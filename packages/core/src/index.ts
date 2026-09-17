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
