/**
 * `email/signInCodeEmail.ts` — the sign-in code email, both parts.
 *
 * What is pinned is what matters about an email nobody here can watch being opened: the code is in
 * both parts and in neither the subject nor the preview a locked phone shows, the HTML fetches
 * nothing, and what it interpolates is escaped. How it LOOKS was checked by rendering it in Chrome
 * at desktop and phone widths; a test cannot tell good from ugly.
 */

import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';

import { mailOptions } from '../../../src/email/sender.js';
import { renderSignInCodeEmail } from '../../../src/email/signInCodeEmail.js';

const email = renderSignInCodeEmail({ code: '482915', ttlMinutes: 10 });

describe('the sign-in code email', () => {
  it('carries the code in both parts, and not in the subject', () => {
    expect(email.text).toContain('482915');
    expect(email.html).toContain('482915');
    expect(email.subject).not.toMatch(/\d/);
  });

  it('keeps the code out of the preview a locked phone shows', () => {
    // The HTML part opens with a hidden preheader, and a client previews from it.
    expect(email.preheader).not.toMatch(/\d{6}/);
    const preheaderAt = email.html.indexOf(email.preheader);
    expect(preheaderAt, 'the preheader is in the HTML').toBeGreaterThan(-1);
    expect(preheaderAt, 'and comes before the code').toBeLessThan(email.html.indexOf('482915'));
    // The text part says what it is before it says the code.
    expect(email.text.split('\n')[0]).not.toContain('482915');
  });

  it('fetches nothing: no image, no link, no stylesheet, no web font', () => {
    expect(email.html).not.toMatch(/\ssrc=/i);
    expect(email.html).not.toMatch(/\shref=/i);
    expect(email.html).not.toMatch(/url\(/i);
    expect(email.html).not.toMatch(/https?:\/\//i);
  });

  it('escapes what it interpolates', () => {
    const hostile = renderSignInCodeEmail({ code: '<img src=x onerror=alert(1)>', ttlMinutes: 10 });
    expect(hostile.html).not.toContain('<img');
    expect(hostile.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('tells someone who did not ask for it what it means', () => {
    expect(email.text).toMatch(/someone has your password/i);
    expect(email.html).toMatch(/someone has your password/i);
    expect(email.text).toContain('10 minutes');
    expect(email.html).toContain('10 min');
  });

  it('goes out as multipart/alternative — the MIME a provider receives', async () => {
    // nodemailer's stream transport builds the exact message `smtpSender` would hand to Brevo,
    // without a socket.
    const built = await nodemailer
      .createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
      .sendMail(
        mailOptions('Terminal <codes@example.invalid>', { to: 'a@example.invalid', ...email }),
      );
    const mime = (built.message as Buffer).toString('utf8');
    expect(mime).toMatch(/Content-Type: multipart\/alternative/i);
    expect(mime).toMatch(/Content-Type: text\/plain/i);
    expect(mime).toMatch(/Content-Type: text\/html/i);
    expect(mime).toContain('Subject: Your Terminal sign-in code');
  });

  it('sends text alone when a message has no HTML part', () => {
    const options = mailOptions('a@b.test', { to: 'c@d.test', subject: 's', text: 't' });
    expect(options).not.toHaveProperty('html');
  });
});
