/**
 * `search/rank.ts` — the WP-08 acceptance row: "`GET /api/v1/search` ranks the same way
 * `core/command/rank.ts` does for a ≥3-char name query" (WORKPLAN L1100, API.md §5.2 L438-488).
 *
 * The claim under test is an EQUALITY, and equality is asserted element by element — the same ids
 * in the same positions, not the same set. A set assertion would pass for a server that reversed
 * the list, and a reversed list is exactly the failure this test exists to catch: the client shows
 * its local rows immediately and merges the server's when they arrive, so a different order makes
 * the list jump under the cursor and can change row 0, which is what `GO` executes.
 *
 * ## Why the expectation is computed the CLIENT's way
 *
 * The expected order below is not a hard-coded list of tickers. It is `core/command/rank.ts#rank()`
 * over a `UniverseIndex` built the way a browser builds one: from `JSON.parse(snapshot.body)` — the
 * literal bytes `GET /universe/snapshot` serves — rather than from the server's in-memory tuples.
 * That makes the round trip part of the test: if the payload ever lost a `search_weight` to a
 * string, or a `status` to a boolean, the two indexes would score differently and the comparison
 * would fail here rather than in a terminal.
 *
 * ## The fixture is built to produce ties
 *
 * Score-equal rows are where two implementations diverge quietly, so the instruments below are
 * chosen so that several queries return rows with identical scores, resolved only by FUNCTIONS.md
 * §3.3's tie-break (shorter `primary`, then alphabetical, then kind, then id) — including two
 * listings whose `primary` is character-for-character identical, which is decided by id alone. Each
 * case asserts that the ties are really there, so the file cannot quietly become vacuous.
 *
 * Self-sufficient (TESTING §4.3): every firm, user, session and instrument is written here, inside
 * the rolled-back transaction, and passed to the app as its `db`.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import {
  FunctionRegistry,
  UniverseIndex,
  VirtualClock,
  rank as coreRank,
  registry as productionRegistry,
} from '@terminal/core';
import type { AnyFunctionManifest, AssetClass, Candidate, RankContext } from '@terminal/core';
import { SearchResponse } from '@terminal/sdk/wire/rest/search';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getConfig } from '../../../src/config.js';
import {
  MAX_RESULTS,
  NAME_FALLBACK_MIN_CHARS,
  rankCandidates,
  rankContextFor,
  searchRanker,
  toSearchHit,
} from '../../../src/search/rank.js';
import { universeSnapshot } from '../../../src/search/snapshot.js';
import { createTestApp } from '../../../src/test/app.js';
import { TEST_NOW } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';

import type { TestApp } from '../../../src/test/app.js';
import type { TestDb } from '../../../src/test/db.js';

/* -------------------------------------------------------------------------------------------- */
/* Fixture catalogue — `core/functions/manifests/` is empty until WP-09/10/11                     */
/* -------------------------------------------------------------------------------------------- */

const PRICED: readonly AssetClass[] = ['equity', 'etf', 'index', 'fx', 'govt'];

function manifest(spec: {
  code: string;
  name: string;
  aliases?: readonly string[];
  tier: 1 | 2 | 3;
  assetClasses?: readonly AssetClass[] | 'any' | 'none';
  requiresSecurity?: boolean;
}): AnyFunctionManifest {
  return {
    code: spec.code,
    name: spec.name,
    aliases: spec.aliases ?? [],
    tier: spec.tier,
    category: 'reference',
    assetClasses: spec.assetClasses ?? PRICED,
    requiresSecurity: spec.requiresSecurity ?? false,
    variants: {},
    params: z.object({}),
    paramGrammar: { positional: [] },
    fieldIds: () => [],
    pageable: false,
    live: null,
    csv: { filename: () => 'fixture.csv', columns: [], rows: () => [] },
    help: { summary: '', description: '', params: [], keys: [], sources: [], related: [] },
    keymap: [],
    screenKind: 'declarative',
    payloadVersion: 1,
  };
}

/** Includes `MICRO`, which collides with the `micro…` name queries below on purpose. */
function fixtureRegistry(): FunctionRegistry {
  return new FunctionRegistry([
    manifest({ code: 'DES', name: 'Security Description', tier: 1, requiresSecurity: true }),
    manifest({ code: 'GP', name: 'Price Graph', tier: 1, requiresSecurity: true }),
    manifest({ code: 'MICRO', name: 'Microstructure', tier: 2, requiresSecurity: true }),
    manifest({ code: 'MSG', name: 'Messages', tier: 2, aliases: ['IB'], assetClasses: 'none' }),
  ]);
}

/* -------------------------------------------------------------------------------------------- */
/* Fixture instruments                                                                            */
/* -------------------------------------------------------------------------------------------- */

interface Seeded {
  ticker: string;
  exch: string;
  sector: string;
  assetClass: string;
  name: string;
  weight: number;
  status: string;
}

/**
 * Chosen for the ties, not for realism alone:
 *
 *  - `MSFT`/`MSF`/`MSFX` all first-word-match `MICRO…` through "Microsoft", score identically, and
 *    are separated only by `primary` length then alphabet;
 *  - `MICR`/`MICROS` first-word-match and also ticker-prefix-match, which is the higher term;
 *  - `DUPE` is listed twice, character-for-character, so the only separator left is the id;
 *  - `MICROCHIP` is delisted, which puts it below everything through the −30 penalty;
 *  - the `Index` and `Curncy` lines carry different sector bonuses and different `primary` shapes.
 */
const INSTRUMENTS: readonly Seeded[] = [
  {
    ticker: 'MSFT',
    exch: 'US',
    sector: 'Equity',
    assetClass: 'equity',
    name: 'Microsoft Corporation',
    weight: 1,
    status: 'active',
  },
  {
    ticker: 'MSF',
    exch: 'US',
    sector: 'Equity',
    assetClass: 'equity',
    name: 'Microsoft Corporation',
    weight: 1,
    status: 'active',
  },
  {
    ticker: 'MSFX',
    exch: 'US',
    sector: 'Equity',
    assetClass: 'equity',
    name: 'Microsoft Corporation',
    weight: 1,
    status: 'active',
  },
  {
    ticker: 'MICR',
    exch: 'US',
    sector: 'Equity',
    assetClass: 'equity',
    name: 'Micron Technology Inc',
    weight: 1,
    status: 'active',
  },
  {
    ticker: 'MICROS',
    exch: 'US',
    sector: 'Equity',
    assetClass: 'equity',
    name: 'Micros Systems Inc',
    weight: 1,
    status: 'active',
  },
  {
    ticker: 'DUPE',
    exch: 'US',
    sector: 'Equity',
    assetClass: 'equity',
    name: 'Microline Holdings Inc',
    weight: 1,
    status: 'active',
  },
  {
    ticker: 'DUPE',
    exch: 'US',
    sector: 'Equity',
    assetClass: 'equity',
    name: 'Microline Holdings Inc',
    weight: 1,
    status: 'active',
  },
  {
    ticker: 'MCHP',
    exch: 'US',
    sector: 'Equity',
    assetClass: 'equity',
    name: 'Microchip Technology Inc',
    weight: 2,
    status: 'active',
  },
  {
    ticker: 'MICROCHIP',
    exch: 'US',
    sector: 'Equity',
    assetClass: 'equity',
    name: 'Microchip Old Line',
    weight: 1,
    status: 'delisted',
  },
  {
    ticker: 'MCRX',
    exch: 'INDEX',
    sector: 'Index',
    assetClass: 'index',
    name: 'Micro Cap Index',
    weight: 2,
    status: 'active',
  },
  {
    ticker: 'MICRUSD',
    exch: 'FX',
    sector: 'Curncy',
    assetClass: 'fx',
    name: 'Micro Dollar Pair',
    weight: 1,
    status: 'active',
  },
  {
    ticker: 'AAPL',
    exch: 'US',
    sector: 'Equity',
    assetClass: 'equity',
    name: 'Apple Inc',
    weight: 2,
    status: 'active',
  },
  {
    ticker: 'APPX',
    exch: 'US',
    sector: 'Equity',
    assetClass: 'equity',
    name: 'Apple Hospitality REIT Inc',
    weight: 1,
    status: 'active',
  },
  {
    ticker: 'APLE',
    exch: 'US',
    sector: 'Equity',
    assetClass: 'equity',
    name: 'Applied Materials Inc',
    weight: 1,
    status: 'active',
  },
  {
    ticker: 'TSLA',
    exch: 'US',
    sector: 'Equity',
    assetClass: 'equity',
    name: 'Tesla Inc',
    weight: 2,
    status: 'active',
  },
];

/** Queries of three characters or more, each exercising a different part of §3.3. */
const NAME_QUERIES: readonly string[] = [
  'micro', // first-word name matches, ties on identical scores
  'microso', // deeper into the first word
  'micr', // ticker prefix and name word competing
  'apple', // a second issuer family
  'appl', // ticker prefix + name word
  'tesla',
  'microline', // the character-identical `DUPE` pair: the id tie-break
  'mic', // exactly NAME_FALLBACK_MIN_CHARS
  'zzzzz', // no hit at all
];

/* -------------------------------------------------------------------------------------------- */
/* Seeding                                                                                        */
/* -------------------------------------------------------------------------------------------- */

async function prov(t: TestDb): Promise<number> {
  const key = `search-fallback-${randomUUID()}`;
  const res = await t.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, source_ts, adapter_version)
     VALUES ('openfigi.mapping', $1, 'test://' || $1, digest($1,'sha256'), digest($1,'sha256'),
             200, 0, $2, $2, 'test/1.0.0')
     RETURNING provenance_id`,
    [key, new Date(TEST_NOW).toISOString()],
  );
  return Number(res.rows[0]!.provenance_id);
}

async function seedInstruments(t: TestDb): Promise<void> {
  const p = await prov(t);
  const issue = await t.client.query<{ id: string }>(
    `SELECT nextval('issue_id_seq')::bigint AS id`,
  );
  const issueId = Number(issue.rows[0]!.id);
  for (const row of INSTRUMENTS) {
    await t.client.query(
      `INSERT INTO instruments (instrument_id, issue_id, asset_class, market_sector, ticker,
                                exch_code, name, currency, status, search_weight,
                                valid_from, tx_from, provenance_id)
       VALUES (nextval('instrument_id_seq'), $1, $2::asset_class, $3::market_sector, $4, $5, $6,
               'USD', $7, $8, '2020-01-01', '2020-01-01', $9)`,
      [
        issueId,
        row.assetClass,
        row.sector,
        row.ticker,
        row.exch,
        row.name,
        row.status,
        row.weight,
        p,
      ],
    );
  }
}

interface Actor {
  userId: number;
  firmId: number;
  cookie: string;
}

async function seedActor(t: TestDb): Promise<Actor> {
  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name, seat_count) VALUES ($1, 5) RETURNING firm_id`,
    [`Search Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'Search User', 'user') RETURNING user_id`,
    [firmId, `wp08-search-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  const signed = cookie.sign(token, getConfig().SESSION_SECRET);
  return { userId, firmId, cookie: `tsid=${encodeURIComponent(signed)}` };
}

/* -------------------------------------------------------------------------------------------- */
/* The client's side of the equality                                                              */
/* -------------------------------------------------------------------------------------------- */

/** The context the server scores in, with no MRU and no watchlist — see `search/rank.ts`. */
function clientContext(): RankContext {
  return {
    panel: { security: null, fn: null, params: {} },
    hasPanelSecurity: false,
    watchlistIds: new Set<number>(),
    mru: new Map(),
  };
}

/** How many distinct scores the list holds — `< length` means the fixture really produced ties. */
function distinctScores(rows: readonly Candidate[]): number {
  return new Set(rows.map((r) => r.score)).size;
}

describe('server search fallback ranks identically to core/command/rank.ts', () => {
  const t = withTxDb();
  const registry = fixtureRegistry();

  /** The index a browser would hold: built from the served JSON, not from the server's objects. */
  async function clientIndex(): Promise<UniverseIndex> {
    const cache = universeSnapshot({
      db: t.db,
      clock: new VirtualClock(TEST_NOW),
      registry,
    });
    const snap = await cache.get();
    return UniverseIndex.build(JSON.parse(snap.body) as never);
  }

  beforeEach(async () => {
    await seedInstruments(t);
  });

  it.each(NAME_QUERIES)('ranks "%s" in exactly the client\'s order', async (q) => {
    const index = await clientIndex();
    const expected = coreRank(q, index, clientContext(), registry);
    const actual = rankCandidates(index, registry, { q });

    // Element by element, in order — not a set comparison.
    expect(actual.map((c) => `${c.kind}:${c.id}`)).toEqual(
      expected.map((c) => `${c.kind}:${c.id}`),
    );
    expect(actual.map((c) => c.score)).toEqual(expected.map((c) => c.score));
    expect(actual).toEqual(expected);
  });

  it('the fixture really produces ties, so the ordering assertions are not vacuous', async () => {
    const index = await clientIndex();

    // Score ties, resolved by `primary` length then alphabet.
    const micro = coreRank('micro', index, clientContext(), registry);
    expect(micro.length).toBeGreaterThan(3);
    expect(distinctScores(micro)).toBeLessThan(micro.length);

    // Two listings whose `primary` is character-for-character identical: the last tie-break, the
    // instrument id, is the only thing deciding their order.
    const dupes = coreRank('microline', index, clientContext(), registry).filter(
      (c) => c.primary === 'DUPE US Equity',
    );
    expect(dupes).toHaveLength(2);
    expect(dupes[0]!.score).toBe(dupes[1]!.score);
    expect(Number(dupes[0]!.id)).toBeLessThan(Number(dupes[1]!.id));
  });

  it('never widens the cut: limit narrows, and MAX_RESULTS is the ceiling', async () => {
    const index = await clientIndex();
    const full = coreRank('micro', index, clientContext(), registry);

    expect(rankCandidates(index, registry, { q: 'micro', limit: 25 })).toEqual(full);
    expect(full.length).toBeLessThanOrEqual(MAX_RESULTS);

    const narrowed = rankCandidates(index, registry, { q: 'micro', limit: 3 });
    expect(narrowed).toEqual(full.slice(0, 3));
  });

  it('applies the name fallback only from three characters up', async () => {
    const index = await clientIndex();

    const short = rankCandidates(index, registry, { q: 'mi' });
    expect(short.every((c) => c.matchedOn !== 'name' && c.matchedOn !== 'trigram')).toBe(true);

    const long = rankCandidates(index, registry, { q: 'mic' });
    expect('mic'.length).toBe(NAME_FALLBACK_MIN_CHARS);
    expect(long.some((c) => c.matchedOn === 'name')).toBe(true);

    // Below the threshold the surviving rows keep `rank()`'s relative order: the gate removes, it
    // never reorders.
    const unfiltered = coreRank('mi', index, clientContext(), registry);
    expect(short.map((c) => c.id)).toEqual(
      unfiltered
        .filter((c) => c.matchedOn !== 'name' && c.matchedOn !== 'trigram')
        .map((c) => c.id),
    );
  });

  it('maps a candidate to the wire hit without touching its order or score', async () => {
    const index = await clientIndex();
    const rows = rankCandidates(index, registry, { q: 'micro' });
    const hits = rows.map(toSearchHit);

    expect(hits.map((h) => h.id)).toEqual(rows.map((c) => c.id));
    expect(hits.map((h) => h.score)).toEqual(rows.map((c) => c.score));
    for (const [i, hit] of hits.entries()) {
      const row = rows[i]!;
      expect(hit.primary).toBe(row.primary);
      expect(hit.secondary).toBe(row.secondary);
      expect(hit.insertText).toBe(row.insertText);
      expect(hit.matchedOn).toBe(row.matchedOn);
      expect(hit.matched).toEqual(row.matched);
      expect(hit.source).toBe('local');
      // `applicable` is a client rendering flag; `sdk/wire/rest/search.ts` does not declare it.
      expect(hit).not.toHaveProperty('applicable');
    }
  });

  it('scores a panel security context the same way the client does', async () => {
    const index = await clientIndex();
    const aapl = index.entries.find((e) => e.upperTicker === 'AAPL');
    expect(aapl?.instrumentId).toBeTypeOf('number');
    const panelSecurityId = aapl!.instrumentId!;

    const ctx = rankContextFor(index, { q: 'appl', panelSecurityId, panelFunction: 'gp' });
    expect(ctx.hasPanelSecurity).toBe(true);
    expect(ctx.panel.security).toEqual({
      instrumentId: panelSecurityId,
      assetClass: 'equity',
      marketSector: 'Equity',
      display: 'AAPL US Equity',
    });
    expect(ctx.panel.fn).toBe('GP');

    const expected = coreRank('appl', index, ctx, registry);
    const actual = rankCandidates(index, registry, {
      q: 'appl',
      panelSecurityId,
      panelFunction: 'gp',
    });
    expect(actual.map((c) => c.id)).toEqual(expected.map((c) => c.id));

    // An id this snapshot does not carry is "no panel security", not a half-filled context.
    const missing = rankContextFor(index, { q: 'appl', panelSecurityId: 999_999_999 });
    expect(missing.hasPanelSecurity).toBe(false);
    expect(missing.panel.security).toBeNull();
  });

  it('caches the index per snapshot version', async () => {
    const cache = universeSnapshot({ db: t.db, clock: new VirtualClock(TEST_NOW), registry });
    const ranker = searchRanker({ snapshot: cache, registry, clock: new VirtualClock(TEST_NOW) });

    const first = await ranker.search({ q: 'micro' });
    const second = await ranker.search({ q: 'apple' });
    expect(ranker.stats().indexBuilds).toBe(1);
    expect(ranker.stats().searches).toBe(2);
    expect(first.version).toBe(second.version);
    expect(first.tookMs).toBeGreaterThanOrEqual(0);

    const index = await clientIndex();
    expect(first.hits.map((h) => h.id)).toEqual(
      coreRank('micro', index, clientContext(), registry).map((c) => c.id),
    );
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The acceptance row: the HTTP boundary                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * `GET /api/v1/search` against the real app.
 *
 * The expectation is computed with the SAME catalogue the route serves — `registry` from
 * `@terminal/core`, the generated one — rather than this file's fixture catalogue. That matters
 * even while the catalogue is empty: FUNCTIONS.md §3.3's per-kind cap and twelve-row cut are
 * global, so a function row occupying a slot changes which instruments survive, and an expectation
 * built from a different catalogue would compare two different cuts and call the difference a bug.
 *
 * `http/routes/search.ts` is the WP-08 route module this exercises.
 */
describe('GET /api/v1/search', () => {
  const t = withTxDb();
  let app: TestApp;
  let actor: Actor;

  beforeEach(async () => {
    await seedInstruments(t);
    actor = await seedActor(t);
    app = await createTestApp({ db: t.db });
  });

  afterEach(async () => {
    await app.close();
  });

  async function search(q: string, limit?: number): Promise<SearchResponse> {
    const query = new URLSearchParams({ q });
    if (limit !== undefined) query.set('limit', String(limit));
    const res = await app.app.inject({
      method: 'GET',
      url: `/api/v1/search?${query.toString()}`,
      headers: { cookie: actor.cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return SearchResponse.parse(res.json());
  }

  /** `rank()` over the index a browser builds from `GET /universe/snapshot`, same catalogue. */
  async function expectedOrder(q: string): Promise<Candidate[]> {
    const cache = universeSnapshot({
      db: t.db,
      clock: new VirtualClock(TEST_NOW),
      registry: productionRegistry,
    });
    const snap = await cache.get();
    const index = UniverseIndex.build(JSON.parse(snap.body) as never);
    return coreRank(q, index, clientContext(), productionRegistry);
  }

  it.each(['micro', 'microline', 'apple', 'appl', 'tesla'])(
    'returns "%s" in exactly the order core/command/rank.ts produces',
    async (q) => {
      const body = await search(q);
      const expected = await expectedOrder(q);

      // Element by element, in order, ids AND scores — not a set comparison.
      expect(body.hits.map((h) => `${h.kind}:${h.id}`)).toEqual(
        expected.map((c) => `${c.kind}:${c.id}`),
      );
      expect(body.hits.map((h) => h.score)).toEqual(expected.map((c) => c.score));
      expect(body.hits.map((h) => h.primary)).toEqual(expected.map((c) => c.primary));
      expect(body.hits.length).toBeGreaterThan(0);
    },
  );

  it('never returns more than MAX_RESULTS, whatever limit asks for', async () => {
    const body = await search('micro', 25);
    expect(body.hits.length).toBeLessThanOrEqual(MAX_RESULTS);
    const narrowed = await search('micro', 2);
    expect(narrowed.hits.map((h) => h.id)).toEqual(body.hits.slice(0, 2).map((h) => h.id));
  });
});
