/**
 * `observability/metrics.ts` — the in-process metric registry and `GET /metrics`
 * (ARCHITECTURE §11 L1207-1211, API.md §5.15 L822).
 *
 * No dependency: `prom-client` would be a second opinion about a text format that is 30 lines to
 * emit, and ARCHITECTURE §12 keeps this process free of anything it does not need. The output is
 * the Prometheus **text exposition format 0.0.4**: one `# HELP` and one `# TYPE` line per metric
 * *name*, then every label combination of that name, with histograms exposing cumulative
 * `_bucket{le=...}` series (always including `+Inf`), a `_sum` and a `_count`.
 *
 * Cardinality is the caller's responsibility — a label value taken from user input is how a
 * registry becomes a memory leak. {@link Metrics.counter} and friends are cheap to call in a hot
 * path: the series is resolved once per distinct `(name, labels)` and cached.
 *
 * **The route is not under `/api/v1`.** API.md §5.15 puts `/metrics` at the root, so `app.ts`
 * registers {@link metricsPlugin} directly rather than letting the generated route barrel pick it
 * up — which is also why this plugin lives here and not in `http/routes/`.
 */

import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { getPool } from '../db/client.js';
import { AuthRequiredError, ForbiddenError } from '../http/errors.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Label set of one series. Values are escaped on render; `undefined` labels are dropped. */
export type Labels = Readonly<Record<string, string | number | boolean | undefined>>;

export interface Counter {
  /** Add `n` (default 1). Negative is a programming error: a counter only goes up. */
  inc(n?: number): void;
}

export interface Histogram {
  observe(v: number): void;
}

export interface Gauge {
  set(v: number): void;
  inc(n?: number): void;
  dec(n?: number): void;
}

export interface MetricOptions {
  /** The `# HELP` line. Defaults to the metric name. */
  help?: string;
  /** Histogram upper bounds, ascending, without `+Inf`. Ignored for counters and gauges. */
  buckets?: readonly number[];
}

export interface Metrics {
  counter(name: string, labels?: Labels, options?: MetricOptions): Counter;
  histogram(name: string, labels?: Labels, options?: MetricOptions): Histogram;
  gauge(name: string, labels?: Labels, options?: MetricOptions): Gauge;
  /**
   * Register a callback run at the start of every {@link Metrics.render}.
   *
   * Gauges that read another component's *current* state — the plant's subject count, the pool's
   * in-use connections, a provider's circuit — belong here rather than being pushed on a timer:
   * the value a scrape reports is then the value at the moment of the scrape, and a process that
   * is never scraped pays nothing. Returns an unregister function so a test (and a shutdown) can
   * take its collector back out.
   */
  onCollect(fn: () => void): () => void;
  /** Prometheus text exposition format 0.0.4, terminated by a newline. */
  render(): string;
  /** Series currently held, for the leak test. */
  size(): number;
  /** Drop every series. Tests only — a running process never forgets a counter. */
  reset(): void;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Format rules
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Prometheus data model: metric names. */
const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
/** Prometheus data model: label names. `__` is reserved for the runtime. */
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Default histogram bounds, in milliseconds — every histogram ARCHITECTURE §11 names is a latency
 * (`plant_publish_latency_ms`, `fn_resolve_ms`, `db_query_ms`, `provider_latency_ms`).
 */
export const DEFAULT_BUCKETS_MS: readonly number[] = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000,
];

/** Escape a label value: backslash, double quote and newline (exposition format §"label values"). */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/** Escape HELP text: backslash and newline only (a quote is legal there). */
function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Exposition format numbers: `+Inf`, `-Inf`, `NaN` are spelled out. */
export function formatValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  if (Number.isInteger(v)) return String(v);
  return String(v);
}

/** Canonical, sorted `{a="1",b="2"}` — or `''` when there are no labels. */
export function renderLabels(labels: Labels, extra?: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  for (const key of Object.keys(labels).sort()) {
    const value = labels[key];
    if (value === undefined) continue;
    if (!LABEL_NAME_RE.test(key)) {
      throw new RangeError(`metrics: "${key}" is not a valid Prometheus label name`);
    }
    parts.push(`${key}="${escapeLabelValue(String(value))}"`);
  }
  if (extra !== undefined) {
    for (const key of Object.keys(extra).sort()) {
      parts.push(`${key}="${escapeLabelValue(extra[key]!)}"`);
    }
  }
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────────────────────

type MetricType = 'counter' | 'gauge' | 'histogram';

interface Family {
  name: string;
  type: MetricType;
  help: string;
  /** Histogram bounds, ascending and without `+Inf`. Empty for counters and gauges. */
  buckets: readonly number[];
  /** Series of this family, keyed by rendered labels (`''` for the unlabelled series). */
  series: Map<string, Series>;
}

interface Series {
  labels: Labels;
  /** Counter/gauge value, or the histogram's running sum. */
  value: number;
  /** Histogram only: per-bucket counts, parallel to `Family.buckets`, plus the `+Inf` slot. */
  counts: number[];
  /** Histogram only: observations. */
  count: number;
}

export function metrics(): Metrics {
  const families = new Map<string, Family>();

  function family(name: string, type: MetricType, options: MetricOptions | undefined): Family {
    if (!METRIC_NAME_RE.test(name)) {
      throw new RangeError(`metrics: "${name}" is not a valid Prometheus metric name`);
    }
    const existing = families.get(name);
    if (existing !== undefined) {
      if (existing.type !== type) {
        // One name, two types renders two `# TYPE` lines for the same family and a scrape that
        // rejects the whole page. Fail at the call site instead.
        throw new TypeError(
          `metrics: "${name}" is already registered as a ${existing.type}, not a ${type}`,
        );
      }
      if (options?.help !== undefined) existing.help = options.help;
      return existing;
    }
    const buckets = type === 'histogram' ? normaliseBuckets(name, options?.buckets) : [];
    const created: Family = {
      name,
      type,
      help: options?.help ?? name,
      buckets,
      series: new Map<string, Series>(),
    };
    families.set(name, created);
    return created;
  }

  function normaliseBuckets(name: string, buckets: readonly number[] | undefined): number[] {
    const source = buckets ?? DEFAULT_BUCKETS_MS;
    const out = [...source];
    for (let i = 0; i < out.length; i++) {
      const b = out[i]!;
      if (!Number.isFinite(b)) {
        throw new RangeError(`metrics: ${name} bucket bounds must be finite (+Inf is implicit)`);
      }
      if (i > 0 && b <= out[i - 1]!) {
        throw new RangeError(`metrics: ${name} bucket bounds must be strictly ascending`);
      }
    }
    return out;
  }

  function series(f: Family, labels: Labels): Series {
    const key = renderLabels(labels);
    const found = f.series.get(key);
    if (found !== undefined) return found;
    const created: Series = {
      labels,
      value: 0,
      counts: f.type === 'histogram' ? new Array<number>(f.buckets.length + 1).fill(0) : [],
      count: 0,
    };
    f.series.set(key, created);
    return created;
  }

  function requireFinite(name: string, v: number): number {
    if (!Number.isFinite(v)) {
      throw new RangeError(`metrics: ${name} was given a non-finite value (${String(v)})`);
    }
    return v;
  }

  const collectors = new Set<() => void>();

  return {
    onCollect(fn: () => void): () => void {
      collectors.add(fn);
      return () => collectors.delete(fn);
    },

    counter(name, labels = {}, options): Counter {
      const s = series(family(name, 'counter', options), labels);
      return {
        inc(n = 1): void {
          if (requireFinite(name, n) < 0) {
            throw new RangeError(`metrics: counter ${name} cannot decrease (got ${String(n)})`);
          }
          s.value += n;
        },
      };
    },

    gauge(name, labels = {}, options): Gauge {
      const s = series(family(name, 'gauge', options), labels);
      return {
        set(v): void {
          s.value = requireFinite(name, v);
        },
        inc(n = 1): void {
          s.value += requireFinite(name, n);
        },
        dec(n = 1): void {
          s.value -= requireFinite(name, n);
        },
      };
    },

    histogram(name, labels = {}, options): Histogram {
      const f = family(name, 'histogram', options);
      const s = series(f, labels);
      return {
        observe(v): void {
          requireFinite(name, v);
          s.value += v;
          s.count += 1;
          // Cumulative buckets: an observation lands in its own bound and every wider one.
          let i = 0;
          while (i < f.buckets.length && v > f.buckets[i]!) i++;
          for (; i < f.buckets.length; i++) s.counts[i] = s.counts[i]! + 1;
          s.counts[f.buckets.length] = s.counts[f.buckets.length]! + 1;
        },
      };
    },

    render(): string {
      for (const collect of collectors) {
        try {
          collect();
        } catch {
          // A collector that cannot read its source must not fail the scrape: the rest of the
          // document is still true, and a missing series is a more honest answer than no document.
        }
      }
      const out: string[] = [];
      for (const name of [...families.keys()].sort()) {
        const f = families.get(name)!;
        if (f.series.size === 0) continue;
        out.push(`# HELP ${f.name} ${escapeHelp(f.help)}`);
        out.push(`# TYPE ${f.name} ${f.type}`);
        for (const key of [...f.series.keys()].sort()) {
          const s = f.series.get(key)!;
          if (f.type !== 'histogram') {
            out.push(`${f.name}${renderLabels(s.labels)} ${formatValue(s.value)}`);
            continue;
          }
          for (let i = 0; i < f.buckets.length; i++) {
            const le = formatValue(f.buckets[i]!);
            out.push(
              `${f.name}_bucket${renderLabels(s.labels, { le })} ${formatValue(s.counts[i]!)}`,
            );
          }
          out.push(
            `${f.name}_bucket${renderLabels(s.labels, { le: '+Inf' })} ${formatValue(s.count)}`,
          );
          out.push(`${f.name}_sum${renderLabels(s.labels)} ${formatValue(s.value)}`);
          out.push(`${f.name}_count${renderLabels(s.labels)} ${formatValue(s.count)}`);
        }
      }
      return out.length === 0 ? '' : `${out.join('\n')}\n`;
    },

    size(): number {
      let n = 0;
      for (const f of families.values()) n += f.series.size;
      return n;
    },

    reset(): void {
      families.clear();
      collectors.clear();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The process registry
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Metrics are process-wide by definition — a scrape of `/metrics` reports this process, not one
 * request's view of it — so the registry is memoised here exactly the way `config.ts` memoises the
 * config, with the same `set…` seam so a test can start from an empty one.
 */
let processMetrics: Metrics | undefined;

export function getMetrics(): Metrics {
  return (processMetrics ??= metrics());
}

/** Test seam: replace the process registry (pass `undefined` to force a fresh one). */
export function setMetrics(next: Metrics | undefined): void {
  processMetrics = next;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The route
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Prometheus' own content type for the 0.0.4 text format. */
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Loopback is decided on the **socket** address, never on `request.ip`.
 *
 * `buildApp` sets `trustProxy: true`, which makes `request.ip` the left-most `X-Forwarded-For`
 * entry — a header the caller writes. Trusting it here would mean `X-Forwarded-For: 127.0.0.1`
 * opens `/metrics` to the internet. `request.socket.remoteAddress` is the peer the kernel accepted
 * and cannot be spoofed by a header.
 */
export function isLoopback(request: FastifyRequest): boolean {
  const address = request.socket.remoteAddress;
  if (address === undefined) return false;
  const bare = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return bare === '127.0.0.1' || bare === '::1' || bare.startsWith('127.');
}

/** Constant-time compare of two presented tokens; length differences do not short-circuit early. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still burn a comparison so the "wrong length" path is not measurably faster.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The process collector (ARCHITECTURE §11 L1207-1211)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `circuit` as a number, because Prometheus has no string values. */
const CIRCUIT_VALUE: Record<string, number> = { closed: 0, half_open: 1, open: 2 };

/**
 * Read the state the rest of the process already computes, and put it on the registry.
 *
 * These are *gauges over somebody else's data structures* — the plant's subject table, the
 * hot set, the connection pool, each provider's breaker and token bucket — so they are sampled at
 * scrape time through {@link Metrics.onCollect} rather than pushed. Nothing here computes anything
 * new: `/status` answers the same numbers from the same objects (OPS-04), which is the point — a
 * dashboard and an operator reading `/status` must not be able to disagree.
 *
 * Every label is low cardinality: a source id from the adapter registry, and nothing a caller can
 * influence.
 */
export function registerProcessCollector(app: FastifyInstance, registry: Metrics): () => void {
  return registry.onCollect(() => {
    const deps = app.deps;

    const plant = deps.plant;
    const stats = plant.stats();
    registry
      .gauge('plant_subjects', {}, { help: 'Subjects held by the ticker plant' })
      .set(stats.subjects);
    registry
      .gauge('plant_state', {}, { help: 'Ticker plant state: 0 ok, 1 degraded' })
      .set(plant.state === 'degraded' ? 1 : 0);
    registry
      .gauge(
        'plant_publish_latency_p99_ms',
        {},
        { help: 'p99 of publish − capture, in milliseconds' },
      )
      .set(stats.publishLatencyP99Ms);

    const hotset = deps.hotset;
    registry.gauge('hotset_size', {}, { help: 'Subjects in the hot set' }).set(hotset?.size ?? 0);
    if (hotset !== undefined) {
      let subscriptions = 0;
      for (const entry of hotset.entries()) subscriptions += entry.subscribers;
      registry
        .gauge('ws_subscriptions', {}, { help: 'Live subject subscriptions' })
        .set(subscriptions);
    }
    registry
      .gauge('ws_sessions', {}, { help: 'Open WebSocket sessions' })
      .set(app.wsGateway?.sessionCount() ?? 0);

    const providers = deps.providers;
    const http = deps.http;
    if (providers !== undefined) {
      for (const adapter of providers.all()) {
        const labels = { source_id: adapter.sourceId };
        const breaker = http?.breaker(adapter.id);
        registry
          .gauge('provider_circuit_state', labels, {
            help: 'Provider circuit: 0 closed, 1 half_open, 2 open',
          })
          .set(CIRCUIT_VALUE[breaker?.state ?? 'closed'] ?? 0);
        registry
          .gauge('provider_bucket_remaining', labels, { help: 'Tokens left in the rate bucket' })
          .set(http?.tokens(adapter.id)?.available ?? 0);
      }
    }

    try {
      const pool = getPool();
      registry
        .gauge('db_pool_in_use', {}, { help: 'Connections checked out of the application pool' })
        .set(Math.max(0, pool.totalCount - pool.idleCount));
      registry
        .gauge('db_pool_total', {}, { help: 'Connections held by the application pool' })
        .set(pool.totalCount);
      registry
        .gauge('db_pool_waiting', {}, { help: 'Requests queued for a connection' })
        .set(pool.waitingCount);
    } catch {
      // No pool in this process (a unit app): there is nothing to report, which is not an error.
    }
  });
}

/**
 * `GET /metrics` — API.md §5.15: public on loopback, otherwise `Authorization: Bearer
 * <METRICS_TOKEN>`. With no `METRICS_TOKEN` configured there is nothing a remote caller could
 * present, so a remote scrape is refused rather than allowed: fail closed.
 *
 * Registered by `app.ts` at the root, because §5.15 puts this path outside `/api/v1`.
 */
export const metricsPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  const unregister = registerProcessCollector(app, getMetrics());
  app.addHook('onClose', (_instance, done) => {
    // A collector holds the app; taking it back out is what lets a test build a hundred apps.
    unregister();
    done();
  });

  app.get('/metrics', async (request, reply) => {
    if (!isLoopback(request)) {
      const expected = app.deps.config.METRICS_TOKEN;
      const header = request.headers.authorization;
      const presented =
        typeof header === 'string' && /^Bearer /i.test(header)
          ? header.slice('Bearer '.length)
          : '';
      if (expected === undefined) {
        throw new ForbiddenError('METRICS_TOKEN is not configured; /metrics is loopback-only.', {
          requiredScope: 'metrics',
        });
      }
      if (presented === '' || !tokenMatches(presented, expected)) {
        throw new AuthRequiredError('A valid METRICS_TOKEN bearer token is required.');
      }
    }
    void reply.header('content-type', METRICS_CONTENT_TYPE);
    void reply.header('cache-control', 'no-store');
    return getMetrics().render();
  });

  // The plugin signature is `FastifyPluginAsync` and registration is synchronous; the same
  // one-liner `http/routes/health.ts` uses to satisfy `require-await`.
  await Promise.resolve();
};
