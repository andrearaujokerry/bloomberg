// packages/web/src/screens/CN/Screen.tsx — Company News (FUNCTIONS_TIER2.md §CN "Screen").
//
// Two variants: `issuer` is the shared `newsList` over one company's stream; `members` is a grid of
// the same stream for an index's constituents, one row per (headline × member link) so a story that
// touches three names is visible against all three.
//
// The rule that shapes both: an empty stream always states WHY it is empty. A `text#empty` node
// carries `meta.unavailable`'s `detail` verbatim rather than a bare "no results".
//
// Pure: no DOM, no state, no IO. Headlines are link-out only; a row's `Enter` opens the publisher.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type { Badge, FunctionScreen, GridColumn, GridRow, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import { feedTag, kindGlyph, newsList } from '../shared/newsList.js';
import type { NewsListRow } from '../shared/newsList.js';
import {
  entitlementBadges,
  footer,
  numCell,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'CN'>;
type Payload = PayloadOf<'CN'>;
type CnIssuer = Extract<Payload, { variant: 'issuer' }>;
type CnMembers = Extract<Payload, { variant: 'members' }>;
type CnRow = CnIssuer['rows'][number];

/**
 * A `CnFilingRow` has `newsId: null` and no `NewsRow` identity, so the shared list is given a row
 * whose `newsId` is derived from the accession number. Nothing else about the row is changed: the
 * headline, the link and the publication time are the payload's.
 */
function toListRows(rows: readonly CnRow[]): NewsListRow[] {
  return rows.map((r, i) => {
    if (r.newsId !== null) return r;
    // A filing row is a `NewsRow` in every field the list reads; only `sourceId` falls outside
    // `NewsRow`'s closed union (`'sec.submissions'` is not one of its three members), which is why
    // the assertion is needed and why it is narrow.
    return { ...r, newsId: -(i + 1) } as unknown as NewsListRow;
  });
}

/**
 * The three-letter feed tag. `NewsRow.sourceId` is a closed union that predates the `filings`
 * table, so a `CnFilingRow` (`sourceId:'sec.submissions'`) is tagged here rather than by the
 * shared helper; everything else goes through `feedTag` unchanged.
 */
function sourceTag(r: CnRow): string {
  return r.sourceId === 'sec.submissions' ? 'FIL' : feedTag({ sourceId: r.sourceId, feed: r.feed });
}

function counts(p: Payload): string {
  const c = p.counts;
  return `story ${String(c.story)} · video ${String(c.video)} · filing ${String(c.filing)} · press ${String(c.press_release)}`;
}

function windowBadges(p: Payload): Badge[] {
  const badges: Badge[] = [
    {
      text: `${p.window.label} · ${p.window.from.slice(0, 10)}..${p.window.to.slice(0, 10)}`,
      tone: 'info',
      title: `${String(p.total)} items in the window`,
    },
    { text: counts(p), tone: 'info' },
  ];
  if (p.variant === 'members') {
    badges.push({
      text: `top ${String(p.membership.shown)} of ${String(p.membership.total)} by weight · membership ${p.membership.asOfDate} ${p.membership.sourceId}`,
      tone: 'info',
    });
  }
  return badges;
}

function noteBadges(p: Payload, meta: Parameters<typeof entitlementBadges>[0]): Badge[] {
  const badges: Badge[] = [
    { text: 'PRECISION-FIRST LINKING', tone: 'info', title: 'Only links at confidence ≥ 0.9 are written (NEWS-02).' },
    { text: 'LINK-OUT ONLY', tone: 'info', title: 'Headlines and links are captured; bodies are never stored.' },
  ];
  for (const note of p.notes) badges.push({ text: note, tone: 'warn' });
  badges.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));
  return badges;
}

/** `time | member | wt% | kind | headline | source` — one row per (headline × member link). */
function membersGrid(p: CnMembers): Node {
  const columns: GridColumn[] = [
    { id: 'time', label: 'Time', align: 'left', fmt: 'datetime' },
    { id: 'member', label: 'Member', align: 'left' },
    { id: 'weight', label: 'Wt %', align: 'right', fieldId: 'IDX_MEMBER_WEIGHT', fmt: 'pct', decimals: 2 },
    { id: 'kind', label: 'Kind', align: 'left' },
    { id: 'headline', label: 'Headline', align: 'left', width: 80 },
    { id: 'source', label: 'Source', align: 'left' },
  ];

  const rows: GridRow[] = [];
  for (const r of p.rows) {
    const tags = r.members.length > 0 ? r.members : [{ instrumentId: -1, key: '—', weight: null }];
    for (const tag of tags) {
      rows.push({
        id: `cn:${String(r.newsId ?? r.accessionNo)}:${tag.key}`,
        cells: {
          time: textCell(r.publishedAt, { fmt: 'datetime' }),
          member: textCell(tag.key, tag.instrumentId < 0 ? {} : { command: `${tag.key} DES` }),
          weight: numCell('IDX_MEMBER_WEIGHT', tag.weight, p.membership.provIdx, { fmt: 'pct', decimals: 2 }),
          kind: textCell(`${kindGlyph(r.kind)} ${r.kind}`),
          headline: textCell(r.headline),
          source: textCell(sourceTag(r)),
        },
        ...(tag.instrumentId < 0 ? {} : { instrumentId: tag.instrumentId, command: `${tag.key} DES` }),
      });
    }
  }

  return {
    kind: 'grid',
    id: 'rows',
    columns,
    rows,
    frozenColumns: 2,
    selectable: true,
    emptyText: 'No member headlines in this window.',
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, instrument, meta }) => {
  const display = instrument?.display ?? 'security';

  if (payload === undefined) {
    return {
      title: `CN · ${display} · Company News`,
      subtitle: 'loading…',
      body: stack('col', [
        { kind: 'badges', id: 'window', items: [{ text: params.window, tone: 'info' }] },
        {
          kind: 'list',
          id: 'rows',
          items: Array.from({ length: 12 }, (_v, i) => ({ id: `skeleton:${String(i)}`, primary: '…' })),
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'rows',
    } satisfies ScreenSpec;
  }

  const unavailable = meta?.unavailable ?? [];
  const empty: Node | null =
    payload.rows.length === 0
      ? {
          kind: 'text',
          id: 'empty',
          tone: 'warn',
          text:
            unavailable.length > 0
              ? unavailable.map((u) => `${u.field}: ${u.reason} — ${u.detail}`).join(' · ')
              : `No headlines linked to this subject between ${payload.window.from.slice(0, 10)} and ${payload.window.to.slice(0, 10)}.`,
        }
      : null;

  const children: Node[] = [
    { kind: 'badges', id: 'window', items: windowBadges(payload) },
    { kind: 'badges', id: 'notes', items: noteBadges(payload, meta) },
  ];

  if (payload.variant === 'members') {
    children.push(membersGrid(payload));
  } else {
    children.push(
      newsList('rows', toListRows(payload.rows), {
        showFeed: true,
        showKind: true,
        showSummary: true,
        liveSubject: payload.liveSubject,
      }),
    );
  }
  if (empty !== null) children.push(empty);

  const title =
    payload.variant === 'members'
      ? `CN · ${payload.index.key} · ${payload.index.name} · Member News`
      : `CN · ${display} · ${payload.security.name} · Company News`;

  return {
    title,
    subtitle: `${payload.window.label} · ${String(payload.total)} items · ${counts(payload)}`,
    body: stack('col', children),
    footer: footer(meta, payload.notes),
    initialFocus: 'rows',
  } satisfies ScreenSpec;
};

export default Screen;
