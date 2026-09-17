/**
 * `scripts/gen-fields.ts` — validates the field dictionary and writes its two generated artefacts
 * (WORKPLAN §1.10, §18.2; API-03, API-07).
 *
 * Input:  `packages/core/src/fields/defs/*.ts` (minus the generated `index.ts`) — one file per
 *         `field_class`, each exporting `<class>Fields: readonly FieldDef[]`, plus
 *         `packages/core/src/fields/dictionary.ts`, which assembles and sorts them.
 * Output: `packages/core/src/fields/defs/index.ts`   — GENERATED barrel over the glob
 *         `packages/sdk/src/fields/fields.json`      — GENERATED `{version, generatedAt, fields}`
 *
 * The dictionary is a build artefact with a fixed `generatedAt` (see `dictionary.ts`), so this
 * script is deterministic: running it twice writes byte-identical files, and CI re-runs it and
 * fails on a diff. `--check` validates and diffs without writing.
 *
 * Validation is the point of the script, not a side effect: a malformed definition must fail here
 * rather than at `GET /fields`, in a CSV header or in a screen column.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFS_DIR = join(ROOT, 'packages/core/src/fields/defs');
const BARREL_OUT = join(DEFS_DIR, 'index.ts');
const JSON_OUT = join(ROOT, 'packages/sdk/src/fields/fields.json');

/* ------------------------------------------------------------------ vocabularies (core/types) */

const FIELD_CLASSES = [
  'price',
  'reference',
  'fundamental',
  'econ',
  'news',
  'analytic',
  'derived',
  'portfolio',
] as const;

const FIELD_TYPES = ['number', 'integer', 'string', 'boolean', 'date', 'datetime', 'enum'] as const;

const FIELD_UNITS = [
  'price',
  'pct',
  'bp',
  'shares',
  'contracts',
  'ccy',
  'ratio',
  'years',
  'days',
  'count',
  'bn',
  'text',
  'date',
  'datetime',
  'enum',
] as const;

const UPDATE_FREQS = [
  'tick',
  '10s',
  '1m',
  'daily',
  'weekly',
  'twice_monthly',
  'monthly',
  'quarterly',
  'annual',
  'on_filing',
  'static',
] as const;

const ASSET_CLASSES = [
  'equity',
  'etf',
  'index',
  'fx',
  'govt',
  'option',
  'future',
  'crypto',
  'rate',
  'econ',
] as const;

const FIELD_ID_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/* ------------------------------------------------------------------------------- tiny helpers */

const problems: string[] = [];
const warnings: string[] = [];

function fail(where: string, message: string): void {
  problems.push(`${where}: ${message}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function oneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/* -------------------------------------------------------------------------------- the defs glob */

function defFiles(): string[] {
  if (!existsSync(DEFS_DIR)) {
    console.error(`missing directory ${DEFS_DIR} — packages/core/src/fields/defs/*.ts is WP-01's`);
    process.exit(1);
  }
  return readdirSync(DEFS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => n.endsWith('.ts') && n !== 'index.ts' && !n.endsWith('.d.ts'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/* ----------------------------------------------------------------------------- def validation */

function validateDef(def: unknown, where: string, expectedClass: string): void {
  if (!isRecord(def)) {
    fail(where, 'is not an object');
    return;
  }
  const id = def.id;
  if (typeof id !== 'string' || !FIELD_ID_RE.test(id)) {
    fail(where, `id ${JSON.stringify(id)} does not match ${String(FIELD_ID_RE)}`);
  }
  const at = typeof id === 'string' ? `${where} (${id})` : where;

  if (!nonEmptyString(def.label)) fail(at, 'label is empty');
  if (!nonEmptyString(def.definition)) fail(at, 'definition is empty');
  if (!oneOf(FIELD_TYPES, def.type))
    fail(at, `type ${JSON.stringify(def.type)} is not a FieldType`);
  if (def.unit !== null && !oneOf(FIELD_UNITS, def.unit)) {
    fail(at, `unit ${JSON.stringify(def.unit)} is neither null nor a FieldUnit`);
  }
  if (
    def.decimals !== null &&
    !(
      typeof def.decimals === 'number' &&
      Number.isInteger(def.decimals) &&
      def.decimals >= 0 &&
      def.decimals <= 12
    )
  ) {
    fail(at, `decimals ${JSON.stringify(def.decimals)} is neither null nor an integer 0..12`);
  }
  if (def.type === 'enum') {
    if (!Array.isArray(def.enumValues) || def.enumValues.length === 0) {
      fail(at, "type 'enum' needs a non-empty enumValues");
    } else if (!def.enumValues.every((v) => nonEmptyString(v))) {
      fail(at, 'enumValues holds a non-string or empty value');
    }
  } else if (def.enumValues !== undefined) {
    fail(at, `enumValues is only meaningful for type 'enum' (type is ${JSON.stringify(def.type)})`);
  }

  if (!oneOf(FIELD_CLASSES, def.fieldClass)) {
    fail(at, `fieldClass ${JSON.stringify(def.fieldClass)} is not a FieldClass`);
  } else if (def.fieldClass !== expectedClass) {
    fail(
      at,
      `fieldClass '${def.fieldClass}' but the file is defs/${expectedClass}.ts — one owner per class`,
    );
  }

  if (!Array.isArray(def.assetClasses)) {
    fail(at, 'assetClasses is not an array');
  } else {
    const seen = new Set<string>();
    for (const ac of def.assetClasses) {
      if (!oneOf(ASSET_CLASSES, ac)) fail(at, `assetClasses holds ${JSON.stringify(ac)}`);
      else if (seen.has(ac)) fail(at, `assetClasses repeats '${ac}'`);
      else seen.add(ac);
    }
  }

  if (!Array.isArray(def.sources)) {
    fail(at, 'sources is not an array');
  } else {
    def.sources.forEach((src, i) => {
      const sAt = `${at}.sources[${i}]`;
      if (!isRecord(src)) {
        fail(sAt, 'is not an object');
        return;
      }
      if (src.assetClass !== '*' && !oneOf(ASSET_CLASSES, src.assetClass)) {
        fail(sAt, `assetClass ${JSON.stringify(src.assetClass)} is neither '*' nor an AssetClass`);
      }
      if (!nonEmptyString(src.sourceId)) fail(sAt, 'sourceId is empty');
      if (!nonEmptyString(src.endpoint)) fail(sAt, 'endpoint is empty');
      if (!nonEmptyString(src.providerPath)) fail(sAt, 'providerPath is empty');
    });
  }

  if (!oneOf(UPDATE_FREQS, def.updateFreq)) {
    fail(at, `updateFreq ${JSON.stringify(def.updateFreq)} is not a FieldUpdateFreq`);
  }
  if (typeof def.pit !== 'boolean') fail(at, 'pit is not a boolean');

  if (def.fieldClass === 'derived' || def.fieldClass === 'analytic') {
    if (!nonEmptyString(def.derivation)) {
      warnings.push(
        `${at}: fieldClass '${String(def.fieldClass)}' carries no derivation (ANAL-08)`,
      );
    }
  }

  const example = def.example;
  if (!isRecord(example)) {
    fail(at, 'example is missing');
  } else {
    if (!nonEmptyString(example.ref)) fail(at, 'example.ref is empty');
    const v = example.value;
    if (!(typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')) {
      fail(at, `example.value ${JSON.stringify(v)} is not a number, string or boolean`);
    }
    if (!nonEmptyString(example.asOf) || !ISO_INSTANT_RE.test(String(example.asOf))) {
      fail(at, `example.asOf ${JSON.stringify(example.asOf)} is not an ISO-8601 date or instant`);
    }
  }

  if (!nonEmptyString(def.since)) fail(at, 'since is empty');

  if (def.deprecated !== undefined) {
    const dep = def.deprecated;
    if (!isRecord(dep)) {
      fail(at, 'deprecated is not an object');
    } else {
      if (!nonEmptyString(dep.since)) fail(at, 'deprecated.since is empty');
      if (
        dep.replacement !== null &&
        !(typeof dep.replacement === 'string' && FIELD_ID_RE.test(dep.replacement))
      ) {
        fail(
          at,
          `deprecated.replacement ${JSON.stringify(dep.replacement)} is neither null nor a field id`,
        );
      }
      if (!nonEmptyString(dep.removeAfter)) fail(at, 'deprecated.removeAfter is empty');
    }
  }
}

/* ------------------------------------------------------------------------------ output writers */

function renderBarrel(classes: readonly string[]): string {
  const lines: string[] = [];
  lines.push('// GENERATED — do not edit.');
  lines.push('//');
  lines.push('// Written by `scripts/gen-fields.ts` (`npm run gen:fields`), WORKPLAN §1.10.');
  lines.push(
    '// Glob: packages/core/src/fields/defs/*.ts (minus index.ts) — one file per field_class.',
  );
  lines.push('//');
  lines.push(
    '// `fields/dictionary.ts` imports the class files directly, not this barrel: the assembled',
  );
  lines.push(
    '// dictionary must exist before the generator ever runs. This barrel is for everything else',
  );
  lines.push('// that wants the per-class arrays or to enumerate the classes the glob matched.');
  lines.push('');
  if (classes.length === 0) {
    lines.push('// The glob matched no class files yet.');
    lines.push('');
    lines.push('export const fieldDefsByClass = {} as const;');
    lines.push('');
    return lines.join('\n');
  }
  for (const c of classes) lines.push(`import { ${c}Fields } from './${c}.js';`);
  lines.push('');
  lines.push('export {');
  for (const c of classes) lines.push(`  ${c}Fields,`);
  lines.push('};');
  lines.push('');
  lines.push('/** Every class array the glob matched, keyed by `field_class`. */');
  lines.push('export const fieldDefsByClass = {');
  for (const c of classes) lines.push(`  ${c}: ${c}Fields,`);
  lines.push('} as const;');
  lines.push('');
  return lines.join('\n');
}

function writeIfChanged(path: string, next: string, check: boolean): boolean {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const rel = path.slice(ROOT.length + 1);
  if (current === next) {
    console.log(`  ok      ${rel}`);
    return true;
  }
  if (check) {
    console.error(`  STALE   ${rel} — run \`npm run gen:fields\``);
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, 'utf8');
  console.log(`  ${current === null ? 'created' : 'updated'} ${rel}`);
  return true;
}

/* -------------------------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const files = defFiles();
  if (files.length === 0) {
    console.error('no field-class files in packages/core/src/fields/defs/ — nothing to validate');
    process.exit(1);
  }

  const classes: string[] = [];
  const fromDefs = new Map<string, string>(); // field id → defining class file

  for (const fileName of files) {
    const base = fileName.slice(0, -3);
    const where = `defs/${fileName}`;
    if (!oneOf(FIELD_CLASSES, base)) {
      fail(
        where,
        `file name is not a FieldClass (one file per class: ${FIELD_CLASSES.join(', ')})`,
      );
      continue;
    }
    const mod: unknown = await import(pathToFileURL(join(DEFS_DIR, fileName)).href);
    const exportName = `${base}Fields`;
    const exported = isRecord(mod) ? mod[exportName] : undefined;
    if (!Array.isArray(exported)) {
      fail(where, `must export \`${exportName}: readonly FieldDef[]\``);
      continue;
    }
    classes.push(base);
    exported.forEach((def, i) => {
      validateDef(def, `${where}[${i}]`, base);
      const id: unknown = isRecord(def) ? def.id : undefined;
      if (typeof id === 'string') {
        const prior = fromDefs.get(id);
        if (prior !== undefined)
          fail(where, `duplicate field id '${id}', already defined in defs/${prior}.ts`);
        else fromDefs.set(id, base);
      }
    });
  }

  // The dictionary is the assembled, sorted, duplicate-checked view; it must agree with the glob.
  const dictMod: unknown = await import(
    pathToFileURL(join(ROOT, 'packages/core/src/fields/dictionary.ts')).href
  );
  if (!isRecord(dictMod) || !isRecord(dictMod.fieldDictionary)) {
    fail('core/fields/dictionary.ts', 'does not export `fieldDictionary`');
  }
  const dictionary = isRecord(dictMod) ? (dictMod.fieldDictionary as Record<string, unknown>) : {};
  const version = dictionary.version;
  const generatedAt = dictionary.generatedAt;
  const fields = dictionary.fields;
  if (!nonEmptyString(version))
    fail('core/fields/dictionary.ts', 'fieldDictionary.version is empty');
  if (!nonEmptyString(generatedAt)) {
    fail(
      'core/fields/dictionary.ts',
      'fieldDictionary.generatedAt is empty (it must be fixed, not now())',
    );
  }
  if (!Array.isArray(fields)) {
    fail('core/fields/dictionary.ts', 'fieldDictionary.fields is not an array');
  } else {
    const dictIds = fields.map((f: unknown) => (isRecord(f) ? String(f.id) : '?'));
    const sorted = [...dictIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (dictIds.join(' ') !== sorted.join(' ')) {
      fail('core/fields/dictionary.ts', 'fieldDictionary.fields is not sorted by id');
    }
    for (const id of dictIds) {
      if (!fromDefs.has(id))
        fail(
          'core/fields/dictionary.ts',
          `field '${id}' is in the dictionary but in no defs/*.ts file`,
        );
    }
    for (const id of fromDefs.keys()) {
      if (!dictIds.includes(id)) {
        fail(
          `defs/${String(fromDefs.get(id))}.ts`,
          `field '${id}' is not assembled into dictionary.ts`,
        );
      }
    }
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} field-dictionary problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  for (const w of warnings) console.warn(`  warn    ${w}`);

  const barrelOk = writeIfChanged(BARREL_OUT, renderBarrel(classes), check);
  const json = `${JSON.stringify({ version, generatedAt, fields }, null, 2)}\n`;
  const jsonOk = writeIfChanged(JSON_OUT, json, check);

  const count = Array.isArray(fields) ? fields.length : 0;
  console.log(
    `  ${count} fields in ${classes.length} classes, dictionary v${String(version)} (generatedAt ${String(generatedAt)})`,
  );
  if (!barrelOk || !jsonOk) process.exit(1);
}

await main();
