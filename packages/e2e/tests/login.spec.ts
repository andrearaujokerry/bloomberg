/**
 * packages/e2e/tests/login.spec.ts — signing in, in Chrome: a password, then a code sent by email.
 *
 * The plant runs with `EMAIL_TRANSPORT=outbox` (`fixtures/serverProcess.ts#serverEnv`), so a "sent"
 * code is a file in `E2E_OUTBOX_DIR` — the production path up to the hand-off to a mail server. The
 * spec reads the newest message addressed to its own account, exactly as a person reads their inbox.
 *
 * ## Why this file types with real keystrokes
 *
 * Every field here is filled with `pressSequentially`, never `fill`. `fill` sets the value directly
 * and fires no `keydown` — and a `keydown` is precisely what broke: the window's key dispatcher was
 * attached while the sign-in gate was up, routed each keystroke to type-anywhere for a command line
 * that did not exist yet, and called `preventDefault`, so the login form swallowed every key. A spec
 * that used `fill` would have passed against that bug. This one would not.
 *
 * ## The account
 *
 * Created by this file, not borrowed from the seed: the seeded accounts have no second factor and
 * other specs sign in as them through `storageState`. A fresh address per run, `mfa_required = true`,
 * removed again at the end.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { E2E_DATABASE_URL, scalar } from '../fixtures/database.js';
import { E2E_OUTBOX_DIR } from '../fixtures/serverProcess.js';

// No session: this file starts where a visitor starts.
test.use({ storageState: { cookies: [], origins: [] } });

const PASSWORD = 'e2e-second-factor-password';
const EMAIL = `mfa-e2e-${randomUUID().slice(0, 8)}@demo.invalid`;

test.beforeAll(async () => {
  // Literals only — `scalar` is `psql -c`, with no parameter binding — and every value here is ours.
  await scalar(
    E2E_DATABASE_URL,
    `WITH u AS (
       INSERT INTO users (firm_id, email, display_name, desk, role, status, mfa_required)
       SELECT firm_id, '${EMAIL}', 'E2E Second Factor', 'Equities PM', 'user', 'active', true
         FROM firms WHERE name = 'Demo Capital'
       RETURNING user_id)
     INSERT INTO user_credentials (user_id, kind, secret_hash)
     SELECT user_id, 'password', crypt('${PASSWORD}', gen_salt('bf', 12)) FROM u
     RETURNING user_id`,
  );
});

test.afterAll(async () => {
  await scalar(
    E2E_DATABASE_URL,
    `WITH u AS (SELECT user_id FROM users WHERE email = '${EMAIL}'),
          s AS (DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM u)),
          c AS (DELETE FROM user_credentials WHERE user_id IN (SELECT user_id FROM u))
     UPDATE users SET status = 'deprovisioned', deprovisioned_at = now() WHERE user_id IN (SELECT user_id FROM u)
     RETURNING user_id`,
  );
});

/** The outbox's file names right now — taken BEFORE a send, so the new message is the one not in it. */
async function outboxSnapshot(): Promise<Set<string>> {
  try {
    return new Set(await readdir(E2E_OUTBOX_DIR));
  } catch {
    return new Set(); // the directory appears with the first message
  }
}

/** The code in the first message to `to` that was not in `before`, waiting up to 10 s for it. */
async function codeFor(to: string, before: Set<string>): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const fresh = [...(await outboxSnapshot())].filter(
      (f) => f.endsWith('.json') && !before.has(f),
    );
    for (const file of fresh) {
      const message = JSON.parse(await readFile(join(E2E_OUTBOX_DIR, file), 'utf8')) as {
        to: string;
        subject: string;
        text: string;
      };
      if (message.to !== to) continue;
      const match = /\b(\d{6})\b/.exec(message.text);
      if (match?.[1] !== undefined) {
        // The subject is what a locked phone shows; the code must not be readable from it.
        expect(message.subject).not.toMatch(/\d{6}/);
        return match[1];
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no sign-in code for ${to} reached ${E2E_OUTBOX_DIR} within 10 s`);
}

/**
 * Submit the login form and return the status `POST /auth/login` answered — waiting out the login
 * limiter when it refuses.
 *
 * API.md §1.3 allows five logins a minute per IP, and `globalSetup` has usually just spent all five
 * on the accounts it pre-mints. A `429` here is the security control doing its job, and the right
 * response is what a person would do — wait as long as they are told, type the password again (the
 * form clears it after any refusal) and resubmit — not to widen the limit for a harness
 * (`fixtures/auth.ts` makes the same argument where it paces itself). Keyed on the RESPONSE, not on
 * the form's text, so a message left over from the previous attempt can never be mistaken for the
 * answer to this one.
 */
async function submitLogin(page: Page, password: string): Promise<number> {
  for (;;) {
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST',
      ),
      page.getByLabel('Password', { exact: true }).press('Enter'),
    ]);
    if (res.status() !== 429) return res.status();
    const body = (await res.json()) as { error: { retryAfterMs?: number } };
    // The person is told how long, in the form's own words.
    await expect(page.getByTestId('login-problem')).toContainText(
      'Too many attempts. Try again in',
    );
    await page.waitForTimeout((body.error.retryAfterMs ?? 60_000) + 1_000);
    await page.getByLabel('Password', { exact: true }).pressSequentially(password);
  }
}

/** Sign in with the password through real keystrokes; returns the outbox as it was before the send. */
async function signInWithPassword(page: Page): Promise<Set<string>> {
  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Email', { exact: true }).pressSequentially(EMAIL);
  await page.getByLabel('Password', { exact: true }).pressSequentially(PASSWORD);
  // The keystrokes landed: this is the assertion the dispatcher bug would have failed.
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(EMAIL);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue(PASSWORD);
  const before = await outboxSnapshot();
  expect(await submitLogin(page, PASSWORD)).toBe(200);
  return before;
}

test.describe('signing in — a password, then a code sent by email', () => {
  // Room for one wait on the login limiter (`submitLogin`) on top of the config's 60 s.
  test.describe.configure({ timeout: 150_000 });

  test('takes the password, mails a code, takes the code, and opens the terminal', async ({
    page,
  }) => {
    const before = await signInWithPassword(page);

    await expect(page.getByTestId('code-form')).toBeVisible();
    await expect(page.getByTestId('code-sent')).toContainText('We sent a 6-digit code to');
    // Masked: the screen names the inbox without printing the address.
    await expect(page.getByTestId('code-sent')).not.toContainText(EMAIL);

    // Until the code is entered, the session cannot reach data.
    const gated = await page.request.get('/api/v1/workspace');
    expect(gated.status()).toBe(401);
    expect(((await gated.json()) as { error: { code: string } }).error.code).toBe('MFA_REQUIRED');

    const code = await codeFor(EMAIL, before);
    await page.getByLabel('Code', { exact: true }).pressSequentially(code);
    await page.getByLabel('Code', { exact: true }).press('Enter');

    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('session-gate')).toHaveCount(0);
    // The SAME cookie is upgraded — no second session minted — so data now answers. Exactly 200:
    // this request races the shell's own first load of a brand-new person's workspace, and an
    // assertion of "not 401" once let that race's 500 through (`firstLoadRace.test.ts`).
    const open = await page.request.get('/api/v1/workspace');
    expect(open.status()).toBe(200);
  });

  test('says how many tries are left after a wrong code', async ({ page }) => {
    const before = await signInWithPassword(page);
    const code = await codeFor(EMAIL, before);
    const wrong = code === '000000' ? '111111' : '000000';

    await page.getByLabel('Code', { exact: true }).pressSequentially(wrong);
    await page.getByLabel('Code', { exact: true }).press('Enter');
    await expect(page.getByTestId('code-problem')).toContainText('4 tries left');
    await expect(page.getByTestId('shell')).toHaveCount(0);
  });

  test('refuses a wrong password without saying which half was wrong', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Email', { exact: true }).pressSequentially(EMAIL);
    await page.getByLabel('Password', { exact: true }).pressSequentially('not-the-password-at-all');
    expect(await submitLogin(page, 'not-the-password-at-all')).toBe(401);
    await expect(page.getByTestId('login-problem')).toHaveText('Email or password is not right.');
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  });
});
