/**
 * `POST /api/v1/data` — the WP-08 acceptance row (WORKPLAN L1094): "API-02: the §12.1 worked
 * example returns the documented envelope with `asOf` and adjustment applied".
 *
 * This is the same claim `test/integration/data/request.test.ts` makes about the *dispatcher*,
 * made one layer up about the *shipped HTTP route*: the real `buildApp`, the real session guard,
 * the real `data:read` scope check, the real entitlement evaluator over the real
 * `licence_registry` and `field_licence` (`seed/licences.ts`), and the real quota counters. Nothing
 * between the socket and `bars_daily` is stubbed. A regression anywhere on that path — a missing
 * guard, an evaluator that denies a licensed field, an `asOf` the route drops on the floor, a
 * `meta` block the route forgets to stamp — fails here and nowhere else.
 *
 * ## The pair of requests is the point
 *
 * API.md §12.1 asks for AAPL's `PX_LAST` across the 2020-08-31 four-for-one split, twice:
 *
 *  - at `knownAt = 2026-09-15`, the split is known, so the closes come back **adjusted** —
 *    `[125.01, 124.8075, 129.04, 134.18]` — with `meta.adjustments` naming the step that did it;
 *  - at `knownAt = 2020-07-30`, the *same request* over the *same rows* comes back **unadjusted**
 *    — `[500.04, 499.23, …]` — with an empty `adjustments` array, because the split was recorded
 *    on 2020-07-31 and as of what we knew on the 30th it did not exist.
 *
 * That pair is REF-03 (bitemporal knowledge) and REF-09 (corporate-action adjustment) working
 * together, and it is the single strongest assertion in this package: a system that stores
 * adjusted prices, or that applies today's corporate actions to a backdated read, cannot produce
 * both answers. The adjusted value for 2020-08-28 is not written down here — it is read from
 * `fixtures/golden/analytics/adjust/aapl.json`, the same golden the analytics engine is tested
 * against, so screen, engine and file cannot drift apart.
 *
 * ## Self-sufficient (TESTING §4.3)
 *
 * WP-15 owns the seed and it does not exist. Every row this file asserts on it wrote itself inside
 * its own `withTxDb()` transaction — the firm, the user, the session, the entitlement grant, the
 * master chain, the four daily bars and the corporate action — and that transaction is also the
 * app's database handle, so the route reads exactly these rows and the whole lot rolls back.
 * `seed/licences.ts` runs inside it too (it is idempotent), because the terms under test must be
 * the *shipped* terms: `yahoo.chart`'s real attribution line and its real tier ceiling, not a
 * fixture's idea of them.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DataResponse } from '@terminal/sdk/wire/dataRequest';

import { getConfig } from '../../../src/config.js';
import {
  InstrumentRepository,
  IssueRepository,
  IssuerRepository,
  ListingRepository,
  MdLineRepository,
} from '../../../src/refdata/master.js';
import { recordAction } from '../../../src/refdata/corporateActions.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Instants and constants — API.md §12.1
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The master rows are true from here and were known from here. */
const VALID_FROM = new Date('2015-01-01T00:00:00Z');
const KNOWN_BASE = new Date('2015-01-02T00:00:00Z');

/** The instant §12.1 serves at. */
const SERVED_AT = '2026-09-15T18:41:30.002Z';

/** The two `knownAt` values that straddle the day the split was recorded. */
const KNOWN_NOW = '2026-09-15T00:00:00Z';
const KNOWN_BEFORE_SPLIT_RECORDED = '2020-07-30T00:00:00Z';

/** `tx_from` of the corporate-action version: the 4:1 split was recorded on 2020-07-31. */
const SPLIT_RECORDED_AT = new Date('2020-07-31T00:00:00Z');

/** Well before every instant here, so a grant written with it is live on the virtual clock. */
const GRANT_FROM = '2015-01-01T00:00:00.000Z';

/** The four published AAPL closes, **unadjusted**, exactly as `bars_daily` stores them. */
const AAPL_CLOSES: readonly (readonly [string, number])[] = [
  ['2020-08-27', 500.04],
  ['2020-08-28', 499.23],
  ['2020-08-31', 129.04],
  ['2020-09-01', 134.18],
];

/** The adjusted closes §12.1 documents, in the same order. */
const EXPECTED_ADJUSTED: readonly number[] = [125.01, 124.8075, 129.04, 134.18];

/**
 * `close.2020-08-28` from `fixtures/golden/analytics/adjust/aapl.json` — the published close run
 * through the same `adjust` engine, independently of this file's expectations.
 */
function goldenAdjustedClose(): number {
  const path = fileURLToPath(
    new URL('../../../../../fixtures/golden/analytics/adjust/aapl.json', import.meta.url),
  );
  const cases = JSON.parse(readFileSync(path, 'utf8')) as {
    id: string;
    expected: Record<string, number>;
  }[];
  const fixture = cases.find((c) => c.id === 'adjust.aapl.fixture');
  if (fixture === undefined) throw new Error('adjust.aapl.fixture is missing from the golden file');
  const close = fixture.expected['close.2020-08-28'];
  if (typeof close !== 'number') throw new Error('golden close.2020-08-28 is not a number');
  return close;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Actor {
  userId: number;
  firmId: number;
  /** `Cookie:` header value — the signed `tsid` a browser would present. */
  cookie: string;
}

interface Fixture {
  aapl: number;
  aaplMdLine: number;
  yahooProv: number;
  masterProv: number;
}

describe('POST /api/v1/data — API.md §12.1 (API-02, REF-03 + REF-09)', () => {
  const t: TestDb = withTxDb();
  const clock = testClock(SERVED_AT);

  let harness: TestApp;
  let app: FastifyInstance;
  let actor: Actor;
  let fixture: Fixture;

  /** One `provenance` row per source, against the shipped `licence_registry`. */
  async function provenance(): Promise<{ yahoo: number; master: number }> {
    const ids: Record<string, number> = {};
    for (const sourceId of ['yahoo.chart', 'internal.user']) {
      const res = await t.client.query<{ provenance_id: string }>(
        `INSERT INTO provenance (source_id, request_key, request_url, request_hash,
                                 response_sha256, http_status, bytes, captured_at, adapter_version)
         VALUES ($1, $2, 'test://wp08/data-request', digest($2, 'sha256'), digest($2, 'sha256'),
                 200, 0, timestamptz '2026-09-15T18:41:28Z', 'test/1.0.0')
         RETURNING provenance_id`,
        [sourceId, `wp08-data-request-${sourceId}-${randomUUID()}`],
      );
      ids[sourceId] = Number(res.rows[0]!.provenance_id);
    }
    return { yahoo: ids['yahoo.chart']!, master: ids['internal.user']! };
  }

  /** AAPL with a full master chain, written through WP-04's own repositories. */
  async function seedMaster(): Promise<Fixture> {
    const prov = await provenance();
    const opts = {
      validFrom: VALID_FROM,
      provenanceId: prov.master,
      knownAt: KNOWN_BASE,
      reason: 'initial' as const,
    };

    const issuerId = await new IssuerRepository(t.db).insert(
      {
        name: 'Apple Inc',
        legalName: 'Apple Inc',
        cik: '0000320193',
        country: 'US',
        entityType: 'operating',
      },
      opts,
    );
    const issueId = await new IssueRepository(t.db).insert(
      {
        issuerId,
        assetClass: 'equity',
        securityType: 'Common Stock',
        isin: 'US0378331005',
        name: 'Apple Inc',
        currency: 'USD',
        countryOfIssue: 'US',
      },
      opts,
    );
    const instrumentId = await new InstrumentRepository(t.db).insert(
      {
        issueId,
        assetClass: 'equity',
        marketSector: 'Equity',
        compositeFigi: 'BBG000B9XRY4',
        ticker: 'AAPL',
        exchCode: 'US',
        name: 'Apple Inc',
        currency: 'USD',
        searchWeight: 2,
      },
      opts,
    );
    await new ListingRepository(t.db).insert(
      {
        instrumentId,
        figi: 'BBG000B9Y5X2',
        mic: 'XNAS',
        exchCode: 'UW',
        localTicker: 'AAPL',
        isPrimary: true,
      },
      opts,
    );
    // No `identifiers` rows are written for this instrument, and that is deliberate.
    //
    // `SecurityResolver` resolves `'AAPL US Equity'` from `instruments.ticker` and `exch_code`;
    // the `TICKER_EXCH` and `COMPOSITE_FIGI` rows this fixture used to add were decoration that
    // nothing here asserts. What they DID do was claim a globally unique key —
    // `identifiers_bt_excl` is `EXCLUDE (scheme, value, qualifier, validity &&)` — that
    // `test/integration/refdata/resolve.test.ts` claims for the same real security. Two
    // `withTxDb` transactions in two forks, each holding one of those keys and waiting for the
    // other, is a deadlock, and which files a run schedules together then decides whether it is
    // green. `vitest.config.ts` records the same hazard for the replay project ("`secNport` and
    // `symbologyRefresh` both write Apple's ISIN") and solves it by serialising that project; a
    // file that simply does not claim a key it never reads needs no serialising at all.
    const mdLineId = await new MdLineRepository(t.db).insert(
      {
        instrumentId,
        sourceId: 'yahoo.chart',
        providerSymbol: 'AAPL',
        lineKind: 'composite',
        intrinsicDelayMin: 15,
        expectedIntervalMs: 10_000,
        priority: 10,
      },
      opts,
    );

    return {
      aapl: instrumentId,
      aaplMdLine: mdLineId,
      yahooProv: prov.yahoo,
      masterProv: prov.master,
    };
  }

  /** The four §12.1 sessions as stored: raw prints (DATA_MODEL §6.1 — bars are never adjusted). */
  async function seedDailyBars(f: Fixture): Promise<void> {
    for (const [date, close] of AAPL_CLOSES) {
      await t.client.query(
        `INSERT INTO bars_daily (instrument_id, session_date, md_line_id, open, high, low, close,
                                 volume, capture_ts, provenance_id)
         VALUES ($1, $2::date, $3, $4, $4, $4, $4, 1000000,
                 timestamptz '2026-09-15T18:41:28Z', $5)`,
        [f.aapl, date, f.aaplMdLine, close, f.yahooProv],
      );
    }
  }

  /**
   * The 4:1 split, ex 2020-08-31, **recorded on 2020-07-31**. `txFrom` is the whole point: without
   * it the version would take `now()` and the second request below would still see the split.
   */
  async function seedSplit(f: Fixture): Promise<void> {
    await recordAction(t.db, {
      instrumentId: f.aapl,
      caType: 'split',
      status: 'confirmed',
      exDate: '2020-08-31',
      ratioNew: 4,
      ratioOld: 1,
      sourceId: 'yahoo.chart',
      provenanceId: f.yahooProv,
      txFrom: SPLIT_RECORDED_AT,
    });
  }

  /**
   * A firm, a user, a live web session and the one entitlement grant that licenses the read.
   *
   * The grants are deliberately broad (every source, every asset class, every field class, up to
   * `realtime`): what this file is testing is the §12.1 envelope, not the evaluator's rule matrix,
   * which `test/integration/entitlements/` owns. What a grant CANNOT do is lift the licence
   * ceiling — `yahoo.chart` is capped by `licence_registry`, and `meta.tier` below is whatever
   * that ceiling and the reader's own tier agree on.
   */
  /**
   * The shipped licence terms, seeded only when they are missing.
   *
   * `seedLicences` is idempotent but not *silent*: on a database the global setup already seeded, it
   * still issues its inserts and updates against `licence_registry`, `field_licence` and
   * `config_versions`, taking row locks on rows every other integration file is also touching from
   * its own open transaction. Two such transactions taking those rows in different orders is a
   * deadlock, and `withTxDb` files run in parallel workers, so the pairing decides whether a run is
   * green. A read first makes the common case take no locks at all, while a database with no seed
   * still gets one.
   */
  async function ensureLicences(): Promise<void> {
    const present = await t.client.query(
      `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
    );
    if (present.rowCount === 0) await seedLicences(t.client);
  }

  async function seedActor(): Promise<Actor> {
    const firm = await t.client.query<{ firm_id: string }>(
      `INSERT INTO firms (name, seat_count) VALUES ($1, 5) RETURNING firm_id`,
      [`WP08 Data Firm ${randomUUID().slice(0, 8)}`],
    );
    const firmId = Number(firm.rows[0]!.firm_id);

    const user = await t.client.query<{ user_id: string }>(
      `INSERT INTO users (firm_id, email, display_name, role)
       VALUES ($1, $2, 'Demo PM', 'user') RETURNING user_id`,
      [firmId, `wp08-${randomUUID()}@demo.invalid`],
    );
    const userId = Number(user.rows[0]!.user_id);

    // BOTH halves of ARCHITECTURE §10: rule 4 is the firm's contract and rule 5 the user's
    // subscription under it. A firm grant alone is `NO_USER_ENTITLEMENT`, which is the design —
    // buying the data for the desk is not the same as seating somebody at it.
    for (const subject of [
      ['firm', firmId],
      ['user', userId],
    ] as const) {
      await t.client.query(
        `INSERT INTO entitlement_grants
           (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
            usage_display, usage_export, usage_api, valid_from, valid_to)
         VALUES ($1, $2, NULL, NULL, NULL, 'realtime', true, true, true,
                 $3::timestamptz, 'infinity')`,
        [subject[0], subject[1], GRANT_FROM],
      );
    }

    const token = `sess-${randomUUID()}`;
    await t.client.query(
      `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
       VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
      [userId, createHash('sha256').update(token, 'utf8').digest()],
    );
    const signed = cookie.sign(token, getConfig().SESSION_SECRET);

    return { userId, firmId, cookie: `tsid=${encodeURIComponent(signed)}` };
  }

  beforeEach(async () => {
    // The SHIPPED terms, inside this transaction: `yahoo.chart`'s real attribution and tier
    // ceiling, and the `field_licence` row that makes `PX_LAST` a licensed field at all.
    await ensureLicences();
    fixture = await seedMaster();
    await seedDailyBars(fixture);
    await seedSplit(fixture);
    actor = await seedActor();

    harness = await createTestApp({ db: t.db, clock });
    app = harness.app;
  });

  afterEach(async () => {
    await harness.close();
  });

  /** The §12.1 request, at whichever `knownAt` the case is about. */
  async function post(knownAt: string, traceId: string): Promise<{ status: number; body: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/data',
      headers: {
        cookie: actor.cookie,
        'x-requested-with': 'terminal',
        'x-trace-id': traceId,
      },
      payload: {
        kind: 'historical',
        securities: [{ ref: 'AAPL US Equity' }],
        fields: ['PX_LAST'],
        start: '2020-08-27',
        end: '2020-09-01',
        adjust: 'price',
        asOf: { knownAt },
      },
    });
    return { status: res.statusCode, body: res.body };
  }

  // ── The worked example, value for value ────────────────────────────────────────────────────

  it('at knownAt 2026-09-15 returns the documented envelope with the split applied', async () => {
    const traceId = randomUUID();
    const res = await post(KNOWN_NOW, traceId);
    expect(res.status, res.body).toBe(200);

    // The strongest shape assertion available: the SDK's own schema for the response.
    const payload = DataResponse.parse(JSON.parse(res.body));

    expect(payload.results).toHaveLength(1);
    const only = payload.results[0]!;
    expect(only.security).toEqual({ ref: 'AAPL US Equity' });
    expect(only.error).toBeUndefined();
    expect(only.instrument?.instrumentId).toBe(fixture.aapl);
    expect(only.instrument?.display).toBe('AAPL US Equity');
    expect(only.instrument?.compositeFigi).toBe('BBG000B9XRY4');
    expect(only.instrument?.name).toBe('Apple Inc');
    expect(only.instrument?.currency).toBe('USD');
    expect(only.tier).toBe('eod');
    expect(only.st).toBe('closed');

    const series = only.series!;
    expect(series.columns).toEqual(['PX_LAST']);
    expect(series.index).toEqual(['2020-08-27', '2020-08-28', '2020-08-31', '2020-09-01']);
    expect(series.adjust).toBe('price');
    expect(series.currency).toBe('USD');

    // REF-09 — the adjusted closes of §12.1, and the 28 August value cross-checked against the
    // analytics golden rather than against this file's own expectation.
    const closes = series.rows.map((row) => row[0]);
    expect(closes).toHaveLength(4);
    for (const [i, expected] of EXPECTED_ADJUSTED.entries()) {
      expect(closes[i]).toBeCloseTo(expected, 4);
    }
    expect(closes[1]).toBeCloseTo(goldenAdjustedClose(), 4);

    // The step that did it, exactly as documented.
    expect(payload.meta.adjustments).toEqual([
      { beforeDate: '2020-08-31', priceFactor: 0.25, volumeFactor: 4, kind: 'split' },
    ]);

    // ANAL-08: the engine that ran is named, with a hash of its inputs.
    expect(payload.meta.engines.map((e) => e.name)).toContain('adjust');
    expect(payload.meta.engines[0]!.inputsHash).toMatch(/^[0-9a-f]{64}$/);

    // DATA-10: every value block cites `meta.provenance`, and DATA-09 attribution is joined from
    // `licence_registry` — read back from the table rather than written down twice.
    expect(series.provIdx.length).toBeGreaterThan(0);
    for (const idx of series.provIdx) {
      expect(payload.meta.provenance[idx]?.sourceId).toBe('yahoo.chart');
    }
    const licence = await t.client.query<{ attribution: string }>(
      `SELECT attribution FROM licence_registry
        WHERE source_id = 'yahoo.chart' AND tx_to = 'infinity'`,
    );
    const attribution = licence.rows[0]!.attribution;
    expect(attribution).not.toBe('');
    expect(payload.meta.provenance[0]?.attribution).toBe(attribution);
    expect(payload.meta.provenance[0]?.capturedAt).toBe('2026-09-15T18:41:28.000Z');

    // Rule 4 — `meta.asOf` reports the pair that was USED; rule 7 charges rows × columns.
    expect(payload.meta.asOf.knownAt).toBe('2026-09-15T00:00:00.000Z');
    expect(payload.meta.asOf.validAt).toBe(SERVED_AT);
    expect(payload.meta.servedAt).toBe(SERVED_AT);
    expect(payload.meta.tier).toBe('eod');
    expect(payload.meta.staleness).toBe('closed');
    expect(payload.meta.quota).toEqual({ dataPointsCharged: 4, uniqueInstrumentsAdded: 1 });

    // ENTL-05: a licensed field is served whole — no downgrade note, nothing unavailable.
    expect(payload.meta.entitlement).toEqual([]);
    expect(payload.meta.unavailable).toEqual([]);

    // Every response carries the trace id, body and header alike (API.md §2 L196).
    expect(payload.meta.traceId).toBe(traceId);
  });

  it('at knownAt 2020-07-30 returns the unadjusted closes and no adjustment steps (REF-03)', async () => {
    const traceId = randomUUID();
    const res = await post(KNOWN_BEFORE_SPLIT_RECORDED, traceId);
    expect(res.status, res.body).toBe(200);

    const payload = DataResponse.parse(JSON.parse(res.body));
    const series = payload.results[0]!.series!;
    const closes = series.rows.map((row) => row[0]);

    // The published prints, untouched: the split was recorded on 2020-07-31, so as of what we
    // knew on the 30th it does not exist.
    for (const [i, [, close]] of AAPL_CLOSES.entries()) {
      expect(closes[i]).toBeCloseTo(close, 4);
    }
    expect(payload.meta.adjustments).toEqual([]);
    expect(payload.meta.asOf.knownAt).toBe('2020-07-30T00:00:00.000Z');

    // Same request, same rows, same instrument — only the knowledge instant moved.
    expect(payload.results[0]!.instrument?.instrumentId).toBe(fixture.aapl);
    expect(series.index).toEqual(['2020-08-27', '2020-08-28', '2020-08-31', '2020-09-01']);
    expect(series.adjust).toBe('price');
  });

  // ── The guards in front of it ──────────────────────────────────────────────────────────────

  it('refuses an anonymous caller with 401 AUTH_REQUIRED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/data',
      headers: { 'x-requested-with': 'terminal' },
      payload: {
        kind: 'historical',
        securities: [{ ref: 'AAPL US Equity' }],
        fields: ['PX_LAST'],
        start: '2020-08-27',
        end: '2020-09-01',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_REQUIRED');
    expect(res.headers['x-trace-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
