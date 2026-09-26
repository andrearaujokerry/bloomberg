// WP-15 part 2 — the session fixture, and the suite's `globalSetup`.
//
// ## The problem this solves
//
// This terminal has no sign-in screen, and that is a design decision rather than a gap: `App.tsx`'s
// `Gate` says so in as many words ("This terminal has no sign-in screen"), and the web client only
// ever reads `GET /auth/session` — it has no code path that posts credentials. Without a session
// cookie the page renders `NO SESSION` and there is no command line, no panel and no grid, so every
// spec in this suite would be asserting against a 5-line paragraph.
//
// A session therefore has to be minted against the PLANT and handed to the browser:
//
//   POST /api/v1/auth/login          header `x-requested-with: terminal`   (API.md §12.1)
//   { email, password, deviceId }
//   → 200, Set-Cookie: tsid=…; HttpOnly; Secure; SameSite=Strict
//
// Every seeded account shares one password (`fixtures/seed/users.json` → `password`, documented
// there as DEV ONLY, and the same string API.md §12.1's login example uses). Chrome accepts the
// `Secure` cookie over `http://localhost` because localhost is a secure context.
//
// The idiomatic Playwright form for "all specs start signed in" is a `storageState` file written
// once by `globalSetup` and named in `use`, so that is what this is: one JSON file per seeded user
// under the (gitignored) output directory, and `playwright.config.ts` points `use.storageState` at
// the default one. A spec that needs a different person writes
// `test.use({ storageState: storageStatePath('compliance') })`.
//
// ## Two constraints that are NOT negotiable, and that a spec author has to know
//
//  1. **One active web session per person, and a second login revokes the first.**
//     `http/auth/session.ts#mintWebSession` takes an advisory lock per user, then revokes any live
//     `web` session with `revoke_reason='superseded'` — unconditionally, regardless of `deviceId`.
//     So a spec that logs in again as a user whose `storageState` is already in play does not get a
//     second session, it INVALIDATES the first, and every later spec using that state renders the
//     gate's `SESSION SUPERSEDED`. Specs use the pre-minted states; they do not log in.
//
//  2. **Five logins per minute per IP** (`routes/auth.ts#LOGIN_RATE_MAX`, API.md §1.3), counted
//     against `request.ip` — and every login in this suite comes from the same loopback address.
//     There is no environment knob for it (`app.deps.auth.loginRateLimit` is only ever set by an
//     in-process test), and raising it would be weakening a security control to suit a harness. So
//     {@link mintStorageState} paces itself: five go straight through, a sixth waits out the
//     window and says so. {@link PREMINTED_USERS} is five long for exactly this reason.
//
// ## Why each spec area gets its own person
//
// The database is provisioned once per RUN, not per spec, and the shell autosaves the workspace
// (`Shell.tsx`'s debounce, plus a flush on `pagehide`). A spec that rearranges panels therefore
// mutates the layout every later spec restores. All seven seeded users start from the SAME
// workspace — mode `4`, `p1=WEI p2=TOP p3=GP p4=W` — so handing the mutating specs their own person
// costs nothing and removes the whole class of order-dependent failure.
//
// Nothing here imports package source (WORKPLAN §1.2): the login goes over the wire, and the user
// list is transcribed from `fixtures/seed/users.json` rather than read out of the seed modules.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { env as processEnv, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { request } from '@playwright/test';

import { assertSeeded, E2E_DATABASE_NAME, E2E_SLOT } from './database.js';
import { SERVER_URL, WEB_URL } from './serverProcess.js';

/* ---------------------------------------------------------------------------------------------- */
/* The seeded people                                                                               */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The one password every seeded account has — `fixtures/seed/users.json` → `password`, which that
 * file marks DEV ONLY and which is API.md §12.1's own example string. The seed hashes it with
 * `crypt(…, gen_salt('bf', 12))` and never rotates it on a re-seed, so this constant is stable
 * across provisioning runs.
 */
export const SEEDED_PASSWORD = 'correct horse battery staple';

export interface E2eUser {
  /** `users.email` — the login identity. */
  readonly email: string;
  /** `users.role`, as `SessionInfo.role` reports it. */
  readonly role: 'user' | 'compliance' | 'dataops' | 'newsroom';
  /** `firms.name`, which is what entitlement grants hang off. */
  readonly firm: string;
  /** What this person is for, so a spec author picks by intent rather than by name. */
  readonly use: string;
}

/**
 * The seven seeded accounts (`fixtures/seed/users.json`), keyed the way that file keys them.
 *
 * The `use` line is the allocation, and it is a harness contract rather than a suggestion: two
 * specs that mutate one person's workspace are two specs whose result depends on their order.
 */
export const E2E_USERS = {
  pm: {
    email: 'pm@demo.terminal',
    role: 'user',
    firm: 'Demo Capital',
    use: 'the default. Read-only specs: command-line, autocomplete, help, live-grid, export.',
  },
  analyst: {
    email: 'analyst@demo.terminal',
    role: 'user',
    firm: 'Demo Capital',
    use: 'panels.spec.ts — it rearranges the layout, so it must not share pm’s workspace.',
  },
  rates: {
    email: 'rates@demo.terminal',
    role: 'user',
    firm: 'Demo Capital',
    use: 'the second mutating spec, whichever that turns out to be.',
  },
  compliance: {
    email: 'compliance@demo.terminal',
    role: 'compliance',
    firm: 'Demo Capital',
    use: 'anything that turns on `role`: surveillance, the compliance screens.',
  },
  reporter: {
    email: 'reporter@newsco.terminal',
    role: 'newsroom',
    firm: 'Other Desk',
    use: 'entitlement.spec.ts — a different firm, so a different grant set (SEC-04).',
  },
  dataops: {
    email: 'dataops@demo.terminal',
    role: 'dataops',
    firm: 'Demo Capital',
    use: 'the DQ and ingest screens. NOT pre-minted — see PREMINTED_USERS.',
  },
  eod: {
    email: 'eod@demo.terminal',
    role: 'user',
    firm: 'Demo Capital',
    use: 'spare. NOT pre-minted — see PREMINTED_USERS.',
  },
} as const satisfies Record<string, E2eUser>;

export type E2eUserKey = keyof typeof E2E_USERS;

/** Whom `use.storageState` points at, and whom a spec gets when it names nobody. */
export const DEFAULT_USER: E2eUserKey = 'pm';

/**
 * Whom `globalSetup` mints before the first spec runs — FIVE, because five is the per-IP login
 * budget for a minute and a sixth would make every run 60 s longer (see constraint 2 above).
 *
 * `TERMINAL_E2E_USERS=pm,dataops` narrows it, which is what a single-spec debugging loop wants;
 * naming more than five is allowed and simply paces.
 */
export const PREMINTED_USERS: readonly E2eUserKey[] = ((): readonly E2eUserKey[] => {
  const requested = processEnv.TERMINAL_E2E_USERS;
  if (requested === undefined || requested.trim() === '') {
    return ['pm', 'analyst', 'rates', 'compliance', 'reporter'];
  }
  return requested
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .map((name) => {
      if (!(name in E2E_USERS)) {
        throw new Error(
          `TERMINAL_E2E_USERS names "${name}", which is not a seeded account. ` +
            `Known: ${Object.keys(E2E_USERS).join(', ')}`,
        );
      }
      return name as E2eUserKey;
    });
})();

/* ---------------------------------------------------------------------------------------------- */
/* Where the states live                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `packages/e2e/test-results/.auth/` — inside the output directory on purpose.
 *
 * A `storageState` file holds a live session token, so it must not be committable: `test-results/`
 * is already in `.gitignore`, which is one fewer thing for this package to add. Playwright also
 * clears the output directory in its FIRST global-setup task, before `webServer` and before
 * `globalSetup` (`runner/index.js#createRemoveOutputDirsTask`), so a state left behind by a previous
 * run can never be picked up by this one — which matters, because provisioning drops the database
 * and every `sessions` row with it.
 */
const AUTH_DIR = fileURLToPath(new URL('../test-results/.auth/', import.meta.url));

/** Where {@link mintStorageState} writes this person's state, and what `test.use` names. */
export function storageStatePath(user: E2eUserKey = DEFAULT_USER): string {
  return `${AUTH_DIR}${user}.json`;
}

/**
 * A stable `sessions.device_id` per person and per parallel stack. Stable so that a re-run shows up
 * as the same device rather than littering `GET /auth/sessions`; slot-scoped so two stacks driving
 * the same seeded user are two devices, not one supersede. `deviceId` is `min(8)` in
 * `Rest.Auth.LoginRequest`, which the `e2e-` prefix guarantees.
 */
export function deviceIdFor(user: E2eUserKey): string {
  return `e2e-${user}-slot${String(E2E_SLOT)}`;
}

/* ---------------------------------------------------------------------------------------------- */
/* Minting                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** The shape Playwright's `storageState` file has, as much of it as this harness writes. */
interface StorageStateFile {
  cookies: {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }[];
  /** Empty: nothing the session needs lives in `localStorage`. */
  origins: never[];
}

export interface MintedState {
  readonly user: E2eUserKey;
  readonly email: string;
  readonly path: string;
  /** `sessions.session_id`, so a failure can be traced in `access_log`. */
  readonly sessionId: string;
  /** What `mintWebSession` displaced, if anything — always `null` on a freshly provisioned run. */
  readonly superseded: unknown;
}

/** API.md §1.3 — 5 attempts per minute per IP. */
const LOGIN_BUDGET = 5;
const LOGIN_WINDOW_MS = 60_000;
/** Timestamps of the logins this process has made, newest last. */
const loginsMade: number[] = [];

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits, if it has to, so that the login about to be made is inside the plant's per-IP budget.
 *
 * Deliberately paces rather than raising the limit. The alternative would be an environment flag on
 * `loginRateLimit`, i.e. a security control with a hole in it that exists only for the test suite.
 */
async function withinLoginBudget(log: (line: string) => void): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (loginsMade.length > 0 && (loginsMade[0] ?? 0) <= now - LOGIN_WINDOW_MS) {
      loginsMade.shift();
    }
    if (loginsMade.length < LOGIN_BUDGET) {
      loginsMade.push(now);
      return;
    }
    const waitMs = (loginsMade[0] ?? now) + LOGIN_WINDOW_MS - now + 250;
    log(
      `  login budget spent (${String(LOGIN_BUDGET)}/min per IP, API.md §1.3) — waiting ` +
        `${String(Math.ceil(waitMs / 1000))} s`,
    );
    await sleep(waitMs);
  }
}

interface LoginResponse {
  session: { sessionId: string; email: string; role: string };
  superseded: unknown;
}

/**
 * Logs one seeded user in against the plant and writes their `storageState` file.
 *
 * Three things happen and all three are checked, because a harness that hands back a file nobody
 * has proved is a session is a harness that turns every spec after it into a test of the gate:
 *
 *  1. `POST /api/v1/auth/login` answers 200 and names the user we asked for;
 *  2. the cookie it set is normalised onto `domain: localhost, path: /` — the plant and the app are
 *     two PORTS of one host and cookies do not distinguish ports, so one cookie serves both, but
 *     Playwright records the domain from the URL it saw and `use.storageState` is read against the
 *     app's origin;
 *  3. the written file is loaded back into a fresh context pointed at the APP's origin, which then
 *     asks `GET /api/v1/auth/session` through the vite proxy and must get this user back. That is
 *     the whole chain a spec will use, verified before any spec depends on it.
 */
export async function mintStorageState(
  user: E2eUserKey,
  log: (line: string) => void = (line) => void stdout.write(`${line}\n`),
): Promise<MintedState> {
  const person = E2E_USERS[user];
  await withinLoginBudget(log);

  const api = await request.newContext({
    baseURL: SERVER_URL,
    // API.md §1.1: a cookie-authenticated mutation must carry the CSRF header. Login is a mutation.
    extraHTTPHeaders: { 'x-requested-with': 'terminal' },
  });
  try {
    const res = await api.post('/api/v1/auth/login', {
      data: {
        email: person.email,
        password: SEEDED_PASSWORD,
        deviceId: deviceIdFor(user),
        deviceLabel: 'Playwright (Chrome)',
      },
    });
    if (res.status() !== 200) {
      throw new Error(
        `POST /api/v1/auth/login for ${person.email} answered ${String(res.status())}: ` +
          `${await res.text()}\nIs ${E2E_DATABASE_NAME} seeded, and is the password in ` +
          'fixtures/seed/users.json still the one above?',
      );
    }
    const body = (await res.json()) as LoginResponse;
    if (body.session.email.toLowerCase() !== person.email.toLowerCase()) {
      throw new Error(
        `login for ${person.email} returned a session for ${body.session.email} — the seeded user ` +
          'table is not what this fixture describes',
      );
    }

    const recorded = await api.storageState();
    const cookies = recorded.cookies.map((cookie) => ({
      ...cookie,
      // One host, two ports: the plant set this on `localhost:<server>` and the browser will send it
      // to `localhost:<web>`. The port is not part of a cookie's identity, so widening the domain
      // and path here is describing the cookie accurately, not loosening it.
      domain: 'localhost',
      path: '/',
    }));
    if (!cookies.some((cookie) => cookie.name === 'tsid')) {
      throw new Error(
        `login for ${person.email} set no \`tsid\` cookie (got ` +
          `${cookies.map((c) => c.name).join(', ') || 'none'}) — API.md §1.1 says it must`,
      );
    }

    const state: StorageStateFile = { cookies, origins: [] };
    const path = storageStatePath(user);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    await verifyStorageState(user, path);

    log(
      `  ${user.padEnd(11)} ${person.email.padEnd(26)} role=${body.session.role} ` +
        `session=${body.session.sessionId.slice(0, 8)}`,
    );
    return {
      user,
      email: person.email,
      path,
      sessionId: body.session.sessionId,
      superseded: body.superseded,
    };
  } finally {
    await api.dispose();
  }
}

/**
 * Loads a written state into a fresh context on the APP's origin and asks who it is.
 *
 * This is the assertion that the harness works. It goes through `WEB_URL` rather than `SERVER_URL`
 * on purpose: that exercises the vite `/api` proxy, which is the only path the browser ever takes,
 * and it fails loudly here rather than as `NO SESSION` inside somebody else's spec.
 */
async function verifyStorageState(user: E2eUserKey, path: string): Promise<void> {
  const proxied = await request.newContext({ baseURL: WEB_URL, storageState: path });
  try {
    const res = await proxied.get('/api/v1/auth/session');
    if (res.status() !== 200) {
      throw new Error(
        `the storageState written for ${user} does not authenticate: ` +
          `GET ${WEB_URL}/api/v1/auth/session → ${String(res.status())} ${await res.text()}`,
      );
    }
    const session = (await res.json()) as { email: string };
    if (session.email.toLowerCase() !== E2E_USERS[user].email.toLowerCase()) {
      throw new Error(
        `the storageState written for ${user} authenticates as ${session.email}`,
      );
    }
  } finally {
    await proxied.dispose();
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* globalSetup                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `playwright.config.ts`'s `globalSetup`, and the reason it lives in this file: its whole job is
 * the sessions the suite runs on, and splitting a nine-line entry point away from the fixture it
 * calls would put the two halves of one contract in two places.
 *
 * It runs AFTER `webServer` — Playwright orders the plugin tasks first
 * (`runner/index.js#createGlobalSetupTasks`) — which is exactly right for a login, and exactly
 * wrong for provisioning a database. That is why the database is provisioned by the plant's own
 * command instead, and why the only database work here is the verification: it catches the
 * `reuseExistingServer` case, where the command never ran and the plant a previous run left behind
 * may be attached to anything at all.
 */
export default async function globalSetup(): Promise<void> {
  const log = (line: string): void => void stdout.write(`${line}\n`);

  const seeded = await assertSeeded();
  log(
    `e2e stack — plant ${SERVER_URL}, app ${WEB_URL}, db ${E2E_DATABASE_NAME} ` +
      `(${String(seeded.instruments)} instruments, ${String(seeded.users)} users)`,
  );

  log(`minting ${String(PREMINTED_USERS.length)} session(s):`);
  for (const user of PREMINTED_USERS) {
    // Serially, not `Promise.all`: `mintWebSession` takes an advisory lock per user so parallelism
    // buys nothing, and the per-IP login budget has to be counted in order to be respected.
    await mintStorageState(user, log);
  }
}
