/**
 * `test/integration/functions/FXC.test.ts` — WP-10's acceptance row for `FXC`
 * ("G10 matrix: direct pairs live, crosses derived via USD, ECB reference toggle switches source
 * and attribution").
 *
 * Nine dollar pairs are seeded as real instruments with `fx_terms`; eight are quoted on the plant
 * and `USDSEK` deliberately is not. That one omission is doing three jobs at once:
 *
 *  - it proves §0.4 rules 1–2 — an unpolled monitor subject is **pending** (`blank`, `provIdx: -1`,
 *    no reason code), never a provider call on the request path;
 *  - it proves that a cross with one null leg is `na` with a `NO_SOURCE` note, not the surviving
 *    leg on its own and never `NaN`;
 *  - it leaves the other 70-odd crosses computed, so "one missing leg" costs exactly the cells
 *    that depend on it.
 *
 * Every pair carries its **own** provenance row, because the acceptance row is specifically that a
 * derived cross cites the provenance of **both** legs. A test where every quote shares one capture
 * would pass against a resolver that cited one leg twice, which is the bug this is written to
 * catch: `legProvIdx` must hold two distinct indices, both present in `meta.provenance`, in the
 * order the derivation string names them.
 *
 * The ECB toggle is asserted end to end: the same axes, a different source id in every provenance
 * row, a different attribution line on the footer, and `chgPct1d` `na` with a reason — because the
 * ECB publishes one fixing a day and there is no intraday change to show.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NormalisedUpdate, PayloadMeta, QuoteFields } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { FXC } from '@terminal/core/functions/manifests/FXC';
import type { FxcCell, FxcPayload } from '@terminal/core/functions/manifests/FXC';

import type { FunctionServerModule } from '../../../src/functions/context.js';
import * as FXCModule from '../../../src/functions/FXC/resolve.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
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
const GOLDEN_NAME = 'FXC.default.json';
const ECB_GOLDEN_NAME = 'FXC.ecb.json';
const FIXING_DATE = '2026-09-15';

const SYMBOL_TAG = `.t${randomUUID().slice(0, 8)}`;

const REGISTRY = new FunctionRegistry([FXC]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { FXC: FXCModule };

const t: TestDb = withTxDb();

/** `[ticker, base, quote, pipSize, live mid, ECB fixing]`; `null` = deliberately never polled. */
const PAIRS: readonly [string, string, string, number, number | null, number][] = [
  ['EURUSD', 'EUR', 'USD', 0.0001, 1.1543, 1.1539],
  ['GBPUSD', 'GBP', 'USD', 0.0001, 1.3482, 1.348],
  ['USDJPY', 'USD', 'JPY', 0.01, 155.0, 154.92],
  ['USDCHF', 'USD', 'CHF', 0.0001, 0.8182, 0.8185],
  ['USDCAD', 'USD', 'CAD', 0.0001, 1.351, 1.3505],
  ['AUDUSD', 'AUD', 'USD', 0.0001, 0.6721, 0.6725],
  ['NZDUSD', 'NZD', 'USD', 0.0001, 0.6012, 0.6015],
  ['USDSEK', 'USD', 'SEK', 0.0001, null, 9.42],
  ['USDNOK', 'USD', 'NOK', 0.0001, 10.15, 10.155],
];

interface SeededPair {
  ticker: string;
  instrumentId: number;
  mdLineId: number;
  provenanceId: number;
}

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  pairs: Record<string, SeededPair>;
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

async function seedPair(
  ticker: string,
  base: string,
  quote: string,
  pipSize: number,
): Promise<SeededPair> {
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, 'internal.user', `fxc-${ticker}`);
  // One capture per pair: the cross assertions need two DISTINCT provenance indices.
  const quoteProv = await bootstrapProvenance(t, 'yahoo.chart', `fxc-quote-${ticker}`);
  const o = { validFrom: VALID_FROM, provenanceId };

  const issuerId = await repos.issuers.insert({ name: `${ticker} issuer` }, o);
  const issueId = await repos.issues.insert(
    { issuerId, assetClass: 'fx', securityType: 'Spot', name: `${base}/${quote}`, currency: quote },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass: 'fx',
      marketSector: 'Curncy',
      ticker,
      exchCode: 'FX',
      name: `${base}-${quote}`,
      currency: quote,
      searchWeight: 50,
    },
    o,
  );
  const { mdLineId } = await repos.mdLines.upsertBySymbol(
    {
      instrumentId,
      sourceId: 'yahoo.chart',
      providerSymbol: `${ticker}=X${SYMBOL_TAG}`,
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 10_000,
      priority: 10,
    },
    o,
  );
  await t.client.query(
    `INSERT INTO fx_terms (instrument_id, base_ccy, quote_ccy, spot_lag, calendar_id, pip_size,
                           quote_convention, valid_from, provenance_id)
     VALUES ($1, $2, $3, 2, 'FX_USD', $4, 'quote_per_base', $5::timestamptz, $6)`,
    [instrumentId, base, quote, pipSize, VALID_FROM.toISOString(), provenanceId],
  );
  return { ticker, instrumentId, mdLineId, provenanceId: quoteProv };
}

function quote(seeded: SeededPair, fields: Partial<QuoteFields>): NormalisedUpdate {
  return {
    subject: `q:${String(seeded.instrumentId)}`,
    instrumentId: seeded.instrumentId,
    mdLineId: seeded.mdLineId,
    assetClass: 'fx',
    tier: 'delayed',
    fields,
    ts: { src: GOLDEN_CAPTURE_MS - 900_000, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: { sourceId: 'yahoo.chart', provenanceId: seeded.provenanceId },
  };
}

beforeEach(async () => {
  await ensureLicences();
  const session = await createWebSession(t, { email: `fxc-${randomUUID()}@demo.invalid` });
  await grantEverySource(session.firmId, session.userId);

  const pairs: Record<string, SeededPair> = {};
  for (const [ticker, base, quoteCcy, pipSize] of PAIRS) {
    pairs[ticker] = await seedPair(ticker, base, quoteCcy, pipSize);
  }

  // The ECB reference fixings, both directions, exactly as `frankfurter` stores them
  // (PROVIDERS §5.7) so the matrix needs no conditional inversion.
  const ecbProv = await bootstrapProvenance(t, 'frankfurter', 'fxc-ecb');
  for (const [, base, quoteCcy, , , fixing] of PAIRS) {
    await t.client.query(
      `INSERT INTO fx_rates (base_ccy, quote_ccy, rate_date, rate, source_id, provenance_id)
       VALUES ($1, $2, $3::date, $4, 'frankfurter', $5),
              ($2, $1, $3::date, $6, 'frankfurter', $5)
       ON CONFLICT DO NOTHING`,
      [base, quoteCcy, FIXING_DATE, fixing, ecbProv, 1 / fixing],
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

  for (const [ticker, , , , mid] of PAIRS) {
    if (mid === null) continue; // USDSEK: never polled, on purpose.
    harness.deps.plant.apply(
      quote(pairs[ticker]!, {
        PX_LAST: mid,
        CHG_NET_1D: 0.001,
        CHG_PCT_1D: 0.05,
        PX_OPEN: mid,
        PX_HIGH: mid,
        PX_LOW: mid,
        PX_CLOSE_1D: mid,
      }),
    );
  }

  env = { harness, app: harness.app, clock, cookie: session.cookie, knownAt, pairs };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: FxcPayload;
  meta: PayloadMeta;
}

async function runFXC(params: Record<string, unknown> = {}): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/FXC/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

function cellOf(payload: FxcPayload, base: string, quote: string): FxcCell {
  const i = payload.ccys.indexOf(base);
  const j = payload.ccys.indexOf(quote);
  expect(i, `${base} is not on the base axis`).toBeGreaterThanOrEqual(0);
  expect(j, `${quote} is not on the quote axis`).toBeGreaterThanOrEqual(0);
  const cell = payload.matrix[i]?.[j];
  expect(cell, `${base}/${quote} is missing from the matrix`).toBeDefined();
  return cell!;
}

/**
 * The one key in an FXC payload that holds a sequence-allocated id: a matrix cell's
 * `instrumentId`. `legSourceIds` is a list of provider names (`'frankfurter'`), and a column's
 * `id`/`fieldId` (`'PX_LAST'`) is a field name.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId']);

function normalise(payload: FxcPayload): unknown {
  const tokens = new Map<number, string>(
    Object.values(env.pairs).map((p) => [p.instrumentId, `<${p.ticker}>`]),
  );
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (typeof value === 'string') return subjectToken(value, tokens);
    // A hundred cross rates and their epoch `ts`, matched by key rather than by value: the matrix
    // is a hundred numbers the old rule could rename on the run where the instrument sequence
    // reached one of them.
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

describe('FXC — the G10 matrix, live', () => {
  it('builds a ten-by-ten matrix over the seeded currencies', async () => {
    const { data } = await runFXC();
    expect(data.variant).toBe('default');
    expect(data.quote).toBe('live');
    expect(data.rateDate).toBeNull();
    expect(data.ccys).toEqual(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK']);
    expect(data.matrix).toHaveLength(10);
    expect(data.matrix.every((row) => row.length === 10)).toBe(true);
    expect(data.missing).toEqual([]);
    expect(data.notes).toContain('INDICATIVE_MID_ONLY');
    expect(data.notes).toContain('NO_FX_DEPTH_SOURCE');
    expect(data.notes).toContain('CROSSES_DERIVED_VIA_USD');
  });

  it('carries the diagonal as unity with no number and no citation', async () => {
    const { data } = await runFXC();
    for (const ccy of data.ccys) {
      const cell = cellOf(data, ccy, ccy);
      expect(cell.kind).toBe('unity');
      // A currency has no rate against itself and nothing publishes one: the payload carries
      // `null` rather than a `1` that would have to cite a source it does not have.
      expect(cell.rate.v).toBeNull();
      expect(cell.rate.provIdx).toBe(-1);
      expect(cell.derivation).toBeNull();
      expect(cell.via).toBeNull();
    }
  });

  it('serves a seeded pair as a live direct cell', async () => {
    const { data, meta } = await runFXC();
    const eurusd = cellOf(data, 'EUR', 'USD');
    expect(eurusd.kind).toBe('direct');
    expect(eurusd.rate.v).toBe(1.1543);
    expect(eurusd.key).toBe('EURUSD Curncy');
    expect(eurusd.subject).toBe(`q:${String(env.pairs.EURUSD!.instrumentId)}`);
    expect(eurusd.rate.live).toEqual({ subject: eurusd.subject, field: 'PX_LAST' });
    expect(eurusd.decimals).toBe(4);
    expect(eurusd.via).toBeNull();
    expect(eurusd.legSourceIds).toEqual(['yahoo.chart']);
    expect(eurusd.legProvIdx).toHaveLength(1);
    expect(meta.provenance.some((p) => p.idx === eurusd.legProvIdx[0])).toBe(true);

    // The pip size decides the display decimals: JPY pairs are 2 dp, the rest 4.
    expect(cellOf(data, 'USD', 'JPY').decimals).toBe(2);
  });

  it('inverts a quoted pair rather than inventing a second quote', async () => {
    const { data } = await runFXC();
    const direct = cellOf(data, 'EUR', 'USD');
    const inverse = cellOf(data, 'USD', 'EUR');
    expect(inverse.kind).toBe('inverse');
    expect(inverse.rate.v).toBeCloseTo(1 / 1.1543, 12);
    expect(inverse.derivation).toBe('1 / EURUSD');
    // The same citation as the cell it is derived from, and no live binding of its own: the screen
    // recomputes it from the direct cell so a tick flashes once (TERM-08).
    expect(inverse.rate.provIdx).toBe(direct.rate.provIdx);
    expect(inverse.subject).toBeNull();
    expect(inverse.rate.live).toBeUndefined();
  });

  it('derives a cross through the dollar and cites BOTH legs', async () => {
    const { data, meta } = await runFXC();
    const eurjpy = cellOf(data, 'EUR', 'JPY');
    expect(eurjpy.kind).toBe('cross');
    expect(eurjpy.via).toBe('USD');
    expect(eurjpy.derivation).toBe('EURUSD × USDJPY');
    expect(eurjpy.rate.v).toBeCloseTo(1.1543 * 155, 10);
    expect(eurjpy.key).toBeNull();
    expect(eurjpy.subject).toBeNull();

    // The acceptance row: two legs, two DISTINCT provenance rows, in derivation order, both real.
    expect(eurjpy.legProvIdx).toHaveLength(2);
    expect(new Set(eurjpy.legProvIdx).size).toBe(2);
    const base = cellOf(data, 'EUR', 'USD');
    const vehicle = cellOf(data, 'USD', 'JPY');
    expect(eurjpy.legProvIdx).toEqual([base.rate.provIdx, vehicle.rate.provIdx]);
    for (const idx of eurjpy.legProvIdx) {
      expect(meta.provenance.some((p) => p.idx === idx)).toBe(true);
    }
    expect(eurjpy.legSourceIds).toEqual(['yahoo.chart', 'yahoo.chart']);
    // §FXC step 3: the cell's own `provIdx` is the base leg's.
    expect(eurjpy.rate.provIdx).toBe(base.rate.provIdx);
  });

  it('crosses two non-dollar currencies through an inverted leg', async () => {
    const { data } = await runFXC();
    const gbpjpy = cellOf(data, 'GBP', 'JPY');
    expect(gbpjpy.kind).toBe('cross');
    expect(gbpjpy.rate.v).toBeCloseTo(1.3482 * 155, 10);

    // CHF is quoted USDCHF, so CHF→JPY needs 1/USDCHF for its first leg and says so.
    const chfjpy = cellOf(data, 'CHF', 'JPY');
    expect(chfjpy.derivation).toBe('1 / USDCHF × USDJPY');
    expect(chfjpy.rate.v).toBeCloseTo((1 / 0.8182) * 155, 10);
  });

  it('round-trips through every triangle on the seeded matrix', async () => {
    const { data } = await runFXC();
    const priced = data.ccys.filter((c) => c !== 'SEK');
    for (const a of priced) {
      for (const b of priced) {
        for (const c of priced) {
          if (a === b || b === c || a === c) continue;
          const ab = cellOf(data, a, b).rate.v as number;
          const bc = cellOf(data, b, c).rate.v as number;
          const ca = cellOf(data, c, a).rate.v as number;
          expect(ab * bc * ca, `${a}${b}${c}`).toBeCloseTo(1, 9);
        }
      }
    }
  });

  it('leaves an unpolled pair pending and its crosses na — never a half-built number', async () => {
    const { data, meta } = await runFXC();
    // §0.4 rules 1–2: the scheduler has not polled USDSEK and a monitor never fetches.
    const usdsek = cellOf(data, 'USD', 'SEK');
    expect(usdsek.kind).toBe('direct');
    expect(usdsek.rate.v).toBeNull();
    expect(usdsek.rate.st).toBe('blank');
    expect(usdsek.rate.provIdx).toBe(-1);
    expect(usdsek.rate.r).toBeUndefined();

    const eursek = cellOf(data, 'EUR', 'SEK');
    expect(eursek.kind).toBe('cross');
    expect(eursek.rate.v).toBeNull();
    expect(eursek.rate.st).toBe('na');
    expect(Number.isNaN(eursek.rate.v as unknown as number)).toBe(false);
    const note = meta.unavailable.find((u) => u.field === 'matrix.EURSEK');
    expect(note).toMatchObject({
      reason: 'NO_SOURCE',
      detail: 'one leg of the cross is unavailable',
    });

    // Exactly the cells that depend on SEK are missing; the rest of the matrix is computed.
    const nulls = data.matrix
      .flat()
      .filter((c) => c.kind !== 'unity' && c.rate.v === null)
      .map((c) => `${c.base}${c.quote}`);
    expect(nulls.every((k) => k.includes('SEK'))).toBe(true);
    expect(nulls).toHaveLength(18);
  });

  it('drops a currency with no path to the dollar and says why', async () => {
    const { data, meta } = await runFXC({ ccys: ['USD', 'EUR', 'JPY', 'ZAR'] });
    expect(data.ccys).toEqual(['USD', 'EUR', 'JPY']);
    expect(data.missing).toEqual(['ZAR']);
    expect(data.matrix).toHaveLength(3);
    const note = meta.unavailable.find((u) => u.field === 'ZAR');
    expect(note).toMatchObject({
      reason: 'NO_SOURCE',
      detail: 'no seeded USD pair for this currency',
    });
  });

  it('transposes the axes without changing any cell', async () => {
    const plain = await runFXC({ ccys: ['USD', 'EUR', 'JPY'] });
    const swapped = await runFXC({ ccys: ['USD', 'EUR', 'JPY'], transpose: true });
    expect(swapped.data.ccys).toEqual(plain.data.ccys);
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        expect(swapped.data.matrix[i]![j]).toEqual(plain.data.matrix[j]![i]);
      }
    }
  });

  it('overrides the pip-derived decimals on request', async () => {
    const { data } = await runFXC({ decimals: '5' });
    expect(data.matrix.flat().every((c) => c.decimals === 5)).toBe(true);
    // The payload still carries full precision: rounding is a display concern (API-05).
    expect(cellOf(data, 'EUR', 'JPY').rate.v).toBeCloseTo(1.1543 * 155, 10);
  });

  it('compares the delayed mid with the ECB fixing of the same day', async () => {
    const { data } = await runFXC();
    expect(data.ecbCompare).not.toBeNull();
    const eur = data.ecbCompare!.find((r) => r.base === 'EUR' && r.quote === 'USD')!;
    expect(eur.live).toBe(1.1543);
    expect(eur.ecb).toBe(1.1539);
    expect(eur.diffPct).toBeCloseTo((1.1543 / 1.1539 - 1) * 100, 10);

    // The unpolled pair states the gap rather than reporting a zero difference.
    const sek = data.ecbCompare!.find((r) => r.base === 'USD' && r.quote === 'SEK')!;
    expect(sek.live).toBeNull();
    expect(sek.diffPct).toBeNull();
  });

  it('declares the two things the reachable FX sources never publish', async () => {
    const { meta } = await runFXC();
    const depth = meta.unavailable.find((u) => u.field === 'bidAsk');
    expect(depth).toMatchObject({ reason: 'NO_SOURCE' });
    expect(depth!.detail).toContain('NO_FX_DEPTH_SOURCE');
    const forwards = meta.unavailable.find((u) => u.field === 'forwardPoints');
    expect(forwards).toMatchObject({ reason: 'NOT_APPLICABLE' });
    expect(forwards!.detail).toContain('NO_FORWARD_POINTS_SOURCE');
  });

  it('matches the committed golden', async () => {
    const { data } = await runFXC();
    expectGolden(GOLDEN_NAME, normalise(data));
  });
});

describe('FXC — the ECB reference toggle', () => {
  it('switches the source and the attribution, not just the numbers', async () => {
    const live = await runFXC();
    const ecb = await runFXC({ quote: 'ecb' });

    expect(ecb.data.quote).toBe('ecb');
    expect(ecb.data.rateDate).toBe(FIXING_DATE);
    expect(ecb.data.ccys).toEqual(live.data.ccys);

    // The source id changes on every provenance row...
    const liveSources = new Set(live.meta.provenance.map((p) => p.sourceId));
    const ecbSources = new Set(ecb.meta.provenance.map((p) => p.sourceId));
    expect(liveSources).toEqual(new Set(['yahoo.chart']));
    expect(ecbSources).toEqual(new Set(['frankfurter']));

    // ...and so does the attribution line the footer and the CSV header carry (DATA-09).
    const liveAttribution = [...new Set(live.meta.provenance.map((p) => p.attribution))];
    const ecbAttribution = [...new Set(ecb.meta.provenance.map((p) => p.attribution))];
    expect(liveAttribution).toHaveLength(1);
    expect(ecbAttribution).toHaveLength(1);
    expect(ecbAttribution[0]).not.toBe(liveAttribution[0]);
    expect(liveAttribution[0]).toMatch(/Yahoo/i);
    expect(ecbAttribution[0]).toMatch(/European Central Bank|ECB/i);
  });

  it('reads both stored directions, so no cell needs a conditional inversion', async () => {
    const { data } = await runFXC({ quote: 'ecb' });
    const eurusd = cellOf(data, 'EUR', 'USD');
    expect(eurusd.kind).toBe('direct');
    expect(eurusd.rate.v).toBe(1.1539);
    expect(eurusd.rate.st).toBe('closed');
    // A stored fixing is not live: no subscription, no flash.
    expect(eurusd.rate.live).toBeUndefined();
    expect(eurusd.legSourceIds).toEqual(['frankfurter']);

    // `fx_rates.rate` is `numeric(18,8)`, so the stored reciprocal is the published one rounded to
    // eight places — not the resolver's own division. That is the point of storing both
    // directions: the payload carries what the publisher published.
    const usdeur = cellOf(data, 'USD', 'EUR');
    expect(usdeur.kind).toBe('direct');
    expect(usdeur.rate.v).toBeCloseTo(1 / 1.1539, 8);
  });

  it('fills the pair grid from the fixings and says there is no intraday change', async () => {
    const { data, meta } = await runFXC({ quote: 'ecb' });
    expect(data.pairs).toHaveLength(9);
    const eur = data.pairs.find((r) => r.key === 'EURUSD Curncy')!;
    expect(eur.cells.PX_LAST!.v).toBe(1.1539);
    expect(eur.cells.PX_OPEN!.v).toBeNull();

    expect(data.matrix.flat().every((c) => c.chgPct1d.v === null)).toBe(true);
    const note = meta.unavailable.find((u) => u.field === 'chgPct1d');
    expect(note).toMatchObject({ reason: 'NOT_APPLICABLE' });
    expect(note!.detail).toContain('one daily fixing');

    // The ECB tab has nothing to stream.
    expect(data.ecbCompare).toBeNull();
  });

  it('serves every SEK cell the live tab could not', async () => {
    const { data } = await runFXC({ quote: 'ecb' });
    expect(cellOf(data, 'USD', 'SEK').rate.v).toBe(9.42);
    expect(cellOf(data, 'EUR', 'SEK').rate.v).toBeCloseTo(1.1539 * 9.42, 10);
    expect(data.matrix.flat().filter((c) => c.kind !== 'unity' && c.rate.v === null)).toHaveLength(
      0,
    );
  });

  it('matches the committed ECB golden', async () => {
    const { data } = await runFXC({ quote: 'ecb' });
    expectGolden(ECB_GOLDEN_NAME, normalise(data));
  });
});
