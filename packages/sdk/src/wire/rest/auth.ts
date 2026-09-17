/**
 * `wire/rest/auth.ts` — `Rest.Auth.*`: the 12 authentication and session routes.
 *
 * Schemas transcribed from API.md §1.2 L66-110; routes from API.md §1.3 L112-127.
 * Owned by WP-01 now, by WP-07 (`server/src/http/routes/auth.ts`) afterwards.
 *
 * Route descriptor shape used by every `wire/rest/*` group (consumed by `client/rest.ts`):
 *   { method, path, params?, query?, body?, response, status, format? }
 * `path` is relative to the `/api/v1` prefix and uses `:name` placeholders matching `params`.
 * `format` is `'json'` when omitted; `'csv'`/`'text'` mark non-JSON bodies; `status` is the
 * success status, and `response: z.void()` marks an empty (204) body.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ schemas */

export const Role = z.enum(['user', 'admin', 'compliance', 'dataops', 'helpdesk', 'newsroom']);
export type Role = z.infer<typeof Role>;

export const ClientKind = z.enum(['web', 'api']);
export type ClientKind = z.infer<typeof ClientKind>;

export const LoginRequest = z.object({
  email: z.email(),
  password: z.string().min(8).max(256),
  /** client-generated stable id (localStorage); stored in `sessions.device_id` */
  deviceId: z.string().min(8).max(64),
  /** 'Chrome on macOS' */
  deviceLabel: z.string().max(80).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const QuotaUsage = z.object({
  used: z.number().int(),
  limit: z.number().int(),
  resetsAt: z.iso.datetime(),
});
export type QuotaUsage = z.infer<typeof QuotaUsage>;

export const SessionInfo = z.object({
  sessionId: z.uuid(),
  userId: z.number().int(),
  firmId: z.number().int(),
  firmName: z.string(),
  email: z.email(),
  displayName: z.string(),
  desk: z.string().nullable(),
  role: Role,
  clientKind: ClientKind,
  mfaRequired: z.boolean(),
  mfaVerified: z.boolean(),
  webauthnEnrolled: z.boolean(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** from the evaluator's cache for this user (ARCHITECTURE §10) */
  entitlementSummary: z.object({
    /** min over the user's grants; 'delayed' for every seeded user */
    defaultTier: z.enum(['eod', 'delayed', 'realtime']),
    exportAllowed: z.boolean(),
    apiAllowed: z.boolean(),
  }),
  quotas: z.object({
    dailyUniqueInstruments: QuotaUsage,
    monthlyDataPoints: QuotaUsage,
    concurrentSubscriptions: QuotaUsage,
  }),
  /** WS protocol the server speaks (API.md §11) */
  protocol: z.literal(1),
  serverVersion: z.string(),
  minClientVersion: z.string(),
  dictionaryVersion: z.string(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const LoginResponse = z.object({
  session: SessionInfo,
  /** true → only /auth/* is usable until webauthn/login/verify */
  mfaRequired: z.boolean(),
  /** the web session this login displaced (SEC-03) */
  superseded: z
    .object({
      sessionId: z.uuid(),
      deviceId: z.string().nullable(),
      deviceLabel: z.string().nullable(),
      lastSeenAt: z.iso.datetime(),
    })
    .nullable(),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const ApiKeyScope = z.enum(['data:read', 'fn:run', 'ws:subscribe', 'server']);
export type ApiKeyScope = z.infer<typeof ApiKeyScope>;

export const ApiKeyCreate = z.object({
  label: z.string().min(1).max(80),
  scopes: z.array(ApiKeyScope).default(['data:read', 'fn:run', 'ws:subscribe']),
});
export type ApiKeyCreate = z.infer<typeof ApiKeyCreate>;

export const ApiKeySummary = z.object({
  apiKeyId: z.number().int(),
  label: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type ApiKeySummary = z.infer<typeof ApiKeySummary>;

/** `secret` ('tk_…') is shown exactly once. */
export const ApiKeyCreated = ApiKeySummary.extend({ secret: z.string() });
export type ApiKeyCreated = z.infer<typeof ApiKeyCreated>;

export const SessionSummary = z.object({
  sessionId: z.uuid(),
  clientKind: ClientKind,
  deviceId: z.string().nullable(),
  deviceLabel: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  current: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/* ----------------------------------------------------- WebAuthn (W3C shapes)
 * The four W3C JSON shapes named in API.md §1.1 L57. Only the members the server reads or
 * writes are constrained; `catchall(unknown)` keeps forward compatibility with the evolving
 * WebAuthn JSON serialisation (extensions, hints, new transports) instead of rejecting it.
 */

const PublicKeyCredentialDescriptorJSON = z
  .object({
    type: z.literal('public-key'),
    id: z.string(),
    transports: z.array(z.string()).optional(),
  })
  .catchall(z.unknown());

export const PublicKeyCredentialCreationOptionsJSON = z
  .object({
    rp: z.object({ id: z.string().optional(), name: z.string() }).catchall(z.unknown()),
    user: z
      .object({ id: z.string(), name: z.string(), displayName: z.string() })
      .catchall(z.unknown()),
    challenge: z.string(),
    pubKeyCredParams: z.array(
      z.object({ type: z.literal('public-key'), alg: z.number().int() }).catchall(z.unknown()),
    ),
    timeout: z.number().int().optional(),
    excludeCredentials: z.array(PublicKeyCredentialDescriptorJSON).optional(),
    authenticatorSelection: z.record(z.string(), z.unknown()).optional(),
    attestation: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown());
export type PublicKeyCredentialCreationOptionsJSON = z.infer<
  typeof PublicKeyCredentialCreationOptionsJSON
>;

export const RegistrationResponseJSON = z
  .object({
    id: z.string(),
    rawId: z.string(),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: z.string(),
        attestationObject: z.string(),
        transports: z.array(z.string()).optional(),
      })
      .catchall(z.unknown()),
    authenticatorAttachment: z.string().optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  })
  .catchall(z.unknown());
export type RegistrationResponseJSON = z.infer<typeof RegistrationResponseJSON>;

export const PublicKeyCredentialRequestOptionsJSON = z
  .object({
    challenge: z.string(),
    timeout: z.number().int().optional(),
    rpId: z.string().optional(),
    allowCredentials: z.array(PublicKeyCredentialDescriptorJSON).optional(),
    userVerification: z.string().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown());
export type PublicKeyCredentialRequestOptionsJSON = z.infer<
  typeof PublicKeyCredentialRequestOptionsJSON
>;

export const AuthenticationResponseJSON = z
  .object({
    id: z.string(),
    rawId: z.string(),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: z.string(),
        authenticatorData: z.string(),
        signature: z.string(),
        userHandle: z.string().nullable().optional(),
      })
      .catchall(z.unknown()),
    authenticatorAttachment: z.string().optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  })
  .catchall(z.unknown());
export type AuthenticationResponseJSON = z.infer<typeof AuthenticationResponseJSON>;

export const WebAuthnRegisterOptionsRequest = z.object({});
export const WebAuthnRegisterVerifyRequest = z.object({
  credential: RegistrationResponseJSON,
  label: z.string().max(80).optional(),
});
export const WebAuthnRegisterVerifyResponse = z.object({ credentialId: z.string() });

export const WebAuthnLoginOptionsRequest = z.object({ email: z.email() });
/** Identical response shape for unknown emails (API.md §1.3 L123). */
export const WebAuthnLoginOptionsResponse = z.object({
  challengeId: z.uuid(),
  options: PublicKeyCredentialRequestOptionsJSON,
});
export const WebAuthnLoginVerifyRequest = z.object({
  challengeId: z.uuid(),
  credential: AuthenticationResponseJSON,
  deviceId: z.string().min(8).max(64),
  deviceLabel: z.string().max(80).optional(),
});

export const SessionListResponse = z.object({ items: z.array(SessionSummary) });
export const ApiKeyListResponse = z.object({ items: z.array(ApiKeySummary) });

/* ------------------------------------------------------------------- routes */

/** The 12 routes of API.md §1.3 (`http/routes/auth.ts`). */
export const Auth = {
  /** `401 AUTH_INVALID_CREDENTIALS`, `403 USER_SUSPENDED`, rate limit 5/min per IP. */
  Login: {
    method: 'POST',
    path: '/auth/login',
    body: LoginRequest,
    response: LoginResponse,
    status: 200,
  },
  /** `revoke_reason='logout'`; open WS gets `bye 1000 'logout'`. */
  Logout: {
    method: 'POST',
    path: '/auth/logout',
    response: z.void(),
    status: 204,
  },
  /** Works for cookie and bearer; refreshes `last_seen_at`. */
  Session: {
    method: 'GET',
    path: '/auth/session',
    response: SessionInfo,
    status: 200,
  },
  /** Own sessions (web + api). */
  Sessions: {
    method: 'GET',
    path: '/auth/sessions',
    response: SessionListResponse,
    status: 200,
  },
  /** Revoke one of your own sessions (`revoke_reason='logout'`). */
  RevokeSession: {
    method: 'DELETE',
    path: '/auth/sessions/:sessionId',
    params: z.object({ sessionId: z.uuid() }),
    response: z.void(),
    status: 204,
  },
  /** Requires an authenticated (password) session; challenge cached 5 min per session. */
  WebAuthnRegisterOptions: {
    method: 'POST',
    path: '/auth/webauthn/register/options',
    body: WebAuthnRegisterOptionsRequest,
    response: PublicKeyCredentialCreationOptionsJSON,
    status: 200,
  },
  /** Inserts `user_credentials kind='webauthn'`. */
  WebAuthnRegisterVerify: {
    method: 'POST',
    path: '/auth/webauthn/register/verify',
    body: WebAuthnRegisterVerifyRequest,
    response: WebAuthnRegisterVerifyResponse,
    status: 200,
  },
  /** allowCredentials from the user's registered keys. */
  WebAuthnLoginOptions: {
    method: 'POST',
    path: '/auth/webauthn/login/options',
    body: WebAuthnLoginOptionsRequest,
    response: WebAuthnLoginOptionsResponse,
    status: 200,
  },
  /** Upgrades the current session to `mfa_verified=true`, or creates one (passwordless). */
  WebAuthnLoginVerify: {
    method: 'POST',
    path: '/auth/webauthn/login/verify',
    body: WebAuthnLoginVerifyRequest,
    response: LoginResponse,
    status: 200,
  },
  /** Own keys. */
  ApiKeys: {
    method: 'GET',
    path: '/auth/api-keys',
    response: ApiKeyListResponse,
    status: 200,
  },
  /** `scopes` containing `server` requires `role='admin'`. */
  CreateApiKey: {
    method: 'POST',
    path: '/auth/api-keys',
    body: ApiKeyCreate,
    response: ApiKeyCreated,
    status: 201,
  },
  /** Sets `revoked_at`; its api session is revoked (`revoke_reason='admin'`). */
  RevokeApiKey: {
    method: 'DELETE',
    path: '/auth/api-keys/:apiKeyId',
    params: z.object({ apiKeyId: z.coerce.number().int() }),
    response: z.void(),
    status: 204,
  },
} as const;
