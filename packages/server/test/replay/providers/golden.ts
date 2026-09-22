/**
 * The golden-file shape shared by every `test/replay/providers/*.test.ts` — WORKPLAN WP-05's
 * QA-02 acceptance row ("`parse.ts` over the recorded fixture equals the committed
 * `fixtures/providers/normalised/<file>.json` golden").
 *
 * Not a test file (no `.test.ts` suffix), so Vitest does not collect it.
 *
 * ## Why a digest and not 25,135 rows of JSON
 *
 * A golden is only useful if a human reviews its diff. `sec-companyfacts-AAPL.json` normalises to
 * 25,116 `xbrl_facts` rows — about 7 MB of JSON, twice the size of the capture it came from, and a
 * diff nobody will ever read. So {@link toGolden} inlines an array up to
 * {@link INLINE_ROW_LIMIT} rows and replaces a larger one with a `$digest`:
 *
 * ```json
 * { "$digest": { "count": 25116, "sha256": "…", "first": [ …3 rows… ], "last": [ …3 rows… ] } }
 * ```
 *
 * The sha256 is taken over `canonicalJson` of the **whole** array, so the check is exactly as
 * strong as comparing every row — one changed character in one of 25,116 facts changes the digest
 * and fails the test — while the committed file stays reviewable: the counts, the first and last
 * rows, and every scalar the parser derived are all there in the open.
 *
 * Arrays at or under the limit — the 504 N-PORT holdings, the 505 SPDR rows, the 40 atom entries —
 * are inlined whole, so the goldens a reviewer actually reads are complete. The limit is 512
 * precisely so that those three land inside it and the 1,000-row filing index does not.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { canonicalJson, sha256Hex } from '@terminal/core';

import type { NormaliseContext, Normalised, RawRecord } from '../../../src/providers/types.js';

/** Arrays up to this length are committed row by row; longer ones become a `$digest`. */
export const INLINE_ROW_LIMIT = 512;

/** How many rows either end of a digested array carries, in the open. */
export const DIGEST_SAMPLE = 3;

export interface RowDigest {
  $digest: {
    count: number;
    /** `sha256Hex(canonicalJson(wholeArray))` — lower-case hex. */
    sha256: string;
    first: unknown[];
    last: unknown[];
  };
}

export interface ProviderGolden {
  /** The capture's file name under `fixtures/providers/raw/`. */
  capture: string;
  providerId: string;
  /** `replayStore.requestKey(...)` — ties the golden to the exact recorded exchange. */
  requestKey: string;
  adapterVersion: string;
  /** `provenance.source_ts`, ISO-8601 UTC, or `null`. */
  sourceTs: string | null;
  /** `NormalisedUpdate[]` length — 0 for every table-shaped source. */
  updateCount: number;
  /** Every problem the normaliser reported, in order. Never digested: there are never many. */
  problems: unknown[];
  /** `Normalised.rows`, with oversize arrays replaced by a {@link RowDigest}. */
  rows: unknown;
}

function digest(rows: readonly unknown[]): RowDigest {
  return {
    $digest: {
      count: rows.length,
      sha256: sha256Hex(canonicalJson(rows)),
      first: rows.slice(0, DIGEST_SAMPLE),
      last: rows.slice(Math.max(0, rows.length - DIGEST_SAMPLE)),
    },
  };
}

function compress(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length > INLINE_ROW_LIMIT ? digest(value) : value.map(compress);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = compress(inner);
    return out;
  }
  return value;
}

/** The committed shape, built from a `Normalised` and the capture it was parsed from. */
export function toGolden(
  capture: string,
  providerId: string,
  requestKey: string,
  adapterVersion: string,
  normalised: Normalised<unknown>,
): ProviderGolden {
  return {
    capture,
    providerId,
    requestKey,
    adapterVersion,
    sourceTs: normalised.sourceTs === null ? null : normalised.sourceTs.toISOString(),
    updateCount: normalised.updates.length,
    problems: normalised.problems.map((problem) => compress(problem)),
    rows: compress(normalised.rows),
  };
}

/** The committed serialisation: two-space indent, trailing newline — a reviewable diff. */
export function serialiseGolden(golden: ProviderGolden): string {
  return `${JSON.stringify(golden, null, 2)}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reading the committed goldens
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `fixtures/providers/normalised/<name>` as an absolute path.
 *
 * Five `..` from `packages/server/test/replay/providers/` is the repository root; resolved from
 * `import.meta.url` rather than from `process.cwd()`, because the runner's working directory is
 * the root and a developer's `vitest` invocation from `packages/server` is not.
 */
export function goldenPath(name: string): string {
  return fileURLToPath(
    new URL(`../../../../../fixtures/providers/normalised/${name}`, import.meta.url),
  );
}

/** The committed golden's exact text, newline and all. */
export function readGolden(name: string): string {
  return readFileSync(goldenPath(name), 'utf8');
}

/**
 * The `NormaliseContext` a replay test gives a normaliser: a provenance id the caller would have
 * inserted, the capture's own `capturedAt` (the only clock a normaliser sees — §1.2) and no md
 * lines, because no SEC or SSGA source ticks the plant.
 */
export function replayContext(raw: RawRecord): NormaliseContext {
  return { provenanceId: 1, capturedAt: raw.capturedAt, lines: new Map() };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// QA-05 — the corruptions every parse.ts must survive
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A deterministic set of broken bodies built from a real capture: empty, one byte, truncated at
 * several points, reversed, appended to, the HTML error page a rate-limited SEC or an unfamiliar
 * SSGA agent receives, and `mutations` copies with twenty random bytes rewritten.
 *
 * Seeded xorshift, not `Math.random`: a fuzz case that cannot be reproduced is a bug report nobody
 * can act on. `parse.ts` must return a parse-error result for every one of these and throw on none
 * of them (QA-05, PROVIDERS.a §1.2).
 */
export function corruptions(body: Buffer, mutations = 12): Buffer[] {
  let seed = 0x2545f491;
  const next = (): number => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 0x1_0000_0000;
  };

  const out: Buffer[] = [
    Buffer.alloc(0),
    Buffer.from('not a payload at all'),
    Buffer.from('{'),
    Buffer.from('[]'),
    Buffer.from('null'),
    Buffer.from('<!DOCTYPE html><html><body>Request Rate Threshold Exceeded</body></html>'),
    body.subarray(0, 1),
    body.subarray(0, Math.floor(body.length / 2)),
    body.subarray(0, body.length - 1),
    Buffer.concat([body, Buffer.from('trailing garbage')]),
    Buffer.from([...body].reverse()),
  ];
  for (let i = 0; i < mutations; i += 1) {
    const mutated = Buffer.from(body);
    for (let k = 0; k < 20; k += 1) {
      mutated[Math.floor(next() * mutated.length)] = Math.floor(next() * 256);
    }
    out.push(mutated);
    out.push(body.subarray(0, Math.floor(next() * body.length)));
  }
  return out;
}
