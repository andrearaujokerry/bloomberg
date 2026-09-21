/**
 * `refdata/resolve.ts` — WP-04 acceptance row 2 (WORKPLAN L757), REF-01 / REF-02 / REF-03.
 *
 * Proves:
 *   1. every reference form of API.md `SecurityRefInput` resolves to the right instrument —
 *      `AAPL US Equity`, `/isin/US0378331005`, `/cusip/037833100`, `/figi/BBG000B9XRY4`,
 *      `912797VE4 Govt`, `SPX Index`, `EURUSD Curncy` — through the three steps in their
 *      documented order (identifiers, then `ticker` + `exch_code`, then the `normName` fallback);
 *   2. **REF-03**: a *corrected* ticker resolves to two different instruments at two `knownAt`
 *      values. The ticker `NWE/US` was attached to the class B share on 2026-02-01 and corrected
 *      to the class A share on 2026-03-01; a read at 2026-02-15 still returns class B, because
 *      that is what we believed then, and a read at 2026-03-15 returns class A. Both versions are
 *      written in **one transaction** (the harness holds one open for the whole test), which is
 *      what `VersionWrite.txFrom` exists for;
 *   3. **REF-02**: an ambiguous input returns the candidate list and no instrument. A ticker is
 *      never the key (REF-01), so `ZNH Equity` — one ticker, two live issuers — is a question,
 *      not an answer.
 *
 * It also exercises the two modules built on the same master snapshot: `refdata/newsDict.ts`
 * (the per-run matcher dictionary, whose ambiguous-ticker rule is the same REF-01 fact seen from
 * the news side) and `refdata/universe.ts` (the search-universe merge).
 *
 * **Self-sufficient by construction.** WP-15 owns the seed modules and they do not exist yet, so
 * the fixture builds every row it needs through this package's own repositories
 * (`refdata/master.ts`, `refdata/identifiers.ts`) inside the test's own transaction, which the
 * harness rolls back. Nothing here assumes a seeded database, and no assertion depends on a row
 * this file did not write — not even a count.
 */

import { describe, expect, it } from 'vitest';

import { buildNewsDict } from '../../../src/refdata/newsDict.js';
import { IdentifierRepository } from '../../../src/refdata/identifiers.js';
import {
  InstrumentRepository,
  IssueRepository,
  IssuerRepository,
  ListingRepository,
  MdLineRepository,
  type InstrumentInput,
  type IssueInput,
  type IssuerInput,
} from '../../../src/refdata/master.js';
import { SecurityResolver, type ResolveResult } from '../../../src/refdata/resolve.js';
import { loadMasterUniverse, mergeUniverse } from '../../../src/refdata/universe.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';

import type { AsOf } from '../../../src/db/bitemporal.js';

// ── Instants ─────────────────────────────────────────────────────────────────────────────────
/** Everything in the fixture is true from here. */
const VALID_FROM = new Date('2026-01-01T00:00:00Z');
/** …and was known from here, which is before every `knownAt` any test reads at. */
const KNOWN_BASE = new Date('2026-01-05T00:00:00Z');
/** The ordinary read: now on both axes. */
const NOW: AsOf = {
  validAt: new Date('2026-06-01T00:00:00Z'),
  knownAt: new Date('2026-06-01T00:00:00Z'),
};

/** REF-03: when we first believed the ticker, and when we learned we were wrong. */
const KNOWN_WRONG = new Date('2026-02-01T00:00:00Z');
const KNOWN_CORRECTED = new Date('2026-03-01T00:00:00Z');
const BEFORE_CORRECTION: AsOf = {
  validAt: new Date('2026-06-01T00:00:00Z'),
  knownAt: new Date('2026-02-15T00:00:00Z'),
};
const AFTER_CORRECTION: AsOf = {
  validAt: new Date('2026-06-01T00:00:00Z'),
  knownAt: new Date('2026-03-15T00:00:00Z'),
};

interface Fixture {
  provenanceId: number;
  appleIssuerId: number;
  appleIssueId: number;
  aapl: number;
  appleListingId: number;
  appleMdLineId: number;
  bill: number;
  spx: number;
  eurusd: number;
  dgs10: number;
  znhUs: number;
  znhLn: number;
  classA: number;
  classB: number;
  delisted: number;
}

describe('SecurityResolver (REF-01, REF-02, REF-03)', () => {
  const t = withTxDb();

  // ── the fixture ────────────────────────────────────────────────────────────────────────────

  /** A licence row and one provenance row: every bitemporal write needs a `provenance_id`. */
  async function provenanceId(t: TestDb): Promise<number> {
    for (const [sourceId, name, kind] of [
      ['internal.user', 'Internal / user supplied', 'internal'],
      ['cboe.quotes', 'Cboe One Summary', 'exchange_delayed'],
    ] as const) {
      await t.client.query(
        `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind,
                                       attribution, rate_limit, valid_from)
         SELECT $1, $2, 'Terminal', $3, 'Internal', 'n/a', timestamptz '2000-01-01'
          WHERE NOT EXISTS (SELECT 1 FROM licence_registry
                             WHERE source_id = $1 AND tx_to = 'infinity')`,
        [sourceId, name, kind],
      );
    }
    const res = await t.client.query<{ provenance_id: string }>(
      `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                               http_status, bytes, captured_at, adapter_version)
       VALUES ('internal.user', 'resolve-fixture', 'test://refdata/resolve',
               digest('resolve-fixture', 'sha256'), digest('resolve-fixture', 'sha256'),
               200, 0, $1, 'test/1.0.0')
       RETURNING provenance_id`,
      [KNOWN_BASE.toISOString()],
    );
    return Number(res.rows[0]!.provenance_id);
  }

  /**
   * The instruments the acceptance row names, built through WP-04's own repositories. Issuer →
   * issue → instrument → listing → md_line, the REF-02 hierarchy, with the `identifiers` rows a
   * symbology load would have written.
   */
  async function seedMaster(t: TestDb): Promise<Fixture> {
    const prov = await provenanceId(t);
    const opts = {
      validFrom: VALID_FROM,
      provenanceId: prov,
      knownAt: KNOWN_BASE,
      reason: 'initial' as const,
    };

    const issuers = new IssuerRepository(t.db);
    const issues = new IssueRepository(t.db);
    const instruments = new InstrumentRepository(t.db);
    const listings = new ListingRepository(t.db);
    const mdLines = new MdLineRepository(t.db);
    const ids = new IdentifierRepository(t.db);

    const issuer = (input: IssuerInput) => issuers.insert(input, opts);
    const issue = (input: IssueInput) => issues.insert(input, opts);
    const instrument = (input: InstrumentInput) => instruments.insert(input, opts);

    // ── Apple: the full REF-02 chain, every identifier scheme a symbology load writes ────────
    const appleIssuerId = await issuer({
      name: 'Apple Inc.',
      legalName: 'Apple Inc.',
      cik: '0000320193',
      country: 'US',
      sic: '3571',
      entityType: 'operating',
      fiscalYearEnd: '0926',
    });
    const appleIssueId = await issue({
      issuerId: appleIssuerId,
      assetClass: 'equity',
      securityType: 'Common Stock',
      shareClassFigi: 'BBG001S5N8V8',
      isin: 'US0378331005',
      cusip: '037833100',
      name: 'Apple Inc',
      currency: 'USD',
      countryOfIssue: 'US',
    });
    const aapl = await instrument({
      issueId: appleIssueId,
      assetClass: 'equity',
      marketSector: 'Equity',
      compositeFigi: 'BBG000B9XRY4',
      ticker: 'AAPL',
      exchCode: 'US',
      name: 'Apple Inc',
      currency: 'USD',
      searchWeight: 2,
    });
    const appleListingId = await listings.insert(
      {
        instrumentId: aapl,
        figi: 'BBG000B9Y5X2',
        mic: 'XNAS',
        exchCode: 'UW',
        localTicker: 'AAPL',
        isPrimary: true,
      },
      opts,
    );
    const appleMdLineId = await mdLines.insert(
      {
        instrumentId: aapl,
        sourceId: 'cboe.quotes',
        providerSymbol: 'AAPL',
        lineKind: 'composite',
        intrinsicDelayMin: 15,
        expectedIntervalMs: 10_000,
        priority: 10,
      },
      opts,
    );

    await ids.upsert(
      { entityKind: 'issuer', entityId: appleIssuerId, scheme: 'CIK', value: '0000320193' },
      opts,
    );
    await ids.upsert(
      { entityKind: 'issue', entityId: appleIssueId, scheme: 'ISIN', value: 'US0378331005' },
      opts,
    );
    await ids.upsert(
      { entityKind: 'issue', entityId: appleIssueId, scheme: 'CUSIP', value: '037833100' },
      opts,
    );
    await ids.upsert(
      {
        entityKind: 'issue',
        entityId: appleIssueId,
        scheme: 'SHARE_CLASS_FIGI',
        value: 'BBG001S5N8V8',
      },
      opts,
    );
    await ids.upsert(
      { entityKind: 'instrument', entityId: aapl, scheme: 'COMPOSITE_FIGI', value: 'BBG000B9XRY4' },
      opts,
    );
    await ids.upsert(
      {
        entityKind: 'instrument',
        entityId: aapl,
        scheme: 'TICKER_EXCH',
        value: 'AAPL',
        qualifier: 'US',
        isPrimary: true,
      },
      opts,
    );
    await ids.upsert(
      { entityKind: 'listing', entityId: appleListingId, scheme: 'FIGI', value: 'BBG000B9Y5X2' },
      opts,
    );

    // ── The 4-week bill: ticker *is* the CUSIP, and only the CUSIP was cross-referenced ──────
    const treasuryId = await issuer({
      name: 'United States Department of the Treasury',
      country: 'US',
      entityType: 'sovereign',
    });
    const billIssueId = await issue({
      issuerId: treasuryId,
      assetClass: 'govt',
      securityType: 'US GOVERNMENT',
      cusip: '912797VE4',
      name: 'United States Treasury Bill 4WK',
      currency: 'USD',
      countryOfIssue: 'US',
    });
    const bill = await instrument({
      issueId: billIssueId,
      assetClass: 'govt',
      marketSector: 'Govt',
      ticker: '912797VE4',
      exchCode: 'GOVT',
      name: 'United States Treasury Bill 4WK',
      currency: 'USD',
    });
    await ids.upsert(
      { entityKind: 'issue', entityId: billIssueId, scheme: 'CUSIP', value: '912797VE4' },
      opts,
    );

    // ── SPX and EURUSD: no `identifiers` row at all, so step 2 has to answer ─────────────────
    const spDjiId = await issuer({
      name: 'S&P Dow Jones Indices LLC',
      country: 'US',
      entityType: 'index_provider',
    });
    const spxIssueId = await issue({
      issuerId: spDjiId,
      assetClass: 'index',
      securityType: 'Index',
      name: 'S&P 500 Index',
      currency: 'USD',
    });
    const spx = await instrument({
      issueId: spxIssueId,
      assetClass: 'index',
      marketSector: 'Index',
      ticker: 'SPX',
      exchCode: 'INDEX',
      name: 'S&P 500 Index',
      currency: 'USD',
      searchWeight: 2,
    });

    const fxIssuerId = await issuer({ name: 'Interbank Foreign Exchange', entityType: 'other' });
    const fxIssueId = await issue({
      issuerId: fxIssuerId,
      assetClass: 'fx',
      securityType: 'Spot',
      name: 'Euro / United States Dollar Spot',
      currency: 'USD',
    });
    const eurusd = await instrument({
      issueId: fxIssueId,
      assetClass: 'fx',
      marketSector: 'Curncy',
      ticker: 'EURUSD',
      exchCode: 'FX',
      name: 'Euro / United States Dollar Spot',
      currency: 'USD',
    });

    // ── An econ series: addressed as '/series/<source_id>/<code>', never as a ticker ────────
    const fredIssuerId = await issuer({
      name: 'Federal Reserve Bank of St. Louis',
      country: 'US',
      entityType: 'central_bank',
    });
    const dgs10Issue = await issue({
      issuerId: fredIssuerId,
      assetClass: 'econ',
      securityType: 'Index',
      name: '10-Year Treasury Constant Maturity Rate',
      currency: 'USD',
    });
    const dgs10 = await instrument({
      issueId: dgs10Issue,
      assetClass: 'econ',
      marketSector: 'Index',
      ticker: 'DGS10',
      exchCode: 'ECON',
      name: '10-Year Treasury Constant Maturity Rate',
      currency: 'USD',
    });
    await ids.upsert(
      {
        entityKind: 'instrument',
        entityId: dgs10,
        scheme: 'SERIES_CODE',
        value: 'DGS10',
        qualifier: 'fred.csv',
      },
      opts,
    );

    // ── One ticker, two issuers: the REF-01 fact, and the REF-02 ambiguity it forces ─────────
    const znhUsIssuer = await issuer({
      name: 'Zenith Holdings Inc.',
      country: 'US',
      entityType: 'operating',
    });
    const znhUsIssue = await issue({
      issuerId: znhUsIssuer,
      assetClass: 'equity',
      securityType: 'Common Stock',
      name: 'Zenith Holdings Inc',
      currency: 'USD',
    });
    const znhUs = await instrument({
      issueId: znhUsIssue,
      assetClass: 'equity',
      marketSector: 'Equity',
      ticker: 'ZNH',
      exchCode: 'US',
      name: 'Zenith Holdings Inc',
      currency: 'USD',
    });
    const znhLnIssuer = await issuer({
      name: 'Zenith Group plc',
      country: 'GB',
      entityType: 'operating',
    });
    const znhLnIssue = await issue({
      issuerId: znhLnIssuer,
      assetClass: 'equity',
      securityType: 'Common Stock',
      name: 'Zenith Group plc',
      currency: 'GBP',
    });
    const znhLn = await instrument({
      issueId: znhLnIssue,
      assetClass: 'equity',
      marketSector: 'Equity',
      ticker: 'ZNH',
      exchCode: 'LN',
      name: 'Zenith Group plc',
      currency: 'GBP',
    });
    await ids.upsert(
      {
        entityKind: 'instrument',
        entityId: znhUs,
        scheme: 'TICKER_EXCH',
        value: 'ZNH',
        qualifier: 'US',
      },
      opts,
    );
    await ids.upsert(
      {
        entityKind: 'instrument',
        entityId: znhLn,
        scheme: 'TICKER_EXCH',
        value: 'ZNH',
        qualifier: 'LN',
      },
      opts,
    );

    // ── Two share classes, and a ticker that was attached to the wrong one (REF-03) ──────────
    const nwIssuer = await issuer({
      name: 'Northwind Energy Corporation',
      country: 'US',
      entityType: 'operating',
    });
    const classAIssue = await issue({
      issuerId: nwIssuer,
      assetClass: 'equity',
      securityType: 'Common Stock',
      name: 'Northwind Energy Corporation Class A',
      currency: 'USD',
    });
    const classBIssue = await issue({
      issuerId: nwIssuer,
      assetClass: 'equity',
      securityType: 'Common Stock',
      name: 'Northwind Energy Corporation Class B',
      currency: 'USD',
    });
    const classA = await instrument({
      issueId: classAIssue,
      assetClass: 'equity',
      marketSector: 'Equity',
      ticker: 'NWEA',
      exchCode: 'US',
      name: 'Northwind Energy Corp Class A',
      currency: 'USD',
    });
    const classB = await instrument({
      issueId: classBIssue,
      assetClass: 'equity',
      marketSector: 'Equity',
      ticker: 'NWEB',
      exchCode: 'US',
      name: 'Northwind Energy Corp Class B',
      currency: 'USD',
    });
    // 2026-02-01: the load attaches 'NWE US' to the class B share.
    await ids.write(
      {
        entityKind: 'instrument',
        entityId: classB,
        scheme: 'TICKER_EXCH',
        value: 'NWE',
        qualifier: 'US',
      },
      { validFrom: VALID_FROM, provenanceId: prov, knownAt: KNOWN_WRONG, reason: 'initial' },
    );
    // 2026-03-01: it was always the class A share. Same valid range, later transaction time —
    // and the same transaction, which only `txFrom` makes possible.
    await ids.write(
      {
        entityKind: 'instrument',
        entityId: classA,
        scheme: 'TICKER_EXCH',
        value: 'NWE',
        qualifier: 'US',
      },
      { validFrom: VALID_FROM, provenanceId: prov, knownAt: KNOWN_CORRECTED, reason: 'correction' },
    );

    // ── A symbol that will leave the Cboe book (the universe merge's delisting case) ─────────
    const deliIssuer = await issuer({
      name: 'Delisted Industries Inc.',
      country: 'US',
      entityType: 'operating',
    });
    const deliIssue = await issue({
      issuerId: deliIssuer,
      assetClass: 'equity',
      securityType: 'Common Stock',
      name: 'Delisted Industries Inc',
      currency: 'USD',
    });
    const delisted = await instrument({
      issueId: deliIssue,
      assetClass: 'equity',
      marketSector: 'Equity',
      ticker: 'DELI',
      exchCode: 'US',
      name: 'Delisted Industries Inc',
      currency: 'USD',
      searchWeight: 0.5,
    });
    await mdLines.insert(
      {
        instrumentId: delisted,
        sourceId: 'cboe.quotes',
        providerSymbol: 'DELI',
        lineKind: 'composite',
        intrinsicDelayMin: 15,
        expectedIntervalMs: 10_000,
        priority: 10,
      },
      opts,
    );

    return {
      provenanceId: prov,
      appleIssuerId,
      appleIssueId,
      aapl,
      appleListingId,
      appleMdLineId,
      bill,
      spx,
      eurusd,
      dgs10,
      znhUs,
      znhLn,
      classA,
      classB,
      delisted,
    };
  }

  /** Unwrap a hit, with the failure spelled out when there is not one. */
  function hit(result: ResolveResult): { instrumentId: number; display: string; method: string } {
    if (!result.ok) {
      throw new Error(
        `expected a hit, got ${result.code}: ${result.message} ` +
          `(candidates: ${result.candidates.map((c) => c.display).join(', ')})`,
      );
    }
    return {
      instrumentId: result.instrument.instrumentId,
      display: result.instrument.display,
      method: result.method,
    };
  }

  // ── 1. every reference form ─────────────────────────────────────────────────────────────────

  it('resolves every reference form of SecurityRefInput to its instrument', async () => {
    const f = await seedMaster(t);
    const resolver = new SecurityResolver(t.db);

    const cases: [string, number, string][] = [
      ['AAPL US Equity', f.aapl, 'identifier'],
      ['/isin/US0378331005', f.aapl, 'identifier'],
      ['/cusip/037833100', f.aapl, 'identifier'],
      ['/figi/BBG000B9XRY4', f.aapl, 'identifier'],
      ['912797VE4 Govt', f.bill, 'identifier'],
      ['SPX Index', f.spx, 'ticker_exch'],
      ['EURUSD Curncy', f.eurusd, 'ticker_exch'],
      ['/series/fred.csv/DGS10', f.dgs10, 'identifier'],
    ];

    for (const [ref, expected, method] of cases) {
      const got = hit(await resolver.resolve(ref, NOW));
      expect(got.instrumentId, `${ref} → instrumentId`).toBe(expected);
      expect(got.method, `${ref} → method`).toBe(method);
    }
  });

  it('carries the display form, the md lines and the issue columns onto the resolved ref', async () => {
    const f = await seedMaster(t);
    const resolver = new SecurityResolver(t.db);

    const result = await resolver.resolve('AAPL US Equity', NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instrument).toMatchObject({
      instrumentId: f.aapl,
      issueId: f.appleIssueId,
      issuerId: f.appleIssuerId,
      display: 'AAPL US Equity',
      name: 'Apple Inc',
      currency: 'USD',
      ticker: 'AAPL',
      exchCode: 'US',
      securityType: 'Common Stock',
      compositeFigi: 'BBG000B9XRY4',
      assetClass: 'equity',
      marketSector: 'Equity',
      status: 'active',
    });
    expect(result.instrument.mdLineIds).toEqual([f.appleMdLineId]);
    // A non-listed wedge is spoken without its synthetic exchange code.
    expect(hit(await resolver.resolve('SPX Index', NOW)).display).toBe('SPX Index');
    expect(hit(await resolver.resolve('912797VE4 Govt', NOW)).display).toBe('912797VE4 Govt');
  });

  it('resolves the internal key and the venue FIGI of a listing', async () => {
    const f = await seedMaster(t);
    const resolver = new SecurityResolver(t.db);

    expect(hit(await resolver.resolve({ id: f.aapl }, NOW))).toMatchObject({
      instrumentId: f.aapl,
      method: 'instrument_id',
    });
    // A venue FIGI names a listing; the listing names the instrument.
    expect(hit(await resolver.resolve('/figi/BBG000B9Y5X2', NOW)).instrumentId).toBe(f.aapl);
  });

  it('falls back to the normalised name when no identifier and no ticker matches', async () => {
    const f = await seedMaster(t);
    const resolver = new SecurityResolver(t.db);

    // 'Apple Inc.', 'APPLE INC' and 'apple inc' all normalise to 'APPLE' (§18.7).
    for (const spelling of ['Apple Inc.', 'APPLE INC', 'apple inc']) {
      const got = hit(await resolver.resolve({ kind: 'ticker', value: spelling }, NOW));
      expect(got.instrumentId, spelling).toBe(f.aapl);
      expect(got.method, spelling).toBe('name');
    }
  });

  // ── 2. REF-03: the corrected ticker ─────────────────────────────────────────────────────────

  it('resolves a corrected ticker to DIFFERENT instruments at two knownAt values (REF-03)', async () => {
    const f = await seedMaster(t);
    const resolver = new SecurityResolver(t.db);

    const before = hit(await resolver.resolve('NWE US Equity', BEFORE_CORRECTION));
    const after = hit(await resolver.resolve('NWE US Equity', AFTER_CORRECTION));

    expect(before.instrumentId).toBe(f.classB);
    expect(after.instrumentId).toBe(f.classA);
    expect(before.instrumentId).not.toBe(after.instrumentId);

    // The valid time is identical in both reads — only what we knew changed.
    expect(BEFORE_CORRECTION.validAt.toISOString()).toBe(AFTER_CORRECTION.validAt.toISOString());

    // And a read from before we knew anything returns nothing rather than the later answer.
    const earlier = await resolver.resolve('NWE US Equity', {
      validAt: NOW.validAt,
      knownAt: new Date('2026-01-10T00:00:00Z'),
    });
    expect(earlier.ok).toBe(false);
    if (!earlier.ok) expect(earlier.code).toBe('SECURITY_NOT_FOUND');
  });

  // ── 3. REF-02: ambiguity is reported, never guessed ─────────────────────────────────────────

  it('returns the candidate list for an ambiguous ticker and never guesses (REF-02)', async () => {
    const f = await seedMaster(t);
    const resolver = new SecurityResolver(t.db);

    const ambiguous = await resolver.resolve('ZNH Equity', NOW);
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) return;
    expect(ambiguous.code).toBe('AMBIGUOUS_SECURITY');
    expect(ambiguous.candidates.map((c) => c.instrumentId).sort((a, b) => a - b)).toEqual(
      [f.znhUs, f.znhLn].sort((a, b) => a - b),
    );
    expect(ambiguous.candidates.map((c) => c.display).sort()).toEqual([
      'ZNH LN Equity',
      'ZNH US Equity',
    ]);

    // The exchange code the caller wrote is a constraint, not a guess: with it, one answer.
    expect(hit(await resolver.resolve('ZNH US Equity', NOW)).instrumentId).toBe(f.znhUs);
    expect(hit(await resolver.resolve('ZNH LN Equity', NOW)).instrumentId).toBe(f.znhLn);
  });

  it('never hides a second instrument behind the one that owns the TICKER_EXCH row (REF-02)', async () => {
    // The half-populated universe: `identifiers_bt_excl` lets exactly ONE instrument hold
    // (TICKER_EXCH, 'GGGG', 'US'), while `instruments` has no uniqueness on (ticker, exch_code),
    // so a symbology load that covered only part of the book leaves two instruments answering to
    // GGGG US with one identifiers row between them. Step 1 used to return the row's owner and
    // never name the other — a guess, in the one case step 2 exists to serve.
    const f = await seedMaster(t);
    const prov = await provenanceId(t);
    const opts = {
      validFrom: VALID_FROM,
      provenanceId: prov,
      knownAt: KNOWN_BASE,
      reason: 'initial' as const,
    };
    const issuers = new IssuerRepository(t.db);
    const issues = new IssueRepository(t.db);
    const instruments = new InstrumentRepository(t.db);
    const ids = new IdentifierRepository(t.db);

    const makeInstrument = async (name: string): Promise<number> => {
      const issuerId = await issuers.insert({ name, country: 'US', entityType: 'operating' }, opts);
      const issueId = await issues.insert(
        {
          issuerId,
          assetClass: 'equity',
          securityType: 'Common Stock',
          name,
          currency: 'USD',
        },
        opts,
      );
      return instruments.insert(
        {
          issueId,
          assetClass: 'equity',
          marketSector: 'Equity',
          ticker: 'GGGG',
          exchCode: 'US',
          name,
          currency: 'USD',
        },
        opts,
      );
    };

    const withIdentifier = await makeInstrument('Gamma Global Inc');
    const withoutIdentifier = await makeInstrument('Gamma Growth Corp');
    await ids.upsert(
      {
        entityKind: 'instrument',
        entityId: withIdentifier,
        scheme: 'TICKER_EXCH',
        value: 'GGGG',
        qualifier: 'US',
      },
      opts,
    );

    const resolver = new SecurityResolver(t.db);
    const result = await resolver.resolve('GGGG US Equity', NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('AMBIGUOUS_SECURITY');
    expect(result.candidates.map((c) => c.instrumentId).sort((a, b) => a - b)).toEqual(
      [withIdentifier, withoutIdentifier].sort((a, b) => a - b),
    );

    // The unambiguous refs are untouched: Apple still resolves through step 1, once.
    expect(hit(await resolver.resolve('AAPL US Equity', NOW)).instrumentId).toBe(f.aapl);
    expect(hit(await resolver.resolve('/isin/US0378331005', NOW)).instrumentId).toBe(f.aapl);
  });

  it('reports a miss rather than the nearest thing', async () => {
    await seedMaster(t);
    const resolver = new SecurityResolver(t.db);

    for (const ref of ['ZZZZ US Equity', '/isin/US0378331004', '/cusip/000000000']) {
      const result = await resolver.resolve(ref, NOW);
      expect(result.ok, ref).toBe(false);
      if (result.ok) continue;
      expect(['SECURITY_NOT_FOUND', 'BAD_IDENTIFIER'], ref).toContain(result.code);
      expect(result.candidates, ref).toHaveLength(0);
    }
  });

  it('does not resolve a security into a sector the caller did not ask for', async () => {
    await seedMaster(t);
    const resolver = new SecurityResolver(t.db);

    // SPX exists — as an Index. Asked for as Equity it is a miss, not a near-enough answer.
    const wrongSector = await resolver.resolve('SPX Equity', NOW);
    expect(wrongSector.ok).toBe(false);
  });

  // ── the two modules built on the same snapshot ──────────────────────────────────────────────

  it('builds the news matcher dictionary once per run, dropping ambiguous tickers (§11.3.1)', async () => {
    const f = await seedMaster(t);
    const dict = await buildNewsDict(t.db, NOW);

    expect(dict.lookupTicker('AAPL')).toMatchObject({
      instrumentId: f.aapl,
      issuerId: f.appleIssuerId,
    });
    // One ticker, two live instruments: removed entirely rather than linked to a coin flip.
    expect(dict.ambiguousTickers.has('ZNH')).toBe(true);
    expect(dict.lookupTicker('ZNH')).toBeNull();

    expect(dict.lookupName('Apple Inc.')).toEqual({
      issuerId: f.appleIssuerId,
      method: 'name_exact',
    });
    expect(dict.lookupCik('320193')).toBe(f.appleIssuerId);
    expect(dict.lookupCik('0000320193')).toBe(f.appleIssuerId);

    // The ×0.90 list, and the floor that drops a short name.
    expect(dict.isAmbiguous('GAP')).toBe(true);
    expect(dict.isAmbiguous('Apple')).toBe(false);
    expect(dict.lookupName('IBM')).toBeNull();
  });

  it('merges the master with the Cboe symbol book and the SEC ticker file', async () => {
    const f = await seedMaster(t);
    const master = await loadMasterUniverse(t.db, NOW);

    const merged = mergeUniverse({
      master,
      symbolBook: [
        { name: 'AAPL', companyName: 'Apple Inc' },
        { name: 'ZZZT', companyName: 'Zephyr Testing Co' },
        { name: '_SPX', companyName: 'S&P 500 Index' },
        { name: 'A2RZ1', companyName: 'Cboe Futures' },
      ],
      secTickers: [{ cik: '0000320193', ticker: 'AAPL', title: 'Apple Inc.' }],
    });
    const byKey = new Map(merged.entries.map((e) => [e.key, e]));

    // Index-member/seed weight is never lowered by the symbol book (search_weight rules).
    expect(byKey.get('AAPL|US')).toMatchObject({
      instrumentId: f.aapl,
      searchWeight: 2,
      cik: '0000320193',
      providerSymbol: 'AAPL',
      status: 'active',
    });
    // Symbol-book-only: findable, but below every real security.
    expect(byKey.get('ZZZT|US')).toMatchObject({
      action: 'create',
      searchWeight: 0.5,
      instrumentId: null,
    });
    // A futures root is 'pending' and last (DATA_MODEL §3.1).
    expect(byKey.get('A2RZ1|US')).toMatchObject({
      status: 'pending',
      searchWeight: 0.1,
      assetClass: 'future',
    });
    // '_SPX' is the *provider* symbol for the SPX index instrument.
    expect(byKey.get('SPX|INDEX')).toMatchObject({ instrumentId: f.spx, providerSymbol: '_SPX' });
    // A symbol that left the book, and had a cboe.quotes line, is delisted.
    expect(byKey.get('DELI|US')).toMatchObject({
      instrumentId: f.delisted,
      action: 'delist',
      status: 'delisted',
    });
    // A master row that never came from the book is left alone.
    expect(byKey.get('912797VE4|GOVT')).toMatchObject({
      instrumentId: f.bill,
      status: 'active',
      action: 'unchanged',
    });
  });
});
