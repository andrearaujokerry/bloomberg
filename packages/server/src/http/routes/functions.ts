/**
 * `http/routes/functions.ts` — API.md §5.3 L489-538 (FUNC-01, FUNC-02, FUNC-04), WORKPLAN WP-08.
 *
 * Six routes, and the wiring that turns a request into a `functionRunner`:
 *
 *   GET  /functions               the catalogue, with an ETag
 *   GET  /functions/:code         one manifest, aliases resolved (`IB` → `MSG`)
 *   GET  /functions/:code/help    HELP ×1 content (TERM-09)
 *   POST /functions/:code/run     the eleven steps of FUNCTIONS.md §1.4.3
 *   POST /functions/:code/page    steps 6-11 over the cached params, with a new `resultId`
 *   GET  /results/:resultId       the cached payload, or a re-run under the viewer's entitlements
 *
 * **What is published is not what is stored.** `FunctionManifestPublic` (API.md L502-516) is the
 * manifest minus the parts that only run on a server: `params` becomes `paramsSchema`
 * (`z.toJSONSchema`), `csv` becomes `csvColumns` (and `null` when the columns are a function of the
 * payload), and `live`, `variants` and `aliasParams` do not cross the wire at all. `fieldIds` is a
 * *function* on the manifest and a *record* on the wire, so it is evaluated here, once per asset
 * class the manifest declares — a screen uses it to grey out a column before it asks for it
 * (ENTL-05), which only works if the answer arrives with the catalogue.
 *
 * **The three run routes carry the `fn:run` scope.** WP-07 mints API keys with
 * `['data:read', 'fn:run', 'ws:subscribe']` and nothing checked `fn:run` anywhere until this file:
 * a scope nobody checks is a permission nobody has, and an API key issued "read only" would have
 * run every function in the catalogue. `GET /functions` and `/help` are catalogue reads and need a
 * session but no scope — the manifest says what a function *would* need, never what it holds.
 *
 * **One transaction per run.** The runner is built inside `withTx`, so `app.user_id`,
 * `app.firm_id` and `app.role` are set for every statement a resolver makes and RLS applies
 * (DATA_MODEL §15.1). The `DataServices`, the security resolver and the context all hang off that
 * one handle: a resolver cannot read outside the transaction that authorised it.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type {
  AnyFunctionManifest,
  AssetClass,
  Clock,
  CsvColumn,
  FieldId,
  FunctionRegistry,
} from '@terminal/core';
import { getField, registry as generatedRegistry, sha256Hex } from '@terminal/core';
import type { SecurityRefInput } from '@terminal/sdk/wire/common';
import {
  FunctionCodeParams,
  FunctionPageRequest,
  FunctionRunRequest,
  HelpQuery,
  ResultParams,
  type FunctionManifestPublic,
  type HelpResponse,
} from '@terminal/sdk/wire/rest/functions';

import { EconService } from '../../data/econ.js';
import { FilingsService } from '../../data/filings.js';
import { FundamentalsService } from '../../data/fundamentals.js';
import { historicalService } from '../../data/historical.js';
import { holdingsService } from '../../data/holdings.js';
import { intradayService } from '../../data/intraday.js';
import { newsService } from '../../data/news.js';
import { optionsService } from '../../data/options.js';
import { portfolioService } from '../../data/portfolio.js';
import { ratesService } from '../../data/rates.js';
import { curvesService } from '../../data/curves.js';
import {
  ProvenanceIndex,
  referenceService,
  type DataDeps,
  type ProvenanceSink,
} from '../../data/reference.js';
import { snapshotService } from '../../data/snapshot.js';
import { ticksService } from '../../data/ticks.js';
import type { AsOf } from '../../db/bitemporal.js';
import { withTx, type Db, type RequestCtx, type Tx } from '../../db/client.js';
import type { AccessLog } from '../../entitlements/accessLog.js';
import type { Evaluator } from '../../entitlements/evaluator.js';
import { licenceRegistry, type LicenceRegistry } from '../../entitlements/licenceRegistry.js';
import type { Quotas } from '../../entitlements/quotas.js';
import type { DataServices, FunctionServerModule } from '../../functions/context.js';
import { functionModules as generatedModules } from '../../functions/index.js';
import { ResultCache } from '../../functions/resultCache.js';
import {
  asOfOf,
  functionRunner,
  type AsOfInstants,
  type FunctionResult,
  type FunctionRunner,
  type ResolvedSecurity,
  type RunFunctionBody,
  type RunFunctionHttpCtx,
} from '../../functions/runner.js';
import type { HotSet } from '../../ingest/hotset.js';
import { getMetrics } from '../../observability/metrics.js';
import type { UsageEvents } from '../../observability/usageEvents.js';
import type { Plant } from '../../plant/tickerPlant.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { SecurityResolver, type ResolveCandidate } from '../../refdata/resolve.js';
import { InstrumentRepository } from '../../refdata/master.js';
import { requireSession, type Principal } from '../auth/session.js';
import { rateLimit, REST_LIMIT } from '../rateLimit.js';
import { AuthRequiredError, NotFoundError, ValidationFailedError } from '../errors.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Injected dependencies
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Everything the function surface needs beyond `db`, `clock` and `plant`.
 *
 * Every member has a working default, so a process that wires none of this still serves the
 * catalogue and runs whatever the generated registry holds. A test injects its own registry and
 * modules here, which is the only way to exercise the runner before WP-09/10/11 write the real
 * manifests.
 */
export interface FunctionRouteDeps {
  registry?: FunctionRegistry;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modules?: Record<string, FunctionServerModule<any, any>>;
  /** Process-wide by default: a result is shared between the run that made it and the CSV route. */
  resultCache?: ResultCache;
  licences?: LicenceRegistry;
  accessLog?: AccessLog;
  usageEvents?: UsageEvents;
  quotas?: Quotas;
  providers?: ProviderRegistry;
  hotset?: HotSet;
  /** FUNCTIONS.md §1.4.3 step 7; default 20 000 ms. */
  timeoutMs?: number;
  /** Step 7's variant assertion: throw (dev/test, the default) or record and serve (prod). */
  strictVariant?: boolean;
  onWarning?: (event: { code: string; message: string; details: Record<string, unknown> }) => void;
}

declare module '../../app.js' {
  // Optional additions only — `buildApp`'s contract (app.ts L60-64) allows exactly this.
  interface AppDeps {
    /** Overrides for the function, data and export routes; every field has a default. */
    functions?: FunctionRouteDeps;
  }
}

/** The host members these routes read off `app.deps`, without importing `AppDeps` itself. */
export interface FunctionHostDeps {
  db: Db | Tx;
  clock: Clock;
  plant: Plant;
  entitlements?: Evaluator;
  quotas?: Quotas;
  hotset?: HotSet;
  functions?: FunctionRouteDeps;
}

/**
 * The result cache, one per `Clock`.
 *
 * Deliberately longer-lived than a request: `GET /functions/:code/csv?resultId=…` arrives on a
 * *different* request from the run that produced the id, and a cache rebuilt per request would
 * make every export a re-resolve (and every share link a 404). The cache is keyed by `resultId`
 * and gated on `userId` and `firmId`, so sharing one instance across requests is exactly the point.
 *
 * **Keyed on the clock, not memoised on first use.** A `ResultCache` measures its ten-minute TTL
 * on the `Clock` it was built with. A single process-global instance would capture whichever clock
 * asked first and keep it forever: one app built with a frozen `VirtualClock` before the real one
 * — a test that forgot `resetResultCache()`, or any future wiring order — and every entry's TTL is
 * computed against a clock that never advances, so nothing ever expires. A `WeakMap` keyed on the
 * clock makes that impossible to express: every caller gets a cache that ages the way its own
 * clock does, and a cache whose clock has been collected goes with it.
 *
 * Each cache starts its own expiry sweep, because the TTL is otherwise honoured on *read* only:
 * a user who runs 500 functions and closes the terminal would leave 500 entitlement-filtered
 * payloads resident until the process restarted (see `ResultCache.start`).
 */
const cachesByClock = new WeakMap<Clock, ResultCache>();

function defaultResultCache(clock: Clock): ResultCache {
  let held = cachesByClock.get(clock);
  if (held === undefined) {
    held = new ResultCache({ clock });
    held.start();
    cachesByClock.set(clock, held);
  }
  return held;
}

/**
 * Drop the cache a clock owns — for a test that wants a cold start, and for `index.ts` on
 * shutdown. With no clock, there is nothing process-global left to reset, so it is a no-op kept
 * for the callers that already say it.
 */
export function resetResultCache(clock?: Clock): void {
  if (clock === undefined) return;
  const held = cachesByClock.get(clock);
  if (held === undefined) return;
  held.stop();
  held.clear();
  cachesByClock.delete(clock);
}

export function hostDepsOf(request: FastifyRequest): FunctionHostDeps {
  return request.server.deps as unknown as FunctionHostDeps;
}

/** The principal the guard decorated, or 401 — a route reached without its guard is a bug. */
export function principalOf(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (principal === undefined) throw new AuthRequiredError();
  return principal;
}

export function ctxOf(principal: Principal): RequestCtx {
  return {
    userId: principal.userId,
    firmId: principal.firmId,
    role: principal.role,
    sessionId: principal.sessionId,
  };
}

export function httpCtxOf(request: FastifyRequest, principal: Principal): RunFunctionHttpCtx {
  return {
    userId: principal.userId,
    firmId: principal.firmId,
    sessionId: principal.sessionId,
    role: principal.role,
    clientKind: principal.clientKind,
    traceId: request.traceId,
    usage: principal.clientKind === 'api' ? 'api' : 'display',
  };
}

/** Parse with a normative wire schema; a failure is the documented `400 VALIDATION_FAILED`. */
export function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  location: 'body' | 'query' | 'params',
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationFailedError(location, result.error.issues);
  return result.data;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Per-request wiring
// ─────────────────────────────────────────────────────────────────────────────────────────────

function registryOf(deps: FunctionHostDeps): FunctionRegistry {
  return deps.functions?.registry ?? generatedRegistry;
}

/**
 * The licence registry, loaded.
 *
 * Memoised per `AppDeps` object rather than per request: the registry holds a snapshot of
 * `licence_registry`, `field_licence` and `entitlement_grants`, and rebuilding it on every request
 * would be three full table loads per screen. `refreshIfStale()` is one cheap `SELECT` of
 * `config_versions('entitlements')` and reloads only when somebody moved it — which is also what
 * fills an empty snapshot on first use. **Without that await, `licence(sourceId)` answers
 * `undefined` and every CSV goes out with a blank `# source:` line**, which is the one thing a
 * licensed source's terms do not permit (DATA-01).
 */
const registryByDeps = new WeakMap<object, LicenceRegistry>();

export async function licencesFor(deps: FunctionHostDeps): Promise<LicenceRegistry> {
  const injected = deps.functions?.licences;
  if (injected !== undefined) {
    await injected.refreshIfStale();
    return injected;
  }
  let held = registryByDeps.get(deps);
  if (held === undefined) {
    held = licenceRegistry({ db: deps.db, clock: deps.clock });
    registryByDeps.set(deps, held);
  }
  await held.refreshIfStale();
  return held;
}

/**
 * The fourteen readers of FUNCTIONS.md §1.4.2, all over one transaction and one `asOf` pair.
 *
 * This is the only assembler in the server, and it is here rather than in `data/` because the
 * *function* surface is what needs all fourteen at once: `data/request.ts` builds its own five
 * (`buildDataSources`) for the `DataRequest` shape. Both are built from the same `DataDeps`, so a
 * screen and a `POST /data` read of the same field at the same `asOf` see the same row.
 */
export function buildDataServices(
  tx: Tx,
  at: AsOf,
  prov: ProvenanceSink,
  scope: { userId: number; firmId: number },
): DataServices {
  const deps: DataDeps = { tx, asOf: at, prov };
  return {
    reference: referenceService(deps),
    historical: historicalService(deps),
    intraday: intradayService(deps),
    ticks: ticksService(deps),
    snapshot: snapshotService(deps),
    fundamentals: new FundamentalsService(tx),
    econ: new EconService(tx),
    rates: ratesService(tx, at),
    curves: curvesService(tx, at),
    options: optionsService(tx, at),
    news: newsService(tx, at),
    filings: new FilingsService(tx),
    holdings: holdingsService(tx, at),
    portfolio: portfolioService(tx, at, { firmId: scope.firmId, userId: scope.userId }),
  };
}

/**
 * The runner's security port over WP-04's `SecurityResolver`.
 *
 * Two reads, not one: the resolver answers with a `ResolveCandidate` (the search row), and
 * `ResolveContext.instrument` is a full bitemporal `Instrument`. The second read is by
 * `instrumentId` at the same `asOf`, so the version the resolver matched is the version the
 * resolver reads — a re-resolution by ticker could otherwise land on a different row if the ticker
 * moved between the two statements.
 */
export function securityPort(
  tx: Tx,
): (ref: SecurityRefInput, asOf: AsOfInstants) => Promise<ResolvedSecurity> {
  const resolver = new SecurityResolver(tx);
  const instruments = new InstrumentRepository(tx);

  return async (ref: SecurityRefInput, asOf: AsOfInstants): Promise<ResolvedSecurity> => {
    if ('formula' in ref) {
      // CHRT-07 computed series are a chart input, not a security context: there is no instrument
      // row to entitle against, so a function that asked for one is told so rather than handed a
      // half-resolved stand-in.
      return {
        ok: false,
        code: 'NOT_IN_UNIVERSE',
        message: `A computed series (${ref.formula}) is not a security a function can run on.`,
      };
    }

    const at: AsOf = { validAt: asOf.validAt, knownAt: asOf.knownAt };
    const outcome = await resolver.resolve('id' in ref ? { id: ref.id } : ref.ref, at);
    if (!outcome.ok) {
      return {
        ok: false,
        // `BAD_IDENTIFIER` is not one of the three API-facing codes (API.md L420): a reference the
        // parser rejects is, to the caller, a security that is not there.
        code: outcome.code === 'BAD_IDENTIFIER' ? 'SECURITY_NOT_FOUND' : outcome.code,
        message: outcome.message,
        candidates: outcome.candidates.map(summaryOf),
      };
    }

    const full = await instruments.get(outcome.instrument.instrumentId, at);
    if (full === null) {
      return {
        ok: false,
        code: 'SECURITY_NOT_FOUND',
        message: `instrument ${outcome.instrument.instrumentId} has no version as of ${at.validAt.toISOString()}`,
      };
    }
    return { ok: true, instrument: full, display: outcome.instrument.display };
  };
}

/** `details.candidates` of a 409 — API.md's `InstrumentSummary` (L234-240). */
function summaryOf(c: ResolveCandidate): Record<string, unknown> {
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
 * DATA-10's existence check for the runner (`RunnerDeps.provenanceExists`).
 *
 * One `SELECT` per run over the ids a resolver cited through `ctx.prov.add()`, answering which of
 * them name no `provenance` row. WP-04's `citeProvenance()` enforces this by construction for
 * `POST /data`; the collector a resolver holds cannot, so the runner asks here.
 */
export function provenancePort(tx: Tx): (ids: readonly number[]) => Promise<readonly number[]> {
  return async (ids: readonly number[]): Promise<readonly number[]> => {
    if (ids.length === 0) return [];
    // Parameterised, never interpolated: the ids come from a resolver's own citations.
    const list = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = await tx.execute<{ provenance_id: string }>(
      sql`SELECT provenance_id::text AS provenance_id
            FROM provenance
           WHERE provenance_id IN (${list})`,
    );
    const found = new Set(rows.rows.map((r) => Number(r.provenance_id)));
    return ids.filter((id) => !found.has(id));
  };
}

/**
 * Build the runner for one request, over one transaction.
 *
 * `asOf` is needed *before* the runner runs, because the `DataServices` are bound to it — which is
 * why the route parses `body.asOf` with the runner's own `asOfOf` rather than letting the runner
 * be the only place that knows. Both use the same function, so the instants cannot disagree.
 */
export function runnerFor(options: {
  deps: FunctionHostDeps;
  tx: Tx;
  asOf: AsOfInstants;
  principal: Principal;
  /** Already loaded — see {@link licencesFor}. */
  licences: LicenceRegistry;
  usageEvents?: UsageEvents | undefined;
}): FunctionRunner {
  const { deps, tx, asOf, principal, licences } = options;
  const overrides = deps.functions ?? {};
  const prov = new ProvenanceIndex();
  const entitlements = deps.entitlements;
  if (entitlements === undefined) {
    // Fail closed, exactly as `data/request.ts#gateFields` does: a forgotten dependency must deny,
    // never allow. `createTestApp` and `index.ts` both wire the real evaluator.
    throw new NotFoundError('No entitlement evaluator is wired.', 'NOT_FOUND');
  }

  return functionRunner({
    clock: deps.clock,
    db: tx,
    registry: registryOf(deps),
    modules: overrides.modules ?? generatedModules,
    entitlements,
    licences,
    ...(overrides.accessLog === undefined ? {} : { accessLog: overrides.accessLog }),
    ...(options.usageEvents === undefined ? {} : { usageEvents: options.usageEvents }),
    resultCache: overrides.resultCache ?? defaultResultCache(deps.clock),
    metrics: getMetrics(),
    context: {
      clock: deps.clock,
      db: tx,
      data: buildDataServices(tx, { validAt: asOf.validAt, knownAt: asOf.knownAt }, prov, {
        userId: principal.userId,
        firmId: principal.firmId,
      }),
      plant: deps.plant,
      ...((overrides.hotset ?? deps.hotset) === undefined
        ? {}
        : { hotset: (overrides.hotset ?? deps.hotset)! }),
      registry: licences,
      entitlements,
      ...(overrides.providers === undefined ? {} : { providers: overrides.providers }),
    },
    resolveSecurity: securityPort(tx),
    provenanceExists: provenancePort(tx),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    ...(overrides.strictVariant === undefined ? {} : { strictVariant: overrides.strictVariant }),
    ...(overrides.onWarning === undefined ? {} : { onWarning: overrides.onWarning }),
  });
}

/** The result cache this process serves `GET /results/:resultId` and the CSV route from. */
export function resultCacheOf(deps: FunctionHostDeps): ResultCache {
  return deps.functions?.resultCache ?? defaultResultCache(deps.clock);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FunctionManifestPublic
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `FunctionManifest` → `FunctionManifestPublic` (API.md L502-516).
 *
 * `paramsSchema` is `z.toJSONSchema(manifest.params)`, which is what lets a client validate a
 * parameter before spending a round trip on it. `csvColumns` is `null` when the manifest computes
 * its columns from the payload — the honest answer, rather than a guess made against an empty one.
 */
export function publicManifest(manifest: AnyFunctionManifest): FunctionManifestPublic {
  const columns = manifest.csv.columns;
  return {
    code: manifest.code,
    name: manifest.name,
    aliases: [...manifest.aliases],
    tier: manifest.tier,
    category: manifest.category,
    assetClasses:
      manifest.assetClasses === 'any' || manifest.assetClasses === 'none'
        ? manifest.assetClasses
        : [...manifest.assetClasses],
    requiresSecurity: manifest.requiresSecurity,
    pageable: manifest.pageable,
    screenKind: manifest.screenKind,
    paramsSchema: z.toJSONSchema(manifest.params) as Record<string, unknown>,
    paramGrammar: manifest.paramGrammar as unknown as Record<string, unknown>,
    fieldIds: fieldIdsOf(manifest),
    csvColumns: typeof columns === 'function' ? null : columns.map((c: CsvColumn) => ({ ...c })),
    help: {
      summary: manifest.help.summary,
      description: manifest.help.description,
      params: manifest.help.params.map((p) => ({ ...p })),
      keys: manifest.help.keys.map((k) => ({ ...k })),
      sources: [...manifest.help.sources],
      related: [...manifest.help.related],
    },
    keymap: manifest.keymap.map((k) => ({ ...k })),
  };
}

/**
 * `fieldIds` per asset class, `'*'` for a manifest that takes none (API.md L509).
 *
 * `'any'` also publishes under `'*'`: the manifest's own field set is the one it asks for whatever
 * the security turns out to be, and enumerating every asset class would publish rows the manifest
 * never claimed.
 */
function fieldIdsOf(manifest: AnyFunctionManifest): Record<string, FieldId[]> {
  const classes = manifest.assetClasses;
  if (classes === 'none' || classes === 'any') return { '*': [...manifest.fieldIds(null)] };
  const out: Record<string, FieldId[]> = {};
  for (const assetClass of classes) out[assetClass] = [...manifest.fieldIds(assetClass)];
  return out;
}

/** HELP ×1 (API.md L530-535): the manifest's own help, plus the dictionary rows it shows. */
export function helpFor(
  manifest: AnyFunctionManifest,
  assetClass: AssetClass | null,
  licences: LicenceRegistry,
): HelpResponse {
  const fields: HelpResponse['fields'] = [];
  for (const fieldId of manifest.fieldIds(assetClass)) {
    const def = getField(fieldId);
    if (def === undefined) continue;
    const sourceId = licences.fieldSource(fieldId, assetClass)?.sourceId ?? '';
    fields.push({
      id: fieldId,
      label: def.label,
      definition: def.definition,
      sourceId,
      attribution: sourceId === '' ? '' : (licences.licence(sourceId)?.attribution ?? ''),
    });
  }
  return {
    code: manifest.code,
    name: manifest.name,
    summary: manifest.help.summary,
    description: manifest.help.description,
    params: manifest.help.params.map((p) => ({ ...p })),
    keys: manifest.help.keys.map((k) => ({ ...k })),
    fields,
    sources: [...manifest.help.sources],
    related: [...manifest.help.related],
  };
}

/**
 * The catalogue ETag: a hash of the *content*, not of `registryVersion`.
 *
 * A version string is bumped by a human and a hash is not, and the catalogue is exactly the kind
 * of document a forgotten bump leaves stale in every client's cache for a release. Memoised per
 * registry instance, because hashing 300 manifests on every poll would be a strange way to save
 * bandwidth.
 */
const catalogueCache = new WeakMap<FunctionRegistry, { etag: string; body: string }>();

export function catalogueOf(registry: FunctionRegistry): { etag: string; body: string } {
  const hit = catalogueCache.get(registry);
  if (hit !== undefined) return hit;
  const functions = registry
    .all()
    .map(publicManifest)
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const body = JSON.stringify({ registryVersion: registry.version, functions });
  const fresh = { etag: `"fn-${sha256Hex(body).slice(0, 32)}"`, body };
  catalogueCache.set(registry, fresh);
  return fresh;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Aliases resolve here (API.md L494); a code that is neither is `404 FUNCTION_NOT_FOUND`. */
function manifestOr404(registry: FunctionRegistry, code: string): AnyFunctionManifest {
  const manifest = registry.get(code);
  if (manifest === undefined) {
    throw new NotFoundError(`No function '${code}'.`, 'FUNCTION_NOT_FOUND', { code });
  }
  return manifest;
}

export const functionsRoutes: FastifyPluginAsync = async (app) => {
  // API.md §8: 20 req/s, burst 60 per session across the REST surface. The catalogue reads are
  // ETagged and the run routes are the expensive ones, so they share one bucket — a client that
  // can loop `GET /functions` can loop `POST /functions/:code/run`.
  const read = { preHandler: [requireSession(), rateLimit(REST_LIMIT)] };
  const run = { preHandler: [requireSession({ scopes: ['fn:run'] }), rateLimit(REST_LIMIT)] };

  // ── GET /functions ──────────────────────────────────────────────────────────────────────────
  app.get('/functions', read, async (request, reply) => {
    const deps = hostDepsOf(request);
    const { etag, body } = catalogueOf(registryOf(deps));

    void reply.header('etag', etag);
    void reply.header('cache-control', 'private, max-age=0, must-revalidate');
    if (request.headers['if-none-match'] === etag) {
      // `304` carries no body. Returning a value here would have Fastify serialise it, and a
      // conditional GET that answers `null` is a conditional GET that saved nothing.
      return reply.status(304).send();
    }
    void reply.type('application/json; charset=utf-8');
    return body;
  });

  // ── GET /functions/:code ────────────────────────────────────────────────────────────────────
  app.get('/functions/:code', read, (request) => {
    const deps = hostDepsOf(request);
    const { code } = parse(FunctionCodeParams, request.params, 'params');
    return publicManifest(manifestOr404(registryOf(deps), code));
  });

  // ── GET /functions/:code/help ───────────────────────────────────────────────────────────────
  app.get('/functions/:code/help', read, async (request) => {
    const deps = hostDepsOf(request);
    const { code } = parse(FunctionCodeParams, request.params, 'params');
    const query = parse(HelpQuery, request.query ?? {}, 'query');
    const manifest = manifestOr404(registryOf(deps), code);
    return helpFor(manifest, query.assetClass ?? null, await licencesFor(deps));
  });

  // ── POST /functions/:code/run ───────────────────────────────────────────────────────────────
  app.post(
    '/functions/:code/run',
    run,
    async (request) => {
      const principal = principalOf(request);
      const deps = hostDepsOf(request);
      const { code } = parse(FunctionCodeParams, request.params, 'params');
      const body = parse(FunctionRunRequest, request.body ?? {}, 'body');

      const runBody: RunFunctionBody = {
        params: body.params,
        ...(body.security === undefined ? {} : { security: body.security }),
        ...(body.asOf === undefined
          ? {}
          : {
              asOf: {
                ...(body.asOf.validAt === undefined ? {} : { validAt: body.asOf.validAt }),
                ...(body.asOf.knownAt === undefined ? {} : { knownAt: body.asOf.knownAt }),
              },
            }),
        ...(body.panelId === undefined ? {} : { panelId: body.panelId }),
        launchKind: body.launchKind,
      };

      return runInTx(request, principal, deps, runBody, (runner, http) =>
        runner.run(code, runBody, http),
      );
    },
  );

  // ── POST /functions/:code/page ──────────────────────────────────────────────────────────────
  app.post(
    '/functions/:code/page',
    run,
    async (request) => {
      const principal = principalOf(request);
      const deps = hostDepsOf(request);
      parse(FunctionCodeParams, request.params, 'params');
      const body = parse(FunctionPageRequest, request.body ?? {}, 'body');

      // A page turn reads at the *cached* `asOf`, which the runner takes from the cached meta. The
      // services here are bound to that same pair, read from the cache before the transaction so
      // the two cannot differ.
      const cached = resultCacheOf(deps).get(body.resultId, principal.userId);
      const asOf: AsOfInstants =
        cached === undefined
          ? asOfOf({}, deps.clock)
          : {
              validAt: new Date(cached.meta.asOf.validAt),
              knownAt: new Date(cached.meta.asOf.knownAt),
            };

      return runAtAsOf(request, principal, deps, asOf, (runner, http) =>
        runner.page(body.resultId, body.direction, http),
      );
    },
  );

  // ── GET /results/:resultId ──────────────────────────────────────────────────────────────────
  app.get(
    '/results/:resultId',
    run,
    async (request) => {
      const principal = principalOf(request);
      const deps = hostDepsOf(request);
      const { resultId } = parse(ResultParams, request.params, 'params');

      const own = resultCacheOf(deps).get(resultId, principal.userId);
      if (own !== undefined) return { data: own.data, meta: own.meta };

      // Somebody else's result (MSG-04) — re-run at its `asOf` under this viewer's entitlements.
      // Firm-scoped: a share link (MSG-04) travels inside a firm, so a resultId presented by
      // another tenant gets the same `undefined` a bogus one gets — and therefore the same 404
      // RESULT_EXPIRED, rather than a re-run that confirms whose screen it was.
      const shared = resultCacheOf(deps).peek(resultId, principal.firmId);
      const asOf: AsOfInstants =
        shared === undefined
          ? asOfOf({}, deps.clock)
          : {
              validAt: new Date(shared.meta.asOf.validAt),
              knownAt: new Date(shared.meta.asOf.knownAt),
            };

      return runAtAsOf(request, principal, deps, asOf, (runner, http) =>
        runner.result(resultId, http),
      );
    },
  );

  // The plugin signature is `FastifyPluginAsync` and registration is synchronous.
  await Promise.resolve();
};

/** One transaction, one runner, one run — with the `asOf` the body asked for. */
async function runInTx(
  request: FastifyRequest,
  principal: Principal,
  deps: FunctionHostDeps,
  body: RunFunctionBody,
  run: (runner: FunctionRunner, http: RunFunctionHttpCtx) => Promise<FunctionResult>,
): Promise<FunctionResult> {
  return runAtAsOf(request, principal, deps, asOfOf(body, deps.clock), run);
}

async function runAtAsOf(
  request: FastifyRequest,
  principal: Principal,
  deps: FunctionHostDeps,
  asOf: AsOfInstants,
  run: (runner: FunctionRunner, http: RunFunctionHttpCtx) => Promise<FunctionResult>,
): Promise<FunctionResult> {
  const http = httpCtxOf(request, principal);
  const licences = await licencesFor(deps);
  return withTx(ctxOf(principal), async (tx) => {
    const runner = runnerFor({
      deps,
      tx,
      asOf,
      principal,
      licences,
      usageEvents: deps.functions?.usageEvents,
    });
    return run(runner, http);
  });
}
