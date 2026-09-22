/**
 * `providers/http.ts` — WORKPLAN WP-05 acceptance row: "token bucket, 3-retry backoff, ETag
 * revalidation, circuit opens at 5 failures and half-opens at 60 s on a `VirtualClock`"
 * (PROVIDERS.a §2.1-§2.5).
 *
 * Nothing here opens a socket, a timer or a database connection: the transport is injected and
 * records its calls, the sleeper advances a `VirtualClock` instead of waiting, and the breaker's
 * sink is a recorder rather than `databaseBreakerSink()`. Two cases read the committed captures
 * through the replay store, which is a file read and the only IO in the file.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { VirtualClock } from '@terminal/core';
import { describe, expect, it } from 'vitest';

import { loadConfig, type Config } from '../../../src/config.js';
import {
  backoffDelayMs,
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_HALF_OPEN_MS,
  BROWSER_USER_AGENT,
  CircuitOpenError,
  countsAsProviderFailure,
  defaultCacheTtlMs,
  isRetryableStatus,
  MAX_ATTEMPTS,
  openfigiJobsPerRequest,
  parseRetryAfterMs,
  ProviderHttpClient,
  ProviderHttpError,
  ProviderTimeoutError,
  providerDefaults,
  RateLimitError,
  replayWallTransport,
  SCHEDULER_BUDGET_SHARE,
  TransportError,
  type BreakerSink,
  type CircuitOpenEvent,
  type Sleeper,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/providers/http.js';
import {
  readManifest,
  ReplayMissError,
  resolveReplayDir,
} from '../../../src/providers/replayStore.js';
import type { ProviderId } from '../../../src/providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

const START = Date.parse('2026-09-15T18:41:28Z');

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: 'postgres://localhost:5432/bloomberg_test',
    SEC_USER_AGENT: 'Terminal Clone/1.0 (ops@example.com)',
    SESSION_SECRET: 'test-only-session-secret-0123456789',
    PROVIDER_MODE: 'live',
    ...overrides,
  });
}

/** A sleeper that does not sleep: it moves the virtual clock and remembers how far. */
function recordingSleeper(clock: VirtualClock): Sleeper & { slept: number[] } {
  const slept: number[] = [];
  return {
    slept,
    sleep(ms: number): Promise<void> {
      slept.push(ms);
      clock.advance(ms);
      return Promise.resolve();
    },
  };
}

interface TransportStub {
  transport: Transport;
  calls: TransportRequest[];
}

/** `handler` answers the n-th call (1-based); throwing from it is a transport failure. */
function stubTransport(
  handler: (req: TransportRequest, n: number) => TransportResponse,
): TransportStub {
  const calls: TransportRequest[] = [];
  const transport: Transport = (req) => {
    calls.push(req);
    // `handler` throwing synchronously is how a test models a transport failure; the rejected
    // promise is what a real transport would hand back.
    try {
      return Promise.resolve(handler(req, calls.length));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
  return { transport, calls };
}

function ok(body: string, headers: Record<string, string> = {}): TransportResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(body, 'utf8'),
  };
}

function status(code: number, headers: Record<string, string> = {}, body = ''): TransportResponse {
  return { status: code, headers, body: Buffer.from(body, 'utf8') };
}

interface SinkRecorder extends BreakerSink {
  opened: CircuitOpenEvent[];
  closed: ProviderId[];
}

function recordingSink(lines: readonly number[] = []): SinkRecorder {
  const opened: CircuitOpenEvent[] = [];
  const closed: ProviderId[] = [];
  return {
    opened,
    closed,
    circuitOpened(event: CircuitOpenEvent): readonly number[] {
      opened.push(event);
      return lines;
    },
    circuitClosed(providerId: ProviderId): void {
      closed.push(providerId);
    },
  };
}

interface Harness {
  client: ProviderHttpClient;
  clock: VirtualClock;
  calls: TransportRequest[];
  slept: number[];
  sink: SinkRecorder;
}

function harness(
  handler: (req: TransportRequest, n: number) => TransportResponse,
  options: { config?: Config; maxWaitMs?: number; rng?: () => number; lines?: number[] } = {},
): Harness {
  const clock = new VirtualClock(START);
  const sleeper = recordingSleeper(clock);
  const stub = stubTransport(handler);
  const sink = recordingSink(options.lines ?? []);
  const client = new ProviderHttpClient({
    config: options.config ?? config(),
    clock,
    sleeper,
    transport: stub.transport,
    rng: options.rng ?? ((): number => 0.5),
    breakerSink: sink,
    ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
  });
  return { client, clock, calls: stub.calls, slept: sleeper.slept, sink };
}

const CBOE_URL = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/AAPL.json';
const SEC_URL = 'https://www.sec.gov/files/company_tickers.json';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §2.2 — the token buckets, with the real published limits
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('token buckets (PROVIDERS.a §2.2)', () => {
  it('publishes the real per-provider limits', () => {
    const { client } = harness(() => ok('{}'));

    expect(client.tokens('openfigi.mapping')).toEqual({
      capacity: 25,
      available: 25,
      refillPerSec: 25 / 60,
    });
    expect(client.tokens('sec.tickers')).toEqual({ capacity: 10, available: 10, refillPerSec: 10 });
    expect(client.tokens('cboe.quotes')).toEqual({ capacity: 8, available: 8, refillPerSec: 4 });
    expect(client.tokens('yahoo.chart')).toEqual({ capacity: 4, available: 4, refillPerSec: 2 });
    expect(client.tokens('frankfurter')).toEqual({ capacity: 2, available: 2, refillPerSec: 1 });
    expect(client.tokens('coingecko.simple')).toEqual({
      capacity: 2,
      available: 2,
      refillPerSec: 1,
    });
    // BLS is 25/day and Treasury 1/minute — the two slowest buckets in the system.
    expect(client.tokens('bls.timeseries')).toEqual({
      capacity: 25,
      available: 25,
      refillPerSec: 25 / 86_400,
    });
    expect(client.tokens('treasury.yieldcurve')).toEqual({
      capacity: 1,
      available: 1,
      refillPerSec: 1 / 60,
    });
    // "everything else": 1/s, burst 2.
    expect(client.tokens('worldbank')).toEqual({ capacity: 2, available: 2, refillPerSec: 1 });
  });

  it('raises the OpenFIGI bucket and the jobs-per-request by config, not by code', () => {
    expect(openfigiJobsPerRequest(config())).toBe(10);
    expect(providerDefaults('openfigi.mapping', config()).refillPerSec).toBe(25 / 60);

    const keyed = config({ OPENFIGI_API_KEY: 'figi-key' });
    expect(openfigiJobsPerRequest(keyed)).toBe(100);
    expect(providerDefaults('openfigi.mapping', keyed).refillPerSec).toBe(25 / 6);
    expect(providerDefaults('openfigi.mapping', keyed).headers['x-openfigi-apikey']).toBe(
      'figi-key',
    );
  });

  it('spends one token per request and refills at the published rate', async () => {
    const { client, calls, slept, clock } = harness(() => ok('{"data":[]}'));

    // The Cboe burst is 8; eight interactive requests go straight through.
    for (let i = 0; i < 8; i += 1) {
      await client.get({ providerId: 'cboe.quotes', url: CBOE_URL, budgetShare: 'interactive' });
    }
    expect(calls.length).toBe(8);
    expect(slept).toEqual([]);
    expect(client.tokens('cboe.quotes').available).toBeCloseTo(0, 9);

    // The ninth waits for exactly one refill interval — 1/4 s at 4 tokens per second.
    const before = clock.now();
    await client.get({ providerId: 'cboe.quotes', url: CBOE_URL, budgetShare: 'interactive' });
    expect(slept).toEqual([250]);
    expect(clock.now() - before).toBe(250);
    expect(calls.length).toBe(9);
  });

  it('leaves 30 % of every bucket to interactive callers (the 70 % scheduler share)', async () => {
    // maxWaitMs 0: a request that would have to wait for a token is refused outright, which is
    // what makes the reserve observable rather than merely slow.
    const { client, calls } = harness(() => ok('{}'), { maxWaitMs: 0 });

    // SEC: capacity 10, so the scheduler may take 7 and must leave 3.
    for (let i = 0; i < 7; i += 1) {
      await client.get({ providerId: 'sec.tickers', url: SEC_URL, budgetShare: 'scheduler' });
    }
    expect(client.tokens('sec.tickers').available).toBeCloseTo(3, 9);
    expect(SCHEDULER_BUDGET_SHARE).toBe(0.7);

    await expect(
      client.get({ providerId: 'sec.tickers', url: SEC_URL, budgetShare: 'scheduler' }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(calls.length).toBe(7);

    // The analyst hitting GO is not starved: the reserved 30 % is still there.
    await client.get({ providerId: 'sec.tickers', url: SEC_URL, budgetShare: 'interactive' });
    expect(calls.length).toBe(8);
    expect(client.tokens('sec.tickers').available).toBeCloseTo(2, 9);
  });

  it('lets the scheduler have the only token of a one-token bucket (treasury is scheduler-only)', async () => {
    const { client, calls } = harness(() => ok('<xml/>'), { maxWaitMs: 0 });
    await client.get({
      providerId: 'treasury.yieldcurve',
      url: 'https://home.treasury.gov/resource-center/data.xml',
      budgetShare: 'scheduler',
    });
    expect(calls.length).toBe(1);
    expect(client.tokens('treasury.yieldcurve').available).toBeCloseTo(0, 9);
    // …and the 45 s timeout that the ≈ 18 s yield-curve response needs.
    expect(providerDefaults('treasury.yieldcurve', config()).timeoutMs).toBe(45_000);
  });

  it('sends the mandatory per-provider headers', async () => {
    const { client, calls } = harness(() => ok('{}'));

    await client.get({ providerId: 'sec.tickers', url: SEC_URL });
    expect(calls[0]?.headers['user-agent']).toBe('Terminal Clone/1.0 (ops@example.com)');
    expect(calls[0]?.headers['accept-encoding']).toBe('gzip, deflate');

    await client.get({
      providerId: 'yahoo.chart',
      url: 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1m&range=1d',
    });
    expect(calls[1]?.headers['user-agent']).toBe(BROWSER_USER_AGENT);

    // The caller wins over the table — an adapter that asks for CSV knows something it does not.
    await client.get({
      providerId: 'cboe.quotes',
      url: CBOE_URL,
      headers: { Accept: 'text/csv' },
    });
    expect(calls[2]?.headers.accept).toBe('text/csv');
  });

  it('refuses to fetch from SEC without a descriptive contact User-Agent', async () => {
    const { client, calls } = harness(() => ok('{}'), {
      config: config({ SEC_USER_AGENT: 'python-requests/2.31' }),
    });
    await expect(client.get({ providerId: 'sec.tickers', url: SEC_URL })).rejects.toThrow(
      /contact email/,
    );
    expect(calls.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §2.3 — retry and backoff
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('retry and backoff (PROVIDERS.a §2.3)', () => {
  it('computes min(30_000, 500 · 2^(n-1)) · (0.5 + rng())', () => {
    const mid = (): number => 0.5;
    expect([1, 2, 3].map((n) => backoffDelayMs(n, mid))).toEqual([500, 1000, 2000]);
    expect([1, 2, 3].map((n) => backoffDelayMs(n, () => 0))).toEqual([250, 500, 1000]);
    expect(backoffDelayMs(1, () => 0.999)).toBe(750);
    // The cap applies before the jitter: 500 · 2^6 = 32 000 → 30 000.
    expect(backoffDelayMs(7, mid)).toBe(30_000);
  });

  it('retries a 503 three times, backing off 500 ms then 1000 ms, then fails', async () => {
    const { client, calls, slept, clock } = harness(() => status(503, {}, 'upstream down'));

    await expect(client.get({ providerId: 'cboe.quotes', url: CBOE_URL })).rejects.toBeInstanceOf(
      ProviderHttpError,
    );

    expect(MAX_ATTEMPTS).toBe(3);
    expect(calls.length).toBe(3);
    expect(slept).toEqual([500, 1000]);
    expect(clock.now()).toBe(START + 1500);
  });

  it('returns the first success and stops retrying', async () => {
    const { client, calls, slept } = harness((_req, n) => (n < 3 ? status(500) : ok('{"ok":1}')));

    const raw = await client.get({ providerId: 'cboe.quotes', url: CBOE_URL });
    expect(raw.status).toBe(200);
    expect(raw.body.toString('utf8')).toBe('{"ok":1}');
    expect(calls.length).toBe(3);
    expect(slept).toEqual([500, 1000]);
  });

  it('never retries a terminal 4xx — a 404 is a data matter, not a network one', async () => {
    const { client, calls, slept } = harness(() => status(404, {}, 'not found'));

    const err = await client
      .get({ providerId: 'cboe.quotes', url: CBOE_URL })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(404);
    expect(calls.length).toBe(1);
    expect(slept).toEqual([]);
    expect(isRetryableStatus(404)).toBe(false);
    expect(countsAsProviderFailure(404)).toBe(false);
    expect([408, 425, 429, 500, 503].every(isRetryableStatus)).toBe(true);
  });

  it('honours Retry-After on a 429 when it is under 30 s, and ignores it when it is not', async () => {
    const short = harness((_req, n) => (n === 1 ? status(429, { 'retry-after': '2' }) : ok('{}')));
    await short.client.get({
      providerId: 'coingecko.simple',
      url: 'https://api.coingecko.com/x',
      budgetShare: 'interactive',
    });
    expect(short.slept).toEqual([2000]);

    const long = harness((_req, n) => (n === 1 ? status(429, { 'retry-after': '600' }) : ok('{}')));
    await long.client.get({
      providerId: 'coingecko.simple',
      url: 'https://api.coingecko.com/x',
      budgetShare: 'interactive',
    });
    expect(long.slept).toEqual([500]);

    expect(parseRetryAfterMs('2', START)).toBe(2000);
    expect(parseRetryAfterMs('Tue, 15 Sep 2026 18:41:38 GMT', START)).toBe(10_000);
    expect(parseRetryAfterMs(undefined, START)).toBeNull();
    expect(parseRetryAfterMs('soon', START)).toBeNull();
  });

  it('retries a transport error and raises a timeout as ProviderTimeoutError', async () => {
    const flaky = harness((_req, n) => {
      if (n < 3) throw new TransportError('ECONNRESET');
      return ok('{}');
    });
    await flaky.client.get({ providerId: 'cboe.quotes', url: CBOE_URL });
    expect(flaky.calls.length).toBe(3);
    expect(flaky.slept).toEqual([500, 1000]);

    const timeout = harness(() => {
      const err = new Error('headers timeout') as Error & { code: string };
      err.code = 'UND_ERR_HEADERS_TIMEOUT';
      throw err;
    });
    const err = await timeout.client
      .get({ providerId: 'cboe.quotes', url: CBOE_URL })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderTimeoutError);
    expect((err as ProviderTimeoutError).timeoutMs).toBe(10_000);
    expect(timeout.calls.length).toBe(3);
  });

  it('does not retry in replay mode, and never reaches the transport', async () => {
    const clock = new VirtualClock(START);
    const sleeper = recordingSleeper(clock);
    const stub = stubTransport(() => ok('{}'));
    const client = new ProviderHttpClient({
      config: config({ PROVIDER_MODE: 'replay' }),
      clock,
      sleeper,
      transport: stub.transport,
    });

    await expect(
      client.get({ providerId: 'cboe.quotes', url: 'https://cdn.cboe.com/api/nothing-here.json' }),
    ).rejects.toBeInstanceOf(ReplayMissError);
    expect(stub.calls.length).toBe(0);
    expect(sleeper.slept).toEqual([]);
    expect(client.breaker('cboe.quotes').consecutiveFailures).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §2.4 — conditional requests and the TTL cache
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('conditional requests and the TTL cache (PROVIDERS.a §2.4)', () => {
  const BODY = '{"data":{"last":233.5}}';

  it('revalidates with If-None-Match and serves the stored body on a 304', async () => {
    const { client, calls, clock } = harness((_req, n) =>
      n === 1 ? ok(BODY, { etag: 'W/"v1"' }) : status(304, { etag: 'W/"v1"' }),
    );

    const first = await client.get({ providerId: 'cboe.quotes', url: CBOE_URL, cacheTtlMs: 0 });
    expect(first.status).toBe(200);
    expect(first.origin).toBe('live');
    expect(calls[0]?.headers['if-none-match']).toBeUndefined();

    clock.advance(30_000);
    const second = await client.get({ providerId: 'cboe.quotes', url: CBOE_URL, cacheTtlMs: 0 });
    expect(calls[1]?.headers['if-none-match']).toBe('W/"v1"');
    expect(second.status).toBe(304);
    expect(second.origin).toBe('cache');
    expect(second.body.toString('utf8')).toBe(BODY);
    expect(second.sha256).toBe(first.sha256);
    // FEED-05: a revalidation publishes nothing new, so `cap` does not advance and the screen
    // keeps ageing (§2.4, §1.3 — and no provenance row is written for a 304).
    expect(second.capturedAt).toBe(first.capturedAt);
  });

  it('sends If-Modified-Since when the source only offers Last-Modified', async () => {
    const lastModified = 'Tue, 15 Sep 2026 18:41:28 GMT';
    const { client, calls } = harness((_req, n) =>
      n === 1 ? ok(BODY, { 'last-modified': lastModified }) : status(304),
    );

    const first = await client.get({ providerId: 'cboe.quotes', url: CBOE_URL, cacheTtlMs: 0 });
    expect(first.sourceTs?.toISOString()).toBe('2026-09-15T18:41:28.000Z');

    await client.get({ providerId: 'cboe.quotes', url: CBOE_URL, cacheTtlMs: 0 });
    expect(calls[1]?.headers['if-modified-since']).toBe(lastModified);
    expect(calls[1]?.headers['if-none-match']).toBeUndefined();
  });

  it('answers inside the TTL without a request and without a token', async () => {
    const { client, calls, clock } = harness(() => ok(BODY, { etag: 'W/"v1"' }));

    const first = await client.get({
      providerId: 'cboe.symbolBook',
      url: 'https://cdn.cboe.com/api/global/us_options/symbol_book/symbol-book.json',
    });
    expect(first.origin).toBe('live');

    clock.advance(60_000);
    // Read the bucket after the clock has moved: what the next assertion proves is that the
    // cached answer spends nothing, not that the bucket never refills.
    const beforeCached = client.tokens('cboe.symbolBook').available;
    const cached = await client.get({
      providerId: 'cboe.symbolBook',
      url: 'https://cdn.cboe.com/api/global/us_options/symbol_book/symbol-book.json',
    });
    expect(calls.length).toBe(1);
    expect(cached.origin).toBe('cache');
    expect(cached.status).toBe(200);
    expect(cached.body.toString('utf8')).toBe(BODY);
    expect(client.tokens('cboe.symbolBook').available).toBeCloseTo(beforeCached, 9);

    // The symbol book's TTL is 6 h (§2.4); past it, the client revalidates.
    expect(defaultCacheTtlMs('cboe.symbolBook')).toBe(6 * 60 * 60 * 1000);
    expect(defaultCacheTtlMs('yahoo.search')).toBe(5 * 60 * 1000);
    expect(defaultCacheTtlMs('frankfurter')).toBe(60 * 60 * 1000);
    expect(defaultCacheTtlMs('coingecko.simple')).toBe(30 * 1000);
    expect(defaultCacheTtlMs('cboe.quotes')).toBe(0);

    clock.advance(6 * 60 * 60 * 1000);
    await client.get({
      providerId: 'cboe.symbolBook',
      url: 'https://cdn.cboe.com/api/global/us_options/symbol_book/symbol-book.json',
    });
    expect(calls.length).toBe(2);
    expect(calls[1]?.headers['if-none-match']).toBe('W/"v1"');
  });

  it('replaces the stored body when a revalidation returns 200', async () => {
    const { client, clock } = harness((_req, n) =>
      n === 1 ? ok('{"seqno":1}', { etag: 'a' }) : ok('{"seqno":2}', { etag: 'b' }),
    );

    const first = await client.get({ providerId: 'cboe.quotes', url: CBOE_URL, cacheTtlMs: 0 });
    clock.advance(1000);
    const second = await client.get({ providerId: 'cboe.quotes', url: CBOE_URL, cacheTtlMs: 0 });

    expect(second.status).toBe(200);
    expect(second.origin).toBe('live');
    expect(second.body.toString('utf8')).toBe('{"seqno":2}');
    expect(second.capturedAt).toBe(first.capturedAt + 1000);
    expect(second.sha256).not.toBe(first.sha256);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §2.5 — the circuit breaker
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('circuit breaker (PROVIDERS.a §2.5)', () => {
  /** Five failed requests, each of which has already spent its three attempts. */
  async function failFiveTimes(h: Harness): Promise<void> {
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i += 1) {
      await expect(
        h.client.get({ providerId: 'cboe.quotes', url: CBOE_URL, budgetShare: 'interactive' }),
      ).rejects.toBeInstanceOf(ProviderHttpError);
    }
  }

  it('opens at five consecutive failures and refuses further requests without a token', async () => {
    const h = harness(() => status(500, {}, 'boom'), { lines: [4001, 4002] });

    await failFiveTimes(h);
    expect(BREAKER_FAILURE_THRESHOLD).toBe(5);
    expect(h.calls.length).toBe(5 * MAX_ATTEMPTS);

    const state = h.client.breaker('cboe.quotes');
    expect(state.state).toBe('open');
    expect(state.consecutiveFailures).toBe(5);
    expect(state.openedAt).toBe(h.clock.now());

    // One dq_events row per opening: kind `provider_circuit_open`, severity `error`, with the
    // details the OPS-03 row carries.
    expect(h.sink.opened.length).toBe(1);
    expect(h.sink.opened[0]).toMatchObject({
      providerId: 'cboe.quotes',
      consecutiveFailures: 5,
      lastStatus: 500,
      lastUrl: CBOE_URL,
      retryAtMs: (h.sink.opened[0]?.openedAt ?? 0) + BREAKER_HALF_OPEN_MS,
    });

    // Every md_line of that source is PROVIDER_DOWN (step 3) — the sink reports which.
    expect(h.client.isProviderDown('cboe.quotes')).toBe(true);
    expect(h.client.downMdLines('cboe.quotes')).toEqual([4001, 4002]);

    const tokensBefore = h.client.tokens('cboe.quotes').available;
    const callsBefore = h.calls.length;
    await expect(h.client.get({ providerId: 'cboe.quotes', url: CBOE_URL })).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(h.calls.length).toBe(callsBefore);
    expect(h.client.tokens('cboe.quotes').available).toBeCloseTo(tokensBefore, 9);

    // An unrelated provider is untouched: the breaker is per ProviderId.
    expect(h.client.breaker('yahoo.chart').state).toBe('closed');
  });

  it('half-opens exactly 60 s later, lets one probe through, and closes on success', async () => {
    let healthy = false;
    const h = harness(() => (healthy ? ok('{"ok":1}') : status(500)));

    await failFiveTimes(h);
    const openedAt = h.client.breaker('cboe.quotes').openedAt ?? 0;

    h.clock.advanceTo(openedAt + BREAKER_HALF_OPEN_MS - 1);
    expect(h.client.breaker('cboe.quotes').state).toBe('open');
    await expect(h.client.get({ providerId: 'cboe.quotes', url: CBOE_URL })).rejects.toBeInstanceOf(
      CircuitOpenError,
    );

    h.clock.advanceTo(openedAt + BREAKER_HALF_OPEN_MS);
    expect(h.client.breaker('cboe.quotes').state).toBe('half_open');

    healthy = true;
    const callsBefore = h.calls.length;
    const raw = await h.client.get({
      providerId: 'cboe.quotes',
      url: CBOE_URL,
      budgetShare: 'interactive',
    });
    expect(raw.status).toBe(200);
    expect(h.calls.length).toBe(callsBefore + 1);

    expect(h.client.breaker('cboe.quotes')).toEqual({
      state: 'closed',
      consecutiveFailures: 0,
      openedAt: null,
    });
    expect(h.sink.closed).toEqual(['cboe.quotes']);
    expect(h.client.isProviderDown('cboe.quotes')).toBe(false);
  });

  it('re-opens for another 60 s when the half-open probe fails', async () => {
    const h = harness(() => status(500));

    await failFiveTimes(h);
    const firstOpenedAt = h.client.breaker('cboe.quotes').openedAt ?? 0;

    h.clock.advanceTo(firstOpenedAt + BREAKER_HALF_OPEN_MS);
    await expect(
      h.client.get({ providerId: 'cboe.quotes', url: CBOE_URL, budgetShare: 'interactive' }),
    ).rejects.toBeInstanceOf(ProviderHttpError);

    const state = h.client.breaker('cboe.quotes');
    expect(state.state).toBe('open');
    expect(state.openedAt).toBe(h.clock.now());
    expect(state.openedAt).toBeGreaterThan(firstOpenedAt);
    expect(h.sink.opened.length).toBe(2);
    expect(h.sink.opened[1]?.retryAtMs).toBe((state.openedAt ?? 0) + BREAKER_HALF_OPEN_MS);

    // …and it is shut again until that new window elapses.
    h.clock.advance(BREAKER_HALF_OPEN_MS - 1);
    await expect(h.client.get({ providerId: 'cboe.quotes', url: CBOE_URL })).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
  });

  it('counts only failures the provider is responsible for, and a success resets the run', async () => {
    const h = harness((_req, n) => (n === 5 ? status(404) : status(500)));

    // Requests 1 and 2 fail (three attempts each: calls 1-3 and 4-6, call 5 being the 404 is
    // retried past). A 404 alone would not count at all.
    await expect(
      h.client.get({ providerId: 'cboe.quotes', url: CBOE_URL, budgetShare: 'interactive' }),
    ).rejects.toBeInstanceOf(ProviderHttpError);
    expect(h.client.breaker('cboe.quotes').consecutiveFailures).toBe(1);

    const only404 = harness(() => status(404));
    for (let i = 0; i < 6; i += 1) {
      await expect(
        only404.client.get({
          providerId: 'cboe.quotes',
          url: CBOE_URL,
          budgetShare: 'interactive',
        }),
      ).rejects.toBeInstanceOf(ProviderHttpError);
    }
    expect(only404.client.breaker('cboe.quotes').state).toBe('closed');
    expect(only404.client.breaker('cboe.quotes').consecutiveFailures).toBe(0);
    expect(only404.sink.opened).toEqual([]);

    // A success in the middle of a failing run resets the counter.
    let failing = true;
    const mixed = harness(() => (failing ? status(503) : ok('{}')));
    await expect(
      mixed.client.get({ providerId: 'cboe.quotes', url: CBOE_URL, budgetShare: 'interactive' }),
    ).rejects.toBeInstanceOf(ProviderHttpError);
    expect(mixed.client.breaker('cboe.quotes').consecutiveFailures).toBe(1);
    failing = false;
    await mixed.client.get({
      providerId: 'cboe.quotes',
      url: CBOE_URL,
      budgetShare: 'interactive',
    });
    expect(mixed.client.breaker('cboe.quotes').consecutiveFailures).toBe(0);
  });

  it('treats a Yahoo 200 with an empty body as a hard failure, not as "no data"', async () => {
    const h = harness(() => ({ status: 200, headers: {}, body: Buffer.alloc(0) }));

    const err = await h.client
      .get({
        providerId: 'yahoo.chart',
        url: 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1m&range=1d',
        budgetShare: 'interactive',
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(200);
    expect(h.client.breaker('yahoo.chart').consecutiveFailures).toBe(1);
    expect(h.calls.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §2.1 — the modes, over the committed captures
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('modes (PROVIDERS.a §2.1)', () => {
  const manifest = readManifest('../../fixtures/providers');

  function replayClient(): { client: ProviderHttpClient; calls: TransportRequest[] } {
    const stub = stubTransport(() => ok('{}'));
    return {
      client: new ProviderHttpClient({
        config: config({ PROVIDER_MODE: 'replay' }),
        clock: new VirtualClock(START),
        transport: stub.transport,
      }),
      calls: stub.calls,
    };
  }

  it('serves a recorded capture from the replay store, byte for byte', async () => {
    const { client, calls } = replayClient();
    const url = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/AAPL.json';
    const entry = Object.values(manifest).find((e) => e.url === url);
    const capture = entry?.captures[0];
    expect(capture).toBeDefined();

    const raw = await client.get({ providerId: 'cboe.quotes', url });
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.body.length).toBe(capture?.bytes);
    expect(raw.sha256).toBe(capture?.sha256);
    expect(new Date(raw.capturedAt).toISOString()).toBe('2026-09-15T18:41:28.000Z');
    expect(raw.sourceTs?.toISOString()).toBe('2026-09-15T18:41:28.000Z');
    expect(raw.body).toEqual(
      readFileSync(join(resolveReplayDir('../../fixtures/providers'), capture?.file ?? '')),
    );
    expect(calls.length).toBe(0);
  });

  it('is a wall: a request with no capture throws and never opens a socket', async () => {
    const { client, calls } = replayClient();
    const err = await client
      .get({ providerId: 'frankfurter', url: 'https://api.frankfurter.dev/v1/latest?base=ZZZ' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReplayMissError);
    // The nearest recorded URL is reported, so a drifted parameter is a one-line diff.
    expect((err as ReplayMissError).message).toContain('https://api.frankfurter.dev/v1/latest');
    expect(calls.length).toBe(0);

    // The stub transport of replay mode is itself a wall.
    await expect(
      replayWallTransport()({
        method: 'GET',
        url: 'https://example.invalid/',
        headers: {},
        body: undefined,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/refusing to open a socket/);
  });

  it('reports its mode', () => {
    expect(replayClient().client.mode).toBe('replay');
    expect(harness(() => ok('{}')).client.mode).toBe('live');
  });
});
