/**
 * WP-08 — `observability/metrics.ts`: the in-process registry, the Prometheus text exposition
 * format, and `GET /metrics` at the **root** (API.md §5.15), guarded by loopback or
 * `Authorization: Bearer <METRICS_TOKEN>`.
 *
 * The rendering assertions are against the format, not against a golden blob: `# HELP` and
 * `# TYPE` once per family, label escaping, cumulative histogram buckets with an explicit `+Inf`,
 * `_sum` and `_count`. A line-by-line parser re-reads the output so "valid exposition format" is
 * checked rather than asserted.
 *
 * The route assertions use `buildApp` through `src/test/app.ts`, because the one thing that must
 * not regress is the path: `/metrics`, not `/api/v1/metrics`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BUCKETS_MS,
  escapeLabelValue,
  formatValue,
  getMetrics,
  METRICS_CONTENT_TYPE,
  metrics,
  renderLabels,
  setMetrics,
} from '../../../src/observability/metrics.js';
import { createTestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';

/** Split an exposition page into its lines, dropping the trailing newline. */
function lines(text: string): string[] {
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1).split('\n');
}

/** Every sample line (`# …` removed), as `[series, value]`. */
function samples(text: string): [string, string][] {
  return lines(text)
    .filter((l) => !l.startsWith('#'))
    .map((l) => {
      const at = l.lastIndexOf(' ');
      return [l.slice(0, at), l.slice(at + 1)] as [string, string];
    });
}

describe('observability/metrics — registry and exposition format', () => {
  afterEach(() => {
    setMetrics(undefined);
  });

  it('renders counters with one HELP and one TYPE per family', () => {
    const m = metrics();
    m.counter('provider_requests_total', { source: 'cboe.quotes', status: 'ok' }).inc();
    m.counter('provider_requests_total', { source: 'cboe.quotes', status: 'ok' }).inc(2);
    m.counter('provider_requests_total', { source: 'yahoo.quote', status: 'error' }).inc();

    const text = m.render();
    expect(lines(text)).toEqual([
      '# HELP provider_requests_total provider_requests_total',
      '# TYPE provider_requests_total counter',
      'provider_requests_total{source="cboe.quotes",status="ok"} 3',
      'provider_requests_total{source="yahoo.quote",status="error"} 1',
    ]);

    // A second handle for the same series is the same series, not a second one.
    expect(m.size()).toBe(2);
  });

  it('renders a gauge and an unlabelled series', () => {
    const m = metrics();
    m.gauge('ws_sessions', {}, { help: 'Open WebSocket sessions.' }).set(17);
    m.gauge('ws_sessions').inc(3);
    m.gauge('ws_sessions').dec();

    expect(lines(m.render())).toEqual([
      '# HELP ws_sessions Open WebSocket sessions.',
      '# TYPE ws_sessions gauge',
      'ws_sessions 19',
    ]);
  });

  it('renders a histogram with cumulative buckets, +Inf, _sum and _count', () => {
    const m = metrics();
    const h = m.histogram('fn_resolve_ms', { code: 'DES' }, { buckets: [1, 10, 100] });
    for (const v of [0.5, 5, 50, 500]) h.observe(v);

    const text = m.render();
    expect(lines(text)).toEqual([
      '# HELP fn_resolve_ms fn_resolve_ms',
      '# TYPE fn_resolve_ms histogram',
      'fn_resolve_ms_bucket{code="DES",le="1"} 1',
      'fn_resolve_ms_bucket{code="DES",le="10"} 2',
      'fn_resolve_ms_bucket{code="DES",le="100"} 3',
      'fn_resolve_ms_bucket{code="DES",le="+Inf"} 4',
      'fn_resolve_ms_sum{code="DES"} 555.5',
      'fn_resolve_ms_count{code="DES"} 4',
    ]);

    // The +Inf bucket always equals _count — the property a scrape relies on.
    const found = new Map(samples(text));
    expect(found.get('fn_resolve_ms_bucket{code="DES",le="+Inf"}')).toBe(
      found.get('fn_resolve_ms_count{code="DES"}'),
    );
  });

  it('puts an observation exactly on a bound into that bucket', () => {
    const m = metrics();
    const h = m.histogram('db_query_ms', {}, { buckets: [10, 20] });
    h.observe(10);
    h.observe(20);
    h.observe(20.000001);

    const found = new Map(samples(m.render()));
    expect(found.get('db_query_ms_bucket{le="10"}')).toBe('1');
    expect(found.get('db_query_ms_bucket{le="20"}')).toBe('2');
    expect(found.get('db_query_ms_bucket{le="+Inf"}')).toBe('3');
  });

  it('uses millisecond latency buckets by default', () => {
    const m = metrics();
    m.histogram('plant_publish_latency_ms').observe(3);
    const bounds = samples(m.render())
      .filter(([series]) => series.startsWith('plant_publish_latency_ms_bucket'))
      .map(([series]) => /le="([^"]+)"/.exec(series)?.[1]);
    expect(bounds).toEqual([...DEFAULT_BUCKETS_MS.map(String), '+Inf']);
  });

  it('escapes label values and spells out the special floats', () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    expect(formatValue(Infinity)).toBe('+Inf');
    expect(formatValue(-Infinity)).toBe('-Inf');
    expect(formatValue(Number.NaN)).toBe('NaN');
    expect(renderLabels({ b: 2, a: 'x', gone: undefined })).toBe('{a="x",b="2"}');

    const m = metrics();
    m.counter('plant_updates_dropped_total', { reason: 'slow "consumer"\nbackpressure' }).inc();
    const line = lines(m.render()).find((l) => !l.startsWith('#'))!;
    expect(line).toBe('plant_updates_dropped_total{reason="slow \\"consumer\\"\\nbackpressure"} 1');
    // One physical line: an unescaped newline would split the sample in two and break the scrape.
    expect(lines(m.render()).filter((l) => !l.startsWith('#'))).toHaveLength(1);
  });

  it('refuses a name or label that Prometheus would reject, and a type collision', () => {
    const m = metrics();
    expect(() => m.counter('not a name')).toThrow(/valid Prometheus metric name/);
    expect(() => m.counter('ok_total', { 'bad-label': 'x' })).toThrow(
      /valid Prometheus label name/,
    );
    m.counter('ws_sessions_total').inc();
    expect(() => m.gauge('ws_sessions_total')).toThrow(/already registered as a counter/);
    expect(() => m.counter('ok_total').inc(-1)).toThrow(/cannot decrease/);
    expect(() => m.gauge('ok_gauge').set(Number.NaN)).toThrow(/non-finite/);
    expect(() => m.histogram('h_ms', {}, { buckets: [10, 5] })).toThrow(/strictly ascending/);
  });

  it('renders an empty registry as the empty string', () => {
    expect(metrics().render()).toBe('');
  });

  it('memoises one registry per process, with a test seam', () => {
    setMetrics(undefined);
    const first = getMetrics();
    expect(getMetrics()).toBe(first);
    const replacement = metrics();
    setMetrics(replacement);
    expect(getMetrics()).toBe(replacement);
  });
});

describe('GET /metrics — API.md §5.15', () => {
  // The route reads no table, but the app is the real one: hand it the test transaction so no
  // handler anywhere can reach a pool this file would then have to close.
  const t = withTxDb();

  afterEach(() => {
    setMetrics(undefined);
  });

  it('serves the exposition page at the root, NOT under /api/v1', async () => {
    const registry = metrics();
    registry.counter('scheduler_lag_ms_total').inc(4);
    setMetrics(registry);

    const harness = await createTestApp({ db: t.db, clock: testClock() });
    try {
      const ok = await harness.app.inject({ method: 'GET', url: '/metrics' });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toBe(METRICS_CONTENT_TYPE);
      expect(ok.headers['cache-control']).toBe('no-store');
      expect(ok.body).toContain('scheduler_lag_ms_total 4');

      const prefixed = await harness.app.inject({ method: 'GET', url: '/api/v1/metrics' });
      expect(prefixed.statusCode).toBe(404);
    } finally {
      await harness.close();
    }
  });

  it('refuses a remote scrape without the bearer token and accepts it with', async () => {
    setMetrics(metrics());
    const token = 'metrics-token-1234567890';
    const harness = await createTestApp({
      db: t.db,
      clock: testClock(),
      config: { METRICS_TOKEN: token },
    });
    try {
      // `inject` presents 127.0.0.1 as the socket address, so force the non-loopback branch by
      // asking for a remote peer.
      const remote = { remoteAddress: '203.0.113.9' };

      const anonymous = await harness.app.inject({ method: 'GET', url: '/metrics', ...remote });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json().error.code).toBe('AUTH_REQUIRED');

      const wrong = await harness.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer metrics-token-0000000000' },
        ...remote,
      });
      expect(wrong.statusCode).toBe(401);

      const right = await harness.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${token}` },
        ...remote,
      });
      expect(right.statusCode).toBe(200);
    } finally {
      await harness.close();
    }
  });

  it('never accepts a forged X-Forwarded-For as loopback', async () => {
    setMetrics(metrics());
    const harness = await createTestApp({
      db: t.db,
      clock: testClock(),
      config: { METRICS_TOKEN: 'a'.repeat(24) },
    });
    try {
      // `trustProxy` is on, so `request.ip` here IS 127.0.0.1 — the guard reads the socket.
      const forged = await harness.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { 'x-forwarded-for': '127.0.0.1' },
        remoteAddress: '203.0.113.9',
      });
      expect(forged.statusCode).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it('refuses a remote scrape outright when no METRICS_TOKEN is configured', async () => {
    setMetrics(metrics());
    const harness = await createTestApp({ db: t.db, clock: testClock() });
    try {
      const remote = await harness.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer anything-at-all-here' },
        remoteAddress: '203.0.113.9',
      });
      expect(remote.statusCode).toBe(403);
      expect(remote.json().error.code).toBe('FORBIDDEN');
    } finally {
      await harness.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// What a scrape of a healthy server actually contains (ARCHITECTURE §11 L1207-1211)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the scrape of a running server is not empty', () => {
  const t = withTxDb();

  afterEach(() => {
    setMetrics(undefined);
  });

  it('counts and times every matched HTTP route, and never mints a series for an unmatched path', async () => {
    setMetrics(metrics());
    const harness = await createTestApp({ db: t.db, clock: testClock() });
    try {
      // Two requests that reach a real route (unauthenticated — the metric is about the HTTP
      // surface, not about who was allowed through) and one path the router does not know.
      await harness.app.inject({ method: 'GET', url: '/api/v1/functions' });
      await harness.app.inject({ method: 'GET', url: '/health' });
      await harness.app.inject({ method: 'GET', url: '/no/such/path/2f3a' });

      const body = (await harness.app.inject({ method: 'GET', url: '/metrics' })).body;

      // The route PATTERN is the label, never the raw URL: a label a caller can vary is how a
      // registry becomes a memory leak.
      expect(body).toContain('route="/api/v1/functions"');
      expect(body).toContain('route="/health"');
      expect(body).toContain('http_requests_total');
      expect(body).toContain('http_request_duration_ms_bucket');
      expect(body).toContain('http_request_duration_ms_count');

      // The unmatched path contributed nothing at all.
      expect(body).not.toContain('/no/such/path');

      // And it is still a valid exposition page.
      expect(lines(body).some((l) => l.startsWith('# TYPE http_requests_total counter'))).toBe(
        true,
      );
    } finally {
      await harness.close();
    }
  });

  it('samples the plant, the hot set and the pool at scrape time', async () => {
    setMetrics(metrics());
    const harness = await createTestApp({ db: t.db, clock: testClock() });
    try {
      // No request at all: a scrape of a server that has served nothing must still describe it.
      const body = (await harness.app.inject({ method: 'GET', url: '/metrics' })).body;
      for (const name of ['plant_subjects', 'plant_state', 'hotset_size', 'ws_sessions']) {
        expect(body, name).toContain(name);
      }
      expect(body.length).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });

  it('takes its collector back out when the app closes', async () => {
    const registry = metrics();
    setMetrics(registry);
    const harness = await createTestApp({ db: t.db, clock: testClock() });
    await harness.app.inject({ method: 'GET', url: '/metrics' });
    await harness.close();

    // A collector that outlived its app would hold the whole Fastify instance — and would read a
    // plant that has been shut down on the next scrape.
    expect(() => registry.render()).not.toThrow();
  });
});
