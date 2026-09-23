// packages/web/src/screens/NI/Screen.tsx — News by Topic (FUNCTIONS_TIER1 §NI "Screen").
//
// The topic tree on the left with its 24-hour and 7-day counts, the selected topic's headlines on
// the right. A topic with no feed and no keyword set behind it is not shown as "0 headlines": it is
// shown as `TOPIC_NO_SOURCE`, because an empty list and an unmapped topic are different answers.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type { FunctionScreen, GridColumn, GridRow, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import { newsList } from '../shared/newsList.js';
import { healthBadges } from '../TOP/Screen.js';
import {
  countCell,
  entitlementBadges,
  footer,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'NI'>;
type Payload = PayloadOf<'NI'>;

const TOPIC_COLUMNS: GridColumn[] = [
  { id: 'code', label: 'Code', align: 'left', sortable: true },
  { id: 'name', label: 'Name', align: 'left', sortable: true },
  { id: 'count24h', label: '24h', fmt: 'int', align: 'right', sortable: true },
  { id: 'count7d', label: '7d', fmt: 'int', align: 'right', sortable: true },
  { id: 'lastPublishedAt', label: 'Last', fmt: 'datetime', align: 'left' },
];

/** Child rows are indented two spaces under their parent; the selected one is marked `▸`. */
function topicRows(p: Payload): GridRow[] {
  return p.topics.map((t) => {
    const sourceless = t.reason === 'TOPIC_NO_SOURCE';
    const selected = p.selected !== null && p.selected.code === t.code;
    const indent = t.parentCode === null ? '' : '  ';
    return {
      id: `topic:${t.code}`,
      cells: {
        code: textCell(`${selected ? '▸' : ' '}${indent}${t.code}`),
        name: textCell(t.name),
        count24h: sourceless ? textCell(null) : countCell(t.count24h),
        count7d: sourceless ? textCell(null) : countCell(t.count7d),
        lastPublishedAt: textCell(t.lastPublishedAt, { fmt: 'datetime' }),
      },
      command: `NI ${t.code}`,
      tone: selected ? ('highlight' as const) : sourceless ? ('muted' as const) : ('normal' as const),
    };
  });
}

/** The right pane is never an unexplained blank: both empty cases carry their own sentence. */
function rowsPane(p: Payload): Node {
  if (p.selected !== null && p.selected.reason === 'TOPIC_NO_SOURCE') {
    return {
      kind: 'text',
      id: 'topicreason',
      tone: 'warn',
      text: `TOPIC_NO_SOURCE — no feed and no keyword set maps to ${p.selected.code}`,
    };
  }
  if (p.rows.length === 0) {
    return {
      kind: 'text',
      id: 'topicreason',
      tone: 'muted',
      text:
        p.selected === null
          ? 'Pick a topic on the left.'
          : `no headlines for ${p.selected.code} in the captured corpus`,
    };
  }
  return newsList('rows', p.rows, {
    showFeed: true,
    showKind: true,
    liveSubject: p.liveSubject,
  });
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta }) => {
  if (payload === undefined) {
    return {
      title: 'NI · News by Topic · browse',
      subtitle: 'loading…',
      body: stack(
        'row',
        [
          {
            kind: 'grid',
            id: 'topics',
            columns: TOPIC_COLUMNS,
            rows: Array.from({ length: 13 }, (_v, i) => ({
              id: `skeleton:${String(i)}`,
              cells: { code: textCell(null) },
              tone: 'muted' as const,
            })),
            emptyText: 'loading…',
          },
          {
            kind: 'list',
            id: 'rows',
            items: Array.from({ length: 10 }, (_v, i) => ({
              id: `skeleton:${String(i)}`,
              primary: '…',
            })),
          },
        ],
        [0.28, 0.72],
      ),
      footer: footer(undefined),
      initialFocus: 'topics',
    } satisfies ScreenSpec;
  }

  const selected = payload.selected;
  const right = rowsPane(payload);
  // The right pane is a headline list, or the sentence that explains why there is none; focus
  // whichever one is actually on screen.
  const rightId = right.kind === 'list' ? 'rows' : 'topicreason';
  const chips = [
    ...healthBadges(payload.feedHealth),
    ...entitlementBadges(meta),
    ...unavailableBadges(meta),
    ...stalenessBadges(meta),
  ];

  const notes: string[] = [];
  if (payload.rolledCodes.length > 0 && params.includeChildren) {
    notes.push(`including child topics: ${payload.rolledCodes.join(', ')}`);
  }
  notes.push(
    `${String(payload.suppressed.kindFilter)} hidden by KIND filter · ${String(payload.suppressed.entitlement)} hidden by entitlement`,
  );

  return {
    title:
      selected === null
        ? 'NI · News by Topic · browse'
        : `NI · News by Topic · ${selected.code} · ${selected.name}`,
    subtitle: `${String(payload.rows.length)} headlines · 24h ${String(selected?.count24h ?? 0)} · 7d ${String(selected?.count7d ?? 0)} · ${payload.asOf.slice(11, 19)}`,
    body: stack(
      'col',
      [
        stack(
          'row',
          [
            {
              kind: 'grid',
              id: 'topics',
              columns: TOPIC_COLUMNS,
              rows: topicRows(payload),
              selectable: true,
              frozenColumns: 1,
              emptyText: 'No topics seeded.',
            },
            right,
          ],
          [0.28, 0.72],
        ),
        { kind: 'badges', id: 'health', items: chips },
      ],
      [0.92, 0.08],
    ),
    footer: footer(meta, notes),
    initialFocus: selected === null ? 'topics' : rightId,
  } satisfies ScreenSpec;
};

export default Screen;
