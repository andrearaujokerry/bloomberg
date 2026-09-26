/**
 * `replay/diff.ts` — the state-log differ (ARCHITECTURE §8.2 L1087-1091, FEED-08, QA-02).
 *
 * Two state logs (`expected.ndjson` from the last accepted run, `actual.ndjson` from this one) go
 * in; **the first divergence** comes out, or `null`. One, not twenty.
 *
 * That is the whole design and it is not laziness. A differ that walks both logs to the end and
 * reports every mismatch reports the *consequences* of one changed tick: a single price that moves
 * changes the `seq` of every later version of that subject, every frame that carries it, the
 * conflator's `prev` chain and the footer's counts, so a one-line cause arrives as several hundred
 * lines of effect and the reader has to find the cause again by hand. The first divergence, in
 * timeline order, with the record index, the JSON path and both values, is the cause. Everything
 * after it is unknown until the cause is understood, which is also why `replay:diff` exits non-zero
 * on it rather than continuing.
 *
 * **What is ignored.** `ts.cap` and `ts.pub` (§8.2), wherever they appear: on a `change` record as
 * `cap`/`pub`, and inside any `{ src, cap, pub }` timestamp triple in a WS frame. `cap` is when a
 * *capture* happened and `pub` is when the plant published it; comparing a release candidate
 * against the previous release on the same session (QA-02) must not fail because the two runs were
 * started at different instants. Everything else — every `seq`, every changed-field list, every
 * field value, every `prev`, every frame in every order — is compared exactly.
 *
 * **The `dq_events` row.** A divergence is a data-quality finding, so it is written to
 * `dq_events` with `kind='replay_diff'` through `observability/dq.ts#raiseDq` (the CHECK list of
 * migration 0014 already carries that kind). The write is separate from the comparison and takes
 * the transaction from the caller, because the differ itself must stay usable with no database at
 * all: `npm run replay:diff` is something a developer runs offline, and a differ that could not
 * report without Postgres would be useless in the one situation it exists for.
 */

import { raiseDq, type DqOptions } from '../observability/dq.js';

import { canonical, STATE_LOG_VERSION, type StateLogRecord } from './harness.js';

/** Where the two logs first disagree. */
export interface Divergence {
  /** Zero-based record index in the log — line `index + 1` of the file. */
  index: number;
  /**
   * JSON path inside the record, `/`-separated from the record root (`/seq`, `/frame/m/0/f/PX_LAST`),
   * or `''` when the whole record is missing on one side.
   */
  path: string;
  expected: unknown;
  actual: unknown;
  /** `r` of the diverging record, from whichever side has one. */
  kind: string;
  /** The subject the record is about, when it names one — the first thing a reader wants. */
  subject?: string;
  /** The version the record is about, when it names one. */
  seq?: number;
  /** One line, ready to print. */
  detail: string;
}

/** A parsed state log: the records, and the text they came from. */
export interface ParsedStateLog {
  records: unknown[];
}

export class StateLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateLogError';
  }
}

/** Parse NDJSON into records. Blank lines are skipped; anything else invalid is an error. */
export function parseStateLog(text: string, label: string): ParsedStateLog {
  const records: unknown[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      throw new StateLogError(
        `${label}:${String(i + 1)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (records.length === 0) throw new StateLogError(`${label} holds no records`);
  return { records };
}

/**
 * Drop `ts.cap` / `ts.pub` from one record.
 *
 * Two shapes carry them. A `change` record carries `cap` and `pub` at its top level, beside the
 * `src` that §8.2 *does* compare. A WS frame carries a `{ src, cap, pub }` triple under `ts` at any
 * depth (`Ts` in `sdk/wire/ws.ts`), including inside each member of a `batch`. The triple is
 * recognised by its own three keys rather than by the property name it hangs off, so a future frame
 * that carries a timestamp under another name is still handled — and an unrelated object that
 * happens to have a `cap` key is not touched, because it will not have all three.
 */
export function stripIgnoredTimestamps(record: unknown): unknown {
  if (Array.isArray(record)) return record.map(stripIgnoredTimestamps);
  if (record === null || typeof record !== 'object') return record;
  const source = record as Record<string, unknown>;

  const isTimestampTriple =
    Object.keys(source).length === 3 &&
    'src' in source &&
    'cap' in source &&
    'pub' in source &&
    (typeof source.src === 'number' || source.src === null) &&
    typeof source.cap === 'number' &&
    typeof source.pub === 'number';
  if (isTimestampTriple) return { src: source.src };

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (source.r === 'change' && (key === 'cap' || key === 'pub')) continue;
    out[key] = stripIgnoredTimestamps(source[key]);
  }
  return out;
}

function shortValue(value: unknown): string {
  if (value === undefined) return '<absent>';
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length <= 120 ? text : `${text.slice(0, 117)}…`;
}

function recordKind(expected: unknown, actual: unknown): string {
  for (const side of [expected, actual]) {
    if (side !== null && typeof side === 'object' && 'r' in side) {
      const r = (side as Record<string, unknown>).r;
      if (typeof r === 'string') return r;
    }
  }
  return '?';
}

function stringField(record: unknown, key: string): string | undefined {
  if (record === null || typeof record !== 'object') return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: unknown, key: string): number | undefined {
  if (record === null || typeof record !== 'object') return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * The first path at which two canonical values differ, or `null`.
 *
 * Depth-first in sorted key order, which is the order {@link canonical} has already put the objects
 * in — so "first" is a stable property of the two values and not of how either was built.
 */
function firstPathDiff(
  expected: unknown,
  actual: unknown,
  path: string,
): { path: string; expected: unknown; actual: unknown } | null {
  if (Object.is(expected, actual)) return null;

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const shared = Math.min(expected.length, actual.length);
    for (let i = 0; i < shared; i += 1) {
      const found = firstPathDiff(expected[i], actual[i], `${path}/${String(i)}`);
      if (found !== null) return found;
    }
    if (expected.length !== actual.length) {
      const i = shared;
      return {
        path: `${path}/${String(i)}`,
        expected: expected[i],
        actual: actual[i],
      };
    }
    return null;
  }

  const bothObjects =
    expected !== null &&
    actual !== null &&
    typeof expected === 'object' &&
    typeof actual === 'object' &&
    !Array.isArray(expected) &&
    !Array.isArray(actual);
  if (bothObjects) {
    const a = expected as Record<string, unknown>;
    const b = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) =>
      x < y ? -1 : x > y ? 1 : 0,
    );
    for (const key of keys) {
      const found = firstPathDiff(a[key], b[key], `${path}/${key}`);
      if (found !== null) return found;
    }
    return null;
  }

  return { path, expected, actual };
}

export interface DiffOptions {
  /** Session name, used only in the printed detail. */
  session?: string;
}

/**
 * Compare two state logs and return **the first** divergence, or `null` when they agree.
 *
 * A format-version mismatch in the header short-circuits everything else: comparing a v1 log
 * against a v2 log record by record would produce a divergence per record, all of them saying the
 * same thing.
 */
export function diffStateLogs(
  expected: ParsedStateLog,
  actual: ParsedStateLog,
  options: DiffOptions = {},
): Divergence | null {
  const where = options.session === undefined ? '' : `${options.session}: `;

  const expectedVersion = numberField(expected.records[0], 'version');
  const actualVersion = numberField(actual.records[0], 'version');
  if (expectedVersion !== actualVersion) {
    return {
      index: 0,
      path: '/version',
      expected: expectedVersion,
      actual: actualVersion,
      kind: 'session',
      detail:
        `${where}state-log format version ${shortValue(expectedVersion)} → ${shortValue(actualVersion)} ` +
        `(this build writes ${String(STATE_LOG_VERSION)}): the log SHAPE changed, so the sessions ` +
        'must be re-accepted rather than investigated',
    };
  }

  const shared = Math.min(expected.records.length, actual.records.length);
  for (let i = 0; i < shared; i += 1) {
    const a = stripIgnoredTimestamps(canonical(expected.records[i]));
    const b = stripIgnoredTimestamps(canonical(actual.records[i]));
    const found = firstPathDiff(a, b, '');
    if (found === null) continue;
    const kind = recordKind(expected.records[i], actual.records[i]);
    const subject =
      stringField(expected.records[i], 'subject') ?? stringField(actual.records[i], 'subject');
    const seq = numberField(expected.records[i], 'seq') ?? numberField(actual.records[i], 'seq');
    return {
      index: i,
      path: found.path,
      expected: found.expected,
      actual: found.actual,
      kind,
      ...(subject === undefined ? {} : { subject }),
      ...(seq === undefined ? {} : { seq }),
      detail:
        `${where}record ${String(i)} (${kind}` +
        `${subject === undefined ? '' : ` ${subject}`}` +
        `${seq === undefined ? '' : ` seq ${String(seq)}`}) ` +
        `diverges at ${found.path === '' ? '/' : found.path}: expected ${shortValue(found.expected)}, ` +
        `got ${shortValue(found.actual)}`,
    };
  }

  if (expected.records.length !== actual.records.length) {
    const i = shared;
    const kind = recordKind(expected.records[i], actual.records[i]);
    const longer = actual.records.length > expected.records.length ? 'actual' : 'expected';
    return {
      index: i,
      path: '',
      expected: expected.records[i],
      actual: actual.records[i],
      kind,
      detail:
        `${where}the logs are ${String(expected.records.length)} and ${String(actual.records.length)} ` +
        `records long; the ${longer} log has an extra record at ${String(i)} (${kind})`,
    };
  }

  return null;
}

/** The printed block `replay:diff` writes to stdout. */
export function formatDivergence(divergence: Divergence): string {
  const lines = [
    `replay divergence at record ${String(divergence.index)} (line ${String(divergence.index + 1)})`,
    `  record   ${divergence.kind}`,
  ];
  if (divergence.subject !== undefined) lines.push(`  subject  ${divergence.subject}`);
  if (divergence.seq !== undefined) lines.push(`  seq      ${String(divergence.seq)}`);
  lines.push(
    `  path     ${divergence.path === '' ? '<whole record>' : divergence.path}`,
    `  expected ${shortValue(divergence.expected)}`,
    `  actual   ${shortValue(divergence.actual)}`,
    '',
    divergence.detail,
  );
  return lines.join('\n');
}

/**
 * Write the `dq_events` row for a divergence (`kind='replay_diff'`, OPS-03).
 *
 * `severity` is `'error'`: a session that no longer replays identically means either the engine
 * changed or the harness lost determinism, and both block a release (QA-02). The idempotency key is
 * `<session>:<index>:<path>`, so a differ run in a loop against an unfixed regression opens one row
 * rather than one per run.
 *
 * @param at the virtual instant the replay ran at, so the row carries the run's own time rather
 *           than the moment somebody happened to look at it.
 * @returns the new `dq_id`, or `null` when an unresolved row for the same key already exists.
 */
export async function recordReplayDiff(
  session: string,
  divergence: Divergence,
  options?: DqOptions & { at?: Date },
): Promise<number | null> {
  const details: Record<string, unknown> = {
    session,
    index: divergence.index,
    path: divergence.path,
    record: divergence.kind,
    expected: divergence.expected ?? null,
    actual: divergence.actual ?? null,
    detail: divergence.detail,
  };
  if (divergence.seq !== undefined) details.seq = divergence.seq;
  return raiseDq(
    {
      kind: 'replay_diff',
      severity: 'error',
      ...(divergence.subject === undefined ? {} : { subject: divergence.subject }),
      details,
      key: `${session}:${String(divergence.index)}:${divergence.path}`,
      ...(options?.at === undefined ? {} : { ts: options.at }),
    },
    options?.tx === undefined ? undefined : { tx: options.tx },
  );
}

/** Convenience for a caller holding two texts: parse both, diff, return the first divergence. */
export function diffStateLogTexts(
  expectedText: string,
  actualText: string,
  options: DiffOptions & { expectedLabel?: string; actualLabel?: string } = {},
): Divergence | null {
  const expected = parseStateLog(expectedText, options.expectedLabel ?? 'expected.ndjson');
  const actual = parseStateLog(actualText, options.actualLabel ?? 'actual.ndjson');
  return diffStateLogs(expected, actual, options);
}

/** Re-exported so `cli.ts` and the tests have one import for the log shape. */
export type { StateLogRecord };
