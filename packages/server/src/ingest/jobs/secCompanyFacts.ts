/**
 * `ingest/jobs/secCompanyFacts.ts` — SEC XBRL company facts → `xbrl_facts` → `fin_statements`.
 *
 * PROVIDERS §7.3 / §7.3.1 / §7.3.2, §13 row `secCompanyFacts`, WORKPLAN §WP-10 L1234.
 *
 * Two writes, in this order, and the order is the whole point:
 *
 *  1. **`xbrl_facts`**, keyed on SEC's `filed` (`filed_at`). The table is WORM
 *     (`xbrl_facts_worm`, DATA_MODEL L2245): a restatement is a *new row* with a later `filed_at`,
 *     never an update of the old one, so the number Apple published on 2026-05-01 is still
 *     readable after the 2026-07-31 restatement of the same period. Re-ingesting the same capture
 *     therefore has to insert **nothing**, which is what the `ON CONFLICT DO NOTHING` against
 *     `xbrl_facts_natural_uniq` buys: the natural key is
 *     `(cik, taxonomy, concept, unit, period_end, COALESCE(period_start,…), accession_no)`, and a
 *     second run of the same payload collides on every row.
 *  2. **`fin_statements`**, standardised through `XBRL_CONCEPT_MAP` (`mapping_version
 *     'std-map/2026.09'`, PROVIDERS §7.3.1), **one row per (period, filing)**. That grouping is
 *     what makes the point-in-time read work: `data/fundamentals.ts#statements` is
 *     `DISTINCT ON (period_end) … WHERE filed_at <= knownAt ORDER BY filed_at DESC`, so a period
 *     reported by two filings must exist as two rows or the restatement is invisible in one
 *     direction and permanent in the other. A builder that wrote "the latest view of each period"
 *     would pass every count assertion and destroy the property the table exists for.
 *
 * `fin_statements` is also insert-only *by grant*: §15.b of `0015_roles_rls_worm.sql` lists the
 * tables `terminal_app` may UPDATE and `fin_statements` is not among them. It does not need to be
 * — `mapping_version` and `filed_at` are both in the primary key, so a re-standardisation under a
 * new mapping adds rows beside the old ones and re-running today's mapping collides with itself.
 *
 * ## What the builder does that the concept map cannot say (§7.3.1's four rules)
 *
 *  - **first hit wins, per period, per filing.** The fallback chain is walked in `priority` order
 *    inside one accession; it never averages and never reaches into a different filing for a
 *    lower-priority concept.
 *  - **two computed items.** `GROSS_PROFIT` falls back to `REVENUE − COGS` and `FCF` is always
 *    `CFO − |CAPEX|`; both record `{"concept": "computed:…", "fact_id": null}` in `as_reported`,
 *    so FA's "as reported" toggle says the issuer never tagged the line instead of showing a
 *    number with no filing behind it.
 *  - **Q4 derivation.** A 10-K carries only the annual duration, so `Q4 = FY − (Q1 + Q2 + Q3)`
 *    with `derived_q4 = true` — and the three quarters are taken *as they were known at the 10-K's
 *    own `filed_at`*, because a Q4 built from a restatement that had not happened yet would be a
 *    number nobody could have computed on the day. `SHARES_DIL` is deliberately **not** derived:
 *    it is a weighted average over a period and the difference of two averages is not a share
 *    count.
 *  - **a standard item with no hit stays NULL.** Never `0`, never a guess; FA reports it through
 *    `PayloadMeta.unavailable` with reason `NO_SOURCE`.
 *
 * ## Determinism
 *
 * Everything is sorted before it is used: the accessions, the periods inside an accession, the
 * concept chain (by `priority`), the fact list inside a period (by `fact_id`), and the
 * `provenance_ids[]` array. `inputs_hash` is the sha256 of the canonical JSON of exactly the
 * inputs that produced the row, so two runs over the same capture produce byte-identical rows and
 * a changed input is visible without diffing twenty-five columns.
 *
 * **Replay is a wall.** With no `HttpClient` wired the job reads the recorded capture through the
 * replay store; a key the store does not hold throws `ReplayMissError`, which this job counts as
 * "that CIK did not answer this tick" — never as a socket.
 */

import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { statementLines } from '@terminal/core/fields/defs/fundamental';

import { companyFactsUrl, secCompanyFactsAdapter } from '../../providers/sec/adapter.js';
import {
  SEC_ADAPTER_VERSION,
  XBRL_CONCEPT_MAP,
  XBRL_CONCEPT_MAP_VERSION,
  durationClass,
} from '../../providers/sec/parse.js';
import { ReplayMissError } from '../../providers/replayStore.js';
import {
  emptyResult,
  fetchError,
  fetchThrough,
  normaliseWithProvenance,
  requestEnvelope,
  withIngestRun,
} from './cboeQuotes.js';
import { recordDqEvent } from './secNport.js';

import type { StatementLineDef } from '@terminal/core/fields/defs/fundamental';
import type { Tx } from '../../db/client.js';
import type { MarketJobContext, MarketJobResult } from './cboeQuotes.js';
import type { NormaliseLine, ProviderId, RawRecord } from '../../providers/types.js';
import type { XbrlFactRow } from '../../providers/sec/parse.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The scheduler row (PROVIDERS §13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** §13: `'0 3 * * *'`, staggered ≤ 10 req/s. */
export const SEC_COMPANYFACTS_SCHEDULE = '0 3 * * *';
export const SEC_COMPANYFACTS_SOURCE_ID = 'sec.companyfacts' satisfies ProviderId;

/** ANAL-08 `engine_name` / `engine_version` for every `fin_statements` row this module writes. */
export const FIN_STATEMENTS_ENGINE = 'secCompanyFacts';
export const FIN_STATEMENTS_ENGINE_VERSION = 'fin-statements/1.0.0';

/** `mapping_version` recorded on every row — the QA-02 assertion. */
export const FIN_STATEMENTS_MAPPING_VERSION = XBRL_CONCEPT_MAP_VERSION;

/** §7.3: a response this much smaller than what this CIK served before is a stale CDN object. */
export const POLL_ANOMALY_FLOOR_BYTES = 100 * 1024;
/** …but only when the CIK has previously served megabytes; a small filer is not an anomaly. */
export const POLL_ANOMALY_PRIOR_BYTES = 1024 * 1024;

/** Postgres caps a statement at 65 535 bind parameters; 1 000 × 15 columns stays far inside it. */
const FACT_CHUNK = 1_000;

/** Company facts carry no `md_lines`; the normaliser takes the empty map. */
const NO_LINES: ReadonlyMap<string, NormaliseLine> = new Map();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The standardisation inputs, indexed once
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Every `us-gaap` concept any standard item can reach — the read-back filter. */
export const MAPPED_CONCEPTS: readonly string[] = Object.freeze(
  [...new Set(XBRL_CONCEPT_MAP.flatMap((item) => item.concepts.map((c) => c.concept)))].sort(),
);

interface Chain {
  def: StatementLineDef;
  concepts: readonly { concept: string; sign: 1 | -1 }[];
}

/**
 * The catalogue joined to the concept map, in catalogue order, each chain sorted by `priority`.
 *
 * The join is checked rather than assumed: a standard item in one and not the other is a silent
 * hole in the income statement, and finding it at module load is cheaper than finding it in a
 * screenshot.
 */
const CHAINS: readonly Chain[] = (() => {
  const byItem = new Map(XBRL_CONCEPT_MAP.map((m) => [m.standardItem, m]));
  const chains: Chain[] = [];
  for (const def of statementLines) {
    const mapped = byItem.get(def.standardItem);
    if (mapped === undefined) {
      // FCF has no concept chain at all and GROSS_PROFIT has one; both are also computed.
      if (def.computed === undefined) {
        throw new Error(
          `fin_statements standard item '${def.standardItem}' has no XBRL_CONCEPT_MAP entry`,
        );
      }
      chains.push({ def, concepts: [] });
      continue;
    }
    if (mapped.statement !== def.statement) {
      throw new Error(
        `fin_statements standard item '${def.standardItem}' is ${def.statement} in the field ` +
          `catalogue and ${mapped.statement} in XBRL_CONCEPT_MAP`,
      );
    }
    const unit = mapped.unit ?? 'USD';
    if (unit !== def.unit) {
      throw new Error(
        `fin_statements standard item '${def.standardItem}' is read in ${def.unit} by the field ` +
          `catalogue and in ${unit} by XBRL_CONCEPT_MAP`,
      );
    }
    chains.push({
      def,
      concepts: [...mapped.concepts]
        .sort((a, b) =>
          a.priority !== b.priority ? a.priority - b.priority : a.concept < b.concept ? -1 : 1,
        )
        .map((c) => ({ concept: c.concept, sign: c.sign })),
    });
  }
  for (const mapped of XBRL_CONCEPT_MAP) {
    if (!statementLines.some((def) => def.standardItem === mapped.standardItem)) {
      throw new Error(
        `XBRL_CONCEPT_MAP item '${mapped.standardItem}' has no fin_statements column in the ` +
          'field catalogue (core/fields/defs/fundamental.ts)',
      );
    }
  }
  return chains;
})();

const chainByItem: ReadonlyMap<string, Chain> = new Map(CHAINS.map((c) => [c.def.standardItem, c]));

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Job context and result
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SecCompanyFactsJobContext extends MarketJobContext {
  /**
   * The CIKs to sweep, zero-padded. Omitted → every `issuers.cik` currently known, which is what
   * "index members daily, universe weekly" (§13) collapses to until WP-15 seeds the two tiers.
   */
  ciks?: readonly string[];
  /** Stop after this many CIKs; the stagger §13 asks for is the scheduler's, not the job's. */
  limit?: number;
  /** `false` ingests facts and skips standardisation — for a backfill that rebuilds it later. */
  buildStatements?: boolean;
}

export interface SecCompanyFactsResult extends MarketJobResult {
  /** CIKs whose capture was parsed this run. */
  ciks: number;
  /** `xbrl_facts` rows this run added. A second run over the same capture adds none. */
  factsInserted: number;
  /** `xbrl_facts` rows already present — the idempotence counter. */
  factsUnchanged: number;
  /** `fin_statements` rows this run added. */
  statementsInserted: number;
  statementsUnchanged: number;
  dqEventsWritten: number;
}

function emptyCompanyFactsResult(): SecCompanyFactsResult {
  return {
    ...emptyResult(),
    ciks: 0,
    factsInserted: 0,
    factsUnchanged: 0,
    statementsInserted: 0,
    statementsUnchanged: 0,
    dqEventsWritten: 0,
  };
}

function isReplayMiss(err: unknown): boolean {
  return err instanceof ReplayMissError || (err as { name?: string })?.name === 'ReplayMissError';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function runSecCompanyFacts(
  ctx: SecCompanyFactsJobContext,
): Promise<SecCompanyFactsResult> {
  const result = emptyCompanyFactsResult();
  await withIngestRun(
    ctx,
    { id: 'secCompanyFacts', sourceId: SEC_COMPANYFACTS_SOURCE_ID },
    async () => {
      const targets = await resolveCiks(ctx);
      for (const cik of targets) {
        const url = companyFactsUrl(cik);
        if (url === null) {
          result.errors.push({
            code: 'BAD_CIK',
            message: `'${cik}' is not a CIK`,
            requestKey: cik,
          });
          continue;
        }

        let raw: RawRecord;
        try {
          raw = await fetchThrough(
            ctx,
            secCompanyFactsAdapter,
            { cik, ...requestEnvelope(ctx) },
            url,
          );
        } catch (err) {
          if (isReplayMiss(err)) {
            result.skipped += 1;
            ctx.log?.info?.('secCompanyFacts.capture_unavailable', { cik, url });
            continue;
          }
          result.errors.push(fetchError(err, url));
          continue;
        }

        // §7.3: `cacheTtlMs 0` with `If-None-Match`; most daily polls revalidate and re-parse
        // nothing. A 304 publishes nothing, so it writes no provenance row either.
        if (raw.status === 304) {
          result.skipped += 1;
          continue;
        }

        // §7.3 "a response smaller than 100 KB for a CIK that previously returned megabytes →
        // poll_anomaly, nothing written". Measured against `provenance`, which is the only record
        // of what this request key has served before.
        if (await isPollAnomaly(ctx.tx, raw)) {
          result.skipped += 1;
          result.dqEventsWritten += await recordDqEvent(ctx.tx, {
            kind: 'poll_anomaly',
            severity: 'warn',
            sourceId: SEC_COMPANYFACTS_SOURCE_ID,
            subject: `cik:${cik}`,
            key: `${raw.requestKey}:${raw.body.length}`,
            details: { bytes: raw.body.length, url, reason: 'companyfacts payload shrank' },
          });
          continue;
        }

        result.fetched += 1;
        result.ciks += 1;

        const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
          raw,
          adapterVersion: SEC_ADAPTER_VERSION,
          lines: NO_LINES,
          normalise: (r, nctx) => secCompanyFactsAdapter.normalise(r, nctx),
        });
        result.provenanceIds.push(provenanceId);
        result.problems.push(...norm.problems);

        const issuerId = await resolveIssuerId(ctx.tx, cik);
        const counts = await insertFacts(ctx.tx, norm.rows.facts, { provenanceId, issuerId });
        result.factsInserted += counts.inserted;
        result.factsUnchanged += counts.unchanged;
        result.inserted += counts.inserted;
        result.skipped += counts.unchanged;

        if (issuerId === null) {
          ctx.log?.warn?.('secCompanyFacts.no_issuer', { cik });
          continue;
        }
        if (ctx.buildStatements === false) continue;

        const built = await buildAndStoreStatements(ctx, cik, issuerId);
        result.statementsInserted += built.inserted;
        result.statementsUnchanged += built.unchanged;
        result.inserted += built.inserted;
        result.skipped += built.unchanged;
        result.dqEventsWritten += built.dqEvents;
      }

      ctx.log?.info?.('secCompanyFacts.done', {
        ciks: result.ciks,
        factsInserted: result.factsInserted,
        factsUnchanged: result.factsUnchanged,
        statementsInserted: result.statementsInserted,
        mappingVersion: FIN_STATEMENTS_MAPPING_VERSION,
      });
      return result;
    },
  );
  return result;
}

/** The sweep set: what the caller named, else every CIK the security master knows. */
async function resolveCiks(ctx: SecCompanyFactsJobContext): Promise<string[]> {
  const named = ctx.ciks;
  const all =
    named !== undefined
      ? [...new Set(named)].sort()
      : (
          await ctx.tx.execute<{ cik: string }>(sql`
            SELECT DISTINCT cik FROM issuers
             WHERE tx_to = 'infinity' AND cik IS NOT NULL
             ORDER BY cik`)
        ).rows.map((r) => r.cik.trim());
  return ctx.limit === undefined ? all : all.slice(0, Math.max(0, ctx.limit));
}

/** `issuers.cik → issuer_id` on the current version. `null` when the master has no such issuer. */
export async function resolveIssuerId(tx: Tx, cik: string): Promise<number | null> {
  const rows = await tx.execute<{ issuer_id: string }>(sql`
    SELECT issuer_id FROM issuers
     WHERE tx_to = 'infinity' AND cik = ${cik}
     ORDER BY issuer_id
     LIMIT 1`);
  const row = rows.rows[0];
  return row === undefined ? null : Number(row.issuer_id);
}

/** §7.3's stale-CDN guard, read off `provenance` rather than off a remembered byte count. */
async function isPollAnomaly(tx: Tx, raw: RawRecord): Promise<boolean> {
  if (raw.body.length >= POLL_ANOMALY_FLOOR_BYTES) return false;
  const rows = await tx.execute<{ max_bytes: string | null }>(sql`
    SELECT max(bytes)::text AS max_bytes FROM provenance
     WHERE source_id = ${SEC_COMPANYFACTS_SOURCE_ID}
       AND request_key = ${raw.requestKey}
       AND http_status = 200`);
  const prior = rows.rows[0]?.max_bytes;
  return prior !== null && prior !== undefined && Number(prior) >= POLL_ANOMALY_PRIOR_BYTES;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `xbrl_facts`
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface FactWriteCounts {
  inserted: number;
  unchanged: number;
}

/**
 * Append the facts that are not already stored.
 *
 * `ON CONFLICT DO NOTHING` with no target, because the natural key is a partial expression index
 * (`COALESCE(period_start, '0001-01-01')`) that `ON CONFLICT (…)` cannot name; the table has one
 * other unique index, its identity primary key, which a fresh insert can never collide on.
 * `RETURNING fact_id` counts what actually landed — a boolean would happily report success for a
 * statement that inserted nothing (QA-02).
 */
export async function insertFacts(
  tx: Tx,
  facts: readonly XbrlFactRow[],
  meta: { provenanceId: number; issuerId: number | null },
): Promise<FactWriteCounts> {
  let inserted = 0;
  for (let i = 0; i < facts.length; i += FACT_CHUNK) {
    const chunk = facts.slice(i, i + FACT_CHUNK);
    const values = chunk.map(
      (f) => sql`(${f.cik}, ${meta.issuerId}::bigint, ${f.taxonomy}, ${f.concept}, ${f.unit},
                  ${f.periodStart}::date, ${f.periodEnd}::date, ${f.fy}::smallint, ${f.fp},
                  ${f.form}, ${f.accessionNo}, ${f.filedAt}::date, ${f.frame},
                  ${f.value}::numeric, ${meta.provenanceId}::bigint)`,
    );
    const rows = await tx.execute<{ fact_id: string }>(sql`
      INSERT INTO xbrl_facts
        (cik, issuer_id, taxonomy, concept, unit, period_start, period_end, fy, fp, form,
         accession_no, filed_at, frame, value, provenance_id)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT DO NOTHING
      RETURNING fact_id`);
    inserted += rows.rows.length;
  }
  return { inserted, unchanged: facts.length - inserted };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `fin_statements` — the standardisation (§7.3.1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `xbrl_facts` row as the builder reads it back. */
export interface StoredFact {
  factId: number;
  concept: string;
  unit: string;
  periodStart: string | null;
  periodEnd: string;
  fy: number | null;
  fp: string | null;
  form: string;
  accessionNo: string;
  filedAt: string;
  value: number;
  provenanceId: number;
}

/** One `as_reported` entry — `{concept, value, fact_id}`, `fact_id` null for a computed item. */
export interface AsReportedEntry {
  concept: string;
  value: number;
  fact_id: number | null;
}

/** One `fin_statements` row, before it is written. */
export interface StatementRow {
  issuerId: number;
  periodEnd: string;
  periodType: 'Q' | 'FY';
  filedAt: string;
  mappingVersion: string;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  accessionNo: string;
  currency: string;
  derivedQ4: boolean;
  /** standard item → signed value in the item's own unit. Absent = NULL, never `0`. */
  values: Map<string, number>;
  asReported: Record<string, AsReportedEntry>;
  provenanceIds: number[];
  inputsHash: string;
}

const DAY_MS = 86_400_000;

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
}

/** `period_type` for a duration: only quarters and annuals become statements (§7.3). */
function periodTypeOf(start: string, end: string): 'Q' | 'FY' | null {
  const cls = durationClass(daysBetween(start, end));
  return cls === 'quarter' ? 'Q' : cls === 'annual' ? 'FY' : null;
}

/**
 * Build every `(period, filing)` statement this CIK's stored facts support, then write the ones
 * that are not already there.
 *
 * The facts are read back from `xbrl_facts` rather than taken from the parse, for two reasons that
 * both matter: `as_reported.fact_id` does not exist until the row is written, and an incremental
 * run must standardise against everything stored for the issuer, not just what this capture added.
 */
async function buildAndStoreStatements(
  ctx: SecCompanyFactsJobContext,
  cik: string,
  issuerId: number,
): Promise<{ inserted: number; unchanged: number; dqEvents: number }> {
  const facts = await readMappedFacts(ctx.tx, cik);
  const rows = buildStatements(facts, issuerId);
  const written = await insertStatements(ctx.tx, rows);
  const dqEvents = await crossCheck(ctx, rows);
  return { ...written, dqEvents };
}

/** Every stored fact any standard item can reach, in a fixed order. */
export async function readMappedFacts(tx: Tx, cik: string): Promise<StoredFact[]> {
  const result = await tx.execute<{
    fact_id: string;
    concept: string;
    unit: string;
    period_start: string | null;
    period_end: string;
    fy: number | null;
    fp: string | null;
    form: string;
    accession_no: string;
    filed_at: string;
    value: string;
    provenance_id: string;
  }>(sql`
    SELECT fact_id, concept, unit, period_start::text, period_end::text, fy, fp, form,
           accession_no, filed_at::text, value::text, provenance_id
      FROM xbrl_facts
     WHERE cik = ${cik}
       AND taxonomy = 'us-gaap'
       AND concept = ANY(${sql`ARRAY[${sql.join(
         MAPPED_CONCEPTS.map((c) => sql`${c}`),
         sql`, `,
       )}]::text[]`})
     ORDER BY fact_id`);
  return result.rows.map((r) => ({
    factId: Number(r.fact_id),
    concept: r.concept,
    unit: r.unit,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    fy: r.fy === null ? null : Number(r.fy),
    fp: r.fp,
    form: r.form,
    accessionNo: r.accession_no.trim(),
    filedAt: r.filed_at,
    value: Number(r.value),
    provenanceId: Number(r.provenance_id),
  }));
}

interface PeriodKey {
  start: string | null;
  end: string;
  type: 'Q' | 'FY';
}

/**
 * The standardisation, as a pure function of the stored facts (§7.3.1).
 *
 * Exported so the replay test can assert on the rows without a database in the way, and so a
 * future re-standardisation under a new `mapping_version` can be written from the same code.
 */
export function buildStatements(facts: readonly StoredFact[], issuerId: number): StatementRow[] {
  // ── group by filing ────────────────────────────────────────────────────────────────────────
  const byAccession = new Map<string, StoredFact[]>();
  for (const fact of facts) {
    const list = byAccession.get(fact.accessionNo);
    if (list === undefined) byAccession.set(fact.accessionNo, [fact]);
    else list.push(fact);
  }

  const rows: StatementRow[] = [];
  for (const accession of [...byAccession.keys()].sort()) {
    const filing = byAccession.get(accession) ?? [];
    // `filed` is a property of the filing, so every fact of an accession carries the same one;
    // the minimum is taken rather than the first so a malformed payload cannot make the row's
    // `filed_at` depend on iteration order.
    const filedAt = filing.map((f) => f.filedAt).sort()[0];
    if (filedAt === undefined) continue;

    const periods = new Map<string, PeriodKey>();
    for (const fact of filing) {
      if (fact.periodStart === null) continue;
      const type = periodTypeOf(fact.periodStart, fact.periodEnd);
      if (type === null) continue;
      periods.set(`${fact.periodStart}|${fact.periodEnd}`, {
        start: fact.periodStart,
        end: fact.periodEnd,
        type,
      });
    }

    for (const key of [...periods.keys()].sort()) {
      const period = periods.get(key);
      if (period === undefined) continue;
      const row = buildRow(filing, period, { issuerId, accession, filedAt, derivedQ4: false });
      if (row !== null) rows.push(row);
    }
  }

  rows.push(...deriveQ4(rows, byAccession));
  rows.sort((a, b) =>
    a.periodEnd < b.periodEnd
      ? -1
      : a.periodEnd > b.periodEnd
        ? 1
        : a.periodType < b.periodType
          ? -1
          : a.periodType > b.periodType
            ? 1
            : a.filedAt < b.filedAt
              ? -1
              : a.filedAt > b.filedAt
                ? 1
                : 0,
  );
  return rows;
}

/** One period of one filing: walk every chain, then compute the two derived items. */
function buildRow(
  filing: readonly StoredFact[],
  period: PeriodKey,
  meta: { issuerId: number; accession: string; filedAt: string; derivedQ4: boolean },
): StatementRow | null {
  const values = new Map<string, number>();
  const asReported: Record<string, AsReportedEntry> = {};
  const provenanceIds = new Set<number>();
  const used: StoredFact[] = [];

  for (const chain of CHAINS) {
    if (chain.concepts.length === 0) continue;
    for (const rung of chain.concepts) {
      const fact = pickFact(filing, chain.def, rung.concept, period);
      if (fact === undefined) continue;
      values.set(chain.def.standardItem, fact.value * rung.sign);
      asReported[chain.def.standardItem] = {
        concept: rung.concept,
        value: fact.value,
        fact_id: fact.factId,
      };
      provenanceIds.add(fact.provenanceId);
      used.push(fact);
      break;
    }
  }

  applyComputed(values, asReported);
  if (values.size === 0) return null;

  // `fy`/`fp` are properties of the filing's own view of the period, so they are read off the
  // facts that actually produced the row — in catalogue order, so the answer does not depend on
  // which concept happened to be tagged first in the payload.
  const anchor = used.find((f) => f.fy !== null) ?? used[0];
  return {
    issuerId: meta.issuerId,
    periodEnd: period.end,
    periodType: period.type,
    filedAt: meta.filedAt,
    mappingVersion: FIN_STATEMENTS_MAPPING_VERSION,
    fiscalYear: anchor?.fy ?? null,
    fiscalPeriod: anchor?.fp ?? null,
    accessionNo: meta.accession,
    currency: 'USD',
    derivedQ4: meta.derivedQ4,
    values,
    asReported,
    provenanceIds: [...provenanceIds].sort((a, b) => a - b),
    inputsHash: hashInputs(meta.issuerId, period, meta.filedAt, asReported, meta.derivedQ4),
  };
}

/**
 * The fact a standard item takes from this filing for this period.
 *
 * A balance-sheet item is an **instant** at the period end (`period_start IS NULL`); an
 * income-statement or cash-flow item is the period's own **duration**. Confusing the two is how a
 * balance sheet ends up reporting a quarter's cash flow.
 */
function pickFact(
  filing: readonly StoredFact[],
  def: StatementLineDef,
  concept: string,
  period: PeriodKey,
): StoredFact | undefined {
  for (const fact of filing) {
    if (fact.concept !== concept || fact.unit !== def.unit) continue;
    if (def.instant) {
      if (fact.periodStart === null && fact.periodEnd === period.end) return fact;
    } else if (fact.periodStart === period.start && fact.periodEnd === period.end) {
      return fact;
    }
  }
  return undefined;
}

/** §7.3.1's two computed items, recorded as `computed:…` with no `fact_id`. */
function applyComputed(
  values: Map<string, number>,
  asReported: Record<string, AsReportedEntry>,
): void {
  const grossProfit = chainByItem.get('GROSS_PROFIT');
  if (grossProfit !== undefined && !values.has('GROSS_PROFIT')) {
    const revenue = values.get('REVENUE');
    const cogs = values.get('COGS');
    if (revenue !== undefined && cogs !== undefined) {
      values.set('GROSS_PROFIT', revenue - cogs);
      asReported.GROSS_PROFIT = {
        concept: grossProfit.def.computed ?? 'computed:REVENUE-COGS',
        value: revenue - cogs,
        fact_id: null,
      };
    }
  }
  const fcf = chainByItem.get('FCF');
  const cfo = values.get('CFO');
  const capex = values.get('CAPEX');
  if (fcf !== undefined && cfo !== undefined && capex !== undefined) {
    const value = cfo - Math.abs(capex);
    values.set('FCF', value);
    asReported.FCF = {
      concept: fcf.def.computed ?? 'computed:CFO-ABS(CAPEX)',
      value,
      fact_id: null,
    };
  }
}

/**
 * `Q4 = FY − (Q1 + Q2 + Q3)`, at the knowledge state of the 10-K that reported the year.
 *
 * The three quarters are the versions whose `filed_at` is at or before the annual filing's, which
 * is the only choice that keeps the derived row point-in-time: a Q4 computed from a restatement
 * filed six months later is a number nobody could have produced on the day, and it would make the
 * PIT read return a value that never existed.
 *
 * `SHARES_DIL` is excluded: a weighted-average share count is not additive over sub-periods. The
 * per-share flows (`EPS_BASIC`, `EPS_DIL`, `DPS`) are, and are derived.
 */
function deriveQ4(
  rows: readonly StatementRow[],
  byAccession: ReadonlyMap<string, readonly StoredFact[]>,
): StatementRow[] {
  const quarters = rows.filter((r) => r.periodType === 'Q');
  const derived: StatementRow[] = [];

  for (const annual of rows.filter((r) => r.periodType === 'FY')) {
    // Already reported as a quarter by the same filing? Then there is nothing to derive.
    if (quarters.some((q) => q.periodEnd === annual.periodEnd && q.filedAt === annual.filedAt)) {
      continue;
    }
    const filing = byAccession.get(annual.accessionNo) ?? [];
    const annualStart = filing.find(
      (f) => f.periodEnd === annual.periodEnd && f.periodStart !== null,
    )?.periodStart;
    if (annualStart === undefined || annualStart === null) continue;

    // The fiscal year's own first three quarters, each at its newest version already public when
    // the 10-K was filed.
    const candidates = new Map<string, StatementRow>();
    for (const q of quarters) {
      if (q.periodEnd <= annualStart || q.periodEnd >= annual.periodEnd) continue;
      if (q.filedAt > annual.filedAt) continue;
      const best = candidates.get(q.periodEnd);
      if (best === undefined || q.filedAt > best.filedAt) candidates.set(q.periodEnd, q);
    }
    if (candidates.size !== 3) continue;
    const priors = [...candidates.values()];

    const values = new Map<string, number>();
    const asReported: Record<string, AsReportedEntry> = {};
    const provenanceIds = new Set<number>(annual.provenanceIds);

    for (const chain of CHAINS) {
      const item = chain.def.standardItem;
      if (item === 'SHARES_DIL') continue;
      if (chain.def.instant) {
        // The balance sheet at the fiscal-year end *is* the Q4 balance sheet: same instant, same
        // facts, same `fact_id`s — carried across rather than differenced.
        const fy = annual.values.get(item);
        const reported = annual.asReported[item];
        if (fy !== undefined && reported !== undefined) {
          values.set(item, fy);
          asReported[item] = reported;
        }
        continue;
      }
      // `FCF` is never differenced: `applyComputed` rebuilds it from the derived `CFO` and
      // `CAPEX` below, so the identity `FCF = CFO − |CAPEX|` holds in the Q4 row as it does in
      // every other. `GROSS_PROFIT` *is* differenced when the year and all three quarters tagged
      // it, and falls back to `REVENUE − COGS` when they did not.
      if (item === 'FCF') continue;
      const fy = annual.values.get(item);
      if (fy === undefined) continue;
      let sum = 0;
      let complete = true;
      for (const prior of priors) {
        const v = prior.values.get(item);
        if (v === undefined) {
          complete = false;
          break;
        }
        sum += v;
        for (const id of prior.provenanceIds) provenanceIds.add(id);
      }
      if (!complete) continue;
      const value = round(fy - sum, chain.def.scale);
      values.set(item, value);
      asReported[item] = {
        concept: `computed:FY-(Q1+Q2+Q3):${annual.asReported[item]?.concept ?? item}`,
        value,
        fact_id: null,
      };
    }

    applyComputed(values, asReported);
    if (values.size === 0) continue;

    derived.push({
      issuerId: annual.issuerId,
      periodEnd: annual.periodEnd,
      periodType: 'Q',
      filedAt: annual.filedAt,
      mappingVersion: FIN_STATEMENTS_MAPPING_VERSION,
      fiscalYear: annual.fiscalYear,
      fiscalPeriod: 'Q4',
      accessionNo: annual.accessionNo,
      currency: annual.currency,
      derivedQ4: true,
      values,
      asReported,
      provenanceIds: [...provenanceIds].sort((a, b) => a - b),
      inputsHash: hashInputs(
        annual.issuerId,
        { start: annualStart, end: annual.periodEnd, type: 'Q' },
        annual.filedAt,
        asReported,
        true,
      ),
    });
  }
  return derived;
}

/** Decimal rounding at the column's own scale, so a float's tail never reaches Postgres. */
function round(value: number, scale: number): number {
  return Number(value.toFixed(scale));
}

/**
 * ANAL-08 `inputs_hash`: sha256 over exactly what produced the row, in a canonical order.
 *
 * `as_reported` is the input set — it names every fact that was read, by id and by value — so a
 * changed concept chain, a changed fact or a changed derivation all move the hash, and nothing
 * else does.
 */
function hashInputs(
  issuerId: number,
  period: PeriodKey,
  filedAt: string,
  asReported: Record<string, AsReportedEntry>,
  derivedQ4: boolean,
): string {
  const canonical = {
    engine: FIN_STATEMENTS_ENGINE,
    engineVersion: FIN_STATEMENTS_ENGINE_VERSION,
    mappingVersion: FIN_STATEMENTS_MAPPING_VERSION,
    issuerId,
    periodStart: period.start,
    periodEnd: period.end,
    periodType: period.type,
    filedAt,
    derivedQ4,
    items: Object.keys(asReported)
      .sort()
      .map((item) => {
        const entry = asReported[item];
        return [item, entry?.concept ?? '', entry?.value ?? null, entry?.fact_id ?? null];
      }),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Write the rows that are not already stored. A re-run collides on the primary key and adds none. */
export async function insertStatements(
  tx: Tx,
  rows: readonly StatementRow[],
): Promise<{ inserted: number; unchanged: number }> {
  let inserted = 0;
  for (const row of rows) {
    const value = (item: string): string | null => {
      const v = row.values.get(item);
      if (v === undefined || !Number.isFinite(v)) return null;
      const def = chainByItem.get(item);
      return v.toFixed(def?.def.scale ?? 2);
    };
    const written = await tx.execute<{ issuer_id: string }>(sql`
      INSERT INTO fin_statements
        (issuer_id, period_end, period_type, filed_at, mapping_version, fiscal_year,
         fiscal_period, accession_no, currency, revenue, cogs, gross_profit, opex, rnd, oper_inc,
         int_exp, pretax_inc, tax, net_inc, eps_basic, eps_dil, shares_dil, tot_assets, tot_liab,
         equity, cash, lt_debt, cfo, capex, fcf, div_paid, buyback, dps, dda, derived_q4,
         as_reported, engine_name, engine_version, inputs_hash, provenance_ids)
      VALUES (
        ${row.issuerId}::bigint, ${row.periodEnd}::date, ${row.periodType}, ${row.filedAt}::date,
        ${row.mappingVersion}, ${row.fiscalYear}::smallint, ${row.fiscalPeriod},
        ${row.accessionNo}, ${row.currency},
        ${value('REVENUE')}::numeric, ${value('COGS')}::numeric, ${value('GROSS_PROFIT')}::numeric,
        ${value('OPEX')}::numeric, ${value('RND')}::numeric, ${value('OPER_INC')}::numeric,
        ${value('INT_EXP')}::numeric, ${value('PRETAX_INC')}::numeric, ${value('TAX')}::numeric,
        ${value('NET_INC')}::numeric, ${value('EPS_BASIC')}::numeric, ${value('EPS_DIL')}::numeric,
        ${value('SHARES_DIL')}::numeric, ${value('TOT_ASSETS')}::numeric,
        ${value('TOT_LIAB')}::numeric, ${value('EQUITY')}::numeric, ${value('CASH')}::numeric,
        ${value('LT_DEBT')}::numeric, ${value('CFO')}::numeric, ${value('CAPEX')}::numeric,
        ${value('FCF')}::numeric, ${value('DIV_PAID')}::numeric, ${value('BUYBACK')}::numeric,
        ${value('DPS')}::numeric, ${value('DDA')}::numeric, ${row.derivedQ4},
        ${JSON.stringify(row.asReported)}::jsonb, ${FIN_STATEMENTS_ENGINE},
        ${FIN_STATEMENTS_ENGINE_VERSION}, ${row.inputsHash},
        ${sql`ARRAY[${sql.join(
          row.provenanceIds.map((id) => sql`${id}::bigint`),
          sql`, `,
        )}]::bigint[]`})
      ON CONFLICT (issuer_id, period_end, period_type, filed_at, mapping_version) DO NOTHING
      RETURNING issuer_id`);
    inserted += written.rows.length;
  }
  return { inserted, unchanged: rows.length - inserted };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §7.3's three cross-checks — `reconcile_mismatch`, severity `warn`, never blocking
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Relative tolerances of §7.3. */
export const BALANCE_TOLERANCE = 0.005;
export const GROSS_PROFIT_TOLERANCE = 0.005;
export const NET_INCOME_TOLERANCE = 0.01;

function offBy(actual: number, expected: number, tolerance: number): boolean {
  const scale = Math.max(Math.abs(actual), Math.abs(expected));
  if (scale === 0) return false;
  return Math.abs(actual - expected) / scale > tolerance;
}

/**
 * The three identity checks, run on the newest version of each period only.
 *
 * Every superseded version of a period would raise the same warning again, one row per historical
 * filing, and the desk cannot act on a 2019 balance sheet that has since been restated. What
 * matters is whether what we serve *today* adds up.
 */
async function crossCheck(
  ctx: SecCompanyFactsJobContext,
  rows: readonly StatementRow[],
): Promise<number> {
  const newest = new Map<string, StatementRow>();
  for (const row of rows) {
    const key = `${row.periodEnd}|${row.periodType}`;
    const best = newest.get(key);
    if (best === undefined || row.filedAt > best.filedAt) newest.set(key, row);
  }

  let written = 0;
  for (const key of [...newest.keys()].sort()) {
    const row = newest.get(key);
    if (row === undefined) continue;
    const checks: { check: string; actual: number; expected: number; tolerance: number }[] = [];

    const assets = row.values.get('TOT_ASSETS');
    const liabilities = row.values.get('TOT_LIAB');
    const equity = row.values.get('EQUITY');
    if (assets !== undefined && liabilities !== undefined && equity !== undefined) {
      checks.push({
        check: 'TOT_ASSETS=TOT_LIAB+EQUITY',
        actual: assets,
        expected: liabilities + equity,
        tolerance: BALANCE_TOLERANCE,
      });
    }

    // Only when the issuer tagged all three: a `GROSS_PROFIT` this module computed from
    // `REVENUE − COGS` agrees with itself by construction and warning about it would be noise.
    const grossProfit = row.values.get('GROSS_PROFIT');
    const revenue = row.values.get('REVENUE');
    const cogs = row.values.get('COGS');
    if (
      grossProfit !== undefined &&
      revenue !== undefined &&
      cogs !== undefined &&
      row.asReported.GROSS_PROFIT?.fact_id != null
    ) {
      checks.push({
        check: 'GROSS_PROFIT=REVENUE-COGS',
        actual: grossProfit,
        expected: revenue - cogs,
        tolerance: GROSS_PROFIT_TOLERANCE,
      });
    }

    const netInc = row.values.get('NET_INC');
    const pretax = row.values.get('PRETAX_INC');
    const tax = row.values.get('TAX');
    if (netInc !== undefined && pretax !== undefined && tax !== undefined) {
      checks.push({
        check: 'NET_INC=PRETAX_INC-TAX',
        actual: netInc,
        expected: pretax - tax,
        tolerance: NET_INCOME_TOLERANCE,
      });
    }

    for (const c of checks) {
      if (!offBy(c.actual, c.expected, c.tolerance)) continue;
      written += await recordDqEvent(ctx.tx, {
        kind: 'reconcile_mismatch',
        severity: 'warn',
        sourceId: SEC_COMPANYFACTS_SOURCE_ID,
        subject: `issuer:${row.issuerId}`,
        key: `${row.periodEnd}:${row.periodType}:${row.filedAt}:${c.check}`,
        details: {
          check: c.check,
          actual: c.actual,
          expected: c.expected,
          periodEnd: row.periodEnd,
          periodType: row.periodType,
          filedAt: row.filedAt,
          mappingVersion: row.mappingVersion,
        },
      });
    }
  }
  return written;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The scheduler row
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** PROVIDERS §13; `IngestJob.id` is this module's basename. */
export const job = {
  id: 'secCompanyFacts',
  schedule: SEC_COMPANYFACTS_SCHEDULE,
  provider: SEC_COMPANYFACTS_SOURCE_ID,
  priority: 2 as const,
  timeoutMs: 900_000,
  run: (ctx: SecCompanyFactsJobContext): Promise<SecCompanyFactsResult> => runSecCompanyFacts(ctx),
};
