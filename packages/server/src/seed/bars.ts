// packages/server/src/seed/bars.ts
//
// Seed modules 8 and 9 of DATA_MODEL §18 (L2568-2570): the bar history, the corporate actions, the
// ECB fixing, the AAPL option chain and the plant's warm start.
//
// What it writes, measured, with §18's figure beside it where the two differ — the difference is
// always a fixture fact and is stated at the line that causes it, never rounded away:
//
// | rows written                     | §18   | capture(s)                                          |
// | -------------------------------- | ----- | --------------------------------------------------- |
// | `bars_daily` 1,255 + 9 fixings    | 1,450 | `yahoo-chart-events` (AAPL 1d/5y), `frankfurter`     |
// | `bars_intraday` 1,033            | 1,110 | the four intraday captures that have an md line     |
// | `corporate_actions` 20 div + 5 splits | ≈24 | `yahoo-chart-events`, `yahoo-chart-AAPL-max-1d.json` |
// | `fx_rates` 58 (29 × 2 directions) | 29    | `frankfurter`                                       |
// | 3,510 option instruments + `option_terms` + `option_quotes` | 3,510 | `cboe-options`         |
// | `quote_ticks` 5                  | 4     | the three Cboe quotes, the EU index, and the chain's |
// |                                  |       | own underlying block (§5.2 step 1)                  |
// | `quote_snapshots` 4, `eod_snapshots` 4 | 4, 4 | the plant, warm-started from those four lines     |
//
// The three divergences that are not arithmetic: §18's 1,450 daily bars counts the 169 rows of the
// `range=max` capture, which is quarterly and therefore not a daily bar (trap 1 below); its 1,110
// intraday bars count `yahoo-bond`'s 75 `^TNX` five-minute bars, and `^TNX` is not one of the 31
// instruments §18 row 5 mints, so that capture has no md line to arrive on; and its ≈24 corporate
// actions count four splits where the file carries five (three historical 2:1, the 2014 7:1 and the
// 2020 4:1).
//
// ## This module needs module 3-5 to have run
//
// Every row above is written **onto an md line**: `resolveTargets` turns `md_lines` into the poll
// list, and the parsers resolve a bar to an instrument through the line it arrived on. The lines for
// `yahoo.chart`, `frankfurter`, `cboe.quotes`, `cboe.options` and `cboe.euIndices` belong to
// `yahoo.chart`, `cboe.quotes` and `cboe.euIndices` belong to `seed/universe.ts` (§18 rows 3-5). So
// a run of this module against a database whose universe has not been seeded writes **nothing at
// all**, logs which symbol it could not find a line for, and returns — the same answer
// `jobs/cboeQuotes.ts` documents for an unseeded database ("a source with no lines returns an empty
// array and the job reports `skipped`, which is the correct state before WP-15's seed has run —
// never an error"). It is a precondition, not a failure, and the next full `db:seed` writes the bars.
//
// Two of the five lines are **not** in universe.ts's remit and are minted here, because the capture
// that needs them is this module's: the nine `frankfurter` lines over the FX instruments universe
// already created ({@link ensureFxEodLines}), and the `cboe.options` line of each underlying whose
// chain was recorded ({@link ensureOptionChainLines} — at runtime `functions/DES/resolve.ts` creates
// it on demand, which is a hot-set decision the seed cannot make on a user's behalf). Without them
// `jobs/fxEod.ts` and `jobs/cboeOptions.ts` report `no_targets` and two whole §18 rows stay empty.
//
// ## Why some captures go through a §13 job and some do not
//
// A §13 job asks for the window its *cadence* needs, which for `yahooIntraday` is `interval=5m&
// range=1d` and for `yahooDaily` is `interval=1d&range=5y`. Three of the eight recorded chart
// captures are exactly those requests, so the job replays them as-is ({@link JOB_BACKFILL}). The
// other five were captured with windows no scheduled poll would ask for — a one-minute AAPL day, a
// five-day SPX history, the `range=max` file — so they are replayed through the shared
// {@link ingestChart}, which is the same fetch → provenance → normalise → publish → write sequence
// the jobs use, with the request the capture was taken with. Those calls write no `ingest_runs` row
// on purpose: `ingest_runs.job_id` is a §13 module name (PROVIDERS §13) and a seed backfill is not
// one of the thirteen jobs. Their audit trail is the `provenance` row per capture, which is the
// row DATA-10 actually requires.
//
// ## The three traps this file is written around
//
//  1. **`yahoo-chart-AAPL-max-1d.json` is quarterly.** Its name says `1d` and `meta.range` says
//     `max`, but Yahoo silently downgraded `dataGranularity` to `3mo` (PROVIDERS §5.5, TESTING §7.3
//     L748), so the parser refuses to write its 169 rows into `bars_daily` — coarse bars are not
//     daily bars. What it *does* carry that nothing else does is the split history, so this module
//     takes the file for its splits and nothing else ({@link CorporateActionFilter}).
//
//     Taking its dividends as well is not merely a volume error, which is worth knowing because the
//     volume error is the forgiving half. Measured: with `actions: 'all'` on that capture the seed
//     writes 92 dividends, and the **next** run fails with `P0001 tx_to must be after tx_from` out of
//     `bt_close_tx`. The two captures state the same dividend differently (the quarterly file rounds
//     its details), so the five-year capture wants to open a new version of a row the later capture
//     already wrote — and its knowledge instant (18:44:51Z) is *earlier* than that row's `tx_from`
//     (18:45:48Z), which `bt_guard_update` rejects by design (`db/bitemporal.ts`: a caller closing a
//     version must pass an instant strictly later than the `tx_from` of the version it closes). A
//     database that has been seeded that way cannot be re-seeded; only the rows can be removed.
//     Replaying two captures of one entity in ascending capture order is therefore not a style
//     choice, and mixing two granularities of one series is a write-order trap, not a duplicate.
//  2. **`quote_ticks` has two writers.** `plant/store.ts` is named the only writer of `quote_ticks`,
//     `quote_snapshots` and `eod_snapshots` (WORKPLAN WP-06), while §18 row 9 has the seed write the
//     four warm-start rows. Both halves are honoured as far as they can be and the tension is
//     recorded, not resolved: the `quote_ticks` rows are written by `jobs/cboeQuotes.ts#
//     insertQuoteTicks` (the guarded, idempotent writer WP-05 already uses, so a second seed run
//     adds none), and `quote_snapshots` / `eod_snapshots` are composed by the **plant** — the
//     `QuoteState` that lands in the jsonb is `plant.snapshot(subject)` and the eod view is
//     `plant.captureEod(...)`, both of them WP-06's own code — but the two rows are written here by
//     SQL rather than through `plantStore.flush()`. `flush()` opens its own transaction
//     (`plant/store.ts#inTx` → `db.transaction`), and the seed runs on a checked-out client inside a
//     `BEGIN` the runner owns; a nested `BEGIN`/`COMMIT` on that client would commit the runner's
//     transaction half-way through the module. The upserts below are the same statements `flush()`
//     issues, with an `IS DISTINCT FROM` guard added so a second run writes nothing.

import { sql } from 'drizzle-orm';

import { buildPlant } from '../plant/tickerPlant.js';
import { EOD_FIELD_IDS } from '../plant/eod.js';
import { familyOf } from '../plant/subjects.js';
import {
  ReplayStore,
  canonicalUrl,
  openReplayStore,
  requestKey,
} from '../providers/replayStore.js';
import { chartUrl } from '../providers/yahoo/adapter.js';
import { cboeQuoteUrl } from '../providers/cboe/adapter.js';
import { recordedLegs } from './fundamentals.js';

import type { LegOutput } from './fundamentals.js';
import { CBOE_EU_SOURCE_ID, runCboeEuIndices } from '../ingest/jobs/cboeEuIndices.js';
import { CBOE_OPTIONS_SOURCE_ID, runCboeOptions } from '../ingest/jobs/cboeOptions.js';
import {
  CBOE_QUOTES_SOURCE_ID,
  emptyResult,
  linesOf,
  resolveTargets,
  runCboeQuotes,
} from '../ingest/jobs/cboeQuotes.js';
import { FRANKFURTER_SOURCE_ID, runFxEod } from '../ingest/jobs/fxEod.js';
import { runFxIntraday } from '../ingest/jobs/fxIntraday.js';
import { YAHOO_SOURCE_ID, ingestChart, runYahooIntraday } from '../ingest/jobs/yahooIntraday.js';
import { runYahooDaily, writeCorporateActions } from '../ingest/jobs/yahooDaily.js';
import { insertProvenance } from '../providers/provenance.js';
import { masterRepositories } from '../refdata/master.js';
import { capturedAtOf, countTables, pinnedClock, tableDeltas } from './rates.js';

import type { EodView } from '../plant/eod.js';
import type { Plant } from '../plant/tickerPlant.js';
import type { Tx } from '../db/client.js';
import type { CaptureSourceId } from '../providers/types.js';
import type { MarketJobContext, MarketJobResult } from '../ingest/jobs/cboeQuotes.js';
import type { YahooChartRows } from '../providers/yahoo/adapter.js';
import type { SeedContext } from './index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// What this module replays
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Which corporate actions a capture contributes.
 *
 * `splits` exists for `yahoo-chart-AAPL-max-1d.json`: its 92-dividend history is the same series the
 * five-year capture carries, extended backwards at quarterly granularity, while its five splits
 * (1987, 2000 and 2005 2:1, the 2014-06-09 7:1 and the 2020-08-31 4:1) appear in no other file.
 * §18 row 8 fixes the volume at "20 dividends + splits" ≈ 24, which is that reading of the two
 * files; taking the whole dividend history from the quarterly file as well would write 97 rows and
 * blow the acceptance count without learning anything the five-year capture does not already say.
 */
export type CorporateActionFilter = 'none' | 'all' | 'splits';

/** One recorded `yahoo.chart` capture and what this module takes from it. */
export interface ChartBackfill {
  /** `md_lines.provider_symbol`. */
  symbol: string;
  interval: string;
  range: string;
  /** `true` → `events=div|split`, which is how the capture was taken. */
  events: boolean;
  /**
   * Which capture of the request to replay. `manifest.json` holds two captures of
   * `AAPL?interval=1m&range=1d` — a 313-bar poll at 18:41:43Z and a 317-bar poll at 18:45:43Z — and
   * §18 names both files, so both are replayed in order: the second restates the 313 bars it shares
   * with the first and inserts the four minutes that had not happened yet.
   */
  captureIndex: number;
  /** `bars_intraday` or `bars_daily`; the parser refuses whichever the granularity is not. */
  write: 'intraday' | 'daily';
  actions: CorporateActionFilter;
  /**
   * The table whose rows decide whether this leg has already run (see
   * `seed/fundamentals.ts#recordedLegs`), which is **measured, not inferred from `write`**.
   *
   * `AAPL 1d/max` is the reason it is a field. Its `write` is `'daily'`, but its bars are quarterly
   * and reach back to 1980, and `bars_daily` is partitioned by year from 2016: none of them lands.
   * Its only durable output is the five `corporate_actions` rows its `note` says it was taken for,
   * so `corporate_actions` is what tells a second run that it has nothing to do. Gating it on
   * `bars_daily` left the one leg in eleven that still re-recorded its capture on every run — a
   * `provenance` row per `db:seed` for an exchange that never happened.
   */
  gate: 'bars_intraday' | 'bars_daily' | 'corporate_actions';
  note: string;
}

/**
 * The Cboe symbols the four top-of-book/chain captures cover.
 *
 * Narrowing these matters more than it does for Yahoo: `seed/universe.ts` mints a `cboe.quotes` line
 * for every one of the 35,618 symbols in the Cboe symbol book (§18 row 3), and an un-narrowed
 * `runCboeQuotes` would ask the replay store for 35,618 URLs, collect 35,615 `ReplayMissError`s and
 * take the module down. The three symbols that were recorded are named here.
 */
export const CBOE_BACKFILL = Object.freeze({
  /** `cboe-quote-AAPL.json`, `cboe-spx`, `cboe-vix`. */
  quotes: Object.freeze(['AAPL', '_SPX', '_VIX']),
  /** `cboe-options` — the 3,510-contract AAPL chain. */
  options: Object.freeze(['AAPL']),
  /** `cboe-eu-indices` — the Cboe UK 100. */
  euIndices: Object.freeze(['BUK100P']),
});

/**
 * The three captures whose request a §13 job already makes, with the symbols to narrow it to.
 *
 * Narrowing matters: `resolveTargets` with no `symbols` returns every line of the source, and in
 * replay mode a line whose window was never captured is a `ReplayMissError` recorded as a job error
 * (FEED-08). A seed that polled all 503 `yahoo.chart` lines would report 502 errors and one bar set.
 */
export const JOB_BACKFILL = Object.freeze({
  /** `interval=1d&range=5y&events=div|split` — `yahoo-chart-events`, 1,255 bars + 20 dividends. */
  yahooDaily: Object.freeze(['AAPL']),
  /** `interval=5m&range=1d` — `yahoo-ftse` (103 bars) and `yahoo-bond` (^TNX, 75 bars). */
  yahooIntraday: Object.freeze(['^FTSE', '^TNX']),
  /** `interval=5m&range=1d` on the one recorded pair — `yahoo-fx`, 238 bars. */
  fxIntraday: Object.freeze(['EURUSD=X']),
});

/**
 * The gate name of one {@link CHART_BACKFILL} entry.
 *
 * Keyed on the REQUEST rather than on the capture index, because `capturesIngested` gates on the
 * whole manifest entry: the two AAPL 1m/1d backfills are two captures of one URL, so they are one
 * gate, satisfied only when both digests are recorded.
 */
function backfillLeg(capture: ChartBackfill): string {
  return `backfill:${capture.symbol}:${capture.interval}:${capture.range}`;
}

/** The captures whose window no scheduled poll asks for. Replayed through {@link ingestChart}. */
export const CHART_BACKFILL: readonly ChartBackfill[] = Object.freeze([
  {
    symbol: 'AAPL',
    interval: '1m',
    range: '1d',
    events: false,
    captureIndex: 0,
    write: 'intraday',
    actions: 'none',
    gate: 'bars_intraday',
    note: 'yahoo-chart-1m — the 18:41:43Z minute poll, 313 bars',
  },
  {
    symbol: 'AAPL',
    interval: '1m',
    range: '1d',
    events: false,
    captureIndex: 1,
    write: 'intraday',
    actions: 'none',
    gate: 'bars_intraday',
    note: 'yahoo-chart-AAPL-1d-1m.json — the 18:45:43Z poll, 317 bars (four minutes later)',
  },
  {
    symbol: '^GSPC',
    interval: '5m',
    range: '5d',
    events: false,
    captureIndex: 0,
    write: 'intraday',
    actions: 'none',
    gate: 'bars_intraday',
    note: 'yahoo-chart-SPX-5d-5m.json — 377 five-minute bars over five sessions',
  },
  {
    symbol: 'AAPL',
    interval: '1d',
    range: 'max',
    events: true,
    captureIndex: 0,
    write: 'daily',
    actions: 'splits',
    gate: 'corporate_actions',
    note: 'yahoo-chart-AAPL-max-1d.json — quarterly despite the name; taken for its five splits',
  },
] satisfies readonly ChartBackfill[]);

/** The recorded URLs this module names directly, so a typo is a `ReplayMissError` and not a silent 0. */
export const FRANKFURTER_LATEST_URL = 'https://api.frankfurter.dev/v1/latest?base=USD';
export const CBOE_OPTIONS_AAPL_URL = 'https://cdn.cboe.com/api/global/delayed_quotes/options/AAPL.json';
export const CBOE_QUOTE_AAPL_URL = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/AAPL.json';
export const CBOE_EU_BUK100P_URL =
  'https://cdn.cboe.com/api/global/european_indices/index_quotes/BUK100P.json';

/** The session the four Cboe captures belong to — their own capture date, never a wall clock. */
export function sessionDateOf(capturedAtMs: number): string {
  return new Date(capturedAtMs).toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Replaying a specific capture of a request
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A view of the replay store in which `url` resolves to its `index`-th capture.
 *
 * `ReplayStore.lookup` takes a capture index, but the offline fetch path does not: `fetchThrough`
 * calls `store.replay({providerId, url})`, which always serves capture 0. Rather than duplicate the
 * fetch-provenance-normalise sequence to reach the second capture of a request, this builds a store
 * over the same directory with a manifest whose entry for that one key holds only the wanted
 * capture. Everything else in the manifest is untouched, the bytes are still verified against their
 * recorded sha256, and a miss still throws.
 *
 * @throws Error when the key or the capture index is not in the manifest — a seed that silently fell
 *         back to capture 0 would write the wrong bar count and look successful.
 */
export function storeAtCapture(
  store: ReplayStore,
  providerId: CaptureSourceId,
  url: string,
  index: number,
): ReplayStore {
  if (index === 0) return store;
  const canonical = canonicalUrl(url);
  const key = requestKey(providerId, 'GET', canonical);
  const entry = store.entry(key);
  const capture = entry?.captures[index];
  if (entry === undefined || capture === undefined) {
    throw new Error(
      `seed/bars: the replay manifest holds ${String(entry?.captures.length ?? 0)} capture(s) of ` +
        `${providerId} ${canonical}, so capture ${String(index)} cannot be replayed`,
    );
  }
  return new ReplayStore(store.dir, { ...store.manifest, [key]: { ...entry, captures: [capture] } });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The two md lines §18 rows 3-5 do not mint
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Cite a recorded capture: the `provenance` row for it, re-used when this database already holds one.
 *
 * The md lines below are reference rows *derived from a capture* — the `frankfurter` fixing names
 * the currencies it publishes, and the `cboe-options` chain names its underlying — so they must cite
 * that capture (DATA-10), and they have to exist before the job that would write its own provenance
 * row runs. The lookup keeps that from meaning a second row per run: an identical capture already
 * cited is cited again rather than re-recorded.
 */
async function citeCapture(tx: Tx, providerId: CaptureSourceId, url: string): Promise<number> {
  const raw = openReplayStore().replay({ providerId, url });
  const held = await tx.execute<{ provenance_id: string }>(sql`
    SELECT provenance_id FROM provenance
     WHERE source_id = ${providerId}
       AND request_key = ${raw.requestKey}
       AND response_sha256 = decode(${raw.sha256}, 'hex')
     ORDER BY provenance_id
     LIMIT 1`);
  const row = held.rows[0];
  if (row !== undefined) return Number(row.provenance_id);
  return insertProvenance(tx, raw, {
    adapterVersion: SEED_LINE_ADAPTER_VERSION,
    sourceTs: raw.sourceTs,
  });
}

/** `provenance.adapter_version` for a line this module mints from a capture. */
export const SEED_LINE_ADAPTER_VERSION = 'seed.bars/1.0.0';

/** §5.7: the ECB publishes once a day and the fixing it publishes is final, not delayed. */
const FX_EOD_LINE = { intrinsicDelayMin: 0, expectedIntervalMs: 86_400_000, priority: 30 } as const;
/** §5.2: the chain is polled a minute at a time off a 15-minute delayed feed. */
const OPTION_LINE = { intrinsicDelayMin: 15, expectedIntervalMs: 60_000, priority: 10 } as const;

/**
 * One `frankfurter` line per seeded FX instrument, keyed by the pair code.
 *
 * `seed/universe.ts` mints the nine G10 pairs and their `yahoo.chart` lines (§18 row 5) but no
 * `frankfurter` line, and `jobs/fxEod.ts` returns `no_targets` without one — so §18 row 8's
 * `fx_rates` would be empty however many times the seed ran. The fixing is this module's capture, so
 * distributing it over the instruments that already exist is this module's business; minting an FX
 * *instrument* would not be.
 *
 * The `provider_symbol 'USD'` reference line of §5.7 is deliberately **not** created: it needs an
 * instrument to hang off, the universe has no US dollar instrument, and its only function is to
 * advance `ts.cap` for the staleness sweep. Inventing an instrument to carry a staleness signal
 * would be worse than not having the signal, so the omission is logged instead.
 */
export async function ensureFxEodLines(
  tx: Tx,
  o: { provenanceId: number; knownAt: Date },
): Promise<{ written: number; lines: number }> {
  const res = await tx.execute<{ instrument_id: string; ticker: string }>(sql`
    SELECT instrument_id::text AS instrument_id, ticker
      FROM instruments
     WHERE asset_class = 'fx'
       AND tx_to = 'infinity'
       AND valid_from <= ${o.knownAt}::timestamptz
       AND valid_to   >  ${o.knownAt}::timestamptz
     ORDER BY ticker`);
  const master = masterRepositories(tx);
  let written = 0;
  for (const row of res.rows) {
    // `pairForLine` reads `'EURUSD'` and `'EURUSD=X'` alike; the frankfurter line carries the plain
    // six-letter pair, which is the spelling §5.7 documents.
    if (!/^[A-Z]{6}$/.test(row.ticker)) continue;
    const line = await master.mdLines.upsertBySymbol(
      {
        instrumentId: Number(row.instrument_id),
        sourceId: FRANKFURTER_SOURCE_ID,
        providerSymbol: row.ticker,
        lineKind: 'composite',
        ...FX_EOD_LINE,
      },
      { validFrom: o.knownAt, provenanceId: o.provenanceId, knownAt: o.knownAt },
    );
    if (line.written) written += 1;
  }
  return { written, lines: res.rows.length };
}

/**
 * The `cboe.options` line for each underlying whose chain was recorded.
 *
 * Nothing else creates it offline: `seed/universe.ts` mints the `cboe.quotes` line for every symbol
 * in the book but no options line, and at runtime `functions/DES/resolve.ts` calls
 * `tryEnsure(ctx, 'cboe.options', …)` when a user opens a chain — a hot-set decision the seed cannot
 * make for them. §18 row 9 is 3,510 contracts off `cboe-options`, and `jobs/cboeOptions.ts` polls
 * `cboe.options` lines, so the line is part of the row.
 *
 * The underlying is found through its `cboe.quotes` line rather than by ticker: the provider symbol
 * is the key both Cboe endpoints use, and resolving by it means the chain hangs off exactly the
 * instrument the top-of-book quote does.
 */
export async function ensureOptionChainLines(
  tx: Tx,
  symbols: readonly string[],
  o: { provenanceId: number; knownAt: Date },
): Promise<{ written: number; missing: string[] }> {
  const master = masterRepositories(tx);
  const missing: string[] = [];
  let written = 0;
  for (const symbol of symbols) {
    const res = await tx.execute<{ instrument_id: string }>(sql`
      SELECT instrument_id::text AS instrument_id
        FROM md_lines
       WHERE source_id = ${CBOE_QUOTES_SOURCE_ID}
         AND provider_symbol = ${symbol}
         AND tx_to = 'infinity'
         AND valid_from <= ${o.knownAt}::timestamptz
         AND valid_to   >  ${o.knownAt}::timestamptz
       ORDER BY md_line_id
       LIMIT 1`);
    const row = res.rows[0];
    if (row === undefined) {
      missing.push(symbol);
      continue;
    }
    const line = await master.mdLines.upsertBySymbol(
      {
        instrumentId: Number(row.instrument_id),
        sourceId: CBOE_OPTIONS_SOURCE_ID,
        providerSymbol: symbol,
        lineKind: 'composite',
        ...OPTION_LINE,
      },
      { validFrom: o.knownAt, provenanceId: o.provenanceId, knownAt: o.knownAt },
    );
    if (line.written) written += 1;
  }
  return { written, missing };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The warm start (§18 row 9)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `eod_snapshots.fields` — `plant/store.ts#eodJson`'s projection, which owns this shape. */
export function eodFieldsJson(view: EodView): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of EOD_FIELD_IDS) {
    const value = view.fields[id];
    if (value !== undefined && value !== null) out[id] = value;
  }
  // The flags travel under a key that is deliberately not a dictionary field id, so a reader that
  // looks fields up by id never sees it but a warm-started view can still say the close was
  // substituted (`plant/store.ts`).
  if (view.flags.length > 0) out._flags = [...view.flags];
  return out;
}

export interface WarmStartCounts {
  snapshots: number;
  snapshotsUnchanged: number;
  eod: number;
  eodUnchanged: number;
}

/**
 * Write the plant's composite state and official close for the polled top-of-book subjects.
 *
 * The four subjects are the ones with a `cboe.quotes` / `cboe.euIndices` line — AAPL, SPX, VIX and
 * the Cboe UK 100. The option chain is deliberately **not** warm-started: `cboe.options` publishes a
 * `q:<contractInstrumentId>` subject per contract in the ATM window (§5.2), and a warm start holding
 * forty stale option quotes would be noise a subscriber re-polls away in one tick, while §18 asks
 * for four rows. The chain's own values are in `option_quotes`, which is where OMON reads them.
 *
 * `updated_at` and the close instant are the capture instant, not `now()`, so the rows are a
 * function of the fixtures and the second run's `IS DISTINCT FROM` guard finds nothing to change.
 *
 * The close is the capture's own session with the `OFFICIAL_CLOSE_FROM_LAST` flag the builder adds:
 * the Cboe delayed feed publishes no official print and these captures were taken mid-session, so
 * the last trade stands in for the close **and the row says so**. That flag is the difference
 * between a warm start and a lie.
 *
 * **One measured caveat, recorded rather than hidden.** `eod_snapshots` is byte-stable across runs,
 * and so is every *number* in `quote_snapshots.state` — but the state cites the provenance of the
 * tick it was composed from (`state.prov.provenanceId` and one id per line, which is BUS-05's
 * per-field provenance), and each seed run inserts a new `provenance` row per replayed exchange
 * (PROVIDERS.a §1.3: one row per exchange, and a re-read is an exchange that happened again). So a
 * second run rewrites these four rows with the same numbers and newer provenance ids. The row
 * *count* is stable, which is what §18's acceptance row asks; a test that asserts "no row was
 * updated" will see these four, and the cause is the provenance rule, not this writer.
 */
export async function writeWarmStart(
  tx: Tx,
  plant: Plant,
  subjects: readonly { subject: string; instrumentId: number; provenanceId: number }[],
  o: { sessionDate: string; closeTsMs: number; updatedAt: string },
): Promise<WarmStartCounts> {
  const counts: WarmStartCounts = {
    snapshots: 0,
    snapshotsUnchanged: 0,
    eod: 0,
    eodUnchanged: 0,
  };
  for (const entry of subjects) {
    const state = plant.snapshot(entry.subject);
    if (state === undefined) continue;
    const snapshot = await tx.execute<{ instrument_id: string }>(sql`
      INSERT INTO quote_snapshots (instrument_id, subject, seq, state, updated_at)
      VALUES (${entry.instrumentId}::bigint, ${entry.subject}, ${state.seq}::bigint,
              ${JSON.stringify(state)}::jsonb, ${o.updatedAt}::timestamptz)
      ON CONFLICT (instrument_id) DO UPDATE
         SET subject = excluded.subject, seq = excluded.seq, state = excluded.state,
             updated_at = excluded.updated_at
       WHERE quote_snapshots.subject IS DISTINCT FROM excluded.subject
          OR quote_snapshots.seq IS DISTINCT FROM excluded.seq
          OR quote_snapshots.state IS DISTINCT FROM excluded.state
      RETURNING instrument_id`);
    if (snapshot.rows.length > 0) counts.snapshots += 1;
    else counts.snapshotsUnchanged += 1;

    const view = plant.captureEod(entry.subject, o.sessionDate, o.closeTsMs);
    if (view === null) continue;
    const eod = await tx.execute<{ instrument_id: string }>(sql`
      INSERT INTO eod_snapshots (instrument_id, session_date, fields, close_ts, provenance_id)
      VALUES (${entry.instrumentId}::bigint, ${view.sessionDate}::date,
              ${JSON.stringify(eodFieldsJson(view))}::jsonb,
              ${new Date(view.closeTs).toISOString()}::timestamptz, ${entry.provenanceId}::bigint)
      ON CONFLICT (instrument_id, session_date) DO UPDATE
         SET fields = excluded.fields, close_ts = excluded.close_ts,
             provenance_id = excluded.provenance_id
       WHERE eod_snapshots.fields IS DISTINCT FROM excluded.fields
          OR eod_snapshots.close_ts IS DISTINCT FROM excluded.close_ts
      RETURNING instrument_id`);
    if (eod.rows.length > 0) counts.eod += 1;
    else counts.eodUnchanged += 1;
  }
  return counts;
}

/** The `q:` subjects the plant holds for these instruments, with the provenance of their last tick. */
export function warmSubjectsOf(
  plant: Plant,
  instrumentIds: readonly number[],
): { subject: string; instrumentId: number; provenanceId: number }[] {
  const wanted = new Set(instrumentIds);
  const out: { subject: string; instrumentId: number; provenanceId: number }[] = [];
  for (const subject of plant.subjects()) {
    if (familyOf(subject) !== 'q') continue;
    const state = plant.snapshot(subject);
    if (state === undefined || !wanted.has(state.instrumentId)) continue;
    out.push({
      subject,
      instrumentId: state.instrumentId,
      provenanceId: state.prov.provenanceId,
    });
  }
  return out.sort((a, b) => a.instrumentId - b.instrumentId);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The module
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The tables modules 8 and 9 write (§18 rows 8-9). */
export const BARS_TABLES: readonly string[] = Object.freeze([
  'bars_daily',
  'bars_intraday',
  'fx_rates',
  'corporate_actions',
  'instruments',
  'option_terms',
  'option_quotes',
  'quote_ticks',
  'quote_snapshots',
  'eod_snapshots',
]);

/** Rows written, per table: the delta, so a second run reports zeros (§18). */
export type SeedBarsResult = Record<string, number>;

/**
 * Modules 8 and 9 (`seed/index.ts` order 5). One transaction, opened by the runner.
 *
 * Deterministic: every job and every backfill runs on a clock pinned to the capture instant of the
 * payload it is reading, so `ingest_runs`, the as-of reads inside `resolveTargets` and the session
 * gate of `cboeQuotes` all answer inside the recorded window. The only wall-clock read left in the
 * module is the one `db/bitemporal.ts` makes to refuse a future `tx_from`.
 */
export async function seedBars(ctx: SeedContext): Promise<SeedBarsResult> {
  // The same cast `ingest/scheduler.ts` L982 makes; see `seed/rates.ts`.
  const tx = ctx.db as unknown as Tx;
  const before = await countTables(tx, BARS_TABLES);
  const store = openReplayStore();
  const errors: string[] = [];
  let missingLines = 0;

  // Which legs this database already holds, decided BEFORE the module writes anything — see
  // `seed/fundamentals.ts#recordedLegs`. The snapshot has to be taken up front here for a concrete
  // reason: `citeCapture` below records the `frankfurter` and `cboe.options` captures so the md
  // lines have something to point at, and a gate evaluated at the job would then find the row the
  // line writer had just inserted and skip the job on a COLD database — 29 `fx_rates` and 3,510
  // `option_quotes` silently absent.
  //
  // Measured before this gate: a second `db:seed` re-ran all nine legs, writing thirteen
  // `provenance` rows and six `ingest_runs` rows for exchanges that never happened (replay reads a
  // file), and rewriting all four `quote_snapshots.state` blobs so their embedded
  // `state.prov.provenanceId` cited the newer rows. WORKPLAN L1552 asks for zero.
  //
  // The AAPL 1m/1d backfills share one manifest entry with two captures, so they share one gate: it
  // is satisfied only when BOTH digests are recorded, which is what makes the first run replay both.
  const dailyUrl = chartUrl({ symbol: 'AAPL', interval: '1d', range: '5y', events: true });
  const intradayUrl = chartUrl({ symbol: '^FTSE', interval: '5m', range: '1d' });
  const fxUrl = chartUrl({ symbol: 'EURUSD=X', interval: '5m', range: '1d' });
  // `Record<string, …>` rather than an inferred literal: the backfill gates are spread in from
  // `Object.fromEntries`, whose keys are `string`, and `backfillLeg` is the one thing that has to
  // agree with them.
  const legs: Record<string, readonly LegOutput[]> = {
    yahooDaily: [
      { table: 'bars_daily', captures: [{ sourceId: YAHOO_SOURCE_ID, url: dailyUrl }] },
    ],
    // Only `^FTSE`: `JOB_BACKFILL.yahooIntraday` also names `^TNX`, whose capture this seed never
    // reads because `seed/universe.ts` mints no `yahoo.chart` line for it (the log says "fetched 1"
    // for two symbols). Gating on a capture the leg does not consume would make the gate
    // unsatisfiable, and the leg would re-record `^FTSE` on every run — the failure mode the gate
    // was written for, arrived at from the other side.
    yahooIntraday: [
      { table: 'bars_intraday', captures: [{ sourceId: YAHOO_SOURCE_ID, url: intradayUrl }] },
    ],
    fxIntraday: [
      { table: 'bars_intraday', captures: [{ sourceId: YAHOO_SOURCE_ID, url: fxUrl }] },
    ],
    ...Object.fromEntries(
      CHART_BACKFILL.map((capture) => [
        backfillLeg(capture),
        [
          {
            table: capture.gate,
            captures: [
              {
                sourceId: YAHOO_SOURCE_ID,
                url: chartUrl({
                  symbol: capture.symbol,
                  interval: capture.interval,
                  range: capture.range,
                  ...(capture.events ? { events: true } : {}),
                }),
              },
            ],
          },
        ],
      ]),
    ),
    fxEod: [
      {
        table: 'fx_rates',
        captures: [{ sourceId: FRANKFURTER_SOURCE_ID, url: FRANKFURTER_LATEST_URL }],
      },
    ],
    cboeOptions: [
      {
        table: 'option_quotes',
        captures: [{ sourceId: CBOE_OPTIONS_SOURCE_ID, url: CBOE_OPTIONS_AAPL_URL }],
      },
    ],
    cboeQuotes: [
      {
        table: 'quote_ticks',
        captures: CBOE_BACKFILL.quotes.map((symbol) => ({
          sourceId: CBOE_QUOTES_SOURCE_ID,
          url: cboeQuoteUrl(symbol),
        })),
      },
    ],
    cboeEuIndices: [
      {
        table: 'quote_ticks',
        captures: [{ sourceId: CBOE_EU_SOURCE_ID, url: CBOE_EU_BUK100P_URL }],
      },
    ],
  };
  const recorded = await recordedLegs(ctx, legs);
  let legsAlreadyIngested = 0;

  /** Log the skip a gated leg takes, in the wording modules 10 and 11 already use. */
  const skip = (label: string): void => {
    legsAlreadyIngested += 1;
    ctx.log(`${label}: capture already in provenance — nothing to do`);
  };

  const fold = (label: string, job: MarketJobResult): void => {
    for (const error of job.errors) errors.push(`${label}: ${error.code} ${error.message}`);
    ctx.log(
      `${label}: fetched ${String(job.fetched)}, wrote ${String(job.inserted)}, restated ` +
        `${String(job.updated)}, unchanged ${String(job.skipped)}`,
    );
  };

  // ── module 8: the daily history and the dividends (yahoo-chart-events) ──────────────────────
  if (recorded.has('yahooDaily')) skip('yahooDaily AAPL 1d/5y');
  else {
    const daily = await runYahooDaily({
      tx,
      clock: pinnedClock(capturedAtOf(YAHOO_SOURCE_ID, dailyUrl)),
      replay: store,
      symbols: JOB_BACKFILL.yahooDaily,
    });
    fold('yahooDaily AAPL 1d/5y', daily);
  }

  // ── module 8: the two index/rate intraday captures ──────────────────────────────────────────
  if (recorded.has('yahooIntraday')) skip('yahooIntraday ^FTSE ^TNX 5m/1d');
  else {
    const intraday = await runYahooIntraday({
      tx,
      clock: pinnedClock(capturedAtOf(YAHOO_SOURCE_ID, intradayUrl)),
      replay: store,
      symbols: JOB_BACKFILL.yahooIntraday,
    });
    fold('yahooIntraday ^FTSE ^TNX 5m/1d', intraday);
  }

  // ── module 8: the one recorded FX pair ──────────────────────────────────────────────────────
  if (recorded.has('fxIntraday')) skip('fxIntraday EURUSD=X 5m/1d');
  else {
    const fxIntraday = await runFxIntraday({
      tx,
      clock: pinnedClock(capturedAtOf(YAHOO_SOURCE_ID, fxUrl)),
      replay: store,
      symbols: JOB_BACKFILL.fxIntraday,
    });
    fold('fxIntraday EURUSD=X 5m/1d', fxIntraday);
  }

  // ── module 8: the windows no scheduled poll asks for ────────────────────────────────────────
  for (const capture of CHART_BACKFILL) {
    const label = `backfill ${capture.symbol} ${capture.interval}/${capture.range} #${String(capture.captureIndex)}`;
    if (recorded.has(backfillLeg(capture))) {
      skip(label);
      continue;
    }
    const request = {
      symbol: capture.symbol,
      interval: capture.interval,
      range: capture.range,
      ...(capture.events ? { events: true } : {}),
    };
    const url = chartUrl(request);
    const capturedAt = storeAtCapture(store, YAHOO_SOURCE_ID, url, capture.captureIndex)
      .replay({ providerId: YAHOO_SOURCE_ID, url })
      .capturedAt;
    const jobCtx: MarketJobContext = {
      tx,
      clock: pinnedClock(capturedAt),
      replay: storeAtCapture(store, YAHOO_SOURCE_ID, url, capture.captureIndex),
    };
    const targets = await resolveTargets(jobCtx, YAHOO_SOURCE_ID, { instrumentIds: null });
    const target = targets.find((line) => line.providerSymbol === capture.symbol);
    if (target === undefined) {
      missingLines += 1;
      ctx.log(
        `no ${YAHOO_SOURCE_ID} md line for ${capture.symbol}: skipping ${capture.note} ` +
          '(seed/universe.ts owns the line — §18 rows 3-5)',
      );
      continue;
    }
    const jobResult = emptyResult();
    await ingestChart(jobCtx, {
      target,
      request,
      lines: linesOf(targets),
      options: {
        intraday: capture.write === 'intraday',
        daily: capture.write === 'daily',
        ...(capture.actions === 'none'
          ? {}
          : {
              extra: async (args: {
                provenanceId: number;
                rows: YahooChartRows;
                capturedAt: number;
              }) =>
                writeCorporateActions(tx, filterActions(args.rows.corporateActions, capture.actions), {
                  provenanceId: args.provenanceId,
                  capturedAt: args.capturedAt,
                }),
            }),
      },
      result: jobResult,
    });
    fold(label, jobResult);
  }

  // ── module 8: the ECB fixing ────────────────────────────────────────────────────────────────
  const frankfurterAt = capturedAtOf(FRANKFURTER_SOURCE_ID, FRANKFURTER_LATEST_URL);
  const fxLines = await ensureFxEodLines(tx, {
    provenanceId: await citeCapture(tx, FRANKFURTER_SOURCE_ID, FRANKFURTER_LATEST_URL),
    knownAt: new Date(frankfurterAt),
  });
  ctx.log(
    `frankfurter lines: ${String(fxLines.written)} written over ${String(fxLines.lines)} fx ` +
      "instruments (no 'USD' reference line: the universe has no US dollar instrument to hang it on)",
  );
  if (recorded.has('fxEod')) skip('fxEod frankfurter');
  else {
    const fxEod = await runFxEod({
      tx,
      clock: pinnedClock(frankfurterAt),
      replay: store,
    });
    fold('fxEod frankfurter', fxEod);
  }

  // ── module 9: the AAPL option chain ─────────────────────────────────────────────────────────
  //
  // No plant: `cboe.options` publishes one `q:` subject per contract in the ATM window, and those
  // are not warm-start subjects (see {@link writeWarmStart}). The chain's rows — 3,510 instruments,
  // `option_terms` and `option_quotes` — are written from `norm.rows`, not through the plant, so
  // leaving it out costs nothing but the forty updates nobody would read.
  const optionsAt = capturedAtOf(CBOE_OPTIONS_SOURCE_ID, CBOE_OPTIONS_AAPL_URL);
  const chainLines = await ensureOptionChainLines(tx, CBOE_BACKFILL.options, {
    provenanceId: await citeCapture(tx, CBOE_OPTIONS_SOURCE_ID, CBOE_OPTIONS_AAPL_URL),
    knownAt: new Date(optionsAt),
  });
  if (chainLines.missing.length > 0) {
    missingLines += chainLines.missing.length;
    ctx.log(
      `no ${CBOE_QUOTES_SOURCE_ID} line for ${chainLines.missing.join(', ')}: the option chain has ` +
        'no underlying to hang off (seed/universe.ts owns the quote line)',
    );
  }
  ctx.log(`${CBOE_OPTIONS_SOURCE_ID} lines: ${String(chainLines.written)} written`);
  if (recorded.has('cboeOptions')) skip('cboeOptions AAPL');
  else {
    const options = await runCboeOptions({
      tx,
      clock: pinnedClock(optionsAt),
      replay: store,
      symbols: CBOE_BACKFILL.options,
    });
    fold('cboeOptions AAPL', options);
  }

  // ── module 9: the four top-of-book captures and the warm start ──────────────────────────────
  const quotesAt = capturedAtOf(CBOE_QUOTES_SOURCE_ID, CBOE_QUOTE_AAPL_URL);
  const plant = buildPlant({ config: ctx.config, clock: pinnedClock(quotesAt) });
  if (recorded.has('cboeQuotes')) skip('cboeQuotes AAPL _SPX _VIX');
  else {
    const quotes = await runCboeQuotes({
      tx,
      clock: pinnedClock(quotesAt),
      replay: store,
      plant,
      symbols: CBOE_BACKFILL.quotes,
    });
    fold('cboeQuotes AAPL _SPX _VIX', quotes);
  }

  const euAt = capturedAtOf(CBOE_EU_SOURCE_ID, CBOE_EU_BUK100P_URL);
  if (recorded.has('cboeEuIndices')) skip('cboeEuIndices BUK100P');
  else {
    const eu = await runCboeEuIndices({
      tx,
      clock: pinnedClock(euAt),
      replay: store,
      plant,
      symbols: CBOE_BACKFILL.euIndices,
    });
    fold('cboeEuIndices BUK100P', eu);
  }

  const topOfBook = await topOfBookInstruments(tx, quotesAt);
  const warm = await writeWarmStart(tx, plant, warmSubjectsOf(plant, topOfBook), {
    sessionDate: sessionDateOf(quotesAt),
    closeTsMs: quotesAt,
    updatedAt: new Date(quotesAt).toISOString(),
  });
  ctx.log(
    `warm start: ${String(warm.snapshots)} quote_snapshots (${String(warm.snapshotsUnchanged)} ` +
      `unchanged), ${String(warm.eod)} eod_snapshots (${String(warm.eodUnchanged)} unchanged)`,
  );

  ctx.log(
    `option chain: ${String(await countOptionTerms(tx))} current option_terms versions; ` +
      `${String(missingLines)} capture(s) had no md line`,
  );
  if (errors.length > 0) {
    throw new Error(
      `seed/bars: ${String(errors.length)} capture(s) could not be read, so the module would have ` +
        `written a partial history:\n  ${errors.join('\n  ')}`,
    );
  }
  // `tableDeltas` compares row COUNTS, and that is the wrong instrument for the two snapshot
  // tables: `quote_snapshots` is keyed on `instrument_id` and holds a fixed four rows, so a run
  // that REWROTE all four states reported `quote_snapshots=0` while the detail line above said
  // "4 quote_snapshots (0 unchanged)". The summary was hiding the only thing a reader of it wants
  // to know. These two report rows CHANGED, which `writeWarmStart` already counts by comparing the
  // new state against the stored one (`IS DISTINCT FROM`), so an update can never read as a zero.
  return {
    ...tableDeltas(before, await countTables(tx, BARS_TABLES)),
    quote_snapshots: warm.snapshots,
    eod_snapshots: warm.eod,
    legsAlreadyIngested,
  };
}

/**
 * Only the actions a capture is being taken for — see {@link CorporateActionFilter}.
 *
 * `'splits'` keeps both split directions: `providers/yahoo/parse.ts` L590 reads a ratio below 1 as a
 * `reverse_split`, and a filter that named only `'split'` would drop a consolidation from the one
 * file that carries the split history.
 */
export function filterActions(
  actions: YahooChartRows['corporateActions'],
  filter: CorporateActionFilter,
): YahooChartRows['corporateActions'] {
  if (filter === 'all') return actions;
  if (filter === 'none') return [];
  return actions.filter(
    (action) => action.caType === 'split' || action.caType === 'reverse_split',
  );
}

/**
 * The instruments with a top-of-book line at `atMs` — `cboe.quotes` and `cboe.euIndices`.
 *
 * Read from `md_lines` rather than from the plant's subject list so that the warm start covers
 * exactly the lines a running terminal polls, and so that an instrument the ATM option window
 * happened to publish never acquires a `quote_snapshots` row.
 */
async function topOfBookInstruments(tx: Tx, atMs: number): Promise<number[]> {
  const res = await tx.execute<{ instrument_id: string }>(sql`
    SELECT DISTINCT instrument_id::text AS instrument_id
      FROM md_lines
     WHERE source_id IN (${CBOE_QUOTES_SOURCE_ID}, ${CBOE_EU_SOURCE_ID})
       AND tx_to = 'infinity'
       AND valid_from <= to_timestamp(${atMs}::double precision / 1000.0)
       AND valid_to   >  to_timestamp(${atMs}::double precision / 1000.0)
     ORDER BY instrument_id`);
  return res.rows.map((row) => Number(row.instrument_id)).sort((a, b) => a - b);
}

/** Current `option_terms` versions — the contract count §18 row 9 fixes at 3,510. */
async function countOptionTerms(tx: Tx): Promise<number> {
  const res = await tx.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM option_terms WHERE tx_to = 'infinity'`);
  return Number(res.rows[0]?.n ?? '0');
}

/** Modules 8-9 of the ordered seed runner (`seed/index.ts`). */
export const seed = seedBars;
