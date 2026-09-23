/**
 * `test/integration/portfolio/helpers.ts` — the fixtures the three WP-10 portfolio suites share.
 *
 * Three notes on why these look the way they do:
 *
 *  1. **Nothing depends on a seeded instrument id.** FUNCTIONS_TIER1 §0.7 names ids (AAPL = 42) for
 *     the goldens, but WP-15 owns that seed and it does not exist yet. Every firm, user, session
 *     and instrument here is created inside the test's own transaction with a random ticker, so
 *     the suites are order-independent and survive the seed's arrival.
 *  2. **`tx_from` is explicit.** The bitemporal `as-of` predicate compares `tx_from` with the
 *     request's `knownAt`, and `knownAt` is the frozen `VirtualClock` at 2026-09-17. A row written
 *     with a wall-clock `tx_from` is written *after* the clock the request reads at and is
 *     therefore invisible to it — the resolver answers `SECURITY_NOT_FOUND` and every import row
 *     fails for a reason that has nothing to do with the code under test. So these inserts set
 *     `valid_from = tx_from = 2020-01-01`, exactly as the Tier-1 function suites do.
 *  3. **`multipartBody` is hand-built.** The upload route parses RFC 7578 itself (there is no
 *     `@fastify/multipart` in this tree), so the test writes the same bytes a browser would and
 *     the parser is exercised rather than mocked.
 *
 * `bootstrapProvenance` touches `licence_registry`, which is a shared reference table — but only
 * behind a `WHERE NOT EXISTS`, and `globalSetup` commits every source id used here, so in a normal
 * run the guard finds the row and nothing is written and no lock is taken. That is the same
 * arrangement `ensureShared` documents, and it is what keeps these suites safe in the four-fork
 * `server-int` project.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';

import { getConfig } from '../../../src/config.js';
import type { TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance } from '../ws/helpers.js';

/** The instant every reference row in these suites is valid and known from. */
export const VALID_FROM = '2020-01-01T00:00:00Z';

/** A signed-in user of one firm. */
export interface Actor {
  userId: number;
  firmId: number;
  role: 'user' | 'admin';
  cookie: string;
}

/** One HTTP answer, in the shape the assertions read. */
export interface Response {
  statusCode: number;
  payload: string;
  json: <T>() => T;
}

export async function newFirm(t: TestDb, label: string): Promise<number> {
  const res = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`${label} ${randomUUID().slice(0, 8)}`],
  );
  return Number(res.rows[0]!.firm_id);
}

export async function newActor(
  t: TestDb,
  firmId: number,
  label: string,
  role: 'user' | 'admin' = 'user',
): Promise<Actor> {
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING user_id`,
    [firmId, `pf-${randomUUID()}@demo.invalid`, label, role],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  return {
    userId,
    firmId,
    role,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
  };
}

/** An instrument and the command-line key an upload names it by (`'PA1B2 US Equity'`). */
export interface SeededEquity {
  instrumentId: number;
  ticker: string;
  key: string;
}

/**
 * One tradeable US equity, valid and known from {@link VALID_FROM} so the frozen test clock can
 * see it. The ticker is random, so two files running in parallel forks never collide.
 */
export async function newEquity(t: TestDb, name = 'Test Issuer'): Promise<SeededEquity> {
  const provenanceId = await bootstrapProvenance(t, 'internal.user', 'pf-ref');
  const ticker = `P${randomUUID().slice(0, 4).toUpperCase()}`;

  const issuer = await t.client.query<{ issuer_id: string }>(
    `INSERT INTO issuers (name, country, entity_type, valid_from, tx_from, provenance_id)
     VALUES ($1, 'US', 'operating', $2::timestamptz, $2::timestamptz, $3)
     RETURNING issuer_id`,
    [`${name} ${ticker}`, VALID_FROM, provenanceId],
  );
  const issue = await t.client.query<{ issue_id: string }>(
    `INSERT INTO issues (issuer_id, asset_class, security_type, name, currency, country_of_issue,
                         valid_from, tx_from, provenance_id)
     VALUES ($1, 'equity'::asset_class, 'Common Stock', $2, 'USD', 'US',
             $3::timestamptz, $3::timestamptz, $4)
     RETURNING issue_id`,
    [issuer.rows[0]!.issuer_id, `${name} ${ticker}`, VALID_FROM, provenanceId],
  );
  const instrument = await t.client.query<{ instrument_id: string }>(
    `INSERT INTO instruments (issue_id, asset_class, market_sector, ticker, exch_code, name,
                              currency, status, search_weight, price_decimals,
                              valid_from, tx_from, provenance_id)
     VALUES ($1, 'equity'::asset_class, 'Equity'::market_sector, $2, 'US', $3, 'USD', 'active',
             1, 2, $4::timestamptz, $4::timestamptz, $5)
     RETURNING instrument_id`,
    [issue.rows[0]!.issue_id, ticker, `${name} ${ticker}`, VALID_FROM, provenanceId],
  );

  return {
    instrumentId: Number(instrument.rows[0]!.instrument_id),
    ticker,
    key: `${ticker} US Equity`,
  };
}

function headers(a: Actor): Record<string, string> {
  return { cookie: a.cookie, 'x-requested-with': 'terminal' };
}

/** `app.inject` under one actor's session, against the versioned prefix. */
export async function call(
  app: FastifyInstance,
  a: Actor,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<Response> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: headers(a),
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    statusCode: res.statusCode,
    payload: res.payload,
    json: <T>(): T => JSON.parse(res.payload) as T,
  };
}

/** One `multipart/form-data` body, built by hand — the route parses RFC 7578 itself. */
export function multipartBody(
  fields: Record<string, string>,
  file: { filename: string; content: string },
): { body: string; contentType: string } {
  const boundary = `----terminaltest${randomUUID().replace(/-/g, '')}`;
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
      `Content-Type: text/csv\r\n\r\n${file.content}\r\n`,
  );
  parts.push(`--${boundary}--\r\n`);
  return { body: parts.join(''), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** `POST /portfolios/:id/import` with a CSV part and an `asOfDate` field. */
export async function upload(
  app: FastifyInstance,
  a: Actor,
  portfolioId: number,
  csv: string,
  asOfDate: string,
  filename = 'positions.csv',
): Promise<Response> {
  const { body, contentType } = multipartBody({ asOfDate }, { filename, content: csv });
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/portfolios/${String(portfolioId)}/import`,
    headers: { ...headers(a), 'content-type': contentType },
    payload: body,
  });
  return {
    statusCode: res.statusCode,
    payload: res.payload,
    json: <T>(): T => JSON.parse(res.payload) as T,
  };
}

/** `count(*)` over one table, for the row-count assertions idempotency is measured with. */
export async function countOf(
  t: TestDb,
  table: string,
  where: string,
  params: readonly unknown[],
): Promise<number> {
  const res = await t.client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
    params as unknown[],
  );
  return Number(res.rows[0]!.n);
}
