/**
 * `portfolio/service.ts` — the write half of the portfolio surface (WORKPLAN WP-10 L1234-1238,
 * API.md §5.9 L670-696, FUNCTIONS_TIER2 §PORT). PORT-01 … PORT-07.
 *
 * `data/portfolio.ts` reads portfolios, positions, lots and imports. This module is everything
 * that *changes* them, plus the glue that hands a valued book to WP-02's analytics engines. It is
 * the only writer, and the three things it exists to get right are:
 *
 *  1. **An import is a reconciliation, not an insert.** Every upload lands as one
 *     `portfolio_imports` row carrying `rows_total/ok/error`, a per-row `errors[]` of
 *     `{row, identifier, column, reason}` and a `reconciliation` of
 *     `{matched, added, removed, quantityDiffs}` against the book it replaced (PORT-01). A row
 *     whose identifier does not resolve is *not* silently dropped and *not* guessed: it is written
 *     as a position with `instrument_id NULL` and `recon_status 'unresolved'`, counted in
 *     `rows_error`, given an `errors[]` entry and queued as an open `data_exceptions` row
 *     (kind `unresolved_identifier`, REF-10) so a human sees it. The import's status is then
 *     `partial` — accepted work plus a named failure, which is what a desk needs at 7am.
 *  2. **Re-uploading the same file changes nothing.** The positions of `(portfolio, asOfDate)` are
 *     replaced wholesale, the lots this import opened are keyed by `external_ref` and replaced the
 *     same way, and an exception already open for the same `(portfolio, asOfDate, identifier)` is
 *     not raised twice. So a second upload of the same CSV leaves every row count where it was;
 *     only `portfolio_imports` grows, because an import history that forgets an attempt is not a
 *     history. The reconciliation of that second run reports `matched = n, added = 0, removed = 0`,
 *     which is the machine-readable statement that nothing moved.
 *  3. **Nothing here invents a number.** A row with an unreadable quantity is an error, never a
 *     zero. A holding with no price has a null market value and is excluded from the totals rather
 *     than valued at zero. The analytics glue passes through to `core/analytics/portfolio/*` and
 *     hands back that engine's own `EngineResult`, so every figure on a screen carries the
 *     `{name, version, inputsHash}` that produced it (ANAL-08) — this module implements no
 *     statistic of its own.
 *
 * **Tenancy.** Every statement carries `firm_id` in its own `WHERE`/`VALUES`, beside — never
 * instead of — migration 0015's RLS policies, for the same reason `data/portfolio.ts` does: the
 * local database owner is a superuser and bypasses RLS, so a test that passed only under RLS would
 * prove nothing about the code. A portfolio of another firm raises `PortfolioAccessError`
 * `not_found`, which the route turns into `404` (PORT-07).
 */

import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Clock } from '@terminal/core';
import { engineMeta } from '@terminal/core/analytics/engine';
import {
  attributionEngine,
  segmentsFromHoldings,
  type AttributionHolding,
  type AttributionResult,
} from '@terminal/core/analytics/portfolio/attribution';
import {
  exposureEngine,
  type ExposureResult,
  type PortfolioAssetClass,
  type Position as ExposurePosition,
} from '@terminal/core/analytics/portfolio/exposure';
import {
  portfolioRiskEngine,
  type PortfolioRiskSummary,
  type RiskHolding,
  type Scenario,
} from '@terminal/core/analytics/portfolio/risk';

import {
  getPortfolio,
  readImports,
  readPositions,
  type ImportChannel,
  type ImportError,
  type ImportReconciliation,
  type ImportReport,
  type PortfolioScope,
  type Position,
  type ReconStatus,
} from '../data/portfolio.js';
import type { AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';
import { SecurityResolver } from '../refdata/resolve.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV parsing (API.md §5.9: `identifier,quantity,cost_price,cost_currency,lot_id,trade_date`)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The columns the documented header names, in order. */
export const IMPORT_CSV_COLUMNS = [
  'identifier',
  'quantity',
  'cost_price',
  'cost_currency',
  'lot_id',
  'trade_date',
] as const;

/**
 * Columns beyond the documented six that an upload may carry. They are optional: a file with the
 * documented header alone imports exactly as before, and a desk that keeps cash and settlement
 * dates in the same export does not have to strip them.
 */
const OPTIONAL_CSV_COLUMNS = ['settle_date', 'is_cash', 'cash_currency'] as const;

const KNOWN_CSV_COLUMNS: readonly string[] = [...IMPORT_CSV_COLUMNS, ...OPTIONAL_CSV_COLUMNS];

/** One upload line, already typed but not yet resolved against the instrument master. */
export interface ImportRowInput {
  /** 1-based, counting data rows — the number the desk sees in its spreadsheet minus the header. */
  row: number;
  identifier: string;
  quantity: number;
  costPrice: number | null;
  costCurrency: string | null;
  lotId: string;
  tradeDate: string | null;
  settleDate: string | null;
  isCash: boolean;
  cashCurrency: string | null;
}

/** What {@link parseImportCsv} produces: the rows it could type, and one error per row it could not. */
export interface ParsedImportCsv {
  rows: ImportRowInput[];
  errors: ImportError[];
  /** Data lines seen, whether or not they parsed. */
  rowsTotal: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CCY_RE = /^[A-Za-z]{3}$/;

/** The whole file is unreadable — no header, or no `identifier`/`quantity` column. */
export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFormatError';
  }
}

/**
 * Split one CSV line, honouring RFC 4180 double quoting (`"a,b"`, `""` for a literal quote).
 * Hand-written rather than pulled in: the grammar is twenty lines, and a dependency that parses a
 * header we do not control is a dependency that decides what an identifier is.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch ?? '';
      }
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      quoted = true;
      field = '';
      continue;
    }
    if (ch === ',') {
      out.push(field);
      field = '';
      continue;
    }
    field += ch ?? '';
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** A boolean column as an upload spells it. Anything else is an error, not a silent `false`. */
function parseBoolean(raw: string): boolean | undefined {
  const v = raw.toLowerCase();
  if (v === '' || v === 'false' || v === 'f' || v === '0' || v === 'no' || v === 'n') return false;
  if (v === 'true' || v === 't' || v === '1' || v === 'yes' || v === 'y') return true;
  return undefined;
}

/**
 * Parse an upload into typed rows plus one `ImportError` per row that could not be typed.
 *
 * Header-driven rather than position-driven: the documented order is the common case, but a file
 * whose columns are shuffled is a file whose columns are named, and refusing it would be pedantry.
 * A missing `identifier` or `quantity` column *is* refused — for the whole file, as a thrown
 * {@link ImportFormatError}, because no row in it can be read.
 */
export function parseImportCsv(text: string): ParsedImportCsv {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = withoutBom.split(/\r\n|\n|\r/);
  const headerLine = lines[0];
  if (headerLine === undefined || headerLine.trim() === '') {
    throw new ImportFormatError('the uploaded file is empty: expected a CSV header row');
  }
  const header = splitCsvLine(headerLine).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const index = (name: string): number => header.indexOf(name);
  for (const required of ['identifier', 'quantity']) {
    if (index(required) < 0) {
      throw new ImportFormatError(
        `the uploaded CSV has no '${required}' column; expected the header ` +
          `'${IMPORT_CSV_COLUMNS.join(',')}' (got '${header.join(',')}')`,
      );
    }
  }
  const unknown = header.filter((h) => h !== '' && !KNOWN_CSV_COLUMNS.includes(h));

  const rows: ImportRowInput[] = [];
  const errors: ImportError[] = [];
  let rowsTotal = 0;

  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined || raw.trim() === '') continue;
    rowsTotal += 1;
    const cells = splitCsvLine(raw);
    const at = (name: string): string => {
      const col = index(name);
      return col < 0 ? '' : (cells[col] ?? '');
    };
    const rowNo = rowsTotal;
    const identifier = at('identifier');
    const fail = (column: string, reason: string): void => {
      errors.push({ row: rowNo, identifier, column, reason });
    };

    if (identifier === '') {
      fail('identifier', 'IDENTIFIER_MISSING: the identifier cell is empty');
      continue;
    }
    const quantityRaw = at('quantity').replace(/,/g, '');
    const quantity = Number(quantityRaw);
    if (quantityRaw === '' || !Number.isFinite(quantity)) {
      fail('quantity', `QUANTITY_NOT_A_NUMBER: '${at('quantity')}' is not a number`);
      continue;
    }

    const costRaw = at('cost_price').replace(/,/g, '');
    let costPrice: number | null = null;
    if (costRaw !== '') {
      const parsed = Number(costRaw);
      if (!Number.isFinite(parsed)) {
        fail('cost_price', `COST_NOT_A_NUMBER: '${at('cost_price')}' is not a number`);
        continue;
      }
      costPrice = parsed;
    }

    const costCurrency = at('cost_currency');
    if (costCurrency !== '' && !CCY_RE.test(costCurrency)) {
      fail('cost_currency', `BAD_CURRENCY: '${costCurrency}' is not a 3-letter ISO 4217 code`);
      continue;
    }
    const cashCurrency = at('cash_currency');
    if (cashCurrency !== '' && !CCY_RE.test(cashCurrency)) {
      fail('cash_currency', `BAD_CURRENCY: '${cashCurrency}' is not a 3-letter ISO 4217 code`);
      continue;
    }

    const tradeDate = at('trade_date');
    if (tradeDate !== '' && !DATE_RE.test(tradeDate)) {
      fail('trade_date', `BAD_DATE: '${tradeDate}' is not YYYY-MM-DD`);
      continue;
    }
    const settleDate = at('settle_date');
    if (settleDate !== '' && !DATE_RE.test(settleDate)) {
      fail('settle_date', `BAD_DATE: '${settleDate}' is not YYYY-MM-DD`);
      continue;
    }

    const isCash = parseBoolean(at('is_cash'));
    if (isCash === undefined) {
      fail('is_cash', `BAD_BOOLEAN: '${at('is_cash')}' is not true/false`);
      continue;
    }

    rows.push({
      row: rowNo,
      identifier,
      quantity,
      costPrice,
      costCurrency: costCurrency === '' ? null : costCurrency.toUpperCase(),
      lotId: at('lot_id') === '' ? 'default' : at('lot_id'),
      tradeDate: tradeDate === '' ? null : tradeDate,
      settleDate: settleDate === '' ? null : settleDate,
      isCash,
      cashCurrency: cashCurrency === '' ? null : cashCurrency.toUpperCase(),
    });
  }

  if (unknown.length > 0) {
    // Not fatal — the rows parsed — but it travels with the report so an operator learns that a
    // column they believed in was ignored, rather than wondering why a field never appears.
    // `row: 0` marks it as a file-level note: it is not counted against `rows_error`.
    errors.push({
      row: 0,
      identifier: '',
      column: unknown.join(','),
      reason: `UNKNOWN_COLUMN: ignored ${
        unknown.length === 1 ? 'a column' : 'columns'
      } not in the documented header`,
    });
  }

  return { rows, errors, rowsTotal };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Import (PORT-01, PORT-02)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What {@link importPositions} is asked to write. */
export interface ImportRequest {
  portfolioId: number;
  /** The date the positions are stated as of; the replace key together with `portfolioId`. */
  asOfDate: string;
  channel: ImportChannel;
  /** The uploaded file name, `null` for the API and manual channels. */
  filename?: string | null;
  /** The typed rows. `parseImportCsv` produces them for the upload channel. */
  rows: readonly ImportRowInput[];
  /** Row-level failures the parser already found; carried into `errors[]` untouched. */
  parseErrors?: readonly ImportError[];
  /** Data lines the file held, including the ones that did not parse. */
  rowsTotal?: number;
  /**
   * The bytes provenance is taken over: the CSV text for an upload, the JSON body for the API
   * channel. Hashed into `provenance.response_sha256` so a position can be traced to the exact
   * payload that asserted it.
   */
  payload: string;
}

/** A row staged for insertion: what it resolved to, and the status that resolution earned it. */
interface StagedRow {
  input: ImportRowInput;
  instrumentId: number | null;
  reconStatus: ReconStatus;
}

const ADAPTER_VERSION = 'portfolio/1.0.0';

function assertDate(value: string, what: string): string {
  if (!DATE_RE.test(value)) {
    throw new RangeError(
      `portfolio/service: ${what} must be YYYY-MM-DD, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * The provenance row one import writes (`internal.user`, DATA-09).
 *
 * Written by hand rather than through `providers/provenance.ts#insertProvenance`, which takes a
 * `RawRecord` from an HTTP adapter: `internal.user` has no adapter and no `ProviderId`, and
 * inventing one so the helper type-checks would be a lie about where the bytes came from.
 */
async function writeProvenance(
  tx: Tx,
  clock: Clock,
  req: { portfolioId: number; asOfDate: string; channel: ImportChannel; payload: string },
): Promise<number> {
  const requestKey = `portfolio:${String(req.portfolioId)}:${req.asOfDate}:${req.channel}`;
  const requestHash = createHash('sha256').update(requestKey, 'utf8').digest('hex');
  const digest = createHash('sha256').update(req.payload, 'utf8').digest('hex');
  const capturedAt = new Date(clock.now()).toISOString();
  const res = await tx.execute<{ provenance_id: string }>(sql`
    INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                            http_status, bytes, captured_at, source_ts, adapter_version)
    VALUES ('internal.user', ${requestKey}, ${`internal://portfolio/${req.channel}`},
            decode(${requestHash}, 'hex'), decode(${digest}, 'hex'), 200,
            ${Buffer.byteLength(req.payload, 'utf8')}, ${capturedAt}::timestamptz, NULL,
            ${ADAPTER_VERSION})
    RETURNING provenance_id::text AS provenance_id`);
  const row = res.rows[0];
  if (row === undefined) {
    throw new Error('portfolio/service: the provenance insert returned no row');
  }
  return Number(row.provenance_id);
}

/**
 * Queue one unresolved identifier for the data-ops exception queue (REF-10), unless an open row
 * already names the same `(portfolio, as-of, identifier)` — a desk that re-uploads the same broken
 * file three times has one problem, not three.
 */
async function raiseUnresolvedException(
  tx: Tx,
  scope: PortfolioScope,
  provenanceId: number,
  ctx: { portfolioId: number; asOfDate: string; identifier: string; row: number },
): Promise<void> {
  const marker = JSON.stringify([
    { portfolioId: ctx.portfolioId, asOfDate: ctx.asOfDate, value: ctx.identifier },
  ]);
  // The dedupe read is scoped by `firm_id` for the same reason the insert sets it: two firms may
  // legitimately upload the same identifier on the same date, and a match on another firm's row
  // would both swallow this firm's exception and confirm that the other firm's row exists.
  const open = await tx.execute<{ exception_id: string }>(sql`
    SELECT exception_id::text AS exception_id
      FROM data_exceptions
     WHERE kind = 'unresolved_identifier'
       AND status = 'open'
       AND firm_id = ${String(scope.firmId)}::bigint
       AND candidates @> ${marker}::jsonb
     LIMIT 1`);
  if (open.rows.length > 0) return;

  const candidates = JSON.stringify([
    {
      sourceId: 'internal.user',
      provenanceId,
      value: ctx.identifier,
      portfolioId: ctx.portfolioId,
      asOfDate: ctx.asOfDate,
      row: ctx.row,
    },
  ]);
  // `firm_id` is not decoration: `candidates` carries the uploaded identifier, the portfolio id,
  // the as-of date and the uploader, so this row is tenant data — `entity_kind` cannot say so
  // (its enum has no `portfolio` member). Migration 0019 gives `data_exceptions` the column, the
  // RLS policy and the reader predicate that keep the row inside the firm that uploaded it
  // (PORT-07); without it the row is visible to every other firm's dataops reader, which is
  // exactly the confirmation the 404-not-403 rule exists to deny.
  await tx.execute(sql`
    INSERT INTO data_exceptions (kind, firm_id, field, candidates, reported_by, status)
    VALUES ('unresolved_identifier', ${String(scope.firmId)}::bigint, 'positions.raw_identifier',
            ${candidates}::jsonb, ${String(scope.userId)}::bigint, 'open')`);
}

/** One line of the book being reconciled, on either side. */
interface ReconRow {
  instrumentId: number | null;
  identifier: string;
  quantity: number;
}

/**
 * The book this import is reconciled against: the rows already stored for the same `as_of_date`
 * when there are any (the re-upload case, where "nothing changed" is the answer a desk wants), and
 * otherwise the most recent earlier date (the next-morning case, where the answer is yesterday's
 * book). Always comparing against nothing would report every position as `added` on the first
 * upload of every date — true, and useless.
 */
async function baselineOf(
  tx: Tx,
  scope: PortfolioScope,
  portfolioId: number,
  asOfDate: string,
): Promise<ReconRow[]> {
  const res = await tx.execute<{
    instrument_id: string | null;
    raw_identifier: string;
    quantity: string;
  }>(sql`
    WITH baseline AS (
      SELECT max(as_of_date) AS as_of_date
        FROM positions
       WHERE portfolio_id = ${String(portfolioId)}::bigint
         AND firm_id = ${String(scope.firmId)}::bigint
         AND as_of_date <= ${asOfDate}::date
    )
    SELECT ps.instrument_id::text AS instrument_id, ps.raw_identifier,
           ps.quantity::text AS quantity
      FROM positions ps
      JOIN baseline b ON ps.as_of_date = b.as_of_date
     WHERE ps.portfolio_id = ${String(portfolioId)}::bigint
       AND ps.firm_id = ${String(scope.firmId)}::bigint`);
  return res.rows.map((r) => ({
    instrumentId: r.instrument_id === null ? null : Number(r.instrument_id),
    identifier: r.raw_identifier,
    quantity: Number(r.quantity),
  }));
}

/** The key a holding reconciles on: its instrument when it resolved, else the raw text. */
function reconKey(row: { instrumentId: number | null; identifier: string }): string {
  return row.instrumentId === null ? `raw:${row.identifier}` : `id:${String(row.instrumentId)}`;
}

/** PORT-01's `{matched, added, removed, quantityDiffs}`, lots rolled up per instrument. */
export function reconcile(
  before: readonly ReconRow[],
  after: readonly ReconRow[],
): ImportReconciliation {
  const roll = (rows: readonly ReconRow[]): Map<string, ReconRow> => {
    const out = new Map<string, ReconRow>();
    for (const row of rows) {
      const key = reconKey(row);
      const held = out.get(key);
      if (held === undefined) out.set(key, { ...row });
      else held.quantity += row.quantity;
    }
    return out;
  };
  const b = roll(before);
  const a = roll(after);

  let matched = 0;
  let added = 0;
  const quantityDiffs: { instrumentId: number; before: number; after: number }[] = [];
  for (const [key, row] of a) {
    const prior = b.get(key);
    if (prior === undefined) {
      added += 1;
      continue;
    }
    matched += 1;
    if (prior.quantity !== row.quantity && row.instrumentId !== null) {
      quantityDiffs.push({
        instrumentId: row.instrumentId,
        before: prior.quantity,
        after: row.quantity,
      });
    }
  }
  let removed = 0;
  for (const key of b.keys()) if (!a.has(key)) removed += 1;

  quantityDiffs.sort((x, y) => x.instrumentId - y.instrumentId);
  return { matched, added, removed, quantityDiffs };
}

/**
 * Write one import: resolve, reconcile, replace and report (PORT-01, PORT-02).
 *
 * @throws PortfolioAccessError `not_found` for a portfolio of another firm (or none at all).
 * @throws RangeError for an `asOfDate` that is not `YYYY-MM-DD`.
 */
export async function importPositions(
  tx: Tx,
  at: AsOf,
  scope: PortfolioScope,
  clock: Clock,
  req: ImportRequest,
): Promise<ImportReport> {
  const portfolio = await getPortfolio(tx, at, scope, req.portfolioId);
  const asOfDate = assertDate(req.asOfDate, 'asOfDate');

  // Serialise the whole replace on the portfolio row before anything reads the baseline.
  //
  // Without this, two uploads of the same `(portfolio, as-of)` interleave into a book neither of
  // them asserted: under READ COMMITTED the second DELETE blocks on the first transaction's row
  // locks and, once it commits, re-evaluates against a snapshot taken *before* that commit — so it
  // deletes only the rows the first import had already deleted, never sees the rows the first
  // import inserted, and the two full replacements union. `lots` unions the same way (it has no
  // unique key at all), and the `portfolio_imports` row the second upload writes then reports a
  // reconciliation against a baseline that no longer exists. A desk that double-clicks Upload
  // silently gets a merged portfolio that every downstream analytic then values.
  //
  // `FOR UPDATE` on the portfolio makes the second import wait for the first to commit, re-read
  // the real baseline and produce a truthful reconciliation. `firm_id` is in the predicate for the
  // same reason every other statement here carries it: RLS is the second lock, never the only one.

  await tx.execute(sql`
    SELECT 1
      FROM portfolios
     WHERE portfolio_id = ${String(portfolio.portfolioId)}::bigint
       AND firm_id = ${String(scope.firmId)}::bigint
       FOR UPDATE`);

  const provenanceId = await writeProvenance(tx, clock, {
    portfolioId: portfolio.portfolioId,
    asOfDate,
    channel: req.channel,
    payload: req.payload,
  });

  const errors: ImportError[] = [...(req.parseErrors ?? [])];
  const resolver = new SecurityResolver(tx);
  const staged: StagedRow[] = [];
  const seen = new Map<string, StagedRow>();

  for (const input of req.rows) {
    const key = `${input.identifier}|${input.lotId}`;
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push({
        row: input.row,
        identifier: input.identifier,
        column: 'lot_id',
        reason: `DUPLICATE_LOT: '${input.identifier}' already appears in lot '${input.lotId}'`,
      });
      // The surviving line is flagged so the screen shows which holding the duplicate collided
      // with; the duplicate itself is not written, because the unique key forbids it and silently
      // summing the two lines would invent a quantity nobody uploaded.
      first.reconStatus = 'duplicate';
      continue;
    }

    let row: StagedRow;
    if (input.isCash) {
      row = { input, instrumentId: null, reconStatus: 'ok' };
    } else {
      const outcome = await resolver.resolve(input.identifier, at);
      if (outcome.ok) {
        row = { input, instrumentId: outcome.instrument.instrumentId, reconStatus: 'ok' };
      } else {
        errors.push({
          row: input.row,
          identifier: input.identifier,
          column: 'identifier',
          reason: `${outcome.code}: ${outcome.message}`,
        });
        row = { input, instrumentId: null, reconStatus: 'unresolved' };
        await raiseUnresolvedException(tx, scope, provenanceId, {
          portfolioId: portfolio.portfolioId,
          asOfDate,
          identifier: input.identifier,
          row: input.row,
        });
      }
    }
    staged.push(row);
    seen.set(key, row);
  }

  const baseline = await baselineOf(tx, scope, portfolio.portfolioId, asOfDate);
  const reconciliation = reconcile(
    baseline,
    staged.map((s) => ({
      instrumentId: s.instrumentId,
      identifier: s.input.identifier,
      quantity: s.input.quantity,
    })),
  );

  const rowsTotal = req.rowsTotal ?? req.rows.length;
  // One row produces at most one failure: a parse error, an unresolved identifier or a duplicate
  // lot. `row: 0` is the file-level note `parseImportCsv` emits for an ignored column, which is
  // not a row failure and must not make an otherwise clean import look partial.
  const failedRows = new Set(errors.filter((e) => e.row > 0).map((e) => e.row));
  const rowsError = failedRows.size;
  const rowsOk = Math.max(rowsTotal - rowsError, 0);
  const status: ImportReport['status'] =
    rowsError === 0 ? 'accepted' : rowsOk === 0 ? 'rejected' : 'partial';

  const inserted = await tx.execute<{ import_id: string }>(sql`
    INSERT INTO portfolio_imports (portfolio_id, firm_id, uploaded_by, uploaded_at, channel,
                                   filename, as_of_date, rows_total, rows_ok, rows_error,
                                   errors, reconciliation, status, provenance_id)
    VALUES (${String(portfolio.portfolioId)}::bigint, ${String(scope.firmId)}::bigint,
            ${String(scope.userId)}::bigint, ${new Date(clock.now()).toISOString()}::timestamptz,
            ${req.channel}, ${req.filename ?? null}, ${asOfDate}::date,
            ${rowsTotal}, ${rowsOk}, ${rowsError},
            ${JSON.stringify(errors)}::jsonb, ${JSON.stringify(reconciliation)}::jsonb,
            ${status}, ${String(provenanceId)}::bigint)
    RETURNING import_id::text AS import_id`);
  const importRow = inserted.rows[0];
  if (importRow === undefined) {
    throw new Error('portfolio/service: the portfolio_imports insert returned no row');
  }
  const importId = Number(importRow.import_id);

  // Replace, never append: an as-of snapshot is the whole book on that date, so a second upload of
  // the same date is a correction of it and not an addition to it. This is what makes a re-upload
  // idempotent in row counts.
  await tx.execute(sql`
    DELETE FROM positions
     WHERE portfolio_id = ${String(portfolio.portfolioId)}::bigint
       AND firm_id = ${String(scope.firmId)}::bigint
       AND as_of_date = ${asOfDate}::date`);

  for (const s of staged) {
    const { input } = s;
    await tx.execute(sql`
      INSERT INTO positions (portfolio_id, firm_id, as_of_date, instrument_id, raw_identifier,
                             is_cash, cash_currency, lot_id, quantity, cost_price, cost_currency,
                             trade_date, settle_date, accrued, recon_status, import_id)
      VALUES (${String(portfolio.portfolioId)}::bigint, ${String(scope.firmId)}::bigint,
              ${asOfDate}::date,
              ${s.instrumentId === null ? null : String(s.instrumentId)}::bigint,
              ${input.identifier}, ${input.isCash},
              ${input.isCash ? (input.cashCurrency ?? portfolio.baseCurrency) : null},
              ${input.lotId}, ${String(input.quantity)}::numeric,
              ${input.costPrice === null ? null : String(input.costPrice)}::numeric,
              ${input.costCurrency}, ${input.tradeDate}::date, ${input.settleDate}::date,
              0, ${s.reconStatus}, ${String(importId)}::bigint)`);
  }

  // PORT-02 lot-level cost basis. `external_ref` is this import's own key for the line, which
  // makes the lot set of an as-of date replaceable — and therefore a re-upload idempotent —
  // without a unique constraint `lots` does not have.
  const lotRefPrefix = `import:${asOfDate}:`;
  await tx.execute(sql`
    DELETE FROM lots
     WHERE portfolio_id = ${String(portfolio.portfolioId)}::bigint
       AND firm_id = ${String(scope.firmId)}::bigint
       AND external_ref LIKE ${`${lotRefPrefix}%`}`);
  for (const s of staged) {
    if (s.instrumentId === null || s.input.isCash || s.input.costPrice === null) continue;
    await tx.execute(sql`
      INSERT INTO lots (portfolio_id, firm_id, instrument_id, open_date, quantity, unit_cost,
                        currency, closed_date, external_ref)
      VALUES (${String(portfolio.portfolioId)}::bigint, ${String(scope.firmId)}::bigint,
              ${String(s.instrumentId)}::bigint, ${s.input.tradeDate ?? asOfDate}::date,
              ${String(s.input.quantity)}::numeric, ${String(s.input.costPrice)}::numeric,
              ${s.input.costCurrency ?? portfolio.baseCurrency}, NULL,
              ${`${lotRefPrefix}${s.input.lotId}:${s.input.identifier}`})`);
  }

  await tx.execute(sql`
    UPDATE portfolios
       SET updated_at = ${new Date(clock.now()).toISOString()}::timestamptz
     WHERE portfolio_id = ${String(portfolio.portfolioId)}::bigint
       AND firm_id = ${String(scope.firmId)}::bigint`);

  const reports = await readImports(tx, at, scope, portfolio.portfolioId, 1);
  const report = reports[0];
  if (report === undefined) {
    throw new Error('portfolio/service: the import written above was not readable back');
  }
  return report;
}

/** One position as `PUT /portfolios/:id/positions` states it (API.md §5.9 `PositionInput`). */
export interface PositionInputRow {
  identifier: string;
  quantity: number;
  costPrice?: number | undefined;
  costCurrency?: string | undefined;
  lotId: string;
  tradeDate?: string | undefined;
  settleDate?: string | undefined;
  isCash: boolean;
  cashCurrency?: string | undefined;
}

/**
 * `PUT /portfolios/:id/positions` — the API channel's full replace for one date, run through the
 * same import path as an upload so that the reconciliation, the exception queue and the provenance
 * row are identical whichever door the positions came in by (API.md §5.9 L693).
 */
export async function replacePositions(
  tx: Tx,
  at: AsOf,
  scope: PortfolioScope,
  clock: Clock,
  input: { portfolioId: number; asOfDate: string; positions: readonly PositionInputRow[] },
): Promise<ImportReport> {
  const rows: ImportRowInput[] = input.positions.map((p, i) => ({
    row: i + 1,
    identifier: p.identifier,
    quantity: p.quantity,
    costPrice: p.costPrice ?? null,
    costCurrency: p.costCurrency ?? null,
    lotId: p.lotId,
    tradeDate: p.tradeDate ?? null,
    settleDate: p.settleDate ?? null,
    isCash: p.isCash,
    cashCurrency: p.cashCurrency ?? null,
  }));
  return importPositions(tx, at, scope, clock, {
    portfolioId: input.portfolioId,
    asOfDate: input.asOfDate,
    channel: 'api',
    filename: null,
    rows,
    rowsTotal: rows.length,
    payload: JSON.stringify({ asOfDate: input.asOfDate, positions: input.positions }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Analytics glue (PORT-03 … PORT-06)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One holding, as the analytics take it.
 *
 * `key` is what the engines use as their `instrumentId` — a string, because `core/analytics` is
 * written against opaque keys and a cash line has no instrument id. Use the command-line key
 * (`'AAPL US Equity'`) where there is one and the raw upload identifier otherwise, so an engine's
 * error message names something a person can look up.
 */
export interface ValuedHolding {
  key: string;
  instrumentId: number | null;
  assetClass: PortfolioAssetClass;
  /** GICS level-1 name; `null` groups under the exposure engine's `Unclassified`. */
  sector: string | null;
  currency: string;
  quantity: number;
  /** Last price in `currency`; `null` when the name is unpriced — never a zero. */
  price: number | null;
  /**
   * Lot-weighted cost price in `currency`, when the book carries one. Used only as the fallback
   * size of an *unpriced* line in `pricedWeight`'s denominator — never as a substitute price.
   */
  costPrice?: number | null;
  /** Units of base currency per unit of `currency`; `null` when the pair is missing. */
  fxRate: number | null;
  multiplier?: number;
  isCash: boolean;
}

/** A holding valued into the base currency, or the reason it could not be. */
export interface HoldingValuation {
  key: string;
  instrumentId: number | null;
  /** Signed, base currency. `null` when the holding carries no price or no FX rate. */
  marketValue: number | null;
  /** Why `marketValue` is null; `null` when it is not. */
  reason: 'PRICE_MISSING' | 'FX_MISSING' | null;
}

/** What {@link valueHoldings} reports about a whole book. */
export interface BookValuation {
  rows: HoldingValuation[];
  /** Σ marketValue over priced rows, cash included, signed. */
  netMv: number;
  /**
   * Σ |marketValue| over **every** priced row, cash included (FUNCTIONS_TIER2 §PORT step 5), and
   * therefore the denominator of every weight: `PORT_WEIGHT = PORT_MV / totals.grossMv`.
   *
   * Cash has to be in it. Dividing a cash line by a denominator that excludes it gives that one
   * row a weight measured against a different book from every other row, and the column then foots
   * to more than 100 % — a five-line book with 6 % cash reported 105.9 % before this was one base.
   */
  grossMv: number;
  /**
   * Σ |marketValue| over priced **non-cash** rows: gross market exposure, which is what
   * `core/analytics/portfolio/exposure` reports as `grossExposure` (cash is a position for NAV and
   * carries no market exposure by convention). Not a weight denominator — `grossMv` is.
   */
  grossSecuritiesMv: number;
  /** Σ marketValue over priced non-cash rows with a positive value; cash is in `cash`. */
  longMv: number;
  /** ≤ 0. */
  shortMv: number;
  cash: number;
  /**
   * Gross market value that could be stated, as a fraction of the gross the book would have. Cash
   * is stated at par, so it counts as priced on both sides of the ratio rather than dragging it
   * down.
   */
  pricedWeight: number;
  /** Keys that could not be valued, in input order. */
  unpricedKeys: string[];
}

/**
 * Value a book in its base currency without guessing.
 *
 * A cash line is `quantity × fxRate`; anything else is `quantity × price × multiplier × fxRate`.
 * A missing price or FX rate yields `marketValue: null` and a reason — the row is then excluded
 * from every total, and `pricedWeight` says how much of the book that leaves standing, which is
 * the number a screen shows before anybody trusts a weight column.
 *
 * `pricedWeight` is measured against the gross the book *would* have had: an unpriced line is
 * carried into the denominator at its **cost** when it has one, so a portfolio whose biggest
 * position lost its price does not report `priced 100 %` merely because the rest of it is intact.
 * A line with neither a price nor a cost has no size anybody can state, so it cannot enter the
 * denominator either — it appears in `unpricedKeys`, and that is the only honest signal left.
 */
export function valueHoldings(
  holdings: readonly ValuedHolding[],
  baseCurrency: string,
): BookValuation {
  const rows: HoldingValuation[] = [];
  const unpricedKeys: string[] = [];
  let netMv = 0;
  let grossMv = 0;
  let grossSecuritiesMv = 0;
  let longMv = 0;
  let shortMv = 0;
  let cash = 0;
  let unpricedGross = 0;

  for (const h of holdings) {
    const fx = h.currency === baseCurrency ? 1 : h.fxRate;
    let marketValue: number | null = null;
    let reason: HoldingValuation['reason'] = null;
    if (fx === null) {
      reason = 'FX_MISSING';
    } else if (h.isCash) {
      marketValue = h.quantity * fx;
    } else if (h.price === null) {
      reason = 'PRICE_MISSING';
    } else {
      marketValue = h.quantity * h.price * (h.multiplier ?? 1) * fx;
    }

    if (marketValue === null) {
      unpricedKeys.push(h.key);
      // The line still has a size even when it has no price — its cost. Counting it in the
      // denominator is what makes `pricedWeight` a warning rather than a flatterer.
      const size = h.price ?? h.costPrice ?? null;
      if (size !== null) {
        unpricedGross += Math.abs(h.quantity * size * (h.multiplier ?? 1) * (fx ?? 1));
      }
    } else {
      netMv += marketValue;
      // Every priced row contributes to the gross base the weight column divides by, cash
      // included; only the *exposure* figure the engines take excludes it.
      grossMv += Math.abs(marketValue);
      if (h.isCash) {
        cash += marketValue;
      } else {
        grossSecuritiesMv += Math.abs(marketValue);
        if (marketValue >= 0) longMv += marketValue;
        else shortMv += marketValue;
      }
    }
    rows.push({ key: h.key, instrumentId: h.instrumentId, marketValue, reason });
  }

  const denominator = grossMv + unpricedGross;
  return {
    rows,
    netMv,
    grossMv,
    grossSecuritiesMv,
    longMv,
    shortMv,
    cash,
    pricedWeight: denominator === 0 ? 0 : grossMv / denominator,
    unpricedKeys,
  };
}

/** An engine result plus the `{name, version, inputsHash}` `ctx.engines.add` wants (ANAL-08). */
export interface EngineOutcome<T> {
  outputs: T;
  engine: { name: string; version: string; inputsHash: string };
}

/**
 * PORT exposure view: `core/analytics/portfolio/exposure@1.0.0` over the valued book.
 *
 * Unpriced rows are dropped rather than zeroed — the engine would otherwise weight a name nobody
 * could price at exactly 0 %, which reads as "held, worth nothing" instead of "held, unknown".
 * `BookValuation.unpricedKeys` is what the caller turns into the `unavailable` entries.
 */
export function exposureOf(
  holdings: readonly ValuedHolding[],
  opts: { baseCurrency: string; valuationTs: string },
): EngineOutcome<ExposureResult> & { valuation: BookValuation } {
  const valuation = valueHoldings(holdings, opts.baseCurrency);
  const byKey = new Map(valuation.rows.map((r) => [r.key, r]));
  const positions: ExposurePosition[] = holdings.flatMap((h) => {
    const mv = byKey.get(h.key)?.marketValue ?? null;
    if (mv === null) return [];
    return [
      {
        instrumentId: h.key,
        assetClass: h.isCash ? 'cash' : h.assetClass,
        sector: h.sector,
        currency: h.currency,
        marketValue: mv,
      },
    ];
  });
  const result = exposureEngine(
    { positions, conventions: { baseCurrency: opts.baseCurrency } },
    opts.valuationTs,
  );
  return { outputs: result.outputs, engine: engineMeta(result), valuation };
}

/** The two sides of a Brinson–Fachler run, each already carrying its segment key. */
export interface AttributionInput {
  portfolio: readonly AttributionHolding[];
  benchmark: readonly AttributionHolding[];
  valuationTs: string;
}

/**
 * PORT attribution view (PORT-03): `core/analytics/portfolio/attribution@1.0.0`.
 *
 * The engine's identity holds — `allocation + selection + interaction === activeReturn`, with
 * `residual` reporting the floating-point difference — and this wrapper adds nothing to it beyond
 * rolling the two holding lists into segments. That identity is the acceptance assertion
 * (`test/integration/portfolio/analytics.test.ts`), which is why nothing here recomputes it.
 */
export function attributionOf(input: AttributionInput): EngineOutcome<AttributionResult> {
  const segments = segmentsFromHoldings(input.portfolio, input.benchmark);
  const result = attributionEngine({ segments }, input.valuationTs);
  return { outputs: result.outputs, engine: engineMeta(result) };
}

/** What the risk view asks of `core/analytics/portfolio/risk@1.0.0` (PORT-04, PORT-05, PORT-06). */
export interface RiskInput {
  /** The portfolio's daily return series, decimal fractions, oldest first. */
  returns: readonly number[];
  /** The benchmark's aligned series; omit for a portfolio with no benchmark. */
  benchmark?: readonly number[] | undefined;
  /** Base-currency portfolio value, so a VaR fraction becomes an amount. */
  portfolioValue: number;
  holdings?: readonly RiskHolding[] | undefined;
  scenarios?: readonly (Scenario | string)[] | undefined;
  /** Rolling VaR backtest window in sessions; omit to skip the backtest. */
  backtestWindow?: number | undefined;
  varConfidence: 0.95 | 0.99;
  valuationTs: string;
}

/**
 * PORT risk view: volatility, tracking error, one-day VaR (historical and parametric), the
 * exception backtest and the scenario grid, in one engine call.
 *
 * Monte-Carlo VaR and factor exposures are absent by design (`VAR_MC_NOT_IN_V1`,
 * `NO_FACTOR_MODEL`); the engine returns `monteCarloVarReturn: null` and this wrapper substitutes
 * nothing for it.
 */
export function riskOf(input: RiskInput): EngineOutcome<PortfolioRiskSummary> {
  const result = portfolioRiskEngine(
    {
      returns: input.returns,
      ...(input.benchmark === undefined ? {} : { benchmark: input.benchmark }),
      portfolioValue: input.portfolioValue,
      ...(input.holdings === undefined ? {} : { holdings: input.holdings }),
      ...(input.scenarios === undefined ? {} : { scenarios: input.scenarios }),
      ...(input.backtestWindow === undefined ? {} : { backtestWindow: input.backtestWindow }),
      conventions: { varConfidence: input.varConfidence },
    },
    input.valuationTs,
  );
  return { outputs: result.outputs, engine: engineMeta(result) };
}

/** Simple daily returns from a close series (ANAL-07 `returns: 'simple'`, `priceBasis: 'close'`). */
export function simpleReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev === undefined || cur === undefined || prev === 0) continue;
    out.push(cur / prev - 1);
  }
  return out;
}

/**
 * A return series that knows which session each observation belongs to, oldest first.
 * `dates[i]` is the session `returns[i]` was earned on; the two arrays are the same length.
 */
export interface DatedReturns {
  dates: readonly string[];
  returns: readonly number[];
}

/** The empty series, for a holding with no usable history. */
export const NO_RETURNS: DatedReturns = { dates: [], returns: [] };

/**
 * Simple daily returns carrying the session each one was earned on (ANAL-07 `returns: 'simple'`,
 * `priceBasis: 'close'`). `dates[i]` labels `closes[i]`, so the return from `closes[i-1]` to
 * `closes[i]` is dated `dates[i]` — the session it was realised in.
 *
 * A pair the arithmetic cannot use (a missing close, a zero previous close) drops the *date* with
 * the return, which is what keeps the two arrays in step; {@link simpleReturns} alone cannot, and
 * that is why the callers that align by date use this instead.
 */
export function datedSimpleReturns(
  dates: readonly string[],
  closes: readonly number[],
): DatedReturns {
  const outDates: string[] = [];
  const outReturns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    const date = dates[i];
    if (prev === undefined || cur === undefined || prev === 0 || date === undefined) continue;
    const r = cur / prev - 1;
    if (!Number.isFinite(r)) continue;
    outDates.push(date);
    outReturns.push(r);
  }
  return { dates: outDates, returns: outReturns };
}

/**
 * The daily return series of a book held at fixed current weights (FUNCTIONS_TIER2 §PORT step 9).
 *
 * `weights` are the holdings' weights and `series` their dated return series. One observation is
 * emitted per session **every** weighted holding has a finite return for, in date order: a session
 * one holding is missing is dropped rather than filled, because a filled-in return is an invented
 * one, and a book whose newest member has 40 sessions of history has 40 sessions of history.
 *
 * The alignment is by *date*, never by index. Indexing every series from 0 and truncating to the
 * shortest pairs a long-history name's oldest returns with a recently-listed name's newest ones:
 * two positions that exactly offset over their common window came back as
 * `[0.045, 0.090, 0.135]` where the truth is `[0, 0, 0]`, and every figure downstream — vol,
 * tracking error, beta, VaR and its backtest — is then computed on a series that never happened.
 */
export function weightedReturnSeries(
  weights: ReadonlyMap<string, number>,
  series: ReadonlyMap<string, DatedReturns>,
): DatedReturns {
  const keys = [...weights.keys()].filter((k) => (series.get(k)?.returns.length ?? 0) > 0);
  const first = keys[0];
  if (first === undefined) return { dates: [], returns: [] };

  const byKey = new Map<string, Map<string, number>>();
  for (const key of keys) {
    const s = series.get(key) ?? NO_RETURNS;
    const m = new Map<string, number>();
    for (const [i, date] of s.dates.entries()) {
      const r = s.returns[i];
      if (r !== undefined && Number.isFinite(r)) m.set(date, r);
    }
    byKey.set(key, m);
  }

  // The intersection of the date sets, oldest first. ISO dates sort lexicographically.
  const common = [...(byKey.get(first) ?? new Map<string, number>()).keys()]
    .filter((date) => keys.every((key) => byKey.get(key)?.has(date) === true))
    .sort();

  const dates: string[] = [];
  const returns: number[] = [];
  for (const date of common) {
    let acc = 0;
    for (const key of keys) acc += (weights.get(key) ?? 0) * (byKey.get(key)?.get(date) ?? 0);
    dates.push(date);
    returns.push(acc);
  }
  return { dates, returns };
}

/**
 * The observations two dated series share, paired by date and oldest first.
 *
 * Beta, correlation, R² and tracking error are all statistics *of a pair*, so a portfolio session
 * the benchmark does not have (and the reverse — a different exchange calendar is enough) cannot
 * enter them. Equal lengths do not mean equal dates, which is why this intersects rather than
 * slicing the tail of the longer one.
 */
export function alignReturns(
  a: DatedReturns,
  b: DatedReturns,
): { dates: string[]; a: number[]; b: number[] } {
  const bByDate = new Map<string, number>();
  for (const [i, date] of b.dates.entries()) {
    const r = b.returns[i];
    if (r !== undefined && Number.isFinite(r)) bByDate.set(date, r);
  }
  const dates: string[] = [];
  const left: number[] = [];
  const right: number[] = [];
  for (const [i, date] of a.dates.entries()) {
    const ra = a.returns[i];
    const rb = bByDate.get(date);
    if (ra === undefined || !Number.isFinite(ra) || rb === undefined) continue;
    dates.push(date);
    left.push(ra);
    right.push(rb);
  }
  return { dates, a: left, b: right };
}

/** The last `n` observations of a dated series, dates and returns kept in step. */
export function tailReturns(series: DatedReturns, n: number): DatedReturns {
  if (series.returns.length <= n) return { dates: [...series.dates], returns: [...series.returns] };
  return {
    dates: series.dates.slice(series.returns.length - n),
    returns: series.returns.slice(series.returns.length - n),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Re-exports the route and the PORT resolver both want
// ─────────────────────────────────────────────────────────────────────────────────────────────

export { readPositions };
export type {
  AttributionHolding,
  ImportChannel,
  ImportError,
  ImportReconciliation,
  ImportReport,
  Position,
  RiskHolding,
};
