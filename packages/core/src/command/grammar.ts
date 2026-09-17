// packages/core/src/command/grammar.ts
//
// The command line's grammar as DATA (FUNCTIONS.md §2.1 L611-634) plus the shell words and reserved
// keys of §2.6 (L790-817). Nothing here parses anything: `tokenizer.ts` lexes, `parser.ts` decides.
// Keeping the shape of the line in one table is what lets HELP, the key bar and the parser agree
// (HELP lists the shell words from `SHELL_COMMANDS`, the key bar renders `RESERVED_KEYS`).
//
// Totality (QA-05): every predicate here takes `unknown` and answers rather than throwing.

import type { MarketSector } from '../types/instrument.js';
import { MARKET_SECTORS, SECTOR_YELLOW_KEYS } from './sectors.js';

/* ---------------------------------------------------------------------------------------------- */
/* The line                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** The five slots of `[SECURITY] [SECTOR] [FUNCTION] [ARGS] <GO>` (FUNCTIONS.md §2.1). */
export type CommandSlotName = 'security' | 'sector' | 'function' | 'args' | 'go';

export interface CommandSlot {
  readonly name: CommandSlotName;
  readonly optional: boolean;
  /** How the slot is written, for HELP and the placeholder text. */
  readonly syntax: string;
  readonly summary: string;
}

/**
 * `[SECURITY] [SECTOR] [FUNCTION] [ARGS] <GO>` — every slot but GO is optional, which is exactly
 * why the parser returns ranked interpretations instead of one reading.
 */
export const COMMAND_SLOTS: readonly CommandSlot[] = Object.freeze([
  Object.freeze({
    name: 'security',
    optional: true,
    syntax: 'ticker | identifier | formula',
    summary: "'AAPL', '912797VE4', '/isin/US0378331005', '<RATIO(AAPL US Equity, SPX Index)>'",
  }),
  Object.freeze({
    name: 'sector',
    optional: true,
    syntax: 'Equity | Index | Curncy | Govt | Corp | Comdty | Mtge | Muni | Pfd | M-Mkt | Crypto',
    summary: 'case-insensitive; a unique prefix of three characters or more; yellow keys F2..F11',
  }),
  Object.freeze({
    name: 'function',
    optional: true,
    syntax: 'CODE',
    summary: 'a registry code or alias, [A-Z][A-Z0-9]{0,5}',
  }),
  Object.freeze({
    name: 'args',
    optional: true,
    syntax: 'KEY=value | value',
    summary: "interpreted by the function manifest's paramGrammar (§2.4)",
  }),
  Object.freeze({
    name: 'go',
    optional: false,
    syntax: '<GO>',
    summary: 'Enter executes parse(text)[0] or the selected autocomplete row',
  }),
] as const);

/**
 * The §2.1 production rules, verbatim, as the single copy any HELP screen or error message quotes.
 */
export const GRAMMAR_EBNF = `command      := ws* (shell | help | body) ws*
shell        := '/' shellword (ws+ token)*
help         := 'HELP' (ws+ (CODE | text))?
body         := security (ws+ function_part)?
              | function_part
              | e
function_part:= CODE (ws+ args)?
security     := ticker_key | identifier | formula
ticker_key   := ticker_tokens (ws+ exch)? (ws+ sector)?
ticker_tokens:= token (ws+ token){0,4}
exch         := [A-Z]{2}
sector       := 'Equity'|'Index'|'Curncy'|'Govt'|'Corp'|'Comdty'|'Mtge'|'Muni'|'Pfd'|'M-Mkt'|'Crypto'
identifier   := '/' scheme '/' value | bare_id
formula      := '<' formula_text '>' | FNAME '(' balanced ')'
CODE         := [A-Z][A-Z0-9]{0,5}
args         := arg (ws+ arg)*
arg          := KEY '=' value | value
token        := [^ \\t]+`;

/** `CODE := [A-Z][A-Z0-9]{0,5}` (§2.1 L630). The registry decides whether the code EXISTS. */
export const CODE_PATTERN = /^[A-Z][A-Z0-9]{0,5}$/u;

/** `exch := [A-Z]{2}` — an OpenFIGI composite exchange code (§2.1 L624). */
export const EXCH_PATTERN = /^[A-Z]{2}$/u;

/** `KEY=VALUE`: the key is `[A-Za-z][A-Za-z0-9_]*` and the `=` is the first one in the token. */
export const KEYED_ARG_PATTERN = /^([A-Za-z][A-Za-z0-9_]*)=([\s\S]*)$/u;

/** `ticker_tokens := token (ws+ token){0,4}` — at most five (§2.1 L623). */
export const MAX_TICKER_TOKENS = 5;

/**
 * The highest token index the sector anchor scans (`the last index k <= 5`, §2.3 step 4 L708):
 * five ticker tokens, or four plus an exchange code, then the sector itself.
 */
export const MAX_SECTOR_TOKEN_INDEX = 5;

/** The word that opens the help screen (§2.1 L616, §4). */
export const HELP_WORD = 'HELP';

/** `true` when `token` is shaped like a function code — not that the registry has one. */
export function isCodeShape(token: unknown): boolean {
  return typeof token === 'string' && CODE_PATTERN.test(token.toUpperCase());
}

/* ---------------------------------------------------------------------------------------------- */
/* Shell commands (§2.6 L790-795)                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/** One argument of a shell command: a fixed word list, or an integer in a closed range. */
export type ShellArgSpec =
  | { readonly name: string; readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly name: string; readonly kind: 'int'; readonly min: number; readonly max: number };

export interface ShellCommandSpec {
  /** The word after the `/`, lower case. */
  readonly word: string;
  readonly args: readonly ShellArgSpec[];
  /** Shown in HELP under "Shell". */
  readonly summary: string;
  /** `true` when running it emits a `panel.switch` usage event (§2.6 L794). */
  readonly emitsPanelSwitch: boolean;
}

/**
 * Every shell command, in HELP order: `/layout`, `/panel`, `/conflate`, `/theme`, `/clear`,
 * `/logout`, `/trace`, `/version` (FUNCTIONS.md §2.6 L792-794). A leading `/` that is not one of
 * these — and not a `/scheme/value` identifier — is still a shell line; it simply names no command.
 */
export const SHELL_COMMANDS: readonly ShellCommandSpec[] = Object.freeze([
  Object.freeze({
    word: 'layout',
    args: Object.freeze([
      Object.freeze({
        name: 'layout',
        kind: 'enum',
        values: Object.freeze(['1', '2h', '2v', '4']),
      } as const),
    ]),
    summary: 'split the workspace: 1, 2h, 2v or 4 panels',
    emitsPanelSwitch: true,
  }),
  Object.freeze({
    word: 'panel',
    args: Object.freeze([Object.freeze({ name: 'panel', kind: 'int', min: 1, max: 8 } as const)]),
    summary: 'focus panel 1..8',
    emitsPanelSwitch: true,
  }),
  Object.freeze({
    word: 'conflate',
    args: Object.freeze([Object.freeze({ name: 'ms', kind: 'int', min: 50, max: 5000 } as const)]),
    summary: 'set the live conflation interval in milliseconds (50..5000)',
    emitsPanelSwitch: false,
  }),
  Object.freeze({
    word: 'theme',
    args: Object.freeze([
      Object.freeze({
        name: 'theme',
        kind: 'enum',
        values: Object.freeze(['dark', 'light', 'system']),
      } as const),
    ]),
    summary: 'switch the colour theme',
    emitsPanelSwitch: false,
  }),
  Object.freeze({
    word: 'clear',
    args: Object.freeze([]),
    summary: "empty the panel's frame stack",
    emitsPanelSwitch: false,
  }),
  Object.freeze({
    word: 'logout',
    args: Object.freeze([]),
    summary: 'end the session',
    emitsPanelSwitch: false,
  }),
  Object.freeze({
    word: 'trace',
    args: Object.freeze([]),
    summary: 'show the last trace id',
    emitsPanelSwitch: false,
  }),
  Object.freeze({
    word: 'version',
    args: Object.freeze([]),
    summary: 'show the client and server versions',
    emitsPanelSwitch: false,
  }),
] as const);

const SHELL_BY_WORD: ReadonlyMap<string, ShellCommandSpec> = new Map(
  SHELL_COMMANDS.map((c) => [c.word, c]),
);

/** The spec for `/word`, or `undefined`. Case-insensitive; `word` is given without the slash. */
export function shellCommand(word: unknown): ShellCommandSpec | undefined {
  if (typeof word !== 'string') return undefined;
  return SHELL_BY_WORD.get(word.trim().toLowerCase());
}

/** `true` when `/word` names a shell command. */
export function isShellWord(word: unknown): boolean {
  return shellCommand(word) !== undefined;
}

/** One reason a shell line does not run, with the index of the offending argument (`-1` = the word). */
export interface ShellArgProblem {
  readonly argIndex: number;
  readonly message: string;
}

/**
 * Check a shell line's arguments against its spec. Arity, enum membership and integer ranges only;
 * the effects themselves belong to `packages/web`. Never throws.
 */
export function validateShellArgs(
  spec: ShellCommandSpec,
  args: readonly string[],
): ShellArgProblem[] {
  const problems: ShellArgProblem[] = [];

  if (args.length > spec.args.length) {
    problems.push({
      argIndex: spec.args.length,
      message:
        spec.args.length === 0
          ? `/${spec.word} takes no arguments`
          : `/${spec.word} takes ${String(spec.args.length)} argument(s)`,
    });
  }

  spec.args.forEach((argSpec, i) => {
    const given = args[i];
    if (given === undefined || given.length === 0) {
      problems.push({ argIndex: i, message: `/${spec.word} needs a ${argSpec.name}` });
      return;
    }
    if (argSpec.kind === 'enum') {
      const lower = given.toLowerCase();
      if (!argSpec.values.includes(lower)) {
        problems.push({
          argIndex: i,
          message: `${argSpec.name} must be one of ${argSpec.values.join(' | ')}`,
        });
      }
      return;
    }
    const n = Number(given);
    if (!Number.isInteger(n) || n < argSpec.min || n > argSpec.max) {
      problems.push({
        argIndex: i,
        message: `${argSpec.name} must be a whole number in ${String(argSpec.min)}..${String(argSpec.max)}`,
      });
    }
  });

  return problems;
}

/* ---------------------------------------------------------------------------------------------- */
/* Reserved words and keys (§2.6 L797-817)                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Words the function registry may not claim: `HELP` opens the help overlay (§4) and every shell
 * word is taken by §2.6. A manifest whose code or alias collides with one of these is a bug the
 * catalogue test catches.
 */
export const RESERVED_WORDS: readonly string[] = Object.freeze([
  HELP_WORD,
  ...SHELL_COMMANDS.map((c) => c.word.toUpperCase()),
]);

/** `true` when `word` is reserved (case-insensitive). */
export function isReservedWord(word: unknown): boolean {
  return typeof word === 'string' && RESERVED_WORDS.includes(word.trim().toUpperCase());
}

export interface ReservedKey {
  /** `KeyboardEvent.code`-style key name, as §2.6 writes it. */
  readonly key: string;
  readonly action: string;
  readonly semantics: string;
}

/** The global keys a function keymap may never bind (FUNCTIONS.md §2.6 L799-813). */
export const RESERVED_KEYS: readonly ReservedKey[] = Object.freeze([
  Object.freeze({
    key: 'Enter',
    action: 'GO',
    semantics: 'execute parse(text)[0] or the selected autocomplete row',
  }),
  Object.freeze({
    key: 'Escape',
    action: 'CANCEL / MENU',
    semantics: 'overlay, then autocomplete, then draft, then pop the frame stack',
  }),
  Object.freeze({
    key: 'F1',
    action: 'HELP',
    semantics: 'help for the focused function; twice within 10 s opens a ticket',
  }),
  Object.freeze({
    key: 'F2',
    action: 'yellow key Govt',
    semantics: 'insert the Govt sector token',
  }),
  Object.freeze({
    key: 'F3',
    action: 'yellow key Corp',
    semantics: 'insert the Corp sector token',
  }),
  Object.freeze({
    key: 'F4',
    action: 'yellow key Mtge',
    semantics: 'insert the Mtge sector token',
  }),
  Object.freeze({
    key: 'F5',
    action: 'yellow key M-Mkt',
    semantics: 'insert the M-Mkt sector token',
  }),
  Object.freeze({
    key: 'F6',
    action: 'yellow key Muni',
    semantics: 'insert the Muni sector token',
  }),
  Object.freeze({ key: 'F7', action: 'yellow key Pfd', semantics: 'insert the Pfd sector token' }),
  Object.freeze({
    key: 'F8',
    action: 'yellow key Equity',
    semantics: 'insert the Equity sector token',
  }),
  Object.freeze({
    key: 'F9',
    action: 'yellow key Comdty',
    semantics: 'insert the Comdty sector token',
  }),
  Object.freeze({
    key: 'F10',
    action: 'yellow key Index',
    semantics: 'insert the Index sector token',
  }),
  Object.freeze({
    key: 'F11',
    action: 'yellow key Curncy',
    semantics: 'insert the Curncy sector token',
  }),
  Object.freeze({
    key: 'Ctrl+P',
    action: 'PRINT',
    semantics: "export the focused panel's result as CSV",
  }),
  Object.freeze({
    key: 'PageDown',
    action: 'PAGE FWD',
    semantics: 'page a pageable function, else scroll one viewport',
  }),
  Object.freeze({
    key: 'PageUp',
    action: 'PAGE BACK',
    semantics: 'page a pageable function, else scroll one viewport',
  }),
  Object.freeze({
    key: 'Alt+ArrowLeft',
    action: 'frame back',
    semantics: 'walk the frame stack backwards',
  }),
  Object.freeze({
    key: 'Alt+ArrowRight',
    action: 'frame forward',
    semantics: 'walk the frame stack forwards',
  }),
  Object.freeze({
    key: 'Alt+1..Alt+8',
    action: 'focus panel',
    semantics: 'panel.switch usage event',
  }),
  Object.freeze({ key: 'Ctrl+Tab', action: 'next panel', semantics: 'focus the next panel' }),
  Object.freeze({
    key: 'Ctrl+Shift+Tab',
    action: 'previous panel',
    semantics: 'focus the previous panel',
  }),
  Object.freeze({
    key: 'Tab',
    action: 'next focus region',
    semantics: 'command line, screen nodes, key bar',
  }),
  Object.freeze({
    key: 'Shift+Tab',
    action: 'previous focus region',
    semantics: 'command line, screen nodes, key bar',
  }),
  Object.freeze({
    key: 'Ctrl+I',
    action: 'provenance',
    semantics: 'provenance panel for the focused cell',
  }),
  Object.freeze({
    key: 'Ctrl+L',
    action: 'command line',
    semantics: "focus the panel's command line",
  }),
  Object.freeze({
    key: 'Ctrl+E',
    action: 'export grid',
    semantics: 'export the focused grid as /data/csv',
  }),
] as const);

const RESERVED_KEY_NAMES: ReadonlySet<string> = new Set(
  RESERVED_KEYS.flatMap((k) =>
    k.key === 'Alt+1..Alt+8'
      ? ['1', '2', '3', '4', '5', '6', '7', '8'].map((d) => `Alt+${d}`)
      : [k.key],
  ),
);

/** `true` when a function keymap may not bind `key` (§2.6 L797). */
export function isReservedKey(key: unknown): boolean {
  return typeof key === 'string' && RESERVED_KEY_NAMES.has(key.trim());
}

/** Sector → yellow key, the F2..F11 map of §2.1 and §2.6 (`null` for Crypto, which has none). */
export const YELLOW_KEYS: Readonly<Record<MarketSector, string | null>> = SECTOR_YELLOW_KEYS;

/** The sector a yellow key inserts, or `undefined`. */
export function sectorForYellowKey(key: unknown): MarketSector | undefined {
  if (typeof key !== 'string') return undefined;
  const wanted = key.trim().toUpperCase();
  return MARKET_SECTORS.find((s) => (YELLOW_KEYS[s] ?? '').toUpperCase() === wanted);
}
