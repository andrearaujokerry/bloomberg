// packages/core/src/functions/manifests/QM.ts
//
// `QM` — Quote Monitor (FUNCTIONS_TIER1.md §QM L890-996, FUNCTIONS.md §6 L1081).
//
// A monitor is a list of subjects and a list of columns. Every row is one security, every cell is a
// `ValueCell` that carries its own state, reason and provenance index, and the grid flashes on
// change. The §6 binding row is `none → default`: QM takes no security, because its security is the
// *list*.

import { z } from 'zod';

import { getField } from '../../fields/dictionary.js';
import type { FieldId } from '../../types/fields.js';
import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import { FieldId as FieldIdSchema, SecurityRefInput, SortSpec } from '../schemas.js';
import type { MonitorColumn, MonitorRow } from '../shared/monitor.js';
import { asOfCompact, slugOf } from './Q.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§QM "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const QmSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('watchlist'),
    id: z.number().int().optional(),
    name: z.string().max(80).optional(),
  }),
  z.object({
    kind: z.literal('index'),
    id: z.number().int().optional(),
    code: z.string().max(12).optional(),
  }),
  z.object({ kind: z.literal('keys'), refs: z.array(SecurityRefInput).min(1).max(500) }),
]);
export type QmSource = z.infer<typeof QmSource>;

export const QM_DEFAULT_COLUMNS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_BID',
  'PX_ASK',
  'BID_SIZE',
  'ASK_SIZE',
  'PX_VOLUME',
  'PX_HIGH',
  'PX_LOW',
  'LAST_TRADE_TIME',
  'SESSION_STATE',
]);

export const QmParams = z.object({
  source: QmSource.default({ kind: 'watchlist' }),
  columns: z
    .array(FieldIdSchema)
    .min(1)
    .max(30)
    .default([...QM_DEFAULT_COLUMNS]),
  sort: SortSpec.optional(),
  groupBy: z.enum(['none', 'GICS_SECTOR_NAME', 'EXCH_CODE', 'MARKET_SECTOR_DES']).default('none'),
});
export type QmParams = z.infer<typeof QmParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§QM "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type QmSkipReason =
  'SECURITY_NOT_FOUND' | 'AMBIGUOUS_SECURITY' | 'NOT_IN_UNIVERSE' | 'FORMULA_ROW';

export interface QmSourceInfo {
  kind: 'watchlist' | 'index' | 'keys';
  id: number | null;
  name: string;
  /** Index membership date; `null` for a watchlist or a key list. */
  asOfDate: string | null;
  /** `'sec.archives'` | `'ssga.holdings'` for an index roster; `null` otherwise. */
  sourceId: string | null;
}

/** `{ rows, live, pending, stale, blank }` — the subtitle's census, taken from the cells' `st`. */
export interface MonitorCounts {
  rows: number;
  live: number;
  pending: number;
  stale: number;
  blank: number;
}

export interface QmPayload {
  variant: 'default';
  source: QmSourceInfo;
  title: string;
  columns: MonitorColumn[];
  rows: MonitorRow[];
  skipped: { ref: string; reason: QmSkipReason }[];
  groupBy: QmParams['groupBy'];
  sort: z.infer<typeof SortSpec> | null;
  counts: MonitorCounts;
  /** `ctx.asOf.validAt` — the instant the payload reproduces at. */
  asOf: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The field set a monitor may pre-check (§QM / §W / §WEI "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Of `ids`, the ones a manifest with `assetClasses: 'none'` may put in its entitlement pre-check.
 *
 * **This filter is a deviation from the tier documents' field lists, and both halves of it are
 * load-bearing.** The runner evaluates `fieldIds(assetClass)` once, before the resolver runs, and
 * for a `'none'` manifest that asset class is `null`. Two things then go wrong with the lists as
 * written, and both end as a screen full of blanks that blames the user's contract:
 *
 *  1. **A field with no single source cannot be looked up at all.** Evaluator rule 1 keys
 *     `field_licence` on `(fieldId, assetClass)`; the registry answers a `null` class only when
 *     every per-class row of that field names ONE source
 *     (`entitlements/licenceRegistry.ts#fieldSource`). `PX_LAST` is `cboe.quotes` for an equity,
 *     `yahoo.chart` for an index and `cboe.options` for a contract, so under a `null` class it
 *     comes back `FIELD_UNKNOWN` — and because the decision's denials seed the plant gate
 *     (`functions/context.ts#buildContext`), every price cell on the screen would render blank
 *     with an entitlement reason. Not a missing grant: a lookup that cannot be made.
 *  2. **A reference field drags the whole screen's tier down.** `decision.effectiveTier` is the
 *     *minimum* over the fields asked about, and the plant gate takes that one tier for every
 *     field it later serves. `GICS_SECTOR_NAME` is licensed from `wiki.sp500` and `EQY_SH_OUT`
 *     from `sec.companyfacts`, both capped at `eod` — so asking about a sector name would freeze
 *     every quote on the grid at the official close with `TIER_EOD`. A sector name's licence has
 *     nothing to say about how fresh a price may be.
 *
 * So a monitor pre-checks the fields it actually reads **from the plant**: quote and derived
 * fields with one source. Reference columns are master columns — read from `instruments` and
 * `entity_classifications`, not gated by `policyTier` — and are not part of the quote decision.
 *
 * The cost is real and is recorded here rather than hidden: the `access_log` rows a monitor writes
 * name the derived fields, not `PX_LAST`, and the per-row price fields are gated only by the
 * plant's own `policyTier.view` at the tier the decision granted. The fix belongs one layer down —
 * either `asset_class IS NULL` rows in `field_licence` for the quote fields, or a runner that
 * pre-checks a `'none'` manifest once per distinct asset class in its own result — and neither is
 * this manifest's to make.
 */
export function monitorPrecheckFields(ids: readonly FieldId[]): FieldId[] {
  const out: FieldId[] = [];
  for (const id of ids) {
    const def = getField(id);
    if (def === undefined) continue;
    if (def.fieldClass === 'reference') continue;
    const sources = new Set(def.sources.map((s) => s.sourceId));
    if (sources.size === 1) out.push(id);
  }
  return out;
}

/** The superset §QM names as the pre-check set, before {@link monitorPrecheckFields}. */
export const QM_PRECHECK_SUPERSET: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_BID',
  'PX_ASK',
  'BID_SIZE',
  'ASK_SIZE',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_CLOSE_1D',
  'PX_VOLUME',
  'LAST_TRADE_TIME',
  'SESSION_STATE',
  'IVOL_30D',
  'VWAP',
  'NAME',
  'ID_TICKER',
  'EXCH_CODE',
  'GICS_SECTOR_NAME',
  'CUR_MKT_CAP',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live, CSV
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The subjects and fields a monitor grid subscribes to, read off the rows' own cells.
 *
 * A pending cell carries `live` too (§0.4 rule 1) — that is the whole point of it: the subject is
 * valid and the first `snap` fills it. Deriving the spec from the cells therefore covers exactly
 * the rows that are waiting, which is what turns `…` into a number without a re-run.
 */
export function monitorLive(
  rows: readonly {
    subject: string;
    cells: Record<string, { live?: { subject: string; field: FieldId } }>;
  }[],
  conflationMs: number,
): LiveSpec {
  const subjects: string[] = [];
  const fields: FieldId[] = [];
  const seenSubject = new Set<string>();
  const seenField = new Set<string>();

  for (const row of rows) {
    for (const cell of Object.values(row.cells)) {
      const live = cell.live;
      if (live === undefined) continue;
      if (!seenSubject.has(live.subject)) {
        seenSubject.add(live.subject);
        subjects.push(live.subject);
      }
      if (!seenField.has(live.field)) {
        seenField.add(live.field);
        fields.push(live.field);
      }
    }
  }
  return { subjects, fields, conflationMs };
}

function qmCsvColumns(_params: QmParams, payload: QmPayload): CsvColumn[] {
  const columns: CsvColumn[] = [
    { id: 'key', label: 'Security', type: 'string' },
    { id: 'name', label: 'Name', type: 'string' },
    { id: 'assetClass', label: 'Asset class', type: 'string' },
    { id: 'exchCode', label: 'Exchange', type: 'string' },
    { id: 'gicsSector', label: 'GICS sector', type: 'string' },
  ];
  for (const column of payload.columns) {
    columns.push({
      id: column.id,
      label: column.label,
      type: column.fmt === 'text' ? 'string' : column.fmt === 'datetime' ? 'datetime' : 'number',
      ...(column.decimals === undefined ? {} : { decimals: column.decimals }),
    });
  }
  columns.push({ id: 'state', label: 'State', type: 'string' });
  return columns;
}

/** The worst `st` over a row's cells — what the `state` column reports (§QM / §WEI CSV). */
export function worstCellState(cells: Record<string, { st: string }>): string {
  const order = ['live', 'closed', 'stale', 'na', 'blank'];
  let worst = 'live';
  for (const cell of Object.values(cells)) {
    if (order.indexOf(cell.st) > order.indexOf(worst)) worst = cell.st;
  }
  return worst;
}

function qmCsvRows(payload: QmPayload): (string | number | boolean | null)[][] {
  return payload.rows.map((row) => [
    row.key,
    row.name,
    row.assetClass,
    row.exchCode,
    row.gicsSector,
    ...payload.columns.map((c) => row.cells[c.id]?.v ?? null),
    worstCellState(row.cells),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const QM = defineFunction<typeof QmParams, QmPayload>({
  code: 'QM',
  name: 'Quote Monitor',
  aliases: ['MON'],
  tier: 1,
  category: 'monitor',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: QmParams,
  paramGrammar: {
    positional: [{ name: 'source', type: 'watchlist', optional: true }],
    keyed: {
      IDX: { name: 'source', type: 'index' },
      KEYS: { name: 'source', type: 'string' },
      COLS: { name: 'columns', type: 'string' },
      SORT: { name: 'sort', type: 'string' },
      GROUP: {
        name: 'groupBy',
        type: 'enum',
        values: ['none', 'GICS_SECTOR_NAME', 'EXCH_CODE', 'MARKET_SECTOR_DES'],
      },
    },
  },
  fieldIds: (): FieldId[] => monitorPrecheckFields(QM_PRECHECK_SUPERSET),
  pageable: false,
  live: (_params, payload): LiveSpec => monitorLive(payload.rows, 250),
  csv: {
    filename: (_params, ctx): string => `QM_${slugOf(ctx.display)}_${asOfCompact(ctx.asOf)}.csv`,
    columns: qmCsvColumns,
    rows: (payload): (string | number | boolean | null)[][] => qmCsvRows(payload),
  },
  help: {
    summary: 'Live quote grid over a watchlist, index members or a typed list of securities',
    description:
      'QM is a monitor: every row is one security and every cell updates from the ticker plant ' +
      'with a flash on change. The source is a watchlist (default: your most recently updated ' +
      "one), an index's current constituents (IDX=SPX from the SPY N-PORT/SSGA membership) or a " +
      'list of keys. Columns are dictionary fields; sort and group are client-side and remembered ' +
      'in the frame. Rows off screen are marked non-essential so a slow connection widens ' +
      'conflation or sheds them before anything is lost; a stale feed is shown, never silently ' +
      'frozen. Enter opens DES, Q the quote, W saves the rows as a watchlist.',
    params: [
      { name: 'source', text: 'watchlist name/id, IDX=<index> or KEYS=a,b,c', example: 'MAG7' },
      { name: 'columns', text: 'field ids', example: 'COLS=PX_LAST,CHG_PCT_1D,PX_VOLUME' },
      { name: 'sort', text: 'column:dir', example: 'SORT=CHG_PCT_1D:desc' },
      {
        name: 'groupBy',
        text: 'none, GICS_SECTOR_NAME, EXCH_CODE, MARKET_SECTOR_DES',
        example: 'GROUP=GICS_SECTOR_NAME',
      },
    ],
    keys: [
      { key: 'Enter', action: 'DES for the focused row' },
      { key: 'Q', action: 'Q for the focused row' },
      { key: 'S', action: 'sort by the focused column' },
      { key: 'G', action: 'cycle the grouping' },
      { key: 'C', action: 'add a column' },
      { key: 'W', action: 'save the rows as a watchlist' },
    ],
    sources: [
      'cboe.quotes',
      'yahoo.chart',
      'coingecko.simple',
      'nyfed.rates',
      'sec.archives',
      'ssga.holdings',
      'wiki.sp500',
      'internal.derived',
    ],
    related: ['W', 'Q', 'DES', 'MEMB', 'WEI'],
  },
  keymap: [
    {
      key: 'Enter',
      action: 'open-des',
      when: 'grid',
      description: 'Description of the focused row',
    },
    {
      key: 'Shift+Enter',
      action: 'open-des-next',
      when: 'grid',
      description: 'Description in the next panel',
    },
    { key: 'Q', action: 'open-q', when: 'grid', description: 'Quote of the focused row' },
    { key: 'P', action: 'open-gp', when: 'grid', description: 'Price chart of the focused row' },
    { key: 'S', action: 'sort-column', when: 'grid', description: 'Sort by the focused column' },
    { key: 'Shift+S', action: 'clear-sort', when: 'grid', description: 'Clear the sort' },
    { key: 'G', action: 'cycle-group', description: 'Cycle the grouping column' },
    { key: 'C', action: 'add-column', description: 'Add a dictionary field as a column (max 30)' },
    {
      key: 'Shift+C',
      action: 'remove-column',
      when: 'grid',
      description: 'Remove the focused column',
    },
    { key: 'Insert', action: 'add-row', when: 'grid', description: 'Add a security to the list' },
    { key: 'Delete', action: 'remove-row', when: 'grid', description: 'Remove the focused row' },
    { key: 'W', action: 'save-as-watchlist', description: 'Save the visible rows as a watchlist' },
    { key: 'L', action: 'open-w', description: 'Open the list in W' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default QM;
