// packages/core/src/functions/shared/news.ts
//
// The one shape every news-bearing Tier 1 function returns (FUNCTIONS_TIER1 §0.2) and the one CSV
// column set they all export (§0.5). TOP, N, NI and the news block of DES render the same `NewsRow`,
// so a headline looks the same and exports the same wherever it appears.

import type { CsvColumn } from '../manifest.js';

/** The three feeds v1 ingests (`news_items.source_id`, PROVIDERS §11). */
export type NewsSourceId = 'bbg.rss' | 'sec.atom' | 'fed.rss';

/** `news_items.kind` — the CHECK values of DATA_MODEL's news table. */
export type NewsKind = 'story' | 'video' | 'filing' | 'press_release' | 'fed_release';

/** `news_entity_links.entity_kind`. */
export type NewsEntityKind = 'instrument' | 'issuer' | 'person' | 'topic';

/**
 * `news_entity_links.method` — the CHECK values, in descending precision. NEWS-02 never writes a
 * link below 0.9 confidence, so `feed_topic` and `keyword` reach a row only when the matcher is
 * certain of them.
 */
export type NewsLinkMethod =
  'cik' | 'ticker_exact' | 'name_exact' | 'name_alias' | 'feed_topic' | 'keyword' | 'manual';

/** One resolved entity on a headline (NEWS-02). `display` is the command-line form: 'AAPL US Equity'. */
export interface NewsLink {
  entityKind: NewsEntityKind;
  entityId: number;
  display: string;
  confidence: number;
  method: NewsLinkMethod;
}

/** One headline as every news screen renders it. `machineGenerated` is always false in v1 (NEWS-08). */
export interface NewsRow {
  newsId: number;
  headline: string;
  summary: string | null;
  sourceId: NewsSourceId;
  feed: string;
  kind: NewsKind;
  author: string | null;
  category: string | null;
  cik: string | null;
  items8k: string[] | null;
  publishedAt: string;
  capturedAt: string;
  url: string;
  isCorrection: boolean;
  machineGenerated: false;
  links: NewsLink[];
  /** Index into `meta.provenance` (DATA-10); every row cites the capture it came from. */
  provIdx: number;
}

/** One CSV cell as `toCsv` accepts it (`CsvDocument['rows'][number][number]`). */
export type NewsCsvCell = string | number | boolean | null;

/** The TOP/N/NI export columns (FUNCTIONS_TIER1 §0.5), in the order `newsCsvRow` emits them. */
export const newsCsvColumns: CsvColumn[] = [
  { id: 'publishedAt', label: 'Published', type: 'datetime' },
  { id: 'sourceId', label: 'Source', type: 'string' },
  { id: 'feed', label: 'Feed', type: 'string' },
  { id: 'kind', label: 'Kind', type: 'string' },
  { id: 'headline', label: 'Headline', type: 'string' },
  { id: 'url', label: 'URL', type: 'string' },
  /** 'AAPL US Equity|SPX Index' */
  { id: 'linkedKeys', label: 'Linked', type: 'string' },
  { id: 'isCorrection', label: 'Correction', type: 'boolean' },
  { id: 'newsId', label: 'News id', type: 'number' },
];

/** One export row, positionally aligned with `newsCsvColumns`. */
export const newsCsvRow = (r: NewsRow): NewsCsvCell[] => [
  r.publishedAt,
  r.sourceId,
  r.feed,
  r.kind,
  r.headline,
  r.url,
  r.links.map((l) => l.display).join('|'),
  r.isCorrection,
  r.newsId,
];
