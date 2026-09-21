/**
 * Classification schemes, codes and entity classifications — WORKPLAN WP-04 L694-699,
 * DATA_MODEL §5 (L824-860), CONTRACTS §1.2 L824-861, REF-07.
 *
 * Three tables and one parser:
 *
 *  - `classification_schemes` — `'GICS'`, `'SIC'`, `'NAICS'`, `'ICB'`, `'INTERNAL'`,
 *    `'NPORT_ASSETCAT'`; a name, a `source_id` and how many levels the scheme has;
 *  - `classification_codes` — `(scheme, code)` with `parent_code` and `level`, the tree itself;
 *  - `entity_classifications` — bitemporal, keyed `(entity_kind, entity_id, scheme)`: **one**
 *    current row per entity per scheme, carrying the *deepest* code we know. Every coarser
 *    question ("which sector?") is answered by walking `parent_code` up, never by a second row —
 *    `entity_classifications_bt_excl` would reject it, and a sector row that disagreed with its
 *    own sub-industry row is precisely the inconsistency the exclusion constraint exists to stop.
 *
 * ## The `wiki-sp500.html` GICS parse
 *
 * There is no licensed GICS feed here. The Wikipedia S&P 500 constituent table
 * (`source_id 'wiki.sp500'`, `licence_kind cc_by_sa`, PROVIDERS §15) is the **only** source of
 * GICS sector and sub-industry *names* for S&P 500 issuers, and it publishes names, not codes.
 * {@link GICS_NODES} is the code side of that join: the GICS 2023 structure for every
 * sub-industry the capture uses plus all of their ancestors — 232 codes (127 sub-industries,
 * 69 industries, 25 industry groups, 11 sectors). DATA_MODEL L2563's "≈ 180" is an estimate made
 * before the capture was counted; the number below is what the recorded bytes actually require.
 *
 * MEMB's sector subtotals and SECF's `gicsSector` both read what this writes, and both are
 * `null`/absent outside the S&P 500 — that is the documented `GICS_SP500_ONLY` gap
 * (FUNCTIONS_TIER1 L2317), not a bug to paper over with a guess.
 *
 * The parser is a tolerant scanner, not an HTML tree: it takes the `id="constituents"` table,
 * reads `<tr>`/`<td>` spans, strips tags, footnote markers and entities, and **never throws**.
 * A malformed capture yields fewer rows and a `problems[]` entry per row it could not read, so an
 * ingest sees a count it can compare against its expectation instead of a stack trace.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  asOf,
  bitemporal,
  upsertVersion,
  writeVersion,
  type AsOf,
  type VersionWrite,
} from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';
import {
  classificationCodes,
  classificationSchemes,
  entityClassifications,
} from '../db/schema/calendars.js';
import type { ReplayStore } from '../providers/replayStore.js';
import type { RawRecord } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Scheme constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `classification_schemes.scheme` for GICS. */
export const GICS = 'GICS';

/** `licence_registry.source_id` of the GICS names (PROVIDERS §15, `licence_kind cc_by_sa`). */
export const WIKI_SP500_SOURCE_ID = 'wiki.sp500';

/** The recorded request: `fixtures/providers/manifest.json` holds one capture of this URL. */
export const WIKI_SP500_URL = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';

/** Attribution obligation of the capture — CC BY-SA 4.0, carried onto every screen that shows it. */
export const WIKI_SP500_ATTRIBUTION =
  'Constituent list and GICS sectors: Wikipedia contributors (CC BY-SA 4.0).';

/** `entity_classifications.entity_kind` — the `entity_kind` enum, narrowed to what REF-07 uses. */
export type ClassifiedEntityKind = 'issuer' | 'instrument';

/** GICS levels: 1 sector (2 digits), 2 industry group (4), 3 industry (6), 4 sub-industry (8). */
export type GicsLevel = 1 | 2 | 3 | 4;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The GICS tree
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `classification_codes` row. `parentCode` is `null` at level 1. */
export interface ClassificationCode {
  scheme: string;
  code: string;
  name: string;
  parentCode: string | null;
  level: number;
}

/**
 * GICS 2023 codes for everything the `wiki-sp500.html` capture names, ancestors included.
 *
 * Ordered sector → industry group → industry → sub-industry, so a reader can check a branch at a
 * glance and `classification_codes.parent_code` is always already present when a row is written.
 * `parent_code` is not written here: it is the code minus its last two digits, and deriving it
 * (rather than repeating it) makes a typo in the tree impossible to hide.
 */
export const GICS_NODES: readonly (readonly [code: string, name: string])[] = Object.freeze([
  // ── 10 Energy ───────────────────────────────────────────────────────────────────────────────
  ['10', 'Energy'],
  ['1010', 'Energy'],
  ['101010', 'Energy Equipment & Services'],
  ['10101020', 'Oil & Gas Equipment & Services'],
  ['101020', 'Oil, Gas & Consumable Fuels'],
  ['10102010', 'Integrated Oil & Gas'],
  ['10102020', 'Oil & Gas Exploration & Production'],
  ['10102030', 'Oil & Gas Refining & Marketing'],
  ['10102040', 'Oil & Gas Storage & Transportation'],

  // ── 15 Materials ────────────────────────────────────────────────────────────────────────────
  ['15', 'Materials'],
  ['1510', 'Materials'],
  ['151010', 'Chemicals'],
  ['15101010', 'Commodity Chemicals'],
  ['15101030', 'Fertilizers & Agricultural Chemicals'],
  ['15101040', 'Industrial Gases'],
  ['15101050', 'Specialty Chemicals'],
  ['151020', 'Construction Materials'],
  ['15102010', 'Construction Materials'],
  ['151030', 'Containers & Packaging'],
  ['15103010', 'Metal, Glass & Plastic Containers'],
  ['15103020', 'Paper & Plastic Packaging Products & Materials'],
  ['151040', 'Metals & Mining'],
  ['15104025', 'Copper'],
  ['15104030', 'Gold'],
  ['15104050', 'Steel'],

  // ── 20 Industrials ──────────────────────────────────────────────────────────────────────────
  ['20', 'Industrials'],
  ['2010', 'Capital Goods'],
  ['201010', 'Aerospace & Defense'],
  ['20101010', 'Aerospace & Defense'],
  ['201020', 'Building Products'],
  ['20102010', 'Building Products'],
  ['201030', 'Construction & Engineering'],
  ['20103010', 'Construction & Engineering'],
  ['201040', 'Electrical Equipment'],
  ['20104010', 'Electrical Components & Equipment'],
  ['20104020', 'Heavy Electrical Equipment'],
  ['201050', 'Industrial Conglomerates'],
  ['20105010', 'Industrial Conglomerates'],
  ['201060', 'Machinery'],
  ['20106010', 'Construction Machinery & Heavy Transportation Equipment'],
  ['20106015', 'Agricultural & Farm Machinery'],
  ['20106020', 'Industrial Machinery & Supplies & Components'],
  ['201070', 'Trading Companies & Distributors'],
  ['20107010', 'Trading Companies & Distributors'],
  ['2020', 'Commercial & Professional Services'],
  ['202010', 'Commercial Services & Supplies'],
  ['20201050', 'Environmental & Facilities Services'],
  ['20201070', 'Diversified Support Services'],
  ['202020', 'Professional Services'],
  ['20202010', 'Human Resource & Employment Services'],
  ['20202020', 'Research & Consulting Services'],
  ['20202030', 'Data Processing & Outsourced Services'],
  ['2030', 'Transportation'],
  ['203010', 'Air Freight & Logistics'],
  ['20301010', 'Air Freight & Logistics'],
  ['203020', 'Passenger Airlines'],
  ['20302010', 'Passenger Airlines'],
  ['203040', 'Ground Transportation'],
  ['20304010', 'Rail Transportation'],
  ['20304030', 'Cargo Ground Transportation'],
  ['20304040', 'Passenger Ground Transportation'],

  // ── 25 Consumer Discretionary ───────────────────────────────────────────────────────────────
  ['25', 'Consumer Discretionary'],
  ['2510', 'Automobiles & Components'],
  ['251010', 'Automobile Components'],
  ['25101010', 'Automotive Parts & Equipment'],
  ['251020', 'Automobiles'],
  ['25102010', 'Automobile Manufacturers'],
  ['2520', 'Consumer Durables & Apparel'],
  ['252010', 'Household Durables'],
  ['25201010', 'Consumer Electronics'],
  ['25201030', 'Homebuilding'],
  ['252020', 'Leisure Products'],
  ['25202010', 'Leisure Products'],
  ['252030', 'Textiles, Apparel & Luxury Goods'],
  ['25203010', 'Apparel, Accessories & Luxury Goods'],
  ['25203020', 'Footwear'],
  ['2530', 'Consumer Services'],
  ['253010', 'Hotels, Restaurants & Leisure'],
  ['25301010', 'Casinos & Gaming'],
  ['25301020', 'Hotels, Resorts & Cruise Lines'],
  ['25301040', 'Restaurants'],
  ['253020', 'Diversified Consumer Services'],
  ['25302020', 'Specialized Consumer Services'],
  ['2550', 'Consumer Discretionary Distribution & Retail'],
  ['255010', 'Distributors'],
  ['25501010', 'Distributors'],
  ['255030', 'Broadline Retail'],
  ['25503030', 'Broadline Retail'],
  ['255040', 'Specialty Retail'],
  ['25504010', 'Apparel Retail'],
  ['25504020', 'Computer & Electronics Retail'],
  ['25504030', 'Home Improvement Retail'],
  ['25504040', 'Other Specialty Retail'],
  ['25504050', 'Automotive Retail'],
  ['25504060', 'Homefurnishing Retail'],

  // ── 30 Consumer Staples ─────────────────────────────────────────────────────────────────────
  ['30', 'Consumer Staples'],
  ['3010', 'Consumer Staples Distribution & Retail'],
  ['301010', 'Consumer Staples Distribution & Retail'],
  ['30101020', 'Food Distributors'],
  ['30101030', 'Food Retail'],
  ['30101040', 'Consumer Staples Merchandise Retail'],
  ['3020', 'Food, Beverage & Tobacco'],
  ['302010', 'Beverages'],
  ['30201010', 'Brewers'],
  ['30201020', 'Distillers & Vintners'],
  ['30201030', 'Soft Drinks & Non-alcoholic Beverages'],
  ['302020', 'Food Products'],
  ['30202010', 'Agricultural Products & Services'],
  ['30202030', 'Packaged Foods & Meats'],
  ['302030', 'Tobacco'],
  ['30203010', 'Tobacco'],
  ['3030', 'Household & Personal Products'],
  ['303010', 'Household Products'],
  ['30301010', 'Household Products'],
  ['303020', 'Personal Care Products'],
  ['30302010', 'Personal Care Products'],

  // ── 35 Health Care ──────────────────────────────────────────────────────────────────────────
  ['35', 'Health Care'],
  ['3510', 'Health Care Equipment & Services'],
  ['351010', 'Health Care Equipment & Supplies'],
  ['35101010', 'Health Care Equipment'],
  ['35101020', 'Health Care Supplies'],
  ['351020', 'Health Care Providers & Services'],
  ['35102010', 'Health Care Distributors'],
  ['35102015', 'Health Care Services'],
  ['35102020', 'Health Care Facilities'],
  ['35102030', 'Managed Health Care'],
  ['351030', 'Health Care Technology'],
  ['35103010', 'Health Care Technology'],
  ['3520', 'Pharmaceuticals, Biotechnology & Life Sciences'],
  ['352010', 'Biotechnology'],
  ['35201010', 'Biotechnology'],
  ['352020', 'Pharmaceuticals'],
  ['35202010', 'Pharmaceuticals'],
  ['352030', 'Life Sciences Tools & Services'],
  ['35203010', 'Life Sciences Tools & Services'],

  // ── 40 Financials ───────────────────────────────────────────────────────────────────────────
  ['40', 'Financials'],
  ['4010', 'Banks'],
  ['401010', 'Banks'],
  ['40101010', 'Diversified Banks'],
  ['40101015', 'Regional Banks'],
  ['4020', 'Financial Services'],
  ['402010', 'Financial Services'],
  ['40201030', 'Multi-Sector Holdings'],
  ['40201060', 'Transaction & Payment Processing Services'],
  ['402020', 'Consumer Finance'],
  ['40202010', 'Consumer Finance'],
  ['402030', 'Capital Markets'],
  ['40203010', 'Asset Management & Custody Banks'],
  ['40203020', 'Investment Banking & Brokerage'],
  ['40203040', 'Financial Exchanges & Data'],
  ['4030', 'Insurance'],
  ['403010', 'Insurance'],
  ['40301010', 'Insurance Brokers'],
  ['40301020', 'Life & Health Insurance'],
  ['40301030', 'Multi-line Insurance'],
  ['40301040', 'Property & Casualty Insurance'],
  ['40301050', 'Reinsurance'],

  // ── 45 Information Technology ───────────────────────────────────────────────────────────────
  ['45', 'Information Technology'],
  ['4510', 'Software & Services'],
  ['451020', 'IT Services'],
  ['45102010', 'IT Consulting & Other Services'],
  ['45102030', 'Internet Services & Infrastructure'],
  ['451030', 'Software'],
  ['45103010', 'Application Software'],
  ['45103020', 'Systems Software'],
  ['4520', 'Technology Hardware & Equipment'],
  ['452010', 'Communications Equipment'],
  ['45201020', 'Communications Equipment'],
  ['452020', 'Technology Hardware, Storage & Peripherals'],
  ['45202030', 'Technology Hardware, Storage & Peripherals'],
  ['452030', 'Electronic Equipment, Instruments & Components'],
  ['45203010', 'Electronic Equipment & Instruments'],
  ['45203015', 'Electronic Components'],
  ['45203020', 'Electronic Manufacturing Services'],
  ['45203030', 'Technology Distributors'],
  ['4530', 'Semiconductors & Semiconductor Equipment'],
  ['453010', 'Semiconductors & Semiconductor Equipment'],
  ['45301010', 'Semiconductor Materials & Equipment'],
  ['45301020', 'Semiconductors'],

  // ── 50 Communication Services ───────────────────────────────────────────────────────────────
  ['50', 'Communication Services'],
  ['5010', 'Telecommunication Services'],
  ['501010', 'Diversified Telecommunication Services'],
  ['50101020', 'Integrated Telecommunication Services'],
  ['501020', 'Wireless Telecommunication Services'],
  ['50102010', 'Wireless Telecommunication Services'],
  ['5020', 'Media & Entertainment'],
  ['502010', 'Media'],
  ['50201010', 'Advertising'],
  ['50201020', 'Broadcasting'],
  ['50201030', 'Cable & Satellite'],
  ['50201040', 'Publishing'],
  ['502020', 'Entertainment'],
  ['50202010', 'Movies & Entertainment'],
  ['50202020', 'Interactive Home Entertainment'],
  ['502030', 'Interactive Media & Services'],
  ['50203010', 'Interactive Media & Services'],

  // ── 55 Utilities ────────────────────────────────────────────────────────────────────────────
  ['55', 'Utilities'],
  ['5510', 'Utilities'],
  ['551010', 'Electric Utilities'],
  ['55101010', 'Electric Utilities'],
  ['551020', 'Gas Utilities'],
  ['55102010', 'Gas Utilities'],
  ['551030', 'Multi-Utilities'],
  ['55103010', 'Multi-Utilities'],
  ['551040', 'Water Utilities'],
  ['55104010', 'Water Utilities'],
  ['551050', 'Independent Power and Renewable Electricity Producers'],
  ['55105010', 'Independent Power Producers & Energy Traders'],

  // ── 60 Real Estate ──────────────────────────────────────────────────────────────────────────
  ['60', 'Real Estate'],
  ['6010', 'Equity Real Estate Investment Trusts (REITs)'],
  ['601025', 'Industrial REITs'],
  ['60102510', 'Industrial REITs'],
  ['601030', 'Hotel & Resort REITs'],
  ['60103010', 'Hotel & Resort REITs'],
  ['601040', 'Office REITs'],
  ['60104010', 'Office REITs'],
  ['601050', 'Health Care REITs'],
  ['60105010', 'Health Care REITs'],
  ['601060', 'Residential REITs'],
  ['60106010', 'Multi-Family Residential REITs'],
  ['60106020', 'Single-Family Residential REITs'],
  ['601070', 'Retail REITs'],
  ['60107010', 'Retail REITs'],
  ['601080', 'Specialized REITs'],
  ['60108010', 'Other Specialized REITs'],
  ['60108020', 'Self-Storage REITs'],
  ['60108030', 'Telecom Tower REITs'],
  ['60108040', 'Timber REITs'],
  ['60108050', 'Data Center REITs'],
  ['6020', 'Real Estate Management & Development'],
  ['602010', 'Real Estate Management & Development'],
  ['60201040', 'Real Estate Services'],
]);

/** The GICS tree as `classification_codes` rows, `parent_code` derived from the code. */
export function gicsCodes(): ClassificationCode[] {
  return GICS_NODES.map(([code, name]) => ({
    scheme: GICS,
    code,
    name,
    parentCode: code.length > 2 ? code.slice(0, code.length - 2) : null,
    level: code.length / 2,
  }));
}

/**
 * Fold a classification name for lookup: case, `&`/`and`, punctuation and whitespace all stop
 * mattering. `'Soft Drinks & Non-alcoholic Beverages'`, `'Soft Drinks and Non-Alcoholic
 * Beverages'` and `'Soft  Drinks &  Non‑alcoholic  Beverages'` are one key, which is what lets
 * the SSGA sector names (PROVIDERS L1775) and the Wikipedia names meet in the same table.
 */
export function foldClassificationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface GicsIndex {
  byCode: Map<string, ClassificationCode>;
  /** Folded name → codes carrying it, per level (a name may repeat across levels). */
  byName: Map<number, Map<string, string[]>>;
}

let gicsIndex: GicsIndex | undefined;

function index(): GicsIndex {
  if (gicsIndex !== undefined) return gicsIndex;
  const byCode = new Map<string, ClassificationCode>();
  const byName = new Map<number, Map<string, string[]>>();
  for (const node of gicsCodes()) {
    byCode.set(node.code, node);
    const level = byName.get(node.level) ?? new Map<string, string[]>();
    const key = foldClassificationName(node.name);
    const codes = level.get(key) ?? [];
    codes.push(node.code);
    level.set(key, codes);
    byName.set(node.level, level);
  }
  gicsIndex = { byCode, byName };
  return gicsIndex;
}

/** The GICS node for a code, or `undefined` when the code is not part of the seeded tree. */
export function gicsNode(code: string): ClassificationCode | undefined {
  return index().byCode.get(code);
}

/**
 * The GICS code for a published *name* at `level`, or `null`.
 *
 * `null` rather than a throw, and `null` rather than a guess: SSGA and Wikipedia both publish
 * free text, a name we do not know is a name we do not classify (PROVIDERS L1775), and the caller
 * records it as a problem rather than filing the issuer under a plausible neighbour. An ambiguous
 * name — the same name on two codes at one level, which the seeded tree does not contain — is
 * also `null`.
 */
export function gicsCodeForName(name: string, level: GicsLevel): string | null {
  const codes = index().byName.get(level)?.get(foldClassificationName(name));
  if (codes?.length !== 1) return null;
  return codes[0] ?? null;
}

/** The sector (level 1) code for a published sector name, or `null`. */
export const gicsSectorCode = (name: string): string | null => gicsCodeForName(name, 1);

/** The sub-industry (level 4) code for a published sub-industry name, or `null`. */
export const gicsSubIndustryCode = (name: string): string | null => gicsCodeForName(name, 4);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// wiki-sp500.html
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One parsed constituent row. Codes are `null` when the published name is not in the tree. */
export interface WikiSp500Row {
  /** The ticker as Wikipedia publishes it: `'BRK.B'`, not the Cboe `'BRK B'`. */
  symbol: string;
  security: string;
  gicsSector: string;
  gicsSubIndustry: string;
  headquarters: string;
  /** `YYYY-MM-DD` when the cell holds a full date, else `null`. */
  dateAdded: string | null;
  /** Ten digits, zero-padded, or `null` when the cell is not a CIK. */
  cik: string | null;
  founded: string;
  sectorCode: string | null;
  subIndustryCode: string | null;
}

/** Why a row, or the whole table, could not be read. */
export interface WikiSp500Problem {
  kind: 'no_table' | 'short_row' | 'empty_symbol' | 'unknown_sector' | 'unknown_sub_industry';
  /** 1-based index among the table's body rows, `null` for a whole-document problem. */
  row: number | null;
  detail: string;
}

/** The result of {@link parseWikiSp500}. Always a value — this parser does not throw. */
export interface WikiSp500Parse {
  rows: WikiSp500Row[];
  problems: WikiSp500Problem[];
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  eacute: 'é',
  egrave: 'è',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  ccedil: 'ç',
  aacute: 'á',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  szlig: 'ß',
  shy: '',
});

/** Decode the entities a MediaWiki page actually emits; leave anything unknown verbatim. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** A cell's HTML → its text: scripts and styles dropped, tags stripped, entities decoded. */
function cellText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      // Wikipedia footnote markers: <sup class="reference">[1]</sup>
      .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\[\d+\]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The `<td>`/`<th>` cells of one row, in order. */
function rowCells(rowHtml: string): string[] {
  const out: string[] = [];
  const re = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowHtml)) !== null) out.push(cellText(m[1] ?? ''));
  return out;
}

/** The substring of `html` holding the constituents table, or `null`. */
function constituentsTable(html: string): string | null {
  // The id may precede or follow the class attribute, so anchor on the id and walk back to the
  // `<table` that opens it rather than matching the whole tag in one pattern.
  const idAt = html.search(/<table\b[^>]*\bid="constituents"/i);
  const start = idAt >= 0 ? idAt : html.search(/<table\b[^>]*>[\s\S]{0,4000}?GICS\s*Sector/i);
  if (start < 0) return null;
  const end = html.indexOf('</table>', start);
  return end < 0 ? html.slice(start) : html.slice(start, end);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse the recorded S&P 500 constituent table.
 *
 * Tolerant by contract (WP-04 acceptance): a missing table, a short row or an unreadable cell is
 * a `problems[]` entry, never an exception. The header row is skipped by shape — a row whose
 * first cell is `'Symbol'` — rather than by index, so an extra `<tr>` of column groups cannot
 * shift every field by one.
 */
export function parseWikiSp500(html: string): WikiSp500Parse {
  const problems: WikiSp500Problem[] = [];
  const rows: WikiSp500Row[] = [];

  const table = constituentsTable(html);
  if (table === null) {
    problems.push({
      kind: 'no_table',
      row: null,
      detail: 'no <table id="constituents"> and no table whose header names a GICS Sector column',
    });
    return { rows, problems };
  }

  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  let ordinal = 0;
  while ((match = trRe.exec(table)) !== null) {
    const cells = rowCells(match[1] ?? '');
    if (cells.length === 0) continue;
    const first = cells[0] ?? '';
    if (/^symbol$/i.test(first) || /^ticker/i.test(first)) continue; // header
    ordinal += 1;

    if (cells.length < 4) {
      problems.push({
        kind: 'short_row',
        row: ordinal,
        detail: `${cells.length} cells, need at least 4 (symbol, security, sector, sub-industry)`,
      });
      continue;
    }
    const symbol = first;
    if (symbol === '') {
      problems.push({ kind: 'empty_symbol', row: ordinal, detail: 'the symbol cell is empty' });
      continue;
    }

    const gicsSector = cells[2] ?? '';
    const gicsSubIndustry = cells[3] ?? '';
    const sectorCode = gicsSector === '' ? null : gicsSectorCode(gicsSector);
    const subIndustryCode = gicsSubIndustry === '' ? null : gicsSubIndustryCode(gicsSubIndustry);
    if (sectorCode === null) {
      problems.push({
        kind: 'unknown_sector',
        row: ordinal,
        detail: `${symbol}: GICS sector '${gicsSector}' is not in the seeded tree`,
      });
    }
    if (subIndustryCode === null) {
      problems.push({
        kind: 'unknown_sub_industry',
        row: ordinal,
        detail: `${symbol}: GICS sub-industry '${gicsSubIndustry}' is not in the seeded tree`,
      });
    }

    const dateCell = cells[5] ?? '';
    const cikCell = (cells[6] ?? '').replace(/\D/g, '');
    rows.push({
      symbol,
      security: cells[1] ?? '',
      gicsSector,
      gicsSubIndustry,
      headquarters: cells[4] ?? '',
      dateAdded: ISO_DAY.test(dateCell) ? dateCell : null,
      cik: cikCell === '' ? null : cikCell.padStart(10, '0').slice(-10),
      founded: cells[7] ?? '',
      sectorCode,
      subIndustryCode,
    });
  }

  return { rows, problems };
}

/** The raw capture plus its parse, straight out of the replay store (no network, ever). */
export interface WikiSp500Capture {
  raw: RawRecord;
  parse: WikiSp500Parse;
}

/**
 * Read `wiki-sp500.html` through the replay store and parse it.
 *
 * `store.replay()` is the wall (PROVIDERS.a §3.6): a missing capture throws `ReplayMissError`
 * with the key it computed, and nothing falls through to a socket. The `RawRecord` carries the
 * `requestKey`, `sha256` and `capturedAt` a `provenance` row needs, so the caller can write the
 * provenance before any GICS row is written.
 */
export function loadWikiSp500(store: ReplayStore): WikiSp500Capture {
  const raw = store.replay({ providerId: WIKI_SP500_SOURCE_ID, method: 'GET', url: WIKI_SP500_URL });
  return { raw, parse: parseWikiSp500(raw.body.toString('utf8')) };
}

/** One issuer's GICS assignment, ready for {@link ClassificationRepository.classify}. */
export interface GicsAssignment {
  symbol: string;
  cik: string | null;
  /** The deepest code we know — the sub-industry. Sector is its level-1 ancestor. */
  code: string;
}

/**
 * The rows that carry a resolved sub-industry code, as assignments.
 *
 * A row whose sub-industry name is unknown is left out rather than filed at sector level: one row
 * per entity per scheme means a sector-level row would *be* the issuer's classification, and RV's
 * `SUB_INDUSTRY` peer basis would silently fall back for it.
 */
export function gicsAssignments(parse: WikiSp500Parse): GicsAssignment[] {
  const out: GicsAssignment[] = [];
  for (const row of parse.rows) {
    if (row.subIndustryCode === null) continue;
    out.push({ symbol: row.symbol, cik: row.cik, code: row.subIndustryCode });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Writes and reads
// ─────────────────────────────────────────────────────────────────────────────────────────────

const BT_ENTITY_CLASSIFICATIONS = bitemporal(
  entityClassifications,
  'entityKind',
  'entityId',
  'scheme',
);

const INSERT_CHUNK = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `classification_schemes` — plain reference data, upserted by primary key. */
export async function upsertScheme(
  tx: Tx,
  scheme: { scheme: string; name: string; sourceId: string; levels: number },
): Promise<void> {
  await tx
    .insert(classificationSchemes)
    .values(scheme)
    .onConflictDoUpdate({
      target: classificationSchemes.scheme,
      set: {
        name: scheme.name,
        sourceId: scheme.sourceId,
        levels: scheme.levels,
      },
    });
}

/**
 * `classification_codes` — upserted parents first, so the self-referencing `parent_code` is never
 * written before the row it points at. Returns the number of rows written.
 */
export async function upsertCodes(tx: Tx, codes: readonly ClassificationCode[]): Promise<number> {
  if (codes.length === 0) return 0;
  const ordered = [...codes].sort((a, b) => a.level - b.level || a.code.localeCompare(b.code));
  for (const batch of chunk(ordered, INSERT_CHUNK)) {
    await tx
      .insert(classificationCodes)
      .values(batch)
      .onConflictDoUpdate({
        target: [classificationCodes.scheme, classificationCodes.code],
        set: {
          name: sql`excluded.name`,
          parentCode: sql`excluded.parent_code`,
          level: sql`excluded.level`,
        },
      });
  }
  return ordered.length;
}

/**
 * Write the `GICS` scheme row and its whole seeded tree.
 *
 * `source_id` is `'wiki.sp500'` (CONTRACTS §1.2 L824): the *names* are the licensed-by-CC-BY-SA
 * part, and they are what this table exists to hold. Idempotent, so the seed and any later
 * refresh may both run it.
 */
export async function upsertGicsTaxonomy(tx: Tx): Promise<number> {
  await upsertScheme(tx, {
    scheme: GICS,
    name: 'Global Industry Classification Standard',
    sourceId: WIKI_SP500_SOURCE_ID,
    levels: 4,
  });
  return upsertCodes(tx, gicsCodes());
}

/** A resolved classification: the stored code, plus the tree row it names. */
export interface EntityClassification {
  entityKind: ClassifiedEntityKind;
  entityId: number;
  scheme: string;
  code: string;
  /** `classification_codes.name`, or `null` when the code has no row (an unseeded scheme). */
  name: string | null;
  level: number | null;
  provenanceId: number;
  validFrom: string;
  validTo: string;
}

/** One classification write. */
export interface ClassificationWrite {
  entityKind: ClassifiedEntityKind;
  entityId: number;
  scheme: string;
  code: string;
  validFrom: Date;
  validTo?: Date;
  provenanceId: number;
  reason: 'initial' | 'change' | 'correction';
  /** knownAt — the instant the classification became known (a GICS change is dated). */
  txFrom?: Date;
}

function classificationVersion(w: ClassificationWrite): VersionWrite<Record<string, unknown>> {
  return {
    entityKey: { entityKind: w.entityKind, entityId: w.entityId, scheme: w.scheme },
    validFrom: w.validFrom,
    ...(w.validTo === undefined ? {} : { validTo: w.validTo }),
    data: { entityKind: w.entityKind, entityId: w.entityId, scheme: w.scheme, code: w.code },
    provenanceId: w.provenanceId,
    reason: w.reason,
    ...(w.txFrom === undefined ? {} : { txFrom: w.txFrom }),
  };
}

/**
 * Schemes, codes and `entity_classifications`, bound to one transaction.
 *
 * The scheme's code tree is loaded at most once per repository (232 rows for GICS) and the
 * ancestor walk happens in memory: a sector subtotal over 503 members is one query for the
 * classifications and one for the tree, not 503 recursive CTEs.
 */
export class ClassificationRepository {
  readonly #trees = new Map<string, Map<string, ClassificationCode>>();

  constructor(private readonly tx: Tx) {}

  // ── Writes ──────────────────────────────────────────────────────────────────────────────────

  /** Classify one entity. Closes the previous version and opens the new one. */
  async classify(w: ClassificationWrite): Promise<number> {
    return writeVersion<Record<string, unknown>>(
      this.tx,
      BT_ENTITY_CLASSIFICATIONS,
      classificationVersion(w),
    );
  }

  /** `classify`, except that an unchanged code writes nothing and returns `null` (idempotence). */
  async upsertClassification(w: ClassificationWrite): Promise<number | null> {
    return upsertVersion<Record<string, unknown>>(
      this.tx,
      BT_ENTITY_CLASSIFICATIONS,
      classificationVersion(w),
    );
  }

  /**
   * `upsertClassification` for a list, in order. Returns how many actually wrote a version —
   * which is what an ingest job reports, and what makes "a second run writes nothing" a row
   * count rather than a boolean.
   */
  async upsertClassifications(writes: readonly ClassificationWrite[]): Promise<number> {
    let written = 0;
    for (const w of writes) {
      if ((await this.upsertClassification(w)) !== null) written += 1;
    }
    return written;
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────────────────

  /**
   * The scheme's code tree, keyed by code, loaded once per repository.
   *
   * Cached because a sector subtotal over 503 members would otherwise be 503 recursive lookups.
   * A repository that read a tree before {@link upsertCodes} extended it holds the older one —
   * call {@link ClassificationRepository.invalidate} after writing codes, or build the repository
   * afterwards, which is what the seed does.
   */
  async tree(scheme: string): Promise<Map<string, ClassificationCode>> {
    const hit = this.#trees.get(scheme);
    if (hit !== undefined) return hit;
    const rows = await this.tx
      .select()
      .from(classificationCodes)
      .where(eq(classificationCodes.scheme, scheme));
    const tree = new Map<string, ClassificationCode>(
      rows.map((r) => [
        r.code,
        { scheme: r.scheme, code: r.code, name: r.name, parentCode: r.parentCode, level: r.level },
      ]),
    );
    this.#trees.set(scheme, tree);
    return tree;
  }

  /** Drop the cached code tree(s) after writing to `classification_codes`. */
  invalidate(scheme?: string): void {
    if (scheme === undefined) this.#trees.clear();
    else this.#trees.delete(scheme);
  }

  /** The classification of one entity under `scheme` at `(validAt, knownAt)`, or `null`. */
  async read(
    entityKind: ClassifiedEntityKind,
    entityId: number,
    scheme: string,
    at: AsOf,
  ): Promise<EntityClassification | null> {
    const rows = await this.readMany(entityKind, [entityId], scheme, at);
    return rows.get(entityId) ?? null;
  }

  /** The same for many entities, in one query, keyed by `entity_id`. */
  async readMany(
    entityKind: ClassifiedEntityKind,
    entityIds: readonly number[],
    scheme: string,
    at: AsOf,
  ): Promise<Map<number, EntityClassification>> {
    const out = new Map<number, EntityClassification>();
    if (entityIds.length === 0) return out;
    const ids = [...new Set(entityIds)];

    const rows = await this.tx
      .select()
      .from(entityClassifications)
      .where(
        and(
          eq(entityClassifications.entityKind, entityKind),
          inArray(entityClassifications.entityId, ids),
          eq(entityClassifications.scheme, scheme),
          asOf(entityClassifications, at),
        ),
      );
    if (rows.length === 0) return out;

    const tree = await this.tree(scheme);
    for (const row of rows) {
      const node = tree.get(row.code);
      out.set(row.entityId, {
        entityKind,
        entityId: row.entityId,
        scheme: row.scheme,
        code: row.code,
        name: node?.name ?? null,
        level: node?.level ?? null,
        provenanceId: row.provenanceId,
        validFrom: row.validFrom,
        validTo: row.validTo,
      });
    }
    return out;
  }

  /**
   * Walk `code` up to `level` — `('45202030', 1)` → `'45'` `Information Technology`.
   *
   * By `parent_code`, not by truncating the string: SIC and NAICS codes do not nest by prefix,
   * and a reader that truncated would answer confidently and wrongly for them. `null` when the
   * code is unknown, or when it is already shallower than `level`.
   */
  async ancestor(scheme: string, code: string, level: number): Promise<ClassificationCode | null> {
    const tree = await this.tree(scheme);
    let node = tree.get(code);
    // `tree.size + 1` steps at most: a cycle in `parent_code` would otherwise spin forever.
    for (let step = 0; node !== undefined && step <= tree.size; step += 1) {
      if (node.level === level) return node;
      if (node.parentCode === null) return null;
      node = tree.get(node.parentCode);
    }
    return null;
  }

  /**
   * The GICS **sector** (level 1) of each entity — what MEMB subtotals by and what SECF's
   * `gicsSector` prints. Entities with no GICS row are absent from the map, which is the
   * `GICS_SP500_ONLY` gap made visible rather than a `'Unknown'` bucket.
   */
  async sectorsFor(
    entityKind: ClassifiedEntityKind,
    entityIds: readonly number[],
    at: AsOf,
    scheme: string = GICS,
  ): Promise<Map<number, ClassificationCode>> {
    const classified = await this.readMany(entityKind, entityIds, scheme, at);
    const out = new Map<number, ClassificationCode>();
    for (const [entityId, row] of classified) {
      const sector = await this.ancestor(scheme, row.code, 1);
      if (sector !== null) out.set(entityId, sector);
    }
    return out;
  }
}
