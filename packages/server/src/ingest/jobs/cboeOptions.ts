/**
 * `ingest/jobs/cboeOptions.ts` — the full Cboe chain (PROVIDERS §5.2, §13).
 *
 * §13: `cboe.options`, `{everyMs: 60000}` for underlyings with an `oc:` or option `q:` subscriber
 * and daily otherwise, priority 1, 30 s. The payload is 1.5 MB and carries 3,510 contracts for a
 * name like AAPL, so the job is never speculative: an underlying nobody is looking at is polled
 * once a day for terms, and `cacheTtlMs 0` with `If-None-Match` keeps the 60-second poll free when
 * the chain has not moved.
 *
 * ## The minting round trip, and why it happens inside one run
 *
 * `option_quotes.instrument_id` is the *contract's* instrument, which only exists once this job has
 * minted it. The parser can only report what `ctx.resolveInstrument` told it, so a chain seen for
 * the first time comes back with `instrumentId: null` on every contract. Writing the quotes on the
 * next poll instead would make the first run write 0 rows and the second write 3,510 — the exact
 * opposite of idempotent. So one run does the whole round trip:
 *
 * ```
 * resolve OCC → instrument_id from `identifiers`      (empty on a first sight)
 * normalise                                           contracts[].instrumentId = null for new ones
 * mint instruments + identifiers + option_terms       for the null ones only
 * re-resolve                                          every contract now has an id
 * write option_quotes                                 3,510 rows, keyed (capture_ts, instrument_id)
 * ```
 *
 * The second run over the same capture resolves every contract from `identifiers`, mints nothing,
 * and finds every `option_quotes` row already saying exactly this — 0 inserted, 0 updated.
 *
 * ## Why the mint is three bulk inserts and not 3,510 repository calls
 *
 * `InstrumentRepository.insert` is the right tool for one instrument and the wrong one for a chain:
 * it costs a `nextval` round trip plus a `writeVersion` per row, which is ~10,000 statements for one
 * AAPL poll on a job with a 30-second timeout. A contract that does not exist yet has no version to
 * close, so its *initial* version is a plain `INSERT` — the bitemporal machinery exists to close and
 * reopen ranges, and there is nothing to close. The ids come from one `generate_series` over
 * `instrument_id_seq`, and the three tables are filled in chunks. Contracts that already exist are
 * skipped entirely: their terms do not change, and re-asserting them would write a version per poll.
 *
 * ## What reaches the plant
 *
 * Only contracts that are subscribed, or within ±10 strikes of the money on the front three
 * expiries (the parser's ATM window). The rest are persisted and not fanned out, because the plant
 * is not a database and 3,510 subjects a minute per underlying is not a quote feed.
 */

import { sql } from 'drizzle-orm';

import {
  cboeOptionsAdapter,
  cboeOptionsUrl,
  CBOE_ADAPTER_VERSION,
} from '../../providers/cboe/adapter.js';
import { normaliseChain } from '../../providers/cboe/parse.js';
import {
  emptyResult,
  fetchError,
  fetchThrough,
  insertQuoteTicks,
  linesOf,
  normaliseWithProvenance,
  publish,
  requestEnvelope,
  resolveTargets,
  sessionAt,
  tally,
  upsertOptionQuotes,
  US_EQUITY_CALENDAR,
  withIngestRun,
} from './cboeQuotes.js';

import type { Tx } from '../../db/client.js';
import type { CboeContractRow, CboeOptionQuoteRow } from '../../providers/cboe/parse.js';
import type { NormaliseLine, ProviderId, RawRecord } from '../../providers/types.js';
import type {
  MarketJobContext,
  MarketJobResult,
  OptionQuoteInput,
  TargetLine,
} from './cboeQuotes.js';

export const CBOE_OPTIONS_SOURCE_ID = 'cboe.options' satisfies ProviderId;

/** §13 `cboeOptions`: `{everyMs: 60000}`; underlyings with no option subscriber go daily. */
export const CBOE_OPTIONS_SCHEDULE = { everyMs: 60_000 } as const;

/** Postgres caps a statement at 65 535 bind parameters; 250 × 19 stays far inside it. */
const MINT_CHUNK = 250;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * OCC symbol → contract `instrument_id`, from the current `identifiers` versions.
 *
 * Scoped by the OCC root (`AAPL`) rather than loaded whole: an `identifiers` table with every
 * option ever listed is millions of rows, and this job only ever asks about one underlying's chain.
 */
export async function resolveContracts(
  tx: Tx,
  root: string,
  atMs: number,
): Promise<Map<string, number>> {
  const res = await tx.execute<{ value: string; entity_id: string | number }>(sql`
    SELECT value, entity_id
      FROM identifiers
     WHERE scheme = 'OCC'
       AND entity_kind = 'instrument'
       AND value LIKE ${`${root}%`}
       AND tx_to = 'infinity'
       AND valid_from <= to_timestamp(${atMs}::double precision / 1000.0)
       AND valid_to   >  to_timestamp(${atMs}::double precision / 1000.0)`);
  const map = new Map<string, number>();
  for (const row of res.rows) map.set(row.value, Number(row.entity_id));
  return map;
}

/** The underlying's `issue_id` — an option contract belongs to the same issue as its underlying. */
export async function issueOfInstrument(
  tx: Tx,
  instrumentId: number,
  atMs: number,
): Promise<number | null> {
  const res = await tx.execute<{ issue_id: string | number }>(sql`
    SELECT issue_id
      FROM instruments
     WHERE instrument_id = ${instrumentId}::bigint
       AND tx_to = 'infinity'
       AND valid_from <= to_timestamp(${atMs}::double precision / 1000.0)
       AND valid_to   >  to_timestamp(${atMs}::double precision / 1000.0)
     LIMIT 1`);
  const row = res.rows[0];
  return row === undefined ? null : Number(row.issue_id);
}

/** `n` fresh ids from `instrument_id_seq`, in one round trip. */
export async function nextInstrumentIds(tx: Tx, n: number): Promise<number[]> {
  if (n <= 0) return [];
  const res = await tx.execute<{ id: string | number }>(sql`
    SELECT nextval('instrument_id_seq') AS id FROM generate_series(1, ${n}::int)`);
  return res.rows.map((row) => Number(row.id));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Minting
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface MintResult {
  /** OCC symbol → the instrument id now backing it, for every contract in the chain. */
  ids: Map<string, number>;
  /** Contracts minted by this call. */
  minted: number;
}

/**
 * Mint `instruments`, `identifiers` and `option_terms` for every contract that has none.
 *
 * All three are *initial* versions of entities that did not exist a statement ago, so they are
 * plain inserts: `valid_from` is the capture instant (the instant we first knew the contract is
 * listed), `valid_to` is `'infinity'`, and there is no previous version for `bt_excl` to collide
 * with. `tx_from` is left to the database's `now()`, which is the transaction's own clock.
 *
 * @returns the full OCC → instrument id map, existing rows included.
 */
export async function mintContracts(
  tx: Tx,
  args: {
    contracts: readonly CboeContractRow[];
    known: ReadonlyMap<string, number>;
    underlyingInstrumentId: number;
    issueId: number;
    provenanceId: number;
    capturedAt: number;
  },
): Promise<MintResult> {
  const ids = new Map<string, number>(args.known);
  const missing: CboeContractRow[] = [];
  const seen = new Set<string>();
  for (const contract of args.contracts) {
    if (ids.has(contract.occSymbol) || seen.has(contract.occSymbol)) continue;
    seen.add(contract.occSymbol);
    missing.push(contract);
  }
  if (missing.length === 0) return { ids, minted: 0 };

  const fresh = await nextInstrumentIds(tx, missing.length);
  const validFrom = new Date(args.capturedAt).toISOString();

  for (let offset = 0; offset < missing.length; offset += MINT_CHUNK) {
    const chunk = missing.slice(offset, offset + MINT_CHUNK);
    const at = (i: number): number => fresh[offset + i]!;

    await tx.execute(sql`
      INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                               exch_code, name, currency, status, price_decimals,
                               valid_from, provenance_id)
      SELECT t.instrument_id, ${args.issueId}::bigint, 'option'::asset_class,
             'Equity'::market_sector, t.occ_symbol, 'US', t.name, 'USD', 'active', 2,
             ${validFrom}::timestamptz, ${args.provenanceId}::bigint
        FROM unnest(
               ${sql.param(chunk.map((_, i) => at(i)))}::bigint[],
               ${sql.param(chunk.map((c) => c.occSymbol))}::text[],
               ${sql.param(chunk.map(contractName))}::text[]
             ) AS t(instrument_id, occ_symbol, name)`);

    await tx.execute(sql`
      INSERT INTO identifiers (entity_kind, entity_id, scheme, value, qualifier, is_primary,
                               valid_from, provenance_id)
      SELECT 'instrument'::entity_kind, t.instrument_id, 'OCC'::id_scheme, t.occ_symbol, '', true,
             ${validFrom}::timestamptz, ${args.provenanceId}::bigint
        FROM unnest(
               ${sql.param(chunk.map((_, i) => at(i)))}::bigint[],
               ${sql.param(chunk.map((c) => c.occSymbol))}::text[]
             ) AS t(instrument_id, occ_symbol)`);

    await tx.execute(sql`
      INSERT INTO option_terms (instrument_id, occ_symbol, root, underlying_instrument_id, expiry,
                                strike, put_call, exercise_style, settlement, am_pm_settlement,
                                multiplier, tick_size, is_weekly, last_trade_date,
                                valid_from, provenance_id)
      SELECT t.instrument_id, t.occ_symbol, t.root, ${args.underlyingInstrumentId}::bigint,
             t.expiry::date, t.strike::numeric, t.put_call, t.exercise_style, t.settlement,
             t.am_pm, t.multiplier::integer, t.tick_size::numeric, t.is_weekly,
             t.last_trade_date::date, ${validFrom}::timestamptz, ${args.provenanceId}::bigint
        FROM unnest(
               ${sql.param(chunk.map((_, i) => at(i)))}::bigint[],
               ${sql.param(chunk.map((c) => c.occSymbol))}::text[],
               ${sql.param(chunk.map((c) => c.root))}::text[],
               ${sql.param(chunk.map((c) => c.expiry))}::text[],
               ${sql.param(chunk.map((c) => c.strike.toFixed(4)))}::text[],
               ${sql.param(chunk.map((c) => c.putCall))}::text[],
               ${sql.param(chunk.map((c) => c.exerciseStyle))}::text[],
               ${sql.param(chunk.map((c) => c.settlement))}::text[],
               ${sql.param(chunk.map((c) => c.amPmSettlement))}::text[],
               ${sql.param(chunk.map((c) => c.multiplier))}::int[],
               ${sql.param(chunk.map((c) => c.tickSize.toFixed(4)))}::text[],
               ${sql.param(chunk.map((c) => c.isWeekly))}::boolean[],
               ${sql.param(chunk.map((c) => c.lastTradeDate))}::text[]
             ) AS t(instrument_id, occ_symbol, root, expiry, strike, put_call, exercise_style,
                    settlement, am_pm, multiplier, tick_size, is_weekly, last_trade_date)`);

    chunk.forEach((contract, i) => ids.set(contract.occSymbol, at(i)));
  }

  return { ids, minted: missing.length };
}

/** `instruments.name` for a contract — the human form of the OCC symbol, never the symbol twice. */
export function contractName(contract: CboeContractRow): string {
  const right = contract.putCall === 'C' ? 'Call' : 'Put';
  return `${contract.root} ${contract.expiry} ${contract.strike.toFixed(2)} ${right}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** OCC symbols with a live `q:` subscriber — §5.2: they always produce a plant update. */
export function subscribedOccOf(
  ctx: MarketJobContext,
  known: ReadonlyMap<string, number>,
): Set<string> {
  const subscribed = new Set<string>();
  if (ctx.hotset === undefined) return subscribed;
  for (const [occ, instrumentId] of known) {
    if (ctx.hotset.subscriberCount(`q:${String(instrumentId)}`) > 0) subscribed.add(occ);
  }
  return subscribed;
}

/** Poll one underlying's chain, end to end. Exported so a seed or a test can drive one name. */
export async function ingestChain(
  ctx: MarketJobContext,
  args: {
    target: TargetLine;
    lines: ReadonlyMap<string, NormaliseLine>;
    result: MarketJobResult;
  },
): Promise<void> {
  const { target, result } = args;
  const url = cboeOptionsUrl(target.providerSymbol);

  let raw: RawRecord;
  try {
    raw = await fetchThrough(
      ctx,
      cboeOptionsAdapter,
      { providerSymbol: target.providerSymbol, ...requestEnvelope(ctx) },
      url,
    );
  } catch (err) {
    result.errors.push(fetchError(err, url));
    return;
  }
  if (raw.status === 304) {
    result.skipped += 1;
    return;
  }
  result.fetched += 1;

  const known = await resolveContracts(ctx.tx, target.providerSymbol, raw.capturedAt);
  const session = sessionAt(ctx.clock.now(), US_EQUITY_CALENDAR);
  const subscribedOcc = subscribedOccOf(ctx, known);

  const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
    raw,
    adapterVersion: CBOE_ADAPTER_VERSION,
    lines: args.lines,
    resolveInstrument: (key) => (key.scheme === 'OCC' ? (known.get(key.value) ?? null) : null),
    normalise: (r, nctx) =>
      normaliseChain(r, nctx, {
        sourceId: CBOE_OPTIONS_SOURCE_ID,
        ...(session === undefined ? {} : { session }),
        subscribedOcc,
      }),
  });
  result.provenanceIds.push(provenanceId);
  result.problems.push(...norm.problems);
  result.published += publish(ctx, norm.updates, result.errors);

  // The underlying quote travels in the same payload on its own md line (§5.2 step 1).
  tally(result, await insertQuoteTicks(ctx.tx, norm.rows.quoteTicks, provenanceId));

  const issueId = await issueOfInstrument(ctx.tx, target.instrumentId, raw.capturedAt);
  if (issueId === null) {
    result.errors.push({
      code: 'UNDERLYING_NOT_FOUND',
      message:
        `no current instruments row for underlying ${String(target.instrumentId)} ` +
        `(${target.providerSymbol}); its chain cannot be minted without an issue_id`,
      url,
    });
    return;
  }

  const mint = await mintContracts(ctx.tx, {
    contracts: norm.rows.contracts,
    known,
    underlyingInstrumentId: target.instrumentId,
    issueId,
    provenanceId,
    capturedAt: raw.capturedAt,
  });
  result.inserted += mint.minted;

  const quotes = resolveQuotes(norm.rows.optionQuotes, mint.ids);
  if (quotes.unresolved > 0) {
    result.problems.push({
      kind: 'unknown_symbol',
      detail:
        `${String(quotes.unresolved)} contract quote(s) in the ${target.providerSymbol} chain ` +
        'could not be tied to an instrument even after minting',
      path: '/data/options',
    });
  }
  tally(result, await upsertOptionQuotes(ctx.tx, quotes.rows, provenanceId));

  ctx.log?.info?.('cboeOptions.chain', {
    underlying: target.providerSymbol,
    contracts: norm.rows.chain.contractCount,
    minted: mint.minted,
    plantContracts: norm.rows.chain.plantContractCount,
    crossed: norm.rows.chain.crossedCount,
    atmIv: norm.rows.chain.atmIv,
    putCallRatio: norm.rows.chain.putCallRatio,
  });
}

/** Fill in the contract ids the mint just allocated; a quote with none is dropped, not guessed. */
export function resolveQuotes(
  rows: readonly CboeOptionQuoteRow[],
  ids: ReadonlyMap<string, number>,
): { rows: OptionQuoteInput[]; unresolved: number } {
  const out: OptionQuoteInput[] = [];
  let unresolved = 0;
  for (const row of rows) {
    const instrumentId = row.instrumentId ?? ids.get(row.occSymbol) ?? null;
    if (instrumentId === null) {
      unresolved += 1;
      continue;
    }
    out.push({
      captureTs: row.captureTs,
      instrumentId,
      underlyingInstrumentId: row.underlyingInstrumentId,
      mdLineId: row.mdLineId,
      bid: row.bid,
      ask: row.ask,
      bidSize: row.bidSize,
      askSize: row.askSize,
      last: row.last,
      lastTs: row.lastTs,
      prevClose: row.prevClose,
      volume: row.volume,
      openInterest: row.openInterest,
      iv: row.iv,
      delta: row.delta,
      gamma: row.gamma,
      vega: row.vega,
      theta: row.theta,
      rho: row.rho,
      theo: row.theo,
      underlyingPx: row.underlyingPx,
    });
  }
  return { rows: out, unresolved };
}

/** Poll every `cboe.options` line in the hot set (§5.2, §13). */
export async function runCboeOptions(ctx: MarketJobContext): Promise<MarketJobResult> {
  return withIngestRun(ctx, { id: 'cboeOptions', sourceId: CBOE_OPTIONS_SOURCE_ID }, async () => {
    const result = emptyResult();
    const targets = await resolveTargets(ctx, CBOE_OPTIONS_SOURCE_ID);
    if (targets.length === 0) {
      ctx.log?.info?.('cboeOptions.no_targets', { sourceId: CBOE_OPTIONS_SOURCE_ID });
      return result;
    }

    const lines = linesOf(targets);
    for (const target of targets) {
      await ingestChain(ctx, { target, lines, result });
    }

    ctx.log?.info?.('cboeOptions.done', {
      underlyings: targets.length,
      fetched: result.fetched,
      inserted: result.inserted,
      updated: result.updated,
      unchanged: result.skipped,
    });
    return result;
  });
}

/** The scheduler row (PROVIDERS §13). */
export const job = {
  id: 'cboeOptions',
  schedule: CBOE_OPTIONS_SCHEDULE,
  provider: CBOE_OPTIONS_SOURCE_ID,
  priority: 1 as const,
  timeoutMs: 30_000,
  run: (ctx: MarketJobContext): Promise<MarketJobResult> => runCboeOptions(ctx),
};
