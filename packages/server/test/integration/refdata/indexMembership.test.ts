/**
 * `refdata/indexMembership.ts` — REF-07 (WORKPLAN §WP-04 acceptance row 5, DATA_MODEL §5
 * L860-955).
 *
 * Proves, against the real database:
 *   1. the roster as of the N-PORT report date and as of the later SSGA file date are different
 *      rosters, and a read as of a date between them still returns the earlier one;
 *   2. the adds and the drops between the two dates, derived from those two reads;
 *   3. the weights of a complete snapshot sum to ≈ 1, summed in Postgres at `numeric` precision;
 *   4. a drop is a **narrowing**, not a deletion: the dropped constituent is still a member on
 *      every date it really was one, and a past-dated read is unaffected;
 *   5. knowledge time is separate from valid time: asking for the SSGA date *as known before the
 *      SSGA file arrived* returns the N-PORT roster, not the later one (REF-03);
 *   6. re-running a snapshot writes nothing — counted by rows, not by a return value.
 *
 * Self-sufficient: WP-15's seed modules do not exist yet, so the fixture creates its own licence
 * rows, provenance rows, instrument ids and `indices` row inside the test's own rolled-back
 * transaction. The rosters are six instruments rather than 503 — the invariants are the same and
 * the 503-member case belongs to `test/replay/refdata/secNport.test.ts`, which has the fixture.
 */

import { describe, expect, it } from 'vitest';

import {
  changesBetween,
  indicesForInstrument,
  membersAsOf,
  membershipAsOf,
  recordSnapshot,
  retireMember,
  upsertIndex,
  upsertMember,
  weightSumAsOf,
} from '../../../src/refdata/indexMembership.js';
import { withTxDb } from '../../../src/test/db.js';

import type { TestDb } from '../../../src/test/db.js';

// ── The two snapshot dates and the instants they became known ────────────────────────────────
/** N-PORT `repPdDate`. */
const NPORT_DATE = '2026-06-30';
/** The filing's `acceptanceDateTime` — the instant the roster became known to us. */
const NPORT_KNOWN = new Date('2026-07-28T16:31:00Z');
/** The SSGA holdings file date. */
const SSGA_DATE = '2026-09-15';
const SSGA_KNOWN = new Date('2026-09-15T21:05:00Z');
/** A second SSGA file, one day later, with identical weights. */
const SSGA_NEXT_DATE = '2026-09-16';
const SSGA_NEXT_KNOWN = new Date('2026-09-16T21:05:00Z');
/** "As we know it now" — after everything above. */
const NOW = new Date('2026-09-20T00:00:00Z');

interface Fixture {
  indexId: number;
  /** Six instrument ids, in the order A…F, plus G, the constituent added by the SSGA file. */
  ids: Record<'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g', number>;
  provenance: (label: string, capturedAt: Date) => Promise<number>;
}

/** Licence rows (`provenance_source_known` demands them), provenance rows, ids, the index row. */
async function fixture(t: TestDb): Promise<Fixture> {
  for (const [sourceId, name] of [
    ['sec.archives', 'SEC EDGAR Archives'],
    ['ssga.holdings', 'SSGA fund holdings'],
  ] as const) {
    await t.client.query(
      `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind, attribution,
                                     rate_limit, valid_from)
       SELECT $1, $2, 'Test', 'public_domain', $2, 'n/a', timestamptz '2000-01-01'
        WHERE NOT EXISTS (SELECT 1 FROM licence_registry
                           WHERE source_id = $1 AND tx_to = 'infinity')`,
      [sourceId, name],
    );
  }

  const instrument = async (): Promise<number> => {
    const res = await t.client.query<{ id: string }>(
      `SELECT nextval('instrument_id_seq')::bigint AS id`,
    );
    return Number(res.rows[0]!.id);
  };

  const provenance = async (label: string, capturedAt: Date): Promise<number> => {
    const sourceId = label.startsWith('nport') ? 'sec.archives' : 'ssga.holdings';
    const res = await t.client.query<{ provenance_id: string }>(
      `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                               http_status, bytes, captured_at, adapter_version)
       VALUES ($1, $2, 'test://membership/' || $2, digest($2, 'sha256'), digest($2, 'sha256'),
               200, 0, $3, 'test/1.0.0')
       RETURNING provenance_id`,
      [sourceId, `${label}-${String(Math.random()).slice(2)}`, capturedAt.toISOString()],
    );
    return Number(res.rows[0]!.provenance_id);
  };

  const ids = {
    a: await instrument(),
    b: await instrument(),
    c: await instrument(),
    d: await instrument(),
    e: await instrument(),
    f: await instrument(),
    g: await instrument(),
  };
  const index = await upsertIndex(t.db, {
    code: `SPXT${ids.a}`, // unique per test: `indices.code` and `instrument_id` are both UNIQUE
    instrumentId: await instrument(),
    proxyFundInstrumentId: await instrument(),
    membershipSourceId: 'sec.archives',
    provider: 'test',
  });
  return { indexId: index.indexId, ids, provenance };
}

/** The N-PORT roster: six names, weights summing to exactly 1. */
function nportMembers(ids: Fixture['ids']): { instrumentId: number; weight: number }[] {
  return [
    { instrumentId: ids.a, weight: 0.3 },
    { instrumentId: ids.b, weight: 0.25 },
    { instrumentId: ids.c, weight: 0.2 },
    { instrumentId: ids.d, weight: 0.13 },
    { instrumentId: ids.e, weight: 0.07 },
    { instrumentId: ids.f, weight: 0.05 },
  ];
}

/** The SSGA roster: F has left, G has joined, A and B have been re-weighted. */
function ssgaMembers(ids: Fixture['ids']): { instrumentId: number; weight: number }[] {
  return [
    { instrumentId: ids.a, weight: 0.31 },
    { instrumentId: ids.b, weight: 0.24 },
    { instrumentId: ids.c, weight: 0.2 },
    { instrumentId: ids.d, weight: 0.13 },
    { instrumentId: ids.e, weight: 0.07 },
    { instrumentId: ids.g, weight: 0.05 },
  ];
}

/** Both snapshots, in the order they arrived. */
async function bothSnapshots(t: TestDb, f: Fixture): Promise<void> {
  await recordSnapshot(t.db, {
    indexId: f.indexId,
    asOfDate: NPORT_DATE,
    sourceId: 'sec.archives',
    provenanceId: await f.provenance('nport', NPORT_KNOWN),
    members: nportMembers(f.ids),
    txFrom: NPORT_KNOWN,
  });
  await recordSnapshot(t.db, {
    indexId: f.indexId,
    asOfDate: SSGA_DATE,
    sourceId: 'ssga.holdings',
    provenanceId: await f.provenance('ssga', SSGA_KNOWN),
    members: ssgaMembers(f.ids),
    txFrom: SSGA_KNOWN,
  });
}

async function memberVersionCount(t: TestDb, indexId: number): Promise<number> {
  const res = await t.client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM index_members WHERE index_id = $1',
    [indexId],
  );
  return Number(res.rows[0]!.n);
}

describe('membersAsOf (REF-07)', () => {
  const t = withTxDb();

  it('returns the N-PORT roster on the report date and the SSGA roster on the file date', async () => {
    const f = await fixture(t);
    await bothSnapshots(t, f);

    const atNport = await membersAsOf(t.db, f.indexId, membershipAsOf(NPORT_DATE, NOW));
    expect(atNport.map((m) => m.instrumentId)).toEqual(
      nportMembers(f.ids).map((m) => m.instrumentId),
    );
    expect(atNport.map((m) => m.weight)).toEqual([0.3, 0.25, 0.2, 0.13, 0.07, 0.05]);
    expect(new Set(atNport.map((m) => m.sourceId))).toEqual(new Set(['sec.archives']));
    expect(new Set(atNport.map((m) => m.asOfDate))).toEqual(new Set([NPORT_DATE]));

    const atSsga = await membersAsOf(t.db, f.indexId, membershipAsOf(SSGA_DATE, NOW));
    expect(atSsga.map((m) => m.instrumentId)).toEqual(
      ssgaMembers(f.ids).map((m) => m.instrumentId),
    );
    expect(atSsga.map((m) => m.weight)).toEqual([0.31, 0.24, 0.2, 0.13, 0.07, 0.05]);
    expect(atSsga.some((m) => m.instrumentId === f.ids.f)).toBe(false);
    expect(atSsga.some((m) => m.instrumentId === f.ids.g)).toBe(true);

    // Every row carries the provenance of the snapshot it came from (PayloadMeta.provenance[]).
    for (const member of atSsga) expect(member.provenanceId).toBeGreaterThan(0);
  });

  it('returns the earlier roster for a date between the two snapshots', async () => {
    const f = await fixture(t);
    await bothSnapshots(t, f);

    const between = await membersAsOf(t.db, f.indexId, membershipAsOf('2026-08-01', NOW));
    expect(between.map((m) => m.instrumentId).sort((x, y) => x - y)).toEqual(
      nportMembers(f.ids)
        .map((m) => m.instrumentId)
        .sort((x, y) => x - y),
    );
    // The dropped constituent is still a member here: the drop narrowed its valid range, it did
    // not delete it.
    const dropped = between.find((m) => m.instrumentId === f.ids.f);
    expect(dropped?.validTo.slice(0, 10)).toBe(SSGA_DATE);
    expect(dropped?.weight).toBe(0.05);
  });

  it('never lets a later file leak into an earlier knowledge instant (REF-03)', async () => {
    const f = await fixture(t);
    await bothSnapshots(t, f);

    // The SSGA date, as known the day before the SSGA file arrived: the roster we had then was
    // the N-PORT one, and G was not a member of anything.
    const knownBefore = await membersAsOf(
      t.db,
      f.indexId,
      membershipAsOf(SSGA_DATE, new Date('2026-09-14T00:00:00Z')),
    );
    expect(knownBefore.map((m) => m.instrumentId).sort((x, y) => x - y)).toEqual(
      nportMembers(f.ids)
        .map((m) => m.instrumentId)
        .sort((x, y) => x - y),
    );
    expect(knownBefore.some((m) => m.instrumentId === f.ids.g)).toBe(false);

    // …and nothing at all was known before the N-PORT filing was accepted.
    const beforeAnything = await membersAsOf(
      t.db,
      f.indexId,
      membershipAsOf(NPORT_DATE, new Date('2026-07-01T00:00:00Z')),
    );
    expect(beforeAnything).toEqual([]);
  });
});

describe('weightSumAsOf (REF-07)', () => {
  const t = withTxDb();

  it('sums a complete roster to ≈ 1 on both dates', async () => {
    const f = await fixture(t);
    await bothSnapshots(t, f);

    await expect(
      weightSumAsOf(t.db, f.indexId, membershipAsOf(NPORT_DATE, NOW)),
    ).resolves.toBeCloseTo(1, 9);
    await expect(
      weightSumAsOf(t.db, f.indexId, membershipAsOf(SSGA_DATE, NOW)),
    ).resolves.toBeCloseTo(1, 9);
  });

  it('is 0 for an index with no members at that pair of instants', async () => {
    const f = await fixture(t);
    await expect(weightSumAsOf(t.db, f.indexId, membershipAsOf(NPORT_DATE, NOW))).resolves.toBe(0);
  });

  it('drops out of the sum as soon as a constituent is retired', async () => {
    const f = await fixture(t);
    await bothSnapshots(t, f);
    await retireMember(t.db, {
      indexId: f.indexId,
      instrumentId: f.ids.a,
      asOfDate: '2026-09-17',
      txFrom: new Date('2026-09-17T21:00:00Z'),
    });
    await expect(
      weightSumAsOf(t.db, f.indexId, membershipAsOf('2026-09-17', NOW)),
    ).resolves.toBeCloseTo(0.69, 9);
    // …and not out of the sum on the day before it left.
    await expect(
      weightSumAsOf(t.db, f.indexId, membershipAsOf('2026-09-16', NOW)),
    ).resolves.toBeCloseTo(1, 9);
  });
});

describe('changesBetween (REF-07 adds and drops)', () => {
  const t = withTxDb();

  it('reports the add, the drop and the reweights between the two dates', async () => {
    const f = await fixture(t);
    await bothSnapshots(t, f);

    const changes = await changesBetween(
      t.db,
      f.indexId,
      membershipAsOf(NPORT_DATE, NOW),
      membershipAsOf(SSGA_DATE, NOW),
    );

    expect(changes.adds.map((m) => m.instrumentId)).toEqual([f.ids.g]);
    expect(changes.adds[0]?.weight).toBe(0.05);
    expect(changes.adds[0]?.sourceId).toBe('ssga.holdings');

    expect(changes.drops.map((m) => m.instrumentId)).toEqual([f.ids.f]);
    expect(changes.drops[0]?.weight).toBe(0.05);
    // The drop carries the roster it left: the N-PORT snapshot.
    expect(changes.drops[0]?.sourceId).toBe('sec.archives');

    expect(changes.reweights.map((r) => [r.instrumentId, r.from, r.to])).toEqual([
      [f.ids.a, 0.3, 0.31],
      [f.ids.b, 0.25, 0.24],
    ]);
    expect(changes.reweights[0]?.delta).toBeCloseTo(0.01, 9);
  });

  it('reports nothing between two reads of the same roster', async () => {
    const f = await fixture(t);
    await bothSnapshots(t, f);
    const changes = await changesBetween(
      t.db,
      f.indexId,
      membershipAsOf(SSGA_DATE, NOW),
      membershipAsOf('2026-09-18', NOW),
    );
    expect(changes).toEqual({ adds: [], drops: [], reweights: [] });
  });
});

describe('recordSnapshot', () => {
  const t = withTxDb();

  it('writes what moved, retires what is missing and counts both', async () => {
    const f = await fixture(t);
    const first = await recordSnapshot(t.db, {
      indexId: f.indexId,
      asOfDate: NPORT_DATE,
      sourceId: 'sec.archives',
      provenanceId: await f.provenance('nport', NPORT_KNOWN),
      members: nportMembers(f.ids),
      txFrom: NPORT_KNOWN,
    });
    expect(first).toEqual({ written: 6, unchanged: 0, retired: 0 });

    const second = await recordSnapshot(t.db, {
      indexId: f.indexId,
      asOfDate: SSGA_DATE,
      sourceId: 'ssga.holdings',
      provenanceId: await f.provenance('ssga', SSGA_KNOWN),
      members: ssgaMembers(f.ids),
      txFrom: SSGA_KNOWN,
    });
    // Six writes, because the four unchanged weights now come from a different source — a fact
    // about where the number came from, which `source_id` records — and one retirement (F).
    expect(second).toEqual({ written: 6, unchanged: 0, retired: 1 });
  });

  it('writes nothing on a second file with the same weights, whatever its date (QA-02)', async () => {
    const f = await fixture(t);
    await bothSnapshots(t, f);
    const before = await memberVersionCount(t, f.indexId);

    const repeat = await recordSnapshot(t.db, {
      indexId: f.indexId,
      asOfDate: SSGA_NEXT_DATE,
      sourceId: 'ssga.holdings',
      provenanceId: await f.provenance('ssga', SSGA_NEXT_KNOWN),
      members: ssgaMembers(f.ids),
      txFrom: SSGA_NEXT_KNOWN,
    });
    expect(repeat).toEqual({ written: 0, unchanged: 6, retired: 0 });
    // Counted by rows, not by the return value: a boolean can lie, a row count cannot.
    expect(await memberVersionCount(t, f.indexId)).toBe(before);

    // And the roster on the new date is still the one the previous file established, still
    // stamped with the date it actually started on.
    const roster = await membersAsOf(t.db, f.indexId, membershipAsOf(SSGA_NEXT_DATE, NOW));
    expect(roster).toHaveLength(6);
    expect(new Set(roster.map((m) => m.asOfDate))).toEqual(new Set([SSGA_DATE]));
  });

  it('refuses a snapshot that names one instrument twice', async () => {
    const f = await fixture(t);
    await expect(
      recordSnapshot(t.db, {
        indexId: f.indexId,
        asOfDate: NPORT_DATE,
        sourceId: 'sec.archives',
        provenanceId: await f.provenance('nport', NPORT_KNOWN),
        members: [
          { instrumentId: f.ids.a, weight: 0.5 },
          { instrumentId: f.ids.a, weight: 0.5 },
        ],
        txFrom: NPORT_KNOWN,
      }),
    ).rejects.toThrow(/appears twice in one snapshot/);
  });
});

describe('upsertMember and retireMember', () => {
  const t = withTxDb();

  it('no-ops on an unchanged weight and writes when the weight moves', async () => {
    const f = await fixture(t);
    const p1 = await f.provenance('ssga', SSGA_KNOWN);
    const p2 = await f.provenance('ssga', SSGA_NEXT_KNOWN);

    const first = await upsertMember(t.db, {
      indexId: f.indexId,
      instrumentId: f.ids.a,
      weight: 0.00083321585405,
      shares: 1234.5,
      marketValue: 98765.43,
      asOfDate: SSGA_DATE,
      sourceId: 'ssga.holdings',
      provenanceId: p1,
      txFrom: SSGA_KNOWN,
    });
    expect(first).not.toBeNull();

    // The same weight, a day later, spelled at full source precision again. `numeric(12,10)`
    // rounds it to 0.0008332159 on the way in, so the comparison has to happen in Postgres.
    const again = await upsertMember(t.db, {
      indexId: f.indexId,
      instrumentId: f.ids.a,
      weight: 0.00083321585405,
      shares: 1234.5,
      marketValue: 98765.43,
      asOfDate: SSGA_NEXT_DATE,
      sourceId: 'ssga.holdings',
      provenanceId: p2,
      txFrom: SSGA_NEXT_KNOWN,
    });
    expect(again).toBeNull();
    expect(await memberVersionCount(t, f.indexId)).toBe(1);

    const moved = await upsertMember(t.db, {
      indexId: f.indexId,
      instrumentId: f.ids.a,
      weight: 0.0009,
      shares: 1234.5,
      marketValue: 98765.43,
      asOfDate: SSGA_NEXT_DATE,
      sourceId: 'ssga.holdings',
      provenanceId: p2,
      txFrom: SSGA_NEXT_KNOWN,
    });
    expect(moved).not.toBeNull();
    // Three rows, not two: the version that ran from the 15th is closed on the transaction axis,
    // its head [09-15, 09-16) is re-asserted with the old weight, and the new weight opens at the
    // 16th. The old weight was true on the 15th and a past-dated read must keep saying so.
    expect(await memberVersionCount(t, f.indexId)).toBe(3);
    const current = await t.client.query<{ weight: string; valid_from: string; valid_to: string }>(
      `SELECT weight, valid_from::text, valid_to::text FROM index_members
        WHERE index_id = $1 AND tx_to = 'infinity' ORDER BY valid_from`,
      [f.indexId],
    );
    expect(
      current.rows.map((r) => [
        Number(r.weight),
        r.valid_from.slice(0, 10),
        r.valid_to.slice(0, 10),
      ]),
    ).toEqual([
      [0.0008332159, SSGA_DATE, SSGA_NEXT_DATE],
      [0.0009, SSGA_NEXT_DATE, 'infinity'],
    ]);
  });

  it('narrows the valid range and keeps the head, and is idempotent', async () => {
    const f = await fixture(t);
    await recordSnapshot(t.db, {
      indexId: f.indexId,
      asOfDate: NPORT_DATE,
      sourceId: 'sec.archives',
      provenanceId: await f.provenance('nport', NPORT_KNOWN),
      members: nportMembers(f.ids),
      txFrom: NPORT_KNOWN,
    });

    const retired = await retireMember(t.db, {
      indexId: f.indexId,
      instrumentId: f.ids.f,
      asOfDate: SSGA_DATE,
      txFrom: SSGA_KNOWN,
    });
    expect(retired).toBe(1);

    const rows = await t.client.query<{ valid_from: string; valid_to: string; tx_to: string }>(
      `SELECT valid_from::text, valid_to::text, tx_to::text FROM index_members
        WHERE index_id = $1 AND instrument_id = $2 ORDER BY tx_from, valid_from`,
      [f.indexId, f.ids.f],
    );
    expect(rows.rows).toHaveLength(2);
    // The original version is closed on the transaction axis…
    expect(rows.rows[0]!.tx_to).not.toContain('infinity');
    expect(rows.rows[0]!.valid_to).toContain('infinity');
    // …and the head it really covered is re-asserted, ending at the drop date. No tail.
    expect(rows.rows[1]!.tx_to).toContain('infinity');
    expect(rows.rows[1]!.valid_from.slice(0, 10)).toBe(NPORT_DATE);
    expect(rows.rows[1]!.valid_to.slice(0, 10)).toBe(SSGA_DATE);

    // Retiring again on the same date writes nothing.
    await expect(
      retireMember(t.db, {
        indexId: f.indexId,
        instrumentId: f.ids.f,
        asOfDate: SSGA_DATE,
        txFrom: new Date('2026-09-16T00:00:00Z'),
      }),
    ).resolves.toBe(0);
    expect(
      (
        await t.client.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM index_members WHERE index_id = $1 AND instrument_id = $2',
          [f.indexId, f.ids.f],
        )
      ).rows[0]!.n,
    ).toBe('2');
  });
});

describe('indicesForInstrument', () => {
  const t = withTxDb();

  it('answers "which indices held this instrument" at a pair of instants', async () => {
    const f = await fixture(t);
    await bothSnapshots(t, f);

    const held = await indicesForInstrument(t.db, f.ids.f, membershipAsOf(NPORT_DATE, NOW));
    expect(held.map((i) => i.indexId)).toEqual([f.indexId]);
    expect(held[0]?.weight).toBe(0.05);
    expect(held[0]?.membershipSourceId).toBe('sec.archives');

    // …and not after it left.
    await expect(
      indicesForInstrument(t.db, f.ids.f, membershipAsOf(SSGA_DATE, NOW)),
    ).resolves.toEqual([]);
  });
});
