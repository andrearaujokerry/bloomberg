/**
 * `email/sender.ts` — how a message leaves the server. One port, three implementations.
 *
 * | | when | where the message goes |
 * | --- | --- | --- |
 * | `smtpSender` | a deployment | any SMTP provider — the choice of provider is configuration, never code |
 * | `outboxSender` | local development, the e2e suite | a file per message in a directory, mode `0600` |
 * | `memorySender` | the vitest suite | an array a test reads; nothing touches a socket or a disk |
 *
 * The suite runs with no network (QA-02), so the SMTP path is never exercised by a test against a
 * real server — `smtpSender` is a thin, configured `nodemailer` transport and its tests assert the
 * configuration it builds (TLS required, timeouts set), not a delivery.
 *
 * ## Fail closed
 *
 * `emailSenderFromConfig` answers `null` when no transport is configured, and the routes that send
 * codes answer `503 PROVIDER_UNAVAILABLE` on `null`. There is no fallback that "logs the code for
 * now": a code in a log is a code anyone with log access can use, and the cheapest way to leak one
 * is a default that seemed harmless in development.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import nodemailer from 'nodemailer';

import type { Config } from '../config.js';

/**
 * One message: a plain-text part, always, and optionally an HTML part sent beside it as
 * multipart/alternative. The HTML comes only from this server's own templates
 * (`email/signInCodeEmail.ts`) — never from anything a user typed.
 */
export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface EmailSender {
  /** Which implementation, for the startup log and `/health`. */
  readonly kind: 'smtp' | 'outbox' | 'memory';
  /** Resolves when the message is handed off; rejects when it could not be. */
  send(message: OutgoingEmail): Promise<void>;
}

/* ---------------------------------------------------------------------------------------------- */
/* SMTP                                                                                             */
/* ---------------------------------------------------------------------------------------------- */

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: 'starttls' | 'tls';
  readonly user?: string | undefined;
  readonly pass?: string | undefined;
  readonly from: string;
}

/**
 * How long one SMTP step may take. A sign-in request is holding a person at a spinner, and a mail
 * server that accepts the TCP connection and then says nothing would otherwise hold it for the
 * OS's socket timeout — minutes.
 */
export const SMTP_TIMEOUT_MS = 10_000;

/** The `nodemailer` transport options `smtpSender` builds — exported so a test can assert them. */
export function smtpTransportOptions(o: SmtpOptions): Record<string, unknown> {
  return {
    host: o.host,
    port: o.port,
    // `secure: true` is implicit TLS (465). With `starttls`, `secure` is false and `requireTLS` is
    // what refuses a server that will not upgrade — without it nodemailer would fall back to sending
    // the code in clear to any server that simply does not offer STARTTLS.
    secure: o.secure === 'tls',
    requireTLS: o.secure === 'starttls',
    ...(o.user === undefined ? {} : { auth: { user: o.user, pass: o.pass } }),
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  };
}

/**
 * What `smtpSender` hands nodemailer for one message — exported so a test can build the exact MIME
 * a provider receives (multipart/alternative when there is an HTML part) without a network.
 */
export function mailOptions(from: string, message: OutgoingEmail): Record<string, string> {
  return {
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html === undefined ? {} : { html: message.html }),
  };
}

export function smtpSender(o: SmtpOptions): EmailSender {
  const transport = nodemailer.createTransport(smtpTransportOptions(o));
  return {
    kind: 'smtp',
    async send(message) {
      await transport.sendMail(mailOptions(o.from, message));
    },
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Outbox                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Write each message to `dir` as `<iso-time>-<uuid>.json` instead of sending it — and its HTML part,
 * when it has one, beside it as `<same name>.html`, so the email can be looked at in a browser.
 *
 * For `npm run dev` and the e2e suite: a developer signs in by opening the newest file, and the
 * Playwright spec reads it the same way, so the code path from "a code was made" to "a code was
 * delivered" is the production one up to the last step. Files are `0600` and the directory `0700`
 * because each holds a live sign-in code.
 */
export function outboxSender(dir: string): EmailSender {
  const root = resolve(dir);
  let ready: Promise<void> | undefined;
  return {
    kind: 'outbox',
    async send(message) {
      ready ??= mkdir(root, { recursive: true, mode: 0o700 }).then(() => chmod(root, 0o700));
      await ready;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = join(root, `${stamp}-${randomUUID()}`);
      await writeFile(`${base}.json`, `${JSON.stringify(message, null, 2)}\n`, { mode: 0o600 });
      if (message.html !== undefined) {
        await writeFile(`${base}.html`, message.html, { mode: 0o600 });
      }
    },
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Memory                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** For tests: every message, in order. `failNext` makes the next send reject, once. */
export interface MemorySender extends EmailSender {
  readonly sent: OutgoingEmail[];
  failNext(error?: Error): void;
}

export function memorySender(): MemorySender {
  const sent: OutgoingEmail[] = [];
  let failure: Error | null = null;
  return {
    kind: 'memory',
    sent,
    failNext(error = new Error('simulated delivery failure')) {
      failure = error;
    },
    send(message) {
      if (failure !== null) {
        const e = failure;
        failure = null;
        return Promise.reject(e);
      }
      sent.push(message);
      return Promise.resolve();
    },
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* From configuration                                                                               */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The configured sender, or `null` when none is — which the code routes treat as "refuse".
 *
 * The cross-key rules (SMTP needs a host and a sender address; the outbox needs a directory) are
 * enforced by `config.ts#emailConfigIssues` at startup step 1, so by the time this runs the
 * combination is known to be complete. It does not log: `index.ts` builds it before the app (and so
 * before the logger) exists, and reports {@link emailTransportNotice} once it does.
 */
export function emailSenderFromConfig(config: Config): EmailSender | null {
  if (config.EMAIL_TRANSPORT === 'smtp' && config.SMTP_HOST !== undefined && config.EMAIL_FROM !== undefined) {
    return smtpSender({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
      from: config.EMAIL_FROM,
    });
  }
  if (config.EMAIL_TRANSPORT === 'outbox' && config.EMAIL_OUTBOX_DIR !== undefined) {
    return outboxSender(config.EMAIL_OUTBOX_DIR);
  }
  return null;
}

/** What to say at startup about the transport — `warn` for anything but SMTP. */
export function emailTransportNotice(config: Config): {
  level: 'info' | 'warn';
  obj: Record<string, unknown>;
  msg: string;
} {
  if (config.EMAIL_TRANSPORT === 'smtp') {
    return {
      level: 'info',
      obj: { transport: 'smtp', host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE },
      msg: 'sign-in codes are sent over SMTP',
    };
  }
  if (config.EMAIL_TRANSPORT === 'outbox') {
    return {
      level: 'warn',
      obj: { transport: 'outbox', dir: resolve(config.EMAIL_OUTBOX_DIR ?? '') },
      msg: 'EMAIL_TRANSPORT=outbox: sign-in codes are WRITTEN TO DISK, not sent. Development and tests only.',
    };
  }
  return {
    level: 'warn',
    obj: { transport: null },
    msg: 'no EMAIL_TRANSPORT: sign-in codes cannot be sent, so an account that requires a second factor cannot sign in',
  };
}
