/**
 * Drizzle mirror of migration 0012_workspace_portfolio.sql — the per-user desk: workspaces,
 * watchlists, chart annotations and saved searches. Portfolios live in `portfolio.ts` and
 * alerts in `alerts.ts`.
 *
 * The `set_updated_at` BEFORE UPDATE triggers live only in the SQL (allowlisted in the drift test).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { firms, users } from './users.js';

/** TERM-05: the whole desk, server-side. */
export const workspaces = pgTable(
  'workspaces',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.userId),
    firmId: bigint('firm_id', { mode: 'number' })
      .notNull()
      .references(() => firms.firmId),
    name: text('name').notNull().default('default'),
    isActive: boolean('is_active').notNull().default(true),
    /** `WorkspaceLayout` (API.md). */
    layout: jsonb('layout').notNull(),
    /** Optimistic concurrency: PUT must send the version it read (409 otherwise). */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('workspaces_user_id_name_key').on(t.userId, t.name),
    uniqueIndex('workspaces_active_uniq')
      .on(t.userId)
      .where(sql`${t.isActive}`),
  ],
);

/** W: user-defined, shareable, computed columns. */
export const watchlists = pgTable(
  'watchlists',
  {
    watchlistId: bigint('watchlist_id', { mode: 'number' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    ownerUserId: bigint('owner_user_id', { mode: 'number' })
      .notNull()
      .references(() => users.userId),
    firmId: bigint('firm_id', { mode: 'number' })
      .notNull()
      .references(() => firms.firmId),
    name: text('name').notNull(),
    /** `[{id:'PX_LAST'} | {id:'c1', formula:'…', label:'Chg', decimals:2}]` (CHRT-07). */
    columns: jsonb('columns').notNull(),
    sort: jsonb('sort').notNull().default([]),
    groupBy: text('group_by'),
    sharedScope: text('shared_scope').notNull().default('private'),
    sharedUserIds: bigint('shared_user_ids', { mode: 'number' })
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('watchlists_owner_user_id_name_key').on(t.ownerUserId, t.name),
    check('watchlists_shared_scope_check', sql`${t.sharedScope} IN ('private','firm','users')`),
  ],
);

/** Ordered watchlist rows: either an instrument or a CHRT-07 formula. */
export const watchlistItems = pgTable(
  'watchlist_items',
  {
    watchlistId: bigint('watchlist_id', { mode: 'number' })
      .notNull()
      .references(() => watchlists.watchlistId, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    /** NULL when the row is a formula/basket. */
    instrumentId: bigint('instrument_id', { mode: 'number' }),
    formula: text('formula'),
    label: text('label'),
    note: text('note'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'watchlist_items_pkey', columns: [t.watchlistId, t.position] }),
    index('watchlist_items_instrument_idx')
      .on(t.instrumentId)
      .where(sql`${t.instrumentId} IS NOT NULL`),
    check('watchlist_items_kind', sql`(${t.instrumentId} IS NULL) <> (${t.formula} IS NULL)`),
  ],
);

/** CHRT-05: anchored in data coordinates, shareable. */
export const chartAnnotations = pgTable(
  'chart_annotations',
  {
    annotationId: bigint('annotation_id', { mode: 'number' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    ownerUserId: bigint('owner_user_id', { mode: 'number' })
      .notNull()
      .references(() => users.userId),
    firmId: bigint('firm_id', { mode: 'number' }).notNull(),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    /** `[{t: epoch_ms, v: number}]` (regression: `{t0, t1, stdev}`). */
    anchors: jsonb('anchors').notNull(),
    style: jsonb('style').notNull().default({}),
    label: text('label'),
    sharedScope: text('shared_scope').notNull().default('private'),
    sharedUserIds: bigint('shared_user_ids', { mode: 'number' })
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chart_annotations_instrument_idx').on(t.instrumentId, t.ownerUserId),
    check(
      'chart_annotations_kind_check',
      sql`${t.kind} IN ('trendline','hline','vline','fib','text','regression_channel','rect')`,
    ),
    check(
      'chart_annotations_shared_scope_check',
      sql`${t.sharedScope} IN ('private','firm','users')`,
    ),
  ],
);

/** NEWS-07 saved news searches, EQS / SRCH screen definitions. */
export const savedSearches = pgTable(
  'saved_searches',
  {
    searchId: bigint('search_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    ownerUserId: bigint('owner_user_id', { mode: 'number' })
      .notNull()
      .references(() => users.userId),
    firmId: bigint('firm_id', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    /** news: `{text, instrumentIds[], topics[], feeds[]}`; eqs/srch: `ScreenCriteria`. */
    query: jsonb('query').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('saved_searches_owner_user_id_kind_name_key').on(t.ownerUserId, t.kind, t.name),
    check('saved_searches_kind_check', sql`${t.kind} IN ('news','eqs','srch')`),
  ],
);
