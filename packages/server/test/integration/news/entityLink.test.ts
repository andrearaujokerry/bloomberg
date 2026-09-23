/**
 * NEWS-02 precision, measured over the recorded stories (WORKPLAN §WP-09 acceptance row: "every
 * written link is ≥ 0.9; a known ambiguous headline produces **no** link; CIK links from
 * `sec-8k-atom.xml` are 1.0").
 *
 * The requirement this file exists to defend is not "link a lot of stories". It is that a link, once
 * written, is trustworthy: a wrong one puts somebody else's story on a user's own holding, where it
 * shows up on that issuer's CN screen, on the `n:inst:` subject and inside an alert. PROVIDERS.b
 * §11.3 encodes that as a floor of 0.90 and an arithmetic designed so the floor actually bites, and
 * the three assertions below are exactly the three ways that arithmetic can be wrong.
 *
 * **The floor is asserted as a minimum over every row, not over a sample.** `min(confidence)` across
 * the whole link set is one query and it cannot be satisfied by a lucky draw.
 *
 * **The floor is compared against the float4 value, deliberately.** `news_entity_links.confidence`
 * is `real`, and 0.9 is not representable in binary: `0.9::real` reads back as 0.8999999761581421,
 * so a link written at exactly the alias floor compares `< 0.9` the moment it is read. Comparing a
 * stored value against the literal would fail on a correct system; comparing it against
 * `LINK_THRESHOLD_STORED` is the same statement made in the type the column actually has. The test
 * also asserts the rounded value, so a genuinely-too-low link (0.875, 0.873, 0.812 — all exactly
 * representable) still fails.
 *
 * **The ambiguous headline is named.** `"India's Trade Gap Narrows Unexpectedly After Exports
 * Surge"` (bbg-rss-econ) against a seeded `The Gap Inc`, which is §11.3.3's own worked example on a
 * real recorded headline: a rule that matched bare prose tokens would file a story about India's
 * balance of trade under a US clothing retailer. The `World Holdings` case beside it proves the
 * ×0.90 ambiguity modifier actually runs, because `GAP` is short enough that `MIN_NAME_LENGTH`
 * would have caught it even if the modifier were dead code.
 *
 * **The ambiguous headline nobody enumerated is named too.** `GAP` and `WORLD` are on the
 * dictionary's 253-word ambiguous list, so a matcher could pass both of those rows while still
 * being wrong about every ordinary English word that is not on it. `Outlook Group Corp` is the
 * control for that: a real issuer whose name is a real word, on no list, which the recorded feeds
 * reach through `"clouding the outlook for the island nation's recovery"` — `normName` drops the
 * leading article, `THE OUTLOOK` becomes the key `OUTLOOK`, and two stories about Sri Lanka's GDP
 * and a Carlyle conference filed under a Wisconsin printing company at 0.9215. `Glencore Plc` and
 * `Vodacom Group Ltd.` in the same run are the other side of it: those still link, because a
 * corporate legal form is a second signal and `the` is not.
 *
 * WP-15 owns the seed and it does not exist: every issuer, instrument, listing, identifier and topic
 * here is created inside this file's own rolled-back transaction, and nothing depends on a literal
 * instrument id.
 */

import { describe, expect, it } from 'vitest';

import { runNewsRss } from '../../../src/ingest/jobs/newsRss.js';
import {
  AMBIGUOUS_MODIFIER,
  BASE_CONFIDENCE,
  clearsFloor,
  LINK_THRESHOLD,
  LINK_THRESHOLD_STORED,
  linkHeadline,
  scoreLink,
} from '../../../src/news/entityLink.js';
import { buildNewsDict } from '../../../src/refdata/newsDict.js';
import { identifierRepository } from '../../../src/refdata/identifiers.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import { openReplayStore } from '../../../src/providers/replayStore.js';
import { frozenClock, TEST_NOW } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';

import type { NewsJobContext } from '../../../src/ingest/jobs/newsRss.js';
import type { NewsDictionary } from '../../../src/refdata/newsDict.js';
import type { TestDb } from '../../../src/test/db.js';

const store = openReplayStore();
const clock = frozenClock(TEST_NOW);
const VALID_FROM = new Date('2020-01-01T00:00:00Z');
/**
 * The seeded master must be *known* before the run's `knownAt`, which is the frozen test clock.
 *
 * `tx_from` defaults to the database's own `now()` — the real wall clock, which is later than
 * `TEST_NOW` — so a dictionary snapshot taken at the frozen clock would not see a row this test
 * had just written, and every link would silently be absent, turning a precision test into a test
 * that nothing happens. `WriteOptions.knownAt` exists for exactly this (`refdata/master.ts` L117):
 * it states when we knew it. The re-write that sets `primary_listing_id` takes a strictly later
 * instant, because closing a version at its own `tx_from` is what `bt_guard_update` rejects.
 */
const KNOWN_FROM = new Date('2020-01-01T00:00:00Z');
const KNOWN_LATER = new Date('2020-01-02T00:00:00Z');
const AT = { validAt: new Date(TEST_NOW), knownAt: new Date(TEST_NOW) };

/** Aerkomm Inc., the first 8-K entry of `sec-8k-atom.xml`. */
const AERKOMM_CIK = '0001590496';

/** bbg-rss-econ. The example §11.3.3 is written around, on a real headline. */
const GAP_HEADLINE_LIKE = '%Trade Gap Narrows%';
/** bbg-rss-markets. `WORLD` is an ambiguous word and `Radiant World` is not our issuer. */
const WORLD_HEADLINE_LIKE = '%Radiant World Fraud%';
/**
 * bbg-rss-tech. A bare single-token issuer name in a headline and nothing else about it — which is
 * the class of false positive the ×0.90 modifier now covers, so it must earn **no** link.
 */
const APPLE_HEADLINE_LIKE = 'Apple AirPods 5%';
/**
 * bbg-rss-industries. The control: the summary opens "General Motors Co. is integrating …", a
 * two-token exact name, which is what a story that is actually about a company reads like.
 */
const GM_HEADLINE_LIKE = 'GM to Offer Apple CarPlay%';
/**
 * bbg-rss-econ. Its summary ends "…clouding the outlook for the island nation's recovery", which
 * reaches the key `OUTLOOK` through the two-token surface `THE OUTLOOK` and is nobody's idea of a
 * story about a printing company.
 */
const OUTLOOK_HEADLINE_LIKE = 'Sri Lanka%Growth Misses Forecast%';
/** bbg-rss-tech. The second one: "…and the outlook for credit with Ian Fujiyama…". */
const OUTLOOK_HEADLINE_LIKE_2 = 'Inside Carlyle%Global Investment Conference%';
/**
 * bbg-rss-markets. Its summary opens "Glencore Plc accused Radiant World and associated
 * companies…", so one story carries both sides of the rule: `GLENCORE PLC` links because `PLC` is
 * a corporate form, and `RADIANT WORLD` does not because `WORLD` is one bare word.
 */
const GLENCORE_HEADLINE_LIKE = 'Glencore Faces $2 Billion Suit%';

function context(t: TestDb): NewsJobContext {
  return { tx: t.db, clock, replay: store, log: {} };
}

/** One bootstrap `provenance` row, so the master repositories have something to cite. */
async function bootstrapProvenance(t: TestDb, label: string): Promise<number> {
  const key = `${label}-${String(Math.random()).slice(2)}`;
  const res = await t.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, adapter_version)
     VALUES ('internal.user', $1, 'test://wp09/' || $1, digest($1, 'sha256'), digest($1, 'sha256'),
             200, 0, $2, 'test/1.0.0')
     RETURNING provenance_id`,
    [key, new Date(TEST_NOW).toISOString()],
  );
  return Number(res.rows[0]!.provenance_id);
}

interface SeededIssuer {
  issuerId: number;
  instrumentId: number | null;
}

/**
 * An issuer, optionally with one live equity instrument whose primary listing is set — which is
 * what §11.3.4's "issuer → instrument fan-out is capped at one" resolves through.
 */
async function seedIssuer(
  t: TestDb,
  spec: { name: string; ticker?: string; cik?: string },
): Promise<SeededIssuer> {
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, `master-${spec.name}`);
  const o = { validFrom: VALID_FROM, knownAt: KNOWN_FROM, provenanceId };

  const issuerId = await repos.issuers.insert({ name: spec.name }, o);
  if (spec.cik !== undefined) {
    await identifierRepository(t.db).upsert(
      { entityKind: 'issuer', entityId: issuerId, scheme: 'CIK', value: spec.cik },
      o,
    );
  }
  if (spec.ticker === undefined) return { issuerId, instrumentId: null };

  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: 'equity',
      securityType: 'Common Stock',
      name: spec.name,
      currency: 'USD',
    },
    o,
  );
  const base = {
    issueId,
    assetClass: 'equity' as const,
    marketSector: 'Equity' as const,
    ticker: spec.ticker,
    exchCode: 'US',
    name: spec.name,
    currency: 'USD',
  };
  const instrumentId = await repos.instruments.insert(base, o);
  const listingId = await repos.listings.insert(
    {
      instrumentId,
      mic: 'XNAS',
      exchCode: 'UW',
      localTicker: spec.ticker,
      isPrimary: true,
    },
    o,
  );
  await repos.instruments.write(
    instrumentId,
    { ...base, primaryListingId: listingId },
    { validFrom: VALID_FROM, knownAt: KNOWN_LATER, provenanceId },
  );
  return { issuerId, instrumentId };
}

/**
 * One `issuer_aliases` row — the `name_alias` path, whose base of 0.90 is the only way to land a
 * candidate exactly on the floor without a single penalty being applied to it.
 */
async function seedAlias(t: TestDb, issuerId: number, alias: string): Promise<void> {
  await t.client.query(
    `INSERT INTO issuer_aliases (issuer_id, alias, kind) VALUES ($1, $2, 'brand')
       ON CONFLICT (issuer_id, alias) DO NOTHING`,
    [issuerId, alias],
  );
}

/** The feed topics §11.3.2 matcher 5 needs, created idempotently. */
async function seedTopics(t: TestDb): Promise<void> {
  const codes: [string, string][] = [
    ['MARKETS', 'Markets'],
    ['ECO', 'Economics'],
    ['POLITICS', 'Politics'],
    ['TECH', 'Technology'],
    ['INDUSTRIES', 'Industries'],
    ['WEALTH', 'Wealth'],
    ['FILINGS', 'Filings'],
    ['FED', 'Federal Reserve'],
    ['RATES', 'Interest rates'],
  ];
  for (const [code, name] of codes) {
    await t.client.query(
      `INSERT INTO topics (code, name, kind, keywords) VALUES ($1, $2, 'feed', '{}')
         ON CONFLICT (code) DO NOTHING`,
      [code, name],
    );
  }
}

interface LinkRow {
  news_id: string;
  entity_kind: string;
  entity_id: string;
  confidence: number;
  method: string;
  headline: string;
}

async function linksOfRun(t: TestDb, provenanceIds: readonly number[]): Promise<LinkRow[]> {
  if (provenanceIds.length === 0) return [];
  const res = await t.client.query<LinkRow>(
    `SELECT l.news_id::text AS news_id, l.entity_kind::text AS entity_kind,
            l.entity_id::text AS entity_id, l.confidence, l.method, n.headline
       FROM news_entity_links l
       JOIN news_items n ON n.news_id = l.news_id
      WHERE n.provenance_id = ANY($1::bigint[])
      ORDER BY l.news_id, l.entity_kind, l.entity_id`,
    [provenanceIds],
  );
  return res.rows;
}

async function headlineRow(
  t: TestDb,
  like: string,
): Promise<{ newsId: number; headline: string; summary: string | null; feed: string }> {
  const res = await t.client.query<{
    news_id: string;
    headline: string;
    summary: string | null;
    feed: string;
  }>(
    `SELECT news_id::text AS news_id, headline, summary, feed FROM news_items WHERE headline LIKE $1`,
    [like],
  );
  expect(res.rows.length).toBe(1);
  const row = res.rows[0]!;
  return {
    newsId: Number(row.news_id),
    headline: row.headline,
    summary: row.summary,
    feed: row.feed,
  };
}

describe('entity linking is precision-first over the recorded stories', () => {
  const t = withTxDb();

  it('writes no link below 0.90, links the CIK at exactly 1.0, and leaves the ambiguous headline alone', async () => {
    await seedTopics(t);
    const apple = await seedIssuer(t, { name: 'Apple Inc', ticker: 'AAPL' });
    const gm = await seedIssuer(t, { name: 'General Motors Co', ticker: 'GM' });
    const aerkomm = await seedIssuer(t, { name: 'Aerkomm Inc', cik: AERKOMM_CIK });
    const gap = await seedIssuer(t, { name: 'The Gap Inc', ticker: 'GPS' });
    const world = await seedIssuer(t, { name: 'World Holdings Inc', ticker: 'WRLD' });
    // Real issuers whose whole name is an ordinary English word, on no ambiguous-word list.
    const outlook = await seedIssuer(t, { name: 'Outlook Group Corp', ticker: 'OUTL' });
    const budget = await seedIssuer(t, { name: 'Budget Group Inc', ticker: 'BD' });
    // …and one whose name is not a word, to keep the run's true positives in the picture.
    const glencore = await seedIssuer(t, { name: 'Glencore plc', ticker: 'GLEN' });

    const run = await runNewsRss(context(t));
    expect(run.errors).toEqual([]);
    expect(run.stories).toBeGreaterThan(100);

    const links = await linksOfRun(t, run.provenanceIds);
    expect(links.length).toBeGreaterThan(0);

    // ── 1 · the floor, over every row ───────────────────────────────────────────────────────
    const confidences = links.map((l) => l.confidence);
    const min = Math.min(...confidences);
    expect(min).toBeGreaterThanOrEqual(LINK_THRESHOLD_STORED);
    // The same statement without relying on the float4 representation: nothing rounds below 0.90.
    expect(Math.round(min * 1e4) / 1e4).toBeGreaterThanOrEqual(LINK_THRESHOLD);
    for (const link of links) {
      expect(link.confidence).toBeGreaterThanOrEqual(LINK_THRESHOLD_STORED);
      expect(link.confidence).toBeLessThanOrEqual(1);
      expect(Object.keys(BASE_CONFIDENCE)).toContain(link.method);
    }

    // ── 2 · CIK links out of sec-8k-atom.xml are exactly 1.0 ────────────────────────────────
    const cikLinks = links.filter((l) => l.method === 'cik');
    expect(cikLinks.length).toBeGreaterThan(0);
    for (const link of cikLinks) expect(link.confidence).toBe(1);

    const aerkommLinks = links.filter((l) => Number(l.entity_id) === aerkomm.issuerId);
    expect(aerkommLinks.map((l) => l.method)).toEqual(['cik']);
    expect(aerkommLinks[0]!.confidence).toBe(1);
    expect(aerkommLinks[0]!.headline).toContain('Aerkomm');

    // ── 3 · the ambiguous headlines earn nothing ────────────────────────────────────────────
    const gapStory = await headlineRow(t, GAP_HEADLINE_LIKE);
    const gapStoryLinks = links.filter(
      (l) =>
        Number(l.news_id) === gapStory.newsId &&
        (l.entity_kind === 'issuer' || l.entity_kind === 'instrument'),
    );
    expect(gapStory.headline).toContain('Trade Gap');
    expect(gapStoryLinks).toEqual([]);
    // …and the seeded retailer is never linked to anything, anywhere in the run.
    expect(links.filter((l) => Number(l.entity_id) === gap.issuerId)).toEqual([]);

    const worldStory = await headlineRow(t, WORLD_HEADLINE_LIKE);
    expect(worldStory.headline).toContain('Radiant World');
    expect(
      links.filter(
        (l) => Number(l.news_id) === worldStory.newsId && Number(l.entity_id) === world.issuerId,
      ),
    ).toEqual([]);
    expect(links.filter((l) => Number(l.entity_id) === world.issuerId)).toEqual([]);

    // ── 4 · a bare single-token name, uncorroborated, earns nothing ─────────────────────────
    //
    // "Apple AirPods 5 Offer Noise Cancellation…" names Apple once, as one word, and nothing else
    // in the story corroborates it. §11.3.3's literal arithmetic scores that 0.95 × 0.95 = 0.9025
    // and writes it — and the same arithmetic files "Fed's New Inflation Target Draws Criticism"
    // under Target Corporation, "Regulators Block Merger of Two Regional Utilities" under Block,
    // Inc. and "Tennis Match Delayed by Rain" under Match Group, because TARGET, BLOCK and MATCH
    // are ordinary English words that happen to be issuer names and are not on anybody's
    // ambiguous-word list. Precision cannot rest on an enumeration being complete, so every
    // uncorroborated single-token surface takes the ×0.90 modifier: 0.81225, below the floor.
    const appleStory = await headlineRow(t, APPLE_HEADLINE_LIKE);
    expect(appleStory.headline).toContain('AirPods');
    expect(links.filter((l) => Number(l.news_id) === appleStory.newsId && l.method !== 'feed_topic'))
      .toEqual([]);

    // ── 4b · an ordinary English word that is NOT on the 253-word list ──────────────────────
    //
    // This is the case the enumeration could never have covered, and it is not hypothetical: with
    // the word list carrying precision, these two recorded stories — Sri Lanka's GDP and a Carlyle
    // conference — were filed under `Outlook Group Corp` at 0.9215 each, because their summaries
    // say "clouding the outlook" and "the outlook for credit". `normName` drops the leading
    // article, so the two-token surface `THE OUTLOOK` normalises to the one-token key `OUTLOOK`,
    // which took neither the single-token modifier (the surface is two tokens) nor the ambiguity
    // modifier (the word is on no list). Ambiguity decided on the key, structurally, is what
    // refuses them.
    const outlookStory = await headlineRow(t, OUTLOOK_HEADLINE_LIKE);
    const outlookStory2 = await headlineRow(t, OUTLOOK_HEADLINE_LIKE_2);
    expect(outlookStory.summary).toContain('the outlook');
    expect(outlookStory2.summary).toContain('the outlook');
    expect(links.filter((l) => Number(l.entity_id) === outlook.issuerId)).toEqual([]);
    expect(links.filter((l) => Number(l.entity_id) === outlook.instrumentId)).toEqual([]);
    // The bare-word form of the same class, for good measure: "UK Budget to Be Based on a Single
    // Set of Economic Forecasts" names a real issuer and no part of that story is about it.
    expect(links.filter((l) => Number(l.entity_id) === budget.issuerId)).toEqual([]);

    // ── 4c · …and the story that IS about a company still links ─────────────────────────────
    //
    // Same story as the `Radiant World` case above — "Glencore Plc accused Radiant World and
    // associated companies of sending falsified invoices" — so the two halves of the rule are
    // decided on one recorded sentence. `GLENCORE PLC` is a one-token key too; what separates it
    // from `THE OUTLOOK` and `RADIANT WORLD` is the corporate form the writer put there.
    const glencoreStory = await headlineRow(t, GLENCORE_HEADLINE_LIKE);
    expect(glencoreStory.summary).toContain('Glencore Plc');
    const glencoreLink = links.find(
      (l) =>
        Number(l.news_id) === glencoreStory.newsId && Number(l.entity_id) === glencore.issuerId,
    );
    expect(glencoreLink).toBeDefined();
    expect(glencoreLink!.method).toBe('name_exact');
    // 0.95 (name_exact) × 0.97 (summary only). No ambiguity penalty: `Plc` is the second signal.
    expect(Math.round(glencoreLink!.confidence * 1e4) / 1e4).toBe(0.9215);

    // ── 5 · the control: a two-token exact name in a story that IS about that company ───────
    //
    // "General Motors Co. is integrating Apple Inc.'s CarPlay …" — the summary of the same story
    // names both. `GENERAL MOTORS CO` is a three-token run normalising to the two-token key
    // `GENERAL MOTORS`, so no single-token modifier applies and it links. `Apple Inc.'s`
    // normalises to `APPLE INCS`, whose only usable surface is the bare word `APPLE`, so Apple
    // does not — which is the rule doing exactly what it says, on a real recorded headline.
    const gmStory = await headlineRow(t, GM_HEADLINE_LIKE);
    const gmLinks = links.filter((l) => Number(l.news_id) === gmStory.newsId);
    const gmIssuer = gmLinks.find(
      (l) => l.entity_kind === 'issuer' && Number(l.entity_id) === gm.issuerId,
    );
    expect(gmIssuer).toBeDefined();
    expect(gmIssuer!.method).toBe('name_exact');
    // 0.95 (name_exact) × 0.97 (the match is in the summary, not the headline) = 0.9215.
    expect(Math.round(gmIssuer!.confidence * 1e4) / 1e4).toBe(0.9215);

    // …and the issuer → instrument fan-out of §11.3.4 follows it, at the same confidence.
    const gmInstrument = gmLinks.find(
      (l) => l.entity_kind === 'instrument' && Number(l.entity_id) === gm.instrumentId,
    );
    expect(gmInstrument).toBeDefined();
    expect(gmInstrument!.confidence).toBe(gmIssuer!.confidence);

    expect(gmLinks.filter((l) => Number(l.entity_id) === apple.issuerId)).toEqual([]);
  });

  it('is idempotent: a second run writes no new link', async () => {
    await seedTopics(t);
    await seedIssuer(t, { name: 'Apple Inc', ticker: 'AAPL' });
    await seedIssuer(t, { name: 'Aerkomm Inc', cik: AERKOMM_CIK });

    const first = await runNewsRss(context(t));
    expect(first.errors).toEqual([]);
    expect(first.linked).toBeGreaterThan(0);

    const before = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM news_entity_links`,
    );
    const second = await runNewsRss(context(t));
    expect(second.errors).toEqual([]);
    expect(second.linked).toBe(0);
    const after = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM news_entity_links`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe('linkHeadline, the pure matcher, against the run dictionary', () => {
  const t = withTxDb();

  async function dictionary(): Promise<NewsDictionary> {
    return buildNewsDict(t.db, AT);
  }

  it('refuses the ambiguous headline and accepts the marked ticker', async () => {
    await seedTopics(t);
    const apple = await seedIssuer(t, { name: 'Apple Inc', ticker: 'AAPL' });
    await seedIssuer(t, { name: 'The Gap Inc', ticker: 'GPS' });
    const world = await seedIssuer(t, { name: 'World Holdings Inc', ticker: 'WRLD' });
    // Issuers whose *names* are ordinary English words, and a ticker that is also an abbreviation
    // English prose glosses in parentheses. Neither is on the 253-entry ambiguous-word list as a
    // name, which is the whole point: a list is an enumeration and precision may not rest on one
    // being complete.
    await seedIssuer(t, { name: 'Target Corporation', ticker: 'TGT' });
    await seedIssuer(t, { name: 'Block Inc', ticker: 'SQ' });
    await seedIssuer(t, { name: 'CPI Aerostructures Inc', ticker: 'CVU' });
    const dict = await dictionary();

    // `GAP` normalises to three characters and never enters the dictionary at all; `WORLD` does,
    // which is what makes the second case a test of the ×0.90 modifier rather than of the length
    // floor.
    expect(dict.names.has('GAP')).toBe(false);
    expect(dict.names.get('WORLD')).toBe(world.issuerId);
    expect(dict.names.get('APPLE')).toBe(apple.issuerId);
    expect(dict.isAmbiguous('WORLD')).toBe(true);
    // The contract that replaced the list: ambiguity is a property of the shape of the surface,
    // not of its membership of anything. One word needs corroboration whatever the word is —
    // `APPLE` is on no list and is ambiguous; `TARGET` is on no list and is ambiguous; a surface
    // of two tokens is not, unless data ops have said otherwise.
    expect(dict.isAmbiguous('APPLE')).toBe(true);
    expect(dict.isAmbiguous('TARGET')).toBe(true);
    expect(dict.isAmbiguous('Apple Inc.')).toBe(false);
    expect(dict.isAmbiguous('APPLE HOSPITALITY')).toBe(false);

    const base = { summary: null, cik: null, items8k: null, feed: 'markets' as const };

    expect(
      linkHeadline(
        {
          ...base,
          headline: 'India’s Trade Gap Narrows Unexpectedly After Exports Surge',
          sourceId: 'bbg.rss',
        },
        dict,
      ),
    ).toEqual([]);

    // 0.95 × 0.95 (single token) × 0.90 (ambiguous, uncorroborated) = 0.81225 → below the floor.
    expect(
      linkHeadline(
        {
          ...base,
          headline: 'Glencore Faces $2 Billion Suit as It Alleges Radiant World Fraud',
          sourceId: 'bbg.rss',
        },
        dict,
      ),
    ).toEqual([]);

    // A marked ticker is a deliberate mark: 1.00 in the headline, and it carries the instrument.
    const marked = linkHeadline(
      { ...base, headline: 'Apple ($AAPL) Lifts Guidance', sourceId: 'bbg.rss' },
      dict,
    );
    expect(marked.map((c) => c.method)).toEqual(['ticker_exact', 'ticker_exact']);
    for (const c of marked) expect(c.confidence).toBe(1);
    expect(marked.map((c) => c.entityKind).sort()).toEqual(['instrument', 'issuer']);

    // The same name, single token, in the summary only: 0.95 × 0.97 × 0.95 = 0.875 → no link.
    expect(
      linkHeadline(
        {
          ...base,
          headline: 'Chipmakers Rally on Demand',
          summary: 'Analysts pointed to Apple as the swing factor.',
          sourceId: 'bbg.rss',
        },
        dict,
      ),
    ).toEqual([]);

    // A URL is never a claim about the story's subject.
    expect(
      linkHeadline(
        {
          ...base,
          headline: 'Chipmakers Rally on Demand',
          summary: 'https://example.com/news/apple-plans-new-chip and nothing else.',
          sourceId: 'bbg.rss',
        },
        dict,
      ),
    ).toEqual([]);

    // ── single-token issuer names that are ordinary English words ───────────────────────────
    //
    // §11.3.3's literal arithmetic scores each of these 0.95 (name_exact) × 0.95 (single token)
    // = 0.9025 and writes it, because the ×0.90 ambiguity modifier only fires for a word on the
    // dictionary's list — and TARGET, BLOCK, MATCH, SQUARE, SHELL, TOTAL, UNITY, ARM and CARVANA
    // are not on it. Each of these headlines would then land on the wrong company's CN screen,
    // its `n:inst:` subject and its alerts.
    for (const headline of [
      'Fed’s New Inflation Target Draws Criticism From Economists',
      'Regulators Block Merger of Two Regional Utilities',
    ]) {
      expect(linkHeadline({ ...base, headline, sourceId: 'bbg.rss' }, dict), headline).toEqual([]);
    }

    // ── a parenthesised abbreviation is not a ticker mark ───────────────────────────────────
    //
    // `(AI)`, `(CPI)`, `(GDP)`, `(ETF)` are how English prose glosses an abbreviation, and they
    // are the same three characters as the unqualified `(TICKER)` form. Scored as a marked
    // ticker, `1.00 × 0.90` lands exactly ON the 0.90 floor and `confidence < LINK_THRESHOLD`
    // does not reject it — so the one surface the modifier exists to suppress was the one it
    // could not suppress. `(CVU)` proves the qualified reading still works.
    expect(
      linkHeadline(
        {
          ...base,
          headline: 'Consumer Price Index (CPI) Rose 0.3% in August, BLS Says',
          sourceId: 'bbg.rss',
        },
        dict,
      ).filter((c) => c.method === 'ticker_exact'),
    ).toEqual([]);

    const qualified = linkHeadline(
      { ...base, headline: 'CPI Aerostructures (CVU US) Wins Contract', sourceId: 'bbg.rss' },
      dict,
    );
    expect(qualified.map((c) => c.method)).toContain('ticker_exact');
    expect(qualified.every((c) => c.confidence >= LINK_THRESHOLD)).toBe(true);
  });

  /**
   * The mechanism, stated as the four things that corroborate and the one thing that does not.
   *
   * Every headline here scores 0.95 (`name_exact`, in the headline, surface of two tokens so no
   * single-token modifier) under an enumerated ambiguous-word list, because not one of `TARGET`,
   * `BLOCK`, `SHELL`, `SQUARE` or `OUTLOOK` is on the 253-entry list — and is written, because
   * 0.95 ≥ 0.90. That is the defect: the word list decided precision, and a word list cannot.
   */
  it('refuses every one-word name the story does not say twice, list or no list', async () => {
    await seedTopics(t);
    const target = await seedIssuer(t, { name: 'Target Corporation', ticker: 'TGT' });
    const block = await seedIssuer(t, { name: 'Block Inc', ticker: 'XYZ', cik: '0001512673' });
    const shell = await seedIssuer(t, { name: 'Shell plc', ticker: 'SHEL' });
    const square = await seedIssuer(t, { name: 'Square Enix Holdings Co', ticker: 'SQNXF' });
    const outlook = await seedIssuer(t, { name: 'Outlook Group Corp', ticker: 'OUTL' });
    const dict = await dictionary();
    const base = { summary: null, cik: null, items8k: null, feed: 'markets' as const };

    // None of these words is on the ambiguous-word list — which is exactly why the list was never
    // a mechanism. Each surface here is TWO tokens (`THE TARGET`, `SHELL COMPANY`, `SQUARE ONE`,
    // `BLOCK CORP`) and normalises to one, so the single-token modifier does not fire either.
    for (const [headline, issuerId] of [
      ['Fed Officials Split Over Whether to Raise the Target for Core Inflation', target.issuerId],
      ['Prosecutors Trace the Money Through a Shell Company in Panama', shell.issuerId],
      ['Talks Collapse and the Parties Are Back to Square One, Mediator Says', square.issuerId],
      ['Sri Lanka’s Growth Misses Forecast as Crisis Clouds the Outlook', outlook.issuerId],
      ['Regulators Block Merger of Two Regional Utilities', block.issuerId],
      ['Fed’s New Inflation Target Draws Criticism From Economists', target.issuerId],
    ] as const) {
      const links = linkHeadline({ ...base, headline, sourceId: 'bbg.rss' }, dict);
      expect(
        links.filter((c) => c.entityId === issuerId || c.method !== 'feed_topic'),
        headline,
      ).toEqual([]);
    }

    // ── the same names, corroborated — the recall side of the same rule ─────────────────────
    //
    // A corporate legal form is the name-side qualifier: no English sentence writes "Inc" or "Plc"
    // after a noun by accident, and `core/text/normName.ts` strips it, so the surface carries a
    // signal the key cannot. 0.95 = name_exact, in the headline, two-token surface.
    const withForm = linkHeadline(
      { ...base, headline: 'Shell Plc Lifts Dividend After a Record Quarter', sourceId: 'bbg.rss' },
      dict,
    );
    const shellIssuer = withForm.find((c) => c.entityKind === 'issuer');
    expect(shellIssuer).toBeDefined();
    expect(shellIssuer!.entityId).toBe(shell.issuerId);
    expect(shellIssuer!.method).toBe('name_exact');
    expect(shellIssuer!.confidence).toBe(0.95);
    expect(clearsFloor(shellIssuer!.confidence)).toBe(true);

    // A marked ticker for the same issuer: the ticker wins the row outright at 1.00, and the point
    // is that the story now says "Target" twice, in two different ways.
    const withTicker = linkHeadline(
      { ...base, headline: 'Target ($TGT) Cuts Its Full-Year Outlook', sourceId: 'bbg.rss' },
      dict,
    );
    const targetIssuer = withTicker.find(
      (c) => c.entityKind === 'issuer' && c.entityId === target.issuerId,
    );
    expect(targetIssuer).toBeDefined();
    expect(targetIssuer!.method).toBe('ticker_exact');
    expect(targetIssuer!.confidence).toBe(1);

    // A CIK on the story is the filer's own identity claim; the bare name in the headline is
    // corroborated by it and the row is written at the CIK's 1.00.
    const withCik = linkHeadline(
      {
        ...base,
        headline: 'Block Reports Fourth-Quarter Results',
        cik: '0001512673',
        feed: '8-K',
        sourceId: 'sec.atom',
      },
      dict,
    );
    const blockIssuer = withCik.find(
      (c) => c.entityKind === 'issuer' && c.entityId === block.issuerId,
    );
    expect(blockIssuer).toBeDefined();
    expect(blockIssuer!.method).toBe('cik');
    expect(blockIssuer!.confidence).toBe(1);
    // …and the same headline with no CIK is the first case again: nothing.
    expect(
      linkHeadline(
        { ...base, headline: 'Block Reports Fourth-Quarter Results', sourceId: 'bbg.rss' },
        dict,
      ).filter((c) => c.method !== 'feed_topic'),
    ).toEqual([]);
  });

  /**
   * `(BOOT)` is a ticker mark and a parenthesised gloss, and nothing in the three characters says
   * which. The two headlines below differ in one thing — the exchange qualifier — so the test
   * isolates the variable the rule is about.
   */
  it('requires the exchange qualifier before a parenthesised ticker is a ticker', async () => {
    await seedTopics(t);
    const boot = await seedIssuer(t, { name: 'Boot Barn Holdings Inc', ticker: 'BOOT' });
    const allstate = await seedIssuer(t, { name: 'Allstate Corp', ticker: 'ALL' });
    const dict = await dictionary();
    const base = { summary: null, cik: null, items8k: null, feed: 'markets' as const };
    expect(dict.lookupTicker('BOOT')?.issuerId).toBe(boot.issuerId);
    // The ticker is one token, so the dictionary calls it ambiguous — no list consulted, and BOOT
    // is on none of them anyway.
    expect(dict.isAmbiguous('BOOT')).toBe(true);

    const unqualified = linkHeadline(
      {
        ...base,
        headline: 'Army Contract for the Standard Combat Boot (BOOT) Goes to One Supplier',
        sourceId: 'bbg.rss',
      },
      dict,
    );
    expect(unqualified.filter((c) => c.method === 'ticker_exact')).toEqual([]);
    expect(unqualified.filter((c) => c.entityId === boot.issuerId)).toEqual([]);

    for (const headline of [
      'Army Contract for the Standard Combat Boot (BOOT US) Goes to One Supplier',
      'Army Contract for the Standard Combat Boot BOOT:US Goes to One Supplier',
      'Army Contract for the Standard Combat Boot $BOOT Goes to One Supplier',
    ]) {
      const qualified = linkHeadline({ ...base, headline, sourceId: 'bbg.rss' }, dict);
      const issuer = qualified.find((c) => c.entityKind === 'issuer');
      expect(issuer, headline).toBeDefined();
      expect(issuer!.method).toBe('ticker_exact');
      // The mark is its own corroboration and takes no single-token discount: the full 1.00.
      expect(issuer!.confidence).toBe(1);
      expect(qualified.some((c) => c.entityKind === 'instrument' && c.confidence === 1)).toBe(true);
    }

    // The other direction, and the reason the rule is "qualified", not "on a list": `ALL` is on
    // the 253-word ambiguous list, and a list-driven rule refused `$ALL` outright — but `$ALL` is
    // a cashtag, not a gloss. No English sentence writes it. The mark decides.
    const cashtag = linkHeadline(
      { ...base, headline: '$ALL Raises Its Full-Year Guidance', sourceId: 'bbg.rss' },
      dict,
    );
    const allIssuer = cashtag.find((c) => c.entityKind === 'issuer');
    expect(allIssuer).toBeDefined();
    expect(allIssuer!.entityId).toBe(allstate.issuerId);
    expect(allIssuer!.method).toBe('ticker_exact');
    expect(allIssuer!.confidence).toBe(1);

    // The unqualified form is not dead: it is one ambiguous surface like any other, so a story
    // that names the issuer some other way writes it — at 1.00 × 0.95, the one-token discount the
    // matcher used to skip for every ticker mark.
    const corroborated = linkHeadline(
      { ...base, headline: 'Boot Barn Holdings (BOOT) Lifts Guidance', sourceId: 'bbg.rss' },
      dict,
    );
    const instrument = corroborated.find((c) => c.entityKind === 'instrument');
    expect(instrument).toBeDefined();
    expect(instrument!.method).toBe('ticker_exact');
    expect(instrument!.confidence).toBe(0.95);
  });

  /**
   * The boundary, asserted on both sides.
   *
   * `name_alias` has base 0.90, and an alias in a headline earns no modifier at all, so it lands on
   * the floor exactly — it is the only candidate class that can. The floor is **inclusive**: this
   * one is written, and the same alias in the summary (× 0.97 = 0.873) is not. The reasoning is in
   * `news/entityLink.ts`'s header under "Where the boundary sits"; the short form is that NEWS-02
   * says "below 0.9", that 0.900 is not below 0.900, and that nothing is allowed to *arrive* at
   * 0.900 by being discounted — the ambiguity rule refuses instead of multiplying by 0.90, which
   * is what made an ambiguous marked ticker land on the floor and pass.
   */
  it('writes a candidate that lands exactly on 0.900 and refuses the one below it', async () => {
    await seedTopics(t);
    const ww = await seedIssuer(t, { name: 'WW International Inc', ticker: 'WW' });
    await seedAlias(t, ww.issuerId, 'Weight Watchers');
    const dict = await dictionary();
    const base = { summary: null, cik: null, items8k: null, feed: 'markets' as const };

    expect(dict.aliases.get('WEIGHT WATCHERS')).toBe(ww.issuerId);
    expect(dict.isAmbiguous('WEIGHT WATCHERS')).toBe(false);

    const onTheFloor = linkHeadline(
      { ...base, headline: 'Weight Watchers Raises Its Full-Year Guidance', sourceId: 'bbg.rss' },
      dict,
    );
    const issuer = onTheFloor.find((c) => c.entityKind === 'issuer');
    expect(issuer).toBeDefined();
    expect(issuer!.method).toBe('name_alias');
    expect(issuer!.confidence).toBe(LINK_THRESHOLD);
    expect(issuer!.confidence).toBe(0.9);

    // One modifier below it — the same alias, in the summary only — and it is gone.
    expect(
      linkHeadline(
        {
          ...base,
          headline: 'Weight-Loss Stocks Rally on Demand',
          summary: 'Analysts pointed to Weight Watchers as the swing factor.',
          sourceId: 'bbg.rss',
        },
        dict,
      ).filter((c) => c.method === 'name_alias'),
    ).toEqual([]);

    // The boundary itself, in both directions, in the type the column stores.
    expect(clearsFloor(LINK_THRESHOLD)).toBe(true);
    expect(clearsFloor(0.899999)).toBe(false);
    expect(clearsFloor(0.873)).toBe(false);
    expect(LINK_THRESHOLD_STORED).toBeLessThan(LINK_THRESHOLD);

    // And the reason the boundary had to be decided rather than inherited: §11.3.3's ×0.90
    // modifier applied to a base of 1.00 lands ON an inclusive floor, so as a *discount* it could
    // never refuse the ambiguous marked ticker it exists for. That is why it is a refusal.
    expect(
      scoreLink(BASE_CONFIDENCE.ticker_exact, {
        inHeadline: true,
        singleToken: false,
        ambiguousUncorroborated: true,
      }),
    ).toBe(LINK_THRESHOLD);
    expect(BASE_CONFIDENCE.ticker_exact * AMBIGUOUS_MODIFIER).toBeCloseTo(LINK_THRESHOLD, 12);
    expect(clearsFloor(BASE_CONFIDENCE.ticker_exact * AMBIGUOUS_MODIFIER)).toBe(true);
  });

  it('corroboration rescues an ambiguous name when a second method names the same issuer', async () => {
    await seedTopics(t);
    const world = await seedIssuer(t, { name: 'World Holdings Inc', ticker: 'WRLD' });
    const dict = await dictionary();

    const links = linkHeadline(
      {
        headline: 'World Holdings ($WRLD) Raises Guidance',
        summary: null,
        cik: null,
        items8k: null,
        feed: 'markets',
        sourceId: 'bbg.rss',
      },
      dict,
    );
    const issuer = links.find((l) => l.entityKind === 'issuer');
    expect(issuer).toBeDefined();
    expect(issuer!.entityId).toBe(world.issuerId);
    // The marked ticker wins the row outright at 1.0 — the name path is corroborated, not needed.
    expect(issuer!.confidence).toBe(1);
    expect(issuer!.method).toBe('ticker_exact');
  });
});
