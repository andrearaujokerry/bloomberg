// packages/web/src/shell/Shell.tsx — the terminal, assembled.
//
// CLIENT.md §1 L53 and §2 L197-203: `<PanelGrid/>` + `<KeyBar/>` + `<StatusBar/>` + the overlays
// root, and the workspace lifecycle around them. WP-01's `App.tsx` is the session gate and renders
// this once the plant has said who the user is; `main.tsx` installs the keyboard dispatcher.
// Neither of those files is edited here, so `Shell` is an ordinary exported component and the wiring
// is one line in `App.tsx`.
//
// What this file actually owns is the workspace (TERM-05), and the whole of it is one sentence: a
// desk layout that comes back tomorrow, and a save that says so when it could not happen.
//
//   * **Load.** `workspaceStore.load()` on mount, which hydrates the panels store from the server's
//     layout. Panels whose top frame carries a function are re-run by the dispatcher with
//     `launchKind: 'refresh'`; that is `PanelActions`' job, because it needs the SDK, and the Shell
//     supplies the hook (`onRestored`) rather than the request.
//   * **Save.** Nothing here calls `PUT`. `state/panels.ts` marks sections dirty as the user works
//     and `state/workspace.ts` owns the 2 s debounce, the 10 s max wait and the version. The Shell
//     adds the one thing a store cannot see: the page going away. `visibilitychange → hidden` and
//     `pagehide` flush immediately, because a laptop lid closing is the most common way a layout
//     is lost, and it is lost silently.
//   * **Conflict.** A `409` that survived the merge and the single retry is rendered by
//     `StatusBar` as an `alert` with two actions. It is deliberately not a toast: a toast
//     auto-dismisses, and a dismissed conflict is a desk layout quietly replaced by another
//     window's.
//
// Theme and density live on `<html>` (CLIENT §12.3) and are per device, so the Shell reflects the
// settings store onto the document rather than styling anything itself.

import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

import type { LiveState } from '@terminal/sdk';

import type { WidgetRegistry } from '../screen/widgets/registry.js';
import { resolveTheme, useSettingsStore } from '../state/settings.js';
import { useWorkspaceStore } from '../state/workspace.js';
import type { Scheduler, WorkspaceApi } from '../state/workspace.js';

import { PanelGrid } from './PanelGrid.js';
import type { PanelKeyContext } from './Panel.js';
import type { PanelActions, PanelSlots, ScreenRegistry } from './Panel.js';
import { StatusBar } from './StatusBar.js';

const S = {
  shell: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    background: 'var(--c-bg)',
    color: 'var(--c-value)',
  },
} satisfies Record<string, CSSProperties>;

export interface ShellProps {
  /**
   * The workspace namespace of the page's one SDK client. Given one, the Shell configures the
   * store and loads on mount; given none (a component test, a preview), the panels store keeps
   * whatever was put in it and nothing is ever saved.
   */
  workspace?: WorkspaceApi | undefined;
  /** Timers and the clock for the autosave debounce; a test injects its own (TESTING §2.2). */
  scheduler?: Scheduler | undefined;
  /** Called once after a workspace has hydrated, so restored frames can be re-run (TERM-05). */
  onRestored?: (() => void) | undefined;
  /** `LiveClient.state` for the status bar; WP-13 owns the socket. */
  connection?: LiveState | undefined;
  /** `ScreenCtx` performed against the SDK — `command/dispatch.ts`, wired once by the caller. */
  actions?: PanelActions | undefined;
  /** The command line, the autocomplete and the per-panel overlays. */
  slots?: PanelSlots | undefined;
  /** WP-13's `LiveGrid` and WP-14's `ChartCanvas`, when they exist. */
  widgets?: WidgetRegistry | undefined;
  screens?: ScreenRegistry | undefined;
  /**
   * The focused panel's focus model, published for the window key dispatcher (TERM-06/TERM-07).
   * The Shell only forwards it; the composition root is what builds a `KeyboardHost` from it.
   */
  onKeyContext?: ((context: PanelKeyContext) => void) | undefined;
  /** `KeyBar.tsx` — between the panels and the status bar (CLIENT §3.3). */
  keyBar?: ReactNode;
  /** Page-level overlays: the lock screen and the toasts, which are not per panel. */
  overlays?: ReactNode;
  /** `web/0.1.0`, and the server clock, both already rendered by their owners. */
  clientVersion?: string | undefined;
  clock?: string | undefined;
}

export function Shell({
  workspace,
  scheduler,
  onRestored,
  connection,
  actions,
  slots,
  widgets,
  screens,
  onKeyContext,
  keyBar,
  overlays,
  clientVersion,
  clock,
}: ShellProps): ReactElement {
  const theme = useSettingsStore((s) => s.theme);
  const density = useSettingsStore((s) => s.density);

  // `<html data-theme data-density>` — CLIENT §12.3. The settings store is per device and is the
  // source of truth from here on; `main.tsx` only seeded the attributes so the first paint is not
  // unstyled.
  useEffect(() => {
    const root = globalThis.document?.documentElement;
    if (root === undefined) return;
    const prefersDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
    root.dataset.theme = resolveTheme(theme, prefersDark);
    root.dataset.density = density;
  }, [theme, density]);

  // Configure the store. Separate from the load below because `configure` is separate in the store:
  // a caller may swap the scheduler — a test injecting a virtual one — and must not re-fetch the
  // layout to do it.
  useEffect(() => {
    if (workspace === undefined) return;
    useWorkspaceStore.getState().configure({
      api: workspace,
      ...(scheduler === undefined ? {} : { scheduler }),
    });
  }, [workspace, scheduler]);

  /**
   * ONE LOAD, ONE RESTORE, per workspace API — whatever React does to this component.
   *
   * `load()` is a fetch and `onRestored()` re-runs every panel's function, so this effect is not
   * idempotent in the way `useEffect` assumes: running it twice costs two `GET /workspace`s, two
   * `POST /functions/<code>/run`s per panel and two `fn.launch` rows against the user's quota, under
   * two different trace ids. Measured off the wire on one authenticated load of the seeded desk
   * before this guard: `auth/session` ×2, `workspace` ×2, and `WEI`, `GP`, `W` and `TOP` ×2 each;
   * the plant's own `usage_events` agreed at `fn.launch W=6/6, GP=6/6, WEI=6/6` over three loads.
   *
   * The cause was React StrictMode (`main.tsx`), which mounts, tears down and re-mounts every
   * component in development precisely to expose an effect that cannot be run twice. Making
   * `onRestored` identity-stable — `App.tsx` does, and for its own separate reason — removes the
   * re-runs that a changing dependency caused but not this one, because StrictMode re-runs the
   * effect with the dependencies unchanged.
   *
   * A ref is the guard rather than a store flag because a ref survives StrictMode's simulated
   * remount (it is the same component instance) while a fresh `useState` would not, and because the
   * condition is about this Shell's lifetime, not about the store's contents: a `load()` that failed
   * must not be silently retried by the next render either — the workspace store reports its own
   * error, and a retry loop behind the user's back is worse than one honest failure. Keyed on the
   * api object so a host that genuinely swaps workspaces (a different server, a test's second app)
   * still gets its load.
   *
   * AND DELIBERATELY NO CLEANUP. The obvious companion — an `alive` flag that suppresses
   * `onRestored` after unmount — breaks the restore outright under the very mode this guard exists
   * for: StrictMode's cleanup would clear the flag of the invocation that owns the in-flight load,
   * the second invocation would return early on the ref, and nothing would ever restore. There is
   * nothing for a cleanup to protect in any case, because `onRestored` writes through
   * `usePanelsStore.getState()` — a module singleton, not this component's state — so a late call
   * cannot touch an unmounted tree.
   */
  const restoredFor = useRef<WorkspaceApi | null>(null);
  useEffect(() => {
    if (workspace === undefined) return;
    if (restoredFor.current === workspace) return;
    restoredFor.current = workspace;
    void useWorkspaceStore
      .getState()
      .load()
      .then(() => {
        onRestored?.();
      });
  }, [workspace, onRestored]);

  // The page going away is the one save the debounce cannot cover.
  useEffect(() => {
    if (workspace === undefined) return undefined;
    const flush = (): void => {
      void useWorkspaceStore.getState().flush();
    };
    const onVisibility = (): void => {
      if (globalThis.document?.visibilityState === 'hidden') flush();
    };
    globalThis.addEventListener('pagehide', flush);
    globalThis.document?.addEventListener('visibilitychange', onVisibility);
    return () => {
      globalThis.removeEventListener('pagehide', flush);
      globalThis.document?.removeEventListener('visibilitychange', onVisibility);
    };
  }, [workspace]);

  return (
    <div style={S.shell} data-testid="shell">
      <PanelGrid
        actions={actions}
        slots={slots}
        widgets={widgets}
        screens={screens}
        onKeyContext={onKeyContext}
      />
      {keyBar}
      <StatusBar
        connection={connection}
        clock={clock}
        clientVersion={clientVersion}
      />
      {overlays}
    </div>
  );
}

export default Shell;
