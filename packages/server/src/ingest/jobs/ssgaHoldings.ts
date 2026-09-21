/**
 * `ingest/jobs/ssgaHoldings.ts` — the SPDR S&P 500 daily holdings file (PROVIDERS §8).
 *
 * N-PORT is the official publication and is structurally two months stale at filing; this file is
 * the issuer's own, published every business day. Both write `index_members` and `etf_holdings`,
 * distinguished by `source_id`, and §8.2 reconciles them **at the N-PORT `as_of_date`** — never at
 * today's date, because comparing a June 30 filing against a September 15 file measures nothing
 * but the passage of time.
 *
 * Three things here are load-bearing:
 *
 * **The placeholder screen, again.** `Identifier` is a CUSIP for US names; a blank or all-zero one
 * identifies nothing, is never written to `identifiers`, and never reaches a resolver. Resolution
 * is CUSIP → SEDOL → ticker → `normName`, and a row that still does not resolve gets its
 * `etf_holdings` row with `holding_instrument_id NULL` plus a `data_exceptions` row of kind
 * `'unresolved_identifier'` (WORKPLAN L740-753, shared with `secNport.ts`).
 *
 * **Cells are addressed by their `r` reference, never by counting siblings.** An `.xlsx` omits
 * empty cells from the XML entirely, so counting `<c>` elements is exactly how a blank SEDOL
 * shifts Weight into the Sector column. {@link readSheet} maps `"C7"` → column 3 and leaves the
 * gap empty.
 *
 * **Columns are found by header text.** The header row is the first whose first non-empty cell is
 * exactly `Name`; every other column is located by its published heading, so SSGA inserting a
 * column cannot silently re-map Weight.
 *
 * The xlsx reader is ~180 lines of `node:zlib` and string scanning. PROVIDERS §8.1 puts it at
 * `providers/ssga/xlsx.ts`, which is WP-05's file; it lives here, exported, until that lands.
 */

import { inflateRawSync } from 'node:zlib';

import { sql } from 'drizzle-orm';

import { insertProvenance } from '../../providers/provenance.js';
import {
  fetchRaw,
  latestAsOfDate,
  presentIdentifier,
  provenanceMeta,
  recordDqEvent,
  recordUnresolvedHolding,
  resolveHolding,
  upsertEtfHoldings,
  writeHoldingIdentifiers,
} from './secNport.js';
import { findIndexByCode, instantOfDate, recordSnapshot } from '../../refdata/indexMembership.js';

import type { Tx } from '../../db/client.js';
import type { AsOf } from '../../db/bitemporal.js';
import type { SnapshotMember, SnapshotResult } from '../../refdata/indexMembership.js';
import type { ProviderId } from '../../providers/types.js';
import type {
  EtfHoldingRow,
  HoldingKeys,
  JobResult,
  RefIngestContext,
  UpsertCounts,
} from './secNport.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// An `.xlsx` reader without a dependency (PROVIDERS §8.1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Raised for a file that is not a readable ZIP, or a member this reader will not decompress. */
export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

/** `PK\x05\x06` — End of Central Directory. */
const EOCD_SIGNATURE = 0x0605_4b50;
/** `PK\x01\x02` — one central-directory entry. */
const CENTRAL_SIGNATURE = 0x0201_4b50;
/** The EOCD is at most 22 bytes plus a 64 KiB comment. */
const EOCD_MAX_TAIL = 22 + 0xffff;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Walk the central directory. Scanning backwards for the EOCD (rather than assuming it sits at
 * `length - 22`) is what makes a file with a ZIP comment readable.
 */
export function readZipDirectory(buf: Buffer): Map<string, ZipEntry> {
  const from = Math.max(0, buf.length - EOCD_MAX_TAIL);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('no End of Central Directory record: not a ZIP archive');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new XlsxError(`central directory entry ${String(i)} is malformed`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * One member's bytes. Method `0` is a slice, method `8` is **raw** inflate — a ZIP member carries
 * no zlib header, so `inflateSync` would fail on it. Nothing else is accepted.
 */
export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const header = entry.localHeaderOffset;
  if (header + 30 > buf.length || buf.readUInt32LE(header) !== 0x0403_4b50) {
    throw new XlsxError(`local header for ${entry.name} is malformed`);
  }
  const nameLength = buf.readUInt16LE(header + 26);
  const extraLength = buf.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const body = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(body);
  if (entry.method === 8) return inflateRawSync(body);
  throw new XlsxError(
    `${entry.name} uses compression method ${String(entry.method)}; only stored (0) and deflate (8) are read`,
  );
}

/** `"C7"` → `{ column: 3, row: 7 }`; `"AA12"` → `{ column: 27, row: 12 }`. */
export function parseCellRef(ref: string): { column: number; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (m === null) return null;
  const letters = m[1]!;
  let column = 0;
  for (const ch of letters) column = column * 26 + (ch.charCodeAt(0) - 64);
  return { column, row: Number(m[2]) };
}

const XML_ENTITY = /&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g;
const XML_NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decode(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(XML_ENTITY, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return XML_NAMED[body] ?? match;
  });
}

/** `<si>` entries in order; rich text (`<r><t>…`) is concatenated into one string. */
export function readSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const body = si[1] ?? '';
    let text = '';
    for (const t of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += decode(t[1] ?? '');
    out.push(text);
  }
  return out;
}

/** One sheet as rows of cells, addressed by 1-based column index. Gaps stay absent. */
export type SheetRow = ReadonlyMap<number, string>;

/**
 * `<row r="n"><c r="A5" t="s"><v>12</v></c>…` → rows in **ascending `r`**, regardless of the order
 * the file happens to store them in. No locale, no `Date.parse`.
 */
export function readSheet(xml: string, sharedStrings: readonly string[]): Map<number, SheetRow> {
  const rows = new Map<number, Map<number, string>>();
  for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowRef = /\br="(\d+)"/.exec(row[1] ?? '');
    if (rowRef === null) continue;
    const rowNumber = Number(rowRef[1]);
    const cells = new Map<number, string>();

    for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? '';
      const inner = cell[2] ?? '';
      const refMatch = /\br="([A-Z]+\d+)"/.exec(attrs);
      if (refMatch === null) continue;
      const ref = parseCellRef(refMatch[1]!);
      if (ref === null) continue;

      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      let value: string | null = null;
      if (type === 'inlineStr') {
        let text = '';
        for (const t of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += decode(t[1] ?? '');
        value = text;
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (v !== null) {
          const literal = decode(v[1] ?? '');
          if (type === 's') {
            const index = Number(literal);
            value = sharedStrings[index] ?? '';
          } else {
            value = literal;
          }
        }
      }
      if (value !== null && value !== '') cells.set(ref.column, value);
    }
    rows.set(rowNumber, cells);
  }
  return new Map([...rows.entries()].sort((a, b) => a[0] - b[0]));
}

/** Sheet 1 of an `.xlsx`, ready to read by cell reference. */
export function readXlsxSheet1(buf: Buffer): Map<number, SheetRow> {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    // The SSGA CDN answers an unfamiliar agent with an HTML error page carrying status 200.
    throw new XlsxError(
      'response does not begin with "PK": the CDN served something other than a workbook',
    );
  }
  const directory = readZipDirectory(buf);
  const sheet = directory.get('xl/worksheets/sheet1.xml');
  if (sheet === undefined) throw new XlsxError('no xl/worksheets/sheet1.xml in the workbook');
  const shared = directory.get('xl/sharedStrings.xml');
  const sharedStrings =
    shared === undefined ? [] : readSharedStrings(readZipEntry(buf, shared).toString('utf8'));
  return readSheet(readZipEntry(buf, sheet).toString('utf8'), sharedStrings);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The SSGA holdings sheet
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SSGA_SOURCE_ID = 'ssga.holdings' satisfies ProviderId;
export const SSGA_ADAPTER_VERSION = 'ssga/1.0.0';

export const SSGA_SPY_URL =
  'https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx';

/** Month names as SSGA writes them. `Date.parse('Sep 15, 2026')` is engine-dependent and banned. */
const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * The header block's date, in either spelling the file has used: `14-Sep-2026` (the recorded
 * capture, under `Holdings:` as `As of 14-Sep-2026`) and `Sep 15, 2026`.
 *
 * @returns `YYYY-MM-DD`, or `null` when no date is recognisable — never a guess.
 */
export function parseSsgaDate(raw: string): string | null {
  const text = raw.trim().replace(/^as\s+of\s+/i, '');
  const dashed = /^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{4})$/.exec(text);
  if (dashed !== null) {
    const month = MONTHS[dashed[2]!.slice(0, 3).toLowerCase()];
    if (month !== undefined) return iso(Number(dashed[1]), month, Number(dashed[3]));
  }
  const spelled = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (spelled !== null) {
    const month = MONTHS[spelled[1]!.slice(0, 3).toLowerCase()];
    if (month !== undefined) return iso(Number(spelled[2]), month, Number(spelled[3]));
  }
  const isoLike = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (isoLike !== null) return text;
  return null;
}

function iso(day: number, month: number, year: number): string | null {
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** One line of the holdings table, exactly as published. */
export interface SsgaHolding {
  /** 1-based position in the table → `etf_holdings.line_no`. */
  lineNo: number;
  name: string;
  ticker: string | null;
  /** The `Identifier` column: a CUSIP for US names. */
  identifier: string | null;
  sedol: string | null;
  /** A **percent** (`7.4123`), as in N-PORT. */
  weight: string | null;
  /** The published sector *name*, never a GICS code. `'-'` means the file omits it. */
  sector: string | null;
  shares: string | null;
  currency: string | null;
}

export interface SsgaParse {
  fundName: string | null;
  fundTicker: string | null;
  /** `YYYY-MM-DD` — `index_members.as_of_date` and `etf_holdings.as_of_date`. */
  asOfDate: string | null;
  holdings: SsgaHolding[];
  problems: { kind: string; detail: string }[];
}

/** The eight published headings, lower-cased for matching. */
const HEADINGS = {
  name: 'name',
  ticker: 'ticker',
  identifier: 'identifier',
  sedol: 'sedol',
  weight: 'weight',
  sector: 'sector',
  shares: 'shares held',
  currency: 'local currency',
} as const;

function cell(row: SheetRow | undefined, column: number | undefined): string | null {
  if (row === undefined || column === undefined) return null;
  const value = row.get(column)?.trim();
  return value === undefined || value.length === 0 || value === '-' ? null : value;
}

/**
 * The workbook → the metadata block plus the holdings table.
 *
 * Pure. The table ends at the first row after the header that has no `Name`, **or** that has a
 * `Name` and nothing else: the file's footer is a disclaimer paragraph living in column A alone,
 * and "empty Name ends the table" alone would swallow it as a 506th holding.
 */
export function parseSsgaHoldings(sheet: Map<number, SheetRow>): SsgaParse {
  const problems: { kind: string; detail: string }[] = [];
  const rowNumbers = [...sheet.keys()].sort((a, b) => a - b);

  let fundName: string | null = null;
  let fundTicker: string | null = null;
  let asOfDate: string | null = null;
  let headerRow: number | null = null;

  for (const n of rowNumbers) {
    const row = sheet.get(n)!;
    const first = row.get(1)?.trim() ?? '';
    if (first === 'Name') {
      headerRow = n;
      break;
    }
    const label = first.replace(/:$/, '').toLowerCase();
    const value = row.get(2)?.trim() ?? '';
    if (label === 'fund name') fundName = value;
    else if (label === 'ticker symbol') fundTicker = value;
    else if (label === 'holdings' || label === 'holdings as of') {
      asOfDate = parseSsgaDate(value);
      if (asOfDate === null && value.length > 0) {
        problems.push({
          kind: 'parse_error',
          detail: `unrecognised holdings date ${JSON.stringify(value)}`,
        });
      }
    }
  }

  if (headerRow === null) {
    problems.push({
      kind: 'schema_drift',
      detail: 'no header row whose first cell is exactly "Name"',
    });
    return { fundName, fundTicker, asOfDate, holdings: [], problems };
  }

  // Columns by heading text, never by position.
  const columns = new Map<string, number>();
  for (const [column, value] of sheet.get(headerRow)!) {
    columns.set(value.trim().toLowerCase(), column);
  }
  for (const heading of Object.values(HEADINGS)) {
    if (!columns.has(heading)) {
      problems.push({ kind: 'schema_drift', detail: `no "${heading}" column in the header row` });
    }
  }

  const holdings: SsgaHolding[] = [];
  for (const n of rowNumbers) {
    if (n <= headerRow) continue;
    const row = sheet.get(n)!;
    const name = cell(row, columns.get(HEADINGS.name));
    if (name === null) break;
    const ticker = cell(row, columns.get(HEADINGS.ticker));
    const identifier = cell(row, columns.get(HEADINGS.identifier));
    const weight = cell(row, columns.get(HEADINGS.weight));
    // The footer is a paragraph in column A with nothing beside it.
    if (ticker === null && identifier === null && weight === null) break;

    holdings.push({
      lineNo: holdings.length + 1,
      name,
      ticker,
      identifier,
      sedol: cell(row, columns.get(HEADINGS.sedol)),
      weight,
      sector: cell(row, columns.get(HEADINGS.sector)),
      shares: cell(row, columns.get(HEADINGS.shares)),
      currency: cell(row, columns.get(HEADINGS.currency)),
    });
  }

  return { fundName, fundTicker, asOfDate, holdings, problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SSGA_MIN_ROWS = 495;
export const SSGA_MAX_ROWS = 515;
export const SSGA_MIN_WEIGHT_SUM = 99.0;
export const SSGA_MAX_WEIGHT_SUM = 100.5;

/** §8.2: per-name weight divergence above 5 bp, aggregate above 50 bp. */
export const RECONCILE_NAME_BP = 5;
export const RECONCILE_TOTAL_BP = 50;

export interface SsgaHoldingsRequest {
  url?: string;
  indexCode?: string;
  /** Re-apply a file whose date is not newer than the stored one — proves write idempotence. */
  force?: boolean;
  /** Skip §8.2's cross-source reconciliation (it is a read-only comparison either way). */
  reconcile?: boolean;
}

/** One §8.2 finding, returned so a caller can assert on it without re-reading `dq_events`. */
export interface ReconcileReport {
  /** The N-PORT `as_of_date` the two were compared at; `null` when there is no N-PORT slice. */
  asOfDate: string | null;
  onlyInNport: number;
  onlyInSsga: number;
  nameDivergences: number;
  /** `Σ |w_nport − w_ssga|`, in basis points. */
  totalDriftBp: number;
}

export interface SsgaHoldingsResult extends JobResult {
  status: 'ok' | 'skipped' | 'failed';
  provenanceId: number | null;
  asOfDate: string | null;
  holdings: number;
  /** Rows eligible for `index_members`: a resolved USD line. */
  indexEligible: number;
  distinctIdentifiers: number;
  placeholderIdentifiers: number;
  resolved: number;
  unresolved: number;
  identifiersWritten: number;
  etfHoldings: UpsertCounts;
  members: SnapshotResult;
  /**
   * **Every** `data_exceptions` row this run wrote: unresolved holdings, duplicate lines and the
   * `'source_conflict'` rows `writeHoldingIdentifiers` files when a holding's CUSIP or SEDOL
   * already points at another entity (REF-10).
   */
  exceptionsWritten: number;
  /** The `'source_conflict'` subset of {@link SsgaHoldingsResult.exceptionsWritten}. */
  conflictsWritten: number;
  dqEventsWritten: number;
  weightSum: number;
  reconcile: ReconcileReport | null;
}

function emptyResult(): SsgaHoldingsResult {
  return {
    fetched: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    provenanceIds: [],
    status: 'ok',
    provenanceId: null,
    asOfDate: null,
    holdings: 0,
    indexEligible: 0,
    distinctIdentifiers: 0,
    placeholderIdentifiers: 0,
    resolved: 0,
    unresolved: 0,
    identifiersWritten: 0,
    etfHoldings: { inserted: 0, updated: 0, unchanged: 0 },
    members: { written: 0, unchanged: 0, retired: 0 },
    exceptionsWritten: 0,
    conflictsWritten: 0,
    dqEventsWritten: 0,
    weightSum: 0,
    reconcile: null,
  };
}

function numericText(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return null;
  // The sheet writes large share counts in scientific notation (`2.95150616E8`); `numeric` accepts
  // that spelling verbatim, so it is passed through rather than round-tripped through a float.
  return trimmed;
}

/** `Weight` (a percent) → a fraction, at the sheet's own decimal precision. */
export function weightToFraction(weight: string | null): string | null {
  const text = numericText(weight);
  if (text === null) return null;
  if (text.includes('e') || text.includes('E')) return (Number(text) / 100).toFixed(10);
  const negative = text.startsWith('-');
  const body = text.replace(/^[+-]/, '');
  const dot = body.indexOf('.');
  const digits = dot < 0 ? body : body.slice(0, dot) + body.slice(dot + 1);
  const scale = dot < 0 ? 0 : body.length - dot - 1;
  const padded = digits.padStart(scale + 3, '0');
  const cut = padded.length - (scale + 2);
  const head = padded.slice(0, cut) === '' ? '0' : padded.slice(0, cut);
  return `${negative ? '-' : ''}${head}.${padded.slice(cut)}`;
}

/**
 * Run the job inside `ctx.tx`.
 *
 * `provenance.source_ts` is the file's own as-of date at 16:00 America/New_York — the close the
 * file describes — not the fetch time (PROVIDERS §8.1).
 */
export async function runSsgaHoldings(
  ctx: RefIngestContext,
  req: SsgaHoldingsRequest = {},
): Promise<SsgaHoldingsResult> {
  const result = emptyResult();
  const url = req.url ?? SSGA_SPY_URL;
  const indexCode = req.indexCode ?? 'SPX';

  const raw = await fetchRaw(ctx, {
    providerId: SSGA_SOURCE_ID,
    url,
    cacheTtlMs: 6 * 60 * 60 * 1000,
    timeoutMs: 60_000,
  });
  result.fetched = 1;

  const parse = parseSsgaHoldings(readXlsxSheet1(raw.body));
  result.asOfDate = parse.asOfDate;
  result.holdings = parse.holdings.length;
  result.weightSum = parse.holdings.reduce((sum, h) => sum + (Number(h.weight) || 0), 0);
  result.distinctIdentifiers = new Set(
    parse.holdings.map((h) => h.identifier).filter((v): v is string => v !== null),
  ).size;
  result.placeholderIdentifiers = parse.holdings.filter(
    (h) => presentIdentifier('CUSIP', h.identifier) === null,
  ).length;

  if (parse.asOfDate === null) {
    result.status = 'failed';
    result.errors.push({
      code: 'NO_AS_OF_DATE',
      message: 'the header block carries no readable "Holdings as of" date',
      url,
    });
    return result;
  }
  const asOfDate = parse.asOfDate;

  // ── validation: nothing is written when the file fails its own arithmetic ──────────────────
  const anomalies: { detail: string; details: Record<string, unknown> }[] = [];
  if (result.holdings < SSGA_MIN_ROWS || result.holdings > SSGA_MAX_ROWS) {
    anomalies.push({
      detail: 'row count outside 495-515',
      details: { actual: result.holdings, expectedMin: SSGA_MIN_ROWS, expectedMax: SSGA_MAX_ROWS },
    });
  }
  if (result.weightSum < SSGA_MIN_WEIGHT_SUM || result.weightSum > SSGA_MAX_WEIGHT_SUM) {
    anomalies.push({
      detail: 'sum of Weight outside 99.0-100.5',
      details: { actual: result.weightSum },
    });
  }
  if (anomalies.length > 0) {
    for (const anomaly of anomalies) {
      result.dqEventsWritten += await recordDqEvent(ctx.tx, {
        kind: 'poll_anomaly',
        severity: 'error',
        sourceId: SSGA_SOURCE_ID,
        subject: 'index_members',
        key: `${SSGA_SOURCE_ID}:${asOfDate}:${anomaly.detail}`,
        details: { ...anomaly.details, detail: anomaly.detail, url },
      });
    }
    result.status = 'skipped';
    result.skipped = result.holdings;
    result.errors.push({ code: 'POLL_ANOMALY', message: anomalies[0]!.detail, url });
    return result;
  }

  const index = await findIndexByCode(ctx.tx, indexCode);
  if (index === null) {
    result.status = 'failed';
    result.errors.push({
      code: 'INDEX_NOT_CONFIGURED',
      message: `no indices row for ${indexCode}; WP-15's seed owns it`,
      url,
    });
    return result;
  }
  const etfInstrumentId = index.proxyFundInstrumentId;
  if (etfInstrumentId === null) {
    result.status = 'failed';
    result.errors.push({
      code: 'PROXY_FUND_NOT_CONFIGURED',
      message: `indices.${indexCode}.proxy_fund_instrument_id is NULL`,
      url,
    });
    return result;
  }

  if (req.force !== true) {
    const stored = await latestAsOfDate(ctx.tx, index.indexId, SSGA_SOURCE_ID);
    if (stored !== null && stored >= asOfDate) {
      result.status = 'skipped';
      result.skipped = result.holdings;
      ctx.log?.info?.('ssgaHoldings.skipped', { asOfDate, stored, url });
      return result;
    }
  }

  const knownAt = new Date(raw.capturedAt);
  const validFrom = instantOfDate(asOfDate);
  const at: AsOf = { validAt: validFrom, knownAt };
  // The close the file describes: 16:00 America/New_York on its own as-of date. September is EDT
  // (UTC−4); the offset is read from the date rather than assumed, so this stays right in January.
  const sourceTs = new Date(`${asOfDate}T16:00:00${easternOffset(asOfDate)}`);

  const provenanceId = await insertProvenance(
    ctx.tx,
    raw,
    provenanceMeta(ctx, SSGA_ADAPTER_VERSION, sourceTs),
  );
  result.provenanceId = provenanceId;
  result.provenanceIds.push(provenanceId);

  const rows: EtfHoldingRow[] = [];
  const members: SnapshotMember[] = [];
  const claimed = new Map<number, number>();

  for (const holding of parse.holdings) {
    const keys: HoldingKeys = {
      // The `Identifier` column is a CUSIP; blank or all-zero identifies nothing.
      cusip: presentIdentifier('CUSIP', holding.identifier),
      isin: null,
      lei: null,
      sedol: presentIdentifier('SEDOL', holding.sedol),
      ticker: holding.ticker,
      name: holding.name,
    };
    const resolution = await resolveHolding(ctx.tx, keys, at);
    if (resolution.instrumentId !== null && resolution.candidate !== null) {
      result.resolved += 1;
      const identifierWrites = await writeHoldingIdentifiers(ctx.tx, {
        candidate: resolution.candidate,
        keys,
        sourceId: SSGA_SOURCE_ID,
        provenanceId,
        validFrom,
        knownAt,
      });
      result.identifiersWritten += identifierWrites.written;
      result.conflictsWritten += identifierWrites.conflicts;
      result.exceptionsWritten += identifierWrites.conflicts;
    } else {
      result.unresolved += 1;
      result.exceptionsWritten += await recordUnresolvedHolding(ctx.tx, {
        sourceId: SSGA_SOURCE_ID,
        provenanceId,
        asOfDate,
        lineNo: holding.lineNo,
        name: holding.name,
        tried: resolution.tried,
        reason: resolution.failure ?? 'unresolved',
      });
    }

    rows.push({
      etfInstrumentId,
      asOfDate,
      sourceId: SSGA_SOURCE_ID,
      lineNo: holding.lineNo,
      holdingInstrumentId: resolution.instrumentId,
      name: holding.name,
      cusip: keys.cusip,
      isin: null,
      lei: null,
      sedol: keys.sedol,
      ticker: holding.ticker,
      shares: numericText(holding.shares),
      // The file publishes no value; deriving one from weight × net assets would invent a number.
      marketValue: null,
      weight: weightToFraction(holding.weight),
      assetCat: null,
      issuerCat: null,
      country: null,
      provenanceId,
    });

    // A non-USD line stays in `etf_holdings` and is excluded from `index_members`.
    if (resolution.instrumentId === null || holding.currency !== 'USD') continue;
    result.indexEligible += 1;
    const previous = claimed.get(resolution.instrumentId);
    if (previous !== undefined) {
      result.exceptionsWritten += await recordUnresolvedHolding(ctx.tx, {
        sourceId: SSGA_SOURCE_ID,
        provenanceId,
        asOfDate,
        lineNo: holding.lineNo,
        name: holding.name,
        tried: [`DUPLICATE_OF_LINE:${String(previous)}`],
        reason: 'ambiguous',
      });
      continue;
    }
    claimed.set(resolution.instrumentId, holding.lineNo);
    members.push({
      instrumentId: resolution.instrumentId,
      weight: weightToFraction(holding.weight),
      shares: numericText(holding.shares),
      // NULL, as for every SSGA row: the file publishes no market value.
      marketValue: null,
    });
  }

  result.etfHoldings = await upsertEtfHoldings(ctx.tx, rows);
  result.members = await recordSnapshot(ctx.tx, {
    indexId: index.indexId,
    asOfDate,
    sourceId: SSGA_SOURCE_ID,
    provenanceId,
    members,
    txFrom: knownAt,
  });

  const coverage = result.holdings === 0 ? 1 : result.resolved / result.holdings;
  if (coverage < 0.98) {
    result.dqEventsWritten += await recordDqEvent(ctx.tx, {
      kind: 'field_population',
      severity: 'warn',
      sourceId: SSGA_SOURCE_ID,
      subject: 'etf_holdings.holding_instrument_id',
      key: `${SSGA_SOURCE_ID}:${asOfDate}:coverage`,
      details: { resolved: result.resolved, total: result.holdings, coverage },
    });
  }

  if (req.reconcile !== false) {
    const report = await reconcileAgainstNport(ctx.tx, {
      etfInstrumentId,
      ssgaAsOfDate: asOfDate,
    });
    result.reconcile = report;
    result.dqEventsWritten += await publishReconcileFindings(ctx.tx, report);
  }

  result.inserted = result.etfHoldings.inserted + result.members.written;
  result.updated = result.etfHoldings.updated;
  result.skipped = result.etfHoldings.unchanged + result.members.unchanged;
  ctx.log?.info?.('ssgaHoldings.ok', {
    asOfDate,
    holdings: result.holdings,
    members: result.members.written,
    unresolved: result.unresolved,
  });
  return result;
}

/**
 * US Eastern's UTC offset on a date, as an ISO suffix. DST runs from the second Sunday in March to
 * the first Sunday in November; that rule has been stable since 2007 and is what the file's own
 * "4 p.m. New York" means. Computed, not looked up, so there is no table to go stale.
 */
export function easternOffset(date: string): '-04:00' | '-05:00' {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const secondSundayMarch = nthSunday(y, 3, 2);
  const firstSundayNovember = nthSunday(y, 11, 1);
  const key = m * 100 + d;
  const start = 300 + secondSundayMarch;
  const end = 1100 + firstSundayNovember;
  return key >= start && key < end ? '-04:00' : '-05:00';
}

function nthSunday(year: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - firstDow) % 7);
  return firstSunday + (n - 1) * 7;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §8.2 — reconciling SPDR against N-PORT (QA-03)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Compare the two publications **at the N-PORT `as_of_date`**, never at today's.
 *
 * `etf_holdings` is keyed by `(etf_instrument_id, as_of_date, source_id, line_no)` rather than
 * being overwritten daily precisely so this comparison has a partner: the SPDR row set for the
 * quarter-end date is still there when the filing arrives two months later. When no SPDR file for
 * that date is held, there is nothing to compare and the report says so rather than comparing a
 * June filing against a September file.
 */
export async function reconcileAgainstNport(
  tx: Tx,
  args: { etfInstrumentId: number; ssgaAsOfDate: string },
): Promise<ReconcileReport> {
  // The newest N-PORT date **that we also hold an SPDR slice for**. Without a partner there is
  // nothing to compare, and comparing a June filing against a September file would report the
  // whole index as a membership difference — a false alarm, not a finding.
  const overlap = await tx.execute<{ as_of_date: string }>(sql`
    SELECT n.as_of_date
      FROM etf_holdings n
     WHERE n.etf_instrument_id = ${args.etfInstrumentId}::bigint
       AND n.source_id = 'sec.archives'
       AND n.as_of_date <= ${args.ssgaAsOfDate}::date
       AND EXISTS (SELECT 1 FROM etf_holdings s
                    WHERE s.etf_instrument_id = n.etf_instrument_id
                      AND s.source_id = 'ssga.holdings'
                      AND s.as_of_date = n.as_of_date)
     ORDER BY n.as_of_date DESC
     LIMIT 1`);
  const asOfDate = overlap.rows[0]?.as_of_date ?? null;
  const empty: ReconcileReport = {
    asOfDate,
    onlyInNport: 0,
    onlyInSsga: 0,
    nameDivergences: 0,
    totalDriftBp: 0,
  };
  if (asOfDate === null) return empty;

  const rows = await tx.execute<{
    only_in_nport: string;
    only_in_ssga: string;
    name_divergences: string;
    total_drift_bp: string;
  }>(sql`
    WITH nport AS (
      SELECT holding_instrument_id AS id, weight
        FROM etf_holdings
       WHERE etf_instrument_id = ${args.etfInstrumentId}::bigint
         AND as_of_date = ${asOfDate}::date
         AND source_id = 'sec.archives'
         AND holding_instrument_id IS NOT NULL),
    ssga AS (
      SELECT holding_instrument_id AS id, weight
        FROM etf_holdings
       WHERE etf_instrument_id = ${args.etfInstrumentId}::bigint
         AND as_of_date = ${asOfDate}::date
         AND source_id = 'ssga.holdings'
         AND holding_instrument_id IS NOT NULL),
    joined AS (SELECT n.id AS nid, s.id AS sid, n.weight AS nw, s.weight AS sw
                 FROM nport n FULL OUTER JOIN ssga s ON s.id = n.id)
    SELECT count(*) FILTER (WHERE sid IS NULL)                                  AS only_in_nport,
           count(*) FILTER (WHERE nid IS NULL)                                  AS only_in_ssga,
           count(*) FILTER (WHERE nid IS NOT NULL AND sid IS NOT NULL
                              AND abs(coalesce(nw, 0) - coalesce(sw, 0)) * 10000 > ${RECONCILE_NAME_BP})
                                                                                AS name_divergences,
           coalesce(sum(abs(coalesce(nw, 0) - coalesce(sw, 0))) * 10000, 0)     AS total_drift_bp
      FROM joined`);
  const row = rows.rows[0];
  if (row === undefined) return empty;
  return {
    asOfDate,
    onlyInNport: Number(row.only_in_nport),
    onlyInSsga: Number(row.only_in_ssga),
    nameDivergences: Number(row.name_divergences),
    totalDriftBp: Number(row.total_drift_bp),
  };
}

/** §8.2's findings as `dq_events`; idempotent, so a re-run adds nothing. */
export async function publishReconcileFindings(tx: Tx, report: ReconcileReport): Promise<number> {
  if (report.asOfDate === null) return 0;
  let written = 0;
  if (report.nameDivergences > 0) {
    written += await recordDqEvent(tx, {
      kind: 'cross_source_divergence',
      severity: 'warn',
      sourceId: SSGA_SOURCE_ID,
      subject: 'index_members',
      key: `${SSGA_SOURCE_ID}:${report.asOfDate}:name-divergence`,
      details: { names: report.nameDivergences, thresholdBp: RECONCILE_NAME_BP },
    });
  }
  if (report.totalDriftBp > RECONCILE_TOTAL_BP) {
    // A whole-file misparse is what this catches; per-name checks can miss it.
    written += await recordDqEvent(tx, {
      kind: 'cross_source_divergence',
      severity: 'error',
      sourceId: SSGA_SOURCE_ID,
      subject: 'index_members',
      key: `${SSGA_SOURCE_ID}:${report.asOfDate}:aggregate-drift`,
      details: { totalDriftBp: report.totalDriftBp, thresholdBp: RECONCILE_TOTAL_BP },
    });
  }
  if (report.onlyInNport > 0 || report.onlyInSsga > 0) {
    written += await recordDqEvent(tx, {
      kind: 'cross_source_divergence',
      severity: 'warn',
      sourceId: SSGA_SOURCE_ID,
      subject: 'index_members.membership',
      key: `${SSGA_SOURCE_ID}:${report.asOfDate}:membership-diff`,
      details: { onlyInNport: report.onlyInNport, onlyInSsga: report.onlyInSsga },
    });
  }
  return written;
}

/** The scheduler row (PROVIDERS §13): daily at 19:00 ET on business days. */
export const job = {
  id: 'ssgaHoldings',
  schedule: '0 19 * * 1-5',
  provider: SSGA_SOURCE_ID,
  priority: 2 as const,
  timeoutMs: 60_000,
  run: (ctx: RefIngestContext): Promise<SsgaHoldingsResult> => runSsgaHoldings(ctx),
};
