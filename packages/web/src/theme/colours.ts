// packages/web/src/theme/colours.ts — the colour tokens, typed (CLIENT.md §12.1-12.2, TERM-11/12).
//
// `theme/tokens.css` (WP-01's) is where the colours are DEFINED, once, on `:root` and again under
// `[data-theme="light"]`. This module is how TypeScript refers to them: a token union the compiler
// checks, the `ValueState` → token mapping of §12.1, and the one reader the canvas needs.
//
// Nothing here hard-codes a hex value. A canvas cannot use a CSS variable — WP-14's chart draws
// with `ctx.strokeStyle`, a string — so it reads the computed value of the token once per theme
// change through `readTokens`. Two sources of truth for `--c-up` is how a line ends up a different
// green from the number above it.
//
// Colour is semantic only (TERM-11): up/down, entitled/blocked, stale/live, focus, error. There is
// no decorative colour and no token for one.

import type { ValueState } from '@terminal/core';

import type { Badge } from '../screen/types.js';

/** Every custom property `tokens.css` defines. The compiler rejects a token that is not here. */
export const COLOUR_TOKENS = [
  '--c-bg',
  '--c-bg-panel',
  '--c-bg-header',
  '--c-bg-row-alt',
  '--c-bg-selected',
  '--c-value',
  '--c-label',
  '--c-muted',
  '--c-up',
  '--c-down',
  '--c-flat',
  '--c-stale',
  '--c-closed',
  '--c-blocked',
  '--c-pending',
  '--c-focus',
  '--c-error',
  '--c-warn',
  '--c-ok',
  '--c-info',
  '--c-grid-line',
  '--c-axis',
  '--c-crosshair',
  '--c-series-1',
  '--c-series-2',
  '--c-series-3',
  '--c-series-4',
  '--c-series-5',
  '--c-series-6',
  '--flash-up-bg',
  '--flash-down-bg',
  '--flash-flat-bg',
] as const;

export type ColourToken = (typeof COLOUR_TOKENS)[number];

/** The six series colours, in the order a chart assigns them (CLIENT §11). */
export const SERIES_TOKENS: readonly ColourToken[] = Object.freeze([
  '--c-series-1',
  '--c-series-2',
  '--c-series-3',
  '--c-series-4',
  '--c-series-5',
  '--c-series-6',
]);

/** The token for series `index`, wrapping after six. */
export function seriesToken(index: number): ColourToken {
  const token =
    SERIES_TOKENS[((index % SERIES_TOKENS.length) + SERIES_TOKENS.length) % SERIES_TOKENS.length];
  return token ?? '--c-series-1';
}

/* -------------------------------------------------------------------------------------------- */
/* Value state and direction (CLIENT §12.1)                                                       */
/* -------------------------------------------------------------------------------------------- */

/** The colour a value in this state is drawn in — the §12.1 table, verbatim. */
export const STATE_TOKEN: Readonly<Record<ValueState, ColourToken>> = Object.freeze({
  live: '--c-value',
  stale: '--c-stale',
  closed: '--c-closed',
  blank: '--c-blocked',
  na: '--c-muted',
});

export const DIRECTION_TOKEN: Readonly<Record<'up' | 'down' | 'flat', ColourToken>> = Object.freeze(
  {
    up: '--c-up',
    down: '--c-down',
    flat: '--c-flat',
  },
);

/**
 * The `data-st` attribute a rendered value carries.
 *
 * `tokens.css` styles `[data-st="stale"]` (grey plus the `·` suffix), `closed`, `blank` and `na`;
 * `live` is the default colour and needs no rule, but the attribute is still written so a test can
 * assert the state of a live cell rather than infer it from the absence of markup (TERM-12).
 */
export function stateAttrs(st: ValueState): { 'data-st': ValueState } {
  return { 'data-st': st };
}

/** The `data-dir` attribute; `undefined` when there is no direction to show. */
export function dirAttrs(dir?: 'up' | 'down' | 'flat'): { 'data-dir'?: 'up' | 'down' | 'flat' } {
  return dir === undefined ? {} : { 'data-dir': dir };
}

/** The class a widget puts on an element whose colour follows the value state. */
export function stateClass(st: ValueState): string {
  return `st-${st}`;
}

/** The class for a change cell, which colours by direction rather than by state. */
export function dirClass(dir?: 'up' | 'down' | 'flat'): string {
  return dir === undefined ? 'chg' : `chg dir-${dir}`;
}

/** The glyph appended to a value in this state (`stale` gets `·`; `na` IS `·`). */
export function stateGlyph(st: ValueState): string {
  return st === 'stale' ? ' ·' : '';
}

/** The token a badge tone is drawn in (CLIENT §12.1, `Badge.tone`). */
export const TONE_TOKEN: Readonly<Record<Badge['tone'], ColourToken>> = Object.freeze({
  info: '--c-info',
  ok: '--c-ok',
  warn: '--c-warn',
  error: '--c-error',
  stale: '--c-stale',
  blocked: '--c-blocked',
});

/* -------------------------------------------------------------------------------------------- */
/* Reading the tokens (the canvas path)                                                           */
/* -------------------------------------------------------------------------------------------- */

/** `var(--c-up)` — what a style object uses; the browser resolves it per theme. */
export function cssVar(token: ColourToken): string {
  return `var(${token})`;
}

/**
 * The computed value of one token, for a surface that cannot use `var()`.
 *
 * Reading computed style is a layout-flush-shaped operation, so a caller reads ONCE per theme
 * change (`readTokens`) and keeps the result — never per frame and never per cell.
 */
export function readToken(token: ColourToken, element: Element): string {
  return getComputedStyle(element).getPropertyValue(token).trim();
}

/** Every token's computed value, for the chart's palette. */
export function readTokens(element: Element): Record<ColourToken, string> {
  const style = getComputedStyle(element);
  const out = {} as Record<ColourToken, string>;
  for (const token of COLOUR_TOKENS) out[token] = style.getPropertyValue(token).trim();
  return out;
}
