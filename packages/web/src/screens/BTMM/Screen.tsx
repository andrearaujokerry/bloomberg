// packages/web/src/screens/BTMM/Screen.tsx — Treasury & Money Markets (FUNCTIONS_TIER2.md §BTMM).
//
// One morning page over the whole front end: the policy band, the NY Fed overnight fixings with
// their percentiles, the bill curve, the par/CMT curve against a comparison date, the spread block
// and a small context monitor.
//
// The gaps are part of the page, not an omission from it. `IORB`, the discount window and fed funds
// futures have no reachable source, so they render as em dashes carrying their reason codes and as
// chips in `badges#gaps` — the screen states what it cannot show.
//
// Pure: no DOM, no state, no IO.

import type { MonitorColumn, ParamsOf, PayloadOf } from '@terminal/core';

import type { Badge, Cell, FunctionScreen, GridColumn, GridRow, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import { monitorColumns, monitorRows } from '../QM/Screen.js';
import {
  EM_DASH,
  cell,
  computedCell,
  entitlementBadges,
  footer,
  kvRow,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'BTMM'>;
type Payload = PayloadOf<'BTMM'>;
type Fixing = Payload['overnight'][number];
type CurvePoint = Payload['curve']['points'][number];
type Spread = Payload['spreads'][number];

const SECTION_TABS: readonly { id: Params['section']; label: string }[] = [
  { id: 'ALL', label: 'ALL' },
  { id: 'POLICY', label: 'POLICY' },
  { id: 'OVERNIGHT', label: 'O/N' },
  { id: 'BILLS', label: 'BILLS' },
  { id: 'CURVE', label: 'CURVE' },
  { id: 'SPREADS', label: 'SPREADS' },
  { id: 'CONTEXT', label: 'CONTEXT' },
];

/** The context monitor's three columns (§BTMM `grid#context`). */
const CONTEXT_COLUMNS: MonitorColumn[] = [
  { id: 'PX_LAST', label: 'Last', fieldId: 'PX_LAST', fmt: 'px' },
  { id: 'CHG_NET_1D', label: 'Chg', fieldId: 'CHG_NET_1D', fmt: 'px' },
  { id: 'CHG_PCT_1D', label: 'Chg %', fieldId: 'CHG_PCT_1D', fmt: 'pct', decimals: 2 },
];

function policyKv(p: Payload): Node {
  const pol = p.policy;
  const last = pol.lastMeeting;
  const next = pol.nextMeeting;
  return {
    kind: 'kv',
    id: 'policy',
    title: 'Policy',
    columns: 3,
    rows: [
      kvRow('Target from', cell('TARGET_FROM', pol.targetFrom, { fmt: 'pct', decimals: 2 })),
      kvRow('Target to', cell('TARGET_TO', pol.targetTo, { fmt: 'pct', decimals: 2 })),
      kvRow('Target mid', cell('TARGET_FROM', pol.targetMid, { fmt: 'pct', decimals: 3 })),
      kvRow('Effective', textCell(pol.effectiveDate, { fmt: 'date' })),
      kvRow(
        'Last FOMC',
        textCell(
          last === null
            ? null
            : `${last.meetingDate}${last.decisionBp === null ? '' : ` (${last.decisionBp > 0 ? '+' : ''}${String(last.decisionBp)} bp)`}`,
        ),
      ),
      kvRow(
        'Next FOMC',
        textCell(
          next === null ? null : `${next.meetingDate} (${String(next.daysAway)} d)${next.hasSep ? ' · SEP' : ''}`,
        ),
      ),
      // Two rates with no reachable source: the em dash carries its reason rather than a zero.
      kvRow('IORB', textCell(`${EM_DASH} ${pol.iorb.r}`)),
      kvRow('Discount window', textCell(`${EM_DASH} ${pol.discountWindow.r}`)),
    ],
  };
}

function overnightGrid(p: Payload, percentiles: boolean): Node {
  const columns: GridColumn[] = [
    { id: 'rate', label: 'Rate', align: 'left' },
    { id: 'label', label: 'Name', align: 'left' },
    { id: 'fix', label: 'Fix', align: 'right', fieldId: 'RATE', fmt: 'pct', decimals: 3, live: true },
    { id: 'chgBp', label: 'Chg bp', align: 'right', fmt: 'bp', decimals: 1 },
  ];
  if (percentiles) {
    columns.push(
      { id: 'p1', label: 'p1', align: 'right', fieldId: 'RATE_P1', fmt: 'pct', decimals: 3 },
      { id: 'p25', label: 'p25', align: 'right', fieldId: 'RATE_P25', fmt: 'pct', decimals: 3 },
      { id: 'p75', label: 'p75', align: 'right', fieldId: 'RATE_P75', fmt: 'pct', decimals: 3 },
      { id: 'p99', label: 'p99', align: 'right', fieldId: 'RATE_P99', fmt: 'pct', decimals: 3 },
    );
  }
  columns.push(
    { id: 'volume', label: 'Vol $bn', align: 'right', fieldId: 'RATE_VOLUME_BN', fmt: 'int' },
    { id: 'effectiveDate', label: 'Eff date', align: 'left', fmt: 'date' },
    { id: 'state', label: 'State', align: 'left' },
  );

  const rows: GridRow[] = p.overnight.map((r: Fixing) => {
    const cells: Record<string, Cell> = {
      rate: textCell(r.rateCode, { command: `${r.rateCode} Index DES` }),
      label: textCell(r.label),
      fix: cell('RATE', r.rate, { fmt: 'pct', decimals: 3 }),
      // `chg1dBp` is resolver arithmetic on the fixing's own provenance: a cited number with no
      // dictionary field of its own.
      chgBp: computedCell(r.chg1dBp, 'bp', 1),
      volume: cell('RATE_VOLUME_BN', r.volumeBn, { fmt: 'int', decimals: 0 }),
      effectiveDate: textCell(r.effectiveDate, { fmt: 'date' }),
      state: textCell(`${r.isLatest ? 'latest' : 'superseded'}${r.revisionIndicator === '' ? '' : ` · ${r.revisionIndicator}`}`),
    };
    if (percentiles) {
      cells.p1 = cell('RATE_P1', r.p1, { fmt: 'pct', decimals: 3 });
      cells.p25 = cell('RATE_P25', r.p25, { fmt: 'pct', decimals: 3 });
      cells.p75 = cell('RATE_P75', r.p75, { fmt: 'pct', decimals: 3 });
      cells.p99 = cell('RATE_P99', r.p99, { fmt: 'pct', decimals: 3 });
    }
    return {
      id: `on:${r.rateCode}`,
      cells,
      subject: r.subject,
      command: `${r.rateCode} Index DES`,
      tone: r.isLatest ? 'normal' : 'muted',
    };
  });

  return {
    kind: 'grid',
    id: 'overnight',
    columns,
    rows,
    frozenColumns: 2,
    selectable: true,
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    emptyText: 'No NY Fed reference rates stored for this date.',
  };
}

function billsGrid(p: Payload): Node {
  const rows: GridRow[] = p.bills.points.map((b: CurvePoint) => ({
    id: `bill:${b.tenor}:${b.cusip ?? ''}`,
    cells: {
      tenor: textCell(b.tenor),
      cusip: textCell(b.cusip, b.cusip === null ? {} : { command: `${b.cusip} Govt YAS` }),
      maturity: textCell(b.maturityDate, { fmt: 'date' }),
      // A bill row carries ONE quoted number; the column it belongs to is `quoteType`. The other
      // column is an em dash, not the same number printed twice under a different name.
      discount:
        b.quoteType === 'discount_rate'
          ? cell('DISC_RATE', b.value, { fmt: 'pct', decimals: 3 })
          : textCell(EM_DASH),
      invYield:
        b.quoteType === 'investment_yield'
          ? cell('MM_YIELD', b.value, { fmt: 'pct', decimals: 3 })
          : textCell(EM_DASH),
      chgBp: computedCell(b.chgBp, 'bp', 1),
      otr: textCell(b.onTheRun ? 'OTR' : ''),
    },
    ...(b.instrumentId === null ? {} : { instrumentId: b.instrumentId }),
    ...(b.cusip === null ? {} : { command: `${b.cusip} Govt YAS` }),
  }));

  return {
    kind: 'grid',
    id: 'bills',
    columns: [
      { id: 'tenor', label: 'Tenor', align: 'left' },
      { id: 'cusip', label: 'CUSIP', align: 'left', fieldId: 'ID_CUSIP' },
      { id: 'maturity', label: 'Maturity', align: 'left', fieldId: 'MATURITY', fmt: 'date' },
      { id: 'discount', label: 'Discount', align: 'right', fieldId: 'DISC_RATE', fmt: 'pct', decimals: 3 },
      { id: 'invYield', label: 'Inv yld', align: 'right', fieldId: 'MM_YIELD', fmt: 'pct', decimals: 3 },
      { id: 'chgBp', label: 'Chg bp', align: 'right', fmt: 'bp', decimals: 1 },
      { id: 'otr', label: 'OTR', align: 'left', fieldId: 'ON_THE_RUN' },
    ],
    rows,
    frozenColumns: 1,
    selectable: true,
    emptyText: 'No Treasury bill rates stored for this date.',
  };
}

function curveGrid(p: Payload): Node {
  const rows: GridRow[] = p.curve.points.map((c: CurvePoint) => ({
    id: `crv:${c.tenor}`,
    cells: {
      tenor: textCell(c.tenor),
      yield: c.fieldId === null ? computedCell(c.value, 'pct', 2) : cell(c.fieldId, c.value, { fmt: 'pct', decimals: 2 }),
      compare: computedCell(c.compareValue, 'pct', 2),
      chgBp: computedCell(c.chgBp, 'bp', 1),
    },
  }));

  return {
    kind: 'grid',
    id: 'curve',
    columns: [
      { id: 'tenor', label: 'Tenor', align: 'left' },
      { id: 'yield', label: 'Yield', align: 'right', fmt: 'pct', decimals: 2 },
      { id: 'compare', label: p.curve.compareDate ?? 'Compare', align: 'right', fmt: 'pct', decimals: 2 },
      { id: 'chgBp', label: 'Chg bp', align: 'right', fmt: 'bp', decimals: 1 },
    ],
    rows,
    frozenColumns: 1,
    selectable: true,
    emptyText: 'No curve points stored on or before this date.',
  };
}

function spreadGrid(p: Payload): Node {
  const rows: GridRow[] = p.spreads.map((s: Spread) => ({
    id: `spr:${s.id}`,
    cells: {
      label: textCell(s.label),
      definition: textCell(s.definition),
      value: computedCell(s.value, s.unit === 'bp' ? 'bp' : 'pct', s.unit === 'bp' ? 1 : 3),
      chgBp: computedCell(s.chgBp, 'bp', 1),
    },
  }));

  return {
    kind: 'grid',
    id: 'spreads',
    columns: [
      { id: 'label', label: 'Spread', align: 'left' },
      { id: 'definition', label: 'Definition', align: 'left', width: 44 },
      { id: 'value', label: 'Value', align: 'right', fmt: 'bp', decimals: 1 },
      { id: 'chgBp', label: 'Chg bp', align: 'right', fmt: 'bp', decimals: 1 },
    ],
    rows,
    frozenColumns: 1,
    emptyText: 'No spreads computable from the stored curve.',
  };
}

function contextGrid(p: Payload): Node {
  const rows = [...p.context.fx, ...p.context.indices];
  return {
    kind: 'grid',
    id: 'context',
    columns: monitorColumns(CONTEXT_COLUMNS),
    rows: monitorRows(rows, CONTEXT_COLUMNS, 'none'),
    frozenColumns: 2,
    selectable: true,
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    emptyText: 'No context instruments seeded.',
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta }) => {
  if (payload === undefined) {
    return {
      title: 'BTMM · Treasury & Money Markets',
      subtitle: 'loading…',
      body: stack('col', [
        {
          kind: 'tabs',
          id: 'section',
          active: params.section,
          tabs: SECTION_TABS.map((t, i) => ({
            id: t.id,
            label: t.label,
            key: String(i + 1),
            body: { kind: 'text' as const, id: `tab-${t.id}`, text: 'loading…', tone: 'muted' as const },
          })),
        },
        {
          kind: 'kv',
          id: 'policy',
          columns: 3,
          rows: [
            kvRow('Target from', textCell(null)),
            kvRow('Target to', textCell(null)),
            kvRow('Target mid', textCell(null)),
            kvRow('Effective', textCell(null)),
            kvRow('Last FOMC', textCell(null)),
            kvRow('Next FOMC', textCell(null)),
          ],
        },
        {
          kind: 'grid',
          id: 'overnight',
          columns: [
            { id: 'rate', label: 'Rate', align: 'left' },
            { id: 'fix', label: 'Fix', align: 'right' },
          ],
          rows: Array.from({ length: 6 }, (_v, i) => ({
            id: `on-skeleton:${String(i)}`,
            cells: { rate: textCell(null) },
            tone: 'muted' as const,
          })),
          emptyText: 'loading…',
        },
        {
          kind: 'grid',
          id: 'bills',
          columns: [{ id: 'tenor', label: 'Tenor', align: 'left' }],
          rows: Array.from({ length: 14 }, (_v, i) => ({
            id: `bill-skeleton:${String(i)}`,
            cells: { tenor: textCell(null) },
            tone: 'muted' as const,
          })),
          emptyText: 'loading…',
        },
        {
          kind: 'grid',
          id: 'curve',
          columns: [{ id: 'tenor', label: 'Tenor', align: 'left' }],
          rows: Array.from({ length: 11 }, (_v, i) => ({
            id: `crv-skeleton:${String(i)}`,
            cells: { tenor: textCell(null) },
            tone: 'muted' as const,
          })),
          emptyText: 'loading…',
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'overnight',
    } satisfies ScreenSpec;
  }

  const gaps: Badge[] = [
    { text: payload.policy.iorb.r, tone: 'warn', title: 'The Fed publishes IORB on a page the wedge does not capture.' },
    { text: payload.policy.discountWindow.r, tone: 'warn', title: 'No discount-window rate source in the wedge.' },
    { text: 'NO_FED_FUNDS_FUTURES', tone: 'warn', title: 'No futures source: the implied policy path lives in WIRP, not here.' },
  ];
  if (payload.curve.stale) {
    gaps.push({
      text: 'CURVE_STALE',
      tone: 'stale',
      title: `Curve date ${payload.curve.curveDate ?? '—'} is more than three USGOVT business days behind the as-of.`,
    });
  }
  for (const note of payload.notes) {
    if (gaps.some((g) => g.text === note)) continue;
    gaps.push({ text: note, tone: 'warn' });
  }
  gaps.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));

  const all = stack(
    'col',
    [
      policyKv(payload),
      overnightGrid(payload, params.percentiles),
      billsGrid(payload),
      curveGrid(payload),
      spreadGrid(payload),
      contextGrid(payload),
    ],
    [0.16, 0.2, 0.18, 0.16, 0.16, 0.14],
  );

  const tabs: Node = {
    kind: 'tabs',
    id: 'section',
    active: payload.section,
    tabs: SECTION_TABS.map((t, i) => ({
      id: t.id,
      label: t.label,
      key: String(i + 1),
      body:
        t.id === payload.section
          ? all
          : { kind: 'text' as const, id: `tab-${t.id}`, text: `Press ${String(i + 1)} for ${t.label}.`, tone: 'muted' as const },
    })),
  };

  return {
    title: 'BTMM · Treasury & Money Markets',
    subtitle: `${payload.curve.curveId} ${payload.curve.curveDate ?? '—'} · compare ${payload.curve.compareDate ?? '—'} · spreads in ${params.spreadUnits}`,
    body: stack('col', [{ kind: 'badges', id: 'gaps', items: gaps }, tabs], [0.07, 0.93]),
    footer: footer(meta, payload.notes),
    initialFocus: 'overnight',
  } satisfies ScreenSpec;
};

export default Screen;
