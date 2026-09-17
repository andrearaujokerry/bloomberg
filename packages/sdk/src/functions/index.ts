/**
 * `functions/index.ts` — the function registry as the SDK exposes it (API.md §10.3 L1359-1362).
 *
 * The registry is not re-implemented here: it is `core/src/functions/registry.ts`, re-exported so
 * that `@terminal/sdk` is the web client's only import surface (ARCHITECTURE §1.1). The one piece of
 * behaviour this module adds is `runFunction()`, which validates the parameters locally against the
 * manifest before the request leaves the process — a bad `GP` parameter must fail in the command
 * line, not at the server (FUNC-01).
 *
 * The route is resolved through `RestClient.routeIdFor('POST', '/functions/:code/run')`, so adding
 * or renaming routes in `wire/rest/functions.ts` never touches this file.
 */
import { registry } from '@terminal/core';
import type {
  FunctionCode,
  FunctionManifest,
  FunctionRegistry,
  Payload,
  PayloadOf,
} from '@terminal/core';

import { TerminalApiError, type RequestOptions, type TerminalClient } from '../client/rest.js';

export { registry };
export type { FunctionCode, FunctionManifest, FunctionRegistry, Payload, PayloadOf };

/**
 * The body of `POST /functions/:code/run` (`FunctionRunRequest`, API.md §5.3). The authoritative
 * schema is `wire/rest/functions.ts`; this structural view exists so `runFunction()` can be called
 * without importing the generated barrel, and the request is validated by that schema anyway on its
 * way through `RestClient`.
 */
export interface FunctionRunRequest {
  readonly params?: Readonly<Record<string, unknown>> | undefined;
  readonly security?: unknown;
  readonly securities?: unknown;
  readonly asOf?: { validAt?: string; knownAt?: string } | undefined;
  readonly [key: string]: unknown;
}

interface ParamSchema {
  safeParse(data: unknown): { success: boolean; error?: { issues?: unknown } };
}

function paramSchemaOf(manifest: unknown): ParamSchema | null {
  const bag = manifest as Record<string, unknown>;
  const params = bag.params;
  return typeof params === 'object' &&
    params !== null &&
    typeof (params as { safeParse?: unknown }).safeParse === 'function'
    ? (params as ParamSchema)
    : null;
}

/**
 * API.md §10.3 L1362 — `= client.fn.run`, with `manifest.params` checked locally first.
 * Throws `TerminalApiError { code: 'FUNCTION_NOT_FOUND' }` for an unknown code and
 * `{ code: 'VALIDATION_FAILED', details.location: 'fnParams' }` for bad parameters.
 */
export async function runFunction<C extends FunctionCode>(
  client: TerminalClient,
  code: C,
  req: FunctionRunRequest,
  init?: RequestOptions,
): Promise<Payload<PayloadOf<C>>> {
  const traceId = init?.traceId ?? '';
  const manifest = registry.get(code);
  if (manifest === undefined) {
    throw new TerminalApiError({
      code: 'FUNCTION_NOT_FOUND',
      message: `unknown function '${String(code)}'`,
      status: 0,
      traceId,
      details: { code },
    });
  }
  const schema = paramSchemaOf(manifest);
  if (schema !== null && req.params !== undefined) {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      const issues = parsed.error?.issues;
      throw new TerminalApiError({
        code: 'VALIDATION_FAILED',
        message: `${String(code)}: invalid parameters`,
        status: 0,
        traceId,
        details: {
          location: 'fnParams',
          issues: Array.isArray(issues) ? issues : [],
          grammar: (manifest as unknown as Record<string, unknown>).paramGrammar ?? null,
        },
      });
    }
  }

  const routeId = client.rest.routeIdFor('POST', '/functions/:code/run');
  if (routeId === undefined) {
    throw new TerminalApiError({
      code: 'NOT_FOUND',
      message: 'wire/rest declares no route for POST /functions/:code/run',
      status: 0,
      traceId,
    });
  }
  return (await client.rest.call(routeId, { params: { code }, body: req }, init ?? {})) as Payload<
    PayloadOf<C>
  >;
}
