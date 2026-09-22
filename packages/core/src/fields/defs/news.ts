// packages/core/src/fields/defs/news.ts — field_class 'news'
//
// Headline metadata. News fields hang off the `n:` subjects rather than off an instrument, so their
// `assetClasses` list is empty (API.md §7: "[] for subject-only fields"); a headline is linked to
// instruments through news_entity_links, not through this dictionary.

import type { FieldDef } from '../../types/fields.js';

type FieldSource = FieldDef['sources'][number];

const src = (
  assetClass: FieldSource['assetClass'],
  sourceId: string,
  endpoint: string,
  providerPath: string,
): FieldSource => ({ assetClass, sourceId, endpoint, providerPath });

const SINCE = '2026.09.1';

export const newsFields: readonly FieldDef[] = [
  {
    id: 'NEWS_ID',
    label: 'Story id',
    definition:
      'Stable terminal identifier of a headline, derived from the feed’s own guid. It is what NLRT ' +
      'alerts, saved stories and the story pane address, and it survives a re-poll of the feed.',
    type: 'string',
    unit: 'text',
    decimals: null,
    fieldClass: 'news',
    assetClasses: [],
    sources: [
      src('*', 'bbg.rss', 'rss', 'channel.item[].guid'),
      src('*', 'sec.atom', 'atom', 'feed.entry[].id'),
      src('*', 'fed.rss', 'rss', 'channel.item[].guid'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'n:inst:42', value: 'bbg.rss:8f2c1e04', asOf: '2026-09-15T18:39:02Z' },
    since: SINCE,
  },
  {
    id: 'IS_CORRECTION',
    label: 'Correction',
    definition:
      'True when the publisher marked this story as a correction or a replacement of an earlier ' +
      'one. A corrected story is shown in place of the original and flagged in the story pane.',
    type: 'boolean',
    unit: null,
    decimals: null,
    fieldClass: 'news',
    assetClasses: [],
    sources: [src('*', 'bbg.rss', 'rss', 'channel.item[].title')],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'n:inst:42', value: false, asOf: '2026-09-15T18:39:02Z' },
    since: SINCE,
  },

  // ── WP-06 subject fields (API.md §6.1): the n:<scope> headline ───────────────────────────────
  {
    id: 'HEADLINE',
    label: 'Headline',
    definition: 'Headline text of the story as published, with the publisher’s own prefixes kept.',
    type: 'string',
    unit: 'text',
    decimals: null,
    fieldClass: 'news',
    assetClasses: [],
    sources: [
      src('*', 'bbg.rss', 'rss', 'channel.item[].title'),
      src('*', 'sec.atom', 'atom', 'feed.entry[].title'),
      src('*', 'fed.rss', 'rss', 'channel.item[].title'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'n:inst:42', value: 'Apple unveils new iPhone lineup', asOf: '2026-09-15T18:39:02Z' },
    since: SINCE,
  },
  {
    id: 'PUBLISHED_AT',
    label: 'Published',
    definition: 'Publisher timestamp of the story in UTC; the order headlines are delivered in on an n: subject.',
    type: 'datetime',
    unit: 'datetime',
    decimals: null,
    fieldClass: 'news',
    assetClasses: [],
    sources: [
      src('*', 'bbg.rss', 'rss', 'channel.item[].pubDate'),
      src('*', 'sec.atom', 'atom', 'feed.entry[].updated'),
      src('*', 'fed.rss', 'rss', 'channel.item[].pubDate'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'n:inst:42', value: '2026-09-15T18:39:02Z', asOf: '2026-09-15T18:39:02Z' },
    since: SINCE,
  },
  {
    id: 'SOURCE_ID',
    label: 'Source',
    definition: 'Source id of the feed the story came from (licence_registry.source_id), shown as the attribution.',
    type: 'string',
    unit: 'text',
    decimals: null,
    fieldClass: 'news',
    assetClasses: [],
    sources: [
      src('*', 'bbg.rss', 'rss', 'channel.title'),
      src('*', 'sec.atom', 'atom', 'feed.title'),
      src('*', 'fed.rss', 'rss', 'channel.title'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'n:inst:42', value: 'bbg.rss', asOf: '2026-09-15T18:39:02Z' },
    since: SINCE,
  },
  {
    id: 'LINK',
    label: 'Link',
    definition: 'Canonical URL of the story at the publisher; opened by the story pane.',
    type: 'string',
    unit: 'text',
    decimals: null,
    fieldClass: 'news',
    assetClasses: [],
    sources: [
      src('*', 'bbg.rss', 'rss', 'channel.item[].link'),
      src('*', 'sec.atom', 'atom', 'feed.entry[].link.href'),
      src('*', 'fed.rss', 'rss', 'channel.item[].link'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'n:inst:42', value: 'https://www.bloomberg.com/news/articles/2026-09-15/apple', asOf: '2026-09-15T18:39:02Z' },
    since: SINCE,
  },
  {
    id: 'KIND',
    label: 'Kind',
    definition: 'What the item is: a news story, a regulatory filing or a central-bank release.',
    type: 'enum',
    unit: 'enum',
    decimals: null,
    enumValues: ['story', 'filing', 'release'],
    fieldClass: 'news',
    assetClasses: [],
    sources: [
      src('*', 'bbg.rss', 'rss', 'channel.item[].category'),
      src('*', 'sec.atom', 'atom', 'feed.entry[].category.term'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'n:inst:42', value: 'story', asOf: '2026-09-15T18:39:02Z' },
    since: SINCE,
  },
];
