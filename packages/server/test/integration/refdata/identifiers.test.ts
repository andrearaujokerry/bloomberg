/**
 * `refdata/identifiers.ts` — the REF-01 cross-reference (WORKPLAN §WP-04 acceptance row 3:
 * "`(scheme, value, qualifier)` uniqueness across time; `TICKER_EXCH` qualifier semantics").
 *
 * What this file proves, in order:
 *
 *  1. the hierarchy the identifiers point at is real — issuer → issue → instrument → listing →
 *     md_line, every level an as-of read (REF-02), built here through `refdata/master.ts`;
 *  2. `(scheme, value, qualifier)` maps to **at most one entity at any valid instant** — enforced
 *     by `identifiers_bt_excl`, demonstrated both through the repository (which closes the prior
 *     version) and against a raw INSERT (which is rejected with SQLSTATE 23P01);
 *  3. …and to *different* entities at different instants: two instruments share one ticker across
 *     time, which is why a ticker is never an identity;
 *  4. `TICKER_EXCH` qualifier semantics: the qualifier is the exchange code, it is required, it is
 *     canonicalised, and `AAPL/US` (composite → instrument) and `AAPL/UW` (venue → listing) are
 *     two different keys that coexist;
 *  5. placeholders are never written — the 29 `<cusip>000000000</cusip>` holdings of the SPY
 *     N-PORT filing (WORKPLAN L740-753), which is the trap this module exists to disarm;
 *  6. values are validated through `@terminal/core`'s codecs before they are stored;
 *  7. a second run writes nothing (QA-02), counted by rows rather than by a boolean.
 *
 * **Self-sufficient by construction.** WP-15 owns the seed modules and they do not exist yet, so
 * every row this file reads is one it wrote itself, inside the single transaction the harness
 * rolls back (TESTING §4.3). Identifier values are *derived from the allocated entity ids* — with
 * a real check digit, through the core codecs — so nothing here can collide with rows a seeded
 * database might already hold, and no assertion depends on a literal sequence value.
 */

import { describe, expect, it } from 'vitest';

import { cusipCheckDigit, cusipToIsin, figiCheckDigit } from '@terminal/core';

import { MasterRepositories } from '../../../src/refdata/master.js';
import {
  IdentifierRepository,
  IdentifierValueError,
  isIdentifierConflict,
  isPlaceholderIdentifier,
  isValidLei,
  normaliseIdentifier,
} from '../../../src/refdata/identifiers.js';
import { withTxDb } from '../../../src/test/db.js';

import type { AsOf } from '../../../src/db/bitemporal.js';
import type { IdentifierWrite } from '../../../src/refdata/identifiers.js';
import type { TestDb } from '../../../src/test/db.js';

// ── instants ─────────────────────────────────────────────────────────────────────────────────
/** Valid time: when the facts are true in the world. */
const V_1998 = new Date('1998-01-01T00:00:00Z');
const V_2010 = new Date('2010-01-01T00:00:00Z');
const V_2015 = new Date('2015-01-01T00:00:00Z');
/** Transaction time: when we learned them. Strictly increasing, one per write. */
const K1 = new Date('2026-01-02T00:00:00Z');
const K2 = new Date('2026-01-03T00:00:00Z');
const K3 = new Date('2026-01-04T00:00:00Z');
/** The reading instant: "as at 2026-02-01, what do we now say was true then?" */
const NOW = new Date('2026-02-01T00:00:00Z');

const at = (validAt: Date, knownAt: Date = NOW): AsOf => ({ validAt, knownAt });

// ── identifier values derived from the ids the sequences hand out ────────────────────────────

/** A structurally valid CUSIP unique to `id` — body '9' + the id, plus the real check digit. */
function cusipFor(id: number): string {
  const body = `9${String(id).padStart(7, '0').slice(-7)}`;
  const check = cusipCheckDigit(body);
  if (check === null) throw new Error(`cusipCheckDigit(${body}) failed`);
  return `${body}${String(check)}`;
}

/** The ISIN of that CUSIP, through the core codec (US + CUSIP + ISIN check digit). */
function isinFor(id: number): string {
  const isin = cusipToIsin(cusipFor(id));
  if (isin === null) throw new Error(`cusipToIsin failed for ${String(id)}`);
  return isin;
}

/** A valid FIGI unique to `id`. Digits only after the 'BBG00' prefix: the FIGI alphabet has no vowels. */
function figiFor(id: number): string {
  const body = `BBG00${String(id).padStart(6, '0').slice(-6)}`;
  const check = figiCheckDigit(body);
  if (check === null) throw new Error(`figiCheckDigit(${body}) failed`);
  return `${body}${String(check)}`;
}

/** A ticker unique to `id`, uppercase and whitespace-free. */
const tickerFor = (id: number): string => `ZZ${String(id).padStart(6, '0').slice(-6)}`;

// ── fixture ──────────────────────────────────────────────────────────────────────────────────

interface Fixture {
  master: MasterRepositories;
  ids: IdentifierRepository;
  /** A fresh provenance row; every write needs one and `provenance_id` is NOT NULL. */
  provenance(label: string, capturedAt: Date): Promise<number>;
  issuerId: number;
  issueId: number;
  instrumentId: number;
  listingId: number;
  mdLineId: number;
  ticker: string;
}

/** `assert_source_known` gates `provenance` and `md_lines`: the licence row has to exist first. */
async function ensureLicence(t: TestDb, sourceId: string, kind: string): Promise<void> {
  await t.client.query(
    `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind, attribution,
                                   rate_limit, valid_from)
     SELECT $1, $1, 'Test', $2, 'Test fixture', 'n/a', timestamptz '2000-01-01'
      WHERE NOT EXISTS (SELECT 1 FROM licence_registry WHERE source_id = $1 AND tx_to = 'infinity')`,
    [sourceId, kind],
  );
}

/**
 * One issuer with one issue, one instrument, one listing and one market-data line — the REF-02
 * chain, written through `refdata/master.ts` inside the test's own transaction.
 */
async function fixture(t: TestDb): Promise<Fixture> {
  await ensureLicence(t, 'internal.user', 'internal');
  await ensureLicence(t, 'cboe.quotes', 'exchange_delayed');

  let seq = 0;
  const provenance = async (label: string, capturedAt: Date): Promise<number> => {
    seq += 1;
    const key = `${label}-${String(seq)}-${String(capturedAt.getTime())}-${String(Math.random())}`;
    const res = await t.client.query<{ provenance_id: string }>(
      `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                               http_status, bytes, captured_at, adapter_version)
       VALUES ('internal.user', $1, 'test://identifiers/' || $1, digest($1, 'sha256'),
               digest($1, 'sha256'), 200, 0, $2, 'test/1.0.0')
       RETURNING provenance_id`,
      [key, capturedAt.toISOString()],
    );
    const row = res.rows[0];
    if (row === undefined) throw new Error('provenance insert returned no row');
    return Number(row.provenance_id);
  };

  const master = new MasterRepositories(t.db);
  const ids = new IdentifierRepository(t.db);
  const p = await provenance('fixture', K1);
  const o = { validFrom: V_1998, provenanceId: p, knownAt: K1 } as const;

  const issuerId = await master.issuers.insert(
    {
      name: 'Testco Inc.',
      legalName: 'Testco Incorporated',
      cik: '0000320193',
      lei: 'HWUPKR0MPOU8FGXBT394',
      country: 'US',
      sic: '3571',
      entityType: 'operating',
      fiscalYearEnd: '0926',
    },
    o,
  );
  const issueId = await master.issues.insert(
    {
      issuerId,
      assetClass: 'equity',
      securityType: 'Common Stock',
      name: 'Testco Inc. common stock',
      currency: 'USD',
      countryOfIssue: 'US',
    },
    o,
  );
  const instrumentId = await master.instruments.insert(
    {
      issueId,
      assetClass: 'equity',
      marketSector: 'Equity',
      ticker: 'PLACEHOLDER',
      exchCode: 'US',
      name: 'Testco Inc.',
      currency: 'USD',
      searchWeight: 1.5,
    },
    o,
  );
  // The ticker is derived from the id the sequence handed out, so it cannot collide with a seeded
  // row; the instrument is written once more with its real ticker.
  const ticker = tickerFor(instrumentId);
  await master.instruments.upsert(
    instrumentId,
    {
      issueId,
      assetClass: 'equity',
      marketSector: 'Equity',
      ticker,
      exchCode: 'US',
      name: 'Testco Inc.',
      currency: 'USD',
      searchWeight: 1.5,
      compositeFigi: figiFor(instrumentId),
    },
    { validFrom: V_1998, provenanceId: p, knownAt: K2 },
  );

  const listingId = await master.listings.insert(
    {
      instrumentId,
      figi: figiFor(instrumentId + 1_000_000),
      mic: 'XNAS',
      exchCode: 'UW',
      localTicker: ticker,
      isPrimary: true,
    },
    o,
  );
  const mdLineId = await master.mdLines.insert(
    {
      instrumentId,
      listingId,
      sourceId: 'cboe.quotes',
      providerSymbol: ticker,
      lineKind: 'venue',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 10_000,
      priority: 10,
    },
    o,
  );

  return { master, ids, provenance, issuerId, issueId, instrumentId, listingId, mdLineId, ticker };
}

/** How many `identifiers` rows exist for a key, over every version. Row counts, never booleans. */
async function rowCount(t: TestDb, scheme: string, value: string): Promise<number> {
  const res = await t.client.query<{ n: string }>(
    `SELECT count(*) AS n FROM identifiers WHERE scheme = $1::id_scheme AND value = $2`,
    [scheme, value],
  );
  return Number(res.rows[0]?.n ?? '0');
}

/**
 * The invariant `identifiers_bt_excl` exists for, checked directly: no two *current* versions of
 * one key may cover the same valid instant. Scoped to one value so a seeded database cannot
 * make it pass or fail by accident.
 */
async function overlappingCurrentVersions(t: TestDb, value: string): Promise<number> {
  const res = await t.client.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM identifiers a
       JOIN identifiers b
         ON a.version_id < b.version_id
        AND a.scheme = b.scheme AND a.value = b.value AND a.qualifier = b.qualifier
        AND tstzrange(a.valid_from, a.valid_to, '[)') && tstzrange(b.valid_from, b.valid_to, '[)')
      WHERE a.value = $1 AND a.tx_to = 'infinity' AND b.tx_to = 'infinity'`,
    [value],
  );
  return Number(res.rows[0]?.n ?? '0');
}

/** The SQLSTATE and message of a rejected statement, unwrapped from drizzle's error wrapper. */
async function pgError(
  t: TestDb,
  fn: () => Promise<unknown>,
): Promise<{ code: string | undefined; message: string; err: unknown }> {
  try {
    await t.savepoint(fn);
  } catch (err) {
    let e = err as { code?: string; message?: string; cause?: unknown };
    while (e.code === undefined && e.cause !== undefined) {
      e = e.cause as { code?: string; message?: string; cause?: unknown };
    }
    return { code: e.code, message: e.message ?? String(err), err };
  }
  throw new Error('expected the statement to be rejected by the database');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the REF-02 hierarchy the identifiers point at', () => {
  const t = withTxDb();

  it('walks issuer → issue → instrument → listing → md_line, every level as-of', async () => {
    const f = await fixture(t);
    const now = at(V_2015);

    const issuer = await f.master.issuers.get(f.issuerId, now);
    expect(issuer?.name).toBe('Testco Inc.');
    expect(issuer?.cik).toBe('0000320193');
    expect(issuer?.lei).toBe('HWUPKR0MPOU8FGXBT394');
    // `char(4)`/`char(2)` come back space-padded only when shorter than the column; either way the
    // repository hands back the value, not the padding.
    expect(issuer?.sic).toBe('3571');
    expect(issuer?.formerNames).toEqual([]);

    const issues = await f.master.issues.byIssuer(f.issuerId, now);
    expect(issues.map((i) => i.issueId)).toEqual([f.issueId]);

    const instruments = await f.master.instruments.byIssue(f.issueId, now);
    expect(instruments.map((i) => i.instrumentId)).toEqual([f.instrumentId]);
    expect(instruments[0]?.ticker).toBe(f.ticker);
    expect(instruments[0]?.searchWeight).toBeCloseTo(1.5, 6);

    const listings = await f.master.listings.byInstrument(f.instrumentId, now);
    expect(listings.map((l) => l.listingId)).toEqual([f.listingId]);
    expect(listings[0]?.mic).toBe('XNAS');
    expect(await f.master.listings.primaryOf(f.instrumentId, now)).not.toBeNull();

    const lines = await f.master.mdLines.byInstrument(f.instrumentId, now);
    expect(lines.map((l) => l.mdLineId)).toEqual([f.mdLineId]);
    expect(lines[0]?.listingId).toBe(f.listingId);
    expect(lines[0]?.providerSymbol).toBe(f.ticker);

    // And the whole chain is invisible to a reader who stands before we knew any of it.
    const unknown = at(V_2015, new Date('2026-01-01T00:00:00Z'));
    expect(await f.master.issuers.get(f.issuerId, unknown)).toBeNull();
    expect(await f.master.instruments.byIssue(f.issueId, unknown)).toEqual([]);
    expect(await f.master.mdLines.byInstrument(f.instrumentId, unknown)).toEqual([]);
  });

  it('finds an instrument by ticker case-insensitively and narrowed by exchange', async () => {
    const f = await fixture(t);
    const now = at(V_2015);
    const lower = await f.master.instruments.byTicker(f.ticker.toLowerCase(), now);
    expect(lower.map((i) => i.instrumentId)).toEqual([f.instrumentId]);
    expect((await f.master.instruments.byTicker(f.ticker, now, { exchCode: 'US' })).length).toBe(1);
    expect((await f.master.instruments.byTicker(f.ticker, now, { exchCode: 'LN' })).length).toBe(0);
  });
});

describe('(scheme, value, qualifier) uniqueness across time', () => {
  const t = withTxDb();

  it('maps one CUSIP to one entity at any instant, and re-pointing closes the old version', async () => {
    const f = await fixture(t);
    const cusip = cusipFor(f.issueId);
    const otherIssueId = await f.master.issues.insert(
      {
        issuerId: f.issuerId,
        assetClass: 'equity',
        securityType: 'Common Stock',
        name: 'Successor Inc. common stock',
        currency: 'USD',
      },
      { validFrom: V_2015, provenanceId: await f.provenance('issue-2', K2), knownAt: K2 },
    );

    const p1 = await f.provenance('cusip-1', K1);
    const p2 = await f.provenance('cusip-2', K2);

    await f.ids.upsert(
      { entityKind: 'issue', entityId: f.issueId, scheme: 'CUSIP', value: cusip, isPrimary: true },
      { validFrom: V_1998, provenanceId: p1, knownAt: K1, reason: 'initial' },
    );
    // The same CUSIP, re-assigned from 2015 — a real thing that happens after a reorganisation.
    await f.ids.write(
      {
        entityKind: 'issue',
        entityId: otherIssueId,
        scheme: 'CUSIP',
        value: cusip,
        isPrimary: true,
      },
      { validFrom: V_2015, provenanceId: p2, knownAt: K2, reason: 'change' },
    );

    expect(await f.ids.entityOf({ scheme: 'CUSIP', value: cusip }, at(V_2010))).toEqual({
      entityKind: 'issue',
      entityId: f.issueId,
    });
    expect(
      await f.ids.entityOf({ scheme: 'CUSIP', value: cusip }, at(new Date('2020-06-01T00:00:00Z'))),
    ).toEqual({ entityKind: 'issue', entityId: otherIssueId });

    // Three rows: the closed original, its re-inserted [1998, 2015) remainder, the new version.
    expect(await rowCount(t, 'CUSIP', cusip)).toBe(3);
    // …and at no instant do two current versions of the key overlap.
    expect(await overlappingCurrentVersions(t, cusip)).toBe(0);

    // Reading before the re-point was known still returns the original entity (REF-03).
    expect(
      await f.ids.entityOf(
        { scheme: 'CUSIP', value: cusip },
        at(new Date('2020-06-01T00:00:00Z'), K2),
      ),
    ).toEqual({ entityKind: 'issue', entityId: otherIssueId });
    expect(
      await f.ids.entityOf(
        { scheme: 'CUSIP', value: cusip },
        at(new Date('2020-06-01T00:00:00Z'), new Date('2026-01-02T12:00:00Z')),
      ),
    ).toEqual({ entityKind: 'issue', entityId: f.issueId });
  });

  it('rejects a second current row overlapping the same valid range (identifiers_bt_excl, 23P01)', async () => {
    const f = await fixture(t);
    const cusip = cusipFor(f.issueId);
    await f.ids.upsert(
      { entityKind: 'issue', entityId: f.issueId, scheme: 'CUSIP', value: cusip },
      { validFrom: V_1998, provenanceId: await f.provenance('excl-1', K1), knownAt: K1 },
    );
    const p2 = await f.provenance('excl-2', K2);

    // The raw INSERT `refdata/identifiers.ts` exists to stop anyone writing: the same key, another
    // entity, an overlapping valid range, no close of the previous version.
    const raw = await pgError(t, async () => {
      await t.client.query(
        `INSERT INTO identifiers (entity_kind, entity_id, scheme, value, qualifier, is_primary,
                                  valid_from, tx_from, provenance_id)
         VALUES ('issue', $1, 'CUSIP', $2, '', false, $3, $4, $5)`,
        [f.issueId + 1, cusip, V_2010.toISOString(), K2.toISOString(), p2],
      );
    });
    expect(raw.code).toBe('23P01');
    expect(raw.message).toContain('identifiers_bt_excl');
    expect(isIdentifierConflict(raw.err)).toBe(true);

    expect(await rowCount(t, 'CUSIP', cusip)).toBe(1);
  });

  it('lets two instruments share a ticker at different times', async () => {
    const f = await fixture(t);
    // A second instrument that takes over the ticker in 2015 — the case REF-01 is about.
    const successorId = await f.master.instruments.insert(
      {
        issueId: f.issueId,
        assetClass: 'equity',
        marketSector: 'Equity',
        ticker: f.ticker,
        exchCode: 'US',
        name: 'Successor Inc.',
        currency: 'USD',
      },
      { validFrom: V_2015, provenanceId: await f.provenance('succ', K2), knownAt: K2 },
    );

    const p1 = await f.provenance('tick-1', K1);
    const p2 = await f.provenance('tick-2', K2);
    await f.ids.upsert(
      {
        entityKind: 'instrument',
        entityId: f.instrumentId,
        scheme: 'TICKER_EXCH',
        value: f.ticker,
        qualifier: 'US',
        isPrimary: true,
      },
      { validFrom: V_1998, validTo: V_2015, provenanceId: p1, knownAt: K1, reason: 'initial' },
    );
    await f.ids.upsert(
      {
        entityKind: 'instrument',
        entityId: successorId,
        scheme: 'TICKER_EXCH',
        value: f.ticker,
        qualifier: 'US',
        isPrimary: true,
      },
      { validFrom: V_2015, provenanceId: p2, knownAt: K2, reason: 'change' },
    );

    expect(
      await f.ids.entityOf({ scheme: 'TICKER_EXCH', value: f.ticker, qualifier: 'US' }, at(V_2010)),
    ).toEqual({ entityKind: 'instrument', entityId: f.instrumentId });
    expect(
      await f.ids.entityOf(
        { scheme: 'TICKER_EXCH', value: f.ticker, qualifier: 'US' },
        at(new Date('2020-06-01T00:00:00Z')),
      ),
    ).toEqual({ entityKind: 'instrument', entityId: successorId });

    // Two current versions, adjacent, never overlapping: both facts are true, at different times.
    expect(await rowCount(t, 'TICKER_EXCH', f.ticker)).toBe(2);
    expect(await overlappingCurrentVersions(t, f.ticker)).toBe(0);

    // A lookup without a qualifier still returns exactly one row per instant — the key is unique,
    // not the value alone.
    expect((await f.ids.lookup('TICKER_EXCH', f.ticker, at(V_2010))).length).toBe(1);
    expect(
      (await f.ids.lookup('TICKER_EXCH', f.ticker, at(new Date('2020-06-01T00:00:00Z')))).length,
    ).toBe(1);
  });
});

describe('TICKER_EXCH qualifier semantics', () => {
  const t = withTxDb();

  it('treats the composite and the venue code as two different keys', async () => {
    const f = await fixture(t);
    const p = await f.provenance('tx-1', K1);
    const o = { validFrom: V_1998, provenanceId: p, knownAt: K1 } as const;

    // 'US' is the composite: it names the instrument. 'UW' is the Nasdaq venue: it names the
    // listing. Same ticker, same instant, two facts — and no constraint violation.
    await f.ids.upsert(
      {
        entityKind: 'instrument',
        entityId: f.instrumentId,
        scheme: 'TICKER_EXCH',
        value: f.ticker,
        qualifier: 'US',
        isPrimary: true,
      },
      o,
    );
    await f.ids.upsert(
      {
        entityKind: 'listing',
        entityId: f.listingId,
        scheme: 'TICKER_EXCH',
        value: f.ticker,
        qualifier: 'UW',
      },
      o,
    );

    expect(
      await f.ids.entityOf({ scheme: 'TICKER_EXCH', value: f.ticker, qualifier: 'US' }, at(V_2010)),
    ).toEqual({ entityKind: 'instrument', entityId: f.instrumentId });
    expect(
      await f.ids.entityOf({ scheme: 'TICKER_EXCH', value: f.ticker, qualifier: 'UW' }, at(V_2010)),
    ).toEqual({ entityKind: 'listing', entityId: f.listingId });

    // Both rows are current at the same instant, which is only legal because the qualifier is part
    // of the key.
    expect(await rowCount(t, 'TICKER_EXCH', f.ticker)).toBe(2);
    expect(await overlappingCurrentVersions(t, f.ticker)).toBe(0);

    // Unqualified, the value is ambiguous by construction: two candidates, no guess (REF-01).
    const both = await f.ids.lookup('TICKER_EXCH', f.ticker, at(V_2010));
    expect(both.map((r) => r.qualifier).sort()).toEqual(['US', 'UW']);
  });

  it('requires the exchange code and canonicalises it', async () => {
    const f = await fixture(t);
    const o = { validFrom: V_1998, provenanceId: await f.provenance('tx-2', K1), knownAt: K1 };

    // Missing: a bare ticker is not an identifier.
    const check = normaliseIdentifier('TICKER_EXCH', f.ticker);
    expect(check).toMatchObject({ ok: false, reason: 'missing_qualifier' });
    expect(check.ok ? '' : check.detail).toContain('exchange code');
    const rejected = await f.ids.upsertIfValid(
      {
        entityKind: 'instrument',
        entityId: f.instrumentId,
        scheme: 'TICKER_EXCH',
        value: f.ticker,
      },
      o,
    );
    expect(rejected).toMatchObject({ ok: false, reason: 'missing_qualifier' });
    expect(await rowCount(t, 'TICKER_EXCH', f.ticker)).toBe(0);

    // …and the strict path says so loudly.
    await expect(
      f.ids.upsert(
        {
          entityKind: 'instrument',
          entityId: f.instrumentId,
          scheme: 'TICKER_EXCH',
          value: f.ticker,
        },
        o,
      ),
    ).rejects.toBeInstanceOf(IdentifierValueError);

    // Lower case in, canonical out — in the stored row and in the lookup.
    const written = await f.ids.upsertIfValid(
      {
        entityKind: 'instrument',
        entityId: f.instrumentId,
        scheme: 'TICKER_EXCH',
        value: f.ticker.toLowerCase(),
        qualifier: 'us',
      },
      o,
    );
    expect(written).toMatchObject({ ok: true, key: { value: f.ticker, qualifier: 'US' } });
    const found = await f.ids.lookup('TICKER_EXCH', f.ticker.toLowerCase(), at(V_2010), 'us');
    expect(found.map((r) => [r.value, r.qualifier])).toEqual([[f.ticker, 'US']]);
  });

  it('refuses a qualifier on a globally unique scheme, which would split the key', async () => {
    const f = await fixture(t);
    const cusip = cusipFor(f.issueId);
    const o = { validFrom: V_1998, provenanceId: await f.provenance('tx-3', K1), knownAt: K1 };

    // ('CUSIP', value, 'openfigi') and ('CUSIP', value, 'sec') would be two keys, and the
    // exclusion constraint would let each point at a different entity.
    const outcome = await f.ids.upsertIfValid(
      {
        entityKind: 'issue',
        entityId: f.issueId,
        scheme: 'CUSIP',
        value: cusip,
        qualifier: 'openfigi',
      },
      o,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'unexpected_qualifier' });
    expect(await rowCount(t, 'CUSIP', cusip)).toBe(0);
  });

  it('requires the source_id on PROVIDER_SYMBOL and SERIES_CODE', async () => {
    const f = await fixture(t);
    const o = { validFrom: V_1998, provenanceId: await f.provenance('tx-4', K1), knownAt: K1 };

    expect(
      await f.ids.upsertIfValid(
        {
          entityKind: 'instrument',
          entityId: f.instrumentId,
          scheme: 'PROVIDER_SYMBOL',
          value: f.ticker,
        },
        o,
      ),
    ).toMatchObject({ ok: false, reason: 'missing_qualifier' });

    expect(
      await f.ids.upsertIfValid(
        {
          entityKind: 'instrument',
          entityId: f.instrumentId,
          scheme: 'PROVIDER_SYMBOL',
          value: f.ticker,
          qualifier: 'not a source id',
        },
        o,
      ),
    ).toMatchObject({ ok: false, reason: 'malformed' });

    const ok = await f.ids.upsertIfValid(
      {
        entityKind: 'instrument',
        entityId: f.instrumentId,
        scheme: 'PROVIDER_SYMBOL',
        value: f.ticker,
        qualifier: 'cboe.quotes',
      },
      o,
    );
    expect(ok).toMatchObject({ ok: true, key: { qualifier: 'cboe.quotes' } });

    // The same symbol at another source is another fact, and both are current at once.
    await f.ids.upsert(
      {
        entityKind: 'instrument',
        entityId: f.instrumentId,
        scheme: 'PROVIDER_SYMBOL',
        value: f.ticker,
        qualifier: 'yahoo.chart',
      },
      o,
    );
    expect(await rowCount(t, 'PROVIDER_SYMBOL', f.ticker)).toBe(2);
    expect(await overlappingCurrentVersions(t, f.ticker)).toBe(0);

    // A provider symbol keeps the provider's own casing: coingecko really does say 'bitcoin'.
    const cg = await f.ids.upsertIfValid(
      {
        entityKind: 'instrument',
        entityId: f.instrumentId,
        scheme: 'PROVIDER_SYMBOL',
        value: 'bitcoin',
        qualifier: 'coingecko.simple',
      },
      o,
    );
    expect(cg).toMatchObject({ ok: true, key: { value: 'bitcoin' } });
  });
});

describe('placeholder identifiers are never written (WORKPLAN L740-753)', () => {
  const t = withTxDb();

  it('treats 000000000 as absent and writes nothing for any number of holdings', async () => {
    const f = await fixture(t);
    const o = { validFrom: V_1998, provenanceId: await f.provenance('ph-1', K1), knownAt: K1 };

    // The check digit of '00000000' is '0', so this string *is* a well-formed CUSIP — the codec
    // accepts it and only the placeholder rule stands between it and the table.
    expect(isPlaceholderIdentifier('CUSIP', '000000000')).toBe(true);
    expect(normaliseIdentifier('CUSIP', '000000000')).toMatchObject({
      ok: false,
      reason: 'placeholder',
    });

    // Three holdings of three different companies, all carrying the N-PORT placeholder. A
    // CUSIP-first resolver would map them onto one entity and the SECOND write would raise 23P01
    // and abort the job; here nothing is written at all and nothing raises.
    const outcomes: IdentifierWrite[] = [];
    for (let i = 0; i < 3; i += 1) {
      outcomes.push(
        await f.ids.upsertIfValid(
          {
            entityKind: 'issue',
            entityId: f.issueId + i,
            scheme: 'CUSIP',
            value: '000000000',
          },
          o,
        ),
      );
    }
    expect(outcomes.every((r) => !r.ok && r.reason === 'placeholder')).toBe(true);
    expect(await rowCount(t, 'CUSIP', '000000000')).toBe(0);

    // The ISIN those holdings *do* carry is a real identifier and is written normally — that is
    // the ISIN → LEI → ticker → normName fallback order the jobs use.
    const isin = isinFor(f.issueId);
    const written = await f.ids.upsertIfValid(
      { entityKind: 'issue', entityId: f.issueId, scheme: 'ISIN', value: isin },
      o,
    );
    expect(written).toMatchObject({ ok: true });
    expect(await f.ids.entityOf({ scheme: 'ISIN', value: isin }, at(V_2010))).toEqual({
      entityKind: 'issue',
      entityId: f.issueId,
    });
  });

  it('treats blank, whitespace and other zero-fillers as absent too', async () => {
    const f = await fixture(t);
    const o = { validFrom: V_1998, provenanceId: await f.provenance('ph-2', K1), knownAt: K1 };

    for (const value of ['', '   ', '0', '000000000', '---', 'N/A', 'None']) {
      expect(isPlaceholderIdentifier('CUSIP', value)).toBe(true);
      const outcome = await f.ids.upsertIfValid(
        { entityKind: 'issue', entityId: f.issueId, scheme: 'CUSIP', value },
        o,
      );
      expect(outcome).toMatchObject({ ok: false, reason: 'placeholder' });
    }

    // A ticker of 'NA' is National Bank of Canada, not a missing value: the textual sentinels
    // deliberately do not apply to ticker-like schemes.
    expect(isPlaceholderIdentifier('TICKER_EXCH', 'NA')).toBe(false);
    expect(isPlaceholderIdentifier('PROVIDER_SYMBOL', 'NA')).toBe(false);
    expect(isPlaceholderIdentifier('TICKER_EXCH', '')).toBe(true);

    const thrown = await f.ids
      .upsert({ entityKind: 'issue', entityId: f.issueId, scheme: 'CUSIP', value: '000000000' }, o)
      .catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(IdentifierValueError);
    expect((thrown as IdentifierValueError).reason).toBe('placeholder');
  });
});

describe('values are validated through the core codecs', () => {
  const t = withTxDb();

  it('refuses a CUSIP whose check digit does not compute', async () => {
    const f = await fixture(t);
    const o = { validFrom: V_1998, provenanceId: await f.provenance('cd-1', K1), knownAt: K1 };
    const good = cusipFor(f.issueId);
    const bad = `${good.slice(0, 8)}${String((Number(good.slice(8)) + 1) % 10)}`;

    expect(
      await f.ids.upsertIfValid(
        { entityKind: 'issue', entityId: f.issueId, scheme: 'CUSIP', value: bad },
        o,
      ),
    ).toMatchObject({ ok: false, reason: 'malformed' });
    expect(await rowCount(t, 'CUSIP', bad)).toBe(0);

    expect(
      await f.ids.upsertIfValid(
        { entityKind: 'issue', entityId: f.issueId, scheme: 'CUSIP', value: good },
        o,
      ),
    ).toMatchObject({ ok: true });
  });

  it('canonicalises ISIN, FIGI and CIK spellings before storing them', async () => {
    const f = await fixture(t);
    const o = { validFrom: V_1998, provenanceId: await f.provenance('canon', K1), knownAt: K1 };
    const isin = isinFor(f.issueId);
    const figi = figiFor(f.instrumentId);

    expect(
      await f.ids.upsertIfValid(
        {
          entityKind: 'issue',
          entityId: f.issueId,
          scheme: 'ISIN',
          value: ` ${isin.toLowerCase()} `,
        },
        o,
      ),
    ).toMatchObject({ ok: true, key: { value: isin } });

    expect(
      await f.ids.upsertIfValid(
        {
          entityKind: 'instrument',
          entityId: f.instrumentId,
          scheme: 'COMPOSITE_FIGI',
          value: figi.toLowerCase(),
        },
        o,
      ),
    ).toMatchObject({ ok: true, key: { value: figi } });

    // The SEC publishes bare CIKs; `data.sec.gov` wants ten digits. One spelling is stored.
    expect(
      await f.ids.upsertIfValid(
        { entityKind: 'issuer', entityId: f.issuerId, scheme: 'CIK', value: '320193' },
        o,
      ),
    ).toMatchObject({ ok: true, key: { value: '0000320193' } });
    expect(await f.ids.entityOf({ scheme: 'CIK', value: '0000320193' }, at(V_2010))).toEqual({
      entityKind: 'issuer',
      entityId: f.issuerId,
    });
    // …and the bare form finds it, because a lookup canonicalises the same way.
    expect(await f.ids.entityOf({ scheme: 'CIK', value: '320193' }, at(V_2010))).toEqual({
      entityKind: 'issuer',
      entityId: f.issuerId,
    });
  });

  it('checks the LEI mod-97 digits', async () => {
    const f = await fixture(t);
    const o = { validFrom: V_1998, provenanceId: await f.provenance('lei', K1), knownAt: K1 };

    expect(isValidLei('HWUPKR0MPOU8FGXBT394')).toBe(true);
    expect(isValidLei('HWUPKR0MPOU8FGXBT395')).toBe(false);
    expect(isValidLei('TOO-SHORT')).toBe(false);

    expect(
      await f.ids.upsertIfValid(
        {
          entityKind: 'issuer',
          entityId: f.issuerId,
          scheme: 'LEI',
          value: 'hwupkr0mpou8fgxbt394',
        },
        o,
      ),
    ).toMatchObject({ ok: true, key: { value: 'HWUPKR0MPOU8FGXBT394' } });

    expect(
      await f.ids.upsertIfValid(
        {
          entityKind: 'issuer',
          entityId: f.issuerId,
          scheme: 'LEI',
          value: 'HWUPKR0MPOU8FGXBT395',
        },
        o,
      ),
    ).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

describe('idempotency (QA-02)', () => {
  const t = withTxDb();

  it('writes nothing on a second identical run, counted by rows', async () => {
    const f = await fixture(t);
    const cusip = cusipFor(f.issueId);
    const input = {
      entityKind: 'issue' as const,
      entityId: f.issueId,
      scheme: 'CUSIP' as const,
      value: cusip,
      isPrimary: true,
    };

    const first = await f.ids.upsert(input, {
      validFrom: V_1998,
      provenanceId: await f.provenance('idem-1', K1),
      knownAt: K1,
      reason: 'initial',
    });
    expect(first).not.toBeNull();
    expect(await rowCount(t, 'CUSIP', cusip)).toBe(1);

    // A second run: the same facts, a fresh fetch (so a new provenance row) and a later knowledge
    // instant. A boolean can lie; the row count cannot.
    const second = await f.ids.upsert(input, {
      validFrom: V_1998,
      provenanceId: await f.provenance('idem-2', K2),
      knownAt: K2,
    });
    expect(second).toBeNull();
    expect(await rowCount(t, 'CUSIP', cusip)).toBe(1);

    // A run where something really changed writes a version and closes the old one.
    const third = await f.ids.upsert(
      { ...input, isPrimary: false },
      { validFrom: V_1998, provenanceId: await f.provenance('idem-3', K3), knownAt: K3 },
    );
    expect(third).not.toBeNull();
    expect(await rowCount(t, 'CUSIP', cusip)).toBe(2);
    expect(await overlappingCurrentVersions(t, cusip)).toBe(0);

    const current = await f.ids.lookup('CUSIP', cusip, at(V_2010));
    expect(current.map((r) => r.isPrimary)).toEqual([false]);
  });

  it('lists every identifier of one entity and finds its primary', async () => {
    const f = await fixture(t);
    const o = { validFrom: V_1998, provenanceId: await f.provenance('entity', K1), knownAt: K1 };
    const cusip = cusipFor(f.issueId);
    const isin = isinFor(f.issueId);

    await f.ids.upsert(
      { entityKind: 'issue', entityId: f.issueId, scheme: 'CUSIP', value: cusip, isPrimary: true },
      o,
    );
    await f.ids.upsert(
      { entityKind: 'issue', entityId: f.issueId, scheme: 'ISIN', value: isin },
      o,
    );

    const all = await f.ids.forEntity('issue', f.issueId, at(V_2010));
    // `ORDER BY scheme` sorts by the enum's *declaration* order (ISIN before CUSIP), so the
    // assertion sorts by name rather than pinning a Postgres implementation detail.
    expect([...all.map((r) => r.scheme)].sort()).toEqual(['CUSIP', 'ISIN']);
    expect((await f.ids.primaryOf('issue', f.issueId, 'CUSIP', at(V_2010)))?.value).toBe(cusip);
    expect(await f.ids.primaryOf('issue', f.issueId, 'ISIN', at(V_2010))).toBeNull();

    // An identifier nobody wrote resolves to nothing — never to a guess.
    expect(await f.ids.entityOf({ scheme: 'SEDOL', value: '2046251' }, at(V_2010))).toBeNull();
  });
});
