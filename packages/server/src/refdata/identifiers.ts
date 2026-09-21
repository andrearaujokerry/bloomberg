/**
 * The `identifiers` cross-reference — WORKPLAN §WP-04 L697-700 and L740-753, DATA_MODEL §3
 * (migration 0003 L152-172), REF-01.
 *
 * One table answers "what is this string?" for every scheme in `id_scheme`, and its key is
 * exactly what `identifiers_bt_excl` constrains:
 *
 * ```sql
 * EXCLUDE USING gist (scheme WITH =, value WITH =, qualifier WITH =,
 *                     tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
 * ```
 *
 * — `(scheme, value, qualifier)` maps to **at most one entity at any valid instant**, as currently
 * believed. Across time it may map to different entities: a ticker really is reused, which is why
 * a ticker is never an identity (REF-01) and why every read here takes an `AsOf`.
 *
 * ## The qualifier is part of the key, not decoration
 *
 * DATA_MODEL L527 fixes its meaning per scheme, and this module enforces it because the constraint
 * cannot:
 *
 * | scheme | qualifier | why |
 * | --- | --- | --- |
 * | `TICKER_EXCH` | the exchange code — `'US'` (composite), `'UW'` (venue) | `AAPL` is only an identifier *at a venue*; `AAPL/US` and `AAPL/UW` are two different facts, and `AAPL` on its own is ambiguous by construction |
 * | `PROVIDER_SYMBOL`, `SERIES_CODE` | the `source_id` — `'cboe.quotes'`, `'fred.series'` | two providers reuse each other's symbols freely (`SPX`, `^GSPC`, `bitcoin`), so the source is what makes the symbol unique |
 * | everything else | `''` | a CUSIP, an ISIN, a FIGI, an LEI, a CIK or a MIC is globally unique on its own |
 *
 * A qualifier on a globally-unique scheme is therefore **rejected**, not stored: writing
 * `('CUSIP','037833100','openfigi')` and `('CUSIP','037833100','sec')` would be two different keys
 * and the exclusion constraint would happily let both point at different entities — the uniqueness
 * this table exists for, gone, silently.
 *
 * ## Placeholders are absent, not values (WORKPLAN L740-753)
 *
 * The recorded `sec-nport-SPY-primary_doc.xml` holds 504 positions with only 476 distinct CUSIPs:
 * 29 foreign-domiciled names carry `<cusip>000000000</cusip>` and are identified only by their
 * ISIN. Writing that string as a CUSIP maps 29 companies onto one entity, and the second write
 * raises SQLSTATE 23P01 and aborts the job. **The codec cannot save you here**: the CUSIP check
 * digit of `00000000` is `0`, so `000000000` is a perfectly well-formed CUSIP and
 * `isValidCusip('000000000')` is `true`. It is rejected because it is a *placeholder*, which is a
 * separate judgement from well-formedness: {@link normaliseIdentifier} refuses it with
 * `reason: 'placeholder'`, and
 * {@link IdentifierRepository.upsertIfValid} reports that instead of writing. Every value is
 * validated and canonicalised through `@terminal/core`'s codecs first — a CUSIP with a broken
 * check digit is a transcription error, and storing it would make it findable.
 *
 * Writes go through `db/bitemporal.ts` and nothing else.
 */

import { and, asc, eq } from 'drizzle-orm';

import { padCik, toCboeForm, toCusip, toFigi, toIsin, toSedol } from '@terminal/core';

import { asOf, bitemporal, retireVersion, upsertVersion, writeVersion } from '../db/bitemporal.js';
import { identifiers } from '../db/schema/index.js';

import type { Bitemporal, IdScheme } from '@terminal/core';
import type { SQL } from 'drizzle-orm';
import type { AsOf, VersionWrite } from '../db/bitemporal.js';
// Type-only: `entityKindEnum` is read for its `enumValues` tuple, never called.
import type { entityKindEnum } from '../db/schema/enums.js';
import type { Tx } from '../db/client.js';
import type { WriteOptions } from './master.js';

/** The table, tagged with its three `identifiers_bt_excl` key columns. */
export const btIdentifiers = bitemporal(identifiers, 'scheme', 'value', 'qualifier');

type IdentifierRow = typeof identifiers.$inferSelect;

/** `entity_kind` — taken from the enum mirror so the two can never drift. */
export type EntityKind = (typeof entityKindEnum.enumValues)[number];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The three columns of `identifiers_bt_excl`, canonicalised. */
export interface IdentifierKey {
  scheme: IdScheme;
  value: string;
  /** Never `undefined`: the column is `NOT NULL DEFAULT ''` and `''` is a real key part. */
  qualifier: string;
}

export interface IdentifierRecord extends Bitemporal, IdentifierKey {
  entityKind: EntityKind;
  entityId: number;
  isPrimary: boolean;
}

export interface IdentifierInput {
  entityKind: EntityKind;
  entityId: number;
  scheme: IdScheme;
  value: string;
  /** Required for `TICKER_EXCH` (exchange code) and `PROVIDER_SYMBOL`/`SERIES_CODE` (source id). */
  qualifier?: string;
  /** The preferred identifier of this scheme for the entity (the primary ticker, say). */
  isPrimary?: boolean;
}

/** Why a value was refused. Ingest jobs record the first two as `data_exceptions` rows. */
export type IdentifierRejection =
  /** All-zero, blank, or a textual "not applicable" — the value is absent, not wrong. */
  | 'placeholder'
  /** Fails its codec: a bad check digit, a wrong length, characters the scheme forbids. */
  | 'malformed'
  /** `TICKER_EXCH` without an exchange code, `PROVIDER_SYMBOL`/`SERIES_CODE` without a source. */
  | 'missing_qualifier'
  /** A qualifier on a globally-unique scheme, which would split the uniqueness key. */
  | 'unexpected_qualifier';

export type IdentifierCheck =
  { ok: true; key: IdentifierKey } | { ok: false; reason: IdentifierRejection; detail: string };

/** Thrown by the strict write path; `upsertIfValid` returns the rejection instead. */
export class IdentifierValueError extends Error {
  readonly code = 'IDENTIFIER_REJECTED' as const;
  readonly reason: IdentifierRejection;
  readonly scheme: IdScheme;
  readonly value: string;
  readonly qualifier: string;

  constructor(
    scheme: IdScheme,
    value: string,
    qualifier: string,
    check: IdentifierCheck & { ok: false },
  ) {
    super(
      `${scheme} ${JSON.stringify(value)} (qualifier ${JSON.stringify(qualifier)}): ${check.detail}`,
    );
    this.name = 'IdentifierValueError';
    this.reason = check.reason;
    this.scheme = scheme;
    this.value = value;
    this.qualifier = qualifier;
  }
}

/** The outcome of an idempotent write. `versionId === null` means the row already said this. */
export type IdentifierWrite =
  | { ok: true; key: IdentifierKey; versionId: number | null }
  | { ok: false; reason: IdentifierRejection; detail: string };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Schemes whose qualifier carries the exchange code. */
const EXCHANGE_QUALIFIED: ReadonlySet<IdScheme> = new Set<IdScheme>(['TICKER_EXCH']);

/** Schemes whose qualifier carries the `licence_registry.source_id`. */
const SOURCE_QUALIFIED: ReadonlySet<IdScheme> = new Set<IdScheme>([
  'PROVIDER_SYMBOL',
  'SERIES_CODE',
]);

/** Schemes whose value is a free-form provider string and keeps the provider's own casing. */
const CASE_SENSITIVE: ReadonlySet<IdScheme> = new Set<IdScheme>(['PROVIDER_SYMBOL', 'SERIES_CODE']);

/** OpenFIGI composite codes, Cboe venue codes and the synthetic ones ('GOVT','INDEX','CRYPTO'). */
const EXCH_CODE = /^[A-Z0-9]{1,8}$/;

/** `licence_registry.source_id`: 'cboe.quotes', 'cboe.euIndices', 'sec.submissions', 'wiki.sp500'. */
const SOURCE_ID = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/;

/** A provider symbol or ticker: no whitespace, printable, bounded. `^GSPC`, `EURUSD=X`, `_SPX`. */
const SYMBOLIC = /^[^\s]{1,64}$/;

/** 20 characters, ISO 17442. */
const LEI_SHAPE = /^[A-Z0-9]{20}$/;

const MIC_SHAPE = /^[A-Z0-9]{4}$/;

/** A RIC: 'AAPL.OQ', '.SPX', 'EUR=' — bounded and whitespace-free, no check digit exists. */
const RIC_SHAPE = /^[A-Z0-9.=^_-]{1,32}$/;

/**
 * Blank, or nothing but zeros and filler. `'000000000'` (the N-PORT CUSIP placeholder), `''`,
 * `'-'`, `'0'`, `'   '` — none of them identify anything.
 */
const BLANK_OR_ZERO = /^[0\s\-_.*#]*$/;

/**
 * Textual "no value". Deliberately **not** applied to ticker-like schemes: `NA` is National Bank
 * of Canada on the TSX and `NIL` is a real symbol somewhere; on a CUSIP or an ISIN the codec would
 * reject them anyway, so this only ever fires where the intent is unambiguous.
 */
const TEXT_SENTINEL = /^(?:n\/?a|none|null|nil|unknown|undefined|not\s*available)$/i;

/**
 * True when `value` is a filler standing in for a missing identifier rather than an identifier.
 *
 * The 29 `<cusip>000000000</cusip>` holdings of the SPY N-PORT filing are the case this exists
 * for (WORKPLAN L740-753).
 */
export function isPlaceholderIdentifier(scheme: IdScheme, value: string): boolean {
  const trimmed = value.trim();
  if (BLANK_OR_ZERO.test(trimmed)) return true;
  if (CASE_SENSITIVE.has(scheme) || scheme === 'TICKER_EXCH' || scheme === 'RIC') return false;
  return TEXT_SENTINEL.test(trimmed);
}

/**
 * ISO 17442 check: the twenty characters, read as base-36 digits, are ≡ 1 (mod 97).
 *
 * `@terminal/core` has codecs for FIGI, ISIN, CUSIP, SEDOL, CIK and OCC but not for LEI, and one
 * belongs there rather than here the moment a second caller needs it (§18). Until then this is
 * the only place an LEI is checked, and an unchecked LEI is how `identifiers` acquires a typo it
 * can never resolve.
 */
export function isValidLei(raw: string): boolean {
  const lei = raw.trim().toUpperCase();
  if (!LEI_SHAPE.test(lei)) return false;
  let remainder = 0;
  for (const ch of lei) {
    const digits = ch >= '0' && ch <= '9' ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** The canonical spelling of a value for its scheme, or `null` when it is not one. */
function canonicalValue(scheme: IdScheme, raw: string): string | null {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();
  switch (scheme) {
    case 'FIGI':
    case 'COMPOSITE_FIGI':
    case 'SHARE_CLASS_FIGI':
      return toFigi(trimmed);
    case 'ISIN':
      return toIsin(trimmed);
    case 'CUSIP':
      return toCusip(trimmed);
    case 'SEDOL':
      return toSedol(trimmed);
    case 'CIK':
      return padCik(trimmed);
    case 'OCC': {
      // Stored in the Cboe form Cboe publishes and `instruments.ticker` carries
      // ('AAPL260916C00245000'); `toCboeForm` accepts either form and normalises.
      const occ = toCboeForm(upper);
      return occ.ok ? occ.value : null;
    }
    case 'LEI':
      return isValidLei(upper) ? upper : null;
    case 'MIC':
      return MIC_SHAPE.test(upper) ? upper : null;
    case 'RIC':
      return RIC_SHAPE.test(upper) ? upper : null;
    case 'TICKER_EXCH':
      return SYMBOLIC.test(upper) ? upper : null;
    case 'PROVIDER_SYMBOL':
    case 'SERIES_CODE':
      // Provider symbols are case-bearing: coingecko says 'bitcoin', Yahoo says '^GSPC'.
      return SYMBOLIC.test(trimmed) ? trimmed : null;
  }
}

/** The canonical qualifier for a scheme, or a rejection. */
function canonicalQualifier(
  scheme: IdScheme,
  raw: string | undefined,
): { ok: true; qualifier: string } | { ok: false; reason: IdentifierRejection; detail: string } {
  const trimmed = (raw ?? '').trim();
  if (EXCHANGE_QUALIFIED.has(scheme)) {
    const code = trimmed.toUpperCase();
    if (code === '') {
      return {
        ok: false,
        reason: 'missing_qualifier',
        detail: `${scheme} requires the exchange code as its qualifier (DATA_MODEL L527)`,
      };
    }
    if (!EXCH_CODE.test(code)) {
      return {
        ok: false,
        reason: 'malformed',
        detail: `${JSON.stringify(code)} is not an exchange code`,
      };
    }
    return { ok: true, qualifier: code };
  }
  if (SOURCE_QUALIFIED.has(scheme)) {
    if (trimmed === '') {
      return {
        ok: false,
        reason: 'missing_qualifier',
        detail: `${scheme} requires the source_id as its qualifier (DATA_MODEL L527)`,
      };
    }
    if (!SOURCE_ID.test(trimmed)) {
      return {
        ok: false,
        reason: 'malformed',
        detail: `${JSON.stringify(trimmed)} is not a licence_registry.source_id`,
      };
    }
    return { ok: true, qualifier: trimmed };
  }
  if (trimmed !== '') {
    return {
      ok: false,
      reason: 'unexpected_qualifier',
      detail:
        `${scheme} is globally unique and its qualifier must be '' — ` +
        `${JSON.stringify(trimmed)} would create a second key for the same value`,
    };
  }
  return { ok: true, qualifier: '' };
}

/**
 * Validate and canonicalise `(scheme, value, qualifier)` into the key the exclusion constraint
 * uses. Pure, never throws, and the single gate every write on this module passes through.
 */
export function normaliseIdentifier(
  scheme: IdScheme,
  value: string,
  qualifier?: string,
): IdentifierCheck {
  if (isPlaceholderIdentifier(scheme, value)) {
    return {
      ok: false,
      reason: 'placeholder',
      detail: `${JSON.stringify(value)} is a placeholder, not a ${scheme}`,
    };
  }
  const canonical = canonicalValue(scheme, value);
  if (canonical === null) {
    return {
      ok: false,
      reason: 'malformed',
      detail: `${JSON.stringify(value.trim())} is not a valid ${scheme}`,
    };
  }
  const q = canonicalQualifier(scheme, qualifier);
  if (!q.ok) return { ok: false, reason: q.reason, detail: q.detail };
  return { ok: true, key: { scheme, value: canonical, qualifier: q.qualifier } };
}

/**
 * The spelling to *look for*, which is laxer than the spelling to write: a search for a CUSIP with
 * a broken check digit must return nothing rather than throw, and a lookup must still find rows
 * written before a codec was tightened. Falls back to the trimmed (and, where the scheme is
 * case-insensitive, upper-cased) input.
 */
function lookupValue(scheme: IdScheme, raw: string): string {
  return (
    canonicalValue(scheme, raw) ??
    (CASE_SENSITIVE.has(scheme) ? raw.trim() : raw.trim().toUpperCase())
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Mapping
// ─────────────────────────────────────────────────────────────────────────────────────────────

function toRecord(row: IdentifierRow): IdentifierRecord {
  return {
    versionId: row.versionId,
    validFrom: row.validFrom,
    validTo: row.validTo,
    txFrom: row.txFrom,
    txTo: row.txTo,
    provenanceId: row.provenanceId,
    entityKind: row.entityKind,
    entityId: row.entityId,
    scheme: row.scheme,
    value: row.value,
    qualifier: row.qualifier,
    isPrimary: row.isPrimary,
  };
}

function versionWrite(
  input: IdentifierInput,
  key: IdentifierKey,
  o: WriteOptions,
  fallbackReason: VersionWrite<IdentifierRow>['reason'],
): VersionWrite<IdentifierRow> {
  const w: VersionWrite<IdentifierRow> = {
    entityKey: { scheme: key.scheme, value: key.value, qualifier: key.qualifier },
    validFrom: o.validFrom,
    data: {
      entityKind: input.entityKind,
      entityId: input.entityId,
      scheme: key.scheme,
      value: key.value,
      qualifier: key.qualifier,
      isPrimary: input.isPrimary ?? false,
    },
    provenanceId: o.provenanceId,
    reason: o.reason ?? fallbackReason,
  };
  if (o.validTo !== undefined) w.validTo = o.validTo;
  if (o.knownAt !== undefined) w.txFrom = o.knownAt;
  return w;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Repository
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `identifiers` cross-reference, bound to one transaction.
 *
 * Two write paths, deliberately:
 *
 *  * {@link upsert} throws on a value that is not an identifier. Use it where the value came from
 *    our own code or a schema-checked field and a bad one is a bug.
 *  * {@link upsertIfValid} returns the rejection. Use it in an ingest job walking a provider file,
 *    where a placeholder CUSIP is expected and the row belongs in `data_exceptions`, not in a
 *    stack trace.
 *
 * Both are idempotent: re-running a job writes nothing when the database already says this
 * (`versionId === null`), which is what QA-02's "a second run writes nothing" measures.
 */
export class IdentifierRepository {
  constructor(private readonly tx: Tx) {}

  /**
   * Idempotent write; `null` when the current version already says exactly this.
   *
   * @throws {IdentifierValueError} when the value is a placeholder or fails its codec.
   */
  async upsert(input: IdentifierInput, o: WriteOptions): Promise<number | null> {
    const check = normaliseIdentifier(input.scheme, input.value, input.qualifier);
    if (!check.ok) {
      throw new IdentifierValueError(input.scheme, input.value, input.qualifier ?? '', check);
    }
    return upsertVersion(this.tx, btIdentifiers, versionWrite(input, check.key, o, 'change'));
  }

  /** {@link upsert} without the throw: a rejected value is an outcome, not an exception. */
  async upsertIfValid(input: IdentifierInput, o: WriteOptions): Promise<IdentifierWrite> {
    const check = normaliseIdentifier(input.scheme, input.value, input.qualifier);
    if (!check.ok) return { ok: false, reason: check.reason, detail: check.detail };
    const versionId = await upsertVersion(
      this.tx,
      btIdentifiers,
      versionWrite(input, check.key, o, 'change'),
    );
    return { ok: true, key: check.key, versionId };
  }

  /**
   * Unconditional new version: re-point an identifier at another entity, or correct one.
   *
   * The previous current version of the same key is closed on the transaction-time axis and the
   * part of its valid range that lies outside the new one is re-inserted, so `AAPL/US` may belong
   * to one instrument until 2015 and another from 2015 without either read ever seeing both.
   *
   * @throws {IdentifierValueError} when the value is a placeholder or fails its codec.
   */
  async write(input: IdentifierInput, o: WriteOptions): Promise<number> {
    const check = normaliseIdentifier(input.scheme, input.value, input.qualifier);
    if (!check.ok) {
      throw new IdentifierValueError(input.scheme, input.value, input.qualifier ?? '', check);
    }
    return writeVersion(this.tx, btIdentifiers, versionWrite(input, check.key, o, 'change'));
  }

  /**
   * **Stop** an identifier: narrow its current version to `valid_to = validTo` and re-open
   * nothing after it. A ticker that was reassigned, a CUSIP that stopped being published, an
   * index member's `SERIES_CODE` that was withdrawn.
   *
   * Not `upsert({ …, validTo })`: an explicit `validTo` on a *write* asserts the identifier over
   * a window and re-inserts whatever lay beyond it (`db/bitemporal.ts#writeVersion`), so the
   * identifier would go on resolving after the date. Retirement is the operation that ends it —
   * and, like every write here, it leaves earlier `knownAt` reads exactly as they were.
   *
   * @returns the number of versions narrowed; `0` when nothing was open past `validTo`, which is
   *          what makes re-running a retiring job a no-op.
   * @throws {IdentifierValueError} when the value is not an identifier of that scheme.
   */
  async retire(
    key: { scheme: IdScheme; value: string; qualifier?: string },
    o: { validTo: Date; knownAt?: Date },
  ): Promise<number> {
    const check = normaliseIdentifier(key.scheme, key.value, key.qualifier);
    if (!check.ok) {
      throw new IdentifierValueError(key.scheme, key.value, key.qualifier ?? '', check);
    }
    return retireVersion(this.tx, btIdentifiers, {
      entityKey: {
        scheme: check.key.scheme,
        value: check.key.value,
        qualifier: check.key.qualifier,
      },
      validTo: o.validTo,
      ...(o.knownAt === undefined ? {} : { txFrom: o.knownAt }),
    });
  }

  /**
   * Every row for `(scheme, value)` at `(validAt, knownAt)`.
   *
   * With a `qualifier` this is the full key and returns at most one row — that is exactly what
   * `identifiers_bt_excl` guarantees. Without one it returns every qualifier, which for
   * `TICKER_EXCH` is the ambiguity `refdata/resolve.ts` must report rather than guess (REF-01).
   */
  lookup(
    scheme: IdScheme,
    value: string,
    at: AsOf,
    qualifier?: string,
  ): Promise<IdentifierRecord[]> {
    const parts: (SQL | undefined)[] = [
      eq(identifiers.scheme, scheme),
      eq(identifiers.value, lookupValue(scheme, value)),
    ];
    if (qualifier !== undefined) {
      const q = canonicalQualifier(scheme, qualifier);
      parts.push(eq(identifiers.qualifier, q.ok ? q.qualifier : qualifier.trim()));
    }
    return this.select(and(...parts), at);
  }

  /**
   * The one entity a full key points at, or `null`.
   *
   * @throws when more than one row comes back, which the exclusion constraint makes impossible
   *         for a *current* read and would mean a corrupted transaction-time slice otherwise.
   */
  async entityOf(
    key: { scheme: IdScheme; value: string; qualifier?: string },
    at: AsOf,
  ): Promise<{ entityKind: EntityKind; entityId: number } | null> {
    const rows = await this.lookup(key.scheme, key.value, at, key.qualifier ?? '');
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw new Error(
        `identifiers: ${key.scheme} ${key.value} resolves to ${String(rows.length)} entities at ` +
          `${at.validAt.toISOString()} / ${at.knownAt.toISOString()} — identifiers_bt_excl is violated`,
      );
    }
    const row = rows[0];
    if (row === undefined) return null;
    return { entityKind: row.entityKind, entityId: row.entityId };
  }

  /** Every identifier of one entity — what DES prints and what the exporter attributes. */
  forEntity(entityKind: EntityKind, entityId: number, at: AsOf): Promise<IdentifierRecord[]> {
    return this.select(
      and(eq(identifiers.entityKind, entityKind), eq(identifiers.entityId, entityId)),
      at,
    );
  }

  /** The entity's preferred identifier of one scheme, if one is flagged primary. */
  async primaryOf(
    entityKind: EntityKind,
    entityId: number,
    scheme: IdScheme,
    at: AsOf,
  ): Promise<IdentifierRecord | null> {
    const rows = await this.select(
      and(
        eq(identifiers.entityKind, entityKind),
        eq(identifiers.entityId, entityId),
        eq(identifiers.scheme, scheme),
        eq(identifiers.isPrimary, true),
      ),
      at,
    );
    return rows[0] ?? null;
  }

  private async select(where: SQL | undefined, at: AsOf): Promise<IdentifierRecord[]> {
    const rows = await this.tx
      .select()
      .from(identifiers)
      .where(and(where, asOf(btIdentifiers, at)))
      .orderBy(asc(identifiers.scheme), asc(identifiers.value), asc(identifiers.qualifier));
    return rows.map(toRecord);
  }
}

/** Convenience: `identifierRepository(tx).lookup('CUSIP', '037833100', at)`. */
export function identifierRepository(tx: Tx): IdentifierRepository {
  return new IdentifierRepository(tx);
}

/**
 * The SQLSTATE `identifiers_bt_excl` raises when two entities would hold one identifier over
 * overlapping valid time. Exported so an ingest job can tell that collision apart from any other
 * failure and record a `data_exceptions` row instead of dying (WORKPLAN L744).
 */
export const IDENTIFIER_CONFLICT_SQLSTATE = '23P01';

/** True when `err` is that collision, however deeply the driver wrapped it. */
export function isIdentifierConflict(err: unknown): boolean {
  let e = err as { code?: unknown; constraint?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; e !== null && e !== undefined && depth < 8; depth += 1) {
    if (e.code === IDENTIFIER_CONFLICT_SQLSTATE && e.constraint === 'identifiers_bt_excl') {
      return true;
    }
    e = e.cause as { code?: unknown; constraint?: unknown; cause?: unknown } | undefined;
  }
  return false;
}
