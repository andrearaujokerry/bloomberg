// packages/web/src/state/panels.ts — 1/2/4 panels, the per-panel frame stack, and who has focus.
//
// CLIENT.md §8 L573-596, FUNCTIONS.md §2.5 L785-791, TERM-04. One concern: what each panel is
// showing and how the user walks back through what it showed before.
//
// The frame stack is a browser history, not a stack of pushes: `index` points at the frame on
// screen, `goBack`/`goForward` move it, and a NEW launch from anywhere but the top TRUNCATES the
// forward history (§2.5 L786). That truncation is the rule worth writing a test for — a panel that
// keeps stale forward frames after a new command lets `Alt+→` walk into a screen the user never
// asked for, which reads as the terminal doing something on its own.
//
// What is persisted is the wire `PanelState` (API.md §5.7) and nothing else: `payload`, `meta`,
// `instrument`, `error` and the paint timestamps are runtime-only, because a workspace row is a
// layout, not a cache. `toLayout()` is the projection and it is the only place that decides so.
//
// This store marks the workspace dirty; it never saves. `workspace.ts` owns the debounce and the
// version, and the dependency runs one way (`panels.ts` → `workspace.ts`) with the panels half of
// the layout handed over through `registerPanels`.
import type { Candidate } from '@terminal/core';
import type { InstrumentSummary, PayloadMeta } from '@terminal/sdk';
import type { PanelState, WorkspaceLayout } from '@terminal/sdk/wire/rest/workspaces';
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

import type { FocusRegion } from '../keyboard/focus.js';

import type { DirtyKey } from './workspace.js';
import { registerPanels, useWorkspaceStore } from './workspace.js';

/* ---------------------------------------------------------------------------------------------- */
/* Shapes                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** A resolved instrument, never a bare ticker (REF-01). */
export interface FrameSecurity {
  id: number;
  display: string;
}

export type FrameStatus = 'idle' | 'loading' | 'ready' | 'error';

/** CLIENT §8 L574-577: the persisted five fields, then the runtime ones. */
export interface Frame {
  security: FrameSecurity | null;
  fn: string | null;
  params: Record<string, unknown>;
  resultId: string | null;
  scroll: number;

  /** minted per launch by `command/dispatch.ts` (OPS-07); `''` on a frame restored from a layout. */
  traceId: string;
  status: FrameStatus;
  payload?: unknown;
  meta?: PayloadMeta;
  instrument?: InstrumentSummary | null;
  error?: { code: string; message: string; traceId: string; details?: Record<string, unknown> };
  startedAt?: number;
  firstPaintAt?: number;
}

/** What `pushFrame` needs; everything else takes its default. */
export interface FrameInput {
  security: FrameSecurity | null;
  fn: string | null;
  traceId: string;
  params?: Record<string, unknown>;
  resultId?: string | null;
  scroll?: number;
  instrument?: InstrumentSummary | null;
  startedAt?: number;
}

export type PanelOverlay = Extract<FocusRegion, { kind: 'overlay' }>;

export interface AutocompleteState {
  rows: Candidate[];
  selected: number;
  open: boolean;
}

export interface PanelRuntime {
  id: string;
  frameStack: Frame[];
  index: number;
  history: string[];
  commandDraft: string;
  overlay: PanelOverlay | null;
  ac: AutocompleteState;
}

export type LayoutMode = WorkspaceLayout['mode'];

/** How many panels each mode shows (CLIENT §3.1, `PanelGrid`). */
export const PANEL_COUNT: Readonly<Record<LayoutMode, number>> = Object.freeze({
  '1': 1,
  '2h': 2,
  '2v': 2,
  '4': 4,
});

/** `PanelState.frameStack` is `.max(50)` on the wire (API.md §5.7). */
export const MAX_FRAMES = 50;
/** `PanelState.history` is `.max(100)`. */
export const MAX_HISTORY = 100;
/** `PanelState.commandDraft` is `.max(200)`. */
export const MAX_DRAFT = 200;
/** `p1`…`p8`. */
export const MAX_PANELS = 8;

export interface PanelsStore {
  panels: Record<string, PanelRuntime>;
  /** Panel ids in layout order; `panels` is a map, and a map has no order to persist. */
  order: string[];
  focus: string;
  mode: LayoutMode;
  visible: string[];

  fromLayout(layout: WorkspaceLayout): void;
  toLayout(): Pick<WorkspaceLayout, 'panels' | 'focus' | 'mode'>;

  setDraft(panelId: string, value: string): void;
  setAc(panelId: string, ac: AutocompleteState): void;
  pushFrame(panelId: string, frame: FrameInput): void;
  replaceFrame(panelId: string, patch: Partial<Frame>): void;
  pushHistory(panelId: string, command: string): void;
  goBack(panelId: string): boolean;
  goForward(panelId: string): boolean;
  popFrame(panelId: string): boolean;
  /** `/clear` — empties the panel's frame stack (FUNCTIONS §2.6). */
  clearFrames(panelId: string): void;
  setFocus(panelId: string): void;
  setMode(mode: LayoutMode): void;
  showPanel(panelId: string): void;
  setOverlay(panelId: string, overlay: PanelOverlay | null): void;
  reset(): void;
}

/* ---------------------------------------------------------------------------------------------- */
/* Helpers                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

export function emptyPanel(id: string): PanelRuntime {
  return {
    id,
    frameStack: [],
    index: 0,
    history: [],
    commandDraft: '',
    overlay: null,
    ac: { rows: [], selected: 0, open: false },
  };
}

function frameOf(input: FrameInput): Frame {
  const frame: Frame = {
    security: input.security,
    fn: input.fn,
    params: input.params ?? {},
    resultId: input.resultId ?? null,
    scroll: input.scroll ?? 0,
    traceId: input.traceId,
    status: 'idle',
  };
  if (input.instrument !== undefined) frame.instrument = input.instrument;
  if (input.startedAt !== undefined) frame.startedAt = input.startedAt;
  return frame;
}

/** The persisted projection of a runtime frame — the wire's five fields, nothing else. */
function toWireFrame(frame: Frame): PanelState['frameStack'][number] {
  return {
    security: frame.security === null ? null : { id: frame.security.id, display: frame.security.display },
    fn: frame.fn,
    params: frame.params,
    resultId: frame.resultId,
    scroll: frame.scroll,
  };
}

function fromWireFrame(frame: PanelState['frameStack'][number]): Frame {
  return {
    security: frame.security,
    fn: frame.fn,
    params: frame.params,
    resultId: frame.resultId,
    scroll: frame.scroll,
    traceId: '',
    status: 'idle',
  };
}

/**
 * Which panels the grid shows. The first `n` in layout order, except that the focused panel is
 * always one of them — focus on a panel nobody can see is how a keystroke goes missing (TERM-04).
 */
export function visibleFor(order: string[], mode: LayoutMode, focus: string): string[] {
  const n = Math.min(PANEL_COUNT[mode], order.length);
  const shown = order.slice(0, n);
  if (shown.includes(focus) || !order.includes(focus)) return shown;
  return [...shown.slice(0, n - 1), focus];
}

const INITIAL_ORDER = ['p1'];

function initialState(): Pick<PanelsStore, 'panels' | 'order' | 'focus' | 'mode' | 'visible'> {
  return {
    panels: { p1: emptyPanel('p1') },
    order: [...INITIAL_ORDER],
    focus: 'p1',
    mode: '1',
    visible: ['p1'],
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* The store                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

const markDirty = (key: DirtyKey): void => {
  useWorkspaceStore.getState().markDirty(key);
};

export const usePanelsStore = create<PanelsStore>()(
  subscribeWithSelector((set, get) => {
    /** Replace one panel and recompute `visible`; `dirty` is the caller's decision. */
    const patchPanel = (panelId: string, next: (panel: PanelRuntime) => PanelRuntime): boolean => {
      const panel = get().panels[panelId];
      if (panel === undefined) return false;
      set({ panels: { ...get().panels, [panelId]: next(panel) } });
      return true;
    };

    return {
      ...initialState(),

      fromLayout(layout) {
        const panels: Record<string, PanelRuntime> = {};
        const order: string[] = [];
        for (const state of layout.panels) {
          const runtime = emptyPanel(state.id);
          runtime.frameStack = state.frameStack.map(fromWireFrame);
          runtime.index = Math.max(0, Math.min(state.index, Math.max(0, runtime.frameStack.length - 1)));
          runtime.history = [...state.history];
          runtime.commandDraft = state.commandDraft;
          panels[state.id] = runtime;
          order.push(state.id);
        }
        if (order.length === 0) {
          const base = initialState();
          set(base);
          return;
        }
        const focus = panels[layout.focus] === undefined ? (order[0] ?? 'p1') : layout.focus;
        set({ panels, order, focus, mode: layout.mode, visible: visibleFor(order, layout.mode, focus) });
      },

      toLayout() {
        const s = get();
        const panels: PanelState[] = s.order.flatMap((id) => {
          const panel = s.panels[id];
          if (panel === undefined) return [];
          return [
            {
              id: panel.id,
              frameStack: panel.frameStack.slice(-MAX_FRAMES).map(toWireFrame),
              index: Math.max(0, Math.min(panel.index, Math.max(0, panel.frameStack.length - 1))),
              history: panel.history.slice(-MAX_HISTORY),
              commandDraft: panel.commandDraft.slice(0, MAX_DRAFT),
            },
          ];
        });
        return { panels, focus: s.focus, mode: s.mode };
      },

      setDraft(panelId, value) {
        // Transient: the draft rides along with the next save rather than scheduling one
        // (CLIENT §8 L583) — a keystroke must not cost a PUT.
        patchPanel(panelId, (panel) => ({ ...panel, commandDraft: value.slice(0, MAX_DRAFT) }));
      },

      setAc(panelId, ac) {
        patchPanel(panelId, (panel) => ({ ...panel, ac }));
      },

      pushFrame(panelId, input) {
        const ok = patchPanel(panelId, (panel) => {
          // Truncate forward history, then push (FUNCTIONS §2.5 L786).
          const kept = panel.frameStack.slice(0, panel.index + 1);
          const stack = [...kept, frameOf(input)].slice(-MAX_FRAMES);
          return { ...panel, frameStack: stack, index: stack.length - 1, commandDraft: '' };
        });
        if (ok) markDirty(`panel:${panelId}`);
      },

      replaceFrame(panelId, patch) {
        const ok = patchPanel(panelId, (panel) => {
          const current = panel.frameStack[panel.index];
          if (current === undefined) return panel;
          const stack = [...panel.frameStack];
          stack[panel.index] = { ...current, ...patch };
          return { ...panel, frameStack: stack };
        });
        // `params`, `resultId` and `scroll` are persisted; a payload or a status is not, so only a
        // patch that touches the layout is worth a save.
        const persisted = ['params', 'resultId', 'scroll', 'security', 'fn'] as const;
        if (ok && persisted.some((key) => key in patch)) markDirty(`panel:${panelId}`);
      },

      pushHistory(panelId, command) {
        const text = command.trim();
        if (text === '') return;
        const ok = patchPanel(panelId, (panel) => ({
          ...panel,
          history: [...panel.history, text].slice(-MAX_HISTORY),
        }));
        if (ok) markDirty(`panel:${panelId}`);
      },

      goBack(panelId) {
        const panel = get().panels[panelId];
        if (panel === undefined || panel.index <= 0) return false;
        patchPanel(panelId, (p) => ({ ...p, index: p.index - 1 }));
        markDirty(`panel:${panelId}`);
        return true;
      },

      goForward(panelId) {
        const panel = get().panels[panelId];
        if (panel === undefined || panel.index >= panel.frameStack.length - 1) return false;
        patchPanel(panelId, (p) => ({ ...p, index: p.index + 1 }));
        markDirty(`panel:${panelId}`);
        return true;
      },

      popFrame(panelId) {
        const panel = get().panels[panelId];
        if (panel === undefined || panel.frameStack.length <= 1) return false;
        patchPanel(panelId, (p) => {
          const stack = [...p.frameStack];
          stack.splice(p.index, 1);
          return { ...p, frameStack: stack, index: Math.max(0, Math.min(p.index - 1, stack.length - 1)) };
        });
        markDirty(`panel:${panelId}`);
        return true;
      },

      clearFrames(panelId) {
        const ok = patchPanel(panelId, (panel) => ({
          ...panel,
          frameStack: [],
          index: 0,
          commandDraft: '',
        }));
        if (ok) markDirty(`panel:${panelId}`);
      },

      setFocus(panelId) {
        const s = get();
        if (s.panels[panelId] === undefined || s.focus === panelId) return;
        set({ focus: panelId, visible: visibleFor(s.order, s.mode, panelId) });
        markDirty('focus');
      },

      setMode(mode) {
        const s = get();
        const panels = { ...s.panels };
        const order = [...s.order];
        // Switching up creates the panels the new mode needs; switching down keeps them, because
        // going 4 → 1 → 4 must not destroy what the other three were showing.
        for (let i = order.length; i < Math.min(PANEL_COUNT[mode], MAX_PANELS); i += 1) {
          const id = `p${String(i + 1)}`;
          panels[id] = emptyPanel(id);
          order.push(id);
        }
        const visible = visibleFor(order, mode, s.focus);
        const focus = visible.includes(s.focus) ? s.focus : (visible[0] ?? s.focus);
        set({ panels, order, mode, visible, focus });
        markDirty('mode');
      },

      showPanel(panelId) {
        const s = get();
        if (s.panels[panelId] === undefined || s.visible.includes(panelId)) return;
        const visible = [...s.visible.slice(0, Math.max(0, s.visible.length - 1)), panelId];
        set({ visible });
      },

      setOverlay(panelId, overlay) {
        patchPanel(panelId, (panel) => ({ ...panel, overlay }));
      },

      reset() {
        set(initialState());
      },
    };
  }),
);

// One-way wiring: the workspace store asks for this section when it saves, and hands the layout
// back on load. `workspace.ts` knows nothing about this module (CLIENT §7.2).
registerPanels({
  toLayout: () => usePanelsStore.getState().toLayout(),
  fromLayout: (layout) => {
    usePanelsStore.getState().fromLayout(layout);
  },
});

/* ---------------------------------------------------------------------------------------------- */
/* Selectors (CLIENT §8 L590-596)                                                                   */
/* ---------------------------------------------------------------------------------------------- */

export const selectPanel =
  (id: string) =>
  (s: PanelsStore): PanelRuntime | undefined =>
    s.panels[id];

export const selectFrame =
  (id: string) =>
  (s: PanelsStore): Frame | undefined => {
    const panel = s.panels[id];
    return panel === undefined ? undefined : panel.frameStack[panel.index];
  };

/** What `command/dispatch.ts` applies the TERM-03 context rules to. */
export interface PanelContext {
  security: {
    instrumentId: number;
    assetClass: InstrumentSummary['assetClass'];
    marketSector: InstrumentSummary['marketSector'];
    display: string;
  } | null;
  fn: string | null;
  params: Record<string, unknown>;
}

export const selectPanelContext =
  (id: string) =>
  (s: PanelsStore): PanelContext => {
    const frame = selectFrame(id)(s);
    const instrument = frame?.instrument ?? null;
    return {
      security:
        instrument === null
          ? null
          : {
              instrumentId: instrument.instrumentId,
              assetClass: instrument.assetClass,
              marketSector: instrument.marketSector,
              display: instrument.display,
            },
      fn: frame?.fn ?? null,
      params: frame?.params ?? {},
    };
  };

export const selectFocusedFrame = (s: PanelsStore): Frame | undefined => selectFrame(s.focus)(s);

export const selectCanGoBack =
  (id: string) =>
  (s: PanelsStore): boolean =>
    (s.panels[id]?.index ?? 0) > 0;

export const selectCanGoForward =
  (id: string) =>
  (s: PanelsStore): boolean => {
    const panel = s.panels[id];
    return panel !== undefined && panel.index < panel.frameStack.length - 1;
  };
