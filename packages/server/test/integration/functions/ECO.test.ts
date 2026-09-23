/**
 * `test/integration/functions/ECO.test.ts` — WP-10's acceptance row for `ECO`
 * ("releases by week with actual/prior/revised; `consensus` null with
 * `consensus_unavailable_reason` populated").
 *
 * Four seeded events inside the week of 2026-09-14, chosen because each one takes a different path
 * through the resolver:
 *
 * | release                | when                 | status      | proves                              |
 * | ---------------------- | -------------------- | ----------- | ----------------------------------- |
 * | Consumer Price Index   | Wed 16 Sep 12:30 UTC | `revised`   | actual + prior + REVISED prior, and a headline series with units and decimals |
 * | Employment Situation   | Fri 18 Sep 12:30 UTC | `scheduled` | a future print: `actual` is `blank`, not zero |
 * | Retail Sales           | Thu 17 Sep 12:30 UTC | `released`  | an unrevised print: `revisedPrior` is `na`, and `IMP=2` keeps it |
 * | Weekly Chain Store Idx | Tue 15 Sep 12:00 UTC | `released`  | importance 3 — `IMP=2` filters it out |
 *
 * The row this file exists for is the one that is null on every single event. There is no
 * consensus provider in the reachable set (BRIEF §2): `econ_release_events.consensus` is `NULL` by
 * schema, `consensus_unavailable_reason` carries `NO_CONSENSUS_SOURCE`, the payload's `consensus`
 * slot is `{ v: null, r: 'NO_CONSENSUS_SOURCE' }` on every row, `surprisePct` is `null` on every
 * row, and `meta.unavailable` states both facts exactly once. A test that only checked the happy
 * numbers would pass against a resolver that quietly filled the column with zeros, which is the
 * failure this screen is designed to make impossible.
 *
 * No seed is assumed: WP-15 owns the seed and it is not written, so every row this file reads it
 * also creates, inside `withTxDb()`'s transaction, and nothing asserts on a literal instrument or
 * release id (TESTING §4.3 — `bigserial` values are not reproducible between runs).
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FunctionRegistry } from '@terminal/core';
import { USGOVT } from '@terminal/core/calendars/usgovt';
import { ECO } from '@terminal/core/functions/manifests/ECO';
import type { EcoEventRow, EcoPayload } from '@terminal/core/functions/manifests/ECO';

import type { PayloadMeta } from '@terminal/core';

import type { FunctionServerModule } from '../../../src/functions/context.js';
import * as ECOModule from '../../../src/functions/ECO/resolve.js';
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
const GOLDEN_NAME = 'ECO.default.json';
const RELEASE_GOLDEN_NAME = 'ECO.default-release.json';

const REGISTRY = new FunctionRegistry([ECO]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { ECO: ECOModule };

const t: TestDb = withTxDb();

interface SeededRelease {
  releaseId: number;
  name: string;
}

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  cpi: SeededRelease;
  employment: SeededRelease;
  retail: SeededRelease;
  chainStore: SeededRelease;
  cpiSeriesId: number;
  cpiEventId: number;
  employmentEventId: number;
  retailEventId: number;
  chainStoreEventId: number;
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

async function seedRelease(spec: {
  sourceId: string;
  providerReleaseId: string;
  name: string;
  importance: number;
  url: string | null;
}): Promise<SeededRelease> {
  const res = await t.client.query<{ release_id: string }>(
    `INSERT INTO econ_releases (source_id, provider_release_id, name, country, url, importance)
     VALUES ($1, $2, $3, 'US', $4, $5) RETURNING release_id`,
    [spec.sourceId, spec.providerReleaseId, spec.name, spec.url, spec.importance],
  );
  return { releaseId: Number(res.rows[0]!.release_id), name: spec.name };
}

async function seedSeries(spec: {
  seriesCode: string;
  providerCode: string;
  name: string;
  units: string;
  decimals: number;
  releaseId: number;
  lastObsDate: string;
}): Promise<number> {
  const res = await t.client.query<{ series_id: string }>(
    `INSERT INTO econ_series (series_code, source_id, provider_code, name, units, frequency,
                              seasonal_adj, country, release_id, decimals, first_obs_date,
                              last_obs_date, last_updated_at)
     VALUES ($1, 'fred.csv', $2, $3, $4, 'M', 'NSA', 'US', $5, $6, date '2020-01-01', $7::date,
             timestamptz '2026-09-11T13:00:00Z')
     RETURNING series_id`,
    [
      spec.seriesCode,
      spec.providerCode,
      spec.name,
      spec.units,
      spec.releaseId,
      spec.decimals,
      spec.lastObsDate,
    ],
  );
  return Number(res.rows[0]!.series_id);
}

async function seedEvent(spec: {
  releaseId: number;
  scheduledAt: string;
  timeKnown: boolean;
  periodLabel: string;
  seriesId: number | null;
  actual: number | null;
  prior: number | null;
  revisedPrior: number | null;
  status: string;
  provenanceId: number;
}): Promise<number> {
  const res = await t.client.query<{ event_id: string }>(
    `INSERT INTO econ_release_events
       (release_id, scheduled_at, time_known, period_label, series_id, actual, prior,
        revised_prior, consensus, consensus_unavailable_reason, status, provenance_id)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, NULL, 'NO_CONSENSUS_SOURCE', $9, $10)
     RETURNING event_id`,
    [
      spec.releaseId,
      spec.scheduledAt,
      spec.timeKnown,
      spec.periodLabel,
      spec.seriesId,
      spec.actual,
      spec.prior,
      spec.revisedPrior,
      spec.status,
      spec.provenanceId,
    ],
  );
  return Number(res.rows[0]!.event_id);
}

beforeEach(async () => {
  await ensureLicences();
  // Only the year the window spans: `calendars` and `calendar_holidays` are shared tables and a
  // wide range holds their keys for the length of the whole file (see WEI.test.ts's note).
  await materialiseCalendar(t.db, USGOVT, { fromYear: 2026, toYear: 2026 });

  const session = await createWebSession(t, { email: `eco-${randomUUID()}@demo.invalid` });
  await grantEverySource(session.firmId, session.userId);

  const fredProv = await bootstrapProvenance(t, 'fred.calendar', 'eco-fred-cal');
  const blsProv = await bootstrapProvenance(t, 'bls.schedule', 'eco-bls-sched');
  const fomcProv = await bootstrapProvenance(t, 'fed.fomc', 'eco-fomc');
  const seriesProv = await bootstrapProvenance(t, 'fred.csv', 'eco-fred-csv');

  const cpi = await seedRelease({
    sourceId: 'fred.calendar',
    providerReleaseId: `10-${randomUUID().slice(0, 8)}`,
    name: 'Consumer Price Index',
    importance: 2,
    url: 'https://fred.stlouisfed.org/releases/calendar',
  });
  const employment = await seedRelease({
    sourceId: 'bls.schedule',
    providerReleaseId: `empsit-${randomUUID().slice(0, 8)}`,
    name: 'Employment Situation',
    importance: 1,
    url: 'https://www.bls.gov/schedule/news_release/empsit.htm',
  });
  const retail = await seedRelease({
    sourceId: 'fred.calendar',
    providerReleaseId: `retail-${randomUUID().slice(0, 8)}`,
    name: 'Advance Retail Sales',
    importance: 2,
    url: null,
  });
  const chainStore = await seedRelease({
    sourceId: 'fred.calendar',
    providerReleaseId: `chain-${randomUUID().slice(0, 8)}`,
    name: 'Weekly Chain Store Index',
    importance: 3,
    url: null,
  });

  const cpiSeriesId = await seedSeries({
    seriesCode: `CUUR0000SA0.${randomUUID().slice(0, 6)}`,
    providerCode: `CUUR0000SA0.${randomUUID().slice(0, 6)}`,
    name: 'CPI for All Urban Consumers: All Items',
    units: 'Index 1982-1984=100',
    decimals: 3,
    releaseId: cpi.releaseId,
    lastObsDate: '2026-08-01',
  });

  // Two vintages of the July observation: the original and the revision the September print
  // carried. The release view lists both, which is what makes a revision data rather than prose.
  await t.client.query(
    `INSERT INTO econ_observations (series_id, obs_date, vintage_at, value, status, is_latest,
                                    provenance_id)
     VALUES ($1, date '2026-07-01', timestamptz '2026-08-12T12:30:00Z', 322.104, 'final', false, $2),
            ($1, date '2026-07-01', timestamptz '2026-09-11T12:30:00Z', 322.140, 'revised', true, $2),
            ($1, date '2026-08-01', timestamptz '2026-09-11T12:30:00Z', 323.048, 'final', true, $2)`,
    [cpiSeriesId, seriesProv],
  );

  const cpiEventId = await seedEvent({
    releaseId: cpi.releaseId,
    scheduledAt: '2026-09-16T12:30:00Z',
    timeKnown: true,
    periodLabel: 'August 2026',
    seriesId: cpiSeriesId,
    actual: 324.112,
    prior: 323.048,
    revisedPrior: 323.05,
    status: 'revised',
    provenanceId: fredProv,
  });
  const employmentEventId = await seedEvent({
    releaseId: employment.releaseId,
    scheduledAt: '2026-09-18T12:30:00Z',
    timeKnown: true,
    periodLabel: 'September 2026',
    seriesId: null,
    actual: null,
    prior: 22_000,
    revisedPrior: null,
    status: 'scheduled',
    provenanceId: blsProv,
  });
  const retailEventId = await seedEvent({
    releaseId: retail.releaseId,
    // `time_known = false`: FRED publishes the day only and the ingest pins it to 08:30 ET.
    scheduledAt: '2026-09-17T12:30:00Z',
    timeKnown: false,
    periodLabel: 'August 2026',
    seriesId: null,
    actual: 0.4,
    prior: 0.6,
    revisedPrior: null,
    status: 'released',
    provenanceId: fredProv,
  });
  const chainStoreEventId = await seedEvent({
    releaseId: chainStore.releaseId,
    scheduledAt: '2026-09-15T12:00:00Z',
    timeKnown: true,
    periodLabel: 'Week of 12 September 2026',
    seriesId: null,
    actual: 1.2,
    prior: 1.1,
    revisedPrior: null,
    status: 'released',
    provenanceId: fredProv,
  });

  await t.client.query(
    `INSERT INTO fomc_meetings (meeting_date, statement_at, has_sep, decision_bp, provenance_id)
     VALUES (date '2026-07-29', timestamptz '2026-07-29T18:00:00Z', false, -25, $1),
            (date '2026-09-16', timestamptz '2026-09-16T18:00:00Z', true, NULL, $1),
            (date '2026-11-04', timestamptz '2026-11-04T19:00:00Z', false, NULL, $1)
     ON CONFLICT (meeting_date) DO NOTHING`,
    [fomcProv],
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
    clock,
    cookie: session.cookie,
    knownAt,
    cpi,
    employment,
    retail,
    chainStore,
    cpiSeriesId,
    cpiEventId,
    employmentEventId,
    retailEventId,
    chainStoreEventId,
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: EcoPayload;
  meta: PayloadMeta;
}

async function runECO(params: Record<string, unknown> = {}): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/ECO/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

/** `POST /functions/ECO/page` — the runner re-runs with the cached cursor and this direction. */
async function pageECO(resultId: string, direction: 'fwd' | 'back'): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/ECO/page`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { resultId, direction },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

/** The `{ anchor, range }` a cursor carries, as `ECO/resolve.ts` mints it. */
function decodeCursor(cursor: string): unknown {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

function events(payload: EcoPayload): EcoEventRow[] {
  return payload.days.flatMap((d) => d.events);
}

function eventOf(payload: EcoPayload, releaseName: string): EcoEventRow {
  const row = events(payload).find((e) => e.releaseName === releaseName);
  expect(row, `${releaseName} is missing from the payload`).toBeDefined();
  return row!;
}

/** Sequence-allocated ids and the run's own `knownAt` become tokens; nothing else is rewritten. */
/**
 * The keys of an ECO payload that hold a sequence-allocated id: `eco_releases.release_id` and
 * `eco_events.event_id` (§ECO). `sourceId` (`'fred.calendar'`) is a name, not a sequence value.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['releaseId', 'eventId']);

function normalise(payload: EcoPayload): unknown {
  const ids = new Map<number, string>([
    [env.cpi.releaseId, '<CPI_RELEASE>'],
    [env.employment.releaseId, '<EMPLOYMENT_RELEASE>'],
    [env.retail.releaseId, '<RETAIL_RELEASE>'],
    [env.chainStore.releaseId, '<CHAIN_RELEASE>'],
    [env.cpiEventId, '<CPI_EVENT>'],
    [env.employmentEventId, '<EMPLOYMENT_EVENT>'],
    [env.retailEventId, '<RETAIL_EVENT>'],
    [env.chainStoreEventId, '<CHAIN_EVENT>'],
  ]);
  const seriesCode = events(payload).find((e) => e.seriesCode !== null)?.seriesCode ?? null;
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (typeof value === 'string') {
      // Each matched by the key it sits under, not by its text: a scheduled or released instant
      // equal to the read instant, or a release name equal to the series code, is the payload's
      // claim and stays literal.
      if (key === 'knownAt' && value === env.knownAt) return '<KNOWN_AT>';
      if (key === 'seriesCode' && seriesCode !== null && value === seriesCode) {
        return '<CPI_SERIES>';
      }
      if (key === 'subject' && seriesCode !== null && value === `e:${seriesCode}`) {
        return 'e:<CPI_SERIES>';
      }
      return value;
    }
    // An id is an id because of the key it sits under. Every event on this grid carries an
    // `importance` of 1, 2 or 3 and a `decimals` — exactly the integers a fresh `eco_events`
    // sequence hands out first — alongside an `actual`, `prior` and `revisedPrior` that are bare
    // magnitudes. The old value-based rule renamed whichever of them the sequence reached.
    return idToken(key, value, ID_KEYS, ids);
  });
  return JSON.parse(json);
}

describe('ECO — the week grid', () => {
  it('anchors on the ISO week of the as-of day and keeps every day of it', async () => {
    const { data } = await runECO();
    expect(data.variant).toBe('default');
    expect(data.mode).toBe('calendar');
    expect(data.window).toMatchObject({
      from: '2026-09-14',
      to: '2026-09-20',
      tz: 'America/New_York',
      label: 'Week of 2026-09-14',
    });
    expect(data.days).toHaveLength(7);
    expect(data.days.map((d) => d.date)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
    // Empty days are kept so the screen renders the grid, and the weekend is not a business day.
    expect(data.days.filter((d) => d.events.length === 0).map((d) => d.date)).toEqual([
      '2026-09-14',
      '2026-09-19',
      '2026-09-20',
    ]);
    expect(data.days.map((d) => d.isBusinessDay)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('carries actual, prior and revised prior from the stored event', async () => {
    const { data } = await runECO();
    const cpi = eventOf(data, 'Consumer Price Index');
    expect(cpi.status).toBe('revised');
    expect(cpi.actual.v).toBe(324.112);
    expect(cpi.actual.st).toBe('closed');
    expect(cpi.prior.v).toBe(323.048);
    expect(cpi.revisedPrior.v).toBe(323.05);
    // Every finite number cites a provenance row (DATA-10).
    expect(cpi.actual.provIdx).toBeGreaterThanOrEqual(0);
    expect(cpi.prior.provIdx).toBeGreaterThanOrEqual(0);
    expect(cpi.revisedPrior.provIdx).toBeGreaterThanOrEqual(0);
    // The headline series travels with the row so the screen can format the number.
    expect(cpi.units).toBe('Index 1982-1984=100');
    expect(cpi.decimals).toBe(3);
    expect(cpi.subject).toBe(`e:${cpi.seriesCode ?? ''}`);
    expect(cpi.sourceId).toBe('fred.calendar');
  });

  it('leaves a scheduled print blank and an unrevised print na — never zero', async () => {
    const { data } = await runECO();
    const employment = eventOf(data, 'Employment Situation');
    expect(employment.status).toBe('scheduled');
    expect(employment.actual.v).toBeNull();
    expect(employment.actual.st).toBe('blank');
    expect(employment.prior.v).toBe(22_000);
    expect(employment.revisedPrior.v).toBeNull();
    expect(employment.revisedPrior.st).toBe('na');
    expect(employment.sourceId).toBe('bls.schedule');
    expect(employment.subject).toBeNull();

    const retail = eventOf(data, 'Advance Retail Sales');
    expect(retail.status).toBe('released');
    expect(retail.actual.v).toBe(0.4);
    expect(retail.revisedPrior.v).toBeNull();
    expect(retail.revisedPrior.st).toBe('na');
    // FRED publishes the day only for this release; the ingest pinned it to 08:30 ET.
    expect(retail.timeKnown).toBe(false);
  });

  it('never fabricates a consensus, on any row, and says so once in meta', async () => {
    const { data, meta } = await runECO();
    const rows = events(data);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.consensus).toEqual({ v: null, r: 'NO_CONSENSUS_SOURCE' });
      expect(row.surprisePct).toBeNull();
    }
    expect(data.consensus).toEqual({ value: null, reason: 'NO_CONSENSUS_SOURCE' });

    const consensus = meta.unavailable.filter((u) => u.field === 'consensus');
    expect(consensus).toHaveLength(1);
    expect(consensus[0]).toMatchObject({ reason: 'NO_SOURCE' });
    expect(consensus[0]!.detail).toContain('NO_CONSENSUS_SOURCE');
    expect(consensus[0]!.detail).toContain('BRIEF §2');

    const surprise = meta.unavailable.filter((u) => u.field === 'surprisePct');
    expect(surprise).toHaveLength(1);
    expect(surprise[0]!.detail).toContain('NO_CONSENSUS_SOURCE');
  });

  it('agrees with the database: consensus is NULL and the reason column is populated', async () => {
    const stored = await t.client.query<{ consensus: string | null; reason: string }>(
      `SELECT consensus::text AS consensus, consensus_unavailable_reason AS reason
         FROM econ_release_events WHERE release_id = ANY($1::bigint[])`,
      [[env.cpi.releaseId, env.employment.releaseId, env.retail.releaseId]],
    );
    expect(stored.rowCount).toBe(3);
    for (const row of stored.rows) {
      expect(row.consensus).toBeNull();
      expect(row.reason).toBe('NO_CONSENSUS_SOURCE');
    }
  });

  it('applies the importance floor the screen badges as IMP ≥ n', async () => {
    // §ECO: `importance` is the "minimum econ_releases.importance shown (1 = show everything)" and
    // the badge reads `IMP ≥ <n>`, so the predicate is `econ_releases.importance >= n` on the raw
    // column. The default of 1 therefore shows every seeded release.
    const all = await runECO();
    expect(events(all.data).map((e) => e.releaseName).sort()).toEqual([
      'Advance Retail Sales',
      'Consumer Price Index',
      'Employment Situation',
      'Weekly Chain Store Index',
    ]);
    expect(all.data.importance).toBe(1);

    const two = await runECO({ importance: 2 });
    expect(events(two.data).map((e) => e.releaseName).sort()).toEqual([
      'Advance Retail Sales',
      'Consumer Price Index',
      'Weekly Chain Store Index',
    ]);
    expect(two.data.importance).toBe(2);

    const three = await runECO({ importance: 3 });
    expect(events(three.data).map((e) => e.releaseName)).toEqual(['Weekly Chain Store Index']);
    expect(three.data.importance).toBe(3);
  });

  it('shows the FOMC block with the last decision and the next meeting', async () => {
    const { data } = await runECO();
    const dates = data.fomc.map((m) => m.meetingDate);
    expect(dates).toContain('2026-09-16');
    expect(dates).toContain('2026-11-04');

    const september = data.fomc.find((m) => m.meetingDate === '2026-09-16')!;
    expect(september.isNext).toBe(true);
    expect(september.inWindow).toBe(true);
    expect(september.hasSep).toBe(true);
    // A decision is never estimated before the meeting.
    expect(september.decisionBp).toBeNull();

    const november = data.fomc.find((m) => m.meetingDate === '2026-11-04')!;
    expect(november.inWindow).toBe(false);
    expect(november.isNext).toBe(false);

    const off = await runECO({ fomc: false });
    expect(off.data.fomc).toEqual([]);
  });

  it('pages a week forward and a week back from the same result', async () => {
    const first = await runECO();
    expect(first.meta.page?.cursor).toBeTypeOf('string');
    // The cursor caches THIS window's anchor, so the same result pages either way.
    expect(decodeCursor(first.meta.page!.cursor!)).toEqual({ anchor: '2026-09-14', range: 'W' });

    const forward = await pageECO(first.meta.resultId, 'fwd');
    expect(forward.data.window.from).toBe('2026-09-21');
    expect(forward.data.window.label).toBe('Week of 2026-09-21');
    // Nothing is seeded in the next week: the grid is seven empty days, not an error.
    expect(events(forward.data)).toHaveLength(0);
    expect(forward.data.cursor.prev).toBe(first.meta.page!.cursor);

    const back = await pageECO(first.meta.resultId, 'back');
    expect(back.data.window.from).toBe('2026-09-07');
    expect(back.data.window.to).toBe('2026-09-13');

    // Two turns forward reach the week after next.
    const twice = await pageECO(forward.meta.resultId, 'fwd');
    expect(twice.data.window.from).toBe('2026-09-28');
  });

  it('shifts by day and by calendar month', async () => {
    const day = await runECO({ range: 'D' });
    expect(day.data.window).toMatchObject({ from: '2026-09-15', to: '2026-09-15' });
    const nextDay = await pageECO(day.meta.resultId, 'fwd');
    expect(nextDay.data.window.from).toBe('2026-09-16');

    const month = await runECO({ range: 'M' });
    expect(month.data.window).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-30',
      label: 'September 2026',
    });
    const nextMonth = await pageECO(month.meta.resultId, 'fwd');
    expect(nextMonth.data.window).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    const backAgain = await pageECO(nextMonth.meta.resultId, 'back');
    expect(backAgain.data.window).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('matches the committed golden', async () => {
    const { data } = await runECO();
    expectGolden(GOLDEN_NAME, normalise(data));
  });
});

describe('ECO — release detail', () => {
  it('lists the release history and every stored vintage of the revised period', async () => {
    const { data, meta } = await runECO({ releaseId: env.cpi.releaseId });
    expect(data.mode).toBe('release');
    const release = data.release;
    expect(release, 'release block is missing').not.toBeNull();
    expect(release!.name).toBe('Consumer Price Index');
    expect(release!.sourceId).toBe('fred.calendar');
    expect(release!.events.map((e) => e.periodLabel)).toEqual(['August 2026']);

    const series = release!.series;
    expect(series).toHaveLength(1);
    expect(series[0]!.units).toBe('Index 1982-1984=100');
    expect(series[0]!.frequency).toBe('M');
    // Point-in-time: the latest vintage per obs_date, oldest date first.
    expect(series[0]!.observations.map((o) => [o.obsDate, o.value])).toEqual([
      ['2026-07-01', 322.14],
      ['2026-08-01', 323.048],
    ]);
    expect(series[0]!.chart.map((p) => p.v)).toEqual([322.14, 323.048]);

    // The revision is data on screen: both vintages of 2026-07-01, oldest first.
    const july = series[0]!.revisions.find((g) => g.obsDate === '2026-07-01');
    expect(july, '2026-07-01 vintages are missing').toBeDefined();
    expect(july!.vintages.map((v) => [v.vintageAt, v.value, v.status])).toEqual([
      ['2026-08-12T12:30:00.000Z', 322.104, 'final'],
      ['2026-09-11T12:30:00.000Z', 322.14, 'revised'],
    ]);

    // Even here the consensus column is empty and says why.
    expect(release!.events.every((e) => e.consensus.v === null)).toBe(true);
    expect(meta.unavailable.some((u) => u.field === 'consensus')).toBe(true);
  });

  it('reproduces an earlier vintage when knownAt predates the revision', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/ECO/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { releaseId: env.cpi.releaseId },
        // Before the 2026-09-11 revision landed: July is still the original 322.104.
        asOf: { validAt: GOLDEN_ISO, knownAt: '2026-09-01T00:00:00.000Z' },
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const { data } = res.json<Run>();
    const observations = data.release!.series[0]!.observations;
    expect(observations.map((o) => [o.obsDate, o.value])).toEqual([['2026-07-01', 322.104]]);
  });

  it('says so when the release id is unknown', async () => {
    const { data, meta } = await runECO({ releaseId: 2_147_483_600 });
    expect(data.release).toBeNull();
    const note = meta.unavailable.find((u) => u.field === 'release');
    expect(note).toMatchObject({ reason: 'NO_SOURCE', detail: 'unknown release id' });
  });

  it('matches the committed release golden', async () => {
    const { data } = await runECO({ releaseId: env.cpi.releaseId });
    expectGolden(RELEASE_GOLDEN_NAME, normalise(data));
  });
});
