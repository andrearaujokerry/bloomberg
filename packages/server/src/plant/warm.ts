/**
 * Warm start (ARCHITECTURE §12.1 step 6, TERM-12, BUS-01).
 *
 * At startup the plant preloads the last composite `QuoteState` per subject from `quote_snapshots`
 * so screens are never blank — and marks every one of them `stale`, so they are never falsely
 * live: a snapshot written before the process died says nothing about the market now. The first
 * successful poll (live or replayed) is what moves a subject back to `live`, through the same
 * `core/quote/staleness.ts` verdict everything else uses.
 *
 * Rows whose subject no longer parses, or whose stored state disagrees with the row's subject,
 * are skipped rather than loaded: a plant seeded with an unparseable subject would publish it.
 */

import type { QuoteState } from '@terminal/core';

import type { PlantStore, SnapshotRow } from './store.js';
import { parseSubject } from './subjects.js';

export interface WarmRow {
  subject: string;
  seq: number;
  /** The stored state with `state: 'stale'` and `ageMs` left as stored (the sweep recomputes it). */
  state: QuoteState;
}

export interface WarmSkip {
  subject: string;
  reason: 'UNPARSEABLE_SUBJECT' | 'SUBJECT_MISMATCH' | 'BAD_STATE';
}

export interface WarmResult {
  rows: WarmRow[];
  /** Rows `readSnapshots` returned that were not loaded, with why. */
  skipped: WarmSkip[];
}

/** Preload from `quote_snapshots`: every subject `stale` until a poll succeeds. */
export async function warmPlant(store: Pick<PlantStore, 'readSnapshots'>): Promise<WarmResult> {
  const stored = await store.readSnapshots();
  return warmRows(stored);
}

/** The pure half of `warmPlant`, over rows already read. */
export function warmRows(stored: readonly SnapshotRow[]): WarmResult {
  const rows: WarmRow[] = [];
  const skipped: WarmResult['skipped'] = [];
  for (const row of stored) {
    if (parseSubject(row.subject) === null) {
      skipped.push({ subject: row.subject, reason: 'UNPARSEABLE_SUBJECT' });
      continue;
    }
    if (!looksLikeQuoteState(row.state)) {
      skipped.push({ subject: row.subject, reason: 'BAD_STATE' });
      continue;
    }
    if (row.state.subject !== row.subject) {
      skipped.push({ subject: row.subject, reason: 'SUBJECT_MISMATCH' });
      continue;
    }
    rows.push({
      subject: row.subject,
      seq: row.seq,
      state: { ...row.state, seq: row.seq, state: 'stale' },
    });
  }
  return { rows, skipped };
}

/** The jsonb came from `upsertSnapshot`, but a hand-edited row must not crash the warm start. */
function looksLikeQuoteState(v: unknown): v is QuoteState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<QuoteState>;
  return (
    typeof s.subject === 'string' &&
    typeof s.instrumentId === 'number' &&
    typeof s.seq === 'number' &&
    typeof s.fields === 'object' &&
    s.fields !== null &&
    typeof s.ts === 'object' &&
    s.ts !== null
  );
}
