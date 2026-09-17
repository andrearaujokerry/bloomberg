// packages/core/src/command/parser.ts
//
// The command line (FUNCTIONS.md §2.3 L663-739, CONTRACTS §4.1 L667-696, WORKPLAN L591-595).
//
//   parse(raw, env) -> ParsedCommand[]     ranked interpretations, best first, NEVER throws
//   toRunRequest(cmd, env)                 the TERM-03 context rules of §2.5, as a run request
//
// The line is `[SECURITY] [SECTOR] [FUNCTION] [ARGS] <GO>` and every slot is optional, so a typed
// line usually has more than one honest reading: `W` is both the Watchlists function and Wayfair,
// `CF` is Company Filings and CF Industries. `parse` returns every reading it can defend, ordered
// by §3.3's rules with the hard rule R0 first, and `parse(raw)[0]` is what GO executes — the rest
// are the alternatives the autocomplete lists.
//
// The two TERM-03 rules live here and in `toRunRequest`:
//
//   * a function code alone applies to the panel's current security (`GP` on a panel showing AAPL);
//   * a security alone reloads the panel's current function with its params (`AAPL` on a panel
//     showing GP {range:'5Y'} stays on GP {range:'5Y'}), falling back to `DES`.
//
// Totality (QA-05): `parse` accepts any string — 100 kB of astral junk, unbalanced `<`, lone `=`,
// control characters — and always returns at least one interpretation whose every span lies inside
// `[0, raw.length]`. Every collaborator it calls (the registry, `lookupTicker`, `parseSecurityRef`,
// `parseArgs`) is either total by construction or guarded here.

import type { AssetClass, MarketSector, SecurityRef } from '../types/instrument.js';
import type { AnyFunctionManifest } from '../functions/manifest.js';
import type { FunctionRegistry } from '../functions/registry.js';
import type { IsoDate } from '../calendars/calendar.js';
import { parseArgs } from './args.js';
import {
  EXCH_PATTERN,
  HELP_WORD,
  MAX_SECTOR_TOKEN_INDEX,
  MAX_TICKER_TOKENS,
  shellCommand,
  validateShellArgs,
} from './grammar.js';
import {
  formulaBody,
  formulaTokenText,
  joinTokens,
  tokenize,
  type Token,
} from './tokenizer.js';
import { resolveSector } from './sectors.js';
import {
  isIdentifierToken,
  parseSecurityRef,
  type SecurityRefParseOk,
  type SecurityRefProblem,
} from '../ids/securityRef.js';

/* ---------------------------------------------------------------------------------------------- */
/* Contract types (CONTRACTS §4.1 L667-694)                                                         */
/* ---------------------------------------------------------------------------------------------- */

export type CommandShape =
  'empty' | 'shell' | 'help' | 'security' | 'function' | 'security+function' | 'invalid';

export interface CommandProblem {
  code:
    | 'UNKNOWN_FUNCTION'
    | 'UNKNOWN_SECTOR'
    | 'NOT_IN_UNIVERSE'
    | 'BAD_IDENTIFIER'
    | 'ARG_PARSE'
    | 'AMBIGUOUS'
    | 'NO_SECURITY_LOADED'
    | 'NOT_APPLICABLE';
  span: [number, number];
  message: string;
}

export interface CommandSecurity {
  /**
   * Canonical display text as typed, sector appended when inferred (`'AAPL US Equity'`).
   *
   * "Canonical" wins where the two pull apart, exactly as it does for a ticker: typing `AAPL`
   * yields the matched instrument's display text, and a **bare identifier is canonicalised to its
   * `/scheme/value` spelling** — `912797VE4` reads back as `/cusip/912797VE4`. The scheme form is
   * unambiguous where the bare form is not (a nine-character alphanumeric can also be a ticker key),
   * and it is the string the run request carries as `{ ref }` for the server to re-parse, so the
   * autocomplete row shows precisely what GO will execute.
   */
  text: string;
  span: [number, number];
  sectorGiven: boolean;
  ref: SecurityRef | { kind: 'formula'; value: string };
  /** Known when the ticker matched the local index exactly (client) — sent as `{ id }`. */
  instrumentId?: number;
  /** From the local index when known. */
  assetClass?: AssetClass;
}

export interface ParsedCommand {
  raw: string;
  shape: CommandShape;
  security?: CommandSecurity;
  /** Canonical code; `alias` is what was typed when it differs (`IB` -> `MSG`). */
  fn?: { code: string; alias?: string; span: [number, number] };
  args: string[];
  argSpan?: [number, number];
  /** Output of `parseArgs` (§2.4); `undefined` for shape `'security'`. */
  params?: Record<string, unknown>;
  shell?: { word: string; args: string[] };
  help?: { code?: string; query?: string };
  problems: CommandProblem[];
}

export interface PanelContext {
  security: {
    instrumentId: number;
    assetClass: AssetClass;
    marketSector: MarketSector;
    display: string;
  } | null;
  fn: string | null;
  params: Record<string, unknown>;
}

/** One row of the local universe index, as `lookupTicker` returns it. */
export interface TickerHit {
  instrumentId: number;
  assetClass: AssetClass;
  marketSector: MarketSector;
  /** `'AAPL US Equity'` — the canonical display form the command line echoes back. */
  display: string;
}

export interface ParseEnv {
  registry: FunctionRegistry;
  panel: PanelContext;
  /**
   * Longest-prefix ticker lookup against the local universe index (client) or the master (server).
   * Returns the instrumentId(s) whose ticker equals `tokens.join(' ')` (case-insensitive),
   * optionally narrowed by `exchCode`/`sector`; `[]` when unknown.
   */
  lookupTicker(tokens: string[], opts?: { exchCode?: string; sector?: MarketSector }): TickerHit[];
  /**
   * Today in the exchange's calendar, for the `TODAY` and `T-<n>` argument syntaxes (§2.4 L760).
   * `packages/core` may not read the platform clock, so the shell passes the date in; without it
   * those two syntaxes are reported as `ARG_PARSE` rather than guessed.
   */
  today?: IsoDate;
  /** `'p1'..'p8'` — copied into the run request for `usage_events.panel_id` (API.md §5.3). */
  panelId?: string;
}

/** How a security is addressed in a run request (API.md §3 `SecurityRefInput`). */
export type CommandSecurityInput = { id: number } | { ref: string } | { formula: string };

/** The body `toRunRequest` produces (API.md §5.3 `FunctionRunRequest`). */
export interface FunctionRunRequestInput {
  security?: CommandSecurityInput;
  params: Record<string, unknown>;
  panelId?: string;
  launchKind: 'launch';
}

export type RunRequest =
  { code: string; alias?: string; body: FunctionRunRequestInput } | { problem: CommandProblem };

/** The function a bare security falls back to when the panel has none (§2.5 L778). */
export const DEFAULT_FUNCTION = 'DES';

/** The function the autocomplete offers when a security is needed and none is loaded (§2.5 L777). */
export const SECURITY_FINDER_FUNCTION = 'SECF';

/* ---------------------------------------------------------------------------------------------- */
/* Small total helpers                                                                              */
/* ---------------------------------------------------------------------------------------------- */

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

const spanIn = (raw: string, start: number, end: number): [number, number] => {
  const a = clamp(Math.trunc(Number.isFinite(start) ? start : 0), 0, raw.length);
  const b = clamp(Math.trunc(Number.isFinite(end) ? end : 0), a, raw.length);
  return [a, b];
};

const problem = (
  code: CommandProblem['code'],
  message: string,
  span: [number, number],
): CommandProblem => ({ code, message, span });

/** `parseSecurityRef`'s problem vocabulary, lifted into the command line's (CONTRACTS L668). */
const REF_PROBLEM_CODES: Readonly<Record<string, CommandProblem['code']>> = Object.freeze({
  BAD_IDENTIFIER: 'BAD_IDENTIFIER',
  AMBIGUOUS_IDENTIFIER: 'AMBIGUOUS',
  UNKNOWN_SECTOR: 'UNKNOWN_SECTOR',
  NOT_IN_UNIVERSE: 'NOT_IN_UNIVERSE',
  BAD_COUPON: 'BAD_IDENTIFIER',
  BAD_MATURITY: 'BAD_IDENTIFIER',
  BAD_OPTION: 'BAD_IDENTIFIER',
  BAD_TICKER: 'BAD_IDENTIFIER',
  UNSUPPORTED_SCHEME: 'BAD_IDENTIFIER',
});

const liftRefProblems = (
  refProblems: readonly SecurityRefProblem[],
  raw: string,
  offset: number,
): CommandProblem[] =>
  refProblems.flatMap((p) => {
    const code = REF_PROBLEM_CODES[p.code];
    if (code === undefined) return [];
    return [problem(code, p.message, spanIn(raw, offset + p.span[0], offset + p.span[1]))];
  });

const lookup = (
  env: ParseEnv,
  tokens: readonly string[],
  opts?: { exchCode?: string; sector?: MarketSector },
): TickerHit[] => {
  try {
    const hits = env.lookupTicker([...tokens], opts);
    if (!Array.isArray(hits)) return [];
    return hits.filter(
      (h): h is TickerHit =>
        h !== null &&
        typeof h === 'object' &&
        typeof h.instrumentId === 'number' &&
        typeof h.display === 'string',
    );
  } catch {
    return [];
  }
};

const manifestOf = (env: ParseEnv, token: string): AnyFunctionManifest | undefined => {
  // `FunctionRegistry.get` trims what it is given, which is right for an API caller and wrong for a
  // token: `token := [^ \t]+` (§2.1 L633), so a quoted `"YAS   "` is an argument, not the function.
  if (/\s/u.test(token)) return undefined;
  try {
    return env.registry.get(token);
  } catch {
    return undefined;
  }
};

const isFunctionToken = (env: ParseEnv, token: string): boolean =>
  manifestOf(env, token) !== undefined;

/**
 * A token that can be part of a security: non-empty and free of whitespace (`token := [^ \t]+`,
 * §2.1 L633). Both `resolveSector` and `parseSecurityRef` trim and re-split what they are given, so
 * without this guard a quoted `""` or a stray `\r` would vanish from the canonical text and the
 * reading would not survive being typed back (QA-05's idempotence property).
 */
const isTickerToken = (token: Token): boolean => token.text.length > 0 && !/\s/u.test(token.text);

/** Distinct hits, index order kept, with the §3.3 sector default deciding ties across sectors. */
const SECTOR_DEFAULT_BONUS: Readonly<Partial<Record<MarketSector, number>>> = Object.freeze({
  Equity: 4,
  Index: 3,
  Curncy: 2,
  Govt: 2,
  Crypto: 1,
});

const orderHits = (hits: readonly TickerHit[]): TickerHit[] => {
  const seen = new Set<number>();
  const unique = hits.filter((h) => {
    if (seen.has(h.instrumentId)) return false;
    seen.add(h.instrumentId);
    return true;
  });
  return unique
    .map((h, i) => ({ h, i }))
    .sort(
      (a, b) =>
        (SECTOR_DEFAULT_BONUS[b.h.marketSector] ?? 0) -
          (SECTOR_DEFAULT_BONUS[a.h.marketSector] ?? 0) || a.i - b.i,
    )
    .map((e) => e.h);
};

/* ---------------------------------------------------------------------------------------------- */
/* Applicability (§2.5, §3.3 R0)                                                                    */
/* ---------------------------------------------------------------------------------------------- */

interface Applicability {
  /** R0's test: the function may be launched as typed, in this panel context. */
  applicable: boolean;
  problems: CommandProblem[];
}

const coversClass = (manifest: AnyFunctionManifest, assetClass: AssetClass | null): boolean => {
  const classes = manifest.assetClasses;
  if (classes === 'none' || classes === 'any') return true;
  if (assetClass === null) return false;
  return Array.isArray(classes) && classes.includes(assetClass);
};

/**
 * R0's applicability test (§3.3 L920-922): `'none'`, `'any'`, the panel security's class is listed,
 * or the panel is empty and the function does not require a security.
 */
function applicabilityOf(
  manifest: AnyFunctionManifest,
  panel: PanelContext,
  span: [number, number],
): Applicability {
  const problems: CommandProblem[] = [];
  const classes = manifest.assetClasses;

  if (classes === 'none') return { applicable: true, problems };

  const security = panel.security;
  if (security === null) {
    if (manifest.requiresSecurity) {
      problems.push(
        problem(
          'NO_SECURITY_LOADED',
          `${manifest.code} needs a security — load one, or type '${SECURITY_FINDER_FUNCTION} ${manifest.code}'`,
          span,
        ),
      );
      return { applicable: false, problems };
    }
    return { applicable: true, problems };
  }

  if (!coversClass(manifest, security.assetClass)) {
    problems.push(
      problem(
        'NOT_APPLICABLE',
        `${manifest.code} is not applicable to ${security.marketSector}`,
        span,
      ),
    );
    return { applicable: false, problems };
  }
  return { applicable: true, problems };
}

/* ---------------------------------------------------------------------------------------------- */
/* Interpretation assembly                                                                          */
/* ---------------------------------------------------------------------------------------------- */

interface Interpretation {
  cmd: ParsedCommand;
  /** R0: an exact, applicable function code sorts above everything (§2.3 step 7, §3.3 L920). */
  r0: boolean;
  score: number;
  /** Tokens the reading accounts for; a longer reading wins a tie. */
  consumed: number;
  order: number;
}

interface FunctionPart {
  fn: { code: string; alias?: string; span: [number, number] };
  manifest: AnyFunctionManifest;
  args: string[];
  argSpan?: [number, number];
  params: Record<string, unknown>;
  problems: CommandProblem[];
}

/** Read `tokens[at]` as a function code and everything after it as its arguments (§2.3 step 8). */
function functionPart(
  tokens: readonly Token[],
  at: number,
  env: ParseEnv,
  raw: string,
): FunctionPart | null {
  const head = tokens[at];
  if (head === undefined) return null;
  const manifest = manifestOf(env, head.text);
  if (manifest === undefined) return null;

  const argTokens = tokens.slice(at + 1);
  const args = argTokens.map((t) => t.text);
  const spans = argTokens.map((t) => spanIn(raw, t.start, t.end));
  const first = argTokens[0];
  const last = argTokens[argTokens.length - 1];

  const mapped = parseArgs(manifest.paramGrammar, args, env, { spans });

  const alias = head.upper === manifest.code ? undefined : head.upper;
  const aliasParams = alias === undefined ? undefined : manifest.aliasParams?.[alias];

  return {
    fn: {
      code: manifest.code,
      ...(alias === undefined ? {} : { alias }),
      span: spanIn(raw, head.start, head.end),
    },
    manifest,
    args,
    ...(first === undefined || last === undefined
      ? {}
      : { argSpan: spanIn(raw, first.start, last.end) }),
    params: { ...(aliasParams ?? {}), ...mapped.params },
    problems: mapped.problems,
  };
}

/** The `CommandSecurity` of a successfully parsed reference, with the local index consulted. */
function securityOf(
  parsed: SecurityRefParseOk,
  span: [number, number],
  env: ParseEnv,
  hitOverride?: TickerHit,
): { security: CommandSecurity; hit: TickerHit | undefined } {
  const ref = parsed.ref;
  let hit = hitOverride;

  if (hit === undefined && ref.kind === 'ticker') {
    hit = orderHits(
      lookup(env, ref.value.split(' '), {
        ...(ref.exchCode === undefined ? {} : { exchCode: ref.exchCode }),
        ...(ref.sector === undefined ? {} : { sector: ref.sector }),
      }),
    )[0];
  }

  const security: CommandSecurity = {
    text: hit?.display ?? parsed.canonical,
    span,
    sectorGiven: parsed.sectorGiven,
    ref,
    ...(hit === undefined ? {} : { instrumentId: hit.instrumentId, assetClass: hit.assetClass }),
  };
  return { security, hit };
}

const base = (raw: string, shape: CommandShape): ParsedCommand => ({
  raw,
  shape,
  args: [],
  problems: [],
});

/* ---------------------------------------------------------------------------------------------- */
/* parse                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Parse a command line into ranked interpretations, best first (FUNCTIONS.md §2.3).
 *
 * Total: never throws, for any input and any environment; the result always has at least one entry.
 */
export function parse(raw: string, env: ParseEnv): ParsedCommand[] {
  const text = typeof raw === 'string' ? raw : '';
  try {
    const out = parseInner(text, env);
    for (const cmd of out) dedupeProblems(cmd);
    return out.length > 0 ? out : [base(text, 'empty')];
  } catch {
    // Defence in depth: nothing below is allowed to throw, and if something ever does, the command
    // line still answers rather than taking the shell down (QA-05).
    const cmd = base(text, 'invalid');
    cmd.problems.push(
      problem('ARG_PARSE', 'the command line could not be read', spanIn(text, 0, text.length)),
    );
    return [cmd];
  }
}

/**
 * Collapse problems that say the same thing about the same characters.
 *
 * Two layers can notice the same fault: §2.3 step 4's check-digit gate reports `BAD_IDENTIFIER` on
 * `tokens[0]`, and the reading it falls through to re-reports it from `parseSecurityRef`'s own
 * problems. The step is singular in the spec ("adds BAD_IDENTIFIER and falls through") and the
 * footer renders every problem's text, so the user would otherwise read the same complaint twice.
 * The first wording survives, because it is the one the more specific layer chose.
 */
function dedupeProblems(cmd: ParsedCommand): void {
  if (cmd.problems.length < 2) return;
  const seen = new Set<string>();
  const kept: CommandProblem[] = [];
  for (const p of cmd.problems) {
    const key = `${p.code}:${String(p.span[0])}:${String(p.span[1])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(p);
  }
  cmd.problems = kept;
}

function parseInner(raw: string, env: ParseEnv): ParsedCommand[] {
  // 1. tokenize; an empty line is the empty command.
  const tokens = tokenize(raw);
  const head = tokens[0];
  if (head === undefined) return [base(raw, 'empty')];

  // 2. a leading '/' that is not a '/scheme/value' identifier is a shell line (§2.6).
  if (head.text.startsWith('/') && !isIdentifierToken(head.text)) {
    return [shellCommandOf(tokens, head, raw)];
  }

  // 3. HELP (§4).
  if (head.upper === HELP_WORD) return [helpCommandOf(tokens, env, raw)];

  // 4. anchors, in order: sector, identifier, formula.
  const anchored = anchoredInterpretations(tokens, env, raw);
  if (anchored !== null) return rankInterpretations(anchored);

  // 6. no anchor: up to three readings. A token shaped like an identifier whose check digit fails
  //    "adds BAD_IDENTIFIER and falls through" (§2.3 step 4), so the problem rides along.
  const badId = badIdentifierProblem(head, raw);
  const readings = unanchoredInterpretations(tokens, env, raw);
  if (badId !== null) for (const r of readings) r.cmd.problems.unshift(badId);
  return rankInterpretations(readings);
}

/* ── shell ─────────────────────────────────────────────────────────────────────────────────────*/

function shellCommandOf(tokens: readonly Token[], head: Token, raw: string): ParsedCommand {
  const word = head.text.slice(1);
  const argTokens = tokens.slice(1);
  const cmd = base(raw, 'shell');
  cmd.shell = { word, args: argTokens.map((t) => t.text) };
  cmd.args = argTokens.map((t) => t.text);

  const spec = shellCommand(word);
  if (spec === undefined) {
    cmd.problems.push(
      problem(
        'UNKNOWN_FUNCTION',
        `'/${word}' is not a shell command`,
        spanIn(raw, head.start, head.end),
      ),
    );
    return cmd;
  }

  for (const p of validateShellArgs(spec, cmd.shell.args)) {
    const token = p.argIndex >= 0 ? argTokens[p.argIndex] : undefined;
    cmd.problems.push(
      problem(
        'ARG_PARSE',
        p.message,
        token === undefined
          ? spanIn(raw, head.start, head.end)
          : spanIn(raw, token.start, token.end),
      ),
    );
  }
  return cmd;
}

/* ── help ──────────────────────────────────────────────────────────────────────────────────────*/

function helpCommandOf(tokens: readonly Token[], env: ParseEnv, raw: string): ParsedCommand {
  const cmd = base(raw, 'help');
  const second = tokens[1];
  if (second === undefined) {
    cmd.help = {};
    return cmd;
  }
  const manifest = tokens.length === 2 ? manifestOf(env, second.text) : undefined;
  if (manifest !== undefined) {
    cmd.help = { code: manifest.code };
    return cmd;
  }
  cmd.help = { query: raw.slice(second.start).trim() };
  return cmd;
}

/* ── anchored readings (§2.3 steps 4 and 5) ────────────────────────────────────────────────────*/

interface Anchor {
  security: CommandSecurity;
  problems: CommandProblem[];
  /** The first token after the security. */
  restFrom: number;
}

function sectorAnchor(tokens: readonly Token[], env: ParseEnv, raw: string): Anchor | null {
  const last = Math.min(MAX_SECTOR_TOKEN_INDEX, tokens.length - 1);
  for (let k = last; k >= 1; k--) {
    const token = tokens[k];
    if (token === undefined) continue;
    const parts = tokens.slice(0, k + 1);
    if (!parts.every(isTickerToken)) continue;
    const sector = resolveSector(token.upper);
    if (!sector.ok) continue;

    const first = tokens[0];
    if (first === undefined) return null;
    const span = spanIn(raw, first.start, token.end);
    // The reference is rebuilt from the TOKENS, not from `raw.slice`: the tokenizer has already
    // stripped quotes and collapsed nothing, so `"AAPL" Equity` and `AAPL  Equity` read the same
    // way they will read when the canonical text is typed back (the QA-05 idempotence property).
    const text = tokens
      .slice(0, k + 1)
      .map((t) => t.text)
      .join(' ');
    const parsed = parseSecurityRef(text);
    if (!parsed.ok) continue;

    const { security } = securityOf(parsed, span, env);
    // Problem spans offset into `text`, which addresses `raw` only when the two agree character for
    // character; otherwise the whole security is underlined rather than the wrong range.
    const aligned = raw.slice(span[0], span[1]) === text;
    const problems = aligned
      ? liftRefProblems(parsed.problems, raw, span[0])
      : liftRefProblems(parsed.problems, raw, span[0]).map((p) => ({ ...p, span }));
    return { security, problems, restFrom: k + 1 };
  }
  return null;
}

function identifierAnchor(tokens: readonly Token[], env: ParseEnv, raw: string): Anchor | null {
  const head = tokens[0];
  if (head === undefined) return null;
  const span = spanIn(raw, head.start, head.end);
  const parsed = parseSecurityRef(head.text);

  if (parsed.ok && (parsed.form === 'scheme' || parsed.form === 'bare')) {
    const { security } = securityOf(parsed, span, env);
    return { security, problems: liftRefProblems(parsed.problems, raw, span[0]), restFrom: 1 };
  }
  return null;
}

/** A token shaped like an identifier whose check digit fails (§2.3 step 4: add `BAD_IDENTIFIER`). */
const IDENTIFIER_SHAPES: readonly RegExp[] = Object.freeze([
  /^BBG[BCDFGHJKLMNPQRSTVWXYZ0-9]{8}\d$/u, // FIGI
  /^[A-Z]{2}[A-Z0-9]{9}\d$/u, // ISIN
  /^[A-Z0-9]{6}\d{2}\d$/u, // CUSIP (issue + check digits)
  /^[A-Z][A-Z0-9.]{0,5}\d{6}[CP]\d{8}$/u, // OCC, Cboe or OSI form
]);

function badIdentifierProblem(head: Token, raw: string): CommandProblem | null {
  const upper = head.upper;
  if (!/^[A-Z0-9.]+$/u.test(upper)) return null;
  if (!IDENTIFIER_SHAPES.some((re) => re.test(upper))) return null;
  const parsed = parseSecurityRef(head.text);
  if (parsed.ok && (parsed.form === 'scheme' || parsed.form === 'bare')) return null;
  return problem(
    'BAD_IDENTIFIER',
    `${head.text} is shaped like an identifier but its check digit is wrong`,
    spanIn(raw, head.start, head.end),
  );
}

function formulaAnchor(tokens: readonly Token[], raw: string): Anchor | null {
  const head = tokens[0];
  if (head === undefined) return null;
  const body = formulaBody(head.text);
  if (body === null || body.length === 0) return null;
  return {
    security: {
      text: formulaTokenText(body),
      span: spanIn(raw, head.start, head.end),
      sectorGiven: false,
      ref: { kind: 'formula', value: body },
    },
    problems: [],
    restFrom: 1,
  };
}

/**
 * Steps 4 and 5: the first anchor that succeeds fixes the security; `rest[0]` must then be a
 * function token, or the reading keeps the security and reports `UNKNOWN_FUNCTION`, with the bare
 * security offered after it.
 */
function anchoredInterpretations(
  tokens: readonly Token[],
  env: ParseEnv,
  raw: string,
): Interpretation[] | null {
  const head = tokens[0];
  if (head === undefined) return null;

  const anchor =
    sectorAnchor(tokens, env, raw) ??
    identifierAnchor(tokens, env, raw) ??
    formulaAnchor(tokens, raw);
  if (anchor === null) return null;

  const rest = tokens.slice(anchor.restFrom);
  const withSecurity = (shape: CommandShape): ParsedCommand => {
    const cmd = base(raw, shape);
    cmd.security = anchor.security;
    cmd.problems.push(...anchor.problems);
    return cmd;
  };

  const restHead = rest[0];
  if (restHead === undefined) {
    const cmd = withSecurity('security');
    return [interpretation(cmd, env, false, tokens.length)];
  }

  const part = functionPart(tokens, anchor.restFrom, env, raw);
  if (part !== null) {
    const cmd = withSecurity('security+function');
    cmd.fn = part.fn;
    cmd.args = part.args;
    if (part.argSpan !== undefined) cmd.argSpan = part.argSpan;
    cmd.params = part.params;
    cmd.problems.push(
      ...part.problems,
      ...applicableToSecurity(part.manifest, anchor.security, cmd.fn.span),
    );
    return [interpretation(cmd, env, false, tokens.length)];
  }

  // Not a function: the reading keeps the security and complains, and the bare security follows.
  const complaining = withSecurity('security');
  complaining.args = rest.map((t) => t.text);
  complaining.problems.push(
    problem(
      'UNKNOWN_FUNCTION',
      `'${restHead.text}' is not a function code`,
      spanIn(raw, restHead.start, restHead.end),
    ),
  );
  const bare = withSecurity('security');
  return [
    interpretation(complaining, env, false, tokens.length),
    interpretation(bare, env, false, anchor.restFrom),
  ];
}

/** `NOT_APPLICABLE` when the typed function does not cover the typed security's asset class. */
function applicableToSecurity(
  manifest: AnyFunctionManifest,
  security: CommandSecurity,
  span: [number, number],
): CommandProblem[] {
  if (security.assetClass === undefined) return [];
  if (coversClass(manifest, security.assetClass)) return [];
  return [
    problem('NOT_APPLICABLE', `${manifest.code} is not applicable to ${security.text}`, span),
  ];
}

/* ── unanchored readings (§2.3 step 6) ─────────────────────────────────────────────────────────*/

function unanchoredInterpretations(
  tokens: readonly Token[],
  env: ParseEnv,
  raw: string,
): Interpretation[] {
  const out: Interpretation[] = [];
  const head = tokens[0];
  if (head === undefined) return out;

  // F — function first.
  const part = functionPart(tokens, 0, env, raw);
  if (part !== null) {
    const cmd = base(raw, 'function');
    cmd.fn = part.fn;
    cmd.args = part.args;
    if (part.argSpan !== undefined) cmd.argSpan = part.argSpan;
    cmd.params = part.params;
    const applicability = applicabilityOf(part.manifest, env.panel, cmd.fn.span);
    cmd.problems.push(...part.problems, ...applicability.problems);
    out.push(interpretation(cmd, env, applicability.applicable, tokens.length));
  }

  // S — a security the local index knows, without a sector.
  out.push(...securityFirstInterpretations(tokens, env, raw));

  // S+F unknown — nothing matched locally.
  if (out.length === 0) out.push(...unresolvedInterpretation(tokens, env, raw));

  return out;
}

/** The `j` loop of step 6 S: the longest token run the local index knows wins. */
function securityFirstInterpretations(
  tokens: readonly Token[],
  env: ParseEnv,
  raw: string,
): Interpretation[] {
  const maxJ = Math.min(MAX_TICKER_TOKENS - 1, tokens.length - 1);

  for (let j = maxJ; j >= 0; j--) {
    const slice = tokens.slice(0, j + 1);
    if (!slice.every(isTickerToken)) continue;
    const tickerTokens = slice.map((t) => t.upper);
    const next = tokens[j + 1];

    // `AAPL US` — a two-letter token after a known ticker is an exchange code, not a function.
    let exchCode: string | undefined;
    let hits = orderHits(lookup(env, tickerTokens));
    if (
      next !== undefined &&
      EXCH_PATTERN.test(next.upper) &&
      !isFunctionToken(env, next.text) &&
      hits.length > 0
    ) {
      const narrowed = orderHits(lookup(env, tickerTokens, { exchCode: next.upper }));
      if (narrowed.length > 0) {
        hits = narrowed;
        exchCode = next.upper;
      }
    }
    if (hits.length === 0) continue;

    const restFrom = j + 1 + (exchCode === undefined ? 0 : 1);
    const restHead = tokens[restFrom];
    const part = restHead === undefined ? null : functionPart(tokens, restFrom, env, raw);
    if (restHead !== undefined && part === null) return []; // the interpretation is dropped

    const first = slice[0];
    const lastToken = exchCode === undefined ? slice[slice.length - 1] : next;
    if (first === undefined || lastToken === undefined) return [];
    const span = spanIn(raw, first.start, lastToken.end);

    return hits.map((hit) => {
      const ref: SecurityRef = {
        kind: 'ticker',
        value: tickerTokens.join(' '),
        ...(exchCode === undefined ? {} : { exchCode }),
        ...(hit.marketSector === undefined ? {} : { sector: hit.marketSector }),
      };
      const security: CommandSecurity = {
        text: hit.display,
        span,
        sectorGiven: false,
        ref,
        instrumentId: hit.instrumentId,
        assetClass: hit.assetClass,
      };
      const cmd = base(raw, part === null ? 'security' : 'security+function');
      cmd.security = security;
      if (part !== null) {
        cmd.fn = part.fn;
        cmd.args = part.args;
        if (part.argSpan !== undefined) cmd.argSpan = part.argSpan;
        cmd.params = part.params;
        cmd.problems.push(
          ...part.problems,
          ...applicableToSecurity(part.manifest, security, part.fn.span),
        );
      }
      return interpretation(cmd, env, false, tokens.length);
    });
  }
  return [];
}

/** Step 6's last reading: an unresolved ticker the server (or Yahoo) may still know. */
function unresolvedInterpretation(
  tokens: readonly Token[],
  env: ParseEnv,
  raw: string,
): Interpretation[] {
  const head = tokens[0];
  if (head === undefined) return [];

  // `token := [^ \t]+` (§2.1 L633): no ticker contains whitespace. A quoted token that does is an
  // argument syntax used where a security was expected, and reading it as a multi-token ticker key
  // would make `insertText` unparseable ("two words" -> TWO WORDS -> two tokens again).
  const parsed = isTickerToken(head) ? parseSecurityRef(head.text) : null;
  if (parsed?.ok !== true) {
    const cmd = base(raw, 'invalid');
    const first = parsed?.problems[0];
    cmd.problems.push(
      problem(
        'BAD_IDENTIFIER',
        first?.message ?? `'${head.text}' is not a security, a function or a shell command`,
        spanIn(raw, head.start, head.end),
      ),
    );
    return [interpretation(cmd, env, false, tokens.length)];
  }

  const span = spanIn(raw, head.start, head.end);
  const { security } = securityOf(parsed, span, env);
  const cmd = base(raw, 'security');
  cmd.security = security;
  cmd.problems.push(...liftRefProblems(parsed.problems, raw, span[0]));

  const next = tokens[1];
  if (next !== undefined) {
    const part = functionPart(tokens, 1, env, raw);
    if (part === null) {
      cmd.args = tokens.slice(1).map((t) => t.text);
      cmd.problems.push(
        problem(
          'UNKNOWN_FUNCTION',
          `'${next.text}' is not a function code`,
          spanIn(raw, next.start, next.end),
        ),
      );
    } else {
      cmd.shape = 'security+function';
      cmd.fn = part.fn;
      cmd.args = part.args;
      if (part.argSpan !== undefined) cmd.argSpan = part.argSpan;
      cmd.params = part.params;
      cmd.problems.push(...part.problems);
    }
  }
  return [interpretation(cmd, env, false, tokens.length)];
}

/* ── ranking (§2.3 step 7, §3.3) ───────────────────────────────────────────────────────────────*/

/**
 * Score one reading with the §3.3 terms that do not need the universe index: the match itself, the
 * kind prior, the sector default and the applicability penalties. `rank.ts` scores candidates for
 * the autocomplete list with the full formula; the two agree on the ordering of these readings,
 * which is what makes `parse()[0]` the same row as `rank()[0]`.
 */
function interpretation(
  cmd: ParsedCommand,
  env: ParseEnv,
  r0: boolean,
  consumed: number,
): Interpretation {
  let score = 0;
  const panel = env.panel;

  if (cmd.shape === 'function') {
    score = 100;
    const notApplicable = cmd.problems.some((p) => p.code === 'NOT_APPLICABLE');
    const noSecurity = cmd.problems.some((p) => p.code === 'NO_SECURITY_LOADED');
    if (notApplicable) score -= 20;
    else if (noSecurity) score -= 4;
    else score += 12;
  } else if (cmd.shape === 'security' || cmd.shape === 'security+function') {
    const security = cmd.security;
    score = security?.instrumentId === undefined ? 60 : 100;
    if (security !== undefined) {
      const sector = security.ref.kind === 'ticker' ? security.ref.sector : undefined;
      score += sector === undefined ? 0 : (SECTOR_DEFAULT_BONUS[sector] ?? 0);
      if (security.sectorGiven) score += 6;
      if (
        panel.security !== null &&
        security.instrumentId !== undefined &&
        security.instrumentId === panel.security.instrumentId
      ) {
        score += 4;
      }
    }
    if (cmd.shape === 'security+function') score += 2;
  } else if (cmd.shape === 'invalid') {
    score = 0;
  }

  if (cmd.problems.some((p) => p.code === 'NOT_IN_UNIVERSE' || p.code === 'BAD_IDENTIFIER')) {
    score -= 30;
  }

  return { cmd, r0, score, consumed, order: 0 };
}

function rankInterpretations(list: readonly Interpretation[]): ParsedCommand[] {
  return list
    .map((i, order) => ({ ...i, order }))
    .sort(
      (a, b) =>
        Number(b.r0) - Number(a.r0) ||
        b.score - a.score ||
        b.consumed - a.consumed ||
        a.order - b.order,
    )
    .map((i) => i.cmd);
}

/* ---------------------------------------------------------------------------------------------- */
/* insertText (§3.2) — the canonical spelling of a reading                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The command line that re-executes this reading — what an autocomplete row inserts, and the text
 * QA-05 re-parses to prove `parse` is idempotent: `parse(insertTextFor(parse(raw)[0]))[0]` is the
 * same reading, and its own `insertTextFor` is the same string.
 */
export function insertTextFor(cmd: ParsedCommand): string {
  if (cmd.shape === 'empty') return '';
  if (cmd.shape === 'shell') {
    // A shell line is executed verbatim; re-assembling it from the word and its arguments would
    // lose the quoting the tokenizer consumed, so the typed text IS the insert text.
    return cmd.raw.trim();
  }
  if (cmd.shape === 'help') {
    const help = cmd.help ?? {};
    const tail = help.code ?? help.query ?? '';
    return tail.length === 0 ? HELP_WORD : `${HELP_WORD} ${tail}`;
  }
  if (cmd.shape === 'invalid') {
    // Nothing canonical to offer: the line is handed back exactly as typed, which re-parses to this
    // same reading. It is NOT trimmed — `String.trim` also removes `\f`, `\v` and `\n`, which the
    // tokenizer treats as ordinary characters, and dropping them would change the reading.
    return cmd.raw;
  }

  const parts: string[] = [];
  const security = cmd.security;
  if (security !== undefined) {
    parts.push(
      security.ref.kind === 'formula' ? formulaTokenText(security.ref.value) : security.text,
    );
  }
  const fn = cmd.fn;
  if (fn !== undefined) parts.push(fn.alias ?? fn.code);
  const args = joinTokens(cmd.args);
  if (args.length > 0) parts.push(args);
  return parts.join(' ');
}

/* ---------------------------------------------------------------------------------------------- */
/* toRunRequest — the TERM-03 context rules (§2.5 L773-789)                                          */
/* ---------------------------------------------------------------------------------------------- */

const securityInput = (security: CommandSecurity): CommandSecurityInput => {
  if (security.ref.kind === 'formula') return { formula: security.ref.value };
  if (security.instrumentId !== undefined) return { id: security.instrumentId };
  return { ref: security.text };
};

/** A manifest's defaults: `params.safeParse({})` (every optional key has `.default()`, §1.2). */
function manifestDefaults(manifest: AnyFunctionManifest | undefined): Record<string, unknown> {
  if (manifest === undefined) return {};
  // `AnyFunctionManifest` types `params` as `any` (the collection is heterogeneous), so the schema
  // is re-typed structurally here rather than trusted: this is the one call into it.
  const schema = manifest.params as unknown as {
    safeParse?: (value: unknown) => { success: boolean; data?: unknown };
  };
  if (typeof schema.safeParse !== 'function') return {};
  try {
    const parsed = schema.safeParse({});
    if (parsed.success && parsed.data !== null && typeof parsed.data === 'object') {
      return { ...(parsed.data as Record<string, unknown>) };
    }
  } catch {
    /* a schema that refuses an empty object simply has no defaults to offer */
  }
  return {};
}

const bodyOf = (
  env: ParseEnv,
  params: Record<string, unknown>,
  security?: CommandSecurityInput,
): FunctionRunRequestInput => ({
  ...(security === undefined ? {} : { security }),
  params,
  ...(env.panelId === undefined ? {} : { panelId: env.panelId }),
  launchKind: 'launch',
});

/**
 * Turn the reading GO executes into a run request, applying the §2.5 table:
 *
 * | shape | panel has a security | panel empty |
 * | --- | --- | --- |
 * | `function` | run `fn` on the panel security (ignored when `assetClasses:'none'`) | `NO_SECURITY_LOADED` when required, else run with none |
 * | `security` | run `panel.fn` with `panel.params`; not applicable to the new class -> `DES` | `DES` |
 * | `security+function` | both replaced; args over manifest defaults, never over the panel's params | same |
 *
 * Never throws; a reading that cannot run answers `{ problem }`.
 */
export function toRunRequest(cmd: ParsedCommand, env: ParseEnv): RunRequest {
  try {
    return runRequestInner(cmd, env);
  } catch {
    return {
      problem: problem('ARG_PARSE', 'the command could not be run', [0, 0]),
    };
  }
}

function runRequestInner(cmd: ParsedCommand, env: ParseEnv): RunRequest {
  const whole: [number, number] = spanIn(cmd.raw, 0, cmd.raw.length);

  switch (cmd.shape) {
    case 'empty':
      return { problem: problem('NOT_APPLICABLE', 'nothing to run', whole) };
    case 'shell':
      return { problem: problem('NOT_APPLICABLE', 'a shell command runs no function', whole) };
    case 'invalid':
      return {
        problem: cmd.problems[0] ?? problem('UNKNOWN_FUNCTION', 'not a command', whole),
      };
    case 'help': {
      const help = cmd.help ?? {};
      const params: Record<string, unknown> = {
        ...(help.code === undefined ? {} : { code: help.code }),
        ...(help.query === undefined ? {} : { query: help.query }),
      };
      const manifest = manifestOf(env, 'HELP');
      return { code: 'HELP', body: bodyOf(env, { ...manifestDefaults(manifest), ...params }) };
    }
    case 'function':
      return functionRunRequest(cmd, env, whole);
    case 'security':
      return securityRunRequest(cmd, env, whole);
    case 'security+function':
      return securityFunctionRunRequest(cmd, env, whole);
    default:
      return { problem: problem('NOT_APPLICABLE', 'nothing to run', whole) };
  }
}

function functionRunRequest(
  cmd: ParsedCommand,
  env: ParseEnv,
  whole: [number, number],
): RunRequest {
  const fn = cmd.fn;
  if (fn === undefined) return { problem: problem('UNKNOWN_FUNCTION', 'no function', whole) };
  const manifest = manifestOf(env, fn.code);
  if (manifest === undefined) {
    return { problem: problem('UNKNOWN_FUNCTION', `${fn.code} is not a function`, fn.span) };
  }

  const applicability = applicabilityOf(manifest, env.panel, fn.span);
  const firstProblem = applicability.problems[0];
  if (!applicability.applicable && firstProblem !== undefined) return { problem: firstProblem };

  const panelSecurity = env.panel.security;
  const security =
    manifest.assetClasses === 'none' || panelSecurity === null
      ? undefined
      : ({ id: panelSecurity.instrumentId } satisfies CommandSecurityInput);

  return {
    code: manifest.code,
    ...(fn.alias === undefined ? {} : { alias: fn.alias }),
    body: bodyOf(env, { ...manifestDefaults(manifest), ...(cmd.params ?? {}) }, security),
  };
}

function securityRunRequest(
  cmd: ParsedCommand,
  env: ParseEnv,
  whole: [number, number],
): RunRequest {
  const security = cmd.security;
  if (security === undefined) {
    return { problem: problem('NOT_APPLICABLE', 'no security', whole) };
  }

  const panelFn = env.panel.fn;
  const panelManifest = panelFn === null ? undefined : manifestOf(env, panelFn);
  const keepsPanelFn =
    panelManifest !== undefined &&
    (security.assetClass === undefined || coversClass(panelManifest, security.assetClass));

  const manifest = keepsPanelFn ? panelManifest : manifestOf(env, DEFAULT_FUNCTION);
  const code = keepsPanelFn ? (panelManifest?.code ?? DEFAULT_FUNCTION) : DEFAULT_FUNCTION;
  const params = keepsPanelFn
    ? { ...manifestDefaults(manifest), ...env.panel.params }
    : manifestDefaults(manifest);

  return { code, body: bodyOf(env, params, securityInput(security)) };
}

function securityFunctionRunRequest(
  cmd: ParsedCommand,
  env: ParseEnv,
  whole: [number, number],
): RunRequest {
  const fn = cmd.fn;
  const security = cmd.security;
  if (fn === undefined || security === undefined) {
    return { problem: problem('UNKNOWN_FUNCTION', 'no function', whole) };
  }
  const manifest = manifestOf(env, fn.code);
  if (manifest === undefined) {
    return { problem: problem('UNKNOWN_FUNCTION', `${fn.code} is not a function`, fn.span) };
  }
  if (security.assetClass !== undefined && !coversClass(manifest, security.assetClass)) {
    return {
      problem: problem(
        'NOT_APPLICABLE',
        `${manifest.code} is not applicable to ${security.text}`,
        fn.span,
      ),
    };
  }

  const securityRef = manifest.assetClasses === 'none' ? undefined : securityInput(security);
  return {
    code: manifest.code,
    ...(fn.alias === undefined ? {} : { alias: fn.alias }),
    // Args merge over the manifest's defaults, NEVER over the panel's previous params (§2.5 L779).
    body: bodyOf(env, { ...manifestDefaults(manifest), ...(cmd.params ?? {}) }, securityRef),
  };
}
