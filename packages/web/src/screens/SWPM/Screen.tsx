// packages/web/src/screens/SWPM/Screen.tsx — Swap Manager (FUNCTIONS_TIER3 §SWPM "Screen").
//
// One USD SOFR overnight-index swap: the trade, the conventions it is built on, the two schedules,
// the valuation and the key-rate risk.
//
// **`kv#conventions` is restated on screen rather than left implicit.** Annual ACT/360 both legs,
// daily-compounded SOFR, no observation shift, a two-business-day payment lag, T+2 spot, modified
// following on SIFMA, single-curve OIS discounting. A swap price is only checkable against the
// conventions it was made on, so they are on the page a reader is reading the price from.
//
// **`PROXY_CURVE` and `NO_OIS_SWAP_QUOTES_SOURCE` are on every payload and every screen.** The
// valuation is complete — nothing is blanked — but the term points are built from the SOFR fixing,
// realised SOFR averages, bills and Treasury par yields, and the reader is told so rather than left
// to assume a quoted swap curve.
//
// The float leg's DV01 arrives `na`: the engine exposes the fixed leg's annuity PV01 and no per-leg
// curve reprice, and a number arrived at by subtraction in a screen would be a second model. The
// cell carries its reason instead.
//
// Pure: no DOM, no state, no IO.

import type { FieldId, ParamsOf, PayloadOf } from '@terminal/core';

import type {
  Badge,
  Cell,
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

type Params = ParamsOf<'SWPM'>;
type Payload = PayloadOf<'SWPM'>;
type Leg = Payload['legs'][number];
type Period = Leg['periods'][number];

const KRD_FIELDS: Readonly<Record<string, FieldId>> = {
  '2Y': 'KRD_2Y',
  '5Y': 'KRD_5Y',
  '10Y': 'KRD_10Y',
  '30Y': 'KRD_30Y',
};

const CAVEAT_TITLES: Readonly<Record<string, string>> = {
  PROXY_CURVE:
    'SOFR OIS term points are proxied (SOFR averages, bills, UST par); no OIS swap or futures source (BRIEF §2).',
  NO_OIS_SWAP_QUOTES_SOURCE: 'There is no OIS swap quote source in this build.',
};

function tradeForm(p: Payload, params: Params, setParams: (patch: Partial<Params>) => void): Node {
  const t = p.trade;
  const fields: FormField[] = [
    { id: 'side', label: 'Side (fixed)', type: 'enum', value: t.side, values: ['pay', 'receive'] },
    { id: 'notional', label: 'Notional', type: 'number', value: t.notional, step: 1_000_000, bigStep: 10_000_000, unit: t.currency },
    { id: 'tenor', label: 'Tenor', type: 'enum', value: t.tenor, values: ['1Y', '2Y', '3Y', '4Y', '5Y', '7Y', '10Y', '15Y', '20Y', '30Y'] },
    { id: 'fixedRate', label: `Fixed % (${t.fixedRateSource})`, type: 'number', value: params.fixedRate, step: 0.01, bigStep: 0.1, unit: '%' },
    { id: 'effective', label: 'Effective', type: 'date', value: t.effective },
    { id: 'maturity', label: 'Maturity', type: 'date', value: t.maturity },
    { id: 'curveDate', label: 'Curve date', type: 'date', value: p.curve.date },
    {
      id: 'interpolation',
      label: 'Interpolation',
      type: 'enum',
      value: params.interpolation,
      values: ['linear_zero', 'log_linear_df', 'monotone_convex'],
    },
  ];

  return {
    kind: 'form',
    id: 'trade',
    fields,
    submitLabel: 'Reprice',
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
      // A blank fixed rate is the instruction "solve par", so `null` is passed through as typed.
      const patch: Partial<Params> = {
        fixedRate: num('fixedRate'),
        effective: text('effective'),
        maturity: text('maturity'),
        curveDate: text('curveDate'),
      };
      const notional = num('notional');
      if (notional !== null) patch.notional = notional;
      const side = text('side');
      if (side !== null) patch.side = side as Params['side'];
      const tenor = text('tenor');
      if (tenor !== null) patch.tenor = tenor as Params['tenor'];
      const interpolation = text('interpolation');
      if (interpolation !== null) patch.interpolation = interpolation as Params['interpolation'];
      setParams(patch);
    },
  };
}

function resultsKv(p: Payload): Node {
  const r = p.results;
  const rows = [
    kvRow('Par rate', cell('SWAP_PAR_RATE', r.parRatePct, { fmt: 'pct', decimals: 4 })),
    kvRow('Fixed rate', cell('SWAP_FIXED_RATE', r.fixedRatePct, { fmt: 'pct', decimals: 4 })),
    kvRow('NPV', cell('SWAP_NPV', r.npv, { fmt: 'ccy', decimals: 2, signed: true })),
    kvRow('MV % notional', computedCell(r.marketValuePctNotional, 'pct', 4)),
    kvRow('PV fixed', computedCell(r.pvFixed, 'ccy', 2)),
    kvRow('PV float', computedCell(r.pvFloat, 'ccy', 2)),
    kvRow('Annuity PV01', cell('SWAP_PV01', r.annuityPv01, { fmt: 'ccy', decimals: 2 })),
    kvRow('DV01 (+1 bp)', cell('DV01', r.dv01, { fmt: 'ccy', decimals: 2, signed: true })),
    kvRow('DV01 / 1mm', computedCell(r.dv01Per1mm, 'ccy', 2)),
    kvRow('Effective duration', computedCell(r.effectiveDurationYears, 'px', 3)),
    kvRow('Accrued', cell('SWAP_ACCRUED', r.accrued, { fmt: 'ccy', decimals: 2 })),
    kvRow('Break-even rate', computedCell(r.breakEvenRatePct, 'pct', 4)),
  ];
  if (r.spreads !== null) {
    rows.push(
      kvRow(`UST ${r.spreads.treasuryTenor}`, cell('YLD_YTM_MID', r.spreads.treasuryYieldPct, { fmt: 'pct', decimals: 3 })),
      kvRow('Swap spread', cell('SPREAD', r.spreads.swapSpreadBp, { fmt: 'bp', decimals: 1, signed: true })),
    );
  }
  return { kind: 'kv', id: 'results', title: 'Valuation', columns: 2, rows };
}

function conventionsKv(p: Payload): Node {
  const c = p.conventions;
  return {
    kind: 'kv',
    id: 'conventions',
    title: 'Conventions',
    columns: 3,
    rows: [
      kvRow('Fixed leg', textCell(`${c.fixedFreq} ${c.fixedDayCount}`)),
      kvRow('Float leg', textCell(`${c.floatFreq} ${c.floatDayCount} · ${c.floatIndex}`)),
      kvRow('Compounding', textCell(c.compounding)),
      kvRow('Observation shift', countCell(c.observationShift)),
      kvRow('Payment lag', countCell(c.paymentLagDays)),
      kvRow('Business day conv', textCell(c.bdc)),
      kvRow('Calendar', textCell(c.calendarId)),
      kvRow('Spot lag', countCell(c.spotLagDays)),
      kvRow('Discounting', textCell(c.discounting)),
      kvRow('Curve', textCell(p.curve.date === null ? `${p.curve.id} (none stored)` : `${p.curve.id} ${p.curve.date}`)),
      kvRow('Build', textCell(p.curve.buildId === null ? null : String(p.curve.buildId))),
      kvRow(
        'Engine',
        textCell(p.curve.engine === null ? null : `${p.curve.engine.name}@${p.curve.engine.version} · ${p.curve.engine.inputsHash.slice(0, 8)}`),
      ),
      kvRow('SOFR fixing', cell('RATE', p.fixing.rate, { fmt: 'pct', decimals: 4 })),
      kvRow('Fixing date', textCell(p.fixing.effectiveDate, { fmt: 'date' })),
      kvRow('Used for realised', textCell(p.fixing.usedForRealised ? 'yes' : 'no (spot/forward-starting swap)')),
    ],
  };
}

function scheduleGrid(leg: Leg, id: string, withSplit: boolean): Node {
  const columns: GridColumn[] = [
    { id: 'n', label: '#', align: 'right', fmt: 'int' },
    { id: 'start', label: 'Start', align: 'left', fmt: 'date' },
    { id: 'end', label: 'End', align: 'left', fmt: 'date' },
    { id: 'paymentDate', label: 'Pay date', align: 'left', fmt: 'date' },
    { id: 'days', label: 'Days', align: 'right', fmt: 'int' },
    { id: 'accrualFactor', label: 'Acc factor', align: 'right', fmt: 'px', decimals: 6 },
    { id: 'rate', label: 'Rate %', align: 'right', fmt: 'pct', decimals: 4 },
    { id: 'cashflow', label: 'Cashflow', align: 'right', fmt: 'ccy', decimals: 2 },
    { id: 'df', label: 'DF', align: 'right', fmt: 'px', decimals: 6 },
    { id: 'pv', label: 'PV', align: 'right', fmt: 'ccy', decimals: 2 },
  ];
  if (withSplit) {
    columns.splice(6, 0, { id: 'realisedDays', label: 'Realised d', align: 'right', fmt: 'int' }, { id: 'projectedDays', label: 'Projected d', align: 'right', fmt: 'int' });
  }

  const rateField: FieldId = leg.kind === 'fixed' ? 'SWAP_FIXED_RATE' : 'RATE';
  const rows: GridRow[] = leg.periods.map((p: Period): GridRow => {
    const cells: Record<string, Cell> = {
      n: countCell(p.n),
      start: textCell(p.start, { fmt: 'date' }),
      end: textCell(p.end, { fmt: 'date' }),
      paymentDate: textCell(p.paymentDate, { fmt: 'date' }),
      days: countCell(p.days),
      accrualFactor: countCell(p.accrualFactor, 'px', 6),
      rate: cell(rateField, p.rate, { fmt: 'pct', decimals: 4 }),
      cashflow: computedCell(p.cashflow, 'ccy', 2),
      df: computedCell(
        p.df === null ? { v: null, st: 'na', provIdx: -1 } : { v: p.df, st: 'closed', provIdx: p.pv.provIdx },
        'px',
        6,
      ),
      pv: computedCell(p.pv, 'ccy', 2),
    };
    if (withSplit) {
      cells.realisedDays = countCell(p.realisedDays);
      cells.projectedDays = countCell(p.projectedDays);
    }
    return { id: `${id}:${String(p.n)}`, cells, tone: p.isCurrent ? 'highlight' : 'normal' };
  });

  return {
    kind: 'grid',
    id,
    columns,
    rows,
    frozenColumns: 1,
    selectable: true,
    emptyText: 'No schedule: the curve this swap prices on is not stored.',
  };
}

function legSummary(leg: Leg, id: string): Node {
  return {
    kind: 'kv',
    id,
    title: `${leg.kind} leg (${leg.payReceive})`,
    columns: 3,
    rows: [
      kvRow('PV', computedCell(leg.pv, 'ccy', 2)),
      kvRow('Accrued', cell('SWAP_ACCRUED', leg.accrued, { fmt: 'ccy', decimals: 2 })),
      kvRow('DV01', cell('DV01', leg.dv01, { fmt: 'ccy', decimals: 2 })),
      kvRow('Next payment', textCell(leg.nextPaymentDate, { fmt: 'date' })),
      kvRow('Next cashflow', computedCell(leg.nextCashflow, 'ccy', 2)),
    ],
  };
}

function riskGrid(p: Payload): Node {
  const total = p.results.keyRateDurations.reduce((acc, k) => acc + Math.abs(k.dv01), 0);
  const rows: GridRow[] = p.results.keyRateDurations.map((k): GridRow => ({
    id: `krd:${k.tenor}`,
    cells: {
      tenor: textCell(k.tenor),
      krd: numCell(KRD_FIELDS[k.tenor] ?? 'DV01', k.krd, p.curve.provIdx, { fmt: 'px', decimals: 4 }),
      dv01: numCell('DV01', k.dv01, p.curve.provIdx, { fmt: 'ccy', decimals: 2 }),
      share: countCell(total === 0 ? null : (Math.abs(k.dv01) / total) * 100, 'pct', 1),
    },
  }));
  return {
    kind: 'grid',
    id: 'risk',
    columns: [
      { id: 'tenor', label: 'Tenor', align: 'left' },
      { id: 'krd', label: 'KRD (yrs)', align: 'right', fmt: 'px', decimals: 4 },
      { id: 'dv01', label: 'DV01', align: 'right', fieldId: 'DV01', fmt: 'ccy', decimals: 2 },
      { id: 'share', label: 'Share %', align: 'right', fmt: 'pct', decimals: 1 },
    ],
    rows,
    frozenColumns: 1,
    selectable: true,
    emptyText: 'No key-rate risk: the curve this swap prices on is not stored.',
  };
}

function krdTable(p: Payload): Node {
  return {
    kind: 'table',
    id: 'krd',
    caption: 'Key-rate durations (years) and DV01 per 1 bp bump of the zero curve',
    columns: [
      { id: 'tenor', label: 'Tenor', type: 'string' },
      { id: 'krd', label: 'KRD (yrs)', type: 'number', decimals: 4 },
      { id: 'dv01', label: 'DV01', type: 'number', decimals: 2 },
    ],
    rows: p.results.keyRateDurations.map((k): Cell[] => [
      textCell(k.tenor),
      numCell(KRD_FIELDS[k.tenor] ?? 'DV01', k.krd, p.curve.provIdx, { fmt: 'px', decimals: 4 }),
      numCell('DV01', k.dv01, p.curve.provIdx, { fmt: 'ccy', decimals: 2 }),
    ]),
  };
}

function caveatBadges(p: Payload, meta: Parameters<typeof footer>[0]): Badge[] {
  const badges: Badge[] = p.curve.caveats.map((c) => ({ text: c, tone: 'warn' as const, title: CAVEAT_TITLES[c] ?? c }));
  badges.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));
  return badges;
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta, ctx }) => {
  if (payload === undefined) {
    return {
      title: `SWPM · USD SOFR OIS · ${params.tenor} · ${params.side} fixed`,
      subtitle: 'loading…',
      body: stack(
        'col',
        [
          {
            kind: 'form',
            id: 'trade',
            fields: [
              { id: 'side', label: 'Side (fixed)', type: 'enum', value: params.side, values: ['pay', 'receive'] },
              { id: 'notional', label: 'Notional', type: 'number', value: params.notional },
              { id: 'tenor', label: 'Tenor', type: 'enum', value: params.tenor, values: ['1Y', '2Y', '3Y', '4Y', '5Y', '7Y', '10Y', '15Y', '20Y', '30Y'] },
            ],
            submitLabel: 'Reprice',
            onSubmit: (): void => undefined,
          },
          {
            kind: 'kv',
            id: 'results',
            title: 'Valuation',
            columns: 2,
            rows: [
              kvRow('Par rate', textCell(null)),
              kvRow('NPV', textCell(null)),
              kvRow('Annuity PV01', textCell(null)),
              kvRow('DV01 (+1 bp)', textCell(null)),
            ],
          },
          {
            kind: 'grid',
            id: 'fixed',
            columns: [{ id: 'n', label: '#', align: 'right' }],
            rows: Array.from({ length: 10 }, (_v, i) => ({
              id: `fixed-skeleton:${String(i)}`,
              cells: { n: textCell(null) },
              tone: 'muted' as const,
            })),
            emptyText: 'loading…',
          },
        ],
        [0.32, 0.38, 0.3],
      ),
      footer: footer(undefined),
      initialFocus: 'trade',
    } satisfies ScreenSpec;
  }

  const fixed = payload.legs.find((l) => l.kind === 'fixed');
  const float = payload.legs.find((l) => l.kind === 'float');

  const tabs: Node = {
    kind: 'tabs',
    id: 'view',
    active: params.view,
    tabs: [
      { id: 'summary', label: 'Summary', key: '1', body: krdTable(payload) },
      {
        id: 'fixed',
        label: 'Fixed leg',
        key: '2',
        body:
          fixed === undefined
            ? { kind: 'text', id: 'fixed', tone: 'warn', text: 'No fixed leg in this payload.' }
            : stack('col', [legSummary(fixed, 'fixedSummary'), scheduleGrid(fixed, 'fixed', false)], [0.25, 0.75]),
      },
      {
        id: 'float',
        label: 'Float leg',
        key: '3',
        body:
          float === undefined
            ? { kind: 'text', id: 'float', tone: 'warn', text: 'No floating leg in this payload.' }
            : stack('col', [legSummary(float, 'floatSummary'), scheduleGrid(float, 'float', true)], [0.25, 0.75]),
      },
      { id: 'risk', label: 'Risk', key: '4', body: riskGrid(payload) },
    ],
    onChange: (id): void => {
      ctx.setParams({ view: id as Params['view'] });
    },
  };

  return {
    title: `SWPM · USD SOFR OIS · ${payload.trade.tenor} · ${payload.trade.side} fixed`,
    subtitle: `effective ${payload.trade.effective} · maturity ${payload.trade.maturity} · notional ${String(payload.trade.notional)} ${payload.trade.currency} · curve ${payload.curve.id} ${payload.curve.date ?? '—'} · ${payload.curve.interpolation ?? '—'}`,
    body: stack(
      'col',
      [
        { kind: 'badges', id: 'caveats', items: caveatBadges(payload, meta) },
        stack(
          'row',
          [
            tradeForm(payload, params, (patch) => {
              ctx.setParams(patch);
            }),
            resultsKv(payload),
          ],
          [0.32, 0.68],
        ),
        conventionsKv(payload),
        tabs,
      ],
      [0.06, 0.32, 0.18, 0.44],
    ),
    footer: footer(meta, [
      `engines: ${payload.engines.map((e) => `${e.name}@${e.version}`).join(' · ')}`,
      ...payload.curve.caveats,
    ]),
    initialFocus: 'trade',
  } satisfies ScreenSpec;
};

export default Screen;
