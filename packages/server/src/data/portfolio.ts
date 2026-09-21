/**
 * `data/portfolio.ts` — the tenant-scoped portfolio reader (WORKPLAN §WP-04 L706-709,
 * FUNCTIONS.md §1.4.2 L308, API.md §5.9 L670-695). PORT-01, PORT-02, **PORT-07**.
 *
 * ### Why every read carries a firm
 *
 * `portfolios`, `positions`, `lots` and `portfolio_imports` are the four tables in this system
 * whose rows belong to a *customer*, not to the market. A leak here is existential, so this module
 * does not have a method that can be called without a firm: the service is constructed from a
 * `PortfolioScope { firmId, userId }` and **every** statement below carries `firm_id = $firmId` in
 * its own `WHERE`, not merely in the portfolio lookup that preceded it. `positions`, `lots` and
 * `imports` therefore filter on their own denormalised `firm_id` column — the column migration
 * 0012 added for exactly this reason — so a row mis-parented to another firm's portfolio is
 * invisible even if the join would have reached it.
 *
 * That is defence in depth, not a replacement for RLS: DATA_MODEL §15 policies on these tables are
 * the outer wall and apply to `terminal_app` regardless of what this module does. This is the inner
 * one, and it is the wall that still stands when a caller runs as the owner role (as the local test
 * database does, where the owner is a superuser and bypasses RLS entirely — DATA_MODEL §15.1
 * L2438). `test/integration/data/portfolio.test.ts` proves the inner wall on its own, without
 * `SET ROLE`, which is what makes it a test of *this* module.
 *
 * ### Not found vs. not yours
 *
 * A portfolio of another firm and a portfolio that does not exist raise the **same**
 * `PortfolioAccessError('not_found')`, and the route turns both into `404`. Distinguishing them
 * would leak the existence of another firm's portfolio through a timing-free oracle.
 *
 * Provenance: positions come from an upload, not a provider, so a position's provenance is its
 * import's (`portfolio_imports.provenance_id`, source `internal.user`). It is carried on every row
 * so the payload can cite where a quantity came from; `null` only for a position written before
 * any import row existed.
 */

import { sql } from 'drizzle-orm';

import type { AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes (API.md §5.9)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The caller's tenant. Every read in this module is scoped by it. */
export interface PortfolioScope {
  firmId: number;
  userId: number;
}

/** The minimum an instrument reference needs on a position row. */
export interface InstrumentSummary {
  instrumentId: number;
  /** `'AAPL US Equity'`. */
  key: string;
  name: string;
  assetClass: string;
  currency: string;
}

export interface Portfolio {
  portfolioId: number;
  firmId: number;
  ownerUserId: number;
  name: string;
  baseCurrency: string;
  benchmarkInstrumentId: number | null;
  benchmark: InstrumentSummary | null;
  createdAt: string;
  updatedAt: string;
}

export type ReconStatus = 'ok' | 'unresolved' | 'duplicate' | 'price_missing';

export interface Position {
  positionId: number;
  portfolioId: number;
  asOfDate: string;
  instrument: InstrumentSummary | null;
  /** What the upload said: `'AAPL US'`, `'US0378331005'`, `'USD'`. */
  identifier: string;
  isCash: boolean;
  cashCurrency: string | null;
  lotId: string;
  quantity: number;
  costPrice: number | null;
  costCurrency: string | null;
  tradeDate: string | null;
  settleDate: string | null;
  accrued: number;
  reconStatus: ReconStatus;
  importId: number | null;
  /** The import's provenance (`internal.user`); `null` when the row predates any import. */
  provenanceId: number | null;
}

export interface Lot {
  lotId: number;
  portfolioId: number;
  instrumentId: number;
  openDate: string;
  quantity: number;
  unitCost: number;
  currency: string;
  closedDate: string | null;
  externalRef: string | null;
}

export type ImportChannel = 'upload' | 'file_drop' | 'api' | 'manual';
export type ImportStatus = 'accepted' | 'partial' | 'rejected';

export interface ImportError {
  row: number;
  identifier: string;
  column: string;
  reason: string;
}

export interface ImportReconciliation {
  matched: number;
  added: number;
  removed: number;
  quantityDiffs: { instrumentId: number; before: number; after: number }[];
}

export interface ImportReport {
  importId: number;
  portfolioId: number;
  channel: ImportChannel;
  filename: string | null;
  asOfDate: string;
  uploadedAt: string;
  status: ImportStatus;
  rowsTotal: number;
  rowsOk: number;
  rowsError: number;
  errors: ImportError[];
  reconciliation: ImportReconciliation;
  provenanceId: number | null;
}

/**
 * Raised when the portfolio does not exist **or** belongs to another firm — deliberately the same
 * error for both (see the module note). `no_imports` is a portfolio that exists but has never been
 * imported into, which is not an access failure.
 */
export class PortfolioAccessError extends Error {
  readonly code: 'not_found' | 'no_imports';
  readonly portfolioId: number;
  constructor(code: PortfolioAccessError['code'], portfolioId: number, message: string) {
    super(message);
    this.name = 'PortfolioAccessError';
    this.code = code;
    this.portfolioId = portfolioId;
  }
}

/** The service as `DataServices.portfolio` declares it, plus the two `/portfolios` route reads. */
export interface PortfolioService {
  get(id: number): Promise<Portfolio>;
  positions(id: number, asOfDate?: string): Promise<Position[]>;
  recon(id: number): Promise<ImportReport>;
  /** API.md §5.9 `GET /portfolios` — every portfolio of the caller's firm. */
  list(): Promise<Portfolio[]>;
  /** API.md §5.9 `GET /portfolios/:id/lots`. */
  lots(id: number, opts?: { open?: boolean }): Promise<Lot[]>;
  /** API.md §5.9 `GET /portfolios/:id/imports`. */
  imports(id: number, limit?: number): Promise<ImportReport[]>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Conversions
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, what: string): string {
  if (!DATE_RE.test(value)) {
    throw new RangeError(
      `data/portfolio: ${what} must be YYYY-MM-DD, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function assertId(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `data/portfolio: ${what} must be a positive integer, got ${String(value)}`,
    );
  }
  return value;
}

function num(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function reqNum(value: string | number | null, what: string): number {
  const n = num(value);
  if (n === null) throw new TypeError(`data/portfolio: ${what} is not a finite number`);
  return n;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function reqIso(value: Date | string, what: string): string {
  const s = iso(value);
  if (s === null) throw new TypeError(`data/portfolio: ${what} is null`);
  return s;
}

function dateOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

const RECON_STATUSES: readonly ReconStatus[] = ['ok', 'unresolved', 'duplicate', 'price_missing'];
const IMPORT_CHANNELS: readonly ImportChannel[] = ['upload', 'file_drop', 'api', 'manual'];
const IMPORT_STATUSES: readonly ImportStatus[] = ['accepted', 'partial', 'rejected'];

function oneOf<T extends string>(values: readonly T[], value: string, what: string): T {
  const hit = values.find((v) => v === value);
  if (hit === undefined) throw new TypeError(`data/portfolio: unknown ${what} '${value}'`);
  return hit;
}

/** `instruments` columns joined onto a position/benchmark row → `InstrumentSummary`. */
function toSummary(row: {
  instrument_id: string | null;
  inst_ticker: string | null;
  inst_exch: string | null;
  inst_sector: string | null;
  inst_name: string | null;
  inst_class: string | null;
  inst_currency: string | null;
}): InstrumentSummary | null {
  if (row.instrument_id === null || row.inst_ticker === null) return null;
  return {
    instrumentId: Number(row.instrument_id),
    key: `${row.inst_ticker} ${row.inst_exch ?? ''} ${row.inst_sector ?? ''}`.trim(),
    name: row.inst_name ?? '',
    assetClass: row.inst_class ?? '',
    currency: row.inst_currency ?? '',
  };
}

/** The `instruments` select list every join below shares, aliased `i`. */
const INSTRUMENT_COLUMNS = sql`
  i.ticker AS inst_ticker, i.exch_code AS inst_exch, i.market_sector::text AS inst_sector,
  i.name AS inst_name, i.asset_class::text AS inst_class, i.currency AS inst_currency`;

/** The bitemporal predicate on the joined `instruments` version. */
const instrumentAsOf = (at: AsOf) => sql`bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                                                  ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)`;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Portfolios
// ─────────────────────────────────────────────────────────────────────────────────────────────

type PortfolioRow = {
  portfolio_id: string;
  firm_id: string;
  owner_user_id: string;
  name: string;
  base_currency: string;
  benchmark_instrument_id: string | null;
  created_at: Date;
  updated_at: Date;
  instrument_id: string | null;
  inst_ticker: string | null;
  inst_exch: string | null;
  inst_sector: string | null;
  inst_name: string | null;
  inst_class: string | null;
  inst_currency: string | null;
};

function toPortfolio(row: PortfolioRow): Portfolio {
  return {
    portfolioId: Number(row.portfolio_id),
    firmId: Number(row.firm_id),
    ownerUserId: Number(row.owner_user_id),
    name: row.name,
    baseCurrency: row.base_currency,
    benchmarkInstrumentId:
      row.benchmark_instrument_id === null ? null : Number(row.benchmark_instrument_id),
    benchmark: toSummary(row),
    createdAt: reqIso(row.created_at, 'created_at'),
    updatedAt: reqIso(row.updated_at, 'updated_at'),
  };
}

const PORTFOLIO_COLUMNS = sql`
  pf.portfolio_id::text AS portfolio_id, pf.firm_id::text AS firm_id,
  pf.owner_user_id::text AS owner_user_id, pf.name, pf.base_currency,
  pf.benchmark_instrument_id::text AS benchmark_instrument_id, pf.created_at, pf.updated_at,
  i.instrument_id::text AS instrument_id, ${INSTRUMENT_COLUMNS}`;

/**
 * One portfolio of the caller's firm.
 *
 * @throws PortfolioAccessError `not_found` when it does not exist **or** belongs to another firm.
 */
export async function getPortfolio(
  tx: Tx,
  at: AsOf,
  scope: PortfolioScope,
  id: number,
): Promise<Portfolio> {
  assertId(id, 'portfolioId');
  const res = await tx.execute<PortfolioRow>(sql`
    SELECT ${PORTFOLIO_COLUMNS}
      FROM portfolios pf
      LEFT JOIN instruments i
             ON i.instrument_id = pf.benchmark_instrument_id
            AND ${instrumentAsOf(at)}
     WHERE pf.portfolio_id = ${id}::bigint
       AND pf.firm_id = ${scope.firmId}::bigint
     LIMIT 1`);
  const row = res.rows[0];
  if (row === undefined) {
    throw new PortfolioAccessError(
      'not_found',
      id,
      `data/portfolio: portfolio ${id} is not visible to firm ${scope.firmId}`,
    );
  }
  return toPortfolio(row);
}

/** Every portfolio of the caller's firm, by name. */
export async function listPortfolios(
  tx: Tx,
  at: AsOf,
  scope: PortfolioScope,
): Promise<Portfolio[]> {
  const res = await tx.execute<PortfolioRow>(sql`
    SELECT ${PORTFOLIO_COLUMNS}
      FROM portfolios pf
      LEFT JOIN instruments i
             ON i.instrument_id = pf.benchmark_instrument_id
            AND ${instrumentAsOf(at)}
     WHERE pf.firm_id = ${scope.firmId}::bigint
     ORDER BY pf.name, pf.portfolio_id`);
  return res.rows.map(toPortfolio);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Positions
// ─────────────────────────────────────────────────────────────────────────────────────────────

type PositionRow = {
  position_id: string;
  portfolio_id: string;
  as_of_date: string;
  instrument_id: string | null;
  raw_identifier: string;
  is_cash: boolean;
  cash_currency: string | null;
  lot_id: string;
  quantity: string;
  cost_price: string | null;
  cost_currency: string | null;
  trade_date: string | null;
  settle_date: string | null;
  accrued: string;
  recon_status: string;
  import_id: string | null;
  provenance_id: string | null;
  inst_ticker: string | null;
  inst_exch: string | null;
  inst_sector: string | null;
  inst_name: string | null;
  inst_class: string | null;
  inst_currency: string | null;
};

/**
 * The positions of `id` as of `asOfDate` (the greatest stored `as_of_date ≤` it), firm-scoped.
 *
 * The portfolio is resolved first — so another firm's id raises `not_found` rather than returning
 * an empty list — and the positions query then *also* filters `positions.firm_id`.
 */
export async function readPositions(
  tx: Tx,
  at: AsOf,
  scope: PortfolioScope,
  id: number,
  asOfDate?: string,
): Promise<Position[]> {
  await getPortfolio(tx, at, scope, id);
  const onOrBefore = asOfDate === undefined ? dateOf(at.validAt) : assertDate(asOfDate, 'asOfDate');
  const res = await tx.execute<PositionRow>(sql`
    WITH latest AS (
      SELECT max(as_of_date) AS as_of_date
        FROM positions
       WHERE portfolio_id = ${id}::bigint
         AND firm_id = ${scope.firmId}::bigint
         AND as_of_date <= ${onOrBefore}::date
    )
    SELECT ps.position_id::text AS position_id, ps.portfolio_id::text AS portfolio_id,
           ps.as_of_date::text AS as_of_date, ps.instrument_id::text AS instrument_id,
           ps.raw_identifier, ps.is_cash, ps.cash_currency, ps.lot_id,
           ps.quantity::text AS quantity, ps.cost_price::text AS cost_price, ps.cost_currency,
           ps.trade_date::text AS trade_date, ps.settle_date::text AS settle_date,
           ps.accrued::text AS accrued, ps.recon_status, ps.import_id::text AS import_id,
           im.provenance_id::text AS provenance_id,
           ${INSTRUMENT_COLUMNS}
      FROM positions ps
      JOIN latest l ON ps.as_of_date = l.as_of_date
      LEFT JOIN portfolio_imports im
             ON im.import_id = ps.import_id AND im.firm_id = ${scope.firmId}::bigint
      LEFT JOIN instruments i
             ON i.instrument_id = ps.instrument_id
            AND ${instrumentAsOf(at)}
     WHERE ps.portfolio_id = ${id}::bigint
       AND ps.firm_id = ${scope.firmId}::bigint
     ORDER BY ps.is_cash, ps.raw_identifier, ps.lot_id`);
  return res.rows.map((row) => ({
    positionId: Number(row.position_id),
    portfolioId: Number(row.portfolio_id),
    asOfDate: row.as_of_date,
    instrument: toSummary(row),
    identifier: row.raw_identifier,
    isCash: row.is_cash,
    cashCurrency: row.cash_currency,
    lotId: row.lot_id,
    quantity: reqNum(row.quantity, 'quantity'),
    costPrice: num(row.cost_price),
    costCurrency: row.cost_currency,
    tradeDate: row.trade_date,
    settleDate: row.settle_date,
    accrued: reqNum(row.accrued, 'accrued'),
    reconStatus: oneOf(RECON_STATUSES, row.recon_status, 'recon_status'),
    importId: row.import_id === null ? null : Number(row.import_id),
    provenanceId: row.provenance_id === null ? null : Number(row.provenance_id),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Lots
// ─────────────────────────────────────────────────────────────────────────────────────────────

type LotRow = {
  lot_id: string;
  portfolio_id: string;
  instrument_id: string;
  open_date: string;
  quantity: string;
  unit_cost: string;
  currency: string;
  closed_date: string | null;
  external_ref: string | null;
};

/** The lots of `id`, firm-scoped; `open: true` drops the closed ones. */
export async function readLots(
  tx: Tx,
  at: AsOf,
  scope: PortfolioScope,
  id: number,
  opts: { open?: boolean } = {},
): Promise<Lot[]> {
  await getPortfolio(tx, at, scope, id);
  const openOnly = opts.open === true ? sql` AND lt.closed_date IS NULL` : sql``;
  const res = await tx.execute<LotRow>(sql`
    SELECT lt.lot_id::text AS lot_id, lt.portfolio_id::text AS portfolio_id,
           lt.instrument_id::text AS instrument_id, lt.open_date::text AS open_date,
           lt.quantity::text AS quantity, lt.unit_cost::text AS unit_cost, lt.currency,
           lt.closed_date::text AS closed_date, lt.external_ref
      FROM lots lt
     WHERE lt.portfolio_id = ${id}::bigint
       AND lt.firm_id = ${scope.firmId}::bigint${openOnly}
     ORDER BY lt.open_date, lt.lot_id`);
  return res.rows.map((row) => ({
    lotId: Number(row.lot_id),
    portfolioId: Number(row.portfolio_id),
    instrumentId: Number(row.instrument_id),
    openDate: row.open_date,
    quantity: reqNum(row.quantity, 'quantity'),
    unitCost: reqNum(row.unit_cost, 'unit_cost'),
    currency: row.currency,
    closedDate: row.closed_date,
    externalRef: row.external_ref,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Imports / reconciliation
// ─────────────────────────────────────────────────────────────────────────────────────────────

type ImportRow = {
  import_id: string;
  portfolio_id: string;
  channel: string;
  filename: string | null;
  as_of_date: string;
  uploaded_at: Date;
  status: string;
  rows_total: number;
  rows_ok: number;
  rows_error: number;
  errors: unknown;
  reconciliation: unknown;
  provenance_id: string | null;
};

function toErrors(value: unknown): ImportError[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    return [
      {
        row: typeof e.row === 'number' ? e.row : 0,
        identifier: typeof e.identifier === 'string' ? e.identifier : '',
        column: typeof e.column === 'string' ? e.column : '',
        reason: typeof e.reason === 'string' ? e.reason : '',
      },
    ];
  });
}

function toReconciliation(value: unknown): ImportReconciliation {
  const empty: ImportReconciliation = { matched: 0, added: 0, removed: 0, quantityDiffs: [] };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return empty;
  const r = value as Record<string, unknown>;
  const diffs = Array.isArray(r.quantityDiffs) ? r.quantityDiffs : [];
  return {
    matched: typeof r.matched === 'number' ? r.matched : 0,
    added: typeof r.added === 'number' ? r.added : 0,
    removed: typeof r.removed === 'number' ? r.removed : 0,
    quantityDiffs: diffs.flatMap((entry) => {
      if (entry === null || typeof entry !== 'object') return [];
      const d = entry as Record<string, unknown>;
      if (
        typeof d.instrumentId !== 'number' ||
        typeof d.before !== 'number' ||
        typeof d.after !== 'number'
      ) {
        return [];
      }
      return [{ instrumentId: d.instrumentId, before: d.before, after: d.after }];
    }),
  };
}

function toReport(row: ImportRow): ImportReport {
  return {
    importId: Number(row.import_id),
    portfolioId: Number(row.portfolio_id),
    channel: oneOf(IMPORT_CHANNELS, row.channel, 'channel'),
    filename: row.filename,
    asOfDate: row.as_of_date,
    uploadedAt: reqIso(row.uploaded_at, 'uploaded_at'),
    status: oneOf(IMPORT_STATUSES, row.status, 'status'),
    rowsTotal: Number(row.rows_total),
    rowsOk: Number(row.rows_ok),
    rowsError: Number(row.rows_error),
    errors: toErrors(row.errors),
    reconciliation: toReconciliation(row.reconciliation),
    provenanceId: row.provenance_id === null ? null : Number(row.provenance_id),
  };
}

const IMPORT_COLUMNS = sql`
  im.import_id::text AS import_id, im.portfolio_id::text AS portfolio_id, im.channel, im.filename,
  im.as_of_date::text AS as_of_date, im.uploaded_at, im.status, im.rows_total, im.rows_ok,
  im.rows_error, im.errors, im.reconciliation, im.provenance_id::text AS provenance_id`;

/** The import history of `id`, newest first, firm-scoped. */
export async function readImports(
  tx: Tx,
  at: AsOf,
  scope: PortfolioScope,
  id: number,
  limit = 50,
): Promise<ImportReport[]> {
  await getPortfolio(tx, at, scope, id);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`data/portfolio: limit must be a positive integer, got ${String(limit)}`);
  }
  const res = await tx.execute<ImportRow>(sql`
    SELECT ${IMPORT_COLUMNS}
      FROM portfolio_imports im
     WHERE im.portfolio_id = ${id}::bigint
       AND im.firm_id = ${scope.firmId}::bigint
     ORDER BY im.uploaded_at DESC, im.import_id DESC
     LIMIT ${limit}`);
  return res.rows.map(toReport);
}

/**
 * `DataServices.portfolio.recon` — the most recent import report (PORT-01).
 *
 * @throws PortfolioAccessError `not_found` for another firm's portfolio, `no_imports` for one of
 *         the caller's own that has never been imported into.
 */
export async function readRecon(
  tx: Tx,
  at: AsOf,
  scope: PortfolioScope,
  id: number,
): Promise<ImportReport> {
  const reports = await readImports(tx, at, scope, id, 1);
  const report = reports[0];
  if (report === undefined) {
    throw new PortfolioAccessError(
      'no_imports',
      id,
      `data/portfolio: portfolio ${id} has no import to reconcile`,
    );
  }
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `DataServices.portfolio`, bound to one transaction, one `(validAt, knownAt)` pair **and one
 * firm**. There is deliberately no unscoped constructor.
 */
export function portfolioService(tx: Tx, at: AsOf, scope: PortfolioScope): PortfolioService {
  assertId(scope.firmId, 'scope.firmId');
  assertId(scope.userId, 'scope.userId');
  const frozen: PortfolioScope = Object.freeze({ firmId: scope.firmId, userId: scope.userId });
  return {
    get: (id) => getPortfolio(tx, at, frozen, id),
    positions: (id, asOfDate) => readPositions(tx, at, frozen, id, asOfDate),
    recon: (id) => readRecon(tx, at, frozen, id),
    list: () => listPortfolios(tx, at, frozen),
    lots: (id, opts) => readLots(tx, at, frozen, id, opts),
    imports: (id, limit) => readImports(tx, at, frozen, id, limit),
  };
}
