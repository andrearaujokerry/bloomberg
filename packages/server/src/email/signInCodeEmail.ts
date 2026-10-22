/**
 * `email/signInCodeEmail.ts` — the sign-in code email: a plain-text part and an HTML part in the
 * terminal's own look (`packages/web/src/theme/tokens.css`, dark theme), sent together as
 * multipart/alternative.
 *
 * What it is built to survive, because an email is rendered by somebody else's program:
 *
 *  - **No image, no link, no web font, no stylesheet to fetch.** Mail clients block remote images
 *    by default and Gmail strips `data:` URIs, so the logo is drawn in text (`>_`, the mark in
 *    `brand/`) and every style is inline. Nothing in the message reaches back to a server, so
 *    opening it tells nobody anything.
 *  - **Tables for layout, `bgcolor` beside `background`.** Outlook's renderer is Word's; it reads
 *    neither flexbox nor `max-width`, and the 480px attribute is what it obeys.
 *  - **Dark on purpose.** `color-scheme: dark` tells clients that re-colour light mail that this
 *    one already is dark, so they leave it alone.
 *
 * And what it is built NOT to do: show the code where a locked phone shows it. The subject never
 * held it; the preview line used to, because a mail client previews the first line of the body
 * and that line was "Your sign-in code is 123456". The HTML part now opens with a hidden preheader
 * that says what the email is without the code — padded so the client does not run on into the
 * body — and the text part states its purpose before the code. The person opening the email sees
 * the code; the lock screen sees that one arrived.
 *
 * Nothing caller-controlled is interpolated except the code and the lifetime, and both are
 * escaped anyway.
 */

export interface SignInCodeEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** The preview line the HTML part opens with — exported so a test can prove it holds no code. */
  readonly preheader: string;
}

/** The dark theme of `packages/web/src/theme/tokens.css`, by name. */
const C = {
  bg: '#000000',
  panel: '#0a0a0a',
  header: '#141414',
  line: '#1f1f1f',
  value: '#f2f2f2',
  amber: '#ffb000',
  muted: '#8c8c8c',
  up: '#37d67a',
  down: '#ff5252',
} as const;

const MONO = "'SF Mono',Menlo,Consolas,'Liberation Mono','Courier New',monospace";

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** One key of the app's key bar (`shell/KeyBar.tsx`), as a table cell a mail client will draw. */
function key(label: string): string {
  return (
    `<td style="padding:0 6px 0 0;"><span style="display:inline-block;border:1px solid ${C.line};` +
    `background:${C.panel};color:${C.value};font-family:${MONO};font-size:11px;line-height:18px;` +
    `padding:0 8px;">${label}</span></td>`
  );
}

export function renderSignInCodeEmail(input: {
  code: string;
  ttlMinutes: number;
}): SignInCodeEmail {
  const code = escapeHtml(input.code);
  const minutes = String(input.ttlMinutes);
  const subject = 'Your Terminal sign-in code';
  const preheader = `Use it to finish signing in. It expires in ${minutes} minutes and works once.`;

  const text = [
    `Use this code to finish signing in to Terminal. It expires in ${minutes} minutes and works once.`,
    '',
    `    ${input.code}`,
    '',
    'If you did not just try to sign in, someone has your password. Change it, and do not share',
    'this code with anyone — no one from Terminal will ever ask you for it.',
  ].join('\n');

  // Zero-width joiners and non-breaking spaces after the preheader: without them a client fills the
  // rest of its preview from the body, which is where the code is.
  const previewPad = '&#8204;&nbsp;'.repeat(90);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};" bgcolor="${C.bg}">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};">${escapeHtml(preheader)}${previewPad}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg};">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="width:100%;max-width:480px;background:${C.panel};border:1px solid ${C.line};">
<tr><td bgcolor="${C.header}" style="background:${C.header};border-bottom:1px solid ${C.line};padding:10px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="font-family:${MONO};font-size:12px;line-height:20px;">
<span style="display:inline-block;width:26px;height:20px;line-height:20px;text-align:center;background:${C.bg};border:1px solid ${C.line};border-radius:5px;color:${C.amber};font-weight:bold;font-size:12px;">&gt;_</span>
&nbsp;<span style="color:${C.amber};font-weight:bold;letter-spacing:2px;">TERMINAL</span>
</td>
<td align="right" style="font-family:${MONO};font-size:11px;line-height:20px;color:${C.muted};letter-spacing:1px;">SIGN-IN</td>
</tr></table>
</td></tr>
<tr><td style="padding:22px 16px 0;font-family:${MONO};font-size:13px;line-height:20px;color:${C.muted};">
<span style="color:${C.amber};">&gt;</span> SIGN-IN CODE &lt;GO&gt;
</td></tr>
<tr><td style="padding:14px 16px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="${C.bg}" style="background:${C.bg};border:1px solid ${C.amber};padding:14px 10px 14px 20px;font-family:${MONO};font-size:34px;line-height:40px;font-weight:bold;letter-spacing:10px;color:${C.amber};">${code}</td>
</tr></table>
</td></tr>
<tr><td style="padding:16px 16px 0;font-family:${MONO};font-size:13px;line-height:20px;color:${C.value};">
Enter it on the sign-in screen to finish signing in.
</td></tr>
<tr><td style="padding:8px 16px 0;font-family:${MONO};font-size:12px;line-height:18px;color:${C.muted};">
<span style="color:${C.up};">&#9679;</span> expires in ${minutes} min &nbsp;&middot;&nbsp; works once
</td></tr>
<tr><td style="padding:22px 16px 20px;font-family:${MONO};font-size:12px;line-height:18px;color:${C.muted};">
<span style="color:${C.down};">!</span> Didn&#39;t just try to sign in? Someone has your password &mdash; change it. Never share this code: no one from Terminal will ask you for it.
</td></tr>
<tr><td bgcolor="${C.header}" style="background:${C.header};border-top:1px solid ${C.line};padding:8px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${key('GO')}${key('CANCEL')}${key('HELP')}</tr></table></td>
<td align="right" style="font-family:${MONO};font-size:11px;color:${C.muted};">terminal</td>
</tr></table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  return { subject, text, html, preheader };
}
