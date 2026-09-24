/**
 * `functions/OMON/resolve.ts` — the listed option chain (FUNCTIONS_TIER3.md §OMON).
 *
 * OMON publishes **the exchange's own marks**. Every implied volatility and every greek on a leg
 * is the number `cboe.options` carries in the chain file, cited to the capture that produced it;
 * this resolver derives four things and nothing else:
 *
 *  1. `mid` — `(bid + ask) / 2` when the market is two-sided and uncrossed;
 *  2. the put/call volume and open-interest ratios, over **every** contract of the selected
 *     expiry rather than over the strike window on screen;
 *  3. the ATM strike (the listed strike nearest spot) and the ATM implied volatility;
 *  4. the SVI smile, from `vol.surface@1.0.0`, registered in `meta.engines[]` (ANAL-04, ANAL-08).
 *
 * Three rules shape the file.
 *
 * **A gap in the listing is a gap, not a blank row.** A strike quoted on one side only carries
 * `call: null` or `put: null`; nothing is fabricated to square the grid, and an underlying with no
 * listed options returns `rows: []` with a `meta.unavailable` entry rather than a synthetic ladder.
 *
 * **A published number and a derived number never wear the same badge.** `ivPct`, `delta`,
 * `gamma`, `vega`, `theta`, `rho` and `theo` cite `provIdx_chain`, the Cboe capture. `mid` cites
 * the same capture because both its inputs do, and the constant caveat `PROVIDER_GREEKS_CBOE`
 * states which half of the screen is whose. The fitted smile cites no provenance index at all: it
 * is an engine output and lives in `meta.engines[]`.
 *
 * **Every deep-in-the-money implied volatility is marked and excluded.** `ivSuspect` is
 * `|delta| > 0.99 || |100 × (spot/strike − 1)| > 25`; a suspect leg still shows its number — it is
 * what the exchange published — but it is kept out of the ATM average and out of the SVI fit,
 * because a vol read off a near-zero vega is noise wearing a number's clothes.
 *
 * Deviations from §OMON, with the reason:
 *
 *  * **One `meta.unavailable` entry per null leg column.** §OMON says a one-sided quote produces
 *    no entry. WP-10's runner refuses any null `ValueCell` under a numeric CSV column that nothing
 *    explains, and the runner is the law. The entry is written once per column with a count of the
 *    legs it covers, so the footer stays readable.
 *  * **The chain is read in one unfiltered call.** §OMON budgets two round trips with a grouped
 *    count; `data.options.chain` already returns the whole expiry ladder on every call, so asking
 *    for the ladder and then for one expiry would be two queries where one does. The cost is that
 *    the full 3,510-row ladder is materialised in the resolver; the benefit is that `isWeekly` and
 *    the per-expiry counts come from the same read as the legs.
 *  * **Staleness is three times the chain's own interval (3 × 60 s), not 3 × 10 s.** §OMON quotes
 *    the `cboe.quotes` interval; `cboe.options` is scheduled at `everyMs: 60_000` (PROVIDERS §13,
 *    `ingest/jobs/cboeOptions.ts`), and the staleness rule has to be about the line that published
 *    the row.
 *  * **A fresh chain's cells are `live`, not the underlying's plant state.** The 15-minute delay
 *    is carried by `tier: 'delayed'`, the `DELAYED_15MIN` caveat and the footer — not by pretending
 *    a current publication is stale. A chain older than its interval is `stale` everywhere.
 *  * **The smile's forward is the chain's own parity forward.** The engine is handed `rate = 0`
 *    and `dividendYield = 0` because OMON makes no rate or dividend call (§OMON step 7), so the
 *    forward it fits against is the one put-call parity implies from these very quotes. That is
 *    also why `selected.forward` is `null`: the payload publishes no forward it did not source.
 */

import type { ReasonCode, Tier, ValueCell, ValueState } from '@terminal/core';
import { engineMeta } from '@terminal/core/analytics/engine';
import type { ChainQuote, VolSurfaceInputs } from '@terminal/core/analytics/vol/surface';
import { volSurfaceEngine } from '@terminal/core/analytics/vol/surface';
import type { Calendar, IsoDate } from '@terminal/core/calendars/calendar';
import { addDays } from '@terminal/core/calendars/calendar';
import type {
  OmonCaveat,
  OmonExpiry,
  OmonLeg,
  OmonParams,
  OmonPayload,
  OmonRow,
  OmonSelected,
  OmonSmile,
  OmonSmilePoint,
  OmonSvi,
  OmonUnderlying,
} from '@terminal/core/functions/manifests/OMON';
import { OMON_CONSTANT_CAVEATS, OMON_DELAY_MIN } from '@terminal/core/functions/manifests/OMON';
import { localClock, localTimeToUtc } from '@terminal/core/quote/session';

import { cellFromState } from '../shared/cells.js';
import { AppError } from '../../http/errors.js';

import type { ChainSnapshot, OptionQuote, OptionTerms } from '../../data/options.js';
import type { ResolveContext } from '../context.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SOURCE_ID = 'cboe.options';
const CHAIN_TIER: Tier = 'delayed';
/** `cboe.options` is scheduled at 60 s (PROVIDERS §13); three intervals is stale. */
const CHAIN_INTERVAL_MS = 60_000;
const CHAIN_STALE_MS = 3 * CHAIN_INTERVAL_MS;
/** §OMON read-through: refresh when the newest capture is older than a minute. */
const CHAIN_MAX_AGE_MS = 60_000;
/** `|delta|` above which a published implied volatility means nothing. */
const SUSPECT_DELTA = 0.99;
/** `|moneyness %|` above which the same is true. */
const SUSPECT_MONEYNESS_PCT = 25;
/** The SVI fitter refuses fewer than five usable quotes. */
const MIN_SMILE_QUOTES = 5;
/** Always populated from this many rows up (§OMON step 8). */
const SMILE_MIN_ROWS = 5;
const CALENDAR_ID = 'XCBO';
/** 16:00 America/New_York — the pm settlement wall-clock time. */
const PM_SETTLEMENT_ET = '16:00';
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function nyDate(ms: number): IsoDate {
  return localClock('America/New_York', ms)?.date ?? new Date(ms).toISOString().slice(0, 10);
}

/**
 * `expiry` at 16:00 America/New_York as an ISO instant — the pm settlement moment
 * (`option_terms.am_pm_settlement = 'pm'`, §0 "Option conventions").
 *
 * `localTimeToUtc` reads the offset in force on the day itself, so this is right on both sides of
 * a daylight-saving change without a table of its own.
 */
export function pmSettlementTs(expiry: IsoDate): string {
  const ms = localTimeToUtc('America/New_York', expiry, PM_SETTLEMENT_ET);
  return new Date(ms ?? Date.parse(`${expiry}T20:00:00.000Z`)).toISOString();
}

function businessDaysBetween(cal: Calendar, from: IsoDate, to: IsoDate): number {
  if (from >= to) return 0;
  let count = 0;
  let cursor = from;
  // Bounded: the listed ladder runs out beyond three years, and 1,400 iterations is cheap.
  for (let i = 0; i < 1_400 && cursor < to; i += 1) {
    cursor = addDays(cursor, 1);
    if (cal.isBusinessDay(cursor)) count += 1;
  }
  return count;
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const expiry = (parsed as { expiry?: unknown }).expiry;
    return typeof expiry === 'string' ? expiry : null;
  } catch {
    return null;
  }
}

/** `'AAPL 9/16/26 C245 Equity'` — the Bloomberg display form of a listed contract. */
export function contractKey(terms: OptionTerms): string {
  const [y = '', m = '', d = ''] = terms.expiry.split('-');
  const date = `${String(Number(m))}/${String(Number(d))}/${y.slice(2)}`;
  const strike = Number.isInteger(terms.strike)
    ? String(terms.strike)
    : String(Number(terms.strike.toFixed(4)));
  return `${terms.root} ${date} ${terms.putCall}${strike} Equity`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cells
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * §OMON and §OVML both write `r: 'NO_DATA'`, which is **not** a member of the landed `ReasonCode`
 * union (`core/types/entitlement.ts`: the codes are about entitlement, the plant and the provider).
 * `FIELD_UNKNOWN` is the member that says what is actually true of these cells — the capture
 * carries no such field for this subject — and the *why* travels in `meta.unavailable` with a
 * detail, which is where a reader looks for it. `PROVIDER_DOWN` stays reserved for "no row at all".
 */
const NO_VALUE: ReasonCode = 'FIELD_UNKNOWN';

/**
 * A leg cell.
 *
 * `v === null` is recorded in `missing` under the column's own name, so the resolver can write one
 * `meta.unavailable` entry per column at the end instead of one per leg.
 */
function legCell(
  value: number | null,
  st: ValueState,
  provIdx: number,
  ts: number | null,
  column: string,
  missing: Map<string, number>,
  reason: ReasonCode = NO_VALUE,
): ValueCell {
  if (value === null || !Number.isFinite(value)) {
    missing.set(column, (missing.get(column) ?? 0) + 1);
    return { v: null, st: 'na', r: reason, provIdx: -1 };
  }
  return { v: value, st, provIdx, ...(ts === null ? {} : { ts }) };
}

function numCell(value: number, st: ValueState, provIdx: number): ValueCell {
  return { v: value, st, provIdx };
}

function naCell(reason: ReasonCode): ValueCell {
  return { v: null, st: 'na', r: reason, provIdx: -1 };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const code = 'OMON';

export async function resolve(ctx: ResolveContext, params: OmonParams): Promise<OmonPayload> {
  const instrument = ctx.instrument;
  if (instrument === null) {
    throw new AppError('NO_SECURITY_CONTEXT', 'OMON needs an underlying security.', {
      details: { code: 'OMON' },
    });
  }

  const detail = await ctx.data.reference.instrument(instrument.instrumentId);
  const underlyingId = detail.instrument.instrumentId;
  const ticker = detail.instrument.ticker;
  const subjU = ctx.plant.subjectFor(underlyingId, 'q');
  const subjChain = ctx.plant.subjectFor(underlyingId, 'oc');
  ctx.plant.ensureHot([subjU, subjChain]);

  const valuationDate = nyDate(ctx.asOf.validAt.getTime());
  const caveats = new Set<OmonCaveat>(OMON_CONSTANT_CAVEATS);

  // ── 1. the chain ────────────────────────────────────────────────────────────────────────────
  let chain = await ctx.data.options.chain(underlyingId);
  const ageMs = ctx.asOf.validAt.getTime() - Date.parse(chain.captureTs);
  if (chain.contracts.length === 0 || ageMs > CHAIN_MAX_AGE_MS) {
    const refreshed = await ctx.providers
      .ensure('cboe.options', ticker, { maxAgeMs: CHAIN_MAX_AGE_MS })
      .catch(() => null);
    if (refreshed?.fresh === true) {
      chain = await ctx.data.options.chain(underlyingId);
    }
  }
  const stale = ctx.asOf.validAt.getTime() - Date.parse(chain.captureTs) > CHAIN_STALE_MS;
  const legState: ValueState = stale ? 'stale' : 'live';
  const chainTs = Date.parse(chain.captureTs);

  const chainProvenanceId =
    chain.contracts.find((c) => c.q !== null)?.q?.provenanceId ?? chain.underlying.provenanceId;
  const provIdxChain = ctx.prov.add({
    sourceId: SOURCE_ID,
    provenanceId: chainProvenanceId,
    capturedAt: new Date(chain.captureTs),
    sourceTs: new Date(chain.captureTs),
    st: legState,
    tier: CHAIN_TIER,
  });

  const stateU = ctx.plant.snapshot(subjU);
  const underlying = underlyingBlock(ctx, {
    detail: { instrumentId: underlyingId, name: detail.instrument.name },
    chain,
    subject: subjU,
    provIdxChain,
    legState,
  });

  // ── 2. no listed options ────────────────────────────────────────────────────────────────────
  if (chain.contracts.length === 0) {
    ctx.unavailable.add({
      field: 'rows',
      reason: 'NO_SOURCE',
      detail: `no listed options for ${underlying.key} in the Cboe chain`,
    });
    ctx.page?.set({ index: 0, count: 0, cursor: null });
    return {
      variant: 'underlying',
      underlying,
      expiries: [],
      selected: emptySelected(valuationDate),
      rows: [],
      smile: { points: [], svi: null, sviSource: null, sviUnavailableReason: 'TOO_FEW_USABLE_QUOTES' },
      captureTs: chain.captureTs,
      delayMin: OMON_DELAY_MIN,
      caveats: [...caveats],
    };
  }

  // ── 3. expiry selection and paging ──────────────────────────────────────────────────────────
  const ladder = chain.expiries.map((e) => e.expiry);
  const cursorExpiry = ctx.page?.cursor === undefined || ctx.page.cursor === null
    ? null
    : decodeCursor(ctx.page.cursor);
  if (cursorExpiry !== null && !ladder.includes(cursorExpiry)) {
    throw new AppError('VALIDATION_FAILED', `expiry ${cursorExpiry} is no longer listed.`, {
      details: {
        location: 'page',
        field: 'cursor',
        detail: `expiry ${cursorExpiry} is no longer listed`,
      },
    });
  }
  if (params.expiry !== null && !ladder.includes(params.expiry)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${params.expiry} is not a listed expiry for ${ticker}.`,
      {
        details: {
          location: 'fnParams',
          field: 'expiry',
          detail:
            `${params.expiry} is not a listed expiry for ${ticker}; listed: ` +
            ladder.slice(0, 5).join(', '),
        },
      },
    );
  }
  const nearest = ladder.find((e) => e >= valuationDate) ?? ladder[ladder.length - 1] ?? '';
  const expiry = params.expiry ?? cursorExpiry ?? nearest;

  const selectedContracts = chain.contracts.filter((c) => c.expiry === expiry);
  const weeklyOf = new Map<string, boolean>();
  for (const contract of chain.contracts) {
    if (!weeklyOf.has(contract.expiry)) weeklyOf.set(contract.expiry, contract.isWeekly);
  }
  const calendar = await ctx.data.reference.calendar(CALENDAR_ID);
  const expiries: OmonExpiry[] = chain.expiries.map((e) => ({
    expiry: e.expiry,
    days: businessDaysBetween(calendar, valuationDate, e.expiry),
    contractCount: e.contractCount,
    isSelected: e.expiry === expiry,
    isWeekly: weeklyOf.get(e.expiry) ?? false,
  }));
  ctx.page?.set({
    index: ladder.indexOf(expiry),
    count: ladder.length,
    cursor: base64url(JSON.stringify({ expiry })),
  });

  // ── 4. the strike window ────────────────────────────────────────────────────────────────────
  const plantSpot = typeof stateU?.fields.PX_LAST === 'number' ? stateU.fields.PX_LAST : null;
  const spot = plantSpot ?? chain.underlying.px;
  const listedStrikes = [...new Set(selectedContracts.map((c) => c.strike))].sort((a, b) => a - b);
  const atmStrike = spot === null ? null : nearestStrike(listedStrikes, spot);
  const centre =
    params.center === 'atm' ? (atmStrike ?? listedStrikes[0] ?? null) : params.center;

  let windowed: number[];
  if (centre === null) {
    windowed = listedStrikes;
  } else if (params.moneyness !== null) {
    const band = (centre * params.moneyness) / 100;
    windowed = listedStrikes.filter((k) => Math.abs(k - centre) <= band);
  } else {
    const nearestIdx = indexOfNearest(listedStrikes, centre);
    const lo = Math.max(0, nearestIdx - params.strikes);
    const hi = Math.min(listedStrikes.length, nearestIdx + params.strikes + 1);
    windowed = listedStrikes.slice(lo, hi);
  }
  if (params.sort === 'strike_desc') windowed = [...windowed].reverse();

  // ── 5. legs ─────────────────────────────────────────────────────────────────────────────────
  const missing = new Map<string, number>();
  const bySide = new Map<string, OptionTerms & { q: OptionQuote | null }>();
  for (const contract of selectedContracts) {
    bySide.set(`${String(contract.strike)}|${contract.putCall}`, contract);
  }

  let anySuspect = false;
  const rows: OmonRow[] = windowed.map((strike) => {
    const moneynessPct = spot === null ? 0 : 100 * (spot / strike - 1);
    const build = (side: 'C' | 'P'): OmonLeg | null => {
      const contract = bySide.get(`${String(strike)}|${side}`);
      if (contract === undefined) return null;
      const leg = legOf(contract, {
        provIdx: provIdxChain,
        st: legState,
        ts: chainTs,
        moneynessPct,
        missing,
      });
      if (leg.ivSuspect) anySuspect = true;
      return leg;
    };
    return {
      strike,
      isAtm: atmStrike !== null && strike === atmStrike,
      moneynessPct,
      call: build('C'),
      put: build('P'),
    };
  });
  if (anySuspect) caveats.add('DEEP_ITM_IV_UNRELIABLE');

  // ── 6. summary over EVERY contract of the expiry ─────────────────────────────────────────────
  let callVolume = 0;
  let putVolume = 0;
  let callOi = 0;
  let putOi = 0;
  for (const contract of selectedContracts) {
    const q = contract.q;
    if (q === null) continue;
    if (contract.putCall === 'C') {
      callVolume += q.volume ?? 0;
      callOi += q.openInterest ?? 0;
    } else {
      putVolume += q.volume ?? 0;
      putOi += q.openInterest ?? 0;
    }
  }
  const ratio = (numerator: number, denominator: number): ValueCell =>
    denominator === 0 ? naCell(NO_VALUE) : numCell(numerator / denominator, legState, provIdxChain);
  if (callVolume === 0) {
    ctx.unavailable.add({
      field: 'selected.putCallVolumeRatio',
      reason: 'NO_SOURCE',
      detail: `no call volume on ${expiry}: the ratio has no denominator`,
    });
  }
  if (callOi === 0) {
    ctx.unavailable.add({
      field: 'selected.putCallOiRatio',
      reason: 'NO_SOURCE',
      detail: `no call open interest on ${expiry}: the ratio has no denominator`,
    });
  }

  const atmRow = rows.find((r) => r.isAtm) ?? null;
  const atmIvs = [atmRow?.call, atmRow?.put].flatMap((leg) =>
    leg !== null && leg !== undefined && !leg.ivSuspect && typeof leg.ivPct.v === 'number'
      ? [leg.ivPct.v]
      : [],
  );
  let atmIvPct: ValueCell;
  if (atmIvs.length > 0) {
    atmIvPct = numCell(
      atmIvs.reduce((sum, v) => sum + v, 0) / atmIvs.length,
      legState,
      provIdxChain,
    );
  } else if (typeof underlying.iv30Pct.v === 'number') {
    atmIvPct = { ...underlying.iv30Pct };
    ctx.unavailable.add({
      field: 'selected.atmIvPct',
      reason: 'NO_SOURCE',
      detail: 'no usable ATM contract IV; 30-day underlying IV shown',
    });
  } else {
    atmIvPct = naCell(NO_VALUE);
    ctx.unavailable.add({
      field: 'selected.atmIvPct',
      reason: 'NO_SOURCE',
      detail: 'no usable ATM contract IV and no 30-day underlying IV',
    });
  }

  const expiryTs = pmSettlementTs(expiry);
  const years = Math.max(0, (Date.parse(expiryTs) - ctx.asOf.validAt.getTime()) / MS_PER_YEAR);
  const selected: OmonSelected = {
    expiry,
    expiryTs,
    days: expiries.find((e) => e.expiry === expiry)?.days ?? 0,
    years,
    contractCount: selectedContracts.length,
    atmStrike,
    atmIvPct,
    forward: null,
    putCallVolumeRatio: ratio(putVolume, callVolume),
    putCallOiRatio: ratio(putOi, callOi),
    totals: {
      callVolume: numCell(callVolume, legState, provIdxChain),
      putVolume: numCell(putVolume, legState, provIdxChain),
      callOi: numCell(callOi, legState, provIdxChain),
      putOi: numCell(putOi, legState, provIdxChain),
    },
  };

  // ── 7. the smile ────────────────────────────────────────────────────────────────────────────
  const smile = fitSmile(ctx, {
    rows,
    spot,
    expiry,
    valuationDate,
    ticker,
    populate: params.view === 'smile' || rows.length >= SMILE_MIN_ROWS,
  });
  if (smile.sviSource === 'fit') caveats.add('SURFACE_NOT_STORED');

  // ── 8. one unavailable entry per null leg column (see the header) ────────────────────────────
  const legTotal = rows.reduce((n, r) => n + (r.call === null ? 0 : 1) + (r.put === null ? 0 : 1), 0);
  for (const [column, count] of [...missing].sort((a, b) => a[0].localeCompare(b[0]))) {
    ctx.unavailable.add({
      field: `rows.${column}`,
      reason: 'NO_SOURCE',
      detail:
        `${String(count)} of ${String(legTotal)} legs on ${expiry} carry no ${column} in the ` +
        'Cboe capture',
    });
  }

  return {
    variant: 'underlying',
    underlying,
    expiries,
    selected,
    rows,
    smile,
    captureTs: chain.captureTs,
    delayMin: OMON_DELAY_MIN,
    caveats: [...caveats],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Blocks
// ─────────────────────────────────────────────────────────────────────────────────────────────

function emptySelected(valuationDate: IsoDate): OmonSelected {
  const blank = naCell(NO_VALUE);
  return {
    expiry: valuationDate,
    expiryTs: pmSettlementTs(valuationDate),
    days: 0,
    years: 0,
    contractCount: 0,
    atmStrike: null,
    atmIvPct: blank,
    forward: null,
    putCallVolumeRatio: blank,
    putCallOiRatio: blank,
    totals: { callVolume: blank, putVolume: blank, callOi: blank, putOi: blank },
  };
}

/**
 * The header block.
 *
 * `px`, `chg`, `chgPct` and `volume` come from the plant when the subject is hot, because those are
 * the cells the WebSocket updates in place. When it is not, the chain's own underlying print is
 * used and cited to the chain capture — the same print the greeks in the same file were computed
 * against, which is the only price they are consistent with.
 */
function underlyingBlock(
  ctx: ResolveContext,
  args: {
    detail: { instrumentId: number; name: string };
    chain: ChainSnapshot;
    subject: string;
    provIdxChain: number;
    legState: ValueState;
  },
): OmonUnderlying {
  const { chain, subject, provIdxChain, legState } = args;
  const state = ctx.plant.snapshot(subject);
  const has = (field: 'PX_LAST' | 'CHG_NET_1D' | 'CHG_PCT_1D' | 'PX_VOLUME' | 'IVOL_30D'): boolean =>
    state !== undefined && typeof state.fields[field] === 'number';

  const px = has('PX_LAST')
    ? cellFromState(ctx, state, 'PX_LAST', subject)
    : chain.underlying.px === null
      ? naCell(NO_VALUE)
      : numCell(chain.underlying.px, legState, provIdxChain);
  const chg = has('CHG_NET_1D') ? cellFromState(ctx, state, 'CHG_NET_1D', subject) : naCell(NO_VALUE);
  const chgPct = has('CHG_PCT_1D')
    ? cellFromState(ctx, state, 'CHG_PCT_1D', subject)
    : chain.underlying.chgPct === null
      ? naCell(NO_VALUE)
      : numCell(100 * chain.underlying.chgPct, legState, provIdxChain);
  const volume = has('PX_VOLUME') ? cellFromState(ctx, state, 'PX_VOLUME', subject) : naCell(NO_VALUE);
  const iv30Pct = has('IVOL_30D')
    ? cellFromState(ctx, state, 'IVOL_30D', subject)
    : chain.underlying.iv30 === null
      ? naCell(NO_VALUE)
      : numCell(chain.underlying.iv30, legState, provIdxChain);

  for (const [field, cell, what] of [
    ['underlying.px', px, 'underlying price'],
    ['underlying.chg', chg, 'net change on the day'],
    ['underlying.chgPct', chgPct, 'percent change on the day'],
    ['underlying.volume', volume, 'underlying volume'],
    ['underlying.iv30Pct', iv30Pct, '30-day implied volatility'],
  ] as const) {
    if (cell.v === null) {
      ctx.unavailable.add({
        field,
        reason: 'NO_SOURCE',
        detail: `no ${what} for ${chain.underlying.display} in the stored Cboe capture or the plant`,
      });
    }
  }

  return {
    instrumentId: chain.underlying.instrumentId,
    key: chain.underlying.display,
    name: args.detail.name,
    px,
    chg,
    chgPct,
    iv30Pct,
    volume,
    subject,
    provIdx: provIdxChain,
    captureTs: chain.captureTs,
  };
}

/** One side of one strike, entirely from the capture. */
function legOf(
  contract: OptionTerms & { q: OptionQuote | null },
  args: {
    provIdx: number;
    st: ValueState;
    ts: number;
    moneynessPct: number;
    missing: Map<string, number>;
  },
): OmonLeg {
  const { provIdx, st, ts, missing } = args;
  const q = contract.q;
  const cell = (value: number | null | undefined, column: string): ValueCell =>
    legCell(
      value === undefined ? null : value,
      st,
      provIdx,
      ts,
      column,
      missing,
      q === null ? 'PROVIDER_DOWN' : NO_VALUE,
    );

  const bid = q?.bid ?? null;
  const ask = q?.ask ?? null;
  const mid = bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : null;
  const last = q?.last ?? null;
  const prevClose = q?.prevClose ?? null;
  const chg = last !== null && prevClose !== null ? last - prevClose : null;
  const chgPct =
    last !== null && prevClose !== null && prevClose !== 0
      ? 100 * (last / prevClose - 1)
      : null;
  const ivPct = q?.iv === null || q?.iv === undefined ? null : q.iv * 100;
  const delta = q?.delta ?? null;

  const ivSuspect =
    (delta !== null && Math.abs(delta) > SUSPECT_DELTA) ||
    Math.abs(args.moneynessPct) > SUSPECT_MONEYNESS_PCT;

  return {
    instrumentId: contract.instrumentId,
    key: contractKey(contract),
    occSymbol: contract.occSymbol,
    subject: `q:${String(contract.instrumentId)}`,
    bid: cell(bid, 'bid'),
    ask: cell(ask, 'ask'),
    bidSize: cell(q?.bidSize, 'bidSize'),
    askSize: cell(q?.askSize, 'askSize'),
    mid: cell(mid, 'mid'),
    last: cell(last, 'last'),
    lastTs: q?.lastTs ?? null,
    chg: cell(chg, 'chg'),
    chgPct: cell(chgPct, 'chgPct'),
    prevClose: cell(prevClose, 'prevClose'),
    volume: cell(q?.volume, 'volume'),
    openInterest: cell(q?.openInterest, 'openInterest'),
    ivPct: cell(ivPct, 'ivPct'),
    delta: cell(delta, 'delta'),
    gamma: cell(q?.gamma, 'gamma'),
    vega: cell(q?.vega, 'vega'),
    theta: cell(q?.theta, 'theta'),
    rho: cell(q?.rho, 'rho'),
    theo: cell(q?.theo, 'theo'),
    ivSuspect,
    provIdx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The smile (ANAL-04)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `vol_surfaces` has no writer in v1, so a stored fit is never found and the slice is fitted in
 * process. That is recorded as `sviUnavailableReason: 'SURFACE_STORE_NOT_IMPLEMENTED'` alongside
 * `sviSource: 'fit'`: the fit on screen is real, but it was not persisted and the historical half
 * of ANAL-04 stays partial.
 */
function fitSmile(
  ctx: ResolveContext,
  args: {
    rows: readonly OmonRow[];
    spot: number | null;
    expiry: string;
    valuationDate: IsoDate;
    ticker: string;
    populate: boolean;
  },
): OmonSmile {
  const points: OmonSmilePoint[] = [];
  const quotes: ChainQuote[] = [];
  for (const row of args.rows) {
    const callIv = usableIv(row.call);
    const putIv = usableIv(row.put);
    if (callIv === null && putIv === null && row.call === null && row.put === null) continue;
    const oiCall = numberOf(row.call?.openInterest);
    const oiPut = numberOf(row.put?.openInterest);
    const oiTotal = oiCall === null && oiPut === null ? null : (oiCall ?? 0) + (oiPut ?? 0);
    if (callIv !== null || putIv !== null) {
      points.push({
        strike: row.strike,
        moneynessPct: row.moneynessPct,
        callIvPct: callIv,
        putIvPct: putIv,
        oiTotal,
      });
    }
    // The fit takes only strikes whose IV is trustworthy on at least one side, two-sided on both
    // legs, so the engine's own parity step has something to regress.
    const cb = numberOf(row.call?.bid);
    const ca = numberOf(row.call?.ask);
    const pb = numberOf(row.put?.bid);
    const pa = numberOf(row.put?.ask);
    const suspect = (row.call?.ivSuspect ?? true) && (row.put?.ivSuspect ?? true);
    if (!suspect && cb !== null && ca !== null && pb !== null && pa !== null) {
      quotes.push({
        strike: row.strike,
        callBid: cb,
        callAsk: ca,
        putBid: pb,
        putAsk: pa,
        ...(callIv === null ? {} : { callIv: callIv / 100 }),
        ...(putIv === null ? {} : { putIv: putIv / 100 }),
      });
    }
  }
  points.sort((a, b) => a.strike - b.strike);
  quotes.sort((a, b) => a.strike - b.strike);

  if (!args.populate || args.spot === null || quotes.length < MIN_SMILE_QUOTES) {
    return {
      points,
      svi: null,
      sviSource: null,
      sviUnavailableReason: 'TOO_FEW_USABLE_QUOTES',
    };
  }

  // No rate and no dividend call on this screen (§OMON step 7): the engine's parity step reads the
  // forward out of these very quotes, which is the only forward OMON is entitled to use.
  const inputs: VolSurfaceInputs = {
    underlying: args.ticker,
    asOf: args.valuationDate,
    spot: args.spot,
    rate: 0,
    dividendYield: 0,
    expiries: [{ expiry: args.expiry, quotes }],
    ivSource: 'quoted',
  };
  let svi: OmonSvi | null = null;
  try {
    const fitted = volSurfaceEngine(inputs, `${args.valuationDate}T00:00:00.000Z`);
    ctx.engines.add(engineMeta(fitted));
    const slice = fitted.outputs.slices[0];
    if (slice !== undefined) {
      svi = {
        a: slice.svi.a,
        b: slice.svi.b,
        rho: slice.svi.rho,
        m: slice.svi.m,
        sigma: slice.svi.sigma,
        rmse: slice.svi.rmse,
        n: slice.svi.n,
      };
    }
  } catch {
    // The engine refuses a slice with fewer than five quotes it can actually use — its accounting
    // is stricter than the count above, and its refusal is the same answer with a better reason.
    svi = null;
  }
  if (svi === null) {
    return { points, svi: null, sviSource: null, sviUnavailableReason: 'TOO_FEW_USABLE_QUOTES' };
  }
  return { points, svi, sviSource: 'fit', sviUnavailableReason: 'SURFACE_STORE_NOT_IMPLEMENTED' };
}

function numberOf(cell: ValueCell | undefined): number | null {
  return cell !== undefined && typeof cell.v === 'number' ? cell.v : null;
}

/** A leg's implied volatility in percent when it is worth plotting, else `null`. */
function usableIv(leg: OmonLeg | null): number | null {
  if (leg === null || leg.ivSuspect) return null;
  return typeof leg.ivPct.v === 'number' ? leg.ivPct.v : null;
}

function nearestStrike(strikes: readonly number[], spot: number): number | null {
  const index = indexOfNearest(strikes, spot);
  return strikes[index] ?? null;
}

function indexOfNearest(strikes: readonly number[], target: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  strikes.forEach((strike, index) => {
    const distance = Math.abs(strike - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}
