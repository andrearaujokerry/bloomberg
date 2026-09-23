/**
 * `test/integration/functions/GP.test.ts` — the price graph, all seven variants.
 *
 * GP exists because "what was this worth over time" has seven different answers depending on what
 * the security *is*, and the whole point of FUNC-02 is that the screen does not have to know which:
 *
 * | variant   | what the line actually is          | table                      |
 * | --------- | ---------------------------------- | -------------------------- |
 * | `equity`  | adjusted closes (REF-09)           | `bars_daily`               |
 * | `index`   | the published level                | `bars_daily`               |
 * | `fx`      | the cross                          | `bars_daily`               |
 * | `govt`    | the **yield** of the on-the-run tenor | `curve_points`          |
 * | `option`  | the contract's trade, else the mid | `option_quotes`            |
 * | `crypto`  | captured polls, resampled          | `quote_ticks`              |
 * | `series`  | a published observation at its vintage | `econ_observations`    |
 *
 * Each is seeded here and each has its own golden, because a regression in one of them is invisible
 * in the other six.
 *
 * Beyond the variants, three behaviours are worth their own test and are what a user would notice
 * first if they broke:
 *
 *  - **An overlay that does not resolve is dropped, not fatal.** A typo in `VS=` costs the overlay
 *    and nothing else; the primary still draws. That is a `NOT_APPLICABLE` note, never a 4xx.
 *  - **A formula overlay is a real series** (CHRT-07): `RATIO(A, B)` evaluated per date over the
 *    *intersection* of its leaves, close-only, with the `formula@1.0.0` engine recorded.
 *  - **Event markers carry commands** (CHRT-06): a dividend opens `CACS` and an earnings 8-K opens
 *    `CF`, because a marker you cannot press is decoration.
 *
 * Nothing here uses a seeded instrument id: WP-15 owns the seed and it does not exist, so every
 * row is written inside this file's own transaction (FUNCTIONS_TIER1 §0.7 notwithstanding).
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { expectGolden, subjectToken } from './golden.js';

import { FunctionRegistry, toCsv } from '@terminal/core';
import type { AssetClass, MarketSector, NormalisedUpdate, QuoteFields } from '@terminal/core';
import { XNAS } from '@terminal/core/calendars/nyse';
import { GP } from '@terminal/core/functions/manifests/GP';
import type { GpPayload, GpVariant } from '@terminal/core/functions/manifests/GP';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as GPModule from '../../../src/functions/GP/resolve.js';
import { materialiseCalendar } from '../../../src/refdata/calendars.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString(); // 2026-09-15T18:41:28.000Z
const AS_OF_DATE = GOLDEN_ISO.slice(0, 10);
const GRANT_FROM = '2020-01-01T00:00:00.000Z';

/** The window every golden but the option one draws — ten sessions, small enough to read. */
const WINDOW = { start: '2026-09-01', end: '2026-09-15' } as const;
/** The option's captures are one day of five-minute marks. */
const OPTION_WINDOW = { start: AS_OF_DATE, end: AS_OF_DATE } as const;
/** Ticks are retained thirty days, so the crypto window is three of them. */
const CRYPTO_WINDOW = { start: '2026-09-13', end: '2026-09-15' } as const;

const DIVIDEND_DATE = '2026-09-08';
const EARNINGS_DATE = '2026-09-04';
const CIK = '0000320193';

const REGISTRY = new FunctionRegistry([GP]);
 
const MODULES: Record<string, FunctionServerModule<any, any>> = { GP: GPModule };

const t: TestDb = withTxDb();

interface Seeded {
  instrumentId: number;
  mdLineId: number;
}

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  cookie: string;
  knownAt: string;
  userId: number;
  ids: Record<'equity' | 'index' | 'fx' | 'govt' | 'option' | 'crypto' | 'series' | 'peer', Seeded>;
  sessions: string[];
  closes: Map<string, number>;
}

let env: Env;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────────────────────

function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= end; ms += 86_400_000) {
    const day = new Date(ms).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

async function seedInstrument(spec: {
  ticker: string;
  name: string;
  assetClass: AssetClass;
  marketSector: MarketSector;
  exchCode: string;
  currency: string;
  mic: string | null;
  sourceId: string;
}): Promise<Seeded> {
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, 'internal.user', `gp-${spec.ticker}`);
  await bootstrapProvenance(t, spec.sourceId, `gp-src-${spec.ticker}`);
  const o = { validFrom: new Date('2020-01-01T00:00:00Z'), provenanceId };

  const issuerId = await repos.issuers.insert({ name: `${spec.name} issuer` }, o);
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: spec.assetClass,
      securityType: spec.assetClass === 'equity' ? 'Common Stock' : spec.marketSector,
      name: spec.name,
      currency: spec.currency,
    },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass: spec.assetClass,
      marketSector: spec.marketSector,
      ticker: spec.ticker,
      exchCode: spec.exchCode,
      name: spec.name,
      currency: spec.currency,
    },
    o,
  );
  let listingId: number | undefined;
  if (spec.mic !== null) {
    listingId = await repos.listings.insert(
      { instrumentId, exchCode: 'UW', localTicker: spec.ticker, isPrimary: true, mic: spec.mic },
      o,
    );
  }
  const { mdLineId } = await repos.mdLines.upsertBySymbol(
    {
      instrumentId,
      ...(listingId === undefined ? {} : { listingId }),
      sourceId: spec.sourceId,
      providerSymbol: spec.ticker,
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 60_000,
      priority: 10,
    },
    o,
  );
  return { instrumentId, mdLineId };
}

async function insertDailyBars(
  seeded: Seeded,
  provenanceId: number,
  dates: readonly string[],
  base: number,
  step: number,
): Promise<Map<string, number>> {
  const closes = new Map<string, number>();
  const values = dates.map((date, i) => {
    const close = Number((base + i * step).toFixed(6));
    closes.set(date, close);
    return close;
  });
  await t.client.query(
    `INSERT INTO bars_daily (instrument_id, session_date, md_line_id, open, high, low, close,
                             volume, capture_ts, provenance_id)
     SELECT $1, d.session_date::date, $2, (d.close - 1)::numeric, (d.close + 2)::numeric,
            (d.close - 2)::numeric, d.close::numeric, 5000000, $3::timestamptz, $4
       FROM unnest($5::text[], $6::numeric[]) AS d(session_date, close)`,
    [seeded.instrumentId, seeded.mdLineId, GOLDEN_ISO, provenanceId, [...dates], values],
  );
  return closes;
}

function quote(
  seeded: Seeded,
  assetClass: AssetClass,
  provenanceId: number,
  sourceId: string,
  fields: Partial<QuoteFields>,
): NormalisedUpdate {
  return {
    subject: `q:${String(seeded.instrumentId)}`,
    instrumentId: seeded.instrumentId,
    mdLineId: seeded.mdLineId,
    assetClass,
    tier: 'delayed',
    fields,
    ts: { src: GOLDEN_CAPTURE_MS - 900_000, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: { sourceId, provenanceId },
  };
}

beforeEach(async () => {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);

  await materialiseCalendar(t.db, XNAS, { fromYear: 2026, toYear: 2026 });
  await t.client.query(
    `INSERT INTO exchanges (mic, operating_mic, name, country, tz, calendar_id)
     VALUES ('XNAS', 'XNAS', 'Nasdaq', 'US', 'America/New_York', 'XNAS')
     ON CONFLICT (mic) DO NOTHING`,
  );

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`GP Firm ${randomUUID()}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'GP User', 'user') RETURNING user_id`,
    [firmId, `gp-${randomUUID()}@demo.invalid`],
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

  const sessions = weekdays(WINDOW.start, WINDOW.end);
  const barProv = await bootstrapProvenance(t, 'yahoo.chart', 'gp-bars');

  // ── the seven securities ────────────────────────────────────────────────────────────────────
  const equity = await seedInstrument({
    ticker: 'AAPL',
    name: 'Apple Inc',
    assetClass: 'equity',
    marketSector: 'Equity',
    exchCode: 'US',
    currency: 'USD',
    mic: 'XNAS',
    sourceId: 'yahoo.chart',
  });
  const peer = await seedInstrument({
    ticker: 'MSFT',
    name: 'Microsoft Corp',
    assetClass: 'equity',
    marketSector: 'Equity',
    exchCode: 'US',
    currency: 'USD',
    mic: 'XNAS',
    sourceId: 'yahoo.chart',
  });
  const index = await seedInstrument({
    ticker: 'SPX',
    name: 'S&P 500',
    assetClass: 'index',
    marketSector: 'Index',
    exchCode: 'INDEX',
    currency: 'USD',
    mic: 'XNAS',
    sourceId: 'cboe.quotes',
  });
  const fx = await seedInstrument({
    ticker: 'EURUSD',
    name: 'Euro / US Dollar',
    assetClass: 'fx',
    marketSector: 'Curncy',
    exchCode: 'FX',
    currency: 'USD',
    mic: null,
    sourceId: 'yahoo.chart',
  });
  const govt = await seedInstrument({
    ticker: '912797VE4',
    name: 'US Treasury Bill 4WK',
    assetClass: 'govt',
    marketSector: 'Govt',
    exchCode: 'GOVT',
    currency: 'USD',
    mic: null,
    sourceId: 'treasury.bills',
  });
  const option = await seedInstrument({
    ticker: 'AAPL260916C00245000',
    name: 'AAPL 9/16/26 C245',
    assetClass: 'option',
    marketSector: 'Equity',
    exchCode: 'US',
    currency: 'USD',
    mic: null,
    sourceId: 'cboe.options',
  });
  const crypto = await seedInstrument({
    ticker: 'BTC',
    name: 'Bitcoin',
    assetClass: 'crypto',
    marketSector: 'Crypto',
    exchCode: 'CRYPTO',
    currency: 'USD',
    mic: null,
    sourceId: 'coingecko.simple',
  });
  const series = await seedInstrument({
    ticker: 'DGS10',
    name: '10-Year Treasury Constant Maturity Rate',
    assetClass: 'econ',
    marketSector: 'Index',
    exchCode: 'ECON',
    currency: 'USD',
    mic: null,
    sourceId: 'fred.csv',
  });

  const closes = await insertDailyBars(equity, barProv, sessions, 330, 0.5);
  await insertDailyBars(peer, barProv, sessions, 520, 0.25);
  await insertDailyBars(index, barProv, sessions, 7600, 3);
  await insertDailyBars(fx, barProv, sessions, 1.08, 0.001);

  // ── equity extras: a CIK, a dividend, an earnings 8-K and one annotation ────────────────────
  await t.client.query(
    `INSERT INTO identifiers (entity_kind, entity_id, scheme, value, qualifier, is_primary,
                              valid_from, provenance_id)
     VALUES ('instrument', $1, 'CIK', $2, '', true, timestamptz '2020-01-01', $3)`,
    [equity.instrumentId, CIK, barProv],
  );
  await t.client.query(
    `INSERT INTO corporate_actions
       (instrument_id, ca_type, status, ex_date, amount, currency, source_id, review_state,
        valid_from, provenance_id)
     VALUES ($1, 'cash_dividend', 'confirmed', $2::date, 0.26, 'USD', 'yahoo.chart', 'auto',
             timestamptz '2020-01-01', $3)`,
    [equity.instrumentId, DIVIDEND_DATE, barProv],
  );
  await t.client.query(
    `INSERT INTO filings (accession_no, cik, form, filed_date, items, url, captured_at,
                          provenance_id)
     VALUES ($1, $2, '8-K', $3::date, ARRAY['2.02','9.01'], 'https://sec.gov/x', $4::timestamptz, $5)`,
    [`0000320193-26-0000${randomUUID().slice(0, 2)}`, CIK, EARNINGS_DATE, GOLDEN_ISO, barProv],
  );
  await t.client.query(
    `INSERT INTO chart_annotations (owner_user_id, firm_id, instrument_id, kind, anchors, style,
                                    label, shared_scope)
     VALUES ($1, $2, $3, 'hline', $4::jsonb, '{}'::jsonb, 'resistance', 'private')`,
    [userId, firmId, equity.instrumentId, JSON.stringify([{ t: 0, v: 340 }])],
  );

  // ── govt: the on-the-run 4-week bill and its investment-yield history ───────────────────────
  await t.client.query(
    `INSERT INTO govt_terms (instrument_id, security_type, cusip, term_label, maturity_date,
                             day_count, valid_from, provenance_id)
     VALUES ($1, 'bill', '912797VE4', '4WK', date '2026-09-29', 'ACT/360',
             timestamptz '2020-01-01', $2)`,
    [govt.instrumentId, barProv],
  );
  const billProv = await bootstrapProvenance(t, 'treasury.bills', 'gp-bills');
  // `curve_points.curve_id` is a foreign key: the curve has to exist before its history does.
  await t.client.query(
    `INSERT INTO curves (curve_id, name, currency, kind, day_count, compounding, source_id)
     VALUES ('UST_BILL', 'US Treasury bills', 'USD', 'bill', 'ACT/360', 'simple', 'treasury.bills')
     ON CONFLICT (curve_id) DO NOTHING`,
  );
  await t.client.query(
    `INSERT INTO curve_points (curve_id, curve_date, tenor, quote_type, vintage_at, tenor_days,
                               value, is_latest, provenance_id)
     SELECT 'UST_BILL', d.session_date::date, '4WK', 'investment_yield', $1::timestamptz, 28,
            d.value::numeric, true, $2
       FROM unnest($3::text[], $4::numeric[]) AS d(session_date, value)`,
    [
      GOLDEN_ISO,
      billProv,
      sessions,
      sessions.map((_, i) => Number((4.2 + i * 0.01).toFixed(8))),
    ],
  );

  // ── option: the contract's terms and one day of five-minute captures ────────────────────────
  const optionProv = await bootstrapProvenance(t, 'cboe.options', 'gp-options');
  await t.client.query(
    `INSERT INTO option_terms (instrument_id, occ_symbol, root, underlying_instrument_id, expiry,
                               strike, put_call, valid_from, provenance_id)
     VALUES ($1, 'AAPL260916C00245000', 'AAPL', $2, date '2026-09-16', 245, 'C',
             timestamptz '2020-01-01', $3)`,
    [option.instrumentId, equity.instrumentId, optionProv],
  );
  const optionCaptures: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    optionCaptures.push(new Date(Date.parse(`${AS_OF_DATE}T14:00:00.000Z`) + i * 300_000).toISOString());
  }
  await t.client.query(
    `INSERT INTO option_quotes (capture_ts, instrument_id, underlying_instrument_id, md_line_id,
                                bid, ask, last, volume, provenance_id)
     SELECT c.capture_ts::timestamptz, $1, $2, $3, c.bid::numeric, c.ask::numeric, c.last::numeric,
            250, $4
       FROM unnest($5::text[], $6::numeric[], $7::numeric[], $8::numeric[])
            AS c(capture_ts, bid, ask, last)`,
    [
      option.instrumentId,
      equity.instrumentId,
      option.mdLineId,
      optionProv,
      optionCaptures,
      optionCaptures.map((_, i) => Number((12.1 + i * 0.05).toFixed(4))),
      optionCaptures.map((_, i) => Number((12.3 + i * 0.05).toFixed(4))),
      optionCaptures.map((_, i) => Number((12.2 + i * 0.05).toFixed(4))),
    ],
  );

  // ── crypto: three days of sixty-second polls, one per hour to keep the golden readable ──────
  const tickProv = await bootstrapProvenance(t, 'coingecko.simple', 'gp-ticks');
  const tickStamps: string[] = [];
  for (let i = 0; i < 48; i += 1) {
    tickStamps.push(
      new Date(Date.parse(`${CRYPTO_WINDOW.start}T00:00:00.000Z`) + i * 3_600_000).toISOString(),
    );
  }
  await t.client.query(
    `INSERT INTO quote_ticks (capture_ts, instrument_id, md_line_id, kind, price, volume,
                              provenance_id)
     SELECT c.capture_ts::timestamptz, $1, $2, 'summary', c.price::numeric, 1000, $3
       FROM unnest($4::text[], $5::numeric[]) AS c(capture_ts, price)`,
    [
      crypto.instrumentId,
      crypto.mdLineId,
      tickProv,
      tickStamps,
      tickStamps.map((_, i) => Number((64_000 + i * 12).toFixed(6))),
    ],
  );

  // ── series: an economic series with one observation per session ─────────────────────────────
  const econProv = await bootstrapProvenance(t, 'fred.csv', 'gp-econ');
  const econ = await t.client.query<{ series_id: string }>(
    `INSERT INTO econ_series (series_code, source_id, provider_code, name, units, frequency,
                              country, instrument_id, decimals)
     VALUES ('DGS10', 'fred.csv', 'DGS10', '10-Year Treasury Constant Maturity Rate',
             'Percent', 'D', 'US', $1, 2)
     RETURNING series_id`,
    [series.instrumentId],
  );
  const seriesId = Number(econ.rows[0]!.series_id);
  await t.client.query(
    `INSERT INTO econ_observations (series_id, obs_date, vintage_at, value, status, is_latest,
                                    provenance_id)
     SELECT $1, d.obs_date::date, $2::timestamptz, d.value::numeric, 'final', true, $3
       FROM unnest($4::text[], $5::numeric[]) AS d(obs_date, value)`,
    [
      seriesId,
      GOLDEN_ISO,
      econProv,
      sessions,
      sessions.map((_, i) => Number((4.35 + i * 0.01).toFixed(6))),
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

  harness.deps.plant.apply(
    quote(equity, 'equity', barProv, 'yahoo.chart', {
      PX_LAST: 335.12,
      PX_CLOSE_1D: 334.5,
      SESSION_STATE: 'open',
    }),
  );
  harness.deps.plant.apply(
    quote(index, 'index', barProv, 'cboe.quotes', {
      PX_LAST: 7630.25,
      PX_CLOSE_1D: 7627,
      SESSION_STATE: 'open',
    }),
  );
  harness.deps.plant.apply(
    quote(fx, 'fx', barProv, 'yahoo.chart', { PX_LAST: 1.0921, PX_CLOSE_1D: 1.0915 }),
  );
  harness.deps.plant.apply(
    quote(crypto, 'crypto', tickProv, 'coingecko.simple', {
      PX_LAST: 64_564,
      PX_CLOSE_1D: 64_100,
    }),
  );
  harness.deps.plant.apply(
    quote(option, 'option', optionProv, 'cboe.options', { PX_LAST: 12.75, PX_CLOSE_1D: 12.2 }),
  );

  env = {
    harness,
    app: harness.app,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    knownAt,
    userId,
    ids: { equity, index, fx, govt, option, crypto, series, peer },
    sessions,
    closes,
  };
});

afterEach(async () => {
  await env.harness.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RunResult {
  data: GpPayload;
  meta: {
    provenance: { provenanceId: number; sourceId: string }[];
    unavailable: { field: string; reason: string; detail: string }[];
    engines: { name: string; version: string }[];
  };
}

async function runGP(instrumentId: number, params: Record<string, unknown>): Promise<RunResult> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/GP/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      security: { id: instrumentId },
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<RunResult>();
}

/** The params each variant's golden is taken at. */
const VARIANT_PARAMS: Record<GpVariant, Record<string, unknown>> = {
  equity: { range: 'CUSTOM', ...WINDOW, periodicity: 'D' },
  index: { range: 'CUSTOM', ...WINDOW, periodicity: 'D' },
  fx: { range: 'CUSTOM', ...WINDOW, periodicity: 'D' },
  govt: { range: 'CUSTOM', ...WINDOW, periodicity: 'D' },
  option: { range: 'CUSTOM', ...OPTION_WINDOW, periodicity: '5m' },
  crypto: { range: 'CUSTOM', ...CRYPTO_WINDOW, periodicity: 'D' },
  series: { range: 'CUSTOM', ...WINDOW, periodicity: 'D' },
};

const VARIANT_OF: Record<GpVariant, keyof Env['ids']> = {
  equity: 'equity',
  index: 'index',
  fx: 'fx',
  govt: 'govt',
  option: 'option',
  crypto: 'crypto',
  series: 'series',
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Variants
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('GP — the seven variants', () => {
  it('charts the adjusted equity closes and follows q: for the forming session', async () => {
    const { data } = await runGP(env.ids.equity.instrumentId, VARIANT_PARAMS.equity);

    expect(data.variant).toBe('equity');
    expect(data.primary.unit).toBe('price');
    expect(data.primary.key).toBe('AAPL US Equity');
    expect(data.primary.t).toHaveLength(env.sessions.length);
    expect(data.primary.c.at(-1)).toBeCloseTo(env.closes.get(env.sessions.at(-1)!)!, 6);
    expect(data.primary.o).not.toBeNull();
    expect(data.primary.v).not.toBeNull();
    expect(data.window.bars).toBe(env.sessions.length);
    expect(data.window.periodicity).toBe('D');
    // A daily chart overwrites the last bar's close from `q:`; it does not append a new bar.
    expect(data.primary.live).toEqual({
      subject: `q:${String(env.ids.equity.instrumentId)}`,
      field: 'PX_LAST',
      mode: 'replace-last',
    });
    expect(data.last.v).toBe(335.12);
    expect(data.reference).toEqual([
      { label: 'prev close', v: 334.5, provIdx: expect.any(Number) },
    ]);
    expect(data.reference[0]!.provIdx).toBeGreaterThanOrEqual(0);
  });

  it('charts an index as a level and an fx pair as a price', async () => {
    const index = await runGP(env.ids.index.instrumentId, VARIANT_PARAMS.index);
    expect(index.data.variant).toBe('index');
    expect(index.data.primary.unit).toBe('index');
    expect(index.data.primary.key).toBe('SPX Index');

    const fx = await runGP(env.ids.fx.instrumentId, VARIANT_PARAMS.fx);
    expect(fx.data.variant).toBe('fx');
    expect(fx.data.primary.unit).toBe('price');
    // §0.6 fixes fx on `FX_USD`, with no listing to join through.
    expect(fx.data.primary.calendarId).toBe('FX_USD');
  });

  it('charts a Treasury bill as its tenor’s yield, not a price', async () => {
    const { data } = await runGP(env.ids.govt.instrumentId, VARIANT_PARAMS.govt);
    expect(data.variant).toBe('govt');
    expect(data.primary.unit).toBe('yield');
    // A yield series has no open, high, low or volume — there is one published number a day.
    expect(data.primary.o).toBeNull();
    expect(data.primary.v).toBeNull();
    expect(data.primary.c).toHaveLength(env.sessions.length);
    expect(data.primary.c[0]).toBeCloseTo(4.2, 8);
    expect(data.primary.live).toBeNull();
    // `'last yield'`, not `'par'`. The number is the last close of the instrument's own yield
    // series, which is what the chart draws; a par yield is a different quantity, bootstrapped
    // from the curve, and a label may not claim more than its number is.
    expect(data.reference).toEqual([
      { label: 'last yield', v: data.primary.c.at(-1), provIdx: data.primary.provIdx },
    ]);
  });

  it('charts an option from its captures and shows the strike', async () => {
    const { data } = await runGP(env.ids.option.instrumentId, VARIANT_PARAMS.option);
    expect(data.variant).toBe('option');
    expect(data.primary.t.length).toBeGreaterThan(0);
    // `last` beats the mid when the contract traded.
    expect(data.primary.c[0]).toBeCloseTo(12.2, 4);
    // Every reference line carries its own provenance index: a chart's horizontal line is a
    // displayed price, and §1.5 admits no displayed price without one. The strike cites the
    // `option_terms` read it came from.
    expect(data.reference).toHaveLength(1);
    expect(data.reference[0]!.label).toBe('strike');
    expect(data.reference[0]!.v).toBe(245);
    expect(data.reference[0]!.provIdx).toBeGreaterThanOrEqual(0);
  });

  it('charts crypto from the captured polls and says they are context only', async () => {
    const body = await runGP(env.ids.crypto.instrumentId, VARIANT_PARAMS.crypto);
    expect(body.data.variant).toBe('crypto');
    expect(body.data.primary.t.length).toBeGreaterThan(0);
    // A daily bucket opens on its first poll and closes on its last: 24 hourly polls, +12 each.
    expect(body.data.primary.o![0]).toBeCloseTo(64_000, 6);
    expect(body.data.primary.c[0]).toBeCloseTo(64_000 + 23 * 12, 6);

    const long = await runGP(env.ids.crypto.instrumentId, {
      range: 'CUSTOM',
      start: '2026-01-01',
      end: AS_OF_DATE,
      periodicity: 'D',
    });
    expect(long.meta.unavailable).toContainEqual({
      field: 'primary',
      reason: 'NO_SOURCE',
      detail: 'no daily history source for crypto (context only); showing captured ticks (≤ 30 d)',
    });
  });

  it('charts an economic series at the vintage it was known at', async () => {
    const { data } = await runGP(env.ids.series.instrumentId, VARIANT_PARAMS.series);
    expect(data.variant).toBe('series');
    // `econ_series.units` starts with 'Percent', so the axis is a percentage, not an index level.
    expect(data.primary.unit).toBe('pct');
    expect(data.primary.c).toHaveLength(env.sessions.length);
    expect(data.primary.c[0]).toBeCloseTo(4.35, 6);
    expect(data.primary.live).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Overlays (CHRT-03, CHRT-07)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('GP — overlays', () => {
  it('adds a second security on its own calendar', async () => {
    const { data } = await runGP(env.ids.equity.instrumentId, {
      ...VARIANT_PARAMS.equity,
      overlays: [{ id: env.ids.peer.instrumentId }],
    });
    expect(data.overlays).toHaveLength(1);
    expect(data.overlays[0]!.key).toBe('MSFT US Equity');
    expect(data.overlays[0]!.t).toHaveLength(env.sessions.length);
    expect(data.overlays[0]!.c[0]).toBeCloseTo(520, 6);
  });

  it('drops an overlay that does not resolve and still draws the primary', async () => {
    const body = await runGP(env.ids.equity.instrumentId, {
      ...VARIANT_PARAMS.equity,
      overlays: [{ ref: 'NOSUCH US Equity' }],
    });
    expect(body.data.overlays).toHaveLength(0);
    expect(body.data.primary.t).toHaveLength(env.sessions.length);
    expect(
      body.meta.unavailable.find((u) => u.field === 'overlays[0]')?.reason,
    ).toBe('NOT_APPLICABLE');
  });

  it('evaluates a formula overlay per date over the intersection of its leaves (CHRT-07)', async () => {
    const body = await runGP(env.ids.equity.instrumentId, {
      ...VARIANT_PARAMS.equity,
      overlays: [{ formula: 'RATIO(AAPL US Equity, MSFT US Equity)' }],
    });

    expect(body.data.overlays).toHaveLength(1);
    const overlay = body.data.overlays[0]!;
    expect(overlay.formula).not.toBeNull();
    expect(overlay.instrument).toBeNull();
    // A ratio has no open, high, low or volume — only a value per date.
    expect(overlay.o).toBeNull();
    expect(overlay.v).toBeNull();
    expect(overlay.t).toHaveLength(env.sessions.length);
    expect(overlay.c[0]).toBeCloseTo(330 / 520, 9);
    expect(body.meta.engines).toContainEqual(
      expect.objectContaining({ name: 'formula', version: '1.0.0' }),
    );
  });

  it('reports a formula that does not parse and keeps the chart', async () => {
    const body = await runGP(env.ids.equity.instrumentId, {
      ...VARIANT_PARAMS.equity,
      overlays: [{ formula: 'RATIO(' }],
    });
    expect(body.data.overlays).toHaveLength(0);
    expect(body.data.primary.t.length).toBeGreaterThan(0);
    expect(
      body.meta.unavailable.find((u) => u.field === 'overlays[0]')?.detail,
    ).toMatch(/^formula parse error: /);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Events and annotations
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('GP — event markers and annotations', () => {
  it('marks the dividend and the earnings filing, each with the command that explains it', async () => {
    const { data } = await runGP(env.ids.equity.instrumentId, VARIANT_PARAMS.equity);

    const dividend = data.events.find((e) => e.kind === 'dividend');
    expect(dividend).toBeDefined();
    expect(dividend!.t).toBe(Date.parse(`${DIVIDEND_DATE}T00:00:00.000Z`));
    expect(dividend!.label).toBe('$0.26');
    expect(dividend!.command).toBe('AAPL US Equity CACS');

    const earnings = data.events.find((e) => e.kind === 'earnings');
    expect(earnings).toBeDefined();
    expect(earnings!.t).toBe(Date.parse(`${EARNINGS_DATE}T00:00:00.000Z`));
    expect(earnings!.command).toBe('AAPL US Equity CF');

    // Ascending by time, so the chart draws them in the order it scans the axis.
    expect([...data.events].sort((a, b) => a.t - b.t)).toEqual(data.events);
    // No index membership was seeded, so there is nothing to add or drop.
    expect(data.events.some((e) => e.kind === 'index_add')).toBe(false);
  });

  it('omits the markers the caller switched off', async () => {
    const { data } = await runGP(env.ids.equity.instrumentId, {
      ...VARIANT_PARAMS.equity,
      events: { dividends: false, splits: false, earnings: false, filings: false },
    });
    expect(data.events).toHaveLength(0);
  });

  it('returns the viewer’s own annotation as editable', async () => {
    const { data } = await runGP(env.ids.equity.instrumentId, VARIANT_PARAMS.equity);
    expect(data.annotations).toHaveLength(1);
    expect(data.annotations[0]).toMatchObject({
      kind: 'hline',
      label: 'resistance',
      sharedScope: 'private',
      ownerUserId: env.userId,
      editable: true,
    });
    expect(data.annotations[0]!.anchors).toEqual([{ t: 0, v: 340 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Window, periodicity and CSV
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('GP — window and periodicity', () => {
  it('resolves `auto` to daily over a one-year range', async () => {
    const { data } = await runGP(env.ids.equity.instrumentId, { range: '1Y' });
    expect(data.window.periodicity).toBe('D');
    expect(data.window.end).toBe(AS_OF_DATE);
  });

  it('clamps an intraday periodicity asked for over a long range', async () => {
    const { data } = await runGP(env.ids.equity.instrumentId, { range: '1Y', periodicity: '5m' });
    // §GP step 1: intraday is limited to 5D; a longer range falls back to daily.
    expect(data.window.periodicity).toBe('D');
  });

  it('refuses a CUSTOM range with no start', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/GP/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { range: 'CUSTOM' },
        security: { id: env.ids.equity.instrumentId },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('GP — CSV parity', () => {
  it('exports one row per (bar, series) and then the event markers', async () => {
    const params = {
      ...VARIANT_PARAMS.equity,
      overlays: [{ id: env.ids.peer.instrumentId }],
    };
    const { data } = await runGP(env.ids.equity.instrumentId, params);
    const doc = toCsv(GP, data, GP.params.parse(params), {
      display: 'AAPL US Equity',
      asOf: GOLDEN_ISO,
      attribution: ['Yahoo Finance'],
    });

    expect(doc.columns.map((c) => c.id)).toEqual([
      't',
      'series',
      'open',
      'high',
      'low',
      'close',
      'volume',
      'currency',
      'adjust',
    ]);
    expect(doc.rows).toHaveLength(
      data.primary.t.length + data.overlays[0]!.t.length + data.events.length,
    );

    // The primary's block comes first, cell for cell.
    for (const [i, t] of data.primary.t.entries()) {
      expect(doc.rows[i], `bar ${String(i)}`).toEqual([
        new Date(t).toISOString().slice(0, 10),
        data.primary.key,
        data.primary.o![i],
        data.primary.h![i],
        data.primary.l![i],
        data.primary.c[i],
        data.primary.v![i],
        data.primary.currency,
        data.primary.adjust,
      ]);
    }

    // Then the overlay's, then the markers: one table, §1.6 rule 3.
    const overlayStart = data.primary.t.length;
    expect(doc.rows[overlayStart]![1]).toBe(data.overlays[0]!.key);

    const eventStart = overlayStart + data.overlays[0]!.t.length;
    const firstEvent = data.events[0]!;
    expect(doc.rows[eventStart]).toEqual([
      new Date(firstEvent.t).toISOString().slice(0, 10),
      'event',
      firstEvent.kind,
      firstEvent.label,
      firstEvent.command,
      null,
      null,
      null,
      null,
    ]);
    expect(doc.filename).toBe('GP_AAPL_US_Equity_CUSTOM_20260915T184128Z.csv');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Goldens
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('GP — goldens', () => {
  for (const variant of Object.keys(VARIANT_PARAMS) as GpVariant[]) {
    it(`${variant} deep-equals its committed golden at the frozen clock`, async () => {
      const seeded = env.ids[VARIANT_OF[variant]];
      const { data } = await runGP(seeded.instrumentId, VARIANT_PARAMS[variant]);
      expectGolden(`GP.${variant}.json`, normalise(data));
    });
  }
});

/**
 * Sequence-allocated ids become tokens: the goldens record the shape and the numbers, not which
 * row of `instruments` this run happened to draw.
 */
function normalise(payload: GpPayload): unknown {
  const ids = new Map<number, string>(
    Object.entries(env.ids).map(([name, seeded]) => [seeded.instrumentId, `<${name}>`]),
  );
  return JSON.parse(
    JSON.stringify(payload, (key: string, value: unknown) => {
      if (key === 'mdLineIds' && Array.isArray(value)) return `<${String(value.length)} md line(s)>`;
      if (key === 'annotationId') return '<annotationId>';
      if (key === 'ownerUserId') return '<ownerUserId>';
      if (typeof value === 'number' && ids.has(value)) return ids.get(value);
      // Only a subject string carries an id (`subjectToken`); substituting anywhere in any string
      // made the golden a function of the sequence values this run drew.
      if (typeof value === 'string') return subjectToken(value, ids);
      return value;
    }),
  );
}
