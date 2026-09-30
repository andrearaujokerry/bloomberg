/**
 * `test/integration/entitlements/wsQuota.test.ts` — the two API-06/API-01 rules the WebSocket
 * enforces on behalf of WP-07, over a real socket (API.md §8 L1143, §1.1 "API keys").
 *
 * Both were reported as absent by the adversarial audit, and both are the kind of control that
 * reads as implemented until someone measures it:
 *
 *  1. **The concurrent-subscription ceiling comes from `quota_limits`,** user row then firm row,
 *     and the host's `WsLimits` only when neither exists. Enforcement used to be the hardcoded
 *     default, so an explicit `quota_limits.concurrent_subscriptions` row was silently ignored.
 *  2. **An api session over the ceiling is rejected `QUOTA_EXCEEDED`, not `LIMIT`.** §8's table
 *     spells both codes out and gives `LIMIT` to the web ceiling alone.
 *  3. **`ws:subscribe` is a scope, and a key minted without it cannot subscribe.** The scope was
 *     documented as enforced by the gateway's `sub` path and was checked nowhere at all.
 *
 * Self-sufficient: the firm, the users, the sessions, the api keys, the instrument and the
 * `quota_limits` rows are all created inside this file's own `withTxDb()` transaction, which is
 * also the app's database handle.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { ServerMsg } from '@terminal/sdk/wire/ws';

import { getConfig } from '../../../src/config.js';
import { buildPlant } from '../../../src/plant/tickerPlant.js';
import { quotas as buildQuotas } from '../../../src/entitlements/quotas.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';
import {
  applyAaplGolden,
  createApiSession,
  createWebSession,
  delayedEntitlements,
  GOLDEN_CAPTURE_MS,
  seedQuoteInstrument,
  startWsApp,
  WsClient,
  type SeededInstrument,
  type StartedWsApp,
} from '../ws/helpers.js';

const t = withTxDb();

type SubAck = Extract<ServerMsg, { t: 'subAck' }>;

let live: { app: StartedWsApp; client: WsClient } | null = null;

afterEach(async () => {
  if (live === null) return;
  await live.client.close();
  await live.app.close();
  live = null;
});

interface World {
  instrument: SeededInstrument;
  subject: string;
  /** A second live subject, so a ceiling of 1 has something to refuse. */
  other: string;
  client: WsClient;
  /**
   * The same app the socket is on, so a test can ask the HTTP side what the socket is doing. The
   * `subs` counter is the only quota whose numerator lives in the process rather than in a table.
   */
  app: StartedWsApp;
  /** A web session's cookie; `''` for an api one, which authenticates on the `hello` frame. */
  cookie: string;
}

/**
 * One plant holding the AAPL golden quote plus `sys:status`, an app whose quota source is the real
 * `entitlements/quotas.ts` over this transaction, and one open socket of the requested kind.
 */
async function world(spec: {
  kind: 'web' | 'api';
  scopes?: readonly string[];
  /** Written to `quota_limits` for the session's user before the socket opens. */
  concurrentSubscriptions?: number;
  wireQuotas?: boolean;
}): Promise<World> {
  const clock = testClock(GOLDEN_CAPTURE_MS);
  const plant = buildPlant({ config: getConfig(), clock });
  const instrument = await seedQuoteInstrument(t, { ticker: 'AAPL', name: 'Apple Inc' });
  await applyAaplGolden(plant, instrument);
  plant.publish(
    'sys:status',
    { PLANT_STATE: 'ok', CONFLATION_FLOOR_MS: 0 },
    { ts: { src: GOLDEN_CAPTURE_MS, cap: GOLDEN_CAPTURE_MS, pub: GOLDEN_CAPTURE_MS } },
  );

  const session =
    spec.kind === 'web'
      ? await createWebSession(t)
      : await createApiSession(t, spec.scopes === undefined ? {} : { scopes: spec.scopes });

  if (spec.concurrentSubscriptions !== undefined) {
    await t.client.query(
      `INSERT INTO quota_limits (subject_kind, subject_id, concurrent_subscriptions)
       VALUES ('user', $1, $2)`,
      [session.userId, spec.concurrentSubscriptions],
    );
  }

  const app = await startWsApp({
    t,
    clock,
    plant,
    entitlements: delayedEntitlements(),
    limits: { sweepMs: 250, maxLimitRejections: 1_000 },
    ...(spec.wireQuotas === false ? {} : { quotas: buildQuotas({ db: t.db, clock }) }),
  });

  const client = new WsClient(
    app.url,
    spec.kind === 'web'
      ? { cookie: (session as { cookie: string }).cookie }
      : {},
  );
  await client.open();
  live = { app, client };

  if (spec.kind === 'api') {
    client.send({ t: 'hello', protocol: 1, client: 'api/0.1.0', conflationMs: 50, token: session.token });
  } else {
    client.send({ t: 'hello', protocol: 1, client: 'web/0.1.0', conflationMs: 50 });
  }

  return {
    instrument,
    subject: instrument.subject,
    other: 'sys:status',
    client,
    app,
    cookie: spec.kind === 'web' ? (session as { cookie: string }).cookie : '',
  };
}

async function ackFor(client: WsClient, id: number): Promise<SubAck> {
  return (await client.next((f) => f.t === 'subAck' && f.id === id)) as SubAck;
}

describe('the concurrent-subscription ceiling (API.md §8)', () => {
  it('is read from quota_limits and reported in welcome', async () => {
    const w = await world({ kind: 'api', concurrentSubscriptions: 1 });
    const welcome = (await w.client.next((f) => f.t === 'welcome')) as {
      limits: { maxSubscriptions: number };
    };
    // Not 2 000: enforcement used to be the hardcoded `DEFAULT_WS_LIMITS.maxSubscriptionsApi`, so
    // an explicit row was ignored and `welcome` advertised a ceiling the row had overridden.
    expect(welcome.limits.maxSubscriptions).toBe(1);

    w.client.send({ t: 'sub', id: 1, subjects: [{ s: w.subject, f: ['PX_LAST'] }] });
    expect((await ackFor(w.client, 1)).accepted).toHaveLength(1);

    w.client.send({ t: 'sub', id: 2, subjects: [{ s: w.other, f: [] }] });
    const refused = await ackFor(w.client, 2);
    expect(refused.accepted).toEqual([]);
    // §8: an api session over a quota is `QUOTA_EXCEEDED`; `LIMIT` is the web ceiling's code.
    expect(refused.rejected[0]).toMatchObject({ s: w.other, code: 'QUOTA_EXCEEDED' });
  });

  it('keeps LIMIT for a web session over its own ceiling', async () => {
    const w = await world({ kind: 'web', concurrentSubscriptions: 1 });
    await w.client.next((f) => f.t === 'welcome');

    w.client.send({ t: 'sub', id: 1, subjects: [{ s: w.subject, f: ['PX_LAST'] }] });
    expect((await ackFor(w.client, 1)).accepted).toHaveLength(1);

    w.client.send({ t: 'sub', id: 2, subjects: [{ s: w.other, f: [] }] });
    expect((await ackFor(w.client, 2)).rejected[0]).toMatchObject({ code: 'LIMIT' });
  });

  it('falls back to the host limits when quota_limits holds no row', async () => {
    const w = await world({ kind: 'api' });
    const welcome = (await w.client.next((f) => f.t === 'welcome')) as {
      limits: { maxSubscriptions: number };
    };
    expect(welcome.limits.maxSubscriptions).toBe(2_000);
  });
});

describe('what the HTTP side reports for the live counter (API-06)', () => {
  /**
   * `concurrentSubscriptions.used` was a hardcoded `0`.
   *
   * `entitlements/quotas.ts#state` takes the count as an argument — the plant holds the subscription
   * set in memory and there is no table to read, and the function's own comment says so — and every
   * HTTP caller omitted the argument, so the field answered `0` with any number of subjects live.
   * `subs 0/10,000` on the status strip was that constant, not a measurement, and the e2e test named
   * "the quota strip reports the plant's own counters, not a constant" was satisfied by it.
   *
   * This is the only place in the suite where the two halves meet: a real socket holding real
   * subscriptions, and the two HTTP reads a client makes about them. Both are asserted, because the
   * strip is seeded from `/auth/session` at page load and refreshed from `/usage/quota` a minute
   * later, and a fix to one of them would have left the other reading zero.
   */
  it('counts the socket’s live subjects on /usage/quota and /auth/session', async () => {
    const w = await world({ kind: 'web' });
    await w.client.next((f) => f.t === 'welcome');

    const quota = async (): Promise<{ used: number; limit: number }> => {
      const res = await w.app.app.inject({
        method: 'GET',
        url: '/api/v1/usage/quota',
        headers: { cookie: w.cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      return (JSON.parse(res.body) as { concurrentSubscriptions: { used: number; limit: number } })
        .concurrentSubscriptions;
    };

    // Before any `sub`, zero is the truth rather than the constant — which is exactly why the
    // assertion below has to move it.
    expect((await quota()).used).toBe(0);

    w.client.send({ t: 'sub', id: 1, subjects: [{ s: w.subject, f: ['PX_LAST'] }] });
    expect((await ackFor(w.client, 1)).accepted).toHaveLength(1);
    w.client.send({ t: 'sub', id: 2, subjects: [{ s: w.other, f: [] }] });
    expect((await ackFor(w.client, 2)).accepted).toHaveLength(1);

    const after = await quota();
    expect(after.used, 'GET /usage/quota does not see the socket’s subscriptions').toBe(2);
    expect(after.limit).toBe(10_000);

    const session = await w.app.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: w.cookie },
    });
    expect(session.statusCode, session.body).toBe(200);
    // `GET /auth/session` answers the bare `SessionInfo`; `POST /auth/login` is the one that wraps it
    // in `{ session }` (API.md §1.2/§1.3).
    const info = JSON.parse(session.body) as {
      quotas: { concurrentSubscriptions: { used: number; limit: number } };
    };
    expect(
      info.quotas.concurrentSubscriptions.used,
      'the page-load snapshot the status strip is seeded from does not see them either',
    ).toBe(2);

    // And it comes back down: a gauge that only ever rose would read as a leak the first time a
    // panel was retargeted (TERM-12's own register — a number that cannot fall is not a measurement).
    // `unsub` is not acknowledged on the wire (API.md §6.4), so the read is retried rather than
    // sequenced: the assertion is the value it settles on, not the first one it sees.
    w.client.send({ t: 'unsub', subjects: [w.other] });
    await expect.poll(async () => (await quota()).used, { timeout: 2_000 }).toBe(1);
  });
});

describe('the ws:subscribe scope (API-01)', () => {
  it('refuses a sub from a key that does not carry it', async () => {
    const w = await world({ kind: 'api', scopes: ['data:read'] });
    await w.client.next((f) => f.t === 'welcome');

    w.client.send({ t: 'sub', id: 1, subjects: [{ s: w.subject, f: ['PX_LAST'] }] });
    const ack = await ackFor(w.client, 1);
    expect(ack.accepted).toEqual([]);
    expect(ack.rejected[0]).toMatchObject({ s: w.subject, code: 'NOT_ENTITLED' });
    expect(ack.rejected[0]!.reason).toContain('ws:subscribe');
  });

  it('accepts a sub from a key that does', async () => {
    const w = await world({ kind: 'api', scopes: ['data:read', 'ws:subscribe'] });
    await w.client.next((f) => f.t === 'welcome');

    w.client.send({ t: 'sub', id: 1, subjects: [{ s: w.subject, f: ['PX_LAST'] }] });
    expect((await ackFor(w.client, 1)).accepted).toHaveLength(1);
  });
});
