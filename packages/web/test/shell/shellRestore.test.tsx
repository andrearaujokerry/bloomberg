/**
 * packages/web/test/shell/shellRestore.test.tsx — the workspace is loaded once and the desk is
 * restored once (TERM-05, API-06).
 *
 * `Shell`'s restore effect is not an ordinary effect. `load()` is a `GET /workspace` and
 * `onRestored()` re-runs every panel's function, so running it twice costs two layout fetches, two
 * `POST /functions/<code>/run`s per panel and two `fn.launch` rows against the user's quota, under
 * two distinct trace ids. Driving the real terminal is what found it: one authenticated load of the
 * seeded desk sent `GET /auth/session` ×2, `GET /workspace` ×2 and `WEI`/`GP`/`W`/`TOP` ×2 each, and
 * the plant's own ledger agreed — `fn.launch W=6/6, GP=6/6, WEI=6/6` over three page loads.
 *
 * **The whole test is the `<StrictMode>` wrapper.** `main.tsx` renders the application inside one,
 * which in development mounts, unmounts and re-mounts every component precisely to expose an effect
 * that cannot be run twice — and the 254 green vitest files could not see this one because none of
 * them rendered the Shell the way the product does. So the assertion is made under the same wrapper
 * the product uses, and it counts calls rather than checking a rendered state, because the defect
 * costs requests and quota rather than pixels: a screen restored twice looks exactly like a screen
 * restored once.
 *
 * Nothing here waits on wall time: the workspace store takes its timers through a `Scheduler` port
 * (TESTING §2.2) and the load resolves on a microtask.
 */

import { StrictMode } from 'react';
import type { Workspace, WorkspaceLayout } from '@terminal/sdk/wire/rest/workspaces';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Shell } from '../../src/shell/Shell.js';
import { usePanelsStore } from '../../src/state/panels.js';
import { useSessionStore } from '../../src/state/session.js';
import { useSettingsStore } from '../../src/state/settings.js';
import { useSubscriptionsStore } from '../../src/state/subscriptions.js';
import { DEFAULT_LAYOUT, useWorkspaceStore } from '../../src/state/workspace.js';
import type { Scheduler, WorkspaceApi } from '../../src/state/workspace.js';

function recordingScheduler(): Scheduler {
  return {
    setTimer: () => 0,
    clearTimer: () => undefined,
    now: () => 0,
  };
}

function workspaceOf(version: number, layout: WorkspaceLayout): Workspace {
  return {
    workspaceId: 7,
    name: 'Default',
    isActive: true,
    version,
    layout,
    updatedAt: '2026-09-15T18:41:28.000Z',
  };
}

interface Counted {
  api: WorkspaceApi;
  /** How many `GET /workspace`s the store issued. */
  loads(): number;
}

function countingApi(): Counted {
  let loads = 0;
  return {
    api: {
      getActive: () => {
        loads += 1;
        return Promise.resolve(workspaceOf(4, structuredClone(DEFAULT_LAYOUT)));
      },
      putActive: () => Promise.reject(new Error('not expected')),
    },
    loads: () => loads,
  };
}

beforeEach(() => {
  useWorkspaceStore.getState().reset();
  usePanelsStore.getState().reset();
  useSessionStore.getState().reset();
  useSubscriptionsStore.getState().reset();
  useSettingsStore.getState().reset();
  useWorkspaceStore.getState().configure({ scheduler: recordingScheduler() });
});

afterEach(() => {
  useWorkspaceStore.getState().reset();
  usePanelsStore.getState().reset();
});

describe('the workspace restore, under the StrictMode the application runs in', () => {
  it('fetches the layout once and calls onRestored once', async () => {
    const counted = countingApi();
    let restores = 0;

    render(
      <StrictMode>
        <Shell
          workspace={counted.api}
          onRestored={() => {
            restores += 1;
          }}
        />
      </StrictMode>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(counted.loads(), 'GET /workspace was issued more than once for one page load').toBe(1);
    expect(restores, 'every panel of the desk was re-run twice').toBe(1);
    // And it did happen: a guard that simply never restored would satisfy both counts at zero.
    expect(useWorkspaceStore.getState().version).toBe(4);
  });

  it('still restores when a host genuinely swaps the workspace api', async () => {
    const first = countingApi();
    const second = countingApi();
    let restores = 0;
    const onRestored = (): void => {
      restores += 1;
    };

    const { rerender } = render(
      <StrictMode>
        <Shell workspace={first.api} onRestored={onRestored} />
      </StrictMode>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(restores).toBe(1);

    // The guard is keyed on the api object, not on "has ever run": a second server (or a test's
    // second app) is a different desk and has to be fetched and restored.
    rerender(
      <StrictMode>
        <Shell workspace={second.api} onRestored={onRestored} />
      </StrictMode>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(first.loads()).toBe(1);
    expect(second.loads()).toBe(1);
    expect(restores).toBe(2);
  });
});
