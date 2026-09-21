/**
 * `db/bitemporal.ts` — the normative write layer (WORKPLAN §WP-04 acceptance row 1, DATA_MODEL
 * §1.3 L187-247, ARCHITECTURE §4.3 L571-622, REF-03 / STOR-03).
 *
 * Proves, in this order:
 *   1. `writeVersion` closes the prior version and opens the new one, re-inserting the parts of
 *      the old valid range that stick out;
 *   2. `upsertVersion` no-ops on identical data (the property that makes `db:seed` and every
 *      ingest job idempotent) and writes when anything actually changed;
 *   3. `<table>_bt_excl` rejects an overlapping *current* valid range;
 *   4. `bt_guard_update` blocks an in-place update of a data column;
 *   5. the TESTING §7.10 `bt.correction` case — initial 2026-03-01 coupon 4.500, correction
 *      written 2026-03-10 as 4.250 over the *same* valid range, read at `knownAt` 2026-03-05 →
 *      4.500 and at 2026-03-12 → 4.250 — with **both versions written inside ONE transaction**,
 *      which is the case `VersionWrite.txFrom` exists for. The harness holds one transaction open
 *      for the whole test (TESTING §4.3), so "one transaction" is satisfied by construction and
 *      the `now()`-is-transaction-start trap is live in every test in this file.
 *
 * Self-sufficient by construction: WP-15 owns the seed modules and they do not exist yet, so the
 * fixture creates its own licence row, provenance rows and instrument id inside the test's own
 * rolled-back transaction. Nothing here assumes a seeded database.
 */

import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { govtTerms, identifiers } from '../../../src/db/schema/index.js';
import {
  BitemporalWriteError,
  asOf,
  bitemporal,
  current,
  nowAsOf,
  retireVersion,
  upsertVersion,
  writeVersion,
  type BitemporalKeys,
} from '../../../src/db/bitemporal.js';
import { identifierRepository } from '../../../src/refdata/identifiers.js';
import { withTxDb } from '../../../src/test/db.js';

import type { TestDb } from '../../../src/test/db.js';

// ── The tables under test, tagged with their `<table>_bt_excl` key columns ────────────────────
const btGovtTerms = bitemporal(govtTerms, 'instrumentId');
const btIdentifiers = bitemporal(identifiers, 'scheme', 'value', 'qualifier');

// ── TESTING §7.10 `bt.correction` ────────────────────────────────────────────────────────────
const CUSIP = '91282CJK8';
/** The valid range both versions of the correction share: re-stated, never changed. */
const VALID_FROM = new Date('2026-02-15T00:00:00Z');
const KNOWN_INITIAL = new Date('2026-03-01T00:00:00Z');
const KNOWN_CORRECTION = new Date('2026-03-10T00:00:00Z');
const VALID_AT = new Date('2026-03-14T00:00:00Z');
const BEFORE_CORRECTION = new Date('2026-03-05T12:00:00Z');
const AFTER_CORRECTION = new Date('2026-03-12T00:00:00Z');

type GovtRow = typeof govtTerms.$inferSelect;
type GovtData = Omit<GovtRow, BitemporalKeys | 'versionId'>;
type IdentifierRow = typeof identifiers.$inferSelect;
type IdentifierData = Omit<IdentifierRow, BitemporalKeys | 'versionId'>;

/** Every non-bitemporal column of `govt_terms`, so `data` really is `Omit<Row, …>`. */
function govtData(instrumentId: number, coupon: string, over: Partial<GovtData> = {}): GovtData {
  return {
    instrumentId,
    securityType: 'note',
    cusip: CUSIP,
    termLabel: '10Y',
    issueDate: '2026-02-15',
    datedDate: '2026-02-15',
    maturityDate: '2036-02-15',
    couponType: 'fixed',
    couponRate: coupon,
    couponFreq: 2,
    dayCount: 'ACT/ACT',
    firstCouponDate: '2026-08-15',
    lastRegularCoupon: null,
    businessDayConv: 'following',
    calendarId: 'SIFMA',
    settlementDays: 1,
    referenceIndex: null,
    spreadBp: null,
    indexRatioBase: null,
    isCallable: false,
    callSchedule: [],
    putSchedule: [],
    sinkSchedule: [],
    amortisation: [],
    makeWhole: null,
    covenants: null,
    guarantors: ['United States'],
    seniority: 'sovereign',
    collateral: null,
    minDenomination: '100.00',
    increment: '100.00',
    amountOutstanding: '40000000000.00',
    onTheRun: true,
    ...over,
  };
}

/**
 * The licence row `assert_source_known` demands, one provenance row per knowledge instant, and a
 * fresh instrument id from the shared sequence. Never assert a literal sequence value
 * (TESTING §4.3) — everything is read back.
 */
async function fixture(t: TestDb): Promise<{
  instrumentId: number;
  provenance: (label: string, capturedAt: Date) => Promise<number>;
}> {
  await t.client.query(
    `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind, attribution,
                                   rate_limit, valid_from)
     SELECT 'internal.user', 'Internal / user supplied', 'Terminal', 'internal',
            'Internal', 'n/a', timestamptz '2000-01-01'
      WHERE NOT EXISTS (SELECT 1 FROM licence_registry
                         WHERE source_id = 'internal.user' AND tx_to = 'infinity')`,
  );
  const seq = await t.client.query<{ id: string }>(
    `SELECT nextval('instrument_id_seq')::bigint AS id`,
  );
  const instrumentId = Number(seq.rows[0]!.id);

  const provenance = async (label: string, capturedAt: Date): Promise<number> => {
    const res = await t.client.query<{ provenance_id: string }>(
      `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                               http_status, bytes, captured_at, adapter_version)
       VALUES ('internal.user', $1, 'test://bitemporal/' || $1, digest($1, 'sha256'),
               digest($1, 'sha256'), 200, 0, $2, 'test/1.0.0')
       RETURNING provenance_id`,
      [`${label}-${instrumentId}`, capturedAt.toISOString()],
    );
    return Number(res.rows[0]!.provenance_id);
  };

  return { instrumentId, provenance };
}

interface VersionRow {
  version_id: string;
  coupon_rate: string | null;
  valid_from: string;
  valid_to: string;
  tx_from: string;
  tx_to: string;
  provenance_id: string;
}

/** Every version of one instrument, ordered as the two axes were written. */
async function versions(t: TestDb, instrumentId: number): Promise<VersionRow[]> {
  const res = await t.client.query<VersionRow>(
    `SELECT version_id, coupon_rate, valid_from::text, valid_to::text,
            tx_from::text, tx_to::text, provenance_id
       FROM govt_terms WHERE instrument_id = $1
      ORDER BY tx_from, valid_from`,
    [instrumentId],
  );
  return res.rows;
}

/** The as-of read, through the exported `asOf()` predicate rather than hand-written SQL. */
async function couponAsOf(
  t: TestDb,
  instrumentId: number,
  validAt: Date,
  knownAt: Date,
): Promise<string[]> {
  const rows = await t.db
    .select({ couponRate: govtTerms.couponRate })
    .from(govtTerms)
    .where(and(eq(govtTerms.instrumentId, instrumentId), asOf(btGovtTerms, { validAt, knownAt })));
  return rows.map((r) => r.couponRate ?? 'null');
}

/**
 * The SQLSTATE and message of the Postgres error a statement raised. Drizzle wraps a driver error
 * in a `DrizzleQueryError` whose `message` is the failed SQL, so the assertions below unwrap
 * `cause` — `db/bitemporal.ts` deliberately does not wrap anything itself.
 */
async function pgError(
  t: TestDb,
  fn: () => Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await t.savepoint(fn);
  } catch (err) {
    let e = err as { code?: string; message?: string; cause?: unknown };
    while (e.code === undefined && e.cause !== undefined) {
      e = e.cause as { code?: string; message?: string; cause?: unknown };
    }
    return { code: e.code, message: e.message ?? String(err) };
  }
  throw new Error('expected the statement to be rejected by the database');
}

describe('writeVersion', () => {
  const t = withTxDb();

  it('closes the prior version and opens the new one, keeping the old valid remainder', async () => {
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('wv-initial', KNOWN_INITIAL);
    const p2 = await provenance('wv-change', KNOWN_CORRECTION);

    const first = await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: VALID_FROM,
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial',
      txFrom: KNOWN_INITIAL,
    });

    // A CHANGE: from 2026-06-15 the coupon really is 5.000. The old version keeps
    // [2026-02-15, 2026-06-15) and is superseded from there on.
    const changeFrom = new Date('2026-06-15T00:00:00Z');
    const second = await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: changeFrom,
      data: govtData(instrumentId, '5.000'),
      provenanceId: p2,
      reason: 'change',
      txFrom: KNOWN_CORRECTION,
    });

    expect(second).not.toBe(first);
    const rows = await versions(t, instrumentId);
    // Three rows: the closed original, its re-inserted head remainder, and the new version.
    expect(rows).toHaveLength(3);

    const closed = rows.find((r) => Number(r.version_id) === first);
    expect(closed?.tx_to).toBe(closed !== undefined ? rows[1]!.tx_from : '');
    expect(closed?.coupon_rate).toBe('4.500000');

    const currentRows = rows.filter((r) => r.tx_to.includes('infinity'));
    expect(currentRows).toHaveLength(2);
    expect(
      currentRows.map((r) => [r.coupon_rate, r.valid_from.slice(0, 10), r.valid_to.slice(0, 10)]),
    ).toEqual([
      ['4.500000', '2026-02-15', '2026-06-15'],
      ['5.000000', '2026-06-15', 'infinity'],
    ]);

    // The remainder keeps the OLD provenance — it is the old fact, not a new one.
    const remainder = currentRows.find((r) => r.coupon_rate === '4.500000');
    expect(Number(remainder?.provenance_id)).toBe(p1);

    // And the two as-of reads that the split exists for.
    const now = new Date('2026-07-01T00:00:00Z');
    await expect(
      couponAsOf(t, instrumentId, new Date('2026-03-01T00:00:00Z'), now),
    ).resolves.toEqual(['4.500000']);
    await expect(
      couponAsOf(t, instrumentId, new Date('2026-07-01T00:00:00Z'), now),
    ).resolves.toEqual(['5.000000']);
  });

  it('re-inserts both remainders when the new range sits inside the old one', async () => {
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('wv-wide', KNOWN_INITIAL);
    const p2 = await provenance('wv-inner', KNOWN_CORRECTION);

    await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: new Date('2026-01-01T00:00:00Z'),
      validTo: new Date('2027-01-01T00:00:00Z'),
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial',
      txFrom: KNOWN_INITIAL,
    });
    await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: new Date('2026-05-01T00:00:00Z'),
      validTo: new Date('2026-08-01T00:00:00Z'),
      data: govtData(instrumentId, '9.000'),
      provenanceId: p2,
      reason: 'change',
      txFrom: KNOWN_CORRECTION,
    });

    const rows = await versions(t, instrumentId);
    const currentRows = rows.filter((r) => r.tx_to.includes('infinity'));
    expect(
      currentRows.map((r) => [r.coupon_rate, r.valid_from.slice(0, 10), r.valid_to.slice(0, 10)]),
    ).toEqual([
      ['4.500000', '2026-01-01', '2026-05-01'],
      ['9.000000', '2026-05-01', '2026-08-01'],
      ['4.500000', '2026-08-01', '2027-01-01'],
    ]);
  });

  it('works without txFrom inside one transaction, because the default is clock_timestamp()', async () => {
    // The regression guard for the `now()` trap: two versions of one key, one transaction, no
    // explicit knowledge instant. With `now()` the close would set tx_to = tx_from and
    // bt_guard_update would raise 'tx_to must be after tx_from'.
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('wv-clock-1', KNOWN_INITIAL);
    const p2 = await provenance('wv-clock-2', KNOWN_CORRECTION);

    await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: VALID_FROM,
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial',
    });
    await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: VALID_FROM,
      data: govtData(instrumentId, '4.250'),
      provenanceId: p2,
      reason: 'correction',
    });

    const rows = await versions(t, instrumentId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tx_to).toBe(rows[1]!.tx_from);
    expect(rows[0]!.tx_from < rows[0]!.tx_to).toBe(true);
    expect(rows[1]!.tx_to).toContain('infinity');
  });

  it('writes a composite-key table (identifiers) through the same path', async () => {
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('id-initial', KNOWN_INITIAL);
    const p2 = await provenance('id-correction', KNOWN_CORRECTION);

    const data = (entityId: number): IdentifierData => ({
      entityKind: 'instrument',
      entityId,
      scheme: 'CUSIP',
      value: CUSIP,
      qualifier: '',
      isPrimary: true,
    });

    await writeVersion(t.db, btIdentifiers, {
      entityKey: { scheme: 'CUSIP', value: CUSIP, qualifier: '' },
      validFrom: VALID_FROM,
      data: data(instrumentId),
      provenanceId: p1,
      reason: 'initial',
      txFrom: KNOWN_INITIAL,
    });
    // The same identifier, re-pointed at another entity: the composite key must close the first.
    await writeVersion(t.db, btIdentifiers, {
      entityKey: { scheme: 'CUSIP', value: CUSIP, qualifier: '' },
      validFrom: VALID_FROM,
      data: data(instrumentId + 1),
      provenanceId: p2,
      reason: 'correction',
      txFrom: KNOWN_CORRECTION,
    });

    const res = await t.client.query<{ entity_id: string; tx_to: string }>(
      `SELECT entity_id, tx_to::text FROM identifiers
        WHERE scheme = 'CUSIP' AND value = $1 AND qualifier = '' ORDER BY tx_from`,
      [CUSIP],
    );
    expect(res.rows.map((r) => Number(r.entity_id))).toEqual([instrumentId, instrumentId + 1]);
    expect(res.rows[0]!.tx_to).not.toContain('infinity');
    expect(res.rows[1]!.tx_to).toContain('infinity');
  });
});

describe('upsertVersion', () => {
  const t = withTxDb();

  it('no-ops on identical data and writes when a field changes', async () => {
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('up-1', KNOWN_INITIAL);
    const p2 = await provenance('up-2', KNOWN_CORRECTION);
    const p3 = await provenance('up-3', new Date('2026-03-20T00:00:00Z'));

    const write = {
      entityKey: { instrumentId },
      validFrom: VALID_FROM,
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial' as const,
      txFrom: KNOWN_INITIAL,
    };

    const first = await upsertVersion(t.db, btGovtTerms, write);
    expect(first).not.toBeNull();

    // A second ingest run: same facts, a fresh fetch (so a different provenance row) and a later
    // knowledge instant. Nothing may be written — that is job idempotency (QA-02).
    const second = await upsertVersion(t.db, btGovtTerms, {
      ...write,
      provenanceId: p2,
      reason: 'change',
      txFrom: KNOWN_CORRECTION,
    });
    expect(second).toBeNull();
    // Counted by rows, not by the return value: a boolean can lie, a row count cannot.
    expect(await versions(t, instrumentId)).toHaveLength(1);

    // A third run where one field really moved.
    const third = await upsertVersion(t.db, btGovtTerms, {
      ...write,
      data: govtData(instrumentId, '4.250'),
      provenanceId: p3,
      reason: 'correction',
      txFrom: new Date('2026-03-20T00:00:00Z'),
    });
    expect(third).not.toBeNull();
    expect(third).not.toBe(first);
    const rows = await versions(t, instrumentId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.coupon_rate)).toEqual(['4.500000', '4.250000']);
  });

  it('no-ops on a jsonb / array column that is equal but not string-identical', async () => {
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('up-json-1', KNOWN_INITIAL);
    const p2 = await provenance('up-json-2', KNOWN_CORRECTION);

    const base = govtData(instrumentId, '4.500', {
      callSchedule: [{ date: '2031-02-15', price: 100 }],
      guarantors: ['United States'],
      // numeric(9,6): the column stores 4.500000 whatever the caller spelled.
      couponRate: '4.5',
    });
    const written = await upsertVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: VALID_FROM,
      data: base,
      provenanceId: p1,
      reason: 'initial',
      txFrom: KNOWN_INITIAL,
    });
    expect(written).not.toBeNull();

    const again = await upsertVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: VALID_FROM,
      // Same facts, spelled differently: a number where a string was used, the same JSON object.
      data: govtData(instrumentId, '4.500000', {
        callSchedule: [{ date: '2031-02-15', price: 100 }],
        guarantors: ['United States'],
      }),
      provenanceId: p2,
      reason: 'change',
      txFrom: KNOWN_CORRECTION,
    });
    expect(again).toBeNull();
    expect(await versions(t, instrumentId)).toHaveLength(1);

    // …but a genuinely different array is a change.
    const changed = await upsertVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: VALID_FROM,
      data: govtData(instrumentId, '4.500', {
        callSchedule: [{ date: '2031-02-15', price: 100 }],
        guarantors: ['United States', 'Treasury'],
      }),
      provenanceId: p2,
      reason: 'change',
      txFrom: new Date('2026-03-20T00:00:00Z'),
    });
    expect(changed).not.toBeNull();
    expect(await versions(t, instrumentId)).toHaveLength(2);
  });

  it('no-ops on a NARROWER validTo, because writing one would not end the fact either', async () => {
    // The audit round asked whether `upsertVersion({ …, validTo })` on identical data must write,
    // on the reading that a caller-supplied `validTo` claims the fact stops being true there.
    // Re-derived here against the database rather than argued: it does not. `writeVersion` over
    // `[2020, 2024)` against a stored `[2020, infinity)` closes the stored version and re-inserts
    // its TAIL `[2024, infinity)` with the old data, so the fact survives the narrowing and every
    // as-of read answers exactly as before. The no-op therefore loses nothing — and what a caller
    // who really means "not true from 2024" needs is `retireVersion`, tested below.
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('narrow-1', KNOWN_INITIAL);
    const p2 = await provenance('narrow-2', KNOWN_CORRECTION);
    const from2020 = new Date('2020-01-01T00:00:00Z');
    const end2024 = new Date('2024-01-01T00:00:00Z');
    const at2025 = new Date('2025-06-01T00:00:00Z');

    await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: from2020,
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial',
      txFrom: KNOWN_INITIAL,
    });

    const narrowed = await upsertVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: from2020,
      validTo: end2024,
      data: govtData(instrumentId, '4.500'),
      provenanceId: p2,
      reason: 'change',
      txFrom: KNOWN_CORRECTION,
    });
    expect(narrowed).toBeNull();
    expect(await versions(t, instrumentId)).toHaveLength(1);
    // Still true in 2025 — and that is ALSO what the write would have left behind.
    await expect(couponAsOf(t, instrumentId, at2025, AFTER_CORRECTION)).resolves.toEqual([
      '4.500000',
    ]);

    // The control: force the same narrowing through `writeVersion` on a second instrument and
    // show the tail coming back. Same answers, three rows instead of one.
    const second = await fixture(t);
    await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId: second.instrumentId },
      validFrom: from2020,
      data: govtData(second.instrumentId, '4.500'),
      provenanceId: await second.provenance('narrow-ctl-1', KNOWN_INITIAL),
      reason: 'initial',
      txFrom: KNOWN_INITIAL,
    });
    await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId: second.instrumentId },
      validFrom: from2020,
      validTo: end2024,
      data: govtData(second.instrumentId, '4.500'),
      provenanceId: await second.provenance('narrow-ctl-2', KNOWN_CORRECTION),
      reason: 'change',
      txFrom: KNOWN_CORRECTION,
    });
    const ctl = (await versions(t, second.instrumentId)).filter((r) =>
      r.tx_to.includes('infinity'),
    );
    expect(ctl.map((r) => [r.valid_from.slice(0, 10), r.valid_to.slice(0, 10)])).toEqual([
      ['2020-01-01', '2024-01-01'],
      ['2024-01-01', 'infinity'],
    ]);
    await expect(couponAsOf(t, second.instrumentId, at2025, AFTER_CORRECTION)).resolves.toEqual([
      '4.500000',
    ]);
  });

  it('is the same story through IdentifierRepository.upsert, and retire() is the way out', async () => {
    // Measured through the public repository API, which is where the audit round looked.
    const { instrumentId, provenance } = await fixture(t);
    const repo = identifierRepository(t.db);
    const from2020 = new Date('2020-01-01T00:00:00Z');
    const end2024 = new Date('2024-01-01T00:00:00Z');
    const at2025 = { validAt: new Date('2025-06-01T00:00:00Z'), knownAt: AFTER_CORRECTION };
    const at2022 = { validAt: new Date('2022-06-01T00:00:00Z'), knownAt: AFTER_CORRECTION };
    const input = {
      entityKind: 'instrument' as const,
      entityId: instrumentId,
      scheme: 'CUSIP' as const,
      value: CUSIP,
    };

    await repo.upsert(input, {
      validFrom: from2020,
      provenanceId: await provenance('repo-1', KNOWN_INITIAL),
      knownAt: KNOWN_INITIAL,
      reason: 'initial',
    });
    const narrowing = await repo.upsert(input, {
      validFrom: from2020,
      validTo: end2024,
      provenanceId: await provenance('repo-2', KNOWN_CORRECTION),
      knownAt: KNOWN_CORRECTION,
    });
    expect(narrowing).toBeNull();
    expect(await repo.entityOf({ scheme: 'CUSIP', value: CUSIP, qualifier: '' }, at2025)).toEqual({
      entityKind: 'instrument',
      entityId: instrumentId,
    });

    // `retire()` is what actually ends it: gone in 2025, untouched in 2022.
    const narrowed = await repo.retire(
      { scheme: 'CUSIP', value: CUSIP, qualifier: '' },
      { validTo: end2024, knownAt: new Date('2026-03-20T00:00:00Z') },
    );
    expect(narrowed).toBe(1);
    expect(
      await repo.entityOf(
        { scheme: 'CUSIP', value: CUSIP, qualifier: '' },
        {
          validAt: at2025.validAt,
          knownAt: new Date('2026-03-21T00:00:00Z'),
        },
      ),
    ).toBeNull();
    expect(
      await repo.entityOf(
        { scheme: 'CUSIP', value: CUSIP, qualifier: '' },
        {
          validAt: at2022.validAt,
          knownAt: new Date('2026-03-21T00:00:00Z'),
        },
      ),
    ).toEqual({ entityKind: 'instrument', entityId: instrumentId });

    // …and the retirement is invisible to a reader who stopped watching before it.
    expect(await repo.entityOf({ scheme: 'CUSIP', value: CUSIP, qualifier: '' }, at2025)).toEqual({
      entityKind: 'instrument',
      entityId: instrumentId,
    });

    // Re-running the retiring job writes nothing.
    expect(
      await repo.retire(
        { scheme: 'CUSIP', value: CUSIP, qualifier: '' },
        { validTo: end2024, knownAt: new Date('2026-03-22T00:00:00Z') },
      ),
    ).toBe(0);
  });

  it('writes when the requested valid range is not already covered', async () => {
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('up-range-1', KNOWN_INITIAL);
    const p2 = await provenance('up-range-2', KNOWN_CORRECTION);

    await upsertVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: new Date('2026-02-15T00:00:00Z'),
      validTo: new Date('2026-06-15T00:00:00Z'),
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial',
      txFrom: KNOWN_INITIAL,
    });
    // Same data, but asserted over a range that runs past the closed end: that is new information.
    const extended = await upsertVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: new Date('2026-02-15T00:00:00Z'),
      data: govtData(instrumentId, '4.500'),
      provenanceId: p2,
      reason: 'change',
      txFrom: KNOWN_CORRECTION,
    });
    expect(extended).not.toBeNull();
    const currentRows = (await versions(t, instrumentId)).filter((r) =>
      r.tx_to.includes('infinity'),
    );
    expect(currentRows.map((r) => r.valid_to.slice(0, 10))).toEqual(['infinity']);
  });
});

describe('retireVersion', () => {
  const t = withTxDb();

  it('keeps the head, drops the tail, and leaves earlier knowledge untouched', async () => {
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('retire-1', KNOWN_INITIAL);
    const from2020 = new Date('2020-01-01T00:00:00Z');
    const end2024 = new Date('2024-01-01T00:00:00Z');

    await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: from2020,
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial',
      txFrom: KNOWN_INITIAL,
    });

    expect(
      await retireVersion(t.db, btGovtTerms, {
        entityKey: { instrumentId },
        validTo: end2024,
        txFrom: KNOWN_CORRECTION,
      }),
    ).toBe(1);

    const rows = await versions(t, instrumentId);
    const currentRows = rows.filter((r) => r.tx_to.includes('infinity'));
    expect(currentRows.map((r) => [r.valid_from.slice(0, 10), r.valid_to.slice(0, 10)])).toEqual([
      ['2020-01-01', '2024-01-01'],
    ]);
    // The head keeps the ORIGINAL provenance: it is the old fact, over the range it really held.
    expect(Number(currentRows[0]!.provenance_id)).toBe(p1);

    const after = new Date('2025-06-01T00:00:00Z');
    await expect(couponAsOf(t, instrumentId, after, AFTER_CORRECTION)).resolves.toEqual([]);
    await expect(
      couponAsOf(t, instrumentId, new Date('2022-06-01T00:00:00Z'), AFTER_CORRECTION),
    ).resolves.toEqual(['4.500000']);
    // Before we knew, it was still true in 2025.
    await expect(couponAsOf(t, instrumentId, after, BEFORE_CORRECTION)).resolves.toEqual([
      '4.500000',
    ]);
  });

  it('retracts a version that starts after the retirement date, and no-ops when already retired', async () => {
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('retire-late-1', KNOWN_INITIAL);
    await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: new Date('2026-02-15T00:00:00Z'),
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial',
      txFrom: KNOWN_INITIAL,
    });

    // Retired from a date BEFORE the version even starts: nothing survives, and no head is kept.
    expect(
      await retireVersion(t.db, btGovtTerms, {
        entityKey: { instrumentId },
        validTo: new Date('2026-01-01T00:00:00Z'),
        txFrom: KNOWN_CORRECTION,
      }),
    ).toBe(1);
    expect((await versions(t, instrumentId)).filter((r) => r.tx_to.includes('infinity'))).toEqual(
      [],
    );

    // A second pass finds nothing open past that date.
    expect(
      await retireVersion(t.db, btGovtTerms, {
        entityKey: { instrumentId },
        validTo: new Date('2026-01-01T00:00:00Z'),
        txFrom: new Date('2026-03-20T00:00:00Z'),
      }),
    ).toBe(0);
  });
});

describe('the preconditions writeVersion refuses before any statement runs', () => {
  const t = withTxDb();

  it('rejects a txFrom in the future, which no read could ever see', async () => {
    // A row with tx_from ahead of the clock is invisible to every present-instant read AND
    // un-repairable by a re-run (upsertVersion's no-op test matches on tx_to = 'infinity', which
    // the invisible row satisfies). One timezone mis-parse of a SEC acceptanceDateTime is enough.
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('future-1', KNOWN_INITIAL);
    const future = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);

    await expect(
      writeVersion(t.db, btGovtTerms, {
        entityKey: { instrumentId },
        validFrom: VALID_FROM,
        data: govtData(instrumentId, '4.500'),
        provenanceId: p1,
        reason: 'initial',
        txFrom: future,
      }),
    ).rejects.toThrowError(BitemporalWriteError);
    await expect(
      upsertVersion(t.db, btGovtTerms, {
        entityKey: { instrumentId },
        validFrom: VALID_FROM,
        data: govtData(instrumentId, '4.500'),
        provenanceId: p1,
        reason: 'initial',
        txFrom: future,
      }),
    ).rejects.toThrowError(/govt_terms: txFrom .* is in the future/);
    expect(await versions(t, instrumentId)).toEqual([]);

    // A knowledge instant a few seconds ahead of the database clock is skew, not a mistake.
    const skewed = await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: VALID_FROM,
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial',
      txFrom: new Date(Date.now() + 2_000),
    });
    expect(skewed).toBeGreaterThan(0);
  });

  it('rejects an inverted or empty valid range under ONE error, not two SQLSTATEs', async () => {
    // Measured: validFrom == validTo raises 23514 (govt_terms_valid_range) from the table, while
    // validFrom > validTo raises 22000 from the tstzrange() in step 1a — before any constraint is
    // reached. A caller told to branch on 23514 would miss half of its own mistake.
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('range-1', KNOWN_INITIAL);
    const base = {
      entityKey: { instrumentId },
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial' as const,
      txFrom: KNOWN_INITIAL,
    };

    await expect(
      writeVersion(t.db, btGovtTerms, {
        ...base,
        validFrom: new Date('2026-06-01T00:00:00Z'),
        validTo: new Date('2026-01-01T00:00:00Z'),
      }),
    ).rejects.toThrowError(/must be strictly before validTo/);
    await expect(
      writeVersion(t.db, btGovtTerms, { ...base, validFrom: VALID_FROM, validTo: VALID_FROM }),
    ).rejects.toThrowError(BitemporalWriteError);
    await expect(
      upsertVersion(t.db, btGovtTerms, {
        ...base,
        validFrom: new Date('2026-06-01T00:00:00Z'),
        validTo: new Date('2026-01-01T00:00:00Z'),
      }),
    ).rejects.toThrowError(BitemporalWriteError);

    // Nothing was written, and the transaction is still usable — these never reached Postgres.
    expect(await versions(t, instrumentId)).toEqual([]);
  });
});

describe('the database invariants writeVersion relies on', () => {
  const t = withTxDb();

  it('rejects an overlapping current valid range with 23P01 (govt_terms_bt_excl)', async () => {
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('excl-1', KNOWN_INITIAL);

    await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: VALID_FROM,
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial',
      txFrom: KNOWN_INITIAL,
    });

    // A raw INSERT — the thing `writeVersion` exists to stop anyone doing — overlapping the
    // current version's valid range.
    const raw = await pgError(t, async () => {
      await t.client.query(
        `INSERT INTO govt_terms (instrument_id, security_type, cusip, maturity_date, coupon_type,
                                 coupon_rate, day_count, valid_from, tx_from, provenance_id)
         VALUES ($1, 'note', $2, DATE '2036-02-15', 'fixed', 9.999, 'ACT/ACT', $3, $4, $5)`,
        [instrumentId, CUSIP, '2026-09-01T00:00:00Z', KNOWN_CORRECTION.toISOString(), p1],
      );
    });
    expect(raw.code).toBe('23P01');
    expect(raw.message).toContain('govt_terms_bt_excl');
  });

  it('revokes DELETE from terminal_app — the half of WORM the trigger does not cover', async () => {
    // `bt_guard_update` stops an UPDATE and fires for superusers too, so the suite covers it from
    // any role. DELETE is stopped by a GRANT, and the harness connects as the owner (superuser on
    // a developer box), which bypasses it — so the module header's "DELETE is revoked from
    // terminal_app" was asserted nowhere. Adopting the role inside the test transaction exercises
    // exactly the privilege the application pool runs with, without a second connection.
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('worm-1', KNOWN_INITIAL);
    const versionId = await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: VALID_FROM,
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial',
      txFrom: KNOWN_INITIAL,
    });

    const grants = await t.client.query<{
      can_select: boolean;
      can_insert: boolean;
      can_delete: boolean;
      can_adopt: boolean;
    }>(
      `SELECT has_table_privilege('terminal_app', 'govt_terms', 'SELECT') AS can_select,
              has_table_privilege('terminal_app', 'govt_terms', 'INSERT') AS can_insert,
              has_table_privilege('terminal_app', 'govt_terms', 'DELETE') AS can_delete,
              pg_has_role(current_user, 'terminal_app', 'MEMBER')          AS can_adopt
         WHERE to_regrole('terminal_app') IS NOT NULL`,
    );
    const g = grants.rows[0];
    // migration 0015 creates the role; if this database predates it there is nothing to assert.
    expect(g).toBeDefined();
    expect([g!.can_select, g!.can_insert, g!.can_delete]).toEqual([true, true, false]);
    if (!g!.can_adopt) return; // the test user cannot SET ROLE; the grant matrix above still holds

    const denied = await pgError(t, async () => {
      await t.client.query('SET LOCAL ROLE terminal_app');
      // The role can read its own writes…
      await t.client.query('SELECT 1 FROM govt_terms WHERE version_id = $1', [versionId]);
      // …and cannot delete them.
      await t.client.query('DELETE FROM govt_terms WHERE version_id = $1', [versionId]);
    });
    expect(denied.code).toBe('42501');
    expect(denied.message).toMatch(/permission denied for (table|relation) govt_terms/);
    await t.client.query('RESET ROLE');

    // The version is still there, under the owner's own eyes.
    expect(await versions(t, instrumentId)).toHaveLength(1);
  });

  it('blocks an in-place update of a data column (bt_guard_update)', async () => {
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('guard-1', KNOWN_INITIAL);
    const versionId = await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: VALID_FROM,
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial',
      txFrom: KNOWN_INITIAL,
    });

    // Raw SQL…
    const raw = await pgError(t, async () => {
      await t.client.query(`UPDATE govt_terms SET coupon_rate = 1.000 WHERE version_id = $1`, [
        versionId,
      ]);
    });
    expect(raw.message).toMatch(/immutable|only tx_to may change/);

    // …and through the ORM, which is the same UPDATE with a nicer spelling. An invariant that a
    // repository can step around by using Drizzle instead of SQL is not an invariant.
    const orm = await pgError(t, async () => {
      await t.db
        .update(govtTerms)
        .set({ couponRate: '1.000' })
        .where(eq(govtTerms.versionId, versionId));
    });
    expect(orm.message).toMatch(/immutable|only tx_to may change/);

    // Closing tx_to and changing a column in the same UPDATE is blocked too.
    const sneaky = await pgError(t, async () => {
      await t.client.query(
        `UPDATE govt_terms SET coupon_rate = 1.000, tx_to = timestamptz '2026-03-20'
          WHERE version_id = $1`,
        [versionId],
      );
    });
    expect(sneaky.message).toContain('only tx_to may change');

    // The row is untouched.
    const rows = await versions(t, instrumentId);
    expect(rows.map((r) => r.coupon_rate)).toEqual(['4.500000']);
  });

  it('refuses to close a version at an instant that is not after its tx_from', async () => {
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('backdate-1', KNOWN_CORRECTION);
    const p2 = await provenance('backdate-2', KNOWN_INITIAL);

    await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: VALID_FROM,
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial',
      txFrom: KNOWN_CORRECTION,
    });

    // A caller that backdates *below* the version it is closing is rejected, not silently
    // accepted: it would otherwise invert the transaction-time axis.
    const backdated = await pgError(t, async () => {
      await writeVersion(t.db, btGovtTerms, {
        entityKey: { instrumentId },
        validFrom: VALID_FROM,
        data: govtData(instrumentId, '4.250'),
        provenanceId: p2,
        reason: 'correction',
        txFrom: KNOWN_INITIAL,
      });
    });
    expect(backdated.message).toContain('tx_to must be after tx_from');
  });
});

describe('bt.correction (TESTING §7.10, DATA_MODEL §1.4)', () => {
  const t = withTxDb();

  /** Both versions, written through `writeVersion` inside the ONE transaction the harness holds. */
  async function writeCorrectedNote(): Promise<{ instrumentId: number; versionIds: number[] }> {
    const { instrumentId, provenance } = await fixture(t);
    const p1 = await provenance('bt-initial', KNOWN_INITIAL);
    const p2 = await provenance('bt-correction', KNOWN_CORRECTION);

    await writeVersion(t.db, btIdentifiers, {
      entityKey: { scheme: 'CUSIP', value: CUSIP, qualifier: '' },
      validFrom: VALID_FROM,
      data: {
        entityKind: 'instrument',
        entityId: instrumentId,
        scheme: 'CUSIP',
        value: CUSIP,
        qualifier: '',
        isPrimary: true,
      },
      provenanceId: p1,
      reason: 'initial',
      txFrom: KNOWN_INITIAL,
    });

    // 2026-03-01: what we first believed.
    const initial = await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: VALID_FROM,
      data: govtData(instrumentId, '4.500'),
      provenanceId: p1,
      reason: 'initial',
      txFrom: KNOWN_INITIAL,
    });
    // 2026-03-10: the coupon was always 4.250 — same valid range, later transaction time.
    const corrected = await writeVersion(t.db, btGovtTerms, {
      entityKey: { instrumentId },
      validFrom: VALID_FROM,
      data: govtData(instrumentId, '4.250'),
      provenanceId: p2,
      reason: 'correction',
      txFrom: KNOWN_CORRECTION,
    });

    return { instrumentId, versionIds: [initial, corrected] };
  }

  it('returns 4.500 at knownAt 2026-03-05 and 4.250 at 2026-03-12', async () => {
    const { instrumentId } = await writeCorrectedNote();
    await expect(couponAsOf(t, instrumentId, VALID_AT, BEFORE_CORRECTION)).resolves.toEqual([
      '4.500000',
    ]);
    await expect(couponAsOf(t, instrumentId, VALID_AT, AFTER_CORRECTION)).resolves.toEqual([
      '4.250000',
    ]);
  });

  it('answers the DATA_MODEL §1.4 worked query, joined through identifiers', async () => {
    await writeCorrectedNote();
    const worked = `
      SELECT g.coupon_rate
        FROM govt_terms g
        JOIN identifiers i ON i.entity_kind = 'instrument' AND i.entity_id = g.instrument_id
                          AND i.scheme = 'CUSIP' AND i.value = $1
       WHERE bt_as_of(g.valid_from, g.valid_to, g.tx_from, g.tx_to, $2, $3)
         AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to, $2, $3)`;
    const before = await t.client.query<{ coupon_rate: string }>(worked, [
      CUSIP,
      VALID_AT.toISOString(),
      BEFORE_CORRECTION.toISOString(),
    ]);
    expect(before.rows.map((r) => r.coupon_rate)).toEqual(['4.500000']);

    const after = await t.client.query<{ coupon_rate: string }>(worked, [
      CUSIP,
      VALID_AT.toISOString(),
      AFTER_CORRECTION.toISOString(),
    ]);
    expect(after.rows.map((r) => r.coupon_rate)).toEqual(['4.250000']);
  });

  it('abuts the two knowledge windows with no gap and no overlap', async () => {
    const { instrumentId, versionIds } = await writeCorrectedNote();
    const rows = await versions(t, instrumentId);
    expect(rows.map((r) => Number(r.version_id))).toEqual(versionIds);
    // The first row's tx_to is exactly the second row's tx_from: that is what `txFrom` buys.
    expect(rows[0]!.tx_to).toBe(rows[1]!.tx_from);
    expect(rows[0]!.tx_from).toBe(
      KNOWN_INITIAL.toISOString().replace('T', ' ').slice(0, 19) + '+00',
    );
    expect(rows[1]!.tx_to).toContain('infinity');

    // A knownAt on the boundary belongs to the later row: bt_as_of is `tf <= known_at < tt`.
    await expect(couponAsOf(t, instrumentId, VALID_AT, KNOWN_CORRECTION)).resolves.toEqual([
      '4.250000',
    ]);
  });

  it('never leaks the corrected value into a past-dated read', async () => {
    const { instrumentId } = await writeCorrectedNote();
    // 4.250 must not exist anywhere in the 2026-03-05 view of the world, whatever the valid time.
    const res = await t.client.query<{ coupon_rate: string }>(
      `SELECT coupon_rate FROM govt_terms
        WHERE instrument_id = $1
          AND tx_from <= $2::timestamptz AND tx_to > $2::timestamptz`,
      [instrumentId, BEFORE_CORRECTION.toISOString()],
    );
    expect(res.rows.map((r) => r.coupon_rate)).toEqual(['4.500000']);

    // …and nothing at all was known before the first write.
    await expect(
      couponAsOf(t, instrumentId, VALID_AT, new Date('2026-02-20T00:00:00Z')),
    ).resolves.toEqual([]);
  });

  it('leaves exactly one current version, findable through current()', async () => {
    const { instrumentId, versionIds } = await writeCorrectedNote();
    const rows = await t.db
      .select({ versionId: govtTerms.versionId, couponRate: govtTerms.couponRate })
      .from(govtTerms)
      .where(and(eq(govtTerms.instrumentId, instrumentId), current(btGovtTerms)));
    expect(rows).toEqual([{ versionId: versionIds[1], couponRate: '4.250000' }]);
  });

  it('nowAsOf pins both axes to the same instant', () => {
    const at = nowAsOf({ now: () => Date.parse('2026-03-12T09:30:00Z') });
    expect(at.validAt.toISOString()).toBe('2026-03-12T09:30:00.000Z');
    expect(at.knownAt.getTime()).toBe(at.validAt.getTime());
  });
});
