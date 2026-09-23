// packages/web/src/screens/FA/Screen.tsx — Financial Analysis (FUNCTIONS_TIER2.md §FA "Screen").
//
// Two variants, two layouts, one code: `equity` is the point-in-time statement grid (one column per
// fiscal period, each column naming the filing behind it), `fund` is sponsor terms, NAV and the
// latest holdings file — because an ETF has no income statement and the screen says so rather than
// rendering an empty grid.
//
// A screen is a PURE function of its props: it returns a `ScreenSpec` — data — and never touches
// the DOM, holds state or does IO. WP-12's `ScreenRenderer` draws what this returns.
//
// Two things about provenance on this screen, because `FaRow.values` is a bare `number[]`:
//   * a statement cell cites the **column's** `provIdx` (the companyfacts capture that produced
//     that fiscal period), which is the block-level citation FUNCTIONS.md §1.3 rule 2 requires;
//   * five of the standardised lines have no dictionary field (`GROSS_PROFIT`, `TOTAL_EQUITY`,
//     `FREE_CASH_FLOW`, `RETURN_COM_EQY`, `FA_FILED_AT` are not among the dictionary's ids, as
//     `manifests/FA.ts` explains). Those cells are cited but carry no `fieldId` — the concept map
//     is their definition, exactly as a CHRT-07 formula column's formula is its own.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type {
  Badge,
  Cell,
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
  numCell,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'FA'>;
type Payload = PayloadOf<'FA'>;
type FaEquity = Extract<Payload, { variant: 'equity' }>;
type FaFund = Extract<Payload, { variant: 'fund' }>;
type FaRow = FaEquity['rows'][number];
type FaColumn = FaEquity['columns'][number];

/** `[1 IS] [2 BS] [3 CF] [4 RATIOS] [5 PER SHARE] [6 SEGMENTS]` (§FA Keyboard `1`…`6`). */
const STATEMENT_TABS: readonly { id: FaEquity['statement']; label: string }[] = [
  { id: 'IS', label: 'IS' },
  { id: 'BS', label: 'BS' },
  { id: 'CF', label: 'CF' },
  { id: 'RATIOS', label: 'RATIOS' },
  { id: 'PER_SHARE', label: 'PER SHARE' },
  { id: 'SEGMENTS', label: 'SEGMENTS' },
];

/** `row.unit` → how the renderer draws the cell, and how many decimals it keeps. */
function unitFormat(unit: FaRow['unit']): { fmt: NonNullable<Cell['fmt']>; decimals: number } {
  switch (unit) {
    case 'ccy':
      return { fmt: 'ccy', decimals: 0 };
    case 'shares':
      return { fmt: 'shares', decimals: 0 };
    case 'per_share':
      return { fmt: 'px', decimals: 2 };
    case 'pct':
      return { fmt: 'pct', decimals: 1 };
    case 'ratio':
      return { fmt: 'px', decimals: 2 };
  }
}

/** `1e6` → `USD millions`; the scale applies to currency and share counts only. */
function scaleLabel(scale: number, currency: string): string {
  if (scale >= 1e9) return `${currency} billions`;
  if (scale >= 1e6) return `${currency} millions`;
  if (scale >= 1e3) return `${currency} thousands`;
  return currency;
}

function scaleValue(v: number | null, unit: FaRow['unit'], scale: number): number | null {
  if (v === null) return null;
  return unit === 'ccy' || unit === 'shares' ? v / scale : v;
}

/**
 * One statement cell. `null` stays `null` — a period the issuer did not tag is blank with the
 * column's citation, never a zero.
 */
function statementCell(row: FaRow, index: number, column: FaColumn, scale: number): Cell {
  const { fmt, decimals } = unitFormat(row.unit);
  const v = scaleValue(row.values[index] ?? null, row.unit, scale);
  if (row.fieldId !== null) return numCell(row.fieldId, v, column.provIdx, { fmt, decimals });
  return computedCell(
    v === null
      ? { v: null, st: 'blank', provIdx: column.provIdx }
      : { v, st: 'closed', provIdx: column.provIdx },
    fmt,
    decimals,
  );
}

function statementGrid(p: FaEquity, params: Params): Node {
  const columns: GridColumn[] = [
    { id: 'label', label: 'Item', align: 'left', width: 34 },
    ...p.columns.map(
      (c): GridColumn => ({
        id: c.periodEnd,
        label: c.restated ? `${c.periodEnd} R` : c.periodEnd,
        align: 'right',
      }),
    ),
  ];

  const rows: GridRow[] = [];
  for (const r of p.rows) {
    const cells: GridRow['cells'] = {
      label: textCell(`${'  '.repeat(r.indent)}${r.label}`),
    };
    p.columns.forEach((c, i) => {
      cells[c.periodEnd] = statementCell(r, i, c, p.scale);
    });
    rows.push({ id: `fa:${r.item}`, cells, tone: r.indent === 0 ? 'normal' : 'muted' });
    if (!params.asReported) continue;
    // The as-reported drill: a muted second line naming the XBRL concept the standard item was
    // mapped from (STOR-06, DATA-06). `Enter` on the standard row opens the fact itself.
    const arCells: GridRow['cells'] = { label: textCell('    as reported') };
    p.columns.forEach((c, i) => {
      const ar = r.asReported[i] ?? null;
      arCells[c.periodEnd] = textCell(ar === null ? null : `${ar.taxonomy}:${ar.concept}`);
    });
    rows.push({ id: `fa:${r.item}:ar`, cells: arCells, tone: 'muted' });
  }

  return {
    kind: 'grid',
    id: 'statement',
    columns,
    rows,
    frozenColumns: 1,
    selectable: true,
    emptyText:
      p.statement === 'SEGMENTS'
        ? 'SEGMENTS_UNAVAILABLE — companyfacts carries no dimensional facts, so no segment breakdown can be built.'
        : 'No standardised lines for this statement at this knownAt.',
  };
}

function equityBody(p: FaEquity, params: Params, notes: Badge[]): Node {
  const mode: Badge[] = [
    {
      text: `${p.periodType} · ${String(p.columns.length)} periods · ${scaleLabel(p.scale, p.issuer.currency)} · knownAt ${p.knownAt.slice(0, 10)} · ${p.mappingVersion}`,
      tone: 'info',
      title: `Standardised through ${p.engine.name}@${p.engine.version}; every column cites the filing it came from.`,
    },
  ];
  if (params.asReported) {
    mode.push({ text: 'AR', tone: 'info', title: 'As reported: the XBRL concept behind each line.' });
  }
  mode.push(...notes);

  const grid = statementGrid(p, params);
  const tabs: Node = {
    kind: 'tabs',
    id: 'statement-tabs',
    active: p.statement,
    tabs: STATEMENT_TABS.map((t, i) => ({
      id: t.id,
      label: t.label,
      key: String(i + 1),
      body:
        t.id === p.statement
          ? grid
          : { kind: 'text', id: `tab-${t.id}`, text: `Press ${String(i + 1)} for ${t.label}.`, tone: 'muted' },
    })),
  };

  return stack('col', [{ kind: 'badges', id: 'mode', items: mode }, tabs], [0.08, 0.92]);
}

function fundBody(p: FaFund, notes: Badge[]): Node {
  const h = p.holdings;
  const fundKv: Node = {
    kind: 'kv',
    id: 'fund',
    title: 'Fund terms',
    columns: 2,
    rows: [
      kvRow('Sponsor', textCell(p.fund.sponsor)),
      kvRow('Fund type', textCell(p.fund.fundType)),
      // The payload's `fund` block carries no `provIdx` of its own, so the terms render uncited
      // (`provIdx: -1`) rather than borrowing the holdings file's citation.
      kvRow('Expense ratio', countCell(p.fund.expenseRatio, 'pct', 2)),
      kvRow('Inception', textCell(p.fund.inceptionDate, { fmt: 'date' })),
      kvRow('Distribution', textCell(p.fund.distributionFreq)),
      kvRow(
        'Tracks',
        textCell(p.fund.trackedIndex?.key ?? null, {
          ...(p.fund.trackedIndex === null ? {} : { command: `${p.fund.trackedIndex.key} MEMB` }),
        }),
      ),
      kvRow('CIK', textCell(p.fund.cik)),
    ],
  };

  const nav: Node = {
    kind: 'kv',
    id: 'nav',
    title: 'NAV',
    columns: 2,
    rows: [
      kvRow('Last', cell('PX_LAST', p.nav.px)),
      kvRow('Chg %', cell('CHG_PCT_1D', p.nav.chgPct, { signed: true })),
    ],
  };

  const note: Node = {
    kind: 'text',
    id: 'note',
    tone: 'warn',
    text: 'STATEMENTS_NOT_APPLICABLE_FUND — an ETF files no income statement; its latest holdings file is shown instead.',
  };

  const top10: Node = {
    kind: 'grid',
    id: 'top10',
    columns: [
      { id: 'key', label: 'Security', align: 'left' },
      { id: 'name', label: 'Name', align: 'left' },
      { id: 'weight', label: 'Weight', align: 'right', fieldId: 'IDX_MEMBER_WEIGHT', fmt: 'pct', decimals: 2 },
      { id: 'mv', label: 'Market value', align: 'right', fieldId: 'IDX_MEMBER_MKT_VAL', fmt: 'ccy' },
    ],
    rows: (h?.top10 ?? []).map((row, i) => ({
      id: `top10:${row.key ?? String(i)}`,
      cells: {
        key: textCell(row.key, row.key === null ? {} : { command: `${row.key} DES` }),
        name: textCell(row.name),
        weight: numCell('IDX_MEMBER_WEIGHT', row.weight, h?.provIdx ?? -1, { fmt: 'pct', decimals: 2 }),
        mv: numCell('IDX_MEMBER_MKT_VAL', row.marketValue, h?.provIdx ?? -1, { fmt: 'ccy', decimals: 0 }),
      },
      ...(row.instrumentId === null ? {} : { instrumentId: row.instrumentId }),
      ...(row.key === null ? {} : { command: `${row.key} DES` }),
    })),
    emptyText: 'No holdings file captured for this fund.',
  };

  const assetCat: Node = {
    kind: 'table',
    id: 'assetCat',
    caption: 'By asset category (N-PORT `assetCat`)',
    columns: [
      { id: 'assetCat', label: 'Category', type: 'string' },
      { id: 'weight', label: 'Weight', type: 'number', decimals: 2 },
      { id: 'count', label: 'Lines', type: 'number' },
    ],
    rows: (h?.byAssetCat ?? []).map((c) => [
      textCell(c.assetCat),
      numCell('IDX_MEMBER_WEIGHT', c.weight, h?.provIdx ?? -1, { fmt: 'pct', decimals: 2 }),
      countCell(c.count),
    ]),
  };

  const filings: Node = {
    kind: 'list',
    id: 'filings',
    items: p.filings.map((f) => ({
      id: `filing:${f.accessionNo}`,
      primary: `${f.form} · ${f.filedAt.slice(0, 10)}`,
      secondary: f.reportDate === null ? f.accessionNo : `${f.accessionNo} · report ${f.reportDate}`,
      ts: f.filedAt,
      url: f.url,
    })),
  };

  return stack(
    'col',
    [
      { kind: 'badges', id: 'mode', items: notes },
      stack('row', [fundKv, nav], [0.6, 0.4]),
      note,
      top10,
      stack('row', [assetCat, filings], [0.45, 0.55]),
    ],
    [0.08, 0.2, 0.05, 0.42, 0.25],
  );
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, instrument, meta }) => {
  const display = instrument?.display ?? 'security';

  if (payload === undefined) {
    // Skeleton: the tab strip plus a grid of twelve muted rows × `params.periods` columns, so the
    // layout does not jump when the payload lands.
    const columns: GridColumn[] = [
      { id: 'label', label: 'Item', align: 'left', width: 34 },
      ...Array.from({ length: params.periods }, (_v, i) => ({
        id: `p${String(i)}`,
        label: '—',
        align: 'right' as const,
      })),
    ];
    const grid: Node = {
      kind: 'grid',
      id: 'statement',
      columns,
      rows: Array.from({ length: 12 }, (_v, i) => ({
        id: `skeleton:${String(i)}`,
        cells: { label: textCell(null) },
        tone: 'muted' as const,
      })),
      frozenColumns: 1,
      emptyText: 'loading…',
    };
    return {
      title: `FA · ${display}`,
      subtitle: 'loading…',
      body: stack('col', [
        {
          kind: 'tabs',
          id: 'statement-tabs',
          active: params.statement,
          tabs: STATEMENT_TABS.map((t, i) => ({
            id: t.id,
            label: t.label,
            key: String(i + 1),
            body:
              t.id === params.statement
                ? grid
                : { kind: 'text', id: `tab-${t.id}`, text: 'loading…', tone: 'muted' },
          })),
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'statement',
    } satisfies ScreenSpec;
  }

  const notes: Badge[] = [
    ...entitlementBadges(meta),
    ...unavailableBadges(meta),
    ...stalenessBadges(meta),
  ];

  if (payload.variant === 'fund') {
    return {
      title: `FA · ${display} · ${payload.fund.name}`,
      subtitle: `Fund terms · ${payload.fund.fundType}${payload.holdings === null ? '' : ` · holdings ${payload.holdings.asOfDate} (${payload.holdings.sourceId})`}`,
      body: fundBody(payload, notes),
      footer: footer(meta, payload.notes),
      initialFocus: 'top10',
    } satisfies ScreenSpec;
  }

  return {
    title: `FA · ${display} · ${payload.issuer.name}`,
    subtitle: `${payload.statement} · ${payload.periodType} · ${scaleLabel(payload.scale, payload.issuer.currency)} · ${payload.mappingVersion}`,
    body: equityBody(payload, params, notes),
    footer: footer(meta, payload.notes),
    initialFocus: 'statement',
  } satisfies ScreenSpec;
};

export default Screen;
