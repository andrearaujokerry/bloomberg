/**
 * `ingest/jobs/secSubmissions.ts` — the filing index and the 8-K current-filings feed.
 *
 * PROVIDERS §7.2 and §7.5, §13 row `secSubmissions`, WORKPLAN §WP-10 L1234.
 *
 * Two legs, one job, because §13 gives this row two cadences: **the 8-K atom every 60 s** and **a
 * per-CIK sweep of `submissions/CIK##########.json` on the hour**. `IngestJob.schedule` holds one
 * value, so the descriptor takes the tighter of the two (`{everyMs: 60_000}`) and the run decides
 * which legs to do from the clock alone: the atom on every tick, the sweep on the tick whose
 * `America/New_York` minute is 0 — which is exactly what `'0 * * * *'` means. Nothing is
 * remembered between runs, so a replayed tick does the same work as a live one, and a test forces
 * either leg with {@link SecSubmissionsJobContext.sweep} rather than by moving a clock.
 *
 * ## What lands where
 *
 *  - **`filings`**, from both legs. The atom usually beats the hourly sweep (§7.5), so the same
 *    accession arrives twice; `filings.accession_no` is the primary key and the write is an upsert
 *    that only touches a row whose content actually changed, which is what makes a re-poll report
 *    `unchanged` rather than `updated`.
 *  - **`news_items` kind `'filing'`**, from the atom leg, through `news/ingest.ts#upsertNewsItems`
 *    — the same writer `newsRss` uses, keyed on `(source_id, provider_guid)`. The two jobs poll
 *    the same feed on purpose (NEWS-04 wants the story; §7.2 wants the filing) and they must not
 *    fight: because both go through that upsert, whichever runs second finds the row already
 *    there and writes nothing.
 *
 * ## Point-in-time
 *
 * `filings.accepted_at` is the *instant* EDGAR made the document public, and `xbrl_facts.filed_at`
 * is only a date. §7.3.2's intraday tie-break — "a 10-Q accepted at 22:30 ET was not knowable at
 * 16:00 ET that day" — is `data/fundamentals.ts` joining `xbrl_facts.accession_no →
 * filings.accepted_at`. That join is the reason this job exists at all for fundamentals, and the
 * reason a filing row is never written with a guessed `accepted_at`: the column is nullable, and
 * a missing row is read as *not yet known*, which is the conservative direction.
 *
 * ## Deviation from §7.2's `parse_error` rule, recorded here
 *
 * §7.2 says `accepted_at` earlier than `filed_date` 00:00 ET is a `parse_error` and the row is
 * dropped. The normaliser that was actually built measured the capture and found the opposite:
 * **49 of Apple's 1,000 filings** are accepted before their filing date begins in ET, because
 * EDGAR dates a submission accepted after 17:30 ET to the *next* business day
 * (`providers/sec/parse.ts#SecSubmissionsRows.acceptedBeforeFiledDate`). Dropping them would
 * discard a twentieth of the filing index as malformed. They are kept and counted; the count is
 * reported on the result and logged, so the assumption stays visible.
 *
 * **Replay is a wall.** A capture the store does not hold throws `ReplayMissError`, which is
 * counted as "that CIK did not answer this tick" — never as a socket.
 */

import { sql } from 'drizzle-orm';

import { upsertNewsItems } from '../../news/ingest.js';
import {
  atomUrl,
  secAtomAdapter,
  secSubmissionsAdapter,
  submissionsUrl,
} from '../../providers/sec/adapter.js';
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
import type { FilingRow } from '../../providers/sec/parse.js';
import type { MarketJobContext, MarketJobResult } from './cboeQuotes.js';
import type { NewsItemInput } from '../../news/ingest.js';
import type { NormaliseLine, ProviderId, RawRecord } from '../../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The scheduler row (PROVIDERS §13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** §13: `{everyMs: 60000}` for the atom feed; `'0 * * * *'` for the per-CIK sweep. */
export const SEC_SUBMISSIONS_SCHEDULE = { everyMs: 60_000 } as const;

export const SEC_SUBMISSIONS_SOURCE_ID = 'sec.submissions' satisfies ProviderId;
export const SEC_ATOM_SOURCE_ID = 'sec.atom' satisfies ProviderId;

export const SEC_SUBMISSIONS_PROVIDERS: readonly ProviderId[] = Object.freeze([
  SEC_SUBMISSIONS_SOURCE_ID,
  SEC_ATOM_SOURCE_ID,
] as ProviderId[]);

/** §7.5: one page of the current-filings feed. */
export const ATOM_TYPE = '8-K';
export const ATOM_COUNT = 40;

/** The zone every cron row of §13 but `fxEod` is written in. */
const SWEEP_TIMEZONE = 'America/New_York';

/** Filings carry no `md_lines`; the normalisers take the empty map. */
const NO_LINES: ReadonlyMap<string, NormaliseLine> = new Map();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Job context and result
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SecSubmissionsJobContext extends MarketJobContext {
  /**
   * The CIKs to sweep, zero-padded. Omitted → every `issuers.cik` currently known — "index
   * members hourly, rest of the universe daily" (§13) collapses to one tier until WP-15 seeds the
   * two.
   */
  ciks?: readonly string[];
  /** Stop after this many CIKs. */
  limit?: number;
  /** Force the per-CIK sweep on or off; omitted → the top of the hour in `America/New_York`. */
  sweep?: boolean;
  /** Force the 8-K atom leg on or off; omitted → every tick, which is its 60 s cadence. */
  atom?: boolean;
}

export interface SecSubmissionsResult extends MarketJobResult {
  /** CIKs whose submissions index was parsed this run. */
  ciks: number;
  filingsInserted: number;
  filingsUpdated: number;
  filingsUnchanged: number;
  /** `news_items` rows the atom leg added. */
  newsInserted: number;
  newsUpdated: number;
  /** §7.2: filings accepted before their filing date began in ET. Ordinary, counted, never dropped. */
  acceptedBeforeFiledDate: number;
  /** The `9999999997-*` paper and `NO ACT` pseudo-accessions. */
  acceptedAfterFiledDate: number;
  dqEventsWritten: number;
  dataExceptionsWritten: number;
}

function emptySubmissionsResult(): SecSubmissionsResult {
  return {
    ...emptyResult(),
    ciks: 0,
    filingsInserted: 0,
    filingsUpdated: 0,
    filingsUnchanged: 0,
    newsInserted: 0,
    newsUpdated: 0,
    acceptedBeforeFiledDate: 0,
    acceptedAfterFiledDate: 0,
    dqEventsWritten: 0,
    dataExceptionsWritten: 0,
  };
}

function isReplayMiss(err: unknown): boolean {
  return err instanceof ReplayMissError || (err as { name?: string })?.name === 'ReplayMissError';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function runSecSubmissions(
  ctx: SecSubmissionsJobContext,
): Promise<SecSubmissionsResult> {
  const result = emptySubmissionsResult();
  await withIngestRun(
    ctx,
    { id: 'secSubmissions', sourceId: SEC_SUBMISSIONS_SOURCE_ID },
    async () => {
      if (ctx.atom !== false) await runAtomLeg(ctx, result);
      if (ctx.sweep ?? isTopOfHour(ctx)) await runSweepLeg(ctx, result);
      ctx.log?.info?.('secSubmissions.done', {
        ciks: result.ciks,
        filingsInserted: result.filingsInserted,
        filingsUpdated: result.filingsUpdated,
        newsInserted: result.newsInserted,
        acceptedBeforeFiledDate: result.acceptedBeforeFiledDate,
      });
      return result;
    },
  );
  return result;
}

/** `'0 * * * *'` in `America/New_York`, evaluated against the injected clock and nothing else. */
function isTopOfHour(ctx: SecSubmissionsJobContext): boolean {
  return zonedParts(ctx.clock.now(), SWEEP_TIMEZONE).minute === 0;
}

// ── the 60 s leg: the 8-K current-filings atom ────────────────────────────────────────────────

async function runAtomLeg(
  ctx: SecSubmissionsJobContext,
  result: SecSubmissionsResult,
): Promise<void> {
  const url = atomUrl(ATOM_TYPE, ATOM_COUNT);
  let raw: RawRecord;
  try {
    raw = await fetchThrough(
      ctx,
      secAtomAdapter,
      { type: ATOM_TYPE, count: ATOM_COUNT, ...requestEnvelope(ctx) },
      url,
    );
  } catch (err) {
    if (isReplayMiss(err)) {
      result.skipped += 1;
      ctx.log?.info?.('secSubmissions.atom_unavailable', { url });
      return;
    }
    result.errors.push(fetchError(err, url));
    return;
  }
  if (raw.status === 304) {
    result.skipped += 1;
    return;
  }
  result.fetched += 1;

  const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
    raw,
    adapterVersion: SEC_ADAPTER_VERSION,
    lines: NO_LINES,
    normalise: (r, nctx) => secAtomAdapter.normalise(r, nctx),
  });
  result.provenanceIds.push(provenanceId);
  result.problems.push(...norm.problems);

  const counts = await upsertFilings(ctx.tx, norm.rows.filings, provenanceId);
  result.filingsInserted += counts.inserted;
  result.filingsUpdated += counts.updated;
  result.filingsUnchanged += counts.unchanged;
  result.inserted += counts.inserted;
  result.updated += counts.updated;
  result.skipped += counts.unchanged;

  // §7.5 → NEWS-04: the same feed, the same upsert `newsRss` uses. One of the two jobs writes the
  // story and the other finds it already written; neither overwrites the other's headline.
  const inputs: NewsItemInput[] = norm.rows.newsItems.map((item) => ({
    sourceId: 'sec.atom',
    feed: item.feed,
    providerGuid: item.providerGuid,
    kind: item.kind,
    headline: item.headline,
    summary: item.summary,
    url: item.url,
    author: null,
    category: item.category,
    cik: item.cik,
    items8k: item.items8k,
    lang: item.lang,
    publishedAt: item.publishedAt,
    isCorrection: item.isCorrection,
  }));
  const news = await upsertNewsItems(ctx.tx, inputs, {
    provenanceId,
    capturedAt: raw.capturedAt,
  });
  result.newsInserted += news.inserted;
  result.newsUpdated += news.updated;
  result.inserted += news.inserted;
  result.updated += news.updated;
  result.skipped += news.unchanged;
  for (const problem of news.problems) {
    ctx.log?.warn?.('secSubmissions.news_row_rejected', { ...problem });
  }
}

// ── the hourly leg: the per-CIK submissions sweep ─────────────────────────────────────────────

async function runSweepLeg(
  ctx: SecSubmissionsJobContext,
  result: SecSubmissionsResult,
): Promise<void> {
  for (const cik of await resolveCiks(ctx)) {
    const url = submissionsUrl(cik);
    if (url === null) {
      result.errors.push({ code: 'BAD_CIK', message: `'${cik}' is not a CIK`, requestKey: cik });
      continue;
    }

    let raw: RawRecord;
    try {
      raw = await fetchThrough(ctx, secSubmissionsAdapter, { cik, ...requestEnvelope(ctx) }, url);
    } catch (err) {
      if (isReplayMiss(err)) {
        result.skipped += 1;
        ctx.log?.info?.('secSubmissions.capture_unavailable', { cik, url });
        continue;
      }
      result.errors.push(fetchError(err, url));
      continue;
    }

    if (raw.status === 304) {
      result.skipped += 1;
      continue;
    }
    // §7.2: a CIK `company_tickers.json` published but `submissions` does not serve is an
    // identifier we cannot resolve, not a run that failed.
    if (raw.status === 404) {
      result.skipped += 1;
      result.dataExceptionsWritten += await recordUnresolvedCik(ctx.tx, cik, url);
      continue;
    }

    const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
      raw,
      adapterVersion: SEC_ADAPTER_VERSION,
      lines: NO_LINES,
      normalise: (r, nctx) => secSubmissionsAdapter.normalise(r, nctx),
    });

    // §7.2's stale-CDN guard: a `recent` whose newest filing is older than what we already hold
    // for this CIK is a cached object, and **nothing is written** — including the provenance row,
    // which is why the check runs after the parse but before anything else uses it.
    const stored = await newestFiledDate(ctx.tx, cik);
    const newest = norm.rows.newestFilingDate;
    if (stored !== null && newest !== null && newest < stored) {
      result.skipped += 1;
      result.dqEventsWritten += await recordDqEvent(ctx.tx, {
        kind: 'poll_anomaly',
        severity: 'warn',
        sourceId: SEC_SUBMISSIONS_SOURCE_ID,
        subject: `cik:${cik}`,
        key: `${stored}:${newest}`,
        details: { stored, served: newest, url, reason: 'submissions index went backwards' },
      });
      continue;
    }

    result.fetched += 1;
    result.ciks += 1;
    result.provenanceIds.push(provenanceId);
    result.problems.push(...norm.problems);
    result.acceptedBeforeFiledDate += norm.rows.acceptedBeforeFiledDate;
    result.acceptedAfterFiledDate += norm.rows.acceptedAfterFiledDate;

    const counts = await upsertFilings(ctx.tx, norm.rows.filings, provenanceId);
    result.filingsInserted += counts.inserted;
    result.filingsUpdated += counts.updated;
    result.filingsUnchanged += counts.unchanged;
    result.inserted += counts.inserted;
    result.updated += counts.updated;
    result.skipped += counts.unchanged;
  }
}

async function resolveCiks(ctx: SecSubmissionsJobContext): Promise<string[]> {
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

/** The newest `filed_date` already stored for a CIK — the input to §7.2's stale-CDN check. */
export async function newestFiledDate(tx: Tx, cik: string): Promise<string | null> {
  const rows = await tx.execute<{ newest: string | null }>(sql`
    SELECT max(filed_date)::text AS newest FROM filings WHERE cik = ${cik}`);
  return rows.rows[0]?.newest ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `filings`
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface FilingWriteCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

/** Postgres caps a statement at 65 535 bind parameters; 200 × 16 columns stays well inside it. */
const FILING_CHUNK = 200;

/**
 * Upsert filings on `accession_no`, touching only rows whose content actually changed.
 *
 * `IS DISTINCT FROM` across the whole tuple rather than `DO UPDATE SET …` unconditionally: an
 * unconditional upsert reports every one of the 1,000 filings as `updated` on every hourly poll,
 * moves `captured_at` and `provenance_id` on rows nobody touched, and makes "a second run writes
 * nothing" unprovable. The `xmax = 0` trick tells insert from update in one statement without a
 * second round trip: a freshly inserted row has no updating transaction.
 *
 * `issuer_id` is resolved in SQL against the current `issuers` version rather than in a second
 * pass — the column is nullable precisely because the master may not know the CIK yet, and a
 * later `symbologyRefresh` that creates the issuer will fill it on the next sweep.
 */
export async function upsertFilings(
  tx: Tx,
  filings: readonly FilingRow[],
  provenanceId: number,
): Promise<FilingWriteCounts> {
  // The last spelling of an accession in the payload wins; a feed that repeats one inside a single
  // statement would otherwise raise `ON CONFLICT DO UPDATE command cannot affect row a second time`.
  const deduped = new Map<string, FilingRow>();
  for (const filing of filings) deduped.set(filing.accessionNo, filing);
  const rows = [...deduped.values()].sort((a, b) =>
    a.accessionNo < b.accessionNo ? -1 : a.accessionNo > b.accessionNo ? 1 : 0,
  );

  // Every literal in a bare `VALUES` list arrives as `text`, so each column that is not text
  // carries its own cast. Postgres applies the assignment cast for `char(n)` and `date` on its
  // own; it refuses one for `boolean`, which is a 42804 at the first 8-K rather than a wrong row.
  const counts: FilingWriteCounts = { inserted: 0, updated: 0, unchanged: 0 };
  for (let i = 0; i < rows.length; i += FILING_CHUNK) {
    const chunk = rows.slice(i, i + FILING_CHUNK);
    const values = chunk.map(
      (f) => sql`(${f.accessionNo}, ${f.cik}, ${f.form}, ${f.filedDate}::date,
                  ${f.acceptedAt}::timestamptz, ${f.reportDate}::date,
                  ${sql`ARRAY[${
                    f.items.length === 0
                      ? sql``
                      : sql.join(
                          f.items.map((item) => sql`${item}`),
                          sql`, `,
                        )
                  }]::text[]`},
                  ${f.primaryDoc}, ${f.primaryDocDesc}, ${f.isXbrl}::boolean,
                  ${f.isInlineXbrl}::boolean, ${f.sizeBytes}::int, ${f.url})`,
    );
    const written = await tx.execute<{ inserted: boolean }>(sql`
      INSERT INTO filings
        (accession_no, cik, issuer_id, form, filed_date, accepted_at, report_date, items,
         primary_doc, primary_doc_desc, is_xbrl, is_inline_xbrl, size_bytes, url, provenance_id)
      SELECT v.accession_no, v.cik,
             (SELECT i.issuer_id FROM issuers i
               WHERE i.tx_to = 'infinity' AND i.cik = v.cik
               ORDER BY i.issuer_id LIMIT 1),
             v.form, v.filed_date, v.accepted_at, v.report_date, v.items, v.primary_doc,
             v.primary_doc_desc, v.is_xbrl, v.is_inline_xbrl, v.size_bytes, v.url,
             ${provenanceId}::bigint
        FROM (VALUES ${sql.join(values, sql`, `)})
          AS v (accession_no, cik, form, filed_date, accepted_at, report_date, items, primary_doc,
                primary_doc_desc, is_xbrl, is_inline_xbrl, size_bytes, url)
      ON CONFLICT (accession_no) DO UPDATE SET
        cik = EXCLUDED.cik, issuer_id = EXCLUDED.issuer_id, form = EXCLUDED.form,
        filed_date = EXCLUDED.filed_date, accepted_at = EXCLUDED.accepted_at,
        report_date = EXCLUDED.report_date, items = EXCLUDED.items,
        primary_doc = EXCLUDED.primary_doc, primary_doc_desc = EXCLUDED.primary_doc_desc,
        is_xbrl = EXCLUDED.is_xbrl, is_inline_xbrl = EXCLUDED.is_inline_xbrl,
        size_bytes = EXCLUDED.size_bytes, url = EXCLUDED.url,
        captured_at = now(), provenance_id = EXCLUDED.provenance_id
      WHERE (filings.cik, filings.issuer_id, filings.form, filings.filed_date, filings.accepted_at,
             filings.report_date, filings.items, filings.primary_doc, filings.primary_doc_desc,
             filings.is_xbrl, filings.is_inline_xbrl, filings.size_bytes, filings.url)
         IS DISTINCT FROM
            (EXCLUDED.cik, EXCLUDED.issuer_id, EXCLUDED.form, EXCLUDED.filed_date,
             EXCLUDED.accepted_at, EXCLUDED.report_date, EXCLUDED.items, EXCLUDED.primary_doc,
             EXCLUDED.primary_doc_desc, EXCLUDED.is_xbrl, EXCLUDED.is_inline_xbrl,
             EXCLUDED.size_bytes, EXCLUDED.url)
      RETURNING (xmax = 0) AS inserted`);
    for (const row of written.rows) {
      if (row.inserted) counts.inserted += 1;
      else counts.updated += 1;
    }
    counts.unchanged += chunk.length - written.rows.length;
  }
  return counts;
}

/** §7.2: a CIK the tickers file published and `submissions` 404s on. Written once per CIK. */
export async function recordUnresolvedCik(tx: Tx, cik: string, url: string): Promise<number> {
  const key = `sec.submissions:${cik}`;
  const candidates = [
    { sourceId: SEC_SUBMISSIONS_SOURCE_ID, provenanceId: null, value: { key, cik, url } },
  ];
  const rows = await tx.execute<{ exception_id: string }>(sql`
    INSERT INTO data_exceptions (kind, entity_kind, entity_id, field, candidates, status)
    SELECT 'unresolved_identifier', NULL, NULL, 'cik', ${JSON.stringify(candidates)}::jsonb, 'open'
     WHERE NOT EXISTS (
       SELECT 1 FROM data_exceptions
        WHERE kind = 'unresolved_identifier'
          AND field = 'cik'
          AND candidates -> 0 -> 'value' ->> 'key' = ${key})
    RETURNING exception_id`);
  return rows.rows.length;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The scheduler row
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** PROVIDERS §13; `IngestJob.id` is this module's basename. */
export const job = {
  id: 'secSubmissions',
  schedule: SEC_SUBMISSIONS_SCHEDULE,
  provider: SEC_SUBMISSIONS_PROVIDERS,
  priority: 1 as const,
  timeoutMs: 60_000,
  run: (ctx: SecSubmissionsJobContext): Promise<SecSubmissionsResult> => runSecSubmissions(ctx),
};
