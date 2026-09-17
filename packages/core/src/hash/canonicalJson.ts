/**
 * Canonical JSON serialisation — WORKPLAN §1.6 / §18.
 *
 * The input half of ANAL-08's `inputsHash = sha256Hex(canonicalJson(inputs))`. Two structurally
 * equal inputs must produce byte-identical text in every process, so:
 *
 *  - object keys are sorted (UTF-16 code-unit order, `Array.prototype.sort`'s default);
 *  - there is no whitespace anywhere;
 *  - numbers use JavaScript's shortest round-trip form (`String(n)`), and `-0` serialises as `0`;
 *  - `undefined` object members are dropped; `undefined` array elements become `null` (JSON rules);
 *  - functions and symbols are treated exactly like `undefined`;
 *  - strings are escaped by `JSON.stringify`, which since ES2019 escapes lone surrogates, so the
 *    output is always well-formed UTF-16 and therefore stable under UTF-8 encoding.
 *
 * Values that JSON cannot represent are rejected rather than silently collapsed to `null`: a hash
 * that maps `NaN`, `Infinity` and `null` onto the same bytes would make `curve_builds`' uniqueness
 * key meaningless.
 */

function toJsonValue(v: unknown): unknown {
  if (v !== null && typeof v === 'object') {
    const maybe = (v as { toJSON?: unknown }).toJSON;
    if (typeof maybe === 'function') {
      return (maybe as (this: unknown, key?: string) => unknown).call(v);
    }
  }
  return v;
}

function encode(value: unknown, seen: Set<object>): string | undefined {
  const v = toJsonValue(value);

  if (v === null) return 'null';

  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) {
        throw new TypeError(`canonicalJson: ${String(v)} is not representable in JSON`);
      }
      return Object.is(v, -0) ? '0' : String(v);
    case 'string':
      return JSON.stringify(v);
    case 'bigint':
      throw new TypeError('canonicalJson: bigint is not representable in JSON');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }

  const obj = v;
  if (seen.has(obj)) throw new TypeError('canonicalJson: circular structure');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (const el of obj as unknown[]) parts.push(encode(el, seen) ?? 'null');
      return `[${parts.join(',')}]`;
    }
    const record = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = encode(record[key], seen);
      if (encoded === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Deterministic JSON text for `v`. A top-level `undefined`, function or symbol serialises as
 * `'null'` so the function always returns hashable text.
 */
export function canonicalJson(v: unknown): string {
  return encode(v, new Set<object>()) ?? 'null';
}
