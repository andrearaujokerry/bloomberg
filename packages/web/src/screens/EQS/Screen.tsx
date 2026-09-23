// packages/web/src/screens/EQS/Screen.tsx — Equity Screening (FUNCTIONS_TIER2.md §EQS "Screen").
//
// A criteria form over a universe, a result grid, and — the part that matters — a state row that
// accounts for every name the screen did NOT return. A factor with no reachable source keeps its
// column and its criterion row, both carrying the reason, so a partial screen can never be mistaken
// for a complete one (§EQS: "the column is never dropped").
//
// Pure: no DOM, no state, no IO. `ctx.setParams` is how the form re-runs the screen; the screen
// itself computes nothing.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type {
  Badge,
  FormField,
  FunctionScreen,
  GridColumn,
  GridRow,
  Node,
  ScreenSpec,
} from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import { monitorColumns, monitorRows } from '../QM/Screen.js';
import {
  countCell,
  entitlementBadges,
  footer,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'EQS'>;
type Payload = PayloadOf<'EQS'>;
type CriterionView = Payload['criteria'][number];

/** `BS_TOT_ASSET > 50.00B  (passed 71 · no data 0)` — one form row per criterion. */
function criterionFields(criteria: readonly CriterionView[]): FormField[] {
  return criteria.flatMap((c, i): FormField[] => {
    const n = String(i + 1);
    const suffix =
      c.unavailableReason === null
        ? `passed ${String(c.passed)} · no data ${String(c.noData)}`
        : `NOT APPLIED · ${c.unavailableReason}`;
    return [
      { id: `factor${n}`, label: `${n} Factor`, type: 'field', value: c.factor },
      { id: `op${n}`, label: `${n} Op`, type: 'text', value: c.op },
      { id: `value${n}`, label: `${n} Value (${suffix})`, type: 'number', value: c.value },
      { id: `value2${n}`, label: `${n} Upper`, type: 'number', value: c.value2 },
    ];
  });
}

function criteriaForm(p: Payload, params: Params, setParams: (patch: Partial<Params>) => void): Node {
  const fields: FormField[] = [
    { id: 'universe', label: 'Universe', type: 'enum', value: p.universe.kind, values: ['INDEX', 'EQUITY', 'ETF', 'WATCHLIST'] },
    { id: 'index', label: 'Index', type: 'text', value: params.index },
    { id: 'sector', label: 'Sector', type: 'text', value: p.filters.sector ?? '' },
    { id: 'exchange', label: 'Exchange', type: 'text', value: p.filters.exchange ?? '' },
    { id: 'country', label: 'Country', type: 'text', value: p.filters.country ?? '' },
    ...criterionFields(p.criteria),
  ];
  return {
    kind: 'form',
    id: 'criteria',
    fields,
    submitLabel: 'Run screen',
    onSubmit: (values): void => {
      const text = (id: string): string | null => {
        const v = values[id];
        return typeof v === 'string' && v.length > 0 ? v : null;
      };
      const patch: Partial<Params> = {
        universe: (text('universe') ?? p.universe.kind) as Params['universe'],
        index: text('index') ?? params.index,
        sector: text('sector'),
        exchange: text('exchange'),
        country: text('country'),
        criteria: p.criteria.map((c, i) => {
          const n = String(i + 1);
          const raw = values[`value${n}`];
          const raw2 = values[`value2${n}`];
          return {
            factor: c.factor,
            op: c.op,
            value: typeof raw === 'number' ? raw : c.value,
            value2: typeof raw2 === 'number' ? raw2 : c.value2,
          };
        }),
      };
      setParams(patch);
    },
  };
}

/** `[503 universe → 503 filtered → 38 screened · page 1/1]` plus everything the run could not do. */
function stateBadges(p: Payload, meta: Parameters<typeof entitlementBadges>[0]): Badge[] {
  const c = p.counts;
  const badges: Badge[] = [
    {
      text: `${String(c.universe)} universe → ${String(c.afterFilters)} filtered → ${String(c.afterCriteria)} screened · ${String(c.returned)} returned`,
      tone: 'info',
      title: `${p.universe.label}${p.frame === null ? '' : ` · frames ${p.frame}`} · knownAt ${p.knownAt.slice(0, 10)}`,
    },
  ];
  if (c.excludedNoData > 0) {
    badges.push({
      text: `${String(c.excludedNoData)} excluded for missing data`,
      tone: 'warn',
      title: 'A name with no value for a criterion factor is excluded, not assumed to pass.',
    });
  }
  for (const crit of p.criteria) {
    if (crit.unavailableReason === null) continue;
    badges.push({
      text: `${crit.factor}: ${crit.unavailableReason}`,
      tone: 'blocked',
      title: `${crit.label} — the criterion was NOT applied because its factor has no reachable source.`,
    });
  }
  for (const note of p.notes) badges.push({ text: note, tone: 'warn' });
  if (p.savedSearch !== null) {
    badges.push({ text: `SAVED: ${p.savedSearch.name}`, tone: 'ok', title: `saved_searches #${String(p.savedSearch.searchId)}` });
  }
  badges.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));
  return badges;
}

function resultsGrid(p: Payload): Node {
  const columns: GridColumn[] = [
    { id: 'rank', label: '#', align: 'right' },
    ...monitorColumns(p.columns),
    { id: 'sector', label: 'GICS sector', align: 'left', sortable: true },
  ];
  const base = monitorRows(p.rows, p.columns, 'none');
  const rows: GridRow[] = base.map((row, i) => {
    const r = p.rows[i];
    return {
      ...row,
      cells: {
        ...row.cells,
        rank: countCell(r?.rank ?? i + 1),
        sector: textCell(r?.gicsSector ?? null),
      },
    };
  });

  return {
    kind: 'grid',
    id: 'results',
    columns,
    rows,
    frozenColumns: 3,
    selectable: true,
    sort: p.columns.some((c) => c.id === 'CUR_MKT_CAP')
      ? { col: 'CUR_MKT_CAP', dir: 'desc' }
      : { col: 'rank', dir: 'asc' },
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    emptyText: `No securities match — ${String(p.counts.excludedNoData)} were excluded for missing data; press C to relax the screen.`,
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta, ctx }) => {
  if (payload === undefined) {
    // Skeleton: the params already typed, plus `pageSize` muted rows under the real headers.
    return {
      title: 'EQS · Equity Screening',
      subtitle: 'loading…',
      body: stack('col', [
        {
          kind: 'form',
          id: 'criteria',
          fields: [
            { id: 'universe', label: 'Universe', type: 'enum', value: params.universe, values: ['INDEX', 'EQUITY', 'ETF', 'WATCHLIST'] },
            { id: 'index', label: 'Index', type: 'text', value: params.index },
          ],
          submitLabel: 'Run screen',
          onSubmit: (): void => undefined,
        },
        {
          kind: 'grid',
          id: 'results',
          columns: [
            { id: 'rank', label: '#', align: 'right' },
            { id: 'key', label: 'Security', align: 'left' },
            { id: 'name', label: 'Name', align: 'left' },
            ...params.columns.map((f): GridColumn => ({ id: f, label: f, align: 'right', live: true })),
          ],
          rows: Array.from({ length: params.pageSize }, (_v, i) => ({
            id: `skeleton:${String(i)}`,
            cells: { key: textCell(null), name: textCell(null) },
            tone: 'muted' as const,
          })),
          emptyText: 'loading…',
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'criteria',
    } satisfies ScreenSpec;
  }

  const counts: Node = {
    kind: 'text',
    id: 'counts',
    tone: payload.counts.excludedNoData > 0 ? 'warn' : 'muted',
    text: `${String(payload.counts.afterCriteria)} of ${String(payload.counts.universe)} match · ${String(payload.counts.excludedNoData)} excluded for missing data (see badges)`,
  };

  return {
    title: 'EQS · Equity Screening',
    subtitle: `${payload.universe.label} · ${String(payload.counts.afterCriteria)} of ${String(payload.counts.universe)}`,
    body: stack(
      'col',
      [
        criteriaForm(payload, params, (patch) => {
          ctx.setParams(patch);
        }),
        { kind: 'badges', id: 'state', items: stateBadges(payload, meta) },
        resultsGrid(payload),
        counts,
      ],
      [0.22, 0.08, 0.64, 0.06],
    ),
    footer: footer(meta, payload.notes),
    initialFocus: payload.rows.length > 0 ? 'results' : 'criteria',
  } satisfies ScreenSpec;
};

export default Screen;
