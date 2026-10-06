/**
 * `email/sender.ts` and the email half of `config.ts` — how a sign-in code leaves the server.
 *
 * The suite runs with no network (QA-02), so `smtpSender` is never pointed at a real server here.
 * What IS pinned is the configuration it builds, because that is where the security lives: in
 * STARTTLS mode nodemailer will, unless told otherwise, send to a server that simply does not offer
 * the upgrade — in clear — and `requireTLS` is the one flag that stops it.
 */

import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError, emailConfigIssues, loadConfig, type RawEnv } from '../../../src/config.js';
import {
  SMTP_TIMEOUT_MS,
  emailSenderFromConfig,
  emailTransportNotice,
  memorySender,
  outboxSender,
  smtpTransportOptions,
} from '../../../src/email/sender.js';

const REQUIRED: RawEnv = {
  DATABASE_URL: 'postgres://localhost:5432/bloomberg_dev',
  SEC_USER_AGENT: 'Terminal/0.1 (ops@example.com)',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef',
};
const env = (extra: Readonly<Record<string, string>> = {}): RawEnv => ({ ...REQUIRED, ...extra });

describe('smtpTransportOptions — TLS is required, never hoped for', () => {
  const base = { host: 'smtp.example.test', port: 587, from: 'Terminal <no-reply@example.test>' } as const;

  it('STARTTLS: plain connect, then REQUIRE the upgrade', () => {
    const o = smtpTransportOptions({ ...base, secure: 'starttls' });
    expect(o.secure).toBe(false);
    expect(o.requireTLS, 'without this a server that does not offer STARTTLS gets the code in clear').toBe(true);
  });

  it('TLS: encrypted from the first byte', () => {
    const o = smtpTransportOptions({ ...base, port: 465, secure: 'tls' });
    expect(o.secure).toBe(true);
    expect(o.requireTLS).toBe(false);
  });

  it('bounds every step, so a silent server cannot hold a sign-in at a spinner', () => {
    const o = smtpTransportOptions({ ...base, secure: 'starttls' });
    expect(o.connectionTimeout).toBe(SMTP_TIMEOUT_MS);
    expect(o.greetingTimeout).toBe(SMTP_TIMEOUT_MS);
    expect(o.socketTimeout).toBe(SMTP_TIMEOUT_MS);
  });

  it('authenticates only when a user is configured', () => {
    expect(smtpTransportOptions({ ...base, secure: 'starttls' })).not.toHaveProperty('auth');
    expect(smtpTransportOptions({ ...base, secure: 'starttls', user: 'u', pass: 'p' }).auth).toEqual({
      user: 'u',
      pass: 'p',
    });
  });
});

describe('memorySender', () => {
  it('records each message, and fails exactly once when told to', async () => {
    const s = memorySender();
    await s.send({ to: 'a@b.test', subject: 's', text: 't' });
    s.failNext(new Error('nope'));
    await expect(s.send({ to: 'a@b.test', subject: 's', text: 't' })).rejects.toThrow('nope');
    await s.send({ to: 'c@d.test', subject: 's', text: 't' });
    expect(s.sent.map((m) => m.to)).toEqual(['a@b.test', 'c@d.test']);
  });
});

describe('outboxSender — a live code on disk, so readable by its owner only', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('writes one file per message, 0600, in a directory it makes 0700', async () => {
    dir = await mkdtemp(join(tmpdir(), 'outbox-test-'));
    const box = join(dir, 'outbox');
    const s = outboxSender(box);
    await s.send({ to: 'a@b.test', subject: 'Your Terminal sign-in code', text: 'Your sign-in code is 123456' });

    const files = await readdir(box);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);
    expect((await stat(box)).mode & 0o777).toBe(0o700);
    expect((await stat(join(box, files[0]!))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(box, files[0]!), 'utf8'))).toEqual({
      to: 'a@b.test',
      subject: 'Your Terminal sign-in code',
      text: 'Your sign-in code is 123456',
    });
  });
});

describe('the email settings — refused at startup when incomplete', () => {
  it('needs a host and a sender address for SMTP', () => {
    expect(() => loadConfig(env({ EMAIL_TRANSPORT: 'smtp' }))).toThrow(ConfigError);
    const issues = emailConfigIssues({ ...loadConfig(env()), EMAIL_TRANSPORT: 'smtp' });
    expect(issues.join('\n')).toContain('SMTP_HOST');
    expect(issues.join('\n')).toContain('EMAIL_FROM');
  });

  it('wants a user and a password together, or neither', () => {
    const c = { ...loadConfig(env()), EMAIL_TRANSPORT: 'smtp' as const, SMTP_HOST: 'h', EMAIL_FROM: 'a@b.test' };
    expect(emailConfigIssues({ ...c, SMTP_USER: 'u' })).toHaveLength(1);
    expect(emailConfigIssues({ ...c, SMTP_USER: 'u', SMTP_PASS: 'p' })).toEqual([]);
    expect(emailConfigIssues(c)).toEqual([]);
  });

  it('needs a directory for the outbox', () => {
    expect(() => loadConfig(env({ EMAIL_TRANSPORT: 'outbox' }))).toThrow(/EMAIL_OUTBOX_DIR/);
    expect(() => loadConfig(env({ EMAIL_TRANSPORT: 'outbox', EMAIL_OUTBOX_DIR: '.outbox' }))).not.toThrow();
  });

  it('defaults to STARTTLS on 587', () => {
    const c = loadConfig(env());
    expect(c.SMTP_PORT).toBe(587);
    expect(c.SMTP_SECURE).toBe('starttls');
  });
});

describe('emailSenderFromConfig — fail closed', () => {
  it('builds no sender at all when no transport is configured', () => {
    expect(emailSenderFromConfig(loadConfig(env()))).toBeNull();
  });

  it('builds the outbox and the SMTP sender when configured — without connecting to anything', () => {
    expect(emailSenderFromConfig(loadConfig(env({ EMAIL_TRANSPORT: 'outbox', EMAIL_OUTBOX_DIR: '.outbox' })))?.kind).toBe(
      'outbox',
    );
    const smtp = emailSenderFromConfig(
      loadConfig(env({ EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.test', EMAIL_FROM: 'a@b.test' })),
    );
    expect(smtp?.kind).toBe('smtp');
  });

  it('warns at startup for anything but SMTP, and says what the outbox does with codes', () => {
    expect(emailTransportNotice(loadConfig(env())).level).toBe('warn');
    const outbox = emailTransportNotice(loadConfig(env({ EMAIL_TRANSPORT: 'outbox', EMAIL_OUTBOX_DIR: '.outbox' })));
    expect(outbox.level).toBe('warn');
    expect(outbox.msg).toMatch(/WRITTEN TO DISK/);
    expect(
      emailTransportNotice(loadConfig(env({ EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'h', EMAIL_FROM: 'a@b.test' }))).level,
    ).toBe('info');
  });
});
