// packages/core/src/functions/manifests/Q.ts
//
// `Q` — Quote (FUNCTIONS_TIER1.md §Q L771-889, FUNCTIONS.md §6 L1080).
//
// Q is the screen that answers "what is this worth, and how do we know". It shows the composite the
// ticker plant maintains for one security, the per-line contributions that composed it, the three
// FEED-05 timestamps of each, the top of book and the captured tape. The payload is deliberately
// redundant — composite AND lines — because the BUS-05 merge is the thing a trader distrusts, and
// the only way to answer "which source won PX_LAST" is to show both and let them be compared.
//
// Asset classes come from the §6 binding row VERBATIM: `equity, etf, index, fx, option, crypto,
// rate → quote`. One variant for seven classes: the shape does not change with the class, only
// which fields the class has (options carry greeks, a rate fixing carries percentiles), so there is
// one resolver and `fieldIds()` narrows the field set.

import { z } from 'zod';

import { requireField } from '../../fields/dictionary.js';
import { isoDateTimeFromEpochMs } from '../../fields/format.js';
import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import type { AssetClass, InstrumentStatus, ResolvedRef } from '../../types/instrument.js';
import type { DataQualityFlag, SessionState, Tier, ValueState } from '../../types/quote.js';
import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§Q "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const QParams = z.object({
  /** Book levels requested; v1 sources publish 1 (top of book), which `book.reason` then says. */
  depth: z.number().int().min(1).max(10).default(5),
  tapeRows: z.number().int().min(10).max(200).default(30),
  view: z.enum(['composite', 'lines', 'tape']).default('composite'),
});
export type QParams = z.infer<typeof QParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§Q "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The API.md §3 `InstrumentSummary`, restated structurally.
 *
 * `packages/core` may not import `@terminal/sdk` (ARCHITECTURE L59-77, and the ESLint rule that
 * enforces it), so the wire type cannot be referenced from a manifest. This is the same shape,
 * declared over core's own `ResolvedRef`: `functions/shared/instrumentSummary.ts#toSummary` returns
 * the sdk type and is assignable to this one column for column, which is what keeps the two from
 * drifting without a second declaration to maintain.
 */
export interface FunctionInstrumentSummary extends Omit<ResolvedRef, 'primaryListingId'> {
  /**
   * `| undefined` spelled out: the wire type is zod-inferred, where an `.optional()` key admits an
   * explicit `undefined`, and under `exactOptionalPropertyTypes` a bare `?:` does not. Without it
   * `toSummary`'s return is not assignable to this type, which is the whole point of declaring it.
   */
  primaryListingId?: number | undefined;
  ticker: string;
  exchCode: string;
  securityType: string;
  compositeFigi: string | null;
  status: InstrumentStatus;
  priceDecimals: number;
}

/** Keyed by the quote fields of the asset class (§0.4 rule 1). */
export type QCells = Partial<Record<FieldId, ValueCell>>;

/** FEED-05's three instants as ISO-8601 strings; `src` is null when the provider publishes none. */
export interface QTimestamps {
  src: string | null;
  cap: string;
  pub: string;
}

/** One md line's own contribution to the composite (BUS-05, FEED-05). */
export interface QLine {
  mdLineId: number;
  sourceId: string;
  providerSymbol: string;
  lineKind: 'composite' | 'venue' | 'derived' | 'reference';
  priority: number;
  intrinsicDelayMin: number;
  expectedIntervalMs: number;
  /** `'l:<mdLineId>'` — the subject the screen registers this row's cells against. */
  subject: string;
  cells: QCells;
  ts: QTimestamps;
  srcSeq: number | null;
  st: ValueState;
  provIdx: number;
  /**
   * Field ids where this line's value IS the composite's — the BUS-05 merge made visible.
   *
   * An addition to §Q's payload table, and the cheapest possible one: the acceptance row asks that
   * "the payload shows which line won each field", and a screen deriving it by comparing floats
   * would have to re-implement the merge's tie-breaks to get it right.
   */
  wonFields: FieldId[];
}

export interface QBookLevel {
  px: number;
  size: number | null;
  venue: string | null;
  provIdx: number;
}

export interface QBook {
  bids: QBookLevel[];
  asks: QBookLevel[];
  depthRequested: number;
  depthAvailable: number;
  reason: 'DEPTH_UNAVAILABLE_SOURCE' | null;
}

/**
 * The venue session (FEED-06).
 *
 * **Nullable, a deviation from §Q's payload table, which types it as always present with a
 * `calendarId: string`.** An instrument whose venue has no seeded calendar has no session times to
 * report, and §0.6's degradation rule for exactly that case is "null plus a reason", never an
 * invented window. A non-nullable field would force this resolver to make one up.
 */
export interface QSession {
  state: SessionState;
  calendarId: string;
  tz: string;
  openLocal: string;
  closeLocal: string;
  nextChangeAt: string | null;
  earlyClose: boolean;
}

export interface QTapeRow {
  capTs: string;
  srcTs: string | null;
  kind: 'trade' | 'quote' | 'summary';
  price: number | null;
  size: number | null;
  bid: number | null;
  ask: number | null;
  tickDir: 'u' | 'd' | 'f' | null;
  srcSeq: number | null;
  conditions: string[];
  provIdx: number;
}

/**
 * `Q`'s own data-quality code, raised by the resolver rather than by the plant.
 *
 * The composite's `last` and its `book` are taken from *different* lines by BUS-05 — the trade
 * block from the freshest line publishing `PX_LAST`, the book from the freshest venue or composite
 * line publishing `PX_BID` — so a merge that is individually correct on both sides can still show
 * a last price outside its own bid/ask. That is a distinct and far more visible defect than the
 * plant's `CROSS_SOURCE_DIVERGENCE`, which only fires past 0.5 %: a seven-cent crossing on a $330
 * name is 0.027 % and reaches the screen silently. It gets its own code so the cause (the merge
 * split, not two sources disagreeing about a price) is legible from the flag.
 */
export type QDataQualityFlag = DataQualityFlag | 'LAST_OUTSIDE_BOOK';

export interface QPayload {
  variant: 'quote';
  instrument: FunctionInstrumentSummary;
  composite: QCells;
  compositeTs: QTimestamps;
  compositeSeq: number;
  tier: Tier;
  delayMin: number;
  lines: QLine[];
  book: QBook;
  session: QSession | null;
  /** Newest first, ≤ `params.tapeRows`. */
  tape: QTapeRow[];
  /** The BUS-05 rules applied, as short strings. */
  compositionRules: string[];
  dq: QDataQualityFlag[];
  /** `ctx.asOf.validAt` — the instant the payload reproduces at. */
  asOf: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field sets (§Q "Data dependencies")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Equity / etf / index / fx / crypto, before the per-class filter below. */
export const Q_QUOTE_FIELDS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'LAST_SIZE',
  'LAST_TRADE_TIME',
  'PX_BID',
  'PX_ASK',
  'BID_SIZE',
  'ASK_SIZE',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_CLOSE_1D',
  'PX_OFFICIAL_CLOSE',
  'PX_VOLUME',
  'VWAP',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'TICK_DIR',
  'IVOL_30D',
  'SESSION_STATE',
]);

/** What an option contract adds (Cboe publishes the greeks). */
export const Q_OPTION_FIELDS: readonly FieldId[] = Object.freeze([
  'OPT_IV',
  'OPT_DELTA',
  'OPT_GAMMA',
  'OPT_VEGA',
  'OPT_THETA',
  'OPT_RHO',
  'OPT_OI',
  'OPT_THEO',
  'OPT_UNDL_PX',
]);

/** A rate fixing has no book and no tape: the fixing, its percentiles, its volume and the target. */
export const Q_RATE_FIELDS: readonly FieldId[] = Object.freeze([
  'RATE',
  'RATE_P1',
  'RATE_P25',
  'RATE_P75',
  'RATE_P99',
  'RATE_VOLUME_BN',
  'TARGET_FROM',
  'TARGET_TO',
  'SESSION_STATE',
]);

/**
 * The fields Q asks for on one asset class.
 *
 * Filtered by the dictionary's own `assetClasses` rather than listed per class by hand. That is
 * not a convenience: the runner's step-5 pre-check turns every field it asks about into a gate
 * entry, and `field_licence` has no row for a pair the dictionary says is meaningless — so asking
 * for `VWAP` on a crypto pair would come back `FIELD_UNKNOWN` and *blank the cell with an
 * entitlement reason*, telling the user their contract is short when the field simply does not
 * exist for that class. The dictionary decides what applies; the manifest only decides what to ask.
 */
export function qFieldIds(assetClass: AssetClass | null): FieldId[] {
  const base =
    assetClass === 'rate'
      ? Q_RATE_FIELDS
      : assetClass === 'option'
        ? [...Q_QUOTE_FIELDS, ...Q_OPTION_FIELDS]
        : Q_QUOTE_FIELDS;
  if (assetClass === null) return [...base];
  return base.filter((id) => requireField(id).assetClasses.includes(assetClass));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§Q "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `'AAPL US Equity'` → `'AAPL_US_Equity'`; the filename half of API.md §9. */
export function slugOf(display: string | null): string {
  const slug = (display ?? 'security').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug === '' ? 'security' : slug;
}

/** `'2026-09-15T18:41:28.000Z'` → `'20260915T184128'` (API.md §9). */
export function asOfCompact(asOf: string): string {
  return asOf.replace(/[-:]/g, '').slice(0, 15);
}

/**
 * One CSV column per line, keyed by its `sourceId`.
 *
 * Two lines of one instrument may share a source (a venue line and a composite line of the same
 * provider), and two columns with one id is a CSV whose header lies about which column is which,
 * so a repeated source carries its `mdLineId`.
 */
export function qLineColumnIds(lines: readonly QLine[]): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line.sourceId, (counts.get(line.sourceId) ?? 0) + 1);
  return lines.map((line) =>
    (counts.get(line.sourceId) ?? 0) > 1
      ? `${line.sourceId}#${String(line.mdLineId)}`
      : line.sourceId,
  );
}

/** `packages/core` has no `Date`: epoch ms → ISO-8601 goes through the pure formatter. */
function isoOrNull(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : isoDateTimeFromEpochMs(ms);
}

function qCsvColumns(_params: QParams, payload: QPayload): CsvColumn[] {
  const columns: CsvColumn[] = [
    { id: 'section', label: 'Section', type: 'string' },
    { id: 'key', label: 'Key', type: 'string' },
    { id: 'composite', label: 'Composite', type: 'string' },
  ];
  for (const id of qLineColumnIds(payload.lines)) {
    columns.push({ id, label: id, type: 'string' });
  }
  columns.push(
    { id: 'srcTs', label: 'Source ts', type: 'datetime' },
    { id: 'capTs', label: 'Captured ts', type: 'datetime' },
    { id: 'pubTs', label: 'Published ts', type: 'datetime' },
    { id: 'state', label: 'State', type: 'string' },
  );
  return columns;
}

function qCsvRows(payload: QPayload): (string | number | boolean | null)[][] {
  const rows: (string | number | boolean | null)[][] = [];

  // `section:'composite'` — one row per field, the composite's value beside every line's own.
  for (const [field, cell] of Object.entries(payload.composite)) {
    if (cell === undefined) continue;
    const lineValues = payload.lines.map((line) => line.cells[field]?.v ?? null);
    rows.push([
      'composite',
      field,
      cell.v,
      ...lineValues,
      isoOrNull(cell.ts ?? null),
      payload.compositeTs.cap,
      payload.compositeTs.pub,
      cell.st,
    ]);
  }

  // `section:'book'` — `bid1`/`ask1`; the first line column carries the size (§Q CSV).
  const padding: (string | number | boolean | null)[] = payload.lines.map(() => null);
  for (const [key, level] of [
    ['bid1', payload.book.bids[0]],
    ['ask1', payload.book.asks[0]],
  ] as const) {
    if (level === undefined) continue;
    const sizes = [...padding];
    if (sizes.length > 0) sizes[0] = level.size === null ? null : String(level.size);
    rows.push([
      'book',
      key,
      level.px,
      ...sizes,
      null,
      payload.compositeTs.cap,
      payload.compositeTs.pub,
      payload.book.reason ?? '',
    ]);
  }

  // `section:'session'` — state, calendar and the local window.
  const session = payload.session;
  rows.push([
    'session',
    'state',
    session?.state ?? 'unknown',
    ...padding,
    null,
    payload.compositeTs.cap,
    payload.compositeTs.pub,
    session === null ? 'na' : 'closed',
  ]);
  if (session !== null) {
    for (const [key, value] of [
      ['calendarId', session.calendarId],
      ['openLocal', session.openLocal],
      ['closeLocal', session.closeLocal],
    ] as const) {
      rows.push([
        'session',
        key,
        value,
        ...padding,
        null,
        payload.compositeTs.cap,
        payload.compositeTs.pub,
        'closed',
      ]);
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live (§Q "Live")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The subjects and fields the screen subscribes to, read off the payload's own cells.
 *
 * Deliberately derived rather than recomputed: a cell that carries `live` is a cell the shell may
 * overwrite from the quote cache, and a subscription that does not cover it leaves a number frozen
 * on screen with nothing to say so (TERM-12). Reading the payload makes the two impossible to
 * disagree.
 */
function qLive(_params: QParams, payload: QPayload): LiveSpec {
  const subjects: string[] = [];
  const fields: FieldId[] = [];
  const seenSubject = new Set<string>();
  const seenField = new Set<string>();

  const take = (cells: QCells): void => {
    for (const cell of Object.values(cells)) {
      const live = cell?.live;
      if (live === undefined) continue;
      if (!seenSubject.has(live.subject)) {
        seenSubject.add(live.subject);
        subjects.push(live.subject);
      }
      if (!seenField.has(live.field)) {
        seenField.add(live.field);
        fields.push(live.field);
      }
    }
  };

  take(payload.composite);
  for (const line of payload.lines) take(line.cells);

  const composite = `q:${String(payload.instrument.instrumentId)}`;
  if (!seenSubject.has(composite)) subjects.unshift(composite);

  // BUS-03: the fastest conflation any Tier 1 screen asks for. The session takes the minimum
  // across visible screens, so this is a request, not a guarantee.
  return { subjects, fields, conflationMs: 100, essential: [composite] };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

const Q_CLASSES: readonly AssetClass[] = Object.freeze([
  'equity',
  'etf',
  'index',
  'fx',
  'option',
  'crypto',
  'rate',
]);

export const Q = defineFunction<typeof QParams, QPayload>({
  code: 'Q',
  name: 'Quote',
  aliases: ['QUOTE', 'QR'],
  tier: 1,
  category: 'pricing',
  assetClasses: Q_CLASSES,
  requiresSecurity: true,
  variants: Object.fromEntries(Q_CLASSES.map((c) => [c, 'quote'])),
  params: QParams,
  paramGrammar: {
    positional: [{ name: 'depth', type: 'int', optional: true }],
    keyed: {
      TAPE: { name: 'tapeRows', type: 'int' },
      VIEW: { name: 'view', type: 'enum', values: ['composite', 'lines', 'tape'] },
    },
  },
  fieldIds: qFieldIds,
  pageable: false,
  live: qLive,
  csv: {
    filename: (_params, ctx): string => `Q_${slugOf(ctx.display)}_${asOfCompact(ctx.asOf)}.csv`,
    columns: qCsvColumns,
    rows: (payload): (string | number | boolean | null)[][] => qCsvRows(payload),
  },
  help: {
    summary: 'Live composite quote with per-source lines, three timestamps, top of book and tape',
    description:
      'Q shows the composite quote the ticker plant maintains for the loaded security and how it ' +
      'was composed: each market-data line (Cboe delayed quotes, Yahoo chart) with its own ' +
      'values, provider sequence number and the three timestamps of every update — ' +
      'source-published, captured and published to you. The book is top of book only, because no ' +
      'v1 source publishes depth; requested levels beyond it are shown blank with the reason. The ' +
      'tape lists the observed changes captured from the delayed feeds (one row per poll that ' +
      'changed, marked synthetic_from_poll). Colour and the dot glyph show staleness: a number ' +
      'that stops updating is marked stale within three poll intervals. Options show the ' +
      'Cboe-published greeks; rates show the fixing with percentiles and volume.',
    params: [
      { name: 'depth', text: 'book levels requested (source publishes 1)', example: '10' },
      { name: 'tapeRows', text: 'tape rows 10-200', example: 'TAPE=100' },
      { name: 'view', text: 'composite, lines or tape emphasis', example: 'VIEW=LINES' },
    ],
    keys: [
      { key: 'Enter', action: 'provenance of the focused line or tick' },
      { key: '+ / -', action: 'more or fewer book levels' },
      { key: 'T', action: 'more tape rows' },
      { key: 'V', action: 'cycle composite / lines / tape' },
      { key: 'G', action: 'GIP' },
      { key: 'P', action: 'GP' },
      { key: 'D', action: 'DES' },
      { key: 'M', action: 'QM seeded with this security' },
      { key: 'O', action: 'OMON' },
    ],
    sources: [
      'cboe.quotes',
      'cboe.options',
      'yahoo.chart',
      'coingecko.simple',
      'nyfed.rates',
      'internal.derived',
    ],
    related: ['QM', 'GIP', 'GP', 'DES', 'OMON'],
  },
  keymap: [
    {
      key: 'Enter',
      action: 'line-provenance',
      when: 'grid',
      description: 'Source, captured-at and request key of the focused line or tick (DATA-10)',
    },
    { key: '+', action: 'depth-up', description: 'One more book level (max 10)' },
    { key: '-', action: 'depth-down', description: 'One fewer book level (min 1)' },
    { key: 'T', action: 'more-tape', description: 'Thirty more tape rows (max 200)' },
    { key: 'V', action: 'cycle-view', description: 'Cycle composite / lines / tape' },
    { key: 'G', action: 'open-gip', description: 'Intraday chart (GIP)' },
    { key: 'P', action: 'open-gp', description: 'Price chart (GP)' },
    { key: 'D', action: 'open-des', description: 'Security description (DES)' },
    { key: 'M', action: 'open-qm', description: 'Quote monitor seeded with this security' },
    { key: 'O', action: 'open-omon', description: 'Option monitor (OMON)' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default Q;
