/**
 * `search/snapshot.ts` — the universe snapshot behind `GET /api/v1/universe/snapshot`
 * (API.md §5.2 L438-488, TERM-02, WORKPLAN WP-08 L1076-1078).
 *
 * The terminal's command line ranks **locally**: the browser downloads this payload once, builds a
 * `core/command/index.ts#UniverseIndex` from it in a Worker, and every keystroke after that is
 * answered in ≤ 4 ms without a round trip (FUNCTIONS.md §3.1, §3.5). The server is consulted only
 * for a name query of three characters or more that the local index could not answer
 * (`search/rank.ts`). So this file has exactly one job, and it is a *bytes and cache* job: produce
 * the one payload the client indexes, and make every repeat request free.
 *
 * ## Three decisions worth stating
 *
 * **1. The ETag is a hash of the content, not of the build.** `generatedAt` is deliberately NOT in
 * the hash. If it were, a server restart — or the freshness rebuild below — would mint a new ETag
 * for a byte-identical universe, every client would re-download several megabytes, and the 304
 * path would only ever fire within a single process lifetime. Hashing the content alone means two
 * processes that read the same `instruments` rows serve the same ETag, which is what makes
 * `Cache-Control: private, max-age=3600` plus `If-None-Match` worth having.
 *
 * **2. The payload is serialized once, at build time, and served as a string.** `body` is the exact
 * JSON of the wire shape (`sdk/wire/rest/search.ts#UniverseSnapshot`). At the seeded scale — ≈36 k
 * instruments — re-serializing per request would burn tens of milliseconds of CPU and a multi-MB
 * allocation on a payload that is identical for every caller in the firm. The tuple arrays are kept
 * alongside it because `search/rank.ts` needs them to build its own `UniverseIndex` for the server
 * fallback, and building that from the parsed arrays beats re-parsing the string.
 *
 * **3. Invalidation is `config_versions('universe')`, not a TTL.** That row is bumped by the
 * symbology refresh job (`ingest/jobs/universeSymbolBook.ts` L470) whenever it writes an instrument.
 * `get()` reads one primary-key row to decide whether the cached build is still current; the 36 k-row
 * scan and the serialization happen only when the version actually moved. `freshnessMs` widens that
 * check into a window for a caller that would rather not touch the database at all on a hot path;
 * it defaults to `0`, which is one indexed single-row `SELECT` per request and no staleness window.
 *
 * ## What is in it, and what is not
 *
 * Four entity kinds, exactly the four the command line completes to (FUNCTIONS.md §3.2):
 * instruments, functions, people and topics. Option contracts are excluded — there are ≈3.5 k per
 * underlying and they are reached through `OMON` or by typing the OCC form, which the server
 * resolves (`core/search/types.ts`, FUNCTIONS.md §3.1 L871-873). Delisted and matured instruments
 * ARE included with `status: 0`: the ranker penalises them by −30 rather than hiding them, because
 * a user who types a dead ticker deserves to be told it is dead instead of getting nothing.
 *
 * Functions come from the injected `FunctionRegistry`, not from the database: the catalogue is code
 * (`core/functions/manifests/`), and a registry that disagrees with the running binary would
 * autocomplete to a function this build cannot run.
 */

import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type {
  Clock,
  FunctionRegistry,
  UniverseFunctionTuple,
  UniverseInstrumentTuple,
  UniversePersonTuple,
  UniverseSnapshot as WireUniverseSnapshot,
  UniverseTopicTuple,
} from '@terminal/core';

import type { Db, Tx } from '../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One built snapshot, held in memory until `config_versions('universe')` moves.
 *
 * `version`, `generatedAt` and the four tuple arrays are the wire shape of API.md §5.2 verbatim.
 * Everything after them is server-side bookkeeping and is NOT part of the payload — `body` is,
 * byte for byte, what the route writes.
 */
export interface UniverseSnapshot {
  /** sha1 of the content, hex. Doubles as the payload's `version` field. */
  version: string;
  /** The `ETag` header value, quoted: `"<version>"`. */
  etag: string;
  /** ISO-8601 instant this build ran, from the injected clock. Not part of `version`. */
  generatedAt: string;
  instruments: readonly UniverseInstrumentTuple[];
  functions: readonly UniverseFunctionTuple[];
  people: readonly UniversePersonTuple[];
  topics: readonly UniverseTopicTuple[];

  /** The serialized wire payload — send this, do not re-stringify the arrays. */
  readonly body: string;
  /** `Buffer.byteLength(body, 'utf8')` — uncompressed. */
  readonly bytes: number;
  /** `config_versions('universe').version` this build was made at. */
  readonly configVersion: number;
}

export interface UniverseSnapshotStats {
  /** Full rebuilds since construction. */
  builds: number;
  /** `get()` calls served from the cached build. */
  hits: number;
  /** Version probes that found `config_versions('universe')` unchanged. */
  freshChecks: number;
  /** Probes skipped because the freshness window had not elapsed. */
  windowSkips: number;
  /** The current build, or `null` before the first one. */
  current: {
    version: string;
    configVersion: number;
    bytes: number;
    instruments: number;
    functions: number;
    people: number;
    topics: number;
  } | null;
}

export interface UniverseSnapshotCache {
  /** The current snapshot, rebuilding it when the universe version moved. */
  get(): Promise<UniverseSnapshot>;
  /** Drop the cached build; the next `get()` rebuilds unconditionally. */
  invalidate(): void;
  stats(): UniverseSnapshotStats;
}

export interface UniverseSnapshotDeps {
  db: Db | Tx;
  clock: Clock;
  /** The catalogue. `registry.all()` becomes the `functions` array. */
  registry: FunctionRegistry;
  /**
   * How long a version probe stays good for, in milliseconds. `0` (the default) probes on every
   * `get()`: one primary-key row, and no window in which a bumped universe is served stale.
   */
  freshnessMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row shapes as the driver returns them (bigint and numeric columns arrive as strings)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface InstrumentSqlRow {
  instrument_id: string;
  ticker: string;
  market_sector: UniverseInstrumentTuple[2];
  exch_code: string;
  name: string;
  asset_class: UniverseInstrumentTuple[5];
  search_weight: number | string;
  status: string;
}

interface PersonSqlRow {
  person_id: string;
  name: string;
  role: string | null;
  issuer_name: string | null;
}

interface TopicSqlRow {
  code: string;
  name: string;
}

/** The only `instruments.status` value that autocompletes without the −30 penalty. */
const ACTIVE = 'active';

/** `·` — the separator the terminal renders between a person's role and their firm (API.md §5.2). */
const DOT = ' · ';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ETag helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Does `If-None-Match` cover `etag`?
 *
 * RFC 9110 §13.1.2: a comma-separated list of entity tags, or `*`. Weak comparison is the right
 * one for `If-None-Match`, so a `W/` prefix on either side is stripped before comparing. Exported
 * because `http/routes/universe.ts` is the caller and this is the part that is easy to get subtly
 * wrong — a route that compares the raw header string never answers 304 for a client that sends
 * two tags, or one that weakens the tag through a proxy.
 */
export function etagMatches(ifNoneMatch: string | undefined | null, etag: string): boolean {
  if (typeof ifNoneMatch !== 'string') return false;
  const header = ifNoneMatch.trim();
  if (header.length === 0) return false;
  if (header === '*') return true;
  const want = stripWeak(etag);
  for (const raw of header.split(',')) {
    if (stripWeak(raw.trim()) === want) return true;
  }
  return false;
}

function stripWeak(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function universeSnapshot(deps: UniverseSnapshotDeps): UniverseSnapshotCache {
  const { db, clock, registry } = deps;
  const freshnessMs = Math.max(0, deps.freshnessMs ?? 0);

  let current: UniverseSnapshot | null = null;
  /** Epoch ms of the last version probe (or build); `-Infinity` forces the next one. */
  let checkedAtMs = Number.NEGATIVE_INFINITY;
  /** Serialises rebuilds: two concurrent `get()`s share one build rather than racing. */
  let building: Promise<UniverseSnapshot> | undefined;

  let builds = 0;
  let hits = 0;
  let freshChecks = 0;
  let windowSkips = 0;

  async function rows<R>(query: ReturnType<typeof sql>): Promise<R[]> {
    const result = await db.execute(query);
    return result.rows as unknown as R[];
  }

  /** `config_versions('universe').version`, or `0` when nothing has bumped it yet. */
  async function readConfigVersion(): Promise<number> {
    const found = await rows<{ version: string }>(
      sql`SELECT version::text AS version FROM config_versions WHERE name = 'universe'`,
    );
    if (found.length === 0) return 0;
    return Number(found[0]?.version ?? 0);
  }

  async function build(): Promise<UniverseSnapshot> {
    // Version FIRST, for the same reason `licenceRegistry.load()` reads it first: a bump that
    // lands between the row read and the version read must leave the cached version BEHIND the
    // data, so the next probe rebuilds. Reading it after would cache a version that claims to
    // cover writes this build did not see.
    const configVersion = await readConfigVersion();
    const nowMs = clock.now();
    const nowIso = new Date(nowMs).toISOString();

    const instrumentRows = await rows<InstrumentSqlRow>(sql`
      SELECT instrument_id::text AS instrument_id, ticker, market_sector, exch_code, name,
             asset_class, search_weight, status
        FROM instruments
       WHERE tx_to = 'infinity'
         AND valid_from <= ${nowIso}::timestamptz
         AND valid_to   >  ${nowIso}::timestamptz
         AND asset_class <> 'option'
       ORDER BY instrument_id`);

    // `people.issuer_id` is a plain bigint by convention, not an FK, so the join is on the
    // issuer's own current bitemporal row rather than a constraint.
    const personRows = await rows<PersonSqlRow>(sql`
      SELECT p.person_id::text AS person_id, p.name, p.role, i.name AS issuer_name
        FROM people p
        LEFT JOIN issuers i
               ON i.issuer_id = p.issuer_id
              AND i.tx_to = 'infinity'
              AND i.valid_from <= ${nowIso}::timestamptz
              AND i.valid_to   >  ${nowIso}::timestamptz
       WHERE p.tx_to = 'infinity'
         AND p.valid_from <= ${nowIso}::timestamptz
         AND p.valid_to   >  ${nowIso}::timestamptz
       ORDER BY p.person_id`);

    const topicRows = await rows<TopicSqlRow>(sql`SELECT code, name FROM topics ORDER BY code`);

    const instruments: UniverseInstrumentTuple[] = instrumentRows.map((r) => [
      Number(r.instrument_id),
      r.ticker,
      r.market_sector,
      r.exch_code,
      r.name,
      r.asset_class,
      Number(r.search_weight),
      r.status === ACTIVE ? 1 : 0,
    ]);

    const functions: UniverseFunctionTuple[] = registry
      .all()
      .map((m) => [m.code, m.name, [...m.aliases], m.tier] as UniverseFunctionTuple)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const people: UniversePersonTuple[] = personRows.map((r) => [
      Number(r.person_id),
      r.name,
      roleFirm(r.role, r.issuer_name),
    ]);

    const topics: UniverseTopicTuple[] = topicRows.map((r) => [r.code, r.name]);

    // The hash covers the content and nothing else — see decision 1 in the module docstring. The
    // content JSON is also the tail of the body, so the payload is stringified exactly once.
    const contentJson = JSON.stringify({ instruments, functions, people, topics });
    const version = createHash('sha1').update(contentJson).digest('hex');
    const head = `{"version":${JSON.stringify(version)},"generatedAt":${JSON.stringify(nowIso)},`;
    const body = head + contentJson.slice(1);

    builds += 1;
    checkedAtMs = nowMs;

    const snapshot: UniverseSnapshot = {
      version,
      etag: `"${version}"`,
      generatedAt: nowIso,
      instruments,
      functions,
      people,
      topics,
      body,
      bytes: Buffer.byteLength(body, 'utf8'),
      configVersion,
    };
    current = snapshot;
    return snapshot;
  }

  /** One build at a time, whoever asks. */
  function buildOnce(): Promise<UniverseSnapshot> {
    building ??= build().finally(() => {
      building = undefined;
    });
    return building;
  }

  return {
    async get(): Promise<UniverseSnapshot> {
      const held = current;
      if (held === null) return buildOnce();

      const nowMs = clock.now();
      if (freshnessMs > 0 && nowMs - checkedAtMs < freshnessMs) {
        windowSkips += 1;
        hits += 1;
        return held;
      }

      const version = await readConfigVersion();
      checkedAtMs = nowMs;
      if (version === held.configVersion) {
        freshChecks += 1;
        hits += 1;
        return held;
      }
      current = null;
      return buildOnce();
    },

    invalidate(): void {
      current = null;
      checkedAtMs = Number.NEGATIVE_INFINITY;
    },

    stats(): UniverseSnapshotStats {
      const held = current;
      return {
        builds,
        hits,
        freshChecks,
        windowSkips,
        current:
          held === null
            ? null
            : {
                version: held.version,
                configVersion: held.configVersion,
                bytes: held.bytes,
                instruments: held.instruments.length,
                functions: held.functions.length,
                people: held.people.length,
                topics: held.topics.length,
              },
      };
    },
  };
}

/** `'CFO · Apple Inc'`, `'CFO'`, `'Apple Inc'` or `''` — whichever halves exist (API.md §5.2). */
function roleFirm(role: string | null, issuerName: string | null): string {
  const parts: string[] = [];
  if (typeof role === 'string' && role.length > 0) parts.push(role);
  if (typeof issuerName === 'string' && issuerName.length > 0) parts.push(issuerName);
  return parts.join(DOT);
}

/**
 * The payload as the client's `UniverseIndex.build()` wants it — the wire shape without this
 * module's bookkeeping. `http/routes/universe.ts` sends `snapshot.body`; this is for a caller that
 * wants the object (the server's own fallback index, and the tests).
 */
export function wireSnapshot(s: UniverseSnapshot): WireUniverseSnapshot {
  return {
    version: s.version,
    generatedAt: s.generatedAt,
    instruments: s.instruments,
    functions: s.functions,
    people: s.people,
    topics: s.topics,
  };
}
