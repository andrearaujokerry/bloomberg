/**
 * packages/web/test/screens/tier3/screens.test.tsx — WP-11's acceptance row, adapted.
 *
 * WORKPLAN's row reads "every Tier 3 `Screen.tsx` renders its payload fixture". Half of that cannot
 * be executed yet and this file does not pretend otherwise:
 *
 *   * **Rendering** is asserted as the `ScreenSpec` each screen returns, not as DOM. A screen is a
 *     pure function from props to a spec; `ScreenRenderer.tsx` and the widget set are WP-12's and do
 *     not exist. Asserting the spec is asserting everything the screen decides.
 *   * **The DOM half is deferred to WP-12.** What is checkable now — and is checked here — is that
 *     every keymap entry names a focus region the spec actually contains, so no binding is addressed
 *     at a node that was never drawn, and that every `custom` node (the curve plot, the smile, the
 *     greeks profile) carries a complete, provenance-cited `ChartSpec` for that renderer to draw.
 *
 * The payload fixtures are `fixtures/golden/functions/<CODE>.<variant>.json`, the committed goldens
 * the resolver integration tests assert against at the frozen clock `2026-09-15T18:41:28Z`. Using
 * them means a screen is exercised against the exact payload the server produces, not against a
 * shape a screen test invented. The goldens substitute identifiers by KEY (`"<AAPL>"`, `"<BUILD>"`),
 * so nothing here does arithmetic on an id.
 *
 * The provenance rules this file enforces (FUNCTIONS.md §1.5, DATA-10):
 *   1. every `Cell` whose value is a number carries an integer `provIdx`;
 *   2. `provIdx >= 0` must index an entry of `meta.provenance`;
 *   3. a `fieldId` on any cell is a real entry of the field dictionary;
 *   4. a cited numeric cell names the `fieldId` it is a value of, UNLESS it is a documented derived
 *      cell — a number whose definition is engine output or resolver arithmetic rather than a
 *      dictionary field (`DERIVED_NODES` / `DERIVED_CELLS` / `DERIVED_PREFIXES` below). Tier 3 has
 *      more of these than Tier 2 by construction: an implied policy path, a Z-spread allocation and
 *      a scenario matrix are model output, and the dictionary names none of them.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getField, manifests } from '@terminal/core';
import type { FunctionCode, ParamsOf, PayloadOf } from '@terminal/core';
import type { InstrumentSummary, PayloadMeta } from '@terminal/sdk';
import { describe, expect, it } from 'vitest';

import type {
  Cell,
  ChartSpec,
  LiveView,
  Node,
  ScreenCtx,
  ScreenProps,
  ScreenSpec,
} from '../../../src/screen/types.js';
import { screenModules } from '../../../src/screens/index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The ten Tier 3 codes
// ─────────────────────────────────────────────────────────────────────────────────────────────

const TIER3_CODES = Object.entries(manifests)
  .filter(([, m]) => m.tier === 3)
  .map(([code]) => code as FunctionCode)
  .sort();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures
//
// The helpers below are deliberate duplicates of `test/screens/tier{1,2}/screens.test.tsx`:
// importing them would import those files' `describe` blocks and run those suites again.
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
      if (key === 'provIdx' || key === 'legProvIdx' || key === 'curveProvIdx' || key === 'termsProvIdx') {
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
function metaFor(payload: unknown, extra: Partial<PayloadMeta> = {}): PayloadMeta {
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
    ...extra,
  };
}

const INSTRUMENT: InstrumentSummary = {
  instrumentId: 1,
  assetClass: 'govt',
  marketSector: 'Govt',
  display: 'T 4.25 08/15/36 Govt',
  name: 'US Treasury Note 4.25% 15-Aug-2036',
  currency: 'USD',
  mdLineIds: [101],
  ticker: 'T',
  exchCode: 'US',
  securityType: 'US GOVERNMENT',
  compositeFigi: null,
  status: 'active',
  priceDecimals: 6,
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
  meta?: PayloadMeta,
): ScreenProps<ParamsOf<C>, PayloadOf<C>> {
  const params = manifests[code].params.parse(overrides) as ParamsOf<C>;
  return {
    payload,
    params,
    instrument: INSTRUMENT,
    meta: payload === undefined ? undefined : (meta ?? metaFor(payload)),
    live: LIVE,
    ctx: recordingCtx<ParamsOf<C>>(rec),
  };
}

function runScreen<C extends FunctionCode>(
  code: C,
  props: ScreenProps<ParamsOf<C>, PayloadOf<C>>,
): ScreenSpec {
  const screen = screenModules[code].Screen as (
    p: ScreenProps<ParamsOf<C>, PayloadOf<C>>,
  ) => ScreenSpec;
  return screen(props);
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
 * Nodes every one of whose cited numbers is engine output with no dictionary field.
 *
 * `cashflows` (YAS), `path` and `terminal` (WIRP), `meetings` (FED), `perContract` and `scenario`
 * (OVML) are each a block of model output: a discounted cashflow, an implied overnight rate, a
 * per-contract premium, a repriced scenario cell. Each cites the provenance of the curve or the
 * valuation it came from; none of them is a value of a dictionary field, and inventing one would be
 * worse than exempting them here where the exemption is reviewable.
 */
const DERIVED_NODES: ReadonlySet<string> = new Set([
  'cashflows',
  'path',
  'terminal',
  'meetings',
  'perContract',
  'scenario',
]);

/** `<nodeId>.<column>` pairs whose number is resolver or engine arithmetic over a cited input. */
const DERIVED_CELLS: ReadonlySet<string> = new Set([
  // YAS — per-100 risk and the 1/32 price step are conventions, not dictionary fields.
  'results.DV01 / 100',
  'results.Yield value 1/32',
  'results.Dollar discount',
  // CRVF — the one-year forward has no dictionary id, and a basis-point change never does.
  'nodes.fwd1y',
  // WIRP — the allocation share of a 25 bp outcome.
  'current.Target mid',
  'current.Basis bp',
  'probs.prob',
  // FED — one-day and spread-to-mid changes on the overnight complex and the H.15 grid.
  'rates.chg1dBp',
  'rates.spreadToMidBp',
  'h15.chg1dBp',
  // OVML — moneyness, lambda and the OMON-style mid are identities over engine outputs.
  'results.Moneyness',
  'results.Lambda',
  'market.Mid',
  // OMON — the mid and the two put/call ratios are OMON's own numbers, not Cboe's.
  'chain.c:mid',
  'chain.p:mid',
  'summary.P/C volume*',
  'summary.P/C open interest*',
  // SWPM — leg present values, the market value fraction and the duration identities.
  'results.MV % notional',
  'results.PV fixed',
  'results.PV float',
  'results.DV01 / 1mm',
  'results.Effective duration',
  'results.Break-even rate',
  'fixedSummary.PV',
  'fixedSummary.Next cashflow',
  'floatSummary.PV',
  'floatSummary.Next cashflow',
  'fixed.cashflow',
  'fixed.df',
  'fixed.pv',
  'float.cashflow',
  'float.df',
  'float.pv',
  // SRCH — years to maturity is a screen concept; the dictionary has no `MTY_YEARS`.
  'rows.MTY_YEARS',
  // GC — the change of a history series over the requested range.
  'series.rangeBp',
]);

/**
 * `[nodeId, columnPrefix]` exemptions, for columns whose id names a comparison date or a compare
 * index rather than a datum: a basis-point change column exists once per comparison and cannot be
 * listed by name without hard-coding the golden's dates.
 */
const DERIVED_PREFIXES: readonly (readonly [string, string])[] = [
  ['changes', 'bp:'],
  ['spreads', 'bp:'],
  ['nodes', 'chg'],
];

function isDerived(nodeId: string, column: string): boolean {
  if (DERIVED_NODES.has(nodeId)) return true;
  if (DERIVED_CELLS.has(`${nodeId}.${column}`)) return true;
  return DERIVED_PREFIXES.some(([node, prefix]) => node === nodeId && column.startsWith(prefix));
}

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

function badgeText(spec: ScreenSpec): string {
  return walkNodes(spec.body)
    .flatMap((n) => (n.kind === 'badges' ? n.items : []))
    .map((b) => `${b.text} ${b.title ?? ''}`)
    .join(' | ');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The cases, each against its committed golden
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Case {
  readonly name: string;
  readonly code: FunctionCode;
  readonly spec: ScreenSpec;
  readonly meta: PayloadMeta;
}

function build(): Case[] {
  const cases: Case[] = [];
  const push = <C extends FunctionCode>(
    name: string,
    code: C,
    payload: PayloadOf<C>,
    overrides: Record<string, unknown> = {},
  ): void => {
    cases.push({
      name,
      code,
      spec: runScreen(code, propsFor(code, payload, overrides)),
      meta: metaFor(payload),
    });
  };

  push('YAS.govt', 'YAS', golden<'YAS'>('YAS.govt.json'));
  push('YAS.govt(cashflows)', 'YAS', golden<'YAS'>('YAS.govt.json'), { view: 'cashflows' });
  push('YAS.govt.bill', 'YAS', golden<'YAS'>('YAS.govt.bill.json'), { input: 'discount' });

  push('CRVF.default', 'CRVF', golden<'CRVF'>('CRVF.default.json'));
  push('CRVF.default(table)', 'CRVF', golden<'CRVF'>('CRVF.default.json'), {
    view: 'table',
    outputs: ['input', 'par', 'zero', 'df', 'fwd3m', 'fwd1y'],
  });

  push('WIRP.default', 'WIRP', golden<'WIRP'>('WIRP.default.json'));
  push('WIRP.default(probabilities)', 'WIRP', golden<'WIRP'>('WIRP.default.json'), {
    view: 'probabilities',
  });

  push('OVML.contract', 'OVML', golden<'OVML'>('OVML.contract.json'));
  push('OVML.contract(scenario)', 'OVML', golden<'OVML'>('OVML.contract.json'), { view: 'scenario' });
  push('OVML.contract(greeks)', 'OVML', golden<'OVML'>('OVML.contract.json'), { view: 'greeks' });
  push('OVML.underlying', 'OVML', golden<'OVML'>('OVML.underlying.json'));

  push('OMON.underlying', 'OMON', golden<'OMON'>('OMON.underlying.json'));
  push('OMON.underlying(smile)', 'OMON', golden<'OMON'>('OMON.underlying.json'), { view: 'smile' });

  push('SWPM.default', 'SWPM', golden<'SWPM'>('SWPM.default.json'));
  push('SWPM.default(fixed)', 'SWPM', golden<'SWPM'>('SWPM.default.json'), { view: 'fixed' });
  push('SWPM.default(float)', 'SWPM', golden<'SWPM'>('SWPM.default.json'), { view: 'float' });
  push('SWPM.default(risk)', 'SWPM', golden<'SWPM'>('SWPM.default.json'), { view: 'risk' });

  push('SRCH.default', 'SRCH', golden<'SRCH'>('SRCH.default.json'));
  push('SRCH.default.bills', 'SRCH', golden<'SRCH'>('SRCH.default.bills.json'), {
    securityTypes: ['bill'],
    columns: ['CUSIP', 'MATURITY', 'DISC_RATE', 'BEY'],
  });

  push('GC.default', 'GC', golden<'GC'>('GC.default.json'));
  push('GC.default.history', 'GC', golden<'GC'>('GC.default.history.json'), {
    mode: 'history',
    range: '5Y',
    tenors: ['10Y'],
  });

  push('FED.default', 'FED', golden<'FED'>('FED.default.json'));
  push('FED.default(calendar)', 'FED', golden<'FED'>('FED.default.json'), { view: 'calendar' });
  push('FED.default(press)', 'FED', golden<'FED'>('FED.default.json'), { view: 'press' });

  push('CRYP.default', 'CRYP', golden<'CRYP'>('CRYP.default.json'));
  return cases;
}

const CASES = build();

describe('Tier 3 screens — every code produces a ScreenSpec from its committed golden', () => {
  it('uses a committed golden for every Tier 3 code', () => {
    const files = readdirSync(GOLDEN_DIR);
    for (const code of TIER3_CODES) {
      expect(files.some((f) => f.startsWith(`${code}.`)), `${code} has no committed golden`).toBe(
        true,
      );
    }
  });

  it('covers all ten Tier 3 codes', () => {
    expect(TIER3_CODES).toHaveLength(10);
    expect(new Set(CASES.map((c) => c.code))).toEqual(new Set(TIER3_CODES));
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
        if (isDerived(nodeId, column)) continue;
        expect(cell.fieldId, `${where}: cited number without a fieldId`).toBeDefined();
      }
    },
  );

  it('keeps the derived-cell exemption list honest', () => {
    // Every exemption has to name a node some Tier 3 screen actually draws, or the list is a
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
    for (const [nodeId] of DERIVED_PREFIXES) {
      expect(drawn.has(nodeId), `DERIVED_PREFIXES names '${nodeId}', which no screen draws`).toBe(
        true,
      );
    }
  });

  it('shows at least one cited numeric cell on every screen that has numbers', () => {
    const cited = CASES.filter((c) =>
      walkCells(c.spec.body).some((x) => typeof x.cell.v === 'number' && x.cell.provIdx >= 0),
    );
    expect(cited.length).toBe(CASES.length);
  });

  it('never shows a number for a value the payload marked null', () => {
    for (const c of CASES) {
      for (const { cell, column, nodeId } of walkCells(c.spec.body)) {
        if (cell.st === 'na' || cell.st === 'blank') {
          expect(cell.v, `${c.name} ${nodeId}.${column}: ${cell.st} cell with a value`).toBeNull();
        }
        // A denied field arrives already null with `r` set; the screen may not launder it (ENTL-05).
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
    '%s is exercised by at least one Tier 3 screen',
    (kind) => {
      expect(used.has(kind as NodeKind)).toBe(true);
    },
  );

  it('uses no `chart` node: every Tier 3 plot is a `custom` canvas WP-12 owns', () => {
    // CRVF, GC, OMON and OVML are the four plots of this tier, and each is a `custom` node carrying
    // a `ChartSpec` in its props rather than a `chart` node — the manifests declare CRVF and GC
    // `screenKind:'custom'`, and the smile and the greeks profile are option canvases, not price
    // charts.
    expect(used.has('chart')).toBe(false);
  });
});

describe('Custom nodes declare a complete, cited ChartSpec and draw nothing', () => {
  const customCases = CASES.filter((c) =>
    walkNodes(c.spec.body).some((n) => n.kind === 'custom'),
  );

  it('at least CRVF, GC, OMON and OVML carry one', () => {
    expect(new Set(customCases.map((c) => c.code))).toEqual(new Set(['CRVF', 'GC', 'OMON', 'OVML']));
  });

  it.each(customCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    for (const node of walkNodes(c.spec.body)) {
      if (node.kind !== 'custom') continue;
      expect(CHART_COMPONENTS.has(node.component), `${node.id}: unexpected component`).toBe(true);
      const props = node.props as { spec?: ChartSpec };
      expect(props.spec, `${node.id}: no ChartSpec in props`).toBeDefined();
      const spec = props.spec!;
      expect(spec.panes.length).toBeGreaterThan(0);
      expect(spec.yAxes.length).toBeGreaterThan(0);
      expect(spec.series.length).toBeGreaterThan(0);
      const axes = new Set(spec.yAxes.map((a) => a.id));
      const panes = new Set(spec.panes.map((p) => p.id));
      for (const series of spec.series) {
        expect(series.x.length, `${node.id}/${series.id}: x and y differ in length`).toBe(
          series.y.length,
        );
        expect(axes.has(series.yAxis), `${node.id}/${series.id}: unknown yAxis`).toBe(true);
        expect(panes.has(series.pane), `${node.id}/${series.id}: unknown pane`).toBe(true);
        expect(Number.isInteger(series.provIdx)).toBe(true);
        expect(series.provIdx).toBeGreaterThanOrEqual(0);
        expect(series.provIdx).toBeLessThan(c.meta.provenance.length);
      }
    }
  });
});

describe('Keymaps address regions the spec actually contains', () => {
  it.each(TIER3_CODES)('%s: every manifest binding names a region some variant renders', (code) => {
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
  it.each(TIER3_CODES)('%s returns a valid spec while the payload is in flight', (code) => {
    const spec = runScreen(code, propsFor(code, undefined) as never);
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
  it.each(TIER3_CODES)('%s surfaces the entitlement denial and the unavailable note', (code) => {
    const c = CASES.find((x) => x.code === code);
    expect(c).toBeDefined();
    const text = badgeText(c!.spec);
    expect(text, `${code} drops the ENTL-05 denial`).toContain('TIER_EOD');
    expect(text, `${code} drops the meta.unavailable note`).toContain('NO_SOURCE');
  });

  it('CRYP leads with CONTEXT_ONLY_NOT_EXCHANGE_DATA and names the source', () => {
    const c = CASES.find((x) => x.code === 'CRYP');
    const text = badgeText(c!.spec);
    expect(text).toContain('CONTEXT_ONLY_NOT_EXCHANGE_DATA');
    expect(text).toContain('coingecko.simple');
    // The change column is a rolling 24-hour move, never a change since a close.
    const grid = walkNodes(c!.spec.body).find((n) => n.kind === 'grid' && n.id === 'rows');
    const columns = (grid as Extract<Node, { kind: 'grid' }>).columns;
    expect(columns.find((col) => col.id === 'chg24hPct')?.label).toContain('24h');
    expect(c!.spec.footer?.notes?.join(' ')).toContain('rolling 24-hour move');
  });

  it('WIRP says twice that its probabilities are not a traded distribution', () => {
    for (const c of CASES.filter((x) => x.code === 'WIRP')) {
      const text = badgeText(c.spec);
      expect(text).toContain('NO_FUTURES_SOURCE');
      expect(text).toContain('POINT_MASS_PROBABILITY_MODEL');
      const disclaimer = walkNodes(c.spec.body).find((n) => n.kind === 'text' && n.id === 'disclaimer');
      expect(disclaimer).toBeDefined();
      expect((disclaimer as Extract<Node, { kind: 'text' }>).text).toContain(
        'not an options-implied distribution',
      );
      expect(c.spec.footer?.notes?.join(' ')).toContain('not an options-implied distribution');
    }
  });

  it('WIRP shows a past meeting as a decision, never as a forecast', () => {
    const c = CASES.find((x) => x.name === 'WIRP.default');
    const grid = walkNodes(c!.spec.body).find((n) => n.kind === 'grid' && n.id === 'path');
    const rows = (grid as Extract<Node, { kind: 'grid' }>).rows;
    const past = rows.filter((r) => r.tone === 'muted');
    expect(past.length).toBeGreaterThan(0);
    for (const row of past) {
      for (const key of ['impliedOn', 'impliedRef', 'cumBp', 'stepBp', 'moves']) {
        expect(typeof row.cells[key]?.v, `${row.id}.${key} back-filled a past meeting`).not.toBe(
          'number',
        );
      }
    }
  });

  it('FED shows its four structural gaps rather than omitting them', () => {
    for (const c of CASES.filter((x) => x.code === 'FED')) {
      const text = badgeText(c.spec);
      for (const reason of [
        'NO_IORB_SOURCE',
        'NO_DISCOUNT_RATE_SOURCE',
        'NO_BALANCE_SHEET_SOURCE',
        'NO_FUTURES_SOURCE',
      ]) {
        expect(text, `${c.name} drops ${reason}`).toContain(reason);
      }
    }
    // …and the calendar never shows a probability number.
    const calendar = CASES.find((x) => x.name === 'FED.default(calendar)');
    const grid = walkNodes(calendar!.spec.body).find((n) => n.kind === 'grid' && n.id === 'meetings');
    for (const row of (grid as Extract<Node, { kind: 'grid' }>).rows) {
      expect(typeof row.cells.hikeProb?.v).not.toBe('number');
      expect(typeof row.cells.cutProb?.v).not.toBe('number');
      expect(String(row.cells.hikeProb?.v)).toContain('NO_FUTURES_SOURCE');
    }
    const note = walkNodes(calendar!.spec.body).find((n) => n.kind === 'text' && n.id === 'pathNote');
    expect((note as Extract<Node, { kind: 'text' }>).text).toContain('no fed-funds futures source');
  });

  it('SRCH never stops saying the price is curve-derived and the universe is the seed', () => {
    for (const c of CASES.filter((x) => x.code === 'SRCH')) {
      const text = badgeText(c.spec);
      expect(text).toContain('NO_BOND_PRICE_SOURCE');
      expect(text).toContain('SEED_UNIVERSE_ONLY');
      const kv = walkNodes(c.spec.body).find((n) => n.kind === 'kv' && n.id === 'pricing');
      expect(kv).toBeDefined();
      const basis = (kv as Extract<Node, { kind: 'kv' }>).rows.find((r) => r.label === 'Basis');
      expect(basis?.value.v).toBe('curve_derived_no_market_quotes');
    }
  });

  it('SWPM and OMON carry their permanent caveats on every variant', () => {
    for (const c of CASES.filter((x) => x.code === 'SWPM')) {
      const text = badgeText(c.spec);
      expect(text).toContain('PROXY_CURVE');
      expect(text).toContain('NO_OIS_SWAP_QUOTES_SOURCE');
    }
    for (const c of CASES.filter((x) => x.code === 'OMON')) {
      const text = badgeText(c.spec);
      expect(text).toContain('PROVIDER_GREEKS_CBOE');
      expect(text).toContain('DELAYED_15MIN');
      expect(text).toContain('NO_OPRA_DEPTH');
    }
  });

  it('SWPM leaves the float leg DV01 blank as a declined cell rather than subtracting one', () => {
    const c = CASES.find((x) => x.name === 'SWPM.default(float)');
    const kv = walkNodes(c!.spec.body).find((n) => n.kind === 'kv' && n.id === 'floatSummary');
    const dv01 = (kv as Extract<Node, { kind: 'kv' }>).rows.find((r) => r.label === 'DV01');
    expect(dv01?.value.v).toBeNull();
    // `st:'na'` and no reason code: the resolver declined to compute it, which is not the same
    // claim as `NOT_IN_UNIVERSE` — the number is not outside the served universe. The sentence
    // is in `meta.unavailable['legs.dv01']`, where the screen's tooltip reads it.
    expect(dv01?.value.st).toBe('na');
    expect(dv01?.value.r).toBeUndefined();
  });

  it('OMON keeps a suspect implied volatility visible with its warning', () => {
    const c = CASES.find((x) => x.name === 'OMON.underlying');
    const grid = walkNodes(c!.spec.body).find((n) => n.kind === 'grid' && n.id === 'chain');
    const rows = (grid as Extract<Node, { kind: 'grid' }>).rows;
    expect(rows.length).toBeGreaterThan(0);
    // The ATM row is highlighted and the chain is not empty of IV.
    expect(rows.some((r) => r.tone === 'highlight')).toBe(true);
    expect(rows.some((r) => typeof r.cells['c:iv']?.v === 'number')).toBe(true);
    expect(badgeText(c!.spec)).toContain('DEEP_ITM_IV_UNRELIABLE');
  });

  it('YAS refuses a TIPS or FRN in words rather than pricing it', () => {
    const payload = golden<'YAS'>('YAS.govt.json');
    const meta = metaFor(payload, {
      unavailable: [
        {
          field: 'results',
          reason: 'NOT_APPLICABLE',
          detail:
            'YAS v1 prices fixed-coupon notes/bonds and bills; TIPS/FRN pricing needs an inflation/reference-rate engine',
        },
      ],
    });
    const spec = runScreen('YAS', propsFor('YAS', payload, {}, undefined, meta));
    const node = walkNodes(spec.body).find((n) => n.kind === 'text' && n.id === 'results');
    expect(node, 'the results block was not replaced').toBeDefined();
    expect((node as Extract<Node, { kind: 'text' }>).text).toContain('TIPS');
    expect((node as Extract<Node, { kind: 'text' }>).tone).toBe('warn');
    // …and no results number is shown anywhere on that spec.
    const results = walkCells(spec.body).filter((x) => x.nodeId === 'results');
    expect(results).toHaveLength(0);
  });

  it('YAS drops the key-rate table on a bill instead of showing an empty one', () => {
    const bill = CASES.find((c) => c.name === 'YAS.govt.bill');
    const krd = walkNodes(bill!.spec.body).find((n) => n.kind !== 'split' && n.id === 'krd');
    expect(krd?.kind).toBe('text');
    const coupon = CASES.find((c) => c.name === 'YAS.govt');
    const table = walkNodes(coupon!.spec.body).find((n) => n.kind !== 'split' && n.id === 'krd');
    expect(table?.kind).toBe('table');
  });
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
  it('SWPM submits the trade form as a param change, and a blank fixed rate means par', () => {
    const rec: Recorder = { setParams: [], navigate: [], provenance: [], focus: [] };
    const props = propsFor('SWPM', golden<'SWPM'>('SWPM.default.json'), {}, rec);
    const spec = screenModules.SWPM.Screen(props);
    const form = walkNodes(spec.body).find((n) => n.kind === 'form');
    expect(form).toBeDefined();
    form!.onSubmit({
      side: 'receive',
      notional: 25_000_000,
      tenor: '10Y',
      fixedRate: '',
      effective: '2026-09-21',
      maturity: '',
      curveDate: '',
      interpolation: 'linear_zero',
    });
    expect(rec.setParams).toHaveLength(1);
    expect(rec.setParams[0]).toMatchObject({
      side: 'receive',
      notional: 25_000_000,
      tenor: '10Y',
      fixedRate: null,
      effective: '2026-09-21',
      interpolation: 'linear_zero',
    });
  });

  it('SRCH submits the criteria form as a param change', () => {
    const rec: Recorder = { setParams: [], navigate: [], provenance: [], focus: [] };
    const props = propsFor('SRCH', golden<'SRCH'>('SRCH.default.json'), {}, rec);
    const spec = screenModules.SRCH.Screen(props);
    const form = walkNodes(spec.body).find((n) => n.kind === 'form');
    form!.onSubmit({
      securityTypes: 'NOTE,BOND',
      maturityFrom: '2028-01-01',
      maturityTo: '',
      yearsFrom: 2,
      yearsTo: 10,
      couponFrom: '',
      couponTo: '',
      onTheRun: 'only',
      callable: 'any',
      minAmountOutstanding: '',
      cusip: '',
      curveId: 'UST_CMT',
      settlement: '',
    });
    expect(rec.setParams).toHaveLength(1);
    expect(rec.setParams[0]).toMatchObject({
      securityTypes: ['note', 'bond'],
      maturityFrom: '2028-01-01',
      maturityTo: null,
      yearsFrom: 2,
      yearsTo: 10,
      onTheRun: 'only',
      curveId: 'UST_CMT',
    });
  });

  it('OMON and CRYP hand a row command back to the shell', () => {
    const omon = CASES.find((c) => c.name === 'OMON.underlying');
    const chain = walkNodes(omon!.spec.body).find((n) => n.kind === 'grid' && n.id === 'chain');
    const grid = chain as Extract<Node, { kind: 'grid' }>;
    const row = grid.rows[0];
    expect(row).toBeDefined();
    expect(grid.onEnter?.(row!)).toContain('OVML');

    const cryp = CASES.find((c) => c.code === 'CRYP');
    const rows = walkNodes(cryp!.spec.body).find((n) => n.kind === 'grid' && n.id === 'rows');
    const crypGrid = rows as Extract<Node, { kind: 'grid' }>;
    expect(crypGrid.onEnter?.(crypGrid.rows[0]!)).toContain('DES');
  });
});
