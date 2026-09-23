// packages/web/src/screens/shared/newsList.ts
//
// The `list` node TOP, N, NI and the news tab of DES all render (FUNCTIONS_TIER1 §0.1). One shape
// for a headline everywhere it appears: the same time column, the same three-letter feed tag, the
// same kind glyph, the same linked entities and the same `[CORRECTION]` badge.
//
// Two rules of the news screens are encoded here rather than repeated four times:
//
//   * **Link-out only.** A news item carries `url` and never a stored body — v1 captures headlines,
//     summaries and links, nothing else (PROVIDERS §11). `Enter` on a row is `ctx.openUrl(item.url)`.
//   * **NEWS-08.** `machineGenerated` is `false` for every row v1 can produce; the flag exists so the
//     render rule is enforceable. {@link machineGeneratedRows} is what a screen would partition on,
//     and `packages/web/test/screens/tier1/screens.test.tsx` asserts every golden row is human.
//
// Pure: no DOM, no state, no IO.

import type { NewsRow } from '@terminal/core';

import type { Badge, Node } from '../../screen/types.js';

/** A `TopRow` is a `NewsRow` with its ranking; N, NI and DES pass plain rows. */
export type NewsListRow = NewsRow & { rank?: number };

/**
 * The three-letter tag in the second column. It names the *feed*, not the source, because that is
 * what a reader recognises: `MKT`, `ECO`, `FIL`, `FED`.
 */
export function feedTag(row: Pick<NewsRow, 'sourceId' | 'feed'>): string {
  if (row.sourceId === 'sec.atom') return 'FIL';
  if (row.sourceId === 'fed.rss') return 'FED';
  const feed = row.feed.toUpperCase();
  if (feed.startsWith('MARKET')) return 'MKT';
  if (feed.startsWith('ECONOMIC')) return 'ECO';
  if (feed.startsWith('TECH')) return 'TEC';
  if (feed.startsWith('POLITIC')) return 'POL';
  return feed.replace(/[^A-Z0-9]/g, '').slice(0, 3).padEnd(3, '·');
}

/** `▶` video · `▤` filing · `◆` press release or Fed release · ` ` a plain story (§TOP layout). */
export function kindGlyph(kind: NewsRow['kind']): string {
  switch (kind) {
    case 'video':
      return '▶';
    case 'filing':
      return '▤';
    case 'press_release':
    case 'fed_release':
      return '◆';
    case 'story':
      return ' ';
  }
}

/** The linked entities as the list shows them: up to two displays, then `+n`. */
export function linkSummary(row: Pick<NewsRow, 'links'>, max = 2): string[] {
  const shown = row.links.slice(0, max).map((l) => l.display);
  if (row.links.length > max) shown.push(`+${String(row.links.length - max)}`);
  return shown;
}

/**
 * NEWS-08: rows a machine wrote, which render under their own divider. `machineGenerated` is typed
 * `false`, so this is empty for every payload v1 can produce — the function exists so the rule has
 * one implementation to point at when a generated feed is added, and so the test can assert it.
 */
export function machineGeneratedRows(rows: readonly NewsListRow[]): NewsListRow[] {
  return rows.filter((r) => (r.machineGenerated as boolean) === true);
}

export interface NewsListOptions {
  /** Show the three-letter feed tag badge. */
  showFeed?: boolean;
  /** Show the kind glyph badge. */
  showKind?: boolean;
  /** Show the TOP rank, four decimals. */
  showRank?: boolean;
  /** Use the summary as the secondary line (N); otherwise the linked entities are the secondary. */
  showSummary?: boolean;
  /** One line per headline — no secondary line at all (TOP). */
  dense?: boolean;
  /** `n:` subject the list prepends live headlines from (TOP, NI). */
  liveSubject?: string | null;
}

/**
 * `list#<id>` — one item per headline.
 *
 * The item's `ts` is `publishedAt` (the renderer formats it time-only for today, `dd/MM HH:mm`
 * otherwise), `primary` is the headline verbatim and `url` is the link out. No item carries a
 * `command`: a headline opens its publisher, not a function.
 */
export function newsList(
  id: string,
  rows: readonly NewsListRow[],
  opts: NewsListOptions = {},
): Node {
  const items = rows.map((row) => {
    const badges: Badge[] = [];
    if (opts.showFeed === true) {
      badges.push({ text: feedTag(row), tone: 'info', title: `${row.sourceId} · ${row.feed}` });
    }
    if (opts.showKind === true) {
      badges.push({ text: kindGlyph(row.kind), tone: 'info', title: row.kind });
    }
    if (row.isCorrection) {
      badges.push({ text: 'CORRECTION', tone: 'warn', title: 'Correction or headline fix' });
    }
    for (const link of row.links.slice(0, 2)) {
      badges.push({
        text: link.display,
        tone: 'ok',
        title: `${link.entityKind} · ${link.method} · confidence ${link.confidence.toFixed(2)}`,
      });
    }
    if (row.links.length > 2) {
      badges.push({
        text: `+${String(row.links.length - 2)}`,
        tone: 'ok',
        title: row.links
          .slice(2)
          .map((l) => l.display)
          .join(', '),
      });
    }
    if (opts.showRank === true && row.rank !== undefined) {
      badges.push({ text: row.rank.toFixed(4), tone: 'info', title: 'TOP rank (NEWS-05)' });
    }

    const item: {
      id: string;
      primary: string;
      secondary?: string;
      ts?: string;
      badges?: Badge[];
      command?: string;
      url?: string;
    } = { id: `news:${String(row.newsId)}`, primary: row.headline, ts: row.publishedAt, url: row.url };

    if (opts.dense !== true) {
      const secondary =
        opts.showSummary === true ? (row.summary ?? linkSummary(row).join(' · ')) : linkSummary(row).join(' · ');
      if (secondary.length > 0) item.secondary = secondary;
    }
    if (badges.length > 0) item.badges = badges;
    return item;
  });

  const node: Extract<Node, { kind: 'list' }> = { kind: 'list', id, items };
  if (opts.liveSubject !== undefined && opts.liveSubject !== null) {
    node.live = { subject: opts.liveSubject };
  }
  return node;
}
