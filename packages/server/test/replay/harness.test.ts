/**
 * `test/replay/harness.test.ts` — the WP-15 acceptance row for the plant session replay:
 * **a session replays bit-identically twice, and an injected change produces exactly one reported
 * divergence** (WORKPLAN L1560, ARCHITECTURE §8.2, FEED-08, QA-02).
 *
 * Both halves are load-bearing and they fail for opposite reasons. Bit-identity is the guarantee
 * itself: if two replays of one recorded store disagree, something in the plant, the conflator or a
 * normaliser is reading the wall clock, a hash order or an unseeded RNG, and every golden in this
 * repository is worth less than it looks. Exactly-one-divergence is what makes the harness *usable*:
 * one changed tick renumbers every later `seq` of that subject and every frame that carries it, so a
 * differ that reports all of them reports several hundred consequences of one cause and the reader
 * has to find the cause by hand again.
 *
 * Two things here are deliberately not assertions about the differ made *with* the differ:
 *
 *  - {@link linesDiffering} compares the two logs by raw text, independently, so "the change
 *    cascaded through 60 records and the differ still reported one, at the first of them" is a claim
 *    checked against something other than the code under test;
 *  - {@link allDivergences} walks the whole disagreement one divergence at a time, patching each
 *    reported record and asking again. That is what distinguishes "reports the FIRST divergence"
 *    from "always reports record 0" and from "misses the rest" — a differ hard-wired to index 0
 *    passes a single-divergence assertion and fails this one.
 *
 * TESTS ARE SELF-SUFFICIENT (WORKPLAN §0.2). Nothing here needs a seeded database: the harness is
 * offline by construction and the five committed sessions are the fixtures. The one database test in
 * the file is the `dq_events` row, which runs inside `withTxDb()` and is rolled back.
 */

import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main as cli, type CliIo } from '../../src/replay/cli.js';
import {
  diffStateLogs,
  diffStateLogTexts,
  parseStateLog,
  recordReplayDiff,
  StateLogError,
  stripIgnoredTimestamps,
  type Divergence,
} from '../../src/replay/diff.js';
import {
  canonical,
  listSessions,
  loadSession,
  replaySession,
  serialiseStateLog,
  sessionsDir,
  SessionError,
  STATE_LOG_VERSION,
  type StateLogRecord,
} from '../../src/replay/harness.js';
import { withTxDb } from '../../src/test/db.js';

/** The five session names TESTING §8 commits to. `aapl-open`/`slow-consumer`/`gap-resync` are withdrawn. */
const SESSIONS = [
  'cboe-aapl-poll',
  'fomc-release',
  'sim-ws-backpressure',
  'sim-ws-burst',
  'sim-ws-resync',
] as const;

/** The three modules of the replay harness, read as text for the determinism audit below. */
const SOURCES = ['harness.ts', 'diff.ts', 'cli.ts'] as const;

function replay(name: string, dir?: string): string {
  return replaySession(loadSession(name, dir), dir === undefined ? {} : { sessionsDir: dir }).text;
}

function expectedText(name: string, dir?: string): string {
  return readFileSync(join(sessionsDir(dir), name, 'expected.ndjson'), 'utf8');
}

/** Raw line-by-line difference count — computed without the differ, on purpose. */
function linesDiffering(a: string, b: string): number[] {
  const left = a.replace(/\n$/, '').split('\n');
  const right = b.replace(/\n$/, '').split('\n');
  const out: number[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) out.push(i);
  }
  return out;
}

/**
 * Every divergence between two logs, found the way a person would: take the first one, accept the
 * actual record for it, ask again. Each returned entry is one invocation's answer.
 */
function allDivergences(expected: string, actual: string, cap = 500): Divergence[] {
  const left = expected.replace(/\n$/, '').split('\n');
  const right = actual.replace(/\n$/, '').split('\n');
  const found: Divergence[] = [];
  for (let i = 0; i < cap; i += 1) {
    const divergence = diffStateLogTexts(left.join('\n') + '\n', right.join('\n') + '\n');
    if (divergence === null) return found;
    found.push(divergence);
    // Accept the actual side of the reported record and ask again. A record that only exists on
    // one side is added or removed so the walk can continue past a length difference.
    if (right[divergence.index] === undefined) left.splice(divergence.index, 1);
    else left[divergence.index] = right[divergence.index]!;
  }
  throw new Error(`more than ${String(cap)} divergences — the walk did not terminate`);
}

/** The state log of `name`, parsed into records the test can edit. */
function records(name: string): Record<string, unknown>[] {
  return expectedText(name)
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function textOf(rows: readonly Record<string, unknown>[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the committed sessions', () => {
  it('are exactly the five names TESTING §8 commits to', () => {
    // A withdrawn name (`aapl-open`, `slow-consumer`, `gap-resync`) creeping back in, or a session
    // added without a plan entry, is caught here rather than in a review.
    expect(listSessions()).toEqual([...SESSIONS]);
  });

  it.each(SESSIONS)('%s declares a provenance row for every value it replays (DATA-10)', (name) => {
    const session = loadSession(name);
    expect(session.definition.provenance.length).toBeGreaterThan(0);
    const declared = new Set(session.definition.provenance.map((row) => row.provenanceId));

    // Every event that produces a value names a declared provenance id. `replaySession` throws when
    // one does not (asserted below); this is the same rule read off the fixture.
    for (const event of session.events) {
      if (event.kind === 'capture' || event.kind === 'publish') {
        expect(declared.has(event.provenanceId), `${name}: ${String(event.tOffsetMs)} ms`).toBe(
          true,
        );
      }
    }
    if (session.definition.feed !== undefined) {
      expect(declared.has(session.definition.feed.provenanceId)).toBe(true);
    }
    // And every declared row points at something: a 64-hex manifest request key for a recorded
    // capture, or the `sim:<seed>:<startMs>` identity of this session's own generated feed.
    for (const row of session.definition.provenance) {
      expect(row.requestKey).toMatch(/^([0-9a-f]{64}|sim:-?\d+:\d+)$/);
    }
  });

  it.each(SESSIONS)('%s says in writing why it exists and how it was produced', (name) => {
    const { notes } = loadSession(name).definition;
    expect(notes.length).toBeGreaterThan(80);
  });
});

describe('bit-identity (FEED-08)', () => {
  it.each(SESSIONS)('%s replays bit-identically twice, and again from a fresh load', (name) => {
    const session = loadSession(name);
    const first = replaySession(session).text;
    const second = replaySession(session).text;
    // Byte for byte, not deep-equal: a state log is a file, and a file that differs is a
    // divergence however equal the objects behind it look.
    expect(second).toBe(first);
    expect(replaySession(loadSession(name)).text).toBe(first);
    expect(first.length).toBeGreaterThan(0);
  });

  it.each(SESSIONS)('%s matches its committed expected.ndjson', (name) => {
    expect(diffStateLogTexts(expectedText(name), replay(name), { session: name })).toBeNull();
  });

  it('the replay path reads no wall clock and no unseeded randomness', () => {
    // Three non-determinism defects in this build passed for a long time before failing, and every
    // one was a platform-clock or iteration-order read. `Date.parse` is allowed: it is a pure
    // function of a string in the session file. Comments are stripped first, because those modules
    // name these very calls in prose to say they do not make them.
    for (const file of SOURCES) {
      const text = readFileSync(join(import.meta.dirname, '../../src/replay', file), 'utf8');
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      const offenders = ['Date.now(', 'Math.random(', 'performance.now(', 'new Date('].filter(
        (needle) => code.includes(needle),
      );
      expect(offenders, `${file} reads a non-deterministic source`).toEqual([]);
    }
  });
});

describe('what the sessions prove about the engine', () => {
  it('cboe-aapl-poll: the second and third polls of one capture are stale-sequence drops (FEED-02)', () => {
    const stats = records('cboe-aapl-poll').find((row) => row.r === 'stats')!;
    const polls = records('cboe-aapl-poll').filter((row) => row.r === 'poll');
    // Three polls of a capture carrying one `seqno`: one new version, two drops. The polls are all
    // real — each one touched `ts.cap` — and nothing was invented from them.
    expect(polls).toHaveLength(3);
    expect(polls.every((poll) => poll.updates === 1)).toBe(true);
    expect(stats.updatesApplied).toBe(1);
    expect(stats.updatesDroppedStaleSeq).toBe(2);
    expect(records('cboe-aapl-poll').filter((row) => row.r === 'change')).toHaveLength(1);
  });

  it('sim-ws-burst: 153 applied changes leave as 4 frames (BUS-03, BUS-04)', () => {
    const rows = records('sim-ws-burst');
    const changes = rows.filter((row) => row.r === 'change');
    const frames = rows.filter((row) => row.r === 'frame');
    expect(changes.length).toBeGreaterThan(100);
    expect(frames.length).toBeLessThan(10);
    // The latest-value guarantee has teeth only if seq really skips: a conflator that emitted every
    // version would produce one frame per change and this ratio would be 1.
    expect(changes.length / frames.length).toBeGreaterThan(10);
  });

  it('fomc-release: three headlines in one window leave as three deltas, in order (NEWS-01)', () => {
    const frames = records('fomc-release').filter((row) => row.r === 'frame');
    const batch = frames[frames.length - 1]!.frame as { t: string; m: Record<string, unknown>[] };
    const news = batch.m.filter((m) => m.s === 'n:feed:econ');
    expect(news.map((m) => m.t)).toEqual(['delta', 'delta', 'delta']);
    expect(news.map((m) => (m.f as Record<string, unknown>).NEWS_ID)).toEqual([9002, 9003, 9004]);
    // A latest-value mask would have kept 9004 and dropped the other two.
    expect(news.map((m) => m.seq)).toEqual([2, 3, 4]);
    expect(news.map((m) => m.prev)).toEqual([1, 2, 3]);
  });

  it('sim-ws-backpressure: every rung of the API.md §6.5 ladder is walked', () => {
    const notices = records('sim-ws-backpressure')
      .filter((row) => row.r === 'frame')
      .map((row) => row.frame as Record<string, unknown>)
      .filter((frame) => frame.t === 'notice')
      .map((frame) => frame.action);
    expect(notices).toEqual([
      'conflation-widened',
      'shed',
      'disconnect-soon',
      'conflation-restored',
    ]);
    const shed = records('sim-ws-backpressure')
      .filter((row) => row.r === 'frame')
      .map((row) => row.frame as Record<string, unknown>)
      .filter((frame) => frame.t === 'status');
    expect(shed.map((frame) => [frame.s, frame.st])).toEqual([['q:3', 'shed']]);
  });

  it('sim-ws-resync: recovery is a fresh snapshot, never replayed deltas (BUS-07)', () => {
    const frames = records('sim-ws-resync')
      .filter((row) => row.r === 'frame')
      .map((row) => row.frame as Record<string, unknown>);
    const resync = frames.findIndex((frame) => frame.t === 'resync');
    expect(resync).toBeGreaterThan(0);
    const members = frames
      .slice(resync + 1)
      .filter((frame) => frame.t === 'batch')
      .flatMap((frame) => frame.m as Record<string, unknown>[]);
    const q1 = members.filter((m) => m.s === 'q:1');
    // The first thing q:1 gets back is a `snap`; a delta would mean the harness replayed a version
    // the client never acknowledged.
    expect(q1[0]?.t).toBe('snap');
    expect(q1.filter((m) => m.t === 'snap')).toHaveLength(1);
  });

  it.each(SESSIONS)("%s keeps every subscriber's prev chain contiguous per subject", (name) => {
    const lastSeq = new Map<string, number>();
    for (const row of records(name)) {
      if (row.r !== 'frame') continue;
      const frame = row.frame as Record<string, unknown>;
      const members = frame.t === 'batch' ? (frame.m as Record<string, unknown>[]) : [frame];
      for (const m of members) {
        if (m.t !== 'delta' && m.t !== 'snap') continue;
        const key = `${String(row.sub)}|${String(m.s)}`;
        if (m.t === 'delta') {
          // `seq` may skip — that IS conflation — but `prev` must be the last seq THIS subscriber
          // was sent for THIS subject, or a client applying frames in order sees a hole.
          expect(m.prev, `${name} ${key}`).toBe(lastSeq.get(key) ?? 0);
        }
        lastSeq.set(key, m.seq as number);
      }
    }
  });
});

describe('the differ reports the first divergence, and only it', () => {
  it('an injected change to one record is reported once, at that record and that path', () => {
    const rows = records('sim-ws-burst');
    const at = rows.findIndex((row) => row.r === 'change' && row.subject === 'q:2');
    expect(at).toBeGreaterThan(0);
    const mutated = [...rows];
    mutated[at] = { ...rows[at]!, seq: (rows[at]!.seq as number) + 1 };

    const divergence = diffStateLogTexts(textOf(rows), textOf(mutated), {
      session: 'sim-ws-burst',
    });
    expect(divergence).not.toBeNull();
    expect(divergence!.index).toBe(at);
    expect(divergence!.path).toBe('/seq');
    expect(divergence!.kind).toBe('change');
    expect(divergence!.subject).toBe('q:2');
    expect(allDivergences(textOf(rows), textOf(mutated))).toHaveLength(1);
  });

  it('a real change to the session input cascades, and is still reported exactly once', () => {
    // The change is real: one subject's opening price moves by 73 cents, which moves its whole
    // simulated path. Nothing about the expected log is edited.
    const dir = mkdtempSync(join(tmpdir(), 'replay-input-'));
    try {
      cpSync(join(sessionsDir(), 'sim-ws-burst'), join(dir, 'sim-ws-burst'), { recursive: true });
      const defPath = join(dir, 'sim-ws-burst', 'subscriptions.json');
      // The feed's rate, halved. Every tick after the first is now due at a different instant, so
      // the cascade is total: 153 change records become 78, every `src` after the first window
      // moves, and every frame carries different values.
      writeFileSync(defPath, readFileSync(defPath, 'utf8').replace('"rateHz": 50', '"rateHz": 25'));

      const actual = replay('sim-ws-burst', dir);
      const differing = linesDiffering(expectedText('sim-ws-burst'), actual);
      // The cascade is the point of the exercise: one changed input, many changed records.
      expect(differing.length).toBeGreaterThan(100);

      const divergence = diffStateLogTexts(expectedText('sim-ws-burst'), actual, {
        session: 'sim-ws-burst',
      });
      expect(divergence).not.toBeNull();
      // Reported ONCE, and at the FIRST record that really differs — not at record 0, and not
      // twenty times.
      expect(divergence!.index).toBe(differing[0]);
      expect(divergence!.kind).toBe('change');
      expect(divergence!.path).toBe('/src');

      // …and asking again after accepting each answer finds the rest, one at a time, always moving
      // forwards and always terminating. Indices are non-DECREASING rather than distinct: the
      // shorter run has 81 records against 159, and each surplus expected record is reported and
      // dropped at the same index in turn, which is the honest way to say "and there are 78 records
      // here that the new run never produced".
      const walk = allDivergences(expectedText('sim-ws-burst'), actual);
      expect(walk.length).toBeGreaterThan(1);
      expect(walk.map((d) => d.index)).toEqual([...walk.map((d) => d.index)].sort((a, b) => a - b));
      expect(walk[0]!.index).toBe(differing[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a changed price shows up inside the frame, because a change record carries field NAMES', () => {
    // ARCHITECTURE §8.2's change log is `(subject, seq, changedFields, ts.src)` — no values. So a
    // price that moves without changing WHICH fields moved is invisible there and shows up in the
    // outbound frame, which is where the value actually reaches a client. Worth pinning: a reader
    // who expected the change record to carry the number would otherwise conclude the differ missed it.
    const dir = mkdtempSync(join(tmpdir(), 'replay-px-'));
    try {
      cpSync(join(sessionsDir(), 'sim-ws-burst'), join(dir, 'sim-ws-burst'), { recursive: true });
      const defPath = join(dir, 'sim-ws-burst', 'subscriptions.json');
      writeFileSync(
        defPath,
        readFileSync(defPath, 'utf8').replace('"px0": 7585.75', '"px0": 7586.48'),
      );

      const actual = replay('sim-ws-burst', dir);
      const differing = linesDiffering(expectedText('sim-ws-burst'), actual);
      expect(differing.length).toBeGreaterThan(1);
      const divergence = diffStateLogTexts(expectedText('sim-ws-burst'), actual);
      expect(divergence?.index).toBe(differing[0]);
      expect(divergence?.kind).toBe('frame');
      expect(divergence?.path).toMatch(/^\/frame\/m\/\d+\/(f|fts)\//);
      expect(allDivergences(expectedText('sim-ws-burst'), actual)).toHaveLength(differing.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('identical logs report nothing', () => {
    expect(
      diffStateLogTexts(expectedText('fomc-release'), expectedText('fomc-release')),
    ).toBeNull();
  });

  it('a missing or extra record at the end is one divergence naming both lengths', () => {
    const rows = records('cboe-aapl-poll');
    const short = diffStateLogTexts(textOf(rows), textOf(rows.slice(0, -1)));
    expect(short?.index).toBe(rows.length - 1);
    expect(short?.detail).toContain('records long');
    const long = diffStateLogTexts(textOf(rows.slice(0, -1)), textOf(rows));
    expect(long?.index).toBe(rows.length - 1);
  });

  it('a format-version change short-circuits to one record-0 divergence', () => {
    const rows = records('cboe-aapl-poll');
    const bumped = [{ ...rows[0]!, version: STATE_LOG_VERSION + 1 }, ...rows.slice(1)];
    // Every later record would also differ if the shape really changed; saying so once is the
    // useful answer.
    const divergence = diffStateLogTexts(textOf(rows), textOf(bumped));
    expect(divergence?.index).toBe(0);
    expect(divergence?.path).toBe('/version');
    expect(divergence?.detail).toContain('re-accepted');
  });
});

describe('ts.cap and ts.pub are ignored, and nothing else is (ARCHITECTURE §8.2)', () => {
  /** Add `delta` ms to every capture/publish instant in a log, leaving `src` alone. */
  function shiftCapturePub(text: string, delta: number): string {
    const walk = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(walk);
      if (value === null || typeof value !== 'object') return value;
      const row = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(row)) {
        out[key] = (key === 'cap' || key === 'pub') && typeof v === 'number' ? v + delta : walk(v);
      }
      return out;
    };
    return (
      text
        .replace(/\n$/, '')
        .split('\n')
        .map((line) => JSON.stringify(walk(JSON.parse(line))))
        .join('\n') + '\n'
    );
  }

  it('a run whose captures and publications happened 5 s later is not a divergence (QA-02)', () => {
    const base = expectedText('cboe-aapl-poll');
    expect(diffStateLogTexts(base, shiftCapturePub(base, 5_000))).toBeNull();
  });

  it('but ts.src is compared, so a source timestamp that moved IS a divergence', () => {
    const rows = records('cboe-aapl-poll');
    const at = rows.findIndex((row) => row.r === 'change');
    const moved = [...rows];
    moved[at] = { ...rows[at]!, src: (rows[at]!.src as number) + 1 };
    expect(diffStateLogTexts(textOf(rows), textOf(moved))?.path).toBe('/src');
  });

  it('and a field value inside a frame is compared', () => {
    const rows = records('cboe-aapl-poll');
    const at = rows.findIndex((row) => row.r === 'frame');
    const frame = structuredClone(rows[at]!);
    const batch = frame.frame as { m: Record<string, unknown>[] };
    (batch.m[0]!.f as Record<string, number>).PX_LAST = 1;
    const moved = [...rows];
    moved[at] = frame;
    const divergence = diffStateLogTexts(textOf(rows), textOf(moved));
    expect(divergence?.path).toBe('/frame/m/0/f/PX_LAST');
    expect(divergence?.actual).toBe(1);
  });

  it('only a full {src,cap,pub} triple is treated as a timestamp', () => {
    // A three-key object that merely has a `cap` key keeps it; the rule keys off the whole shape,
    // so an unrelated payload is never quietly edited.
    expect(stripIgnoredTimestamps({ cap: 1, pub: 2, other: 3 })).toEqual({
      cap: 1,
      pub: 2,
      other: 3,
    });
    expect(stripIgnoredTimestamps({ src: 1, cap: 2, pub: 3 })).toEqual({ src: 1 });
    expect(stripIgnoredTimestamps({ r: 'poll', at: 7 })).toEqual({ r: 'poll', at: 7 });
  });

  it('canonical() sorts keys by code point at every depth', () => {
    expect(JSON.stringify(canonical({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } }))).toBe(
      '{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}',
    );
  });
});

describe('a broken session fails loudly', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'replay-bad-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a session made of `definition` and `events`, then load and replay it. */
  function build(name: string, definition: unknown, events: readonly unknown[]): () => void {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'subscriptions.json'), JSON.stringify(definition, null, 2));
    writeFileSync(
      join(root, 'events.ndjson'),
      events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    );
    return () => {
      replaySession(loadSession(name, dir), { sessionsDir: dir });
    };
  }

  const base = {
    startAt: '2026-09-15T18:41:28.000Z',
    endOffsetMs: 1000,
    notes: 'a deliberately broken session, used only by test/replay/harness.test.ts',
    provenance: [{ provenanceId: 1, sourceId: 'cboe.quotes', requestKey: 'deadbeef' }],
    lines: [],
    subscribers: [
      {
        id: 'grid',
        conflationMs: 250,
        subjects: [{ subject: 'q:1', fields: [], tier: 'delayed' }],
      },
    ],
  };

  it('an empty events.ndjson is an error, not an empty log', () => {
    expect(build('empty', { ...base, name: 'empty' }, [])).toThrow(/holds no events/);
  });

  it('an endOffsetMs before the last event is an error: the tail would never flush', () => {
    expect(
      build('short', { ...base, name: 'short', endOffsetMs: 10 }, [
        {
          kind: 'publish',
          tOffsetMs: 500,
          subject: 'e:X',
          fields: { ECO_VALUE: 1 },
          provenanceId: 1,
          src: null,
        },
      ]),
    ).toThrow(/endOffsetMs 10 is before the last event/);
  });

  it('a directory whose subscriptions.json names another session is an error', () => {
    expect(
      build('renamed', { ...base, name: 'elsewhere' }, [{ kind: 'sim', tOffsetMs: 0 }]),
    ).toThrow(/names "elsewhere" but sits in "renamed"/);
  });

  it('an event naming an undeclared provenance id is an error (DATA-10)', () => {
    expect(
      build('noprov', { ...base, name: 'noprov' }, [
        {
          kind: 'publish',
          tOffsetMs: 0,
          subject: 'e:X',
          fields: { ECO_VALUE: 1 },
          provenanceId: 7,
          src: null,
        },
      ]),
    ).toThrow(/provenanceId 7, which subscriptions.json does not declare/);
  });

  it('a capture whose requestKey is not in the manifest is a hard stop, never a network call', () => {
    expect(
      build('miss', { ...base, name: 'miss' }, [
        {
          kind: 'capture',
          tOffsetMs: 0,
          providerId: 'cboe.quotes',
          requestKey: 'deadbeef',
          provenanceId: 1,
        },
      ]),
    ).toThrow(/no capture 0 for requestKey deadbeef/);
  });

  it('a capture naming a provider that produces no plant update is an error', () => {
    expect(
      build(
        'wrongprovider',
        {
          ...base,
          name: 'wrongprovider',
          provenance: [{ provenanceId: 1, sourceId: 'sec.companyfacts', requestKey: 'deadbeef' }],
        },
        [
          {
            kind: 'capture',
            tOffsetMs: 0,
            providerId: 'sec.companyfacts',
            requestKey: 'deadbeef',
            provenanceId: 1,
          },
        ],
      ),
    ).toThrow(/produces no plant updates/);
  });

  it('a sim event without a feed is an error', () => {
    expect(build('nofeed', { ...base, name: 'nofeed' }, [{ kind: 'sim', tOffsetMs: 0 }])).toThrow(
      /needs a "feed" in subscriptions.json/,
    );
  });

  it('a feed whose provenance key is not its own sim identity is an error (DATA-10)', () => {
    expect(
      build(
        'wrongseed',
        {
          ...base,
          name: 'wrongseed',
          provenance: [{ provenanceId: 1, sourceId: 'internal.derived', requestKey: 'sim:1:2' }],
          feed: {
            seed: 247184634,
            rateHz: 10,
            provenanceId: 1,
            session: 'open',
            subjects: [
              {
                subject: 'q:1',
                instrumentId: 1,
                mdLineId: 1,
                assetClass: 'equity',
                tier: 'delayed',
                px0: 330.27,
                annualVolPct: 22,
                spreadBp: 1,
                avgTradeSize: 100,
                calendarId: 'XNYS',
              },
            ],
          },
        },
        [{ kind: 'sim', tOffsetMs: 0 }],
      ),
    ).toThrow(/the run's identity and its provenance row must agree/);
  });

  it('a subscriber a control event does not name is an error', () => {
    expect(
      build('nosubscriber', { ...base, name: 'nosubscriber' }, [
        { kind: 'buffered', tOffsetMs: 0, subscriber: 'ghost', bytes: 1 },
      ]),
    ).toThrow(/no reference subscriber "ghost"/);
  });

  it('a missing directory and a malformed log are named, not guessed at', () => {
    expect(() => loadSession('not-a-session', dir)).toThrow(SessionError);
    expect(() => parseStateLog('{ not json\n', 'x.ndjson')).toThrow(StateLogError);
    expect(() => parseStateLog('\n\n', 'x.ndjson')).toThrow(/holds no records/);
  });

  it('blank lines in a state log are skipped rather than parsed', () => {
    const rows = records('cboe-aapl-poll');
    expect(parseStateLog(`\n${textOf(rows)}\n`, 'x.ndjson').records).toHaveLength(rows.length);
  });
});

describe('the dq_events row (kind=replay_diff, OPS-03)', () => {
  const t = withTxDb();

  it('is written once per divergence and is idempotent on its key', async () => {
    const divergence = diffStateLogs(
      parseStateLog(expectedText('sim-ws-burst'), 'expected'),
      parseStateLog(
        textOf(
          records('sim-ws-burst').map((row, i) =>
            i === 2 ? { ...row, seq: (row.seq as number) + 1 } : row,
          ),
        ),
        'actual',
      ),
      { session: 'sim-ws-burst' },
    );
    expect(divergence).not.toBeNull();

    const at = new Date('2026-09-15T13:30:01.250Z');
    const first = await recordReplayDiff('sim-ws-burst', divergence!, { tx: t.db, at });
    expect(first).not.toBeNull();

    const rows = await t.db.execute<{
      kind: string;
      severity: string;
      subject: string | null;
      details: Record<string, unknown>;
      ts: Date;
    }>(sql`SELECT kind, severity, subject, details, ts FROM dq_events WHERE dq_id = ${first}`);
    const row = rows.rows[0]!;
    expect(row.kind).toBe('replay_diff');
    // 'error': a session that no longer replays identically blocks a release (QA-02).
    expect(row.severity).toBe('error');
    expect(row.subject).toBe(divergence!.subject ?? null);
    expect(row.details.session).toBe('sim-ws-burst');
    expect(row.details.index).toBe(divergence!.index);
    expect(row.details.path).toBe(divergence!.path);
    expect(row.details.key).toBe(`sim-ws-burst:${String(divergence!.index)}:${divergence!.path}`);
    expect(new Date(row.ts).toISOString()).toBe(at.toISOString());

    // A differ run in a loop against an unfixed regression opens one row, not one per run.
    expect(await recordReplayDiff('sim-ws-burst', divergence!, { tx: t.db, at })).toBeNull();
    const count = await t.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM dq_events WHERE kind = 'replay_diff'
          AND details->>'key' = ${`sim-ws-burst:${String(divergence!.index)}:${divergence!.path}`}`,
    );
    expect(count.rows[0]?.n).toBe('1');
  });
});

describe('the CLI (npm run replay:run / replay:diff)', () => {
  function io(): CliIo & { out: (t: string) => void; text: () => string } {
    const chunks: string[] = [];
    return {
      out: (text: string) => chunks.push(text),
      err: (text: string) => chunks.push(text),
      text: () => chunks.join(''),
    };
  }

  it('diff --all exits 0 when every session is identical', async () => {
    const sink = io();
    expect(await cli(['diff', '--all'], { io: sink })).toBe(0);
    for (const name of SESSIONS) expect(sink.text()).toContain(`${name}: identical`);
  });

  it('diff exits 1 and prints the divergence when a session changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-cli-'));
    try {
      cpSync(join(sessionsDir(), 'fomc-release'), join(dir, 'fomc-release'), { recursive: true });
      const path = join(dir, 'fomc-release', 'events.ndjson');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace('"ECO_VALUE":4.0', '"ECO_VALUE":4.25'),
      );

      const sink = io();
      const written: [string, Divergence][] = [];
      const code = await cli(['diff', '--session', 'fomc-release', '--dq'], {
        io: sink,
        sessionsDir: dir,
        writeDq: (session, divergence) => {
          written.push([session, divergence]);
          return Promise.resolve(4242);
        },
      });
      expect(code).toBe(1);
      expect(sink.text()).toContain('replay divergence at record');
      expect(sink.text()).toContain('ECO_VALUE');
      expect(sink.text()).toContain("dq_events row 4242 (kind='replay_diff')");
      expect(written).toHaveLength(1);
      expect(written[0]![0]).toBe('fomc-release');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('run writes actual.ndjson, and --accept writes expected.ndjson', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-run-'));
    try {
      cpSync(join(sessionsDir(), 'cboe-aapl-poll'), join(dir, 'cboe-aapl-poll'), {
        recursive: true,
      });
      rmSync(join(dir, 'cboe-aapl-poll', 'expected.ndjson'));

      // Without an accepted log, diff cannot say anything and must not pretend it can.
      const before = io();
      expect(
        await cli(['diff', '--session', 'cboe-aapl-poll'], { io: before, sessionsDir: dir }),
      ).toBe(2);
      expect(before.text()).toContain('--accept');

      expect(
        await cli(['run', '--session', 'cboe-aapl-poll'], { io: io(), sessionsDir: dir }),
      ).toBe(0);
      const actual = readFileSync(join(dir, 'cboe-aapl-poll', 'actual.ndjson'), 'utf8');
      expect(actual).toBe(expectedText('cboe-aapl-poll'));

      expect(
        await cli(['run', '--session', 'cboe-aapl-poll', '--accept'], {
          io: io(),
          sessionsDir: dir,
        }),
      ).toBe(0);
      expect(readFileSync(join(dir, 'cboe-aapl-poll', 'expected.ndjson'), 'utf8')).toBe(actual);
      expect(
        await cli(['diff', '--session', 'cboe-aapl-poll'], { io: io(), sessionsDir: dir }),
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names actual.ndjson as scratch, and .gitignore keeps it out of the tree', async () => {
    // `replay:run` writes beside the golden it will be compared against, which is the one place
    // `replay:diff --actual` looks. That is defensible only if the file is visibly not a golden and
    // never reaches a commit — an `actual.ndjson` sitting in a committed session directory is one
    // mistyped `--accept` away from BEING the golden. Both halves are asserted, because the comment
    // that says so is not enforcement.
    const dir = mkdtempSync(join(tmpdir(), 'replay-scratch-'));
    try {
      cpSync(join(sessionsDir(), 'cboe-aapl-poll'), join(dir, 'cboe-aapl-poll'), {
        recursive: true,
      });
      const scratch = io();
      expect(await cli(['run', '--session', 'cboe-aapl-poll'], { io: scratch, sessionsDir: dir })).toBe(0);
      expect(scratch.text()).toContain('actual.ndjson (scratch)');
      expect(scratch.text()).not.toContain('(golden)');

      const golden = io();
      expect(
        await cli(['run', '--session', 'cboe-aapl-poll', '--accept'], {
          io: golden,
          sessionsDir: dir,
        }),
      ).toBe(0);
      expect(golden.text()).toContain('expected.ndjson (golden)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // `fixtures/sessions` → the repository root, which is where `.gitignore` lives.
    const ignore = readFileSync(join(sessionsDir(), '..', '..', '.gitignore'), 'utf8');
    expect(
      ignore,
      '.gitignore must ignore the replay scratch log, or an ordinary `npm run replay:run` dirties ' +
        'every committed session directory it touches',
    ).toContain('fixtures/sessions/*/actual.ndjson');
  });

  it('refuses a usage it cannot honour rather than ignoring the flag', async () => {
    const speed = io();
    expect(
      await cli(['run', '--session', 'cboe-aapl-poll', '--speed', 'realtime'], { io: speed }),
    ).toBe(2);
    expect(speed.text()).toContain('VirtualClock');

    const noSession = io();
    expect(await cli(['diff'], { io: noSession })).toBe(2);
    expect(noSession.text()).toContain('--session');

    expect(await cli(['run', '--session', 'cboe-aapl-poll', '--dq'], { io: io() })).toBe(2);
    expect(await cli(['diff', '--session', 'cboe-aapl-poll', '--accept'], { io: io() })).toBe(2);
    expect(await cli(['sprint'], { io: io() })).toBe(2);
    expect(await cli([], { io: io() })).toBe(2);
    expect(await cli(['run', '--session'], { io: io() })).toBe(2);
    expect(await cli(['run', '--nope'], { io: io() })).toBe(2);
  });

  it('--speed max is accepted, because ARCHITECTURE §8.2 spells the invocation that way', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-speed-'));
    try {
      cpSync(join(sessionsDir(), 'cboe-aapl-poll'), join(dir, 'cboe-aapl-poll'), {
        recursive: true,
      });
      expect(
        await cli(['run', '--session', 'cboe-aapl-poll', '--speed', 'max', '--out', 'out.ndjson'], {
          io: io(),
          sessionsDir: dir,
        }),
      ).toBe(0);
      expect(readFileSync(join(dir, 'cboe-aapl-poll', 'out.ndjson'), 'utf8')).toBe(
        expectedText('cboe-aapl-poll'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('serialiseStateLog', () => {
  it('is one canonical JSON object per line with a trailing newline', () => {
    const rows: StateLogRecord[] = [
      {
        r: 'poll',
        at: 2,
        providerId: 'p',
        requestKey: 'k',
        captureIndex: 0,
        updates: 1,
        problems: [],
      },
    ];
    expect(serialiseStateLog(rows)).toBe(
      '{"at":2,"captureIndex":0,"problems":[],"providerId":"p","r":"poll","requestKey":"k","updates":1}\n',
    );
  });
});
