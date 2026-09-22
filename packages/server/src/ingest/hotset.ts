/**
 * The hot set — which subjects the real-time jobs poll this minute.
 * ARCHITECTURE §6.2 L798-800, §7.1; PROVIDERS §5.1 L688-692; WORKPLAN §WP-05 L813.
 *
 * ```
 * polled subjects = (subjects with ≥ 1 WS subscriber)
 *                 ∪ (watchlist members of connected users)
 *                 ∪ (always-on seed: WEI indices, VIX, benchmark Treasuries, G10 FX, SOFR/EFFR)
 * ordered by (subscriber count desc, last poll asc); a subject with no holder decays out 300 s
 * after the last one let go.
 * ```
 *
 * Three halves, three lifetimes, and that is the whole design:
 *
 *  * **subscribers** are in-memory and live: the WS gateway (WP-06) calls {@link HotSet.subscribe}
 *    / {@link HotSet.unsubscribe} as sessions come and go. Nothing is read from the database for
 *    this half — a subscription that exists for four seconds must never cost a query.
 *  * **connected users' watchlists** come from the database, refreshed on a cadence by
 *    {@link refreshWatchlistSubjects}. `watchlists` and `watchlist_items` carry RLS (DATA_MODEL
 *    §15), and an ingest transaction has no `app.*` identity, so a global scan as `terminal_app`
 *    would return **zero rows**. The read is therefore done **per connected user, under that
 *    user's own `RequestCtx`**, which is both the correct answer to "connected users' watchlists"
 *    and the only form the policies admit. The owner predicate is also written out in SQL so the
 *    result does not change when the caller happens to be a superuser (as it is in tests).
 *  * **the always-on seed** is held for ever, never decays, and is resolved from `md_lines`:
 *    every always-on name is named by the `(source_id, provider_symbol)` of the line that quotes
 *    it (PROVIDERS §5.1/§5.4/§7.1), which is a key this system already owns, rather than a ticker
 *    literal invented here. Keys that resolve to nothing are skipped — before WP-15's seed has
 *    run, most of them will, and a terminal with an empty seed set must still poll subscribers.
 *
 * Decay is what keeps the Cboe 4 req/s bucket spendable: a name nobody has looked at for five
 * minutes stops being polled. `subscribers > 0`, a watchlist membership, or the always-on seed all
 * hold a subject; when the last hold goes, the subject is retained for `decayMs` and then dropped.
 * The entry's `lastPolledAt` is dropped with it, so a re-subscribe polls it immediately.
 */

import { sql } from 'drizzle-orm';

import type { Clock } from '@terminal/core';

import { withTx } from '../db/client.js';

import type { RequestCtx, Tx } from '../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** ARCHITECTURE L800 / PROVIDERS §5.1 L692 — "decaying out 300 s after the last subscriber leaves". */
export const HOTSET_DECAY_MS = 300_000;

/**
 * How recently a session must have been seen to count as *connected*. `sessions.last_seen_at` is
 * touched on every request and on every WS heartbeat (API.md §2), so five minutes of silence is a
 * closed terminal — the same horizon as the decay, deliberately: a user who walks away stops
 * costing polls at one predictable moment rather than two.
 */
export const CONNECTED_SESSION_IDLE_MS = 300_000;

/**
 * One always-on seed name: the market-data line that quotes it. `md_lines (source_id,
 * provider_symbol)` is unique among open versions (`md_lines_symbol_excl`), so a key resolves to
 * at most one instrument.
 *
 * The list below is the five families of ARCHITECTURE L799. Every symbol in it is one the provider
 * sections name outright; nothing here is invented, and anything WP-15's seed does not create is
 * silently absent rather than an error.
 */
export interface AlwaysOnKey {
  readonly sourceId: string;
  readonly providerSymbol: string;
}

/**
 * The default always-on seed (ARCHITECTURE L799): WEI European indices (PROVIDERS §5.4 `BUK100P`),
 * VIX (§5.1 `_VIX`, the Cboe index form), the G10 FX pairs (§5.5/§13 Yahoo `=X` symbols), the
 * benchmark Treasury proxy (`^TNX`, §14.2) and the overnight rate fixings (§7.1 NY Fed types).
 *
 * Wiring may pass its own list; this one is the default so that an unconfigured process still
 * polls the screens (WEI, FX, rates) that must never be blank.
 */
export const ALWAYS_ON_SEED_KEYS: readonly AlwaysOnKey[] = [
  // WEI — Cboe European indices (§5.4).
  { sourceId: 'cboe.euIndices', providerSymbol: 'BUK100P' },
  // Volatility (§5.1: Cboe index symbols are underscore-prefixed).
  { sourceId: 'cboe.quotes', providerSymbol: '_VIX' },
  { sourceId: 'cboe.quotes', providerSymbol: '_SPX' },
  // G10 FX — Yahoo `=X` symbols (§13 `fxIntraday`).
  { sourceId: 'yahoo.chart', providerSymbol: 'EURUSD=X' },
  { sourceId: 'yahoo.chart', providerSymbol: 'USDJPY=X' },
  { sourceId: 'yahoo.chart', providerSymbol: 'GBPUSD=X' },
  { sourceId: 'yahoo.chart', providerSymbol: 'USDCHF=X' },
  { sourceId: 'yahoo.chart', providerSymbol: 'USDCAD=X' },
  { sourceId: 'yahoo.chart', providerSymbol: 'AUDUSD=X' },
  { sourceId: 'yahoo.chart', providerSymbol: 'NZDUSD=X' },
  { sourceId: 'yahoo.chart', providerSymbol: 'USDSEK=X' },
  { sourceId: 'yahoo.chart', providerSymbol: 'USDNOK=X' },
  // Benchmark Treasuries — the 10-year yield proxy of §14.2.
  { sourceId: 'yahoo.chart', providerSymbol: '^TNX' },
  // Overnight fixings (§7.1 `fedRates`).
  { sourceId: 'nyfed.rates', providerSymbol: 'SOFR' },
  { sourceId: 'nyfed.rates', providerSymbol: 'EFFR' },
];

/** A plant quote subject for an instrument — `data/request.ts#subjectFor(…, 'q')`. */
export function quoteSubject(instrumentId: number): string {
  return `q:${String(instrumentId)}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The set itself
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Why a subject is in the set. A subject may be held by more than one of them at once. */
export type HoldKind = 'subscriber' | 'watchlist' | 'always-on';

/** One subject's standing in the hot set. */
export interface HotSetEntry {
  readonly subject: string;
  /** Live WS subscribers (ARCHITECTURE L798). */
  readonly subscribers: number;
  /** On a connected user's watchlist as of the last refresh. */
  readonly watchlisted: boolean;
  /** In the always-on seed set. */
  readonly alwaysOn: boolean;
  /** Epoch ms of the last completed poll, `null` when it has never been polled. */
  readonly lastPolledAt: number | null;
  /** Epoch ms the subject first entered the set. */
  readonly firstSeenAt: number;
  /** Epoch ms the subject drops out unless something holds it again; `Infinity` while held. */
  readonly retainUntil: number;
}

interface MutableEntry {
  subject: string;
  subscribers: number;
  watchlisted: boolean;
  alwaysOn: boolean;
  lastPolledAt: number | null;
  firstSeenAt: number;
  retainUntil: number;
}

export interface HotSetDeps {
  clock: Clock;
  /** Grace after the last hold is released. Default {@link HOTSET_DECAY_MS}. */
  decayMs?: number;
  /** Subjects held for ever. May also be set later with {@link HotSet.setAlwaysOn}. */
  alwaysOn?: Iterable<string>;
}

/**
 * The polled-subject set. In-memory, single-process, and deliberately cheap: `subscribe` and
 * `unsubscribe` are O(1) and touch nothing outside this object.
 */
export class HotSet {
  readonly #clock: Clock;
  readonly #decayMs: number;
  readonly #entries = new Map<string, MutableEntry>();

  constructor(deps: HotSetDeps) {
    this.#clock = deps.clock;
    this.#decayMs = deps.decayMs ?? HOTSET_DECAY_MS;
    if (this.#decayMs < 0 || !Number.isFinite(this.#decayMs)) {
      throw new RangeError(`HotSet: decayMs must be a finite, non-negative duration`);
    }
    if (deps.alwaysOn !== undefined) this.setAlwaysOn(deps.alwaysOn);
  }

  /** A WS session subscribed to `subject` (ARCHITECTURE L798). */
  subscribe(subject: string, count = 1): void {
    if (count <= 0) return;
    const entry = this.#ensure(subject);
    entry.subscribers += count;
    this.#rehold(entry);
  }

  /**
   * A WS session let `subject` go. The subject stays in the set — and keeps being polled — until
   * the decay window closes, which is what stops a scroll through a grid from thrashing the poller.
   */
  unsubscribe(subject: string, count = 1): void {
    const entry = this.#entries.get(subject);
    if (entry === undefined) return;
    entry.subscribers = Math.max(0, entry.subscribers - count);
    this.#rehold(entry);
  }

  /** Live subscriber count, 0 for a subject that is not held by one. */
  subscriberCount(subject: string): number {
    return this.#entries.get(subject)?.subscribers ?? 0;
  }

  /** Replace the always-on seed wholesale. Seed subjects never decay. */
  setAlwaysOn(subjects: Iterable<string>): void {
    this.#replaceHold('always-on', subjects);
  }

  /**
   * Replace the watchlist half wholesale — the result of {@link refreshWatchlistSubjects}. A
   * subject that has dropped off every connected watchlist loses that hold and decays out unless
   * a subscriber or the seed still holds it.
   */
  setWatchlistSubjects(subjects: Iterable<string>): void {
    this.#replaceHold('watchlist', subjects);
  }

  /** Record a completed poll, which is what `(… , last poll asc)` orders on. */
  markPolled(subject: string, at?: number): void {
    const entry = this.#entries.get(subject);
    if (entry === undefined) return;
    entry.lastPolledAt = at ?? this.#clock.now();
  }

  /** True when the subject is currently polled (decayed entries are dropped first). */
  has(subject: string): boolean {
    this.prune();
    return this.#entries.has(subject);
  }

  /** Number of polled subjects. */
  get size(): number {
    this.prune();
    return this.#entries.size;
  }

  /**
   * The subjects to poll, in poll order: **subscriber count desc, last poll asc** (ARCHITECTURE
   * L800), never-polled first, then by subject so the order is total and a test is reproducible.
   */
  subjects(limit?: number): string[] {
    const ordered = this.entries().map((e) => e.subject);
    return limit === undefined ? ordered : ordered.slice(0, Math.max(0, limit));
  }

  /** {@link subjects} with the standing of each entry. */
  entries(): HotSetEntry[] {
    this.prune();
    return [...this.#entries.values()]
      .map((e): HotSetEntry => ({ ...e }))
      .sort((a, b) => {
        if (a.subscribers !== b.subscribers) return b.subscribers - a.subscribers;
        const ap = a.lastPolledAt ?? Number.NEGATIVE_INFINITY;
        const bp = b.lastPolledAt ?? Number.NEGATIVE_INFINITY;
        if (ap !== bp) return ap - bp;
        return a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0;
      });
  }

  /** Drop everything whose decay window has closed. Returns how many were dropped. */
  prune(now = this.#clock.now()): number {
    let dropped = 0;
    for (const [subject, entry] of this.#entries) {
      if (entry.retainUntil <= now) {
        this.#entries.delete(subject);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Forget everything. For a process that has lost leadership and will re-derive the set. */
  clear(): void {
    this.#entries.clear();
  }

  #ensure(subject: string): MutableEntry {
    const existing = this.#entries.get(subject);
    if (existing !== undefined) return existing;
    const now = this.#clock.now();
    const entry: MutableEntry = {
      subject,
      subscribers: 0,
      watchlisted: false,
      alwaysOn: false,
      lastPolledAt: null,
      firstSeenAt: now,
      retainUntil: now + this.#decayMs,
    };
    this.#entries.set(subject, entry);
    return entry;
  }

  /** Recompute the retention deadline after a hold changed. */
  #rehold(entry: MutableEntry): void {
    const held = entry.subscribers > 0 || entry.watchlisted || entry.alwaysOn;
    entry.retainUntil = held ? Number.POSITIVE_INFINITY : this.#clock.now() + this.#decayMs;
  }

  #replaceHold(kind: Exclude<HoldKind, 'subscriber'>, subjects: Iterable<string>): void {
    const next = new Set(subjects);
    const flag = kind === 'watchlist' ? 'watchlisted' : 'alwaysOn';
    for (const entry of this.#entries.values()) {
      if (entry[flag] && !next.has(entry.subject)) {
        entry[flag] = false;
        this.#rehold(entry);
      }
    }
    for (const subject of next) {
      const entry = this.#ensure(subject);
      entry[flag] = true;
      this.#rehold(entry);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The database halves
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A user with at least one live session — the identity their watchlists are read under. */
export interface ConnectedUser {
  userId: number;
  firmId: number;
  role: RequestCtx['role'];
  /** The most recent live session of that user, for the `RequestCtx` the read runs under. */
  sessionId: string;
}

export interface ConnectedUsersOptions {
  clock: Clock;
  /** How long a session may be silent and still count. Default {@link CONNECTED_SESSION_IDLE_MS}. */
  idleMs?: number;
}

/**
 * The users with a live session: not revoked, not expired, seen within `idleMs`.
 *
 * `sessions` carries no RLS policy (it is keyed by an opaque token hash and is read by the auth
 * path before an identity exists), so this one read is legitimately global — it is the *only*
 * global read the hot set does.
 */
export async function loadConnectedUsers(
  tx: Tx,
  opts: ConnectedUsersOptions,
): Promise<ConnectedUser[]> {
  const now = new Date(opts.clock.now());
  const idleMs = opts.idleMs ?? CONNECTED_SESSION_IDLE_MS;
  const since = new Date(opts.clock.now() - idleMs);

  const rows = await tx.execute<{
    user_id: string | number;
    firm_id: string | number;
    role: string;
    session_id: string;
  }>(sql`
    SELECT DISTINCT ON (u.user_id)
           u.user_id, u.firm_id, u.role, s.session_id
      FROM sessions s
      JOIN users u ON u.user_id = s.user_id
     WHERE s.revoked_at IS NULL
       AND s.expires_at > ${now}
       AND s.last_seen_at >= ${since}
       AND u.status = 'active'
     ORDER BY u.user_id, s.last_seen_at DESC
  `);

  return rows.rows.map((row) => ({
    userId: Number(row.user_id),
    firmId: Number(row.firm_id),
    role: row.role as RequestCtx['role'],
    sessionId: row.session_id,
  }));
}

export interface WatchlistSubjectsOptions {
  /**
   * Read on this transaction instead of opening one per user. The caller then owns the identity:
   * RLS still applies, so `app.user_id` must already be that user's (or the caller must be a role
   * RLS does not apply to, which is what the test harness is). Without it, each user's watchlists
   * are read in their own `withTx(ctx, …)`.
   */
  tx?: Tx;
}

/**
 * The quote subjects on the watchlists of `users` — `q:<instrumentId>` per distinct instrument.
 *
 * Formula rows (`watchlist_items.formula IS NOT NULL`, CHRT-07) have no instrument and no subject
 * of their own; their inputs enter the hot set when the formula is evaluated, not here.
 */
export async function loadWatchlistSubjects(
  users: readonly ConnectedUser[],
  opts: WatchlistSubjectsOptions = {},
): Promise<string[]> {
  const subjects = new Set<string>();

  for (const user of users) {
    const read = async (tx: Tx): Promise<void> => {
      const rows = await tx.execute<{ instrument_id: string | number }>(sql`
        SELECT DISTINCT wi.instrument_id
          FROM watchlist_items wi
          JOIN watchlists w ON w.watchlist_id = wi.watchlist_id
         WHERE wi.instrument_id IS NOT NULL
           AND w.owner_user_id = ${user.userId}
      `);
      for (const row of rows.rows) subjects.add(quoteSubject(Number(row.instrument_id)));
    };

    if (opts.tx !== undefined) {
      await read(opts.tx);
    } else {
      await withTx(
        {
          userId: user.userId,
          firmId: user.firmId,
          role: user.role,
          sessionId: user.sessionId,
        },
        read,
      );
    }
  }

  return [...subjects].sort();
}

/**
 * Resolve always-on seed keys to subjects through the **current** `md_lines` versions. A key with
 * no open line — the normal state before WP-15's seed has run — contributes nothing.
 */
export async function resolveAlwaysOnSubjects(
  tx: Tx,
  keys: readonly AlwaysOnKey[] = ALWAYS_ON_SEED_KEYS,
): Promise<string[]> {
  if (keys.length === 0) return [];
  const sourceIds = keys.map((k) => k.sourceId);
  const symbols = keys.map((k) => k.providerSymbol);

  const rows = await tx.execute<{ instrument_id: string | number }>(sql`
    SELECT DISTINCT m.instrument_id
      FROM md_lines m
      JOIN unnest(${sql.param(sourceIds)}::text[], ${sql.param(symbols)}::text[])
             AS k(source_id, provider_symbol)
        ON k.source_id = m.source_id AND k.provider_symbol = m.provider_symbol
     WHERE m.tx_to = 'infinity' AND m.valid_to = 'infinity'
  `);

  return rows.rows.map((row) => quoteSubject(Number(row.instrument_id))).sort();
}

export interface RefreshOptions extends ConnectedUsersOptions {
  /** Run every read on this transaction (see {@link WatchlistSubjectsOptions.tx}). */
  tx?: Tx;
  /** Also re-resolve the always-on seed. Default `false` — the seed changes at seed time, not hourly. */
  alwaysOnKeys?: readonly AlwaysOnKey[];
}

/**
 * One refresh of the database-backed halves: connected users → their watchlists → the hot set,
 * and optionally the always-on seed. The subscriber half is untouched.
 *
 * @returns the subjects installed, for logging and for the caller's own assertions.
 */
export async function refreshWatchlistSubjects(
  hotset: HotSet,
  opts: RefreshOptions,
): Promise<{ users: ConnectedUser[]; watchlist: string[]; alwaysOn: string[] }> {
  const read = async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    opts.tx !== undefined ? fn(opts.tx) : withTx(null, fn);

  const users = await read((tx) => loadConnectedUsers(tx, opts));
  const watchlist = await loadWatchlistSubjects(
    users,
    opts.tx !== undefined ? { tx: opts.tx } : {},
  );
  hotset.setWatchlistSubjects(watchlist);

  let alwaysOn: string[] = [];
  const keys = opts.alwaysOnKeys;
  if (keys !== undefined) {
    alwaysOn = await read((tx) => resolveAlwaysOnSubjects(tx, keys));
    hotset.setAlwaysOn(alwaysOn);
  }

  return { users, watchlist, alwaysOn };
}
