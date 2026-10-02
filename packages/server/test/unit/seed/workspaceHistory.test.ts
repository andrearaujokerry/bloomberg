/**
 * Every command the seeded workspaces put in a panel's history ring must RUN (DATA_MODEL §18 module
 * 13, FUNCTIONS §2.4, TERM-05).
 *
 * A history entry is not a label. `Ctrl+P` / `Ctrl+N` recall it into the command line and the desk
 * presses GO, so an entry the parser cannot read is a seeded dead end — and `fixtures/seed/
 * workspaces.json` held one: `SPX Index GP RANGE=1Y`, later `RANGE=5D`. `GP.paramGrammar` lists
 * `range` as its first POSITIONAL slot and its `keyed` map holds TYPE / ADJ / VS / CCY / NORM / PER /
 * LOG and no RANGE, so `core/command/args.ts` answers `ARG_PARSE: RANGE is not an argument of this
 * function` and the run starts on the manifest default instead of the range the panel is showing.
 * Nothing noticed, because the seed validates the `layout` against the wire schema (which types
 * `history` as `string[]`) and no test had ever read the strings.
 *
 * This is the test that reads them, over the fixture the seed actually writes, through the shipped
 * parser rather than a transcription of its rules. It is a unit test on purpose: the fixture is a
 * file, the parser is pure, and the failure a seed run would give is a 157-second seed that succeeds
 * anyway.
 *
 * The universe is deliberately NOT stubbed into existence. `lookupTicker` answers `[]`, as it does on
 * a cold client before the universe index has built, so a security problem (`BAD_IDENTIFIER`,
 * `NOT_IN_UNIVERSE`) is possible here and is not what this file is about: the assertion is on
 * `ARG_PARSE` and on the function code, which are decided from the text and the registry alone.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, registry, type PanelContext, type ParseEnv } from '@terminal/core';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');
const FIXTURE = join(REPO_ROOT, 'fixtures', 'seed', 'workspaces.json');

interface SeedFrame {
  fn: string | null;
  params?: Record<string, unknown>;
}
interface SeedPanel {
  id: string;
  frameStack: SeedFrame[];
  history?: string[];
}
interface SeedFixture {
  layout: { panels: SeedPanel[] };
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as SeedFixture;

/** An empty panel: a recalled command is typed into whatever panel the desk is on. */
const EMPTY_PANEL: PanelContext = { panelId: 'p1', security: null, fn: null, params: {} };

function envFor(): ParseEnv {
  return {
    registry,
    panel: EMPTY_PANEL,
    lookupTicker: () => [],
    today: '2026-10-01',
    panelId: 'p1',
  };
}

describe('the seeded workspace history is runnable (DATA_MODEL §18 module 13)', () => {
  const entries = fixture.layout.panels.flatMap((panel) =>
    (panel.history ?? []).map((raw) => ({ panelId: panel.id, raw })),
  );

  it('has history to check', () => {
    // Guards against the shape of this file passing vacuously if `history` is ever renamed or moved:
    // four panels, each with the one command that restored it.
    expect(entries.length).toBeGreaterThanOrEqual(4);
  });

  it('parses every entry with no ARG_PARSE problem', () => {
    const bad: string[] = [];
    for (const { panelId, raw } of entries) {
      for (const cmd of parse(raw, envFor())) {
        for (const problem of cmd.problems) {
          if (problem.code === 'ARG_PARSE') bad.push(`${panelId}: "${raw}" — ${problem.message}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('contradicts none of the params the panel was seeded with', () => {
    // The complement of the assertion above, and the exact claim is worth stating because a looser one
    // would pass against the defect this file was written for. A recalled entry has to reproduce the
    // frame it came from, and it may do that in two ways: by NAMING the param, or by leaving it to the
    // manifest default when that default is already the frame's value. `W`'s `view: 'grid'` is the
    // second kind — `W.params` defaults `view` to `'grid'`, so `W Core` restores the same screen
    // without saying so — and `GP`'s `range: '5D'` must be the first, because GP defaults to `'1Y'`.
    //
    // Note what this one alone would NOT catch: `SPX Index GP RANGE=1Y`, the original defect, named
    // nothing the parser could read AND GP's default is `1Y`, so the frame and the parse agreed by
    // accident. That is why the ARG_PARSE assertion above is the primary one and this is the second.
    for (const panel of fixture.layout.panels) {
      const frame = panel.frameStack[0];
      const raw = panel.history?.[0];
      if (frame === undefined || raw === undefined) continue;
      const cmds = parse(raw, envFor());
      const cmd = cmds[cmds.length - 1];
      expect(cmd, `${panel.id}: "${raw}" parsed to nothing`).toBeDefined();
      if (cmd === undefined) continue;
      expect(cmd.fn?.code ?? null, `${panel.id}: "${raw}"`).toBe(frame.fn);

      // The params AS THE RUNNER WOULD SEE THEM: what the parser read, through the manifest's own
      // schema, so a key the text left out arrives as the manifest default. That is the comparison the
      // claim needs — `W Core` restores `view: 'grid'` because `W.params` defaults it, and the only way
      // to say so without re-stating the defaults here is to run the schema. A history entry whose
      // params the manifest rejects is a defect in its own right, so the parse is asserted too.
      const manifest = frame.fn === null ? undefined : registry.get(frame.fn);
      const effective = manifest?.params.safeParse(cmd.params);
      expect(effective?.success, `${panel.id}: "${raw}" does not satisfy ${String(frame.fn)}.params`).toBe(
        true,
      );
      const resolved: Record<string, unknown> =
        effective?.success === true ? (effective.data as Record<string, unknown>) : cmd.params;

      for (const [key, value] of Object.entries(frame.params ?? {})) {
        const got = resolved[key];
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          // A reference the parser ENRICHES rather than copies: `W`'s seeded `{ watchlist: { name:
          // 'Core' } }` parses to `{ kind: 'watchlist', name: 'Core' }` — `WWatchlistRef` accepts the
          // name form and the parser tags which kind of reference it read. Every seeded entry must
          // survive; the parser may add to them and may not change one.
          expect(got, `${panel.id}: "${raw}" changed ${key}`).toMatchObject(
            value as Record<string, unknown>,
          );
        } else {
          expect(got, `${panel.id}: "${raw}" changed ${key}`).toEqual(value);
        }
      }
    }
  });
});
