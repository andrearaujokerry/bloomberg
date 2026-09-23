// packages/web/src/screens/MEMB/Screen.tsx — Index Members (FUNCTIONS_TIER2.md §MEMB "Screen").
//
// The constituent list, its weights, and — the part the footer exists for — an honest statement of
// where those weights came from. When membership is read through a tracking fund's N-PORT file,
// the weights are the FUND's holdings on the file date, not the index provider's list, and the
// screen says exactly that in `badges#basis` and in the footer note.
//
// Three layouts on one variant: the plain member grid, the grouped grid with its subtotal table
// (`groupBy`), and the adds/drops/moves grids when a `compareDate` is set (REF-07). An index with
// no membership source gets the fourth: a `NO_MEMBERSHIP_SOURCE` chip and a note that says what IS
// available, rather than an empty grid.
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

type Params = ParamsOf<'MEMB'>;
type Payload = PayloadOf<'MEMB'>;
type Member = Payload['members'][number];

const VIA_NOTE =
  "Weights are the tracking fund's holdings as of the file date, not the index provider's list.";

function memberColumns(): GridColumn[] {
  return [
    { id: 'key', label: 'Security', align: 'left', sortable: true },
    { id: 'name', label: 'Name', align: 'left', sortable: true },
    { id: 'sector', label: 'GICS sector', align: 'left', fieldId: 'GICS_SECTOR_NAME', sortable: true },
    { id: 'weight', label: 'Weight', align: 'right', fieldId: 'IDX_MEMBER_WEIGHT', fmt: 'pct', decimals: 4, sortable: true },
    { id: 'shares', label: 'Shares', align: 'right', fieldId: 'IDX_MEMBER_SHARES', fmt: 'int' },
    { id: 'value', label: 'Market value', align: 'right', fieldId: 'IDX_MEMBER_MKT_VAL', fmt: 'ccy', decimals: 0 },
    { id: 'px', label: 'Px', align: 'right', fieldId: 'PX_LAST', fmt: 'px', live: true },
    { id: 'chgPct', label: 'Chg %', align: 'right', fieldId: 'CHG_PCT_1D', fmt: 'pct', decimals: 2, live: true },
    { id: 'contrib', label: 'Contrib bp', align: 'right', fmt: 'bp', decimals: 1 },
    { id: 'country', label: 'Country', align: 'left', fieldId: 'CNTRY_OF_ISSUE' },
  ];
}

function memberRow(m: Member, provIdx: number, groupBy: Params['groupBy']): GridRow {
  const group =
    groupBy === 'gics_sector'
      ? (m.gicsSector ?? '—')
      : groupBy === 'country'
        ? (m.country ?? '—')
        : groupBy === 'asset_cat'
          ? (m.assetCat ?? '—')
          : undefined;
  return {
    id: `memb:${m.key ?? m.name}`,
    cells: {
      key: textCell(m.key ?? m.ticker ?? m.cusip, m.key === null ? {} : { command: `${m.key} DES` }),
      name: textCell(m.name),
      sector: textCell(m.gicsSector, { fieldId: 'GICS_SECTOR_NAME' }),
      weight: numCell('IDX_MEMBER_WEIGHT', m.weight, provIdx, { fmt: 'pct', decimals: 4 }),
      shares: numCell('IDX_MEMBER_SHARES', m.shares, provIdx, { fmt: 'int', decimals: 0 }),
      value: numCell('IDX_MEMBER_MKT_VAL', m.marketValue, provIdx, { fmt: 'ccy', decimals: 0 }),
      px: cell('PX_LAST', m.px),
      chgPct: cell('CHG_PCT_1D', m.chgPct, { signed: true }),
      // `contribPct` is `weight × chgPct`, shown in basis points; it has no dictionary field, so it
      // cites the membership capture its weight came from and nothing else.
      contrib: countCell(m.contribPct === null ? null : m.contribPct * 100, 'bp', 1),
      country: textCell(m.country, { fieldId: 'CNTRY_OF_ISSUE' }),
    },
    ...(group === undefined ? {} : { group }),
    ...(m.instrumentId === null ? {} : { instrumentId: m.instrumentId }),
    ...(m.subject === null ? {} : { subject: m.subject }),
    ...(m.key === null ? {} : { command: `${m.key} DES` }),
    tone: m.instrumentId === null ? 'muted' : 'normal',
  };
}

function changeGrid(
  id: string,
  label: string,
  rows: readonly { instrumentId: number | null; key: string | null; name: string; weight: number | null }[],
  provIdx: number,
  tone: 'highlight' | 'muted',
): Node {
  return {
    kind: 'grid',
    id,
    columns: [
      { id: 'key', label: 'Security', align: 'left' },
      { id: 'name', label: 'Name', align: 'left' },
      { id: 'weight', label: 'Weight', align: 'right', fieldId: 'IDX_MEMBER_WEIGHT', fmt: 'pct', decimals: 4 },
    ],
    rows: rows.map((r) => ({
      id: `${id}:${r.key ?? r.name}`,
      cells: {
        key: textCell(r.key, r.key === null ? {} : { command: `${r.key} DES` }),
        name: textCell(r.name),
        weight: numCell('IDX_MEMBER_WEIGHT', r.weight, provIdx, { fmt: 'pct', decimals: 4 }),
      },
      ...(r.instrumentId === null ? {} : { instrumentId: r.instrumentId }),
      ...(r.key === null ? {} : { command: `${r.key} DES` }),
      tone,
    })),
    emptyText: `No ${label.toLowerCase()} between the two dates.`,
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta }) => {
  if (payload === undefined) {
    return {
      title: 'MEMB · Index Members',
      subtitle: 'loading…',
      body: stack('col', [
        {
          kind: 'kv',
          id: 'index',
          columns: 3,
          rows: [
            kvRow('Provider', textCell(null)),
            kvRow('Methodology', textCell(null)),
            kvRow('Currency', textCell(null)),
            kvRow('Members', textCell(null)),
            kvRow('As of', textCell(null)),
          ],
        },
        {
          kind: 'grid',
          id: 'members',
          columns: memberColumns(),
          rows: Array.from({ length: Math.min(params.limit, 25) }, (_v, i) => ({
            id: `skeleton:${String(i)}`,
            cells: { key: textCell(null), name: textCell(null) },
            tone: 'muted' as const,
          })),
          emptyText: 'loading…',
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'members',
    } satisfies ScreenSpec;
  }

  const idx = payload.index;
  const ms = payload.membership;
  const noSource = payload.members.length === 0 && ms.count === 0;

  const basis: Badge[] = [];
  if (ms.via.kind === 'proxy_fund') {
    basis.push({
      text: `VIA ${ms.via.key} N-PORT · MEMBERSHIP_VIA_PROXY_FUND`,
      tone: 'info',
      title: VIA_NOTE,
    });
  } else {
    basis.push({ text: 'DIRECT MEMBERSHIP', tone: 'info', title: 'Published constituent file.' });
  }
  basis.push({ text: `SOURCE ${ms.sourceId}`, tone: 'info', title: `As of ${ms.asOfDate}` });
  basis.push({
    text: `${String(payload.unresolved.count)} unresolved`,
    tone: payload.unresolved.count === 0 ? 'ok' : 'warn',
    title:
      payload.unresolved.reason === null
        ? 'Every line resolved to a security in the master.'
        : `${payload.unresolved.reason}: a line whose identifier resolves to nothing keeps its place, with no key and no price.`,
  });
  for (const note of payload.notes) basis.push({ text: note, tone: 'warn' });
  basis.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));

  const indexKv: Node = {
    kind: 'kv',
    id: 'index',
    title: idx.name,
    columns: 3,
    rows: [
      kvRow('Provider', textCell(idx.provider, { fieldId: 'IDX_PROVIDER' })),
      kvRow('Methodology', textCell(idx.methodology)),
      kvRow('Currency', textCell(idx.calcCurrency, { fieldId: 'CRNCY' })),
      kvRow('Members', numCell('IDX_MEMBER_COUNT', ms.count, ms.provIdx, { fmt: 'int', decimals: 0 })),
      kvRow('Σ weight', numCell('IDX_MEMBER_WEIGHT', ms.weightSum, ms.provIdx, { fmt: 'pct', decimals: 2 })),
      kvRow('As of', textCell(ms.asOfDate, { fieldId: 'IDX_MEMBER_ASOF', fmt: 'date' })),
      kvRow('Available dates', textCell(ms.availableDates.join(', '))),
    ],
  };

  if (noSource) {
    return {
      title: `MEMB · ${idx.key} · ${idx.name} · Members`,
      subtitle: `Members · ${ms.sourceId} ${ms.asOfDate}`,
      body: stack(
        'col',
        [
          {
            kind: 'badges',
            id: 'reason',
            items: [
              { text: 'NO_MEMBERSHIP_SOURCE', tone: 'error', title: 'No constituent source is reachable for this index.' },
              ...basis,
            ],
          },
          {
            kind: 'text',
            id: 'note',
            tone: 'warn',
            text: `No constituent source is reachable for ${idx.key}: it has no N-PORT proxy fund and no published holdings file. The index level and its history are available — press G for GP, W for WEI.`,
          },
        ],
        [0.2, 0.8],
      ),
      footer: footer(meta, payload.notes),
      initialFocus: 'note',
    } satisfies ScreenSpec;
  }

  const members: Node = {
    kind: 'grid',
    id: 'members',
    columns: memberColumns(),
    rows: payload.members.map((m) => memberRow(m, ms.provIdx, params.groupBy)),
    frozenColumns: 2,
    selectable: true,
    sort: { col: 'weight', dir: 'desc' },
    ...(params.groupBy === 'none' ? {} : { groupBy: params.groupBy }),
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    page: { index: meta?.page?.index ?? 0, count: meta?.page?.count ?? 1 },
    emptyText: 'No members on this page.',
  };

  const children: Node[] = [indexKv, { kind: 'badges', id: 'basis', items: basis }];

  if (payload.groups.length > 0) {
    children.push({
      kind: 'table',
      id: 'groups',
      caption: `Subtotals by ${params.groupBy}`,
      columns: [
        { id: 'group', label: 'Group', type: 'string' },
        { id: 'weight', label: 'Weight', type: 'number', decimals: 2 },
        { id: 'count', label: 'Members', type: 'number' },
        { id: 'chg', label: 'Wtd chg %', type: 'number', decimals: 2 },
      ],
      rows: payload.groups.map((g) => [
        textCell(g.label),
        numCell('IDX_MEMBER_WEIGHT', g.weight, ms.provIdx, { fmt: 'pct', decimals: 2 }),
        countCell(g.count),
        countCell(g.chgPctWeighted, 'pct', 2),
      ]),
    });
  }

  children.push(members);

  const ch = payload.changes;
  if (ch !== null) {
    children.push({
      kind: 'badges',
      id: 'compare',
      items: [
        {
          text: `VS ${ch.compareDate} · ${String(ch.adds.length)} adds · ${String(ch.drops.length)} drops`,
          tone: 'info',
          title: `Compared against ${ch.compareSourceId} (REF-07).`,
        },
      ],
    });
    children.push(changeGrid('adds', 'Adds', ch.adds, ch.provIdx, 'highlight'));
    children.push(changeGrid('drops', 'Drops', ch.drops, ch.provIdx, 'muted'));
    children.push({
      kind: 'grid',
      id: 'moves',
      columns: [
        { id: 'key', label: 'Security', align: 'left' },
        { id: 'name', label: 'Name', align: 'left' },
        { id: 'from', label: 'From', align: 'right', fieldId: 'IDX_MEMBER_WEIGHT', fmt: 'pct', decimals: 4 },
        { id: 'to', label: 'To', align: 'right', fieldId: 'IDX_MEMBER_WEIGHT', fmt: 'pct', decimals: 4 },
        { id: 'delta', label: 'Δ bp', align: 'right', fmt: 'bp', decimals: 1 },
      ],
      rows: ch.weightMoves.map((m) => ({
        id: `move:${m.key ?? m.name}`,
        cells: {
          key: textCell(m.key, m.key === null ? {} : { command: `${m.key} DES` }),
          name: textCell(m.name),
          from: numCell('IDX_MEMBER_WEIGHT', m.weightFrom, ch.provIdx, { fmt: 'pct', decimals: 4 }),
          to: numCell('IDX_MEMBER_WEIGHT', m.weightTo, ch.provIdx, { fmt: 'pct', decimals: 4 }),
          delta: countCell(m.deltaBp, 'bp', 1),
        },
        ...(m.instrumentId === null ? {} : { instrumentId: m.instrumentId }),
        ...(m.key === null ? {} : { command: `${m.key} DES` }),
      })),
      emptyText: 'No weight moves between the two dates.',
    });
  }

  return {
    title: `MEMB · ${idx.key} · ${idx.name} · Members`,
    subtitle: `Members · ${ms.sourceId} ${ms.asOfDate}${ch === null ? '' : ` · vs ${ch.compareDate}`}`,
    body: stack('col', children),
    footer: footer(meta, [VIA_NOTE, ...payload.notes]),
    initialFocus: 'members',
  } satisfies ScreenSpec;
};

export default Screen;
