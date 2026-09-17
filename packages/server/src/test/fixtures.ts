/**
 * Replay-fixture loader for tests — ARCHITECTURE §3.3 L352-353, PROVIDERS.md §3.1 L350-366.
 *
 * ```
 * fixtures/providers/manifest.json          requestKey → capture metadata (PROVIDERS §3.3)
 * fixtures/providers/raw/<file>             the recorded bytes, original names preserved
 * fixtures/providers/normalised/<file>.json golden normaliser output, one per raw file
 * fixtures/sessions/<name>/                 events.ndjson, subscriptions.json, expected.ndjson
 * fixtures/seed/<name>.json                 curated seed inputs (DATA_MODEL §18)
 * ```
 *
 * This is the *file* view of the store, which is what tests, seeds and goldens need. The
 * `requestKey` view — `canonicalUrl`, `requestKey`, and the dispatcher that serves an adapter's
 * HTTP call from the manifest — is `providers/replayStore.ts` (WP-05) and deliberately does not
 * live here.
 *
 * A miss throws `ReplayMissError` (`code: 'REPLAY_MISS'`), never a silent fallback to the network:
 * in `PROVIDER_MODE=replay` a missing fixture must fail the test loudly (PROVIDERS §4 L262).
 *
 * Roots come from `config.REPLAY_DIR`, resolved against the **package** directory rather than
 * `process.cwd()`, so a test, a seed run and a `tsx` process all see the same files no matter where
 * they were started from.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConfig } from '../config.js';

/** Thrown when a fixture is not on disk. Mirrors the `REPLAY_MISS` error code of API.md §2. */
export class ReplayMissError extends Error {
  readonly code = 'REPLAY_MISS' as const;
  readonly path: string;

  constructor(path: string) {
    super(`REPLAY_MISS: no fixture at ${path}`);
    this.name = 'ReplayMissError';
    this.path = path;
  }
}

/** `packages/server` — the same from `src/test/` and from `dist/test/`. */
const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** `fixtures/providers` (or whatever `REPLAY_DIR` points at), absolute. */
export function providersDir(): string {
  const dir = getConfig().REPLAY_DIR;
  return isAbsolute(dir) ? dir : resolve(PACKAGE_DIR, dir);
}

/** `fixtures/` — the parent of `REPLAY_DIR`, which also holds `sessions/` and `seed/`. */
export function fixturesRoot(): string {
  return resolve(providersDir(), '..');
}

export function rawDir(): string {
  return join(providersDir(), 'raw');
}

export function normalisedDir(): string {
  return join(providersDir(), 'normalised');
}

export function sessionsDir(): string {
  return join(fixturesRoot(), 'sessions');
}

export function seedDir(): string {
  return join(fixturesRoot(), 'seed');
}

async function readText(path: string): Promise<string> {
  if (!existsSync(path)) throw new ReplayMissError(path);
  return readFile(path, 'utf8');
}

async function readJson<T>(path: string): Promise<T> {
  const text = await readText(path);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new SyntaxError(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Every file in `raw/` (top level only), sorted — the list the manifest-integrity test walks. */
export async function listRaw(): Promise<string[]> {
  const dir = rawDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** True when `name` exists in `raw/`. */
export function hasRaw(name: string): boolean {
  return existsSync(join(rawDir(), name));
}

/** Recorded bytes as text — names are the originals (`cboe-quote-AAPL.json`, `yahoo-fx`, …). */
export function readRaw(name: string): Promise<string> {
  return readText(join(rawDir(), name));
}

/** Recorded bytes parsed as JSON. */
export function readRawJson<T = unknown>(name: string): Promise<T> {
  return readJson<T>(join(rawDir(), name));
}

/** The golden normaliser output for a raw file: `normalised/<name>.json`. */
export function readNormalised<T = unknown>(rawName: string): Promise<T> {
  return readJson<T>(join(normalisedDir(), `${rawName}.json`));
}

/**
 * `manifest.json` as parsed JSON. Typed as `unknown` on purpose: `providers/replayStore.ts` (WP-05)
 * owns the manifest schema, and a second, drifting copy of it here would be worse than a cast at
 * the two call sites that need one.
 */
export function readManifest(): Promise<unknown> {
  return readJson<unknown>(join(providersDir(), 'manifest.json'));
}

/** A curated seed input, `fixtures/seed/<name>.json` (DATA_MODEL §18: firms, users, workspaces …). */
export function readSeedFixture<T = unknown>(name: string): Promise<T> {
  const file = name.endsWith('.json') ? name : `${name}.json`;
  return readJson<T>(join(seedDir(), file));
}

/** Parse newline-delimited JSON, ignoring blank lines. */
export function parseNdjson<T = unknown>(text: string): T[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as T;
      } catch (err) {
        throw new SyntaxError(
          `ndjson line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
}

/** A recorded plant session (PROVIDERS §3.1): the inputs and the expected output stream. */
export interface SessionFixture<E = unknown, S = unknown, X = unknown> {
  name: string;
  events: E[];
  subscriptions: S;
  expected: X[];
}

/** Load `fixtures/sessions/<name>/` for the replay harness (`replay/harness.ts`, §8.2). */
export async function readSession<E = unknown, S = unknown, X = unknown>(
  name: string,
): Promise<SessionFixture<E, S, X>> {
  const dir = join(sessionsDir(), name);
  const [events, subscriptions, expected] = await Promise.all([
    readText(join(dir, 'events.ndjson')).then((t) => parseNdjson<E>(t)),
    readJson<S>(join(dir, 'subscriptions.json')),
    readText(join(dir, 'expected.ndjson')).then((t) => parseNdjson<X>(t)),
  ]);
  return { name, events, subscriptions, expected };
}
