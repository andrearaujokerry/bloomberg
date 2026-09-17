/**
 * Drizzle mirror of migration 0010_news.sql.
 *
 * The `news_items_source_known` trigger lives only in the SQL (allowlisted in the drift test).
 */
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  index,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { entityKindEnum } from './enums.js';
import { provenance } from './provenance.js';

/** `tsvector` has no native Drizzle column type; the value is opaque to the application. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/** News topic tree: feeds, sectors, themes, regions, events, releases. */
export const topics = pgTable(
  'topics',
  {
    topicId: bigint('topic_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    parentTopicId: bigint('parent_topic_id', { mode: 'number' }).references(
      (): AnyPgColumn => topics.topicId,
    ),
    keywords: text('keywords')
      .array()
      .notNull()
      .default(sql`'{}'`),
  },
  (t) => [
    unique('topics_code_key').on(t.code),
    check(
      'topics_kind_check',
      sql`${t.kind} IN ('feed','sector','theme','region','event','release')`,
    ),
  ],
);

/** RSS / Atom stories, videos, filings and press releases. */
export const newsItems = pgTable(
  'news_items',
  {
    newsId: bigint('news_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    sourceId: text('source_id').notNull(),
    feed: text('feed').notNull(),
    providerGuid: text('provider_guid').notNull(),
    kind: text('kind').notNull(),
    headline: text('headline').notNull(),
    summary: text('summary'),
    url: text('url').notNull(),
    author: text('author'),
    category: text('category'),
    cik: char('cik', { length: 10 }),
    items8k: text('items_8k').array(),
    lang: char('lang', { length: 2 }).notNull().default('en'),
    /** pubDate / <updated> (FEED-05 src). */
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    /** Our receipt (cap). */
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    isCorrection: boolean('is_correction').notNull().default(false),
    /** NEWS-08: always false in v1; the column exists so the render rule is enforceable. */
    machineGenerated: boolean('machine_generated').notNull().default(false),
    tsv: tsvector('tsv').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(headline, '')), 'A') || setweight(to_tsvector('english', coalesce(summary, '')), 'B')`,
    ),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    unique('news_items_source_id_provider_guid_key').on(t.sourceId, t.providerGuid),
    index('news_items_tsv_idx').using('gin', t.tsv),
    index('news_items_headline_trgm').using('gin', t.headline.op('gin_trgm_ops')),
    index('news_items_published_idx').on(t.publishedAt.desc()),
    index('news_items_feed_idx').on(t.feed, t.publishedAt.desc()),
    index('news_items_cik_idx')
      .on(t.cik, t.publishedAt.desc())
      .where(sql`${t.cik} IS NOT NULL`),
    check(
      'news_items_kind_check',
      sql`${t.kind} IN ('story','video','filing','press_release','fed_release')`,
    ),
  ],
);

/** NEWS-02 precision-first entity resolution (exact ticker/CIK/name only; no fuzzy links). */
export const newsEntityLinks = pgTable(
  'news_entity_links',
  {
    newsId: bigint('news_id', { mode: 'number' })
      .notNull()
      .references(() => newsItems.newsId, { onDelete: 'cascade' }),
    entityKind: entityKindEnum('entity_kind').notNull(),
    entityId: bigint('entity_id', { mode: 'number' }).notNull(),
    /** 1.0 CIK/ticker exact; 0.95 name exact; 0.9 alias; links < 0.9 are never written. */
    confidence: real('confidence').notNull(),
    method: text('method').notNull(),
  },
  (t) => [
    primaryKey({ name: 'news_entity_links_pkey', columns: [t.newsId, t.entityKind, t.entityId] }),
    index('news_entity_links_entity_idx').on(t.entityKind, t.entityId, t.newsId.desc()),
    check('news_entity_links_confidence_check', sql`${t.confidence} BETWEEN 0 AND 1`),
    check(
      'news_entity_links_method_check',
      sql`${t.method} IN ('cik','ticker_exact','name_exact','name_alias','feed_topic','keyword','manual')`,
    ),
  ],
);
