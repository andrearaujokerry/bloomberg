// packages/core/src/functions/manifest.ts
//
// The function framework's normative shape (FUNCTIONS.md §1.2 L50-157). ARCHITECTURE §5.1/§5.2 show
// an earlier copy of these interfaces and is informative only; where the two differ this file wins:
// `variants`, `aliasParams` and `payloadVersion` are additions, and the payload is bound to
// `T extends { variant: string }` rather than `unknown`.
//
// This module is types-only at runtime except for `defineFunction`, which is the identity function
// that gives a manifest literal its inferred `P`/`T` without widening.

import type { z } from 'zod';

import type { AssetClass } from '../types/instrument.js';
import type { FieldId } from '../types/fields.js';

/**
 * Catalogue tier of a function (FUNCTIONS.md §6 L66). Deliberately NOT the data `tier` enum of
 * `types/quote.ts` (`'eod' | 'delayed' | 'realtime'`), which shares the name: one ranks functions
 * by build order, the other ranks entitlements by latency. The package barrel should re-export this
 * one as `FunctionTier` — the alias below exists for exactly that.
 */
export type Tier = 1 | 2 | 3;

/** Collision-free name for the barrel: `export type { FunctionTier } from './functions/manifest.js'`. */
export type FunctionTier = Tier;

export type FunctionCategory =
  | 'reference'
  | 'pricing'
  | 'charting'
  | 'news'
  | 'fundamentals'
  | 'screening'
  | 'rates'
  | 'derivatives'
  | 'portfolio'
  | 'messaging'
  | 'monitor'
  | 'system';

/** Types a command-line argument can be coerced to (§2.4 fixes the accepted syntaxes). */
export type ArgType =
  | 'tenor'
  | 'range'
  | 'date'
  | 'datetime'
  | 'number'
  | 'int'
  | 'enum'
  | 'string'
  | 'security'
  | 'topic'
  | 'watchlist'
  | 'index'
  | 'currency'
  | 'curve'
  | 'boolean';

/** One token position of the command line, mapped onto a key of `params`. */
export interface ParamGrammarSlot {
  name: string;
  type: ArgType;
  values?: readonly string[];
  optional?: boolean;
}

/** A `KEY=value` token of the command line, mapped onto a key of `params`. */
export interface ParamGrammarKeyed {
  name: string;
  type: ArgType;
  values?: readonly string[];
}

/** Maps the tokens after the function code onto `params` (§2.4). */
export interface ParamGrammar {
  /** Positional tokens, in order; an optional slot may not precede a required one. */
  positional: readonly ParamGrammarSlot[];
  /** `'ADJ=TR'` → `params.adjust`; keyed by the uppercase token name. */
  keyed?: Readonly<Record<string, ParamGrammarKeyed>>;
  /** Everything left over as free text: `'N tender offer'` → `params.query`. */
  rest?: { name: string; type: 'text' };
}

/** What the screen subscribes to once the payload is on screen (ARCHITECTURE §6.1 subjects). */
export interface LiveSpec {
  /** `'q:42'`, `'b1m:42'`, `'oc:42'`, `'c:UST_PAR'`, `'r:SOFR'`, `'e:CPIAUCSL'`, `'n:inst:42'`, `'room:7'`. */
  subjects: string[];
  /** `'*'` = the subject's whole field set (API.md §6.1). */
  fields: FieldId[] | '*';
  /** Per-screen override of `hello.conflationMs` (50..5000). */
  conflationMs?: number;
  /** Subjects that must never be shed (default: all subjects of a kv/header block). */
  essential?: string[];
}

export interface CsvColumn {
  id: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'datetime' | 'boolean';
  /** Display hint only — `toCsv` always emits full stored precision (FUNCTIONS.md §1.6 rule 2). */
  decimals?: number;
}

export interface CsvDocument {
  /** `'HP_AAPL_US_Equity_20260915T184128Z.csv'` (API.md §9). */
  filename: string;
  /** `licence_registry.attribution` of every cited source, in provenance idx order. */
  attribution: string[];
  /** `meta.asOf.validAt`. */
  asOf: string;
  columns: CsvColumn[];
  /** One table; multi-block screens use a leading `section` column (FUNCTIONS.md §1.6 rule 3). */
  rows: (string | number | boolean | null)[][];
}

export interface CsvSpec<P, T> {
  filename(params: P, ctx: { display: string | null; asOf: string }): string;
  /** A function when the columns depend on the payload (QM, W, HP fields). */
  columns: CsvColumn[] | ((params: P, payload: T) => CsvColumn[]);
  rows(payload: T, params: P): CsvDocument['rows'];
}

export interface HelpSpec {
  /** One line, ≤ 80 chars, shown in autocomplete and the HELP index. */
  summary: string;
  /** HELP ×1 body; plain text with blank-line paragraphs. */
  description: string;
  /** One per `params` key, same order as the zod object. */
  params: { name: string; text: string; example?: string }[];
  /** Derived from `keymap` when omitted; may add explanations. */
  keys: { key: string; action: string }[];
  /** `licence_registry.source_id` values the function cites. */
  sources: string[];
  /** Function codes offered as next steps. */
  related: string[];
}

export interface KeyBinding {
  /** `'G'`, `'Shift+ArrowUp'`, `'Ctrl+Enter'`, `'1'..'9'` (KeyboardEvent.code-based; §2.6). */
  key: string;
  /** Stable action id the screen switches on: `'open-gp'`, `'cycle-adjust'`, `'page-fwd'`. */
  action: string;
  /** Focus region the binding is active in (default `'always'`). */
  when?: 'grid' | 'chart' | 'form' | 'always';
  /** Shown in HELP and the footer key bar. */
  description: string;
}

export interface FunctionManifest<
  P extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
  T extends { variant: string } = { variant: string },
> {
  /** Canonical mnemonic, uppercase, 1–6 `[A-Z0-9]`, unique across codes AND aliases. */
  code: string;
  /** `'Security Description'`. */
  name: string;
  /** `'IB'` → MSG; never equal to another code or alias. */
  aliases: readonly string[];
  /** Params merged BEFORE the zod parse when launched by that alias: ICVS → `{ curveId: 'SOFR_OIS' }`. */
  aliasParams?: Readonly<Record<string, Record<string, unknown>>>;
  tier: Tier;
  category: FunctionCategory;
  /** `'none'` = takes no security (WEI, TOP, ECO, HELP); `'any'` = security optional (N). */
  assetClasses: readonly AssetClass[] | 'any' | 'none';
  /** true → 422 `NO_SECURITY_CONTEXT` / client `NO_SECURITY_LOADED` without one. */
  requiresSecurity: boolean;
  /** Asset class → `payload.variant` (`'etf'` → `'equity'`); `{}` for `'none'` (variant `'default'`). */
  variants: Readonly<Partial<Record<AssetClass, string>>>;
  /** zod object; EVERY optional key has `.default()`; no transforms that change types. */
  params: P;
  paramGrammar: ParamGrammar;
  /** Entitlement pre-check set for the runner (ARCHITECTURE §10); `null` for `'none'`. */
  fieldIds: (assetClass: AssetClass | null) => FieldId[];
  /** PAGE FWD/BACK semantics; the resolver must honour `ctx.page`. */
  pageable: boolean;
  /** `null` = static screen. */
  live: ((params: z.infer<P>, payload: T) => LiveSpec | null) | null;
  csv: CsvSpec<z.infer<P>, T>;
  help: HelpSpec;
  keymap: readonly KeyBinding[];
  /** `custom` = the ScreenSpec contains a `'custom'` node that owns a canvas (GP, GIP, GC, CRVF). */
  screenKind: 'declarative' | 'custom';
  /** Bumped on any breaking change of `T` (API.md §11); part of `registryVersion`. */
  payloadVersion: number;
  /** Phantom for typing only; never set. */
  _payload?: T;
}

/**
 * A manifest of unknown parameter/payload types.
 *
 * `FunctionManifest<P, T>` is invariant in `P` through `live`/`csv`, so a heterogeneous collection
 * (the generated barrel, the registry) cannot be typed with the defaulted generic: a concrete
 * `live: (params: { range: string }, …)` is not assignable to `live: (params: Record<string, unknown>, …)`
 * under `strictFunctionTypes`. FUNCTIONS.md §1.6 uses `FunctionManifest<any, T>` for the same reason.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFunctionManifest = FunctionManifest<any, any>;

/** Identity function that pins `P` and `T` from the literal instead of widening them. */
export const defineFunction = <P extends z.ZodObject<z.ZodRawShape>, T extends { variant: string }>(
  m: FunctionManifest<P, T>,
): FunctionManifest<P, T> => m;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ParamsOf<M> = M extends FunctionManifest<infer P, any> ? z.infer<P> : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PayloadOf<M> = M extends FunctionManifest<any, infer T> ? T : never;
