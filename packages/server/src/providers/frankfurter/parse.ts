/**
 * `frankfurter` — ECB reference FX, PROVIDERS.md §5.7.
 *
 * **Pure.** No IO, no clock, no randomness; a QA-05 fuzz target that never throws and returns
 * `{ ok: false, problems }` instead.
 *
 * The payload is one day's ECB fixing quoted per one unit of the request base:
 *
 * ```json
 * { "amount": 1.0, "base": "USD", "date": "2026-09-15",
 *   "rates": { "AUD": 1.4034, ..., "EUR": 0.86663, "GBP": 0.74166, "JPY": 155.0, ... } }
 * ```
 *
 * `base` and `amount` are **asserted**, not assumed: the job always requests `base=USD`, the
 * inversion below divides into 1, and a silently different base would write a whole day of wrong
 * cross-rates. `amount !== 1` or `base !== 'USD'` is a hard parse error (§5.7).
 */

import type { NormaliseProblem, RawRecord } from '../types.js';

/** The base the arithmetic here assumes, and the only one the job ever requests. */
export const EXPECTED_BASE = 'USD';

/**
 * §5.7: `date` is a date with no time. It becomes `provenance.source_ts` at **14:15:00Z**, the
 * ECB's publication instant, which is also `ts.src` for the reference line.
 */
export const ECB_PUBLICATION_TIME_UTC = '14:15:00Z';

/** `numeric(18,8)` — the inversion is rounded once, here, so every consumer sees the same number. */
export const FX_RATE_SCALE = 8;

export interface FrankfurterParseInput {
  body: Uint8Array | string;
  url?: string | undefined;
}

export function inputFromRaw(raw: Pick<RawRecord, 'body' | 'url'>): FrankfurterParseInput {
  return { body: raw.body, url: raw.url };
}

export interface FrankfurterRate {
  /** ISO-4217, as the payload spells it. */
  currency: string;
  /** `rates[CCY]` — units of `CCY` per one USD. `fx_rates(USD, CCY)`. */
  quotePerUsd: number;
  /** `1 / rates[CCY]`, rounded once at `numeric(18,8)`. `fx_rates(CCY, USD)`. */
  usdPerQuote: number;
}

export interface FrankfurterParsed {
  readonly ok: true;
  base: string;
  amount: number;
  /** `fx_rates.rate_date` / `bars_daily.session_date`. */
  date: string;
  /** `date` at 14:15:00Z, epoch ms — `provenance.source_ts` and `ts.src`. */
  sourceTsMs: number;
  /** Sorted by currency code, so the golden order is stable whatever the JSON key order was. */
  rates: FrankfurterRate[];
  problems: NormaliseProblem[];
}

export interface FrankfurterParseFailure {
  readonly ok: false;
  readonly problems: NormaliseProblem[];
}

export type FrankfurterResult = FrankfurterParsed | FrankfurterParseFailure;

const decoder = new TextDecoder('utf-8', { fatal: false });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

function decodeBody(body: Uint8Array | string): string {
  return typeof body === 'string' ? body : decoder.decode(body);
}

function problem(kind: NormaliseProblem['kind'], detail: string, path?: string): NormaliseProblem {
  return path === undefined ? { kind, detail } : { kind, detail, path };
}

/**
 * Round half away from zero at `FX_RATE_SCALE` decimals, through the decimal string rather than
 * through `Math.round(x * 1e8)` — `1e8` multiplication introduces a binary rounding step of its
 * own, and this number is pinned in a committed golden.
 */
export function roundRate(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(FX_RATE_SCALE));
}

/** `2026-09-15` → the epoch ms of `2026-09-15T14:15:00Z`, or `null` when the date is not a date. */
export function ecbPublicationInstant(date: string): number | null {
  if (!ISO_DATE.test(date)) return null;
  const ms = Date.parse(`${date}T${ECB_PUBLICATION_TIME_UTC}`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse one `v1/latest` (or `v1/{from}..{to}` single-day) payload.
 *
 * Non-fatal: a `rates` entry that is not a positive finite number, or whose key is not a 3-letter
 * code, is dropped with a problem — §5.7 wants a currency that disappears between runs recorded as
 * `field_dropped` plus a `data_exceptions` row of kind `missing_field`, which the ingest job writes
 * from these problems.
 */
export function parseFrankfurter(input: FrankfurterParseInput): FrankfurterResult {
  const problems: NormaliseProblem[] = [];

  let document: unknown;
  try {
    document = JSON.parse(decodeBody(input.body)) as unknown;
  } catch (err) {
    return {
      ok: false,
      problems: [problem('parse_error', `response is not JSON: ${(err as Error).message}`)],
    };
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { ok: false, problems: [problem('parse_error', 'payload is not a JSON object')] };
  }
  const root = document as Record<string, unknown>;

  const base = root.base;
  if (typeof base !== 'string' || base !== EXPECTED_BASE) {
    return {
      ok: false,
      problems: [
        problem(
          'parse_error',
          `base is ${JSON.stringify(base)}; this adapter requests and its arithmetic assumes ` +
            `'${EXPECTED_BASE}' (PROVIDERS §5.7)`,
          '/base',
        ),
      ],
    };
  }

  const amount = root.amount;
  if (typeof amount !== 'number' || amount !== 1) {
    return {
      ok: false,
      problems: [
        problem(
          'parse_error',
          `amount is ${JSON.stringify(amount)}; only amount 1 is supported`,
          '/amount',
        ),
      ],
    };
  }

  const date = root.date;
  if (typeof date !== 'string' || !ISO_DATE.test(date)) {
    return {
      ok: false,
      problems: [
        problem('parse_error', `date is ${JSON.stringify(date)}; expected YYYY-MM-DD`, '/date'),
      ],
    };
  }
  const sourceTsMs = ecbPublicationInstant(date);
  if (sourceTsMs === null) {
    return {
      ok: false,
      problems: [problem('parse_error', `date '${date}' is not a calendar date`, '/date')],
    };
  }

  const ratesRaw = root.rates;
  if (typeof ratesRaw !== 'object' || ratesRaw === null || Array.isArray(ratesRaw)) {
    return {
      ok: false,
      problems: [problem('parse_error', 'payload has no `rates` object', '/rates')],
    };
  }

  const rates: FrankfurterRate[] = [];
  for (const currency of Object.keys(ratesRaw).sort()) {
    const value = (ratesRaw as Record<string, unknown>)[currency];
    if (!CURRENCY_CODE.test(currency)) {
      problems.push(
        problem('field_dropped', `'${currency}' is not an ISO-4217 code`, `/rates/${currency}`),
      );
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(
        problem(
          'field_dropped',
          `rate for ${currency} is ${JSON.stringify(value)}`,
          `/rates/${currency}`,
        ),
      );
      continue;
    }
    if (value <= 0) {
      problems.push(
        problem('out_of_range', `rate for ${currency} is ${value}`, `/rates/${currency}`),
      );
      continue;
    }
    rates.push({ currency, quotePerUsd: value, usdPerQuote: roundRate(1 / value) });
  }

  if (rates.length === 0) {
    return {
      ok: false,
      problems: [...problems, problem('parse_error', '`rates` carried no usable rate', '/rates')],
    };
  }

  return { ok: true, base, amount, date, sourceTsMs, rates, problems };
}

/**
 * The conventional rate for `base/quote` out of a USD-based fixing —
 * `EURUSD = 1 / rates.EUR`, `USDJPY = rates.JPY`, `EURGBP = rates.GBP / rates.EUR`.
 *
 * Pure, and **driven by the pair it is asked for** (which comes from `fx_terms.base_ccy`/
 * `quote_ccy`), never by a hard-coded list of inverted majors (§5.7).
 */
export function crossRate(
  parsed: FrankfurterParsed,
  baseCcy: string,
  quoteCcy: string,
): number | null {
  if (baseCcy === quoteCcy) return 1;
  const perUsd = (code: string): number | null => {
    if (code === EXPECTED_BASE) return 1;
    const row = parsed.rates.find((rate) => rate.currency === code);
    return row === undefined ? null : row.quotePerUsd;
  };
  const baseRate = perUsd(baseCcy);
  const quoteRate = perUsd(quoteCcy);
  if (baseRate === null || quoteRate === null || baseRate === 0) return null;
  return roundRate(quoteRate / baseRate);
}
