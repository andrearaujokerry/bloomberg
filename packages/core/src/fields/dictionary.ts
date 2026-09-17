// packages/core/src/fields/dictionary.ts
//
// The field dictionary (API-07, API.md §7). Defined once here, validated and serialised to
// `packages/sdk/src/fields/fields.json` by `scripts/gen-fields.ts`, served by `GET /fields`, and
// read by `core/fields/format.ts` — which is why a field looks the same on the screen, in the CSV
// header and in the SDK.
//
// The entries live in `defs/<field_class>.ts`, one file per `field_class`, so that each class has a
// single owner. This module imports those files directly rather than the generated `defs/index.ts`
// barrel: the assembled dictionary must exist before the generator ever runs, and the barrel adds
// nothing the eight named imports do not already give.

import type { AssetClass } from '../types/instrument.js';
import type { FieldClass, FieldDef, FieldId } from '../types/fields.js';

import { analyticFields } from './defs/analytic.js';
import { derivedFields } from './defs/derived.js';
import { econFields } from './defs/econ.js';
import { fundamentalFields } from './defs/fundamental.js';
import { newsFields } from './defs/news.js';
import { portfolioFields } from './defs/portfolio.js';
import { priceFields } from './defs/price.js';
import { referenceFields } from './defs/reference.js';

/** Recorded in `schema_meta('field_dictionary_version')`; returned as `dictionaryVersion`. */
export const FIELD_DICTIONARY_VERSION = '2026.09.1';

/**
 * Fixed, not `now()`: `packages/core` has no clock and the dictionary is a build artefact, so its
 * `generatedAt` must be reproducible byte-for-byte across processes (the `/fields` ETag depends on it).
 */
export const FIELD_DICTIONARY_GENERATED_AT = '2026-09-17T00:00:00.000Z';

export interface FieldDictionaryDoc {
  version: string;
  generatedAt: string;
  fields: readonly FieldDef[];
}

const assemble = (): readonly FieldDef[] => {
  const all = [
    ...priceFields,
    ...referenceFields,
    ...fundamentalFields,
    ...econFields,
    ...newsFields,
    ...analyticFields,
    ...derivedFields,
    ...portfolioFields,
  ];
  const seen = new Map<string, FieldDef>();
  for (const def of all) {
    const existing = seen.get(def.id);
    if (existing !== undefined) {
      throw new Error(
        `duplicate field id '${def.id}': declared in both the '${existing.fieldClass}' and ` +
          `'${def.fieldClass}' class files — a field id is globally unique and never reused`,
      );
    }
    seen.set(def.id, def);
  }
  return [...all].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

/** Every field, sorted by id. */
export const fieldDefs: readonly FieldDef[] = assemble();

const byId: ReadonlyMap<string, FieldDef> = new Map(fieldDefs.map((def) => [def.id, def]));

/** The document `scripts/gen-fields.ts` validates and writes out. */
export const fieldDictionary: FieldDictionaryDoc = {
  version: FIELD_DICTIONARY_VERSION,
  generatedAt: FIELD_DICTIONARY_GENERATED_AT,
  fields: fieldDefs,
};

/** `undefined` for an id the dictionary does not know — callers decide whether that is an error. */
export function getField(id: FieldId): FieldDef | undefined {
  return byId.get(id);
}

export function hasField(id: string): boolean {
  return byId.has(id);
}

/** The strict lookup, for call sites that treat an unknown id as a bug (the runner does). */
export function requireField(id: FieldId): FieldDef {
  const def = byId.get(id);
  if (def === undefined) {
    throw new Error(
      `unknown field id '${id}' (core/fields/dictionary.ts, v${FIELD_DICTIONARY_VERSION})`,
    );
  }
  return def;
}

/** Every field id, sorted. */
export function fieldIds(): FieldId[] {
  return fieldDefs.map((def) => def.id);
}

/**
 * Filtered view used by `GET /fields` and the HELP overlay. A field with an empty `assetClasses`
 * is subject-only (`n:`, `c:`, `e:`, `sys:`) and never matches an asset-class filter.
 */
export function listFields(filter?: {
  fieldClass?: FieldClass;
  assetClass?: AssetClass;
}): FieldDef[] {
  if (filter === undefined) return [...fieldDefs];
  return fieldDefs.filter(
    (def) =>
      (filter.fieldClass === undefined || def.fieldClass === filter.fieldClass) &&
      (filter.assetClass === undefined || def.assetClasses.includes(filter.assetClass)),
  );
}
