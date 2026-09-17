/**
 * Drizzle mirror of migration 0012_workspace_portfolio.sql — the portfolio tables.
 *
 * PORT-07: strictly tenant-isolated; the `FORCE ROW LEVEL SECURITY` policies of migration 0015
 * and the `portfolios_updated` trigger live only in the SQL (allowlisted in the drift test).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { provenance } from './provenance.js';
import { firms, users } from './users.js';

/** A portfolio owned by one user inside one firm. */
export const portfolios = pgTable(
  'portfolios',
  {
    portfolioId: bigint('portfolio_id', { mode: 'number' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    firmId: bigint('firm_id', { mode: 'number' })
      .notNull()
      .references(() => firms.firmId),
    ownerUserId: bigint('owner_user_id', { mode: 'number' })
      .notNull()
      .references(() => users.userId),
    name: text('name').notNull(),
    baseCurrency: char('base_currency', { length: 3 }).notNull().default('USD'),
    /** SPX Index / SPY; deliberately no FK (instruments are bitemporal). */
    benchmarkInstrumentId: bigint('benchmark_instrument_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('portfolios_firm_id_name_key').on(t.firmId, t.name)],
);

/** PORT-01: upload / file drop / API with a reconciliation report. */
export const portfolioImports = pgTable(
  'portfolio_imports',
  {
    importId: bigint('import_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    portfolioId: bigint('portfolio_id', { mode: 'number' })
      .notNull()
      .references(() => portfolios.portfolioId, { onDelete: 'cascade' }),
    firmId: bigint('firm_id', { mode: 'number' }).notNull(),
    uploadedBy: bigint('uploaded_by', { mode: 'number' }).notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    channel: text('channel').notNull(),
    filename: text('filename'),
    asOfDate: date('as_of_date').notNull(),
    rowsTotal: integer('rows_total').notNull().default(0),
    rowsOk: integer('rows_ok').notNull().default(0),
    rowsError: integer('rows_error').notNull().default(0),
    /** `[{row, identifier, column, reason}]` */
    errors: jsonb('errors').notNull().default([]),
    /** `{matched, added, removed, quantityDiffs:[{instrumentId, before, after}]}` */
    reconciliation: jsonb('reconciliation').notNull().default({}),
    status: text('status').notNull(),
    /** Source `internal.user`. */
    provenanceId: bigint('provenance_id', { mode: 'number' }).references(
      () => provenance.provenanceId,
    ),
  },
  (t) => [
    check(
      'portfolio_imports_channel_check',
      sql`${t.channel} IN ('upload','file_drop','api','manual')`,
    ),
    check('portfolio_imports_status_check', sql`${t.status} IN ('accepted','partial','rejected')`),
  ],
);

/** PORT-02: multi-asset, multi-currency; one row per (portfolio, lot, as-of). */
export const positions = pgTable(
  'positions',
  {
    positionId: bigint('position_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    portfolioId: bigint('portfolio_id', { mode: 'number' })
      .notNull()
      .references(() => portfolios.portfolioId, { onDelete: 'cascade' }),
    /** Denormalised for RLS. */
    firmId: bigint('firm_id', { mode: 'number' }).notNull(),
    asOfDate: date('as_of_date').notNull(),
    /** NULL = cash line or unresolved identifier. */
    instrumentId: bigint('instrument_id', { mode: 'number' }),
    rawIdentifier: text('raw_identifier').notNull(),
    isCash: boolean('is_cash').notNull().default(false),
    cashCurrency: char('cash_currency', { length: 3 }),
    lotId: text('lot_id').notNull().default('default'),
    quantity: numeric('quantity', { precision: 24, scale: 8 }).notNull(),
    costPrice: numeric('cost_price', { precision: 18, scale: 6 }),
    costCurrency: char('cost_currency', { length: 3 }),
    tradeDate: date('trade_date'),
    settleDate: date('settle_date'),
    accrued: numeric('accrued', { precision: 18, scale: 6 }).notNull().default('0'),
    reconStatus: text('recon_status').notNull().default('ok'),
    importId: bigint('import_id', { mode: 'number' }).references(() => portfolioImports.importId),
  },
  (t) => [
    // Postgres truncates the generated constraint name at 63 bytes.
    unique('positions_portfolio_id_as_of_date_raw_identifier_lot_id_key').on(
      t.portfolioId,
      t.asOfDate,
      t.rawIdentifier,
      t.lotId,
    ),
    index('positions_portfolio_idx').on(t.portfolioId, t.asOfDate.desc()),
    check(
      'positions_recon_status_check',
      sql`${t.reconStatus} IN ('ok','unresolved','duplicate','price_missing')`,
    ),
  ],
);

/** PORT-02 lot-level cost basis (open lots; `positions` is the as-of snapshot). */
export const lots = pgTable(
  'lots',
  {
    lotId: bigint('lot_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    portfolioId: bigint('portfolio_id', { mode: 'number' })
      .notNull()
      .references(() => portfolios.portfolioId, { onDelete: 'cascade' }),
    firmId: bigint('firm_id', { mode: 'number' }).notNull(),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    openDate: date('open_date').notNull(),
    quantity: numeric('quantity', { precision: 24, scale: 8 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 24, scale: 8 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    closedDate: date('closed_date'),
    externalRef: text('external_ref'),
  },
  (t) => [
    index('lots_portfolio_idx')
      .on(t.portfolioId, t.instrumentId)
      .where(sql`${t.closedDate} IS NULL`),
  ],
);
