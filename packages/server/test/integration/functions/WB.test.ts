/**
 * `test/integration/functions/WB.test.ts` — WP-10's `WB` row ("non-US tenors; where a tenor has no
 * source, it is unavailable with a reason, never interpolated silently").
 *
 * The sixteen-country table is a constant of the manifest, so the interesting axis is not how many
 * rows come back — it is **how many different ways a row can have no number**, and whether each of
 * them says which one it is. This file seeds one of each:
 *
 * | country | what is seeded                        | the row says                    |
 * | ------- | ------------------------------------- | ------------------------------- |
 * | `US`    | the Treasury par curve, daily         | a yield, `frequency:'D'`, `lagDays` |
 * | `DE`    | an OECD series with observations      | a yield, `frequency:'M'`, a 45-day lag |
 * | `JP`    | the same, one observation             | a yield with no 1M comparison   |
 * | `GB`    | the same                              | a yield                         |
 * | `CA`    | an `econ_series` row, no observations | `NO_RECORDED_FIXTURE`           |
 * | others  | nothing                               | `NO_SERIES_SEEDED`              |
 *
 * And on the 2Y and 30Y tabs, every non-US row is `NO_OECD_SERIES_FOR_TENOR`: the OECD long-term
 * interest rate is a ten-year benchmark, and the one failure this screen must never have is
 * showing that ten-year number under a thirty-year heading. Nothing is interpolated, carried
 * forward from the previous month, or borrowed from a neighbouring country.
 *
 * `lagDays` is asserted on every populated row, because it is the screen's statement that a
 * monthly OECD print from five weeks ago is not today's market — the spread column mixes the two
 * and would be misread without it.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NormalisedUpdate, PayloadMeta, QuoteFields } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { WB } from '@terminal/core/functions/manifests/WB';
import type { WbCountryRow, WbPayload } from '@terminal/core/functions/manifests/WB';

import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as WBModule from '../../../src/functions/WB/resolve.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, createWebSession, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';
import { expectGolden, idToken, subjectToken } from './golden.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = new Date('2020-01-01T00:00:00Z');
const GOLDEN_NAME = 'WB.default.json';

const SYMBOL_TAG = `.t${randomUUID().slice(0, 8)}`;

const CURVE_DATE = '2026-09-11';
const PREVIOUS_CURVE_DATE = '2026-09-10';
const MONTH_AGO_CURVE_DATE = '2026-08-11';
const VINTAGE = '2026-09-15T10:00:00.000Z';

const REGISTRY = new FunctionRegistry([WB]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { WB: WBModule };

const t: TestDb = withTxDb();

/** `[tenor, tenorDays, 2026-09-11, 2026-09-10, 2026-08-11]`. */
const PAR_POINTS: readonly [string, number, number, number, number][] = [
  ['2Y', 730, 3.76, 3.74, 3.69],
  ['10Y', 3653, 4.07, 4.03, 3.95],
  ['30Y', 10958, 4.66, 4.62, 4.55],
];

/** `[iso, providerCode, name, observations]` — the OECD long-term rate, monthly. */
const SERIES: readonly [string, string, string, [string, number][]][] = [
  [
    'DE',
    'IRLTLT01DEM156N',
    'Long-Term Government Bond Yields: 10-year: Germany',
    [
      ['2026-06-01', 2.55],
      ['2026-07-01', 2.61],
      ['2026-08-01', 2.68],
    ],
  ],
  ['JP', 'IRLTLT01JPM156N', 'Long-Term Government Bond Yields: 10-year: Japan', [['2026-08-01', 1.42]]],
  [
    'GB',
    'IRLTLT01GBM156N',
    'Long-Term Government Bond Yields: 10-year: United Kingdom',
    [
      ['2026-07-01', 4.25],
      ['2026-08-01', 4.31],
    ],
  ],
  // Canada has a series row and no recorded observation: the replay wall, stated as a reason.
  ['CA', 'IRLTLT01CAM156N', 'Long-Term Government Bond Yields: 10-year: Canada', []],
];

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  tnxId: number;
  seriesCodes: Record<string, string>;
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

async function seedTnx(): Promise<{ instrumentId: number; mdLineId: number }> {
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, 'internal.user', 'wb-tnx');
  await bootstrapProvenance(t, 'yahoo.chart', 'wb-tnx-src');
  const o = { validFrom: VALID_FROM, provenanceId };
  const issuerId = await repos.issuers.insert({ name: 'Cboe Global Markets' }, o);
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: 'index',
      securityType: 'Index',
      name: 'Cboe 10-Year Treasury Note Yield Index',
      currency: 'USD',
    },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass: 'index',
      marketSector: 'Index',
      ticker: 'TNX',
      exchCode: 'INDEX',
      name: 'Cboe 10-Year Treasury Note Yield Index',
      currency: 'USD',
      searchWeight: 40,
    },
    o,
  );
  const { mdLineId } = await repos.mdLines.upsertBySymbol(
    {
      instrumentId,
      sourceId: 'yahoo.chart',
      providerSymbol: `^TNX${SYMBOL_TAG}`,
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 10_000,
      priority: 10,
    },
    o,
  );
  return { instrumentId, mdLineId };
}

beforeEach(async () => {
  await ensureLicences();
  const session = await createWebSession(t, { email: `wb-${randomUUID()}@demo.invalid` });
  await grantEverySource(session.firmId, session.userId);

  // ── the US par curve ──────────────────────────────────────────────────────────────────────
  const parProv = await bootstrapProvenance(t, 'treasury.yieldcurve', 'wb-par');
  await t.client.query(
    `INSERT INTO curves (curve_id, name, currency, kind, day_count, compounding, source_id,
                         default_interpolation)
     VALUES ('UST_PAR', 'US Treasury par yield curve', 'USD', 'par', 'ACT/ACT', 'semiannual',
             'treasury.yieldcurve', 'monotone_convex')
     ON CONFLICT (curve_id) DO NOTHING`,
  );
  for (const [tenor, tenorDays, today, yesterday, monthAgo] of PAR_POINTS) {
    for (const [curveDate, value] of [
      [CURVE_DATE, today],
      [PREVIOUS_CURVE_DATE, yesterday],
      [MONTH_AGO_CURVE_DATE, monthAgo],
    ] as const) {
      await t.client.query(
        `INSERT INTO curve_points (curve_id, curve_date, tenor, quote_type, vintage_at, tenor_days,
                                   value, is_latest, provenance_id)
         VALUES ('UST_PAR', $1::date, $2, 'par_yield', $3::timestamptz, $4, $5, true, $6)`,
        [curveDate, tenor, VINTAGE, tenorDays, value, parProv],
      );
    }
  }

  // ── the OECD series ───────────────────────────────────────────────────────────────────────
  const fredProv = await bootstrapProvenance(t, 'fred.csv', 'wb-fred');
  const seriesCodes: Record<string, string> = {};
  for (const [iso, providerCode, name, observations] of SERIES) {
    const code = `${providerCode}.${randomUUID().slice(0, 6)}`;
    seriesCodes[iso] = code;
    const res = await t.client.query<{ series_id: string }>(
      `INSERT INTO econ_series (series_code, source_id, provider_code, name, units, frequency,
                                seasonal_adj, country, decimals, first_obs_date, last_obs_date,
                                last_updated_at)
       VALUES ($1, 'fred.csv', $2, $3, 'Percent', 'M', NULL, $4, 2, date '2000-01-01', $5::date, $6::timestamptz)
       RETURNING series_id`,
      [
        code,
        providerCode,
        name,
        iso,
        observations[observations.length - 1]?.[0] ?? null,
        // Canada's row is stale on purpose: the resolver attempts a `fred.series` read-through,
        // the replay store has no recorded response for it, and the row states the gap.
        observations.length === 0 ? '2026-09-01T00:00:00Z' : '2026-09-15T18:00:00Z',
      ],
    );
    const seriesId = Number(res.rows[0]!.series_id);
    for (const [obsDate, value] of observations) {
      await t.client.query(
        `INSERT INTO econ_observations (series_id, obs_date, vintage_at, value, status, is_latest,
                                        provenance_id)
         VALUES ($1, $2::date, $3::timestamptz, $4, 'final', true, $5)`,
        [seriesId, obsDate, `${obsDate}T13:00:00Z`, value, fredProv],
      );
    }
  }

  const tnx = await seedTnx();

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };

  const yahooProv = await bootstrapProvenance(t, 'yahoo.chart', 'wb-yahoo');
  const update: NormalisedUpdate = {
    subject: `q:${String(tnx.instrumentId)}`,
    instrumentId: tnx.instrumentId,
    mdLineId: tnx.mdLineId,
    assetClass: 'index',
    tier: 'delayed',
    fields: { PX_LAST: 4.99, CHG_NET_1D: 0.039, CHG_PCT_1D: 0.7876 } satisfies Partial<QuoteFields>,
    ts: { src: GOLDEN_CAPTURE_MS - 900_000, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: { sourceId: 'yahoo.chart', provenanceId: yahooProv },
  };
  harness.deps.plant.apply(update);

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: session.cookie,
    knownAt,
    tnxId: tnx.instrumentId,
    seriesCodes,
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: WbPayload;
  meta: PayloadMeta;
}

async function runWB(params: Record<string, unknown> = {}): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/WB/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

function rowOf(payload: WbPayload, iso: string): WbCountryRow {
  const row = payload.rows.find((r) => r.iso === iso);
  expect(row, `${iso} is missing from the payload`).toBeDefined();
  return row!;
}

/**
 * The one key in a WB payload that holds a sequence-allocated id: the US 10-year's `instrumentId`.
 * `curveId` (`'UST_PAR'`), `fieldId` (`'CRV_2Y'`) and `sourceId` (`'treasury.yieldcurve'`) are
 * names, and `seriesCode` is tokenised by the code map below.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId']);

function normalise(payload: WbPayload): unknown {
  const tokens = new Map<number, string>([[env.tnxId, '<TNX>']]);
  const codes = new Map(Object.entries(env.seriesCodes).map(([iso, code]) => [code, `<${iso}>`]));
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (typeof value === 'string') {
      const code = codes.get(value);
      if (code !== undefined) return code;
      if (value.startsWith('e:')) {
        const mapped = codes.get(value.slice(2));
        if (mapped !== undefined) return `e:${mapped}`;
      }
      return subjectToken(value, tokens);
    }
    // Sixteen sovereign yields, their 1D/1W/1M/YTD changes in basis points and a US par curve: a
    // table of numbers, matched by the key they sit under rather than by what they equal.
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

describe('WB — the sixteen-market table', () => {
  it('returns every country of the manifest table, grouped by region', async () => {
    const { data } = await runWB();
    expect(data.variant).toBe('default');
    expect(data.tenor).toBe('10Y');
    expect(data.rows).toHaveLength(16);
    expect(data.rows.map((r) => r.iso).slice(0, 4)).toEqual(['US', 'CA', 'MX', 'BR']);
    expect(data.regions).toEqual([
      { region: 'AMERICAS', count: 4, withData: 1 },
      // DE and GB have observations; FR, IT, ES, CH, SE and NO have no series at all.
      { region: 'EMEA', count: 8, withData: 2 },
      { region: 'APAC', count: 4, withData: 1 },
    ]);
    expect(data.notes).toContain('OECD_MONTHLY_LAG');
    expect(data.notes).toContain('NO_NON_US_INTRADAY');
  });

  it('serves the US row and block from the Treasury par curve', async () => {
    const { data } = await runWB();
    expect(data.us.curveDate).toBe(CURVE_DATE);
    expect(data.us.points.map((p) => p.tenor)).toEqual(['2Y', '10Y', '30Y']);
    expect(data.us.points.map((p) => p.value.v)).toEqual([3.76, 4.07, 4.66]);
    expect(data.us.points.map((p) => p.chgBp.v)).toEqual([2, 4, 4]);

    const us = rowOf(data, 'US');
    expect(us.yield.v).toBe(4.07);
    expect(us.frequency).toBe('D');
    expect(us.sourceId).toBe('treasury.yieldcurve');
    expect(us.asOfDate).toBe(CURVE_DATE);
    expect(us.lagDays).toBe(4);
    expect(us.chgBp.v).toBe(4);
    expect(us.spreadBp.v).toBe(0);
    expect(us.curve.t2y.v).toBe(3.76);
    expect(us.curve.t10y.v).toBe(4.07);
    expect(us.curve.t30y.v).toBe(4.66);
    expect(us.unavailableReason).toBeNull();
    // The Cboe ten-year yield index is the only intraday yield in the reachable source set.
    expect(us.subject).toBe(`q:${String(env.tnxId)}`);
  });

  it('carries the Cboe ten-year yield index as the US intraday proxy', async () => {
    const { data } = await runWB();
    expect(data.us.intraday).not.toBeNull();
    expect(data.us.intraday!.key).toBe('TNX Index');
    expect(data.us.intraday!.cells.PX_LAST!.v).toBe(4.99);
    expect(data.us.intraday!.cells.PX_LAST!.live).toEqual({
      subject: data.us.intraday!.subject,
      field: 'PX_LAST',
    });
  });

  it('labels an OECD row as monthly, with its own as-of date and lag', async () => {
    const { data } = await runWB();
    const de = rowOf(data, 'DE');
    expect(de.yield.v).toBe(2.68);
    expect(de.frequency).toBe('M');
    expect(de.sourceId).toBe('fred.csv');
    expect(de.seriesCode).toBe(env.seriesCodes.DE);
    expect(de.subject).toBe(`e:${env.seriesCodes.DE ?? ''}`);
    expect(de.asOfDate).toBe('2026-08-01');
    // 45 calendar days between the print and the as-of: never rendered as today's market.
    expect(de.lagDays).toBe(45);
    expect(de.unavailableReason).toBeNull();
    expect(de.yield.provIdx).toBeGreaterThanOrEqual(0);

    // The spread mixes a daily US par yield with a monthly OECD print; both dates are on the row.
    expect(de.spreadBp.v).toBe(-139);
    expect(rowOf(data, 'JP').spreadBp.v).toBe(-265);
    expect(rowOf(data, 'GB').spreadBp.v).toBe(24);
  });

  it('refuses a one-day change on a monthly series', async () => {
    const { data, meta } = await runWB();
    const de = rowOf(data, 'DE');
    expect(data.chgWindow).toBe('1D');
    expect(de.chgBp.v).toBeNull();
    expect(de.chgBp.st).toBe('na');
    const note = meta.unavailable.find((u) => u.field === 'chgBp.DE');
    expect(note).toMatchObject({ reason: 'NOT_APPLICABLE' });
    expect(note!.detail).toContain('OECD_MONTHLY_LAG');
  });

  it('computes a one-month change from the observation a month back', async () => {
    const { data, meta } = await runWB({ chgWindow: '1M' });
    // 2.68 − 2.61 = +7.0 bp, from the 2026-07-01 observation.
    expect(rowOf(data, 'DE').chgBp.v).toBe(7);
    expect(rowOf(data, 'GB').chgBp.v).toBe(6);
    // Japan has one observation only: there is nothing a month back, and the row says so.
    expect(rowOf(data, 'JP').chgBp.v).toBeNull();
    const note = meta.unavailable.find((u) => u.field === 'chgBp.JP');
    expect(note).toMatchObject({ reason: 'NO_SOURCE' });

    // The US compares against the newest curve date a month back, not the previous one.
    expect(rowOf(data, 'US').chgBp.v).toBe(12);
  });

  it('never interpolates: each empty row names the reason it is empty', async () => {
    const { data, meta } = await runWB();

    // A seeded series with no recorded observation is the replay wall, not a missing country.
    const ca = rowOf(data, 'CA');
    expect(ca.yield.v).toBeNull();
    expect(ca.unavailableReason).toBe('NO_RECORDED_FIXTURE');
    expect(ca.seriesCode).toBe(env.seriesCodes.CA);
    expect(ca.frequency).toBe('M');
    expect(ca.sourceId).toBe('fred.csv');
    expect(ca.lagDays).toBeNull();
    const caNote = meta.unavailable.find((u) => u.field === 'yield.CA');
    expect(caNote!.detail).toContain('NO_RECORDED_FIXTURE');
    expect(caNote!.detail).toContain('IRLTLT01CAM156N');
    expect(data.notes).toContain('NO_RECORDED_FIXTURE');

    // No `econ_series` row at all is a different fact and gets a different reason.
    const fr = rowOf(data, 'FR');
    expect(fr.yield.v).toBeNull();
    expect(fr.unavailableReason).toBe('NO_SERIES_SEEDED');
    expect(fr.seriesCode).toBeNull();
    expect(fr.sourceId).toBeNull();
    const frNote = meta.unavailable.find((u) => u.field === 'yield.FR');
    expect(frNote!.detail).toContain('NO_SERIES_SEEDED');

    // And nobody borrowed Germany's number.
    for (const iso of ['FR', 'IT', 'ES', 'CH', 'SE', 'NO', 'MX', 'BR', 'AU', 'NZ', 'KR']) {
      expect(rowOf(data, iso).yield.v, iso).toBeNull();
      expect(rowOf(data, iso).spreadBp.v, iso).toBeNull();
    }
  });

  it('makes the 2Y and 30Y tabs a US-only view rather than showing the ten-year twice', async () => {
    for (const tenor of ['2Y', '30Y'] as const) {
      const { data, meta } = await runWB({ tenor });
      const us = rowOf(data, 'US');
      expect(us.yield.v).toBe(tenor === '2Y' ? 3.76 : 4.66);
      expect(us.tenor).toBe(tenor);

      const de = rowOf(data, 'DE');
      expect(de.tenor).toBe(tenor);
      expect(de.yield.v).toBeNull();
      expect(de.yield.st).toBe('na');
      expect(de.unavailableReason).toBe('NO_OECD_SERIES_FOR_TENOR');
      // The ten-year value exists in the store and is deliberately not shown here.
      expect(de.yield.v).not.toBe(2.68);

      const note = meta.unavailable.find((u) => u.field === 'yield.DE');
      expect(note).toMatchObject({ reason: 'NO_SOURCE' });
      expect(note!.detail).toContain('NO_OECD_SERIES_FOR_TENOR');
      expect(data.regions.map((r) => r.withData)).toEqual([1, 0, 0]);
    }
  });

  it('says the non-US curve columns have no source instead of leaving them blank', async () => {
    const { data, meta } = await runWB();
    const jp = rowOf(data, 'JP');
    for (const cell of [jp.curve.t2y, jp.curve.t10y, jp.curve.t30y]) {
      expect(cell.v).toBeNull();
      expect(cell.st).toBe('na');
    }
    const note = meta.unavailable.find((u) => u.field === 'curve.JP');
    expect(note).toMatchObject({ reason: 'NO_SOURCE' });
    expect(note!.detail).toContain('only the US publishes a full par curve');
  });

  it('drops the spread column on SPR=NONE', async () => {
    const { data } = await runWB({ spreadTo: 'NONE' });
    expect(data.spreadTo).toBe('NONE');
    expect(data.rows.every((r) => r.spreadBp.v === null)).toBe(true);
    // The yields are untouched.
    expect(rowOf(data, 'DE').yield.v).toBe(2.68);
  });

  it('sinks a market with no source to the bottom instead of sorting it as zero', async () => {
    const { data } = await runWB({ sort: 'yield' });
    const isos = data.rows.map((r) => r.iso);
    const values = data.rows.map((r) => r.yield.v);
    // Descending by yield: the UK's 4.31 is above the US 10Y par at 4.07.
    expect(isos.slice(0, 4)).toEqual(['GB', 'US', 'DE', 'JP']);
    expect(values.slice(0, 4)).toEqual([4.31, 4.07, 2.68, 1.42]);
    // Everything after the fourth row has no value at all, and none of them sorted above Japan.
    expect(data.rows.slice(4).every((r) => r.yield.v === null)).toBe(true);
  });

  it('filters by region before it queries anything', async () => {
    const { data } = await runWB({ region: 'APAC' });
    expect(data.rows.map((r) => r.iso)).toEqual(['JP', 'AU', 'NZ', 'KR']);
    expect(data.regions).toEqual([{ region: 'APAC', count: 4, withData: 1 }]);
    // With no US row in the table there is nothing to spread against, honestly reported.
    expect(data.rows.every((r) => r.spreadBp.v === null)).toBe(true);
  });

  it('matches the committed golden', async () => {
    const { data } = await runWB();
    expectGolden(GOLDEN_NAME, normalise(data));
  });
});
