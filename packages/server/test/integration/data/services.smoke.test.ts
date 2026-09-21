/**
 * `data/{rates,news,holdings,options}.ts` — read-path coverage against the real database
 * (WORKPLAN §WP-04 L706-709).
 *
 * The two headline acceptance tests of this task live in `curves.test.ts` (the ANAL-08 build
 * cache) and `portfolio.test.ts` (PORT-07 tenant isolation). This file is the coverage the other
 * four services would otherwise ship without: every statement they issue is executed once, and the
 * invariants that are easy to get wrong in SQL are asserted —
 *
 *  - `rates`: one row per effective date, the newest vintage **known at `knownAt`**, so a revision
 *    published later is invisible until it is known (STOR-06);
 *  - `news`: the `tsv` match, the trigram fallback for a partial word, the entity-link filter, and
 *    the keyset cursor;
 *  - `holdings`: the latest file per `(etf, source)`, an unresolved line kept with a `null`
 *    instrument id, the inverse holder read, and an index roster projected into the holdings shape
 *    through `bt_as_of`;
 *  - `options`: the `bt_as_of` read of `option_terms`, one quote per contract at the newest
 *    capture ≤ `validAt`, and the two derived underlying numbers (`chgPct` off `bars_daily`,
 *    `iv30` off `vol_surfaces`).
 *
 * Self-sufficient (TESTING §4.3): every row is written by the test inside its own transaction,
 * which is rolled back. `tx_from` is passed explicitly on every bitemporal insert — the column
 * default is `now()`, which is the *wall clock*, and a fixture dated in the past would otherwise
 * be invisible to its own `knownAt`.
 */
import { describe, expect, it } from 'vitest';

import { membershipAsHoldings, readEtfHoldings, readHolders } from '../../../src/data/holdings.js';
import { listTopics, searchNews, topNews } from '../../../src/data/news.js';
import { chainSnapshot, contractTerms } from '../../../src/data/options.js';
import { fixingHistory, latestFixing } from '../../../src/data/rates.js';
import { withTxDb } from '../../../src/test/db.js';

import type { TestDb } from '../../../src/test/db.js';

const AT = { validAt: new Date('2026-09-15T20:00:00Z'), knownAt: new Date('2026-09-15T22:00:00Z') };

async function prov(t: TestDb, source: string): Promise<number> {
  const key = `${source}-${String(Math.random()).slice(2)}`;
  const res = await t.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, source_ts, adapter_version)
     VALUES ($1, $2, 'test://' || $2, digest($2,'sha256'), digest($2,'sha256'), 200, 0,
             $3, $3, 'test/1.0.0') RETURNING provenance_id`,
    [source, key, AT.knownAt.toISOString()],
  );
  return Number(res.rows[0]!.provenance_id);
}

async function nextId(t: TestDb, seq: string): Promise<number> {
  const res = await t.client.query<{ id: string }>(`SELECT nextval($1)::bigint AS id`, [seq]);
  return Number(res.rows[0]!.id);
}

describe('data services — read paths', () => {
  const t = withTxDb();

  it('rates', async () => {
    const code = `SOFR_T${String(Math.random()).slice(2, 8)}`;
    const p1 = await prov(t, 'nyfed.rates');
    const p2 = await prov(t, 'nyfed.rates');
    await t.client.query(
      `INSERT INTO rate_fixings (rate_code, effective_date, vintage_at, rate, is_latest, provenance_id)
       VALUES ($1,'2026-09-14','2026-09-15T13:00:00Z',5.31,true,$2),
              ($1,'2026-09-15','2026-09-15T13:00:00Z',5.33,true,$2),
              ($1,'2026-09-15','2026-09-16T13:00:00Z',5.34,false,$3)`,
      [code, p1, p2],
    );
    const latest = await latestFixing(t.db, AT, code);
    expect(latest.effectiveDate).toBe('2026-09-15');
    expect(latest.rate).toBe(5.33);
    expect(latest.provenanceId).toBe(p1);
    expect(latest.sourceTs).toBe(AT.knownAt.toISOString());

    const later = await latestFixing(
      t.db,
      { validAt: AT.validAt, knownAt: new Date('2026-09-17T00:00:00Z') },
      code,
    );
    expect(later.rate).toBe(5.34);

    const hist = await fixingHistory(t.db, AT, code, 5);
    expect(hist.map((h) => h.effectiveDate)).toEqual(['2026-09-15', '2026-09-14']);
  });

  it('news', async () => {
    const p = await prov(t, 'bbg.rss');
    const issuerId = await nextId(t, 'issuer_id_seq');
    const topic = await t.client.query<{ topic_id: string }>(
      `INSERT INTO topics (code, name, kind) VALUES ($1,'Markets','feed') RETURNING topic_id`,
      [`MKT${String(Math.random()).slice(2, 8)}`],
    );
    const topicId = Number(topic.rows[0]!.topic_id);

    const ids: number[] = [];
    for (const [i, headline] of [
      'Nvidia shares surge on AI demand',
      'Treasury yields slip after auction',
    ].entries()) {
      const res = await t.client.query<{ news_id: string }>(
        `INSERT INTO news_items (source_id, feed, provider_guid, kind, headline, summary, url,
                                 published_at, captured_at, provenance_id)
         VALUES ('bbg.rss','markets',$1,'story',$2,'body text','https://example.test',
                 $3,$4,$5) RETURNING news_id`,
        [
          `guid-${String(Math.random()).slice(2)}`,
          headline,
          new Date(Date.UTC(2026, 8, 15, 10 + i)).toISOString(),
          AT.knownAt.toISOString(),
          p,
        ],
      );
      ids.push(Number(res.rows[0]!.news_id));
    }
    await t.client.query(
      `INSERT INTO news_entity_links (news_id, entity_kind, entity_id, confidence, method)
       VALUES ($1,'issuer',$2,1.0,'cik'), ($1,'topic',$3,1.0,'feed_topic')`,
      [ids[0], issuerId, topicId],
    );

    const hit = await searchNews(t.db, AT, { q: 'Nvidia' });
    expect(hit.total).toBe(1);
    expect(hit.items[0]!.headline).toContain('Nvidia');
    expect(hit.items[0]!.provenanceId).toBe(p);
    expect(hit.items[0]!.links.map((l) => l.entityKind).sort()).toEqual(['issuer', 'topic']);

    const fallback = await searchNews(t.db, AT, { q: 'Nvid' });
    expect(fallback.total).toBe(1);

    const byIssuer = await searchNews(t.db, AT, { issuerId });
    expect(byIssuer.total).toBe(1);

    const paged = await searchNews(t.db, AT, { limit: 1 });
    expect(paged.items).toHaveLength(1);
    expect(paged.nextCursor).not.toBeNull();
    const next = await searchNews(t.db, AT, { limit: 1, cursor: paged.nextCursor! });
    expect(next.items[0]!.newsId).not.toBe(paged.items[0]!.newsId);

    const top = await topNews(t.db, AT, 'all', undefined, 5);
    expect(top.length).toBeGreaterThanOrEqual(2);
    const topFeed = await topNews(t.db, AT, 'feed', 'markets', 5);
    expect(topFeed.length).toBeGreaterThanOrEqual(2);

    const topics = await listTopics(t.db);
    expect(topics.some((x) => x.topicId === topicId)).toBe(true);
  });

  it('holdings', async () => {
    const p = await prov(t, 'ssga.holdings');
    const etf = await nextId(t, 'instrument_id_seq');
    const held = await nextId(t, 'instrument_id_seq');
    await t.client.query(
      `INSERT INTO etf_holdings (etf_instrument_id, as_of_date, source_id, line_no,
                                 holding_instrument_id, name, shares, market_value, weight,
                                 provenance_id)
       VALUES ($1,'2026-09-14','ssga.holdings',1,$2,'Apple Inc',100,1000,0.07,$3),
              ($1,'2026-09-14','ssga.holdings',2,NULL,'Unresolved plc',5,50,0.01,$3),
              ($1,'2026-09-15','ssga.holdings',1,$2,'Apple Inc',110,1100,0.08,$3)`,
      [etf, held, p],
    );

    const latest = await readEtfHoldings(t.db, AT, etf);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.asOfDate).toBe('2026-09-15');
    expect(latest[0]!.shares).toBe(110);
    expect(latest[0]!.provenanceId).toBe(p);

    const earlier = await readEtfHoldings(t.db, AT, etf, '2026-09-14');
    expect(earlier).toHaveLength(2);
    expect(earlier[1]!.holdingInstrumentId).toBeNull();

    const holders = await readHolders(t.db, AT, held);
    expect(holders.holders).toHaveLength(1);
    expect(holders.holders[0]!.holderInstrumentId).toBe(etf);
    expect(holders.holders[0]!.weightInHolder).toBe(0.08);
    expect(holders.asOfDate).toBe('2026-09-15');
    expect(holders.sources).toEqual(['ssga.holdings']);
    expect(holders.totals.holderCount).toBe(1);

    const none = await readHolders(t.db, AT, etf);
    expect(none.holders).toHaveLength(0);
    expect(none.asOfDate).toBeNull();
  });

  it('options', async () => {
    const p = await prov(t, 'cboe.options');
    const issueId = await nextId(t, 'issue_id_seq');
    const underlying = await nextId(t, 'instrument_id_seq');
    const contract = await nextId(t, 'instrument_id_seq');
    for (const [id, ticker, cls, sector] of [
      [underlying, 'AAPL', 'equity', 'Equity'],
      [contract, 'AAPL260916C00245000', 'option', 'Equity'],
    ] as const) {
      await t.client.query(
        `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                                  exch_code, name, currency, valid_from, tx_from, provenance_id)
         VALUES ($1,$2,$3,$4,$5,'US','Apple Inc','USD','2020-01-01','2020-01-01',$6)`,
        [id, issueId, cls, sector, ticker, p],
      );
    }
    await t.client.query(
      `INSERT INTO option_terms (instrument_id, occ_symbol, root, underlying_instrument_id, expiry,
                                 strike, put_call, valid_from, tx_from, provenance_id)
       VALUES ($1,'AAPL260916C00245000','AAPL',$2,'2026-09-16',245,'C','2026-01-01','2026-01-01',$3),
              ($4,'AAPL261016C00250000','AAPL',$2,'2026-10-16',250,'C','2026-01-01','2026-01-01',$3)`,
      [contract, underlying, p, await nextId(t, 'instrument_id_seq')],
    );

    const terms = await contractTerms(t.db, AT, contract);
    expect(terms.occSymbol).toBe('AAPL260916C00245000');
    expect(terms.strike).toBe(245);
    expect(terms.putCall).toBe('C');
    expect(terms.provenanceId).toBe(p);

    const chain = await chainSnapshot(t.db, AT, underlying);
    expect(chain.underlying.display).toBe('AAPL US Equity');
    expect(chain.expiries.map((e) => e.expiry)).toEqual(['2026-09-16', '2026-10-16']);
    expect(chain.contracts).toHaveLength(2);
    expect(chain.contracts.every((c) => c.q === null)).toBe(true);
    expect(chain.underlying.provenanceId).toBe(p);

    const filtered = await chainSnapshot(t.db, AT, underlying, '2026-10-16');
    expect(filtered.contracts).toHaveLength(1);
    expect(filtered.expiries).toHaveLength(2);
  });

  it('membership as holdings', async () => {
    const p = await prov(t, 'sec.archives');
    const idxInstrument = await nextId(t, 'instrument_id_seq');
    const m1 = await nextId(t, 'instrument_id_seq');
    const m2 = await nextId(t, 'instrument_id_seq');
    const issueId = await nextId(t, 'issue_id_seq');
    await t.client.query(
      `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                                exch_code, name, currency, valid_from, tx_from, provenance_id)
       VALUES ($1,$4,'equity','Equity','AAA','US','Alpha Inc','USD','2020-01-01','2020-01-01',$3),
              ($2,$4,'equity','Equity','BBB','US','Beta Inc','USD','2020-01-01','2020-01-01',$3)`,
      [m1, m2, p, issueId],
    );
    const idx = await t.client.query<{ index_id: string }>(
      `INSERT INTO indices (code, instrument_id, membership_source_id, provider)
       VALUES ($1,$2,'sec.archives','test') RETURNING index_id`,
      [`IDX${String(Math.random()).slice(2, 10)}`, idxInstrument],
    );
    const indexId = Number(idx.rows[0]!.index_id);
    await t.client.query(
      `INSERT INTO index_members (index_id, instrument_id, weight, as_of_date, source_id,
                                  valid_from, tx_from, provenance_id)
       VALUES ($1,$2,0.6,'2026-06-30','sec.archives','2026-06-30','2026-07-28',$4),
              ($1,$3,0.4,'2026-06-30','sec.archives','2026-06-30','2026-07-28',$4)`,
      [indexId, m1, m2, p],
    );

    const rows = await membershipAsHoldings(t.db, AT, idxInstrument);
    expect(rows.map((r) => r.holdingInstrumentId)).toEqual([m1, m2]);
    expect(rows.map((r) => r.weight)).toEqual([0.6, 0.4]);
    expect(rows.map((r) => r.lineNo)).toEqual([1, 2]);
    expect(rows[0]!.name).toBe('Alpha Inc');
    expect(rows[0]!.sourceId).toBe('sec.archives');
    expect(rows[0]!.provenanceId).toBe(p);

    // The fallback: an index with no etf_holdings file reads its roster instead.
    const viaService = await readEtfHoldings(t.db, AT, idxInstrument);
    expect(viaService).toHaveLength(2);

    // Known before the filing was accepted: no roster.
    const early = await membershipAsHoldings(
      t.db,
      { validAt: AT.validAt, knownAt: new Date('2026-07-01T00:00:00Z') },
      idxInstrument,
    );
    expect(early).toHaveLength(0);
  });

  it('option quotes, chgPct and iv30', async () => {
    const p = await prov(t, 'cboe.options');
    const issueId = await nextId(t, 'issue_id_seq');
    const underlying = await nextId(t, 'instrument_id_seq');
    const contract = await nextId(t, 'instrument_id_seq');
    await t.client.query(
      `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                                exch_code, name, currency, valid_from, tx_from, provenance_id)
       VALUES ($1,$3,'equity','Equity','MSFT','US','Microsoft','USD','2020-01-01','2020-01-01',$4),
              ($2,$3,'option','Equity','MSFT260916C00500000','US','MSFT call','USD','2020-01-01','2020-01-01',$4)`,
      [underlying, contract, issueId, p],
    );
    await t.client.query(
      `INSERT INTO option_terms (instrument_id, occ_symbol, root, underlying_instrument_id, expiry,
                                 strike, put_call, valid_from, tx_from, provenance_id)
       VALUES ($1,'MSFT260916C00500000','MSFT',$2,'2026-09-16',500,'C','2026-01-01','2026-01-01',$3)`,
      [contract, underlying, p],
    );
    await t.client.query(
      `INSERT INTO bars_daily (instrument_id, session_date, md_line_id, close, capture_ts,
                               provenance_id)
       VALUES ($1,'2026-09-14',1,400,'2026-09-14T21:00:00Z',$2)`,
      [underlying, p],
    );
    await t.client.query(
      `INSERT INTO option_quotes (capture_ts, instrument_id, underlying_instrument_id, md_line_id,
                                  bid, ask, iv, delta, open_interest, underlying_px, provenance_id)
       VALUES ('2026-09-15T18:00:00Z',$1,$2,1,12.5,12.7,0.24,0.55,1200,410,$3),
              ('2026-09-15T19:30:00Z',$1,$2,1,12.9,13.1,0.25,0.56,1300,420,$3)`,
      [contract, underlying, p],
    );
    await t.client.query(
      `INSERT INTO vol_surfaces (underlying_instrument_id, as_of, expiry, forward, atm_iv, svi,
                                 engine_name, engine_version, inputs_hash, provenance_ids)
       VALUES ($1,'2026-09-15T19:30:00Z','2026-10-15',420,0.27,'{}'::jsonb,'svi','1.0.0',
               repeat('a',64), ARRAY[$2]::bigint[])`,
      [underlying, p],
    );

    const chain = await chainSnapshot(t.db, AT, underlying);
    expect(chain.contracts).toHaveLength(1);
    const q = chain.contracts[0]!.q!;
    expect(q.captureTs).toBe('2026-09-15T19:30:00.000Z');
    expect(q.bid).toBe(12.9);
    expect(q.openInterest).toBe(1300);
    expect(q.provenanceId).toBe(p);
    expect(chain.captureTs).toBe('2026-09-15T19:30:00.000Z');
    expect(chain.underlying.px).toBe(420);
    expect(chain.underlying.chgPct).toBeCloseTo(0.05, 12);
    expect(chain.underlying.iv30).toBe(0.27);
    expect(chain.underlying.provenanceId).toBe(p);
  });
});
