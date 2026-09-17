/**
 * Postgres enum types, declared once and imported by every schema module.
 * Mirrors `drizzle/migrations/0001_extensions_enums.sql`.
 *
 * The value lists are order-sensitive: Postgres sorts an enum by declaration
 * order, and `tier` in particular is declared in rank order (eod < delayed <
 * realtime) because `tier_rank()` and the entitlement evaluator rely on it.
 */
import { pgEnum } from 'drizzle-orm/pg-core';

export const assetClassEnum = pgEnum('asset_class', [
  'equity',
  'etf',
  'index',
  'fx',
  'govt',
  'option',
  'future',
  'crypto',
  'rate',
  'econ',
]);

export const marketSectorEnum = pgEnum('market_sector', [
  'Equity',
  'Index',
  'Curncy',
  'Govt',
  'Corp',
  'Comdty',
  'Mtge',
  'Muni',
  'Pfd',
  'M-Mkt',
  'Crypto',
]);

export const idSchemeEnum = pgEnum('id_scheme', [
  'FIGI',
  'COMPOSITE_FIGI',
  'SHARE_CLASS_FIGI',
  'ISIN',
  'CUSIP',
  'SEDOL',
  'RIC',
  'TICKER_EXCH',
  'LEI',
  'MIC',
  'CIK',
  'OCC',
  'PROVIDER_SYMBOL',
  'SERIES_CODE',
]);

export const tierEnum = pgEnum('tier', ['eod', 'delayed', 'realtime']);

export const usageTypeEnum = pgEnum('usage_type', ['display', 'export', 'api']);

export const fieldClassEnum = pgEnum('field_class', [
  'price',
  'reference',
  'fundamental',
  'econ',
  'news',
  'analytic',
  'derived',
  'portfolio',
]);

export const entlDecisionEnum = pgEnum('entl_decision', ['allow', 'downgrade', 'deny']);

export const caTypeEnum = pgEnum('ca_type', [
  'cash_dividend',
  'special_dividend',
  'stock_dividend',
  'split',
  'reverse_split',
  'spinoff',
  'merger',
  'tender',
  'rights',
  'call',
  'conversion',
  'name_change',
  'ticker_change',
  'delisting',
  'capital_return',
]);

export const caStatusEnum = pgEnum('ca_status', [
  'estimated',
  'announced',
  'confirmed',
  'paid',
  'cancelled',
]);

export const entityKindEnum = pgEnum('entity_kind', [
  'issuer',
  'issue',
  'instrument',
  'listing',
  'person',
  'topic',
]);

export const sessionStateEnum = pgEnum('session_state', [
  'pre',
  'open',
  'auction',
  'halted',
  'closed',
  'post',
  'unknown',
]);
