/**
 * packages/web/test/shell/keyBar.test.tsx — the on-screen action keys (CLIENT §3.3, TERM-07).
 *
 * ## What was missing
 *
 * `shell/KeyBar.tsx` was never written. CLIENT §5 L348 requires every binding to have an on-screen
 * equivalent and §18.6 Q6 names this bar the GUARANTEED path for `F11` (Curncy), which macOS Chrome
 * does not surrender to a page — so with no bar, `F11` had no reachable binding at all, `MENU` had only
 * the key the browser might also swallow, and `TRACEABILITY.md`'s TERM-07 row said so.
 *
 * ## What is asserted here, and what is asserted in `test/app/App.test.tsx`
 *
 * Here: the bar's own contract — which buttons exist, what keystroke each one sends, when the bar is on
 * screen, and that it is ONE tab stop with its own arrow walk. The keystrokes are checked as the
 * `KeyboardEventInit` the bar emits, because that is the bar's whole output: it does not know what `F11`
 * means, and it must not.
 *
 * There: that the emitted keystroke reaches the dispatcher and the sector token lands in the command
 * line — the end of the path, on the composed application.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { yellowKeyForSector } from '@terminal/core';

import { KeyBar } from '../../src/shell/KeyBar.js';
import { useSettingsStore } from '../../src/state/settings.js';

function keys(): KeyboardEventInit[] {
  return sent;
}
let sent: KeyboardEventInit[] = [];

beforeEach(() => {
  sent = [];
  useSettingsStore.getState().configure({ storage: null });
  useSettingsStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mount(): void {
  render(<KeyBar onKey={(init) => sent.push(init)} />);
}

describe('the key bar renders the reserved actions §3.3 lists', () => {
  it('renders the seven action keys, in the spec’s order', () => {
    mount();
    const bar = screen.getByTestId('key-bar');
    const labels = [...bar.querySelectorAll('[data-keybar-action]')].map((b) => b.textContent);
    expect(labels).toEqual(['GO', 'CANCEL', 'MENU', 'HELP', 'PRINT', 'PG▲', 'PG▼']);
  });

  /**
   * The ten yellow keys, `F2`..`F11`, derived from `yellowKeyForSector` rather than listed.
   *
   * `Crypto` has no yellow key (the table answers `null`) and is therefore absent — from the bar for the
   * same reason it is absent from the keyboard, which is the property worth asserting: a bar that listed
   * eleven would offer a button that sends no key.
   */
  it('renders the ten sectors that have a yellow key, and not the one that does not', () => {
    mount();
    const bar = screen.getByTestId('key-bar');
    const sectors = [...bar.querySelectorAll('[data-keybar-sector]')].map(
      (b) => b.getAttribute('data-keybar-sector') ?? '',
    );
    expect(sectors).toEqual([
      'Govt',
      'Corp',
      'Mtge',
      'M-Mkt',
      'Muni',
      'Pfd',
      'Equity',
      'Comdty',
      'Index',
      'Curncy',
    ]);
    expect(sectors).not.toContain('Crypto');
    expect(yellowKeyForSector('Crypto')).toBeNull();
    // And the labels are the sector names up-cased, as §3.3 writes them.
    expect([...bar.querySelectorAll('[data-keybar-sector]')].map((b) => b.textContent)).toEqual(
      sectors.map((s) => s.toUpperCase()),
    );
  });

  it('sends each action’s keystroke, and nothing else', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'HELP' }));
    expect(keys()).toEqual([{ key: 'F1' }]);

    await userEvent.click(screen.getByRole('button', { name: 'PRINT' }));
    expect(keys()[1]).toEqual({ key: 'p', ctrlKey: true });

    await userEvent.click(screen.getByRole('button', { name: 'PG▼' }));
    expect(keys()[2]).toEqual({ key: 'PageDown' });
  });

  /**
   * CANCEL and MENU send the SAME key, and that is the design.
   *
   * §5.2 gives `Escape` both names: it is a ladder whose last rung pops the frame stack. A bar that
   * called `popFrame()` for MENU directly would pop the frame out from under an open overlay. So both
   * buttons press `Escape` and `keyboard/dispatcher.ts` decides which rung applies — one implementation
   * of the ladder, not two.
   */
  it('presses Escape for both CANCEL and MENU', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
    await userEvent.click(screen.getByRole('button', { name: 'MENU' }));
    expect(keys()).toEqual([{ key: 'Escape' }, { key: 'Escape' }]);
  });

  it('sends F11 for CURNCY — the key macOS Chrome will not give up', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'CURNCY' }));
    expect(keys()).toEqual([{ key: 'F11' }]);
  });

  it('sends the right F-key for every sector, by the core table', async () => {
    mount();
    const bar = screen.getByTestId('key-bar');
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>('[data-keybar-sector]')];
    for (const button of buttons) {
      sent = [];
      await userEvent.click(button);
      const sector = button.getAttribute('data-keybar-sector') ?? '';
      expect(keys(), sector).toEqual([
        { key: yellowKeyForSector(sector as Parameters<typeof yellowKeyForSector>[0]) },
      ]);
    }
  });
});

describe('visibility follows the setting and the density (§3.3)', () => {
  it('is on by default, which is a normal desk', () => {
    mount();
    expect(screen.queryByTestId('key-bar')).not.toBeNull();
  });

  it('is off in compact density by default, and `/keybar on` brings it back', () => {
    // The reason `settings.keybar` is three-state: a boolean cannot tell the default-on of a normal desk
    // from an explicit on, so either this test or the one above would have to be deleted.
    useSettingsStore.getState().set('density', 'compact');
    mount();
    expect(screen.queryByTestId('key-bar')).toBeNull();

    cleanup();
    useSettingsStore.getState().set('keybar', 'on');
    mount();
    expect(screen.queryByTestId('key-bar')).not.toBeNull();
  });

  it('is off when the user says off, whatever the density', () => {
    useSettingsStore.getState().set('keybar', 'off');
    mount();
    expect(screen.queryByTestId('key-bar')).toBeNull();

    cleanup();
    useSettingsStore.getState().set('density', 'comfortable');
    mount();
    expect(screen.queryByTestId('key-bar')).toBeNull();
  });
});

describe('the bar is one tab stop, and the arrows walk it (§5.2 Tab ring)', () => {
  /**
   * `keyboard/focus.ts#nextRegion`'s ring is `command line → nodes → key bar → command line`: ONE entry
   * for the bar. Seventeen tab stops would make `Tab` mean something different from what §5.2's table
   * says, so the buttons are `tabIndex={-1}` except the first and `ArrowLeft`/`ArrowRight` move between
   * them — the toolbar pattern.
   */
  it('exposes exactly one tabbable button', () => {
    mount();
    const bar = screen.getByTestId('key-bar');
    const tabbable = [...bar.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.tabIndex === 0,
    );
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]?.textContent).toBe('GO');
  });

  it('moves focus with the arrows and wraps', async () => {
    mount();
    const bar = screen.getByTestId('key-bar');
    const first = screen.getByRole('button', { name: 'GO' });
    first.focus();
    expect(document.activeElement).toBe(first);

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'CANCEL' }));

    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(first);

    // And wraps backwards onto the last yellow key, so the whole bar is reachable from either end.
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'CURNCY' }));
    expect(bar.contains(document.activeElement)).toBe(true);
  });

  it('is a toolbar, so a screen reader announces it as one group', () => {
    mount();
    expect(screen.getByRole('toolbar', { name: 'Key bar' })).toBeInTheDocument();
  });
});
