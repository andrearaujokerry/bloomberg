/**
 * `http/auth/emailCode.ts` — the arithmetic of the email second factor, in isolation.
 *
 * The integration file (`test/integration/auth/mfaEmail.test.ts`) proves the routes hold the
 * properties; this one pins the pieces they are built from, including the one number that is
 * deliberately stated twice — `MAX_ATTEMPTS` here and `CHECK (attempts BETWEEN 0 AND 5)` in
 * migration 0020 — and must agree.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CODE_LENGTH,
  MAX_ATTEMPTS,
  deriveCodeKey,
  generateCode,
  hashCode,
  hashesMatch,
  maskEmail,
  normaliseCode,
  renderCodeEmail,
} from '../../../src/http/auth/emailCode.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, '..', '..', '..', 'drizzle', 'migrations', '0020_mfa_email_codes.sql');

describe('generateCode', () => {
  it('is always exactly six ASCII digits, leading zeros kept', () => {
    for (let i = 0; i < 5_000; i += 1) {
      expect(generateCode()).toMatch(/^[0-9]{6}$/);
    }
  });

  it('spreads across the whole range — every leading digit appears, including zero', () => {
    // The failure this catches is the unpadded generator: `String(randomInt(0, 10 ** 6))` makes
    // codes like `42913`, which are five digits and never start with 0, so `0` goes missing from
    // the leading position. For a uniform source, ten thousand draws missing any one leading digit
    // is roughly a (9/10)^10000 event.
    const leading = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) leading.add(generateCode()[0] ?? '');
    expect([...leading].sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('does not repeat in a run of a thousand more than chance allows', () => {
    // A birthday bound over 10^6 values: 1,000 draws expect about 0.5 collisions. A stuck or
    // low-entropy source collides constantly; more than five is a one-in-a-million event here.
    const seen = new Set<string>();
    let collisions = 0;
    for (let i = 0; i < 1_000; i += 1) {
      const c = generateCode();
      if (seen.has(c)) collisions += 1;
      seen.add(c);
    }
    expect(collisions).toBeLessThanOrEqual(5);
  });
});

describe('deriveCodeKey — a second key, not the session secret', () => {
  it('is stable for one secret and different for another', () => {
    expect(deriveCodeKey('a-session-secret-long-enough')).toEqual(deriveCodeKey('a-session-secret-long-enough'));
    expect(deriveCodeKey('a-session-secret-long-enough')).not.toEqual(deriveCodeKey('another-secret-entirely'));
  });

  it('is not the secret itself, nor contains it', () => {
    const secret = 'a-session-secret-long-enough';
    const key = deriveCodeKey(secret);
    expect(key.length).toBe(32);
    expect(key.toString('utf8')).not.toContain(secret);
    expect(key.equals(Buffer.from(secret))).toBe(false);
  });
});

describe('hashCode and hashesMatch', () => {
  const key = deriveCodeKey('a-session-secret-long-enough');

  it('produces 32 bytes — what migration 0020 checks with octet_length', () => {
    expect(hashCode(key, 'id', '123456').length).toBe(32);
  });

  it('is keyed: the same code under another key is a different hash', () => {
    const other = deriveCodeKey('another-secret-entirely');
    expect(hashCode(key, 'id', '123456').equals(hashCode(other, 'id', '123456'))).toBe(false);
  });

  it('is salted by the row: the same code in two rows is two hashes', () => {
    expect(hashCode(key, 'row-a', '123456').equals(hashCode(key, 'row-b', '123456'))).toBe(false);
  });

  it('matches only the same code', () => {
    const stored = hashCode(key, 'id', '123456');
    expect(hashesMatch(stored, hashCode(key, 'id', '123456'))).toBe(true);
    expect(hashesMatch(stored, hashCode(key, 'id', '123457'))).toBe(false);
  });

  it('answers false rather than throwing on a length mismatch', () => {
    // `timingSafeEqual` throws on unequal lengths; a corrupted row must read as "no match", not crash.
    expect(hashesMatch(Buffer.alloc(32), Buffer.alloc(31))).toBe(false);
  });
});

describe('normaliseCode — forgiving of spacing, strict about everything else', () => {
  it.each([
    ['123456', '123456'],
    ['123 456', '123456'],
    ['123-456', '123456'],
    [' 12 34 56 ', '123456'],
    ['000000', '000000'],
  ])('accepts %j', (input, expected) => {
    expect(normaliseCode(input)).toBe(expected);
  });

  it.each([
    '12345',
    '1234567',
    'abcdef',
    '12345a',
    '',
    '１２３４５６', // full-width digits: a lookalike, not ASCII
    '12345\u0000',
  ])('refuses %j', (input) => {
    expect(normaliseCode(input)).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    for (const v of [123456, null, undefined, {}, ['123456']]) expect(normaliseCode(v)).toBeNull();
  });
});

describe('maskEmail — recognisable, not readable', () => {
  it.each([
    ['jane.doe@example.com', 'j******e@e*****e.com'],
    ['ab@cd.io', 'a*@c*.io'],
    ['a@b.co', 'a*@b*.co'],
  ])('%s → %s', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });

  it('never contains the whole local part or the whole host', () => {
    const masked = maskEmail('someone.important@corporation.example');
    expect(masked).not.toContain('someone.important');
    expect(masked).not.toContain('corporation');
    expect(masked.endsWith('.example')).toBe(true);
  });

  it('answers something harmless for a malformed address rather than throwing', () => {
    expect(maskEmail('not-an-address')).toBe('***');
    expect(maskEmail('@nouser.com')).toBe('***');
  });
});

describe('renderCodeEmail', () => {
  it('puts the code in the body and NOT in the subject a locked phone shows', () => {
    const email = renderCodeEmail({ code: '482915', ttlMinutes: 10 });
    expect(email.text).toContain('482915');
    expect(email.subject).not.toContain('482915');
    expect(email.subject).not.toMatch(/\d/);
  });

  it('tells someone who did not ask for it what it means', () => {
    const email = renderCodeEmail({ code: '482915', ttlMinutes: 10 });
    expect(email.text).toMatch(/someone has your password/i);
    expect(email.text).toContain('10 minutes');
  });
});

describe('MAX_ATTEMPTS, stated twice on purpose', () => {
  it('agrees with migration 0020’s CHECK — the enforcement and its ceiling are one number', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const match = /attempts\s+integer[^\n]*CHECK \(attempts BETWEEN 0 AND (\d+)\)/.exec(sql);
    expect(match, 'migration 0020 states the ceiling as BETWEEN 0 AND n').not.toBeNull();
    expect(Number(match![1])).toBe(MAX_ATTEMPTS);
  });

  it('and the code length is what the hash and the screen both assume', () => {
    expect(CODE_LENGTH).toBe(6);
  });
});
