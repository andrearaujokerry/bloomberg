/**
 * packages/web/test/screen/renderer.test.tsx — the WP-12 acceptance row for the screen renderer.
 *
 * WORKPLAN L1404: "every `Node` kind keyboard-operable; each `Cell` state renders distinctly;
 * provenance panel opens on `Ctrl+I`".
 *
 * The fixtures are the real thing on both sides. The payloads are the committed goldens under
 * `fixtures/golden/functions/` — the exact JSON the server produces at the frozen clock — and the
 * specs are what the 38 shipped `Screen.tsx` files return when handed those payloads. Nothing here
 * hand-builds a `ScreenSpec` for its own convenience, because a renderer that only agrees with
 * specs the renderer's own author wrote proves nothing about the 38 screens.
 *
 * Three places where a hand-built node is unavoidable, each stated where it is used:
 *   1. **`chart`** — no shipped screen emits `kind: 'chart'`. All eleven chart-bearing screens go
 *      through `custom` with a `PriceChart`/`CurveChart`/`OptionSurface` component and a `ChartSpec`
 *      in `props`, because WP-13/14 own the canvas. The `chart` widget is still part of the fixed
 *      set and still has to work, so it is exercised against a `ChartSpec` lifted out of GP's own
 *      `gpChartSpec`, not out of thin air.
 *   2. **the five `ValueState`s side by side** — no single payload carries all five. The distinctness
 *      test needs the same value in five states to compare, which no golden provides.
 *   3. **a `boolean` form field** — no shipped screen has one today (`Space` toggles a checkbox, and
 *      the three `type: 'boolean'` occurrences in the screens are CSV columns, not form fields).
 *
 * `user-event` runs with `delay: null`: a web test drives frames, never `setTimeout` (TESTING §2.2).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifests } from '@terminal/core';
import type { FunctionCode, ParamsOf, PayloadOf } from '@terminal/core';
import type { InstrumentSummary, PayloadMeta } from '@terminal/sdk';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ScreenRenderer } from '../../src/screen/ScreenRenderer.js';
import type { ScreenHandle } from '../../src/screen/ScreenRenderer.js';
import type {
  Cell,
  ChartSpec,
  FunctionScreen,
  LiveView,
  Node,
  ScreenCtx,
  ScreenProps,
  ScreenSpec,
} from '../../src/screen/types.js';
import type {
  ChartCanvasProps,
  LiveGridProps,
  ScreenActions,
  WidgetRegistry,
} from '../../src/screen/widgets/registry.js';
import { gpChartSpec } from '../../src/screens/GP/Screen.js';
import { screenModules } from '../../src/screens/index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures — the committed goldens, and the props a panel would hand a screen
// ─────────────────────────────────────────────────────────────────────────────────────────────

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(dirname(TEST_DIR))));
const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'golden', 'functions');

function golden<C extends FunctionCode>(name: string): PayloadOf<C> {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')) as PayloadOf<C>;
}

/** The deepest `provIdx` a payload cites — `meta.provenance` must be at least that long. */
function maxProvIdx(value: unknown): number {
  let max = -1;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    for (const [key, val] of Object.entries(v)) {
      if (key === 'provIdx') {
        const ns = Array.isArray(val) ? val : [val];
        for (const n of ns) if (typeof n === 'number' && n > max) max = n;
        continue;
      }
      walk(val);
    }
  };
  walk(value);
  return max;
}

/** A `PayloadMeta` consistent with the payload it describes (one provenance entry per cited idx). */
function metaFor(payload: unknown): PayloadMeta {
  const count = maxProvIdx(payload) + 1;
  return {
    traceId: '0f2c9ab1-0000-4000-8000-00000000abcd',
    resultId: '01J0000000000000000000TEST',
    asOf: { validAt: '2026-09-15T18:41:28.000Z', knownAt: '2026-09-15T18:41:28.000Z' },
    tier: 'delayed',
    staleness: 'live',
    provenance: Array.from({ length: Math.max(count, 1) }, (_v, idx) => ({
      idx,
      sourceId: `source.${String(idx)}`,
      provenanceId: 1000 + idx,
      capturedAt: '2026-09-15T18:41:28.000Z',
      sourceTs: '2026-09-15T18:26:26.000Z',
      attribution: `Attribution for source ${String(idx)}`,
    })),
    entitlement: [{ fieldId: 'PX_BID', decision: 'deny', effectiveTier: null, reason: 'TIER_EOD' }],
    unavailable: [
      { field: 'fundamentals', reason: 'NO_SOURCE', detail: 'no XBRL facts for this issuer' },
    ],
    engines: [],
    page: { index: 0, count: 1, cursor: null },
    servedAt: '2026-09-15T18:41:28.100Z',
  };
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

const LIVE: LiveView = {
  get: (subject, field) => ({ v: null, st: 'blank', provIdx: -1, live: { subject, field } }),
  state: () => 'blank',
};

/** Everything the shell would do, recorded instead of done. `ScreenCtx` satisfies `ScreenActions`. */
interface Recorder {
  navigate: string[];
  navigateNext: string[];
  openUrl: string[];
  provenance: number[];
  setParams: Record<string, unknown>[];
}

function newRecorder(): Recorder {
  return { navigate: [], navigateNext: [], openUrl: [], provenance: [], setParams: [] };
}

function recordingCtx<P>(rec: Recorder): ScreenCtx<P> {
  return {
    panelId: 'p1',
    setParams: (patch) => rec.setParams.push(patch),
    navigate: (command) => rec.navigate.push(command),
    navigateNext: (command) => rec.navigateNext.push(command),
    export: () => undefined,
    page: () => undefined,
    focus: () => undefined,
    prompt: () => Promise.resolve(null),
    provenance: (idx) => rec.provenance.push(idx),
    openUrl: (url) => rec.openUrl.push(url),
  };
}

function propsFor<C extends FunctionCode>(
  code: C,
  payload: PayloadOf<C>,
  overrides: Record<string, unknown>,
  rec: Recorder,
): ScreenProps<ParamsOf<C>, PayloadOf<C>> {
  return {
    payload,
    params: manifests[code].params.parse(overrides) as ParamsOf<C>,
    instrument: INSTRUMENT,
    meta: metaFor(payload),
    live: LIVE,
    ctx: recordingCtx<ParamsOf<C>>(rec),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The corpus: every one of the 38 codes, against a committed golden
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Case {
  name: string;
  code: FunctionCode;
  spec: ScreenSpec;
  meta: PayloadMeta;
  rec: Recorder;
}

const GP_PARAMS = {
  range: 'CUSTOM',
  start: '2026-09-01',
  end: '2026-09-15',
  studies: [
    { id: 'SMA', params: { n: 20 }, pane: 'main' },
    { id: 'RSI', params: { n: 14 } },
  ],
};

const SPECS: [name: string, code: FunctionCode, file: string, params: Record<string, unknown>][] = [
  ['BTMM.default', 'BTMM', 'BTMM.default.json', {}],
  ['CACS.issuer', 'CACS', 'CACS.issuer.json', {}],
  ['CF.issuer', 'CF', 'CF.issuer.json', {}],
  ['CN.issuer', 'CN', 'CN.issuer.json', {}],
  ['CRVF.default', 'CRVF', 'CRVF.default.json', {}],
  ['CRYP.default', 'CRYP', 'CRYP.default.json', {}],
  ['DES.equity', 'DES', 'DES.equity.json', {}],
  ['DES.equity(news)', 'DES', 'DES.equity.json', { tab: 'news' }],
  // DES on a government bond carries `identifiers: []`, so it is the corpus's one empty node — the
  // case that showed a caption and five column headers nothing could ever put the focus on.
  ['DES.govt', 'DES', 'DES.govt.json', {}],
  ['ECO.calendar', 'ECO', 'ECO.default.json', {}],
  ['EE.equity', 'EE', 'EE.equity.json', {}],
  ['EQS.default', 'EQS', 'EQS.default.json', {}],
  ['FA.equity', 'FA', 'FA.equity.json', {}],
  ['FED.default', 'FED', 'FED.default.json', {}],
  ['FXC.live', 'FXC', 'FXC.default.json', {}],
  ['GC.default', 'GC', 'GC.default.json', {}],
  ['GIP.intraday', 'GIP', 'GIP.intraday.json', {}],
  ['GP.equity', 'GP', 'GP.equity.json', GP_PARAMS],
  ['HDS.equity', 'HDS', 'HDS.equity.json', {}],
  ['HELP.default', 'HELP', 'HELP.default.json', {}],
  ['HP.price', 'HP', 'HP.price.json', {}],
  ['MEMB.index', 'MEMB', 'MEMB.index.json', { groupBy: 'gics_sector', compareDate: '2026-03-31' }],
  ['MSG.default', 'MSG', 'MSG.default.json', {}],
  ['N.default', 'N', 'N.default.json', { q: 'capital' }],
  ['NI.default', 'NI', 'NI.default.json', { topic: 'FED' }],
  ['OMON.underlying', 'OMON', 'OMON.underlying.json', {}],
  ['OVML.contract', 'OVML', 'OVML.contract.json', {}],
  ['PORT.holdings', 'PORT', 'PORT.default.json', {}],
  ['Q.quote', 'Q', 'Q.quote.json', {}],
  ['QM.default', 'QM', 'QM.default.json', {}],
  ['RV.equity', 'RV', 'RV.equity.json', {}],
  ['SECF.default', 'SECF', 'SECF.default.json', { query: 'apple' }],
  ['SRCH.default', 'SRCH', 'SRCH.default.json', {}],
  ['SWPM.default', 'SWPM', 'SWPM.default.json', {}],
  ['TOP.default', 'TOP', 'TOP.default.json', {}],
  ['W.default', 'W', 'W.default.json', {}],
  ['W.manage', 'W', 'W.default.json', { view: 'manage' }],
  ['WB.default', 'WB', 'WB.default.json', {}],
  ['WEI.default', 'WEI', 'WEI.default.json', {}],
  ['WIRP.default', 'WIRP', 'WIRP.default.json', {}],
  ['YAS.govt', 'YAS', 'YAS.govt.json', {}],
];

type AnyScreen = FunctionScreen<never, never>;

function buildCase(entry: (typeof SPECS)[number]): Case {
  const [name, code, file, params] = entry;
  const payload = golden(file);
  const rec = newRecorder();
  const mod = screenModules[code] as { Screen: AnyScreen };
  const props = propsFor(code, payload, params, rec) as unknown as ScreenProps<never, never>;
  return { name, code, spec: mod.Screen(props), meta: metaFor(payload), rec };
}

const CASES: Case[] = SPECS.map(buildCase);

function caseNamed(name: string): Case {
  const found = CASES.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no case ${name}`);
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Spec walking (only into the tab that is actually on screen)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const NODE_KINDS = [
  'split',
  'kv',
  'grid',
  'table',
  'chart',
  'tabs',
  'form',
  'text',
  'list',
  'badges',
  'custom',
] as const;
type NodeKind = (typeof NODE_KINDS)[number];

/** Every node the renderer will actually mount, in document order. */
function mountedNodes(node: Node, out: Node[] = []): Node[] {
  out.push(node);
  if (node.kind === 'split') for (const child of node.children) mountedNodes(child, out);
  if (node.kind === 'tabs') {
    const active = node.tabs.find((t) => t.id === node.active) ?? node.tabs[0];
    if (active !== undefined) mountedNodes(active.body, out);
  }
  return out;
}

function mountedIds(spec: ScreenSpec): string[] {
  return mountedNodes(spec.body)
    .filter((n) => n.kind !== 'split')
    .map((n) => n.id);
}

function firstOfKind<K extends NodeKind>(
  spec: ScreenSpec,
  kind: K,
): Extract<Node, { kind: K }> | undefined {
  return mountedNodes(spec.body).find((n) => n.kind === kind) as
    Extract<Node, { kind: K }> | undefined;
}

/** Every case whose mounted tree contains `kind`, so a per-kind test can pick a real one. */
function casesWith(kind: NodeKind): Case[] {
  return CASES.filter((c) => mountedNodes(c.spec.body).some((n) => n.kind === kind));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rendering helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RenderOptions {
  widgets?: WidgetRegistry;
  autoFocus?: boolean;
  handle?: { current: ScreenHandle | null };
}

function renderSpec(
  spec: ScreenSpec,
  meta: PayloadMeta | undefined,
  rec: Recorder,
  opts: RenderOptions = {},
): HTMLElement {
  const actions: ScreenActions = recordingCtx(rec);
  const { container } = render(
    <ScreenRenderer
      spec={spec}
      meta={meta}
      actions={actions}
      widgets={opts.widgets ?? {}}
      format={{ currency: 'USD', priceDecimals: 2 }}
      autoFocus={opts.autoFocus ?? false}
      ref={opts.handle}
    />,
  );
  return container;
}

function renderCase(c: Case, opts: RenderOptions = {}): HTMLElement {
  return renderSpec(c.spec, c.meta, c.rec, opts);
}

function setup(): UserEvent {
  // `delay: null` keeps `user-event` off `setTimeout` entirely (TESTING §2.2 L115-119).
  return userEvent.setup({ delay: null });
}

function focusedNodeId(): string | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return null;
  return el.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? null;
}

/**
 * What a sighted user actually reads in an element: its text with every `.sr-only` span removed.
 *
 * `el.textContent` is not that. Every cell carries a visually-hidden state phrase — `widgets.css`
 * clips `.sr-only` to one pixel — so `textContent` says "231.45 (closed, session ended)" for a cell
 * that renders `231.45` on screen. An assertion over `textContent` therefore cannot fail when two
 * states collapse to the same visible rendering, which is the one thing it is there to catch.
 */
function visibleText(el: Element | null | undefined): string {
  if (el === null || el === undefined) return '';
  const clone = el.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('.sr-only')) hidden.remove();
  return (clone.textContent ?? '').trim();
}

/**
 * The `::after` glyph each `ValueState` is given, read out of the two stylesheets that declare them.
 *
 * jsdom does not compute pseudo-element content, so a rendering test cannot see these marks in the
 * DOM — but they are half of what makes `stale` and `closed` distinguishable from `live` without
 * relying on colour, so a test that ignores them is measuring the wrong thing. Reading the rules is
 * the honest substitute: delete the `closed` rule and the two states collapse and this fails.
 */
function stateGlyphs(): Map<string, string> {
  const files = [
    join(TEST_DIR, '..', '..', 'src', 'theme', 'tokens.css'),
    join(TEST_DIR, '..', '..', 'src', 'screen', 'widgets', 'widgets.css'),
  ];
  const glyphs = new Map<string, string>();
  for (const file of files) {
    const css = readFileSync(file, 'utf8');
    const re = /\[data-st='(\w+)'\]::after\s*\{\s*content:\s*'([^']*)'/g;
    let hit: RegExpExecArray | null = re.exec(css);
    while (hit !== null) {
      if (hit[1] !== undefined && hit[2] !== undefined) glyphs.set(hit[1], hit[2]);
      hit = re.exec(css);
    }
  }
  return glyphs;
}

/** Every `Cell` the renderer will mount for this spec, with the node it sits in. */
function mountedCells(spec: ScreenSpec): Cell[] {
  const cells: Cell[] = [];
  for (const node of mountedNodes(spec.body)) {
    if (node.kind === 'kv') for (const row of node.rows) cells.push(row.value);
    else if (node.kind === 'table')
      for (const row of node.rows) for (const cell of row) cells.push(cell);
  }
  return cells;
}

/** Press `Tab` up to `limit` times and report the node id focus sat in after each press. */
async function tabThrough(user: UserEvent, limit: number): Promise<string[]> {
  const visited: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    await user.tab();
    visited.push(focusedNodeId() ?? '(outside)');
  }
  return visited;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The renderer and the 38 screens agree
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the fixed widget set renders every shipped screen', () => {
  it('covers all 38 function codes', () => {
    const codes = new Set(CASES.map((c) => c.code));
    expect(codes.size).toBe(Object.keys(screenModules).length);
  });

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s renders every mounted node, in spec order',
    (_name, c) => {
      const container = renderCase(c);
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(c.spec.title);

      const inDom = [...container.querySelectorAll<HTMLElement>('[data-node-id]')].map(
        (el) => el.dataset.nodeId ?? '',
      );
      // Every mounted node drew, exactly once, in document order — which is what makes `Tab` move
      // through a screen in reading order without the renderer keeping a focus list.
      expect(inDom).toEqual(mountedIds(c.spec));
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s uses no widget outside the fixed set',
    (_name, c) => {
      const kinds = new Set(mountedNodes(c.spec.body).map((n) => n.kind));
      for (const kind of kinds) expect(NODE_KINDS).toContain(kind);
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s names a real node in initialFocus, and autoFocus lands on it',
    async (_name, c) => {
      if (c.spec.initialFocus === undefined) return;
      expect(mountedIds(c.spec)).toContain(c.spec.initialFocus);
      renderCase(c, { autoFocus: true });
      await Promise.resolve();
      expect(focusedNodeId()).toBe(c.spec.initialFocus);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. Every Node kind is keyboard-operable (TERM-06)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('every Node kind is keyboard-operable', () => {
  it('the corpus covers ten of the eleven kinds; chart is covered separately', () => {
    const covered = NODE_KINDS.filter((kind) => casesWith(kind).length > 0);
    expect([...covered].sort()).toEqual([...NODE_KINDS].filter((k) => k !== 'chart').sort());
  });

  it.each(NODE_KINDS.filter((k) => k !== 'split' && k !== 'chart'))(
    'a real %s node is reachable by Tab',
    async (kind) => {
      const c = casesWith(kind)[0];
      expect(c).toBeDefined();
      if (c === undefined) return;
      const node = firstOfKind(c.spec, kind);
      expect(node).toBeDefined();
      if (node === undefined) return;

      const user = setup();
      renderCase(c);
      // Generous: a form contributes one tab stop per field, so the budget is not the node count.
      const visited = await tabThrough(user, mountedIds(c.spec).length + 60);
      expect(visited).toContain(node.id);
    },
  );

  // ── empty nodes ──────────────────────────────────────────────────────────────────────────
  //
  // A node is one tab stop in EVERY state. The roving widgets built their tab stop over their
  // items, so a node with no items had no tab stop at all: it disappeared from the Tab order, from
  // `ctx.focus(id)` and from `Ctrl+I` exactly when its payload was empty. DES on a government bond
  // is the live case in the corpus — `identifiers: []` drew a caption and five column headers that
  // nothing could ever land on — and the suite never rendered an empty node of any kind before.

  const EMPTY_SPEC: ScreenSpec = {
    title: 'Empty nodes',
    body: {
      kind: 'split',
      dir: 'col',
      sizes: [0.2, 0.2, 0.2, 0.2, 0.2],
      children: [
        { kind: 'kv', id: 'kvE', title: 'Values', rows: [] },
        { kind: 'table', id: 'tblE', caption: 'Identifiers', columns: [], rows: [] },
        { kind: 'list', id: 'lstE', items: [] },
        { kind: 'badges', id: 'bdgE', items: [] },
        { kind: 'tabs', id: 'tabE', tabs: [], active: 'none' },
      ],
    },
  };
  const EMPTY_IDS = ['kvE', 'tblE', 'lstE', 'bdgE', 'tabE'];

  it.each(EMPTY_IDS)('an empty %s node is still exactly one tab stop', (id) => {
    const container = renderSpec(EMPTY_SPEC, metaFor({}), newRecorder());
    const node = container.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
    expect(node).not.toBeNull();
    expect(node?.tabIndex).toBe(0);
    node?.focus();
    expect(focusedNodeId()).toBe(id);
    // And it says out loud that it is empty, rather than showing headers over nothing.
    expect(visibleText(node)).not.toBe('');
  });

  it('a Tab sweep reaches every empty node, in document order', async () => {
    const user = setup();
    renderSpec(EMPTY_SPEC, metaFor({}), newRecorder());
    const visited = await tabThrough(user, EMPTY_IDS.length + 4);
    const seen = [...new Set(visited.filter((id) => EMPTY_IDS.includes(id)))];
    expect(seen).toEqual(EMPTY_IDS);
  });

  it('an empty table shows no column headers over rows it does not have', () => {
    const container = renderSpec(
      {
        title: 'Empty table',
        body: {
          kind: 'table',
          id: 'ids',
          caption: 'Identifiers (REF-02)',
          columns: [
            { id: 'a', label: 'ISIN' },
            { id: 'b', label: 'CUSIP' },
          ],
          rows: [],
        },
      },
      metaFor({}),
      newRecorder(),
    );
    expect(container.querySelectorAll('[role="columnheader"]')).toHaveLength(0);
    expect(visibleText(container.querySelector('[data-node-id="ids"]'))).toContain('No rows');
  });

  it('DES.govt: the empty identifiers table is reachable — the case that was live at HEAD', async () => {
    const c = caseNamed('DES.govt');
    const empty = mountedNodes(c.spec.body).find((n) => n.kind === 'table' && n.rows.length === 0);
    expect(empty).toBeDefined();
    if (empty === undefined || empty.kind === 'split') return;

    const user = setup();
    renderCase(c);
    const visited = await tabThrough(user, mountedIds(c.spec).length + 60);
    expect(visited).toContain(empty.id);
  });

  it('a focus request for a node inside an INACTIVE tab selects the tab and lands on it', async () => {
    // The node is in the spec and not in the DOM, which is what a tabbed screen invites. Before,
    // `focusNode` returned false, the autoFocus effect discarded the boolean, and focus stayed on
    // <body> with no signal anywhere.
    const spec: ScreenSpec = {
      title: 'Tabbed',
      initialFocus: 'hidden',
      body: {
        kind: 'tabs',
        id: 'strip',
        active: 'one',
        tabs: [
          { id: 'one', label: 'One', body: { kind: 'text', id: 'shown', text: 'first' } },
          { id: 'two', label: 'Two', body: { kind: 'text', id: 'hidden', text: 'second' } },
        ],
      },
    };

    const handle: { current: ScreenHandle | null } = { current: null };
    const container = renderSpec(spec, metaFor({}), newRecorder(), { handle, autoFocus: true });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-node-id="hidden"]')).not.toBeNull();
    expect(focusedNodeId()).toBe('hidden');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      'Two',
    );

    // And the request is one-shot: selecting another tab afterwards is not overridden.
    const user = setup();
    const first = container.querySelectorAll<HTMLElement>('[role="tab"]')[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    await user.click(first);
    expect(container.querySelector('[data-node-id="shown"]')).not.toBeNull();
    expect(container.querySelector('[data-node-id="hidden"]')).toBeNull();

    // A second request for the same node works again, seq being what makes it not a no-op.
    act(() => {
      expect(handle.current?.focusNode('hidden')).toBe(true);
    });
    expect(focusedNodeId()).toBe('hidden');
  });

  it('a focus request for a node the spec does not contain reports false', () => {
    const handle: { current: ScreenHandle | null } = { current: null };
    renderSpec(
      { title: 'One node', body: { kind: 'text', id: 'only', text: 'x' } },
      metaFor({}),
      newRecorder(),
      { handle },
    );
    expect(handle.current?.focusNode('only')).toBe(true);
    expect(handle.current?.focusNode('nowhere')).toBe(false);
  });

  it('split keeps its children in document order, so Tab reads the screen top to bottom', async () => {
    const c = caseNamed('W.default');
    const split = firstOfKind(c.spec, 'split');
    expect(split).toBeDefined();
    if (split === undefined) return;
    expect(split.children.length).toBeGreaterThan(1);

    const user = setup();
    renderCase(c);
    const order = mountedIds(c.spec);
    const visited = await tabThrough(user, order.length + 20);
    const firstSeen = order.filter((id) => visited.includes(id));
    const seenOrder = [...new Set(visited.filter((id) => order.includes(id)))];
    expect(seenOrder).toEqual(firstSeen.slice(0, seenOrder.length));
  });

  it('kv: arrows move between rows inside one tab stop', async () => {
    const c = caseNamed('DES.equity');
    const kv = firstOfKind(c.spec, 'kv');
    expect(kv).toBeDefined();
    if (kv === undefined) return;
    expect(kv.rows.length).toBeGreaterThan(1);

    const user = setup();
    const container = renderCase(c, { autoFocus: false });
    const node = container.querySelector<HTMLElement>(`[data-node-id="${kv.id}"]`);
    expect(node).not.toBeNull();
    const rows = [...(node?.querySelectorAll<HTMLElement>('[role="row"]') ?? [])];
    expect(rows.length).toBe(kv.rows.length);

    rows[0]?.focus();
    expect(document.activeElement).toBe(rows[0]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rows[1]);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(rows[0]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(rows[rows.length - 1]);

    // One tab stop: exactly one row carries tabIndex 0 at any moment.
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it('table: arrows move cell to cell in two dimensions', async () => {
    const c = casesWith('table')[0];
    expect(c).toBeDefined();
    if (c === undefined) return;
    const table = firstOfKind(c.spec, 'table');
    if (table === undefined || table.rows.length < 2 || table.columns.length < 2) {
      throw new Error(`no multi-cell table in ${c.name}`);
    }

    const user = setup();
    const container = renderCase(c);
    const node = container.querySelector<HTMLElement>(`[data-node-id="${table.id}"]`);
    const cells = [...(node?.querySelectorAll<HTMLElement>('[role="cell"][tabindex]') ?? [])];
    expect(cells.length).toBeGreaterThan(table.columns.length);

    cells[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(cells[1]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(cells[1 + table.columns.length]);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(cells[table.columns.length]);
  });

  it('tabs: arrows and the tab key digit select, and the panel follows', async () => {
    const c = caseNamed('DES.equity');
    const tabs = firstOfKind(c.spec, 'tabs');
    expect(tabs).toBeDefined();
    if (tabs === undefined) return;
    expect(tabs.tabs.length).toBeGreaterThan(1);

    const user = setup();
    renderCase(c);
    const strip = screen.getByRole('tablist', { name: `Tabs ${tabs.id}` });
    const buttons = within(strip).getAllByRole('tab');
    expect(buttons).toHaveLength(tabs.tabs.length);

    buttons[0]?.focus();
    expect(buttons[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(buttons[1]).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(buttons[1]);
    const secondPanelId = `${tabs.id}-panel-${tabs.tabs[1]?.id ?? ''}`;
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', secondPanelId);

    // A tab that declares a key (DES numbers its tabs) is reachable by that key.
    const keyed = tabs.tabs.findIndex((t) => t.key !== undefined);
    if (keyed >= 0) {
      await user.keyboard(tabs.tabs[keyed]?.key ?? '');
      expect(buttons[keyed]).toHaveAttribute('aria-selected', 'true');
    }
  });

  it('list: arrows move, Enter runs the row command, Shift+Enter sends it to the next panel', async () => {
    const c = CASES.find((k) => {
      const list = firstOfKind(k.spec, 'list');
      return list?.items.some((i) => i.command !== undefined) === true;
    });
    expect(c).toBeDefined();
    if (c === undefined) return;
    const list = firstOfKind(c.spec, 'list');
    if (list === undefined) return;
    const withCommand = list.items.findIndex((i) => i.command !== undefined);

    const user = setup();
    const container = renderCase(c);
    const node = container.querySelector<HTMLElement>(`[data-node-id="${list.id}"]`);
    const options = [...(node?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    expect(options).toHaveLength(list.items.length);

    options[0]?.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(options[1]);

    const before = c.rec.navigate.length;
    options[withCommand]?.focus();
    await user.keyboard('{Enter}');
    expect(c.rec.navigate).toHaveLength(before + 1);
    expect(c.rec.navigate.at(-1)).toBe(list.items[withCommand]?.command);

    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(c.rec.navigateNext.at(-1)).toBe(list.items[withCommand]?.command);
  });

  it('badges: arrows walk the strip and the reason is readable without a pointer', async () => {
    const c = CASES.find((k) => {
      const b = firstOfKind(k.spec, 'badges');
      return b !== undefined && b.items.length > 1 && b.items.some((i) => i.title !== undefined);
    });
    expect(c).toBeDefined();
    if (c === undefined) return;
    const badges = firstOfKind(c.spec, 'badges');
    if (badges === undefined) return;

    const user = setup();
    const container = renderCase(c);
    const node = container.querySelector<HTMLElement>(`[data-node-id="${badges.id}"]`);
    const items = [...(node?.querySelectorAll<HTMLElement>('[role="listitem"]') ?? [])];
    expect(items).toHaveLength(badges.items.length);

    items[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(items[1]);

    const titled = badges.items.findIndex((i) => i.title !== undefined);
    const reason = badges.items[titled]?.title ?? '';
    // The reason is in the text, not only in a `title` attribute a keyboard user never sees.
    expect(items[titled]?.textContent).toContain(reason);
  });

  it('form: Tab reaches the fields, PageUp steps a number by bigStep, Space toggles a boolean', async () => {
    const c = caseNamed('W.manage');
    const form = firstOfKind(c.spec, 'form');
    expect(form).toBeDefined();
    if (form === undefined) return;

    const user = setup();
    renderCase(c);
    const first = form.fields[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const input = screen.getByLabelText(first.label);
    input.focus();
    await user.keyboard('AAPL');
    expect(input).toHaveValue(`${typeof first.value === 'string' ? first.value : ''}AAPL`);

    // Submitting hands `onSubmit` the edited values — the screen's own handler calls setParams.
    const before = c.rec.setParams.length;
    await user.keyboard('{Enter}');
    expect(c.rec.setParams.length).toBeGreaterThan(before);

    // No shipped screen declares a `boolean` or stepped `number` field yet, so these two go
    // through a `form` node built from the `FormField` contract directly.
    const synthetic: ScreenSpec = {
      title: 'Synthetic form',
      body: {
        kind: 'form',
        id: 'synthetic',
        fields: [
          { id: 'rate', label: 'Fixed rate', type: 'number', value: 4, step: 0.01, bigStep: 0.25 },
          { id: 'flat', label: 'Flat curve', type: 'boolean', value: false },
        ],
        onSubmit: () => undefined,
      },
    };
    const rec = newRecorder();
    renderSpec(synthetic, undefined, rec);
    const rate = screen.getByLabelText('Fixed rate');
    rate.focus();
    await user.keyboard('{PageUp}');
    expect(rate).toHaveValue(4.25);
    await user.keyboard('{PageDown}{PageDown}');
    expect(rate).toHaveValue(3.75);

    const flat = screen.getByLabelText('Flat curve');
    flat.focus();
    expect(flat).not.toBeChecked();
    await user.keyboard(' ');
    expect(flat).toBeChecked();
  });

  it('text: a text node is focusable, so a screen made of prose is not a keyboard dead end', () => {
    const c = casesWith('text')[0];
    expect(c).toBeDefined();
    if (c === undefined) return;
    const text = firstOfKind(c.spec, 'text');
    if (text === undefined) return;
    const container = renderCase(c);
    const node = container.querySelector<HTMLElement>(`[data-node-id="${text.id}"]`);
    expect(node).not.toBeNull();
    expect(node?.tabIndex).toBe(0);
    node?.focus();
    expect(document.activeElement).toBe(node);
  });

  it('custom: the placeholder takes focus and names the component it is waiting for', () => {
    const c = casesWith('custom')[0];
    expect(c).toBeDefined();
    if (c === undefined) return;
    const custom = firstOfKind(c.spec, 'custom');
    if (custom === undefined) return;
    const container = renderCase(c);
    const node = container.querySelector<HTMLElement>(`[data-node-id="${custom.id}"]`);
    expect(node?.tabIndex).toBe(0);
    expect(node?.dataset.pending).toBe(custom.component);
    expect(node?.textContent).toContain(custom.component);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. Grid and Chart delegate; the placeholder is honest about what it is waiting for
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('grid and chart are delegated, never faked', () => {
  it('the grid placeholder says which component it waits for and draws no rows', () => {
    const c = CASES.find((k) => {
      const g = firstOfKind(k.spec, 'grid');
      return g !== undefined && g.rows.length > 0;
    });
    expect(c).toBeDefined();
    if (c === undefined) return;
    const grid = firstOfKind(c.spec, 'grid');
    if (grid === undefined) return;

    const container = renderCase(c);
    const node = container.querySelector<HTMLElement>(`[data-node-id="${grid.id}"]`);
    expect(node?.dataset.pending).toBe('LiveGrid');
    expect(node?.tabIndex).toBe(0);
    expect(node?.textContent).toContain('waiting for LiveGrid');
    expect(node?.textContent).toContain(`${String(grid.rows.length)} rows`);
    // Nothing that could be read as data: no row, no cell, no value from the payload.
    expect(node?.querySelectorAll('[role="row"]')).toHaveLength(0);
    expect(node?.querySelectorAll('.cell')).toHaveLength(0);
  });

  it('the grid placeholder cites provenance, so Ctrl+I answers about the payload', async () => {
    // The grid holds most of the numbers on most screens, and every `GridRow` cell already carries
    // a `provIdx` the placeholder reads. Without `data-prov-idx` the one focusable thing on those
    // screens answered "the focused element cites no provenance" — a fact about the placeholder,
    // not about the payload, when the payload had the answer all along (DATA-10).
    const c = CASES.find((k) => {
      const g = firstOfKind(k.spec, 'grid');
      if (g === undefined) return false;
      return g.rows.some((row) => Object.values(row.cells).some((cell) => cell.provIdx >= 0));
    });
    expect(c).toBeDefined();
    if (c === undefined) return;
    const grid = firstOfKind(c.spec, 'grid');
    if (grid === undefined) return;
    const expected = grid.rows
      .flatMap((row) => grid.columns.map((col) => row.cells[col.id]))
      .find((cell) => cell !== undefined && cell.provIdx >= 0)?.provIdx;
    expect(expected).toBeDefined();

    const user = setup();
    const container = renderCase(c);
    const node = container.querySelector<HTMLElement>(`[data-node-id="${grid.id}"]`);
    expect(node?.dataset.provIdx).toBe(String(expected));

    node?.focus();
    await user.keyboard('{Control>}i{/Control}');
    const dialog = screen.getByRole('dialog', { name: 'Provenance' });
    expect(dialog).toHaveTextContent(`source.${String(expected ?? -1)}`);
    expect(dialog).not.toHaveTextContent(/cites no provenance/);
  });

  it('a grid with nothing to cite says so rather than claiming a pending capture', async () => {
    const user = setup();
    const container = renderSpec(
      {
        title: 'Empty grid',
        body: { kind: 'grid', id: 'g', columns: [{ id: 'a', label: 'A' }], rows: [] },
      },
      metaFor({}),
      newRecorder(),
    );
    const node = container.querySelector<HTMLElement>('[data-node-id="g"]');
    expect(node?.dataset.provIdx).toBe('-2');
    node?.focus();
    await user.keyboard('{Control>}i{/Control}');
    expect(screen.getByRole('dialog', { name: 'Provenance' })).toHaveTextContent(
      /cites no provenance/,
    );
  });

  it('LiveGrid receives the node through the props contract, and the renderer navigates', () => {
    const c = CASES.find((k) => {
      const g = firstOfKind(k.spec, 'grid');
      return g !== undefined && g.rows.length > 0;
    });
    if (c === undefined) throw new Error('no grid case');
    const grid = firstOfKind(c.spec, 'grid');
    if (grid === undefined) throw new Error('no grid node');

    const seen: LiveGridProps[] = [];
    const LiveGrid = (props: LiveGridProps) => {
      seen.push(props);
      return <div role="grid" aria-label={props.id} tabIndex={0} />;
    };
    renderCase(c, { widgets: { LiveGrid } });

    const props = seen[0];
    expect(props).toBeDefined();
    if (props === undefined) return;
    expect(props.id).toBe(grid.id);
    expect(props.columns).toBe(grid.columns);
    expect(props.rows).toBe(grid.rows);
    expect(props.currency).toBe('USD');
    expect(props.priceDecimals).toBe(2);
    // `exactOptionalPropertyTypes`: what the screen did not say is absent, never null.
    if (grid.sort === undefined) expect('sort' in props).toBe(false);
    if (grid.groupBy === undefined) expect('groupBy' in props).toBe(false);

    const row = grid.rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    const expected = grid.onEnter?.(row) ?? row.command ?? null;
    const before = c.rec.navigate.length;
    const returned = props.onEnter?.(row) ?? null;
    expect(returned).toBe(expected);
    expect(c.rec.navigate.length).toBe(before + (expected === null ? 0 : 1));
    if (expected !== null) expect(c.rec.navigate.at(-1)).toBe(expected);
  });

  it('the chart placeholder states the spec it is waiting to draw, and plots nothing', () => {
    // No shipped screen emits `kind: 'chart'` — they route charts through `custom` so WP-14 owns
    // the canvas. The node below carries GP's own `ChartSpec`, built by the shipped screen.
    const gp = golden<'GP'>('GP.equity.json');
    const params = manifests.GP.params.parse(GP_PARAMS);
    const chartSpec: ChartSpec = gpChartSpec(gp, params);
    const spec: ScreenSpec = {
      title: 'GP · chart node',
      body: { kind: 'chart', id: 'price', spec: chartSpec },
      initialFocus: 'price',
    };
    const rec = newRecorder();
    const container = renderSpec(spec, metaFor(gp), rec);
    const node = container.querySelector<HTMLElement>('[data-node-id="price"]');
    expect(node?.dataset.pending).toBe('ChartCanvas');
    expect(node?.tabIndex).toBe(0);
    expect(node?.textContent).toContain('waiting for ChartCanvas');
    expect(node?.textContent).toContain(`${String(chartSpec.series.length)} series`);
    expect(node?.querySelector('canvas')).toBeNull();
    expect(node?.querySelector('svg')).toBeNull();
  });

  it('a chart with no series says it cites nothing, not that a value is pending', async () => {
    // `-1` means "computed or still waiting for its first capture", and the panel says exactly
    // that. It is a claim about attribution, and a chart with no series has no values to attribute.
    const empty: ChartSpec = {
      ...gpChartSpec(golden<'GP'>('GP.equity.json'), manifests.GP.params.parse(GP_PARAMS)),
      series: [],
    };
    const user = setup();
    const container = renderSpec(
      { title: 'Empty chart', body: { kind: 'chart', id: 'c', spec: empty } },
      metaFor({}),
      newRecorder(),
    );
    const node = container.querySelector<HTMLElement>('[data-node-id="c"]');
    expect(node?.dataset.provIdx).toBe('-2');
    node?.focus();
    await user.keyboard('{Control>}i{/Control}');
    const dialog = screen.getByRole('dialog', { name: 'Provenance' });
    expect(dialog).toHaveTextContent(/cites no provenance/);
    expect(dialog).not.toHaveTextContent(/Pending/);
  });

  it('a chart drawn from two sources names both, and claims neither for the whole canvas', () => {
    const base = gpChartSpec(golden<'GP'>('GP.equity.json'), manifests.GP.params.parse(GP_PARAMS));
    const first = base.series[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const twoSources: ChartSpec = {
      ...base,
      series: [
        { ...first, provIdx: 0 },
        { ...first, label: 'Second', provIdx: 1 },
      ],
    };
    const container = renderSpec(
      { title: 'Two sources', body: { kind: 'chart', id: 'c', spec: twoSources } },
      metaFor({ provIdx: 1 }),
      newRecorder(),
    );
    const node = container.querySelector<HTMLElement>('[data-node-id="c"]');
    // Naming series 0 for everything drawn would be a false attribution, not a missing one.
    expect(node?.dataset.provIdx).toBe('-2');
    // Nothing is hidden: the placeholder names each series' source until WP-14 can do it per point.
    expect(node?.textContent).toContain('source 0');
    expect(node?.textContent).toContain('source 1');
  });

  it('a chart whose series all share one source cites it', () => {
    const base = gpChartSpec(golden<'GP'>('GP.equity.json'), manifests.GP.params.parse(GP_PARAMS));
    const first = base.series[0];
    if (first === undefined) return;
    const oneSource: ChartSpec = {
      ...base,
      series: [
        { ...first, provIdx: 3 },
        { ...first, label: 'Second', provIdx: 3 },
      ],
    };
    const container = renderSpec(
      { title: 'One source', body: { kind: 'chart', id: 'c', spec: oneSource } },
      metaFor({ provIdx: 3 }),
      newRecorder(),
    );
    expect(container.querySelector<HTMLElement>('[data-node-id="c"]')?.dataset.provIdx).toBe('3');
  });

  it('ChartCanvas receives the spec through the props contract', () => {
    const gp = golden<'GP'>('GP.equity.json');
    const params = manifests.GP.params.parse(GP_PARAMS);
    const chartSpec: ChartSpec = gpChartSpec(gp, params);
    const seen: ChartCanvasProps[] = [];
    const ChartCanvas = (props: ChartCanvasProps) => {
      seen.push(props);
      return <div role="img" aria-label={props.id} />;
    };
    const spec: ScreenSpec = {
      title: 'GP · chart node',
      body: { kind: 'chart', id: 'price', spec: chartSpec },
    };
    renderSpec(spec, metaFor(gp), newRecorder(), { widgets: { ChartCanvas } });
    expect(seen[0]?.id).toBe('price');
    expect(seen[0]?.spec).toBe(chartSpec);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. Every Cell state renders distinctly (TERM-12, ENTL-05)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('a Cell renders its ValueState distinctly', () => {
  /** The same number, five times, in the five states — the comparison no golden can provide. */
  const states: Cell[] = [
    { v: 231.45, st: 'live', provIdx: 0, fmt: 'px', decimals: 2 },
    { v: 231.45, st: 'stale', provIdx: 0, fmt: 'px', decimals: 2, ts: 1_757_961_986_000 },
    { v: 231.45, st: 'closed', provIdx: 0, fmt: 'px', decimals: 2 },
    { v: null, st: 'blank', provIdx: 0, fmt: 'px', decimals: 2, r: 'NO_FIRM_ENTITLEMENT' },
    { v: null, st: 'na', provIdx: 0, fmt: 'px', decimals: 2 },
  ];

  const spec: ScreenSpec = {
    title: 'Five states',
    body: {
      kind: 'kv',
      id: 'states',
      rows: states.map((cell) => ({ label: cell.st, value: cell })),
    },
  };

  function renderStates(): HTMLElement[] {
    const container = renderSpec(spec, metaFor({ provIdx: 0 }), newRecorder());
    return [...container.querySelectorAll<HTMLElement>('.cell')];
  }

  it('the five states differ from each other, not merely render', () => {
    const cells = renderStates();
    expect(cells).toHaveLength(5);

    const byState = new Set(cells.map((el) => el.dataset.st));
    const byTitle = new Set(cells.map((el) => el.getAttribute('title')));

    expect(byState).toEqual(new Set(['live', 'stale', 'closed', 'blank', 'na']));
    expect(byTitle.size).toBe(5);
  });

  it('the five states are five VISIBLY different renderings, not five shades of one', () => {
    // The assertion this replaces read `el.textContent`, which includes the clipped `.sr-only`
    // state phrase and so returned five distinct strings no matter what reached the screen. It
    // could not fail. What a user sees is the `.cell__value` subtree plus whatever `::after` glyph
    // the state's rule appends, and by that measure `live` and `closed` were byte-identical
    // `231.45`, separated only by #f2f2f2 against #cfcfcf — 1.39:1, under the 3:1 floor.
    const cells = renderStates();
    const glyphs = stateGlyphs();

    const rendering = (el: HTMLElement): string => {
      const st = el.dataset.st ?? '';
      return `${visibleText(el.querySelector('.cell__value'))}${glyphs.get(st) ?? ''}`;
    };

    const seen = new Map<string, string>();
    for (const el of cells) {
      const key = rendering(el);
      const clash = seen.get(key);
      expect(
        clash,
        `state '${el.dataset.st ?? ''}' and state '${clash ?? ''}' both render as ${JSON.stringify(key)} — a user cannot tell them apart without colour`,
      ).toBeUndefined();
      seen.set(key, el.dataset.st ?? '');
    }
    expect(seen.size).toBe(5);

    // Named explicitly, so removing either rule fails here rather than quietly collapsing a pair.
    expect(glyphs.get('stale')).toBeDefined();
    expect(glyphs.get('closed')).toBeDefined();
    expect(glyphs.get('closed')).not.toBe(glyphs.get('stale'));
    expect(glyphs.get('live')).toBeUndefined();
  });

  it('na is the state, not the value: a payload that left a number beside it still prints ·', () => {
    // `blank` already worked this way. `na` did not: `cellText` only returned the glyph when `v`
    // was also null, so `st: 'na'` with a number fell through to the formatter and printed an
    // ordinary `123.45` whose only mark was the muted colour — the live/closed collapse again, in
    // a state that asserts the field does not apply to this instrument at all.
    const container = renderSpec(
      {
        title: 'Not applicable',
        body: {
          kind: 'kv',
          id: 'na',
          rows: [{ label: 'Coupon', value: { v: 123.45, st: 'na', provIdx: 0, fmt: 'px' } }],
        },
      },
      metaFor({ provIdx: 0 }),
      newRecorder(),
    );
    const cell = container.querySelector<HTMLElement>('.cell');
    expect(cell?.dataset.st).toBe('na');
    expect(visibleText(cell)).toBe('·');
    expect(visibleText(cell)).not.toContain('123');
  });

  it('a denied cell shows an em dash and its reason — never a number, never a blank space', () => {
    const cells = renderStates();
    const blank = cells.find((el) => el.dataset.st === 'blank');
    expect(blank).toBeDefined();
    expect(blank?.textContent).toContain('—');
    expect(blank?.textContent).toContain('NO_FIRM_ENTITLEMENT');
    expect(blank?.textContent).not.toContain('231');
    expect(blank?.textContent?.trim()).not.toBe('');
  });

  it('a blank cell hides the number even when the payload still carries one (ENTL-05)', () => {
    // The denial is the server's; the screen renders exactly the reason it was sent. A payload that
    // left a last-known value beside `st: 'blank'` must not leak it — that is the number the
    // entitlement decision withheld.
    const leaky: Cell = { v: 231.45, st: 'blank', provIdx: 0, fmt: 'px', r: 'TIER_EOD' };
    const container = renderSpec(
      {
        title: 'Denied',
        body: { kind: 'kv', id: 'denied', rows: [{ label: 'Bid', value: leaky }] },
      },
      metaFor({ provIdx: 0 }),
      newRecorder(),
    );
    const cell = container.querySelector<HTMLElement>('.cell');
    expect(cell?.dataset.st).toBe('blank');
    expect(cell?.textContent).toContain('—');
    expect(cell?.textContent).toContain('TIER_EOD');
    expect(cell?.textContent).not.toContain('231');
  });

  it('a denied field on a REAL screen shows the reason the meta gave, not a bare em dash', () => {
    // The hand-built cell above proves the capability. This proves the product path, which is a
    // different thing and was the one that was broken: almost no payload sets `Cell.r`. The server
    // records a denial once per field in `meta.entitlement[]`, and the renderer is where that meta
    // is, so the renderer is where the per-cell lookup has to happen. Before it existed, all 73
    // blank cells across the goldens rendered as `—` and nothing else, which makes a price withheld
    // by entitlement and a price the source does not have the same mark (ENTL-05).
    const c = caseNamed('DES.equity');
    const denied = mountedCells(c.spec).find(
      (cell) => cell.st === 'blank' && cell.fieldId !== undefined,
    );
    expect(denied?.fieldId).toBeDefined();
    const fieldId = denied?.fieldId ?? '';

    const meta: PayloadMeta = {
      ...c.meta,
      entitlement: [
        { fieldId, decision: 'deny', effectiveTier: null, reason: 'NO_FIRM_ENTITLEMENT' },
      ],
    };
    const container = renderSpec(c.spec, meta, newRecorder());

    const blanks = [...container.querySelectorAll<HTMLElement>('.cell[data-st="blank"]')];
    expect(blanks.length).toBeGreaterThan(0);
    const withReason = blanks.filter((el) => visibleText(el).includes('NO_FIRM_ENTITLEMENT'));
    expect(withReason.length).toBeGreaterThan(0);
    // Visible, not merely in the DOM: the reason must survive stripping every `.sr-only` span.
    expect(visibleText(withReason[0])).toContain('—');
    expect(withReason[0]?.getAttribute('title')).toContain('NO_FIRM_ENTITLEMENT');
  });

  it.each(
    CASES.filter((c) =>
      mountedCells(c.spec).some((cell) => cell.st === 'blank' && cell.fieldId !== undefined),
    ).map((c) => [c.name, c] as const),
  )('%s: no blank cell is a bare em dash when the payload says why', (_name, c) => {
    // Every field that is blank on this screen, reported the way a real payload reports it — once
    // per field in `meta.unavailable[]` — and then every one of those cells must say so on screen.
    const blanks = mountedCells(c.spec).filter((cell) => cell.st === 'blank');
    const fields = [
      ...new Set(blanks.flatMap((cell) => (cell.fieldId === undefined ? [] : [cell.fieldId]))),
    ];
    expect(fields.length).toBeGreaterThan(0);

    const meta: PayloadMeta = {
      ...c.meta,
      entitlement: [],
      unavailable: fields.map((field) => ({
        field,
        reason: 'NO_SOURCE' as const,
        detail: 'no capture for this field',
      })),
    };
    const container = renderSpec(c.spec, meta, newRecorder());

    const explicable = blanks.filter((cell) => cell.fieldId !== undefined || cell.r !== undefined);
    const rendered = [...container.querySelectorAll<HTMLElement>('.cell[data-st="blank"]')];
    const explained = rendered.filter(
      (el) => visibleText(el.querySelector('.cell__reason')) !== '',
    );
    expect(explained).toHaveLength(explicable.length);
    for (const el of explained) expect(visibleText(el)).toContain('—');
  });

  it('a row shorter than its header renders a real blank cell, not an empty box', async () => {
    // An empty `<span>` in a numeric column says nothing: it is indistinguishable from a value that
    // is genuinely blank, and it was `aria-hidden` and outside the roving index, so a screen reader
    // never heard it and Tab and Ctrl+I could never reach it. No golden produces a ragged row
    // today, which makes this the one short row away from a silently empty numeric cell.
    const user = setup();
    const container = renderSpec(
      {
        title: 'Ragged',
        body: {
          kind: 'table',
          id: 'r',
          columns: [
            { id: 'a', label: 'Bid' },
            { id: 'b', label: 'Ask' },
            { id: 'c', label: 'Last' },
          ],
          rows: [[{ v: 1.5, st: 'live', provIdx: 0, fmt: 'px' }]],
        },
      },
      metaFor({ provIdx: 0 }),
      newRecorder(),
    );

    const cells = [...container.querySelectorAll<HTMLElement>('[role="cell"]')];
    expect(cells).toHaveLength(3);
    for (const cell of cells) expect(cell.getAttribute('aria-hidden')).toBeNull();

    const missing = cells.slice(1);
    for (const cell of missing) {
      expect(cell.querySelector('.cell')?.getAttribute('data-st')).toBe('blank');
      expect(visibleText(cell)).toContain('—');
    }
    // Reachable, and part of the node's one tab stop like every other cell.
    cells[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(cells[1]);
    await user.keyboard('{Control>}i{/Control}');
    expect(screen.getByRole('dialog', { name: 'Provenance' })).toHaveTextContent(/Pending/);
  });

  it('a stale cell keeps its last value and says it is stale; a live one does not', () => {
    const cells = renderStates();
    const live = cells.find((el) => el.dataset.st === 'live');
    const stale = cells.find((el) => el.dataset.st === 'stale');
    expect(live?.textContent).toContain('231.45');
    expect(stale?.textContent).toContain('231.45');
    expect(stale?.textContent).toContain('stale');
    expect(live?.textContent).not.toContain('stale');
    expect(live?.textContent).toContain('live');
    // The `·` glyph is `tokens.css`'s `[data-st='stale']::after`; the DOM must not double it.
    expect(stale?.textContent).not.toContain('·');
  });

  it('an unavailable cell renders an em dash, and na is not the same as blank', () => {
    const cells = renderStates();
    const blank = cells.find((el) => el.dataset.st === 'blank');
    const na = cells.find((el) => el.dataset.st === 'na');
    expect(na?.textContent).toContain('·');
    expect(na?.textContent).toContain('not applicable');
    expect(na?.textContent).not.toBe(blank?.textContent);
  });

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s renders every payload cell in the state the payload gave it',
    (_name, c) => {
      const container = renderCase(c);
      const specStates = new Map<string, number>();
      for (const node of mountedNodes(c.spec.body)) {
        const add = (cell: Cell): void => {
          specStates.set(cell.st, (specStates.get(cell.st) ?? 0) + 1);
        };
        if (node.kind === 'kv') for (const row of node.rows) add(row.value);
        else if (node.kind === 'table')
          for (const row of node.rows) for (const cell of row) add(cell);
      }
      const domStates = new Map<string, number>();
      for (const el of container.querySelectorAll<HTMLElement>('.cell')) {
        const st = el.dataset.st ?? '';
        domStates.set(st, (domStates.get(st) ?? 0) + 1);
      }
      expect(Object.fromEntries(domStates)).toEqual(Object.fromEntries(specStates));
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. Ctrl+I opens the provenance panel for the focused cell (DATA-10)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('Ctrl+I opens the provenance panel', () => {
  /** The first element of a rendered screen that cites a provenance index matching `want`. */
  function citing(container: HTMLElement, want: (idx: number) => boolean): HTMLElement {
    const found = [...container.querySelectorAll<HTMLElement>('[data-prov-idx]')].find((el) =>
      want(Number.parseInt(el.dataset.provIdx ?? '', 10)),
    );
    if (found === undefined) throw new Error('no element cites a matching provenance index');
    return found;
  }

  it('shows the entry the focused cell cites, from a real screen and a real payload', async () => {
    const c = caseNamed('DES.equity');
    const user = setup();
    const container = renderCase(c);

    const target = citing(container, (idx) => idx >= 0);
    const idx = Number.parseInt(target.dataset.provIdx ?? '', 10);
    const entry = c.meta.provenance[idx];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    target.focus();
    await user.keyboard('{Control>}i{/Control}');

    const dialog = screen.getByRole('dialog', { name: 'Provenance' });
    expect(within(dialog).getByText(entry.sourceId)).toBeInTheDocument();
    expect(within(dialog).getByText(entry.attribution)).toBeInTheDocument();
    expect(within(dialog).getByText(entry.capturedAt)).toBeInTheDocument();
    expect(within(dialog).getByText(String(entry.provenanceId))).toBeInTheDocument();
    // The shell is told too, so the panel and the usage event agree on the index.
    expect(c.rec.provenance.at(-1)).toBe(idx);
  });

  it('shows a different entry for a cell that cites a different index', async () => {
    const c = caseNamed('DES.equity');
    const user = setup();
    const container = renderCase(c);

    const indices = [...container.querySelectorAll<HTMLElement>('[data-prov-idx]')]
      .map((el) => Number.parseInt(el.dataset.provIdx ?? '', 10))
      .filter((n) => n >= 0);
    const distinct = [...new Set(indices)];
    expect(distinct.length).toBeGreaterThan(1);

    const [a, b] = distinct;
    if (a === undefined || b === undefined) return;

    citing(container, (idx) => idx === a).focus();
    await user.keyboard('{Control>}i{/Control}');
    expect(screen.getByRole('dialog')).toHaveTextContent(`source.${String(a)}`);
    await user.keyboard('{Escape}');

    citing(container, (idx) => idx === b).focus();
    await user.keyboard('{Control>}i{/Control}');
    expect(screen.getByRole('dialog')).toHaveTextContent(`source.${String(b)}`);
    expect(screen.getByRole('dialog')).not.toHaveTextContent(`source.${String(a)}`);
  });

  it('a cell whose provIdx is -1 is pending and says so, rather than showing nothing', async () => {
    // BTMM's screen carries computed cells the payload attributes to no capture.
    const c = caseNamed('BTMM.default');
    const user = setup();
    const container = renderCase(c);
    const pending = citing(container, (idx) => idx === -1);

    pending.focus();
    await user.keyboard('{Control>}i{/Control}');
    const dialog = screen.getByRole('dialog', { name: 'Provenance' });
    expect(dialog).toHaveTextContent(/Pending/);
    expect(dialog.querySelector('dl')).toBeNull();
  });

  it('Escape closes the panel and gives focus back to the cell', async () => {
    const c = caseNamed('DES.equity');
    const user = setup();
    const container = renderCase(c);
    const target = citing(container, (idx) => idx >= 0);

    target.focus();
    await user.keyboard('{Control>}i{/Control}');
    expect(screen.getByRole('dialog', { name: 'Provenance' })).toBeInTheDocument();
    expect(document.activeElement).not.toBe(target);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Provenance' })).toBeNull();
    expect(document.activeElement).toBe(target);
  });

  it('Ctrl+I on something that cites no provenance says so instead of opening an empty panel', async () => {
    const c = caseNamed('TOP.default');
    const user = setup();
    const container = renderCase(c);
    const text = container.querySelector<HTMLElement>('.text');
    expect(text).not.toBeNull();
    text?.focus();
    await user.keyboard('{Control>}i{/Control}');
    expect(screen.getByRole('dialog', { name: 'Provenance' })).toHaveTextContent(
      /cites no provenance/,
    );
  });

  it('the key is matched by code through keymap.ts, not by the character it produced', () => {
    // Every other keyboard path in the package matches `KeyboardEvent.code` precisely so a layout
    // or a macOS dead key cannot change what a key means. A second, hand-rolled `e.key === 'i'`
    // here was a second answer to "was that the provenance key", and two answers to one reserved
    // key eventually disagree about which cell is focused.
    const c = caseNamed('DES.equity');
    const container = renderCase(c);
    const target = citing(container, (idx) => idx >= 0);

    // A Turkish keyboard: the physical `I` key reports `key: 'ı'`, dotless. Still Ctrl+I.
    target.focus();
    fireEvent.keyDown(target, { key: 'ı', code: 'KeyI', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Provenance' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Provenance' })).toBeNull();

    // And a different physical key that happens to produce an `i` is not the provenance key.
    target.focus();
    fireEvent.keyDown(target, { key: 'i', code: 'KeyJ', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: 'Provenance' })).toBeNull();
  });

  it('the handle exposes focusNode and openProvenance for the shell (ScreenCtx.focus/provenance)', () => {
    const c = caseNamed('DES.equity');
    const handle: { current: ScreenHandle | null } = { current: null };
    renderCase(c, { handle });
    expect(handle.current).not.toBeNull();

    const ids = mountedIds(c.spec);
    const target = ids[ids.length - 1] ?? '';
    expect(handle.current?.focusNode(target)).toBe(true);
    expect(focusedNodeId()).toBe(target);
    expect(handle.current?.focusNode('no-such-node')).toBe(false);

    act(() => {
      handle.current?.openProvenance(0);
    });
    expect(screen.getByRole('dialog', { name: 'Provenance' })).toHaveTextContent('source.0');
  });
});
