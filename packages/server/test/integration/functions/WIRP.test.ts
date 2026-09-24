/**
 * `test/integration/functions/WIRP.test.ts` — WP-11's acceptance row for `WIRP`
 * ("probabilities sum to 1 per meeting; the path is flat when the curve is flat").
 *
 * Both halves of that row are about the same failure mode from two directions. A policy-path
 * screen goes wrong quietly: the arithmetic is small, every intermediate is plausible, and a sign
 * or an off-by-one in the meeting index produces a curve that still looks like a policy path. So:
 *
 *  1. **The allocation is a probability distribution or it is nothing.** `Σ outcomes[].probPct`
 *     must be exactly 100 for every meeting — not "about 100". A two-point allocation that does
 *     not sum to one is not a reading of the implied step, it is two unrelated numbers next to a
 *     percent sign.
 *  2. **A flat curve implies a flat path.** This is the degenerate case, and it is constructed so
 *     that the *reading convention* cannot manufacture a slope: the FOMC dates are spaced exactly
 *     42 days apart and the curve has a single interpolation segment spanning all of them, so
 *     every inter-meeting simple ACT/360 forward is read over an interval of identical length. The
 *     implied rate is then **exactly** equal at every meeting — bit for bit — and any sign error,
 *     index shift or anchor mistake breaks it. (A flat *par* OIS curve does not give an exactly
 *     constant simple forward over unequal windows: within one log-linear-`df` segment the simple
 *     forward over a window of length Δ is `(e^{fΔ} − 1)/Δ`, which moves with Δ. Equal windows is
 *     what makes the assertion exact rather than a tolerance, and the level assertion below keeps
 *     a 2 bp tolerance for exactly that convexity.)
 *
 * The rest of the file pins the three things §WIRP says must never happen: no synthetic meeting
 * date is invented at the horizon, a past meeting never carries a model rate, and a payload with
 * no EFFR target range blanks the target-anchored cells while leaving the curve-derived ones.
 *
 * No seed is assumed and nothing asserts on a literal instrument id (WP-15 owns the seed): every
 * row lives inside `withTxDb()`'s transaction.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PayloadMeta } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { SIFMA } from '@terminal/core/calendars/sifma';
import { WIRP } from '@terminal/core/functions/manifests/WIRP';
import type { WirpMeeting, WirpPayload } from '@terminal/core/functions/manifests/WIRP';

import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as WIRPModule from '../../../src/functions/WIRP/resolve.js';
import { materialiseCalendar } from '../../../src/refdata/calendars.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, createWebSession, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';
import { expectGolden, idToken } from './golden.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VINTAGE = '2026-09-15T10:00:00.000Z';
const GOLDEN_NAME = 'WIRP.default.json';

const REGISTRY = new FunctionRegistry([WIRP]);
 
const MODULES: Record<string, FunctionServerModule<any, any>> = { WIRP: WIRPModule };

const t: TestDb = withTxDb();

/** The morning this file seeds: Monday 2026-09-14's fixings, the same day's OIS curve. */
const CURVE_DATE = '2026-09-14';
/** Five paired EFFR/SOFR business days, 2026-09-08 … 2026-09-14 (09-12/13 are the weekend). */
const PAIRED: readonly [string, number, number][] = [
  ['2026-09-08', 3.63, 3.62],
  ['2026-09-09', 3.63, 3.62],
  ['2026-09-10', 3.64, 3.63],
  ['2026-09-11', 3.63, 3.62],
  ['2026-09-14', 3.63, 3.62],
];

/** The 2026 FOMC calendar: five decided meetings and three scheduled ones at the frozen clock. */
const FOMC_2026: readonly [string, boolean, number | null][] = [
  ['2026-01-28', true, 0],
  ['2026-03-18', true, -25],
  ['2026-04-29', false, 0],
  ['2026-06-17', true, -25],
  ['2026-07-29', false, -25],
  ['2026-09-16', true, null],
  ['2026-10-28', false, null],
  ['2026-12-09', true, null],
];

/**
 * A downward-sloping money-market curve: the front implies cuts. `[tenor, days, percent]`.
 *
 * **Whole years only.** `curve.ois.bootstrap` schedules each quote as an annual-pay OIS and throws
 * `'<tenor> is not a whole number of 1/yr fixed periods'` on anything shorter, so a `1M`/`3M`/`6M`
 * `ois_rate` point is not a curve input this build can consume — it is a 500. The slope through
 * the first year comes from `monotone_convex`, which fits a continuous forward between the
 * overnight anchor and the 1Y node rather than holding it flat.
 */
const OIS_QUOTES: readonly [string, number, number][] = [
  ['1Y', 365, 3.42],
  ['2Y', 730, 3.38],
  ['3Y', 1096, 3.4],
  ['5Y', 1826, 3.45],
  ['10Y', 3653, 3.7],
];

const ON_FIXING_PCT = 3.62;

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  oisProvenanceId: number;
  fomcProvenanceId: number;
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

async function seedFixing(
  spec: {
    code: string;
    effectiveDate: string;
    rate: number | null;
    target?: [number, number];
  },
  provenanceId: number,
): Promise<void> {
  await t.client.query(
    `INSERT INTO rate_fixings (rate_code, effective_date, vintage_at, rate, target_from, target_to,
                               revision_indicator, is_latest, provenance_id)
     VALUES ($1, $2::date, $3::timestamptz, $4, $5, $6, '', true, $7)`,
    [
      spec.code,
      spec.effectiveDate,
      VINTAGE,
      spec.rate,
      spec.target?.[0] ?? null,
      spec.target?.[1] ?? null,
      provenanceId,
    ],
  );
}

async function seedCurveRow(spec: { interpolation: string }): Promise<void> {
  await t.client.query(
    `INSERT INTO curves (curve_id, name, currency, kind, day_count, compounding, source_id,
                         default_interpolation)
     VALUES ('SOFR_OIS', 'USD SOFR OIS (proxied)', 'USD', 'ois', 'ACT/360', 'simple',
             'internal.derived', $1)
     ON CONFLICT (curve_id) DO UPDATE SET default_interpolation = EXCLUDED.default_interpolation`,
    [spec.interpolation],
  );
}

async function seedPoint(spec: {
  curveDate: string;
  tenor: string;
  tenorDays: number;
  quoteType: string;
  value: number;
  provenanceId: number;
}): Promise<void> {
  await t.client.query(
    `INSERT INTO curve_points (curve_id, curve_date, tenor, quote_type, vintage_at, tenor_days,
                               value, is_latest, provenance_id)
     VALUES ('SOFR_OIS', $1::date, $2, $3, $4::timestamptz, $5, $6, true, $7)`,
    [spec.curveDate, spec.tenor, spec.quoteType, VINTAGE, spec.tenorDays, spec.value, spec.provenanceId],
  );
}

async function seedMeetings(
  rows: readonly [string, boolean, number | null][],
  provenanceId: number,
): Promise<void> {
  for (const [date, hasSep, decisionBp] of rows) {
    await t.client.query(
      `INSERT INTO fomc_meetings (meeting_date, statement_at, has_sep, decision_bp, provenance_id)
       VALUES ($1::date, ($1 || 'T18:00:00Z')::timestamptz, $2, $3, $4)
       ON CONFLICT (meeting_date) DO NOTHING`,
      [date, hasSep, decisionBp, provenanceId],
    );
  }
}

beforeEach(async () => {
  await ensureLicences();
  await materialiseCalendar(t.db, SIFMA, { fromYear: 2026, toYear: 2027 });

  const session = await createWebSession(t, { email: `wirp-${randomUUID()}@demo.invalid` });
  await grantEverySource(session.firmId, session.userId);

  const nyfedProv = await bootstrapProvenance(t, 'nyfed.rates', 'wirp-nyfed');
  for (const [date, effr, sofr] of PAIRED) {
    await seedFixing({ code: 'EFFR', effectiveDate: date, rate: effr, target: [3.5, 3.75] }, nyfedProv);
    await seedFixing({ code: 'SOFR', effectiveDate: date, rate: sofr }, nyfedProv);
  }

  const oisProv = await bootstrapProvenance(t, 'internal.derived', 'wirp-ois');
  const fomcProv = await bootstrapProvenance(t, 'fed.fomc', 'wirp-fomc');
  await seedMeetings(FOMC_2026, fomcProv);

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
    clock,
    cookie: session.cookie,
    knownAt,
    oisProvenanceId: oisProv,
    fomcProvenanceId: fomcProv,
  };
});

afterEach(async () => {
  await env.harness.close();
});

/** The realistic curve: an overnight anchor and six par OIS quotes, monotone convex. */
async function seedSlopedCurve(): Promise<void> {
  await seedCurveRow({ interpolation: 'monotone_convex' });
  await seedPoint({
    curveDate: CURVE_DATE,
    tenor: 'ON',
    tenorDays: 1,
    quoteType: 'fixing',
    value: ON_FIXING_PCT,
    provenanceId: env.oisProvenanceId,
  });
  for (const [tenor, tenorDays, value] of OIS_QUOTES) {
    await seedPoint({
      curveDate: CURVE_DATE,
      tenor,
      tenorDays,
      quoteType: 'ois_rate',
      value,
      provenanceId: env.oisProvenanceId,
    });
  }
}

interface Run {
  data: WirpPayload;
  meta: PayloadMeta;
}

async function runWIRP(params: Record<string, unknown> = {}): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/WIRP/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

const future = (payload: WirpPayload): WirpMeeting[] => payload.meetings.filter((m) => !m.isPast);
const past = (payload: WirpPayload): WirpMeeting[] => payload.meetings.filter((m) => m.isPast);

/**
 * The only sequence-allocated value a WIRP payload carries: `curve.buildId`. `provIdx` is an index
 * into `meta.provenance` and is stable; `daysAhead`, `stepBp`, `moves` and `bp` are quantities.
 * A number is a build id because of the key it sits under, never because of what it equals.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['buildId']);

function normalise(payload: WirpPayload): unknown {
  const tokens = new Map<number, string>(
    payload.curve.buildId === null ? [] : [[payload.curve.buildId, '<BUILD>']],
  );
  return JSON.parse(
    JSON.stringify(payload, (key, value: unknown) => idToken(key, value, ID_KEYS, tokens)),
  ) as unknown;
}

describe('WIRP — the implied policy path', () => {
  it('allocates each meeting’s implied step onto ranges whose probabilities sum to 100', async () => {
    await seedSlopedCurve();
    const { data } = await runWIRP();

    expect(data.variant).toBe('default');
    expect(future(data)).toHaveLength(3);
    expect(future(data).map((m) => m.meetingDate)).toEqual([
      '2026-09-16',
      '2026-10-28',
      '2026-12-09',
    ]);

    for (const meeting of future(data)) {
      expect(meeting.outcomes.length, `${meeting.meetingDate} has no outcome ladder`).toBeGreaterThan(0);
      const total = meeting.outcomes.reduce((sum, o) => sum + (o.probPct.v as number), 0);
      // Exactly 100, to within double-precision noise on a sum of two complements.
      expect(Math.abs(total - 100), `${meeting.meetingDate} probabilities sum to ${String(total)}`)
        .toBeLessThan(1e-9);

      // Every outcome is a real 25 bp target range around the published one, and the ladder is
      // ordered the way the screen prints it.
      const moves = meeting.outcomes.map((o) => o.moves);
      expect([...moves].sort((a, b) => b - a)).toEqual(moves);
      for (const o of meeting.outcomes) {
        expect(o.rangeTo - o.rangeFrom).toBeCloseTo(0.25, 12);
        expect(o.rangeFrom).toBeCloseTo(3.5 + o.moves * 0.25, 12);
        expect(o.bp).toBe(o.moves * 25);
        expect(o.probPct.provIdx).toBeGreaterThanOrEqual(0);
      }
    }

    // The front of this curve is below the target midpoint, so the path implies easing.
    expect(data.current.targetMid.v).toBe(3.625);
    const terminalCum = data.terminal.cumChangeBp.v as number;
    expect(terminalCum).toBeLessThan(0);
    expect(data.terminal.meetingDate).toBe('2026-12-09');
  });

  it('telescopes: the per-meeting steps sum to the cumulative change', async () => {
    await seedSlopedCurve();
    const { data } = await runWIRP();

    let running = 0;
    for (const meeting of future(data)) {
      running += meeting.stepChangeBp.v as number;
      expect(running, `${meeting.meetingDate} cumulative`).toBeCloseTo(
        meeting.cumChangeBp.v as number,
        9,
      );
      // `impliedMoves` is the same number expressed in 25 bp steps.
      expect((meeting.impliedMoves.v as number) * 25).toBeCloseTo(meeting.cumChangeBp.v as number, 9);
    }
  });

  it('derives the EFFR − SOFR basis from the stored pairs and shifts the path by it', async () => {
    await seedSlopedCurve();
    const { data } = await runWIRP();

    expect(data.basis.source).toBe('derived');
    expect(data.basis.observations).toBe(PAIRED.length);
    expect(data.basis.window).toEqual({ from: '2026-09-08', to: '2026-09-14' });
    const expectedBp =
      (PAIRED.reduce((sum, [, effr, sofr]) => sum + (effr - sofr), 0) / PAIRED.length) * 100;
    expect(data.basis.appliedBp.v as number).toBeCloseTo(expectedBp, 9);

    for (const meeting of future(data)) {
      expect(meeting.impliedReferencePct.v as number).toBeCloseTo(
        (meeting.impliedOvernightPct.v as number) + expectedBp / 100,
        9,
      );
    }

    // A user basis replaces the derived one and moves every implied reference rate by exactly it.
    const overridden = await runWIRP({ basisBp: 5 });
    expect(overridden.data.basis.source).toBe('user');
    expect(overridden.data.basis.observations).toBe(0);
    const before = future(data);
    const after = future(overridden.data);
    for (let i = 0; i < before.length; i += 1) {
      expect((after[i]!.impliedOvernightPct.v as number)).toBeCloseTo(
        before[i]!.impliedOvernightPct.v as number,
        12,
      );
      expect((after[i]!.impliedReferencePct.v as number)).toBeCloseTo(
        (after[i]!.impliedOvernightPct.v as number) + 0.05,
        12,
      );
    }
  });

  it('is flat when the curve is flat', async () => {
    // A single interpolation segment covering every meeting boundary, and meetings spaced exactly
    // 42 days apart, so every inter-meeting forward is read over an interval of identical length.
    // Under those two conditions a flat curve implies a *bit-for-bit* constant overnight path, and
    // the tolerance below is only for the level, which carries the simple-vs-continuous convexity
    // of a single node span (bounded by r²Δ/2 ≈ 1.2 bp at r = 3.5 %, Δ ≤ 0.2 y).
    const FLAT_PCT = 3.5;
    const FLAT_MEETINGS: [string, boolean, number | null][] = [
      ['2026-09-17', false, null],
      ['2026-10-29', false, null],
      ['2026-12-10', false, null],
      ['2027-01-21', false, null],
    ];
    // The 2026 calendar is replaced, not added to: the point of the case is equal spacing.
    await t.client.query(`DELETE FROM fomc_meetings`);
    await seedMeetings(FLAT_MEETINGS, env.fomcProvenanceId);
    await seedCurveRow({ interpolation: 'log_linear_df' });
    await seedPoint({
      curveDate: CURVE_DATE,
      tenor: 'ON',
      tenorDays: 1,
      quoteType: 'fixing',
      value: FLAT_PCT,
      provenanceId: env.oisProvenanceId,
    });
    await seedPoint({
      curveDate: CURVE_DATE,
      tenor: '5Y',
      tenorDays: 1826,
      quoteType: 'ois_rate',
      value: FLAT_PCT,
      provenanceId: env.oisProvenanceId,
    });

    // `reference: 'SOFR'` sets the basis to zero, so the implied reference rate *is* the implied
    // overnight rate and the assertion is about the path and nothing else.
    const { data } = await runWIRP({ reference: 'SOFR', meetings: 4 });
    expect(data.basis.source).toBe('zero');

    const rows = future(data).filter((m) => m.meetingDate >= '2026-09-17');
    expect(rows.map((m) => m.meetingDate)).toEqual(FLAT_MEETINGS.map(([d]) => d));

    const first = rows[0]!.impliedOvernightPct.v as number;
    for (const meeting of rows) {
      // Equal to the last few ulp: a flat curve read over equal windows cannot produce a slope.
      // (`(df(a)/df(b) − 1)/(b − a)` is evaluated at different magnitudes per meeting, so the
      // agreement is to about 1e-13 relative rather than bit for bit.)
      expect(meeting.impliedOvernightPct.v as number, `${meeting.meetingDate} implied overnight`)
        .toBeCloseTo(first, 12);
      expect(meeting.impliedReferencePct.v as number).toBeCloseTo(first, 12);
      // Basis points, so the same 1e-13-relative agreement reads as ~1e-11 absolute here.
      expect(meeting.cumChangeBp.v as number).toBeCloseTo(rows[0]!.cumChangeBp.v as number, 9);
    }
    // No step after the first: the only change is the one that takes the path off the target.
    for (const meeting of rows.slice(1)) {
      expect(meeting.stepChangeBp.v as number, `${meeting.meetingDate} step`).toBeCloseTo(0, 8);
    }
    // The level is the curve's own flat rate expressed as a *simple overnight* forward, which sits
    // below an annually compounded par OIS quote of the same number: a flat 3.50 % annual par OIS
    // implies ln(1.035) ≈ 3.44 % continuously, and that is economics, not an error. The band is
    // wide enough to admit the compounding conversion and narrow enough to catch a units mistake.
    expect(first).toBeGreaterThan(FLAT_PCT - 0.1);
    expect(first).toBeLessThan(FLAT_PCT + 0.1);
  });

  it('invents no meeting at the horizon and no rate for a meeting that has happened', async () => {
    await seedSlopedCurve();
    const { data, meta } = await runWIRP({ meetings: 8 });

    // Three undecided meetings are published, eight were asked for: the grid shows three.
    expect(future(data)).toHaveLength(3);
    expect(data.model.caveats).toContain('FOMC_CALENDAR_HORIZON');
    expect(
      meta.unavailable.some(
        (u) => u.field === 'meetings' && u.detail.includes('3 undecided meetings'),
      ),
      JSON.stringify(meta.unavailable),
    ).toBe(true);

    // The two permanent caveats are on every payload.
    expect(data.model.caveats).toContain('NO_FUTURES_SOURCE');
    expect(data.model.caveats).toContain('POINT_MASS_PROBABILITY_MODEL');
    expect(data.curve.caveats).toEqual(['PROXY_CURVE', 'NO_OIS_SWAP_QUOTES_SOURCE']);

    // Past meetings carry their published decision and no model number at all.
    expect(past(data)).toHaveLength(5);
    for (const meeting of past(data)) {
      expect(meeting.impliedOvernightPct.v).toBeNull();
      expect(meeting.impliedOvernightPct.r).toBe('NOT_IN_UNIVERSE');
      expect(meeting.cumChangeBp.v).toBeNull();
      expect(meeting.outcomes).toEqual([]);
      expect(typeof meeting.decisionBp).toBe('number');
    }
  });

  it('blanks the target-anchored cells and keeps the curve ones when no EFFR range is stored', async () => {
    await seedSlopedCurve();
    await t.client.query(`DELETE FROM rate_fixings WHERE rate_code = 'EFFR'`);

    const { data, meta } = await runWIRP();
    expect(data.current.targetMid.v).toBeNull();
    expect(data.current.targetMid.r).toBe('PROVIDER_DOWN');
    expect(
      meta.unavailable.some((u) => u.field === 'current.targetMid'),
      JSON.stringify(meta.unavailable),
    ).toBe(true);

    for (const meeting of future(data)) {
      // The curve is a different source and it is still there.
      expect(typeof meeting.impliedOvernightPct.v).toBe('number');
      expect(meeting.cumChangeBp.v).toBeNull();
      expect(meeting.stepChangeBp.v).toBeNull();
      expect(meeting.impliedMoves.v).toBeNull();
      expect(meeting.outcomes).toEqual([]);
    }
  });

  it('records the engine and reproduces byte-identical numbers across two runs (ANAL-08)', async () => {
    await seedSlopedCurve();
    const first = await runWIRP();
    const second = await runWIRP();

    const engine = first.meta.engines.find((e) => e.name === 'wirp.policypath');
    expect(engine, JSON.stringify(first.meta.engines)).toBeDefined();
    expect(engine!.version).toBe('1.0.0');
    expect(engine!.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.data.model.engine).toEqual(engine);

    expect(second.meta.engines).toEqual(first.meta.engines);
    expect(JSON.stringify(second.data)).toBe(JSON.stringify(first.data));

    // Every finite cell cites a provenance row (DATA-10). The runner enforces this; the assertion
    // is here so a failure names the cell rather than the request.
    const cells: [string, { v: unknown; provIdx: number }][] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((item, i) => {
          walk(item, `${path}[${String(i)}]`);
        });
        return;
      }
      const record = node as Record<string, unknown>;
      if ('v' in record && 'st' in record && 'provIdx' in record) {
        cells.push([path, record as { v: unknown; provIdx: number }]);
      }
      for (const [key, value] of Object.entries(record)) walk(value, path === '' ? key : `${path}.${key}`);
    };
    walk(first.data, '');
    expect(cells.length).toBeGreaterThan(20);
    for (const [path, cell] of cells) {
      if (typeof cell.v === 'number') expect(cell.provIdx, path).toBeGreaterThanOrEqual(0);
    }
  });

  it('matches the committed golden payload', async () => {
    await seedSlopedCurve();
    const { data } = await runWIRP();
    expectGolden(GOLDEN_NAME, normalise(data));
  });
});
