/**
 * `entitlements/evaluator.ts` — ENTL-01..06, ARCHITECTURE §10 L1158-1192.
 *
 * `evaluate(req)` runs before any data-service read and on every WS `sub`. It decides **per field**,
 * and the rule order is normative: the FIRST rule that fails decides that field, which is what makes
 * `SOURCE_TIER_CAP` beat a generous grant instead of the other way round.
 *
 *  1. **Field → source.** `field_licence[(fieldId, assetClass)]` → `(sourceId, fieldClass)` through
 *     the registry. A pair the table does not know is `FIELD_UNKNOWN` (deny). Nothing is guessed:
 *     the dictionary is consulted only for the `field_class` written to the audit row, never for a
 *     source.
 *  2. **Licence gate.** `licence_registry[sourceId]` must allow the requested usage —
 *     `display` / `export_allowed` / `api_allowed`. Otherwise `LICENCE_FORBIDS_USAGE` (deny). A
 *     source the registry does not hold is denied by the same rule: an absent licence proves
 *     nothing, and an unprovable field is never served.
 *  3. **Source ceiling.** `cap = licence.max_tier`. No grant can exceed it, so a 15-minute delayed
 *     source never serves `realtime` however generous the contract is.
 *  4. **Firm contract.** `entitlement_grants` rows with `subject_kind='firm'` valid as-of now and
 *     matching `(sourceId, assetClass, fieldClass)` and the requested usage flag; none →
 *     `NO_FIRM_ENTITLEMENT` (deny → the screen renders blank, not missing).
 *  5. **User subscription.** The same for `subject_kind='user'`; none → `NO_USER_ENTITLEMENT`.
 *     Effective tier = `min(cap, firm tier, user tier)` (ENTL-02).
 *  6. **Tier.** A request above the effective tier is a `downgrade`, never a deny: the reason is
 *     `SOURCE_TIER_CAP` when the licence ceiling is what binds and `NOT_ENTITLED_TIER` when the
 *     grants are. The caller then serves the lower tier's fresh value or a blank — never the
 *     higher tier's stale one (ENTL-05); this module returns the tier, so the value it returns for
 *     is fetched at that tier by construction.
 *  8. **Quotas** (API-06): a `usage: 'api'` request that is over a ceiling turns every field that
 *     survived rules 1-6 into `QUOTA_EXCEEDED` (deny). Fields already denied keep their own,
 *     earlier reason — the first failing rule still wins.
 *  9. **Log** (ENTL-04): one `access_log` row per `(user, instrument, field, decision)`, handed to
 *     the batching writer with `append()`, which never awaits. `EntitlementDecision.logIds` carries
 *     the writer's provisional handles, in field order — not `access_log.log_id`, which does not
 *     exist until the batch lands.
 * 10. **Cache**: the decision *inputs* (licence cap, usage gate, firm tier, user tier) per
 *     `(userId, assetClass, sourceId, fieldClass, usage)` for 60 s. Every `evaluate` first calls
 *     `registry.refreshIfStale()` — one indexed `SELECT` of `config_versions('entitlements')` — and
 *     a version that moved clears the cache, so a revoked grant takes effect on the next call
 *     rather than 60 s later.
 *
 * Rule 7 (natural-person binding) is the session service's: grants are keyed on `user_id` here and
 * nowhere else, and `sessions` enforces the single active session.
 *
 * The returned object satisfies WP-06's `WsEntitlements` structurally (`{ evaluate }`), so wiring it
 * into `AppDeps.entitlements` is what retires the gateway's fail-closed default.
 */

import { getField } from '@terminal/core';
import type {
  AssetClass,
  Clock,
  EntitlementDecision,
  EntitlementDowngrade,
  EntitlementRequest,
  FieldClass,
  FieldDecision,
  FieldId,
  ReasonCode,
  Tier,
  UsageType,
} from '@terminal/core';

import type { Db, Tx } from '../db/client.js';
import type { AccessLog, AccessLogRow } from './accessLog.js';
import type { GrantRow, LicenceRegistry } from './licenceRegistry.js';
import type { Quotas } from './quotas.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface EvaluatorDeps {
  db: Db | Tx;
  clock: Clock;
  registry: LicenceRegistry;
  /** ENTL-04. Omitted only where there is deliberately no audit trail (a unit test). */
  log?: AccessLog;
  /** API-06. Omitted → rule 8 is skipped (no quota source, no invented rejection). */
  quotas?: Quotas;
  /** Rule 10; default 60 000 ms. */
  cacheTtlMs?: number;
}

export interface EvaluatorStats {
  evaluations: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface Evaluator {
  evaluate(req: EntitlementRequest): Promise<EntitlementDecision>;
  /** Drop every cached input — for a test, and for an admin write that knows it changed a grant. */
  invalidate(): void;
  stats(): EvaluatorStats;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tier algebra
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `eod < delayed < realtime`. */
const TIER_RANK: Readonly<Record<Tier, number>> = { eod: 0, delayed: 1, realtime: 2 };

/** BRIEF §5.6: every seeded user has `delayed`; it is also what an unspecified request means. */
export const DEFAULT_TIER: Tier = 'delayed';

export function tierRank(tier: Tier): number {
  return TIER_RANK[tier];
}

/** The lower (more restrictive) of two tiers. */
export function minTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

/** The higher (more generous) of two tiers — how two grants on the same subject combine. */
export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_CACHE_TTL_MS = 60_000;

/** The inputs rule 10 caches. Everything here is derived from the registry, never from the field. */
interface CachedInputs {
  /** The firm the entry was computed for; a different firm id is a miss, not a hit. */
  firmId: number;
  /** `false` when `licence_registry` holds no current row for the source. */
  licenceKnown: boolean;
  /** Rule 2: the licence permits the requested usage. */
  usageAllowed: boolean;
  /** Rule 3: `licence.max_tier`. */
  cap: Tier;
  /** Rule 4: the best firm grant's tier, or `null` when there is none. */
  firmTier: Tier | null;
  /** Rule 5: the best user grant's tier, or `null` when there is none. */
  userTier: Tier | null;
  expiresAt: number;
}

function cacheKey(
  userId: number,
  assetClass: AssetClass | null,
  sourceId: string,
  fieldClass: FieldClass,
  usage: UsageType,
): string {
  return `${String(userId)}|${assetClass ?? '*'}|${sourceId}|${fieldClass}|${usage}`;
}

/** Does this grant cover the source, asset class, field class and usage being asked about? */
function grantApplies(
  grant: GrantRow,
  sourceId: string,
  assetClass: AssetClass | null,
  fieldClass: FieldClass,
  usage: UsageType,
): boolean {
  if (grant.sourceId !== null && grant.sourceId !== sourceId) return false;
  // A grant scoped to an asset class does not cover a request whose asset class is unknown:
  // fail closed rather than assume the scope matches.
  if (grant.assetClass !== null && grant.assetClass !== assetClass) return false;
  if (grant.fieldClass !== null && grant.fieldClass !== fieldClass) return false;
  if (usage === 'display' && !grant.usageDisplay) return false;
  if (usage === 'export' && !grant.usageExport) return false;
  if (usage === 'api' && !grant.usageApi) return false;
  return true;
}

/** The best tier a subject's grants give, and when the answer could next change. */
interface GrantVerdict {
  /** The most generous applicable grant's tier, or `null` when none applies. */
  tier: Tier | null;
  /**
   * The earliest epoch-ms at which an applicable grant lapses, or `Infinity` when every one of
   * them has an open end. Rule 10 caps the cache entry here: a contract that simply runs out
   * writes nothing, so nothing bumps `config_versions` and nothing else would notice.
   */
  boundary: number;
}

/** `validTo` as epoch ms; the open end (`null` / `'infinity'`) is `Infinity`. */
function grantEndMs(grant: GrantRow): number {
  if (grant.validTo === null) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(grant.validTo);
  // An unparseable end is treated as "could lapse at any moment": never cached.
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * The most generous applicable grant of a subject, plus the earliest lapse among the grants that
 * applied. Capping at the earliest — not the one that happened to win — is deliberately
 * conservative: it can only shorten a cache entry, never extend one past a contract's end.
 */
function bestGrantTier(
  grants: readonly GrantRow[],
  sourceId: string,
  assetClass: AssetClass | null,
  fieldClass: FieldClass,
  usage: UsageType,
): GrantVerdict {
  let best: Tier | null = null;
  let boundary = Number.POSITIVE_INFINITY;
  for (const grant of grants) {
    if (!grantApplies(grant, sourceId, assetClass, fieldClass, usage)) continue;
    best = best === null ? grant.maxTier : maxTier(best, grant.maxTier);
    boundary = Math.min(boundary, grantEndMs(grant));
  }
  return { tier: best, boundary };
}

/** The `field_class` for the audit row of a field with no `field_licence` entry. */
function auditFieldClass(fieldId: FieldId): FieldClass {
  return getField(fieldId)?.fieldClass ?? 'reference';
}

function deny(
  fieldId: FieldId,
  sourceId: string,
  fieldClass: FieldClass,
  reason: ReasonCode,
): FieldDecision {
  return { fieldId, sourceId, fieldClass, decision: 'deny', effectiveTier: null, reason };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The evaluator
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function evaluator(deps: EvaluatorDeps): Evaluator {
  const { clock, registry } = deps;
  const log = deps.log;
  const quotaSource = deps.quotas;
  const ttlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new RangeError(
      `evaluator: cacheTtlMs must be a non-negative number, got ${String(ttlMs)}`,
    );
  }

  const cache = new Map<string, CachedInputs>();
  /** The registry version the cache was built against; a bump empties it (rule 10). */
  let cacheVersion = -1;
  const counters = { evaluations: 0, cacheHits: 0, cacheMisses: 0 };

  function inputsFor(
    req: EntitlementRequest,
    sourceId: string,
    fieldClass: FieldClass,
    nowMs: number,
  ): CachedInputs {
    const key = cacheKey(req.userId, req.assetClass, sourceId, fieldClass, req.usage);
    const held = cache.get(key);
    if (held?.firmId === req.firmId && held.expiresAt > nowMs) {
      counters.cacheHits += 1;
      return held;
    }
    counters.cacheMisses += 1;

    const licence = registry.licence(sourceId);
    const usageAllowed =
      licence === undefined
        ? false
        : req.usage === 'display'
          ? licence.display
          : req.usage === 'export'
            ? licence.exportAllowed
            : licence.apiAllowed;

    const firm = bestGrantTier(
      registry.grantsFor('firm', req.firmId),
      sourceId,
      req.assetClass,
      fieldClass,
      req.usage,
    );
    const user = bestGrantTier(
      registry.grantsFor('user', req.userId),
      sourceId,
      req.assetClass,
      fieldClass,
      req.usage,
    );

    const computed: CachedInputs = {
      firmId: req.firmId,
      licenceKnown: licence !== undefined,
      usageAllowed,
      cap: licence?.maxTier ?? 'eod',
      firmTier: firm.tier,
      userTier: user.tier,
      // Rule 10, bounded by the contracts themselves: a grant expiring in 5 s caps the entry at
      // 5 s, an open-ended grant contributes `Infinity` and costs nothing. Without this a lapsed
      // contract keeps serving for the rest of the TTL, because an expiry is not a write and so
      // never bumps `config_versions`.
      expiresAt: Math.min(nowMs + ttlMs, firm.boundary, user.boundary),
    };
    cache.set(key, computed);
    return computed;
  }

  /** Rules 1-6 for one field. */
  function decideField(req: EntitlementRequest, fieldId: FieldId, nowMs: number): FieldDecision {
    // Rule 1 — field → source.
    const source = registry.fieldSource(fieldId, req.assetClass);
    if (source === undefined) {
      return deny(fieldId, '', auditFieldClass(fieldId), 'FIELD_UNKNOWN');
    }
    const { sourceId, fieldClass } = source;

    const inputs = inputsFor(req, sourceId, fieldClass, nowMs);

    // Rule 2 — licence gate. An unknown licence proves nothing and is refused by the same rule.
    if (!inputs.licenceKnown || !inputs.usageAllowed) {
      return deny(fieldId, sourceId, fieldClass, 'LICENCE_FORBIDS_USAGE');
    }

    // Rule 4 — firm contract (rule 3 is the `cap` carried in `inputs`).
    if (inputs.firmTier === null) {
      return deny(fieldId, sourceId, fieldClass, 'NO_FIRM_ENTITLEMENT');
    }

    // Rule 5 — user subscription.
    if (inputs.userTier === null) {
      return deny(fieldId, sourceId, fieldClass, 'NO_USER_ENTITLEMENT');
    }

    const grantTier = minTier(inputs.firmTier, inputs.userTier);
    const effective = minTier(inputs.cap, grantTier);

    // Rule 6 — tier.
    if (tierRank(req.tier) <= tierRank(effective)) {
      return {
        fieldId,
        sourceId,
        fieldClass,
        decision: 'allow',
        effectiveTier: req.tier,
        reason: 'OK',
      };
    }
    // The licence ceiling is checked first (rule 3), so when both bind it is the licence that is
    // reported: a generous grant never explains away a source that cannot serve the tier.
    const reason: ReasonCode =
      tierRank(inputs.cap) <= tierRank(grantTier) ? 'SOURCE_TIER_CAP' : 'NOT_ENTITLED_TIER';
    return {
      fieldId,
      sourceId,
      fieldClass,
      decision: 'downgrade',
      effectiveTier: effective,
      reason,
    };
  }

  return {
    async evaluate(req: EntitlementRequest): Promise<EntitlementDecision> {
      counters.evaluations += 1;

      // Rule 10 — one indexed SELECT; a version bump on any grant or licence write empties the
      // cache before it can serve a decision the database no longer supports.
      await registry.refreshIfStale();
      const version = registry.version();
      if (version !== cacheVersion) {
        cache.clear();
        cacheVersion = version;
      }

      const nowMs = clock.now();
      const fields: FieldDecision[] = req.fieldIds.map((fieldId) =>
        decideField(req, fieldId, nowMs),
      );

      // Rule 8 — quotas, for bearer sessions only. Nothing is charged for a request in which every
      // field was already refused.
      const served = fields.filter((f) => f.decision !== 'deny');
      if (req.usage === 'api' && quotaSource !== undefined && served.length > 0) {
        const instrumentIds = req.instrumentId === null ? [] : [req.instrumentId];
        const check = await quotaSource.check({
          userId: req.userId,
          firmId: req.firmId,
          clientKind: 'api',
          instrumentIds,
          dataPoints: served.length,
        });
        if (!check.ok) {
          for (const field of fields) {
            if (field.decision === 'deny') continue;
            field.decision = 'deny';
            field.effectiveTier = null;
            field.reason = 'QUOTA_EXCEEDED';
          }
        } else {
          // The daily unique-instrument counter only ever grows by insert-if-absent, so recording
          // it here is idempotent and cannot double-count whatever the data path records later.
          // The monthly data points are charged on the SAME call: checking a ceiling and then not
          // charging it makes it unenforceable, and API.md §8 counts the fields served for an api
          // session. A read with no instrument still charges its points, so the `record` is
          // unconditional. Not awaited: rule 8 must not put a write on the response path.
          void quotaSource
            .record({
              userId: req.userId,
              firmId: req.firmId,
              instrumentIds,
              dataPoints: served.length,
            })
            .catch((err: unknown) => {
              process.emitWarning(
                `quota instrument record failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
      }

      // Rule 9 — the audit trail. `append()` never awaits; the ids are provisional.
      const logIds: number[] = [];
      if (log !== undefined) {
        for (const field of fields) {
          const row: AccessLogRow = {
            ts: nowMs,
            userId: req.userId,
            firmId: req.firmId,
            sessionId: req.sessionId,
            instrumentId: req.instrumentId,
            fieldId: field.fieldId,
            fieldClass: field.fieldClass,
            sourceId: field.sourceId,
            requestedTier: req.tier,
            tier: field.effectiveTier,
            usage: req.usage,
            purpose: req.purpose,
            decision: field.decision,
            reason: field.reason,
            traceId: req.traceId,
          };
          logIds.push(log.append(row));
        }
      }

      const downgrades: EntitlementDowngrade[] = fields
        .filter((f) => f.decision === 'downgrade')
        .map((f) => ({ fieldId: f.fieldId, reason: f.reason }));

      // The decision's tier is the most restrictive tier any served field came back with: it is the
      // tier the caller may label the whole response with without overstating a single field.
      let effectiveTier: Tier | null = null;
      for (const field of fields) {
        if (field.decision === 'deny' || field.effectiveTier === null) continue;
        effectiveTier =
          effectiveTier === null
            ? field.effectiveTier
            : minTier(effectiveTier, field.effectiveTier);
      }

      return { effectiveTier, fields, downgrades, logIds };
    },

    invalidate(): void {
      cache.clear();
      cacheVersion = -1;
    },

    stats(): EvaluatorStats {
      return { ...counters };
    },
  };
}
