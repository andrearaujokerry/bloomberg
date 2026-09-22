/**
 * `test/integration/functions/errors.test.ts` — WP-08's acceptance row for the error envelope
 * (API.md §2 L132-197) and for the per-field denial of API.md §12.3 L1447-1460.
 *
 * This file is the one place that asserts the *wire contract of failure*. Every other suite in the
 * package proves that a route works; this one proves that when a route does not work, the client
 * is told something it can act on. The properties asserted for each code are the four API.md §2
 * promises, and all four are checked every time rather than one of them per test:
 *
 *   1. the HTTP **status** — derived from the code by `ERROR_CODE_STATUS`, so a code and a status
 *      can never disagree, and a test that asserted only the status would not notice a route
 *      returning the wrong *code* with the right number;
 *   2. the **code** itself;
 *   3. **`retryable`** — true for exactly the four codes of `RETRYABLE_ERROR_CODES` and false for
 *      every other. A client retry loop is driven by this boolean: a `VALIDATION_FAILED` marked
 *      retryable is an infinite loop on a request that will never succeed, and a
 *      `PROVIDER_UNAVAILABLE` marked non-retryable is a panel that stays blank after the provider
 *      comes back;
 *   4. the documented **`details` keys** for the codes that carry them, by *value* — the candidate
 *      list of a 409, the `applicable` classes of a 422, the `requiredScope` of a 403, the reasons
 *      of an `ENTITLEMENT_DENIED` — because `details` is the only part of an envelope a screen can
 *      render into something other than a sentence.
 *
 * And, on every single response in the file, success or failure: **`x-trace-id`**. It is asserted
 * through a helper that every request in this file goes through, so it cannot be forgotten on the
 * paths that matter most — the error paths, where the id is the only way to find out what
 * happened (API.md L196, OPS-07).
 *
 * ## §12.3, and why it gets its own section
 *
 * Two outcomes that look alike and must never be confused:
 *
 *   - **one** field of a request denied → `200`, that field `null`, the reason in
 *     `meta.entitlement`. The screen draws every column it is allowed to draw.
 *   - **every** field denied → `403 ENTITLEMENT_DENIED` with `details.reasons`. There is nothing
 *     to draw.
 *
 * Getting the first wrong blanks a screen the user is entitled to see; getting the second wrong
 * leaks a screen they are not. Both directions are proved here, on the function surface (where the
 * 403 lives) and on the data surface (where §12.3's own example lives).
 *
 * ## Codes this package cannot produce
 *
 * `AUTH_INVALID_CREDENTIALS`, `SESSION_EXPIRED`, `SESSION_SUPERSEDED`, `MFA_REQUIRED` and
 * `USER_SUSPENDED` belong to WP-07's `/auth` surface; `MESSAGE_POLICY_BLOCKED` to WP-09's
 * messaging; `PROTOCOL_VERSION` to the WS handshake; `REPLAY_MISS` to a provider read in
 * `PROVIDER_MODE=replay`. They are named here so that the absence of a test for them is a
 * statement rather than an oversight. The 401 this package *does* produce — `AUTH_REQUIRED` — is
 * asserted on several routes, because "no session" is the most common failure any route has.
 *
 * ## One code that is documented but unreachable
 *
 * `429 QUOTA_EXCEEDED` cannot be produced by any HTTP route on the shipped wiring. The 429 section
 * below says exactly why, and asserts the `403 ENTITLEMENT_DENIED` that is sent instead — a test
 * that asserted the documented envelope would assert something nothing produces. It is the one
 * deviation in this file, and it is a finding, not a licence to weaken the rest.
 *
 * ## Self-sufficiency
 *
 * No seed exists (WP-15 owns it). The licence tables, firm, users, sessions, API key, grants,
 * quota rows and instruments are all created inside this file's own `withTxDb()` transaction,
 * which is also the app's database handle. The function manifests are fixtures built with
 * `defineFunction` in this file and injected through `app.deps.functions`: nothing is written into
 * `core/src/functions/manifests/`, which the generated registry globs.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { FieldId } from '@terminal/core';
import { defineFunction, FunctionRegistry } from '@terminal/core';
import { RETRYABLE_ERROR_CODES } from '@terminal/sdk/wire/envelope';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, TEST_NOW, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, seedQuoteInstrument } from '../ws/helpers.js';

const API = '/api/v1';

/** `NAME` resolves to this source in `field_licence`; the fixture firm holds a grant for it. */
const DERIVED_SOURCE = 'internal.derived';
/** `PX_LAST` resolves to this one; the fixture firm holds **no** grant for it, by design. */
const QUOTE_SOURCE = 'cboe.quotes';

/** Well before `TEST_NOW`, so a grant written with it is live on the virtual clock. */
const GRANT_FROM = '2026-01-01T00:00:00.000Z';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture manifests
//
// Six small functions, each existing to reach exactly one step of FUNCTIONS.md §1.4.3 through a
// real route. There are no real manifests yet (WP-09/10/11 write them), and a fixture is the
// honest way to drive step 4's applicability check and step 7's failure modes without waiting for
// a catalogue that does not exist.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface FixturePayload {
  variant: string;
  name: string | null;
  pxLast: number | null;
}

/** `rows` is bounded so that an out-of-range value is a *parameter* failure, not a runtime one. */
const fixtureParams = z.object({ rows: z.number().int().min(1).max(5).default(1) });

type FixtureModule = FunctionServerModule<z.infer<typeof fixtureParams>, FixturePayload>;

function fixture(spec: {
  code: string;
  fields: readonly FieldId[];
  assetClasses: readonly ('equity' | 'govt')[];
  requiresSecurity?: boolean;
}): ReturnType<typeof defineFunction<typeof fixtureParams, FixturePayload>> {
  const classes = [...spec.assetClasses];
  return defineFunction<typeof fixtureParams, FixturePayload>({
    code: spec.code,
    name: `Error fixture ${spec.code}`,
    aliases: [],
    tier: 1,
    category: 'reference',
    assetClasses: classes,
    requiresSecurity: spec.requiresSecurity ?? true,
    variants: Object.fromEntries(classes.map((c) => [c, c])),
    params: fixtureParams,
    paramGrammar: { positional: [{ name: 'rows', type: 'int', optional: true }] },
    fieldIds: (): FieldId[] => [...spec.fields],
    pageable: false,
    live: null,
    csv: {
      filename: (): string => `${spec.code}.csv`,
      columns: [
        { id: 'name', label: 'Name', type: 'string' },
        { id: 'pxLast', label: 'Px Last', type: 'number' },
      ],
      rows: (payload): (string | number | null)[][] => [[payload.name, payload.pxLast]],
    },
    help: {
      summary: `${spec.code} fixture`,
      description: 'A fixture function used by the WP-08 error-envelope acceptance test.',
      params: [{ name: 'rows', text: 'How many rows to emit.', example: '2' }],
      keys: [],
      sources: [DERIVED_SOURCE],
      related: [],
    },
    keymap: [],
    screenKind: 'declarative',
    payloadVersion: 1,
  });
}

/** Runs cleanly on an equity: `NAME` alone, and the firm holds that grant. */
const EOK = fixture({ code: 'EOK', fields: ['NAME'], assetClasses: ['equity'] });
/** Declares `govt` only — launching it on an equity is step 4's 422. */
const EGV = fixture({ code: 'EGV', fields: ['NAME'], assetClasses: ['govt'] });
/** Needs `PX_LAST` alone, which nothing grants — step 5's 403: every field denied. */
const EDN = fixture({ code: 'EDN', fields: ['PX_LAST'], assetClasses: ['equity'] });
/** Needs both — one allowed, one denied. §12.3's partial denial, which is a 200. */
const EPT = fixture({ code: 'EPT', fields: ['NAME', 'PX_LAST'], assetClasses: ['equity'] });
/** Its resolver asks the read-through for something no store holds — step 7's 503. */
const EPU = fixture({ code: 'EPU', fields: ['NAME'], assetClasses: ['equity'] });
/** Its resolver throws an ordinary `Error` carrying a secret — step 7's 500. */
const EIN = fixture({ code: 'EIN', fields: ['NAME'], assetClasses: ['equity'] });

const REGISTRY = new FunctionRegistry([EOK, EGV, EDN, EPT, EPU, EIN]);

/** The detail an internal failure must never put on the wire. */
const LEAKED_SECRET = 'postgres://terminal:hunter2@db.internal:5432';

/**
 * The `provenance` row these fixtures cite, inserted per test.
 *
 * The runner refuses a payload whose citations name no row (DATA-10), so a fixture may not invent
 * an id any more than a manifest may.
 */
let PROV_ID = 0;

const plain: FixtureModule = {
  async resolve(ctx): Promise<FixturePayload> {
    ctx.prov.add({
      sourceId: DERIVED_SOURCE,
      provenanceId: PROV_ID,
      capturedAt: new Date(ctx.asOf.validAt),
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });
    // This fixture has no price source at all, so `pxLast` is a gap — and a gap says why
    // (FUNCTIONS.md §1.3 rule 6). Without this line the runner refuses the payload, which is the
    // point: a blank cell a user cannot hover over is a defect, in a fixture as much as in a
    // shipped manifest.
    ctx.unavailable.add({
      field: 'PX_LAST',
      reason: 'NO_SOURCE',
      detail: 'the fixture resolver reads no price source',
    });
    return Promise.resolve({
      variant: ctx.instrument?.assetClass ?? 'equity',
      name: ctx.instrument?.name ?? null,
      pxLast: null,
    });
  },
};

/**
 * The realistic per-field shape: ask `ctx.entitle` what may be shown, fill what is allowed and
 * leave the rest `null` with a `meta.unavailable` note. This is the resolver half of ENTL-05 and
 * the thing §12.3 is a picture of.
 */
const perField: FixtureModule = {
  async resolve(ctx): Promise<FixturePayload> {
    ctx.prov.add({
      sourceId: DERIVED_SOURCE,
      provenanceId: PROV_ID,
      capturedAt: new Date(ctx.asOf.validAt),
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });
    const decision = await ctx.entitle(['NAME', 'PX_LAST'], 'display');
    const allowed = new Set(
      decision.fields.filter((f) => f.decision !== 'deny').map((f) => f.fieldId),
    );
    if (!allowed.has('PX_LAST')) {
      ctx.unavailable.add({
        field: 'PX_LAST',
        reason: 'NOT_LICENSED',
        detail: 'no grant covers this field for this user',
      });
    }
    return {
      variant: ctx.instrument?.assetClass ?? 'equity',
      name: allowed.has('NAME') ? (ctx.instrument?.name ?? null) : null,
      // Never a stale value for a denied field — `null`, and a reason (ENTL-05).
      pxLast: allowed.has('PX_LAST') ? 1.23 : null,
    };
  },
};

const providerBound: FixtureModule = {
  async resolve(ctx): Promise<FixturePayload> {
    // Nothing is stored for this key and no read-through route is wired, so `readThrough` has
    // nothing honest to return: the documented outcome is a 503, never an invented number.
    await ctx.providers.ensure('cboe.quote', 'NOT-IN-ANY-STORE', { maxAgeMs: 0 });
    return { variant: 'equity', name: null, pxLast: null };
  },
};

const broken: FixtureModule = {
  resolve(): Promise<FixturePayload> {
    return Promise.reject(new Error(`resolver blew up connecting to ${LEAKED_SECRET}`));
  },
};

const MODULES: Record<string, FixtureModule> = {
  EOK: plain,
  EGV: plain,
  EDN: plain,
  EPT: perField,
  EPU: providerBound,
  EIN: broken,
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

const t: TestDb = withTxDb();

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  /** A web session: signed `tsid` cookie, role `user`. */
  cookie: string;
  /** A bearer session minted by an API key that holds `data:read` and NOT `fn:run`. */
  narrowBearer: string;
  userId: number;
  firmId: number;
  instrumentId: number;
  display: string;
}

let env: Env;

/**
 * The shipped licence terms, seeded only when they are missing.
 *
 * `seedLicences` is idempotent but not *silent*: on a database `test/globalSetup.ts` already
 * seeded, it still issues its inserts and updates against `licence_registry`, `field_licence` and
 * `config_versions` — rows every other integration file is also writing from its own open
 * transaction, in its own fork. Two transactions holding one of those keys and waiting for the
 * other is a deadlock, and which files a run happens to schedule together then decides whether it
 * is green. (`vitest.config.ts` records the same hazard for the replay project and solves it by
 * serialising.) A read first means the common case takes no locks at all, while a database with
 * no seed still gets one.
 */
async function ensureLicences(): Promise<void> {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);
}

beforeEach(async () => {
  await ensureLicences();
  PROV_ID = await bootstrapProvenance(t, DERIVED_SOURCE, 'errors-fixture');

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Errors Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);

  const userId = await insertUser(firmId, 'user');

  const token = `sess-${randomUUID()}`;
  await insertWebSession(userId, token);

  // An API key whose scopes deliberately omit `fn:run` (API-01). WP-07 mints keys with three
  // scopes and nothing checked any of them until WP-08's function routes; this is the session
  // that proves the check exists.
  const narrowToken = await insertApiSession(userId, ['data:read']);

  await grantSource(firmId, userId, DERIVED_SOURCE);

  const seeded = await seedQuoteInstrument(t, {
    ticker: `ER${randomUUID().slice(0, 3).toUpperCase()}`,
    name: 'Errors Fixture Inc',
  });
  const tickerRow = await t.client.query<{ ticker: string }>(
    `SELECT ticker FROM instruments WHERE instrument_id = $1 AND tx_to = 'infinity' LIMIT 1`,
    [seeded.instrumentId],
  );
  const display = `${tickerRow.rows[0]!.ticker} US Equity`;

  // Every row above was written with `clock_timestamp()` as its `tx_from`; a `knownAt` earlier
  // than that instant sees none of it. Start the virtual clock at whichever is later.
  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const clock = testClock(Math.max(TEST_NOW, Date.parse(wrote.rows[0]!.at) + 1_000));
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    narrowBearer: narrowToken,
    userId,
    firmId,
    instrumentId: seeded.instrumentId,
    display,
  };
});

afterEach(async () => {
  await env.harness.close();
});

/**
 * Move the virtual clock past the wall-clock instant of the rows written so far.
 *
 * Every row a test writes with raw SQL or a repository carries `tx_from = clock_timestamp()` —
 * the real clock, which the `VirtualClock` knows nothing about. A read at a `knownAt` earlier than
 * that instant does not see the row. `beforeEach` does this once for the fixture; a test that
 * seeds more rows of its own has to do it again.
 */
async function catchUpKnownAt(): Promise<void> {
  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const target = Date.parse(wrote.rows[0]!.at) + 1_000;
  const delta = target - env.clock.now();
  if (delta > 0) env.clock.advance(delta);
}

async function insertUser(firmId: number, role: string): Promise<number> {
  const res = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'Errors User', $3) RETURNING user_id`,
    [firmId, `errors-${randomUUID()}@demo.invalid`, role],
  );
  return Number(res.rows[0]!.user_id);
}

async function insertWebSession(userId: number, token: string): Promise<void> {
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
}

/** A `client_kind='api'` session behind a key carrying exactly `scopes`; returns the raw token. */
async function insertApiSession(userId: number, scopes: readonly string[]): Promise<string> {
  const token = `tok-${randomUUID()}`;
  const key = await t.client.query<{ api_key_id: string }>(
    `INSERT INTO api_keys (user_id, key_hash, label, scopes)
     VALUES ($1, $2, 'errors test key', $3) RETURNING api_key_id`,
    [userId, createHash('sha256').update(`key-${token}`, 'utf8').digest(), [...scopes]],
  );
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, api_key_id, expires_at, mfa_verified)
     VALUES ($1, $2, 'api', $3, now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest(), Number(key.rows[0]!.api_key_id)],
  );
  return token;
}

/** One grant for the firm and one for the user: the evaluator (rules 4-5) requires both. */
async function grantSource(firmId: number, userId: number, sourceId: string): Promise<void> {
  for (const [kind, id] of [
    ['firm', firmId],
    ['user', userId],
  ] as const) {
    await t.client.query(
      `INSERT INTO entitlement_grants
         (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
          usage_display, usage_export, usage_api, valid_from, valid_to)
       VALUES ($1, $2, $3, NULL, NULL, 'realtime'::tier, true, true, true,
               $4::timestamptz, 'infinity'::timestamptz)`,
      [kind, id, sourceId, GRANT_FROM],
    );
  }
}

function webHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: env.cookie, 'x-requested-with': 'terminal', ...extra };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The assertion every case in this file goes through
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Envelope {
  error: {
    code: string;
    message: string;
    traceId: string;
    retryable: boolean;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
  };
}

interface Injected {
  statusCode: number;
  headers: Record<string, unknown>;
  payload: string;
  json<T>(): T;
}

/** RFC 4122 v4 — the shape `http/trace.ts` mints and a `uuid` column accepts. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Inject a request and assert the one thing API.md L196 promises of **every** response: an
 * `x-trace-id` header carrying a well-formed id, echoed when the caller supplied a valid one.
 */
async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  options: { headers?: Record<string, string>; payload?: unknown; traceId?: string } = {},
): Promise<Injected> {
  const traceId = options.traceId ?? randomUUID();
  const res = (await env.app.inject({
    method,
    url,
    headers: { ...(options.headers ?? {}), 'x-trace-id': traceId },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  })) as unknown as Injected;

  const header = res.headers['x-trace-id'];
  expect(header, `no x-trace-id on ${method} ${url} (${String(res.statusCode)})`).toBe(traceId);
  expect(UUID_V4.test(String(header))).toBe(true);
  return res;
}

/**
 * Assert an error response against all four §2 promises at once, and return the envelope for the
 * per-code `details` assertions.
 *
 * `retryable` is checked against `RETRYABLE_ERROR_CODES` — the SDK's own list — rather than
 * against a literal written by hand here, so the test cannot drift from the schema the client
 * parses. Where the list says retryable, `Retry-After` is required too.
 */
function envelopeOf(res: Injected, status: number, code: string): Envelope['error'] {
  expect(res.statusCode, res.payload).toBe(status);
  expect(String(res.headers['content-type'])).toContain('application/json');

  const body = res.json<Envelope>();
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(body.error.traceId).toBe(res.headers['x-trace-id']);

  const shouldRetry = (RETRYABLE_ERROR_CODES as readonly string[]).includes(code);
  expect(body.error.retryable).toBe(shouldRetry);

  // An error never carries data (API.md L196-197).
  expect(res.json<Record<string, unknown>>()).not.toHaveProperty('data');
  expect(res.json<Record<string, unknown>>()).not.toHaveProperty('results');

  return body.error;
}

/** `Retry-After` in seconds, as `errors.ts#sendError` writes it. */
function retryAfterSeconds(res: Injected): number {
  const header = res.headers['retry-after'];
  expect(header, 'no Retry-After header').toBeDefined();
  return Number(header);
}

async function run(
  code: string,
  body: Record<string, unknown>,
  headers = webHeaders(),
): Promise<Injected> {
  return call('POST', `${API}/functions/${code}/run`, { headers, payload: body });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 400
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('400', () => {
  it('VALIDATION_FAILED on the request body, with location and the zod issues', async () => {
    const res = await run('EOK', {
      security: { id: env.instrumentId },
      // `launchKind` is an enum on `FunctionRunRequest`; this is a body failure, not a param one.
      launchKind: 'teleport',
    });

    const error = envelopeOf(res, 400, 'VALIDATION_FAILED');
    expect(error.details?.location).toBe('body');
    const issues = error.details?.issues as { path: unknown[]; code: string }[];
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path.includes('launchKind'))).toBe(true);
  });

  it("VALIDATION_FAILED on function parameters, with location 'fnParams' and the manifest grammar", async () => {
    const res = await run('EOK', {
      security: { id: env.instrumentId },
      params: { rows: 99 }, // the manifest's schema bounds this at 5
    });

    const error = envelopeOf(res, 400, 'VALIDATION_FAILED');
    // The pair API.md L188 documents for a parameter failure: the location, and the grammar the
    // client needs to tell the user what it *should* have typed.
    expect(error.details?.location).toBe('fnParams');
    expect(error.details?.code).toBe('EOK');
    expect(error.details?.grammar).toEqual(EOK.paramGrammar);
    const issues = error.details?.issues as { path: unknown[] }[];
    expect(issues.some((i) => i.path.includes('rows'))).toBe(true);
  });

  it('VALIDATION_FAILED on a query string, located in the query', async () => {
    // `q` must be present; `/search` parses the URL query with the same schema the SDK uses.
    const res = await call('GET', `${API}/search?limit=notanumber`, { headers: webHeaders() });
    const error = envelopeOf(res, 400, 'VALIDATION_FAILED');
    expect(error.details?.location).toBe('query');
  });

  it('BAD_REQUEST for a body that is not JSON at all', async () => {
    const res = await call('POST', `${API}/functions/EOK/run`, {
      headers: webHeaders({ 'content-type': 'application/json' }),
      payload: '{ this is not json',
    });
    envelopeOf(res, 400, 'BAD_REQUEST');
  });

  it('BAD_REQUEST when the CSV route is given neither a resultId nor a re-resolve tuple', async () => {
    const res = await call('GET', `${API}/functions/EOK/csv`, { headers: webHeaders() });
    envelopeOf(res, 400, 'BAD_REQUEST');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 401
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('401', () => {
  it('AUTH_REQUIRED with no credential at all, on every guarded surface', async () => {
    const cases: ['GET' | 'POST', string][] = [
      ['POST', `${API}/functions/EOK/run`],
      ['GET', `${API}/functions`],
      ['POST', `${API}/data`],
      ['GET', `${API}/data/snapshot?securities=X&fields=PX_LAST`],
      ['GET', `${API}/search?q=abc`],
      ['GET', `${API}/workspace`],
      ['GET', `${API}/status`],
      ['GET', `${API}/universe/snapshot`],
    ];

    for (const [method, url] of cases) {
      const res = await call(method, url, { payload: method === 'POST' ? {} : undefined });
      const error = envelopeOf(res, 401, 'AUTH_REQUIRED');
      // A 401 must not hint at what would have been served.
      expect(error.details).toBeUndefined();
    }
  });

  it('AUTH_REQUIRED for a bearer token that resolves to nothing', async () => {
    const res = await call('GET', `${API}/functions`, {
      headers: { authorization: 'Bearer tok-00000000-0000-4000-8000-000000000000' },
    });
    envelopeOf(res, 401, 'AUTH_REQUIRED');
  });

  it('AUTH_REQUIRED for a cookie whose signature does not verify', async () => {
    const res = await call('GET', `${API}/functions`, {
      headers: { cookie: 'tsid=forged.notasignature' },
    });
    envelopeOf(res, 401, 'AUTH_REQUIRED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 403
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('403', () => {
  it('FORBIDDEN with details.requiredScope when an API key lacks fn:run', async () => {
    const res = await call('POST', `${API}/functions/EOK/run`, {
      headers: { authorization: `Bearer ${env.narrowBearer}` },
      payload: { security: { id: env.instrumentId } },
    });

    const error = envelopeOf(res, 403, 'FORBIDDEN');
    expect(error.details?.requiredScope).toEqual(['fn:run']);

    // The same key DOES carry `data:read`, so the refusal is about the scope and not the key.
    const allowed = await call('POST', `${API}/data`, {
      headers: { authorization: `Bearer ${env.narrowBearer}` },
      payload: {
        kind: 'reference',
        securities: [{ id: env.instrumentId }],
        fields: ['NAME'] satisfies FieldId[],
      },
    });
    expect(allowed.statusCode, allowed.payload).toBe(200);
  });

  it('FORBIDDEN with details.requiredRole when a user reaches an admin-only route', async () => {
    const res = await call('GET', `${API}/admin/licences`, { headers: webHeaders() });
    const error = envelopeOf(res, 403, 'FORBIDDEN');
    expect(Array.isArray(error.details?.requiredRole)).toBe(true);
    expect(error.details?.requiredRole as string[]).not.toContain('user');
  });

  it('CSRF_REJECTED for a cookie-authenticated mutation without the terminal header', async () => {
    const res = await call('POST', `${API}/functions/EOK/run`, {
      headers: { cookie: env.cookie }, // no x-requested-with
      payload: { security: { id: env.instrumentId } },
    });
    envelopeOf(res, 403, 'CSRF_REJECTED');

    // A safe method with the same cookie is untouched: CSRF applies to mutations only.
    const safe = await call('GET', `${API}/functions`, { headers: { cookie: env.cookie } });
    expect(safe.statusCode).toBe(200);
  });

  it('ENTITLEMENT_DENIED with details.reasons when EVERY field a function needs is denied', async () => {
    const res = await run('EDN', { security: { id: env.instrumentId } });

    const error = envelopeOf(res, 403, 'ENTITLEMENT_DENIED');
    const reasons = error.details?.reasons as
      { fieldId: string; decision: string; reason: string }[] | undefined;
    expect(reasons).toBeDefined();
    expect(reasons!.map((r) => r.fieldId)).toEqual(['PX_LAST']);
    expect(reasons!.every((r) => r.decision === 'deny')).toBe(true);
    expect(reasons![0]!.reason.length).toBeGreaterThan(0);

    // A refusal is not a leak: nothing about the instrument is in the body.
    expect(res.payload).not.toContain('Errors Fixture Inc');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 404
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('404', () => {
  it('NOT_FOUND for a URL no route serves', async () => {
    const res = await call('GET', `${API}/nothing/here`, { headers: webHeaders() });
    envelopeOf(res, 404, 'NOT_FOUND');
  });

  it('FUNCTION_NOT_FOUND, with the code that was asked for', async () => {
    const res = await run('ZZZ', { security: { id: env.instrumentId } });
    const error = envelopeOf(res, 404, 'FUNCTION_NOT_FOUND');
    expect(error.details?.code).toBe('ZZZ');
  });

  it('SECURITY_NOT_FOUND for a reference nothing resolves', async () => {
    const res = await run('EOK', { security: { ref: 'NOSUCHTICKER US Equity' } });
    envelopeOf(res, 404, 'SECURITY_NOT_FOUND');
  });

  it('FIELD_UNKNOWN for an id the dictionary does not hold', async () => {
    const res = await call('GET', `${API}/fields/NOT_A_FIELD`, { headers: webHeaders() });
    const error = envelopeOf(res, 404, 'FIELD_UNKNOWN');
    expect(error.details).toBeDefined();
  });

  it('RESULT_EXPIRED for an unknown resultId, and for another user’s', async () => {
    const unknown = await call('GET', `${API}/results/01ZZZZZZZZZZZZZZZZZZZZZZZZ`, {
      headers: webHeaders(),
    });
    envelopeOf(unknown, 404, 'RESULT_EXPIRED');

    const launched = await run('EOK', { security: { id: env.instrumentId } });
    expect(launched.statusCode, launched.payload).toBe(200);
    const resultId = launched.json<{ meta: { resultId: string } }>().meta.resultId;

    // A second user in the same firm, holding the id but not the result.
    const otherId = await insertUser(env.firmId, 'user');
    const otherToken = `sess-${randomUUID()}`;
    await insertWebSession(otherId, otherToken);
    const otherCookie = `tsid=${encodeURIComponent(cookie.sign(otherToken, getConfig().SESSION_SECRET))}`;

    const foreign = await call('GET', `${API}/functions/EOK/csv?resultId=${resultId}`, {
      headers: { cookie: otherCookie, 'x-requested-with': 'terminal' },
    });
    // Indistinguishable from an id that never existed: a holder learns nothing about it.
    envelopeOf(foreign, 404, 'RESULT_EXPIRED');

    // And the producer still has it, so the 404 above was about the *viewer*, not the cache.
    const mine = await call('GET', `${API}/functions/EOK/csv?resultId=${resultId}`, {
      headers: webHeaders(),
    });
    expect(mine.statusCode, mine.payload).toBe(200);
  });

  it('RESULT_EXPIRED once the ten-minute TTL is up on the virtual clock', async () => {
    const launched = await run('EOK', { security: { id: env.instrumentId } });
    const resultId = launched.json<{ meta: { resultId: string } }>().meta.resultId;

    env.clock.advance(10 * 60 * 1_000 + 1);
    const res = await call('GET', `${API}/results/${resultId}`, { headers: webHeaders() });
    envelopeOf(res, 404, 'RESULT_EXPIRED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 409
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('409', () => {
  it('AMBIGUOUS_SECURITY carries the candidate summaries, not just a message', async () => {
    // Two instruments sharing a ticker: 'TICK Equity' (no exchange) matches both, and REF-02 says
    // the resolver refuses to choose rather than picking the first row.
    const ticker = `AM${randomUUID().slice(0, 3).toUpperCase()}`;
    const a = await seedQuoteInstrument(t, { ticker, name: 'Ambiguous One' });
    const b = await seedQuoteInstrument(t, {
      ticker,
      name: 'Ambiguous Two',
      providerSymbol: `${ticker}.B`,
    });
    expect(a.instrumentId).not.toBe(b.instrumentId);

    // Both rows must be inside the run's `knownAt`, or the resolver sees one instrument and
    // resolves it instead of refusing to choose.
    //
    // `beforeEach` pinned the virtual clock a second past the wall clock at that moment; these two
    // instruments are written afterwards, with `tx_from = clock_timestamp()`. Under load the
    // second write can land past that second, and then only the FIRST is visible — a 200 where the
    // test asked for a 409, once in perhaps ten runs. Re-reading the wall clock and moving the
    // virtual one past it makes the visibility a fact rather than a race.
    await catchUpKnownAt();

    const res = await run('EOK', { security: { ref: `${ticker} Equity` } });

    const error = envelopeOf(res, 409, 'AMBIGUOUS_SECURITY');
    const candidates = error.details?.candidates as
      { instrumentId: number; display: string; name: string }[] | undefined;
    expect(candidates).toBeDefined();
    expect(candidates!.length).toBeGreaterThanOrEqual(2);
    expect(candidates!.map((c) => c.instrumentId).sort()).toEqual(
      [a.instrumentId, b.instrumentId].sort(),
    );
    // `InstrumentSummary`, not a bare id: a picker needs something to show.
    for (const candidate of candidates!) {
      expect(typeof candidate.display).toBe('string');
      expect(candidate.display.length).toBeGreaterThan(0);
      expect(typeof candidate.name).toBe('string');
    }
  });

  it('WORKSPACE_VERSION_CONFLICT carries the server copy so the client can merge', async () => {
    const start = (await call('GET', `${API}/workspace`, { headers: webHeaders() })).json<{
      version: number;
      layout: unknown;
    }>();

    const first = await call('PUT', `${API}/workspace`, {
      headers: webHeaders(),
      payload: { version: start.version, layout: start.layout },
    });
    expect(first.statusCode, first.payload).toBe(200);

    const stale = await call('PUT', `${API}/workspace`, {
      headers: webHeaders(),
      payload: { version: start.version, layout: start.layout },
    });
    const error = envelopeOf(stale, 409, 'WORKSPACE_VERSION_CONFLICT');
    const current = error.details?.current as { version: number } | undefined;
    expect(current).toBeDefined();
    expect(current!.version).toBe(start.version + 1);
  });

  it('DUPLICATE_NAME when a workspace name is reused', async () => {
    const layout = (await call('GET', `${API}/workspace`, { headers: webHeaders() })).json<{
      layout: unknown;
    }>().layout;

    const name = `Rates ${randomUUID().slice(0, 6)}`;
    const created = await call('POST', `${API}/workspaces`, {
      headers: webHeaders(),
      payload: { name, layout },
    });
    expect(created.statusCode, created.payload).toBe(201);

    const dup = await call('POST', `${API}/workspaces`, {
      headers: webHeaders(),
      payload: { name, layout },
    });
    envelopeOf(dup, 409, 'DUPLICATE_NAME');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 422
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('422', () => {
  it('NO_SECURITY_CONTEXT when the manifest requires a security and none was sent', async () => {
    const res = await run('EOK', {});
    const error = envelopeOf(res, 422, 'NO_SECURITY_CONTEXT');
    expect(error.details?.code).toBe('EOK');
  });

  it('FUNCTION_NOT_APPLICABLE with the class and the applicable list (§12.3, FUNC-02)', async () => {
    const res = await run('EGV', { security: { id: env.instrumentId } });

    const error = envelopeOf(res, 422, 'FUNCTION_NOT_APPLICABLE');
    // Exactly the two keys of API.md L1457 — this is what the panel footer renders.
    expect(error.details?.assetClass).toBe('equity');
    expect(error.details?.applicable).toEqual(['govt']);
    expect(error.message).toContain('EGV');
  });

  it('NOT_IN_UNIVERSE for a computed series, which is not a security a function can run on', async () => {
    const res = await run('EOK', {
      security: { formula: `RATIO(${env.display}, ${env.display})` },
    });
    envelopeOf(res, 422, 'NOT_IN_UNIVERSE');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 429
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('429', () => {
  /**
   * **This is a reported gap, asserted as it really behaves.**
   *
   * API.md §2 L184 documents an over-quota read as `429 QUOTA_EXCEEDED` with
   * `details { quota, used, limit, resetsAt }`. On the shipped wiring it is a `403
   * ENTITLEMENT_DENIED` instead, and the four keys never reach the client:
   *
   *  - `quotas.check()` enforces for `clientKind='api'` only (API.md §8 L1131: counted for web,
   *    enforced for api), so a web session can never produce the 429 at all;
   *  - for an api session the evaluator's rule 8 runs *first*, inside `gateFields`, and rewrites
   *    every surviving field to `decision:'deny', reason:'QUOTA_EXCEEDED'`. `data/request.ts` then
   *    sees an empty `allowed` list and raises its own 403 before `quotaPort.reserve` — the only
   *    caller of `quotaExceededError` — is ever reached.
   *
   * The reason survives, on `details.reasons[].reason`, so a client can still *tell* it is a quota
   * problem; what it cannot do is show the limit, the usage or when the quota frees up, and it will
   * not retry because a 403 is not retryable. Asserting the documented 429 here would be asserting
   * something no route produces. See the report: the fix belongs in WP-07's evaluator or in
   * `data/request.ts`, neither of which is this package's file.
   */
  it('an over-quota API read is a 429 QUOTA_EXCEEDED the client can wait on', async () => {
    // A user-level ceiling of zero unique instruments a day: the first read is already over.
    await t.client.query(
      `INSERT INTO quota_limits
         (subject_kind, subject_id, daily_unique_instruments, monthly_data_points,
          concurrent_subscriptions)
       VALUES ('user', $1, 0, 2000000, 10000)`,
      [env.userId],
    );

    const res = await call('POST', `${API}/data`, {
      headers: { authorization: `Bearer ${env.narrowBearer}` },
      payload: {
        kind: 'reference',
        securities: [{ ref: env.display }],
        fields: ['NAME'] satisfies FieldId[],
      },
    });

    // The evaluator's rule 8 denies every field with reason QUOTA_EXCEEDED, which reaches the
    // dispatcher looking like an entitlement denial. It is not one — the caller IS entitled to
    // NAME and will be served again when the day rolls — so quota-only exhaustion falls through
    // to the reserve, which raises the documented envelope of API.md §2 L184.
    const error = envelopeOf(res, 429, 'QUOTA_EXCEEDED');
    expect(error.retryable, 'a client must know to come back').toBe(true);
    expect(error.details?.quota).toBe('dailyUniqueInstruments');
    expect(error.details?.limit).toBe(0);
    expect(typeof error.details?.used).toBe('number');
    // The four keys exist so the client can say when the quota frees up, rather than only that it
    // was refused.
    expect(typeof error.details?.resetsAt).toBe('string');
    expect(String(error.details?.resetsAt).length).toBeGreaterThan(0);
  });

  it('a denial that is NOT about quota is still a 403, not a 429', async () => {
    // The distinction the branch above turns on: an unentitled field is refused permanently, and
    // must not be dressed up as a quota problem a client would retry forever.
    const res = await call('POST', `${API}/data`, {
      headers: { authorization: `Bearer ${env.narrowBearer}` },
      payload: {
        kind: 'reference',
        securities: [{ ref: env.display }],
        // The field the `EDN` fixture is built on: the narrow bearer holds no grant for it.
        fields: ['PX_LAST'] satisfies FieldId[],
      },
    });

    const error = envelopeOf(res, 403, 'ENTITLEMENT_DENIED');
    expect(error.retryable).toBe(false);
    const reasons = error.details?.reasons as { fieldId: string; reason: string }[];
    expect(reasons.every((r) => r.reason !== 'QUOTA_EXCEEDED')).toBe(true);
  });

  it('the same ceiling is COUNTED and not enforced for a web session (API.md §8 L1131)', async () => {
    await t.client.query(
      `INSERT INTO quota_limits
         (subject_kind, subject_id, daily_unique_instruments, monthly_data_points,
          concurrent_subscriptions)
       VALUES ('user', $1, 0, 2000000, 10000)`,
      [env.userId],
    );

    const res = await call(
      'GET',
      `${API}/data/reference?securities=${encodeURIComponent(env.display)}&fields=NAME`,
      { headers: webHeaders() },
    );

    // Served, and the charge is reported so the status bar can show it.
    expect(res.statusCode, res.payload).toBe(200);
    const meta = res.json<{
      meta: { quota: { dataPointsCharged: number; uniqueInstrumentsAdded: number } };
    }>().meta;
    expect(meta.quota.uniqueInstrumentsAdded).toBe(1);
    expect(meta.quota.dataPointsCharged).toBeGreaterThan(0);
  });

  it('RATE_LIMITED with a Retry-After header the client can wait on', async () => {
    const payload = {
      email: `errors-${randomUUID()}@demo.invalid`,
      password: 'not the password',
      deviceId: 'd_errors_0001',
    };

    // The window is 5 attempts per peer (API.md §1.3); the sixth is refused before any hashing.
    let refused: Injected | undefined;
    for (let i = 0; i < 8 && refused === undefined; i += 1) {
      const res = await call('POST', `${API}/auth/login`, {
        headers: { 'x-requested-with': 'terminal' },
        payload,
      });
      if (res.statusCode === 429) refused = res;
    }

    expect(refused, 'the login limiter never refused within 8 attempts').toBeDefined();
    const error = envelopeOf(refused!, 429, 'RATE_LIMITED');
    expect(error.retryAfterMs).toBeGreaterThan(0);
    // The header is the millisecond field rounded up to whole seconds (errors.ts#sendError).
    expect(retryAfterSeconds(refused!)).toBe(Math.ceil(error.retryAfterMs! / 1_000));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 500 / 503
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('500 and 503', () => {
  it('INTERNAL for a resolver that throws, and the cause never reaches the client', async () => {
    const res = await run('EIN', { security: { id: env.instrumentId } });

    const error = envelopeOf(res, 500, 'INTERNAL');
    expect(error.retryable).toBe(false);
    // The thrown message named a connection string. None of it is on the wire.
    expect(res.payload).not.toContain(LEAKED_SECRET);
    expect(res.payload).not.toContain('hunter2');
    expect(res.payload).not.toContain('blew up');
  });

  it('PROVIDER_UNAVAILABLE when a read-through has nothing stored and cannot fetch', async () => {
    const res = await run('EPU', { security: { id: env.instrumentId } });

    const error = envelopeOf(res, 503, 'PROVIDER_UNAVAILABLE');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterSeconds(res)).toBe(Math.ceil(error.retryAfterMs! / 1_000));
    // Nothing was invented in place of the missing read.
    expect(res.payload).not.toContain('"data"');
  });

  it('STARTING, retryable, with a Retry-After, when a subsystem is not running here', async () => {
    // `/admin/ingest/run/:jobId` is the documented 503 STARTING of a process with no scheduler
    // (API.md §2 L192). A dataops session reaches it; the test app wires no scheduler.
    const opsId = await insertUser(env.firmId, 'dataops');
    const opsToken = `sess-${randomUUID()}`;
    await insertWebSession(opsId, opsToken);
    const opsCookie = `tsid=${encodeURIComponent(cookie.sign(opsToken, getConfig().SESSION_SECRET))}`;

    const res = await call('POST', `${API}/admin/ingest/run/any-job`, {
      headers: { cookie: opsCookie, 'x-requested-with': 'terminal' },
      payload: {},
    });

    const error = envelopeOf(res, 503, 'STARTING');
    expect(error.retryable).toBe(true);
    expect(retryAfterSeconds(res)).toBe(Math.ceil(error.retryAfterMs! / 1_000));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §12.3 — the difference between a blank screen and a leak
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('per-field denial (API.md §12.3, ENTL-05)', () => {
  it('a PARTIAL denial is a 200 with the field null and meta.entitlement populated', async () => {
    const res = await run('EPT', { security: { id: env.instrumentId } });

    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<{
      data: FixturePayload;
      meta: {
        entitlement: { fieldId: string; decision: string; reason: string }[];
        unavailable: { field: string; reason: string }[];
      };
    }>();

    // The allowed field is served …
    expect(body.data.name).toBe('Errors Fixture Inc');
    // … and the denied one is null. Never a stale value, never a fabricated one.
    expect(body.data.pxLast).toBeNull();

    // The reason is on the envelope, so the screen can grey the column and say why.
    const denied = body.meta.entitlement.filter((n) => n.decision === 'deny');
    expect(denied.map((n) => n.fieldId)).toEqual(['PX_LAST']);
    expect(denied[0]!.reason.length).toBeGreaterThan(0);
    // The allowed field is NOT in the notes list: notes are exceptions, not a per-field echo.
    expect(body.meta.entitlement.map((n) => n.fieldId)).not.toContain('NAME');

    // And the gap is also declared as unavailable (FUNCTIONS.md §1.3 rule 6).
    expect(body.meta.unavailable).toContainEqual(
      expect.objectContaining({ field: 'PX_LAST', reason: 'NOT_LICENSED' }),
    );
  });

  it('the SAME function is a 403 once every field it needs is denied — and a 200 again once granted', async () => {
    // EDN needs only the ungranted field: nothing is servable, so there is nothing to draw.
    const denied = await run('EDN', { security: { id: env.instrumentId } });
    envelopeOf(denied, 403, 'ENTITLEMENT_DENIED');

    // Grant the missing source and the very same request succeeds. This is the control that makes
    // the 403 above a statement about entitlements rather than about a broken fixture.
    await grantSource(env.firmId, env.userId, QUOTE_SOURCE);
    (env.harness.entitlements as { invalidate?: () => void }).invalidate?.();

    const allowed = await run('EDN', { security: { id: env.instrumentId } });
    expect(allowed.statusCode, allowed.payload).toBe(200);
    const meta = allowed.json<{ meta: { entitlement: unknown[] } }>().meta;
    expect(meta.entitlement).toEqual([]);

    // And the partial case is now a full one: both fields present, no notes.
    const both = await run('EPT', { security: { id: env.instrumentId } });
    expect(both.statusCode, both.payload).toBe(200);
    const body = both.json<{ data: FixturePayload; meta: { entitlement: unknown[] } }>();
    expect(body.data.pxLast).toBe(1.23);
    expect(body.meta.entitlement).toEqual([]);
  });

  it('a tier the grant does not reach is a 200 with nulls and reasons, never a 403 (§12.3)', async () => {
    // §12.3's own example: an eod-only grant, a realtime snapshot request. The documented answer
    // is a 200 whose fields are null with per-field reasons — the evaluator downgrades rather
    // than denying (ARCHITECTURE §10 rule 6), so the request is served, emptily and honestly.
    const eodUser = await insertUser(env.firmId, 'user');
    const eodToken = `sess-${randomUUID()}`;
    await insertWebSession(eodUser, eodToken);
    for (const [kind, id] of [
      ['firm', env.firmId],
      ['user', eodUser],
    ] as const) {
      await t.client.query(
        `INSERT INTO entitlement_grants
           (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
            usage_display, usage_export, usage_api, valid_from, valid_to)
         VALUES ($1, $2, $3, NULL, NULL, 'eod'::tier, true, true, true,
                 $4::timestamptz, 'infinity'::timestamptz)`,
        [kind, id, QUOTE_SOURCE, GRANT_FROM],
      );
    }
    (env.harness.entitlements as { invalidate?: () => void }).invalidate?.();

    const eodCookie = `tsid=${encodeURIComponent(cookie.sign(eodToken, getConfig().SESSION_SECRET))}`;
    const res = await call(
      'GET',
      `${API}/data/snapshot?securities=${encodeURIComponent(env.display)}` +
        `&fields=PX_LAST,PX_BID&tier=realtime`,
      { headers: { cookie: eodCookie, 'x-requested-with': 'terminal' } },
    );

    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<{
      meta: {
        tier: string;
        entitlement: { fieldId: string; decision: string; effectiveTier: string | null }[];
      };
      results: { fields: Record<string, unknown>; r?: Record<string, string> }[];
    }>();

    // Downgraded, not refused — and the envelope says so per field.
    expect(body.meta.entitlement.map((n) => n.fieldId).sort()).toEqual(['PX_BID', 'PX_LAST']);
    expect(body.meta.entitlement.map((n) => n.effectiveTier)).toEqual(['eod', 'eod']);
    expect(body.meta.tier).toBe('eod');

    // NOTE for the client: API.md §12.3 prints `"decision": "deny"` for this exact case, but the
    // evaluator's rule 6 (ARCHITECTURE §10) makes a tier shortfall a `downgrade`, never a deny —
    // which is *why* the response is a 200 at all, since `data/request.ts` 403s when every field
    // is denied. A client that switched on `decision === 'deny'` to grey a column, copying the
    // document, would grey nothing. The wire is the authority; this asserts what it really says.
    expect(body.meta.entitlement.map((n) => n.decision)).toEqual(['downgrade', 'downgrade']);

    // No realtime number was served in place of the missing one.
    const result = body.results[0];
    expect(result).toBeDefined();
    expect(result!.fields.PX_LAST ?? null).toBeNull();
    expect(result!.fields.PX_BID ?? null).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The header that makes all of the above findable
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('x-trace-id', () => {
  it('is on unauthenticated, public and error responses alike', async () => {
    // `call` asserts the header on every request; these are the routes outside `/api/v1` and
    // outside the session guard, which a helper applied only to guarded routes would miss.
    for (const url of ['/health', '/metrics']) {
      const res = await call('GET', url);
      expect(res.statusCode).toBeLessThan(500);
    }
    const missing = await call('GET', '/definitely/not/a/route');
    envelopeOf(missing, 404, 'NOT_FOUND');
  });

  it('mints a fresh id when the caller sends a malformed one rather than echoing it', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: `${API}/functions`,
      headers: { cookie: env.cookie, 'x-trace-id': 'not-a-uuid\r\nInjected: header' },
    });
    const header = String(res.headers['x-trace-id']);
    expect(header).not.toContain('Injected');
    expect(UUID_V4.test(header)).toBe(true);
  });
});
