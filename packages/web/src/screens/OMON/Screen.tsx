// packages/web/src/screens/OMON/Screen.tsx — Option Monitor (FUNCTIONS_TIER3 §OMON "Screen").
//
// The listed chain for one expiry as the exchange publishes it: calls on the left, puts on the
// right, strikes down the middle, with Cboe's own implied volatility and greeks.
//
// **OMON is a monitor of the exchange's marks, not a pricer**, and the screen says so without being
// asked: `PROVIDER_GREEKS_CBOE` is a constant badge, the column headers name Cboe, and the only
// four numbers OMON computes itself — the mid, the two put/call ratios and the ATM strike — are the
// only ones cited to anything other than the `cboe.options` capture. A reader comparing this delta
// with OVML's must be able to see which is which.
//
// `ivSuspect` is carried to the cell, not dropped: a deep in- or out-of-the-money implied volatility
// is shown with its warning rather than hidden, because hiding it would leave a hole with no reason.
//
// The smile is a `custom#smile` node declaring its scatter points, its SVI fit and its reference
// lines. Nothing is drawn here.
//
// Pure: no DOM, no state, no IO.

import type { FieldId, ParamsOf, PayloadOf, ValueCell } from '@terminal/core';

import type {
  Badge,
  Cell,
  ChartSeries,
  ChartSpec,
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
  quoteHeader,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'OMON'>;
type Payload = PayloadOf<'OMON'>;
type Leg = NonNullable<Payload['rows'][number]['call']>;
type OmonColumn = Params['columns'][number];

interface LegColumnDef {
  label: string;
  fieldId?: FieldId;
  fmt: NonNullable<Cell['fmt']>;
  decimals: number;
  /** OMON's own number rather than a Cboe-published one. */
  derived?: true;
  pick: (leg: Leg) => ValueCell;
}

/** The leg column catalogue. Every entry but `mid` is a number Cboe published. */
const LEG_COLUMNS: Readonly<Record<OmonColumn, LegColumnDef>> = {
  bid: { label: 'Bid', fieldId: 'PX_BID', fmt: 'px', decimals: 2, pick: (l) => l.bid },
  ask: { label: 'Ask', fieldId: 'PX_ASK', fmt: 'px', decimals: 2, pick: (l) => l.ask },
  mid: { label: 'Mid*', fmt: 'px', decimals: 4, derived: true, pick: (l) => l.mid },
  last: { label: 'Last', fieldId: 'PX_LAST', fmt: 'px', decimals: 2, pick: (l) => l.last },
  chg: { label: 'Chg', fieldId: 'CHG_NET_1D', fmt: 'px', decimals: 2, pick: (l) => l.chg },
  volume: { label: 'Vol', fieldId: 'PX_VOLUME', fmt: 'int', decimals: 0, pick: (l) => l.volume },
  oi: { label: 'OI', fieldId: 'OPT_OI', fmt: 'int', decimals: 0, pick: (l) => l.openInterest },
  iv: { label: 'IV %', fieldId: 'OPT_IV', fmt: 'pct', decimals: 2, pick: (l) => l.ivPct },
  delta: { label: 'Delta', fieldId: 'OPT_DELTA', fmt: 'px', decimals: 4, pick: (l) => l.delta },
  gamma: { label: 'Gamma', fieldId: 'OPT_GAMMA', fmt: 'px', decimals: 4, pick: (l) => l.gamma },
  vega: { label: 'Vega', fieldId: 'OPT_VEGA', fmt: 'px', decimals: 4, pick: (l) => l.vega },
  theta: { label: 'Theta', fieldId: 'OPT_THETA', fmt: 'px', decimals: 4, pick: (l) => l.theta },
  rho: { label: 'Rho', fieldId: 'OPT_RHO', fmt: 'px', decimals: 4, pick: (l) => l.rho },
  theo: { label: 'Theo', fieldId: 'OPT_THEO', fmt: 'px', decimals: 4, pick: (l) => l.theo },
};

const CAVEAT_TITLES: Readonly<Record<string, string>> = {
  DELAYED_15MIN: 'Cboe delayed chain: quotes are fifteen minutes behind the exchange.',
  PROVIDER_GREEKS_CBOE:
    'Every implied volatility and greek on this screen is the number Cboe publishes; OMON re-derives none of them.',
  NO_OPRA_DEPTH: 'There is no OPRA feed, so size is Cboe top of book only.',
  DEEP_ITM_IV_UNRELIABLE: 'A near-zero vega makes a deep in- or out-of-the-money implied volatility meaningless.',
  SURFACE_NOT_STORED: 'No stored volatility surface: the smile shown is fitted on the fly.',
};

function legCell(def: LegColumnDef, leg: Leg | null): Cell {
  if (leg === null) return textCell(null);
  const vc = def.pick(leg);
  if (def.derived === true) return computedCell(vc, def.fmt, def.decimals);
  return cell(def.fieldId ?? 'PX_LAST', vc, { fmt: def.fmt, decimals: def.decimals });
}

function chainGrid(p: Payload, columns: readonly OmonColumn[]): Node {
  // Calls mirror right-to-left so the strike column is the axis of the grid (TERM-11).
  const callOrder = [...columns].reverse();
  const gridColumns: GridColumn[] = [
    ...callOrder.map((id): GridColumn => {
      const def = LEG_COLUMNS[id];
      const col: GridColumn = {
        id: `c:${id}`,
        label: `C ${def.label}`,
        align: 'right',
        fmt: def.fmt,
        decimals: def.decimals,
        live: true,
      };
      if (def.fieldId !== undefined) col.fieldId = def.fieldId;
      return col;
    }),
    { id: 'strike', label: 'Strike', align: 'right', fieldId: 'OPT_STRIKE_PX', fmt: 'px', decimals: 2 },
    ...columns.map((id): GridColumn => {
      const def = LEG_COLUMNS[id];
      const col: GridColumn = {
        id: `p:${id}`,
        label: `P ${def.label}`,
        align: 'right',
        fmt: def.fmt,
        decimals: def.decimals,
        live: true,
      };
      if (def.fieldId !== undefined) col.fieldId = def.fieldId;
      return col;
    }),
  ];

  const rows: GridRow[] = p.rows.map((r): GridRow => {
    const cells: Record<string, Cell> = {
      strike: numCell('OPT_STRIKE_PX', r.strike, r.call?.provIdx ?? r.put?.provIdx ?? -1, {
        fmt: 'px',
        decimals: 2,
      }),
    };
    for (const id of columns) {
      cells[`c:${id}`] = legCell(LEG_COLUMNS[id], r.call);
      cells[`p:${id}`] = legCell(LEG_COLUMNS[id], r.put);
    }
    const row: GridRow = {
      id: `strike:${String(r.strike)}`,
      cells,
      tone: r.isAtm ? 'highlight' : 'normal',
    };
    const leg = r.call ?? r.put;
    if (leg !== null) {
      row.subject = leg.subject;
      row.command = `${leg.key} OVML`;
    }
    return row;
  });

  return {
    kind: 'grid',
    id: 'chain',
    columns: gridColumns,
    rows,
    frozenColumns: 0,
    selectable: true,
    sort: { col: 'strike', dir: p.rows.length > 1 && (p.rows[0]?.strike ?? 0) > (p.rows[1]?.strike ?? 0) ? 'desc' : 'asc' },
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    onEnter: (row: GridRow): string | null => row.command ?? null,
    onShiftEnter: (row: GridRow): string | null => row.command ?? null,
    emptyText: `No listed options for ${p.underlying.key} in the Cboe chain.`,
  };
}

/** The smile as a chart spec: the published points, the fit when there is one, and nothing drawn. */
export function omonSmileSpec(p: Payload): ChartSpec {
  const x = p.smile.points.map((pt) => pt.strike);
  const provIdx = p.underlying.provIdx;
  const series: ChartSeries[] = [
    {
      id: 'callIv',
      label: 'Call IV %',
      type: 'scatter',
      pane: 'main',
      yAxis: 'y',
      x,
      y: p.smile.points.map((pt) => pt.callIvPct ?? Number.NaN),
      provIdx,
    },
    {
      id: 'putIv',
      label: 'Put IV %',
      type: 'scatter',
      pane: 'main',
      yAxis: 'y',
      x,
      y: p.smile.points.map((pt) => pt.putIvPct ?? Number.NaN),
      provIdx,
    },
  ];
  const spot = typeof p.underlying.px.v === 'number' ? p.underlying.px.v : Number.NaN;
  const reference: NonNullable<ChartSpec['reference']> = [{ yAxis: 'y', v: spot, label: 'spot' }];
  if (p.selected.atmStrike !== null) {
    reference.push({ yAxis: 'y', v: p.selected.atmStrike, label: 'ATM' });
  }
  return {
    kind: 'curve',
    xAxis: { type: 'tenor' },
    yAxes: [{ id: 'y', side: 'left', scale: 'linear', fmt: 'pct', decimals: 2 }],
    panes: [{ id: 'main', height: 1 }],
    series,
    crosshair: true,
    reference,
  };
}

function summaryKv(p: Payload): Node {
  const s = p.selected;
  const svi = p.smile.svi;
  return {
    kind: 'kv',
    id: 'summary',
    title: 'Expiry summary',
    columns: 3,
    rows: [
      kvRow('Expiry', textCell(s.expiry, { fmt: 'date' })),
      kvRow('Expiry ts', textCell(s.expiryTs, { fmt: 'datetime' })),
      kvRow('Days', countCell(s.days)),
      kvRow('Years', countCell(s.years, 'px', 6)),
      kvRow('Contracts', countCell(s.contractCount)),
      kvRow('ATM strike*', countCell(s.atmStrike, 'px', 2)),
      kvRow('ATM IV', cell('OPT_IV', s.atmIvPct, { fmt: 'pct', decimals: 2 })),
      kvRow('P/C volume*', computedCell(s.putCallVolumeRatio, 'px', 4)),
      kvRow('P/C open interest*', computedCell(s.putCallOiRatio, 'px', 4)),
      kvRow('Call volume', cell('PX_VOLUME', s.totals.callVolume, { fmt: 'int', decimals: 0 })),
      kvRow('Put volume', cell('PX_VOLUME', s.totals.putVolume, { fmt: 'int', decimals: 0 })),
      kvRow('Call OI', cell('OPT_OI', s.totals.callOi, { fmt: 'int', decimals: 0 })),
      kvRow('Put OI', cell('OPT_OI', s.totals.putOi, { fmt: 'int', decimals: 0 })),
      kvRow(
        'SVI fit',
        textCell(
          svi === null
            ? `— ${p.smile.sviUnavailableReason ?? 'no fit'}`
            : `${p.smile.sviSource ?? 'fit'} · rmse ${svi.rmse.toFixed(4)} · n ${String(svi.n)}`,
        ),
      ),
      kvRow('Captured', textCell(p.captureTs, { fmt: 'datetime' })),
    ],
  };
}

function caveatBadges(p: Payload, meta: Parameters<typeof footer>[0]): Badge[] {
  const badges: Badge[] = p.caveats.map((c) => ({ text: c, tone: 'warn' as const, title: CAVEAT_TITLES[c] ?? c }));
  badges.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));
  return badges;
}

const sizesFor = (view: Params['view']): number[] =>
  view === 'chain' ? [1, 0] : view === 'smile' ? [0, 1] : [0.55, 0.45];

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, instrument, meta, ctx }) => {
  if (payload === undefined) {
    return {
      title: `OMON · ${instrument?.display ?? 'Chain'}`,
      subtitle: 'loading…',
      body: stack(
        'col',
        [
          {
            kind: 'grid',
            id: 'chain',
            columns: [{ id: 'strike', label: 'Strike', align: 'right' }],
            rows: Array.from({ length: 21 }, (_v, i) => ({
              id: `chain-skeleton:${String(i)}`,
              cells: { strike: textCell(null) },
              tone: 'muted' as const,
            })),
            emptyText: 'loading…',
          },
        ],
        [1],
      ),
      footer: footer(undefined),
      initialFocus: 'chain',
    } satisfies ScreenSpec;
  }

  const u = payload.underlying;
  const header = quoteHeader(
    { display: u.key, name: u.name },
    { px: u.px, chgNet: u.chg, chgPct: u.chgPct },
    {
      id: 'header',
      extra: [
        { label: 'IV 30d', value: cell('IVOL_30D', u.iv30Pct, { fmt: 'pct', decimals: 2 }) },
        { label: 'Volume', value: cell('PX_VOLUME', u.volume, { fmt: 'int', decimals: 0 }) },
      ],
    },
  );

  const selectedBody: Node = stack(
    'col',
    [
      chainGrid(payload, params.columns),
      { kind: 'custom', id: 'smile', component: 'OptionSurface', props: { chart: 'smile', spec: omonSmileSpec(payload), svi: payload.smile.svi } },
    ],
    sizesFor(params.view),
  );

  const tabs: Node = {
    kind: 'tabs',
    id: 'expiry',
    active: payload.selected.expiry,
    tabs: payload.expiries.map((e, i) => ({
      id: e.expiry,
      label: `${e.expiry} (${String(e.days)}d) ${String(e.contractCount)}`,
      ...(i < 9 ? { key: String(i + 1) } : {}),
      body: e.isSelected
        ? selectedBody
        : ({
            kind: 'text',
            id: `expiry:${e.expiry}`,
            tone: 'muted',
            text: `${String(e.contractCount)} contracts · ${String(e.days)} days · press Enter or use the arrows to load this expiry.`,
          } satisfies Node),
    })),
    onChange: (id): void => {
      ctx.setParams({ expiry: id });
    },
  };

  return {
    title: `OMON · ${u.key} · ${u.name}`,
    subtitle: `${payload.selected.expiry} · ${String(payload.selected.days)}d · ${String(payload.selected.contractCount)} contracts · ATM ${String(payload.selected.atmStrike ?? '—')} IV ${String(payload.selected.atmIvPct.v ?? '—')} % · P/C vol ${String(payload.selected.putCallVolumeRatio.v ?? '—')}`,
    body: stack(
      'col',
      [
        { kind: 'badges', id: 'caveats', items: caveatBadges(payload, meta) },
        header,
        tabs,
        summaryKv(payload),
      ],
      [0.07, 0.13, 0.62, 0.18],
    ),
    footer: footer(meta, [
      "Greeks and implied volatility as published by Cboe; * marks OMON's own numbers (mid, ATM strike, put/call ratios).",
      `Captured ${payload.captureTs} · ${String(payload.delayMin)} minute delay`,
    ]),
    initialFocus: 'chain',
  } satisfies ScreenSpec;
};

export default Screen;
