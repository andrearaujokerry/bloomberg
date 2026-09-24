// packages/web/src/theme/type.ts — the density type stack (CLIENT.md §12.3, TERM-11).
//
// Monospace everywhere numbers appear, tabular figures, and no whitespace beyond one cell padding.
// A terminal is read by scanning columns, and a proportional digit destroys that: `1` narrower
// than `8` means a column of prices no longer lines up, and the eye has to parse what it should
// only have to scan.
//
// `tokens.css` carries the same three density rows as CSS custom properties on `<html
// data-density>`. This module is the TypeScript copy for the surfaces that cannot read CSS: the
// chart canvas measuring text, and the grid virtualiser, which needs the row height in pixels to
// decide which rows exist at all. The two must stay in step; each file says so.
//
// The arithmetic here is layout arithmetic — characters to columns, rows to pixels — which is the
// web package's own work. No number a user reads is computed here; those come from
// `packages/core` (WORKPLAN §WP-12).

import type { FieldFormat } from '@terminal/core';

/** One family for everything: UI text is mono too, so labels and values share a grid. */
export const FONT_MONO =
  '"IBM Plex Mono", "JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
export const FONT_UI = FONT_MONO;

export type DensityName = 'compact' | 'normal' | 'comfortable';

export interface DensityMetrics {
  /** Body text size in CSS pixels. */
  readonly fontPx: number;
  /** Grid/list row height in CSS pixels — the virtualiser's unit. */
  readonly rowPx: number;
  /** Horizontal cell padding, in characters of the mono font. */
  readonly cellPadCh: number;
  /** Column-header row height in CSS pixels. */
  readonly headerPx: number;
  /** Flash lifetime in milliseconds (`--flash-ms`). */
  readonly flashMs: number;
}

/** CLIENT §12.3, verbatim; `tokens.css` defines the same three rows. */
export const DENSITY: Readonly<Record<DensityName, DensityMetrics>> = Object.freeze({
  compact: Object.freeze({ fontPx: 11, rowPx: 16, cellPadCh: 0.5, headerPx: 18, flashMs: 350 }),
  normal: Object.freeze({ fontPx: 12, rowPx: 18, cellPadCh: 0.5, headerPx: 20, flashMs: 700 }),
  comfortable: Object.freeze({
    fontPx: 13,
    rowPx: 22,
    cellPadCh: 0.75,
    headerPx: 24,
    flashMs: 700,
  }),
});

export const DEFAULT_DENSITY: DensityName = 'normal';

export const DENSITY_NAMES: readonly DensityName[] = Object.freeze([
  'compact',
  'normal',
  'comfortable',
]);

/** The metrics of a density name, falling back to `normal` for an unknown one. */
export function densityMetrics(name: string | null | undefined): DensityMetrics {
  return name !== null && name !== undefined && isDensityName(name)
    ? DENSITY[name]
    : DENSITY[DEFAULT_DENSITY];
}

export function isDensityName(value: string): value is DensityName {
  return value === 'compact' || value === 'normal' || value === 'comfortable';
}

/** Font weights: 400 body, 500 labels and headers, 600 focused row keys and panel titles. */
export const WEIGHT = Object.freeze({ body: 400, label: 500, strong: 600 } as const);

/** The `font` shorthand for a canvas context at this density. */
export function canvasFont(density: DensityMetrics, weight: number = WEIGHT.body): string {
  return `${String(weight)} ${String(density.fontPx)}px ${FONT_MONO}`;
}

/* -------------------------------------------------------------------------------------------- */
/* Column widths (CLIENT §12.3)                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * Width in characters implied by a rendering. A number's width is a property of its FORMAT, not of
 * the sample of values loaded, so a column does not resize when the page changes and a scanning
 * eye keeps its place.
 */
export const FORMAT_WIDTH_CH: Readonly<Record<FieldFormat, number>> = Object.freeze({
  px: 10,
  pct: 8,
  bp: 7,
  int: 12,
  shares: 12,
  ccy: 12,
  date: 10,
  datetime: 19,
  // `text` is measured from its content instead; this is the floor.
  text: 8,
});

/** A text column is never wider than this, however long its longest value (CLIENT §12.3). */
export const TEXT_WIDTH_CAP_CH = 32;

/**
 * The width of a column, in characters.
 *
 * Numeric formats take their fixed width. `text` takes the longest of its header and its values,
 * capped at 32 characters — the cap is what stops one 300-character headline from pushing every
 * price off the screen.
 */
export function columnWidthCh(
  fmt: FieldFormat | undefined,
  headerLength: number,
  longestValueLength = 0,
): number {
  const format = fmt ?? 'text';
  if (format !== 'text') return Math.max(FORMAT_WIDTH_CH[format], headerLength);
  const content = Math.max(headerLength, longestValueLength, FORMAT_WIDTH_CH.text);
  return Math.min(content, TEXT_WIDTH_CAP_CH);
}

/**
 * Column width in CSS pixels at a given density.
 *
 * A mono font's advance width is a fixed fraction of its size; 0.6 em is the IBM Plex Mono figure
 * and is close enough for every other family in the stack that a column never clips. The grid
 * measures the real advance once at mount and overrides this — this is the value used before the
 * first measurement and in environments (jsdom, a worker) where there is nothing to measure.
 */
export const MONO_ADVANCE_EM = 0.6;

export function columnWidthPx(widthCh: number, density: DensityMetrics): number {
  const padding = density.cellPadCh * 2;
  return Math.ceil((widthCh + padding) * density.fontPx * MONO_ADVANCE_EM);
}
