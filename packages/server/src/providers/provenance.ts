/**
 * `insertProvenance` — DATA-10, PROVIDERS.a §1.3 (L130-150), DATA_MODEL §2.
 *
 * Exactly one `provenance` row per non-304 provider exchange, written **before** `normalise()`
 * runs, so that every update and every row the normaliser produces can carry the id. No value is
 * written to any table without one: `provenance_id` is `NOT NULL` on every value-bearing table in
 * CONTRACTS §1.2, which makes "where did this number come from" answerable by a join rather than
 * by a log search.
 *
 * `provenance.source_id` is trigger-checked against `licence_registry`
 * (`provenance_source_known` → `assert_source_known`), so an adapter whose licence row is missing
 * cannot write a single value — that is the enforcement mechanism behind DATA-09: registration is
 * not a convention, it is a foreign-key-by-trigger. The check below is the same rule, reported
 * from the process that can name the adapter rather than from SQLSTATE.
 *
 * A `304 Not Modified` writes **no** provenance row (§1.3): nothing new was published, the plant's
 * `ts.cap` deliberately does not advance, and the scheduler counts the exchange in
 * `ingest_runs.skipped`.
 */

import type { Tx } from '../db/client.js';
import { provenance } from '../db/schema/provenance.js';
import { isLicensedSource } from './types.js';
import type { RawRecord } from './types.js';

/** What the caller knows and the transport does not. */
export interface ProvenanceMeta {
  /** `'<family>/<semver>'` — `'cboe/1.0.0'` (PROVIDERS.a §1.4). */
  adapterVersion: string;
  /**
   * The provider-published instant. Optional: the transport already put what it knew on
   * `raw.sourceTs`, and a normaliser that reads a more precise instant out of the payload passes
   * it here. `null` is an explicit "this payload carries none" and overrides `raw.sourceTs`.
   */
  sourceTs?: Date | null;
  /** OPS-07 — set when the fetch happened on behalf of a request. Must be a uuid. */
  traceId?: string;
  /** `ingest_runs.run_id` when the scheduler was the caller. */
  runId?: number;
}

/** Thrown instead of letting a 304 or an unlicensed source reach the database. */
export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvenanceError';
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

function hexToBytes(hex: string, field: string): Buffer {
  if (!HEX64.test(hex)) {
    throw new ProvenanceError(
      `provenance.${field} must be 64 lower-case hex characters, got '${hex}'`,
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Write the provenance row for one raw exchange and return its id.
 *
 * `bytes` is `raw.body.length` — the bytes actually received, which for a `200` is what was
 * hashed into `response_sha256`. `captured_at` is FEED-05 `cap`, the instant the fetch completed,
 * and is what a replayed run reproduces from the manifest (so a 2030 replay stamps the 2026
 * instant, not its own wall clock).
 *
 * @throws ProvenanceError on a 304, on an unlicensed `source_id`, or on a malformed digest.
 */
export async function insertProvenance(
  tx: Tx,
  raw: RawRecord,
  meta: ProvenanceMeta,
): Promise<number> {
  if (raw.status === 304) {
    throw new ProvenanceError(
      `refusing to write provenance for a 304 from ${raw.providerId} ${raw.url}: a revalidation ` +
        'publishes nothing new, so it writes no row and emits no update (PROVIDERS.a §1.3) — ' +
        'count it in ingest_runs.skipped instead',
    );
  }
  if (!isLicensedSource(raw.providerId)) {
    throw new ProvenanceError(
      `source_id '${raw.providerId}' is not in the licence registry ` +
        '(packages/server/src/providers/licences.ts); assert_source_known would reject this row ' +
        '(DATA-09)',
    );
  }
  if (meta.adapterVersion === '') {
    throw new ProvenanceError(
      `adapter_version is required on every provenance row (${raw.providerId} ${raw.url})`,
    );
  }

  const sourceTs = meta.sourceTs === undefined ? raw.sourceTs : meta.sourceTs;

  const rows = await tx
    .insert(provenance)
    .values({
      sourceId: raw.providerId,
      requestKey: raw.requestKey,
      requestUrl: raw.url,
      requestHash: hexToBytes(raw.requestHash, 'request_hash'),
      responseSha256: hexToBytes(raw.sha256, 'response_sha256'),
      httpStatus: raw.status,
      bytes: raw.body.length,
      capturedAt: new Date(raw.capturedAt).toISOString(),
      sourceTs: sourceTs === null ? null : sourceTs.toISOString(),
      adapterVersion: meta.adapterVersion,
      traceId: meta.traceId ?? null,
      runId: meta.runId ?? null,
    })
    .returning({ provenanceId: provenance.provenanceId });

  const row = rows[0];
  if (row === undefined) {
    throw new ProvenanceError(
      `the provenance insert for ${raw.providerId} ${raw.url} returned no row`,
    );
  }
  return Number(row.provenanceId);
}
