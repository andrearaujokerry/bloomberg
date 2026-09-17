// packages/core/src/command/args.ts
//
// Argument mapping (FUNCTIONS.md §2.4 L741-772, CONTRACTS §4.1 L744).
//
//   parseArgs(grammar, args, env) -> { params, problems }
//
// Four steps, in the order §2.4 numbers them:
//
//   1. `KEY=VALUE` tokens are keyed arguments; the key is case-insensitive and must be a key of
//      `grammar.keyed`. An unknown key is an `ARG_PARSE` problem and the token is dropped.
//   2. What is left fills `grammar.positional` in order. A token that fails the current slot's type
//      is tried against the next slot when the current one is optional, which is what makes
//      `HP W` fill `periodicity` and skip the optional `range`. A required slot left unfilled is an
//      `ARG_PARSE` problem.
//   3. Leftovers go to `grammar.rest` joined with single spaces (raw case, quotes already stripped
//      by the tokenizer); with no `rest` slot the first leftover is an `ARG_PARSE` problem.
//   4. Coercion is by `ArgType`, one function per type, exactly as the §2.4 table specifies.
//
// A malformed argument NEVER stops the launch: the function runs with its manifest defaults and the
// footer shows the problem text (§2.3 step 8 L732-734). Nothing here throws, for any input.

import type { ArgType, ParamGrammar, ParamGrammarSlot } from '../functions/manifest.js';
import type { MarketSector } from '../types/instrument.js';
import type { CommandProblem, CommandSecurityInput, ParseEnv } from './parser.js';
import { KEYED_ARG_PATTERN } from './grammar.js';
import { formulaBody, isFormulaToken } from './tokenizer.js';
import {
  addDays,
  daysInMonth,
  formatIsoDate,
  fromEpochDay,
  toEpochDay,
  type IsoDate,
  SUNDAY,
  nthWeekdayOfMonth,
} from '../calendars/calendar.js';
import { XNYS } from '../calendars/nyse.js';
import { parseSecurityRef } from '../ids/securityRef.js';

/* ---------------------------------------------------------------------------------------------- */
/* Result shapes                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

export interface ParseArgsResult {
  params: Record<string, unknown>;
  problems: CommandProblem[];
}

export interface ParseArgsOptions {
  /**
   * Source spans of `args[i]`, so an `ARG_PARSE` problem underlines the token the user typed. The
   * parser passes the token spans; without them every problem carries the empty span `[0, 0]`.
   */
  spans?: readonly (readonly [number, number])[];
}

/** A coercion either produced a value or said why it could not. */
export type ArgCoercion =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };

const ok = (value: unknown): ArgCoercion => ({ ok: true, value });
const no = (message: string): ArgCoercion => ({ ok: false, message });

/* ---------------------------------------------------------------------------------------------- */
/* §2.4 vocabularies                                                                                */
/* ---------------------------------------------------------------------------------------------- */

/** `range`: `1D 5D 1M 3M 6M YTD 1Y 2Y 5Y 10Y MAX` (§2.4 L759). */
export const RANGE_VALUES: readonly string[] = Object.freeze([
  '1D',
  '5D',
  '1M',
  '3M',
  '6M',
  'YTD',
  '1Y',
  '2Y',
  '5Y',
  '10Y',
  'MAX',
]);

/** `boolean`: `1 0 Y N YES NO TRUE FALSE ON OFF` (§2.4 L764). */
export const BOOLEAN_WORDS: Readonly<Record<string, boolean>> = Object.freeze({
  '1': true,
  '0': false,
  Y: true,
  N: false,
  YES: true,
  NO: false,
  TRUE: true,
  FALSE: false,
  ON: true,
  OFF: false,
});

const TENOR = /^(\d{1,4})([DWMY])$/u;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/u;
const DDMMM = /^(\d{1,2})([A-Z]{3})(\d{2}|\d{4})$/u;
const T_MINUS = /^T-(\d{1,4})$/u;
const DATETIME_SUFFIX = /^([\s\S]+)T(\d{1,2}):(\d{2})$/u;
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const NUMBER_SUFFIX = /^([\s\S]*?)(%|BPS?)$/u;
const CODE_WORD = /^[A-Z][A-Z0-9_.-]{0,31}$/u;
const CURRENCY = /^[A-Z]{3}$/u;

const MONTHS: readonly string[] = Object.freeze([
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
]);

/**
 * Two-digit years: `00..68` are 2000s and `69..99` are 1900s — the POSIX pivot, which is what a
 * `9/16/26` option expiry and a `15SEP99` historical date both need.
 */
export const YEAR_PIVOT = 68;

const expandYear = (yy: number): number => (yy <= YEAR_PIVOT ? 2000 + yy : 1900 + yy);

/* ---------------------------------------------------------------------------------------------- */
/* Dates and times                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

const validDate = (y: number, m: number, d: number): IsoDate | null => {
  if (!Number.isInteger(y) || y < 1800 || y > 2200) return null;
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  if (!Number.isInteger(d) || d < 1 || d > daysInMonth(y, m)) return null;
  return formatIsoDate(y, m, d);
};

/** `n` NYSE business days before `from`; `n = 0` is `from` itself (§2.4 `T-<n>`). */
export function businessDaysBefore(from: IsoDate, n: number): IsoDate {
  let day = from;
  let left = Math.min(n, 5000);
  while (left > 0) {
    day = addDays(day, -1);
    if (XNYS.isBusinessDay(day)) left--;
  }
  return day;
}

/**
 * Parse every `date` syntax of §2.4 L760 to `YYYY-MM-DD`: ISO, `M/D/YY`, `M/D/YYYY`, `DDMMMYY`,
 * `DDMMMYYYY`, `TODAY` and `T-<n>` (business days back through the NYSE calendar).
 *
 * `TODAY` and `T-<n>` need today's date, which `packages/core` may not read from the platform
 * clock: `env.today` carries it (the web shell computes it in the exchange's zone). Without it they
 * are rejected rather than guessed.
 */
export function parseArgDate(raw: string, today?: IsoDate): { date: IsoDate } | { why: string } {
  const text = raw.trim().toUpperCase();
  if (text.length === 0) return { why: 'empty date' };

  if (text === 'TODAY' || text === 'T') {
    return today === undefined ? { why: "'TODAY' needs env.today" } : { date: today };
  }

  const tMinus = T_MINUS.exec(text);
  if (tMinus !== null) {
    if (today === undefined) return { why: "'T-n' needs env.today" };
    return { date: businessDaysBefore(today, Number(tMinus[1])) };
  }

  const iso = ISO_DATE.exec(text);
  if (iso !== null) {
    const date = validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return date === null ? { why: `${raw} is not a real date` } : { date };
  }

  const us = US_DATE.exec(text);
  if (us !== null) {
    const yRaw = us[3] ?? '';
    const year = yRaw.length === 2 ? expandYear(Number(yRaw)) : Number(yRaw);
    const date = validDate(year, Number(us[1]), Number(us[2]));
    return date === null ? { why: `${raw} is not a real date` } : { date };
  }

  const ddmmm = DDMMM.exec(text);
  if (ddmmm !== null) {
    const month = MONTHS.indexOf(ddmmm[2] ?? '') + 1;
    const yRaw = ddmmm[3] ?? '';
    const year = yRaw.length === 2 ? expandYear(Number(yRaw)) : Number(yRaw);
    const date = month === 0 ? null : validDate(year, month, Number(ddmmm[1]));
    return date === null ? { why: `${raw} is not a real date` } : { date };
  }

  return { why: `${raw} is not a date (YYYY-MM-DD, M/D/YY, DDMMMYY, TODAY, T-5)` };
}

/**
 * The US Eastern offset in minutes at a local wall time, by the post-2007 rule: daylight time runs
 * from 02:00 on the second Sunday in March to 02:00 on the first Sunday in November. `-240` during
 * daylight time, `-300` otherwise.
 */
export function easternOffsetMinutes(date: IsoDate, minutesOfDay: number): number {
  const year = Number(date.slice(0, 4));
  let start: IsoDate;
  let end: IsoDate;
  try {
    start = nthWeekdayOfMonth(year, 3, SUNDAY, 2);
    end = nthWeekdayOfMonth(year, 11, SUNDAY, 1);
  } catch {
    return -300;
  }
  const minute = toEpochDay(date) * 1440 + minutesOfDay;
  const from = toEpochDay(start) * 1440 + 120;
  const to = toEpochDay(end) * 1440 + 120;
  return minute >= from && minute < to ? -240 : -300;
}

/** `2026-09-15` + `14:30` ET -> `2026-09-15T18:30:00Z` (§2.4 L761). */
export function easternToUtcIso(date: IsoDate, hour: number, minute: number): string {
  const local = hour * 60 + minute;
  const utcMinutes = toEpochDay(date) * 1440 + local - easternOffsetMinutes(date, local);
  const day = Math.floor(utcMinutes / 1440);
  const rest = utcMinutes - day * 1440;
  const hh = Math.floor(rest / 60);
  const mm = rest - hh * 60;
  const pad2 = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));
  return `${fromEpochDay(day)}T${pad2(hh)}:${pad2(mm)}:00Z`;
}

/* ---------------------------------------------------------------------------------------------- */
/* Numbers                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A JS numeric literal with `_`/`,` thousands separators and an optional `%` or `bp` suffix
 * (§2.4 L762): `4.25` -> 4.25, `50bp` -> 0.005, `10%` -> 0.1, `1_000` -> 1000.
 */
export function parseArgNumber(raw: string): { value: number } | { why: string } {
  const text = raw.trim().replace(/[_,]/gu, '');
  if (text.length === 0) return { why: 'empty number' };
  const upper = text.toUpperCase();

  let body = upper;
  let scale = 1;
  const suffix = NUMBER_SUFFIX.exec(upper);
  if (suffix !== null) {
    body = suffix[1] ?? '';
    scale = suffix[2] === '%' ? 1 / 100 : 1 / 10_000;
  }

  if (!NUMERIC.test(body)) return { why: `${raw} is not a number` };
  const n = Number(body);
  if (!Number.isFinite(n)) return { why: `${raw} is not a finite number` };
  return { value: n * scale };
}

/* ---------------------------------------------------------------------------------------------- */
/* Enums                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/** The initials of a snake-case value: `total_return` -> `TR`, `price` -> `P`. */
const initialsOf = (value: string): string =>
  value
    .split(/[_\-\s]+/u)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0))
    .join('')
    .toUpperCase();

/**
 * `enum` (§2.4 L763): exact value, else a unique case-insensitive prefix, else the unique
 * initials form — which is the "manifest-declared short alias" the spec's `ADJ=TR` example needs
 * (`ParamGrammar` carries no alias map, and `TR` is exactly the initials of `total_return`).
 */
export function resolveEnumValue(token: string, values: readonly string[]): ArgCoercion {
  if (values.length === 0) return no('no values are declared for this argument');
  const q = token.trim().toUpperCase();
  if (q.length === 0) return no('empty value');

  const exact = values.find((v) => v.toUpperCase() === q);
  if (exact !== undefined) return ok(exact);

  const prefix = values.filter((v) => v.toUpperCase().startsWith(q));
  if (prefix.length === 1) return ok(prefix[0]);
  if (prefix.length > 1) return no(`${token} could be ${prefix.join(' or ')}`);

  const initials = values.filter((v) => initialsOf(v) === q);
  if (initials.length === 1) return ok(initials[0]);
  if (initials.length > 1) return no(`${token} could be ${initials.join(' or ')}`);

  return no(`${token} is not one of ${values.join(' | ')}`);
}

/* ---------------------------------------------------------------------------------------------- */
/* Securities                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

const lookup = (
  env: ParseEnv,
  tokens: readonly string[],
  opts?: { exchCode?: string; sector?: MarketSector },
): ReturnType<ParseEnv['lookupTicker']> => {
  try {
    const hits = env.lookupTicker([...tokens], opts);
    return Array.isArray(hits) ? hits : [];
  } catch {
    return [];
  }
};

/**
 * `security` (§2.4 L766): a ticker key with a sector, an identifier or a bare ticker resolved by
 * `env.lookupTicker`. The value is a `SecurityRefInput`: `{ id }` when the local index knows it,
 * `{ ref }` when the server must resolve it, `{ formula }` for a computed series.
 */
export function coerceSecurity(token: string, env: ParseEnv): ArgCoercion {
  const body = formulaBody(token);
  if (body !== null) return ok({ formula: body } satisfies CommandSecurityInput);

  const parsed = parseSecurityRef(token);
  if (!parsed.ok) return no(`${token} is not a security`);

  if (parsed.ref.kind !== 'ticker')
    return ok({ ref: parsed.canonical } satisfies CommandSecurityInput);

  const hits = lookup(env, parsed.ref.value.split(' '), {
    ...(parsed.ref.exchCode === undefined ? {} : { exchCode: parsed.ref.exchCode }),
    ...(parsed.ref.sector === undefined ? {} : { sector: parsed.ref.sector }),
  });
  const hit = hits[0];
  if (hit !== undefined) return ok({ id: hit.instrumentId } satisfies CommandSecurityInput);
  return ok({ ref: parsed.canonical } satisfies CommandSecurityInput);
}

/* ---------------------------------------------------------------------------------------------- */
/* The §2.4 coercion table                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Coerce one token to one `ArgType`. `values` is the slot's enum (`ParamGrammarSlot.values`), which
 * `range`, `enum`, `topic`, `currency` and `curve` narrow themselves with when it is given.
 *
 * Total: any token, any type, never throws.
 */
export function coerceArg(
  type: ArgType,
  token: string,
  env: ParseEnv,
  values?: readonly string[],
): ArgCoercion {
  const text = typeof token === 'string' ? token : '';
  const upper = text.trim().toUpperCase();

  switch (type) {
    case 'tenor': {
      return TENOR.test(upper) ? ok(upper) : no(`${text} is not a tenor (10D, 13W, 6M, 10Y)`);
    }
    case 'range': {
      // §2.4 L759: the accepted syntax IS the fixed list; the manifest's enum only *extends* it
      // ("a tenor is accepted when the manifest's enum lists it"). Treating `values` as the whole
      // allowed set would make a manifest that adds `13W` stop accepting `5Y`, a range its own
      // screen supports, so the list and the enum are unioned rather than replaced.
      const extra = values ?? [];
      const hit =
        RANGE_VALUES.find((v) => v === upper) ?? extra.find((v) => v.toUpperCase() === upper);
      if (hit !== undefined) return ok(hit.toUpperCase());
      const allowed = [...RANGE_VALUES, ...extra.filter((v) => !RANGE_VALUES.includes(v.toUpperCase()))];
      return no(`${text} is not a range (${allowed.join(' ')})`);
    }
    case 'date': {
      const d = parseArgDate(text, env.today);
      return 'date' in d ? ok(d.date) : no(d.why);
    }
    case 'datetime': {
      const whole = parseArgDate(text, env.today);
      if ('date' in whole) return ok(easternToUtcIso(whole.date, 0, 0));
      const split = DATETIME_SUFFIX.exec(upper);
      if (split === null) return no(whole.why);
      const day = parseArgDate(split[1] ?? '', env.today);
      if (!('date' in day)) return no(day.why);
      const hour = Number(split[2]);
      const minute = Number(split[3]);
      if (hour > 23 || minute > 59) return no(`${text} is not a real time of day`);
      return ok(easternToUtcIso(day.date, hour, minute));
    }
    case 'number': {
      const n = parseArgNumber(text);
      return 'value' in n ? ok(n.value) : no(n.why);
    }
    case 'int': {
      const n = parseArgNumber(text);
      if (!('value' in n)) return no(n.why);
      return Number.isInteger(n.value) ? ok(n.value) : no(`${text} is not a whole number`);
    }
    case 'enum': {
      return resolveEnumValue(text, values ?? []);
    }
    case 'boolean': {
      const b = BOOLEAN_WORDS[upper];
      return b === undefined ? no(`${text} is not a yes/no value`) : ok(b);
    }
    case 'string': {
      return text.length === 0 ? no('empty value') : ok(text);
    }
    case 'security': {
      return coerceSecurity(text, env);
    }
    case 'topic': {
      if (values !== undefined && values.length > 0) return resolveEnumValue(text, values);
      return CODE_WORD.test(upper) ? ok(upper) : no(`${text} is not a topic code`);
    }
    case 'watchlist': {
      if (upper.length === 0) return no('empty watchlist');
      if (/^\d{1,12}$/u.test(upper)) {
        return ok({ kind: 'watchlist', id: Number(upper) });
      }
      return ok({ kind: 'watchlist', name: text.trim() });
    }
    case 'index': {
      if (!CODE_WORD.test(upper)) return no(`${text} is not an index code`);
      const hit = lookup(env, [upper], { sector: 'Index' })[0];
      return ok(hit === undefined ? { ref: `${upper} Index` } : { id: hit.instrumentId });
    }
    case 'currency': {
      if (!CURRENCY.test(upper)) return no(`${text} is not an ISO 4217 currency code`);
      if (values !== undefined && values.length > 0) return resolveEnumValue(upper, values);
      return ok(upper);
    }
    case 'curve': {
      if (values !== undefined && values.length > 0) return resolveEnumValue(upper, values);
      return CODE_WORD.test(upper) ? ok(upper) : no(`${text} is not a curve id`);
    }
    default: {
      // `ArgType` is a closed union; an unknown type can only come from data, and is an argument
      // the parser must not silently accept.
      return no(`unknown argument type`);
    }
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* parseArgs                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

const EMPTY_GRAMMAR: ParamGrammar = { positional: [] };

const slotValues = (slot: { values?: readonly string[] }): readonly string[] | undefined =>
  slot.values;

/**
 * Map command-line arguments onto a function's `params` (FUNCTIONS.md §2.4).
 *
 * Never throws and never rejects a launch: everything it cannot map becomes an `ARG_PARSE` problem
 * and the function starts with its manifest defaults for that key.
 */
export function parseArgs(
  grammar: ParamGrammar,
  args: readonly string[],
  env: ParseEnv,
  opts: ParseArgsOptions = {},
): ParseArgsResult {
  const params: Record<string, unknown> = {};
  const problems: CommandProblem[] = [];
  const g: ParamGrammar =
    grammar !== null && typeof grammar === 'object' && Array.isArray(grammar.positional)
      ? grammar
      : EMPTY_GRAMMAR;

  const spanOf = (i: number): [number, number] => {
    const s = opts.spans?.[i];
    return s === undefined ? [0, 0] : [s[0], s[1]];
  };
  const fail = (i: number, message: string): void => {
    problems.push({ code: 'ARG_PARSE', span: spanOf(i), message });
  };

  // ── 1. keyed arguments ───────────────────────────────────────────────────────────────────────
  const keyed = g.keyed ?? {};
  const keyByUpper = new Map(Object.keys(keyed).map((k) => [k.toUpperCase(), k]));
  const positionalTokens: { text: string; index: number }[] = [];

  args.forEach((arg, i) => {
    const text = typeof arg === 'string' ? arg : '';
    const m = KEYED_ARG_PATTERN.exec(text);
    if (m === null) {
      positionalTokens.push({ text, index: i });
      return;
    }
    const typedKey = (m[1] ?? '').toUpperCase();
    const value = m[2] ?? '';
    const key = keyByUpper.get(typedKey);
    const spec = key === undefined ? undefined : keyed[key];
    if (key === undefined || spec === undefined) {
      fail(i, `${m[1] ?? ''} is not an argument of this function`);
      return;
    }
    const coerced = coerceArg(spec.type, value, env, slotValues(spec));
    if (coerced.ok) params[spec.name] = coerced.value;
    else fail(i, `${typedKey}: ${coerced.message}`);
  });

  // ── 2. positional slots ──────────────────────────────────────────────────────────────────────
  const positional: readonly ParamGrammarSlot[] = g.positional;
  const filled = new Set<string>();
  let slotIndex = 0;
  let leftoverFrom = positionalTokens.length;

  for (let t = 0; t < positionalTokens.length; t++) {
    const token = positionalTokens[t];
    if (token === undefined) continue;
    let placed = false;

    while (slotIndex < positional.length) {
      const slot = positional[slotIndex];
      if (slot === undefined) {
        slotIndex++;
        continue;
      }
      if (filled.has(slot.name)) {
        // A keyed argument already supplied this key; the slot is spoken for.
        slotIndex++;
        continue;
      }
      const coerced = coerceArg(slot.type, token.text, env, slotValues(slot));
      if (coerced.ok) {
        params[slot.name] = coerced.value;
        filled.add(slot.name);
        slotIndex++;
        placed = true;
        break;
      }
      if (slot.optional === true) {
        // "tried against the next optional slot": skip the optional slot the token does not fit.
        slotIndex++;
        continue;
      }
      // A required slot the token does not fit ends the positional fill; the token is a leftover
      // and the slot is reported as missing below.
      break;
    }

    if (!placed) {
      leftoverFrom = t;
      break;
    }
  }

  // Keyed arguments may have filled positional keys already; mark them so nothing is overwritten.
  for (const slot of positional) {
    if (Object.hasOwn(params, slot.name)) filled.add(slot.name);
  }

  // ── 3. leftovers ─────────────────────────────────────────────────────────────────────────────
  const leftovers = positionalTokens.slice(leftoverFrom);
  if (leftovers.length > 0) {
    const rest = g.rest;
    if (rest !== undefined && typeof rest.name === 'string') {
      params[rest.name] = leftovers.map((l) => l.text).join(' ');
    } else {
      const first = leftovers[0];
      if (first !== undefined)
        fail(first.index, `${first.text} is not an argument of this function`);
    }
  }

  // ── 2 (cont.) required slots with no token ───────────────────────────────────────────────────
  for (const slot of positional) {
    if (slot.optional === true || filled.has(slot.name)) continue;
    problems.push({
      code: 'ARG_PARSE',
      span: spanOf(Math.max(0, args.length - 1)),
      message: `${slot.name} is required`,
    });
  }

  return { params, problems };
}

/** `true` when `text` is a `KEY=VALUE` argument (used by the parser's function-token test). */
export function isKeyedArg(text: unknown): boolean {
  return typeof text === 'string' && KEYED_ARG_PATTERN.test(text);
}

/** Re-exported so a screen can render the formula test the argument mapper uses. */
export { isFormulaToken };
