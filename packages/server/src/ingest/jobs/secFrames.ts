/**
 * `ingest/jobs/secFrames.ts` — the cross-sectional cut EQS screens over.
 *
 * PROVIDERS §7.4, §13 row `secFrames`, WORKPLAN §WP-10 L1234.
 *
 * One request per `(concept, unit, frame)`: twenty screening concepts × the last eight quarters,
 * about 160 requests at 7 req/s, weekly on Sunday at 03:00 ET. **Never fetched interactively** —
 * EQS reads `xbrl_frames`, and the whole point of this table is that a screen over six thousand
 * filers is a single index scan rather than six thousand HTTP requests.
 *
 * Three things about a frame that a fact is not, and all three are in the writes below:
 *
 *  1. **A frame carries no filed date.** SEC publishes `{accn, cik, entityName, loc, end, val}` and
 *     nothing that says when it became public, so `xbrl_frames.filed_at` is nullable and is
 *     back-filled from the matching `xbrl_facts` row when we happen to hold one. A frame is
 *     therefore **never** the point-in-time source (§7.4); `data/fundamentals.ts#frames` returns
 *     `filedAt: null` for the rest so the caller can raise `FRAMES_NOT_POINT_IN_TIME` rather than
 *     silently screen on knowledge nobody had.
 *  2. **Most of the population is outside our universe.** `issuer_id` resolves for the filers the
 *     security master knows and stays NULL for the rest, and the rest are **kept**: a percentile
 *     rank computed against the 504 names we follow is not the percentile SEC's own data supports,
 *     and EQS says "top decile of US filers", not "top decile of our watchlist".
 *  3. **A re-run is an upsert.** The primary key is `(taxonomy, concept, unit, frame, cik)`, one
 *     row per filer per period, so the weekly job converges instead of accumulating. The update is
 *     conditional on the content actually changing, which is what makes "the second run writes
 *     nothing" a row count rather than a hope.
 *
 * **A 404 is expected**, not a failure: the current quarter does not exist until SEC assembles it.
 * It is counted in `skipped` and never touches the breaker. In replay a capture the store does not
 * hold is the same thing said differently, and is counted the same way.
 */

import { sql } from 'drizzle-orm';

import { framesUrl, secFramesAdapter } from '../../providers/sec/adapter.js';
import { SEC_ADAPTER_VERSION } from '../../providers/sec/parse.js';
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
import { zonedParts } from '../scheduler.js';

import type { Tx } from '../../db/client.js';
import type { MarketJobContext, MarketJobResult } from './cboeQuotes.js';
import type { NormaliseLine, ProviderId, RawRecord } from '../../providers/types.js';
import type { XbrlFrameRow } from '../../providers/sec/parse.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The scheduler row (PROVIDERS §13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** §13: `'0 3 * * 0'` — Sunday 03:00 America/New_York. */
export const SEC_FRAMES_SCHEDULE = '0 3 * * 0';
export const SEC_FRAMES_SOURCE_ID = 'sec.frames' satisfies ProviderId;

/** §7.4: "~20 EQS concepts × last 8 frames". */
export const SEC_FRAMES_QUARTERS = 8;

/** §7.4's `poll_anomaly` floor for a concept the whole market tags. */
export const FRAMES_MIN_POINTS = 1_000;

/** Frames carry no `md_lines`. */
const NO_LINES: ReadonlyMap<string, NormaliseLine> = new Map();

/** Postgres caps a statement at 65 535 bind parameters; 300 × 9 columns stays well inside it. */
const FRAME_CHUNK = 300;

/** One screening series: the concept, the unit its values are in, and whether it is an instant. */
export interface FrameConcept {
  concept: string;
  unit: 'USD' | 'USD/shares' | 'shares';
  /** Balance-sheet concepts are instants and their frame label carries the trailing `I`. */
  instant: boolean;
}

/**
 * The twenty concepts EQS screens on, drawn from the primary rung of each `XBRL_CONCEPT_MAP`
 * chain: a screen ranks on what most filers tag, and the fallback rungs exist for the ones that
 * do not, which is precisely the population a cross-section cannot rank against.
 */
export const EQS_FRAME_CONCEPTS: readonly FrameConcept[] = Object.freeze([
  { concept: 'Assets', unit: 'USD', instant: true },
  { concept: 'Liabilities', unit: 'USD', instant: true },
  { concept: 'StockholdersEquity', unit: 'USD', instant: true },
  { concept: 'CashAndCashEquivalentsAtCarryingValue', unit: 'USD', instant: true },
  { concept: 'LongTermDebtNoncurrent', unit: 'USD', instant: true },
  { concept: 'Revenues', unit: 'USD', instant: false },
  { concept: 'RevenueFromContractWithCustomerExcludingAssessedTax', unit: 'USD', instant: false },
  { concept: 'CostOfGoodsAndServicesSold', unit: 'USD', instant: false },
  { concept: 'GrossProfit', unit: 'USD', instant: false },
  { concept: 'ResearchAndDevelopmentExpense', unit: 'USD', instant: false },
  { concept: 'OperatingIncomeLoss', unit: 'USD', instant: false },
  { concept: 'InterestExpense', unit: 'USD', instant: false },
  { concept: 'IncomeTaxExpenseBenefit', unit: 'USD', instant: false },
  { concept: 'NetIncomeLoss', unit: 'USD', instant: false },
  { concept: 'NetCashProvidedByUsedInOperatingActivities', unit: 'USD', instant: false },
  { concept: 'PaymentsToAcquirePropertyPlantAndEquipment', unit: 'USD', instant: false },
  { concept: 'PaymentsForRepurchaseOfCommonStock', unit: 'USD', instant: false },
  { concept: 'PaymentsOfDividendsCommonStock', unit: 'USD', instant: false },
  { concept: 'DepreciationDepletionAndAmortization', unit: 'USD', instant: false },
  { concept: 'EarningsPerShareDiluted', unit: 'USD/shares', instant: false },
] as FrameConcept[]);

/**
 * The last `count` **completed** calendar quarters at `atMs`, newest first, as SEC labels them.
 *
 * The quarter the clock is standing in is excluded: SEC assembles a frame only after the filings
 * that make it up have arrived, and asking for the current one is the expected 404 of §7.4. An
 * instant frame carries the trailing `I` (`CY2024Q4I`); a duration frame does not (`CY2024Q4`).
 */
export function recentFrames(atMs: number, count: number, instant: boolean): string[] {
  const parts = zonedParts(atMs, 'UTC');
  // The quarter containing `atMs`, then step back one to the newest completed quarter.
  let year = parts.year;
  let quarter = Math.floor((parts.month - 1) / 3) + 1;
  const labels: string[] = [];
  for (let i = 0; i < count; i += 1) {
    quarter -= 1;
    if (quarter === 0) {
      quarter = 4;
      year -= 1;
    }
    labels.push(`CY${String(year)}Q${String(quarter)}${instant ? 'I' : ''}`);
  }
  return labels;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Job context and result
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One request this job makes. */
export interface FrameTarget {
  taxonomy: string;
  concept: string;
  unit: string;
  frame: string;
}

export interface SecFramesJobContext extends MarketJobContext {
  /** Exactly these `(concept, unit, frame)` triples; omitted → {@link EQS_FRAME_CONCEPTS} × 8. */
  targets?: readonly FrameTarget[];
  /** How many completed quarters to sweep. Default {@link SEC_FRAMES_QUARTERS}. */
  quarters?: number;
}

export interface SecFramesResult extends MarketJobResult {
  /** Frames whose capture was parsed this run. */
  frames: number;
  /** Frames the source does not have yet — §7.4's expected 404. */
  framesAbsent: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  /** `filed_at` values back-filled from a matching `xbrl_facts` row. */
  filedAtBackfilled: number;
  dqEventsWritten: number;
}

function emptyFramesResult(): SecFramesResult {
  return {
    ...emptyResult(),
    frames: 0,
    framesAbsent: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsUnchanged: 0,
    filedAtBackfilled: 0,
    dqEventsWritten: 0,
  };
}

function isReplayMiss(err: unknown): boolean {
  return err instanceof ReplayMissError || (err as { name?: string })?.name === 'ReplayMissError';
}

/** The default sweep: every screening concept over the last `quarters` completed quarters. */
export function defaultTargets(atMs: number, quarters: number): FrameTarget[] {
  const targets: FrameTarget[] = [];
  for (const series of EQS_FRAME_CONCEPTS) {
    for (const frame of recentFrames(atMs, quarters, series.instant)) {
      targets.push({ taxonomy: 'us-gaap', concept: series.concept, unit: series.unit, frame });
    }
  }
  return targets;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function runSecFrames(ctx: SecFramesJobContext): Promise<SecFramesResult> {
  const result = emptyFramesResult();
  await withIngestRun(ctx, { id: 'secFrames', sourceId: SEC_FRAMES_SOURCE_ID }, async () => {
    const targets =
      ctx.targets ?? defaultTargets(ctx.clock.now(), ctx.quarters ?? SEC_FRAMES_QUARTERS);

    for (const target of targets) {
      const url = framesUrl(target.concept, target.unit, target.frame, target.taxonomy);
      if (url === null) {
        result.errors.push({
          code: 'BAD_FRAME',
          message: `(${target.concept}, ${target.unit}, ${target.frame}) is not a frame`,
        });
        continue;
      }

      let raw: RawRecord;
      try {
        raw = await fetchThrough(
          ctx,
          secFramesAdapter,
          { ...target, ...requestEnvelope(ctx) },
          url,
        );
      } catch (err) {
        if (isReplayMiss(err)) {
          result.framesAbsent += 1;
          result.skipped += 1;
          ctx.log?.info?.('secFrames.frame_unavailable', { ...target, url });
          continue;
        }
        result.errors.push(fetchError(err, url));
        continue;
      }

      if (raw.status === 304) {
        result.skipped += 1;
        continue;
      }
      // §7.4: the current quarter before SEC assembles it. Expected, swallowed, never a failure.
      if (raw.status === 404) {
        result.framesAbsent += 1;
        result.skipped += 1;
        continue;
      }

      result.fetched += 1;
      result.frames += 1;

      const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
        raw,
        adapterVersion: SEC_ADAPTER_VERSION,
        lines: NO_LINES,
        normalise: (r, nctx) => secFramesAdapter.normalise(r, nctx),
      });
      result.provenanceIds.push(provenanceId);
      result.problems.push(...norm.problems);

      // The parser drops a payload whose `pts` disagrees with `data.length` (`schema_drift`), so
      // an empty row set here is either that or a genuinely empty frame; neither is written.
      if (norm.rows.frames.length === 0) {
        result.skipped += 1;
        continue;
      }
      if (norm.rows.pts < FRAMES_MIN_POINTS) {
        result.dqEventsWritten += await recordDqEvent(ctx.tx, {
          kind: 'poll_anomaly',
          severity: 'warn',
          sourceId: SEC_FRAMES_SOURCE_ID,
          subject: `frame:${target.concept}:${target.frame}`,
          key: `${target.unit}:${String(norm.rows.pts)}`,
          details: { ...target, pts: norm.rows.pts, url, floor: FRAMES_MIN_POINTS },
        });
      }

      const counts = await upsertFrames(ctx.tx, norm.rows.frames, provenanceId);
      result.rowsInserted += counts.inserted;
      result.rowsUpdated += counts.updated;
      result.rowsUnchanged += counts.unchanged;
      result.inserted += counts.inserted;
      result.updated += counts.updated;
      result.skipped += counts.unchanged;

      result.filedAtBackfilled += await backfillFiledAt(ctx.tx, target);
      result.dqEventsWritten += await checkEntityNames(ctx, target, norm.rows.frames);
    }

    ctx.log?.info?.('secFrames.done', {
      frames: result.frames,
      absent: result.framesAbsent,
      rowsInserted: result.rowsInserted,
      rowsUpdated: result.rowsUpdated,
      filedAtBackfilled: result.filedAtBackfilled,
    });
    return result;
  });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `xbrl_frames`
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface FrameWriteCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

/**
 * Upsert one frame's rows, touching only the ones whose value or accession actually changed.
 *
 * `entityName` is deliberately not stored — §7.4 drops it — so it takes part in no comparison
 * here; it is cross-checked against `issuers.name` separately, where a disagreement becomes a
 * `reconcile_mismatch` rather than a silent rename of a company.
 */
export async function upsertFrames(
  tx: Tx,
  frames: readonly XbrlFrameRow[],
  provenanceId: number,
): Promise<FrameWriteCounts> {
  // One row per CIK per frame is the primary key, so a payload that named a filer twice would
  // raise `ON CONFLICT DO UPDATE command cannot affect row a second time`. Last spelling wins.
  const deduped = new Map<string, XbrlFrameRow>();
  for (const frame of frames) {
    deduped.set(
      `${frame.taxonomy}|${frame.concept}|${frame.unit}|${frame.frame}|${frame.cik}`,
      frame,
    );
  }
  const rows = [...deduped.values()].sort((a, b) => (a.cik < b.cik ? -1 : a.cik > b.cik ? 1 : 0));

  const counts: FrameWriteCounts = { inserted: 0, updated: 0, unchanged: 0 };
  for (let i = 0; i < rows.length; i += FRAME_CHUNK) {
    const chunk = rows.slice(i, i + FRAME_CHUNK);
    const values = chunk.map(
      (f) => sql`(${f.taxonomy}, ${f.concept}, ${f.unit}, ${f.frame}, ${f.cik},
                  ${f.accessionNo}, ${f.periodEnd}::date, ${f.value}::numeric)`,
    );
    const written = await tx.execute<{ inserted: boolean }>(sql`
      INSERT INTO xbrl_frames
        (taxonomy, concept, unit, frame, cik, issuer_id, accession_no, period_end, value,
         provenance_id)
      SELECT v.taxonomy, v.concept, v.unit, v.frame, v.cik,
             (SELECT i.issuer_id FROM issuers i
               WHERE i.tx_to = 'infinity' AND i.cik = v.cik
               ORDER BY i.issuer_id LIMIT 1),
             v.accession_no, v.period_end, v.value, ${provenanceId}::bigint
        FROM (VALUES ${sql.join(values, sql`, `)})
          AS v (taxonomy, concept, unit, frame, cik, accession_no, period_end, value)
      ON CONFLICT (taxonomy, concept, unit, frame, cik) DO UPDATE SET
        issuer_id = EXCLUDED.issuer_id, accession_no = EXCLUDED.accession_no,
        period_end = EXCLUDED.period_end, value = EXCLUDED.value,
        captured_at = now(), provenance_id = EXCLUDED.provenance_id
      WHERE (xbrl_frames.issuer_id, xbrl_frames.accession_no, xbrl_frames.period_end,
             xbrl_frames.value)
         IS DISTINCT FROM
            (EXCLUDED.issuer_id, EXCLUDED.accession_no, EXCLUDED.period_end, EXCLUDED.value)
      RETURNING (xmax = 0) AS inserted`);
    for (const row of written.rows) {
      if (row.inserted) counts.inserted += 1;
      else counts.updated += 1;
    }
    counts.unchanged += chunk.length - written.rows.length;
  }
  return counts;
}

/**
 * §7.4: fill `filed_at` from the `xbrl_facts` row the frame quotes, where we hold one.
 *
 * The join is on `(cik, concept, unit, period_end, accession_no)` — the accession is part of it
 * because that is what makes the answer the date *this* value was filed rather than the date some
 * other filing reported the same period. Rows with no matching fact keep `filed_at NULL`, which is
 * what tells `data/fundamentals.ts` the row is not point-in-time.
 */
export async function backfillFiledAt(tx: Tx, target: FrameTarget): Promise<number> {
  const updated = await tx.execute<{ cik: string }>(sql`
    UPDATE xbrl_frames f
       SET filed_at = x.filed_at
      FROM (SELECT cik, concept, unit, period_end, accession_no, min(filed_at) AS filed_at
              FROM xbrl_facts
             WHERE taxonomy = ${target.taxonomy}
               AND concept = ${target.concept}
               AND unit = ${target.unit}
             GROUP BY cik, concept, unit, period_end, accession_no) x
     WHERE f.taxonomy = ${target.taxonomy}
       AND f.concept = ${target.concept}
       AND f.unit = ${target.unit}
       AND f.frame = ${target.frame}
       AND f.cik = x.cik
       AND f.period_end = x.period_end
       AND f.accession_no = x.accession_no
       AND f.filed_at IS DISTINCT FROM x.filed_at
    RETURNING f.cik`);
  return updated.rows.length;
}

/**
 * §7.4: compare `data[].entityName` with `issuers.name` for the filers we resolved.
 *
 * "A hard disagreement" is read strictly: the names are compared after case folding and after
 * stripping the punctuation and corporate suffixes that every source spells differently, because
 * `APPLE INC` and `Apple Inc.` are the same company and raising a data-quality event on that pair
 * would bury the one case that matters — a CIK that has been re-used or mis-resolved.
 */
async function checkEntityNames(
  ctx: SecFramesJobContext,
  target: FrameTarget,
  frames: readonly XbrlFrameRow[],
): Promise<number> {
  const named = new Map<string, string>();
  for (const frame of frames) {
    if (frame.entityName !== null && frame.entityName !== '')
      named.set(frame.cik, frame.entityName);
  }
  if (named.size === 0) return 0;

  const ciks = [...named.keys()].sort();
  const rows = await ctx.tx.execute<{ cik: string; name: string; issuer_id: string }>(sql`
    SELECT cik, name, issuer_id FROM issuers
     WHERE tx_to = 'infinity'
       AND cik = ANY(${sql`ARRAY[${sql.join(
         ciks.map((c) => sql`${c}`),
         sql`, `,
       )}]::bpchar[]`})`);

  let written = 0;
  for (const row of rows.rows) {
    const cik = row.cik.trim();
    const published = named.get(cik);
    if (published === undefined) continue;
    if (comparableName(published) === comparableName(row.name)) continue;
    written += await recordDqEvent(ctx.tx, {
      kind: 'reconcile_mismatch',
      severity: 'warn',
      sourceId: SEC_FRAMES_SOURCE_ID,
      subject: `issuer:${row.issuer_id}`,
      key: `${target.concept}:${target.frame}:${cik}`,
      details: { cik, frameEntityName: published, issuerName: row.name, ...target },
    });
  }
  return written;
}

const CORPORATE_SUFFIX =
  /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|lp|llc|llp|sa|nv|ag|holdings?|group|trust|the)\b/g;

function comparableName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(CORPORATE_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The scheduler row
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** PROVIDERS §13; `IngestJob.id` is this module's basename. */
export const job = {
  id: 'secFrames',
  schedule: SEC_FRAMES_SCHEDULE,
  provider: SEC_FRAMES_SOURCE_ID,
  priority: 3 as const,
  timeoutMs: 600_000,
  run: (ctx: SecFramesJobContext): Promise<SecFramesResult> => runSecFrames(ctx),
};
