// packages/web/test/chart/types.test.ts — the chart type module's name tables, against their sources.
//
// `src/chart/types.ts` and `src/chart/studies/types.ts` are type declarations, and the compiler is
// what checks those: `tsc -b` is the assertion that `SeriesDraw` is satisfiable, that `DrawMode` is
// the seven kinds of `ChartSpec.annotations`, and that `SERIES_TYPES` covers `SeriesType` (it is a
// `satisfies Record<SeriesType, SeriesType>`, so a thirteenth member of the union breaks the build).
// None of that needs a runtime test and none of it can be tested at runtime.
//
// What CAN be wrong at runtime is the four name tables those files ship, because each of them is a
// transcription of something written down elsewhere, and a transcription is exactly the kind of thing
// that is right on the day it is typed and wrong six weeks later. So this file reads the sources —
// CLIENT.md §11.3, §11.6 and §11.8, and the `chart_annotations.kind` CHECK constraint in migration
// 0012 — and compares. A renamed study, a reordered draw-mode footer, an eighth annotation kind
// added to the database, a typo in an id: each of those fails here rather than in a trader's hands,
// and the last one would otherwise fail as a Postgres CHECK violation on `Ctrl+S` after the
// annotation had already been drawn.
//
// jsdom's global `URL` is not the one `fileURLToPath` accepts, so paths are resolved with `dirname`
// — the same reason `test/no-direct-io.test.ts` gives.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DRAW_MODES,
  DRAW_MODE_ANCHORS,
  DRAW_MODE_LABEL,
  SERIES_TYPES,
} from '../../src/chart/types.js';
import { STUDY_IDS } from '../../src/chart/studies/types.js';

/** `packages/web/test/chart/` → `packages/web/` → the monorepo root. */
const WEB_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_ROOT = dirname(dirname(WEB_ROOT));

const CLIENT_MD = readFileSync(join(REPO_ROOT, 'docs', 'CLIENT.md'), 'utf8');
const MIGRATION_0012 = readFileSync(
  join(REPO_ROOT, 'packages', 'server', 'drizzle', 'migrations', '0012_workspace_portfolio.sql'),
  'utf8',
);

/** The text of one `### n.n` subsection of CLIENT.md, up to the next `###`. */
function section(heading: string): string {
  const start = CLIENT_MD.indexOf(`### ${heading}`);
  expect(start, `CLIENT.md has no section ${heading}`).toBeGreaterThan(-1);
  const rest = CLIENT_MD.slice(start + 4);
  const end = rest.indexOf('\n### ');
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The first column of every `| \`id\` | … |` row of a markdown table, in document order.
 *
 * `header` is the doc's own name for that column and is dropped when it appears — §11.3 heads its
 * table `| \`SeriesType\` |`, in backticks like the rows, so it is indistinguishable from an id
 * without being told. It is a parameter rather than a "skip the first match" rule because skipping
 * blind would also swallow a real id if the heading ever loses its backticks.
 */
function firstColumnIds(markdown: string, header?: string): string[] {
  const ids: string[] = [];
  for (const line of markdown.split('\n')) {
    const m = /^\|\s*`([A-Za-z_]+)`\s*\|/.exec(line);
    if (m?.[1] !== undefined && m[1] !== header) ids.push(m[1]);
  }
  return ids;
}

describe('SERIES_TYPES (CLIENT.md §11.3, CHRT-01)', () => {
  it('lists every series type the §11.3 table draws, in the same order', () => {
    const documented = firstColumnIds(section('11.3'), 'SeriesType');
    expect(documented).toHaveLength(12);
    expect([...SERIES_TYPES]).toEqual(documented);
  });

  it('is frozen: the table is shared by every draw path and nothing may splice it', () => {
    expect(Object.isFrozen(SERIES_TYPES)).toBe(true);
  });
});

describe('DrawMode tables (CLIENT.md §11.8, CHRT-05)', () => {
  /** The `kind IN (…)` CHECK of `chart_annotations`, which is the authority on which kinds exist. */
  const checkedKinds = ((): string[] => {
    const table = MIGRATION_0012.slice(MIGRATION_0012.indexOf('CREATE TABLE chart_annotations'));
    const ddl = table.slice(0, table.indexOf(');'));
    const m = /CHECK \(kind IN \(([^)]*)\)\)/.exec(ddl);
    expect(m?.[1], 'migration 0012 no longer CHECKs chart_annotations.kind').toBeDefined();
    return (m?.[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  })();

  it('DRAW_MODES is exactly the kinds the database accepts, in the same order', () => {
    // Order matters as well as membership: the footer lists the kinds in this order and the letter
    // keys of §11.8 are read off that footer, so a reordering here is a reordering of the UI.
    expect(checkedKinds).toHaveLength(7);
    expect([...DRAW_MODES]).toEqual(checkedKinds);
  });

  it('DRAW_MODE_LABEL spells the footer §11.8 shows, in DRAW_MODES order', () => {
    const footer = /the footer shows `([^`]+)`/.exec(section('11.8'))?.[1];
    expect(footer, 'CLIENT.md §11.8 no longer states the draw-mode footer').toBeDefined();
    expect(DRAW_MODES.map((k) => DRAW_MODE_LABEL[k]).join(' ')).toBe(footer);
  });

  it('DRAW_MODE_ANCHORS matches the anchor count §11.8 states for each kind', () => {
    const prose = section('11.8');
    const documented = Object.fromEntries(
      DRAW_MODES.map((kind) => {
        const m = new RegExp(`\`${kind}\` \\((\\d)`).exec(prose);
        expect(m?.[1], `CLIENT.md §11.8 states no anchor count for ${kind}`).toBeDefined();
        return [kind, Number(m?.[1])];
      }),
    );
    expect({ ...DRAW_MODE_ANCHORS }).toEqual(documented);
  });
});

describe('STUDY_IDS (CLIENT.md §11.6, CHRT-04)', () => {
  it('is the 22 ids of the §11.6 registry table, in the same order', () => {
    // 22 is the shipped registry; CHRT-04's ~100 is the stated gap (§11.11). The count is asserted
    // so that dropping a study is a failure rather than a shorter picker nobody notices.
    const documented = firstColumnIds(section('11.6'));
    expect(documented).toHaveLength(22);
    expect([...STUDY_IDS]).toEqual(documented);
  });

  it('has no duplicate id: the registry is keyed by these', () => {
    expect(new Set(STUDY_IDS).size).toBe(STUDY_IDS.length);
  });
});
