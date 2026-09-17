/**
 * Drizzle mirror of migration 0012_workspace_portfolio.sql — the alert tables (NEWS-07).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { users } from './users.js';

/** User-defined triggers on prices, news, filings and calendar events. */
export const alerts = pgTable(
  'alerts',
  {
    alertId: bigint('alert_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    ownerUserId: bigint('owner_user_id', { mode: 'number' })
      .notNull()
      .references(() => users.userId),
    firmId: bigint('firm_id', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    /** Price alerts (evaluated on plant deltas). */
    instrumentId: bigint('instrument_id', { mode: 'number' }),
    /**
     * price: `{field:'PX_LAST', op:'>='|'<='|'crosses', value}`; news: `{savedSearchId}|{query}`;
     * filing: `{ciks[], forms[], items[]}`; calendar: `{releaseId, minutesBefore}`.
     */
    condition: jsonb('condition').notNull(),
    /** `inapp` | `email` | `push` (email/push are recorded intents in v1). */
    delivery: text('delivery')
      .array()
      .notNull()
      .default(sql`'{inapp}'`),
    status: text('status').notNull().default('armed'),
    oneShot: boolean('one_shot').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
  },
  (t) => [
    index('alerts_armed_price_idx')
      .on(t.instrumentId)
      .where(sql`${t.status} = 'armed' AND ${t.kind} = 'price'`),
    index('alerts_owner_idx')
      .on(t.ownerUserId)
      .where(sql`${t.status} <> 'deleted'`),
    check('alerts_kind_check', sql`${t.kind} IN ('price','news','filing','calendar')`),
    check('alerts_status_check', sql`${t.status} IN ('armed','paused','fired','deleted')`),
  ],
);

/** One row per firing, with per-channel delivery state. */
export const alertEvents = pgTable(
  'alert_events',
  {
    eventId: bigint('event_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    alertId: bigint('alert_id', { mode: 'number' })
      .notNull()
      .references(() => alerts.alertId, { onDelete: 'cascade' }),
    firmId: bigint('firm_id', { mode: 'number' }).notNull(),
    firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
    /** `{value, newsId, accessionNo, eventId, provenanceId}` */
    payload: jsonb('payload').notNull(),
    /** `{inapp: ts, email: null, push: null}` */
    delivered: jsonb('delivered').notNull().default({}),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  },
  (t) => [index('alert_events_alert_idx').on(t.alertId, t.firedAt.desc())],
);
