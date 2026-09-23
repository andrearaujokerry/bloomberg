// packages/web/src/screens/PORT/Screen.tsx — Portfolio Analytics (FUNCTIONS_TIER2.md §PORT "Screen").
//
// Four views on one code — holdings, exposure, attribution, risk — behind a tab strip, over a
// tenant-isolated book. Three things this screen never does:
//
//   * it never hides an unpriced line. A holding with no price keeps its row, its quantity and its
//     `reconStatus`, and `totals.pricedWeight` says how much of the book actually carries a price;
//   * it never fills a missing analytic with a zero. `varMonteCarlo` and `factorExposures` are
//     `null` by construction (`VAR_MC_NOT_IN_V1`, `NO_FACTOR_MODEL`) and render as reasons;
//   * it never drops the `PORT-07 FIRM ONLY` chip. Portfolio data is firm-isolated and the screen
//     says so on every view, as the CSV header does.
//
// Pure: no DOM, no state, no IO.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type { Badge, Cell, FunctionScreen, GridColumn, GridRow, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
  EM_DASH,
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

type Params = ParamsOf<'PORT'>;
type Payload = PayloadOf<'PORT'>;
type Holding = Payload['holdings'][number];

const VIEW_TABS: readonly { id: Params['view']; label: string }[] = [
  { id: 'holdings', label: 'Holdings' },
  { id: 'exposure', label: 'Exposure' },
  { id: 'attribution', label: 'Attribution' },
  { id: 'risk', label: 'Risk' },
];

/** `initialFocus` per view (§PORT: holdings / exposure / attribution / scenarios). */
const FOCUS: Readonly<Record<Params['view'], string>> = {
  holdings: 'holdings',
  exposure: 'exposure',
  attribution: 'attribution',
  risk: 'scenarios',
};

function holdingsGrid(p: Payload): Node {
  const columns: GridColumn[] = [
    { id: 'key', label: 'Security', align: 'left', sortable: true },
    { id: 'name', label: 'Name', align: 'left', sortable: true },
    { id: 'qty', label: 'Qty', align: 'right', fmt: 'shares', decimals: 0 },
    { id: 'cost', label: 'Cost', align: 'right', fmt: 'px' },
    { id: 'px', label: 'Last', align: 'right', fieldId: 'PX_LAST', fmt: 'px', live: true },
    { id: 'ccy', label: 'Ccy', align: 'left', fieldId: 'CRNCY' },
    { id: 'fx', label: 'FX', align: 'right', fieldId: 'FX_USD', fmt: 'px', decimals: 4 },
    { id: 'mv', label: 'Mkt value', align: 'right', fieldId: 'PORT_MV', fmt: 'ccy', decimals: 2, live: true },
    { id: 'weight', label: 'Wt %', align: 'right', fieldId: 'PORT_WEIGHT', fmt: 'pct', decimals: 2, live: true },
    { id: 'benchWeight', label: 'Bench wt %', align: 'right', fmt: 'pct', decimals: 2 },
    { id: 'activeWeight', label: 'Active wt %', align: 'right', fieldId: 'PORT_ACTIVE_WEIGHT', fmt: 'pct', decimals: 2 },
    { id: 'dayPnl', label: 'Day P&L', align: 'right', fieldId: 'PORT_PNL_1D', fmt: 'ccy', decimals: 2, live: true },
    { id: 'unrealPnl', label: 'Unreal P&L', align: 'right', fieldId: 'PORT_UNREAL_PNL', fmt: 'ccy', decimals: 2 },
    { id: 'recon', label: 'Recon', align: 'left' },
  ];

  const rows: GridRow[] = p.holdings.map((h: Holding) => ({
    id: `pos:${String(h.positionId)}`,
    cells: {
      key: textCell(h.key ?? h.rawIdentifier, h.key === null ? {} : { command: `${h.key} DES` }),
      name: textCell(h.name),
      qty: countCell(h.quantity, 'shares', 0),
      cost: countCell(h.costPrice, 'px'),
      px: cell('PX_LAST', h.px),
      ccy: textCell(h.currency, { fieldId: 'CRNCY' }),
      fx: cell('FX_USD', h.fxRate, { fmt: 'px', decimals: 4 }),
      mv: cell('PORT_MV', h.marketValue, { fmt: 'ccy', decimals: 2 }),
      weight: cell('PORT_WEIGHT', h.weight, { fmt: 'pct', decimals: 2 }),
      benchWeight: countCell(h.benchWeight, 'pct', 2),
      activeWeight: numCell('PORT_ACTIVE_WEIGHT', h.activeWeight, h.provIdx, { fmt: 'pct', decimals: 2 }),
      dayPnl: cell('PORT_PNL_1D', h.dayPnl, { fmt: 'ccy', decimals: 2, signed: true }),
      unrealPnl: cell('PORT_UNREAL_PNL', h.unrealisedPnl, { fmt: 'ccy', decimals: 2, signed: true }),
      recon: textCell(h.reconStatus),
    },
    group: h.isCash ? 'Cash' : (h.gicsSector ?? 'Unclassified'),
    ...(h.instrumentId === null ? {} : { instrumentId: h.instrumentId }),
    ...(h.subject === null ? {} : { subject: h.subject }),
    ...(h.key === null ? {} : { command: `${h.key} DES` }),
    tone: h.reconStatus === 'ok' ? 'normal' : 'muted',
  }));

  return {
    kind: 'grid',
    id: 'holdings',
    columns,
    rows,
    frozenColumns: 2,
    groupBy: 'gicsSector',
    selectable: true,
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    emptyText: 'No positions stored for this portfolio at this as-of date.',
  };
}

function totalsKv(p: Payload): Node {
  const t = p.totals;
  return {
    kind: 'kv',
    id: 'totals',
    title: 'Totals',
    columns: 3,
    rows: [
      kvRow('Market value', cell('PORT_MV', t.marketValue, { fmt: 'ccy', decimals: 2 })),
      kvRow('Day P&L', cell('PORT_PNL_1D', t.dayPnl, { fmt: 'ccy', decimals: 2, signed: true })),
      kvRow('Unrealised P&L', cell('PORT_UNREAL_PNL', t.unrealisedPnl, { fmt: 'ccy', decimals: 2, signed: true })),
      kvRow('Cost basis', countCell(t.costBasis, 'ccy', 2)),
      kvRow('Gross', countCell(t.grossMv, 'ccy', 2)),
      kvRow('Net', countCell(t.netMv, 'ccy', 2)),
      kvRow('Long', countCell(t.longMv, 'ccy', 2)),
      kvRow('Short', countCell(t.shortMv, 'ccy', 2)),
      kvRow('Cash', countCell(t.cash, 'ccy', 2)),
      kvRow('Accrued', countCell(t.accrued, 'ccy', 2)),
      kvRow('Priced', countCell(t.pricedWeight, 'pct', 2)),
    ],
  };
}

function exposureNodes(p: Payload): Node[] {
  const e = p.exposure;
  const grid: Node = {
    kind: 'grid',
    id: 'exposure',
    columns: [
      { id: 'group', label: 'Group', align: 'left' },
      { id: 'mv', label: 'Mkt value', align: 'right', fieldId: 'PORT_MV', fmt: 'ccy', decimals: 2 },
      { id: 'weight', label: 'Weight %', align: 'right', fieldId: 'PORT_WEIGHT', fmt: 'pct', decimals: 2 },
      { id: 'benchWeight', label: 'Bench wt %', align: 'right', fmt: 'pct', decimals: 2 },
      { id: 'activeWeight', label: 'Active wt %', align: 'right', fieldId: 'PORT_ACTIVE_WEIGHT', fmt: 'pct', decimals: 2 },
      { id: 'count', label: 'n', align: 'right', fmt: 'int' },
    ],
    rows: (e?.rows ?? []).map((r) => ({
      id: `exp:${r.key}`,
      cells: {
        group: textCell(r.label),
        mv: countCell(r.marketValue, 'ccy', 2),
        weight: countCell(r.weight, 'pct', 2),
        benchWeight: countCell(r.benchWeight, 'pct', 2),
        activeWeight: countCell(r.activeWeight, 'pct', 2),
        count: countCell(r.count),
      },
    })),
    emptyText: 'Exposure is computed for the exposure view only — press 2.',
  };

  const currency: Node = {
    kind: 'table',
    id: 'currency',
    caption: 'Currency exposure',
    columns: [
      { id: 'ccy', label: 'Ccy', type: 'string' },
      { id: 'mv', label: 'Mkt value', type: 'number', decimals: 2 },
      { id: 'weight', label: 'Weight %', type: 'number', decimals: 2 },
      { id: 'fx', label: 'FX rate', type: 'number', decimals: 6 },
      { id: 'fxDate', label: 'FX date', type: 'date' },
    ],
    rows: (e?.currency ?? []).map((c) => [
      textCell(c.ccy, { fieldId: 'CRNCY' }),
      countCell(c.marketValue, 'ccy', 2),
      countCell(c.weight, 'pct', 2),
      cell('FX_USD', c.fxRate, { fmt: 'px', decimals: 6 }),
      textCell(c.fxDate, { fmt: 'date' }),
    ]),
  };

  return [grid, currency];
}

function attributionNodes(p: Payload): Node[] {
  const a = p.attribution;
  const bp = (v: number | null): Cell => countCell(v === null ? null : v * 10_000, 'bp', 1);

  const rows: GridRow[] = (a?.rows ?? []).map((r) => ({
    id: `attr:${r.key}`,
    cells: {
      sector: textCell(r.label),
      wP: countCell(r.portWeight, 'pct', 2),
      wB: countCell(r.benchWeight, 'pct', 2),
      rP: countCell(r.portReturn, 'pct', 2),
      rB: countCell(r.benchReturn, 'pct', 2),
      alloc: bp(r.allocation),
      sel: bp(r.selection),
      inter: bp(r.interaction),
      total: bp(r.total),
    },
  }));

  if (a !== null) {
    rows.push({
      id: 'attr:_total',
      cells: {
        sector: textCell('TOTAL'),
        wP: countCell(null, 'pct', 2),
        wB: countCell(null, 'pct', 2),
        rP: countCell(a.total.portReturn, 'pct', 2),
        rB: countCell(a.total.benchReturn, 'pct', 2),
        alloc: bp(a.total.allocation),
        sel: bp(a.total.selection),
        inter: bp(a.total.interaction),
        total: bp(a.total.active),
      },
      tone: 'highlight',
    });
    if (a.unattributed !== null) {
      rows.push({
        id: 'attr:_unattributed',
        cells: {
          sector: textCell(`Unattributed (${a.unattributed.reason})`),
          wP: countCell(a.unattributed.weight, 'pct', 2),
          wB: countCell(null, 'pct', 2),
          rP: countCell(null, 'pct', 2),
          rB: countCell(null, 'pct', 2),
          alloc: countCell(null, 'bp', 1),
          sel: countCell(null, 'bp', 1),
          inter: countCell(null, 'bp', 1),
          total: bp(a.unattributed.total),
        },
        tone: 'muted',
      });
    }
  }

  const grid: Node = {
    kind: 'grid',
    id: 'attribution',
    columns: [
      { id: 'sector', label: 'Sector', align: 'left' },
      { id: 'wP', label: 'wP %', align: 'right', fmt: 'pct', decimals: 2 },
      { id: 'wB', label: 'wB %', align: 'right', fmt: 'pct', decimals: 2 },
      { id: 'rP', label: 'rP %', align: 'right', fmt: 'pct', decimals: 2 },
      { id: 'rB', label: 'rB %', align: 'right', fmt: 'pct', decimals: 2 },
      { id: 'alloc', label: 'Alloc bp', align: 'right', fmt: 'bp', decimals: 1 },
      { id: 'sel', label: 'Sel bp', align: 'right', fmt: 'bp', decimals: 1 },
      { id: 'inter', label: 'Inter bp', align: 'right', fmt: 'bp', decimals: 1 },
      { id: 'total', label: 'Total bp', align: 'right', fmt: 'bp', decimals: 1 },
    ],
    rows,
    frozenColumns: 1,
    selectable: true,
    emptyText: 'Attribution is computed for the attribution view only — press 3.',
  };

  const period: Node = {
    kind: 'text',
    id: 'attr-period',
    tone: 'muted',
    text:
      a === null
        ? 'No attribution in this payload.'
        : `${a.method} · ${a.groupBy} · ${a.period.from} … ${a.period.to} (${String(a.period.sessions)} sessions) · ${a.engine.name}@${a.engine.version}`,
  };

  return [grid, period];
}

function riskNodes(p: Payload): Node[] {
  const r = p.risk;
  const riskKv: Node = {
    kind: 'kv',
    id: 'risk',
    title: 'Risk',
    columns: 3,
    rows: [
      kvRow('Vol %', countCell(r?.volPct ?? null, 'pct', 2)),
      kvRow('Bench vol %', countCell(r?.benchVolPct ?? null, 'pct', 2)),
      kvRow('Tracking error %', countCell(r?.trackingErrorPct ?? null, 'pct', 2)),
      kvRow('Beta', numCell('PORT_BETA', r?.beta ?? null, -1, { fmt: 'px', decimals: 3 })),
      kvRow('Corr', countCell(r?.corr ?? null, 'px', 3)),
      kvRow('R²', countCell(r?.r2 ?? null, 'px', 3)),
      kvRow('Sharpe', countCell(r?.sharpe ?? null, 'px', 2)),
      kvRow('Information ratio', countCell(r?.informationRatio ?? null, 'px', 2)),
      kvRow('Max drawdown %', countCell(r?.maxDrawdownPct ?? null, 'pct', 2)),
      kvRow(
        `VaR ${r === null ? '' : `${r.var.method}/${String(r.var.confidence)}`} 1d %`,
        numCell('PORT_VAR', r?.var.valuePct ?? null, -1, { fmt: 'pct', decimals: 2 }),
      ),
      kvRow('VaR 1d (ccy)', countCell(r?.var.valueCcy ?? null, 'ccy', 2)),
      kvRow(
        'VaR backtest',
        textCell(
          r?.var.backtest === null || r?.var.backtest === undefined
            ? null
            : `${String(r.var.backtest.exceptions)} exceptions / ${r.var.backtest.expected.toFixed(1)} expected over ${String(r.var.backtest.windowSessions)} sessions`,
        ),
      ),
      kvRow('Monte-Carlo VaR', textCell(EM_DASH)),
      kvRow('Factor exposures', textCell(EM_DASH)),
    ],
  };

  const scenarios: Node = {
    kind: 'grid',
    id: 'scenarios',
    columns: [
      { id: 'id', label: 'Id', align: 'left' },
      { id: 'label', label: 'Scenario', align: 'left' },
      { id: 'method', label: 'Method', align: 'left' },
      { id: 'detail', label: 'Detail', align: 'left', width: 60 },
      { id: 'pnlCcy', label: 'P&L', align: 'right', fmt: 'ccy', decimals: 2 },
      { id: 'pnlPct', label: 'P&L %', align: 'right', fmt: 'pct', decimals: 2 },
      { id: 'reason', label: 'Reason', align: 'left' },
    ],
    rows: (r?.scenarios ?? []).map((s) => ({
      id: `scn:${s.id}`,
      cells: {
        id: textCell(s.id),
        label: textCell(s.label),
        method: textCell(s.method),
        detail: textCell(s.detail),
        pnlCcy: countCell(s.pnlCcy, 'ccy', 2),
        pnlPct: countCell(s.pnlPct, 'pct', 2),
        reason: textCell(s.unavailableReason ?? ''),
      },
      tone: s.unavailableReason === null ? 'normal' : 'muted',
    })),
    emptyText: 'Scenarios are computed for the risk view only — press 4.',
  };

  return [riskKv, scenarios];
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta }) => {
  if (payload === undefined) {
    return {
      title: 'PORT · Portfolio Analytics',
      subtitle: 'loading…',
      body: stack('col', [
        {
          kind: 'tabs',
          id: 'view',
          active: params.view,
          tabs: VIEW_TABS.map((t, i) => ({
            id: t.id,
            label: t.label,
            key: String(i + 1),
            body: { kind: 'text' as const, id: `tab-${t.id}`, text: 'loading…', tone: 'muted' as const },
          })),
        },
        {
          kind: 'kv',
          id: 'totals',
          columns: 3,
          rows: [
            kvRow('Market value', textCell(null)),
            kvRow('Day P&L', textCell(null)),
            kvRow('Unrealised P&L', textCell(null)),
            kvRow('Gross', textCell(null)),
            kvRow('Net', textCell(null)),
            kvRow('Cash', textCell(null)),
          ],
        },
        {
          kind: 'grid',
          id: 'holdings',
          columns: [
            { id: 'key', label: 'Security', align: 'left' },
            { id: 'name', label: 'Name', align: 'left' },
            { id: 'qty', label: 'Qty', align: 'right' },
          ],
          rows: Array.from({ length: 12 }, (_v, i) => ({
            id: `skeleton:${String(i)}`,
            cells: { key: textCell(null), name: textCell(null) },
            tone: 'muted' as const,
          })),
          emptyText: 'loading…',
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'holdings',
    } satisfies ScreenSpec;
  }

  const pf = payload.portfolio;
  const mode: Badge[] = [
    { text: `bench ${pf.benchmark?.key ?? EM_DASH}`, tone: 'info', title: pf.benchmark?.name ?? 'No benchmark set for this portfolio.' },
    { text: `as-of ${pf.asOfDate}`, tone: 'info' },
    { text: `GRP ${params.groupBy}`, tone: 'info' },
    {
      text: 'PORT-07 FIRM ONLY',
      tone: 'blocked',
      title: payload.confidentiality.note,
    },
    ...stalenessBadges(meta),
  ];

  const reasons: Badge[] = [
    { text: 'VAR_MC_NOT_IN_V1', tone: 'warn', title: 'Monte-Carlo VaR is not computed in v1; historical and parametric are.' },
    { text: 'NO_FACTOR_MODEL', tone: 'warn', title: 'No factor model is licensed in the wedge, so factor exposures are unavailable.' },
  ];
  for (const note of payload.notes) reasons.push({ text: note, tone: 'warn' });
  reasons.push(...entitlementBadges(meta), ...unavailableBadges(meta));

  const recon: Node = {
    kind: 'text',
    id: 'recon',
    tone: payload.recon.rowsError > 0 ? 'warn' : 'muted',
    text: `import ${payload.recon.importId === null ? '—' : String(payload.recon.importId)} · ${String(payload.recon.rowsTotal)} rows · ${String(payload.recon.rowsOk)} ok · ${String(payload.recon.rowsError)} error · matched ${String(payload.recon.matched)} / added ${String(payload.recon.added)} / removed ${String(payload.recon.removed)}${payload.recon.errors.length === 0 ? '' : ` · ${payload.recon.errors.map((e) => `row ${String(e.row)} ${e.identifier}: ${e.reason}`).join(' · ')}`}`,
  };

  const bodyOf = (view: Params['view']): Node => {
    switch (view) {
      case 'holdings':
        return stack('col', [totalsKv(payload), holdingsGrid(payload), recon], [0.24, 0.66, 0.1]);
      case 'exposure':
        return stack('col', exposureNodes(payload), [0.6, 0.4]);
      case 'attribution':
        return stack('col', attributionNodes(payload), [0.9, 0.1]);
      case 'risk':
        return stack('col', riskNodes(payload), [0.45, 0.55]);
    }
  };

  const tabs: Node = {
    kind: 'tabs',
    id: 'view',
    active: payload.view,
    tabs: VIEW_TABS.map((t, i) => ({
      id: t.id,
      label: t.label,
      key: String(i + 1),
      body:
        t.id === payload.view
          ? bodyOf(t.id)
          : { kind: 'text' as const, id: `tab-${t.id}`, text: `Press ${String(i + 1)} for ${t.label}.`, tone: 'muted' as const },
    })),
  };

  return {
    title: `PORT · ${pf.name} · ${pf.asOfDate} · ${pf.baseCurrency}`,
    subtitle: `${payload.view} · bench ${pf.benchmark?.key ?? EM_DASH} · ${String(payload.risk?.lookbackDays ?? params.lookbackDays)} sessions`,
    body: stack(
      'col',
      [
        { kind: 'badges', id: 'mode', items: mode },
        { kind: 'badges', id: 'reason', items: reasons },
        tabs,
      ],
      [0.06, 0.06, 0.88],
    ),
    footer: footer(meta, [payload.confidentiality.note, ...payload.notes]),
    initialFocus: FOCUS[payload.view],
  } satisfies ScreenSpec;
};

export default Screen;
