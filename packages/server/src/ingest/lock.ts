/**
 * Leader election for the ingest scheduler — ARCHITECTURE §7.1 L1005-1006, WORKPLAN §WP-05 L810.
 *
 * > leader election via `pg_try_advisory_lock(hashtext('ingest-leader'))` so a second process
 * > never double-runs
 *
 * Two terminal servers behind a load balancer both hold the whole job table in memory. Only one of
 * them may run it: two `cboeQuotes` runs a second apart would double the Cboe bucket spend, write
 * two `ingest_runs` rows for one logical poll, and race each other's `quote_ticks` upserts. The
 * arbiter is Postgres, because it is the one thing both processes already share.
 *
 * **Session-scoped, not transaction-scoped.** `pg_try_advisory_lock` (as opposed to
 * `pg_advisory_xact_lock`) holds until it is unlocked or the session ends, which is exactly the
 * lifetime leadership needs: the scheduler acquires once and keeps it across thousands of
 * transactions. The consequence is that the lock is pinned to **one connection**, so this module
 * checks a client out of the pool and holds it for as long as it is leader. That connection issues
 * one statement per acquisition and nothing else; it is never handed to drizzle.
 *
 * **Crash safety comes free.** If the leader process dies, its connection dies with it, Postgres
 * releases the advisory lock, and the next `tryAcquireLeaderLock` on any other process succeeds on
 * its next tick. There is no lease to expire and no heartbeat to miss.
 *
 * **`hashtext` is deliberate.** Advisory locks are keyed by a `bigint`; `hashtext('ingest-leader')`
 * is how the design fixes that number without a magic constant, and it is what every process in
 * the fleet computes, so the key cannot drift between deployments. `hashtext` is a Postgres
 * internal function rather than a documented one, which is why the key is written once, here.
 */

import type pg from 'pg';

import { getPool } from '../db/client.js';

/** The advisory-lock key text, hashed by Postgres. ARCHITECTURE L1005. */
export const LEADER_LOCK_KEY = 'ingest-leader';

/** A held session-level advisory lock. Release it, or end the process, to give up leadership. */
export interface LeaderLock {
  /** The key text this lock was taken on. */
  readonly key: string;
  /** False once {@link release} has run, or once the underlying connection has died. */
  held(): boolean;
  /** Unlock and return the connection to the pool. Safe to call more than once. */
  release(): Promise<void>;
}

/** What the scheduler asks each tick until it becomes leader. */
export interface LeaderElection {
  /** `null` when another session already holds the lock. */
  acquire(): Promise<LeaderLock | null>;
}

export interface LeaderLockOptions {
  /** Defaults to the application pool (`db/client.ts#getPool`). */
  pool?: pg.Pool;
  /** Defaults to {@link LEADER_LOCK_KEY}. Tests use a per-file key so they cannot collide. */
  key?: string;
  /** Called when the connection holding the lock dies — leadership is gone, not merely idle. */
  onLost?: (err: Error) => void;
}

interface TryLockRow {
  locked: boolean;
}

/**
 * Try to become the ingest leader.
 *
 * @returns the held lock, or `null` when another session has it. Never throws for contention —
 *          only for a database that cannot be reached, which the caller reports as a failed tick.
 */
export async function tryAcquireLeaderLock(
  opts: LeaderLockOptions = {},
): Promise<LeaderLock | null> {
  const pool = opts.pool ?? getPool();
  const key = opts.key ?? LEADER_LOCK_KEY;

  const client = await pool.connect();
  let result: pg.QueryResult<TryLockRow>;
  try {
    result = await client.query<TryLockRow>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [
      key,
    ]);
  } catch (err) {
    client.release();
    throw err;
  }

  if (result.rows[0]?.locked !== true) {
    // Someone else is leader. Give the connection straight back: a follower holds nothing.
    client.release();
    return null;
  }

  let live = true;
  const onError = (err: Error): void => {
    // The connection carrying the lock has gone. Postgres has already released the lock; all we
    // can do is stop claiming we hold it, so the next tick tries again.
    if (!live) return;
    live = false;
    opts.onLost?.(err);
  };
  client.on('error', onError);

  return {
    key,
    held: () => live,
    async release(): Promise<void> {
      if (!live) return;
      live = false;
      client.removeListener('error', onError);
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      } catch {
        // The connection is already broken, which means the lock is already gone. Nothing to undo.
      } finally {
        client.release();
      }
    },
  };
}

/** The default election the scheduler uses: one attempt per tick against the application pool. */
export function pgLeaderElection(opts: LeaderLockOptions = {}): LeaderElection {
  return { acquire: () => tryAcquireLeaderLock(opts) };
}

/**
 * An election that always succeeds, for a single-process context that has no peers — `db:seed`,
 * a one-shot CLI run, a unit test of the tick logic. Never use it in the server: the whole point
 * of the real one is that the second process loses.
 */
export function unlockedLeaderElection(key = LEADER_LOCK_KEY): LeaderElection {
  return {
    acquire: async (): Promise<LeaderLock> => {
      let live = true;
      return Promise.resolve({
        key,
        held: () => live,
        release: async (): Promise<void> => {
          live = false;
          await Promise.resolve();
        },
      });
    },
  };
}
