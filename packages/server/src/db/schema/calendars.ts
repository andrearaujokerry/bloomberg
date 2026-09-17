/**
 * Calendars, exchanges, classifications, index membership, people and relations —
 * mirrors `drizzle/migrations/0005_calendars_classifications.sql`.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  char,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { entityKindEnum } from './enums.js';
import { provenance } from './provenance.js';

/** REF-06: exchange, settlement, currency and government calendars. */
export const calendars = pgTable('calendars', {
  calendarId: text('calendar_id').primaryKey(),
  name: text('name').notNull(),
  tz: text('tz').notNull(),
  kind: text('kind').notNull(),
  sourceId: text('source_id').notNull(),
});

/** Regular weekly session template (FEED-06 session lifecycle inputs). */
export const calendarSessions = pgTable(
  'calendar_sessions',
  {
    calendarId: text('calendar_id')
      .notNull()
      .references(() => calendars.calendarId),
    weekday: smallint('weekday').notNull(),
    preOpen: time('pre_open'),
    openTime: time('open_time').notNull(),
    closeTime: time('close_time').notNull(),
    postClose: time('post_close'),
  },
  (t) => [primaryKey({ columns: [t.calendarId, t.weekday] })],
);

/** Rule-generated 1990–2040 by core/calendars at seed; ad-hoc closures added by data ops. */
export const calendarHolidays = pgTable(
  'calendar_holidays',
  {
    calendarId: text('calendar_id')
      .notNull()
      .references(() => calendars.calendarId),
    day: date('day', { mode: 'string' }).notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    closeTime: time('close_time'),
  },
  (t) => [primaryKey({ columns: [t.calendarId, t.day] })],
);

export const exchanges = pgTable(
  'exchanges',
  {
    mic: char('mic', { length: 4 }).primaryKey(),
    operatingMic: char('operating_mic', { length: 4 }).notNull(),
    name: text('name').notNull(),
    country: char('country', { length: 2 }).notNull(),
    tz: text('tz').notNull(),
    calendarId: text('calendar_id')
      .notNull()
      .references(() => calendars.calendarId),
    bbgExchCode: text('bbg_exch_code'),
    compositeCode: text('composite_code'),
    cboeExchangeId: integer('cboe_exchange_id'),
  },
  (t) => [
    uniqueIndex('exchanges_bbg_code_idx')
      .on(t.bbgExchCode)
      .where(sql`bbg_exch_code IS NOT NULL`),
  ],
);

/** REF-07 schemes. */
export const classificationSchemes = pgTable('classification_schemes', {
  scheme: text('scheme').primaryKey(),
  name: text('name').notNull(),
  sourceId: text('source_id').notNull(),
  levels: smallint('levels').notNull(),
});

export const classificationCodes = pgTable(
  'classification_codes',
  {
    scheme: text('scheme')
      .notNull()
      .references(() => classificationSchemes.scheme),
    code: text('code').notNull(),
    name: text('name').notNull(),
    parentCode: text('parent_code'),
    level: smallint('level').notNull(),
  },
  (t) => [primaryKey({ columns: [t.scheme, t.code] })],
);

/** Bitemporal: sector changes have effective dates. */
export const entityClassifications = pgTable(
  'entity_classifications',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    entityKind: entityKindEnum('entity_kind').notNull(),
    entityId: bigint('entity_id', { mode: 'number' }).notNull(),
    scheme: text('scheme').notNull(),
    code: text('code').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    txFrom: timestamp('tx_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    txTo: timestamp('tx_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    foreignKey({
      columns: [t.scheme, t.code],
      foreignColumns: [classificationCodes.scheme, classificationCodes.code],
    }),
    index('entity_classifications_current_idx')
      .on(t.entityKind, t.entityId, t.scheme)
      .where(sql`tx_to = 'infinity'`),
    index('entity_classifications_lookup_idx')
      .on(t.scheme, t.code)
      .where(sql`tx_to = 'infinity'`),
  ],
);

/** One row per index whose membership we track. */
export const indices = pgTable('indices', {
  indexId: bigint('index_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  code: text('code').notNull().unique('indices_code_key'),
  instrumentId: bigint('instrument_id', { mode: 'number' })
    .notNull()
    .unique('indices_instrument_id_key'),
  proxyFundInstrumentId: bigint('proxy_fund_instrument_id', { mode: 'number' }),
  membershipSourceId: text('membership_source_id'),
  provider: text('provider').notNull(),
});

/** REF-07 membership + weights with history; key (index_id, instrument_id). */
export const indexMembers = pgTable(
  'index_members',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    indexId: bigint('index_id', { mode: 'number' })
      .notNull()
      .references(() => indices.indexId),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    weight: numeric('weight', { precision: 12, scale: 10 }),
    shares: numeric('shares', { precision: 20, scale: 4 }),
    marketValue: numeric('market_value', { precision: 20, scale: 2 }),
    asOfDate: date('as_of_date', { mode: 'string' }).notNull(),
    sourceId: text('source_id').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    txFrom: timestamp('tx_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    txTo: timestamp('tx_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    index('index_members_current_idx')
      .on(t.indexId, t.instrumentId)
      .where(sql`tx_to = 'infinity'`),
    index('index_members_asof_idx')
      .on(t.indexId, t.validFrom, t.validTo)
      .where(sql`tx_to = 'infinity'`),
    index('index_members_inst_idx')
      .on(t.instrumentId)
      .where(sql`tx_to = 'infinity'`),
  ],
);

/** REF-08 minimal: officers, news authors, directory users. */
export const people = pgTable(
  'people',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    personId: bigint('person_id', { mode: 'number' })
      .notNull()
      .default(sql`nextval('person_id_seq')`),
    name: text('name').notNull(),
    role: text('role'),
    issuerId: bigint('issuer_id', { mode: 'number' }),
    userId: bigint('user_id', { mode: 'number' }),
    aliases: text('aliases')
      .array()
      .notNull()
      .default(sql`'{}'`),
    sourceId: text('source_id').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    txFrom: timestamp('tx_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    txTo: timestamp('tx_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    index('people_current_idx')
      .on(t.personId)
      .where(sql`tx_to = 'infinity'`),
    index('people_name_trgm')
      .using('gin', sql`name gin_trgm_ops`)
      .where(sql`tx_to = 'infinity'`),
  ],
);

/** REF-08 hierarchy/ownership shape. */
export const entityRelations = pgTable(
  'entity_relations',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    fromKind: entityKindEnum('from_kind').notNull(),
    fromId: bigint('from_id', { mode: 'number' }).notNull(),
    toKind: entityKindEnum('to_kind').notNull(),
    toId: bigint('to_id', { mode: 'number' }).notNull(),
    relation: text('relation').notNull(),
    weight: numeric('weight', { precision: 12, scale: 10 }),
    sourceId: text('source_id').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    txFrom: timestamp('tx_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    txTo: timestamp('tx_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    index('entity_relations_from_idx')
      .on(t.fromKind, t.fromId)
      .where(sql`tx_to = 'infinity'`),
    index('entity_relations_to_idx')
      .on(t.toKind, t.toId)
      .where(sql`tx_to = 'infinity'`),
  ],
);

/** Name matching for NEWS-02: 'Apple' → issuer. */
export const issuerAliases = pgTable(
  'issuer_aliases',
  {
    issuerId: bigint('issuer_id', { mode: 'number' }).notNull(),
    alias: text('alias').notNull(),
    kind: text('kind').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issuerId, t.alias] }),
    index('issuer_aliases_trgm').using('gin', sql`alias gin_trgm_ops`),
    index('issuer_aliases_lower_idx').on(sql`lower(alias)`),
  ],
);
