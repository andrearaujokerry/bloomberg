// packages/web/test/keyboard/keymap.test.ts — WP-12 acceptance row (WORKPLAN L1404):
// "reserved keys, Escape priority, yellow keys, typing-anywhere routing".
//
// The keyboard is the product. Every assertion below is driven through
// `@testing-library/user-event` against a real jsdom document with the real dispatcher attached to
// `window`, because the bugs worth catching here are not in the table — they are in the order the
// stages run in, and in what a key does when two things are open at once.
//
// The host is a recording double that MUTATES its own state: `closeOverlay()` really closes the
// overlay, `clearCommandDraft()` really empties the input. That is what lets five consecutive
// `Escape` presses assert the whole CANCEL ladder in the order §2.6 states it, rather than five
// independent presses that each assert one rung with the others switched off.

import { beforeEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';

import type { KeyBinding, MarketSector } from '@terminal/core';

import {
  createDispatcher,
  HELP_DOUBLE_PRESS_MS,
  type CancelRung,
  type Dispatcher,
  type KeyboardHost,
  type KeyResolution,
} from '../../src/keyboard/dispatcher.js';
import {
  RESERVED_KEYS,
  YELLOW_KEYS,
  bindingApplies,
  insertSectorToken,
  isPrintable,
  isReservedKey,
  matchesKey,
  parseCombo,
  reservedConflicts,
  reservedFor,
  type KeyRegion,
} from '../../src/keyboard/keymap.js';
import {
  capturesTypedText,
  collectFocusNodes,
  createFocusState,
  closeOverlay as closeFocusOverlay,
  enterPanel,
  focusNode,
  nextRegion,
  nodeTabIndex,
  openOverlay as openFocusOverlay,
  paint,
  regionOf,
} from '../../src/keyboard/focus.js';
import type { Node } from '../../src/screen/types.js';

/* -------------------------------------------------------------------------------------------- */
/* The harness                                                                                    */
/* -------------------------------------------------------------------------------------------- */

interface HostState {
  locked: boolean;
  overlay: 'help' | 'ticket' | 'prompt' | 'provenance' | 'picker' | 'lock' | null;
  autocomplete: boolean;
  pendingMode: boolean;
  frames: number;
  region: KeyRegion;
  bindings: KeyBinding[];
  capturesText: boolean;
  pageable: boolean;
  /** `true` when the focused region answers Enter itself (a grid row command). */
  regionHandlesEnter: boolean;
  /** `true` when the command line's own map answers Tab (an open autocomplete completes). */
  completeOnTab: boolean;
  /** `true` when the focused region answers Escape itself (a form field reverting, CLIENT §5.3). */
  regionHandlesEscape: boolean;
  now: number;
}

interface Harness {
  readonly state: HostState;
  readonly calls: string[];
  readonly host: KeyboardHost;
  readonly dispatcher: Dispatcher;
  readonly input: HTMLInputElement;
  readonly grid: HTMLDivElement;
  readonly detach: () => void;
}

function harness(initial: Partial<HostState> = {}): Harness {
  const state: HostState = {
    locked: false,
    overlay: null,
    autocomplete: false,
    pendingMode: false,
    frames: 0,
    region: 'command',
    bindings: [],
    capturesText: false,
    pageable: false,
    regionHandlesEnter: false,
    completeOnTab: false,
    regionHandlesEscape: false,
    now: 1_000_000,
    ...initial,
  };
  const calls: string[] = [];
  const record = (name: string, detail?: string): void => {
    calls.push(detail === undefined ? name : `${name}:${detail}`);
  };

  document.body.innerHTML = '';
  const input = document.createElement('input');
  input.setAttribute('aria-label', 'command line');
  const grid = document.createElement('div');
  grid.tabIndex = 0;
  grid.setAttribute('role', 'grid');
  document.body.append(input, grid);

  const host: KeyboardHost = {
    now: () => state.now,
    isLocked: () => state.locked,
    overlay: () => state.overlay,
    autocompleteOpen: () => state.autocomplete,
    commandText: () => input.value,
    hasPendingMode: () => state.pendingMode,
    canPopFrame: () => state.frames > 0,
    region: () => state.region,
    screenBindings: () => state.bindings,
    capturesTypedText: () => state.capturesText,
    isPageable: () => state.pageable,

    overlayKey: (e, overlay) => {
      record('overlayKey', `${overlay}/${e.key}`);
      return false;
    },
    regionKey: (e, region) => {
      if (e.key === 'Enter' && state.regionHandlesEnter) {
        record('regionEnter', region);
        return true;
      }
      if (e.key === 'Tab' && region === 'command' && state.completeOnTab) {
        record('complete');
        return true;
      }
      if (e.key === 'Escape' && state.regionHandlesEscape) {
        // A field reverts once: after it has, there is nothing left for the next Escape to undo,
        // so the ladder must be able to carry on past this rung.
        state.regionHandlesEscape = false;
        record('regionEscape', region);
        return true;
      }
      return false;
    },
    unlock: () => {
      state.locked = false;
      record('unlock');
    },

    closeOverlay: () => {
      record('closeOverlay', state.overlay ?? 'none');
      state.overlay = null;
    },
    openHelp: () => {
      state.overlay = 'help';
      record('openHelp');
    },
    openTicket: () => {
      state.overlay = 'ticket';
      record('openTicket');
    },
    closeAutocomplete: () => {
      state.autocomplete = false;
      record('closeAutocomplete');
    },
    clearCommandDraft: () => {
      input.value = '';
      record('clearCommandDraft');
    },
    cancelPendingMode: () => {
      state.pendingMode = false;
      record('cancelPendingMode');
    },
    popFrame: () => {
      state.frames -= 1;
      record('popFrame');
    },
    cancelUnavailable: () => {
      record('cancelUnavailable');
    },
    go: () => {
      record('go', input.value);
    },
    goNextPanel: () => {
      record('goNextPanel', input.value);
    },
    rowNextPanel: () => {
      record('rowNextPanel');
    },
    insertSector: (sector: MarketSector) => {
      const next = insertSectorToken(input.value, sector);
      input.value = next.text;
      record('insertSector', sector);
    },
    print: () => {
      record('print');
    },
    exportGrid: () => {
      record('exportGrid');
    },
    page: (direction) => {
      record('page', direction);
    },
    scrollViewport: (direction) => {
      record('scrollViewport', direction);
    },
    frame: (direction) => {
      record('frame', direction);
    },
    focusPanel: (index) => {
      record('focusPanel', String(index));
    },
    cyclePanel: (direction) => {
      record('cyclePanel', String(direction));
    },
    moveRegion: (direction) => {
      record('moveRegion', String(direction));
    },
    provenance: () => {
      record('provenance');
    },
    focusCommandLine: ({ selectAll }) => {
      state.region = 'command';
      input.focus();
      if (selectAll) input.select();
      record('focusCommandLine', String(selectAll));
    },
    typeIntoCommandLine: (ch) => {
      input.value += ch;
      record('type', ch);
    },
    screenAction: (action) => {
      record('screenAction', action);
    },
  };

  const dispatcher = createDispatcher(host);
  const detach = dispatcher.attach(window);
  return { state, calls, host, dispatcher, input, grid, detach };
}

/** Focus the grid element and tell the host the focused region is a grid. */
function focusGrid(h: Harness): void {
  h.grid.focus();
  h.state.region = 'grid';
}

/**
 * Dispatch one real, cancelable `keydown` and report both what the dispatcher decided and whether
 * the browser's own default survived.
 *
 * `defaultPrevented` is half the assertion in this file: a key the dispatcher "does not handle" but
 * `preventDefault()`s anyway never reaches the field, the form's tab order or the dialog, and the
 * user sees a dead keyboard with nothing in the call log to explain it.
 */
function press(
  name: string,
  code: string = name,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): { resolution: KeyResolution; defaultPrevented: boolean } {
  const event = new KeyboardEvent('keydown', {
    key: name,
    code,
    bubbles: true,
    cancelable: true,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  });
  const resolution = h.dispatcher.handleKeyDown(event);
  return { resolution, defaultPrevented: event.defaultPrevented };
}

let h: Harness;

beforeEach(() => {
  h = harness();
  return () => {
    h.detach();
  };
});

/* -------------------------------------------------------------------------------------------- */
/* 1. The reserved key table (FUNCTIONS.md §2.6 L790-812)                                          */
/* -------------------------------------------------------------------------------------------- */

describe('reserved keys', () => {
  it('binds every row of the §2.6 table to its action', () => {
    const table = new Map(RESERVED_KEYS.map((b) => [b.key, b.action]));
    expect(table.get('Enter')).toBe('go');
    expect(table.get('Escape')).toBe('cancel');
    expect(table.get('F1')).toBe('help');
    expect(table.get('Ctrl+P')).toBe('print');
    expect(table.get('Ctrl+E')).toBe('grid-export');
    expect(table.get('PageDown')).toBe('page-fwd');
    expect(table.get('PageUp')).toBe('page-back');
    expect(table.get('Alt+ArrowLeft')).toBe('frame-back');
    expect(table.get('Alt+ArrowRight')).toBe('frame-forward');
    expect(table.get('Ctrl+Tab')).toBe('panel-next');
    expect(table.get('Ctrl+Shift+Tab')).toBe('panel-prev');
    expect(table.get('Tab')).toBe('region-next');
    expect(table.get('Shift+Tab')).toBe('region-prev');
    expect(table.get('Ctrl+I')).toBe('provenance');
    expect(table.get('Ctrl+L')).toBe('focus-command');
    expect(table.get('Ctrl+Enter')).toBe('go-next-panel');
    expect(table.get('Shift+Enter')).toBe('row-next-panel');
    for (let n = 1; n <= 8; n += 1) {
      expect(table.get(`Alt+${String(n)}`)).toBe('focus-panel');
    }
  });

  it('matches on the physical key, so Ctrl+P is PRINT on any layout', async () => {
    const user = userEvent.setup();
    h.input.focus();
    await user.keyboard('{Control>}p{/Control}');
    expect(h.calls).toEqual(['print']);
  });

  it('routes PAGE keys to the pager on a pageable function and to the scroller otherwise', async () => {
    const user = userEvent.setup();
    focusGrid(h);
    h.state.pageable = true;
    await user.keyboard('{PageDown}{PageUp}');
    h.state.pageable = false;
    await user.keyboard('{PageDown}');
    expect(h.calls).toEqual(['page:fwd', 'page:back', 'scrollViewport:fwd']);
  });

  it('walks panels, frames and focus regions', async () => {
    const user = userEvent.setup();
    focusGrid(h);
    await user.keyboard('{Alt>}{ArrowLeft}{ArrowRight}3{/Alt}');
    await user.keyboard('{Control>}{Tab}{/Control}');
    await user.keyboard('{Control>}{Shift>}{Tab}{/Shift}{/Control}');
    await user.keyboard('{Tab}{Shift>}{Tab}{/Shift}');
    await user.keyboard('{Control>}i{/Control}');
    await user.keyboard('{Control>}l{/Control}');
    expect(h.calls).toEqual([
      'frame:back',
      'frame:forward',
      'focusPanel:3',
      'cyclePanel:1',
      'cyclePanel:-1',
      'moveRegion:1',
      'moveRegion:-1',
      'provenance',
      'focusCommandLine:true',
    ]);
  });

  it('gives Enter to the node when the command line is empty, and to GO when it is not', async () => {
    const user = userEvent.setup();
    focusGrid(h);
    h.state.regionHandlesEnter = true;

    await user.keyboard('{Enter}');
    expect(h.calls).toEqual(['regionEnter:grid']);

    // With text in the command line, GO executes it from any region (TERM-01, §5.2).
    h.input.value = 'AAPL US Equity DES';
    await user.keyboard('{Enter}');
    expect(h.calls).toEqual(['regionEnter:grid', 'go:AAPL US Equity DES']);
  });

  it('cannot be rebound by a function keymap: the reserved stage resolves first', async () => {
    const user = userEvent.setup();
    focusGrid(h);
    h.state.bindings = [
      { key: 'Ctrl+P', action: 'screen-print', when: 'always', description: 'not allowed' },
    ];
    await user.keyboard('{Control>}p{/Control}');
    expect(h.calls).toEqual(['print']);
    expect(h.calls).not.toContain('screenAction:screen-print');
    expect(isReservedKey('Ctrl+P')).toBe(true);
    expect(reservedConflicts(h.state.bindings)).toHaveLength(1);
  });

  it('leaves a non-reserved screen binding to the screen', async () => {
    const user = userEvent.setup();
    focusGrid(h);
    h.state.bindings = [
      { key: 'G', action: 'open-gp', when: 'always', description: 'Price graph (GP)' },
      { key: 'Shift+G', action: 'open-gp-next', when: 'always', description: 'GP next panel' },
    ];
    await user.keyboard('g');
    await user.keyboard('{Shift>}G{/Shift}');
    expect(h.calls).toEqual(['screenAction:open-gp', 'screenAction:open-gp-next']);
    // Rule 5 of §5.1: a printable letter bound by the screen is NOT routed to the command line.
    expect(h.input.value).toBe('');
  });

  it('leaves Tab to the command line while the autocomplete is open (§4.1 completion)', async () => {
    const user = userEvent.setup();
    h.input.focus();
    h.input.value = 'AAP';
    h.state.autocomplete = true;
    h.state.completeOnTab = true;

    await user.keyboard('{Tab}');
    expect(h.calls).toEqual(['complete']);
    expect(h.calls).not.toContain('moveRegion:1');

    // Closed again, Tab is the reserved key: leave the command line.
    h.state.autocomplete = false;
    h.state.completeOnTab = false;
    await user.keyboard('{Tab}');
    expect(h.calls).toEqual(['complete', 'moveRegion:1']);
  });

  it('leaves Tab to the form, which owns its own field order (§5.2, §5.3)', async () => {
    const user = userEvent.setup();
    const f1 = document.createElement('input');
    f1.id = 'f1-notional';
    const f2 = document.createElement('input');
    f2.id = 'f2-tenor';
    document.body.append(f1, f2);
    f1.focus();
    h.state.region = 'form';

    // The Form widget binds no Tab handler: its fields are in document order and the browser moves
    // between them. A reserved-stage `moveRegion` + `preventDefault()` here makes the second field
    // of every form screen (OVML, SWPM, EQS, SRCH) unreachable from the keyboard.
    await user.keyboard('{Tab}');
    expect(h.calls).toEqual([]);
    expect(document.activeElement?.id).toBe('f2-tenor');

    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(h.calls).toEqual([]);
    expect(document.activeElement?.id).toBe('f1-notional');

    // Nothing was swallowed on the way: the dispatcher left the default alone in both directions.
    expect(press('Tab').defaultPrevented).toBe(false);
    expect(press('Tab', 'Tab', { shift: true }).defaultPrevented).toBe(false);

    // Outside a form Tab is still the shell's region walk.
    h.state.region = 'grid';
    await user.keyboard('{Tab}');
    expect(h.calls).toEqual(['moveRegion:1']);
  });

  it('never fires on a Meta-modified key, which belongs to the browser', () => {
    const e = {
      key: 'p',
      code: 'KeyP',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: true,
    };
    expect(reservedFor(e)).toBeNull();
    expect(matchesKey(e, 'Ctrl+P')).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 2. HELP: once explains, twice tickets (TERM-09)                                                 */
/* -------------------------------------------------------------------------------------------- */

describe('HELP', () => {
  it('explains once and opens a ticket on the second press within 10 s', async () => {
    const user = userEvent.setup();
    h.input.focus();

    await user.keyboard('{F1}');
    expect(h.calls).toEqual(['openHelp']);

    // Still open: the second press is the ticket however long it has been open.
    h.state.now += 30_000;
    await user.keyboard('{F1}');
    expect(h.calls).toEqual(['openHelp', 'openTicket']);
  });

  it('explains again when the second press is late', async () => {
    const user = userEvent.setup();
    h.input.focus();

    await user.keyboard('{F1}');
    h.state.overlay = null; // the user closed it
    h.state.now += HELP_DOUBLE_PRESS_MS + 1;
    await user.keyboard('{F1}');
    expect(h.calls).toEqual(['openHelp', 'openHelp']);
  });

  it('tickets on the second press inside the window', async () => {
    const user = userEvent.setup();
    h.input.focus();

    await user.keyboard('{F1}');
    h.state.overlay = null;
    h.state.now += HELP_DOUBLE_PRESS_MS - 1;
    await user.keyboard('{F1}');
    expect(h.calls).toEqual(['openHelp', 'openTicket']);
    // One state, one transition: after a ticket the next press explains again.
    h.state.overlay = null;
    await user.keyboard('{F1}');
    expect(h.calls).toEqual(['openHelp', 'openTicket', 'openHelp']);
  });

  it('reaches HELP through an open overlay, which is what makes the second press possible', async () => {
    const user = userEvent.setup();
    h.state.overlay = 'picker';
    h.input.focus();
    await user.keyboard('{F1}');
    expect(h.calls).toEqual(['openHelp']);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 2b. An open overlay is opaque to the screen behind it (CLIENT §3.4, §5.1)                       */
/* -------------------------------------------------------------------------------------------- */

describe('an open overlay', () => {
  const CHART_KEYS: KeyBinding[] = [
    { key: 'R', action: 'cycle-range', when: 'always', description: 'Cycle range' },
    { key: 'W', action: 'toggle-log', when: 'always', description: 'Log scale' },
    { key: 'K', action: 'toggle-events', when: 'always', description: 'Events' },
  ];

  it('does not let the screen keymap fire on text typed into a dialog', async () => {
    const user = userEvent.setup();
    h.state.bindings = CHART_KEYS;

    // The control: with no dialog up, these are exactly the bare-letter bindings a GP screen ships,
    // and they fire. 200 of the shipped manifests' bindings have this shape.
    focusGrid(h);
    await user.keyboard('r');
    expect(h.calls).toEqual(['screenAction:cycle-range']);

    // Now open the ticket dialog over it and type the complaint into its question box.
    const question = document.createElement('textarea');
    document.body.append(question);
    question.focus();
    h.state.overlay = 'ticket';
    h.state.region = 'overlay';
    h.calls.length = 0;

    await user.keyboard('Range looks wrong');

    expect(h.calls.filter((c) => c.startsWith('screenAction'))).toEqual([]);
    // And because nothing was `preventDefault()`ed, every character reached the field.
    expect(question.value).toBe('Range looks wrong');
  });

  it('stops the stage-2 fall-through at the end of stage 3', () => {
    h.state.bindings = CHART_KEYS;
    h.state.overlay = 'help';
    h.state.region = 'overlay';

    const letter = press('r', 'KeyR');
    expect(letter.resolution.stage).not.toBe('screen');
    expect(letter.resolution.stage).toBe('unhandled');
    expect(letter.defaultPrevented).toBe(false);
    expect(h.calls).toEqual(['overlayKey:help/r']);

    // Tab under a dialog is the dialog's (it traps it); it is never the region walk of the screen
    // the dialog is covering.
    h.calls.length = 0;
    expect(press('Tab').defaultPrevented).toBe(false);
    expect(h.calls).toEqual(['overlayKey:help/Tab']);

    // Enter likewise reaches the dialog's own button rather than GO or a row command.
    h.calls.length = 0;
    expect(press('Enter').defaultPrevented).toBe(false);
    expect(h.calls).toEqual(['overlayKey:help/Enter']);
  });

  it('still lets the reserved globals through, which is what stage 2 falls through FOR', async () => {
    const user = userEvent.setup();
    h.state.bindings = CHART_KEYS;
    h.state.overlay = 'picker';
    h.state.region = 'overlay';

    await user.keyboard('{Alt>}2{/Alt}');
    await user.keyboard('{Control>}p{/Control}');
    expect(h.calls.filter((c) => !c.startsWith('overlayKey'))).toEqual(['focusPanel:2', 'print']);
  });

  it('is not advertised in the footer either: no screen binding applies to `overlay`', () => {
    for (const binding of CHART_KEYS) {
      expect(bindingApplies(binding, 'overlay')).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 3. Escape priority — the CANCEL → MENU ladder (§2.6, CLIENT §5.2)                               */
/* -------------------------------------------------------------------------------------------- */

describe('Escape priority', () => {
  it('descends the ladder one rung per press, in order', async () => {
    const user = userEvent.setup();
    h.state.overlay = 'provenance';
    h.state.autocomplete = true;
    h.state.pendingMode = true;
    h.state.frames = 1;
    h.input.value = 'AAPL US Equity D';
    h.input.focus();

    await user.keyboard('{Escape}{Escape}{Escape}{Escape}{Escape}{Escape}');

    expect(h.calls).toEqual([
      'closeOverlay:provenance',
      'closeAutocomplete',
      'clearCommandDraft',
      'cancelPendingMode',
      'popFrame',
      'cancelUnavailable',
    ]);
    expect(h.input.value).toBe('');
    expect(h.state.frames).toBe(0);
  });

  it('reports the rung that consumed the key', () => {
    h.state.autocomplete = true;
    h.input.value = 'AAP';
    const press = (): CancelRung | undefined =>
      h.dispatcher.handleKeyDown(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
      ).cancel;

    expect(press()).toBe('autocomplete');
    expect(press()).toBe('draft');
    expect(press()).toBe('none');
  });

  it('closes only the overlay when an overlay is open over a filled command line', async () => {
    const user = userEvent.setup();
    h.state.overlay = 'help';
    h.input.value = 'AAPL US Equity';
    h.input.focus();

    await user.keyboard('{Escape}');
    expect(h.calls).toEqual(['closeOverlay:help']);
    expect(h.input.value).toBe('AAPL US Equity');
  });

  it('gives the focused region a rung before the frame stack (§5.3: revert the field)', () => {
    h.state.region = 'form';
    h.state.regionHandlesEscape = true;
    h.state.frames = 2;

    // Escape is reserved, so the form's own map at stage 4 never sees it. The ladder asks the
    // region instead — otherwise a half-typed swap is answered by navigating away from the screen
    // it was being typed on, and the terms go with it.
    const reverted = press('Escape');
    expect(reverted.resolution.cancel).toBe('field');
    expect(h.calls).toEqual(['regionEscape:form']);
    expect(h.state.frames).toBe(2);

    // Nothing left to revert: the same key is MENU again, so the rung costs no navigation.
    const popped = press('Escape');
    expect(popped.resolution.cancel).toBe('frame');
    expect(h.calls).toEqual(['regionEscape:form', 'popFrame']);
    expect(h.state.frames).toBe(1);
  });

  it('puts that rung below `pending` and above `frame`, and nowhere else', async () => {
    const user = userEvent.setup();
    h.state.overlay = 'prompt';
    h.state.autocomplete = true;
    h.state.pendingMode = true;
    h.state.regionHandlesEscape = true;
    h.state.frames = 1;
    h.state.region = 'form';
    h.input.value = 'AAPL US Equity D';

    await user.keyboard('{Escape}{Escape}{Escape}{Escape}{Escape}{Escape}{Escape}');

    expect(h.calls).toEqual([
      'closeOverlay:prompt',
      'closeAutocomplete',
      'clearCommandDraft',
      'cancelPendingMode',
      'regionEscape:form',
      'popFrame',
      'cancelUnavailable',
    ]);
  });

  it('never asks the command line for Escape: its rungs are the draft and the autocomplete', () => {
    h.state.region = 'command';
    h.state.regionHandlesEscape = true;
    h.state.frames = 1;

    expect(press('Escape').resolution.cancel).toBe('frame');
    expect(h.calls).toEqual(['popFrame']);
  });

  it('pops the frame stack when there is nothing else to cancel (MENU)', async () => {
    const user = userEvent.setup();
    focusGrid(h);
    h.state.frames = 2;
    await user.keyboard('{Escape}{Escape}{Escape}');
    expect(h.calls).toEqual(['popFrame', 'popFrame', 'cancelUnavailable']);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 4. Yellow keys (FUNCTIONS.md §2.1 L638-647, §2.6)                                               */
/* -------------------------------------------------------------------------------------------- */

describe('yellow keys', () => {
  it('maps F2…F11 to the ten sectors in the order the table states', () => {
    expect(YELLOW_KEYS.map((b) => [b.key, b.sector])).toEqual([
      ['F2', 'Govt'],
      ['F3', 'Corp'],
      ['F4', 'Mtge'],
      ['F5', 'M-Mkt'],
      ['F6', 'Muni'],
      ['F7', 'Pfd'],
      ['F8', 'Equity'],
      ['F9', 'Comdty'],
      ['F10', 'Index'],
      ['F11', 'Curncy'],
    ]);
  });

  it('inserts the sector token after the typed ticker', async () => {
    const user = userEvent.setup();
    h.input.focus();
    await user.keyboard('AAPL US');
    await user.keyboard('{F8}');
    expect(h.input.value).toBe('AAPL US Equity ');
    expect(h.calls).toEqual(['insertSector:Equity']);
  });

  it('replaces a sector already on the line rather than contradicting it', () => {
    expect(insertSectorToken('AAPL US Equity DES', 'Govt').text).toBe('AAPL US Govt DES');
    expect(insertSectorToken('', 'Equity').text).toBe('Equity ');
    expect(insertSectorToken('AAPL', 'Equity')).toEqual({ text: 'AAPL Equity ', caret: 12 });
    // Canonical spelling always, whatever the user typed.
    expect(insertSectorToken('t 4.25 08/15/36 govt', 'Govt').text).toBe('t 4.25 08/15/36 Govt');
  });

  it('works from a grid, where the command line is not focused', async () => {
    const user = userEvent.setup();
    focusGrid(h);
    h.input.value = 'SPX';
    await user.keyboard('{F10}');
    expect(h.calls).toEqual(['insertSector:Index']);
    expect(h.input.value).toBe('SPX Index ');
  });

  it('has no yellow key for Crypto, which is typed in full', () => {
    expect(YELLOW_KEYS.some((b) => b.sector === 'Crypto')).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 5. Typing anywhere (TERM-06/TERM-07, CLIENT §4.1 L301)                                          */
/* -------------------------------------------------------------------------------------------- */

describe('typing anywhere', () => {
  it('routes a printable key pressed on a grid into the command line, and keeps typing there', async () => {
    const user = userEvent.setup();
    focusGrid(h);

    await user.keyboard('AAPL');

    // The first character is routed by the dispatcher; focus moves with it, so the rest are typed
    // into the input itself. The user never clicked anything.
    expect(h.calls.slice(0, 2)).toEqual(['focusCommandLine:false', 'type:A']);
    expect(document.activeElement).toBe(h.input);
    expect(h.input.value).toBe('AAPL');
  });

  it('routes from the key bar and from a chart too', async () => {
    const user = userEvent.setup();
    for (const region of ['keybar', 'chart', 'list', 'kv'] as const) {
      h.detach();
      h = harness({ region });
      h.grid.focus();
      await user.keyboard('7');
      expect(h.calls, region).toEqual(['focusCommandLine:false', 'type:7']);
    }
  });

  it('never steals a character from a form field or the MSG composer', async () => {
    const user = userEvent.setup();
    h.detach();
    h = harness({ region: 'form', capturesText: true });
    h.grid.focus();
    await user.keyboard('4');
    expect(h.calls).toEqual([]);
    expect(h.input.value).toBe('');
  });

  it('does not route while an overlay is open', async () => {
    const user = userEvent.setup();
    h.detach();
    h = harness({ region: 'grid', overlay: 'picker' });
    h.grid.focus();
    await user.keyboard('a');
    expect(h.calls).toEqual(['overlayKey:picker/a']);
    expect(h.input.value).toBe('');
  });

  it('leaves the command line alone: the input already has the character', async () => {
    const user = userEvent.setup();
    h.input.focus();
    await user.keyboard('ab');
    expect(h.calls).toEqual([]);
    expect(h.input.value).toBe('ab');
  });

  it('routes only printable keys', () => {
    const base = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    expect(isPrintable({ ...base, key: 'a', code: 'KeyA' })).toBe(true);
    expect(isPrintable({ ...base, key: 'A', code: 'KeyA', shiftKey: true })).toBe(true);
    expect(isPrintable({ ...base, key: ' ', code: 'Space' })).toBe(true);
    expect(isPrintable({ ...base, key: 'ArrowDown', code: 'ArrowDown' })).toBe(false);
    expect(isPrintable({ ...base, key: 'a', code: 'KeyA', ctrlKey: true })).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 6. Combos and `when` regions                                                                    */
/* -------------------------------------------------------------------------------------------- */

describe('combos', () => {
  it('parses modifiers, letters, digits and named keys onto physical codes', () => {
    expect(parseCombo('G')).toEqual({
      code: 'KeyG',
      key: 'G',
      ctrl: false,
      alt: false,
      shift: false,
    });
    expect(parseCombo('Ctrl+Shift+ArrowUp')).toEqual({
      code: 'ArrowUp',
      key: 'ARROWUP',
      ctrl: true,
      alt: false,
      shift: true,
    });
    expect(parseCombo('Alt+1').code).toBe('Digit1');
    // A manifest that binds `+` (OMON, OVML) parses it as a base token, not as a separator.
    expect(parseCombo('+').key).toBe('+');
    expect(parseCombo('Ctrl++').ctrl).toBe(true);
    expect(parseCombo('Ctrl++').key).toBe('+');
  });

  it('distinguishes a bare letter from its shifted form', () => {
    const g = {
      key: 'g',
      code: 'KeyG',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    };
    const shiftG = { ...g, key: 'G', shiftKey: true };
    expect(matchesKey(g, 'G')).toBe(true);
    expect(matchesKey(g, 'Shift+G')).toBe(false);
    expect(matchesKey(shiftG, 'Shift+G')).toBe(true);
    expect(matchesKey(shiftG, 'G')).toBe(false);
  });

  it('falls back to the key name when the event carries no usable code', () => {
    // `user-event` has no F-keys in its US-104 map and emits `code: 'Unknown'`.
    const f1 = {
      key: 'F1',
      code: 'Unknown',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    };
    expect(reservedFor(f1)?.action).toBe('help');
    expect(matchesKey(f1, 'F1')).toBe(true);
  });

  it('applies `when` the way §5.1 states it', () => {
    const always: KeyBinding = { key: 'S', action: 'sort', when: 'always', description: '' };
    const grid: KeyBinding = { key: 'S', action: 'sort', when: 'grid', description: '' };
    expect(bindingApplies(always, 'chart')).toBe(true);
    expect(bindingApplies(always, 'command')).toBe(false);
    // A dialog owns the screen while it is up (CLIENT §3.4), so nothing the screen bound applies.
    expect(bindingApplies(always, 'overlay')).toBe(false);
    expect(bindingApplies(grid, 'overlay')).toBe(false);
    expect(bindingApplies(grid, 'grid')).toBe(true);
    // A `table` is a grid without live cells (CLIENT §5.3).
    expect(bindingApplies(grid, 'table')).toBe(true);
    expect(bindingApplies(grid, 'chart')).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 7. The focus ring (CLIENT §3.2)                                                                 */
/* -------------------------------------------------------------------------------------------- */

const SPEC_BODY: Node = {
  kind: 'split',
  dir: 'col',
  sizes: [0.4, 0.6],
  children: [
    { kind: 'kv', id: 'header', rows: [] },
    {
      kind: 'tabs',
      id: 'tabs',
      active: 'profile',
      tabs: [
        {
          id: 'profile',
          label: 'Profile',
          body: { kind: 'grid', id: 'profile-grid', columns: [], rows: [] },
        },
        { id: 'notes', label: 'Notes', body: { kind: 'text', id: 'notes-text', text: 'hidden' } },
      ],
    },
  ],
};

describe('focus ring', () => {
  const nodes = collectFocusNodes(SPEC_BODY);

  it('collects the focusable nodes in document order and skips hidden tab bodies', () => {
    expect(nodes.map((n) => n.id)).toEqual(['header', 'tabs', 'profile-grid']);
    expect(nodes.map((n) => n.kind)).toEqual(['kv', 'tabs', 'grid']);
  });

  it('cycles command → nodes → key bar → command', () => {
    let state = createFocusState('p1');
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      state = nextRegion(state, nodes, 1);
      seen.push(state.region.kind === 'node' ? state.region.nodeId : state.region.kind);
    }
    expect(seen).toEqual(['header', 'tabs', 'profile-grid', 'keybar', 'command']);
    state = nextRegion(state, nodes, -1);
    expect(state.region.kind).toBe('keybar');
  });

  it('reports the region a keymap matches against', () => {
    const state = focusNode(createFocusState('p1'), nodes, 'profile-grid');
    expect(regionOf(state, nodes)).toBe('grid');
    expect(regionOf(createFocusState('p1'), nodes)).toBe('command');
  });

  it('roves tabindex: exactly one focusable element at a time', () => {
    const state = focusNode(createFocusState('p1'), nodes, 'tabs');
    expect(nodes.map((n) => nodeTabIndex(state, n.id))).toEqual([-1, 0, -1]);
  });

  it('restores the node under an overlay when it closes', () => {
    let state = focusNode(createFocusState('p1'), nodes, 'profile-grid');
    state = openFocusOverlay(state, 'provenance');
    expect(state.region).toEqual({ kind: 'overlay', overlay: 'provenance' });
    state = closeFocusOverlay(state, nodes);
    expect(state.region).toEqual({ kind: 'node', nodeId: 'profile-grid' });
  });

  it('restores focus per panel and falls back to initialFocus when the node is gone', () => {
    let state = focusNode(createFocusState('p1'), nodes, 'profile-grid');
    state = enterPanel(state, 'p2', nodes, 'header');
    expect(state.region).toEqual({ kind: 'node', nodeId: 'header' });
    state = enterPanel(state, 'p1', nodes, 'header');
    expect(state.region).toEqual({ kind: 'node', nodeId: 'profile-grid' });

    const otherNodes = collectFocusNodes({ kind: 'text', id: 'only', text: '' });
    state = enterPanel(state, 'p1', otherNodes, 'only');
    expect(state.region).toEqual({ kind: 'node', nodeId: 'only' });
  });

  it('keeps focus where the user put it when a payload repaints', () => {
    const state = focusNode(createFocusState('p1'), nodes, 'profile-grid');
    expect(paint(state, nodes, 'header').region).toEqual({ kind: 'node', nodeId: 'profile-grid' });
    // A launch from the command line takes the spec's initialFocus.
    const launching = createFocusState('p1');
    expect(paint(launching, nodes, 'tabs', { fromCommand: true }).region).toEqual({
      kind: 'node',
      nodeId: 'tabs',
    });
  });

  it('knows which regions swallow typed text', () => {
    const formNodes = collectFocusNodes({
      kind: 'split',
      dir: 'col',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'form', id: 'inputs', fields: [], onSubmit: () => undefined },
        { kind: 'custom', id: 'composer', component: 'Composer', props: {} },
      ],
    });
    const onForm = focusNode(createFocusState('p1'), formNodes, 'inputs');
    const onComposer = focusNode(createFocusState('p1'), formNodes, 'composer');
    expect(capturesTypedText(onForm, formNodes)).toBe(true);
    expect(capturesTypedText(onComposer, formNodes)).toBe(true);
    expect(capturesTypedText(createFocusState('p1'), formNodes)).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 8. The lock screen (stage 1)                                                                    */
/* -------------------------------------------------------------------------------------------- */

describe('lock screen', () => {
  it('answers Enter and nothing else', async () => {
    const user = userEvent.setup();
    h.detach();
    h = harness({ locked: true, region: 'grid' });
    h.grid.focus();
    await user.keyboard('a{Control>}p{/Control}');
    expect(h.calls).toEqual([]);
    await user.keyboard('{Enter}');
    expect(h.calls).toEqual(['unlock']);
  });
});
