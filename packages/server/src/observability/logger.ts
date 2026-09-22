/**
 * `observability/logger.ts` — the process logger (ARCHITECTURE §11 "Logs" L1206, OPS-07).
 *
 * pino JSON to stdout, with the trace id carried as a **child binding** so every line a request
 * emits is joinable with `access_log.trace_id`, `usage_events.trace_id`, `provenance.trace_id` and
 * `ingest_runs.trace_id` — which is the whole point of OPS-07's one-string lookup.
 *
 * **Secrets never reach the stream.** That is enforced by a *list*, not by a convention that every
 * call site is expected to remember:
 *
 *  1. {@link redactSecrets} walks the structured payload of every log call (the `logMethod` hook)
 *     and censors any key that matches {@link SECRET_KEYS} or one of {@link SECRET_KEY_SUFFIXES}.
 *     It only recurses into **plain** objects and arrays: a class instance (a `FastifyRequest`, an
 *     `Error`, a `Buffer`, a pg `Client`) is passed through untouched rather than deep-copied, so
 *     a log call can never turn into a traversal of the whole server graph.
 *  2. {@link REDACT_PATHS} is handed to pino's own `redact`, which runs *after* the serializers.
 *     That is what covers the objects step 1 deliberately does not walk — above all
 *     `req.headers.cookie` and `req.headers.authorization`, which Fastify's standard `req`
 *     serializer expands into the line.
 *
 * Direct `.child(bindings)` calls bypass step 1 (pino pre-serialises bindings into a string), so
 * bindings go through {@link childLogger} / {@link traceLogger}, which redact them first.
 *
 * What redaction cannot do is read English: a secret interpolated into the *message string* is
 * invisible to any key-based list. Pass values as fields, never as `\`token=${t}\``.
 */

import pino from 'pino';
import type { DestinationStream, Logger } from 'pino';

import type { LogLevel } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The redaction list
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What a censored value is replaced with. Never the empty string: absence must stay visible. */
export const REDACTED = '[redacted]';

/** Replaces a value nested deeper than {@link MAX_DEPTH}, which is never walked and never logged. */
export const TRUNCATED = '[truncated]';

/** Replaces a value already seen on the current path. */
export const CIRCULAR = '[circular]';

/**
 * Deepest plain-object nesting {@link redactSecrets} walks. Anything below is replaced wholesale:
 * an unwalked subtree is an unredacted subtree, so it is not logged at all.
 */
const MAX_DEPTH = 8;

/**
 * Key comparison is on the *normalised* key: lower-cased with `-`, `_` and `.` removed, so
 * `Authorization`, `authorization`, `x-api-key`, `apiKey` and `api_key` are one thing.
 */
export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_.]/g, '');
}

/** Exact (normalised) key names whose value is a secret. */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  // HTTP
  'cookie',
  'cookies',
  'setcookie',
  'authorization',
  'proxyauthorization',
  'wwwauthenticate',
  'bearer',
  // Session material. `tsid` is the session cookie (`app.ts`); `sessionId` is the uuid audit
  // identifier and is deliberately NOT here — it is what makes a line joinable to `access_log`.
  'tsid',
  'sid',
  'authtoken',
  'sessionkey',
  // Credentials
  'password',
  'passwd',
  'pwd',
  'passwordhash',
  'passwordverifier',
  'credential',
  'credentials',
  'privatekey',
  'signingkey',
  // Second factor and recovery
  'otp',
  'totp',
  'mfacode',
  'recoverycode',
  'backupcode',
  'authorizationheader',
]);
// A bare `key` is deliberately absent: `requestKey` (providers), cache keys and map keys are
// routine debugging material, and the `apikey` suffix below already covers the secret ones.

/**
 * Suffixes of a normalised key that make it a secret. This is what catches the names nobody
 * thought to enumerate — `metricsToken`, `SESSION_SECRET`, `x-api-key`, `refresh_token`.
 */
export const SECRET_KEY_SUFFIXES: readonly string[] = [
  'password',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'privatekey',
  'credential',
  'credentials',
];

/** True when a key's value must be censored. */
export function isSecretKey(key: string): boolean {
  const k = normaliseKey(key);
  if (SECRET_KEYS.has(k)) return true;
  return SECRET_KEY_SUFFIXES.some((suffix) => k.endsWith(suffix));
}

/**
 * pino `redact` paths, applied after the serializers — the half of the list that covers objects
 * {@link redactSecrets} refuses to walk (Fastify's `req`/`res`, and anything a serializer builds).
 */
export const REDACT_PATHS: readonly string[] = [
  'cookie',
  'authorization',
  'password',
  'token',
  'apiKey',
  'secret',
  'headers.cookie',
  'headers.authorization',
  'headers["set-cookie"]',
  'headers["x-api-key"]',
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'request.headers.cookie',
  'request.headers.authorization',
  'response.headers["set-cookie"]',
  '*.cookie',
  '*.authorization',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.secret',
  '*.headers.cookie',
  '*.headers.authorization',
  '*.headers["set-cookie"]',
  '*.headers["x-api-key"]',
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The scrubber
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Only these are walked; everything else is a value, logged as the serializers render it. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, depth: number, seen: Set<object>): unknown {
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return TRUNCATED;
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    const out = value.map((item) => walk(item, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  if (!isPlainObject(value)) return value;
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : walk(item, depth + 1, seen);
  }
  seen.delete(value);
  return out;
}

/**
 * Return a copy of `value` with every secret-named field censored. Pure: the argument is never
 * mutated, so a redacted log line cannot change the object the caller is about to use.
 */
export function redactSecrets(value: unknown): unknown {
  return walk(value, 0, new Set<object>());
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The logger
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface LoggerDeps {
  /** pino level; the process passes `config.LOG_LEVEL`. */
  level?: LogLevel;
  /** Where lines go. Defaults to pino's own stdout destination; tests pass a capturing stream. */
  stream?: DestinationStream;
  /** Static bindings on every line (`service`, `version`). Redacted like everything else. */
  base?: Record<string, unknown>;
}

/**
 * Build the root logger. Every line it or any of its children emit has passed the redaction list.
 */
export function createLogger(deps: LoggerDeps = {}): Logger {
  const base = deps.base === undefined ? undefined : (redactSecrets(deps.base) as pino.Bindings);
  const options: pino.LoggerOptions = {
    level: deps.level ?? 'info',
    // `base: undefined` would drop pino's own `pid`/`hostname`; only override when asked.
    ...(base === undefined ? {} : { base }),
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    hooks: {
      logMethod(args, method) {
        // pino's call shapes: (obj, msg?, ...), (msg, ...interpolation). Only the structured
        // payload is walkable; an interpolated string is the caller's responsibility.
        if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
          const [first, ...rest] = args;
          method.apply(this, [redactSecrets(first), ...rest] as typeof args);
          return;
        }
        method.apply(this, args);
      },
    },
  };
  return deps.stream === undefined ? pino(options) : pino(options, deps.stream);
}

/**
 * A child logger with `bindings` redacted first. Use this instead of `logger.child(...)`: pino
 * pre-serialises bindings into a string, so they never reach the `logMethod` hook.
 */
export function childLogger(parent: Logger, bindings: Record<string, unknown>): Logger {
  return parent.child(redactSecrets(bindings) as pino.Bindings);
}

/**
 * ARCHITECTURE §11: the trace id is a child binding, not a field a call site must remember to
 * pass. `http/trace.ts` does the same to Fastify's own request logger.
 */
export function traceLogger(parent: Logger, traceId: string): Logger {
  return childLogger(parent, { traceId });
}
