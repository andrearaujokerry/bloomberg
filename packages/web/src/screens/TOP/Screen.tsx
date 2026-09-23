// packages/web/src/screens/TOP/Screen.tsx — Top News (FUNCTIONS_TIER1 §TOP "Screen").
//
// A health strip that says how fresh each feed is, the ranked headline list, and one line naming
// everything that was hidden and why. A headline links out; v1 stores no article body.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type { Badge, FunctionScreen, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import { newsList } from '../shared/newsList.js';
import { entitlementBadges, footer, stalenessBadges, unavailableBadges } from '../shared/quoteHeader.js';

type Params = ParamsOf<'TOP'>;
type Payload = PayloadOf<'TOP'>;
type FeedHealth = Payload['feedHealth'][number];

/** `● live`, `◐ stale`, `○ blank` — the glyph the subtitle and the health chips share. */
export function healthGlyph(st: FeedHealth['st']): string {
  switch (st) {
    case 'live':
      return '●';
    case 'stale':
      return '◐';
    case 'blank':
      return '○';
  }
}

/** `badges#health` — one chip per feed with its last capture and its verdict. */
export function healthBadges(feeds: readonly FeedHealth[]): Badge[] {
  return feeds.map((f) => ({
    text: `${f.sourceId} ${f.feed} ${f.lastCapturedAt?.slice(11, 19) ?? '—'} ${f.st.toUpperCase()}`,
    tone: f.st === 'live' ? ('ok' as const) : f.st === 'stale' ? ('stale' as const) : ('blocked' as const),
    title: `expected every ${String(Math.round(f.expectedIntervalMs / 1000))} s · provenance ${String(f.provIdx)}`,
  }));
}

/** The one line that accounts for every headline the reader is not seeing. */
function suppressedText(p: Payload): Node {
  return {
    kind: 'text',
    id: 'suppressed',
    tone: 'muted',
    text: `${String(p.suppressed.kindFilter)} headlines hidden by KIND filter · ${String(p.suppressed.entitlement)} hidden by entitlement`,
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta }) => {
  if (payload === undefined) {
    // Skeleton: three muted health chips and ten muted rows.
    return {
      title: 'TOP · Top News',
      subtitle: 'loading…',
      body: stack(
        'col',
        [
          { kind: 'badges', id: 'health', items: [] },
          {
            kind: 'list',
            id: 'rows',
            items: Array.from({ length: 10 }, (_v, i) => ({
              id: `skeleton:${String(i)}`,
              primary: '…',
            })),
          },
        ],
        [0.08, 0.92],
      ),
      footer: footer(undefined),
      initialFocus: 'rows',
    } satisfies ScreenSpec;
  }

  const glyphs = payload.feedHealth.map((f) => `${healthGlyph(f.st)} ${f.sourceId}`).join(' ');
  const chips = [
    ...healthBadges(payload.feedHealth),
    ...entitlementBadges(meta),
    ...unavailableBadges(meta),
    ...stalenessBadges(meta),
  ];

  return {
    title: `TOP · Top News · ${payload.resolved.label}`,
    subtitle: `${String(payload.rows.length)} headlines · ${payload.asOf.slice(11, 19)} · ${glyphs}`,
    body: stack(
      'col',
      [
        { kind: 'badges', id: 'health', items: chips },
        newsList('rows', payload.rows, {
          showFeed: true,
          showKind: true,
          showRank: true,
          dense: true,
          liveSubject: payload.liveSubject,
        }),
        suppressedText(payload),
      ],
      [0.08, 0.86, 0.06],
    ),
    footer: footer(meta, [`scope ${payload.resolved.scope} · limit ${String(params.limit)}`]),
    initialFocus: 'rows',
  } satisfies ScreenSpec;
};

export default Screen;
