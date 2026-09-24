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

import { useEffect } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

import type { LiveState } from '@terminal/sdk';

import type { WidgetRegistry } from '../screen/widgets/registry.js';
import { resolveTheme, useSettingsStore } from '../state/settings.js';
import { useWorkspaceStore } from '../state/workspace.js';
import type { Scheduler, WorkspaceApi } from '../state/workspace.js';

import { PanelGrid } from './PanelGrid.js';
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

  // Load the workspace. `configure` is separate from `load` in the store so that a caller can swap
  // the scheduler without re-fetching; here they happen together, once.
  useEffect(() => {
    if (workspace === undefined) return;
    const store = useWorkspaceStore.getState();
    store.configure({
      api: workspace,
      ...(scheduler === undefined ? {} : { scheduler }),
    });
    void store.load().then(() => {
      onRestored?.();
    });
  }, [workspace, scheduler, onRestored]);

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
