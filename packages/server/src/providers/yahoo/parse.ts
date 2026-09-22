/**
 * Yahoo Finance parsers — PROVIDERS.md §5.5 (`yahoo.chart`) and §5.6 (`yahoo.search`).
 *
 * **This module is pure.** No IO, no clock, no randomness, no `process.env`, no database. It is a
 * QA-05 fuzz target (`test/unit/providers/parse.fuzz.test.ts`) and therefore **never throws**: a
 * payload it cannot make sense of comes back as `{ ok: false, problems: [...] }`. Every number it
 * publishes is a function of the bytes it was handed, which is what makes the committed goldens
 * under `fixtures/providers/normalised/` meaningful (QA-02) and what lets a 2030 CI box reproduce
 * a 2026 capture bit for bit.
 *
 * Two deliberate consequences of purity, both visible in the goldens:
 *
 *  - **no `Date.now()`, so no `status`.** PROVIDERS §5.5 wants a dividend stamped `'paid'` when its
 *    ex-date is in the past and `'announced'` otherwise. That is a clock reading, so it happens in
 *    `adapter.ts#normalise`, from `NormaliseContext.capturedAt` (the only clock a normaliser sees),
 *    never here.
 *  - **no IANA time zone database.** Exchange-local dates (`bars_daily.session_date`,
 *    `corporate_actions.ex_date`) are derived from `meta.gmtoffset`, the offset the payload itself
 *    carries, rather than from `Intl` over `meta.exchangeTimezoneName`. `Intl`'s tz data moves with
 *    the ICU version bundled in Node, so a golden built through it would drift under the test
 *    runner's feet. The offset is the capture-time one, so it can be an hour wrong for a bar
 *    recorded in the other DST phase — which never changes the date, because every Yahoo daily bar
 *    and every dividend instant sits at the exchange open (13:30–14:30Z for New York, 07:00–08:00Z
 *    for London), the middle of the local day.
 */

import type { NormaliseProblem, RawRecord } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared result shape
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What a parser was given: the response bytes, and the URL they answered (for the interval). */
export interface YahooParseInput {
  /** `RawRecord.body`, or the decoded text — both are accepted so a fuzzer can hand either. */
  body: Uint8Array | string;
  /** `RawRecord.url`. Optional: the fuzzers omit it, and every parser copes. */
  url?: string | undefined;
}

/** A payload no parse rule could be applied to. Never thrown — always returned. */
export interface YahooParseFailure {
  readonly ok: false;
  readonly problems: NormaliseProblem[];
  /**
   * `chart.error` when the payload carried one. PROVIDERS §5.5: a `chart.error` is a hard failure
   * that `adapter.ts` raises as a `ProviderHttpError`, never a silent empty series.
   */
  readonly chartError: YahooChartError | null;
}

export interface YahooChartError {
  code: string;
  description: string;
}

/** A `RawRecord` is accepted directly; only these two fields are read. */
export function inputFromRaw(raw: Pick<RawRecord, 'body' | 'url'>): YahooParseInput {
  return { body: raw.body, url: raw.url };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tiny pure helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

const decoder = new TextDecoder('utf-8', { fatal: false });

/** Bytes → string. `fatal: false`, so malformed UTF-8 becomes U+FFFD instead of a throw. */
export function decodeBody(body: Uint8Array | string): string {
  return typeof body === 'string' ? body : decoder.decode(body);
}

function problem(kind: NormaliseProblem['kind'], detail: string, path?: string): NormaliseProblem {
  return path === undefined ? { kind, detail } : { kind, detail, path };
}

function fail(
  problems: NormaliseProblem[],
  chartError: YahooChartError | null = null,
): YahooParseFailure {
  return { ok: false, problems, chartError };
}

/** `unknown` → plain object, or `null`. Arrays are not objects here. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** A finite `number`, or `null`. Rejects `NaN`, `±Infinity`, strings and booleans. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

/**
 * Epoch **seconds** → exchange-local ISO date, using the payload's own UTC offset (see the header
 * note). `offsetSec` is `meta.gmtoffset`.
 */
export function localIsoDate(epochSeconds: number, offsetSec: number): string | null {
  if (!Number.isFinite(epochSeconds) || !Number.isFinite(offsetSec)) return null;
  const shifted = (epochSeconds + offsetSec) * 1000;
  // Beyond ±8.64e15 ms `Date` is Invalid; a fuzzed timestamp gets `null`, not a throw.
  if (!Number.isFinite(shifted) || Math.abs(shifted) > 8.64e15) return null;
  const date = new Date(shifted);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(year)) return null;
  const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0');
  return `${year < 0 ? '-' : ''}${pad(year, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** The `interval` query parameter of the request this payload answered, or `null`. */
export function requestedInterval(url: string | undefined): string | null {
  if (url === undefined || url === '') return null;
  try {
    return new URL(url).searchParams.get('interval');
  } catch {
    return null;
  }
}

/** The `range` query parameter, or `null`. */
export function requestedRange(url: string | undefined): string | null {
  if (url === undefined || url === '') return null;
  try {
    return new URL(url).searchParams.get('range');
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// yahoo.chart — §5.5
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Granularities that populate `bars_intraday`. */
export const INTRADAY_GRANULARITIES = ['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h'] as const;

/** Granularities that populate `bars_daily`. Only `1d`; `5d`/`1wk`/`1mo`/`3mo` are coarse. */
export const DAILY_GRANULARITIES = ['1d'] as const;

export type YahooBarKind = 'intraday' | 'daily' | 'coarse' | 'unknown';

/** Which table a granularity may be written to. */
export function barKindFor(granularity: string | null): YahooBarKind {
  if (granularity === null) return 'unknown';
  if ((INTRADAY_GRANULARITIES as readonly string[]).includes(granularity)) return 'intraday';
  if ((DAILY_GRANULARITIES as readonly string[]).includes(granularity)) return 'daily';
  if (['5d', '1wk', '1mo', '3mo'].includes(granularity)) return 'coarse';
  return 'unknown';
}

/** `bars_intraday.session` — PROVIDERS §5.5 `currentTradingPeriod` row. */
export type YahooSession = 'pre' | 'regular' | 'post';

export interface YahooTradingPeriod {
  start: number;
  end: number;
  gmtOffsetSec: number;
  timezone: string | null;
}

export interface YahooCurrentTradingPeriod {
  pre: YahooTradingPeriod | null;
  regular: YahooTradingPeriod | null;
  post: YahooTradingPeriod | null;
}

/** Everything `meta` carries that any consumer of this adapter needs. Epoch **ms**, not seconds. */
export interface YahooChartMeta {
  symbol: string;
  currency: string | null;
  instrumentType: string | null;
  exchangeName: string | null;
  fullExchangeName: string | null;
  exchangeTimezoneName: string | null;
  timezoneAbbr: string | null;
  /** `meta.gmtoffset`, seconds east of UTC at capture time. `0` when absent. */
  gmtOffsetSec: number;
  /** `instruments.first_trade_date` — epoch ms; negative for a pre-1970 listing (`^GSPC`). */
  firstTradeDateMs: number | null;
  /** `instruments.price_decimals`. */
  priceHint: number | null;
  dataGranularity: string | null;
  range: string | null;
  regularMarketTimeMs: number | null;
  regularMarketPrice: number | null;
  regularMarketDayHigh: number | null;
  regularMarketDayLow: number | null;
  regularMarketVolume: number | null;
  /** The close of the previous **session** — the `PX_CLOSE_1D` source (§5.5). */
  previousClose: number | null;
  /** The close before the chart's first bar. Never `PX_CLOSE_1D`: `0.128` on the `range=max` capture. */
  chartPreviousClose: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  hasPrePostMarketData: boolean;
  longName: string | null;
  shortName: string | null;
  currentTradingPeriod: YahooCurrentTradingPeriod | null;
  /**
   * `meta.tradingPeriods` flattened — one regular session per chart day, which is what classifies a
   * bar on a multi-day intraday range (`range=5d` carries five of them). Falls back to
   * `currentTradingPeriod.regular` when the payload omits the array.
   */
  regularPeriods: YahooTradingPeriod[];
}

export interface YahooBar {
  /** Bar **start**, epoch ms. */
  barTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** `null` is impossible here — a null in any of the five drops the bar — but `0` is common. */
  volume: number | null;
  /** `indicators.adjclose[0].adjclose[i]`; reconciliation only, never served (REF-09). */
  adjClose: number | null;
  session: YahooSession;
}

export interface YahooDividendEvent {
  /** The key of the `events.dividends` map, epoch ms: the **bar** the event was attached to. */
  barTsMs: number;
  /** `date`, epoch ms: the ex-dividend instant. */
  exTsMs: number;
  /** `date` in the exchange's local date — `corporate_actions.ex_date`. */
  exDate: string;
  amount: number;
  currency: string | null;
}

export interface YahooSplitEvent {
  barTsMs: number;
  exTsMs: number;
  exDate: string;
  numerator: number;
  denominator: number;
  splitRatio: string | null;
  /** `numerator > denominator` is a split; anything else is a reverse split (§5.5). */
  caType: 'split' | 'reverse_split';
}

/** The quote line built from `meta` alone — the `q:` line of §5.5. */
export interface YahooQuoteSnapshot {
  /**
   * `PX_LAST`, `PX_HIGH`, `PX_LOW`, `PX_VOLUME`, `PX_CLOSE_1D`. Keys are `QuoteFields` ids; a field
   * the payload does not carry is simply absent (never `0`, never `null`).
   *
   * `PX_VOLUME` is dropped when `regularMarketVolume` is `0` on an `INDEX` or `CURRENCY`
   * instrument: Yahoo publishes a zero there because it has no volume to publish, and writing it
   * would make MOST/VWAP screens read "0 shares traded" instead of "not applicable" (§5.5). It is
   * the documented shape of those payloads, so it raises no problem.
   */
  fields: Record<string, number>;
  /** FEED-05 `ts.src` — `meta.regularMarketTime × 1000`, `null` when the payload omits it. */
  sourceTsMs: number | null;
  /** `meta.regularMarketTime` against `currentTradingPeriod`. `SESSION_STATE` for the plant. */
  session: 'pre' | 'open' | 'post' | 'closed' | 'unknown';
  /**
   * 52-week range. **Not** in `fields`: `QuoteFields` (core `types/quote.ts`) has no
   * `PX_HIGH_52W`/`PX_LOW_52W` slot, so these cannot ride the plant today. They are published here
   * so the reference writer can still store them — see the note in the work-package report.
   */
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
}

export interface YahooChartParsed {
  readonly ok: true;
  symbol: string;
  meta: YahooChartMeta;
  quote: YahooQuoteSnapshot;
  /** `meta.dataGranularity`. */
  granularity: string | null;
  /** The `interval` the request asked for, `null` when the URL was not supplied. */
  requestedInterval: string | null;
  /** `false` ⇒ Yahoo silently downgraded the granularity — the `range=max` trap (§5.5). */
  granularityMatchesRequest: boolean | null;
  barKind: YahooBarKind;
  /**
   * `false` ⇒ the bars are parsed and published here (a caller may still chart them) but **must
   * not** be written to `bars_intraday`/`bars_daily`: a quarterly bar stored as a daily one would
   * corrupt every return series (§5.5). `adapter.ts#normalise` emits no bar rows when this is
   * `false`.
   */
  barsWritable: boolean;
  bars: YahooBar[];
  dividends: YahooDividendEvent[];
  splits: YahooSplitEvent[];
  problems: NormaliseProblem[];
}

export type YahooChartResult = YahooChartParsed | YahooParseFailure;

function readTradingPeriod(value: unknown): YahooTradingPeriod | null {
  const record = asRecord(value);
  if (record === null) return null;
  const start = num(record.start);
  const end = num(record.end);
  if (start === null || end === null) return null;
  return {
    start,
    end,
    gmtOffsetSec: num(record.gmtoffset) ?? 0,
    timezone: str(record.timezone),
  };
}

function readRegularPeriods(
  meta: Record<string, unknown>,
  current: YahooCurrentTradingPeriod | null,
): YahooTradingPeriod[] {
  const periods: YahooTradingPeriod[] = [];
  const outer = asArray(meta.tradingPeriods);
  if (outer !== null) {
    for (const day of outer) {
      // Yahoo nests one array per chart day; a flat array has been seen too, so both are read.
      const inner = asArray(day);
      if (inner === null) {
        const single = readTradingPeriod(day);
        if (single !== null) periods.push(single);
        continue;
      }
      for (const slot of inner) {
        const period = readTradingPeriod(slot);
        if (period !== null) periods.push(period);
      }
    }
  }
  if (periods.length === 0 && current?.regular != null) periods.push(current.regular);
  periods.sort((a, b) => a.start - b.start || a.end - b.end);
  return periods;
}

/**
 * Which session a bar start belongs to. A bar inside a published regular window is `regular`;
 * otherwise `currentTradingPeriod.pre`/`post` decide; otherwise the bar is placed relative to the
 * nearest regular window, which is what classifies an extended-hours bar on a day whose own
 * pre/post windows the payload never published.
 */
export function sessionForBar(barTsSec: number, meta: YahooChartMeta): YahooSession {
  for (const period of meta.regularPeriods) {
    if (barTsSec >= period.start && barTsSec < period.end) return 'regular';
  }
  const current = meta.currentTradingPeriod;
  if (current !== null) {
    const { pre, post } = current;
    if (pre !== null && barTsSec >= pre.start && barTsSec < pre.end) return 'pre';
    if (post !== null && barTsSec >= post.start && barTsSec < post.end) return 'post';
  }
  let nearest: YahooTradingPeriod | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const period of meta.regularPeriods) {
    const distance =
      barTsSec < period.start
        ? period.start - barTsSec
        : barTsSec - Math.max(period.end, period.start);
    if (distance < bestDistance) {
      bestDistance = distance;
      nearest = period;
    }
  }
  if (nearest === null) return 'regular';
  return barTsSec < nearest.start ? 'pre' : 'post';
}

function sessionForQuote(
  regularMarketTimeSec: number | null,
  current: YahooCurrentTradingPeriod | null,
): YahooQuoteSnapshot['session'] {
  if (regularMarketTimeSec === null || current === null) return 'unknown';
  const { pre, regular, post } = current;
  if (
    regular !== null &&
    regularMarketTimeSec >= regular.start &&
    regularMarketTimeSec < regular.end
  ) {
    return 'open';
  }
  if (pre !== null && regularMarketTimeSec >= pre.start && regularMarketTimeSec < pre.end)
    return 'pre';
  if (post !== null && regularMarketTimeSec >= post.start && regularMarketTimeSec < post.end)
    return 'post';
  return 'closed';
}

function readMeta(raw: Record<string, unknown>): YahooChartMeta | null {
  const symbol = str(raw.symbol);
  if (symbol === null || symbol === '') return null;

  const currentRaw = asRecord(raw.currentTradingPeriod);
  const current: YahooCurrentTradingPeriod | null =
    currentRaw === null
      ? null
      : {
          pre: readTradingPeriod(currentRaw.pre),
          regular: readTradingPeriod(currentRaw.regular),
          post: readTradingPeriod(currentRaw.post),
        };

  const firstTradeDate = num(raw.firstTradeDate);
  const regularMarketTime = num(raw.regularMarketTime);

  return {
    symbol,
    currency: str(raw.currency),
    instrumentType: str(raw.instrumentType),
    exchangeName: str(raw.exchangeName),
    fullExchangeName: str(raw.fullExchangeName),
    exchangeTimezoneName: str(raw.exchangeTimezoneName),
    timezoneAbbr: str(raw.timezone),
    gmtOffsetSec: num(raw.gmtoffset) ?? 0,
    firstTradeDateMs: firstTradeDate === null ? null : firstTradeDate * 1000,
    priceHint: num(raw.priceHint),
    dataGranularity: str(raw.dataGranularity),
    range: str(raw.range),
    regularMarketTimeMs: regularMarketTime === null ? null : regularMarketTime * 1000,
    regularMarketPrice: num(raw.regularMarketPrice),
    regularMarketDayHigh: num(raw.regularMarketDayHigh),
    regularMarketDayLow: num(raw.regularMarketDayLow),
    regularMarketVolume: num(raw.regularMarketVolume),
    previousClose: num(raw.previousClose),
    chartPreviousClose: num(raw.chartPreviousClose),
    fiftyTwoWeekHigh: num(raw.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(raw.fiftyTwoWeekLow),
    hasPrePostMarketData: bool(raw.hasPrePostMarketData),
    longName: str(raw.longName),
    shortName: str(raw.shortName),
    currentTradingPeriod: current,
    regularPeriods: readRegularPeriods(raw, current),
  };
}

function quoteFromMeta(meta: YahooChartMeta): YahooQuoteSnapshot {
  const fields: Record<string, number> = {};
  if (meta.regularMarketPrice !== null) fields.PX_LAST = meta.regularMarketPrice;
  if (meta.regularMarketDayHigh !== null) fields.PX_HIGH = meta.regularMarketDayHigh;
  if (meta.regularMarketDayLow !== null) fields.PX_LOW = meta.regularMarketDayLow;

  const volumeless =
    meta.instrumentType === 'INDEX' ||
    meta.instrumentType === 'CURRENCY' ||
    meta.instrumentType === null;
  if (meta.regularMarketVolume !== null && !(meta.regularMarketVolume === 0 && volumeless)) {
    fields.PX_VOLUME = meta.regularMarketVolume;
  }
  // `previousClose`, never `chartPreviousClose` (§5.5). A long-range request omits it entirely, so
  // the field is simply absent on those payloads.
  if (meta.previousClose !== null) fields.PX_CLOSE_1D = meta.previousClose;

  return {
    fields,
    sourceTsMs: meta.regularMarketTimeMs,
    session: sessionForQuote(
      meta.regularMarketTimeMs === null ? null : meta.regularMarketTimeMs / 1000,
      meta.currentTradingPeriod,
    ),
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
  };
}

function readEvents(
  events: Record<string, unknown> | null,
  meta: YahooChartMeta,
  problems: NormaliseProblem[],
): { dividends: YahooDividendEvent[]; splits: YahooSplitEvent[] } {
  const dividends: YahooDividendEvent[] = [];
  const splits: YahooSplitEvent[] = [];
  if (events === null) return { dividends, splits };

  const dividendMap = asRecord(events.dividends);
  if (dividendMap !== null) {
    for (const key of Object.keys(dividendMap).sort(compareNumericKeys)) {
      const entry = asRecord(dividendMap[key]);
      const barTs = Number(key);
      if (entry === null || !Number.isFinite(barTs)) {
        problems.push(
          problem(
            'field_dropped',
            `unreadable dividend entry '${key}'`,
            `/chart/result/0/events/dividends/${key}`,
          ),
        );
        continue;
      }
      const amount = num(entry.amount);
      const date = num(entry.date);
      if (amount === null || date === null) {
        problems.push(
          problem(
            'field_dropped',
            `dividend '${key}' is missing amount or date`,
            `/chart/result/0/events/dividends/${key}`,
          ),
        );
        continue;
      }
      const exDate = localIsoDate(date, meta.gmtOffsetSec);
      if (exDate === null) {
        problems.push(
          problem(
            'out_of_range',
            `dividend '${key}' has an unrepresentable date ${date}`,
            `/chart/result/0/events/dividends/${key}`,
          ),
        );
        continue;
      }
      dividends.push({
        barTsMs: barTs * 1000,
        exTsMs: date * 1000,
        exDate,
        amount,
        currency: meta.currency,
      });
    }
  }

  const splitMap = asRecord(events.splits);
  if (splitMap !== null) {
    for (const key of Object.keys(splitMap).sort(compareNumericKeys)) {
      const entry = asRecord(splitMap[key]);
      const barTs = Number(key);
      if (entry === null || !Number.isFinite(barTs)) {
        problems.push(
          problem(
            'field_dropped',
            `unreadable split entry '${key}'`,
            `/chart/result/0/events/splits/${key}`,
          ),
        );
        continue;
      }
      const date = num(entry.date);
      const numerator = num(entry.numerator);
      const denominator = num(entry.denominator);
      if (date === null || numerator === null || denominator === null) {
        problems.push(
          problem(
            'field_dropped',
            `split '${key}' is missing date, numerator or denominator`,
            `/chart/result/0/events/splits/${key}`,
          ),
        );
        continue;
      }
      if (numerator <= 0 || denominator <= 0) {
        problems.push(
          problem(
            'out_of_range',
            `split '${key}' has ratio ${numerator}:${denominator}`,
            `/chart/result/0/events/splits/${key}`,
          ),
        );
        continue;
      }
      const exDate = localIsoDate(date, meta.gmtOffsetSec);
      if (exDate === null) {
        problems.push(
          problem(
            'out_of_range',
            `split '${key}' has an unrepresentable date ${date}`,
            `/chart/result/0/events/splits/${key}`,
          ),
        );
        continue;
      }
      splits.push({
        barTsMs: barTs * 1000,
        exTsMs: date * 1000,
        exDate,
        numerator,
        denominator,
        splitRatio: str(entry.splitRatio),
        caType: numerator > denominator ? 'split' : 'reverse_split',
      });
    }
  }

  return { dividends, splits };
}

/** Sorts the string keys of an events map numerically, so the golden order is the time order. */
function compareNumericKeys(a: string, b: string): number {
  const left = Number(a);
  const right = Number(b);
  if (Number.isFinite(left) && Number.isFinite(right))
    return left - right || (a < b ? -1 : a > b ? 1 : 0);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `chart.result[0]` → meta, bars, events and the `q:` line. PROVIDERS §5.5.
 *
 * Rejection rules, all of them returning rather than throwing:
 *  - not JSON, or no `chart` object → `parse_error`;
 *  - `chart.error` non-null → `parse_error` carrying `{code, description}` in `chartError`;
 *  - no `result[0]`, or `meta.symbol` missing → `parse_error`;
 *  - `timestamp.length` differing from any quote array → the whole payload is rejected with a
 *    `parse_error` (§5.5 "Failures and data quality"), because a misaligned OHLC series is worse
 *    than no series.
 *
 * A `null` in any of `open/high/low/close/volume` is Yahoo's gap marker and drops that one bar —
 * never zero-filled, never forward-filled.
 */
export function parseYahooChart(input: YahooParseInput): YahooChartResult {
  const problems: NormaliseProblem[] = [];

  let document: unknown;
  try {
    document = JSON.parse(decodeBody(input.body)) as unknown;
  } catch (err) {
    return fail([problem('parse_error', `response is not JSON: ${(err as Error).message}`)]);
  }

  const root = asRecord(document);
  const chart = root === null ? null : asRecord(root.chart);
  if (chart === null) {
    return fail([problem('parse_error', 'payload has no `chart` object', '/chart')]);
  }

  const errorRecord = asRecord(chart.error);
  if (errorRecord !== null) {
    const chartError: YahooChartError = {
      code: str(errorRecord.code) ?? 'unknown',
      description: str(errorRecord.description) ?? '',
    };
    return fail(
      [
        problem(
          'parse_error',
          `chart.error ${chartError.code}: ${chartError.description}`,
          '/chart/error',
        ),
      ],
      chartError,
    );
  }

  const results = asArray(chart.result);
  const first = results === null ? null : asRecord(results[0]);
  if (first === null) {
    return fail([problem('parse_error', 'chart.result[0] is absent', '/chart/result/0')]);
  }

  const metaRecord = asRecord(first.meta);
  const meta = metaRecord === null ? null : readMeta(metaRecord);
  if (meta === null) {
    return fail([
      problem('parse_error', 'chart.result[0].meta has no symbol', '/chart/result/0/meta'),
    ]);
  }

  const interval = requestedInterval(input.url);
  const granularity = meta.dataGranularity;
  const granularityMatchesRequest = interval === null ? null : interval === granularity;
  const barKind = barKindFor(granularity);

  let barsWritable = true;
  if (granularityMatchesRequest === false) {
    // The `range=max` trap: `interval=1d` answered with `dataGranularity: "3mo"`.
    problems.push(
      problem(
        'schema_drift',
        `requested interval '${String(interval)}' but meta.dataGranularity is '${String(granularity)}'; ` +
          'bars are not written (a quarterly bar stored as a daily one corrupts every return series)',
        '/chart/result/0/meta/dataGranularity',
      ),
    );
    barsWritable = false;
  }
  if (barKind === 'coarse' || barKind === 'unknown') {
    if (granularityMatchesRequest !== false) {
      problems.push(
        problem(
          'schema_drift',
          `meta.dataGranularity '${String(granularity)}' maps to no bar table; bars are not written`,
          '/chart/result/0/meta/dataGranularity',
        ),
      );
    }
    barsWritable = false;
  }

  const timestamps = asArray(first.timestamp) ?? [];
  const indicators = asRecord(first.indicators);
  const quoteArray = indicators === null ? null : asArray(indicators.quote);
  const quoteBlock = quoteArray === null ? null : asRecord(quoteArray[0]);

  const opens = quoteBlock === null ? null : asArray(quoteBlock.open);
  const highs = quoteBlock === null ? null : asArray(quoteBlock.high);
  const lows = quoteBlock === null ? null : asArray(quoteBlock.low);
  const closes = quoteBlock === null ? null : asArray(quoteBlock.close);
  const volumes = quoteBlock === null ? null : asArray(quoteBlock.volume);

  const named: [string, unknown[] | null][] = [
    ['open', opens],
    ['high', highs],
    ['low', lows],
    ['close', closes],
    ['volume', volumes],
  ];

  const hasSeries = timestamps.length > 0 && quoteBlock !== null;
  if (hasSeries) {
    for (const [name, array] of named) {
      if (array === null) {
        return fail([
          problem(
            'parse_error',
            `indicators.quote[0].${name} is absent while timestamp has ${timestamps.length} entries`,
            `/chart/result/0/indicators/quote/0/${name}`,
          ),
        ]);
      }
      if (array.length !== timestamps.length) {
        // §5.5: a length mismatch rejects the whole payload — `dq_events kind 'parse_error'`.
        return fail([
          problem(
            'parse_error',
            `indicators.quote[0].${name} has ${array.length} entries but timestamp has ${timestamps.length}`,
            `/chart/result/0/indicators/quote/0/${name}`,
          ),
        ]);
      }
    }
  }

  // `indicators.adjclose[0].adjclose` — optional, and a length mismatch drops the column rather
  // than the payload: `src_adj_close` is reconciliation-only and never serves a screen (REF-09).
  let adjcloses: unknown[] | null = null;
  const adjArray = indicators === null ? null : asArray(indicators.adjclose);
  const adjBlock = adjArray === null ? null : asRecord(adjArray[0]);
  if (adjBlock !== null) {
    const candidate = asArray(adjBlock.adjclose);
    if (candidate !== null && candidate.length === timestamps.length) {
      adjcloses = candidate;
    } else {
      problems.push(
        problem(
          'field_dropped',
          `indicators.adjclose[0].adjclose has ${candidate === null ? 'no array' : `${candidate.length} entries`} ` +
            `against ${timestamps.length} timestamps; src_adj_close is dropped`,
          '/chart/result/0/indicators/adjclose/0/adjclose',
        ),
      );
    }
  }

  const bars: YahooBar[] = [];
  let gaps = 0;
  if (hasSeries) {
    const daily = barKind !== 'intraday';
    for (let i = 0; i < timestamps.length; i++) {
      const ts = num(timestamps[i]);
      const open = num(opens?.[i]);
      const high = num(highs?.[i]);
      const low = num(lows?.[i]);
      const close = num(closes?.[i]);
      const volume = num(volumes?.[i]);
      if (
        ts === null ||
        open === null ||
        high === null ||
        low === null ||
        close === null ||
        volume === null
      ) {
        gaps++;
        continue;
      }
      bars.push({
        barTs: ts * 1000,
        open,
        high,
        low,
        close,
        volume,
        adjClose: adjcloses === null ? null : num(adjcloses[i]),
        // A daily or coarser bar has no intraday session; §5.5 classifies only intraday bars.
        session: daily ? 'regular' : sessionForBar(ts, meta),
      });
    }
  }
  if (gaps > 0) {
    problems.push(
      problem(
        'field_dropped',
        `${gaps} of ${timestamps.length} bars dropped: a null in timestamp/open/high/low/close/volume ` +
          'is Yahoo’s gap marker and is never zero-filled',
        '/chart/result/0/indicators/quote/0',
      ),
    );
  }

  const { dividends, splits } = readEvents(asRecord(first.events), meta, problems);

  return {
    ok: true,
    symbol: meta.symbol,
    meta,
    quote: quoteFromMeta(meta),
    granularity,
    requestedInterval: interval,
    granularityMatchesRequest,
    barKind,
    barsWritable,
    bars,
    dividends,
    splits,
    problems,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// yahoo.search — §5.6
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `quoteType` → `instruments.asset_class` (§5.6). Anything absent from this map is discarded. */
export const QUOTE_TYPE_ASSET_CLASS: Readonly<Record<string, string>> = {
  EQUITY: 'equity',
  ETF: 'etf',
  INDEX: 'index',
  CURRENCY: 'fx',
  CRYPTOCURRENCY: 'crypto',
  MUTUALFUND: 'etf',
  FUTURE: 'future',
};

export interface YahooSearchQuote {
  symbol: string;
  shortName: string | null;
  longName: string | null;
  /** `"NMS"`. */
  exchange: string | null;
  /** `"NASDAQ"`. */
  exchDisp: string | null;
  quoteType: string;
  typeDisp: string | null;
  /** The mapped `AssetClass` value. */
  assetClass: string;
  sector: string | null;
  industry: string | null;
  /** Yahoo's own relevance score, on Yahoo's scale. **Never** merged into our ranking (§5.6). */
  score: number | null;
}

export interface YahooSearchParsed {
  readonly ok: true;
  /** The `q` parameter of the request, when the URL was supplied. */
  query: string | null;
  /** Yahoo's `count`, which is the count *before* our own filtering. */
  reportedCount: number | null;
  quotes: YahooSearchQuote[];
  problems: NormaliseProblem[];
}

export type YahooSearchResult = YahooSearchParsed | YahooParseFailure;

/**
 * `quotes[]` → autocomplete fallback rows. `news`, `nav`, `lists`, `researchReports`,
 * `screenerFieldResults` and every `timeTakenFor*` field are ignored (§5.6).
 *
 * This adapter writes nothing, so there are no rows — the result is handed straight back to
 * `GET /api/v1/search` tagged `sourceId: 'yahoo.search'`.
 */
export function parseYahooSearch(input: YahooParseInput): YahooSearchResult {
  const problems: NormaliseProblem[] = [];

  let document: unknown;
  try {
    document = JSON.parse(decodeBody(input.body)) as unknown;
  } catch (err) {
    return fail([problem('parse_error', `response is not JSON: ${(err as Error).message}`)]);
  }

  const root = asRecord(document);
  if (root === null) {
    return fail([problem('parse_error', 'payload is not a JSON object')]);
  }

  let query: string | null = null;
  if (input.url !== undefined && input.url !== '') {
    try {
      query = new URL(input.url).searchParams.get('q');
    } catch {
      query = null;
    }
  }

  const rawQuotes = asArray(root.quotes);
  if (rawQuotes === null) {
    return fail([problem('parse_error', 'payload has no `quotes` array', '/quotes')]);
  }

  const quotes: YahooSearchQuote[] = [];
  for (let i = 0; i < rawQuotes.length; i++) {
    const entry = asRecord(rawQuotes[i]);
    if (entry === null) {
      problems.push(problem('field_dropped', 'quotes element is not an object', `/quotes/${i}`));
      continue;
    }
    const symbol = str(entry.symbol);
    if (symbol === null || symbol === '') {
      // §5.6: an element without a symbol is skipped with a `field_dropped` problem.
      problems.push(problem('field_dropped', 'quotes element has no symbol', `/quotes/${i}`));
      continue;
    }
    const quoteType = str(entry.quoteType) ?? '';
    const assetClass = QUOTE_TYPE_ASSET_CLASS[quoteType];
    if (assetClass === undefined) {
      problems.push(
        problem(
          'field_dropped',
          `quoteType '${quoteType}' maps to no asset class; ${symbol} discarded`,
          `/quotes/${i}`,
        ),
      );
      continue;
    }
    if (quoteType === 'MUTUALFUND') {
      // §5.6 asks for the problem explicitly: a mutual fund is stored as an `etf`, which loses the
      // distinction, so the loss is recorded rather than hidden.
      problems.push(
        problem(
          'field_dropped',
          `${symbol} is a MUTUALFUND mapped to asset class 'etf'`,
          `/quotes/${i}/quoteType`,
        ),
      );
    }
    quotes.push({
      symbol,
      shortName: str(entry.shortname),
      longName: str(entry.longname),
      exchange: str(entry.exchange),
      exchDisp: str(entry.exchDisp),
      quoteType,
      typeDisp: str(entry.typeDisp),
      assetClass,
      sector: str(entry.sector),
      industry: str(entry.industry),
      score: num(entry.score),
    });
  }

  return { ok: true, query, reportedCount: num(root.count), quotes, problems };
}
