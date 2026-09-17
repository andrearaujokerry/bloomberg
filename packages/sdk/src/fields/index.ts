/**
 * `fields/index.ts` — `FieldsApi` (API.md §10.3 L1354-1358).
 *
 * The dictionary itself is `core/src/fields/` (API-07); this module is the client-side view of it:
 * an in-memory index that can be seeded from the GENERATED `sdk/src/fields/fields.json` and
 * refreshed from `GET /fields`, plus `format()`, which is a straight delegation to
 * `core/fields/format.ts` — the only formatter in the system (API.md L1356). Nothing here formats a
 * number itself.
 *
 * The route is found through `RestClient.routeIdFor('GET', '/fields')`, never by a hard-coded route
 * id, so this file stays correct whatever `wire/rest/fields.ts` calls the entry.
 */
import { format as coreFormat } from '@terminal/core';
import type { AssetClass, FieldClass, FieldDef, FieldId, FieldValue } from '@terminal/core';

import type { RestClient } from '../client/rest.js';

/** Options accepted by `core/fields/format.ts` (API.md L1356). */
export interface FieldFormatOptions {
  priceDecimals?: number | undefined;
  locale?: string | undefined;
}

/** The single formatter signature; injectable so tests can assert on calls. */
export type FieldFormatter = (id: FieldId, value: FieldValue, opts?: FieldFormatOptions) => string;

/** `GET /fields` → API.md §7 L1100. */
export interface FieldDictionary {
  version: string;
  generatedAt?: string;
  fields: readonly FieldDef[];
}

export interface FieldFilter {
  fieldClass?: FieldClass | undefined;
  assetClass?: AssetClass | undefined;
  /** substring on id or label — the `q` parameter of `GET /fields`. */
  q?: string | undefined;
}

/** API.md §10.3 L1354-1358. */
export interface FieldsApi {
  /** dictionary version (`'2026.09.1'`), `''` until the first seed or refresh. */
  readonly version: string;
  /** how many definitions are loaded. */
  readonly size: number;
  get(id: FieldId): FieldDef | undefined;
  list(filter?: FieldFilter): FieldDef[];
  format(id: FieldId, value: FieldValue, opts?: FieldFormatOptions): string;
  /** `GET /fields`; warns on deprecated ids already in use. */
  refresh(): Promise<void>;
  /** Seed from the generated `fields.json` (or a test fixture) without a round trip. */
  load(dictionary: FieldDictionary): void;
}

export interface FieldsApiOptions {
  /** used by `refresh()`; omit for an offline, seed-only dictionary. */
  rest?: RestClient | undefined;
  seed?: FieldDictionary | undefined;
  /** overrides `core/fields/format.ts` (tests only). */
  format?: FieldFormatter | undefined;
  /** called instead of `console.warn` when a refreshed definition deprecates an id in use. */
  onDeprecated?: ((ids: readonly FieldId[]) => void) | undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Reads `{ version, fields }` out of whatever `GET /fields` returned. */
function toDictionary(value: unknown): FieldDictionary {
  if (!isRecord(value) || !Array.isArray(value.fields)) {
    throw new TypeError('GET /fields did not return a FieldDictionary');
  }
  const version = typeof value.version === 'string' ? value.version : '';
  const generatedAt = typeof value.generatedAt === 'string' ? value.generatedAt : undefined;
  const fields = value.fields as readonly FieldDef[];
  return generatedAt === undefined ? { version, fields } : { version, generatedAt, fields };
}

function isDeprecated(def: FieldDef): boolean {
  const bag = def as unknown as Record<string, unknown>;
  return bag.deprecated !== undefined && bag.deprecated !== null;
}

export function createFieldsApi(opts: FieldsApiOptions = {}): FieldsApi {
  const byId = new Map<FieldId, FieldDef>();
  const used = new Set<FieldId>();
  let version = '';
  // `core/fields/format.ts` is the only formatter (API.md L1356). It is called through this
  // wrapper rather than aliased, so that an `opts` object carrying explicit `undefined`s (legal
  // here, not under core's `exactOptionalPropertyTypes` signature) is normalised first.
  const fallback: FieldFormatter = (id, value, formatOpts) => {
    const forwarded: { priceDecimals?: number; locale?: string } = {};
    if (formatOpts?.priceDecimals !== undefined) forwarded.priceDecimals = formatOpts.priceDecimals;
    if (formatOpts?.locale !== undefined) forwarded.locale = formatOpts.locale;
    return coreFormat(id, value, forwarded);
  };
  const formatter: FieldFormatter = opts.format ?? fallback;

  const load = (dictionary: FieldDictionary): void => {
    byId.clear();
    for (const def of dictionary.fields) byId.set(def.id, def);
    version = dictionary.version;
    const stale = [...used].filter((id) => {
      const def = byId.get(id);
      return def !== undefined && isDeprecated(def);
    });
    if (stale.length > 0) {
      if (opts.onDeprecated) opts.onDeprecated(stale);
      else console.warn(`[@terminal/sdk] deprecated field ids in use: ${stale.join(', ')}`);
    }
  };

  if (opts.seed) load(opts.seed);

  const get = (id: FieldId): FieldDef | undefined => {
    used.add(id);
    return byId.get(id);
  };

  return {
    get version(): string {
      return version;
    },
    get size(): number {
      return byId.size;
    },
    get,
    list(filter?: FieldFilter): FieldDef[] {
      const q = filter?.q?.toLowerCase();
      const out: FieldDef[] = [];
      for (const def of byId.values()) {
        if (filter?.fieldClass !== undefined && def.fieldClass !== filter.fieldClass) continue;
        if (filter?.assetClass !== undefined && !def.assetClasses.includes(filter.assetClass)) {
          continue;
        }
        if (
          q !== undefined &&
          !def.id.toLowerCase().includes(q) &&
          !def.label.toLowerCase().includes(q)
        ) {
          continue;
        }
        out.push(def);
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    format(id: FieldId, value: FieldValue, formatOpts?: FieldFormatOptions): string {
      used.add(id);
      return formatter(id, value, formatOpts);
    },
    async refresh(): Promise<void> {
      const rest = opts.rest;
      if (rest === undefined) {
        throw new Error('FieldsApi.refresh() needs a RestClient — pass one to createFieldsApi()');
      }
      const routeId = rest.routeIdFor('GET', '/fields');
      if (routeId === undefined) {
        throw new Error(
          'wire/rest declares no route for GET /fields — cannot refresh the dictionary',
        );
      }
      load(toDictionary(await rest.call(routeId)));
    },
    load,
  };
}
