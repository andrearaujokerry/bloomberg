/**
 * The worked acceptance query of DATA_MODEL §1.4 and TESTING §7.10 case `bt.correction`
 * (WORKPLAN §1.11, REF-03).
 *
 * Treasury note `91282CJK8` is recorded on 2026-03-01 with `coupon_rate = 4.500` (reason
 * `initial`), then corrected on 2026-03-10 to `4.250` (reason `correction`: the coupon was always
 * 4.250, we were simply wrong). The correction keeps the *valid* range and takes a later
 * *transaction* time, which is the whole point of the second axis:
 *
 * | `valid_at`  | `known_at`           | `coupon_rate` |
 * | ----------- | -------------------- | ------------- |
 * | 2026-03-14  | 2026-03-05T12:00:00Z | 4.500         |
 * | 2026-03-14  | 2026-03-12T00:00:00Z | 4.250         |
 *
 * Both versions are written in **one transaction** — the case `VersionWrite.txFrom` exists for
 * (DATA_MODEL §1.3 L221-237): `bt_close_tx` is given the second row's `tx_from` explicitly, so the
 * first row's `tx_to` is exactly the second row's `tx_from` and the two known-at windows abut with
 * no gap and no overlap. The harness holds one transaction open for the whole test and rolls it
 * back afterwards, so the "one transaction" requirement is satisfied by construction.
 *
 * `writeVersion()` / `upsertVersion()` (`db/repos/bitemporal.ts`) are a later work package; this
 * file drives the same SQL those helpers will emit, so it pins the contract they must meet.
 */

import { describe, expect, it } from 'vitest';

import { withTxDb } from '../../src/test/db.js';

/** Instant the initial version became known (`tx_from` of version 1). */
const KNOWN_INITIAL = '2026-03-01T00:00:00Z';
/** Instant the correction became known (`tx_to` of version 1 and `tx_from` of version 2). */
const KNOWN_CORRECTION = '2026-03-10T00:00:00Z';
/** The valid range both versions share: the coupon was never *changed*, only re-stated. */
const VALID_FROM = '2026-02-15T00:00:00Z';

const VALID_AT = '2026-03-14T00:00:00Z';
const BEFORE_CORRECTION = '2026-03-05T12:00:00Z';
const AFTER_CORRECTION = '2026-03-12T00:00:00Z';

const CUSIP = '91282CJK8';

/** DATA_MODEL §1.4, verbatim but parameterised on `valid_at` / `known_at`. */
const WORKED_QUERY = `
  SELECT g.coupon_rate
    FROM govt_terms g
    JOIN identifiers i ON i.entity_kind = 'instrument' AND i.entity_id = g.instrument_id
                      AND i.scheme = 'CUSIP' AND i.value = $1
   WHERE bt_as_of(g.valid_from, g.valid_to, g.tx_from, g.tx_to, $2, $3)
     AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to, $2, $3)`;

describe('bitemporal correction (bt.correction)', () => {
  const t = withTxDb();

  /**
   * Insert the initial version and its correction, in this one transaction. Returns the ids so the
   * negative cases can address individual rows.
   */
  async function writeCorrectedNote(): Promise<{
    instrumentId: number;
    initialVersionId: number;
    correctedVersionId: number;
    closed: number;
  }> {
    // The registry is the source of truth for `source_id`; `assert_source_known` fires on every
    // `provenance` insert. `internal.user` is seeded (DATA_MODEL §18 module 1) — insert it if a
    // narrower seed selection left it out, so this file stands on its own.
    await t.client.query(
      `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind, attribution,
                                     rate_limit, valid_from)
       SELECT 'internal.user', 'Internal / user supplied', 'Terminal', 'internal',
              'Internal', 'n/a', timestamptz '2000-01-01'
        WHERE NOT EXISTS (SELECT 1 FROM licence_registry
                           WHERE source_id = 'internal.user' AND tx_to = 'infinity')`,
    );

    const provenance = await t.client.query<{ provenance_id: string }>(
      `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                               http_status, bytes, captured_at, adapter_version)
       VALUES ('internal.user', $1, 'test://bitemporal/' || $1, digest($1, 'sha256'),
               digest($1, 'sha256'), 200, 0, $2, 'test/1.0.0'),
              ('internal.user', $3, 'test://bitemporal/' || $3, digest($3, 'sha256'),
               digest($3, 'sha256'), 200, 0, $4, 'test/1.0.0')
       RETURNING provenance_id`,
      ['bt-initial', KNOWN_INITIAL, 'bt-correction', KNOWN_CORRECTION],
    );
    const initialProv = provenance.rows[0]!.provenance_id;
    const correctionProv = provenance.rows[1]!.provenance_id;

    // `instrument_id` is the *entity* id, drawn from the shared sequence; `version_id` is the row
    // id. Never assert a literal sequence value (TESTING §4.3) — read it back.
    const instrument = await t.client.query<{ id: string }>(
      `SELECT nextval('instrument_id_seq')::bigint AS id`,
    );
    const instrumentId = Number(instrument.rows[0]!.id);

    await t.client.query(
      `INSERT INTO identifiers (entity_kind, entity_id, scheme, value, is_primary,
                                valid_from, tx_from, provenance_id)
       VALUES ('instrument', $1, 'CUSIP', $2, true, $3, $4, $5)`,
      [instrumentId, CUSIP, VALID_FROM, KNOWN_INITIAL, initialProv],
    );

    // ── 2026-03-01: what we first believed ──────────────────────────────────────────────────
    const initial = await t.client.query<{ version_id: string }>(
      `INSERT INTO govt_terms (instrument_id, security_type, cusip, term_label, issue_date,
                               dated_date, maturity_date, coupon_type, coupon_rate, coupon_freq,
                               day_count, valid_from, tx_from, provenance_id)
       VALUES ($1, 'note', $2, '10Y', DATE '2026-02-15', DATE '2026-02-15', DATE '2036-02-15',
               'fixed', 4.500, 2, 'ACT/ACT', $3, $4, $5)
       RETURNING version_id`,
      [instrumentId, CUSIP, VALID_FROM, KNOWN_INITIAL, initialProv],
    );
    const initialVersionId = Number(initial.rows[0]!.version_id);

    // ── 2026-03-10: the correction, in the SAME transaction ─────────────────────────────────
    // `p_now` is passed explicitly: `clock_timestamp()` would stamp "now", and a correction is
    // backdated to the instant the source published it.
    const closed = await t.client.query<{ n: number }>(
      `SELECT bt_close_tx('govt_terms'::regclass, 'instrument_id', $1::bigint,
                          $2::timestamptz, 'infinity'::timestamptz, $3::timestamptz) AS n`,
      [instrumentId, VALID_FROM, KNOWN_CORRECTION],
    );

    const corrected = await t.client.query<{ version_id: string }>(
      `INSERT INTO govt_terms (instrument_id, security_type, cusip, term_label, issue_date,
                               dated_date, maturity_date, coupon_type, coupon_rate, coupon_freq,
                               day_count, valid_from, tx_from, provenance_id)
       VALUES ($1, 'note', $2, '10Y', DATE '2026-02-15', DATE '2026-02-15', DATE '2036-02-15',
               'fixed', 4.250, 2, 'ACT/ACT', $3, $4, $5)
       RETURNING version_id`,
      [instrumentId, CUSIP, VALID_FROM, KNOWN_CORRECTION, correctionProv],
    );

    return {
      instrumentId,
      initialVersionId,
      correctedVersionId: Number(corrected.rows[0]!.version_id),
      closed: closed.rows[0]!.n,
    };
  }

  it('closes exactly one current version when the correction lands', async () => {
    const { closed } = await writeCorrectedNote();
    expect(closed).toBe(1);
  });

  it('returns 4.500 at known_at 2026-03-05 and 4.250 at 2026-03-12', async () => {
    await writeCorrectedNote();

    const before = await t.client.query<{ coupon_rate: string }>(WORKED_QUERY, [
      CUSIP,
      VALID_AT,
      BEFORE_CORRECTION,
    ]);
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]!.coupon_rate).toBe('4.500000');

    const after = await t.client.query<{ coupon_rate: string }>(WORKED_QUERY, [
      CUSIP,
      VALID_AT,
      AFTER_CORRECTION,
    ]);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.coupon_rate).toBe('4.250000');
  });

  it('abuts the two known-at windows with no gap and no overlap', async () => {
    const { instrumentId, initialVersionId, correctedVersionId } = await writeCorrectedNote();
    const res = await t.client.query<{
      version_id: string;
      coupon_rate: string;
      tx_from: string;
      tx_to: string;
    }>(
      `SELECT version_id, coupon_rate, tx_from::text, tx_to::text
         FROM govt_terms WHERE instrument_id = $1 ORDER BY tx_from`,
      [instrumentId],
    );
    expect(res.rows.map((r) => Number(r.version_id))).toEqual([
      initialVersionId,
      correctedVersionId,
    ]);
    // The first row's tx_to is *exactly* the second row's tx_from: that is what `txFrom` buys.
    expect(res.rows[0]!.tx_to).toBe(res.rows[1]!.tx_from);
    expect(res.rows[1]!.tx_to).toContain('infinity');

    // A `known_at` on the boundary belongs to the later row: bt_as_of is `tf <= known_at < tt`.
    const boundary = await t.client.query<{ coupon_rate: string }>(WORKED_QUERY, [
      CUSIP,
      VALID_AT,
      KNOWN_CORRECTION,
    ]);
    expect(boundary.rows).toHaveLength(1);
    expect(boundary.rows[0]!.coupon_rate).toBe('4.250000');
  });

  it('leaves exactly one current version after the correction', async () => {
    const { instrumentId, correctedVersionId } = await writeCorrectedNote();
    const res = await t.client.query<{ version_id: string }>(
      `SELECT version_id FROM govt_terms WHERE instrument_id = $1 AND tx_to = 'infinity'`,
      [instrumentId],
    );
    expect(res.rows.map((r) => Number(r.version_id))).toEqual([correctedVersionId]);
  });

  it('rejects an overlapping current version with 23P01 (govt_terms_bt_excl)', async () => {
    const { instrumentId } = await writeCorrectedNote();
    const attempt = t.savepoint(async () => {
      await t.client.query(
        `INSERT INTO govt_terms (instrument_id, security_type, cusip, maturity_date, coupon_type,
                                 coupon_rate, day_count, valid_from, tx_from, provenance_id)
         SELECT $1, 'note', $2, DATE '2036-02-15', 'fixed', 9.999, 'ACT/ACT',
                $3, $4, min(provenance_id) FROM provenance`,
        [instrumentId, CUSIP, VALID_FROM, KNOWN_CORRECTION],
      );
    });
    await expect(attempt).rejects.toMatchObject({ code: '23P01' });
  });

  it('rejects an UPDATE of an already-closed row (bt_guard_update)', async () => {
    const { initialVersionId } = await writeCorrectedNote();
    const attempt = t.savepoint(async () => {
      await t.client.query(
        `UPDATE govt_terms SET tx_to = timestamptz '2026-03-20' WHERE version_id = $1`,
        [initialVersionId],
      );
    });
    await expect(attempt).rejects.toThrow(/already closed/);
  });

  it('rejects an UPDATE that changes a data column (bt_guard_update)', async () => {
    const { correctedVersionId } = await writeCorrectedNote();
    const attempt = t.savepoint(async () => {
      await t.client.query(
        `UPDATE govt_terms SET coupon_rate = 1.000, tx_to = timestamptz '2026-03-20'
          WHERE version_id = $1`,
        [correctedVersionId],
      );
    });
    await expect(attempt).rejects.toThrow(/only tx_to may change/);
  });

  it('rejects re-opening a row by setting tx_to back to infinity (bt_guard_update)', async () => {
    const { correctedVersionId } = await writeCorrectedNote();
    const attempt = t.savepoint(async () => {
      await t.client.query(`UPDATE govt_terms SET tx_to = 'infinity' WHERE version_id = $1`, [
        correctedVersionId,
      ]);
    });
    await expect(attempt).rejects.toThrow(/immutable/);
  });

  it('never shows the corrected value at a known_at before the correction', async () => {
    // The leak test: 4.250 must not exist anywhere in the 2026-03-05 view of the world.
    await writeCorrectedNote();
    const res = await t.client.query<{ coupon_rate: string }>(
      `SELECT g.coupon_rate FROM govt_terms g
        WHERE g.cusip = $1
          AND bt_as_of(g.valid_from, g.valid_to, g.tx_from, g.tx_to, $2, $3)`,
      [CUSIP, VALID_AT, BEFORE_CORRECTION],
    );
    expect(res.rows.map((r) => r.coupon_rate)).toEqual(['4.500000']);
  });

  it('bt_as_of is false outside the valid range whatever the known_at', async () => {
    await writeCorrectedNote();
    const res = await t.client.query<{ coupon_rate: string }>(WORKED_QUERY, [
      CUSIP,
      '2026-01-01T00:00:00Z', // before valid_from
      AFTER_CORRECTION,
    ]);
    expect(res.rows).toHaveLength(0);
  });

  it('bt_as_of is false before anything was known', async () => {
    await writeCorrectedNote();
    const res = await t.client.query<{ coupon_rate: string }>(WORKED_QUERY, [
      CUSIP,
      VALID_AT,
      '2026-02-20T00:00:00Z', // before tx_from of the initial version
    ]);
    expect(res.rows).toHaveLength(0);
  });
});
