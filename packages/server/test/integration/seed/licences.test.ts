/**
 * WORKPLAN §1.11 — `db:seed` inserts 33 `licence_registry` rows and the `field_licence` matrix;
 * every `ProviderId` of PROVIDERS.a §1.1 has a row; `retention_days` is non-null on exactly
 * `cboe.quotes` (30), `cboe.options` (10) and `yahoo.chart` (400); `assert_source_known` rejects an
 * unknown `source_id`.
 *
 * The seed itself runs in `test/globalSetup.ts` (TESTING §4.2 step 5) before any integration file;
 * this test only reads what it left and then probes the trigger inside a savepoint.
 *
 * `openfigi.search` is deliberately **not** a `ProviderId` and must have no row: `/v3/search` and
 * `/v3/mapping` are one licence and record under `openfigi.mapping` (PROVIDERS.b §6.2).
 */

import { describe, expect, it } from 'vitest';

import { withTxDb } from '../../../src/test/db.js';

/** PROVIDERS.a §1.1 `ProviderId`, verbatim — thirty ids. */
const PROVIDER_IDS: readonly string[] = [
  'cboe.quotes',
  'cboe.options',
  'cboe.symbolBook',
  'cboe.euIndices',
  'yahoo.chart',
  'yahoo.search',
  'openfigi.mapping',
  'sec.tickers',
  'sec.submissions',
  'sec.companyfacts',
  'sec.frames',
  'sec.atom',
  'sec.archives',
  'fred.csv',
  'fred.calendar',
  'nyfed.rates',
  'fed.h15',
  'fed.rss',
  'fed.fomc',
  'treasury.yieldcurve',
  'treasury.bills',
  'bls.timeseries',
  'bls.schedule',
  'worldbank',
  'imf.datamapper',
  'frankfurter',
  'finra.shortInterest',
  'bbg.rss',
  'coingecko.simple',
  'ssga.holdings',
];

/**
 * The three registry rows that are not provider adapters: derived values (curves, statistics,
 * standardised statements), user uploads and the seed itself, and the Wikipedia S&P 500 list
 * (DATA_MODEL §2 L25-30).
 */
const NON_PROVIDER_SOURCES: readonly string[] = ['internal.derived', 'internal.user', 'wiki.sp500'];

/** STOR-07: the only three sources with a finite retention. NULL everywhere else = unlimited. */
const RETENTION_DAYS: Readonly<Record<string, number>> = {
  'cboe.quotes': 30,
  'cboe.options': 10,
  'yahoo.chart': 400,
};

describe('seed — licence_registry', () => {
  const t = withTxDb();

  async function currentSources(): Promise<string[]> {
    const res = await t.client.query<{ source_id: string }>(
      `SELECT source_id FROM licence_registry WHERE tx_to = 'infinity' ORDER BY source_id`,
    );
    return res.rows.map((r) => r.source_id);
  }

  it('inserts exactly 33 current rows, one per source', async () => {
    const res = await t.client.query<{ rows: string; sources: string }>(
      `SELECT count(*)::text AS rows, count(DISTINCT source_id)::text AS sources
         FROM licence_registry WHERE tx_to = 'infinity'`,
    );
    expect(res.rows[0]!.rows).toBe('33');
    expect(res.rows[0]!.sources).toBe('33');
  });

  it('covers every ProviderId of PROVIDERS.a §1.1, plus the three non-provider sources', async () => {
    expect(PROVIDER_IDS).toHaveLength(30);
    const sources = await currentSources();
    for (const id of PROVIDER_IDS) expect(sources, id).toContain(id);
    for (const id of NON_PROVIDER_SOURCES) expect(sources, id).toContain(id);
    expect(sources).toEqual([...PROVIDER_IDS, ...NON_PROVIDER_SOURCES].sort());
  });

  it('has no row for `openfigi.search` — /v3/search records under openfigi.mapping', async () => {
    const sources = await currentSources();
    expect(sources).not.toContain('openfigi.search');
    expect(sources).toContain('openfigi.mapping');
  });

  it('sets retention_days on exactly cboe.quotes (30), cboe.options (10) and yahoo.chart (400)', async () => {
    const res = await t.client.query<{ source_id: string; retention_days: number }>(
      `SELECT source_id, retention_days FROM licence_registry
        WHERE tx_to = 'infinity' AND retention_days IS NOT NULL
        ORDER BY source_id`,
    );
    const found = Object.fromEntries(res.rows.map((r) => [r.source_id, r.retention_days]));
    expect(found).toEqual(RETENTION_DAYS);
  });

  it('opens every row and closes none (the seed writes a first version only)', async () => {
    const res = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM licence_registry
        WHERE tx_to <> 'infinity' OR valid_to <> 'infinity'`,
    );
    expect(res.rows[0]!.n).toBe('0');
  });

  it('gives every row a licence_kind the CHECK allows and a non-empty attribution', async () => {
    const res = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM licence_registry
        WHERE tx_to = 'infinity'
          AND (attribution IS NULL OR btrim(attribution) = ''
               OR source_name IS NULL OR btrim(source_name) = ''
               OR publisher IS NULL OR btrim(publisher) = '')`,
    );
    expect(res.rows[0]!.n).toBe('0');
  });

  it('bootstraps with provenance_id NULL — the registry predates any provider exchange', async () => {
    const res = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM licence_registry
        WHERE tx_to = 'infinity' AND provenance_id IS NOT NULL`,
    );
    expect(res.rows[0]!.n).toBe('0');
  });
});

describe('seed — field_licence matrix', () => {
  const t = withTxDb();

  it('inserts the matrix and points every row at a registered source', async () => {
    const total = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM field_licence`,
    );
    expect(Number(total.rows[0]!.n)).toBeGreaterThan(0);

    const orphans = await t.client.query<{ field_id: string; source_id: string }>(
      `SELECT f.field_id, f.source_id FROM field_licence f
        WHERE NOT EXISTS (SELECT 1 FROM licence_registry l
                           WHERE l.source_id = f.source_id AND l.tx_to = 'infinity')`,
    );
    expect(orphans.rows).toEqual([]);
  });

  it('keys the matrix on (field_id, asset_class)', async () => {
    const res = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT field_id, asset_class FROM field_licence
          GROUP BY field_id, asset_class HAVING count(*) > 1) d`,
    );
    expect(res.rows[0]!.n).toBe('0');
  });

  it('classifies price fields as `price` (evaluator rule 1 reads field_class)', async () => {
    const res = await t.client.query<{ field_class: string }>(
      `SELECT DISTINCT field_class::text FROM field_licence WHERE field_id = 'PX_LAST'`,
    );
    expect(res.rows.map((r) => r.field_class)).toEqual(['price']);
  });
});

describe('assert_source_known', () => {
  const t = withTxDb();

  it('rejects an unknown source_id on provenance', async () => {
    const attempt = t.savepoint(async () => {
      await t.client.query(
        `INSERT INTO provenance (source_id, request_key, request_url, request_hash,
                                 response_sha256, http_status, bytes, captured_at, adapter_version)
         VALUES ('acme.quotes', 'k', 'test://unknown', digest('k', 'sha256'),
                 digest('k', 'sha256'), 200, 0, now(), 'test/1.0.0')`,
      );
    });
    await expect(attempt).rejects.toThrow(/unknown source_id acme\.quotes/);
  });

  it('rejects an unknown source_id on field_licence', async () => {
    const attempt = t.savepoint(async () => {
      await t.client.query(
        `INSERT INTO field_licence (field_id, asset_class, source_id, field_class)
         VALUES ('PX_LAST', 'equity', 'acme.quotes', 'price')`,
      );
    });
    await expect(attempt).rejects.toThrow(/unknown source_id acme\.quotes/);
  });

  it('accepts a source the registry does know', async () => {
    const inserted = await t.savepoint(async () => {
      const res = await t.client.query<{ provenance_id: string }>(
        `INSERT INTO provenance (source_id, request_key, request_url, request_hash,
                                 response_sha256, http_status, bytes, captured_at, adapter_version)
         VALUES ('internal.user', 'known-source-probe', 'test://known',
                 digest('known-source-probe', 'sha256'), digest('known-source-probe', 'sha256'),
                 200, 0, now(), 'test/1.0.0')
         RETURNING provenance_id`,
      );
      return res.rows[0]!.provenance_id;
    });
    expect(Number(inserted)).toBeGreaterThan(0);
  });
});
