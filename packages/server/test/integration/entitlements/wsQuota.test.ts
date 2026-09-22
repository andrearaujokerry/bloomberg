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

  return { instrument, subject: instrument.subject, other: 'sys:status', client };
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
