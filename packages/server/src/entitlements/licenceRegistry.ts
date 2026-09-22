/**
 * `entitlements/licenceRegistry.ts` — the process-local copy of everything the evaluator needs
 * that lives in a table (WORKPLAN WP-07, ARCHITECTURE §10 rules 1, 2 and 10).
 *
 * Three tables, one snapshot:
 *
 *  - `licence_registry`, **current version only**: `tx_to = 'infinity'` (the open transaction end)
 *    and `valid_from <= now < valid_to` (the open validity bracket). The exclusion constraint of
 *    migration 0002 guarantees at most one such row per `source_id`, so the map is unambiguous.
 *    This is rule 2 (usage gate) and rule 3 (`max_tier` ceiling).
 *  - `field_licence`, which is rule 1: `(fieldId, assetClass) → (sourceId, fieldClass)`. A pair the
 *    table does not know returns `undefined`, and the evaluator answers `FIELD_UNKNOWN` — nothing
 *    here invents a source.
 *  - `entitlement_grants`, filtered to rows valid as-of `clock.now()` at every `grantsFor` call
 *    (rules 4 and 5). The snapshot holds every grant row; validity is decided per call, so a grant
 *    that expires between two reloads stops applying the second it expires.
 *
 * **Staleness.** `refreshIfStale()` is ONE `SELECT version FROM config_versions WHERE name =
 * 'entitlements'`. The `licence_registry_bump` / `field_licence_bump` / `entitlement_grants_bump`
 * statement triggers (migration 0014) move that number on any write to the three tables, so a grant
 * revoked by another process reaches this one on the next call, at the cost of one indexed lookup.
 * `reload()` reads the version FIRST and the data after: a bump that lands mid-load then leaves the
 * stored version BEHIND the bumped one, so the next `refreshIfStale()` reloads. Reading the version
 * last would record a version newer than the data and pin a torn snapshot forever.
 *
 * Nothing here writes, and nothing here opens a transaction: four `SELECT`s on the injected handle,
 * which is the request/test transaction when one is in scope.
 */

import { sql } from 'drizzle-orm';

import type { AssetClass, Clock, FieldClass, FieldId, Tier } from '@terminal/core';

import type { Db, Tx } from '../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One current `licence_registry` row — the machine-readable terms of a source (DATA-09). */
export interface LicenceEntry {
  sourceId: string;
  sourceName: string;
  publisher: string;
  licenceKind: string;
  display: boolean;
  nonDisplay: boolean;
  derived: boolean;
  redistribution: boolean;
  exportAllowed: boolean;
  apiAllowed: boolean;
  /** Evaluator rule 3: the ceiling no grant can exceed. */
  maxTier: Tier;
  intrinsicDelayMin: number;
  /** `null` = unlimited retention. */
  retentionDays: number | null;
  attribution: string | null;
  contractRef: string | null;
}

/** The key of a `field_licence` row. `assetClass` is `null` for the field-wide fallback. */
export interface FieldLicenceKey {
  fieldId: FieldId;
  assetClass: AssetClass | null;
}

/** What rule 1 resolves a field to. */
export interface FieldSource {
  sourceId: string;
  fieldClass: FieldClass;
}

/** One `entitlement_grants` row. `validTo` is `null` for the open end (`'infinity'` in SQL). */
export interface GrantRow {
  grantId: number;
  subjectKind: 'user' | 'firm';
  subjectId: number;
  /** `null` = every source. */
  sourceId: string | null;
  /** `null` = every asset class. */
  assetClass: AssetClass | null;
  /** `null` = every field class. */
  fieldClass: FieldClass | null;
  maxTier: Tier;
  usageDisplay: boolean;
  usageExport: boolean;
  usageApi: boolean;
  validFrom: string;
  validTo: string | null;
  contractRef: string | null;
}

export interface LicenceRegistry {
  /** The current terms of `sourceId`, or `undefined` when the registry does not know it. */
  licence(sourceId: string): LicenceEntry | undefined;
  /**
   * Rule 1. A named `assetClass` resolves ONLY against the exact `(fieldId, assetClass)` row;
   * the field-wide view is for `assetClass === null` callers alone.
   */
  fieldSource(fieldId: FieldId, assetClass: AssetClass | null): FieldSource | undefined;
  /** Every grant row of the subject, filtered to those valid as-of `clock.now()`. */
  grantsFor(subjectKind: 'user' | 'firm', subjectId: number): readonly GrantRow[];
  /** `config_versions('entitlements').version` as last loaded. */
  version(): number;
  /** Full load of all three tables. Called on construction and on a version bump. */
  reload(): Promise<void>;
  /** One cheap `SELECT` of the version; reloads only when it moved. */
  refreshIfStale(): Promise<void>;
  /** Rows held by the current snapshot — for `/status` and the tests. */
  stats(): LicenceRegistryStats;
}

export interface LicenceRegistryStats {
  version: number;
  licences: number;
  fieldLicences: number;
  grants: number;
  loads: number;
  /** `refreshIfStale()` calls that found the version unchanged. */
  freshChecks: number;
}

export interface LicenceRegistryDeps {
  db: Db | Tx;
  clock: Clock;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row shapes as the driver returns them (bigint columns arrive as strings)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface LicenceSqlRow {
  source_id: string;
  source_name: string;
  publisher: string;
  licence_kind: string;
  display: boolean;
  non_display: boolean;
  derived: boolean;
  redistribution: boolean;
  export_allowed: boolean;
  api_allowed: boolean;
  max_tier: Tier;
  intrinsic_delay_min: number;
  retention_days: number | null;
  attribution: string | null;
  contract_ref: string | null;
}

interface FieldLicenceSqlRow {
  field_id: string;
  asset_class: AssetClass | null;
  source_id: string;
  field_class: FieldClass;
}

interface GrantSqlRow {
  grant_id: string;
  subject_kind: string;
  subject_id: string;
  source_id: string | null;
  asset_class: AssetClass | null;
  field_class: FieldClass | null;
  max_tier: Tier;
  usage_display: boolean;
  usage_export: boolean;
  usage_api: boolean;
  /** ISO 8601, or `null` for `-infinity`. */
  valid_from: string | null;
  /** ISO 8601, or `null` for `infinity` (the open end). */
  valid_to: string | null;
  contract_ref: string | null;
}

/** A grant plus the epoch-ms bracket `grantsFor` compares against, computed once at load. */
interface CachedGrant {
  row: GrantRow;
  fromMs: number;
  toMs: number;
}

interface Snapshot {
  version: number;
  licences: Map<string, LicenceEntry>;
  /** `${fieldId}:${assetClass}` → source. */
  exact: Map<string, FieldSource>;
  /**
   * `fieldId` → the field-wide fallback, or `null` when the field's rows disagree on the source and
   * a fallback would have to guess. `null` denies (`FIELD_UNKNOWN`) rather than guess.
   */
  anyClass: Map<string, FieldSource | null>;
  /** `${subjectKind}:${subjectId}` → that subject's grants. */
  grants: Map<string, CachedGrant[]>;
  fieldLicenceCount: number;
  grantCount: number;
}

const EMPTY_GRANTS: readonly GrantRow[] = Object.freeze([]);

function emptySnapshot(): Snapshot {
  return {
    version: 0,
    licences: new Map(),
    exact: new Map(),
    anyClass: new Map(),
    grants: new Map(),
    fieldLicenceCount: 0,
    grantCount: 0,
  };
}

/** `field_licence` key. `:` cannot appear in a field id (/^[A-Z][A-Z0-9_]{1,39}$/) or in an asset_class label. */
function exactKey(fieldId: string, assetClass: string): string {
  return `${fieldId}:${assetClass}`;
}

function subjectKey(subjectKind: string, subjectId: number): string {
  return `${subjectKind}:${String(subjectId)}`;
}

/** `to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` for a timestamptz that is not infinite. */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export function licenceRegistry(deps: LicenceRegistryDeps): LicenceRegistry {
  const { db, clock } = deps;
  let snapshot: Snapshot = emptySnapshot();
  let loads = 0;
  let freshChecks = 0;
  /** Serialises `reload()`: two concurrent callers share one load rather than racing. */
  let loading: Promise<void> | undefined;

  async function rows<R>(query: ReturnType<typeof sql>): Promise<R[]> {
    const result = await db.execute(query);
    return result.rows as unknown as R[];
  }

  async function readVersion(): Promise<number> {
    const found = await rows<{ version: string }>(
      sql`SELECT version::text AS version FROM config_versions WHERE name = 'entitlements'`,
    );
    // A database without the row (nothing has bumped it yet) reads as version 0, which is below
    // every real version, so the first bump still triggers a reload.
    return found.length === 0 ? 0 : Number(found[0]?.version ?? 0);
  }

  async function load(): Promise<void> {
    // Version FIRST — see the module docstring.
    const version = await readVersion();
    const nowIso = new Date(clock.now()).toISOString();

    const licenceRows = await rows<LicenceSqlRow>(sql`
      SELECT source_id, source_name, publisher, licence_kind, display, non_display, derived,
             redistribution, export_allowed, api_allowed, max_tier, intrinsic_delay_min,
             retention_days, attribution, contract_ref
        FROM licence_registry
       WHERE tx_to = 'infinity'
         AND valid_from <= ${nowIso}::timestamptz
         AND valid_to   >  ${nowIso}::timestamptz`);

    const fieldRows = await rows<FieldLicenceSqlRow>(sql`
      SELECT field_id, asset_class, source_id, field_class FROM field_licence`);

    const grantRows = await rows<GrantSqlRow>(sql`
      SELECT grant_id::text          AS grant_id,
             subject_kind,
             subject_id::text        AS subject_id,
             source_id, asset_class, field_class, max_tier,
             usage_display, usage_export, usage_api,
             CASE WHEN valid_from = '-infinity' THEN NULL
                  ELSE to_char(valid_from AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS valid_from,
             CASE WHEN valid_to = 'infinity' THEN NULL
                  ELSE to_char(valid_to AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS valid_to,
             contract_ref
        FROM entitlement_grants`);

    const next: Snapshot = {
      ...emptySnapshot(),
      version,
      fieldLicenceCount: fieldRows.length,
      grantCount: grantRows.length,
    };

    for (const row of licenceRows) {
      next.licences.set(row.source_id, {
        sourceId: row.source_id,
        sourceName: row.source_name,
        publisher: row.publisher,
        licenceKind: row.licence_kind,
        display: row.display,
        nonDisplay: row.non_display,
        derived: row.derived,
        redistribution: row.redistribution,
        exportAllowed: row.export_allowed,
        apiAllowed: row.api_allowed,
        maxTier: row.max_tier,
        intrinsicDelayMin: Number(row.intrinsic_delay_min),
        retentionDays: row.retention_days === null ? null : Number(row.retention_days),
        attribution: row.attribution,
        contractRef: row.contract_ref,
      });
    }

    for (const row of fieldRows) {
      const source: FieldSource = { sourceId: row.source_id, fieldClass: row.field_class };
      if (row.asset_class === null) {
        // A genuine `asset_class IS NULL` row IS the field-wide fallback and wins outright.
        next.anyClass.set(row.field_id, source);
        continue;
      }
      next.exact.set(exactKey(row.field_id, row.asset_class), source);
      if (next.anyClass.has(row.field_id)) {
        const held = next.anyClass.get(row.field_id);
        // An explicit NULL row already decided the fallback; per-class rows never override it.
        if (held === undefined) continue;
        if (held === null) continue;
        if (held.sourceId !== source.sourceId || held.fieldClass !== source.fieldClass) {
          next.anyClass.set(row.field_id, null); // ambiguous → no fallback
        }
      } else {
        next.anyClass.set(row.field_id, source);
      }
    }

    for (const row of grantRows) {
      if (row.subject_kind !== 'user' && row.subject_kind !== 'firm') continue;
      const subjectId = Number(row.subject_id);
      const grant: GrantRow = {
        grantId: Number(row.grant_id),
        subjectKind: row.subject_kind,
        subjectId,
        sourceId: row.source_id,
        assetClass: row.asset_class,
        fieldClass: row.field_class,
        maxTier: row.max_tier,
        usageDisplay: row.usage_display,
        usageExport: row.usage_export,
        usageApi: row.usage_api,
        validFrom: row.valid_from ?? '-infinity',
        validTo: row.valid_to,
        contractRef: row.contract_ref,
      };
      const cached: CachedGrant = {
        row: grant,
        fromMs: row.valid_from === null ? Number.NEGATIVE_INFINITY : Date.parse(row.valid_from),
        toMs: row.valid_to === null ? Number.POSITIVE_INFINITY : Date.parse(row.valid_to),
      };
      const key = subjectKey(row.subject_kind, subjectId);
      const bucket = next.grants.get(key);
      if (bucket === undefined) next.grants.set(key, [cached]);
      else bucket.push(cached);
    }

    snapshot = next;
    loads += 1;
  }

  async function reload(): Promise<void> {
    // A second caller joins the load in flight instead of issuing four more SELECTs.
    loading ??= load().finally(() => {
      loading = undefined;
    });
    await loading;
  }

  return {
    licence(sourceId: string): LicenceEntry | undefined {
      return snapshot.licences.get(sourceId);
    },

    fieldSource(fieldId: FieldId, assetClass: AssetClass | null): FieldSource | undefined {
      // Rule 1's key is `(fieldId, assetClass)`. When the caller NAMES an asset class, only the
      // row for that pair may answer: falling back to another class's row would make an
      // asset-class-scoped grant portable to a source the contract never bought (a sub on an
      // equity subject asking for OPT_IV would otherwise bill cboe.options). A miss is a miss,
      // and the evaluator denies FIELD_UNKNOWN.
      if (assetClass !== null) return snapshot.exact.get(exactKey(fieldId, assetClass));
      // Only a caller that names NO asset class gets the field-wide view: a genuine
      // `asset_class IS NULL` row, or the field's own per-class rows when they all agree on the
      // source. When they disagree the entry is `null` and there is nothing to fall back to.
      return snapshot.anyClass.get(fieldId) ?? undefined;
    },

    grantsFor(subjectKind: 'user' | 'firm', subjectId: number): readonly GrantRow[] {
      const bucket = snapshot.grants.get(subjectKey(subjectKind, subjectId));
      if (bucket === undefined) return EMPTY_GRANTS;
      const now = clock.now();
      const live: GrantRow[] = [];
      for (const grant of bucket) {
        if (grant.fromMs <= now && now < grant.toMs) live.push(grant.row);
      }
      return live;
    },

    version(): number {
      return snapshot.version;
    },

    reload,

    async refreshIfStale(): Promise<void> {
      const version = await readVersion();
      if (version === snapshot.version) {
        freshChecks += 1;
        return;
      }
      await reload();
    },

    stats(): LicenceRegistryStats {
      return {
        version: snapshot.version,
        licences: snapshot.licences.size,
        fieldLicences: snapshot.fieldLicenceCount,
        grants: snapshot.grantCount,
        loads,
        freshChecks,
      };
    },
  };
}
