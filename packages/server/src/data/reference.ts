/**
 * `data/reference.ts` — the reference reader service (FUNCTIONS.md §1.4.2 `DataServices.reference`,
 * ARCHITECTURE §3.3 L269, API.md §5.1).
 *
 * `data/*` is the **only** reader surface a function resolver may use. Nothing here writes, nothing
 * here fetches: every method is a read of the master tables through `refdata/*`, as of the
 * `(validAt, knownAt)` pair the service was constructed with (REF-03).
 *
 * ## DATA-10: every value carries its provenance
 *
 * A function payload's `meta.provenance[]` is a list of *rows of the `provenance` table*, and every
 * rendered cell points at one of them by index. The reference records returned here are the
 * bitemporal rows themselves, so each already carries `provenanceId`; what the runner additionally
 * needs is the mapping from those ids to `meta.provenance` indexes. That is what
 * {@link citeProvenance} does, and every service in this package returns the `provIdx` /
 * `provIdxOf` pair it produces.
 *
 * The sink is `ProvenanceCollector` (FUNCTIONS.md §1.4.2), which `functions/context.ts` builds for
 * a run; {@link ProvenanceIndex} is the standalone implementation used by ingest jobs, by
 * `data/request.ts` and by tests, so a service can be exercised without a function runner.
 *
 * This module is also the base of the five reader services: `historical`, `intraday`, `ticks` and
 * `snapshot` import {@link ProvenanceSink}, {@link DataDeps} and {@link citeProvenance} from here
 * rather than each declaring their own copy.
 */

import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';

import { asOf } from '../db/bitemporal.js';
import { classificationCodes, entityClassifications } from '../db/schema/calendars.js';
import { provenance as provenanceRows } from '../db/schema/provenance.js';
import { instruments } from '../db/schema/reference.js';
import { CalendarRepository } from '../refdata/calendars.js';
import { identifierRepository } from '../refdata/identifiers.js';
import {
  findIndexByInstrumentId,
  membersAsOf,
  membershipAsOf,
} from '../refdata/indexMembership.js';
import { masterRepositories } from '../refdata/master.js';
import { SecurityResolver } from '../refdata/resolve.js';
import { TermsRepository } from '../refdata/terms.js';

import type { Calendar } from '@terminal/core/calendars/calendar';
import type {
  AssetClass,
  InstrumentStatus,
  MarketSector,
  PayloadProvenance,
  Tier,
  ValueState,
} from '@terminal/core';
import type { SQL } from 'drizzle-orm';
import type { AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';
import type { CalendarRange } from '../refdata/calendars.js';
import type { EntityClassification } from '../refdata/classifications.js';
import type { IdentifierRecord } from '../refdata/identifiers.js';
import type { IndexMemberRecord, IndexRecord } from '../refdata/indexMembership.js';
import type {
  InstrumentRecord,
  IssueRecord,
  IssuerRecord,
  ListingRecord,
  MdLineRecord,
} from '../refdata/master.js';
import type { ResolveCandidate, SecurityResolverInput } from '../refdata/resolve.js';
import type { InstrumentTerms } from '../refdata/terms.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Provenance plumbing (DATA-10)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `provenance` row as `ProvenanceCollector.add` takes it (FUNCTIONS.md §1.4.2). */
export interface ProvenanceRef {
  sourceId: string;
  provenanceId: number;
  capturedAt: Date;
  sourceTs: Date | null;
  /** Feeds `meta.staleness` (worst wins). Omitted where the reader cannot know it. */
  st?: ValueState;
  /** Feeds `meta.tier` (lowest wins). Omitted → the runner takes it from the licence registry. */
  tier?: Tier;
}

/**
 * The half of `ProvenanceCollector` a data service uses: register a row, get its
 * `meta.provenance` index. The same `provenanceId` must always return the same index.
 */
export interface ProvenanceSink {
  add(ref: ProvenanceRef): number;
}

/** A `provenance_id` that a data row references but the `provenance` table does not contain. */
export class MissingProvenanceError extends Error {
  readonly provenanceId: number;
  constructor(provenanceId: number) {
    super(
      `no provenance row ${provenanceId}: a data row references it but provenance does not ` +
        'contain it (DATA-10)',
    );
    this.name = 'MissingProvenanceError';
    this.provenanceId = provenanceId;
  }
}

/**
 * The `meta.provenance` index of a value-bearing row, or {@link MissingProvenanceError}.
 *
 * `provIdxOf[id] ?? 0` is never right for a value: 0 is a real citation (API.md §4's example is
 * `"provIdx": [0]`), so the fallback would silently attribute the value to the first source in
 * the list. Only a cell with no value at all may carry the literal 0.
 */
export function citedIndex(provIdxOf: Record<number, number>, provenanceId: number): number {
  const idx = provIdxOf[provenanceId];
  if (idx === undefined) throw new MissingProvenanceError(provenanceId);
  return idx;
}

/** The reference row a reader asked for does not exist at `(validAt, knownAt)`. */
export class DataNotFoundError extends Error {
  readonly kind: string;
  readonly key: string | number;
  constructor(kind: string, key: string | number, at?: AsOf) {
    super(
      `no ${kind} ${String(key)}` +
        (at === undefined
          ? ''
          : ` as of ${at.validAt.toISOString()} known at ${at.knownAt.toISOString()}`),
    );
    this.name = 'DataNotFoundError';
    this.kind = kind;
    this.key = key;
  }
}

/** What a reader returns so the runner can put an index on every cell. */
export interface ProvenanceCitation {
  /** The distinct `meta.provenance` indexes this block cites, ascending (API.md §4 `provIdx`). */
  provIdx: number[];
  /** `provenance_id` → `meta.provenance` index, for per-cell attribution. */
  provIdxOf: Record<number, number>;
}

/** `worstState()` ordering: the later the entry, the worse (DATA-10 / TERM-12). */
const STATE_SEVERITY: Readonly<Record<ValueState, number>> = Object.freeze({
  live: 0,
  closed: 1,
  na: 2,
  stale: 3,
  blank: 4,
});

/** `lowestTier()` ordering: `eod < delayed < realtime` (core `Tier`). */
const TIER_RANK: Readonly<Record<Tier, number>> = Object.freeze({
  eod: 0,
  delayed: 1,
  realtime: 2,
});

/**
 * Load the `provenance` rows behind a set of ids.
 *
 * One query, deduplicated. `capturedAt` / `sourceTs` come back as `Date` because that is what
 * `ProvenanceCollector.add` takes; the column mirror stores them as ISO strings so the
 * `'infinity'` sentinel of the bitemporal columns can survive elsewhere in the schema.
 */
export async function loadProvenanceRefs(
  tx: Tx,
  ids: readonly number[],
): Promise<Map<number, ProvenanceRef>> {
  const out = new Map<number, ProvenanceRef>();
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return out;
  const rows = await tx
    .select({
      provenanceId: provenanceRows.provenanceId,
      sourceId: provenanceRows.sourceId,
      capturedAt: provenanceRows.capturedAt,
      sourceTs: provenanceRows.sourceTs,
    })
    .from(provenanceRows)
    .where(inArray(provenanceRows.provenanceId, wanted));
  for (const row of rows) {
    out.set(row.provenanceId, {
      sourceId: row.sourceId,
      provenanceId: row.provenanceId,
      capturedAt: new Date(row.capturedAt),
      sourceTs: row.sourceTs === null ? null : new Date(row.sourceTs),
    });
  }
  return out;
}

/**
 * Register every cited `provenance_id` with the run's collector and return the index mapping.
 *
 * `hint` supplies the `st` / `tier` a reader does know: a completed session's bar is `'closed'`
 * and never becomes anything else, a stored `QuoteState` carries its own verdict. Readers that
 * cannot know leave both out and the runner fills them from the licence registry.
 *
 * @throws MissingProvenanceError when an id has no row — a broken foreign key, never a blank cell.
 */
export async function citeProvenance(
  tx: Tx,
  sink: ProvenanceSink,
  ids: readonly number[],
  hint: { st?: ValueState; tier?: Tier } = {},
): Promise<ProvenanceCitation> {
  const refs = await loadProvenanceRefs(tx, ids);
  const provIdxOf: Record<number, number> = {};
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const ref = refs.get(id);
    if (ref === undefined) throw new MissingProvenanceError(id);
    provIdxOf[id] = sink.add({
      ...ref,
      ...(hint.st === undefined ? {} : { st: hint.st }),
      ...(hint.tier === undefined ? {} : { tier: hint.tier }),
    });
  }
  const provIdx = [...new Set(Object.values(provIdxOf))].sort((a, b) => a - b);
  return { provIdx, provIdxOf };
}

/**
 * A standalone `ProvenanceSink` — the `ProvenanceCollector` surface a data service needs, without
 * a function runner. `data/request.ts`, the ingest jobs and the tests build one of these; a
 * function run passes the runner's collector instead, and the two agree because the index is
 * simply the insertion order of distinct `provenance_id`s.
 *
 * `attribution` is left empty: only the runner has the licence registry (DATA-09), and inventing
 * an attribution string here would put an unattributed value on a screen.
 */
export class ProvenanceIndex implements ProvenanceSink {
  readonly #byId = new Map<number, number>();
  readonly #refs: ProvenanceRef[] = [];

  add(ref: ProvenanceRef): number {
    const hit = this.#byId.get(ref.provenanceId);
    if (hit !== undefined) {
      // A second citation may know more than the first (a quote state's staleness beats a bare
      // row's silence), so the worst state and the lowest tier win, as `meta` reports them.
      const held = this.#refs[hit];
      if (held !== undefined) {
        if (
          ref.st !== undefined &&
          (held.st === undefined || STATE_SEVERITY[ref.st] > STATE_SEVERITY[held.st])
        ) {
          held.st = ref.st;
        }
        if (
          ref.tier !== undefined &&
          (held.tier === undefined || TIER_RANK[ref.tier] < TIER_RANK[held.tier])
        ) {
          held.tier = ref.tier;
        }
      }
      return hit;
    }
    const idx = this.#refs.length;
    this.#refs.push({ ...ref });
    this.#byId.set(ref.provenanceId, idx);
    return idx;
  }

  /** `meta.provenance[]` without attribution — the runner fills that from `licence_registry`. */
  list(): PayloadProvenance[] {
    return this.#refs.map((ref, idx) => ({
      idx,
      sourceId: ref.sourceId,
      provenanceId: ref.provenanceId,
      capturedAt: ref.capturedAt.toISOString(),
      sourceTs: ref.sourceTs === null ? null : ref.sourceTs.toISOString(),
      attribution: '',
    }));
  }

  /** `meta.staleness`: the worst verdict any cited row carried. */
  worstState(): ValueState {
    let worst: ValueState = 'live';
    for (const ref of this.#refs) {
      if (ref.st !== undefined && STATE_SEVERITY[ref.st] > STATE_SEVERITY[worst]) worst = ref.st;
    }
    return worst;
  }

  /** `meta.tier`: the lowest tier any cited row carried; `'eod'` when none said. */
  lowestTier(): Tier {
    let lowest: Tier | undefined;
    for (const ref of this.#refs) {
      if (ref.tier === undefined) continue;
      if (lowest === undefined || TIER_RANK[ref.tier] < TIER_RANK[lowest]) lowest = ref.tier;
    }
    return lowest ?? 'eod';
  }

  /** How many distinct provenance rows have been cited. */
  get size(): number {
    return this.#refs.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Service dependencies
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What every reader in this package is constructed with: the request transaction, the as-of pair
 * the whole run reads at (ARCHITECTURE §5 step 6), and the run's provenance collector.
 *
 * The services are deliberately *not* given an entitlement decision here: the runner performs the
 * ENTL-01 pre-check before it builds them (FUNCTIONS.md §1.4.2) and hands the denied fields to the
 * readers that render cells — see `snapshot.ts`'s `denied` map.
 */
export interface DataDeps {
  tx: Tx;
  asOf: AsOf;
  prov: ProvenanceSink;
}

/** `YYYY-MM-DD` of an instant, in UTC (every session date in the schema is a UTC date). */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Result shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `GET /ref/:instrumentId` (API.md §5.1 L539) as one object: the whole hierarchy at one instant.
 * Every member is a bitemporal record and carries its own `provenanceId`; `provIdxOf` maps those
 * to `meta.provenance` indexes.
 */
export interface InstrumentDetail extends ProvenanceCitation {
  instrument: InstrumentRecord;
  issue: IssueRecord | null;
  issuer: IssuerRecord | null;
  listings: ListingRecord[];
  mdLines: MdLineRecord[];
  identifiers: IdentifierRecord[];
  /** Discriminated by `kind`; `null` for an asset class with no terms table (equity, crypto). */
  terms: InstrumentTerms | null;
  /** Every scheme, for the instrument and for its issuer (GICS, SIC, NAICS, internal). */
  classifications: EntityClassification[];
}

/** API.md L416 `ResolveItem`, with this package's richer candidate rows. */
export interface ResolveItem {
  /** The reference as it was asked for. */
  ref: SecurityResolverInput;
  instrument: ResolveCandidate | null;
  /** Best matches when ambiguous or not found (≤ 8, `search_weight` first). */
  candidates: ResolveCandidate[];
  error?: {
    code: 'SECURITY_NOT_FOUND' | 'AMBIGUOUS_SECURITY' | 'NOT_IN_UNIVERSE';
    message: string;
  };
  /** Always `'master'` here: filling a miss from OpenFIGI is an ingest job's job, not a read's. */
  source: 'master';
  /** Set when `panelSecurityId` broke a tie (TERM-03). */
  disambiguatedByPanel?: boolean;
}

/** One constituent of `GET /indices/:instrumentId/members` (REF-07, MEMB). */
export interface MemberView {
  instrumentId: number;
  ticker: string;
  exchCode: string;
  name: string;
  currency: string;
  assetClass: AssetClass;
  marketSector: MarketSector;
  status: InstrumentStatus;
  /** Fraction of the index, not a percentage. */
  weight: number | null;
  shares: number | null;
  marketValue: number | null;
  sourceId: string;
  asOfDate: string;
  provenanceId: number;
  /** Index into `meta.provenance` for this row. */
  provIdx: number;
}

export interface MembersResponse extends ProvenanceCitation {
  indexInstrumentId: number;
  indexId: number;
  /** `'SPX'`. */
  code: string;
  /** The date the roster was read at (`YYYY-MM-DD`). */
  asOfDate: string;
  members: MemberView[];
  /** Σ weight over the members that carry one — ≈ 1 for a full roster (REF-07). */
  weightSum: number;
  /** Members whose instrument row could not be read at this instant (a placeholder holding). */
  unresolved: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SUMMARY_COLUMNS = {
  instrumentId: instruments.instrumentId,
  ticker: instruments.ticker,
  exchCode: instruments.exchCode,
  name: instruments.name,
  currency: instruments.currency,
  assetClass: instruments.assetClass,
  marketSector: instruments.marketSector,
  status: instruments.status,
} as const;

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `DataServices.reference` (FUNCTIONS.md §1.4.2 L285-291).
 *
 * `search()` is deliberately absent: its declared signature is typed in terms of `SecfParams` /
 * `SecfPayload`, which are generated from the SECF manifest in the tier-1 function package and do
 * not exist yet. It joins this service when they do (WORKPLAN §18); `refdata/universe.ts` already
 * holds the candidate side of it.
 */
export class ReferenceService {
  readonly #tx: Tx;
  readonly #at: AsOf;
  readonly #prov: ProvenanceSink;
  readonly #master: ReturnType<typeof masterRepositories>;
  readonly #identifiers: ReturnType<typeof identifierRepository>;
  readonly #terms: TermsRepository;
  readonly #resolver: SecurityResolver;
  readonly #calendars: CalendarRepository;

  constructor(deps: DataDeps, calendarRange?: CalendarRange) {
    this.#tx = deps.tx;
    this.#at = deps.asOf;
    this.#prov = deps.prov;
    this.#master = masterRepositories(deps.tx);
    this.#identifiers = identifierRepository(deps.tx);
    this.#terms = new TermsRepository(deps.tx);
    this.#resolver = new SecurityResolver(deps.tx);
    this.#calendars =
      calendarRange === undefined
        ? new CalendarRepository(deps.tx)
        : new CalendarRepository(deps.tx, calendarRange);
  }

  /** The as-of pair every read in this service uses. */
  get asOf(): AsOf {
    return this.#at;
  }

  /**
   * instrument + issue + issuer + listings + mdLines + identifiers + terms + classifications, all
   * at `(validAt, knownAt)`.
   *
   * @throws DataNotFoundError when no version of the instrument is valid and known at that pair —
   *         which is the honest answer for a future instrument or a past-dated read, and is what
   *         the runner turns into `404 SECURITY_NOT_FOUND`.
   */
  async instrument(id: number): Promise<InstrumentDetail> {
    const at = this.#at;
    const instrument = await this.#master.instruments.get(id, at);
    if (instrument === null) throw new DataNotFoundError('instrument', id, at);

    const issue = await this.#master.issues.get(instrument.issueId, at);
    const issuer = issue === null ? null : await this.#master.issuers.get(issue.issuerId, at);
    const [listings, mdLines, instrumentIds, issueIds] = await Promise.all([
      this.#master.listings.byInstrument(id, at),
      this.#master.mdLines.byInstrument(id, at),
      this.#identifiers.forEntity('instrument', id, at),
      issue === null
        ? Promise.resolve<IdentifierRecord[]>([])
        : this.#identifiers.forEntity('issue', issue.issueId, at),
    ]);
    const issuerIds =
      issuer === null ? [] : await this.#identifiers.forEntity('issuer', issuer.issuerId, at);
    const terms = await this.#terms.forInstrument(id, instrument.assetClass, at);
    const classifications = await this.classifications(
      id,
      issuer === null ? null : issuer.issuerId,
    );

    const identifiers = [...instrumentIds, ...issueIds, ...issuerIds];
    const cited: number[] = [
      instrument.provenanceId,
      ...(issue === null ? [] : [issue.provenanceId]),
      ...(issuer === null ? [] : [issuer.provenanceId]),
      ...listings.map((r) => r.provenanceId),
      ...mdLines.map((r) => r.provenanceId),
      ...identifiers.map((r) => r.provenanceId),
      ...(terms === null ? [] : [terms.terms.provenanceId]),
      ...classifications.map((r) => r.provenanceId),
    ];
    const citation = await citeProvenance(this.#tx, this.#prov, cited);

    return {
      instrument,
      issue,
      issuer,
      listings,
      mdLines,
      identifiers,
      terms,
      classifications,
      ...citation,
    };
  }

  /**
   * Every classification version in force for the instrument and (when given) its issuer, across
   * every scheme, with the code's name joined in.
   *
   * A direct read rather than `ClassificationRepository.readMany`, which is scheme-scoped: DES and
   * SECF want "whatever this name is classified as", and asking per scheme would be one query per
   * scheme for a screen that shows them all.
   */
  async classifications(
    instrumentId: number,
    issuerId: number | null,
  ): Promise<EntityClassification[]> {
    const keys: SQL[] = [
      and(
        eq(entityClassifications.entityKind, 'instrument'),
        eq(entityClassifications.entityId, instrumentId),
      )!,
    ];
    if (issuerId !== null) {
      keys.push(
        and(
          eq(entityClassifications.entityKind, 'issuer'),
          eq(entityClassifications.entityId, issuerId),
        )!,
      );
    }
    const rows = await this.#tx
      .select({
        entityKind: entityClassifications.entityKind,
        entityId: entityClassifications.entityId,
        scheme: entityClassifications.scheme,
        code: entityClassifications.code,
        name: classificationCodes.name,
        level: classificationCodes.level,
        provenanceId: entityClassifications.provenanceId,
        validFrom: entityClassifications.validFrom,
        validTo: entityClassifications.validTo,
      })
      .from(entityClassifications)
      .leftJoin(
        classificationCodes,
        and(
          eq(classificationCodes.scheme, entityClassifications.scheme),
          eq(classificationCodes.code, entityClassifications.code),
        ),
      )
      .where(and(or(...keys), asOf(entityClassifications, this.#at)))
      .orderBy(asc(entityClassifications.scheme), asc(entityClassifications.code));

    return rows.map((row) => ({
      // `entity_kind` is the six-value enum; only these two are classifiable, and the WHERE above
      // asked for no others.
      entityKind: row.entityKind === 'issuer' ? 'issuer' : 'instrument',
      entityId: row.entityId,
      scheme: row.scheme,
      code: row.code,
      name: row.name,
      level: row.level,
      provenanceId: row.provenanceId,
      validFrom: row.validFrom,
      validTo: row.validTo,
    }));
  }

  /** Every identifier of one instrument (and of its issue / issuer) at this instant. */
  async identifiers(instrumentId: number): Promise<IdentifierRecord[]> {
    const detail = await this.instrument(instrumentId);
    return detail.identifiers;
  }

  /**
   * `SecurityRef | identifier → ResolvedRef` as of this service's pair (REF-01, REF-02).
   *
   * Ambiguity returns candidates and never a guess. `panelSecurityId` is the TERM-03 context: when
   * the panel already holds a security and exactly one candidate shares its composite exchange (or,
   * failing that, its market sector), that candidate answers — which is what makes typing `AAPL`
   * in a US-equity panel resolve without an exchange code, while the same text with no context
   * still refuses.
   */
  async resolve(
    ref: SecurityResolverInput,
    opts: { panelSecurityId?: number } = {},
  ): Promise<ResolveItem> {
    const result = await this.#resolver.resolve(ref, this.#at);
    if (result.ok) {
      return { ref, instrument: result.instrument, candidates: [], source: 'master' };
    }

    const candidates = [...result.candidates];
    if (result.code === 'AMBIGUOUS_SECURITY' && opts.panelSecurityId !== undefined) {
      const panel = await this.#resolver.byInstrumentId(opts.panelSecurityId, this.#at);
      if (panel !== null) {
        const sameExch = candidates.filter((c) => c.exchCode === panel.exchCode);
        const narrowed =
          sameExch.length === 1
            ? sameExch
            : candidates.filter((c) => c.marketSector === panel.marketSector);
        const only = narrowed.length === 1 ? narrowed[0] : undefined;
        if (only !== undefined) {
          return {
            ref,
            instrument: only,
            candidates: [],
            source: 'master',
            disambiguatedByPanel: true,
          };
        }
      }
    }

    // `BAD_IDENTIFIER` is internal: the three codes API.md L420 puts on the wire are the others,
    // and a malformed reference is, to a caller, a reference that names nothing.
    const code =
      result.code === 'AMBIGUOUS_SECURITY' || result.code === 'NOT_IN_UNIVERSE'
        ? result.code
        : 'SECURITY_NOT_FOUND';
    return {
      ref,
      instrument: null,
      candidates,
      error: { code, message: result.message },
      source: 'master',
    };
  }

  /**
   * The roster of an index on `asOfDate` (default: the UTC date of `validAt`), with weights, as
   * known at `knownAt` — REF-07.
   *
   * `indexInstrumentId` is the *index's own instrument* (`SPX Index`), which is how a function
   * addresses it; `indices.instrument_id` maps it to the membership key.
   */
  async members(indexInstrumentId: number, asOfDate?: string): Promise<MembersResponse> {
    const index: IndexRecord | null = await findIndexByInstrumentId(this.#tx, indexInstrumentId);
    if (index === null) throw new DataNotFoundError('index for instrument', indexInstrumentId);

    const date = asOfDate ?? utcDate(this.#at.validAt);
    const at = membershipAsOf(date, this.#at.knownAt);
    const rows: IndexMemberRecord[] = await membersAsOf(this.#tx, index.indexId, at);

    const summaries = await this.#summaries(
      rows.map((r) => r.instrumentId),
      at,
    );
    const citation = await citeProvenance(
      this.#tx,
      this.#prov,
      rows.map((r) => r.provenanceId),
    );

    const members: MemberView[] = [];
    let weightSum = 0;
    let unresolved = 0;
    for (const row of rows) {
      const summary = summaries.get(row.instrumentId);
      if (summary === undefined) {
        unresolved += 1;
        continue;
      }
      if (row.weight !== null) weightSum += row.weight;
      members.push({
        ...summary,
        weight: row.weight,
        shares: row.shares,
        marketValue: row.marketValue,
        sourceId: row.sourceId,
        asOfDate: row.asOfDate,
        provenanceId: row.provenanceId,
        // Not `?? 0`: index 0 is a real citation, so a member row we could not attribute would be
        // shown under someone else's source. `citeProvenance` registered every id in `cited`
        // above and throws on one the `provenance` table does not hold, so this cannot be absent
        // — and if it ever is, it fails here rather than lying.
        provIdx: citedIndex(citation.provIdxOf, row.provenanceId),
      });
    }

    return {
      indexInstrumentId,
      indexId: index.indexId,
      code: index.code,
      asOfDate: date,
      members,
      weightSum,
      unresolved,
      ...citation,
    };
  }

  /**
   * The database's `Calendar` (REF-06). Not the generator in `@terminal/core`: a missing row means
   * the calendar was never materialised, and answering from the rules would hide that behind
   * correct-looking holidays.
   *
   * @throws CalendarRowError when the calendar has no rows.
   */
  calendar(calendarId: string): Promise<Calendar> {
    return this.#calendars.require(calendarId);
  }

  /** Instrument summaries for a list of ids, in one query, as of `at`. */
  async #summaries(
    ids: readonly number[],
    at: AsOf,
  ): Promise<
    Map<
      number,
      Omit<
        MemberView,
        'weight' | 'shares' | 'marketValue' | 'sourceId' | 'asOfDate' | 'provenanceId' | 'provIdx'
      >
    >
  > {
    const out = new Map<
      number,
      Omit<
        MemberView,
        'weight' | 'shares' | 'marketValue' | 'sourceId' | 'asOfDate' | 'provenanceId' | 'provIdx'
      >
    >();
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return out;
    const rows = await this.#tx
      .select(SUMMARY_COLUMNS)
      .from(instruments)
      .where(and(inArray(instruments.instrumentId, wanted), asOf(instruments, at)))
      .orderBy(asc(instruments.instrumentId));
    for (const row of rows) {
      out.set(row.instrumentId, {
        instrumentId: row.instrumentId,
        ticker: row.ticker,
        exchCode: row.exchCode,
        name: row.name,
        currency: row.currency,
        assetClass: row.assetClass,
        marketSector: row.marketSector,
        status: row.status as InstrumentStatus,
      });
    }
    return out;
  }
}

/** `referenceService({ tx, asOf, prov }).instrument(42)`. */
export function referenceService(deps: DataDeps, calendarRange?: CalendarRange): ReferenceService {
  return new ReferenceService(deps, calendarRange);
}

/**
 * The quote currency of an instrument at `at` — what `SeriesBlock.currency` reports when the
 * caller asked for no conversion. Shared with `historical.ts` / `intraday.ts`.
 *
 * @throws DataNotFoundError when the instrument has no version at that instant.
 */
export async function instrumentCurrency(tx: Tx, instrumentId: number, at: AsOf): Promise<string> {
  const rows = await tx
    .select({ currency: instruments.currency })
    .from(instruments)
    .where(and(eq(instruments.instrumentId, instrumentId), asOf(instruments, at)))
    .orderBy(desc(instruments.versionId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new DataNotFoundError('instrument', instrumentId, at);
  return row.currency;
}

/**
 * ECB reference rates (`fx_rates`) as a per-date multiplier from `from` to `to`, for the series
 * currency conversion of CHRT-03. `null` when the pair has no rate on that date; the caller
 * decides whether that is a blank row or a refusal.
 */
export async function fxMultipliers(
  tx: Tx,
  from: string,
  to: string,
  start: string,
  end: string,
): Promise<Map<string, { rate: number; provenanceId: number }>> {
  const out = new Map<string, { rate: number; provenanceId: number }>();
  if (from === to) return out;
  const rows = await tx.execute<{
    rate_date: string;
    rate: string;
    provenance_id: string;
    inverted: boolean;
  }>(sql`
      SELECT rate_date::text AS rate_date, rate::text AS rate, provenance_id::text AS provenance_id,
             false AS inverted
        FROM fx_rates
       WHERE base_ccy = ${from} AND quote_ccy = ${to}
         AND rate_date BETWEEN ${start}::date AND ${end}::date
       UNION ALL
      SELECT rate_date::text, rate::text, provenance_id::text, true
        FROM fx_rates
       WHERE base_ccy = ${to} AND quote_ccy = ${from}
         AND rate_date BETWEEN ${start}::date AND ${end}::date`);

  for (const row of rows.rows) {
    const raw = numberOrNull(row.rate);
    if (raw === null || raw === 0) continue;
    const rate = row.inverted ? 1 / raw : raw;
    // A direct quote wins over an inverted one when both exist.
    if (row.inverted && out.has(row.rate_date)) continue;
    out.set(row.rate_date, { rate, provenanceId: Number(row.provenance_id) });
  }
  return out;
}
