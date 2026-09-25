/**
 * `@terminal/sdk` — the only IO boundary the web client has (ARCHITECTURE §1.1, API.md §10).
 *
 * One package for the browser and for Node 22 (ESM, `@terminal/core` as a peer dependency). Every
 * number the terminal shows is reachable from here: the wire schemas (`wire/*`), the REST transport
 * (`client/rest.ts`), the WebSocket client (`client/ws.ts`, WP-13), the field dictionary and the
 * function registry.
 *
 * ```ts
 * import { createClient } from '@terminal/sdk';
 * const api = createClient({ baseUrl: 'http://localhost:8080', clientVersion: 'sdk-js/0.1.0' });
 * const session = await api.auth.session();
 * ```
 */

// ── Wire vocabulary ───────────────────────────────────────────────────────────────────────────
// `wire/envelope.ts` already re-exports `ReasonCode`, so `wire/reasonCodes.ts` contributes only the
// two tables that are unique to it (a duplicate `export *` would be an ambiguous star export).
export * from './wire/envelope.js';
export { REASON_CODES, REASON_CODE_MEANINGS } from './wire/reasonCodes.js';
export * from './wire/ws.js';
export * from './wire/dataRequest.js';

/**
 * The GENERATED route table (`scripts/gen-function-index.ts` over `wire/rest/*.ts`). Exposed as a
 * namespace rather than flattened, because the group modules deliberately reuse short schema names
 * (`Rest.Auth.LoginRequest`, `Rest.Portfolios.ImportReport`, …).
 */
export * as RestRoutes from './wire/rest/index.js';

// ── Transport ─────────────────────────────────────────────────────────────────────────────────
export { RestClient, TerminalApiError, createClient, GROUP_ALIASES } from './client/rest.js';
export type {
  AnyRouteArgs,
  ClientOptions,
  GroupApi,
  GroupAliases,
  GroupName,
  HttpMethod,
  RequestOptions,
  RestNamespaces,
  RestRegistry,
  RouteArgs,
  RouteDef,
  RouteDefOf,
  RouteId,
  RouteResponse,
  RouteResponseOf,
  TerminalApiErrorInit,
  TerminalClient,
  TerminalClientCore,
  TextResponse,
  TraceEvent,
  VersionEvent,
} from './client/rest.js';

// ── Live (WP-13: one socket, the prev-chain rule, ref-counted subscriptions) ──────────────────
export { LiveClient, QuoteCache } from './client/ws.js';
export { SubscriptionRegistry } from './client/subscriptions.js';
export type {
  DowngradeEvent,
  LiveAlertEvent,
  LiveCloseEvent,
  LiveErrorEvent,
  LiveLimits,
  LiveMessageEvent,
  LiveState,
  Notice,
  StatusEvent,
} from './client/ws.js';
export type {
  SubscribeOptions,
  Subscription,
  SubscriptionAck,
  UpdateEvent,
} from './client/subscriptions.js';
export type { ApplyResult, QuoteView } from './client/quoteCache.js';

// ── Dictionary and functions ──────────────────────────────────────────────────────────────────
export { createFieldsApi } from './fields/index.js';
export type {
  FieldDictionary,
  FieldFilter,
  FieldFormatOptions,
  FieldFormatter,
  FieldsApi,
  FieldsApiOptions,
} from './fields/index.js';

export { registry, runFunction } from './functions/index.js';
export type {
  FunctionCode,
  FunctionManifest,
  FunctionRegistry,
  FunctionRunRequest,
  Payload,
  PayloadOf,
} from './functions/index.js';

/** The package identity, used in `x-client-version` defaults and in WS `hello.client`. */
export const SDK_NAME = '@terminal/sdk' as const;
export const SDK_CLIENT_VERSION = 'sdk-js/0.1.0' as const;
