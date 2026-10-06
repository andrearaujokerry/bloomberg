/**
 * scripts/create-user.ts — create a real account, the way a deployment's first account is made.
 *
 *   npx tsx scripts/create-user.ts --email you@example.com --name "Your Name" --firm "Demo Capital"
 *   npx tsx scripts/create-user.ts ... --role admin          # user (default) | admin | compliance | …
 *   npx tsx scripts/create-user.ts ... --no-mfa              # password only — NOT for a public site
 *   npx tsx scripts/create-user.ts ... --url postgresql://…  # else DATABASE_URL, as migrate.ts
 *
 * The password is PROMPTED FOR, twice, with nothing echoed — never an argument, which would land in
 * shell history and in `ps` output for anyone on the host. When stdin is not a terminal (a CI job),
 * it is read from `CREATE_USER_PASSWORD` instead; that is still an environment variable, so set it
 * from a secret store and only for the one command.
 *
 * ## Why this exists
 *
 * There is no sign-up, by design: SEC-01 makes an account one natural person, onboarded by someone
 * accountable. The seeded accounts all share one fixture password and use `@demo.terminal`
 * addresses that cannot receive mail, so on a deployed site they must not exist (docs/DEPLOYMENT.md
 * §5) — and then the first real account has to come from somewhere. This is that somewhere.
 *
 * ## What it guarantees about the account it makes
 *
 *   * **A second factor by default.** `mfa_required = true` unless `--no-mfa` is passed, so a new
 *     account signs in with its password AND a code mailed to its address.
 *   * **A firm that already exists.** Entitlements attach to a firm or a user
 *     (`entitlement_grants.subject_kind`), and the seed's `Demo Capital` carries a firm-wide
 *     delayed-tier grant. Creating a firm here would make an account that signs in to a terminal
 *     where every value is denied — worse than refusing — so an unknown firm is an error.
 *   * **The production hashing path.** The password goes through `http/auth/password.ts#setPassword`
 *     — pgcrypto bcrypt, cost 12 — the same function the server uses, not a copy of it.
 *   * **Atomic.** The user row and the credential are one transaction: no account without a
 *     password, no password without an account.
 */

import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { setPassword } from '../packages/server/src/http/auth/password.js';
import { databaseUrlFromArgv, loadDotEnv } from './migrate.js';

const ROLES = ['user', 'admin', 'compliance', 'dataops', 'helpdesk', 'newsroom'] as const;
type Role = (typeof ROLES)[number];

/** Longer than the wire's minimum of 8: this makes a real account on a public site. */
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 256;

export interface CreateUserArgs {
  email: string;
  name: string;
  firm: string;
  role: Role;
  mfa: boolean;
}

/** Parse argv. Throws with a message a person can act on; never echoes a password (there is none). */
export function parseCreateUserArgs(argv: readonly string[]): CreateUserArgs {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    if (at === -1) return undefined;
    const v = argv[at + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  if (argv.includes('--password')) {
    throw new Error('--password is not accepted: it would be kept in shell history. You will be prompted.');
  }
  const email = value('--email');
  const name = value('--name');
  const firm = value('--firm');
  if (email === undefined || name === undefined || firm === undefined) {
    throw new Error('usage: create-user --email <address> --name "<display name>" --firm <id or name> [--role user] [--no-mfa]');
  }
  // Deliberately loose: the address is validated by delivering a code to it, which is the only
  // test of an address that means anything. This only stops an obvious slip.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`--email: '${email}' is not an address`);
  const role = (value('--role') ?? 'user') as Role;
  if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}`);
  return { email, name, firm, role, mfa: !argv.includes('--no-mfa') };
}

/** Why a password is refused, or `null`. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `at least ${String(MIN_PASSWORD)} characters`;
  if (password.length > MAX_PASSWORD) return `at most ${String(MAX_PASSWORD)} characters`;
  if (password.trim() !== password) return 'no leading or trailing spaces (they are too easy to lose)';
  return null;
}

/** Read one line from the terminal with nothing echoed. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolvePrompt, reject) => {
    stdout.write(question);
    let input = '';
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolvePrompt(input);
          return;
        }
        if (ch === '\u0003') {
          // Ctrl-C: restore the terminal before leaving, or the shell is left in raw mode.
          stdin.setRawMode(false);
          stdout.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') input = input.slice(0, -1);
        else input += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function readPassword(): Promise<string> {
  if (!stdin.isTTY) {
    const fromEnv = process.env.CREATE_USER_PASSWORD;
    if (fromEnv === undefined || fromEnv === '') {
      throw new Error('stdin is not a terminal and CREATE_USER_PASSWORD is not set');
    }
    return fromEnv;
  }
  const first = await promptHidden('Password: ');
  const problem = passwordProblem(first);
  if (problem !== null) throw new Error(`password refused: ${problem}`);
  const second = await promptHidden('Again:    ');
  if (first !== second) throw new Error('the two passwords differ');
  return first;
}

async function main(): Promise<void> {
  loadDotEnv();
  const argv = process.argv.slice(2);
  const args = parseCreateUserArgs(argv);
  const url = databaseUrlFromArgv(argv);
  const password = await readPassword();
  const problem = passwordProblem(password);
  if (problem !== null) throw new Error(`password refused: ${problem}`);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    const firm = await client.query<{ firm_id: string; name: string }>(
      /^\d+$/.test(args.firm)
        ? 'SELECT firm_id, name FROM firms WHERE firm_id = $1'
        : 'SELECT firm_id, name FROM firms WHERE name = $1',
      [args.firm],
    );
    const found = firm.rows[0];
    if (found === undefined) {
      const known = await client.query<{ name: string }>('SELECT name FROM firms ORDER BY firm_id');
      throw new Error(
        `no firm '${args.firm}'. Known: ${known.rows.map((r) => r.name).join(', ') || '(none — run the seed first)'}`,
      );
    }
    const taken = await client.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [args.email]);
    if (taken.rowCount !== 0) throw new Error(`an account for ${args.email} already exists`);

    const inserted = await client.query<{ user_id: string }>(
      `INSERT INTO users (firm_id, email, display_name, role, status, mfa_required)
       VALUES ($1, $2, $3, $4, 'active', $5) RETURNING user_id`,
      [Number(found.firm_id), args.email, args.name, args.role, args.mfa],
    );
    const userId = Number(inserted.rows[0]!.user_id);
    await setPassword(drizzle(client), userId, password);
    await client.query('COMMIT');

    stdout.write(
      [
        `created user ${String(userId)}: ${args.email} (${args.role}) in ${found.name}`,
        args.mfa
          ? 'second factor: an emailed code at every sign-in — the server needs EMAIL_TRANSPORT set'
          : 'second factor: NONE (--no-mfa). Do not use this on a public site.',
        '',
      ].join('\n'),
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`create-user failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
