/**
 * Ticker plant — **WP-01 stub**. Owned by WP-06 (ARCHITECTURE §6, WORKPLAN §1.8 L370-371).
 *
 * The real plant keeps the in-memory `QuoteState` per subject, applies normalised updates, drives
 * the conflators and answers entitlement-filtered snapshots. This file exists so `app.ts`,
 * `index.ts` and the test harness can be written, compiled and run now: `buildPlant` returns a
 * plant that is permanently `degraded` with no subjects, and every read throws
 * `NotImplementedError` rather than inventing a quote.
 *
 * WP-06 replaces the body. The exported shape (`Plant`, `buildPlant`) is what `app.ts` depends on;
 * widen it there rather than changing the call sites.
 */

import type { Clock } from '@terminal/core';

import type { Config } from '../config.js';
import { NotImplementedError } from '../http/errors.js';

/** ARCHITECTURE §11 / `StatusResponse.plant.state`. */
export type PlantState = 'ok' | 'degraded';

export interface PlantDeps {
  config: Config;
  clock: Clock;
}

/**
 * The subset of the plant that the HTTP side uses. WP-06 adds the `PlantReader` / `PlantBus`
 * halves (snapshot views for resolvers, the publish bus for the WS gateway).
 */
export interface Plant {
  /** `ok` once the warm start of ARCHITECTURE §12.1 step 6 has run and a poll has succeeded. */
  readonly state: PlantState;
  /** `true` when the plant can serve snapshots — the `plant` field of `GET /health`. */
  ready(): boolean;
  /** Number of live subjects (`StatusResponse.plant.subjects`). */
  subjectCount(): number;
  /** Warm from `quote_snapshots` and start the conflators (startup step 6). */
  start(): Promise<void>;
  /** Stop the conflators; safe to call when never started (SIGTERM). */
  stop(): Promise<void>;
  /** Entitlement-filtered snapshot of one subject — WP-06. */
  snapshot(subject: string): never;
  /** Entitlement-filtered snapshots of many subjects — WP-06. */
  snapshotMany(subjects: readonly string[]): never;
}

/** Build the (stub) plant. WP-06 replaces the implementation, not the signature. */
export function buildPlant(deps: PlantDeps): Plant {
  // Referenced so the stub keeps the real constructor's dependencies honest and lint-clean.
  void deps.clock;
  void deps.config;
  let started = false;

  return {
    get state(): PlantState {
      return 'degraded';
    },
    ready(): boolean {
      // The stub never becomes ready: `/health` reports `plant: false` and `status: 'degraded'`,
      // which is the truth until WP-06 lands.
      return false;
    },
    subjectCount(): number {
      return 0;
    },
    async start(): Promise<void> {
      started = true;
      await Promise.resolve();
    },
    async stop(): Promise<void> {
      started = false;
      await Promise.resolve();
    },
    snapshot(subject: string): never {
      void started;
      throw new NotImplementedError(`plant/tickerPlant.ts#snapshot(${subject}) — WP-06`);
    },
    snapshotMany(subjects: readonly string[]): never {
      throw new NotImplementedError(
        `plant/tickerPlant.ts#snapshotMany(${subjects.length} subjects) — WP-06`,
      );
    },
  };
}
