// packages/web/src/keyboard/dispatcher.ts — the single window `keydown` listener (CLIENT.md §5.1,
// FUNCTIONS.md §2.6, TERM-06/TERM-07/TERM-09).
//
// One listener, one resolution order, one place to look when a key does the wrong thing. Widgets
// bind no key handlers of their own: they answer questions (`region()`, `commandText()`) and
// perform actions (`go()`, `popFrame()`), and this file decides which action a keystroke means.
//
// The resolution order is CLIENT §5.1 exactly — the first stage that handles the key wins:
//
//   1. the page lock screen (only `Enter`);
//   2. the focused panel's open overlay (its own map; `Escape` always closes it);
//   3. the reserved global keys (`keymap.ts`) — a function keymap cannot rebind these;
//   4. the focused region's map (grid, list, form, tabs, kv/text, chart, key bar);
//   5. the screen's `manifest.keymap` + `ScreenSpec.keymap` entries whose `when` matches;
//   6. typing-anywhere routing into the command line.
//
// AN OPEN OVERLAY IS OPAQUE (CLIENT §3.4). Stage 2 deliberately lets a key it does not claim fall
// through, so `Alt+2` still switches panel from under a picker — but the fall-through stops at the
// end of stage 3. Stages 4, 5 and 6 belong to the screen *behind* the dialog, and a screen keymap is
// mostly bare letters: 200 of the shipped manifests' bindings are a single character with
// `when:'always'`. Without the guard, typing "Range looks wrong" into a ticket's question box fires
// a dozen chart actions behind it and the dispatcher's own `preventDefault()` eats the characters.
// A dialog owns the screen while it is open; the keys it does not want do nothing, which is what
// "modal" means.
//
// Three behaviours in that list are what make the thing feel like a terminal rather than a web page,
// and all are easy to get subtly wrong:
//
// TYPING ANYWHERE (TERM-01/TERM-06). A printable key pressed while focus is on a grid, list, chart
// or the key bar is not lost and does not scroll anything: it focuses the panel's command line and
// lands in it. That is stage 6, which is LAST — so a screen that binds `G` to "open GP" keeps `G`
// (stage 5), and a form field keeps every character it is typed (`capturesTypedText`). The user
// never has to click, and never has to know where focus was.
//
// ESCAPE PRIORITY (§2.6). `Escape` is CANCEL and then MENU, a ladder rather than a handler: close
// the overlay → close autocomplete → clear the command draft → cancel an in-progress prompt or
// draw mode → revert the focused region's in-progress edit → pop the frame stack one step (MENU =
// the previous screen) → nothing to cancel, a footer hint. Each rung is asked of the host in order
// and the FIRST that applies consumes the key, so `Escape` over an autocomplete list never also
// throws away the screen behind it.
//
// The region rung is there because `Escape` is a RESERVED key, resolved at stage 3, so the focused
// region's own map at stage 4 is never reached by it. §5.3 gives a form field `Escape` = "revert
// this field to its last value"; without a rung the ladder would run straight past a half-typed
// swap and pop the frame stack, taking the whole screen — and the terms typed into it — with it.
//
// HELP (TERM-09) is STATE, not two handlers. `F1` explains the screen; `F1` again within 10 s, or
// while the HELP overlay is open, opens a ticket. Modelled as one timestamp and one transition
// function (`nextHelpEffect`), because two handlers that each decide whether they are "the second
// press" are two handlers that will one day disagree — and the disagreement is a support ticket
// opened by a user who wanted an explanation.

import type { KeyBinding, MarketSector } from '@terminal/core';

import type { FocusState, OverlayKind } from './focus.js';
import type { KeyEventLike, KeyRegion, ReservedBinding } from './keymap.js';
import { bindingApplies, isPrintable, matchesCombo, parseCombo, reservedFor } from './keymap.js';

/* -------------------------------------------------------------------------------------------- */
/* HELP: one press explains, two open a ticket (TERM-09)                                          */
/* -------------------------------------------------------------------------------------------- */

/** A second `F1` within this window is a ticket, not a second explanation (CLIENT §5.2). */
export const HELP_DOUBLE_PRESS_MS = 10_000;

export interface HelpState {
  /** When HELP was last asked for, or `null` when the next press is a first press. */
  readonly lastHelpAt: number | null;
}

export const initialHelpState: HelpState = { lastHelpAt: null };

/**
 * The one transition. `explain` opens the HELP overlay; `ticket` opens `TicketDialog`.
 *
 * `helpOpen` is the overlay state, so pressing `F1` on an already-open HELP is a ticket however
 * long it has been open — the user is looking at the explanation and is asking for something else.
 */
export function nextHelpEffect(
  state: HelpState,
  now: number,
  helpOpen: boolean,
): { state: HelpState; effect: 'explain' | 'ticket' } {
  const recent = state.lastHelpAt !== null && now - state.lastHelpAt <= HELP_DOUBLE_PRESS_MS;
  if (helpOpen || recent) return { state: { lastHelpAt: null }, effect: 'ticket' };
  return { state: { lastHelpAt: now }, effect: 'explain' };
}

/* -------------------------------------------------------------------------------------------- */
/* The port                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * What the dispatcher needs from the shell.
 *
 * It is a port, not an import: the stores (`state/panels.ts`), the command dispatcher
 * (`command/dispatch.ts`), the grid (WP-13) and the chart (WP-14) all land later and in other
 * hands, and the keyboard layer must not depend on any of them to be written or tested. The shell
 * implements this interface once, in `Shell.tsx`.
 */
export interface KeyboardHost {
  /** Epoch milliseconds; injected so HELP's 10 s window is testable without a wall clock. */
  now?(): number;

  // ── what is on screen ───────────────────────────────────────────────────────────────────────
  /** The page-level lock screen (CLIENT §5.1 stage 1). */
  isLocked(): boolean;
  /** The focused panel's open overlay, or `null`. */
  overlay(): OverlayKind | null;
  autocompleteOpen(): boolean;
  /** The focused panel's command-line text. */
  commandText(): string;
  /** An in-progress prompt or chart draw mode — the fourth rung of the CANCEL ladder. */
  hasPendingMode(): boolean;
  /** Is there a previous frame to go back to (MENU)? */
  canPopFrame(): boolean;
  /** The focused region (`focus.ts#regionOf`). */
  region(): KeyRegion;
  /** `manifest.keymap` merged with `ScreenSpec.keymap` for the focused panel. */
  screenBindings(): readonly KeyBinding[];
  /** Does the focused element swallow printable keys? (`focus.ts#capturesTypedText`) */
  capturesTypedText(): boolean;
  /** Does the focused function page server-side (`manifest.paging`)? */
  isPageable(): boolean;

  // ── stages that own their own maps ──────────────────────────────────────────────────────────
  /** The overlay's own key map; `true` when it consumed the key. */
  overlayKey(e: KeyboardEvent, overlay: OverlayKind): boolean;
  /**
   * The focused region's map (grid, list, form, tabs, kv, chart, key bar); `true` when consumed.
   *
   * Called at stage 4, and once more from the CANCEL ladder's `'field'` rung: `Escape` is a
   * reserved key and never reaches stage 4, so a region that owns an in-progress edit answers it
   * there instead. Return `true` only when the region really cancelled something — a `true` for an
   * `Escape` it ignored would eat MENU.
   */
  regionKey(e: KeyboardEvent, region: KeyRegion): boolean;
  /** The lock screen's `Enter`. */
  unlock(): void;

  // ── actions ─────────────────────────────────────────────────────────────────────────────────
  closeOverlay(): void;
  openHelp(): void;
  openTicket(): void;
  closeAutocomplete(): void;
  clearCommandDraft(): void;
  cancelPendingMode(): void;
  popFrame(): void;
  /** Nothing left to cancel: a footer hint, never a silent no-op (CLIENT §5.2). */
  cancelUnavailable(): void;
  /** GO: execute the selected autocomplete row, else `parse(text)[0]`. */
  go(): void;
  goNextPanel(): void;
  /** `Shift+Enter` on a grid or list row. */
  rowNextPanel(): void;
  /** A yellow key: insert the sector token after the typed ticker. */
  insertSector(sector: MarketSector): void;
  print(): void;
  exportGrid(): void;
  page(direction: 'fwd' | 'back'): void;
  /** A non-pageable screen scrolls one viewport instead. */
  scrollViewport(direction: 'fwd' | 'back'): void;
  frame(direction: 'back' | 'forward'): void;
  focusPanel(index: number): void;
  cyclePanel(direction: 1 | -1): void;
  moveRegion(direction: 1 | -1): void;
  provenance(): void;
  focusCommandLine(opts: { selectAll: boolean }): void;
  /** Typing anywhere: this character belongs in the command line (TERM-06). */
  typeIntoCommandLine(ch: string): void;
  /** A screen or manifest binding fired. */
  screenAction(action: string, binding: KeyBinding): void;
}

/* -------------------------------------------------------------------------------------------- */
/* The result                                                                                     */
/* -------------------------------------------------------------------------------------------- */

export type KeyStage =
  'lock' | 'overlay' | 'reserved' | 'region' | 'screen' | 'typing' | 'unhandled';

export interface KeyResolution {
  readonly handled: boolean;
  readonly stage: KeyStage;
  /** The reserved action, the screen binding's action id, or `'type'` for routed text. */
  readonly action?: string;
  /** The CANCEL rung that consumed `Escape`, for tests and for the footer hint. */
  readonly cancel?: CancelRung;
}

/**
 * The CANCEL ladder of FUNCTIONS §2.6 / CLIENT §5.2, in priority order.
 *
 * `'field'` is the focused region's own rung (CLIENT §5.3: `Escape` reverts a form field to its
 * last value). It sits below `'pending'` and above `'frame'`, so reverting an edit never also
 * navigates away from the screen the edit was on.
 */
export type CancelRung =
  'overlay' | 'autocomplete' | 'draft' | 'pending' | 'field' | 'frame' | 'none';

export interface Dispatcher {
  /** Resolve one `keydown`. Safe to call directly in a test; `attach` wires it to a target. */
  handleKeyDown(e: KeyboardEvent): KeyResolution;
  /** Install the single listener; returns the remover. */
  attach(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void;
  /** The HELP double-press state, for the status bar and for tests. */
  helpState(): HelpState;
  /** Forget the pending HELP press (a new frame painted, the panel changed). */
  resetHelp(): void;
}

export interface DispatcherOptions {
  /** `preventDefault()` on a handled key. Default true — the browser must not also act. */
  preventDefault?: boolean;
}

const unhandled: KeyResolution = { handled: false, stage: 'unhandled' };

/**
 * Regions where `Tab` is NOT the shell's region walk (CLIENT §5.2 L379, §5.3).
 *
 * A form owns `Tab`: §5.2 says so in as many words ("Inside a form: next/previous field — the form
 * owns Tab"), and the widget implements it the way the platform does, by putting its fields in
 * document order and letting the browser move between them. The reserved stage must therefore NOT
 * `preventDefault()` the key, or the second field of every form screen — OVML, SWPM, EQS, SRCH — is
 * unreachable from the keyboard.
 *
 * A dialog owns `Tab` too, because it traps it (`HelpOverlay#trapTab`). The trap runs on the
 * dialog's own element and stops propagation, so the dispatcher usually never sees the key; this is
 * the case where it does — a dialog with nothing focusable in it yet — and walking the regions of
 * the screen behind a modal is the one thing that must not happen.
 */
function ownsTab(region: KeyRegion): boolean {
  return region === 'form' || region === 'overlay';
}

/* -------------------------------------------------------------------------------------------- */
/* The dispatcher                                                                                 */
/* -------------------------------------------------------------------------------------------- */

export function createDispatcher(host: KeyboardHost, options: DispatcherOptions = {}): Dispatcher {
  const preventDefault = options.preventDefault ?? true;
  let help: HelpState = initialHelpState;

  const now = (): number => (host.now === undefined ? Date.now() : host.now());

  /**
   * The CANCEL ladder. Each rung is asked in order and the first that applies consumes the key,
   * so one `Escape` never dismantles two things at once.
   */
  const cancel = (e: KeyboardEvent): KeyResolution => {
    if (host.overlay() !== null) {
      host.closeOverlay();
      return { handled: true, stage: 'reserved', action: 'cancel', cancel: 'overlay' };
    }
    if (host.autocompleteOpen()) {
      host.closeAutocomplete();
      return { handled: true, stage: 'reserved', action: 'cancel', cancel: 'autocomplete' };
    }
    if (host.commandText() !== '') {
      host.clearCommandDraft();
      return { handled: true, stage: 'reserved', action: 'cancel', cancel: 'draft' };
    }
    if (host.hasPendingMode()) {
      host.cancelPendingMode();
      return { handled: true, stage: 'reserved', action: 'cancel', cancel: 'pending' };
    }
    // The focused region's rung. `Escape` is reserved, so stage 4 never sees it; a region that owns
    // an in-progress edit — a form field mid-type (CLIENT §5.3) — is asked here instead, and only a
    // region that says it consumed the key stops the ladder.
    const region = host.region();
    if (region !== 'command' && host.regionKey(e, region)) {
      return { handled: true, stage: 'reserved', action: 'cancel', cancel: 'field' };
    }
    if (host.canPopFrame()) {
      // MENU: back to the previous screen (FUNCTIONS §2.6).
      host.popFrame();
      return { handled: true, stage: 'reserved', action: 'cancel', cancel: 'frame' };
    }
    host.cancelUnavailable();
    return { handled: true, stage: 'reserved', action: 'cancel', cancel: 'none' };
  };

  /** Stage 3. `null` means "not handled here, try the next stage". */
  const reservedStage = (binding: ReservedBinding, e: KeyboardEvent): KeyResolution | null => {
    const region = host.region();
    switch (binding.action) {
      case 'go':
        // §2.6: inside a grid/list/form the node's own Enter applies first when the command line
        // is empty; with text in it, GO executes from any region (TERM-01).
        if (region !== 'command' && host.commandText() === '') return null;
        host.go();
        return { handled: true, stage: 'reserved', action: 'go' };
      case 'go-next-panel':
        host.goNextPanel();
        return { handled: true, stage: 'reserved', action: 'go-next-panel' };
      case 'row-next-panel':
        // Only a row has a "next panel" meaning; in the command line `Shift+Enter` is nothing.
        if (region === 'command') return null;
        host.rowNextPanel();
        return { handled: true, stage: 'reserved', action: 'row-next-panel' };
      case 'cancel':
        return cancel(e);
      case 'help': {
        const next = nextHelpEffect(help, now(), host.overlay() === 'help');
        help = next.state;
        if (next.effect === 'ticket') host.openTicket();
        else host.openHelp();
        return {
          handled: true,
          stage: 'reserved',
          action: next.effect === 'ticket' ? 'help-ticket' : 'help',
        };
      }
      case 'sector': {
        const sector = binding.sector;
        if (sector === undefined) return null;
        host.insertSector(sector);
        return { handled: true, stage: 'reserved', action: 'sector' };
      }
      case 'print':
        host.print();
        return { handled: true, stage: 'reserved', action: 'print' };
      case 'grid-export':
        host.exportGrid();
        return { handled: true, stage: 'reserved', action: 'grid-export' };
      case 'page-fwd':
      case 'page-back': {
        const direction = binding.action === 'page-fwd' ? 'fwd' : 'back';
        if (host.isPageable()) host.page(direction);
        else host.scrollViewport(direction);
        return { handled: true, stage: 'reserved', action: binding.action };
      }
      case 'frame-back':
        host.frame('back');
        return { handled: true, stage: 'reserved', action: 'frame-back' };
      case 'frame-forward':
        host.frame('forward');
        return { handled: true, stage: 'reserved', action: 'frame-forward' };
      case 'focus-panel': {
        const index = binding.panel;
        if (index === undefined) return null;
        host.focusPanel(index);
        return { handled: true, stage: 'reserved', action: 'focus-panel' };
      }
      case 'panel-next':
        host.cyclePanel(1);
        return { handled: true, stage: 'reserved', action: 'panel-next' };
      case 'panel-prev':
        host.cyclePanel(-1);
        return { handled: true, stage: 'reserved', action: 'panel-prev' };
      case 'region-next':
        // §4.1: with the autocomplete open, Tab COMPLETES the selected row rather than leaving
        // the command line. The command line's own map (stage 4) owns that case.
        if (region === 'command' && host.autocompleteOpen()) return null;
        if (ownsTab(region)) return null;
        host.moveRegion(1);
        return { handled: true, stage: 'reserved', action: 'region-next' };
      case 'region-prev':
        if (ownsTab(region)) return null;
        host.moveRegion(-1);
        return { handled: true, stage: 'reserved', action: 'region-prev' };
      case 'provenance':
        host.provenance();
        return { handled: true, stage: 'reserved', action: 'provenance' };
      case 'focus-command':
        host.focusCommandLine({ selectAll: true });
        return { handled: true, stage: 'reserved', action: 'focus-command' };
    }
  };

  /** Stage 5: the first screen binding whose combo and `when` both match. */
  const screenStage = (e: KeyEventLike, region: KeyRegion): KeyResolution | null => {
    for (const binding of host.screenBindings()) {
      if (!bindingApplies(binding, region)) continue;
      if (!matchesCombo(e, parseCombo(binding.key))) continue;
      host.screenAction(binding.action, binding);
      return { handled: true, stage: 'screen', action: binding.action };
    }
    return null;
  };

  const resolve = (e: KeyboardEvent): KeyResolution => {
    // ── 1. the lock screen ────────────────────────────────────────────────────────────────────
    if (host.isLocked()) {
      if (e.key === 'Enter') {
        host.unlock();
        return { handled: true, stage: 'lock', action: 'unlock' };
      }
      return { handled: false, stage: 'lock' };
    }

    const binding = reservedFor(e);
    const overlay = host.overlay();

    // ── 2. the open overlay ───────────────────────────────────────────────────────────────────
    // HELP is the one key that passes through an open overlay: F1 over HELP is the ticket
    // (TERM-09), and an overlay that swallowed it would make the second press unreachable.
    if (overlay !== null && binding?.action !== 'help') {
      if (binding?.action === 'cancel') {
        host.closeOverlay();
        return { handled: true, stage: 'overlay', action: 'cancel', cancel: 'overlay' };
      }
      if (host.overlayKey(e, overlay)) return { handled: true, stage: 'overlay' };
      // An unhandled key falls through: Alt+2 still switches panel from under a picker.
    }

    // ── 3. the reserved global keys ───────────────────────────────────────────────────────────
    if (binding !== null) {
      const handled = reservedStage(binding, e);
      if (handled !== null) return handled;
    }

    // The fall-through from stage 2 ends here. Stages 4, 5 and 6 are the screen BEHIND the dialog,
    // and an open overlay is opaque to them (CLIENT §3.4): the screen's keymap must not fire on the
    // letters being typed into a ticket, and a key this dispatcher does not claim must reach the
    // dialog's own fields un-`preventDefault()`ed.
    if (overlay !== null) return unhandled;

    const region = host.region();

    // ── 4. the focused region's own map ───────────────────────────────────────────────────────
    // Including the command line's (CLIENT §5.1 stage 4, §4.1): history recall on the arrows,
    // completion on Tab. A key the region does not claim falls through, so an ordinary character
    // still reaches the focused <input> the way the browser would deliver it.
    if (host.regionKey(e, region)) {
      return { handled: true, stage: 'region' };
    }

    // ── 5. the screen's keymap ────────────────────────────────────────────────────────────────
    const screen = screenStage(e, region);
    if (screen !== null) return screen;

    // ── 6. typing anywhere (TERM-06) ──────────────────────────────────────────────────────────
    // A printable key lands in the command line wherever focus is — except in the command line
    // itself, where the input already has it, and except where the focused thing is text: a form
    // field, the MSG composer, a prompt dialog.
    // (An open overlay never reaches here at all: it returned above.)
    if (region !== 'command' && isPrintable(e) && !host.capturesTypedText()) {
      host.focusCommandLine({ selectAll: false });
      host.typeIntoCommandLine(e.key);
      return { handled: true, stage: 'typing', action: 'type' };
    }

    return unhandled;
  };

  const handleKeyDown = (e: KeyboardEvent): KeyResolution => {
    const result = resolve(e);
    if (result.handled && preventDefault) e.preventDefault();
    return result;
  };

  return {
    handleKeyDown,
    attach(target) {
      const listener = (event: Event): void => {
        handleKeyDown(event as KeyboardEvent);
      };
      target.addEventListener('keydown', listener);
      return () => {
        target.removeEventListener('keydown', listener);
      };
    },
    helpState: () => help,
    resetHelp() {
      help = initialHelpState;
    },
  };
}

/** Re-exported so the shell can type its focus wiring without importing two modules. */
export type { FocusState };
