/**
 * packages/web/test/state/panels.test.ts — CLIENT.md §8 L573-596, FUNCTIONS.md §2.5 L785-791.
 *
 * The frame stack is the terminal's back button, and the case that matters is the one a naive
 * push/pop gets wrong: BACK, then a new launch. The forward history must be truncated at that
 * point, so `Alt+→` cannot walk into a screen the user abandoned — and `Alt+←` must still reach
 * the frame before it.
 *
 * The workspace store is configured with a manual scheduler here because `pushFrame` marks the
 * layout dirty, which schedules an autosave: a web test drives its own clock (TESTING §2.2).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_FRAMES,
  PANEL_COUNT,
  selectCanGoBack,
  selectCanGoForward,
  selectFrame,
  usePanelsStore,
  visibleFor,
} from '../../src/state/panels.js';
import type { FrameInput } from '../../src/state/panels.js';
import type { Scheduler } from '../../src/state/workspace.js';
import { useWorkspaceStore } from '../../src/state/workspace.js';

/** Timers that only run when the test says so. */
function manualScheduler(): { scheduler: Scheduler; run: () => void } {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    scheduler: {
      setTimer: (fn) => {
        const handle = next++;
        pending.set(handle, fn);
        return handle;
      },
      clearTimer: (handle) => {
        pending.delete(handle);
      },
      now: () => 0,
    },
    run: () => {
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn();
    },
  };
}

const frame = (fn: string, id: number): FrameInput => ({
  security: { id, display: `SEC${String(id)} US Equity` },
  fn,
  traceId: `trace-${fn}`,
});

beforeEach(() => {
  useWorkspaceStore.getState().reset();
  useWorkspaceStore.getState().configure({ scheduler: manualScheduler().scheduler });
  usePanelsStore.getState().reset();
});

describe('panelsStore — the frame stack', () => {
  it('pushes, walks back and truncates forward history on the next launch', () => {
    const store = usePanelsStore.getState();
    store.pushFrame('p1', frame('DES', 42));
    store.pushFrame('p1', frame('GP', 42));

    expect(usePanelsStore.getState().panels.p1?.index).toBe(1);
    expect(selectFrame('p1')(usePanelsStore.getState())?.fn).toBe('GP');

    expect(usePanelsStore.getState().goBack('p1')).toBe(true);
    expect(selectFrame('p1')(usePanelsStore.getState())?.fn).toBe('DES');
    expect(selectCanGoForward('p1')(usePanelsStore.getState())).toBe(true);

    // A new launch from the middle of the stack drops everything ahead of it.
    usePanelsStore.getState().pushFrame('p1', frame('HP', 42));
    const panel = usePanelsStore.getState().panels.p1;
    expect(panel?.frameStack.map((f) => f.fn)).toEqual(['DES', 'HP']);
    expect(panel?.index).toBe(1);
    expect(usePanelsStore.getState().goForward('p1')).toBe(false);

    // …and back still reaches the frame that preceded the new launch.
    expect(usePanelsStore.getState().goBack('p1')).toBe(true);
    expect(selectFrame('p1')(usePanelsStore.getState())?.fn).toBe('DES');
  });

  it('refuses to walk off either end', () => {
    expect(usePanelsStore.getState().goBack('p1')).toBe(false);
    expect(usePanelsStore.getState().goForward('p1')).toBe(false);
    usePanelsStore.getState().pushFrame('p1', frame('DES', 42));
    expect(selectCanGoBack('p1')(usePanelsStore.getState())).toBe(false);
    expect(usePanelsStore.getState().goForward('p1')).toBe(false);
    expect(usePanelsStore.getState().goBack('unknown-panel')).toBe(false);
  });

  it('pops the current frame and steps back (Escape-MENU)', () => {
    const store = usePanelsStore.getState();
    store.pushFrame('p1', frame('DES', 42));
    store.pushFrame('p1', frame('GP', 42));

    expect(usePanelsStore.getState().popFrame('p1')).toBe(true);
    expect(usePanelsStore.getState().panels.p1?.frameStack.map((f) => f.fn)).toEqual(['DES']);
    expect(usePanelsStore.getState().panels.p1?.index).toBe(0);
    // One frame left is nothing to pop: Escape has already run out of things to cancel.
    expect(usePanelsStore.getState().popFrame('p1')).toBe(false);
  });

  it('caps the stack at the 50 frames the wire schema allows', () => {
    for (let i = 0; i < MAX_FRAMES + 5; i += 1) usePanelsStore.getState().pushFrame('p1', frame(`F${String(i)}`, 1));
    const panel = usePanelsStore.getState().panels.p1;
    expect(panel?.frameStack).toHaveLength(MAX_FRAMES);
    expect(panel?.index).toBe(MAX_FRAMES - 1);
    // The OLDEST frames are the ones dropped.
    expect(panel?.frameStack[0]?.fn).toBe('F5');
  });

  it('clears the stack for /clear', () => {
    usePanelsStore.getState().pushFrame('p1', frame('DES', 42));
    usePanelsStore.getState().clearFrames('p1');
    expect(usePanelsStore.getState().panels.p1?.frameStack).toEqual([]);
    expect(selectFrame('p1')(usePanelsStore.getState())).toBeUndefined();
  });
});

describe('panelsStore — layout and focus', () => {
  it('creates the panels a mode needs and keeps them when the mode shrinks', () => {
    usePanelsStore.getState().setMode('4');
    expect(usePanelsStore.getState().order).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(usePanelsStore.getState().visible).toHaveLength(PANEL_COUNT['4']);

    usePanelsStore.getState().pushFrame('p3', frame('GP', 7));
    usePanelsStore.getState().setMode('1');
    expect(usePanelsStore.getState().visible).toEqual(['p1']);
    // Going 4 → 1 hides p3; it does not destroy what it was showing.
    expect(usePanelsStore.getState().panels.p3?.frameStack).toHaveLength(1);

    usePanelsStore.getState().setMode('4');
    expect(usePanelsStore.getState().visible).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('never leaves focus on a panel the grid is not showing', () => {
    usePanelsStore.getState().setMode('4');
    usePanelsStore.getState().setFocus('p4');
    usePanelsStore.getState().setMode('1');
    const s = usePanelsStore.getState();
    expect(s.visible).toContain(s.focus);
    expect(visibleFor(['p1', 'p2', 'p3', 'p4'], '2h', 'p4')).toEqual(['p1', 'p4']);
  });
});

describe('panelsStore — the persisted projection', () => {
  it('persists the wire fields and nothing that belongs to this run', () => {
    usePanelsStore.getState().pushFrame('p1', frame('DES', 42));
    usePanelsStore.getState().replaceFrame('p1', {
      status: 'ready',
      payload: { big: 'object' },
      resultId: '01J0000000000000000000TEST',
      scroll: 12,
    });
    usePanelsStore.getState().pushHistory('p1', 'AAPL US Equity DES');
    usePanelsStore.getState().setDraft('p1', 'MSFT US Equity ');

    const layout = usePanelsStore.getState().toLayout();
    expect(layout).toEqual({
      mode: '1',
      focus: 'p1',
      panels: [
        {
          id: 'p1',
          index: 0,
          history: ['AAPL US Equity DES'],
          commandDraft: 'MSFT US Equity ',
          frameStack: [
            {
              security: { id: 42, display: 'SEC42 US Equity' },
              fn: 'DES',
              params: {},
              resultId: '01J0000000000000000000TEST',
              scroll: 12,
            },
          ],
        },
      ],
    });
  });

  it('round-trips a layout back into runtime panels', () => {
    usePanelsStore.getState().setMode('2h');
    usePanelsStore.getState().pushFrame('p2', frame('GP', 7));
    usePanelsStore.getState().setFocus('p2');
    const section = usePanelsStore.getState().toLayout();

    usePanelsStore.getState().reset();
    usePanelsStore.getState().fromLayout({
      schema: 1,
      ...section,
      monitors: [],
      chart: { defaultRange: '1Y', defaultType: 'line', studies: [] },
      conflationMs: 250,
      windows: [],
    });

    const s = usePanelsStore.getState();
    expect(s.order).toEqual(['p1', 'p2']);
    expect(s.focus).toBe('p2');
    expect(s.mode).toBe('2h');
    expect(selectFrame('p2')(s)?.fn).toBe('GP');
    // A restored frame has not been run yet: no trace id, no payload.
    expect(selectFrame('p2')(s)?.traceId).toBe('');
    expect(selectFrame('p2')(s)?.status).toBe('idle');
  });
});

describe('panelsStore — what marks the workspace dirty', () => {
  it('marks the panel on a launch and the section on a layout change, but not on a keystroke', () => {
    usePanelsStore.getState().pushFrame('p1', frame('DES', 42));
    expect([...useWorkspaceStore.getState().dirty]).toEqual(['panel:p1']);

    useWorkspaceStore.setState({ dirty: new Set() });
    usePanelsStore.getState().setDraft('p1', 'AAPL');
    usePanelsStore.getState().setAc('p1', { rows: [], selected: 0, open: true });
    usePanelsStore.getState().setOverlay('p1', { kind: 'overlay', overlay: 'help' });
    expect(useWorkspaceStore.getState().dirty.size).toBe(0);

    usePanelsStore.getState().setMode('4');
    usePanelsStore.getState().setFocus('p2');
    expect([...useWorkspaceStore.getState().dirty].sort()).toEqual(['focus', 'mode']);

    // A payload landing is not a layout change either.
    useWorkspaceStore.setState({ dirty: new Set() });
    usePanelsStore.getState().replaceFrame('p1', { status: 'ready', payload: {} });
    expect(useWorkspaceStore.getState().dirty.size).toBe(0);
    usePanelsStore.getState().replaceFrame('p1', { params: { range: '1Y' } });
    expect([...useWorkspaceStore.getState().dirty]).toEqual(['panel:p1']);
  });
});
