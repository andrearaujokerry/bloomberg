/**
 * WP-08 — `observability/logger.ts`: pino with the trace id as a child binding, and a *list*-based
 * redaction that no call site has to remember.
 *
 * Every assertion here reads the bytes that would have gone to stdout: the logger is built over a
 * capturing `DestinationStream`, and the test parses the JSON lines. A secret is "not logged" only
 * if it does not appear anywhere in the line, so the checks are on the raw string as well as on
 * the parsed object.
 *
 * No database: this file lives under `test/integration/observability/` because WP-08 owns that
 * directory, and the `server-int` project is the one that includes it.
 */

import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';

import {
  childLogger,
  createLogger,
  isSecretKey,
  normaliseKey,
  REDACTED,
  redactSecrets,
  traceLogger,
  TRUNCATED,
  CIRCULAR,
} from '../../../src/observability/logger.js';

/** A pino destination that keeps every line it is written. */
function capture(): { stream: DestinationStream; lines(): string[]; objects(): unknown[] } {
  const written: string[] = [];
  return {
    stream: {
      write(chunk: string): void {
        written.push(chunk);
      },
    },
    lines: () => [...written],
    objects: () => written.map((line) => JSON.parse(line) as unknown),
  };
}

describe('observability/logger — trace binding and the redaction list', () => {
  it('carries the trace id as a child binding on every line', () => {
    const sink = capture();
    const root = createLogger({ level: 'info', stream: sink.stream });
    const traceId = '0f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8';
    const log = traceLogger(root, traceId);

    log.info({ route: 'GET /api/v1/status' }, 'served');
    log.warn({ route: 'GET /api/v1/status' }, 'slow');

    const objects = sink.objects() as { traceId?: string; msg?: string }[];
    expect(objects).toHaveLength(2);
    for (const line of objects) expect(line.traceId).toBe(traceId);
    expect(objects.map((l) => l.msg)).toEqual(['served', 'slow']);
  });

  it('censors a cookie, an Authorization header, a password, a session token and an API key', () => {
    const sink = capture();
    const log = createLogger({ level: 'info', stream: sink.stream });

    log.info(
      {
        cookie: 'tsid=s%3Areal-session-value.sig',
        authorization: 'Bearer real-bearer-token',
        password: 'hunter2-the-real-one',
        sessionToken: 'real-session-token',
        apiKey: 'tk_live_real_api_key',
        metricsToken: 'real-metrics-token',
        SESSION_SECRET: 'real-session-secret',
        'x-api-key': 'real-x-api-key',
        // Not secrets: these are what makes a line useful.
        userId: 42,
        sessionId: '0f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8',
        requestKey: 'cboe.quotes:AAPL',
      },
      'login',
    );

    const line = sink.lines()[0]!;
    for (const secret of [
      'real-session-value',
      'real-bearer-token',
      'hunter2-the-real-one',
      'real-session-token',
      'tk_live_real_api_key',
      'real-metrics-token',
      'real-session-secret',
      'real-x-api-key',
    ]) {
      expect(line).not.toContain(secret);
    }

    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.cookie).toBe(REDACTED);
    expect(parsed.authorization).toBe(REDACTED);
    expect(parsed.password).toBe(REDACTED);
    expect(parsed.sessionToken).toBe(REDACTED);
    expect(parsed.apiKey).toBe(REDACTED);
    expect(parsed.metricsToken).toBe(REDACTED);
    expect(parsed.SESSION_SECRET).toBe(REDACTED);
    expect(parsed['x-api-key']).toBe(REDACTED);

    // The identifiers that make a log line joinable survive untouched.
    expect(parsed.userId).toBe(42);
    expect(parsed.sessionId).toBe('0f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8');
    expect(parsed.requestKey).toBe('cboe.quotes:AAPL');
  });

  it('censors secrets nested inside headers and bodies, at any depth it walks', () => {
    const sink = capture();
    const log = createLogger({ level: 'info', stream: sink.stream });

    log.info(
      {
        req: {
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: {
            cookie: 'tsid=nested-cookie-value',
            authorization: 'Bearer nested-bearer',
            'user-agent': 'terminal/1.0',
          },
          body: { email: 'a@b.invalid', password: 'nested-password' },
        },
        attempts: [{ password: 'array-password' }, { ok: true }],
      },
      'request',
    );

    const line = sink.lines()[0]!;
    expect(line).not.toContain('nested-cookie-value');
    expect(line).not.toContain('nested-bearer');
    expect(line).not.toContain('nested-password');
    expect(line).not.toContain('array-password');
    expect(line).toContain('terminal/1.0');
    expect(line).toContain('a@b.invalid');
  });

  it('redacts child bindings, which pino serialises before the hook can see them', () => {
    const sink = capture();
    const root = createLogger({ level: 'info', stream: sink.stream });
    const log = childLogger(root, { component: 'auth', apiKey: 'binding-api-key' });

    log.info('bound');

    const line = sink.lines()[0]!;
    expect(line).not.toContain('binding-api-key');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.component).toBe('auth');
    expect(parsed.apiKey).toBe(REDACTED);
  });

  it('passes class instances through instead of deep-copying the server graph', () => {
    // A `FastifyRequest`, a pg client or an Error must never be walked: it is cyclic, enormous,
    // and pino's serializers already know how to render it. pino's own `redact` paths cover the
    // serialized output, which is why the two halves of the list exist.
    class Session {
      readonly token = 'class-token';
    }
    const instance = new Session();
    expect(redactSecrets({ session: instance })).toEqual({ session: instance });

    const err = new Error('boom');
    expect(redactSecrets(err)).toBe(err);
  });

  it('is a list, not a convention: the key rules are directly testable', () => {
    expect(normaliseKey('X-API-Key')).toBe('xapikey');
    expect(normaliseKey('session_secret')).toBe('sessionsecret');

    for (const key of [
      'cookie',
      'Cookie',
      'set-cookie',
      'Authorization',
      'proxy-authorization',
      'password',
      'newPassword',
      'password_hash',
      'apiKey',
      'x-api-key',
      'refresh_token',
      'METRICS_TOKEN',
      'SESSION_SECRET',
      'clientSecret',
      'privateKey',
      'recoveryCode',
      'totp',
    ]) {
      expect(isSecretKey(key)).toBe(true);
    }
    for (const key of ['userId', 'sessionId', 'traceId', 'requestKey', 'code', 'tokenCount']) {
      expect(isSecretKey(key)).toBe(false);
    }
  });

  it('never walks past the depth limit and survives a cycle', () => {
    // Nine levels: the ninth is replaced wholesale rather than left unredacted.
    let deep: Record<string, unknown> = { password: 'too-deep' };
    for (let i = 0; i < 9; i++) deep = { nest: deep };
    expect(JSON.stringify(redactSecrets(deep))).not.toContain('too-deep');
    expect(JSON.stringify(redactSecrets(deep))).toContain(TRUNCATED);

    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(redactSecrets(cyclic)).toEqual({ name: 'root', self: CIRCULAR });
  });

  it('does not mutate the object the caller passed', () => {
    const payload = { password: 'original', nested: { token: 'original-token' } };
    redactSecrets(payload);
    expect(payload.password).toBe('original');
    expect(payload.nested.token).toBe('original-token');
  });

  it('respects the level so a debug line is not written at info', () => {
    const sink = capture();
    const log = createLogger({ level: 'info', stream: sink.stream });
    log.debug({ a: 1 }, 'quiet');
    expect(sink.lines()).toHaveLength(0);
    log.info({ a: 1 }, 'loud');
    expect(sink.lines()).toHaveLength(1);
  });
});
