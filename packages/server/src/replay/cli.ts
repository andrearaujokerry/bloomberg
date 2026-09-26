/**
 * `replay/cli.ts` — `npm run replay:run` and `npm run replay:diff` (ARCHITECTURE §8.2 L1083-1088).
 *
 * Two subcommands, and the script names in `package.json` already point here, so they are fixed:
 *
 *   npm run replay:run  -- --session cboe-aapl-poll --speed max
 *   npm run replay:run  -- --all
 *   npm run replay:run  -- --session sim-ws-burst --accept
 *   npm run replay:diff -- --session cboe-aapl-poll
 *   npm run replay:diff -- --all --dq
 *
 * `run` replays a session and writes `actual.ndjson` beside it; with `--accept` it writes
 * `expected.ndjson` instead, which is the golden-update protocol for a session and is therefore
 * never the default — a golden that updates itself proves nothing.
 *
 * **`actual.ndjson` is scratch, and `.gitignore` says so** — the ignore rule names it under every
 * session directory. It is written inside the session directory because that is where
 * `replay:diff --actual <file>` looks for it, which is the only reason a writable file sits next to
 * a golden at all; nothing else reads it, and `--accept` is the one path that writes the golden. `diff` replays the session (or
 * reads an `actual.ndjson` already on disk with `--actual`) and prints the **first** divergence
 * against `expected.ndjson`, exiting non-zero on it.
 *
 * Exit codes: `0` agreement, `1` a divergence, `2` a usage error or a broken session. The three are
 * distinct because CI has to tell "the engine changed" from "the invocation was wrong".
 *
 * `--dq` is opt-in for the same reason the `dq_events` write lives in `diff.ts` rather than in the
 * comparison: a developer diffing a session on a laptop has no reason to need Postgres, and a CI
 * job that wants the finding recorded says so.
 *
 * Output goes through an injected writer rather than `console`, so `harness.test.ts` can assert what
 * the command printed without capturing a global — and so that nothing in `packages/server/src`
 * writes to a stream it does not own.
 */

import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  diffStateLogs,
  formatDivergence,
  parseStateLog,
  recordReplayDiff,
  StateLogError,
  type Divergence,
} from './diff.js';
import {
  listSessions,
  loadSession,
  readStateLogText,
  replaySession,
  SessionError,
  writeStateLog,
  type LoadedSession,
  type ReplayOptions,
} from './harness.js';

/** The default file names inside a session directory. */
export const ACTUAL_LOG = 'actual.ndjson';
export const EXPECTED_LOG = 'expected.ndjson';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const streamIo: CliIo = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

export interface CliOptions extends ReplayOptions {
  io?: CliIo;
  /** Injected so a test can assert the `dq_events` write without opening its own connection. */
  writeDq?: (session: string, divergence: Divergence) => Promise<number | null>;
}

const USAGE = `usage:
  replay:run  --session <name> | --all  [--speed max] [--out <file>] [--accept]
  replay:diff --session <name> | --all  [--expected <file>] [--actual <file>] [--dq]

  --session <name>   a directory under fixtures/sessions/
  --all              every committed session, in name order
  --speed max        accepted for ARCHITECTURE §8.2's spelling; the clock is virtual, so there is
                     no other speed and any other value is refused rather than ignored
  --accept           replay:run only: write expected.ndjson (the golden-update protocol)
  --out <file>       replay:run only: the file name to write inside the session directory
  --expected <file>  replay:diff only: the accepted log to compare against
  --actual <file>    replay:diff only: compare this file on disk instead of replaying
  --dq               replay:diff only: also write the dq_events row (kind='replay_diff')
`;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

interface Args {
  sessions: string[];
  all: boolean;
  accept: boolean;
  dq: boolean;
  out?: string;
  expected?: string;
  actual?: string;
}

/** One flag's value, which may not be another flag — a swallowed flag is a silent wrong run. */
function valueOf(argv: readonly string[], at: number, flag: string): string {
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`${flag} needs a value`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { sessions: [], all: false, accept: false, dq: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--session':
      case '-s':
        args.sessions.push(valueOf(argv, i, arg));
        i += 1;
        break;
      case '--all':
        args.all = true;
        break;
      case '--accept':
        args.accept = true;
        break;
      case '--dq':
        args.dq = true;
        break;
      case '--out':
        args.out = valueOf(argv, i, arg);
        i += 1;
        break;
      case '--expected':
        args.expected = valueOf(argv, i, arg);
        i += 1;
        break;
      case '--actual':
        args.actual = valueOf(argv, i, arg);
        i += 1;
        break;
      case '--speed': {
        const speed = valueOf(argv, i, arg);
        if (speed !== 'max') {
          throw new UsageError(
            `--speed ${speed} is not available: the harness runs on a VirtualClock, so a session ` +
              'replays as fast as the process can compute it and "max" is the only speed there is',
          );
        }
        i += 1;
        break;
      }
      default:
        throw new UsageError(`unknown argument ${arg}`);
    }
  }
  return args;
}

/** The sessions a command was asked to act on, in a fixed order. */
function selected(args: Args, options: CliOptions): string[] {
  const names = args.all ? listSessions(options.sessionsDir) : args.sessions;
  if (names.length === 0) {
    throw new UsageError(
      args.all ? 'fixtures/sessions holds no sessions' : 'name a session with --session, or --all',
    );
  }
  const unique = [...new Set(names)];
  return args.all ? unique : unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function loadOne(name: string, options: CliOptions): LoadedSession {
  return loadSession(name, options.sessionsDir);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// run
// ─────────────────────────────────────────────────────────────────────────────────────────────

function runCommand(args: Args, options: CliOptions, io: CliIo): number {
  if (args.dq) throw new UsageError('--dq belongs to replay:diff, not replay:run');
  const fileName = args.out ?? (args.accept ? EXPECTED_LOG : ACTUAL_LOG);
  for (const name of selected(args, options)) {
    const session = loadOne(name, options);
    const result = replaySession(session, options);
    const path = writeStateLog(session, fileName, result.records);
    const counts = result.records.reduce<Record<string, number>>((acc, record) => {
      acc[record.r] = (acc[record.r] ?? 0) + 1;
      return acc;
    }, {});
    const summary = Object.keys(counts)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((kind) => `${String(counts[kind])} ${kind}`)
      .join(', ');
    // The `(scratch)` tag is not decoration: it is the line a developer sees after an ordinary
    // `replay:run`, and it has to say that the file it just wrote beside the golden is not one.
    const kind = fileName === EXPECTED_LOG ? 'golden' : 'scratch';
    io.out(`${name} → ${basename(path)} (${kind})  (${summary})\n`);
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// diff
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function diffCommand(args: Args, options: CliOptions, io: CliIo): Promise<number> {
  if (args.accept) throw new UsageError('--accept belongs to replay:run, not replay:diff');
  const expectedName = args.expected ?? EXPECTED_LOG;
  let worst = 0;

  for (const name of selected(args, options)) {
    const session = loadOne(name, options);
    const expectedText = readStateLogText(session, expectedName);
    if (expectedText === null) {
      io.err(
        `${name}: no ${expectedName} — run "npm run replay:run -- --session ${name} --accept" once ` +
          'you have read the log and agree it is right\n',
      );
      worst = Math.max(worst, 2);
      continue;
    }

    let actualText: string;
    if (args.actual === undefined) {
      actualText = replaySession(session, options).text;
    } else {
      const onDisk = readStateLogText(session, args.actual);
      if (onDisk === null) {
        io.err(`${name}: no ${args.actual} in ${session.dir}\n`);
        worst = Math.max(worst, 2);
        continue;
      }
      actualText = onDisk;
    }

    const divergence = diffStateLogs(
      parseStateLog(expectedText, `${name}/${expectedName}`),
      parseStateLog(
        actualText,
        args.actual === undefined ? `${name} (replayed)` : `${name}/${args.actual}`,
      ),
      { session: name },
    );
    if (divergence === null) {
      io.out(`${name}: identical\n`);
      continue;
    }
    io.err(`${formatDivergence(divergence)}\n`);
    worst = Math.max(worst, 1);
    if (args.dq) {
      const write = options.writeDq ?? ((s, d) => recordReplayDiff(s, d));
      const dqId = await write(name, divergence);
      io.err(
        dqId === null
          ? `${name}: dq_events already holds an unresolved replay_diff row for this divergence\n`
          : `${name}: dq_events row ${String(dqId)} (kind='replay_diff')\n`,
      );
    }
  }
  return worst;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Run the CLI. Returns the process exit code instead of calling `process.exit`, so the whole command
 * is testable in-process (`0` identical, `1` a divergence, `2` a usage error).
 */
export async function main(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const io = options.io ?? streamIo;
  const command = argv[0];
  try {
    const args = parseArgs(argv.slice(1));
    if (command === 'run') return runCommand(args, options, io);
    // `await`, not a bare `return`: a UsageError thrown inside the async command would
    // otherwise reject the returned promise instead of reaching this try's catch.
    if (command === 'diff') return await diffCommand(args, options, io);
    throw new UsageError(
      command === undefined ? 'name a subcommand: run or diff' : `unknown subcommand ${command}`,
    );
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    if (err instanceof SessionError || err instanceof StateLogError) {
      io.err(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`replay failed: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exitCode = 2;
    });
}
