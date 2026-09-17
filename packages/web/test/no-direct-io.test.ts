// packages/web/test/no-direct-io.test.ts — WP-01 acceptance test (WORKPLAN §1.11).
//
// ARCHITECTURE L73-76: "`no-restricted-globals` (`fetch`, `WebSocket`, `XMLHttpRequest`) in
// `packages/web`; and `packages/web/test/no-direct-io.test.ts`, which greps the production bundle
// for `new WebSocket(` and `fetch(` outside the SDK chunk. This is how API-05 is made structural
// rather than aspirational: the terminal cannot obtain a number by a path the public SDK does not
// also expose."
//
// The lint rule can be suppressed with a comment and does not see third-party code; the bundle
// cannot lie. So this file greps the *emitted* chunks. `vite.config.ts` puts everything under
// `packages/sdk/` (or resolved through `@terminal/sdk`) into a chunk named `sdk`; every other chunk
// must be free of direct IO.
//
// The bundle is built on demand when `dist/` is absent, because the thing under test is the build
// output, not the source.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

// `new URL('../', import.meta.url)` is avoided on purpose: this project runs in the `jsdom`
// environment, whose global `URL` is jsdom's own implementation and is not the one `fileURLToPath`
// accepts. `dirname` on the resolved path has no such problem.
/** `packages/web/test/` → `packages/web/` and the monorepo root. */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = dirname(TEST_DIR);
const REPO_ROOT = dirname(dirname(WEB_ROOT));
const ASSETS = join(WEB_ROOT, 'dist', 'assets');

interface Chunk {
  readonly file: string;
  readonly code: string;
  /** `vite.config.ts` `manualChunks()` names the SDK chunk `sdk`. */
  readonly isSdk: boolean;
}

let chunks: Chunk[] = [];

/** `vite build`; the emitted `.js` files, sourcemaps and CSS excluded. */
function buildIfNeeded(): void {
  const built = (): string[] =>
    existsSync(ASSETS) ? readdirSync(ASSETS).filter((f) => f.endsWith('.js')) : [];

  if (built().length === 0) {
    try {
      execFileSync('npm', ['run', 'build', '--workspace', '@terminal/web'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000,
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(
        'the web bundle could not be built, so API-05 cannot be checked against it.\n' +
          'Run `npm run build:web` and fix the build before reading anything into this failure.\n' +
          `${e.stdout ?? ''}\n${e.stderr ?? e.message ?? ''}`,
      );
    }
  }

  const files = built();
  if (files.length === 0) {
    throw new Error(`\`vite build\` produced no JavaScript chunks in ${ASSETS}`);
  }
  chunks = files
    .sort((a, b) => (a < b ? -1 : 1))
    .map((file) => ({
      file,
      code: readFileSync(join(ASSETS, file), 'utf8'),
      isSdk: file.startsWith('sdk-') || file === 'sdk.js',
    }));
}

/**
 * `fetch(` as a call, not as the tail of another identifier: `prefetch(` and `refetch(` are not
 * direct IO. `window.fetch(` and `globalThis.fetch(` still match, because `.` is not an identifier
 * character.
 */
const FETCH_CALL = /(?<![A-Za-z0-9_$])fetch\s*\(/g;
const WEBSOCKET_CALL = /new\s+WebSocket\s*\(/g;
const XHR_CALL = /new\s+XMLHttpRequest\s*\(/g;
const EVENTSOURCE_CALL = /new\s+EventSource\s*\(/g;

/**
 * Vite injects its modulepreload polyfill at the very top of the entry chunk; it calls `fetch()` on
 * `<link rel="modulepreload">` hrefs to warm the module graph. That is bundler scaffolding, not
 * application code, and it fetches no data. The exemption is deliberately narrow: the occurrence
 * must be preceded, within 1200 characters, by the literal `modulepreload`.
 *
 * Setting `build.modulePreload.polyfill = false` in `packages/web/vite.config.ts` would remove the
 * need for it entirely.
 */
const POLYFILL_WINDOW = 1200;
function isModulePreloadPolyfill(code: string, index: number): boolean {
  const before = code.slice(Math.max(0, index - POLYFILL_WINDOW), index);
  return before.includes('modulepreload');
}

interface Hit {
  readonly file: string;
  readonly index: number;
  readonly snippet: string;
}

function find(pattern: RegExp, chunk: Chunk, exempt?: (code: string, i: number) => boolean): Hit[] {
  const hits: Hit[] = [];
  const re = new RegExp(pattern.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk.code)) !== null) {
    if (exempt?.(chunk.code, m.index) === true) continue;
    hits.push({
      file: chunk.file,
      index: m.index,
      snippet: chunk.code.slice(Math.max(0, m.index - 60), m.index + 60),
    });
  }
  return hits;
}

const describeHits = (hits: readonly Hit[]): string =>
  hits.map((h) => `  ${h.file}@${String(h.index)}: …${h.snippet}…`).join('\n');

beforeAll(() => {
  buildIfNeeded();
}, 320_000);

describe('the production web bundle — API-05 (ARCHITECTURE L73-76)', () => {
  it('emits an sdk chunk and at least one application chunk', () => {
    expect(chunks.length).toBeGreaterThan(1);
    const sdk = chunks.filter((c) => c.isSdk);
    const app = chunks.filter((c) => !c.isSdk);
    expect(sdk, `no sdk-* chunk among ${chunks.map((c) => c.file).join(', ')}`).toHaveLength(1);
    expect(app.length).toBeGreaterThan(0);
  });

  it('contains no `new WebSocket(` outside the SDK chunk', () => {
    const hits = chunks.filter((c) => !c.isSdk).flatMap((c) => find(WEBSOCKET_CALL, c));
    expect(
      hits.length,
      `direct WebSocket construction outside the SDK:\n${describeHits(hits)}`,
    ).toBe(0);
  });

  it('contains no `fetch(` outside the SDK chunk', () => {
    const hits = chunks
      .filter((c) => !c.isSdk)
      .flatMap((c) => find(FETCH_CALL, c, isModulePreloadPolyfill));
    expect(hits.length, `direct fetch outside the SDK:\n${describeHits(hits)}`).toBe(0);
  });

  it('exempts at most one fetch per chunk as the modulepreload polyfill', () => {
    // Keeps the exemption from quietly swallowing real violations: Vite emits the polyfill once.
    for (const chunk of chunks.filter((c) => !c.isSdk)) {
      const all = find(FETCH_CALL, chunk);
      const kept = find(FETCH_CALL, chunk, isModulePreloadPolyfill);
      expect(
        all.length - kept.length,
        `${chunk.file}: more than one fetch( was exempted as bundler scaffolding`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('contains no `new XMLHttpRequest(` or `new EventSource(` outside the SDK chunk', () => {
    // The same `no-restricted-globals` zone as fetch/WebSocket (ARCHITECTURE L73).
    const hits = chunks
      .filter((c) => !c.isSdk)
      .flatMap((c) => [...find(XHR_CALL, c), ...find(EVENTSOURCE_CALL, c)]);
    expect(hits.length, `direct XHR/SSE outside the SDK:\n${describeHits(hits)}`).toBe(0);
  });

  it('keeps the transport in the SDK chunk, so the check is not vacuous', () => {
    // `client/rest.ts` resolves the implementation once: `opts.fetch ?? globalThis.fetch`.
    // If this ever stops matching, the bundle stopped routing IO through the SDK and the
    // assertions above would be passing for the wrong reason.
    const sdk = chunks.find((c) => c.isSdk);
    expect(sdk).toBeDefined();
    expect(sdk!.code).toContain('globalThis.fetch');
  });

  it('detects a seeded violation (the grep itself works)', () => {
    const seeded: Chunk = {
      file: 'seeded.js',
      isSdk: false,
      code: 'const a=1;fetch("/api/v1/data");new WebSocket("wss://x");const p=prefetch(1);',
    };
    expect(find(FETCH_CALL, seeded, isModulePreloadPolyfill)).toHaveLength(1);
    expect(find(WEBSOCKET_CALL, seeded)).toHaveLength(1);
    // `prefetch(` is not a direct-IO call and must not be reported.
    expect(find(FETCH_CALL, seeded).every((h) => !h.snippet.includes('prefetch'))).toBe(true);
  });

  it('would still report a violation that the polyfill exemption does not cover', () => {
    const seeded: Chunk = {
      file: 'seeded.js',
      isSdk: false,
      code: `${'x'.repeat(2000)}modulepreload${'y'.repeat(2000)};fetch("/api/v1/data")`,
    };
    // The `modulepreload` marker is 2000 characters away, well outside the window.
    expect(find(FETCH_CALL, seeded, isModulePreloadPolyfill)).toHaveLength(1);
  });
});
