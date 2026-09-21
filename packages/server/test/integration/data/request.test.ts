/**
 * `data/request.ts` — WP-04 acceptance row 8 (WORKPLAN L764): the `DataRequest` examples of
 * API.md §4 and §12.1 dispatch to the right service and return the documented envelope.
 *
 * Every assertion here is about the *dispatcher*, not about the readers it routes to:
 *
 *  - each of the five `kind`s reaches its own service and comes back in the block that kind is
 *    documented to fill (`fields`/`fprov` for reference and realtime, `series` for historical and
 *    intraday, `ticks`/`nextCursor` for tick, plus `subject` for realtime);
 *  - the whole response re-parses under `DataResponse` from `@terminal/sdk/wire/dataRequest`.
 *    That is the strongest statement this file can make: the server cannot emit a shape the SDK
 *    would reject, because the SDK's own schema is the assertion;
 *  - the §12.1 worked example reproduces value for value — `PX_LAST` for AAPL across the
 *    2020-08-31 4:1 split at `knownAt = 2026-09-15` is `[125.01, 124.8075, 129.04, 134.18]` with
 *    `meta.adjustments` naming the split, and the *same request* at `knownAt = 2020-07-30` is
 *    `[500.04, 499.23, …]` with an empty `adjustments`, because the split was not recorded until
 *    2020-07-31 (REF-03 + REF-09 together);
 *  - the seven numbered rules of API.md §4: per-result errors keep the response `200` (1),
 *    entitlement runs once and denies per field (2), `adjust` applies as of `knownAt` (3),
 *    `meta.asOf` reports the effective pair (4), ticks are `capTs`-ascending (5), realtime names a
 *    subject (6) and `meta.quota` charges the documented unit (7).
 *
 * **Self-sufficient by construction.** WP-15 owns the seed modules and they do not exist yet, so
 * the fixture builds every row it needs — licence registry, provenance, the master chain,
 * `bars_daily`, `bars_intraday`, `quote_ticks`, `quote_snapshots`, the corporate action — through
 * this package's own repositories inside the test's own transaction, which the harness rolls back.
 * No assertion depends on a row this file did not write, not even a count.
 */

import type { QuoteState } from '@terminal/core';
import { DataResponse } from '@terminal/sdk/wire/dataRequest';
import { describe, expect, it } from 'vitest';

import {
  ProvenanceIndex,
  buildDataSources,
  createDispatcher,
  dataDeps,
  type DataSources,
} from '../../../src/data/request.js';
import { AppError } from '../../../src/http/errors.js';
import { IdentifierRepository } from '../../../src/refdata/identifiers.js';
import {
  InstrumentRepository,
  IssueRepository,
  IssuerRepository,
  ListingRepository,
  MdLineRepository,
} from '../../../src/refdata/master.js';
import { recordAction } from '../../../src/refdata/corporateActions.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { frozenClock } from '../../../src/test/clock.js';

import type { AsOf } from '../../../src/db/bitemporal.js';

// ── Instants ─────────────────────────────────────────────────────────────────────────────────

/** The master rows are true from here and were known from here. */
const VALID_FROM = new Date('2015-01-01T00:00:00Z');
const KNOWN_BASE = new Date('2015-01-02T00:00:00Z');

/** API.md §12.1: the read instant, and the two `knownAt` values that straddle the split's record. */
const KNOWN_NOW = '2026-09-15T00:00:00Z';
const KNOWN_BEFORE_SPLIT_RECORDED = '2020-07-30T00:00:00Z';
/** The 4:1 split was recorded on 2020-07-31 — `tx_from` on the `corporate_actions` version. */
const SPLIT_RECORDED_AT = new Date('2020-07-31T00:00:00Z');

/** `meta.traceId` is a uuid on the wire. */
const TRACE_ID = '5c0e1b62-6f3a-4f2e-9a71-0c9d3d8e5a10';

const CLOCK = frozenClock('2026-09-15T18:41:30.002Z');

/** The four published AAPL closes of API.md §12.1, **unadjusted** as `bars_daily` stores them. */
const AAPL_CLOSES: readonly (readonly [string, number])[] = [
  ['2020-08-27', 500.04],
  ['2020-08-28', 499.23],
  ['2020-08-31', 129.04],
  ['2020-09-01', 134.18],
];

interface Fixture {
  aapl: number;
  msft: number;
  aaplMdLine: number;
  msftMdLine: number;
  yahooProv: number;
  cboeProv: number;
  masterProv: number;
}

describe('DataRequest dispatcher (API-02, API.md §4 and §12.1)', () => {
  const t = withTxDb();

  // ── the fixture ────────────────────────────────────────────────────────────────────────────

  /** A licence row per source and one `provenance` row against each — nothing writes without one. */
  async function provenance(t: TestDb): Promise<{ yahoo: number; cboe: number; master: number }> {
    for (const [sourceId, name, kind, attribution] of [
      ['internal.user', 'Internal / user supplied', 'internal', 'Internal'],
      ['cboe.quotes', 'Cboe One Summary', 'exchange_delayed', 'Cboe One Summary (15-min delayed)'],
      [
        'yahoo.chart',
        'Yahoo Finance chart v8',
        'unofficial',
        'Yahoo Finance chart v8 (unofficial; 15-min delayed)',
      ],
    ] as const) {
      await t.client.query(
        `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind,
                                       attribution, rate_limit, valid_from)
         SELECT $1, $2, 'Terminal', $3, $4, 'n/a', timestamptz '2000-01-01'
          WHERE NOT EXISTS (SELECT 1 FROM licence_registry
                             WHERE source_id = $1 AND tx_to = 'infinity')`,
        [sourceId, name, kind, attribution],
      );
    }
    const ids: Record<string, number> = {};
    for (const sourceId of ['yahoo.chart', 'cboe.quotes', 'internal.user']) {
      const res = await t.client.query<{ provenance_id: string }>(
        `INSERT INTO provenance (source_id, request_key, request_url, request_hash,
                                 response_sha256, http_status, bytes, captured_at, adapter_version)
         VALUES ($1, $2, 'test://data/request', digest($2, 'sha256'), digest($2, 'sha256'),
                 200, 0, timestamptz '2026-09-15T18:41:28Z', 'test/1.0.0')
         RETURNING provenance_id`,
        [sourceId, `request-fixture-${sourceId}`],
      );
      ids[sourceId] = Number(res.rows[0]!.provenance_id);
    }
    return {
      yahoo: ids['yahoo.chart']!,
      cboe: ids['cboe.quotes']!,
      master: ids['internal.user']!,
    };
  }

  /** Two equities with a full master chain, built through WP-04's own repositories. */
  async function seed(t: TestDb): Promise<Fixture> {
    const prov = await provenance(t);
    const opts = {
      validFrom: VALID_FROM,
      provenanceId: prov.master,
      knownAt: KNOWN_BASE,
      reason: 'initial' as const,
    };
    const issuers = new IssuerRepository(t.db);
    const issues = new IssueRepository(t.db);
    const instruments = new InstrumentRepository(t.db);
    const listings = new ListingRepository(t.db);
    const mdLines = new MdLineRepository(t.db);
    const identifiers = new IdentifierRepository(t.db);

    async function equity(
      name: string,
      ticker: string,
      cik: string,
      isin: string,
      figi: string,
      lineFigi: string,
    ): Promise<{ instrumentId: number; mdLineId: number }> {
      const issuerId = await issuers.insert(
        { name, legalName: name, cik, country: 'US', entityType: 'operating' },
        opts,
      );
      const issueId = await issues.insert(
        {
          issuerId,
          assetClass: 'equity',
          securityType: 'Common Stock',
          isin,
          name,
          currency: 'USD',
          countryOfIssue: 'US',
        },
        opts,
      );
      const instrumentId = await instruments.insert(
        {
          issueId,
          assetClass: 'equity',
          marketSector: 'Equity',
          compositeFigi: figi,
          ticker,
          exchCode: 'US',
          name,
          currency: 'USD',
          searchWeight: 2,
        },
        opts,
      );
      await listings.insert(
        {
          instrumentId,
          figi: lineFigi,
          mic: 'XNAS',
          exchCode: 'UW',
          localTicker: ticker,
          isPrimary: true,
        },
        opts,
      );
      const mdLineId = await mdLines.insert(
        {
          instrumentId,
          sourceId: 'cboe.quotes',
          providerSymbol: ticker,
          lineKind: 'composite',
          intrinsicDelayMin: 15,
          expectedIntervalMs: 10_000,
          priority: 10,
        },
        opts,
      );
      await identifiers.upsert(
        {
          entityKind: 'instrument',
          entityId: instrumentId,
          scheme: 'TICKER_EXCH',
          value: ticker,
          qualifier: 'US',
          isPrimary: true,
        },
        opts,
      );
      await identifiers.upsert(
        { entityKind: 'instrument', entityId: instrumentId, scheme: 'COMPOSITE_FIGI', value: figi },
        opts,
      );
      return { instrumentId, mdLineId };
    }

    const aapl = await equity(
      'Apple Inc',
      'AAPL',
      '0000320193',
      'US0378331005',
      'BBG000B9XRY4',
      'BBG000B9Y5X2',
    );
    const msft = await equity(
      'Microsoft Corp',
      'MSFT',
      '0000789019',
      'US5949181045',
      'BBG000BPH459',
      'BBG000BPHFS9',
    );

    return {
      aapl: aapl.instrumentId,
      msft: msft.instrumentId,
      aaplMdLine: aapl.mdLineId,
      msftMdLine: msft.mdLineId,
      yahooProv: prov.yahoo,
      cboeProv: prov.cboe,
      masterProv: prov.master,
    };
  }

  /**
   * A second instrument carrying the ticker `AAPL` on another composite. A ticker is not an
   * identity (REF-01), so `'AAPL Equity'` — which names no exchange — then matches two rows and
   * the resolver returns candidates rather than a guess (REF-02).
   */
  async function seedSecondAapl(t: TestDb, f: Fixture): Promise<void> {
    const opts = {
      validFrom: VALID_FROM,
      provenanceId: f.masterProv,
      knownAt: KNOWN_BASE,
      reason: 'initial' as const,
    };
    const issuerId = await new IssuerRepository(t.db).insert(
      { name: 'Apple Inc (London line)', country: 'GB', entityType: 'operating' },
      opts,
    );
    const issueId = await new IssueRepository(t.db).insert(
      {
        issuerId,
        assetClass: 'equity',
        securityType: 'Common Stock',
        name: 'Apple Inc',
        currency: 'GBP',
        countryOfIssue: 'GB',
      },
      opts,
    );
    const instrumentId = await new InstrumentRepository(t.db).insert(
      {
        issueId,
        assetClass: 'equity',
        marketSector: 'Equity',
        ticker: 'AAPL',
        exchCode: 'LN',
        name: 'Apple Inc',
        currency: 'GBP',
      },
      opts,
    );
    // The symbology row a real load would write. Without it the resolver's first step finds only
    // the US line and answers, which is the behaviour the `identifiers` table is *for*.
    await new IdentifierRepository(t.db).upsert(
      {
        entityKind: 'instrument',
        entityId: instrumentId,
        scheme: 'TICKER_EXCH',
        value: 'AAPL',
        qualifier: 'LN',
        isPrimary: true,
      },
      opts,
    );
  }

  /** The four §12.1 sessions as stored, unadjusted prints (DATA_MODEL §6.1: bars are raw). */
  async function seedDailyBars(t: TestDb, f: Fixture): Promise<void> {
    for (const [date, close] of AAPL_CLOSES) {
      await t.client.query(
        `INSERT INTO bars_daily (instrument_id, session_date, md_line_id, open, high, low, close,
                                 volume, capture_ts, provenance_id)
         VALUES ($1, $2::date, $3, $4, $4, $4, $4, 1000000,
                 timestamptz '2026-09-15T18:41:28Z', $5)`,
        [f.aapl, date, f.aaplMdLine, close, f.yahooProv],
      );
    }
    // MSFT trades on three of the four sessions: the missing 2020-08-28 is what makes
    // `calendarAlign: 'intersection'` observable.
    for (const [date, close] of [
      ['2020-08-27', 226.58],
      ['2020-08-31', 225.53],
      ['2020-09-01', 227.27],
    ] as const) {
      await t.client.query(
        `INSERT INTO bars_daily (instrument_id, session_date, md_line_id, open, high, low, close,
                                 volume, capture_ts, provenance_id)
         VALUES ($1, $2::date, $3, $4, $4, $4, $4, 2000000,
                 timestamptz '2026-09-15T18:41:28Z', $5)`,
        [f.msft, date, f.msftMdLine, close, f.yahooProv],
      );
    }
  }

  /**
   * The 4:1 split, ex 2020-08-31, **recorded on 2020-07-31**. `txFrom` is the whole point: without
   * it the version would take `now()` and a read at `knownAt = 2020-07-30` would still see the
   * split, which is exactly the REF-03 claim API.md §12.1 makes.
   */
  async function seedSplit(t: TestDb, f: Fixture): Promise<void> {
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

  /** Five 5-minute bars on one session, so `interval: '15m'` has something to aggregate. */
  async function seedIntradayBars(t: TestDb, f: Fixture): Promise<void> {
    const bars: readonly (readonly [string, number])[] = [
      ['2026-09-15T13:30:00Z', 230.1],
      ['2026-09-15T13:35:00Z', 230.6],
      ['2026-09-15T13:40:00Z', 229.8],
      ['2026-09-15T13:45:00Z', 231.2],
      ['2026-09-15T13:50:00Z', 231.9],
    ];
    for (const [ts, close] of bars) {
      await t.client.query(
        `INSERT INTO bars_intraday (instrument_id, bar_interval, bar_ts, md_line_id, open, high,
                                    low, close, volume, session, is_final, capture_ts,
                                    provenance_id)
         VALUES ($1, '5m', $2::timestamptz, $3, $4, $4, $4, $4, 500, 'regular', true,
                 timestamptz '2026-09-15T18:41:28Z', $5)`,
        [f.aapl, ts, f.aaplMdLine, close, f.cboeProv],
      );
    }
  }

  /** Three ticks in capture order; the dispatcher must hand them back in the same order (rule 5). */
  async function seedTicks(t: TestDb, f: Fixture): Promise<void> {
    const ticks: readonly (readonly [string, number, number])[] = [
      ['2026-09-15T13:31:00Z', 230.11, 100],
      ['2026-09-15T13:32:00Z', 230.24, 200],
      ['2026-09-15T13:33:00Z', 230.19, 300],
    ];
    for (const [ts, price, size] of ticks) {
      await t.client.query(
        `INSERT INTO quote_ticks (capture_ts, instrument_id, md_line_id, kind, source_ts, price,
                                  size, bid, ask, conditions, provenance_id)
         VALUES ($1::timestamptz, $2, $3, 'trade', $1::timestamptz, $4, $5, $4, $4,
                 ARRAY['@'], $6)`,
        [ts, f.aapl, f.aaplMdLine, price, size, f.cboeProv],
      );
    }
  }

  /** One composite `QuoteState` in `quote_snapshots` — the warm tier `kind:'realtime'` reads. */
  async function seedQuoteSnapshot(t: TestDb, f: Fixture): Promise<void> {
    const cap = Date.parse('2026-09-15T18:41:28Z');
    const state: QuoteState = {
      subject: `q:${f.aapl}`,
      instrumentId: f.aapl,
      assetClass: 'equity',
      seq: 7,
      tier: 'delayed',
      delayMin: 15,
      fields: { PX_LAST: 231.9, PX_BID: 231.88, PX_ASK: 231.92, PX_VOLUME: 41_200_000 },
      fieldTs: { PX_LAST: cap },
      ts: { src: cap, cap, pub: cap },
      session: 'open',
      state: 'live',
      ageMs: 0,
      expectedIntervalMs: 10_000,
      prov: { sourceId: 'cboe.quotes', provenanceId: f.cboeProv },
      lines: {},
      dq: [],
    };
    await t.client.query(
      `INSERT INTO quote_snapshots (instrument_id, subject, seq, state, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, timestamptz '2026-09-15T18:41:28Z')`,
      [f.aapl, state.subject, state.seq, JSON.stringify(state)],
    );
  }

  // ── the dispatcher under test ──────────────────────────────────────────────────────────────

  /**
   * Build the readers and the dispatcher exactly as `POST /data` will: one `ProvenanceIndex` and
   * one `DataDeps` for the request, shared by every service it touches.
   */
  function dispatcher(
    at: AsOf,
    extra: Partial<Parameters<typeof createDispatcher>[0]> = {},
    sources?: DataSources,
  ): ReturnType<typeof createDispatcher> {
    const prov = new ProvenanceIndex();
    const deps = dataDeps(t.db, at, prov);
    return createDispatcher({
      tx: t.db,
      clock: CLOCK,
      traceId: TRACE_ID,
      prov,
      sources: sources ?? buildDataSources(deps),
      ...extra,
    });
  }

  /** `asOf` as the dispatcher will compute it, so the readers and the request agree. */
  function asOf(validAt: string, knownAt: string): AsOf {
    return { validAt: new Date(validAt), knownAt: new Date(knownAt) };
  }

  // ── §12.1 — the worked example, value for value ────────────────────────────────────────────

  it('§12.1: historical AAPL PX_LAST across the 2020-08-31 split, adjusted as of knownAt', async () => {
    const f = await seed(t);
    await seedDailyBars(t, f);
    await seedSplit(t, f);

    const at = asOf('2026-09-15T18:41:30.002Z', KNOWN_NOW);
    const res = await dispatcher(at).dispatch({
      kind: 'historical',
      securities: [{ ref: 'AAPL US Equity' }],
      fields: ['PX_LAST'],
      start: '2020-08-27',
      end: '2020-09-01',
      adjust: 'price',
      asOf: { knownAt: KNOWN_NOW },
    });

    // The documented envelope, asserted by the SDK's own schema.
    expect(() => DataResponse.parse(res)).not.toThrow();

    expect(res.results).toHaveLength(1);
    const [only] = res.results;
    expect(only?.security).toEqual({ ref: 'AAPL US Equity' });
    expect(only?.instrument?.instrumentId).toBe(f.aapl);
    expect(only?.instrument?.display).toBe('AAPL US Equity');
    expect(only?.instrument?.compositeFigi).toBe('BBG000B9XRY4');
    expect(only?.tier).toBe('eod');
    expect(only?.st).toBe('closed');
    expect(only?.error).toBeUndefined();

    const series = only?.series;
    expect(series?.columns).toEqual(['PX_LAST']);
    expect(series?.index).toEqual(['2020-08-27', '2020-08-28', '2020-08-31', '2020-09-01']);
    expect(series?.adjust).toBe('price');
    expect(series?.currency).toBe('USD');
    const closes = (series?.rows ?? []).map((row) => row[0]);
    expect(closes[0]).toBeCloseTo(125.01, 4);
    expect(closes[1]).toBeCloseTo(124.8075, 4);
    expect(closes[2]).toBeCloseTo(129.04, 4);
    expect(closes[3]).toBeCloseTo(134.18, 4);

    // REF-09 — the step is echoed, and the block cites the provenance row that supplied the bars.
    expect(res.meta.adjustments).toEqual([
      { beforeDate: '2020-08-31', priceFactor: 0.25, volumeFactor: 4, kind: 'split' },
    ]);
    expect(series?.provIdx.length).toBeGreaterThan(0);
    for (const idx of series?.provIdx ?? []) {
      expect(res.meta.provenance[idx]?.sourceId).toBe('yahoo.chart');
    }
    // DATA-09: attribution is joined from `licence_registry`, never invented by a reader — so the
    // expected text is read back from the registry rather than written down twice.
    const licence = await t.client.query<{ attribution: string }>(
      `SELECT attribution FROM licence_registry
        WHERE source_id = 'yahoo.chart' AND tx_to = 'infinity'`,
    );
    expect(res.meta.provenance[0]?.attribution).toBe(licence.rows[0]?.attribution);
    expect(res.meta.provenance[0]?.attribution).not.toBe('');
    // ANAL-08: the engine that ran is named, with a hash of its inputs.
    expect(res.meta.engines.map((e) => e.name)).toContain('adjust');
    expect(res.meta.engines[0]?.inputsHash).toMatch(/^[0-9a-f]{64}$/);

    // Rule 4 — `meta.asOf` reports the effective pair, and rule 7 charges rows × columns.
    expect(res.meta.asOf.knownAt).toBe('2026-09-15T00:00:00.000Z');
    expect(res.meta.asOf.validAt).toBe('2026-09-15T18:41:30.002Z');
    expect(res.meta.quota).toEqual({ dataPointsCharged: 4, uniqueInstrumentsAdded: 1 });
    expect(res.meta.traceId).toBe(TRACE_ID);
    expect(res.meta.tier).toBe('eod');
    expect(res.meta.staleness).toBe('closed');
  });

  it('§12.1 (REF-03): the same request at knownAt 2020-07-30 is unadjusted, with no steps', async () => {
    const f = await seed(t);
    await seedDailyBars(t, f);
    await seedSplit(t, f);

    const at = asOf('2026-09-15T18:41:30.002Z', KNOWN_BEFORE_SPLIT_RECORDED);
    const res = await dispatcher(at).dispatch({
      kind: 'historical',
      securities: [{ ref: 'AAPL US Equity' }],
      fields: ['PX_LAST'],
      start: '2020-08-27',
      end: '2020-09-01',
      adjust: 'price',
      asOf: { knownAt: KNOWN_BEFORE_SPLIT_RECORDED },
    });

    expect(() => DataResponse.parse(res)).not.toThrow();
    const closes = (res.results[0]?.series?.rows ?? []).map((row) => row[0]);
    expect(closes[0]).toBeCloseTo(500.04, 4);
    expect(closes[1]).toBeCloseTo(499.23, 4);
    // The split was recorded on 2020-07-31, so as of what we knew on the 30th it did not exist.
    expect(res.meta.adjustments).toEqual([]);
    expect(res.meta.asOf.knownAt).toBe('2020-07-30T00:00:00.000Z');
  });

  // ── §4 — one example per kind, each reaching its own service ───────────────────────────────

  it("kind:'reference' dispatches to the reference reader and fills fields / fprov / ts", async () => {
    const f = await seed(t);
    const res = await dispatcher(asOf(KNOWN_NOW, KNOWN_NOW)).dispatch({
      kind: 'reference',
      securities: [{ ref: 'AAPL US Equity' }, { id: f.msft }],
      fields: ['NAME', 'ID_TICKER', 'CRNCY'],
    });

    expect(() => DataResponse.parse(res)).not.toThrow();
    expect(res.results).toHaveLength(2);

    const [apple, microsoft] = res.results;
    expect(apple?.fields).toEqual({ NAME: 'Apple Inc', ID_TICKER: 'AAPL', CRNCY: 'USD' });
    expect(microsoft?.fields).toEqual({ NAME: 'Microsoft Corp', ID_TICKER: 'MSFT', CRNCY: 'USD' });
    // A reference read fills no series, no ticks and no subject — those belong to other kinds.
    expect(apple?.series).toBeUndefined();
    expect(apple?.ticks).toBeUndefined();
    expect(apple?.subject).toBeUndefined();

    // Every field cites a `meta.provenance` index (DATA-10).
    for (const field of ['NAME', 'ID_TICKER', 'CRNCY']) {
      const idx = apple?.fprov?.[field];
      expect(idx).toBeTypeOf('number');
      expect(res.meta.provenance[idx!]?.sourceId).toBe('internal.user');
    }
    // Rule 7 — reference charges securities × fields.
    expect(res.meta.quota).toEqual({ dataPointsCharged: 6, uniqueInstrumentsAdded: 2 });
  });

  it("kind:'intraday' dispatches to the intraday reader and resamples 5m bars to 15m", async () => {
    const f = await seed(t);
    await seedIntradayBars(t, f);

    const res = await dispatcher(asOf('2026-09-15T18:41:30.002Z', KNOWN_NOW)).dispatch({
      kind: 'intraday',
      securities: [{ ref: 'AAPL US Equity' }],
      fields: ['PX_LAST', 'PX_VOLUME'],
      start: '2026-09-15T13:30:00Z',
      end: '2026-09-15T14:00:00Z',
      interval: '15m',
    });

    expect(() => DataResponse.parse(res)).not.toThrow();
    const series = res.results[0]?.series;
    // Three 5m bars in 13:30–13:45 and two in 13:45–14:00 (API.md §4 L320: 15m from 5m on read).
    expect(series?.index).toEqual(['2026-09-15T13:30:00.000Z', '2026-09-15T13:45:00.000Z']);
    expect(series?.columns).toEqual(['PX_LAST', 'PX_VOLUME']);
    expect(series?.rows[0]?.[0]).toBeCloseTo(229.8, 4); // last print of the bucket
    expect(series?.rows[0]?.[1]).toBe(1500); // volume sums
    expect(series?.rows[1]?.[0]).toBeCloseTo(231.9, 4);
    expect(series?.rows[1]?.[1]).toBe(1000);
    // An intraday read carries no `adjustments` block: adjustment is a historical concept.
    expect(res.meta.adjustments).toBeUndefined();
  });

  it("kind:'tick' dispatches to the tick reader, capTs ascending, f projected to the request", async () => {
    const f = await seed(t);
    await seedTicks(t, f);

    const res = await dispatcher(asOf('2026-09-15T18:41:30.002Z', KNOWN_NOW)).dispatch({
      kind: 'tick',
      securities: [{ ref: 'AAPL US Equity' }],
      fields: ['PX_LAST', 'LAST_SIZE'],
      start: '2026-09-15T13:00:00Z',
      end: '2026-09-15T14:00:00Z',
    });

    expect(() => DataResponse.parse(res)).not.toThrow();
    const ticks = res.results[0]?.ticks ?? [];
    expect(ticks).toHaveLength(3);
    expect(ticks.map((row) => row.capTs)).toEqual([...ticks.map((row) => row.capTs)].sort());
    expect(ticks[0]?.kind).toBe('trade');
    expect(ticks[0]?.mdLineId).toBe(f.aaplMdLine);
    // "the requested fields present on this tick" — PX_BID was stored but never asked for.
    expect(Object.keys(ticks[0]?.f ?? {}).sort()).toEqual(['LAST_SIZE', 'PX_LAST']);
    expect(ticks[0]?.f.PX_LAST).toBeCloseTo(230.11, 4);
    expect(res.results[0]?.nextCursor).toBeNull();
    // Rule 7 — tick charges ticks.length.
    expect(res.meta.quota?.dataPointsCharged).toBe(3);
  });

  it("kind:'realtime' dispatches to the snapshot reader and names the subject to subscribe to", async () => {
    const f = await seed(t);
    await seedQuoteSnapshot(t, f);

    const res = await dispatcher(asOf('2026-09-15T18:41:30.002Z', KNOWN_NOW)).dispatch({
      kind: 'realtime',
      securities: [{ ref: 'AAPL US Equity' }],
      fields: ['PX_LAST', 'PX_BID'],
      tier: 'delayed',
    });

    expect(() => DataResponse.parse(res)).not.toThrow();
    const [row] = res.results;
    expect(row?.fields?.PX_LAST).toBeCloseTo(231.9, 4);
    expect(row?.fields?.PX_BID).toBeCloseTo(231.88, 4);
    // Rule 6 / §6.1 — the one-shot REST view plus the subject family the caller asked for.
    expect(row?.subject).toEqual({
      subject: `q:${f.aapl}`,
      fields: ['PX_LAST', 'PX_BID'],
      tier: 'delayed',
      reason: 'OK',
    });
    expect(row?.tier).toBe('delayed');
    expect(row?.series).toBeUndefined();

    // `subjectKind: 'l'` addresses the md line instead of the instrument (§6.1).
    const byLine = await dispatcher(asOf('2026-09-15T18:41:30.002Z', KNOWN_NOW)).dispatch({
      kind: 'realtime',
      securities: [{ ref: 'AAPL US Equity' }],
      fields: ['PX_LAST'],
      subjectKind: 'l',
    });
    expect(byLine.results[0]?.subject?.subject).toBe(`l:${f.aaplMdLine}`);
  });

  // ── The numbered rules ─────────────────────────────────────────────────────────────────────

  it('rule 1: an unresolved and an ambiguous security are per-result errors, not a failed request', async () => {
    const f = await seed(t);
    await seedDailyBars(t, f);
    // A second AAPL on another composite, so `'AAPL Equity'` — no exchange code — matches two
    // instruments. REF-02: the resolver returns candidates and refuses to guess.
    await seedSecondAapl(t, f);

    const res = await dispatcher(asOf(KNOWN_NOW, KNOWN_NOW)).dispatch({
      kind: 'reference',
      securities: [
        { ref: 'AAPL US Equity' },
        { ref: 'NOSUCHTICKER US Equity' },
        { ref: 'AAPL Equity' },
      ],
      fields: ['NAME'],
    });

    // Two of the three failed and the response is still a well-formed 200 `DataResponse`.
    expect(() => DataResponse.parse(res)).not.toThrow();
    expect(res.results).toHaveLength(3);
    expect(res.results[0]?.instrument?.instrumentId).toBe(f.aapl);
    expect(res.results[0]?.error).toBeUndefined();

    const miss = res.results[1];
    expect(miss?.instrument).toBeNull();
    expect(miss?.error?.code).toBe('SECURITY_NOT_FOUND');
    expect(miss?.st).toBe('blank');
    // The echoed request is still there, so a grid can keep the row it asked for.
    expect(miss?.security).toEqual({ ref: 'NOSUCHTICKER US Equity' });

    const ambiguous = res.results[2];
    expect(ambiguous?.instrument).toBeNull();
    expect(ambiguous?.error?.code).toBe('AMBIGUOUS_SECURITY');
    expect(ambiguous?.error?.candidates?.map((c) => c.exchCode).sort()).toEqual(['LN', 'US']);
  });

  it('rule 2: entitlement runs once; a denied field is null with its reason, all denied is 403', async () => {
    const f = await seed(t);

    const denyBid = {
      evaluate: () =>
        Promise.resolve({
          effectiveTier: 'eod' as const,
          fields: [
            {
              fieldId: 'NAME',
              sourceId: 'internal.user',
              fieldClass: 'reference' as const,
              decision: 'allow' as const,
              effectiveTier: 'eod' as const,
              reason: 'OK' as const,
            },
            {
              fieldId: 'PX_BID',
              sourceId: 'cboe.quotes',
              fieldClass: 'price' as const,
              decision: 'deny' as const,
              effectiveTier: 'eod' as const,
              reason: 'TIER_EOD' as const,
            },
          ],
          downgrades: [],
          logIds: [],
        }),
    };
    const caller = { userId: 2, firmId: 1, sessionId: 'sess-1' };

    const partial = await dispatcher(asOf(KNOWN_NOW, KNOWN_NOW), {
      entitlement: denyBid,
      caller,
    }).dispatch({
      kind: 'reference',
      securities: [{ id: f.aapl }],
      fields: ['NAME', 'PX_BID'],
    });

    expect(() => DataResponse.parse(partial)).not.toThrow();
    expect(partial.results[0]?.fields?.NAME).toBe('Apple Inc');
    expect(partial.results[0]?.fields?.PX_BID).toBeNull();
    expect(partial.results[0]?.r?.PX_BID).toBe('TIER_EOD');
    expect(partial.meta.entitlement).toEqual([
      { fieldId: 'PX_BID', decision: 'deny', effectiveTier: 'eod', reason: 'TIER_EOD' },
    ]);

    // A request in which *no* field is servable is 403 ENTITLEMENT_DENIED, not an empty 200.
    const denyAll = {
      evaluate: () =>
        Promise.resolve({
          effectiveTier: null,
          fields: [
            {
              fieldId: 'PX_BID',
              sourceId: 'cboe.quotes',
              fieldClass: 'price' as const,
              decision: 'deny' as const,
              effectiveTier: null,
              reason: 'TIER_EOD' as const,
            },
          ],
          downgrades: [],
          logIds: [],
        }),
    };
    await expect(
      dispatcher(asOf(KNOWN_NOW, KNOWN_NOW), { entitlement: denyAll, caller }).dispatch({
        kind: 'reference',
        securities: [{ id: f.aapl }],
        fields: ['PX_BID'],
      }),
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_DENIED', status: 403 });
  });

  it('an unknown field id is 404 FIELD_UNKNOWN before any service is asked', async () => {
    const f = await seed(t);
    const never: DataSources = {
      referenceFields: () => {
        throw new Error('the dispatcher must not read for an unknown field');
      },
      snapshotFields: () => {
        throw new Error('unreachable');
      },
      historical: () => {
        throw new Error('unreachable');
      },
      intraday: () => {
        throw new Error('unreachable');
      },
      ticks: () => {
        throw new Error('unreachable');
      },
    };
    await expect(
      dispatcher(asOf(KNOWN_NOW, KNOWN_NOW), {}, never).dispatch({
        kind: 'reference',
        securities: [{ id: f.aapl }],
        fields: ['PX_LST'],
      }),
    ).rejects.toMatchObject({ code: 'FIELD_UNKNOWN', status: 404 });
  });

  it('a malformed request is 400 VALIDATION_FAILED from the SDK schema itself', async () => {
    await expect(
      dispatcher(asOf(KNOWN_NOW, KNOWN_NOW)).dispatch({
        kind: 'historical',
        securities: [],
        fields: ['PX_LAST'],
        start: '2020-08-27',
      } as never),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('CHRT-03: calendarAlign intersection keeps only the sessions both names traded', async () => {
    const f = await seed(t);
    await seedDailyBars(t, f);

    const res = await dispatcher(asOf('2026-09-15T18:41:30.002Z', KNOWN_NOW)).dispatch({
      kind: 'historical',
      securities: [{ ref: 'AAPL US Equity' }, { ref: 'MSFT US Equity' }],
      fields: ['PX_LAST'],
      start: '2020-08-27',
      end: '2020-09-01',
      adjust: 'unadjusted',
      calendarAlign: 'intersection',
      asOf: { knownAt: KNOWN_NOW },
    });

    expect(() => DataResponse.parse(res)).not.toThrow();
    const shared = ['2020-08-27', '2020-08-31', '2020-09-01'];
    expect(res.results[0]?.series?.index).toEqual(shared);
    expect(res.results[1]?.series?.index).toEqual(shared);
    // 3 sessions × 1 column × 2 securities.
    expect(res.meta.quota?.dataPointsCharged).toBe(6);

    const union = await dispatcher(asOf('2026-09-15T18:41:30.002Z', KNOWN_NOW)).dispatch({
      kind: 'historical',
      securities: [{ ref: 'AAPL US Equity' }, { ref: 'MSFT US Equity' }],
      fields: ['PX_LAST'],
      start: '2020-08-27',
      end: '2020-09-01',
      adjust: 'unadjusted',
      calendarAlign: 'union',
      fill: 'prev',
      asOf: { knownAt: KNOWN_NOW },
    });
    expect(union.results[1]?.series?.index).toEqual([
      '2020-08-27',
      '2020-08-28',
      '2020-08-31',
      '2020-09-01',
    ]);
    // `fill: 'prev'` carries 2020-08-27's close into the session MSFT did not trade.
    expect(union.results[1]?.series?.rows[1]?.[0]).toBeCloseTo(226.58, 4);
  });
});
