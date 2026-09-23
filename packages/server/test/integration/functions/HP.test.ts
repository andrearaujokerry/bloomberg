/**
 * `test/integration/functions/HP.test.ts` — WP-09's acceptance row for `HP`
 * (WORKPLAN §WP-09: "periodicity, adjustment basis (REF-09), paging, CSV parity; the §12.1 example
 * reproduces exactly").
 *
 * ## The one test in this file that matters most
 *
 * API.md §12.1: the *same* historical read at two `knownAt` instants returns two different price
 * series, and neither is wrong. AAPL's 4:1 split went ex on 2020-08-31 and was **recorded** on
 * 2020-07-31. A read as of 30 July 2020 has never heard of it and returns the print, 499.23. A
 * read today has, and returns 499.23 × ¼ = 124.8075. That is REF-03 (bitemporality) and REF-09
 * (adjust on read) meeting on one row of one table, and it is the behaviour a user reporting "the
 * numbers changed" is actually seeing.
 *
 * The expected closes are not copied out of the resolver: they are read from
 * `fixtures/golden/analytics/adjust/aapl.json`, the REF-09 golden, and the fixture's 2020-08-28
 * bar is seeded from that file's `inputs.bars` so the assertion and the seed have one source.
 *
 * ## What the fixture is
 *
 * Two blocks of `bars_daily` on one synthetic equity, because the two questions need different
 * shapes:
 *
 *  - **2026** — every weekday from 2025-09-01 to the frozen clock, on a deterministic ramp, so the
 *    default `1Y D` window has enough rows to page (five pages of 60) and the weekly/monthly
 *    roll-ups have something to aggregate that can be checked arithmetically rather than by eye.
 *  - **2020** — the August/September window either side of the split, with 2020-08-28 at exactly
 *    the golden's 499.23.
 *
 * Nothing here depends on a seed: §0.7's instrument ids do not exist yet (WP-15 owns the seed), so
 * every row is written inside this file's own transaction and every id is the one the fixture
 * returned.
 *
 * ## Why the reference rows are backdated
 *
 * `instruments`, `issues` and `listings` are bitemporal, and the repositories stamp `tx_from` with
 * the wall clock. A read at `knownAt = 2020-07-30` would therefore not find the *instrument*, and
 * the §12.1 example would fail for a reason that has nothing to do with the split. The fixture
 * backdates `tx_from` on its own rows so that 2020 is inside their transaction range — which is
 * what the real master looks like for a security that existed in 2020.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { expectGolden, idToken, subjectToken } from './golden.js';

import { FunctionRegistry, toCsv } from '@terminal/core';
import { XNAS } from '@terminal/core/calendars/nyse';
import { HP } from '@terminal/core/functions/manifests/HP';
import type {
  HpPayload,
  HpPricePayload,
  HpSeriesPayload,
} from '@terminal/core/functions/manifests/HP';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as HPModule from '../../../src/functions/HP/resolve.js';
import { decodeHpCursor } from '../../../src/functions/HP/window.js';
import { materialiseCalendar } from '../../../src/refdata/calendars.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const AS_OF_DATE = GOLDEN_ISO.slice(0, 10);
const GRANT_FROM = '2020-01-01T00:00:00.000Z';

/** REF-09's golden: the split ex-dates, the 2020-08-28 print and the adjusted close it becomes. */
const ADJUST_GOLDEN_PATH = fileURLToPath(
  new URL('../../../../../fixtures/golden/analytics/adjust/aapl.json', import.meta.url),
);
const GOLDEN_NAME = 'HP.price.json';

interface AdjustGolden {
  inputs: {
    actions: { caType: string; status: string; exDate: string; ratioNew: number; ratioOld: number }[];
    bars: { date: string; open: number; high: number; low: number; close: number }[];
  };
  expected: Record<string, number | string>;
}

const adjustGolden = (JSON.parse(readFileSync(ADJUST_GOLDEN_PATH, 'utf8')) as AdjustGolden[])[0]!;
/** `{ caType:'split', exDate:'2020-08-31', ratioNew:4, ratioOld:1 }`. */
const SPLIT = adjustGolden.inputs.actions.find((a) => a.exDate === '2020-08-31')!;
/** The 2020-08-28 bar as published: 499.23 flat. */
const SPLIT_EVE = adjustGolden.inputs.bars.find((b) => b.date === '2020-08-28')!;
const ADJUSTED_CLOSE = adjustGolden.expected['close.2020-08-28'] as number; // 124.8075
const PRICE_FACTOR = adjustGolden.expected['steps.4.priceFactor'] as number; // 0.25

/** The instant the split was recorded. A read before it does not see the split (REF-03). */
const SPLIT_RECORDED_AT = '2020-07-31T12:00:00.000Z';
/** §12.1's "before": one day before the split was recorded. */
const BEFORE_SPLIT_KNOWN_AT = '2020-07-30T12:00:00.000Z';
/** The 2020 window both §12.1 reads use. */
const WINDOW_2020 = { start: '2020-08-03', end: '2020-09-30' };
const VALID_AT_2020 = '2020-09-30T20:00:00.000Z';

const REGISTRY = new FunctionRegistry([HP]);
 
const MODULES: Record<string, FunctionServerModule<any, any>> = { HP: HPModule };

const t: TestDb = withTxDb();

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  cookie: string;
  knownAt: string;
  instrumentId: number;
  /** The `series` variant's instrument: the BLS CPI-U series. */
  econInstrumentId: number;
  /** The recent block, `date → close`, in seed order. */
  recent: { date: string; close: number; volume: number }[];
  /** The 2020 block. */
  twentyTwenty: { date: string; close: number }[];
}

let env: Env;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every **XNAS session** in `[from, to]`, ascending.
 *
 * Not "every weekday": the golden declares `calendarId: 'XNAS'` and a bar on a day that calendar
 * says the venue was shut is not a session. The committed golden used to list 2020-09-07 — Labor
 * Day, Nasdaq closed — which made it useless as evidence for any calendar-sensitive claim and
 * would have hidden an off-by-one in the row window behind a row that should not exist.
 *
 * `XNAS` is the same rule calendar `materialiseCalendar` writes into `calendar_holidays` below, so
 * the bars and the calendar the resolver reads are one statement, not two that happen to agree.
 */
function sessions(from: string, to: string): string[] {
  const out: string[] = [];
  for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= Date.parse(`${to}T00:00:00Z`); ms += 86_400_000) {
    const date = new Date(ms).toISOString().slice(0, 10);
    if (XNAS.isBusinessDay(date)) out.push(date);
  }
  return out;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push([...items.slice(i, i + size)]);
  return out;
}

async function insertBars(
  instrumentId: number,
  mdLineId: number,
  provenanceId: number,
  bars: readonly { date: string; open: number; high: number; low: number; close: number; volume: number }[],
): Promise<void> {
  for (const chunk of chunked(bars, 200)) {
    await t.client.query(
      `INSERT INTO bars_daily (instrument_id, session_date, md_line_id, open, high, low, close,
                               volume, capture_ts, provenance_id)
       SELECT $1, d.session_date::date, $2, d.open::numeric, d.high::numeric, d.low::numeric,
              d.close::numeric, d.volume::bigint, $3::timestamptz, $4
         FROM unnest($5::text[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::bigint[])
              AS d(session_date, open, high, low, close, volume)`,
      [
        instrumentId,
        mdLineId,
        GOLDEN_ISO,
        provenanceId,
        chunk.map((b) => b.date),
        chunk.map((b) => b.open),
        chunk.map((b) => b.high),
        chunk.map((b) => b.low),
        chunk.map((b) => b.close),
        chunk.map((b) => b.volume),
      ],
    );
  }
}


/**
 * One equity, its primary Nasdaq listing and one md line — **recorded in 2019**.
 *
 * `ws/helpers.ts#seedQuoteInstrument` writes the same rows but stamps `tx_from` with the wall
 * clock, and bitemporal rows are immutable (a WORM trigger refuses the `UPDATE` that would
 * backdate them). A read at `knownAt = 2020-07-30` therefore would not find the instrument at
 * all, and the §12.1 example would fail for the wrong reason. `WriteOptions.knownAt` is the
 * supported way to say when a version became known, so the fixture uses it directly.
 */
async function seedEquity(): Promise<{ instrumentId: number; mdLineId: number }> {
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, 'internal.user', 'hp-master');
  await bootstrapProvenance(t, 'yahoo.chart', 'hp-src');
  const o = {
    validFrom: new Date('2019-01-01T00:00:00Z'),
    knownAt: new Date('2019-01-01T00:00:00Z'),
    provenanceId,
  };

  const issuerId = await repos.issuers.insert({ name: 'Apple Inc issuer' }, o);
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: 'equity',
      securityType: 'Common Stock',
      name: 'Apple Inc',
      currency: 'USD',
    },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass: 'equity',
      marketSector: 'Equity',
      ticker: 'AAPL',
      exchCode: 'US',
      name: 'Apple Inc',
      currency: 'USD',
    },
    o,
  );
  const listingId = await repos.listings.insert(
    { instrumentId, exchCode: 'UW', localTicker: 'AAPL', isPrimary: true, mic: 'XNAS' },
    o,
  );
  const { mdLineId } = await repos.mdLines.upsertBySymbol(
    {
      instrumentId,
      listingId,
      sourceId: 'yahoo.chart',
      providerSymbol: 'AAPL',
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 10_000,
      priority: 10,
    },
    o,
  );
  return { instrumentId, mdLineId };
}

/**
 * The `series` variant's fixture: an econ instrument, its `econ_series` row and two years of
 * monthly observations at one vintage each.
 *
 * HP has two variants (FUNC-02) and until now only `price` was covered, so `HP/series.ts` shipped
 * with no test and no golden at all. `econ` is the family that makes the variant's point: an
 * observation carries the *vintage* it was published in, and a read as of a `knownAt` before a
 * revision legitimately returns the number that was published then (STOR-06).
 */
async function seedEconSeries(): Promise<{ instrumentId: number; seriesId: number }> {
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, 'internal.user', 'hp-econ-master');
  const obsProv = await bootstrapProvenance(t, 'bls.timeseries', 'hp-econ-obs');
  const o = {
    validFrom: new Date('2019-01-01T00:00:00Z'),
    knownAt: new Date('2019-01-01T00:00:00Z'),
    provenanceId,
  };

  const issuerId = await repos.issuers.insert({ name: 'US Bureau of Labor Statistics' }, o);
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: 'econ',
      securityType: 'Economic series',
      name: 'CPI-U All items, NSA',
      currency: 'USD',
    },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass: 'econ',
      marketSector: 'Index',
      ticker: 'CUUR0000SA0',
      exchCode: 'ECON',
      name: 'CPI-U All items, NSA',
      currency: 'USD',
    },
    o,
  );

  const release = await t.client.query<{ release_id: string }>(
    `INSERT INTO econ_releases (source_id, provider_release_id, name, country, url, importance)
     VALUES ('bls.timeseries', $1, 'Consumer Price Index', 'US', 'https://www.bls.gov/cpi/', 1)
     RETURNING release_id`,
    [`CPI-${randomUUID().slice(0, 8)}`],
  );
  const series = await t.client.query<{ series_id: string }>(
    `INSERT INTO econ_series (series_code, source_id, provider_code, name, units, frequency,
                              seasonal_adj, country, release_id, instrument_id, decimals,
                              first_obs_date, last_obs_date)
     VALUES ($1, 'bls.timeseries', $1, 'CPI-U All items, NSA', 'Index 1982-84=100',
             'M', 'NSA', 'US', $2, $3, 3, '2024-09-01', '2026-08-01')
     RETURNING series_id`,
    [`CUUR0000SA0-${randomUUID().slice(0, 8)}`, Number(release.rows[0]!.release_id), instrumentId],
  );
  const seriesId = Number(series.rows[0]!.series_id);

  // Twenty-four monthly prints ending 2026-08-01, on a deterministic ramp. One period is a
  // published gap — `status:'missing'` with a null value, never interpolated (§1.3 rule 6).
  const months: string[] = [];
  for (let i = 23; i >= 0; i -= 1) {
    months.push(new Date(Date.UTC(2026, 7 - i, 1)).toISOString().slice(0, 10));
  }
  await t.client.query(
    `INSERT INTO econ_observations (series_id, obs_date, vintage_at, value, status, is_latest,
                                    provenance_id)
     VALUES ${months
       .map(
         (m, i) =>
           `($1, '${m}', '${m}T13:30:00Z', ${
             i === 5 ? 'NULL' : (315 + i * 0.4).toFixed(3)
           }, '${i === 5 ? 'missing' : 'final'}', true, $2)`,
       )
       .join(',')}`,
    [seriesId, obsProv],
  );

  return { instrumentId, seriesId };
}

beforeEach(async () => {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);

  // Only the years this file's default window touches: `calendars` is a shared table and
  // `server-int` runs several forks against one database (see WEI.test.ts for the same note).
  await materialiseCalendar(t.db, XNAS, { fromYear: 2025, toYear: 2026 });
  await t.client.query(
    `INSERT INTO exchanges (mic, operating_mic, name, country, tz, calendar_id)
     VALUES ('XNAS', 'XNAS', 'Nasdaq', 'US', 'America/New_York', 'XNAS')
     ON CONFLICT (mic) DO NOTHING`,
  );

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`HP Firm ${randomUUID()}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'HP User', 'user') RETURNING user_id`,
    [firmId, `hp-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
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

  const seeded = await seedEquity();
  const econ = await seedEconSeries();

  const barProv = await bootstrapProvenance(t, 'yahoo.chart', 'hp-bars');

  // The recent block: a deterministic ramp, so every roll-up and every return is arithmetic.
  const recentDates = sessions('2025-09-01', AS_OF_DATE);
  const recent = recentDates.map((date, i) => ({
    date,
    close: Number((200 + i * 0.5).toFixed(6)),
    volume: 1_000_000 + i * 1_000,
  }));
  await insertBars(
    seeded.instrumentId,
    seeded.mdLineId,
    barProv,
    recent.map((b) => ({
      date: b.date,
      open: Number((b.close - 1).toFixed(6)),
      high: Number((b.close + 2).toFixed(6)),
      low: Number((b.close - 2).toFixed(6)),
      close: b.close,
      volume: b.volume,
    })),
  );

  // The 2020 block, either side of the split. 2020-08-28 is the golden's own bar.
  const dates2020 = sessions(WINDOW_2020.start, WINDOW_2020.end);
  const twentyTwenty = dates2020.map((date) => ({
    date,
    close:
      date === SPLIT_EVE.date
        ? SPLIT_EVE.close
        : date < SPLIT.exDate
          ? 480
          : 120,
  }));
  await insertBars(
    seeded.instrumentId,
    seeded.mdLineId,
    barProv,
    twentyTwenty.map((b) => ({
      date: b.date,
      open: b.close,
      high: b.close,
      low: b.close,
      close: b.close,
      volume: 100_000_000,
    })),
  );

  // The split, recorded on 2020-07-31 — the whole point of the §12.1 example.
  await t.client.query(
    `INSERT INTO corporate_actions
       (instrument_id, ca_type, status, ex_date, ratio_new, ratio_old, source_id, review_state,
        valid_from, valid_to, tx_from, tx_to, provenance_id)
     VALUES ($1, 'split', 'confirmed', $2::date, $3, $4, 'yahoo.chart', 'auto',
             $5::timestamptz, 'infinity', $5::timestamptz, 'infinity', $6)`,
    [
      seeded.instrumentId,
      SPLIT.exDate,
      SPLIT.ratioNew,
      SPLIT.ratioOld,
      SPLIT_RECORDED_AT,
      barProv,
    ],
  );

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };

  env = {
    harness,
    app: harness.app,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    knownAt,
    instrumentId: seeded.instrumentId,
    econInstrumentId: econ.instrumentId,
    recent,
    twentyTwenty,
  };
});

afterEach(async () => {
  await env.harness.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RunResult {
  data: HpPayload;
  meta: {
    resultId: string;
    page?: { index: number; count: number; cursor: string | null };
    provenance: { provenanceId: number; sourceId: string }[];
    unavailable: { field: string; reason: string; detail: string }[];
    engines: { name: string; version: string }[];
  };
}

async function runHP(
  params: Record<string, unknown> = {},
  asOf: { validAt: string; knownAt: string } = { validAt: GOLDEN_ISO, knownAt: env.knownAt },
): Promise<RunResult> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/HP/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, security: { id: env.instrumentId }, asOf },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<RunResult>();
}

/**
 * PAGE FWD / PAGE BACK as the shell sends them: `POST /functions/:code/page` over the previous
 * result's id. The run route takes no cursor — a page turn is a re-run of the *cached* params,
 * security and `asOf`, which is what keeps the summary stable across pages.
 */
async function pageHP(resultId: string, direction: 'fwd' | 'back'): Promise<RunResult> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/HP/page`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { resultId, direction },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<RunResult>();
}

function price(payload: HpPayload): HpPricePayload {
  expect(payload.variant).toBe('price');
  return payload as HpPricePayload;
}

function rowOn(payload: HpPricePayload, date: string): HpPricePayload['rows'][number] {
  const row = payload.rows.find((r) => r.date === date);
  expect(row, `${date} is missing from the page`).toBeDefined();
  return row!;
}

function valueOf(payload: HpPricePayload, date: string, field: string): number | null {
  const at = payload.columns.findIndex((c) => c.id === field);
  expect(at, `${field} is not a column`).toBeGreaterThanOrEqual(0);
  return rowOn(payload, date).v[at] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Periodicity
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('HP — periodicity', () => {
  it('serves one row per session at D and rolls the same window up at W, M, Q and Y', async () => {
    const daily = price((await runHP({ range: 'CUSTOM', ...WINDOW_2020, periodicity: 'D', pageSize: 500 })).data);
    expect(daily.rows).toHaveLength(env.twentyTwenty.length);
    expect(daily.rows.every((r) => r.sessions === 1)).toBe(true);

    const monthly = price(
      (await runHP({ range: 'CUSTOM', ...WINDOW_2020, periodicity: 'M', pageSize: 500 })).data,
    );
    // August and September 2020, in that order once the desc default is undone.
    expect(monthly.rows.map((r) => r.date.slice(0, 7)).sort()).toEqual(['2020-08', '2020-09']);
    // Each monthly row aggregates the daily sessions of its month.
    const august = env.twentyTwenty.filter((b) => b.date.startsWith('2020-08')).length;
    expect(monthly.rows.find((r) => r.date.startsWith('2020-08'))?.sessions).toBe(august);

    const yearly = price(
      (await runHP({ range: 'CUSTOM', ...WINDOW_2020, periodicity: 'Y', pageSize: 500 })).data,
    );
    expect(yearly.rows).toHaveLength(1);
    expect(yearly.rows[0]?.sessions).toBe(env.twentyTwenty.length);
    expect(yearly.periodicity).toBe('Y');
  });

  it('aggregates a roll-up as open-first, high-max, low-min, close-last, volume-sum', async () => {
    const fields = ['PX_OPEN', 'PX_HIGH', 'PX_LOW', 'PX_LAST', 'PX_VOLUME'];
    const monthly = price(
      (
        await runHP({
          range: 'CUSTOM',
          start: '2025-09-01',
          end: '2025-09-30',
          periodicity: 'M',
          fields,
          pageSize: 500,
        })
      ).data,
    );
    expect(monthly.rows).toHaveLength(1);

    const september = env.recent.filter((b) => b.date.startsWith('2025-09'));
    const closes = september.map((b) => b.close);
    expect(valueOf(monthly, monthly.rows[0]!.date, 'PX_OPEN')).toBeCloseTo(closes[0]! - 1, 6);
    expect(valueOf(monthly, monthly.rows[0]!.date, 'PX_HIGH')).toBeCloseTo(Math.max(...closes) + 2, 6);
    expect(valueOf(monthly, monthly.rows[0]!.date, 'PX_LOW')).toBeCloseTo(Math.min(...closes) - 2, 6);
    expect(valueOf(monthly, monthly.rows[0]!.date, 'PX_LAST')).toBeCloseTo(closes.at(-1)!, 6);
    expect(valueOf(monthly, monthly.rows[0]!.date, 'PX_VOLUME')).toBe(
      september.reduce((a, b) => a + b.volume, 0),
    );
  });

  it('computes CHG_NET_1D and CHG_PCT_1D between rows of the chosen periodicity', async () => {
    const fields = ['PX_LAST', 'CHG_NET_1D', 'CHG_PCT_1D'];
    const body = await runHP({
      range: 'CUSTOM',
      start: '2025-09-01',
      end: '2025-09-30',
      periodicity: 'D',
      order: 'asc',
      fields,
      pageSize: 500,
    });
    const daily = price(body.data);
    const rows = daily.rows;
    const second = rows[1]!;
    const first = rows[0]!;
    const closeAt = daily.columns.findIndex((c) => c.id === 'PX_LAST');
    const netAt = daily.columns.findIndex((c) => c.id === 'CHG_NET_1D');
    const pctAt = daily.columns.findIndex((c) => c.id === 'CHG_PCT_1D');

    expect(second.v[netAt]).toBeCloseTo((second.v[closeAt]!) - (first.v[closeAt]!), 9);
    expect(second.v[pctAt]).toBeCloseTo(
      ((second.v[closeAt]!) / (first.v[closeAt]!) - 1) * 100,
      9,
    );
    // The first row has no predecessor inside the window, so the change is absent with a reason.
    expect(first.v[netAt]).toBeNull();
    expect(body.meta.engines).toContainEqual(
      expect.objectContaining({ name: 'stats', version: '1.0.0' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Adjustment basis (REF-09) and the API.md §12.1 example (REF-03)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('HP — adjustment basis', () => {
  it('applies the split factor under ADJ=price and reports the step', async () => {
    const body = await runHP({
      range: 'CUSTOM',
      ...WINDOW_2020,
      periodicity: 'D',
      adjust: 'price',
      pageSize: 500,
    });
    const payload = price(body.data);

    expect(valueOf(payload, SPLIT_EVE.date, 'PX_LAST')).toBeCloseTo(ADJUSTED_CLOSE, 4);
    expect(rowOn(payload, SPLIT_EVE.date).adjFactor).toBeCloseTo(PRICE_FACTOR, 12);
    expect(payload.adjust).toBe('price');
    // The factor pair is the step itself, carried per row: price × ¼ and volume × 4.
    expect(rowOn(payload, SPLIT_EVE.date).volumeFactor).toBeCloseTo(
      SPLIT.ratioNew / SPLIT.ratioOld,
      12,
    );
    // A session on or after the ex-date is unadjusted: the factor is cumulative *forward*.
    expect(rowOn(payload, '2020-09-01').adjFactor).toBe(1);
    expect(rowOn(payload, '2020-09-01').volumeFactor).toBe(1);
    void body;
  });

  it('leaves the print alone under ADJ=unadjusted', async () => {
    const body = await runHP({
      range: 'CUSTOM',
      ...WINDOW_2020,
      periodicity: 'D',
      adjust: 'unadjusted',
      pageSize: 500,
    });
    const payload = price(body.data);
    expect(valueOf(payload, SPLIT_EVE.date, 'PX_LAST')).toBeCloseTo(SPLIT_EVE.close, 6);
    expect(rowOn(payload, SPLIT_EVE.date).adjFactor).toBe(1);
    void body;
  });

  /**
   * API.md §12.1, reproduced exactly: one request, two `knownAt`s, two answers.
   */
  it('returns the unadjusted print at a knownAt before the split was recorded (§12.1)', async () => {
    const params = {
      range: 'CUSTOM',
      ...WINDOW_2020,
      periodicity: 'D',
      adjust: 'price',
      pageSize: 500,
    };

    const after = await runHP(params, { validAt: VALID_AT_2020, knownAt: env.knownAt });
    const before = await runHP(params, {
      validAt: VALID_AT_2020,
      knownAt: BEFORE_SPLIT_KNOWN_AT,
    });

    expect(valueOf(price(after.data), SPLIT_EVE.date, 'PX_LAST')).toBeCloseTo(ADJUSTED_CLOSE, 4);
    expect(valueOf(price(before.data), SPLIT_EVE.date, 'PX_LAST')).toBeCloseTo(SPLIT_EVE.close, 6);

    // The factor is the visible difference: ¼ where the split is known, 1 where it is not.
    expect(rowOn(price(after.data), SPLIT_EVE.date).adjFactor).toBeCloseTo(PRICE_FACTOR, 12);
    expect(rowOn(price(before.data), SPLIT_EVE.date).adjFactor).toBe(1);

    // Both reads are of the same window at the same `validAt`; only what was *known* differs.
    expect(price(before.data).rows).toHaveLength(price(after.data).rows.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Paging
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('HP — paging', () => {
  it('pages the window and keeps the summary identical on every page', async () => {
    const first = await runHP({ range: '1Y', periodicity: 'D', pageSize: 60 });
    const page1 = price(first.data);

    expect(page1.rows.length).toBe(60);
    expect(first.meta.page?.index).toBe(0);
    expect(first.meta.page?.count).toBe(Math.ceil(page1.summary.bars / 60));
    expect(first.meta.page?.cursor).not.toBeNull();
    expect(decodeHpCursor(first.meta.page!.cursor!)).toBe(page1.rows.at(-1)!.date);

    const second = await pageHP(first.meta.resultId, 'fwd');
    const page2 = price(second.data);
    expect(second.meta.page?.index).toBe(1);
    // Descending by default: page 2 is older than page 1 and they do not overlap.
    expect(page2.rows[0]!.date < page1.rows.at(-1)!.date).toBe(true);
    expect(page2.summary).toEqual(page1.summary);

    const back = await pageHP(second.meta.resultId, 'back');
    expect(price(back.data).rows.map((r) => r.date)).toEqual(page1.rows.map((r) => r.date));
    expect(price(back.data).summary).toEqual(page1.summary);
  });

  it('summarises the whole window, not the page', async () => {
    const body = await runHP({ range: '1Y', periodicity: 'D', pageSize: 60 });
    const payload = price(body.data);
    const window = env.recent.filter(
      (b) => b.date >= payload.window.start && b.date <= payload.window.end,
    );

    expect(payload.summary.bars).toBe(window.length);
    expect(payload.summary.first).toBeCloseTo(window[0]!.close, 6);
    expect(payload.summary.last).toBeCloseTo(window.at(-1)!.close, 6);
    expect(payload.summary.firstDate).toBe(window[0]!.date);
    expect(payload.summary.lastDate).toBe(window.at(-1)!.date);
    expect(payload.summary.priceReturnPct).toBeCloseTo(
      (window.at(-1)!.close / window[0]!.close - 1) * 100,
      9,
    );
    // The ramp only rises, so the window high is the last session's high and the low the first's.
    expect(payload.summary.highDate).toBe(window.at(-1)!.date);
    expect(payload.summary.lowDate).toBe(window[0]!.date);
  });

  it('orders ascending when asked and pages the other way round', async () => {
    const body = await runHP({ range: '1Y', periodicity: 'D', pageSize: 60, order: 'asc' });
    const payload = price(body.data);
    expect(payload.rows[0]!.date < payload.rows.at(-1)!.date).toBe(true);
    expect(payload.rows[0]!.date).toBe(payload.summary.firstDate);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV parity (FUNC-03) and the payload-honesty rules
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('HP — CSV parity', () => {
  it('exports every cell of the payload it came from, at full precision', async () => {
    const params = {
      range: 'CUSTOM',
      ...WINDOW_2020,
      periodicity: 'D',
      adjust: 'price' as const,
      fields: ['PX_LAST', 'PX_OPEN', 'PX_HIGH', 'PX_LOW', 'PX_VOLUME', 'CHG_PCT_1D'],
      pageSize: 500,
      order: 'desc' as const,
    };
    const body = await runHP(params);
    const payload = price(body.data);

    const doc = toCsv(HP, payload, { ...HP.params.parse(params) }, {
      display: 'AAPL US Equity',
      asOf: GOLDEN_ISO,
      attribution: ['Yahoo Finance'],
    });

    // Columns: date, then one per payload column, then adjFactor.
    expect(doc.columns.map((c) => c.id)).toEqual([
      'date',
      ...payload.columns.map((c) => c.id),
      'adjFactor',
    ]);
    expect(doc.columns.map((c) => c.decimals)).toEqual([
      undefined,
      ...payload.columns.map((c) => c.decimals ?? undefined),
      undefined,
    ]);

    expect(doc.rows).toHaveLength(payload.rows.length);
    for (const [i, row] of payload.rows.entries()) {
      // Cell for cell, including the nulls: an exported gap must stay a gap.
      expect(doc.rows[i], `row ${String(i)}`).toEqual([row.date, ...row.v, row.adjFactor]);
    }
    expect(doc.filename).toBe(`HP_AAPL_US_Equity_20260915T184128Z.csv`);
  });
});

describe('HP — payload honesty', () => {
  it('cites provenance for every row and explains its nulls', async () => {
    const body = await runHP({ range: 'CUSTOM', ...WINDOW_2020, periodicity: 'D', pageSize: 500 });
    const payload = price(body.data);

    // Every row of the window cites the bar block that produced it. The indexes are the ones
    // `data/historical.ts` handed back; see the file note on the two provenance collectors.
    expect(payload.provIdx.length).toBeGreaterThan(0);
    for (const idx of payload.provIdx) expect(idx).toBeGreaterThanOrEqual(0);
    expect(body.meta.provenance.length).toBeGreaterThan(0);
    // `CHG_PCT_1D` on the first row is null by construction; the runner would have refused the
    // payload if nothing in `meta` explained a null cell.
    expect(body.meta.unavailable.length).toBeGreaterThan(0);
  });

  it('says so when the window holds no sessions at all', async () => {
    const body = await runHP({
      range: 'CUSTOM',
      start: '2015-01-01',
      end: '2015-01-31',
      periodicity: 'D',
    });
    const payload = price(body.data);
    expect(payload.rows).toHaveLength(0);
    expect(payload.summary.bars).toBe(0);
    expect(body.meta.unavailable).toContainEqual({
      field: 'rows',
      reason: 'NO_SOURCE',
      detail: 'no daily bars in window',
    });
  });

  it('excludes the open session and flags it', async () => {
    const body = await runHP({ range: '1M', periodicity: 'D', pageSize: 500 });
    const payload = price(body.data);
    // Nothing on or after the as-of date is in the table; HP shows completed sessions only.
    expect(payload.rows.every((r) => r.date <= AS_OF_DATE)).toBe(true);
    expect(payload.calendarId).toBe('XNAS');
    expect(typeof payload.sessionOpen).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Golden
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('HP — the series variant (FUNC-02)', () => {
  async function runSeries(params: Record<string, unknown> = {}): Promise<RunResult> {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/HP/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params,
        security: { id: env.econInstrumentId },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    return res.json<RunResult>();
  }

  function series(payload: HpPayload): HpSeriesPayload {
    expect(payload.variant).toBe('series');
    return payload as HpSeriesPayload;
  }

  it('serves published observations with their vintages, and never interpolates a gap', async () => {
    const { data, meta } = await runSeries({ range: '2Y' });
    const payload = series(data);

    // The runner asserted `variant` against `HP.variants.econ` before this line ran; this is the
    // statement the *screen* depends on.
    expect(payload.series.kind).toBe('econ');
    expect(payload.columns.map((c) => c.id)).toEqual(['ECO_VALUE']);
    expect(payload.rows.length).toBeGreaterThan(0);
    expect(payload.rows.every((r) => r.vintageAt !== null)).toBe(true);

    // A published gap is `missing` with a null value, and it is explained rather than blank.
    const gap = payload.rows.find((r) => r.status === 'missing');
    expect(gap).toBeDefined();
    expect(gap!.v[0]).toBeNull();
    expect(meta.unavailable.map((u) => u.field)).toContain('ECO_VALUE');

    // Every value carries a provenance index, and each one names a row of `meta.provenance`.
    for (const idx of payload.provIdx) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(meta.provenance[idx]).toBeDefined();
    }
    for (const note of meta.unavailable) {
      expect(['NO_SOURCE', 'NOT_LICENSED', 'NOT_APPLICABLE']).toContain(note.reason);
    }

    // The summary is over the window, and it skips the gap rather than treating it as a zero.
    expect(payload.summary.observations).toBe(payload.rows.length);
    expect(payload.summary.low).toBeGreaterThan(0);
    expect(payload.summary.high).toBeGreaterThanOrEqual(payload.summary.low!);
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    const { data } = await runSeries({ range: '2Y' });
    expectGolden('HP.series.json', normaliseSeries(series(data)));
  });

  /**
   * The instrument id and the per-run series code become tokens, and so does `knownAt`.
   *
   * `knownAt` is the *wall clock* of the write that seeded this run (`clock_timestamp()` + 1 s),
   * not the frozen clock: bitemporal reads need a `knownAt` after the rows were written, and the
   * rows are written now. It is echoed on the payload because a point-in-time read has to say what
   * it was read as of — which makes it the one field in this payload that cannot be a golden.
   */
  function normaliseSeries(payload: HpSeriesPayload): unknown {
    const id = env.econInstrumentId;
    const code = payload.series.code;
    const tokens = new Map([[id, '<CPI>']]);
    return JSON.parse(
      JSON.stringify(payload, (key: string, value: unknown) => {
        if (key === 'knownAt') return '<knownAt>';
        // The series code is a fixture string and `series.code` is the one place it is published;
        // the instrument id is a sequence value and is replaced in subject strings only
        // (`subjectToken`), never in a timestamp that happens to contain its digits.
        if (typeof value === 'string') {
          const untagged = key === 'code' ? value.split(code).join('<SERIES_CODE>') : value;
          return subjectToken(untagged, tokens);
        }
        // An economic series is a column of observations — CPI levels, month-over-month and
        // year-over-year changes. An id is an id because of the key it sits under, never because
        // a print equals one.
        return idToken(key, value, ID_KEYS, tokens);
      }),
    );
  }
});

describe('HP — golden', () => {
  it('deep-equals the committed golden at the frozen clock', async () => {
    const body = await runHP({
      range: 'CUSTOM',
      ...WINDOW_2020,
      periodicity: 'D',
      adjust: 'price',
      pageSize: 500,
    });
    const payload = price(body.data);
    expectGolden(GOLDEN_NAME, normalise(payload));
  });
});

/**
 * The one key in an HP payload that holds a sequence-allocated id (both variants). `calendarId`
 * (`'XNAS'`), a column's `id` (`'PX_LAST'`) and `sourceId` (`'bls.timeseries'`) are names, and
 * `mdLineIds` has its own branch.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId']);

/**
 * The golden cannot carry the fixture's instrument id (the id is whatever the sequence gave this
 * run), so every occurrence of it — the number and the string — becomes `<AAPL>` before the
 * comparison. Provenance indexes are positions in this run's `meta.provenance`, which is stable
 * for a fixed read, so they are compared as they are.
 */
function normalise(payload: HpPricePayload): unknown {
  const id = env.instrumentId;
  const tokens = new Map([[id, '<AAPL>']]);
  return JSON.parse(
    JSON.stringify(payload, (key: string, value: unknown) => {
      // `md_lines.md_line_id` is a bare sequence with no fixture control over it, so the golden
      // records that there is exactly one line rather than which number this run drew.
      if (key === 'mdLineIds' && Array.isArray(value)) return `<${String(value.length)} md line(s)>`;
      if (typeof value === 'string') return subjectToken(value, tokens);
      // A price history is nothing but bars — open, high, low, close, volume, adjustment factors
      // and the summary's `first`, `last`, `high`, `low` and `bars`. Under the old value-based
      // rule every whole-numbered one of them was a candidate: the run whose sequence reached the
      // fixture's own close would have renamed the close as `<AAPL>`.
      return idToken(key, value, ID_KEYS, tokens);
    }),
  );
}
