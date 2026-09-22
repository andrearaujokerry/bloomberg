/**
 * `data/request.ts` — the `DataRequest` dispatcher (API-02, API.md §4 L289-391).
 *
 * `POST /data` is the single data endpoint and this is the single place its five kinds are served.
 * The convenience GETs of API.md §5.4 (`/data/reference`, `/data/history`, `/data/intraday`,
 * `/data/ticks`, `/data/snapshot`) build the same `DataRequest` object and come through here, so
 * there is exactly one implementation of resolution, entitlement, quota, provenance and the
 * response envelope rather than six that drift.
 *
 * ## What the dispatcher owns
 *
 * Everything that is about the *request*, and nothing that is about a table:
 *
 *  1. **validation** — the body is parsed with the wire schema itself
 *     (`@terminal/sdk/wire/dataRequest`), so the server can never accept a request the SDK cannot
 *     produce. Every `.default()` in that schema is applied here and nowhere else, which is what
 *     makes the convenience GETs and `POST /data` provably the same request;
 *  2. **resolution** as of `asOf` (REF-03) through `refdata/resolve.ts`. A miss or an ambiguity is a
 *     *per-result* `error` with `candidates`; the request as a whole is still `200` (rule 1);
 *  3. **entitlement**, once per request over `securities × fields × tier × usage`, **before any
 *     service read** (rule 2, ENTL-01). Denied fields come back `null` with `r[field]`; a request in
 *     which no field is servable is `403 ENTITLEMENT_DENIED`;
 *  4. **quota** (rule 7, API-06): reference/realtime charge `securities × fields`, historical and
 *     intraday `rows × columns`, tick `ticks.length`. The limit is checked against the upper bound
 *     the request implies *before* any fetch; `meta.quota` reports what was actually charged;
 *  5. **multi-security alignment** (`calendarAlign`, CHRT-03) and `fill`. Both are properties of a
 *     *set* of series — which is exactly why neither appears in `DataServices.historical.bars`
 *     (FUNCTIONS.md L292) — so they are applied here, after the per-security blocks come back;
 *  6. **the envelope**: `meta.provenance[]` with the attribution text joined from
 *     `licence_registry`, `meta.tier` (lowest cited), `meta.staleness` (worst cited),
 *     `meta.adjustments`, `meta.engines`, `meta.unavailable`, and `meta.asOf` — always the
 *     *effective* pair, never the requested one (rule 4).
 *
 * ## Provenance: the dispatcher is the runner
 *
 * `data/reference.ts` sets the convention every reader in this package follows: a service is built
 * from a `DataDeps { tx, asOf, prov }`, registers each `provenance_id` it touches with the run's
 * `ProvenanceSink` and returns the `provIdx` the sink handed back. `ProvenanceIndex.list()`
 * deliberately leaves `attribution` empty, because only the runner has the licence registry
 * (DATA-09) — and for a `DataRequest`, **this file is the runner**. {@link withAttribution} fills it
 * from the `licence_registry` version current at `knownAt`, so a licence whose terms changed after
 * a value was captured cannot rewrite the footer of a past-dated read.
 *
 * ## Entitlement and quota are ports, not implementations
 *
 * `server/src/entitlements/evaluator.ts` (ARCHITECTURE §10) and the API-06 quota counters are not
 * WP-04 files. They arrive as the optional {@link EntitlementPort} / {@link QuotaPort} dependencies.
 * With NO evaluator wired the dispatcher serves NOTHING: every field is denied
 * `NO_FIRM_ENTITLEMENT`, the same fail-closed default `ws/gateway.ts` takes. A deployment that
 * genuinely wants entitlements off passes {@link allowAllEntitlements} and says so; an omitted
 * dependency is never allowed to mean "allow everything".
 */

import {
  canonicalJson,
  getField,
  sha256Hex,
  type AssetClass,
  type Clock,
  type EntitlementDecision,
  type EntitlementRequest,
  type FieldDef,
  type FieldId,
  type FieldValue,
  type PayloadProvenance,
  type ReasonCode,
  type Tier,
  type UsageType,
  type ValueCell,
  type ValueState,
} from '@terminal/core';
import {
  DataRequest,
  type DataKind,
  type DataRequestInput,
  type DataResponse,
  type DataResult,
  type SeriesBlock,
  type TickRow,
} from '@terminal/sdk/wire/dataRequest';
import type {
  AdjustmentStep,
  EngineNote,
  EntitlementNote,
  InstrumentSummary,
  Meta,
  ProvenanceRef,
  SecurityRefInput,
  UnavailableNote,
} from '@terminal/sdk/wire/envelope';
import { and, inArray, sql } from 'drizzle-orm';

import type { AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';
import { licenceRegistry } from '../db/schema/provenance.js';
import { AppError } from '../http/errors.js';
import { SecurityResolver, type ResolveCandidate, type ResolveResult } from '../refdata/resolve.js';

import { EconService } from './econ.js';
import { HISTORY_FIELDS, historicalService } from './historical.js';
import { INTRADAY_FIELDS, intradayService } from './intraday.js';
import {
  ProvenanceIndex,
  citeProvenance,
  type DataDeps,
  type ProvenanceSink,
} from './reference.js';
import { snapshotService } from './snapshot.js';
import { ticksService } from './ticks.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The reader port
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What `data/historical.ts` and `data/intraday.ts` return: the wire's `SeriesBlock` — `provIdx`
 * already assigned by the run's sink — plus the notes only the runner can place in `meta`.
 */
export interface SeriesOut extends SeriesBlock {
  /** REF-09: the factor steps actually applied, echoed in `meta.adjustments`. */
  adjustments?: readonly AdjustmentStep[];
  /** ANAL-08: `{ name: 'adjust', version, inputsHash }`. */
  engines?: readonly EngineNote[];
  /** TERM-12 verdict for the block; defaults to `'closed'` (a completed session cannot change). */
  st?: ValueState;
  tier?: Tier;
}

/** What `data/ticks.ts` returns for one security (rule 5: `capTs` ascending, cursor-paginated). */
export interface TicksPage {
  ticks: TickRow[];
  nextCursor: string | null;
  st?: ValueState;
  tier?: Tier;
}

/** `historical`, with `end` already defaulted from `validAt` and `fields` already entitlement-gated. */
export interface HistoricalQuery {
  start: string;
  end: string;
  periodicity: 'D' | 'W' | 'M' | 'Q' | 'Y';
  adjust: 'unadjusted' | 'price' | 'total_return';
  fields: FieldId[];
  currency?: string;
}

export interface IntradayQuery {
  start: string;
  end: string;
  interval: '1m' | '5m' | '15m' | '1h';
  session: 'regular' | 'extended';
  fields: FieldId[];
}

export interface TickQuery {
  start: string;
  end: string;
  kinds: readonly ('trade' | 'quote' | 'summary')[];
  limit: number;
  fields: FieldId[];
  cursor?: string;
}

/** A record-shaped read: `instrumentId → field → cell`, the shape of `DataServices.snapshot.fields`. */
export type CellsByInstrument = Map<number, Record<string, ValueCell>>;

/**
 * The five readers the dispatcher routes to. Each is one `data/*` service, already constructed
 * with this request's `DataDeps` (so `asOf` and the provenance sink are baked in and cannot drift
 * between two reads of the same response).
 *
 * `reference` and `realtime` share a cell shape but not a source: `referenceFields` is the master
 * / terms / classifications / PIT read, `snapshotFields` is the plant ∪ reference merge of
 * `data/snapshot.ts`, which is what makes `kind:'realtime'` on REST one `snapshotMany()` (rule 6).
 */
export interface DataSources {
  referenceFields(ids: readonly number[], fields: readonly FieldId[]): Promise<CellsByInstrument>;
  snapshotFields(
    ids: readonly number[],
    fields: readonly FieldId[],
    tier: Tier,
  ): Promise<CellsByInstrument>;
  historical(instrumentId: number, q: HistoricalQuery): Promise<SeriesOut>;
  intraday(instrumentId: number, q: IntradayQuery): Promise<SeriesOut>;
  ticks(instrumentId: number, q: TickQuery): Promise<TicksPage>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entitlement / quota ports
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `server/src/entitlements/evaluator.ts#evaluate` (ARCHITECTURE §10), injected. */
export interface EntitlementPort {
  evaluate(req: EntitlementRequest): Promise<EntitlementDecision>;
}

/**
 * The explicit opt-out: every requested field allowed at the requested tier, no audit row.
 *
 * This exists so that "entitlements are off" is a value an operator or a test **passes**, never
 * what a forgotten dependency silently means. {@link DispatcherDeps.entitlement} left undefined
 * denies everything (fail closed, like `ws/gateway.ts`'s `denyAllEntitlements`); only this port
 * opens it, and the call site then says so in one word.
 */
export const allowAllEntitlements: EntitlementPort = {
  evaluate(req: EntitlementRequest): Promise<EntitlementDecision> {
    return Promise.resolve({
      effectiveTier: req.tier,
      fields: req.fieldIds.map((fieldId) => ({
        fieldId,
        sourceId: '',
        fieldClass: getField(fieldId)?.fieldClass ?? 'reference',
        decision: 'allow' as const,
        effectiveTier: req.tier,
        reason: 'OK' as const,
      })),
      downgrades: [],
      logIds: [],
    });
  },
};

export interface QuotaCharge {
  kind: DataKind;
  purpose: string;
  instrumentIds: readonly number[];
  dataPoints: number;
}

/** API-06. `reserve` runs before any fetch (rule 7); `settle` records what was really served. */
export interface QuotaPort {
  /** Throws `AppError('QUOTA_EXCEEDED')` when the upper bound would break a limit. */
  reserve(charge: QuotaCharge): Promise<void>;
  /** Returns `uniqueInstrumentsAdded`: how many of these instruments were newly counted today. */
  settle(charge: QuotaCharge): Promise<number>;
}

/** The session identity entitlement decisions and access-log rows are written against. */
export interface DataCaller {
  userId: number;
  firmId: number;
  sessionId: string;
  /** Forced by the route: bearer sessions are `'api'`, export routes `'export'` (API.md §4). */
  usage?: UsageType;
  /** The ceiling the session may request before per-field rules apply. */
  tier?: Tier;
}

export interface DispatcherDeps {
  tx: Tx;
  clock: Clock;
  /** Built from this request's `DataDeps` — see {@link createDispatcher}. */
  sources: DataSources;
  /** `meta.traceId`; the wire schema requires a uuid. */
  traceId: string;
  /** The run's provenance collector: the same sink the services were constructed with. */
  prov: ProvenanceIndex;
  caller?: DataCaller;
  entitlement?: EntitlementPort;
  quota?: QuotaPort;
  resolver?: SecurityResolver;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Orderings the envelope needs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `meta.tier` is the **lowest** tier among cited values (API.md §3, FUNCTIONS runner step 8). */
const TIER_RANK: Readonly<Record<Tier, number>> = Object.freeze({
  eod: 0,
  delayed: 1,
  realtime: 2,
});

export function lowestTier(tiers: readonly Tier[]): Tier {
  let best: Tier | undefined;
  for (const t of tiers) if (best === undefined || TIER_RANK[t] < TIER_RANK[best]) best = t;
  return best ?? 'eod';
}

/**
 * `meta.staleness` is the **worst** `ValueState` cited (TERM-12). The ordering is the one
 * `data/reference.ts` established for `ProvenanceIndex.worstState()`, so the two agree: `closed` is
 * not a fault (a finished session's official print is the value), `na` says the field does not
 * apply, `stale` says a value that should have updated did not, and `blank` — nothing may be shown
 * — is the worst thing a response can say.
 */
const STATE_SEVERITY: Readonly<Record<ValueState, number>> = Object.freeze({
  live: 0,
  closed: 1,
  na: 2,
  stale: 3,
  blank: 4,
});

export function worstState(states: readonly ValueState[]): ValueState {
  let worst: ValueState = 'live';
  for (const s of states) if (STATE_SEVERITY[s] > STATE_SEVERITY[worst]) worst = s;
  return worst;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Provenance attribution (DATA-09, DATA-10)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Put the licence attribution on the collector's list.
 *
 * `ProvenanceIndex.list()` returns `attribution: ''` on purpose — a data service has no business
 * inventing the text a screen footer and a CSV header must show. The governing row is the
 * `licence_registry` version whose validity covers **`validAt`**: terms change, and a 2019 value
 * must be footed with the terms that applied in 2019.
 *
 * It is read as *currently known* (`tx_to = 'infinity'`) rather than as known at `knownAt`,
 * deliberately. The registry is a catalogue of terms, not an observation of the market: its rows
 * are written when the terms are entered, which for every v1 source is long after the data they
 * govern was published. Reading it at `knownAt` would leave every past-dated response
 * unattributed, and DATA-09 requires the footer on every screen, not on recent ones.
 *
 * A source with no registry row keeps its `source_id` as the attribution. That can only happen for
 * a hand-written row, because `assert_source_known` rejects any `provenance` insert whose
 * `source_id` the registry does not know.
 */
export async function withAttribution(
  tx: Tx,
  at: AsOf,
  refs: readonly PayloadProvenance[],
): Promise<ProvenanceRef[]> {
  if (refs.length === 0) return [];
  const sourceIds = [...new Set(refs.map((r) => r.sourceId))];
  const rows = await tx
    .select({ sourceId: licenceRegistry.sourceId, attribution: licenceRegistry.attribution })
    .from(licenceRegistry)
    .where(
      and(
        inArray(licenceRegistry.sourceId, sourceIds),
        sql`${licenceRegistry.txTo} = 'infinity'`,
        sql`${licenceRegistry.validFrom} <= ${at.validAt}::timestamptz`,
        sql`${licenceRegistry.validTo} > ${at.validAt}::timestamptz`,
      ),
    );

  const bySource = new Map<string, string>();
  for (const row of rows) bySource.set(row.sourceId, row.attribution);

  return refs.map((ref) => ({
    idx: ref.idx,
    sourceId: ref.sourceId,
    provenanceId: ref.provenanceId,
    capturedAt: ref.capturedAt,
    sourceTs: ref.sourceTs,
    attribution: bySource.get(ref.sourceId) ?? ref.sourceId,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// asOf, fields, instruments
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The effective `(validAt, knownAt)` pair (REF-03). Both default to now, and `meta.asOf` reports
 * what was used rather than what was asked for (rule 4) — which is what makes a run reproducible
 * (ANAL-08): replay the pair the response reported and you get the same rows.
 */
export function effectiveAsOf(
  asOf: { validAt?: string | undefined; knownAt?: string | undefined } | undefined,
  clock: Clock,
): AsOf {
  const now = new Date(clock.now());
  return {
    validAt: asOf?.validAt === undefined ? now : new Date(asOf.validAt),
    knownAt: asOf?.knownAt === undefined ? now : new Date(asOf.knownAt),
  };
}

/** `'YYYY-MM-DD'` in UTC — what `end` defaults to when a historical request omits it. */
function utcDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * Every requested field must be a dictionary field (API-03, API.md §5.5). An unknown id is
 * `404 FIELD_UNKNOWN` for the whole request rather than a silently blank column: a caller who typed
 * `PX_LST` wants to be told, not handed nulls it will plot.
 */
export function requireFields(ids: readonly FieldId[]): FieldDef[] {
  const unknown: string[] = [];
  const defs: FieldDef[] = [];
  for (const id of ids) {
    const def = getField(id);
    if (def === undefined) unknown.push(id);
    else defs.push(def);
  }
  if (unknown.length > 0) {
    throw new AppError('FIELD_UNKNOWN', `not a dictionary field: ${unknown.join(', ')}`, {
      details: { fields: unknown },
    });
  }
  return defs;
}

/** `ResolveCandidate` → the wire's `InstrumentSummary` (API.md §3 L232-240). */
export function toInstrumentSummary(c: ResolveCandidate): InstrumentSummary {
  return {
    instrumentId: c.instrumentId,
    assetClass: c.assetClass,
    marketSector: c.marketSector,
    display: c.display,
    name: c.name,
    currency: c.currency,
    ...(c.primaryListingId === undefined ? {} : { primaryListingId: c.primaryListingId }),
    mdLineIds: c.mdLineIds,
    ticker: c.ticker,
    exchCode: c.exchCode,
    securityType: c.securityType,
    compositeFigi: c.compositeFigi,
    status: c.status,
    priceDecimals: c.priceDecimals,
  };
}

/**
 * A resolver failure → the per-result `error` block. `BAD_IDENTIFIER` is internal: to a caller, a
 * malformed reference is a reference that names nothing (API.md L420 puts three codes on the wire).
 */
function errorOf(miss: Extract<ResolveResult, { ok: false }>): NonNullable<DataResult['error']> {
  const code =
    miss.code === 'AMBIGUOUS_SECURITY' || miss.code === 'NOT_IN_UNIVERSE'
      ? miss.code
      : ('SECURITY_NOT_FOUND' as const);
  const candidates = miss.candidates.map(toInstrumentSummary);
  return candidates.length === 0
    ? { code, message: miss.message }
    : { code, message: miss.message, candidates };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entitlement (rule 2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface FieldGate {
  /** The fields that may be read, in request order. */
  allowed: FieldId[];
  /** field → reason, for every denied field (ENTL-05). */
  denied: Map<FieldId, ReasonCode>;
  /** field → the tier it is served at. */
  tierOf: Map<FieldId, Tier>;
  notes: EntitlementNote[];
  effectiveTier: Tier;
}

/**
 * Entitlement runs **once** per request, over `securities × fields × tier × usage`, before any
 * service read. The decision is per *field*, not per `(security, field)` pair: a firm is entitled to
 * a field of a *source*, and the instrument only selects which source governs — so one evaluation
 * governs every result in the response, which is also what keeps it one `access_log` write
 * (ENTL-04) instead of `securities × fields` of them.
 */
async function gateFields(
  deps: DispatcherDeps,
  kind: DataKind,
  defs: readonly FieldDef[],
  assetClass: AssetClass | null,
  instrumentId: number | null,
  requestedTier: Tier,
  usage: UsageType,
): Promise<FieldGate> {
  const ids = defs.map((d) => d.id);
  const gate: FieldGate = {
    allowed: [],
    denied: new Map(),
    tierOf: new Map(),
    notes: [],
    effectiveTier: requestedTier,
  };

  if (deps.entitlement === undefined || deps.caller === undefined) {
    // No evaluator or no caller: NOTHING is served. A field that cannot be proved licensed is
    // denied with a reason (WP-07), which is what `ws/gateway.ts`'s `denyAllEntitlements` default
    // already does. Serving everything here would make a forgotten dependency — not a decision —
    // the thing that switches entitlements off, and it would look exactly like a decision in which
    // everything was allowed. A deployment that genuinely wants no entitlements passes an explicit
    // allow-all port; it does not omit one.
    for (const id of ids) gate.denied.set(id, 'NO_FIRM_ENTITLEMENT');
    gate.notes = ids.map((id) => ({
      fieldId: id,
      decision: 'deny' as const,
      effectiveTier: null,
      reason: 'NO_FIRM_ENTITLEMENT' as const,
    }));
    return gate;
  }

  const decision = await deps.entitlement.evaluate({
    userId: deps.caller.userId,
    firmId: deps.caller.firmId,
    sessionId: deps.caller.sessionId,
    instrumentId,
    assetClass,
    fieldIds: ids,
    tier: requestedTier,
    usage,
    purpose: `data.${kind}`,
    traceId: deps.traceId,
  });

  for (const field of decision.fields) {
    if (field.decision === 'deny') {
      gate.denied.set(field.fieldId, field.reason);
    } else {
      gate.allowed.push(field.fieldId);
      gate.tierOf.set(field.fieldId, field.effectiveTier ?? requestedTier);
    }
    if (field.decision !== 'allow') {
      gate.notes.push({
        fieldId: field.fieldId,
        decision: field.decision,
        effectiveTier: field.effectiveTier,
        reason: field.reason,
      });
    }
  }
  // A field the evaluator did not rule on is not silently served.
  for (const id of ids) {
    if (!gate.tierOf.has(id) && !gate.denied.has(id)) gate.denied.set(id, 'NO_FIRM_ENTITLEMENT');
  }
  gate.effectiveTier = decision.effectiveTier ?? lowestTier([...gate.tierOf.values()]);
  return gate;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Alignment (CHRT-03) and fill
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `calendarAlign` decides which index the blocks of a multi-security request share (CHRT-03):
 *
 * - `primary` — every block keeps its own index. Two names on different calendars come back with
 *   different `index` arrays: right for two charts, wrong for one;
 * - `union` — every session either name traded. A name that did not trade gets `null`, or the
 *   previous value when `fill: 'prev'`;
 * - `intersection` — only sessions on which *every* name traded. The honest index for a ratio: a
 *   spread against a day one leg did not trade is not a spread.
 *
 * Returns `null` when no re-indexing is needed, so the common single-security case does no work.
 */
export function alignIndexes(
  indexes: readonly (readonly string[])[],
  mode: 'primary' | 'union' | 'intersection',
): string[] | null {
  if (mode === 'primary' || indexes.length <= 1) return null;
  const present = indexes.filter((ix) => ix.length > 0);
  if (present.length === 0) return null;
  if (mode === 'union') {
    const all = new Set<string>();
    for (const ix of present) for (const k of ix) all.add(k);
    return [...all].sort();
  }
  const [first, ...rest] = present;
  const sets = rest.map((ix) => new Set(ix));
  return [...(first ?? [])].filter((k) => sets.every((s) => s.has(k))).sort();
}

/** Re-index one block onto `target`, carrying values forward when the request asked for it. */
export function reindex(
  block: { index: string[]; rows: (number | null)[][]; columns: FieldId[] },
  target: readonly string[],
  fill: 'none' | 'prev',
): void {
  const width = block.columns.length;
  const byKey = new Map<string, (number | null)[]>();
  for (const [i, key] of block.index.entries()) byKey.set(key, block.rows[i] ?? blankRow(width));

  const rows: (number | null)[][] = [];
  let previous: (number | null)[] | undefined;
  for (const key of target) {
    const hit = byKey.get(key);
    if (hit !== undefined) {
      rows.push(hit);
      previous = hit;
    } else if (fill === 'prev' && previous !== undefined) {
      rows.push([...previous]);
    } else {
      rows.push(blankRow(width));
    }
  }
  block.index = [...target];
  block.rows = rows;
}

function blankRow(width: number): (number | null)[] {
  return Array.from({ length: width }, () => null);
}

/** `fill: 'prev'` on a single block: carry the last non-null value of each column forward. */
export function fillForward(block: { rows: (number | null)[][]; columns: FieldId[] }): void {
  const last: (number | null)[] = blankRow(block.columns.length);
  for (const row of block.rows) {
    for (let j = 0; j < row.length; j += 1) {
      const v = row[j];
      if (v === null || v === undefined) row[j] = last[j] ?? null;
      else last[j] = v;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Subjects (API.md §6.1) — `kind:'realtime'`
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Which subject a security maps onto for `kind:'realtime'`. `q`, `b1m` and `oc` are keyed by
 * `instrumentId`; `l` is keyed by an **`mdLineId`**, so it needs the instrument's lines and returns
 * `null` for one that has none — the caller then gets `SUBJECT_UNKNOWN` rather than a subject
 * nothing will ever publish on.
 */
export function subjectFor(
  instrument: InstrumentSummary,
  subjectKind: 'q' | 'l' | 'b1m' | 'oc',
): string | null {
  if (subjectKind !== 'l') return `${subjectKind}:${instrument.instrumentId}`;
  const line = instrument.mdLineIds[0];
  return line === undefined ? null : `l:${line}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The dispatcher
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Resolved {
  security: SecurityRefInput;
  instrument: ResolveCandidate | null;
  error?: NonNullable<DataResult['error']>;
}

/**
 * Routes one `DataRequest` to the right `data/*` service and returns the documented
 * `DataResponse`.
 *
 * One instance serves one request: it holds the provenance collector and the accumulated `meta`
 * notes, so `dispatch()` is not re-entrant. Build one per request with {@link createDispatcher}.
 */
export class DataDispatcher {
  private readonly resolver: SecurityResolver;
  private readonly tiers: Tier[] = [];
  private readonly states: ValueState[] = [];
  private readonly unavailable: UnavailableNote[] = [];
  private readonly engines: EngineNote[] = [];
  private readonly adjustments: AdjustmentStep[] = [];

  constructor(private readonly deps: DispatcherDeps) {
    this.resolver = deps.resolver ?? new SecurityResolver(deps.tx);
  }

  /**
   * Parse, resolve, gate, fetch, assemble.
   *
   * Throws `AppError` for the whole-request failures of API.md §2 (`VALIDATION_FAILED`,
   * `FIELD_UNKNOWN`, `ENTITLEMENT_DENIED`, `QUOTA_EXCEEDED`) and reports every per-security failure
   * inside `results[i].error`, leaving the response `200` (rule 1).
   */
  async dispatch(input: DataRequestInput): Promise<DataResponse> {
    const parsed = DataRequest.safeParse(input);
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', 'the data request is not well formed', {
        details: { location: 'body', issues: parsed.error.issues },
      });
    }
    const req = parsed.data;
    const at = effectiveAsOf(req.asOf, this.deps.clock);
    const defs = requireFields(req.fields);
    const usage = this.deps.caller?.usage ?? req.usage;
    const requestedTier = this.requestedTier(req);

    const resolved = await this.resolveAll(req.securities, at);
    const hits = resolved.filter(
      (r): r is Resolved & { instrument: ResolveCandidate } => r.instrument !== null,
    );

    // Rule 2 — one evaluation, before any service read. The lead instrument supplies the asset
    // class that selects which source governs each field.
    const lead = hits[0]?.instrument ?? null;
    const gate = await gateFields(
      this.deps,
      req.kind,
      defs,
      lead?.assetClass ?? null,
      lead?.instrumentId ?? null,
      requestedTier,
      usage,
    );
    if (gate.allowed.length === 0) {
      throw new AppError(
        'ENTITLEMENT_DENIED',
        `no requested field is servable at tier '${requestedTier}' for usage '${usage}'`,
        { details: { reasons: gate.notes } },
      );
    }

    const instrumentIds = hits.map((h) => h.instrument.instrumentId);
    if (this.deps.quota !== undefined) {
      await this.deps.quota.reserve({
        kind: req.kind,
        purpose: `data.${req.kind}`,
        instrumentIds,
        dataPoints: upperBound(req, instrumentIds.length, gate.allowed.length),
      });
    }

    const results = await this.fetch(req, at, resolved, gate, defs);

    const dataPointsCharged = countDataPoints(req.kind, results);
    const uniqueInstrumentsAdded =
      this.deps.quota === undefined
        ? new Set(instrumentIds).size
        : await this.deps.quota.settle({
            kind: req.kind,
            purpose: `data.${req.kind}`,
            instrumentIds,
            dataPoints: dataPointsCharged,
          });

    return {
      meta: await this.buildMeta(at, gate, req.kind, {
        dataPointsCharged,
        uniqueInstrumentsAdded,
      }),
      results,
    };
  }

  /**
   * The tier the request asks for. `realtime` may name one; `reference` takes the session ceiling;
   * the three stored-history kinds are `'eod'` by construction — a bar that closed cannot be served
   * at a tier that implies it is still moving.
   */
  private requestedTier(req: DataRequest): Tier {
    if (req.kind === 'realtime') return req.tier ?? this.deps.caller?.tier ?? 'delayed';
    if (req.kind === 'reference') return this.deps.caller?.tier ?? 'delayed';
    return 'eod';
  }

  // ── resolution (rule 1) ───────────────────────────────────────────────────────────────────

  private async resolveAll(securities: readonly SecurityRefInput[], at: AsOf): Promise<Resolved[]> {
    const out: Resolved[] = [];
    for (const security of securities) {
      if ('formula' in security) {
        // CHRT-07 computed series are evaluated by `core/formula` over the results of other
        // `DataRequest`s. They have no security-master row, so the dispatcher names the reason
        // rather than inventing an instrument for them.
        out.push({
          security,
          instrument: null,
          error: {
            code: 'NOT_IN_UNIVERSE',
            message:
              `'${security.formula}' is a computed series (CHRT-07): it is evaluated by the ` +
              'formula engine over resolved securities, not read from /data directly',
          },
        });
        continue;
      }
      const input = 'id' in security ? { id: security.id } : security.ref;
      const result = await this.resolver.resolve(input, at);
      out.push(
        result.ok
          ? { security, instrument: result.instrument }
          : { security, instrument: null, error: errorOf(result) },
      );
    }
    return out;
  }

  // ── dispatch ──────────────────────────────────────────────────────────────────────────────

  private fetch(
    req: DataRequest,
    at: AsOf,
    resolved: readonly Resolved[],
    gate: FieldGate,
    defs: readonly FieldDef[],
  ): Promise<DataResult[]> {
    switch (req.kind) {
      case 'reference':
        return this.records(req, resolved, gate, defs);
      case 'realtime':
        return this.records(req, resolved, gate, defs);
      case 'historical':
        return this.series(req, at, resolved, gate);
      case 'intraday':
        return this.series(req, at, resolved, gate);
      case 'tick':
        return this.ticks(req, resolved, gate);
    }
  }

  // ── kind:'reference' and kind:'realtime' ──────────────────────────────────────────────────

  /**
   * The two record-shaped kinds. They differ only in which reader answers: `reference` reads the
   * master (rule 4 sends `pit` fields to `knownAt`), `realtime` costs one plant `snapshotMany()`
   * (rule 6) and additionally names the subject the caller should subscribe to.
   */
  private async records(
    req: Extract<DataRequest, { kind: 'reference' | 'realtime' }>,
    resolved: readonly Resolved[],
    gate: FieldGate,
    defs: readonly FieldDef[],
  ): Promise<DataResult[]> {
    const ids = idsOf(resolved);
    const cells: CellsByInstrument =
      ids.length === 0
        ? new Map<number, Record<string, ValueCell>>()
        : req.kind === 'reference'
          ? await this.deps.sources.referenceFields(ids, gate.allowed)
          : await this.deps.sources.snapshotFields(ids, gate.allowed, gate.effectiveTier);

    return resolved.map((r) =>
      this.recordResult(
        r,
        cells,
        gate,
        defs,
        req.kind === 'realtime' ? req.subjectKind : undefined,
      ),
    );
  }

  private recordResult(
    r: Resolved,
    cells: CellsByInstrument,
    gate: FieldGate,
    defs: readonly FieldDef[],
    subjectKind: 'q' | 'l' | 'b1m' | 'oc' | undefined,
  ): DataResult {
    if (r.instrument === null) return this.missResult(r, gate);

    const summary = toInstrumentSummary(r.instrument);
    const row = cells.get(r.instrument.instrumentId);
    const fields: Record<string, FieldValue> = {};
    const reasons: Record<string, ReasonCode> = {};
    const fts: Record<string, string> = {};
    const fprov: Record<string, number> = {};
    const states: ValueState[] = [];
    let sourceTs: string | null = null;

    for (const def of defs) {
      const denial = gate.denied.get(def.id);
      if (denial !== undefined) {
        // ENTL-05: a denied field is null with its reason, never a number and never absent.
        fields[def.id] = null;
        reasons[def.id] = denial;
        states.push('blank');
        continue;
      }
      if (!applies(def, r.instrument.assetClass)) {
        // Not a denial and not a gap: the field has no meaning here (a bid on an index with no
        // book). `na` is its own verdict precisely so a screen does not draw it as missing data.
        fields[def.id] = null;
        states.push('na');
        this.noteUnavailable({
          field: def.id,
          reason: 'NOT_APPLICABLE',
          detail: `${def.id} does not apply to ${r.instrument.assetClass} instruments`,
        });
        continue;
      }
      const cell = row?.[def.id];
      if (cell === undefined) {
        fields[def.id] = null;
        states.push('blank');
        this.noteUnavailable({
          field: def.id,
          reason: 'NO_SOURCE',
          detail: `no stored value for ${def.id} on ${summary.display}`,
        });
        continue;
      }
      fields[def.id] = cell.v;
      states.push(cell.st);
      if (cell.v === null && cell.r !== undefined) reasons[def.id] = cell.r;
      if (cell.ts !== undefined && cell.ts !== null) {
        const iso = new Date(cell.ts).toISOString();
        fts[def.id] = iso;
        if (sourceTs === null || iso > sourceTs) sourceTs = iso;
      }
      fprov[def.id] = cell.provIdx;
    }

    const st = worstState(states.length === 0 ? ['blank'] : states);
    const tier = gate.effectiveTier;
    this.states.push(st);
    this.tiers.push(tier);

    const served = new Date(this.deps.clock.now()).toISOString();
    const result: DataResult = {
      security: r.security,
      instrument: summary,
      fields,
      tier,
      st,
      // FEED-05: `cap`/`pub` are this response's instants; `src` is the newest provider time cited.
      ts: { src: sourceTs, cap: served, pub: served },
    };
    if (Object.keys(reasons).length > 0) result.r = reasons;
    if (Object.keys(fts).length > 0) result.fts = fts;
    if (Object.keys(fprov).length > 0) result.fprov = fprov;

    if (subjectKind !== undefined) {
      const subject = subjectFor(summary, subjectKind);
      if (subject === null) {
        result.st = 'blank';
        result.r = { ...(result.r ?? {}), ...blanket(gate.allowed, 'SUBJECT_UNKNOWN') };
      } else {
        // Rule 6: a cold subject is added to the hot set and answers blank only if the
        // read-through failed, which is what the reader reports as `st:'blank'`.
        result.subject = {
          subject,
          fields: gate.allowed,
          tier,
          reason: st === 'blank' ? 'PROVIDER_DOWN' : 'OK',
        };
      }
    }
    return result;
  }

  // ── kind:'historical' and kind:'intraday' ─────────────────────────────────────────────────

  private async series(
    req: Extract<DataRequest, { kind: 'historical' | 'intraday' }>,
    at: AsOf,
    resolved: readonly Resolved[],
    gate: FieldGate,
  ): Promise<DataResult[]> {
    const blocks = new Map<number, SeriesOut>();
    for (const r of resolved) {
      if (r.instrument === null) continue;
      const id = r.instrument.instrumentId;
      if (blocks.has(id)) continue;
      blocks.set(id, await this.readSeries(req, at, id, gate));
    }

    // CHRT-03 — one shared index across the blocks, when the request asked for one.
    const fill = req.kind === 'historical' ? req.fill : 'none';
    const align = req.kind === 'historical' ? req.calendarAlign : 'primary';
    const ordered = [...blocks.values()];
    const target = alignIndexes(
      ordered.map((b) => b.index),
      align,
    );
    for (const block of ordered) {
      if (target !== null) reindex(block, target, fill);
      else if (fill === 'prev') fillForward(block);
    }

    return resolved.map((r) => {
      if (r.instrument === null) return this.missResult(r, gate);
      const summary = toInstrumentSummary(r.instrument);
      const block = blocks.get(r.instrument.instrumentId);
      if (block === undefined) {
        this.states.push('blank');
        this.tiers.push(gate.effectiveTier);
        return {
          security: r.security,
          instrument: summary,
          tier: gate.effectiveTier,
          st: 'blank' as const,
        };
      }
      for (const step of block.adjustments ?? []) this.noteAdjustment(step);
      for (const engine of block.engines ?? []) this.noteEngine(engine);

      const series: SeriesBlock = {
        columns: block.columns,
        index: block.index,
        rows: block.rows,
        currency: block.currency,
        provIdx: block.provIdx,
      };
      if (block.adjust !== undefined) series.adjust = block.adjust;
      else if (req.kind === 'historical') series.adjust = req.adjust;

      const st = block.st ?? (block.index.length === 0 ? 'blank' : 'closed');
      const tier = block.tier ?? 'eod';
      this.states.push(st);
      this.tiers.push(tier);
      return { security: r.security, instrument: summary, series, tier, st };
    });
  }

  private readSeries(
    req: Extract<DataRequest, { kind: 'historical' | 'intraday' }>,
    at: AsOf,
    instrumentId: number,
    gate: FieldGate,
  ): Promise<SeriesOut> {
    if (req.kind === 'historical') {
      const q: HistoricalQuery = {
        start: req.start,
        // API.md L307: `end` defaults to `validAt`'s date, not to today — a past-dated read must
        // not silently extend to now.
        end: req.end ?? utcDate(at.validAt),
        periodicity: req.periodicity,
        adjust: req.adjust,
        fields: gate.allowed,
        ...(req.currency === undefined ? {} : { currency: req.currency }),
      };
      return this.deps.sources.historical(instrumentId, q);
    }
    return this.deps.sources.intraday(instrumentId, {
      start: req.start,
      end: req.end ?? at.validAt.toISOString(),
      interval: req.interval,
      session: req.session,
      fields: gate.allowed,
    });
  }

  // ── kind:'tick' (rule 5) ──────────────────────────────────────────────────────────────────

  private async ticks(
    req: Extract<DataRequest, { kind: 'tick' }>,
    resolved: readonly Resolved[],
    gate: FieldGate,
  ): Promise<DataResult[]> {
    const out: DataResult[] = [];
    for (const r of resolved) {
      if (r.instrument === null) {
        out.push(this.missResult(r, gate));
        continue;
      }
      const page = await this.deps.sources.ticks(r.instrument.instrumentId, {
        start: req.start,
        end: req.end,
        kinds: req.kinds,
        limit: req.limit,
        fields: gate.allowed,
        ...(req.cursor === undefined ? {} : { cursor: req.cursor }),
      });
      const st = page.st ?? (page.ticks.length === 0 ? 'blank' : 'closed');
      const tier = page.tier ?? 'eod';
      this.states.push(st);
      this.tiers.push(tier);
      out.push({
        security: r.security,
        instrument: toInstrumentSummary(r.instrument),
        ticks: page.ticks,
        nextCursor: page.nextCursor,
        tier,
        st,
      });
    }
    return out;
  }

  // ── shared ────────────────────────────────────────────────────────────────────────────────

  /** A security that did not resolve: `instrument: null`, the error, a blank cell (rule 1). */
  private missResult(r: Resolved, gate: FieldGate): DataResult {
    this.states.push('blank');
    this.tiers.push(gate.effectiveTier);
    const result: DataResult = {
      security: r.security,
      instrument: null,
      tier: gate.effectiveTier,
      st: 'blank',
    };
    if (r.error !== undefined) result.error = r.error;
    return result;
  }

  private noteUnavailable(note: UnavailableNote): void {
    if (this.unavailable.some((n) => n.field === note.field && n.reason === note.reason)) return;
    this.unavailable.push(note);
  }

  private noteEngine(engine: EngineNote): void {
    const held = this.engines.some(
      (e) =>
        e.name === engine.name &&
        e.version === engine.version &&
        e.inputsHash === engine.inputsHash,
    );
    if (!held) this.engines.push(engine);
  }

  private noteAdjustment(step: AdjustmentStep): void {
    const held = this.adjustments.some(
      (s) =>
        s.beforeDate === step.beforeDate &&
        s.kind === step.kind &&
        s.priceFactor === step.priceFactor,
    );
    if (!held) this.adjustments.push(step);
  }

  private async buildMeta(
    at: AsOf,
    gate: FieldGate,
    kind: DataKind,
    quota: { dataPointsCharged: number; uniqueInstrumentsAdded: number },
  ): Promise<Meta> {
    const prov = this.deps.prov;
    const cited = prov.size > 0;
    const meta: Meta = {
      traceId: this.deps.traceId,
      asOf: { validAt: at.validAt.toISOString(), knownAt: at.knownAt.toISOString() },
      // FUNCTIONS runner step 8: the collector answers both, because it is the only object that
      // saw every cited row. With nothing cited there is nothing to be lowest or worst *of*, so
      // the request's own verdicts stand.
      tier: lowestTier(cited ? [prov.lowestTier(), ...this.tiers] : this.tiers),
      staleness: worstState(
        cited
          ? [prov.worstState(), ...this.states]
          : this.states.length === 0
            ? ['blank']
            : this.states,
      ),
      provenance: await withAttribution(this.deps.tx, at, prov.list()),
      entitlement: gate.notes,
      unavailable: this.unavailable,
      engines: this.engines,
      servedAt: new Date(this.deps.clock.now()).toISOString(),
      quota,
    };
    // REF-09 — `adjustments` belongs to a historical read and is present there even when empty, so
    // "no split was applied" is distinguishable from "adjustment does not apply to this kind".
    if (kind === 'historical') meta.adjustments = this.adjustments;
    return meta;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function idsOf(resolved: readonly Resolved[]): number[] {
  const ids: number[] = [];
  for (const r of resolved) {
    if (r.instrument !== null && !ids.includes(r.instrument.instrumentId)) {
      ids.push(r.instrument.instrumentId);
    }
  }
  return ids;
}

/** `assetClasses: []` marks a subject-only field (`n:`, `c:`, `e:`, `sys:`): applicable anywhere. */
function applies(def: FieldDef, assetClass: AssetClass): boolean {
  return def.assetClasses.length === 0 || def.assetClasses.includes(assetClass);
}

function blanket(fields: readonly FieldId[], reason: ReasonCode): Record<string, ReasonCode> {
  const out: Record<string, ReasonCode> = {};
  for (const f of fields) out[f] = reason;
  return out;
}

/**
 * Rule 7 — what was actually charged: reference/realtime `securities × fields`, historical and
 * intraday `rows × columns`, tick `ticks.length`.
 */
export function countDataPoints(kind: DataKind, results: readonly DataResult[]): number {
  let total = 0;
  for (const r of results) {
    switch (kind) {
      case 'reference':
      case 'realtime':
        total += Object.keys(r.fields ?? {}).length;
        break;
      case 'historical':
      case 'intraday':
        total += (r.series?.rows.length ?? 0) * (r.series?.columns.length ?? 0);
        break;
      case 'tick':
        total += r.ticks?.length ?? 0;
        break;
    }
  }
  return total;
}

/**
 * The upper bound the request implies — the number checked against the limit **before** any fetch
 * (rule 7). For the series kinds the true row count is not known until the rows are read, so the
 * bound is the number of periods the window could hold; it is an over-estimate by construction,
 * which is the safe direction for a limit check.
 */
export function upperBound(req: DataRequest, securities: number, columns: number): number {
  switch (req.kind) {
    case 'reference':
    case 'realtime':
      return securities * columns;
    case 'tick':
      return securities * req.limit;
    case 'historical': {
      const step: Record<'D' | 'W' | 'M' | 'Q' | 'Y', number> = {
        D: 1,
        W: 7,
        M: 30,
        Q: 91,
        Y: 365,
      };
      const days = spanDays(req.start, req.end);
      return securities * columns * Math.max(1, Math.ceil(days / step[req.periodicity]));
    }
    case 'intraday': {
      const per: Record<'1m' | '5m' | '15m' | '1h', number> = {
        '1m': 1,
        '5m': 5,
        '15m': 15,
        '1h': 60,
      };
      return securities * columns * Math.ceil(spanMinutes(req.start, req.end) / per[req.interval]);
    }
  }
}

function spanDays(start: string, end: string | undefined): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = end === undefined ? Date.now() : Date.parse(`${end}T00:00:00Z`);
  return Math.max(1, Math.ceil((to - from) / 86_400_000) + 1);
}

function spanMinutes(start: string, end: string | undefined): number {
  const from = Date.parse(start);
  const to = end === undefined ? Date.now() : Date.parse(end);
  return Math.max(1, Math.ceil((to - from) / 60_000) + 1);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What {@link createDispatcher} needs beyond the readers it is handed. */
export interface DispatcherOptions {
  tx: Tx;
  clock: Clock;
  traceId: string;
  caller?: DataCaller;
  entitlement?: EntitlementPort;
  quota?: QuotaPort;
  /** Overrides the readers — the seam the integration tests and the function runner use. */
  sources: DataSources;
  /** The run's collector; a fresh {@link ProvenanceIndex} when omitted. */
  prov?: ProvenanceIndex;
  resolver?: SecurityResolver;
}

/**
 * One dispatcher for one request.
 *
 * `sources` is passed in rather than constructed here because the readers are built from a
 * `DataDeps { tx, asOf, prov }` and `asOf` is only known once the request has been parsed. The
 * route handler builds both together — see {@link buildDataSources}.
 */
export function createDispatcher(options: DispatcherOptions): DataDispatcher {
  const deps: DispatcherDeps = {
    tx: options.tx,
    clock: options.clock,
    traceId: options.traceId,
    sources: options.sources,
    prov: options.prov ?? new ProvenanceIndex(),
    ...(options.caller === undefined ? {} : { caller: options.caller }),
    ...(options.entitlement === undefined ? {} : { entitlement: options.entitlement }),
    ...(options.quota === undefined ? {} : { quota: options.quota }),
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
  };
  return new DataDispatcher(deps);
}

/** The `DataDeps` every reader in this package is constructed from. */
export function dataDeps(tx: Tx, asOf: AsOf, prov: ProvenanceSink): DataDeps {
  return { tx, asOf, prov };
}

export { DataRequest, ProvenanceIndex };
export type { DataRequestInput, DataResponse, DataResult, DataKind, DataDeps, ProvenanceSink };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Wiring — the concrete `data/*` services behind {@link DataSources}
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `15m` and `1h` are "resampled from 5m/1m on read" (API.md §4 L320) and `data/intraday.ts` serves
 * `1m` and `5m` only, so the base bar a coarser interval is built from is named here.
 */
const BASE_INTERVAL: Readonly<Record<'1m' | '5m' | '15m' | '1h', '1m' | '5m'>> = Object.freeze({
  '1m': '1m',
  '5m': '5m',
  '15m': '5m',
  '1h': '5m',
});

const INTERVAL_MS: Readonly<Record<'1m' | '5m' | '15m' | '1h', number>> = Object.freeze({
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
});

/** A bar block as the two bar services return it, before the dispatcher trims it. */
interface BarBlock {
  columns: FieldId[];
  index: string[];
  rows: (number | null)[][];
  rowProvIdx: number[];
  provIdx: number[];
}

/**
 * The `meta.provenance` index of row `i` of a bar block.
 *
 * `rowProvIdx` carries exactly one entry per row — that is the block's invariant, and both
 * transforms below rebuild the three arrays together. Neither `?? 0` nor "skip it" is a safe
 * reading of a missing entry: index 0 is a real citation, and skipping shifts every later row's
 * attribution by one. So a break in the invariant stops the response instead of shipping a
 * plausible one (DATA-10).
 */
function rowCitation(block: BarBlock, row: number): number {
  const idx = block.rowProvIdx[row];
  if (idx === undefined) {
    throw new Error(
      `bar block: row ${String(row)} carries no provenance index (rowProvIdx has ` +
        `${String(block.rowProvIdx.length)} entries for ${String(block.index.length)} rows)`,
    );
  }
  return idx;
}

/**
 * `data/intraday.ts` answers "the last N sessions" (`days: 1 | 2 | 5`) because that is what the
 * chart functions ask, while a `DataRequest` names an instant window. The smallest `days` that can
 * contain the window is chosen here and the block is clipped to `[start, end]` afterwards, so a
 * caller that asks for 90 minutes is not silently handed a week.
 */
export function intradayDays(start: string, end: string, now: Date): 1 | 2 | 5 {
  const from = Date.parse(start);
  const to = Number.isNaN(Date.parse(end)) ? now.getTime() : Date.parse(end);
  const span = Math.max(to, now.getTime()) - from;
  if (span <= 86_400_000) return 1;
  if (span <= 2 * 86_400_000) return 2;
  return 5;
}

/** Drop rows outside `[from, to]` (ISO instants or dates), keeping the per-row provenance aligned. */
export function clipWindow(block: BarBlock, from: string, to: string): void {
  const lo = Date.parse(from);
  const hi = Date.parse(to);
  const index: string[] = [];
  const rows: (number | null)[][] = [];
  const rowProvIdx: number[] = [];
  for (const [i, key] of block.index.entries()) {
    const t = Date.parse(key);
    if (Number.isNaN(t) || t < lo || t > hi) continue;
    index.push(key);
    rows.push(block.rows[i] ?? []);
    rowProvIdx.push(rowCitation(block, i));
  }
  block.index = index;
  block.rows = rows;
  block.rowProvIdx = rowProvIdx;
  block.provIdx = [...new Set(rowProvIdx)].sort((a, b) => a - b);
}

/** Keep only `wanted` columns, in `wanted`'s order. Columns the block does not carry are dropped. */
export function projectColumns(block: BarBlock, wanted: readonly FieldId[]): void {
  const keep: number[] = [];
  const columns: FieldId[] = [];
  for (const id of wanted) {
    const j = block.columns.indexOf(id);
    if (j >= 0) {
      keep.push(j);
      columns.push(id);
    }
  }
  block.columns = columns;
  block.rows = block.rows.map((row) => keep.map((j) => row[j] ?? null));
}

/**
 * Aggregate `toMs` buckets out of `fromMs` bars, UTC-aligned: open is the first print of the
 * bucket, high the maximum, low the minimum, last the final print and volume the sum. Any other
 * column takes the bucket's last value, which is the only aggregation that is never wrong.
 *
 * Buckets are keyed on the UTC epoch, matching how `bars_intraday.bar_ts` is stored.
 */
export function resampleBars(block: BarBlock, fromMs: number, toMs: number): void {
  if (toMs <= fromMs || block.index.length === 0) return;
  const how = block.columns.map(aggregationOf);

  const index: string[] = [];
  const rows: (number | null)[][] = [];
  const rowProvIdx: number[] = [];
  let bucket = -1;

  for (const [i, key] of block.index.entries()) {
    const t = Date.parse(key);
    if (Number.isNaN(t)) continue;
    const start = Math.floor(t / toMs) * toMs;
    const row = block.rows[i] ?? [];
    const prov = rowCitation(block, i);
    if (start !== bucket) {
      bucket = start;
      index.push(new Date(start).toISOString());
      rows.push(block.columns.map((_, j) => row[j] ?? null));
      rowProvIdx.push(prov);
      continue;
    }
    const target = rows[rows.length - 1];
    if (target === undefined) continue;
    for (let j = 0; j < how.length; j += 1) {
      target[j] = combine(how[j] ?? 'last', target[j] ?? null, row[j] ?? null);
    }
    // The bucket's citation is its LAST contributing row, which is the bar the bucket closes on.
    rowProvIdx[rowProvIdx.length - 1] = prov;
  }

  block.index = index;
  block.rows = rows;
  block.rowProvIdx = rowProvIdx;
  block.provIdx = [...new Set(rowProvIdx)].sort((a, b) => a - b);
}

type Aggregation = 'first' | 'max' | 'min' | 'last' | 'sum';

function aggregationOf(field: FieldId): Aggregation {
  switch (field) {
    case 'PX_OPEN':
      return 'first';
    case 'PX_HIGH':
      return 'max';
    case 'PX_LOW':
      return 'min';
    case 'PX_VOLUME':
      return 'sum';
    default:
      return 'last';
  }
}

function combine(how: Aggregation, held: number | null, next: number | null): number | null {
  if (next === null) return held;
  if (held === null) return how === 'first' ? null : next;
  switch (how) {
    case 'first':
      return held;
    case 'max':
      return Math.max(held, next);
    case 'min':
      return Math.min(held, next);
    case 'sum':
      return held + next;
    case 'last':
      return next;
  }
}

/** Extra inputs the readers need that the request itself does not carry. */
export interface DataSourceOptions {
  /**
   * ENTL-05 — the fields the entitlement decision refused, with the reason. `data/snapshot.ts`
   * renders them as blank cells and never reads them from the store; the dispatcher passes the
   * same map so a denied field is blank for exactly one reason, decided in one place.
   */
  denied?: ReadonlyMap<FieldId, ReasonCode>;
}

/** ANAL-08 — the engine identity `meta.engines` reports for an adjusted read (API.md §12.1). */
const ADJUST_ENGINE_VERSION = '1.0.0';

/**
 * Build the five readers from one `DataDeps`, so every read in a response shares an `asOf` pair and
 * one provenance collector.
 *
 * The adaptations here are the places where the *function-facing* service signatures
 * (FUNCTIONS.md §1.4.2, written for HP/GP/QM) and the *request-facing* `DataRequest` differ:
 *
 *  - `data/intraday.ts` answers "the last `days` sessions" at `1m`/`5m`, because that is what a
 *    chart asks; a `DataRequest` names an instant window and may ask for `15m` or `1h`. The window
 *    picks the smallest `days` that contains it, the block is clipped to the window, and `15m`/`1h`
 *    are aggregated from `5m` — which is exactly what API.md §4 L320 says happens "on read";
 *  - `historical` routes on the fields: bar fields go to `data/historical.ts`, `ECO_VALUE` goes to
 *    `data/econ.ts` at `knownAt` so the vintage in force then is the one returned (rule 3, STOR-06);
 *  - `ticks` projects each tick's `f` down to the requested fields (API.md §4 `TickRow.f` is "the
 *    requested fields present on this tick", not every column `quote_ticks` has);
 *  - `reference` and `realtime` both read through `data/snapshot.ts`, which is the one
 *    record-shaped reader: plant ∪ `eod_snapshots` ∪ master. For a reference-class field the plant
 *    contributes nothing, so the merge *is* the reference read.
 */
export function buildDataSources(deps: DataDeps, options: DataSourceOptions = {}): DataSources {
  const history = historicalService(deps);
  const intra = intradayService(deps);
  const tickReader = ticksService(deps);
  const snap = snapshotService({
    ...deps,
    ...(options.denied === undefined ? {} : { denied: options.denied }),
  });
  const econ = new EconService(deps.tx);

  const cells = (ids: readonly number[], fields: readonly FieldId[]): Promise<CellsByInstrument> =>
    snap.fields([...ids], [...fields]);

  return {
    referenceFields: cells,
    snapshotFields: (ids, fields) => cells(ids, fields),

    async historical(instrumentId, q) {
      const bars = q.fields.filter((f) => HISTORY_FIELDS.includes(f));
      if (bars.length > 0) {
        const series = await history.bars(instrumentId, {
          start: q.start,
          end: q.end,
          periodicity: q.periodicity,
          adjust: q.adjust,
          fields: bars,
          ...(q.currency === undefined ? {} : { currency: q.currency }),
        });
        const out: SeriesOut = {
          columns: series.columns,
          index: series.index,
          rows: series.rows,
          currency: series.currency,
          provIdx: series.provIdx,
          adjust: series.adjust ?? q.adjust,
          adjustments: series.adjustments,
          st: 'closed',
          tier: 'eod',
        };
        if (q.adjust !== 'unadjusted') {
          out.engines = [
            {
              name: 'adjust',
              version: ADJUST_ENGINE_VERSION,
              inputsHash: sha256Hex(
                canonicalJson({
                  instrumentId,
                  start: q.start,
                  end: q.end,
                  periodicity: q.periodicity,
                  adjust: q.adjust,
                  knownAt: deps.asOf.knownAt.toISOString(),
                  steps: series.adjustments,
                }),
              ),
            },
          ];
        }
        return out;
      }

      if (q.fields.includes('ECO_VALUE')) return econHistory(deps, econ, instrumentId, q);

      // Rule 3 names exactly what `fields` may hold on a historical read. A request for a
      // reference field over a date range is a mistake worth reporting, not an empty chart.
      throw new AppError(
        'BAD_REQUEST',
        `historical: none of [${q.fields.join(', ')}] is a bar field or ECO_VALUE; ` +
          `bar fields are ${HISTORY_FIELDS.join(', ')}`,
        { details: { fields: q.fields, barFields: [...HISTORY_FIELDS] } },
      );
    },

    async intraday(instrumentId, q) {
      const wanted = q.fields.filter((f) => INTRADAY_FIELDS.includes(f));
      if (wanted.length === 0) {
        throw new AppError(
          'BAD_REQUEST',
          `intraday: none of [${q.fields.join(', ')}] is a bar field; ` +
            `bar fields are ${INTRADAY_FIELDS.join(', ')}`,
          { details: { fields: q.fields, barFields: [...INTRADAY_FIELDS] } },
        );
      }
      const base = BASE_INTERVAL[q.interval];
      const series = await intra.bars(instrumentId, {
        days: intradayDays(q.start, q.end, deps.asOf.validAt),
        interval: base,
        session: q.session,
      });
      const block: BarBlock = {
        columns: [...series.columns],
        index: [...series.index],
        rows: series.rows.map((row) => [...row]),
        rowProvIdx: [...series.rowProvIdx],
        provIdx: [...series.provIdx],
      };
      clipWindow(block, q.start, q.end);
      if (q.interval !== base) {
        resampleBars(block, INTERVAL_MS[base], INTERVAL_MS[q.interval]);
      }
      projectColumns(block, wanted);
      return {
        columns: block.columns,
        index: block.index,
        rows: block.rows,
        currency: series.currency,
        provIdx: block.provIdx,
      };
    },

    async ticks(instrumentId, q) {
      const page = await tickReader.window(instrumentId, {
        start: q.start,
        end: q.end,
        kinds: q.kinds,
        limit: q.limit,
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
      });
      const wanted = new Set(q.fields);
      return {
        ticks: page.ticks.map((t) => ({
          capTs: t.capTs,
          srcTs: t.srcTs,
          pubTs: t.pubTs,
          kind: t.kind,
          srcSeq: t.srcSeq,
          mdLineId: t.mdLineId,
          f: Object.fromEntries(Object.entries(t.f).filter(([id]) => wanted.has(id))),
          conditions: t.conditions,
          provIdx: t.provIdx,
        })),
        nextCursor: page.nextCursor,
      };
    },
  };
}

/**
 * `kind:'historical'` on an `asset_class='econ'` instrument (rule 3): the vintages of the series,
 * read at `knownAt` so a revision published after the read instant does not appear (STOR-06). Only
 * `ECO_VALUE` is a numeric column — `ECO_PERIOD` and `ECO_VINTAGE` are strings and a `SeriesBlock`
 * carries numbers — so the block is one column wide.
 */
async function econHistory(
  deps: DataDeps,
  econ: EconService,
  instrumentId: number,
  q: HistoricalQuery,
): Promise<SeriesOut> {
  const series = await econ.seriesForInstrument(instrumentId);
  if (series === null) {
    throw new AppError(
      'NOT_IN_UNIVERSE',
      `instrument ${instrumentId} is not an econ series; ECO_VALUE has no source for it`,
      { details: { instrumentId } },
    );
  }
  const obs = await econ.observations(series.seriesCode, {
    from: q.start,
    to: q.end,
    knownAt: deps.asOf.knownAt,
  });
  const citation = await citeProvenance(
    deps.tx,
    deps.prov,
    obs.map((o) => o.provenanceId),
    { st: 'closed', tier: 'eod' },
  );
  return {
    columns: ['ECO_VALUE'],
    index: obs.map((o) => o.obsDate),
    rows: obs.map((o) => [o.value]),
    // `SeriesBlock.currency` is required and three letters, but an econ observation has *units*
    // (percent, index points, thousands of persons), not a currency. `USD` is the reporting
    // currency of the wedge; the unit a screen must label the axis with is `EconSeries.units`.
    currency: 'USD',
    provIdx: citation.provIdx,
    st: 'closed',
    tier: 'eod',
  };
}
