/**
 * `test/integration/functions/GIP.test.ts` — the intraday chart.
 *
 * Three things are worth a test here and the rest is plumbing:
 *
 *  1. **The forming bar is not a bar.** `bars` holds sealed minutes from `bars_intraday`; the
 *     minute still being traded comes from the plant's `b1m:` composite and lives in its own key.
 *     A screen that could not tell them apart would draw a provisional candle as a closed one,
 *     which is exactly what TERM-12 forbids. The tests below prove the separation from both sides:
 *     a `b1m:` state with `IS_FINAL:false` becomes `forming`, and one with `IS_FINAL:true` does
 *     not (it belongs in `bars`, and the store is where it will arrive).
 *  2. **VWAP is a quantity that sometimes does not exist.** An index has no share volume, so the
 *     answer is `null` with `NOT_APPLICABLE` — never zero, and never an array of `NaN` that a
 *     chart would draw as a line along the bottom of the pane.
 *  3. **`5D` forces `5m`.** The payload echoes the *effective* interval, so the CSV header and the
 *     bars it describes cannot disagree.
 *
 * The fixture is one synthetic equity with a full regular session of one-minute bars ending one
 * minute before the frozen clock, and one index with a quote and no bars at all. Both are written
 * inside this file's transaction: §0.7's seed instrument ids do not exist (WP-15 owns the seed).
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { expectGolden, idToken, subjectToken } from './golden.js';

import { FunctionRegistry, toCsv } from '@terminal/core';
import type { NormalisedUpdate, QuoteFields } from '@terminal/core';
import { XNAS } from '@terminal/core/calendars/nyse';
import { GIP } from '@terminal/core/functions/manifests/GIP';
import type { GipPayload } from '@terminal/core/functions/manifests/GIP';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as GIPModule from '../../../src/functions/GIP/resolve.js';
import { parseSubject } from '../../../src/plant/subjects.js';
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

const GOLDEN_NAME = 'GIP.intraday.json';

/** 13:30Z — the Nasdaq open on a non-DST-shifted September session. */
const SESSION_OPEN_MS = Date.parse(`${AS_OF_DATE}T13:30:00.000Z`);
/** The last **sealed** minute: 18:40Z, one minute before the frozen clock. */
const LAST_FINAL_MS = Date.parse(`${AS_OF_DATE}T18:40:00.000Z`);
/** The minute still being traded at the frozen clock. */
const FORMING_MS = Date.parse(`${AS_OF_DATE}T18:41:00.000Z`);
const MINUTE = 60_000;

const REGISTRY = new FunctionRegistry([GIP]);
 
const MODULES: Record<string, FunctionServerModule<any, any>> = { GIP: GIPModule };

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
  equity: Seeded;
  index: Seeded;
  /** The sealed one-minute bars, in seed order. */
  bars: { ts: number; open: number; high: number; low: number; close: number; volume: number }[];
  /** The 30 daily sessions behind `stats.pctOfAvgVolume30d`. */
  dailyVolumes: number[];
}

let env: Env;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function seedInstrument(spec: {
  ticker: string;
  name: string;
  assetClass: 'equity' | 'index';
  mic: string | null;
}): Promise<Seeded> {
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, 'internal.user', `gip-${spec.ticker}`);
  await bootstrapProvenance(t, 'yahoo.chart', `gip-src-${spec.ticker}`);
  const o = { validFrom: new Date('2020-01-01T00:00:00Z'), provenanceId };

  const issuerId = await repos.issuers.insert({ name: `${spec.name} issuer` }, o);
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: spec.assetClass,
      securityType: spec.assetClass === 'equity' ? 'Common Stock' : 'Index',
      name: spec.name,
      currency: 'USD',
    },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass: spec.assetClass,
      marketSector: spec.assetClass === 'equity' ? 'Equity' : 'Index',
      ticker: spec.ticker,
      exchCode: spec.assetClass === 'equity' ? 'US' : 'INDEX',
      name: spec.name,
      currency: 'USD',
    },
    o,
  );
  let listingId: number | undefined;
  if (spec.mic !== null) {
    listingId = await repos.listings.insert(
      {
        instrumentId,
        exchCode: 'UW',
        localTicker: spec.ticker,
        isPrimary: true,
        mic: spec.mic,
      },
      o,
    );
  }
  const { mdLineId } = await repos.mdLines.upsertBySymbol(
    {
      instrumentId,
      ...(listingId === undefined ? {} : { listingId }),
      sourceId: 'yahoo.chart',
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

function quote(
  seeded: Seeded,
  assetClass: 'equity' | 'index',
  provenanceId: number,
  fields: Partial<QuoteFields>,
  subject: 'q' | 'b1m' = 'q',
): NormalisedUpdate {
  return {
    subject: `${subject}:${String(seeded.instrumentId)}`,
    instrumentId: seeded.instrumentId,
    mdLineId: seeded.mdLineId,
    assetClass,
    tier: 'delayed',
    fields,
    ts: { src: GOLDEN_CAPTURE_MS - 900_000, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: { sourceId: 'yahoo.chart', provenanceId },
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
    [`GIP Firm ${randomUUID()}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'GIP User', 'user') RETURNING user_id`,
    [firmId, `gip-${randomUUID()}@demo.invalid`],
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

  const equity = await seedInstrument({
    ticker: 'AAPL',
    name: 'Apple Inc',
    assetClass: 'equity',
    mic: 'XNAS',
  });
  const index = await seedInstrument({
    ticker: 'SPX',
    name: 'S&P 500',
    assetClass: 'index',
    mic: 'XNAS',
  });

  const barProv = await bootstrapProvenance(t, 'yahoo.chart', 'gip-bars');

  // One regular session of sealed one-minute bars, on a deterministic ramp so VWAP is arithmetic.
  const bars: Env['bars'] = [];
  for (let ts = SESSION_OPEN_MS; ts <= LAST_FINAL_MS; ts += MINUTE) {
    const i = (ts - SESSION_OPEN_MS) / MINUTE;
    const close = Number((330 + i * 0.01).toFixed(6));
    bars.push({
      ts,
      open: Number((close - 0.02).toFixed(6)),
      high: Number((close + 0.03).toFixed(6)),
      low: Number((close - 0.04).toFixed(6)),
      close,
      volume: 1_000 + i,
    });
  }
  for (const chunk of chunked(bars, 200)) {
    await t.client.query(
      `INSERT INTO bars_intraday (instrument_id, bar_interval, bar_ts, md_line_id, open, high, low,
                                  close, volume, session, is_final, capture_ts, provenance_id)
       SELECT $1, '1m', b.bar_ts::timestamptz, $2, b.open::numeric, b.high::numeric, b.low::numeric,
              b.close::numeric, b.volume::bigint, 'regular', true, $3::timestamptz, $4
         FROM unnest($5::text[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::bigint[])
              AS b(bar_ts, open, high, low, close, volume)`,
      [
        equity.instrumentId,
        equity.mdLineId,
        GOLDEN_ISO,
        barProv,
        chunk.map((b) => new Date(b.ts).toISOString()),
        chunk.map((b) => b.open),
        chunk.map((b) => b.high),
        chunk.map((b) => b.low),
        chunk.map((b) => b.close),
        chunk.map((b) => b.volume),
      ],
    );
  }

  // Thirty daily sessions behind `% of 30-d average volume`.
  const dailyVolumes: number[] = [];
  const dailyDates: string[] = [];
  for (let i = 30; i >= 1; i -= 1) {
    const date = new Date(Date.parse(`${AS_OF_DATE}T00:00:00Z`) - i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    dailyDates.push(date);
    dailyVolumes.push(20_000_000 + i * 1_000);
  }
  await t.client.query(
    `INSERT INTO bars_daily (instrument_id, session_date, md_line_id, open, high, low, close,
                             volume, capture_ts, provenance_id)
     SELECT $1, d.session_date::date, $2, 330, 331, 329, 330, d.volume::bigint, $3::timestamptz, $4
       FROM unnest($5::text[], $6::bigint[]) AS d(session_date, volume)`,
    [equity.instrumentId, equity.mdLineId, GOLDEN_ISO, barProv, dailyDates, dailyVolumes],
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

  const lastBar = bars.at(-1)!;
  harness.deps.plant.apply(
    quote(equity, 'equity', barProv, {
      PX_LAST: 333.11,
      PX_OPEN: 330,
      PX_HIGH: 333.4,
      PX_LOW: 329.6,
      PX_VOLUME: 16_591_786,
      PX_CLOSE_1D: 331.02,
      CHG_NET_1D: 2.09,
      CHG_PCT_1D: 0.6314,
      SESSION_STATE: 'open',
    }),
  );
  // The minute still being traded: `IS_FINAL:false`, one interval after the last sealed bar.
  harness.deps.plant.apply(
    quote(
      equity,
      'equity',
      barProv,
      {
        BAR_TS: FORMING_MS,
        PX_OPEN: lastBar.close,
        PX_HIGH: 333.2,
        PX_LOW: lastBar.close,
        PX_LAST: 333.11,
        PX_VOLUME: 4_210,
        IS_FINAL: false,
      },
      'b1m',
    ),
  );
  harness.deps.plant.apply(
    quote(index, 'index', barProv, {
      PX_LAST: 7585.75,
      CHG_NET_1D: -34.23,
      CHG_PCT_1D: -0.4492,
      SESSION_STATE: 'open',
    }),
  );

  env = {
    harness,
    app: harness.app,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    knownAt,
    equity,
    index,
    bars,
    dailyVolumes,
  };
});

afterEach(async () => {
  await env.harness.close();
});

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push([...items.slice(i, i + size)]);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RunResult {
  data: GipPayload;
  meta: {
    provenance: { provenanceId: number; sourceId: string }[];
    unavailable: { field: string; reason: string; detail: string }[];
    engines: { name: string; version: string }[];
  };
}

async function runGIP(
  instrumentId: number,
  params: Record<string, unknown> = {},
): Promise<RunResult> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/GIP/run`,
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('GIP — sealed bars and the forming bar', () => {
  it('returns the session of sealed minutes with its session band', async () => {
    const { data } = await runGIP(env.equity.instrumentId);

    expect(data.variant).toBe('intraday');
    expect(data.interval).toBe('1m');
    expect(data.days).toBe(1);
    expect(data.tz).toBe('America/New_York');
    expect(data.calendarId).toBe('XNAS');

    expect(data.bars.t).toHaveLength(env.bars.length);
    expect(data.bars.t[0]).toBe(SESSION_OPEN_MS);
    expect(data.bars.t.at(-1)).toBe(LAST_FINAL_MS);
    expect(data.bars.c.at(-1)).toBeCloseTo(env.bars.at(-1)!.close, 6);
    expect(data.bars.o[0]).toBeCloseTo(env.bars[0]!.open, 6);
    expect(data.bars.v[0]).toBe(env.bars[0]!.volume);

    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]).toEqual({
      start: SESSION_OPEN_MS,
      // The band's exclusive end is one interval after the last bar.
      end: LAST_FINAL_MS + MINUTE,
      kind: 'regular',
      date: AS_OF_DATE,
    });
  });

  it('keeps the forming bar out of bars and in its own key', async () => {
    const { data } = await runGIP(env.equity.instrumentId);

    expect(data.bars.t).not.toContain(FORMING_MS);
    expect(data.forming).not.toBeNull();
    expect(data.forming!.t).toBe(FORMING_MS);
    expect(data.forming!.isFinal).toBe(false);
    expect(data.forming!.c).toBe(333.11);
    expect(data.forming!.v).toBe(4_210);
    expect(data.forming!.provIdx).toBeGreaterThanOrEqual(0);
  });

  it('drops the forming bar once the plant says the minute is sealed (TERM-12)', async () => {
    const provenanceId = await bootstrapProvenance(t, 'yahoo.chart', 'gip-sealed');
    env.harness.deps.plant.apply(
      quote(
        env.equity,
        'equity',
        provenanceId,
        { BAR_TS: FORMING_MS, PX_LAST: 333.11, IS_FINAL: true },
        'b1m',
      ),
    );
    const { data } = await runGIP(env.equity.instrumentId);
    expect(data.forming).toBeNull();
  });
});

describe('GIP — VWAP', () => {
  it('accumulates the volume-weighted price within the regular session', async () => {
    const body = await runGIP(env.equity.instrumentId);
    const vwap = body.data.vwap!;
    expect(vwap).toHaveLength(env.bars.length);

    // The first bar's VWAP is its own typical price; the last is the running average.
    const first = env.bars[0]!;
    expect(vwap[0]).toBeCloseTo((first.high + first.low + first.close) / 3, 9);

    let pv = 0;
    let volume = 0;
    for (const bar of env.bars) {
      pv += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
      volume += bar.volume;
    }
    expect(vwap.at(-1)).toBeCloseTo(pv / volume, 9);
    expect(body.data.stats.vwapNow.v).toBeCloseTo(pv / volume, 9);
    expect(body.meta.engines).toContainEqual(
      expect.objectContaining({ name: 'vwap', version: '1.0.0' }),
    );
  });

  it('is null with a reason for an instrument that has no volume', async () => {
    const body = await runGIP(env.index.instrumentId);
    expect(body.data.vwap).toBeNull();
    expect(body.meta.unavailable).toContainEqual({
      field: 'vwap',
      reason: 'NOT_APPLICABLE',
      detail: 'no volume for this instrument',
    });
  });

  it('is omitted entirely when the caller turns it off, and says why', async () => {
    const body = await runGIP(env.equity.instrumentId, { vwap: false });
    expect(body.data.vwap).toBeNull();
    expect(body.data.stats.vwapNow.v).toBeNull();
    expect(body.data.stats.vwapNow.st).toBe('na');
    expect(body.meta.unavailable).toContainEqual({
      field: 'vwap',
      reason: 'NOT_APPLICABLE',
      detail: 'VWAP is switched off for this chart (V toggles it)',
    });
  });
});

describe('GIP — statistics and the source line', () => {
  it('takes the header cells from the plant and marks them live', async () => {
    const { data } = await runGIP(env.equity.instrumentId);

    expect(data.stats.last.v).toBe(333.11);
    expect(data.stats.chgPct.v).toBe(0.6314);
    expect(data.stats.sessionState.v).toBe('open');
    expect(data.prevClose.v).toBe(331.02);
    for (const cell of [data.stats.last, data.stats.open, data.prevClose]) {
      expect(cell.live?.subject).toBe(`q:${String(env.equity.instrumentId)}`);
    }
  });

  it('computes % of the 30-day average volume from the daily bars', async () => {
    const { data } = await runGIP(env.equity.instrumentId);
    const average = env.dailyVolumes.reduce((a, b) => a + b, 0) / env.dailyVolumes.length;
    expect(data.stats.pctOfAvgVolume30d.v).toBeCloseTo((16_591_786 / average) * 100, 6);
  });

  it('says which line feeds the chart, with its intrinsic delay', async () => {
    const { data } = await runGIP(env.equity.instrumentId);
    expect(data.sourceLine).toEqual({
      mdLineId: env.equity.mdLineId,
      sourceId: 'yahoo.chart',
      providerSymbol: 'AAPL',
      intrinsicDelayMin: 15,
    });
  });

  it('reports no bars, rather than an empty chart, for a security with none', async () => {
    const body = await runGIP(env.index.instrumentId);
    expect(body.data.bars.t).toHaveLength(0);
    expect(body.meta.unavailable).toContainEqual({
      field: 'bars',
      reason: 'NO_SOURCE',
      detail: 'no intraday bars in window (holiday or provider outage)',
    });
  });
});

describe('GIP — params and live', () => {
  it('forces 5m over five days and echoes the effective interval', async () => {
    const { data } = await runGIP(env.equity.instrumentId, { days: '5', interval: '1m' });
    expect(data.days).toBe(5);
    expect(data.interval).toBe('5m');
    // The fixture only holds 1m bars, so the five-day 5m window is legitimately empty.
    expect(data.bars.t).toHaveLength(0);
  });

  it('declares a LiveSpec over the q: and b1m: subjects of the loaded security', async () => {
    const { data } = await runGIP(env.equity.instrumentId);
    const live = GIP.live!(GIP.params.parse({}), data)!;

    expect(live.subjects).toEqual([
      `b1m:${String(env.equity.instrumentId)}`,
      `q:${String(env.equity.instrumentId)}`,
    ]);
    for (const subject of live.subjects) {
      expect(parseSubject(subject), subject).not.toBeNull();
    }
    expect(live.conflationMs).toBe(250);
    expect(live.essential).toEqual([`q:${String(env.equity.instrumentId)}`]);
    expect(live.fields).toContain('IS_FINAL');
  });
});

describe('GIP — CSV parity', () => {
  it('exports one row per sealed bar and the forming bar last', async () => {
    const { data } = await runGIP(env.equity.instrumentId);
    const doc = toCsv(GIP, data, GIP.params.parse({}), {
      display: 'AAPL US Equity',
      asOf: GOLDEN_ISO,
      attribution: ['Yahoo Finance'],
    });

    expect(doc.columns.map((c) => c.id)).toEqual([
      't',
      'open',
      'high',
      'low',
      'close',
      'volume',
      'vwap',
      'session',
    ]);
    expect(doc.rows).toHaveLength(data.bars.t.length + 1);

    for (const [i] of data.bars.t.entries()) {
      expect(doc.rows[i], `bar ${String(i)}`).toEqual([
        new Date(data.bars.t[i]!).toISOString().replace('.000Z', 'Z'),
        data.bars.o[i],
        data.bars.h[i],
        data.bars.l[i],
        data.bars.c[i],
        data.bars.v[i],
        data.vwap![i],
        'regular',
      ]);
    }

    const last = doc.rows.at(-1)!;
    expect(last[0]).toBe(new Date(FORMING_MS).toISOString().replace('.000Z', 'Z'));
    expect(last[4]).toBe(data.forming!.c);
    expect(last[7]).toBe('forming');
    expect(doc.filename).toBe('GIP_AAPL_US_Equity_1D1m_20260915T184128Z.csv');
  });
});

describe('GIP — golden', () => {
  it('deep-equals the committed golden at the frozen clock', async () => {
    const { data } = await runGIP(env.equity.instrumentId);
    expectGolden(GOLDEN_NAME, normalise(data));
  });
});

/**
 * Sequence-allocated ids are replaced by tokens; everything else is compared as served.
 *
 * The one key in a GIP payload that holds an instrument id (`mdLineId` and `mdLineIds` have their
 * own branches below, and `calendarId` is `'XNAS'` — a name, not a sequence value).
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId']);

function normalise(payload: GipPayload): unknown {
  const id = env.equity.instrumentId;
  const mdLineId = env.equity.mdLineId;
  const tokens = new Map([[id, '<AAPL>']]);
  return JSON.parse(
    JSON.stringify(payload, (key: string, value: unknown) => {
      if (key === 'mdLineIds' && Array.isArray(value)) return `<${String(value.length)} md line(s)>`;
      if (key === 'mdLineId' && value === mdLineId) return '<mdLine>';
      if (typeof value === 'string') return subjectToken(value, tokens);
      // An intraday payload is a series of bars: opens, highs, lows, closes, volumes and bar
      // counts. An id is an id because of the key it sits under, never because a bar happens to
      // print at the number the instrument sequence drew.
      return idToken(key, value, ID_KEYS, tokens);
    }),
  );
}
