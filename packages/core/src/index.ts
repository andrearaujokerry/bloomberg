/**
 * `@terminal/core` — the pure domain. Types, enums, schemas, the field dictionary and analytics.
 * No IO, no framework, no ambient clock: `zod` is the only dependency.
 *
 * This barrel is the single import surface; every other package imports from `@terminal/core`.
 */

// ── Clock (ARCHITECTURE L49, L123) ────────────────────────────────────────────────────────────
export type { Clock } from './clock.js';
export { SystemClock, VirtualClock } from './clock.js';

// ── Instrument hierarchy (ARCHITECTURE §4.1, REF-01..03) ──────────────────────────────────────
export type {
  AssetClass,
  MarketSector,
  IdScheme,
  Bitemporal,
  Issuer,
  IssuerEntityType,
  Issue,
  Instrument,
  InstrumentStatus,
  Listing,
  ListingStatus,
  MdLine,
  MdLineKind,
  SecurityRef,
  SecurityRefKind,
  ResolvedRef,
} from './types/instrument.js';

// ── Quote state (ARCHITECTURE §4.2, FEED-03/05/06, TERM-12) ───────────────────────────────────
export type {
  Tier,
  SessionState,
  ValueState,
  Timestamps3,
  ProvRef,
  TickDirection,
  QuoteFields,
  QuoteFieldId,
  LineState,
  DataQualityFlag,
  QuoteState,
  NormalisedUpdate,
} from './types/quote.js';

// ── Field dictionary shapes (API.md §7, API-03/05/07) ─────────────────────────────────────────
export type {
  FieldId,
  FieldClass,
  FieldValue,
  FieldType,
  FieldUnit,
  FieldUpdateFreq,
  FieldSource,
  FieldDeprecation,
  FieldExample,
  FieldDef,
} from './types/fields.js';

// ── Provenance and licences (ARCHITECTURE §9, DATA-09/10, STOR-07) ────────────────────────────
export type { ProvenanceRecord, LicenceKind, LicenceEntry } from './types/provenance.js';

// ── Entitlement (ARCHITECTURE §10, ENTL-01..06) ───────────────────────────────────────────────
export type {
  UsageType,
  ReasonCode,
  EntitlementRequest,
  FieldDecision,
  EntitlementDowngrade,
  EntitlementDecision,
} from './types/entitlement.js';

// ── Function payload conventions (FUNCTIONS.md §1.3) ──────────────────────────────────────────
export type {
  UnavailableReason,
  PayloadProvenance,
  PayloadEntitlementNote,
  PayloadUnavailable,
  PayloadEngine,
  PayloadAdjustment,
  PayloadPage,
  PayloadQuota,
  PayloadMeta,
  Payload,
  ValueCell,
  BasePayload,
} from './types/function.js';

// ── Bars and adjustment (ARCHITECTURE §4.3, DATA_MODEL §20, REF-09) ───────────────────────────
export type { BarInterval, AdjustPolicy, Periodicity, BarSession, Bar } from './types/bars.js';

// ── Hashing (ANAL-08: inputsHash = sha256Hex(canonicalJson(inputs))) ──────────────────────────
export { sha256, sha256Hex, utf8Bytes } from './hash/sha256.js';
export { canonicalJson } from './hash/canonicalJson.js';

// ── Function manifests (FUNCTIONS.md §1.1-1.4 L50-157) ────────────────────────────────────────
// `manifest.ts`'s `Tier` (1 | 2 | 3) is the catalogue tier and collides with the entitlement
// `Tier` above, so it is exported under its unambiguous alias `FunctionTier` only. `ParamsOf` and
// `PayloadOf` likewise come from the generated barrel below, keyed by function code, which is the
// form every consumer uses (FUNCTIONS.md L526-527).
export type {
  FunctionTier,
  FunctionCategory,
  ArgType,
  ParamGrammarSlot,
  ParamGrammarKeyed,
  ParamGrammar,
  LiveSpec,
  CsvColumn,
  CsvDocument,
  CsvSpec,
  HelpSpec,
  KeyBinding,
  FunctionManifest,
  AnyFunctionManifest,
} from './functions/manifest.js';
export { defineFunction } from './functions/manifest.js';

// ── Registry (FUNCTIONS.md §1.7 L508-538) ─────────────────────────────────────────────────────
export { FunctionRegistry, DuplicateFunctionCodeError } from './functions/registry.js';
export { manifests, manifestModules, registry } from './functions/manifests/index.js';
export type { FunctionCode, ParamsOf, PayloadOf } from './functions/manifests/index.js';

// ── CSV export (FUNCTIONS.md §1.6 L474-501, API.md §9) ────────────────────────────────────────
export {
  CSV_LINE_ENDING,
  standardHeaderLines,
  toCsv,
  writeCsv,
  serialiseCell,
  numberToCsv,
  escapeCsvField,
} from './functions/csv.js';
export type { CsvContext, CsvHeaderInput } from './functions/csv.js';

// ── Field dictionary (API-07) ─────────────────────────────────────────────────────────────────
export {
  FIELD_DICTIONARY_VERSION,
  FIELD_DICTIONARY_GENERATED_AT,
  fieldDefs,
  fieldDictionary,
  getField,
  hasField,
  requireField,
  fieldIds,
  listFields,
} from './fields/dictionary.js';
export type { FieldDictionaryDoc } from './fields/dictionary.js';

// ── Formatting — the only formatter in the system (API.md L1356) ──────────────────────────────
export {
  format,
  formatAs,
  formatOf,
  decimalsOf,
  toNumber,
  isoDateFromEpochMs,
  isoDateTimeFromEpochMs,
} from './fields/format.js';
export type { FieldFormat, FormatOptions } from './fields/format.js';

// ── WP-03 ──────────────────────────────────────────────────────────────────────────────────────
// Symbology, the command line, ranking and the formula language. WP-01 owns this file's structure;
// this block is WP-03's export surface, added here because an unexported module is invisible to
// `@terminal/core`'s consumers — WP-08 builds the server-side universe snapshot and runs the same
// `rank()`, and WP-12 parses the command line in the web shell.

// Identifier codecs with check digits (WORKPLAN L581, FUNCTIONS.md §2.3 step 4).
export {
  FIGI_LENGTH,
  FIGI_ALPHABET,
  figiCheckDigit,
  parseFigi,
  isValidFigi,
  toFigi,
} from './ids/figi.js';
export type { FigiProblem, FigiProblemCode, FigiParseResult } from './ids/figi.js';
export {
  ISIN_LENGTH,
  isinCheckDigit,
  isinCountry,
  isinNsin,
  parseIsin,
  isValidIsin,
  toIsin,
} from './ids/isin.js';
export type { IsinProblem, IsinProblemCode, IsinParseResult } from './ids/isin.js';
export {
  CUSIP_LENGTH,
  cusipCheckDigit,
  cusipToIsin,
  parseCusip,
  isValidCusip,
  toCusip,
} from './ids/cusip.js';
export type { CusipProblem, CusipProblemCode, CusipParseResult } from './ids/cusip.js';
export {
  SEDOL_LENGTH,
  sedolCheckDigit,
  parseSedol,
  isValidSedol,
  toSedol,
} from './ids/sedol.js';
export type { SedolProblem, SedolProblemCode, SedolParseResult } from './ids/sedol.js';
export {
  OCC_SYMBOL_LENGTH,
  OCC_STRIKE_SCALE,
  formatOcc,
  occStrikeText,
  parseOcc,
  parseOccOrNull,
  isOccSymbol,
  isCboeOccSymbol,
  isOsiOccSymbol,
  toCboeForm,
  toOsiForm,
} from './ids/occ.js';
export type {
  OccForm,
  OccOption,
  OccOptionLike,
  OccParseResult,
  OccProblem,
  OccProblemCode,
  OccResult,
  OptionRight,
} from './ids/occ.js';
// `pad`/`unpad` are exported under their unambiguous aliases only: the bare names say nothing about
// what is being padded, and `cik.ts` already publishes both spellings (§18.6).
export { CIK_PADDED_LENGTH, padCik, unpadCik, parseCik, isValidCik, cikUrlKey } from './ids/cik.js';
export type { CikProblem, CikProblemCode, CikParseResult } from './ids/cik.js';

// Security references — the eight ref forms (ARCHITECTURE L140-142).
export {
  SECURITY_REF_SCHEMES,
  canonicaliseSecurityRef,
  canonicaliseTicker,
  formatSecurityRef,
  isIdentifierToken,
  isSecurityRef,
  isSecurityRefScheme,
  parseSecurityRef,
  parseSecurityRefOrNull,
} from './ids/securityRef.js';
export type {
  BondRefTerms,
  OptionRefTerms,
  SecurityRefForm,
  SecurityRefParseOk,
  SecurityRefParseFail,
  SecurityRefParseResult,
  SecurityRefProblem,
  SecurityRefProblemCode,
} from './ids/securityRef.js';

// The one name normaliser (§18.7), shared by `refdata/resolve.ts` and the news matcher.
export { foldName, normName, normNameTokens, sameName, stripLegalSuffixes } from './text/normName.js';
export type { NormNameOptions } from './text/normName.js';

// Market sector ↔ asset class (WORKPLAN L588).
export {
  ASSET_CLASS_SECTOR,
  MARKET_SECTORS,
  SECTOR_ALIASES,
  SECTOR_ASSET_CLASSES,
  assetClassesForSector,
  isSectorToken,
  lookupSector,
  resolveSector,
  sectorAllowsAssetClass,
  sectorForAssetClass,
  sectorInUniverse,
  yellowKeyForSector,
} from './command/sectors.js';
export type { SectorLookup, SectorMatchKind, SectorMissReason } from './command/sectors.js';

// The command line (CONTRACTS §4.1 L651-696, FUNCTIONS.md §2).
export { QUOTE, isFormulaToken, formulaBody, formulaTokenText, joinTokens, quoteToken, tokenize } from './command/tokenizer.js';
export type { Token } from './command/tokenizer.js';
export {
  COMMAND_SLOTS,
  GRAMMAR_EBNF,
  HELP_WORD,
  MAX_SECTOR_TOKEN_INDEX,
  MAX_TICKER_TOKENS,
  RESERVED_KEYS,
  RESERVED_WORDS,
  SHELL_COMMANDS,
  isReservedKey,
  isReservedWord,
  isShellWord,
  shellCommand,
  validateShellArgs,
} from './command/grammar.js';
export type { CommandSlot, CommandSlotName, ShellCommandSpec } from './command/grammar.js';
export {
  DEFAULT_FUNCTION,
  SECURITY_FINDER_FUNCTION,
  insertTextFor,
  parse,
  toRunRequest,
} from './command/parser.js';
export type {
  CommandProblem,
  CommandSecurity,
  CommandSecurityInput,
  CommandShape,
  FunctionRunRequestInput,
  PanelContext,
  ParseEnv,
  ParsedCommand,
  RunRequest,
  TickerHit,
} from './command/parser.js';
export {
  BOOLEAN_WORDS,
  RANGE_VALUES,
  coerceArg,
  isKeyedArg,
  parseArgs,
  parseArgDate,
  parseArgNumber,
} from './command/args.js';
export type { ParseArgsOptions, ParseArgsResult } from './command/args.js';

// Autocomplete: the universe index and the ranker (FUNCTIONS.md §3).
export { UniverseIndex, jaccard, normalizeWords, trigramsOf } from './command/index.js';
export type { BuildOptions, CodeHit, TickerLookupHit, TrigramHit } from './command/index.js';
export {
  LOCAL_HIT_MATCH_FLOOR,
  MAX_PER_KIND,
  MAX_RESULTS,
  clampYahooBelowLocal,
  compareCandidates,
  isFunctionApplicable,
  kindPrior,
  popularity,
  rank,
  recencyBoost,
} from './command/rank.js';
export { mruKey } from './search/types.js';
export type {
  Candidate,
  CandidateKind,
  CandidateSource,
  HighlightRange,
  MatchedOn,
  MruRank,
  MruRecord,
  RankContext,
  RankPanelContext,
  UniverseEntry,
  UniverseFunctionTuple,
  UniverseInstrumentTuple,
  UniversePersonTuple,
  UniverseSnapshot,
  UniverseTopicTuple,
} from './search/types.js';

// The formula language (CHRT-07) — what `watchlists.columns[].formula` holds.
export { lexFormula, formulaBody as formulaBodySpan } from './formula/lexer.js';
export type { FormulaLexResult, FormulaToken, FormulaTokenKind } from './formula/lexer.js';
export {
  canonicaliseFormula,
  isFormula,
  parseFormula,
  parseFormulaOrNull,
} from './formula/parser.js';
export type { FormulaParseResult } from './formula/parser.js';
export {
  FORMULA_FUNCTIONS,
  MAX_FORMULA_DEPTH,
  MAX_FORMULA_LENGTH,
  formatFormula,
  formulaDependencies,
  formulaProblem,
  hasErrorNode,
  isSeriesNode,
  lookupFormulaFunction,
  walkFormula,
} from './formula/ast.js';
export type {
  FormulaBinaryOp,
  FormulaDependencies,
  FormulaFunctionName,
  FormulaFunctionSpec,
  FormulaNode,
  FormulaProblem,
  FormulaProblemCode,
  FormulaSpan,
  FormulaUnaryOp,
} from './formula/ast.js';
export { DEFAULT_FORMULA_FIELD, evaluateFormula, evaluateFormulaNode } from './formula/evaluator.js';
export type {
  FormulaContext,
  FormulaEvaluation,
  FormulaInputRead,
  FormulaNaReason,
  FormulaSecurity,
} from './formula/evaluator.js';
