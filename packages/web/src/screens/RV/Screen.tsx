// packages/web/src/screens/RV/Screen.tsx — Relative Valuation (FUNCTIONS_TIER2.md §RV "Screen").
//
// The target against its peer group, and the peer group against itself. Two rules of this screen
// are structural rather than cosmetic:
//
//   * a peer with `dataState:'none'` STAYS on the grid, muted, every multiple an em dash and its
//     `unavailableReason` on the row — a silently shorter peer list is a lie about the peer set;
//   * a statistic whose `reason` is `INSUFFICIENT_PEERS` renders `—` in every row of that column,
//     because a median over two names is not a median.
//
// Pure: no DOM, no state, no IO.

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
  EM_DASH,
  blankCell,
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

type Params = ParamsOf<'RV'>;
type Payload = PayloadOf<'RV'>;
type RvRow = Payload['peers'][number];
type RvStat = Payload['stats'][number];

/** The ten statistics rows of `table#stats`, in the order §RV lists them. */
const STAT_ROWS: readonly { id: string; label: string; of: (s: RvStat) => number | null }[] = [
  { id: 'min', label: 'min', of: (s) => s.min },
  { id: 'p25', label: 'p25', of: (s) => s.p25 },
  { id: 'median', label: 'median', of: (s) => s.median },
  { id: 'p75', label: 'p75', of: (s) => s.p75 },
  { id: 'max', label: 'max', of: (s) => s.max },
  { id: 'mean', label: 'mean', of: (s) => s.mean },
  { id: 'n', label: 'n', of: (s) => s.n },
  { id: 'target', label: 'target', of: (s) => s.target },
  { id: 'percentile', label: '%ile', of: (s) => s.targetPercentile },
  { id: 'premium', label: 'prem/disc vs med', of: (s) => s.premiumToMedianPct },
];

function peerColumns(p: Payload): GridColumn[] {
  const columns: GridColumn[] = [
    { id: 'key', label: 'Security', align: 'left', sortable: true },
    { id: 'name', label: 'Name', align: 'left', sortable: true },
  ];
  for (const m of p.metrics) {
    const col: GridColumn = {
      id: m.id,
      label: m.label,
      fmt: m.fmt,
      align: m.fmt === 'text' || m.fmt === 'date' || m.fmt === 'datetime' ? 'left' : 'right',
      sortable: true,
      live: true,
    };
    if (m.fieldId !== undefined) col.fieldId = m.fieldId;
    if (m.decimals !== undefined) col.decimals = m.decimals;
    columns.push(col);
  }
  columns.push({ id: 'state', label: 'Data', align: 'left' });
  return columns;
}

function peerRow(r: RvRow, p: Payload): GridRow {
  const cells: GridRow['cells'] = {
    key: textCell(r.key, { command: `${r.key} DES` }),
    name: textCell(r.name),
    state: textCell(r.dataState === 'none' ? (r.unavailableReason ?? 'none') : r.dataState),
  };
  for (const m of p.metrics) {
    const vc = r.cells[m.id];
    if (vc === undefined) {
      cells[m.id] = m.fieldId === undefined ? blankCell() : blankCell(m.fieldId);
      continue;
    }
    const opts = m.decimals === undefined ? { fmt: m.fmt } : { fmt: m.fmt, decimals: m.decimals };
    cells[m.id] =
      m.fieldId === undefined
        ? computedCell(vc, m.fmt, m.decimals)
        : cell(m.fieldId, vc, { ...opts, signed: m.id.startsWith('CHG_') || m.id.startsWith('RET_') });
  }
  return {
    id: `rv:${String(r.instrumentId)}`,
    cells,
    subject: r.subject,
    instrumentId: r.instrumentId,
    command: `${r.key} DES`,
    tone: r.isTarget ? 'highlight' : r.dataState === 'none' ? 'muted' : 'normal',
  };
}

function statsTable(p: Payload): Node {
  const rows: Cell[][] = STAT_ROWS.map((sr) => {
    const line: Cell[] = [textCell(sr.label)];
    p.stats.forEach((s, i) => {
      const m = p.metrics[i];
      const fmt: NonNullable<Cell['fmt']> = sr.id === 'n' ? 'int' : sr.id === 'percentile' || sr.id === 'premium' ? 'pct' : (m?.fmt ?? 'px');
      const decimals = sr.id === 'n' ? 0 : (m?.decimals ?? 2);
      if (s.reason === 'INSUFFICIENT_PEERS' && sr.id !== 'n') {
        line.push(textCell(EM_DASH));
        return;
      }
      line.push(countCell(sr.of(s), fmt, decimals));
    });
    return line;
  });

  return {
    kind: 'table',
    id: 'stats',
    caption: `Peer statistics · ${p.periodType} · target excluded from n`,
    columns: [
      { id: 'stat', label: 'Stat', type: 'string' },
      ...p.metrics.map((m) => ({ id: m.id, label: m.label, type: 'number' as const })),
    ],
    rows,
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, instrument, meta }) => {
  const display = instrument?.display ?? 'security';

  if (payload === undefined) {
    return {
      title: `RV · ${display}`,
      subtitle: 'loading…',
      body: stack('col', [
        {
          kind: 'kv',
          id: 'basis',
          columns: 1,
          rows: [
            kvRow('Basis', textCell(null)),
            kvRow('Period', textCell(null)),
            kvRow('Known at', textCell(null)),
          ],
        },
        {
          kind: 'grid',
          id: 'peers',
          columns: [
            { id: 'key', label: 'Security', align: 'left' },
            { id: 'name', label: 'Name', align: 'left' },
            ...params.metrics.map((m): GridColumn => ({ id: m, label: m, align: 'right' })),
          ],
          rows: Array.from({ length: params.maxPeers }, (_v, i) => ({
            id: `skeleton:${String(i)}`,
            cells: { key: textCell(null), name: textCell(null) },
            tone: 'muted' as const,
          })),
          emptyText: 'loading…',
        },
        {
          kind: 'table',
          id: 'stats',
          columns: [{ id: 'stat', label: 'Stat', type: 'string' }],
          rows: STAT_ROWS.map((s) => [textCell(s.label)]),
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'peers',
    } satisfies ScreenSpec;
  }

  const ps = payload.peerSet;
  const basis: Node = {
    kind: 'kv',
    id: 'basis',
    columns: 3,
    rows: [
      kvRow('Basis', textCell(`${ps.basis}${ps.code === null ? '' : ` (${ps.scheme} ${ps.code})`}`)),
      kvRow('Peer set', textCell(ps.label)),
      kvRow('Restricted to', textCell(ps.restrictedToIndex)),
      kvRow('Peers', textCell(`${String(ps.returned)} of ${String(ps.candidates)} shown`)),
      kvRow('Period', textCell(payload.periodType)),
      kvRow('Known at', textCell(payload.knownAt, { fmt: 'datetime' })),
    ],
  };

  const state: Badge[] = [];
  if (ps.candidates > ps.returned) {
    state.push({
      text: `PEERS_TRUNCATED ${String(ps.candidates)}→${String(ps.returned)}`,
      tone: 'warn',
      title: 'The peer set is larger than `maxPeers`; press + for more.',
    });
  }
  const missing = payload.peers.filter((r) => r.dataState !== 'full').length;
  if (missing > 0) {
    state.push({
      text: `FUNDAMENTALS_NOT_INGESTED ${String(missing)}/${String(payload.peers.length)}`,
      tone: 'warn',
      title: 'Peers with no `fin_statements` row at this knownAt keep their place on the grid with every multiple blank.',
    });
  }
  state.push({ text: payload.periodType, tone: 'info' });
  for (const note of payload.notes) state.push({ text: note, tone: 'warn' });
  state.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));

  const grid: Node = {
    kind: 'grid',
    id: 'peers',
    columns: peerColumns(payload),
    // The target is always the first row and is never sorted away (§RV grid#peers).
    rows: [peerRow(payload.target, payload), ...payload.peers.map((r) => peerRow(r, payload))],
    frozenColumns: 2,
    selectable: true,
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    emptyText: 'No peers resolved for this basis.',
  };

  return {
    title: `RV · ${display} · ${payload.target.name} · vs ${ps.label}`,
    subtitle: `${ps.label} · ${String(payload.peers.length)} peers · ${payload.periodType}`,
    body: stack(
      'col',
      [basis, { kind: 'badges', id: 'state', items: state }, grid, statsTable(payload)],
      [0.14, 0.06, 0.52, 0.28],
    ),
    footer: footer(meta, payload.notes),
    initialFocus: 'peers',
  } satisfies ScreenSpec;
};

export default Screen;
