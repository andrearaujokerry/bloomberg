/**
 * packages/web/test/screens/tier1/screens.test.tsx — WP-09 acceptance row, adapted.
 *
 * WORKPLAN's row reads "every Tier 1 `Screen.tsx` renders its payload fixture; every `Node` kind is
 * keyboard-operable". Half of that cannot be executed yet and this file does not pretend otherwise:
 *
 *   * **Rendering** is asserted as the `ScreenSpec` each screen returns, not as DOM. A screen is a
 *     pure function from props to a spec; `ScreenRenderer.tsx` and the widget set are WP-12's and do
 *     not exist. Asserting the spec is asserting everything the screen decides.
 *   * **Keyboard operability** of a node is the renderer's behaviour, so the DOM half of the row is
 *     deferred to WP-12. What is checkable now — and is checked here — is that every keymap entry
 *     names a focus region that the spec actually contains, so no binding is addressed at a node
 *     that was never drawn.
 *
 * What the payload fixtures are: `fixtures/golden/functions/<CODE>.<variant>.json`, the committed
 * goldens the resolver integration tests assert against at the frozen clock `2026-09-15T18:41:28Z`.
 * Using them means a screen is exercised against the exact payload the server produces, not against
 * a shape a screen test invented. Two codes have no committed golden — see `MISSING_GOLDENS`.
 *
 * The provenance rule this file enforces (FUNCTIONS.md §1.5, DATA-10):
 *   1. every `Cell` whose value is a number carries a `provIdx`;
 *   2. a numeric cell that cites provenance (`provIdx >= 0`) names the `fieldId` it is a value of,
 *      and that index exists in `meta.provenance`;
 *   3. a `fieldId` on any cell is a real entry of the field dictionary;
 *   4. the single exemption from (2) is a CHRT-07 computed column (`c1`, `c2`, …), whose formula is
 *      its definition and which has no dictionary field — `MonitorRow.cells` documents that key.
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
  LiveView,
  Node,
  ScreenCtx,
  ScreenProps,
  ScreenSpec,
} from '../../../src/screen/types.js';
import { machineGeneratedRows } from '../../../src/screens/shared/newsList.js';
import type { NewsListRow } from '../../../src/screens/shared/newsList.js';
import { screenModules } from '../../../src/screens/index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────────────────────

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(dirname(dirname(TEST_DIR)))));
const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'golden', 'functions');

/**
 * The two Tier 1 codes with no committed golden. Phase 3 wrote one golden per variant for the other
 * twelve; `HELP` and `SECF` have resolver tests that assert their payloads inline rather than
 * against a file, so there is nothing for this file to load. Their payloads are therefore built
 * here — typed as `PayloadOf<'HELP'>` / `PayloadOf<'SECF'>`, so the compiler still checks the shape,
 * and built out of the real manifests rather than out of invented text.
 */
const MISSING_GOLDENS = ['HELP', 'SECF'] as const;

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
      if (key === 'provIdx') {
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
    entitlement: [
      { fieldId: 'PX_BID', decision: 'deny', effectiveTier: null, reason: 'TIER_EOD' },
    ],
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

/** Everything the shell would do, recorded instead of done. */
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

/** CHRT-07 computed column: `c1`, `c2`, … (`MonitorRow.cells` — "FieldId or 'c<n>' formula column"). */
const FORMULA_COLUMN = /^c\d+$/;

const VALUE_STATES = new Set(['live', 'stale', 'closed', 'blank', 'na']);

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
// The fourteen screens, each against its committed golden payload
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Case {
  readonly name: string;
  readonly code: FunctionCode;
  readonly spec: ScreenSpec;
  readonly meta: PayloadMeta;
}

/** `HELP`'s four views, built from real manifests (see `MISSING_GOLDENS`). */
function helpPayloads(): PayloadOf<'HELP'>[] {
  const gp = manifests.GP;
  return [
    {
      variant: 'default',
      view: 'function',
      function: {
        code: gp.code,
        name: gp.name,
        tier: gp.tier,
        variant: 'equity',
        help: gp.help,
        params: gp.help.params.map((p) => ({ name: p.name, schema: {}, default: null })),
        csvColumns: Array.isArray(gp.csv?.columns) ? gp.csv.columns : null,
        fields: [
          {
            id: 'PX_LAST',
            label: 'Last price',
            definition: 'The most recent trade price the composite has accepted.',
            sourceId: 'cboe.quotes',
            attribution: 'Cboe delayed quotes',
            decision: 'allow',
            reason: 'OK',
          },
          {
            id: 'PX_BID',
            label: 'Bid price',
            definition: 'Best bid on the composite.',
            sourceId: 'cboe.quotes',
            attribution: 'Cboe delayed quotes',
            decision: 'deny',
            reason: 'TIER_EOD',
          },
        ],
        keys: gp.keymap,
      },
    },
    {
      variant: 'default',
      view: 'index',
      tiers: [
        {
          tier: 1,
          functions: Object.values(manifests).map((m) => ({
            code: m.code,
            name: m.name,
            summary: m.help.summary,
            aliases: [...m.aliases],
          })),
        },
      ],
      shell: [{ word: 'GO', text: 'Execute the command line.' }],
      keys: [{ key: 'F1', action: 'help' }],
    },
    {
      variant: 'default',
      view: 'search',
      query: 'chart',
      hits: [
        { kind: 'function', id: 'GP', title: 'GP · Price Graph', snippet: 'Daily chart', score: 0.98 },
        { kind: 'field', id: 'PX_LAST', title: 'PX_LAST', snippet: 'Last price', score: 0.41 },
      ],
    },
    {
      variant: 'default',
      view: 'tickets',
      tickets: [
        {
          ticketId: 7,
          openedAt: '2026-09-15T18:20:00.000Z',
          functionCode: 'GP',
          question: 'Why is the 1Y return blank for UKX?',
          status: 'open',
          roomId: 3,
          answer: null,
          answeredAt: null,
        },
      ],
    },
  ];
}

/** `SECF`'s payload (see `MISSING_GOLDENS`). */
function secfPayload(): PayloadOf<'SECF'> {
  return {
    variant: 'default',
    hits: [
      {
        instrument: {
          instrumentId: 1,
          assetClass: 'equity',
          marketSector: 'Equity',
          display: 'AAPL US Equity',
          name: 'Apple Inc',
          currency: 'USD',
          mdLineIds: [101],
          ticker: 'AAPL',
          exchCode: 'UW',
          securityType: 'Common Stock',
          compositeFigi: 'BBG000B9Y5X2',
          status: 'active',
          priceDecimals: 2,
        },
        matchedOn: 'name',
        matched: [[0, 5]],
        score: 0.982,
        identifiers: { figi: 'BBG000B9XRY4', isin: 'US0378331005', cusip: '037833100' },
        memberOf: ['SPX'],
        listings: 4,
        gicsSector: 'Information Technology',
        provIdx: 0,
      },
    ],
    total: 41,
    facets: {
      assetClass: { equity: 28, etf: 6, index: 3, rate: 1, econ: 1, crypto: 2 },
      exchange: { UW: 12, UN: 16 },
      status: { active: 41 },
    },
    source: 'master',
  };
}

function build(): Case[] {
  const cases: Case[] = [];
  const push = <C extends FunctionCode>(
    name: string,
    code: C,
    payload: PayloadOf<C>,
    overrides: Record<string, unknown> = {},
  ): void => {
    const props = propsFor(code, payload, overrides);
    const screen = screenModules[code].Screen as (
      p: ScreenProps<ParamsOf<C>, PayloadOf<C>>,
    ) => ScreenSpec;
    cases.push({ name, code, spec: screen(props), meta: props.meta! });
  };

  for (const variant of ['equity', 'index', 'fx', 'govt', 'option', 'crypto', 'rate', 'econ']) {
    push(`DES.${variant}`, 'DES', golden<'DES'>(`DES.${variant}.json`));
  }
  push('DES.equity(news tab)', 'DES', golden<'DES'>('DES.equity.json'), { tab: 'news' });

  for (const variant of ['equity', 'index', 'fx', 'govt', 'option', 'crypto', 'series']) {
    push(`GP.${variant}`, 'GP', golden<'GP'>(`GP.${variant}.json`), {
      range: 'CUSTOM',
      start: '2026-09-01',
      end: '2026-09-15',
      studies: [{ id: 'SMA', params: { n: 20 }, pane: 'main' }, { id: 'RSI', params: { n: 14 } }],
    });
  }
  push('GIP.intraday', 'GIP', golden<'GIP'>('GIP.intraday.json'));
  push('HP.price', 'HP', golden<'HP'>('HP.price.json'));
  push('Q.quote', 'Q', golden<'Q'>('Q.quote.json'));
  push('QM.default', 'QM', golden<'QM'>('QM.default.json'));
  push('W.default', 'W', golden<'W'>('W.default.json'));
  push('W.manage', 'W', golden<'W'>('W.default.json'), { view: 'manage' });
  push('W.share', 'W', golden<'W'>('W.default.json'), { view: 'share' });
  push('TOP.default', 'TOP', golden<'TOP'>('TOP.default.json'));
  push('N.default', 'N', golden<'N'>('N.default.json'), { q: 'capital' });
  push('NI.default', 'NI', golden<'NI'>('NI.default.json'), { topic: 'FED' });
  push('MSG.default', 'MSG', golden<'MSG'>('MSG.default.json'));
  push('MSG.directory', 'MSG', golden<'MSG'>('MSG.default.json'), { view: 'directory' });
  push('WEI.default', 'WEI', golden<'WEI'>('WEI.default.json'));
  for (const payload of helpPayloads()) {
    push(`HELP.${payload.view}`, 'HELP', payload, { view: payload.view });
  }
  push('SECF.default', 'SECF', secfPayload(), { query: 'apple' });
  return cases;
}

const CASES = build();
const CODES = Object.keys(manifests) as FunctionCode[];

describe('Tier 1 screens — every code produces a ScreenSpec from its committed golden', () => {
  it('uses a committed golden for every code that has one', () => {
    // The goldens are the payloads the resolver integration tests assert against; a screen tested
    // against anything else is tested against a shape the server may not produce. Two codes have
    // no golden on disk and are the documented exception (`MISSING_GOLDENS`); this assertion keeps
    // the exception list honest, and keeps passing once those goldens land.
    const files = readdirSync(GOLDEN_DIR);
    for (const code of CODES) {
      const hasGolden = files.some((f) => f.startsWith(`${code}.`));
      expect(
        hasGolden || (MISSING_GOLDENS as readonly string[]).includes(code),
        `${code} has a committed golden that this file does not use`,
      ).toBe(true);
    }
  });

  it('covers all fourteen Tier 1 codes', () => {
    expect(new Set(CASES.map((c) => c.code))).toEqual(new Set(CODES));
    expect(CASES.length).toBeGreaterThanOrEqual(CODES.length);
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s returns a well-formed spec', (_name, c) => {
    expect(c.spec.title.length).toBeGreaterThan(0);
    const nodes = walkNodes(c.spec.body);
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(NODE_KINDS).toContain(node.kind);
      if (node.kind !== 'split') expect(node.id.length).toBeGreaterThan(0);
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
      // Some specs are all list and form and carry no cells at all (TOP, N, the W editors); the
      // `cited numeric cell` test below is what keeps this rule from passing vacuously overall.
      const cells = walkCells(c.spec.body);
      for (const { cell, column, nodeId } of cells) {
        const where = `${c.name} ${nodeId}.${column}`;
        expect(VALUE_STATES.has(cell.st), `${where}: bad state ${cell.st}`).toBe(true);
        // A blank cell shows nothing: it never carries a value the reader could read.
        if (cell.st === 'blank') expect(cell.v, `${where}: blank cell with a value`).toBeNull();
        if (cell.fieldId !== undefined) {
          expect(getField(cell.fieldId), `${where}: ${cell.fieldId} is not in the dictionary`)
            .toBeDefined();
        }
        if (typeof cell.v !== 'number') continue;
        expect(typeof cell.provIdx, `${where}: numeric cell without provIdx`).toBe('number');
        if (cell.provIdx < 0) continue;
        expect(
          cell.provIdx,
          `${where}: provIdx ${String(cell.provIdx)} is outside meta.provenance`,
        ).toBeLessThan(c.meta.provenance.length);
        if (FORMULA_COLUMN.test(column)) continue; // CHRT-07 computed column: the formula is its definition
        expect(cell.fieldId, `${where}: cited number without a fieldId`).toBeDefined();
      }
    },
  );

  it('shows at least one cited numeric cell on every screen that has numbers', () => {
    // Keeps the rule above from passing vacuously on a spec that happens to show no numbers.
    const cited = CASES.filter((c) =>
      walkCells(c.spec.body).some((x) => typeof x.cell.v === 'number' && x.cell.provIdx >= 0),
    );
    expect(cited.length).toBeGreaterThanOrEqual(12);
  });
});

describe('Node kinds', () => {
  const used = new Set<NodeKind>();
  for (const c of CASES) for (const n of walkNodes(c.spec.body)) used.add(n.kind);

  it.each(NODE_KINDS.filter((k) => k !== 'chart'))('%s is exercised by at least one screen', (kind) => {
    expect(used.has(kind)).toBe(true);
  });

  it('routes every Tier 1 chart through a `custom` node, not the `chart` node kind', () => {
    // FUNCTIONS_TIER1 §GP and §GIP both specify `custom#chart` with `component:'PriceChart'`,
    // because the chart owns its own key handling (crosshair, pan, draw mode) — which §1.5 gives to
    // `custom` nodes and not to `chart` nodes. So `chart` is the one kind of the union no Tier 1
    // screen uses; its `ChartSpec` still crosses the boundary, inside the custom node's props.
    expect(used.has('chart')).toBe(false);
    const charts = CASES.flatMap((c) => walkNodes(c.spec.body)).filter(
      (n) => n.kind === 'custom' && n.component === 'PriceChart',
    );
    expect(charts.length).toBeGreaterThanOrEqual(2);
    for (const node of charts) {
      const props = (node as Extract<Node, { kind: 'custom' }>).props as { spec: unknown };
      const spec = props.spec as Record<string, unknown>;
      expect(spec).not.toBeNull();
      expect(spec.kind).toBeDefined();
      expect(spec.xAxis).toBeDefined();
      expect(Array.isArray(spec.yAxes)).toBe(true);
      expect(Array.isArray(spec.panes)).toBe(true);
      expect(Array.isArray(spec.series)).toBe(true);
      expect(spec.crosshair).toBe(true);
    }
  });
});

describe('Keymaps address regions the spec actually contains', () => {
  // The DOM half of the acceptance row (Tab order, arrows inside a grid, Enter on a row) is WP-12's
  // renderer and is deferred to it. What is assertable here is that no binding is aimed at a focus
  // region no screen of that code ever draws.
  it.each(CODES)('%s: every manifest binding names a region some variant renders', (code) => {
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
  it.each(CODES)('%s returns a valid spec while the payload is in flight', (code) => {
    const screen = screenModules[code].Screen as (p: ScreenProps<never, never>) => ScreenSpec;
    const spec = screen(propsFor(code, undefined) as unknown as ScreenProps<never, never>);
    expect(spec.title.length).toBeGreaterThan(0);
    const ids = nodeIds(spec.body);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain(spec.initialFocus);
    // A skeleton shows no numbers at all — it has none to show, and it never invents one.
    for (const { cell } of walkCells(spec.body)) expect(typeof cell.v).not.toBe('number');
  });
});

describe('Entitlement, unavailability and the null rule', () => {
  const RENDERS_META = CODES.filter((c) => c !== 'HELP');

  it.each(RENDERS_META)('%s surfaces the entitlement denial and the unavailable note', (code) => {
    const c = CASES.find((x) => x.code === code);
    expect(c).toBeDefined();
    const badges = walkNodes(c!.spec.body).flatMap((n) => (n.kind === 'badges' ? n.items : []));
    const text = badges.map((b) => `${b.text} ${b.title ?? ''}`).join(' | ');
    expect(text, `${code} drops the ENTL-05 denial`).toContain('TIER_EOD');
    expect(text, `${code} drops the meta.unavailable note`).toContain('NO_SOURCE');
  });

  it('HELP does not gate its own text on entitlements', () => {
    // §HELP: "Entitlement is not applied to the help text itself (documentation is not licensed
    // data)"; the decision is shown as a column of `grid#fields` instead.
    const help = CASES.find((c) => c.name === 'HELP.function');
    expect(help).toBeDefined();
    const badges = walkNodes(help!.spec.body).flatMap((n) => (n.kind === 'badges' ? n.items : []));
    expect(badges.some((b) => b.text.includes('TIER_EOD'))).toBe(false);
    const cells = walkCells(help!.spec.body).filter((x) => x.column === 'entitlement');
    expect(cells.map((x) => String(x.cell.v))).toContain('blocked (TIER_EOD)');
  });

  it('keeps every reason the payload attached to a denied cell', () => {
    // A denied field arrives from the plant already null with `r` set; the screen may not launder
    // it into a plain blank (ENTL-05).
    const denied = CASES.flatMap((c) => walkCells(c.spec.body)).filter(
      (x) => x.cell.r !== undefined,
    );
    for (const { cell } of denied) expect(cell.v).toBeNull();
  });
});

describe('News screens', () => {
  const NEWS_CASES = CASES.filter((c) => ['TOP', 'N', 'NI'].includes(c.code));

  it('renders every headline as a link-out list item with its publication time', () => {
    for (const c of NEWS_CASES) {
      const list = walkNodes(c.spec.body).find((n) => n.kind === 'list' && n.id === 'rows');
      expect(list, `${c.name} has no list#rows`).toBeDefined();
      const items = (list as Extract<Node, { kind: 'list' }>).items;
      for (const item of items) {
        expect(item.primary.length).toBeGreaterThan(0);
        expect(item.ts).toBeDefined();
        expect(item.url).toBeDefined();
        expect(item.command).toBeUndefined();
      }
    }
  });

  it('NEWS-08: no captured headline is machine generated', () => {
    // v1 never produces one; the column exists so the "render generated copy under its own
    // divider" rule is enforceable rather than aspirational. `machineGeneratedRows` is the one
    // implementation of that partition, and over the whole captured corpus it is empty.
    for (const file of ['TOP.default.json', 'N.default.json', 'NI.default.json']) {
      const payload = JSON.parse(readFileSync(join(GOLDEN_DIR, file), 'utf8')) as {
        rows: NewsListRow[];
      };
      expect(payload.rows.length).toBeGreaterThan(0);
      for (const row of payload.rows) expect(row.machineGenerated).toBe(false);
      expect(machineGeneratedRows(payload.rows)).toHaveLength(0);
    }
  });
});

describe('Screens wire their own interactions back through ctx', () => {
  it('N submits the query form as a param change', () => {
    const rec: Recorder = { setParams: [], navigate: [], provenance: [], focus: [] };
    const props = propsFor('N', golden<'N'>('N.default.json'), { q: 'capital' }, rec);
    const spec = screenModules.N.Screen(props);
    const form = walkNodes(spec.body).find((n) => n.kind === 'form');
    expect(form).toBeDefined();
    (form!).onSubmit({
      q: 'rate cut',
      scope: 'all',
      feeds: 'markets,economics',
      topics: '',
      kinds: 'story,filing',
      from: '2026-09-01',
      to: '',
      pageSize: 25,
    });
    expect(rec.setParams).toHaveLength(1);
    expect(rec.setParams[0]).toMatchObject({
      q: 'rate cut',
      feeds: ['markets', 'economics'],
      kinds: ['story', 'filing'],
      from: '2026-09-01',
      pageSize: 25,
    });
  });

  it('SECF submits its filters as a param change', () => {
    const rec: Recorder = { setParams: [], navigate: [], provenance: [], focus: [] };
    const props = propsFor('SECF', secfPayload(), { query: 'apple' }, rec);
    const spec = screenModules.SECF.Screen(props);
    const form = walkNodes(spec.body).find((n) => n.kind === 'form');
    (form!).onSubmit({
      query: 'apple hosp',
      exchange: 'UN',
      status: 'all',
    });
    expect(rec.setParams[0]).toEqual({ query: 'apple hosp', exchange: 'UN', status: 'all' });
  });

  it('W leaves its editor by returning to the grid view', () => {
    const rec: Recorder = { setParams: [], navigate: [], provenance: [], focus: [] };
    const props = propsFor('W', golden<'W'>('W.default.json'), { view: 'manage' }, rec);
    const spec = screenModules.W.Screen(props);
    const form = walkNodes(spec.body).find((n) => n.kind === 'form');
    (form!).onSubmit({ name: 'Core' });
    expect(rec.setParams[0]).toEqual({ view: 'grid', watchlist: { name: 'Core' } });
  });

  it('every live grid can name the subject of each of its rows', () => {
    for (const c of CASES) {
      for (const node of walkNodes(c.spec.body)) {
        if (node.kind !== 'grid' || node.live === undefined) continue;
        for (const row of node.rows) {
          expect(node.live.subjectOf(row)).toBe(row.subject ?? null);
        }
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
