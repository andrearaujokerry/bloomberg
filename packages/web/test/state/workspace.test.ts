/**
 * packages/web/test/state/workspace.test.ts — TERM-05, CLIENT.md §7.2 L484-520.
 *
 * The acceptance row is one sentence: **the workspace version conflict surfaces rather than being
 * swallowed**. A swallowed 409 has exactly one observable consequence — the user's layout is
 * quietly replaced by someone else's — and nothing in the UI ever says so. So the assertions here
 * are about what is *visible* afterwards: `status`, the server copy kept beside ours, and the fact
 * that `dirty` and the local layout survive.
 *
 * Everything is driven through the injected scheduler; no test here waits on wall time
 * (TESTING §2.2).
 */
import { TerminalApiError } from '@terminal/sdk';
import type { Workspace, WorkspaceLayout } from '@terminal/sdk/wire/rest/workspaces';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePanelsStore } from '../../src/state/panels.js';
import {
  DEBOUNCE_MS,
  DEFAULT_LAYOUT,
  MAX_WAIT_MS,
  mergeLayouts,
  migrateLayout,
  selectConflictMessage,
  useWorkspaceStore,
} from '../../src/state/workspace.js';
import type { Scheduler, WorkspaceApi } from '../../src/state/workspace.js';

/* -------------------------------------------------------------------------------- the harness */

interface Clock {
  scheduler: Scheduler;
  /** Move time forward and run every timer whose delay has elapsed. */
  advance(ms: number): void;
  pending(): number;
}

function clock(): Clock {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    scheduler: {
      setTimer: (fn, ms) => {
        const handle = next++;
        timers.set(handle, { at: now + ms, fn });
        return handle;
      },
      clearTimer: (handle) => {
        timers.delete(handle);
      },
      now: () => now,
    },
    advance(ms) {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

function layout(patch: Partial<WorkspaceLayout> = {}): WorkspaceLayout {
  return { ...structuredClone(DEFAULT_LAYOUT), ...patch };
}

function workspace(version: number, l: WorkspaceLayout = layout()): Workspace {
  return {
    workspaceId: 7,
    name: 'default',
    isActive: true,
    version,
    layout: l,
    updatedAt: '2026-09-15T18:41:28.000Z',
  };
}

function conflict(version: number, serverLayout: WorkspaceLayout): TerminalApiError {
  return new TerminalApiError({
    code: 'WORKSPACE_VERSION_CONFLICT',
    message: 'workspace was saved elsewhere',
    status: 409,
    traceId: '0f2c9ab1-0000-4000-8000-00000000abcd',
    details: { current: workspace(version, serverLayout) },
  });
}

/** A 409 whose `details.current` is whatever the caller hands over, well formed or not. */
function rawConflict(details: unknown): TerminalApiError {
  return new TerminalApiError({
    code: 'WORKSPACE_VERSION_CONFLICT',
    message: 'workspace was saved elsewhere',
    status: 409,
    traceId: '0f2c9ab1-0000-4000-8000-00000000abcd',
    ...(details === undefined ? {} : { details }),
  });
}

let time: Clock;

beforeEach(() => {
  usePanelsStore.getState().reset();
  useWorkspaceStore.getState().reset();
  time = clock();
  useWorkspaceStore.getState().configure({ scheduler: time.scheduler });
});

/* ------------------------------------------------------------------------------------- saving */

describe('workspaceStore — saving', () => {
  it('debounces to one PUT carrying the version it read', async () => {
    const putActive = vi.fn().mockResolvedValue({ version: 5, updatedAt: '2026-09-15T18:42:00Z' });
    const api: WorkspaceApi = { getActive: () => Promise.resolve(workspace(4)), putActive };
    useWorkspaceStore.getState().configure({ api });
    await useWorkspaceStore.getState().load();

    usePanelsStore.getState().pushFrame('p1', { security: null, fn: 'DES', traceId: 't1' });
    usePanelsStore.getState().pushFrame('p1', { security: null, fn: 'GP', traceId: 't2' });
    expect(putActive).not.toHaveBeenCalled();

    time.advance(DEBOUNCE_MS);
    await vi.waitFor(() => {
      expect(putActive).toHaveBeenCalledTimes(1);
    });

    expect(putActive.mock.calls[0]?.[0].body.version).toBe(4);
    expect(putActive.mock.calls[0]?.[0].body.layout.panels[0].frameStack).toHaveLength(2);
    expect(useWorkspaceStore.getState().version).toBe(5);
    expect(useWorkspaceStore.getState().dirty.size).toBe(0);
    expect(useWorkspaceStore.getState().status).toBe('idle');
  });

  it('stops deferring at the 10 s max wait', async () => {
    const putActive = vi.fn().mockResolvedValue({ version: 2, updatedAt: '2026-09-15T18:42:00Z' });
    useWorkspaceStore
      .getState()
      .configure({ api: { getActive: () => Promise.resolve(workspace(1)), putActive } });
    useWorkspaceStore.getState().hydrate(workspace(1));

    // A change every 1.5 s resets a plain trailing debounce for ever; the max wait is what stops
    // an actively-edited workspace from never being saved at all.
    for (let i = 0; i < 8; i += 1) {
      useWorkspaceStore.getState().markDirty('monitors');
      time.advance(1_500);
    }

    await vi.waitFor(() => {
      expect(putActive).toHaveBeenCalledTimes(1);
    });
    // Nothing in this run was ever quiet for the full 2 s debounce, so only the 10 s max wait can
    // have issued that PUT.
    expect(useWorkspaceStore.getState().lastSavedAt).not.toBeNull();
    expect(MAX_WAIT_MS).toBe(10_000);
  });
});

/* ----------------------------------------------------------------------------------- conflict */

describe('workspaceStore — 409 WORKSPACE_VERSION_CONFLICT (TERM-05)', () => {
  const theirs = layout({
    mode: '2h',
    conflationMs: 1_000,
    panels: [
      { id: 'p1', frameStack: [], index: 0, history: ['their command'], commandDraft: '' },
      { id: 'p2', frameStack: [], index: 0, history: [], commandDraft: '' },
    ],
    focus: 'p2',
  });

  it('merges per key and retries once with the version the server named', async () => {
    const putActive = vi
      .fn()
      .mockRejectedValueOnce(conflict(9, theirs))
      .mockResolvedValueOnce({ version: 10, updatedAt: '2026-09-15T18:43:00Z' });
    useWorkspaceStore
      .getState()
      .configure({ api: { getActive: () => Promise.resolve(workspace(4)), putActive } });
    useWorkspaceStore.getState().hydrate(workspace(4));

    // Local edit: one panel and the conflation preference.
    usePanelsStore.getState().pushFrame('p1', { security: null, fn: 'DES', traceId: 't1' });
    await useWorkspaceStore.getState().saveNow();

    expect(putActive).toHaveBeenCalledTimes(2);
    const first = putActive.mock.calls[0]?.[0].body;
    const second = putActive.mock.calls[1]?.[0].body;
    expect(first.version).toBe(4);
    // The retry carries THEIR version, not ours-plus-one.
    expect(second.version).toBe(9);
    // Our dirty panel survived the merge…
    expect(second.layout.panels[0].frameStack).toHaveLength(1);
    // …their panel, which we never touched, came along…
    expect(second.layout.panels.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2']);
    // …and a key we had not touched took their value.
    expect(second.layout.conflationMs).toBe(1_000);
    expect(second.layout.mode).toBe('2h');

    expect(useWorkspaceStore.getState().status).toBe('idle');
    expect(useWorkspaceStore.getState().version).toBe(10);
  });

  it('surfaces a second conflict instead of swallowing it, and keeps the local layout', async () => {
    const putActive = vi
      .fn()
      .mockRejectedValueOnce(conflict(9, theirs))
      .mockRejectedValueOnce(conflict(11, theirs));
    useWorkspaceStore
      .getState()
      .configure({ api: { getActive: () => Promise.resolve(workspace(4)), putActive } });
    useWorkspaceStore.getState().hydrate(workspace(4));
    usePanelsStore.getState().pushFrame('p1', { security: null, fn: 'DES', traceId: 't1' });

    await useWorkspaceStore.getState().saveNow();

    const s = useWorkspaceStore.getState();
    expect(putActive).toHaveBeenCalledTimes(2);
    expect(s.status).toBe('conflict');
    expect(s.conflict?.serverVersion).toBe(11);
    expect(s.conflict?.serverLayout?.mode).toBe('2h');
    // Nothing was thrown away: the dirty set is intact and the panel is still ours.
    expect([...s.dirty]).toContain('panel:p1');
    expect(usePanelsStore.getState().panels.p1?.frameStack).toHaveLength(1);
    // And the user is told, in words, by the status bar.
    expect(selectConflictMessage(s)).toMatch(/saved elsewhere/i);

    // A further edit must not fire another save on top of an unanswered conflict.
    usePanelsStore.getState().pushFrame('p1', { security: null, fn: 'GP', traceId: 't2' });
    time.advance(DEBOUNCE_MS * 2);
    expect(putActive).toHaveBeenCalledTimes(2);
  });

  it('reloads the server copy when the user picks R', async () => {
    const putActive = vi.fn().mockRejectedValue(conflict(9, theirs));
    useWorkspaceStore
      .getState()
      .configure({ api: { getActive: () => Promise.resolve(workspace(9, theirs)), putActive } });
    useWorkspaceStore.getState().hydrate(workspace(4));
    usePanelsStore.getState().pushFrame('p1', { security: null, fn: 'DES', traceId: 't1' });
    await useWorkspaceStore.getState().saveNow();
    expect(useWorkspaceStore.getState().status).toBe('conflict');

    await useWorkspaceStore.getState().resolveConflict('reload');

    const s = useWorkspaceStore.getState();
    expect(s.status).toBe('idle');
    expect(s.conflict).toBeNull();
    expect(s.dirty.size).toBe(0);
    expect(s.version).toBe(9);
    // The panels store took the server's layout, which is what "reload theirs" means.
    expect(usePanelsStore.getState().order).toEqual(['p1', 'p2']);
    expect(usePanelsStore.getState().panels.p1?.frameStack).toHaveLength(0);
  });

  it('re-reads the version and forces ours when the user picks K', async () => {
    const putActive = vi
      .fn()
      .mockRejectedValueOnce(conflict(9, theirs))
      .mockRejectedValueOnce(conflict(11, theirs))
      .mockResolvedValueOnce({ version: 12, updatedAt: '2026-09-15T18:44:00Z' });
    useWorkspaceStore
      .getState()
      .configure({ api: { getActive: () => Promise.resolve(workspace(11, theirs)), putActive } });
    useWorkspaceStore.getState().hydrate(workspace(4));
    usePanelsStore.getState().pushFrame('p1', { security: null, fn: 'DES', traceId: 't1' });
    await useWorkspaceStore.getState().saveNow();

    await useWorkspaceStore.getState().resolveConflict('keep-mine');

    expect(putActive).toHaveBeenCalledTimes(3);
    expect(putActive.mock.calls[2]?.[0].body.version).toBe(11);
    expect(putActive.mock.calls[2]?.[0].body.layout.panels[0].frameStack).toHaveLength(1);
    expect(useWorkspaceStore.getState().status).toBe('idle');
    expect(useWorkspaceStore.getState().version).toBe(12);
  });

  /* A 409 the client cannot read is the case where it is easiest to lie to the user: we know a
     conflict happened but not what beat us. The store must say so rather than dress our own last
     acknowledged copy up as the server's. */
  describe('a 409 whose server copy we cannot use', () => {
    it("keeps the server's version and refuses to pass our layout off as theirs", async () => {
      const putActive = vi
        .fn()
        .mockRejectedValue(rawConflict({ current: { version: 99, layout: { nonsense: true } } }));
      useWorkspaceStore
        .getState()
        .configure({ api: { getActive: () => Promise.resolve(workspace(4)), putActive } });
      useWorkspaceStore.getState().hydrate(workspace(4, theirs));
      usePanelsStore.getState().pushFrame('p1', { security: null, fn: 'DES', traceId: 't1' });

      await useWorkspaceStore.getState().saveNow();

      const s = useWorkspaceStore.getState();
      expect(s.status).toBe('conflict');
      // There is nothing to merge against, so the one retry never happens.
      expect(putActive).toHaveBeenCalledTimes(1);
      // The version is a plain number and survives an unreadable layout: it is 99, not our 4.
      expect(s.conflict?.serverVersion).toBe(99);
      // And "theirs" is honestly empty rather than a copy of `serverLayout`.
      expect(s.conflict?.serverLayout).toBeNull();
      expect(s.serverLayout?.mode).toBe(theirs.mode);
      // The message must not offer to reload a copy we do not have.
      const message = selectConflictMessage(s) ?? '';
      expect(message).toContain('server version 99');
      expect(message).toContain('their copy did not arrive');
      expect(message).toContain('K keep mine');
      expect(message).not.toContain('R reload theirs');
      // Nothing local was thrown away.
      expect([...s.dirty]).toContain('panel:p1');
      expect(usePanelsStore.getState().panels.p1?.frameStack).toHaveLength(1);
    });

    it('says the version is unknown when the 409 carries no `details.current`', async () => {
      const putActive = vi.fn().mockRejectedValue(rawConflict(undefined));
      useWorkspaceStore
        .getState()
        .configure({ api: { getActive: () => Promise.resolve(workspace(4)), putActive } });
      useWorkspaceStore.getState().hydrate(workspace(4));
      usePanelsStore.getState().pushFrame('p1', { security: null, fn: 'DES', traceId: 't1' });

      await useWorkspaceStore.getState().saveNow();

      const s = useWorkspaceStore.getState();
      expect(s.status).toBe('conflict');
      expect(s.conflict).toEqual({ serverVersion: null, serverLayout: null });
      expect(selectConflictMessage(s)).toContain('server version unknown');
    });

    it('fetches the real server copy when the user picks R, instead of re-applying ours', async () => {
      const server = workspace(99, theirs);
      const getActive = vi.fn().mockResolvedValue(server);
      const putActive = vi
        .fn()
        .mockRejectedValue(rawConflict({ current: { version: 99, layout: { nonsense: true } } }));
      useWorkspaceStore.getState().configure({ api: { getActive, putActive } });
      useWorkspaceStore.getState().hydrate(workspace(4));
      usePanelsStore.getState().pushFrame('p1', { security: null, fn: 'DES', traceId: 't1' });
      await useWorkspaceStore.getState().saveNow();
      expect(useWorkspaceStore.getState().conflict?.serverLayout).toBeNull();

      await useWorkspaceStore.getState().resolveConflict('reload');

      expect(getActive).toHaveBeenCalledTimes(1);
      const s = useWorkspaceStore.getState();
      expect(s.status).toBe('idle');
      expect(s.conflict).toBeNull();
      expect(s.version).toBe(99);
      // The layout on screen is the one the server actually holds, two panels and all.
      expect(usePanelsStore.getState().order).toEqual(['p1', 'p2']);
      expect(usePanelsStore.getState().panels.p1?.frameStack).toHaveLength(0);
    });

    it('leaves the conflict standing when that re-read fails', async () => {
      const getActive = vi
        .fn()
        .mockResolvedValueOnce(workspace(4))
        .mockRejectedValue(
          new TerminalApiError({
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'plant unreachable',
            status: 503,
            traceId: '0f2c9ab1-0000-4000-8000-00000000abcd',
          }),
        );
      const putActive = vi
        .fn()
        .mockRejectedValue(rawConflict({ current: { version: 99, layout: { nonsense: true } } }));
      useWorkspaceStore.getState().configure({ api: { getActive, putActive } });
      await useWorkspaceStore.getState().load();
      usePanelsStore.getState().pushFrame('p1', { security: null, fn: 'DES', traceId: 't1' });
      await useWorkspaceStore.getState().saveNow();

      await useWorkspaceStore.getState().resolveConflict('reload');

      const s = useWorkspaceStore.getState();
      // Still asking. A failed re-read must not look like a resolved conflict.
      expect(s.status).toBe('conflict');
      expect(s.conflict?.serverVersion).toBe(99);
      expect(s.error?.code).toBe('UPSTREAM_UNAVAILABLE');
      expect([...s.dirty]).toContain('panel:p1');
    });

    it('never pairs a version from one 409 with a layout from another', async () => {
      const putActive = vi
        .fn()
        .mockRejectedValueOnce(conflict(9, theirs))
        .mockRejectedValueOnce(rawConflict({ current: { version: 11, layout: { nonsense: true } } }));
      useWorkspaceStore
        .getState()
        .configure({ api: { getActive: () => Promise.resolve(workspace(4)), putActive } });
      useWorkspaceStore.getState().hydrate(workspace(4));
      usePanelsStore.getState().pushFrame('p1', { security: null, fn: 'DES', traceId: 't1' });

      await useWorkspaceStore.getState().saveNow();

      const s = useWorkspaceStore.getState();
      expect(s.status).toBe('conflict');
      // Version 11 is real; the version-9 layout from the first 409 is NOT version 11's layout.
      expect(s.conflict).toEqual({ serverVersion: 11, serverLayout: null });
    });
  });

  it('reports an ordinary failure as an error, not as a conflict', async () => {
    const putActive = vi.fn().mockRejectedValue(
      new TerminalApiError({
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'plant unreachable',
        status: 503,
        traceId: '0f2c9ab1-0000-4000-8000-00000000abcd',
      }),
    );
    useWorkspaceStore
      .getState()
      .configure({ api: { getActive: () => Promise.resolve(workspace(4)), putActive } });
    useWorkspaceStore.getState().hydrate(workspace(4));
    usePanelsStore.getState().pushFrame('p1', { security: null, fn: 'DES', traceId: 't1' });

    await useWorkspaceStore.getState().saveNow();

    expect(useWorkspaceStore.getState().status).toBe('error');
    expect(useWorkspaceStore.getState().error?.code).toBe('UPSTREAM_UNAVAILABLE');
    // The edit is still pending, so the next tick tries again rather than losing it.
    expect([...useWorkspaceStore.getState().dirty]).toContain('panel:p1');
  });
});

/* -------------------------------------------------------------------------------------- merge */

describe('mergeLayouts', () => {
  it('keeps dirty keys local, takes the rest from the server, and loses no panel', () => {
    const local = layout({
      mode: '4',
      conflationMs: 250,
      focus: 'p3',
      panels: [
        { id: 'p1', frameStack: [], index: 0, history: ['mine'], commandDraft: '' },
        { id: 'p3', frameStack: [], index: 0, history: [], commandDraft: '' },
      ],
    });
    const server = layout({
      mode: '2v',
      conflationMs: 1_000,
      focus: 'p2',
      panels: [
        { id: 'p1', frameStack: [], index: 0, history: ['theirs'], commandDraft: '' },
        { id: 'p2', frameStack: [], index: 0, history: [], commandDraft: '' },
      ],
    });

    const merged = mergeLayouts(local, server, new Set(['mode', 'panel:p1']));

    expect(merged.mode).toBe('4');
    expect(merged.conflationMs).toBe(1_000);
    expect(merged.panels.map((p) => p.id)).toEqual(['p1', 'p3', 'p2']);
    expect(merged.panels[0]?.history).toEqual(['mine']);
    // `focus` was not dirty, so the server's wins — and it exists in the merged panel set.
    expect(merged.focus).toBe('p2');
  });

  it('falls back to a real panel when the surviving focus points at none', () => {
    const local = layout({ focus: 'p1' });
    const server = layout({
      focus: 'p8',
      panels: [{ id: 'p1', frameStack: [], index: 0, history: [], commandDraft: '' }],
    });
    expect(mergeLayouts(local, server, new Set()).focus).toBe('p1');
  });
});

describe('migrateLayout', () => {
  it('passes schema 1 through and falls back loudly on anything else', () => {
    const ours = layout({ mode: '2h' });
    expect(migrateLayout(ours)).toEqual({ layout: ours, migrated: false });

    const future = migrateLayout({ ...ours, schema: 2 });
    expect(future.migrated).toBe(true);
    expect(future.layout.mode).toBe('1');

    expect(migrateLayout(null).migrated).toBe(true);
    expect(migrateLayout({ schema: 1 }).migrated).toBe(true);
  });
});
