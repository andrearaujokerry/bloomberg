// packages/web/src/screens/HDS/Screen.tsx — Holders (FUNCTIONS_TIER2.md §HDS "Screen").
//
// Two variants. `equity` answers "who holds this?" out of what the wedge actually has — ETF
// holdings files — and says loudly what it does NOT have: `13F_NOT_AVAILABLE` and
// `INSIDER_HOLDINGS_NOT_PARSED` are permanent warn chips on this variant, never hidden, because a
// holders screen missing the institutional half is only honest if it says so. `fund` answers the
// mirror question: what does this fund hold?
//
// Pure: no DOM, no state, no IO.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type { Badge, FunctionScreen, GridColumn, GridRow, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
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

type Params = ParamsOf<'HDS'>;
type Payload = PayloadOf<'HDS'>;
type HdsEquity = Extract<Payload, { variant: 'equity' }>;
type HdsFund = Extract<Payload, { variant: 'fund' }>;

const VIEW_TABS: readonly { id: 'HOLDERS' | 'INSIDERS'; label: string }[] = [
  { id: 'HOLDERS', label: 'HOLDERS' },
  { id: 'INSIDERS', label: 'INSIDERS' },
];

function holdersGrid(p: HdsEquity): Node {
  const columns: GridColumn[] = [
    { id: 'holder', label: 'Holder', align: 'left', sortable: true },
    { id: 'kind', label: 'Kind', align: 'left' },
    { id: 'shares', label: 'Shares', align: 'right', fieldId: 'HLD_SHARES_HELD', fmt: 'int' },
    { id: 'value', label: 'Market value', align: 'right', fieldId: 'HLD_MKT_VAL', fmt: 'ccy', decimals: 0 },
    { id: 'weightInHolder', label: 'Wt in holder', align: 'right', fieldId: 'IDX_MEMBER_WEIGHT', fmt: 'pct', decimals: 2 },
    { id: 'pctOut', label: '% sh out', align: 'right', fieldId: 'HLD_PCT_OUT', fmt: 'pct', decimals: 2 },
    { id: 'asOf', label: 'As of', align: 'left', fieldId: 'HLD_AS_OF_DT', fmt: 'date' },
    { id: 'source', label: 'Source', align: 'left' },
  ];

  const rows: GridRow[] = p.holders.map((h, i) => ({
    id: `holder:${h.holderKey ?? `${h.holderName}:${String(i)}`}`,
    cells: {
      holder: textCell(h.holderName, {
        fieldId: 'HLD_HOLDER_NAME',
        ...(h.holderKey === null ? {} : { command: `${h.holderKey} HDS` }),
      }),
      kind: textCell(h.holderKind),
      shares: numCell('HLD_SHARES_HELD', h.shares, h.provIdx, { fmt: 'int', decimals: 0 }),
      value: numCell('HLD_MKT_VAL', h.marketValue, h.provIdx, { fmt: 'ccy', decimals: 0 }),
      weightInHolder: numCell('IDX_MEMBER_WEIGHT', h.weightInHolder, h.provIdx, { fmt: 'pct', decimals: 2 }),
      pctOut: numCell('HLD_PCT_OUT', h.pctSharesOut, h.provIdx, { fmt: 'pct', decimals: 2 }),
      asOf: textCell(h.asOfDate, { fieldId: 'HLD_AS_OF_DT', fmt: 'date' }),
      source: textCell(h.sourceId),
    },
    ...(h.holderInstrumentId === null ? {} : { instrumentId: h.holderInstrumentId }),
    ...(h.holderKey === null ? {} : { command: `${h.holderKey} HDS` }),
  }));

  return {
    kind: 'grid',
    id: 'holders',
    columns,
    rows,
    frozenColumns: 1,
    selectable: true,
    sort: { col: 'weightInHolder', dir: 'desc' },
    emptyText: 'No fund holdings file lists this security. 13F institutional holdings are not available (13F_NOT_AVAILABLE).',
  };
}

function insidersNodes(p: HdsEquity): Node[] {
  const note: Node = {
    kind: 'text',
    id: 'insider-note',
    tone: 'warn',
    text: 'INSIDER_HOLDINGS_NOT_PARSED — Form 3/4/5 documents are not parsed in v1: the filings are listed, with no share counts or transactions. Press Enter to open the filing on sec.gov.',
  };

  const grid: Node = {
    kind: 'grid',
    id: 'insiders',
    columns: [
      { id: 'filed', label: 'Filed', align: 'left', fmt: 'date' },
      { id: 'form', label: 'Form', align: 'left' },
      { id: 'accepted', label: 'Accepted', align: 'left', fmt: 'datetime' },
      { id: 'report', label: 'Report', align: 'left', fmt: 'date' },
      { id: 'description', label: 'Description', align: 'left', width: 50 },
      { id: 'accession', label: 'Accession', align: 'left' },
    ],
    rows: p.insiders.filings.map((f) => ({
      id: `insider:${f.accessionNo}`,
      cells: {
        filed: textCell(f.filedDate, { fmt: 'date' }),
        form: textCell(f.form),
        accepted: textCell(f.acceptedAt, { fmt: 'datetime' }),
        report: textCell(f.reportDate, { fmt: 'date' }),
        description: textCell(f.primaryDocDesc),
        accession: textCell(f.accessionNo),
      },
    })),
    emptyText: 'No Form 3/4/5 filings stored for this issuer.',
  };

  return [note, grid];
}

function equityBody(p: HdsEquity, notes: Badge[]): Node {
  const shareBase: Node = {
    kind: 'kv',
    id: 'shareBase',
    title: 'Share base',
    columns: 2,
    rows: [
      kvRow('Shares out', cell('EQY_SH_OUT', p.shareBase.sharesOut, { fmt: 'int', decimals: 0 })),
      kvRow('Float %', cell('EQY_FLOAT_PCT', p.shareBase.floatPct, { fmt: 'pct', decimals: 2 })),
      kvRow('Market cap', cell('CUR_MKT_CAP', p.shareBase.marketCap, { fmt: 'ccy', decimals: 0 })),
      kvRow('Last', cell('PX_LAST', p.shareBase.px)),
    ],
  };

  const summary: Node = {
    kind: 'kv',
    id: 'summary',
    title: 'Holders summary',
    columns: 3,
    rows: [
      kvRow('Holders', countCell(p.summary.holderCount)),
      kvRow('Shares held', numCell('HLD_SHARES_HELD', p.summary.sharesHeld, p.summary.provIdx, { fmt: 'int', decimals: 0 })),
      kvRow('Value held', numCell('HLD_MKT_VAL', p.summary.marketValueHeld, p.summary.provIdx, { fmt: 'ccy', decimals: 0 })),
      kvRow('% shares out', numCell('HLD_PCT_OUT', p.summary.pctSharesOutHeld, p.summary.provIdx, { fmt: 'pct', decimals: 2 })),
      kvRow('As of', textCell(p.summary.asOfDate, { fieldId: 'HLD_AS_OF_DT', fmt: 'date' })),
      kvRow('Sources', textCell(p.summary.sources.join(', '))),
    ],
  };

  const holdersBody = stack('col', [summary, holdersGrid(p)], [0.24, 0.76]);
  const insidersBody = stack('col', insidersNodes(p), [0.12, 0.88]);

  const tabs: Node = {
    kind: 'tabs',
    id: 'view',
    active: p.view,
    tabs: VIEW_TABS.map((t, i) => ({
      id: t.id,
      label: t.label,
      key: String(i + 1),
      body: t.id === p.view ? (t.id === 'HOLDERS' ? holdersBody : insidersBody) : { kind: 'text' as const, id: `tab-${t.id}`, text: `Press ${String(i + 1)} for ${t.label}.`, tone: 'muted' as const },
    })),
  };

  return stack('col', [shareBase, { kind: 'badges', id: 'reason', items: notes }, tabs], [0.14, 0.06, 0.8]);
}

function fundBody(p: HdsFund, notes: Badge[]): Node {
  const fundKv: Node = {
    kind: 'kv',
    id: 'fund',
    title: 'Fund',
    columns: 2,
    rows: [
      kvRow('Sponsor', textCell(p.fund.sponsor)),
      kvRow('Fund type', textCell(p.fund.fundType)),
      kvRow('Expense ratio', countCell(p.fund.expenseRatio, 'pct', 2)),
      kvRow(
        'Tracks',
        textCell(p.fund.trackedIndex?.key ?? null, p.fund.trackedIndex === null ? {} : { command: `${p.fund.trackedIndex.key} MEMB` }),
      ),
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

  const holdings: Node = {
    kind: 'grid',
    id: 'holdings',
    columns: [
      { id: 'key', label: 'Security', align: 'left', sortable: true },
      { id: 'name', label: 'Name', align: 'left', sortable: true },
      { id: 'shares', label: 'Shares', align: 'right', fieldId: 'IDX_MEMBER_SHARES', fmt: 'int' },
      { id: 'value', label: 'Market value', align: 'right', fieldId: 'IDX_MEMBER_MKT_VAL', fmt: 'ccy', decimals: 0 },
      { id: 'weight', label: 'Weight', align: 'right', fieldId: 'IDX_MEMBER_WEIGHT', fmt: 'pct', decimals: 4 },
      { id: 'px', label: 'Px', align: 'right', fieldId: 'PX_LAST', fmt: 'px', live: true },
      { id: 'chgPct', label: 'Chg %', align: 'right', fieldId: 'CHG_PCT_1D', fmt: 'pct', decimals: 2, live: true },
      { id: 'cat', label: 'Cat', align: 'left' },
      { id: 'country', label: 'Country', align: 'left' },
    ],
    rows: p.holdings.map((h) => ({
      id: `hold:${String(h.lineNo)}`,
      cells: {
        key: textCell(h.key ?? h.ticker ?? h.cusip, h.key === null ? {} : { command: `${h.key} DES` }),
        name: textCell(h.name),
        shares: numCell('IDX_MEMBER_SHARES', h.shares, p.file.provIdx, { fmt: 'int', decimals: 0 }),
        value: numCell('IDX_MEMBER_MKT_VAL', h.marketValue, p.file.provIdx, { fmt: 'ccy', decimals: 0 }),
        weight: numCell('IDX_MEMBER_WEIGHT', h.weight, p.file.provIdx, { fmt: 'pct', decimals: 4 }),
        px: cell('PX_LAST', h.px),
        chgPct: cell('CHG_PCT_1D', h.chgPct, { signed: true }),
        cat: textCell(h.assetCat),
        country: textCell(h.country),
      },
      ...(h.holdingInstrumentId === null ? {} : { instrumentId: h.holdingInstrumentId }),
      ...(h.subject === null ? {} : { subject: h.subject }),
      ...(h.key === null ? {} : { command: `${h.key} DES` }),
      tone: h.holdingInstrumentId === null ? ('muted' as const) : ('normal' as const),
    })),
    frozenColumns: 2,
    selectable: true,
    sort: { col: 'weight', dir: 'desc' },
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    emptyText: 'No holdings lines in this file.',
  };

  const assetCat: Node = {
    kind: 'table',
    id: 'assetCat',
    caption: 'By asset category',
    columns: [
      { id: 'assetCat', label: 'Category', type: 'string' },
      { id: 'weight', label: 'Weight', type: 'number', decimals: 2 },
      { id: 'count', label: 'Lines', type: 'number' },
    ],
    rows: p.byAssetCat.map((c) => [
      textCell(c.assetCat),
      numCell('IDX_MEMBER_WEIGHT', c.weight, p.file.provIdx, { fmt: 'pct', decimals: 2 }),
      countCell(c.count),
    ]),
  };

  return stack(
    'col',
    [stack('row', [fundKv, nav], [0.65, 0.35]), { kind: 'badges', id: 'file', items: notes }, holdings, assetCat],
    [0.14, 0.06, 0.6, 0.2],
  );
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, instrument, meta }) => {
  const display = instrument?.display ?? 'security';

  if (payload === undefined) {
    return {
      title: `HDS · ${display}`,
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
          kind: 'grid',
          id: 'holders',
          columns: [
            { id: 'holder', label: 'Holder', align: 'left' },
            { id: 'shares', label: 'Shares', align: 'right' },
            { id: 'value', label: 'Market value', align: 'right' },
          ],
          rows: Array.from({ length: Math.min(params.limit, 25) }, (_v, i) => ({
            id: `skeleton:${String(i)}`,
            cells: { holder: textCell(null) },
            tone: 'muted' as const,
          })),
          emptyText: 'loading…',
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'holders',
    } satisfies ScreenSpec;
  }

  const notes: Badge[] = [];
  if (payload.variant === 'equity') {
    notes.push(
      {
        text: `INSTITUTIONAL ${payload.institutional.reason}`,
        tone: 'warn',
        title: 'No 13F source in the wedge: institutional holders are unavailable, not zero.',
      },
      { text: 'ETF/FUND HOLDERS ONLY', tone: 'info', title: 'Holders are read from captured fund holdings files.' },
      {
        text: payload.insiders.reason,
        tone: 'warn',
        title: 'Form 3/4/5 ownership documents are not parsed in v1; the filings are listed instead.',
      },
    );
  } else {
    notes.push({
      text: `FILE ${payload.file.asOfDate} · ${payload.file.sourceId} · ${String(payload.file.count)} lines`,
      tone: 'info',
      title: payload.file.netAssets === null ? 'Net assets not reported in this file.' : `Net assets ${String(payload.file.netAssets)}`,
    });
    if (payload.unresolved.reason !== null) {
      notes.push({
        text: `${payload.unresolved.reason} ${String(payload.unresolved.count)}`,
        tone: 'warn',
        title: 'Lines whose identifier resolves to nothing in the master keep their place, unpriced.',
      });
    }
  }
  for (const note of payload.notes) notes.push({ text: note, tone: 'warn' });
  notes.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));

  if (payload.variant === 'fund') {
    return {
      title: `HDS · ${display} · ${payload.fund.name} · Holdings`,
      subtitle: `Holdings · ${payload.file.sourceId} ${payload.file.asOfDate}`,
      body: fundBody(payload, notes),
      footer: footer(meta, [
        `${String(payload.file.count)} lines, ${String(payload.unresolved.count)} unresolved`,
        ...payload.notes,
      ]),
      initialFocus: 'holdings',
    } satisfies ScreenSpec;
  }

  return {
    title:
      payload.view === 'INSIDERS'
        ? `HDS · ${display} · ${payload.security.name} · Insider filings`
        : `HDS · ${display} · ${payload.security.name} · Holders`,
    subtitle:
      payload.view === 'INSIDERS'
        ? 'Insider filings'
        : `Holders · as of ${payload.summary.asOfDate ?? '—'}`,
    body: equityBody(payload, notes),
    footer: footer(meta, payload.notes),
    initialFocus: payload.view === 'INSIDERS' ? 'insiders' : 'holders',
  } satisfies ScreenSpec;
};

export default Screen;
