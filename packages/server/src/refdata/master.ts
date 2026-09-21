/**
 * Security-master repositories — WORKPLAN §WP-04 L697-700, ARCHITECTURE §4.1 L262-266,
 * DATA_MODEL §3 (migration 0003), REF-01 / REF-02 / REF-03.
 *
 * The five levels of the hierarchy, one repository each:
 *
 * ```
 *   issuers      one legal entity                       Apple Inc.
 *     └ issues     one security / share class / bond    AAPL common stock (share-class FIGI)
 *         └ instruments  what a user names on the line  'AAPL US', 'AAPL GR'  (composite FIGI)
 *             └ listings   one venue                    UW (XNAS), UN (XNYS), UP (ARCX)
 *                 └ md_lines  one (source, symbol) feed cboe.quotes/AAPL, yahoo.chart/AAPL
 * ```
 *
 * Each level is *many* below the one above it (REF-02), so every repository exposes the downward
 * navigation as an as-of read: `issues.byIssuer`, `instruments.byIssue`, `listings.byInstrument`,
 * `mdLines.byInstrument` / `byListing`. There are no foreign keys between these tables and there
 * cannot be: a FK references one row, and every row here is one *version* of an entity, so the
 * parent link is the entity id (`issuer_id`, `issue_id`, …) resolved at the same `(validAt,
 * knownAt)` as the child. Reading a child at one instant and its parent at another is how a
 * past-dated screen quietly acquires a fact nobody knew then, which is why **every** read on this
 * module takes an `AsOf` and there is no `…Now()` convenience anywhere in it.
 *
 * Writes go through `db/bitemporal.ts` and through nothing else (WORKPLAN L690-696): `insert()`
 * allocates the entity id from its sequence and opens the key with `writeVersion`, `upsert()` is
 * the idempotent form an ingest job or a seed uses (`null` = the database already says exactly
 * this), and `write()` forces a new version for a real change or a correction. None of them ever
 * issues an UPDATE: `<table>_bt_guard` would reject it, and the ORM is not a way around that.
 *
 * `id_scheme` cross-references (`identifiers`) are `refdata/identifiers.ts`; resolution
 * (`SecurityRef` → `ResolvedRef`) is `refdata/resolve.ts`. This module is the storage of the five
 * entity tables and nothing more.
 */

import { and, asc, eq, sql, type SQL } from 'drizzle-orm';

import { asOf, bitemporal, upsertVersion, writeVersion } from '../db/bitemporal.js';
import { instruments, issuers, issues, listings, mdLines } from '../db/schema/index.js';

import type {
  AssetClass,
  Bitemporal,
  Instrument,
  InstrumentStatus,
  Issue,
  Issuer,
  IssuerEntityType,
  Listing,
  ListingStatus,
  MarketSector,
  MdLine,
  MdLineKind,
} from '@terminal/core';
import type { AsOf, BitemporalKeys, VersionWrite } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The tables, tagged with their `<table>_bt_excl` key column
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const btIssuers = bitemporal(issuers, 'issuerId');
export const btIssues = bitemporal(issues, 'issueId');
export const btInstruments = bitemporal(instruments, 'instrumentId');
export const btListings = bitemporal(listings, 'listingId');
export const btMdLines = bitemporal(mdLines, 'mdLineId');

type IssuerRow = typeof issuers.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type InstrumentRow = typeof instruments.$inferSelect;
type ListingRow = typeof listings.$inferSelect;
type MdLineRow = typeof mdLines.$inferSelect;

type Data<Row> = Omit<Row, BitemporalKeys | 'versionId'>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Write options
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What every write on this module needs beyond the data itself.
 *
 * `validFrom`/`validTo` are *valid time* — when the fact is true in the world (a listing's first
 * trading day, a symbol book's file date). `knownAt` is *transaction time* — when we learned it.
 * A seed or a replayed ingest run passes the historical knowledge instant (the SEC
 * `acceptanceDateTime`, the file's publication timestamp); a live job may leave it out and take
 * `clock_timestamp()`. Leaving it out inside a test is safe: the writer reads
 * `clock_timestamp()`, never `now()`, so two versions written in one transaction still abut
 * (WORKPLAN L663-680).
 */
export interface WriteOptions {
  validFrom: Date;
  /** Omitted → `'infinity'`: true from `validFrom` until something says otherwise. */
  validTo?: Date;
  provenanceId: number;
  /** The knowledge instant → `tx_from`. Omitted → `clock_timestamp()`. */
  knownAt?: Date;
  /** Audit label; defaults to `'initial'` for `insert()` and `'change'` for the others. */
  reason?: VersionWrite<unknown>['reason'];
}

function versionWrite<Row>(
  entityKey: Partial<Row>,
  data: Data<Row>,
  o: WriteOptions,
  fallbackReason: VersionWrite<Row>['reason'],
): VersionWrite<Row> {
  const w: VersionWrite<Row> = {
    entityKey,
    validFrom: o.validFrom,
    data,
    provenanceId: o.provenanceId,
    reason: o.reason ?? fallbackReason,
  };
  // `exactOptionalPropertyTypes`: an explicit `undefined` is not the same as an absent key, and
  // `VersionWrite` distinguishes them (`validTo` absent = 'infinity', `txFrom` absent = clock).
  if (o.validTo !== undefined) w.validTo = o.validTo;
  if (o.knownAt !== undefined) w.txFrom = o.knownAt;
  return w;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row ⇄ domain mapping
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Assign only when present: `exactOptionalPropertyTypes` rejects an explicit `undefined`. */
function set<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

/**
 * A `char(n)` column comes back space-padded when the stored value is shorter than the column
 * (`sic` '99', a two-letter `country` in a `char(2)` is exact, a short `mic` is not), and an empty
 * string is never a value. Both become "absent".
 */
function text(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

interface VersionRow {
  versionId: number;
  validFrom: string;
  validTo: string;
  txFrom: string;
  txTo: string;
  provenanceId: number;
}

function version(row: VersionRow): Bitemporal {
  return {
    versionId: row.versionId,
    validFrom: row.validFrom,
    validTo: row.validTo,
    txFrom: row.txFrom,
    txTo: row.txTo,
    provenanceId: row.provenanceId,
  };
}

/** `[{name, from, to}]` — SEC `submissions.formerNames`, stored as jsonb. */
export interface FormerName {
  name: string;
  from?: string;
  to?: string;
}

/**
 * `@terminal/core`'s `Issuer` plus the `issuers` columns it does not carry. The core type is the
 * shared vocabulary; the extra columns are what DES, SECF and the SEC adapters actually store,
 * and dropping them on the floor here would mean re-reading the table to get them back.
 */
export interface IssuerRecord extends Issuer {
  stateOfInc?: string;
  sicDescription?: string;
  filerCategory?: string;
  website?: string;
  formerNames: FormerName[];
}

export interface IssuerInput {
  name: string;
  legalName?: string;
  lei?: string;
  /** Zero-padded to 10, as `@terminal/core`'s `padCik` produces it. */
  cik?: string;
  country?: string;
  stateOfInc?: string;
  sic?: string;
  sicDescription?: string;
  entityType?: IssuerEntityType;
  /** 'MMDD' from SEC `submissions.fiscalYearEnd`. */
  fiscalYearEnd?: string;
  filerCategory?: string;
  website?: string;
  formerNames?: FormerName[];
}

function issuerData(issuerId: number, input: IssuerInput): Data<IssuerRow> {
  return {
    issuerId,
    name: input.name,
    legalName: input.legalName ?? null,
    lei: input.lei ?? null,
    cik: input.cik ?? null,
    country: input.country ?? null,
    stateOfInc: input.stateOfInc ?? null,
    sic: input.sic ?? null,
    sicDescription: input.sicDescription ?? null,
    entityType: input.entityType ?? 'operating',
    fiscalYearEnd: input.fiscalYearEnd ?? null,
    filerCategory: input.filerCategory ?? null,
    website: input.website ?? null,
    formerNames: input.formerNames ?? [],
  };
}

function toIssuer(row: IssuerRow): IssuerRecord {
  const out: IssuerRecord = {
    ...version(row),
    issuerId: row.issuerId,
    name: row.name,
    entityType: row.entityType as IssuerEntityType,
    formerNames: (row.formerNames as FormerName[] | null) ?? [],
  };
  set(out, 'legalName', text(row.legalName));
  set(out, 'lei', text(row.lei));
  set(out, 'cik', text(row.cik));
  set(out, 'country', text(row.country));
  set(out, 'stateOfInc', text(row.stateOfInc));
  set(out, 'sic', text(row.sic));
  set(out, 'sicDescription', text(row.sicDescription));
  set(out, 'fiscalYearEnd', text(row.fiscalYearEnd));
  set(out, 'filerCategory', text(row.filerCategory));
  set(out, 'website', text(row.website));
  return out;
}

/** The record as it would be written again — for "read the current version, change one field". */
export function toIssuerInput(record: IssuerRecord): IssuerInput {
  const out: IssuerInput = { name: record.name, entityType: record.entityType };
  set(out, 'legalName', record.legalName);
  set(out, 'lei', record.lei);
  set(out, 'cik', record.cik);
  set(out, 'country', record.country);
  set(out, 'stateOfInc', record.stateOfInc);
  set(out, 'sic', record.sic);
  set(out, 'sicDescription', record.sicDescription);
  set(out, 'fiscalYearEnd', record.fiscalYearEnd);
  set(out, 'filerCategory', record.filerCategory);
  set(out, 'website', record.website);
  out.formerNames = record.formerNames;
  return out;
}

export interface IssueRecord extends Issue {
  securityType2?: string;
  /** `numeric(18,6)`, carried as the exact decimal string Postgres returned. */
  parValue?: string;
}

export interface IssueInput {
  issuerId: number;
  assetClass: AssetClass;
  /** OpenFIGI `securityType`: 'Common Stock', 'ETP', 'Index', 'US GOVERNMENT', … */
  securityType: string;
  securityType2?: string;
  shareClassFigi?: string;
  isin?: string;
  cusip?: string;
  sedol?: string;
  name: string;
  currency: string;
  countryOfIssue?: string;
  parValue?: string;
}

function issueData(issueId: number, input: IssueInput): Data<IssueRow> {
  return {
    issueId,
    issuerId: input.issuerId,
    assetClass: input.assetClass,
    securityType: input.securityType,
    securityType2: input.securityType2 ?? null,
    shareClassFigi: input.shareClassFigi ?? null,
    isin: input.isin ?? null,
    cusip: input.cusip ?? null,
    sedol: input.sedol ?? null,
    name: input.name,
    currency: input.currency,
    countryOfIssue: input.countryOfIssue ?? null,
    parValue: input.parValue ?? null,
  };
}

function toIssue(row: IssueRow): IssueRecord {
  const out: IssueRecord = {
    ...version(row),
    issueId: row.issueId,
    issuerId: row.issuerId,
    assetClass: row.assetClass,
    securityType: row.securityType,
    name: row.name,
    currency: row.currency.trim(),
  };
  set(out, 'securityType2', text(row.securityType2));
  set(out, 'shareClassFigi', text(row.shareClassFigi));
  set(out, 'isin', text(row.isin));
  set(out, 'cusip', text(row.cusip));
  set(out, 'sedol', text(row.sedol));
  set(out, 'countryOfIssue', text(row.countryOfIssue));
  set(out, 'parValue', text(row.parValue));
  return out;
}

export function toIssueInput(record: IssueRecord): IssueInput {
  const out: IssueInput = {
    issuerId: record.issuerId,
    assetClass: record.assetClass,
    securityType: record.securityType,
    name: record.name,
    currency: record.currency,
  };
  set(out, 'securityType2', record.securityType2);
  set(out, 'shareClassFigi', record.shareClassFigi);
  set(out, 'isin', record.isin);
  set(out, 'cusip', record.cusip);
  set(out, 'sedol', record.sedol);
  set(out, 'countryOfIssue', record.countryOfIssue);
  set(out, 'parValue', record.parValue);
  return out;
}

export interface InstrumentRecord extends Instrument {
  /** Display hint (Yahoo `priceHint`); the formatter in core decides what to do with it. */
  priceDecimals: number;
  firstTradeDate?: string;
}

export interface InstrumentInput {
  issueId: number;
  assetClass: AssetClass;
  marketSector: MarketSector;
  compositeFigi?: string;
  ticker: string;
  /** OpenFIGI composite code 'US'; 'GOVT','FX','INDEX','RATE','ECON','CRYPTO' when not listed. */
  exchCode: string;
  name: string;
  currency: string;
  primaryListingId?: number;
  status?: InstrumentStatus;
  searchWeight?: number;
  priceDecimals?: number;
  firstTradeDate?: string;
}

function instrumentData(instrumentId: number, input: InstrumentInput): Data<InstrumentRow> {
  return {
    instrumentId,
    issueId: input.issueId,
    assetClass: input.assetClass,
    marketSector: input.marketSector,
    compositeFigi: input.compositeFigi ?? null,
    ticker: input.ticker,
    exchCode: input.exchCode,
    name: input.name,
    currency: input.currency,
    primaryListingId: input.primaryListingId ?? null,
    status: input.status ?? 'active',
    searchWeight: input.searchWeight ?? 1,
    priceDecimals: input.priceDecimals ?? 2,
    firstTradeDate: input.firstTradeDate ?? null,
  };
}

function toInstrument(row: InstrumentRow): InstrumentRecord {
  const out: InstrumentRecord = {
    ...version(row),
    instrumentId: row.instrumentId,
    issueId: row.issueId,
    assetClass: row.assetClass,
    marketSector: row.marketSector,
    ticker: row.ticker,
    exchCode: row.exchCode,
    name: row.name,
    currency: row.currency.trim(),
    status: row.status as InstrumentStatus,
    searchWeight: row.searchWeight,
    priceDecimals: row.priceDecimals,
  };
  set(out, 'compositeFigi', text(row.compositeFigi));
  set(out, 'primaryListingId', row.primaryListingId ?? undefined);
  set(out, 'firstTradeDate', text(row.firstTradeDate));
  return out;
}

export function toInstrumentInput(record: InstrumentRecord): InstrumentInput {
  const out: InstrumentInput = {
    issueId: record.issueId,
    assetClass: record.assetClass,
    marketSector: record.marketSector,
    ticker: record.ticker,
    exchCode: record.exchCode,
    name: record.name,
    currency: record.currency,
    status: record.status,
    searchWeight: record.searchWeight,
    priceDecimals: record.priceDecimals,
  };
  set(out, 'compositeFigi', record.compositeFigi);
  set(out, 'primaryListingId', record.primaryListingId);
  set(out, 'firstTradeDate', record.firstTradeDate);
  return out;
}

export type ListingRecord = Listing;

export interface ListingInput {
  instrumentId: number;
  figi?: string;
  mic?: string;
  /** OpenFIGI venue code 'UW'. */
  exchCode: string;
  localTicker: string;
  isPrimary?: boolean;
  listingStatus?: ListingStatus;
}

function listingData(listingId: number, input: ListingInput): Data<ListingRow> {
  return {
    listingId,
    instrumentId: input.instrumentId,
    figi: input.figi ?? null,
    mic: input.mic ?? null,
    exchCode: input.exchCode,
    localTicker: input.localTicker,
    isPrimary: input.isPrimary ?? false,
    listingStatus: input.listingStatus ?? 'active',
  };
}

function toListing(row: ListingRow): ListingRecord {
  const out: ListingRecord = {
    ...version(row),
    listingId: row.listingId,
    instrumentId: row.instrumentId,
    exchCode: row.exchCode,
    localTicker: row.localTicker,
    isPrimary: row.isPrimary,
    listingStatus: row.listingStatus as ListingStatus,
  };
  set(out, 'figi', text(row.figi));
  set(out, 'mic', text(row.mic));
  return out;
}

export function toListingInput(record: ListingRecord): ListingInput {
  const out: ListingInput = {
    instrumentId: record.instrumentId,
    exchCode: record.exchCode,
    localTicker: record.localTicker,
    isPrimary: record.isPrimary,
    listingStatus: record.listingStatus,
  };
  set(out, 'figi', record.figi);
  set(out, 'mic', record.mic);
  return out;
}

export type MdLineRecord = MdLine;

export interface MdLineInput {
  instrumentId: number;
  /** Absent = the composite line. */
  listingId?: number;
  /** `licence_registry.source_id` — the `md_lines_source_known` trigger checks it exists. */
  sourceId: string;
  providerSymbol: string;
  lineKind: MdLineKind;
  intrinsicDelayMin: number;
  expectedIntervalMs: number;
  /** Lower wins ties in the composite merge (cboe 10, yahoo 20). */
  priority?: number;
}

function mdLineData(mdLineId: number, input: MdLineInput): Data<MdLineRow> {
  return {
    mdLineId,
    instrumentId: input.instrumentId,
    listingId: input.listingId ?? null,
    sourceId: input.sourceId,
    providerSymbol: input.providerSymbol,
    lineKind: input.lineKind,
    intrinsicDelayMin: input.intrinsicDelayMin,
    expectedIntervalMs: input.expectedIntervalMs,
    priority: input.priority ?? 100,
  };
}

function toMdLine(row: MdLineRow): MdLineRecord {
  const out: MdLineRecord = {
    ...version(row),
    mdLineId: row.mdLineId,
    instrumentId: row.instrumentId,
    sourceId: row.sourceId,
    providerSymbol: row.providerSymbol,
    lineKind: row.lineKind as MdLineKind,
    intrinsicDelayMin: row.intrinsicDelayMin,
    expectedIntervalMs: row.expectedIntervalMs,
    priority: row.priority,
  };
  set(out, 'listingId', row.listingId ?? undefined);
  return out;
}

export function toMdLineInput(record: MdLineRecord): MdLineInput {
  const out: MdLineInput = {
    instrumentId: record.instrumentId,
    sourceId: record.sourceId,
    providerSymbol: record.providerSymbol,
    lineKind: record.lineKind,
    intrinsicDelayMin: record.intrinsicDelayMin,
    expectedIntervalMs: record.expectedIntervalMs,
    priority: record.priority,
  };
  set(out, 'listingId', record.listingId);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared internals
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The next entity id from its sequence.
 *
 * Sequences are not transactional, which is the point: two concurrent ingest workers creating the
 * same issuer get two ids and one of them loses the `<table>_bt_excl` race on the identifier
 * instead of silently sharing a key. Never assert a literal id value anywhere.
 */
async function nextId(tx: Tx, sequence: string): Promise<number> {
  const res = await tx.execute<{ id: string }>(
    sql`SELECT nextval(${sequence}::regclass)::bigint AS id`,
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error(`nextval('${sequence}') returned no row`);
  return Number(row.id);
}

function first<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Repositories
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Legal entities (REF-02 level 1). */
export class IssuerRepository {
  constructor(private readonly tx: Tx) {}

  /** Open a new issuer key: allocates `issuer_id` and writes its first version. */
  async insert(input: IssuerInput, o: WriteOptions): Promise<number> {
    const issuerId = await nextId(this.tx, 'issuer_id_seq');
    await writeVersion(
      this.tx,
      btIssuers,
      versionWrite({ issuerId }, issuerData(issuerId, input), o, 'initial'),
    );
    return issuerId;
  }

  /** Idempotent write: `null` when the current version already says exactly this. */
  upsert(issuerId: number, input: IssuerInput, o: WriteOptions): Promise<number | null> {
    return upsertVersion(
      this.tx,
      btIssuers,
      versionWrite({ issuerId }, issuerData(issuerId, input), o, 'change'),
    );
  }

  /** Unconditional new version — a real change, or a correction of what we believed. */
  write(issuerId: number, input: IssuerInput, o: WriteOptions): Promise<number> {
    return writeVersion(
      this.tx,
      btIssuers,
      versionWrite({ issuerId }, issuerData(issuerId, input), o, 'change'),
    );
  }

  async get(issuerId: number, at: AsOf): Promise<IssuerRecord | null> {
    const rows = await this.select(eq(issuers.issuerId, issuerId), at);
    return first(rows);
  }

  /** SEC CIK, zero-padded. */
  async byCik(cik: string, at: AsOf): Promise<IssuerRecord[]> {
    return this.select(eq(issuers.cik, cik), at);
  }

  async byLei(lei: string, at: AsOf): Promise<IssuerRecord[]> {
    return this.select(eq(issuers.lei, lei.toUpperCase()), at);
  }

  private async select(where: SQL | undefined, at: AsOf): Promise<IssuerRecord[]> {
    const rows = await this.tx
      .select()
      .from(issuers)
      .where(and(where, asOf(btIssuers, at)))
      .orderBy(asc(issuers.issuerId));
    return rows.map(toIssuer);
  }
}

/** Securities / share classes / bond issues (REF-02 level 2). */
export class IssueRepository {
  constructor(private readonly tx: Tx) {}

  async insert(input: IssueInput, o: WriteOptions): Promise<number> {
    const issueId = await nextId(this.tx, 'issue_id_seq');
    await writeVersion(
      this.tx,
      btIssues,
      versionWrite({ issueId }, issueData(issueId, input), o, 'initial'),
    );
    return issueId;
  }

  upsert(issueId: number, input: IssueInput, o: WriteOptions): Promise<number | null> {
    return upsertVersion(
      this.tx,
      btIssues,
      versionWrite({ issueId }, issueData(issueId, input), o, 'change'),
    );
  }

  write(issueId: number, input: IssueInput, o: WriteOptions): Promise<number> {
    return writeVersion(
      this.tx,
      btIssues,
      versionWrite({ issueId }, issueData(issueId, input), o, 'change'),
    );
  }

  async get(issueId: number, at: AsOf): Promise<IssueRecord | null> {
    return first(await this.select(eq(issues.issueId, issueId), at));
  }

  /** Every issue of one issuer, as of `(validAt, knownAt)` — one issuer, many issues. */
  byIssuer(issuerId: number, at: AsOf): Promise<IssueRecord[]> {
    return this.select(eq(issues.issuerId, issuerId), at);
  }

  byIsin(isin: string, at: AsOf): Promise<IssueRecord[]> {
    return this.select(eq(issues.isin, isin.toUpperCase()), at);
  }

  byCusip(cusip: string, at: AsOf): Promise<IssueRecord[]> {
    return this.select(eq(issues.cusip, cusip.toUpperCase()), at);
  }

  private async select(where: SQL | undefined, at: AsOf): Promise<IssueRecord[]> {
    const rows = await this.tx
      .select()
      .from(issues)
      .where(and(where, asOf(btIssues, at)))
      .orderBy(asc(issues.issueId));
    return rows.map(toIssue);
  }
}

/** What a user names on the command line (REF-02 level 3). */
export class InstrumentRepository {
  constructor(private readonly tx: Tx) {}

  async insert(input: InstrumentInput, o: WriteOptions): Promise<number> {
    const instrumentId = await nextId(this.tx, 'instrument_id_seq');
    await writeVersion(
      this.tx,
      btInstruments,
      versionWrite({ instrumentId }, instrumentData(instrumentId, input), o, 'initial'),
    );
    return instrumentId;
  }

  upsert(instrumentId: number, input: InstrumentInput, o: WriteOptions): Promise<number | null> {
    return upsertVersion(
      this.tx,
      btInstruments,
      versionWrite({ instrumentId }, instrumentData(instrumentId, input), o, 'change'),
    );
  }

  write(instrumentId: number, input: InstrumentInput, o: WriteOptions): Promise<number> {
    return writeVersion(
      this.tx,
      btInstruments,
      versionWrite({ instrumentId }, instrumentData(instrumentId, input), o, 'change'),
    );
  }

  async get(instrumentId: number, at: AsOf): Promise<InstrumentRecord | null> {
    return first(await this.select(eq(instruments.instrumentId, instrumentId), at));
  }

  /** One issue, many instruments: AAPL US, AAPL GR, AAPL LN. */
  byIssue(issueId: number, at: AsOf): Promise<InstrumentRecord[]> {
    return this.select(eq(instruments.issueId, issueId), at);
  }

  /**
   * The `instruments_ticker_idx` lookup: case-insensitive ticker, optionally narrowed by the
   * composite exchange code and the market sector. A ticker is **not** an identity (REF-01), so
   * this returns every match and the caller decides — `refdata/resolve.ts` never guesses.
   */
  byTicker(
    ticker: string,
    at: AsOf,
    narrow: { exchCode?: string; marketSector?: MarketSector } = {},
  ): Promise<InstrumentRecord[]> {
    const parts: (SQL | undefined)[] = [
      sql`upper(${instruments.ticker}) = ${ticker.toUpperCase()}`,
    ];
    if (narrow.exchCode !== undefined) parts.push(eq(instruments.exchCode, narrow.exchCode));
    if (narrow.marketSector !== undefined) {
      parts.push(eq(instruments.marketSector, narrow.marketSector));
    }
    return this.select(and(...parts), at);
  }

  byCompositeFigi(figi: string, at: AsOf): Promise<InstrumentRecord[]> {
    return this.select(eq(instruments.compositeFigi, figi.toUpperCase()), at);
  }

  private async select(where: SQL | undefined, at: AsOf): Promise<InstrumentRecord[]> {
    const rows = await this.tx
      .select()
      .from(instruments)
      .where(and(where, asOf(btInstruments, at)))
      .orderBy(asc(instruments.instrumentId));
    return rows.map(toInstrument);
  }
}

/** Venue listings (REF-02 level 4). */
export class ListingRepository {
  constructor(private readonly tx: Tx) {}

  async insert(input: ListingInput, o: WriteOptions): Promise<number> {
    const listingId = await nextId(this.tx, 'listing_id_seq');
    await writeVersion(
      this.tx,
      btListings,
      versionWrite({ listingId }, listingData(listingId, input), o, 'initial'),
    );
    return listingId;
  }

  upsert(listingId: number, input: ListingInput, o: WriteOptions): Promise<number | null> {
    return upsertVersion(
      this.tx,
      btListings,
      versionWrite({ listingId }, listingData(listingId, input), o, 'change'),
    );
  }

  write(listingId: number, input: ListingInput, o: WriteOptions): Promise<number> {
    return writeVersion(
      this.tx,
      btListings,
      versionWrite({ listingId }, listingData(listingId, input), o, 'change'),
    );
  }

  async get(listingId: number, at: AsOf): Promise<ListingRecord | null> {
    return first(await this.select(eq(listings.listingId, listingId), at));
  }

  /** One instrument, many listings. */
  byInstrument(instrumentId: number, at: AsOf): Promise<ListingRecord[]> {
    return this.select(eq(listings.instrumentId, instrumentId), at);
  }

  byFigi(figi: string, at: AsOf): Promise<ListingRecord[]> {
    return this.select(eq(listings.figi, figi.toUpperCase()), at);
  }

  /** The primary venue at that instant, if one is flagged. */
  async primaryOf(instrumentId: number, at: AsOf): Promise<ListingRecord | null> {
    const rows = await this.select(
      and(eq(listings.instrumentId, instrumentId), eq(listings.isPrimary, true)),
      at,
    );
    return first(rows);
  }

  private async select(where: SQL | undefined, at: AsOf): Promise<ListingRecord[]> {
    const rows = await this.tx
      .select()
      .from(listings)
      .where(and(where, asOf(btListings, at)))
      .orderBy(asc(listings.listingId));
    return rows.map(toListing);
  }
}

/** Market-data lines (REF-02 level 5): one listing (or the composite) → many feeds. */
export class MdLineRepository {
  constructor(private readonly tx: Tx) {}

  async insert(input: MdLineInput, o: WriteOptions): Promise<number> {
    const mdLineId = await nextId(this.tx, 'md_line_id_seq');
    await writeVersion(
      this.tx,
      btMdLines,
      versionWrite({ mdLineId }, mdLineData(mdLineId, input), o, 'initial'),
    );
    return mdLineId;
  }

  upsert(mdLineId: number, input: MdLineInput, o: WriteOptions): Promise<number | null> {
    return upsertVersion(
      this.tx,
      btMdLines,
      versionWrite({ mdLineId }, mdLineData(mdLineId, input), o, 'change'),
    );
  }

  write(mdLineId: number, input: MdLineInput, o: WriteOptions): Promise<number> {
    return writeVersion(
      this.tx,
      btMdLines,
      versionWrite({ mdLineId }, mdLineData(mdLineId, input), o, 'change'),
    );
  }

  /**
   * Upsert keyed by what the *provider* knows — `(source_id, provider_symbol)`, which is what
   * `md_lines_symbol_excl` actually constrains. An ingest job that allocated a fresh
   * `md_line_id` on every run would insert a second current line for the same symbol and get
   * SQLSTATE 23P01; this finds the line that already carries the symbol and writes a version of
   * it instead.
   *
   * @returns the line id, and whether this call actually wrote a version (a second run of the
   *          same job writes nothing and reports `written: false`).
   */
  async upsertBySymbol(
    input: MdLineInput,
    o: WriteOptions,
  ): Promise<{ mdLineId: number; written: boolean }> {
    // "As currently believed, valid at the instant this write takes effect" — deliberately not an
    // `asOf` read against a wall clock, which would need a `Clock` the writer does not have and
    // would answer a different question than the constraint asks.
    const rows = await this.tx
      .select({ mdLineId: mdLines.mdLineId })
      .from(mdLines)
      .where(
        and(
          eq(mdLines.sourceId, input.sourceId),
          eq(mdLines.providerSymbol, input.providerSymbol),
          sql`${mdLines.txTo} = 'infinity'`,
          sql`${mdLines.validFrom} <= ${o.validFrom}::timestamptz`,
          sql`${mdLines.validTo} > ${o.validFrom}::timestamptz`,
        ),
      )
      .orderBy(asc(mdLines.mdLineId));
    const existing = first(rows);
    if (existing === null) {
      const mdLineId = await this.insert(input, o);
      return { mdLineId, written: true };
    }
    const versionId = await this.upsert(existing.mdLineId, input, o);
    return { mdLineId: existing.mdLineId, written: versionId !== null };
  }

  async get(mdLineId: number, at: AsOf): Promise<MdLineRecord | null> {
    return first(await this.select(eq(mdLines.mdLineId, mdLineId), at));
  }

  /** Every line feeding an instrument — composite and venue alike, cheapest priority first. */
  async byInstrument(instrumentId: number, at: AsOf): Promise<MdLineRecord[]> {
    const rows = await this.tx
      .select()
      .from(mdLines)
      .where(and(eq(mdLines.instrumentId, instrumentId), asOf(btMdLines, at)))
      .orderBy(asc(mdLines.priority), asc(mdLines.mdLineId));
    return rows.map(toMdLine);
  }

  byListing(listingId: number, at: AsOf): Promise<MdLineRecord[]> {
    return this.select(eq(mdLines.listingId, listingId), at);
  }

  bySymbol(sourceId: string, providerSymbol: string, at: AsOf): Promise<MdLineRecord[]> {
    return this.select(
      and(eq(mdLines.sourceId, sourceId), eq(mdLines.providerSymbol, providerSymbol)),
      at,
    );
  }

  private async select(where: SQL | undefined, at: AsOf): Promise<MdLineRecord[]> {
    const rows = await this.tx
      .select()
      .from(mdLines)
      .where(and(where, asOf(btMdLines, at)))
      .orderBy(asc(mdLines.mdLineId));
    return rows.map(toMdLine);
  }
}

/**
 * The five repositories bound to one transaction — what a service, an ingest job or a test
 * constructs once and passes down.
 */
export class MasterRepositories {
  readonly issuers: IssuerRepository;
  readonly issues: IssueRepository;
  readonly instruments: InstrumentRepository;
  readonly listings: ListingRepository;
  readonly mdLines: MdLineRepository;

  constructor(tx: Tx) {
    this.issuers = new IssuerRepository(tx);
    this.issues = new IssueRepository(tx);
    this.instruments = new InstrumentRepository(tx);
    this.listings = new ListingRepository(tx);
    this.mdLines = new MdLineRepository(tx);
  }
}

/** Convenience: `masterRepositories(tx).instruments.byTicker(…)`. */
export function masterRepositories(tx: Tx): MasterRepositories {
  return new MasterRepositories(tx);
}
