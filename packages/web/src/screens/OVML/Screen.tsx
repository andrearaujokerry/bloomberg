// packages/web/src/screens/OVML/Screen.tsx — Option Valuation (FUNCTIONS_TIER3 §OVML "Screen").
//
// One vanilla listed option, valued on the §0 option conventions, with its full greek set, a
// spot × volatility scenario matrix and a greeks profile.
//
// The distinction this screen exists to keep visible: **`kv#market` is what Cboe published and
// `kv#results` is what the engine computed.** They are separate blocks with separate provenance,
// because OVML's delta and Cboe's delta are different numbers arrived at on different conventions,
// and a reader comparing OVML with OMON must be able to see which is which without being told.
//
// The greeks profile is a `custom#profile` node: it declares the series and the reference lines the
// chart needs and draws none of them — the canvas is WP-12's renderer.
//
// `EXPIRED_CONTRACT` replaces the results block with a sentence rather than filling it with numbers
// from a model that has no time left to run.
//
// Pure: no DOM, no state, no IO.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type {
  Badge,
  Cell,
  ChartSpec,
  FormField,
  FunctionScreen,
  GridColumn,
  GridRow,
  Node,
  ScreenSpec,
} from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
  computedCell,
  cell,
  countCell,
  entitlementBadges,
  footer,
  kvRow,
  numCell,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'OVML'>;
type Payload = PayloadOf<'OVML'>;
type KvRow = ReturnType<typeof kvRow>;

const CAVEAT_TITLES: Readonly<Record<string, string>> = {
  VANILLA_ONLY_NO_EXOTICS: 'v1 has no exotic or path-dependent pricer (ANAL-03 partial).',
  DEEP_ITM_IV_UNRELIABLE: 'A near-zero vega makes a deep in- or out-of-the-money implied volatility meaningless.',
  IV_NO_CONVERGENCE: 'The implied-volatility solve did not converge; no number is shown for it.',
  RATE_FLAT_SOFR: 'No OIS term structure was available: the rate is the flat SOFR fixing.',
  PROXY_CURVE: 'SOFR OIS term points are proxied (SOFR averages, bills, UST par).',
  NO_FUTURES_SOURCE: 'No fed-funds futures or options source is reachable (BRIEF §2).',
  NO_DIVIDEND_HISTORY: 'No cash dividend in the trailing twelve months; the dividend yield used is zero.',
  EXPIRED_CONTRACT: 'OVML values live contracts; this contract has expired.',
};

function inputsForm(p: Payload, params: Params, setParams: (patch: Partial<Params>) => void): Node {
  const i = p.inputs;
  const fields: FormField[] = [
    { id: 'model', label: 'Model', type: 'enum', value: i.model, values: ['bsm', 'black76', 'crr', 'trinomial', 'mc'] },
    { id: 'style', label: 'Style', type: 'enum', value: i.style, values: ['american', 'european'] },
    { id: 'spot', label: `Spot (${i.spotSource})`, type: 'number', value: i.spot.v, step: 0.01, bigStep: 0.1 },
    { id: 'vol', label: `Vol % (${i.volSource})`, type: 'number', value: i.volPct.v, step: 0.25, bigStep: 2.5, unit: '%' },
    { id: 'rate', label: `Rate % (${i.rateSource})`, type: 'number', value: i.ratePct.v, step: 0.01, bigStep: 0.1, unit: '%' },
    { id: 'divYield', label: `Div yld % (${i.divSource})`, type: 'number', value: i.divYieldPct.v, step: 0.01, bigStep: 0.1, unit: '%' },
    { id: 'contracts', label: 'Contracts', type: 'number', value: params.contracts, step: 1, bigStep: 10 },
    { id: 'steps', label: 'Steps', type: 'number', value: i.steps, step: 25, bigStep: 250 },
  ];
  if (p.variant === 'underlying') {
    fields.push(
      { id: 'expiry', label: 'Expiry', type: 'enum', value: p.picked.expiry, values: p.picked.expiriesAvailable.map((e) => e.expiry) },
      { id: 'strike', label: 'Strike', type: 'enum', value: String(p.picked.strike), values: p.picked.strikesAvailable.map((s) => String(s)) },
      { id: 'putCall', label: 'Put/Call', type: 'enum', value: p.picked.putCall, values: ['C', 'P'] },
    );
  }

  return {
    kind: 'form',
    id: 'inputs',
    fields,
    submitLabel: 'Revalue',
    onSubmit: (values): void => {
      const num = (id: string): number | null => {
        const v = values[id];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
        return null;
      };
      const text = (id: string): string | null => {
        const v = values[id];
        return typeof v === 'string' && v !== '' ? v : null;
      };
      const patch: Partial<Params> = {
        spot: num('spot'),
        vol: num('vol'),
        rate: num('rate'),
        divYield: num('divYield'),
        strike: num('strike'),
        expiry: text('expiry'),
      };
      const model = text('model');
      if (model !== null) patch.model = model as NonNullable<Params['model']>;
      const style = text('style');
      if (style !== null) patch.style = style as NonNullable<Params['style']>;
      const putCall = text('putCall');
      if (putCall !== null) patch.putCall = putCall as Params['putCall'];
      const contracts = num('contracts');
      if (contracts !== null) patch.contracts = contracts;
      const steps = num('steps');
      if (steps !== null) patch.steps = steps;
      setParams(patch);
    },
  };
}

function resultsKv(p: Payload): Node {
  const r = p.results;
  const rows: KvRow[] = [
    kvRow('Model value', cell('OPT_MODEL_PX', r.price, { fmt: 'px', decimals: 4 })),
    kvRow('Intrinsic', cell('OPT_INTRINSIC', r.intrinsic, { fmt: 'px', decimals: 4 })),
    kvRow('Time value', cell('OPT_TIME_VALUE', r.timeValue, { fmt: 'px', decimals: 4 })),
    kvRow('Breakeven', cell('OPT_BREAKEVEN', r.breakeven, { fmt: 'px', decimals: 4 })),
    kvRow('Moneyness', computedCell(r.moneynessPct, 'pct', 2)),
    kvRow('Implied vol', cell('OPT_IMPL_VOL_MID', r.impliedVolPct, { fmt: 'pct', decimals: 4 })),
    kvRow('Delta', cell('OPT_DELTA', r.delta, { fmt: 'px', decimals: 5 })),
    kvRow('Gamma', cell('OPT_GAMMA', r.gamma, { fmt: 'px', decimals: 6 })),
    kvRow('Vega', cell('OPT_VEGA', r.vega, { fmt: 'px', decimals: 6 })),
    kvRow('Theta / day', cell('OPT_THETA', r.theta, { fmt: 'px', decimals: 6 })),
    kvRow('Rho', cell('OPT_RHO', r.rho, { fmt: 'px', decimals: 6 })),
    kvRow('Lambda', computedCell(r.lambda, 'px', 4)),
    kvRow('Vanna', cell('OPT_VANNA', r.vanna, { fmt: 'px', decimals: 6 })),
    kvRow('Volga', cell('OPT_VOLGA', r.volga, { fmt: 'px', decimals: 9 })),
    kvRow('Charm', cell('OPT_CHARM', r.charm, { fmt: 'px', decimals: 6 })),
  ];
  if (r.mcStdErr !== null) {
    rows.push(kvRow('MC std error', countCell(r.mcStdErr, 'px', 6)));
  }
  return { kind: 'kv', id: 'results', title: 'Valuation', columns: 2, rows };
}

function perContractKv(p: Payload): Node {
  const c = p.results.perContract;
  return {
    kind: 'kv',
    id: 'perContract',
    title: `Per contract × ${String(c.contracts)} (multiplier ${String(c.multiplier)})`,
    columns: 3,
    rows: [
      kvRow('Premium', computedCell(c.premium, 'ccy', 2)),
      kvRow('Δ shares', computedCell(c.deltaShares, 'px', 4)),
      kvRow('Γ shares', computedCell(c.gammaShares, 'px', 6)),
      kvRow('Vega $ / pt', computedCell(c.vegaCcy, 'ccy', 4)),
      kvRow('Theta $ / day', computedCell(c.thetaCcy, 'ccy', 4)),
      kvRow('Rho $ / 1 %', computedCell(c.rhoCcy, 'ccy', 4)),
    ],
  };
}

function marketKv(p: Payload): Node {
  const m = p.market;
  return {
    kind: 'kv',
    id: 'market',
    title: 'Market (Cboe delayed — exchange-published greeks)',
    columns: 3,
    rows: [
      kvRow('Bid', cell('PX_BID', m.bid, { fmt: 'px', decimals: 4 })),
      kvRow('Ask', cell('PX_ASK', m.ask, { fmt: 'px', decimals: 4 })),
      kvRow('Mid', computedCell(m.mid, 'px', 4)),
      kvRow('Last', cell('PX_LAST', m.last, { fmt: 'px', decimals: 4 })),
      kvRow('Last time', textCell(m.lastTs, { fmt: 'datetime' })),
      kvRow('Prev close', cell('PX_CLOSE_1D', m.prevClose, { fmt: 'px', decimals: 4 })),
      kvRow('Volume', cell('PX_VOLUME', m.volume, { fmt: 'int', decimals: 0 })),
      kvRow('Open interest', cell('OPT_OI', m.openInterest, { fmt: 'int', decimals: 0 })),
      kvRow('Cboe IV', cell('OPT_IV', m.providerIvPct, { fmt: 'pct', decimals: 2 })),
      kvRow('Cboe delta', cell('OPT_DELTA', m.providerDelta, { fmt: 'px', decimals: 4 })),
      kvRow('Cboe gamma', cell('OPT_GAMMA', m.providerGamma, { fmt: 'px', decimals: 4 })),
      kvRow('Cboe vega', cell('OPT_VEGA', m.providerVega, { fmt: 'px', decimals: 4 })),
      kvRow('Cboe theta', cell('OPT_THETA', m.providerTheta, { fmt: 'px', decimals: 4 })),
      kvRow('Cboe rho', cell('OPT_RHO', m.providerRho, { fmt: 'px', decimals: 4 })),
      kvRow('Cboe theo', cell('OPT_THEO', m.providerTheo, { fmt: 'px', decimals: 4 })),
      kvRow('Captured', textCell(m.captureTs, { fmt: 'datetime' })),
    ],
  };
}

function termsKv(p: Payload): Node {
  const c = p.contract;
  const u = p.underlying;
  return {
    kind: 'kv',
    id: 'terms',
    title: 'Contract',
    columns: 3,
    rows: [
      kvRow('OCC', textCell(c.occSymbol, { provIdx: c.provIdx })),
      kvRow('Root', textCell(c.root)),
      kvRow('Underlying', textCell(u.key, { command: `${u.key} DES` })),
      kvRow('Underlying px', cell('OPT_UNDL_PX', u.px, { fmt: 'px', decimals: 4 })),
      kvRow('Strike', numCell('OPT_STRIKE_PX', c.strike, c.provIdx, { fmt: 'px', decimals: 2 })),
      kvRow('Put/Call', textCell(c.putCall, { fieldId: 'OPT_PUT_CALL', provIdx: c.provIdx })),
      kvRow('Expiry', textCell(c.expiry, { fieldId: 'OPT_EXPIRE_DT', fmt: 'date', provIdx: c.provIdx })),
      kvRow('Expiry ts', textCell(c.expiryTs, { fmt: 'datetime' })),
      kvRow('Exercise', textCell(c.exerciseStyle)),
      kvRow('Settlement', textCell(`${c.settlement} · ${c.amPm}`)),
      kvRow('Multiplier', numCell('OPT_CONT_SIZE', c.multiplier, c.provIdx, { fmt: 'int' })),
      kvRow('Tick size', countCell(c.tickSize, 'px', 4)),
      kvRow('Weekly', textCell(c.isWeekly ? 'Y' : 'N')),
      kvRow('Last trade', textCell(c.lastTradeDate, { fmt: 'date' })),
      kvRow('Rate used', cell('OPT_RATE_USED', p.inputs.ratePct, { fmt: 'pct', decimals: 4 })),
      kvRow('Div yield used', cell('OPT_DVD_YIELD_USED', p.inputs.divYieldPct, { fmt: 'pct', decimals: 4 })),
      kvRow('T (years)', countCell(p.inputs.years, 'px', 6)),
      kvRow('Valued at', textCell(p.inputs.valuationTs, { fmt: 'datetime' })),
    ],
  };
}

/** The scenario matrix: one price column and one P&L column per vol shock (a Cell holds one number). */
function scenarioGrid(p: Payload): Node {
  const s = p.scenario;
  const columns: GridColumn[] = [
    { id: 'spot', label: `Spot (${String(s.days)}d decay)`, align: 'left' },
    ...s.volPts.flatMap((v): GridColumn[] => [
      { id: `px:${String(v)}`, label: `px vol ${v > 0 ? '+' : ''}${String(v)}`, align: 'right', fmt: 'px', decimals: 4 },
      { id: `pnl:${String(v)}`, label: `pnl vol ${v > 0 ? '+' : ''}${String(v)}`, align: 'right', fmt: 'ccy', decimals: 2 },
    ]),
  ];

  const rows: GridRow[] = s.spotPct.map((shock): GridRow => {
    const cells: Record<string, Cell> = {
      spot: textCell(`${shock > 0 ? '+' : ''}${String(shock)} %`),
    };
    for (const v of s.volPts) {
      const found = s.cells.find((c) => c.spotPct === shock && c.volPts === v);
      cells[`px:${String(v)}`] = computedCell(
        found === undefined
          ? { v: null, st: 'na', provIdx: -1 }
          : { v: found.price, st: 'closed', provIdx: p.results.price.provIdx },
        'px',
        4,
      );
      cells[`pnl:${String(v)}`] = computedCell(
        found === undefined
          ? { v: null, st: 'na', provIdx: -1 }
          : { v: found.pnl, st: 'closed', provIdx: p.results.price.provIdx },
        'ccy',
        2,
      );
    }
    return {
      id: `scn:${String(shock)}`,
      cells,
      tone: shock === 0 ? 'highlight' : 'normal',
    };
  });

  return {
    kind: 'grid',
    id: 'scenario',
    columns,
    rows,
    frozenColumns: 1,
    selectable: true,
    emptyText: 'No scenario shocks requested.',
  };
}

/** The greeks profile as a chart spec; the component draws it, this file only says what it is. */
export function ovmlProfileSpec(p: Payload): ChartSpec {
  const x = p.greeksProfile.map((pt) => pt.spot);
  const provIdx = p.results.price.provIdx;
  const spot = typeof p.inputs.spot.v === 'number' ? p.inputs.spot.v : Number.NaN;
  return {
    kind: 'curve',
    xAxis: { type: 'tenor' },
    yAxes: [
      { id: 'y', side: 'left', scale: 'linear', fmt: 'px', decimals: 4 },
      { id: 'g', side: 'right', scale: 'linear', fmt: 'px', decimals: 5 },
    ],
    panes: [{ id: 'main', height: 1 }],
    series: [
      { id: 'price', label: 'Price', type: 'line', pane: 'main', yAxis: 'y', x, y: p.greeksProfile.map((pt) => pt.price), provIdx },
      { id: 'delta', label: 'Delta', type: 'line', pane: 'main', yAxis: 'g', x, y: p.greeksProfile.map((pt) => pt.delta), provIdx },
      { id: 'gamma', label: 'Gamma', type: 'line', pane: 'main', yAxis: 'g', x, y: p.greeksProfile.map((pt) => pt.gamma), provIdx, style: { dashed: true } },
      { id: 'vega', label: 'Vega', type: 'line', pane: 'main', yAxis: 'g', x, y: p.greeksProfile.map((pt) => pt.vega), provIdx },
      { id: 'theta', label: 'Theta', type: 'line', pane: 'main', yAxis: 'g', x, y: p.greeksProfile.map((pt) => pt.theta), provIdx },
    ],
    crosshair: true,
    reference: [
      { yAxis: 'y', v: spot, label: 'spot' },
      { yAxis: 'y', v: p.contract.strike, label: 'strike' },
    ],
  };
}

function pickedKv(p: Extract<Payload, { variant: 'underlying' }>): Node {
  return {
    kind: 'kv',
    id: 'picked',
    title: 'Picked contract',
    columns: 3,
    rows: [
      kvRow('Rule', textCell(p.picked.rule)),
      kvRow('Expiry', textCell(p.picked.expiry, { fmt: 'date' })),
      kvRow('Strike', countCell(p.picked.strike, 'px', 2)),
      kvRow('Put/Call', textCell(p.picked.putCall)),
      kvRow('Expiries listed', countCell(p.picked.expiriesAvailable.length)),
      kvRow('Strikes listed', countCell(p.picked.strikesAvailable.length)),
    ],
  };
}

function caveatBadges(p: Payload, meta: Parameters<typeof footer>[0]): Badge[] {
  const badges: Badge[] = p.caveats.map((c) => ({ text: c, tone: 'warn' as const, title: CAVEAT_TITLES[c] ?? c }));
  badges.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));
  return badges;
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, instrument, meta, ctx }) => {
  if (payload === undefined) {
    return {
      title: `OVML · ${instrument?.display ?? 'Option'}`,
      subtitle: 'loading…',
      body: stack(
        'col',
        [
          {
            kind: 'form',
            id: 'inputs',
            fields: [
              { id: 'model', label: 'Model', type: 'enum', value: params.model ?? 'crr', values: ['bsm', 'black76', 'crr', 'trinomial', 'mc'] },
              { id: 'contracts', label: 'Contracts', type: 'number', value: params.contracts },
            ],
            submitLabel: 'Revalue',
            onSubmit: (): void => undefined,
          },
          {
            kind: 'kv',
            id: 'results',
            title: 'Valuation',
            columns: 2,
            rows: [
              kvRow('Model value', textCell(null)),
              kvRow('Delta', textCell(null)),
              kvRow('Gamma', textCell(null)),
              kvRow('Implied vol', textCell(null)),
            ],
          },
        ],
        [0.32, 0.68],
      ),
      footer: footer(undefined),
      initialFocus: 'inputs',
    } satisfies ScreenSpec;
  }

  const expired = payload.caveats.includes('EXPIRED_CONTRACT');
  const results: Node = expired
    ? {
        kind: 'text',
        id: 'results',
        tone: 'warn',
        text: `OVML values live contracts; this contract expired on ${payload.contract.expiry}.`,
      }
    : resultsKv(payload);

  const upper: Node = stack(
    'row',
    [
      inputsForm(payload, params, (patch) => {
        ctx.setParams(patch);
      }),
      results,
    ],
    [0.32, 0.68],
  );

  const blocks: Node[] = [
    { kind: 'badges', id: 'caveats', items: caveatBadges(payload, meta) },
    upper,
    termsKv(payload),
    marketKv(payload),
  ];
  const sizes = [0.06, 0.34, 0.16, 0.18, 0.26];
  if (payload.variant === 'underlying') {
    blocks.splice(2, 0, pickedKv(payload));
    sizes.splice(2, 0, 0.08);
  }
  blocks.push({
    kind: 'tabs',
    id: 'view',
    active: params.view,
    tabs: [
      { id: 'valuation', label: 'Valuation', key: '1', body: perContractKv(payload) },
      { id: 'scenario', label: 'Scenario', key: '2', body: scenarioGrid(payload) },
      {
        id: 'greeks',
        label: 'Greeks',
        key: '3',
        body: {
          kind: 'custom',
          id: 'profile',
          component: 'OptionSurface',
          props: { chart: 'greeks-profile', spec: ovmlProfileSpec(payload) },
        },
      },
    ],
    onChange: (id): void => {
      ctx.setParams({ view: id as Params['view'] });
    },
  });

  const title =
    payload.variant === 'underlying'
      ? `OVML · ${payload.underlying.key} · picked ${payload.contract.putCall}${String(payload.contract.strike)} ${payload.contract.expiry}`
      : `OVML · ${payload.contract.key} · ${payload.underlying.name}`;

  return {
    title: `${title} · ${payload.inputs.model.toUpperCase()} · ${String(payload.inputs.days)}d`,
    subtitle: `valued ${payload.inputs.valuationTs} · r ${String(payload.inputs.ratePct.v ?? '—')} % ${payload.inputs.rateSource} ${payload.inputs.rateCurveDate ?? ''} · q ${String(payload.inputs.divYieldPct.v ?? '—')} % · T ${payload.inputs.years.toFixed(6)}y`,
    body: stack('col', blocks, sizes),
    footer: footer(meta, [
      `engines: ${payload.engines.map((e) => `${e.name}@${e.version}`).join(' · ')}`,
      ...payload.caveats,
    ]),
    initialFocus: 'inputs',
  } satisfies ScreenSpec;
};

export default Screen;
