/**
 * `http/routes/portfolios.ts` — the eleven routes of API.md §5.9 L670-696 (PORT-01, PORT-02,
 * PORT-07), WP-10.
 *
 *   GET    /portfolios                          every portfolio of the caller's firm
 *   POST   /portfolios                          create
 *   GET    /portfolios/:id                      owner or firm admin
 *   PUT    /portfolios/:id                      owner or firm admin
 *   DELETE /portfolios/:id                      owner or firm admin
 *   GET    /portfolios/:id/positions            firm, as-of a date
 *   PUT    /portfolios/:id/positions            owner — the API channel, a full replace
 *   POST   /portfolios/:id/import               owner — multipart CSV (PORT-01 reconciliation)
 *   GET    /portfolios/:id/imports              firm — the import history
 *   GET    /portfolios/:id/lots                 firm — open or all tax lots
 *   POST   /portfolios/:id/analytics            firm — the PORT payload, one implementation
 *
 * Four rules hold throughout:
 *
 *  1. **Not yours and not there are the same answer.** Every read and every write goes through
 *     `data/portfolio.ts`, which filters on the caller's `firm_id` in its own `WHERE` beside
 *     migration 0015's RLS policy, and raises one `PortfolioAccessError('not_found')` for a
 *     portfolio of another firm *and* for one that does not exist. This file turns both into
 *     `404 NOT_FOUND` (PORT-07). A `403` would confirm that another desk's portfolio id is real,
 *     which is the leak the requirement exists to prevent.
 *  2. **The analytics route is not a second implementation.** `POST /:id/analytics` runs function
 *     `PORT` through the ordinary function runner, so the JSON a screen renders and the JSON this
 *     route returns are the same payload from the same resolver under the same entitlements
 *     (API.md L695, "the same resolver as function `PORT` (single implementation)"). Nothing about
 *     portfolio analytics is computed here.
 *  3. **Multipart is parsed here, not globally.** The terminal has exactly one file upload, and it
 *     is this one. Registering a body parser for `multipart/form-data` inside this plugin — where
 *     Fastify's encapsulation confines it — keeps every other route on the 2 MB JSON limit and
 *     means no request to `/functions/:code/run` can ever be handed to a multipart decoder. The
 *     parser is a strict RFC 7578 reader over a buffered body, capped at
 *     {@link MAX_UPLOAD_BYTES}: a CSV of positions is kilobytes, and an upload route with no
 *     ceiling is a denial-of-service route.
 *  4. **An import always answers with a report.** A file with a bad row is not a `400`: it is a
 *     `200` carrying `status: 'partial'`, the row that failed and the reconciliation of what did
 *     land (PORT-01). Only a file that cannot be read *at all* — no header, no `identifier`
 *     column — is a `400`, because there is no report to give.
 */

import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import type {
  ImportListResponse,
  ImportReport as WireImportReport,
  Lot as WireLot,
  LotListResponse,
  Portfolio as WirePortfolio,
  PortfolioListResponse,
  Position as WirePosition,
  PositionListResponse,
} from '@terminal/sdk/wire/rest/portfolios';
import {
  CreatePortfolioRequest,
  ImportListQuery,
  ImportPositionsRequest,
  LotListQuery,
  PortfolioAnalyticsRequest,
  PortfolioParams,
  PositionListQuery,
  ReplacePositionsRequest,
} from '@terminal/sdk/wire/rest/portfolios';
import type { InstrumentSummary } from '@terminal/sdk/wire/common';
import type { Meta } from '@terminal/sdk/wire/envelope';

import {
  PortfolioAccessError,
  getPortfolio,
  listPortfolios,
  readImports,
  readLots,
  readPositions,
  type ImportReport,
  type Lot,
  type Portfolio,
  type PortfolioScope,
  type Position,
} from '../../data/portfolio.js';
import { toInstrumentSummary, withAttribution } from '../../data/request.js';
import { ProvenanceIndex } from '../../data/reference.js';
import type { AsOf } from '../../db/bitemporal.js';
import { withTx, type Tx } from '../../db/client.js';
import {
  ImportFormatError,
  importPositions,
  parseImportCsv,
  replacePositions,
} from '../../portfolio/service.js';
import { SecurityResolver } from '../../refdata/resolve.js';
import { requireSession, type Principal } from '../auth/session.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationFailedError,
} from '../errors.js';
import { rateLimit, REST_LIMIT } from '../rateLimit.js';
import { asOfOfRequest } from './data.js';
import { ctxOf, hostDepsOf, licencesFor, parse, principalOf, runnerFor } from './functions.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The scope every reader and writer in `data/portfolio.ts` and `portfolio/service.ts` takes. */
function scopeOf(principal: Principal): PortfolioScope {
  return { firmId: principal.firmId, userId: principal.userId };
}

/** A path id, as a positive integer, or the documented `400 VALIDATION_FAILED`. */
function idParam(raw: unknown): number {
  const source = (raw ?? {}) as Record<string, unknown>;
  const value = source.portfolioId;
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationFailedError('params', [
      {
        code: 'invalid_type',
        path: ['portfolioId'],
        message: 'portfolioId must be a positive integer',
      },
    ]);
  }
  return PortfolioParams.parse({ portfolioId: n }).portfolioId;
}

/**
 * `PortfolioAccessError` → the HTTP answer. `not_found` is a `404` whether the portfolio belongs
 * to another firm or to nobody; `no_imports` is not an access failure and is handled at the one
 * call site that can provoke it.
 */
function asHttpError(err: unknown): never {
  if (err instanceof PortfolioAccessError && err.code === 'not_found') {
    throw new NotFoundError('No such portfolio.');
  }
  throw err;
}

/** Postgres' unique-violation SQLSTATE — `portfolios (firm_id, name)`. */
function isUniqueViolation(err: unknown): boolean {
  return uniqueViolation(err) !== null;
}

/** The unique violation inside `err`, unwrapped from whatever the driver wrapped it in. */
function uniqueViolation(err: unknown): { table?: unknown; constraint?: unknown } | null {
  for (let cursor: unknown = err, depth = 0; cursor !== undefined && depth < 5; depth += 1) {
    if (typeof cursor !== 'object' || cursor === null) return null;
    const node: { code?: unknown; table?: unknown; constraint?: unknown } = cursor;
    if (node.code === '23505') return node;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Run an import and let a *position* unique violation answer 409 rather than 500.
 *
 * `portfolio/service.ts#importPositions` takes `FOR UPDATE` on the portfolio before it reads the
 * baseline, so two uploads of the same `(portfolio, as-of)` now queue instead of racing and
 * `positions_portfolio_id_as_of_date_raw_identifier_lot_id_key` is unreachable by that route. This
 * is the belt beside those braces: a desk that double-clicks Upload must never be answered with an
 * opaque `500 INTERNAL` for what is an ordinary retry, because API.md §5.9's contract is that an
 * import answers with a report or with a conflict it can explain.
 *
 * The code is `DUPLICATE_NAME` because that is the 409 the wire vocabulary has
 * (`sdk/wire/envelope.ts`); introducing an `IMPORT_IN_PROGRESS` code is an API.md change this work
 * package does not own, so the meaning travels in the message the panel footer shows verbatim.
 */
async function importOrConflict<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const violation = uniqueViolation(err);
    const table = typeof violation?.table === 'string' ? violation.table : '';
    if (table === 'positions' || table === 'lots') {
      throw new ConflictError(
        'DUPLICATE_NAME',
        'Another import of this portfolio and as-of date is still being written. Nothing was ' +
          'changed by this attempt; retry it.',
        { reason: 'IMPORT_IN_PROGRESS', table },
      );
    }
    throw err;
  }
}

/**
 * The write gate of API.md §5.9: the owner, or an admin of the portfolio's own firm.
 *
 * The firm test is already carried by `getPortfolio` (it cannot return another firm's row), so
 * what is left here is the owner-or-admin half. A non-owner, non-admin colleague gets `404` and
 * not `403`, for the same reason the tenant check does: the answer must not distinguish "yours
 * but you may not" from "not yours".
 */
function requireWritable(portfolio: Portfolio, principal: Principal): Portfolio {
  if (portfolio.ownerUserId === principal.userId) return portfolio;
  if (principal.role === 'admin' && portfolio.firmId === principal.firmId) return portfolio;
  throw new NotFoundError('No such portfolio.');
}

/** The instrument summary shape the wire declares, from `data/portfolio.ts`'s narrower one. */
async function summariesFor(
  tx: Tx,
  at: AsOf,
  instrumentIds: readonly number[],
): Promise<Map<number, InstrumentSummary>> {
  const out = new Map<number, InstrumentSummary>();
  const unique = [...new Set(instrumentIds)];
  if (unique.length === 0) return out;
  const resolver = new SecurityResolver(tx);
  const results = await resolver.resolveMany(
    unique.map((id) => ({ id })),
    at,
  );
  for (const result of results) {
    if (!result.ok) continue;
    out.set(result.instrument.instrumentId, toInstrumentSummary(result.instrument));
  }
  return out;
}

function toWirePortfolio(portfolio: Portfolio, benchmark: InstrumentSummary | null): WirePortfolio {
  return {
    portfolioId: portfolio.portfolioId,
    name: portfolio.name,
    baseCurrency: portfolio.baseCurrency,
    benchmark,
  };
}

function toWireReport(report: ImportReport): WireImportReport {
  return {
    importId: report.importId,
    channel: report.channel,
    asOfDate: report.asOfDate,
    status: report.status,
    rowsTotal: report.rowsTotal,
    rowsOk: report.rowsOk,
    rowsError: report.rowsError,
    errors: report.errors,
    reconciliation: report.reconciliation,
  };
}

function toWirePosition(position: Position, instrument: InstrumentSummary | null): WirePosition {
  return {
    positionId: position.positionId,
    asOfDate: position.asOfDate,
    instrument,
    identifier: position.identifier,
    quantity: position.quantity,
    ...(position.costPrice === null ? {} : { costPrice: position.costPrice }),
    ...(position.costCurrency === null ? {} : { costCurrency: position.costCurrency }),
    lotId: position.lotId,
    ...(position.tradeDate === null ? {} : { tradeDate: position.tradeDate }),
    ...(position.settleDate === null ? {} : { settleDate: position.settleDate }),
    isCash: position.isCash,
    ...(position.cashCurrency === null ? {} : { cashCurrency: position.cashCurrency }),
    accrued: position.accrued,
    reconStatus: position.reconStatus,
    importId: position.importId,
  };
}

function toWireLot(lot: Lot, instrument: InstrumentSummary | null): WireLot {
  return {
    lotId: String(lot.lotId),
    instrument,
    openDate: lot.openDate,
    quantity: lot.quantity,
    unitCost: lot.unitCost,
    currency: lot.currency,
    closedDate: lot.closedDate,
    externalRef: lot.externalRef,
  };
}

/**
 * `meta` for the positions read.
 *
 * Positions are `internal.user` data, so the only provenance a read can cite is the import that
 * asserted them; `entitlement`, `unavailable` and `engines` are empty because no field was gated,
 * nothing was missing (a missing portfolio is a `404`) and no engine ran. Analytics — and their
 * engines — come from `POST /:id/analytics`, which is the `PORT` payload with its own meta.
 */
async function positionsMeta(
  tx: Tx,
  at: AsOf,
  positions: readonly Position[],
  request: FastifyRequest,
): Promise<Meta> {
  const prov = new ProvenanceIndex();
  const seen = new Set<number>();
  for (const position of positions) {
    if (position.provenanceId === null || seen.has(position.provenanceId)) continue;
    seen.add(position.provenanceId);
    prov.add({
      sourceId: 'internal.user',
      provenanceId: position.provenanceId,
      capturedAt: at.validAt,
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });
  }
  return {
    traceId: request.traceId,
    asOf: { validAt: at.validAt.toISOString(), knownAt: at.knownAt.toISOString() },
    tier: prov.lowestTier(),
    staleness: prov.worstState(),
    provenance: await withAttribution(tx, at, prov.list()),
    entitlement: [],
    unavailable: [],
    engines: [],
    servedAt: new Date(hostDepsOf(request).clock.now()).toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// multipart/form-data (RFC 7578) — one upload route, one parser, confined to this plugin
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A positions CSV is kilobytes; 8 MB is four orders of magnitude of headroom and still bounded. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** One decoded part of a multipart body. */
interface MultipartPart {
  name: string;
  filename: string | null;
  contentType: string | null;
  body: Buffer;
}

/** The parsed body this plugin's content-type parser hands to the import handler. */
interface MultipartBody {
  fields: Record<string, string>;
  files: MultipartPart[];
}

function boundaryOf(contentType: string): string {
  // `multipart/form-data; boundary=----abc` or `boundary="----abc"`.
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (boundary === undefined || boundary === '') {
    throw new BadRequestError('the multipart body declares no boundary');
  }
  return boundary;
}

/** `Content-Disposition: form-data; name="file"; filename="positions.csv"`. */
function dispositionOf(headers: string): { name: string; filename: string | null } {
  const line = headers
    .split('\r\n')
    .find((h) => h.toLowerCase().startsWith('content-disposition:'));
  if (line === undefined) {
    throw new BadRequestError('a multipart part carries no Content-Disposition header');
  }
  const name = /;\s*name=(?:"([^"]*)"|([^;\s]+))/i.exec(line);
  const filename = /;\s*filename=(?:"([^"]*)"|([^;\s]+))/i.exec(line);
  const partName = name?.[1] ?? name?.[2];
  if (partName === undefined) {
    throw new BadRequestError('a multipart part carries no name');
  }
  return { name: partName, filename: filename?.[1] ?? filename?.[2] ?? null };
}

function headerValue(headers: string, key: string): string | null {
  const prefix = `${key.toLowerCase()}:`;
  const line = headers.split('\r\n').find((h) => h.toLowerCase().startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

/**
 * Decode an RFC 7578 body.
 *
 * Deliberately strict and deliberately small: parts are split on the declared boundary, each
 * part's headers end at the first CRLFCRLF, and anything that does not fit that shape is a
 * `400`. No transfer encodings, no nested multiparts, no streaming — this endpoint accepts one
 * CSV and two form fields, and a parser that accepted more would be a parser nobody audited.
 */
export function parseMultipart(body: Buffer, contentType: string): MultipartBody {
  const boundary = boundaryOf(contentType);
  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  const fields: Record<string, string> = {};
  const files: MultipartPart[] = [];

  let cursor = body.indexOf(delimiter);
  if (cursor < 0) throw new BadRequestError('the multipart body contains no boundary delimiter');

  while (cursor >= 0) {
    const afterDelimiter = cursor + delimiter.length;
    if (body.subarray(afterDelimiter, afterDelimiter + 2).toString('utf8') === '--') break; // closing
    const partStart = afterDelimiter + 2; // skip the CRLF after the delimiter
    const next = body.indexOf(delimiter, partStart);
    if (next < 0) throw new BadRequestError('the multipart body is truncated');
    // The CRLF immediately before the next delimiter belongs to the delimiter, not the content.
    const partEnd = next - 2;
    const headerEnd = body.indexOf('\r\n\r\n', partStart);
    if (headerEnd < 0 || headerEnd > partEnd) {
      throw new BadRequestError('a multipart part has no header block');
    }
    const headers = body.subarray(partStart, headerEnd).toString('utf8');
    const content = body.subarray(headerEnd + 4, Math.max(headerEnd + 4, partEnd));
    const { name, filename } = dispositionOf(headers);
    if (filename === null) {
      fields[name] = content.toString('utf8');
    } else {
      files.push({
        name,
        filename,
        contentType: headerValue(headers, 'content-type'),
        body: content,
      });
    }
    cursor = next;
  }

  return { fields, files };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const portfoliosRoutes: FastifyPluginAsync = async (app) => {
  // API.md §5.9's Role column is "any"/"owner"/"firm": ownership decides what a request may touch,
  // not a bearer scope. The analytics route additionally requires `fn:run`, because it *is* a
  // function run and is metered as one (FUNC-04).
  const read = { preHandler: [requireSession(), rateLimit(REST_LIMIT)] };
  const write = { preHandler: [requireSession(), rateLimit(REST_LIMIT)] };
  const runGuard = { preHandler: [requireSession({ scopes: ['fn:run'] }), rateLimit(REST_LIMIT)] };

  // Encapsulated in this plugin: no other route group can be handed a multipart body.
  app.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (request, body, done) => {
      try {
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
        done(null, parseMultipart(buffer, request.headers['content-type'] ?? ''));
      } catch (err) {
        done(err instanceof Error ? err : new BadRequestError('the multipart body is unreadable'));
      }
    },
  );

  const asOfOf = (request: FastifyRequest): AsOf =>
    asOfOfRequest(
      request.query as { validAt?: string; knownAt?: string } | undefined,
      app.deps.clock,
    );

  /** Every handler's frame: one transaction with the caller's RLS context, one `asOf`. */
  const inTx = async <T>(
    request: FastifyRequest,
    fn: (ctx: { tx: Tx; at: AsOf; principal: Principal; scope: PortfolioScope }) => Promise<T>,
  ): Promise<T> => {
    const principal = principalOf(request);
    const at = asOfOf(request);
    try {
      return await withTx(ctxOf(principal), (tx) =>
        fn({ tx, at, principal, scope: scopeOf(principal) }),
      );
    } catch (err) {
      return asHttpError(err);
    }
  };

  // ── GET /portfolios ────────────────────────────────────────────────────────────────────────
  app.get('/portfolios', read, async (request): Promise<PortfolioListResponse> =>
    inTx(request, async ({ tx, at, scope }) => {
      const portfolios = await listPortfolios(tx, at, scope);
      const summaries = await summariesFor(
        tx,
        at,
        portfolios.flatMap((p) =>
          p.benchmarkInstrumentId === null ? [] : [p.benchmarkInstrumentId],
        ),
      );
      return {
        items: portfolios.map((p) =>
          toWirePortfolio(
            p,
            p.benchmarkInstrumentId === null
              ? null
              : (summaries.get(p.benchmarkInstrumentId) ?? null),
          ),
        ),
      };
    }),
  );

  // ── POST /portfolios ───────────────────────────────────────────────────────────────────────
  app.post('/portfolios', write, async (request, reply): Promise<WirePortfolio> => {
    const body = parse(CreatePortfolioRequest, request.body ?? {}, 'body');
    const created = await inTx(request, async ({ tx, at, principal, scope }) => {
      const benchmark = await resolveBenchmark(tx, at, body.benchmark);
      let portfolioId: number;
      try {
        const res = await tx.execute<{ portfolio_id: string }>(sql`
          INSERT INTO portfolios (firm_id, owner_user_id, name, base_currency,
                                  benchmark_instrument_id)
          VALUES (${String(scope.firmId)}::bigint, ${String(principal.userId)}::bigint,
                  ${body.name}, ${(body.baseCurrency ?? 'USD').toUpperCase()},
                  ${benchmark === null ? null : String(benchmark.instrumentId)}::bigint)
          RETURNING portfolio_id::text AS portfolio_id`);
        const row = res.rows[0];
        if (row === undefined) throw new NotFoundError('The portfolio was not written.');
        portfolioId = Number(row.portfolio_id);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError('DUPLICATE_NAME', `A portfolio named "${body.name}" exists.`);
        }
        throw err;
      }
      const portfolio = await getPortfolio(tx, at, scope, portfolioId);
      return toWirePortfolio(portfolio, benchmark);
    });
    void reply.status(201);
    return created;
  });

  // ── GET /portfolios/:portfolioId ───────────────────────────────────────────────────────────
  app.get('/portfolios/:portfolioId', read, async (request): Promise<WirePortfolio> => {
    const portfolioId = idParam(request.params);
    return inTx(request, async ({ tx, at, principal, scope }) => {
      const portfolio = requireWritable(await getPortfolio(tx, at, scope, portfolioId), principal);
      const summaries = await summariesFor(
        tx,
        at,
        portfolio.benchmarkInstrumentId === null ? [] : [portfolio.benchmarkInstrumentId],
      );
      return toWirePortfolio(
        portfolio,
        portfolio.benchmarkInstrumentId === null
          ? null
          : (summaries.get(portfolio.benchmarkInstrumentId) ?? null),
      );
    });
  });

  // ── PUT /portfolios/:portfolioId ───────────────────────────────────────────────────────────
  app.put('/portfolios/:portfolioId', write, async (request): Promise<WirePortfolio> => {
    const portfolioId = idParam(request.params);
    const body = parse(CreatePortfolioRequest, request.body ?? {}, 'body');
    return inTx(request, async ({ tx, at, principal, scope }) => {
      const existing = requireWritable(await getPortfolio(tx, at, scope, portfolioId), principal);
      const benchmark = await resolveBenchmark(tx, at, body.benchmark);
      try {
        await tx.execute(sql`
          UPDATE portfolios
             SET name = ${body.name},
                 base_currency = ${(body.baseCurrency ?? existing.baseCurrency).toUpperCase()},
                 benchmark_instrument_id = ${
                   benchmark === null ? null : String(benchmark.instrumentId)
                 }::bigint
           WHERE portfolio_id = ${String(portfolioId)}::bigint
             AND firm_id = ${String(scope.firmId)}::bigint`);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError('DUPLICATE_NAME', `A portfolio named "${body.name}" exists.`);
        }
        throw err;
      }
      const updated = await getPortfolio(tx, at, scope, portfolioId);
      return toWirePortfolio(updated, benchmark);
    });
  });

  // ── DELETE /portfolios/:portfolioId ────────────────────────────────────────────────────────
  app.delete('/portfolios/:portfolioId', write, async (request, reply): Promise<void> => {
    const portfolioId = idParam(request.params);
    await inTx(request, async ({ tx, at, principal, scope }) => {
      requireWritable(await getPortfolio(tx, at, scope, portfolioId), principal);
      await tx.execute(sql`
        DELETE FROM portfolios
         WHERE portfolio_id = ${String(portfolioId)}::bigint
           AND firm_id = ${String(scope.firmId)}::bigint`);
      return null;
    });
    void reply.status(204);
  });

  // ── GET /portfolios/:portfolioId/positions ─────────────────────────────────────────────────
  app.get(
    '/portfolios/:portfolioId/positions',
    read,
    async (request): Promise<PositionListResponse> => {
      const portfolioId = idParam(request.params);
      const query = parse(PositionListQuery, request.query ?? {}, 'query');
      return inTx(request, async ({ tx, at, scope }) => {
        const positions = await readPositions(tx, at, scope, portfolioId, query.asOfDate);
        const summaries = await summariesFor(
          tx,
          at,
          positions.flatMap((p) => (p.instrument === null ? [] : [p.instrument.instrumentId])),
        );
        return {
          meta: await positionsMeta(tx, at, positions, request),
          // The stored date the rows actually carry — which is the greatest `as_of_date ≤` the one
          // asked for, not the one asked for. Reporting the request back would claim a snapshot on a
          // date that has none.
          asOfDate:
            positions[0]?.asOfDate ?? query.asOfDate ?? at.validAt.toISOString().slice(0, 10),
          positions: positions.map((p) =>
            toWirePosition(
              p,
              p.instrument === null ? null : (summaries.get(p.instrument.instrumentId) ?? null),
            ),
          ),
        };
      });
    },
  );

  // ── PUT /portfolios/:portfolioId/positions ─────────────────────────────────────────────────
  app.put(
    '/portfolios/:portfolioId/positions',
    write,
    async (request): Promise<WireImportReport> => {
      const portfolioId = idParam(request.params);
      const body = parse(ReplacePositionsRequest, request.body ?? {}, 'body');
      return inTx(request, async ({ tx, at, principal, scope }) => {
        requireWritable(await getPortfolio(tx, at, scope, portfolioId), principal);
        const report = await importOrConflict(() =>
          replacePositions(tx, at, scope, app.deps.clock, {
            portfolioId,
            asOfDate: body.asOfDate,
            positions: body.positions,
          }),
        );
        return toWireReport(report);
      });
    },
  );

  // ── POST /portfolios/:portfolioId/import ───────────────────────────────────────────────────
  app.post('/portfolios/:portfolioId/import', write, async (request): Promise<WireImportReport> => {
    const portfolioId = idParam(request.params);
    const body = request.body;
    if (body === null || typeof body !== 'object' || !('files' in body)) {
      throw new BadRequestError(
        'POST /portfolios/:portfolioId/import takes multipart/form-data with a `file` part ' +
          'and an `asOfDate` field (API.md §5.9)',
      );
    }
    const multipart = body as MultipartBody;
    const file = multipart.files.find((f) => f.name === 'file') ?? multipart.files[0];
    if (file === undefined) {
      throw new BadRequestError('the multipart body carries no `file` part');
    }
    const { asOfDate } = parse(
      ImportPositionsRequest,
      { asOfDate: multipart.fields.asOfDate },
      'body',
    );

    let parsed;
    try {
      parsed = parseImportCsv(file.body.toString('utf8'));
    } catch (err) {
      if (err instanceof ImportFormatError) throw new BadRequestError(err.message);
      throw err;
    }

    return inTx(request, async ({ tx, at, principal, scope }) => {
      requireWritable(await getPortfolio(tx, at, scope, portfolioId), principal);
      const report = await importOrConflict(() =>
        importPositions(tx, at, scope, app.deps.clock, {
          portfolioId,
          asOfDate,
          channel: 'upload',
          filename: file.filename,
          rows: parsed.rows,
          parseErrors: parsed.errors,
          rowsTotal: parsed.rowsTotal,
          payload: file.body.toString('utf8'),
        }),
      );
      return toWireReport(report);
    });
  });

  // ── GET /portfolios/:portfolioId/imports ───────────────────────────────────────────────────
  app.get(
    '/portfolios/:portfolioId/imports',
    read,
    async (request): Promise<ImportListResponse> => {
      const portfolioId = idParam(request.params);
      // A query string carries `limit` as text; the wire schema declares a number, so the one
      // numeric parameter in this group is coerced here rather than loosened there.
      const raw = (request.query ?? {}) as Record<string, unknown>;
      const query = parse(
        ImportListQuery,
        raw.limit === undefined ? {} : { limit: Number(raw.limit) },
        'query',
      );
      return inTx(request, async ({ tx, at, scope }) => {
        const reports = await readImports(tx, at, scope, portfolioId, query.limit);
        return { items: reports.map(toWireReport) };
      });
    },
  );

  // ── GET /portfolios/:portfolioId/lots ──────────────────────────────────────────────────────
  app.get('/portfolios/:portfolioId/lots', read, async (request): Promise<LotListResponse> => {
    const portfolioId = idParam(request.params);
    const raw = (request.query ?? {}) as Record<string, unknown>;
    const query = parse(
      LotListQuery,
      raw.open === undefined ? {} : { open: raw.open === 'true' || raw.open === true },
      'query',
    );
    return inTx(request, async ({ tx, at, scope }) => {
      const lots = await readLots(
        tx,
        at,
        scope,
        portfolioId,
        query.open === undefined ? {} : { open: query.open },
      );
      const summaries = await summariesFor(
        tx,
        at,
        lots.map((l) => l.instrumentId),
      );
      return { items: lots.map((l) => toWireLot(l, summaries.get(l.instrumentId) ?? null)) };
    });
  });

  // ── POST /portfolios/:portfolioId/analytics ────────────────────────────────────────────────
  //
  // API.md L695: "the same resolver as function `PORT` (single implementation)". So this is a
  // function run with `portfolioId` bound from the path — not a second analytics pipeline. It
  // therefore inherits the runner's entitlement checks, its result cache, its `usage_events` row
  // and its `meta`, and a change to the `PORT` resolver reaches this route by construction.
  app.post('/portfolios/:portfolioId/analytics', runGuard, async (request) => {
    const portfolioId = idParam(request.params);
    const body = parse(PortfolioAnalyticsRequest, request.body ?? {}, 'body');
    const principal = principalOf(request);
    const deps = hostDepsOf(request);
    const asOf = asOfOfRequest(body.asOf ?? {}, deps.clock);
    const licences = await licencesFor(deps);

    // Prove the portfolio is visible to this caller before the runner is built: a `404` for
    // another firm's id must not depend on what a resolver happens to do with it (PORT-07).
    await withTx(ctxOf(principal), async (tx) => {
      try {
        await getPortfolio(tx, asOf, scopeOf(principal), portfolioId);
      } catch (err) {
        asHttpError(err);
      }
    });

    return withTx(ctxOf(principal), async (tx) => {
      const runner = runnerFor({
        deps,
        tx,
        asOf,
        principal,
        licences,
        ...(deps.functions?.usageEvents === undefined
          ? {}
          : { usageEvents: deps.functions.usageEvents }),
      });
      return runner.run(
        'PORT',
        {
          // `body.scenarios` is deliberately not forwarded. The wire declares `ScenarioSpec[]` —
          // free-form `{name, shocks[]}` objects, and `wire/rest/portfolios.ts` marks that shape a
          // DESIGN GAP because API.md §5.9 L695 references it without defining it — while
          // `PortParams.scenarios` (FUNCTIONS_TIER2 §PORT) is an enum of nine *named* scenarios
          // that `core/analytics/portfolio/risk.ts` knows how to price. Passing the former where
          // the latter is expected would fail the resolver's own zod parse, and silently mapping
          // one onto the other would invent shocks the caller did not ask for. Until the two are
          // reconciled, `POST /:id/analytics` runs PORT's default scenario set; a caller who wants
          // a different one runs `POST /functions/PORT/run` with `params.scenarios`.
          params: {
            portfolioId,
            ...(body.benchmark === undefined ? {} : { benchmark: body.benchmark }),
          },
          asOf: {
            validAt: asOf.validAt.toISOString(),
            knownAt: asOf.knownAt.toISOString(),
          },
          launchKind: 'launch',
        },
        {
          userId: principal.userId,
          firmId: principal.firmId,
          sessionId: principal.sessionId,
          role: principal.role,
          clientKind: principal.clientKind,
          traceId: request.traceId,
          usage: principal.clientKind === 'api' ? 'api' : 'display',
        },
      );
    });
  });

  // The plugin signature is `FastifyPluginAsync` and registration is synchronous.
  await Promise.resolve();
};

/**
 * Resolve the optional benchmark of a create/update body.
 *
 * A reference that names nothing is the resolver's own error — `SECURITY_NOT_FOUND`, or `409
 * AMBIGUOUS_SECURITY` with the candidates — because "which SPY?" is a question the caller can
 * answer, and a portfolio whose benchmark silently became null is a portfolio whose attribution
 * silently stops working.
 */
async function resolveBenchmark(
  tx: Tx,
  at: AsOf,
  benchmark: { id: number } | { ref: string } | { formula: string } | undefined,
): Promise<InstrumentSummary | null> {
  if (benchmark === undefined) return null;
  if ('formula' in benchmark) {
    throw new ValidationFailedError('body', [
      {
        code: 'custom',
        path: ['benchmark'],
        message: 'a benchmark is a security, not a computed series',
      },
    ]);
  }
  const resolver = new SecurityResolver(tx);
  const outcome = await resolver.resolve(
    'id' in benchmark ? { id: benchmark.id } : benchmark.ref,
    at,
  );
  if (!outcome.ok) {
    const code =
      outcome.code === 'AMBIGUOUS_SECURITY' ? 'AMBIGUOUS_SECURITY' : 'SECURITY_NOT_FOUND';
    throw new AppError(code, outcome.message, {
      details: { candidates: outcome.candidates.map(toInstrumentSummary) },
    });
  }
  return toInstrumentSummary(outcome.instrument);
}
