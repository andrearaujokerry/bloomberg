// packages/web/src/screen/ScreenRenderer.tsx — the thing that finally draws a screen.
//
// Thirty-eight functions have been written as pure `FunctionScreen`s: props in, `ScreenSpec` out.
// Nothing has ever rendered one. This file is the other half of that contract and the only place
// that knows a `Node` kind maps to a component.
//
// Three rules it exists to keep (WORKPLAN L1370-1374, CLIENT.md §5.4, §12.1):
//
//   1. **The widget set is fixed.** `Split, KeyValue, Grid, Table, Chart, Tabs, Form, Text, List,
//      Badges, Custom`. The switch below is exhaustive over `Node['kind']` and the compiler proves
//      it: a new kind would fail to build rather than fall through to a generic box.
//   2. **Every node is keyboard-operable** (TERM-06). `Tab` moves between nodes in document order —
//      which is free, because each node is one tab stop and the DOM is in spec order — and the
//      arrows move within a node. No affordance is bound to `onClick` alone; where a pointer
//      handler exists it calls the same function the key calls.
//   3. **`Ctrl+I` answers "where did this number come from"** (DATA-10). Every element that stands
//      for a value carries `data-prov-idx`; the handler reads it off whatever has focus, and the
//      panel shows that entry of `meta.provenance` — or says the value is still pending when the
//      index is -1, which is a real state and not an error.
//
//   4. **A blank cell says WHY it is blank** (ENTL-05). The reason for a denial lives once per
//      field in `meta.entitlement[]` and an absence once per field in `meta.unavailable[]`, not on
//      every cell the decision touched. This file is where the meta is, so this file flattens the
//      two into the `fieldId -> ReasonCode` lookup `CellView` consults when a blank cell carries no
//      `r` of its own. Without it a withheld price and a missing price are the same em dash.
//
// What this file deliberately does not do: draw a grid or a chart. Those are WP-13's `LiveGrid` and
// WP-14's `ChartCanvas`, delegated through the props contracts in `widgets/registry.ts`.

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, Ref } from 'react';

import type { PayloadMeta } from '@terminal/sdk';

import { reservedFor } from '../keyboard/keymap.js';

/** One `meta.provenance[]` entry, taken from the wire type rather than re-declared. */
type ProvenanceEntry = PayloadMeta['provenance'][number];

import type { Node, ScreenSpec } from './types.js';
import { Badges } from './widgets/Badges.js';
import { CellFormatContext, CellReasonContext } from './widgets/CellView.js';
import type { CellFormatContextValue, CellReasonResolver } from './widgets/CellView.js';
import { Chart } from './widgets/Chart.js';
import { Custom } from './widgets/Custom.js';
import { Form } from './widgets/Form.js';
import { Grid } from './widgets/Grid.js';
import { KeyValue } from './widgets/KeyValue.js';
import { List } from './widgets/List.js';
import { Split } from './widgets/Split.js';
import { Table } from './widgets/Table.js';
import { EMPTY_TAB_REQUEST, TabRequestContext, Tabs } from './widgets/Tabs.js';
import type { TabRequest } from './widgets/Tabs.js';
import { Text } from './widgets/Text.js';
import { INERT_ACTIONS, ScreenActionsContext, WidgetRegistryContext } from './widgets/registry.js';
import type { ScreenActions, WidgetRegistry } from './widgets/registry.js';

import './widgets/widgets.css';

/** What the shell can ask of a rendered screen. */
export interface ScreenHandle {
  /** Move focus to a node id (`ScreenCtx.focus`). False when the spec has no such node. */
  focusNode(nodeId: string): boolean;
  /** Open the provenance panel for an index directly (`ScreenCtx.provenance`). */
  openProvenance(provIdx: number): void;
  /** The provenance index `Ctrl+I` would use right now, or null when nothing focused cites one. */
  focusedProvIdx(): number | null;
}

export interface ScreenRendererProps {
  spec: ScreenSpec;
  /** The payload's meta: the provenance panel reads `meta.provenance[]` out of it. */
  meta?: PayloadMeta | undefined;
  /** `ScreenCtx<P>` satisfies this structurally — a panel passes its own `ctx`. */
  actions?: ScreenActions | undefined;
  /** WP-13's `LiveGrid`, WP-14's `ChartCanvas` and the `custom` components, when they exist. */
  widgets?: WidgetRegistry | undefined;
  /** `instruments.currency` / `price_decimals` for the cells that need them. */
  format?: CellFormatContextValue | undefined;
  /**
   * Move focus to `spec.initialFocus` on mount. Off by default: the shell decides whether a new
   * frame steals focus from the command line, and a renderer that grabbed it unasked would make
   * typing-anywhere (TERM-07) unusable.
   */
  autoFocus?: boolean | undefined;
  ref?: Ref<ScreenHandle> | undefined;
}

const EMPTY_FORMAT: CellFormatContextValue = {};

/**
 * Vite's development flag, read through a cast because `import.meta.env` is the bundler's and not
 * the type system's. A bundle that does not set it is treated as production, which is the safe way
 * round: the warnings below are for the person writing a screen, not for the person trading on one.
 */
const DEV = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;

/**
 * The tab selections needed to reveal `nodeId`, or null when the spec has no such node.
 *
 * `ScreenCtx.focus(nodeId)` and `spec.initialFocus` name a node in the *spec*, and a node inside an
 * inactive tab is in the spec but not in the DOM. Rather than fail silently, the renderer works out
 * which tab of which strip has to be selected — at every level, because tabs nest — and asks for it.
 */
function tabPathTo(
  node: Node,
  nodeId: string,
  acc: Readonly<Record<string, string>> = {},
): Record<string, string> | null {
  if (node.kind !== 'split' && node.id === nodeId) return { ...acc };
  if (node.kind === 'split') {
    for (const child of node.children) {
      const hit = tabPathTo(child, nodeId, acc);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (node.kind === 'tabs') {
    for (const tab of node.tabs) {
      const hit = tabPathTo(tab.body, nodeId, { ...acc, [node.id]: tab.id });
      if (hit !== null) return hit;
    }
    return null;
  }
  return null;
}

/**
 * `meta.entitlement[]` + `meta.unavailable[]`, flattened to the lookup a blank cell needs (ENTL-05).
 *
 * A denial wins over an absence when the payload reports both for one field: "you are not entitled
 * to this" is a statement about the viewer and is the more specific of the two, and it is the one
 * the user can act on.
 */
function reasonResolverFor(meta: PayloadMeta | undefined): CellReasonResolver {
  if (meta === undefined) return () => undefined;
  const byField = new Map<string, string>();
  for (const note of meta.unavailable) byField.set(note.field, note.reason);
  for (const note of meta.entitlement) {
    if (note.decision === 'deny') byField.set(note.fieldId, note.reason);
  }
  if (byField.size === 0) return () => undefined;
  return (fieldId) => (fieldId === undefined ? undefined : byField.get(fieldId));
}

/** The element `Ctrl+I` is about: whatever has focus, or the nearest ancestor that cites an index. */
function provIdxOfFocus(root: HTMLElement | null): number | null {
  if (root === null) return null;
  const active = root.ownerDocument.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  const cited = active.closest<HTMLElement>('[data-prov-idx]');
  if (cited === null) return null;
  const raw = cited.dataset.provIdx;
  if (raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function ScreenRenderer({
  spec,
  meta,
  actions = INERT_ACTIONS,
  widgets = {},
  format = EMPTY_FORMAT,
  autoFocus = false,
  ref,
}: ScreenRendererProps): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const [provOpen, setProvOpen] = useState<number | null>(null);
  const provRef = useRef<HTMLDivElement | null>(null);
  const [tabRequest, setTabRequest] = useState<TabRequest>(EMPTY_TAB_REQUEST);
  /** A focus target that needed a tab selected first; resolved on the commit that reveals it. */
  const pendingFocus = useRef<string | null>(null);
  // `focusNode` must see the current spec without being rebuilt on every render: it is the identity
  // the imperative handle and the autoFocus effect both depend on.
  const specRef = useRef(spec);
  specRef.current = spec;

  /** Focus the node if it is in the DOM right now. */
  const focusMounted = useCallback((nodeId: string): boolean => {
    const root = rootRef.current;
    if (root === null) return false;
    // The id lands inside an attribute selector; only `"` and `\\` can break out of one.
    const escaped = nodeId.replace(/["\\]/g, (c) => `\\${c}`);
    const node = root.querySelector<HTMLElement>(`[data-node-id="${escaped}"]`);
    if (node === null) return false;
    // A node is either focusable itself (the placeholders, `text`, and any list-shaped node that is
    // empty) or owns exactly one tab stop (the roving widgets, the form's first control).
    const target =
      node.tabIndex >= 0
        ? node
        : node.querySelector<HTMLElement>('[tabindex="0"], input, select, button, textarea');
    (target ?? node).focus();
    return true;
  }, []);

  /**
   * Move focus to a node id, and say whether it could be done.
   *
   * Three outcomes, and none of them is silence. The node is mounted, so focus moves and this
   * returns true. The node is in the spec but inside an inactive tab, so the strips are asked to
   * select the tabs that reveal it and the focus lands on the next commit — also true, because the
   * request will be honoured. Or the spec has no such node at all, which is a screen bug: false,
   * plus a warning in development, because a focus request that quietly does nothing is exactly the
   * failure that stays invisible until someone notices the keyboard has stopped working.
   */
  const focusNode = useCallback(
    (nodeId: string): boolean => {
      if (rootRef.current === null) return false;
      if (focusMounted(nodeId)) return true;
      const path = tabPathTo(specRef.current.body, nodeId);
      if (path === null) {
        if (DEV) {
          console.warn(`ScreenRenderer: focus("${nodeId}") — no such node in this spec.`);
        }
        return false;
      }
      pendingFocus.current = nodeId;
      setTabRequest((prev) => ({ seq: prev.seq + 1, want: { ...prev.want, ...path } }));
      return true;
    },
    [focusMounted],
  );

  // The commit after a tab request: the body is mounted now, so the focus that was waiting on it
  // lands. One attempt, then the request is dropped — a focus that keeps retrying across renders
  // would fight the user for the caret.
  useEffect(() => {
    const nodeId = pendingFocus.current;
    if (nodeId === null) return;
    pendingFocus.current = null;
    if (focusMounted(nodeId)) return;
    if (DEV) {
      console.warn(
        `ScreenRenderer: focus("${nodeId}") — the node is in the spec but did not mount.`,
      );
    }
  });

  const openProvenance = useCallback(
    (provIdx: number): void => {
      const root = rootRef.current;
      const active = root?.ownerDocument.activeElement;
      returnFocusTo.current = active instanceof HTMLElement ? active : null;
      setProvOpen(provIdx);
      actions.provenance(provIdx);
    },
    [actions],
  );

  const closeProvenance = useCallback((): void => {
    setProvOpen(null);
    returnFocusTo.current?.focus();
    returnFocusTo.current = null;
  }, []);

  useImperativeHandle(
    ref,
    (): ScreenHandle => ({
      focusNode,
      openProvenance,
      focusedProvIdx: () => provIdxOfFocus(rootRef.current),
    }),
    [focusNode, openProvenance],
  );

  const reasonOf = useMemo(() => reasonResolverFor(meta), [meta]);

  const initialFocus = spec.initialFocus;
  useEffect(() => {
    if (!autoFocus || initialFocus === undefined) return;
    focusNode(initialFocus);
  }, [autoFocus, initialFocus, focusNode]);

  useEffect(() => {
    if (provOpen === null) return;
    provRef.current?.focus();
  }, [provOpen]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Ctrl+I is reserved globally (FUNCTIONS.md §2.6) and a function keymap may not rebind it.
    //
    // The match comes from `keymap.ts`'s one table rather than a `e.key === 'i'` comparison here.
    // Every other keyboard path in this package matches on `KeyboardEvent.code` precisely so that a
    // non-US layout or a macOS dead key cannot change what a key means; a second, hand-rolled
    // comparison in this file would be a second answer to "was that the provenance key", and the
    // two would eventually disagree.
    //
    // The renderer is the SOLE owner of the reserved `provenance` action while focus is inside a
    // screen, which is why the event stops here. It is the only thing that knows which cell has
    // focus and which `meta.provenance` index that cell cites — `Panel.tsx` says as much where it
    // wires `ScreenActions` ("`provenance` is the renderer's own panel"), and `actions.provenance`
    // below is how the shell still hears about it for telemetry. A `KeyboardHost.provenance()`
    // implementation must therefore delegate to this component's `ScreenHandle`
    // (`openProvenance(focusedProvIdx() ?? -2)`) rather than open a panel of its own.
    if (reservedFor(e.nativeEvent)?.action === 'provenance') {
      e.preventDefault();
      e.stopPropagation();
      openProvenance(provIdxOfFocus(rootRef.current) ?? -2);
      return;
    }
    if (e.key === 'Escape' && provOpen !== null) {
      e.preventDefault();
      e.stopPropagation();
      closeProvenance();
    }
  };

  const renderNode = useCallback((node: Node, key: string): ReactElement => {
    switch (node.kind) {
      case 'split':
        return <Split key={key} node={node} renderNode={renderNode} />;
      case 'kv':
        return <KeyValue key={key} node={node} />;
      case 'grid':
        return <Grid key={key} node={node} />;
      case 'table':
        return <Table key={key} node={node} />;
      case 'chart':
        return <Chart key={key} node={node} />;
      case 'tabs':
        return <Tabs key={key} node={node} renderNode={renderNode} />;
      case 'form':
        return <Form key={key} node={node} />;
      case 'text':
        return <Text key={key} node={node} />;
      case 'list':
        return <List key={key} node={node} />;
      case 'badges':
        return <Badges key={key} node={node} />;
      case 'custom':
        return <Custom key={key} node={node} />;
      default: {
        // The widget set is fixed: a new `Node` kind fails to compile here rather than silently
        // rendering nothing.
        const exhaustive: never = node;
        return (
          <span key={key} hidden>
            {String(exhaustive)}
          </span>
        );
      }
    }
  }, []);

  return (
    <WidgetRegistryContext.Provider value={widgets}>
      <ScreenActionsContext.Provider value={actions}>
        <CellFormatContext.Provider value={format}>
          <CellReasonContext.Provider value={reasonOf}>
            <TabRequestContext.Provider value={tabRequest}>
              <div className="screen" ref={rootRef} onKeyDown={onKeyDown}>
                <header className="screen__head">
                  <h1 className="screen__title">{spec.title}</h1>
                  {spec.subtitle === undefined ? null : (
                    <p className="screen__subtitle">{spec.subtitle}</p>
                  )}
                </header>
                <div className="screen__body">{renderNode(spec.body, 'body')}</div>
                {spec.footer === undefined ? null : (
                  <footer className="screen__footer">
                    <ul aria-label="Sources">
                      {spec.footer.sources.map((source) => (
                        <li key={source}>{source}</li>
                      ))}
                    </ul>
                    {spec.footer.asOf === undefined ? null : (
                      <span className="screen__asof">{` · as of ${spec.footer.asOf}`}</span>
                    )}
                    {(spec.footer.notes ?? []).map((note) => (
                      <span key={note} className="screen__note">{` · ${note}`}</span>
                    ))}
                  </footer>
                )}
                {provOpen === null ? null : (
                  <ProvenancePanel
                    provIdx={provOpen}
                    meta={meta}
                    onClose={closeProvenance}
                    panelRef={provRef}
                  />
                )}
              </div>
            </TabRequestContext.Provider>
          </CellReasonContext.Provider>
        </CellFormatContext.Provider>
      </ScreenActionsContext.Provider>
    </WidgetRegistryContext.Provider>
  );
}

interface ProvenancePanelProps {
  /** The index cited by the focused element; -1 means pending, -2 means nothing cited one. */
  provIdx: number;
  meta: PayloadMeta | undefined;
  onClose: () => void;
  panelRef: Ref<HTMLDivElement>;
}

/**
 * DATA-10: every number on the screen can name its source, when it was captured and who must be
 * credited for it. The three cases below are three different answers, and none of them is silence:
 * a value with an index shows the entry, a value whose index is -1 is *pending* and says so, and an
 * element that cites nothing says that too rather than opening an empty panel.
 */
function ProvenancePanel({ provIdx, meta, onClose, panelRef }: ProvenancePanelProps): ReactElement {
  const entry: ProvenanceEntry | undefined = provIdx >= 0 ? meta?.provenance[provIdx] : undefined;

  return (
    <div
      className="prov"
      role="dialog"
      aria-label="Provenance"
      tabIndex={-1}
      ref={panelRef}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <h2 className="prov__title">Provenance</h2>
      {entry !== undefined ? (
        <dl className="prov__dl">
          <dt>Source</dt>
          <dd>{entry.sourceId}</dd>
          <dt>Captured</dt>
          <dd>{entry.capturedAt}</dd>
          <dt>Source time</dt>
          <dd>{entry.sourceTs ?? '—'}</dd>
          <dt>Attribution</dt>
          <dd>{entry.attribution}</dd>
          <dt>Provenance id</dt>
          <dd>{String(entry.provenanceId)}</dd>
          <dt>Index</dt>
          <dd>{String(entry.idx)}</dd>
        </dl>
      ) : provIdx === -1 ? (
        <p className="prov__pending">
          Pending — this value has not been attributed yet. It was computed or is still waiting for
          its first capture, so there is no source to show.
        </p>
      ) : provIdx === -2 ? (
        <p className="prov__pending">
          The focused element cites no provenance. Move to a value and press Ctrl+I again.
        </p>
      ) : (
        <p className="prov__pending">
          {`No provenance entry ${String(provIdx)} in this payload — the screen cited an index the meta does not carry.`}
        </p>
      )}
      <button type="button" className="prov__close" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

export default ScreenRenderer;
