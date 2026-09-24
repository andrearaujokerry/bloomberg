// packages/web/src/screen/widgets/Tabs.tsx — the tab strip and the active body.
//
// The ARIA tabs pattern with automatic activation: the strip is one tab stop, Left/Right/Home/End
// move and select, and a tab that declares a `key` (DES's `1`..`6`) is also reachable by that key
// while the strip has focus.
//
// One wrinkle the 38 screens force. `Node.tabs` carries `active` and an *optional* `onChange`, and
// most screens omit `onChange` because they drive the tab from a param (`ctx.setParams({ tab })`)
// through the manifest keymap instead. A strip that only obeyed `onChange` would therefore be dead
// on those screens. So selection is applied locally as well as reported, and the local override is
// dropped the moment the incoming `active` changes — which is exactly what happens when the screen
// re-runs with the new param, so the screen stays the source of truth wherever it wants to be.

import { createContext, useContext, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';

import type { Node } from '../types.js';
import { useRoving } from './roving.js';

/**
 * A tab the renderer needs selected in order to reveal a focus target (`ScreenCtx.focus`,
 * `spec.initialFocus`). `want` maps a tabs node id to the tab id; `seq` rises on every request so a
 * strip can tell "select this tab again" from "you have already applied this one" and does not
 * override a tab the user picked afterwards.
 */
export interface TabRequest {
  readonly seq: number;
  readonly want: Readonly<Record<string, string>>;
}

export const EMPTY_TAB_REQUEST: TabRequest = { seq: 0, want: {} };

export const TabRequestContext = createContext<TabRequest>(EMPTY_TAB_REQUEST);

export interface TabsProps {
  node: Extract<Node, { kind: 'tabs' }>;
  renderNode: (node: Node, key: string) => ReactElement;
}

export function Tabs({ node, renderNode }: TabsProps): ReactElement {
  const [override, setOverride] = useState<string | null>(null);
  const lastActive = useRef(node.active);
  if (lastActive.current !== node.active) {
    lastActive.current = node.active;
    if (override !== null) setOverride(null);
  }

  // A renderer focus request for a node inside this strip, applied once. The guard is the same
  // render-phase adjustment the `active` reset above uses, so the body is mounted in the very
  // commit the request arrives in and the focus that is waiting on it lands immediately.
  const request = useContext(TabRequestContext);
  const wanted = request.want[node.id];
  const wantedKey = wanted === undefined ? null : `${String(request.seq)}:${wanted}`;
  const appliedRequest = useRef<string | null>(null);
  if (
    wanted !== undefined &&
    wantedKey !== appliedRequest.current &&
    node.tabs.some((t) => t.id === wanted)
  ) {
    appliedRequest.current = wantedKey;
    setOverride(wanted);
  }

  const activeId = override ?? node.active;
  const activeIndex = Math.max(
    node.tabs.findIndex((t) => t.id === activeId),
    0,
  );
  const roving = useRoving(node.tabs.length);
  const active = node.tabs[activeIndex];

  const select = (index: number): void => {
    const tab = node.tabs[index];
    if (tab === undefined) return;
    setOverride(tab.id);
    node.onChange?.(tab.id);
    roving.move(index);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    const count = node.tabs.length;
    if (count === 0) return;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = activeIndex + 1;
    else if (e.key === 'ArrowLeft') next = activeIndex - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    else {
      const byKey = node.tabs.findIndex((t) => t.key !== undefined && t.key === e.key);
      if (byKey >= 0) next = byKey;
    }
    if (next === null) return;
    e.preventDefault();
    select(((next % count) + count) % count);
  };

  if (node.tabs.length === 0) {
    // A strip with no tabs still has to be exactly one tab stop, like every other node: a node that
    // vanishes from the Tab order when it happens to be empty is a node `ctx.focus` cannot reach
    // and `Ctrl+I` cannot be pressed on, and nothing on screen says why.
    return (
      <div
        className="tabs tabs--empty"
        data-node-id={node.id}
        tabIndex={0}
        role="group"
        aria-label={`Tabs ${node.id}`}
      >
        <p className="widget__empty">No tabs.</p>
      </div>
    );
  }

  return (
    <div className="tabs" data-node-id={node.id}>
      <div className="tabs__strip" role="tablist" aria-label={`Tabs ${node.id}`}>
        {node.tabs.map((tab, i) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${node.id}-tab-${tab.id}`}
            className="tabs__tab"
            aria-selected={tab.id === activeId}
            aria-controls={`${node.id}-panel-${tab.id}`}
            tabIndex={i === activeIndex ? 0 : -1}
            ref={roving.register(i)}
            onClick={() => {
              select(i);
            }}
            onKeyDown={onKeyDown}
          >
            {tab.label}
            {tab.key === undefined ? null : <span className="tabs__key">{tab.key}</span>}
          </button>
        ))}
      </div>
      {active === undefined ? null : (
        <div
          className="tabs__panel"
          role="tabpanel"
          id={`${node.id}-panel-${active.id}`}
          aria-labelledby={`${node.id}-tab-${active.id}`}
        >
          {renderNode(active.body, `${node.id}:${active.id}`)}
        </div>
      )}
    </div>
  );
}
