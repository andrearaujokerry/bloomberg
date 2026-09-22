/**
 * `test/integration/functions/export.test.ts` — WP-08's acceptance row for CSV export
 * (FUNCTIONS.md §1.4.4 L351-368, API.md §9 L1179-1201, FUNC-03, ENTL-01).
 *
 * Five things are proved here, in the order of how much it would cost to get them wrong:
 *
 *  1. **A denied field fails the WHOLE export.** `403 ENTITLEMENT_DENIED` with `details.reasons`,
 *     and — the part a weaker test would miss — the response body is an error envelope and
 *     contains no CSV at all. A partial file is the failure mode §9 exists to prevent: a column
 *     missing from a spreadsheet is indistinguishable from a column nobody asked for.
 *  2. **The bytes.** The `#` header block and the attribution line are asserted literally,
 *     including CRLF line ends and the absence of a BOM, because an export is read by software
 *     that does not forgive.
 *  3. **The `resultId` path** returns the cached payload with `x-regenerated: false`.
 *  4. **The regenerated path**: after the result has expired on the virtual clock, `resultId`
 *     alone is `404 RESULT_EXPIRED`, and `params + validAt + knownAt` re-resolves at the *stored*
 *     instants and produces the same table with `x-regenerated: true`.
 *  5. **Exactly one `usage_events` row per export**, of kind `fn.export` — including on the
 *     regenerated path, where the internal re-resolve must not also look like a launch.
 *
 * There are no real function manifests yet (`core/src/functions/manifests/` holds only its
 * generated index; WP-09/10/11 write the catalogue), so this file builds two fixture manifests
 * with `defineFunction` and injects them through `app.deps.functions`. They are deliberately small
 * and deliberately *not* written into the manifests directory, which the generated registry globs.
 *
 * Self-sufficient (TESTING §4.3): the licence tables, the firm, the user, the session, the grants
 * and the instrument are all created inside this file's own `withTxDb()` transaction, which is
 * also the app's database handle — so the routes read exactly these rows and the whole lot rolls
 * back. WP-15 owns the seed and it does not exist.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { FieldId, Tier } from '@terminal/core';
import { defineFunction, FunctionRegistry } from '@terminal/core';

import { getConfig } from '../../../src/config.js';
import { accessLog, type AccessLog } from '../../../src/entitlements/accessLog.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import { usageEvents, type UsageEvents } from '../../../src/observability/usageEvents.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, TEST_NOW, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, seedQuoteInstrument } from '../ws/helpers.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture manifests
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The source `NAME` resolves to (`field_licence`), and the attribution line it carries. */
const DERIVED_SOURCE = 'internal.derived';
const DERIVED_ATTRIBUTION = 'Derived by this terminal from the sources cited on the screen.';

/** `PX_LAST` on an equity resolves to this source — and no grant below covers it. */
const QUOTE_SOURCE = 'cboe.quotes';

/** A provenance id the fixture resolver cites; the collector never reads the row back. */
/**
 * The `provenance` row the fixture resolver cites, inserted per test.
 *
 * Not a made-up constant: the runner checks that every `provenance_id` a resolver cites through
 * `ctx.prov.add()` names a real row (DATA-10), so a fixture that invents one is a fixture that
 * would let a real manifest invent one too. The id goes into `meta.provenance`, into the CSV's
 * `# provenance:` line and into the `x-provenance` header, where it reads as an audit trail.
 */
let PROV_ID = 0;
const CAPTURED_AT = '2026-09-17T13:29:00.000Z';

interface FixturePayload {
  variant: 'equity';
  rows: { row: number; label: string; value: number }[];
}

const fixtureParams = z.object({ rows: z.number().int().min(1).max(10).default(2) });

/** The manifest body shared by both fixtures; only the code and the field set differ. */
const fixture = (code: string, fields: readonly FieldId[], aliases: readonly string[] = []) =>
  defineFunction<typeof fixtureParams, FixturePayload>({
    code,
    name: `Export fixture ${code}`,
    aliases: [...aliases],
    ...(aliases.length === 0 ? {} : { aliasParams: { [aliases[0]!]: { rows: 3 } } }),
    tier: 1,
    category: 'reference',
    assetClasses: ['equity'],
    requiresSecurity: true,
    variants: { equity: 'equity' },
    params: fixtureParams,
    paramGrammar: { positional: [{ name: 'rows', type: 'int', optional: true }] },
    fieldIds: (): FieldId[] => [...fields],
    pageable: false,
    live: null,
    csv: {
      filename: (_params, ctx): string =>
        `${code}_${(ctx.display ?? 'NONE').replace(/\s+/g, '_')}.csv`,
      columns: [
        { id: 'row', label: 'Row', type: 'number' },
        { id: 'label', label: 'Label', type: 'string' },
        { id: 'value', label: 'Value', type: 'number' },
      ],
      rows: (payload): (string | number | null)[][] =>
        payload.rows.map((r) => [r.row, r.label, r.value]),
    },
    help: {
      summary: `${code} fixture`,
      description: 'A fixture function used by the WP-08 export acceptance test.',
      params: [{ name: 'rows', text: 'How many rows to emit.', example: '3' }],
      keys: [],
      sources: [DERIVED_SOURCE],
      related: [],
    },
    keymap: [],
    screenKind: 'declarative',
    payloadVersion: 1,
  });

/** Exports cleanly: every field it needs is granted for export. */
const XPT = fixture('XPT', ['NAME'], ['XPA']);
/** Cannot export: `PX_LAST` resolves to a source the firm holds no grant for. */
const XPD = fixture('XPD', ['NAME', 'PX_LAST']);

const REGISTRY = new FunctionRegistry([XPT, XPD]);

const fixtureModule: FunctionServerModule<z.infer<typeof fixtureParams>, FixturePayload> = {
  async resolve(ctx, params) {
    ctx.prov.add({
      sourceId: DERIVED_SOURCE,
      provenanceId: PROV_ID,
      capturedAt: new Date(CAPTURED_AT),
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });
    const rows = Array.from({ length: params.rows }, (_v, i) => ({
      row: i + 1,
      // A comma and a quote, so RFC 4180 escaping is exercised by the real exporter rather than
      // by a unit test of the escaper.
      label: i === 0 ? 'Apple, Inc "A"' : `row ${i + 1}`,
      value: 1 / (i + 3),
    }));
    return Promise.resolve({ variant: 'equity' as const, rows });
  },
};

const MODULES = { XPT: fixtureModule, XPD: fixtureModule };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

const t: TestDb = withTxDb();

/** Well before `TEST_NOW`, so a grant written with it is live on the virtual clock. */
const GRANT_FROM = '2026-01-01T00:00:00.000Z';

/** A timer port that never fires: the batched writers are flushed by hand in this file. */
const MANUAL_TIMERS = {
  setInterval: (): unknown => undefined,
  clearInterval: (): void => undefined,
};

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  userId: number;
  firmId: number;
  instrumentId: number;
  display: string;
  cache: ResultCache;
  events: UsageEvents;
  access: AccessLog;
}

let env: Env;

const API = '/api/v1';

/**
 * The shipped licence terms, seeded only when they are missing.
 *
 * `seedLicences` is idempotent but not *silent*: on a database `test/globalSetup.ts` already
 * seeded, it still issues its inserts and updates against `licence_registry`, `field_licence` and
 * `config_versions` — rows every other integration file is also writing from its own open
 * transaction, in its own fork. Two transactions holding one of those keys and waiting for the
 * other is a deadlock, and which files a run happens to schedule together then decides whether it
 * is green. (`vitest.config.ts` records the same hazard for the replay project and solves it by
 * serialising.) A read first means the common case takes no locks at all, while a database with
 * no seed still gets one.
 */
async function ensureLicences(): Promise<void> {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);
}

beforeEach(async () => {
  // The shipped licence terms first: `field_licence` is what maps NAME → internal.derived and
  // PX_LAST → cboe.quotes, and `bootstrapProvenance` (inside `seedQuoteInstrument`) must not be
  // the thing that invents a licence row for either.
  await ensureLicences();
  PROV_ID = await bootstrapProvenance(t, DERIVED_SOURCE, 'export-fixture');

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Export Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);

  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'Export User', 'user') RETURNING user_id`,
    [firmId, `export-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);

  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );

  // One grant per subject, scoped to the source `NAME` comes from. The evaluator needs a firm
  // grant AND a user grant (ARCHITECTURE §10 rules 4-5), and `PX_LAST` (cboe.quotes) is covered by
  // neither — which is exactly the denial the export test needs, produced by a contract rather
  // than by a stub.
  await grantSource(firmId, userId, DERIVED_SOURCE);

  const seeded = await seedQuoteInstrument(t, {
    ticker: `XP${randomUUID().slice(0, 3).toUpperCase()}`,
    name: 'Export Fixture Inc',
  });

  const tickerRow = await t.client.query<{ ticker: string }>(
    `SELECT ticker FROM instruments WHERE instrument_id = $1 AND tx_to = 'infinity' LIMIT 1`,
    [seeded.instrumentId],
  );
  const display = `${tickerRow.rows[0]!.ticker} US Equity`;

  // The bitemporal `tx_from` of every row written above is `clock_timestamp()` — the real wall
  // clock, which the virtual clock knows nothing about. A `knownAt` earlier than that instant sees
  // none of this fixture, so the clock starts at whichever is later: `TEST_NOW` (inside the seeded
  // partitions) or the moment the writes landed.
  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const clock = testClock(Math.max(TEST_NOW, Date.parse(wrote.rows[0]!.at) + 1_000));
  const harness = await createTestApp({ db: t.db, clock });
  const cache = new ResultCache({ clock });
  const events = usageEvents({ db: t.db, clock, timers: MANUAL_TIMERS });
  const access = accessLog({ db: t.db, clock, timers: MANUAL_TIMERS });

  // `app.deps` is the object `buildApp` was decorated with, so filling in the optional function
  // bag here is the same wiring `index.ts` does at startup.
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: cache,
    usageEvents: events,
    accessLog: access,
  };

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    userId,
    firmId,
    instrumentId: seeded.instrumentId,
    display,
    cache,
    events,
    access,
  };
});

afterEach(async () => {
  await env.harness.close();
});

/** One grant for the firm and one for the user: the evaluator requires both. */
async function grantSource(firmId: number, userId: number, sourceId: string): Promise<void> {
  for (const [kind, id] of [
    ['firm', firmId],
    ['user', userId],
  ] as const) {
    await t.client.query(
      `INSERT INTO entitlement_grants
         (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
          usage_display, usage_export, usage_api, valid_from, valid_to)
       VALUES ($1, $2, $3, NULL, NULL, 'realtime'::tier, true, true, true,
               $4::timestamptz, 'infinity'::timestamptz)`,
      [kind, id, sourceId, GRANT_FROM],
    );
  }
}

function headers(): Record<string, string> {
  return { cookie: env.cookie, 'x-requested-with': 'terminal' };
}

interface RunResult {
  data: FixturePayload;
  meta: {
    resultId: string;
    traceId: string;
    asOf: { validAt: string; knownAt: string };
    tier: Tier;
    staleness: string;
    provenance: { provenanceId: number; attribution: string; sourceId: string }[];
    entitlement: { fieldId: string; decision: string; reason: string }[];
  };
}

/** Launch a fixture function against the seeded instrument. */
async function run(code: string, params: Record<string, unknown> = {}): Promise<RunResult> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/${code}/run`,
    headers: headers(),
    payload: { security: { id: env.instrumentId }, params, launchKind: 'launch', panelId: 'p1' },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return JSON.parse(res.payload) as RunResult;
}

/** Rows of `usage_events` for one trace, newest last. */
async function usageRows(
  traceId: string,
): Promise<{ kind: string; code: string | null; details: Record<string, unknown> }[]> {
  await env.events.flush();
  const res = await t.client.query<{ kind: string; code: string | null; details: unknown }>(
    `SELECT kind, code, details FROM usage_events WHERE trace_id = $1 ORDER BY event_id`,
    [traceId],
  );
  return res.rows.map((r) => ({
    kind: r.kind,
    code: r.code,
    details: (r.details ?? {}) as Record<string, unknown>,
  }));
}

const TRACE = (): string => randomUUID();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The resultId path
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('GET /functions/:code/csv', () => {
  it('exports the cached result by resultId, byte for byte', async () => {
    const launched = await run('XPT');
    const traceId = TRACE();

    const res = await env.app.inject({
      method: 'GET',
      url: `${API}/functions/XPT/csv?resultId=${launched.meta.resultId}`,
      headers: { ...headers(), 'x-trace-id': traceId },
    });

    expect(res.statusCode, res.payload).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['x-regenerated']).toBe('false');
    expect(res.headers['x-as-of-valid']).toBe(launched.meta.asOf.validAt);
    expect(res.headers['x-as-of-known']).toBe(launched.meta.asOf.knownAt);
    expect(res.headers['x-provenance']).toBe(String(PROV_ID));
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="XPT_${env.display.replace(/\s+/g, '_')}.csv"`,
    );

    // UTF-8, no BOM.
    expect(res.rawPayload[0]).not.toBe(0xef);
    expect(res.payload.startsWith('# terminal-export v1')).toBe(true);

    // CRLF everywhere, and only there: no bare LF survives.
    expect(res.payload.replace(/\r\n/g, '')).not.toContain('\n');

    const lines = res.payload.split('\r\n');
    expect(lines[0]).toBe('# terminal-export v1');
    expect(lines[1]).toBe(`# function: XPT  security: ${env.display}  params: {"rows":2}`);
    expect(lines[2]).toBe(
      `# asOf: validAt=${launched.meta.asOf.validAt} knownAt=${launched.meta.asOf.knownAt}  ` +
        `tier: ${launched.meta.tier}  staleness: ${launched.meta.staleness}`,
    );
    // The attribution line — `licence_registry.attribution` of the cited source, verbatim.
    expect(lines[3]).toBe(`# source: ${DERIVED_ATTRIBUTION}`);
    expect(lines[4]).toBe(
      `# provenance: ${PROV_ID}  engines:   trace: ${traceId}  regenerated: false`,
    );

    // The table: the column ids, then the payload's own rows at full stored precision, with
    // RFC 4180 quoting of the embedded comma and doubled quotes.
    expect(lines[5]).toBe('row,label,value');
    expect(lines[6]).toBe(`1,"Apple, Inc ""A""",${String(1 / 3)}`);
    expect(lines[7]).toBe(`2,row 2,${String(1 / 4)}`);
    // A trailing CRLF ends the last record, so the split leaves one empty tail element.
    expect(lines[8]).toBe('');
    expect(lines).toHaveLength(9);
  });

  it('resolves an alias and carries its aliasParams into the exported params', async () => {
    const launched = await run('XPA');
    expect(launched.data.rows).toHaveLength(3);

    const res = await env.app.inject({
      method: 'GET',
      url: `${API}/functions/XPA/csv?resultId=${launched.meta.resultId}`,
      headers: headers(),
    });

    expect(res.statusCode, res.payload).toBe(200);
    const lines = res.payload.split('\r\n');
    expect(lines[1]).toBe(
      `# function: XPT [alias: XPA]  security: ${env.display}  params: {"rows":3}`,
    );
    // Three data rows plus the five comment lines, the header row and the empty tail.
    expect(lines).toHaveLength(10);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // 2. The regenerated-at-asOf path
  // ───────────────────────────────────────────────────────────────────────────────────────────

  it('404 RESULT_EXPIRED once the result has aged out, and re-resolves at the stored asOf', async () => {
    const launched = await run('XPT', { rows: 2 });
    const { validAt, knownAt } = launched.meta.asOf;

    // Past the 10-minute TTL of `ResultCache` (FUNCTIONS.md L351).
    env.clock.advance(11 * 60 * 1_000);

    const expired = await env.app.inject({
      method: 'GET',
      url: `${API}/functions/XPT/csv?resultId=${launched.meta.resultId}`,
      headers: headers(),
    });
    expect(expired.statusCode).toBe(404);
    expect((JSON.parse(expired.payload) as { error: { code: string } }).error.code).toBe(
      'RESULT_EXPIRED',
    );

    const params = Buffer.from(JSON.stringify({ rows: 2 }), 'utf8').toString('base64url');
    const query = new URLSearchParams({
      resultId: launched.meta.resultId,
      params,
      security: env.display,
      validAt,
      knownAt,
    });
    const traceId = TRACE();
    const res = await env.app.inject({
      method: 'GET',
      url: `${API}/functions/XPT/csv?${query.toString()}`,
      headers: { ...headers(), 'x-trace-id': traceId },
    });

    expect(res.statusCode, res.payload).toBe(200);
    expect(res.headers['x-regenerated']).toBe('true');
    // The re-resolve read at the STORED instants, not at the clock's new "now".
    expect(res.headers['x-as-of-valid']).toBe(validAt);
    expect(res.headers['x-as-of-known']).toBe(knownAt);

    const lines = res.payload.split('\r\n');
    expect(lines[2]).toBe(
      `# asOf: validAt=${validAt} knownAt=${knownAt}  tier: ${launched.meta.tier}  ` +
        `staleness: ${launched.meta.staleness}`,
    );
    expect(lines[4]).toBe(
      `# provenance: ${PROV_ID}  engines:   trace: ${traceId}  regenerated: true`,
    );
    // Same table as the cached export would have produced.
    expect(lines[5]).toBe('row,label,value');
    expect(lines[6]).toBe(`1,"Apple, Inc ""A""",${String(1 / 3)}`);

    // Still exactly one usage row, of kind fn.export: the internal re-resolve is a step of this
    // export, not a second launch.
    const rows = await usageRows(traceId);
    expect(rows.map((r) => r.kind)).toEqual(['fn.export']);
    expect(rows[0]?.details.regenerated).toBe(true);
  });

  it('400 BAD_REQUEST when neither a resultId nor a complete re-resolve tuple is given', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `${API}/functions/XPT/csv`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.payload) as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // 3. A denied field fails the whole export
  // ───────────────────────────────────────────────────────────────────────────────────────────

  it('403 ENTITLEMENT_DENIED for a denied field — and NOT a partial file', async () => {
    // The launch itself succeeds: a partial denial is a 200 with `meta.entitlement` (ENTL-05).
    const launched = await run('XPD');
    const denied = launched.meta.entitlement.filter((n) => n.decision === 'deny');
    expect(denied.map((n) => n.fieldId)).toContain('PX_LAST');

    const traceId = TRACE();
    const res = await env.app.inject({
      method: 'GET',
      url: `${API}/functions/XPD/csv?resultId=${launched.meta.resultId}`,
      headers: { ...headers(), 'x-trace-id': traceId },
    });

    expect(res.statusCode, res.payload).toBe(403);
    expect(res.headers['content-type']).toContain('application/json');

    const body = JSON.parse(res.payload) as {
      error: { code: string; details?: { reasons?: { fieldId: string; reason: string }[] } };
    };
    expect(body.error.code).toBe('ENTITLEMENT_DENIED');
    const reasons = body.error.details?.reasons ?? [];
    expect(reasons.map((r) => r.fieldId)).toEqual(['PX_LAST']);
    expect(reasons[0]?.reason).toBeTruthy();

    // No subset escaped: nothing in the response looks like the file that would have been sent.
    expect(res.payload).not.toContain('# terminal-export');
    expect(res.payload).not.toContain('row,label,value');
    expect(res.payload).not.toContain('Apple');

    // And nothing was billed as an export.
    expect(await usageRows(traceId)).toEqual([]);
  });

  it('exports the same function once the missing source is granted', async () => {
    await grantSource(env.firmId, env.userId, QUOTE_SOURCE);
    (env.harness.entitlements as { invalidate?: () => void }).invalidate?.();

    const launched = await run('XPD');
    const res = await env.app.inject({
      method: 'GET',
      url: `${API}/functions/XPD/csv?resultId=${launched.meta.resultId}`,
      headers: headers(),
    });

    expect(res.statusCode, res.payload).toBe(200);
    expect(res.payload).toContain('row,label,value');
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // 4. One usage row, and the access-log rows
  // ───────────────────────────────────────────────────────────────────────────────────────────

  it('writes exactly one usage_events row per export, and the export access-log rows', async () => {
    const launched = await run('XPT');
    const traceId = TRACE();

    for (let i = 0; i < 2; i += 1) {
      const res = await env.app.inject({
        method: 'GET',
        url: `${API}/functions/XPT/csv?resultId=${launched.meta.resultId}`,
        headers: { ...headers(), 'x-trace-id': traceId },
      });
      expect(res.statusCode, res.payload).toBe(200);
    }

    const rows = await usageRows(traceId);
    expect(rows.map((r) => r.kind)).toEqual(['fn.export', 'fn.export']);
    expect(rows.every((r) => r.code === 'XPT')).toBe(true);
    expect(rows[0]?.details.regenerated).toBe(false);

    // ENTL-04: one access-log row per field of the export decision, under `export:<CODE>`.
    await env.access.flush();
    const audit = await t.client.query<{ field_id: string; usage: string; purpose: string }>(
      `SELECT field_id, usage, purpose FROM access_log WHERE trace_id = $1 ORDER BY log_id`,
      [traceId],
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows.every((r) => r.usage === 'export')).toBe(true);
    expect(audit.rows.every((r) => r.purpose === 'export:XPT')).toBe(true);
    expect(audit.rows.every((r) => r.field_id === 'NAME')).toBe(true);
  });

  it('names the security even when the cache does not hand the result back', async () => {
    // The defensive branch of `export.ts#payloadFor`: the runner produced a payload, but reading it
    // back out of the cache missed. It must not silently become an export "about no instrument".
    //
    // Before the fix that branch built a `CachedResult` with `security: null`, so the export
    // entitlement was evaluated with `instrumentId: null, assetClass: null` — an instrument-scoped
    // denial (a restricted list, an ethical wall, a per-instrument licence) was never consulted,
    // `manifest.fieldIds(null)` checked a different field set, and the ENTL-04 rows were written
    // with `instrument_id NULL`, so the audit trail did not say what had been exported.
    class AmnesiacCache extends ResultCache {
      override get(): undefined {
        return undefined;
      }
    }
    env.harness.deps.functions = {
      ...env.harness.deps.functions,
      resultCache: new AmnesiacCache({ clock: env.clock }),
    };

    const launched = await run('XPT', { rows: 1 });
    const params = Buffer.from(JSON.stringify({ rows: 1 }), 'utf8').toString('base64url');
    const query = new URLSearchParams({
      params,
      security: env.display,
      validAt: launched.meta.asOf.validAt,
      knownAt: launched.meta.asOf.knownAt,
    });
    const traceId = TRACE();

    const res = await env.app.inject({
      method: 'GET',
      url: `${API}/functions/XPT/csv?${query.toString()}`,
      headers: { ...headers(), 'x-trace-id': traceId },
    });

    expect(res.statusCode, res.payload).toBe(200);
    // The filename still names the security…
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="XPT_${env.display.replace(/\s+/g, '_')}.csv"`,
    );
    // …and so does the header line the file carries.
    expect(res.payload.split('\r\n')[1]).toContain(`security: ${env.display}`);

    // The decision that let this file out was about the real instrument, and the audit says so.
    await env.access.flush();
    const audit = await t.client.query<{ instrument_id: string | null; purpose: string }>(
      `SELECT instrument_id::text AS instrument_id, purpose FROM access_log WHERE trace_id = $1`,
      [traceId],
    );
    // The internal re-resolve logs its own `purpose: 'XPT'` rows; the export decision is the
    // `export:XPT` one, and that is the one that had lost its instrument.
    const exportRows = audit.rows.filter((r) => r.purpose === 'export:XPT');
    expect(exportRows.length).toBeGreaterThan(0);
    expect(exportRows.every((r) => Number(r.instrument_id) === env.instrumentId)).toBe(true);
  });

  it('404 FUNCTION_NOT_FOUND for a code the registry does not hold', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `${API}/functions/ZZZ/csv?resultId=whatever`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(404);
    expect((JSON.parse(res.payload) as { error: { code: string } }).error.code).toBe(
      'FUNCTION_NOT_FOUND',
    );
  });

  it("refuses another user's resultId rather than exporting their data", async () => {
    const launched = await run('XPT');

    const other = await t.client.query<{ user_id: string }>(
      `INSERT INTO users (firm_id, email, display_name, role)
       VALUES ($1, $2, 'Other User', 'user') RETURNING user_id`,
      [env.firmId, `other-${randomUUID()}@demo.invalid`],
    );
    const otherToken = `sess-${randomUUID()}`;
    await t.client.query(
      `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
       VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
      [Number(other.rows[0]!.user_id), createHash('sha256').update(otherToken, 'utf8').digest()],
    );

    const res = await env.app.inject({
      method: 'GET',
      url: `${API}/functions/XPT/csv?resultId=${launched.meta.resultId}`,
      headers: {
        cookie: `tsid=${encodeURIComponent(cookie.sign(otherToken, getConfig().SESSION_SECRET))}`,
      },
    });

    // Indistinguishable from an expired id — a holder of a resultId learns nothing about it.
    expect(res.statusCode).toBe(404);
    expect((JSON.parse(res.payload) as { error: { code: string } }).error.code).toBe(
      'RESULT_EXPIRED',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. POST /data/csv
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /data/csv', () => {
  it('exports a reference read as one row per security', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/data/csv`,
      headers: headers(),
      payload: {
        kind: 'reference',
        securities: [{ id: env.instrumentId }],
        fields: ['NAME'] satisfies FieldId[],
      },
    });

    expect(res.statusCode, res.payload).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    const lines = res.payload.split('\r\n');
    expect(lines[0]).toBe('# terminal-export v1');
    expect(lines.some((l) => l === 'security,NAME')).toBe(true);
    expect(res.payload).toContain('Export Fixture Inc');
  });

  it('403 ENTITLEMENT_DENIED when any requested field is not licensed for export', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/data/csv`,
      headers: headers(),
      payload: {
        kind: 'reference',
        securities: [{ id: env.instrumentId }],
        fields: ['NAME', 'PX_LAST'] satisfies FieldId[],
      },
    });

    expect(res.statusCode, res.payload).toBe(403);
    const body = JSON.parse(res.payload) as {
      error: { code: string; details?: { reasons?: { fieldId: string }[] } };
    };
    expect(body.error.code).toBe('ENTITLEMENT_DENIED');
    expect((body.error.details?.reasons ?? []).map((r) => r.fieldId)).toContain('PX_LAST');
    expect(res.payload).not.toContain('# terminal-export');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 6. The catalogue and result routes the exporter depends on
//
// `http/routes/functions.ts` is this package's file too, and the CSV route reads what these
// routes publish (the manifest, the alias table and the result cache). A catalogue that stops
// resolving `XPA → XPT`, or a `/results` route that hands one user another's payload, breaks the
// export contract from behind, so they are asserted here rather than assumed.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the function catalogue', () => {
  it('publishes the manifests with an ETag and answers 304 on a repeat', async () => {
    const first = await env.app.inject({
      method: 'GET',
      url: `${API}/functions`,
      headers: headers(),
    });
    expect(first.statusCode, first.payload).toBe(200);

    const body = JSON.parse(first.payload) as {
      registryVersion: string;
      functions: { code: string; paramsSchema: Record<string, unknown>; csvColumns: unknown }[];
    };
    expect(body.functions.map((f) => f.code)).toEqual(['XPD', 'XPT']);
    // `paramsSchema` is `z.toJSONSchema(manifest.params)`, not the zod object.
    expect(body.functions[1]?.paramsSchema).toHaveProperty('properties.rows');
    // Fixed columns publish; a payload-dependent column list would be null.
    expect(body.functions[1]?.csvColumns).toHaveLength(3);

    const etag = first.headers.etag;
    expect(typeof etag).toBe('string');

    const again = await env.app.inject({
      method: 'GET',
      url: `${API}/functions`,
      headers: { ...headers(), 'if-none-match': String(etag) },
    });
    expect(again.statusCode).toBe(304);
    expect(again.payload).toBe('');
  });

  it('resolves an alias on GET /functions/:code and serves its help', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `${API}/functions/XPA`,
      headers: headers(),
    });
    expect(res.statusCode, res.payload).toBe(200);
    const manifest = JSON.parse(res.payload) as {
      code: string;
      aliases: string[];
      fieldIds: Record<string, string[]>;
    };
    expect(manifest.code).toBe('XPT');
    expect(manifest.aliases).toEqual(['XPA']);
    expect(manifest.fieldIds).toEqual({ equity: ['NAME'] });

    const help = await env.app.inject({
      method: 'GET',
      url: `${API}/functions/XPT/help?assetClass=equity`,
      headers: headers(),
    });
    expect(help.statusCode, help.payload).toBe(200);
    const body = JSON.parse(help.payload) as {
      code: string;
      fields: { id: string; sourceId: string; attribution: string }[];
    };
    expect(body.code).toBe('XPT');
    // The dictionary row, with the licence that governs it (API-07).
    expect(body.fields).toEqual([
      expect.objectContaining({
        id: 'NAME',
        sourceId: DERIVED_SOURCE,
        attribution: DERIVED_ATTRIBUTION,
      }),
    ]);
  });

  it('serves a cached result to its producer and 404s an unknown id', async () => {
    const launched = await run('XPT');

    const mine = await env.app.inject({
      method: 'GET',
      url: `${API}/results/${launched.meta.resultId}`,
      headers: headers(),
    });
    expect(mine.statusCode, mine.payload).toBe(200);
    const payload = JSON.parse(mine.payload) as RunResult;
    expect(payload.meta.resultId).toBe(launched.meta.resultId);
    expect(payload.data.rows).toHaveLength(2);

    const missing = await env.app.inject({
      method: 'GET',
      url: `${API}/results/01ZZZZZZZZZZZZZZZZZZZZZZZZ`,
      headers: headers(),
    });
    expect(missing.statusCode).toBe(404);
    expect((JSON.parse(missing.payload) as { error: { code: string } }).error.code).toBe(
      'RESULT_EXPIRED',
    );
  });

  it('a resultId from another FIRM is 404 RESULT_EXPIRED, like an id that never existed', async () => {
    const launched = await run('XPT');

    // A second tenant, granted everything, so nothing but the firm boundary can refuse them.
    const otherFirm = await t.client.query<{ firm_id: string }>(
      `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
      [`Other Firm ${randomUUID().slice(0, 8)}`],
    );
    const otherFirmId = Number(otherFirm.rows[0]!.firm_id);
    const otherUser = await t.client.query<{ user_id: string }>(
      `INSERT INTO users (firm_id, email, display_name, role)
       VALUES ($1, $2, 'Other Tenant', 'user') RETURNING user_id`,
      [otherFirmId, `tenant-${randomUUID()}@demo.invalid`],
    );
    const otherUserId = Number(otherUser.rows[0]!.user_id);
    await grantSource(otherFirmId, otherUserId, DERIVED_SOURCE);

    const otherToken = `sess-${randomUUID()}`;
    await t.client.query(
      `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
       VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
      [otherUserId, createHash('sha256').update(otherToken, 'utf8').digest()],
    );
    const otherHeaders = {
      cookie: `tsid=${encodeURIComponent(cookie.sign(otherToken, getConfig().SESSION_SECRET))}`,
      'x-requested-with': 'terminal',
    };

    // API.md §5.3 re-runs a shared result under the VIEWER's entitlements for MSG-04 share links
    // — but messages are firm-scoped, so no share link ever crosses a firm. Honouring the id here
    // told the other tenant which security this desk was looking at, and when; refusing it with a
    // 403 would still have confirmed that the id exists. It gets the 404 a bogus id gets.
    const across = await env.app.inject({
      method: 'GET',
      url: `${API}/results/${launched.meta.resultId}`,
      headers: otherHeaders,
    });
    expect(across.statusCode, across.payload).toBe(404);
    expect((JSON.parse(across.payload) as { error: { code: string } }).error.code).toBe(
      'RESULT_EXPIRED',
    );

    const bogus = await env.app.inject({
      method: 'GET',
      url: `${API}/results/01ZZZZZZZZZZZZZZZZZZZZZZZZ`,
      headers: otherHeaders,
    });
    expect(bogus.statusCode).toBe(404);
    expect(JSON.parse(bogus.payload)).toMatchObject({ error: { code: 'RESULT_EXPIRED' } });

    // A colleague in the PRODUCER's firm still gets the share link, re-run under their own
    // entitlements — the behaviour §5.3 asks for is intact.
    const colleague = await t.client.query<{ user_id: string }>(
      `INSERT INTO users (firm_id, email, display_name, role)
       VALUES ($1, $2, 'Colleague', 'user') RETURNING user_id`,
      [env.firmId, `colleague-${randomUUID()}@demo.invalid`],
    );
    const colleagueId = Number(colleague.rows[0]!.user_id);
    await grantSource(env.firmId, colleagueId, DERIVED_SOURCE);
    const colleagueToken = `sess-${randomUUID()}`;
    await t.client.query(
      `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
       VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
      [colleagueId, createHash('sha256').update(colleagueToken, 'utf8').digest()],
    );
    const shared = await env.app.inject({
      method: 'GET',
      url: `${API}/results/${launched.meta.resultId}`,
      headers: {
        cookie: `tsid=${encodeURIComponent(cookie.sign(colleagueToken, getConfig().SESSION_SECRET))}`,
        'x-requested-with': 'terminal',
      },
    });
    expect(shared.statusCode, shared.payload).toBe(200);
    // A re-run, not the producer's cached copy.
    expect((JSON.parse(shared.payload) as RunResult).meta.resultId).not.toBe(
      launched.meta.resultId,
    );
  });
});
