// packages/server/src/seed/news.ts
//
// Seed module 11 of DATA_MODEL §18 (L2570): news, the topic tree, the economic series and the
// release calendar.
//
//   fixture                                   → table
//   (the thirteen v1 codes, DATA_MODEL L1540) → topics 13
//   bbg-rss-{markets,econ,politics,tech,industries} (5 × 20) ┐
//   sec-8k-atom.xml (40)                                     ├→ news_items 160, news_entity_links
//   fed-press-rss.xml (20)                                   ┘  and people (the bylines)
//   fred-DGS10.csv (16,881 observations)       → econ_series, econ_observations
//   bls-cpi.json (CUUR0000SA0, 32 months)      → econ_series, econ_observations
//   worldbank, imf-weo.json                    → econ_series, econ_observations
//   fred-cal, fred-releases.html, bls-schedule.html → econ_releases, econ_release_events
//   fixtures/seed/fomc-2026.json               → fomc_meetings 8
//
// **Order inside the module is a dependency order, and two of the edges are easy to get wrong.**
//
//  1. `topics` **before** `newsRss`. NEWS-02's matcher 5 maps a feed to a topic code
//     (`news/entityLink.ts#FEED_TOPIC_CODE`) and `refdata/newsDict.ts` builds its `topicKeywords`
//     map from the `topics` rows that exist when the run starts. Seed the stories first and all 160
//     of them are stored with no `feed_topic` link, permanently — `newsRss` links a story once, on
//     the run that stored it, and a later run finds it already stored and links nothing.
//  2. `econ_series` for BLS **before** `blsSeries`. That job builds its POST body from the
//     `bls.timeseries` rows in the database and drops a code the database does not know
//     (`blsSeries.ts` L286-292). The body participates in the replay key byte for byte, so the id
//     list must be *exactly* `["CUUR0000SA0"]` — the list the capture was recorded with. One extra
//     seeded BLS series and the request key changes and the fixture misses (FEED-08: a miss is a
//     wall, never a network call). `fredSeries` and `worldMacro` mint their own `econ_series` rows,
//     so only BLS needs this.
//
// **`people` is written from `news_items`, not from the feed bytes.** Every stored story already
// carries its verbatim `dc:creator` byline *and* the `provenance_id` of the capture that byline
// arrived in, so reading the authors back out of the table gives each person a provenance row
// pointing at the exact fixture that named them (DATA-10) without a second fetch and without a
// second parser. See {@link seedPeople} for why a byline is split into individuals.
//
// The FOMC calendar page is the one thing here that has no capture at all: `econCalendar.ts`'s
// `runFomcHalf` checks and records `noCapture` rather than inventing meetings (PROVIDERS §16.9),
// which is exactly why §18 hands this module the curated `fomc-2026.json` instead.
//
// Idempotence: the ingest legs are gated on {@link sourceFullyIngested} for the reason module 10's
// header sets out (a re-parse writes no value row, but a re-fetch would write a `provenance` row for
// an exchange that did not happen); `topics`, `people` and `fomc_meetings` are written by this
// module and each is an upsert that refuses to write unchanged data.

import { bitemporal, upsertVersion } from '../db/bitemporal.js';
import { people } from '../db/schema/calendars.js';
import { runBlsSeries } from '../ingest/jobs/blsSeries.js';
import { runEconCalendar } from '../ingest/jobs/econCalendar.js';
import { ensureEconSeries, runFredSeries } from '../ingest/jobs/fredSeries.js';
import { runNewsRss } from '../ingest/jobs/newsRss.js';
import { runWorldMacro } from '../ingest/jobs/worldMacro.js';
import { FEED_TOPIC_CODE } from '../news/entityLink.js';

import { capturesIngested, readSeedFixture, seedTx, sourceFullyIngested } from './fundamentals.js';

import type { SeedContext } from './index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// topics — the thirteen v1 codes
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface TopicSeed {
  code: string;
  name: string;
  kind: 'feed' | 'sector' | 'theme' | 'region' | 'event' | 'release';
  keywords: string[];
}

/**
 * DATA_MODEL L1540's thirteen codes, with the `kind` each one is and the keywords the matcher may
 * use.
 *
 * Six are `feed` because a Bloomberg RSS feed maps onto them one-for-one; `FED` and `FILINGS` are
 * `release` because a Fed press release and an 8-K are publications, not editorial sections;
 * `EARNINGS` and `CA` are `event`; the last three are `theme`.
 *
 * **Keywords are deliberately sparse.** `refdata/newsDict.ts` drops a keyword two topics share and
 * `news/entityLink.ts` scores a keyword hit at 0.9 — exactly the floor — so a keyword is a link, not
 * a hint, and a loose one is a wrong link on somebody's screen. Only the three `theme` topics carry
 * any, because a theme has no feed to identify it and a keyword is the only handle it has; the six
 * feed topics need none (matcher 5 reaches them by feed) and giving them keywords would make a
 * *"markets"* in a Fed press release link to the Markets feed topic.
 */
const TOPIC_SEED: readonly TopicSeed[] = Object.freeze([
  { code: 'MARKETS', name: 'Markets', kind: 'feed', keywords: [] },
  { code: 'ECO', name: 'Economics', kind: 'feed', keywords: [] },
  { code: 'POLITICS', name: 'Politics', kind: 'feed', keywords: [] },
  { code: 'TECH', name: 'Technology', kind: 'feed', keywords: [] },
  { code: 'WEALTH', name: 'Wealth', kind: 'feed', keywords: [] },
  { code: 'INDUSTRIES', name: 'Industries', kind: 'feed', keywords: [] },
  { code: 'FED', name: 'Federal Reserve', kind: 'release', keywords: [] },
  { code: 'FILINGS', name: 'Filings', kind: 'release', keywords: [] },
  { code: 'EARNINGS', name: 'Earnings', kind: 'event', keywords: [] },
  { code: 'CA', name: 'Corporate actions', kind: 'event', keywords: [] },
  { code: 'RATES', name: 'Rates', kind: 'theme', keywords: ['rate cut', 'rate hike'] },
  { code: 'FX', name: 'Foreign exchange', kind: 'theme', keywords: ['exchange rate'] },
  {
    code: 'AI',
    name: 'Artificial intelligence',
    kind: 'theme',
    keywords: ['artificial intelligence'],
  },
]);

/**
 * Write `topics`, then prove that every code matcher 5 can produce actually exists.
 *
 * The assertion is the point of doing this here rather than in a migration: `FEED_TOPIC_CODE` maps
 * eight feeds onto topic codes, and a feed whose code has no row links nothing — silently, because
 * `entityLink` treats an unknown topic as "no topic" rather than as an error. The failure would show
 * up as a TOP screen that is quietly missing a section, months later.
 */
async function seedTopics(ctx: SeedContext): Promise<number> {
  // Thirteen single-row statements rather than one `unnest`: `keywords` is `text[]`, so the batched
  // form would need a nested array parameter, and Postgres has no ragged nested array type —
  // `text[][]` is a rectangular matrix and `unnest` flattens it completely, which silently turns
  // thirteen keyword lists into one. Thirteen round trips inside one transaction is the cheaper
  // mistake to not make.
  let written = 0;
  for (const topic of TOPIC_SEED) {
    const one = await ctx.query(
      `INSERT INTO topics (code, name, kind, keywords)
       VALUES ($1, $2, $3, $4::text[])
       ON CONFLICT (code) DO UPDATE
          SET name = EXCLUDED.name, kind = EXCLUDED.kind, keywords = EXCLUDED.keywords
        WHERE topics.name     IS DISTINCT FROM EXCLUDED.name
           OR topics.kind     IS DISTINCT FROM EXCLUDED.kind
           OR topics.keywords IS DISTINCT FROM EXCLUDED.keywords
       RETURNING code`,
      [topic.code, topic.name, topic.kind, topic.keywords],
    );
    written += one.rows.length;
  }

  const present = await ctx.query(`SELECT code FROM topics`);
  const codes = new Set((present.rows as { code: string }[]).map((r) => r.code));
  const missing = [...new Set(FEED_TOPIC_CODE.values())].filter((code) => !codes.has(code)).sort();
  if (missing.length > 0) {
    throw new Error(
      `news/entityLink.ts#FEED_TOPIC_CODE maps a feed onto topic ${missing.join(', ')} but ` +
        'seed/news.ts writes no such row — every story on that feed would be stored with no ' +
        'feed_topic link and nothing would report it (NEWS-02 matcher 5)',
    );
  }
  return written;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// econ_series for BLS — the one series the recorded POST body names
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `CUUR0000SA0` — CPI for All Urban Consumers, all items, US city average, **not** seasonally
 * adjusted. The one id in the recorded `bls.timeseries` POST body, which is why it is the one id
 * seeded: see this module's header on why a second one would break the replay key.
 */
const BLS_CPI_SERIES = {
  seriesCode: 'CUUR0000SA0',
  sourceId: 'bls.timeseries',
  providerCode: 'CUUR0000SA0',
  name: 'Consumer Price Index for All Urban Consumers: All Items in U.S. City Average',
  units: 'Index 1982-1984=100',
  frequency: 'M' as const,
  seasonalAdj: 'NSA',
  country: 'US',
  decimals: 3,
} as const;

/** The recorded BLS window (`{"startyear":"2024","endyear":"2026"}`) — part of the request key. */
const BLS_RECORDED_WINDOW = { startYear: 2024, endYear: 2026 } as const;

/** The page size the World Bank capture was recorded with (§10.7: production uses 100). */
const WORLDBANK_RECORDED_PER_PAGE = 3;

/** The month `bls-schedule.html` covers — `.../schedule/news_release/september26.htm`. */
const BLS_SCHEDULE_MONTH = { year: 2026, month: 9 } as const;

/**
 * The two calendar pages the leg actually reads, named for {@link capturesIngested}.
 *
 * `fixtures/providers/raw` also holds `fred-releases.html` under `fred.calendar`
 * (`https://fred.stlouisfed.org/releases`, the release *catalogue*), and `econCalendar.ts` does not
 * read it — so the gate names the URL rather than the source, or it could never be satisfied.
 */
const FRED_CALENDAR_CONSUMED_URL = 'https://fred.stlouisfed.org/releases/calendar';
const BLS_SCHEDULE_CONSUMED_URL = 'https://www.bls.gov/schedule/news_release/september26.htm';

/** The one FRED series with a recorded capture (`fred-DGS10.csv`, 16,881 observations). */
const FRED_SEEDED_SERIES = ['DGS10'] as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// people — the bylines
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Credits that are not a natural person and must not become a `people` row.
 *
 * `people` is defined as natural persons (DATA_MODEL §19 gives it a lawful basis on that footing,
 * and `people.user_id` links a row to a platform user), so a wire credit is excluded. The list is
 * short on purpose: an exclusion that is wrong costs a person their row, so only credits that are
 * unambiguously an organisation are here.
 */
const NON_PERSON_CREDITS: ReadonlySet<string> = new Set(['bloomberg news', 'bloomberg']);

/**
 * Split one `dc:creator` byline into the people it names.
 *
 * Bloomberg writes a joint byline as `'Valentine Hilaire and Carolina Millán'` and a three-way one
 * as `'A, B and C'`. `news_items.author` keeps the byline verbatim — that is what was published —
 * but `people.name` is a person's name, and a row reading *"Erik Hertzberg and Brian Platt"* would
 * be a person who does not exist, would never match an autocomplete query for either journalist,
 * and would be personal data about two people filed under one name.
 *
 * The split is on `', '` and `' and '` only. Nothing clever: no initial-expansion, no title
 * stripping, no case folding of the stored name. A byline this rule mis-splits produces a person
 * nobody searches for, which is recoverable; a rule that merged two journalists would not be.
 */
export function splitByline(byline: string): string[] {
  return byline
    .split(/,\s*|\s+and\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== '' && !NON_PERSON_CREDITS.has(part.toLowerCase()));
}

const btPeople = bitemporal(people, 'personId');

/**
 * Write one `people` row per individual named in a stored byline.
 *
 * The provenance of a person is the capture their byline arrived in, and it is read straight off
 * `news_items`: `MIN(provenance_id)` per author is the first capture that named them, which is the
 * one a reader following DATA-10 back from the row should land on. Taking `MIN` rather than any
 * arbitrary row also makes the seed deterministic — the same database twice produces the same
 * provenance id on the same person.
 *
 * `people` is bitemporal, so `upsertVersion` is what gives this leg its idempotence: it compares the
 * candidate against the current version in Postgres on the table's own row type and returns `null`
 * when nothing changed, which is why a second seed writes no version and no `provenance` reference
 * churns. `person_id` comes from `person_id_seq` and is allocated **only** for a name the table does
 * not already hold, so a re-run neither burns ids nor forks a person into two.
 *
 * `valid_from` is the story's publication instant, not `now()`: what this row asserts is that the
 * person was writing for that desk then. `txFrom` is deliberately left to `clock_timestamp()` —
 * the knowledge instant is when the seed learned it, which is now.
 */
async function seedPeople(ctx: SeedContext): Promise<{ inserted: number; unchanged: number }> {
  const tx = seedTx(ctx);

  const rows = await ctx.query(
    `SELECT author, MIN(provenance_id) AS provenance_id, MIN(published_at) AS first_published_at
       FROM news_items
      WHERE author IS NOT NULL AND btrim(author) <> ''
      GROUP BY author
      ORDER BY author`,
  );

  interface AuthorRow {
    author: string;
    provenance_id: string | number;
    first_published_at: string | Date;
  }

  // One individual may appear in several bylines; the earliest capture and the earliest publication
  // win, so the aggregation happens here rather than in SQL (SQL cannot split the byline).
  const byPerson = new Map<string, { provenanceId: number; validFrom: Date }>();
  for (const row of rows.rows as AuthorRow[]) {
    const provenanceId = Number(row.provenance_id);
    const validFrom = new Date(row.first_published_at);
    for (const name of splitByline(row.author)) {
      const existing = byPerson.get(name);
      if (existing === undefined) {
        byPerson.set(name, { provenanceId, validFrom });
        continue;
      }
      if (provenanceId < existing.provenanceId) existing.provenanceId = provenanceId;
      if (validFrom < existing.validFrom) existing.validFrom = validFrom;
    }
  }

  const current = await ctx.query(
    `SELECT person_id, name FROM people WHERE tx_to = 'infinity' AND source_id = 'bbg.rss'`,
  );
  const personIdByName = new Map(
    (current.rows as { person_id: string | number; name: string }[]).map((r) => [
      r.name,
      Number(r.person_id),
    ]),
  );

  let inserted = 0;
  let unchanged = 0;

  for (const [name, { provenanceId, validFrom }] of [...byPerson].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    let personId = personIdByName.get(name);
    if (personId === undefined) {
      const next = await ctx.query(`SELECT nextval('person_id_seq') AS id`);
      personId = Number((next.rows[0] as { id: string | number }).id);
    }

    const versionId = await upsertVersion(tx, btPeople, {
      entityKey: { personId },
      validFrom,
      data: {
        personId,
        name,
        // A byline proves the person wrote the story; it does not prove a job title, and 'Reporter'
        // is the only role the source supports for every one of them (DATA_MODEL §19: "published
        // news authors"). `issuerId` and `userId` stay absent — a journalist is neither.
        role: 'Reporter',
        issuerId: null,
        userId: null,
        aliases: [],
        sourceId: 'bbg.rss',
      },
      provenanceId,
      reason: 'initial',
    });
    if (versionId === null) unchanged += 1;
    else inserted += 1;
  }

  return { inserted, unchanged };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// fomc_meetings — the curated 2026 calendar
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface FomcFixture {
  meetings: { meetingDate: string; statementAt: string; hasSep: boolean }[];
}

/**
 * Write `fomc_meetings` from `fixtures/seed/fomc-2026.json`.
 *
 * `provenance_id` is left NULL, which the column permits (0009) and which is the honest value: no
 * `fed.fomc` capture exists on disk — `econCalendar.ts#runFomcHalf` checks for one and records
 * `noCapture` — so there is no fixture to point at and the JSON file *is* the source. Pointing at
 * some other capture to satisfy a habit would be worse than NULL, because a reader following the id
 * would land on bytes that say nothing about FOMC dates.
 *
 * `decision_bp` is never written. It is "filled after the meeting" and no recorded source carries a
 * decision, so WIRP reads eight dates and no number we made up.
 */
async function seedFomcMeetings(ctx: SeedContext): Promise<number> {
  const fixture = readSeedFixture<FomcFixture>('fomc-2026.json');
  if (fixture.meetings.length !== 8) {
    throw new Error(
      `fixtures/seed/fomc-2026.json holds ${String(fixture.meetings.length)} meetings; the FOMC ` +
        'holds eight scheduled meetings a year and DATA_MODEL §18 expects eight rows',
    );
  }

  const result = await ctx.query(
    `INSERT INTO fomc_meetings (meeting_date, statement_at, has_sep)
     SELECT * FROM unnest($1::date[], $2::timestamptz[], $3::boolean[])
     ON CONFLICT (meeting_date) DO UPDATE
        SET statement_at = EXCLUDED.statement_at, has_sep = EXCLUDED.has_sep
      WHERE fomc_meetings.statement_at IS DISTINCT FROM EXCLUDED.statement_at
         OR fomc_meetings.has_sep      IS DISTINCT FROM EXCLUDED.has_sep
     RETURNING meeting_date`,
    [
      fixture.meetings.map((m) => m.meetingDate),
      fixture.meetings.map((m) => m.statementAt),
      fixture.meetings.map((m) => m.hasSep),
    ],
  );
  return result.rows.length;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The module
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SeedNewsResult {
  topicsWritten: number;
  newsItemsInserted: number;
  newsLinksWritten: number;
  peopleInserted: number;
  econObservationsInserted: number;
  econReleasesInserted: number;
  econReleaseEventsInserted: number;
  fomcMeetingsWritten: number;
  legsAlreadyIngested: number;
}

export async function seedNews(ctx: SeedContext): Promise<SeedNewsResult> {
  const tx = seedTx(ctx);
  const jobCtx = { tx, clock: ctx.clock, log: { info: () => undefined } };

  const result: SeedNewsResult = {
    topicsWritten: 0,
    newsItemsInserted: 0,
    newsLinksWritten: 0,
    peopleInserted: 0,
    econObservationsInserted: 0,
    econReleasesInserted: 0,
    econReleaseEventsInserted: 0,
    fomcMeetingsWritten: 0,
    legsAlreadyIngested: 0,
  };

  // ── 1 · topics, before any story is stored ──────────────────────────────────────────────────
  result.topicsWritten = await seedTopics(ctx);
  ctx.log(`topics ~${String(result.topicsWritten)} of ${String(TOPIC_SEED.length)}`);

  // ── 2 · econ_series for BLS, before the POST body is built from the table ────────────────────
  await ensureEconSeries(tx, BLS_CPI_SERIES);

  // ── 3 · the economic series ─────────────────────────────────────────────────────────────────
  if (await sourceFullyIngested(ctx, 'fred.csv')) {
    result.legsAlreadyIngested += 1;
    ctx.log('fred: the DGS10 capture is already in provenance — nothing to do');
  } else {
    const fred = await runFredSeries({ ...jobCtx, seriesIds: FRED_SEEDED_SERIES });
    result.econObservationsInserted += fred.observationsInserted;
    ctx.log(
      `fred econ_observations +${String(fred.observationsInserted)} (${String(fred.series)} series)`,
    );
  }

  if (await sourceFullyIngested(ctx, 'bls.timeseries')) {
    result.legsAlreadyIngested += 1;
    ctx.log('bls: the CPI capture is already in provenance — nothing to do');
  } else {
    // `force` bypasses the two-slot daily gate (`blsFetchDecision`), which exists so production
    // polls BLS twice a day and not on every scheduler tick; a seed is neither.
    const bls = await runBlsSeries(jobCtx, {
      force: true,
      window: BLS_RECORDED_WINDOW,
      providerCodes: [BLS_CPI_SERIES.providerCode],
    });
    result.econObservationsInserted += bls.observations.inserted;
    ctx.log(`bls econ_observations +${String(bls.observations.inserted)}`);
  }

  if (await sourceFullyIngested(ctx, 'worldbank', 'imf.datamapper')) {
    result.legsAlreadyIngested += 1;
    ctx.log('worldbank/imf: both captures are already in provenance — nothing to do');
  } else {
    // `perPage` is the page size the World Bank capture was recorded at (§10.7: production uses
    // 100), and it is part of the URL, so it is part of the request key.
    const macro = await runWorldMacro(jobCtx, { perPage: WORLDBANK_RECORDED_PER_PAGE });
    result.econObservationsInserted +=
      macro.worldBank.observations.inserted + macro.imf.observations.inserted;
    if (macro.imf.noCapture.length > 0) {
      ctx.log(`imf: ${String(macro.imf.noCapture.length)} indicator(s) have no recorded capture`);
    }
    ctx.log(
      `worldbank+imf econ_observations +${String(
        macro.worldBank.observations.inserted + macro.imf.observations.inserted,
      )}`,
    );
  }

  // ── 4 · the release calendar ────────────────────────────────────────────────────────────────
  if (
    await capturesIngested(
      ctx,
      { sourceId: 'fred.calendar', url: FRED_CALENDAR_CONSUMED_URL },
      { sourceId: 'bls.schedule', url: BLS_SCHEDULE_CONSUMED_URL },
    )
  ) {
    result.legsAlreadyIngested += 1;
    ctx.log('econ calendar: both captures are already in provenance — nothing to do');
  } else {
    // One month, and the month the BLS schedule page was recorded for: asking for "current + next"
    // off the wall clock would request a page nothing recorded, and `econCalendar` would record the
    // miss as `noCapture` rather than fetch it.
    const calendar = await runEconCalendar(jobCtx, { from: BLS_SCHEDULE_MONTH, months: 1 });
    result.econReleasesInserted = calendar.fred.releases + calendar.bls.releases;
    result.econReleaseEventsInserted = calendar.fred.events + calendar.bls.events;
    ctx.log(
      `econ_releases +${String(result.econReleasesInserted)} ` +
        `econ_release_events +${String(result.econReleaseEventsInserted)}`,
    );
  }

  // ── 5 · fomc_meetings, from the curated fixture ──────────────────────────────────────────────
  result.fomcMeetingsWritten = await seedFomcMeetings(ctx);
  ctx.log(`fomc_meetings ~${String(result.fomcMeetingsWritten)} of 8`);

  // ── 6 · the stories, and then the bylines they carry ────────────────────────────────────────
  //
  // `feeds` names the five Bloomberg feeds that were recorded. `wealth` is the sixth of §11.1 and
  // has no capture; leaving it in would cost one `ReplayMissError` the job counts as "that feed did
  // not answer", which is true of production and misleading here.
  if (await sourceFullyIngested(ctx, 'bbg.rss', 'sec.atom', 'fed.rss')) {
    result.legsAlreadyIngested += 1;
    ctx.log('news: every bbg/sec.atom/fed.rss capture is already in provenance — nothing to do');
  } else {
    const news = await runNewsRss({
      ...jobCtx,
      feeds: ['markets', 'economics', 'politics', 'technology', 'industries'],
    });
    result.newsItemsInserted = news.inserted;
    result.newsLinksWritten = news.linked;
    ctx.log(
      `news_items +${String(news.inserted)} (${String(news.stories)} stories seen) ` +
        `news_entity_links +${String(news.linked)}, ${String(news.unlinked)} unlinked`,
    );
  }

  // §18 lists `sec-8k-atom.xml` under this module and a reader will look for the leg that reads it:
  // it is leg 6. `runNewsRss` polls the 8-K atom feed itself (`newsRss.ts` §2), so the forty filing
  // headlines land there. `ingest/jobs/secSubmissions.ts` has a second atom leg for the 60-second
  // production cadence, and calling it here would fetch the same capture again to store nothing.

  const peopleWritten = await seedPeople(ctx);
  result.peopleInserted = peopleWritten.inserted;
  ctx.log(
    `people +${String(peopleWritten.inserted)} (${String(peopleWritten.unchanged)} unchanged)`,
  );

  return result;
}

/** Module 11 of the ordered seed runner (`seed/index.ts`). */
export const newsSeedModule = {
  order: 11,
  name: 'news',
  run: seedNews,
} as const;
