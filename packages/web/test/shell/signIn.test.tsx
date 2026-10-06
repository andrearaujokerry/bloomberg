/**
 * packages/web/test/shell/signIn.test.tsx — the sign-in screen's two steps, in isolation.
 *
 * `test/app/App.test.tsx` drives the happy journey on the composed application (password → code →
 * terminal) and is where the dispatcher bug was found: the window key listener swallowed every
 * keystroke typed into the login form. This file pins what that journey does not reach — the
 * ways a step can fail, and what each one tells the person — against a fake SDK.
 */

import { StrictMode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { SessionInfo } from '@terminal/sdk/wire/rest/auth';

import { EmailCodeStep, LoginForm, type SignInSdk } from '../../src/shell/SignIn.js';

const SESSION = {
  sessionId: '11111111-2222-4333-8444-555555555555',
  mfaRequired: true,
  mfaVerified: false,
} as unknown as SessionInfo;

/** A failure shaped like `TerminalApiError`. */
function apiError(code: string, extra: { retryAfterMs?: number; details?: Record<string, unknown>; message?: string } = {}): Error {
  return Object.assign(new Error(extra.message ?? code), { code, ...extra });
}

function fakeSdk(over: Partial<SignInSdk['auth']> = {}): SignInSdk & { calls: Record<string, number> } {
  const calls: Record<string, number> = { login: 0, send: 0, verify: 0, logout: 0 };
  return {
    calls,
    auth: {
      login: () => {
        calls.login = (calls.login ?? 0) + 1;
        return Promise.resolve({ session: SESSION, mfaRequired: true, superseded: null });
      },
      mfaEmailSend: () => {
        calls.send = (calls.send ?? 0) + 1;
        return Promise.resolve({
          sentTo: 'j******e@e*****e.com',
          expiresAt: '2026-10-06T12:10:00.000Z',
          resendAvailableAt: new Date(Date.now() + 30_000).toISOString(),
          sendsRemaining: 4,
        });
      },
      mfaEmailVerify: () => {
        calls.verify = (calls.verify ?? 0) + 1;
        return Promise.resolve({ session: { ...SESSION, mfaVerified: true }, mfaRequired: true, superseded: null });
      },
      logout: () => {
        calls.logout = (calls.logout ?? 0) + 1;
        return Promise.resolve(undefined);
      },
      ...over,
    },
  };
}

describe('LoginForm', () => {
  it('keeps the address and clears the password after a refusal', async () => {
    const sdk = fakeSdk({ login: () => Promise.reject(apiError('AUTH_INVALID_CREDENTIALS')) });
    render(<LoginForm sdk={sdk} onSession={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Email'), 'someone@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'not-the-password');
    await userEvent.click(screen.getByTestId('login-submit'));

    expect(await screen.findByTestId('login-problem')).toHaveTextContent('Email or password is not right.');
    expect(screen.getByLabelText('Email')).toHaveValue('someone@example.test');
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('says how long to wait when the login limiter refuses', async () => {
    const sdk = fakeSdk({ login: () => Promise.reject(apiError('RATE_LIMITED', { retryAfterMs: 41_200 })) });
    render(<LoginForm sdk={sdk} onSession={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Email'), 'someone@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'a-long-test-password');
    await userEvent.click(screen.getByTestId('login-submit'));
    expect(await screen.findByTestId('login-problem')).toHaveTextContent('Try again in 42 s.');
  });

  it('sends a device id and a coarse label, never the raw user agent', async () => {
    const login = vi.fn<SignInSdk['auth']['login']>(() =>
      Promise.resolve({ session: SESSION, mfaRequired: true, superseded: null }),
    );
    const onSession = vi.fn();
    render(<LoginForm sdk={fakeSdk({ login })} onSession={onSession} />);
    await userEvent.type(screen.getByLabelText('Email'), ' someone@example.test ');
    await userEvent.type(screen.getByLabelText('Password'), 'a-long-test-password');
    await userEvent.click(screen.getByTestId('login-submit'));

    const body = login.mock.calls[0]?.[0].body;
    expect(body?.email, 'trimmed').toBe('someone@example.test');
    expect(body?.deviceId.length).toBeGreaterThanOrEqual(8);
    expect(body?.deviceLabel).toMatch(/^[A-Za-z ]+ on [A-Za-z ]+$/);
    expect(body?.deviceLabel).not.toContain('Mozilla');
    expect(onSession).toHaveBeenCalledWith(SESSION);
  });
});

describe('EmailCodeStep', () => {
  it('asks for ONE code on arrival, even under StrictMode’s double mount', async () => {
    const sdk = fakeSdk();
    render(
      <StrictMode>
        <EmailCodeStep sdk={sdk} session={SESSION} onSession={vi.fn()} onSignedOut={vi.fn()} />
      </StrictMode>,
    );
    expect(await screen.findByTestId('code-sent')).toHaveTextContent('j******e@e*****e.com');
    expect(sdk.calls.send).toBe(1);
  });

  it('treats a cooldown on arrival as "already sent" — a reload is not an error', async () => {
    const sdk = fakeSdk({
      mfaEmailSend: () => Promise.reject(apiError('RATE_LIMITED', { retryAfterMs: 12_000, details: { reason: 'cooldown' } })),
    });
    render(<EmailCodeStep sdk={sdk} session={SESSION} onSession={vi.fn()} onSignedOut={vi.fn()} />);
    expect(await screen.findByTestId('code-sent')).toHaveTextContent('your email');
    expect(screen.queryByTestId('code-unavailable')).toBeNull();
    expect(screen.getByLabelText('Code')).toBeEnabled();
  });

  it('says plainly when no code can be sent, and does not offer a box that cannot work', async () => {
    const sdk = fakeSdk({
      mfaEmailSend: () => Promise.reject(apiError('PROVIDER_UNAVAILABLE', { retryAfterMs: 5_000 })),
    });
    render(<EmailCodeStep sdk={sdk} session={SESSION} onSession={vi.fn()} onSignedOut={vi.fn()} />);
    expect(await screen.findByTestId('code-unavailable')).toHaveTextContent('could not be sent');
    expect(screen.getByLabelText('Code')).toBeDisabled();
    expect(screen.getByTestId('code-submit')).toBeDisabled();
  });

  it('keeps the box working when a RESEND fails — the code already sent is still good', async () => {
    // The server rolls a failed send back, so the earlier code is not superseded: disabling the box
    // here would lock the person out of a code sitting in their inbox.
    let sends = 0;
    const sdk = fakeSdk({
      mfaEmailSend: () => {
        sends += 1;
        return sends === 1
          ? Promise.resolve({
              sentTo: 'j******e@e*****e.com',
              expiresAt: '2026-10-06T12:10:00.000Z',
              resendAvailableAt: new Date(Date.now() - 1).toISOString(),
              sendsRemaining: 4,
            })
          : Promise.reject(apiError('PROVIDER_UNAVAILABLE', { retryAfterMs: 5_000 }));
      },
    });
    render(<EmailCodeStep sdk={sdk} session={SESSION} onSession={vi.fn()} onSignedOut={vi.fn()} />);
    await screen.findByTestId('code-sent');
    await userEvent.click(screen.getByTestId('code-resend'));

    expect(await screen.findByTestId('code-notice')).toHaveTextContent('the code already sent still works');
    expect(screen.queryByTestId('code-unavailable')).toBeNull();
    expect(screen.getByTestId('code-sent')).toHaveTextContent('j******e@e*****e.com');
    expect(screen.getByLabelText('Code')).toBeEnabled();
  });

  it('keeps the box working at the send limit, and says how to get another code', async () => {
    // Reached on arrival after a reload: five codes went out for this sign-in, and the newest may
    // still be good. The way to a sixth is a new sign-in, which costs the password again.
    const sdk = fakeSdk({
      mfaEmailSend: () =>
        Promise.reject(
          apiError('RATE_LIMITED', {
            message: 'Too many codes have been sent for this sign-in. Sign in again to get a new one.',
            details: { reason: 'send_limit', limit: 5 },
          }),
        ),
    });
    render(<EmailCodeStep sdk={sdk} session={SESSION} onSession={vi.fn()} onSignedOut={vi.fn()} />);
    expect(await screen.findByTestId('code-notice')).toHaveTextContent('Sign in again to get a new one.');
    expect(screen.queryByTestId('code-unavailable')).toBeNull();
    expect(screen.getByLabelText('Code')).toBeEnabled();
    expect(screen.getByTestId('code-resend')).toBeDisabled();
  });

  it('counts down the resend, then allows it', async () => {
    let t = 1_000_000;
    const now = (): number => t;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const sdk = fakeSdk({
        mfaEmailSend: () =>
          Promise.resolve({
            sentTo: 'j******e@e*****e.com',
            expiresAt: new Date(t + 600_000).toISOString(),
            resendAvailableAt: new Date(t + 30_000).toISOString(),
            sendsRemaining: 4,
          }),
      });
      render(<EmailCodeStep sdk={sdk} session={SESSION} onSession={vi.fn()} onSignedOut={vi.fn()} now={now} />);
      await screen.findByTestId('code-sent');
      expect(screen.getByTestId('code-resend')).toBeDisabled();
      expect(screen.getByTestId('code-resend')).toHaveTextContent('in 30 s');

      t += 30_000;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(screen.getByTestId('code-resend')).toBeEnabled();
      expect(screen.getByTestId('code-resend')).toHaveTextContent('Send a new code');
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the person how many tries are left, then how to recover when there are none', async () => {
    let left = 2;
    const sdk = fakeSdk({
      mfaEmailVerify: () => {
        left -= 1;
        return Promise.reject(
          left > 0
            ? apiError('AUTH_INVALID_CREDENTIALS', { details: { reason: 'mismatch', attemptsRemaining: left } })
            : apiError('AUTH_INVALID_CREDENTIALS', {
                message: 'Too many wrong codes. Ask for a new one.',
                details: { reason: 'exhausted', attemptsRemaining: 0 },
              }),
        );
      },
    });
    render(<EmailCodeStep sdk={sdk} session={SESSION} onSession={vi.fn()} onSignedOut={vi.fn()} />);
    await screen.findByTestId('code-sent');

    await userEvent.type(screen.getByLabelText('Code'), '000000');
    await userEvent.click(screen.getByTestId('code-submit'));
    expect(await screen.findByTestId('code-problem')).toHaveTextContent('1 try left');

    await userEvent.type(screen.getByLabelText('Code'), '000000');
    await userEvent.click(screen.getByTestId('code-submit'));
    expect(await screen.findByTestId('code-problem')).toHaveTextContent('Use “Send a new code”');
  });

  it('lets the person back out to a different account, dropping the session first', async () => {
    const sdk = fakeSdk();
    const onSignedOut = vi.fn();
    render(<EmailCodeStep sdk={sdk} session={SESSION} onSession={vi.fn()} onSignedOut={onSignedOut} />);
    await screen.findByTestId('code-sent');
    await userEvent.click(screen.getByTestId('code-signout'));
    expect(sdk.calls.logout).toBe(1);
    expect(onSignedOut).toHaveBeenCalledOnce();
  });

  it('marks the code field for one-time-code autofill and the number pad', async () => {
    render(<EmailCodeStep sdk={fakeSdk()} session={SESSION} onSession={vi.fn()} onSignedOut={vi.fn()} />);
    await screen.findByTestId('code-sent');
    const input = screen.getByLabelText('Code');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
  });
});
