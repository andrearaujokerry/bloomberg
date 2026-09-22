/**
 * BUS-02 — `plant/subjects.ts` against the wire regex (WORKPLAN WP-06 acceptance row 4,
 * ARCHITECTURE §6.1, API.md §6.1).
 *
 * Two invariants, each asserted against BOTH `parseSubject` and `SUBJECT_ID_PATTERN` in the same
 * expectation so the plant's grammar and the SDK's schema can never drift apart:
 *
 *  1. every subject form of ARCHITECTURE §6.1 parses, re-formats to itself, and matches the regex;
 *  2. a corpus of invalid subjects is rejected by the parser AND by the regex — or, for the strict
 *     subset the parser adds (a non-numeric instrument id, `alerts:you`), rejected by the parser
 *     while the regex alone would let it through, which is listed separately and on purpose.
 */

import { SUBJECT_ID_PATTERN, SubjectId } from '@terminal/sdk/wire/ws';
import { describe, expect, it } from 'vitest';

import {
  SUBJECT_FAMILIES,
  allowsAllFields,
  familyOf,
  formatSubject,
  instrumentIdOf,
  isQuoteFamily,
  lineSubject,
  parseSubject,
  quoteSubject,
  type ParsedSubject,
  type SubjectFamily,
} from '../../../src/plant/subjects.js';

/** Every subject form of ARCHITECTURE §6.1, with what it must parse to. */
const VALID: readonly [string, ParsedSubject][] = [
  ['q:42', { family: 'q', instrumentId: 42 }],
  ['q:101', { family: 'q', instrumentId: 101 }],
  ['l:5101', { family: 'l', mdLineId: 5101 }],
  ['b1m:42', { family: 'b1m', instrumentId: 42 }],
  ['oc:42', { family: 'oc', instrumentId: 42 }],
  ['c:UST_PAR', { family: 'c', curveId: 'UST_PAR' }],
  ['c:SOFR_OIS', { family: 'c', curveId: 'SOFR_OIS' }],
  ['r:SOFR', { family: 'r', rateCode: 'SOFR' }],
  ['e:CPIAUCSL', { family: 'e', seriesCode: 'CPIAUCSL' }],
  ['n:all', { family: 'n', scope: { kind: 'all' } }],
  ['n:feed:markets', { family: 'n', scope: { kind: 'feed', name: 'markets' } }],
  ['n:inst:42', { family: 'n', scope: { kind: 'inst', instrumentId: 42 } }],
  ['n:topic:fed-policy', { family: 'n', scope: { kind: 'topic', code: 'fed-policy' } }],
  ['alerts:me', { family: 'alerts', target: 'me' }],
  ['room:abc-123', { family: 'room', roomId: 'abc-123' }],
  ['room:7', { family: 'room', roomId: '7' }],
  ['sys:status', { family: 'sys', topic: 'status' }],
];

/** Rejected by the wire regex — and therefore by the parser. */
const INVALID_ON_THE_WIRE: readonly string[] = [
  '', // empty
  'q', // no separator
  'q:', // 'q:' alone: empty id
  ':42', // empty family
  'Q:1', // families are lower-case
  'quote:42', // unknown family
  'x:1', // unknown family
  'q:4 2', // space inside the id
  ' q:42', // leading space
  'q:42 ', // trailing space
  'q:42\n', // trailing newline (the regex is anchored; `$` must not match before it)
  'q:４２', // full-width digits (unicode)
  'q:42€', // unicode symbol
  'n:topic:金融', // unicode id
  'q:42/1', // '/' is outside the alphabet
  'q:42;drop', // ';' is outside the alphabet
  'q:{42}', // braces
  'q:42?x=1', // query string
  'b1m', // family alone
  'sys:', // empty id on a fixed-id family
];

/**
 * Well-formed on the wire but rejected by the plant: the regex only knows the alphabet, the parser
 * knows what each family's id must be. These are the reason `subAck.rejected[SUBJECT_UNKNOWN]`
 * exists after the schema has already accepted the frame.
 */
const INVALID_FOR_THE_PLANT_ONLY: readonly string[] = [
  'q:abc', // instrument ids are numeric
  'q:0', // and positive
  'q:-1', // no sign
  'q:042', // no leading zero: would not re-format to itself
  'q:1.5', // integral
  'q:1:2', // one id, not two
  'l:x', // md line ids are numeric
  'b1m:AAPL', // instrument id, not a ticker
  'oc:AAPL',
  'alerts:you', // only 'me'
  'alerts:me:too',
  'sys:health', // only 'status'
  'n:feed', // scope with no name
  'n:feed:', // empty name
  'n:inst:AAPL', // inst scope carries an instrument id
  'n:topic', // scope with no code
  'n:weird:1', // unknown scope kind
  'n:', // handled by the regex too, but listed for the parser's own switch
  'c:UST:PAR', // codes do not carry ':'
  'e:', // handled by the regex; parser must agree
];

describe('plant/subjects — every form of ARCHITECTURE §6.1', () => {
  it.each(VALID)('%s parses, re-formats to itself and matches the wire regex', (text, parsed) => {
    const result = parseSubject(text);
    expect(result).toEqual(parsed);
    expect(formatSubject(parsed)).toBe(text);
    expect(formatSubject(result!)).toBe(text);
    // The wire schema and the plant agree, asserted together.
    expect([SUBJECT_ID_PATTERN.test(text), result !== null]).toEqual([true, true]);
    expect(SubjectId.safeParse(text).success).toBe(true);
  });

  it('covers every family the regex names', () => {
    const seen = new Set<SubjectFamily>(VALID.map(([, p]) => p.family));
    for (const family of SUBJECT_FAMILIES) expect(seen.has(family)).toBe(true);
    // And the regex's alternation lists exactly those families, in the plant's order.
    const alternation = /^\^\(([a-z0-9|]+)\):/.exec(SUBJECT_ID_PATTERN.source);
    expect(alternation?.[1]?.split('|')).toEqual([...SUBJECT_FAMILIES]);
  });

  it('parse ∘ format is the identity on the parsed shape', () => {
    for (const [, parsed] of VALID) {
      expect(parseSubject(formatSubject(parsed))).toEqual(parsed);
    }
  });
});

describe('plant/subjects — invalid corpus', () => {
  it.each(INVALID_ON_THE_WIRE.map((s) => [s]))(
    '%j is rejected by BOTH parseSubject and SUBJECT_ID_PATTERN',
    (text) => {
      // One assertion over the pair, so a drift between the two shows up as [true, false].
      expect([SUBJECT_ID_PATTERN.test(text), parseSubject(text) !== null]).toEqual([false, false]);
      expect(SubjectId.safeParse(text).success).toBe(false);
    },
  );

  it.each(INVALID_FOR_THE_PLANT_ONLY.map((s) => [s]))(
    '%j is rejected by parseSubject (the plant is a strict subset of the regex)',
    (text) => {
      expect(parseSubject(text)).toBeNull();
      // The parser never accepts what the regex rejects, whatever the regex says here.
      if (!SUBJECT_ID_PATTERN.test(text)) expect(parseSubject(text)).toBeNull();
    },
  );

  it('never accepts a string the regex rejects (fuzz over the alphabet edges)', () => {
    const samples = [
      'q:1\u0000', // NUL
      'q:1\t', // tab
      'Q:Q',
      'N:all',
      'q:1\u200b', // zero-width space
      'q\u003a1', // ':' spelled as an escape is still ':' — accepted by both
      'q:1\u00e9', // accented letter
    ];
    for (const s of samples) {
      if (!SUBJECT_ID_PATTERN.test(s)) expect(parseSubject(s)).toBeNull();
      else expect(parseSubject(s)).not.toBeNull();
    }
  });
});

describe('plant/subjects — family helpers', () => {
  it('quote families must name fields; the rest allow f: []', () => {
    const quote: SubjectFamily[] = ['q', 'l', 'b1m', 'oc', 'r'];
    const all: SubjectFamily[] = ['c', 'e', 'n', 'sys', 'alerts', 'room'];
    for (const f of quote) {
      expect(isQuoteFamily(f)).toBe(true);
      expect(allowsAllFields(f)).toBe(false);
    }
    for (const f of all) {
      expect(isQuoteFamily(f)).toBe(false);
      expect(allowsAllFields(f)).toBe(true);
    }
    // The two sets partition the families.
    expect(new Set([...quote, ...all])).toEqual(new Set(SUBJECT_FAMILIES));
  });

  it('familyOf, instrumentIdOf and the constructors agree with parseSubject', () => {
    expect(familyOf('q:42')).toBe('q');
    expect(familyOf('bogus')).toBeNull();
    expect(instrumentIdOf(parseSubject('q:42')!)).toBe(42);
    expect(instrumentIdOf(parseSubject('b1m:42')!)).toBe(42);
    expect(instrumentIdOf(parseSubject('n:inst:42')!)).toBe(42);
    expect(instrumentIdOf(parseSubject('n:all')!)).toBeNull();
    expect(instrumentIdOf(parseSubject('l:5101')!)).toBeNull();
    expect(instrumentIdOf(parseSubject('c:UST_PAR')!)).toBeNull();
    expect(quoteSubject(101)).toBe('q:101');
    expect(lineSubject(5101)).toBe('l:5101');
    expect(parseSubject(quoteSubject(101))).toEqual({ family: 'q', instrumentId: 101 });
    expect(parseSubject(lineSubject(5101))).toEqual({ family: 'l', mdLineId: 5101 });
  });
});
