/**
 * Subject grammar (BUS-02) — ARCHITECTURE §6.1, API.md §6.1.
 *
 * Every subject on the wire is `<family>:<id>` and must match `SUBJECT_ID_PATTERN`, the one regex
 * `sdk/wire/ws.ts` exports as `SubjectId`. That pattern is imported here, never retyped, so the
 * plant and the wire schema cannot drift: `parseSubject` accepts a strict subset of what the regex
 * accepts (a numeric instrument id where the family demands one, `alerts:me` and `sys:status`
 * exactly, a known `n:` scope) and `formatSubject(parseSubject(s)) === s` for every accepted `s`.
 *
 * | Family   | Id                                       | Fields on `sub`                  |
 * | -------- | ---------------------------------------- | -------------------------------- |
 * | `q`      | instrumentId                             | named (quote family)             |
 * | `l`      | mdLineId                                 | named                            |
 * | `b1m`    | instrumentId                             | named                            |
 * | `oc`     | instrumentId                             | named                            |
 * | `r`      | rateCode (`r:SOFR`)                      | named                            |
 * | `c`      | curveId (`c:UST_PAR`)                    | `f: []` allowed                  |
 * | `e`      | seriesCode (`e:CPIAUCSL`)                | `f: []` allowed                  |
 * | `n`      | `all` / `feed:<name>` / `inst:<id>` / `topic:<code>` | `f: []` allowed      |
 * | `alerts` | `me`                                     | `f: []` allowed                  |
 * | `room`   | roomId                                   | `f: []` allowed                  |
 * | `sys`    | `status`                                 | `f: []` allowed                  |
 */

import { SUBJECT_ID_PATTERN } from '@terminal/sdk/wire/ws';

export type SubjectFamily =
  | 'q'
  | 'l'
  | 'b1m'
  | 'oc'
  | 'c'
  | 'r'
  | 'e'
  | 'n'
  | 'alerts'
  | 'room'
  | 'sys';

/** The four `n:<scope>` forms of ARCHITECTURE §6.1. */
export type NewsScope =
  | { kind: 'all' }
  | { kind: 'feed'; name: string }
  | { kind: 'inst'; instrumentId: number }
  | { kind: 'topic'; code: string };

export type ParsedSubject =
  | { family: 'q'; instrumentId: number }
  | { family: 'b1m'; instrumentId: number }
  | { family: 'oc'; instrumentId: number }
  | { family: 'l'; mdLineId: number }
  | { family: 'c'; curveId: string }
  | { family: 'r'; rateCode: string }
  | { family: 'e'; seriesCode: string }
  | { family: 'n'; scope: NewsScope }
  | { family: 'alerts'; target: 'me' }
  | { family: 'room'; roomId: string }
  | { family: 'sys'; topic: 'status' };

/** Every family, in the order the wire regex lists them. */
export const SUBJECT_FAMILIES: readonly SubjectFamily[] = Object.freeze([
  'q',
  'l',
  'b1m',
  'oc',
  'c',
  'r',
  'e',
  'n',
  'alerts',
  'room',
  'sys',
]);

/** Families whose subscription must name fields (`f: []` is `FIELD_UNKNOWN`). */
const QUOTE_FAMILIES: ReadonlySet<SubjectFamily> = new Set(['q', 'l', 'b1m', 'oc', 'r']);

/** Families where `f: []` means "all fields of the subject". */
const ALL_FIELDS_FAMILIES: ReadonlySet<SubjectFamily> = new Set([
  'c',
  'e',
  'n',
  'sys',
  'alerts',
  'room',
]);

/**
 * A database id as it appears in a subject: decimal, no sign, no leading zero, within the safe
 * integer range. Leading zeros are rejected so a parsed subject re-formats to the same text.
 */
const NUMERIC_ID = /^[1-9][0-9]{0,15}$/;

/** A code id (`c:UST_PAR`, `r:SOFR`, `e:CPIAUCSL`, `room:abc-1`): the regex alphabet minus ':'. */
const CODE_ID = /^[A-Za-z0-9_.-]+$/;

function parseNumericId(text: string): number | null {
  if (!NUMERIC_ID.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

function parseNewsScope(text: string): NewsScope | null {
  if (text === 'all') return { kind: 'all' };
  const sep = text.indexOf(':');
  if (sep <= 0 || sep === text.length - 1) return null;
  const kind = text.slice(0, sep);
  const rest = text.slice(sep + 1);
  switch (kind) {
    case 'feed':
      return CODE_ID.test(rest) ? { kind: 'feed', name: rest } : null;
    case 'topic':
      return CODE_ID.test(rest) ? { kind: 'topic', code: rest } : null;
    case 'inst': {
      const id = parseNumericId(rest);
      return id === null ? null : { kind: 'inst', instrumentId: id };
    }
    default:
      return null;
  }
}

/**
 * Parse a subject string. Returns `null` for anything `SUBJECT_ID_PATTERN` rejects and for a
 * well-formed-looking string whose id does not fit its family (`q:abc`, `alerts:you`,
 * `n:feed:`), so a caller never needs a second check against the wire schema.
 */
export function parseSubject(s: string): ParsedSubject | null {
  if (typeof s !== 'string' || !SUBJECT_ID_PATTERN.test(s)) return null;
  const sep = s.indexOf(':');
  const family = s.slice(0, sep);
  const id = s.slice(sep + 1);
  switch (family) {
    case 'q':
    case 'b1m':
    case 'oc': {
      const instrumentId = parseNumericId(id);
      return instrumentId === null ? null : { family, instrumentId };
    }
    case 'l': {
      const mdLineId = parseNumericId(id);
      return mdLineId === null ? null : { family, mdLineId };
    }
    case 'c':
      return CODE_ID.test(id) ? { family, curveId: id } : null;
    case 'r':
      return CODE_ID.test(id) ? { family, rateCode: id } : null;
    case 'e':
      return CODE_ID.test(id) ? { family, seriesCode: id } : null;
    case 'n': {
      const scope = parseNewsScope(id);
      return scope === null ? null : { family, scope };
    }
    case 'alerts':
      return id === 'me' ? { family, target: 'me' } : null;
    case 'room':
      return CODE_ID.test(id) ? { family, roomId: id } : null;
    case 'sys':
      return id === 'status' ? { family, topic: 'status' } : null;
    default:
      return null;
  }
}

/** The canonical text of a parsed subject; `parseSubject(formatSubject(p))` deep-equals `p`. */
export function formatSubject(p: ParsedSubject): string {
  switch (p.family) {
    case 'q':
    case 'b1m':
    case 'oc':
      return `${p.family}:${String(p.instrumentId)}`;
    case 'l':
      return `l:${String(p.mdLineId)}`;
    case 'c':
      return `c:${p.curveId}`;
    case 'r':
      return `r:${p.rateCode}`;
    case 'e':
      return `e:${p.seriesCode}`;
    case 'n':
      return `n:${formatNewsScope(p.scope)}`;
    case 'alerts':
      return 'alerts:me';
    case 'room':
      return `room:${p.roomId}`;
    case 'sys':
      return 'sys:status';
  }
}

export function formatNewsScope(scope: NewsScope): string {
  switch (scope.kind) {
    case 'all':
      return 'all';
    case 'feed':
      return `feed:${scope.name}`;
    case 'inst':
      return `inst:${String(scope.instrumentId)}`;
    case 'topic':
      return `topic:${scope.code}`;
  }
}

/** `q l b1m oc r` — subscriptions must name fields; `f: []` is `FIELD_UNKNOWN` (API.md §6.1). */
export function isQuoteFamily(f: SubjectFamily): boolean {
  return QUOTE_FAMILIES.has(f);
}

/** `c e n sys alerts room` — `f: []` means every field of the subject (API.md §6.1). */
export function allowsAllFields(f: SubjectFamily): boolean {
  return ALL_FIELDS_FAMILIES.has(f);
}

/** The family of a subject string, or `null` when it does not parse. */
export function familyOf(s: string): SubjectFamily | null {
  return parseSubject(s)?.family ?? null;
}

/**
 * The instrument a subject is about, when it is about one: `q:`, `b1m:`, `oc:` and `n:inst:`.
 * `l:` carries an md line, not an instrument, and resolves through `md_lines`.
 */
export function instrumentIdOf(p: ParsedSubject): number | null {
  switch (p.family) {
    case 'q':
    case 'b1m':
    case 'oc':
      return p.instrumentId;
    case 'n':
      return p.scope.kind === 'inst' ? p.scope.instrumentId : null;
    default:
      return null;
  }
}

/** Subject for a composite quote. */
export function quoteSubject(instrumentId: number): string {
  return `q:${String(instrumentId)}`;
}

/** Subject for a single md line. */
export function lineSubject(mdLineId: number): string {
  return `l:${String(mdLineId)}`;
}
