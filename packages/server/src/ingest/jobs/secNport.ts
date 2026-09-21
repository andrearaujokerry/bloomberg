/**
 * `ingest/jobs/secNport.ts` — SPY's N-PORT filing → S&P 500 membership (REF-07).
 *
 * PROVIDERS §7.6, WORKPLAN WP-04 L716-753. The SPDR S&P 500 ETF Trust (CIK `0000884394`) files
 * Form NPORT-P quarterly; `formData/fundInfo/invstOrSecs/invstOrSec` is the portfolio, and the
 * portfolio of the fund that tracks the index is the closest thing to the index membership that
 * exists without an index licence (DATA-01). The filing writes `etf_holdings` (every line) and
 * `index_members` (the equity longs that resolve).
 *
 * ── Two traps this module exists to avoid ────────────────────────────────────────────────────
 *
 * **1. The document-wide tag scan.** The recorded capture has 504 `<invstOrSec>` blocks but 505
 * `<isin …>` tags: holding 220 (`CONTRA HOLOGIC INCORPO`, `assetCat DE`) carries a
 * `derivativeInfo/othDeriv/descRefInstrmnt/otherRefInst/identifiers` with the *reference*
 * instrument's `<cusip value="436440101"/>` and `<isin value="US4364401012"/>` nested inside it.
 * A `getElementsByTagName('isin')` over the whole document therefore yields one value too many
 * and shifts every identifier after that point by one — a silent, total corruption of the index.
 * {@link parseNport} walks **direct children** of each holding (and of that holding's own
 * `identifiers` element) and nothing else, and asserts `cusipCount === holdingCount` inside the
 * scoped traversal before it returns.
 *
 * **2. The placeholder CUSIP.** 29 of the 504 holdings carry `<cusip>000000000</cusip>` —
 * foreign-domiciled names (Allegion plc `IE00BFRT3W74`, Amcor plc `JE00BV7DQ550`, …) that the
 * filer identifies only by ISIN. There are 476 distinct CUSIP strings across 504 holdings for
 * exactly this reason. A CUSIP-first resolver maps all 29 onto one entity, and the second
 * `identifiers(scheme 'CUSIP', value '000000000', qualifier '')` write raises
 * `identifiers_bt_excl` (SQLSTATE 23P01) and aborts the job. So a placeholder CUSIP is treated as
 * **absent**: it is never resolved against, never written to `identifiers`, and never stored in
 * `etf_holdings.cusip`. Resolution falls through to ISIN → LEI → ticker → `normName`, and a
 * holding that still does not resolve gets its `etf_holdings` row with
 * `holding_instrument_id NULL` plus a `data_exceptions` row of kind `'unresolved_identifier'`.
 *
 * ── Ownership note (for the integrator) ──────────────────────────────────────────────────────
 *
 * PROVIDERS §7.6 puts the N-PORT normaliser in `providers/sec/parse.ts#normaliseNport` and §7.1
 * puts `IngestJob`/`JobContext` in `ingest/scheduler.ts`, both of which are WP-05's files and do
 * not exist yet. The parser and the small context/result types live here until they do; they are
 * exported so WP-05 can re-export rather than rewrite them. Nothing here reads `process.env`,
 * opens a socket of its own, or writes outside the caller's transaction.
 */

import { normName } from '@terminal/core';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

import { etfHoldings } from '../../db/schema/timeseries.js';
import { indexMembers } from '../../db/schema/calendars.js';
import { insertProvenance } from '../../providers/provenance.js';
import { openReplayStore } from '../../providers/replayStore.js';
import {
  IDENTIFIER_CONFLICT_SQLSTATE,
  identifierRepository,
  isPlaceholderIdentifier,
} from '../../refdata/identifiers.js';
import { IssueRepository, toIssueInput } from '../../refdata/master.js';
import {
  findIndexByCode,
  instantOfDate,
  membersAsOf,
  recordSnapshot,
} from '../../refdata/indexMembership.js';
import { SecurityResolver } from '../../refdata/resolve.js';

import type { Clock, IdScheme } from '@terminal/core';
import type { Tx } from '../../db/client.js';
import type { AsOf } from '../../db/bitemporal.js';
import type { IndexRecord, SnapshotMember, SnapshotResult } from '../../refdata/indexMembership.js';
import type { ResolveCandidate } from '../../refdata/resolve.js';
import type { HttpClient, ProviderId, RawRecord } from '../../providers/types.js';
import type { ReplayStore } from '../../providers/replayStore.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared ingest plumbing (WP-05's `ingest/scheduler.ts` is its permanent home)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `ingest_runs.errors` — ARCHITECTURE §7.1 `JobError`. */
export interface JobError {
  code: string;
  message: string;
  url?: string;
  requestKey?: string;
}

/** ARCHITECTURE §7.1 `JobResult`. */
export interface JobResult {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: JobError[];
  provenanceIds: number[];
}

/** Structured job logging; every method is optional so a caller may pass `{}`. */
export interface IngestLogger {
  info?(event: string, detail: Record<string, unknown>): void;
  warn?(event: string, detail: Record<string, unknown>): void;
  error?(event: string, detail: Record<string, unknown>): void;
}

/**
 * The slice of ARCHITECTURE §7.1's `JobContext` a reference-ingest job actually uses: a
 * transaction to write in, a clock, and a way to get bytes. `plant` and `hotset` belong to the
 * real-time jobs and are deliberately absent, so these three jobs are callable from a test, from
 * `db:seed` and from the scheduler without any of them owning the other's dependencies.
 *
 * `http` is WP-05's shared client. Until it exists — and in every replay test forever — the job
 * reads the recorded capture out of the replay store, which is the wall of PROVIDERS.b §3.6: a
 * miss throws, it never opens a socket.
 */
export interface RefIngestContext {
  tx: Tx;
  clock: Clock;
  http?: HttpClient;
  replay?: ReplayStore;
  log?: IngestLogger;
  /** OPS-07 — copied onto `provenance.trace_id`. Must be a uuid when present. */
  traceId?: string;
  /** `ingest_runs.run_id` when the scheduler is the caller. */
  runId?: number;
}

/** `ctx.http` when WP-05 has wired one in, the recorded capture otherwise. */
export async function fetchRaw(
  ctx: RefIngestContext,
  req: { providerId: ProviderId; url: string; cacheTtlMs?: number; timeoutMs?: number },
): Promise<RawRecord> {
  if (ctx.http !== undefined) {
    const get: Parameters<HttpClient['get']>[0] = {
      providerId: req.providerId,
      url: req.url,
      budgetShare: 'scheduler',
    };
    if (req.cacheTtlMs !== undefined) get.cacheTtlMs = req.cacheTtlMs;
    if (req.timeoutMs !== undefined) get.timeoutMs = req.timeoutMs;
    if (ctx.traceId !== undefined) get.traceId = ctx.traceId;
    if (ctx.runId !== undefined) get.runId = ctx.runId;
    return ctx.http.get(get);
  }
  const store = ctx.replay ?? openReplayStore();
  return store.replay({ providerId: req.providerId, url: req.url });
}

/** `insertProvenance` meta built from the context, without writing `undefined` into it. */
export function provenanceMeta(
  ctx: RefIngestContext,
  adapterVersion: string,
  sourceTs: Date | null,
): { adapterVersion: string; sourceTs: Date | null; traceId?: string; runId?: number } {
  const meta: { adapterVersion: string; sourceTs: Date | null; traceId?: string; runId?: number } =
    { adapterVersion, sourceTs };
  if (ctx.traceId !== undefined) meta.traceId = ctx.traceId;
  if (ctx.runId !== undefined) meta.runId = ctx.runId;
  return meta;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A minimal, scoped XML reader
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One element. `text` is this element's **own** character data, not its descendants'. */
export interface XmlNode {
  /** Local name: the namespace prefix (`ncom:`) is stripped. */
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly text: string;
  readonly children: readonly XmlNode[];
}

interface MutableXmlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: MutableXmlNode[];
}

/** Raised for malformed XML. A normaliser turns it into a `parse_error`, never a crash. */
export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** XML's five predefined entities plus numeric references; anything else is left as written. */
export function decodeXmlEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** The index of the `>` that closes the tag starting at `from`, honouring quoted attributes. */
function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

const ATTR_RE = /([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function localName(qname: string): string {
  const colon = qname.indexOf(':');
  return colon < 0 ? qname : qname.slice(colon + 1);
}

/** Depth ceiling: a hostile or truncated document must fail, not exhaust the stack. */
const MAX_XML_DEPTH = 64;

/**
 * Parse `source` into a tree. Deliberately small: comments, processing instructions, the
 * `DOCTYPE` line and CDATA are handled, external entities and DTD subsets are not — a normaliser
 * that resolves an external entity is a network call hiding inside a parser (PROVIDERS.b §1.2).
 *
 * @throws {XmlParseError} on an unterminated tag, a mismatched close or excessive nesting.
 */
export function parseXml(source: string): XmlNode {
  const root: MutableXmlNode = { name: '#document', attrs: {}, text: '', children: [] };
  const stack: MutableXmlNode[] = [root];
  let i = 0;

  const top = (): MutableXmlNode => stack[stack.length - 1] ?? root;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      top().text += decodeXmlEntities(source.slice(i));
      break;
    }
    if (lt > i) top().text += decodeXmlEntities(source.slice(i, lt));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlParseError('unterminated comment');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlParseError('unterminated CDATA section');
      top().text += source.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (source.startsWith('<?', lt) || source.startsWith('<!', lt)) {
      const end = findTagEnd(source, lt + 2);
      if (end < 0) throw new XmlParseError('unterminated processing instruction or declaration');
      i = end + 1;
      continue;
    }

    const end = findTagEnd(source, lt + 1);
    if (end < 0) throw new XmlParseError(`unterminated tag at offset ${String(lt)}`);
    let raw = source.slice(lt + 1, end);
    i = end + 1;

    if (raw.startsWith('/')) {
      const name = localName(raw.slice(1).trim());
      const open = stack.pop();
      if (open === undefined || open === root || open.name !== name) {
        throw new XmlParseError(
          `</${name}> does not close <${open === undefined ? '#document' : open.name}>`,
        );
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    if (selfClosing) raw = raw.slice(0, -1);
    const space = raw.search(/\s/);
    const qname = (space < 0 ? raw : raw.slice(0, space)).trim();
    if (qname.length === 0) throw new XmlParseError(`empty tag name at offset ${String(lt)}`);

    const attrs: Record<string, string> = {};
    if (space >= 0) {
      const attrText = raw.slice(space);
      ATTR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ATTR_RE.exec(attrText)) !== null) {
        attrs[localName(m[1] ?? '')] = decodeXmlEntities(m[2] ?? m[3] ?? '');
      }
    }

    const node: MutableXmlNode = { name: localName(qname), attrs, text: '', children: [] };
    top().children.push(node);
    if (!selfClosing) {
      if (stack.length >= MAX_XML_DEPTH) {
        throw new XmlParseError(`XML nested deeper than ${String(MAX_XML_DEPTH)} elements`);
      }
      stack.push(node);
    }
  }

  if (stack.length !== 1) {
    throw new XmlParseError(
      `unclosed <${stack[stack.length - 1]?.name ?? '?'}> at end of document`,
    );
  }
  return root;
}

/** The first **direct child** named `name`. Never searches descendants — that is trap #1. */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

/** Every direct child named `name`, in document order. */
export function childrenNamed(node: XmlNode | undefined, name: string): readonly XmlNode[] {
  return node?.children.filter((c) => c.name === name) ?? [];
}

/** A direct child's trimmed text, or `null` when the element is absent or empty. */
export function childText(node: XmlNode | undefined, name: string): string | null {
  const found = child(node, name);
  if (found === undefined) return null;
  const text = found.text.trim();
  return text.length === 0 ? null : text;
}

/** Walk a path of direct children: `path(root, 'formData', 'genInfo')`. */
export function path(node: XmlNode | undefined, ...names: readonly string[]): XmlNode | undefined {
  let current = node;
  for (const name of names) current = child(current, name);
  return current;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// N-PORT
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `licence_registry.source_id` for the Archives document. */
export const SEC_ARCHIVES_SOURCE_ID = 'sec.archives' satisfies ProviderId;

/** `provenance.adapter_version` — `'<family>/<semver>'` (PROVIDERS.a §1.4). */
export const NPORT_ADAPTER_VERSION = 'nport/1.0.0';

/** The SPDR S&P 500 ETF Trust, zero-padded as SEC publishes it. */
export const SPY_CIK = '0000884394';

/** The N-PORT accession the fixture was captured from. */
export const SPY_NPORT_ACCESSION = '0001410368-26-089410';

/**
 * The Archives URL for one filing. The accession loses its dashes for the path segment, the CIK
 * is **unpadded**, and `primaryDocument` has its leading `xsl…/` viewer segment stripped —
 * that prefix returns styled HTML, not XML (PROVIDERS §7.2).
 */
export function nportUrl(cik: string, accession: string, document = 'primary_doc.xml'): string {
  const bareCik = String(Number.parseInt(cik, 10));
  const bareAccession = accession.replaceAll('-', '');
  return `https://www.sec.gov/Archives/edgar/data/${bareCik}/${bareAccession}/${document}`;
}

/** The recorded capture's URL. */
export const SPY_NPORT_URL = nportUrl(SPY_CIK, SPY_NPORT_ACCESSION);

/** `formData/genInfo` + `formData/fundInfo`'s scalars + the signature date. */
export interface NportHeader {
  submissionType: string;
  regName: string;
  regCik: string;
  regLei: string | null;
  /** The **portfolio** date — `index_members.as_of_date` and `etf_holdings.as_of_date`. */
  repPdDate: string;
  /** The reporting period end. Recorded in `dq_events.details`; never an as-of date. */
  repPdEnd: string | null;
  totAssets: number | null;
  totLiabs: number | null;
  netAssets: number | null;
  /** `signature/dateSigned` — the closest thing the document carries to a publication instant. */
  dateSigned: string | null;
}

/** One `invstOrSec`, exactly as published. Numbers stay strings: `numeric` takes them verbatim. */
export interface NportHolding {
  /** 1-based document order → `etf_holdings.line_no`. */
  lineNo: number;
  name: string;
  lei: string | null;
  title: string | null;
  /** The published CUSIP, `null` when the element is absent. `000000000` is kept here and
   *  flagged by {@link NportHolding.cusipIsPlaceholder}; it never reaches a column. */
  cusip: string | null;
  /** `identifiers/isin/@value` — an **attribute**, not text. */
  isin: string | null;
  balance: string | null;
  units: string | null;
  curCd: string | null;
  valUsd: string | null;
  /** A **percent** (`0.083321585405`); `index_members.weight` is `pctVal / 100`. */
  pctVal: string | null;
  payoffProfile: string | null;
  /** `'EC'` equity, `'DBT'` debt, `'STIV'` short-term, `'DE'` derivative. */
  assetCat: string | null;
  issuerCat: string | null;
  country: string | null;
  /** `000000000`, all-zero or blank: the filer published no CUSIP for this name. */
  cusipIsPlaceholder: boolean;
}

/** A non-fatal parse observation. Mirrors `NormaliseProblem` without importing the adapter type. */
export interface NportProblem {
  kind: 'parse_error' | 'unknown_symbol' | 'field_dropped' | 'schema_drift' | 'out_of_range';
  detail: string;
  path?: string;
}

export interface NportParse {
  header: NportHeader;
  holdings: NportHolding[];
  problems: NportProblem[];
  /** `signature/dateSigned` at UTC midnight → `provenance.source_ts`; `null` when absent. */
  sourceTs: Date | null;
}

/** Thrown when the document is not the form we asked for, or its own counts disagree. */
export class NportSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NportSchemaError';
  }
}

function numberOrNull(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** `'EC'` + `'Long'` + `'NS'` + `'USD'`: the lines that are index membership, not exposure. */
export function isIndexEligible(h: NportHolding): boolean {
  return h.assetCat === 'EC' && h.payoffProfile === 'Long' && h.units === 'NS' && h.curCd === 'USD';
}

/**
 * `primary_doc.xml` → header + 504 holdings.
 *
 * Pure: same bytes in, byte-identical rows out, on any machine in any year. The scoped traversal
 * is the point — see the module header, trap #1.
 *
 * @throws {XmlParseError} malformed XML.
 * @throws {NportSchemaError} a submission type other than `NPORT-P`, a missing `repPdDate`, or a
 *         `cusip` count that disagrees with the holding count inside the scoped traversal.
 */
export function parseNport(xml: string): NportParse {
  const root = parseXml(xml);
  const submission = child(root, 'edgarSubmission');
  if (submission === undefined) {
    throw new NportSchemaError('no <edgarSubmission> root element');
  }

  const submissionType = childText(child(submission, 'headerData'), 'submissionType');
  if (submissionType !== 'NPORT-P') {
    throw new NportSchemaError(
      `expected submissionType NPORT-P, got ${JSON.stringify(submissionType)}`,
    );
  }

  const formData = child(submission, 'formData');
  const genInfo = child(formData, 'genInfo');
  const fundInfo = child(formData, 'fundInfo');
  const repPdDate = childText(genInfo, 'repPdDate');
  if (repPdDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(repPdDate)) {
    throw new NportSchemaError(`genInfo/repPdDate is missing or not a date: ${String(repPdDate)}`);
  }
  const dateSigned = childText(child(formData, 'signature'), 'dateSigned');

  const header: NportHeader = {
    submissionType,
    regName: childText(genInfo, 'regName') ?? '',
    regCik: childText(genInfo, 'regCik') ?? '',
    regLei: childText(genInfo, 'regLei'),
    repPdDate,
    repPdEnd: childText(genInfo, 'repPdEnd'),
    totAssets: numberOrNull(childText(fundInfo, 'totAssets')),
    totLiabs: numberOrNull(childText(fundInfo, 'totLiabs')),
    netAssets: numberOrNull(childText(fundInfo, 'netAssets')),
    dateSigned,
  };

  const problems: NportProblem[] = [];
  // PROVIDERS §7.6 writes the path as `formData/fundInfo/invstOrSecs/invstOrSec`. In the recorded
  // capture `invstOrSecs` is a **sibling** of `fundInfo` under `formData` (line 88, against
  // `</fundInfo>` on line 87), which is what the EDGAR schema actually produces. Both spellings
  // are accepted — the container is found, then only its direct `invstOrSec` children are read.
  const container = child(fundInfo, 'invstOrSecs') ?? child(formData, 'invstOrSecs');
  const blocks = childrenNamed(container, 'invstOrSec');
  const holdings: NportHolding[] = [];
  let cusipCount = 0;

  blocks.forEach((block, index) => {
    const lineNo = index + 1;
    const cusip = childText(block, 'cusip');
    if (cusip !== null) cusipCount += 1;
    // `identifiers` is read as a DIRECT child of the holding, so the reference instrument nested
    // under `derivativeInfo/othDeriv/descRefInstrmnt/otherRefInst/identifiers` is invisible here.
    const isinNode = child(child(block, 'identifiers'), 'isin');
    const isin = isinNode?.attrs.value?.trim() ?? null;
    const name = childText(block, 'name');
    if (name === null) {
      problems.push({
        kind: 'schema_drift',
        detail: 'holding has no <name>',
        path: `/formData/fundInfo/invstOrSecs/invstOrSec/${String(index)}`,
      });
    }

    holdings.push({
      lineNo,
      name: name ?? '',
      lei: childText(block, 'lei'),
      title: childText(block, 'title'),
      cusip,
      isin: isin !== null && isin.length > 0 ? isin : null,
      balance: childText(block, 'balance'),
      units: childText(block, 'units'),
      curCd: childText(block, 'curCd'),
      valUsd: childText(block, 'valUSD'),
      pctVal: childText(block, 'pctVal'),
      payoffProfile: childText(block, 'payoffProfile'),
      assetCat: childText(block, 'assetCat'),
      issuerCat: childText(block, 'issuerCat'),
      country: childText(block, 'invCountry'),
      cusipIsPlaceholder: cusip === null || isPlaceholderIdentifier('CUSIP', cusip),
    });
  });

  if (cusipCount !== holdings.length) {
    throw new NportSchemaError(
      `scoped traversal found ${String(cusipCount)} <cusip> elements across ` +
        `${String(holdings.length)} holdings; a whole-document tag scan has leaked in`,
    );
  }

  return {
    header,
    holdings,
    problems,
    sourceTs: dateSigned === null ? null : new Date(`${dateSigned}T00:00:00.000Z`),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Holding resolution (shared with `ssgaHoldings.ts`)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Everything either holdings file can offer about one line, already placeholder-screened. */
export interface HoldingKeys {
  /** `null` when the published value was a placeholder — see the module header, trap #2. */
  cusip: string | null;
  isin: string | null;
  lei: string | null;
  sedol: string | null;
  /** SSGA publishes class shares as `BRK.B`; every spelling is tried. */
  ticker: string | null;
  name: string;
}

/** Which key answered — recorded so a coverage report can say *how* the index was matched. */
export type HoldingResolveMethod = 'cusip' | 'isin' | 'lei' | 'sedol' | 'ticker' | 'name';

export interface HoldingResolution {
  instrumentId: number | null;
  method: HoldingResolveMethod | null;
  /** `'unresolved'` or `'ambiguous'` — both become a `data_exceptions` row. */
  failure: 'unresolved' | 'ambiguous' | null;
  candidate: ResolveCandidate | null;
  /** The keys actually tried, in order, for the exception's `candidates` payload. */
  tried: string[];
}

/** `BRK.B` is also written `BRK-B` and `BRK B`; all three are tried against `TICKER_EXCH`. */
export function tickerSpellings(ticker: string): string[] {
  const base = ticker.trim().toUpperCase();
  if (base.length === 0) return [];
  const out = new Set<string>([base]);
  if (base.includes('.')) {
    out.add(base.replaceAll('.', '-'));
    out.add(base.replaceAll('.', ' '));
  }
  return [...out];
}

/** A value that identifies nothing (`000000000`, `-`, `N/A`, blank) reads as absent. */
export function presentIdentifier(scheme: IdScheme, raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim().toUpperCase();
  if (value.length === 0) return null;
  return isPlaceholderIdentifier(scheme, value) ? null : value;
}

/**
 * CUSIP → ISIN → LEI → SEDOL → ticker → `normName`, stopping at the first key that names exactly
 * one instrument (REF-01: ambiguity is reported, never guessed).
 *
 * A placeholder CUSIP is already `null` by the time it gets here, so the chain simply starts at
 * ISIN for the 29 foreign-domiciled names — which is the whole point of WORKPLAN L740-753.
 */
export async function resolveHolding(
  tx: Tx,
  keys: HoldingKeys,
  at: AsOf,
): Promise<HoldingResolution> {
  const resolver = new SecurityResolver(tx);
  const tried: string[] = [];
  let ambiguous = false;

  const attempt = async (
    method: HoldingResolveMethod,
    label: string,
    run: () => Promise<ResolveCandidate[]>,
  ): Promise<HoldingResolution | null> => {
    tried.push(label);
    const rows = await run();
    if (rows.length === 1) {
      const only = rows[0]!;
      return { instrumentId: only.instrumentId, method, failure: null, candidate: only, tried };
    }
    if (rows.length > 1) ambiguous = true;
    return null;
  };

  const viaRef = async (
    kind: 'cusip' | 'isin' | 'ticker',
    value: string,
    exchCode?: string,
  ): Promise<ResolveCandidate[]> => {
    const result = await resolver.resolve(
      exchCode === undefined ? { kind, value } : { kind, value, exchCode },
      at,
    );
    return result.ok ? [result.instrument] : [...result.candidates];
  };

  if (keys.cusip !== null) {
    const hit = await attempt('cusip', `CUSIP:${keys.cusip}`, () => viaRef('cusip', keys.cusip!));
    if (hit !== null) return hit;
  }
  if (keys.isin !== null) {
    const hit = await attempt('isin', `ISIN:${keys.isin}`, () => viaRef('isin', keys.isin!));
    if (hit !== null) return hit;
  }
  if (keys.lei !== null) {
    const hit = await attempt('lei', `LEI:${keys.lei}`, () => instrumentsByLei(tx, keys.lei!, at));
    if (hit !== null) return hit;
  }
  if (keys.sedol !== null) {
    const hit = await attempt('sedol', `SEDOL:${keys.sedol}`, () =>
      instrumentsByIdentifier(tx, 'SEDOL', keys.sedol!, at),
    );
    if (hit !== null) return hit;
  }
  if (keys.ticker !== null) {
    for (const spelling of tickerSpellings(keys.ticker)) {
      const hit = await attempt('ticker', `TICKER_EXCH:${spelling}`, () =>
        viaRef('ticker', spelling, 'US'),
      );
      if (hit !== null) return hit;
    }
  }
  if (keys.name.trim().length > 0 && normName(keys.name).length >= 2) {
    const hit = await attempt('name', `NAME:${keys.name}`, async () => {
      const result = await resolver.resolve({ kind: 'ticker', value: keys.name }, at);
      // Only the name step may answer here: a company name that happens to equal a ticker is a
      // coincidence, not an identification.
      if (result.ok) return result.method === 'name' ? [result.instrument] : [];
      return result.method === 'name' ? [...result.candidates] : [];
    });
    if (hit !== null) return hit;
  }

  return {
    instrumentId: null,
    method: null,
    failure: ambiguous ? 'ambiguous' : 'unresolved',
    candidate: null,
    tried,
  };
}

/** Every instrument an `identifiers` row of `(scheme, value)` leads to, via its entity. */
async function instrumentsByIdentifier(
  tx: Tx,
  scheme: IdScheme,
  value: string,
  at: AsOf,
): Promise<ResolveCandidate[]> {
  const rows = await identifierRepository(tx).lookup(scheme, value, at);
  const resolver = new SecurityResolver(tx);
  const ids = new Set<number>();
  for (const row of rows) {
    for (const id of await instrumentIdsForEntity(tx, row.entityKind, row.entityId, at)) {
      ids.add(id);
    }
  }
  const out: ResolveCandidate[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const found = await resolver.byInstrumentId(id, at);
    if (found !== null) out.push(found);
  }
  return out;
}

/**
 * LEI → instruments. `refdata/resolve.ts` has no `/lei/` ref form (an LEI names a legal entity,
 * not a security), so the fan-out is done here: the `identifiers` row first, then `issuers.lei`,
 * which is where `symbologyRefresh` puts it.
 */
async function instrumentsByLei(tx: Tx, lei: string, at: AsOf): Promise<ResolveCandidate[]> {
  const byIdentifier = await instrumentsByIdentifier(tx, 'LEI', lei, at);
  if (byIdentifier.length > 0) return byIdentifier;

  const rows = await tx.execute<{ instrument_id: string }>(sql`
    SELECT i.instrument_id
      FROM instruments i
      JOIN issues s ON s.issue_id = i.issue_id
      JOIN issuers r ON r.issuer_id = s.issuer_id
     WHERE upper(r.lei) = ${lei}
       AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                    ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)
       AND bt_as_of(s.valid_from, s.valid_to, s.tx_from, s.tx_to,
                    ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)
       AND bt_as_of(r.valid_from, r.valid_to, r.tx_from, r.tx_to,
                    ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)
     ORDER BY i.instrument_id`);

  const resolver = new SecurityResolver(tx);
  const out: ResolveCandidate[] = [];
  for (const row of rows.rows) {
    const found = await resolver.byInstrumentId(Number(row.instrument_id), at);
    if (found !== null) out.push(found);
  }
  return out;
}

/** An identifier's entity → the instruments it covers (issuer → issues → instruments). */
async function instrumentIdsForEntity(
  tx: Tx,
  entityKind: string,
  entityId: number,
  at: AsOf,
): Promise<number[]> {
  if (entityKind === 'instrument') return [entityId];
  const predicate = sql`bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                                 ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)`;
  if (entityKind === 'issue') {
    const rows = await tx.execute<{ instrument_id: string }>(sql`
      SELECT i.instrument_id FROM instruments i
       WHERE i.issue_id = ${entityId}::bigint AND ${predicate} ORDER BY i.instrument_id`);
    return rows.rows.map((r) => Number(r.instrument_id));
  }
  if (entityKind === 'issuer') {
    const rows = await tx.execute<{ instrument_id: string }>(sql`
      SELECT i.instrument_id FROM instruments i JOIN issues s ON s.issue_id = i.issue_id
       WHERE s.issuer_id = ${entityId}::bigint
         AND ${predicate}
         AND bt_as_of(s.valid_from, s.valid_to, s.tx_from, s.tx_to,
                      ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)
       ORDER BY i.instrument_id`);
    return rows.rows.map((r) => Number(r.instrument_id));
  }
  if (entityKind === 'listing') {
    const rows = await tx.execute<{ instrument_id: string }>(sql`
      SELECT i.instrument_id FROM instruments i
       WHERE i.primary_listing_id = ${entityId}::bigint AND ${predicate} ORDER BY i.instrument_id`);
    return rows.rows.map((r) => Number(r.instrument_id));
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `etf_holdings`, `data_exceptions`, `dq_events` — idempotent writers shared by both jobs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `etf_holdings` row, already resolved. */
export interface EtfHoldingRow {
  etfInstrumentId: number;
  asOfDate: string;
  sourceId: string;
  lineNo: number;
  holdingInstrumentId: number | null;
  name: string;
  cusip: string | null;
  isin: string | null;
  lei: string | null;
  sedol: string | null;
  ticker: string | null;
  shares: string | null;
  marketValue: string | null;
  weight: string | null;
  assetCat: string | null;
  issuerCat: string | null;
  country: string | null;
  provenanceId: number;
}

export interface UpsertCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

/** Postgres caps a statement at 65 535 bind parameters; 200 × 18 keeps a wide margin. */
const HOLDINGS_CHUNK = 200;

/**
 * Insert or update `etf_holdings`, counting **rows**, not booleans (QA-02).
 *
 * `DO UPDATE … WHERE` compares every data column except `provenance_id`: a re-fetch of unchanged
 * bytes is still unchanged data, and a row whose `WHERE` is false is not returned at all, so
 * `unchanged` is the count the statement did not touch. `xmax = 0` on a returned row means the
 * row was inserted rather than updated — the only way Postgres will tell you which branch fired.
 */
export async function upsertEtfHoldings(
  tx: Tx,
  rows: readonly EtfHoldingRow[],
): Promise<UpsertCounts> {
  const counts: UpsertCounts = { inserted: 0, updated: 0, unchanged: 0 };
  for (let offset = 0; offset < rows.length; offset += HOLDINGS_CHUNK) {
    const chunk = rows.slice(offset, offset + HOLDINGS_CHUNK);
    const returned = await tx
      .insert(etfHoldings)
      .values(chunk.map((r) => ({ ...r })))
      .onConflictDoUpdate({
        target: [
          etfHoldings.etfInstrumentId,
          etfHoldings.asOfDate,
          etfHoldings.sourceId,
          etfHoldings.lineNo,
        ],
        set: {
          holdingInstrumentId: sql`excluded.holding_instrument_id`,
          name: sql`excluded.name`,
          cusip: sql`excluded.cusip`,
          isin: sql`excluded.isin`,
          lei: sql`excluded.lei`,
          sedol: sql`excluded.sedol`,
          ticker: sql`excluded.ticker`,
          shares: sql`excluded.shares`,
          marketValue: sql`excluded.market_value`,
          weight: sql`excluded.weight`,
          assetCat: sql`excluded.asset_cat`,
          issuerCat: sql`excluded.issuer_cat`,
          country: sql`excluded.country`,
          provenanceId: sql`excluded.provenance_id`,
        },
        setWhere: sql`(etf_holdings.holding_instrument_id, etf_holdings.name, etf_holdings.cusip,
                       etf_holdings.isin, etf_holdings.lei, etf_holdings.sedol, etf_holdings.ticker,
                       etf_holdings.shares, etf_holdings.market_value, etf_holdings.weight,
                       etf_holdings.asset_cat, etf_holdings.issuer_cat, etf_holdings.country)
                      IS DISTINCT FROM
                      (excluded.holding_instrument_id, excluded.name, excluded.cusip,
                       excluded.isin, excluded.lei, excluded.sedol, excluded.ticker,
                       excluded.shares, excluded.market_value, excluded.weight,
                       excluded.asset_cat, excluded.issuer_cat, excluded.country)`,
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });

    for (const row of returned) {
      if (row.inserted) counts.inserted += 1;
      else counts.updated += 1;
    }
    counts.unchanged += chunk.length - returned.length;
  }
  return counts;
}

/** One unresolved holding, as `data_exceptions` records it. */
export interface UnresolvedHolding {
  sourceId: string;
  provenanceId: number;
  asOfDate: string;
  lineNo: number;
  name: string;
  tried: readonly string[];
  reason: 'unresolved' | 'ambiguous';
}

/**
 * A `data_exceptions` row of kind `'unresolved_identifier'`, written once per
 * `(source, as-of date, line)`. The dedupe key lives inside the candidate payload, so a re-run of
 * the same file adds nothing — the exception queue is a work list, not a log.
 *
 * @returns `1` when a row was written, `0` when one already existed.
 */
export async function recordUnresolvedHolding(
  tx: Tx,
  exception: UnresolvedHolding,
): Promise<number> {
  const key = `${exception.sourceId}:${exception.asOfDate}:${String(exception.lineNo)}`;
  const candidates = [
    {
      sourceId: exception.sourceId,
      provenanceId: exception.provenanceId,
      value: {
        key,
        name: exception.name,
        lineNo: exception.lineNo,
        asOfDate: exception.asOfDate,
        reason: exception.reason,
        tried: [...exception.tried],
      },
    },
  ];
  const rows = await tx.execute<{ exception_id: string }>(sql`
    INSERT INTO data_exceptions (kind, entity_kind, entity_id, field, candidates, status)
    SELECT 'unresolved_identifier', NULL, NULL, 'holding_instrument_id',
           ${JSON.stringify(candidates)}::jsonb, 'open'
     WHERE NOT EXISTS (
       SELECT 1 FROM data_exceptions
        WHERE kind = 'unresolved_identifier'
          AND field = 'holding_instrument_id'
          AND candidates -> 0 -> 'value' ->> 'key' = ${key})
    RETURNING exception_id`);
  return rows.rows.length;
}

/** A `dq_events` row, written at most once per `(kind, source, subject, key)`. */
export async function recordDqEvent(
  tx: Tx,
  event: {
    kind: string;
    severity: 'info' | 'warn' | 'error';
    sourceId: string;
    subject: string;
    key: string;
    details: Record<string, unknown>;
    instrumentId?: number;
  },
): Promise<number> {
  const details = { ...event.details, key: event.key };
  const rows = await tx.execute<{ dq_id: string }>(sql`
    INSERT INTO dq_events (kind, severity, instrument_id, source_id, subject, details)
    SELECT ${event.kind}, ${event.severity},
           ${event.instrumentId ?? null}::bigint, ${event.sourceId}, ${event.subject},
           ${JSON.stringify(details)}::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM dq_events
        WHERE kind = ${event.kind}
          AND source_id = ${event.sourceId}
          AND subject = ${event.subject}
          AND details ->> 'key' = ${event.key})
    RETURNING dq_id`);
  return rows.rows.length;
}

/**
 * Write the identifiers a resolved holding proves, and fill in `issues.cusip`/`issues.isin`.
 *
 * Every write is guarded four ways:
 *
 *  1. a placeholder or malformed value never reaches SQL — `upsertIfValid` returns the rejection
 *     rather than throwing, because a `000000000` CUSIP is an expected input here, not a bug;
 *  2. an identical current version writes nothing (`versionId === null`), which is what makes a
 *     re-run free;
 *  3. **a key that currently points at a different entity is not re-pointed.** `upsertVersion`
 *     would happily close the old version and open a new one — that is what
 *     `IdentifierRepository.write` is *for*, and it is the right operation for a data-ops
 *     correction. It is the wrong operation for an ingest job: a holdings file that mis-resolves
 *     one line would silently move a CUSIP from one issue to another and leave no trace. So the
 *     current owner is read first, and a disagreement becomes a `data_exceptions` row of kind
 *     `'source_conflict'` with a 2-business-day SLA (REF-10) while the database keeps saying what
 *     it said;
 *  4. whatever still reaches Postgres runs inside a savepoint, so an `identifiers_bt_excl`
 *     violation (23P01) or a `bt_guard_update` refusal (P0001) from a concurrent writer costs one
 *     identifier, not the whole run — this job issues 504 of these in a row.
 *
 * @returns `written`, the identifier versions actually written, and `conflicts`, the
 *          `data_exceptions` rows of kind `'source_conflict'` this holding filed (guard 3). Both
 *          are reported by the job: a run that quietly refuses to re-point three LEIs has told
 *          the operator nothing unless the refusals are counted.
 */
export async function writeHoldingIdentifiers(
  tx: Tx,
  args: {
    candidate: ResolveCandidate;
    keys: HoldingKeys;
    sourceId: string;
    provenanceId: number;
    validFrom: Date;
    knownAt: Date;
  },
): Promise<{ written: number; conflicts: number }> {
  const options = {
    validFrom: args.validFrom,
    provenanceId: args.provenanceId,
    knownAt: args.knownAt,
  };
  const wanted: {
    scheme: IdScheme;
    value: string;
    entityKind: 'issue' | 'issuer';
    entityId: number;
  }[] = [];
  if (args.keys.cusip !== null) {
    wanted.push({
      scheme: 'CUSIP',
      value: args.keys.cusip,
      entityKind: 'issue',
      entityId: args.candidate.issueId,
    });
  }
  if (args.keys.isin !== null) {
    wanted.push({
      scheme: 'ISIN',
      value: args.keys.isin,
      entityKind: 'issue',
      entityId: args.candidate.issueId,
    });
  }
  if (args.keys.sedol !== null) {
    wanted.push({
      scheme: 'SEDOL',
      value: args.keys.sedol,
      entityKind: 'issue',
      entityId: args.candidate.issueId,
    });
  }
  if (args.keys.lei !== null) {
    wanted.push({
      scheme: 'LEI',
      value: args.keys.lei,
      entityKind: 'issuer',
      entityId: args.candidate.issuerId,
    });
  }

  const repo = identifierRepository(tx);
  const keyAt: AsOf = { validAt: args.validFrom, knownAt: args.knownAt };

  let written = 0;
  let conflicts = 0;
  for (const target of wanted) {
    // Guard 3: who owns this key right now? A `null` owner means the key is free; the same owner
    // means the write is a no-op; a different owner is a conflict this job does not resolve.
    const owner = await repo.entityOf(
      { scheme: target.scheme, value: target.value, qualifier: '' },
      keyAt,
    );
    if (
      owner !== null &&
      (owner.entityKind !== target.entityKind || owner.entityId !== target.entityId)
    ) {
      conflicts += await recordIdentifierConflict(tx, {
        scheme: target.scheme,
        value: target.value,
        entityKind: target.entityKind,
        entityId: target.entityId,
        heldBy: owner,
        sourceId: args.sourceId,
        provenanceId: args.provenanceId,
      });
      continue;
    }

    try {
      const outcome = await tx.transaction(async (sp) =>
        identifierRepository(sp).upsertIfValid(
          {
            entityKind: target.entityKind,
            entityId: target.entityId,
            scheme: target.scheme,
            value: target.value,
          },
          options,
        ),
      );
      if (outcome.ok && outcome.versionId !== null) written += 1;
    } catch (err) {
      if (!isConflict(err)) throw err;
      conflicts += await recordIdentifierConflict(tx, {
        scheme: target.scheme,
        value: target.value,
        entityKind: target.entityKind,
        entityId: target.entityId,
        heldBy: null,
        sourceId: args.sourceId,
        provenanceId: args.provenanceId,
      });
    }
  }

  // `issues.cusip` / `issues.isin` / `issues.sedol` (PROVIDERS §7.6 Writes). Idempotent: the
  // repository's `upsert` writes nothing when the current version already says this.
  const issueRepo = new IssueRepository(tx);
  const at: AsOf = { validAt: args.validFrom, knownAt: args.knownAt };
  const record = await issueRepo.get(args.candidate.issueId, at);
  if (record !== null) {
    const input = toIssueInput(record);
    let changed = false;
    if (args.keys.cusip !== null && input.cusip !== args.keys.cusip) {
      input.cusip = args.keys.cusip;
      changed = true;
    }
    if (args.keys.isin !== null && input.isin !== args.keys.isin) {
      input.isin = args.keys.isin;
      changed = true;
    }
    if (args.keys.sedol !== null && input.sedol !== args.keys.sedol) {
      input.sedol = args.keys.sedol;
      changed = true;
    }
    if (changed) await issueRepo.upsert(args.candidate.issueId, input, options);
  }

  return { written, conflicts };
}

/**
 * `identifiers_bt_excl` (23P01) and `bt_guard_update`'s `tx_to must be after tx_from` (P0001) are
 * both "this key is already claimed inside this transaction". Both are recoverable at the level of
 * one identifier; nothing else is.
 */
function isConflict(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    typeof err === 'object' &&
    err !== null &&
    (code === IDENTIFIER_CONFLICT_SQLSTATE || code === 'P0001')
  );
}

/**
 * REF-10: one open row per disputed key, with both sides in `candidates` so a data-ops screen can
 * choose. Deduped on the key, so a daily job does not grow a queue of identical work items.
 *
 * @returns 1 when a `data_exceptions` row was written, 0 when this key was already queued. The
 *          count is reported — an ops dashboard that reads the run summary has to see every row
 *          the run filed, not only the unresolved holdings.
 */
async function recordIdentifierConflict(
  tx: Tx,
  args: {
    scheme: IdScheme;
    value: string;
    entityKind: 'issue' | 'issuer';
    entityId: number;
    /** Who the database says owns the key today; `null` when Postgres refused without telling us. */
    heldBy: { entityKind: string; entityId: number } | null;
    sourceId: string;
    provenanceId: number;
  },
): Promise<number> {
  const key = `${args.sourceId}:${args.scheme}:${args.value}`;
  const candidates = [
    {
      sourceId: args.sourceId,
      provenanceId: args.provenanceId,
      value: {
        key,
        scheme: args.scheme,
        value: args.value,
        proposed: { entityKind: args.entityKind, entityId: args.entityId },
        held: args.heldBy,
      },
    },
  ];
  const inserted = await tx.execute(sql`
    INSERT INTO data_exceptions (kind, entity_kind, entity_id, field, candidates, status, sla_due_at)
    SELECT 'source_conflict', ${args.entityKind}::entity_kind, ${args.entityId}::bigint,
           ${args.scheme}, ${JSON.stringify(candidates)}::jsonb, 'open',
           clock_timestamp() + interval '2 days'
     WHERE NOT EXISTS (
       SELECT 1 FROM data_exceptions
        WHERE kind = 'source_conflict'
          AND candidates -> 0 -> 'value' ->> 'key' = ${key})
    RETURNING exception_id`);
  return inserted.rows.length;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Holding counts outside this band mean a misparse, not a rebalance (PROVIDERS §7.6). */
export const NPORT_MIN_HOLDINGS = 495;
export const NPORT_MAX_HOLDINGS = 515;

/** `Σ pctVal` must land here; the payload is a percent, so ≈100. */
export const NPORT_MIN_PCT_SUM = 99.0;
export const NPORT_MAX_PCT_SUM = 100.5;

/** `Σ valUSD` against `netAssets`. */
export const NPORT_VALUE_TOLERANCE = 0.01;

export interface SecNportRequest {
  /** Defaults to SPY. */
  cik?: string;
  accession?: string;
  /** Overrides the URL the CIK + accession would build. */
  url?: string;
  /** The index this fund proxies. Defaults to `'SPX'`. */
  indexCode?: string;
  /**
   * SEC `acceptanceDateTime` → `tx_from`: the instant this became known to us. The
   * `secSubmissions` poll has it; without one the capture instant is used, which is the instant
   * *we* learned it, and is never a wall clock (a 2030 replay stamps the 2026 capture).
   */
  acceptedAt?: Date;
  /**
   * Re-apply a filing whose `repPdDate` is not newer than what we hold. The freshness gate makes
   * the monthly job cheap; `force` is what proves the writes themselves are idempotent, which is
   * a different property and the one QA-02 measures.
   */
  force?: boolean;
}

export interface SecNportResult extends JobResult {
  status: 'ok' | 'skipped' | 'failed';
  provenanceId: number | null;
  asOfDate: string | null;
  /** `<invstOrSec>` blocks in the file — 504 in the recorded capture. */
  holdings: number;
  /** `assetCat EC` + `Long` + `NS` + `USD` — 503. */
  indexEligible: number;
  /** Distinct **published** CUSIP strings, placeholders included — 476. */
  distinctCusips: number;
  /** Holdings whose CUSIP is `000000000` or otherwise absent — 29. */
  placeholderCusips: number;
  /** Of the placeholder rows, how many the ISIN step rescued. */
  placeholderResolvedByIsin: number;
  resolved: number;
  unresolved: number;
  identifiersWritten: number;
  etfHoldings: UpsertCounts;
  members: SnapshotResult;
  /**
   * **Every** `data_exceptions` row this run wrote — unresolved holdings, duplicate lines AND the
   * `'source_conflict'` rows guard 3 files when a holding's LEI or CUSIP already points at
   * another entity. It was the unresolved ones only, which under-reported the recorded SPY filing
   * by three quarters (1 reported, 4 written: the LEIs shared by the Alphabet A/C, Fox A/B and
   * News A/B pairs are one conflict each).
   */
  exceptionsWritten: number;
  /** The `'source_conflict'` subset of {@link SecNportResult.exceptionsWritten} (REF-10). */
  conflictsWritten: number;
  dqEventsWritten: number;
  pctValSum: number;
  valueSum: number;
}

function emptyResult(): SecNportResult {
  return {
    fetched: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    provenanceIds: [],
    status: 'ok',
    provenanceId: null,
    asOfDate: null,
    holdings: 0,
    indexEligible: 0,
    distinctCusips: 0,
    placeholderCusips: 0,
    placeholderResolvedByIsin: 0,
    resolved: 0,
    unresolved: 0,
    identifiersWritten: 0,
    etfHoldings: { inserted: 0, updated: 0, unchanged: 0 },
    members: { written: 0, unchanged: 0, retired: 0 },
    exceptionsWritten: 0,
    conflictsWritten: 0,
    dqEventsWritten: 0,
    pctValSum: 0,
    valueSum: 0,
  };
}

/** `numeric` bind value: the published decimal string, never a float round-trip. */
function numericText(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed) ? trimmed : null;
}

/** `pctVal` (a percent) → `index_members.weight` (a fraction), at full decimal precision. */
export function percentToFraction(pct: string | null): string | null {
  const text = numericText(pct);
  if (text === null) return null;
  const negative = text.startsWith('-');
  const body = text.replace(/^[+-]/, '');
  if (body.includes('e') || body.includes('E')) return (Number(text) / 100).toFixed(10);
  const dot = body.indexOf('.');
  const digits = dot < 0 ? body : body.slice(0, dot) + body.slice(dot + 1);
  const scale = dot < 0 ? 0 : body.length - dot - 1;
  const padded = digits.padStart(scale + 3, '0');
  const cut = padded.length - (scale + 2);
  const head = padded.slice(0, cut) === '' ? '0' : padded.slice(0, cut);
  return `${negative ? '-' : ''}${head}.${padded.slice(cut)}`;
}

/**
 * Run the job inside `ctx.tx`.
 *
 * Order matters and is the order of PROVIDERS.b §1.3: fetch, parse, **validate**, then — and only
 * then — write provenance and rows. A file that fails its own sanity checks must leave no trace
 * but a `dq_events` row; writing provenance first would leave an orphan citation for data that
 * was never accepted.
 */
export async function runSecNport(
  ctx: RefIngestContext,
  req: SecNportRequest = {},
): Promise<SecNportResult> {
  const result = emptyResult();
  const cik = req.cik ?? SPY_CIK;
  const url = req.url ?? nportUrl(cik, req.accession ?? SPY_NPORT_ACCESSION);
  const indexCode = req.indexCode ?? 'SPX';

  const raw = await fetchRaw(ctx, {
    providerId: SEC_ARCHIVES_SOURCE_ID,
    url,
    cacheTtlMs: 24 * 60 * 60 * 1000,
    timeoutMs: 180_000,
  });
  result.fetched = 1;

  const parse = parseNport(raw.body.toString('utf8'));
  const asOfDate = parse.header.repPdDate;
  result.asOfDate = asOfDate;
  result.holdings = parse.holdings.length;
  result.indexEligible = parse.holdings.filter(isIndexEligible).length;
  result.distinctCusips = new Set(
    parse.holdings.map((h) => h.cusip).filter((c): c is string => c !== null),
  ).size;
  result.placeholderCusips = parse.holdings.filter((h) => h.cusipIsPlaceholder).length;
  result.pctValSum = parse.holdings.reduce((sum, h) => sum + (Number(h.pctVal) || 0), 0);
  result.valueSum = parse.holdings.reduce((sum, h) => sum + (Number(h.valUsd) || 0), 0);

  // ── validation: nothing is written when the file fails its own arithmetic ──────────────────
  const anomalies: { detail: string; details: Record<string, unknown> }[] = [];
  if (result.holdings < NPORT_MIN_HOLDINGS || result.holdings > NPORT_MAX_HOLDINGS) {
    anomalies.push({
      detail: 'holding count outside 495-515',
      details: {
        actual: result.holdings,
        expectedMin: NPORT_MIN_HOLDINGS,
        expectedMax: NPORT_MAX_HOLDINGS,
      },
    });
  }
  if (result.pctValSum < NPORT_MIN_PCT_SUM || result.pctValSum > NPORT_MAX_PCT_SUM) {
    anomalies.push({
      detail: 'sum of pctVal outside 99.0-100.5',
      details: { actual: result.pctValSum, repPdEnd: parse.header.repPdEnd },
    });
  }
  if (anomalies.length > 0) {
    for (const anomaly of anomalies) {
      result.dqEventsWritten += await recordDqEvent(ctx.tx, {
        kind: 'poll_anomaly',
        severity: 'error',
        sourceId: SEC_ARCHIVES_SOURCE_ID,
        subject: 'index_members',
        key: `${SEC_ARCHIVES_SOURCE_ID}:${asOfDate}:${anomaly.detail}`,
        details: { ...anomaly.details, detail: anomaly.detail, url },
      });
    }
    result.status = 'skipped';
    result.skipped = result.holdings;
    result.errors.push({ code: 'POLL_ANOMALY', message: anomalies[0]!.detail, url });
    return result;
  }

  const index = await findIndexByCode(ctx.tx, indexCode);
  if (index === null) {
    result.status = 'failed';
    result.errors.push({
      code: 'INDEX_NOT_CONFIGURED',
      message: `no indices row for ${indexCode}; WP-15's seed owns it`,
      url,
    });
    return result;
  }
  const etfInstrumentId = index.proxyFundInstrumentId;
  if (etfInstrumentId === null) {
    result.status = 'failed';
    result.errors.push({
      code: 'PROXY_FUND_NOT_CONFIGURED',
      message: `indices.${indexCode}.proxy_fund_instrument_id is NULL; N-PORT has no ETF to hang holdings on`,
      url,
    });
    return result;
  }

  // ── freshness: a repPdDate no newer than what we hold is a no-op (monthly re-runs are free) ──
  if (req.force !== true) {
    const stored = await latestAsOfDate(ctx.tx, index.indexId, SEC_ARCHIVES_SOURCE_ID);
    if (stored !== null && stored >= asOfDate) {
      result.status = 'skipped';
      result.skipped = result.holdings;
      ctx.log?.info?.('secNport.skipped', { asOfDate, stored, url });
      return result;
    }
  }

  const knownAt = req.acceptedAt ?? new Date(raw.capturedAt);
  const validFrom = instantOfDate(asOfDate);
  const at: AsOf = { validAt: validFrom, knownAt };

  const provenanceId = await insertProvenance(
    ctx.tx,
    raw,
    provenanceMeta(ctx, NPORT_ADAPTER_VERSION, parse.sourceTs),
  );
  result.provenanceId = provenanceId;
  result.provenanceIds.push(provenanceId);

  // ── resolve, then write ────────────────────────────────────────────────────────────────────
  const rows: EtfHoldingRow[] = [];
  const members: SnapshotMember[] = [];
  const claimed = new Map<number, number>();

  for (const holding of parse.holdings) {
    const keys: HoldingKeys = {
      // The placeholder screen: `000000000` never reaches a resolver or a column.
      cusip: holding.cusipIsPlaceholder ? null : presentIdentifier('CUSIP', holding.cusip),
      isin: presentIdentifier('ISIN', holding.isin),
      lei: presentIdentifier('LEI', holding.lei),
      sedol: null,
      ticker: null,
      name: holding.name,
    };
    const resolution = await resolveHolding(ctx.tx, keys, at);
    if (resolution.instrumentId !== null && resolution.candidate !== null) {
      result.resolved += 1;
      if (holding.cusipIsPlaceholder && resolution.method === 'isin') {
        result.placeholderResolvedByIsin += 1;
      }
      const identifierWrites = await writeHoldingIdentifiers(ctx.tx, {
        candidate: resolution.candidate,
        keys,
        sourceId: SEC_ARCHIVES_SOURCE_ID,
        provenanceId,
        validFrom,
        knownAt,
      });
      result.identifiersWritten += identifierWrites.written;
      result.conflictsWritten += identifierWrites.conflicts;
      result.exceptionsWritten += identifierWrites.conflicts;
    } else {
      result.unresolved += 1;
      result.exceptionsWritten += await recordUnresolvedHolding(ctx.tx, {
        sourceId: SEC_ARCHIVES_SOURCE_ID,
        provenanceId,
        asOfDate,
        lineNo: holding.lineNo,
        name: holding.name,
        tried: resolution.tried,
        reason: resolution.failure ?? 'unresolved',
      });
    }

    rows.push({
      etfInstrumentId,
      asOfDate,
      sourceId: SEC_ARCHIVES_SOURCE_ID,
      lineNo: holding.lineNo,
      holdingInstrumentId: resolution.instrumentId,
      name: holding.name,
      cusip: keys.cusip,
      isin: keys.isin,
      lei: keys.lei,
      sedol: null,
      ticker: null,
      shares: holding.units === 'NS' ? numericText(holding.balance) : null,
      marketValue: numericText(holding.valUsd),
      weight: percentToFraction(holding.pctVal),
      assetCat: holding.assetCat,
      issuerCat: holding.issuerCat,
      country: holding.country,
      provenanceId,
    });

    if (resolution.instrumentId === null || !isIndexEligible(holding)) continue;
    const previous = claimed.get(resolution.instrumentId);
    if (previous !== undefined) {
      // Two lines of one file naming one instrument would violate `index_members_bt_excl`.
      // Report it; never let it reach `recordSnapshot`.
      result.exceptionsWritten += await recordUnresolvedHolding(ctx.tx, {
        sourceId: SEC_ARCHIVES_SOURCE_ID,
        provenanceId,
        asOfDate,
        lineNo: holding.lineNo,
        name: holding.name,
        tried: [`DUPLICATE_OF_LINE:${String(previous)}`],
        reason: 'ambiguous',
      });
      continue;
    }
    claimed.set(resolution.instrumentId, holding.lineNo);
    members.push({
      instrumentId: resolution.instrumentId,
      weight: percentToFraction(holding.pctVal),
      shares: numericText(holding.balance),
      marketValue: numericText(holding.valUsd),
    });
  }

  result.etfHoldings = await upsertEtfHoldings(ctx.tx, rows);
  result.members = await recordSnapshot(ctx.tx, {
    indexId: index.indexId,
    asOfDate,
    sourceId: SEC_ARCHIVES_SOURCE_ID,
    provenanceId,
    members,
    txFrom: knownAt,
  });

  // ── post-write data quality (never blocks the write) ───────────────────────────────────────
  const netAssets = parse.header.netAssets;
  if (netAssets !== null && netAssets > 0) {
    const drift = Math.abs(result.valueSum - netAssets) / netAssets;
    if (drift > NPORT_VALUE_TOLERANCE) {
      result.dqEventsWritten += await recordDqEvent(ctx.tx, {
        kind: 'reconcile_mismatch',
        severity: 'warn',
        sourceId: SEC_ARCHIVES_SOURCE_ID,
        subject: 'etf_holdings',
        key: `${SEC_ARCHIVES_SOURCE_ID}:${asOfDate}:valUSD-vs-netAssets`,
        details: { expected: netAssets, actual: result.valueSum, diffPct: drift * 100 },
      });
    }
  }
  const coverage = result.holdings === 0 ? 1 : result.resolved / result.holdings;
  if (coverage < 0.98) {
    result.dqEventsWritten += await recordDqEvent(ctx.tx, {
      kind: 'field_population',
      severity: 'warn',
      sourceId: SEC_ARCHIVES_SOURCE_ID,
      subject: 'etf_holdings.holding_instrument_id',
      key: `${SEC_ARCHIVES_SOURCE_ID}:${asOfDate}:coverage`,
      details: { resolved: result.resolved, total: result.holdings, coverage },
    });
  }

  result.inserted = result.etfHoldings.inserted + result.members.written;
  result.updated = result.etfHoldings.updated;
  result.skipped = result.etfHoldings.unchanged + result.members.unchanged;
  ctx.log?.info?.('secNport.ok', {
    asOfDate,
    holdings: result.holdings,
    members: result.members.written,
    unresolved: result.unresolved,
  });
  return result;
}

/** The newest `as_of_date` this index holds from one source — the freshness gate. */
export async function latestAsOfDate(
  tx: Tx,
  indexId: number,
  sourceId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ asOfDate: sql<string | null>`max(${indexMembers.asOfDate})` })
    .from(indexMembers)
    .where(
      and(
        eq(indexMembers.indexId, indexId),
        eq(indexMembers.sourceId, sourceId),
        sql`${indexMembers.txTo} = 'infinity'`,
      ),
    );
  return rows[0]?.asOfDate ?? null;
}

/** The resolved constituents of one snapshot — what `ssgaHoldings.ts` reconciles against. */
export async function holdingsSnapshot(
  tx: Tx,
  args: { etfInstrumentId: number; asOfDate: string; sourceId: string },
): Promise<{ instrumentId: number; weight: number | null; shares: number | null }[]> {
  const rows = await tx
    .select({
      instrumentId: etfHoldings.holdingInstrumentId,
      weight: etfHoldings.weight,
      shares: etfHoldings.shares,
    })
    .from(etfHoldings)
    .where(
      and(
        eq(etfHoldings.etfInstrumentId, args.etfInstrumentId),
        eq(etfHoldings.asOfDate, args.asOfDate),
        eq(etfHoldings.sourceId, args.sourceId),
        isNotNull(etfHoldings.holdingInstrumentId),
      ),
    );
  return rows.map((r) => ({
    instrumentId: r.instrumentId!,
    weight: r.weight === null ? null : Number(r.weight),
    shares: r.shares === null ? null : Number(r.shares),
  }));
}

/** Re-exported so `ssgaHoldings.ts` can read the roster it must reconcile against. */
export { membersAsOf };

/** Re-exported so a caller can read the table this job writes without a second import. */
export { etfHoldings };

/**
 * The scheduler row (PROVIDERS §13): monthly at 04:00 ET on the 1st, plus immediately whenever
 * the hourly SPY submissions poll sees a new `NPORT-P`.
 */
export const job = {
  id: 'secNport',
  schedule: '0 4 1 * *',
  provider: SEC_ARCHIVES_SOURCE_ID,
  priority: 3 as const,
  timeoutMs: 180_000,
  run: (ctx: RefIngestContext): Promise<SecNportResult> => runSecNport(ctx),
};

/** The index whose membership this job publishes. */
export type { IndexRecord };
