// packages/web/src/screens/WB/Screen.tsx — World Bond Markets (FUNCTIONS_TIER2.md §WB "Screen").
//
// Sovereign benchmark yields by region, against the US par curve.
//
// `lagDays` is always on the grid, and that is the point of the screen rather than a detail of it:
// the non-US rows come from the OECD monthly long-term series, so a row can be weeks old. A screen
// that showed a monthly print beside an intraday one without saying which is which would be
// misleading, so the lag column, the `OECD_MONTHLY_LAG` chip and the per-row reason all stay.
//
// Pure: no DOM, no state, no IO.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type { Badge, FunctionScreen, GridColumn, GridRow, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
  cell,
  computedCell,
  countCell,
  entitlementBadges,
  footer,
  kvRow,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'WB'>;
type Payload = PayloadOf<'WB'>;
type CountryRow = Payload['rows'][number];

const TENOR_TABS: readonly Params['tenor'][] = ['2Y', '10Y', '30Y'];

function rowColumns(): GridColumn[] {
  return [
    { id: 'country', label: 'Country', align: 'left', sortable: true },
    { id: 'ccy', label: 'Ccy', align: 'left', fieldId: 'CRNCY' },
    { id: 'yield', label: 'Yield', align: 'right', fmt: 'pct', decimals: 2, live: true, sortable: true },
    { id: 'asOf', label: 'As of', align: 'left', fmt: 'date' },
    { id: 'freq', label: 'Freq', align: 'left' },
    { id: 'chgBp', label: 'Chg bp', align: 'right', fmt: 'bp', decimals: 1, sortable: true },
    { id: 'spreadBp', label: 'Spread vs US bp', align: 'right', fieldId: 'SPRD_TO_BENCH', fmt: 'bp', decimals: 1, sortable: true },
    { id: 'lag', label: 'Lag d', align: 'right', fmt: 'int' },
    { id: 'source', label: 'Src', align: 'left', fieldId: 'SOURCE_ID' },
  ];
}

function countryRow(r: CountryRow): GridRow {
  return {
    id: `wb:${r.iso}`,
    cells: {
      country: textCell(r.country, r.seriesCode === null ? {} : { command: `${r.seriesCode} Index GP` }),
      ccy: textCell(r.ccy, { fieldId: 'CRNCY' }),
      // The yield is a stored observation of a country series; it has no single dictionary field
      // across the OECD/Treasury sources, so it is cited at block level through the row's `provIdx`.
      yield: computedCell(r.yield, 'pct', 2),
      asOf: textCell(r.asOfDate, { fmt: 'date' }),
      freq: textCell(r.frequency),
      chgBp: computedCell(r.chgBp, 'bp', 1),
      spreadBp: cell('SPRD_TO_BENCH', r.spreadBp, { fmt: 'bp', decimals: 1 }),
      lag: countCell(r.lagDays, 'int', 0),
      source: textCell(r.sourceId, { fieldId: 'SOURCE_ID' }),
    },
    group: r.region,
    ...(r.subject === null ? {} : { subject: r.subject }),
    ...(r.seriesCode === null ? {} : { command: `${r.seriesCode} Index GP` }),
    tone: r.unavailableReason === null ? 'normal' : 'muted',
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta }) => {
  if (payload === undefined) {
    return {
      title: 'WB · World Bond Markets',
      subtitle: 'loading…',
      body: stack('col', [
        {
          kind: 'tabs',
          id: 'tenor',
          active: params.tenor,
          tabs: TENOR_TABS.map((t, i) => ({
            id: t,
            label: t,
            key: String(i + 1),
            body: { kind: 'text' as const, id: `tab-${t}`, text: 'loading…', tone: 'muted' as const },
          })),
        },
        {
          kind: 'kv',
          id: 'us',
          columns: 2,
          rows: [
            kvRow('US par curve', textCell(null)),
            kvRow('2Y', textCell(null)),
            kvRow('10Y', textCell(null)),
            kvRow('30Y', textCell(null)),
          ],
        },
        {
          kind: 'grid',
          id: 'rows',
          columns: rowColumns(),
          rows: Array.from({ length: 16 }, (_v, i) => ({
            id: `skeleton:${String(i)}`,
            cells: { country: textCell(null) },
            tone: 'muted' as const,
          })),
          emptyText: 'loading…',
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'rows',
    } satisfies ScreenSpec;
  }

  const us = payload.us;
  const point = (tenor: string): Payload['us']['points'][number] | undefined =>
    us.points.find((p) => p.tenor === tenor);
  const intraday = us.intraday;
  const intradayCells = intraday?.cells ?? {};

  const usKv: Node = {
    kind: 'kv',
    id: 'us',
    title: `US par curve ${us.curveDate ?? '—'}`,
    columns: 3,
    rows: [
      ...['2Y', '10Y', '30Y'].map((tenor) => {
        const p = point(tenor);
        return kvRow(
          tenor,
          p === undefined
            ? textCell(null)
            : p.fieldId === null
              ? computedCell(p.value, 'pct', 2)
              : cell(p.fieldId, p.value, { fmt: 'pct', decimals: 2 }),
        );
      }),
      kvRow(
        intraday?.key ?? 'TNX Index',
        intradayCells.PX_LAST === undefined
          ? textCell(null)
          : cell('PX_LAST', intradayCells.PX_LAST, { fmt: 'px', decimals: 2 }),
      ),
      kvRow(
        'Chg',
        intradayCells.CHG_NET_1D === undefined
          ? textCell(null)
          : cell('CHG_NET_1D', intradayCells.CHG_NET_1D, { fmt: 'px', decimals: 3, signed: true }),
      ),
      kvRow(
        'Chg %',
        intradayCells.CHG_PCT_1D === undefined
          ? textCell(null)
          : cell('CHG_PCT_1D', intradayCells.CHG_PCT_1D, { signed: true }),
      ),
    ],
  };

  const notes: Badge[] = [
    {
      text: 'OECD_MONTHLY_LAG',
      tone: 'warn',
      title: 'Non-US benchmarks come from the OECD monthly long-term interest-rate series; the `Lag d` column is how old each print is.',
    },
    {
      text: 'NO_NON_US_INTRADAY',
      tone: 'warn',
      title: 'Only the US publishes an intraday yield in the reachable source set (TNX Index).',
    },
  ];
  for (const region of payload.regions) {
    notes.push({
      text: `${region.region} ${String(region.withData)}/${String(region.count)}`,
      tone: region.withData === region.count ? 'ok' : 'warn',
      title: 'Countries in the region with a value for this tenor, out of the countries listed.',
    });
  }
  for (const note of payload.notes) {
    if (notes.some((n) => n.text === note)) continue;
    notes.push({ text: note, tone: 'warn' });
  }
  notes.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));

  const grid: Node = {
    kind: 'grid',
    id: 'rows',
    columns: rowColumns(),
    rows: payload.rows.map(countryRow),
    frozenColumns: 1,
    groupBy: 'region',
    selectable: true,
    sort: { col: payload.spreadTo === 'US' ? 'spreadBp' : 'yield', dir: 'desc' },
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    emptyText: 'No sovereign series seeded for this tenor.',
  };

  const body = stack('col', [usKv, { kind: 'badges', id: 'notes', items: notes }, grid], [0.18, 0.08, 0.74]);

  const tabs: Node = {
    kind: 'tabs',
    id: 'tenor',
    active: payload.tenor,
    tabs: TENOR_TABS.map((t, i) => ({
      id: t,
      label: t,
      key: String(i + 1),
      body:
        t === payload.tenor
          ? body
          : { kind: 'text' as const, id: `tab-${t}`, text: `Press ${String(i + 1)} for ${t}.`, tone: 'muted' as const },
    })),
  };

  return {
    title: 'WB · World Bond Markets',
    subtitle: `${payload.tenor} benchmark · chg ${payload.chgWindow} · spread vs ${payload.spreadTo}`,
    body: tabs,
    footer: footer(meta, payload.notes),
    initialFocus: 'rows',
  } satisfies ScreenSpec;
};

export default Screen;
