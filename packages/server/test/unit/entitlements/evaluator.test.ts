/**
 * WORKPLAN WP-07 acceptance row — `test/unit/entitlements/evaluator.test.ts`: "the five rules in
 * order; `SOURCE_TIER_CAP` beats a generous grant; per-field `downgrade` list is complete".
 *
 * A unit test in the strict sense: no database, no network, no clock but the virtual one. The
 * evaluator's only source of facts is the `LicenceRegistry`, so the registry is a stub whose three
 * tables (`licence_registry`, `field_licence`, `entitlement_grants`) are maps this file writes. That
 * is what makes "rule 2 beats rule 4" assertable at all — the same request is answered twice, once
 * with the earlier rule satisfied and once without, and the reason code must move.
 *
 * Every case is built so that the LATER rules would have produced a DIFFERENT answer. A test that
 * only asserts `NO_FIRM_ENTITLEMENT` when nothing else is set up proves nothing about order.
 */

import { describe, expect, it } from 'vitest';

import type { AssetClass, EntitlementRequest, FieldClass, FieldId, Tier } from '@terminal/core';

import type { AccessLog, AccessLogRow } from '../../../src/entitlements/accessLog.js';
import { evaluator, maxTier, minTier, tierRank } from '../../../src/entitlements/evaluator.js';
import type {
  FieldSource,
  GrantRow,
  LicenceEntry,
  LicenceRegistry,
  LicenceRegistryStats,
} from '../../../src/entitlements/licenceRegistry.js';
import type { QuotaCheck, QuotaState, Quotas } from '../../../src/entitlements/quotas.js';
import type { WsEntitlements } from '../../../src/ws/session.js';
import type { Db } from '../../../src/db/client.js';
import { testClock, TEST_NOW } from '../../../src/test/clock.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Stubs — the three tables, as maps
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The evaluator never reads the database: every fact comes from the registry. */
const NO_DB = {} as unknown as Db;

const CBOE = 'cboe.quotes';
const YAHOO = 'yahoo.chart';

function licenceEntry(sourceId: string, over: Partial<LicenceEntry> = {}): LicenceEntry {
  return {
    sourceId,
    sourceName: sourceId,
    publisher: 'Test Publisher',
    licenceKind: 'exchange_delayed',
    display: true,
    nonDisplay: false,
    derived: false,
    redistribution: false,
    exportAllowed: false,
    apiAllowed: false,
    maxTier: 'delayed',
    intrinsicDelayMin: 15,
    retentionDays: null,
    attribution: null,
    contractRef: null,
    ...over,
  };
}

function grantRow(
  subjectKind: 'user' | 'firm',
  subjectId: number,
  over: Partial<GrantRow> = {},
): GrantRow {
  return {
    grantId: Math.floor(Math.random() * 1e9),
    subjectKind,
    subjectId,
    sourceId: null,
    assetClass: null,
    fieldClass: null,
    maxTier: 'delayed',
    usageDisplay: true,
    usageExport: true,
    usageApi: true,
    validFrom: '-infinity',
    validTo: null,
    contractRef: null,
    ...over,
  };
}

interface StubRegistry extends LicenceRegistry {
  readonly licences: Map<string, LicenceEntry>;
  /** `${fieldId}|${assetClass ?? '*'}` → source. */
  readonly fields: Map<string, FieldSource>;
  readonly grants: GrantRow[];
  /** What a `config_versions` bump does: move the version the evaluator's cache is keyed on. */
  bump(): void;
  readonly refreshes: number;
}

/**
 * `now` is what `grantsFor` filters validity against, exactly as the real registry does: it holds
 * every grant row and decides liveness per call, so a grant that lapses does so the instant it
 * lapses. Default: the frozen `TEST_NOW`, which every `-infinity`/open grant passes.
 */
function stubRegistry(now: () => number = () => TEST_NOW): StubRegistry {
  const licences = new Map<string, LicenceEntry>();
  const fields = new Map<string, FieldSource>();
  const grants: GrantRow[] = [];
  let version = 1;
  let refreshes = 0;

  return {
    licences,
    fields,
    grants,
    bump(): void {
      version += 1;
    },
    get refreshes(): number {
      return refreshes;
    },
    licence(sourceId: string): LicenceEntry | undefined {
      return licences.get(sourceId);
    },
    fieldSource(fieldId: FieldId, assetClass: AssetClass | null): FieldSource | undefined {
      if (assetClass !== null) {
        const exact = fields.get(`${fieldId}|${assetClass}`);
        if (exact !== undefined) return exact;
      }
      return fields.get(`${fieldId}|*`);
    },
    grantsFor(subjectKind: 'user' | 'firm', subjectId: number): readonly GrantRow[] {
      const at = now();
      return grants.filter((g) => {
        if (g.subjectKind !== subjectKind || g.subjectId !== subjectId) return false;
        const from = g.validFrom === '-infinity' ? -Infinity : Date.parse(g.validFrom);
        const to = g.validTo === null ? Infinity : Date.parse(g.validTo);
        return from <= at && at < to;
      });
    },
    version(): number {
      return version;
    },
    reload(): Promise<void> {
      return Promise.resolve();
    },
    refreshIfStale(): Promise<void> {
      refreshes += 1;
      return Promise.resolve();
    },
    stats(): LicenceRegistryStats {
      return {
        version,
        licences: licences.size,
        fieldLicences: fields.size,
        grants: grants.length,
        loads: 1,
        freshChecks: refreshes,
      };
    },
  };
}

interface StubLog extends AccessLog {
  readonly rows: AccessLogRow[];
}

function stubAccessLog(): StubLog {
  const rows: AccessLogRow[] = [];
  let nextId = 0;
  return {
    rows,
    append(row: AccessLogRow): number {
      rows.push(row);
      nextId += 1;
      return nextId;
    },
    flush(): Promise<number> {
      return Promise.resolve(0);
    },
    size(): number {
      return rows.length;
    },
    start(): void {
      /* nothing to arm */
    },
    stop(): Promise<void> {
      return Promise.resolve();
    },
    stats() {
      return { buffered: 0, written: rows.length, flushes: 0, dropped: 0 };
    },
  };
}

interface StubQuotas extends Quotas {
  readonly checks: number;
  readonly recorded: number[];
  /** Data points charged through `record()` — rule 8 must charge what it checked. */
  readonly points: number;
}

/** A quota source that answers `answer` and counts what it was asked. */
function stubQuotas(answer: QuotaCheck): StubQuotas {
  let checks = 0;
  let points = 0;
  const recorded: number[] = [];
  return {
    get checks(): number {
      return checks;
    },
    get points(): number {
      return points;
    },
    recorded,
    limitsFor(): Promise<{
      dailyUniqueInstruments: number;
      monthlyDataPoints: number;
      concurrentSubscriptions: number;
    }> {
      return Promise.resolve({
        dailyUniqueInstruments: 500,
        monthlyDataPoints: 2_000_000,
        concurrentSubscriptions: 2_000,
      });
    },
    concurrencyCeiling(): Promise<number | null> {
      return Promise.resolve(null);
    },
    check(): Promise<QuotaCheck> {
      checks += 1;
      return Promise.resolve(answer);
    },
    record(ctx: { instrumentIds?: readonly number[]; dataPoints?: number }): Promise<void> {
      recorded.push(...(ctx.instrumentIds ?? []));
      points += ctx.dataPoints ?? 0;
      return Promise.resolve();
    },
    state(): Promise<QuotaState> {
      throw new Error('stubQuotas.state: not used by the evaluator');
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The world every case starts from: one licence, one field, a firm grant and a user grant
// ─────────────────────────────────────────────────────────────────────────────────────────────

const USER = 7;
const FIRM = 3;
const INSTRUMENT = 4242;

/** `PX_LAST` on an equity, served by `cboe.quotes` — the canonical price read. */
function baseWorld(now?: () => number): StubRegistry {
  const registry = stubRegistry(now);
  registry.licences.set(CBOE, licenceEntry(CBOE, { maxTier: 'delayed', display: true }));
  registry.fields.set('PX_LAST|equity', { sourceId: CBOE, fieldClass: 'price' });
  registry.grants.push(grantRow('firm', FIRM, { sourceId: CBOE, fieldClass: 'price' }));
  registry.grants.push(grantRow('user', USER, { sourceId: CBOE, fieldClass: 'price' }));
  return registry;
}

function request(over: Partial<EntitlementRequest> = {}): EntitlementRequest {
  return {
    userId: USER,
    firmId: FIRM,
    sessionId: '11111111-2222-4333-8444-555555555555',
    instrumentId: INSTRUMENT,
    assetClass: 'equity',
    fieldIds: ['PX_LAST'],
    tier: 'delayed',
    usage: 'display',
    purpose: 'DES',
    traceId: '99999999-8888-4777-8666-555555555555',
    ...over,
  };
}

function build(
  registry: LicenceRegistry,
  extra: { log?: AccessLog; quotas?: Quotas; cacheTtlMs?: number } = {},
): ReturnType<typeof evaluator> {
  return evaluator({ db: NO_DB, clock: testClock(), registry, ...extra });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tier algebra
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('WP-06 wiring', () => {
  it('satisfies WsEntitlements with no adapter, which is what retires the fail-closed default', async () => {
    // A compile-time statement first: the evaluator IS the gateway's entitlement source.
    const wired: WsEntitlements = build(baseWorld());
    const decision = await wired.evaluate(request());
    expect(decision.fields[0]?.decision).toBe('allow');
  });
});

describe('tier order', () => {
  it('orders eod < delayed < realtime and takes the lowest as the intersection', () => {
    expect(tierRank('eod')).toBeLessThan(tierRank('delayed'));
    expect(tierRank('delayed')).toBeLessThan(tierRank('realtime'));
    expect(minTier('realtime', 'delayed')).toBe('delayed');
    expect(minTier('delayed', 'eod')).toBe('eod');
    expect(maxTier('eod', 'delayed')).toBe('delayed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The rules, in order
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('rule 1 — field → source', () => {
  it('denies an unknown field FIELD_UNKNOWN and never guesses a source', async () => {
    const registry = baseWorld();
    // Everything a later rule needs is in place: a licence, a firm grant and a user grant that
    // would say `allow` the moment the field resolved. It must not resolve.
    const decision = await build(registry).evaluate(request({ fieldIds: ['NOT_A_FIELD'] }));

    expect(decision.fields).toHaveLength(1);
    const field = decision.fields[0]!;
    expect(field.reason).toBe('FIELD_UNKNOWN');
    expect(field.decision).toBe('deny');
    expect(field.effectiveTier).toBeNull();
    // Nothing invented: no source id, and the audit row's class is the dictionary's, not a source's.
    expect(field.sourceId).toBe('');
    expect(decision.effectiveTier).toBeNull();
  });

  it('beats rule 2: an unknown field whose would-be source forbids the usage is still FIELD_UNKNOWN', async () => {
    const registry = baseWorld();
    registry.licences.set(CBOE, licenceEntry(CBOE, { display: false }));
    const decision = await build(registry).evaluate(request({ fieldIds: ['NOT_A_FIELD'] }));
    expect(decision.fields[0]?.reason).toBe('FIELD_UNKNOWN');
  });

  it('resolves the asset-class-specific row before the field-wide fallback', async () => {
    const registry = baseWorld();
    registry.licences.set(YAHOO, licenceEntry(YAHOO, { maxTier: 'eod' }));
    registry.fields.set('PX_LAST|*', { sourceId: YAHOO, fieldClass: 'price' });
    const decision = await build(registry).evaluate(request());
    expect(decision.fields[0]?.sourceId).toBe(CBOE);

    // …and a request with no asset class falls back to the field-wide row.
    const fallback = await build(registry).evaluate(request({ assetClass: null }));
    expect(fallback.fields[0]?.sourceId).toBe(YAHOO);
  });
});

describe('rule 2 — licence gate', () => {
  it('denies LICENCE_FORBIDS_USAGE although the grants are generous enough to allow', async () => {
    const registry = baseWorld();
    // export_allowed is false on the licence; both grants permit export at realtime.
    for (const g of registry.grants) g.maxTier = 'realtime';
    const decision = await build(registry).evaluate(request({ usage: 'export', tier: 'eod' }));

    const field = decision.fields[0]!;
    expect(field.reason).toBe('LICENCE_FORBIDS_USAGE');
    expect(field.decision).toBe('deny');
    // The source IS named — the field resolved; it is the terms that refuse.
    expect(field.sourceId).toBe(CBOE);
  });

  it('gates each usage against its own licence flag', async () => {
    const registry = baseWorld();
    registry.licences.set(
      CBOE,
      licenceEntry(CBOE, { display: false, exportAllowed: true, apiAllowed: true }),
    );
    const evl = build(registry);
    expect((await evl.evaluate(request({ usage: 'display' }))).fields[0]?.reason).toBe(
      'LICENCE_FORBIDS_USAGE',
    );
    expect((await evl.evaluate(request({ usage: 'export' }))).fields[0]?.decision).toBe('allow');
    expect((await evl.evaluate(request({ usage: 'api' }))).fields[0]?.decision).toBe('allow');
  });

  it('beats rule 4: a licence that forbids the usage is refused before a missing firm grant', async () => {
    const registry = baseWorld();
    registry.licences.set(CBOE, licenceEntry(CBOE, { display: false }));
    registry.grants.length = 0; // no firm grant, no user grant either
    const decision = await build(registry).evaluate(request());
    expect(decision.fields[0]?.reason).toBe('LICENCE_FORBIDS_USAGE');
  });

  it('denies a source the registry does not hold rather than assuming terms', async () => {
    const registry = baseWorld();
    registry.licences.delete(CBOE);
    const decision = await build(registry).evaluate(request());
    expect(decision.fields[0]?.reason).toBe('LICENCE_FORBIDS_USAGE');
    expect(decision.fields[0]?.decision).toBe('deny');
  });
});

describe('rule 3 — source ceiling', () => {
  it('SOURCE_TIER_CAP beats a generous grant: realtime on a 15-minute source is delayed', async () => {
    const registry = baseWorld();
    // The firm bought realtime and the user has realtime. The source cannot serve it.
    for (const g of registry.grants) g.maxTier = 'realtime';
    const decision = await build(registry).evaluate(request({ tier: 'realtime' }));

    const field = decision.fields[0]!;
    expect(field.decision).toBe('downgrade');
    expect(field.effectiveTier).toBe('delayed');
    expect(field.reason).toBe('SOURCE_TIER_CAP');
    expect(decision.effectiveTier).toBe('delayed');
    expect(decision.downgrades).toEqual([{ fieldId: 'PX_LAST', reason: 'SOURCE_TIER_CAP' }]);
  });

  it('a daily source can never serve delayed', async () => {
    const registry = baseWorld();
    registry.licences.set(CBOE, licenceEntry(CBOE, { maxTier: 'eod' }));
    for (const g of registry.grants) g.maxTier = 'realtime';
    const decision = await build(registry).evaluate(request({ tier: 'delayed' }));
    expect(decision.fields[0]?.effectiveTier).toBe('eod');
    expect(decision.fields[0]?.reason).toBe('SOURCE_TIER_CAP');
  });

  it('reports the licence cap, not the grant, when both would bind', async () => {
    const registry = baseWorld();
    // cap = delayed and both grants = delayed: rule 3 is checked first, so the licence is blamed.
    const decision = await build(registry).evaluate(request({ tier: 'realtime' }));
    expect(decision.fields[0]?.reason).toBe('SOURCE_TIER_CAP');
  });
});

describe('rule 4 — firm contract', () => {
  it('denies NO_FIRM_ENTITLEMENT although the user is entitled', async () => {
    const registry = baseWorld();
    // The user grant survives, and it is realtime: without rule 4 this request would be allowed.
    const only = [grantRow('user', USER, { sourceId: CBOE, fieldClass: 'price' })];

    const decision = await buildWithGrants(registry, only).evaluate(request());
    const field = decision.fields[0]!;
    expect(field.reason).toBe('NO_FIRM_ENTITLEMENT');
    expect(field.decision).toBe('deny');
    // A deny renders blank, not missing: the field is still in the list, with its source named.
    expect(field.sourceId).toBe(CBOE);
    expect(field.effectiveTier).toBeNull();
  });

  it('ignores a firm grant scoped to another source, asset class or field class', async () => {
    for (const over of [
      { sourceId: YAHOO },
      { assetClass: 'fx' as AssetClass },
      { fieldClass: 'fundamental' as FieldClass },
    ]) {
      const registry = baseWorld();
      const grants = [
        grantRow('firm', FIRM, { sourceId: CBOE, fieldClass: 'price', ...over }),
        grantRow('user', USER, { sourceId: CBOE, fieldClass: 'price' }),
      ];
      const decision = await buildWithGrants(registry, grants).evaluate(request());
      expect(decision.fields[0]?.reason).toBe('NO_FIRM_ENTITLEMENT');
    }
  });

  it('ignores a firm grant that does not permit the requested usage', async () => {
    const registry = baseWorld();
    registry.licences.set(CBOE, licenceEntry(CBOE, { apiAllowed: true }));
    const grants = [
      grantRow('firm', FIRM, { sourceId: CBOE, fieldClass: 'price', usageApi: false }),
      grantRow('user', USER, { sourceId: CBOE, fieldClass: 'price' }),
    ];
    const decision = await buildWithGrants(registry, grants).evaluate(request({ usage: 'api' }));
    expect(decision.fields[0]?.reason).toBe('NO_FIRM_ENTITLEMENT');
  });

  it('beats rule 6: a missing firm grant denies rather than downgrades', async () => {
    const registry = baseWorld();
    const grants = [grantRow('user', USER, { sourceId: CBOE, fieldClass: 'price' })];
    const decision = await buildWithGrants(registry, grants).evaluate(
      request({ tier: 'realtime' }),
    );
    expect(decision.fields[0]?.decision).toBe('deny');
    expect(decision.fields[0]?.reason).toBe('NO_FIRM_ENTITLEMENT');
    expect(decision.downgrades).toEqual([]);
  });
});

describe('rule 5 — user subscription', () => {
  it('denies NO_USER_ENTITLEMENT when the firm is entitled and the user is not', async () => {
    const registry = baseWorld();
    const grants = [grantRow('firm', FIRM, { sourceId: CBOE, fieldClass: 'price' })];
    const decision = await buildWithGrants(registry, grants).evaluate(request());
    expect(decision.fields[0]?.reason).toBe('NO_USER_ENTITLEMENT');
    expect(decision.fields[0]?.decision).toBe('deny');
  });

  it('intersects: effective tier is min(cap, firm, user)', async () => {
    const cases: { cap: Tier; firm: Tier; user: Tier; want: Tier }[] = [
      { cap: 'realtime', firm: 'realtime', user: 'delayed', want: 'delayed' },
      { cap: 'realtime', firm: 'delayed', user: 'realtime', want: 'delayed' },
      { cap: 'delayed', firm: 'realtime', user: 'realtime', want: 'delayed' },
      { cap: 'realtime', firm: 'realtime', user: 'eod', want: 'eod' },
    ];
    for (const c of cases) {
      const registry = baseWorld();
      registry.licences.set(CBOE, licenceEntry(CBOE, { maxTier: c.cap }));
      const grants = [
        grantRow('firm', FIRM, { sourceId: CBOE, fieldClass: 'price', maxTier: c.firm }),
        grantRow('user', USER, { sourceId: CBOE, fieldClass: 'price', maxTier: c.user }),
      ];
      const decision = await buildWithGrants(registry, grants).evaluate(
        request({ tier: 'realtime' }),
      );
      expect(decision.fields[0]?.effectiveTier).toBe(c.want);
    }
  });

  it('takes the most generous of several grants on the same subject', async () => {
    const registry = baseWorld();
    registry.licences.set(CBOE, licenceEntry(CBOE, { maxTier: 'realtime' }));
    const grants = [
      grantRow('firm', FIRM, { sourceId: CBOE, fieldClass: 'price', maxTier: 'eod' }),
      grantRow('firm', FIRM, { sourceId: null, fieldClass: null, maxTier: 'realtime' }),
      grantRow('user', USER, { sourceId: CBOE, fieldClass: 'price', maxTier: 'realtime' }),
    ];
    const decision = await buildWithGrants(registry, grants).evaluate(
      request({ tier: 'realtime' }),
    );
    expect(decision.fields[0]?.decision).toBe('allow');
    expect(decision.fields[0]?.effectiveTier).toBe('realtime');
  });
});

describe('rule 6 — tier', () => {
  it('downgrades with NOT_ENTITLED_TIER when the grant, not the licence, is what binds', async () => {
    const registry = baseWorld();
    registry.licences.set(CBOE, licenceEntry(CBOE, { maxTier: 'realtime' }));
    const grants = [
      grantRow('firm', FIRM, { sourceId: CBOE, fieldClass: 'price', maxTier: 'realtime' }),
      grantRow('user', USER, { sourceId: CBOE, fieldClass: 'price', maxTier: 'delayed' }),
    ];
    const decision = await buildWithGrants(registry, grants).evaluate(
      request({ tier: 'realtime' }),
    );

    const field = decision.fields[0]!;
    expect(field.decision).toBe('downgrade');
    expect(field.reason).toBe('NOT_ENTITLED_TIER');
    // The lower tier, never the higher tier's stale value (ENTL-05).
    expect(field.effectiveTier).toBe('delayed');
  });

  it('allows a request at or below the effective tier and serves exactly what was asked', async () => {
    const registry = baseWorld();
    registry.licences.set(CBOE, licenceEntry(CBOE, { maxTier: 'realtime' }));
    for (const g of registry.grants) g.maxTier = 'realtime';
    const evl = build(registry);

    const asked = await evl.evaluate(request({ tier: 'delayed' }));
    expect(asked.fields[0]?.decision).toBe('allow');
    expect(asked.fields[0]?.reason).toBe('OK');
    // Entitled to realtime, asked for delayed: delayed is what is served.
    expect(asked.fields[0]?.effectiveTier).toBe('delayed');

    const eod = await evl.evaluate(request({ tier: 'eod' }));
    expect(eod.fields[0]?.effectiveTier).toBe('eod');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The mixed request — the acceptance row's "per-field downgrade list is complete"
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('a mixed request', () => {
  it('decides per field and lists every downgrade, and only the downgrades', async () => {
    const registry = stubRegistry();
    // Four sources so that each field can fail a different rule.
    registry.licences.set(CBOE, licenceEntry(CBOE, { maxTier: 'realtime' })); // allow
    registry.licences.set(YAHOO, licenceEntry(YAHOO, { maxTier: 'delayed' })); // SOURCE_TIER_CAP
    registry.licences.set(
      'sec.submissions',
      licenceEntry('sec.submissions', { maxTier: 'realtime' }),
    ); // NOT_ENTITLED_TIER
    registry.licences.set('fred.series', licenceEntry('fred.series', { display: false })); // LICENCE_FORBIDS_USAGE
    registry.licences.set(
      'coingecko.simple',
      licenceEntry('coingecko.simple', { maxTier: 'realtime' }),
    ); // NO_FIRM_ENTITLEMENT

    registry.fields.set('PX_LAST|equity', { sourceId: CBOE, fieldClass: 'price' });
    registry.fields.set('PX_BID|equity', { sourceId: YAHOO, fieldClass: 'price' });
    registry.fields.set('REVENUE|equity', {
      sourceId: 'sec.submissions',
      fieldClass: 'fundamental',
    });
    registry.fields.set('CPI_YOY|equity', { sourceId: 'fred.series', fieldClass: 'econ' });
    registry.fields.set('PX_ASK|equity', { sourceId: 'coingecko.simple', fieldClass: 'price' });

    // Firm: realtime on cboe/yahoo price, realtime on sec fundamentals, nothing on coingecko.
    registry.grants.push(
      grantRow('firm', FIRM, { sourceId: CBOE, fieldClass: 'price', maxTier: 'realtime' }),
      grantRow('firm', FIRM, { sourceId: YAHOO, fieldClass: 'price', maxTier: 'realtime' }),
      grantRow('firm', FIRM, {
        sourceId: 'sec.submissions',
        fieldClass: 'fundamental',
        maxTier: 'realtime',
      }),
      grantRow('firm', FIRM, { sourceId: 'fred.series', fieldClass: 'econ', maxTier: 'realtime' }),
    );
    // User: realtime on cboe/yahoo price, only DELAYED on sec fundamentals.
    registry.grants.push(
      grantRow('user', USER, { sourceId: CBOE, fieldClass: 'price', maxTier: 'realtime' }),
      grantRow('user', USER, { sourceId: YAHOO, fieldClass: 'price', maxTier: 'realtime' }),
      grantRow('user', USER, {
        sourceId: 'sec.submissions',
        fieldClass: 'fundamental',
        maxTier: 'delayed',
      }),
      grantRow('user', USER, { sourceId: 'fred.series', fieldClass: 'econ', maxTier: 'realtime' }),
    );

    const decision = await build(registry).evaluate(
      request({
        tier: 'realtime',
        fieldIds: ['PX_LAST', 'PX_BID', 'REVENUE', 'CPI_YOY', 'PX_ASK', 'NOT_A_FIELD'],
      }),
    );

    expect(decision.fields.map((f) => [f.fieldId, f.decision, f.reason, f.effectiveTier])).toEqual([
      ['PX_LAST', 'allow', 'OK', 'realtime'],
      ['PX_BID', 'downgrade', 'SOURCE_TIER_CAP', 'delayed'],
      ['REVENUE', 'downgrade', 'NOT_ENTITLED_TIER', 'delayed'],
      ['CPI_YOY', 'deny', 'LICENCE_FORBIDS_USAGE', null],
      ['PX_ASK', 'deny', 'NO_FIRM_ENTITLEMENT', null],
      ['NOT_A_FIELD', 'deny', 'FIELD_UNKNOWN', null],
    ]);

    // Complete: both downgrades, in field order, and nothing else.
    expect(decision.downgrades).toEqual([
      { fieldId: 'PX_BID', reason: 'SOURCE_TIER_CAP' },
      { fieldId: 'REVENUE', reason: 'NOT_ENTITLED_TIER' },
    ]);
    // The response may be labelled `delayed` without overstating any single field.
    expect(decision.effectiveTier).toBe('delayed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rule 8 — quotas
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('rule 8 — quotas', () => {
  it('turns every surviving field into QUOTA_EXCEEDED and leaves earlier denials alone', async () => {
    const registry = baseWorld();
    registry.licences.set(CBOE, licenceEntry(CBOE, { apiAllowed: true }));
    const quota = stubQuotas({
      ok: false,
      quota: 'dailyUniqueInstruments',
      used: 500,
      limit: 500,
      resetsAt: '2026-09-18T00:00:00.000Z',
    });

    const decision = await build(registry, { quotas: quota }).evaluate(
      request({ usage: 'api', fieldIds: ['PX_LAST', 'NOT_A_FIELD'] }),
    );

    expect(decision.fields.map((f) => [f.fieldId, f.decision, f.reason])).toEqual([
      ['PX_LAST', 'deny', 'QUOTA_EXCEEDED'],
      ['NOT_A_FIELD', 'deny', 'FIELD_UNKNOWN'],
    ]);
    expect(decision.effectiveTier).toBeNull();
    expect(quota.checks).toBe(1);
  });

  it('is skipped for display and export usage, and when every field is already denied', async () => {
    const registry = baseWorld();
    registry.licences.set(CBOE, licenceEntry(CBOE, { apiAllowed: true }));
    const quota = stubQuotas({ ok: false, quota: 'monthlyDataPoints', used: 1, limit: 1 });
    const evl = build(registry, { quotas: quota });

    expect((await evl.evaluate(request({ usage: 'display' }))).fields[0]?.decision).toBe('allow');
    expect(
      (await evl.evaluate(request({ usage: 'api', fieldIds: ['NOT_A_FIELD'] }))).fields[0]?.reason,
    ).toBe('FIELD_UNKNOWN');
    expect(quota.checks).toBe(0);
  });

  it('records the instrument against the daily counter once the check passes', async () => {
    const registry = baseWorld();
    registry.licences.set(CBOE, licenceEntry(CBOE, { apiAllowed: true }));
    const quota = stubQuotas({ ok: true });
    const decision = await build(registry, { quotas: quota }).evaluate(request({ usage: 'api' }));
    expect(decision.fields[0]?.decision).toBe('allow');
    expect(quota.recorded).toEqual([INSTRUMENT]);
  });

  it('charges the data points it checked, so the monthly ceiling is reachable', async () => {
    const registry = baseWorld();
    registry.licences.set(CBOE, licenceEntry(CBOE, { apiAllowed: true }));
    registry.fields.set('PX_BID|equity', { sourceId: CBOE, fieldClass: 'price' });
    const quota = stubQuotas({ ok: true });
    const evl = build(registry, { quotas: quota });

    // Two served fields, twice: four points. Checking a ceiling and then not charging it is what
    // made `monthly_data_points` unenforceable — the counter never moved (API.md §8).
    await evl.evaluate(request({ usage: 'api', fieldIds: ['PX_LAST', 'PX_BID'] }));
    await evl.evaluate(request({ usage: 'api', fieldIds: ['PX_LAST', 'PX_BID'] }));
    expect(quota.points).toBe(4);
  });

  it('charges a read with no instrument at all', async () => {
    const registry = baseWorld();
    registry.licences.set(CBOE, licenceEntry(CBOE, { apiAllowed: true }));
    const quota = stubQuotas({ ok: true });
    await build(registry, { quotas: quota }).evaluate(
      request({ usage: 'api', instrumentId: null }),
    );
    // Nothing to add to the daily instrument set, but the point is still consumed.
    expect(quota.recorded).toEqual([]);
    expect(quota.points).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rule 9 — the audit trail
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('rule 9 — access log', () => {
  it('appends one row per field with the decision, the reason and the granted tier', async () => {
    const registry = baseWorld();
    const log = stubAccessLog();
    const decision = await build(registry, { log }).evaluate(
      request({ tier: 'realtime', fieldIds: ['PX_LAST', 'NOT_A_FIELD'] }),
    );

    expect(log.rows).toHaveLength(2);
    expect(decision.logIds).toHaveLength(2);
    expect(decision.logIds).toEqual([1, 2]);

    const [priceRow, unknownRow] = log.rows;
    expect(priceRow).toMatchObject({
      ts: TEST_NOW,
      userId: USER,
      firmId: FIRM,
      instrumentId: INSTRUMENT,
      fieldId: 'PX_LAST',
      fieldClass: 'price',
      sourceId: CBOE,
      requestedTier: 'realtime',
      tier: 'delayed',
      usage: 'display',
      purpose: 'DES',
      decision: 'downgrade',
      reason: 'SOURCE_TIER_CAP',
    });
    expect(unknownRow).toMatchObject({
      fieldId: 'NOT_A_FIELD',
      decision: 'deny',
      reason: 'FIELD_UNKNOWN',
      tier: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rule 10 — the cache
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('rule 10 — cache', () => {
  it('caches the decision inputs per (user, source, field class, usage)', async () => {
    const registry = baseWorld();
    const evl = build(registry);

    await evl.evaluate(request());
    expect(evl.stats()).toMatchObject({ evaluations: 1, cacheMisses: 1, cacheHits: 0 });

    await evl.evaluate(request());
    expect(evl.stats()).toMatchObject({ evaluations: 2, cacheMisses: 1, cacheHits: 1 });

    // A different usage is a different key, so it is computed again.
    registry.licences.set(CBOE, licenceEntry(CBOE, { apiAllowed: true }));
    await evl.evaluate(request({ usage: 'api' }));
    expect(evl.stats()).toMatchObject({ cacheMisses: 2, cacheHits: 1 });
  });

  it('checks staleness on every evaluation and drops the cache when the version moved', async () => {
    const registry = baseWorld();
    const evl = build(registry);

    await evl.evaluate(request());
    expect(registry.refreshes).toBe(1);

    // The grant is revoked behind the evaluator's back. Without a bump the cache still answers…
    registry.grants.length = 0;
    expect((await evl.evaluate(request())).fields[0]?.decision).toBe('allow');
    expect(registry.refreshes).toBe(2);

    // …and the `entitlement_grants_bump` trigger is what makes it visible.
    registry.bump();
    const after = await evl.evaluate(request());
    expect(after.fields[0]?.reason).toBe('NO_FIRM_ENTITLEMENT');
  });

  it('expires an entry after the TTL', async () => {
    const registry = baseWorld();
    const clock = testClock();
    const evl = evaluator({ db: NO_DB, clock, registry, cacheTtlMs: 60_000 });

    await evl.evaluate(request());
    registry.grants.length = 0;
    clock.advance(59_999);
    expect((await evl.evaluate(request())).fields[0]?.decision).toBe('allow');
    clock.advance(2);
    expect((await evl.evaluate(request())).fields[0]?.reason).toBe('NO_FIRM_ENTITLEMENT');
  });

  it('caps the entry at the grant that lapses first, because an expiry bumps nothing', async () => {
    const clock = testClock();
    const registry = baseWorld(() => clock.now());
    // Both contracts run out in five seconds. Nothing WRITES when they do, so the
    // `entitlement_grants_bump` trigger never fires and rule 10's version check cannot help.
    const endsAt = new Date(TEST_NOW + 5_000).toISOString();
    registry.grants.length = 0;
    registry.grants.push(
      grantRow('firm', FIRM, { sourceId: CBOE, fieldClass: 'price', validTo: endsAt }),
      grantRow('user', USER, { sourceId: CBOE, fieldClass: 'price', validTo: endsAt }),
    );
    const evl = evaluator({ db: NO_DB, clock, registry, cacheTtlMs: 60_000 });

    expect((await evl.evaluate(request())).fields[0]?.reason).toBe('OK');
    clock.advance(4_999);
    expect((await evl.evaluate(request())).fields[0]?.reason).toBe('OK');

    // One millisecond past the contract, and 55 s inside the TTL: the lapse is what decides.
    clock.advance(1);
    expect(registry.grantsFor('user', USER)).toHaveLength(0);
    expect((await evl.evaluate(request())).fields[0]?.reason).toBe('NO_FIRM_ENTITLEMENT');
  });

  it('still caches for the full TTL when every applicable grant is open-ended', async () => {
    const clock = testClock();
    const registry = baseWorld(() => clock.now());
    const evl = evaluator({ db: NO_DB, clock, registry, cacheTtlMs: 60_000 });

    await evl.evaluate(request());
    clock.advance(59_999);
    await evl.evaluate(request());
    // An `Infinity` boundary costs nothing: the second call is still a hit.
    expect(evl.stats()).toMatchObject({ cacheMisses: 1, cacheHits: 1 });
  });

  it('invalidate() drops every entry', async () => {
    const registry = baseWorld();
    const evl = build(registry);
    await evl.evaluate(request());
    registry.grants.length = 0;
    evl.invalidate();
    expect((await evl.evaluate(request())).fields[0]?.reason).toBe('NO_FIRM_ENTITLEMENT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helper that needs the stubs above
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A registry whose grants are exactly `grants` — the shortest way to state "only this grant". */
function buildWithGrants(
  registry: StubRegistry,
  grants: readonly GrantRow[],
): ReturnType<typeof evaluator> {
  registry.grants.length = 0;
  registry.grants.push(...grants);
  return build(registry);
}
