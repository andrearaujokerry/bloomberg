// packages/web/src/screen/widgets/CellView.tsx — one `Cell`, and the five states it can be in.
//
// This is the smallest file in WP-12 and the one that carries the terminal's credibility. TERM-12
// says a stale price that looks live is the defect the whole design exists to prevent, so the five
// `ValueState`s are five *visibly different* renderings and not five shades of grey:
//
//   live    the formatted number, `--c-value`, a ▲/▼ when the cell names a direction
//   stale   the last formatted number, `--c-stale`, and the ` ·` glyph `tokens.css` appends
//   closed  the last/official number, `--c-closed`, no glyph — it is not expected to change
//   blank   an em dash AND the `ReasonCode` that denied it, `--c-blocked` — never a number,
//           never an empty space (ENTL-05)
//   na      `·` in `--c-muted` — the field does not apply to this instrument
//
// Where the `ReasonCode` on a blank cell comes from. Most payload paths do NOT set `Cell.r`: the
// denial is recorded once per field in `meta.entitlement[]` and the absence once per field in
// `meta.unavailable[]`, not repeated on every cell that was hit by it. A `CellView` that only drew
// `cell.r` therefore printed a bare em dash for almost every real blank, which makes a price
// withheld by entitlement and a price the source simply does not have the same mark — exactly what
// ENTL-05 forbids. So the reason is resolved in two steps: the cell's own `r` when it has one, and
// otherwise `CellReasonContext` — a `fieldId -> ReasonCode` lookup `ScreenRenderer` builds once
// from the meta it already holds. A blank whose `fieldId` is in neither table still prints the em
// dash alone; nothing is invented to fill the gap.
//
// Two mechanical points:
//   * the glyph for `stale` is `tokens.css`'s `[data-st='stale']::after { content: ' ·' }` and the
//     one for `closed` is `widgets.css`'s `[data-st='closed']::after`, so this file must NOT also
//     put either mark in the text — that would render two. The state word a test (and a screen
//     reader) needs instead lives in a visually-hidden span, which sits *before* the
//     pseudo-element and is invisible on screen.
//   * formatting is `format/index.ts`, the thin wrapper over `core/fields/format.ts`, and only
//     that. A number formatted one way on screen and another way in the CSV export is the bug the
//     single-formatter rule exists to prevent, so there is no number handling in this file at all
//     — only the choice of which glyph a non-value state prints.

import { createContext, useContext } from 'react';
import type { ReactElement } from 'react';

import { BLANK, formatCell } from '../../format/index.js';
// Aliased: the React context below wants the name `CellFormatContext`.
import type { CellFormatContext as CellFormatOptions } from '../../format/index.js';
import type { Cell } from '../types.js';

/**
 * Instrument-level context a cell cannot carry itself (FUNCTIONS.md §1.5 `fmt: 'ccy'`): the
 * currency for `ccy` cells and `instruments.price_decimals` for `px` cells whose dictionary
 * decimals are null.
 */
export type CellFormatContextValue = Pick<CellFormatOptions, 'currency' | 'priceDecimals'>;

export const CellFormatContext = createContext<CellFormatContextValue>({});

export function useCellFormat(): CellFormatContextValue {
  return useContext(CellFormatContext);
}

/**
 * Why a field on this payload is blank: `meta.entitlement[]` (a `deny` decision) and
 * `meta.unavailable[]`, flattened to one lookup. `ScreenRenderer` builds it; a cell consults it
 * only when it is `blank` and carries no `r` of its own.
 */
export type CellReasonResolver = (fieldId: string | undefined) => string | undefined;

const NO_REASONS: CellReasonResolver = () => undefined;

export const CellReasonContext = createContext<CellReasonResolver>(NO_REASONS);

export function useCellReason(): CellReasonResolver {
  return useContext(CellReasonContext);
}

/**
 * The `ReasonCode` shown beside a blank cell: the cell's own first, then the payload-level lookup.
 * Exported so WP-13's grid resolves a blank the same way rather than growing a second rule.
 */
export function reasonOfCell(
  cell: Cell,
  resolve: CellReasonResolver = NO_REASONS,
): string | undefined {
  if (cell.st !== 'blank') return cell.r;
  return cell.r ?? resolve(cell.fieldId);
}

/** What a screen reader hears and a test asserts on, one phrase per state. */
const STATE_PHRASE: Readonly<Record<Cell['st'], string>> = {
  live: 'live',
  stale: 'stale, no fresh update',
  closed: 'closed, session ended',
  blank: 'unavailable',
  na: 'not applicable',
};

const DIR_GLYPH: Readonly<Record<'up' | 'down' | 'flat', string>> = {
  up: '▲',
  down: '▼',
  flat: '',
};

/**
 * The formatted text of a cell's *value*, exported because the list and badge widgets render the
 * same numbers outside a `<CellView>`.
 *
 * The formatting itself is `format/index.ts`, which is a thin wrapper over `core/fields/format.ts`,
 * and that is also where the two state rules live: `blank` prints the blank glyph and `na` prints
 * its own glyph whatever `v` holds. They are the formatter's because every surface needs them —
 * WP-13's grid formats through `formatGridCell` and never calls this function — and this file adds
 * nothing to them. All that happens here is the choice of `signed` for a change cell.
 */
export function cellText(cell: Cell, ctx: CellFormatContextValue = {}): string {
  const opts: CellFormatOptions = { ...ctx, blank: BLANK };
  // A cell that names a direction is a change cell, and a change is written with its sign.
  if (cell.dir !== undefined) opts.signed = true;
  return formatCell(cell, opts);
}

/**
 * The `title` a cell carries: state first, then why, then when. `reason` is the resolved
 * `ReasonCode` — `cell.r` when the cell carries one, otherwise the payload-level lookup — so the
 * tooltip and the visible badge always say the same thing.
 */
export function cellTooltip(cell: Cell, reason: string | undefined = cell.r): string {
  const parts: string[] = [STATE_PHRASE[cell.st]];
  if (reason !== undefined) parts.push(reason);
  if (cell.ts !== undefined && cell.ts !== null) parts.push(new Date(cell.ts).toISOString());
  if (cell.command !== undefined) parts.push(`Enter: ${cell.command}`);
  return parts.join(' · ');
}

export interface CellViewProps {
  cell: Cell;
  /** Rendered in the accessible name before the value — the column or row this cell sits under. */
  label?: string;
  className?: string;
}

/**
 * One cell. The element carries `data-st` (colour, and the stale glyph) and `data-dir` (the change
 * colour), which is also what WP-13's `cellRegistry` writes to when a delta lands on a live cell:
 * the DOM contract is the same whether React or the registry wrote it.
 */
export function CellView({ cell, label, className }: CellViewProps): ReactElement {
  const ctx = useCellFormat();
  const resolve = useCellReason();
  const text = cellText(cell, ctx);
  const reason = reasonOfCell(cell, resolve);
  const dir = cell.dir;
  const classes = ['cell', className].filter((c) => c !== undefined).join(' ');

  return (
    <span
      className={classes}
      data-st={cell.st}
      {...(dir === undefined ? {} : { 'data-dir': dir })}
      {...(cell.live === undefined
        ? {}
        : { 'data-subject': cell.live.subject, 'data-field': cell.live.field })}
      title={cellTooltip(cell, reason)}
    >
      {label === undefined ? null : <span className="sr-only">{`${label}: `}</span>}
      <span className={dir === undefined ? 'cell__value' : 'cell__value chg'}>
        {dir === undefined || DIR_GLYPH[dir] === '' ? text : `${DIR_GLYPH[dir]} ${text}`}
      </span>
      {cell.st === 'blank' && reason !== undefined ? (
        <span className="cell__reason">{reason}</span>
      ) : null}
      <span className="sr-only">{` (${STATE_PHRASE[cell.st]})`}</span>
    </span>
  );
}
