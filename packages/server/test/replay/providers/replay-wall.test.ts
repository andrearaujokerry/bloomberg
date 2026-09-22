/**
 * WP-05 acceptance row — **"a request with no fixture throws in `replay` mode and never opens a
 * socket."** (PROVIDERS.a §2.1, §3.6.)
 *
 * The property the other thirty replay suites rely on but none of them state. They all pass
 * because every request they make happens to have a capture; none of them would notice if a miss
 * quietly fell through to the network, and CI would then be green on a machine with connectivity
 * and red on one without — or, worse, green while silently hammering `sec.gov` at 10 requests a
 * second from a build agent.
 *
 * So the wall is asserted from both sides:
 *
 *  1. **the store side** — `ReplayStore.replay()` on an unrecorded key throws `ReplayMissError`,
 *     naming the key it computed and the nearest recorded URL, and `lookup()` returns `null`
 *     rather than reaching for anything;
 *  2. **the client side** — `ProviderHttpClient` in `replay` mode, given a *working* transport
 *     that would happily answer `200`, still throws `ReplayMissError` for the unrecorded request
 *     and **never calls that transport** — not for the miss, not for the hit, not for a retry.
 *     The spy fails the test by its own call count, so nothing depends on the machine being
 *     offline.
 *
 * The injected transport is the whole point: `replayWallTransport()` is what production installs
 * in replay mode, and a test that used it would be proving the stub rejects, not that the wall is
 * never reached. Here the transport *works*, and the assertion is that it is never asked.
 */

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config.js';
import { ProviderHttpClient, replayWallTransport } from '../../../src/providers/http.js';
import {
  ReplayMissError,
  canonicalUrl,
  openReplayStore,
  requestKey,
} from '../../../src/providers/replayStore.js';
import { atomUrl } from '../../../src/providers/sec/adapter.js';

import type { Transport, TransportRequest } from '../../../src/providers/http.js';

const store = openReplayStore();

/** A URL no capture can ever answer, on a provider that has captures (so `nearest` is populated). */
const UNRECORDED_URL = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=10-Q-NOPE';

/** A transport that answers 200 for anything — and records that it was asked, which is the failure. */
function spyTransport(): { transport: Transport; calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  const transport: Transport = (req) => {
    calls.push(req);
    return Promise.resolve({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"this":"should never be reached"}'),
      url: req.url,
    });
  };
  return { transport, calls };
}

function replayClient(transport: Transport): ProviderHttpClient {
  return new ProviderHttpClient({
    config: { ...loadConfig(), PROVIDER_MODE: 'replay' },
    transport,
    store,
  });
}

describe('replay is a wall — the store', () => {
  it('throws ReplayMissError for a request with no capture', () => {
    expect(() => store.replay({ providerId: 'sec.atom', url: UNRECORDED_URL })).toThrow(
      ReplayMissError,
    );
  });

  it('names the key it computed and the nearest recorded URL, so the miss is actionable', () => {
    let thrown: unknown;
    try {
      store.replay({ providerId: 'sec.atom', url: UNRECORDED_URL });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ReplayMissError);
    const miss = thrown as ReplayMissError;
    expect(miss.requestKey).toBe(requestKey('sec.atom', 'GET', UNRECORDED_URL));
    // The manifest records the CANONICAL url (query sorted), which is what the key is over.
    expect(miss.nearest?.url).toBe(canonicalUrl(atomUrl()));
    expect(miss.message).toContain('npm run fixtures:import');
  });

  it('returns null from lookup rather than inventing a record', () => {
    expect(store.lookup(requestKey('sec.atom', 'GET', UNRECORDED_URL))).toBeNull();
    // A capture index past the end of a recorded entry is a miss too, never a wrap-around.
    const recordedKey = requestKey('sec.atom', 'GET', atomUrl());
    expect(store.lookup(recordedKey, 0)).not.toBeNull();
    expect(store.lookup(recordedKey, store.captureCount(recordedKey))).toBeNull();
  });
});

describe('replay is a wall — the http client', () => {
  it('never calls the transport for a miss, even when the transport would answer', async () => {
    const { transport, calls } = spyTransport();
    const client = replayClient(transport);
    await expect(client.get({ providerId: 'sec.atom', url: UNRECORDED_URL })).rejects.toBeInstanceOf(
      ReplayMissError,
    );
    expect(calls).toEqual([]);
  });

  it('never calls the transport for a hit either — the capture answers', async () => {
    const { transport, calls } = spyTransport();
    const client = replayClient(transport);
    const raw = await client.get({ providerId: 'sec.atom', url: atomUrl() });
    expect(raw.origin).toBe('replay');
    expect(raw.body.length).toBe(28_829);
    expect(calls).toEqual([]);
  });

  it('does not retry a miss: one attempt, no backoff, no breaker accounting', async () => {
    const { transport, calls } = spyTransport();
    const client = replayClient(transport);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(client.get({ providerId: 'sec.atom', url: UNRECORDED_URL })).rejects.toThrow(
        ReplayMissError,
      );
    }
    expect(calls).toEqual([]);
    // Six misses would open a breaker that counted them (§2.5 opens at five). It must not:
    // a missing fixture is a test defect, and a tripped breaker hides it behind a stale screen.
    expect(client.breaker('sec.atom').state).toBe('closed');
  });

  it('a POST body is part of the key, so a changed body is a miss and still opens no socket', async () => {
    const { transport, calls } = spyTransport();
    const client = replayClient(transport);
    await expect(
      client.post({
        providerId: 'openfigi.mapping',
        url: 'https://api.openfigi.com/v3/mapping',
        body: '[{"idType":"ID_ISIN","idValue":"US0000000000"}]',
      }),
    ).rejects.toBeInstanceOf(ReplayMissError);
    expect(calls).toEqual([]);
  });

  it("the production stub is the belt to this file's braces", async () => {
    // `replayWallTransport()` is what the client installs in replay mode when nothing is injected.
    // Nothing should ever reach it — but if a future code path did, it must reject rather than dial.
    await expect(
      replayWallTransport()({
        method: 'GET',
        url: 'https://example.invalid/',
        headers: {},
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/refusing to open a socket/);
  });
});
