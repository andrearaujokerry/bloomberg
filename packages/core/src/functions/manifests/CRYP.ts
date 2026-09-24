// packages/core/src/functions/manifests/CRYP.ts
//
// `CRYP` — Crypto Monitor (FUNCTIONS.md §7.3 L1213-1308, the NORMATIVE worked example, reproduced
// verbatim by FUNCTIONS_TIER3.md §CRYP L1907-2038 with five completions).
//
// CRYP is the one screen in this build that exists to say what it is **not**. There is no exchange
// feed for crypto here: CoinGecko's simple-price endpoint publishes an indicative cross-venue
// price and a **rolling** 24-hour change, with no order book, no volume, no venue and no session.
// So the payload carries `caveat: 'CONTEXT_ONLY_NOT_EXCHANGE_DATA'` unconditionally — not as a
// degradation badge that appears when something breaks, but as a permanent statement of what the
// numbers are — and the screen leads with it (TERM-08).
//
// Two decisions about the 24-hour change, both of which are about not fabricating a close:
//
//  1. **The column is `chg24hPct`, never a change since the previous close.** A 24×7 asset has no
//     session and therefore no close. CoinGecko publishes `usd_24h_change` over a rolling window;
//     presenting it as "today's change" would be a fabricated session boundary. The label, the CSV
//     header and the help text all say 24-hour, and the resolver adds a `NOT_APPLICABLE` note for
//     `PX_CLOSE_1D` so a reader of `meta` is told the same thing.
//  2. **The number comes off the plant's `CHG_PCT_1D`, which is derived, not sourced.** §7.3 step 4
//     reads `state.fields.CHG_PCT_1D` and says the adapter normalises `usd_24h_change` into it.
//     The landed WP-05 adapter does not: it writes `PX_LAST` and a *reconstructed* 24-hour-ago
//     price into `PX_CLOSE_1D` (`coingecko/parse.ts#impliedPrevClose`, flagged
//     `impliedPrevCloseIsRolling`), and `core/quote/derive.ts` derives `CHG_PCT_1D` from the pair
//     at four decimals. The resolver follows the landed pipeline rather than inventing a second
//     path for the same number; the consequence for the golden is recorded in `CRYP/resolve.ts`.

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import { monitorPrecheckFields } from './QM.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§7.3 "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The four seeded CoinGecko ids, in the order `CRYP` with no arguments shows them. */
export const CRYP_IDS = ['bitcoin', 'ethereum', 'solana', 'ripple'] as const;
export type CrypId = (typeof CRYP_IDS)[number];

/**
 * CoinGecko id → the instrument ticker the security master carries (`'BTC Crypto'`).
 *
 * A catalogue fact, and the only way a row can be shown for an id whose `md_lines` row does not
 * exist — which is exactly the `solana`/`ripple` case §CRYP completion 2 describes. Kept beside the
 * params it mirrors so the screen legend and the resolver read one list.
 */
export const CRYP_TICKERS: Readonly<Record<CrypId, string>> = Object.freeze({
  bitcoin: 'BTC',
  ethereum: 'ETH',
  solana: 'SOL',
  ripple: 'XRP',
});

export const CrypParams = z.object({
  ids: z
    .array(z.enum(CRYP_IDS))
    .min(1)
    .max(4)
    .default([...CRYP_IDS]),
  sort: z.enum(['name', 'px', 'chg']).default('name'),
});
export type CrypParams = z.infer<typeof CrypParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§7.3 "Payload", verbatim)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The permanent badge: these are indicative prices, not exchange or venue data. */
export const CRYP_CAVEAT = 'CONTEXT_ONLY_NOT_EXCHANGE_DATA' as const;

/** The `meta.unavailable` detail for an id that is in the enum but has no seeded CoinGecko line. */
export const CRYP_NO_SOURCE_DETAIL = 'not a seeded CoinGecko id';

/** Why no change-since-close is shown, however tempting the column would be. */
export const CRYP_NO_CLOSE_DETAIL =
  'crypto trades 24×7 and CoinGecko publishes a rolling 24-hour change, not a session close: ' +
  'the stored previous price is the reconstructed level 24 hours ago, so no change-since-close ' +
  'is computed';

export interface CrypRow {
  instrumentId: number;
  /** `'BTC Crypto'`. */
  key: string;
  name: string;
  coingeckoId: string;
  px: ValueCell;
  chg24hPct: ValueCell;
  /** ISO 8601 — the source instant of the quote, or the capture instant of the reference row. */
  asOf: string;
}

export interface CrypPayload {
  variant: 'default';
  rows: CrypRow[];
  source: 'coingecko.simple';
  caveat: typeof CRYP_CAVEAT;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§7.3 "Data dependencies")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const CRYP_FIELD_IDS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_PCT_1D',
  'LAST_TRADE_TIME',
] as const);

/**
 * What the runner may pre-check, which is not the same list.
 *
 * `CRYP` is a `'none'` manifest, so the entitlement decision is evaluated with `assetClass: null`,
 * and `PX_LAST` names three different sources across the classes that carry it — so under a null
 * class it resolves to no source at all and comes back `FIELD_UNKNOWN`, which would blank the price
 * column of a correctly entitled firm. `monitorPrecheckFields` (declared and argued in `QM.ts`,
 * which hit this first) drops exactly those; the price cell is then gated by the plant's own
 * `policyTier.view` at the granted tier, as it is on QM and WEI. The superset above stays the
 * screen's field set and is what `live()` subscribes to.
 */
export const CRYP_PRECHECK_FIELD_IDS: readonly FieldId[] = Object.freeze(
  monitorPrecheckFields(CRYP_FIELD_IDS),
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§7.3 "CSV", columns fixed by §CRYP completion 3)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CRYP_CSV_COLUMNS: CsvColumn[] = [
  { id: 'key', label: 'Security', type: 'string' },
  { id: 'name', label: 'Name', type: 'string' },
  { id: 'coingeckoId', label: 'CoinGecko id', type: 'string' },
  { id: 'px', label: 'Price', type: 'number', decimals: 8 },
  { id: 'chg24hPct', label: 'Chg 24h %', type: 'number', decimals: 8 },
  { id: 'asOf', label: 'As of', type: 'datetime' },
  { id: 'source', label: 'Source', type: 'string' },
];

type CsvRow = (string | number | boolean | null)[];

/** `cell.v` as the CSV writes it: a number, or an empty field — never `0` for "no value". */
const csvValue = (cell: ValueCell): number | null => (typeof cell.v === 'number' ? cell.v : null);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const CRYP = defineFunction<typeof CrypParams, CrypPayload>({
  code: 'CRYP',
  name: 'Crypto Monitor',
  aliases: ['CRYPTO'],
  tier: 3,
  category: 'monitor',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: CrypParams,
  // §CRYP completion 1: `CRYPTO` is a plain alias, so there is no `aliasParams`. A bare positional
  // token is a comma-separated list of CoinGecko ids; an unknown token fails `z.enum` and is a
  // `400 VALIDATION_FAILED` on `ids`, never a silently dropped row.
  paramGrammar: {
    positional: [{ name: 'ids', type: 'string', optional: true }],
    keyed: {
      SORT: { name: 'sort', type: 'enum', values: ['name', 'px', 'chg'] },
    },
  },
  fieldIds: (): FieldId[] => [...CRYP_PRECHECK_FIELD_IDS],
  pageable: false,
  live: (_params, payload): LiveSpec => ({
    subjects: payload.rows.map((row) => `q:${String(row.instrumentId)}`),
    fields: [...CRYP_FIELD_IDS],
    conflationMs: 1000,
  }),
  csv: {
    filename: (_params, ctx): string => `CRYP_${ctx.asOf.replace(/[-:]/g, '')}.csv`,
    columns: CRYP_CSV_COLUMNS,
    rows: (payload): CsvRow[] =>
      payload.rows.map((row) => [
        row.key,
        row.name,
        row.coingeckoId,
        csvValue(row.px),
        csvValue(row.chg24hPct),
        row.asOf,
        payload.source,
      ]),
  },
  help: {
    summary: 'Context-only crypto prices (CoinGecko), not exchange data',
    description:
      "CRYP shows spot prices and 24-hour changes for the seeded crypto assets from CoinGecko's " +
      'simple-price endpoint. Values are indicative and are not exchange or venue prices; there ' +
      'is no order book, no volume and no session state. The change column is a rolling 24-hour ' +
      'move, not a change since a close — a 24×7 asset has no close to change from. Use DES on a ' +
      'row for the instrument record and GP for history.',
    params: [
      { name: 'ids', text: 'CoinGecko ids, comma-separated', example: 'bitcoin,ethereum' },
      { name: 'sort', text: 'name, px or chg' },
    ],
    keys: [
      { key: 'Enter', action: 'DES for the focused row' },
      { key: 'G', action: 'GP for the focused row' },
      { key: 'S', action: 'cycle the sort' },
      { key: 'Ctrl+W', action: 'add the rows to a watchlist' },
    ],
    sources: ['coingecko.simple'],
    related: ['DES', 'GP', 'WEI'],
  },
  keymap: [
    { key: 'Enter', action: 'open-des', when: 'grid', description: 'Instrument record (DES)' },
    {
      key: 'Shift+Enter',
      action: 'open-des-next',
      when: 'grid',
      description: 'DES in the next panel',
    },
    { key: 'G', action: 'open-gp', when: 'grid', description: 'Price history (GP)' },
    { key: 'S', action: 'cycle-sort', description: 'Cycle name / price / change' },
    { key: 'Ctrl+W', action: 'add-watchlist', when: 'grid', description: 'Add to a watchlist' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default CRYP;
