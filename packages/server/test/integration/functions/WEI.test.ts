/**
 * `test/integration/functions/WEI.test.ts` — WP-09's acceptance row for `WEI`
 * (WORKPLAN §WP-09: "seeded indices with returns and session state, including the Cboe European
 * ones").
 *
 * Five indices, chosen because each one takes a different path through the resolver and the
 * differences are the whole screen:
 *
 * | code      | region   | venue               | quote   | history | what it proves                |
 * | --------- | -------- | ------------------- | ------- | ------- | ----------------------------- |
 * | `SPX`     | Americas | `XCBO` (calendar)   | yes     | 380 d   | returns, `sessionSource:'calendar'`, local time |
 * | `VIX`     | Americas | `XCBO` (calendar)   | yes     | none    | `NO_DAILY_HISTORY`: every `RET_*` is `na`, not 0 |
 * | `UKX`     | EMEA     | `XLON` (calendar)   | yes     | none    | a second, non-US calendar and its own time zone |
 * | `BUK100P` | EMEA     | none (Cboe Europe)  | yes     | none    | `sessionSource:'provider'` — the Cboe European line publishes its own status |
 * | `NKY`     | APAC     | `XTKS` (no exchange row) | no | none    | `sessionSource:'none'`, pending cells, `NO_CALENDAR_FOR_VENUE` |
 *
 * The two indices with no quote are the ones that make the monitor rule visible: §0.4 rule 2
 * forbids `ctx.providers.ensure` on a monitor, so a subject the scheduler has not polled stays
 * **pending** — `st:'blank'`, `provIdx:-1`, no reason code. That is also how this file proves the
 * rule through HTTP without a spy: an `ensure` would have either filled those cells or thrown a
 * 503 in `PROVIDER_MODE=replay`, and neither happened.
 *
 * `NKY` is the honest-degradation row. v1 seeds `XNYS`, `XNAS`, `XCBO` and `XLON` and nothing else,
 * so a Tokyo listing has no calendar; the session is `unknown` with a reason, never a guess.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, subjectToken } from './golden.js';

import type { NormalisedUpdate, QuoteFields } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { XCBO } from '@terminal/core/calendars/nyse';
import { XLON } from '@terminal/core/calendars/target2';
import { WEI } from '@terminal/core/functions/manifests/WEI';
import type { WeiPayload, WeiRow } from '@terminal/core/functions/manifests/WEI';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as WEIModule from '../../../src/functions/WEI/resolve.js';
import { parseSubject } from '../../../src/plant/subjects.js';
import { materialiseCalendar } from '../../../src/refdata/calendars.js';
import { upsertIndex } from '../../../src/refdata/indexMembership.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const AS_OF_DATE = GOLDEN_ISO.slice(0, 10);
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = new Date('2020-01-01T00:00:00Z');

/**
 * `md_lines_symbol_excl` makes `(source_id, provider_symbol)` a GLOBAL namespace — "a provider
 * symbol feeds at most one line at a time" — and `server-int` runs four forks against one
 * database. Two open transactions inserting the same symbol therefore wait on each other's
 * exclusion check, and two such waits in opposite order are a deadlock. Every symbol this file
 * seeds carries a per-run suffix so no other suite can ever be on the other side of that wait.
 * The suffix is invisible to the payload: no monitor row carries a provider symbol.
 */
const SYMBOL_TAG = `.t${randomUUID().slice(0, 8)}`;
const sym = (base: string): string => `${base}${SYMBOL_TAG}`;

const GOLDEN_NAME = 'WEI.default.json';

const REGISTRY = new FunctionRegistry([WEI]);

const MODULES: Record<string, FunctionServerModule<any, any>> = { WEI: WEIModule };

const t: TestDb = withTxDb();

interface SeededIndex {
  code: string;
  instrumentId: number;
  mdLineId: number;
}

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  ids: Record<string, SeededIndex>;
  /** `close(asOfSession) / close(last session of 2025) - 1`, computed from the seeded bars. */
  expectedRetYtd: number;
}

let env: Env;

async function ensureLicences(): Promise<void> {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);
}

async function grantEverySource(firmId: number, userId: number): Promise<void> {
  await t.client.query(
    `INSERT INTO entitlement_grants
       (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
        usage_display, usage_export, usage_api, valid_from, valid_to)
     SELECT k.kind, k.id, l.source_id, NULL, NULL, 'realtime'::tier, true, true, true,
            $3::timestamptz, 'infinity'::timestamptz
       FROM (SELECT DISTINCT source_id FROM licence_registry WHERE tx_to = 'infinity') l
       CROSS JOIN (VALUES ('firm', $1::bigint), ('user', $2::bigint)) AS k(kind, id)`,
    [firmId, userId, GRANT_FROM],
  );
}

/**
 * One index instrument with its terms, its (optional) listing and one md line.
 *
 * `seedQuoteInstrument` always writes an `XNAS` listing, and the venue is exactly what this file
 * varies, so the index fixture builds its own rows through the same WP-04 repositories.
 */
async function seedIndex(spec: {
  code: string;
  name: string;
  mic: string | null;
  region: string;
  provider: string;
  methodology: string;
  calcCurrency: string;
  sourceId: string;
  providerSymbol: string;
  searchWeight: number;
  membershipSourceId?: string;
}): Promise<SeededIndex> {
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, 'internal.user', `wei-${spec.code}`);
  await bootstrapProvenance(t, spec.sourceId, `wei-src-${spec.code}`);
  const o = { validFrom: VALID_FROM, provenanceId };

  const issuerId = await repos.issuers.insert({ name: `${spec.name} issuer` }, o);
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: 'index',
      securityType: 'Index',
      name: spec.name,
      currency: spec.calcCurrency,
    },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass: 'index',
      marketSector: 'Index',
      ticker: spec.code,
      exchCode: 'INDEX',
      name: spec.name,
      currency: spec.calcCurrency,
      searchWeight: spec.searchWeight,
    },
    o,
  );
  if (spec.mic !== null) {
    await repos.listings.insert(
      {
        instrumentId,
        exchCode: spec.mic,
        localTicker: spec.code,
        isPrimary: true,
        mic: spec.mic,
      },
      o,
    );
  }
  const { mdLineId } = await repos.mdLines.upsertBySymbol(
    {
      instrumentId,
      sourceId: spec.sourceId,
      providerSymbol: sym(spec.providerSymbol),
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 10_000,
      priority: 10,
    },
    o,
  );
  await t.client.query(
    `INSERT INTO index_terms (instrument_id, provider, methodology, calc_currency, region,
                              valid_from, provenance_id)
     VALUES ($1, $2, $3, $4, $5, timestamptz '2020-01-01', $6)`,
    [instrumentId, spec.provider, spec.methodology, spec.calcCurrency, spec.region, provenanceId],
  );
  await upsertIndex(t.db, {
    code: spec.code,
    instrumentId,
    proxyFundInstrumentId: null,
    membershipSourceId: spec.membershipSourceId ?? null,
    provider: spec.provider,
  });
  return { code: spec.code, instrumentId, mdLineId };
}

function quote(
  index: SeededIndex,
  sourceId: string,
  provenanceId: number,
  fields: Partial<QuoteFields>,
): NormalisedUpdate {
  return {
    subject: `q:${String(index.instrumentId)}`,
    instrumentId: index.instrumentId,
    mdLineId: index.mdLineId,
    assetClass: 'index',
    tier: 'delayed',
    fields,
    ts: { src: GOLDEN_CAPTURE_MS - 900_000, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: { sourceId, provenanceId },
  };
}

/** Weekday dates from `from` to `to` inclusive, ascending — the bar series' index. */
function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00.000Z`);
  for (let ms = Date.parse(`${from}T00:00:00.000Z`); ms <= end; ms += 86_400_000) {
    const day = new Date(ms).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

beforeEach(async () => {
  await ensureLicences();

  // Only the two calendars this file reads, and only the two years the bar window spans:
  // `calendars` and `calendar_holidays` are shared tables and `server-int` runs four forks against
  // one database, so a wide range would hold those keys for the length of the whole file and a
  // sibling suite would wait on it (see `functions/Q.test.ts` for the same note).
  await materialiseCalendar(t.db, XCBO, { fromYear: 2025, toYear: 2026 });
  await materialiseCalendar(t.db, XLON, { fromYear: 2025, toYear: 2026 });
  await t.client.query(
    `INSERT INTO exchanges (mic, operating_mic, name, country, tz, calendar_id) VALUES
       ('XCBO', 'XCBO', 'Cboe Options Exchange', 'US', 'America/New_York', 'XCBO'),
       ('XLON', 'XLON', 'London Stock Exchange', 'GB', 'Europe/London', 'XLON')
     ON CONFLICT (mic) DO NOTHING`,
  );

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`WEI Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'WEI User', 'user') RETURNING user_id`,
    [firmId, `wei-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  await grantEverySource(firmId, userId);

  const spx = await seedIndex({
    code: 'SPX',
    name: 'S&P 500',
    mic: 'XCBO',
    region: 'North America',
    provider: 'S&P Dow Jones',
    methodology: 'float_cap_weighted',
    calcCurrency: 'USD',
    sourceId: 'cboe.quotes',
    providerSymbol: '_SPX',
    searchWeight: 100,
    membershipSourceId: 'ssga.holdings',
  });
  const vix = await seedIndex({
    code: 'VIX',
    name: 'Cboe Volatility Index',
    mic: 'XCBO',
    region: 'Americas',
    provider: 'Cboe',
    methodology: 'volatility',
    calcCurrency: 'USD',
    sourceId: 'cboe.quotes',
    providerSymbol: '_VIX',
    searchWeight: 90,
  });
  const ukx = await seedIndex({
    code: 'UKX',
    name: 'FTSE 100',
    mic: 'XLON',
    region: 'UK',
    provider: 'FTSE Russell',
    methodology: 'float_cap_weighted',
    calcCurrency: 'GBP',
    sourceId: 'yahoo.chart',
    providerSymbol: '^FTSE',
    searchWeight: 80,
  });
  const buk = await seedIndex({
    code: 'BUK100P',
    name: 'Cboe UK 100',
    mic: null,
    region: 'Europe',
    provider: 'Cboe',
    methodology: 'cap_weighted',
    calcCurrency: 'GBP',
    sourceId: 'cboe.euIndices',
    providerSymbol: 'BUK100P',
    searchWeight: 70,
  });
  const nky = await seedIndex({
    code: 'NKY',
    name: 'Nikkei 225',
    mic: 'XTKS',
    region: 'Asia',
    provider: 'Nikkei',
    methodology: 'price_weighted',
    calcCurrency: 'JPY',
    sourceId: 'yahoo.chart',
    providerSymbol: '^N225',
    searchWeight: 60,
  });

  // SPX's daily history: every weekday of the trailing 380 days, on a deterministic ramp so the
  // expected YTD return is arithmetic rather than a number copied out of a failure message.
  const barProv = await bootstrapProvenance(t, 'yahoo.chart', 'wei-bars');
  const dates = weekdays('2025-06-01', AS_OF_DATE);
  const closeOf = (i: number): number => Number((6000 + i * 4).toFixed(6));
  const values = dates.map((date, i) => ({ date, close: closeOf(i) }));
  for (const chunk of chunked(values, 200)) {
    await t.client.query(
      `INSERT INTO bars_daily (instrument_id, session_date, md_line_id, open, high, low, close,
                               volume, capture_ts, provenance_id)
       SELECT $1, d.session_date::date, $2, d.close::numeric, (d.close + 5)::numeric,
              (d.close - 5)::numeric, d.close::numeric, 1000000, $3::timestamptz, $4
         FROM unnest($5::text[], $6::numeric[]) AS d(session_date, close)`,
      [
        spx.instrumentId,
        spx.mdLineId,
        GOLDEN_ISO,
        barProv,
        chunk.map((v) => v.date),
        chunk.map((v) => v.close),
      ],
    );
  }

  const cboeProv = await bootstrapProvenance(t, 'cboe.quotes', 'wei-cboe');
  const euProv = await bootstrapProvenance(t, 'cboe.euIndices', 'wei-eu');
  const yahooProv = await bootstrapProvenance(t, 'yahoo.chart', 'wei-yahoo');

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };

  harness.deps.plant.apply(
    quote(spx, 'cboe.quotes', cboeProv, {
      PX_LAST: 7585.75,
      CHG_NET_1D: -34.23,
      CHG_PCT_1D: -0.4492,
      PX_OPEN: 7610.1,
      PX_HIGH: 7620.4,
      PX_LOW: 7580.2,
      PX_CLOSE_1D: 7619.98,
      PX_VOLUME: 0,
    }),
  );
  harness.deps.plant.apply(
    quote(vix, 'cboe.quotes', cboeProv, {
      PX_LAST: 17.5,
      CHG_NET_1D: 0.4,
      CHG_PCT_1D: 2.3392,
    }),
  );
  harness.deps.plant.apply(
    quote(ukx, 'yahoo.chart', yahooProv, {
      PX_LAST: 10_658.13,
      CHG_NET_1D: -39.44,
      CHG_PCT_1D: -0.3687,
    }),
  );
  // The Cboe European line publishes its own status ("C" → closed) and no calendar is seeded for
  // it: this is the `sessionSource:'provider'` path (FEED-06).
  harness.deps.plant.apply(
    quote(buk, 'cboe.euIndices', euProv, {
      PX_LAST: 1059.4557,
      CHG_NET_1D: -3.66,
      CHG_PCT_1D: -0.3443,
      SESSION_STATE: 'closed',
    }),
  );
  // NKY is deliberately never polled.

  const lastOf2025 = [...values].filter((v) => v.date <= '2025-12-31').pop()!;
  const last = values[values.length - 1]!;

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    knownAt,
    ids: { SPX: spx, VIX: vix, UKX: ukx, BUK100P: buk, NKY: nky },
    expectedRetYtd: (last.close / lastOf2025.close - 1) * 100,
  };
});

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push([...items.slice(i, i + size)]);
  return out;
}

afterEach(async () => {
  await env.harness.close();
});

async function runWEI(params: Record<string, unknown> = {}): Promise<WeiPayload> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/WEI/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<{ data: WeiPayload }>().data;
}

function rowOf(payload: WeiPayload, code: string): WeiRow {
  const row = payload.regions.flatMap((r) => r.rows).find((r) => r.code === code);
  expect(row, `${code} is missing from the payload`).toBeDefined();
  return row!;
}

function normalise(payload: WeiPayload): unknown {
  const tokens = new Map<number, string>(
    Object.values(env.ids).map((i) => [i.instrumentId, `<${i.code}>`]),
  );
  const json = JSON.stringify(payload, (_key, value: unknown) => {
    if (typeof value === 'number' && tokens.has(value)) return tokens.get(value);
    // Only a subject string carries an id (`subjectToken`); substituting anywhere in any string
    // made the golden a function of the sequence values this run drew.
    if (typeof value === 'string') return subjectToken(value, tokens);
    return value;
  });
  return JSON.parse(json);
}

describe('WEI — indices by region, with returns and session state', () => {
  it('groups the seeded indices into the three regions in params order', async () => {
    const payload = await runWEI();
    expect(payload.regions.map((r) => r.region)).toEqual(['Americas', 'EMEA', 'APAC']);
    expect(payload.regions.map((r) => r.rows.map((x) => x.code))).toEqual([
      ['SPX', 'VIX'],
      ['UKX', 'BUK100P'],
      ['NKY'],
    ]);
    expect(payload.counts.rows).toBe(5);
    expect(payload.view).toBe('returns');
    expect(payload.conventions).toMatchObject({ returns: 'simple', adjust: 'price' });
  });

  it('computes the period returns from the seeded history and cites the stats engine', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/WEI/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { codes: ['SPX'] },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<{
      data: WeiPayload;
      meta: { engines: { name: string; version: string }[] };
    }>();
    const spx = rowOf(body.data, 'SPX');

    expect(spx.historySessions).toBeGreaterThan(250);
    expect(spx.cells.RET_YTD?.v).toBeCloseTo(env.expectedRetYtd, 10);
    // A derived cell is a stored value: closed, no `live`, and it cites the bar block.
    expect(spx.cells.RET_YTD?.st).toBe('closed');
    expect(spx.cells.RET_YTD?.live).toBeUndefined();
    expect(spx.cells.RET_YTD?.provIdx).toBeGreaterThanOrEqual(0);
    expect(spx.cells.PX_HIGH_52W?.v).toBeGreaterThan(spx.cells.PX_LOW_52W?.v as number);
    expect(body.meta.engines).toContainEqual(
      expect.objectContaining({ name: 'stats', version: '1.0.0' }),
    );
  });

  it('marks an index with no daily history na, never zero', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/WEI/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { codes: ['VIX'] },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<{
      data: WeiPayload;
      meta: { unavailable: { field: string; reason: string; detail: string }[] };
    }>();
    const vix = rowOf(body.data, 'VIX');

    expect(vix.historySessions).toBe(0);
    for (const field of ['RET_1W', 'RET_1M', 'RET_YTD', 'RET_1Y', 'PX_HIGH_52W', 'PX_LOW_52W']) {
      expect(vix.cells[field]?.v, field).toBeNull();
      expect(vix.cells[field]?.st, field).toBe('na');
    }
    // The live cells are unaffected: no history is not no quote.
    expect(vix.cells.PX_LAST?.v).toBe(17.5);
    expect(body.meta.unavailable).toContainEqual({
      field: 'rows.VIX.returns',
      reason: 'NO_SOURCE',
      detail: 'no daily history recorded for VIX',
    });
  });

  it('takes the session from the calendar, from the provider, or from neither — and says which', async () => {
    const payload = await runWEI();

    const spx = rowOf(payload, 'SPX');
    expect(spx.calendarId).toBe('XCBO');
    expect(spx.sessionSource).toBe('calendar');
    expect(spx.sessionState).toBe('open');
    expect(spx.localTime).toContain('America/New_York');
    expect(spx.membershipAvailable).toBe(true);

    const ukx = rowOf(payload, 'UKX');
    expect(ukx.calendarId).toBe('XLON');
    expect(ukx.sessionSource).toBe('calendar');
    expect(ukx.localTime).toContain('Europe/London');
    expect(ukx.membershipAvailable).toBe(false);

    // The Cboe European index: no seeded venue calendar, but the line publishes its own status.
    const buk = rowOf(payload, 'BUK100P');
    expect(buk.mic).toBeNull();
    expect(buk.calendarId).toBeNull();
    expect(buk.sessionSource).toBe('provider');
    expect(buk.sessionState).toBe('closed');
    expect(buk.calcCurrency).toBe('GBP');
    expect(buk.cells.PX_LAST?.v).toBe(1059.4557);

    // Tokyo: no calendar and no provider status. Unknown, with the reason — never invented.
    const nky = rowOf(payload, 'NKY');
    expect(nky.calendarId).toBeNull();
    expect(nky.localTime).toBeNull();
    expect(nky.sessionState).toBe('unknown');
    expect(nky.sessionSource).toBe('none');
  });

  it('leaves an unpolled index pending rather than fetching it (§0.4 rule 2)', async () => {
    const payload = await runWEI();
    const nky = rowOf(payload, 'NKY');
    for (const field of ['PX_LAST', 'CHG_NET_1D', 'CHG_PCT_1D']) {
      const cell = nky.cells[field]!;
      expect(cell.v, field).toBeNull();
      expect(cell.st, field).toBe('blank');
      expect(cell.provIdx, field).toBe(-1);
      expect(cell.r, field).toBeUndefined();
      expect(cell.live, field).toEqual({ subject: nky.subject, field });
    }
    expect(payload.counts.pending).toBe(1);
  });

  it('reports the index source publishing no volume as na, never 0', async () => {
    const payload = await runWEI({ view: 'levels' });
    const spx = rowOf(payload, 'SPX');
    expect(payload.columns.map((c) => c.id)).toContain('PX_VOLUME');
    expect(spx.cells.PX_VOLUME?.v).toBeNull();
    expect(spx.cells.PX_VOLUME?.st).toBe('na');
    expect(spx.cells.PX_OPEN?.v).toBe(7610.1);
  });

  it('honours regions, codes and the skipped list', async () => {
    const emea = await runWEI({ regions: ['EMEA'] });
    expect(emea.regions).toHaveLength(1);
    expect(emea.regions[0]?.rows.map((r) => r.code)).toEqual(['UKX', 'BUK100P']);

    const explicit = await runWEI({ codes: ['SPX', 'ZZZ'] });
    expect(explicit.regions.flatMap((r) => r.rows).map((r) => r.code)).toEqual(['SPX']);
    expect(explicit.skipped).toEqual([{ code: 'ZZZ', reason: 'INDEX_NOT_SEEDED' }]);
  });

  it('declares a LiveSpec of valid q: subjects, one per row', async () => {
    const payload = await runWEI();
    const live = WEI.live!(
      {
        regions: ['Americas', 'EMEA', 'APAC'],
        columns: [],
        view: 'returns',
      } as never,
      payload,
    )!;
    expect(live.subjects).toHaveLength(5);
    for (const subject of live.subjects) {
      expect(parseSubject(subject)?.family, subject).toBe('q');
    }
    expect(live.conflationMs).toBe(500);
    // The daily cells never flash: they carry no `live`, so they are not in the field set.
    expect(live.fields).not.toContain('RET_YTD');
    expect(live.fields).toContain('PX_LAST');
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    const payload = await runWEI();
    expectGolden(GOLDEN_NAME, normalise(payload));
  });
});
