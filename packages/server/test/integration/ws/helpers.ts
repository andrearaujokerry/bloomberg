/**
 * Shared harness for the `test/integration/ws/**` suites (TESTING.md §10).
 *
 * These are the only tests in the repository that speak over a **real** socket: the gateway is
 * driven exactly as a browser drives it, through `ws`, on `127.0.0.1:0`. Everything else stays
 * deterministic — the clock is a `VirtualClock`, the quote is the recorded `cboe-quote-AAPL`
 * fixture, and the follow-on ticks come from WP-05's seeded `SimFeed`, so the only real time in a
 * test is the socket's own latency.
 *
 * Self-sufficiency is the rule (WP-15's seed does not exist): every firm, user, session,
 * instrument, listing and md line a test needs is created inside that test's own `withTxDb()`
 * transaction, and that transaction is the app's database handle, so the gateway's own reads see
 * the rows and everything rolls back afterwards.
 */

import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';

import type {
  AssetClass,
  EntitlementDecision,
  EntitlementRequest,
  FieldClass,
  FieldId,
  NormalisedUpdate,
  QuoteFields,
  ReasonCode,
  Tier,
} from '@terminal/core';
import { getField } from '@terminal/core';
import type { ClientMsgInput, ServerMsg } from '@terminal/sdk/wire/ws';

import { buildApp, type AppDeps, type ServerState } from '../../../src/app.js';
import { getConfig, type Config } from '../../../src/config.js';
import type { Plant } from '../../../src/plant/tickerPlant.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import type { TestDb } from '../../../src/test/db.js';
import type { WsAuthenticator } from '../../../src/ws/auth.js';
import type { BackpressureThresholds } from '../../../src/ws/conflator.js';
import type { WsAppOptions } from '../../../src/ws/gateway.js';
import type {
  WsEntitlements,
  WsLimits,
  WsQuotas,
  WsTimerHandle,
  WsTimers,
} from '../../../src/ws/session.js';
import type { HotSet } from '../../../src/ingest/hotset.js';
import { readNormalised } from '../../../src/test/fixtures.js';

// `src/test/fixtures.ts` resolves `REPLAY_DIR` against `packages/server`; the repository `.env`
// carries a root-relative path that lands one directory too deep. The captures are a fixed part of
// the repository, so the absolute path is pinned here (as `test/integration/plant/store.test.ts`
// does).
process.env.REPLAY_DIR = fileURLToPath(
  new URL('../../../../../fixtures/providers', import.meta.url),
);

/** The AAPL fixture's capture instant — the clock every WS suite starts at, so its `snap` is live. */
export const GOLDEN_CAPTURE_MS = 1_789_497_688_000;

/** Bitemporal validity floor for the rows a test creates. */
const VALID_FROM = new Date('2020-01-01T00:00:00Z');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The app
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface StartedWsApp {
  url: string;
  app: FastifyInstance;
  deps: AppDeps;
  close(): Promise<void>;
}

export interface StartWsAppOptions {
  t: TestDb;
  clock: { now(): number };
  plant: Plant;
  entitlements?: WsEntitlements;
  auth?: WsAuthenticator;
  hotset?: HotSet;
  thresholds?: Partial<BackpressureThresholds>;
  timers?: WsTimers;
  limits?: Partial<WsLimits>;
  /**
   * API-06. The gateway reads the session's concurrent-subscription ceiling from it once, at
   * `hello`. Omitted — as it is everywhere in the WP-06 suite — the ceiling is `limits`'s.
   */
  quotas?: WsQuotas;
  /** Event-loop lag in ms, read once per gateway sweep (NFR-02; `ws/gateway.ts#checkOverload`). */
  lagProbe?: () => number;
  config?: Partial<Config>;
}

/**
 * The production `buildApp`, listening on an ephemeral loopback port, with the test transaction as
 * its database handle and the WS ports injected through `AppDeps.ws`.
 */
export async function startWsApp(options: StartWsAppOptions): Promise<StartedWsApp> {
  const config: Config = { ...getConfig(), ...options.config };
  const ws: WsAppOptions = {};
  if (options.entitlements !== undefined) ws.entitlements = options.entitlements;
  if (options.auth !== undefined) ws.auth = options.auth;
  if (options.hotset !== undefined) ws.hotset = options.hotset;
  if (options.thresholds !== undefined) ws.thresholds = options.thresholds;
  if (options.timers !== undefined) ws.timers = options.timers;
  if (options.limits !== undefined) ws.limits = options.limits;
  if (options.quotas !== undefined) ws.quotas = options.quotas;
  if (options.lagProbe !== undefined) ws.lagProbe = options.lagProbe;

  const state: ServerState = {
    phase: 'ok',
    startedAtMs: options.clock.now(),
    migrationsPending: 0,
    scheduler: false,
  };
  const deps: AppDeps = {
    config,
    clock: options.clock,
    db: options.t.db,
    plant: options.plant,
    state,
    ws,
  };

  const app = buildApp(deps, { logger: false });
  await app.ready();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const port = new URL(address).port;

  return {
    url: `ws://127.0.0.1:${port}/ws/v1`,
    app,
    deps,
    close: async (): Promise<void> => {
      await app.wsGateway.close();
      await app.close();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reference data
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One bootstrap `provenance` row — the only FK the master repositories need. */
export async function bootstrapProvenance(
  t: TestDb,
  sourceId: string,
  label: string,
): Promise<number> {
  await t.client.query(
    `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind, attribution,
                                   rate_limit, valid_from)
     SELECT $1, $1, 'Terminal', 'internal', 'Internal', 'n/a', timestamptz '2000-01-01'
      WHERE NOT EXISTS (SELECT 1 FROM licence_registry WHERE source_id = $1 AND tx_to = 'infinity')`,
    [sourceId],
  );
  const key = `${label}-${randomUUID()}`;
  const res = await t.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, adapter_version)
     VALUES ($1, $2, 'test://ws/' || $2, digest($2, 'sha256'), digest($2, 'sha256'),
             200, 0, $3, 'test/1.0.0')
     RETURNING provenance_id`,
    [sourceId, key, new Date(GOLDEN_CAPTURE_MS).toISOString()],
  );
  return Number(res.rows[0]!.provenance_id);
}

export interface SeededInstrument {
  instrumentId: number;
  mdLineId: number;
  listingId: number;
  provenanceId: number;
  subject: string;
}

/**
 * An instrument, its primary listing and one md line, through WP-04's repositories. The line's
 * delay, cadence and priority are `cboe.quotes`'s own (PROVIDERS §5.1): 15 min, 10 s, priority 10.
 */
export async function seedQuoteInstrument(
  t: TestDb,
  spec: {
    ticker: string;
    name?: string;
    sourceId?: string;
    providerSymbol?: string;
    assetClass?: AssetClass;
    expectedIntervalMs?: number;
    priority?: number;
  },
): Promise<SeededInstrument> {
  const sourceId = spec.sourceId ?? 'cboe.quotes';
  const name = spec.name ?? `${spec.ticker} Inc`;
  const assetClass = spec.assetClass ?? 'equity';
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, 'internal.user', `ws-${spec.ticker}`);
  await bootstrapProvenance(t, sourceId, `ws-src-${spec.ticker}`);
  const o = { validFrom: VALID_FROM, provenanceId };

  const issuerId = await repos.issuers.insert({ name: `${name} issuer` }, o);
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass,
      securityType: assetClass === 'equity' ? 'Common Stock' : 'Index',
      name,
      currency: 'USD',
    },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass,
      marketSector: assetClass === 'equity' ? 'Equity' : 'Index',
      ticker: spec.ticker,
      exchCode: 'US',
      name,
      currency: 'USD',
    },
    o,
  );
  const listingId = await repos.listings.insert(
    { instrumentId, exchCode: 'UW', localTicker: spec.ticker, isPrimary: true, mic: 'XNAS' },
    o,
  );
  const { mdLineId } = await repos.mdLines.upsertBySymbol(
    {
      instrumentId,
      listingId,
      sourceId,
      providerSymbol: spec.providerSymbol ?? spec.ticker,
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: spec.expectedIntervalMs ?? 10_000,
      priority: spec.priority ?? 10,
    },
    o,
  );

  return {
    instrumentId,
    mdLineId,
    listingId,
    provenanceId,
    subject: `q:${String(instrumentId)}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SeededSession {
  userId: number;
  firmId: number;
  sessionId: string;
  /** The raw bearer token; `sessions.token_hash` holds its sha256 and nothing else. */
  token: string;
  /** `Cookie:` header value for a web session (signed `tsid`), else `undefined`. */
  cookie?: string;
}

async function insertPrincipal(
  t: TestDb,
  spec: { email?: string; firmName?: string; role?: string },
): Promise<{ userId: number; firmId: number }> {
  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [spec.firmName ?? `WS Test Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING user_id`,
    [
      firmId,
      spec.email ?? `ws-${randomUUID()}@demo.invalid`,
      'WS Test User',
      spec.role ?? 'user',
    ],
  );
  return { userId: Number(user.rows[0]!.user_id), firmId };
}

async function insertSession(
  t: TestDb,
  userId: number,
  clientKind: 'web' | 'api',
  scopes?: readonly string[],
): Promise<{ sessionId: string; token: string }> {
  const token = `tok-${randomUUID()}`;
  const hash = createHash('sha256').update(token, 'utf8').digest();

  // An `api` session is minted BY a key in production (`http/auth/apikeys.ts`), and the key is
  // where its scopes live — `ws/auth.ts` reads them to decide whether the socket may `sub` at all.
  // A session row with `client_kind='api'` and no key behind it carries no scopes and can do
  // nothing, which is right for production and useless as a fixture, so the fixture mints the key.
  let apiKeyId: number | null = null;
  if (clientKind === 'api') {
    const key = await t.client.query<{ api_key_id: string }>(
      `INSERT INTO api_keys (user_id, key_hash, label, scopes)
       VALUES ($1, $2, $3, $4) RETURNING api_key_id`,
      [
        userId,
        createHash('sha256').update(`key-${token}`, 'utf8').digest(),
        'ws test key',
        scopes === undefined ? ['data:read', 'fn:run', 'ws:subscribe'] : [...scopes],
      ],
    );
    apiKeyId = Number(key.rows[0]!.api_key_id);
  }

  const res = await t.client.query<{ session_id: string }>(
    `INSERT INTO sessions (user_id, token_hash, client_kind, api_key_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 day') RETURNING session_id`,
    [userId, hash, clientKind, apiKeyId],
  );
  return { sessionId: res.rows[0]!.session_id, token };
}

/** A `web` session plus the signed `tsid` cookie header the browser would present. */
export async function createWebSession(
  t: TestDb,
  spec: { userId?: number; firmId?: number; email?: string; secret?: string } = {},
): Promise<SeededSession & { cookie: string }> {
  const principal =
    spec.userId !== undefined && spec.firmId !== undefined
      ? { userId: spec.userId, firmId: spec.firmId }
      : await insertPrincipal(t, spec.email === undefined ? {} : { email: spec.email });
  const { sessionId, token } = await insertSession(t, principal.userId, 'web');
  const secret = spec.secret ?? getConfig().SESSION_SECRET;
  const signed = cookie.sign(token, secret);
  return {
    ...principal,
    sessionId,
    token,
    cookie: `tsid=${encodeURIComponent(signed)}`,
  };
}

/** An `api` session: the bearer token goes in `hello.token`, never in a cookie. */
export async function createApiSession(
  t: TestDb,
  spec: { userId?: number; firmId?: number; email?: string; scopes?: readonly string[] } = {},
): Promise<SeededSession> {
  const principal =
    spec.userId !== undefined && spec.firmId !== undefined
      ? { userId: spec.userId, firmId: spec.firmId }
      : await insertPrincipal(t, spec.email === undefined ? {} : { email: spec.email });
  const { sessionId, token } = await insertSession(t, principal.userId, 'api', spec.scopes);
  return { ...principal, sessionId, token };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entitlements
// ─────────────────────────────────────────────────────────────────────────────────────────────

const TIER_RANK: Record<Tier, number> = { eod: 0, delayed: 1, realtime: 2 };

export interface FakeGrant {
  /** The firm's grant tier; `null` is "no firm grant at all" (ENTL-05 blank subject). */
  firmTier?: Tier | null;
  /** The user's own cap; defaults to the firm's. */
  userTier?: Tier | null;
  /** `licence_registry` tier cap for the source — every v1 quote source caps at `delayed`. */
  sourceCap?: Tier;
  /** `licence_registry.api_allowed`; `false` rejects a bearer session (LICENCE_FORBIDS_USAGE). */
  apiAllowed?: boolean;
  /** Fields the user's grant does not cover, with the reason they come back `null`. */
  deniedFields?: readonly FieldId[];
  deniedReason?: ReasonCode;
}

/**
 * An in-memory evaluator implementing ARCHITECTURE §10 rules 3-6: the firm grant, the user cap, the
 * licence tier cap per source and `api_allowed`. It is the WP-07 evaluator's shape, not its
 * implementation — WP-07 replaces it and these tests keep passing.
 */
export function fakeEntitlements(grant: FakeGrant): WsEntitlements {
  const deniedFields = new Set<string>(grant.deniedFields ?? []);
  const deniedReason: ReasonCode = grant.deniedReason ?? 'NO_USER_ENTITLEMENT';

  return {
    evaluate(req: EntitlementRequest): Promise<EntitlementDecision> {
      const sourceId = grant.sourceCap === undefined ? '' : 'cboe.quotes';
      const fieldClassOf = (id: FieldId): FieldClass => getField(id)?.fieldClass ?? 'price';

      const deny = (reason: ReasonCode): EntitlementDecision => ({
        effectiveTier: null,
        fields: req.fieldIds.map((fieldId) => ({
          fieldId,
          sourceId,
          fieldClass: fieldClassOf(fieldId),
          decision: 'deny' as const,
          effectiveTier: null,
          reason,
        })),
        downgrades: [],
        logIds: [],
      });

      if (req.usage === 'api' && grant.apiAllowed === false) {
        return Promise.resolve(deny('LICENCE_FORBIDS_USAGE'));
      }
      const firmTier = grant.firmTier === undefined ? 'delayed' : grant.firmTier;
      if (firmTier === null) return Promise.resolve(deny('NO_FIRM_ENTITLEMENT'));
      const userTier = grant.userTier === undefined ? firmTier : grant.userTier;
      if (userTier === null) return Promise.resolve(deny('NO_USER_ENTITLEMENT'));

      const grantTier = TIER_RANK[userTier] < TIER_RANK[firmTier] ? userTier : firmTier;
      const capped: Tier[] = [req.tier, grantTier];
      if (grant.sourceCap !== undefined) capped.push(grant.sourceCap);
      const effectiveTier = capped.reduce((a, b) => (TIER_RANK[a] <= TIER_RANK[b] ? a : b));

      const sourceBinds =
        grant.sourceCap !== undefined && TIER_RANK[grant.sourceCap] === TIER_RANK[effectiveTier];
      const grantBinds = TIER_RANK[grantTier] === TIER_RANK[effectiveTier];
      const reason: ReasonCode = sourceBinds
        ? 'SOURCE_TIER_CAP'
        : grantBinds && TIER_RANK[grantTier] < TIER_RANK[req.tier]
          ? 'NOT_ENTITLED_TIER'
          : grantBinds
            ? 'NOT_ENTITLED_TIER'
            : 'OK';

      const downgraded = TIER_RANK[effectiveTier] < TIER_RANK[req.tier];
      return Promise.resolve({
        effectiveTier,
        fields: req.fieldIds.map((fieldId) => {
          const denied = deniedFields.has(fieldId);
          return {
            fieldId,
            sourceId,
            fieldClass: fieldClassOf(fieldId),
            decision: denied ? ('deny' as const) : downgraded ? ('downgrade' as const) : ('allow' as const),
            effectiveTier: denied ? null : effectiveTier,
            reason: denied ? deniedReason : reason,
          };
        }),
        downgrades: downgraded ? req.fieldIds.map((fieldId) => ({ fieldId, reason })) : [],
        logIds: [],
      });
    },
  };
}

/** A {@link fakeEntitlements} whose grant can be rewritten while a session is live (ENTL-05). */
export interface MutableEntitlements extends WsEntitlements {
  /** Replace the grant every later `evaluate` answers from — a grant revoked mid-session. */
  set(grant: FakeGrant): void;
  /** How many times the evaluator has been asked (one call per subject per `sub`). */
  calls(): number;
}

/**
 * The evaluator TESTING.md §10 row 15 needs: the grant is a variable, not a constructor argument,
 * so a test can revoke it between two frames and then trigger the gateway's grant-change path.
 */
export function mutableEntitlements(initial: FakeGrant): MutableEntitlements {
  let inner = fakeEntitlements(initial);
  let calls = 0;
  return {
    evaluate(req: EntitlementRequest): Promise<EntitlementDecision> {
      calls += 1;
      return inner.evaluate(req);
    },
    set(grant: FakeGrant): void {
      inner = fakeEntitlements(grant);
    },
    calls(): number {
      return calls;
    },
  };
}

/** Everything allowed at the requested tier, capped at `delayed` like every v1 source. */
export function delayedEntitlements(): WsEntitlements {
  return fakeEntitlements({ firmTier: 'delayed', sourceCap: 'delayed' });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The golden quote
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface NormalisedFixture {
  updates: NormalisedUpdate[];
}

let goldenCache: NormalisedUpdate | undefined;

/** The one recorded quote observation, as normalised by WP-05. */
export async function goldenUpdate(): Promise<NormalisedUpdate> {
  if (goldenCache === undefined) {
    const fx = await readNormalised<NormalisedFixture>('cboe-quote-AAPL');
    goldenCache = fx.updates[0]!;
  }
  return goldenCache;
}

/**
 * Apply the recorded AAPL quote to `plant`, re-keyed onto the ids this test seeded.
 *
 * @param patch overrides merged over the update — a later `ts.src`/`srcSeq` and different fields
 * make a second, legitimate tick out of the same recording (the fixture is a single poll, so a
 * delta can never be *derived* from it; every follow-on tick here is explicit).
 */
export async function applyAaplGolden(
  plant: Plant,
  ids: { instrumentId: number; mdLineId: number; provenanceId?: number },
  patch?: {
    fields?: Partial<QuoteFields>;
    srcSeqDelta?: number;
    srcMs?: number;
    capMs?: number;
  },
): Promise<NormalisedUpdate> {
  const golden = await goldenUpdate();
  const update: NormalisedUpdate = {
    ...golden,
    subject: `q:${String(ids.instrumentId)}`,
    instrumentId: ids.instrumentId,
    mdLineId: ids.mdLineId,
    fields: { ...golden.fields, ...(patch?.fields ?? {}) },
    ts: {
      src: patch?.srcMs ?? golden.ts.src,
      cap: patch?.capMs ?? golden.ts.cap,
      pub: 0,
    },
    prov: {
      ...golden.prov,
      provenanceId: ids.provenanceId ?? golden.prov.provenanceId,
      srcSeq: (golden.prov.srcSeq ?? 0) + (patch?.srcSeqDelta ?? 0),
    },
  };
  plant.apply(update);
  return update;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Timers
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ManualTimers extends WsTimers {
  /** Fire every timer whose delay is ≤ `ms`, oldest first. */
  advance(ms: number): number;
  pending(): number;
}

/** A timer port a test drives by hand — for the deadlines a real timer would make slow. */
export function manualTimers(): ManualTimers {
  interface Entry {
    id: number;
    fn: () => void;
    ms: number;
  }
  const entries = new Map<number, Entry>();
  let nextId = 1;
  return {
    setTimeout(fn: () => void, ms: number): WsTimerHandle {
      const id = nextId++;
      entries.set(id, { id, fn, ms });
      return id;
    },
    clearTimeout(handle: WsTimerHandle): void {
      entries.delete(handle as number);
    },
    advance(ms: number): number {
      const due = [...entries.values()].filter((e) => e.ms <= ms);
      let fired = 0;
      for (const entry of due) {
        if (!entries.has(entry.id)) continue;
        entries.delete(entry.id);
        entry.fn();
        fired += 1;
      }
      return fired;
    },
    pending(): number {
      return entries.size;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The client
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface WsClientOptions {
  cookie?: string;
  /** `Authorization: Bearer` on the upgrade (an API client that can set headers). */
  bearer?: string;
}

/**
 * A minimal protocol client: it records every decoded frame in receipt order and unpacks `batch`
 * members into the same list, which is what a frame-order census (TESTING row 1) asserts on.
 */
export class WsClient {
  /** Every frame received, in order; `batch` members are appended after their envelope. */
  readonly frames: ServerMsg[] = [];
  /** The raw frames, envelopes included — for "how many `batch` frames" assertions. */
  readonly envelopes: ServerMsg[] = [];

  #socket: WebSocket;
  #closeCode: number | null = null;
  #closeReason = '';
  #waiters: { predicate: (f: ServerMsg) => boolean; resolve: (f: ServerMsg) => void }[] = [];
  #closeWaiters: (() => void)[] = [];

  constructor(url: string, options: WsClientOptions = {}) {
    const headers: Record<string, string> = {};
    if (options.cookie !== undefined) headers.cookie = options.cookie;
    if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`;
    this.#socket = new WebSocket(url, { headers });
    this.#socket.on('message', (data: unknown) => {
      const parsed: unknown = JSON.parse(String(data));
      const frame = parsed as ServerMsg;
      this.envelopes.push(frame);
      this.#record(frame);
    });
    this.#socket.on('close', (code: number, reason: Buffer) => {
      this.#closeCode = code;
      this.#closeReason = reason.toString();
      for (const w of this.#closeWaiters.splice(0)) w();
    });
    this.#socket.on('error', () => undefined);
  }

  #record(frame: ServerMsg): void {
    this.frames.push(frame);
    if (frame.t === 'batch') {
      for (const member of frame.m) this.frames.push(member);
    }
    for (let i = this.#waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.#waiters[i]!;
      const hit = frame.t === 'batch' ? frame.m.find((m) => waiter.predicate(m)) : undefined;
      if (waiter.predicate(frame)) {
        this.#waiters.splice(i, 1);
        waiter.resolve(frame);
      } else if (hit !== undefined) {
        this.#waiters.splice(i, 1);
        waiter.resolve(hit);
      }
    }
  }

  /** Resolve once the socket is open. */
  async open(): Promise<void> {
    if (this.#socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.#socket.once('open', () => {
        resolve();
      });
      this.#socket.once('close', (code: number) => {
        reject(new Error(`socket closed before open: ${String(code)}`));
      });
      this.#socket.once('error', (err: Error) => {
        reject(err);
      });
    });
  }

  send(msg: ClientMsgInput | Record<string, unknown> | string): void {
    this.#socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  /** The first frame (already received, or the next one) matching `predicate`. */
  next(predicate: (f: ServerMsg) => boolean, timeoutMs = 3_000): Promise<ServerMsg> {
    const seen = this.frames.find(predicate);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise<ServerMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w.resolve !== wrapped);
        reject(
          new Error(
            `timed out after ${String(timeoutMs)} ms; frames so far: ${this.frames
              .map((f) => f.t)
              .join(',')}`,
          ),
        );
      }, timeoutMs);
      const wrapped = (frame: ServerMsg): void => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.#waiters.push({ predicate, resolve: wrapped });
    });
  }

  /** Wait until the server closes the socket, and report the code. */
  async closeCode(timeoutMs = 3_000): Promise<number> {
    if (this.#closeCode !== null) return this.#closeCode;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`socket did not close within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.#closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.#closeCode ?? -1;
  }

  closeReason(): string {
    return this.#closeReason;
  }

  /** `true` once the socket has closed — the code itself is {@link closeCode}'s to await. */
  get closed(): boolean {
    return this.#closeCode !== null;
  }

  /** Destroy the TCP connection without a close frame — what a laptop lid does. */
  kill(): void {
    this.#socket.terminate();
  }

  /**
   * Stop reading from the underlying TCP socket: the receive window closes, the server's kernel
   * send buffer fills and everything it writes after that accumulates in `socket.bufferedAmount`.
   * This is a *stalled reader*, not a dead one — the connection is healthy, the peer is simply not
   * draining it, which is exactly the consumer API.md §6.5 describes.
   */
  pauseSocket(): void {
    this.#rawSocket().pause();
  }

  /** Read again; everything the server buffered while paused is delivered, in order. */
  resumeSocket(): void {
    this.#rawSocket().resume();
  }

  #rawSocket(): { pause(): void; resume(): void } {
    const raw = (this.#socket as unknown as { _socket?: { pause(): void; resume(): void } })._socket;
    if (raw === undefined) throw new Error('socket is not connected yet');
    return raw;
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    this.#socket.close(1000, 'test over');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      this.#closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** Real-time sleep — only for letting a real socket drain between assertions. */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
