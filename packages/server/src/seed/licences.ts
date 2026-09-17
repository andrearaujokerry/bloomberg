// packages/server/src/seed/licences.ts
//
// Seed module 1 of DATA_MODEL §18: `licence_registry` (33 sources) and `field_licence`
// (one row per field × asset class, ≈ 400). It runs first and alone: the `assert_source_known`
// trigger rejects every other write — `provenance` included — until these rows exist.
//
// Deterministic and idempotent, per DATA_MODEL §18:
//   * `licence_registry` is bitemporal and immutable (the `bt_guard_update` trigger lets only `tx_to`
//     change), so an unchanged source is left completely alone, and a changed one has its current
//     version closed with `tx_to = clock_timestamp()` before the new version is inserted. Re-running
//     the seed on an unchanged registry issues no write at all, which also means the
//     `licence_registry_bump` / `field_licence_bump` statement triggers do not bump
//     `config_versions('entitlements')` for a no-op run.
//   * `field_licence` is a plain PK table: rows are upserted on `(field_id, asset_class)` and rows
//     that the dictionary no longer produces are deleted, because startup exits 1 on a
//     `field_licence.field_id` the dictionary does not know (ARCHITECTURE §12.1 step 3).
//
// The caller owns the transaction (`db/client.ts#withTx`) and passes its client in; this module
// never opens a connection, so the same code seeds `bloomberg_dev`, `bloomberg_test` and a scratch
// database from a script.

import type { FieldLicenceRow, LicenceRow } from '../providers/licences.js';
import { fieldLicenceRows, licenceRows } from '../providers/licences.js';

/**
 * The narrow slice of `pg.Client` / `pg.PoolClient` this module needs — a transaction-scoped
 * executor. Anything with `query(text, values)` satisfies it, including a drizzle session's
 * underlying client.
 */
export interface SeedDb {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * `valid_from` of the bootstrap versions. Fixed rather than `now()` so that re-seeding a database
 * produces byte-identical rows and the bitemporal history of a licence change reads as
 * "these terms were in force from the start of the system".
 */
export const LICENCE_VALID_FROM = '2026-01-01T00:00:00.000Z';

export interface SeedLicencesResult {
  readonly licencesInserted: number;
  readonly licencesVersioned: number;
  readonly licencesUnchanged: number;
  readonly fieldLicencesInserted: number;
  readonly fieldLicencesUpdated: number;
  readonly fieldLicencesDeleted: number;
  readonly fieldLicencesUnchanged: number;
}

/** The mutable shape `licence_registry` columns come back as. */
interface CurrentLicence {
  version_id: string;
  source_id: string;
  source_name: string;
  publisher: string;
  terms_url: string | null;
  contract_ref: string | null;
  licence_kind: string;
  display: boolean;
  non_display: boolean;
  derived: boolean;
  redistribution: boolean;
  export_allowed: boolean;
  api_allowed: boolean;
  max_tier: string;
  intrinsic_delay_min: number;
  retention_days: number | null;
  attribution: string;
  rate_limit: string;
  requires_user_agent: boolean;
  api_key_env: string | null;
  audit_obligation: string | null;
  notes: string | null;
}

interface CurrentFieldLicence {
  field_id: string;
  asset_class: string;
  source_id: string;
  field_class: string;
}

const LICENCE_COLUMNS = `version_id, source_id, source_name, publisher, terms_url, contract_ref,
  licence_kind, display, non_display, derived, redistribution, export_allowed, api_allowed,
  max_tier, intrinsic_delay_min, retention_days, attribution, rate_limit, requires_user_agent,
  api_key_env, audit_obligation, notes`;

async function select<R>(db: SeedDb, text: string, values?: unknown[]): Promise<R[]> {
  const result = await db.query(text, values);
  return result.rows as R[];
}

/** True when the stored version already says exactly what `row` says (`version_id` aside). */
function licenceMatches(current: CurrentLicence, row: LicenceRow): boolean {
  return (
    current.source_name === row.sourceName &&
    current.publisher === row.publisher &&
    current.terms_url === row.termsUrl &&
    current.contract_ref === row.contractRef &&
    current.licence_kind === row.licenceKind &&
    current.display === row.display &&
    current.non_display === row.nonDisplay &&
    current.derived === row.derived &&
    current.redistribution === row.redistribution &&
    current.export_allowed === row.exportAllowed &&
    current.api_allowed === row.apiAllowed &&
    current.max_tier === row.maxTier &&
    current.intrinsic_delay_min === row.intrinsicDelayMin &&
    current.retention_days === row.retentionDays &&
    current.attribution === row.attribution &&
    current.rate_limit === row.rateLimit &&
    current.requires_user_agent === row.requiresUserAgent &&
    current.api_key_env === row.apiKeyEnv &&
    current.audit_obligation === row.auditObligation &&
    current.notes === row.notes
  );
}

function licenceValues(row: LicenceRow): unknown[] {
  return [
    row.sourceId,
    row.sourceName,
    row.publisher,
    row.termsUrl,
    row.contractRef,
    row.licenceKind,
    row.display,
    row.nonDisplay,
    row.derived,
    row.redistribution,
    row.exportAllowed,
    row.apiAllowed,
    row.maxTier,
    row.intrinsicDelayMin,
    row.retentionDays,
    row.attribution,
    row.rateLimit,
    row.requiresUserAgent,
    row.apiKeyEnv,
    row.auditObligation,
    row.notes,
    LICENCE_VALID_FROM,
  ];
}

const INSERT_LICENCE = `
  INSERT INTO licence_registry (
    source_id, source_name, publisher, terms_url, contract_ref, licence_kind,
    display, non_display, derived, redistribution, export_allowed, api_allowed,
    max_tier, intrinsic_delay_min, retention_days, attribution, rate_limit,
    requires_user_agent, api_key_env, audit_obligation, notes,
    valid_from, valid_to, tx_from, tx_to, provenance_id
  ) VALUES (
    $1, $2, $3, $4, $5, $6,
    $7, $8, $9, $10, $11, $12,
    $13::tier, $14, $15, $16, $17,
    $18, $19, $20, $21,
    $22::timestamptz, 'infinity', clock_timestamp(), 'infinity', NULL
  )`;

/**
 * Writes the registry and the field matrix. The caller must already be inside a transaction; on any
 * error the whole module rolls back, which is what keeps `field_licence` from pointing at a source
 * that was never registered.
 */
export async function seedLicences(db: SeedDb): Promise<SeedLicencesResult> {
  // ── licence_registry ────────────────────────────────────────────────────────────────────────
  const current = await select<CurrentLicence>(
    db,
    `SELECT ${LICENCE_COLUMNS} FROM licence_registry WHERE tx_to = 'infinity'`,
  );
  const currentBySource = new Map(current.map((row) => [row.source_id, row]));

  let licencesInserted = 0;
  let licencesVersioned = 0;
  let licencesUnchanged = 0;

  for (const row of licenceRows) {
    const existing = currentBySource.get(row.sourceId);
    if (existing !== undefined) {
      if (licenceMatches(existing, row)) {
        licencesUnchanged += 1;
        continue;
      }
      // Bitemporal correction: close the current version first — the exclusion constraint only
      // looks at rows with tx_to = 'infinity', so the new version can reuse the same valid range.
      await db.query(
        `UPDATE licence_registry SET tx_to = clock_timestamp() WHERE version_id = $1 AND tx_to = 'infinity'`,
        [existing.version_id],
      );
      licencesVersioned += 1;
    } else {
      licencesInserted += 1;
    }
    await db.query(INSERT_LICENCE, licenceValues(row));
  }

  // ── field_licence ───────────────────────────────────────────────────────────────────────────
  const currentFields = await select<CurrentFieldLicence>(
    db,
    'SELECT field_id, asset_class, source_id, field_class FROM field_licence',
  );
  const currentByKey = new Map(
    currentFields.map((row) => [`${row.field_id} ${row.asset_class}`, row]),
  );

  const toWrite: FieldLicenceRow[] = [];
  let fieldLicencesInserted = 0;
  let fieldLicencesUpdated = 0;
  let fieldLicencesUnchanged = 0;
  const wanted = new Set<string>();

  for (const row of fieldLicenceRows) {
    const key = `${row.fieldId} ${row.assetClass}`;
    wanted.add(key);
    const existing = currentByKey.get(key);
    if (existing === undefined) {
      fieldLicencesInserted += 1;
      toWrite.push(row);
    } else if (existing.source_id !== row.sourceId || existing.field_class !== row.fieldClass) {
      fieldLicencesUpdated += 1;
      toWrite.push(row);
    } else {
      fieldLicencesUnchanged += 1;
    }
  }

  if (toWrite.length > 0) {
    await db.query(
      `INSERT INTO field_licence (field_id, asset_class, source_id, field_class)
       SELECT * FROM unnest($1::text[], $2::asset_class[], $3::text[], $4::field_class[])
       ON CONFLICT (field_id, asset_class)
       DO UPDATE SET source_id = EXCLUDED.source_id, field_class = EXCLUDED.field_class`,
      [
        toWrite.map((row) => row.fieldId),
        toWrite.map((row) => row.assetClass),
        toWrite.map((row) => row.sourceId),
        toWrite.map((row) => row.fieldClass),
      ],
    );
  }

  // Rows the dictionary no longer produces would fail the startup validation, so they go.
  const stale = currentFields.filter((row) => !wanted.has(`${row.field_id} ${row.asset_class}`));
  if (stale.length > 0) {
    await db.query(
      `DELETE FROM field_licence fl
        USING unnest($1::text[], $2::asset_class[]) AS d(field_id, asset_class)
        WHERE fl.field_id = d.field_id AND fl.asset_class = d.asset_class`,
      [stale.map((row) => row.field_id), stale.map((row) => row.asset_class)],
    );
  }

  return {
    licencesInserted,
    licencesVersioned,
    licencesUnchanged,
    fieldLicencesInserted,
    fieldLicencesUpdated,
    fieldLicencesDeleted: stale.length,
    fieldLicencesUnchanged,
  };
}

/** Module 1 of the ordered seed runner (`seed/index.ts`). */
export const licencesSeedModule = {
  order: 1,
  name: 'licences',
  run: seedLicences,
} as const;
