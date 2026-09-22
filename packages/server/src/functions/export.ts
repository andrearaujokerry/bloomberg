/**
 * `functions/export.ts` — CSV export (FUNCTIONS.md §1.4.4 L351-368, API.md §9 L1179-1201),
 * WORKPLAN WP-08.
 *
 * Two exporters live here, because they answer the same question about the same data and must not
 * answer it differently:
 *
 *  - {@link csvForFunction} — `GET /functions/:code/csv`. The cached payload of a screen, or the
 *    same payload re-resolved at the `asOf` the screen was drawn at.
 *  - {@link csvForDataRequest} — `POST /data/csv`. A `DataRequest` served through WP-04's
 *    dispatcher and laid out per API.md §9 ("reference → one row per security; historical/intraday
 *    → one row per `(security, index)`; tick → one row per tick").
 *
 * Three rules shape this file, and each one is a rule somebody could plausibly "optimise" away:
 *
 * **1. The bytes come from `core/functions/csv.ts`, never from here.** `toCsv` builds the document
 * from the *manifest's own* `csv` spec over the *cached payload*, and `writeCsv` serialises it.
 * That is ARCHITECTURE §15's "export equality": the screen and the file are two renderings of one
 * object, so they cannot disagree about a number. A second serialiser in this module — even a
 * one-line `rows.join(',')` for the `/data/csv` path — would be a second source of truth, so the
 * data path builds a `CsvDocument` by hand and hands it to the *same* `writeCsv`.
 *
 * **2. Any denied field fails the whole export.** Not the denied column, not a blank cell: the
 * whole file, with `403 ENTITLEMENT_DENIED` and `details.reasons` (API.md §9 L1195-1199,
 * ARCHITECTURE §10 rule 2). A screen may show a partial grid with per-cell reasons because the
 * user can see the reason; a CSV leaves the building, and a column silently missing from a
 * spreadsheet is indistinguishable from a column that was never asked for. The entitlement is
 * therefore re-evaluated here with `usage:'export'` and `purpose:'export:<CODE>'` even when the
 * payload is served straight out of the result cache — the launch was checked as `'display'`, and
 * `licence_registry.export_allowed = false` is a thing that is true of a licence and not of a
 * screen (`LICENCE_FORBIDS_USAGE`).
 *
 * **3. An export is audited and charged like any other read.** `usage_events kind='fn.export'`,
 * the `access_log` rows of the export decision, and the datapoint quota (API.md §9 L1200-1201).
 * The usage row is the accounting record of a file that left the building; it is written once per
 * export, which is why {@link CsvExportDeps.runner} is documented as a runner wired *without* a
 * `usageEvents` writer: a re-resolve is an internal step of one export, not a second launch.
 */

import type {
  AssetClass,
  Clock,
  CsvColumn,
  CsvDocument,
  EntitlementDecision,
  FieldId,
  Instrument,
  PayloadMeta,
  Tier,
} from '@terminal/core';
import type { AnyFunctionManifest, FunctionRegistry } from '@terminal/core';
import { standardHeaderLines, toCsv, writeCsv } from '@terminal/core';
import type { SecurityRefInput } from '@terminal/sdk/wire/common';
import type { DataRequestInput, DataResponse, DataResult } from '@terminal/sdk/wire/dataRequest';

import type { AccessLog, AccessLogRow } from '../entitlements/accessLog.js';
import type { Evaluator } from '../entitlements/evaluator.js';
import type { LicenceRegistry } from '../entitlements/licenceRegistry.js';
import { quotaExceededError, type Quotas } from '../entitlements/quotas.js';
import { AppError, BadRequestError, NotFoundError } from '../http/errors.js';
import type { Metrics } from '../observability/metrics.js';
import { paramsHash, type UsageEvents } from '../observability/usageEvents.js';
import type { CachedResult, ResultCache } from './resultCache.js';
import {
  entitlementNotes,
  type AsOfInstants,
  type FunctionRunner,
  type ResolvedSecurity,
  type RunFunctionHttpCtx,
} from './runner.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The tier an export asks for, as the runner's step 5 does: a higher one is a grant, not a wish. */
const REQUESTED_TIER: Tier = 'delayed';

export interface CsvExportDeps {
  clock: Clock;
  registry: FunctionRegistry;
  resultCache: ResultCache;
  entitlements: Evaluator;
  licences: LicenceRegistry;
  /** ENTL-04. Rows are appended only when the evaluator did not already queue them. */
  accessLog?: AccessLog;
  /** FUNC-04. Exactly one `fn.export` row per export. */
  usageEvents?: UsageEvents;
  metrics?: Metrics;
  /** API-06. Omitted ⇒ no counting; never a silent free export in a deployment that has quotas. */
  quotas?: Quotas;
  /**
   * The runner used to re-resolve an expired result.
   *
   * **Wire it without a `usageEvents` writer.** A re-resolve is a step inside one export, and a
   * runner that logs would make the regenerated path write `fn.launch` *and* `fn.export` while the
   * cached path wrote only `fn.export` — the same export billed two different ways depending on
   * whether a ten-minute cache happened to still hold the result.
   */
  runner: FunctionRunner;
  /** The same security port the runner uses, so an export and its launch name one instrument row. */
  resolveSecurity(ref: SecurityRefInput, asOf: AsOfInstants): Promise<ResolvedSecurity>;
  /** Where a swallowed accounting failure is reported. */
  onWarning?: (event: { code: string; message: string; details: Record<string, unknown> }) => void;
}

/** `FunctionCsvQuery` (API.md §9 L1187) after the route has decoded `params` from base64url. */
export interface CsvForFunctionArgs {
  code: string;
  /** Preferred: the payload's `meta.resultId`. */
  resultId?: string;
  /** The re-resolve tuple, used when the cached result has expired. */
  params?: Record<string, unknown>;
  security?: SecurityRefInput;
  validAt?: string;
  knownAt?: string;
  panelId?: string;
}

/**
 * What a CSV route needs to answer.
 *
 * **Deviation from the shared contract, deliberate.** The contract writes
 * `csvForFunction(...): Promise<CsvDocument>`. A `CsvDocument` carries the filename, the columns
 * and the rows, but none of the seven response headers API.md §9 L1214-1217 requires
 * (`x-as-of-valid`, `x-as-of-known`, `x-provenance`, `x-engine-version`, `x-regenerated`,
 * `content-disposition`) — those are facts about the *run*, not about the table. Returning the
 * document alone would force the route to re-derive them from a `meta` it does not have, or to
 * guess. The document is still here, unchanged, as `document`.
 */
export interface CsvExport {
  document: CsvDocument;
  /** The file, exactly as it goes on the wire: UTF-8, RFC 4180, CRLF, no BOM. */
  text: string;
  filename: string;
  /** True when the payload was re-resolved rather than read from the result cache. */
  regenerated: boolean;
  meta: PayloadMeta;
  /** The §9 response headers, ready for `reply.header`. */
  headers: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────────────────────

const functionNotFound = (code: string): AppError =>
  new NotFoundError(`No function '${code}'.`, 'FUNCTION_NOT_FOUND', { code });

const resultExpired = (resultId: string): AppError =>
  new NotFoundError(
    `Result ${resultId} is no longer cached; re-send with params, validAt and knownAt to ` +
      're-resolve it.',
    'RESULT_EXPIRED',
    { resultId },
  );

/**
 * API.md §9's refusal. `details.reasons` is the *denied* subset, in the order the evaluator
 * returned it, so the client can name the column that stopped the file.
 */
const exportDenied = (code: string, decision: EntitlementDecision): AppError => {
  const reasons = entitlementNotes(decision).filter((n) => n.decision === 'deny');
  return new AppError(
    'ENTITLEMENT_DENIED',
    `Export of ${code} refused: ${reasons.length} field(s) are not licensed for export.`,
    { details: { reasons, code } },
  );
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The cached `meta.asOf` back as instants — a re-resolve reads at the launch's instant, not now. */
function asOfFromMeta(meta: PayloadMeta): AsOfInstants {
  return { validAt: new Date(meta.asOf.validAt), knownAt: new Date(meta.asOf.knownAt) };
}

/**
 * The `# source:` lines: one attribution per cited source, first citation first, deduplicated.
 *
 * `meta.provenance[].attribution` is already filled by the runner from `licence_registry`; the
 * registry is consulted only for a row that arrived empty (a context built without one). A source
 * whose licence has no attribution line contributes nothing rather than an empty `;` separator.
 */
function attributionsOf(meta: PayloadMeta, licences: LicenceRegistry): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const row of meta.provenance) {
    const text =
      row.attribution !== ''
        ? row.attribution
        : (licences.licence(row.sourceId)?.attribution ?? '');
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
  }
  return lines;
}

function engineLines(meta: PayloadMeta): string[] {
  return meta.engines.map((e) => `${e.name}/${e.version}`);
}

function provenanceIds(meta: PayloadMeta): number[] {
  return meta.provenance.map((p) => p.provenanceId);
}

/** Rows × columns — what an export delivers, and therefore what API-06 charges for. */
function dataPointsOf(document: CsvDocument): number {
  return document.rows.length * document.columns.length;
}

/** The §9 response headers (API.md L1214-1217). */
function headersFor(
  meta: PayloadMeta,
  filename: string,
  regenerated: boolean,
): Record<string, string> {
  return {
    'x-as-of-valid': meta.asOf.validAt,
    'x-as-of-known': meta.asOf.knownAt,
    'x-provenance': provenanceIds(meta).join(','),
    'x-engine-version': engineLines(meta).join(','),
    'x-regenerated': regenerated ? 'true' : 'false',
    'content-disposition': `attachment; filename="${filename.replace(/["\\]/g, '')}"`,
  };
}

/**
 * ENTL-04's audit rows for the export decision.
 *
 * Same rule as `runner.ts#logAccess`: the evaluator writes them itself when it holds an
 * `AccessLog` (and reports the handles in `decision.logIds`), so this appends only when it does
 * not. The two branches are decided by the same fact, so a row cannot be written twice or lost.
 */
function logAccess(
  deps: CsvExportDeps,
  decision: EntitlementDecision,
  purpose: string,
  instrumentId: number | null,
  http: RunFunctionHttpCtx,
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
      instrumentId,
      fieldId: field.fieldId,
      fieldClass: field.fieldClass,
      sourceId: field.sourceId,
      requestedTier: REQUESTED_TIER,
      tier: field.effectiveTier,
      usage: 'export',
      purpose,
      decision: field.decision,
      reason: field.reason,
      traceId: http.traceId,
    };
    log.append(row);
  }
}

/** FUNC-04's one row per export. Never awaited, and never able to fail a file that is ready. */
function logUsage(
  deps: CsvExportDeps,
  args: {
    code: string;
    alias: string | null;
    params: unknown;
    instrumentId: number | null;
    panelId: string | null;
    regenerated: boolean;
    resultId: string;
    rows: number;
    columns: number;
    http: RunFunctionHttpCtx;
  },
): void {
  const events = deps.usageEvents;
  if (events === undefined) return;
  try {
    events.enqueue({
      ts: deps.clock.now(),
      userId: args.http.userId,
      firmId: args.http.firmId,
      sessionId: args.http.sessionId,
      panelId: args.panelId,
      kind: 'fn.export',
      code: args.code,
      paramsHash: paramsHash(args.params),
      instrumentId: args.instrumentId,
      durationMs: null,
      traceId: args.http.traceId,
      details: {
        alias: args.alias,
        regenerated: args.regenerated,
        resultId: args.resultId,
        rows: args.rows,
        columns: args.columns,
      },
    });
  } catch (err) {
    deps.onWarning?.({
      code: 'USAGE_EVENT_REJECTED',
      message: 'usage_events row rejected',
      details: { code: args.code, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * API-06. `check` before `record`, and both before the caller sees a byte: a quota that is only
 * counted after the file is sent is a quota that can be overrun by exactly one export, every time.
 */
async function charge(
  deps: CsvExportDeps,
  http: RunFunctionHttpCtx,
  instrumentIds: readonly number[],
  dataPoints: number,
): Promise<void> {
  const quotas = deps.quotas;
  if (quotas === undefined) return;
  const ctx = {
    userId: http.userId,
    firmId: http.firmId,
    clientKind: http.clientKind,
    instrumentIds,
    dataPoints,
  };
  const check = await quotas.check(ctx);
  if (!check.ok) throw quotaExceededError(check);
  await quotas.record({
    userId: http.userId,
    firmId: http.firmId,
    instrumentIds,
    dataPoints,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GET /functions/:code/csv
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * FUNCTIONS.md §1.4.4:
 *
 * ```
 * 1. cached = args.resultId ? resultCache.get(resultId, user) : undefined
 *    miss with resultId only → 404 RESULT_EXPIRED unless params+validAt+knownAt are also supplied
 * 2. if !cached: re-run the runner at asOf = { validAt, knownAt } with usage 'export'; regenerated
 * 3. decision = evaluate({ …, usage:'export', purpose:'export:'+code }); ANY deny → 403
 * 4. toCsv over the manifest's own spec, writeCsv, attribution from licence_registry
 * 5. one usage_events row, the access-log rows, the datapoint quota
 * ```
 */
export async function csvForFunction(
  deps: CsvExportDeps,
  args: CsvForFunctionArgs,
  http: RunFunctionHttpCtx,
): Promise<CsvExport> {
  // Step 1 — the manifest, by code or by alias.
  const manifest = deps.registry.get(args.code);
  if (manifest === undefined) throw functionNotFound(args.code);
  const typed = args.code.trim().toUpperCase();
  const alias = typed === manifest.code ? null : typed;

  const { cached, regenerated } = await payloadFor(deps, manifest, args, http);

  // Step 3 — the instrument, for the asset class the field set depends on and for the filename.
  const asOf = asOfFromMeta(cached.meta);
  const resolved = await instrumentFor(deps, cached.security, asOf);
  const assetClass: AssetClass | null = resolved.instrument?.assetClass ?? null;
  const display = resolved.display;

  const purpose = `export:${manifest.code}`;
  const fieldIds: FieldId[] = [...manifest.fieldIds(assetClass)];
  const decision = await deps.entitlements.evaluate({
    userId: http.userId,
    firmId: http.firmId,
    sessionId: http.sessionId,
    instrumentId: resolved.instrument?.instrumentId ?? null,
    assetClass,
    fieldIds,
    tier: REQUESTED_TIER,
    usage: 'export',
    purpose,
    traceId: http.traceId,
  });

  logAccess(deps, decision, purpose, resolved.instrument?.instrumentId ?? null, http);

  // Rule 2 — ANY denial ends the export. Checked before a single cell is rendered, so there is no
  // half-built file to leak and no temptation to "just drop the column".
  if (decision.fields.some((f) => f.decision === 'deny')) {
    throw exportDenied(manifest.code, decision);
  }

  // Step 4 — the manifest's own CSV spec over the cached payload.
  const attribution = attributionsOf(cached.meta, deps.licences);
  const document = toCsv(manifest, cached.data, cached.params, {
    display,
    asOf: cached.meta.asOf.validAt,
    attribution,
  });

  const text = writeCsv(
    document,
    standardHeaderLines({
      code: manifest.code,
      alias,
      display,
      params: cached.params,
      validAt: cached.meta.asOf.validAt,
      knownAt: cached.meta.asOf.knownAt,
      tier: cached.meta.tier,
      staleness: cached.meta.staleness,
      attribution,
      provenance: provenanceIds(cached.meta),
      engines: engineLines(cached.meta),
      traceId: http.traceId,
      regenerated,
      // A *downgraded* field is still exported, blanked, and says so in the header; a *denied*
      // one never gets here (rule 2 above).
      entitlement: cached.meta.entitlement.map((e) => ({ fieldId: e.fieldId, reason: e.reason })),
      unavailable: cached.meta.unavailable.map((u) => ({ field: u.field, reason: u.reason })),
    }),
  );

  // Step 5 — accounting.
  const instrumentIds = resolved.instrument === null ? [] : [resolved.instrument.instrumentId];
  await charge(deps, http, instrumentIds, dataPointsOf(document));
  logUsage(deps, {
    code: manifest.code,
    alias,
    params: cached.params,
    instrumentId: resolved.instrument?.instrumentId ?? null,
    panelId: args.panelId ?? null,
    regenerated,
    resultId: cached.meta.resultId,
    rows: document.rows.length,
    columns: document.columns.length,
    http,
  });
  deps.metrics?.counter('fn_exports_total', { code: manifest.code }).inc();

  return {
    document,
    text,
    filename: document.filename,
    regenerated,
    meta: cached.meta,
    headers: headersFor(cached.meta, document.filename, regenerated),
  };
}

/**
 * Steps 1-2: the cached payload, or a re-resolve at the supplied `asOf`.
 *
 * The re-resolve goes through the runner rather than through a private copy of steps 6-8, so an
 * export cannot drift from the screen it is exporting: same parse, same variant choice, same
 * `meta`. The result it produces is in the cache by the time `run` returns (step 9), which is why
 * this reads it back by `resultId` instead of rebuilding a `CachedResult` here.
 */
async function payloadFor(
  deps: CsvExportDeps,
  manifest: AnyFunctionManifest,
  args: CsvForFunctionArgs,
  http: RunFunctionHttpCtx,
): Promise<{ cached: CachedResult; regenerated: boolean }> {
  if (args.resultId !== undefined) {
    const hit = deps.resultCache.get(args.resultId, http.userId);
    if (hit !== undefined) {
      if (hit.code !== manifest.code) {
        // The id names somebody else's screen. Treated as expired rather than as a mismatch: the
        // holder of a resultId learns nothing about what it belongs to.
        throw resultExpired(args.resultId);
      }
      return { cached: hit, regenerated: false };
    }
    if (!canRegenerate(args)) throw resultExpired(args.resultId);
  }

  if (!canRegenerate(args)) {
    throw new BadRequestError(
      'A CSV export needs either resultId, or params with validAt and knownAt to re-resolve ' +
        'at (API.md §9).',
      { code: manifest.code },
    );
  }

  const result = await deps.runner.run(
    manifest.code,
    {
      params: args.params ?? {},
      ...(args.security === undefined ? {} : { security: args.security }),
      // `args.validAt`/`knownAt` are present — `canRegenerate` is what proved it.
      asOf: { validAt: args.validAt, knownAt: args.knownAt },
      ...(args.panelId === undefined ? {} : { panelId: args.panelId }),
      launchKind: 'refresh',
    },
    { ...http, usage: 'export' },
  );

  const stored = deps.resultCache.get(result.meta.resultId, http.userId);
  if (stored !== undefined) return { cached: stored, regenerated: true };

  // A cache that refused the result (an unusual configuration, never the default) must not turn a
  // successful export into a 404: the payload is in hand, so it is exported.
  //
  // `security` comes from the runner's own answer rather than being left `null`. The export
  // subject is what `csvForFunction` evaluates the entitlement against, picks the field set for
  // and names the file after; a `null` here would evaluate an instrument-scoped denial about no
  // instrument at all, check `manifest.fieldIds(null)` instead of the asset class's field set, and
  // write the ENTL-04 rows with `instrument_id NULL` — three fail-open consequences of a branch
  // that exists only to keep a *successful* export from becoming a 404.
  return {
    cached: {
      resultId: result.meta.resultId,
      userId: http.userId,
      firmId: http.firmId,
      code: manifest.code,
      params: args.params ?? {},
      security: result.instrumentId,
      data: result.data,
      meta: result.meta,
      storedAt: deps.clock.now(),
    },
    regenerated: true,
  };
}

/** The §9 re-resolve tuple: `params` **and** both instants. Two of the three is not a request. */
function canRegenerate(args: CsvForFunctionArgs): args is CsvForFunctionArgs & {
  params: Record<string, unknown>;
  validAt: string;
  knownAt: string;
} {
  return args.params !== undefined && args.validAt !== undefined && args.knownAt !== undefined;
}

/** The cached `security` id back as an instrument, through the one resolver port. */
async function instrumentFor(
  deps: CsvExportDeps,
  instrumentId: number | null,
  asOf: AsOfInstants,
): Promise<{ instrument: Instrument | null; display: string | null }> {
  if (instrumentId === null) return { instrument: null, display: null };
  const outcome = await deps.resolveSecurity({ id: instrumentId }, asOf);
  if (!outcome.ok) {
    throw new NotFoundError(
      outcome.message ?? `Instrument ${instrumentId} could not be re-read for export.`,
      'SECURITY_NOT_FOUND',
    );
  }
  return { instrument: outcome.instrument, display: outcome.display ?? outcome.instrument.name };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// POST /data/csv
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface DataCsvArgs {
  request: DataRequestInput;
  /** The dispatcher, already built over the request transaction with `usage:'export'` forced. */
  dispatch(input: DataRequestInput): Promise<DataResponse>;
}

/**
 * `POST /data/csv` (API.md §9 L1188).
 *
 * The dispatcher does the entitlement work — it refuses the whole request when nothing is servable
 * — but it is built for the *screen* contract, where a denied field is a blank cell with a reason
 * (ENTL-05). §9 is stricter, so the response is inspected here: any `r[field]` reason anywhere in
 * the results means a cell the caller asked for is not in the file, and the export is refused.
 * That check is on the *response*, not on a second evaluation, so it catches a denial however it
 * arose — grant, licence or tier.
 */
export async function csvForDataRequest(
  deps: CsvExportDeps,
  args: DataCsvArgs,
  http: RunFunctionHttpCtx,
): Promise<CsvExport> {
  const response = await args.dispatch(args.request);
  // `Meta.provenance[].requestKey` is `string | undefined` on the wire and `string` when present
  // on `PayloadProvenance`; rebuilt rather than spread so the optional key is absent, not
  // `undefined` (`exactOptionalPropertyTypes`).
  const meta: PayloadMeta = {
    traceId: response.meta.traceId,
    resultId: '',
    asOf: { validAt: response.meta.asOf.validAt, knownAt: response.meta.asOf.knownAt },
    tier: response.meta.tier,
    staleness: response.meta.staleness,
    provenance: response.meta.provenance.map((row) => ({
      idx: row.idx,
      sourceId: row.sourceId,
      provenanceId: row.provenanceId,
      capturedAt: row.capturedAt,
      sourceTs: row.sourceTs,
      attribution: row.attribution,
      ...(row.requestKey === undefined ? {} : { requestKey: row.requestKey }),
    })),
    entitlement: response.meta.entitlement.map((n) => ({ ...n })),
    unavailable: response.meta.unavailable.map((n) => ({ ...n })),
    engines: response.meta.engines.map((e) => ({ ...e })),
    ...(response.meta.adjustments === undefined
      ? {}
      : { adjustments: response.meta.adjustments.map((a) => ({ ...a })) }),
    servedAt: response.meta.servedAt,
    ...(response.meta.quota === undefined ? {} : { quota: { ...response.meta.quota } }),
  };

  const denials = deniedCells(response);
  if (denials.length > 0) {
    throw new AppError(
      'ENTITLEMENT_DENIED',
      `Export refused: ${denials.length} field(s) are not licensed for export.`,
      { details: { reasons: denials } },
    );
  }

  const document = dataCsvDocument(
    response,
    attributionsOf(meta, deps.licences),
    meta.asOf.validAt,
  );
  const text = writeCsv(
    document,
    standardHeaderLines({
      code: `DATA:${args.request.kind}`,
      display: null,
      params: args.request,
      validAt: meta.asOf.validAt,
      knownAt: meta.asOf.knownAt,
      tier: meta.tier,
      staleness: meta.staleness,
      attribution: document.attribution,
      provenance: provenanceIds(meta),
      engines: engineLines(meta),
      traceId: http.traceId,
      regenerated: false,
      unavailable: meta.unavailable.map((u) => ({ field: u.field, reason: u.reason })),
    }),
  );

  const instrumentIds = response.results
    .map((r) => r.instrument?.instrumentId)
    .filter((id): id is number => typeof id === 'number');
  await charge(deps, http, instrumentIds, dataPointsOf(document));
  logUsage(deps, {
    code: `DATA_${args.request.kind.toUpperCase()}`,
    alias: null,
    params: args.request,
    instrumentId: instrumentIds[0] ?? null,
    panelId: null,
    regenerated: false,
    resultId: '',
    rows: document.rows.length,
    columns: document.columns.length,
    http,
  });
  deps.metrics?.counter('data_exports_total', { kind: String(args.request.kind) }).inc();

  return {
    document,
    text,
    filename: document.filename,
    regenerated: false,
    meta,
    headers: headersFor(meta, document.filename, false),
  };
}

/** Every `(security, field)` the response blanked with a reason — §9's "any denied field". */
function deniedCells(
  response: DataResponse,
): { security: string; fieldId: string; reason: string }[] {
  const out: { security: string; fieldId: string; reason: string }[] = [];
  for (const result of response.results) {
    const reasons = result.r;
    if (reasons === undefined) continue;
    for (const [fieldId, reason] of Object.entries(reasons)) {
      out.push({ security: displayOf(result), fieldId, reason });
    }
  }
  return out;
}

function displayOf(result: DataResult): string {
  if (result.instrument !== null) return result.instrument.display;
  const ref: SecurityRefInput = result.security;
  if ('ref' in ref) return ref.ref;
  if ('formula' in ref) return ref.formula;
  return `#${String(ref.id)}`;
}

/**
 * The §9 layout, as one `CsvDocument` so that `writeCsv` — the one serialiser — does the bytes.
 *
 * A leading `security` column on every kind, because a `DataRequest` always names a list: a file
 * whose rows are only distinguishable by position is not something a spreadsheet can sort.
 */
function dataCsvDocument(response: DataResponse, attribution: string[], asOf: string): CsvDocument {
  const stamp = asOf.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const kind = kindOf(response);
  const columns: CsvColumn[] = [{ id: 'security', label: 'Security', type: 'string' }];
  const rows: CsvDocument['rows'] = [];

  if (kind === 'series') {
    const fields = seriesFields(response);
    columns.push({ id: 'index', label: 'Index', type: 'string' });
    for (const field of fields) columns.push({ id: field, label: field, type: 'number' });
    for (const result of response.results) {
      const series = result.series;
      if (series === undefined) continue;
      for (const [i, key] of series.index.entries()) {
        const row = series.rows[i] ?? [];
        rows.push([
          displayOf(result),
          key,
          ...fields.map((field) => {
            const at = series.columns.indexOf(field);
            return at < 0 ? null : (row[at] ?? null);
          }),
        ]);
      }
    }
  } else if (kind === 'tick') {
    const fields = tickFields(response);
    columns.push(
      { id: 'capTs', label: 'Captured', type: 'string' },
      { id: 'srcTs', label: 'Source time', type: 'string' },
      { id: 'kind', label: 'Kind', type: 'string' },
    );
    for (const field of fields) columns.push({ id: field, label: field, type: 'number' });
    for (const result of response.results) {
      for (const tick of result.ticks ?? []) {
        rows.push([
          displayOf(result),
          tick.capTs,
          tick.srcTs,
          tick.kind,
          ...fields.map((field) => cellOf(tick.f[field])),
        ]);
      }
    }
  } else {
    const fields = recordFields(response);
    for (const field of fields) columns.push({ id: field, label: field, type: 'string' });
    for (const result of response.results) {
      rows.push([displayOf(result), ...fields.map((field) => cellOf(result.fields?.[field]))]);
    }
  }

  return {
    filename: `DATA_${String(kindOf(response)).toUpperCase()}_${stamp}.csv`,
    attribution,
    asOf,
    columns,
    rows,
  };
}

function kindOf(response: DataResponse): 'series' | 'tick' | 'record' {
  for (const result of response.results) {
    if (result.series !== undefined) return 'series';
    if (result.ticks !== undefined) return 'tick';
  }
  return 'record';
}

/** Column order is first-seen order across the results, so two securities line up. */
function seriesFields(response: DataResponse): string[] {
  const out: string[] = [];
  for (const result of response.results) {
    for (const field of result.series?.columns ?? []) if (!out.includes(field)) out.push(field);
  }
  return out;
}

function tickFields(response: DataResponse): string[] {
  const out: string[] = [];
  for (const result of response.results) {
    for (const tick of result.ticks ?? []) {
      for (const field of Object.keys(tick.f)) if (!out.includes(field)) out.push(field);
    }
  }
  return out;
}

function recordFields(response: DataResponse): string[] {
  const out: string[] = [];
  for (const result of response.results) {
    for (const field of Object.keys(result.fields ?? {})) if (!out.includes(field)) out.push(field);
  }
  return out;
}

/** A `FieldValue` as a CSV cell. Objects have no place in a one-table document. */
function cellOf(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}
