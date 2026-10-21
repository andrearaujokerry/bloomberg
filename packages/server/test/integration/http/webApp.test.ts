/**
 * `http/webApp.ts` — the plant serving the built web client (docs/DEPLOYMENT.md §4.2).
 *
 * Driven through the real application over a throwaway build directory, because the claims are
 * about routing as much as files: which paths get the page, which get a file, and — the part a
 * catch-all gets wrong — which still get the JSON 404 the client parses.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { isPagePath, resolveWebDist } from '../../../src/http/webApp.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { withTxDb } from '../../../src/test/db.js';

const t = withTxDb();

const PAGE = '<!doctype html><html><head><title>Terminal</title></head><body><div id="root"></div></body></html>';
const SCRIPT = 'console.log("terminal");';

let dist: string;
let started: TestApp | undefined;

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'web-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), PAGE);
  writeFileSync(join(dist, 'assets', 'index-AbC123.js'), SCRIPT);
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

afterEach(async () => {
  await started?.close();
  started = undefined;
});

async function serving(dir: string | undefined): Promise<TestApp> {
  started = await createTestApp({
    db: t.db,
    ...(dir === undefined ? {} : { config: { WEB_DIST_DIR: dir } }),
  });
  return started;
}

function errorCode(body: string): string | undefined {
  return (JSON.parse(body) as { error?: { code?: string } }).error?.code;
}

describe('with WEB_DIST_DIR set', () => {
  it('serves the page at the root, uncached and unframeable', async () => {
    const { app } = await serving(dist);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toBe(PAGE);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('answers any other page path with the page — a reload anywhere still loads the terminal', async () => {
    const { app } = await serving(dist);
    for (const url of ['/terminal', '/some/deep/path', '/p1?panel=GP']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toBe(PAGE);
      expect(res.headers['x-frame-options'], url).toBe('DENY');
    }
  });

  it('serves a fingerprinted asset with a year of immutable caching', async () => {
    const { app } = await serving(dist);
    const res = await app.inject({ method: 'GET', url: '/assets/index-AbC123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toBe(SCRIPT);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('answers a missing asset with a 404, never with the page', async () => {
    // After a redeploy the old fingerprint is gone; feeding a script tag HTML with a 200 fails with
    // a parse error that names nothing.
    const { app } = await serving(dist);
    const res = await app.inject({ method: 'GET', url: '/assets/index-OLDHASH.js' });
    expect(res.statusCode).toBe(404);
    expect(errorCode(res.body)).toBe('NOT_FOUND');
  });

  it('leaves the API alone: a real route answers, and an unknown one is still the JSON 404', async () => {
    const { app } = await serving(dist);
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['content-type']).toMatch(/json/);

    for (const url of ['/api/v1/no-such-route', '/api', '/ws/v1', '/metrics/x']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(errorCode(res.body), url).toBe('NOT_FOUND');
    }
  });

  it('only answers GET and HEAD with the page', async () => {
    const { app } = await serving(dist);
    const head = await app.inject({ method: 'HEAD', url: '/some/page' });
    expect(head.statusCode).toBe(200);
    const post = await app.inject({ method: 'POST', url: '/some/page', payload: {} });
    expect(post.statusCode).toBe(404);
    expect(errorCode(post.body)).toBe('NOT_FOUND');
  });
});

describe('without WEB_DIST_DIR', () => {
  it('serves the API only, exactly as before — the root is the JSON 404', async () => {
    const { app } = await serving(undefined);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(errorCode(res.body)).toBe('NOT_FOUND');
  });
});

describe('a missing build', () => {
  it('stops startup with a message that says what to do', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'web-empty-'));
    try {
      expect(() => resolveWebDist(empty)).toThrow(/no index\.html .*npm run build/);
      await expect(serving(empty)).rejects.toThrow(/WEB_DIST_DIR/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('isPagePath', () => {
  it.each([
    ['/terminal', true],
    ['/a/b/c', true],
    ['/x?y=1.5', true],
    ['/assets/app.js', false],
    ['/favicon.ico', false],
    ['/api/v1/workspace', false],
    ['/api', false],
    ['/ws/v1', false],
    ['/metrics', false],
    ['/health', false],
  ])('%s → %s', (url, expected) => {
    expect(isPagePath(url)).toBe(expected);
  });
});
