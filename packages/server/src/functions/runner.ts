/**
 * Function runner — **WP-01 stub**. Owned by WP-08 (FUNCTIONS.md §1.4.3 L317-340, ARCHITECTURE
 * §5, API.md §5.3, WORKPLAN §1.8 L372-373).
 *
 * The real `runFunction` is the ten-step pipeline of FUNCTIONS.md §1.4.3: manifest lookup →
 * parameter parse → security resolution → applicability → entitlement evaluation → context build →
 * resolver → meta assembly → result cache → access/usage logging. None of that exists yet, and a
 * half-implementation would be worse than none: a payload without `meta.provenance` or without an
 * entitlement decision violates DATA-10 and ENTL-05.
 *
 * So this throws. The signature is the one WP-08 fills in, so call sites written against it compile
 * today and keep compiling.
 */

import { NotImplementedError } from '../http/errors.js';

/** FUNCTIONS.md §1.4.3 step 1 — the request body a function launch carries (API.md §5.3). */
export interface RunFunctionBody {
  /** Raw function parameters, merged over `manifest.aliasParams[alias]` before parsing. */
  params?: Record<string, unknown>;
  /** The security context, e.g. `AAPL US Equity`; ignored when `assetClasses === 'none'`. */
  security?: string;
  /** Pagination cursor for paged screens. */
  page?: { cursor: string | null; direction: 'fwd' | 'back' };
  /** Which panel launched it — recorded on the `usage_events` row. */
  panelId?: string;
  /** `fn.launch` vs `fn.param` vs `fn.page`, for FUNC-04 usage accounting. */
  launchKind?: 'launch' | 'param' | 'page';
}

/** The caller's HTTP context: identity, trace and usage type. Widened by WP-08. */
export interface RunFunctionHttpCtx {
  userId: number;
  firmId: number;
  sessionId: string;
  role: string;
  traceId: string;
  usage: 'display' | 'export' | 'api';
}

/**
 * Run a function by code.
 *
 * @throws NotImplementedError — always, until WP-08 implements FUNCTIONS.md §1.4.3.
 */
export function runFunction(
  code: string,
  body: RunFunctionBody,
  http: RunFunctionHttpCtx,
): Promise<never> {
  void body;
  void http;
  throw new NotImplementedError(`functions/runner.ts#runFunction(${code}) — WP-08`);
}
