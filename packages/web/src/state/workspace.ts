// packages/web/src/state/workspace.ts — the layout that outlives the tab (TERM-05).
//
// CLIENT.md §7 L472-520 and §8. The whole file exists for one sentence of the design: a `PUT` of
// the workspace carries **the version it read**, and a `409 WORKSPACE_VERSION_CONFLICT` means
// another window or another device saved in between.
//
// A 409 is not an error to swallow. Swallowing it has exactly one visible consequence — the user's
// panels silently become someone else's — and it is invisible until the next morning, when the
// layout they spent a week arranging is gone and nothing ever said so. So:
//
//   1. merge `details.current` with the local layout PER KEY (dirty keys keep the local value,
//      everything else takes the server's, panels merge by id) and retry ONCE with the server's
//      version — the ordinary case of two windows autosaving a second apart;
//   2. a second 409 means the other writer is still going. Stop. `status: 'conflict'`, the server
//      copy kept beside ours in `conflict`, `dirty` NOT cleared, and the user chooses: R reloads
//      the server copy, K re-reads the version and forces ours (CLIENT §7.2 step 3).
//
// The local layout is never overwritten by a failed save. `serverLayout` only ever holds what the
// server acknowledged, and `conflict.serverLayout` only ever holds what a 409 actually carried: a
// 409 whose `details.current` we cannot parse leaves it NULL. Filling it with our own last-known
// copy would leave "R reload theirs" reloading ours under the server's name, which is the same
// silent loss as swallowing the 409, only harder to notice because the user was asked first.
//
// Ports, not imports: the REST namespace and the timer source are injected through `configure()`.
// All IO remains the SDK's (API-05); what this file owns is *when* and *with which version*. The
// scheduler port is also why the tests drive the 2 s debounce without a single `setTimeout`
// (TESTING §2.2: a web test drives frames, never wall-clock waits).
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

import { WorkspaceLayout as WorkspaceLayoutSchema } from '@terminal/sdk/wire/rest/workspaces';
import type {
  MonitorSpec,
  PanelState,
  Workspace,
  WorkspaceLayout,
} from '@terminal/sdk/wire/rest/workspaces';

/* ---------------------------------------------------------------------------------------------- */
/* Ports                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/** The slice of `TerminalClient['workspace']` this store calls (API.md §5.7). */
export interface WorkspaceApi {
  getActive(): Promise<Workspace>;
  putActive(args: {
    body: { version: number; layout: WorkspaceLayout };
  }): Promise<{ version: number; updatedAt: string }>;
}

/** Timers and the clock, injected so tests never wait on wall time. */
export interface Scheduler {
  setTimer(fn: () => void, ms: number): number;
  clearTimer(handle: number): void;
  now(): number;
}

const defaultScheduler: Scheduler = {
  setTimer: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimer: (handle) => {
    globalThis.clearTimeout(handle);
  },
  now: () => Date.now(),
};

/**
 * `panelsStore` owns the `panels`/`focus`/`mode` third of the layout. It registers itself here at
 * module load, which keeps the dependency one-way (`panels.ts` → `workspace.ts`) and the cycle the
 * obvious `import { usePanelsStore }` would create out of the graph.
 */
export interface PanelsSection {
  panels: PanelState[];
  focus: string;
  mode: WorkspaceLayout['mode'];
}
export interface PanelsPort {
  toLayout(): PanelsSection;
  fromLayout(layout: WorkspaceLayout): void;
}

let panelsPort: PanelsPort | null = null;

export function registerPanels(port: PanelsPort): void {
  panelsPort = port;
}

/* ---------------------------------------------------------------------------------------------- */
/* The layout                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** The seed shape (API.md §5.7; the server's `DEFAULT_WORKSPACE_LAYOUT`). */
export const DEFAULT_LAYOUT: WorkspaceLayout = WorkspaceLayoutSchema.parse({
  schema: 1,
  mode: '1',
  panels: [{ id: 'p1', frameStack: [], index: 0, history: [] }],
  focus: 'p1',
});

/**
 * CLIENT §7.2 step 5. `schema` 1 is today's only schema, so the forward migration is the identity;
 * anything else (or anything the wire schema rejects) falls back to the default layout and reports
 * `migrated: true` so the shell can say so instead of showing a blank workspace.
 */
export function migrateLayout(raw: unknown): { layout: WorkspaceLayout; migrated: boolean } {
  const parsed = WorkspaceLayoutSchema.safeParse(raw);
  if (parsed.success) return { layout: parsed.data, migrated: false };
  return { layout: structuredClone(DEFAULT_LAYOUT), migrated: true };
}

/** The six keys that are not panels, plus `panel:<id>` for each panel (CLIENT §7.2). */
export type SectionKey = 'mode' | 'focus' | 'monitors' | 'chart' | 'conflationMs' | 'windows';
export type DirtyKey = SectionKey | `panel:${string}`;

/** The non-panel sections this store owns outright. */
export interface OwnSections {
  monitors: MonitorSpec[];
  chart: WorkspaceLayout['chart'];
  conflationMs: number;
  windows: WorkspaceLayout['windows'];
}

export const DEBOUNCE_MS = 2_000;
export const MAX_WAIT_MS = 10_000;

export type WorkspaceStatus = 'idle' | 'saving' | 'conflict' | 'error';

/**
 * What a 409 told us about the copy that beat ours. Both halves are nullable, and neither is ever
 * filled in from local state: `serverVersion: null` means the response did not name a version, and
 * `serverLayout: null` means it did not carry a layout we could parse. Substituting our own
 * `serverLayout` here would make "R reload theirs" reload OUR last-known copy under the server's
 * name — the same silent layout loss this file exists to prevent, wearing a reassuring label.
 */
export interface WorkspaceConflict {
  serverVersion: number | null;
  serverLayout: WorkspaceLayout | null;
}

export interface WorkspaceStore extends OwnSections {
  workspaceId: number | null;
  name: string;
  version: number;
  serverLayout: WorkspaceLayout | null;
  dirty: ReadonlySet<string>;
  status: WorkspaceStatus;
  lastSavedAt: number | null;
  /** Set only after a second 409: the server copy, kept beside ours until the user chooses. */
  conflict: WorkspaceConflict | null;
  /** The last save/load failure, and the migration notice, for the status bar and the toast. */
  error: { code: string; message: string } | null;
  migrated: boolean;

  configure(opts: { api?: WorkspaceApi; scheduler?: Scheduler }): void;
  hydrate(ws: Workspace): void;
  load(): Promise<void>;
  markDirty(key: DirtyKey): void;
  setSection<K extends keyof OwnSections>(key: K, value: OwnSections[K]): void;
  toLayout(): WorkspaceLayout;
  saveNow(): Promise<void>;
  /** `visibilitychange → hidden` / `pagehide`: save immediately when dirty, best effort. */
  flush(): Promise<void>;
  resolveConflict(choice: 'reload' | 'keep-mine'): Promise<void>;
  reset(): void;
}

/* ---------------------------------------------------------------------------------------------- */
/* Merge                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * CLIENT §7.2 step 3, last-writer-wins PER KEY rather than per document: a key this client has
 * touched since its last successful save keeps the local value; every other key takes the server's.
 * Panels merge by id under the same rule, and a panel that exists on only one side is kept — losing
 * a panel because the other window had not seen it yet is the same silent loss in miniature.
 */
export function mergeLayouts(
  local: WorkspaceLayout,
  server: WorkspaceLayout,
  dirty: ReadonlySet<string>,
): WorkspaceLayout {
  const pick = <K extends keyof WorkspaceLayout>(key: K & SectionKey): WorkspaceLayout[K] =>
    dirty.has(key) ? local[key] : server[key];

  const byId = new Map<string, PanelState>();
  for (const panel of server.panels) byId.set(panel.id, panel);
  for (const panel of local.panels) {
    if (dirty.has(`panel:${panel.id}`) || !byId.has(panel.id)) byId.set(panel.id, panel);
  }
  // Local order first (it is the order the user is looking at), then server-only panels.
  const order = [...local.panels.map((p) => p.id)];
  for (const panel of server.panels) if (!order.includes(panel.id)) order.push(panel.id);
  const panels = order.flatMap((id) => {
    const panel = byId.get(id);
    return panel === undefined ? [] : [panel];
  });

  const focus = pick('focus');
  return {
    schema: 1,
    mode: pick('mode'),
    panels,
    focus: panels.some((p) => p.id === focus) ? focus : (panels[0]?.id ?? 'p1'),
    monitors: pick('monitors'),
    chart: pick('chart'),
    conflationMs: pick('conflationMs'),
    windows: pick('windows'),
  };
}

/**
 * `409` carries `details.current`, which may be the whole `Workspace` or just its layout. The two
 * halves are reported separately on purpose: the version is a plain number that survives a layout
 * we cannot parse, and it is what the message and `K keep mine` need. `layout: null` says the
 * server's copy did not arrive in a usable shape, and the caller must leave it null rather than
 * reach for `serverLayout`.
 */
function conflictCurrent(err: unknown): { version: number; layout: WorkspaceLayout | null } | null {
  if (typeof err !== 'object' || err === null) return null;
  const details = (err as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return null;
  const current = (details as { current?: unknown }).current;
  if (typeof current !== 'object' || current === null) return null;
  const bag = current as { version?: unknown; layout?: unknown };
  if (typeof bag.version !== 'number') return null;
  const parsed = WorkspaceLayoutSchema.safeParse(bag.layout ?? current);
  return { version: bag.version, layout: parsed.success ? parsed.data : null };
}

function isConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const bag = err as { status?: unknown; code?: unknown };
  return bag.status === 409 || bag.code === 'WORKSPACE_VERSION_CONFLICT';
}

function errorOf(err: unknown): { code: string; message: string } {
  if (typeof err === 'object' && err !== null) {
    const bag = err as { code?: unknown; message?: unknown };
    return {
      code: typeof bag.code === 'string' ? bag.code : 'UNKNOWN',
      message: typeof bag.message === 'string' ? bag.message : 'unknown error',
    };
  }
  return { code: 'UNKNOWN', message: typeof err === 'string' ? err : 'unknown error' };
}

/* ---------------------------------------------------------------------------------------------- */
/* The store                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

let api: WorkspaceApi | null = null;
let scheduler: Scheduler = defaultScheduler;
let timer: number | null = null;
/** When the current debounce window opened, for the 10 s max wait. */
let firstDirtyAt: number | null = null;

function clearTimer(): void {
  if (timer !== null) {
    scheduler.clearTimer(timer);
    timer = null;
  }
}

const INITIAL = {
  workspaceId: null,
  name: '',
  version: 0,
  serverLayout: null,
  dirty: new Set<string>() as ReadonlySet<string>,
  status: 'idle' as WorkspaceStatus,
  lastSavedAt: null,
  conflict: null,
  error: null,
  migrated: false,
  monitors: [] as MonitorSpec[],
  chart: structuredClone(DEFAULT_LAYOUT.chart),
  conflationMs: DEFAULT_LAYOUT.conflationMs,
  windows: [] as WorkspaceLayout['windows'],
};

export const useWorkspaceStore = create<WorkspaceStore>()(
  subscribeWithSelector((set, get) => ({
    ...INITIAL,

    configure(opts) {
      if (opts.api !== undefined) api = opts.api;
      if (opts.scheduler !== undefined) {
        clearTimer();
        scheduler = opts.scheduler;
      }
    },

    hydrate(ws) {
      const { layout, migrated } = migrateLayout(ws.layout);
      clearTimer();
      firstDirtyAt = null;
      set({
        workspaceId: ws.workspaceId,
        name: ws.name,
        version: ws.version,
        serverLayout: layout,
        dirty: new Set<string>(),
        status: 'idle',
        conflict: null,
        error: null,
        migrated,
        monitors: layout.monitors,
        chart: layout.chart,
        conflationMs: layout.conflationMs,
        windows: layout.windows,
      });
      panelsPort?.fromLayout(layout);
    },

    async load() {
      const client = api;
      if (client === null) {
        set({ status: 'error', error: { code: 'NOT_CONFIGURED', message: 'no workspace api' } });
        return;
      }
      try {
        const ws = await client.getActive();
        get().hydrate(ws);
      } catch (err) {
        set({ status: 'error', error: errorOf(err) });
      }
    },

    markDirty(key) {
      const dirty = new Set(get().dirty);
      dirty.add(key);
      set({ dirty });
      // A conflict awaiting the user's choice must not be overwritten by the autosave that the
      // next keystroke schedules; the user answers R or K first.
      if (get().status === 'conflict') return;
      const now = scheduler.now();
      firstDirtyAt ??= now;
      const waited = now - firstDirtyAt;
      const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - waited));
      clearTimer();
      timer = scheduler.setTimer(() => {
        timer = null;
        void get().saveNow();
      }, delay);
    },

    setSection<K extends keyof OwnSections>(key: K, value: OwnSections[K]) {
      set({ [key]: value } as Pick<OwnSections, K>);
      get().markDirty(key);
    },

    toLayout() {
      const s = get();
      const section = panelsPort?.toLayout() ?? {
        panels: s.serverLayout?.panels ?? DEFAULT_LAYOUT.panels,
        focus: s.serverLayout?.focus ?? DEFAULT_LAYOUT.focus,
        mode: s.serverLayout?.mode ?? DEFAULT_LAYOUT.mode,
      };
      return {
        schema: 1,
        mode: section.mode,
        panels: section.panels,
        focus: section.focus,
        monitors: s.monitors,
        chart: s.chart,
        conflationMs: s.conflationMs,
        windows: s.windows,
      };
    },

    async saveNow() {
      const client = api;
      if (client === null) {
        // A scheduled save with no client attached is a wiring bug, not a user-visible failure —
        // and it arrives on a timer, where a throw would be an unhandled rejection nobody sees.
        set({ status: 'error', error: { code: 'NOT_CONFIGURED', message: 'no workspace api' } });
        return;
      }
      const s = get();
      if (s.workspaceId === null) return;
      clearTimer();

      const layout = get().toLayout();
      // The wire schema is normative: a layout it rejects is a bug here, and sending it would earn
      // a 422 that looks like a conflict to the user.
      const validated = WorkspaceLayoutSchema.safeParse(layout);
      if (!validated.success) {
        set({ status: 'error', error: { code: 'VALIDATION_FAILED', message: 'invalid layout' } });
        return;
      }

      const sent = new Set(s.dirty);
      // The max-wait window closes here, not when the response lands: an edit made DURING the
      // flight opens a fresh 2 s window of its own rather than inheriting an already-expired one
      // and firing a second PUT immediately (the route allows 1 req/s, API.md §8).
      firstDirtyAt = null;
      set({ status: 'saving', error: null });

      const put = async (version: number, body: WorkspaceLayout): Promise<void> => {
        const res = await client.putActive({ body: { version, layout: body } });
        const remaining = new Set(get().dirty);
        for (const key of sent) remaining.delete(key);
        set({
          version: res.version,
          serverLayout: body,
          dirty: remaining,
          status: 'idle',
          conflict: null,
          lastSavedAt: scheduler.now(),
        });
      };

      try {
        await put(s.version, validated.data);
      } catch (err) {
        if (!isConflict(err)) {
          set({ status: 'error', error: errorOf(err) });
          return;
        }
        const current = conflictCurrent(err);
        if (current?.layout == null) {
          // A 409 we cannot merge — no `details.current`, or a `current` whose layout the wire
          // schema rejects. There is nothing to merge against, so we do not retry. We report the
          // version the server named when it named one (it is what the message and `K` need) and
          // leave `serverLayout` null: we were not given theirs, and ours is not a substitute.
          set({
            status: 'conflict',
            error: errorOf(err),
            conflict: { serverVersion: current?.version ?? null, serverLayout: null },
          });
          return;
        }
        const theirLayout = current.layout;
        const merged = mergeLayouts(validated.data, theirLayout, sent);
        try {
          // Retry ONCE, with the version the server just told us about.
          await put(current.version, merged);
          panelsPort?.fromLayout(merged);
          set({
            monitors: merged.monitors,
            chart: merged.chart,
            conflationMs: merged.conflationMs,
            windows: merged.windows,
          });
        } catch (err2) {
          if (!isConflict(err2)) {
            set({ status: 'error', error: errorOf(err2) });
            return;
          }
          // Two conflicts in a row: somebody else is actively writing. The user decides; nothing
          // local is thrown away and `dirty` is left exactly as it was.
          //
          // The version and the layout are taken from the SAME response or from neither: when the
          // second 409 names version 11 but carries a layout we cannot parse, pairing 11 with the
          // layout from the first 409 would label a version-9 copy as version 11.
          const second = conflictCurrent(err2);
          const pair = second ?? { version: current.version, layout: theirLayout };
          set({
            status: 'conflict',
            error: errorOf(err2),
            conflict: { serverVersion: pair.version, serverLayout: pair.layout },
          });
        }
      }
    },

    async flush() {
      if (get().dirty.size === 0) return;
      clearTimer();
      await get().saveNow();
    },

    async resolveConflict(choice) {
      const conflict = get().conflict;
      if (conflict === null) return;
      if (choice === 'reload') {
        if (conflict.serverLayout === null) {
          // We never received a usable server copy, so "reload theirs" has to go and fetch it. The
          // alternative — re-applying `serverLayout`, our own last acknowledged copy — would look
          // identical to the user and quietly discard whatever the other window actually wrote.
          const reader = api;
          if (reader === null) {
            set({ status: 'error', error: { code: 'NOT_CONFIGURED', message: 'no workspace api' } });
            return;
          }
          try {
            get().hydrate(await reader.getActive());
          } catch (err) {
            // The conflict stays up: the user has still not chosen, and the status bar must keep
            // asking rather than fall back to a state where nothing is pending.
            set({ status: 'conflict', error: errorOf(err) });
          }
          return;
        }
        const theirs = conflict.serverLayout;
        get().hydrate({
          workspaceId: get().workspaceId ?? 0,
          name: get().name,
          isActive: true,
          version: conflict.serverVersion ?? get().version,
          layout: theirs,
          updatedAt: new Date(scheduler.now()).toISOString(),
        });
        return;
      }
      const client = api;
      if (client === null) {
        set({ status: 'error', error: { code: 'NOT_CONFIGURED', message: 'no workspace api' } });
        return;
      }
      // Keep mine: re-read for the newest version, then send the local layout against it.
      try {
        const ws = await client.getActive();
        set({ version: ws.version, status: 'idle', conflict: null });
        await get().saveNow();
      } catch (err) {
        set({ status: 'error', error: errorOf(err) });
      }
    },

    reset() {
      clearTimer();
      firstDirtyAt = null;
      api = null;
      scheduler = defaultScheduler;
      set({
        ...INITIAL,
        dirty: new Set<string>(),
        chart: structuredClone(DEFAULT_LAYOUT.chart),
        monitors: [],
        windows: [],
      });
    },
  })),
);

/* ---------------------------------------------------------------------------------------------- */
/* Selectors                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

export const selectIsDirty = (s: WorkspaceStore): boolean => s.dirty.size > 0;
export const selectHasConflict = (s: WorkspaceStore): boolean => s.status === 'conflict';
/**
 * The one-line message the status bar shows when a save could not be reconciled (TERM-05).
 *
 * The wording tracks what we actually hold. With their layout in hand, `R` re-applies it locally
 * and the message says "reload theirs". Without it, there is no "theirs" to reload, so the message
 * neither names a version we are guessing at nor promises a copy we do not have: it says the copy
 * did not arrive and offers `R` as a re-read of the server.
 */
export const selectConflictMessage = (s: WorkspaceStore): string | null => {
  if (s.status !== 'conflict' || s.conflict === null) return null;
  const { serverVersion, serverLayout } = s.conflict;
  const named =
    serverVersion === null ? 'server version unknown' : `server version ${String(serverVersion)}`;
  return serverLayout === null
    ? `Workspace saved elsewhere (${named}); their copy did not arrive. ` +
        'R re-read theirs · K keep mine'
    : `Workspace saved elsewhere (${named}). R reload theirs · K keep mine`;
};

/** True when `conflict.serverLayout` holds the server's copy, so `R` is a local re-apply. */
export const selectHasServerCopy = (s: WorkspaceStore): boolean =>
  s.status === 'conflict' && s.conflict?.serverLayout != null;
