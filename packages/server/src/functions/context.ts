/**
 * `functions/context.ts` — the `ResolveContext` a function resolver is handed (FUNCTIONS.md §1.4.1
 * and §1.4.2, ARCHITECTURE §5.1, WORKPLAN WP-08).
 *
 * This file lands before the runner because WP-09, WP-10 and WP-11 write every resolver against
 * the shapes declared here. §1.4.1 and §1.4.2 are verbatim specifications; the interfaces below
 * are those, plus the factories that build them and the two small additions noted at each site.
 *
 * **This is the only way a resolver touches data.** A resolver receives a `ResolveContext` and
 * nothing else: no `db/client.ts`, no `getDb()`, no `withTx()`, no provider adapter, no raw plant.
 * Nothing in this module re-exports a connection-management function, so a resolver that imported
 * only from here cannot open a connection, start a transaction, or reach a provider directly —
 * and `test/unit/functions/context.test.ts` asserts that surface stays closed.
 *
 * The four collaborators, and why each one exists:
 *
 *  - `ProvenanceCollector` — every value block cites one `meta.provenance[]` index (DATA-10). It
 *    wraps WP-04's `data/reference.ts#ProvenanceIndex`, which already guarantees the idempotence
 *    (same `provenance_id` ⇒ same idx) the data services depend on, and adds the two things a
 *    function run needs on top: `addQuote(state)` for a plant citation, and the licence
 *    attribution DATA-09 requires on every screen footer and CSV header.
 *  - `UnavailableCollector` — a gap is `null` in the payload **and** a `meta.unavailable[]` entry,
 *    never a fabricated number (FUNCTIONS.md §1.3 rule 6).
 *  - `EngineCollector` — `meta.engines` (ANAL-08): name, version and `inputsHash` of every
 *    analytic that ran, so a number can be recomputed years later.
 *  - `PlantReader` — the composite snapshot with `plant/policyTier.ts#view` already applied for
 *    the caller's granted tier and the decision's denials. A resolver physically cannot read a
 *    field the user may not see: the gated state does not carry it.
 *
 * And `ReadThrough`, the freshness guarantee: `ensure(kind, key, { maxAgeMs })` promises that the
 * store is at most `maxAgeMs` old for that resource, fetching through the provider adapter only
 * when it is not — token buckets and circuit breaker shared with the scheduler, `PROVIDER_MODE`
 * honoured, replay a wall. When it cannot fetch and stale data exists the resolver is told so and
 * marks its cells `'stale'`; when it cannot fetch and nothing is stored it raises
 * `ProviderUnavailableError` (503). It never returns a number that is not in the store.
 */

import { desc, eq } from 'drizzle-orm';

import type { Role } from '@terminal/sdk/wire/rest/auth';

import type {
  AssetClass,
  Clock,
  EntitlementDecision,
  FieldId,
  Instrument,
  PayloadEngine,
  PayloadMeta,
  PayloadPage,
  PayloadProvenance,
  PayloadUnavailable,
  QuoteFields,
  QuoteState,
  ReasonCode,
  Tier,
  UnavailableReason,
  UsageType,
  ValueState,
} from '@terminal/core';

import type { CurvesService } from '../data/curves.js';
import type { EconService } from '../data/econ.js';
import type { FilingsService } from '../data/filings.js';
import type { FundamentalsService } from '../data/fundamentals.js';
import type { HistoricalService } from '../data/historical.js';
import type { HoldingsService } from '../data/holdings.js';
import type { IntradayService } from '../data/intraday.js';
import type { NewsService } from '../data/news.js';
import type { OptionsService } from '../data/options.js';
import type { PortfolioService } from '../data/portfolio.js';
import type { RatesService } from '../data/rates.js';
import { ProvenanceIndex } from '../data/reference.js';
import type { ProvenanceRef, ProvenanceSink, ReferenceService } from '../data/reference.js';
import type { SnapshotService } from '../data/snapshot.js';
import type { TicksService } from '../data/ticks.js';
import type { Db, Tx } from '../db/client.js';
import { provenance } from '../db/schema/provenance.js';
import { DEFAULT_TIER, minTier } from '../entitlements/evaluator.js';
import type { Evaluator } from '../entitlements/evaluator.js';
import type { LicenceRegistry } from '../entitlements/licenceRegistry.js';
import { ProviderUnavailableError } from '../http/errors.js';
import type { HotSet } from '../ingest/hotset.js';
import { view } from '../plant/policyTier.js';
import { formatSubject } from '../plant/subjects.js';
import type { ParsedSubject } from '../plant/subjects.js';
import type { Plant } from '../plant/tickerPlant.js';
import { insertProvenance } from '../providers/provenance.js';
import { requestKey as requestKeyFor } from '../providers/replayStore.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type {
  HttpClient,
  HttpMethod,
  NormaliseLine,
  Normalised,
  ProviderId,
  RawRecord,
} from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Provenance (DATA-10)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type { ProvenanceRef, ProvenanceSink };

/**
 * FUNCTIONS.md §1.4.2. `add` registers a `provenance` row and returns its `meta.provenance` index;
 * the same `provenanceId` always returns the same index, so citing one row from three blocks
 * produces one entry and three identical `provIdx` values.
 */
export interface ProvenanceCollector extends ProvenanceSink {
  add(ref: ProvenanceRef): number;
  /** Cite a plant snapshot: uses `state.prov`, `state.ts`, `state.state` and `state.tier`. */
  addQuote(state: QuoteState): number;
  /** `meta.provenance[]`, attribution filled from `licence_registry` (DATA-09). */
  list(): PayloadMeta['provenance'];
  /** `meta.staleness`: the worst verdict any cited row carried. */
  worstState(): ValueState;
  /** `meta.tier`: the lowest tier any cited row carried. */
  lowestTier(): Tier;
  /** Distinct rows cited so far. */
  size(): number;
}

export interface ProvenanceCollectorDeps {
  /**
   * The attribution text for a source id — `licenceRegistry.licence(id)?.attribution`. Omitted
   * leaves `attribution: ''`, which is what WP-04's bare `ProvenanceIndex` does and what
   * `data/request.ts#withAttribution` then fills in from the database.
   */
  attribution?: (sourceId: string) => string | null | undefined;
}

/**
 * The collector, over WP-04's {@link ProvenanceIndex}.
 *
 * Three behaviours are inherited deliberately rather than re-decided here, because a function's
 * `meta` and a `POST /data` response must agree field for field:
 *
 *  - **idempotence with refinement.** A second citation of the same row keeps the first index but
 *    takes the worse `st` and the lower `tier` — a plant snapshot that knows the value is stale
 *    beats a bare reference row that said nothing.
 *  - **`worstState()` severity `live < closed < na < stale < blank`.** `'closed'` is not a fault
 *    (a finished session's official print *is* the value); `'na'` says the field does not apply to
 *    this instrument, which is more of a gap than a close but less of one than a value that should
 *    have updated and did not; `'blank'` — nothing may be shown — is the worst thing a response can
 *    say. With nothing cited the answer is `'live'`: there is no stale value in a payload that
 *    cites no row.
 *  - **`lowestTier()` is `'eod'` when nothing said.** The most restrictive claim available, never
 *    an overstatement of what the caller was served.
 */
export function provenanceCollector(deps: ProvenanceCollectorDeps = {}): ProvenanceCollector {
  const index = new ProvenanceIndex();
  const attribution = deps.attribution;

  return {
    add(ref: ProvenanceRef): number {
      return index.add(ref);
    },

    addQuote(state: QuoteState): number {
      const ref: ProvenanceRef = {
        sourceId: state.prov.sourceId,
        provenanceId: state.prov.provenanceId,
        capturedAt: new Date(state.ts.cap),
        sourceTs: state.ts.src === null ? null : new Date(state.ts.src),
        st: state.state,
        tier: state.tier,
      };
      return index.add(ref);
    },

    list(): PayloadProvenance[] {
      const rows = index.list();
      if (attribution === undefined) return rows;
      return rows.map((row) => ({ ...row, attribution: attribution(row.sourceId) ?? '' }));
    },

    worstState: () => index.worstState(),
    lowestTier: () => index.lowestTier(),
    size: () => index.size,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Unavailable and engines
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** FUNCTIONS.md §1.3 rule 6: a gap is `null` **and** an entry here, never a fabricated number. */
export interface UnavailableCollector {
  add(n: { field: string; reason: UnavailableReason; detail: string }): void;
  list(): PayloadMeta['unavailable'];
}

/**
 * Entries are de-duplicated on `(field, reason)` and keep the first `detail`: a column that is
 * `NO_SOURCE` for two hundred rows is one gap reported once, not two hundred lines of `meta`.
 */
export function unavailableCollector(): UnavailableCollector {
  const seen = new Set<string>();
  const rows: PayloadUnavailable[] = [];
  return {
    add(n): void {
      const key = `${n.field}|${n.reason}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ field: n.field, reason: n.reason, detail: n.detail });
    },
    list: () => rows.map((r) => ({ ...r })),
  };
}

/** ANAL-08: `meta.engines`. `inputsHash = sha256Hex(canonicalJson(inputs))`. */
export interface EngineCollector {
  add(e: { name: string; version: string; inputsHash: string }): void;
  list(): PayloadMeta['engines'];
}

/**
 * De-duplicated on all three fields. The same engine run twice over the same inputs is one entry;
 * the same engine over different inputs is two, because two different numbers were produced and
 * both must be reproducible.
 */
export function engineCollector(): EngineCollector {
  const seen = new Set<string>();
  const rows: PayloadEngine[] = [];
  return {
    add(e): void {
      const key = `${e.name}|${e.version}|${e.inputsHash}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ name: e.name, version: e.version, inputsHash: e.inputsHash });
    },
    list: () => rows.map((r) => ({ ...r })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PlantReader (BUS-01, BUS-06, ENTL-05)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A `QuoteState` that has been through `plant/policyTier.ts#view`.
 *
 * FUNCTIONS.md §1.4.2 says "denied fields null". `QuoteFields` types every member as an optional
 * `number`/`string`/`boolean`, so a literal `null` there would be a lie to the type system and a
 * `state.fields.PX_LAST` that type-checks as a number but is not one. The honest projection is
 * therefore: **a field the caller may not see is absent from `fields` and `fieldTs`, and present in
 * `r` with the reason it is blank.** Reading it yields `undefined` — never a number, and never a
 * stale higher-tier value (ENTL-05). `r` is the same partial record the wire `snap.r` carries, so a
 * screen and a function payload render the same blank for the same reason.
 */
export interface GatedQuoteState extends QuoteState {
  /** Reason per field that is **not served**. A served field never appears here. */
  r: Record<FieldId, ReasonCode>;
}

/** FUNCTIONS.md §1.4.2. Composite snapshots, entitlement-filtered. */
export interface PlantReader {
  /** `'q:42'`, `'b1m:42'`, `'oc:42'`. */
  subjectFor(instrumentId: number, kind?: 'q' | 'b1m' | 'oc'): string;
  /** The gated composite, or `undefined` when the plant holds no such subject. */
  snapshot(subject: string): GatedQuoteState | undefined;
  snapshotMany(subjects: readonly string[]): Map<string, GatedQuoteState>;
  /** Add to the hot set (ARCHITECTURE §6.2) so the poller keeps it fresh. Never blocks. */
  ensureHot(subjects: readonly string[]): void;
}

/** What the reader needs to know about the caller before it may show a number. */
export interface PlantGate {
  /** The tier the entitlement decision granted; `'eod'` freezes every field on the official close. */
  tier: Tier;
  /** Fields the decision refused, with the reason (ENTL-05). Read live: denials may accumulate. */
  denied: ReadonlyMap<FieldId, ReasonCode>;
}

export interface PlantReaderDeps {
  plant: Plant;
  /** `ensureHot` is a no-op without one — a unit context has no poller to ask. */
  hotset?: HotSet;
  /** Read on every call, so a mid-resolve `ctx.entitle()` denial closes the gate immediately. */
  gate: () => PlantGate;
}

/**
 * The reader over WP-06's plant.
 *
 * Every read goes through `policyTier.view(state, tier, { fieldIds, eod, denied })`, the one
 * projection the WebSocket gateway also uses — so a field a subscriber may not see over the wire is
 * a field a function may not see either, decided by the same code rather than by two that agree
 * today. `fieldIds` is whatever the composite actually holds: a function asks for a snapshot, not
 * for a subscription field set, and nothing outside the composite can be invented anyway.
 */
export function plantReader(deps: PlantReaderDeps): PlantReader {
  const { plant, hotset, gate } = deps;

  const project = (state: QuoteState): GatedQuoteState => {
    const { tier, denied } = gate();
    const fieldIds: readonly FieldId[] = Object.keys(state.fields);
    const projected = view(state, tier, { fieldIds, eod: plant.eodView(state.subject), denied });

    const fields: QuoteFields = {};
    const fieldTs: QuoteState['fieldTs'] = {};
    for (const id of fieldIds) {
      const value = projected.fields[id];
      if (value === undefined || value === null) continue;
      (fields as Record<string, unknown>)[id] = value;
      const ts = projected.fieldTs[id];
      if (ts !== undefined) (fieldTs as Record<string, number>)[id] = ts;
    }

    return {
      ...state,
      tier: projected.tier,
      fields,
      fieldTs,
      ts: projected.ts,
      state: projected.state,
      session: projected.session,
      r: projected.r,
    };
  };

  return {
    subjectFor(instrumentId, kind = 'q') {
      const parsed: ParsedSubject =
        kind === 'q'
          ? { family: 'q', instrumentId }
          : kind === 'b1m'
            ? { family: 'b1m', instrumentId }
            : { family: 'oc', instrumentId };
      return formatSubject(parsed);
    },

    snapshot(subject) {
      const state = plant.snapshot(subject);
      return state === undefined ? undefined : project(state);
    },

    snapshotMany(subjects) {
      const out = new Map<string, GatedQuoteState>();
      for (const [subject, state] of plant.snapshotMany([...subjects])) {
        out.set(subject, project(state));
      }
      return out;
    },

    /**
     * Hold each subject for the hot set's decay window (5 min) without pinning it for ever: a
     * `subscribe`/`unsubscribe` pair leaves the entry present with a fresh retention deadline,
     * which is exactly "somebody looked at this, keep polling it for a while". Pinning it with a
     * bare `subscribe` would leak a hold no resolver is alive to release. Synchronous and
     * in-memory: it never blocks the resolve.
     */
    ensureHot(subjects) {
      if (hotset === undefined) return;
      for (const subject of subjects) {
        hotset.subscribe(subject);
        hotset.unsubscribe(subject);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ReadThrough (PROVIDERS.a §2.4, §2.6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** FUNCTIONS.md §1.4.2 — the resources an interactive read may refresh on demand. */
export type ReadThroughKind =
  | 'sec.submissions'
  | 'sec.companyfacts'
  | 'sec.nport'
  | 'cboe.quote'
  | 'cboe.options'
  | 'yahoo.intraday'
  | 'yahoo.daily'
  | 'yahoo.fx'
  | 'coingecko.simple'
  | 'fred.series'
  | 'nyfed.rates'
  | 'finra.shortInterest'
  | 'bbg.rss'
  | 'fed.rss';

export interface ReadThroughResult {
  /** `true` when the store is within `maxAgeMs` — after a fetch, or without one. */
  fresh: boolean;
  /** The `provenance` row the answer rests on; `null` only when nothing is stored. */
  provenanceId: number | null;
  capturedAt: Date | null;
}

export interface ReadThrough {
  ensure(
    kind: ReadThroughKind,
    key: string,
    opts: { maxAgeMs: number },
  ): Promise<ReadThroughResult>;
}

/** 503, from the error hierarchy — re-exported so a resolver needs no second import. */
export { ProviderUnavailableError };

/** What a route's `persist` hook is handed after a successful fetch. */
export interface ReadThroughPersistArgs<Rows> {
  /** The savepoint the provenance row was written in; rows must go through this handle. */
  tx: Tx;
  raw: RawRecord;
  provenanceId: number;
  normalised: Normalised<Rows>;
  key: string;
  /** `raw.capturedAt` — FEED-05 `cap`, and the only instant a persisted row may stamp. */
  capturedAt: number;
}

/**
 * How one {@link ReadThroughKind} is fetched.
 *
 * The route is the small bridge between "a resolver wants `yahoo.daily` for `AAPL`" and the
 * adapter, which speaks its own request type and knows nothing about kinds. It is **injected**,
 * not hard-coded here: the URL shapes and the per-source row writers belong to WP-05's adapters
 * and jobs, and duplicating them in WP-08 would give the system two places to be wrong about where
 * SEC company facts live.
 *
 * `url(key)` must be the URL `adapter.fetch` will build for `request(key)`; it is what the
 * freshness probe hashes into a `provenance.request_key`. A route whose `url` disagrees with its
 * adapter costs an avoidable fetch on every call — never a wrong answer, because the answer after
 * a fetch comes from the `RawRecord`'s own key.
 */
export interface ReadThroughRoute<Req = unknown, Rows = unknown> {
  providerId: ProviderId;
  /** The adapter request for this key. */
  request(key: string): Req;
  /** The canonical URL that request hits — the store probe. */
  url(key: string): string;
  /** Default `'GET'`. */
  method?: HttpMethod;
  /** POST bodies (OpenFIGI-shaped adapters). Participates in the request key byte for byte. */
  body?(key: string): string | undefined;
  /** Default: the adapter's own `adapterVersion`. */
  adapterVersion?: string;
  /** `md_lines` by `provider_symbol` for `normalise`. Omitted ⇒ an empty map, so no plant update. */
  lines?(key: string, tx: Tx): Promise<ReadonlyMap<string, NormaliseLine>>;
  /**
   * Write the normalised rows. Omitted ⇒ the exchange is recorded in `provenance` and nothing
   * else: honest, and the only thing a generic runner can do with a typed row set it cannot name.
   */
  persist?(args: ReadThroughPersistArgs<Rows>): Promise<void> | void;
}

/** A route of unknown request and row types — what the table stores (cf. `ProviderRegistry`). */
export type AnyReadThroughRoute = ReadThroughRoute<unknown, unknown>;

/** The injected `kind → route` table. */
export class ReadThroughRoutes {
  readonly #routes = new Map<ReadThroughKind, AnyReadThroughRoute>();

  /**
   * Add a route. Generic so a concrete `ReadThroughRoute<Req, Rows>` keeps its types at the call
   * site; stored erased, exactly as `ProviderRegistry.register` stores adapters, because a table of
   * heterogeneous routes has no other honest shape.
   */
  register<Req, Rows>(kind: ReadThroughKind, route: ReadThroughRoute<Req, Rows>): this {
    if (this.#routes.has(kind)) throw new Error(`read-through route '${kind}' is already registered`);
    this.#routes.set(kind, route);
    return this;
  }

  get(kind: ReadThroughKind): AnyReadThroughRoute | undefined {
    return this.#routes.get(kind);
  }

  kinds(): ReadThroughKind[] {
    return [...this.#routes.keys()];
  }

  get size(): number {
    return this.#routes.size;
  }
}

/** The stored half: the one seam this module has onto Postgres. */
export interface ReadThroughStore {
  /** Newest `provenance` row for a request key, or `null`. */
  latest(requestKey: string): Promise<{ provenanceId: number; capturedAt: Date } | null>;
  /**
   * Write the provenance row for one raw exchange and, inside the same savepoint, the route's rows.
   * Returns the new `provenance_id`.
   */
  record<Rows>(args: {
    raw: RawRecord;
    adapterVersion: string;
    traceId: string;
    key: string;
    normalise(tx: Tx, provenanceId: number): Promise<Normalised<Rows>> | Normalised<Rows>;
    persist?(args: ReadThroughPersistArgs<Rows>): Promise<void> | void;
  }): Promise<number>;
}

export interface ReadThroughDeps {
  clock: Clock;
  db: Db | Tx;
  traceId: string;
  routes?: ReadThroughRoutes;
  providers?: ProviderRegistry;
  http?: HttpClient;
  /** Default: {@link dbReadThroughStore} over `db`. */
  store?: ReadThroughStore;
}

/**
 * The database-backed store.
 *
 * `record` opens a **savepoint** on the request transaction rather than importing `withTx`: a
 * provenance insert that fails (an unlicensed source, a malformed digest) rolls back the write and
 * nothing else, and this module keeps its promise of having no path to `db/client.ts` beyond the
 * `Db`/`Tx` types.
 */
export function dbReadThroughStore(db: Db | Tx): ReadThroughStore {
  return {
    async latest(key) {
      const rows = await db
        .select({ provenanceId: provenance.provenanceId, capturedAt: provenance.capturedAt })
        .from(provenance)
        .where(eq(provenance.requestKey, key))
        .orderBy(desc(provenance.capturedAt))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return { provenanceId: row.provenanceId, capturedAt: new Date(row.capturedAt) };
    },

    record(args) {
      return db.transaction(async (tx) => {
        const provenanceId = await insertProvenance(tx, args.raw, {
          adapterVersion: args.adapterVersion,
          traceId: args.traceId,
        });
        if (args.persist !== undefined) {
          const normalised = await args.normalise(tx, provenanceId);
          await args.persist({
            tx,
            raw: args.raw,
            provenanceId,
            normalised,
            key: args.key,
            capturedAt: args.raw.capturedAt,
          });
        }
        return provenanceId;
      });
    },
  };
}

/**
 * The read-through, and the one rule it follows.
 *
 * ```
 * stored within maxAgeMs                     → { fresh: true,  stored }      (no provider touched)
 * stale, a fetch is possible and succeeds    → { fresh: true,  the new row }
 * stale, a 304                               → { fresh: true,  stored }      (nothing new published)
 * stale, a fetch is impossible or fails …
 *    … and something is stored               → { fresh: false, stored }      (resolver marks 'stale')
 *    … and nothing is stored                 → throw ProviderUnavailableError (503)
 * ```
 *
 * "A fetch is impossible" covers every way this call must not reach a provider, and they are all
 * the same fact to a resolver: the circuit for the source is open (PROVIDERS.a §2.5); the source is
 * `schedulerOnly`, so the interactive path serves what the tables hold and the screen shows the age
 * (§2.6); no route, adapter, registry or HTTP client is wired for the kind. A failure to fetch —
 * a timeout, a 500, a replay-store miss behind the wall — lands in the same place: the freshest
 * thing that really exists, labelled honestly, or a 503. Never an invented number.
 */
export function readThrough(deps: ReadThroughDeps): ReadThrough {
  const store = deps.store ?? dbReadThroughStore(deps.db);

  return {
    async ensure(kind, key, opts) {
      const route = deps.routes?.get(kind);
      const probe = routeRequestKey(route, key);
      const stored = probe === null ? null : await store.latest(probe);

      const ageMs = stored === null ? Infinity : deps.clock.now() - stored.capturedAt.getTime();
      if (stored !== null && ageMs <= opts.maxAgeMs) {
        return { fresh: true, provenanceId: stored.provenanceId, capturedAt: stored.capturedAt };
      }

      const degrade = (cause: unknown, why: string): ReadThroughResult => {
        if (stored !== null) {
          return { fresh: false, provenanceId: stored.provenanceId, capturedAt: stored.capturedAt };
        }
        throw new ProviderUnavailableError(
          `${kind} '${key}' is not in the store and cannot be fetched: ${why}`,
          { cause },
        );
      };

      const { http, providers } = deps;
      if (route === undefined) return degrade(undefined, `no read-through route for '${kind}'`);
      if (providers === undefined || http === undefined) {
        return degrade(undefined, 'no provider registry or HTTP client is wired');
      }
      if (providers.isSchedulerOnly(route.providerId)) {
        return degrade(
          undefined,
          `'${route.providerId}' is scheduler-only (PROVIDERS.a §2.6); the stored rows are what ` +
            'an interactive read serves',
        );
      }
      if (http.breaker(route.providerId).state === 'open') {
        return degrade(undefined, `the circuit for '${route.providerId}' is open`);
      }

      const adapter = providers.get(route.providerId);
      if (adapter === undefined) {
        return degrade(undefined, `no adapter is registered for '${route.providerId}'`);
      }

      let raw: RawRecord;
      try {
        // `require` is the registry's own typed re-read; the route was written against this
        // adapter, and an adapter of unknown request type cannot be called any other way.
        const typed = providers.require<unknown, unknown>(route.providerId);
        raw = await typed.fetch(http, route.request(key));
      } catch (err) {
        return degrade(err, `the fetch failed (${errorText(err)})`);
      }

      // A 304 publishes nothing: no provenance row is written (PROVIDERS.a §1.3), and the store it
      // revalidated IS current — which is the freshness this call was asked for.
      if (raw.status === 304) {
        if (stored !== null) {
          return { fresh: true, provenanceId: stored.provenanceId, capturedAt: stored.capturedAt };
        }
        return degrade(undefined, 'the provider answered 304 but nothing is stored');
      }

      // Bound out of the route so the object literal below carries a function value, not a
      // method reference whose `this` would be the route (@typescript-eslint/unbound-method).
      const persist = route.persist?.bind(route);
      const provenanceId = await store.record({
        raw,
        adapterVersion: route.adapterVersion ?? adapter.adapterVersion,
        traceId: deps.traceId,
        key,
        async normalise(tx, id) {
          const lines: ReadonlyMap<string, NormaliseLine> =
            route.lines === undefined ? EMPTY_LINES : await route.lines(key, tx);
          return adapter.normalise(raw, {
            provenanceId: id,
            capturedAt: raw.capturedAt,
            lines,
          });
        },
        ...(persist === undefined ? {} : { persist }),
      });

      return { fresh: true, provenanceId, capturedAt: new Date(raw.capturedAt) };
    },
  };
}

/** `provenance.request_key` for a route's `key`, or `null` when nothing can be probed. */
function routeRequestKey(route: AnyReadThroughRoute | undefined, key: string): string | null {
  if (route === undefined) return null;
  return requestKeyFor(route.providerId, route.method ?? 'GET', route.url(key), route.body?.(key));
}

/** The empty `md_lines` map a route without a `lines` hook normalises against. */
const EMPTY_LINES: ReadonlyMap<string, NormaliseLine> = new Map<string, NormaliseLine>();

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// DataServices (FUNCTIONS.md §1.4.2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The readers a resolver may use, and the only ones (ARCHITECTURE §3.3).
 *
 * Each member is WP-04's own service type rather than a re-declaration of its methods: a signature
 * copied into this file would drift from the implementation the first time WP-04 tightened one,
 * and the compiler would not notice. FUNCTIONS.md §1.4.2 also names `workspace` and `messaging`;
 * WP-09 and WP-10 own those readers, and they join this record when they exist — adding a member is
 * an addition, and no resolver written today can call one that is not here.
 */
export interface DataServices {
  reference: ReferenceService;
  historical: HistoricalService;
  intraday: IntradayService;
  ticks: TicksService;
  snapshot: SnapshotService;
  fundamentals: FundamentalsService;
  econ: EconService;
  rates: RatesService;
  curves: CurvesService;
  options: OptionsService;
  news: NewsService;
  filings: FilingsService;
  holdings: HoldingsService;
  portfolio: PortfolioService;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Paging
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * FUNCTIONS.md §1.4.1 `page`, plus `.info` — what `set()` recorded, which is what the runner
 * stamps into `meta.page` (§1.4.3 step 8) and what `POST /functions/:code/page` reads the next
 * cursor from. The spec writes `ctx.page?.info`; `null` until a resolver calls `set`.
 */
export interface PageContext {
  readonly cursor: string | null;
  readonly direction: 'fwd' | 'back';
  set(info: { index: number; count: number; cursor: string | null }): void;
  readonly info: PayloadPage | null;
}

export function pageContext(input: { cursor: string | null; direction: 'fwd' | 'back' }): PageContext {
  let info: PayloadPage | null = null;
  return {
    cursor: input.cursor,
    direction: input.direction,
    set(next): void {
      info = { index: next.index, count: next.count, cursor: next.cursor };
    },
    get info(): PayloadPage | null {
      return info;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ResolveContext (FUNCTIONS.md §1.4.1, verbatim)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ResolveUser {
  userId: number;
  firmId: number;
  sessionId: string;
  role: Role;
}

export interface ResolveContext {
  user: ResolveUser;
  /** UUID v4 from `x-trace-id` (ARCHITECTURE §11). */
  traceId: string;
  /** `'p1'..'p8'`. */
  panelId?: string;
  /** Resolved as-of `ctx.asOf`; `null` when the manifest takes no security. */
  instrument: Instrument | null;
  /** Defaults now/now; export, page and share re-supply the cached `meta.asOf`. */
  asOf: { validAt: Date; knownAt: Date };
  /** The only source of "now" (a `VirtualClock` in tests). */
  clock: Clock;
  /** The request transaction, with `app.user_id` / `app.firm_id` set, so RLS applies. */
  db: Tx;
  data: DataServices;
  plant: PlantReader;
  providers: ReadThrough;
  /** Extra checks beyond the runner's pre-check; new denials close the plant gate immediately. */
  entitle: (fieldIds: FieldId[], usage: UsageType, tier?: Tier) => Promise<EntitlementDecision>;
  prov: ProvenanceCollector;
  unavailable: UnavailableCollector;
  engines: EngineCollector;
  usage: UsageType;
  page?: PageContext;
}

export type FunctionResolver<P, T> = (ctx: ResolveContext, params: P) => Promise<T>;

export interface FunctionServerModule<P, T> {
  /** Default / dispatcher. */
  resolve: FunctionResolver<P, T>;
  /** Keyed by asset class (FUNC-02); `'etf'` may point at the equity resolver. */
  variants?: Partial<Record<AssetClass, FunctionResolver<P, T>>>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// buildContext
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface BuildContextDeps {
  clock: Clock;
  /** The request transaction (FUNCTIONS.md §1.4.1). `Db` is accepted for the shared contract. */
  db: Db | Tx;
  /** Built by the caller over the same transaction and the decision's denials. */
  data: DataServices;
  plant: Plant;
  hotset?: HotSet;
  registry: LicenceRegistry;
  entitlements: Evaluator;
  providers?: ProviderRegistry;
  http?: HttpClient;
  /** The injected read-through table (WP-05 owns the routes). Absent ⇒ every kind degrades. */
  routes?: ReadThroughRoutes;
  /** Test seam: the provenance store `ReadThrough` probes and writes. */
  store?: ReadThroughStore;
}

export interface BuildContextInput {
  user: ResolveUser;
  traceId: string;
  panelId?: string;
  instrument: Instrument | null;
  asOf: { validAt: Date; knownAt: Date };
  usage: UsageType;
  page?: { cursor: string | null; direction: 'fwd' | 'back' };
  /**
   * The runner's step-5 decision. **Addition to §1.4.1's `buildContext` input**, and a load-bearing
   * one: without it the `PlantReader` has no gate to apply, and a resolver would read a field the
   * decision denied. Absent ⇒ `DEFAULT_TIER` and no denials, which is what a unit context with no
   * entitlement story means.
   */
  decision?: EntitlementDecision;
  /** `entitlement_grants` purpose recorded by `ctx.entitle` — the function code. Default `'fn'`. */
  purpose?: string;
}

/**
 * Assemble the `ResolveContext` over one request transaction.
 *
 * The gate the `PlantReader` reads is **mutable and shared with `ctx.entitle`**: a resolver that
 * asks for more fields mid-resolve and is refused closes the gate for every later plant read in
 * the same run. Denials only ever accumulate and the tier only ever falls — a second decision can
 * take a field away, never hand one back, which is the only direction that is safe when two
 * decisions disagree.
 */
export function buildContext(deps: BuildContextDeps, input: BuildContextInput): ResolveContext {
  const decision = input.decision;
  const denied = new Map<FieldId, ReasonCode>();
  // The decision's own tier seeds the gate; every later decision can only lower it.
  let tier: Tier = decision?.effectiveTier ?? DEFAULT_TIER;

  const absorb = (d: EntitlementDecision): void => {
    if (d.effectiveTier !== null) tier = minTier(tier, d.effectiveTier);
    for (const field of d.fields) {
      if (field.decision === 'deny' && !denied.has(field.fieldId)) {
        denied.set(field.fieldId, field.reason);
      }
    }
  };
  for (const field of decision?.fields ?? []) {
    if (field.decision === 'deny') denied.set(field.fieldId, field.reason);
  }

  const prov = provenanceCollector({
    attribution: (sourceId) => deps.registry.licence(sourceId)?.attribution,
  });

  // `Tx` is what every reader and the plant store take; `Db | Tx` is the shared-contract type of
  // the dependency, and a pool handle reaching here would mean the route opened no transaction.
  const tx = deps.db as Tx;

  const purpose = input.purpose ?? 'fn';
  const instrument = input.instrument;

  const context: ResolveContext = {
    user: input.user,
    traceId: input.traceId,
    instrument,
    asOf: input.asOf,
    clock: deps.clock,
    db: tx,
    data: deps.data,
    plant: plantReader({
      plant: deps.plant,
      ...(deps.hotset === undefined ? {} : { hotset: deps.hotset }),
      gate: () => ({ tier, denied }),
    }),
    providers: readThrough({
      clock: deps.clock,
      db: deps.db,
      traceId: input.traceId,
      ...(deps.routes === undefined ? {} : { routes: deps.routes }),
      ...(deps.providers === undefined ? {} : { providers: deps.providers }),
      ...(deps.http === undefined ? {} : { http: deps.http }),
      ...(deps.store === undefined ? {} : { store: deps.store }),
    }),
    async entitle(fieldIds, usage, requestedTier) {
      const next = await deps.entitlements.evaluate({
        userId: input.user.userId,
        firmId: input.user.firmId,
        sessionId: input.user.sessionId,
        instrumentId: instrument === null ? null : instrument.instrumentId,
        assetClass: instrument === null ? null : instrument.assetClass,
        fieldIds: [...fieldIds],
        tier: requestedTier ?? tier,
        usage,
        purpose,
        traceId: input.traceId,
      });
      absorb(next);
      return next;
    },
    prov,
    unavailable: unavailableCollector(),
    engines: engineCollector(),
    usage: input.usage,
  };

  if (input.panelId !== undefined) context.panelId = input.panelId;
  if (input.page !== undefined) context.page = pageContext(input.page);
  return context;
}
