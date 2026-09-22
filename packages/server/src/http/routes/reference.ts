/**
 * `http/routes/reference.ts` — the eleven resolution and reference reads of API.md §5.1 L399-437
 * (REF-01 … REF-09), WORKPLAN WP-08 L1076.
 *
 * Every route here is a *read of the security master at a pair of instants*. That is the whole
 * shape of the group, and three consequences follow from it:
 *
 *  1. **`validAt` / `knownAt` are first-class, everywhere** (REF-03). Both default to the injected
 *     clock's now, and `meta.asOf` reports the pair that was *used*, not the pair that was asked
 *     for — which is what makes a reference read reproducible: replay the pair the response
 *     reported and the same versions come back. `GET /ref/:id/versions` is the audit view of the
 *     same idea: every version of one key, so "what did we believe on 14 March as of 5 March" is a
 *     question the API can answer rather than a story about the database.
 *  2. **Nothing here computes.** The reads go through WP-04's `data/reference.ts` service and the
 *     `refdata/*` repositories that back it; this module parses, dispatches and serialises. A
 *     value that is not in the master is absent, never invented.
 *  3. **Every cited row is attributed** (DATA-09/DATA-10). The services register each row's
 *     `provenance_id` in one `ProvenanceIndex` per request; the handler turns that into
 *     `meta.provenance` with the attribution joined from `licence_registry`, and each versioned
 *     row points at its entry by index. A reference row with no provenance cannot exist — the
 *     schema requires one — so there is no "unknown source" branch to write.
 *
 * ## Serialisation
 *
 * The master repositories hand back Postgres' own timestamp text and the `'infinity'` sentinel
 * that open bitemporal ranges use. The wire schemas (`sdk/wire/rest/reference.ts`, normative) want
 * ISO-8601. {@link wireInstant} is the one place that conversion happens, and `'infinity'` becomes
 * {@link FOREVER} — the largest instant the format carries — for exactly the reason
 * `http/routes/usage.ts` does the same: an open range has no ISO spelling, it sorts last, and
 * nothing reads it back as a date.
 *
 * ## Entitlements
 *
 * These are master rows — identifiers, listings, terms, corporate actions — not field values, so
 * there is no per-field gate to run: `field_licence` keys on `(field_id, asset_class)` and none of
 * these responses carries a dictionary field. The guard is the session and the `data:read` scope,
 * which is what an API key without it must not get past. Field-level entitlement lives on
 * `POST /data` and the function runner, where the values are.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AssetClass, Clock, FieldId } from '@terminal/core';
import type { Meta, PayloadMeta, ProvenanceRef } from '@terminal/sdk/wire/envelope';
import type {
  IdentifiersResponse,
  TermsResponse,
  VersionsResponse,
} from '@terminal/sdk/wire/rest/reference';
import {
  AsOfQuery,
  ClassificationScheme,
  ResolveGetQuery,
  ResolvePostRequest,
  VersionsTable,
  type CalendarResponse,
  type Classification,
  type ClassificationsResponse,
  type CorporateAction,
  type Identifier,
  type InstrumentDetail as WireInstrumentDetail,
  type IssuerResponse,
  type MembersResponse as WireMembersResponse,
  type Person,
  type ResolveItem as WireResolveItem,
  type ResolveResponse,
  type VersionRow,
} from '@terminal/sdk/wire/rest/reference';
import type { InstrumentSummary, SecurityRefInput } from '@terminal/sdk/wire/common';

import {
  ProvenanceIndex,
  citeProvenance,
  referenceService,
  type ProvenanceCitation,
  type ReferenceService,
} from '../../data/reference.js';
import { toInstrumentSummary, withAttribution } from '../../data/request.js';
import type { AsOf } from '../../db/bitemporal.js';
import { withTx, type RequestCtx, type Tx } from '../../db/client.js';
import {
  classificationCodes,
  entityRelations,
  issuerAliases,
  people,
} from '../../db/schema/calendars.js';
import { actionsAsOf } from '../../refdata/corporateActions.js';
import { CalendarRowError } from '../../refdata/calendars.js';
import { IssueRepository, IssuerRepository, InstrumentRepository } from '../../refdata/master.js';
import { SecurityResolver, type ResolveCandidate } from '../../refdata/resolve.js';
import { DataNotFoundError } from '../../data/reference.js';
import type { Evaluator } from '../../entitlements/evaluator.js';
import { AppError, AuthRequiredError, NotFoundError, ValidationFailedError } from '../errors.js';
import { requireSession, type Principal } from '../auth/session.js';
import { rateLimit, REST_LIMIT } from '../rateLimit.js';
import { hostDepsOf } from './functions.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants and small helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `data/reference.ts`'s calendar shape — `core/calendars/calendar.ts#Calendar`, not re-exported. */
type CalendarView = Awaited<ReturnType<ReferenceService['calendar']>>;

/** The `data:read` scope every read in this group requires (API-01). */
const READ_SCOPES = ['data:read'] as const;

/**
 * `'infinity'` on the wire. An open bitemporal range has no ISO-8601 spelling, so the open end is
 * sent as the largest instant the format carries — the same convention `http/routes/usage.ts`
 * uses for an open-ended grant. Nothing reads it back as a date; it sorts last.
 */
export const FOREVER = '9999-12-31T23:59:59.999Z';

/** `'-infinity'`, for symmetry. No row in the schema opens on this end, but a read must not crash. */
export const FOREVER_AGO = '0001-01-01T00:00:00.000Z';

/**
 * A Postgres timestamp as the wire wants it.
 *
 * `mode: 'string'` columns arrive as Postgres' own text (`2015-01-01 00:00:00+00`) and open ranges
 * as `'infinity'`; `z.iso.datetime()` accepts neither. This is the only place either is converted.
 */
export function wireInstant(value: string): string {
  const trimmed = value.trim();
  if (trimmed === 'infinity') return FOREVER;
  if (trimmed === '-infinity') return FOREVER_AGO;
  const parsed = new Date(trimmed);
  const ms = parsed.getTime();
  if (Number.isNaN(ms)) {
    throw new TypeError(`not a timestamp this route can serialise: ${JSON.stringify(value)}`);
  }
  return parsed.toISOString();
}

/** The five bitemporal columns of any master row, serialised. */
function versionOf(row: {
  versionId: number;
  validFrom: string;
  validTo: string;
  txFrom: string;
  txTo: string;
  provenanceId: number;
}): {
  versionId: number;
  validFrom: string;
  validTo: string;
  txFrom: string;
  txTo: string;
  provenanceId: number;
} {
  return {
    versionId: row.versionId,
    validFrom: wireInstant(row.validFrom),
    validTo: wireInstant(row.validTo),
    txFrom: wireInstant(row.txFrom),
    txTo: wireInstant(row.txTo),
    provenanceId: row.provenanceId,
  };
}

/** A master record on the wire: the record itself with its four instants normalised. */
function serialiseRow<T extends Parameters<typeof versionOf>[0]>(row: T): T {
  return { ...row, ...versionOf(row) };
}

/** The principal the guard decorated, or 401 — a route reached without its guard is a bug. */
function principalOf(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (principal === undefined) throw new AuthRequiredError();
  return principal;
}

function ctxOf(principal: Principal): RequestCtx {
  return {
    userId: principal.userId,
    firmId: principal.firmId,
    role: principal.role,
    sessionId: principal.sessionId,
  };
}

function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  location: 'body' | 'query' | 'params',
): z.infer<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw new ValidationFailedError(location, result.error.issues);
  return result.data;
}

/**
 * The effective `(validAt, knownAt)` pair (REF-03, API.md §4 rule 4).
 *
 * Both default to the injected clock's now — never `Date.now()`, so a `VirtualClock` test reads
 * the instant it froze.
 */
export function asOfFrom(
  query: { validAt?: string | undefined; knownAt?: string | undefined },
  clock: Clock,
): AsOf {
  const now = new Date(clock.now());
  return {
    validAt: query.validAt === undefined ? now : new Date(query.validAt),
    knownAt: query.knownAt === undefined ? now : new Date(query.knownAt),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Per-request context
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RefRequest {
  tx: Tx;
  at: AsOf;
  prov: ProvenanceIndex;
  service: ReferenceService;
  traceId: string;
  clock: Clock;
}

/**
 * Open the request transaction with the caller's RLS context, build one `ProvenanceIndex` and one
 * `ReferenceService` over it, and run `fn`.
 *
 * One index per request, shared by every read the handler makes, is what makes `meta.provenance`
 * a single list with stable indexes that each row can cite.
 */
async function read<T>(request: FastifyRequest, fn: (ctx: RefRequest) => Promise<T>): Promise<T> {
  const principal = principalOf(request);
  const { clock } = request.server.deps;
  const at = asOfFrom(request.query as { validAt?: string; knownAt?: string }, clock);

  return withTx(ctxOf(principal), async (tx) => {
    const prov = new ProvenanceIndex();
    const service = referenceService({ tx, asOf: at, prov });
    return fn({ tx, at, prov, service, traceId: request.traceId, clock });
  });
}

/**
 * `meta` for a reference response: the effective pair, the cited provenance with attribution
 * joined from `licence_registry`, and the tier/staleness the cited rows implied.
 *
 * `entitlement`, `unavailable` and `engines` are empty by construction here: no field was gated,
 * nothing was missing (a missing row is a 404, not a null), and no engine ran.
 */
async function metaOf(ctx: RefRequest): Promise<Meta> {
  const provenance = await withAttribution(ctx.tx, ctx.at, ctx.prov.list());
  return {
    traceId: ctx.traceId,
    asOf: {
      validAt: ctx.at.validAt.toISOString(),
      knownAt: ctx.at.knownAt.toISOString(),
    },
    tier: ctx.prov.lowestTier(),
    staleness: ctx.prov.worstState(),
    provenance,
    entitlement: [],
    unavailable: [],
    engines: [],
    servedAt: new Date(ctx.clock.now()).toISOString(),
  };
}

/** `DataNotFoundError` from a reader → the documented 404, with the as-of pair in the message. */
function notFound(err: unknown, fallback: string): never {
  if (err instanceof DataNotFoundError) {
    throw new NotFoundError(err.message, 'NOT_FOUND', { kind: err.kind, key: err.key });
  }
  if (err instanceof CalendarRowError) throw new NotFoundError(err.message);
  if (err instanceof Error) throw err;
  throw new NotFoundError(fallback);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolve (REF-01, REF-02)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `SecurityRefInput` → what `refdata/resolve.ts` takes. A formula names no master row. */
function resolverInput(ref: SecurityRefInput): string | { id: number } | null {
  if ('id' in ref) return { id: ref.id };
  if ('ref' in ref) return ref.ref;
  return null;
}

async function resolveOne(
  service: ReferenceService,
  ref: SecurityRefInput,
  panelSecurityId: number | undefined,
): Promise<WireResolveItem> {
  const input = resolverInput(ref);
  if (input === null) {
    // CHRT-07 formulas are evaluated by `core/formula` over securities that are themselves
    // resolved; there is no master row called `RATIO(...)` and pretending otherwise would put a
    // fabricated instrument on the wire.
    return {
      ref,
      instrument: null,
      candidates: [],
      error: {
        code: 'SECURITY_NOT_FOUND',
        message: 'a formula is not a security reference; resolve its operands instead',
      },
      source: 'master',
    };
  }

  const item = await service.resolve(
    input,
    panelSecurityId === undefined ? {} : { panelSecurityId },
  );

  return {
    ref,
    instrument: item.instrument === null ? null : toInstrumentSummary(item.instrument),
    candidates: item.candidates.map(toInstrumentSummary),
    ...(item.error === undefined ? {} : { error: item.error }),
    source: 'master',
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Versions (REF-03) — the bitemporal audit view
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How each auditable table is keyed from an instrument id.
 *
 * `issues` and `issuers` are reached through the instrument's own chain rather than by a column on
 * themselves: `/ref/42/versions?table=issuers` means "the versions of the issuer *this instrument*
 * belongs to". The table names come from the normative `VersionsTable` enum, so this map is the
 * only place a table name is written, and an unlisted table cannot reach the SQL.
 */
const VERSION_KEYS = {
  instruments: { table: 'instruments', column: 'instrument_id', key: 'instrument' },
  issues: { table: 'issues', column: 'issue_id', key: 'issue' },
  issuers: { table: 'issuers', column: 'issuer_id', key: 'issuer' },
  listings: { table: 'listings', column: 'instrument_id', key: 'instrument' },
  md_lines: { table: 'md_lines', column: 'instrument_id', key: 'instrument' },
  identifiers: { table: 'identifiers', column: 'entity_id', key: 'instrument' },
  govt_terms: { table: 'govt_terms', column: 'instrument_id', key: 'instrument' },
  option_terms: { table: 'option_terms', column: 'instrument_id', key: 'instrument' },
  future_terms: { table: 'future_terms', column: 'instrument_id', key: 'instrument' },
  index_members: { table: 'index_members', column: 'instrument_id', key: 'instrument' },
  corporate_actions: { table: 'corporate_actions', column: 'instrument_id', key: 'instrument' },
} as const satisfies Record<
  z.infer<typeof VersionsTable>,
  { table: string; column: string; key: 'instrument' | 'issue' | 'issuer' }
>;

/** The bitemporal columns every audited table carries, excluded from the row's `data` blob. */
const VERSION_COLUMNS = ['version_id', 'valid_from', 'valid_to', 'tx_from', 'tx_to'] as const;

interface VersionSqlRow extends Record<string, unknown> {
  version_id: string;
  valid_from: string;
  valid_to: string;
  tx_from: string;
  tx_to: string;
  provenance_id: string;
  data: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────────────────────

const InstrumentIdParam = z.object({ instrumentId: z.coerce.number().int().positive() });
const IssuerIdParam = z.object({ issuerId: z.coerce.number().int().positive() });
const CalendarIdParam = z.object({ calendarId: z.string().min(1).max(32) });
const SchemeParam = z.object({ scheme: ClassificationScheme });

const VersionsQuery = z.object({
  table: VersionsTable.default('instruments'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const CorporateActionsQuery = AsOfQuery.extend({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  status: z
    .preprocess(
      (v: unknown) => (typeof v === 'string' ? v.split(',').filter((s) => s.length > 0) : v),
      z.array(z.enum(['estimated', 'announced', 'confirmed', 'paid', 'cancelled'])),
    )
    .optional(),
});

const CalendarQuery = z.object({ from: z.iso.date(), to: z.iso.date() });

const MembersQuery = AsOfQuery.extend({
  asOfDate: z.iso.date().optional(),
  source: z.enum(['sec.archives', 'ssga.holdings']).optional(),
});

const ClassificationsQuery = z.object({ code: z.string().min(1).max(32).optional() });

/** REF-06: `from`/`to` span at most five years (API.md §5.1). */
const MAX_CALENDAR_YEARS = 5;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entitlement (ENTL-01, ENTL-05) — the master surface is licensed, like every other surface
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The fields the master record is made of.
 *
 * `POST /data {fields:['NAME']}` consults the evaluator and can answer `403 ENTITLEMENT_DENIED`.
 * `GET /ref/:instrumentId` serves the same `NAME` — from the same `instruments` row, under the
 * same licence — so it has to ask the same question. Two routes that disagree about one field mean
 * the answer to "may this user see it" depends on which URL was asked, and the cheaper URL wins.
 */
const MASTER_FIELDS: readonly FieldId[] = ['NAME', 'ID_TICKER'];

/**
 * `identifiers.scheme` → the dictionary field that licenses it.
 *
 * ISIN, CUSIP and SEDOL are externally licensed identifiers with their own `licence_registry`
 * rows; FIGI is open. A scheme with no entry here is not separately licensed and rides on
 * {@link MASTER_FIELDS} — which is still a check, not an exemption.
 */
const IDENTIFIER_FIELD: Partial<Record<Identifier['scheme'], FieldId>> = {
  ISIN: 'ID_ISIN',
  CUSIP: 'ID_CUSIP',
  SEDOL: 'ID_SEDOL',
  FIGI: 'ID_BB_GLOBAL',
  COMPOSITE_FIGI: 'ID_BB_GLOBAL',
  SHARE_CLASS_FIGI: 'ID_BB_GLOBAL',
  LEI: 'ID_LEI',
  CIK: 'ID_CIK',
  TICKER_EXCH: 'ID_EXCH_TICKER',
};

/** The distinct fields the identifier list would disclose. */
const IDENTIFIER_FIELDS: readonly FieldId[] = [...new Set(Object.values(IDENTIFIER_FIELD))];

/** The instrument's asset class, for an entitlement decision that does not need the whole record. */
async function assetClassOf(ctx: RefRequest, instrumentId: number): Promise<AssetClass | null> {
  const row = await new InstrumentRepository(ctx.tx).get(instrumentId, ctx.at);
  return row?.assetClass ?? null;
}

export interface RefGate {
  /** Fields the evaluator refused, by id. */
  denied: ReadonlySet<FieldId>;
  /** `meta.entitlement` — every non-`allow` verdict, ENTL-05. */
  notes: PayloadMeta['entitlement'];
}

/**
 * Evaluate a reference read, and refuse it outright when nothing is servable.
 *
 * Fails **closed**: with no evaluator wired the answer is `403 ENTITLEMENT_DENIED`, exactly as
 * `data/request.ts#gateFields` does. A forgotten dependency must never be the thing that opens a
 * surface — that was the whole shape of this defect, where `/data` denied everything with no port
 * and `/ref/:id` served everything.
 */
async function gateReference(
  request: FastifyRequest,
  instrumentId: number | null,
  assetClass: AssetClass | null,
  fieldIds: readonly FieldId[],
  purpose: string,
): Promise<RefGate> {
  const principal = principalOf(request);
  const evaluator: Evaluator | undefined = hostDepsOf(request).entitlements;
  if (evaluator === undefined) {
    throw new AppError('ENTITLEMENT_DENIED', 'No entitlement evaluator is wired.', {
      details: { reasons: [] },
    });
  }

  const decision = await evaluator.evaluate({
    userId: principal.userId,
    firmId: principal.firmId,
    sessionId: principal.sessionId,
    instrumentId,
    assetClass,
    fieldIds: [...fieldIds],
    tier: 'delayed',
    usage: principal.clientKind === 'api' ? 'api' : 'display',
    purpose,
    traceId: request.traceId,
  });

  const denied = new Set<FieldId>();
  const notes: PayloadMeta['entitlement'] = [];
  for (const field of decision.fields) {
    if (field.decision === 'deny') denied.add(field.fieldId);
    if (field.decision !== 'allow') {
      notes.push({
        fieldId: field.fieldId,
        decision: field.decision,
        effectiveTier: field.effectiveTier,
        reason: field.reason,
      });
    }
  }

  if (decision.fields.length > 0 && denied.size === decision.fields.length) {
    throw new AppError(
      'ENTITLEMENT_DENIED',
      `no reference field is servable for usage '${principal.clientKind === 'api' ? 'api' : 'display'}'`,
      { details: { reasons: notes } },
    );
  }

  return { denied, notes };
}

/** A version row of the `identifiers` table survives only when its scheme is not denied. */
function allowedVersionRow(
  table: string,
  data: Record<string, unknown>,
  gate: RefGate,
): boolean {
  if (table !== 'identifiers') return true;
  const scheme = data.scheme;
  if (typeof scheme !== 'string') return true;
  const field = IDENTIFIER_FIELD[scheme as Identifier['scheme']];
  return field === undefined || !gate.denied.has(field);
}

/** Drop the identifiers whose scheme the evaluator refused (ENTL-05: a denial is never a value). */
function allowedIdentifiers<T extends { scheme: Identifier['scheme'] }>(
  rows: readonly T[],
  gate: RefGate,
): T[] {
  return rows.filter((row) => {
    const field = IDENTIFIER_FIELD[row.scheme];
    return field === undefined || !gate.denied.has(field);
  });
}

export const referenceRoutes: FastifyPluginAsync = async (app) => {
  // `data:read`, plus one REST token per request (20 req/s, burst 60 — API.md §8).
  const guard = {
    preHandler: [requireSession({ scopes: READ_SCOPES }), rateLimit(REST_LIMIT)],
  };

  // ── REF-01 / REF-02 — resolution ─────────────────────────────────────────────────────────

  app.get('/ref/resolve', guard, async (request): Promise<ResolveResponse> => {
    const query = parse(ResolveGetQuery, request.query, 'query');
    return read(request, async (ctx) => {
      const item = await resolveOne(ctx.service, { ref: query.ref }, query.panelSecurityId);
      const meta = await metaOf(ctx);
      return {
        meta: { traceId: meta.traceId, asOf: meta.asOf, servedAt: meta.servedAt },
        results: [item],
      };
    });
  });

  app.post('/ref/resolve', guard, async (request): Promise<ResolveResponse> => {
    const body = parse(ResolvePostRequest, request.body, 'body');
    const principal = principalOf(request);
    const { clock } = request.server.deps;
    const at = asOfFrom(body.asOf ?? {}, clock);

    return withTx(ctxOf(principal), async (tx) => {
      const prov = new ProvenanceIndex();
      const service = referenceService({ tx, asOf: at, prov });
      const results: WireResolveItem[] = [];
      for (const ref of body.refs) {
        results.push(await resolveOne(service, ref, body.panelSecurityId));
      }
      const meta = await metaOf({ tx, at, prov, service, traceId: request.traceId, clock });
      return {
        meta: { traceId: meta.traceId, asOf: meta.asOf, servedAt: meta.servedAt },
        results,
      };
    });
  });

  // ── The master record (REF-04, REF-05) ───────────────────────────────────────────────────

  app.get('/ref/:instrumentId', guard, async (request): Promise<WireInstrumentDetail> => {
    const params = parse(InstrumentIdParam, request.params, 'params');
    parse(AsOfQuery, request.query, 'query');

    return read(request, async (ctx) => {
      const detail = await ctx.service
        .instrument(params.instrumentId)
        .catch((err: unknown) => notFound(err, `no instrument ${params.instrumentId}`));

      if (detail.issue === null || detail.issuer === null) {
        // `InstrumentDetail` declares both as present (API.md L405). An instrument whose issue or
        // issuer has no version at this pair is a broken chain, not a partial answer.
        throw new NotFoundError(
          `instrument ${params.instrumentId} has no ${detail.issue === null ? 'issue' : 'issuer'} ` +
            `version at ${ctx.at.validAt.toISOString()} known at ${ctx.at.knownAt.toISOString()}`,
        );
      }

      // The master record is licensed data. A user with no grant is refused here exactly as they
      // are refused by `POST /data {fields:['NAME']}`, and a partial denial drops the identifier
      // schemes it covers and says so in `meta.entitlement` (ENTL-05).
      const gate = await gateReference(
        request,
        params.instrumentId,
        detail.instrument.assetClass,
        [...MASTER_FIELDS, ...IDENTIFIER_FIELDS],
        'ref.instrument',
      );

      const meta = await metaOf(ctx);
      meta.entitlement = gate.notes;

      return {
        meta,
        instrument: serialiseRow(detail.instrument),
        issue: serialiseRow(detail.issue),
        issuer: serialiseRow(detail.issuer),
        listings: detail.listings.map(serialiseRow),
        mdLines: detail.mdLines.map(serialiseRow),
        terms: termsOnWire(detail.terms, detail.provIdxOf),
        classifications: await classificationsOnWire(ctx.tx, detail.classifications),
        identifiers: allowedIdentifiers(detail.identifiers, gate).map(identifierOnWire),
      } as WireInstrumentDetail;
    });
  });

  app.get(
    '/ref/:instrumentId/identifiers',
    guard,
    async (request): Promise<z.infer<typeof IdentifiersResponse>> => {
      const params = parse(InstrumentIdParam, request.params, 'params');
      parse(AsOfQuery, request.query, 'query');

      return read(request, async (ctx) => {
        const rows = await ctx.service
          .identifiers(params.instrumentId)
          .catch((err: unknown) => notFound(err, `no instrument ${params.instrumentId}`));

        // ISIN, CUSIP and SEDOL are externally licensed. Handing them to any authenticated
        // session — which is what this route did — is the licence breach `POST /data` refuses.
        const gate = await gateReference(
          request,
          params.instrumentId,
          await assetClassOf(ctx, params.instrumentId),
          IDENTIFIER_FIELDS,
          'ref.identifiers',
        );

        const meta = await metaOf(ctx);
        meta.entitlement = gate.notes;
        return { meta, identifiers: allowedIdentifiers(rows, gate).map(identifierOnWire) };
      });
    },
  );

  // ── REF-03 — the bitemporal audit view ───────────────────────────────────────────────────

  app.get(
    '/ref/:instrumentId/versions',
    guard,
    async (request): Promise<z.infer<typeof VersionsResponse>> => {
      const params = parse(InstrumentIdParam, request.params, 'params');
      const query = parse(VersionsQuery, request.query, 'query');
      const spec = VERSION_KEYS[query.table];

      return read(request, async (ctx) => {
        // The audit view re-serves the very rows `GET /ref/:id` and `/identifiers` serve, one
        // version at a time — `?table=identifiers` hands back the same ISIN and CUSIP. Gating the
        // two read routes and leaving this one open would make the gate a detour rather than a
        // rule, so it asks the same question of the same field set.
        const gate = await gateReference(
          request,
          params.instrumentId,
          await assetClassOf(ctx, params.instrumentId),
          [...MASTER_FIELDS, ...IDENTIFIER_FIELDS],
          'ref.versions',
        );

        const key = await versionKey(ctx, params.instrumentId, spec.key);

        // Every version of the key, newest knowledge first — NOT filtered by the as-of pair: that
        // is the point of an audit view. The table and column come from `VERSION_KEYS`, which is
        // keyed by the normative enum, so nothing a caller typed reaches `sql.raw`.
        const dropped = [...VERSION_COLUMNS, 'provenance_id']
          .map((c) => `- ${sqlLiteral(c)}`)
          .join(' ');
        const rows = await ctx.tx.execute<VersionSqlRow>(sql`
        SELECT version_id::text AS version_id,
               valid_from::text AS valid_from, valid_to::text AS valid_to,
               tx_from::text    AS tx_from,    tx_to::text    AS tx_to,
               provenance_id::text AS provenance_id,
               ${sql.raw(`to_jsonb(t) ${dropped}`)} AS data
          FROM ${sql.raw(spec.table)} t
         WHERE ${sql.raw(spec.column)} = ${key}
         ${sql.raw(spec.table === 'identifiers' ? `AND entity_kind = 'instrument'` : '')}
         ORDER BY tx_from DESC, valid_from DESC, version_id DESC
         LIMIT ${query.limit}`);

        const sqlRows = rows.rows;
        const citation = await citeProvenance(
          ctx.tx,
          ctx.prov,
          sqlRows.map((r) => Number(r.provenance_id)),
        );
        const meta = await metaOf(ctx);

        meta.entitlement = gate.notes;

        const versions: VersionRow[] = sqlRows
          // A denied identifier scheme is dropped here too — a version of a value the caller may
          // not see is still that value.
          .filter((row) => allowedVersionRow(query.table, row.data, gate))
          .map((row) => ({
            versionId: Number(row.version_id),
            validFrom: wireInstant(row.valid_from),
            validTo: wireInstant(row.valid_to),
            txFrom: wireInstant(row.tx_from),
            txTo: wireInstant(row.tx_to),
            provenance: citedRef(meta.provenance, citation, Number(row.provenance_id)),
            data: row.data,
          }));

        return { meta, versions };
      });
    },
  );

  // ── DATA-08 — corporate actions ──────────────────────────────────────────────────────────

  app.get('/ref/:instrumentId/corporate-actions', guard, async (request) => {
    const params = parse(InstrumentIdParam, request.params, 'params');
    const query = parse(CorporateActionsQuery, request.query, 'query');

    return read(request, async (ctx) => {
      const rows = await actionsAsOf(
        ctx.tx,
        {
          instrumentId: params.instrumentId,
          ...(query.from === undefined ? {} : { from: query.from }),
          ...(query.to === undefined ? {} : { to: query.to }),
          ...(query.status === undefined ? {} : { statuses: query.status }),
        },
        ctx.at,
      );

      const citation = await citeProvenance(
        ctx.tx,
        ctx.prov,
        rows.map((r) => r.provenanceId),
      );
      const meta = await metaOf(ctx);

      const actions: CorporateAction[] = rows.map((row) => ({
        caId: row.caId,
        instrumentId: row.instrumentId,
        caType: row.caType,
        status: row.status,
        declaredDate: row.declaredDate,
        exDate: row.exDate,
        recordDate: row.recordDate,
        payDate: row.payDate,
        effectiveDate: row.effectiveDate,
        amount: row.amount,
        currency: row.currency,
        ratioNew: row.ratioNew,
        ratioOld: row.ratioOld,
        newInstrumentId: row.newInstrumentId,
        frequency: row.frequency,
        grossOrNet: row.grossOrNet,
        details: row.details,
        sourceId: row.sourceId,
        reviewState: row.reviewState,
        provIdx: citation.provIdxOf[row.provenanceId] ?? 0,
      }));

      return { meta, actions };
    });
  });

  // ── REF-04 / REF-05 — contractual terms ──────────────────────────────────────────────────

  app.get(
    '/ref/:instrumentId/terms',
    guard,
    async (request): Promise<z.infer<typeof TermsResponse>> => {
      const params = parse(InstrumentIdParam, request.params, 'params');
      parse(AsOfQuery, request.query, 'query');

      return read(request, async (ctx) => {
        const detail = await ctx.service
          .instrument(params.instrumentId)
          .catch((err: unknown) => notFound(err, `no instrument ${params.instrumentId}`));

        const gate = await gateReference(
          request,
          params.instrumentId,
          detail.instrument.assetClass,
          MASTER_FIELDS,
          'ref.terms',
        );

        const meta = await metaOf(ctx);
        meta.entitlement = gate.notes;
        return {
          meta,
          terms: termsOnWire(detail.terms, detail.provIdxOf),
        } as z.infer<typeof TermsResponse>;
      });
    },
  );

  // ── REF-08 — the issuer ──────────────────────────────────────────────────────────────────

  app.get('/issuers/:issuerId', guard, async (request): Promise<IssuerResponse> => {
    const params = parse(IssuerIdParam, request.params, 'params');
    parse(AsOfQuery, request.query, 'query');

    return read(request, async (ctx) => {
      const issuer = await new IssuerRepository(ctx.tx).get(params.issuerId, ctx.at);
      if (issuer === null) {
        throw new NotFoundError(
          `no issuer ${params.issuerId} as of ${ctx.at.validAt.toISOString()} known at ` +
            ctx.at.knownAt.toISOString(),
        );
      }

      const issues = await new IssueRepository(ctx.tx).byIssuer(params.issuerId, ctx.at);
      const instrumentRepo = new InstrumentRepository(ctx.tx);
      const instrumentIds: number[] = [];
      for (const issue of issues) {
        const rows = await instrumentRepo.byIssue(issue.issueId, ctx.at);
        for (const row of rows) instrumentIds.push(row.instrumentId);
      }

      const [summaries, personRows, relationRows, aliasRows] = await Promise.all([
        summariesFor(ctx.tx, instrumentIds, ctx.at),
        ctx.tx
          .select()
          .from(people)
          .where(and(eq(people.issuerId, params.issuerId), asOfSql(people, ctx.at)))
          .orderBy(asc(people.personId)),
        ctx.tx
          .select()
          .from(entityRelations)
          .where(
            and(
              sql`(${entityRelations.fromKind} = 'issuer' AND ${entityRelations.fromId} = ${params.issuerId})
                  OR (${entityRelations.toKind} = 'issuer' AND ${entityRelations.toId} = ${params.issuerId})`,
              asOfSql(entityRelations, ctx.at),
            ),
          )
          .orderBy(asc(entityRelations.versionId)),
        ctx.tx
          .select({ alias: issuerAliases.alias })
          .from(issuerAliases)
          .where(eq(issuerAliases.issuerId, params.issuerId))
          .orderBy(asc(issuerAliases.alias)),
      ]);

      await citeProvenance(ctx.tx, ctx.prov, [
        issuer.provenanceId,
        ...personRows.map((r) => r.provenanceId),
        ...relationRows.map((r) => r.provenanceId),
      ]);

      return {
        meta: await metaOf(ctx),
        issuer: serialiseRow(issuer),
        instruments: summaries,
        people: personRows.map((row): Person => ({
          personId: row.personId,
          name: row.name,
          role: row.role ?? '',
          issuerId: row.issuerId,
          userId: row.userId,
          aliases: row.aliases,
          sourceId: row.sourceId,
        })),
        relations: relationRows.map((row) => ({
          fromKind: row.fromKind,
          fromId: row.fromId,
          toKind: row.toKind,
          toId: row.toId,
          relation: row.relation,
          weight: row.weight === null ? null : Number(row.weight),
          sourceId: row.sourceId,
        })),
        aliases: aliasRows.map((row) => row.alias),
      } as IssuerResponse;
    });
  });

  // ── REF-06 — the calendar ────────────────────────────────────────────────────────────────

  app.get('/calendars/:calendarId', guard, async (request): Promise<CalendarResponse> => {
    const params = parse(CalendarIdParam, request.params, 'params');
    const query = parse(CalendarQuery, request.query, 'query');

    const fromYear = Number(query.from.slice(0, 4));
    const toYear = Number(query.to.slice(0, 4));
    if (query.to < query.from) {
      throw new ValidationFailedError('query', [
        { code: 'custom', path: ['to'], message: '`to` is before `from`' },
      ]);
    }
    if (toYear - fromYear > MAX_CALENDAR_YEARS) {
      throw new ValidationFailedError('query', [
        {
          code: 'custom',
          path: ['to'],
          message: `a calendar window spans at most ${MAX_CALENDAR_YEARS} years`,
        },
      ]);
    }

    return read(request, async (ctx) => {
      const calendar: CalendarView = await ctx.service
        .calendar(params.calendarId)
        .catch((err: unknown) => notFound(err, `no calendar ${params.calendarId}`));

      const holidays = calendar
        .holidays(fromYear, toYear)
        .filter((h) => h.day >= query.from && h.day <= query.to)
        .map((h) => ({
          day: h.day,
          name: h.name,
          kind: h.kind === 'early_close' ? ('early_close' as const) : ('holiday' as const),
          ...(h.closeTime === undefined ? {} : { closeTimeLocal: h.closeTime }),
        }));

      // A weekday with no open or close is a non-trading day in the template; the wire declares
      // both as required, so such a row is absent rather than sent with a made-up time.
      const sessions = calendar
        .sessions()
        .filter((s) => s.openTime !== null && s.closeTime !== null)
        .map((s) => ({
          weekday: s.weekday,
          openLocal: s.openTime!,
          closeLocal: s.closeTime!,
          ...(s.preOpen === null ? {} : { preOpenLocal: s.preOpen }),
          ...(s.postClose === null ? {} : { postCloseLocal: s.postClose }),
        }));

      return { calendarId: calendar.id, holidays, sessions, tz: calendar.tz };
    });
  });

  // ── REF-07 / MEMB — index membership ─────────────────────────────────────────────────────

  app.get(
    '/indices/:instrumentId/members',
    guard,
    async (request): Promise<WireMembersResponse> => {
      const params = parse(InstrumentIdParam, request.params, 'params');
      const query = parse(MembersQuery, request.query, 'query');

      return read(request, async (ctx) => {
        const roster = await ctx.service
          .members(params.instrumentId, query.asOfDate)
          .catch((err: unknown) => notFound(err, `no index for instrument ${params.instrumentId}`));

        // `source` narrows the roster to one provider's holdings file (API.md §5.1) — the filter
        // is applied here rather than in the reader, which answers "the membership as of a date".
        const members =
          query.source === undefined
            ? roster.members
            : roster.members.filter((m) => m.sourceId === query.source);

        const summaries = await summariesFor(
          ctx.tx,
          members.map((m) => m.instrumentId),
          ctx.at,
        );
        const byId = new Map(summaries.map((s) => [s.instrumentId, s]));

        return {
          meta: await metaOf(ctx),
          asOfDate: roster.asOfDate,
          members: members.flatMap((member) => {
            const instrument = byId.get(member.instrumentId);
            // A constituent whose instrument row has no version at this pair is already counted
            // in `unresolved` by the reader; it has no summary to send and is not invented.
            if (instrument === undefined) return [];
            return [
              {
                instrument,
                weight: member.weight,
                shares: member.shares,
                marketValue: member.marketValue,
                sourceId: member.sourceId,
              },
            ];
          }),
        };
      });
    },
  );

  // ── Classification taxonomies ────────────────────────────────────────────────────────────

  app.get('/classifications/:scheme', guard, async (request): Promise<ClassificationsResponse> => {
    const params = parse(SchemeParam, request.params, 'params');
    const query = parse(ClassificationsQuery, request.query, 'query');
    const principal = principalOf(request);

    return withTx(ctxOf(principal), async (tx) => {
      // `classification_schemes.scheme` is stored upper-case ('GICS'); the route's enum is the
      // lower-case spelling API.md §5.1 puts in the path.
      const scheme = params.scheme.toUpperCase();
      const where =
        query.code === undefined
          ? eq(classificationCodes.scheme, scheme)
          : and(
              eq(classificationCodes.scheme, scheme),
              sql`(${classificationCodes.code} = ${query.code}
                   OR ${classificationCodes.parentCode} = ${query.code})`,
            );

      const rows = await tx
        .select({
          code: classificationCodes.code,
          name: classificationCodes.name,
          parentCode: classificationCodes.parentCode,
        })
        .from(classificationCodes)
        .where(where)
        .orderBy(asc(classificationCodes.level), asc(classificationCodes.code));

      return { scheme: params.scheme, nodes: rows };
    });
  });

  await Promise.resolve();
};

export default referenceRoutes;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared serialisation helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A single-quoted SQL string literal, for the `to_jsonb(t) - '<col>'` list. */
function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** `bt_as_of(...)` over a table's bitemporal columns. */
function asOfSql(
  table: { validFrom: unknown; validTo: unknown; txFrom: unknown; txTo: unknown },
  at: AsOf,
): ReturnType<typeof sql> {
  const t = table as {
    validFrom: Parameters<typeof sql>[0];
    validTo: unknown;
    txFrom: unknown;
    txTo: unknown;
  };
  return sql`bt_as_of(${t.validFrom}, ${t.validTo}, ${t.txFrom}, ${t.txTo}, ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)`;
}

/** The `meta.provenance` entry a row cites, by its `provenance_id`. */
function citedRef(
  provenance: readonly ProvenanceRef[],
  citation: ProvenanceCitation,
  provenanceId: number,
): ProvenanceRef {
  const idx = citation.provIdxOf[provenanceId];
  const found = idx === undefined ? undefined : provenance[idx];
  if (found === undefined) {
    // `citeProvenance` throws on a row the `provenance` table does not contain, so this is
    // unreachable — and if it ever is reached, a fabricated citation is the wrong answer.
    throw new TypeError(`provenance ${provenanceId} was not cited by this request`);
  }
  return found;
}

/**
 * `EntityClassification` → the wire's `Classification` (API.md §5.1 L405).
 *
 * `parent_code` lives on `classification_codes`, not on the assignment, so the taxonomy rows are
 * joined in one batched read rather than one per assignment. A code with no taxonomy row — an
 * unseeded scheme — keeps the code as its own name: the assignment is real and hiding it would
 * lose a classification the master does hold, while inventing a label for it would be worse.
 */
async function classificationsOnWire(
  tx: Tx,
  rows: readonly {
    scheme: string;
    code: string;
    name: string | null;
    level: number | null;
  }[],
): Promise<Classification[]> {
  if (rows.length === 0) return [];
  const codes = [...new Set(rows.map((r) => r.code))];
  const schemes = [...new Set(rows.map((r) => r.scheme))];
  const taxonomy = await tx
    .select({
      scheme: classificationCodes.scheme,
      code: classificationCodes.code,
      name: classificationCodes.name,
      parentCode: classificationCodes.parentCode,
      level: classificationCodes.level,
    })
    .from(classificationCodes)
    .where(
      and(inArray(classificationCodes.scheme, schemes), inArray(classificationCodes.code, codes)),
    );

  // `|` separates the two halves: neither a scheme nor a code may contain one, and a printable
  // separator keeps this debuggable — the lesson `entitlements/licenceRegistry.ts` learned.
  const key = (scheme: string, code: string): string => `${scheme}|${code}`;
  const byKey = new Map(taxonomy.map((row) => [key(row.scheme, row.code), row]));

  return rows.map((row) => {
    const node = byKey.get(key(row.scheme, row.code));
    return {
      scheme: row.scheme,
      code: row.code,
      name: row.name ?? node?.name ?? row.code,
      parentCode: node?.parentCode ?? null,
      level: row.level ?? node?.level ?? null,
    };
  });
}

/** `IdentifierRecord` → the wire's `Identifier` (API.md §5.1 L417). */
function identifierOnWire(row: {
  scheme: Identifier['scheme'];
  value: string;
  qualifier: string;
  isPrimary: boolean;
  validFrom: string;
  validTo: string;
}): Identifier {
  return {
    scheme: row.scheme,
    value: row.value,
    qualifier: row.qualifier,
    isPrimary: row.isPrimary,
    validFrom: wireInstant(row.validFrom),
    validTo: wireInstant(row.validTo),
  };
}

/**
 * `InstrumentTerms` → the wire's flat `Terms` union.
 *
 * The reader returns `{ kind, instrumentId, terms }`; the wire wants the columns alongside the
 * `kind` tag, with the valid range as ISO instants and a `provIdx` pointing into
 * `meta.provenance`. Everything else the terms row carries rides along under the union's
 * `catchall` rather than being dropped — a terms table is the contract, and a field this build
 * does not name is still one a caller may need.
 */
function termsOnWire(
  terms: { kind: string; instrumentId: number; terms: Record<string, unknown> } | null,
  provIdxOf: Record<number, number>,
): unknown {
  if (terms === null) return null;
  const row = terms.terms;
  const provenanceId = Number(row.provenanceId);
  const out: Record<string, unknown> = {
    ...row,
    kind: terms.kind,
    instrumentId: terms.instrumentId,
  };
  if (typeof row.validFrom === 'string') out.validFrom = wireInstant(row.validFrom);
  if (typeof row.validTo === 'string') out.validTo = wireInstant(row.validTo);
  if (typeof row.txFrom === 'string') out.txFrom = wireInstant(row.txFrom);
  if (typeof row.txTo === 'string') out.txTo = wireInstant(row.txTo);
  const idx = provIdxOf[provenanceId];
  if (idx !== undefined) out.provIdx = idx;
  return out;
}

/**
 * `InstrumentSummary` for a list of instrument ids, as-of.
 *
 * Through `refdata/resolve.ts` rather than a query written here: `display` ('AAPL US Equity',
 * 'SPX Index') is a rule about synthetic exchange codes that the resolver owns, and a second
 * spelling of it in a route is how two screens end up disagreeing about what a security is
 * called. `resolveMany` costs one round trip per id; the lists it is used for here (an issuer's
 * instruments, an index roster) are small, and a batch entry point on the resolver is the right
 * fix when a 500-name index is served hot — see the notes for the integrator.
 */
async function summariesFor(
  tx: Tx,
  instrumentIds: readonly number[],
  at: AsOf,
): Promise<InstrumentSummary[]> {
  const ids = [...new Set(instrumentIds)];
  if (ids.length === 0) return [];
  const resolver = new SecurityResolver(tx);
  const out: InstrumentSummary[] = [];
  for (const id of ids) {
    const candidate: ResolveCandidate | null = await resolver.byInstrumentId(id, at);
    if (candidate !== null) out.push(toInstrumentSummary(candidate));
  }
  return out;
}

/** The key `VERSION_KEYS` says to filter on, walked from the instrument's own chain. */
async function versionKey(
  ctx: RefRequest,
  instrumentId: number,
  key: 'instrument' | 'issue' | 'issuer',
): Promise<number> {
  if (key === 'instrument') return instrumentId;

  const instrument = await new InstrumentRepository(ctx.tx).get(instrumentId, ctx.at);
  if (instrument === null) {
    throw new NotFoundError(
      `no instrument ${instrumentId} as of ${ctx.at.validAt.toISOString()} known at ` +
        ctx.at.knownAt.toISOString(),
    );
  }
  if (key === 'issue') return instrument.issueId;

  const issue = await new IssueRepository(ctx.tx).get(instrument.issueId, ctx.at);
  if (issue === null) {
    throw new NotFoundError(`no issue ${instrument.issueId} at this instant`);
  }
  return issue.issuerId;
}

// Re-exported for tests that serialise the same master rows.
export { serialiseRow as serialiseMasterRow };
