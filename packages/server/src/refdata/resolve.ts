/**
 * `SecurityResolver` — `SecurityRef | identifier | instrumentId` → `ResolvedRef`, as of
 * `(validAt, knownAt)`. ARCHITECTURE L264, WORKPLAN §WP-04 L691-693, REF-01 / REF-02 / REF-03.
 *
 * Three steps, in this order, and the first step that produces candidates decides the outcome —
 * with one exception, noted in step 2: for a **ticker**, steps 1 and 2 are unioned rather than
 * short-circuited, because only step 1 is protected by a uniqueness constraint.
 *
 *  1. **`identifiers`** — the cross-reference. `/isin/…`, `/cusip/…`, `/figi/…`, `/occ/…`,
 *     `/series/…` and a ticker (as `TICKER_EXCH`, qualifier = exch code) are all looked up here
 *     first, because this is the only table that is keyed on the identifier itself. A bare token
 *     that *also* satisfies an identifier's check digit (`912797VE4 Govt` is a valid CUSIP as well
 *     as a Treasury's ticker) is probed under both schemes in this one step, so the two spellings
 *     of the same security converge instead of racing.
 *  2. **`instruments.ticker` + `exch_code`** — the composite row itself, for securities whose
 *     ticker was never written to `identifiers` (index and rate instruments, anything a partial
 *     ingest has only half-populated). This step runs for a ticker ref **even when step 1 found
 *     something**, and the two candidate sets are unioned: `identifiers_bt_excl` guarantees at
 *     most one instrument holds `(TICKER_EXCH, value, exch)`, so step 1 alone cannot see a second
 *     instrument carrying that `(ticker, exch_code)` in `instruments`, where no such constraint
 *     exists. Returning step 1's owner and staying silent about the other was a guess (REF-02).
 *     The cost is one indexed SELECT on the ticker path; other ref forms do not pay it.
 *  3. **the `normName` fallback** — `core/text/normName.ts` over `instruments.name` and then
 *     `issuers.name`, exact equality on the normalised form only. `"Apple Inc."`, `"APPLE INC"`
 *     and `"apple inc"` all normalise to `APPLE`; nothing fuzzier than that is accepted here,
 *     because a near-miss would be a guess.
 *
 * **A ticker is never the key** (REF-01). `AAPL` is a lookup *token* whose answer is a function of
 * `(validAt, knownAt)`: the same ticker resolves to different instruments at different points on
 * either axis, and the only durable handle is `instrumentId`. Every read here goes through
 * `db/bitemporal.ts#asOf`, so a past-dated read can never return something we did not know then.
 *
 * **Ambiguity is never resolved by guessing** (REF-02). When a step yields more than one
 * instrument the result is `{ ok: false, code: 'AMBIGUOUS_SECURITY', candidates }` — the API's
 * `409 AMBIGUOUS_SECURITY` with `details.candidates` (API.md L154, L416-420) and the command
 * line's `AMBIGUOUS` problem. The only narrowing applied is what the *caller* wrote: a sector
 * (`SPX Index`) and an exchange code (`AAPL UW Equity`) are constraints the user supplied, not
 * inferences the resolver made. Ordering the candidate list by `search_weight` is presentation,
 * not selection: the caller still has to choose.
 *
 * Nothing here writes. A miss that could be filled from OpenFIGI (`ResolveItem.source`,
 * API.md L421) is WP-10's read-through, not this module's.
 */

import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';

import {
  isValidCusip,
  isValidFigi,
  isValidIsin,
  isCboeOccSymbol,
  isOsiOccSymbol,
  normName,
  parseSecurityRef,
  toCboeForm,
  toOsiForm,
  type AssetClass,
  type IdScheme,
  type InstrumentStatus,
  type MarketSector,
  type ResolvedRef,
  type SecurityRef,
} from '@terminal/core';

import { asOf, type AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';
import {
  identifiers,
  instruments,
  issuers,
  issues,
  listings,
  mdLines,
} from '../db/schema/index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Result shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `ResolvedRef` (core/types/instrument.ts) plus the display columns every candidate list needs —
 * API.md's `InstrumentSummary` (L234-240) verbatim, plus `issueId`/`issuerId` so a caller that has
 * to disambiguate can say *why* two rows differ.
 */
export interface ResolveCandidate extends ResolvedRef {
  ticker: string;
  exchCode: string;
  /** `issues.security_type`: 'Common Stock', 'ETP', 'Index', 'US GOVERNMENT', … */
  securityType: string;
  compositeFigi: string | null;
  status: InstrumentStatus;
  priceDecimals: number;
  searchWeight: number;
  assetClass: AssetClass;
  marketSector: MarketSector;
  issueId: number;
  issuerId: number;
}

/** Which of the three steps answered. `instrument_id` is the trivial step: the key itself. */
export type ResolveMethod = 'instrument_id' | 'identifier' | 'ticker_exch' | 'name';

export interface ResolveHit {
  ok: true;
  method: ResolveMethod;
  /** Set when `method === 'identifier'`: which scheme matched. */
  scheme?: IdScheme;
  instrument: ResolveCandidate;
  /** Always empty on a hit; present so callers can destructure one shape. */
  candidates: readonly ResolveCandidate[];
}

/**
 * `SECURITY_NOT_FOUND` — nothing matched. `AMBIGUOUS_SECURITY` — more than one did, and the
 * resolver will not choose (REF-02). `NOT_IN_UNIVERSE` — the ref named a sector outside the
 * supported wedge. `BAD_IDENTIFIER` — the text is not a reference at all, or its check digit
 * failed; the three API-facing codes are the first three (API.md L420).
 */
export type ResolveFailureCode =
  'SECURITY_NOT_FOUND' | 'AMBIGUOUS_SECURITY' | 'NOT_IN_UNIVERSE' | 'BAD_IDENTIFIER';

export interface ResolveMiss {
  ok: false;
  code: ResolveFailureCode;
  message: string;
  /** Best matches, `search_weight` first, capped at `MAX_CANDIDATES` (API.md L419). */
  candidates: readonly ResolveCandidate[];
  /** The step that produced the candidates, when there was one. */
  method?: ResolveMethod;
}

export type ResolveResult = ResolveHit | ResolveMiss;

/** What `resolve()` accepts: the API's `SecurityRefInput` minus the formula form (CHRT-07). */
export type SecurityResolverInput = string | SecurityRef | { id: number };

/** API.md L419: `candidates` carries the best matches, never the whole table. */
export const MAX_CANDIDATES = 8;

/** How many names the step-3 prefilter may hand to `normName` for the exact decision. */
export const NAME_SCAN_LIMIT = 2000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `(scheme, value, qualifier?)` lookup against `identifiers`. */
interface IdentifierProbe {
  scheme: IdScheme;
  value: string;
  /** `undefined` = any qualifier (the caller did not say which exchange or which source). */
  qualifier?: string;
}

interface EntityRef {
  entityKind: 'issuer' | 'issue' | 'instrument' | 'listing' | 'person' | 'topic';
  entityId: number;
  scheme: IdScheme;
}

const CANDIDATE_COLUMNS = {
  instrumentId: instruments.instrumentId,
  issueId: instruments.issueId,
  issuerId: issues.issuerId,
  assetClass: instruments.assetClass,
  marketSector: instruments.marketSector,
  ticker: instruments.ticker,
  exchCode: instruments.exchCode,
  name: instruments.name,
  currency: instruments.currency,
  compositeFigi: instruments.compositeFigi,
  primaryListingId: instruments.primaryListingId,
  status: instruments.status,
  priceDecimals: instruments.priceDecimals,
  searchWeight: instruments.searchWeight,
  securityType: issues.securityType,
} as const;

/** `'AAPL US Equity'` — the canonical display form (core `ResolvedRef.display`). */
function displayOf(ticker: string, exchCode: string, sector: MarketSector): string {
  // Non-listed wedges carry a synthetic exch code ('GOVT', 'INDEX', 'FX', 'RATE', 'ECON') that is
  // never spoken on the command line: 'SPX Index', not 'SPX INDEX Index'.
  const spoken = SYNTHETIC_EXCH_CODES.has(exchCode) ? '' : `${exchCode} `;
  return `${ticker} ${spoken}${sector}`;
}

/** Exchange codes that stand for "not listed anywhere" (DATA_MODEL §3 `instruments.exch_code`). */
const SYNTHETIC_EXCH_CODES = new Set(['GOVT', 'FX', 'INDEX', 'RATE', 'ECON', 'CRYPTO']);

function miss(
  code: ResolveFailureCode,
  message: string,
  candidates: readonly ResolveCandidate[] = [],
  method?: ResolveMethod,
): ResolveMiss {
  return method === undefined
    ? { ok: false, code, message, candidates }
    : { ok: false, code, message, candidates, method };
}

/**
 * Two candidate lists, in the order they were produced, each instrument named once.
 *
 * Order matters: the identifiers hit comes first, so an unambiguous answer is the same object it
 * always was and `candidates[0]` in an ambiguous one is still the curated row. Identity is the
 * `instrumentId`, the only durable handle (REF-01).
 */
function unionCandidates(
  primary: readonly ResolveCandidate[],
  secondary: readonly ResolveCandidate[],
): ResolveCandidate[] {
  if (secondary.length === 0) return [...primary];
  const seen = new Set(primary.map((c) => c.instrumentId));
  const out = [...primary];
  for (const candidate of secondary) {
    if (seen.has(candidate.instrumentId)) continue;
    seen.add(candidate.instrumentId);
    out.push(candidate);
  }
  return out;
}

/**
 * The identifier probes a parsed ref implies. More than one probe per ref is normal and
 * deliberate: `/figi/…` may name a venue FIGI, a composite FIGI or a share-class FIGI, and a bare
 * Treasury token is both a ticker and a CUSIP.
 */
export function identifierProbes(ref: SecurityRef): IdentifierProbe[] {
  const value = ref.value.trim().toUpperCase();
  if (value.length === 0) return [];

  switch (ref.kind) {
    case 'isin':
      return [{ scheme: 'ISIN', value }];
    case 'cusip':
      return [{ scheme: 'CUSIP', value }];
    case 'figi':
      return [
        { scheme: 'FIGI', value },
        { scheme: 'COMPOSITE_FIGI', value },
        { scheme: 'SHARE_CLASS_FIGI', value },
      ];
    case 'occ':
      return occProbes(value);
    case 'series': {
      // '/series/fred.csv/DGS10' — `source_id` + '/' + series code; the qualifier of a
      // SERIES_CODE identifier is the source id (CONTRACTS §1.2 `identifiers.qualifier`).
      const slash = value.indexOf('/');
      if (slash <= 0) return [{ scheme: 'SERIES_CODE', value }];
      return [
        {
          scheme: 'SERIES_CODE',
          value: value.slice(slash + 1),
          qualifier: ref.value.slice(0, slash),
        },
      ];
    }
    case 'ticker': {
      const probes: IdentifierProbe[] = [
        ref.exchCode === undefined
          ? { scheme: 'TICKER_EXCH', value }
          : { scheme: 'TICKER_EXCH', value, qualifier: ref.exchCode.toUpperCase() },
      ];
      // A bare token that also satisfies a check digit: '912797VE4 Govt' is the Treasury bill's
      // ticker *and* its CUSIP, and only the CUSIP was necessarily written to `identifiers`.
      if (isValidCusip(value)) probes.push({ scheme: 'CUSIP', value });
      if (isValidIsin(value)) probes.push({ scheme: 'ISIN', value });
      if (isValidFigi(value)) {
        probes.push(
          { scheme: 'FIGI', value },
          { scheme: 'COMPOSITE_FIGI', value },
          { scheme: 'SHARE_CLASS_FIGI', value },
        );
      }
      if (isCboeOccSymbol(value) || isOsiOccSymbol(value)) probes.push(...occProbes(value));
      return probes;
    }
    default:
      return [];
  }
}

/**
 * Both spellings of an OCC symbol. Cboe publishes the root unpadded (`AAPL260916C00245000`), the
 * OSI form pads it to six (`AAPL  260916C00245000`), and either may be what an ingest wrote.
 */
function occProbes(value: string): IdentifierProbe[] {
  const forms = new Set<string>([value]);
  const cboe = toCboeForm(value);
  const osi = toOsiForm(value);
  if (cboe.ok) forms.add(cboe.value);
  if (osi.ok) forms.add(osi.value);
  return [...forms].map((v) => ({ scheme: 'OCC' as const, value: v }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export class SecurityResolver {
  constructor(private readonly tx: Tx) {}

  /**
   * Resolve one reference as of `(validAt, knownAt)`.
   *
   * @param input `{ id }` (the internal key), a `SecurityRef` already parsed by
   *        `core/ids/securityRef.ts`, or the raw command-line text, which is parsed here.
   */
  async resolve(input: SecurityResolverInput, at: AsOf): Promise<ResolveResult> {
    if (typeof input === 'object' && 'id' in input) {
      const found = await this.byInstrumentId(input.id, at);
      return found === null
        ? miss('SECURITY_NOT_FOUND', `no instrument ${input.id} as of ${at.validAt.toISOString()}`)
        : { ok: true, method: 'instrument_id', instrument: found, candidates: [] };
    }

    let ref: SecurityRef;
    if (typeof input === 'string') {
      const parsed = parseSecurityRef(input);
      if (!parsed.ok) {
        const notInUniverse = parsed.problems.some((p) => p.code === 'NOT_IN_UNIVERSE');
        const first = parsed.problems[0];
        return miss(
          notInUniverse ? 'NOT_IN_UNIVERSE' : 'BAD_IDENTIFIER',
          first?.message ?? `not a security reference: ${input}`,
        );
      }
      // A well-formed parse may still carry a fatal-for-resolution problem: a sector outside the
      // wedge, or a token shaped like an identifier whose check digit failed.
      const notInUniverse = parsed.problems.find((p) => p.code === 'NOT_IN_UNIVERSE');
      if (notInUniverse !== undefined) {
        return miss('NOT_IN_UNIVERSE', notInUniverse.message);
      }
      const badIdentifier = parsed.problems.find((p) => p.code === 'BAD_IDENTIFIER');
      if (badIdentifier !== undefined && parsed.form !== 'ticker') {
        return miss('BAD_IDENTIFIER', badIdentifier.message);
      }
      ref = parsed.ref;
    } else {
      ref = input;
    }

    return this.resolveRef(ref, at);
  }

  /** `resolve()` over a list, preserving order. One round trip per ref; no caching (WP-10 owns the LRU). */
  async resolveMany(inputs: readonly SecurityResolverInput[], at: AsOf): Promise<ResolveResult[]> {
    const out: ResolveResult[] = [];
    for (const input of inputs) out.push(await this.resolve(input, at));
    return out;
  }

  /** The internal key, read back as-of. `null` when no version of that instrument was valid then. */
  async byInstrumentId(instrumentId: number, at: AsOf): Promise<ResolveCandidate | null> {
    const rows = await this.loadCandidates([instrumentId], at);
    return rows[0] ?? null;
  }

  // ── the three steps ─────────────────────────────────────────────────────────────────────────

  private async resolveRef(ref: SecurityRef, at: AsOf): Promise<ResolveResult> {
    // Step 1 — identifiers.
    const byIdentifier = await this.byIdentifiers(ref, at);
    if (byIdentifier.candidates.length > 0) {
      // For a TICKER a hit here does NOT end the search, it only decides the method. Step 2 is
      // run as well and the candidate sets are unioned, because `identifiers_bt_excl` lets at
      // most ONE instrument hold `(TICKER_EXCH, 'GGGG', 'US')` while nothing in the schema stops
      // a second instrument from carrying ticker GGGG / exch US in `instruments` — there is no
      // uniqueness on `(ticker, exch_code)` and a half-populated universe (the seed writes
      // PROVIDER_SYMBOL for ≈36 k Cboe symbols, `symbologyRefresh` writes TICKER_EXCH only for
      // the OpenFIGI/SEC subset) is exactly the state that produces it. Short-circuiting here
      // answered a genuine ambiguity with whichever instrument happened to own the identifiers
      // row and never named the other, which REF-02 forbids. Other ref kinds (`/isin/…`,
      // `/cusip/…`) are not affected: step 2 keys on the ticker and would find nothing.
      const alsoByTicker = ref.kind === 'ticker' ? await this.byTicker(ref, at) : [];
      const union = unionCandidates(byIdentifier.candidates, alsoByTicker);
      return this.decide(union, 'identifier', ref, byIdentifier.scheme);
    }

    // Step 2 — instruments.ticker + exch_code.
    if (ref.kind === 'ticker') {
      const byTicker = await this.byTicker(ref, at);
      if (byTicker.length > 0) return this.decide(byTicker, 'ticker_exch', ref);
    }

    // Step 3 — the normName fallback.
    const byName = await this.byName(ref, at);
    if (byName.length > 0) return this.decide(byName, 'name', ref);

    return miss('SECURITY_NOT_FOUND', `nothing resolves ${describe(ref)}`);
  }

  /**
   * One query over every probe the ref implies, then entity → instrument fan-out: an `instrument`
   * identifier is the instrument, a `listing` identifier is its instrument, an `issue` identifier
   * is every instrument of that issue (AAPL US, AAPL GR, …) and an `issuer` identifier every
   * instrument the issuer issued. The last two are frequently ambiguous, which is the honest
   * answer: `/cusip/…` on a share class does not say which listing venue you meant.
   */
  private async byIdentifiers(
    ref: SecurityRef,
    at: AsOf,
  ): Promise<{ candidates: ResolveCandidate[]; scheme?: IdScheme }> {
    const probes = identifierProbes(ref);
    if (probes.length === 0) return { candidates: [] };

    const clauses: SQL[] = probes.map((p) => {
      const value = eq(identifiers.value, p.value);
      const scheme = eq(identifiers.scheme, p.scheme);
      return p.qualifier === undefined
        ? and(scheme, value)!
        : and(scheme, value, eq(identifiers.qualifier, p.qualifier))!;
    });

    const rows = await this.tx
      .select({
        entityKind: identifiers.entityKind,
        entityId: identifiers.entityId,
        scheme: identifiers.scheme,
      })
      .from(identifiers)
      .where(and(asOf(identifiers, at), or(...clauses)));

    if (rows.length === 0) return { candidates: [] };

    const ids = await this.instrumentIdsFor(rows, at);
    if (ids.length === 0) return { candidates: [] };

    const candidates = this.applyRefFilters(await this.loadCandidates(ids, at), ref);
    const schemes = new Set(rows.map((r) => r.scheme));
    const only = schemes.size === 1 ? [...schemes][0] : undefined;
    return only === undefined ? { candidates } : { candidates, scheme: only };
  }

  /** Step 2: the composite row's own `(ticker, exch_code)`, as-of. */
  private async byTicker(ref: SecurityRef, at: AsOf): Promise<ResolveCandidate[]> {
    const ticker = ref.value.trim().toUpperCase();
    if (ticker.length === 0) return [];

    const where: SQL[] = [asOf(instruments, at), sql`upper(${instruments.ticker}) = ${ticker}`];
    if (ref.exchCode !== undefined) {
      where.push(sql`upper(${instruments.exchCode}) = ${ref.exchCode.toUpperCase()}`);
    }
    if (ref.sector !== undefined) where.push(eq(instruments.marketSector, ref.sector));

    const rows = await this.tx
      .select({ instrumentId: instruments.instrumentId })
      .from(instruments)
      .where(and(...where));

    return this.applyRefFilters(
      await this.loadCandidates(
        rows.map((r) => r.instrumentId),
        at,
      ),
      ref,
    );
  }

  /**
   * Step 3: exact equality on the normalised name (`core/text/normName.ts`), instrument names
   * first and issuer names second.
   *
   * Postgres does the coarse filter — the squashed, punctuation-free form of the query has to
   * occur in the squashed name, which no exact match can escape — and `normName` in JS makes the
   * decision, so the SQL and the TypeScript can never disagree about what "the same name" means.
   *
   * The prefilter is bounded (`NAME_SCAN_LIMIT`) because a two-letter query matches thousands of
   * the ≈36 k names, and it is ordered by name length so that the bound cannot hide an exact
   * match behind longer ones: an exact match's stored name is the query plus at most a legal
   * suffix, so it is always among the shortest that contain the query.
   */
  private async byName(ref: SecurityRef, at: AsOf): Promise<ResolveCandidate[]> {
    const wanted = normName(ref.value);
    if (wanted.length < 2) return [];
    const squashed = wanted.replaceAll(' ', '');
    const pattern = `%${squashed}%`;

    const instrumentRows = await this.tx
      .select({ instrumentId: instruments.instrumentId, name: instruments.name })
      .from(instruments)
      .where(
        and(
          asOf(instruments, at),
          ref.sector === undefined ? undefined : eq(instruments.marketSector, ref.sector),
          sql`regexp_replace(upper(${instruments.name}), '[^A-Z0-9]+', '', 'g') LIKE ${pattern}`,
        ),
      )
      .orderBy(sql`length(${instruments.name})`, asc(instruments.instrumentId))
      .limit(NAME_SCAN_LIMIT);

    const matched = instrumentRows.filter((r) => normName(r.name) === wanted);
    if (matched.length > 0) {
      return this.applyRefFilters(
        await this.loadCandidates(
          matched.map((r) => r.instrumentId),
          at,
        ),
        ref,
      );
    }

    // No instrument is called that; try the issuer ("Apple Inc" → AAPL US, AAPL GR, …).
    const issuerRows = await this.tx
      .select({ issuerId: issuers.issuerId, name: issuers.name })
      .from(issuers)
      .where(
        and(
          asOf(issuers, at),
          sql`regexp_replace(upper(${issuers.name}), '[^A-Z0-9]+', '', 'g') LIKE ${pattern}`,
        ),
      )
      .orderBy(sql`length(${issuers.name})`, asc(issuers.issuerId))
      .limit(NAME_SCAN_LIMIT);

    const issuerIds = issuerRows.filter((r) => normName(r.name) === wanted).map((r) => r.issuerId);
    if (issuerIds.length === 0) return [];

    const instrumentIds = await this.instrumentIdsForIssuers(issuerIds, at);
    if (instrumentIds.length === 0) return [];
    return this.applyRefFilters(await this.loadCandidates(instrumentIds, at), ref);
  }

  // ── plumbing ────────────────────────────────────────────────────────────────────────────────

  /** One or many: a single candidate is the answer, several are candidates and never a guess. */
  private decide(
    candidates: readonly ResolveCandidate[],
    method: ResolveMethod,
    ref: SecurityRef,
    scheme?: IdScheme,
  ): ResolveResult {
    const first = candidates[0];
    if (first === undefined) {
      return miss('SECURITY_NOT_FOUND', `nothing resolves ${describe(ref)}`);
    }
    if (candidates.length === 1) {
      return scheme === undefined
        ? { ok: true, method, instrument: first, candidates: [] }
        : { ok: true, method, scheme, instrument: first, candidates: [] };
    }
    return miss(
      'AMBIGUOUS_SECURITY',
      `${describe(ref)} matches ${String(candidates.length)} instruments; ` +
        'name the exchange or use the instrument id',
      candidates.slice(0, MAX_CANDIDATES),
      method,
    );
  }

  /** The constraints the *caller* wrote. Never a preference of our own. */
  private applyRefFilters(rows: ResolveCandidate[], ref: SecurityRef): ResolveCandidate[] {
    let out = rows;
    if (ref.sector !== undefined) out = out.filter((r) => r.marketSector === ref.sector);
    if (ref.exchCode !== undefined) {
      const wanted = ref.exchCode.toUpperCase();
      out = out.filter((r) => r.exchCode.toUpperCase() === wanted);
    }
    return out;
  }

  /** `identifiers` rows → the instruments they name, as-of. */
  private async instrumentIdsFor(rows: readonly EntityRef[], at: AsOf): Promise<number[]> {
    const ids = new Set<number>();
    const listingIds: number[] = [];
    const issueIds: number[] = [];
    const issuerIds: number[] = [];

    for (const row of rows) {
      switch (row.entityKind) {
        case 'instrument':
          ids.add(row.entityId);
          break;
        case 'listing':
          listingIds.push(row.entityId);
          break;
        case 'issue':
          issueIds.push(row.entityId);
          break;
        case 'issuer':
          issuerIds.push(row.entityId);
          break;
        default:
          // 'person' and 'topic' identifiers never name a security.
          break;
      }
    }

    if (listingIds.length > 0) {
      const found = await this.tx
        .select({ instrumentId: listings.instrumentId })
        .from(listings)
        .where(and(asOf(listings, at), inArray(listings.listingId, listingIds)));
      for (const row of found) ids.add(row.instrumentId);
    }

    if (issueIds.length > 0) {
      const found = await this.tx
        .select({ instrumentId: instruments.instrumentId })
        .from(instruments)
        .where(and(asOf(instruments, at), inArray(instruments.issueId, issueIds)));
      for (const row of found) ids.add(row.instrumentId);
    }

    if (issuerIds.length > 0) {
      for (const id of await this.instrumentIdsForIssuers(issuerIds, at)) ids.add(id);
    }

    return [...ids];
  }

  private async instrumentIdsForIssuers(issuerIds: readonly number[], at: AsOf): Promise<number[]> {
    if (issuerIds.length === 0) return [];
    const rows = await this.tx
      .select({ instrumentId: instruments.instrumentId })
      .from(instruments)
      .innerJoin(issues, and(eq(issues.issueId, instruments.issueId), asOf(issues, at)))
      .where(and(asOf(instruments, at), inArray(issues.issuerId, [...issuerIds])));
    return [...new Set(rows.map((r) => r.instrumentId))];
  }

  /**
   * Instruments by internal key, as-of, with their issue, their md-line ids and their display
   * form. Ordered `search_weight` desc then `instrument_id`, which is the order a candidate list
   * is shown in (FUNCTIONS.md L947: the autocomplete prior) — presentation only.
   */
  private async loadCandidates(
    instrumentIds: readonly number[],
    at: AsOf,
  ): Promise<ResolveCandidate[]> {
    if (instrumentIds.length === 0) return [];
    const ids = [...new Set(instrumentIds)];

    const rows = await this.tx
      .select(CANDIDATE_COLUMNS)
      .from(instruments)
      .innerJoin(issues, and(eq(issues.issueId, instruments.issueId), asOf(issues, at)))
      .where(and(asOf(instruments, at), inArray(instruments.instrumentId, ids)))
      .orderBy(desc(instruments.searchWeight), asc(instruments.instrumentId));

    if (rows.length === 0) return [];

    const lineRows = await this.tx
      .select({ mdLineId: mdLines.mdLineId, instrumentId: mdLines.instrumentId })
      .from(mdLines)
      .where(
        and(
          asOf(mdLines, at),
          inArray(
            mdLines.instrumentId,
            rows.map((r) => r.instrumentId),
          ),
        ),
      )
      .orderBy(asc(mdLines.priority), asc(mdLines.mdLineId));

    const linesByInstrument = new Map<number, number[]>();
    for (const line of lineRows) {
      const list = linesByInstrument.get(line.instrumentId);
      if (list === undefined) linesByInstrument.set(line.instrumentId, [line.mdLineId]);
      else list.push(line.mdLineId);
    }

    return rows.map((row) => {
      const candidate: ResolveCandidate = {
        instrumentId: row.instrumentId,
        issueId: row.issueId,
        issuerId: row.issuerId,
        assetClass: row.assetClass,
        marketSector: row.marketSector,
        display: displayOf(row.ticker, row.exchCode, row.marketSector),
        name: row.name,
        currency: row.currency,
        ticker: row.ticker,
        exchCode: row.exchCode,
        securityType: row.securityType,
        compositeFigi: row.compositeFigi,
        status: row.status as InstrumentStatus,
        priceDecimals: row.priceDecimals,
        searchWeight: row.searchWeight,
        mdLineIds: linesByInstrument.get(row.instrumentId) ?? [],
        // exactOptionalPropertyTypes: an absent primary listing is an absent property, not
        // `undefined` assigned to one.
        ...(row.primaryListingId === null ? {} : { primaryListingId: row.primaryListingId }),
      };
      return candidate;
    });
  }
}

/** A ref in words, for the message on a miss. */
function describe(ref: SecurityRef): string {
  const parts = [ref.value];
  if (ref.exchCode !== undefined) parts.push(ref.exchCode);
  if (ref.sector !== undefined) parts.push(ref.sector);
  return `'${parts.join(' ')}'`;
}
