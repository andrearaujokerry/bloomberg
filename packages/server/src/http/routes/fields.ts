/**
 * `http/routes/fields.ts` — the field dictionary (API.md §5.5 L559-566, §7 L1080-1140, API-07),
 * WORKPLAN WP-08 L1075.
 *
 * Three routes over `core/fields/dictionary.ts`, which is the single source of truth for what a
 * field *means*: the same 299 definitions the formatter uses for a screen cell, the CSV header and
 * the SDK's types. This module does not restate any of it — it filters, attaches the governing
 * licence, and derives the changelog from the definitions themselves.
 *
 * ## The deprecation rules (API.md §7 rule 3, API-03)
 *
 * A deprecated field is **still served**. That is the whole rule: an id is deprecated for at least
 * two dictionary minor versions and six months before it is removed, and during that window every
 * caller keeps getting its value. What changes is that the response says so —
 * `x-deprecated-fields: <id>[,<id>…]` on any response that carried one — so an SDK can log one
 * warning per process and a screen can mark the column, without a single row going missing. A
 * deprecated field that vanished from `/fields` would be a silent break dressed up as a warning.
 *
 * `GET /fields/changelog` is the other half: it lists, per dictionary version, what was added and
 * what was deprecated. It is **derived**, not stored — `FieldDef.since` says which version
 * introduced a field and `FieldDef.deprecated.since` which version deprecated it, so the changelog
 * cannot drift from the dictionary it describes. `removed` and `changed` are therefore empty: the
 * dictionary records no removal and no edit history, and a plausible-looking guess at one would be
 * exactly the fabrication this codebase refuses. When a field is genuinely removed, the entry that
 * records it has to be written down somewhere that outlives the definition.
 *
 * ## Caching and the public flag
 *
 * Every response carries an `ETag` over the exact bytes served (the dictionary is a build
 * artefact: `FIELD_DICTIONARY_GENERATED_AT` is fixed, not `now()`, so two processes agree), and a
 * repeat request with `If-None-Match` gets `304`. With `PUBLIC_FIELDS=1` the three routes drop the
 * session guard (API.md L563): the dictionary is documentation — definitions, units and licence
 * terms — and contains no instrument, price, firm or user.
 */

import { createHash } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import {
  FIELD_DICTIONARY_GENERATED_AT,
  FIELD_DICTIONARY_VERSION,
  fieldDefs,
  getField,
  type AssetClass,
  type FieldDef,
  type FieldId,
} from '@terminal/core';
import {
  ChangelogResponse,
  FieldsQuery,
  type ChangelogEntry,
  type FieldDetail,
  type FieldDictionary,
  type LicenceSummary,
} from '@terminal/sdk/wire/rest/fields';
import { z } from 'zod';

import type { AppDeps } from '../../app.js';
import { licenceRegistry as buildLicenceRegistry } from '../../entitlements/licenceRegistry.js';
import type { LicenceRegistry } from '../../entitlements/licenceRegistry.js';
import { licenceRegistry as licenceRegistryTable } from '../../db/schema/provenance.js';
import { AppError, NotFoundError, ValidationFailedError } from '../errors.js';
import { requireSession, type SessionGuard } from '../auth/session.js';
import { rateLimit, REST_LIMIT } from '../rateLimit.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Optional overrides. Absent, the licence registry is built from `app.deps`. */
export interface FieldsRouteDeps {
  licences?: LicenceRegistry;
}

declare module '../../app.js' {
  // Optional additions only — `buildApp`'s contract (app.ts L60-64) allows exactly this.
  interface AppDeps {
    /** Overrides for `http/routes/fields.ts`; the default is built from `app.deps`. */
    fields?: FieldsRouteDeps;
  }
}

/** API.md §7 rule 3 — the header that says an answer contained a deprecated id. */
export const DEPRECATED_HEADER = 'x-deprecated-fields';

/** One registry per `AppDeps`, so its snapshot is loaded once rather than per request. */
const registries = new WeakMap<AppDeps, LicenceRegistry>();

function registryFor(app: FastifyInstance): LicenceRegistry {
  const deps = app.deps;
  const override = deps.fields?.licences;
  if (override !== undefined) return override;
  const held = registries.get(deps);
  if (held !== undefined) return held;
  const built = buildLicenceRegistry({ db: deps.db, clock: deps.clock });
  registries.set(deps, built);
  return built;
}

/**
 * The guard these routes run under. `PUBLIC_FIELDS=1` makes them anonymous (API.md L563); anything
 * else requires a session, of any role.
 */
function guardFor(app: FastifyInstance): SessionGuard | undefined {
  return app.deps.config.PUBLIC_FIELDS === '1' ? undefined : requireSession();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ETag / 304
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `"<sha1 of the body>"` — over the bytes actually served, so a filtered view has its own tag. */
export function etagOf(body: string): string {
  return `"${createHash('sha1').update(body).digest('hex')}"`;
}

/** RFC 9110 §13.1.2 weak comparison, list or `*`. */
function ifNoneMatch(header: string | undefined, etag: string): boolean {
  if (typeof header !== 'string') return false;
  const trimmed = header.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === '*') return true;
  const strip = (t: string): string => (t.startsWith('W/') ? t.slice(2) : t);
  const want = strip(etag);
  return trimmed.split(',').some((raw) => strip(raw.trim()) === want);
}

/**
 * Serialize once, tag it, and either answer `304` or write those exact bytes.
 *
 * The body is stringified here rather than returned as an object because the ETag has to be a hash
 * of what the client receives; hashing an object and letting Fastify serialize it separately is
 * how a tag and a payload drift apart.
 */
function sendJson(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  deprecated: readonly FieldId[],
): unknown {
  const body = JSON.stringify(payload);
  const etag = etagOf(body);
  void reply.header('ETag', etag).header('Cache-Control', 'private, max-age=3600');
  // API.md §7 rule 3 — the field is still in the payload; the header is what says "move on".
  if (deprecated.length > 0) void reply.header(DEPRECATED_HEADER, deprecated.join(','));
  if (ifNoneMatch(request.headers['if-none-match'], etag)) return reply.status(304).send();
  void reply.type('application/json; charset=utf-8');
  return body;
}

/** The deprecated ids among `defs`, in dictionary order. */
export function deprecatedIds(defs: readonly FieldDef[]): FieldId[] {
  return defs.filter((d) => d.deprecated !== undefined).map((d) => d.id);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GET /fields
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `fieldClass`, `assetClass` and the `q` substring of API.md §5.5, applied in that order.
 *
 * `q` matches id or label, case-insensitively — a user typing `last` in the HELP overlay is
 * looking for `PX_LAST` whichever case they used. A field with an empty `assetClasses` is
 * subject-only (`n:`, `c:`, `e:`, `sys:`) and matches no asset-class filter.
 */
export function filterFields(
  defs: readonly FieldDef[],
  query: { fieldClass?: string; assetClass?: AssetClass; q?: string },
): FieldDef[] {
  const needle = query.q?.toLowerCase();
  return defs.filter((def) => {
    if (query.fieldClass !== undefined && def.fieldClass !== query.fieldClass) return false;
    if (query.assetClass !== undefined && !def.assetClasses.includes(query.assetClass)) {
      return false;
    }
    if (needle !== undefined) {
      const hit = def.id.toLowerCase().includes(needle) || def.label.toLowerCase().includes(needle);
      if (!hit) return false;
    }
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GET /fields/changelog
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `'2026.09.1'` → `[2026, 9, 1]`; a segment that is not a number sorts as `-1`. */
function versionParts(version: string): number[] {
  return version.split('.').map((part) => {
    const n = Number(part);
    return Number.isFinite(n) ? n : -1;
  });
}

/** Ascending order over `'YYYY.MM.N'`. Exported because the `since` filter depends on it. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * The release date of a dictionary version.
 *
 * The current version has one recorded: `FIELD_DICTIONARY_GENERATED_AT`, fixed in
 * `core/fields/dictionary.ts` precisely so it is reproducible. Older versions do not — nothing in
 * this repository stores a per-version release date — so their entry is dated from the version
 * string itself, which is `YYYY.MM.N`: the month is a fact the version states, the day is not
 * recorded and is reported as the first of that month. `changed` and `removed` are left empty for
 * the same reason (see the module docstring): the dictionary knows what a field IS, not what it
 * used to be.
 */
export function versionDate(version: string): string {
  if (version === FIELD_DICTIONARY_VERSION) return FIELD_DICTIONARY_GENERATED_AT.slice(0, 10);
  const [year, month] = versionParts(version);
  if (year === undefined || month === undefined || year < 1 || month < 1 || month > 12) {
    return FIELD_DICTIONARY_GENERATED_AT.slice(0, 10);
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

/**
 * Every dictionary version the definitions mention, newest first, with what changed in it.
 *
 * Derived from `FieldDef.since` and `FieldDef.deprecated.since` — see the module docstring for why
 * that is the right source and why `removed`/`changed` are empty.
 */
export function buildChangelog(defs: readonly FieldDef[]): ChangelogEntry[] {
  const added = new Map<string, FieldId[]>();
  const deprecated = new Map<string, ChangelogEntry['deprecated']>();

  for (const def of defs) {
    const since = added.get(def.since) ?? [];
    since.push(def.id);
    added.set(def.since, since);

    const dep = def.deprecated;
    if (dep !== undefined) {
      const list = deprecated.get(dep.since) ?? [];
      list.push({ id: def.id, replacement: dep.replacement, removeAfter: dep.removeAfter });
      deprecated.set(dep.since, list);
    }
  }

  const versions = [...new Set([...added.keys(), ...deprecated.keys()])].sort((a, b) =>
    compareVersions(b, a),
  );

  return versions.map((version) => ({
    version,
    date: versionDate(version),
    added: added.get(version) ?? [],
    deprecated: deprecated.get(version) ?? [],
    removed: [],
    changed: [],
  }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GET /fields/:id — the governing licence
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Which `licence_registry` row governs a field.
 *
 * Evaluator rule 1 resolves `(fieldId, assetClass)` through `field_licence`. A field is usually
 * governed by one source across every asset class it is meaningful for, so the field-wide row is
 * tried first; failing that, the field's own asset classes are tried in the order the dictionary
 * declares them, and the first that resolves answers. `FieldDetail` carries one licence, so this
 * is a choice the route has to make rather than a list it can return.
 */
function governingSource(
  registry: LicenceRegistry,
  def: FieldDef,
): { sourceId: string } | undefined {
  const wide = registry.fieldSource(def.id, null);
  if (wide !== undefined) return wide;
  for (const assetClass of def.assetClasses) {
    const found = registry.fieldSource(def.id, assetClass);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * `LicenceEntry` + `terms_url` → the wire's `LicenceSummary`.
 *
 * `terms_url` is read here rather than taken from the registry because `LicenceEntry` does not
 * carry it (`entitlements/licenceRegistry.ts` holds what the evaluator decides with, and the
 * evaluator has never needed a URL). One indexed read of one row, on a route nobody calls in a
 * loop.
 */
async function licenceSummary(
  app: FastifyInstance,
  registry: LicenceRegistry,
  sourceId: string,
): Promise<LicenceSummary> {
  const entry = registry.licence(sourceId);
  if (entry === undefined) {
    throw new AppError(
      'INTERNAL',
      `licence_registry has no row for '${sourceId}', which field_licence points at`,
    );
  }
  const rows = await app.deps.db
    .select({ termsUrl: licenceRegistryTable.termsUrl })
    .from(licenceRegistryTable)
    .where(
      and(
        eq(licenceRegistryTable.sourceId, sourceId),
        sql`${licenceRegistryTable.txTo} = 'infinity'`,
        sql`${licenceRegistryTable.validTo} = 'infinity'`,
      ),
    )
    .limit(1);

  return {
    sourceId: entry.sourceId,
    sourceName: entry.sourceName,
    publisher: entry.publisher,
    licenceKind: entry.licenceKind,
    // The same fallback `data/request.ts#withAttribution` uses: a source with no attribution line
    // is credited by its own id rather than by an empty string, so a footer always says something.
    attribution: entry.attribution ?? entry.sourceId,
    display: entry.display,
    exportAllowed: entry.exportAllowed,
    apiAllowed: entry.apiAllowed,
    redistribution: entry.redistribution,
    maxTier: entry.maxTier,
    intrinsicDelayMin: entry.intrinsicDelayMin,
    retentionDays: entry.retentionDays,
    termsUrl: rows[0]?.termsUrl ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The routes
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ChangelogQuery = z.object({ since: z.string().min(1).max(32).optional() });
const FieldIdParam = z.object({ id: z.string().min(1).max(64) });

export const fieldsRoutes: FastifyPluginAsync = async (app) => {
  const guard = guardFor(app);
  // API.md §8's REST bucket. With `PUBLIC_FIELDS=1` there is no session to key on, so
  // `limitKey` falls back to the socket peer — a public dictionary is still not a free loop.
  const options = {
    preHandler: guard === undefined ? [rateLimit(REST_LIMIT)] : [guard, rateLimit(REST_LIMIT)],
  };

  /**
   * `GET /fields` — the dictionary, filtered.
   *
   * `version` serves a prior dictionary for the deprecation window (API.md §7 rule 3). Only the
   * built-in version exists in this build: a request for any other is `404 NOT_FOUND` naming the
   * one that is available, because answering with the current dictionary under an older version
   * number would misreport what that version contained.
   */
  app.get('/fields', options, async (request, reply): Promise<unknown> => {
    const parsed = FieldsQuery.safeParse(request.query ?? {});
    if (!parsed.success) throw new ValidationFailedError('query', parsed.error.issues);
    const query = parsed.data;

    if (query.version !== undefined && query.version !== FIELD_DICTIONARY_VERSION) {
      throw new NotFoundError(
        `no dictionary version '${query.version}'; this build serves ${FIELD_DICTIONARY_VERSION}`,
        'NOT_FOUND',
        { version: query.version, available: [FIELD_DICTIONARY_VERSION] },
      );
    }

    const matched = filterFields(fieldDefs, {
      ...(query.fieldClass === undefined ? {} : { fieldClass: query.fieldClass }),
      ...(query.assetClass === undefined ? {} : { assetClass: query.assetClass }),
      ...(query.q === undefined ? {} : { q: query.q }),
    });

    const payload: FieldDictionary = {
      version: FIELD_DICTIONARY_VERSION,
      generatedAt: FIELD_DICTIONARY_GENERATED_AT,
      fields: matched as FieldDictionary['fields'],
    };
    return sendJson(request, reply, payload, deprecatedIds(matched));
  });

  /**
   * `GET /fields/changelog` — declared before `/fields/:id` for the reader's sake; Fastify's radix
   * router prefers the static segment regardless of registration order.
   */
  app.get('/fields/changelog', options, async (request, reply): Promise<unknown> => {
    const parsed = ChangelogQuery.safeParse(request.query ?? {});
    if (!parsed.success) throw new ValidationFailedError('query', parsed.error.issues);
    const since = parsed.data.since;

    const all = buildChangelog(fieldDefs);
    // "every change since `since`" — strictly after, so a client that already holds `since` is not
    // handed it again.
    const versions =
      since === undefined ? all : all.filter((e) => compareVersions(e.version, since) > 0);

    const payload = ChangelogResponse.parse({ versions });
    const deprecated = versions.flatMap((entry) => entry.deprecated.map((d) => d.id));
    return sendJson(request, reply, payload, deprecated);
  });

  /** `GET /fields/:id` — one definition plus the `licence_registry` row that governs it. */
  app.get('/fields/:id', options, async (request, reply): Promise<unknown> => {
    const parsed = FieldIdParam.safeParse(request.params);
    if (!parsed.success) throw new ValidationFailedError('params', parsed.error.issues);
    const id = parsed.data.id;

    const def = getField(id);
    if (def === undefined) {
      throw new NotFoundError(`not a dictionary field: ${id}`, 'FIELD_UNKNOWN', {
        fields: [id],
        dictionaryVersion: FIELD_DICTIONARY_VERSION,
      });
    }

    const registry = registryFor(app);
    await registry.refreshIfStale();
    const source = governingSource(registry, def);
    if (source === undefined) {
      // ARCHITECTURE §12.1: startup fails when `field_licence` is missing a row, so this is only
      // reachable against a registry that has not been populated. Fail closed and say why.
      throw new NotFoundError(
        `no field_licence row governs ${id}; the licence registry cannot say who owns it`,
        'NOT_FOUND',
        { fieldId: id },
      );
    }

    const licence = await licenceSummary(app, registry, source.sourceId);
    const payload: FieldDetail = { ...def, licence } as FieldDetail;
    return sendJson(request, reply, payload, deprecatedIds([def]));
  });

  await Promise.resolve();
};

export default fieldsRoutes;
