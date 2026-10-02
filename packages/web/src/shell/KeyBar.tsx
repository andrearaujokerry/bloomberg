// packages/web/src/shell/KeyBar.tsx — the on-screen action keys (CLIENT.md §3.3 L266-270).
//
// One row above the status bar: `GO CANCEL MENU HELP PRINT PG▲ PG▼` and the ten yellow sector keys
// `GOVT CORP MTGE M-MKT MUNI PFD EQUITY COMDTY INDEX CURNCY`.
//
// ## Why it is not decoration
//
// CLIENT §5 L348 says every binding has an on-screen equivalent, and §18.6 Q6 names this bar THE
// GUARANTEED PATH for `F11` (Curncy), which macOS Chrome does not surrender to a page. For fifteen
// packages this file did not exist, so `F11` had no reachable binding at all and `MENU` had no path
// other than the key the browser might also swallow. `TRACEABILITY.md`'s TERM-07 row recorded the
// gap: "the key bar was never written, so there is no on-screen equivalent either".
//
// ## The one decision in here
//
// **A button presses the key.** `onKey` hands a `KeyboardEventInit` to the same
// `dispatcher.handleKeyDown` the window listener calls, so a button and its key are not two
// implementations of one action that can drift — the button IS the key, resolved by the one ladder in
// `keyboard/dispatcher.ts`. That matters most for the two names Escape carries: `CANCEL` is the ladder
// (close overlay → close autocomplete → clear the draft → cancel a pending mode) and `MENU` is its last
// rung, popping the frame stack, and which one a press means depends on what is open. A bar that called
// `popFrame()` for `MENU` directly would pop the frame out from under an open overlay. So `MENU` sends
// `Escape` too, and the ladder decides — the button is labelled for what it does when there is nothing
// else to cancel, which is what §5.2's own table calls it.
//
// `Alt+ArrowLeft` is NOT here even though it is reserved: the frame stack already has its visible
// back/forward buttons in every panel header (`Panel.tsx`), and a second pair of them in a global bar
// would act on the focused panel while looking global.
//
// Arithmetic: none. IO: none. The bar reads two settings and emits keystrokes.

import { useCallback } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';

import { MARKET_SECTORS, yellowKeyForSector } from '@terminal/core';
import type { MarketSector } from '@terminal/core';

import { keyBarVisible, useSettingsStore } from '../state/settings.js';

/* ---------------------------------------------------------------------------------------------- */
/* The buttons                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/** One action button: its label, the keystroke it sends, and what it does, for the tooltip. */
interface ActionKey {
  readonly id: string;
  readonly label: string;
  /** How §5.2 writes the key, for the title attribute — the user is being taught the keyboard. */
  readonly keyName: string;
  readonly init: KeyboardEventInit;
  readonly title: string;
}

/**
 * The seven reserved actions §3.3 lists, in its order.
 *
 * `GO` is `Enter` and is included even though the command line owns `Enter` at the element: a desk that
 * has typed a command and then clicked into a grid still has a visible way to run it (TERM-01 — "when
 * the command line has text, GO executes it from any region").
 */
const ACTION_KEYS: readonly ActionKey[] = Object.freeze([
  {
    id: 'go',
    label: 'GO',
    keyName: 'Enter',
    init: { key: 'Enter' },
    title: 'GO — run the command line (Enter)',
  },
  {
    id: 'cancel',
    label: 'CANCEL',
    keyName: 'Escape',
    init: { key: 'Escape' },
    title: 'CANCEL — close an overlay, then the autocomplete, then clear the draft (Escape)',
  },
  {
    id: 'menu',
    label: 'MENU',
    keyName: 'Escape',
    init: { key: 'Escape' },
    title: 'MENU — the previous screen, once there is nothing left to cancel (Escape)',
  },
  {
    id: 'help',
    label: 'HELP',
    keyName: 'F1',
    init: { key: 'F1' },
    title: 'HELP — help for this function; twice within ten seconds opens a ticket (F1)',
  },
  {
    id: 'print',
    label: 'PRINT',
    keyName: 'Ctrl+P',
    init: { key: 'p', ctrlKey: true },
    title: "PRINT — export the focused panel's result as CSV (Ctrl+P)",
  },
  {
    id: 'page-back',
    label: 'PG▲',
    keyName: 'PageUp',
    init: { key: 'PageUp' },
    title: 'PAGE BACK — the previous page, or one viewport up (PageUp)',
  },
  {
    id: 'page-fwd',
    label: 'PG▼',
    keyName: 'PageDown',
    init: { key: 'PageDown' },
    title: 'PAGE FWD — the next page, or one viewport down (PageDown)',
  },
] satisfies ActionKey[]);

/**
 * The ten sectors that have a yellow key, in `F2`..`F11` order.
 *
 * Derived from `yellowKeyForSector` rather than listed, so the bar cannot disagree with the table the
 * dispatcher matches against. `Crypto` answers `null` there — it has no yellow key — and is therefore
 * absent here, which is the same reason it is absent from the keyboard.
 */
const YELLOW_KEYS: readonly { sector: MarketSector; fKey: string }[] = Object.freeze(
  MARKET_SECTORS.flatMap((sector) => {
    const fKey = yellowKeyForSector(sector);
    return fKey === null ? [] : [{ sector, fKey }];
  }).sort((a, b) => Number(a.fKey.slice(1)) - Number(b.fKey.slice(1))),
);

/* ---------------------------------------------------------------------------------------------- */
/* Props                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

export interface KeyBarProps {
  /**
   * Send a keystroke to the window dispatcher — `App.tsx` passes `dispatcher.handleKeyDown` wrapped.
   *
   * A keystroke and not an action id, deliberately: see the header. The bar is a keyboard.
   */
  readonly onKey: (init: KeyboardEventInit) => void;
}

/* ---------------------------------------------------------------------------------------------- */
/* Styles                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

const S = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: '1ch',
    minHeight: 'var(--row-px)',
    padding: '0 1ch',
    background: 'var(--c-bg-header)',
    borderTop: '1px solid var(--c-grid-line)',
    whiteSpace: 'nowrap',
    overflowX: 'auto',
  },
  group: { display: 'flex', alignItems: 'center', gap: '1ch' },
  spacer: { flex: '1 1 auto', minWidth: '1ch' },
  button: {
    font: 'inherit',
    lineHeight: 1,
    color: 'var(--c-value)',
    background: 'var(--c-bg-panel)',
    border: '1px solid var(--c-grid-line)',
    padding: '0 1ch',
    cursor: 'pointer',
  },
  // The yellow keys are yellow. `--c-label` is the terminal amber, defined in both themes, and is the
  // same token the field labels use — there is no second palette here.
  yellow: {
    font: 'inherit',
    lineHeight: 1,
    color: 'var(--c-label)',
    background: 'var(--c-bg-panel)',
    border: '1px solid var(--c-label)',
    padding: '0 1ch',
    cursor: 'pointer',
  },
} satisfies Record<string, CSSProperties>;

/* ---------------------------------------------------------------------------------------------- */
/* The bar                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `KeyBar` — visible per `settings.keybar` and the density (`keyBarVisible`, CLIENT §3.3).
 *
 * §3.3: "hidden in density `compact` unless `/keybar on`". The setting is three-state and defaults to
 * `'auto'`, so the bar is on a normal desk without anybody asking for it, off on a compact one, and
 * `/keybar on` is the escape hatch — without which a compact desk would have no way to reach `F11` at
 * all, which is the gap this file closes.
 */
export function KeyBar({ onKey }: KeyBarProps): ReactElement | null {
  const keybar = useSettingsStore((s) => s.keybar);
  const density = useSettingsStore((s) => s.density);

  /**
   * `ArrowLeft` / `ArrowRight` walk the bar, and the bar is ONE tab stop.
   *
   * `keyboard/focus.ts`' ring is `command line → nodes in document order → key bar → command line`:
   * one entry for the whole bar, not one per button. So the buttons carry `tabIndex={-1}` except the
   * first, and the arrows move between them — the toolbar pattern, and the one that keeps `Tab` meaning
   * what §5.2's table says it means. `preventDefault` is what tells the window listener the key was
   * consumed here (`App.tsx`: "the element wins").
   */
  const onArrows = useCallback((e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const direction = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (direction === 0) return;
    const bar = e.currentTarget;
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button')];
    if (buttons.length === 0) return;
    const at = buttons.findIndex((b) => b === globalThis.document?.activeElement);
    const next = buttons[(Math.max(0, at) + direction + buttons.length) % buttons.length];
    if (next === undefined) return;
    e.preventDefault();
    for (const b of buttons) b.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  }, []);

  if (!keyBarVisible(keybar, density)) return null;

  return (
    <div
      style={S.bar}
      role="toolbar"
      aria-label="Key bar"
      data-testid="key-bar"
      onKeyDown={onArrows}
    >
      <div style={S.group}>
        {ACTION_KEYS.map((action, i) => (
          <button
            key={action.id}
            type="button"
            style={S.button}
            tabIndex={i === 0 ? 0 : -1}
            title={action.title}
            data-keybar-action={action.id}
            onClick={() => onKey(action.init)}
          >
            {action.label}
          </button>
        ))}
      </div>
      <div style={S.spacer} />
      <div style={S.group}>
        {YELLOW_KEYS.map(({ sector, fKey }) => (
          <button
            key={sector}
            type="button"
            style={S.yellow}
            tabIndex={-1}
            title={`${sector} — insert the sector token (${fKey})`}
            data-keybar-sector={sector}
            onClick={() => onKey({ key: fKey })}
          >
            {sector.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

export default KeyBar;
