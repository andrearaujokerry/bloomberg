// packages/web/src/screens/SRCH/Screen.tsx — Treasury Search (FUNCTIONS_TIER3 §SRCH "Screen").
//
// A criteria form over the Treasury universe, the matching securities, and — the part that matters
// — the two sentences the screen never stops saying:
//
//   * **`NO_BOND_PRICE_SOURCE`.** There is no evaluated fixed-income pricing vendor in this build,
//     so every yield, price, accrued and duration column is derived from the Treasury curve by the
//     engines YAS uses. `kv#pricing` names the curve, its date, the interpolation and the build, so
//     a row can be checked against the YAS screen for the same security and settlement (ANAL-09).
//   * **`SEED_UNIVERSE_ONLY`.** The universe is the seeded Treasury set, not an issuance file. A
//     search that returns nothing must never be read as "no such security exists", so the empty
//     state shows each predicate's own match count and says which criterion emptied the screen.
//
// A `na` cell is a real answer, not a hole: a bill has no modified-duration convention to quote and
// a coupon bond has no discount rate, so those cells arrive `{v:null, st:'na'}` and render as an em
// dash with "not applicable to this security type" — the column is never dropped.
//
// Pure: no DOM, no state, no IO.

import type { ParamsOf, PayloadOf } from '@terminal/core';

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

type Params = ParamsOf<'SRCH'>;
type Payload = PayloadOf<'SRCH'>;
type Column = Payload['columns'][number];
type Row = Payload['rows'][number];

const NOTE_TITLES: Readonly<Record<string, string>> = {
  NO_BOND_PRICE_SOURCE:
    'Yields and prices are derived from the Treasury curve; there is no evaluated bond price source in v1 (BRIEF §1, DATA-04).',
  SEED_UNIVERSE_ONLY:
    'The universe is the seeded Treasury securities (bills from the Treasury bill file plus the curated on-the-run notes and bonds).',
  TIPS_FRN_NOT_PRICED:
    'TIPS/FRN pricing needs an inflation or reference-rate engine (the same boundary YAS draws).',
  CURVE_DATE_BEFORE_VALUATION:
    'The latest stored curve date is earlier than the valuation date; the analytic columns are priced off it.',
};

function criteriaForm(p: Payload, params: Params, setParams: (patch: Partial<Params>) => void): Node {
  const fields: FormField[] = [
    { id: 'securityTypes', label: 'Types', type: 'text', value: params.securityTypes.join(',') },
    { id: 'maturityFrom', label: 'Maturity from', type: 'date', value: params.maturityFrom },
    { id: 'maturityTo', label: 'Maturity to', type: 'date', value: params.maturityTo },
    { id: 'yearsFrom', label: 'Years from', type: 'number', value: params.yearsFrom, step: 1 },
    { id: 'yearsTo', label: 'Years to', type: 'number', value: params.yearsTo, step: 1 },
    { id: 'couponFrom', label: 'Coupon from %', type: 'number', value: params.couponFrom, step: 0.125 },
    { id: 'couponTo', label: 'Coupon to %', type: 'number', value: params.couponTo, step: 0.125 },
    { id: 'onTheRun', label: 'On-the-run', type: 'enum', value: params.onTheRun, values: ['any', 'only', 'exclude'] },
    { id: 'callable', label: 'Callable', type: 'enum', value: params.callable, values: ['any', 'only', 'exclude'] },
    { id: 'minAmountOutstanding', label: 'Min amount', type: 'number', value: params.minAmountOutstanding },
    { id: 'cusip', label: 'CUSIP', type: 'text', value: params.cusip },
    { id: 'curveId', label: 'Curve', type: 'enum', value: p.pricing.curveId, values: ['UST_PAR', 'UST_CMT'] },
    { id: 'settlement', label: 'Settlement', type: 'date', value: p.pricing.settlement },
  ];

  return {
    kind: 'form',
    id: 'criteria',
    fields,
    submitLabel: 'Run search',
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
        maturityFrom: text('maturityFrom'),
        maturityTo: text('maturityTo'),
        yearsFrom: num('yearsFrom'),
        yearsTo: num('yearsTo'),
        couponFrom: num('couponFrom'),
        couponTo: num('couponTo'),
        minAmountOutstanding: num('minAmountOutstanding'),
        cusip: text('cusip'),
        settlement: text('settlement'),
      };
      const types = text('securityTypes');
      if (types !== null) {
        patch.securityTypes = types
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t !== '') as Params['securityTypes'];
      }
      const onTheRun = text('onTheRun');
      if (onTheRun !== null) patch.onTheRun = onTheRun as Params['onTheRun'];
      const callable = text('callable');
      if (callable !== null) patch.callable = callable as Params['callable'];
      const curveId = text('curveId');
      if (curveId !== null) patch.curveId = curveId as Params['curveId'];
      setParams(patch);
    },
  };
}

function rowsGrid(p: Payload, meta: Parameters<typeof footer>[0]): Node {
  const columns: GridColumn[] = [
    { id: 'rank', label: '#', align: 'right', fmt: 'int' },
    { id: 'key', label: 'Security', align: 'left', sortable: true },
    ...p.columns.map((c: Column): GridColumn => {
      const col: GridColumn = {
        id: c.id,
        label: c.label,
        align: c.fmt === 'text' || c.fmt === 'date' ? 'left' : 'right',
        fmt: c.fmt,
        sortable: true,
      };
      if (c.decimals !== undefined) col.decimals = c.decimals;
      if (c.fieldId !== undefined) col.fieldId = c.fieldId;
      return col;
    }),
  ];

  const rows: GridRow[] = p.rows.map((r: Row): GridRow => {
    const cells: Record<string, Cell> = {
      rank: countCell(r.rank),
      key: textCell(r.key, { command: `${r.key} YAS` }),
    };
    for (const c of p.columns) {
      const vc = r.cells[c.id];
      if (vc === undefined) {
        cells[c.id] = textCell(null);
        continue;
      }
      const opts = c.decimals === undefined ? { fmt: c.fmt } : { fmt: c.fmt, decimals: c.decimals };
      // `TERM_LABEL`, `MTY_YEARS` and the column ids the dictionary spells differently have no
      // field of their own; the number is still cited to the terms row or the curve it came from.
      cells[c.id] =
        c.fieldId === undefined
          ? computedCell(vc, c.fmt, c.decimals ?? 2)
          : cell(c.fieldId, vc, opts);
    }
    return {
      id: `srch:${r.cusip}`,
      cells,
      subject: r.subject,
      command: `${r.key} YAS`,
      tone: r.onTheRun ? 'highlight' : 'normal',
    };
  });

  const grid: Extract<Node, { kind: 'grid' }> = {
    kind: 'grid',
    id: 'rows',
    columns,
    rows,
    frozenColumns: 2,
    selectable: true,
    sort: { col: p.columns.some((c) => c.id === 'MATURITY') ? 'MATURITY' : 'rank', dir: 'asc' },
    onEnter: (row: GridRow): string | null => row.command ?? null,
    onShiftEnter: (row: GridRow): string | null => row.command ?? null,
    emptyText: 'No Treasury matches these terms — see the filter counts below for which criterion emptied the screen.',
  };
  if (meta?.page !== undefined) grid.page = { index: meta.page.index, count: meta.page.count };
  return grid;
}

function pricingKv(p: Payload): Node {
  const e = p.pricing.engine;
  return {
    kind: 'kv',
    id: 'pricing',
    title: 'Pricing',
    columns: 3,
    rows: [
      kvRow('Basis', textCell(p.pricing.basis)),
      kvRow('Curve', textCell(p.pricing.curveId)),
      kvRow('Curve date', textCell(p.pricing.curveDate, { fmt: 'date' })),
      kvRow('Interpolation', textCell(p.pricing.interpolation)),
      kvRow('Build', textCell(p.pricing.buildId === null ? null : String(p.pricing.buildId))),
      kvRow('Settlement', textCell(`${p.pricing.settlement} (${p.pricing.settlementRule})`)),
      kvRow('Engine', textCell(e === null ? null : `${e.name}@${e.version}`)),
      kvRow('Inputs hash', textCell(e === null ? null : e.inputsHash.slice(0, 8))),
      kvRow('Universe', textCell(`${p.universe.label} · ${String(p.universe.size)} securities`)),
      kvRow('Coverage', textCell(p.universe.coverage)),
      kvRow('Excluded (no terms)', countCell(p.counts.excludedNoTerms)),
      kvRow('Excluded (not priced)', countCell(p.counts.excludedNotPriced)),
    ],
  };
}

/** The filter and facet counts as chips — which criterion cut what, and what the survivors are. */
function facetBadges(p: Payload): Badge[] {
  const items: Badge[] = p.filters.map((f) => ({
    text: `${f.label} → ${String(f.matched)}`,
    tone: f.unavailableReason === null ? ('info' as const) : ('warn' as const),
    title: f.unavailableReason ?? `${f.field}: ${String(f.matched)} of ${String(p.counts.universe)} pass this predicate alone`,
  }));
  for (const t of p.facets.securityType) items.push({ text: `${t.value} ${String(t.count)}`, tone: 'ok' });
  for (const b of p.facets.maturityBucket) items.push({ text: `${b.value} ${String(b.count)}`, tone: 'ok' });
  for (const o of p.facets.onTheRun) items.push({ text: `OTR ${o.value} ${String(o.count)}`, tone: 'ok' });
  return items;
}

function noteBadges(p: Payload, meta: Parameters<typeof footer>[0]): Badge[] {
  const badges: Badge[] = p.notes.map((n) => ({ text: n, tone: 'warn' as const, title: NOTE_TITLES[n] ?? n }));
  if (p.savedSearch !== null) {
    badges.push({ text: `SAVED: ${p.savedSearch.name}`, tone: 'ok', title: `saved_searches #${String(p.savedSearch.searchId)}` });
  }
  badges.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));
  return badges;
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta, ctx }) => {
  if (payload === undefined) {
    return {
      title: 'SRCH · US Treasuries',
      subtitle: 'loading…',
      body: stack(
        'col',
        [
          {
            kind: 'form',
            id: 'criteria',
            fields: [
              { id: 'securityTypes', label: 'Types', type: 'text', value: params.securityTypes.join(',') },
              { id: 'onTheRun', label: 'On-the-run', type: 'enum', value: params.onTheRun, values: ['any', 'only', 'exclude'] },
            ],
            submitLabel: 'Run search',
            onSubmit: (): void => undefined,
          },
          {
            kind: 'grid',
            id: 'rows',
            columns: [
              { id: 'rank', label: '#', align: 'right' },
              ...params.columns.map((c): GridColumn => ({ id: c, label: c, align: 'right' })),
            ],
            rows: Array.from({ length: 12 }, (_v, i) => ({
              id: `srch-skeleton:${String(i)}`,
              cells: { rank: textCell(null) },
              tone: 'muted' as const,
            })),
            emptyText: 'loading…',
          },
        ],
        [0.3, 0.7],
      ),
      footer: footer(undefined),
      initialFocus: 'criteria',
    } satisfies ScreenSpec;
  }

  const right: Node =
    payload.rows.length === 0
      ? stack(
          'col',
          [
            {
              kind: 'text',
              id: 'empty',
              tone: 'warn',
              text: `No Treasury matches these terms. ${payload.filters
                .map((f) => `${f.label} → ${String(f.matched)}`)
                .join(' · ')}`,
            },
            pricingKv(payload),
          ],
          [0.3, 0.7],
        )
      : stack('col', [rowsGrid(payload, meta), pricingKv(payload)], [0.7, 0.3]);

  return {
    title: `SRCH · US Treasuries · ${String(payload.counts.universe)} securities · ${String(payload.counts.afterFilters)} match`,
    subtitle: `curve ${payload.pricing.curveId} ${payload.pricing.curveDate ?? '—'} · settlement ${payload.pricing.settlement} · sorted by ${params.sort.col} ${params.sort.dir}`,
    body: stack(
      'col',
      [
        { kind: 'badges', id: 'notes', items: noteBadges(payload, meta) },
        stack(
          'row',
          [
            criteriaForm(payload, params, (patch) => {
              ctx.setParams(patch);
            }),
            right,
          ],
          [0.3, 0.7],
        ),
        { kind: 'badges', id: 'facets', items: facetBadges(payload) },
      ],
      [0.08, 0.82, 0.1],
    ),
    footer: footer(meta, [
      'Analytic columns are curve-derived: there is no evaluated bond price source in this build (NO_BOND_PRICE_SOURCE).',
      ...payload.notes,
    ]),
    initialFocus: payload.rows.length > 0 ? 'rows' : 'criteria',
  } satisfies ScreenSpec;
};

export default Screen;
