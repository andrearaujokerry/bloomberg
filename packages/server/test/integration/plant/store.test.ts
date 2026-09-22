/**
 * `plant/store.ts` — the one writer of `quote_ticks`, `quote_snapshots` and `eod_snapshots`
 * (WORKPLAN WP-06, STOR-01, STOR-05, BUS-06), inside the rolled-back harness transaction.
 *
 * Self-sufficient: the test creates its own licence row and provenance row (the only FK the three
 * tables carry) and takes an instrument id from the shared sequence — WP-15's seed does not exist
 * yet and nothing here assumes one.
 *
 * `quote_ticks` is range-partitioned on `capture_ts` and only the daily partitions migration 0016
 * created exist: `quote_ticks_d2026_09_14` … `quote_ticks_d2026_09_21`. The tick written here
 * carries the AAPL fixture's own capture instant, `2026-09-15T18:41:28Z`, which routes to
 * `quote_ticks_d2026_09_15` (`FROM '2026-09-15 00:00:00+00' TO '2026-09-16 00:00:00+00'`).
 */

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { NormalisedUpdate, QuoteState } from '@terminal/core';

import { buildEodSnapshot } from '../../../src/plant/eod.js';
import { plantStore, tickRow } from '../../../src/plant/store.js';
import { warmPlant } from '../../../src/plant/warm.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { testClock } from '../../../src/test/clock.js';
import { readNormalised } from '../../../src/test/fixtures.js';

// `src/test/fixtures.ts` resolves `REPLAY_DIR` against `packages/server`, and the repository's
// `.env` carries the root-relative `./fixtures/providers`, which lands one directory too deep. The
// captures are a fixed part of the repository, so this file pins the absolute path (the same thing
// `test/integration/ingest/reconcile.test.ts` does). It must be set on `process.env`, not through
// `setConfig`, because the setup files clear the memoised config before every test.
process.env.REPLAY_DIR = fileURLToPath(
  new URL('../../../../../fixtures/providers', import.meta.url),
);

const t = withTxDb();

/** The fixture's capture instant: inside `quote_ticks_d2026_09_15`. */
const CAPTURE_ISO = '2026-09-15T18:41:28.000Z';
const SESSION_DATE = '2026-09-15';
const CLOSE_TS = Date.parse('2026-09-15T20:00:00.000Z');

interface NormalisedFixture {
  updates: NormalisedUpdate[];
}

/** A licence row (the provenance trigger demands a known source), one provenance row, a fresh id. */
async function fixture(db: TestDb): Promise<{ instrumentId: number; provenanceId: number }> {
  await db.client.query(
    `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind, attribution,
                                   rate_limit, valid_from)
     SELECT 'internal.user', 'Internal / user supplied', 'Terminal', 'internal',
            'Internal', 'n/a', timestamptz '2000-01-01'
      WHERE NOT EXISTS (SELECT 1 FROM licence_registry
                         WHERE source_id = 'internal.user' AND tx_to = 'infinity')`,
  );
  const seq = await db.client.query<{ id: string }>(
    `SELECT nextval('instrument_id_seq')::bigint AS id`,
  );
  const instrumentId = Number(seq.rows[0]!.id);
  const prov = await db.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, adapter_version)
     VALUES ('internal.user', $1, 'test://plant-store/' || $1, digest($1, 'sha256'),
             digest($1, 'sha256'), 200, 0, $2, 'test/1.0.0')
     RETURNING provenance_id`,
    [`plant-store-${String(instrumentId)}`, CAPTURE_ISO],
  );
  return { instrumentId, provenanceId: Number(prov.rows[0]!.provenance_id) };
}

/** The AAPL fixture update re-keyed onto this test's instrument and provenance. */
async function aaplUpdate(instrumentId: number, provenanceId: number): Promise<NormalisedUpdate> {
  const fx = await readNormalised<NormalisedFixture>('cboe-quote-AAPL');
  const u = fx.updates[0]!;
  expect(new Date(u.ts.cap).toISOString()).toBe(CAPTURE_ISO);
  return {
    ...u,
    subject: `q:${String(instrumentId)}`,
    instrumentId,
    prov: { ...u.prov, provenanceId },
  };
}

function stateOf(u: NormalisedUpdate, seq: number, fields: QuoteState['fields']): QuoteState {
  const fieldTs: QuoteState['fieldTs'] = {};
  for (const id of Object.keys(fields) as (keyof QuoteState['fields'])[]) {
    fieldTs[id] = u.ts.src ?? u.ts.cap;
  }
  return {
    subject: u.subject,
    instrumentId: u.instrumentId,
    assetClass: u.assetClass,
    seq,
    tier: u.tier,
    delayMin: 15,
    fields,
    fieldTs,
    ts: u.ts,
    session: 'open',
    state: 'live',
    ageMs: 0,
    expectedIntervalMs: 10_000,
    prov: u.prov,
    lines: {
      [u.mdLineId]: {
        mdLineId: u.mdLineId,
        sourceId: u.prov.sourceId,
        fields: u.fields,
        ts: u.ts,
        srcSeq: u.prov.srcSeq!,
        provenanceId: u.prov.provenanceId,
      },
    },
    dq: [],
  };
}

describe('plant/store — quote_ticks', () => {
  it('maps the fixture update to the row cboe-quote-AAPL.json records', async () => {
    const { instrumentId, provenanceId } = await fixture(t);
    const u = await aaplUpdate(instrumentId, provenanceId);
    const row = tickRow({ update: u, kind: 'summary', tickDir: 'down' });
    expect(row).toEqual({
      captureTs: CAPTURE_ISO,
      instrumentId,
      mdLineId: 5101,
      kind: 'summary',
      sourceTs: '2026-09-15T18:26:26.000Z',
      publishTs: CAPTURE_ISO,
      srcSeq: 15972883317,
      price: '330.270000',
      size: null,
      bid: '330.250000',
      ask: '330.280000',
      bidSize: 40,
      askSize: 120,
      open: '330.240000',
      high: '331.590000',
      low: '328.350000',
      prevClose: '333.080000',
      volume: 16591786,
      iv30: '24.427000',
      tickDir: 'd',
      conditions: ['delayed'],
      sessionState: null,
      provenanceId,
    });
    // A realtime line carries no 'delayed' condition; an explicit override wins over the tier.
    expect(tickRow({ update: { ...u, tier: 'realtime' }, kind: 'trade' }).conditions).toEqual([]);
    expect(tickRow({ update: u, kind: 'trade', delayed: false }).conditions).toEqual([]);
    expect(
      tickRow({ update: u, kind: 'quote', conditions: ['late', 'delayed'] }).conditions,
    ).toEqual(['late', 'delayed']);
    // tick_dir defaults to the update's TICK_DIR and maps u|d|f.
    expect(tickRow({ update: { ...u, fields: { ...u.fields, TICK_DIR: 'up' } }, kind: 'trade' }).tickDir).toBe('u');
    expect(tickRow({ update: { ...u, fields: { ...u.fields, TICK_DIR: 'flat' } }, kind: 'trade' }).tickDir).toBe('f');
    expect(tickRow({ update: u, kind: 'trade' }).tickDir).toBeNull();
  });

  it('writes the tick into the 2026-09-15 partition with capture_ts as the partition key', async () => {
    const { instrumentId, provenanceId } = await fixture(t);
    const u = await aaplUpdate(instrumentId, provenanceId);
    const store = plantStore({ db: t.db, clock: testClock() });

    store.writeTick({ update: u, kind: 'summary', tickDir: 'down' });
    expect(store.stats().pendingTicks).toBe(1);
    await store.flush();
    expect(store.stats()).toMatchObject({ pendingTicks: 0, ticksWritten: 1, flushes: 1 });

    const res = await t.client.query<{
      partition: string;
      capture_ts: string;
      md_line_id: string;
      kind: string;
      price: string;
      prev_close: string;
      volume: string;
      tick_dir: string;
      conditions: string[];
      src_seq: string;
      session_state: string | null;
      provenance_id: string;
    }>(
      `SELECT tableoid::regclass::text AS partition,
              to_char(capture_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS capture_ts,
              md_line_id::text, kind, price::text, prev_close::text, volume::text, tick_dir,
              conditions, src_seq::text, session_state, provenance_id::text
         FROM quote_ticks
        WHERE instrument_id = $1`,
      [instrumentId],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toEqual({
      partition: 'quote_ticks_d2026_09_15',
      capture_ts: CAPTURE_ISO,
      md_line_id: '5101',
      kind: 'summary',
      price: '330.270000',
      prev_close: '333.080000',
      volume: '16591786',
      tick_dir: 'd',
      conditions: ['delayed'],
      src_seq: '15972883317',
      session_state: null,
      provenance_id: String(provenanceId),
    });
  });

  it('a flush with nothing pending writes nothing and counts no flush', async () => {
    const store = plantStore({ db: t.db, clock: testClock() });
    await store.flush();
    expect(store.stats().flushes).toBe(0);
  });
});

describe('plant/store — quote_snapshots', () => {
  it('upserts twice: seq advances, one row, readSnapshots deep-equals the QuoteState', async () => {
    const { instrumentId, provenanceId } = await fixture(t);
    const u = await aaplUpdate(instrumentId, provenanceId);
    const clock = testClock();
    const store = plantStore({ db: t.db, clock });

    const first = stateOf(u, 1, { ...u.fields, CHG_NET_1D: -2.81, CHG_PCT_1D: -0.8436, TICK_DIR: 'down' });
    store.upsertSnapshot(u.subject, 1, first);
    await store.flush();

    const second = stateOf(u, 2, { ...first.fields, PX_LAST: 330.31, PX_VOLUME: 16601102, TICK_DIR: 'up' });
    second.ts = { src: u.ts.src! + 15_000, cap: u.ts.cap + 15_400, pub: u.ts.cap + 15_401 };
    clock.advance(15_400);
    store.upsertSnapshot(u.subject, 2, second);
    await store.flush();

    const count = await t.client.query<{ n: string; seq: string; updated_at: string }>(
      `SELECT count(*)::text AS n, max(seq)::text AS seq,
              to_char(max(updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
         FROM quote_snapshots WHERE instrument_id = $1`,
      [instrumentId],
    );
    expect(count.rows[0]).toEqual({
      n: '1',
      seq: '2',
      updated_at: new Date(clock.now()).toISOString(),
    });

    const rows = (await store.readSnapshots()).filter((r) => r.subject === u.subject);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ subject: u.subject, seq: 2, state: second });
    // Deep equality on the whole state: lines, provenance, fieldTs and the derived fields survive
    // the jsonb round trip untouched.
    expect(rows[0]!.state).toStrictEqual(second);
    expect(rows[0]!.state).not.toEqual(first);
  });

  it('two upserts of one subject inside a single flush collapse to the later one', async () => {
    const { instrumentId, provenanceId } = await fixture(t);
    const u = await aaplUpdate(instrumentId, provenanceId);
    const store = plantStore({ db: t.db, clock: testClock() });
    store.upsertSnapshot(u.subject, 1, stateOf(u, 1, u.fields));
    store.upsertSnapshot(u.subject, 2, stateOf(u, 2, { ...u.fields, PX_LAST: 330.3 }));
    expect(store.stats().pendingSnapshots).toBe(1);
    await store.flush();
    const rows = (await store.readSnapshots()).filter((r) => r.subject === u.subject);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seq).toBe(2);
    expect(rows[0]!.state.fields.PX_LAST).toBe(330.3);
  });

  it('warmPlant preloads the stored state marked stale (ARCHITECTURE §12.1 step 6)', async () => {
    const { instrumentId, provenanceId } = await fixture(t);
    const u = await aaplUpdate(instrumentId, provenanceId);
    const store = plantStore({ db: t.db, clock: testClock() });
    const live = stateOf(u, 7, u.fields);
    expect(live.state).toBe('live');
    store.upsertSnapshot(u.subject, 7, live);
    await store.flush();

    const warm = await warmPlant(store);
    const row = warm.rows.find((r) => r.subject === u.subject);
    expect(row).toBeDefined();
    expect(row!.seq).toBe(7);
    expect(row!.state).toEqual({ ...live, state: 'stale' });
    expect(warm.skipped.filter((s) => s.subject === u.subject)).toEqual([]);
  });
});

describe('plant/store — eod_snapshots', () => {
  it('writes the official close and reads it back through readEod, flags included', async () => {
    const { instrumentId, provenanceId } = await fixture(t);
    const u = await aaplUpdate(instrumentId, provenanceId);
    const store = plantStore({ db: t.db, clock: testClock() });
    const state = stateOf(u, 3, u.fields);

    expect(await store.readEod(instrumentId)).toBeNull();

    const eod = buildEodSnapshot(state, SESSION_DATE, CLOSE_TS);
    store.writeEodSnapshot(instrumentId, eod, provenanceId);
    await store.flush();
    expect(store.stats()).toMatchObject({ eodWritten: 1, pendingEod: 0 });

    const back = await store.readEod(instrumentId);
    expect(back).toEqual(eod);
    expect(back).toEqual({
      sessionDate: SESSION_DATE,
      closeTs: CLOSE_TS,
      fields: {
        PX_OFFICIAL_CLOSE: 330.27,
        PX_CLOSE_1D: 333.08,
        PX_VOLUME: 16591786,
        PX_OPEN: 330.24,
        PX_HIGH: 331.59,
        PX_LOW: 328.35,
      },
      flags: ['OFFICIAL_CLOSE_FROM_LAST'],
    });

    const raw = await t.client.query<{ close_ts: string; provenance_id: string; fields: Record<string, unknown> }>(
      `SELECT to_char(close_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS close_ts,
              provenance_id::text, fields
         FROM eod_snapshots WHERE instrument_id = $1 AND session_date = $2`,
      [instrumentId, SESSION_DATE],
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]!.close_ts).toBe('2026-09-15T20:00:00.000Z');
    expect(raw.rows[0]!.provenance_id).toBe(String(provenanceId));
    expect(raw.rows[0]!.fields.PX_OFFICIAL_CLOSE).toBe(330.27);
  });

  it('a second write for the same session replaces the row; readEod returns the latest session', async () => {
    const { instrumentId, provenanceId } = await fixture(t);
    const u = await aaplUpdate(instrumentId, provenanceId);
    const store = plantStore({ db: t.db, clock: testClock() });

    const state = stateOf(u, 3, { ...u.fields, PX_OFFICIAL_CLOSE: 330.3 });
    store.writeEodSnapshot(instrumentId, buildEodSnapshot(state, SESSION_DATE, CLOSE_TS), provenanceId);
    await store.flush();
    store.writeEodSnapshot(instrumentId, buildEodSnapshot(state, SESSION_DATE, CLOSE_TS + 1), provenanceId);
    await store.flush();

    const later = buildEodSnapshot(state, '2026-09-16', CLOSE_TS + 86_400_000);
    store.writeEodSnapshot(instrumentId, later, provenanceId);
    await store.flush();

    const n = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM eod_snapshots WHERE instrument_id = $1`,
      [instrumentId],
    );
    expect(n.rows[0]!.n).toBe('2');
    const back = await store.readEod(instrumentId);
    expect(back).toEqual(later);
    expect(back!.flags).toEqual([]);
  });
});

describe('plant/store — one transaction per flush', () => {
  it('a tick, a snapshot and an eod row queued together land in one flush', async () => {
    const { instrumentId, provenanceId } = await fixture(t);
    const u = await aaplUpdate(instrumentId, provenanceId);
    const store = plantStore({ db: t.db, clock: testClock() });
    const state = stateOf(u, 1, u.fields);

    store.writeTick({ update: u, kind: 'summary' });
    store.upsertSnapshot(u.subject, 1, state);
    store.writeEodSnapshot(instrumentId, buildEodSnapshot(state, SESSION_DATE, CLOSE_TS), provenanceId);
    expect(store.stats()).toMatchObject({ pendingTicks: 1, pendingSnapshots: 1, pendingEod: 1 });

    // Two overlapping flushes: the second waits for the first and finds nothing to do.
    await Promise.all([store.flush(), store.flush()]);
    expect(store.stats()).toMatchObject({
      pendingTicks: 0,
      pendingSnapshots: 0,
      pendingEod: 0,
      ticksWritten: 1,
      snapshotsWritten: 1,
      eodWritten: 1,
      flushes: 1,
    });
  });

  it('a failed flush keeps the batch pending and rethrows', async () => {
    const { instrumentId, provenanceId } = await fixture(t);
    const u = await aaplUpdate(instrumentId, provenanceId);
    const store = plantStore({ db: t.db, clock: testClock() });
    // A provenance id no row carries: the FK rejects it, the savepoint rolls back.
    const bad = { ...u, prov: { ...u.prov, provenanceId: provenanceId + 1_000_000 } };
    store.writeTick({ update: bad, kind: 'summary' });
    await expect(store.flush()).rejects.toThrow();
    expect(store.stats()).toMatchObject({ pendingTicks: 1, ticksWritten: 0, flushes: 0 });

    // The harness transaction is still usable after the failed savepoint.
    const ok = await t.client.query<{ one: number }>('SELECT 1 AS one');
    expect(ok.rows[0]!.one).toBe(1);
  });
});
