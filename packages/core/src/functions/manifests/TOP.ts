// packages/core/src/functions/manifests/TOP.ts
//
// `TOP` — Top News (FUNCTIONS_TIER1.md §TOP L1119-1236, FUNCTIONS.md §6 L1083).
//
// TOP is the ranked front page of the normalised news stream: Bloomberg RSS headlines, SEC 8-K
// current filings and Federal Reserve press releases in one list. Three things make it a function
// rather than a list:
//
//  - the **rank is published**, not just applied. Every row carries the four parts the score was
//    made of (`rankParts`), so "why is this at the top" has an answer with numbers in it;
//  - **feed health is part of the payload** (TERM-12). A feed that stopped publishing goes stale
//    on screen rather than silently empty, which is the difference between "no news" and "no
//    feed";
//  - **what was dropped is counted** (`suppressed`). A kind filter or a missing licence removes
//    headlines, and a screen that removed them without saying so would be lying by omission.
//
// `assetClasses: 'none'`: a security loaded in the panel is ignored (TERM-03). Issuer news is CN;
// instrument-scoped ranking is `TOP SCOPE=INSTRUMENT id=<instrumentId>`.

import { z } from 'zod';

import type { NewsRow, NewsSourceId } from '../shared/news.js';
import { newsCsvColumns, newsCsvRow } from '../shared/news.js';
import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import type { FieldId } from '../../types/fields.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§TOP "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const TOP_KINDS = ['story', 'video', 'filing', 'press_release', 'fed_release'] as const;

export const TopParams = z.object({
  scope: z.enum(['auto', 'all', 'feed', 'topic', 'instrument']).default('auto'),
  /** Topic code (`'FED'`), feed name (`'markets'`) or an instrument id as a string. */
  id: z.string().max(64).optional(),
  limit: z.number().int().min(10).max(50).default(30),
  kinds: z.array(z.enum(TOP_KINDS)).default([...TOP_KINDS]),
});
export type TopParams = z.infer<typeof TopParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§TOP "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The four named parts of a rank, as `news/ranker.ts` computes them. */
export interface TopRankParts {
  recency: number;
  feedWeight: number;
  linkConfidence: number;
  clickThrough: number;
}

export type TopScope = 'all' | 'feed' | 'topic' | 'instrument';

/** One line of the health strip: when each feed was last captured, and whether that is current. */
export interface TopFeedHealth {
  sourceId: NewsSourceId;
  feed: string;
  lastCapturedAt: string | null;
  expectedIntervalMs: number;
  st: 'live' | 'stale' | 'blank';
  provIdx: number;
}

export type TopRow = NewsRow & { rank: number; rankParts: TopRankParts };

export interface TopPayload {
  variant: 'default';
  resolved: { scope: TopScope; id: string | null; label: string };
  /** `rank` desc, ties → `publishedAt` desc, then `newsId` desc. */
  rows: TopRow[];
  /** `'n:all' | 'n:feed:markets' | 'n:topic:FED' | 'n:inst:42'`. */
  liveSubject: string;
  feedHealth: TopFeedHealth[];
  /** Rows dropped before `rows` was built, so the screen can say so (ENTL-05). */
  suppressed: { entitlement: number; kindFilter: number };
  asOf: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§TOP "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `'2026-09-15T18:41:28.000Z'` → `'20260915T184128Z'` (API.md §9; §TOP `asOfCompact`). */
export function topAsOfCompact(asOf: string): string {
  return asOf.replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/** `newsCsvColumns` (§0.5) plus the one column TOP adds. */
export const topCsvColumns: CsvColumn[] = [
  ...newsCsvColumns,
  { id: 'rank', label: 'Rank', type: 'number', decimals: 4 },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live (§TOP "Live")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One `n:` subject, no fields, never shed.
 *
 * `conflationMs` is deliberately omitted: `n:` is not conflated (API.md §6.1 — one `delta` per
 * headline, in `publishedAt` order), and a conflation window would merge two stories into one.
 */
function topLive(_params: TopParams, payload: TopPayload): LiveSpec {
  return { subjects: [payload.liveSubject], fields: [], essential: [payload.liveSubject] };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const TOP = defineFunction<typeof TopParams, TopPayload>({
  code: 'TOP',
  name: 'Top News',
  aliases: ['TOPN'],
  tier: 1,
  category: 'news',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: TopParams,
  paramGrammar: {
    positional: [{ name: 'id', type: 'string', optional: true }],
    keyed: {
      SCOPE: {
        name: 'scope',
        type: 'enum',
        values: ['auto', 'all', 'feed', 'topic', 'instrument'],
      },
      N: { name: 'limit', type: 'int' },
      KIND: { name: 'kinds', type: 'enum', values: TOP_KINDS },
    },
  },
  /**
   * Empty, and not an oversight (§TOP "Field ids"): `n:` subjects are subscribed with `f: []`, and
   * the news fields (`NEWS_ID`, `HEADLINE`, …) carry `assetClasses: []` — they hang off the
   * subject, not off an instrument. The entitlement question TOP actually asks is per *source*
   * (`bbg.rss`, `sec.atom`, `fed.rss` against `field_licence.field_class = 'news'`), which the
   * resolver asks for itself; a field list here would make the runner evaluate the wrong thing.
   */
  fieldIds: (): FieldId[] => [],
  pageable: false,
  live: topLive,
  csv: {
    filename: (params, ctx): string =>
      `TOP_${(params.id ?? 'ALL').replace(/[^A-Za-z0-9]+/g, '_')}_${topAsOfCompact(ctx.asOf)}.csv`,
    columns: topCsvColumns,
    rows: (payload): (string | number | boolean | null)[][] =>
      payload.rows.map((row) => [...newsCsvRow(row), row.rank]),
  },
  help: {
    summary: 'Ranked headline feed by topic, feed or security, with live prepend',
    description:
      'TOP is the ranked front page of the normalised news stream: Bloomberg RSS headlines, SEC ' +
      '8-K current filings and Federal Reserve press releases in one list, newest and most ' +
      'relevant first. Ranking combines recency, the weight of the feed, the confidence of the ' +
      'entity link and how often the desk opens that kind of headline. Only headlines, summaries ' +
      'and links are stored — article bodies stay with the publisher, so Enter opens the story on ' +
      "the publisher's site. Headlines arrive live: a new story is prepended and flashed within a " +
      'second of receipt, never overwriting an earlier one. The health chips show when each feed ' +
      'was last captured; a feed that stops publishing goes stale rather than silently empty. ' +
      'Nothing on this screen is machine-generated.',
    params: [
      { name: 'scope', text: 'all, feed, topic or instrument', example: 'SCOPE=TOPIC' },
      { name: 'id', text: 'topic code, feed name or instrument id', example: 'FED' },
      { name: 'limit', text: '10–50 headlines', example: 'N=50' },
      {
        name: 'kinds',
        text: 'story, video, filing, press_release, fed_release',
        example: 'KIND=FILING',
      },
    ],
    keys: [
      { key: 'Enter', action: 'open the story at the publisher (link-out only)' },
      { key: 'Shift+Enter', action: 'open the story in the N reader in the next panel' },
      { key: 'Ctrl+I', action: 'provenance of the focused headline (DATA-10)' },
      { key: 'S', action: 'DES on the first linked instrument' },
      { key: 'N', action: 'search this headline in N' },
      { key: 'I', action: 'NI on the row’s topic' },
      { key: 'C', action: 'cycle scope all / feed / topic' },
      { key: 'K', action: 'cycle kinds all / stories / filings' },
      { key: '+ / -', action: 'ten more or fewer headlines' },
      { key: 'A', action: 'alert on this scope (NEWS-07)' },
    ],
    sources: ['bbg.rss', 'sec.atom', 'fed.rss'],
    related: ['N', 'NI', 'CN', 'DES', 'MSG'],
  },
  /**
   * `Enter`, `Shift+Enter` and `Ctrl+I` are §2.6 **reserved** keys (GO, GO-next, provenance) and a
   * manifest may not bind them (§1.2 invariant 3), so they are documented in `help.keys` above and
   * handled by the shell's own node semantics. Everything here is a TOP-specific action.
   */
  keymap: [
    { key: 'S', action: 'open-security', description: 'DES on the first linked instrument' },
    { key: 'N', action: 'open-n', description: 'Search this headline in N' },
    { key: 'I', action: 'open-ni', description: 'NI on the row’s topic' },
    { key: 'C', action: 'cycle-scope', description: 'Cycle scope all / feed / topic' },
    { key: 'K', action: 'cycle-kinds', description: 'Cycle kinds all / stories / filings' },
    { key: '+', action: 'more', description: 'Ten more headlines (max 50)' },
    { key: '-', action: 'fewer', description: 'Ten fewer headlines (min 10)' },
    { key: 'A', action: 'alert-on-scope', description: 'Alert on the next headline in this scope' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default TOP;
