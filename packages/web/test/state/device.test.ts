/**
 * packages/web/test/state/device.test.ts — the id and label `POST /auth/login` is sent.
 *
 * The label has one ordering trap worth a test of its own: an iPhone's user agent says
 * "like Mac OS X" and an Android one says "Linux", so a naive platform check reports an iPhone as a
 * Mac. The first draft of `deviceLabel` did exactly that.
 */

import { describe, expect, it } from 'vitest';

import { DEVICE_KEY, deviceId, deviceLabel, type DeviceStorage } from '../../src/state/device.js';

function memoryStorage(): DeviceStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

const throwing: DeviceStorage = {
  getItem: () => {
    throw new Error('SecurityError: private mode');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('deviceId', () => {
  it('is made once and then kept', () => {
    const s = memoryStorage();
    const first = deviceId(s);
    expect(first.length).toBeGreaterThanOrEqual(8);
    expect(s.data.get(DEVICE_KEY)).toBe(first);
    expect(deviceId(s)).toBe(first);
  });

  it('ignores a stored value the server would refuse, and replaces it', () => {
    const s = memoryStorage();
    s.data.set(DEVICE_KEY, 'short');
    const id = deviceId(s);
    expect(id).not.toBe('short');
    expect(id.length).toBeGreaterThanOrEqual(8);
  });

  it('works in private mode — one id for the life of the page, never a throw', () => {
    const a = deviceId(throwing);
    const b = deviceId(throwing);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(8);
  });
});

describe('deviceLabel', () => {
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Chrome on macOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
      'Edge on Windows',
    ],
    ['Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Firefox on Linux'],
    ['', 'A browser on an unknown platform'],
  ])('%s', (ua, expected) => {
    expect(deviceLabel(ua)).toBe(expected);
  });

  it('never returns the user agent itself', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/129.0.0.0 Safari/537.36';
    expect(deviceLabel(ua)).not.toContain('Mozilla');
    expect(deviceLabel(ua).length).toBeLessThanOrEqual(80);
  });
});
