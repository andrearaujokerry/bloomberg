/**
 * `functions/CRYP/resolve.ts` — the crypto monitor (FUNCTIONS.md §7.3, the normative worked
 * example; FUNCTIONS_TIER3.md §CRYP reproduces it with five completions).
 *
 * The screen's whole job is to be honest about what it is showing, so this file is written around
 * three things that would each be a fabrication:
 *
 *  1. **There is no exchange feed.** `caveat: 'CONTEXT_ONLY_NOT_EXCHANGE_DATA'` is on every payload,
 *     unconditionally. It is not a degradation badge and never has to be earned by a failure.
 *  2. **There is no previous close.** CoinGecko publishes a *rolling* 24-hour change. The landed
 *     WP-05 adapter reconstructs the level 24 hours ago into `PX_CLOSE_1D`
 *     (`providers/coingecko/parse.ts#impliedPrevClose`, which flags it `impliedPrevCloseIsRolling`)
 *     and `core/quote/derive.ts` derives `CHG_PCT_1D` from the pair. So the number this screen
 *     shows *is* the rolling 24-hour move, round-tripped through the reconstruction and rounded to
 *     the four decimals `derive.ts` publishes at — and the column is named `chg24hPct` rather than
 *     a change-since-close. A `NOT_APPLICABLE` note on `PX_CLOSE_1D` says the same in `meta`.
 *
 *     **Deviation from §7.3 step 4, forced by the landed pipeline and reported.** The example says
 *     the adapter normalises `usd_24h_change` into `CHG_PCT_1D`. It does not — nothing in the store
 *     carries `usd_24h_change` — so the fixture's `-4.217368765220806` reaches the payload as
 *     `-4.2174`. Reconstructing the raw figure here would mean a second, private path for a number
 *     the wire and the WebSocket cell compute the other way, and the live cell would then disagree
 *     with the resolved one on first tick. The pipeline wins; the precision loss is stated.
 *  3. **An id with no source is not a row full of zeros.** `solana` and `ripple` are in the enum
 *     and in the security master, and the recorded CoinGecko response answers neither. They come
 *     back as rows with blank cells, a reason code and a `meta.unavailable` entry naming the id —
 *     never an interpolated or last-known price (§CRYP completion 2).
 *
 * Budget (§7.3): one DB query, zero provider calls when hot.
 */

import { sql } from 'drizzle-orm';

import type { ValueCell } from '@terminal/core';
import type { CrypId, CrypParams, CrypPayload, CrypRow } from '@terminal/core/functions/manifests/CRYP';
import {
  CRYP_CAVEAT,
  CRYP_NO_CLOSE_DETAIL,
  CRYP_NO_SOURCE_DETAIL,
  CRYP_TICKERS,
} from '@terminal/core/functions/manifests/CRYP';

import type { GatedQuoteState, ResolveContext } from '../context.js';
import { cellFromState, pendingCell } from '../shared/cells.js';
import { displayOf } from '../shared/instrumentSummary.js';

export const code = 'CRYP';

/** The store is allowed to be a minute old before the resolver reaches for the provider (§7.3). */
const MAX_AGE_MS = 60_000;

interface UniverseRow extends Record<string, unknown> {
  instrument_id: string;
  ticker: string;
  name: string;
  exch_code: string;
  market_sector: string;
  provider_symbol: string | null;
  provenance_id: string;
  source_id: string;
  captured_at: string;
  source_ts: string | null;
}

/**
 * Every seeded crypto instrument the requested ids can name, with its CoinGecko line when it has
 * one — one statement, which is the whole DB budget of this screen.
 *
 * The `md_lines` join is a LEFT join on purpose. §7.3 step 1 matches on `provider_symbol`, and an
 * inner join would simply drop an id whose instrument exists but whose line does not — which is the
 * `solana`/`ripple` case, and the one the screen most needs to *show* with a reason rather than
 * hide. The ticker map is what lets that row be named at all.
 */
async function universe(
  ctx: ResolveContext,
  ids: readonly CrypId[],
): Promise<Map<string, UniverseRow>> {
  const tickers = ids.map((id) => CRYP_TICKERS[id]);
  const validAt = ctx.asOf.validAt;
  const knownAt = ctx.asOf.knownAt;
  const res = await ctx.db.execute<UniverseRow>(sql`
    SELECT i.instrument_id::text        AS instrument_id,
           i.ticker, i.name, i.exch_code,
           i.market_sector::text        AS market_sector,
           m.provider_symbol,
           COALESCE(m.provenance_id, i.provenance_id)::text AS provenance_id,
           p.source_id,
           to_char(p.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
           to_char(p.source_ts   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS source_ts
      FROM instruments i
      LEFT JOIN md_lines m
        ON m.instrument_id = i.instrument_id
       AND m.source_id = 'coingecko.simple'
       AND m.provider_symbol = ANY(${sql.param(ids)}::text[])
       AND bt_as_of(m.valid_from, m.valid_to, m.tx_from, m.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
      LEFT JOIN provenance p
        ON p.provenance_id = COALESCE(m.provenance_id, i.provenance_id)
     WHERE i.asset_class = 'crypto'
       AND i.ticker = ANY(${sql.param(tickers)}::text[])
       AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
     ORDER BY i.ticker`);

  const byTicker = new Map<string, UniverseRow>();
  for (const row of res.rows) {
    // A ticker with two current rows is a master defect, not a reason to show two lines: the first
    // in ticker order wins and the payload is deterministic either way.
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, row);
  }
  return byTicker;
}

/** `provenance` row → a `meta.provenance` index, or `-1` when the row carries none. */
function cite(ctx: ResolveContext, row: UniverseRow): number {
  const provenanceId = Number(row.provenance_id);
  if (!Number.isInteger(provenanceId) || provenanceId <= 0) return -1;
  if (row.source_id === null || row.captured_at === null) return -1;
  return ctx.prov.add({
    sourceId: row.source_id,
    provenanceId,
    capturedAt: new Date(row.captured_at),
    sourceTs: row.source_ts === null ? null : new Date(row.source_ts),
    st: 'closed',
    tier: 'delayed',
  });
}

/**
 * A cell for an id that has no CoinGecko line at all (§CRYP completion 2).
 *
 * `NOT_IN_UNIVERSE`, not `PROVIDER_DOWN`. The two say opposite things about the same fact and the
 * cell used to contradict the footer: the `meta.unavailable` entry raised beside it records
 * `NO_SOURCE` — this id has no line — while the cell told the reader CoinGecko was unreachable.
 * FUNCTIONS.md §7.3 reserves `PROVIDER_DOWN` for a provider that could not be refreshed, and TERM-12
 * has *those* cells go `stale` carrying their last values rather than blank. `NOT_IN_UNIVERSE` is
 * the cell vocabulary's word for the footer's `NO_SOURCE`, and the code SRCH, SWPM and WIRP already
 * use for a row the plant holds nothing for. The `providers.ensure` failure path keeps its own
 * `meta` entry and leaves the cells exactly as they were.
 */
function noSourceCell(provIdx: number): ValueCell {
  return { v: null, st: 'blank', r: 'NOT_IN_UNIVERSE', provIdx };
}

/** The instant a row is as of: the quote's own source time, else its capture, else the reference row's. */
function asOfOf(state: GatedQuoteState | undefined, fallback: string): string {
  if (state === undefined) return fallback;
  const ms = state.ts.src ?? state.ts.cap;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

export async function resolve(ctx: ResolveContext, params: CrypParams): Promise<CrypPayload> {
  // ── 1. ids → instruments ────────────────────────────────────────────────────────────────────
  const byTicker = await universe(ctx, params.ids);

  interface Candidate {
    id: CrypId;
    row: UniverseRow;
    instrumentId: number;
    subject: string;
    /** True when a `coingecko.simple` line exists for this id — i.e. the id is really seeded. */
    seeded: boolean;
    provIdx: number;
  }

  const candidates: Candidate[] = [];
  for (const id of params.ids) {
    const row = byTicker.get(CRYP_TICKERS[id]);
    if (row === undefined) {
      // Neither a line nor an instrument: nothing to show, and the reason is the id itself.
      ctx.unavailable.add({ field: id, reason: 'NO_SOURCE', detail: CRYP_NO_SOURCE_DETAIL });
      continue;
    }
    const instrumentId = Number(row.instrument_id);
    const seeded = row.provider_symbol === id;
    if (!seeded) {
      ctx.unavailable.add({ field: id, reason: 'NO_SOURCE', detail: CRYP_NO_SOURCE_DETAIL });
    }
    candidates.push({
      id,
      row,
      instrumentId,
      subject: ctx.plant.subjectFor(instrumentId),
      seeded,
      provIdx: cite(ctx, row),
    });
  }

  // ── 2. the plant ────────────────────────────────────────────────────────────────────────────
  const live = candidates.filter((c) => c.seeded);
  const subjects = live.map((c) => c.subject);
  ctx.plant.ensureHot(subjects);
  let states = ctx.plant.snapshotMany(subjects);

  // ── 3. one read-through when a seeded subject has nothing, then look again ───────────────────
  const blank = live.some((c) => {
    const state = states.get(c.subject);
    return state === undefined || state.state === 'blank';
  });
  if (blank && live.length > 0) {
    try {
      await ctx.providers.ensure('coingecko.simple', live.map((c) => c.id).join(','), {
        maxAgeMs: MAX_AGE_MS,
      });
      states = ctx.plant.snapshotMany(subjects);
    } catch (err: unknown) {
      // TERM-12: a provider that cannot be reached leaves the cells as they are — stale values
      // stay on screen with their own state — and the screen says so. It is never a 503: a monitor
      // that refuses to render because one fetch failed is worse than one that renders what it has.
      ctx.unavailable.add({
        field: 'source',
        reason: 'NO_SOURCE',
        detail: `coingecko.simple could not be refreshed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ── 4. rows ─────────────────────────────────────────────────────────────────────────────────
  const rows: CrypRow[] = candidates.map((candidate) => {
    const state = candidate.seeded ? states.get(candidate.subject) : undefined;
    const px = !candidate.seeded
      ? noSourceCell(candidate.provIdx)
      : state === undefined
        ? pendingCell(candidate.subject, 'PX_LAST')
        : cellFromState(ctx, state, 'PX_LAST', candidate.subject);
    const chg = !candidate.seeded
      ? noSourceCell(candidate.provIdx)
      : state === undefined
        ? pendingCell(candidate.subject, 'CHG_PCT_1D')
        : cellFromState(ctx, state, 'CHG_PCT_1D', candidate.subject);
    return {
      instrumentId: candidate.instrumentId,
      key: displayOf(
        candidate.row.ticker,
        candidate.row.exch_code,
        candidate.row.market_sector as Parameters<typeof displayOf>[2],
      ),
      name: candidate.row.name,
      coingeckoId: candidate.id,
      px,
      chg24hPct: chg,
      asOf: asOfOf(state, candidate.row.captured_at ?? ctx.asOf.validAt.toISOString()),
    };
  });

  // The change column is a rolling 24-hour move. Saying so in `meta` costs one entry and is the
  // difference between a reader trusting a session boundary that does not exist and knowing there
  // is none (FUNCTIONS.md §1.3 rule 6's spirit: state the absence, do not paper over it).
  ctx.unavailable.add({
    field: 'PX_CLOSE_1D',
    reason: 'NOT_APPLICABLE',
    detail: CRYP_NO_CLOSE_DETAIL,
  });

  // ── 5. sort ─────────────────────────────────────────────────────────────────────────────────
  const numberOf = (cell: ValueCell): number | null =>
    typeof cell.v === 'number' && Number.isFinite(cell.v) ? cell.v : null;
  const desc = (a: number | null, b: number | null, tie: number): number => {
    if (a === null && b === null) return tie;
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a === 0 ? tie : b - a;
  };
  rows.sort((a, b) => {
    const tie = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    switch (params.sort) {
      case 'px':
        return desc(numberOf(a.px), numberOf(b.px), tie);
      case 'chg':
        return desc(numberOf(a.chg24hPct), numberOf(b.chg24hPct), tie);
      default:
        return a.name < b.name ? -1 : a.name > b.name ? 1 : tie;
    }
  });

  return { variant: 'default', rows, source: 'coingecko.simple', caveat: CRYP_CAVEAT };
}
