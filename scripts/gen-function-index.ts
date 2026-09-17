/**
 * `scripts/gen-function-index.ts` — writes the six GENERATED barrels (WORKPLAN §1.10, §0.1, §17).
 *
 * Every output file is generated-only: it has no human owner, is never hand-edited, is committed,
 * and CI re-runs this generator and fails on a diff. Adding a module means adding the file and
 * re-running `npm run gen:functions`.
 *
 * The globs are exact rather than "everything in the directory", because several of these
 * directories also hold hand-written siblings — `server/src/functions/` holds WP-08's `runner.ts`,
 * `context.ts`, `resultCache.ts` and `export.ts`, which are not function modules, so that barrel
 * globs one `resolve.ts` per function-code directory.
 *
 * | Barrel                                  | Glob                                                 |
 * | --------------------------------------- | ---------------------------------------------------- |
 * | `core/src/functions/manifests/index.ts` | `manifests/<CODE>.ts`, minus `index.ts`              |
 * | `server/src/functions/index.ts`         | `functions/<CODE>/resolve.ts` (directories only)     |
 * | `web/src/screens/index.ts`              | `screens/<CODE>/Screen.tsx`                          |
 * | `server/src/ingest/jobs/index.ts`       | `jobs/<job>.ts`, minus `index.ts`                    |
 * | `server/src/http/routes/index.ts`       | `routes/<group>.ts`, minus `index.ts`                |
 * | `sdk/src/wire/rest/index.ts`            | `rest/<group>.ts`, minus `index.ts`                  |
 *
 * Emitted shape, for every barrel: one namespace import per glob member, a re-export of each
 * namespace under its member name, and one `const` map so a consumer can enumerate the members the
 * glob matched without knowing their names. Namespaces (rather than `export *`) are used because
 * sibling modules legitimately export the same symbol names — `sdk/src/client/rest.ts` documents
 * and accepts exactly this form ("`export * as auth from './auth.js'` — a namespace that contains
 * the group object").
 *
 * Usage: `npm run gen:functions` writes the files; `--check` writes nothing and exits 1 when any
 * file is missing or stale (for CI).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What a barrel globs: either files in a directory, or an entry file inside each subdirectory. */
type GlobKind = 'files' | 'directories';

interface BarrelSpec {
  /** Repo-relative path of the generated file. */
  readonly out: string;
  /** Repo-relative directory the glob runs in. */
  readonly dir: string;
  readonly kind: GlobKind;
  /** `'.ts'`/`'.tsx'` for `kind: 'files'`; the entry file name for `kind: 'directories'`. */
  readonly match: string;
  /** Name of the emitted module map. */
  readonly mapName: string;
  /** Human-readable glob, written into the header. */
  readonly glob: string;
  /** One line of prose for the header. */
  readonly what: string;
  /**
   * How the barrel binds each member: `'namespace'` (`import * as x`) everywhere except the
   * manifests barrel, whose members export one symbol named for their function code, so it binds
   * them by name and the map is the `manifests` object FUNCTIONS.md L524 specifies.
   */
  readonly bind?: 'namespace' | 'named';
  /** Lines emitted at the top of the file, before the member imports. */
  readonly prologue?: readonly string[];
  /** Lines emitted after the module map. */
  readonly epilogue?: readonly string[];
}

/**
 * The manifests barrel is more than a module map: FUNCTIONS.md L524-528 makes it the source of
 * `manifests`, `FunctionCode`, `PayloadOf<C>`, `ParamsOf<C>` and the single `registry` instance.
 */
const MANIFEST_PROLOGUE: readonly string[] = [
  "import type { ParamsOf as ParamsOfManifest, PayloadOf as PayloadOfManifest } from '../manifest.js';",
  "import { FunctionRegistry } from '../registry.js';",
];

const MANIFEST_EPILOGUE: readonly string[] = [
  '',
  '/** Canonical code → manifest (FUNCTIONS.md L524). Aliases are not keys; `registry` resolves those. */',
  'export const manifests = manifestModules;',
  '',
  "/** 'DES' | 'GP' | … — canonical codes only (FUNCTIONS.md L525). */",
  'export type FunctionCode = keyof typeof manifests;',
  '',
  '/** The payload variant union of one function code (FUNCTIONS.md L526). */',
  'export type PayloadOf<C extends FunctionCode> = PayloadOfManifest<(typeof manifests)[C]>;',
  '',
  '/** The parsed parameter object of one function code (FUNCTIONS.md L527). */',
  'export type ParamsOf<C extends FunctionCode> = ParamsOfManifest<(typeof manifests)[C]>;',
  '',
  '/** The one catalogue every side shares (FUNCTIONS.md L528). */',
  'export const registry = new FunctionRegistry(Object.values(manifests));',
];

const BARRELS: readonly BarrelSpec[] = [
  {
    out: 'packages/core/src/functions/manifests/index.ts',
    dir: 'packages/core/src/functions/manifests',
    kind: 'files',
    match: '.ts',
    mapName: 'manifestModules',
    glob: 'packages/core/src/functions/manifests/*.ts (minus index.ts)',
    what: 'One module per catalogue function manifest (ARCHITECTURE §3.1, BRIEF §6).',
    bind: 'named',
    prologue: MANIFEST_PROLOGUE,
    epilogue: MANIFEST_EPILOGUE,
  },
  {
    out: 'packages/server/src/functions/index.ts',
    dir: 'packages/server/src/functions',
    kind: 'directories',
    match: 'resolve.ts',
    mapName: 'functionModules',
    glob: 'packages/server/src/functions/*/resolve.ts (directories only — one per function code)',
    what: 'Server-side resolvers. Hand-written siblings (runner.ts, context.ts, resultCache.ts, export.ts) are NOT function modules and are excluded by the glob.',
  },
  {
    out: 'packages/web/src/screens/index.ts',
    dir: 'packages/web/src/screens',
    kind: 'directories',
    match: 'Screen.tsx',
    mapName: 'screenModules',
    glob: 'packages/web/src/screens/*/Screen.tsx',
    what: 'One screen component per function code (ARCHITECTURE §3.3).',
  },
  {
    out: 'packages/server/src/ingest/jobs/index.ts',
    dir: 'packages/server/src/ingest/jobs',
    kind: 'files',
    match: '.ts',
    mapName: 'ingestJobModules',
    glob: 'packages/server/src/ingest/jobs/*.ts (minus index.ts)',
    what: 'One module per row of the ingest job table (PROVIDERS §13). `IngestJob.id` is the module basename.',
  },
  {
    out: 'packages/server/src/http/routes/index.ts',
    dir: 'packages/server/src/http/routes',
    kind: 'files',
    match: '.ts',
    mapName: 'routeModules',
    glob: 'packages/server/src/http/routes/*.ts (minus index.ts)',
    what: 'One module per route group, so `http/app.ts` stays frozen after WP-01 (WORKPLAN §18.3).',
  },
  {
    out: 'packages/sdk/src/wire/rest/index.ts',
    dir: 'packages/sdk/src/wire/rest',
    kind: 'files',
    match: '.ts',
    mapName: 'restModules',
    glob: 'packages/sdk/src/wire/rest/*.ts (minus index.ts)',
    what: 'One module per route group; `client/rest.ts` indexes the group objects these namespaces contain.',
  },
];

/** Reserved words that cannot be a binding name; a member called one of these gets a `$` prefix. */
const RESERVED = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
]);

interface Member {
  /** The binding name used in the barrel. */
  readonly name: string;
  /** The ESM specifier, always with a `.js` extension (NodeNext). */
  readonly specifier: string;
}

function identifierFor(raw: string, taken: Set<string>): string {
  let name = raw.replace(/[^A-Za-z0-9_$]/g, '_');
  if (name.length === 0 || /^[0-9]/.test(name)) name = `_${name}`;
  if (RESERVED.has(name)) name = `$${name}`;
  let candidate = name;
  let n = 2;
  while (taken.has(candidate)) candidate = `${name}_${n++}`;
  taken.add(candidate);
  return candidate;
}

function membersOf(spec: BarrelSpec): Member[] {
  const dir = join(ROOT, spec.dir);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const taken = new Set<string>();
  const members: Member[] = [];
  if (spec.kind === 'files') {
    const names = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((n) => n.endsWith(spec.match) && n !== `index${spec.match}` && !n.endsWith('.d.ts'))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const fileName of names) {
      const base = fileName.slice(0, -spec.match.length);
      members.push({ name: identifierFor(base, taken), specifier: `./${base}.js` });
    }
    return members;
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => existsSync(join(dir, n, spec.match)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const entryBase = spec.match.replace(/\.tsx?$/, '');
  for (const sub of dirs) {
    members.push({ name: identifierFor(sub, taken), specifier: `./${sub}/${entryBase}.js` });
  }
  return members;
}

function render(spec: BarrelSpec, members: readonly Member[]): string {
  const lines: string[] = [];
  lines.push('// GENERATED — do not edit.');
  lines.push('//');
  lines.push(
    '// Written by `scripts/gen-function-index.ts` (`npm run gen:functions`), WORKPLAN §1.10.',
  );
  lines.push(`// Glob: ${spec.glob}`);
  lines.push(`// ${spec.what}`);
  lines.push('//');
  lines.push('// Add a module by adding the file and re-running the generator. Hand edits are');
  lines.push('// overwritten and fail CI, which re-runs the generator and diffs the result.');
  lines.push('');
  const prologue = spec.prologue ?? [];
  if (prologue.length > 0) {
    for (const line of prologue) lines.push(line);
    lines.push('');
  }
  if (members.length === 0) {
    lines.push('// The glob matched no modules yet.');
    lines.push('');
    lines.push(`export const ${spec.mapName} = {} as const;`);
  } else {
    for (const m of members) {
      lines.push(
        spec.bind === 'named'
          ? `import { ${m.name} } from '${m.specifier}';`
          : `import * as ${m.name} from '${m.specifier}';`,
      );
    }
    lines.push('');
    lines.push('export {');
    for (const m of members) lines.push(`  ${m.name},`);
    lines.push('};');
    lines.push('');
    lines.push('/** Every module the glob matched, keyed by its file (or directory) name. */');
    lines.push(`export const ${spec.mapName} = {`);
    for (const m of members) lines.push(`  ${m.name},`);
    lines.push('} as const;');
  }
  for (const line of spec.epilogue ?? []) lines.push(line);
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const spec of BARRELS) {
    const members = membersOf(spec);
    const next = render(spec, members);
    const outPath = join(ROOT, spec.out);
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;
    const count = `${members.length} module${members.length === 1 ? '' : 's'}`;
    if (current === next) {
      console.log(`  ok      ${spec.out}  (${count})`);
      continue;
    }
    if (check) {
      stale += 1;
      console.error(`  STALE   ${spec.out}  (${count}) — run \`npm run gen:functions\``);
      continue;
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, next, 'utf8');
    console.log(`  ${current === null ? 'created' : 'updated'} ${spec.out}  (${count})`);
  }
  if (stale > 0) {
    console.error(`\n${stale} generated barrel(s) are out of date.`);
    process.exitCode = 1;
  }
}

main();
