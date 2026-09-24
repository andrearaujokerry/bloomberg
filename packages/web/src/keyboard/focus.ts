// packages/web/src/keyboard/focus.ts — the focus ring (CLIENT.md §3.2, TERM-04/TERM-08).
//
// Exactly one panel is focused; within it, focus is a REGION rather than a DOM element: the command
// line, one `ScreenSpec` node, an overlay, or the key bar. Everything here is a pure function over
// an immutable `FocusState`, so the zustand store that owns the state (WP-12 `state/panels.ts`) is
// a thin holder and the movement rules are testable without rendering anything.
//
// Two rules from the design that this file exists to make true:
//
//   * Roving `tabindex` (CLIENT §3.2): the focused element carries `tabIndex=0` and every other
//     focusable element `-1`, so the browser's own Tab order never fights the dispatcher. That is
//     `tabIndexOf`, and it is the only thing a widget needs to ask.
//   * Focus is RESTORED per panel when a frame is popped (`lastNodeByPanel`) and set to
//     `ScreenSpec.initialFocus` when a new payload paints (FUNCTIONS §1.5). Both are transitions
//     here — `enterPanel` and `paint` — not ad-hoc `useEffect`s in the renderer, because two
//     components restoring focus independently is how a terminal ends up fighting its user.
//
// Movement WITHIN a node — row to row in a grid, field to field in a form, tab to tab — belongs to
// the region maps (CLIENT §5.3): the grid's is WP-13's, the chart's WP-14's. What this file owns is
// movement BETWEEN nodes and the one within-node move that is structural rather than visual:
// stepping from a tab strip into the body of its active tab.

import type { Node } from '../screen/types.js';

import type { KeyRegion } from './keymap.js';

/** The overlays a panel can open (CLIENT §3.4); `lock` is page-level and not per panel. */
export type OverlayKind = 'help' | 'ticket' | 'prompt' | 'provenance' | 'picker' | 'lock';

export type FocusRegion =
  | { kind: 'command' }
  | { kind: 'node'; nodeId: string }
  | { kind: 'overlay'; overlay: OverlayKind }
  | { kind: 'keybar' };

export interface FocusState {
  panelId: string;
  region: FocusRegion;
  lastNodeByPanel: Record<string, string | undefined>;
}

/** Every `Node` kind that can hold focus — the union minus `split`, which is layout only. */
export type FocusNodeKind = Exclude<Node['kind'], 'split'>;

export interface FocusNode {
  readonly id: string;
  readonly kind: FocusNodeKind;
  /** `custom` nodes only: which component, so the MSG composer can be recognised. */
  readonly component?: string;
  /** Nesting depth, for the renderer's roving tabindex bookkeeping. */
  readonly depth: number;
}

/** A fresh state: the command line of `panelId`, nothing remembered. */
export function createFocusState(panelId: string): FocusState {
  return { panelId, region: { kind: 'command' }, lastNodeByPanel: {} };
}

/* -------------------------------------------------------------------------------------------- */
/* The ring                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * The focusable nodes of a spec body, in document order.
 *
 * A `split` contributes nothing but its children. A `tabs` node contributes itself and then the
 * nodes of its ACTIVE tab only: a node the user cannot see must not be Tab-reachable, and a hidden
 * grid that answers `ArrowDown` is the classic way a keyboard UI loses its user.
 */
export function collectFocusNodes(body: Node, depth = 0): FocusNode[] {
  switch (body.kind) {
    case 'split': {
      const out: FocusNode[] = [];
      for (const child of body.children) out.push(...collectFocusNodes(child, depth));
      return out;
    }
    case 'tabs': {
      const self: FocusNode = { id: body.id, kind: 'tabs', depth };
      const active = body.tabs.find((tab) => tab.id === body.active) ?? body.tabs[0];
      return active === undefined ? [self] : [self, ...collectFocusNodes(active.body, depth + 1)];
    }
    case 'custom':
      return [{ id: body.id, kind: 'custom', component: body.component, depth }];
    default:
      return [{ id: body.id, kind: body.kind, depth }];
  }
}

/** The node the spec says to focus first, falling back to the first node, then the command line. */
export function initialRegion(nodes: readonly FocusNode[], initialFocus?: string): FocusRegion {
  if (initialFocus !== undefined && nodes.some((n) => n.id === initialFocus)) {
    return { kind: 'node', nodeId: initialFocus };
  }
  const first = nodes[0];
  return first === undefined ? { kind: 'command' } : { kind: 'node', nodeId: first.id };
}

/** The region kind a keymap matches `when` against (`keymap.ts#bindingApplies`). */
export function regionOf(state: FocusState, nodes: readonly FocusNode[]): KeyRegion {
  switch (state.region.kind) {
    case 'command':
      return 'command';
    case 'keybar':
      return 'keybar';
    case 'overlay':
      return 'overlay';
    case 'node': {
      const nodeId: string = state.region.nodeId;
      const node = nodes.find((n) => n.id === nodeId);
      return node === undefined ? 'command' : node.kind;
    }
  }
}

/** The focused node, or `null` when focus is not on a node. */
export function focusedNode(state: FocusState, nodes: readonly FocusNode[]): FocusNode | null {
  const region = state.region;
  if (region.kind !== 'node') return null;
  const nodeId = region.nodeId;
  return nodes.find((n) => n.id === nodeId) ?? null;
}

const remember = (state: FocusState, region: FocusRegion): FocusState => {
  const lastNodeByPanel =
    region.kind === 'node'
      ? { ...state.lastNodeByPanel, [state.panelId]: region.nodeId }
      : state.lastNodeByPanel;
  return { panelId: state.panelId, region, lastNodeByPanel };
};

/**
 * `Tab` / `Shift+Tab`: command line → nodes in document order → key bar → command line
 * (FUNCTIONS §2.6, CLIENT §5.2).
 *
 * An open overlay traps focus (CLIENT §3.4) — the dialog owns `Tab` — so the state is returned
 * unchanged and the dispatcher lets the overlay's own map have the key.
 */
export function nextRegion(
  state: FocusState,
  nodes: readonly FocusNode[],
  direction: 1 | -1,
): FocusState {
  if (state.region.kind === 'overlay') return state;

  const region = state.region;
  const ring: FocusRegion[] = [
    { kind: 'command' },
    ...nodes.map((n): FocusRegion => ({ kind: 'node', nodeId: n.id })),
    { kind: 'keybar' },
  ];
  const current = ring.findIndex((r) =>
    r.kind === 'node' && region.kind === 'node'
      ? r.nodeId === region.nodeId
      : r.kind === region.kind,
  );
  const from = current === -1 ? 0 : current;
  const next = ring[(from + direction + ring.length) % ring.length];
  return next === undefined ? state : remember(state, next);
}

/** Focus a node by id; unknown ids are ignored rather than clearing focus. */
export function focusNode(
  state: FocusState,
  nodes: readonly FocusNode[],
  nodeId: string,
): FocusState {
  if (!nodes.some((n) => n.id === nodeId)) return state;
  return remember(state, { kind: 'node', nodeId });
}

/** Focus the panel's command line (`Ctrl+L`, and the target of typing-anywhere routing). */
export function focusCommand(state: FocusState): FocusState {
  return remember(state, { kind: 'command' });
}

/** Focus the on-screen key bar (the guaranteed path when the browser swallows an F-key). */
export function focusKeybar(state: FocusState): FocusState {
  return remember(state, { kind: 'keybar' });
}

/**
 * Open an overlay. The node under it is already in `lastNodeByPanel`, which is what `closeOverlay`
 * restores — so HELP over a grid returns to that grid and not to the command line.
 */
export function openOverlay(state: FocusState, overlay: OverlayKind): FocusState {
  return remember(state, { kind: 'overlay', overlay });
}

/** Close the overlay and restore the node that was focused under it. */
export function closeOverlay(state: FocusState, nodes: readonly FocusNode[]): FocusState {
  const region = state.region;
  if (region.kind !== 'overlay') return state;
  const remembered = state.lastNodeByPanel[state.panelId];
  if (remembered !== undefined && nodes.some((n) => n.id === remembered)) {
    return remember(state, { kind: 'node', nodeId: remembered });
  }
  return {
    panelId: state.panelId,
    region: { kind: 'command' },
    lastNodeByPanel: state.lastNodeByPanel,
  };
}

/**
 * Move focus to another panel, restoring what was focused there (`lastNodeByPanel`, CLIENT §3.2).
 *
 * A panel whose remembered node is gone — the frame changed while it was unfocused — lands on the
 * new spec's `initialFocus`, then its first node, then its command line.
 */
export function enterPanel(
  state: FocusState,
  panelId: string,
  nodes: readonly FocusNode[],
  initialFocus?: string,
): FocusState {
  const remembered = state.lastNodeByPanel[panelId];
  const region: FocusRegion =
    remembered !== undefined && nodes.some((n) => n.id === remembered)
      ? { kind: 'node', nodeId: remembered }
      : initialRegion(nodes, initialFocus);
  const lastNodeByPanel =
    region.kind === 'node'
      ? { ...state.lastNodeByPanel, [panelId]: region.nodeId }
      : state.lastNodeByPanel;
  return { panelId, region, lastNodeByPanel };
}

/**
 * A new payload painted in this panel (FUNCTIONS §1.5 `initialFocus`).
 *
 * Focus moves only when it has to: a user reading row 40 of a grid that repaints with fresh prices
 * stays on row 40. It moves when the focused node no longer exists, and when the previous region
 * was the command line and the spec asks for a node — the launch case, where the command line has
 * just been emptied by the run.
 */
export function paint(
  state: FocusState,
  nodes: readonly FocusNode[],
  initialFocus?: string,
  opts: { fromCommand?: boolean } = {},
): FocusState {
  const region = state.region;
  if (region.kind === 'overlay') return state;
  if (region.kind === 'node' && nodes.some((n) => n.id === region.nodeId)) return state;
  if (region.kind === 'command' && opts.fromCommand !== true) return state;
  if (region.kind === 'keybar') return state;
  return remember(state, initialRegion(nodes, initialFocus));
}

/**
 * Step from a tab strip into the body of its active tab (`Enter` / `ArrowDown`, CLIENT §5.3).
 * The tab body's first node follows the strip in document order, so this is that node.
 */
export function enterNode(state: FocusState, nodes: readonly FocusNode[]): FocusState {
  const region = state.region;
  if (region.kind !== 'node') return state;
  const nodeId = region.nodeId;
  const index = nodes.findIndex((n) => n.id === nodeId);
  const self = nodes[index];
  if (self === undefined) return state;
  const child = nodes[index + 1];
  if (child === undefined || child.depth <= self.depth) return state;
  return remember(state, { kind: 'node', nodeId: child.id });
}

/* -------------------------------------------------------------------------------------------- */
/* What a widget asks                                                                             */
/* -------------------------------------------------------------------------------------------- */

/** Roving tabindex: `0` for the focused region, `-1` for everything else (CLIENT §3.2). */
export function tabIndexOf(state: FocusState, target: FocusRegion): 0 | -1 {
  const region = state.region;
  if (region.kind !== target.kind) return -1;
  if (region.kind === 'node' && target.kind === 'node') {
    return region.nodeId === target.nodeId ? 0 : -1;
  }
  if (region.kind === 'overlay' && target.kind === 'overlay') {
    return region.overlay === target.overlay ? 0 : -1;
  }
  return 0;
}

/** `tabIndexOf` for a node id, which is the form every widget actually needs. */
export function nodeTabIndex(state: FocusState, nodeId: string): 0 | -1 {
  return tabIndexOf(state, { kind: 'node', nodeId });
}

/**
 * Does the focused region swallow printable keys instead of routing them to the command line?
 *
 * CLIENT §4.1 L303: the exceptions to typing-anywhere are a `form` field, the MSG `Composer`, a
 * prompt dialog and the login form. The first three are structural and answered here; the login
 * form is a different page and never reaches the dispatcher.
 */
export function capturesTypedText(state: FocusState, nodes: readonly FocusNode[]): boolean {
  const region = state.region;
  if (region.kind === 'overlay') return region.overlay === 'prompt';
  const node = focusedNode(state, nodes);
  if (node === null) return false;
  return node.kind === 'form' || (node.kind === 'custom' && node.component === 'Composer');
}
