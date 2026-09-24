// packages/web/src/keyboard/keymap.ts — the reserved global keys (FUNCTIONS.md §2.6 L784-812,
// CLIENT.md §5.1-5.2) and the combo grammar every other keyboard module matches against.
//
// This file is a TABLE and the pure functions that read it. It performs no side effect, touches no
// DOM and holds no state: `dispatcher.ts` decides what a key *does*, this decides what a key *is*.
//
// Three things the design pins down and this file therefore pins down too:
//
//   * Keys are matched on `KeyboardEvent.code`, not `key` (FUNCTIONS §2.6, CLIENT §5). `code` is the
//     physical key, so `Ctrl+P` is the same key on a Dvorak or AZERTY layout, and `Alt+1` still
//     matches on macOS where Alt+1 produces the character `¡`. Where `code` is absent or the
//     synthetic `'Unknown'` — jsdom events built by hand, and `user-event`'s F-keys, which are not
//     in its US-104 key map — the match falls back to the `key` name, so `F1` still means HELP in a
//     test. No production path relies on the fallback.
//   * `Ctrl` means `ctrlKey` on every platform and `Meta` is never bound (CLIENT §5): macOS `Cmd`
//     stays with the browser, so a combo never matches an event carrying `metaKey`.
//   * The yellow sector keys are NOT re-listed here. `F2…F11 → Govt Corp Mtge M-Mkt Muni Pfd Equity
//     Comdty Index Curncy` lives in `packages/core/src/command/sectors.ts` (`yellowKeyForSector`),
//     which is the table the command parser already resolves sector tokens against. One table, so a
//     yellow key and a typed `Govt` cannot drift apart.

import { MARKET_SECTORS, SECTOR_ALIASES, yellowKeyForSector } from '@terminal/core';
import type { KeyBinding, MarketSector } from '@terminal/core';

/* -------------------------------------------------------------------------------------------- */
/* Combos                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * The part of a `KeyboardEvent` a keymap reads. A real `KeyboardEvent` satisfies it structurally,
 * and so does a plain object, which is what lets every function here be unit tested without a DOM.
 */
export interface KeyEventLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

/** A parsed binding spec: the physical key plus the three modifiers that may be bound. */
export interface KeyCombo {
  /** `KeyboardEvent.code`: `'KeyG'`, `'Digit1'`, `'Enter'`, `'F1'`, `'ArrowLeft'`. */
  readonly code: string;
  /** `KeyboardEvent.key` as the spec spelled it, upper-cased; the fallback match. */
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

const COMBO_CACHE = new Map<string, KeyCombo>();

/** `KeyboardEvent.code` for a base token: `'g'` → `'KeyG'`, `'1'` → `'Digit1'`, `'F1'` → `'F1'`. */
function codeOfToken(token: string): string {
  if (token.length === 1) {
    const ch = token.toUpperCase();
    if (ch >= 'A' && ch <= 'Z') return `Key${ch}`;
    if (ch >= '0' && ch <= '9') return `Digit${ch}`;
    if (ch === ' ') return 'Space';
    // Punctuation bound by a manifest (`+`, `-`, `,`, `.`, `/`): there is no portable code for it,
    // so it is matched by `key` alone, which is what a user actually typed.
    return '';
  }
  return token === 'Space' ? 'Space' : token;
}

/**
 * Parse a binding spec — `'G'`, `'Shift+ArrowUp'`, `'Ctrl+Shift+S'`, `'Alt+1'`, `'F1'`.
 *
 * A bare `'+'` is a legal base token (several manifests bind it), so the split is on `'+'`
 * separators only, and a trailing empty segment is read back as the `+` key itself.
 */
export function parseCombo(spec: string): KeyCombo {
  const cached = COMBO_CACHE.get(spec);
  if (cached !== undefined) return cached;

  const parts = spec.split('+');
  let ctrl = false;
  let alt = false;
  let shift = false;
  let base = '';

  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i] ?? '';
    const part = raw.trim();
    const isLast = i === parts.length - 1;
    if (part === '' && isLast) {
      // `'Ctrl++'` → base `'+'`.
      base = '+';
      continue;
    }
    const lower = part.toLowerCase();
    if (!isLast && (lower === 'ctrl' || lower === 'control')) ctrl = true;
    else if (!isLast && lower === 'alt') alt = true;
    else if (!isLast && lower === 'shift') shift = true;
    else base = part;
  }

  const combo: KeyCombo = {
    code: codeOfToken(base),
    key: base.toUpperCase(),
    ctrl,
    alt,
    shift,
  };
  COMBO_CACHE.set(spec, combo);
  return combo;
}

/** Canonical spelling of a combo, for HELP rows and the key bar. */
export function formatCombo(combo: KeyCombo): string {
  const mods = [
    combo.ctrl ? 'Ctrl' : '',
    combo.alt ? 'Alt' : '',
    combo.shift ? 'Shift' : '',
  ].filter((m) => m !== '');
  return [...mods, combo.key].join('+');
}

/**
 * Does this event fire this combo?
 *
 * Modifiers match exactly — `'G'` is not fired by `Shift+G`, which is why `DES` can bind both — and
 * `metaKey` never matches, because no binding uses `Meta`.
 */
export function matchesCombo(e: KeyEventLike, combo: KeyCombo): boolean {
  if (e.metaKey) return false;
  if (e.ctrlKey !== combo.ctrl || e.altKey !== combo.alt || e.shiftKey !== combo.shift)
    return false;
  if (combo.code !== '' && e.code !== '' && e.code !== 'Unknown') return e.code === combo.code;
  return e.key.toUpperCase() === combo.key;
}

/** `matchesCombo` against a spec string, with the parse cached. */
export function matchesKey(e: KeyEventLike, spec: string): boolean {
  return matchesCombo(e, parseCombo(spec));
}

/**
 * A printable keystroke: one character, no `Ctrl`/`Alt`/`Meta` (CLIENT §4.1 L301).
 *
 * `Shift` is deliberately allowed — `A` is as printable as `a` — and `Enter`, `Tab` and the arrows
 * are excluded by the length test, since their `key` is a name rather than a character.
 */
export function isPrintable(e: KeyEventLike): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
}

/* -------------------------------------------------------------------------------------------- */
/* Focus regions                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * Where a keystroke lands. The node kinds are `ScreenSpec.Node['kind']` minus `split` (a layout
 * container is never focused), plus the three regions that are not nodes.
 */
export type KeyRegion =
  | 'command'
  | 'grid'
  | 'table'
  | 'list'
  | 'form'
  | 'tabs'
  | 'kv'
  | 'text'
  | 'badges'
  | 'chart'
  | 'custom'
  | 'keybar'
  | 'overlay';

/**
 * Does a `KeyBinding.when` cover this region?
 *
 * `'always'` matches every region except the command line, where a printable letter is text
 * (CLIENT §5.1 rule 5), and an open overlay, which owns the screen while it is up (CLIENT §3.4).
 * `table` is a grid without live cells (CLIENT §5.3), so a `when:'grid'` binding is active on both.
 *
 * The overlay exclusion matters twice over. `dispatcher.ts` stops at the end of stage 3 while a
 * dialog is open, so a screen binding could not fire from there anyway; but `Panel.tsx#keyHints`
 * asks this same question to decide what the footer advertises, and a footer offering `R  cycle
 * range` while a ticket dialog has the keyboard is an offer the terminal will not honour.
 */
export function bindingApplies(binding: KeyBinding, region: KeyRegion): boolean {
  const when = binding.when ?? 'always';
  if (region === 'command' || region === 'overlay') return false;
  if (when === 'always') return true;
  if (when === 'grid') return region === 'grid' || region === 'table';
  return when === region;
}

/* -------------------------------------------------------------------------------------------- */
/* The reserved keys (FUNCTIONS.md §2.6)                                                          */
/* -------------------------------------------------------------------------------------------- */

export type ReservedAction =
  | 'go'
  | 'go-next-panel'
  | 'row-next-panel'
  | 'cancel'
  | 'help'
  | 'sector'
  | 'print'
  | 'grid-export'
  | 'page-fwd'
  | 'page-back'
  | 'frame-back'
  | 'frame-forward'
  | 'focus-panel'
  | 'panel-next'
  | 'panel-prev'
  | 'region-next'
  | 'region-prev'
  | 'provenance'
  | 'focus-command';

export interface ReservedBinding {
  /** The spec as §2.6 writes it. */
  readonly key: string;
  readonly combo: KeyCombo;
  readonly action: ReservedAction;
  /** The terminal's name for the key — what the key bar prints (CLIENT §3.3). */
  readonly label: string;
  readonly description: string;
  /** Yellow keys only: the sector token the key inserts. */
  readonly sector?: MarketSector;
  /** `Alt+1`…`Alt+8` only: the panel ordinal, 1-based. */
  readonly panel?: number;
}

const reserved = (
  key: string,
  action: ReservedAction,
  label: string,
  description: string,
): ReservedBinding => ({ key, combo: parseCombo(key), action, label, description });

/**
 * The yellow sector keys, in `F2…F11` order, derived from core's sector table.
 *
 * `Crypto` has no yellow key on a Bloomberg keyboard (`yellowKeyForSector` returns null) and so is
 * absent here; `BTC Crypto` is typed in full.
 */
export const YELLOW_KEYS: readonly ReservedBinding[] = Object.freeze(
  MARKET_SECTORS.map((sector) => ({ sector, key: yellowKeyForSector(sector) }))
    .filter((row): row is { sector: MarketSector; key: string } => row.key !== null)
    .sort((a, b) => Number(a.key.slice(1)) - Number(b.key.slice(1)))
    .map(({ sector, key }): ReservedBinding => ({
      key,
      combo: parseCombo(key),
      action: 'sector',
      label: sector.toUpperCase(),
      description: `Insert the ${sector} sector token`,
      sector,
    })),
);

/** `Alt+1`…`Alt+8` — focus panel `p1`…`p8`. */
const PANEL_KEYS: readonly ReservedBinding[] = Object.freeze(
  [1, 2, 3, 4, 5, 6, 7, 8].map((n): ReservedBinding => ({
    key: `Alt+${String(n)}`,
    combo: parseCombo(`Alt+${String(n)}`),
    action: 'focus-panel',
    label: `P${String(n)}`,
    description: `Focus panel p${String(n)}`,
    panel: n,
  })),
);

/**
 * FUNCTIONS.md §2.6 L790-812 and CLIENT.md §5.2, in the order those tables list them.
 *
 * A function keymap may not rebind any of these: `dispatcher.ts` resolves this table before the
 * screen's own bindings, so a manifest that binds `Ctrl+P` never sees the key.
 */
export const RESERVED_KEYS: readonly ReservedBinding[] = Object.freeze([
  reserved('Enter', 'go', 'GO', 'Execute the command line, or the selected autocomplete row'),
  reserved('Ctrl+Enter', 'go-next-panel', 'GO NEXT', 'Execute the command line in the next panel'),
  reserved('Shift+Enter', 'row-next-panel', 'ROW NEXT', 'Open the focused row in the next panel'),
  reserved('Escape', 'cancel', 'CANCEL', 'Cancel, then MENU: back to the previous screen'),
  reserved('F1', 'help', 'HELP', 'Explain this screen; press twice for a ticket'),
  ...YELLOW_KEYS,
  reserved('Ctrl+P', 'print', 'PRINT', 'Export the panel result as CSV'),
  reserved('Ctrl+E', 'grid-export', 'DATA', 'Export the focused grid as CSV'),
  reserved('PageDown', 'page-fwd', 'PG FWD', 'Page forward, or scroll one viewport'),
  reserved('PageUp', 'page-back', 'PG BACK', 'Page back, or scroll one viewport'),
  reserved('Alt+ArrowLeft', 'frame-back', 'BACK', 'Previous frame in this panel'),
  reserved('Alt+ArrowRight', 'frame-forward', 'FWD', 'Next frame in this panel'),
  ...PANEL_KEYS,
  reserved('Ctrl+Tab', 'panel-next', 'NEXT PANEL', 'Focus the next visible panel'),
  reserved('Ctrl+Shift+Tab', 'panel-prev', 'PREV PANEL', 'Focus the previous visible panel'),
  reserved('Tab', 'region-next', 'NEXT', 'Next focus region'),
  reserved('Shift+Tab', 'region-prev', 'PREV', 'Previous focus region'),
  reserved('Ctrl+I', 'provenance', 'PROV', 'Provenance of the focused cell'),
  reserved('Ctrl+L', 'focus-command', 'CMD', 'Focus the command line'),
]);

/** `code|modifiers` → binding, and `KEY|modifiers` → binding for the `code`-less fallback. */
const BY_CODE = new Map<string, ReservedBinding>();
const BY_KEY = new Map<string, ReservedBinding>();

const mods = (c: { ctrl: boolean; alt: boolean; shift: boolean }): string =>
  `${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}`;

for (const binding of RESERVED_KEYS) {
  if (binding.combo.code !== '')
    BY_CODE.set(`${binding.combo.code}|${mods(binding.combo)}`, binding);
  BY_KEY.set(`${binding.combo.key}|${mods(binding.combo)}`, binding);
}

/** The reserved binding this event fires, or `null`. Two map probes, no scan. */
export function reservedFor(e: KeyEventLike): ReservedBinding | null {
  if (e.metaKey) return null;
  const m = `${e.ctrlKey ? 'C' : ''}${e.altKey ? 'A' : ''}${e.shiftKey ? 'S' : ''}`;
  if (e.code !== '' && e.code !== 'Unknown') {
    const hit = BY_CODE.get(`${e.code}|${m}`);
    if (hit !== undefined) return hit;
    // A key with a real code that is not reserved is not reserved: do not fall back, or
    // `Shift+Digit1` (`!`) would be read as the `1` of some other table.
    return null;
  }
  return BY_KEY.get(`${e.key.toUpperCase()}|${m}`) ?? null;
}

/** Is this spec one of the reserved keys? */
export function isReservedKey(spec: string): boolean {
  const c = parseCombo(spec);
  const key = `${c.code !== '' ? c.code : c.key}|${mods(c)}`;
  return (c.code !== '' ? BY_CODE.has(key) : false) || BY_KEY.has(`${c.key}|${mods(c)}`);
}

/**
 * Screen bindings that collide with a reserved key.
 *
 * This is a diagnostic, not a rejection. Four shipped manifests do collide and all four agree with
 * the reserved semantics rather than fighting them — `HELP` binds `F1`→ticket and `Escape`→close,
 * `CF`/`SECF`/`SRCH` bind `PageDown`→page-fwd — and several bind `Enter` in a grid, which §2.6
 * explicitly allows ("inside a grid/list/form the node's own Enter applies first when the command
 * line is empty"). Precedence in `dispatcher.ts` is what enforces the reservation; this function
 * exists so a new manifest that binds `Ctrl+P` can be caught in review rather than at a user's desk.
 */
export function reservedConflicts(
  bindings: readonly KeyBinding[],
): { binding: KeyBinding; reserved: ReservedBinding }[] {
  const out: { binding: KeyBinding; reserved: ReservedBinding }[] = [];
  for (const binding of bindings) {
    const c = parseCombo(binding.key);
    const hit =
      (c.code !== '' ? BY_CODE.get(`${c.code}|${mods(c)}`) : undefined) ??
      BY_KEY.get(`${c.key}|${mods(c)}`);
    if (hit !== undefined) out.push({ binding, reserved: hit });
  }
  return out;
}

/* -------------------------------------------------------------------------------------------- */
/* Yellow-key semantics                                                                           */
/* -------------------------------------------------------------------------------------------- */

/** Every spelling of a sector, exactly — canonical names and aliases, no prefix matching. */
const SECTOR_TOKENS: ReadonlySet<string> = new Set(SECTOR_ALIASES.keys());

export interface SectorInsertion {
  readonly text: string;
  /** Where the caret ends up: after the inserted token and its trailing space. */
  readonly caret: number;
}

/**
 * A yellow key inserts its sector token after the typed ticker (FUNCTIONS §2.6).
 *
 * The three cases, in the order they are tested:
 *   * empty line → the token alone, so `F8` on a blank line leaves `Equity ` and the user types
 *     the ticker after it as on a real keyboard;
 *   * a line that already carries a sector token anywhere → that token is REPLACED, so `F2` on
 *     `AAPL US Equity DES` gives `AAPL US Govt DES` rather than a second, contradictory sector;
 *   * otherwise → appended, which for `AAPL` or `AAPL US` is "after the typed ticker".
 *
 * Case matters in the output and never in the input: the canonical spelling from core is written,
 * so `govt` typed by hand and `F2` produce the same `Govt` the parser resolves.
 */
export function insertSectorToken(text: string, sector: MarketSector): SectorInsertion {
  const parts = text.split(/(\s+)/).filter((p) => p !== '');
  const words: { index: number; word: string }[] = [];
  parts.forEach((part, index) => {
    if (!/^\s+$/.test(part)) words.push({ index, word: part });
  });

  if (words.length === 0) return { text: `${sector} `, caret: sector.length + 1 };

  for (let i = words.length - 1; i >= 0; i -= 1) {
    const entry = words[i];
    if (entry !== undefined && SECTOR_TOKENS.has(entry.word.toUpperCase())) {
      parts[entry.index] = sector;
      const next = parts.join('');
      const caret = parts.slice(0, entry.index + 1).join('').length;
      return { text: next, caret };
    }
  }

  const trimmed = text.replace(/\s+$/, '');
  const next = `${trimmed} ${sector} `;
  return { text: next, caret: next.length };
}

/** The sector a yellow key inserts, or `null` when the event is not a yellow key. */
export function sectorForKey(e: KeyEventLike): MarketSector | null {
  const hit = reservedFor(e);
  return hit !== null && hit.action === 'sector' ? (hit.sector ?? null) : null;
}
