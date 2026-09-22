/**
 * `openfigi.mapping` — the pure half. PROVIDERS.a §6.1 (`POST /v3/mapping`) and §6.2
 * (`POST /v3/search`), WORKPLAN WP-05.
 *
 * Both endpoints share one `ProviderId`, one bucket and one `adapter_version`, and they share
 * `normaliseRecord()` below because a `data[]` element has the same ten fields in each. They
 * differ in exactly two ways, and both are load-bearing:
 *
 *  - **mapping is positional.** The response is an array parallel to the request array: element
 *    *i* answers job *i*, and the payload carries no echo of the job. Losing the index loses the
 *    identity of every row, so {@link normaliseOpenFigiMapping} refuses the whole payload when
 *    `response.length !== jobs.length` (`schema_drift`), exactly as §6.1 requires.
 *  - **search is a relevance list.** It returns an object with `data` and an opaque `next` cursor;
 *    its results are candidates, never master rows (§6.2 — "search proposes, mapping disposes").
 *
 * Nothing here throws (§1.2, QA-05): malformed JSON, a truncated array, an element that is neither
 * `data` nor `warning` nor `error`, a record missing `figi` — each returns a result carrying a
 * `NormaliseProblem` instead.
 *
 * **Deviation from §6.1, carried under §18** (the same one `ingest/jobs/symbologyRefresh.ts`
 * records): §6.1 says `normalise` "re-reads the jobs from `raw.body`". `RawRecord.body` is the
 * *response*; the request body is not on the record — it lives on the replay manifest entry. The
 * jobs are therefore passed in by the caller that built them, and {@link parseOpenFigiJobs} is
 * provided so a replay test (or the fixtures importer) can recover them from the recorded request
 * body byte-for-byte. Passing `null` says "the job list is unknown": the positional answers are
 * still emitted, indexed, and the length check is skipped rather than failed.
 */

import type { AssetClass, MarketSector, NormalisedUpdate } from '@terminal/core';

import type { NormaliseContext, NormaliseProblem, Normalised, RawRecord } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Limits
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Stop pushing per-record problems after this many; the payload is still parsed in full. */
export const MAX_REPORTED_PROBLEMS = 50;

/** §6.2: the search walk stops after three `next` pages (300 candidates). */
export const MAX_SEARCH_PAGES = 3;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Request and payload shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The three `idType`s in use (§6.1): tickers, then CUSIP, then ISIN as the fallback. */
export type OpenFigiIdType = 'TICKER' | 'ID_CUSIP' | 'ID_ISIN';

/** One job of the request array. `exchCode` is `'US'` for the ticker universe. */
export interface OpenFigiJob {
  idType: OpenFigiIdType;
  idValue: string;
  exchCode?: string;
}

/** One `data[]` record, as published. Optional fields are absent on real rows, not empty. */
export interface OpenFigiRecord {
  figi: string;
  name: string;
  ticker: string;
  exchCode: string;
  compositeFIGI: string;
  securityType: string;
  marketSector: string;
  shareClassFIGI?: string;
  securityType2?: string;
  securityDescription?: string;
}

/** One element of the mapping response: data, a warning, or an error — never two of them. */
export type OpenFigiElement =
  | { kind: 'data'; records: OpenFigiRecord[] }
  | { kind: 'warning'; text: string }
  | { kind: 'error'; text: string };

export interface OpenFigiParse {
  elements: OpenFigiElement[];
  problems: NormaliseProblem[];
}

export interface OpenFigiSearchParse {
  candidates: OpenFigiRecord[];
  /** The opaque cursor, or `null` when the result set ends here. */
  next: string | null;
  problems: NormaliseProblem[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row shapes — the typed rows this adapter hands the bitemporal writer
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What one job was answered with, in the job's own position. `job` is `null` when the caller did
 * not supply the request array (see the header note).
 */
export interface OpenFigiAnswer {
  index: number;
  job: OpenFigiJob | null;
  outcome: 'data' | 'warning' | 'error';
  /** The warning or error text; `null` for a `data` element. */
  text: string | null;
  recordCount: number;
}

/**
 * One country-level line — one per distinct `compositeFIGI` (§6.1).
 *
 * `compositeExchCode` is the OpenFIGI composite code (`'US'`, `'GR'`), and it is `null` when the
 * payload contains no record whose `figi === compositeFIGI`: 78 of the 98 composites in the
 * recorded capture are named only by their venue lines, which carry the *venue* code (`'UW'`), and
 * writing that into `instruments.exch_code` would file a Nasdaq listing as a country line.
 */
export interface OpenFigiCompositeRow {
  compositeFigi: string;
  ticker: string;
  compositeExchCode: string | null;
  name: string;
  securityType: string;
  securityType2: string | null;
  marketSector: MarketSector | null;
  shareClassFigi: string | null;
  /** Derived from `securityType` (§6.1); `null` for a type with no home here. */
  assetClass: AssetClass | null;
}

/** One venue-level FIGI — every record whose `figi !== compositeFIGI` (§6.1). */
export interface OpenFigiListingRow {
  figi: string;
  compositeFigi: string;
  localTicker: string;
  exchCode: string;
  name: string;
  securityType: string;
}

/** `identifiers` (CONTRACTS §1.2) without the entity ids, which only the writer can assign. */
export interface OpenFigiIdentifierRow {
  entityKind: 'issue' | 'instrument' | 'listing';
  scheme: 'COMPOSITE_FIGI' | 'SHARE_CLASS_FIGI' | 'FIGI' | 'TICKER_EXCH';
  value: string;
  qualifier: string;
  isPrimary: boolean;
}

/** A `data_exceptions` candidate row (§6.1): an unresolved identifier or a source conflict. */
export interface OpenFigiExceptionRow {
  kind: 'unresolved_identifier' | 'source_conflict';
  entityKind: 'instrument';
  /** The `idType` that missed, or `'compositeFIGI'` for a conflict. */
  field: string;
  candidates: { sourceId: string; value: string }[];
}

export interface OpenFigiMappingRows {
  answers: OpenFigiAnswer[];
  composites: OpenFigiCompositeRow[];
  listings: OpenFigiListingRow[];
  identifiers: OpenFigiIdentifierRow[];
  exceptions: OpenFigiExceptionRow[];
}

export interface OpenFigiSearchRows {
  candidates: OpenFigiRecord[];
  next: string | null;
}

export type OpenFigiRows = { mapping: OpenFigiMappingRows } | { search: OpenFigiSearchRows };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Code-unit ordering. `String.prototype.localeCompare` is locale- and ICU-dependent, and a golden
 * file may not depend on which collation the host happens to ship.
 */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(body: Buffer | string): string {
  return typeof body === 'string' ? body : body.toString('utf8');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

const MARKET_SECTORS: ReadonlySet<string> = new Set<MarketSector>([
  'Equity',
  'Index',
  'Curncy',
  'Govt',
  'Corp',
  'Comdty',
  'Mtge',
  'Muni',
  'Pfd',
  'M-Mkt',
  'Crypto',
]);

/** `market_sector` is OpenFIGI's own enum (§6.1); an unknown value is dropped, never coerced. */
export function marketSectorOf(value: string): MarketSector | null {
  return MARKET_SECTORS.has(value) ? (value as MarketSector) : null;
}

/** The `asset_class` row of §6.1, keyed on the upper-cased `securityType`. */
const ASSET_CLASS_BY_SECURITY_TYPE: ReadonlyMap<string, AssetClass> = new Map<string, AssetClass>([
  ['COMMON STOCK', 'equity'],
  ['REIT', 'equity'],
  ['PREFERENCE', 'equity'],
  ['PREFERRED STOCK', 'equity'],
  ['ETP', 'etf'],
  ['MUTUAL FUND', 'etf'],
  ['INDEX', 'index'],
  ['US GOVERNMENT', 'govt'],
  ['EQUITY OPTION', 'option'],
  ['SPOT', 'fx'],
]);

/** §6.1's derivation. `null` = a security type with no home in `asset_class`. */
export function assetClassForSecurityType(securityType: string): AssetClass | null {
  return ASSET_CLASS_BY_SECURITY_TYPE.get(securityType.trim().toUpperCase()) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The request body ↔ job array
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `JSON.stringify` with no whitespace — §6.1's body, and part of the request key (§3.2). */
export function openFigiMappingBody(jobs: readonly OpenFigiJob[]): string {
  return JSON.stringify(jobs);
}

/**
 * Sort by `(idType, idValue, exchCode)`. Not cosmetic: the body is part of the `requestKey`, so an
 * unsorted list produces a different key on every run and every recorded capture misses (§6.1).
 */
export function sortOpenFigiJobs(jobs: readonly OpenFigiJob[]): OpenFigiJob[] {
  // `'\uffff'` sorts an absent `exchCode` after every present one — the same rule
  // `ingest/jobs/symbologyRefresh.ts` already ships, so the two agree on the body bytes and
  // therefore on the request key.
  return [...jobs].sort(
    (a, b) =>
      cmp(a.idType, b.idType) ||
      cmp(a.idValue, b.idValue) ||
      cmp(a.exchCode ?? '\uffff', b.exchCode ?? '\uffff'),
  );
}

/**
 * Recover the job array from a recorded request body. Pure, and total: anything that is not an
 * array of `{idType, idValue}` objects comes back as `null` rather than a throw, which is what
 * lets a replay test hand the manifest's `body` straight to {@link normaliseOpenFigiMapping}.
 */
export function parseOpenFigiJobs(body: string): OpenFigiJob[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(doc)) return null;
  const jobs: OpenFigiJob[] = [];
  for (const entry of doc) {
    if (!isRecord(entry)) return null;
    const idType = stringField(entry, 'idType');
    const idValue = stringField(entry, 'idValue');
    if (idType === undefined || idValue === undefined) return null;
    if (idType !== 'TICKER' && idType !== 'ID_CUSIP' && idType !== 'ID_ISIN') return null;
    const job: OpenFigiJob = { idType, idValue };
    const exchCode = stringField(entry, 'exchCode');
    if (exchCode !== undefined) job.exchCode = exchCode;
    jobs.push(job);
  }
  return jobs;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Record-level parsing, shared by §6.1 and §6.2
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One `data[]` entry → an {@link OpenFigiRecord}, or `null` when a field the master keys on is
 * missing. FIGIs, tickers and exchange codes are upper-cased (the payload is already upper-case on
 * every recorded row; normalising here means a lower-cased one cannot mint a second identifier).
 * `name` is left exactly as published — it is a proper noun, and case is information.
 */
export function normaliseRecord(entry: unknown): OpenFigiRecord | null {
  if (!isRecord(entry)) return null;
  const figi = stringField(entry, 'figi');
  const name = stringField(entry, 'name');
  const ticker = stringField(entry, 'ticker');
  const exchCode = stringField(entry, 'exchCode');
  const compositeFigi = stringField(entry, 'compositeFIGI');
  const securityType = stringField(entry, 'securityType');
  const marketSector = stringField(entry, 'marketSector');
  if (
    figi === undefined ||
    name === undefined ||
    ticker === undefined ||
    exchCode === undefined ||
    compositeFigi === undefined ||
    securityType === undefined ||
    marketSector === undefined
  ) {
    return null;
  }
  const record: OpenFigiRecord = {
    figi: figi.toUpperCase(),
    name,
    ticker: ticker.toUpperCase(),
    exchCode: exchCode.toUpperCase(),
    compositeFIGI: compositeFigi.toUpperCase(),
    securityType,
    marketSector,
  };
  const shareClassFigi = stringField(entry, 'shareClassFIGI');
  if (shareClassFigi !== undefined) record.shareClassFIGI = shareClassFigi.toUpperCase();
  const securityType2 = stringField(entry, 'securityType2');
  if (securityType2 !== undefined) record.securityType2 = securityType2;
  const securityDescription = stringField(entry, 'securityDescription');
  if (securityDescription !== undefined) record.securityDescription = securityDescription;
  return record;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §6.1 — POST /v3/mapping
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The mapping response → positional elements.
 *
 * @param jobs the request array, or `null` when it is not known (the length check is then skipped).
 */
export function parseOpenFigiMapping(
  body: Buffer | string,
  jobs: readonly OpenFigiJob[] | null,
): OpenFigiParse {
  let doc: unknown;
  try {
    doc = JSON.parse(textOf(body));
  } catch (err) {
    return { elements: [], problems: [{ kind: 'parse_error', detail: messageOf(err) }] };
  }
  if (!Array.isArray(doc)) {
    return {
      elements: [],
      problems: [{ kind: 'schema_drift', detail: 'openfigi /v3/mapping did not return an array' }],
    };
  }
  if (jobs !== null && doc.length !== jobs.length) {
    return {
      elements: [],
      problems: [
        {
          kind: 'schema_drift',
          detail:
            `openfigi /v3/mapping answered ${String(doc.length)} elements for ` +
            `${String(jobs.length)} jobs; the response is positional, so the whole payload is ` +
            'dropped',
        },
      ],
    };
  }

  const problems: NormaliseProblem[] = [];
  const elements: OpenFigiElement[] = [];
  doc.forEach((entry: unknown, index: number) => {
    if (!isRecord(entry)) {
      elements.push({ kind: 'error', text: 'element is not an object' });
      problems.push({
        kind: 'schema_drift',
        detail: 'openfigi element is not an object',
        path: `/${String(index)}`,
      });
      return;
    }
    const error = stringField(entry, 'error');
    if (error !== undefined) {
      elements.push({ kind: 'error', text: error });
      return;
    }
    const warning = stringField(entry, 'warning');
    if (warning !== undefined) {
      elements.push({ kind: 'warning', text: warning });
      return;
    }
    const data = entry.data;
    if (!Array.isArray(data)) {
      elements.push({ kind: 'error', text: 'element carries neither data, warning nor error' });
      problems.push({
        kind: 'schema_drift',
        detail: 'openfigi element carries neither data, warning nor error',
        path: `/${String(index)}`,
      });
      return;
    }
    const records: OpenFigiRecord[] = [];
    data.forEach((raw: unknown, position: number) => {
      const record = normaliseRecord(raw);
      if (record === null) {
        if (problems.length < MAX_REPORTED_PROBLEMS) {
          problems.push({
            kind: 'field_dropped',
            detail:
              'openfigi record is missing one of figi/name/ticker/exchCode/compositeFIGI/' +
              'securityType/marketSector',
            path: `/${String(index)}/data/${String(position)}`,
          });
        }
        return;
      }
      records.push(record);
    });
    elements.push({ kind: 'data', records });
  });

  return { elements, problems };
}

/** Identity of an identifier row, so the same one is never emitted twice. */
function identifierKey(row: OpenFigiIdentifierRow): string {
  return `${row.entityKind}|${row.scheme}|${row.value}|${row.qualifier}`;
}

/**
 * `POST /v3/mapping` → the rows of §6.1.
 *
 * Emits no `NormalisedUpdate`: OpenFIGI publishes no market data and the master has no plant
 * subject (§6.1, "no `md_lines` row, no plant subject").
 *
 * Row order is document order — first appearance of a `compositeFIGI` wins its composite row —
 * so the golden is a function of the bytes alone.
 */
export function normaliseOpenFigiMapping(
  raw: RawRecord,
  _ctx: NormaliseContext,
  jobs: readonly OpenFigiJob[] | null,
): Normalised<OpenFigiMappingRows> {
  const parsed = parseOpenFigiMapping(raw.body, jobs);
  const problems: NormaliseProblem[] = [...parsed.problems];

  const answers: OpenFigiAnswer[] = [];
  const exceptions: OpenFigiExceptionRow[] = [];
  const composites: OpenFigiCompositeRow[] = [];
  const compositeIndex = new Map<string, number>();
  const listings: OpenFigiListingRow[] = [];
  const listingSeen = new Set<string>();
  const identifiers: OpenFigiIdentifierRow[] = [];
  const identifierSeen = new Set<string>();
  /** `ticker|exchCode` → the composite it first claimed, for the §6.1 conflict rule. */
  const compositeByTickerExch = new Map<string, string>();

  const addIdentifier = (row: OpenFigiIdentifierRow): void => {
    const key = identifierKey(row);
    if (identifierSeen.has(key)) return;
    identifierSeen.add(key);
    identifiers.push(row);
  };

  parsed.elements.forEach((element, index) => {
    const job = jobs?.[index] ?? null;
    if (element.kind === 'warning') {
      answers.push({ index, job, outcome: 'warning', text: element.text, recordCount: 0 });
      problems.push({
        kind: 'field_dropped',
        detail: `openfigi warning: ${element.text}`,
        path: `/${String(index)}`,
      });
      return;
    }
    if (element.kind === 'error') {
      answers.push({ index, job, outcome: 'error', text: element.text, recordCount: 0 });
      problems.push({
        kind: 'unknown_symbol',
        detail:
          job === null
            ? `openfigi error: ${element.text}`
            : `openfigi error for ${job.idType} ${job.idValue}: ${element.text}`,
        path: `/${String(index)}`,
      });
      exceptions.push({
        kind: 'unresolved_identifier',
        entityKind: 'instrument',
        field: job?.idType ?? 'unknown',
        candidates: [{ sourceId: 'openfigi.mapping', value: job?.idValue ?? '' }],
      });
      return;
    }

    answers.push({
      index,
      job,
      outcome: 'data',
      text: null,
      recordCount: element.records.length,
    });

    element.records.forEach((record) => {
      const isComposite = record.figi === record.compositeFIGI;

      // The composite row. The first record naming a composite creates it; a later record that IS
      // the composite (figi === compositeFIGI) upgrades `compositeExchCode`, which only it knows.
      const existing = compositeIndex.get(record.compositeFIGI);
      if (existing === undefined) {
        compositeIndex.set(record.compositeFIGI, composites.length);
        composites.push({
          compositeFigi: record.compositeFIGI,
          ticker: record.ticker,
          compositeExchCode: isComposite ? record.exchCode : null,
          name: record.name,
          securityType: record.securityType,
          securityType2: record.securityType2 ?? null,
          marketSector: marketSectorOf(record.marketSector),
          shareClassFigi: record.shareClassFIGI ?? null,
          assetClass: assetClassForSecurityType(record.securityType),
        });
      } else if (isComposite) {
        const row = composites[existing];
        if (row !== undefined) {
          row.compositeExchCode = record.exchCode;
          row.ticker = record.ticker;
          row.name = record.name;
          row.securityType = record.securityType;
          row.securityType2 = record.securityType2 ?? null;
          row.marketSector = marketSectorOf(record.marketSector);
          row.shareClassFigi = record.shareClassFIGI ?? row.shareClassFigi;
          row.assetClass = assetClassForSecurityType(record.securityType);
        }
      }

      addIdentifier({
        entityKind: 'instrument',
        scheme: 'COMPOSITE_FIGI',
        value: record.compositeFIGI,
        qualifier: '',
        isPrimary: true,
      });
      if (record.shareClassFIGI !== undefined) {
        addIdentifier({
          entityKind: 'issue',
          scheme: 'SHARE_CLASS_FIGI',
          value: record.shareClassFIGI,
          qualifier: '',
          isPrimary: false,
        });
      }
      addIdentifier({
        entityKind: isComposite ? 'instrument' : 'listing',
        scheme: 'TICKER_EXCH',
        value: record.ticker,
        qualifier: record.exchCode,
        isPrimary: false,
      });

      if (!isComposite) {
        addIdentifier({
          entityKind: 'listing',
          scheme: 'FIGI',
          value: record.figi,
          qualifier: '',
          isPrimary: false,
        });
        if (!listingSeen.has(record.figi)) {
          listingSeen.add(record.figi);
          listings.push({
            figi: record.figi,
            compositeFigi: record.compositeFIGI,
            localTicker: record.ticker,
            exchCode: record.exchCode,
            name: record.name,
            securityType: record.securityType,
          });
        }
      }

      // §6.1: a ticker that maps to two different composites for the same exchCode is a
      // `source_conflict` — neither is written until data ops resolves it (REF-10).
      const tickerExch = `${record.ticker}|${record.exchCode}`;
      const claimed = compositeByTickerExch.get(tickerExch);
      if (claimed === undefined) {
        compositeByTickerExch.set(tickerExch, record.compositeFIGI);
      } else if (claimed !== record.compositeFIGI) {
        exceptions.push({
          kind: 'source_conflict',
          entityKind: 'instrument',
          field: 'compositeFIGI',
          candidates: [
            { sourceId: 'openfigi.mapping', value: claimed },
            { sourceId: 'openfigi.mapping', value: record.compositeFIGI },
          ],
        });
      }
    });
  });

  const updates: NormalisedUpdate[] = [];
  return {
    updates,
    rows: { answers, composites, listings, identifiers, exceptions },
    sourceTs: raw.sourceTs,
    problems,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §6.2 — POST /v3/search
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The search response → candidates plus the opaque cursor. Never throws. */
export function parseOpenFigiSearch(body: Buffer | string): OpenFigiSearchParse {
  let doc: unknown;
  try {
    doc = JSON.parse(textOf(body));
  } catch (err) {
    return {
      candidates: [],
      next: null,
      problems: [{ kind: 'parse_error', detail: messageOf(err) }],
    };
  }
  if (!isRecord(doc)) {
    return {
      candidates: [],
      next: null,
      problems: [{ kind: 'schema_drift', detail: 'openfigi /v3/search did not return an object' }],
    };
  }
  const data = doc.data;
  if (!Array.isArray(data)) {
    return {
      candidates: [],
      next: null,
      problems: [{ kind: 'schema_drift', detail: 'openfigi /v3/search returned no data array' }],
    };
  }

  const problems: NormaliseProblem[] = [];
  const candidates: OpenFigiRecord[] = [];
  data.forEach((entry: unknown, position: number) => {
    const record = normaliseRecord(entry);
    if (record === null) {
      if (problems.length < MAX_REPORTED_PROBLEMS) {
        problems.push({
          kind: 'field_dropped',
          detail: 'openfigi search candidate is missing a keyed field',
          path: `/data/${String(position)}`,
        });
      }
      return;
    }
    candidates.push(record);
  });

  const next = stringField(doc, 'next') ?? null;
  return { candidates, next, problems };
}

/**
 * `POST /v3/search` → candidates. **Writes nothing** (§6.2): a candidate becomes a master row only
 * by re-issuing a `/v3/mapping` job on its `ticker` + `exchCode`, which is the assertion path.
 */
export function normaliseOpenFigiSearch(
  raw: RawRecord,
  _ctx: NormaliseContext,
): Normalised<OpenFigiSearchRows> {
  const parsed = parseOpenFigiSearch(raw.body);
  return {
    updates: [],
    rows: { candidates: parsed.candidates, next: parsed.next },
    sourceTs: raw.sourceTs,
    problems: parsed.problems,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The adapter's own entry point
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Shape-dispatching normalise, for the `ProviderAdapter.normalise(raw, ctx)` signature: a JSON
 * array is a mapping response, an object is a search response. The mapping branch runs with an
 * unknown job list (see the header note); a caller that holds the jobs calls
 * {@link normaliseOpenFigiMapping} directly and gets the positional length check as well.
 */
export function normaliseOpenFigi(raw: RawRecord, ctx: NormaliseContext): Normalised<OpenFigiRows> {
  const text = textOf(raw.body).trimStart();
  if (text.startsWith('[')) {
    const mapping = normaliseOpenFigiMapping(raw, ctx, null);
    return {
      updates: mapping.updates,
      rows: { mapping: mapping.rows },
      sourceTs: mapping.sourceTs,
      problems: mapping.problems,
    };
  }
  const search = normaliseOpenFigiSearch(raw, ctx);
  return {
    updates: search.updates,
    rows: { search: search.rows },
    sourceTs: search.sourceTs,
    problems: search.problems,
  };
}
