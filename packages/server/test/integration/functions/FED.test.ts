/**
 * `test/integration/functions/FED.test.ts` — WP-11's `FED` page: the policy range, the overnight
 * complex, the FOMC calendar with implied moves, and the Federal Reserve press feed.
 *
 * The page's defining property is what it will **not** show. Four things Bloomberg's FED has are
 * not reachable in this build, and the failure this file is written to catch is a resolver that
 * quietly closes one of those gaps with a plausible number — IORB set to EFFR, a discount rate
 * derived from the target range, a hike probability inferred from the implied path. So the first
 * test asserts, for each of them, both halves of §1.3 rule 6: the value is null **and** there is a
 * `meta.unavailable` entry that says why. A null with no reason is a bug; a number with no source
 * is a worse one.
 *
 * The second thing asserted is that the implied path is a *rate path*, computed once by
 * `wirp.policypath@1.0.0` and anchored on the published SOFR fixing, and that turning it off
 * (`path: false`) blanks exactly those three columns and changes nothing else. A page that rewrites
 * its rates block when a calendar option changes is a page whose numbers are not what they claim.
 *
 * No seed is assumed (WP-15 owns it): every row lives inside `withTxDb()`'s transaction.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PayloadMeta } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { SIFMA } from '@terminal/core/calendars/sifma';
import { USGOVT } from '@terminal/core/calendars/usgovt';
import { FED } from '@terminal/core/functions/manifests/FED';
import type { FedMeetingRow, FedPayload } from '@terminal/core/functions/manifests/FED';

import type { FunctionServerModule } from '../../../src/functions/context.js';
import * as FEDModule from '../../../src/functions/FED/resolve.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
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
const GOLDEN_NAME = 'FED.default.json';

const FIXING_DATE = '2026-09-14';
const PRIOR_FIXING_DATE = '2026-09-11';
const SOFRAI_DATE = '2026-09-15';
const CMT_DATE = '2026-09-11';
const CMT_PRIOR_DATE = '2026-09-10';
const OIS_CURVE_DATE = '2026-09-14';

const REGISTRY = new FunctionRegistry([FED]);
 
const MODULES: Record<string, FunctionServerModule<any, any>> = { FED: FEDModule };

const t: TestDb = withTxDb();

/** `[code, rate, [p1, p25, p75, p99], volumeBn]` on 2026-09-14 — the `nyfed-all` capture's shape. */
const OVERNIGHT: readonly [string, number, [number, number, number, number], number][] = [
  ['EFFR', 3.63, [3.6, 3.62, 3.63, 3.64], 91],
  ['SOFR', 3.62, [3.57, 3.6, 3.67, 3.7], 2861],
  ['OBFR', 3.63, [3.53, 3.62, 3.63, 3.7], 226],
  ['TGCR', 3.6, [3.53, 3.6, 3.6, 3.63], 1155],
  ['BGCR', 3.6, [3.53, 3.6, 3.61, 3.66], 1183],
];
/** The prior session, so `chg1dBp` has something to difference against. */
const PRIOR: readonly [string, number][] = [
  ['EFFR', 3.57],
  ['SOFR', 3.64],
  ['OBFR', 3.6],
  ['TGCR', 3.59],
  ['BGCR', 3.59],
];

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

/** `[tenor, tenorDays, 2026-09-11, 2026-09-10]` — the H.15 constant-maturity block. */
const CMT_POINTS: readonly [string, number, number, number][] = [
  ['1M', 30, 3.93, 3.91],
  ['3M', 91, 3.9, 3.88],
  ['1Y', 365, 3.84, 3.81],
  ['2Y', 730, 3.76, 3.74],
  ['5Y', 1826, 3.81, 3.78],
  ['10Y', 3653, 4.96, 4.92],
  ['30Y', 10958, 5.35, 5.31],
];

const OIS_QUOTES: readonly [string, number, number][] = [
  ['1Y', 365, 3.42],
  ['2Y', 730, 3.38],
  ['3Y', 1096, 3.4],
  ['5Y', 1826, 3.45],
  ['10Y', 3653, 3.7],
];

interface PressSpec {
  guid: string;
  headline: string;
  category: string;
  publishedAt: string;
  kind: 'press_release' | 'fed_release';
}

const PRESS: readonly PressSpec[] = [
  {
    guid: 'fed-1',
    headline: 'Federal Reserve issues FOMC statement',
    category: 'Monetary Policy',
    publishedAt: '2026-07-29T18:00:00Z',
    kind: 'press_release',
  },
  {
    guid: 'fed-2',
    headline: 'Minutes of the Federal Open Market Committee, July 28-29, 2026',
    category: 'Monetary Policy',
    publishedAt: '2026-08-19T18:00:00Z',
    kind: 'fed_release',
  },
  {
    guid: 'fed-3',
    headline: 'Agencies finalise rule on bank capital requirements',
    category: 'Banking and Consumer Regulatory Policy',
    publishedAt: '2026-09-02T14:00:00Z',
    kind: 'press_release',
  },
  {
    guid: 'fed-4',
    headline: 'Federal Reserve Board announces the appointment of a new general counsel',
    category: 'Other Announcements',
    publishedAt: '2026-09-09T14:00:00Z',
    kind: 'press_release',
  },
];

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
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
    pct?: [number, number, number, number];
    volumeBn?: number;
    target?: [number, number];
    averages?: [number, number, number, number];
  },
  provenanceId: number,
): Promise<void> {
  await t.client.query(
    `INSERT INTO rate_fixings (rate_code, effective_date, vintage_at, rate, pct_1, pct_25, pct_75,
                               pct_99, volume_bn, target_from, target_to, avg_30d, avg_90d,
                               avg_180d, index_value, revision_indicator, is_latest, provenance_id)
     VALUES ($1, $2::date, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             '', true, $16)`,
    [
      spec.code,
      spec.effectiveDate,
      VINTAGE,
      spec.rate,
      spec.pct?.[0] ?? null,
      spec.pct?.[1] ?? null,
      spec.pct?.[2] ?? null,
      spec.pct?.[3] ?? null,
      spec.volumeBn ?? null,
      spec.target?.[0] ?? null,
      spec.target?.[1] ?? null,
      spec.averages?.[0] ?? null,
      spec.averages?.[1] ?? null,
      spec.averages?.[2] ?? null,
      spec.averages?.[3] ?? null,
      provenanceId,
    ],
  );
}

async function seedCurve(spec: {
  curveId: string;
  name: string;
  kind: string;
  dayCount: string;
  compounding: string;
  sourceId: string;
}): Promise<void> {
  await t.client.query(
    `INSERT INTO curves (curve_id, name, currency, kind, day_count, compounding, source_id,
                         default_interpolation)
     VALUES ($1, $2, 'USD', $3, $4, $5, $6, 'monotone_convex')
     ON CONFLICT (curve_id) DO NOTHING`,
    [spec.curveId, spec.name, spec.kind, spec.dayCount, spec.compounding, spec.sourceId],
  );
}

async function seedPoint(spec: {
  curveId: string;
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
     VALUES ($1, $2::date, $3, $4, $5::timestamptz, $6, $7, true, $8)`,
    [
      spec.curveId,
      spec.curveDate,
      spec.tenor,
      spec.quoteType,
      VINTAGE,
      spec.tenorDays,
      spec.value,
      spec.provenanceId,
    ],
  );
}

beforeEach(async () => {
  await ensureLicences();
  await materialiseCalendar(t.db, USGOVT, { fromYear: 2026, toYear: 2027 });
  await materialiseCalendar(t.db, SIFMA, { fromYear: 2026, toYear: 2027 });

  const session = await createWebSession(t, { email: `fed-${randomUUID()}@demo.invalid` });
  await grantEverySource(session.firmId, session.userId);

  const nyfedProv = await bootstrapProvenance(t, 'nyfed.rates', 'fed-nyfed');
  for (const [code, rate, pct, volumeBn] of OVERNIGHT) {
    await seedFixing(
      {
        code,
        effectiveDate: FIXING_DATE,
        rate,
        pct,
        volumeBn,
        ...(code === 'EFFR' ? { target: [3.5, 3.75] as [number, number] } : {}),
      },
      nyfedProv,
    );
  }
  for (const [code, rate] of PRIOR) {
    await seedFixing(
      {
        code,
        effectiveDate: PRIOR_FIXING_DATE,
        rate,
        ...(code === 'EFFR' ? { target: [3.5, 3.75] as [number, number] } : {}),
      },
      nyfedProv,
    );
  }
  await seedFixing(
    {
      code: 'SOFRAI',
      effectiveDate: SOFRAI_DATE,
      rate: null,
      averages: [3.6485, 3.64603, 3.65767, 1.25884091],
    },
    nyfedProv,
  );

  const h15Prov = await bootstrapProvenance(t, 'fed.h15', 'fed-h15');
  const oisProv = await bootstrapProvenance(t, 'internal.derived', 'fed-ois');
  const fomcProv = await bootstrapProvenance(t, 'fed.fomc', 'fed-fomc');
  const rssProv = await bootstrapProvenance(t, 'fed.rss', 'fed-rss');

  await seedCurve({
    curveId: 'UST_CMT',
    name: 'H.15 constant maturity',
    kind: 'cmt',
    dayCount: 'ACT/ACT',
    compounding: 'semiannual',
    sourceId: 'fed.h15',
  });
  for (const [tenor, tenorDays, value, prior] of CMT_POINTS) {
    await seedPoint({
      curveId: 'UST_CMT',
      curveDate: CMT_DATE,
      tenor,
      tenorDays,
      quoteType: 'cmt_yield',
      value,
      provenanceId: h15Prov,
    });
    await seedPoint({
      curveId: 'UST_CMT',
      curveDate: CMT_PRIOR_DATE,
      tenor,
      tenorDays,
      quoteType: 'cmt_yield',
      value: prior,
      provenanceId: h15Prov,
    });
  }

  await seedCurve({
    curveId: 'SOFR_OIS',
    name: 'USD SOFR OIS (proxied)',
    kind: 'ois',
    dayCount: 'ACT/360',
    compounding: 'simple',
    sourceId: 'internal.derived',
  });
  await seedPoint({
    curveId: 'SOFR_OIS',
    curveDate: OIS_CURVE_DATE,
    tenor: 'ON',
    tenorDays: 1,
    quoteType: 'fixing',
    value: 3.62,
    provenanceId: oisProv,
  });
  for (const [tenor, tenorDays, value] of OIS_QUOTES) {
    await seedPoint({
      curveId: 'SOFR_OIS',
      curveDate: OIS_CURVE_DATE,
      tenor,
      tenorDays,
      quoteType: 'ois_rate',
      value,
      provenanceId: oisProv,
    });
  }

  for (const [date, hasSep, decisionBp] of FOMC_2026) {
    await t.client.query(
      `INSERT INTO fomc_meetings (meeting_date, statement_at, has_sep, decision_bp, provenance_id)
       VALUES ($1::date, ($1 || 'T18:00:00Z')::timestamptz, $2, $3, $4)
       ON CONFLICT (meeting_date) DO NOTHING`,
      [date, hasSep, decisionBp, fomcProv],
    );
  }

  for (const item of PRESS) {
    await t.client.query(
      `INSERT INTO news_items (source_id, feed, provider_guid, kind, headline, summary, url,
                               category, published_at, captured_at, is_correction, provenance_id)
       VALUES ('fed.rss', 'press_all', $1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz,
               false, $9)`,
      [
        item.guid,
        item.kind,
        item.headline,
        null,
        `https://www.federalreserve.gov/newsevents/pressreleases/${item.guid}.htm`,
        item.category,
        item.publishedAt,
        new Date(GOLDEN_CAPTURE_MS).toISOString(),
        rssProv,
      ],
    );
  }

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };

  env = { harness, app: harness.app, clock, cookie: session.cookie, knownAt };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: FedPayload;
  meta: PayloadMeta;
}

async function runFED(params: Record<string, unknown> = {}): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/FED/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

const explains = (meta: PayloadMeta, field: string): boolean =>
  meta.unavailable.some((u) => u.field === field);

/** `newsId` and `buildId` are the sequence-allocated numbers; everything else is a quantity. */
const ID_KEYS: ReadonlySet<string> = new Set(['newsId', 'buildId']);

function normalise(payload: FedPayload): unknown {
  const tokens = new Map<number, string>();
  payload.press.forEach((item, i) => tokens.set(item.newsId, `<NEWS${String(i)}>`));
  if (payload.path !== null) tokens.set(payload.path.buildId, '<BUILD>');
  return JSON.parse(
    JSON.stringify(payload, (key, value: unknown) => idToken(key, value, ID_KEYS, tokens)),
  ) as unknown;
}

describe('FED — the Federal Reserve monitor', () => {
  it('serves the policy range and the overnight complex with percentiles and volumes', async () => {
    const { data } = await runFED();

    expect(data.variant).toBe('default');
    expect(data.asOfDate).toBe('2026-09-15');
    expect(data.policy.targetFrom.v).toBe(3.5);
    expect(data.policy.targetTo.v).toBe(3.75);
    expect(data.policy.effectiveDate).toBe(FIXING_DATE);
    expect(data.policy.lastChange).toEqual({ meetingDate: '2026-07-29', decisionBp: -25 });
    expect(data.policy.nextMeeting).toMatchObject({
      meetingDate: '2026-09-16',
      hasSep: true,
      businessDaysAway: 1,
    });

    expect(data.rates.map((r) => r.rateCode)).toEqual(['EFFR', 'SOFR', 'OBFR', 'TGCR', 'BGCR']);
    const sofr = data.rates.find((r) => r.rateCode === 'SOFR')!;
    expect(sofr.rate.v).toBe(3.62);
    expect([sofr.p1.v, sofr.p25.v, sofr.p75.v, sofr.p99.v]).toEqual([3.57, 3.6, 3.67, 3.7]);
    expect(sofr.volumeBn.v).toBe(2861);
    expect(sofr.subject).toBe('r:SOFR');
    // Differences against the published numbers, not against a model.
    expect(sofr.chg1dBp.v as number).toBeCloseTo((3.62 - 3.64) * 100, 9);
    expect(sofr.spreadToMidBp.v as number).toBeCloseTo((3.62 - 3.625) * 100, 9);
    // Every rate cell flashes on a new fixing rather than waiting for a re-run.
    expect(sofr.rate.live).toEqual({ subject: 'r:SOFR', field: 'RATE' });

    expect(data.sofrAverages.indexValue.v).toBe(1.25884091);
    expect(data.sofrAverages.avg30d.v).toBe(3.6485);
    expect(data.sofrAverages.effectiveDate).toBe(SOFRAI_DATE);

    // The H.15 grid, ascending in tenor, with a one-day change column.
    expect(data.h15.curveDate).toBe(CMT_DATE);
    expect(data.h15.priorDate).toBe(CMT_PRIOR_DATE);
    expect(data.h15.rows.map((r) => r.tenor)).toEqual(CMT_POINTS.map(([tenor]) => tenor));
    const ten = data.h15.rows.find((r) => r.tenor === '10Y')!;
    expect(ten.yieldPct.v).toBe(4.96);
    expect(ten.chg1dBp.v as number).toBeCloseTo((4.96 - 4.92) * 100, 9);

    // The history grid, newest first, one row per stored session.
    expect(data.history.map((r) => r.date)).toEqual([FIXING_DATE, PRIOR_FIXING_DATE]);
    expect(data.history[0]).toMatchObject({ effr: 3.63, sofr: 3.62, targetFrom: 3.5 });
  });

  it('shows nothing it has no source for, and says why for each of them', async () => {
    const { data, meta } = await runFED();

    expect(data.policy.iorb.v).toBeNull();
    expect(data.policy.discountPrimary.v).toBeNull();
    expect(data.balanceSheet).toBeNull();
    for (const m of data.meetings) {
      expect(m.hikeProbPct).toBeNull();
      expect(m.cutProbPct).toBeNull();
    }

    // Null AND explained — a null with no reason is as wrong as a number with no source.
    for (const field of [
      'policy.iorb',
      'policy.discountPrimary',
      'balanceSheet',
      'meetings.hikeProbPct',
      'meetings.cutProbPct',
    ]) {
      expect(explains(meta, field), `${field}: ${JSON.stringify(meta.unavailable)}`).toBe(true);
    }
    const iorb = meta.unavailable.find((u) => u.field === 'policy.iorb')!;
    expect(iorb.detail).toContain('H.15');

    // IORB is not EFFR, and not EFFR-with-a-haircut: it is absent.
    const effr = data.rates.find((r) => r.rateCode === 'EFFR')!;
    expect(effr.rate.v).toBe(3.63);
    expect(data.policy.iorb.v).not.toBe(effr.rate.v);
  });

  it('computes one implied rate path and calls it a rate path', async () => {
    const { data, meta } = await runFED();

    expect(data.path).not.toBeNull();
    expect(data.path!.curveId).toBe('SOFR_OIS');
    expect(data.path!.curveDate).toBe(OIS_CURVE_DATE);
    expect(data.path!.caveats).toEqual(['PROXY_CURVE', 'NO_FUTURES_SOURCE']);
    expect(data.path!.engine.name).toBe('wirp.policypath');
    expect(data.path!.engine.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.engines.some((e) => e.name === 'wirp.policypath')).toBe(true);
    // The path is anchored on the published SOFR fixing, not on the target midpoint.
    expect(data.path!.spotRatePct).toMatchObject({ v: 3.62 });

    // Eight meetings around today: five decided, the next one flagged.
    expect(data.meetings).toHaveLength(8);
    expect(data.meetings[5]!.meetingDate).toBe('2026-09-16');
    expect(data.meetings[5]!.isNext).toBe(true);
    expect(data.meetings.filter((m) => m.isNext)).toHaveLength(1);

    const scheduled = data.meetings.filter((m) => !m.isPast);
    expect(scheduled.map((m) => m.meetingDate)).toEqual([
      '2026-09-16',
      '2026-10-28',
      '2026-12-09',
    ]);
    for (const m of scheduled) {
      expect(typeof m.impliedRatePct.v).toBe('number');
      // `cumulativeMoveBp` is measured from the spot the path was anchored on.
      expect(m.cumulativeMoveBp.v as number).toBeCloseTo(((m.impliedRatePct.v as number) - 3.62) * 100, 6);
      expect(m.decisionBp).toBeNull();
    }
    // The per-meeting move telescopes into the cumulative one: one anchor governs the row, so the
    // first meeting's move IS its cumulative move and the column sums to the last cumulative. It
    // used to be the engine's `incrementalBp`, whose first step measures from the curve's own
    // pre-meeting forward rather than from the 3.62 spot — the column then footed 0.278 bp short.
    const moves = scheduled.map((m) => m.impliedMoveBp.v as number);
    const cumulative = scheduled.map((m) => m.cumulativeMoveBp.v as number);
    expect(moves[0]!).toBe(cumulative[0]!);
    expect(moves.reduce((a, b) => a + b, 0)).toBeCloseTo(cumulative[cumulative.length - 1]!, 9);
    for (let i = 1; i < scheduled.length; i += 1) {
      // Each later step is the difference of two *implied rates*, which is what §FED step 8 says.
      expect(moves[i]!).toBeCloseTo(
        (scheduled[i]!.impliedRatePct.v as number) * 100 -
          (scheduled[i - 1]!.impliedRatePct.v as number) * 100,
        6,
      );
    }

    // A decided meeting carries its decision and no model rate at all.
    const decided = data.meetings.filter((m) => m.isPast);
    expect(decided).toHaveLength(5);
    for (const m of decided) {
      expect(m.impliedRatePct.v).toBeNull();
      expect(m.impliedRatePct.r).toBe('NOT_IN_UNIVERSE');
      expect(typeof m.decisionBp).toBe('number');
    }
  });

  it('path=false blanks the three implied columns and changes nothing else', async () => {
    const withPath = await runFED();
    const without = await runFED({ path: false });

    expect(without.data.path).toBeNull();
    for (const m of without.data.meetings) {
      expect(m.impliedRatePct.v).toBeNull();
      expect(m.impliedMoveBp.v).toBeNull();
      expect(m.cumulativeMoveBp.v).toBeNull();
    }
    expect(explains(without.meta, 'meetings.impliedRatePct')).toBe(true);

    // Everything that is not the path is identical, block for block. `provIdx` is dropped because
    // it is an INDEX into `meta.provenance`, and not computing the path means the SOFR OIS curve is
    // never cited — so every later citation legitimately shifts down by one. The values are what
    // must not move.
    const dropProvIdx = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(dropProvIdx);
      if (node === null || typeof node !== 'object') return node;
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .filter(([key]) => key !== 'provIdx')
          .map(([key, value]) => [key, dropProvIdx(value)]),
      );
    };
    const strip = (payload: FedPayload): unknown => dropProvIdx({
      policy: payload.policy,
      rates: payload.rates,
      sofrAverages: payload.sofrAverages,
      history: payload.history,
      h15: payload.h15,
      press: payload.press,
      meetings: payload.meetings.map((m: FedMeetingRow) => ({
        meetingDate: m.meetingDate,
        isNext: m.isNext,
        isPast: m.isPast,
        decisionBp: m.decisionBp,
        hasSep: m.hasSep,
      })),
    } satisfies Record<string, unknown>);
    expect(JSON.stringify(strip(without.data))).toBe(JSON.stringify(strip(withPath.data)));
  });

  it('filters the press feed by category and empties honestly', async () => {
    const all = await runFED({ view: 'press' });
    expect(all.data.press.map((p) => p.headline)).toEqual(
      [...PRESS].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1)).map((p) => p.headline),
    );
    for (const item of all.data.press) {
      expect(item.provIdx).toBeGreaterThanOrEqual(0);
      expect(item.url).toContain('federalreserve.gov');
    }

    const monetary = await runFED({ view: 'press', category: 'monetary' });
    expect(monetary.data.press).toHaveLength(2);
    for (const item of monetary.data.press) expect(item.category).toBe('Monetary Policy');

    const banking = await runFED({ view: 'press', category: 'banking' });
    expect(banking.data.press).toHaveLength(1);

    const other = await runFED({ view: 'press', category: 'other' });
    expect(other.data.press).toHaveLength(1);
    expect(other.data.press[0]!.category).toBe('Other Announcements');

    // An empty filter is a stated absence, not a silently empty list.
    await t.client.query(`DELETE FROM news_items WHERE feed = 'press_all'`);
    const none = await runFED({ view: 'press', category: 'monetary' });
    expect(none.data.press).toEqual([]);
    expect(explains(none.meta, 'press')).toBe(true);
  });

  it('cites a provenance row for every number and reproduces itself (ANAL-08)', async () => {
    const first = await runFED();
    const second = await runFED();
    expect(second.meta.engines).toEqual(first.meta.engines);
    expect(JSON.stringify(second.data)).toBe(JSON.stringify(first.data));

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
      for (const [key, value] of Object.entries(record)) {
        walk(value, path === '' ? key : `${path}.${key}`);
      }
    };
    walk(first.data, '');
    expect(cells.length).toBeGreaterThan(40);
    for (const [path, cell] of cells) {
      if (typeof cell.v === 'number') expect(cell.provIdx, path).toBeGreaterThanOrEqual(0);
    }
  });

  it('matches the committed golden payload', async () => {
    const { data } = await runFED();
    expectGolden(GOLDEN_NAME, normalise(data));
  });
});
