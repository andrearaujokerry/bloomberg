/**
 * WORKPLAN WP-07 — the evaluator against the REAL `licence_registry` and `field_licence`, closing
 * the three rows of ARCHITECTURE §10 that a unit test with a stubbed registry cannot reach:
 *
 *  - **rule 9 end to end.** One `access_log` row per field, with the decision and the reason the
 *    evaluator returned. Counted, not sampled: the rows are read back by `trace_id` and compared
 *    field by field against `decision.fields`.
 *  - **rule 10, the cache.** A repeated evaluation is served without touching the grants again —
 *    asserted by counting `grantsFor` calls through a wrapper, not by trusting `stats()` alone.
 *  - **rule 10, the invalidation.** A grant written by somebody else bumps
 *    `config_versions('entitlements')` (the `entitlement_grants_bump` statement trigger), and the
 *    NEXT `evaluate()` on the SAME evaluator instance sees it. Nothing restarts, nothing calls
 *    `invalidate()`, and nothing reloads the registry by hand. This is the only test of that path.
 *
 * Nothing is hand-written into `licence_registry` or `field_licence`: `seed/licences.ts` runs inside
 * this file's transaction, so the terms under test are the shipped terms (33 sources, ≈543 field
 * rows). That is what makes the expectations below facts about the product rather than about a
 * fixture — `cboe.quotes` really is capped at `delayed`, `sec.companyfacts` at `eod`,
 * `internal.derived` at `realtime`, and `yahoo.chart` really does forbid `api` usage.
 *
 * The seed is idempotent, so on an already-seeded test database it issues no write and therefore no
 * `config_versions` bump: the version only moves where a test moves it.
 *
 * Time is the virtual clock at `TEST_NOW` (2026-09-17T13:30Z), which is inside the shipped
 * `access_log_m2026_09` partition and inside every grant window this file opens. Grants are written
 * with an explicit `valid_from` in the past rather than the column default `now()`, because `now()`
 * is wall-clock and would land AFTER the virtual clock and silently make every grant inapplicable.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AssetClass, EntitlementRequest, FieldId, Tier, UsageType } from '@terminal/core';

import { accessLog, NO_SOURCE, type AccessLog } from '../../../src/entitlements/accessLog.js';
import { evaluator, type Evaluator } from '../../../src/entitlements/evaluator.js';
import {
  licenceRegistry,
  type LicenceRegistry,
} from '../../../src/entitlements/licenceRegistry.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { testClock, TEST_NOW } from '../../../src/test/clock.js';
import { seedQuoteInstrument } from '../ws/helpers.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Well before `TEST_NOW`, so a grant written with it is live on the virtual clock. */
const GRANT_FROM = '2026-01-01T00:00:00.000Z';

interface GrantSpec {
  sourceId?: string | null;
  assetClass?: AssetClass | null;
  fieldClass?: string | null;
  maxTier: Tier;
  display?: boolean;
  export?: boolean;
  api?: boolean;
  validFrom?: string;
  validTo?: string;
}

async function insertGrant(
  t: TestDb,
  subjectKind: 'user' | 'firm',
  subjectId: number,
  spec: GrantSpec,
): Promise<number> {
  const res = await t.client.query<{ grant_id: string }>(
    `INSERT INTO entitlement_grants
       (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
        usage_display, usage_export, usage_api, valid_from, valid_to)
     VALUES ($1, $2, $3, $4::asset_class, $5::field_class, $6::tier,
             $7, $8, $9, $10::timestamptz, $11::timestamptz)
     RETURNING grant_id`,
    [
      subjectKind,
      subjectId,
      spec.sourceId ?? null,
      spec.assetClass ?? null,
      spec.fieldClass ?? null,
      spec.maxTier,
      spec.display ?? true,
      spec.export ?? true,
      spec.api ?? true,
      spec.validFrom ?? GRANT_FROM,
      spec.validTo ?? 'infinity',
    ],
  );
  return Number(res.rows[0]!.grant_id);
}

/** The `config_versions('entitlements')` counter the three bump triggers move. */
async function entitlementsVersion(t: TestDb): Promise<number> {
  const res = await t.client.query<{ version: string }>(
    `SELECT version::text AS version FROM config_versions WHERE name = 'entitlements'`,
  );
  return res.rows.length === 0 ? 0 : Number(res.rows[0]!.version);
}

/** A registry that counts what the evaluator asked it for — rule 10 is about calls, not results. */
interface CountingRegistry extends LicenceRegistry {
  readonly calls: { grantsFor: number; fieldSource: number; licence: number };
}

function countingRegistry(inner: LicenceRegistry): CountingRegistry {
  const calls = { grantsFor: 0, fieldSource: 0, licence: 0 };
  return {
    ...inner,
    calls,
    grantsFor(subjectKind, subjectId) {
      calls.grantsFor += 1;
      return inner.grantsFor(subjectKind, subjectId);
    },
    fieldSource(fieldId, assetClass) {
      calls.fieldSource += 1;
      return inner.fieldSource(fieldId, assetClass);
    },
    licence(sourceId) {
      calls.licence += 1;
      return inner.licence(sourceId);
    },
  };
}

interface Env {
  userId: number;
  firmId: number;
  sessionId: string;
  instrumentId: number;
  clock: ReturnType<typeof testClock>;
  registry: CountingRegistry;
  log: AccessLog;
  ev: Evaluator;
}

/**
 * The shipped licence tables, a firm, a user of it, one equity instrument, and — unless the caller
 * says otherwise — a firm and a user grant generous enough that only the LICENCE can bind.
 */
async function setup(
  t: TestDb,
  opts: { firmGrant?: GrantSpec | null; userGrant?: GrantSpec | null } = {},
): Promise<Env> {
  await seedLicences(t.client);

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Evaluator Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'Evaluator User', 'user') RETURNING user_id`,
    [firmId, `evaluator-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);
  const session = await t.client.query<{ session_id: string }>(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at)
     VALUES ($1, digest($2, 'sha256'), 'web', now() + interval '1 day') RETURNING session_id`,
    [userId, randomUUID()],
  );

  const firmGrant = opts.firmGrant === undefined ? { maxTier: 'realtime' as Tier } : opts.firmGrant;
  const userGrant = opts.userGrant === undefined ? { maxTier: 'realtime' as Tier } : opts.userGrant;
  if (firmGrant !== null) await insertGrant(t, 'firm', firmId, firmGrant);
  if (userGrant !== null) await insertGrant(t, 'user', userId, userGrant);

  const { instrumentId } = await seedQuoteInstrument(t, {
    ticker: `EV${randomUUID().slice(0, 4).toUpperCase()}`,
  });

  const clock = testClock();
  const inner = licenceRegistry({ db: t.db, clock });
  await inner.reload();
  const registry = countingRegistry(inner);
  const log = accessLog({ db: t.db, clock });
  const ev = evaluator({ db: t.db, clock, registry, log });

  return {
    userId,
    firmId,
    sessionId: session.rows[0]!.session_id,
    instrumentId,
    clock,
    registry,
    log,
    ev,
  };
}

function request(
  env: Env,
  over: { fieldIds: FieldId[]; assetClass: AssetClass | null; tier: Tier; usage?: UsageType },
): EntitlementRequest {
  return {
    userId: env.userId,
    firmId: env.firmId,
    sessionId: env.sessionId,
    instrumentId: env.instrumentId,
    assetClass: over.assetClass,
    fieldIds: over.fieldIds,
    tier: over.tier,
    usage: over.usage ?? 'display',
    purpose: 'DES',
    traceId: randomUUID(),
  };
}

interface LoggedRow {
  field_id: string;
  field_class: string;
  source_id: string;
  decision: string;
  reason: string;
  requested_tier: string;
  tier: string | null;
  usage: string;
  purpose: string;
  instrument_id: string | null;
  user_id: string;
  firm_id: string;
  session_id: string | null;
}

/** Everything `access_log` holds for one trace, in a stable order. */
async function loggedRows(t: TestDb, traceId: string): Promise<LoggedRow[]> {
  const res = await t.client.query<LoggedRow>(
    `SELECT field_id, field_class, source_id::text AS source_id, decision::text AS decision, reason,
            requested_tier::text AS requested_tier, tier::text AS tier, usage::text AS usage,
            purpose, instrument_id::text AS instrument_id, user_id::text AS user_id,
            firm_id::text AS firm_id, session_id::text AS session_id
       FROM access_log WHERE trace_id = $1 ORDER BY field_id`,
    [traceId],
  );
  return res.rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('entitlements/evaluator — real licence_registry + field_licence (ARCHITECTURE §10)', () => {
  const t = withTxDb();

  it('decides a mixed equity request per field from the shipped licence terms', async () => {
    const env = await setup(t);

    // PX_LAST/equity      → cboe.quotes       cap delayed  (price)
    // BS_TOT_ASSET/equity → sec.companyfacts  cap eod      (fundamental)
    // BETA_1Y/equity      → internal.derived  cap realtime (analytic)
    // HEADLINE            → no field_licence row at all    (news)
    const req = request(env, {
      fieldIds: ['PX_LAST', 'BS_TOT_ASSET', 'BETA_1Y', 'HEADLINE'],
      assetClass: 'equity',
      tier: 'realtime',
    });
    const decision = await env.ev.evaluate(req);

    const byField = new Map(decision.fields.map((f) => [f.fieldId, f]));
    expect(decision.fields).toHaveLength(4);

    // The grants say `realtime` on everything, so every answer below is the LICENCE talking.
    expect(byField.get('BETA_1Y')).toEqual({
      fieldId: 'BETA_1Y',
      sourceId: 'internal.derived',
      fieldClass: 'analytic',
      decision: 'allow',
      effectiveTier: 'realtime',
      reason: 'OK',
    });
    expect(byField.get('PX_LAST')).toEqual({
      fieldId: 'PX_LAST',
      sourceId: 'cboe.quotes',
      fieldClass: 'price',
      decision: 'downgrade',
      effectiveTier: 'delayed',
      reason: 'SOURCE_TIER_CAP',
    });
    expect(byField.get('BS_TOT_ASSET')).toEqual({
      fieldId: 'BS_TOT_ASSET',
      sourceId: 'sec.companyfacts',
      fieldClass: 'fundamental',
      decision: 'downgrade',
      effectiveTier: 'eod',
      reason: 'SOURCE_TIER_CAP',
    });
    // News lives on the `n:` subjects, so the licence matrix has no row for it. The dictionary DOES
    // name sources for HEADLINE (`bbg.rss`); the evaluator must not use them. An unprovable field is
    // denied, and the audit row names no source at all.
    expect(byField.get('HEADLINE')).toEqual({
      fieldId: 'HEADLINE',
      sourceId: '',
      fieldClass: 'news',
      decision: 'deny',
      effectiveTier: null,
      reason: 'FIELD_UNKNOWN',
    });

    // The whole-response tier is the most restrictive tier any served field came back with.
    expect(decision.effectiveTier).toBe('eod');
    expect(decision.downgrades).toEqual([
      { fieldId: 'PX_LAST', reason: 'SOURCE_TIER_CAP' },
      { fieldId: 'BS_TOT_ASSET', reason: 'SOURCE_TIER_CAP' },
    ]);
    expect(new Set(decision.logIds).size).toBe(4);
  });

  it('writes exactly one access_log row per field, carrying that field own decision and reason', async () => {
    const env = await setup(t);
    const req = request(env, {
      fieldIds: ['PX_LAST', 'BS_TOT_ASSET', 'BETA_1Y', 'HEADLINE'],
      assetClass: 'equity',
      tier: 'realtime',
    });
    const decision = await env.ev.evaluate(req);

    // Rule 9: nothing is on the response path. The rows exist only once the batch is flushed.
    expect(env.log.size()).toBe(4);
    expect(await loggedRows(t, req.traceId)).toHaveLength(0);
    expect(await env.log.flush()).toBe(4);

    const rows = await loggedRows(t, req.traceId);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.field_id)).toEqual([
      'BETA_1Y',
      'BS_TOT_ASSET',
      'HEADLINE',
      'PX_LAST',
    ]);

    // One row per field, and the row says what the decision said — not merely "a row exists".
    for (const field of decision.fields) {
      const matching = rows.filter((r) => r.field_id === field.fieldId);
      expect(matching).toHaveLength(1);
      const row = matching[0]!;
      expect({
        decision: row.decision,
        reason: row.reason,
        fieldClass: row.field_class,
        sourceId: row.source_id,
        tier: row.tier,
        requestedTier: row.requested_tier,
        usage: row.usage,
        purpose: row.purpose,
        userId: Number(row.user_id),
        firmId: Number(row.firm_id),
        instrumentId: Number(row.instrument_id),
        sessionId: row.session_id,
      }).toEqual({
        decision: field.decision,
        reason: field.reason,
        fieldClass: field.fieldClass,
        // `access_log.source_id` is `text NOT NULL`, so a field that resolved to NO source at all
        // (`FIELD_UNKNOWN`, `sourceId: ''` in the decision) is stored as the reserved
        // `NO_SOURCE` marker rather than as an empty string that reads like a lost value.
        sourceId: field.sourceId === '' ? NO_SOURCE : field.sourceId,
        tier: field.effectiveTier,
        requestedTier: 'realtime',
        usage: 'display',
        purpose: 'DES',
        userId: env.userId,
        firmId: env.firmId,
        instrumentId: env.instrumentId,
        sessionId: env.sessionId,
      });
    }

    // Counted by decision, so a writer that logged every field as `allow` cannot pass.
    const byDecision = new Map<string, number>();
    for (const row of rows) byDecision.set(row.decision, (byDecision.get(row.decision) ?? 0) + 1);
    expect(Object.fromEntries(byDecision)).toEqual({ allow: 1, downgrade: 2, deny: 1 });
    expect(env.log.stats().written).toBe(4);
  });

  it('crosses asset classes: the same field id resolves to a different source per class', async () => {
    const env = await setup(t);

    // fx PX_LAST is yahoo.chart, whose licence forbids `api` usage outright (rule 2), although the
    // grants below permit `api` at `realtime` — so this proves rule 2 runs before rules 4-6.
    const fx = request(env, { fieldIds: ['PX_LAST'], assetClass: 'fx', tier: 'delayed', usage: 'api' });
    const fxDecision = await env.ev.evaluate(fx);
    expect(fxDecision.fields[0]).toMatchObject({
      sourceId: 'yahoo.chart',
      decision: 'deny',
      reason: 'LICENCE_FORBIDS_USAGE',
      effectiveTier: null,
    });

    // The same source, same field, under `display`, which yahoo.chart does permit: delayed, allowed.
    const fxDisplay = request(env, { fieldIds: ['PX_LAST'], assetClass: 'fx', tier: 'delayed' });
    expect((await env.ev.evaluate(fxDisplay)).fields[0]).toMatchObject({
      sourceId: 'yahoo.chart',
      decision: 'allow',
      reason: 'OK',
      effectiveTier: 'delayed',
    });

    // option PX_LAST is cboe.options, a different source again. Two option `analytic` fields sit on
    // either side of the source boundary — OPT_IV is the exchange's own, OPT_BREAKEVEN is computed
    // here — so the SAME asset class and the SAME field class get two different ceilings. It is the
    // licence that caps a field, not its class.
    const option = request(env, {
      fieldIds: ['PX_LAST', 'OPT_IV', 'OPT_BREAKEVEN'],
      assetClass: 'option',
      tier: 'realtime',
    });
    const optionDecision = await env.ev.evaluate(option);
    expect(
      optionDecision.fields.map((f) => [
        f.fieldId,
        f.sourceId,
        f.fieldClass,
        f.decision,
        f.effectiveTier,
      ]),
    ).toEqual([
      ['PX_LAST', 'cboe.options', 'price', 'downgrade', 'delayed'],
      ['OPT_IV', 'cboe.options', 'analytic', 'downgrade', 'delayed'],
      ['OPT_BREAKEVEN', 'internal.derived', 'analytic', 'allow', 'realtime'],
    ]);

    // econ ECO_VALUE is fred.csv; the very same field id on `rate` is nyfed.rates, which is
    // licensed to realtime — one field id, two sources, two ceilings, decided per asset class.
    const econ = request(env, { fieldIds: ['ECO_VALUE'], assetClass: 'econ', tier: 'realtime' });
    expect((await env.ev.evaluate(econ)).fields[0]).toMatchObject({
      sourceId: 'fred.csv',
      fieldClass: 'econ',
      decision: 'downgrade',
      effectiveTier: 'eod',
      reason: 'SOURCE_TIER_CAP',
    });
    const rate = request(env, { fieldIds: ['ECO_VALUE'], assetClass: 'rate', tier: 'realtime' });
    expect((await env.ev.evaluate(rate)).fields[0]).toMatchObject({
      sourceId: 'nyfed.rates',
      fieldClass: 'econ',
      decision: 'allow',
      effectiveTier: 'realtime',
      reason: 'OK',
    });

    // And with no asset class at all, PX_LAST cannot be resolved: its rows name three different
    // sources, so there is nothing to fall back to and the field is denied rather than guessed.
    const anyClass = request(env, { fieldIds: ['PX_LAST'], assetClass: null, tier: 'delayed' });
    expect((await env.ev.evaluate(anyClass)).fields[0]).toMatchObject({
      sourceId: '',
      decision: 'deny',
      reason: 'FIELD_UNKNOWN',
    });
  });

  it('denies with NO_USER_ENTITLEMENT where the firm is entitled and the user is not', async () => {
    const env = await setup(t, {
      firmGrant: { maxTier: 'realtime' },
      // The user is entitled to price and to nothing else.
      userGrant: { maxTier: 'realtime', fieldClass: 'price' },
    });
    const req = request(env, {
      fieldIds: ['PX_LAST', 'BS_TOT_ASSET'],
      assetClass: 'equity',
      tier: 'delayed',
    });
    const decision = await env.ev.evaluate(req);
    expect(decision.fields.map((f) => [f.fieldId, f.decision, f.reason])).toEqual([
      ['PX_LAST', 'allow', 'OK'],
      ['BS_TOT_ASSET', 'deny', 'NO_USER_ENTITLEMENT'],
    ]);

    await env.log.flush();
    const rows = await loggedRows(t, req.traceId);
    expect(rows.map((r) => [r.field_id, r.decision, r.reason, r.tier])).toEqual([
      ['BS_TOT_ASSET', 'deny', 'NO_USER_ENTITLEMENT', null],
      ['PX_LAST', 'allow', 'OK', 'delayed'],
    ]);
  });

  it('serves a repeated evaluation from the cache without reading the grants again', async () => {
    const env = await setup(t);
    const spec = {
      fieldIds: ['PX_LAST', 'BS_TOT_ASSET', 'BETA_1Y'] as FieldId[],
      assetClass: 'equity' as AssetClass,
      tier: 'delayed' as Tier,
    };

    await env.ev.evaluate(request(env, spec));
    const afterFirst = env.ev.stats();
    // Three distinct (source, field class) pairs → three misses, and two grant reads each
    // (firm + user) → six.
    expect(afterFirst).toEqual({ evaluations: 1, cacheHits: 0, cacheMisses: 3 });
    expect(env.registry.calls.grantsFor).toBe(6);
    const loadsAfterFirst = env.registry.stats().loads;

    const second = await env.ev.evaluate(request(env, spec));
    expect(env.ev.stats()).toEqual({ evaluations: 2, cacheHits: 3, cacheMisses: 3 });
    // THE point of rule 10: not one further grant read.
    expect(env.registry.calls.grantsFor).toBe(6);
    // …and not one further reload either: the staleness check is a single version SELECT.
    expect(env.registry.stats().loads).toBe(loadsAfterFirst);
    expect(env.registry.stats().freshChecks).toBeGreaterThanOrEqual(1);
    // A cached decision is still the same decision.
    expect(second.fields.map((f) => [f.fieldId, f.decision, f.effectiveTier])).toEqual([
      ['PX_LAST', 'allow', 'delayed'],
      ['BS_TOT_ASSET', 'downgrade', 'eod'],
      ['BETA_1Y', 'allow', 'delayed'],
    ]);

    // A different user is a different cache key, not a hit on somebody else's entitlements.
    const other = await t.client.query<{ user_id: string }>(
      `INSERT INTO users (firm_id, email, display_name, role)
       VALUES ($1, $2, 'Other User', 'user') RETURNING user_id`,
      [env.firmId, `evaluator-other-${randomUUID()}@demo.invalid`],
    );
    const otherUserId = Number(other.rows[0]!.user_id);
    const otherReq = { ...request(env, spec), userId: otherUserId };
    const otherDecision = await env.ev.evaluate(otherReq);
    expect(env.ev.stats().cacheMisses).toBe(6);
    // No grant of their own, and the cache did not lend them this user's.
    expect(otherDecision.fields.every((f) => f.reason === 'NO_USER_ENTITLEMENT')).toBe(true);
  });

  it('rule 10: a grant written elsewhere bumps config_versions and the next evaluate sees it', async () => {
    // The user starts capped at `delayed` on the analytics source, which is licensed to realtime:
    // so the GRANT is what binds, and a change to it must be visible without a restart.
    const env = await setup(t, {
      firmGrant: { maxTier: 'realtime' },
      userGrant: { maxTier: 'delayed', sourceId: 'internal.derived' },
    });
    const spec = {
      fieldIds: ['BETA_1Y'] as FieldId[],
      assetClass: 'equity' as AssetClass,
      tier: 'realtime' as Tier,
    };

    const before = await env.ev.evaluate(request(env, spec));
    expect(before.fields[0]).toMatchObject({
      decision: 'downgrade',
      effectiveTier: 'delayed',
      reason: 'NOT_ENTITLED_TIER',
    });
    const versionBefore = await entitlementsVersion(t);
    expect(env.registry.version()).toBe(versionBefore);
    const loadsBefore = env.registry.stats().loads;
    const missesBefore = env.ev.stats().cacheMisses;

    // Somebody else (the admin route, another process) widens the grant. Nothing here touches the
    // evaluator or the registry: the `entitlement_grants_bump` statement trigger is the only
    // channel between that write and this in-memory cache.
    const upgradeId = await insertGrant(t, 'user', env.userId, {
      maxTier: 'realtime',
      sourceId: 'internal.derived',
    });
    const versionAfter = await entitlementsVersion(t);
    expect(versionAfter).toBeGreaterThan(versionBefore);

    const after = await env.ev.evaluate(request(env, spec));
    expect(after.fields[0]).toMatchObject({
      decision: 'allow',
      effectiveTier: 'realtime',
      reason: 'OK',
    });
    // Proof it was the bump that did it, and not a 60 s TTL expiring or a manual reload: the
    // registry reloaded exactly once more and the cache was emptied (a miss, not a hit).
    expect(env.registry.stats().loads).toBe(loadsBefore + 1);
    expect(env.registry.version()).toBe(versionAfter);
    expect(env.ev.stats().cacheMisses).toBe(missesBefore + 1);
    expect(env.ev.stats().cacheHits).toBe(0);

    // The same channel revokes. Deleting both of the user's grants bumps again, and the very next
    // evaluation denies — a widened entitlement and a withdrawn one travel the same path.
    await t.client.query(`DELETE FROM entitlement_grants WHERE grant_id = $1`, [upgradeId]);
    await t.client.query(
      `DELETE FROM entitlement_grants WHERE subject_kind = 'user' AND subject_id = $1`,
      [env.userId],
    );
    expect(await entitlementsVersion(t)).toBeGreaterThan(versionAfter);
    const revoked = await env.ev.evaluate(request(env, spec));
    expect(revoked.fields[0]).toMatchObject({
      decision: 'deny',
      effectiveTier: null,
      reason: 'NO_USER_ENTITLEMENT',
    });
  });

  it('honours a grant that has expired on the clock even with no version bump', async () => {
    const env = await setup(t, {
      firmGrant: { maxTier: 'realtime' },
      userGrant: { maxTier: 'realtime', validTo: new Date(TEST_NOW + 60_000).toISOString() },
    });
    const spec = {
      fieldIds: ['BETA_1Y'] as FieldId[],
      assetClass: 'equity' as AssetClass,
      tier: 'realtime' as Tier,
    };
    expect((await env.ev.evaluate(request(env, spec))).fields[0]).toMatchObject({
      decision: 'allow',
      reason: 'OK',
    });

    const version = await entitlementsVersion(t);
    env.clock.advance(120_000);
    // The cache is keyed on inputs computed at evaluation time; its 60 s TTL is shorter than the
    // two minutes just advanced, so the expiry is seen without anything bumping the version.
    const after = await env.ev.evaluate(request(env, spec));
    expect(await entitlementsVersion(t)).toBe(version);
    expect(after.fields[0]).toMatchObject({ decision: 'deny', reason: 'NO_USER_ENTITLEMENT' });
  });
});
