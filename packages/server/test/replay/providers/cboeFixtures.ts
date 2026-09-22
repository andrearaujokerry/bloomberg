/**
 * The deterministic inputs behind the four Cboe replay suites and their goldens (QA-02).
 *
 * The captures are read **through the replay store**, never with `node:fs`: that is what verifies
 * each fixture's recorded `sha256`, what proves the request keys in `manifest.json` are the ones
 * the adapters build, and what makes `PROVIDER_MODE=replay` a wall rather than a preference
 * (PROVIDERS.a §3.6). The goldens under `fixtures/providers/normalised/` are read with `node:fs` —
 * they are committed expectations, not provider bytes.
 *
 * Every id here is a literal. `normalise` is pure, so the only way the golden can move is if the
 * parser's output moves, which is exactly what the suites are for. `packages/server/test/replay`
 * runs in the `server-replay` project (a migrated database is available), but nothing in these
 * suites touches it: the parsers take bytes and a context, and that is all.
 *
 * Goldens are written as **compact** JSON with a trailing newline. Two of the six are large
 * (3,510 contracts; 35,618 symbols) and an indented form would add megabytes to the repository for
 * a file no one reads by eye — the suites assert the structure, field by field, in prose.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AssetClass, Tier } from '@terminal/core';

import {
  cboeEuIndexUrl,
  cboeOptionsUrl,
  cboeQuoteUrl,
  CBOE_SYMBOL_BOOK_URL,
} from '../../../src/providers/cboe/adapter.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import type {
  CaptureSourceId,
  NormaliseContext,
  NormaliseLine,
  RawRecord,
} from '../../../src/providers/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `fixtures/providers/normalised/` — the committed parse expectations. */
export const GOLDEN_DIR = join(HERE, '../../../../../fixtures/providers/normalised');

export const store = openReplayStore();

/** Read one recorded capture. A miss throws `ReplayMissError` — it never opens a socket. */
export function capture(providerId: CaptureSourceId, url: string): RawRecord {
  return store.replay({ providerId, url });
}

/** The key `manifest.json` holds this capture under, recomputed from the adapter's own URL. */
export function keyFor(providerId: CaptureSourceId, url: string): string {
  return requestKey(providerId, 'GET', url);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// md lines — what WP-04's `md_lines` rows would give the normaliser (PROVIDERS.a §5.1 "Staleness
// tier"). Fixed ids: a golden cannot depend on a sequence.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function line(
  mdLineId: number,
  instrumentId: number,
  assetClass: AssetClass,
  expectedIntervalMs: number,
): NormaliseLine {
  return {
    mdLineId,
    instrumentId,
    assetClass,
    tier: 'delayed' satisfies Tier,
    intrinsicDelayMin: 15,
    expectedIntervalMs,
    priority: 10,
  };
}

/** `cboe.quotes`: `provider_symbol` is what goes in the URL — `AAPL`, `_SPX`, `_VIX`. */
export const QUOTE_LINES: ReadonlyMap<string, NormaliseLine> = new Map([
  ['AAPL', line(5101, 101, 'equity', 10_000)],
  ['_SPX', line(5102, 102, 'index', 10_000)],
  ['_VIX', line(5103, 103, 'index', 10_000)],
]);

/** `cboe.options`: its own md line on the same underlying instrument (§5.2, BUS-05). */
export const OPTION_LINES: ReadonlyMap<string, NormaliseLine> = new Map([
  ['AAPL', line(5201, 101, 'equity', 60_000)],
]);

/** `cboe.euIndices`: `provider_symbol 'BUK100P'` — `data.index`, not `data.symbol` (§5.4). */
export const EU_LINES: ReadonlyMap<string, NormaliseLine> = new Map([
  ['BUK100P', line(5401, 401, 'index', 60_000)],
]);

/** One provenance id per source, so a golden names the row its values would carry. */
export const PROVENANCE_IDS = {
  quotes: 900_101,
  options: 900_201,
  symbolBook: 900_301,
  euIndices: 900_401,
} as const;

export function quoteContext(raw: RawRecord): NormaliseContext {
  return { provenanceId: PROVENANCE_IDS.quotes, capturedAt: raw.capturedAt, lines: QUOTE_LINES };
}

export function euContext(raw: RawRecord): NormaliseContext {
  return { provenanceId: PROVENANCE_IDS.euIndices, capturedAt: raw.capturedAt, lines: EU_LINES };
}

export function symbolBookContext(raw: RawRecord): NormaliseContext {
  return {
    provenanceId: PROVENANCE_IDS.symbolBook,
    capturedAt: raw.capturedAt,
    lines: new Map(),
  };
}

/**
 * The options context, with the contract instrument ids WP-04's `identifiers` table would hold
 * once the chain's contracts have been minted: `700001 + <index in payload order>`, which is
 * deterministic for a given capture and lets the ATM fan-out of §5.2 be exercised. A resolver
 * that answers `null` (a chain seen for the first time) is asserted separately.
 */
export function optionContext(raw: RawRecord, resolve = true): NormaliseContext {
  const ids = resolve ? contractIds(raw) : new Map<string, number>();
  return {
    provenanceId: PROVENANCE_IDS.options,
    capturedAt: raw.capturedAt,
    lines: OPTION_LINES,
    resolveInstrument: (key) => (key.scheme === 'OCC' ? (ids.get(key.value) ?? null) : null),
  };
}

let contractIdCache: Map<string, number> | undefined;

/** OCC symbol → instrument id, in the capture's own payload order. */
export function contractIds(raw: RawRecord): Map<string, number> {
  if (contractIdCache !== undefined) return contractIdCache;
  const payload = JSON.parse(raw.body.toString('utf8')) as {
    data: { options: { option: string }[] };
  };
  const ids = new Map<string, number>();
  payload.data.options.forEach((entry, index) => {
    if (!ids.has(entry.option)) ids.set(entry.option, 700_001 + index);
  });
  contractIdCache = ids;
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Goldens
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The one canonical serialisation: compact JSON, one trailing newline. */
export function serialiseGolden(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function goldenPath(name: string): string {
  return join(GOLDEN_DIR, name);
}

export function readGolden(name: string): string {
  return readFileSync(goldenPath(name), 'utf8');
}

/** What a golden holds: `JSON.stringify` of the `Normalised<Rows>` the parser returned. */
export function goldenOf(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** The capture URLs, in one place so the suites and the golden writer cannot disagree. */
export const CAPTURES = {
  aapl: {
    providerId: 'cboe.quotes' as const,
    url: cboeQuoteUrl('AAPL'),
    golden: 'cboe-quote-AAPL.json',
  },
  spx: { providerId: 'cboe.quotes' as const, url: cboeQuoteUrl('_SPX'), golden: 'cboe-spx.json' },
  vix: { providerId: 'cboe.quotes' as const, url: cboeQuoteUrl('_VIX'), golden: 'cboe-vix.json' },
  options: {
    providerId: 'cboe.options' as const,
    url: cboeOptionsUrl('AAPL'),
    golden: 'cboe-options.json',
  },
  symbolBook: {
    providerId: 'cboe.symbolBook' as const,
    url: CBOE_SYMBOL_BOOK_URL,
    golden: 'cboe-symbol-book.json',
  },
  euIndices: {
    providerId: 'cboe.euIndices' as const,
    url: cboeEuIndexUrl('BUK100P'),
    golden: 'cboe-eu-indices.json',
  },
} as const;
