// packages/core/src/functions/csv.ts
//
// The CSV exporter (FUNCTIONS.md §1.6 L480-506, API.md §9 L1200-1217).
//
// `toCsv` is the ONLY serialiser: the server export route calls it on the cached payload, tests call
// it on golden payloads, and the web client never serialises at all. Because export and screen read
// the same payload, CSV = screen by construction.
//
// Output is RFC 4180: `"` doubles inside a quoted field, records end with CRLF, and the text is
// UTF-8 with no byte-order mark (this module returns a string and never prepends U+FEFF).

import type { AnyFunctionManifest, CsvColumn, CsvDocument } from './manifest.js';
import { isoDateFromEpochMs, isoDateTimeFromEpochMs } from '../fields/format.js';
import { canonicalJson } from '../hash/canonicalJson.js';

/** Record separator required by API.md §9 ("`\r\n` line ends"). */
export const CSV_LINE_ENDING = '\r\n';

export interface CsvContext {
  /** The security's display name, `null` for functions that take none. */
  display: string | null;
  /** `meta.asOf.validAt`. */
  asOf: string;
  /** `licence_registry.attribution` of every cited source, in provenance idx order. */
  attribution: string[];
}

/** Everything the standard `#` header block of an export is made of (FUNCTIONS.md §1.6 rule 5). */
export interface CsvHeaderInput {
  code: string;
  /** The alias the function was launched by, when it was not launched by its code. */
  alias?: string | null;
  display: string | null;
  /** Rendered with `canonicalJson`, so the same params always produce the same header byte-for-byte. */
  params: unknown;
  validAt: string;
  knownAt: string;
  /** The granted data tier: `'realtime' | 'delayed' | 'eod'`. */
  tier: string;
  /** `meta.staleness`: `'live' | 'stale' | 'closed' | …`. */
  staleness: string;
  attribution: readonly string[];
  provenance: readonly (number | string)[];
  /** `meta.engines` rendered as `name/version`. */
  engines: readonly string[];
  traceId: string;
  regenerated: boolean;
  /** Fields blanked by a downgrade; a *denied* field aborts the export before `toCsv` runs. */
  entitlement?: readonly { fieldId: string; reason: string }[];
  unavailable?: readonly { field: string; reason: string }[];
}

const SOURCE_PREFIX = '# source:';

/**
 * Build the standard header block, in the order FUNCTIONS.md §1.6 rule 5 fixes. The last two lines
 * are emitted only when there is something to report.
 */
export function standardHeaderLines(input: CsvHeaderInput): string[] {
  const aliasPart =
    input.alias !== undefined && input.alias !== null && input.alias !== input.code
      ? ` [alias: ${input.alias}]`
      : '';
  const lines = [
    '# terminal-export v1',
    `# function: ${input.code}${aliasPart}  security: ${input.display ?? '-'}  ` +
      `params: ${canonicalJson(input.params)}`,
    `# asOf: validAt=${input.validAt} knownAt=${input.knownAt}  tier: ${input.tier}  ` +
      `staleness: ${input.staleness}`,
    `${SOURCE_PREFIX} ${input.attribution.join('; ')}`,
    `# provenance: ${input.provenance.join(',')}  engines: ${input.engines.join(',')}  ` +
      `trace: ${input.traceId}  regenerated: ${String(input.regenerated)}`,
  ];
  if (input.entitlement !== undefined && input.entitlement.length > 0) {
    lines.push(
      `# entitlement: ${input.entitlement.map((e) => `${e.fieldId}=${e.reason}`).join(',')}`,
    );
  }
  if (input.unavailable !== undefined && input.unavailable.length > 0) {
    lines.push(
      `# unavailable: ${input.unavailable.map((u) => `${u.field}=${u.reason}`).join(',')}`,
    );
  }
  return lines;
}

/**
 * Turn a payload into the one-table CSV document the manifest describes.
 *
 * `columns` may be a function of the payload (QM, W, HP) — then `FunctionManifestPublic.csvColumns`
 * is `null` for that function. Rows must all be as wide as the column list: a ragged table would
 * silently misalign under Excel, so it throws instead.
 */
export function toCsv<P, T>(
  manifest: AnyFunctionManifest,
  payload: T,
  params: P,
  ctx: CsvContext,
): CsvDocument {
  const spec = manifest.csv;
  const columns: CsvColumn[] =
    typeof spec.columns === 'function' ? spec.columns(params, payload) : spec.columns;
  const rows = spec.rows(payload, params);

  for (const [index, row] of rows.entries()) {
    if (row.length !== columns.length) {
      throw new RangeError(
        `${manifest.code} csv row ${index} has ${row.length} cells but ${columns.length} columns ` +
          `are declared (FUNCTIONS.md §1.6 rule 3: one table per document)`,
      );
    }
  }

  return {
    filename: spec.filename(params, { display: ctx.display, asOf: ctx.asOf }),
    attribution: [...ctx.attribution],
    asOf: ctx.asOf,
    columns: columns.map((c) => ({ ...c })),
    rows: rows.map((row) => [...row]),
  };
}

/**
 * Serialise a document: the `#` comment lines first, then the column-id header row, then the data.
 *
 * `headerLines` normally comes from `standardHeaderLines`. Any line missing its `#` marker gets one,
 * and embedded line breaks are folded to spaces so a comment can never split the file. When the
 * caller supplied no `# source:` line, one is derived from `doc.attribution` — the licence footer is
 * not optional (DATA-01).
 */
export function writeCsv(doc: CsvDocument, headerLines: string[]): string {
  const comments = headerLines.map(normaliseComment);
  if (!comments.some((line) => line.startsWith(SOURCE_PREFIX)) && doc.attribution.length > 0) {
    comments.push(`${SOURCE_PREFIX} ${doc.attribution.join('; ')}`);
  }

  const lines = [
    ...comments,
    doc.columns.map((c) => escapeCsvField(c.id)).join(','),
    ...doc.rows.map((row) =>
      row.map((cell, i) => escapeCsvField(serialiseCell(cell, doc.columns[i]))).join(','),
    ),
  ];
  return `${lines.join(CSV_LINE_ENDING)}${CSV_LINE_ENDING}`;
}

const normaliseComment = (line: string): string => {
  const flat = line.replace(/[\r\n]+/g, ' ').trimEnd();
  return flat.startsWith('#') ? flat : `# ${flat}`;
};

/**
 * Cell text at full stored precision (FUNCTIONS.md §1.6 rule 2): numbers as the shortest decimal
 * that round-trips and never in exponent form for |x| ≥ 1e-6, dates `YYYY-MM-DD`, datetimes ISO
 * UTC, booleans `true`/`false`, `null` empty.
 */
export function serialiseCell(
  cell: string | number | boolean | null | undefined,
  column?: CsvColumn,
): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  if (typeof cell === 'number') {
    if (column?.type === 'date') return isoDateFromEpochMs(cell);
    if (column?.type === 'datetime') return isoDateTimeFromEpochMs(cell);
    return numberToCsv(cell);
  }
  return cell;
}

/** Shortest round-trip decimal, expanded out of exponent notation for |x| ≥ 1e-6. */
export function numberToCsv(value: number): string {
  if (!Number.isFinite(value)) return '';
  const text = String(value === 0 ? 0 : value);
  if (!text.includes('e') && !text.includes('E')) return text;
  if (Math.abs(value) < 1e-6) return text;
  return expandExponential(text);
}

const expandExponential = (text: string): string => {
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (m === null) return text;
  const sign = m[1] ?? '';
  const intPart = m[2] ?? '0';
  const fracPart = m[3] ?? '';
  const exponent = Number(m[4] ?? '0');
  const digits = `${intPart}${fracPart}`;
  const point = intPart.length + exponent;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
};

/** RFC 4180 quoting: quote on `,`, `"`, CR, LF or edge whitespace; double every `"` inside. */
export function escapeCsvField(value: string): string {
  const needsQuotes =
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\r') ||
    value.includes('\n') ||
    value !== value.trim();
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}
