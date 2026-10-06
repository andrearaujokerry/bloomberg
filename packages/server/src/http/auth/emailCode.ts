/**
 * `http/auth/emailCode.ts` — the pure half of the email second factor: making, hashing, comparing
 * and describing a six-digit code. No database, no network, no clock — the service in
 * `emailCodeService.ts` does those, with these as its arithmetic.
 *
 * ## What an email code is, and what it is not
 *
 * A code is a SECOND factor. It upgrades a session that already proved the password — the MFA gate
 * of API.md §1.1 L57, where a password login for a `mfa_required` user yields a session that may only
 * call `/auth/*` — and nothing else. It never mints a session. WebAuthn in this server has a
 * passwordless path (`/auth/webauthn/login/verify` without a prior login) and an email code must not
 * copy it: an inbox is not a credential, and a code that could stand alone would turn "something you
 * know and something you have" into "something in your email".
 *
 * ## The numbers, and why each is the number it is
 *
 * | | | |
 * | --- | --- | --- |
 * | length | 6 digits | 10⁶ codes. With five guesses a code and five codes a session, a guesser gets 25 tries per *password-verified* login — a 0.0025% chance — and every login costs a password the login limiter already throttles to five a minute per address. |
 * | lifetime | 10 minutes | Long enough for slow mail; short enough that a code read off a shoulder is stale. |
 * | attempts | 5 per code | Then the code is dead and a new one must be sent. Enforced by a conditional UPDATE, and capped again by a CHECK in migration 0020 — two statements of one number, asserted equal by the tests. |
 * | resend | 30 s apart, 5 per session | Stops a signed-in attacker — who already has the password — using the server to flood the owner's inbox. |
 */

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** Digits in a code. */
export const CODE_LENGTH = 6;

/** How long a code lives. */
export const CODE_TTL_MS = 10 * 60 * 1_000;

/**
 * Wrong guesses before a code dies. **Stated again in migration 0020** as
 * `CHECK (attempts BETWEEN 0 AND 5)`, deliberately: the conditional UPDATE in the service is the
 * enforcement, the CHECK is the ceiling that holds if that statement is ever written wrong.
 */
export const MAX_ATTEMPTS = 5;

/** Minimum gap between two sends to one session. */
export const RESEND_COOLDOWN_MS = 30 * 1_000;

/** Most codes one session may be sent. A new login is a new session, and costs a password. */
export const MAX_SENDS_PER_SESSION = 5;

/**
 * The code-hashing key, DERIVED from the session secret rather than equal to it.
 *
 * Domain separation: `SESSION_SECRET` signs cookies, and a key used for two purposes is a key whose
 * two uses can be played against each other. An HMAC of a fixed label under the secret gives a
 * second key that is independent for every practical purpose, and costs the deployment no new
 * secret to manage. The label is versioned so a future change of scheme cannot collide with this one.
 */
export function deriveCodeKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update('terminal/mfa-email-code/v1').digest();
}

/**
 * A fresh code: six digits from the operating system's CSPRNG, zero-padded.
 *
 * `randomInt` and not `Math.random()`: the latter is not a cryptographic generator and its state can
 * be recovered from a handful of outputs. `randomInt(0, 10 ** 6)` is uniform over the whole range —
 * Node rejects and redraws rather than taking a modulo, so no code is likelier than another.
 */
export function generateCode(): string {
  return randomInt(0, 10 ** CODE_LENGTH).toString().padStart(CODE_LENGTH, '0');
}

/**
 * The stored form of a code: HMAC-SHA256 under the derived key, over `codeId:code`.
 *
 * Keyed so a copy of the table without the server's secret yields nothing — six digits are only
 * a million possibilities, and an unkeyed hash of them is a lookup table away from the code. Salted
 * by the row's own id so two rows that happen to share six digits do not share a hash.
 */
export function hashCode(key: Buffer, codeId: string, code: string): Buffer {
  return createHmac('sha256', key).update(`${codeId}:${code}`).digest();
}

/**
 * Do two hashes match? In constant time.
 *
 * `timingSafeEqual` throws on unequal lengths, which is itself a timing signal and a crash; both
 * sides here are SHA-256 outputs, so a length mismatch can only mean a corrupted row, and it answers
 * `false` rather than throwing.
 */
export function hashesMatch(stored: Uint8Array, candidate: Uint8Array): boolean {
  if (stored.length !== candidate.length) return false;
  return timingSafeEqual(stored, candidate);
}

/**
 * What the user typed, as a code, or `null` when it cannot be one.
 *
 * Forgiving of what people actually paste: spaces and hyphens are removed (`123 456`, `123-456`),
 * because a mail client that groups the digits for readability should not cost the user a guess.
 * Everything else is strict — exactly six ASCII digits — and a non-code is rejected BEFORE it is
 * hashed or counted, so a typo of the wrong length does not burn one of the five attempts.
 */
export function normaliseCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const compact = input.replace(/[\s-]/g, '');
  return new RegExp(`^[0-9]{${String(CODE_LENGTH)}}$`).test(compact) ? compact : null;
}

/**
 * An address as it may be shown back to the person signing in: enough to recognise, not enough to
 * read off a screen. `jane.doe@example.com` → `j******e@e*****e.com`.
 *
 * Shown so the user knows WHICH inbox to open — an account can be older than its owner's current
 * address — without printing the whole address onto a page anyone behind them can see.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  const mask = (s: string): string =>
    s.length <= 2 ? `${s[0] ?? ''}*` : `${s[0] ?? ''}${'*'.repeat(Math.min(s.length - 2, 6))}${s.at(-1) ?? ''}`;
  return `${mask(local)}@${mask(host)}${tld}`;
}

/** The message itself. Plain text: there is nothing here that markup would improve. */
export interface CodeEmail {
  readonly subject: string;
  readonly text: string;
}

/**
 * The email a code arrives in.
 *
 * **The code is not in the subject**, although many services put it there: a subject is what a
 * locked phone shows on its notification screen, and a second factor readable without unlocking the
 * device is a weaker second factor. It says what the code is for and that the user did not ask for
 * it if they did not — so a code that arrives unbidden reads as the warning it is (someone has the
 * password) rather than as noise.
 */
export function renderCodeEmail(input: { code: string; ttlMinutes: number }): CodeEmail {
  return {
    subject: 'Your Terminal sign-in code',
    text: [
      `Your sign-in code is ${input.code}`,
      '',
      `It expires in ${String(input.ttlMinutes)} minutes and can be used once.`,
      '',
      'If you did not just try to sign in, someone has your password. Change it, and do not',
      'share this code with anyone — no one from the Terminal will ever ask you for it.',
    ].join('\n'),
  };
}
