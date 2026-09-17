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
];
