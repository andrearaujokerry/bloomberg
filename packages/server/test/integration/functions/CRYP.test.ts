/**
 * `test/integration/functions/CRYP.test.ts` — WP-11's acceptance row for `CRYP`
 * ("reproduces the FUNCTIONS.md §7.3 worked example exactly, including the
 * `CONTEXT_ONLY_NOT_EXCHANGE_DATA` badge").
 *
 * The example is normative, so this file reproduces its *pipeline* rather than its numbers: the
 * recorded `coingecko-simple.json` is handed to the landed WP-05 adapter, the adapter's updates are
 * applied to the plant, and the resolver is run over the result. A test that typed `75828` into a
 * fixture of its own would assert that the resolver can copy a literal; this one asserts that the
 * recorded response reaches the payload through the same code the scheduler uses.
 *
 * Four things the example is about, and this file pins:
 *
 *  1. **The badge is unconditional.** `caveat: 'CONTEXT_ONLY_NOT_EXCHANGE_DATA'` on every payload —
 *     including the sorted variants and the one where two of the four rows are blank.
 *  2. **Four rows, two of them blank with a reason.** `solana` and `ripple` are in the enum and in
 *     the security master and the recorded response answers neither, so they are rows with
 *     `{v:null, st:'blank', r:'NOT_IN_UNIVERSE'}` and a `meta.unavailable` entry naming the id — not
 *     dropped, not zero, not last-known.
 *  3. **The change is a rolling 24-hour move, not a change since a close.** The landed adapter
 *     reconstructs the level 24 hours ago into `PX_CLOSE_1D` and `core/quote/derive.ts` derives
 *     `CHG_PCT_1D` from the pair at four decimals, so the fixture's `-4.217368765220806` arrives as
 *     `-4.2174`. The assertion below states both halves of that: the value, and the fact that it is
 *     the fixture's own number rounded by `derive.ts` rather than a different measurement.
 *  4. **The CSV is the payload.** `key,name,coingeckoId,px,chg24hPct,asOf,source`, with the blank
 *     rows carrying empty numeric fields rather than `0` (FUNCTIONS.md §1.6 rule 2).
 *
 * No seed is assumed and nothing asserts on a literal instrument id (WP-15 owns the seed): every
 * row lives inside `withTxDb()`'s transaction.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PayloadMeta } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { CRYP, CrypParams } from '@terminal/core/functions/manifests/CRYP';
import type { CrypPayload } from '@terminal/core/functions/manifests/CRYP';
import { pctChange } from '@terminal/core/quote/derive';

import * as CRYPModule from '../../../src/functions/CRYP/resolve.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import { coingeckoAdapter } from '../../../src/providers/coingecko/adapter.js';
import { impliedPrevClose } from '../../../src/providers/coingecko/parse.js';
import type { NormaliseLine, RawRecord } from '../../../src/providers/types.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, createWebSession, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';
import { expectGolden, idToken, subjectToken } from './golden.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = new Date('2020-01-01T00:00:00Z');

/**
 * `md_lines_symbol_excl` makes `(source_id, provider_symbol)` a global namespace and `server-int`
 * runs several forks against one database, so every symbol this file seeds carries a per-run
 * suffix — except the two CoinGecko ids, which the resolver matches *by value*. Those two are
 * seeded unsuffixed and are the reason this file must stay in the serial project.
 */
const SYMBOL_TAG = `.t${randomUUID().slice(0, 8)}`;

const REGISTRY = new FunctionRegistry([CRYP]);
const MODULES: Record<string, FunctionServerModule<any, any>> = { CRYP: CRYPModule };

const t: TestDb = withTxDb();

/** The recorded response the worked example is written against (FIXTURES.md). */
const FIXTURE = fileURLToPath(
  new URL('../../../../../fixtures/providers/raw/coingecko-simple.json', import.meta.url),
);
const FIXTURE_BODY = readFileSync(FIXTURE);
const FIXTURE_JSON = JSON.parse(FIXTURE_BODY.toString('utf8')) as Record<
  string,
  { usd: number; usd_24h_change: number }
>;

const COIN_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin%2Cethereum%2Csolana%2Cripple' +
  '&include_24hr_change=true&vs_currencies=usd';

interface SeededCoin {
  instrumentId: number;
  mdLineId: number;
  key: string;
}

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  coins: Record<string, SeededCoin>;
  referenceCapturedAt: string;
}

let env: Env;

async function ensureLicences(): Promise<void> {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);
}

async function grantEverySource(firmId: number, userId: number): Promise<void> {
  await t.client.query(
    `INSERT INTO entitlement_grants
       (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
        usage_display, usage_export, usage_api, valid_from, valid_to)
     SELECT k.kind, k.id, l.source_id, NULL, NULL, 'realtime'::tier, true, true, true,
            $3::timestamptz, 'infinity'::timestamptz
       FROM (SELECT DISTINCT source_id FROM licence_registry WHERE tx_to = 'infinity') l
       CROSS JOIN (VALUES ('firm', $1::bigint), ('user', $2::bigint)) AS k(kind, id)`,
    [firmId, userId, GRANT_FROM],
  );
}

/**
 * One crypto instrument, with a CoinGecko line only when the recorded response answers its id.
 *
 * `solana` and `ripple` are seeded *without* a line on purpose: an `md_lines` row asserts that a
 * source publishes this symbol, and the recorded response does not. That is exactly the state
 * §CRYP completion 2 describes, and it is what makes those two rows `NO_SOURCE` rather than pending.
 */
async function seedCoin(spec: {
  ticker: string;
  name: string;
  coingeckoId: string | null;
  provenanceId: number;
}): Promise<SeededCoin> {
  const repos = masterRepositories(t.db);
  const o = { validFrom: VALID_FROM, provenanceId: spec.provenanceId };
  const issuerId = await repos.issuers.insert({ name: `${spec.name} network` }, o);
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: 'crypto',
      securityType: 'Crypto',
      name: spec.name,
      currency: 'USD',
    },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass: 'crypto',
      marketSector: 'Crypto',
      ticker: spec.ticker,
      exchCode: 'CRYPTO',
      name: spec.name,
      currency: 'USD',
      priceDecimals: 2,
    },
    o,
  );
  let mdLineId = -1;
  if (spec.coingeckoId !== null) {
    const line = await repos.mdLines.upsertBySymbol(
      {
        instrumentId,
        sourceId: 'coingecko.simple',
        providerSymbol: spec.coingeckoId,
        lineKind: 'composite',
        intrinsicDelayMin: 0,
        expectedIntervalMs: 60_000,
        priority: 10,
      },
      o,
    );
    mdLineId = line.mdLineId;
  }
  return { instrumentId, mdLineId, key: `${spec.ticker} Crypto` };
}

/** The recorded bytes as the transport hands them to a normaliser. */
function rawRecord(capturedAt: number): RawRecord {
  const sha = createHash('sha256').update(FIXTURE_BODY).digest('hex');
  return {
    providerId: 'coingecko.simple',
    method: 'GET',
    url: COIN_URL,
    requestKey: `coingecko.simple/${sha.slice(0, 16)}`,
    requestHash: sha,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: FIXTURE_BODY,
    capturedAt,
    sha256: sha,
    sourceTs: null,
    origin: 'network',
  };
}

beforeEach(async () => {
  await ensureLicences();

  const session = await createWebSession(t, { email: `cryp-${randomUUID()}@demo.invalid` });
  await grantEverySource(session.firmId, session.userId);

  const refProv = await bootstrapProvenance(t, 'internal.user', `cryp-ref-${SYMBOL_TAG}`);
  const quoteProv = await bootstrapProvenance(t, 'coingecko.simple', `cryp-quote-${SYMBOL_TAG}`);

  const btc = await seedCoin({
    ticker: 'BTC',
    name: 'Bitcoin',
    coingeckoId: 'bitcoin',
    provenanceId: refProv,
  });
  const eth = await seedCoin({
    ticker: 'ETH',
    name: 'Ethereum',
    coingeckoId: 'ethereum',
    provenanceId: refProv,
  });
  const sol = await seedCoin({
    ticker: 'SOL',
    name: 'Solana',
    coingeckoId: null,
    provenanceId: refProv,
  });
  const xrp = await seedCoin({
    ticker: 'XRP',
    name: 'XRP',
    coingeckoId: null,
    provenanceId: refProv,
  });

  const captured = await t.client.query<{ at: string }>(
    `SELECT to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
       FROM provenance WHERE provenance_id = $1`,
    [refProv],
  );
  const referenceCapturedAt = new Date(captured.rows[0]!.at).toISOString();

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };

  // The recorded response → the landed adapter → the plant. Nothing here restates a price.
  const line = (coin: SeededCoin): NormaliseLine => ({
    mdLineId: coin.mdLineId,
    instrumentId: coin.instrumentId,
    assetClass: 'crypto',
    tier: 'delayed',
    intrinsicDelayMin: 0,
    expectedIntervalMs: 60_000,
    priority: 10,
  });
  const normalised = coingeckoAdapter.normalise(rawRecord(GOLDEN_CAPTURE_MS), {
    provenanceId: quoteProv,
    capturedAt: GOLDEN_CAPTURE_MS,
    lines: new Map([
      ['bitcoin', line(btc)],
      ['ethereum', line(eth)],
    ]),
  });
  expect(normalised.updates).toHaveLength(2);
  for (const update of normalised.updates) harness.deps.plant.apply(update);

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: session.cookie,
    knownAt,
    coins: { BTC: btc, ETH: eth, SOL: sol, XRP: xrp },
    referenceCapturedAt,
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: CrypPayload;
  meta: PayloadMeta;
}

async function runCRYP(params: Record<string, unknown> = {}): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/CRYP/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

/**
 * The one key of a CRYP payload that holds a sequence-allocated id.
 *
 * Every other number here is a measurement — a price, a percentage — and a value-based rule would
 * rename whichever of them the instrument sequence happens to reach (the defect WP-10 closed across
 * 25 files). `subjectToken` covers the `q:<id>` tails inside the cells' `live.subject`.
 */
const ID_KEYS: ReadonlySet<string> = new Set(['instrumentId']);

function normalise(payload: CrypPayload): unknown {
  const tokens = new Map<number, string>(
    Object.entries(env.coins).map(([name, coin]) => [coin.instrumentId, `<${name}>`]),
  );
  const json = JSON.stringify(payload, (key, value: unknown) => {
    // Nothing else is substituted. Every timestamp in this payload is the frozen capture instant
    // — the quotes come from a `capturedAt` of `GOLDEN_CAPTURE_MS` and the reference rows from
    // `bootstrapProvenance`, which writes the same instant — so the golden carries them literally
    // rather than through a rule that would rewrite any string that happened to equal one.
    if (typeof value === 'string') return subjectToken(value, tokens);
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

/** The 24-hour change as the landed pipeline publishes it: reconstructed close → `derive.ts`. */
function derivedChange(id: 'bitcoin' | 'ethereum'): number {
  const quote = FIXTURE_JSON[id]!;
  const close = impliedPrevClose(quote.usd, quote.usd_24h_change);
  expect(close).not.toBeNull();
  const pct = pctChange({ PX_LAST: quote.usd, PX_CLOSE_1D: close! });
  expect(pct).toBeDefined();
  return pct!;
}

describe('CRYP — the §7.3 worked example', () => {
  it('shows four rows, the two priced ones from the recorded response', async () => {
    const { data } = await runCRYP();

    expect(data.variant).toBe('default');
    expect(data.source).toBe('coingecko.simple');
    // The badge the whole screen exists to carry (TERM-08), on the ordinary payload.
    expect(data.caveat).toBe('CONTEXT_ONLY_NOT_EXCHANGE_DATA');

    expect(data.rows).toHaveLength(4);
    expect(data.rows.map((row) => row.key)).toEqual([
      'BTC Crypto',
      'ETH Crypto',
      'SOL Crypto',
      'XRP Crypto',
    ]);
    expect(data.rows.map((row) => row.coingeckoId)).toEqual([
      'bitcoin',
      'ethereum',
      'solana',
      'ripple',
    ]);
    expect(data.rows.map((row) => row.name)).toEqual(['Bitcoin', 'Ethereum', 'Solana', 'XRP']);

    const btc = data.rows[0]!;
    expect(btc.instrumentId).toBe(env.coins.BTC!.instrumentId);
    expect(btc.px.v).toBe(FIXTURE_JSON.bitcoin!.usd); // 75828
    expect(btc.px.provIdx).toBeGreaterThanOrEqual(0);
    expect(btc.px.live).toEqual({ subject: `q:${String(btc.instrumentId)}`, field: 'PX_LAST' });
    expect(btc.asOf).toBe(GOLDEN_ISO);

    const eth = data.rows[1]!;
    expect(eth.px.v).toBe(FIXTURE_JSON.ethereum!.usd); // 2386.91
    expect(eth.chg24hPct.live).toEqual({
      subject: `q:${String(eth.instrumentId)}`,
      field: 'CHG_PCT_1D',
    });
  });

  it('carries the rolling 24-hour change, not a change since a close', async () => {
    const { data, meta } = await runCRYP();

    // The fixture's `usd_24h_change` is -4.217368765220806 for bitcoin. It reaches the payload
    // through the landed pipeline — reconstructed 24-hour-ago price, then `derive.ts` at four
    // decimals — so the payload number is that figure rounded, and this asserts the identity
    // rather than a transcribed literal.
    expect(data.rows[0]!.chg24hPct.v).toBe(derivedChange('bitcoin'));
    expect(data.rows[0]!.chg24hPct.v).toBeCloseTo(FIXTURE_JSON.bitcoin!.usd_24h_change, 3);
    expect(data.rows[1]!.chg24hPct.v).toBe(derivedChange('ethereum'));
    expect(data.rows[1]!.chg24hPct.v).toBeCloseTo(FIXTURE_JSON.ethereum!.usd_24h_change, 3);

    // And `meta` says why there is no change-since-close column at all.
    const note = meta.unavailable.find((row) => row.field === 'PX_CLOSE_1D');
    expect(note?.reason).toBe('NOT_APPLICABLE');
    expect(note?.detail).toContain('rolling 24-hour change');
  });

  it('shows an unanswered id as a blank row with a reason, never as a price', async () => {
    const { data, meta } = await runCRYP();

    for (const [index, id] of [
      [2, 'solana'],
      [3, 'ripple'],
    ] as const) {
      const row = data.rows[index]!;
      expect(row.coingeckoId).toBe(id);
      expect(row.px.v).toBeNull();
      expect(row.px.st).toBe('blank');
      // The specific code matters: the cell and the footer describe the same fact, and
      // `PROVIDER_DOWN` would claim CoinGecko was unreachable when it answered fine and simply
      // carries no line for this id. TERM-12's provider-down cells are `stale` with their last
      // values, not blank.
      expect(row.px.r).toBe('NOT_IN_UNIVERSE');
      expect(row.px.provIdx).toBeGreaterThanOrEqual(0);
      expect(row.chg24hPct.v).toBeNull();
      expect(row.chg24hPct.st).toBe('blank');
      expect(row.chg24hPct.r).toBe('NOT_IN_UNIVERSE');
      expect(row.asOf).toBe(env.referenceCapturedAt);

      const note = meta.unavailable.find((entry) => entry.field === id);
      expect(note?.reason).toBe('NO_SOURCE');
      expect(note?.detail).toBe('not a seeded CoinGecko id');
    }
  });

  it('sorts by name, price and change, and keeps the badge on every variant', async () => {
    const byName = await runCRYP({ sort: 'name' });
    expect(byName.data.rows.map((row) => row.name)).toEqual([
      'Bitcoin',
      'Ethereum',
      'Solana',
      'XRP',
    ]);

    // Price descending, and the two rows with no price stay last in key order rather than
    // sorting as if they were zero.
    const byPx = await runCRYP({ sort: 'px' });
    expect(byPx.data.rows.map((row) => row.coingeckoId)).toEqual([
      'bitcoin',
      'ethereum',
      'solana',
      'ripple',
    ]);
    expect(byPx.data.caveat).toBe('CONTEXT_ONLY_NOT_EXCHANGE_DATA');

    // Least-negative first: bitcoin (-4.2174) before ethereum (-6.0013); the blanks stay last.
    const byChg = await runCRYP({ sort: 'chg' });
    expect(byChg.data.rows.map((row) => row.coingeckoId)).toEqual([
      'bitcoin',
      'ethereum',
      'solana',
      'ripple',
    ]);
    expect(byChg.data.caveat).toBe('CONTEXT_ONLY_NOT_EXCHANGE_DATA');
  });

  it('takes a subset of ids and says nothing about the ones not asked for', async () => {
    const { data, meta } = await runCRYP({ ids: ['bitcoin', 'ethereum'] });
    expect(data.rows.map((row) => row.coingeckoId)).toEqual(['bitcoin', 'ethereum']);
    expect(meta.unavailable.some((row) => row.field === 'solana')).toBe(false);
    expect(meta.unavailable.some((row) => row.field === 'ripple')).toBe(false);
  });

  it('refuses an id that is not one of the four', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/CRYP/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { ids: ['dogecoin'] },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; details?: { location?: string } } }>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details?.location).toBe('fnParams');
  });

  it('declares the params, the live spec and the CSV the example specifies', async () => {
    // Params: `CRYP` with no arguments is all four, sorted by name.
    expect(CrypParams.parse({})).toEqual({
      ids: ['bitcoin', 'ethereum', 'solana', 'ripple'],
      sort: 'name',
    });

    const { data } = await runCRYP();
    const live = CRYP.live!(CrypParams.parse({}), data);
    expect(live).not.toBeNull();
    expect(live!.subjects).toEqual(data.rows.map((row) => `q:${String(row.instrumentId)}`));
    expect(live!.fields).toEqual(['PX_LAST', 'CHG_PCT_1D', 'LAST_TRADE_TIME']);
    expect(live!.conflationMs).toBe(1000);

    const columns = CRYP.csv.columns;
    expect(Array.isArray(columns)).toBe(true);
    expect((columns as { id: string }[]).map((column) => column.id)).toEqual([
      'key',
      'name',
      'coingeckoId',
      'px',
      'chg24hPct',
      'asOf',
      'source',
    ]);
    expect(CRYP.csv.filename(CrypParams.parse({}), { display: null, asOf: GOLDEN_ISO })).toBe(
      `CRYP_${GOLDEN_ISO.replace(/[-:]/g, '')}.csv`,
    );

    const rows = CRYP.csv.rows(data, CrypParams.parse({}));
    expect(rows[0]).toEqual([
      'BTC Crypto',
      'Bitcoin',
      'bitcoin',
      FIXTURE_JSON.bitcoin!.usd,
      derivedChange('bitcoin'),
      GOLDEN_ISO,
      'coingecko.simple',
    ]);
    // §1.6 rule 2: a blank cell is an empty field, never a zero.
    expect(rows[2]![3]).toBeNull();
    expect(rows[2]![4]).toBeNull();
  });

  it('matches the committed golden', async () => {
    const { data } = await runCRYP();
    expectGolden('CRYP.default.json', normalise(data));
  });
});
