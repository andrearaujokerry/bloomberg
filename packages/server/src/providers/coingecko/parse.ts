/**
 * `coingecko.simple` — crypto context, PROVIDERS.md §5.8.
 *
 * **Pure.** No IO, no clock, no randomness; a QA-05 fuzz target that never throws.
 *
 * ```json
 * { "bitcoin": { "usd": 75828, "usd_24h_change": -4.217368765220806 },
 *   "ethereum": { "usd": 2386.91, "usd_24h_change": -6.001270999715535 } }
 * ```
 *
 * Two properties of this payload shape everything below.
 *
 * **There is no timestamp at all.** `ts.src` is `null` and `provenance.source_ts` is `NULL`;
 * `valueState` relies purely on `ts.cap` and `expected_interval_ms` for this source, which is
 * exactly why `staleness.ts` guards on `q.ts.src !== null`.
 *
 * **`usd_24h_change` is a rolling 24-hour move, not a session change.** The terminal defines
 * `CHG_PCT_1D` as the change against `PX_CLOSE_1D` and derives it itself (`core/quote/derive.ts`),
 * so publishing CoinGecko's number as `CHG_PCT_1D` would put a differently-defined quantity in a
 * field every screen reads one way. Instead this parser reconstructs the price 24 hours ago —
 * `PX_CLOSE_1D = usd / (1 + usd_24h_change / 100)` — and lets the standard derivation produce
 * `CHG_NET_1D` and `CHG_PCT_1D` from it as for every other asset class. The number is therefore a
 * *rolling* 24-hour reference, not a session close, and `impliedPrevCloseIsRolling` says so on
 * every row: CRYP footnotes it from `field_licence` so it is never mistaken for a session change.
 */

import type { NormaliseProblem, RawRecord } from '../types.js';

export interface CoingeckoParseInput {
  body: Uint8Array | string;
  url?: string | undefined;
}

export function inputFromRaw(raw: Pick<RawRecord, 'body' | 'url'>): CoingeckoParseInput {
  return { body: raw.body, url: raw.url };
}

export interface CoingeckoQuote {
  /** The CoinGecko slug; joins directly to `md_lines.provider_symbol` (`'bitcoin'`). */
  id: string;
  /** `usd` → `PX_LAST` / `quote_ticks.price`. */
  usd: number;
  /** `usd_24h_change`, percent over a **rolling** 24 hours. `null` when the payload omits it. */
  change24hPct: number | null;
  /** `usd / (1 + change/100)` → `PX_CLOSE_1D`. `null` when it cannot be reconstructed. */
  impliedPrevClose: number | null;
  /** Always `true` when `impliedPrevClose` is set: a rolling reference, not a session close. */
  impliedPrevCloseIsRolling: boolean;
}

export interface CoingeckoParsed {
  readonly ok: true;
  /** The `ids` the request asked for, when the URL was supplied; else `[]`. */
  requestedIds: string[];
  /** Sorted by id, so the golden order does not depend on JSON key order. */
  quotes: CoingeckoQuote[];
  /** Requested ids the response did not answer — CoinGecko does not know them (§5.8). */
  unknownIds: string[];
  /** The payload carries no publication instant. Always `null`; stated so, not omitted. */
  sourceTsMs: null;
  problems: NormaliseProblem[];
}

export interface CoingeckoParseFailure {
  readonly ok: false;
  readonly problems: NormaliseProblem[];
}

export type CoingeckoResult = CoingeckoParsed | CoingeckoParseFailure;

const decoder = new TextDecoder('utf-8', { fatal: false });

function decodeBody(body: Uint8Array | string): string {
  return typeof body === 'string' ? body : decoder.decode(body);
}

function problem(kind: NormaliseProblem['kind'], detail: string, path?: string): NormaliseProblem {
  return path === undefined ? { kind, detail } : { kind, detail, path };
}

/** The `ids` query parameter, split and de-duplicated. Empty when the URL is absent or unparseable. */
export function requestedIds(url: string | undefined): string[] {
  if (url === undefined || url === '') return [];
  let ids: string | null;
  try {
    ids = new URL(url).searchParams.get('ids');
  } catch {
    return [];
  }
  if (ids === null) return [];
  const seen = new Set<string>();
  for (const part of ids.split(',')) {
    const id = part.trim();
    if (id !== '') seen.add(id);
  }
  return [...seen];
}

/**
 * Reconstruct the price 24 hours ago from a rolling percent move.
 *
 * Guarded rather than trusted: `change = -100 %` (a coin that went to zero over the day, or a
 * corrupted field) divides by zero, and anything at or below it yields a negative or infinite
 * "previous close" that would render as a nonsensical arrow on CRYP. Such a row keeps its
 * `PX_LAST` and simply has no `PX_CLOSE_1D`.
 */
export function impliedPrevClose(usd: number, change24hPct: number): number | null {
  const factor = 1 + change24hPct / 100;
  if (!Number.isFinite(factor) || factor <= 1e-9) return null;
  const previous = usd / factor;
  return Number.isFinite(previous) && previous > 0 ? previous : null;
}

export function parseCoingeckoSimple(input: CoingeckoParseInput): CoingeckoResult {
  const problems: NormaliseProblem[] = [];

  let document: unknown;
  try {
    document = JSON.parse(decodeBody(input.body)) as unknown;
  } catch (err) {
    return {
      ok: false,
      problems: [problem('parse_error', `response is not JSON: ${(err as Error).message}`)],
    };
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { ok: false, problems: [problem('parse_error', 'payload is not a JSON object')] };
  }
  const root = document as Record<string, unknown>;

  const asked = requestedIds(input.url);
  const quotes: CoingeckoQuote[] = [];

  for (const id of Object.keys(root).sort()) {
    const entry = root[id];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(problem('field_dropped', `'${id}' does not carry a price object`, `/${id}`));
      continue;
    }
    const record = entry as Record<string, unknown>;
    const usdRaw = record.usd;
    if (typeof usdRaw !== 'number' || !Number.isFinite(usdRaw)) {
      // §5.8: `usd` absent while the id key is present → a `missing_field` data exception, which
      // the ingest job writes from this problem.
      problems.push(problem('field_dropped', `'${id}' has no usable usd price`, `/${id}/usd`));
      continue;
    }
    if (usdRaw <= 0) {
      problems.push(problem('out_of_range', `'${id}' priced at ${usdRaw} usd`, `/${id}/usd`));
      continue;
    }

    const changeRaw = record.usd_24h_change;
    const change24hPct =
      typeof changeRaw === 'number' && Number.isFinite(changeRaw) ? changeRaw : null;
    let previous: number | null = null;
    if (change24hPct !== null) {
      previous = impliedPrevClose(usdRaw, change24hPct);
      if (previous === null) {
        problems.push(
          problem(
            'out_of_range',
            `'${id}' reports a 24h change of ${change24hPct} %, from which no 24-hour-ago price can be reconstructed`,
            `/${id}/usd_24h_change`,
          ),
        );
      }
    }

    quotes.push({
      id,
      usd: usdRaw,
      change24hPct,
      impliedPrevClose: previous,
      impliedPrevCloseIsRolling: previous !== null,
    });
  }

  // "Unknown" means CoinGecko never mentioned the id at all. An id it answered with an unusable
  // body already raised its own `field_dropped`/`out_of_range` problem above and is not reported
  // twice under a kind that means something else.
  const mentioned = new Set(Object.keys(root));
  const unknownIds = asked.filter((id) => !mentioned.has(id)).sort();
  for (const id of unknownIds) {
    // §5.8: an id present in the request but absent from the response means CoinGecko does not
    // know it — no update, and the md line is NOT marked stale, because it never ticked.
    problems.push(
      problem('unknown_symbol', `CoinGecko returned no entry for id '${id}'`, `/${id}`),
    );
  }

  return { ok: true, requestedIds: asked.sort(), quotes, unknownIds, sourceTsMs: null, problems };
}
