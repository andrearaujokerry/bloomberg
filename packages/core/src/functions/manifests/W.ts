// packages/core/src/functions/manifests/W.ts
//
// `W` — Watchlists (FUNCTIONS_TIER1.md §W L997-1107, FUNCTIONS.md §6 L1082).
//
// W is QM plus ownership: the lists you own and the ones shared with you, the selected one as a
// live grid, and CHRT-07's two computed shapes — a formula COLUMN over a row's own fields
// (`PX_LAST/PX_CLOSE_1D-1`) and a formula ROW over other securities
// (`RATIO(AAPL US Equity, SPX Index)`). Both are evaluated by `core/formula`, server-side here and
// client-side on every delta, which is what makes the CSV and the screen agree at resolve time.
//
// The §6 binding row is `none → default`.

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import type { SortSpec } from '../schemas.js';
import type { MonitorColumn, MonitorRow } from '../shared/monitor.js';
import { asOfCompact, slugOf } from './Q.js';
import { monitorPrecheckFields, worstCellState } from './QM.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§W "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const WWatchlistRef = z.union([
  z.object({ id: z.number().int() }),
  z.object({ name: z.string().max(80) }),
]);
export type WWatchlistRef = z.infer<typeof WWatchlistRef>;

export const WParams = z.object({
  /** Undefined → the caller's most recently updated own list. */
  watchlist: WWatchlistRef.optional(),
  view: z.enum(['grid', 'manage', 'share']).default('grid'),
});
export type WParams = z.infer<typeof WParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§W "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type WSharedScope = 'private' | 'firm' | 'users';

export interface WListSummary {
  watchlistId: number;
  name: string;
  ownerUserId: number;
  ownerDisplay: string;
  isOwner: boolean;
  sharedScope: WSharedScope;
  itemCount: number;
  updatedAt: string;
}

/**
 * One row of the active list.
 *
 * A formula row has `instrumentId: 0` and `subject: ''` (§W) — it is not a security, so it has no
 * plant subject of its own; the subjects it *reads* are in `deps`, which is what the screen
 * subscribes to so the computed cell recomputes on every input tick.
 */
export interface WRow extends MonitorRow {
  position: number;
  label: string | null;
  note: string | null;
  addedAt: string;
  formula: string | null;
  /** Subjects a formula row or a formula column depends on; empty for a plain row. */
  deps: string[];
}

export interface WFormulaError {
  /** `'c1'` for a column, `'row:3'` for a row (the item's `position`). */
  where: string;
  message: string;
}

export interface WActive {
  watchlistId: number;
  name: string;
  isOwner: boolean;
  sharedScope: WSharedScope;
  sharedUserIds: number[];
  updatedAt: string;
  columns: MonitorColumn[];
  sort: z.infer<typeof SortSpec>[];
  groupBy: string | null;
  rows: WRow[];
  formulaErrors: WFormulaError[];
}

export interface WPayload {
  variant: 'default';
  me: { userId: number; firmId: number };
  watchlists: WListSummary[];
  active: WActive | null;
  /** `ctx.asOf.validAt` — the instant the payload reproduces at. */
  asOf: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§W "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * §W's pre-check superset, minus the two ids the shipped dictionary does not define.
 *
 * `TICKER` is `ID_TICKER` in `core/fields/defs/reference.ts`, and there is no `PE_RATIO` field at
 * all — `monitorColumn()` throws on an unknown id, and a pre-check naming one would deny a field
 * that cannot exist. Both are recorded here rather than silently dropped.
 */
export const W_PRECHECK_SUPERSET: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_BID',
  'PX_ASK',
  'PX_VOLUME',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_CLOSE_1D',
  'LAST_TRADE_TIME',
  'SESSION_STATE',
  'IVOL_30D',
  'NAME',
  'ID_TICKER',
  'EXCH_CODE',
  'GICS_SECTOR_NAME',
  'CUR_MKT_CAP',
  'EQY_SH_OUT',
  'DVD_YIELD',
  'PX_HIGH_52W',
  'PX_LOW_52W',
  'RET_YTD',
  'RET_1Y',
  'VOL_30D',
  'BETA_1Y',
]);

/** The columns a new list gets when nothing says otherwise (`Ctrl+N`, and an empty `columns`). */
export const W_DEFAULT_COLUMNS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_VOLUME',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live, CSV
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Plain rows follow their own subject; formula rows and formula columns follow their inputs.
 *
 * `deps` is unioned in rather than derived from the cells, because a computed cell carries no
 * `live` of its own: it is not pushed, it is *recomputed* in the client from the inputs' deltas
 * (`web/screens/W/formulaCells.ts`), and a subscription that covered only the pushed cells would
 * leave every computed one frozen.
 */
function wLive(_params: WParams, payload: WPayload): LiveSpec | null {
  const active = payload.active;
  if (active === null) return null;

  const subjects: string[] = [];
  const fields: FieldId[] = [];
  const seenSubject = new Set<string>();
  const seenField = new Set<string>();

  const addSubject = (subject: string): void => {
    if (subject === '' || seenSubject.has(subject)) return;
    seenSubject.add(subject);
    subjects.push(subject);
  };

  for (const row of active.rows) {
    addSubject(row.subject);
    for (const dep of row.deps) addSubject(dep);
    for (const cell of Object.values(row.cells)) {
      const live = cell.live;
      if (live === undefined) continue;
      addSubject(live.subject);
      if (!seenField.has(live.field)) {
        seenField.add(live.field);
        fields.push(live.field);
      }
    }
  }
  for (const column of active.columns) {
    if (column.fieldId === undefined) continue;
    if (seenField.has(column.fieldId)) continue;
    seenField.add(column.fieldId);
    fields.push(column.fieldId);
  }

  return { subjects, fields, conflationMs: 250 };
}

function wCsvColumns(_params: WParams, payload: WPayload): CsvColumn[] {
  const columns: CsvColumn[] = [
    { id: 'position', label: 'Position', type: 'number' },
    { id: 'key', label: 'Security', type: 'string' },
    { id: 'name', label: 'Name', type: 'string' },
  ];
  for (const column of payload.active?.columns ?? []) {
    columns.push({
      id: column.id,
      label: column.label,
      type: column.fmt === 'text' ? 'string' : column.fmt === 'datetime' ? 'datetime' : 'number',
      ...(column.decimals === undefined ? {} : { decimals: column.decimals }),
    });
  }
  columns.push(
    { id: 'label', label: 'Label', type: 'string' },
    { id: 'note', label: 'Note', type: 'string' },
    { id: 'state', label: 'State', type: 'string' },
  );
  return columns;
}

function wCsvRows(payload: WPayload): (string | number | boolean | null)[][] {
  const active = payload.active;
  if (active === null) return [];
  return active.rows.map((row) => [
    row.position,
    // A formula row is addressed by its formula: it has no key of its own (§W CSV).
    row.formula ?? row.key,
    row.name,
    ...active.columns.map((c) => row.cells[c.id]?.v ?? null),
    row.label,
    row.note,
    worstCellState(row.cells),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const W = defineFunction<typeof WParams, WPayload>({
  code: 'W',
  name: 'Watchlists',
  aliases: ['WL', 'WATCH'],
  tier: 1,
  category: 'monitor',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: WParams,
  paramGrammar: {
    positional: [{ name: 'watchlist', type: 'watchlist', optional: true }],
    keyed: { VIEW: { name: 'view', type: 'enum', values: ['grid', 'manage', 'share'] } },
  },
  fieldIds: (): FieldId[] => monitorPrecheckFields(W_PRECHECK_SUPERSET),
  pageable: false,
  live: wLive,
  csv: {
    filename: (_params, ctx): string => `W_${slugOf(ctx.display)}_${asOfCompact(ctx.asOf)}.csv`,
    columns: wCsvColumns,
    rows: (payload): (string | number | boolean | null)[][] => wCsvRows(payload),
  },
  help: {
    summary: 'Your watchlists: live grid, formula columns and rows, sharing, reorder',
    description:
      'W lists your watchlists and the ones shared with you (firm-wide or by name) and shows the ' +
      'selected one as a live grid. Columns are dictionary fields or formulas over them (F adds ' +
      'one, e.g. PX_LAST/PX_CLOSE_1D-1); rows are securities or formulas over securities ' +
      '(Shift+Insert, e.g. RATIO(AAPL US Equity, SPX Index)), evaluated in the client on every ' +
      'update with the same formula engine the server uses for export. Lists belong to a person ' +
      'and never leave the firm; sharing is by scope. Edits save immediately; the last list you ' +
      'opened is part of your workspace. QM (M) shows the same list as a plain monitor.',
    params: [
      { name: 'watchlist', text: 'name or id; default: your most recent list', example: 'MAG7' },
      { name: 'view', text: 'grid, manage or share', example: 'VIEW=SHARE' },
    ],
    keys: [
      { key: 'Enter', action: 'open the focused list, or DES for the focused row' },
      { key: 'Insert', action: 'add a security' },
      { key: 'Shift+Insert', action: 'add a formula row' },
      { key: 'F', action: 'add a formula column' },
      { key: 'C', action: 'add a field column' },
      { key: 'Ctrl+N', action: 'new list' },
    ],
    sources: [
      'cboe.quotes',
      'yahoo.chart',
      'coingecko.simple',
      'nyfed.rates',
      'sec.companyfacts',
      'internal.derived',
    ],
    related: ['QM', 'DES', 'GP', 'SECF'],
  },
  keymap: [
    {
      key: 'Enter',
      action: 'open-list',
      when: 'grid',
      description: 'Open the focused list or row',
    },
    {
      key: 'Shift+Enter',
      action: 'open-des-next',
      when: 'grid',
      description: 'Description in the next panel',
    },
    { key: 'G', action: 'open-gp', when: 'grid', description: 'Price chart of the focused row' },
    { key: 'M', action: 'open-qm', description: 'The active list as a plain monitor' },
    { key: 'Insert', action: 'add-row', when: 'grid', description: 'Add a security (owner only)' },
    {
      key: 'Shift+Insert',
      action: 'add-formula-row',
      when: 'grid',
      description: 'Add a formula row (owner only)',
    },
    { key: 'Delete', action: 'remove-row', when: 'grid', description: 'Remove the focused row' },
    { key: 'Alt+ArrowUp', action: 'move-up', when: 'grid', description: 'Move the row up' },
    { key: 'Alt+ArrowDown', action: 'move-down', when: 'grid', description: 'Move the row down' },
    { key: 'F', action: 'add-formula-column', description: 'Add a computed column (CHRT-07)' },
    { key: 'C', action: 'add-field-column', description: 'Add a dictionary field as a column' },
    {
      key: 'Shift+C',
      action: 'remove-column',
      when: 'grid',
      description: 'Remove the focused column',
    },
    { key: 'S', action: 'sort-column', when: 'grid', description: 'Sort by the focused column' },
    { key: 'R', action: 'rename', description: 'Rename the list (owner only)' },
    { key: 'Ctrl+N', action: 'new-list', description: 'Create a watchlist' },
    { key: 'Ctrl+Shift+S', action: 'share', description: 'Sharing form' },
    { key: 'V', action: 'cycle-view', description: 'Cycle grid / manage / share' },
    { key: 'X', action: 'delete-list', description: 'Delete the list (owner only, typed confirm)' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default W;
