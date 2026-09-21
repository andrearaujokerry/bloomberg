/**
 * Instrument terms by asset class — WORKPLAN WP-04 L693-694, DATA_MODEL §4 (`govt_terms` …
 * `rate_terms`), CONTRACTS §1.2 L75-783, REF-04 / REF-05.
 *
 * Seven tables, one per asset class that *has* contractual terms, all keyed on `instrument_id`
 * and all bitemporal: a coupon that is corrected, an option root that is re-struck after a split,
 * an index methodology that changes in 2027 — each is a new version, never an UPDATE. Every write
 * goes through `db/bitemporal.ts` (`writeVersion` / `upsertVersion`) and every read through the
 * `bt_as_of(...)` predicate, so a past-dated read can never return something we did not know then.
 *
 * ## The discriminated read
 *
 * A caller that has an `instruments` row does not want to know which of the seven tables to look
 * in — that is a property of `instruments.asset_class`, and encoding it at each call site is how
 * an `etf` ends up read from `index_terms`. {@link termsKindForAssetClass} is the single mapping
 * and {@link TermsRepository.forInstrument} is the single read:
 *
 *     const terms = await repo.forInstrument(id, 'govt', at);
 *     if (terms?.kind === 'govt') terms.terms.maturityDate;   // narrowed to GovtTermsRow
 *
 * Three asset classes have no terms table at all (`equity`, `crypto`, `econ`): their reference
 * data is `instruments` + `issues` + `issuers` (equity), the `md_lines` of the crypto feed, and
 * `econ_series` respectively. `forInstrument` answers `null` for them, which is a fact, not a
 * miss — nothing further is fetched and no caller has to special-case a throw.
 *
 * Row shapes come from the drizzle mirror, so `numeric` reads back as a string (`'4.250000'`) and
 * `date` as an ISO day (`'2036-08-15'`): the analytics layer parses what it needs and nothing is
 * silently rounded through a float on the way out of the database.
 */

import { and, eq, inArray } from 'drizzle-orm';

import type { AssetClass } from '@terminal/core';

import {
  asOf,
  bitemporal,
  upsertVersion,
  writeVersion,
  type AsOf,
  type BitemporalKeys,
  type BitemporalTable,
  type VersionWrite,
} from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';
import {
  fundTerms,
  futureTerms,
  fxTerms,
  govtTerms,
  indexTerms,
  optionTerms,
  rateTerms,
} from '../db/schema/terms.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The seven tables
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The seven terms tables of CONTRACTS §1.2, by the tag the discriminated read returns. */
export const TERMS_TABLES = {
  govt: govtTerms,
  option: optionTerms,
  future: futureTerms,
  fund: fundTerms,
  index: indexTerms,
  fx: fxTerms,
  rate: rateTerms,
} as const;

/** `'govt' | 'option' | 'future' | 'fund' | 'index' | 'fx' | 'rate'`. */
export type TermsKind = keyof typeof TERMS_TABLES;

/** The seven kinds in a stable order (the order CONTRACTS §1.2 declares the tables). */
export const TERMS_KINDS: readonly TermsKind[] = Object.freeze([
  'govt',
  'option',
  'future',
  'fund',
  'index',
  'fx',
  'rate',
] as const);

/**
 * The `<table>_bt_excl` wrappers. All seven are keyed on `instrument_id` alone, so a second
 * current version of one instrument's terms covering an overlapping valid range is rejected by
 * the database with SQLSTATE 23P01 rather than by a convention here.
 */
const BT: Readonly<Record<TermsKind, BitemporalTable<Record<string, unknown>>>> = Object.freeze({
  govt: bitemporal(govtTerms, 'instrumentId'),
  option: bitemporal(optionTerms, 'instrumentId'),
  future: bitemporal(futureTerms, 'instrumentId'),
  fund: bitemporal(fundTerms, 'instrumentId'),
  index: bitemporal(indexTerms, 'instrumentId'),
  fx: bitemporal(fxTerms, 'instrumentId'),
  rate: bitemporal(rateTerms, 'instrumentId'),
});

/**
 * The as-of and history reads, one closure per table.
 *
 * A single generic `select().from(TERMS_TABLES[kind])` does not type-check: drizzle infers the
 * selected shape from the *concrete* table, and a union of seven tables collapses that inference
 * to an empty selection. Seven concrete closures behind a mapped type keep both halves honest —
 * each query is written against its own table, and `READERS[kind]` still returns `TermsRow<K>`.
 */
const READERS: {
  [K in TermsKind]: {
    asOf(tx: Tx, ids: readonly number[], at: AsOf): Promise<TermsRow<K>[]>;
    history(tx: Tx, instrumentId: number): Promise<TermsRow<K>[]>;
  };
} = {
  govt: {
    asOf: (tx, ids, at) =>
      tx
        .select()
        .from(govtTerms)
        .where(and(inArray(govtTerms.instrumentId, [...ids]), asOf(govtTerms, at))),
    history: (tx, id) =>
      tx
        .select()
        .from(govtTerms)
        .where(eq(govtTerms.instrumentId, id))
        .orderBy(govtTerms.txFrom, govtTerms.validFrom),
  },
  option: {
    asOf: (tx, ids, at) =>
      tx
        .select()
        .from(optionTerms)
        .where(and(inArray(optionTerms.instrumentId, [...ids]), asOf(optionTerms, at))),
    history: (tx, id) =>
      tx
        .select()
        .from(optionTerms)
        .where(eq(optionTerms.instrumentId, id))
        .orderBy(optionTerms.txFrom, optionTerms.validFrom),
  },
  future: {
    asOf: (tx, ids, at) =>
      tx
        .select()
        .from(futureTerms)
        .where(and(inArray(futureTerms.instrumentId, [...ids]), asOf(futureTerms, at))),
    history: (tx, id) =>
      tx
        .select()
        .from(futureTerms)
        .where(eq(futureTerms.instrumentId, id))
        .orderBy(futureTerms.txFrom, futureTerms.validFrom),
  },
  fund: {
    asOf: (tx, ids, at) =>
      tx
        .select()
        .from(fundTerms)
        .where(and(inArray(fundTerms.instrumentId, [...ids]), asOf(fundTerms, at))),
    history: (tx, id) =>
      tx
        .select()
        .from(fundTerms)
        .where(eq(fundTerms.instrumentId, id))
        .orderBy(fundTerms.txFrom, fundTerms.validFrom),
  },
  index: {
    asOf: (tx, ids, at) =>
      tx
        .select()
        .from(indexTerms)
        .where(and(inArray(indexTerms.instrumentId, [...ids]), asOf(indexTerms, at))),
    history: (tx, id) =>
      tx
        .select()
        .from(indexTerms)
        .where(eq(indexTerms.instrumentId, id))
        .orderBy(indexTerms.txFrom, indexTerms.validFrom),
  },
  fx: {
    asOf: (tx, ids, at) =>
      tx
        .select()
        .from(fxTerms)
        .where(and(inArray(fxTerms.instrumentId, [...ids]), asOf(fxTerms, at))),
    history: (tx, id) =>
      tx
        .select()
        .from(fxTerms)
        .where(eq(fxTerms.instrumentId, id))
        .orderBy(fxTerms.txFrom, fxTerms.validFrom),
  },
  rate: {
    asOf: (tx, ids, at) =>
      tx
        .select()
        .from(rateTerms)
        .where(and(inArray(rateTerms.instrumentId, [...ids]), asOf(rateTerms, at))),
    history: (tx, id) =>
      tx
        .select()
        .from(rateTerms)
        .where(eq(rateTerms.instrumentId, id))
        .orderBy(rateTerms.txFrom, rateTerms.validFrom),
  },
};

/** The full row of the table behind `K`, exactly as the drizzle mirror selects it. */
export type TermsRow<K extends TermsKind> = (typeof TERMS_TABLES)[K]['$inferSelect'];

export type GovtTermsRow = TermsRow<'govt'>;
export type OptionTermsRow = TermsRow<'option'>;
export type FutureTermsRow = TermsRow<'future'>;
export type FundTermsRow = TermsRow<'fund'>;
export type IndexTermsRow = TermsRow<'index'>;
export type FxTermsRow = TermsRow<'fx'>;
export type RateTermsRow = TermsRow<'rate'>;

/**
 * What a caller supplies: the row minus the identity (`version_id`), minus the key
 * (`instrument_id`, which travels on {@link TermsWrite}) and minus the four columns
 * `db/bitemporal.ts` owns.
 *
 * Every remaining column is **required**, including the ones with a database default. A version
 * is a complete statement of the terms at an instant, and `writeVersion` inserts exactly the
 * columns `data` carries: a partial correction would either trip a NOT NULL constraint or, worse,
 * silently re-open the key with the defaults for everything it left out. Pass
 * `{ ...previous, couponRate: '4.250000' }` to correct one field.
 */
export type TermsData<K extends TermsKind> = Omit<
  TermsRow<K>,
  BitemporalKeys | 'versionId' | 'instrumentId'
>;

/** One version write against one instrument's terms. */
export interface TermsWrite<K extends TermsKind> {
  instrumentId: number;
  data: TermsData<K>;
  /** When the terms became true in the world. */
  validFrom: Date;
  /** Omitted → `'infinity'`. */
  validTo?: Date;
  provenanceId: number;
  reason: 'initial' | 'change' | 'correction';
  /**
   * knownAt — required whenever the knowledge instant is historical (a Treasury auction
   * announcement, a filing's `acceptanceDateTime`). Omitted → `clock_timestamp()`.
   */
  txFrom?: Date;
}

/**
 * The discriminated result of {@link TermsRepository.forInstrument}: the tag says which of the
 * seven tables answered, and `terms` is that table's row type.
 */
export type InstrumentTerms = {
  [K in TermsKind]: { kind: K; instrumentId: number; terms: TermsRow<K> };
}[TermsKind];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// asset_class → terms table
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The one mapping from `instruments.asset_class` (CONTRACTS §1.1) to the terms table that
 * describes it. `null` means the asset class carries no contractual terms:
 *
 *  - `equity` — described by `issues` / `issuers` / `listings`;
 *  - `crypto` — a quoted pair with no contract behind it (context only, BRIEF §1 non-goal);
 *  - `econ` — described by `econ_series`, not by terms.
 *
 * `etf` maps to `fund_terms` and `rate` to `rate_terms`: the two pairs whose names do not match.
 */
export const TERMS_KIND_BY_ASSET_CLASS: Readonly<Record<AssetClass, TermsKind | null>> =
  Object.freeze({
    equity: null,
    etf: 'fund',
    index: 'index',
    fx: 'fx',
    govt: 'govt',
    option: 'option',
    future: 'future',
    crypto: null,
    rate: 'rate',
    econ: null,
  });

/** The terms table for an asset class, or `null` when it has none. */
export function termsKindForAssetClass(assetClass: AssetClass): TermsKind | null {
  return TERMS_KIND_BY_ASSET_CLASS[assetClass];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Repository
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Reads and writes over the seven terms tables, bound to one transaction.
 *
 * Bound rather than passed-per-call because every caller in `data/*` and `ingest/*` already runs
 * inside `withTx`, and an accidental second connection is exactly what makes an integration test
 * see half its own writes.
 */
export class TermsRepository {
  constructor(private readonly tx: Tx) {}

  // ── Writes ────────────────────────────────────────────────────────────────────────────────

  /**
   * Write a new version. Closes any current version of the same instrument whose valid range
   * overlaps and re-opens the parts that stick out (DATA_MODEL §1.3).
   *
   * @returns the new `version_id`.
   * @throws the `pg` error unwrapped — `23P01` when a current version of this instrument already
   *         covers part of `[validFrom, validTo)` in a way the writer cannot close.
   */
  async write<K extends TermsKind>(kind: K, w: TermsWrite<K>): Promise<number> {
    return writeVersion<Record<string, unknown>>(this.tx, BT[kind], versionWrite(w));
  }

  /**
   * `write`, except that identical current terms write nothing and return `null`. This is what
   * makes a terms refresh (the symbology job, `db:seed`) idempotent: re-running it does not grow
   * the table by one version per instrument per run.
   */
  async upsert<K extends TermsKind>(kind: K, w: TermsWrite<K>): Promise<number | null> {
    return upsertVersion<Record<string, unknown>>(this.tx, BT[kind], versionWrite(w));
  }

  // ── Reads ─────────────────────────────────────────────────────────────────────────────────

  /** The version of `kind` terms valid at `at.validAt` as known at `at.knownAt`, or `null`. */
  async read<K extends TermsKind>(
    kind: K,
    instrumentId: number,
    at: AsOf,
  ): Promise<TermsRow<K> | null> {
    const rows = await this.readMany(kind, [instrumentId], at);
    return rows.get(instrumentId) ?? null;
  }

  /**
   * The same read for many instruments in one round trip, keyed by `instrument_id`. A grid of
   * 500 option rows is one query, not 500 — the chain and membership screens are built on this.
   *
   * At most one row per instrument can satisfy `bt_as_of` for a given `(validAt, knownAt)`: the
   * `<table>_bt_excl` constraint forbids two *current* versions with overlapping valid ranges,
   * and the transaction-time filter keeps exactly one belief line. A duplicate would be a
   * corrupted table, so the last row wins rather than being silently merged.
   */
  async readMany<K extends TermsKind>(
    kind: K,
    instrumentIds: readonly number[],
    at: AsOf,
  ): Promise<Map<number, TermsRow<K>>> {
    const out = new Map<number, TermsRow<K>>();
    if (instrumentIds.length === 0) return out;
    const rows = await READERS[kind].asOf(this.tx, [...new Set(instrumentIds)], at);
    for (const row of rows) out.set(row.instrumentId, row);
    return out;
  }

  /**
   * The discriminated read: pick the table from `assetClass`, return the row under its tag.
   * `null` when the asset class has no terms table, or when it has one and this instrument has
   * no version at `(validAt, knownAt)` — the two cases are deliberately the same answer, because
   * "there are no terms to show" is what every caller does with them.
   */
  async forInstrument(
    instrumentId: number,
    assetClass: AssetClass,
    at: AsOf,
  ): Promise<InstrumentTerms | null> {
    const kind = termsKindForAssetClass(assetClass);
    if (kind === null) return null;
    const terms = await this.read(kind, instrumentId, at);
    if (terms === null) return null;
    // `kind` and `terms` were produced by the same `K`, which is what makes the union member
    // well formed; TypeScript cannot see that through the distributive mapped type above.
    return { kind, instrumentId, terms } as InstrumentTerms;
  }

  /**
   * `forInstrument` for a whole list, grouped so that each terms table is queried once. The
   * result is keyed by `instrument_id`, and an instrument whose asset class has no terms table,
   * or which has no version at `(validAt, knownAt)`, is simply absent.
   */
  async forInstruments(
    instruments: readonly { instrumentId: number; assetClass: AssetClass }[],
    at: AsOf,
  ): Promise<Map<number, InstrumentTerms>> {
    const byKind = new Map<TermsKind, number[]>();
    for (const { instrumentId, assetClass } of instruments) {
      const kind = termsKindForAssetClass(assetClass);
      if (kind === null) continue;
      const bucket = byKind.get(kind);
      if (bucket === undefined) byKind.set(kind, [instrumentId]);
      else bucket.push(instrumentId);
    }

    const out = new Map<number, InstrumentTerms>();
    for (const [kind, ids] of byKind) {
      for (const [instrumentId, terms] of await this.readMany(kind, ids, at)) {
        out.set(instrumentId, { kind, instrumentId, terms } as InstrumentTerms);
      }
    }
    return out;
  }

  /**
   * Every version ever written for one instrument, newest belief first — the audit read behind
   * `Ctrl+I` and the correction tests. Includes closed versions (`tx_to <> 'infinity'`), which
   * is the point: it answers "what did we think, and when did we stop thinking it?".
   */
  async history<K extends TermsKind>(
    kind: K,
    instrumentId: number,
  ): Promise<readonly TermsRow<K>[]> {
    return READERS[kind].history(this.tx, instrumentId);
  }
}

/**
 * `TermsWrite` → the `VersionWrite` shape `db/bitemporal.ts` takes.
 *
 * Typed at `Record<string, unknown>` because the writer is driven by the table's own columns
 * (`getTableColumns`) rather than by the row type: the seven tables share one key column and one
 * code path, and a per-table `VersionWrite<GovtTermsRow>` would buy nothing the `TermsWrite<K>`
 * signature has not already checked at the call site.
 */
function versionWrite<K extends TermsKind>(w: TermsWrite<K>): VersionWrite<Record<string, unknown>> {
  // `validTo` and `txFrom` are spread conditionally rather than passed as `undefined`:
  // `exactOptionalPropertyTypes` distinguishes "absent" (→ 'infinity' / clock_timestamp()) from
  // an explicit `undefined`, and `writeVersion` branches on `=== undefined` either way.
  return {
    entityKey: { instrumentId: w.instrumentId },
    validFrom: w.validFrom,
    ...(w.validTo === undefined ? {} : { validTo: w.validTo }),
    data: { ...w.data, instrumentId: w.instrumentId },
    provenanceId: w.provenanceId,
    reason: w.reason,
    ...(w.txFrom === undefined ? {} : { txFrom: w.txFrom }),
  };
}
