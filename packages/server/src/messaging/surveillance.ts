/**
 * `messaging/surveillance.ts` — the MSG-02 lexicon scan over the WORM message log.
 *
 * `surveillance_lexicon` holds case-insensitive regexes, global (`firm_id IS NULL`) or per firm.
 * Every message body is scanned once and each matching term produces one `surveillance_hits` row
 * in state `open`, which a compliance reviewer moves to `escalated` or `cleared`. The unique
 * `(message_id, term_id)` key means a re-scan — a replay, a retry, a back-fill after a new term is
 * added — can never double-report the same message against the same term.
 *
 * Two deliberate restraints:
 *
 * - **A bad pattern is reported, not thrown.** A lexicon is edited by compliance, not by a
 *   programmer, and one unparseable regex must not stop the scan of a message against the other
 *   forty terms. An invalid or oversized pattern is skipped and handed to `onError`.
 * - **The scan is bounded.** Patterns are capped at {@link MAX_PATTERN_CHARS} and the body at
 *   `MAX_BODY_CHARS`, and each term is matched non-globally: one hit per term per message, with
 *   the matched text truncated for the review queue. A lexicon is untrusted input on a hot path,
 *   and unbounded backtracking over an 8,000-character body is a denial of service waiting to
 *   happen.
 *
 * RLS, and why the write goes through a function. `surveillance_hits` is readable only by
 * compliance, **of a firm that is in the room** (migration 0017 §17.d — the 0015 policy had no firm
 * predicate, so firm B's compliance officer could read and clear firm A's hits, `matched_text`
 * included, which is a verbatim excerpt of a message body they correctly could not read).
 *
 * The scan, though, has to run where the body is: inside the sender's transaction, whose
 * `app.role` is `'user'`. Under the plain policy every INSERT was refused, swallowed by the
 * savepoint, and handed to `onError` — the send succeeded and the compliance archive stayed empty.
 * So the write is made through `record_surveillance_hit`, a SECURITY DEFINER function owned by the
 * migration owner (0017 §17.e). It is deliberately a *writer only*: it appends one hit for a
 * message that exists, idempotently on `(message_id, term_id)`, and returns nothing, so the
 * sender's transaction gains no ability to read the review queue.
 */

import { sql } from 'drizzle-orm';

import type { Clock } from '@terminal/core';

import type { Db, Tx } from '../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type ReviewStatus = 'open' | 'escalated' | 'cleared';

export interface LexiconTerm {
  termId: number;
  /** `null` = the global list, applied to every firm. */
  firmId: number | null;
  pattern: string;
  severity: number;
  active: boolean;
  note: string | null;
}

/** One term matching one body, before it is written. */
export interface LexiconMatch {
  termId: number;
  severity: number;
  matchedText: string;
}

export interface SurveillanceHit extends LexiconMatch {
  hitId: number;
  messageId: number;
  detectedAt: string;
  reviewStatus: ReviewStatus;
  reviewerNote: string | null;
}

export interface ReviewInput {
  status: Exclude<ReviewStatus, 'open'>;
  reviewerUserId: number;
  note?: string;
}

export interface SurveillanceScanner {
  /** The active terms that apply to `firmId`: the global list plus that firm's own. */
  lexicon(firmId: number): Promise<LexiconTerm[]>;
  /** Pure: which terms match this body, in lexicon order. */
  scan(body: string, terms: readonly LexiconTerm[]): LexiconMatch[];
  /** Scan one message and record its hits. Idempotent on `(message_id, term_id)`. */
  scanMessage(input: { messageId: number; firmId: number; body: string }): Promise<LexiconMatch[]>;
  /** The open review queue, newest first. */
  open(limit?: number): Promise<SurveillanceHit[]>;
  /** Move a hit out of `open`. */
  review(hitId: number, input: ReviewInput): Promise<void>;
}

export interface SurveillanceDeps {
  db: Db | Tx;
  clock: Clock;
  onError?: (err: unknown, detail: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Bounds
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A lexicon pattern longer than this is a mistake, not a rule. */
export const MAX_PATTERN_CHARS = 512;
/** `messages.body` is capped at 8,000 characters (API.md §5.10); the scan never exceeds it. */
export const MAX_BODY_CHARS = 8_000;
/** What lands in `surveillance_hits.matched_text` — enough to review, not a second copy. */
export const MAX_MATCH_CHARS = 200;

const DEFAULT_QUEUE_LIMIT = 100;
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

interface TermRow {
  term_id: string;
  firm_id: string | null;
  pattern: string;
  severity: number;
  active: boolean;
  note: string | null;
}

interface HitRow {
  hit_id: string;
  message_id: string;
  term_id: string;
  severity: number;
  matched_text: string;
  detected_at: string;
  review_status: string;
  reviewer_note: string | null;
}

const asRows = <T>(result: { rows: unknown[] }): T[] => result.rows as T[];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The scanner
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function surveillanceScanner(deps: SurveillanceDeps): SurveillanceScanner {
  const db = deps.db;
  const report = deps.onError ?? ((): void => undefined);
  /** Compiled patterns, keyed by `termId:pattern` so an edited term recompiles. */
  const compiled = new Map<string, RegExp | null>();

  function regexFor(term: LexiconTerm): RegExp | null {
    const key = `${String(term.termId)}:${term.pattern}`;
    const seen = compiled.get(key);
    if (seen !== undefined) return seen;
    let built: RegExp | null = null;
    if (term.pattern.length > MAX_PATTERN_CHARS) {
      report(
        new Error(`pattern is ${String(term.pattern.length)} characters`),
        `surveillance: lexicon term ${String(term.termId)} is too long to compile`,
      );
    } else {
      try {
        built = new RegExp(term.pattern, 'i');
      } catch (err) {
        report(err, `surveillance: lexicon term ${String(term.termId)} is not a valid regex`);
      }
    }
    compiled.set(key, built);
    return built;
  }

  function scan(body: string, terms: readonly LexiconTerm[]): LexiconMatch[] {
    const text = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
    const hits: LexiconMatch[] = [];
    const seen = new Set<number>();
    for (const term of terms) {
      if (!term.active || seen.has(term.termId)) continue;
      const re = regexFor(term);
      if (re === null) continue;
      const match = re.exec(text);
      if (match === null) continue;
      seen.add(term.termId);
      hits.push({
        termId: term.termId,
        severity: term.severity,
        matchedText: match[0].slice(0, MAX_MATCH_CHARS),
      });
    }
    return hits;
  }

  async function lexicon(firmId: number): Promise<LexiconTerm[]> {
    const result = await db.execute(sql`
      SELECT term_id::text AS term_id, firm_id::text AS firm_id, pattern, severity, active, note
        FROM surveillance_lexicon
       WHERE active AND (firm_id IS NULL OR firm_id = ${firmId})
       ORDER BY severity DESC, term_id`);
    return asRows<TermRow>(result).map((row) => ({
      termId: Number(row.term_id),
      firmId: row.firm_id === null ? null : Number(row.firm_id),
      pattern: row.pattern,
      severity: row.severity,
      active: row.active,
      note: row.note,
    }));
  }

  return {
    lexicon,
    scan,

    async scanMessage(input): Promise<LexiconMatch[]> {
      const terms = await lexicon(input.firmId);
      const matches = scan(input.body, terms);
      if (matches.length === 0) return matches;
      const detectedAt = new Date(deps.clock.now()).toISOString();
      for (const match of matches) {
        await db.execute(sql`
          SELECT record_surveillance_hit(${input.messageId}::bigint, ${match.termId}::bigint,
                                         ${match.matchedText}::text,
                                         ${detectedAt}::timestamptz)`);
      }
      return matches;
    },

    async open(limit = DEFAULT_QUEUE_LIMIT): Promise<SurveillanceHit[]> {
      const capped = Math.min(Math.max(limit, 1), 1_000);
      const result = await db.execute(sql`
        SELECT h.hit_id::text AS hit_id, h.message_id::text AS message_id,
               h.term_id::text AS term_id, l.severity, h.matched_text,
               to_char(h.detected_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS detected_at,
               h.review_status, h.reviewer_note
          FROM surveillance_hits h
          JOIN surveillance_lexicon l ON l.term_id = h.term_id
          JOIN messages m ON m.message_id = h.message_id
         WHERE h.review_status = 'open'
           AND room_has_firm(m.room_id, app_firm_id())
         ORDER BY h.detected_at DESC, h.hit_id DESC
         LIMIT ${capped}`);
      return asRows<HitRow>(result).map((row) => ({
        hitId: Number(row.hit_id),
        messageId: Number(row.message_id),
        termId: Number(row.term_id),
        severity: row.severity,
        matchedText: row.matched_text,
        detectedAt: row.detected_at,
        reviewStatus: row.review_status as ReviewStatus,
        reviewerNote: row.reviewer_note,
      }));
    },

    /**
     * Move a hit out of `open`, for a room the reviewer's own firm is in.
     *
     * The firm predicate is restated here rather than left to the policy. RLS is the backstop; a
     * service that relies on it alone is one `SET LOCAL ROLE` away from a cross-firm write, and
     * the statement "a reviewer reviews their own firm's rooms" belongs where a reader of this
     * file can see it.
     */
    async review(hitId: number, input: ReviewInput): Promise<void> {
      await db.execute(sql`
        UPDATE surveillance_hits h
           SET review_status = ${input.status},
               reviewed_by = ${input.reviewerUserId},
               reviewed_at = ${new Date(deps.clock.now()).toISOString()}::timestamptz,
               reviewer_note = ${input.note ?? null}
         WHERE h.hit_id = ${hitId}
           AND EXISTS (SELECT 1 FROM messages m
                        WHERE m.message_id = h.message_id
                          AND room_has_firm(m.room_id, app_firm_id()))`);
    },
  };
}
