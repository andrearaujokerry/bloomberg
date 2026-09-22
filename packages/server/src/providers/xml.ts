/**
 * A dependency-free, namespace-aware XML reader — PROVIDERS.b §16.5 (§18.5), WORKPLAN WP-05.
 *
 * One of the four shared parsers. It is adequate for every XML document this system reads:
 *
 * | Document | What it needs from here |
 * | --- | --- |
 * | `sec-nport-SPY-primary_doc.xml` (444 KB, 504 `<invstOrSec>`) | a default namespace (`http://www.sec.gov/edgar/nport`), attribute-carried values (`<isin value="…"/>`), deep paths |
 * | `treasury-xml2`, `treasury-bills.xml` | Atom with two *prefixed* namespaces (`d:`, `m:`) — the OData properties are `d:BC_10YEAR`, and only the prefix distinguishes them from Atom's own elements |
 * | `sec-8k-atom.xml` | Atom in a default namespace, `ISO-8859-1` declared in the XML declaration |
 * | `fed-press-rss.xml`, `bbg-rss-*` | RSS 2.0, no namespace on the payload elements, `<![CDATA[…]]>` bodies, a UTF-8 BOM, `dc:`/`content:`/`media:` extensions |
 * | `xl/worksheets/sheet1.xml`, `xl/sharedStrings.xml` | the SpreadsheetML parts read by `providers/ssga/xlsx.ts` |
 *
 * **Purity and the QA-05 contract.** Nothing here reads the clock, the environment, the network or
 * the filesystem, and **nothing here throws**. Truncated, reordered and corrupted input is the
 * normal case for a fuzz target, so damage is reported, not raised:
 *
 * - `ok: false` means nothing usable was recovered (no root element at all);
 * - `ok: true` with a non-empty `problems` means a tree was recovered from a damaged document —
 *   an unclosed tag, an unmatched end tag, a second root. A caller that requires a clean parse
 *   uses {@link parseXmlStrict}, which turns any `parse_error` problem into `ok: false`.
 *
 * Problems carry the shared {@link NormaliseProblem} shape, so a `parse.ts` can forward them into
 * `Normalised.problems` unchanged (PROVIDERS.a §1.2).
 */

import type { NormaliseProblem } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Limits — a fuzz target needs a bound on every loop
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Largest document accepted, in UTF-16 code units. The biggest real capture is 444 KB. */
export const MAX_XML_LENGTH = 64 * 1024 * 1024;
/** Deepest element nesting accepted. N-PORT is 7 deep; 512 is far past any real document. */
export const MAX_XML_DEPTH = 512;
/** Most elements accepted in one document. The N-PORT filing has ~11 000. */
export const MAX_XML_ELEMENTS = 2_000_000;

/** The XML namespace of the `xml:` prefix, bound implicitly in every document (XML Names §3). */
export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
/** The namespace of the `xmlns:` prefix itself. */
export const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The tree
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One attribute, with its namespace resolved. Unprefixed attributes have no namespace (`''`). */
export interface XmlAttribute {
  /** The qualified name exactly as written, e.g. `m:type`. */
  readonly name: string;
  /** `'m'`, or `''` when unprefixed. */
  readonly prefix: string;
  /** `'type'`. */
  readonly local: string;
  /** Resolved namespace URI, `''` when the attribute is unprefixed or the prefix is unbound. */
  readonly uri: string;
  /** Entity-decoded value. */
  readonly value: string;
}

/** One element. Immutable once {@link parseXml} returns. */
export interface XmlElement {
  /** The qualified name as written: `d:BC_10YEAR`. */
  readonly name: string;
  /** `'d'`, or `''`. */
  readonly prefix: string;
  /** `'BC_10YEAR'` — what every lookup helper here matches on. */
  readonly local: string;
  /** Resolved namespace URI, `''` when the element is in no namespace. */
  readonly uri: string;
  /** Attributes by qualified name, in document order of first appearance. */
  readonly attrs: Readonly<Record<string, string>>;
  /** The same attributes with prefixes and namespaces resolved. */
  readonly attrList: readonly XmlAttribute[];
  readonly children: readonly XmlElement[];
  /**
   * The element's own character data (text nodes and CDATA directly inside it), concatenated in
   * document order and entity-decoded. Text inside a child element belongs to that child.
   */
  readonly text: string;
  /** Index into the source string of this element's `<`. Useful when reporting a problem. */
  readonly offset: number;
  /**
   * Where this element sat in its parent's {@link text} — the number of characters of the parent's
   * own character data that preceded it. It is what lets {@link deepTextOf} put mixed content back
   * in document order (`hi <b>there</b> you`) without keeping a node list per element.
   */
  readonly textIndex: number;
}

export interface XmlOk {
  readonly ok: true;
  readonly root: XmlElement;
  /** Empty when the document parsed cleanly. */
  readonly problems: readonly NormaliseProblem[];
  /** Number of elements in the tree. */
  readonly elementCount: number;
}

export interface XmlFailure {
  readonly ok: false;
  /** Why nothing could be read. Also present as the first entry of `problems`. */
  readonly problem: NormaliseProblem;
  readonly problems: readonly NormaliseProblem[];
}

export type XmlResult = XmlOk | XmlFailure;

function failure(detail: string, path?: string): XmlFailure {
  const problem: NormaliseProblem =
    path === undefined ? { kind: 'parse_error', detail } : { kind: 'parse_error', detail, path };
  return { ok: false, problem, problems: [problem] };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────────────────────────────────────────────────

const XML_NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const ENTITY_PATTERN = /&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z_][\w.-]*);/g;

/**
 * Decode the five XML predefined entities and numeric character references.
 *
 * An unknown entity (`&nbsp;` in a document that never declared it) is left exactly as written
 * rather than dropped: a normaliser comparing against a golden file must see a stable string, and
 * silently deleting five characters is how a CUSIP becomes wrong.
 */
export function decodeXmlEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(ENTITY_PATTERN, (match, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88; /* x | X */
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
      // Surrogate halves are not characters; leaving the reference intact is the safe answer.
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    return XML_NAMED_ENTITIES[body] ?? match;
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Bytes → string
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Encodings this reader decodes without an external dependency. */
const SUPPORTED_ENCODINGS: Readonly<Record<string, BufferEncoding>> = {
  'utf-8': 'utf8',
  utf8: 'utf8',
  'us-ascii': 'latin1',
  ascii: 'latin1',
  'iso-8859-1': 'latin1',
  'iso8859-1': 'latin1',
  latin1: 'latin1',
  'windows-1252': 'latin1',
  cp1252: 'latin1',
  'utf-16': 'utf16le',
  'utf-16le': 'utf16le',
};

/**
 * Decode a recorded body into a string, honouring the byte-order mark and then the XML
 * declaration's `encoding=` (`sec-8k-atom.xml` declares `ISO-8859-1`; `fed-press-rss.xml` carries
 * a UTF-8 BOM). An unrecognised encoding falls back to UTF-8 and is reported by the caller-visible
 * `encoding` field rather than guessed at silently.
 *
 * `windows-1252` is decoded as `latin1`, which differs only in the 0x80-0x9F range; Node has no
 * built-in cp1252 decoder and adding a table for it is not worth it until a capture needs one.
 */
export function decodeXmlBuffer(buffer: Buffer): { text: string; encoding: string } {
  if (buffer.length >= 2) {
    const b0 = buffer[0];
    const b1 = buffer[1];
    if (b0 === 0xff && b1 === 0xfe)
      return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
    if (b0 === 0xfe && b1 === 0xff) {
      // Big-endian: swap in a copy, then decode as LE. `swap16` throws on an odd length.
      const even =
        buffer.length % 2 === 0 ? buffer.subarray(2) : buffer.subarray(2, buffer.length - 1);
      return { text: Buffer.from(even).swap16().toString('utf16le'), encoding: 'utf-16be' };
    }
  }
  let start = 0;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf)
    start = 3;

  const head = buffer.subarray(start, Math.min(start + 200, buffer.length)).toString('latin1');
  const declared = /^\s*<\?xml\s[^?>]*?encoding\s*=\s*["']([\w.:-]+)["']/.exec(head)?.[1];
  const key = declared?.toLowerCase() ?? 'utf-8';
  const encoding = SUPPORTED_ENCODINGS[key] ?? 'utf8';
  return { text: buffer.subarray(start).toString(encoding), encoding: key };
}

/** {@link decodeXmlBuffer} followed by {@link parseXml}. What an adapter's `parse.ts` calls. */
export function parseXmlBuffer(buffer: Buffer): XmlResult {
  if (!Buffer.isBuffer(buffer)) return failure('parseXmlBuffer: body is not a Buffer');
  if (buffer.length === 0) return failure('parseXmlBuffer: empty body');
  return parseXml(decodeXmlBuffer(buffer).text);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The scanner
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** True for a character that may appear in an XML name (deliberately permissive). */
function isNameChar(code: number): boolean {
  return !(
    code === 0x20 || // space
    code === 0x09 || // tab
    code === 0x0a || // LF
    code === 0x0d || // CR
    code === 0x2f || // /
    code === 0x3e || // >
    code === 0x3c || // <
    code === 0x3d || // =
    code === 0x22 || // "
    code === 0x27 // '
  );
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

interface MutableElement {
  name: string;
  prefix: string;
  local: string;
  uri: string;
  attrs: Record<string, string>;
  attrList: XmlAttribute[];
  children: XmlElement[];
  text: string;
  offset: number;
  textIndex: number;
}

/** A prefix → URI scope, pushed only by an element that declares one (most declare none). */
interface NsScope {
  depth: number;
  bindings: Map<string, string>;
}

function splitName(name: string): { prefix: string; local: string } {
  const colon = name.indexOf(':');
  if (colon <= 0 || colon === name.length - 1) return { prefix: '', local: name };
  return { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
}

/**
 * Parse an XML document.
 *
 * Tolerant by contract: an unclosed element is closed at end of input, an unmatched end tag is
 * dropped, and a second root is ignored — each one recorded as a `parse_error` problem. The tree
 * that comes back is whatever the document actually supported.
 */
export function parseXml(source: string): XmlResult {
  if (typeof source !== 'string') return failure('parseXml: source is not a string');
  if (source.length === 0) return failure('parseXml: empty document');
  if (source.length > MAX_XML_LENGTH)
    return failure(
      `parseXml: document is ${String(source.length)} chars, over the ${String(MAX_XML_LENGTH)} limit`,
    );

  const problems: NormaliseProblem[] = [];
  const note = (detail: string, offset: number): void => {
    if (problems.length < 64)
      problems.push({ kind: 'parse_error', detail, path: `@${String(offset)}` });
  };

  const stack: MutableElement[] = [];
  const nsScopes: NsScope[] = [];
  let root: MutableElement | null = null;
  let elementCount = 0;
  let truncated = false;

  const n = source.length;
  let i = 0;

  const resolvePrefix = (prefix: string): string => {
    if (prefix === 'xml') return XML_NAMESPACE;
    if (prefix === 'xmlns') return XMLNS_NAMESPACE;
    for (let s = nsScopes.length - 1; s >= 0; s -= 1) {
      const uri = nsScopes[s]?.bindings.get(prefix);
      if (uri !== undefined) return uri;
    }
    return '';
  };

  const addText = (raw: string, decode: boolean): void => {
    const top = stack[stack.length - 1];
    if (top === undefined) return; // text outside the root element: whitespace, or noise
    top.text += decode ? decodeXmlEntities(raw) : raw;
  };

  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      addText(source.slice(i), true);
      break;
    }
    if (lt > i) addText(source.slice(i, lt), true);

    const c1 = source.charCodeAt(lt + 1);

    // ── <!-- comment -->, <![CDATA[…]]>, <!DOCTYPE …> ──────────────────────────────────────
    if (c1 === 0x21 /* ! */) {
      if (source.startsWith('<!--', lt)) {
        const end = source.indexOf('-->', lt + 4);
        if (end < 0) {
          note('unterminated comment', lt);
          truncated = true;
          break;
        }
        i = end + 3;
        continue;
      }
      if (source.startsWith('<![CDATA[', lt)) {
        const end = source.indexOf(']]>', lt + 9);
        if (end < 0) {
          note('unterminated CDATA section', lt);
          truncated = true;
          break;
        }
        addText(source.slice(lt + 9, end), false);
        i = end + 3;
        continue;
      }
      // <!DOCTYPE …> — skip it, tracking one level of internal subset brackets.
      let j = lt + 2;
      let bracket = 0;
      let closed = false;
      for (; j < n; j += 1) {
        const c = source.charCodeAt(j);
        if (c === 0x5b /* [ */) bracket += 1;
        else if (c === 0x5d /* ] */) bracket -= 1;
        else if (c === 0x3e /* > */ && bracket <= 0) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        note('unterminated declaration', lt);
        truncated = true;
        break;
      }
      i = j + 1;
      continue;
    }

    // ── <?xml …?> / processing instruction ─────────────────────────────────────────────────
    if (c1 === 0x3f /* ? */) {
      const end = source.indexOf('?>', lt + 2);
      if (end < 0) {
        note('unterminated processing instruction', lt);
        truncated = true;
        break;
      }
      i = end + 2;
      continue;
    }

    // ── </name> ────────────────────────────────────────────────────────────────────────────
    if (c1 === 0x2f /* / */) {
      let j = lt + 2;
      while (j < n && isNameChar(source.charCodeAt(j))) j += 1;
      const name = source.slice(lt + 2, j);
      while (j < n && isSpace(source.charCodeAt(j))) j += 1;
      if (j >= n || source.charCodeAt(j) !== 0x3e) {
        note(`unterminated end tag </${name}`, lt);
        truncated = true;
        break;
      }
      i = j + 1;

      const top = stack[stack.length - 1];
      if (top?.name === name) {
        stack.pop();
        while (nsScopes.length > 0 && (nsScopes[nsScopes.length - 1]?.depth ?? 0) > stack.length)
          nsScopes.pop();
        continue;
      }
      // Recovery: close everything down to a matching open element, if there is one.
      let match = -1;
      for (let s = stack.length - 2; s >= 0; s -= 1) {
        if (stack[s]?.name === name) {
          match = s;
          break;
        }
      }
      if (match < 0) {
        note(`end tag </${name}> matches no open element`, lt);
        continue;
      }
      for (let s = stack.length - 1; s > match; s -= 1) {
        note(`element <${stack[s]?.name ?? '?'}> was never closed`, stack[s]?.offset ?? lt);
      }
      stack.length = match;
      while (nsScopes.length > 0 && (nsScopes[nsScopes.length - 1]?.depth ?? 0) > stack.length)
        nsScopes.pop();
      continue;
    }

    // ── <name attr="v" …> or <name … /> ────────────────────────────────────────────────────
    if (!isNameChar(c1) || Number.isNaN(c1)) {
      // A bare '<' in character data. XML forbids it; RSS descriptions contain it anyway.
      addText('<', false);
      i = lt + 1;
      continue;
    }

    let j = lt + 1;
    while (j < n && isNameChar(source.charCodeAt(j))) j += 1;
    const name = source.slice(lt + 1, j);

    const attrs: Record<string, string> = {};
    const rawAttrs: { name: string; value: string }[] = [];
    let selfClosing = false;
    let tagClosed = false;

    while (j < n) {
      while (j < n && isSpace(source.charCodeAt(j))) j += 1;
      if (j >= n) break;
      const c = source.charCodeAt(j);
      if (c === 0x3e /* > */) {
        tagClosed = true;
        j += 1;
        break;
      }
      if (c === 0x2f /* / */) {
        selfClosing = true;
        j += 1;
        continue;
      }
      const attrStart = j;
      while (j < n && isNameChar(source.charCodeAt(j))) j += 1;
      if (j === attrStart) {
        // Not a name character and not a tag terminator — skip it rather than spin.
        j += 1;
        continue;
      }
      const attrName = source.slice(attrStart, j);
      while (j < n && isSpace(source.charCodeAt(j))) j += 1;
      let value = '';
      if (j < n && source.charCodeAt(j) === 0x3d /* = */) {
        j += 1;
        while (j < n && isSpace(source.charCodeAt(j))) j += 1;
        const quote = j < n ? source.charCodeAt(j) : -1;
        if (quote === 0x22 || quote === 0x27) {
          const end = source.indexOf(quote === 0x22 ? '"' : "'", j + 1);
          if (end < 0) {
            note(`unterminated attribute value for ${attrName}`, lt);
            truncated = true;
            j = n;
            break;
          }
          value = decodeXmlEntities(source.slice(j + 1, end));
          j = end + 1;
        } else {
          // Unquoted value — invalid XML, ordinary HTML. Read to whitespace or '>'.
          const start = j;
          while (j < n && !isSpace(source.charCodeAt(j)) && source.charCodeAt(j) !== 0x3e) j += 1;
          value = decodeXmlEntities(source.slice(start, j));
        }
      } else {
        // Valueless attribute — invalid XML, ordinary HTML. Its own name is the value.
        value = attrName;
      }
      if (!Object.hasOwn(attrs, attrName)) {
        attrs[attrName] = value;
        rawAttrs.push({ name: attrName, value });
      }
    }

    if (!tagClosed && !truncated) {
      note(`unterminated start tag <${name}`, lt);
      truncated = true;
      break;
    }
    if (truncated) break;
    i = j;

    elementCount += 1;
    if (elementCount > MAX_XML_ELEMENTS)
      return failure(`parseXml: over ${String(MAX_XML_ELEMENTS)} elements`);

    // Namespace declarations bind before the element's own name is resolved.
    let scope: NsScope | null = null;
    for (const attr of rawAttrs) {
      if (attr.name === 'xmlns') {
        scope ??= { depth: stack.length + 1, bindings: new Map() };
        scope.bindings.set('', attr.value);
      } else if (attr.name.startsWith('xmlns:')) {
        scope ??= { depth: stack.length + 1, bindings: new Map() };
        scope.bindings.set(attr.name.slice(6), attr.value);
      }
    }
    if (scope !== null) nsScopes.push(scope);

    const { prefix, local } = splitName(name);
    const attrList: XmlAttribute[] = rawAttrs.map((attr) => {
      const split = splitName(attr.name);
      return {
        name: attr.name,
        prefix: split.prefix,
        local: split.local,
        // An unprefixed attribute is in no namespace — the default namespace never applies to it.
        uri: split.prefix === '' ? '' : resolvePrefix(split.prefix),
        value: attr.value,
      };
    });

    const element: MutableElement = {
      name,
      prefix,
      local,
      uri: resolvePrefix(prefix),
      attrs,
      attrList,
      children: [],
      text: '',
      offset: lt,
      textIndex: stack[stack.length - 1]?.text.length ?? 0,
    };

    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      if (root === null) {
        root = element;
      } else {
        note(`second root element <${name}> ignored`, lt);
        if (scope !== null) nsScopes.pop();
        continue;
      }
    } else {
      parent.children.push(element);
    }

    if (!selfClosing) {
      if (stack.length + 1 > MAX_XML_DEPTH)
        return failure(`parseXml: nesting deeper than ${String(MAX_XML_DEPTH)}`);
      stack.push(element);
    } else if (scope !== null) {
      nsScopes.pop();
    }
  }

  if (truncated) {
    for (const open of stack)
      note(`element <${open.name}> was never closed (truncated)`, open.offset);
  } else {
    for (const open of stack) note(`element <${open.name}> was never closed`, open.offset);
  }

  if (root === null) {
    const detail = truncated
      ? 'parseXml: document is truncated and has no root element'
      : 'parseXml: no root element';
    const problem: NormaliseProblem = { kind: 'parse_error', detail };
    return { ok: false, problem, problems: [problem, ...problems] };
  }

  return { ok: true, root: root, problems, elementCount };
}

/** {@link parseXml}, but any `parse_error` problem demotes the result to `ok: false`. */
export function parseXmlStrict(source: string): XmlResult {
  const result = parseXml(source);
  if (!result.ok) return result;
  const first = result.problems.find((p) => p.kind === 'parse_error');
  if (first === undefined) return result;
  return { ok: false, problem: first, problems: result.problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Navigation — every helper matches on the LOCAL name, optionally filtered by namespace
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Direct children named `local`. When `uri` is given, only children in that namespace match;
 * when it is omitted the namespace is ignored, which is what an RSS feed needs (payload elements
 * are in no namespace while the extensions are).
 */
export function childrenNamed(
  element: XmlElement,
  local: string,
  uri?: string,
): readonly XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of element.children) {
    if (child.local === local && (uri === undefined || child.uri === uri)) out.push(child);
  }
  return out;
}

/** The first direct child named `local`, or `null`. */
export function child(element: XmlElement, local: string, uri?: string): XmlElement | null {
  for (const candidate of element.children) {
    if (candidate.local === local && (uri === undefined || candidate.uri === uri)) return candidate;
  }
  return null;
}

/**
 * Every descendant named `local`, in document order. Iterative, so a pathological document cannot
 * overflow the stack.
 */
export function descendants(element: XmlElement, local: string, uri?: string): XmlElement[] {
  const out: XmlElement[] = [];
  const queue: XmlElement[] = [element];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    if (
      current !== element &&
      current.local === local &&
      (uri === undefined || current.uri === uri)
    )
      out.push(current);
    for (let k = current.children.length - 1; k >= 0; k -= 1) {
      const next = current.children[k];
      if (next !== undefined) queue.push(next);
    }
  }
  return out;
}

/** Follow a `/`-separated path of local names from `element`. `findPath(root, 'formData/genInfo')`. */
export function findPath(element: XmlElement, path: string): XmlElement | null {
  let current: XmlElement | null = element;
  for (const step of path.split('/')) {
    if (step === '') continue;
    if (current === null) return null;
    current = child(current, step);
  }
  return current;
}

/** Every element reachable by `path`, branching at each step. */
export function findAllPath(element: XmlElement, path: string): XmlElement[] {
  let level: XmlElement[] = [element];
  for (const step of path.split('/')) {
    if (step === '') continue;
    const next: XmlElement[] = [];
    for (const node of level) next.push(...childrenNamed(node, step));
    level = next;
    if (level.length === 0) return [];
  }
  return [...level];
}

/** The element's own text, trimmed. `''` when the element is empty. */
export function textOf(element: XmlElement | null): string {
  return element === null ? '' : element.text.trim();
}

/** Text of the first child named `local`, trimmed; `''` when there is none. */
export function childText(element: XmlElement, local: string, uri?: string): string {
  return textOf(child(element, local, uri));
}

/**
 * The element's whole subtree as text, in document order, trimmed — mixed content included, so
 * `<a>hi <b>there</b> you</a>` reads `'hi there you'` and not `'hi  youthere'`.
 *
 * Recursion is bounded by {@link MAX_XML_DEPTH}, which the parser enforces.
 */
export function deepTextOf(element: XmlElement): string {
  const walk = (node: XmlElement): string => {
    let out = '';
    let cursor = 0;
    for (const kid of node.children) {
      const at =
        kid.textIndex >= cursor && kid.textIndex <= node.text.length ? kid.textIndex : cursor;
      out += node.text.slice(cursor, at);
      cursor = at;
      out += walk(kid);
    }
    return out + node.text.slice(cursor);
  };
  return walk(element).trim();
}

/**
 * An attribute by qualified name (`m:type`) or, failing that, by local name (`type`). The two-step
 * lookup is what lets a caller read `value` from `<isin value="…"/>` without knowing whether the
 * document happened to prefix it.
 */
export function attrOf(element: XmlElement, name: string): string | null {
  const direct = element.attrs[name];
  if (direct !== undefined) return direct;
  for (const attr of element.attrList) {
    if (attr.local === name) return attr.value;
  }
  return null;
}

/** A finite number from an element's text, or `null` — never `NaN`, never locale-dependent. */
export function numberOf(element: XmlElement | null): number | null {
  const text = textOf(element);
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** The count of every local element name in the document — the FIXTURES.md tag histogram. */
export function tagHistogram(root: XmlElement): Map<string, number> {
  const counts = new Map<string, number>();
  const queue: XmlElement[] = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    counts.set(current.name, (counts.get(current.name) ?? 0) + 1);
    for (const kid of current.children) queue.push(kid);
  }
  return counts;
}
