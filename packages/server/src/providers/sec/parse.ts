/**
 * `providers/sec/parse.ts` — the six SEC normalisers, PROVIDERS §7 (L1252-1733).
 *
 * **Pure.** No IO, no clock, no randomness, no `process.env`, no database. The only instant any
 * function here may read is `ctx.capturedAt`, and the only bytes are `raw.body`. That is what makes
 * the goldens in `fixtures/providers/normalised/` meaningful (QA-02) and the QA-05 fuzzers
 * possible: every function below returns a `Normalised<Rows>` carrying a `parse_error` problem
 * rather than throwing, on any input at all, including truncated, reordered and corrupted bytes.
 *
 * Six `ProviderId`s share this module and one `adapter_version` `'sec/1.0.0'` (§7 preamble),
 * because they share the header discipline, the host pair and the bitemporal write path:
 *
 * | function | source | capture |
 * | --- | --- | --- |
 * | {@link normaliseTickers} | `sec.tickers` | `sec-company-tickers.json` |
 * | {@link normaliseSubmissions} | `sec.submissions` | `sec-submissions-AAPL.json`, `sec-spy-submissions.json` |
 * | {@link normaliseCompanyFacts} | `sec.companyfacts` | `sec-companyfacts-AAPL.json` |
 * | {@link normaliseFrames} | `sec.frames` | `sec-frames-assets.json` |
 * | {@link normaliseAtom} | `sec.atom` | `sec-8k-atom.xml` |
 * | {@link normaliseNport} | `sec.archives` | `sec-nport-SPY-primary_doc.xml` |
 *
 * ## Three conventions that hold across all six
 *
 * **CIK form.** Every `cik` a row carries is the zero-padded 10-character form (`'0000320193'`).
 * `core/ids/cik.ts#pad`/`#unpad` are the only two converters; a URL under `/Archives/edgar/data/`
 * needs the unpadded form and `providers/sec/adapter.ts` is the only place that asks for it.
 *
 * **Numbers are decimal text, never floats.** `value`, `weight`, `shares` and `market_value` are
 * Postgres `numeric` columns; a JavaScript float cannot carry `numeric(12,10)` and a round trip
 * through one silently rewrites the last digits of every index weight. `percentToFraction` shifts
 * the decimal point in the *string*, so `0.083321585405 %` becomes exactly `0.00083321585405`.
 *
 * **A row that cannot be trusted is dropped with a problem, never guessed at.** An 8-K entry whose
 * `<title>` does not match, a filing whose `acceptedAt` precedes its `filedDate`, an XBRL fact
 * outside ±1e15 — each is reported through `problems` and left out of `rows`. Nothing here invents
 * a value to keep a count round.
 */

import { padCik, unpadCik } from '@terminal/core';

import { attrOf, child, childText, childrenNamed, parseXmlBuffer, textOf } from '../xml.js';

import type {
  NormaliseContext,
  NormaliseProblem,
  NormaliseProblemKind,
  Normalised,
  RawRecord,
} from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared vocabulary
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `provenance.adapter_version` for all six SEC adapters (§7 preamble, §1.4). */
export const SEC_ADAPTER_VERSION = 'sec/1.0.0';

/** §7.1: fewer than this many entries in `company_tickers.json` and the payload is not believed. */
export const MIN_TICKER_ENTRIES = 8_000;

/** §7.1: the entry count of the 2026-09-15 capture, carried for the `poll_anomaly` details. */
export const EXPECTED_TICKER_ENTRIES = 10_422;

/** §7.3: the four units we model. Anything else is skipped with `field_dropped`. */
export const MODELLED_XBRL_UNITS: readonly string[] = ['USD', 'shares', 'USD/shares', 'pure'];

/** §7.3: only these two taxonomies are ingested. */
export const INGESTED_TAXONOMIES: readonly string[] = ['us-gaap', 'dei'];

/** §7.3: `|val|` beyond this is `out_of_range` and the fact is dropped. */
export const XBRL_VALUE_LIMIT = 1e15;

/** §7.6: the N-PORT holding count band outside which the filing is not believed. */
export const NPORT_MIN_HOLDINGS = 495;
export const NPORT_MAX_HOLDINGS = 515;

/** `exchanges[i]` → MIC (§7.2). A name we do not know maps to `null`, never to a guess. */
export const EXCHANGE_MIC: Readonly<Record<string, string>> = {
  Nasdaq: 'XNAS',
  NASDAQ: 'XNAS',
  NYSE: 'XNYS',
  'NYSE Arca': 'ARCX',
  'NYSE American': 'XASE',
  'NYSE Amex': 'XASE',
  Cboe: 'BATS',
  'Cboe BZX': 'BATS',
  OTC: 'OOTC',
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Pure helpers — every one of them total: no input makes any of these throw
// ─────────────────────────────────────────────────────────────────────────────────────────────

function problem(kind: NormaliseProblemKind, detail: string, path?: string): NormaliseProblem {
  return path === undefined ? { kind, detail } : { kind, detail, path };
}

/** A `Normalised` carrying nothing but one problem — the shape every failure path returns. */
function failed<Rows>(
  rows: Rows,
  detail: string,
  kind: NormaliseProblemKind = 'parse_error',
): Normalised<Rows> {
  return { updates: [], rows, sourceTs: null, problems: [problem(kind, detail)] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `JSON.parse` that reports rather than throws, and rejects a non-object document. */
function jsonObject(
  raw: RawRecord,
): { ok: true; value: Record<string, unknown> } | { ok: false; detail: string } {
  if (!Buffer.isBuffer(raw.body)) return { ok: false, detail: 'body is not a Buffer' };
  if (raw.body.length === 0) return { ok: false, detail: 'body is empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.body.toString('utf8'));
  } catch (err) {
    return { ok: false, detail: `body is not valid JSON: ${(err as Error).message}` };
  }
  if (!isRecord(parsed)) return { ok: false, detail: 'payload is not a JSON object' };
  return { ok: true, value: parsed };
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

/** `'2026-06-30'` when the string is a real calendar date, else `null`. Never throws. */
export function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${m[1]!}-${m[2]!}-${m[3]!}`;
}

/** Days since 1970-01-01 for a validated ISO date. */
function epochDay(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** `end - start` in whole days, or `null` when either side is not a date. */
export function dayDiff(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  return epochDay(end) - epochDay(start);
}

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(\.\d{1,9})?(Z|z|[+-]\d{2}:?\d{2})?$/;

/**
 * A strict ISO-8601 instant → canonical UTC `YYYY-MM-DDTHH:MM:SS[.mmm]Z`, or `null`.
 *
 * `Date.parse` is not used: its behaviour on anything but the narrow ISO grammar is
 * implementation-defined, and a normaliser whose output depends on the engine cannot have a
 * golden. An offset (`-04:00`, which only `sec.atom`'s `<updated>` carries) is subtracted here.
 */
export function isoInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = ISO_INSTANT.exec(value.trim());
  if (m === null) return null;
  const date = isoDate(`${m[1]!}-${m[2]!}-${m[3]!}`);
  if (date === null) return null;
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (hour > 23 || minute > 59 || second > 60) return null;
  const millis = m[7] === undefined ? 0 : Math.round(Number(`0${m[7]}`) * 1000);

  let offsetMinutes = 0;
  const zone = m[8];
  if (zone !== undefined && zone !== 'Z' && zone !== 'z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const body = zone.slice(1).replace(':', '');
    offsetMinutes = sign * (Number(body.slice(0, 2)) * 60 + Number(body.slice(2, 4)));
  }

  const epochMs =
    epochDay(date) * 86_400_000 +
    (hour * 60 + minute - offsetMinutes) * 60_000 +
    Math.min(second, 59) * 1000 +
    millis;
  const iso = new Date(epochMs).toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso;
}

/** US Eastern's offset in minutes on a date, by the post-2007 rule. Computed, never looked up. */
export function easternOffsetMinutes(date: string): number {
  const year = Number(date.slice(0, 4));
  const marchFirstDow = new Date(Date.UTC(year, 2, 1)).getUTCDay();
  const secondSundayMarch = 1 + ((7 - marchFirstDow) % 7) + 7;
  const novFirstDow = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstSundayNovember = 1 + ((7 - novFirstDow) % 7);
  const key = Number(date.slice(5, 7)) * 100 + Number(date.slice(8, 10));
  const start = 300 + secondSundayMarch;
  const end = 1100 + firstSundayNovember;
  return key >= start && key < end ? -240 : -300;
}

/** `'2026-09-14'` + 16:00 ET → `Date` of `2026-09-14T20:00:00Z`. */
export function easternInstant(date: string, hour: number, minute: number): Date {
  const local = hour * 60 + minute;
  return new Date((epochDay(date) * 1440 + local - easternOffsetMinutes(date)) * 60_000);
}

/**
 * Canonical decimal text for a `numeric` column: no exponent, no trailing zeros, at most
 * `maxScale` fraction digits. `null` for a non-finite number or one too large for the column.
 */
export function decimalText(value: unknown, maxScale = 6): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (Math.abs(value) >= 1e21) return null;
  const normalised = Object.is(value, -0) ? 0 : value;
  let text = String(normalised);
  if (text.includes('e') || text.includes('E')) text = normalised.toFixed(maxScale);
  const dot = text.indexOf('.');
  if (dot === -1) return text;
  const head = text.slice(0, dot);
  const frac = text.slice(dot + 1, dot + 1 + maxScale).replace(/0+$/, '');
  return frac === '' ? head : `${head}.${frac}`;
}

/**
 * Shift a decimal string's point `places` to the left, exactly — `'0.083321585405'` with 2 places
 * is `'0.00083321585405'`. String arithmetic, because `x / 100` on a float rewrites the tail of
 * every index weight and the sum stops landing on 1.
 */
export function percentToFraction(text: string | null, places = 2): string | null {
  if (text === null) return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (m === null) return null;
  const sign = m[1] === '-' ? '-' : '';
  const int = m[2] ?? '';
  const frac = m[3] ?? '';
  if (int === '' && frac === '') return null;

  let digits = int + frac;
  let pointAt = int.length - places;
  while (pointAt < 0) {
    digits = `0${digits}`;
    pointAt += 1;
  }
  const head = digits.slice(0, pointAt).replace(/^0+(?=\d)/, '') || '0';
  const tail = digits.slice(pointAt).replace(/0+$/, '');
  if (tail === '') return head === '0' ? '0' : `${sign}${head}`;
  return `${sign}${head}.${tail}`;
}

/** The numeric literal a `numeric` column would take from a published decimal string, or `null`. */
export function numericText(value: unknown, maxScale = 6): string | null {
  if (typeof value === 'number') return decimalText(value, maxScale);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const sign = trimmed.startsWith('-') ? '-' : '';
  const body = trimmed.replace(/^[+-]/, '');
  const dot = body.indexOf('.');
  const head = (dot === -1 ? body : body.slice(0, dot)).replace(/^0+(?=\d)/, '') || '0';
  const frac = (dot === -1 ? '' : body.slice(dot + 1)).slice(0, maxScale).replace(/0+$/, '');
  const magnitude = frac === '' ? head : `${head}.${frac}`;
  return magnitude === '0' ? '0' : `${sign}${magnitude}`;
}

/** Exact sum of decimal strings, to `scale` places — used for Σ pctVal and Σ weight checks. */
export function sumDecimal(values: readonly (string | null)[], scale: number): string {
  let total = 0n;
  const factor = 10n ** BigInt(scale);
  for (const value of values) {
    if (value === null) continue;
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value);
    if (m === null) continue;
    const sign = m[1] === '-' ? -1n : 1n;
    const int = BigInt(m[2] === '' || m[2] === undefined ? '0' : m[2]);
    const fracText = (m[3] ?? '').slice(0, scale).padEnd(scale, '0');
    const frac = BigInt(fracText === '' ? '0' : fracText);
    total += sign * (int * factor + frac);
  }
  const negative = total < 0n;
  const abs = negative ? -total : total;
  const head = (abs / factor).toString();
  const tail = (abs % factor).toString().padStart(scale, '0');
  return `${negative ? '-' : ''}${head}${scale > 0 ? `.${tail}` : ''}`;
}

/** The dashed 20-character accession form, or `null`. */
export function accessionNo(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{10}-\d{2}-\d{6}$/.test(trimmed) ? trimmed : null;
}

/**
 * `'xslFormNPORT-P_X01/primary_doc.xml'` → `'primary_doc.xml'` (§7.2 "the XSL trap").
 *
 * The `xsl…/` prefix names the styled viewer, which returns HTML. `filings.primary_doc` keeps the
 * value as published; only the Archives URL is built from the stripped form.
 */
export function stripXslPrefix(document: string): string {
  return document.replace(/^xsl[^/]*\//i, '');
}

/** `https://www.sec.gov/Archives/edgar/data/<unpadded cik>/<accession, no dashes>/<document>`. */
export function archivesUrl(cik: string, accession: string, document: string): string | null {
  const unpadded = unpadCik(cik);
  if (unpadded === null) return null;
  const bare = accession.replace(/-/g, '');
  if (!/^\d{18}$/.test(bare)) return null;
  const doc = stripXslPrefix(document.trim());
  const tail = doc === '' ? `${accession}-index.htm` : doc;
  return `https://www.sec.gov/Archives/edgar/data/${unpadded}/${bare}/${tail}`;
}

/** {@link padCik} over a value of unknown type: never throws, never widens a lie into a cast. */
function cikOf(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return padCik(value);
}

/** A value of unknown type, safe to put in a problem's `detail`. Never `[object Object]`. */
function show(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return String(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    return typeof value;
  }
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.1 — sec.tickers
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** One issuer of `company_tickers.json`, with every ticker the file published under its CIK. */
export interface SecTickerIssuer {
  /** Zero-padded 10 characters. */
  cik: string;
  /** `title` — wins over OpenFIGI's `name` (§6.1). */
  name: string;
  /** `'company'` by default; §7.2 overwrites it for funds and sovereigns. */
  entityType: 'company';
  /**
   * The SEC spelling, in payload order: `'BRK-B'` keeps the hyphen. The Cboe/Yahoo `.`/`-`
   * variants are separate `TICKER_EXCH` identifiers and are never made by rewriting this.
   */
  tickers: string[];
}

/** One ticker published under two CIKs — `data_exceptions` kind `'source_conflict'` (§7.1). */
export interface SecTickerConflict {
  ticker: string;
  ciks: string[];
}

export interface SecTickersRows {
  issuers: SecTickerIssuer[];
  conflicts: SecTickerConflict[];
  /** Entries in the payload — 10,422 in the 2026-09-15 capture. */
  entryCount: number;
  /** Distinct CIKs — fewer than `entryCount`, because multi-class issuers repeat. */
  issuerCount: number;
  /** §7.1: below {@link MIN_TICKER_ENTRIES} the caller writes `poll_anomaly` and writes nothing. */
  belowMinimum: boolean;
}

const EMPTY_TICKERS: SecTickersRows = {
  issuers: [],
  conflicts: [],
  entryCount: 0,
  issuerCount: 0,
  belowMinimum: true,
};

/**
 * `company_tickers.json` → issuers with their tickers (§7.1).
 *
 * The payload is **not an array**: it is an object whose keys are the decimal strings `"0"`…
 * `"10421"`. They are sorted **numerically** — under string ordering `"10" < "9"`, which would
 * shuffle the output and break the golden — and grouped by `cik_str`, so a multi-class issuer
 * (`GOOGL`/`GOOG`) yields one row with two tickers.
 */
export function normaliseTickers(
  raw: RawRecord,
  _ctx: NormaliseContext,
): Normalised<SecTickersRows> {
  const body = jsonObject(raw);
  if (!body.ok) return failed(EMPTY_TICKERS, `sec.tickers: ${body.detail}`);

  const problems: NormaliseProblem[] = [];
  const keys = Object.keys(body.value)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b));

  if (keys.length === 0) {
    return failed(EMPTY_TICKERS, 'sec.tickers: payload has no numeric entry keys');
  }

  const byCik = new Map<string, SecTickerIssuer>();
  const tickerOwners = new Map<string, Set<string>>();
  let entryCount = 0;

  for (const key of keys) {
    const entry = body.value[key];
    if (!isRecord(entry)) {
      problems.push(problem('schema_drift', `entry '${key}' is not an object`, `/${key}`));
      continue;
    }
    const cik = cikOf(entry.cik_str);
    const ticker = stringOrNull(entry.ticker);
    const title = stringOrNull(entry.title);
    if (cik === null || ticker === null || title === null) {
      problems.push(
        problem('schema_drift', `entry '${key}' is missing cik_str, ticker or title`, `/${key}`),
      );
      continue;
    }
    entryCount += 1;

    const existing = byCik.get(cik);
    if (existing === undefined) {
      byCik.set(cik, { cik, name: title, entityType: 'company', tickers: [ticker] });
    } else if (!existing.tickers.includes(ticker)) {
      existing.tickers.push(ticker);
    }

    let owners = tickerOwners.get(ticker);
    if (owners === undefined) {
      owners = new Set<string>();
      tickerOwners.set(ticker, owners);
    }
    owners.add(cik);
  }

  const conflicts: SecTickerConflict[] = [];
  for (const ticker of [...tickerOwners.keys()].sort()) {
    const owners = tickerOwners.get(ticker)!;
    if (owners.size < 2) continue;
    const ciks = [...owners].sort();
    conflicts.push({ ticker, ciks });
    problems.push(
      problem(
        'schema_drift',
        `source_conflict: ticker '${ticker}' is published under CIKs ${ciks.join(', ')}`,
      ),
    );
  }

  const issuers = [...byCik.values()];
  return {
    updates: [],
    rows: {
      issuers,
      conflicts,
      entryCount,
      issuerCount: issuers.length,
      belowMinimum: entryCount < MIN_TICKER_ENTRIES,
    },
    sourceTs: null,
    problems,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.2 — sec.submissions
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The `issuers` half of a submissions payload. Every field is `| null`, never absent. */
export interface SubmissionsIssuer {
  cik: string;
  name: string;
  sic: string | null;
  sicDescription: string | null;
  fiscalYearEnd: string | null;
  stateOfInc: string | null;
  filerCategory: string | null;
  /** `'operating'`, `'other'`, … and `'fund'` when §7.2's fund rule fires. */
  entityType: string;
  website: string | null;
  formerNames: { name: string; from: string | null; to: string | null }[];
}

export interface SubmissionsIdentifier {
  scheme: 'LEI' | 'TICKER_EXCH';
  value: string;
  qualifier: string;
}

export interface SubmissionsListing {
  ticker: string;
  exchange: string;
  /** `null` when the exchange name is not in {@link EXCHANGE_MIC} — never a guess. */
  mic: string | null;
}

/** One `filings` row. Column names are DATA_MODEL's, camel-cased. */
export interface FilingRow {
  accessionNo: string;
  cik: string;
  form: string;
  filedDate: string;
  /** The public-knowledge instant (§7.3.2), canonical UTC. */
  acceptedAt: string | null;
  reportDate: string | null;
  items: string[];
  /** As published — `'xslFormNPORT-P_X01/primary_doc.xml'` is stored verbatim (§7.2). */
  primaryDoc: string | null;
  primaryDocDesc: string | null;
  isXbrl: boolean;
  isInlineXbrl: boolean;
  sizeBytes: number | null;
  /** Built from the **stripped** document, because the `xsl…/` prefix returns HTML. */
  url: string;
}

export interface SubmissionsOverflowFile {
  name: string;
  filingCount: number | null;
  filingFrom: string | null;
  filingTo: string | null;
}

export interface SecSubmissionsRows {
  issuer: SubmissionsIssuer | null;
  identifiers: SubmissionsIdentifier[];
  aliases: { alias: string; kind: 'former_name'; from: string | null; to: string | null }[];
  classifications: { scheme: 'SIC'; code: string }[];
  listings: SubmissionsListing[];
  filings: FilingRow[];
  overflowFiles: SubmissionsOverflowFile[];
  /** The newest `filingDate` in `recent` — the input to §7.2's stale-CDN `poll_anomaly`. */
  newestFilingDate: string | null;
  /**
   * Filings accepted **before** their filing date began in ET. EDGAR dates a submission accepted
   * after 17:30 ET to the next business day, so this is ordinary — 49 of Apple's 1,000 filings.
   */
  acceptedBeforeFiledDate: number;
  /**
   * Filings accepted more than a day **after** their filing date: the `9999999997-*` paper and
   * `NO ACT` pseudo-accessions, whose filing date is the paper date and whose acceptance is the
   * instant the document was scanned in. Seven of Apple's 1,000, by up to 96 days.
   */
  acceptedAfterFiledDate: number;
}

const EMPTY_SUBMISSIONS: SecSubmissionsRows = {
  issuer: null,
  identifiers: [],
  aliases: [],
  classifications: [],
  listings: [],
  filings: [],
  overflowFiles: [],
  newestFilingDate: null,
  acceptedBeforeFiledDate: 0,
  acceptedAfterFiledDate: 0,
};

/** The fourteen-plus parallel arrays of `filings.recent` that we read. */
const RECENT_COLUMNS = [
  'accessionNumber',
  'filingDate',
  'reportDate',
  'acceptanceDateTime',
  'form',
  'items',
  'size',
  'isXBRL',
  'isInlineXBRL',
  'primaryDocument',
  'primaryDocDescription',
] as const;

/**
 * `Array.isArray` narrows an `unknown` to `any[]`, and an element read out of that is an `any` that
 * spreads through everything it touches. Every array read in this module goes through here instead.
 */
function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

function elementAt(column: unknown, index: number): unknown {
  return asArray(column)?.[index];
}

function stringAt(column: unknown, index: number): string {
  const value = elementAt(column, index);
  return typeof value === 'string' ? value.trim() : '';
}

function numberAt(column: unknown, index: number): number | null {
  const value = elementAt(column, index);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function flagAt(column: unknown, index: number): boolean {
  const value = elementAt(column, index);
  return value === 1 || value === true || value === '1';
}

/**
 * `submissions/CIK##########.json` → the issuer header and its filing index (§7.2).
 *
 * `filings.recent` is **column-oriented**: parallel arrays of equal length (1,000 for AAPL, 275 for
 * SPY). Every array is checked against the first before anything is zipped — a short array would
 * silently shift every subsequent filing's form type by one, which is a `schema_drift` that drops
 * the whole payload rather than a row-level problem.
 */
export function normaliseSubmissions(
  raw: RawRecord,
  _ctx: NormaliseContext,
): Normalised<SecSubmissionsRows> {
  const body = jsonObject(raw);
  if (!body.ok) return failed(EMPTY_SUBMISSIONS, `sec.submissions: ${body.detail}`);
  const payload = body.value;

  const cik = cikOf(payload.cik);
  const name = stringOrNull(payload.name);
  if (cik === null || name === null) {
    return failed(EMPTY_SUBMISSIONS, 'sec.submissions: payload has no cik or no name');
  }

  const problems: NormaliseProblem[] = [];

  // ── header ────────────────────────────────────────────────────────────────────────────────
  const tickers = Array.isArray(payload.tickers)
    ? payload.tickers.filter((t): t is string => typeof t === 'string')
    : [];
  const exchanges = Array.isArray(payload.exchanges)
    ? payload.exchanges.filter((e): e is string => typeof e === 'string')
    : [];

  const formerNames: SubmissionsIssuer['formerNames'] = [];
  const aliases: SecSubmissionsRows['aliases'] = [];
  const rawFormerNames = payload.formerNames;
  if (Array.isArray(rawFormerNames)) {
    for (const [index, entry] of rawFormerNames.entries()) {
      if (!isRecord(entry)) continue;
      const alias = stringOrNull(entry.name);
      if (alias === null) {
        problems.push(
          problem('field_dropped', 'formerNames entry has no name', `/formerNames/${index}`),
        );
        continue;
      }
      const from = isoInstant(entry.from);
      const to = isoInstant(entry.to);
      formerNames.push({ name: alias, from, to });
      aliases.push({ alias, kind: 'former_name', from, to });
    }
  }

  const identifiers: SubmissionsIdentifier[] = [];
  const lei = stringOrNull(payload.lei);
  if (lei !== null) identifiers.push({ scheme: 'LEI', value: lei, qualifier: '' });

  const listings: SubmissionsListing[] = [];
  for (const [index, ticker] of tickers.entries()) {
    const trimmed = ticker.trim();
    if (trimmed === '') continue;
    identifiers.push({ scheme: 'TICKER_EXCH', value: trimmed, qualifier: 'US' });
    const exchange = (exchanges[index] ?? '').trim();
    const mic = EXCHANGE_MIC[exchange] ?? null;
    if (exchange !== '' && mic === null) {
      problems.push(
        problem(
          'field_dropped',
          `exchange '${exchange}' has no MIC in the literal table`,
          `/exchanges/${index}`,
        ),
      );
    }
    listings.push({ ticker: trimmed, exchange, mic });
  }

  const sic = stringOrNull(payload.sic);
  const classifications: SecSubmissionsRows['classifications'] =
    sic === null ? [] : [{ scheme: 'SIC', code: sic }];

  // ── filings.recent ────────────────────────────────────────────────────────────────────────
  const filingsNode = payload.filings;
  const recent = isRecord(filingsNode) ? filingsNode.recent : undefined;
  const filings: FilingRow[] = [];
  let newestFilingDate: string | null = null;
  let lengthMismatch = false;
  let acceptedBeforeFiledDate = 0;
  let acceptedAfterFiledDate = 0;

  if (!isRecord(recent)) {
    problems.push(
      problem('schema_drift', 'filings.recent is missing or not an object', '/filings/recent'),
    );
  } else {
    const accession = recent.accessionNumber;
    const rowCount = Array.isArray(accession) ? accession.length : -1;
    if (rowCount < 0) {
      problems.push(
        problem(
          'schema_drift',
          'filings.recent.accessionNumber is not an array',
          '/filings/recent/accessionNumber',
        ),
      );
      lengthMismatch = true;
    } else {
      for (const column of RECENT_COLUMNS) {
        const values = recent[column];
        if (!Array.isArray(values) || values.length !== rowCount) {
          problems.push(
            problem(
              'schema_drift',
              `filings.recent.${column} has ${Array.isArray(values) ? String(values.length) : 'no'} ` +
                `entries against accessionNumber's ${String(rowCount)} — the whole payload is dropped, ` +
                'because a short array shifts every later filing by one',
              `/filings/recent/${column}`,
            ),
          );
          lengthMismatch = true;
        }
      }
    }

    if (!lengthMismatch && rowCount >= 0) {
      for (let index = 0; index < rowCount; index += 1) {
        const at = `/filings/recent/${String(index)}`;
        const accessionValue = accessionNo(stringAt(accession, index));
        if (accessionValue === null) {
          problems.push(
            problem('parse_error', 'accessionNumber is not a dashed 20-character accession', at),
          );
          continue;
        }
        const filedDate = isoDate(stringAt(recent.filingDate, index));
        if (filedDate === null) {
          problems.push(
            problem('parse_error', `filingDate of ${accessionValue} is not a date`, at),
          );
          continue;
        }
        const form = stringAt(recent.form, index) || stringAt(recent.core_type, index);
        if (form === '') {
          problems.push(problem('parse_error', `${accessionValue} has no form`, at));
          continue;
        }

        const acceptedAt = isoInstant(stringAt(recent.acceptanceDateTime, index));
        let lagDays = 0;
        if (acceptedAt !== null) {
          // §7.3.2. PROVIDERS §7.2 says to drop a filing whose `accepted_at` precedes its
          // `filed_date` 00:00 ET. **The recorded bytes say otherwise**, and the rule as written
          // would throw away 49 of Apple's 1,000 filings and 15 of SPY's 275 — including the
          // 2024-08-01 10-Q. Two legitimate patterns produce that ordering:
          //
          //  * EDGAR dates a submission accepted after 17:30 ET to the **next business day**, so
          //    acceptance an evening (or a Friday, two days) before the filing date is the norm;
          //  * a `9999999997-*` paper/`NO ACT` pseudo-accession carries the paper filing date and
          //    the later instant the document was scanned in — acceptance *after* the filing date,
          //    by up to 96 days in this capture.
          //
          // Neither is a parse error, and neither breaks point-in-time correctness: `filed_at` is
          // the coarse filter and `filings.accepted_at` is the tie-break, so a row whose acceptance
          // is late is simply invisible to a `knownAt` before it — which is the conservative
          // direction the PIT read already takes (§7.3.2). Both directions are counted instead, so
          // the job can raise `poll_anomaly` on a payload where they are the rule rather than the
          // exception. Only an impossible instant is dropped.
          const filedStart = easternInstant(filedDate, 0, 0).getTime();
          lagDays = (Date.parse(acceptedAt) - filedStart) / 86_400_000;
          if (Math.abs(lagDays) > 366) {
            problems.push(
              problem(
                'parse_error',
                `${accessionValue} was accepted at ${acceptedAt}, ${Math.round(Math.abs(lagDays)).toString()} ` +
                  `days from its filing date ${filedDate} — the two are unrelatable, which is what a ` +
                  'shifted parallel array looks like, so the row is dropped',
                at,
              ),
            );
            continue;
          }
          if (lagDays < 0) acceptedBeforeFiledDate += 1;
          else if (lagDays > 1) acceptedAfterFiledDate += 1;
        }

        const itemsText = stringAt(recent.items, index);
        const items =
          itemsText === ''
            ? []
            : itemsText
                .split(',')
                .map((item) => item.trim())
                .filter((item) => item !== '');

        const primaryDocRaw = stringAt(recent.primaryDocument, index);
        const url = archivesUrl(cik, accessionValue, primaryDocRaw);
        if (url === null) {
          problems.push(problem('parse_error', `${accessionValue} yields no Archives URL`, at));
          continue;
        }

        filings.push({
          accessionNo: accessionValue,
          cik,
          form,
          filedDate,
          acceptedAt,
          reportDate: isoDate(stringAt(recent.reportDate, index)),
          items,
          primaryDoc: primaryDocRaw === '' ? null : primaryDocRaw,
          primaryDocDesc: stringOrNull(stringAt(recent.primaryDocDescription, index)),
          isXbrl: flagAt(recent.isXBRL, index),
          isInlineXbrl: flagAt(recent.isInlineXBRL, index),
          sizeBytes: numberAt(recent.size, index),
          url,
        });
        if (newestFilingDate === null || filedDate > newestFilingDate) newestFilingDate = filedDate;
      }
    }
  }

  // §7.2: `'other'` + tickers + an NPORT-P history ⇒ a fund. This is how SPY's issuer is typed.
  const declaredType = stringOrNull(payload.entityType) ?? 'operating';
  const hasNport = filings.some((filing) => filing.form.startsWith('NPORT-'));
  const entityType =
    declaredType === 'other' && tickers.length > 0 && hasNport ? 'fund' : declaredType;

  const overflowFiles: SubmissionsOverflowFile[] = [];
  const files = isRecord(filingsNode) ? filingsNode.files : undefined;
  if (Array.isArray(files)) {
    for (const entry of files) {
      if (!isRecord(entry)) continue;
      const fileName = stringOrNull(entry.name);
      if (fileName === null) continue;
      overflowFiles.push({
        name: fileName,
        filingCount: typeof entry.filingCount === 'number' ? entry.filingCount : null,
        filingFrom: isoDate(entry.filingFrom),
        filingTo: isoDate(entry.filingTo),
      });
    }
  }

  const issuer: SubmissionsIssuer = {
    cik,
    name,
    sic,
    sicDescription: stringOrNull(payload.sicDescription),
    fiscalYearEnd: stringOrNull(payload.fiscalYearEnd),
    stateOfInc: stringOrNull(payload.stateOfIncorporation),
    filerCategory: stringOrNull(payload.category),
    entityType,
    website: stringOrNull(payload.website),
    formerNames,
  };

  // The provider-published instant this payload carries is the newest acceptance it reports.
  let sourceTs: Date | null = null;
  for (const filing of filings) {
    if (filing.acceptedAt === null) continue;
    const instant = new Date(filing.acceptedAt);
    if (sourceTs === null || instant.getTime() > sourceTs.getTime()) sourceTs = instant;
  }

  return {
    updates: [],
    rows: {
      issuer,
      identifiers,
      aliases,
      classifications,
      listings,
      filings,
      overflowFiles,
      newestFilingDate,
      acceptedBeforeFiledDate,
      acceptedAfterFiledDate,
    },
    sourceTs,
    problems,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.3 — sec.companyfacts
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The duration class §7.3 derives from `period_end − period_start`. It is not in the payload and
 * it is what keeps the statement builder from summing a quarter, a nine-month and an annual
 * duration of the same revenue into one number three times too large.
 */
export type XbrlDurationClass = 'instant' | 'quarter' | 'half' | 'nine_month' | 'annual' | 'other';

export function durationClass(days: number | null): XbrlDurationClass {
  if (days === null) return 'instant';
  if (days >= 80 && days <= 100) return 'quarter';
  if (days >= 170 && days <= 190) return 'half';
  if (days >= 260 && days <= 285) return 'nine_month';
  if (days >= 350 && days <= 380) return 'annual';
  return 'other';
}

/** One `xbrl_facts` row. Append-only: the table carries a WORM trigger (DATA_MODEL L2245). */
export interface XbrlFactRow {
  cik: string;
  taxonomy: string;
  concept: string;
  unit: string;
  /** `null` for an instant (balance-sheet) fact — what `xbrl_facts_period_chk` keys on. */
  periodStart: string | null;
  periodEnd: string;
  fy: number | null;
  fp: string | null;
  form: string;
  accessionNo: string;
  /** The point-in-time key (STOR-06). */
  filedAt: string;
  /** Frequently absent; `null` is never inferred. */
  frame: string | null;
  /** `numeric(28,6)` as canonical decimal text. */
  value: string;
  /** Derived, not published. */
  durationClass: XbrlDurationClass;
  /**
   * `true` when an earlier-filed fact for the same `(taxonomy, concept, unit, start, end)` carried
   * a different value. A restatement is a **new row**, never an update (§7.3).
   */
  restatement: boolean;
}

export interface SecCompanyFactsRows {
  cik: string;
  entityName: string | null;
  facts: XbrlFactRow[];
  /** `us-gaap` concept count — 503 in the 2026-09-15 AAPL capture. */
  conceptCount: number;
  /** Facts skipped because their unit is not one we model, by unit. */
  droppedUnits: Record<string, number>;
  /** `filed` range across the kept facts. */
  filedFrom: string | null;
  filedTo: string | null;
}

const EMPTY_COMPANY_FACTS: SecCompanyFactsRows = {
  cik: '',
  entityName: null,
  facts: [],
  conceptCount: 0,
  droppedUnits: {},
  filedFrom: null,
  filedTo: null,
};

/**
 * `companyfacts/CIK##########.json` → `xbrl_facts` (§7.3).
 *
 * The shape is `facts.<taxonomy>.<concept>.units.<unit>[]`. Iteration follows **document order** —
 * `JSON.parse` preserves the insertion order of non-numeric keys — which is what makes "the first
 * in document order is kept" a well-defined rule for duplicate suppression, and what makes this
 * function's output byte-identical on any engine for a fixed capture.
 */
export function normaliseCompanyFacts(
  raw: RawRecord,
  _ctx: NormaliseContext,
): Normalised<SecCompanyFactsRows> {
  const body = jsonObject(raw);
  if (!body.ok) return failed(EMPTY_COMPANY_FACTS, `sec.companyfacts: ${body.detail}`);
  const payload = body.value;

  const cik = cikOf(payload.cik);
  if (cik === null) return failed(EMPTY_COMPANY_FACTS, 'sec.companyfacts: payload has no cik');
  const factsNode = payload.facts;
  if (!isRecord(factsNode)) {
    return failed({ ...EMPTY_COMPANY_FACTS, cik }, 'sec.companyfacts: payload has no facts object');
  }

  const problems: NormaliseProblem[] = [];
  const facts: XbrlFactRow[] = [];
  const droppedUnits: Record<string, number> = {};
  const seen = new Map<string, string>();
  let conceptCount = 0;

  for (const taxonomy of Object.keys(factsNode)) {
    if (!INGESTED_TAXONOMIES.includes(taxonomy)) {
      problems.push(
        problem('field_dropped', `taxonomy '${taxonomy}' is not ingested`, `/facts/${taxonomy}`),
      );
      continue;
    }
    const concepts = factsNode[taxonomy];
    if (!isRecord(concepts)) {
      problems.push(
        problem('schema_drift', `facts.${taxonomy} is not an object`, `/facts/${taxonomy}`),
      );
      continue;
    }

    for (const concept of Object.keys(concepts)) {
      if (taxonomy === 'us-gaap') conceptCount += 1;
      const conceptNode = concepts[concept];
      const units = isRecord(conceptNode) ? conceptNode.units : undefined;
      if (!isRecord(units)) {
        problems.push(
          problem(
            'schema_drift',
            `${taxonomy}/${concept} has no units object`,
            `/facts/${taxonomy}/${concept}`,
          ),
        );
        continue;
      }

      for (const unit of Object.keys(units)) {
        const entries = units[unit];
        if (!Array.isArray(entries)) {
          problems.push(
            problem(
              'schema_drift',
              `${taxonomy}/${concept}/${unit} is not an array`,
              `/facts/${taxonomy}/${concept}/units/${unit}`,
            ),
          );
          continue;
        }
        if (!MODELLED_XBRL_UNITS.includes(unit)) {
          droppedUnits[unit] = (droppedUnits[unit] ?? 0) + entries.length;
          problems.push(
            problem(
              'field_dropped',
              `unit '${unit}' is not modelled; ${String(entries.length)} ${taxonomy}/${concept} facts skipped`,
              `/facts/${taxonomy}/${concept}/units/${unit}`,
            ),
          );
          continue;
        }

        for (const [index, entry] of entries.entries()) {
          const at = `/facts/${taxonomy}/${concept}/units/${unit}/${String(index)}`;
          if (!isRecord(entry)) {
            problems.push(problem('schema_drift', 'fact is not an object', at));
            continue;
          }
          const periodEnd = isoDate(entry.end);
          const filedAt = isoDate(entry.filed);
          const accession = accessionNo(entry.accn);
          const form = stringOrNull(entry.form);
          if (periodEnd === null || filedAt === null || accession === null || form === null) {
            problems.push(problem('parse_error', 'fact is missing end, filed, accn or form', at));
            continue;
          }
          const value = entry.val;
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            problems.push(problem('parse_error', `val ${show(value)} is not a finite number`, at));
            continue;
          }
          if (Math.abs(value) > XBRL_VALUE_LIMIT) {
            problems.push(problem('out_of_range', `val ${show(value)} is outside ±1e15`, at));
            continue;
          }
          const text = decimalText(value, 6);
          if (text === null) {
            problems.push(
              problem('out_of_range', `val ${show(value)} has no numeric(28,6) form`, at),
            );
            continue;
          }

          const periodStart = entry.start === undefined ? null : isoDate(entry.start);
          if (entry.start !== undefined && periodStart === null) {
            problems.push(problem('parse_error', `start '${show(entry.start)}' is not a date`, at));
            continue;
          }

          // Duplicate suppression, on the natural key `xbrl_facts_natural_uniq` enforces — which
          // does not include `val`, so two different values under one accession are a conflict the
          // database would reject, not a duplicate to swallow silently.
          const key = `${taxonomy}|${concept}|${unit}|${periodStart ?? ''}|${periodEnd}|${accession}`;
          const previous = seen.get(key);
          if (previous !== undefined) {
            if (previous !== text) {
              problems.push(
                problem(
                  'schema_drift',
                  `${concept} ${unit} ${periodStart ?? 'instant'}→${periodEnd} is tagged twice in ` +
                    `${accession} with different values (${previous} then ${text}); the first is kept`,
                  at,
                ),
              );
            }
            continue;
          }
          seen.set(key, text);

          const fy = typeof entry.fy === 'number' && Number.isFinite(entry.fy) ? entry.fy : null;
          facts.push({
            cik,
            taxonomy,
            concept,
            unit,
            periodStart,
            periodEnd,
            fy,
            fp: stringOrNull(entry.fp),
            form,
            accessionNo: accession,
            filedAt,
            frame: stringOrNull(entry.frame),
            value: text,
            durationClass: durationClass(dayDiff(periodStart, periodEnd)),
            restatement: false,
          });
        }
      }
    }
  }

  // Restatement detection — a second pass, because it is a property of a *group* of facts: the
  // same (taxonomy, concept, unit, period) filed later with a different value. Order within a
  // group is by `filed` then accession, so the flag does not depend on document order.
  const groups = new Map<string, XbrlFactRow[]>();
  for (const fact of facts) {
    const key = `${fact.taxonomy}|${fact.concept}|${fact.unit}|${fact.periodStart ?? ''}|${fact.periodEnd}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [fact]);
    else bucket.push(fact);
  }
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const ordered = [...bucket].sort((a, b) =>
      a.filedAt < b.filedAt
        ? -1
        : a.filedAt > b.filedAt
          ? 1
          : a.accessionNo < b.accessionNo
            ? -1
            : a.accessionNo > b.accessionNo
              ? 1
              : 0,
    );
    let last = ordered[0]!.value;
    for (const fact of ordered.slice(1)) {
      if (fact.value !== last) {
        fact.restatement = true;
        last = fact.value;
      }
    }
  }

  let filedFrom: string | null = null;
  let filedTo: string | null = null;
  for (const fact of facts) {
    if (filedFrom === null || fact.filedAt < filedFrom) filedFrom = fact.filedAt;
    if (filedTo === null || fact.filedAt > filedTo) filedTo = fact.filedAt;
  }

  return {
    updates: [],
    rows: {
      cik,
      entityName: stringOrNull(payload.entityName),
      facts,
      conceptCount,
      droppedUnits,
      filedFrom,
      filedTo,
    },
    sourceTs: null,
    problems,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §7.3.1 — the standardisation map, named here so the chains are in one readable place
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `fin_statements`'s three statements. */
export type StatementKind = 'IS' | 'BS' | 'CF';

/** One rung of a fallback chain: the concept, its 1-based priority, and its sign. */
export interface ConceptMapping {
  concept: string;
  /** Lower wins. The builder takes the **first** concept that has a fact, per period per filing. */
  priority: number;
  /** `-1` flips a concept SEC tags as a positive outflow. */
  sign: 1 | -1;
}

export interface StandardItemMap {
  standardItem: string;
  statement: StatementKind;
  /** In priority order. */
  concepts: ConceptMapping[];
  /** The unit the item is read in, when it is not `USD`. */
  unit?: 'USD/shares' | 'shares';
}

/**
 * `mapping_version 'std-map/2026.09'` — the `xbrl_concept_map` seed of PROVIDERS §7.3.1.
 *
 * It lives here, beside the parser, because the fallback chains are the thing that decides what
 * "revenue" means and they are worth reading in one place; `seed/fundamentals.ts` (WP-15) loads
 * these rows and `ingest/jobs/secCompanyFacts.ts` builds `fin_statements` from them. Nothing in
 * this module uses it — a normaliser writes facts, not statements.
 *
 * Four rules the builder applies on top of this table, none of which the table can express:
 *
 *  - **first hit wins, per period, per filing.** It never averages, and it never falls through to
 *    a lower-priority concept taken from a *different* accession.
 *  - **two computed items.** `GROSS_PROFIT` falls back to `REVENUE − COGS` and `FCF` is always
 *    `CFO − |CAPEX|`; both are recorded in `fin_statements.as_reported` as
 *    `{"concept": "computed:REVENUE-COGS", …, "fact_id": null}`, so FA's "as reported" toggle can
 *    show that the issuer never tagged it.
 *  - **Q4 derivation.** A 10-K carries only the annual duration, so `Q4 = FY − (Q1 + Q2 + Q3)` and
 *    the row is written with `derived_q4 = true`.
 *  - **a standard item with no hit stays NULL**, reported through `PayloadMeta.unavailable` with
 *    reason `NO_SOURCE` — never `0`.
 */
export const XBRL_CONCEPT_MAP_VERSION = 'std-map/2026.09';

export const XBRL_CONCEPT_MAP: readonly StandardItemMap[] = [
  {
    standardItem: 'REVENUE',
    statement: 'IS',
    concepts: [
      { concept: 'RevenueFromContractWithCustomerExcludingAssessedTax', priority: 1, sign: 1 },
      { concept: 'Revenues', priority: 2, sign: 1 },
      { concept: 'SalesRevenueNet', priority: 3, sign: 1 },
      { concept: 'RevenueFromContractWithCustomerIncludingAssessedTax', priority: 4, sign: 1 },
    ],
  },
  {
    standardItem: 'COGS',
    statement: 'IS',
    concepts: [
      { concept: 'CostOfGoodsAndServicesSold', priority: 1, sign: 1 },
      { concept: 'CostOfRevenue', priority: 2, sign: 1 },
      { concept: 'CostOfGoodsSold', priority: 3, sign: 1 },
    ],
  },
  {
    standardItem: 'GROSS_PROFIT',
    statement: 'IS',
    concepts: [{ concept: 'GrossProfit', priority: 1, sign: 1 }],
  },
  {
    standardItem: 'RND',
    statement: 'IS',
    concepts: [{ concept: 'ResearchAndDevelopmentExpense', priority: 1, sign: 1 }],
  },
  {
    standardItem: 'OPEX',
    statement: 'IS',
    concepts: [
      { concept: 'OperatingExpenses', priority: 1, sign: 1 },
      { concept: 'CostsAndExpenses', priority: 2, sign: 1 },
    ],
  },
  {
    standardItem: 'OPER_INC',
    statement: 'IS',
    concepts: [{ concept: 'OperatingIncomeLoss', priority: 1, sign: 1 }],
  },
  {
    standardItem: 'INT_EXP',
    statement: 'IS',
    concepts: [
      { concept: 'InterestExpense', priority: 1, sign: 1 },
      { concept: 'InterestExpenseNonoperating', priority: 2, sign: 1 },
      // Tagged net of income, so the sign flips on this rung alone (§7.3.1).
      { concept: 'InterestIncomeExpenseNet', priority: 3, sign: -1 },
    ],
  },
  {
    standardItem: 'PRETAX_INC',
    statement: 'IS',
    concepts: [
      {
        concept:
          'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
        priority: 1,
        sign: 1,
      },
      {
        concept:
          'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
        priority: 2,
        sign: 1,
      },
    ],
  },
  {
    standardItem: 'TAX',
    statement: 'IS',
    concepts: [{ concept: 'IncomeTaxExpenseBenefit', priority: 1, sign: 1 }],
  },
  {
    standardItem: 'NET_INC',
    statement: 'IS',
    concepts: [
      { concept: 'NetIncomeLoss', priority: 1, sign: 1 },
      { concept: 'ProfitLoss', priority: 2, sign: 1 },
    ],
  },
  {
    standardItem: 'EPS_BASIC',
    statement: 'IS',
    unit: 'USD/shares',
    concepts: [{ concept: 'EarningsPerShareBasic', priority: 1, sign: 1 }],
  },
  {
    standardItem: 'EPS_DIL',
    statement: 'IS',
    unit: 'USD/shares',
    concepts: [{ concept: 'EarningsPerShareDiluted', priority: 1, sign: 1 }],
  },
  {
    standardItem: 'SHARES_DIL',
    statement: 'IS',
    unit: 'shares',
    concepts: [
      { concept: 'WeightedAverageNumberOfDilutedSharesOutstanding', priority: 1, sign: 1 },
    ],
  },
  {
    standardItem: 'TOT_ASSETS',
    statement: 'BS',
    concepts: [{ concept: 'Assets', priority: 1, sign: 1 }],
  },
  {
    standardItem: 'TOT_LIAB',
    statement: 'BS',
    concepts: [{ concept: 'Liabilities', priority: 1, sign: 1 }],
  },
  {
    standardItem: 'EQUITY',
    statement: 'BS',
    concepts: [
      { concept: 'StockholdersEquity', priority: 1, sign: 1 },
      {
        concept: 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
        priority: 2,
        sign: 1,
      },
    ],
  },
  {
    standardItem: 'CASH',
    statement: 'BS',
    concepts: [
      { concept: 'CashAndCashEquivalentsAtCarryingValue', priority: 1, sign: 1 },
      {
        concept: 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
        priority: 2,
        sign: 1,
      },
    ],
  },
  {
    standardItem: 'LT_DEBT',
    statement: 'BS',
    concepts: [
      { concept: 'LongTermDebtNoncurrent', priority: 1, sign: 1 },
      { concept: 'LongTermDebt', priority: 2, sign: 1 },
    ],
  },
  {
    standardItem: 'CFO',
    statement: 'CF',
    concepts: [
      { concept: 'NetCashProvidedByUsedInOperatingActivities', priority: 1, sign: 1 },
      {
        concept: 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
        priority: 2,
        sign: 1,
      },
    ],
  },
  {
    standardItem: 'CAPEX',
    statement: 'CF',
    concepts: [{ concept: 'PaymentsToAcquirePropertyPlantAndEquipment', priority: 1, sign: -1 }],
  },
  {
    standardItem: 'DIV_PAID',
    statement: 'CF',
    concepts: [
      { concept: 'PaymentsOfDividendsCommonStock', priority: 1, sign: -1 },
      { concept: 'PaymentsOfDividends', priority: 2, sign: -1 },
    ],
  },
  {
    standardItem: 'BUYBACK',
    statement: 'CF',
    concepts: [{ concept: 'PaymentsForRepurchaseOfCommonStock', priority: 1, sign: -1 }],
  },
  {
    standardItem: 'DDA',
    statement: 'CF',
    concepts: [
      { concept: 'DepreciationDepletionAndAmortization', priority: 1, sign: 1 },
      { concept: 'DepreciationAmortizationAndAccretionNet', priority: 2, sign: 1 },
    ],
  },
  {
    standardItem: 'DPS',
    statement: 'CF',
    unit: 'USD/shares',
    concepts: [{ concept: 'CommonStockDividendsPerShareDeclared', priority: 1, sign: 1 }],
  },
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.4 — sec.frames
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** One `xbrl_frames` row. `filed_at` is `null`: a frame carries no filed date, ever (§7.4). */
export interface XbrlFrameRow {
  taxonomy: string;
  concept: string;
  unit: string;
  frame: string;
  cik: string;
  accessionNo: string;
  periodEnd: string;
  value: string;
  /** Dropped from the row, kept here for the `issuers.name` cross-check (§7.4). */
  entityName: string | null;
}

export interface SecFramesRows {
  taxonomy: string;
  concept: string;
  unit: string;
  frame: string;
  /** The payload's own count; asserted equal to `frames.length` before anything is emitted. */
  pts: number;
  frames: XbrlFrameRow[];
  periodEndFrom: string | null;
  periodEndTo: string | null;
}

const EMPTY_FRAMES: SecFramesRows = {
  taxonomy: '',
  concept: '',
  unit: '',
  frame: '',
  pts: 0,
  frames: [],
  periodEndFrom: null,
  periodEndTo: null,
};

/**
 * `frames/us-gaap/{concept}/{unit}/CY{…}.json` → `xbrl_frames` (§7.4).
 *
 * `pts` is asserted equal to `data.length`; a mismatch is `schema_drift` and the payload is dropped
 * whole, because a frame that is missing rows silently rewrites every EQS percentile rank.
 */
export function normaliseFrames(raw: RawRecord, _ctx: NormaliseContext): Normalised<SecFramesRows> {
  const body = jsonObject(raw);
  if (!body.ok) return failed(EMPTY_FRAMES, `sec.frames: ${body.detail}`);
  const payload = body.value;

  const taxonomy = stringOrNull(payload.taxonomy);
  const concept = stringOrNull(payload.tag);
  const unit = stringOrNull(payload.uom);
  const frame = stringOrNull(payload.ccp);
  const data = payload.data;
  if (
    taxonomy === null ||
    concept === null ||
    unit === null ||
    frame === null ||
    !Array.isArray(data)
  ) {
    return failed(EMPTY_FRAMES, 'sec.frames: payload has no taxonomy/tag/uom/ccp/data');
  }

  const pts = typeof payload.pts === 'number' ? payload.pts : -1;
  const header = { taxonomy, concept, unit, frame, pts };
  if (pts !== data.length) {
    return failed(
      { ...EMPTY_FRAMES, ...header, pts },
      `sec.frames: pts ${String(pts)} disagrees with data.length ${String(data.length)} — ` +
        'the payload is dropped, because a short frame rewrites every percentile rank',
      'schema_drift',
    );
  }

  const problems: NormaliseProblem[] = [];
  const frames: XbrlFrameRow[] = [];
  let periodEndFrom: string | null = null;
  let periodEndTo: string | null = null;

  for (const [index, entry] of data.entries()) {
    const at = `/data/${String(index)}`;
    if (!isRecord(entry)) {
      problems.push(problem('schema_drift', 'frame point is not an object', at));
      continue;
    }
    const cik = cikOf(entry.cik);
    const accession = accessionNo(entry.accn);
    const periodEnd = isoDate(entry.end);
    if (cik === null || accession === null || periodEnd === null) {
      problems.push(problem('parse_error', 'frame point is missing cik, accn or end', at));
      continue;
    }
    const value = decimalText(entry.val, 6);
    if (value === null) {
      problems.push(problem('parse_error', `val ${show(entry.val)} is not a numeric(28,6)`, at));
      continue;
    }
    frames.push({
      taxonomy,
      concept,
      unit,
      frame,
      cik,
      accessionNo: accession,
      periodEnd,
      value,
      entityName: stringOrNull(entry.entityName),
    });
    if (periodEndFrom === null || periodEnd < periodEndFrom) periodEndFrom = periodEnd;
    if (periodEndTo === null || periodEnd > periodEndTo) periodEndTo = periodEnd;
  }

  return {
    updates: [],
    rows: { ...header, frames, periodEndFrom, periodEndTo },
    sourceTs: null,
    problems,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.5 — sec.atom (the 8-K current-filings feed)
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** `"8-K - Aerkomm Inc. (0001590496) (Filer)"` — the identity line, §7.5 trap 3. */
const ATOM_TITLE =
  /^(?<form>\S+) - (?<name>.+) \((?<cik>\d{10})\) \((?<role>Filer|Reporting|Subject|Issuer)\)$/;

const SUMMARY_FILED = /Filed:<\/b>\s*(\d{4}-\d{2}-\d{2})/;
const SUMMARY_ACCNO = /AccNo:<\/b>\s*(\d{10}-\d{2}-\d{6})/;
const SUMMARY_SIZE = /Size:<\/b>\s*([\d.]+)\s*(KB|MB)/;
const SUMMARY_ITEM = /^Item\s+(\d+\.\d+):\s*([\s\S]*)$/;

/** One `news_items` row built from an atom entry. */
export interface AtomNewsRow {
  sourceId: 'sec.atom';
  feed: '8-K';
  /** `urn:tag:sec.gov,2008:accession-number=…` — the dedupe key with `source_id`. */
  providerGuid: string;
  kind: 'filing';
  headline: string;
  summary: string | null;
  url: string;
  category: string;
  cik: string;
  items8k: string[];
  /** FEED-05 `src`, canonical UTC — the entry's `<updated>`, the one SEC stamp with an offset. */
  publishedAt: string;
  isCorrection: boolean;
  machineGenerated: false;
  lang: 'en';
}

export interface SecAtomRows {
  /** The feed-level `<updated>`. */
  feedUpdated: string | null;
  newsItems: AtomNewsRow[];
  /** One `filings` row per entry — the atom usually beats the hourly submissions poll (§7.5). */
  filings: FilingRow[];
  /** Entries in the document, including ones that were dropped. */
  entryCount: number;
}

const EMPTY_ATOM: SecAtomRows = { feedUpdated: null, newsItems: [], filings: [], entryCount: 0 };

function sizeToBytes(amount: string, unit: string): number | null {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) return null;
  const factor = unit === 'MB' ? 1024 * 1024 : 1024;
  return Math.round(value * factor);
}

/**
 * The 8-K current-filings atom feed → `news_items` + `filings` (§7.5).
 *
 * Four traps, all of them in the recorded bytes:
 *
 *  1. **the declared encoding is `ISO-8859-1`** — `parseXmlBuffer` reads the declaration and
 *     decodes with `latin1`, because decoding those bytes as UTF-8 mangles accented issuer names
 *     into replacement characters that then fail the exact-name match in §11.3;
 *  2. **`<summary type="html">` is escaped HTML inside the XML** — the XML parser's own entity
 *     decoding is the *one* decode it gets; a second pass would eat a literal `&amp;` in a name;
 *  3. **`<title>` carries the identity** and a title that does not match is a `parse_error` and the
 *     entry is skipped, never guessed at;
 *  4. **`<updated>` carries an offset**, unlike every other SEC timestamp — and it is the
 *     acceptance instant, so it feeds both `news_items.published_at` and `filings.accepted_at`.
 */
export function normaliseAtom(raw: RawRecord, _ctx: NormaliseContext): Normalised<SecAtomRows> {
  if (!Buffer.isBuffer(raw.body) || raw.body.length === 0) {
    return failed(EMPTY_ATOM, 'sec.atom: body is empty or not a Buffer');
  }
  // §7.5: SEC's rate-limit page is HTML with a 200. It must trip the breaker, not parse to zero.
  const head = raw.body.subarray(0, 256).toString('latin1').trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    return failed(
      EMPTY_ATOM,
      'sec.atom: the response is HTML, not an atom feed (SEC rate-limit page)',
    );
  }

  const document = parseXmlBuffer(raw.body);
  if (!document.ok) return failed(EMPTY_ATOM, `sec.atom: ${document.problem.detail}`);

  const problems: NormaliseProblem[] = [...document.problems];
  const feed = document.root;
  if (feed.local !== 'feed') {
    return failed(
      EMPTY_ATOM,
      `sec.atom: root element is <${feed.name}>, not <feed>`,
      'schema_drift',
    );
  }

  const feedUpdated = isoInstant(childText(feed, 'updated'));
  const entries = childrenNamed(feed, 'entry');
  const newsItems: AtomNewsRow[] = [];
  const filings: FilingRow[] = [];

  for (const [index, entry] of entries.entries()) {
    const at = `/feed/entry/${String(index)}`;
    const title = childText(entry, 'title');
    const matched = ATOM_TITLE.exec(title);
    if (matched?.groups === undefined) {
      problems.push(
        problem('parse_error', `entry title '${title}' does not match the identity pattern`, at),
      );
      continue;
    }
    const form = matched.groups.form!;
    const issuerName = matched.groups.name!;
    const cik = matched.groups.cik!;

    const summaryText = childText(entry, 'summary');
    const filedDate = isoDate(SUMMARY_FILED.exec(summaryText)?.[1] ?? '');
    const accession = accessionNo(SUMMARY_ACCNO.exec(summaryText)?.[1] ?? '');
    if (filedDate === null || accession === null) {
      problems.push(
        problem('parse_error', `entry summary carries no Filed:/AccNo: pair (${title})`, at),
      );
      continue;
    }

    const sizeMatch = SUMMARY_SIZE.exec(summaryText);
    const sizeBytes = sizeMatch === null ? null : sizeToBytes(sizeMatch[1]!, sizeMatch[2]!);

    // Item codes and their descriptions: the summary's `<br>`-separated tail.
    const items: string[] = [];
    const descriptions: string[] = [];
    for (const chunk of summaryText.split(/<br\s*\/?>/i)) {
      const item = SUMMARY_ITEM.exec(chunk.trim());
      if (item === null) continue;
      items.push(item[1]!);
      const description = item[2]!.trim();
      if (description !== '') descriptions.push(description);
    }

    const link =
      childrenNamed(entry, 'link').find((node) => attrOf(node, 'rel') === 'alternate') ??
      child(entry, 'link');
    const url = link === null ? null : stringOrNull(attrOf(link, 'href'));
    if (url === null) {
      problems.push(problem('parse_error', `entry has no alternate link (${title})`, at));
      continue;
    }

    const guid = stringOrNull(childText(entry, 'id'));
    if (guid === null) {
      problems.push(problem('parse_error', `entry has no <id> (${title})`, at));
      continue;
    }

    const publishedAt = isoInstant(childText(entry, 'updated'));
    if (publishedAt === null) {
      problems.push(problem('parse_error', `entry <updated> is not an instant (${title})`, at));
      continue;
    }

    const category = child(entry, 'category');
    const term = category === null ? null : stringOrNull(attrOf(category, 'term'));
    if (term !== null && term !== form) {
      problems.push(
        problem(
          'schema_drift',
          `<category term='${term}'> disagrees with the title's form '${form}'`,
          at,
        ),
      );
    }

    newsItems.push({
      sourceId: 'sec.atom',
      feed: '8-K',
      providerGuid: guid,
      kind: 'filing',
      headline:
        descriptions.length === 0
          ? `${form}: ${issuerName}`
          : `${form}: ${issuerName} — ${descriptions[0]!}`,
      summary: descriptions.length === 0 ? null : descriptions.join(' '),
      url,
      category: form,
      cik,
      items8k: items,
      publishedAt,
      isCorrection: form.endsWith('/A'),
      machineGenerated: false,
      lang: 'en',
    });

    filings.push({
      accessionNo: accession,
      cik,
      form,
      filedDate,
      // `<updated>` IS EDGAR's acceptance instant for the submission — it is the only SEC stamp
      // published with an offset (`-04:00`), which is why it can be read as one. Writing it here
      // gives §7.3.2's point-in-time tie-break a value from the moment the atom entry lands; the
      // hourly `sec.submissions` upsert later overwrites it with `acceptanceDateTime`, which the
      // accession key makes the same submission. Leaving it null would let the coarse `filed_date`
      // filter silently govern every filing first seen through this feed.
      acceptedAt: publishedAt,
      reportDate: null,
      items,
      primaryDoc: null,
      primaryDocDesc: null,
      isXbrl: false,
      isInlineXbrl: false,
      sizeBytes,
      url,
    });
  }

  return {
    updates: [],
    rows: { feedUpdated, newsItems, filings, entryCount: entries.length },
    sourceTs: feedUpdated === null ? null : new Date(feedUpdated),
    problems,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7.6 — sec.archives (N-PORT)
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The `<cusip>` an N-PORT filer writes when it has none — 29 holdings in the capture. */
export const PLACEHOLDER_CUSIP = '000000000';

export interface NportHeader {
  submissionType: string;
  regName: string | null;
  regCik: string | null;
  regLei: string | null;
  seriesName: string | null;
  seriesLei: string | null;
  /** The portfolio date — `index_members.as_of_date`, **not** the filing date. */
  repPdDate: string | null;
  /** The reporting period end; `dq_events.details` only. */
  repPdEnd: string | null;
  totAssets: string | null;
  totLiabs: string | null;
  netAssets: string | null;
}

/** One `etf_holdings` row from an `<invstOrSec>` block. */
export interface NportHolding {
  lineNo: number;
  name: string;
  lei: string | null;
  /** `null` when the filer published the all-zero placeholder (see {@link PLACEHOLDER_CUSIP}). */
  cusip: string | null;
  /** From `identifiers/isin/@value` — an **attribute**, not text. */
  isin: string | null;
  /** `balance`, but only when `units === 'NS'`; a `PA` row is debt and never a member. */
  shares: string | null;
  units: string | null;
  curCd: string | null;
  marketValue: string | null;
  /** `pctVal / 100` — the payload is a percent, `index_members.weight` is a fraction. */
  weight: string | null;
  /** The published percent, kept for the Σ check. */
  pctVal: string | null;
  payoffProfile: string | null;
  assetCat: string | null;
  issuerCat: string | null;
  country: string | null;
  /** `EC` + `Long` + `NS` + `USD`: the four conditions for an `index_members` row. */
  indexEligible: boolean;
}

export interface SecNportRows {
  header: NportHeader;
  holdings: NportHolding[];
  holdingCount: number;
  /** Holdings that carried a direct `<cusip>` child — asserted equal to `holdingCount`. */
  cusipCount: number;
  placeholderCusipCount: number;
  eligibleCount: number;
  /** Σ pctVal across every holding, exactly. §7.6 wants 99.0-100.5. */
  pctValSum: string;
  /** Σ valUSD across every holding, exactly. */
  valUsdSum: string;
  /** `true` when the count is outside 495-515 and the caller must write nothing. */
  outsideCountBand: boolean;
}

const EMPTY_NPORT: SecNportRows = {
  header: {
    submissionType: '',
    regName: null,
    regCik: null,
    regLei: null,
    seriesName: null,
    seriesLei: null,
    repPdDate: null,
    repPdEnd: null,
    totAssets: null,
    totLiabs: null,
    netAssets: null,
  },
  holdings: [],
  holdingCount: 0,
  cusipCount: 0,
  placeholderCusipCount: 0,
  eligibleCount: 0,
  pctValSum: '0.000000000000',
  valUsdSum: '0.00',
  outsideCountBand: true,
};

/**
 * SPY's N-PORT primary document → `etf_holdings` + the `index_members` candidates (§7.6).
 *
 * **The 505th `isin`.** The document holds 504 `<invstOrSec>` blocks and 504 `<cusip>` tags but
 * 505 `<isin>` tags: one holding's `<derivativeInfo>` nests the *reference* instrument's `<isin>`
 * (it carries no `<cusip>` of its own, which is why only the isin count is inflated). A
 * document-wide `getElementsByTagName('isin')` therefore yields one value too many and shifts
 * every holding's identifier from that point on — a silent, total corruption of the index. This
 * function reads **named direct children** of each holding (and of that holding's own
 * `<identifiers>` element) and nothing else, and asserts both `cusipCount === holdingCount` and
 * `isinCount === holdingCount` inside the scoped traversal before it returns a single row: the
 * isin count is the one the trap actually threatens, and the cusip count is what proves the
 * traversal stayed scoped for the identifier that does not repeat.
 */
export function normaliseNport(raw: RawRecord, _ctx: NormaliseContext): Normalised<SecNportRows> {
  if (!Buffer.isBuffer(raw.body) || raw.body.length === 0) {
    return failed(EMPTY_NPORT, 'sec.archives: body is empty or not a Buffer');
  }
  const head = raw.body.subarray(0, 256).toString('latin1').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    return failed(
      EMPTY_NPORT,
      'sec.archives: the response is HTML — the `xsl…/` viewer path was fetched instead of the document (§7.2)',
    );
  }

  const document = parseXmlBuffer(raw.body);
  if (!document.ok) return failed(EMPTY_NPORT, `sec.archives: ${document.problem.detail}`);

  const problems: NormaliseProblem[] = [...document.problems];
  const root = document.root;

  const headerData = child(root, 'headerData');
  const submissionType = headerData === null ? '' : childText(headerData, 'submissionType');
  if (submissionType !== 'NPORT-P') {
    return failed(
      { ...EMPTY_NPORT, header: { ...EMPTY_NPORT.header, submissionType } },
      `sec.archives: submissionType is '${submissionType}', not 'NPORT-P'`,
      'schema_drift',
    );
  }

  const formData = child(root, 'formData');
  if (formData === null) return failed(EMPTY_NPORT, 'sec.archives: no <formData>', 'schema_drift');
  const genInfo = child(formData, 'genInfo');
  const fundInfo = child(formData, 'fundInfo');

  const header: NportHeader = {
    submissionType,
    regName: genInfo === null ? null : stringOrNull(childText(genInfo, 'regName')),
    regCik: genInfo === null ? null : cikOf(childText(genInfo, 'regCik')),
    regLei: genInfo === null ? null : stringOrNull(childText(genInfo, 'regLei')),
    seriesName: genInfo === null ? null : stringOrNull(childText(genInfo, 'seriesName')),
    seriesLei: genInfo === null ? null : stringOrNull(childText(genInfo, 'seriesLei')),
    repPdDate: genInfo === null ? null : isoDate(childText(genInfo, 'repPdDate')),
    repPdEnd: genInfo === null ? null : isoDate(childText(genInfo, 'repPdEnd')),
    totAssets: fundInfo === null ? null : numericText(childText(fundInfo, 'totAssets'), 2),
    totLiabs: fundInfo === null ? null : numericText(childText(fundInfo, 'totLiabs'), 2),
    netAssets: fundInfo === null ? null : numericText(childText(fundInfo, 'netAssets'), 2),
  };
  if (header.repPdDate === null) {
    problems.push(
      problem(
        'schema_drift',
        'genInfo/repPdDate is missing or not a date',
        '/formData/genInfo/repPdDate',
      ),
    );
  }

  // §7.6 writes the path as `formData/fundInfo/invstOrSecs/invstOrSec`. In the recorded capture
  // `invstOrSecs` is a **sibling** of `fundInfo` under `formData`; both spellings are accepted, and
  // only the container's own direct `invstOrSec` children are read.
  const container =
    (fundInfo === null ? null : child(fundInfo, 'invstOrSecs')) ?? child(formData, 'invstOrSecs');
  if (container === null) {
    return failed(
      { ...EMPTY_NPORT, header },
      'sec.archives: no <invstOrSecs> container under fundInfo or formData',
      'schema_drift',
    );
  }

  const blocks = childrenNamed(container, 'invstOrSec');
  const holdings: NportHolding[] = [];
  const pctVals: (string | null)[] = [];
  const valUsds: (string | null)[] = [];
  let cusipCount = 0;
  let isinCount = 0;
  let placeholderCusipCount = 0;
  let eligibleCount = 0;

  for (const [index, block] of blocks.entries()) {
    const at = `/formData/fundInfo/invstOrSecs/invstOrSec/${String(index)}`;
    const name = stringOrNull(childText(block, 'name'));
    if (name === null) {
      problems.push(problem('parse_error', 'holding has no <name>', at));
      continue;
    }

    const cusipNode = child(block, 'cusip');
    if (cusipNode !== null) cusipCount += 1;
    const publishedCusip = cusipNode === null ? null : stringOrNull(textOf(cusipNode));
    const isPlaceholder = publishedCusip !== null && /^0+$/.test(publishedCusip);
    if (isPlaceholder) placeholderCusipCount += 1;

    // Scoped: this holding's OWN <identifiers> element, never a document-wide scan.
    const identifiers = child(block, 'identifiers');
    const isinNode = identifiers === null ? null : child(identifiers, 'isin');
    if (isinNode !== null) isinCount += 1;
    const isin =
      isinNode === null ? null : stringOrNull(attrOf(isinNode, 'value') ?? textOf(isinNode));

    const units = stringOrNull(childText(block, 'units'));
    const balance = numericText(childText(block, 'balance'), 4);
    const curCd = stringOrNull(childText(block, 'curCd'));
    const pctVal = numericText(childText(block, 'pctVal'), 12);
    const valUsd = numericText(childText(block, 'valUSD'), 2);
    const payoffProfile = stringOrNull(childText(block, 'payoffProfile'));
    const assetCat = stringOrNull(childText(block, 'assetCat'));

    const eligible =
      assetCat === 'EC' && payoffProfile === 'Long' && units === 'NS' && curCd === 'USD';
    if (eligible) eligibleCount += 1;
    if (eligible && curCd !== 'USD') {
      problems.push(
        problem('out_of_range', `holding '${name}' is EC but priced in ${String(curCd)}`, at),
      );
    }

    pctVals.push(pctVal);
    valUsds.push(valUsd);

    holdings.push({
      lineNo: holdings.length + 1,
      name,
      lei: stringOrNull(childText(block, 'lei')),
      cusip: isPlaceholder ? null : publishedCusip,
      isin,
      shares: units === 'NS' ? balance : null,
      units,
      curCd,
      marketValue: valUsd,
      weight: percentToFraction(pctVal, 2),
      pctVal,
      payoffProfile,
      assetCat,
      issuerCat: stringOrNull(childText(block, 'issuerCat')),
      country: stringOrNull(childText(block, 'invCountry')),
      indexEligible: eligible,
    });
  }

  if (cusipCount !== holdings.length) {
    return failed(
      { ...EMPTY_NPORT, header },
      `sec.archives: the scoped traversal saw ${String(cusipCount)} <cusip> children against ` +
        `${String(holdings.length)} holdings — a document-wide tag scan has leaked in and every ` +
        'identifier after the first derivative would be shifted by one (§7.6)',
      'schema_drift',
    );
  }

  if (isinCount !== holdings.length) {
    return failed(
      { ...EMPTY_NPORT, header },
      `sec.archives: the scoped traversal saw ${String(isinCount)} <identifiers>/<isin> children ` +
        `against ${String(holdings.length)} holdings — the document carries one more <isin> than ` +
        'it has holdings (the reference instrument inside <derivativeInfo>), so a count that is ' +
        'not exactly the holding count means a document-wide tag scan has leaked in (§7.6)',
      'schema_drift',
    );
  }

  const holdingCount = holdings.length;
  return {
    updates: [],
    rows: {
      header,
      holdings,
      holdingCount,
      cusipCount,
      placeholderCusipCount,
      eligibleCount,
      pctValSum: sumDecimal(pctVals, 12),
      valUsdSum: sumDecimal(valUsds, 2),
      outsideCountBand: holdingCount < NPORT_MIN_HOLDINGS || holdingCount > NPORT_MAX_HOLDINGS,
    },
    sourceTs: null,
    problems,
  };
}
