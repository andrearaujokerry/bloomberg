/**
 * The replay store — PROVIDERS.a §3 (L296-410, §3.1-§3.6), FEED-08, QA-02.
 *
 * `fixtures/providers/manifest.json` maps a `requestKey` to the bytes that were recorded for it.
 * In `PROVIDER_MODE=replay` — the default, so that forgetting to set the variable cannot put a
 * test on the network — this file is the *only* source of provider bytes, and a miss is a wall:
 * `ReplayMissError` is thrown with nearest-URL diagnostics and nothing falls through to a socket.
 *
 * Three things here are normative and nothing may re-implement them:
 *
 *  - `canonicalUrl()` — the key is stable only if every caller spells the URL the same way.
 *  - `requestKey()` — `sha256(providerId|METHOD|canonicalUrl|sha256(body))`, the same hex string
 *    that lands on `provenance.request_key`, which is what lets `Ctrl+I` jump from a cell on screen
 *    to the raw bytes that produced it (DATA-10).
 *  - `writeManifest()` — the manifest is a reviewed artefact: keys sorted, captures ordered by
 *    `capturedAt`, two-space indent, trailing newline, so `npm run fixtures:import` is idempotent
 *    and its diff is readable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Hex } from '@terminal/core';

import { getConfig } from '../config.js';
import type { CaptureSourceId, HttpMethod, ProviderId, RawRecord } from './types.js';
import { isCaptureSourceId } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// canonicalUrl — PROVIDERS.a §3.2, steps 1-5, normative
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Percent-decode tolerantly: a malformed escape is left exactly as it was written. */
function decodeTolerant(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Compare two strings as UTF-8 byte sequences. `<` on JS strings compares UTF-16 code units, which
 * orders astral characters before U+E000-U+FFFF — the opposite of UTF-8 byte order. The spec says
 * bytes, so bytes it is.
 */
function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * The canonical spelling of a request URL (PROVIDERS.a §3.2):
 *
 *  1. lower-case scheme and host, drop a default port, drop the fragment (and any credentials —
 *     they are never part of an identity we hash);
 *  2. each path segment is decoded once and re-encoded with `encodeURIComponent`, so `^GSPC`,
 *     `%5EGSPC` and `%5egspc` all canonicalise to `%5EGSPC` and the function is idempotent;
 *  3. query parameters sorted by name then value as UTF-8 bytes, values re-encoded with
 *     `encodeURIComponent` — `events=div|split` is always `events=div%7Csplit`;
 *  4. a parameter with an empty name is dropped; one with an empty value is kept as `name=`;
 *  5. `?` is emitted only when at least one parameter survives.
 *
 * The path is decoded before re-encoding because `URL.pathname` keeps whatever escapes the caller
 * wrote; the query is *not*, because `URLSearchParams` has already decoded it once and decoding
 * twice would turn a literal `%7C` in a value into a `|`.
 *
 * @throws Error naming the input when it is not an absolute URL.
 */
export function canonicalUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `canonicalUrl: '${url}' is not an absolute URL — an adapter must build a full ` +
        'scheme://host/path URL before it reaches the request key (PROVIDERS.a §3.2)',
    );
  }

  const path = parsed.pathname
    .split('/')
    .map((segment) => encodeURIComponent(decodeTolerant(segment)))
    .join('/');

  const params: { name: string; value: string }[] = [];
  for (const [name, value] of parsed.searchParams) {
    if (name === '') continue; // step 4
    params.push({ name, value });
  }
  params.sort((a, b) => compareUtf8(a.name, b.name) || compareUtf8(a.value, b.value));

  const query = params
    .map(({ name, value }) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');

  // `parsed.host` is lower-cased and already omits a default port (WHATWG URL); `parsed.protocol`
  // carries the trailing colon. The fragment and any user:password are simply not read.
  return `${parsed.protocol}//${parsed.host}${path}${query === '' ? '' : `?${query}`}`;
}

/**
 * `sha256( providerId + '|' + METHOD + '|' + canonicalUrl(url) + '|' + sha256(body ?? '') )`, hex.
 *
 * `body` is the exact request body string (OpenFIGI's JSON job array), not a re-serialised object:
 * two different orderings of the same JSON are two different keys, deliberately — the bytes are
 * what was sent, and what was sent is what was answered.
 */
export function requestKey(
  providerId: CaptureSourceId,
  method: HttpMethod,
  url: string,
  body?: string,
): string {
  const upper = method.toUpperCase();
  return sha256Hex(`${providerId}|${upper}|${canonicalUrl(url)}|${sha256Hex(body ?? '')}`);
}

/** `provenance.request_hash` — lower-case hex `sha256(method + url + body)` (PROVIDERS.a §1.1). */
export function requestHash(method: HttpMethod, url: string, body?: string): string {
  return sha256Hex(`${method.toUpperCase()}${url}${body ?? ''}`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// manifest.json — PROVIDERS.a §3.3
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One recorded response under a `requestKey`. */
export interface ManifestCapture {
  /** Path relative to `REPLAY_DIR`, e.g. `raw/cboe-quote-AAPL.json`. */
  file: string;
  status: number;
  bytes: number;
  /** Lower-case hex of the file bytes; verified on every load. */
  sha256: string;
  /** ISO-8601 UTC — `RawRecord.capturedAt` (FEED-05 `cap`). */
  capturedAt: string;
  /** Provider-published instant, `null` when the payload carries none. */
  sourceTs: string | null;
  /** Lower-cased response header names; `content-type`, `etag`, `last-modified` are what matter. */
  headers: Record<string, string>;
  note?: string;
}

/** One request, with every capture ever taken of it (§3.3: `captures[]`, never overwritten). */
export interface ManifestEntry {
  providerId: CaptureSourceId;
  method: HttpMethod;
  /** The canonical URL — `canonicalUrl(url)` of the request that produced the key. */
  url: string;
  /** POST only; the exact body string that participates in the key. */
  body?: string;
  captures: ManifestCapture[];
}

/** `requestKey` → entry. */
export type ReplayManifest = Record<string, ManifestEntry>;

/** Thrown when a fixture file's bytes no longer hash to the sha256 the manifest records. */
export class FixtureIntegrityError extends Error {
  constructor(
    readonly file: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `fixture '${file}' does not match its manifest sha256: expected ${expected}, ` +
        `got ${actual} — the recorded bytes were edited; re-run \`npm run fixtures:import\``,
    );
    this.name = 'FixtureIntegrityError';
  }
}

/** Thrown when `manifest.json` is missing, unparseable or structurally wrong. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCapture(key: string, index: number, value: unknown): ManifestCapture {
  if (!isRecord(value))
    throw new ManifestError(`manifest[${key}].captures[${index}] is not an object`);
  const { file, status, bytes, sha256, capturedAt, sourceTs, headers, note } = value;
  if (typeof file !== 'string' || file === '')
    throw new ManifestError(`manifest[${key}].captures[${index}].file must be a non-empty string`);
  if (typeof status !== 'number')
    throw new ManifestError(`manifest[${key}].captures[${index}].status must be a number`);
  if (typeof bytes !== 'number')
    throw new ManifestError(`manifest[${key}].captures[${index}].bytes must be a number`);
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
    throw new ManifestError(`manifest[${key}].captures[${index}].sha256 must be 64 hex chars`);
  if (typeof capturedAt !== 'string' || Number.isNaN(Date.parse(capturedAt)))
    throw new ManifestError(
      `manifest[${key}].captures[${index}].capturedAt must be an ISO instant`,
    );
  if (sourceTs !== null && (typeof sourceTs !== 'string' || Number.isNaN(Date.parse(sourceTs))))
    throw new ManifestError(
      `manifest[${key}].captures[${index}].sourceTs must be an ISO instant or null`,
    );
  if (!isRecord(headers))
    throw new ManifestError(`manifest[${key}].captures[${index}].headers must be an object`);

  const parsedHeaders: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== 'string')
      throw new ManifestError(
        `manifest[${key}].captures[${index}].headers['${name}'] must be a string`,
      );
    parsedHeaders[name.toLowerCase()] = headerValue;
  }

  const capture: ManifestCapture = {
    file,
    status,
    bytes,
    sha256,
    capturedAt,
    sourceTs,
    headers: parsedHeaders,
  };
  if (typeof note === 'string') capture.note = note;
  return capture;
}

function parseEntry(key: string, value: unknown): ManifestEntry {
  if (!isRecord(value)) throw new ManifestError(`manifest[${key}] is not an object`);
  const { providerId, method, url, body, captures } = value;
  if (typeof providerId !== 'string' || !isCaptureSourceId(providerId))
    throw new ManifestError(
      `manifest[${key}].providerId '${String(providerId)}' is not a known source id ` +
        '(providers/licences.ts)',
    );
  if (method !== 'GET' && method !== 'POST')
    throw new ManifestError(`manifest[${key}].method must be 'GET' or 'POST'`);
  if (typeof url !== 'string' || url === '')
    throw new ManifestError(`manifest[${key}].url must be a non-empty string`);
  if (!Array.isArray(captures) || captures.length === 0)
    throw new ManifestError(`manifest[${key}].captures must be a non-empty array`);
  if (body !== undefined && typeof body !== 'string')
    throw new ManifestError(`manifest[${key}].body must be a string when present`);

  const entry: ManifestEntry = {
    providerId,
    method,
    url,
    captures: captures.map((capture, index) => parseCapture(key, index, capture)),
  };
  if (typeof body === 'string') entry.body = body;
  return entry;
}

/** Parse a manifest document, validating every field a lookup depends on. */
export function parseManifest(document: unknown): ReplayManifest {
  if (!isRecord(document)) throw new ManifestError('manifest.json must be a JSON object');
  const manifest: ReplayManifest = {};
  for (const [key, value] of Object.entries(document)) {
    if (!/^[0-9a-f]{64}$/.test(key))
      throw new ManifestError(`manifest key '${key}' is not a 64-char lower-case hex requestKey`);
    manifest[key] = parseEntry(key, value);
  }
  return manifest;
}

/**
 * Serialise a manifest exactly as `scripts/fixtures-import.ts` must write it: keys sorted, captures
 * ordered by `capturedAt` (then by `file`, so two captures with the same instant still order
 * deterministically), fields in the documented order, two-space indent, trailing newline. Byte
 * identical to the committed file for the committed content — `requestKey.test.ts` asserts it.
 */
export function serialiseManifest(manifest: ReplayManifest): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(manifest).sort()) {
    const entry = manifest[key]!;
    const captures = [...entry.captures].sort(
      (a, b) =>
        Date.parse(a.capturedAt) - Date.parse(b.capturedAt) ||
        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
    );
    // Property order is the serialisation order, so these literals are the documented field order
    // of §3.3; an optional field is spread in at its place rather than appended afterwards.
    ordered[key] = {
      providerId: entry.providerId,
      method: entry.method,
      url: entry.url,
      ...(entry.body === undefined ? {} : { body: entry.body }),
      captures: captures.map((capture) => ({
        file: capture.file,
        status: capture.status,
        bytes: capture.bytes,
        sha256: capture.sha256,
        capturedAt: capture.capturedAt,
        sourceTs: capture.sourceTs,
        headers: Object.fromEntries(
          Object.entries(capture.headers).sort(([a], [b]) => compareUtf8(a, b)),
        ),
        ...(capture.note === undefined ? {} : { note: capture.note }),
      })),
    };
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Resolve `REPLAY_DIR` to an absolute directory.
 *
 * A relative value has two plausible bases and both are in use: `config.ts` defaults to
 * `../../fixtures/providers`, which is relative to the **server package**, while the committed
 * `.env` ships `./fixtures/providers`, which is relative to the **repository root** — and a
 * process may be started from either (`npm run dev` from `packages/server`, `npm test` from the
 * root). Both spellings name the same directory, so the resolver tries the candidate bases in a
 * fixed order and takes the first that actually holds a `manifest.json`, then the first that
 * exists, and otherwise the package-relative reading, so a miss reports a stable path.
 */
export function resolveReplayDir(dir: string): string {
  if (isAbsolute(dir)) return dir;
  // `src/providers/replayStore.ts` → `packages/server`; identical from `dist/providers/…`.
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  const repoRoot = resolve(packageRoot, '../..');
  const candidates = [
    resolve(packageRoot, dir),
    resolve(repoRoot, dir),
    resolve(process.cwd(), dir),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);

  return (
    candidates.find((candidate) => existsSync(join(candidate, 'manifest.json'))) ??
    candidates.find((candidate) => existsSync(candidate)) ??
    candidates[0]!
  );
}

export function manifestPath(dir: string): string {
  return join(resolveReplayDir(dir), 'manifest.json');
}

/** Read and validate `<dir>/manifest.json`. An absent file is an empty manifest (record mode). */
export function readManifest(dir: string): ReplayManifest {
  const path = manifestPath(dir);
  if (!existsSync(path)) return {};
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ManifestError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseManifest(document);
}

/** Write `<dir>/manifest.json` in the canonical form. */
export function writeManifest(dir: string, manifest: ReplayManifest): void {
  writeFileSync(manifestPath(dir), serialiseManifest(manifest), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ReplayMissError — PROVIDERS.a §3.6
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface NearestCapture {
  url: string;
  key: string;
}

/**
 * A request with no capture, in `replay` mode. Never caught by the scheduler's failure handler,
 * never converted into a `dq_events` row, and explicitly **not** a circuit-breaker failure
 * (PROVIDERS.a §2.5): a missing fixture is a test defect, and tripping the breaker would hide it
 * behind a stale screen. It fails the test, with the diff already in the message.
 */
export class ReplayMissError extends Error {
  constructor(
    readonly providerId: CaptureSourceId,
    readonly method: HttpMethod,
    readonly url: string,
    readonly requestKey: string,
    readonly nearest: NearestCapture | null,
  ) {
    const lines = [
      `no capture for ${providerId} ${method} ${url}`,
      `  requestKey ${requestKey}`,
      nearest === null
        ? '  nearest    (no capture recorded for this provider)'
        : `  nearest    ${nearest.url} (${nearest.key})`,
      '  fix        add the URL to scripts/fixtures-urls.ts and re-run `npm run fixtures:import`,',
      '             or capture it with `npm run fixtures:record`',
    ];
    super(lines.join('\n'));
    this.name = 'ReplayMissError';
  }
}

/** Levenshtein distance, bounded by the longer input; used only for miss diagnostics. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ReplayStore
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Options for `record()` — the two things a `RawRecord` cannot carry by itself. */
export interface RecordOptions {
  /** The exact request body that was sent (POST only); stored on the entry for the importer. */
  body?: string;
  /** Free-text provenance of the capture, e.g. `'imported by scripts/fixtures-import.ts'`. */
  note?: string;
}

/** `content-type` → file extension, PROVIDERS.a §3.5. */
export function extensionForContentType(contentType: string | undefined): string {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type === 'text/csv') return 'csv';
  if (type.endsWith('/xml') || type.endsWith('+xml')) return 'xml';
  if (type === 'text/html') return 'html';
  if (type.includes('spreadsheetml')) return 'xlsx';
  return 'bin';
}

/** Responses over 8 MB are refused, so a stray full-history pull cannot bloat the repository. */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

/**
 * The store. Synchronous on purpose: `lookup` sits inside `HttpClient.get` in replay mode, and an
 * await there would let a test's fake timers run between the request and its answer.
 */
export class ReplayStore {
  readonly dir: string;
  #manifest: ReplayManifest;
  /** Verified file bytes, by manifest `file` path — a fixture is hashed once per process. */
  readonly #bodies = new Map<string, Buffer>();

  constructor(dir: string, manifest?: ReplayManifest) {
    this.dir = resolveReplayDir(dir);
    this.#manifest = manifest ?? readManifest(this.dir);
  }

  /** The parsed manifest. Treat as read-only; `record()` is the only writer. */
  get manifest(): ReplayManifest {
    return this.#manifest;
  }

  /** Re-read `manifest.json` from disk (after an import, or between record-mode runs). */
  reload(): void {
    this.#manifest = readManifest(this.dir);
    this.#bodies.clear();
  }

  has(key: string): boolean {
    return this.#manifest[key] !== undefined;
  }

  entry(key: string): ManifestEntry | undefined {
    return this.#manifest[key];
  }

  /** The number of captures held under a key (§3.3: a session may walk successive captures). */
  captureCount(key: string): number {
    return this.#manifest[key]?.captures.length ?? 0;
  }

  /**
   * The recorded exchange for `key`, or `null` when there is none. `captureIndex` selects among
   * repeated captures of the same request (default `0`); an index past the end is a miss, not a
   * wrap-around, because a session that walks off the end of its captures must say so.
   *
   * @throws FixtureIntegrityError when the file on disk no longer matches its recorded sha256.
   */
  lookup(key: string, captureIndex = 0): RawRecord | null {
    const entry = this.#manifest[key];
    if (entry === undefined) return null;
    const capture = entry.captures[captureIndex];
    if (capture === undefined) return null;

    const body = this.#readBody(capture);
    return {
      providerId: entry.providerId,
      method: entry.method,
      url: entry.url,
      requestKey: key,
      requestHash: requestHash(entry.method, entry.url, entry.body),
      status: capture.status,
      headers: { ...capture.headers },
      body,
      capturedAt: Date.parse(capture.capturedAt),
      sha256: capture.sha256,
      sourceTs: capture.sourceTs === null ? null : new Date(capture.sourceTs),
      origin: 'replay',
    };
  }

  /**
   * Replay a request. **This is the wall** (§3.6): a miss throws, it never opens a socket.
   *
   * @throws ReplayMissError with the key it computed and the nearest recorded URL.
   */
  replay(req: {
    providerId: CaptureSourceId;
    method?: HttpMethod;
    url: string;
    body?: string;
    captureIndex?: number;
  }): RawRecord {
    const method = req.method ?? 'GET';
    const canonical = canonicalUrl(req.url);
    const key = requestKey(req.providerId, method, canonical, req.body);
    const record = this.lookup(key, req.captureIndex ?? 0);
    if (record === null) {
      throw new ReplayMissError(
        req.providerId,
        method,
        canonical,
        key,
        this.nearest(req.providerId, canonical),
      );
    }
    return record;
  }

  /**
   * The capture for the same provider whose canonical URL is closest to `url` — which turns "a
   * query parameter drifted" from a twenty-minute hunt into a one-line diff (§3.6).
   */
  nearest(providerId: CaptureSourceId, url: string): NearestCapture | null {
    const target = canonicalUrl(url);
    let best: NearestCapture | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    // Sorted so a tie is resolved by key, not by object-property order.
    for (const key of Object.keys(this.#manifest).sort()) {
      const entry = this.#manifest[key]!;
      if (entry.providerId !== providerId) continue;
      const distance = editDistance(target, entry.url);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { url: entry.url, key };
      }
    }
    return best;
  }

  /**
   * Record mode (§3.5): append a capture and write the bytes to
   * `raw/<providerId>/<requestKey>.<ext>`. A capture whose sha256 is already held under the key is
   * skipped; a different sha256 is **appended**, never overwritten, so a recording session can
   * capture a symbol ticking. `304` responses are not recorded — there is nothing new to store.
   *
   * @returns the capture that is now in the manifest (existing or new), or `null` for a skipped 304.
   * @throws Error when the body exceeds {@link MAX_CAPTURE_BYTES}.
   */
  record(raw: RawRecord, options: RecordOptions = {}): ManifestCapture | null {
    if (raw.status === 304) return null;
    if (raw.body.length > MAX_CAPTURE_BYTES) {
      throw new Error(
        `refusing to record ${raw.body.length} bytes from ${raw.url}: the replay store caps a ` +
          `capture at ${MAX_CAPTURE_BYTES} bytes (PROVIDERS.a §3.5)`,
      );
    }

    const key = raw.requestKey;
    const existing = this.#manifest[key];
    const already = existing?.captures.find((capture) => capture.sha256 === raw.sha256);
    if (already !== undefined) return already;

    const ext = extensionForContentType(raw.headers['content-type']);
    const file = join('raw', raw.providerId, `${key}.${ext}`);
    const absolute = join(this.dir, file);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, raw.body);

    const capture: ManifestCapture = {
      file,
      status: raw.status,
      bytes: raw.body.length,
      sha256: raw.sha256,
      capturedAt: isoInstant(new Date(raw.capturedAt)),
      sourceTs: raw.sourceTs === null ? null : isoInstant(raw.sourceTs),
      headers: { ...raw.headers },
    };
    if (options.note !== undefined) capture.note = options.note;

    if (existing === undefined) {
      const entry: ManifestEntry = {
        providerId: raw.providerId,
        method: raw.method,
        url: raw.url,
        captures: [capture],
      };
      if (options.body !== undefined) entry.body = options.body;
      this.#manifest[key] = entry;
    } else {
      existing.captures.push(capture);
    }

    this.#bodies.set(file, raw.body);
    writeManifest(this.dir, this.#manifest);
    return capture;
  }

  #readBody(capture: ManifestCapture): Buffer {
    const cached = this.#bodies.get(capture.file);
    if (cached !== undefined) return cached;
    const path = join(this.dir, capture.file);
    let body: Buffer;
    try {
      body = readFileSync(path);
    } catch (err) {
      throw new ManifestError(
        `fixture '${capture.file}' is referenced by manifest.json but cannot be read ` +
          `(${(err as Error).message})`,
      );
    }
    const actual = sha256Hex(body);
    if (actual !== capture.sha256)
      throw new FixtureIntegrityError(capture.file, capture.sha256, actual);
    this.#bodies.set(capture.file, body);
    return body;
  }
}

/** ISO-8601 UTC, seconds precision when the instant has no sub-second part (the manifest style). */
export function isoInstant(date: Date): string {
  const iso = date.toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso;
}

let shared: ReplayStore | undefined;

/**
 * The process-wide store over `REPLAY_DIR`. `dir` is for tests and the importer; the default comes
 * from the config, which is the only reader of the environment.
 */
export function openReplayStore(dir?: string): ReplayStore {
  if (dir !== undefined) return new ReplayStore(dir);
  return (shared ??= new ReplayStore(getConfig().REPLAY_DIR));
}

/** Test seam: drop the memoised store (pass a store to install one). */
export function setReplayStore(store: ReplayStore | undefined): void {
  shared = store;
}

/** Re-exported so `http.ts` and the adapters can narrow without importing `types.ts` twice. */
export type { ProviderId };
