/**
 * packages/web/test/shell/panels.test.tsx — the WP-12 acceptance row for the panel shell.
 *
 * WORKPLAN L1405: "1/2/4 layouts, per-panel frame stack, focus ring, workspace version conflict
 * surfaces a 409 message".
 *
 * The screens are the real ones and the payloads are the committed goldens under
 * `fixtures/golden/functions/`. A shell test that rendered a hand-built `ScreenSpec` would prove
 * that the shell can host a fixture; what has to be true is that it hosts the thirty-eight screens
 * that were written months before anything could draw them, so `DES` and `Q` are launched into
 * panels exactly as `command/dispatch.ts` will launch them — a frame pushed, then the payload
 * written onto it — and the assertions are made against what those screens themselves return.
 *
 * The stores are real too. `state/panels.ts` and `state/workspace.ts` are the shell's model, and
 * mocking them would leave the two things this file exists to prove — that the forward history is
 * truncated, and that a second 409 reaches the user — asserted against a fake.
 *
 * No `setTimeout` anywhere: the workspace store takes its timers through a `Scheduler` port, and
 * this file passes one that records instead of scheduling (TESTING §2.2).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifests, registry } from '@terminal/core';
import type { FieldId, FunctionCode, PayloadOf } from '@terminal/core';
import type { InstrumentSummary, PayloadMeta, SubscribeOptions, Subscription } from '@terminal/sdk';
import type { Workspace, WorkspaceLayout } from '@terminal/sdk/wire/rest/workspaces';
import { act, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ScreenCtx, ScreenSpec } from '../../src/screen/types.js';
import { NO_LIVE_VIEW, SCREENS, keyHints } from '../../src/shell/Panel.js';
import { LAYOUT_TRACKS, ordinalOf } from '../../src/shell/PanelGrid.js';
import { Shell } from '../../src/shell/Shell.js';
import { STALENESS_LEGEND, connectionOf } from '../../src/shell/StatusBar.js';
import { PANEL_COUNT, usePanelsStore } from '../../src/state/panels.js';
import { useSessionStore } from '../../src/state/session.js';
import { useSettingsStore } from '../../src/state/settings.js';
import { selectSubjects, useSubscriptionsStore } from '../../src/state/subscriptions.js';
import { DEFAULT_LAYOUT, useWorkspaceStore } from '../../src/state/workspace.js';
import type { Scheduler, WorkspaceApi } from '../../src/state/workspace.js';

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(dirname(TEST_DIR))));
const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'golden', 'functions');

function golden<C extends FunctionCode>(file: string): PayloadOf<C> {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, file), 'utf8')) as PayloadOf<C>;
}

const INSTRUMENT: InstrumentSummary = {
  instrumentId: 1,
  assetClass: 'equity',
  marketSector: 'Equity',
  display: 'AAPL US Equity',
  name: 'Apple Inc',
  currency: 'USD',
  mdLineIds: [101],
  ticker: 'AAPL',
  exchCode: 'US',
  securityType: 'Common Stock',
  compositeFigi: null,
  status: 'active',
  priceDecimals: 2,
};

/** Enough `provenance` entries that a screen citing an index finds one; nothing here reads them. */
function metaFor(traceId: string): PayloadMeta {
  return {
    traceId,
    resultId: '01J0000000000000000000TEST',
    asOf: { validAt: '2026-09-15T18:41:28.000Z', knownAt: '2026-09-15T18:41:28.000Z' },
    tier: 'delayed',
    staleness: 'live',
    provenance: Array.from({ length: 64 }, (_v, idx) => ({
      idx,
      sourceId: `source.${String(idx)}`,
      provenanceId: 1000 + idx,
      capturedAt: '2026-09-15T18:41:28.000Z',
      sourceTs: '2026-09-15T18:26:26.000Z',
      attribution: `Attribution for source ${String(idx)}`,
    })),
    entitlement: [],
    unavailable: [],
    engines: [],
    page: { index: 0, count: 1, cursor: null },
    servedAt: '2026-09-15T18:41:28.100Z',
  };
}

/** A `ScreenCtx` that does nothing — the spec a screen returns is a pure function of its props. */
const INERT_CTX: ScreenCtx<Record<string, unknown>> = {
  panelId: 'p1',
  setParams: () => undefined,
  navigate: () => undefined,
  navigateNext: () => undefined,
  export: () => undefined,
  page: () => undefined,
  focus: () => undefined,
  prompt: () => Promise.resolve(null),
  provenance: () => undefined,
  openUrl: () => undefined,
};

interface Launch {
  readonly code: FunctionCode;
  readonly payload: unknown;
  readonly params: Record<string, unknown>;
  readonly traceId: string;
  readonly meta: PayloadMeta;
}

function launchOf(code: FunctionCode, file: string, traceId: string): Launch {
  return {
    code,
    payload: golden(file),
    params: manifests[code].params.parse({}),
    traceId,
    meta: metaFor(traceId),
  };
}

/** The spec that screen returns for that payload — the expectation, taken from the screen itself. */
function specOf(launch: Launch): ScreenSpec {
  const entry = SCREENS[launch.code];
  if (entry === undefined) throw new Error(`no screen registered for ${launch.code}`);
  return entry.Screen({
    payload: launch.payload,
    params: launch.params,
    instrument: INSTRUMENT,
    meta: launch.meta,
    live: NO_LIVE_VIEW,
    ctx: INERT_CTX,
  });
}

/** What `command/dispatch.ts` does on a GO: push the frame, then write the payload onto it. */
function run(panelId: string, launch: Launch): void {
  act(() => {
    usePanelsStore.getState().pushFrame(panelId, {
      security: { id: INSTRUMENT.instrumentId, display: INSTRUMENT.display },
      fn: launch.code,
      traceId: launch.traceId,
      params: launch.params,
      instrument: INSTRUMENT,
    });
    usePanelsStore.getState().replaceFrame(panelId, {
      payload: launch.payload,
      meta: launch.meta,
      status: 'ready',
    });
  });
}

const DES = (): Launch => launchOf('DES', 'DES.equity.json', 'aaaaaaaa-0000-4000-8000-000000000001');
const Q = (): Launch => launchOf('Q', 'Q.quote.json', 'bbbbbbbb-0000-4000-8000-000000000002');

/* ---------------------------------------------------------------------------------------------- */
/* Harness                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** The workspace store's timer port, recording instead of scheduling (TESTING §2.2). */
interface RecordingScheduler extends Scheduler {
  readonly timers: { fn: () => void; ms: number }[];
}

function recordingScheduler(): RecordingScheduler {
  const timers: { fn: () => void; ms: number }[] = [];
  return {
    timers,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
    now: () => 0,
  };
}

function panelOf(ordinal: number): HTMLElement {
  return screen.getByLabelText(`Panel ${String(ordinal)}`);
}

function focusedPanelIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-panel][data-focused="true"]')].map(
    (el) => el.dataset.panel ?? '',
  );
}

function firstFocusableNode(panel: HTMLElement): HTMLElement {
  const node = panel.querySelector<HTMLElement>('[data-node-id][tabindex]');
  if (node === null) throw new Error('the screen rendered no focusable node');
  return node;
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

/* ---------------------------------------------------------------------------------------------- */
/* 1 / 2 / 4 layouts (CLIENT §3.1)                                                                  */
/* ---------------------------------------------------------------------------------------------- */

describe('layouts', () => {
  it("mode '1' shows one panel", () => {
    render(<Shell />);
    expect(screen.getByTestId('panel-grid')).toHaveAttribute('data-layout', '1');
    expect(document.querySelectorAll('[data-panel]')).toHaveLength(1);
    expect(panelOf(1)).toBeInTheDocument();
  });

  it("'2h' and '2v' both show two panels and arrange them differently", () => {
    render(<Shell />);

    act(() => {
      usePanelsStore.getState().setMode('2h');
    });
    expect(document.querySelectorAll('[data-panel]')).toHaveLength(2);
    expect(panelOf(2)).toBeInTheDocument();
    const horizontal = screen.getByTestId('panel-grid');
    expect(horizontal).toHaveAttribute('data-layout', '2h');
    expect(horizontal.style.gridTemplateColumns).toBe(LAYOUT_TRACKS['2h'].columns);
    expect(horizontal.style.gridTemplateRows).toBe(LAYOUT_TRACKS['2h'].rows);

    act(() => {
      usePanelsStore.getState().setMode('2v');
    });
    expect(document.querySelectorAll('[data-panel]')).toHaveLength(2);
    const vertical = screen.getByTestId('panel-grid');
    expect(vertical.style.gridTemplateColumns).toBe(LAYOUT_TRACKS['2v'].columns);
    expect(vertical.style.gridTemplateRows).toBe(LAYOUT_TRACKS['2v'].rows);

    // The pair differs in arrangement, not in count — the bug worth guarding is the two being swapped.
    expect(LAYOUT_TRACKS['2h'].columns).not.toBe(LAYOUT_TRACKS['2v'].columns);
    expect(LAYOUT_TRACKS['2h'].rows).not.toBe(LAYOUT_TRACKS['2v'].rows);
  });

  it("'4' shows four panels in a two-by-two grid", () => {
    render(<Shell />);
    act(() => {
      usePanelsStore.getState().setMode('4');
    });

    expect(document.querySelectorAll('[data-panel]')).toHaveLength(4);
    for (const ordinal of [1, 2, 3, 4]) expect(panelOf(ordinal)).toBeInTheDocument();
    const grid = screen.getByTestId('panel-grid');
    expect(grid.style.gridTemplateColumns).toBe('1fr 1fr');
    expect(grid.style.gridTemplateRows).toBe('1fr 1fr');
  });

  it('going 4 → 1 → 4 does not destroy what the other three panels were showing', () => {
    render(<Shell />);
    act(() => {
      usePanelsStore.getState().setMode('4');
    });
    run('p3', DES());
    const title = specOf(DES()).title;
    expect(within(panelOf(3)).getByRole('heading', { name: title })).toBeInTheDocument();

    act(() => {
      usePanelsStore.getState().setMode('1');
    });
    expect(document.querySelectorAll('[data-panel]')).toHaveLength(1);

    act(() => {
      usePanelsStore.getState().setMode('4');
    });
    expect(within(panelOf(3)).getByRole('heading', { name: title })).toBeInTheDocument();
  });

  it('numbers a panel by its id, not by its slot', () => {
    expect(ordinalOf('p3', 0)).toBe(3);
    expect(ordinalOf('weird', 1)).toBe(2);
  });

  it('the grid tracks agree with the store about how many panels a mode shows', () => {
    // Two files would otherwise have to be changed together to add a mode, and the one that was
    // forgotten would render four panels into two cells or two into four.
    for (const mode of ['1', '2h', '2v', '4'] as const) {
      expect(LAYOUT_TRACKS[mode].count).toBe(PANEL_COUNT[mode]);
      const cells =
        LAYOUT_TRACKS[mode].columns.split(' ').length * LAYOUT_TRACKS[mode].rows.split(' ').length;
      expect(cells).toBe(PANEL_COUNT[mode]);
    }
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The per-panel frame stack (TERM-04, FUNCTIONS §2.5)                                              */
/* ---------------------------------------------------------------------------------------------- */

describe('the per-panel frame stack', () => {
  it('renders the top frame, and Back / Forward walk the stack', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Shell />);

    const des = DES();
    const q = Q();
    const desTitle = specOf(des).title;
    const qTitle = specOf(q).title;
    expect(desTitle).not.toBe(qTitle);

    run('p1', des);
    expect(within(panelOf(1)).getByRole('heading', { name: desTitle })).toBeInTheDocument();

    run('p1', q);
    expect(within(panelOf(1)).getByRole('heading', { name: qTitle })).toBeInTheDocument();
    expect(within(panelOf(1)).queryByRole('heading', { name: desTitle })).toBeNull();

    const back = within(panelOf(1)).getByRole('button', { name: 'Back in panel 1' });
    const forward = within(panelOf(1)).getByRole('button', { name: 'Forward in panel 1' });
    expect(back).toBeEnabled();
    expect(forward).toBeDisabled();

    await user.click(back);
    expect(within(panelOf(1)).getByRole('heading', { name: desTitle })).toBeInTheDocument();
    expect(within(panelOf(1)).getByRole('button', { name: 'Back in panel 1' })).toBeDisabled();
    expect(within(panelOf(1)).getByRole('button', { name: 'Forward in panel 1' })).toBeEnabled();

    await user.click(within(panelOf(1)).getByRole('button', { name: 'Forward in panel 1' }));
    expect(within(panelOf(1)).getByRole('heading', { name: qTitle })).toBeInTheDocument();
  });

  it('a launch made after going back truncates the forward history', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Shell />);

    const des = DES();
    const q = Q();
    run('p1', des);
    run('p1', q);

    await user.click(within(panelOf(1)).getByRole('button', { name: 'Back in panel 1' }));
    expect(
      within(panelOf(1)).getByRole('heading', { name: specOf(des).title }),
    ).toBeInTheDocument();

    // A new launch from a back frame replaces the future, so Alt+→ cannot walk into a screen the
    // user never asked for (FUNCTIONS §2.5 L786).
    run('p1', q);
    expect(within(panelOf(1)).getByRole('button', { name: 'Forward in panel 1' })).toBeDisabled();
    expect(usePanelsStore.getState().panels.p1?.frameStack).toHaveLength(2);
  });

  it('each panel owns its own stack', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Shell />);
    act(() => {
      usePanelsStore.getState().setMode('2h');
    });

    const des = DES();
    const q = Q();
    run('p1', des);
    run('p1', q);
    run('p2', des);

    // p1 has two frames and p2 one: p2's Back is disabled while p1's is not.
    expect(within(panelOf(1)).getByRole('button', { name: 'Back in panel 1' })).toBeEnabled();
    expect(within(panelOf(2)).getByRole('button', { name: 'Back in panel 2' })).toBeDisabled();

    await user.click(within(panelOf(1)).getByRole('button', { name: 'Back in panel 1' }));
    expect(
      within(panelOf(1)).getByRole('heading', { name: specOf(des).title }),
    ).toBeInTheDocument();
    expect(
      within(panelOf(2)).getByRole('heading', { name: specOf(des).title }),
    ).toBeInTheDocument();
    expect(usePanelsStore.getState().panels.p1?.index).toBe(0);
    expect(usePanelsStore.getState().panels.p2?.index).toBe(0);
    expect(usePanelsStore.getState().panels.p1?.frameStack).toHaveLength(2);
    expect(usePanelsStore.getState().panels.p2?.frameStack).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The focus ring (TERM-04)                                                                         */
/* ---------------------------------------------------------------------------------------------- */

describe('the focus ring', () => {
  it('marks exactly one panel, and marks the one the store says keys reach', () => {
    render(<Shell />);
    act(() => {
      usePanelsStore.getState().setMode('4');
    });

    expect(focusedPanelIds()).toEqual(['p1']);
    expect(panelOf(1)).toHaveAttribute('aria-current', 'true');
    expect(panelOf(2)).not.toHaveAttribute('aria-current');

    // The ring is visible, not merely semantic: the focused panel's border is the focus colour and
    // the others' is the ordinary grid line. `--c-focus` is defined once, in tokens.css.
    expect(panelOf(1).style.borderColor).toBe('var(--c-focus)');
    expect(panelOf(2).style.borderColor).toBe('var(--c-grid-line)');
    expect(panelOf(1).style.boxShadow).not.toBe(panelOf(2).style.boxShadow);

    act(() => {
      usePanelsStore.getState().setFocus('p3');
    });
    expect(focusedPanelIds()).toEqual(['p3']);
    expect(usePanelsStore.getState().focus).toBe('p3');
  });

  it('clicking a panel moves the ring to it', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Shell />);
    act(() => {
      usePanelsStore.getState().setMode('4');
    });

    await user.click(panelOf(4));
    expect(focusedPanelIds()).toEqual(['p4']);
    expect(usePanelsStore.getState().focus).toBe('p4');
  });

  it('focusing a node inside an unfocused panel moves the ring and shows that node’s key hints', () => {
    render(<Shell />);
    act(() => {
      usePanelsStore.getState().setMode('2h');
    });
    run('p2', DES());

    // Before anything in the body is focused there is no node, so there are no hints to show.
    expect(within(panelOf(2)).queryByRole('group', { name: 'Key hints' })).toBeNull();

    const node = firstFocusableNode(panelOf(2));
    act(() => {
      node.focus();
    });

    expect(focusedPanelIds()).toEqual(['p2']);
    const hints = within(panelOf(2)).getByRole('group', { name: 'Key hints' });
    const descriptions = (registry.get('DES')?.keymap ?? []).map((b) => b.description);
    expect(descriptions.length).toBeGreaterThan(0);
    expect(descriptions.some((d) => hints.textContent?.includes(d) === true)).toBe(true);
  });

  it('key hints are scoped to the focused region, and the command line has none', () => {
    const keymap = registry.get('DES')?.keymap ?? [];
    const onGrid = keyHints(keymap, undefined, 'grid').map((h) => h.description);
    const onKv = keyHints(keymap, undefined, 'kv').map((h) => h.description);

    // DES binds Enter to "open the SEC filing" only on a grid (`when: 'grid'`).
    expect(onGrid).toContain('Open the SEC filing');
    expect(onKv).not.toContain('Open the SEC filing');
    // A `table` is a grid without live cells, so a `when: 'grid'` binding reaches it too.
    expect(keyHints(keymap, undefined, 'table').map((h) => h.description)).toContain(
      'Open the SEC filing',
    );
    // In the command line a printable key is text, never an action.
    expect(keyHints(keymap, undefined, 'command')).toEqual([]);
    expect(keyHints(keymap, undefined, null)).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The panel footer                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

describe('the panel footer', () => {
  it('shows the attribution the screen asked for', () => {
    render(<Shell />);
    const des = DES();
    run('p1', des);

    const sources = specOf(des).footer?.sources ?? [];
    expect(sources.length).toBeGreaterThan(0);
    const footer = screen.getByTestId('panel-sources-p1');
    for (const source of sources) expect(footer).toHaveTextContent(source);
  });

  it('shows the last error of the frame, with its trace id', () => {
    render(<Shell />);
    run('p1', DES());
    act(() => {
      usePanelsStore.getState().replaceFrame('p1', {
        status: 'error',
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'yahoo.chart did not answer',
          traceId: 'deadbeef-0000-4000-8000-000000000003',
        },
      });
    });

    const line = screen.getByTestId('panel-error-p1');
    expect(line).toHaveTextContent('UPSTREAM_UNAVAILABLE');
    expect(line).toHaveTextContent('yahoo.chart did not answer');
    expect(line).toHaveTextContent('deadbeef');
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The status bar                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

describe('the status bar', () => {
  it('names all five value states with the treatment the cells use', () => {
    render(<Shell />);
    const legend = screen.getByTestId('staleness-legend');

    // The same five `ValueState`s the renderer draws, and the same `data-st` attribute — which is
    // what `tokens.css` styles, so the swatch cannot drift from the cell it explains.
    expect(STALENESS_LEGEND.map((e) => e.st)).toEqual(['live', 'stale', 'closed', 'blank', 'na']);
    for (const entry of STALENESS_LEGEND) {
      const swatch = legend.querySelector(`[data-legend-swatch="${entry.st}"]`);
      expect(swatch).not.toBeNull();
      expect(swatch).toHaveAttribute('data-st', entry.st);
      expect(legend).toHaveTextContent(entry.label);
    }
  });

  it('shows the connection state, the conflation interval and the focused frame’s trace id', () => {
    render(<Shell connection="open" />);
    expect(screen.getByTestId('status-bar')).toHaveTextContent('LIVE');
    expect(screen.getByTestId('conflation')).toHaveTextContent('conf 250ms');

    run('p1', DES());
    expect(screen.getByTestId('trace-id')).toHaveTextContent('aaaaaaaa');
  });

  it('a socket that is not open never reads LIVE', () => {
    expect(connectionOf('idle').label).toBe('OFFLINE');
    expect(connectionOf('closed').label).toBe('OFFLINE');
    expect(connectionOf('connecting').label).toBe('RESYNC');
    expect(connectionOf('resyncing').label).toBe('RESYNC');
    expect(connectionOf('open').label).toBe('LIVE');
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The workspace (TERM-05)                                                                          */
/* ---------------------------------------------------------------------------------------------- */

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

/** A layout that is visibly not the default: two panels, side by side, focused on the second. */
function twoPanelLayout(): WorkspaceLayout {
  const seed = DEFAULT_LAYOUT.panels[0];
  if (seed === undefined) throw new Error('the default layout has no panels');
  return {
    ...structuredClone(DEFAULT_LAYOUT),
    mode: '2h',
    panels: [structuredClone(seed), { ...structuredClone(seed), id: 'p2' }],
    focus: 'p2',
  };
}

/** The `409` the workspace route returns, carrying `details.current` (API.md §5.7). */
function conflict(
  version: number,
  layout: WorkspaceLayout,
): Error & { status: number; code: string; details: unknown } {
  return Object.assign(new Error('the workspace changed under this save'), {
    status: 409,
    code: 'WORKSPACE_VERSION_CONFLICT',
    details: { current: { version, layout } },
  });
}

describe('the workspace', () => {
  it('loads through the store on mount and lays the panels out as the server had them', async () => {
    const api: WorkspaceApi = {
      getActive: () => Promise.resolve(workspaceOf(4, twoPanelLayout())),
      putActive: () => Promise.reject(new Error('not expected')),
    };

    render(<Shell workspace={api} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(useWorkspaceStore.getState().version).toBe(4);
    expect(usePanelsStore.getState().mode).toBe('2h');
    expect(document.querySelectorAll('[data-panel]')).toHaveLength(2);
    expect(focusedPanelIds()).toEqual(['p2']);
  });

  it('surfaces a 409 the merge could not settle, and lets the user act on it', async () => {
    const user = userEvent.setup({ delay: null });
    const serverLayout = twoPanelLayout();
    const api: WorkspaceApi = {
      getActive: () => Promise.resolve(workspaceOf(9, serverLayout)),
      // Another window is writing continuously: the first PUT conflicts, and so does the merged
      // retry. That second 409 is the one the user has to be told about.
      putActive: () => Promise.reject(conflict(9, serverLayout)),
    };

    useWorkspaceStore.getState().configure({ api, scheduler: recordingScheduler() });
    act(() => {
      useWorkspaceStore.getState().hydrate(workspaceOf(3, structuredClone(DEFAULT_LAYOUT)));
    });

    render(<Shell />);
    expect(screen.queryByTestId('workspace-conflict')).toBeNull();

    act(() => {
      usePanelsStore.getState().setMode('2v');
    });
    await act(async () => {
      await useWorkspaceStore.getState().saveNow();
    });

    expect(useWorkspaceStore.getState().status).toBe('conflict');
    const alert = screen.getByTestId('workspace-conflict');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Workspace saved elsewhere (server version 9)');
    // Nothing local was thrown away while the user decides.
    expect(useWorkspaceStore.getState().dirty.size).toBeGreaterThan(0);
    expect(usePanelsStore.getState().mode).toBe('2v');

    // …and the message is actionable, not merely informative.
    await act(async () => {
      await user.click(within(alert).getByRole('button', { name: 'Reload theirs' }));
    });

    expect(screen.queryByTestId('workspace-conflict')).toBeNull();
    expect(useWorkspaceStore.getState().status).toBe('idle');
    expect(useWorkspaceStore.getState().version).toBe(9);
    expect(usePanelsStore.getState().mode).toBe('2h');
    expect(document.querySelectorAll('[data-panel]')).toHaveLength(2);
  });

  it('a 409 the user has not answered does not schedule another save over it', () => {
    const scheduler = recordingScheduler();
    const api: WorkspaceApi = {
      getActive: () => Promise.resolve(workspaceOf(9, twoPanelLayout())),
      putActive: () => Promise.reject(conflict(9, twoPanelLayout())),
    };
    useWorkspaceStore.getState().configure({ api, scheduler });
    act(() => {
      useWorkspaceStore.getState().hydrate(workspaceOf(3, structuredClone(DEFAULT_LAYOUT)));
    });

    render(<Shell />);
    act(() => {
      usePanelsStore.getState().setMode('2v');
    });
    const scheduledBeforeConflict = scheduler.timers.length;
    expect(scheduledBeforeConflict).toBeGreaterThan(0);

    act(() => {
      useWorkspaceStore.setState({
        status: 'conflict',
        conflict: { serverVersion: 9, serverLayout: twoPanelLayout() },
      });
    });
    act(() => {
      usePanelsStore.getState().setMode('4');
    });

    expect(scheduler.timers).toHaveLength(scheduledBeforeConflict);
    expect(screen.getByTestId('workspace-conflict')).toHaveTextContent('R reload theirs');
  });
});

describe('a frame carries the params that were STORED, not the params a manifest defaults', () => {
  /**
   * A restored workspace frame holds only the keys the user actually set — `pushFrame` stores what
   * the dispatcher was given, and `GET /workspace` returns that. `FunctionScreen<Params, Payload>`
   * declares `Params` as the OUTPUT of the manifest's zod object, so a screen is entitled to read a
   * key the manifest gives a `.default()`. `Panel` is the seam that has to reconcile the two.
   *
   * It did not, and the whole suite was blind to it because `launchOf` above pre-parses
   * (`manifests[code].params.parse({})`) — every test here hands the screen a shape the real restore
   * path never produces. Loading the running application as a seeded user is what found it: the four
   * restored panels each ran their function and answered 200, then the page went blank on
   * `TypeError: params.regions is not iterable` from WEI's skeleton branch.
   */
  it('renders a restored WEI frame whose stored params omit a defaulted key', () => {
    render(<Shell />);
    act(() => {
      // Deliberately RAW and partial: no `regions`, exactly as a workspace round-trip returns it.
      usePanelsStore.getState().pushFrame('p1', {
        security: null,
        fn: 'WEI',
        traceId: 'restored-wei-0001',
        params: {},
        instrument: null,
      });
    });

    // The skeleton branch draws before any payload arrives, which is where it used to throw.
    const panel = screen.getByTestId('panel-body-p1');
    expect(within(panel).getByText(/WEI/)).toBeInTheDocument();
    // The manifest's default is three regions; the skeleton draws a header per region.
    for (const region of ['AMERICAS', 'EMEA', 'APAC']) {
      expect(within(panel).getByText(region)).toBeInTheDocument();
    }
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* What a panel asks the socket for (CLIENT §9, TERM-08, TERM-12)                                   */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The panel-side half of the live path, which for fifteen packages did not exist.
 *
 * `state/subscriptions.ts#acquire` turns a screen's `LiveSpec` into `sub` frames and had no product
 * caller: the only subscription the terminal ever made was `ChartCanvas`'s, so every grid drew its
 * payload once and never received a delta — measured in Chrome, with the call removed again, as
 * `q:85`, `q:21133` and `q:37398` never subscribed while the chart's `q:37367` was. `Panel` is the
 * component that holds the frame, the manifest and the parsed params, so it is the component that can
 * answer "what does this panel want off the wire".
 *
 * One limit of this file, stated rather than worked around: the committed goldens carry REDACTED
 * instrument ids (`q:<AAPL>`), and `planSubscription` drops a subject that does not match the wire
 * grammar — correctly, since the plant would reject the whole `sub` frame for it. So a golden-driven
 * grid proves the spec that was computed and the subjects that were dropped; the assertion that a
 * `sub` reaches the socket is made on CRVF, whose subject comes from a param and is therefore real.
 * The end-to-end claim — a `sub` for a grid's own subjects, and a delta repainting the cell that
 * changed — is `packages/e2e/tests/live-grid.spec.ts`'s, against the seeded database.
 */
describe('a panel subscribes what its manifest asks for', () => {
  interface SubCall {
    subjects: string[];
    fields: FieldId[] | '*';
    options: SubscribeOptions | undefined;
  }

  /** `LiveSubscriber` as `rt/wsBridge.ts` attaches it: the socket, recorded. */
  function recordingSubscriber(): { calls: SubCall[]; unsubscribed: number[] } {
    const calls: SubCall[] = [];
    const unsubscribed: number[] = [];
    useSubscriptionsStore.getState().attach({
      subscribe: (subjects, fields, opts): Subscription => {
        const id = calls.length + 1;
        calls.push({ subjects: [...subjects], fields, options: opts });
        return {
          id,
          subjects,
          fields,
          ack: Promise.resolve({ accepted: [], rejected: [] }),
          on: () => () => undefined,
          unsubscribe: () => unsubscribed.push(id),
        };
      },
    });
    return { calls, unsubscribed };
  }

  const W = (): Launch => launchOf('W', 'W.default.json', 'cccccccc-0000-4000-8000-000000000003');
  const HP = (): Launch => launchOf('HP', 'HP.price.json', 'dddddddd-0000-4000-8000-000000000004');

  it('computes the spec from the manifest over the payload on screen', () => {
    render(<Shell />);
    const w = W();
    run('p1', w);

    // What W's own `live` says about this payload — taken from the manifest, because the subjects are
    // the watchlist's rows and a transcribed list would start asserting about the fixture instead.
    const expected = manifests.W.live?.(w.params as never, w.payload as never) ?? null;
    expect(expected, 'W no longer declares a live spec — this test is about the wrong function').not.toBeNull();

    const entry = useSubscriptionsStore.getState().byPanel.p1;
    expect(entry, 'the panel painted a streaming screen and asked for nothing').not.toBeNull();
    expect(entry?.spec).toEqual(expected);
    // It is the watchlist's four rows that were asked for, not an empty list that happens to match.
    expect(entry?.spec.subjects).toContain('q:<AAPL>');
    expect(entry?.spec.subjects.length).toBeGreaterThan(1);
    expect(entry?.spec.fields).toContain('PX_LAST');
    // …and the redacted ids are reported as dropped rather than silently discarded, which is also
    // the proof that the plan was built from THIS payload's subjects (`planSubscription`).
    expect(entry?.plan.dropped.map((d) => d.subject)).toContain('q:<AAPL>');
  });

  it('subscribes the parsed params, not the raw ones a restored frame carries', () => {
    const socket = recordingSubscriber();
    render(<Shell />);

    // A restored CRVF frame: `params` holds only what the user typed, and they typed nothing.
    // CRVF's live is `subjects: ['c:' + params.curveId]` over a key the manifest defaults to
    // `UST_PAR`, so the raw bag would subscribe `c:undefined` — a subject the plant rejects, taking
    // the whole `sub` frame with it, which is the failure mode `screenParams` exists to prevent.
    act(() => {
      usePanelsStore.getState().pushFrame('p1', {
        security: null,
        fn: 'CRVF',
        traceId: 'restored-crvf-0001',
        params: {},
        instrument: null,
      });
      usePanelsStore.getState().replaceFrame('p1', {
        payload: golden('CRVF.default.json'),
        meta: metaFor('restored-crvf-0001'),
        status: 'ready',
      });
    });

    expect(usePanelsStore.getState().panels.p1?.frameStack[0]?.params).toEqual({});
    expect(selectSubjects(useSubscriptionsStore.getState())).toEqual(['c:UST_PAR']);
    // And it reached the socket the bridge attached: `c:` is one of the families for which `f: []`
    // is legal (API.md §6.1), which is what `'*'` becomes on the wire.
    expect(socket.calls).toEqual([
      { subjects: ['c:UST_PAR'], fields: '*', options: { essential: true, conflationMs: 1_000 } },
    ]);
  });

  it('releases the subjects when the frame moves to a screen that does not stream', () => {
    const socket = recordingSubscriber();
    render(<Shell />);

    act(() => {
      usePanelsStore.getState().pushFrame('p1', {
        security: null,
        fn: 'CRVF',
        traceId: 'crvf-0002',
        params: {},
        instrument: null,
      });
      usePanelsStore.getState().replaceFrame('p1', {
        payload: golden('CRVF.default.json'),
        meta: metaFor('crvf-0002'),
        status: 'ready',
      });
    });
    expect(socket.calls).toHaveLength(1);
    expect(socket.unsubscribed).toEqual([]);

    // HP is a static screen (`live: null`): nothing about a price history changes while it is open,
    // so holding its predecessor's subjects would spend the session's subscription budget on a panel
    // that cannot show a tick.
    run('p1', HP());
    expect(useSubscriptionsStore.getState().byPanel.p1).toBeUndefined();
    expect(socket.unsubscribed).toEqual([1]);
    // No churn on the way: a release is not a resubscribe.
    expect(socket.calls).toHaveLength(1);
  });

  it('releases them when the panel goes away, and a repaint does not resubscribe', () => {
    const socket = recordingSubscriber();
    const view = render(<Shell />);

    const w = W();
    run('p1', w);
    const first = useSubscriptionsStore.getState().byPanel.p1?.plan;
    expect(first).toBeDefined();

    // The same payload painted again — a status write, a focus change, any of the things that give a
    // frame a new identity. `acquire` diffs, so the socket sees nothing: a repaint that resubscribed
    // would gap the stream and make the server rebuild its field mask several times a second.
    run('p1', w);
    expect(useSubscriptionsStore.getState().byPanel.p1?.plan).toBe(first);
    expect(socket.calls).toHaveLength(0); // W's golden subjects are redacted, hence dropped

    // Going 4 → 1 unmounts three panels; this unmounts all of them at once, which is the same event.
    view.unmount();
    expect(useSubscriptionsStore.getState().byPanel).toEqual({});
  });
});
