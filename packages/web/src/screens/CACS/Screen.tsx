// packages/web/src/screens/CACS/Screen.tsx — Corporate Actions (FUNCTIONS_TIER2.md §CACS "Screen").
//
// The actions timeline, with the DATA-08 lifecycle visible on every row: `estimated → announced →
// confirmed → paid`, plus `cancelled`. A projected row — the resolver's next expected ex-date — is
// muted, badged `PROJECTED` and carries the basis it was derived from, because a projection that
// looks like an announcement is worse than no projection at all.
//
// Two variants: `issuer` (one company's actions and its 8-K earnings timeline) and `members` (an
// index's constituents, grouped by ex-date with the day's weighted total).
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

type Params = ParamsOf<'CACS'>;
type Payload = PayloadOf<'CACS'>;
type CacsIssuer = Extract<Payload, { variant: 'issuer' }>;
type CacsMembers = Extract<Payload, { variant: 'members' }>;
type CacsAction = CacsIssuer['actions'][number];

/** DATA-08's lifecycle as a chip: colour is the state, never the amount. */
function statusBadge(status: CacsAction['status']): Badge {
  switch (status) {
    case 'estimated':
      return { text: 'estimated', tone: 'info', title: 'Derived or pre-announcement; not yet declared.' };
    case 'announced':
      return { text: 'announced', tone: 'info', title: 'Declared by the issuer.' };
    case 'confirmed':
      return { text: 'confirmed', tone: 'ok', title: 'Confirmed against a second source.' };
    case 'paid':
      return { text: 'paid', tone: 'ok', title: 'Paid.' };
    case 'cancelled':
      return { text: 'cancelled', tone: 'error', title: 'Cancelled by the issuer.' };
  }
}

function ratioText(a: CacsAction): string | null {
  if (a.ratioNew === null || a.ratioOld === null) return null;
  return `${String(a.ratioNew)}:${String(a.ratioOld)}`;
}

function actionColumns(): GridColumn[] {
  return [
    { id: 'exDate', label: 'Ex-date', align: 'left', fmt: 'date', sortable: true },
    { id: 'type', label: 'Type', align: 'left' },
    { id: 'status', label: 'Status', align: 'left' },
    { id: 'amount', label: 'Amount', align: 'right', fieldId: 'CA_AMOUNT', fmt: 'ccy', decimals: 4 },
    { id: 'ratio', label: 'Ratio', align: 'left' },
    { id: 'declared', label: 'Declared', align: 'left', fmt: 'date' },
    { id: 'record', label: 'Record', align: 'left', fmt: 'date' },
    { id: 'pay', label: 'Pay', align: 'left', fmt: 'date' },
    { id: 'adjFactor', label: 'Adj factor', align: 'right', fieldId: 'ADJ_FACTOR_PX', fmt: 'px', decimals: 5 },
    { id: 'source', label: 'Source', align: 'left' },
    { id: 'review', label: 'Review', align: 'left' },
  ];
}

function actionRow(a: CacsAction, validAt: string): GridRow {
  const future = a.exDate >= validAt.slice(0, 10);
  return {
    id: `ca:${a.caId === null ? `proj:${a.exDate}:${a.key}` : String(a.caId)}`,
    cells: {
      exDate: textCell(a.exDate, { fmt: 'date' }),
      type: textCell(a.projected ? `${a.caType} (PROJECTED)` : a.caType),
      status: textCell(statusBadge(a.status).text),
      amount: numCell('CA_AMOUNT', a.amount, a.provIdx, { fmt: 'ccy', decimals: 4 }),
      ratio: textCell(ratioText(a)),
      declared: textCell(a.declaredDate, { fmt: 'date' }),
      record: textCell(a.recordDate, { fmt: 'date' }),
      pay: textCell(a.payDate, { fmt: 'date' }),
      adjFactor: numCell('ADJ_FACTOR_PX', a.adjFactor, a.provIdx, { fmt: 'px', decimals: 5 }),
      source: textCell(a.sourceId),
      review: textCell(a.reviewState),
    },
    instrumentId: a.instrumentId,
    command: `${a.key} DES`,
    tone: a.projected ? 'muted' : future ? 'highlight' : 'normal',
  };
}

function issuerBody(p: CacsIssuer, notes: Badge[], validAt: string): Node {
  const s = p.summary;
  const summary: Node = {
    kind: 'kv',
    id: 'summary',
    title: 'Summary',
    columns: 3,
    rows: [
      kvRow('TTM dividend', numCell('DVD_SH_12M', s.ttmCashDividend, -1, { fmt: 'ccy', decimals: 4 })),
      kvRow('TTM payments', countCell(s.ttmCount)),
      kvRow('Frequency', textCell(s.frequency)),
      kvRow('Yield', cell('DVD_YIELD', s.dvdYield)),
      kvRow('Last', cell('PX_LAST', s.pxLast)),
      kvRow(
        'Last split',
        textCell(
          s.lastSplit === null
            ? null
            : `${String(s.lastSplit.ratioNew)}:${String(s.lastSplit.ratioOld)} ${s.lastSplit.exDate}`,
        ),
      ),
      kvRow('Cumulative adj factor', countCell(s.cumulativeAdjFactor, 'px', 5)),
      kvRow('Next (projected)', textCell(s.nextProjected?.exDate ?? null, { fmt: 'date' })),
      kvRow('Next amount (est.)', countCell(s.nextProjected?.amount ?? null, 'ccy', 4)),
    ],
  };

  const actions: Node = {
    kind: 'grid',
    id: 'actions',
    columns: actionColumns(),
    rows: p.actions.map((a) => actionRow(a, validAt)),
    frozenColumns: 1,
    selectable: true,
    sort: { col: 'exDate', dir: 'desc' },
    emptyText: 'No corporate actions in this window at this knownAt.',
  };

  const earnings: Node = {
    kind: 'grid',
    id: 'earnings',
    columns: [
      { id: 'acceptedAt', label: 'Reported', align: 'left', fmt: 'datetime' },
      { id: 'timing', label: 'Timing', align: 'left' },
      { id: 'form', label: 'Form', align: 'left' },
      { id: 'items', label: 'Items', align: 'left' },
      { id: 'accession', label: 'Accession', align: 'left' },
    ],
    rows: p.earnings.map((e) => ({
      id: `earn:${e.accessionNo}`,
      cells: {
        acceptedAt: textCell(e.acceptedAt, { fmt: 'datetime' }),
        timing: textCell(e.reportTiming),
        form: textCell(e.form),
        items: textCell(e.items8k.join(', ')),
        accession: textCell(e.accessionNo),
      },
    })),
    emptyText: 'No 8-K item 2.02 filings stored in this window.',
  };

  return stack(
    'col',
    [summary, { kind: 'badges', id: 'notes', items: notes }, actions, earnings],
    [0.2, 0.06, 0.5, 0.24],
  );
}

function membersBody(p: CacsMembers, notes: Badge[], validAt: string): Node {
  const scope: Badge[] = [
    {
      text: `top ${String(p.membership.shown)} of ${String(p.membership.total)} by weight · membership ${p.membership.asOfDate} · coverage ${(p.summary.coverage * 100).toFixed(0)}%`,
      tone: 'info',
      title: `Source ${p.membership.sourceId}`,
    },
    ...notes,
  ];

  const columns: GridColumn[] = [
    { id: 'exDate', label: 'Ex-date', align: 'left', fmt: 'date' },
    { id: 'member', label: 'Member', align: 'left' },
    { id: 'weight', label: 'Wt %', align: 'right', fieldId: 'IDX_MEMBER_WEIGHT', fmt: 'pct', decimals: 2 },
    { id: 'type', label: 'Type', align: 'left' },
    { id: 'status', label: 'Status', align: 'left' },
    { id: 'amount', label: 'Amount', align: 'right', fieldId: 'CA_AMOUNT', fmt: 'ccy', decimals: 4 },
    { id: 'weighted', label: 'Weighted', align: 'right', fmt: 'ccy', decimals: 6 },
    { id: 'ratio', label: 'Ratio', align: 'left' },
    { id: 'source', label: 'Source', align: 'left' },
  ];

  const actions: Node = {
    kind: 'grid',
    id: 'actions',
    columns,
    rows: p.actions.map((a) => ({
      id: `ca:${a.caId === null ? `proj:${a.exDate}:${a.key}` : String(a.caId)}`,
      cells: {
        exDate: textCell(a.exDate, { fmt: 'date' }),
        member: textCell(a.key, { command: `${a.key} DES` }),
        weight: numCell('IDX_MEMBER_WEIGHT', a.weight, p.membership.provIdx, { fmt: 'pct', decimals: 2 }),
        type: textCell(a.caType),
        status: textCell(a.status),
        amount: numCell('CA_AMOUNT', a.amount, a.provIdx, { fmt: 'ccy', decimals: 4 }),
        weighted: countCell(a.weightedAmount, 'ccy', 6),
        ratio: textCell(ratioText(a)),
        source: textCell(a.sourceId),
      },
      group: a.exDate,
      instrumentId: a.instrumentId,
      command: `${a.key} DES`,
      tone: a.exDate >= validAt.slice(0, 10) ? ('highlight' as const) : ('normal' as const),
    })),
    groupBy: 'exDate',
    frozenColumns: 2,
    selectable: true,
    emptyText: 'No member corporate actions in this window.',
  };

  const summary: Node = {
    kind: 'kv',
    id: 'summary',
    title: 'Summary',
    columns: 3,
    rows: [
      kvRow('Upcoming ex-dates', countCell(p.summary.exDateCount)),
      kvRow('Weighted cash per index unit', countCell(p.summary.weightedCashPerIndexUnit, 'ccy', 4)),
      kvRow('Coverage', countCell(p.summary.coverage, 'pct', 2)),
    ],
  };

  return stack('col', [{ kind: 'badges', id: 'scope', items: scope }, actions, summary], [0.08, 0.72, 0.2]);
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, instrument, meta }) => {
  const display = instrument?.display ?? 'security';

  if (payload === undefined) {
    return {
      title: `CACS · ${display} · Corporate Actions`,
      subtitle: 'loading…',
      body: stack('col', [
        {
          kind: 'kv',
          id: 'summary',
          columns: 2,
          rows: [
            kvRow('TTM dividend', textCell(null)),
            kvRow('Yield', textCell(null)),
            kvRow('Last split', textCell(null)),
            kvRow('Next (projected)', textCell(null)),
          ],
        },
        {
          kind: 'grid',
          id: 'actions',
          columns: actionColumns(),
          rows: Array.from({ length: 12 }, (_v, i) => ({
            id: `skeleton:${String(i)}`,
            cells: { exDate: textCell(null) },
            tone: 'muted' as const,
          })),
          emptyText: 'loading…',
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'actions',
    } satisfies ScreenSpec;
  }

  const validAt = meta?.asOf.validAt ?? payload.knownAt;
  const notes: Badge[] = [
    { text: `KNOWN AT ${payload.knownAt.slice(0, 10)}`, tone: 'info', title: 'Point-in-time (STOR-06, REF-03).' },
  ];
  if (params.includeProjected) {
    notes.push({
      text: 'PROJECTED ROW',
      tone: 'info',
      title: 'The next expected ex-date is derived from the issuer’s own cadence and is never written to `corporate_actions`.',
    });
  }
  for (const note of payload.notes) notes.push({ text: note, tone: 'warn' });
  notes.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));

  if (payload.variant === 'members') {
    return {
      title: `CACS · ${payload.index.key} · ${payload.index.name} · Member Corporate Actions`,
      subtitle: `${payload.window.from} … ${payload.window.to} · knownAt ${payload.knownAt.slice(0, 10)}`,
      body: membersBody(payload, notes, validAt),
      footer: footer(meta, payload.notes),
      initialFocus: 'actions',
    } satisfies ScreenSpec;
  }

  return {
    title: `CACS · ${display} · ${payload.security.name} · Corporate Actions`,
    subtitle: `${payload.window.from} … ${payload.window.to} · knownAt ${payload.knownAt.slice(0, 10)}`,
    body: issuerBody(payload, notes, validAt),
    footer: footer(meta, payload.notes),
    initialFocus: 'actions',
  } satisfies ScreenSpec;
};

export default Screen;
