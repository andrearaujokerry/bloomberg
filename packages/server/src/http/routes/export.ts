/**
 * `http/routes/export.ts` — API.md §9 L1179-1201 (FUNC-03, API-05, ENTL-01), WORKPLAN WP-08.
 *
 *   GET  /functions/:code/csv   the screen's own payload as a file
 *   POST /data/csv              a `DataRequest` as a file
 *
 * The two CSV routes of §9 that are not here belong to other groups and other packages:
 * `/watchlists/:id/export.csv` and `/portfolios/:id/export.csv` ship with WP-09/WP-10's route
 * files, and the compliance exports are WP-07's `admin.ts`.
 *
 * **These routes carry `usage:'export'` end to end.** Not as a label: the evaluator's third rule
 * reads `licence_registry.export_allowed` and an `entitlement_grants.usage_export` column, so a
 * firm may see a number on screen and be refused the same number as a file
 * (`LICENCE_FORBIDS_USAGE`). Any such refusal fails the whole export — `403 ENTITLEMENT_DENIED`
 * with `details.reasons` — because a CSV that silently omits a column is indistinguishable from a
 * CSV of a request that never asked for it.
 *
 * The bytes are built by `functions/export.ts` over `core/functions/csv.ts`; this file is the HTTP
 * shell: parse, authorise, open one transaction, set the §9 headers, send `text/csv`.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { registry as generatedRegistry } from '@terminal/core';
import type { DataRequestInput } from '@terminal/sdk/wire/dataRequest';
import { FunctionCsvParams, FunctionCsvQuery } from '@terminal/sdk/wire/rest/export';

import { withTx } from '../../db/client.js';
import {
  csvForDataRequest,
  csvForFunction,
  type CsvExport,
  type CsvExportDeps,
} from '../../functions/export.js';
import type { RunFunctionHttpCtx } from '../../functions/runner.js';
import { getMetrics } from '../../observability/metrics.js';
import { requireSession } from '../auth/session.js';
import { EXPORT_LIMIT, rateLimit } from '../rateLimit.js';
import { AppError, ValidationFailedError } from '../errors.js';
import { asOfOfRequest, dispatcherFor, quotaHeaderHook, quotasOf } from './data.js';
import {
  ctxOf,
  hostDepsOf,
  licencesFor,
  parse,
  principalOf,
  resultCacheOf,
  runnerFor,
  securityPort,
} from './functions.js';

/** `text/csv; charset=utf-8` — API.md §9 L1187. No BOM: `writeCsv` never emits one. */
const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

/**
 * `?params=<base64url JSON>` (API.md §9 L1187).
 *
 * Base64url rather than a nested query string because the value is the *canonical* parameter
 * object of a run — the same bytes `params_hash` is taken over — and a query encoder that
 * reordered keys or coerced `"1"` to `1` would produce a different run than the one being
 * exported. A malformed value is `400 VALIDATION_FAILED` on `query`, never an empty `{}`.
 */
export function decodeParams(encoded: string | undefined): Record<string, unknown> | undefined {
  if (encoded === undefined) return undefined;
  let text: string;
  try {
    text = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    throw new ValidationFailedError('query', [
      { code: 'custom', path: ['params'], message: 'not base64url' },
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationFailedError('query', [
      { code: 'custom', path: ['params'], message: 'not JSON once decoded' },
    ]);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationFailedError('query', [
      { code: 'custom', path: ['params'], message: 'must decode to a JSON object' },
    ]);
  }
  return parsed as Record<string, unknown>;
}

/** Send a finished export: the §9 headers, then the file. */
function sendCsv(
  reply: { header(k: string, v: string): unknown; type(v: string): unknown },
  out: CsvExport,
): string {
  for (const [name, value] of Object.entries(out.headers)) reply.header(name, value);
  reply.header('cache-control', 'no-store');
  reply.type(CSV_CONTENT_TYPE);
  return out.text;
}

export const exportRoutes: FastifyPluginAsync = async (app) => {
  // §8: an export is a data-bearing response and carries the three quota headers; §8's export row
  // is 2 req/s and 60 per hour, which is the one rate limit with a window longer than a second —
  // a file that leaves the building is audited, charged and deliberately hard to loop over.
  app.addHook('onSend', quotaHeaderHook());

  // ── GET /functions/:code/csv ────────────────────────────────────────────────────────────────
  app.get(
    '/functions/:code/csv',
    { preHandler: [requireSession({ scopes: ['fn:run'] }), rateLimit(EXPORT_LIMIT)] },
    async (request, reply) => {
      const principal = principalOf(request);
      const deps = hostDepsOf(request);
      const { code } = parse(FunctionCsvParams, request.params, 'params');
      const query = parse(FunctionCsvQuery, request.query ?? {}, 'query');
      const params = decodeParams(query.params);

      const entitlements = deps.entitlements;
      if (entitlements === undefined) {
        throw new AppError('ENTITLEMENT_DENIED', 'No entitlement evaluator is wired.', {
          details: { reasons: [] },
        });
      }

      // `asOf` for the re-resolve path: the instants the caller supplied, or now. The services the
      // runner reads through are bound to it, so it has to be known before the transaction opens.
      const asOf = asOfOfRequest(
        {
          ...(query.validAt === undefined ? {} : { validAt: query.validAt }),
          ...(query.knownAt === undefined ? {} : { knownAt: query.knownAt }),
        },
        deps.clock,
      );

      const http: RunFunctionHttpCtx = {
        userId: principal.userId,
        firmId: principal.firmId,
        sessionId: principal.sessionId,
        role: principal.role,
        clientKind: principal.clientKind,
        traceId: request.traceId,
        usage: 'export',
      };

      const quotas = quotasOf(deps);
      const licences = await licencesFor(deps);
      const out = await withTx(ctxOf(principal), async (tx) => {
        // The re-resolve runner is wired WITHOUT a usage-event writer: an export writes exactly
        // one `fn.export` row, and a regenerated export must not also look like a launch
        // (`functions/export.ts#CsvExportDeps.runner`).
        const runner = runnerFor({ deps, tx, asOf, principal, licences });
        const exportDeps: CsvExportDeps = {
          clock: deps.clock,
          registry: registryOfRequest(request),
          resultCache: resultCacheOf(deps),
          entitlements,
          licences,
          ...(deps.functions?.accessLog === undefined
            ? {}
            : { accessLog: deps.functions.accessLog }),
          ...(deps.functions?.usageEvents === undefined
            ? {}
            : { usageEvents: deps.functions.usageEvents }),
          metrics: getMetrics(),
          ...(quotas === undefined ? {} : { quotas }),
          runner,
          resolveSecurity: securityPort(tx),
          ...(deps.functions?.onWarning === undefined
            ? {}
            : { onWarning: deps.functions.onWarning }),
        };

        return csvForFunction(
          exportDeps,
          {
            code,
            ...(query.resultId === undefined ? {} : { resultId: query.resultId }),
            ...(params === undefined ? {} : { params }),
            ...(query.security === undefined ? {} : { security: { ref: query.security } }),
            ...(query.validAt === undefined ? {} : { validAt: query.validAt }),
            ...(query.knownAt === undefined ? {} : { knownAt: query.knownAt }),
          },
          http,
        );
      });

      return sendCsv(reply, out);
    },
  );

  // ── POST /data/csv ──────────────────────────────────────────────────────────────────────────
  app.post(
    '/data/csv',
    { preHandler: [requireSession({ scopes: ['data:read'] }), rateLimit(EXPORT_LIMIT)] },
    async (request, reply) => {
      const principal = principalOf(request);
      const deps = hostDepsOf(request);
      const input = request.body as DataRequestInput;

      const entitlements = deps.entitlements;
      if (entitlements === undefined) {
        throw new AppError('ENTITLEMENT_DENIED', 'No entitlement evaluator is wired.', {
          details: { reasons: [] },
        });
      }

      const http: RunFunctionHttpCtx = {
        userId: principal.userId,
        firmId: principal.firmId,
        sessionId: principal.sessionId,
        role: principal.role,
        clientKind: principal.clientKind,
        traceId: request.traceId,
        usage: 'export',
      };

      const at = asOfOfRequest(
        (input as { asOf?: { validAt?: string; knownAt?: string } }).asOf,
        deps.clock,
      );

      const licences = await licencesFor(deps);
      const out = await withTx(ctxOf(principal), async (tx) => {
        const dispatcher = dispatcherFor({
          tx,
          clock: deps.clock,
          traceId: request.traceId,
          principal,
          entitlements,
          quotas: quotasOf(deps),
          usage: 'export',
          at,
        });
        const exportDeps: CsvExportDeps = {
          clock: deps.clock,
          registry: registryOfRequest(request),
          resultCache: resultCacheOf(deps),
          entitlements,
          licences,
          ...(deps.functions?.usageEvents === undefined
            ? {}
            : { usageEvents: deps.functions.usageEvents }),
          metrics: getMetrics(),
          // The dispatcher charges the datapoint quota itself (API.md §8 rule 7), so the exporter
          // must not charge it a second time for the same rows.
          runner: nullRunner(),
          resolveSecurity: securityPort(tx),
        };
        return csvForDataRequest(
          exportDeps,
          { request: input, dispatch: (req) => dispatcher.dispatch(req) },
          http,
        );
      });

      return sendCsv(reply, out);
    },
  );

  await Promise.resolve();
};

/** The registry this process serves — the same one `GET /functions` publishes. */
function registryOfRequest(request: FastifyRequest): CsvExportDeps['registry'] {
  return hostDepsOf(request).functions?.registry ?? generatedRegistry;
}

/**
 * `POST /data/csv` never re-resolves a function, so it has no runner to give. A throwing stub is
 * the honest value: a future edit that reaches for `deps.runner` on this path fails loudly instead
 * of exporting something the data route never authorised.
 */
function nullRunner(): CsvExportDeps['runner'] {
  const refuse = (): never => {
    throw new AppError('INTERNAL', 'POST /data/csv has no function runner.');
  };
  return { run: refuse, page: refuse, result: refuse };
}
