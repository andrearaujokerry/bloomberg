// packages/web/src/screens/N/Screen.tsx — News Search (FUNCTIONS_TIER1 §N "Screen").
//
// The query form, the line that says exactly how the query was matched, the results and a note
// about live prepend. `matcher:'trigram'` is called out in amber: an approximate match is a
// different answer from an exact one and the screen never lets it pass as one.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type { FormField, FunctionScreen, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import { newsList } from '../shared/newsList.js';
import { healthBadges } from '../TOP/Screen.js';
import { entitlementBadges, footer, stalenessBadges, unavailableBadges } from '../shared/quoteHeader.js';

type Params = ParamsOf<'N'>;
type Payload = PayloadOf<'N'>;

const KINDS = ['story', 'video', 'filing', 'press_release', 'fed_release'] as const;

function queryForm(
  p: Payload | undefined,
  params: Params,
  onSubmit: (values: Record<string, unknown>) => void,
): Node {
  const q = p?.query;
  const fields: FormField[] = [
    { id: 'q', label: 'Query', type: 'text', value: q?.q ?? params.q ?? '' },
    {
      id: 'scope',
      label: 'Scope',
      type: 'enum',
      value: params.scope,
      values: ['all', 'security'] as const,
    },
    { id: 'feeds', label: 'Feeds', type: 'text', value: (q?.feeds ?? params.feeds).join(',') },
    { id: 'topics', label: 'Topics', type: 'text', value: (q?.topics ?? params.topics).join(',') },
    { id: 'kinds', label: 'Kinds', type: 'text', value: (q?.kinds ?? params.kinds).join(',') },
    { id: 'from', label: 'From', type: 'date', value: q?.from ?? params.from ?? '' },
    { id: 'to', label: 'To', type: 'date', value: q?.to ?? params.to ?? '' },
    { id: 'pageSize', label: 'Rows', type: 'number', value: params.pageSize, step: 10, bigStep: 50 },
  ];
  return { kind: 'form', id: 'query', fields, submitLabel: 'Search', onSubmit };
}

/** The matcher line — `tsquery` states the parsed query, `trigram` warns, `none` says nothing. */
function matcherText(p: Payload): Node {
  if (p.matcher === 'trigram') {
    return {
      kind: 'text',
      id: 'matcher',
      tone: 'warn',
      text: `no exact match — showing approximate headline matches (pg_trgm) · ${String(p.total)}${p.totalIsCapped ? '+' : ''} hits`,
    };
  }
  if (p.matcher === 'none') {
    return {
      kind: 'text',
      id: 'matcher',
      tone: 'muted',
      text: `${String(p.total)}${p.totalIsCapped ? '+' : ''} headlines · no text query`,
    };
  }
  return {
    kind: 'text',
    id: 'matcher',
    mono: true,
    text: `websearch_to_tsquery: ${p.tsquery ?? ''} · ${String(p.total)}${p.totalIsCapped ? '+' : ''} hits (exact)`,
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta, ctx }) => {
  const submit = (values: Record<string, unknown>): void => {
    const patch: Partial<Params> = {};
    const q = values.q;
    if (typeof q === 'string') patch.q = q;
    const scope = values.scope;
    if (scope === 'all' || scope === 'security') patch.scope = scope;
    const list = (key: string): string[] => {
      const raw = values[key];
      return typeof raw === 'string' && raw.length > 0 ? raw.split(',').map((s) => s.trim()) : [];
    };
    patch.feeds = list('feeds');
    patch.topics = list('topics');
    patch.kinds = list('kinds').filter((k): k is (typeof KINDS)[number] =>
      (KINDS as readonly string[]).includes(k),
    );
    const from = values.from;
    if (typeof from === 'string' && from.length > 0) patch.from = from;
    const to = values.to;
    if (typeof to === 'string' && to.length > 0) patch.to = to;
    const pageSize = values.pageSize;
    if (typeof pageSize === 'number') patch.pageSize = pageSize;
    ctx.setParams(patch);
  };

  if (payload === undefined) {
    return {
      title: `N · News Search · ${params.q ?? 'all headlines'} · all sources`,
      subtitle: 'loading…',
      body: stack(
        'col',
        [
          queryForm(undefined, params, submit),
          {
            kind: 'list',
            id: 'rows',
            items: Array.from({ length: 12 }, (_v, i) => ({
              id: `skeleton:${String(i)}`,
              primary: '…',
            })),
          },
        ],
        [0.18, 0.82],
      ),
      footer: footer(undefined),
      initialFocus: params.q === undefined ? 'query' : 'rows',
    } satisfies ScreenSpec;
  }

  const page = meta?.page;
  const empty = payload.query.q === null && payload.query.feeds.length === 0 &&
    payload.query.topics.length === 0 && payload.query.kinds.length === 0 &&
    payload.query.instrumentId === null;

  const chips = [
    ...healthBadges(payload.feedHealth),
    ...entitlementBadges(meta),
    ...unavailableBadges(meta),
    ...stalenessBadges(meta),
  ];

  return {
    title: `N · News Search · ${payload.query.q ?? 'all headlines'} · ${payload.query.instrumentDisplay ?? 'all sources'}`,
    subtitle: `page ${String((page?.index ?? 0) + 1)}/${String(page?.count ?? 1)} · ${String(payload.total)}${payload.totalIsCapped ? '+' : ''} hits · ${payload.matcher} · ${payload.asOf.slice(11, 19)}`,
    body: stack(
      'col',
      [
        queryForm(payload, params, submit),
        matcherText(payload),
        { kind: 'badges', id: 'health', items: chips },
        newsList('rows', payload.rows, { showFeed: true, showKind: true, showSummary: true }),
        {
          kind: 'text',
          id: 'livenote',
          tone: 'muted',
          text:
            payload.matcher === 'none'
              ? 'live prepend on — new headlines matching these filters appear at the top'
              : 'live prepend off for text queries — press R to re-run',
        },
      ],
      [0.18, 0.04, 0.06, 0.66, 0.06],
    ),
    footer: footer(
      meta,
      payload.savedSearch === null ? [] : [`saved search: ${payload.savedSearch.name}`],
    ),
    initialFocus: empty ? 'query' : 'rows',
  } satisfies ScreenSpec;
};

export default Screen;
