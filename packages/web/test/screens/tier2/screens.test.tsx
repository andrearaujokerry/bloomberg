/**
 * packages/web/test/screens/tier2/screens.test.tsx — WP-10 acceptance row, adapted.
 *
 * WORKPLAN's row reads "every Tier 2 `Screen.tsx` renders its payload fixture". Half of that cannot
 * be executed yet and this file does not pretend otherwise:
 *
 *   * **Rendering** is asserted as the `ScreenSpec` each screen returns, not as DOM. A screen is a
 *     pure function from props to a spec; `ScreenRenderer.tsx` and the widget set are WP-12's and do
 *     not exist. Asserting the spec is asserting everything the screen decides.
 *   * **The DOM half is deferred to WP-12.** What is checkable now — and is checked here — is that
 *     every keymap entry names a focus region the spec actually contains, so no binding is addressed
 *     at a node that was never drawn.
 *
 * The payload fixtures are `fixtures/golden/functions/<CODE>.<variant>.json`, the committed goldens
 * the resolver integration tests assert against at the frozen clock `2026-09-15T18:41:28Z`. Using
 * them means a screen is exercised against the exact payload the server produces, not against a
 * shape a screen test invented.
 *
 * The provenance rules this file enforces (FUNCTIONS.md §1.5, DATA-10):
 *   1. every `Cell` whose value is a number carries an integer `provIdx`;
 *   2. `provIdx >= 0` must index an entry of `meta.provenance`;
 *   3. a `fieldId` on any cell is a real entry of the field dictionary;
 *   4. a cited numeric cell names the `fieldId` it is a value of, UNLESS it is a documented derived
 *      cell — a number whose definition is an arithmetic or a concept map rather than a dictionary
 *      field (`DERIVED_NODES` / `DERIVED_CELLS` below, plus the payload's own fieldId-less
 *      `MonitorColumn`s on EQS and RV). This is the Tier 2 generalisation of Tier 1's `c<n>`
 *      formula-column exemption, and the list is explicit so it stays reviewable.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getField, manifests } from '@terminal/core';
import type { FunctionCode, MonitorColumn, ParamsOf, PayloadOf } from '@terminal/core';
import type { InstrumentSummary, PayloadMeta } from '@terminal/sdk';
import { describe, expect, it } from 'vitest';

import type {
  Cell,
  LiveView,
  Node,
  ScreenCtx,
  ScreenProps,
  ScreenSpec,
} from '../../../src/screen/types.js';
import { screenModules } from '../../../src/screens/index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The fourteen Tier 2 codes
// ─────────────────────────────────────────────────────────────────────────────────────────────

const TIER2_CODES = Object.entries(manifests)
  .filter(([, m]) => m.tier === 2)
  .map(([code]) => code as FunctionCode)
  .sort();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures
//
// The three helpers below (`maxProvIdx`, `metaFor`, `recordingCtx`) are deliberate duplicates of
// `test/screens/tier1/screens.test.tsx`: importing them would import that file's `describe` blocks
// and run the Tier 1 suite a second time.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(dirname(dirname(TEST_DIR)))));
const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'golden', 'functions');

function golden<C extends FunctionCode>(name: string): PayloadOf<C> {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')) as PayloadOf<C>;
}

/** The deepest `provIdx` a payload cites; `meta.provenance` must be at least that long + 1. */
function maxProvIdx(value: unknown): number {
  let max = -1;
  const note = (n: unknown): void => {
    if (typeof n === 'number' && n > max) max = n;
  };
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    for (const [key, val] of Object.entries(v)) {
      if (key === 'provIdx' || key === 'legProvIdx') {
        if (Array.isArray(val)) for (const n of val) note(n);
        else note(val);
        continue;
      }
      walk(val);
    }
  };
  walk(value);
  return max;
}

/**
 * A `PayloadMeta` consistent with the payload: one provenance entry per index the payload cites,
 * plus one entitlement denial and one unavailable note, because both have to render on every screen
 * that carries them and a meta with neither would leave those paths untested.
 */
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

interface Recorder {
  setParams: Record<string, unknown>[];
  navigate: string[];
  provenance: number[];
  focus: string[];
}

function recordingCtx<P>(rec: Recorder): ScreenCtx<P> {
  return {
    panelId: 'p1',
    setParams: (patch) => rec.setParams.push(patch),
    navigate: (command) => rec.navigate.push(command),
    navigateNext: (command) => rec.navigate.push(`NEXT ${command}`),
    export: () => undefined,
    page: () => undefined,
    focus: (nodeId) => rec.focus.push(nodeId),
    prompt: () => Promise.resolve(null),
    provenance: (idx) => rec.provenance.push(idx),
    openUrl: () => undefined,
  };
}

const LIVE: LiveView = {
  get: (subject, field) => ({ v: null, st: 'blank', provIdx: -1, live: { subject, field } }),
  state: () => 'blank',
};

function propsFor<C extends FunctionCode>(
  code: C,
  payload: PayloadOf<C> | undefined,
  overrides: Record<string, unknown> = {},
  rec: Recorder = { setParams: [], navigate: [], provenance: [], focus: [] },
): ScreenProps<ParamsOf<C>, PayloadOf<C>> {
  const params = manifests[code].params.parse(overrides) as ParamsOf<C>;
  return {
    payload,
    params,
    instrument: INSTRUMENT,
    meta: payload === undefined ? undefined : metaFor(payload),
    live: LIVE,
    ctx: recordingCtx<ParamsOf<C>>(rec),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Spec walking
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

/** Every node of a spec, including the bodies inside tabs. */
function walkNodes(node: Node, out: Node[] = []): Node[] {
  out.push(node);
  if (node.kind === 'split') for (const child of node.children) walkNodes(child, out);
  if (node.kind === 'tabs') for (const tab of node.tabs) walkNodes(tab.body, out);
  return out;
}

/** Every addressable node id in a spec (a `split` is layout and has none). */
function nodeIds(node: Node): string[] {
  return walkNodes(node)
    .filter((n) => n.kind !== 'split')
    .map((n) => (n.kind === 'split' ? '' : n.id));
}

/** Every cell in a spec, tagged with the column (or row label) it sits under. */
function walkCells(node: Node): { cell: Cell; column: string; nodeId: string }[] {
  const out: { cell: Cell; column: string; nodeId: string }[] = [];
  for (const n of walkNodes(node)) {
    if (n.kind === 'kv') {
      for (const row of n.rows) out.push({ cell: row.value, column: row.label, nodeId: n.id });
    } else if (n.kind === 'grid') {
      for (const row of n.rows) {
        for (const [column, cell] of Object.entries(row.cells)) {
          out.push({ cell, column, nodeId: n.id });
        }
      }
    } else if (n.kind === 'table') {
      for (const row of n.rows) {
        row.forEach((cell, i) => {
          out.push({ cell, column: n.columns[i]?.id ?? String(i), nodeId: n.id });
        });
      }
    }
  }
  return out;
}

const VALUE_STATES = new Set(['live', 'stale', 'closed', 'blank', 'na']);

/**
 * Nodes every one of whose cited numbers is a derived value with no dictionary field.
 *
 * `statement` is FA's point-in-time grid: `FaRow.fieldId` is `null` for `GROSS_PROFIT`,
 * `TOTAL_EQUITY`, `FREE_CASH_FLOW` and `RETURN_COM_EQY`, which the tier document names but the
 * dictionary does not carry (`manifests/FA.ts` states this and drops them from `fieldIds`). Those
 * lines are defined by `xbrl_concept_map.standard_item`, and each cell cites the fiscal column's
 * own companyfacts capture.
 */
const DERIVED_NODES: ReadonlySet<string> = new Set(['statement']);

/**
 * `<nodeId>.<column>` pairs whose number is resolver arithmetic over a cited input rather than a
 * value of a dictionary field: basis-point changes, a curve level whose tenor has no `CRV_*` id,
 * a spread, and WB's country yield (whose source differs per row, so no single field names it).
 */
const DERIVED_CELLS: ReadonlySet<string> = new Set([
  'overnight.chgBp',
  'bills.chgBp',
  'curve.yield',
  'curve.compare',
  'curve.chgBp',
  'spreads.value',
  'spreads.chgBp',
  'rows.yield',
  'rows.chgBp',
  'us.2Y',
  'us.10Y',
  'us.30Y',
]);

/** Which node kinds can carry each keymap focus region (§1.5 "Shell contract for every screen"). */
const CHART_COMPONENTS = new Set(['PriceChart', 'CurveChart', 'OptionSurface', 'Sparkline']);
function hasRegion(body: Node, region: 'grid' | 'chart' | 'form'): boolean {
  return walkNodes(body).some((n) => {
    if (region === 'grid') return n.kind === 'grid' || n.kind === 'table' || n.kind === 'list';
    if (region === 'chart') {
      return n.kind === 'chart' || (n.kind === 'custom' && CHART_COMPONENTS.has(n.component));
    }
    return n.kind === 'form' || (n.kind === 'custom' && n.component === 'Composer');
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The cases, each against its committed golden
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Case {
  readonly name: string;
  readonly code: FunctionCode;
  readonly spec: ScreenSpec;
  readonly meta: PayloadMeta;
  /** Extra `<nodeId>.<column>` exemptions taken from this payload's own fieldId-less columns. */
  readonly derived: ReadonlySet<string>;
}

/** EQS and RV carry their columns in the payload; a factor with no dictionary field has no id. */
function fieldlessColumns(nodeId: string, columns: readonly MonitorColumn[]): Set<string> {
  const out = new Set<string>();
  for (const c of columns) if (c.fieldId === undefined) out.add(`${nodeId}.${c.id}`);
  return out;
}

function build(): Case[] {
  const cases: Case[] = [];
  const push = <C extends FunctionCode>(
    name: string,
    code: C,
    payload: PayloadOf<C>,
    overrides: Record<string, unknown> = {},
    derived: ReadonlySet<string> = new Set<string>(),
  ): void => {
    const props = propsFor(code, payload, overrides);
    const screen = screenModules[code].Screen as (
      p: ScreenProps<ParamsOf<C>, PayloadOf<C>>,
    ) => ScreenSpec;
    cases.push({ name, code, spec: screen(props), meta: metaFor(payload), derived });
  };

  push('FA.equity', 'FA', golden<'FA'>('FA.equity.json'));
  push('FA.equity(asReported)', 'FA', golden<'FA'>('FA.equity.json'), { asReported: true });
  push('FA.fund', 'FA', golden<'FA'>('FA.fund.json'));
  push('EE.equity', 'EE', golden<'EE'>('EE.equity.json'));

  const eqs = golden<'EQS'>('EQS.default.json');
  push('EQS.default', 'EQS', eqs, {}, fieldlessColumns('results', eqs.columns));

  const rv = golden<'RV'>('RV.equity.json');
  push('RV.equity', 'RV', rv, {}, fieldlessColumns('peers', rv.metrics));

  push('CN.issuer', 'CN', golden<'CN'>('CN.issuer.json'));
  push('CN.members', 'CN', golden<'CN'>('CN.members.json'));
  push('CACS.issuer', 'CACS', golden<'CACS'>('CACS.issuer.json'));
  push('CF.issuer', 'CF', golden<'CF'>('CF.issuer.json'));
  push('ECO.calendar', 'ECO', golden<'ECO'>('ECO.default.json'));
  push('ECO.release', 'ECO', golden<'ECO'>('ECO.default-release.json'));
  push('PORT.holdings', 'PORT', golden<'PORT'>('PORT.default.json'));
  push('PORT.attribution', 'PORT', golden<'PORT'>('PORT.default-attribution.json'), {
    view: 'attribution',
  });
  push('PORT.risk', 'PORT', golden<'PORT'>('PORT.default-risk.json'), { view: 'risk' });
  push('HDS.equity', 'HDS', golden<'HDS'>('HDS.equity.json'));
  // The insider layout of the same committed payload: only `view` changes, and it is the payload's
  // own discriminant, so nothing about the data is invented here.
  push(
    'HDS.equity(insiders)',
    'HDS',
    { ...golden<'HDS'>('HDS.equity.json'), view: 'INSIDERS' } as PayloadOf<'HDS'>,
    { view: 'INSIDERS' },
  );
  push('HDS.fund', 'HDS', golden<'HDS'>('HDS.fund.json'));
  push('MEMB.index', 'MEMB', golden<'MEMB'>('MEMB.index.json'), {
    groupBy: 'gics_sector',
    compareDate: '2026-03-31',
  });
  push('BTMM.default', 'BTMM', golden<'BTMM'>('BTMM.default.json'));
  push('BTMM.default(no percentiles)', 'BTMM', golden<'BTMM'>('BTMM.default.json'), {
    percentiles: false,
  });
  push('FXC.live', 'FXC', golden<'FXC'>('FXC.default.json'));
  push('FXC.ecb', 'FXC', golden<'FXC'>('FXC.ecb.json'), { quote: 'ecb' });
  push('WB.default', 'WB', golden<'WB'>('WB.default.json'));
  return cases;
}

const CASES = build();

describe('Tier 2 screens — every code produces a ScreenSpec from its committed golden', () => {
  it('uses a committed golden for every Tier 2 code', () => {
    const files = readdirSync(GOLDEN_DIR);
    for (const code of TIER2_CODES) {
      expect(
        files.some((f) => f.startsWith(`${code}.`)),
        `${code} has no committed golden`,
      ).toBe(true);
    }
  });

  it('covers all fourteen Tier 2 codes', () => {
    expect(TIER2_CODES).toHaveLength(14);
    expect(new Set(CASES.map((c) => c.code))).toEqual(new Set(TIER2_CODES));
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s returns a well-formed spec', (_name, c) => {
    expect(c.spec.title.length).toBeGreaterThan(0);
    const nodes = walkNodes(c.spec.body);
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(NODE_KINDS).toContain(node.kind);
      if (node.kind !== 'split') expect(node.id.length).toBeGreaterThan(0);
      if (node.kind === 'split') expect(node.sizes).toHaveLength(node.children.length);
    }
    // A node id is what `ctx.focus(nodeId)` addresses, so it has to be unique within a spec.
    const ids = nodeIds(c.spec.body);
    expect(new Set(ids).size, `duplicate node ids in ${c.name}: ${ids.join(', ')}`).toBe(ids.length);
  });

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s names an initialFocus node that exists',
    (_name, c) => {
      expect(c.spec.initialFocus).toBeDefined();
      expect(nodeIds(c.spec.body)).toContain(c.spec.initialFocus);
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s cites provenance for every number it shows',
    (_name, c) => {
      for (const { cell, column, nodeId } of walkCells(c.spec.body)) {
        const where = `${c.name} ${nodeId}.${column}`;
        expect(VALUE_STATES.has(cell.st), `${where}: bad state ${cell.st}`).toBe(true);
        // A blank cell shows nothing: it never carries a value the reader could read.
        if (cell.st === 'blank') expect(cell.v, `${where}: blank cell with a value`).toBeNull();
        if (cell.fieldId !== undefined) {
          expect(
            getField(cell.fieldId),
            `${where}: ${cell.fieldId} is not in the dictionary`,
          ).toBeDefined();
        }
        if (typeof cell.v !== 'number') continue;
        expect(typeof cell.provIdx, `${where}: numeric cell without provIdx`).toBe('number');
        expect(Number.isInteger(cell.provIdx), `${where}: non-integer provIdx`).toBe(true);
        if (cell.provIdx < 0) continue;
        expect(
          cell.provIdx,
          `${where}: provIdx ${String(cell.provIdx)} is outside meta.provenance`,
        ).toBeLessThan(c.meta.provenance.length);
        if (DERIVED_NODES.has(nodeId)) continue;
        if (DERIVED_CELLS.has(`${nodeId}.${column}`)) continue;
        if (c.derived.has(`${nodeId}.${column}`)) continue;
        expect(cell.fieldId, `${where}: cited number without a fieldId`).toBeDefined();
      }
    },
  );

  it('keeps the derived-cell exemption list honest', () => {
    // Every exemption has to name a node some Tier 2 screen actually draws, or the list is a
    // licence to drop `fieldId` from a cell nobody is looking at any more.
    const drawn = new Set(CASES.flatMap((c) => nodeIds(c.spec.body)));
    for (const node of DERIVED_NODES) {
      expect(drawn.has(node), `DERIVED_NODES names '${node}', which no screen draws`).toBe(true);
    }
    for (const pair of DERIVED_CELLS) {
      const nodeId = pair.slice(0, pair.indexOf('.'));
      expect(drawn.has(nodeId), `DERIVED_CELLS names '${pair}', whose node no screen draws`).toBe(
        true,
      );
    }
  });

  it('shows at least one cited numeric cell on every screen that has numbers', () => {
    const cited = CASES.filter((c) =>
      walkCells(c.spec.body).some((x) => typeof x.cell.v === 'number' && x.cell.provIdx >= 0),
    );
    expect(cited.length).toBeGreaterThanOrEqual(12);
  });

  it('never shows a number for a value the payload marked null', () => {
    for (const c of CASES) {
      for (const { cell, column, nodeId } of walkCells(c.spec.body)) {
        if (cell.st === 'na' || cell.st === 'blank') {
          expect(cell.v, `${c.name} ${nodeId}.${column}: ${cell.st} cell with a value`).toBeNull();
        }
        // A denied field arrives from the plant already null with `r` set; the screen may not
        // launder it into a plain blank (ENTL-05).
        if (cell.r !== undefined) {
          expect(cell.v, `${c.name} ${nodeId}.${column}: denied cell with a value`).toBeNull();
        }
      }
    }
  });
});

describe('Node kinds', () => {
  const used = new Set<NodeKind>();
  for (const c of CASES) for (const n of walkNodes(c.spec.body)) used.add(n.kind);

  it.each(['split', 'kv', 'grid', 'table', 'tabs', 'form', 'text', 'list', 'badges', 'custom'])(
    '%s is exercised by at least one Tier 2 screen',
    (kind) => {
      expect(used.has(kind as NodeKind)).toBe(true);
    },
  );

  it('uses no `chart` node: Tier 2 draws no price chart', () => {
    // EE and ECO use `custom` with `component:'Sparkline'` (§EE: "no `ChartSpec`; Sparkline takes
    // points directly"), and FXC's matrix is explicitly not a chart (§FXC). Nothing in Tier 2
    // builds a `ChartSpec`.
    expect(used.has('chart')).toBe(false);
  });
});

describe('Keymaps address regions the spec actually contains', () => {
  it.each(TIER2_CODES)('%s: every manifest binding names a region some variant renders', (code) => {
    const specs = CASES.filter((c) => c.code === code).map((c) => c.spec);
    expect(specs.length).toBeGreaterThan(0);
    for (const binding of manifests[code].keymap) {
      const when = binding.when ?? 'always';
      if (when === 'always') continue;
      expect(
        specs.some((s) => hasRegion(s.body, when)),
        `${code} binds ${binding.key} (${binding.action}) to a '${when}' region no variant renders`,
      ).toBe(true);
    }
  });

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s: every binding the screen itself adds names a region in that same spec',
    (_name, c) => {
      for (const binding of c.spec.keymap ?? []) {
        const when = binding.when ?? 'always';
        if (when === 'always') continue;
        expect(hasRegion(c.spec.body, when), `${c.name}: ${binding.key} → '${when}'`).toBe(true);
      }
    },
  );
});

describe('Skeletons', () => {
  it.each(TIER2_CODES)('%s returns a valid spec while the payload is in flight', (code) => {
    const screen = screenModules[code].Screen as (p: ScreenProps<never, never>) => ScreenSpec;
    const spec = screen(propsFor(code, undefined) as unknown as ScreenProps<never, never>);
    expect(spec.title.length).toBeGreaterThan(0);
    const ids = nodeIds(spec.body);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(spec.initialFocus);
    // A skeleton shows no numbers at all — it has none to show, and it never invents one.
    for (const { cell } of walkCells(spec.body)) expect(typeof cell.v).not.toBe('number');
  });
});

describe('Entitlement, unavailability and the null rule', () => {
  it.each(TIER2_CODES)('%s surfaces the entitlement denial and the unavailable note', (code) => {
    const c = CASES.find((x) => x.code === code);
    expect(c).toBeDefined();
    const badges = walkNodes(c!.spec.body).flatMap((n) => (n.kind === 'badges' ? n.items : []));
    const text = badges.map((b) => `${b.text} ${b.title ?? ''}`).join(' | ');
    expect(text, `${code} drops the ENTL-05 denial`).toContain('TIER_EOD');
    expect(text, `${code} drops the meta.unavailable note`).toContain('NO_SOURCE');
  });

  it('EE keeps its estimate columns, empty and explained (BRIEF §2)', () => {
    const ee = CASES.find((c) => c.code === 'EE');
    expect(ee).toBeDefined();
    const grid = walkNodes(ee!.spec.body).find((n) => n.kind === 'grid' && n.id === 'history');
    expect(grid).toBeDefined();
    const columns = (grid as Extract<Node, { kind: 'grid' }>).columns;
    const estimate = columns.find((col) => col.id === 'estimate');
    const surprise = columns.find((col) => col.id === 'surprise');
    // The column is never dropped and never blank-without-a-reason.
    expect(estimate?.label).toContain('NO_ESTIMATES_SOURCE');
    expect(surprise?.label).toContain('NO_ESTIMATES_SOURCE');
    // …and no estimate cell ever carries a number.
    for (const { cell, column } of walkCells(ee!.spec.body)) {
      if (column !== 'estimate' && column !== 'surprise') continue;
      expect(typeof cell.v).not.toBe('number');
    }
    const badges = walkNodes(ee!.spec.body).flatMap((n) => (n.kind === 'badges' ? n.items : []));
    expect(badges.map((b) => b.text).join(' | ')).toContain('NO_ESTIMATES_SOURCE');
  });

  it('ECO keeps its consensus column, empty and explained', () => {
    const eco = CASES.find((c) => c.name === 'ECO.calendar');
    expect(eco).toBeDefined();
    const grid = walkNodes(eco!.spec.body).find((n) => n.kind === 'grid' && n.id === 'events');
    const columns = (grid as Extract<Node, { kind: 'grid' }>).columns;
    expect(columns.find((col) => col.id === 'consensus')?.label).toContain('NO_CONSENSUS_SOURCE');
    for (const { cell, column } of walkCells(eco!.spec.body)) {
      if (column !== 'consensus') continue;
      expect(typeof cell.v).not.toBe('number');
    }
  });

  it('HDS says what it does not have on every equity run', () => {
    // §HDS: `13F_NOT_AVAILABLE` and `INSIDER_HOLDINGS_NOT_PARSED` are always present on the equity
    // variant, never hidden — a holders screen missing the institutional half is only honest if it
    // says so.
    for (const c of CASES.filter((x) => x.code === 'HDS' && x.name.startsWith('HDS.equity'))) {
      const text = walkNodes(c.spec.body)
        .flatMap((n) => (n.kind === 'badges' ? n.items : []))
        .map((b) => b.text)
        .join(' | ');
      expect(text).toContain('13F_NOT_AVAILABLE');
      expect(text).toContain('INSIDER_HOLDINGS_NOT_PARSED');
    }
  });

  it('PORT carries the PORT-07 firm-isolation chip on every view', () => {
    for (const c of CASES.filter((x) => x.code === 'PORT')) {
      const badges = walkNodes(c.spec.body).flatMap((n) => (n.kind === 'badges' ? n.items : []));
      const chip = badges.find((b) => b.text === 'PORT-07 FIRM ONLY');
      expect(chip, `${c.name} drops the PORT-07 chip`).toBeDefined();
      expect(chip?.tone).toBe('blocked');
    }
  });

  it('MEMB states that a proxy-fund weight is the fund’s, not the index provider’s', () => {
    const memb = CASES.find((c) => c.code === 'MEMB');
    expect(memb).toBeDefined();
    const notes = memb!.spec.footer?.notes ?? [];
    expect(notes.join(' ')).toContain("tracking fund's holdings");
    const badges = walkNodes(memb!.spec.body).flatMap((n) => (n.kind === 'badges' ? n.items : []));
    expect(badges.map((b) => b.text).join(' | ')).toContain('MEMBERSHIP_VIA_PROXY_FUND');
  });

  it('BTMM shows its three missing sources rather than omitting them', () => {
    const btmm = CASES.find((c) => c.name === 'BTMM.default');
    const text = walkNodes(btmm!.spec.body)
      .flatMap((n) => (n.kind === 'badges' ? n.items : []))
      .map((b) => b.text)
      .join(' | ');
    for (const reason of ['NO_IORB_SOURCE', 'NO_DISCOUNT_WINDOW_SOURCE', 'NO_FED_FUNDS_FUTURES']) {
      expect(text).toContain(reason);
    }
  });
});

describe('FXC matrix cells cite every leg they depend on', () => {
  // The matrix is a `custom` node, so `walkCells` cannot reach it; §FXC's rule is that a derived
  // cross cites the provenance of BOTH legs, not one, so it is asserted directly.
  interface MatrixCell {
    kind: string;
    value: Cell;
    via: string | null;
    derivation: string | null;
    legProvIdx: number[];
  }

  it.each(CASES.filter((c) => c.code === 'FXC').map((c) => [c.name, c] as const))(
    '%s',
    (_name, c) => {
      const node = walkNodes(c.spec.body).find((n) => n.kind === 'custom' && n.id === 'matrix');
      expect(node).toBeDefined();
      const props = (node as Extract<Node, { kind: 'custom' }>).props as { rows: MatrixCell[][] };
      expect(props.rows.length).toBeGreaterThan(0);
      let crosses = 0;
      for (const row of props.rows) {
        for (const cellOf of row) {
          if (typeof cellOf.value.v !== 'number') continue;
          expect(cellOf.legProvIdx.length, `${cellOf.kind} cell cites no leg`).toBeGreaterThan(0);
          for (const idx of cellOf.legProvIdx) {
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(c.meta.provenance.length);
          }
          if (cellOf.kind !== 'cross') continue;
          crosses += 1;
          expect(cellOf.via).toBe('USD');
          expect(cellOf.derivation).not.toBeNull();
          expect(cellOf.legProvIdx.length).toBeGreaterThanOrEqual(2);
        }
      }
      expect(crosses, 'the matrix shows no derived cross at all').toBeGreaterThan(0);
    },
  );
});

describe('Live grids can name the subject of each of their rows', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    for (const node of walkNodes(c.spec.body)) {
      if (node.kind !== 'grid' || node.live === undefined) continue;
      for (const row of node.rows) {
        expect(node.live.subjectOf(row)).toBe(row.subject ?? null);
      }
    }
  });
});

describe('Footers carry the attribution of every source the payload cited', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(c.spec.footer).toBeDefined();
    const sources = c.spec.footer?.sources ?? [];
    expect(new Set(sources).size).toBe(sources.length);
    for (const p of c.meta.provenance) expect(sources).toContain(p.attribution);
    expect(c.spec.footer?.asOf).toBe(c.meta.asOf.validAt);
  });
});

describe('Screens wire their own interactions back through ctx', () => {
  it('EQS submits the criteria form as a param change', () => {
    const rec: Recorder = { setParams: [], navigate: [], provenance: [], focus: [] };
    const props = propsFor('EQS', golden<'EQS'>('EQS.default.json'), {}, rec);
    const spec = screenModules.EQS.Screen(props);
    const form = walkNodes(spec.body).find((n) => n.kind === 'form');
    expect(form).toBeDefined();
    form!.onSubmit({
      universe: 'INDEX',
      index: 'NDX',
      sector: 'Information Technology',
      exchange: '',
      country: '',
      value1: 1_000,
    });
    expect(rec.setParams).toHaveLength(1);
    expect(rec.setParams[0]).toMatchObject({
      index: 'NDX',
      sector: 'Information Technology',
      exchange: null,
      country: null,
    });
  });
});
