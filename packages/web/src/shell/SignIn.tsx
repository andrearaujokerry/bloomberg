// packages/web/src/shell/SignIn.tsx — the sign-in screen: a password, then a code sent by email.
//
// For fifteen packages this terminal had no sign-in UI at all — the gate told a visitor to mint a
// session with `POST /auth/login` from a terminal of their own — and an account that requires a
// second factor could not finish signing in through the browser, because the only second factor was
// WebAuthn and no WebAuthn UI exists. This is both halves:
//
//   * `LoginForm` — email and password, `POST /auth/login`. A `mfa_required` account comes back with
//     a session that may only call `/auth/*`, and the session store reads that as status `'mfa'`.
//   * `EmailCodeStep` — sends a six-digit code to the account's address on arrival, takes it back,
//     `POST /auth/mfa/email/verify` upgrades the SAME session, and the store reads `'ready'`.
//
// The gate (`App.tsx#Gate`) chooses between them from the store's status, so neither component
// navigates: each one only tells the store what the server said.
//
// What is deliberately NOT here:
//
//   * **Which half of a failed login was wrong.** "Email or password is not right" — the server
//     answers both the same way at the same cost so the form cannot be used to learn which addresses
//     have accounts, and saying more here would undo that.
//   * **The password, after a failure.** Cleared, and never kept anywhere but the input.
//   * **Auto-submit when six digits are typed.** A paste with a stray character would spend one of
//     the five guesses without the person choosing to; Enter is one key away in a keyboard-first
//     terminal.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactElement } from 'react';

import type {
  LoginRequest,
  LoginResponse,
  MfaEmailSendResponse,
  MfaEmailVerifyRequest,
  SessionInfo,
} from '@terminal/sdk/wire/rest/auth';

import { deviceId, deviceLabel } from '../state/device.js';

/** The four calls this screen makes — a structural slice of the SDK, so a test hands in a fake. */
export interface SignInSdk {
  readonly auth: {
    readonly login: (args: { body: LoginRequest }) => Promise<LoginResponse>;
    readonly mfaEmailSend: () => Promise<MfaEmailSendResponse>;
    readonly mfaEmailVerify: (args: { body: MfaEmailVerifyRequest }) => Promise<LoginResponse>;
    readonly logout: () => Promise<unknown>;
  };
}

/** What a failed call looks like, read structurally from `TerminalApiError` (or a test's fake). */
interface FailureLike {
  code?: unknown;
  message?: unknown;
  retryAfterMs?: unknown;
  details?: unknown;
}

function failureOf(err: unknown): {
  code: string;
  message: string;
  retryAfterMs: number | null;
  details: Record<string, unknown>;
} {
  const f = (typeof err === 'object' && err !== null ? err : {}) as FailureLike;
  return {
    code: typeof f.code === 'string' ? f.code : 'NETWORK',
    message: typeof f.message === 'string' ? f.message : 'The server did not answer.',
    retryAfterMs: typeof f.retryAfterMs === 'number' ? f.retryAfterMs : null,
    details: typeof f.details === 'object' && f.details !== null ? (f.details as Record<string, unknown>) : {},
  };
}

const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1_000));

/* ---------------------------------------------------------------------------------------------- */
/* Styles — the gate's own idiom: amber heading, muted prose, nothing that is not text or a box     */
/* ---------------------------------------------------------------------------------------------- */

const S = {
  form: { display: 'flex', flexDirection: 'column', gap: '1.2ch', maxWidth: '44ch' },
  head: { color: 'var(--c-label)', margin: 0, letterSpacing: '0.05em' },
  muted: { color: 'var(--c-muted)', margin: 0 },
  error: { color: 'var(--c-error)', margin: 0 },
  label: { display: 'flex', flexDirection: 'column', gap: '0.4ch', color: 'var(--c-muted)' },
  input: {
    font: 'inherit',
    color: 'var(--c-value)',
    background: 'var(--c-bg-panel)',
    border: '1px solid var(--c-grid-line)',
    padding: '0.6ch 1ch',
  },
  code: {
    font: 'inherit',
    fontSize: '1.4em',
    letterSpacing: '0.4em',
    color: 'var(--c-value)',
    background: 'var(--c-bg-panel)',
    border: '1px solid var(--c-grid-line)',
    padding: '0.4ch 1ch',
    width: '12ch',
  },
  row: { display: 'flex', gap: '2ch', alignItems: 'center', flexWrap: 'wrap' },
  primary: {
    font: 'inherit',
    color: 'var(--c-bg)',
    background: 'var(--c-label)',
    border: 'none',
    padding: '0.6ch 2ch',
    cursor: 'pointer',
    alignSelf: 'flex-start',
  },
  link: {
    font: 'inherit',
    color: 'var(--c-focus)',
    background: 'none',
    border: 'none',
    padding: 0,
    textDecoration: 'underline',
    cursor: 'pointer',
  },
} satisfies Record<string, CSSProperties>;

/* ---------------------------------------------------------------------------------------------- */
/* Step 1 — the password                                                                            */
/* ---------------------------------------------------------------------------------------------- */

export interface LoginFormProps {
  sdk: SignInSdk;
  /** `useSessionStore.getState().setSession` — the store derives `'mfa'` or `'ready'` from it. */
  readonly onSession: (info: SessionInfo) => void;
}

export function LoginForm({ sdk, onSession }: LoginFormProps): ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (pending) return;
      setPending(true);
      setProblem(null);
      try {
        const res = await sdk.auth.login({
          body: { email: email.trim(), password, deviceId: deviceId(), deviceLabel: deviceLabel() },
        });
        setPassword('');
        onSession(res.session);
      } catch (err) {
        const f = failureOf(err);
        setPassword('');
        setProblem(
          f.code === 'AUTH_INVALID_CREDENTIALS' || f.code === 'VALIDATION_FAILED'
            ? 'Email or password is not right.'
            : f.code === 'RATE_LIMITED'
              ? `Too many attempts. Try again in ${String(seconds(f.retryAfterMs ?? 60_000))} s.`
              : f.code === 'USER_SUSPENDED'
                ? f.message
                : `Sign-in failed — ${f.message}`,
        );
      } finally {
        setPending(false);
      }
    },
    [sdk, email, password, pending, onSession],
  );

  return (
    <form style={S.form} onSubmit={(e) => void submit(e)} aria-label="Sign in" data-testid="login-form" noValidate>
      <h1 style={S.head}>SIGN IN</h1>
      <label style={S.label}>
        Email
        <input
          style={S.input}
          type="email"
          name="email"
          autoComplete="username"
          // A keyboard-first terminal: the first thing on screen takes the keys.
          autoFocus
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid="login-email"
        />
      </label>
      <label style={S.label}>
        Password
        <input
          style={S.input}
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="login-password"
        />
      </label>
      {problem === null ? null : (
        <p style={S.error} role="alert" data-testid="login-problem">
          {problem}
        </p>
      )}
      <button
        type="submit"
        style={S.primary}
        disabled={pending || email.trim() === '' || password === ''}
        data-testid="login-submit"
      >
        {pending ? 'SIGNING IN…' : 'SIGN IN'}
      </button>
    </form>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Step 2 — the code                                                                                */
/* ---------------------------------------------------------------------------------------------- */

export interface EmailCodeStepProps {
  sdk: SignInSdk;
  /** The pending session — its id keys the "send once" guard. */
  session: SessionInfo;
  readonly onSession: (info: SessionInfo) => void;
  /** Back to the password: the store's `reset`, after the server has dropped the session. */
  readonly onSignedOut: () => void;
  /** Injected so a test can move time without waiting. */
  now?: () => number;
}

type SendState =
  | { kind: 'sending' }
  | { kind: 'sent'; sentTo: string; resendAt: number }
  /** This sign-in has had all its codes. The newest may still be good, so the box stays. */
  | { kind: 'limit' }
  /** No code went out at all, so a box would be a box that cannot work. */
  | { kind: 'unavailable'; message: string };

export function EmailCodeStep({
  sdk,
  session,
  onSession,
  onSignedOut,
  now = Date.now,
}: EmailCodeStepProps): ReactElement {
  const [send, setSend] = useState<SendState>({ kind: 'sending' });
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A send that failed while a code may already be out: said, but the box stays live. The server
  // rolls a failed send back, so it never supersedes the code the person already has.
  const [notice, setNotice] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const requestCode = useCallback(
    async (resend: boolean) => {
      setNotice(null);
      if (resend) setResending(true);
      else setSend({ kind: 'sending' });
      try {
        const res = await sdk.auth.mfaEmailSend();
        setSend({ kind: 'sent', sentTo: res.sentTo, resendAt: Date.parse(res.resendAvailableAt) });
        inputRef.current?.focus();
      } catch (err) {
        const f = failureOf(err);
        if (f.code === 'RATE_LIMITED' && f.details.reason === 'cooldown') {
          // A code went out moments ago — a reload, or a second tab. That code is still good, so this
          // is "check your inbox", not an error.
          setSend({ kind: 'sent', sentTo: 'your email', resendAt: now() + (f.retryAfterMs ?? 30_000) });
          return;
        }
        if (f.code === 'RATE_LIMITED' && f.details.reason === 'send_limit') {
          // Five codes went out for this sign-in and the newest may still be good. Keep the box, stop
          // the resends, and say that the way to another code is a new sign-in.
          setSend({ kind: 'limit' });
          setNotice(f.message);
          return;
        }
        if (resend) {
          // The earlier code was not superseded (the failed send rolled back), so it still works.
          setNotice(
            f.code === 'PROVIDER_UNAVAILABLE'
              ? 'A new code could not be sent — the code already sent still works.'
              : `A new code could not be sent — ${f.message}`,
          );
          return;
        }
        setSend({
          kind: 'unavailable',
          message:
            f.code === 'PROVIDER_UNAVAILABLE'
              ? 'A sign-in code could not be sent. If this keeps happening, the server has no mail configured — ask your administrator.'
              : `A sign-in code could not be sent — ${f.message}`,
        });
      } finally {
        if (resend) setResending(false);
      }
    },
    [sdk, now],
  );

  // ONE send per pending session, whatever React does to this component. StrictMode mounts, unmounts
  // and remounts in development to expose an effect that cannot be run twice — and this one cannot:
  // a second send would be refused by the 30 s cooldown at best, and at worst supersede the code the
  // person is already reading. A ref survives the simulated remount (same instance), keyed on the
  // session so a genuinely new sign-in still gets its code. `Shell.tsx#restoredFor` is the same rule.
  const sentFor = useRef<string | null>(null);
  useEffect(() => {
    if (sentFor.current === session.sessionId) return;
    sentFor.current = session.sessionId;
    void requestCode(false);
  }, [session.sessionId, requestCode]);

  // The resend countdown: re-render once a second while there is something to count down, and stop
  // ticking the moment there is not. `tick` exists only to cause the re-render; the remaining wait is
  // always computed from `now()`, so a slow tick can never show a wrong number.
  const waitMs = send.kind === 'sent' ? send.resendAt - now() : 0;
  useEffect(() => {
    if (send.kind !== 'sent' || send.resendAt <= now()) return undefined;
    const id = setInterval(() => {
      setTick((n) => n + 1);
      if (send.resendAt <= now()) clearInterval(id);
    }, 1_000);
    return () => clearInterval(id);
  }, [send, now]);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (pending || code.trim() === '') return;
      setPending(true);
      setProblem(null);
      try {
        const res = await sdk.auth.mfaEmailVerify({ body: { code } });
        onSession(res.session);
      } catch (err) {
        const f = failureOf(err);
        const left = typeof f.details.attemptsRemaining === 'number' ? f.details.attemptsRemaining : null;
        const reason = f.details.reason;
        setCode('');
        setProblem(
          reason === 'mismatch' && left !== null && left > 0
            ? `That code is not right — ${String(left)} ${left === 1 ? 'try' : 'tries'} left.`
            : reason === 'malformed'
              ? 'A sign-in code is six digits.'
              : reason === 'expired' || reason === 'exhausted' || reason === 'no_code' || left === 0
                ? `${f.message} Use “Send a new code”.`
                : `Could not check the code — ${f.message}`,
        );
        inputRef.current?.focus();
      } finally {
        setPending(false);
      }
    },
    [sdk, code, pending, onSession],
  );

  const signOut = useCallback(async () => {
    await sdk.auth.logout().catch(() => undefined);
    onSignedOut();
  }, [sdk, onSignedOut]);

  return (
    <form style={S.form} onSubmit={(e) => void submit(e)} aria-label="Enter your sign-in code" data-testid="code-form" noValidate>
      <h1 style={S.head}>CHECK YOUR EMAIL</h1>

      {send.kind === 'sending' ? (
        <p style={S.muted} aria-live="polite" data-testid="code-sending">
          Sending a sign-in code…
        </p>
      ) : null}
      {send.kind === 'sent' ? (
        <p style={S.muted} aria-live="polite" data-testid="code-sent">
          {`We sent a 6-digit code to ${send.sentTo}. It expires in 10 minutes.`}
        </p>
      ) : null}
      {send.kind === 'unavailable' ? (
        <p style={S.error} role="alert" data-testid="code-unavailable">
          {send.message}
        </p>
      ) : null}
      {notice === null ? null : (
        <p style={S.muted} role="status" data-testid="code-notice">
          {notice}
        </p>
      )}

      <label style={S.label}>
        Code
        <input
          ref={inputRef}
          style={S.code}
          type="text"
          name="code"
          // `one-time-code` lets a phone offer the code straight out of the email; `numeric` brings up
          // the number pad. Up to seven characters so `123 456` — a mail client's grouping — fits.
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={send.kind === 'unavailable'}
          data-testid="code-input"
        />
      </label>

      {problem === null ? null : (
        <p style={S.error} role="alert" data-testid="code-problem">
          {problem}
        </p>
      )}

      <div style={S.row}>
        <button
          type="submit"
          style={S.primary}
          disabled={pending || code.trim() === '' || send.kind === 'unavailable'}
          data-testid="code-submit"
        >
          {pending ? 'CHECKING…' : 'VERIFY'}
        </button>
        <button
          type="button"
          style={S.link}
          onClick={() => void requestCode(true)}
          disabled={send.kind === 'sending' || send.kind === 'limit' || resending || waitMs > 0}
          data-testid="code-resend"
        >
          {waitMs > 0 ? `Send a new code in ${String(seconds(waitMs))} s` : 'Send a new code'}
        </button>
        <button type="button" style={S.link} onClick={() => void signOut()} data-testid="code-signout">
          Use a different account
        </button>
      </div>
    </form>
  );
}
