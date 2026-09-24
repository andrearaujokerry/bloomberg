// packages/web/src/shell/PanelGrid.tsx — the four layouts, and the ring that says where keys go.
//
// CLIENT.md §3.1 L216-222, WORKPLAN L1367. Four modes, one CSS grid:
//
//   '1'   p1                      one column, one row
//   '2h'  p1 | p2                 two columns, one row   (horizontally arranged, side by side)
//   '2v'  p1 over p2              one column, two rows
//   '4'   p1 p2 / p3 p4           two columns, two rows
//
// The `h`/`v` names read the arrangement, not the split line: `'2h'` is the *horizontal* pair. It
// is the one place in this file where a wrong guess produces a layout that looks plausible and is
// the wrong way round, so the mapping is a named constant with the panels spelled out beside it.
//
// The panels themselves come from `state/panels.ts`: `visible` is already the answer to "which
// panels does this mode show", including its one correction — the focused panel is always visible,
// because focus on a panel nobody can see is how a keystroke goes missing (TERM-04). This file does
// not recompute that; it renders it.
//
// The focus ring is `Panel`'s (`data-focused`), driven by the store's `focus`. Not `:focus-within`:
// the store is what the keyboard dispatcher routes by, so a ring drawn from DOM focus could point
// at a different panel than the one the next keystroke would reach — which is the single thing the
// ring exists to prevent.

import { useCallback } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import { Panel } from './Panel.js';
import type { PanelActions, PanelSlots, ScreenRegistry } from './Panel.js';
import type { WidgetRegistry } from '../screen/widgets/registry.js';
import type { LayoutMode } from '../state/panels.js';
import { usePanelsStore } from '../state/panels.js';

/** The grid track definition of each mode, and the panels it puts where. */
export interface LayoutTracks {
  readonly columns: string;
  readonly rows: string;
  /** How many panels the mode shows — the same number `PANEL_COUNT` gives, for assertions here. */
  readonly count: number;
  readonly description: string;
}

export const LAYOUT_TRACKS: Readonly<Record<LayoutMode, LayoutTracks>> = Object.freeze({
  '1': { columns: '1fr', rows: '1fr', count: 1, description: 'one panel' },
  '2h': { columns: '1fr 1fr', rows: '1fr', count: 2, description: 'two panels side by side' },
  '2v': { columns: '1fr', rows: '1fr 1fr', count: 2, description: 'two panels stacked' },
  '4': { columns: '1fr 1fr', rows: '1fr 1fr', count: 4, description: 'four panels, two by two' },
});

/** `'p3'` → 3, for the aria label and the `/panel n` command; position + 1 for anything else. */
export function ordinalOf(panelId: string, position: number): number {
  const match = /^p(\d+)$/.exec(panelId);
  const parsed = match === null ? Number.NaN : Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : position + 1;
}

const S = {
  grid: {
    flex: '1 1 auto',
    display: 'grid',
    minHeight: 0,
    minWidth: 0,
    gap: '2px',
    padding: '2px',
    background: 'var(--c-bg)',
  },
} satisfies Record<string, CSSProperties>;

export interface PanelGridProps {
  actions?: PanelActions | undefined;
  slots?: PanelSlots | undefined;
  widgets?: WidgetRegistry | undefined;
  screens?: ScreenRegistry | undefined;
}

export function PanelGrid({ actions, slots, widgets, screens }: PanelGridProps): ReactElement {
  const mode = usePanelsStore((s) => s.mode);
  const visible = usePanelsStore((s) => s.visible);
  const focus = usePanelsStore((s) => s.focus);
  // `getState()` rather than a selected method: the store's actions are stable, and a method
  // pulled out of its object is a method that has lost its `this`.
  const setFocus = useCallback((panelId: string) => {
    usePanelsStore.getState().setFocus(panelId);
  }, []);

  const tracks = LAYOUT_TRACKS[mode];

  return (
    <main
      style={{ ...S.grid, gridTemplateColumns: tracks.columns, gridTemplateRows: tracks.rows }}
      data-layout={mode}
      data-testid="panel-grid"
      aria-label={`Panels — ${tracks.description}`}
    >
      {visible.map((panelId, position) => (
        <Panel
          key={panelId}
          panelId={panelId}
          ordinal={ordinalOf(panelId, position)}
          focused={panelId === focus}
          onFocus={setFocus}
          actions={actions}
          slots={slots}
          widgets={widgets}
          screens={screens}
        />
      ))}
    </main>
  );
}

export default PanelGrid;
