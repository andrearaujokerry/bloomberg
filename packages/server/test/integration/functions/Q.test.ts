/**
 * `test/integration/functions/Q.test.ts` — WP-09's acceptance row for `Q`
 * (WORKPLAN §WP-09: "composite + per-line view with all three timestamps (FEED-05) and the BUS-05
 * merge visible").
 *
 * The three things this file is about, and why each needs a *two-line* fixture:
 *
 *  1. **The composite.** One number per field, gated by the caller's entitlement decision.
 *  2. **The per-line view with all three timestamps.** FEED-05 says every value carries
 *     source-published, captured and published-to-you. A single-line fixture proves nothing about
 *     the third: with one source the composite's instants and the line's are the same object.
 *  3. **The merge, visible.** BUS-05 composes `PX_LAST` from the freshest line and
 *     `PX_OPEN`/`PX_CLOSE_1D` from the *primary* one. Two lines that disagree — a fresher, lower
 *     priority Yahoo line against an older, primary Cboe line — is the only fixture where "which
 *     line won this field" has a non-trivial answer, and `lines[i].wonFields` is asserted to give
 *     it for both directions at once.
 *
 * ## The clock, and why it is the capture instant
 *
 * `GOLDEN_CAPTURE_MS` (2026-09-15T18:41:28Z) is the frozen golden clock. The plant is built on it,
 * so a quote stamped at that instant is `live` rather than three days stale; the request's
 * `asOf.validAt` is the same instant, so the payload — and the committed golden — do not move.
 * `asOf.knownAt` is the *real* instant the fixture rows were written at, because a bitemporal read
 * at a `knownAt` earlier than `tx_from` sees none of them (TESTING §4.3).
 *
 * ## No seed
 *
 * WP-15 owns the seed and it does not exist. Every firm, user, grant, instrument, line, calendar,
 * exchange and tick here is created inside this file's own `withTxDb()` transaction, and nothing
 * depends on a literal instrument id — the golden is compared after the ids are normalised to
 * stable tokens, which is what makes it a golden rather than a snapshot of one run's sequences.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, idToken, subjectToken } from './golden.js';

import type { NormalisedUpdate } from '@terminal/core';
import { FunctionRegistry } from '@terminal/core';
import { XNAS } from '@terminal/core/calendars/nyse';
import { Q } from '@terminal/core/functions/manifests/Q';
import type { QPayload } from '@terminal/core/functions/manifests/Q';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as QModule from '../../../src/functions/Q/resolve.js';
import { materialiseCalendar } from '../../../src/refdata/calendars.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { readNormalised } from '../../../src/test/fixtures.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS, seedQuoteInstrument } from '../ws/helpers.js';

/**
 * `fixtures/providers/normalised/cboe-quote-AAPL.json`, the recorded poll FUNCTIONS_TIER1 §0.7
 * names behind the equity variant — the normaliser's own output plus the rows it produced.
 */
interface CboeQuoteFixture {
  updates: NormalisedUpdate[];
  rows: {
    quoteTicks: {
      srcSeq: number | null;
      price: number;
      size: number | null;
      bid: number | null;
      ask: number | null;
      tickDir: string | null;
      conditions: string[];
    }[];
  };
}

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const VALID_FROM = new Date('2020-01-01T00:00:00Z');

/**
 * `md_lines_symbol_excl` makes `(source_id, provider_symbol)` a GLOBAL namespace — "a provider
 * symbol feeds at most one line at a time" — and `server-int` runs four forks against one
 * database. Two open transactions inserting the same symbol therefore wait on each other's
 * exclusion check, and two such waits in opposite order are a deadlock. Every symbol this file
 * seeds carries a per-run suffix so no other suite can be on the other side of that wait;
 * `normalise` strips it again, so the golden still reads `AAPL`.
 */
const SYMBOL_TAG = `.t${randomUUID().slice(0, 8)}`;
const sym = (base: string): string => `${base}${SYMBOL_TAG}`;

/** The golden lives beside the fixtures, not in the test: a golden a test writes proves nothing. */
const GOLDEN_NAME = 'Q.quote.json';

const REGISTRY = new FunctionRegistry([Q]);

const MODULES: Record<string, FunctionServerModule<any, any>> = { Q: QModule };

const t: TestDb = withTxDb();

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  knownAt: string;
  instrumentId: number;
  cboeLineId: number;
  yahooLineId: number;
  cboeProv: number;
  yahooProv: number;
}

let env: Env;

async function ensureLicences(): Promise<void> {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);
}

/**
 * A grant per source, for the firm and for the user.
 *
 * Evaluator rules 4 and 5 need both, and a manifest's pre-check asks about every field it declares
 * — so granting one source would turn a missing *contract* into a blanked column and make this
 * file a test of entitlements rather than of Q. Entitlement blanking has its own acceptance row.
 */
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

function update(spec: {
  instrumentId: number;
  mdLineId: number;
  sourceId: string;
  provenanceId: number;
  srcMs: number;
  fields: NormalisedUpdate['fields'];
  srcSeq?: number;
}): NormalisedUpdate {
  return {
    subject: `q:${String(spec.instrumentId)}`,
    instrumentId: spec.instrumentId,
    mdLineId: spec.mdLineId,
    assetClass: 'equity',
    tier: 'delayed',
    fields: spec.fields,
    ts: { src: spec.srcMs, cap: GOLDEN_CAPTURE_MS, pub: 0 },
    prov: {
      sourceId: spec.sourceId,
      provenanceId: spec.provenanceId,
      ...(spec.srcSeq === undefined ? {} : { srcSeq: spec.srcSeq }),
    },
  };
}

beforeEach(async () => {
  await ensureLicences();

  // The venue, so `venueCalendar` has something to join through. Neither table is seeded by the
  // harness: `exchanges` is plain reference data and `calendars` is materialised per year range.
  //
  // **Exactly one calendar, over exactly one year.** `calendars`, `calendar_sessions`,
  // `calendar_holidays` and `exchanges` are shared, and `server-int` runs four forks against one
  // database: two transactions inserting the same primary key block each other until one of them
  // rolls back, and a wide year range holds those locks for the length of the whole file. Seeding
  // the narrowest thing this file actually reads keeps that window to a few rows, and touching a
  // calendar no other function suite touches keeps the two from meeting at all.
  await materialiseCalendar(t.db, XNAS, { fromYear: 2026, toYear: 2026 });
  await t.client.query(
    `INSERT INTO exchanges (mic, operating_mic, name, country, tz, calendar_id)
     VALUES ('XNAS', 'XNAS', 'Nasdaq', 'US', 'America/New_York', 'XNAS')
     ON CONFLICT (mic) DO NOTHING`,
  );

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Q Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'Q User', 'user') RETURNING user_id`,
    [firmId, `q-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  await grantEverySource(firmId, userId);

  const seeded = await seedQuoteInstrument(t, {
    ticker: 'AAPL',
    name: 'Apple Inc',
    sourceId: 'cboe.quotes',
    providerSymbol: sym('AAPL'),
    priority: 10,
  });

  // The second line: same instrument, a different provider, a higher priority number. This is the
  // fixture the merge is visible in.
  const yahooProv = await bootstrapProvenance(t, 'yahoo.chart', 'q-yahoo');
  const { mdLineId: yahooLineId } = await masterRepositories(t.db).mdLines.upsertBySymbol(
    {
      instrumentId: seeded.instrumentId,
      listingId: seeded.listingId,
      sourceId: 'yahoo.chart',
      providerSymbol: sym('AAPL'),
      lineKind: 'venue',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 60_000,
      priority: 20,
    },
    { validFrom: VALID_FROM, provenanceId: yahooProv },
  );
  const cboeProv = await bootstrapProvenance(t, 'cboe.quotes', 'q-cboe');

  // The tape, from the capture. `fixtures/providers/normalised/cboe-quote-AAPL.json` records one
  // poll, so the newest row is the recorded `quoteTicks[0]` verbatim — price, size, bid, ask,
  // `srcSeq`, conditions and all — and the two older rows are the same shape at earlier instants
  // with earlier sequence numbers. Nothing is typed by hand.
  //
  // In particular `size` is `null`: `cboe.quotes` publishes no last size at all. The golden used
  // to show a 100-share print, and a tape row with a size no source ever reported is a fabricated
  // number on a screen whatever else is right about it.
  const captured = (await readNormalised<CboeQuoteFixture>('cboe-quote-AAPL')).rows.quoteTicks[0]!;
  for (const [offset, price, kind] of [
    [-120_000, 330.2, 'trade'],
    [-60_000, 330.25, 'quote'],
    [0, captured.price, 'trade'],
  ] as const) {
    await t.client.query(
      `INSERT INTO quote_ticks (capture_ts, instrument_id, md_line_id, kind, source_ts, publish_ts,
                                src_seq, price, size, bid, ask, tick_dir, conditions, provenance_id)
       VALUES ($1::timestamptz, $2, $3, $4, $1::timestamptz, $1::timestamptz, $5, $6, $7,
               $8, $9, $10, $11::text[], $12)`,
      [
        new Date(GOLDEN_CAPTURE_MS + offset).toISOString(),
        seeded.instrumentId,
        seeded.mdLineId,
        kind,
        (captured.srcSeq ?? 0) + offset / 1_000,
        price,
        captured.size,
        captured.bid,
        captured.ask,
        captured.tickDir,
        captured.conditions,
        cboeProv,
      ],
    );
  }

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  // The plant's clock IS the capture instant, so the fixture quote is `live` and not `stale`.
  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };

  const capturedUpdate = (await readNormalised<CboeQuoteFixture>('cboe-quote-AAPL')).updates[0]!;

  // Cboe first (primary, older source ts), then Yahoo (fresher). PX_LAST goes to the fresher line;
  // PX_OPEN and PX_CLOSE_1D stay with the primary one.
  harness.deps.plant.apply(
    update({
      instrumentId: seeded.instrumentId,
      mdLineId: seeded.mdLineId,
      sourceId: 'cboe.quotes',
      provenanceId: cboeProv,
      srcMs: GOLDEN_CAPTURE_MS - 900_000,
      srcSeq: capturedUpdate.prov.srcSeq ?? 0,
      // The recorded normaliser output, field for field. Retyping it is how `IVOL_30D` came to be
      // 24.43 against the capture's 24.427, and how a `LAST_SIZE` appeared for a source that
      // publishes none: a golden that does not descend from the capture proves self-consistency
      // and nothing about provider → payload fidelity.
      fields: { ...capturedUpdate.fields },
    }),
  );
  harness.deps.plant.apply(
    update({
      instrumentId: seeded.instrumentId,
      mdLineId: yahooLineId,
      sourceId: 'yahoo.chart',
      provenanceId: yahooProv,
      srcMs: GOLDEN_CAPTURE_MS - 60_000,
      fields: { PX_LAST: 330.18, PX_VOLUME: 17_500_000, PX_OPEN: 330.11 },
    }),
  );

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    knownAt,
    instrumentId: seeded.instrumentId,
    cboeLineId: seeded.mdLineId,
    yahooLineId,
    cboeProv,
    yahooProv,
  };
});

afterEach(async () => {
  await env.harness.close();
});

async function runQ(params: Record<string, unknown> = {}): Promise<QPayload> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/Q/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      security: { id: env.instrumentId },
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<{ data: QPayload }>().data;
}

/**
 * Ids the database hands out are sequence values, so the golden is compared after they are
 * replaced by stable tokens. Everything else in the payload — prices, timestamps, states,
 * provenance indices — is asserted verbatim.
 */
/**
 * The keys of a Q payload that hold a sequence-allocated id (§Q `QLine`, `ResolvedRef`).
 * `mdLineIds` is an array of them, which `idToken` maps element-wise; `sourceId`
 * (`'cboe.quotes'`) and `calendarId` (`'XNAS'`) are names, and `srcSeq`, `priority` and `provIdx`
 * are the payload's own small integers.
 */
const ID_KEYS: ReadonlySet<string> = new Set([
  'instrumentId',
  'primaryListingId',
  'mdLineId',
  'mdLineIds',
]);

function normalise(payload: QPayload): unknown {
  const tokens = new Map<number, string>([
    [env.instrumentId, '<AAPL>'],
    [env.cboeLineId, '<CBOE_LINE>'],
    [env.yahooLineId, '<YAHOO_LINE>'],
  ]);
  const json = JSON.stringify(payload, (key, value: unknown) => {
    // The per-run provider-symbol suffix is stripped; the ids are substituted in subject strings
    // only (`subjectToken`), never in a timestamp that happens to contain their digits.
    if (typeof value === 'string') return subjectToken(value.split(SYMBOL_TAG).join(''), tokens);
    // And in numbers only under a key that names an id. Every whole number Q publishes was a
    // candidate under the old value-based rule — `srcSeq`, `priority`, `provIdx`,
    // `intrinsicDelayMin`, `expectedIntervalMs`, a size, a volume, a round price — and a quote
    // golden that renames a sequence number as `<CBOE_LINE>` has stopped pinning the quote.
    return idToken(key, value, ID_KEYS, tokens);
  });
  return JSON.parse(json);
}

describe('Q — composite, lines and the BUS-05 merge', () => {
  it('shows the composite and every line with all three FEED-05 timestamps', async () => {
    const payload = await runQ();

    expect(payload.variant).toBe('quote');
    expect(payload.instrument.display).toBe('AAPL US Equity');
    // BUS-05: the FRESHEST line supplies the trade block, not the primary one — the Yahoo line's
    // source ts is fourteen minutes newer than Cboe's, so 330.18 is the composite's last price
    // even though Cboe is the primary line. That is the merge doing its job, and asserting the
    // Cboe price here would be asserting that it does not.
    expect(payload.composite.PX_LAST?.v).toBe(330.18);
    expect(payload.composite.PX_LAST?.st).toBe('live');
    // The primary line still supplies the session's open and the prior close.
    expect(payload.composite.PX_OPEN?.v).toBe(330.24);
    expect(payload.composite.PX_CLOSE_1D?.v).toBe(333.08);
    expect(payload.composite.PX_LAST?.live).toEqual({
      subject: `q:${String(env.instrumentId)}`,
      field: 'PX_LAST',
    });

    // FEED-05: three instants on the composite and on every line, all ISO-8601.
    expect(payload.compositeTs.cap).toBe(GOLDEN_ISO);
    expect(payload.compositeTs.pub).toBe(GOLDEN_ISO);
    expect(payload.compositeTs.src).toBe(new Date(GOLDEN_CAPTURE_MS - 60_000).toISOString());

    expect(payload.lines).toHaveLength(2);
    for (const line of payload.lines) {
      expect(typeof line.ts.cap).toBe('string');
      expect(typeof line.ts.pub).toBe('string');
      expect(line.ts.src).not.toBeNull();
      expect(line.subject).toBe(`l:${String(line.mdLineId)}`);
    }

    const cboe = payload.lines.find((l) => l.sourceId === 'cboe.quotes')!;
    const yahoo = payload.lines.find((l) => l.sourceId === 'yahoo.chart')!;
    expect(cboe.srcSeq).toBe(15_972_883_317);
    expect(cboe.ts.src).toBe(new Date(GOLDEN_CAPTURE_MS - 900_000).toISOString());
    expect(yahoo.ts.src).toBe(new Date(GOLDEN_CAPTURE_MS - 60_000).toISOString());
    // The two lines disagree on PX_LAST — which is the point of the fixture.
    expect(cboe.cells.PX_LAST?.v).toBe(330.27);
    expect(yahoo.cells.PX_LAST?.v).toBe(330.18);
  });

  it('shows which line won each field (BUS-05)', async () => {
    const payload = await runQ();
    const cboe = payload.lines.find((l) => l.sourceId === 'cboe.quotes')!;
    const yahoo = payload.lines.find((l) => l.sourceId === 'yahoo.chart')!;

    // The freshest line supplies the trade block; the primary line supplies open and prior close.
    expect(yahoo.wonFields).toContain('PX_LAST');
    expect(cboe.wonFields).toContain('PX_OPEN');
    expect(cboe.wonFields).toContain('PX_CLOSE_1D');
    expect(cboe.wonFields).not.toContain('PX_LAST');
    expect(yahoo.wonFields).not.toContain('PX_OPEN');

    // Every won field's value IS the composite's, on every line: the claim is checkable, not a label.
    for (const line of payload.lines) {
      for (const field of line.wonFields) {
        expect(line.cells[field]?.v).toBe(payload.composite[field]?.v);
      }
    }
    // And no field is claimed by two lines at once.
    const claimed = payload.lines.flatMap((l) => l.wonFields);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('reports top of book, the session and the tape, and says what is missing', async () => {
    const payload = await runQ({ depth: 5 });

    expect(payload.book.depthRequested).toBe(5);
    expect(payload.book.depthAvailable).toBe(1);
    expect(payload.book.reason).toBe('DEPTH_UNAVAILABLE_SOURCE');
    expect(payload.book.bids[0]?.px).toBe(330.25);
    expect(payload.book.asks[0]?.px).toBe(330.28);

    expect(payload.session?.calendarId).toBe('XNAS');
    expect(payload.session?.tz).toBe('America/New_York');
    expect(payload.session?.state).toBe('open');

    // Newest first, and the conditions the v1 poll writes are carried through (FEED-07) — as the
    // capture wrote them, which is `['delayed']` and no tick direction. `cboe.quotes` publishes no
    // last size either, so the tape's `size` is null rather than a 100-share print nobody reported.
    expect(payload.tape).toHaveLength(3);
    expect(payload.tape[0]?.capTs).toBe(GOLDEN_ISO);
    expect(payload.tape[0]?.price).toBe(330.27);
    expect(payload.tape[2]?.price).toBe(330.2);
    expect(payload.tape[0]?.conditions).toEqual(['delayed']);
    expect(payload.tape[0]?.tickDir).toBeNull();
    expect(payload.tape[0]?.size).toBeNull();
    expect(payload.tape[0]?.srcSeq).toBe(15_972_883_317);

    expect(payload.compositionRules.length).toBeGreaterThan(0);
  });

  it('raises LAST_OUTSIDE_BOOK when the BUS-05 merge splits the last from the book', async () => {
    const payload = await runQ();

    // BUS-05 takes the trade block from the freshest line publishing `PX_LAST` (yahoo, 330.18) and
    // the book from the freshest line publishing `PX_BID` (cboe, 330.25/330.28), so the composite
    // shows a last seven cents BELOW its own bid while both lines are individually correct.
    // `CROSS_SOURCE_DIVERGENCE` only fires past 0.5 % and |330.27−330.18|/330.18 is 0.027 %, so
    // nothing used to report it — and a last outside the book is far more visible than a 0.5 %
    // disagreement.
    expect(payload.composite.PX_LAST?.v).toBe(330.18);
    expect(payload.book.bids[0]?.px).toBe(330.25);
    expect(payload.dq).toContain('LAST_OUTSIDE_BOOK');
  });

  it('carries every absent value with a reason in meta.unavailable', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `${API}/functions/Q/run`,
      headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
      payload: {
        params: { depth: 5 },
        security: { id: env.instrumentId },
        asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const meta = res.json<{ meta: { unavailable: { field: string; reason: string }[] } }>().meta;
    const fields = meta.unavailable.map((u) => u.field);
    expect(fields).toContain('composite.VWAP');
    expect(fields).toContain('book');
    for (const note of meta.unavailable) {
      expect(['NO_SOURCE', 'NOT_LICENSED', 'NOT_APPLICABLE']).toContain(note.reason);
    }
  });

  it('declares a live spec whose subjects are the composite and every line', async () => {
    const payload = await runQ();
    const live = Q.live!({ depth: 5, tapeRows: 30, view: 'composite' }, payload)!;
    expect(live.subjects[0]).toBe(`q:${String(env.instrumentId)}`);
    expect(live.subjects).toContain(`l:${String(env.cboeLineId)}`);
    expect(live.subjects).toContain(`l:${String(env.yahooLineId)}`);
    expect(live.conflationMs).toBe(100);
    expect(live.essential).toEqual([`q:${String(env.instrumentId)}`]);
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    const payload = await runQ();
    expectGolden(GOLDEN_NAME, normalise(payload));
  });
});
