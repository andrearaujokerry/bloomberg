/**
 * `replay/harness.ts` — plant session replay (ARCHITECTURE §8.2 L1078-1091, FEED-08, QA-02).
 *
 * A session is a directory under `fixtures/sessions/<name>/`:
 *
 *  - `events.ndjson`      one line per thing that happened, at a `tOffsetMs` from the session start;
 *  - `subscriptions.json` the clock, the provenance table, the generated feed (when there is one)
 *                         and the reference subscribers — their subjects, fields, tiers and
 *                         `conflationMs`;
 *  - `expected.ndjson`    the state log of the last accepted run.
 *
 * {@link replaySession} builds a real plant on a {@link VirtualClock}, drives the real adapters and
 * normalisers through the replay store at the recorded offsets, runs the real `ws/conflator.ts` for
 * each reference subscriber, and returns the state log: the session header, one `poll` record per
 * replayed capture, one `change` record per applied composite change `(subject, seq, changedFields,
 * ts.src)`, one `frame` record per outbound WS frame per subscriber, and a `stats` footer.
 *
 * **Why this can be bit-identical (FEED-08).** Every instant comes from the `VirtualClock`: the
 * clock is moved to each event's own offset and never reads the platform clock, the normalisers are
 * pure functions of recorded bytes, the sim feed is a seeded `xoshiro128ss` stream
 * (`providers/sim/prng.ts`), and every collection this module iterates is either an array in
 * declaration order or a `Map` whose insertion order is fixed by the event order. There is no
 * `Date.now()`, no `Math.random()`, no timer and no `readdirSync` order in the replay path —
 * `listSessions` is the one directory read and it sorts. Three non-determinism defects in this
 * build were all of that shape and all passed for a long time before failing, so the rule here is
 * absolute rather than a preference.
 *
 * **Ties.** A subscriber flush due at the same millisecond as an event fires *after* that event:
 * offsets are the session's script, and a tie resolved the other way would silently drop the last
 * tick of a session into the next (never emitted) window. The tail is drained up to the declared
 * `endOffsetMs`, which is why a session states its own end rather than inferring one.
 *
 * **What is deliberately NOT in the log.** `PlantStats.publishLatencyP99Ms` is a *measurement*
 * (`pub − cap`), not state: with `cap` from a 2026 capture and `pub` from the virtual clock the
 * number is arithmetically reproducible but means nothing, and a budget belongs in a bench file.
 * Encoded frame *byte counts* are left out for a sharper reason — they are a function of how many
 * digits `ts.cap`/`ts.pub` happen to have, and ARCHITECTURE §8.2 requires the diff to ignore
 * exactly those two fields, so comparing bytes would smuggle them back in.
 *
 * **DEVIATION from ARCHITECTURE §8.2.** The sentence "plus the function-output matrix (every
 * manifest × seed securities) at the session end" is not implemented here and this module has no
 * flag for it. That matrix is a statement about REST payload = CSV export = WS snapshot over the
 * *seeded database* (API-05), which is `packages/server/test/parity/fn-parity.test.ts` — it needs a
 * seeded Postgres, the function registry and the entitlement evaluator, none of which a session
 * replay has or should acquire: the harness is offline and database-free by construction, which is
 * what lets `harness.test.ts` run a whole session in milliseconds. Recording the matrix here would
 * also make every session's `expected.ndjson` a hostage to the seed's row counts. The parity test
 * owns that comparison; this module owns the plant state log.
 */

import { emptyMask, maskOf, maskToIds, VirtualClock } from '@terminal/core';
import type { AssetClass, FieldId, FieldValue, SessionState, Tier } from '@terminal/core';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { getConfig, type Config } from '../config.js';
import { buildPlant, type Plant, type PlantEvent } from '../plant/tickerPlant.js';
import { normaliseEuIndex, normaliseQuote } from '../providers/cboe/parse.js';
import { openReplayStore, type ReplayStore } from '../providers/replayStore.js';
import { SimFeed, simRequestKey, type SimSubject } from '../providers/sim/feed.js';
import { Conflator, type Subscription } from '../ws/conflator.js';

import type { NormaliseContext, NormaliseLine, Normalised, RawRecord } from '../providers/types.js';
import type { ServerMsg } from '@terminal/sdk/wire/ws';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Format version
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * State-log format version, written into the header record and compared by the differ.
 *
 * It exists so that changing the *shape* of the log is a loud, one-line divergence ("the format
 * changed, re-accept the sessions") instead of five hundred quiet ones. Bump it whenever a record
 * type gains, loses or renames a field.
 */
export const STATE_LOG_VERSION = 1;

/** Smallest `conflationMs` the protocol accepts (`ClientMsg.hello.conflationMs`, API.md §6.2). */
const MIN_CONFLATION_MS = 50;

/**
 * Hard ceiling on flushes drained in one session, so a malformed `endOffsetMs`/`conflationMs` pair
 * fails with a message rather than hanging a test runner.
 */
const MAX_FLUSHES = 100_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `subscriptions.json`
// ─────────────────────────────────────────────────────────────────────────────────────────────

const TIERS = ['realtime', 'delayed', 'eod'] as const satisfies readonly Tier[];

const ASSET_CLASSES = [
  'equity',
  'etf',
  'index',
  'option',
  'future',
  'govt',
  'rate',
  'fx',
  'crypto',
  'econ',
] as const satisfies readonly AssetClass[];

const SESSION_STATES = [
  'pre',
  'open',
  'post',
  'closed',
  'halted',
  'auction',
  'unknown',
] as const satisfies readonly SessionState[];

const SUBJECT = z.string().regex(/^[a-z0-9]+:[A-Za-z0-9_.:-]+$/, 'not a plant subject');

/**
 * One synthetic `provenance` row. The harness has no database, so DATA-10 is carried here instead:
 * every event names a `provenanceId`, every declared id names the `requestKey` of the fixture the
 * values came from, and {@link replaySession} refuses a session where those two do not line up. A
 * replayed number with no fixture behind it is a defect however plausible it looks.
 */
const ProvenanceDecl = z.object({
  provenanceId: z.number().int().min(1),
  sourceId: z.string().min(1),
  /** The `fixtures/providers/manifest.json` key, or `sim:<seed>:<startMs>` for a generated feed. */
  requestKey: z.string().min(1),
});

/** An `md_lines` row, by `provider_symbol` — what a normaliser resolves a payload against. */
const LineDecl = z.object({
  providerSymbol: z.string().min(1),
  mdLineId: z.number().int().min(1),
  instrumentId: z.number().int().min(1),
  assetClass: z.enum(ASSET_CLASSES),
  tier: z.enum(TIERS),
  intrinsicDelayMin: z.number().int().min(0),
  expectedIntervalMs: z.number().int().min(1),
  priority: z.number().int(),
});

const SimSubjectDecl = z.object({
  subject: SUBJECT,
  instrumentId: z.number().int().min(1),
  mdLineId: z.number().int().min(1),
  assetClass: z.enum(ASSET_CLASSES),
  tier: z.enum(TIERS),
  px0: z.number().positive(),
  annualVolPct: z.number().min(0),
  spreadBp: z.number().min(0),
  avgTradeSize: z.number().positive(),
  calendarId: z.string().min(1),
  tickSize: z.number().positive().optional(),
});

/** The generated feed of a `sim-*` session (WP-05 `providers/sim/prng.ts`, deterministic by seed). */
const FeedDecl = z.object({
  seed: z.number().int(),
  rateHz: z.number().positive(),
  provenanceId: z.number().int().min(1),
  subjects: z.array(SimSubjectDecl).min(1),
  /** Pins the session resolver so a session is not a hostage to the exchange calendar tables. */
  session: z.enum(SESSION_STATES).optional(),
});

const SubscriptionDecl = z.object({
  subject: SUBJECT,
  /** Subscribed field ids in request order; empty means "every field the subject carries". */
  fields: z.array(z.string().min(1)),
  tier: z.enum(TIERS),
  /** `false` is the first thing shed under backpressure (API.md §6.5). */
  essential: z.boolean().default(true),
});

const ThresholdsDecl = z.object({
  softBytes: z.number().int().min(0).optional(),
  hardBytes: z.number().int().min(0).optional(),
  graceMs: z.number().int().min(0).optional(),
  maxMs: z.number().int().min(0).optional(),
  eodFloorMs: z.number().int().min(0).optional(),
  frameCapBytes: z.number().int().min(1).optional(),
});

const SubscriberDecl = z.object({
  id: z.string().min(1),
  conflationMs: z.number().int().min(MIN_CONFLATION_MS).max(5_000),
  subjects: z.array(SubscriptionDecl).min(1),
  thresholds: ThresholdsDecl.optional(),
});

export const SessionDefinition = z.object({
  /** Must equal the directory name; a copied session that forgot to be renamed is a mistake. */
  name: z.string().min(1),
  /** ISO instant the `VirtualClock` starts at. Every `tOffsetMs` is relative to it. */
  startAt: z.string().min(1),
  /** The last instant the harness drains flushes at; must be ≥ the last event's offset. */
  endOffsetMs: z.number().int().min(0),
  /** Why this session exists and, for a generated one, why it is not recorded. Documentation. */
  notes: z.string().min(1),
  provenance: z.array(ProvenanceDecl).min(1),
  lines: z.array(LineDecl).default([]),
  feed: FeedDecl.optional(),
  subscribers: z.array(SubscriberDecl).min(1),
});

export type SessionDefinition = z.infer<typeof SessionDefinition>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `events.ndjson`
// ─────────────────────────────────────────────────────────────────────────────────────────────

const OFFSET = z.number().int().min(0);

/** A recorded provider exchange: `{ tOffsetMs, providerId, requestKey }` of ARCHITECTURE §8.2. */
const CaptureEvent = z.object({
  kind: z.literal('capture'),
  tOffsetMs: OFFSET,
  providerId: z.string().min(1),
  requestKey: z.string().min(1),
  /** Walks successive captures of one key (`ReplayStore.lookup`, PROVIDERS §3.3). Default `0`. */
  captureIndex: z.number().int().min(0).optional(),
  provenanceId: z.number().int().min(1),
  /** The session at capture time, from the instrument calendar. Absent means "not stated". */
  session: z.enum(SESSION_STATES).optional(),
});

/** Pump the generated feed up to this instant. Requires `feed` in `subscriptions.json`. */
const SimEvent = z.object({ kind: z.literal('sim'), tOffsetMs: OFFSET });

/** A non-quote publication: news (queued, NEWS-01), an econ release, `sys:status`. */
const PublishEvent = z.object({
  kind: z.literal('publish'),
  tOffsetMs: OFFSET,
  subject: SUBJECT,
  fields: z.record(z.string().min(1), z.union([z.number(), z.string(), z.boolean(), z.null()])),
  provenanceId: z.number().int().min(1),
  /** `ts.src` — the provider-published instant, `null` when the payload states none. */
  src: z.number().int().nullable(),
  /** Default: `true` for the `n:` family, `false` otherwise — the plant's own rule. */
  queued: z.boolean().optional(),
  assetClass: z.enum(ASSET_CLASSES).optional(),
  session: z.enum(SESSION_STATES).optional(),
});

/** Move a subscriber's `socket.bufferedAmount`: the input to the §6.5 backpressure ladder. */
const BufferedEvent = z.object({
  kind: z.literal('buffered'),
  tOffsetMs: OFFSET,
  subscriber: z.string().min(1),
  bytes: z.number().int().min(0),
});

/** `plant.forceResync` — the plant asking every session to re-snapshot (BUS-07). */
const ResyncEvent = z.object({
  kind: z.literal('resync'),
  tOffsetMs: OFFSET,
  subjects: z.array(SUBJECT).optional(),
});

/**
 * The client's re-`sub` after a server-initiated resync. It is an explicit event rather than
 * something the harness does by itself, because in production it is a round trip the *client*
 * chooses to make (API.md §6.3 step 7) and a session should script it, not assume it.
 */
const SubEvent = z.object({
  kind: z.literal('sub'),
  tOffsetMs: OFFSET,
  subscriber: z.string().min(1),
  subject: SUBJECT,
});

/** A viewport change (`essential`), which decides what a shed takes away (API.md §6.8). */
const EssentialEvent = z.object({
  kind: z.literal('essential'),
  tOffsetMs: OFFSET,
  subscriber: z.string().min(1),
  subjects: z.array(SUBJECT).min(1),
  essential: z.boolean(),
});

export const SessionEvent = z.discriminatedUnion('kind', [
  CaptureEvent,
  SimEvent,
  PublishEvent,
  BufferedEvent,
  ResyncEvent,
  SubEvent,
  EssentialEvent,
]);

export type SessionEvent = z.infer<typeof SessionEvent>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// State-log records
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** First line of every state log: what was replayed, and against which fixtures. */
export interface HeaderRecord {
  r: 'session';
  name: string;
  version: number;
  startMs: number;
  endOffsetMs: number;
  events: number;
  /** The provenance table, by ascending id — the DATA-10 audit trail of the run. */
  prov: { id: number; sourceId: string; requestKey: string }[];
  subscribers: string[];
}

/** One replayed provider exchange and what the real normaliser made of it. */
export interface PollRecord {
  r: 'poll';
  at: number;
  providerId: string;
  requestKey: string;
  captureIndex: number;
  updates: number;
  /** Normaliser problem kinds, sorted and de-duplicated: a normaliser never throws (§1.2). */
  problems: string[];
}

/** One applied composite change — ARCHITECTURE §8.2's `(subject, seq, changedFields, ts.src)`. */
export interface ChangeRecord {
  r: 'change';
  subject: string;
  seq: number;
  changed: FieldId[];
  src: number | null;
  /** Ignored by the differ (§8.2); written so a log is readable on its own. */
  cap: number;
  /** Ignored by the differ (§8.2). */
  pub: number;
  queued: boolean;
  resync: boolean;
}

/** One outbound WS frame, per reference subscriber, in emission order. */
export interface FrameRecord {
  r: 'frame';
  sub: string;
  n: number;
  at: number;
  frame: unknown;
}

/** The session footer. No latency and no byte counts — see this module's header comment. */
export interface StatsRecord {
  r: 'stats';
  updatesApplied: number;
  updatesDroppedStaleSeq: number;
  subjects: number;
  subscribers: {
    id: string;
    frames: number;
    subjects: number;
    effectiveMs: number;
    dirty: number;
  }[];
}

export type StateLogRecord = HeaderRecord | PollRecord | ChangeRecord | FrameRecord | StatsRecord;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Canonical JSON
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A value with every object key sorted by code point, recursively.
 *
 * `JSON.stringify` serialises keys in insertion order, so two runs that build the same frame by
 * different code paths (a `snap` assembled field by field, the same `snap` read back from a file)
 * would differ byte for byte while being the same state. Sorting removes the whole class.
 * `localeCompare` is deliberately not used: it is locale-dependent, which is the defect this
 * function exists to prevent.
 */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const v = source[key];
    if (v === undefined) continue;
    out[key] = canonical(v);
  }
  return out;
}

/**
 * A copy of `source` without the keys whose value is `undefined`.
 *
 * `zod`'s `.optional()` produces a type whose keys are *present and possibly undefined*, while
 * `exactOptionalPropertyTypes` makes an absent optional genuinely absent. The two disagree exactly
 * here — a `thresholds` object parsed from a session file would otherwise hand
 * `{ softBytes: undefined }` to `new Conflator(...)`, which is a different thing from omitting it.
 */
function definedOnly<T extends object>(source: T): { [K in keyof T]?: NonNullable<T[K]> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out as { [K in keyof T]?: NonNullable<T[K]> };
}

/** NDJSON text of a state log: one canonical JSON object per line, trailing newline. */
export function serialiseStateLog(records: readonly StateLogRecord[]): string {
  return records.map((record) => JSON.stringify(canonical(record))).join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Session directories
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Resolve `fixtures/sessions` to an absolute directory.
 *
 * The same two-plausible-bases problem `providers/replayStore.ts#resolveReplayDir` documents: a
 * process may be started from the repository root (`npm test`) or from `packages/server`
 * (`npm run dev`). The candidates are tried in a fixed order and the first that exists wins, so a
 * miss reports a stable path rather than one that depends on the working directory.
 */
export function sessionsDir(dir?: string): string {
  if (dir !== undefined && isAbsolute(dir)) return dir;
  const relative = dir ?? 'fixtures/sessions';
  // `src/replay/harness.ts` → `packages/server`; identical from `dist/replay/…`.
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  const repoRoot = resolve(packageRoot, '../..');
  const candidates = [
    resolve(repoRoot, relative),
    resolve(packageRoot, relative),
    resolve(process.cwd(), relative),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/** Committed session names, sorted — `readdirSync` order is filesystem-dependent and never trusted. */
export function listSessions(dir?: string): string[] {
  const root = sessionsDir(dir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .filter((name) => existsSync(join(root, name, 'subscriptions.json')))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface LoadedSession {
  name: string;
  dir: string;
  definition: SessionDefinition;
  /** Events in `tOffsetMs` order; ties keep their file order (a stable sort). */
  events: SessionEvent[];
  startMs: number;
}

/** Thrown for anything wrong with a session on disk. The message names the file. */
export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

function parseNdjson(path: string, text: string): unknown[] {
  const out: unknown[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      throw new SessionError(
        `${path}:${String(i + 1)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/** Read and validate `fixtures/sessions/<name>/`. Nothing is replayed yet. */
export function loadSession(name: string, dir?: string): LoadedSession {
  const root = join(sessionsDir(dir), name);
  const defPath = join(root, 'subscriptions.json');
  const eventsPath = join(root, 'events.ndjson');
  if (!existsSync(defPath)) throw new SessionError(`${defPath} does not exist`);
  if (!existsSync(eventsPath)) throw new SessionError(`${eventsPath} does not exist`);

  let document: unknown;
  try {
    document = JSON.parse(readFileSync(defPath, 'utf8'));
  } catch (err) {
    throw new SessionError(
      `${defPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = SessionDefinition.safeParse(document);
  if (!parsed.success) {
    throw new SessionError(`${defPath} is not a session definition: ${parsed.error.message}`);
  }
  const definition = parsed.data;
  if (definition.name !== name) {
    throw new SessionError(
      `${defPath} names "${definition.name}" but sits in "${name}" — a copied session must be renamed`,
    );
  }

  const startMs = Date.parse(definition.startAt);
  if (Number.isNaN(startMs)) {
    throw new SessionError(`${defPath}: startAt "${definition.startAt}" is not an ISO instant`);
  }

  const raw = parseNdjson(eventsPath, readFileSync(eventsPath, 'utf8'));
  const events: SessionEvent[] = raw.map((line, i) => {
    const event = SessionEvent.safeParse(line);
    if (!event.success) {
      throw new SessionError(
        `${eventsPath}:${String(i + 1)} is not a session event: ${event.error.message}`,
      );
    }
    return event.data;
  });
  if (events.length === 0) throw new SessionError(`${eventsPath} holds no events`);

  // A stable sort by offset: `Array.prototype.sort` has been stable since ES2019, so two events at
  // the same offset keep the order the file put them in — which is the only order a session author
  // can express for a tie.
  const ordered = [...events].sort((a, b) => a.tOffsetMs - b.tOffsetMs);
  const last = ordered[ordered.length - 1]!;
  if (last.tOffsetMs > definition.endOffsetMs) {
    throw new SessionError(
      `${defPath}: endOffsetMs ${String(definition.endOffsetMs)} is before the last event at ` +
        `${String(last.tOffsetMs)} ms — the tail would never be flushed`,
    );
  }

  return { name, dir: root, definition, events: ordered, startMs };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Normalisers
// ─────────────────────────────────────────────────────────────────────────────────────────────

type QuoteNormaliser = (
  raw: RawRecord,
  ctx: NormaliseContext,
  options: { session?: SessionState },
) => Normalised<unknown>;

/**
 * Provider id → the normaliser whose output reaches `plant.apply`.
 *
 * Only the adapters that produce *plant updates* belong here. Most of the 48 captures are reference
 * or history payloads (SEC facts, FRED series, the symbol book) whose normalisers produce rows for
 * an ingest job and nothing for the plant, so a session event naming one of them is a mistake worth
 * an error rather than a silent empty poll.
 */
const NORMALISERS: Readonly<Record<string, QuoteNormaliser>> = {
  'cboe.quotes': (raw, ctx, options) =>
    normaliseQuote(raw, ctx, options.session === undefined ? {} : { session: options.session }),
  'cboe.euIndices': (raw, ctx, options) =>
    normaliseEuIndex(raw, ctx, options.session === undefined ? {} : { session: options.session }),
};

/** The provider ids a session may name in a `capture` event, sorted. */
export function replayableProviderIds(): string[] {
  return Object.keys(NORMALISERS).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reference subscribers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One reference subscriber: the **real** `ws/conflator.ts` plus the fifteen lines of `ws/session.ts`
 * that stand between the plant fan-out and it (`#onPlantEvent`, `resyncFromServer`).
 *
 * Those lines are mirrored rather than imported because `WsSession` is a socket, an auth context, a
 * usage-event batcher and a set of platform timers, none of which a replay has. The conflator — the
 * part that decides what goes on the wire — is the shipped class, unmodified.
 */
class ReferenceSubscriber {
  readonly id: string;
  readonly conflator: Conflator;
  /** Frames in emission order, the log's `frame` records. */
  readonly frames: { at: number; frame: ServerMsg }[] = [];

  /** `socket.bufferedAmount`, moved only by a `buffered` event. */
  buffered = 0;
  /** Next virtual instant this subscriber's flush timer fires. */
  nextFlushMs: number;
  /** Subjects awaiting the client's re-`sub` after a server resync (`ws/session.ts#suppressed`). */
  readonly suppressed = new Set<string>();

  readonly #declared = new Map<string, z.infer<typeof SubscriptionDecl>>();
  readonly #clock: VirtualClock;

  constructor(
    decl: z.infer<typeof SubscriberDecl>,
    plant: Plant,
    clock: VirtualClock,
    startMs: number,
  ) {
    this.id = decl.id;
    this.#clock = clock;
    this.nextFlushMs = startMs + decl.conflationMs;
    this.conflator = new Conflator({
      plant,
      clock,
      requestedMs: decl.conflationMs,
      send: (frame) => {
        this.frames.push({ at: clock.now(), frame });
      },
      bufferedAmount: () => this.buffered,
      ...(decl.thresholds === undefined ? {} : { thresholds: definedOnly(decl.thresholds) }),
    });
    for (const sub of decl.subjects) {
      this.#declared.set(sub.subject, sub);
      this.conflator.add(this.#subscription(sub, startMs));
    }
  }

  #subscription(decl: z.infer<typeof SubscriptionDecl>, atMs: number): Subscription {
    return {
      subject: decl.subject,
      fieldMask: decl.fields.length === 0 ? emptyMask() : maskOf(decl.fields),
      fieldIds: [...decl.fields],
      lastSentSeq: 0,
      tier: decl.tier,
      essential: decl.essential,
      denied: new Map(),
      reason: 'OK',
      lastFlushMs: atMs,
    };
  }

  /** The client's re-`sub`: a fresh subscription, owed a `snap`, with `lastSentSeq` back at 0. */
  resubscribe(subject: string): void {
    const decl = this.#declared.get(subject);
    if (decl === undefined) {
      throw new SessionError(
        `subscriber "${this.id}" has no declared subscription for ${subject}; a sub event cannot invent one`,
      );
    }
    this.suppressed.delete(subject);
    this.conflator.add(this.#subscription(decl, this.#clock.now()));
  }

  setEssential(subjects: readonly string[], essential: boolean): void {
    for (const subject of subjects) {
      const sub = this.conflator.subs.get(subject);
      if (sub !== undefined) sub.essential = essential;
    }
  }

  /** `ws/session.ts#resyncFromServer`: drop the subscription, tell the client, wait for its re-`sub`. */
  resyncFromServer(subject: string): void {
    if (!this.conflator.subs.has(subject)) return;
    this.suppressed.add(subject);
    this.conflator.remove(subject);
    this.frames.push({ at: this.#clock.now(), frame: { t: 'resync', subjects: [subject] } });
  }

  /** `ws/session.ts#onPlantEvent`, verbatim in behaviour. */
  onPlantEvent(ev: PlantEvent, plant: Plant): void {
    if (!this.conflator.subs.has(ev.subject)) return;
    if (this.suppressed.has(ev.subject)) return;
    if (ev.resync === true) {
      this.resyncFromServer(ev.subject);
      return;
    }
    if (ev.queued) {
      // News is queued, never conflated: the state as published, so a headline cannot be
      // overwritten by the next one inside the window (NEWS-01).
      const snapshot = plant.snapshot(ev.subject);
      if (snapshot === undefined) this.conflator.markQueued(ev.subject, ev.seq);
      else this.conflator.markQueued(ev.subject, ev.seq, snapshot);
      return;
    }
    this.conflator.mark(ev.subject, ev.changed);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Replay
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ReplayOptions {
  /** Defaults to `getConfig()`; the plant reads nothing from it but takes it as a dependency. */
  config?: Config;
  /** Defaults to the process-wide store over `REPLAY_DIR`. */
  store?: ReplayStore;
  /** Overrides `fixtures/sessions`. */
  sessionsDir?: string;
}

export interface ReplayResult {
  session: LoadedSession;
  records: StateLogRecord[];
  /** NDJSON text of `records` — what `actual.ndjson` holds. */
  text: string;
}

/** Sorted, de-duplicated problem kinds of a normaliser run. */
function problemKinds(problems: readonly { kind: string }[]): string[] {
  return [...new Set(problems.map((p) => p.kind))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Replay a session and return its state log.
 *
 * Nothing here touches the network (`PROVIDER_MODE=replay` is a wall: a fixture miss throws,
 * FEED-08/QA-02), nothing touches a database, and nothing reads the platform clock.
 */
export function replaySession(session: LoadedSession, options: ReplayOptions = {}): ReplayResult {
  const { definition, events, startMs } = session;
  const config = options.config ?? getConfig();
  const store = options.store ?? openReplayStore();
  const clock = new VirtualClock(startMs);
  const plant = buildPlant({ config, clock });

  // ── the provenance table (DATA-10) ────────────────────────────────────────────────────────
  const provById = new Map<number, z.infer<typeof ProvenanceDecl>>();
  for (const row of definition.provenance) {
    if (provById.has(row.provenanceId)) {
      throw new SessionError(
        `${session.name}: provenanceId ${String(row.provenanceId)} is declared twice`,
      );
    }
    provById.set(row.provenanceId, row);
  }
  function provOf(id: number, what: string): z.infer<typeof ProvenanceDecl> {
    const row = provById.get(id);
    if (row === undefined) {
      throw new SessionError(
        `${session.name}: ${what} names provenanceId ${String(id)}, which subscriptions.json does ` +
          'not declare — every replayed value must point at the fixture it came from (DATA-10)',
      );
    }
    return row;
  }

  // ── md lines, by provider symbol ──────────────────────────────────────────────────────────
  const lines = new Map<string, NormaliseLine>();
  for (const line of definition.lines) {
    lines.set(line.providerSymbol, {
      mdLineId: line.mdLineId,
      instrumentId: line.instrumentId,
      assetClass: line.assetClass,
      tier: line.tier,
      intrinsicDelayMin: line.intrinsicDelayMin,
      expectedIntervalMs: line.expectedIntervalMs,
      priority: line.priority,
    });
  }

  // ── the generated feed ────────────────────────────────────────────────────────────────────
  let feed: SimFeed | null = null;
  if (definition.feed !== undefined) {
    const decl = definition.feed;
    const prov = provOf(decl.provenanceId, 'the generated feed');
    const expected = simRequestKey(decl.seed, startMs);
    if (prov.requestKey !== expected) {
      throw new SessionError(
        `${session.name}: the feed's provenance requestKey is "${prov.requestKey}" but seed ` +
          `${String(decl.seed)} at ${definition.startAt} produces "${expected}" — the run's ` +
          'identity and its provenance row must agree (DATA-10)',
      );
    }
    const pinned = decl.session;
    feed = new SimFeed(
      {
        seed: decl.seed,
        startMs,
        rateHz: decl.rateHz,
        subjects: decl.subjects as readonly SimSubject[],
        ...(pinned === undefined ? {} : { sessionOf: (): SessionState => pinned }),
      },
      { clock, plant, provenanceId: decl.provenanceId },
    );
    if (feed.problems.length > 0) {
      throw new SessionError(
        `${session.name}: the generated feed is misconfigured — ` +
          feed.problems.map((p) => p.detail).join('; '),
      );
    }
    feed.start();
  }

  // ── the reference subscribers ─────────────────────────────────────────────────────────────
  const subscribers = definition.subscribers.map(
    (decl) => new ReferenceSubscriber(decl, plant, clock, startMs),
  );
  const byId = new Map<string, ReferenceSubscriber>();
  for (const subscriber of subscribers) {
    if (byId.has(subscriber.id)) {
      throw new SessionError(`${session.name}: subscriber "${subscriber.id}" is declared twice`);
    }
    byId.set(subscriber.id, subscriber);
  }
  function subscriberOf(id: string): ReferenceSubscriber {
    const found = byId.get(id);
    if (found === undefined) {
      throw new SessionError(`${session.name}: no reference subscriber "${id}"`);
    }
    return found;
  }

  // ── the log ───────────────────────────────────────────────────────────────────────────────
  const changes: ChangeRecord[] = [];
  const polls: PollRecord[] = [];

  plant.subscribe((ev) => {
    const state = plant.get(ev.subject);
    changes.push({
      r: 'change',
      subject: ev.subject,
      seq: ev.seq,
      changed: maskToIds(ev.changed),
      src: state?.ts.src ?? null,
      cap: state?.ts.cap ?? 0,
      pub: state?.ts.pub ?? 0,
      queued: ev.queued,
      resync: ev.resync === true,
    });
    for (const subscriber of subscribers) subscriber.onPlantEvent(ev, plant);
  });

  // ── the timeline ──────────────────────────────────────────────────────────────────────────

  /**
   * Fire every flush due strictly before `beforeMs`, in (due instant, declaration order). Strictly
   * before, so a flush due at the same millisecond as an event happens after it — see the header.
   */
  let flushes = 0;
  function drainFlushes(beforeMs: number, inclusive: boolean): void {
    for (;;) {
      let next: ReferenceSubscriber | null = null;
      for (const subscriber of subscribers) {
        const due = inclusive
          ? subscriber.nextFlushMs <= beforeMs
          : subscriber.nextFlushMs < beforeMs;
        if (!due) continue;
        if (next === null || subscriber.nextFlushMs < next.nextFlushMs) next = subscriber;
      }
      if (next === null) return;
      flushes += 1;
      if (flushes > MAX_FLUSHES) {
        throw new SessionError(
          `${session.name}: more than ${String(MAX_FLUSHES)} flushes — endOffsetMs and conflationMs disagree`,
        );
      }
      clock.advanceTo(next.nextFlushMs);
      const outcome = next.conflator.flush();
      // `ws/session.ts#armFlush` re-arms on the CURRENT effectiveMs, so a widened interval takes
      // effect from the next window rather than retroactively (API.md §6.5).
      next.nextFlushMs += Math.max(outcome.effectiveMs, MIN_CONFLATION_MS);
    }
  }

  function applyCapture(event: z.infer<typeof CaptureEvent>): void {
    const normaliser = NORMALISERS[event.providerId];
    if (normaliser === undefined) {
      throw new SessionError(
        `${session.name}: provider "${event.providerId}" produces no plant updates; a capture ` +
          `event may name only ${replayableProviderIds().join(', ')}`,
      );
    }
    const prov = provOf(event.provenanceId, `the ${event.providerId} capture`);
    if (prov.requestKey !== event.requestKey) {
      throw new SessionError(
        `${session.name}: the capture at ${String(event.tOffsetMs)} ms replays requestKey ` +
          `${event.requestKey} but its provenance row points at ${prov.requestKey} (DATA-10)`,
      );
    }
    const captureIndex = event.captureIndex ?? 0;
    const raw = store.lookup(event.requestKey, captureIndex);
    if (raw === null) {
      throw new SessionError(
        `${session.name}: no capture ${String(captureIndex)} for requestKey ${event.requestKey} in ` +
          `${store.dir} — a replay miss is a hard stop, never a network call (FEED-08)`,
      );
    }
    if (raw.providerId !== event.providerId) {
      throw new SessionError(
        `${session.name}: requestKey ${event.requestKey} was captured from ${raw.providerId}, not ` +
          `${event.providerId}`,
      );
    }
    const ctx: NormaliseContext = {
      provenanceId: event.provenanceId,
      capturedAt: raw.capturedAt,
      lines,
    };
    const result = normaliser(
      raw,
      ctx,
      event.session === undefined ? {} : { session: event.session },
    );
    polls.push({
      r: 'poll',
      at: clock.now(),
      providerId: event.providerId,
      requestKey: event.requestKey,
      captureIndex,
      updates: result.updates.length,
      problems: problemKinds(result.problems),
    });
    for (const update of result.updates) plant.apply(update);
  }

  function applyPublish(event: z.infer<typeof PublishEvent>): void {
    const prov = provOf(event.provenanceId, `the publish to ${event.subject}`);
    // Sorted field ids: `plant.publish` stamps `fieldTs` while walking `Object.keys(fields)`, and a
    // session author's key order in a JSON file is not something a state log should depend on.
    const fields: Record<FieldId, FieldValue> = {};
    for (const key of Object.keys(event.fields).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const value = event.fields[key];
      if (value !== undefined) fields[key] = value;
    }
    const at = clock.now();
    plant.publish(event.subject, fields, {
      ts: { src: event.src, cap: at, pub: 0 },
      prov: { sourceId: prov.sourceId, provenanceId: event.provenanceId },
      ...(event.queued === undefined ? {} : { queued: event.queued }),
      ...(event.assetClass === undefined ? {} : { assetClass: event.assetClass }),
      ...(event.session === undefined ? {} : { session: event.session }),
    });
  }

  for (const event of events) {
    const at = startMs + event.tOffsetMs;
    drainFlushes(at, false);
    clock.advanceTo(at);
    switch (event.kind) {
      case 'capture':
        applyCapture(event);
        break;
      case 'sim':
        if (feed === null) {
          throw new SessionError(
            `${session.name}: a sim event at ${String(event.tOffsetMs)} ms needs a "feed" in subscriptions.json`,
          );
        }
        feed.pump();
        break;
      case 'publish':
        applyPublish(event);
        break;
      case 'buffered':
        subscriberOf(event.subscriber).buffered = event.bytes;
        break;
      case 'resync':
        plant.forceResync(event.subjects === undefined ? undefined : [...event.subjects]);
        break;
      case 'sub':
        subscriberOf(event.subscriber).resubscribe(event.subject);
        break;
      case 'essential':
        subscriberOf(event.subscriber).setEssential(event.subjects, event.essential);
        break;
    }
  }

  // The tail: every flush due up to and including the declared end of the session.
  drainFlushes(startMs + definition.endOffsetMs, true);
  clock.advanceTo(startMs + definition.endOffsetMs);
  if (feed !== null) feed.stop();

  const stats = plant.stats();
  const header: HeaderRecord = {
    r: 'session',
    name: session.name,
    version: STATE_LOG_VERSION,
    startMs,
    endOffsetMs: definition.endOffsetMs,
    events: events.length,
    prov: [...provById.values()]
      .sort((a, b) => a.provenanceId - b.provenanceId)
      .map((row) => ({ id: row.provenanceId, sourceId: row.sourceId, requestKey: row.requestKey })),
    subscribers: subscribers.map((s) => s.id),
  };
  const footer: StatsRecord = {
    r: 'stats',
    updatesApplied: stats.updatesApplied,
    updatesDroppedStaleSeq: stats.updatesDroppedStaleSeq,
    subjects: stats.subjects,
    subscribers: subscribers.map((subscriber) => ({
      id: subscriber.id,
      frames: subscriber.frames.length,
      subjects: subscriber.conflator.subs.size,
      effectiveMs: subscriber.conflator.effectiveMs,
      dirty: subscriber.conflator.dirtySize(),
    })),
  };

  // Log order: the header, then everything that happened in the order it happened, then the
  // footer. Polls, changes and frames are interleaved by their virtual instant, and a tie is
  // resolved poll → change → frame, which is cause before effect.
  const timeline: { at: number; rank: number; seq: number; record: StateLogRecord }[] = [];
  let ordinal = 0;
  for (const poll of polls) timeline.push({ at: poll.at, rank: 0, seq: ordinal++, record: poll });
  for (const change of changes) {
    timeline.push({ at: change.pub, rank: 1, seq: ordinal++, record: change });
  }
  for (const subscriber of subscribers) {
    subscriber.frames.forEach((entry, i) => {
      timeline.push({
        at: entry.at,
        rank: 2,
        seq: ordinal++,
        record: { r: 'frame', sub: subscriber.id, n: i + 1, at: entry.at, frame: entry.frame },
      });
    });
  }
  timeline.sort((a, b) => a.at - b.at || a.rank - b.rank || a.seq - b.seq);

  const records: StateLogRecord[] = [header, ...timeline.map((entry) => entry.record), footer];
  return { session, records, text: serialiseStateLog(records) };
}

/** Replay a session by name. */
export function replaySessionNamed(name: string, options: ReplayOptions = {}): ReplayResult {
  return replaySession(loadSession(name, options.sessionsDir), options);
}

/** Write a state log next to its session. Returns the absolute path. */
export function writeStateLog(
  session: LoadedSession,
  fileName: string,
  records: readonly StateLogRecord[],
): string {
  const path = join(session.dir, fileName);
  writeFileSync(path, serialiseStateLog(records), 'utf8');
  return path;
}

/** Read `<session>/<fileName>` as text, or `null` when it does not exist. */
export function readStateLogText(session: LoadedSession, fileName: string): string | null {
  const path = join(session.dir, fileName);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
