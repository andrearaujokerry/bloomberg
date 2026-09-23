// packages/web/src/screens/shared/quoteHeader.ts
//
// The `kv#header` node every security screen shows first (FUNCTIONS_TIER1 §0.1), and the small cell
// vocabulary every Tier 1 screen builds its spec out of.
//
// Why both live in one file: WP-09 owns exactly two shared screen modules — this one and
// `newsList.ts` (FUNCTIONS_TIER1 §0.1). The header is where the cell rules are exercised first
// (a price, a signed change, a session state, a denied field), so the helpers that encode those
// rules are declared here and imported by the other thirteen screens rather than copied into each.
//
// The rules these helpers encode, once, so no screen can forget one:
//
//   * **Provenance.** A cell that shows a number carries `fieldId` and `provIdx` — that pair is what
//     `Ctrl+I` resolves against `meta.provenance` (FUNCTIONS.md §1.5, DATA-10). `cell()` takes the
//     field id as its first argument for exactly that reason: it cannot be called without one.
//   * **Nulls.** A screen never shows a number the payload marked `null`. The cell keeps `v: null`
//     and its `r` (entitlement reason, ENTL-05) or is explained by `meta.unavailable`; the renderer
//     draws an em dash. Nothing here substitutes a zero, a last-known value or a blank.
//   * **Display numbers are not data.** Row counts, page numbers, unread counts and ranks are not
//     values a source published, so they are `countCell()`s: `provIdx: -1`, no `fieldId`, nothing to
//     open a provenance panel on. The screens test asserts that split.
//
// Pure: no DOM, no state, no IO. WP-12's `ScreenRenderer` turns what these return into pixels.

import { decimalsOf, formatOf } from '@terminal/core';
import type { FieldId, ValueCell } from '@terminal/core';
import type { PayloadMeta } from '@terminal/sdk';

import type { Badge, Cell, Node, ScreenSpec } from '../../screen/types.js';

/** What the renderer draws for a null cell (FUNCTIONS_TIER1 §DES "denials render `—`"). */
export const EM_DASH = '—';

/** The `…` a never-polled (pending) subject shows — `provIdx: -1`, no reason (§0.4 rule 1). */
export const ELLIPSIS = '…';

export interface CellOptions {
  /** Override the rendering the dictionary implies. */
  fmt?: Cell['fmt'];
  /** Override the dictionary's decimals (or supply them where it says "instrument decimals"). */
  decimals?: number;
  /** Command line `Enter` runs on this cell. */
  command?: string;
  /** Derive `dir` from the sign of the value — `CHG_*` cells colour up/down (TERM-11). */
  signed?: boolean;
}

/** up / down / flat from a signed value; `undefined` when there is no number to take a sign of. */
export function dirOf(v: unknown): Cell['dir'] {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  if (v > 0) return 'up';
  if (v < 0) return 'down';
  return 'flat';
}

/**
 * A payload `ValueCell` as the screen renders it. `st`, `r`, `ts`, `live` and `provIdx` are carried
 * through untouched — the screen may not launder a denial or a staleness verdict — and the field id
 * supplies the format, the decimals and the target of `Ctrl+I`.
 */
export function cell(fieldId: FieldId, vc: ValueCell, opts: CellOptions = {}): Cell {
  const out: Cell = { ...vc, fieldId, fmt: opts.fmt ?? formatOf(fieldId) };
  const decimals = opts.decimals ?? decimalsOf(fieldId) ?? undefined;
  if (decimals !== undefined) out.decimals = decimals;
  if (opts.command !== undefined) out.command = opts.command;
  if (opts.signed === true) {
    const dir = dirOf(vc.v);
    if (dir !== undefined) out.dir = dir;
  }
  return out;
}

/**
 * A stored number that is not plant-backed (a bar, a fact, a fixing — §0.4 rule 3): `st:'closed'`,
 * no `live`, and the `provIdx` of the block it came from. `null` becomes a blank cell, never a zero.
 */
export function numCell(
  fieldId: FieldId,
  v: number | null,
  provIdx: number,
  opts: CellOptions = {},
): Cell {
  const vc: ValueCell =
    v === null ? { v: null, st: 'blank', provIdx } : { v, st: 'closed', provIdx };
  return cell(fieldId, vc, opts);
}

export interface TextCellOptions {
  fieldId?: FieldId;
  fmt?: Cell['fmt'];
  provIdx?: number;
  command?: string;
}

/** A label, an identifier, a date string — text the renderer prints as it stands. */
export function textCell(v: string | null, opts: TextCellOptions = {}): Cell {
  const out: Cell = {
    v,
    st: v === null ? 'blank' : 'closed',
    provIdx: opts.provIdx ?? -1,
    fmt: opts.fmt ?? 'text',
  };
  if (opts.fieldId !== undefined) out.fieldId = opts.fieldId;
  if (opts.command !== undefined) out.command = opts.command;
  return out;
}

/**
 * A CHRT-07 computed column (`c1`, `c2`, …): a real number, with the provenance of the inputs it
 * was computed from, but no dictionary field — the formula *is* its definition. It is the one
 * cited numeric cell that legitimately carries no `fieldId`, and the screens test exempts exactly
 * this case by the `c<n>` column id.
 */
export function computedCell(
  vc: ValueCell,
  fmt: NonNullable<Cell['fmt']>,
  decimals?: number,
): Cell {
  const out: Cell = { ...vc, fmt };
  if (decimals !== undefined) out.decimals = decimals;
  return out;
}

/**
 * A display number the screen computed for the reader — a row count, a page index, an unread badge,
 * a rank. It cites nothing (`provIdx: -1`) and names no field, because no source published it.
 */
export function countCell(v: number | null, fmt: Cell['fmt'] = 'int', decimals?: number): Cell {
  const out: Cell = { v, st: v === null ? 'blank' : 'closed', provIdx: -1, fmt };
  if (decimals !== undefined) out.decimals = decimals;
  return out;
}

/** The cell a skeleton row shows: nothing known yet, nothing denied (§0.4 rule 1). */
export function blankCell(fieldId?: FieldId): Cell {
  const out: Cell = { v: null, st: 'blank', provIdx: -1 };
  if (fieldId !== undefined) {
    out.fieldId = fieldId;
    out.fmt = formatOf(fieldId);
  }
  return out;
}

/** One `kv` row built from a cell, carrying the cell's field and provenance at row level too. */
export function kvRow(
  label: string,
  value: Cell,
): { label: string; value: Cell; provIdx?: number; fieldId?: FieldId } {
  const row: { label: string; value: Cell; provIdx?: number; fieldId?: FieldId } = { label, value };
  if (value.fieldId !== undefined) row.fieldId = value.fieldId;
  if (value.provIdx >= 0) row.provIdx = value.provIdx;
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// meta → badges and footer (ENTL-05, DATA-10, TERM-12)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `PX_BID: TIER_EOD` — one chip per denial or downgrade the run reported. */
export function entitlementBadges(meta: PayloadMeta | undefined): Badge[] {
  return (meta?.entitlement ?? []).map((note) => ({
    text: `${note.fieldId}: ${note.reason}`,
    tone: note.decision === 'deny' ? ('blocked' as const) : ('warn' as const),
    title:
      note.decision === 'deny'
        ? `${note.fieldId} is not available to you: ${note.reason}`
        : `${note.fieldId} downgraded to ${note.effectiveTier ?? 'eod'}: ${note.reason}`,
  }));
}

/** `fundamentals: NO_SOURCE — no XBRL facts…` — one muted chip per absent value. */
export function unavailableBadges(meta: PayloadMeta | undefined): Badge[] {
  return (meta?.unavailable ?? []).map((note) => ({
    text: `${note.field}: ${note.reason}`,
    tone: 'warn' as const,
    title: note.detail,
  }));
}

/** The amber strip TERM-12 requires when the feed behind a screen has gone stale. */
export function stalenessBadges(meta: PayloadMeta | undefined): Badge[] {
  if (meta?.staleness !== 'stale') return [];
  return [
    {
      text: `feed stale since ${meta.asOf.validAt}`,
      tone: 'stale' as const,
      title: 'No update within three expected intervals (TERM-12).',
    },
  ];
}

/** Attribution strip: `meta.provenance[].attribution` deduplicated in idx order. */
export function footer(
  meta: PayloadMeta | undefined,
  notes: string[] = [],
): NonNullable<ScreenSpec['footer']> {
  const sources: string[] = [];
  for (const p of meta?.provenance ?? []) {
    if (!sources.includes(p.attribution)) sources.push(p.attribution);
  }
  const out: { sources: string[]; asOf?: string; notes?: string[] } = { sources };
  if (meta !== undefined) out.asOf = meta.asOf.validAt;
  if (notes.length > 0) out.notes = notes;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// quoteHeader (FUNCTIONS_TIER1 §0.1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What the header needs of a security; every Tier 1 payload's `instrument` block satisfies it. */
export interface HeaderSecurity {
  display: string;
  name: string;
  priceDecimals?: number;
  currency?: string;
}

/** The plant-backed cells the header renders. Anything absent renders pending, not denied. */
export interface QuoteHeaderCells {
  px?: ValueCell;
  chgNet?: ValueCell;
  chgPct?: ValueCell;
  sessionState?: ValueCell;
}

export interface QuoteHeaderOptions {
  /** Default `'header'`; a screen with two headers names the second one. */
  id?: string;
  title?: string;
  /** `'PX_LAST'` by default; the govt variant leads with `BEY` instead (§DES govt). */
  pxField?: FieldId;
  /** Instrument price decimals, for `px` fields the dictionary leaves to the instrument. */
  priceDecimals?: number;
  /** Extra rows appended after the standard six (the option key, the crypto caveat, …). */
  extra?: { label: string; value: Cell }[];
  columns?: 1 | 2 | 3;
}

/**
 * `kv#header` — key · name · last · net change · percent change · session state, in that order,
 * with whatever the variant adds after it. A cell the payload did not supply is pending (`…`), not
 * denied: the WS `snap` fills it (§0.4 rule 1).
 */
export function quoteHeader(
  security: HeaderSecurity | null,
  cells: QuoteHeaderCells,
  opts: QuoteHeaderOptions = {},
): Node {
  const pxField = opts.pxField ?? 'PX_LAST';
  const priceDecimals = opts.priceDecimals ?? security?.priceDecimals;
  const pxOpts: CellOptions = priceDecimals === undefined ? {} : { decimals: priceDecimals };

  const rows = [
    kvRow('Security', textCell(security?.display ?? null)),
    kvRow('Name', textCell(security?.name ?? null)),
    kvRow(
      'Last',
      cells.px === undefined ? blankCell(pxField) : cell(pxField, cells.px, pxOpts),
    ),
    kvRow(
      'Chg',
      cells.chgNet === undefined
        ? blankCell('CHG_NET_1D')
        : cell('CHG_NET_1D', cells.chgNet, { ...pxOpts, signed: true }),
    ),
    kvRow(
      'Chg %',
      cells.chgPct === undefined
        ? blankCell('CHG_PCT_1D')
        : cell('CHG_PCT_1D', cells.chgPct, { signed: true }),
    ),
    kvRow(
      'Session',
      cells.sessionState === undefined
        ? blankCell('SESSION_STATE')
        : cell('SESSION_STATE', cells.sessionState),
    ),
    ...(opts.extra ?? []).map((e) => kvRow(e.label, e.value)),
  ];

  const node: Extract<Node, { kind: 'kv' }> = {
    kind: 'kv',
    id: opts.id ?? 'header',
    columns: opts.columns ?? 3,
    rows,
  };
  if (opts.title !== undefined) node.title = opts.title;
  return node;
}
