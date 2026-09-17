/**
 * `scripts/fixtures-import.ts` — registers the recorded provider fixtures into
 * `fixtures/providers/manifest.json` (PROVIDERS §3.2-3.4, WORKPLAN §1.10). `npm run fixtures:import`.
 *
 * For every file directly in `fixtures/providers/raw/` (non-recursive, so the `raw/<providerId>/…`
 * files written by record mode are left alone) it:
 *
 *   1. looks the name up in `scripts/fixtures-urls.ts` — an unmapped file is a hard error, so a
 *      fixture added without a URL cannot go unnoticed;
 *   2. computes `sha256` and `bytes` of the bytes on disk;
 *   3. derives `capturedAt` from `capturedAtPath` (Yahoo `meta.regularMarketTime`, epoch seconds),
 *      else from `sourceTsPath` (Cboe `timestamp`, frankfurter `date`), else from the file's mtime;
 *   4. derives `sourceTs` from `sourceTsPath`, `null` when the payload publishes no instant;
 *   5. computes `requestKey(providerId, method, url, body)` and merges a `captures[]` entry;
 *   6. rewrites the manifest with sorted keys, two-space indent and a trailing newline.
 *
 * Idempotent: running it twice produces a byte-identical manifest. Where `capturedAt` can only come
 * from the mtime, an existing capture with the same file and `sha256` keeps its recorded
 * `capturedAt`, so a fresh checkout (which resets mtimes) does not churn the manifest.
 *
 * `captures[]` rather than ARCHITECTURE §8.1's single-capture value object is required, and is
 * PROVIDERS §3.3's "Addition required": `yahoo-chart-1m` and `yahoo-chart-AAPL-1d-1m.json` are the
 * same request captured four minutes apart and collide on one `requestKey`; the single-capture
 * shape would silently drop one.
 *
 * `canonicalUrl` and `requestKey` are implemented here because the scripts run before WP-05 writes
 * `packages/server/src/providers/replayStore.ts`; that module must compute the same bytes — the
 * derivation is PROVIDERS §3.2 and is restated in full below.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_URLS, type FixtureUrl } from './fixtures-urls.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPLAY_DIR = join(ROOT, 'fixtures/providers');
const RAW_DIR = join(REPLAY_DIR, 'raw');
const MANIFEST = join(REPLAY_DIR, 'manifest.json');

/* ------------------------------------------------------- PROVIDERS §3.2: the key derivation */

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** UTF-8 byte comparison, as §3.2 rule 3 requires (not the UTF-16 order of `<`). */
function byteCompare(a: string, b: string): number {
  return Buffer.from(a, 'utf8').compare(Buffer.from(b, 'utf8'));
}

/**
 * PROVIDERS §3.2. The key is only stable if every caller spells the URL the same way:
 * 1. lower-case scheme and host; drop a default port; drop the fragment;
 * 2. keep the path byte-for-byte after `encodeURIComponent` on each segment
 *    (`^GSPC` → `%5EGSPC`, `EURUSD=X` → `EURUSD%3DX`, `_SPX` → `_SPX`);
 * 3. sort query parameters by name, then by value, both as UTF-8 byte comparisons; re-encode
 *    values with `encodeURIComponent` (so `events=div|split` is always `events=div%7Csplit`);
 * 4. drop a parameter with an empty name; keep a parameter with an empty value as `name=`;
 * 5. emit `?` only when at least one parameter survives.
 */
export function canonicalUrl(url: string): string {
  const u = new URL(url); // WHATWG URL already lower-cases scheme + host and drops a default port
  const scheme = u.protocol.toLowerCase().replace(/:$/, '');
  const host = u.hostname.toLowerCase();
  const port = u.port === '' ? '' : `:${u.port}`;
  const auth =
    u.username === '' ? '' : `${u.username}${u.password === '' ? '' : `:${u.password}`}@`;

  const path = u.pathname
    .split('/')
    .map((segment) => {
      if (segment === '') return '';
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        decoded = segment; // a stray '%' that is not an escape: keep the bytes as they are
      }
      return encodeURIComponent(decoded);
    })
    .join('/');

  const params: [string, string][] = [];
  for (const [name, value] of u.searchParams) {
    if (name === '') continue; // rule 4
    params.push([name, value]);
  }
  params.sort((a, b) => byteCompare(a[0], b[0]) || byteCompare(a[1], b[1]));
  const query =
    params.length === 0
      ? ''
      : `?${params.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&')}`;

  return `${scheme}://${auth}${host}${port}${path}${query}`;
}

/** `sha256(providerId + '|' + METHOD + '|' + canonicalUrl(url) + '|' + sha256(body ?? ''))`. */
export function requestKey(
  providerId: string,
  method: 'GET' | 'POST',
  url: string,
  body?: string,
): string {
  const parts = [providerId, method.toUpperCase(), canonicalUrl(url), sha256Hex(body ?? '')];
  return sha256Hex(parts.join('|'));
}

/* ----------------------------------------------------------------- the manifest's value shape */

export interface FixtureCapture {
  /** Path relative to `REPLAY_DIR`. */
  file: string;
  status: number;
  bytes: number;
  /** Of the file bytes; verified on every load. */
  sha256: string;
  /** → `RawRecord.capturedAt` (FEED-05 'cap'). */
  capturedAt: string;
  /** Provider-published instant; null when the payload carries none. */
  sourceTs: string | null;
  headers: Record<string, string>;
  note: string;
}

export interface FixtureEntry {
  providerId: string;
  method: 'GET' | 'POST';
  /** The canonical URL the key was computed from. */
  url: string;
  /** The exact request body, when the request had one (OpenFIGI, BLS). */
  body?: string;
  captures: FixtureCapture[];
}

export type FixtureManifest = Record<string, FixtureEntry>;

/* --------------------------------------------------------------------------- payload helpers */

/** RFC 6901-style pointer walk, tolerant: any miss is `undefined`. */
function pointer(doc: unknown, path: string): unknown {
  let cursor: unknown = doc;
  for (const rawSegment of path.split('/')) {
    if (rawSegment === '') continue;
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cursor)) {
      const i = Number(segment);
      if (!Number.isInteger(i) || i < 0 || i >= cursor.length) return undefined;
      cursor = cursor[i];
      continue;
    }
    if (typeof cursor === 'object' && cursor !== null && segment in cursor) {
      cursor = (cursor as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return cursor;
}

/** `2026-09-15T18:41:28Z` — seconds precision, always UTC, the shape PROVIDERS §3.3 shows. */
function toInstant(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * Coerces a provider-published timestamp to an instant:
 * - a number is epoch seconds (Yahoo `regularMarketTime`) unless it is already milliseconds;
 * - `2026-09-15` (frankfurter `date`) is that date at midnight UTC;
 * - `2026-09-15 18:41:28` is Cboe's `T`-less form and is parsed as UTC (PROVIDERS §5.1);
 * - anything else must parse as an ISO-8601 instant.
 */
function coerceInstant(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return toInstant(value < 1e11 ? value * 1000 : value);
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00Z`;
  const naive = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(s);
  if (naive !== null) return `${naive[1]}T${naive[2]}Z`;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : toInstant(ms);
}

/** Only JSON payloads carry pointers; everything else answers `undefined`. */
function parseJsonOrNull(bytes: Buffer): unknown {
  const head = bytes.subarray(0, 1).toString('utf8');
  if (head !== '{' && head !== '[') return undefined;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Deterministic `content-type`, sniffed from the recorded bytes (no header was preserved). */
function contentType(fileName: string, bytes: Buffer): string {
  const head = bytes.subarray(0, 512).toString('utf8').trimStart();
  if (bytes.subarray(0, 2).toString('binary') === 'PK') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (head.startsWith('{') || head.startsWith('[')) return 'application/json';
  if (head.startsWith('<?xml')) {
    const window = bytes.subarray(0, 4096).toString('utf8');
    if (window.includes('<rss')) return 'application/rss+xml';
    if (window.includes('<feed')) return 'application/atom+xml';
    return 'application/xml';
  }
  if (/^<!doctype html|^<html/i.test(head)) return 'text/html; charset=utf-8';
  if (fileName.endsWith('.csv') || /^"?[A-Za-z_][\w ]*"?,/.test(head)) return 'text/csv';
  return 'application/octet-stream';
}

/* ----------------------------------------------------------------------------- manifest merge */

function readManifest(): FixtureManifest {
  if (!existsSync(MANIFEST)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as FixtureManifest) : {};
  } catch (err) {
    console.error(`${MANIFEST} is not valid JSON — delete it to re-import from scratch`);
    throw err;
  }
}

function priorCapturedAt(
  prior: FixtureManifest,
  key: string,
  file: string,
  sha256: string,
): string | undefined {
  const captures = prior[key]?.captures;
  if (!Array.isArray(captures)) return undefined;
  const hit = captures.find((c) => c.file === file && c.sha256 === sha256);
  return hit?.capturedAt;
}

function sortCaptures(captures: FixtureCapture[]): FixtureCapture[] {
  return [...captures].sort(
    (a, b) =>
      (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0) ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  );
}

/* -------------------------------------------------------------------------------------- main */

function main(): void {
  const check = process.argv.includes('--check');
  if (!existsSync(RAW_DIR)) {
    console.error(`missing ${RAW_DIR} — the recorded fixtures are part of the repository`);
    process.exit(1);
  }

  const files = readdirSync(RAW_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== '.DS_Store')
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const unmapped = files.filter((f) => FIXTURE_URLS[f] === undefined);
  if (unmapped.length > 0) {
    console.error(
      `${unmapped.length} file(s) in fixtures/providers/raw/ have no entry in scripts/fixtures-urls.ts:`,
    );
    for (const f of unmapped) console.error(`  - ${f}`);
    console.error('Add the exact URL each was captured from and re-run `npm run fixtures:import`.');
    process.exit(1);
  }
  const missing = Object.keys(FIXTURE_URLS).filter((f) => !files.includes(f));
  if (missing.length > 0) {
    console.error(`${missing.length} mapped fixture(s) are not on disk:`);
    for (const f of missing) console.error(`  - ${f}`);
    process.exit(1);
  }

  const prior = readManifest();
  const imported = new Set(files.map((f) => `raw/${f}`));
  const next: FixtureManifest = {};
  const keyOf = new Map<string, string[]>(); // key → files, for the collision report

  for (const fileName of files) {
    const spec: FixtureUrl = FIXTURE_URLS[fileName]!;
    const abs = join(RAW_DIR, fileName);
    const bytes = readFileSync(abs);
    const sha256 = sha256Hex(bytes);
    const key = requestKey(spec.providerId, spec.method, spec.url, spec.body);
    const relFile = `raw/${fileName}`;

    const doc =
      spec.sourceTsPath !== undefined || spec.capturedAtPath !== undefined
        ? parseJsonOrNull(bytes)
        : undefined;
    const sourceTs =
      spec.sourceTsPath === undefined ? null : coerceInstant(pointer(doc, spec.sourceTsPath));
    if (spec.sourceTsPath !== undefined && sourceTs === null) {
      console.warn(
        `  warn    ${fileName}: sourceTsPath '${spec.sourceTsPath}' resolved to nothing`,
      );
    }
    const fromCapturedAtPath =
      spec.capturedAtPath === undefined ? null : coerceInstant(pointer(doc, spec.capturedAtPath));
    const capturedAt =
      fromCapturedAtPath ??
      sourceTs ??
      priorCapturedAt(prior, key, relFile, sha256) ??
      toInstant(statSync(abs).mtimeMs);

    const entry: FixtureEntry = next[key] ?? {
      providerId: spec.providerId,
      method: spec.method,
      url: canonicalUrl(spec.url),
      ...(spec.body === undefined ? {} : { body: spec.body }),
      captures: [],
    };
    entry.captures.push({
      file: relFile,
      status: 200,
      bytes: bytes.byteLength,
      sha256,
      capturedAt,
      sourceTs,
      headers: { 'content-type': contentType(fileName, bytes) },
      note: 'imported by scripts/fixtures-import.ts',
    });
    next[key] = entry;
    keyOf.set(key, [...(keyOf.get(key) ?? []), fileName]);
  }

  // Keep every capture this importer does not own: record mode's `raw/<providerId>/<key>.<ext>`.
  for (const [key, entry] of Object.entries(prior)) {
    const kept = (entry.captures ?? []).filter((c) => !imported.has(c.file));
    if (kept.length === 0) continue;
    const target = next[key];
    if (target === undefined) next[key] = { ...entry, captures: kept };
    else target.captures.push(...kept);
  }

  const sortedKeys = Object.keys(next).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: FixtureManifest = {};
  for (const key of sortedKeys) {
    const entry = next[key]!;
    entry.captures = sortCaptures(entry.captures);
    out[key] = entry;
  }

  const rendered = `${JSON.stringify(out, null, 2)}\n`;
  const current = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : null;

  for (const [key, group] of keyOf) {
    if (group.length > 1) {
      console.log(
        `  collide ${group.join(', ')} → one requestKey ${key.slice(0, 12)}… (captures[])`,
      );
    }
  }

  if (current === rendered) {
    console.log(`  ok      fixtures/providers/manifest.json`);
  } else if (check) {
    console.error('  STALE   fixtures/providers/manifest.json — run `npm run fixtures:import`');
    process.exitCode = 1;
    return;
  } else {
    mkdirSync(dirname(MANIFEST), { recursive: true });
    writeFileSync(MANIFEST, rendered, 'utf8');
    console.log(`  ${current === null ? 'created' : 'updated'} fixtures/providers/manifest.json`);
  }

  const captureCount = Object.values(out).reduce((n, e) => n + e.captures.length, 0);
  console.log(
    `  ${files.length} raw files → ${sortedKeys.length} request keys, ${captureCount} captures`,
  );
}

main();
