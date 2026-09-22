/**
 * A tolerant HTML tokeniser and table extractor — PROVIDERS.b §16.5 (§18.5), WORKPLAN WP-05.
 *
 * The second of the four shared parsers. Three pages in this system are published as HTML with no
 * contract behind them, and all three are read here:
 *
 * | Page | Fixture | What it needs |
 * | --- | --- | --- |
 * | Wikipedia S&P 500 constituents (`wiki.sp500`) | `wiki-sp500.html`, 556 KB | `<table id="constituents">`, 503 body rows, cells whose text lives inside `<a>` elements, and attribute values containing quotes and braces (`data-mw='{"parts":[…]}'`) |
 * | FRED release calendar and catalogue (`fred.calendar`) | `fred-cal`, `fred-releases.html` | `<meta name="description" content="34 economic release dates.">` as the row-count invariant, and `<a href="/release?rid=502">` as the stable id (PROVIDERS §10.2) |
 * | BLS release schedule (`bls.schedule`) | `bls-schedule.html` | `<table class="release-calendar">` **nested inside** `<table id="main-content-table">`, and cells whose four facts are separated by `<br>` and `<p>` (PROVIDERS §10.6) |
 *
 * It is a scanner, not a DOM: no tree is built for the document as a whole, nothing is executed,
 * and nothing is fetched. Text is attributed to the innermost open cell of the innermost open
 * table, which is what makes the BLS page's nested tables read correctly without a parser stack
 * that understands HTML's implicit-close rules in general.
 *
 * **The QA-05 contract**, as in `providers/xml.ts`: nothing here throws. `ok: false` means the
 * input could not be treated as a document at all (not a string, or over {@link MAX_HTML_LENGTH});
 * anything else returns what was recovered, with `problems` naming every structural surprise. HTML
 * has no notion of "damaged" — a page with one unclosed `<td>` is an ordinary page — so a caller
 * that needs certainty asserts on the content (a row count, a `<title>`, a `<meta>` count), which
 * is exactly what PROVIDERS §10.2 and §10.6 require it to do.
 */

import type { NormaliseProblem } from './types.js';

/** Largest document accepted, in UTF-16 code units. The biggest real capture is 556 KB. */
export const MAX_HTML_LENGTH = 32 * 1024 * 1024;
/** Most tables, rows and cells accepted in one document. */
export const MAX_HTML_NODES = 500_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The named entities that actually occur in the captured pages, plus the rest of Latin-1 and the
 * punctuation Wikipedia uses. An unknown entity is left as written (see `decodeXmlEntities`).
 */
const HTML_NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  dagger: '†',
  Dagger: '‡',
  bull: '•',
  hellip: '…',
  permil: '‰',
  prime: '′',
  Prime: '″',
  lsaquo: '‹',
  rsaquo: '›',
  euro: '€',
  trade: '™',
  minus: '−',
  larr: '←',
  uarr: '↑',
  rarr: '→',
  darr: '↓',
  harr: '↔',
  ne: '≠',
  le: '≤',
  ge: '≥',
  infin: '∞',
  deg: '°',
  iexcl: '¡',
  cent: '¢',
  pound: '£',
  curren: '¤',
  yen: '¥',
  brvbar: '¦',
  sect: '§',
  uml: '¨',
  copy: '©',
  ordf: 'ª',
  laquo: '«',
  not: '¬',
  shy: '­',
  reg: '®',
  macr: '¯',
  plusmn: '±',
  sup2: '²',
  sup3: '³',
  acute: '´',
  micro: 'µ',
  para: '¶',
  middot: '·',
  cedil: '¸',
  sup1: '¹',
  ordm: 'º',
  raquo: '»',
  frac14: '¼',
  frac12: '½',
  frac34: '¾',
  iquest: '¿',
  Agrave: 'À',
  Aacute: 'Á',
  Acirc: 'Â',
  Atilde: 'Ã',
  Auml: 'Ä',
  Aring: 'Å',
  AElig: 'Æ',
  Ccedil: 'Ç',
  Egrave: 'È',
  Eacute: 'É',
  Ecirc: 'Ê',
  Euml: 'Ë',
  Igrave: 'Ì',
  Iacute: 'Í',
  Icirc: 'Î',
  Iuml: 'Ï',
  ETH: 'Ð',
  Ntilde: 'Ñ',
  Ograve: 'Ò',
  Oacute: 'Ó',
  Ocirc: 'Ô',
  Otilde: 'Õ',
  Ouml: 'Ö',
  times: '×',
  Oslash: 'Ø',
  Ugrave: 'Ù',
  Uacute: 'Ú',
  Ucirc: 'Û',
  Uuml: 'Ü',
  Yacute: 'Ý',
  THORN: 'Þ',
  szlig: 'ß',
  agrave: 'à',
  aacute: 'á',
  acirc: 'â',
  atilde: 'ã',
  auml: 'ä',
  aring: 'å',
  aelig: 'æ',
  ccedil: 'ç',
  egrave: 'è',
  eacute: 'é',
  ecirc: 'ê',
  euml: 'ë',
  igrave: 'ì',
  iacute: 'í',
  icirc: 'î',
  iuml: 'ï',
  eth: 'ð',
  ntilde: 'ñ',
  ograve: 'ò',
  oacute: 'ó',
  ocirc: 'ô',
  otilde: 'õ',
  ouml: 'ö',
  divide: '÷',
  oslash: 'ø',
  ugrave: 'ù',
  uacute: 'ú',
  ucirc: 'û',
  uuml: 'ü',
  yacute: 'ý',
  thorn: 'þ',
  yuml: 'ÿ',
};

const ENTITY_PATTERN = /&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g;

/** Decode HTML character references. Unknown entities are left exactly as written. */
export function decodeHtmlEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(ENTITY_PATTERN, (match, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88;
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    return HTML_NAMED_ENTITIES[body] ?? match;
  });
}

/**
 * Collapse every run of whitespace — including the no-break space a wiki table is full of — into
 * one ordinary space, and trim. The normalisation every text comparison in a parse rule assumes.
 */
export function normaliseSpace(text: string): string {
  return text.replace(/[\s\u00a0\u200b]+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tokeniser
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface HtmlTag {
  /** Lower-cased tag name. */
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly selfClosing: boolean;
  /** Index of the `<`. */
  readonly start: number;
  /** Index just past the `>`. */
  readonly end: number;
}

export interface HtmlHandlers {
  onOpen?(tag: HtmlTag): void;
  onClose?(name: string, start: number, end: number): void;
  /** Raw source text, not yet entity-decoded. */
  onText?(text: string, start: number, end: number): void;
  onProblem?(problem: NormaliseProblem): void;
}

/** Elements with no end tag; an explicit `</br>` is ignored. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'basefont',
  'br',
  'col',
  'embed',
  'frame',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** Elements whose content is raw text, not markup. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'title']);

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

function isTagNameChar(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2d || // -
    code === 0x5f || // _
    code === 0x3a // :
  );
}

function isAttrNameChar(code: number): boolean {
  return !(
    isSpace(code) ||
    code === 0x3d || // =
    code === 0x3e || // >
    code === 0x2f || // /
    code === 0x22 || // "
    code === 0x27 || // '
    code === 0x3c // <
  );
}

/**
 * Walk `source`, calling the handlers. The whole of this module is built on it, and an adapter
 * that needs something other than a table can use it directly.
 *
 * Deliberately permissive: an unquoted attribute value, a valueless attribute, a stray `<`, a
 * `</p>` with no `<p>` and a truncated final tag are all ordinary here. The one thing it will not
 * do is loop: every branch advances the cursor.
 */
export function scanHtml(source: string, handlers: HtmlHandlers): void {
  const n = source.length;
  let i = 0;
  // Lower-cased copy of the whole document, built at most once per scan. Computing it inside the
  // raw-text branch below made the scan O(k*n) in the number of raw-text elements — and every RSS
  // or Atom feed is exactly that shape, one <title> per item.
  let lowerCache: string | null = null;

  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      handlers.onText?.(source.slice(i), i, n);
      return;
    }
    if (lt > i) handlers.onText?.(source.slice(i, lt), i, lt);

    // <!-- … -->, <![CDATA[ … ]]>, <!DOCTYPE …>
    if (source.charCodeAt(lt + 1) === 0x21 /* ! */) {
      if (source.startsWith('<!--', lt)) {
        const end = source.indexOf('-->', lt + 4);
        if (end < 0) {
          handlers.onProblem?.({
            kind: 'parse_error',
            detail: 'unterminated comment',
            path: `@${String(lt)}`,
          });
          return;
        }
        i = end + 3;
        continue;
      }
      if (source.startsWith('<![CDATA[', lt)) {
        const end = source.indexOf(']]>', lt + 9);
        if (end < 0) {
          handlers.onProblem?.({
            kind: 'parse_error',
            detail: 'unterminated CDATA',
            path: `@${String(lt)}`,
          });
          return;
        }
        handlers.onText?.(source.slice(lt + 9, end), lt + 9, end);
        i = end + 3;
        continue;
      }
      const end = source.indexOf('>', lt + 2);
      if (end < 0) {
        handlers.onProblem?.({
          kind: 'parse_error',
          detail: 'unterminated declaration',
          path: `@${String(lt)}`,
        });
        return;
      }
      i = end + 1;
      continue;
    }

    // <? … > (a processing instruction; HTML treats it as a bogus comment)
    if (source.charCodeAt(lt + 1) === 0x3f /* ? */) {
      const end = source.indexOf('>', lt + 2);
      if (end < 0) return;
      i = end + 1;
      continue;
    }

    // </name>
    if (source.charCodeAt(lt + 1) === 0x2f /* / */) {
      let j = lt + 2;
      while (j < n && isTagNameChar(source.charCodeAt(j))) j += 1;
      const name = source.slice(lt + 2, j).toLowerCase();
      const end = source.indexOf('>', j);
      if (end < 0) {
        handlers.onProblem?.({
          kind: 'parse_error',
          detail: `unterminated end tag </${name}`,
          path: `@${String(lt)}`,
        });
        return;
      }
      if (name !== '') handlers.onClose?.(name, lt, end + 1);
      i = end + 1;
      continue;
    }

    if (!isTagNameChar(source.charCodeAt(lt + 1))) {
      // A bare '<' in text.
      handlers.onText?.('<', lt, lt + 1);
      i = lt + 1;
      continue;
    }

    let j = lt + 1;
    while (j < n && isTagNameChar(source.charCodeAt(j))) j += 1;
    const name = source.slice(lt + 1, j).toLowerCase();

    const attrs: Record<string, string> = {};
    let selfClosing = false;
    let closed = false;

    while (j < n) {
      while (j < n && isSpace(source.charCodeAt(j))) j += 1;
      if (j >= n) break;
      const code = source.charCodeAt(j);
      if (code === 0x3e /* > */) {
        closed = true;
        j += 1;
        break;
      }
      if (code === 0x2f /* / */) {
        selfClosing = true;
        j += 1;
        continue;
      }
      const attrStart = j;
      while (j < n && isAttrNameChar(source.charCodeAt(j))) j += 1;
      if (j === attrStart) {
        j += 1; // not a name character and not a terminator — skip rather than spin
        continue;
      }
      const attrName = source.slice(attrStart, j).toLowerCase();
      while (j < n && isSpace(source.charCodeAt(j))) j += 1;
      let value = '';
      if (j < n && source.charCodeAt(j) === 0x3d /* = */) {
        j += 1;
        while (j < n && isSpace(source.charCodeAt(j))) j += 1;
        const quote = j < n ? source.charCodeAt(j) : -1;
        if (quote === 0x22 || quote === 0x27) {
          // Quoted: `>` inside the value does NOT end the tag. `data-mw='{"a":">"}'` depends on it.
          const end = source.indexOf(quote === 0x22 ? '"' : "'", j + 1);
          if (end < 0) {
            handlers.onProblem?.({
              kind: 'parse_error',
              detail: `unterminated attribute value for ${attrName}`,
              path: `@${String(lt)}`,
            });
            return;
          }
          value = decodeHtmlEntities(source.slice(j + 1, end));
          j = end + 1;
        } else {
          const start = j;
          while (j < n && !isSpace(source.charCodeAt(j)) && source.charCodeAt(j) !== 0x3e) j += 1;
          value = decodeHtmlEntities(source.slice(start, j));
        }
      } else {
        value = attrName;
      }
      if (!Object.hasOwn(attrs, attrName)) attrs[attrName] = value;
    }

    if (!closed) {
      handlers.onProblem?.({
        kind: 'parse_error',
        detail: `unterminated start tag <${name}`,
        path: `@${String(lt)}`,
      });
      return;
    }

    const isVoid = selfClosing || VOID_ELEMENTS.has(name);
    handlers.onOpen?.({ name, attrs, selfClosing: isVoid, start: lt, end: j });
    i = j;

    if (!isVoid && RAW_TEXT_ELEMENTS.has(name)) {
      // Raw text: everything up to the matching end tag is character data, markup or not.
      lowerCache ??= source.toLowerCase();
      const closeAt = lowerCache.indexOf(`</${name}`, i);
      if (closeAt < 0) {
        handlers.onText?.(source.slice(i), i, n);
        return;
      }
      handlers.onText?.(source.slice(i, closeAt), i, closeAt);
      const end = source.indexOf('>', closeAt);
      if (end < 0) return;
      handlers.onClose?.(name, closeAt, end + 1);
      i = end + 1;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Document-level helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Remove every tag, decode entities and collapse whitespace. */
export function stripTags(fragment: string): string {
  let out = '';
  scanHtml(fragment, {
    onText: (text) => {
      out += text;
    },
    onOpen: (tag) => {
      if (BREAKING_TAGS.has(tag.name)) out += '\n';
    },
    onClose: (name) => {
      if (BREAKING_TAGS.has(name)) out += '\n';
    },
  });
  return normaliseSpace(decodeHtmlEntities(out));
}

/** The document `<title>`, whitespace-collapsed — the BLS structural assertion (§10.6). */
export function documentTitle(source: string): string | null {
  let inTitle = false;
  let text: string | null = null;
  scanHtml(source, {
    onOpen: (tag) => {
      if (tag.name === 'title' && text === null) inTitle = true;
    },
    onText: (raw) => {
      if (inTitle) text = (text ?? '') + raw;
    },
    onClose: (name) => {
      if (name === 'title') inTitle = false;
    },
  });
  return text === null ? null : normaliseSpace(decodeHtmlEntities(text));
}

/**
 * `<meta name="description" content="34 economic release dates.">` → the `content` value.
 * The FRED calendar's whole defence against silent HTML drift is this one string (§10.2).
 */
export function metaContent(source: string, name: string): string | null {
  const wanted = name.toLowerCase();
  let found: string | null = null;
  scanHtml(source, {
    onOpen: (tag) => {
      if (found !== null || tag.name !== 'meta') return;
      const key = tag.attrs.name ?? tag.attrs.property ?? tag.attrs['http-equiv'];
      if (key?.toLowerCase() === wanted) found = tag.attrs.content ?? '';
    },
  });
  return found;
}

/** One `<a href>` with its visible text. */
export interface HtmlLink {
  readonly href: string;
  readonly text: string;
}

/** Every anchor in the document, in document order. */
export function anchors(source: string): HtmlLink[] {
  const out: HtmlLink[] = [];
  let href: string | null = null;
  let text = '';
  scanHtml(source, {
    onOpen: (tag) => {
      if (tag.name !== 'a') return;
      if (href !== null) out.push({ href, text: normaliseSpace(decodeHtmlEntities(text)) });
      href = tag.attrs.href ?? '';
      text = '';
    },
    onText: (raw) => {
      if (href !== null) text += raw;
    },
    onClose: (name) => {
      if (name !== 'a' || href === null) return;
      out.push({ href, text: normaliseSpace(decodeHtmlEntities(text)) });
      href = null;
      text = '';
    },
  });
  if (href !== null) out.push({ href, text: normaliseSpace(decodeHtmlEntities(text)) });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Tags that end a line of text inside a cell. `<br>` is the one the BLS calendar relies on. */
const BREAKING_TAGS: ReadonlySet<string> = new Set([
  'br',
  'p',
  'div',
  'li',
  'tr',
  'ul',
  'ol',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'section',
  'article',
  'header',
  'footer',
  'blockquote',
  'pre',
  'table',
]);

export interface HtmlCell {
  /** `'td'` or `'th'`. */
  readonly tag: 'td' | 'th';
  readonly attrs: Readonly<Record<string, string>>;
  /** Visible text, entity-decoded, whitespace-collapsed, lines joined by a single space. */
  readonly text: string;
  /**
   * The same text split at `<br>` and block boundaries, each line trimmed, empties dropped. A BLS
   * calendar cell is `['11', 'Consumer Price Index', 'August 2026', '08:30 AM', …]`.
   */
  readonly lines: readonly string[];
  /** Anchors inside the cell — `rid` for FRED, the ticker link for Wikipedia. */
  readonly links: readonly HtmlLink[];
  /** The cell's inner HTML, exactly as written. */
  readonly html: string;
  readonly colspan: number;
  readonly rowspan: number;
}

export interface HtmlRow {
  /** `'thead' | 'tbody' | 'tfoot' | ''` — the section the row was written in, not inferred. */
  readonly section: string;
  readonly cells: readonly HtmlCell[];
  /** True when every cell is a `<th>` and there is at least one. */
  readonly isHeader: boolean;
}

export interface HtmlTable {
  /** Position among the document's tables, in order of their opening tag. */
  readonly index: number;
  /** 0 for a top-level table, 1 for one nested inside a cell of a top-level table. */
  readonly depth: number;
  readonly attrs: Readonly<Record<string, string>>;
  /** `attrs.id`, or `''`. */
  readonly id: string;
  /** `attrs.class` split on whitespace. */
  readonly classes: readonly string[];
  readonly rows: readonly HtmlRow[];
}

export interface HtmlOk {
  readonly ok: true;
  readonly tables: readonly HtmlTable[];
  readonly problems: readonly NormaliseProblem[];
}

export interface HtmlFailure {
  readonly ok: false;
  readonly problem: NormaliseProblem;
  readonly problems: readonly NormaliseProblem[];
}

export type HtmlResult = HtmlOk | HtmlFailure;

interface OpenCell {
  tag: 'td' | 'th';
  attrs: Record<string, string>;
  text: string;
  contentStart: number;
  contentEnd: number;
  links: HtmlLink[];
  linkHref: string | null;
  linkTextAt: number;
}

interface OpenRow {
  section: string;
  cells: HtmlCell[];
}

interface OpenTable {
  index: number;
  depth: number;
  attrs: Record<string, string>;
  rows: HtmlRow[];
  section: string;
  row: OpenRow | null;
  cell: OpenCell | null;
}

function toPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 10_000 ? parsed : fallback;
}

function finishCell(open: OpenTable, source: string, at: number): void {
  const cell = open.cell;
  if (cell === null) return;
  open.cell = null;
  if (cell.linkHref !== null) {
    cell.links.push({
      href: cell.linkHref,
      text: normaliseSpace(decodeHtmlEntities(cell.text.slice(cell.linkTextAt))),
    });
    cell.linkHref = null;
  }
  const decoded = decodeHtmlEntities(cell.text);
  const lines = decoded
    .split('\n')
    .map((line) => normaliseSpace(line))
    .filter((line) => line !== '');
  const end = at > cell.contentStart ? at : cell.contentStart;
  const row = open.row;
  const finished: HtmlCell = {
    tag: cell.tag,
    attrs: cell.attrs,
    text: lines.join(' '),
    lines,
    links: cell.links,
    html: source.slice(cell.contentStart, end),
    colspan: toPositiveInt(cell.attrs.colspan, 1),
    rowspan: toPositiveInt(cell.attrs.rowspan, 1),
  };
  if (row !== null) row.cells.push(finished);
}

function finishRow(open: OpenTable, source: string, at: number): void {
  finishCell(open, source, at);
  const row = open.row;
  if (row === null) return;
  open.row = null;
  open.rows.push({
    section: row.section,
    cells: row.cells,
    isHeader: row.cells.length > 0 && row.cells.every((c) => c.tag === 'th'),
  });
}

/**
 * Every `<table>` in the document, in the order their opening tags appear, each with its own rows
 * — a nested table's rows belong to the nested table, never to the cell that contains it.
 */
export function extractTables(source: string): HtmlResult {
  if (typeof source !== 'string') {
    const problem: NormaliseProblem = {
      kind: 'parse_error',
      detail: 'extractTables: source is not a string',
    };
    return { ok: false, problem, problems: [problem] };
  }
  if (source.length > MAX_HTML_LENGTH) {
    const problem: NormaliseProblem = {
      kind: 'parse_error',
      detail: `extractTables: document is ${String(source.length)} chars, over the ${String(MAX_HTML_LENGTH)} limit`,
    };
    return { ok: false, problem, problems: [problem] };
  }

  const problems: NormaliseProblem[] = [];
  const note = (detail: string, offset: number): void => {
    if (problems.length < 64)
      problems.push({ kind: 'parse_error', detail, path: `@${String(offset)}` });
  };

  const stack: OpenTable[] = [];
  const finished: { index: number; table: HtmlTable }[] = [];
  let nodes = 0;
  let opened = 0;
  let overflow = false;

  const top = (): OpenTable | null => stack[stack.length - 1] ?? null;

  const closeTable = (at: number): void => {
    const open = stack.pop();
    if (open === undefined) return;
    finishRow(open, source, at);
    finished.push({
      index: open.index,
      table: {
        index: open.index,
        depth: open.depth,
        attrs: open.attrs,
        id: open.attrs.id ?? '',
        classes: (open.attrs.class ?? '').split(/\s+/).filter((c) => c !== ''),
        rows: open.rows,
      },
    });
  };

  scanHtml(source, {
    onProblem: (problem) => {
      if (problems.length < 64) problems.push(problem);
    },
    onOpen: (tag) => {
      if (overflow) return;
      const current = top();

      if (tag.name === 'table') {
        nodes += 1;
        if (nodes > MAX_HTML_NODES) {
          overflow = true;
          return;
        }
        if (stack.length >= 32) {
          note('tables nested more than 32 deep; ignoring', tag.start);
          return;
        }
        stack.push({
          index: opened++,
          depth: stack.length,
          attrs: tag.attrs,
          rows: [],
          section: '',
          row: null,
          cell: null,
        });
        return;
      }
      if (current === null) return;

      switch (tag.name) {
        case 'thead':
        case 'tbody':
        case 'tfoot':
          finishRow(current, source, tag.start);
          current.section = tag.name;
          return;
        case 'tr':
          nodes += 1;
          if (nodes > MAX_HTML_NODES) {
            overflow = true;
            return;
          }
          finishRow(current, source, tag.start);
          current.row = { section: current.section, cells: [] };
          return;
        case 'td':
        case 'th': {
          nodes += 1;
          if (nodes > MAX_HTML_NODES) {
            overflow = true;
            return;
          }
          finishCell(current, source, tag.start);
          if (current.row === null) {
            // A cell outside any <tr>: HTML's implied row. Open one rather than lose the cell.
            note(`<${tag.name}> outside a <tr>`, tag.start);
            current.row = { section: current.section, cells: [] };
          }
          current.cell = {
            tag: tag.name,
            attrs: tag.attrs,
            text: '',
            contentStart: tag.end,
            contentEnd: tag.end,
            links: [],
            linkHref: null,
            linkTextAt: 0,
          };
          return;
        }
        case 'a': {
          const cell = current.cell;
          if (cell === null) return;
          if (cell.linkHref !== null) {
            cell.links.push({
              href: cell.linkHref,
              text: normaliseSpace(decodeHtmlEntities(cell.text.slice(cell.linkTextAt))),
            });
          }
          cell.linkHref = tag.attrs.href ?? '';
          cell.linkTextAt = cell.text.length;
          return;
        }
        default:
          if (BREAKING_TAGS.has(tag.name) && current.cell !== null) current.cell.text += '\n';
          return;
      }
    },
    onText: (text) => {
      if (overflow) return;
      const cell = top()?.cell;
      if (cell !== null && cell !== undefined) cell.text += text;
    },
    onClose: (name, start, end) => {
      if (overflow) return;
      const current = top();
      if (current === null) return;
      switch (name) {
        case 'table':
          closeTable(start);
          return;
        case 'tr':
          finishRow(current, source, start);
          return;
        case 'td':
        case 'th':
          finishCell(current, source, start);
          return;
        case 'thead':
        case 'tbody':
        case 'tfoot':
          finishRow(current, source, start);
          current.section = '';
          return;
        case 'a': {
          const cell = current.cell;
          if (cell?.linkHref == null) return;
          cell.links.push({
            href: cell.linkHref,
            text: normaliseSpace(decodeHtmlEntities(cell.text.slice(cell.linkTextAt))),
          });
          cell.linkHref = null;
          return;
        }
        default:
          if (BREAKING_TAGS.has(name) && current.cell !== null) current.cell.text += '\n';
          void end;
          return;
      }
    },
  });

  if (overflow)
    note(`document has more than ${String(MAX_HTML_NODES)} table nodes; truncated`, source.length);
  while (stack.length > 0) {
    const open = top();
    note(`<table> #${String(open?.index ?? -1)} was never closed`, source.length);
    closeTable(source.length);
  }

  finished.sort((a, b) => a.index - b.index);
  return { ok: true, tables: finished.map((f) => f.table), problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Table lookup — by id, by class, by header text. Never by position.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The table whose `id` attribute equals `id`, or `null`. */
export function tableById(tables: readonly HtmlTable[], id: string): HtmlTable | null {
  return tables.find((t) => t.id === id) ?? null;
}

/** The first table carrying `className`, or `null`. */
export function tableByClass(tables: readonly HtmlTable[], className: string): HtmlTable | null {
  return tables.find((t) => t.classes.includes(className)) ?? null;
}

/**
 * The first table whose header row contains every one of `headers` (case- and space-insensitive).
 * Binding a table by the text of its header is the rule that survives a publisher adding a column.
 */
export function tableByHeaders(
  tables: readonly HtmlTable[],
  headers: readonly string[],
): HtmlTable | null {
  const wanted = headers.map((h) => normaliseSpace(h).toLowerCase());
  for (const table of tables) {
    const index = headerIndex(table);
    if (index === null) continue;
    if (wanted.every((h) => index.has(h))) return table;
  }
  return null;
}

/** The table's header row: the first row that is all `<th>`, else the first row containing one. */
export function headerRow(table: HtmlTable): HtmlRow | null {
  return (
    table.rows.find((r) => r.isHeader) ??
    table.rows.find((r) => r.cells.some((c) => c.tag === 'th')) ??
    null
  );
}

/**
 * `header text (lower-cased) → column index`, honouring `colspan`. `null` when the table has no
 * header row. This is the map every "columns are found by header text, never by position" rule in
 * PROVIDERS.md is written against.
 */
export function headerIndex(table: HtmlTable): Map<string, number> | null {
  const row = headerRow(table);
  if (row === null) return null;
  const map = new Map<string, number>();
  let column = 0;
  for (const cell of row.cells) {
    const key = cell.text.toLowerCase();
    if (key !== '' && !map.has(key)) map.set(key, column);
    column += cell.colspan;
  }
  return map;
}

/** Every row that is not the header row. */
export function bodyRows(table: HtmlTable): readonly HtmlRow[] {
  const header = headerRow(table);
  return header === null ? table.rows : table.rows.filter((r) => r !== header);
}

/** Cell text at `column`, or `''`. `colspan` is not expanded — a spanning cell occupies its first column. */
export function cellText(row: HtmlRow, column: number): string {
  return row.cells[column]?.text ?? '';
}

/** Each body row as `{header: text}`, using {@link headerIndex}. Missing cells become `''`. */
export function rowRecords(table: HtmlTable): Record<string, string>[] {
  const index = headerIndex(table);
  if (index === null) return [];
  const out: Record<string, string>[] = [];
  for (const row of bodyRows(table)) {
    const record: Record<string, string> = {};
    for (const [name, column] of index) record[name] = cellText(row, column);
    out.push(record);
  }
  return out;
}
