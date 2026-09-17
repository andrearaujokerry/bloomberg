/**
 * Drizzle mirror of migration 0013_messaging.sql — IB-style rooms, the WORM message log,
 * legal holds and supervisory surveillance.
 *
 * `messages` is append-only and hash-chained: the `messages_chain` / `worm_block` triggers and the
 * REVOKE UPDATE/DELETE of migration 0015 live only in the SQL (allowlisted in the drift test).
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
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea } from './provenance.js';
import { firms, users } from './users.js';

/** DM / group / firm / helpdesk rooms. */
export const rooms = pgTable(
  'rooms',
  {
    roomId: bigint('room_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    kind: text('kind').notNull(),
    name: text('name'),
    /** NULL for cross-firm dm/group rooms (policy checked per member firm). */
    firmId: bigint('firm_id', { mode: 'number' }).references(() => firms.firmId),
    scope: text('scope').notNull().default('internal'),
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.userId),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** MSG-03 / REG-01: >= firm retention; purge never below 7 years. */
    retentionDays: integer('retention_days').notNull().default(2557),
    disclaimer: text('disclaimer'),
    /** MSG-03 / SEC-06 ethical wall; enforced by `messaging/service.ts`. */
    wallTag: text('wall_tag'),
    /** `{permittedFirms:[], allowExternal:false}` */
    policy: jsonb('policy').notNull().default({}),
  },
  (t) => [
    check('rooms_kind_check', sql`${t.kind} IN ('dm','group','firm','helpdesk')`),
    check('rooms_scope_check', sql`${t.scope} IN ('internal','external')`),
  ],
);

/** Room membership, with supervisor seats. */
export const roomMembers = pgTable(
  'room_members',
  {
    roomId: bigint('room_id', { mode: 'number' })
      .notNull()
      .references(() => rooms.roomId),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.userId),
    role: text('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: 'room_members_pkey', columns: [t.roomId, t.userId] }),
    index('room_members_user_idx')
      .on(t.userId)
      .where(sql`${t.leftAt} IS NULL`),
    check('room_members_role_check', sql`${t.role} IN ('member','owner','supervisor')`),
  ],
);

/** MSG-02 / REG-01 WORM: append-only, hash-chained per room. */
export const messages = pgTable(
  'messages',
  {
    messageId: bigint('message_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    roomId: bigint('room_id', { mode: 'number' })
      .notNull()
      .references(() => rooms.roomId),
    /** Per-room sequence, assigned by the chain trigger. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    senderUserId: bigint('sender_user_id', { mode: 'number' })
      .notNull()
      .references(() => users.userId),
    senderFirmId: bigint('sender_firm_id', { mode: 'number' }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    body: text('body').notNull(),
    /** MSG-04 live-rendered attachments. */
    attachments: jsonb('attachments').notNull().default([]),
    /** MSG-06 shape only: `{type:'ioi'|'rfq', side, instrumentId, qty, price}` — display only. */
    structured: jsonb('structured'),
    /** Idempotent send. */
    clientMsgId: uuid('client_msg_id').notNull(),
    prevHash: bytea('prev_hash'),
    /** `sha256(prev_hash || room_id || seq || sender || sent_at || body || attachments)` */
    hash: bytea('hash').notNull(),
    traceId: uuid('trace_id'),
  },
  (t) => [
    unique('messages_room_id_seq_key').on(t.roomId, t.seq),
    unique('messages_room_id_client_msg_id_key').on(t.roomId, t.clientMsgId),
    index('messages_room_time_idx').on(t.roomId, t.sentAt.desc()),
    index('messages_fts_idx').using('gin', sql`to_tsvector('english', ${t.body})`),
  ],
);

/** Per-user read cursors (no FKs in the DDL: the table is written on a hot path). */
export const messageReads = pgTable(
  'message_reads',
  {
    roomId: bigint('room_id', { mode: 'number' }).notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'message_reads_pkey', columns: [t.roomId, t.userId] })],
);

/** MSG-02: while open, nothing in scope may be purged. */
export const legalHolds = pgTable(
  'legal_holds',
  {
    holdId: bigint('hold_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    firmId: bigint('firm_id', { mode: 'number' })
      .notNull()
      .references(() => firms.firmId),
    /** `{userIds:[], roomIds:[], from, to}` */
    scope: jsonb('scope').notNull(),
    reason: text('reason').notNull(),
    createdBy: bigint('created_by', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: bigint('released_by', { mode: 'number' }),
  },
  (t) => [
    index('legal_holds_open_idx')
      .on(t.firmId)
      .where(sql`${t.releasedAt} IS NULL`),
  ],
);

/** MSG-02 lexicon-based surveillance patterns. */
export const surveillanceLexicon = pgTable(
  'surveillance_lexicon',
  {
    termId: bigint('term_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    /** NULL = global list. */
    firmId: bigint('firm_id', { mode: 'number' }).references(() => firms.firmId),
    /** Case-insensitive regex. */
    pattern: text('pattern').notNull(),
    severity: smallint('severity').notNull().default(2),
    active: boolean('active').notNull().default(true),
    note: text('note'),
  },
  (t) => [check('surveillance_lexicon_severity_check', sql`${t.severity} BETWEEN 1 AND 3`)],
);

/** One row per (message, lexicon term) match. */
export const surveillanceHits = pgTable(
  'surveillance_hits',
  {
    hitId: bigint('hit_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    messageId: bigint('message_id', { mode: 'number' })
      .notNull()
      .references(() => messages.messageId),
    termId: bigint('term_id', { mode: 'number' })
      .notNull()
      .references(() => surveillanceLexicon.termId),
    matchedText: text('matched_text').notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    reviewStatus: text('review_status').notNull().default('open'),
    reviewedBy: bigint('reviewed_by', { mode: 'number' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewerNote: text('reviewer_note'),
  },
  (t) => [
    unique('surveillance_hits_message_id_term_id_key').on(t.messageId, t.termId),
    index('surveillance_hits_open_idx')
      .on(t.detectedAt.desc())
      .where(sql`${t.reviewStatus} = 'open'`),
    check(
      'surveillance_hits_review_status_check',
      sql`${t.reviewStatus} IN ('open','escalated','cleared')`,
    ),
  ],
);

/** Supervisory review queue (random sample + manual flags). */
export const messageReviews = pgTable(
  'message_reviews',
  {
    reviewId: bigint('review_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    messageId: bigint('message_id', { mode: 'number' })
      .notNull()
      .references(() => messages.messageId),
    flaggedBy: text('flagged_by').notNull(),
    status: text('status').notNull().default('open'),
    reviewerUserId: bigint('reviewer_user_id', { mode: 'number' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    note: text('note'),
  },
  (t) => [
    check(
      'message_reviews_flagged_by_check',
      sql`${t.flaggedBy} IN ('lexicon','random_sample','manual')`,
    ),
    check('message_reviews_status_check', sql`${t.status} IN ('open','reviewed','escalated')`),
  ],
);
