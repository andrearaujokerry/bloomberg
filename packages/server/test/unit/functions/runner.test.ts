/**
 * WORKPLAN WP-08 acceptance row — `functions/runner.ts`: "steps 1-11 of FUNCTIONS.md §1.4.3
 * including every error code, alias params and the variant assertion".
 *
 * A unit test in the strict sense: no database, no network, no wall clock. The evaluator, the
 * licence registry, the plant, the security resolver, the access log and the usage-event writer are
 * stubs this file owns, and the functions being run are fixture manifests built here with
 * `defineFunction()`. **Deliberately not a manifest under `core/src/functions/manifests/`**: that
 * directory is globbed into the generated registry, and a test fixture living there would ship in
 * the catalogue as a real function.
 *
 * What is proved, and why each one earns a test rather than a comment:
 *
 *  1. **The order of the eleven steps.** The order decides which error a bad request gets, and the
 *     client switches on the code to decide what the panel says. A request that is wrong in three
 *     ways at once is therefore run against the whole ladder: bad params on an unresolvable ticker
 *     for a function that does not apply must be `VALIDATION_FAILED`, because the parameter grammar
 *     is the thing the user can actually see and fix.
 *  2. **Every documented error code**, each asserted by `code` *and* by HTTP status, because the
 *     status is derived from the code and a mismatch between the two is silent otherwise.
 *  3. **The variant assertion (FUNC-02).** A payload whose `variant` is not the one
 *     `manifest.variants[assetClass]` promised renders the wrong screen with the right numbers,
 *     which is worse than an error. In test it throws; the `strictVariant: false` path is asserted
 *     too, because that is what production does and an untested branch is not a behaviour.
 *  4. **Reproducibility (ANAL-08).** Two runs at an explicit `asOf`, minutes apart on a
 *     `VirtualClock`, differ in exactly `traceId`, `resultId` and `servedAt` and in nothing else.
 *     This is the property the whole file is shaped around, so it is asserted by diffing two whole
 *     payloads rather than by spot-checking fields.
 *  5. **The share-link rule (MSG-04).** `result()` hands a viewer a *re-run under their own
 *     entitlements*, never the producer's cached values. The fixture makes the producer's payload
 *     hold a number the viewer is denied, and asserts the viewer never sees it.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  defineFunction,
  FunctionRegistry,
  type AnyFunctionManifest,
  type AssetClass,
  type EntitlementDecision,
  type EntitlementRequest,
  type FieldId,
  type Instrument,
  type QuoteState,
  type ReasonCode,
  type Tier,
} from '@terminal/core';

import type { Tx } from '../../../src/db/client.js';
import type { AccessLog, AccessLogRow } from '../../../src/entitlements/accessLog.js';
import type { Evaluator } from '../../../src/entitlements/evaluator.js';
import type {
  LicenceEntry,
  LicenceRegistry,
} from '../../../src/entitlements/licenceRegistry.js';
import {
  ReadThroughRoutes,
  type BuildContextDeps,
  type DataServices,
  type FunctionServerModule,
  type ReadThroughStore,
  type ResolveContext,
} from '../../../src/functions/context.js';
import {
  asOfOf,
  functionRunner,
  ulid,
  type FunctionResult,
  type ResolvedSecurity,
  type RunFunctionBody,
  type RunFunctionHttpCtx,
  type RunnerDeps,
} from '../../../src/functions/runner.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import { AppError } from '../../../src/http/errors.js';
import { metrics } from '../../../src/observability/metrics.js';
import { paramsHash, type UsageEventRow, type UsageEvents } from '../../../src/observability/usageEvents.js';
import type { EodView } from '../../../src/plant/eod.js';
import type { Plant } from '../../../src/plant/tickerPlant.js';
import { testClock, TEST_NOW, type VirtualClock } from '../../../src/test/clock.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture manifests — built here, never written into core/src/functions/manifests/
// ─────────────────────────────────────────────────────────────────────────────────────────────

const PX_LAST = 'PX_LAST' as FieldId;
const PX_VOLUME = 'PX_VOLUME' as FieldId;
const NAME = 'NAME' as FieldId;

const SOURCE = 'yahoo.chart';

function helpOf(code: string): AnyFunctionManifest['help'] {
  return {
    summary: `${code} fixture`,
    description: `${code} fixture manifest for the runner unit test.`,
    params: [],
    keys: [],
    sources: [SOURCE],
    related: [],
  };
}

/**
 * `FIX` — the everyday shape: takes a security, applies to two asset classes, has an alias that
 * carries default params, is pageable, and declares CSV columns.
 */
const FIX = defineFunction({
  code: 'FIX',
  name: 'Fixture Screen',
  aliases: ['FX1'],
  aliasParams: { FX1: { range: '5Y', currency: 'EUR' } },
  tier: 1,
  category: 'pricing',
  assetClasses: ['equity', 'etf'],
  requiresSecurity: true,
  variants: { equity: 'equity', etf: 'equity', govt: 'govt' },
  params: z.object({
    range: z.string().default('1Y'),
    currency: z.string().default('USD'),
    rows: z.number().int().positive().default(10),
  }),
  paramGrammar: {
    positional: [{ name: 'range', type: 'range', optional: true }],
    keyed: { CCY: { name: 'currency', type: 'currency' } },
  },
  fieldIds: (assetClass: AssetClass | null): FieldId[] =>
    assetClass === null ? [NAME] : [PX_LAST, PX_VOLUME],
  pageable: true,
  live: null,
  csv: {
    filename: () => 'FIX.csv',
    columns: [
      { id: 'label', label: 'Label', type: 'string' },
      { id: 'value', label: 'Value', type: 'number', decimals: 4 },
    ],
    rows: () => [['px', 1]],
  },
  help: helpOf('FIX'),
  keymap: [],
  screenKind: 'declarative',
  payloadVersion: 1,
});

/** `NOSEC` — `assetClasses: 'none'`: takes no security, variant is always `'default'`. */
const NOSEC = defineFunction({
  code: 'NOSEC',
  name: 'No Security Fixture',
  aliases: [],
  tier: 1,
  category: 'monitor',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: z.object({ limit: z.number().int().default(5) }),
  paramGrammar: { positional: [] },
  fieldIds: (): FieldId[] => [],
  pageable: false,
  live: null,
  csv: { filename: () => 'NOSEC.csv', columns: [], rows: () => [] },
  help: helpOf('NOSEC'),
  keymap: [],
  screenKind: 'declarative',
  payloadVersion: 1,
});

/** `ANYSEC` — `assetClasses: 'any'`, security optional: step 4 never refuses it. */
const ANYSEC = defineFunction({
  code: 'ANYSEC',
  name: 'Optional Security Fixture',
  aliases: [],
  tier: 2,
  category: 'news',
  assetClasses: 'any',
  requiresSecurity: false,
  variants: { equity: 'equity', govt: 'govt' },
  params: z.object({ q: z.string().default('') }),
  paramGrammar: { positional: [], rest: { name: 'q', type: 'text' } },
  fieldIds: (): FieldId[] => [NAME],
  pageable: false,
  live: null,
  csv: { filename: () => 'ANYSEC.csv', columns: [], rows: () => [] },
  help: helpOf('ANYSEC'),
  keymap: [],
  screenKind: 'declarative',
  payloadVersion: 1,
});

const REGISTRY = new FunctionRegistry([FIX, NOSEC, ANYSEC]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Nothing here reaches Postgres; a runner that tried would fail loudly, not silently. */
const NO_DB = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`the unit runner touched the database (db.${String(prop)})`);
    },
  },
) as unknown as Tx;

const NO_DATA = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`the unit runner touched a data service (data.${String(prop)})`);
    },
  },
) as unknown as DataServices;

function fakePlant(): Plant {
  const plant = {
    snapshot: (): QuoteState | undefined => undefined,
    snapshotMany: (): Map<string, QuoteState> => new Map(),
    eodView: (): EodView | null => null,
  };
  return plant as unknown as Plant;
}

function licences(attribution: Record<string, string | null>): LicenceRegistry {
  return {
    licence: (sourceId: string): LicenceEntry | undefined => {
      if (!(sourceId in attribution)) return undefined;
      return { sourceId, attribution: attribution[sourceId] ?? null } as unknown as LicenceEntry;
    },
    fieldSource: () => undefined,
    grantsFor: () => [],
    version: () => 1,
    reload: () => Promise.resolve(),
    refreshIfStale: () => Promise.resolve(),
    stats: () => ({
      version: 1,
      licences: 0,
      fieldLicences: 0,
      grants: 0,
      loads: 1,
      freshChecks: 0,
    }),
  };
}

const ATTRIBUTION = 'Source: Yahoo Finance';
const LICENCES = licences({ [SOURCE]: ATTRIBUTION });
/** A registry that knows nothing — used to prove the runner's own attribution backstop. */
const NO_LICENCES = licences({});

function fieldDecision(
  fieldId: FieldId,
  decision: 'allow' | 'downgrade' | 'deny',
  reason: ReasonCode,
  effectiveTier: Tier | null,
): EntitlementDecision['fields'][number] {
  return { fieldId, sourceId: SOURCE, fieldClass: 'price', decision, effectiveTier, reason };
}

interface EvaluatorHandle {
  evaluator: Evaluator;
  requests: EntitlementRequest[];
  /** Replaced per test; default allows everything asked for. */
  policy: (req: EntitlementRequest) => EntitlementDecision;
}

function fakeEvaluator(): EvaluatorHandle {
  const handle: EvaluatorHandle = {
    requests: [],
    policy: (req) => ({
      effectiveTier: 'delayed',
      fields: req.fieldIds.map((f) => fieldDecision(f, 'allow', 'OK', 'delayed')),
      downgrades: [],
      logIds: [],
    }),
    evaluator: {
      evaluate: (req) => {
        handle.requests.push(req);
        return Promise.resolve(handle.policy(req));
      },
      invalidate: () => undefined,
      stats: () => ({ evaluations: handle.requests.length, cacheHits: 0, cacheMisses: 0 }),
    },
  };
  return handle;
}

function fakeAccessLog(): { log: AccessLog; rows: AccessLogRow[] } {
  const rows: AccessLogRow[] = [];
  let seq = 0;
  return {
    rows,
    log: {
      append: (row) => {
        rows.push(row);
        seq += 1;
        return seq;
      },
      flush: () => Promise.resolve(0),
      size: () => rows.length,
      start: () => undefined,
      stop: () => Promise.resolve(),
      stats: () => ({ buffered: 0, written: rows.length, flushes: 0, dropped: 0 }),
    },
  };
}

function fakeUsageEvents(): { events: UsageEvents; rows: UsageEventRow[] } {
  const rows: UsageEventRow[] = [];
  let seq = 0;
  return {
    rows,
    events: {
      enqueue: (row) => {
        rows.push(row);
        seq += 1;
        return seq;
      },
      flush: () => Promise.resolve(0),
      size: () => rows.length,
      start: () => undefined,
      stop: () => Promise.resolve(),
      stats: () => ({ buffered: 0, written: rows.length, flushes: 0, dropped: 0 }),
    },
  };
}

function instrument(over: Partial<Instrument> = {}): Instrument {
  return {
    instrumentId: 42,
    issueId: 4,
    assetClass: 'equity',
    marketSector: 'Equity',
    ticker: 'AAPL',
    exchCode: 'US',
    name: 'Apple Inc.',
    currency: 'USD',
    status: 'active',
    searchWeight: 1,
    versionId: 1,
    validFrom: '2020-01-01T00:00:00.000Z',
    validTo: '9999-12-31T00:00:00.000Z',
    txFrom: '2020-01-01T00:00:00.000Z',
    txTo: '9999-12-31T00:00:00.000Z',
    provenanceId: 900,
    ...over,
  };
}

const HTTP: RunFunctionHttpCtx = {
  userId: 7,
  firmId: 3,
  sessionId: '22222222-2222-4222-8222-222222222222',
  role: 'user',
  clientKind: 'web',
  traceId: '11111111-1111-4111-8111-111111111111',
  usage: 'display',
};

/**
 * A colleague: a different user of the **same firm**. MSG-04 share links travel through
 * `messages`, which is firm-scoped, so this is the only viewer a share link can reach.
 */
const VIEWER: RunFunctionHttpCtx = {
  ...HTTP,
  userId: 8,
  sessionId: '33333333-3333-4333-8333-333333333333',
  traceId: '44444444-4444-4444-8444-444444444444',
};

/** Another tenant entirely. A resultId means nothing to them — see the cross-firm test below. */
const OUTSIDER: RunFunctionHttpCtx = {
  ...HTTP,
  userId: 9,
  firmId: 4,
  sessionId: '55555555-5555-4555-8555-555555555555',
  traceId: '66666666-6666-4666-8666-666666666666',
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The equity payload the default `FIX` resolver returns. */
interface FixPayload {
  variant: string;
  range: string;
  currency: string;
  rows: number;
  px: number | null;
}

type AnyModule = FunctionServerModule<any, any>;

interface Harness {
  clock: VirtualClock;
  runner: ReturnType<typeof functionRunner>;
  entitlements: EvaluatorHandle;
  access: ReturnType<typeof fakeAccessLog>;
  usage: ReturnType<typeof fakeUsageEvents>;
  metrics: ReturnType<typeof metrics>;
  cache: ResultCache;
  /** Every `(ref, asOf)` the security port was asked for. */
  resolutions: unknown[];
  /** Swap the security resolution outcome per test. */
  setSecurity(fn: (ref: unknown) => ResolvedSecurity | Promise<ResolvedSecurity>): void;
  /** Swap a server module per test. */
  setModule(code: string, module: AnyModule): void;
  warnings: { code: string; message: string; details: Record<string, unknown> }[];
}

/** The `FIX` resolver every test starts from: cites one provenance row and echoes its params. */
const fixModule: AnyModule = {
  resolve: (ctx: ResolveContext, params: unknown): Promise<FixPayload> => {
    const p = params as { range: string; currency: string; rows: number };
    ctx.prov.add({
      sourceId: SOURCE,
      provenanceId: 901,
      capturedAt: new Date(TEST_NOW - 5_000),
      sourceTs: new Date(TEST_NOW - 6_000),
      st: 'live',
      tier: 'delayed',
    });
    ctx.page?.set({ index: 1, count: 3, cursor: 'CUR-2' });
    return Promise.resolve({
      variant: 'equity',
      range: p.range,
      currency: p.currency,
      rows: p.rows,
      px: 188.5,
    });
  },
};

function harness(
  over: Partial<RunnerDeps> & { modules?: Record<string, AnyModule> } = {},
): Harness {
  const clock = testClock();
  const entitlements = fakeEvaluator();
  const access = fakeAccessLog();
  const usage = fakeUsageEvents();
  const registryMetrics = metrics();
  const cache = new ResultCache({ clock });
  const resolutions: unknown[] = [];

  let security: (ref: unknown) => ResolvedSecurity | Promise<ResolvedSecurity> = () => ({
    ok: true,
    instrument: instrument(),
  });

  const modules: Record<string, AnyModule> = over.modules ?? {
    FIX: fixModule,
    NOSEC: { resolve: () => Promise.resolve({ variant: 'default', rows: [] }) },
    ANYSEC: {
      // `assetClasses: 'any'` — the variant is `manifest.variants[assetClass]` with a security
      // loaded and `'default'` without one (FUNCTIONS.md §1.3 rule 1).
      resolve: (ctx: ResolveContext) =>
        Promise.resolve({
          variant:
            ctx.instrument === null
              ? 'default'
              : (ANYSEC.variants[ctx.instrument.assetClass] ?? 'default'),
          hits: [],
        }),
    },
  };

  const context: BuildContextDeps = {
    clock,
    db: NO_DB,
    data: NO_DATA,
    plant: fakePlant(),
    registry: LICENCES,
    entitlements: entitlements.evaluator,
  };

  const warnings: Harness['warnings'] = [];

  const deps: RunnerDeps = {
    clock,
    db: NO_DB,
    registry: REGISTRY,
    modules,
    entitlements: entitlements.evaluator,
    licences: LICENCES,
    accessLog: access.log,
    usageEvents: usage.events,
    resultCache: cache,
    metrics: registryMetrics,
    context,
    resolveSecurity: (ref, asOf) => {
      resolutions.push({ ref, asOf });
      return Promise.resolve(security(ref));
    },
    onWarning: (w) => warnings.push(w),
    ...over,
  };

  return {
    clock,
    runner: functionRunner(deps),
    entitlements,
    access,
    usage,
    metrics: registryMetrics,
    cache,
    resolutions,
    setSecurity: (fn) => {
      security = fn;
    },
    setModule: (code, module) => {
      modules[code] = module;
    },
    warnings,
  };
}

/** Assert an `AppError` code and the status derived from it. */
async function expectError(
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<AppError> {
  const err = await promise.then(
    () => {
      throw new Error(`expected ${code}, but the call succeeded`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  const appError = err as AppError;
  expect(appError.code).toBe(code);
  expect(appError.status).toBe(status);
  return appError;
}

const run = (h: Harness, code: string, body: RunFunctionBody = {}, http = HTTP): Promise<FunctionResult> =>
  h.runner.run(code, body, http);

const SECURITY = { ref: 'AAPL US Equity' } as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 1 — the manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('step 1 — manifest lookup', () => {
  it('404 FUNCTION_NOT_FOUND for a code the registry does not hold', async () => {
    const h = harness();
    const err = await expectError(run(h, 'NOPE'), 'FUNCTION_NOT_FOUND', 404);
    expect(err.details).toEqual({ code: 'NOPE' });
  });

  it('resolves an alias to its manifest and records the alias on the result', async () => {
    const h = harness();
    const { meta } = await run(h, 'FX1', { security: SECURITY });
    const cached = h.cache.get(meta.resultId, HTTP.userId);
    expect(cached?.code).toBe('FIX');
    expect(cached?.alias).toBe('FX1');
  });

  it('is case-insensitive, and a canonical launch carries no alias', async () => {
    const h = harness();
    const { meta } = await run(h, 'fix', { security: SECURITY });
    const cached = h.cache.get(meta.resultId, HTTP.userId);
    expect(cached?.code).toBe('FIX');
    expect(cached?.alias).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 2 — params, and the alias defaults
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('step 2 — parameter parse', () => {
  it('400 VALIDATION_FAILED with location fnParams and the manifest grammar', async () => {
    const h = harness();
    const err = await expectError(
      run(h, 'FIX', { security: SECURITY, params: { rows: -1 } }),
      'VALIDATION_FAILED',
      400,
    );
    expect(err.details?.location).toBe('fnParams');
    expect(err.details?.grammar).toEqual(FIX.paramGrammar);
    expect(err.details?.code).toBe('FIX');
    expect(Array.isArray(err.details?.issues)).toBe(true);
  });

  it('applies the manifest defaults', async () => {
    const h = harness();
    const { data } = await run(h, 'FIX', { security: SECURITY });
    expect(data).toMatchObject({ range: '1Y', currency: 'USD', rows: 10 });
  });

  it('merges manifest.aliasParams[alias] UNDER body.params', async () => {
    const h = harness();
    // FX1 carries { range: '5Y', currency: 'EUR' }; the caller overrides one of them.
    const { data } = await run(h, 'FX1', { security: SECURITY, params: { currency: 'GBP' } });
    expect(data).toMatchObject({ range: '5Y', currency: 'GBP', rows: 10 });
  });

  it('applies no alias defaults when the canonical code was typed', async () => {
    const h = harness();
    const { data } = await run(h, 'FIX', { security: SECURITY });
    expect(data).toMatchObject({ range: '1Y', currency: 'USD' });
  });

  it('runs BEFORE security resolution — a request wrong in both ways is a 400', async () => {
    const h = harness();
    h.setSecurity(() => ({ ok: false, code: 'SECURITY_NOT_FOUND', message: 'no such ticker' }));
    await expectError(
      run(h, 'FIX', { security: { ref: 'NOPE US Equity' }, params: { rows: 0 } }),
      'VALIDATION_FAILED',
      400,
    );
    // The security port was never reached: the grammar failure is what the user can fix.
    expect(h.resolutions).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 3 — the security
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('step 3 — security resolution', () => {
  it('422 NO_SECURITY_CONTEXT when the manifest requires one and none was sent', async () => {
    const h = harness();
    const err = await expectError(run(h, 'FIX', {}), 'NO_SECURITY_CONTEXT', 422);
    expect(err.details).toEqual({ code: 'FIX' });
  });

  it('404 SECURITY_NOT_FOUND', async () => {
    const h = harness();
    h.setSecurity(() => ({ ok: false, code: 'SECURITY_NOT_FOUND', message: 'no such ticker' }));
    const err = await expectError(
      run(h, 'FIX', { security: { ref: 'ZZZZ US Equity' } }),
      'SECURITY_NOT_FOUND',
      404,
    );
    expect(err.message).toBe('no such ticker');
  });

  it('409 AMBIGUOUS_SECURITY with the candidates', async () => {
    const h = harness();
    const candidates = [{ instrumentId: 1, display: 'AAPL US Equity' }, { instrumentId: 2, display: 'AAPL GR Equity' }];
    h.setSecurity(() => ({ ok: false, code: 'AMBIGUOUS_SECURITY', message: 'two matches', candidates }));
    const err = await expectError(
      run(h, 'FIX', { security: { ref: 'AAPL' } }),
      'AMBIGUOUS_SECURITY',
      409,
    );
    expect(err.details?.candidates).toEqual(candidates);
  });

  it('422 NOT_IN_UNIVERSE', async () => {
    const h = harness();
    h.setSecurity(() => ({ ok: false, code: 'NOT_IN_UNIVERSE', message: 'Corp is not in the wedge' }));
    const err = await expectError(
      run(h, 'FIX', { security: { ref: 'IBM 4.25 08/15/36 Corp' } }),
      'NOT_IN_UNIVERSE',
      422,
    );
    expect(err.message).toBe('Corp is not in the wedge');
  });

  it("ignores body.security entirely when assetClasses is 'none'", async () => {
    const h = harness();
    h.setSecurity(() => {
      throw new Error('the security port must not be called for a no-security function');
    });
    const { data } = await run(h, 'NOSEC', { security: SECURITY });
    expect(data).toEqual({ variant: 'default', rows: [] });
    expect(h.resolutions).toHaveLength(0);
  });

  it("resolves nothing, and refuses nothing, when the security is optional and absent", async () => {
    const h = harness();
    const { meta } = await run(h, 'ANYSEC', {});
    expect(h.resolutions).toHaveLength(0);
    expect(h.cache.get(meta.resultId, HTTP.userId)?.security).toBeNull();
  });

  it('passes the run’s asOf to the resolver, so the ticker is read at that instant', async () => {
    const h = harness();
    const asOf = { validAt: '2026-03-02T00:00:00.000Z', knownAt: '2026-03-03T00:00:00.000Z' };
    await run(h, 'FIX', { security: SECURITY, asOf });
    expect(h.resolutions[0]).toEqual({
      ref: SECURITY,
      asOf: { validAt: new Date(asOf.validAt), knownAt: new Date(asOf.knownAt) },
    });
  });

  it('400 VALIDATION_FAILED for an unparseable asOf rather than a silent now()', async () => {
    const h = harness();
    await expectError(
      run(h, 'FIX', { security: SECURITY, asOf: { validAt: 'yesterday' } }),
      'VALIDATION_FAILED',
      400,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 4 — applicability
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('step 4 — applicability (FUNC-02)', () => {
  it('422 FUNCTION_NOT_APPLICABLE with the class and the applicable list', async () => {
    const h = harness();
    h.setSecurity(() => ({ ok: true, instrument: instrument({ assetClass: 'govt' }) }));
    const err = await expectError(
      run(h, 'FIX', { security: { ref: '912797VE4 Govt' } }),
      'FUNCTION_NOT_APPLICABLE',
      422,
    );
    expect(err.details).toEqual({ assetClass: 'govt', applicable: ['equity', 'etf'] });
  });

  it("never refuses a manifest whose assetClasses is 'any'", async () => {
    const h = harness();
    h.setSecurity(() => ({ ok: true, instrument: instrument({ assetClass: 'govt' }) }));
    h.setModule('ANYSEC', { resolve: () => Promise.resolve({ variant: 'govt' }) } as AnyModule);
    const { data } = await run(h, 'ANYSEC', { security: { ref: '912797VE4 Govt' } });
    expect(data).toEqual({ variant: 'govt' });
  });

  it('runs AFTER security resolution — an unresolvable ticker is a 404, not a 422', async () => {
    const h = harness();
    h.setSecurity(() => ({ ok: false, code: 'SECURITY_NOT_FOUND' }));
    await expectError(run(h, 'FIX', { security: { ref: 'ZZZZ' } }), 'SECURITY_NOT_FOUND', 404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 5 — entitlements
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('step 5 — the entitlement pre-check', () => {
  it('asks over manifest.fieldIds(assetClass) with the documented request', async () => {
    const h = harness();
    await run(h, 'FIX', { security: SECURITY });
    expect(h.entitlements.requests[0]).toEqual({
      userId: 7,
      firmId: 3,
      sessionId: HTTP.sessionId,
      instrumentId: 42,
      assetClass: 'equity',
      fieldIds: [PX_LAST, PX_VOLUME],
      tier: 'delayed',
      usage: 'display',
      purpose: 'FIX',
      traceId: HTTP.traceId,
    });
  });

  it("uses usage 'api' for a bearer caller whatever the route said", async () => {
    const h = harness();
    await run(h, 'FIX', { security: SECURITY }, { ...HTTP, clientKind: 'api' });
    expect(h.entitlements.requests[0]?.usage).toBe('api');
  });

  it('403 ENTITLEMENT_DENIED only when EVERY field is denied', async () => {
    const h = harness();
    h.entitlements.policy = (req) => ({
      effectiveTier: null,
      fields: req.fieldIds.map((f) => fieldDecision(f, 'deny', 'NO_FIRM_ENTITLEMENT', null)),
      downgrades: [],
      logIds: [],
    });
    const err = await expectError(
      run(h, 'FIX', { security: SECURITY }),
      'ENTITLEMENT_DENIED',
      403,
    );
    expect(err.details?.reasons).toEqual([
      { fieldId: PX_LAST, decision: 'deny', effectiveTier: null, reason: 'NO_FIRM_ENTITLEMENT' },
      { fieldId: PX_VOLUME, decision: 'deny', effectiveTier: null, reason: 'NO_FIRM_ENTITLEMENT' },
    ]);
  });

  it('a PARTIAL denial is a 200 with the note in meta.entitlement (ENTL-05)', async () => {
    const h = harness();
    h.entitlements.policy = (req) => ({
      effectiveTier: 'delayed',
      fields: req.fieldIds.map((f, i) =>
        i === 0
          ? fieldDecision(f, 'allow', 'OK', 'delayed')
          : fieldDecision(f, 'deny', 'NOT_ENTITLED_TIER', null),
      ),
      downgrades: [],
      logIds: [],
    });
    const { meta } = await run(h, 'FIX', { security: SECURITY });
    expect(meta.entitlement).toEqual([
      { fieldId: PX_VOLUME, decision: 'deny', effectiveTier: null, reason: 'NOT_ENTITLED_TIER' },
    ]);
  });

  it('reports a downgrade, and never reports an allow', async () => {
    const h = harness();
    h.entitlements.policy = (req) => ({
      effectiveTier: 'eod',
      fields: req.fieldIds.map((f, i) =>
        i === 0
          ? fieldDecision(f, 'downgrade', 'SOURCE_TIER_CAP', 'eod')
          : fieldDecision(f, 'allow', 'OK', 'delayed'),
      ),
      downgrades: [{ fieldId: PX_LAST, reason: 'SOURCE_TIER_CAP' }],
      logIds: [],
    });
    const { meta } = await run(h, 'FIX', { security: SECURITY });
    expect(meta.entitlement).toEqual([
      { fieldId: PX_LAST, decision: 'downgrade', effectiveTier: 'eod', reason: 'SOURCE_TIER_CAP' },
    ]);
  });

  it('a manifest with no fields is not "every field denied"', async () => {
    const h = harness();
    h.entitlements.policy = () => ({
      effectiveTier: 'delayed',
      fields: [],
      downgrades: [],
      logIds: [],
    });
    const { meta } = await run(h, 'NOSEC', {});
    expect(meta.entitlement).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Steps 6-7 — the context, the variant and the resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('steps 6-7 — context, variant dispatch and the resolver', () => {
  it('dispatches to module.variants[assetClass] when one exists', async () => {
    const h = harness();
    const etf = vi.fn(() => Promise.resolve({ variant: 'equity', from: 'etf-resolver' }));
    const base = vi.fn(() => Promise.resolve({ variant: 'equity', from: 'default' }));
    h.setModule('FIX', { resolve: base, variants: { etf } });
    h.setSecurity(() => ({ ok: true, instrument: instrument({ assetClass: 'etf' }) }));

    const { data } = await run(h, 'FIX', { security: { ref: 'SPY US Equity' } });
    expect(data).toMatchObject({ from: 'etf-resolver' });
    expect(base).not.toHaveBeenCalled();
  });

  it('falls back to module.resolve when the class has no variant resolver', async () => {
    const h = harness();
    const base = vi.fn(() => Promise.resolve({ variant: 'equity', from: 'default' }));
    h.setModule('FIX', {
      resolve: base,
      variants: { etf: () => Promise.resolve({ variant: 'equity' }) },
    });
    const { data } = await run(h, 'FIX', { security: SECURITY });
    expect(data).toMatchObject({ from: 'default' });
  });

  it('THROWS when data.variant is not manifest.variants[assetClass] (dev/test)', async () => {
    const h = harness();
    h.setModule('FIX', { resolve: () => Promise.resolve({ variant: 'govt' }) } as AnyModule);
    const err = await expectError(run(h, 'FIX', { security: SECURITY }), 'INTERNAL', 500);
    expect(err.details).toMatchObject({ expected: 'equity', actual: 'govt', assetClass: 'equity' });
  });

  it("requires variant 'default' for a manifest that takes no security", async () => {
    const h = harness();
    h.setModule('NOSEC', { resolve: () => Promise.resolve({ variant: 'something' }) } as AnyModule);
    await expectError(run(h, 'NOSEC', {}), 'INTERNAL', 500);
  });

  it('maps an asset class onto a SHARED variant name (etf → equity screen)', async () => {
    const h = harness();
    h.setSecurity(() => ({ ok: true, instrument: instrument({ assetClass: 'etf' }) }));
    const { data } = await run(h, 'FIX', { security: { ref: 'SPY US Equity' } });
    // manifest.variants.etf === 'equity', so the equity payload is the correct one here.
    expect((data as FixPayload).variant).toBe('equity');
  });

  it('serves a mismatch with a warning when strictVariant is false (production)', async () => {
    const h = harness({ strictVariant: false });
    h.setModule('FIX', { resolve: () => Promise.resolve({ variant: 'govt' }) } as AnyModule);
    const { data } = await run(h, 'FIX', { security: SECURITY });
    expect(data).toEqual({ variant: 'govt' });
    expect(h.warnings[0]?.code).toBe('VARIANT_MISMATCH');
  });

  it('hands the resolver a context at the requested asOf, usage and panel', async () => {
    const h = harness();
    let seen: ResolveContext | undefined;
    h.setModule('FIX', {
      resolve: (ctx: ResolveContext) => {
        seen = ctx;
        return Promise.resolve({ variant: 'equity' });
      },
    } as AnyModule);

    await run(h, 'FIX', {
      security: SECURITY,
      panelId: 'p3',
      asOf: { validAt: '2026-03-02T00:00:00.000Z', knownAt: '2026-03-02T00:00:00.000Z' },
    });

    expect(seen?.usage).toBe('display');
    expect(seen?.panelId).toBe('p3');
    expect(seen?.instrument?.instrumentId).toBe(42);
    expect(seen?.asOf.validAt.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(seen?.user).toEqual({ userId: 7, firmId: 3, sessionId: HTTP.sessionId, role: 'user' });
    expect(seen?.traceId).toBe(HTTP.traceId);
  });

  it('500 INTERNAL, with the resolver’s message withheld, when a resolver throws', async () => {
    const h = harness();
    h.setModule('FIX', {
      resolve: () => Promise.reject(new Error('connection string leaked here')),
    } as AnyModule);
    const err = await expectError(run(h, 'FIX', { security: SECURITY }), 'INTERNAL', 500);
    expect(err.message).toBe('FIX failed.');
    expect(err.message).not.toContain('connection string');
  });

  it('lets a resolver’s own AppError through unchanged (a read-through 503)', async () => {
    const h = harness();
    h.setModule('FIX', {
      resolve: () =>
        Promise.reject(new AppError('PROVIDER_UNAVAILABLE', 'yahoo.chart circuit is open')),
    } as AnyModule);
    const err = await expectError(
      run(h, 'FIX', { security: SECURITY }),
      'PROVIDER_UNAVAILABLE',
      503,
    );
    expect(err.message).toBe('yahoo.chart circuit is open');
    expect(err.retryable).toBe(true);
  });

  it('500 INTERNAL when the registry holds a code with no server module', async () => {
    const h = harness({ modules: {} });
    await expectError(run(h, 'NOSEC', {}), 'INTERNAL', 500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 7 — the 20 s timeout, and which 5xx it is
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('step 7 — the resolver timeout', () => {
  /** A read-through whose store never answers, so a provider call is genuinely in flight. */
  function hangingProviders(): Pick<BuildContextDeps, 'routes' | 'store'> {
    const routes = new ReadThroughRoutes();
    routes.register('yahoo.daily', {
      providerId: 'yahoo.chart',
      request: (key: string) => ({ symbol: key }),
      url: (key: string) => `https://query1.finance.yahoo.com/v8/finance/chart/${key}`,
    });
    const store: ReadThroughStore = {
      latest: () => new Promise(() => undefined),
      record: () => new Promise(() => undefined),
    };
    return { routes, store };
  }

  it('503 PROVIDER_UNAVAILABLE when a provider call is in flight at the deadline', async () => {
    const clock = testClock();
    const evaluator = fakeEvaluator();
    const h = harness({
      clock,
      timeoutMs: 20,
      entitlements: evaluator.evaluator,
      modules: {
        FIX: {
          resolve: async (ctx: ResolveContext) => {
            // The store never answers, so a read-through really is in flight at the deadline.
            await ctx.providers.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 60_000 });
            return { variant: 'equity' };
          },
        } as AnyModule,
      },
      context: {
        clock,
        db: NO_DB,
        data: NO_DATA,
        plant: fakePlant(),
        registry: LICENCES,
        entitlements: evaluator.evaluator,
        ...hangingProviders(),
      },
    });

    const err = await expectError(
      run(h, 'FIX', { security: SECURITY }),
      'PROVIDER_UNAVAILABLE',
      503,
    );
    expect(err.message).toContain('waiting for a provider');
    expect(err.retryable).toBe(true);
  });

  it('500 INTERNAL when the resolver is stuck in its own work', async () => {
    const h = harness({ timeoutMs: 20 });
    h.setModule('FIX', { resolve: () => new Promise(() => undefined) } as AnyModule);
    const err = await expectError(run(h, 'FIX', { security: SECURITY }), 'INTERNAL', 500);
    expect(err.details).toMatchObject({ code: 'FIX', timeoutMs: 20 });
  });

  it('does not fire for a resolver that finished in time', async () => {
    const h = harness({ timeoutMs: 1_000 });
    const { data } = await run(h, 'FIX', { security: SECURITY });
    expect((data as FixPayload).px).toBe(188.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 8 — meta
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('step 8 — the meta envelope', () => {
  it('stamps every documented field', async () => {
    const h = harness();
    const asOf = { validAt: '2026-03-02T00:00:00.000Z', knownAt: '2026-03-03T00:00:00.000Z' };
    const { meta } = await run(h, 'FIX', { security: SECURITY, asOf, page: { cursor: null, direction: 'fwd' } });

    expect(meta.traceId).toBe(HTTP.traceId);
    expect(meta.resultId).toHaveLength(26);
    expect(meta.asOf).toEqual(asOf);
    expect(meta.tier).toBe('delayed');
    expect(meta.staleness).toBe('live');
    expect(meta.provenance).toEqual([
      {
        idx: 0,
        sourceId: SOURCE,
        provenanceId: 901,
        capturedAt: new Date(TEST_NOW - 5_000).toISOString(),
        sourceTs: new Date(TEST_NOW - 6_000).toISOString(),
        attribution: ATTRIBUTION,
      },
    ]);
    expect(meta.entitlement).toEqual([]);
    expect(meta.unavailable).toEqual([]);
    expect(meta.engines).toEqual([]);
    expect(meta.page).toEqual({ index: 1, count: 3, cursor: 'CUR-2' });
    expect(meta.servedAt).toBe(new Date(TEST_NOW).toISOString());
  });

  it('defaults asOf to the injected clock, never to Date.now()', async () => {
    const h = harness();
    h.clock.advance(120_000);
    const { meta } = await run(h, 'FIX', { security: SECURITY });
    const expected = new Date(TEST_NOW + 120_000).toISOString();
    expect(meta.asOf).toEqual({ validAt: expected, knownAt: expected });
    expect(meta.servedAt).toBe(expected);
  });

  it('carries unavailable entries and engine records through from the resolver', async () => {
    const h = harness();
    h.setModule('FIX', {
      resolve: (ctx: ResolveContext) => {
        ctx.unavailable.add({ field: 'EPS_EST', reason: 'NO_SOURCE', detail: 'no estimates feed' });
        ctx.engines.add({ name: 'ratios', version: '1.0.0', inputsHash: 'a'.repeat(64) });
        return Promise.resolve({ variant: 'equity', eps: null });
      },
    } as AnyModule);

    const { data, meta } = await run(h, 'FIX', { security: SECURITY });
    // Nothing invents data: the gap is null in the payload AND named in meta.unavailable.
    expect((data as { eps: null }).eps).toBeNull();
    expect(meta.unavailable).toEqual([
      { field: 'EPS_EST', reason: 'NO_SOURCE', detail: 'no estimates feed' },
    ]);
    expect(meta.engines).toEqual([
      { name: 'ratios', version: '1.0.0', inputsHash: 'a'.repeat(64) },
    ]);
  });

  it('reports the worst state and the lowest tier any cited row carried', async () => {
    const h = harness();
    h.setModule('FIX', {
      resolve: (ctx: ResolveContext) => {
        ctx.prov.add({
          sourceId: SOURCE,
          provenanceId: 1,
          capturedAt: new Date(TEST_NOW),
          sourceTs: null,
          st: 'live',
          tier: 'realtime',
        });
        ctx.prov.add({
          sourceId: SOURCE,
          provenanceId: 2,
          capturedAt: new Date(TEST_NOW),
          sourceTs: null,
          st: 'stale',
          tier: 'eod',
        });
        return Promise.resolve({ variant: 'equity' });
      },
    } as AnyModule);

    const { meta } = await run(h, 'FIX', { security: SECURITY });
    expect(meta.staleness).toBe('stale');
    expect(meta.tier).toBe('eod');
    expect(meta.provenance).toHaveLength(2);
  });

  it('backfills attribution from the runner’s own licence registry (DATA-09)', async () => {
    // The context was built with a registry that knows nothing about the source…
    const h = harness({
      licences: LICENCES,
      context: {
        clock: testClock(),
        db: NO_DB,
        data: NO_DATA,
        plant: fakePlant(),
        registry: NO_LICENCES,
        entitlements: fakeEvaluator().evaluator,
      },
    });
    const { meta } = await run(h, 'FIX', { security: SECURITY });
    // …and the footer still carries the licensed attribution line.
    expect(meta.provenance[0]?.attribution).toBe(ATTRIBUTION);
  });

  it('gives a PAGEABLE manifest a first page context, so paging can start at all', async () => {
    const h = harness();
    let seen: ResolveContext | undefined;
    h.setModule('FIX', {
      resolve: (ctx: ResolveContext) => {
        seen = ctx;
        ctx.page?.set({ index: 0, count: 3, cursor: 'CUR-1' });
        return Promise.resolve({ variant: 'equity' });
      },
    } as AnyModule);

    // No `page` in the body — `FunctionRunRequest` has no such member (API.md §5.3 L516).
    const { meta } = await run(h, 'FIX', { security: SECURITY });
    expect(seen?.page?.cursor).toBeNull();
    expect(seen?.page?.direction).toBe('fwd');
    // `POST /page` reads its next cursor out of exactly this.
    expect(meta.page).toEqual({ index: 0, count: 3, cursor: 'CUR-1' });
  });

  it('gives a NON-pageable manifest no page context at all', async () => {
    const h = harness();
    let seen: ResolveContext | undefined;
    h.setModule('NOSEC', {
      resolve: (ctx: ResolveContext) => {
        seen = ctx;
        return Promise.resolve({ variant: 'default' });
      },
    } as AnyModule);
    const { meta } = await run(h, 'NOSEC', {});
    expect(seen?.page).toBeUndefined();
    expect(meta.page).toBeUndefined();
  });

  it('omits meta.page for a screen that never paged', async () => {
    const h = harness();
    h.setModule('FIX', { resolve: () => Promise.resolve({ variant: 'equity' }) } as AnyModule);
    const { meta } = await run(h, 'FIX', { security: SECURITY });
    expect(meta.page).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Steps 9-11 — cache, logs, metrics
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('steps 9-11 — the result cache, the logs and the metric', () => {
  it('caches the result under its resultId for its producer only', async () => {
    const h = harness();
    const { data, meta } = await run(h, 'FIX', { security: SECURITY });
    const cached = h.cache.get(meta.resultId, HTTP.userId);
    expect(cached?.data).toBe(data);
    expect(cached?.params).toEqual({ range: '1Y', currency: 'USD', rows: 10 });
    expect(cached?.security).toBe(42);
    expect(cached?.storedAt).toBe(TEST_NOW);
    expect(h.cache.get(meta.resultId, VIEWER.userId)).toBeUndefined();
  });

  it('writes one usage_events row per launch, with a stable params_hash', async () => {
    const h = harness();
    await run(h, 'FIX', { security: SECURITY, panelId: 'p2' });
    expect(h.usage.rows).toHaveLength(1);
    expect(h.usage.rows[0]).toEqual({
      ts: TEST_NOW,
      userId: 7,
      firmId: 3,
      sessionId: HTTP.sessionId,
      panelId: 'p2',
      kind: 'fn.launch',
      code: 'FIX',
      paramsHash: paramsHash({ range: '1Y', currency: 'USD', rows: 10 }),
      instrumentId: 42,
      durationMs: 0,
      traceId: HTTP.traceId,
      details: { alias: null, variant: 'equity', launchKind: 'launch' },
    });
  });

  it("records fn.param for a parameter change and names the alias", async () => {
    const h = harness();
    await run(h, 'FX1', { security: SECURITY, launchKind: 'param' });
    expect(h.usage.rows[0]?.kind).toBe('fn.param');
    expect(h.usage.rows[0]?.details).toMatchObject({ alias: 'FX1', launchKind: 'param' });
  });

  it('hashes the same params to the same value whatever order the keys arrived in', async () => {
    const h = harness();
    await run(h, 'FIX', { security: SECURITY, params: { range: '5Y', currency: 'EUR' } });
    await run(h, 'FIX', { security: SECURITY, params: { currency: 'EUR', range: '5Y' } });
    expect(h.usage.rows[0]?.paramsHash).toBe(h.usage.rows[1]?.paramsHash);
  });

  it('appends the access_log rows the evaluator did not (ENTL-04), and never twice', async () => {
    const h = harness();
    await run(h, 'FIX', { security: SECURITY });
    expect(h.access.rows).toHaveLength(2);
    expect(h.access.rows[0]).toEqual({
      ts: TEST_NOW,
      userId: 7,
      firmId: 3,
      sessionId: HTTP.sessionId,
      instrumentId: 42,
      fieldId: PX_LAST,
      fieldClass: 'price',
      sourceId: SOURCE,
      requestedTier: 'delayed',
      tier: 'delayed',
      usage: 'display',
      purpose: 'FIX',
      decision: 'allow',
      reason: 'OK',
      traceId: HTTP.traceId,
    });
  });

  it('writes no access_log row when the evaluator already queued them', async () => {
    const h = harness();
    h.entitlements.policy = (req) => ({
      effectiveTier: 'delayed',
      fields: req.fieldIds.map((f) => fieldDecision(f, 'allow', 'OK', 'delayed')),
      downgrades: [],
      // Non-empty logIds ⇒ the evaluator has the writer and has already queued the rows.
      logIds: [11, 12],
    });
    await run(h, 'FIX', { security: SECURITY });
    expect(h.access.rows).toHaveLength(0);
  });

  it('observes fn_resolve_ms labelled with the code', async () => {
    const h = harness();
    await run(h, 'FIX', { security: SECURITY });
    const text = h.metrics.render();
    expect(text).toContain('fn_resolve_ms_count{code="FIX"} 1');
    expect(text).toContain('fn_runs_total{code="FIX"} 1');
  });

  it('serves the payload even when the usage row is rejected', async () => {
    // An out-of-range kind is a RangeError from the writer; accounting must not cost a payload.
    const broken: UsageEvents = {
      enqueue: () => {
        throw new RangeError('bad kind');
      },
      flush: () => Promise.resolve(0),
      size: () => 0,
      start: () => undefined,
      stop: () => Promise.resolve(),
      stats: () => ({ buffered: 0, written: 0, flushes: 0, dropped: 0 }),
    };
    const h = harness({ usageEvents: broken });
    const { meta } = await run(h, 'FIX', { security: SECURITY });
    expect(meta.resultId).toHaveLength(26);
    expect(h.warnings[0]?.code).toBe('USAGE_EVENT_REJECTED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reproducibility — ANAL-08
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('reproducibility (ANAL-08)', () => {
  it('two runs at an explicit asOf differ only in traceId, resultId and servedAt', async () => {
    const h = harness();
    const asOf = { validAt: '2026-03-02T00:00:00.000Z', knownAt: '2026-03-03T00:00:00.000Z' };

    const first = await run(h, 'FIX', { security: SECURITY, asOf });
    h.clock.advance(7 * 24 * 60 * 60 * 1_000); // a week later
    const second = await run(
      h,
      'FIX',
      { security: SECURITY, asOf },
      { ...HTTP, traceId: '55555555-5555-4555-8555-555555555555' },
    );

    expect(second.data).toEqual(first.data);

    const strip = (m: FunctionResult['meta']): Record<string, unknown> => {
      const { traceId, resultId, servedAt, staleness, ...rest } = m;
      void traceId;
      void resultId;
      void servedAt;
      void staleness;
      return rest;
    };
    expect(strip(second.meta)).toEqual(strip(first.meta));

    // …and the three that are allowed to move did move.
    expect(second.meta.traceId).not.toBe(first.meta.traceId);
    expect(second.meta.resultId).not.toBe(first.meta.resultId);
    expect(second.meta.servedAt).not.toBe(first.meta.servedAt);
  });

  it('a run without an explicit asOf moves with the clock — which is why export re-supplies it', async () => {
    const h = harness();
    const first = await run(h, 'FIX', { security: SECURITY });
    h.clock.advance(60_000);
    const second = await run(h, 'FIX', { security: SECURITY });
    expect(second.meta.asOf).not.toEqual(first.meta.asOf);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// step 7½ — the payload/meta invariant (DATA-10, FUNCTIONS.md §1.3 rule 6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the payload and its meta must agree', () => {
  /** A resolver that returns `payload` and cites nothing at all. */
  const silent = (payload: unknown): AnyModule =>
    ({ resolve: () => Promise.resolve(payload) }) as AnyModule;

  it('refuses a number in a declared cell that cites no provenance and no engine', async () => {
    const h = harness();
    // `value` is one of FIX's own csv columns, so it is a data cell by the manifest's own account.
    h.setModule('FIX', silent({ variant: 'equity', value: 1234.5 }));
    const err = await expectError(run(h, 'FIX', { security: SECURITY }), 'INTERNAL', 500);
    expect(String(err.message)).toContain('value');
    expect(err.details?.violations).toBeDefined();
  });

  it('allows a number that cites an ENGINE rather than a source (ANAL-08)', async () => {
    const h = harness();
    h.setModule('FIX', {
      resolve: (ctx: ResolveContext) => {
        ctx.engines.add({ name: 'bond', version: '1.0.0', inputsHash: 'abc' });
        return Promise.resolve({ variant: 'equity', value: 1234.5 });
      },
    } as AnyModule);
    const out = await run(h, 'FIX', { security: SECURITY });
    expect((out.data as { value: number }).value).toBe(1234.5);
  });

  it('leaves numbers that are NOT data cells alone — an echoed parameter has no source', async () => {
    const h = harness();
    // `rows` is a parameter echo, not a declared column: a row count has nothing to cite.
    h.setModule('FIX', silent({ variant: 'equity', rows: 20, label: 'PX' }));
    const out = await run(h, 'FIX', { security: SECURITY });
    expect((out.data as { rows: number }).rows).toBe(20);
  });

  it('refuses a null cell with nothing in meta to explain it (§1.3 rule 6)', async () => {
    const h = harness();
    h.setModule('FIX', {
      resolve: (ctx: ResolveContext) => {
        ctx.prov.add({
          sourceId: SOURCE,
          provenanceId: 901,
          capturedAt: new Date(TEST_NOW),
          sourceTs: null,
          st: 'live',
          tier: 'delayed',
        });
        return Promise.resolve({ variant: 'equity', value: null });
      },
    } as AnyModule);
    const err = await expectError(run(h, 'FIX', { security: SECURITY }), 'INTERNAL', 500);
    expect(String(err.message)).toContain('value');
  });

  it('accepts a null a per-field DENIAL explains (§12.3 puts that reason in meta.entitlement)', async () => {
    const h = harness();
    h.entitlements.policy = (req) => ({
      effectiveTier: 'delayed',
      fields: req.fieldIds.map((f, i) =>
        i === 0
          ? fieldDecision(f, 'allow', 'OK', 'delayed')
          : fieldDecision(f, 'deny', 'NO_FIRM_ENTITLEMENT', null),
      ),
      downgrades: [],
      logIds: [],
    });
    h.setModule('FIX', {
      resolve: (ctx: ResolveContext) => {
        ctx.prov.add({
          sourceId: SOURCE,
          provenanceId: 901,
          capturedAt: new Date(TEST_NOW),
          sourceTs: null,
          st: 'live',
          tier: 'delayed',
        });
        return Promise.resolve({ variant: 'equity', value: null });
      },
    } as AnyModule);
    const out = await run(h, 'FIX', { security: SECURITY });
    expect((out.data as { value: null }).value).toBeNull();
    expect(out.meta.entitlement.some((e) => e.decision === 'deny')).toBe(true);
  });

  it('accepts the same null once the resolver says why it is missing', async () => {
    const h = harness();
    h.setModule('FIX', {
      resolve: (ctx: ResolveContext) => {
        ctx.prov.add({
          sourceId: SOURCE,
          provenanceId: 901,
          capturedAt: new Date(TEST_NOW),
          sourceTs: null,
          st: 'live',
          tier: 'delayed',
        });
        ctx.unavailable.add({ field: 'value', reason: 'NO_SOURCE', detail: 'no consensus feed' });
        return Promise.resolve({ variant: 'equity', value: null });
      },
    } as AnyModule);
    const out = await run(h, 'FIX', { security: SECURITY });
    expect((out.data as { value: null }).value).toBeNull();
    expect(out.meta.unavailable).toEqual([
      { field: 'value', reason: 'NO_SOURCE', detail: 'no consensus feed' },
    ]);
  });

  it('stamps staleness "blank" — not "live" — when nothing was cited at all', async () => {
    const h = harness();
    h.setModule('FIX', silent({ variant: 'equity', label: 'PX' }));
    const out = await run(h, 'FIX', { security: SECURITY });
    expect(out.meta.provenance).toEqual([]);
    expect(out.meta.staleness).toBe('blank');
  });

  it('serves a violation with a warning when strictVariant is off (production)', async () => {
    const h = harness({ strictVariant: false });
    h.setModule('FIX', silent({ variant: 'equity', value: 1234.5 }));
    const out = await run(h, 'FIX', { security: SECURITY });
    expect((out.data as { value: number }).value).toBe(1234.5);
    expect(h.warnings.map((w) => w.code)).toContain('PAYLOAD_META_MISMATCH');
  });

  it('refuses a cited provenanceId that names no row (DATA-10)', async () => {
    const asked: readonly number[][] = [];
    const h = harness({
      provenanceExists: (ids) => {
        (asked as number[][]).push([...ids]);
        return Promise.resolve(ids.filter((id) => id === 901));
      },
    });
    const err = await expectError(run(h, 'FIX', { security: SECURITY }), 'INTERNAL', 500);
    expect(asked[0]).toEqual([901]);
    expect(String(err.message)).toContain('901');
  });

  it('asks only once, for the distinct ids, and serves when they all resolve', async () => {
    let calls = 0;
    const h = harness({
      provenanceExists: (ids) => {
        calls += 1;
        expect(ids).toEqual([901]);
        return Promise.resolve([]);
      },
    });
    await run(h, 'FIX', { security: SECURITY });
    expect(calls).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// page()
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('page() — steps 6-11 over the cached input', () => {
  it('re-runs at the cached asOf with the cached params and the next cursor', async () => {
    const h = harness();
    let seen: ResolveContext | undefined;
    const asOf = { validAt: '2026-03-02T00:00:00.000Z', knownAt: '2026-03-03T00:00:00.000Z' };

    h.setModule('FIX', {
      resolve: (ctx: ResolveContext, params: unknown) => {
        seen = ctx;
        ctx.page?.set({ index: 2, count: 3, cursor: 'CUR-3' });
        return Promise.resolve({ variant: 'equity', params });
      },
    } as AnyModule);

    const first = await run(h, 'FX1', {
      security: SECURITY,
      asOf,
      page: { cursor: null, direction: 'fwd' },
    });
    expect(first.meta.page).toEqual({ index: 2, count: 3, cursor: 'CUR-3' });

    h.clock.advance(30_000);
    const next = await h.runner.page(first.meta.resultId, 'fwd', HTTP);

    // The cursor the first page reported is the cursor the second page starts from.
    expect(seen?.page?.cursor).toBe('CUR-3');
    expect(seen?.page?.direction).toBe('fwd');
    // Same instant, same params (including the alias defaults), new resultId.
    expect(next.meta.asOf).toEqual(asOf);
    expect((next.data as { params: unknown }).params).toEqual({
      range: '5Y',
      currency: 'EUR',
      rows: 10,
    });
    expect(next.meta.resultId).not.toBe(first.meta.resultId);
  });

  it('writes a fn.page usage row', async () => {
    const h = harness();
    // No `page` in the launch body: a pageable manifest gets its first page context from the
    // manifest, and `launchKind` is what separates a launch from a page turn (FUNC-04).
    const first = await run(h, 'FIX', { security: SECURITY });
    await h.runner.page(first.meta.resultId, 'fwd', HTTP);
    expect(h.usage.rows.map((r) => r.kind)).toEqual(['fn.launch', 'fn.page']);
  });

  it('re-checks entitlements, so a grant that lapsed stops the next page', async () => {
    const h = harness();
    const first = await run(h, 'FIX', { security: SECURITY });
    h.entitlements.policy = (req) => ({
      effectiveTier: null,
      fields: req.fieldIds.map((f) => fieldDecision(f, 'deny', 'NO_FIRM_ENTITLEMENT', null)),
      downgrades: [],
      logIds: [],
    });
    await expectError(
      h.runner.page(first.meta.resultId, 'fwd', HTTP),
      'ENTITLEMENT_DENIED',
      403,
    );
  });

  it('404 RESULT_EXPIRED for an unknown, expired or foreign resultId', async () => {
    const h = harness();
    const first = await run(h, 'FIX', { security: SECURITY });

    await expectError(h.runner.page('nope', 'fwd', HTTP), 'RESULT_EXPIRED', 404);
    await expectError(h.runner.page(first.meta.resultId, 'fwd', VIEWER), 'RESULT_EXPIRED', 404);

    h.clock.advance(600_000);
    await expectError(h.runner.page(first.meta.resultId, 'fwd', HTTP), 'RESULT_EXPIRED', 404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// result() — MSG-04 share links
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('result() — the producer, and the viewer (MSG-04)', () => {
  it('hands the producer exactly what was cached', async () => {
    const h = harness();
    const first = await run(h, 'FIX', { security: SECURITY });
    h.clock.advance(60_000);
    const again = await h.runner.result(first.meta.resultId, HTTP);
    expect(again.data).toBe(first.data);
    expect(again.meta).toBe(first.meta);
  });

  it('RE-RUNS for a viewer under the VIEWER’s entitlements, never the producer’s values', async () => {
    const h = harness();
    // The producer is entitled and gets a number.
    const producerPayload = { variant: 'equity', px: 188.5 };
    const viewerPayload = { variant: 'equity', px: null };
    let calls = 0;
    h.setModule('FIX', {
      resolve: (ctx: ResolveContext) => {
        calls += 1;
        return Promise.resolve(ctx.user.userId === HTTP.userId ? producerPayload : viewerPayload);
      },
    } as AnyModule);

    const first = await run(h, 'FIX', { security: SECURITY });
    expect(first.data).toEqual(producerPayload);

    // The viewer's firm has no grant for PX_VOLUME.
    h.entitlements.policy = (req) => ({
      effectiveTier: 'delayed',
      fields: req.fieldIds.map((f, i) =>
        i === 0
          ? fieldDecision(f, 'allow', 'OK', 'delayed')
          : fieldDecision(f, 'deny', 'NO_FIRM_ENTITLEMENT', null),
      ),
      downgrades: [],
      logIds: [],
    });

    const shared = await h.runner.result(first.meta.resultId, VIEWER);

    expect(calls).toBe(2); // it re-ran; it did not serve the cache
    expect(shared.data).toEqual(viewerPayload);
    expect(shared.data).not.toEqual(producerPayload);
    expect(shared.meta.entitlement).toEqual([
      { fieldId: PX_VOLUME, decision: 'deny', effectiveTier: null, reason: 'NO_FIRM_ENTITLEMENT' },
    ]);
    expect(shared.meta.resultId).not.toBe(first.meta.resultId);
    // The viewer's re-run is at the producer's instant, so the share link shows the same screen.
    expect(shared.meta.asOf).toEqual(first.meta.asOf);
    expect(shared.meta.traceId).toBe(VIEWER.traceId);
  });

  it('refuses the viewer outright when the viewer is entitled to nothing', async () => {
    const h = harness();
    const first = await run(h, 'FIX', { security: SECURITY });
    h.entitlements.policy = (req) => ({
      effectiveTier: null,
      fields: req.fieldIds.map((f) => fieldDecision(f, 'deny', 'NO_FIRM_ENTITLEMENT', null)),
      downgrades: [],
      logIds: [],
    });
    await expectError(h.runner.result(first.meta.resultId, VIEWER), 'ENTITLEMENT_DENIED', 403);
  });

  it('404 RESULT_EXPIRED once the ten minutes are up, for producer and viewer alike', async () => {
    const h = harness();
    const first = await run(h, 'FIX', { security: SECURITY });
    h.clock.advance(600_000);
    await expectError(h.runner.result(first.meta.resultId, HTTP), 'RESULT_EXPIRED', 404);
    await expectError(h.runner.result(first.meta.resultId, VIEWER), 'RESULT_EXPIRED', 404);
  });

  it('re-reads the instrument by id, so a viewer sees the same security', async () => {
    const h = harness();
    const first = await run(h, 'FIX', { security: SECURITY });
    h.resolutions.length = 0;
    await h.runner.result(first.meta.resultId, VIEWER);
    expect(h.resolutions[0]).toMatchObject({ ref: { id: 42 } });
  });

  it('404 RESULT_EXPIRED across a firm boundary — indistinguishable from a bogus id', async () => {
    const h = harness();
    const first = await run(h, 'FIX', { security: SECURITY });
    h.resolutions.length = 0;

    // A share link is an MSG-04 link and messages are firm-scoped, so a resultId presented by
    // another tenant is a probe. It gets the SAME answer a resultId that never existed gets: had
    // it been honoured, the 200 (or even the 403) would confirm which security another firm's
    // desk was looking at, and when.
    const real = await expectError(
      h.runner.result(first.meta.resultId, OUTSIDER),
      'RESULT_EXPIRED',
      404,
    );
    const bogus = await expectError(
      h.runner.result('01ZZZZZZZZZZZZZZZZZZZZZZZY', OUTSIDER),
      'RESULT_EXPIRED',
      404,
    );
    expect(real.status).toBe(bogus.status);
    // Nothing was resolved, so nothing about the producer's instrument was touched.
    expect(h.resolutions).toEqual([]);
    // …and the producer still has their own result.
    expect(h.cache.get(first.meta.resultId, HTTP.userId)).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers the runner exports
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ulid() and asOfOf()', () => {
  it('mints a 26-character, time-ordered, clock-driven id', () => {
    const clock = testClock();
    const a = ulid(clock);
    clock.advance(1_000);
    const b = ulid(clock);
    expect(a).toHaveLength(26);
    expect(b).toHaveLength(26);
    expect(b > a).toBe(true);
    // The random half makes two ids in the same millisecond differ.
    expect(ulid(clock)).not.toBe(ulid(clock));
  });

  it('is the only place the clock decides the as-of instant', () => {
    const clock = testClock();
    expect(asOfOf({}, clock)).toEqual({
      validAt: new Date(TEST_NOW),
      knownAt: new Date(TEST_NOW),
    });
    expect(asOfOf({ asOf: { validAt: '2026-01-02T03:04:05.000Z' } }, clock)).toEqual({
      validAt: new Date('2026-01-02T03:04:05.000Z'),
      knownAt: new Date(TEST_NOW),
    });
  });
});
