/**
 * Cboe normalisers — PROVIDERS.a §5.1 (`cboe.quotes`), §5.2 (`cboe.options`),
 * §5.3 (`cboe.symbolBook`), §5.4 (`cboe.euIndices`).
 *
 * **This module is pure** (PROVIDERS.a §1.2): no IO, no clock, no randomness, no database. Its
 * only inputs are a `RawRecord`'s bytes and a `NormaliseContext`, and the same bytes produce the
 * same output on a 2026 laptop and a 2030 CI box — which is what makes the goldens under
 * `fixtures/providers/normalised/` meaningful and what lets QA-05 fuzz it. **Nothing here ever
 * throws**: a truncated, reordered or corrupted payload comes back as
 * `problems: [{ kind: 'parse_error', … }]` with empty updates and rows.
 *
 * Three rules from §5's preamble are implemented here and are worth naming, because each one is a
 * screen defect when it is got wrong:
 *
 *  1. **Three timestamp conventions.** The top-level `timestamp` (`"2026-09-15 18:41:28"`, the
 *     `T`-less space form) is **UTC** and becomes `provenance.source_ts`; `data.last_trade_time`
 *     (`"2026-09-15T14:26:26"`) is **naive `America/New_York`** and becomes `ts.src`; the European
 *     endpoint's `last_trade_time` carries an explicit offset and is parsed as-is. Confusing the
 *     first two moves every print four or five hours.
 *  2. **Zeros are not values.** A `0` bid on `^VIX`, a `0` volume on an index, a `0` open before
 *     the open: these mean "not applicable / not yet", and publishing them renders a number where
 *     a `--` belongs. Prices, sizes and IV go through {@link positive}; a dropped price takes its
 *     size with it.
 *  3. **Derived fields are never taken from a provider.** `price_change`, `price_change_percent`
 *     and `tick` are parsed into `rows.crossChecks` for the QA-03 `reconcile_mismatch` monitor and
 *     are *never* published as `CHG_NET_1D`, `CHG_PCT_1D` or `TICK_DIR` — `core/quote/derive.ts`
 *     computes those.
 *
 * `PX_OFFICIAL_CLOSE` needs the session, which a pure function cannot read from a calendar clock:
 * intra-session Cboe sets `close = current_price` (the AAPL capture shows `close 330.27 =
 * current_price 330.27`) and publishing that would be a fake official close. The session therefore
 * arrives as an explicit option from the caller (`ingest/jobs/cboeQuotes.ts`, which holds
 * `refdata/calendars.ts`), and the default — no session stated — publishes no official close.
 */

import type { AssetClass, NormalisedUpdate, QuoteFields, SessionState, Tier } from '@terminal/core';
import { parseOcc } from '@terminal/core';

import type {
  NormaliseContext,
  NormaliseLine,
  NormaliseProblem,
  NormaliseProblemKind,
  Normalised,
  RawRecord,
} from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row types — DATA_MODEL column names, camel-cased (PROVIDERS.a §1.1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One `quote_ticks` row, `kind 'summary'` (CONTRACTS §1.2 L163).
 *
 * `publishTs` and `tickDir` are `null` by construction: the plant stamps `publish_ts` when it
 * applies the update and `core/quote/derive.ts` computes the tick direction, so an adapter that
 * filled either of them would be publishing a provider's derived field as its own.
 */
export interface CboeQuoteTickRow {
  captureTs: string;
  instrumentId: number;
  mdLineId: number;
  kind: 'summary';
  sourceTs: string | null;
  publishTs: null;
  srcSeq: number | null;
  price: number | null;
  size: null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null;
  iv30: number | null;
  tickDir: null;
  conditions: string[];
  sessionState: SessionState | null;
  provenanceId: number;
}

/**
 * The provider's own derived fields, parsed and carried but never published (§5 preamble). The
 * QA-03 monitor compares `priceChange` against `core/quote/derive.ts` and writes a `dq_events`
 * row of kind `'reconcile_mismatch'` when they differ by more than a tick.
 */
export interface CboeQuoteCrossCheck {
  providerSymbol: string;
  securityType: string | null;
  exchangeId: number | null;
  currentPrice: number | null;
  prevDayClose: number | null;
  priceChange: number | null;
  priceChangePercent: number | null;
  tick: string | null;
}

export interface CboeQuoteRows {
  quoteTicks: CboeQuoteTickRow[];
  crossChecks: CboeQuoteCrossCheck[];
}

/** An `identifiers` row the adapter mints — §5.4 records the Cboe European symbol form. */
export interface CboeIdentifierRow {
  entityKind: 'instrument';
  entityId: number;
  scheme: 'PROVIDER_SYMBOL';
  value: string;
  qualifier: string;
  isPrimary: boolean;
}

/** §5.4: `data.status` is a hint; the XLON calendar stays authoritative. */
export interface CboeEuIndexStatus {
  /** `'C'` | `'O'` | `'H'`, or `null` when the payload carries none. */
  code: string | null;
  /** The session the letter implies, `null` for an unknown letter. */
  session: SessionState | null;
  /** The bare `"16:59:53"` top-level timestamp, kept verbatim for `dq_events.details`. */
  payloadTime: string | null;
  /** `payloadTime` (read as UTC on `last_trade_time`'s date) − `last_trade_time`, ms. */
  skewMs: number | null;
}

export interface CboeEuIndexRows extends CboeQuoteRows {
  identifiers: CboeIdentifierRow[];
  status: CboeEuIndexStatus;
}

/** One `option_terms` version plus everything needed to mint the contract's `instruments` row. */
export interface CboeContractRow {
  /** `'AAPL260916C00245000'` — the Cboe form, root unpadded (CONTRACTS §1.2 L80). */
  occSymbol: string;
  root: string;
  expiry: string;
  putCall: 'C' | 'P';
  strike: number;
  multiplier: number;
  exerciseStyle: 'american';
  settlement: 'physical';
  amPmSettlement: 'pm';
  tickSize: number;
  isWeekly: boolean;
  lastTradeDate: string;
  /** `instruments.ticker` = `occSymbol`; the mint columns of §5.2 step 2. */
  assetClass: 'option';
  marketSector: 'Equity';
  exchCode: 'US';
  currency: 'USD';
  /** Resolved through `ctx.resolveInstrument` when the contract already exists, else `null`. */
  instrumentId: number | null;
}

/** One `option_quotes` row (CONTRACTS §1.2 L166). */
export interface CboeOptionQuoteRow {
  captureTs: string;
  occSymbol: string;
  instrumentId: number | null;
  underlyingInstrumentId: number;
  mdLineId: number;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  last: number | null;
  lastTs: string | null;
  prevClose: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  rho: number | null;
  theo: number | null;
  underlyingPx: number | null;
  provenanceId: number;
}

/**
 * The `oc:<underlyingInstrumentId>` aggregate of §5.2.
 *
 * It is a **row**, not a `NormalisedUpdate`: `QuoteFields` (ARCHITECTURE §4.2, `packages/core`)
 * has no `EXPIRIES` / `ATM_IV` / `PUT_CALL_RATIO` / `CONTRACT_COUNT` member, so there is no typed
 * way to carry these on an update today. WP-06 owns the chain subject; until it adds those field
 * ids, the job reads them from here.
 */
export interface CboeChainSummary {
  underlyingSymbol: string;
  underlyingInstrumentId: number;
  mdLineId: number;
  contractCount: number;
  expiries: string[];
  frontExpiry: string | null;
  atmStrike: number | null;
  atmIv: number | null;
  callVolume: number;
  putVolume: number;
  putCallRatio: number | null;
  /** Contracts suppressed from the plant for a crossed market (`bid > ask`). */
  crossedCount: number;
  /** Contracts with no `instruments` row yet — minted by the job, then resolved on the next poll. */
  unresolvedCount: number;
  /** Contracts that produced a plant update (subscribed, or in the ATM window). */
  plantContractCount: number;
}

export interface CboeChainRows extends CboeQuoteRows {
  contracts: CboeContractRow[];
  optionQuotes: CboeOptionQuoteRow[];
  chain: CboeChainSummary;
}

/** §5.3 shape classification. */
export type CboeSymbolKind = 'equity' | 'future' | 'index' | 'other';

export interface CboeSymbolBookEntry {
  name: string;
  companyName: string;
  kind: CboeSymbolKind;
}

export interface CboeSymbolBookSummary {
  entryCount: number;
  duplicateCount: number;
  byKind: Record<CboeSymbolKind, number>;
  /**
   * `true` when the payload holds fewer than {@link SYMBOL_BOOK_MIN_ENTRIES} entries — §5.3 rejects
   * such a payload outright (`dq_events kind 'poll_anomaly'`) and keeps the previous snapshot live.
   */
  belowMinimum: boolean;
}

export interface CboeSymbolBookRows {
  entries: CboeSymbolBookEntry[];
  summary: CboeSymbolBookSummary;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Options accepted by the normalisers
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface CboeQuoteOptions {
  /** `prov.sourceId`; `'cboe.options'` for the underlying block inside a chain payload. */
  sourceId?: string;
  /**
   * The session at `raw.capturedAt`, from `refdata/calendars.ts`. `PX_OFFICIAL_CLOSE` is published
   * only for `'closed'` and `'post'` (§5.1); absent means "not stated", and nothing is published.
   */
  session?: SessionState;
  /** Overrides the provider symbol read from the payload (the `md_lines.provider_symbol` key). */
  providerSymbol?: string;
}

export interface CboeChainOptions extends CboeQuoteOptions {
  /** OCC symbols with a live `q:` subscriber — they always produce a plant update (§5.2). */
  subscribedOcc?: ReadonlySet<string>;
  /** Expiries deep enough to fan out. Default {@link ATM_EXPIRY_DEPTH}. */
  atmExpiryDepth?: number;
  /** Strikes either side of the money that fan out. Default {@link ATM_STRIKE_WINDOW}. */
  atmStrikeWindow?: number;
}

/** §5.2: the front three expiries fan out to the plant. */
export const ATM_EXPIRY_DEPTH = 3;

/** §5.2: ±10 strikes of the money. */
export const ATM_STRIKE_WINDOW = 10;

/** §5.3: a payload with fewer entries than this is a truncated CDN object, not a universe. */
export const SYMBOL_BOOK_MIN_ENTRIES = 30_000;

/** §5.3: the entry count of the recorded capture, carried in `dq_events.details.expected`. */
export const SYMBOL_BOOK_EXPECTED_ENTRIES = 35_618;

/** §5.1: `current_price` must stay inside `[0.2 × prev_day_close, 5 × prev_day_close]`. */
export const PRICE_SANITY_LOW = 0.2;
export const PRICE_SANITY_HIGH = 5;

/** §5.4: a bare top-level time this far from `last_trade_time` is reported. */
export const EU_TIMESTAMP_SKEW_LIMIT_MS = 5 * 60 * 1000;

/** `quote_ticks.conditions` — FEED-07: the only condition a delayed poll can assert. */
const DELAYED_CONDITIONS: readonly string[] = ['delayed'];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Problem plumbing
// ─────────────────────────────────────────────────────────────────────────────────────────────

function problem(kind: NormaliseProblemKind, detail: string, path?: string): NormaliseProblem {
  return path === undefined ? { kind, detail } : { kind, detail, path };
}

/** The empty result a fatal parse failure returns — never a throw (§1.2). */
function failed<Rows>(rows: Rows, detail: string, path?: string): Normalised<Rows> {
  return { updates: [], rows, sourceTs: null, problems: [problem('parse_error', detail, path)] };
}

function emptyQuoteRows(): CboeQuoteRows {
  return { quoteTicks: [], crossChecks: [] };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Scalars
// ─────────────────────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A finite number, or `null`. Strings are accepted because a provider that changes
 * `"bid": 1.5` to `"bid": "1.5"` should degrade to a value, not to a dropped field; anything else
 * (`null`, `true`, `{}`, `NaN`, `Infinity`) is `null`.
 */
export function finite(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** §5 preamble rule 2 — "zeros are not values": a non-positive number is absent, not `0`. */
export function positive(value: unknown): number | null {
  const parsed = finite(value);
  return parsed === null || parsed <= 0 ? null : parsed;
}

/** A finite integer, or `null`. Cboe publishes sizes as floats (`125.0`). */
function integral(value: unknown): number | null {
  const parsed = finite(value);
  if (parsed === null) return null;
  const truncated = Math.trunc(parsed);
  return Number.isSafeInteger(truncated) ? truncated : null;
}

/** A positive integer, or `null`. */
function positiveInt(value: unknown): number | null {
  const parsed = integral(value);
  return parsed === null || parsed <= 0 ? null : parsed;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Time — the three conventions of §5's preamble
// ─────────────────────────────────────────────────────────────────────────────────────────────

const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
const OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

interface Naive {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

/** Sub-second digits are **truncated** to milliseconds (`.900000` → `900`), never rounded. */
function millisOf(fraction: string | undefined): number {
  if (fraction === undefined) return 0;
  return Number(`${fraction}000`.slice(0, 3));
}

function matchNaive(value: string, re: RegExp): { naive: Naive; offset: string | null } | null {
  const m = re.exec(value);
  if (m === null) return null;
  const naive: Naive = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
    ms: millisOf(m[7]),
  };
  if (naive.month < 1 || naive.month > 12 || naive.day < 1 || naive.day > 31) return null;
  if (naive.hour > 23 || naive.minute > 59 || naive.second > 59) return null;
  return { naive, offset: m[8] ?? null };
}

/** The naive wall-clock fields read as if they were UTC. */
function naiveAsUtcMs(naive: Naive): number | null {
  const ms = Date.UTC(
    naive.year,
    naive.month - 1,
    naive.day,
    naive.hour,
    naive.minute,
    naive.second,
    naive.ms,
  );
  if (!Number.isFinite(ms)) return null;
  // Rejects 2026-02-30 and friends: `Date.UTC` rolls them over instead of failing.
  const back = new Date(ms);
  if (back.getUTCMonth() !== naive.month - 1 || back.getUTCDate() !== naive.day) return null;
  return ms;
}

/** Day of the month of the `n`-th Sunday of `month` (1-12) in `year`. */
function nthSunday(year: number, month: number, n: number): number {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - firstWeekday) % 7);
  return firstSunday + (n - 1) * 7;
}

/**
 * `-240` (EDT) or `-300` (EST) for a **wall-clock** instant in `America/New_York`.
 *
 * The rule is the post-2007 US one: DST runs from 02:00 local on the second Sunday of March to
 * 02:00 local on the first Sunday of November. Every capture this parser will ever see is 2026 or
 * later; a pre-2007 date would be given the modern rule, which is stated here rather than hidden.
 * The ambiguous hour of the November fall-back resolves to its first occurrence (EDT) and the
 * non-existent hour of the March spring-forward to EST — both deterministic, which is what a
 * golden needs.
 */
export function easternOffsetMinutes(naive: Naive): number {
  const t = Date.UTC(
    naive.year,
    naive.month - 1,
    naive.day,
    naive.hour,
    naive.minute,
    naive.second,
  );
  const start = Date.UTC(naive.year, 2, nthSunday(naive.year, 3, 2), 2);
  const end = Date.UTC(naive.year, 10, nthSunday(naive.year, 11, 1), 2);
  return t >= start && t < end ? -240 : -300;
}

/** `"2026-09-15 18:41:28"` → epoch ms, read as **UTC** (the top-level Cboe timestamp). */
export function parseCboeUtcMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const matched = matchNaive(value.trim(), NAIVE_RE);
  if (matched === null) return null;
  return naiveAsUtcMs(matched.naive);
}

/** `"2026-09-15T14:26:26"` → epoch ms, read as naive **America/New_York** (`data.last_trade_time`). */
export function parseCboeEasternMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const matched = matchNaive(value.trim(), NAIVE_RE);
  if (matched === null) return null;
  const asUtc = naiveAsUtcMs(matched.naive);
  if (asUtc === null) return null;
  return asUtc - easternOffsetMinutes(matched.naive) * 60_000;
}

/** `"2026-09-15T15:30:04.900000+00:00"` → epoch ms, offset honoured (§5.4). */
export function parseCboeOffsetMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const matched = matchNaive(value.trim(), OFFSET_RE);
  if (matched?.offset == null) return null;
  const asUtc = naiveAsUtcMs(matched.naive);
  if (asUtc === null) return null;
  if (matched.offset === 'Z') return asUtc;
  const sign = matched.offset.startsWith('-') ? -1 : 1;
  const hours = Number(matched.offset.slice(1, 3));
  const minutes = Number(matched.offset.slice(4, 6));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 23 || minutes > 59) {
    return null;
  }
  return asUtc - sign * (hours * 60 + minutes) * 60_000;
}

/** `"16:59:53"` → seconds since midnight, or `null`. */
function parseBareTimeSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (m === null) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = Number(m[3]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return hour * 3600 + minute * 60 + second;
}

function isoOf(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The §5.1 quote block — shared by cboe.quotes, the cboe.options underlying and cboe.euIndices
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** JSON body → object, without throwing. */
function readJson(raw: RawRecord): { ok: true; value: unknown } | { ok: false; detail: string } {
  let jsonText: string;
  try {
    jsonText = raw.body.toString('utf8');
  } catch (err) {
    return { ok: false, detail: `response body is not decodable text: ${String(err)}` };
  }
  try {
    return { ok: true, value: JSON.parse(jsonText) as unknown };
  } catch (err) {
    const head = jsonText.slice(0, 80);
    return {
      ok: false,
      detail: `response body is not JSON (${(err as Error).message}); first bytes: ${JSON.stringify(head)}`,
    };
  }
}

interface QuoteBlock {
  providerSymbol: string;
  data: Record<string, unknown>;
}

/** Everything a published quote line needs, once the md line is known. */
interface QuoteBuild {
  fields: Partial<QuoteFields>;
  row: CboeQuoteTickRow;
  crossCheck: CboeQuoteCrossCheck;
  update: NormalisedUpdate | null;
  sourceTsMs: number | null;
  problems: NormaliseProblem[];
}

interface QuoteBuildOptions {
  sourceId: string;
  session: SessionState | undefined;
  /** §5.4 drops the book, the volume and the IV wholesale; §5.1 decides per field. */
  europeanIndex?: boolean;
  /** `data.last_trade_time` carries an explicit offset (§5.4) rather than naive ET (§5.1). */
  offsetTimestamps?: boolean;
  path: string;
}

/**
 * Build the fields, the `quote_ticks` row and the plant update for one §5.1-shaped quote block.
 *
 * Returns `update: null` when the md line resolves but the sanity check of §5.1 rejects the print
 * (`current_price` outside `[0.2 × prev_day_close, 5 × prev_day_close]`); the row is dropped with
 * it, because a value that may not be shown may not be stored either.
 */
function buildQuote(
  block: QuoteBlock,
  line: NormaliseLine,
  raw: RawRecord,
  ctx: NormaliseContext,
  options: QuoteBuildOptions,
): QuoteBuild {
  const data = block.data;
  const problems: NormaliseProblem[] = [];
  const securityType = text(data.security_type);
  const isIndex = securityType === 'index' || options.europeanIndex === true;

  const price = positive(data.current_price);
  const prevClose = positive(data.prev_day_close);
  const open = positive(data.open);
  const high = positive(data.high);
  const low = positive(data.low);
  const close = positive(data.close);
  const iv30 = positive(data.iv30);
  const seqno = integral(data.seqno);

  // §5.1: a bid whose price is absent takes its size with it. `_SPX` publishes `bid 7584.49 /
  // bid_size 1` and keeps both; `^VIX` publishes `0 / 0` and keeps neither. A European index
  // publishes no book at all, so the pair is dropped without looking (§5.4).
  const bid = options.europeanIndex === true ? null : positive(data.bid);
  const ask = options.europeanIndex === true ? null : positive(data.ask);
  const bidSize = bid === null ? null : positiveInt(data.bid_size);
  const askSize = ask === null ? null : positiveInt(data.ask_size);

  // §5.1: indices publish `volume 0`; the field is not applicable, not zero.
  const volume = isIndex ? null : positiveInt(data.volume);

  const lastTradeMs =
    options.offsetTimestamps === true
      ? parseCboeOffsetMs(data.last_trade_time)
      : parseCboeEasternMs(data.last_trade_time);
  if (lastTradeMs === null && data.last_trade_time !== null && data.last_trade_time !== undefined) {
    problems.push(
      problem(
        'field_dropped',
        `last_trade_time ${JSON.stringify(data.last_trade_time)} is not a ` +
          `${options.offsetTimestamps === true ? 'offset-bearing ISO 8601' : 'naive America/New_York'} timestamp`,
        `${options.path}/last_trade_time`,
      ),
    );
  }

  const crossCheck: CboeQuoteCrossCheck = {
    providerSymbol: block.providerSymbol,
    securityType,
    exchangeId: integral(data.exchange_id),
    currentPrice: price,
    prevDayClose: prevClose,
    priceChange: finite(data.price_change),
    priceChangePercent: finite(data.price_change_percent),
    tick: text(data.tick),
  };

  const fields: Partial<QuoteFields> = {};
  if (price !== null) fields.PX_LAST = price;
  if (lastTradeMs !== null) fields.LAST_TRADE_TIME = lastTradeMs;
  if (bid !== null) fields.PX_BID = bid;
  if (ask !== null) fields.PX_ASK = ask;
  if (bidSize !== null) fields.BID_SIZE = bidSize;
  if (askSize !== null) fields.ASK_SIZE = askSize;
  if (open !== null) fields.PX_OPEN = open;
  if (high !== null) fields.PX_HIGH = high;
  if (low !== null) fields.PX_LOW = low;
  if (prevClose !== null) fields.PX_CLOSE_1D = prevClose;
  if (volume !== null) fields.PX_VOLUME = volume;
  // §5.4: a European index publishes `iv30 0`; `positive` has already dropped it.
  if (iv30 !== null) fields.IVOL_30D = iv30;

  // §5.1: intra-session `close` mirrors `current_price`. Only a stated closed/post session makes
  // it an official close.
  const sessionClosed = options.session === 'closed' || options.session === 'post';
  if (close !== null && sessionClosed) fields.PX_OFFICIAL_CLOSE = close;
  if (options.session !== undefined) fields.SESSION_STATE = options.session;

  const row: CboeQuoteTickRow = {
    captureTs: new Date(raw.capturedAt).toISOString(),
    instrumentId: line.instrumentId,
    mdLineId: line.mdLineId,
    kind: 'summary',
    sourceTs: isoOf(lastTradeMs),
    publishTs: null,
    srcSeq: seqno,
    price,
    size: null,
    bid,
    ask,
    bidSize,
    askSize,
    open,
    high,
    low,
    prevClose,
    volume,
    iv30,
    tickDir: null,
    conditions: [...DELAYED_CONDITIONS],
    sessionState: options.session ?? null,
    provenanceId: ctx.provenanceId,
  };

  // §5.1 failures: a print outside the sanity band is dropped, with both values named so the
  // `dq_events` row the job writes (`kind 'parse_error'`) can carry them.
  if (price !== null && prevClose !== null) {
    const low_ = PRICE_SANITY_LOW * prevClose;
    const high_ = PRICE_SANITY_HIGH * prevClose;
    if (price < low_ || price > high_) {
      problems.push(
        problem(
          'out_of_range',
          `current_price ${price} is outside [${low_}, ${high_}] for prev_day_close ${prevClose} ` +
            `on ${block.providerSymbol}; the update and the tick row are dropped (§5.1)`,
          `${options.path}/current_price`,
        ),
      );
      return { fields, row, crossCheck, update: null, sourceTsMs: lastTradeMs, problems };
    }
  }

  const update: NormalisedUpdate = {
    subject: `q:${String(line.instrumentId)}`,
    instrumentId: line.instrumentId,
    mdLineId: line.mdLineId,
    assetClass: line.assetClass,
    tier: line.tier,
    fields,
    ts: { src: lastTradeMs, cap: raw.capturedAt, pub: raw.capturedAt },
    prov:
      seqno === null
        ? { sourceId: options.sourceId, provenanceId: ctx.provenanceId }
        : { sourceId: options.sourceId, provenanceId: ctx.provenanceId, srcSeq: seqno },
    ...(options.session === undefined ? {} : { session: options.session }),
  };

  return { fields, row, crossCheck, update, sourceTsMs: lastTradeMs, problems };
}

function lineFor(
  ctx: NormaliseContext,
  providerSymbol: string,
): { line: NormaliseLine } | { problem: NormaliseProblem } {
  const line = ctx.lines.get(providerSymbol);
  if (line === undefined) {
    return {
      problem: problem(
        'unknown_symbol',
        `no md_lines row for provider_symbol '${providerSymbol}' — the payload is discarded ` +
          'rather than written against a guessed instrument',
      ),
    };
  }
  return { line };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §5.1 — cboe.quotes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `cboe.quotes` — delayed top-of-book and session summary (§5.1).
 *
 * The provider symbol is the top-level `symbol` (`"AAPL"`, `"_SPX"`), which is exactly what the
 * URL carried and exactly what `md_lines.provider_symbol` stores — *not* `data.symbol`, which is
 * the display form (`"^SPX"`).
 */
export function normaliseQuote(
  raw: RawRecord,
  ctx: NormaliseContext,
  options: CboeQuoteOptions = {},
): Normalised<CboeQuoteRows> {
  const sourceId = options.sourceId ?? 'cboe.quotes';
  const json = readJson(raw);
  if (!json.ok) return failed(emptyQuoteRows(), json.detail);
  if (!isRecord(json.value)) {
    return failed(emptyQuoteRows(), `expected a JSON object, got ${describe(json.value)}`);
  }

  const payload = json.value;
  const data = payload.data;
  if (!isRecord(data)) {
    return failed(emptyQuoteRows(), `'data' is ${describe(data)}, expected an object`, '/data');
  }

  const providerSymbol = options.providerSymbol ?? text(payload.symbol) ?? text(data.symbol);
  if (providerSymbol === null) {
    return failed(emptyQuoteRows(), "no 'symbol' in the payload; the md line cannot be resolved");
  }

  const sourceTsMs = parseCboeUtcMs(payload.timestamp);
  const problems: NormaliseProblem[] = [];
  if (sourceTsMs === null) {
    problems.push(
      problem(
        'schema_drift',
        `top-level timestamp ${JSON.stringify(payload.timestamp)} is not the Cboe UTC form ` +
          '"YYYY-MM-DD HH:MM:SS"; provenance.source_ts falls back to the transport value',
        '/timestamp',
      ),
    );
  }

  const resolved = lineFor(ctx, providerSymbol);
  if ('problem' in resolved) {
    return {
      updates: [],
      rows: emptyQuoteRows(),
      sourceTs: sourceTsMs === null ? null : new Date(sourceTsMs),
      problems: [...problems, resolved.problem],
    };
  }

  const built = buildQuote({ providerSymbol, data }, resolved.line, raw, ctx, {
    sourceId,
    session: options.session,
    path: '/data',
  });
  problems.push(...built.problems);

  return {
    updates: built.update === null ? [] : [built.update],
    rows: {
      quoteTicks: built.update === null ? [] : [built.row],
      crossChecks: [built.crossCheck],
    },
    sourceTs: sourceTsMs === null ? null : new Date(sourceTsMs),
    problems,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §5.4 — cboe.euIndices
// ─────────────────────────────────────────────────────────────────────────────────────────────

function sessionOfStatus(code: string | null): SessionState | null {
  switch (code) {
    case 'C':
      return 'closed';
    case 'O':
      return 'open';
    case 'H':
      return 'halted';
    default:
      return null;
  }
}

/**
 * `cboe.euIndices` — European index quotes (§5.4).
 *
 * Three differences from §5.1, all of them load-bearing: the top-level timestamp is a **bare
 * time** and cannot be `provenance.source_ts` (it is taken from `last_trade_time` instead);
 * `last_trade_time` carries an explicit UTC offset rather than naive ET; and the index publishes
 * no book, no volume and no IV, so those fields are dropped wholesale.
 */
export function normaliseEuIndex(
  raw: RawRecord,
  ctx: NormaliseContext,
  options: CboeQuoteOptions = {},
): Normalised<CboeEuIndexRows> {
  const sourceId = options.sourceId ?? 'cboe.euIndices';
  const empty = (): CboeEuIndexRows => ({
    quoteTicks: [],
    crossChecks: [],
    identifiers: [],
    status: { code: null, session: null, payloadTime: null, skewMs: null },
  });

  const json = readJson(raw);
  if (!json.ok) return failed(empty(), json.detail);
  if (!isRecord(json.value)) {
    return failed(empty(), `expected a JSON object, got ${describe(json.value)}`);
  }
  const payload = json.value;
  const data = payload.data;
  if (!isRecord(data)) {
    return failed(empty(), `'data' is ${describe(data)}, expected an object`, '/data');
  }

  const providerSymbol = options.providerSymbol ?? text(data.index) ?? text(payload.symbol);
  if (providerSymbol === null) {
    return failed(empty(), "no 'data.index' in the payload; the md line cannot be resolved");
  }

  const problems: NormaliseProblem[] = [];
  const lastTradeMs = parseCboeOffsetMs(data.last_trade_time);
  const payloadTime = text(payload.timestamp);
  const bareSeconds = parseBareTimeSeconds(payloadTime);

  // The bare time has no date, so it is compared on `last_trade_time`'s own UTC day. A payload
  // without a usable `last_trade_time` cannot be compared at all.
  let skewMs: number | null = null;
  if (bareSeconds !== null && lastTradeMs !== null) {
    const midnight = Date.UTC(
      new Date(lastTradeMs).getUTCFullYear(),
      new Date(lastTradeMs).getUTCMonth(),
      new Date(lastTradeMs).getUTCDate(),
    );
    skewMs = midnight + bareSeconds * 1000 - lastTradeMs;
    if (Math.abs(skewMs) > EU_TIMESTAMP_SKEW_LIMIT_MS) {
      problems.push(
        problem(
          'schema_drift',
          `top-level timestamp '${payloadTime ?? ''}' is ${String(Math.round(skewMs / 1000))}s ` +
            `from last_trade_time; it carries no date and is not used as provenance.source_ts (§5.4)`,
          '/timestamp',
        ),
      );
    }
  }

  const statusCode = text(data.status);
  const status: CboeEuIndexStatus = {
    code: statusCode,
    session: sessionOfStatus(statusCode),
    payloadTime,
    skewMs,
  };
  if (statusCode !== null && status.session === null) {
    problems.push(
      problem(
        'schema_drift',
        `unknown data.status '${statusCode}', expected C, O or H`,
        '/data/status',
      ),
    );
  }

  const resolved = lineFor(ctx, providerSymbol);
  if ('problem' in resolved) {
    return {
      updates: [],
      rows: { quoteTicks: [], crossChecks: [], identifiers: [], status },
      sourceTs: lastTradeMs === null ? null : new Date(lastTradeMs),
      problems: [...problems, resolved.problem],
    };
  }

  const built = buildQuote({ providerSymbol, data }, resolved.line, raw, ctx, {
    sourceId,
    session: options.session,
    europeanIndex: true,
    offsetTimestamps: true,
    path: '/data',
  });
  problems.push(...built.problems);

  // §5.4: `data.symbol` `"^BUK100P-SL"` is the Cboe European form, recorded as an identifier so a
  // later payload can be joined back to the instrument by what the provider actually calls it.
  const identifiers: CboeIdentifierRow[] = [];
  const providerForm = text(data.symbol);
  if (providerForm !== null) {
    identifiers.push({
      entityKind: 'instrument',
      entityId: resolved.line.instrumentId,
      scheme: 'PROVIDER_SYMBOL',
      value: providerForm,
      qualifier: sourceId,
      isPrimary: false,
    });
  }

  return {
    updates: built.update === null ? [] : [built.update],
    rows: {
      quoteTicks: built.update === null ? [] : [built.row],
      crossChecks: [built.crossCheck],
      identifiers,
      status,
    },
    // §5.4: the bare top-level time cannot serve; `last_trade_time` is the published instant.
    sourceTs: lastTradeMs === null ? null : new Date(lastTradeMs),
    problems,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §5.3 — cboe.symbolBook
// ─────────────────────────────────────────────────────────────────────────────────────────────

const EQUITY_NAME_RE = /^[A-Z]{1,5}$/;
const FUTURE_NAME_RE = /^[A-Z0-9]{2,6}[FGHJKMNQUVXZ]\d$/;

/**
 * §5.3 shape classification — the order matters, futures before the equity fallback.
 *
 * **Deviation from §5.3, forced by the capture.** The specification says an index is a `name`
 * starting `_` (`_SPX`, `_VIX`), but the underscore is the *delayed-quotes URL* convention: the
 * recorded symbol book carries **no** name starting `_` and 1,907 starting `^` — `^SPX`
 * (`S&P 500 INDEX`), `^VIX` (`Cboe Volatility Index`), and 1,905 more. Taking `_` literally
 * classifies every index as `'other'`, which is the difference between SPX being findable in
 * autocomplete at full weight and being a low-weight leftover (TERM-02). Both prefixes are
 * therefore accepted, so the rule survives whichever spelling a future capture uses.
 */
export function classifySymbolBookName(name: string, companyName: string): CboeSymbolKind {
  if (name.startsWith('_') || name.startsWith('^')) return 'index';
  if (FUTURE_NAME_RE.test(name) && companyName.includes('Futures')) return 'future';
  if (EQUITY_NAME_RE.test(name)) return 'equity';
  return 'other';
}

/** Code-unit ordering, so the sort does not depend on a locale or on the provider's ordering. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `cboe.symbolBook` — the 35,618-entry universe (§5.3).
 *
 * Writes **nothing** to the security master: it feeds `refdata/universe.ts` and
 * `search/snapshot.ts`. The array arrives sorted by `name`; it is sorted again here so the output
 * never depends on the provider's ordering, and duplicates keep the first entry.
 */
export function normaliseSymbolBook(
  raw: RawRecord,
  _ctx: NormaliseContext,
): Normalised<CboeSymbolBookRows> {
  const empty = (): CboeSymbolBookRows => ({
    entries: [],
    summary: {
      entryCount: 0,
      duplicateCount: 0,
      byKind: { equity: 0, future: 0, index: 0, other: 0 },
      belowMinimum: true,
    },
  });

  const json = readJson(raw);
  if (!json.ok) return failed(empty(), json.detail);
  if (!isRecord(json.value)) {
    return failed(empty(), `expected a JSON object, got ${describe(json.value)}`);
  }
  const payload = json.value;
  const data = payload.data;
  if (!Array.isArray(data)) {
    return failed(empty(), `'data' is ${describe(data)}, expected an array`, '/data');
  }

  const problems: NormaliseProblem[] = [];
  const sourceTsMs = parseCboeUtcMs(payload.timestamp);
  if (sourceTsMs === null) {
    problems.push(
      problem(
        'schema_drift',
        `top-level timestamp ${JSON.stringify(payload.timestamp)} is not the Cboe UTC form`,
        '/timestamp',
      ),
    );
  }

  const seen = new Map<string, CboeSymbolBookEntry>();
  let duplicateCount = 0;
  let malformed = 0;
  const bookEntries: readonly unknown[] = data;
  for (let i = 0; i < bookEntries.length; i++) {
    const entry = bookEntries[i];
    if (!isRecord(entry)) {
      malformed++;
      continue;
    }
    const name = text(entry.name);
    if (name === null) {
      malformed++;
      continue;
    }
    const companyName = typeof entry.company_name === 'string' ? entry.company_name : '';
    if (seen.has(name)) {
      duplicateCount++;
      // §5.3: keep the first, report the drop. Only the first few are named; the count is exact.
      if (duplicateCount <= 5) {
        problems.push(
          problem(
            'field_dropped',
            `duplicate symbol-book name '${name}'; the first entry is kept`,
            `/data/${String(i)}`,
          ),
        );
      }
      continue;
    }
    seen.set(name, { name, companyName, kind: classifySymbolBookName(name, companyName) });
  }
  if (malformed > 0) {
    problems.push(
      problem(
        'field_dropped',
        `${String(malformed)} symbol-book entries had no usable 'name'`,
        '/data',
      ),
    );
  }
  if (duplicateCount > 5) {
    problems.push(
      problem(
        'field_dropped',
        `${String(duplicateCount)} duplicate symbol-book names in total; the first entry of each is kept`,
        '/data',
      ),
    );
  }

  const entries = [...seen.values()].sort((a, b) => compareNames(a.name, b.name));
  const byKind: Record<CboeSymbolKind, number> = { equity: 0, future: 0, index: 0, other: 0 };
  for (const entry of entries) byKind[entry.kind]++;

  const belowMinimum = entries.length < SYMBOL_BOOK_MIN_ENTRIES;
  if (belowMinimum) {
    problems.push(
      problem(
        'out_of_range',
        `symbol book holds ${String(entries.length)} entries, fewer than the ` +
          `${String(SYMBOL_BOOK_MIN_ENTRIES)} floor (expected about ` +
          `${String(SYMBOL_BOOK_EXPECTED_ENTRIES)}) — a truncated CDN object; the previous ` +
          'snapshot stays live (§5.3)',
        '/data',
      ),
    );
  }

  return {
    updates: [],
    rows: {
      entries,
      summary: { entryCount: entries.length, duplicateCount, byKind, belowMinimum },
    },
    sourceTs: sourceTsMs === null ? null : new Date(sourceTsMs),
    problems,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §5.2 — cboe.options
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A standard monthly expiry is the third Friday; anything else is a weekly (§5.2). */
export function isThirdFriday(expiry: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDay() !== 5) return false;
  return day >= 15 && day <= 21;
}

interface ContractParse {
  row: CboeContractRow;
  quote: CboeOptionQuoteRow;
  fields: Partial<QuoteFields>;
  lastTradeMs: number | null;
  crossed: boolean;
  volume: number;
}

function greekInRange(name: string, value: number): boolean {
  switch (name) {
    case 'delta':
      return Math.abs(value) <= 1;
    case 'gamma':
    case 'vega':
      return value >= 0;
    default:
      return true;
  }
}

/**
 * `cboe.options` — the full chain with greeks and IV (§5.2).
 *
 * One fetch yields three things: the underlying quote (the §5.1 shape, on the `cboe.options` md
 * line so BUS-05 can compare it against the `cboe.quotes` line), the contract terms for every
 * `option` string, and the contract quotes. Only subscribed contracts and the ±10 strikes of the
 * money on the front three expiries produce plant updates; the rest are persisted and not fanned
 * out, because the payload is 1.5 MB and the plant is not a database.
 */
export function normaliseChain(
  raw: RawRecord,
  ctx: NormaliseContext,
  options: CboeChainOptions = {},
): Normalised<CboeChainRows> {
  const sourceId = options.sourceId ?? 'cboe.options';
  const emptyChain = (symbol: string): CboeChainSummary => ({
    underlyingSymbol: symbol,
    underlyingInstrumentId: 0,
    mdLineId: 0,
    contractCount: 0,
    expiries: [],
    frontExpiry: null,
    atmStrike: null,
    atmIv: null,
    callVolume: 0,
    putVolume: 0,
    putCallRatio: null,
    crossedCount: 0,
    unresolvedCount: 0,
    plantContractCount: 0,
  });
  const empty = (symbol = ''): CboeChainRows => ({
    quoteTicks: [],
    crossChecks: [],
    contracts: [],
    optionQuotes: [],
    chain: emptyChain(symbol),
  });

  const json = readJson(raw);
  if (!json.ok) return failed(empty(), json.detail);
  if (!isRecord(json.value)) {
    return failed(empty(), `expected a JSON object, got ${describe(json.value)}`);
  }
  const payload = json.value;
  const data = payload.data;
  if (!isRecord(data)) {
    return failed(empty(), `'data' is ${describe(data)}, expected an object`, '/data');
  }
  const rawOptions = data.options;
  if (!Array.isArray(rawOptions)) {
    return failed(
      empty(text(payload.symbol) ?? ''),
      `'data.options' is ${describe(rawOptions)}, expected an array`,
      '/data/options',
    );
  }

  const providerSymbol = options.providerSymbol ?? text(payload.symbol) ?? text(data.symbol);
  if (providerSymbol === null) {
    return failed(empty(), "no 'symbol' in the payload; the md line cannot be resolved");
  }

  const problems: NormaliseProblem[] = [];
  const sourceTsMs = parseCboeUtcMs(payload.timestamp);
  if (sourceTsMs === null) {
    problems.push(
      problem(
        'schema_drift',
        `top-level timestamp ${JSON.stringify(payload.timestamp)} is not the Cboe UTC form`,
        '/timestamp',
      ),
    );
  }
  const sourceTs = sourceTsMs === null ? null : new Date(sourceTsMs);

  const resolved = lineFor(ctx, providerSymbol);
  if ('problem' in resolved) {
    return {
      updates: [],
      rows: empty(providerSymbol),
      sourceTs,
      problems: [...problems, resolved.problem],
    };
  }
  const line = resolved.line;

  // 1 — the underlying block, byte-for-byte the §5.1 shape.
  const underlying = buildQuote({ providerSymbol, data }, line, raw, ctx, {
    sourceId,
    session: options.session,
    path: '/data',
  });
  problems.push(...underlying.problems);
  const underlyingPx = positive(data.current_price);

  // 2 and 3 — terms and quotes, one pass over the chain.
  const captureTs = new Date(raw.capturedAt).toISOString();
  const parsed: ContractParse[] = [];
  let crossedCount = 0;
  let callVolume = 0;
  let putVolume = 0;
  let unresolvedCount = 0;
  let badSymbols = 0;

  const chainEntries: readonly unknown[] = rawOptions;
  for (let i = 0; i < chainEntries.length; i++) {
    const path = `/data/options/${String(i)}`;
    const entry = chainEntries[i];
    if (!isRecord(entry)) {
      badSymbols++;
      problems.push(
        problem('parse_error', `chain entry is ${describe(entry)}, expected an object`, path),
      );
      continue;
    }
    const occSymbol = text(entry.option);
    if (occSymbol === null) {
      badSymbols++;
      problems.push(problem('parse_error', "chain entry has no 'option' symbol", path));
      continue;
    }
    const occ = parseOcc(occSymbol);
    if (!occ.ok) {
      badSymbols++;
      problems.push(
        problem(
          'parse_error',
          `'${occSymbol}' is not an OCC symbol: ${occ.problem.message}`,
          `${path}/option`,
        ),
      );
      continue;
    }

    const instrumentId =
      ctx.resolveInstrument?.({ scheme: 'OCC', value: occSymbol, qualifier: '' }) ?? null;
    if (instrumentId === null) unresolvedCount++;

    const contract: CboeContractRow = {
      occSymbol,
      root: occ.value.root,
      expiry: occ.value.expiry,
      putCall: occ.value.right,
      strike: occ.value.strike,
      multiplier: 100,
      exerciseStyle: 'american',
      settlement: 'physical',
      amPmSettlement: 'pm',
      tickSize: 0.01,
      isWeekly: !isThirdFriday(occ.value.expiry),
      lastTradeDate: occ.value.expiry,
      assetClass: 'option',
      marketSector: 'Equity',
      exchCode: 'US',
      currency: 'USD',
      instrumentId,
    };

    const bid = positive(entry.bid);
    const ask = positive(entry.ask);
    const bidSize = bid === null ? null : positiveInt(entry.bid_size);
    const askSize = ask === null ? null : positiveInt(entry.ask_size);
    const last = positive(entry.last_trade_price);
    const lastTradeMs = parseCboeEasternMs(entry.last_trade_time);
    const prevClose = positive(entry.prev_day_close);
    // Volume and open interest are counts: `0` is a measured fact for one contract on one day,
    // not a "not applicable", so they are stored and published as published.
    const volume = integral(entry.volume) ?? 0;
    const openInterest = integral(entry.open_interest);
    const iv = positive(entry.iv);

    if (iv === null && bid !== null) {
      // §5.2: `iv = 0` with a non-zero bid is a model gap, not a zero volatility. OPT_IV stays
      // absent so the screen shows `--`.
      problems.push(
        problem(
          'field_dropped',
          `iv is 0 on ${occSymbol} with a bid of ${String(bid)}`,
          `${path}/iv`,
        ),
      );
    }

    const greeks: Record<string, number | null> = {
      delta: finite(entry.delta),
      gamma: finite(entry.gamma),
      vega: finite(entry.vega),
      theta: finite(entry.theta),
      rho: finite(entry.rho),
      theo: positive(entry.theo),
    };
    for (const [name, value] of Object.entries(greeks)) {
      if (value !== null && !greekInRange(name, value)) {
        problems.push(
          problem(
            'out_of_range',
            `${name} ${String(value)} on ${occSymbol} is out of range`,
            `${path}/${name}`,
          ),
        );
        greeks[name] = null;
      }
    }

    const crossed = bid !== null && ask !== null && bid > ask;
    if (crossed) {
      crossedCount++;
      problems.push(
        problem(
          'parse_error',
          `crossed market on ${occSymbol}: bid ${String(bid)} > ask ${String(ask)}; the row is ` +
            'persisted and suppressed from the plant (§5.2)',
          path,
        ),
      );
    }

    if (contract.putCall === 'C') callVolume += volume;
    else putVolume += volume;

    const quote: CboeOptionQuoteRow = {
      captureTs,
      occSymbol,
      instrumentId,
      underlyingInstrumentId: line.instrumentId,
      mdLineId: line.mdLineId,
      bid,
      ask,
      bidSize,
      askSize,
      last,
      lastTs: isoOf(lastTradeMs),
      prevClose,
      volume,
      openInterest,
      iv,
      delta: greeks.delta ?? null,
      gamma: greeks.gamma ?? null,
      vega: greeks.vega ?? null,
      theta: greeks.theta ?? null,
      rho: greeks.rho ?? null,
      theo: greeks.theo ?? null,
      underlyingPx,
      provenanceId: ctx.provenanceId,
    };

    const fields: Partial<QuoteFields> = {};
    if (bid !== null) fields.PX_BID = bid;
    if (ask !== null) fields.PX_ASK = ask;
    if (bidSize !== null) fields.BID_SIZE = bidSize;
    if (askSize !== null) fields.ASK_SIZE = askSize;
    if (last !== null) fields.PX_LAST = last;
    if (lastTradeMs !== null) fields.LAST_TRADE_TIME = lastTradeMs;
    if (prevClose !== null) fields.PX_CLOSE_1D = prevClose;
    if (volume > 0) fields.PX_VOLUME = volume;
    if (openInterest !== null) fields.OPT_OI = openInterest;
    if (iv !== null) fields.OPT_IV = iv;
    if (quote.delta !== null) fields.OPT_DELTA = quote.delta;
    if (quote.gamma !== null) fields.OPT_GAMMA = quote.gamma;
    if (quote.vega !== null) fields.OPT_VEGA = quote.vega;
    if (quote.theta !== null) fields.OPT_THETA = quote.theta;
    if (quote.rho !== null) fields.OPT_RHO = quote.rho;
    if (quote.theo !== null) fields.OPT_THEO = quote.theo;
    if (options.session !== undefined) fields.SESSION_STATE = options.session;

    parsed.push({ row: contract, quote, fields, lastTradeMs, crossed, volume });
  }

  if (badSymbols > 0) {
    problems.push(
      problem(
        'field_dropped',
        `${String(badSymbols)} chain entries were unparseable and dropped`,
        '/data/options',
      ),
    );
  }

  // The chain aggregate: expiries, the ATM pair on the front expiry, the put/call ratio.
  const expiries = [...new Set(parsed.map((p) => p.row.expiry))].sort(compareNames);
  const frontExpiry = expiries[0] ?? null;
  let atmStrike: number | null = null;
  let atmIv: number | null = null;
  if (frontExpiry !== null && underlyingPx !== null) {
    const front = parsed.filter((p) => p.row.expiry === frontExpiry);
    for (const p of front) {
      if (
        atmStrike === null ||
        Math.abs(p.row.strike - underlyingPx) < Math.abs(atmStrike - underlyingPx)
      ) {
        atmStrike = p.row.strike;
      }
    }
    if (atmStrike !== null) {
      const pair = front.filter((p) => p.row.strike === atmStrike);
      const ivs = pair.map((p) => p.quote.iv).filter((iv): iv is number => iv !== null);
      atmIv = ivs.length === 0 ? null : ivs.reduce((a, b) => a + b, 0) / ivs.length;
    }
  }

  // §5.2 fan-out: subscribed contracts always; otherwise the ±10 strikes of the money on the
  // front three expiries. `atmStrikeWindow` counts strikes, not dollars, so it is computed per
  // expiry over that expiry's own sorted strike ladder.
  const depth = options.atmExpiryDepth ?? ATM_EXPIRY_DEPTH;
  const window = options.atmStrikeWindow ?? ATM_STRIKE_WINDOW;
  const fanOutStrikes = new Map<string, Set<number>>();
  if (underlyingPx !== null) {
    for (const expiry of expiries.slice(0, depth)) {
      const strikes = [
        ...new Set(parsed.filter((p) => p.row.expiry === expiry).map((p) => p.row.strike)),
      ].sort((a, b) => a - b);
      if (strikes.length === 0) continue;
      let nearest = 0;
      for (let i = 1; i < strikes.length; i++) {
        if (Math.abs(strikes[i]! - underlyingPx) < Math.abs(strikes[nearest]! - underlyingPx))
          nearest = i;
      }
      const from = Math.max(0, nearest - window);
      const to = Math.min(strikes.length - 1, nearest + window);
      fanOutStrikes.set(expiry, new Set(strikes.slice(from, to + 1)));
    }
  }

  const subscribed = options.subscribedOcc;
  const updates: NormalisedUpdate[] = underlying.update === null ? [] : [underlying.update];
  let plantContractCount = 0;
  for (const p of parsed) {
    if (p.crossed) continue;
    if (p.row.instrumentId === null) continue;
    const inWindow = fanOutStrikes.get(p.row.expiry)?.has(p.row.strike) === true;
    if (!inWindow && subscribed?.has(p.row.occSymbol) !== true) continue;
    plantContractCount++;
    updates.push({
      subject: `q:${String(p.row.instrumentId)}`,
      instrumentId: p.row.instrumentId,
      mdLineId: line.mdLineId,
      assetClass: 'option' satisfies AssetClass,
      tier: line.tier satisfies Tier,
      fields: p.fields,
      ts: { src: p.lastTradeMs, cap: raw.capturedAt, pub: raw.capturedAt },
      prov: { sourceId, provenanceId: ctx.provenanceId },
      ...(options.session === undefined ? {} : { session: options.session }),
    });
  }

  const chain: CboeChainSummary = {
    underlyingSymbol: providerSymbol,
    underlyingInstrumentId: line.instrumentId,
    mdLineId: line.mdLineId,
    contractCount: parsed.length,
    expiries,
    frontExpiry,
    atmStrike,
    atmIv,
    callVolume,
    putVolume,
    // §5.2: `null` when the call total is 0 — a ratio with a zero denominator is not "infinite
    // bearishness", it is an absent measurement.
    putCallRatio: callVolume === 0 ? null : putVolume / callVolume,
    crossedCount,
    unresolvedCount,
    plantContractCount,
  };

  return {
    updates,
    rows: {
      quoteTicks: underlying.update === null ? [] : [underlying.row],
      crossChecks: [underlying.crossCheck],
      contracts: parsed.map((p) => p.row),
      optionQuotes: parsed.map((p) => p.quote),
      chain,
    },
    sourceTs,
    problems,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A type name for an error message, without ever stringifying a 2 MB payload. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${String(value.length)}`;
  return `a ${typeof value}`;
}
