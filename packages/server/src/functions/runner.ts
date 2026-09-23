/**
 * `functions/runner.ts` — the eleven steps of FUNCTIONS.md §1.4.3 (L317-350), ARCHITECTURE §5,
 * API.md §5.3 (L489-538). WORKPLAN WP-08.
 *
 * Every function launch in the terminal goes through `run()`. The order of the steps is not a
 * style choice: it is what decides *which* error a bad request gets, and the client switches on
 * that code. A launch of `HP` with unparseable params on a ticker that does not exist must answer
 * `400 VALIDATION_FAILED`, not `404 SECURITY_NOT_FOUND`, because the parameter grammar is what the
 * user can see and fix from the command line. So the steps run in the documented order, each one
 * throwing its own `AppError`, and nothing is evaluated early "to save a round trip".
 *
 *   1. manifest lookup ..................... 404 FUNCTION_NOT_FOUND
 *   2. `manifest.params.parse` ............. 400 VALIDATION_FAILED { location:'fnParams', grammar }
 *   3. security resolution ................. 422 NO_SECURITY_CONTEXT | 404 SECURITY_NOT_FOUND
 *                                            409 AMBIGUOUS_SECURITY | 422 NOT_IN_UNIVERSE
 *   4. applicability ....................... 422 FUNCTION_NOT_APPLICABLE { assetClass, applicable }
 *   5. entitlement pre-check ............... 403 ENTITLEMENT_DENIED (only when EVERY field is denied)
 *   6. `buildContext` + variant choice
 *   7. resolver, 20 s timeout .............. 503 PROVIDER_UNAVAILABLE | 500 INTERNAL
 *   8. `meta` stamped
 *   9. `resultCache.put`
 *  10. `access_log` and `usage_events`
 *  11. `fn_resolve_ms{code}` observed, payload returned
 *
 * **Reproducibility (ANAL-08) is the property this file is shaped around.** With an explicit
 * `asOf`, steps 6-8 must be pure in `(code, params, asOf, store)`: two runs a week apart return
 * byte-identical `data` and `meta.engines`, and may differ only in `traceId`, `resultId`,
 * `servedAt`, `staleness` and a live subject's `capturedAt`. Three structural decisions make that
 * true rather than merely intended:
 *
 *   - `asOfOf()` is the *only* place the clock is consulted for the as-of instant, and an explicit
 *     `body.asOf` short-circuits it entirely. Nothing downstream calls `clock.now()` to decide what
 *     to read — the resolver reads through `ctx.asOf`, and `ctx.clock` exists for durations and
 *     timestamps, not for choosing rows.
 *   - the five non-reproducible fields of `meta` are assembled in one block, `volatileMeta()`,
 *     physically separated from `stableMeta()`. A future field lands in one of the two and the
 *     author has to say which — the split is the specification, in code.
 *   - the resolver receives `params` *after* the zod parse and `instrument` *after* resolution, so
 *     a re-run from the result cache (`page()`, `result()`, `export.ts`) re-enters at step 6 with
 *     exactly the objects the first run used, never with the raw request body again.
 *
 * What this module deliberately does NOT do: write to the database directly, read `process.env`,
 * call `Date.now()`, or format a number. It composes the collaborators WP-04, WP-05 and WP-07
 * built and stamps the envelope API.md §3 documents.
 */

import { randomBytes } from 'node:crypto';

import type {
  AssetClass,
  Clock,
  EntitlementDecision,
  FieldId,
  Instrument,
  PayloadEntitlementNote,
  PayloadMeta,
  PayloadProvenance,
  Tier,
  UsageType,
} from '@terminal/core';
import type { AnyFunctionManifest, FunctionRegistry } from '@terminal/core';
import { hasField } from '@terminal/core';
import type { CsvColumn } from '@terminal/core';
import type { SecurityRefInput } from '@terminal/sdk/wire/common';
import type { Role } from '@terminal/sdk/wire/rest/auth';
import type { z } from 'zod';

import type { Db, Tx } from '../db/client.js';
import type { AccessLog, AccessLogRow } from '../entitlements/accessLog.js';
import type { Evaluator } from '../entitlements/evaluator.js';
import type { LicenceRegistry } from '../entitlements/licenceRegistry.js';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ProviderUnavailableError,
  ValidationFailedError,
} from '../http/errors.js';
import type { Metrics } from '../observability/metrics.js';
import { paramsHash, type UsageEventKind, type UsageEvents } from '../observability/usageEvents.js';
import {
  buildContext,
  type BuildContextDeps,
  type FunctionServerModule,
  type ReadThrough,
  type ResolveContext,
  type ResolveUser,
} from './context.js';
import type { CachedResult, ResultCache } from './resultCache.js';

/**
 * Every `ValueState` string (`core/types/quote.ts`), as a set, so step 7½ can recognise a
 * {@link ValueCell} from its shape alone without importing a manifest's column map.
 */
const VALUE_STATES: ReadonlySet<string> = new Set<string>([
  'live',
  'stale',
  'closed',
  'blank',
  'na',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Request shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The two instants every read is made at. `body.asOf` is the ISO form of this (API.md §3). */
export interface AsOfInstants {
  validAt: Date;
  knownAt: Date;
}

/**
 * `FunctionRunRequest` (API.md §5.3 L516-524) as the runner sees it, after the route's zod parse.
 *
 * `launchKind` carries `'page'` in addition to the wire enum: `POST /functions/:code/page` re-enters
 * the same pipeline and must produce a `fn.page` usage row rather than a second `fn.launch`
 * (FUNC-04). The wire schema is unchanged — the page route sets it, not the client.
 */
export interface RunFunctionBody {
  /** Raw parameters; merged over `manifest.aliasParams[alias]` before the zod parse. */
  params?: Record<string, unknown>;
  /** Ignored when `manifest.assetClasses === 'none'` (§1.4.3 step 3). */
  security?: SecurityRefInput;
  /** ISO-8601; absent members default to `clock.now()`. */
  asOf?: { validAt?: string; knownAt?: string };
  page?: { cursor: string | null; direction: 'fwd' | 'back' };
  /** `'p1'..'p8'` — recorded on the `usage_events` row. */
  panelId?: string;
  launchKind?: 'launch' | 'param' | 'refresh' | 'page';
}

/** The caller's identity, trace and usage type, as the session decorator produced them. */
export interface RunFunctionHttpCtx {
  userId: number;
  firmId: number;
  sessionId: string;
  role: Role;
  /** `'api'` ⇒ a bearer/API-key caller; step 5's `usage` is `'api'` for those (API.md §5.3). */
  clientKind: 'web' | 'api';
  traceId: string;
  usage: UsageType;
}

/**
 * The security resolver port.
 *
 * A discriminated union rather than a throw, because the runner owns the mapping from a resolution
 * failure to an HTTP code and must not have to pattern-match somebody else's error class to do it.
 * `data/reference.ts#SecurityResolver.resolve` already answers in exactly this shape
 * (`{ ok, code, candidates }`), so the route adapter is a rename, not a translation.
 */
export type ResolvedSecurity =
  | { ok: true; instrument: Instrument; display?: string }
  | {
      ok: false;
      code: 'SECURITY_NOT_FOUND' | 'AMBIGUOUS_SECURITY' | 'NOT_IN_UNIVERSE';
      message?: string;
      /** `details.candidates` of a 409 (API.md §2 L181). */
      candidates?: readonly unknown[];
    };

export interface RunnerDeps {
  clock: Clock;
  /**
   * The request transaction. It overrides `context.db`: one run reads through one transaction, and
   * a runner handed a pool handle where the route should have opened a transaction would read
   * outside RLS.
   */
  db: Db | Tx;
  registry: FunctionRegistry;
  /** `functions/index.ts`'s generated `functionModules`, keyed by canonical code. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modules: Record<string, FunctionServerModule<any, any>>;
  entitlements: Evaluator;
  licences: LicenceRegistry;
  /**
   * ENTL-04. The evaluator writes the decision's rows when it was given this same writer; the
   * runner appends them only when it was not, so a row is written exactly once either way
   * (see {@link logAccess}).
   */
  accessLog?: AccessLog;
  usageEvents?: UsageEvents;
  resultCache: ResultCache;
  metrics?: Metrics;
  context: BuildContextDeps;
  resolveSecurity(ref: SecurityRefInput, asOf: AsOfInstants): Promise<ResolvedSecurity>;
  /** FUNCTIONS.md §1.4.3 step 7. Default 20 000 ms. */
  timeoutMs?: number;
  /**
   * Step 7's variant assertion: throw on a mismatch (dev/test) or record it and serve (prod).
   * Defaults to `true` — a build that wants the production behaviour says so in `config.ts`,
   * because a silent wrong-variant payload renders the wrong screen.
   */
  strictVariant?: boolean;
  /**
   * DATA-10. Which of the `provenance_id`s a resolver cited through `ctx.prov.add()` are **not**
   * rows in `provenance`. Returns the missing ids; an empty array means every citation resolves.
   *
   * WP-04's `citeProvenance()` enforces this for `POST /data`, but `ctx.prov.add()` — the surface
   * a resolver actually uses — takes an id on trust, so `meta.provenance` and the CSV's
   * `# x-provenance` header can carry an id that names no row. The check lives here because the
   * runner is the one choke point every function payload passes through. Omitted, the check is
   * skipped (a unit runner with no database).
   */
  provenanceExists?: (ids: readonly number[]) => Promise<readonly number[]>;
  /** Where a non-strict variant mismatch and a swallowed usage-event failure are recorded. */
  onWarning?: (event: { code: string; message: string; details: Record<string, unknown> }) => void;
}

export interface FunctionResult {
  data: unknown;
  meta: PayloadMeta;
  /**
   * The instrument the payload is *about*, or `null` for a manifest that takes no security.
   *
   * Reported alongside the payload rather than left for the caller to re-derive, because the two
   * callers who need it (`functions/export.ts`, and any future re-run path) would otherwise have
   * to guess it from the request. `export.ts` evaluates the export entitlement against this id:
   * guessing `null` there evaluates an instrument-scoped licence, restricted list or ethical wall
   * about *no instrument at all*, and writes the ENTL-04 audit rows with `instrument_id NULL`.
   */
  instrumentId: number | null;
}

export interface FunctionRunner {
  /** Steps 1-11. */
  run(code: string, body: RunFunctionBody, http: RunFunctionHttpCtx): Promise<FunctionResult>;
  /** `POST /functions/:code/page` — steps 6-11 over the cached params, security and `asOf`. */
  page(
    resultId: string,
    direction: 'fwd' | 'back',
    http: RunFunctionHttpCtx,
  ): Promise<FunctionResult>;
  /** `GET /results/:resultId` — the producer's copy, or a re-run under the viewer's entitlements. */
  result(resultId: string, http: RunFunctionHttpCtx): Promise<FunctionResult>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** FUNCTIONS.md §1.4.3 step 7. */
export const DEFAULT_RESOLVER_TIMEOUT_MS = 20_000;

/** The payload `variant` of a function that takes no security (FUNCTIONS.md §1.3 rule 1). */
export const DEFAULT_VARIANT = 'default';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// resultId — a ULID on the injected clock
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Crockford base32, as ULID specifies: no I, L, O or U. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A ULID from `clock.now()` — 10 characters of millisecond timestamp, 16 of randomness.
 *
 * Lexicographic order is time order, which is what makes a resultId readable in a log line next to
 * an `access_log` row, and the timestamp half comes from the injected clock so a `VirtualClock`
 * test gets a deterministic prefix. The random half is `randomBytes`, not `Math.random()`: a
 * resultId is handed out in share links, and a guessable one would be a way to probe the cache
 * (the cache's producer check is the real defence, but a predictable id makes probing free).
 */
export function ulid(clock: Clock): string {
  let ms = Math.floor(clock.now());
  if (!Number.isFinite(ms) || ms < 0) ms = 0;

  const time = new Array<string>(10);
  for (let i = 9; i >= 0; i -= 1) {
    time[i] = CROCKFORD.charAt(ms % 32);
    ms = Math.floor(ms / 32);
  }

  const bytes = randomBytes(16);
  const random = new Array<string>(16);
  for (let i = 0; i < 16; i += 1) {
    random[i] = CROCKFORD.charAt((bytes[i] ?? 0) % 32);
  }

  return time.join('') + random.join('');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Error constructors — one per documented code, so no route writes an envelope by hand
// ─────────────────────────────────────────────────────────────────────────────────────────────

const functionNotFound = (code: string): AppError =>
  new NotFoundError(`No function '${code}'.`, 'FUNCTION_NOT_FOUND', { code });

const noSecurityContext = (manifest: AnyFunctionManifest): AppError =>
  new AppError('NO_SECURITY_CONTEXT', `${manifest.code} needs a security.`, {
    details: { code: manifest.code },
  });

const notApplicable = (
  manifest: AnyFunctionManifest,
  assetClass: AssetClass,
  applicable: readonly AssetClass[],
): AppError =>
  new AppError(
    'FUNCTION_NOT_APPLICABLE',
    `${manifest.code} does not apply to a ${assetClass} security.`,
    { details: { assetClass, applicable: [...applicable] } },
  );

const entitlementDenied = (notes: readonly PayloadEntitlementNote[]): AppError =>
  new AppError('ENTITLEMENT_DENIED', 'Not entitled to any field this function needs.', {
    details: { reasons: notes.map((n) => ({ ...n })) },
  });

const resultExpired = (resultId: string): AppError =>
  new NotFoundError(`Result ${resultId} is no longer cached.`, 'RESULT_EXPIRED', { resultId });

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Step 5's usage type. `http.usage` is honoured — `export.ts` passes `'export'` — but a bearer
 * caller is `'api'` whatever the route said, because `usage` decides both the licence check
 * (ENTL-01 `display_allowed` / `api_allowed`) and the `access_log` row, and a route that forgot
 * would understate an API read as a screen view.
 */
function usageFor(http: RunFunctionHttpCtx): UsageType {
  if (http.usage === 'export') return 'export';
  return http.clientKind === 'api' ? 'api' : 'display';
}

function resolveUserOf(http: RunFunctionHttpCtx): ResolveUser {
  return {
    userId: http.userId,
    firmId: http.firmId,
    sessionId: http.sessionId,
    role: http.role,
  };
}

/** An ISO instant that must parse; a malformed `asOf` is a request error, never a silent `now`. */
function instantOf(iso: string | undefined, fallback: number, which: string): Date {
  if (iso === undefined) return new Date(fallback);
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new ValidationFailedError('body', [
      { code: 'custom', path: ['asOf', which], message: `not an ISO-8601 instant: ${iso}` },
    ]);
  }
  return new Date(ms);
}

/**
 * The as-of pair. **The only place the clock decides what is read** — everything downstream takes
 * `ctx.asOf`, which is what makes a re-run at an explicit `asOf` reproducible (ANAL-08).
 */
export function asOfOf(body: RunFunctionBody, clock: Clock): AsOfInstants {
  const now = clock.now();
  return {
    validAt: instantOf(body.asOf?.validAt, now, 'validAt'),
    knownAt: instantOf(body.asOf?.knownAt, now, 'knownAt'),
  };
}

/** `manifest.assetClasses` as the list step 4 tests against; `null` for `'any'` and `'none'`. */
function applicableClasses(manifest: AnyFunctionManifest): readonly AssetClass[] | null {
  const classes = manifest.assetClasses;
  if (classes === 'any' || classes === 'none') return null;
  return classes;
}

/**
 * `meta.entitlement` (API.md §3): only the downgrades and denials are reported, never the allows.
 *
 * FUNCTIONS.md §1.4.3 step 8 writes `entitlement: decision.downgrades`, but `EntitlementDowngrade`
 * is `{ fieldId, reason }` and `PayloadEntitlementNote` — the type the wire schema and every client
 * parse — is `{ fieldId, decision, effectiveTier, reason }`. The typed shape wins: the notes are
 * built from `decision.fields`, which is a superset of `downgrades` and is where a *denial* (as
 * opposed to a downgrade) is recorded at all.
 */
/** The column ids the manifest's own CSV spec names, or an empty set when it computes them. */
function csvColumnIds(manifest: AnyFunctionManifest): ReadonlySet<string> {
  const columns = manifest.csv.columns;
  // A function of `(params, payload)` computes its columns from the payload, so there is no
  // static set to check against and the null rule does not apply to this manifest's keys.
  if (typeof columns !== 'object' || columns === null) return new Set<string>();
  return new Set(columns.map((c: CsvColumn) => c.id));
}

export function entitlementNotes(decision: EntitlementDecision): PayloadEntitlementNote[] {
  const notes: PayloadEntitlementNote[] = [];
  for (const field of decision.fields) {
    if (field.decision === 'allow') continue;
    notes.push({
      fieldId: field.fieldId,
      decision: field.decision,
      effectiveTier: field.effectiveTier,
      reason: field.reason,
    });
  }
  return notes;
}

/** True when the pre-check left nothing servable — step 5's 403 (API.md §2 L170). */
export function everyFieldDenied(decision: EntitlementDecision): boolean {
  return decision.fields.length > 0 && decision.fields.every((f) => f.decision === 'deny');
}

/**
 * FUNC-04's `usage_events.kind` for this run.
 *
 * **Deviation from §1.4.3 step 10, deliberate.** The spec writes
 * `body.launchKind === 'param' ? 'fn.param' : body.page ? 'fn.page' : 'fn.launch'`, which reads
 * `body.page` as "this is a page turn". That is no longer true here: the runner gives every
 * *pageable* manifest a page context on its first launch too (see `pageInputFor`), because a
 * screen that never reports `meta.page.cursor` can never be paged at all — `POST /page` reads the
 * next cursor out of the cached meta. `body.page` therefore stops distinguishing a launch from a
 * page turn, and `launchKind` — which only the page route sets to `'page'` — does. A first launch
 * of a pageable screen is a launch, and the 30-day roadmap query counts it as one.
 */
function usageKind(body: RunFunctionBody): UsageEventKind {
  if (body.launchKind === 'page') return 'fn.page';
  if (body.launchKind === 'param') return 'fn.param';
  return 'fn.launch';
}

/**
 * The `ctx.page` a run gets: the caller's cursor, or a first page for a pageable manifest.
 *
 * A non-pageable manifest gets no page context at all, so a resolver that calls `ctx.page.set` on
 * a screen the manifest says is not pageable finds nothing there — the manifest and the payload
 * cannot disagree about whether a screen pages.
 */
function pageInputFor(
  manifest: AnyFunctionManifest,
  body: RunFunctionBody,
): { cursor: string | null; direction: 'fwd' | 'back' } | undefined {
  if (body.page !== undefined) return body.page;
  return manifest.pageable ? { cursor: null, direction: 'fwd' } : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The runner
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function functionRunner(deps: RunnerDeps): FunctionRunner {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_RESOLVER_TIMEOUT_MS;
  const strictVariant = deps.strictVariant ?? true;

  const warn = (code: string, message: string, details: Record<string, unknown>): void => {
    deps.onWarning?.({ code, message, details });
  };

  /**
   * Step 8's "provenance: `prov.list()` with attribution from `licenceRegistry`" (DATA-09).
   *
   * The collector already fills attribution from the registry `buildContext` was given, so this is
   * normally a pass-through. It is not redundant: a context assembled without that registry — a
   * unit context, a resolver constructed by hand — would otherwise serve a screen footer and a CSV
   * header with no attribution line at all, which is the one thing a licensed source's terms do
   * not permit. The runner's own registry is the backstop, and it never overwrites a filled line.
   */
  function withAttribution(rows: readonly PayloadProvenance[]): PayloadProvenance[] {
    return rows.map((row) =>
      row.attribution === ''
        ? { ...row, attribution: deps.licences.licence(row.sourceId)?.attribution ?? '' }
        : { ...row },
    );
  }

  // ── step 1 ────────────────────────────────────────────────────────────────────────────────
  /** The manifest, and the alias it was reached by when that differs from the canonical code. */
  function lookup(code: string): { manifest: AnyFunctionManifest; alias: string | undefined } {
    const manifest = deps.registry.get(code);
    if (manifest === undefined) throw functionNotFound(code);
    const typed = code.trim().toUpperCase();
    return { manifest, alias: typed === manifest.code ? undefined : typed };
  }

  // ── step 2 ────────────────────────────────────────────────────────────────────────────────
  /**
   * `{ ...manifest.aliasParams?.[alias], ...body.params }` then `manifest.params.parse`.
   *
   * The alias defaults go *under* the body: typing `ICVS` means `curveId: 'SOFR_OIS'` unless the
   * caller said otherwise, and a caller who says otherwise is not overridden by their own shortcut.
   */
  function parseParams(
    manifest: AnyFunctionManifest,
    alias: string | undefined,
    body: RunFunctionBody,
  ): unknown {
    const defaults = alias === undefined ? undefined : manifest.aliasParams?.[alias];
    const merged = { ...defaults, ...body.params };
    // `AnyFunctionManifest` erases the parameter schema's generic to `any`; the manifest's own
    // contract is that `params` is a zod object, and `unknown` is the honest type of what it
    // yields here — the resolver is what knows its own `P`.
    const schema = manifest.params as z.ZodType<unknown>;
    const parsed = schema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationFailedError('fnParams', parsed.error.issues, {
        grammar: manifest.paramGrammar,
        code: manifest.code,
      });
    }
    return parsed.data;
  }

  // ── step 3 ────────────────────────────────────────────────────────────────────────────────
  async function resolveSecurity(
    manifest: AnyFunctionManifest,
    body: RunFunctionBody,
    asOf: AsOfInstants,
  ): Promise<Instrument | null> {
    if (manifest.assetClasses === 'none') return null; // body.security ignored, per the spec
    if (body.security === undefined) {
      if (manifest.requiresSecurity) throw noSecurityContext(manifest);
      return null;
    }

    const outcome = await deps.resolveSecurity(body.security, asOf);
    if (outcome.ok) return outcome.instrument;

    const message = outcome.message ?? 'Security could not be resolved.';
    if (outcome.code === 'AMBIGUOUS_SECURITY') {
      throw new ConflictError('AMBIGUOUS_SECURITY', message, {
        candidates: outcome.candidates === undefined ? [] : [...outcome.candidates],
      });
    }
    if (outcome.code === 'NOT_IN_UNIVERSE') {
      throw new AppError('NOT_IN_UNIVERSE', message);
    }
    throw new NotFoundError(message, 'SECURITY_NOT_FOUND');
  }

  // ── step 4 ────────────────────────────────────────────────────────────────────────────────
  function assertApplicable(manifest: AnyFunctionManifest, instrument: Instrument | null): void {
    const applicable = applicableClasses(manifest);
    if (applicable === null || instrument === null) return;
    if (applicable.includes(instrument.assetClass)) return;
    throw notApplicable(manifest, instrument.assetClass, applicable);
  }

  // ── step 5 ────────────────────────────────────────────────────────────────────────────────
  async function entitle(
    manifest: AnyFunctionManifest,
    instrument: Instrument | null,
    http: RunFunctionHttpCtx,
    usage: UsageType,
    requestedTier: Tier,
  ): Promise<EntitlementDecision> {
    const assetClass = instrument?.assetClass ?? null;
    const fieldIds: FieldId[] = [...manifest.fieldIds(assetClass)];
    const decision = await deps.entitlements.evaluate({
      userId: http.userId,
      firmId: http.firmId,
      sessionId: http.sessionId,
      instrumentId: instrument?.instrumentId ?? null,
      assetClass,
      fieldIds,
      tier: requestedTier,
      usage,
      purpose: manifest.code,
      traceId: http.traceId,
    });
    if (everyFieldDenied(decision)) throw entitlementDenied(entitlementNotes(decision));
    return decision;
  }

  // ── step 7 ────────────────────────────────────────────────────────────────────────────────
  /**
   * Run the resolver under the timeout, and decide which of the two 5xx codes a timeout is.
   *
   * "PROVIDER_UNAVAILABLE when the cause is a provider" needs a fact, not a guess: `ctx.providers`
   * is wrapped so the runner knows whether a read-through call was *in flight* when the clock ran
   * out. A resolver stuck waiting on a provider is a 503 the client may retry; a resolver stuck in
   * its own arithmetic is a 500 that retrying will not fix, and telling the two apart wrongly
   * either hides a bug behind a retry loop or tells the user a healthy provider is down.
   */
  async function runResolver(
    manifest: AnyFunctionManifest,
    ctx: ResolveContext,
    params: unknown,
  ): Promise<{ data: unknown; durationMs: number }> {
    const module = deps.modules[manifest.code];
    if (module === undefined) {
      throw new AppError('INTERNAL', `No server module for function ${manifest.code}.`, {
        details: { code: manifest.code },
      });
    }

    const variantResolver =
      ctx.instrument === null ? undefined : module.variants?.[ctx.instrument.assetClass];
    const resolver = variantResolver ?? module.resolve;

    let inFlight = 0;
    const inner: ReadThrough = ctx.providers;
    ctx.providers = {
      async ensure(kind, key, opts) {
        inFlight += 1;
        try {
          return await inner.ensure(kind, key, opts);
        } finally {
          inFlight -= 1;
        }
      },
    };

    const startedAt = deps.clock.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const data = await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            inFlight > 0
              ? new ProviderUnavailableError(
                  `${manifest.code} timed out after ${timeoutMs} ms waiting for a provider.`,
                )
              : new AppError('INTERNAL', `${manifest.code} timed out after ${timeoutMs} ms.`, {
                  details: { code: manifest.code, timeoutMs },
                }),
          );
        }, timeoutMs);
        timer.unref?.();
        void resolver(ctx, params).then(resolve, reject);
      });
      return { data, durationMs: deps.clock.now() - startedAt };
    } catch (err) {
      // An `AppError` from a resolver is already a documented code (a read-through's 503, a data
      // service's 404); anything else is a defect and must not leak its message to the caller.
      if (err instanceof AppError) throw err;
      throw new AppError('INTERNAL', `${manifest.code} failed.`, {
        cause: err,
        details: { code: manifest.code },
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      ctx.providers = inner;
    }
  }

  /** Step 7's assertion: the payload's `variant` must be the one FUNC-02 promised the screen. */
  function assertVariant(
    manifest: AnyFunctionManifest,
    instrument: Instrument | null,
    data: unknown,
  ): void {
    const expected =
      instrument === null ? DEFAULT_VARIANT : manifest.variants[instrument.assetClass];
    if (expected === undefined) return; // no promise was made for this class
    const actual = (data as { variant?: unknown } | null)?.variant;
    if (actual === expected) return;

    const details = {
      code: manifest.code,
      expected,
      actual,
      assetClass: instrument?.assetClass ?? null,
    };
    if (strictVariant) {
      throw new AppError(
        'INTERNAL',
        `${manifest.code} returned variant ${JSON.stringify(actual)}, expected ` +
          `${JSON.stringify(expected)}.`,
        { details },
      );
    }
    warn('VARIANT_MISMATCH', `${manifest.code} returned the wrong variant.`, details);
  }


  // ── step 7½ — the payload/meta invariant (DATA-10, FUNCTIONS.md §1.3 rule 6) ───────────────
  /**
   * Assert that the payload and the `meta` the runner is about to stamp on it agree.
   *
   * `assertVariant` already checks that the payload is the *shape* FUNC-02 promised. This checks
   * the claims §1.3 makes about its *contents*, and it lives here for the same reason: the runner
   * is the one choke point every function payload passes through, and a resolver cannot check
   * itself. Tier 1's fourteen manifests are written (WP-09) and Tier 2/3's twenty-six are not
   * (WP-10/11) — which is exactly why this has to say what it means before the rest are written
   * against it.
   *
   *  1. **The payload as a whole is attributable.** A payload that carries a data cell holding a
   *     finite number while nothing at all was cited — no `ctx.prov.add()`, no `ctx.engines.add()`
   *     — is a number the client cannot trace to a source or to a computation. DATA-10: every
   *     value block cites one idx.
   *  2. **Each cell is attributable on its own.** Rule 1 is an aggregate, and an aggregate is not
   *     what DATA-10 says: one citation anywhere in a payload would otherwise excuse every other
   *     number in it, and `Ctrl+I` on the cell that was *not* cited answers nothing. So every
   *     object shaped like a {@link ValueCell} is checked individually — a cell whose `v` is a
   *     finite number carries an integer `provIdx >= 0`, wherever in the payload it sits. The one
   *     documented exception is the reserved `provIdx: -1` (TIER1 §0.4 rule 1), which marks a cell
   *     that is *pending* or *denied* and therefore has a null `v`: `-1` never accompanies a
   *     number. A cell citing an engine rather than a source still carries the idx of the input
   *     the engine ran on (§0.4 rule 4), so this rule holds for derived cells too.
   *  3. **A null is explained.** §1.3 rule 6: unavailable data is `null` in the payload *and* a
   *     `meta.unavailable[]` entry. The checkable form of that is weaker than the rule: a payload
   *     carrying a null in a data cell must carry *some* explanation in `meta` — an `unavailable`
   *     entry, or an entitlement denial, which is where §12.3 puts the reason for a blanked field.
   *     The correspondence cannot be checked cell by cell, because `meta.unavailable[].field` is a
   *     dictionary `FieldId` while a payload key is the manifest's own column id, and only the
   *     manifest knows the mapping between them. What the runner *can* prove is that a payload
   *     with gaps is never served with an empty `meta` — which is the case that reaches a user as
   *     a blank cell with nothing to hover over.
   *
   * Rules 1 and 3 are bounded to the keys that are certainly **data cells**: a dictionary
   * `FieldId`, or a column the manifest's own CSV spec names. That boundary is the honest one. A
   * generic walk cannot tell a quote from an echoed parameter, a row count or a page index — all
   * numbers with no source and no business having one — so a rule over *every* number would fire
   * on correct payloads, and a rule over every null would fire on a structural `nextCursor: null`.
   * The keys a manifest itself declares as columns are the cells that reach a screen and a CSV,
   * which is exactly the surface DATA-10 and rule 6 are about; anything else in the payload is the
   * manifest's own business.
   *
   * Rule 2 needs no such boundary, and is the stronger check because of it: it recognises a cell by
   * its shape rather than by its key, so it reaches a cell nested in a row, a line or a block that
   * no column list names. What it cannot reach is a bare series — `number[]` has nowhere to put a
   * citation — so a payload that ships a *series* of prices carries a block-level idx beside it
   * (`GpSeries.provIdx`, `GipPayload.vwapProvIdx`) and the walk is not what proves it.
   *
   * Strictness follows `strictVariant`: a dev or test build throws (the payload is a defect and
   * must not be served), a production build reports it through `onWarning` and serves, because a
   * screen that is one unexplained null short is still better than no screen.
   */
  /**
   * Is this object a {@link ValueCell}?
   *
   * Decidable from shape alone, which is the point: the runner knows no manifest's column map, but
   * every screen cell in the system is `{ v, st, provIdx, … }` (FUNCTIONS.md §1.5, TIER1 §0.4) and
   * `st` is one of the seven `ValueState` strings. That is narrow enough that an echoed parameter
   * object cannot be mistaken for one, and broad enough that every cell a screen renders is caught
   * wherever in the payload it sits.
   */
  function isValueCell(node: object): boolean {
    if (!('v' in node) || !('st' in node)) return false;
    const st = (node as { st: unknown }).st;
    return typeof st === 'string' && VALUE_STATES.has(st);
  }

  function assertPayloadMeta(
    manifest: AnyFunctionManifest,
    ctx: ResolveContext,
    data: unknown,
    meta: PayloadMeta,
  ): void {
    const violations: string[] = [];

    const cells = csvColumnIds(manifest);
    const isCell = (key: string | null): key is string =>
      key !== null && (cells.has(key) || hasField(key));
    const explained =
      meta.unavailable.length > 0 || meta.entitlement.some((e) => e.decision === 'deny');
    const uncited: string[] = [];
    const gaps: string[] = [];
    const unciteableCells: string[] = [];

    const walk = (node: unknown, key: string | null, path: string): void => {
      if (typeof node === 'number') {
        if (Number.isFinite(node) && isCell(key)) uncited.push(key);
        return;
      }
      if (node === null) {
        if (isCell(key)) gaps.push(key);
        return;
      }
      if (Array.isArray(node)) {
        // An array carries its parent's key: `rows: [1, 2]` is still the `rows` cell.
        node.forEach((item, i) => {
          walk(item, key, `${path}[${String(i)}]`);
        });
        return;
      }
      if (typeof node === 'object') {
        if (isValueCell(node)) {
          const cell = node as { v: unknown; provIdx?: unknown };
          if (typeof cell.v === 'number' && Number.isFinite(cell.v)) {
            const idx = cell.provIdx;
            if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
              unciteableCells.push(path === '' ? (key ?? '<root>') : path);
            }
          }
          // Fall through: a cell's own fields are not themselves cells, but a `Custom` node may
          // nest one, and walking on costs nothing.
        }
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          walk(v, k, path === '' ? k : `${path}.${k}`);
        }
      }
    };
    walk(data, null, '');

    if (uncited.length > 0 && ctx.prov.size() === 0 && ctx.engines.list().length === 0) {
      violations.push(
        `numbers with no provenance and no engine: ${[...new Set(uncited)].sort().join(', ')} ` +
          '(DATA-10)',
      );
    }
    if (unciteableCells.length > 0) {
      violations.push(
        `value cells showing a finite number with no provenance index: ` +
          `${[...new Set(unciteableCells)].sort().slice(0, 12).join(', ')}` +
          `${unciteableCells.length > 12 ? ` (+${String(unciteableCells.length - 12)} more)` : ''} ` +
          '(DATA-10; provIdx -1 is reserved for the pending cell, whose `v` is null)',
      );
    }
    if (gaps.length > 0 && !explained) {
      violations.push(
        `null cells with nothing in meta.unavailable or meta.entitlement to explain them: ` +
          `${[...new Set(gaps)].sort().join(', ')} (FUNCTIONS.md §1.3 rule 6)`,
      );
    }
    if (violations.length === 0) return;

    const details = { code: manifest.code, violations, resultId: meta.resultId };
    if (strictVariant) {
      throw new AppError('INTERNAL', `${manifest.code}: ${violations.join('; ')}.`, { details });
    }
    warn('PAYLOAD_META_MISMATCH', `${manifest.code} payload disagrees with its meta.`, details);
  }

  /**
   * DATA-10's other half: a cited `provenance_id` names a row that exists.
   *
   * `citeProvenance()` enforces this on the `POST /data` path by construction; `ctx.prov.add()`
   * cannot, because a collector has no database. Checking the whole citation set once, here, costs
   * one `SELECT … WHERE provenance_id = ANY(...)` per run and closes the gap for every manifest at
   * once. A fabricated id would otherwise be copied verbatim into `meta.provenance` and into the
   * CSV's `# x-provenance` header, where it reads as an audit trail.
   */
  async function assertProvenanceExists(
    manifest: AnyFunctionManifest,
    meta: PayloadMeta,
  ): Promise<void> {
    const check = deps.provenanceExists;
    if (check === undefined) return;
    const ids = [...new Set(meta.provenance.map((row) => row.provenanceId))].filter(
      (id) => Number.isInteger(id) && id > 0,
    );
    if (ids.length === 0) return;
    const missing = await check(ids);
    if (missing.length === 0) return;

    const details = { code: manifest.code, missing: [...missing], resultId: meta.resultId };
    if (strictVariant) {
      throw new AppError(
        'INTERNAL',
        `${manifest.code} cited provenance rows that do not exist: ${missing.join(', ')}.`,
        { details },
      );
    }
    warn('PROVENANCE_MISSING', `${manifest.code} cited a provenance row that does not exist.`, {
      ...details,
    });
  }

  // ── step 8 ────────────────────────────────────────────────────────────────────────────────
  /**
   * The reproducible half of `meta`. Everything here is a function of `(code, params, asOf, store)`
   * alone — which is exactly ANAL-08's claim — so two runs a week apart produce the same object.
   */
  function stableMeta(
    ctx: ResolveContext,
    decision: EntitlementDecision,
  ): Omit<PayloadMeta, 'traceId' | 'resultId' | 'servedAt' | 'staleness'> {
    const page = ctx.page?.info ?? null;
    return {
      asOf: {
        validAt: ctx.asOf.validAt.toISOString(),
        knownAt: ctx.asOf.knownAt.toISOString(),
      },
      tier: ctx.prov.lowestTier(),
      provenance: withAttribution(ctx.prov.list()),
      entitlement: entitlementNotes(decision),
      unavailable: ctx.unavailable.list(),
      engines: ctx.engines.list(),
      ...(page === null ? {} : { page }),
    };
  }

  /**
   * The five fields two runs are allowed to disagree on (ANAL-08). Kept in their own function so
   * that a field added to `meta` has to be classified by whoever adds it: reproducible fields go
   * above, non-reproducible ones go here, and there is no third place to put one.
   */
  function volatileMeta(
    ctx: ResolveContext,
    http: RunFunctionHttpCtx,
  ): Pick<PayloadMeta, 'traceId' | 'resultId' | 'servedAt' | 'staleness'> {
    return {
      traceId: http.traceId,
      resultId: ulid(deps.clock),
      // Nothing cited is `'blank'`, never `'live'`. `worstState()` folds over the cited rows and
      // an empty fold is the *best* label, so a payload with no provenance at all would be
      // stamped with the strongest freshness claim the vocabulary has. `data/request.ts#buildMeta`
      // makes the same distinction for `POST /data`, and the screen and the data route must not
      // describe the same emptiness differently.
      staleness: ctx.prov.size() === 0 ? 'blank' : ctx.prov.worstState(),
      servedAt: new Date(deps.clock.now()).toISOString(),
    };
  }

  // ── step 10 ───────────────────────────────────────────────────────────────────────────────
  /**
   * ENTL-04's audit rows.
   *
   * The evaluator appends them itself when it was constructed with an `AccessLog`, and reports the
   * handles it got in `decision.logIds`. So: rows already queued ⇒ nothing to do; no handles and a
   * writer here ⇒ the evaluator has none, and the runner queues them, which is the difference
   * between an audited deployment and a silently unaudited one. Neither branch can double-write,
   * because the two are decided by the same fact.
   */
  function logAccess(
    decision: EntitlementDecision,
    manifest: AnyFunctionManifest,
    instrument: Instrument | null,
    http: RunFunctionHttpCtx,
    usage: UsageType,
    requestedTier: Tier,
  ): void {
    const log = deps.accessLog;
    if (log === undefined) return;
    if (decision.logIds.length > 0) return;
    if (decision.fields.length === 0) return;

    const ts = deps.clock.now();
    for (const field of decision.fields) {
      const row: AccessLogRow = {
        ts,
        userId: http.userId,
        firmId: http.firmId,
        sessionId: http.sessionId,
        instrumentId: instrument?.instrumentId ?? null,
        fieldId: field.fieldId,
        fieldClass: field.fieldClass,
        sourceId: field.sourceId,
        requestedTier,
        tier: field.effectiveTier,
        usage,
        purpose: manifest.code,
        decision: field.decision,
        reason: field.reason,
        traceId: http.traceId,
      };
      log.append(row);
    }
  }

  /** FUNC-04's one row per launch. Never awaited, and never able to fail a served payload. */
  function logUsage(args: {
    manifest: AnyFunctionManifest;
    alias: string | undefined;
    params: unknown;
    instrument: Instrument | null;
    body: RunFunctionBody;
    http: RunFunctionHttpCtx;
    durationMs: number;
    variant: unknown;
  }): void {
    const events = deps.usageEvents;
    if (events === undefined) return;
    try {
      events.enqueue({
        ts: deps.clock.now(),
        userId: args.http.userId,
        firmId: args.http.firmId,
        sessionId: args.http.sessionId,
        panelId: args.body.panelId ?? null,
        kind: usageKind(args.body),
        code: args.manifest.code,
        paramsHash: paramsHash(args.params),
        instrumentId: args.instrument?.instrumentId ?? null,
        durationMs: Math.round(args.durationMs),
        traceId: args.http.traceId,
        details: {
          alias: args.alias ?? null,
          variant: args.variant ?? null,
          launchKind: args.body.launchKind ?? 'launch',
        },
      });
    } catch (err) {
      // A rejected usage row must never cost the caller their payload (FUNC-04 is accounting, not
      // authorisation). It is a defect, so it is reported, not swallowed silently.
      warn('USAGE_EVENT_REJECTED', 'usage_events row rejected', {
        code: args.manifest.code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── steps 6-11, the part `page()`, `result()` and `export.ts` re-enter at ─────────────────
  /**
   * Steps 6 through 11 over an already-parsed `params` and an already-resolved `instrument`.
   *
   * This is the reproducible core: it never looks at `body.params` or `body.security` again, so a
   * re-run cannot re-parse, re-resolve or re-alias its way onto a different input than the run it
   * is reproducing. `page()` and `result()` call it with the cached objects; `run()` calls it with
   * the ones steps 1-5 just produced.
   */
  async function resolveAndStamp(args: {
    manifest: AnyFunctionManifest;
    alias: string | undefined;
    params: unknown;
    instrument: Instrument | null;
    asOf: AsOfInstants;
    decision: EntitlementDecision;
    body: RunFunctionBody;
    http: RunFunctionHttpCtx;
    usage: UsageType;
    requestedTier: Tier;
  }): Promise<FunctionResult> {
    const { manifest, instrument, http } = args;
    const pageInput = pageInputFor(manifest, args.body);

    // step 6 — one context over one transaction, gated by the step-5 decision.
    const ctx = buildContext(
      { ...deps.context, db: deps.db },
      {
        user: resolveUserOf(http),
        traceId: http.traceId,
        ...(args.body.panelId === undefined ? {} : { panelId: args.body.panelId }),
        instrument,
        asOf: args.asOf,
        usage: args.usage,
        ...(pageInput === undefined ? {} : { page: pageInput }),
        decision: args.decision,
        purpose: manifest.code,
      },
    );

    // step 7
    const { data, durationMs } = await runResolver(manifest, ctx, args.params);
    assertVariant(manifest, instrument, data);

    // step 8
    const meta: PayloadMeta = {
      ...volatileMeta(ctx, http),
      ...stableMeta(ctx, args.decision),
    };
    assertPayloadMeta(manifest, ctx, data, meta);
    await assertProvenanceExists(manifest, meta);

    // step 9
    const cached: CachedResult = {
      resultId: meta.resultId,
      userId: http.userId,
      firmId: http.firmId,
      code: manifest.code,
      ...(args.alias === undefined ? {} : { alias: args.alias }),
      params: args.params,
      security: instrument?.instrumentId ?? null,
      data,
      meta,
      storedAt: deps.clock.now(),
    };
    deps.resultCache.put(cached);

    // step 10
    logAccess(args.decision, manifest, instrument, http, args.usage, args.requestedTier);
    logUsage({
      manifest,
      alias: args.alias,
      params: args.params,
      instrument,
      body: args.body,
      http,
      durationMs,
      variant: (data as { variant?: unknown } | null)?.variant,
    });

    // step 11
    deps.metrics?.histogram('fn_resolve_ms', { code: manifest.code }).observe(durationMs);
    deps.metrics?.counter('fn_runs_total', { code: manifest.code }).inc();

    return { data, meta, instrumentId: instrument?.instrumentId ?? null };
  }

  // ── run ───────────────────────────────────────────────────────────────────────────────────
  async function run(
    code: string,
    body: RunFunctionBody,
    http: RunFunctionHttpCtx,
  ): Promise<FunctionResult> {
    const usage = usageFor(http);
    const requestedTier: Tier = 'delayed'; // §1.4.3 step 5; a higher tier is a grant, not a request

    const { manifest, alias } = lookup(code); // 1
    const params = parseParams(manifest, alias, body); // 2
    const asOf = asOfOf(body, deps.clock);
    const instrument = await resolveSecurity(manifest, body, asOf); // 3
    assertApplicable(manifest, instrument); // 4
    const decision = await entitle(manifest, instrument, http, usage, requestedTier); // 5

    return resolveAndStamp({
      manifest,
      alias,
      params,
      instrument,
      asOf,
      decision,
      body,
      http,
      usage,
      requestedTier,
    }); // 6-11
  }

  /**
   * Re-enter at step 6 with the *cached* params, security and `asOf`, and the next cursor.
   *
   * The entitlement pre-check (step 5) is re-run rather than reused: a page turn is a new read,
   * minutes after the launch, and a grant that lapsed in between must stop the next page. The
   * instrument is rebuilt from the cached `security` id through the same resolver port, so a page
   * turn and its launch are guaranteed to be about the same instrument row even if the ticker was
   * reassigned.
   */
  async function page(
    resultId: string,
    direction: 'fwd' | 'back',
    http: RunFunctionHttpCtx,
  ): Promise<FunctionResult> {
    const cached = deps.resultCache.get(resultId, http.userId);
    if (cached === undefined) throw resultExpired(resultId);

    const manifest = deps.registry.get(cached.code);
    if (manifest === undefined) throw functionNotFound(cached.code);

    const usage = usageFor(http);
    const requestedTier: Tier = 'delayed';
    const asOf = asOfFromMeta(cached.meta);
    const instrument = await instrumentFor(cached.security, asOf);
    const decision = await entitle(manifest, instrument, http, usage, requestedTier);

    const body: RunFunctionBody = {
      launchKind: 'page',
      page: { cursor: cached.meta.page?.cursor ?? null, direction },
    };

    return resolveAndStamp({
      manifest,
      alias: cached.alias,
      params: cached.params,
      instrument,
      asOf,
      decision,
      body,
      http,
      usage,
      requestedTier,
    });
  }

  /**
   * `GET /results/:resultId` — MSG-04 share links.
   *
   * The producer gets their own payload back untouched. **Anybody else gets a re-run** at the
   * cached `meta.asOf` under their *own* entitlements: the cached `data` was assembled under the
   * producer's grants and may hold a realtime price the viewer's firm has not licensed, so handing
   * it over would be an entitlement bypass dressed up as a convenience. A re-run costs a resolve
   * and returns the same screen at the same instant, with the viewer's denials in
   * `meta.entitlement` — which is what a share link is supposed to mean.
   */
  async function result(resultId: string, http: RunFunctionHttpCtx): Promise<FunctionResult> {
    const own = deps.resultCache.get(resultId, http.userId);
    if (own !== undefined) {
      return { data: own.data, meta: own.meta, instrumentId: own.security };
    }

    const shared = deps.resultCache.peek(resultId, http.firmId);
    if (shared === undefined) throw resultExpired(resultId);

    const manifest = deps.registry.get(shared.code);
    if (manifest === undefined) throw functionNotFound(shared.code);

    const usage = usageFor(http);
    const requestedTier: Tier = 'delayed';
    const asOf = asOfFromMeta(shared.meta);
    const instrument = await instrumentFor(shared.security, asOf);
    assertApplicable(manifest, instrument);
    const decision = await entitle(manifest, instrument, http, usage, requestedTier);

    const body: RunFunctionBody = {
      launchKind: 'launch',
      ...(shared.meta.page === undefined
        ? {}
        : { page: { cursor: shared.meta.page.cursor, direction: 'fwd' as const } }),
    };

    return resolveAndStamp({
      manifest,
      alias: shared.alias,
      params: shared.params,
      instrument,
      asOf,
      decision,
      body,
      http,
      usage,
      requestedTier,
    });
  }

  /** The cached `meta.asOf` back as instants — the re-run reads at the launch's instant, not now. */
  function asOfFromMeta(meta: PayloadMeta): AsOfInstants {
    return {
      validAt: new Date(meta.asOf.validAt),
      knownAt: new Date(meta.asOf.knownAt),
    };
  }

  /** The cached `security` id back as an `Instrument`, through the one resolver port. */
  async function instrumentFor(
    instrumentId: number | null,
    asOf: AsOfInstants,
  ): Promise<Instrument | null> {
    if (instrumentId === null) return null;
    const outcome = await deps.resolveSecurity({ id: instrumentId }, asOf);
    if (outcome.ok) return outcome.instrument;
    throw new NotFoundError(
      outcome.message ?? `Instrument ${instrumentId} could not be re-read.`,
      'SECURITY_NOT_FOUND',
    );
  }

  return { run, page, result };
}
