/**
 * NEWS-07 — the alert engine (WORKPLAN WP-09 acceptance row).
 *
 * The row to prove is "a price alert fires once when `one_shot`, writes `alert_events` and reaches
 * `alerts:me`", and each clause is taken literally: **fires once** is asserted under repeated
 * deltas rather than one, **writes** is read back out of the table, and **reaches `alerts:me`** is
 * a frame arriving on a real socket held open by the production gateway, not a spy on a function.
 *
 * The other three kinds are here too — news on a saved search, filings on CIK/form/item, calendar
 * on `releaseId`/`minutesBefore` — because "fires exactly once" is a property of the engine, not
 * of the price path, and each kind dedupes on a different key.
 *
 * WP-15's seed does not exist: every firm, user, alert, release and session is created inside this
 * file's own transaction.
 */

import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type { QuoteFields, QuoteState } from '@terminal/core';
import { AlertEvent } from '@terminal/sdk/wire/rest/alerts';

import {
  alertEngine,
  attachAlertEngine,
  type AlertEngine,
  type AlertGateway,
} from '../../../src/alerts/engine.js';
import { getConfig } from '../../../src/config.js';
import type { NewsItem } from '../../../src/data/news.js';
import { buildPlant } from '../../../src/plant/tickerPlant.js';
import { testClock } from '../../../src/test/clock.js';
import { asAppRole, asUser, withTxDb } from '../../../src/test/db.js';
import {
  bootstrapProvenance,
  createWebSession,
  startWsApp,
  WsClient,
  type StartedWsApp,
} from '../ws/helpers.js';

const t = withTxDb();

const CLOCK_START = Date.parse('2026-09-15T18:41:28Z');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Owner {
  userId: number;
  firmId: number;
}

async function createOwner(): Promise<Owner> {
  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Alert Firm ${randomUUID().slice(0, 6)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name) VALUES ($1, $2, 'Alert Owner')
     RETURNING user_id`,
    [firmId, `alert-${randomUUID()}@demo.invalid`],
  );
  return { userId: Number(user.rows[0]!.user_id), firmId };
}

async function createAlert(
  owner: Owner,
  spec: {
    kind: 'price' | 'news' | 'filing' | 'calendar';
    instrumentId?: number;
    condition: Record<string, unknown>;
    oneShot?: boolean;
    delivery?: string[];
  },
): Promise<number> {
  const res = await t.client.query<{ alert_id: string }>(
    `INSERT INTO alerts (owner_user_id, firm_id, kind, instrument_id, condition, delivery, one_shot)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING alert_id`,
    [
      owner.userId,
      owner.firmId,
      spec.kind,
      spec.instrumentId ?? null,
      JSON.stringify(spec.condition),
      spec.delivery ?? ['inapp'],
      spec.oneShot ?? true,
    ],
  );
  return Number(res.rows[0]!.alert_id);
}

/** A plant composite as the gateway would hand it to the engine. */
function quoteState(instrumentId: number, fields: QuoteFields, seq = 1): QuoteState {
  return {
    subject: `q:${String(instrumentId)}`,
    instrumentId,
    assetClass: 'equity',
    seq,
    tier: 'delayed',
    delayMin: 15,
    fields,
    fieldTs: { PX_LAST: CLOCK_START },
    ts: { src: CLOCK_START, cap: CLOCK_START, pub: CLOCK_START },
    session: 'open',
    state: 'live',
    ageMs: 0,
    expectedIntervalMs: 10_000,
    prov: { sourceId: 'cboe.quotes', provenanceId: 0 },
    lines: {},
    dq: [],
  };
}

interface Captured {
  userId: number;
  frame: { t: string; alertId?: string; firedAt?: number; payload?: unknown };
}

function capturingGateway(sink: Captured[]): AlertGateway {
  return {
    sendToUser(userId, msg): number {
      sink.push({ userId, frame: msg });
      return 1;
    },
  };
}

function engineWith(sink: Captured[]): AlertEngine {
  return alertEngine({
    db: t.db,
    clock: testClock(CLOCK_START),
    gateway: capturingGateway(sink),
  });
}

async function eventsOf(
  alertId: number,
): Promise<{ payload: Record<string, unknown>; delivered: Record<string, unknown> }[]> {
  const res = await t.client.query<{
    payload: Record<string, unknown>;
    delivered: Record<string, unknown>;
  }>(`SELECT payload, delivered FROM alert_events WHERE alert_id = $1 ORDER BY event_id`, [
    alertId,
  ]);
  return res.rows;
}

async function statusOf(alertId: number): Promise<{ status: string; lastFiredAt: string | null }> {
  const res = await t.client.query<{ status: string; last_fired_at: string | null }>(
    `SELECT status, last_fired_at::text AS last_fired_at FROM alerts WHERE alert_id = $1`,
    [alertId],
  );
  return { status: res.rows[0]!.status, lastFiredAt: res.rows[0]!.last_fired_at };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Price alerts
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('NEWS-07 — price alerts on plant deltas', () => {
  it('fires a one_shot alert exactly once under repeated deltas, and records the firing', async () => {
    const owner = await createOwner();
    await asUser(t, owner.userId, owner.firmId);
    const instrumentId = 918_001;
    const alertId = await createAlert(owner, {
      kind: 'price',
      instrumentId,
      condition: { field: 'PX_LAST', op: '>=', value: 250 },
      oneShot: true,
    });

    const sink: Captured[] = [];
    const engine = engineWith(sink);
    const subject = `q:${String(instrumentId)}`;

    await engine.onPlantDelta(subject, quoteState(instrumentId, { PX_LAST: 249.5 }, 1));
    expect(await eventsOf(alertId)).toHaveLength(0);

    // Five deltas, all above the threshold. Exactly one firing.
    for (let i = 0; i < 5; i += 1) {
      await engine.onPlantDelta(
        subject,
        quoteState(instrumentId, { PX_LAST: 250.25 + i * 0.1 }, 2 + i),
      );
    }

    const events = await eventsOf(alertId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ value: 250.25 });
    expect(events[0]!.payload.summary).toBe('PX_LAST >= 250 (250.25)');
    expect(events[0]!.delivered).toEqual({ inapp: '2026-09-15T18:41:28.000Z' });

    const after = await statusOf(alertId);
    expect(after.status).toBe('fired');
    expect(after.lastFiredAt).not.toBeNull();

    expect(sink).toHaveLength(1);
    expect(sink[0]!.userId).toBe(owner.userId);
    expect(sink[0]!.frame.t).toBe('alert');
    expect(sink[0]!.frame.alertId).toBe(String(alertId));

    // The frame's payload is the REST `AlertEvent` verbatim, so live and replayed alerts share one
    // shape (API.md §6.9).
    const parsed = AlertEvent.parse(sink[0]!.frame.payload);
    expect(parsed.alertId).toBe(alertId);
    expect(parsed.payload.value).toBe(250.25);
    expect(parsed.acknowledgedAt).toBeNull();
    expect(engine.stats()).toMatchObject({ fired: 1, delivered: 1 });
  });

  it('fires a <= alert when the price falls through the level', async () => {
    const owner = await createOwner();
    await asUser(t, owner.userId, owner.firmId);
    const instrumentId = 918_002;
    const alertId = await createAlert(owner, {
      kind: 'price',
      instrumentId,
      condition: { field: 'PX_LAST', op: '<=', value: 100 },
    });
    const engine = engineWith([]);
    const subject = `q:${String(instrumentId)}`;

    await engine.onPlantDelta(subject, quoteState(instrumentId, { PX_LAST: 101 }));
    expect(await eventsOf(alertId)).toHaveLength(0);
    await engine.onPlantDelta(subject, quoteState(instrumentId, { PX_LAST: 99.5 }, 2));
    expect(await eventsOf(alertId)).toHaveLength(1);
  });

  it('needs two observations for `crosses`, and fires on the crossing in either direction', async () => {
    const owner = await createOwner();
    await asUser(t, owner.userId, owner.firmId);
    const instrumentId = 918_003;
    const alertId = await createAlert(owner, {
      kind: 'price',
      instrumentId,
      condition: { field: 'PX_LAST', op: 'crosses', value: 200 },
      oneShot: false,
    });
    const engine = engineWith([]);
    const subject = `q:${String(instrumentId)}`;

    // The first delta is already above the level: there is no observed crossing, so nothing fires.
    await engine.onPlantDelta(subject, quoteState(instrumentId, { PX_LAST: 205 }));
    expect(await eventsOf(alertId)).toHaveLength(0);

    await engine.onPlantDelta(subject, quoteState(instrumentId, { PX_LAST: 198 }, 2));
    expect(await eventsOf(alertId)).toHaveLength(1); // crossed down

    await engine.onPlantDelta(subject, quoteState(instrumentId, { PX_LAST: 197 }, 3));
    expect(await eventsOf(alertId)).toHaveLength(1); // still below: not a crossing

    await engine.onPlantDelta(subject, quoteState(instrumentId, { PX_LAST: 201 }, 4));
    expect(await eventsOf(alertId)).toHaveLength(2); // crossed up
    expect((await statusOf(alertId)).status).toBe('armed');
  });

  it('is edge-triggered when repeating: entry fires, dwelling does not, re-entry fires again', async () => {
    const owner = await createOwner();
    await asUser(t, owner.userId, owner.firmId);
    const instrumentId = 918_004;
    const alertId = await createAlert(owner, {
      kind: 'price',
      instrumentId,
      condition: { field: 'PX_LAST', op: '>=', value: 50 },
      oneShot: false,
    });
    const engine = engineWith([]);
    const subject = `q:${String(instrumentId)}`;

    await engine.onPlantDelta(subject, quoteState(instrumentId, { PX_LAST: 51 }));
    await engine.onPlantDelta(subject, quoteState(instrumentId, { PX_LAST: 52 }, 2));
    await engine.onPlantDelta(subject, quoteState(instrumentId, { PX_LAST: 53 }, 3));
    expect(await eventsOf(alertId)).toHaveLength(1);

    await engine.onPlantDelta(subject, quoteState(instrumentId, { PX_LAST: 49 }, 4));
    await engine.onPlantDelta(subject, quoteState(instrumentId, { PX_LAST: 51 }, 5));
    expect(await eventsOf(alertId)).toHaveLength(2);
  });

  it('ignores a paused alert, another instrument, an absent field and a non-quote subject', async () => {
    const owner = await createOwner();
    await asUser(t, owner.userId, owner.firmId);
    const instrumentId = 918_005;
    const paused = await createAlert(owner, {
      kind: 'price',
      instrumentId,
      condition: { field: 'PX_LAST', op: '>=', value: 1 },
    });
    await t.client.query(`UPDATE alerts SET status = 'paused' WHERE alert_id = $1`, [paused]);
    const other = await createAlert(owner, {
      kind: 'price',
      instrumentId: instrumentId + 1,
      condition: { field: 'PX_LAST', op: '>=', value: 1 },
    });
    const onVolume = await createAlert(owner, {
      kind: 'price',
      instrumentId,
      condition: { field: 'PX_VOLUME', op: '>=', value: 1 },
    });

    const engine = engineWith([]);
    await engine.onPlantDelta(
      `q:${String(instrumentId)}`,
      quoteState(instrumentId, { PX_LAST: 999 }),
    );
    await engine.onPlantDelta('n:all', quoteState(instrumentId, { PX_LAST: 999 }));

    expect(await eventsOf(paused)).toHaveLength(0);
    expect(await eventsOf(other)).toHaveLength(0);
    expect(await eventsOf(onVolume)).toHaveLength(0); // the delta carries no PX_VOLUME
    expect(engine.stats().skipped).toBeGreaterThan(0);
  });

  it('writes the firing under the shipped RLS policies, as terminal_app', async () => {
    const owner = await createOwner();
    const instrumentId = 918_006;
    const alertId = await createAlert(owner, {
      kind: 'price',
      instrumentId,
      condition: { field: 'PX_LAST', op: '>=', value: 10 },
    });

    // `alerts_owner` and `alert_events_owner` (migration 0015 L142-146) answer app_user_id(), so
    // the engine sees exactly what the transaction's context permits.
    await asUser(t, owner.userId, owner.firmId);
    await asAppRole(t);
    const engine = engineWith([]);
    await engine.onPlantDelta(
      `q:${String(instrumentId)}`,
      quoteState(instrumentId, { PX_LAST: 11 }),
    );

    const res = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM alert_events WHERE alert_id = $1`,
      [alertId],
    );
    expect(Number(res.rows[0]!.n)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// alerts:me over a real socket
// ─────────────────────────────────────────────────────────────────────────────────────────────

let live: { app: StartedWsApp; client: WsClient } | null = null;

afterEach(async () => {
  if (live === null) return;
  await live.client.close();
  await live.app.close();
  live = null;
});

describe('NEWS-07 — the alerts:me fan-out', () => {
  it('reaches the owner’s open session as an `alert` frame', async () => {
    const clock = testClock(CLOCK_START);
    const plant = buildPlant({ config: getConfig(), clock });
    const session = await createWebSession(t);
    await asUser(t, session.userId, session.firmId);

    const instrumentId = 918_010;
    const alertId = await createAlert(
      { userId: session.userId, firmId: session.firmId },
      {
        kind: 'price',
        instrumentId,
        condition: { field: 'PX_LAST', op: '>=', value: 250 },
        delivery: ['inapp', 'email'],
      },
    );

    const app = await startWsApp({ t, clock, plant });
    const client = new WsClient(app.url, { cookie: session.cookie });
    await client.open();
    live = { app, client };
    client.send({ t: 'hello', protocol: 1, client: 'web/0.1.0' });
    await client.next((f) => f.t === 'welcome');

    // The gateway's own `sendToUser` is the `alerts:me` fan-out (API.md §6.9, gateway L119).
    const engine = alertEngine({ db: t.db, clock, gateway: app.app.wsGateway });
    await engine.onPlantDelta(
      `q:${String(instrumentId)}`,
      quoteState(instrumentId, { PX_LAST: 251.5 }),
    );

    const frame = await client.next((f) => f.t === 'alert');
    expect(frame.t).toBe('alert');
    const alert = frame as { alertId: string; firedAt: number; payload: unknown };
    expect(alert.alertId).toBe(String(alertId));
    expect(alert.firedAt).toBe(CLOCK_START);

    const parsed = AlertEvent.parse(alert.payload);
    expect(parsed.payload.value).toBe(251.5);
    // `email` was requested and is a recorded intent in v1: null, never a timestamp for a
    // delivery that did not happen.
    expect(parsed.delivered).toEqual({ inapp: '2026-09-15T18:41:28.000Z', email: null });
    expect(engine.stats().delivered).toBe(1);
  });

  it('reaches alerts:me through the real wiring, driven by a plant delta', async () => {
    const clock = testClock(CLOCK_START);
    const plant = buildPlant({ config: getConfig(), clock });
    const session = await createWebSession(t);
    await asUser(t, session.userId, session.firmId);

    const instrumentId = 918_011;
    const alertId = await createAlert(
      { userId: session.userId, firmId: session.firmId },
      {
        kind: 'price',
        instrumentId,
        condition: { field: 'PX_LAST', op: '>=', value: 250 },
      },
    );

    const app = await startWsApp({ t, clock, plant });
    const client = new WsClient(app.url, { cookie: session.cookie });
    await client.open();
    live = { app, client };
    client.send({ t: 'hello', protocol: 1, client: 'web/0.1.0' });
    await client.next((f) => f.t === 'welcome');

    // `attachAlertEngine` is what `index.ts` calls. Until it existed `alertEngine` was constructed
    // nowhere but in tests — `grep -rn alertEngine src` matched only its own definition — so
    // NEWS-07 alerts never fired in a running server no matter how correct the engine was. This
    // asserts the wiring, not the engine: nothing below calls `onPlantDelta` by hand.
    const runtime = attachAlertEngine({
      plant,
      clock,
      gateway: app.app.wsGateway,
      // The test transaction *is* the handle, as everywhere else in this file; in the server it is
      // `withTx(null, fn)`, one transaction per delta.
      withTx: (fn) => fn(t.db),
      calendarTickMs: 0,
    });

    plant.publish(
      `q:${String(instrumentId)}`,
      { PX_LAST: 251.5 },
      {
        ts: { src: CLOCK_START, cap: CLOCK_START, pub: CLOCK_START },
        assetClass: 'equity',
        session: 'open',
        state: 'live',
      },
    );

    const frame = await client.next((f) => f.t === 'alert');
    const alert = frame as { alertId: string };
    expect(alert.alertId).toBe(String(alertId));
    expect(runtime.stats().fired).toBe(1);

    // …and the runtime leaves no timer behind, so `npm test` still exits on its own.
    await runtime.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// News, filing and calendar alerts
// ─────────────────────────────────────────────────────────────────────────────────────────────

function newsItem(spec: Partial<NewsItem> & { newsId: number; headline: string }): NewsItem {
  return {
    sourceId: 'bbg.rss',
    feed: 'markets',
    kind: 'story',
    summary: null,
    url: 'https://example.invalid/story',
    author: null,
    category: null,
    cik: null,
    items8k: null,
    lang: 'en',
    publishedAt: '2026-09-15T18:30:00.000Z',
    capturedAt: '2026-09-15T18:31:00.000Z',
    isCorrection: false,
    machineGenerated: false,
    provenanceId: 1,
    sourceTs: null,
    links: [],
    ...spec,
  };
}

describe('NEWS-07 — news alerts on a saved search', () => {
  it('fires on a matching story, once per story, and not on a story that misses a clause', async () => {
    const owner = await createOwner();
    await asUser(t, owner.userId, owner.firmId);
    const instrumentId = 918_020;

    const saved = await t.client.query<{ search_id: string }>(
      `INSERT INTO saved_searches (owner_user_id, firm_id, kind, name, query)
       VALUES ($1, $2, 'news', 'Apple on markets', $3::jsonb) RETURNING search_id`,
      [
        owner.userId,
        owner.firmId,
        JSON.stringify({ text: 'buyback', instrumentIds: [instrumentId], feeds: ['markets'] }),
      ],
    );
    const alertId = await createAlert(owner, {
      kind: 'news',
      condition: { savedSearchId: Number(saved.rows[0]!.search_id) },
      oneShot: false,
    });

    const engine = engineWith([]);
    const linked = [
      {
        entityKind: 'instrument' as const,
        entityId: instrumentId,
        display: 'AAPL US Equity',
        confidence: 1,
        method: 'ticker_exact' as const,
      },
    ];

    await engine.onNews(
      newsItem({ newsId: 5_001, headline: 'Apple announces a $90bn buyback', links: linked }),
    );
    expect(await eventsOf(alertId)).toHaveLength(1);
    expect((await eventsOf(alertId))[0]!.payload).toMatchObject({
      newsId: 5_001,
      summary: 'Apple announces a $90bn buyback',
    });

    // The same story again (a re-ingest, a correction pass) must not re-notify.
    await engine.onNews(
      newsItem({ newsId: 5_001, headline: 'Apple announces a $90bn buyback', links: linked }),
    );
    expect(await eventsOf(alertId)).toHaveLength(1);

    // Right words, wrong feed.
    await engine.onNews(
      newsItem({
        newsId: 5_002,
        headline: 'Apple announces a buyback',
        feed: 'technology',
        links: linked,
      }),
    );
    // Right feed and instrument, wrong words.
    await engine.onNews(
      newsItem({ newsId: 5_003, headline: 'Apple names a new CFO', links: linked }),
    );
    // Right words and feed, not linked to the instrument.
    await engine.onNews(newsItem({ newsId: 5_004, headline: 'Another buyback elsewhere' }));
    expect(await eventsOf(alertId)).toHaveLength(1);
  });

  it('refuses a savedSearchId that belongs to another owner', async () => {
    const victim = await createOwner();
    const attacker = await createOwner();
    const instrumentId = 918_021;

    await asUser(t, victim.userId, victim.firmId);
    const saved = await t.client.query<{ search_id: string }>(
      `INSERT INTO saved_searches (owner_user_id, firm_id, kind, name, query)
       VALUES ($1, $2, 'news', 'Project Nova', $3::jsonb) RETURNING search_id`,
      [
        victim.userId,
        victim.firmId,
        JSON.stringify({ text: 'Project Nova', instrumentIds: [instrumentId] }),
      ],
    );

    // The engine is a system-wide fan-out, so `criteriaFor` used to select `saved_searches` by
    // `search_id` alone — an id, with no owner predicate, on a handle that can see every row. An
    // alert could therefore name any user's private search and be evaluated against it, which
    // leaks what a rival desk is watching for the moment a matching headline lands.
    await asUser(t, attacker.userId, attacker.firmId);
    const alertId = await createAlert(attacker, {
      kind: 'news',
      condition: { savedSearchId: Number(saved.rows[0]!.search_id) },
      oneShot: false,
    });

    const engine = engineWith([]);
    await engine.onNews(
      newsItem({
        newsId: 5_101,
        headline: 'Project Nova prices at 42',
        links: [
          {
            entityKind: 'instrument' as const,
            entityId: instrumentId,
            display: 'NOVA US Equity',
            confidence: 1,
            method: 'ticker_exact' as const,
          },
        ],
      }),
    );
    expect(await eventsOf(alertId)).toEqual([]);

    // …and the victim's own alert on their own search still fires, so this is an owner check and
    // not the criteria path going dark.
    await asUser(t, victim.userId, victim.firmId);
    const ownAlertId = await createAlert(victim, {
      kind: 'news',
      condition: { savedSearchId: Number(saved.rows[0]!.search_id) },
      oneShot: false,
    });
    await engineWith([]).onNews(
      newsItem({
        newsId: 5_102,
        headline: 'Project Nova prices at 42',
        links: [
          {
            entityKind: 'instrument' as const,
            entityId: instrumentId,
            display: 'NOVA US Equity',
            confidence: 1,
            method: 'ticker_exact' as const,
          },
        ],
      }),
    );
    expect(await eventsOf(ownAlertId)).toHaveLength(1);
  });
});

describe('NEWS-07 — filing alerts', () => {
  it('matches on CIK, form and 8-K item, and dedupes on the accession number', async () => {
    const owner = await createOwner();
    await asUser(t, owner.userId, owner.firmId);
    const alertId = await createAlert(owner, {
      kind: 'filing',
      condition: { ciks: ['320193'], forms: ['8-K'], items: ['2.02'] },
      oneShot: false,
    });
    const engine = engineWith([]);

    // The CIK is stored unpadded in the condition and padded in the filing: both normalise.
    await engine.onFiling({
      accessionNo: '0000320193-26-000020',
      cik: '0000320193',
      form: '8-K',
      items: ['2.02', '9.01'],
      filedDate: '2026-09-15',
    });
    expect(await eventsOf(alertId)).toHaveLength(1);
    expect((await eventsOf(alertId))[0]!.payload).toMatchObject({
      accessionNo: '0000320193-26-000020',
      summary: '8-K filed 2026-09-15',
    });

    await engine.onFiling({
      accessionNo: '0000320193-26-000020',
      cik: '0000320193',
      form: '8-K',
      items: ['2.02'],
      filedDate: '2026-09-15',
    });
    expect(await eventsOf(alertId)).toHaveLength(1);

    // Same filer, wrong form.
    await engine.onFiling({
      accessionNo: '0000320193-26-000021',
      cik: '0000320193',
      form: '10-Q',
      items: null,
      filedDate: '2026-09-16',
    });
    // Right form, wrong item.
    await engine.onFiling({
      accessionNo: '0000320193-26-000022',
      cik: '0000320193',
      form: '8-K',
      items: ['5.02'],
      filedDate: '2026-09-17',
    });
    // Right form and item, another filer.
    await engine.onFiling({
      accessionNo: '0000789019-26-000001',
      cik: '0000789019',
      form: '8-K',
      items: ['2.02'],
      filedDate: '2026-09-17',
    });
    expect(await eventsOf(alertId)).toHaveLength(1);
  });
});

describe('NEWS-07 — calendar alerts', () => {
  it('fires inside the minutesBefore window, once per event, and not before it', async () => {
    const owner = await createOwner();
    await asUser(t, owner.userId, owner.firmId);
    const provenanceId = await bootstrapProvenance(t, 'fred.calendar', 'econ-release');

    const release = await t.client.query<{ release_id: string }>(
      `INSERT INTO econ_releases (source_id, provider_release_id, name)
       VALUES ('fred.calendar', $1, 'Consumer Price Index') RETURNING release_id`,
      [`cpi-${randomUUID().slice(0, 8)}`],
    );
    const releaseId = Number(release.rows[0]!.release_id);
    const scheduledAt = new Date(CLOCK_START + 20 * 60_000).toISOString();
    const event = await t.client.query<{ event_id: string }>(
      `INSERT INTO econ_release_events (release_id, scheduled_at, period_label, provenance_id)
       VALUES ($1, $2::timestamptz, 'August 2026', $3) RETURNING event_id`,
      [releaseId, scheduledAt, provenanceId],
    );
    const eventId = Number(event.rows[0]!.event_id);

    const alertId = await createAlert(owner, {
      kind: 'calendar',
      condition: { releaseId, minutesBefore: 15 },
      oneShot: false,
    });
    const engine = engineWith([]);

    // 20 minutes out: outside the 15-minute window.
    await engine.onCalendarTick(CLOCK_START);
    expect(await eventsOf(alertId)).toHaveLength(0);

    // 10 minutes out: inside it.
    await engine.onCalendarTick(CLOCK_START + 10 * 60_000);
    const events = await eventsOf(alertId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ eventId });
    expect(events[0]!.payload.summary).toContain('Consumer Price Index');

    // Every tick after it is still inside the window; the event fires once.
    await engine.onCalendarTick(CLOCK_START + 11 * 60_000);
    await engine.onCalendarTick(CLOCK_START + 12 * 60_000);
    expect(await eventsOf(alertId)).toHaveLength(1);

    // A released event is no longer scheduled and never fires again.
    await t.client.query(`UPDATE econ_release_events SET status = 'released' WHERE event_id = $1`, [
      eventId,
    ]);
    await engine.onCalendarTick(CLOCK_START + 13 * 60_000);
    expect(await eventsOf(alertId)).toHaveLength(1);
  });
});
