// packages/core/src/functions/registry.ts
//
// The function catalogue, constructed the same way on every side (FUNCTIONS.md §1.7 L508-538).
// Pure and synchronous: the generated barrel builds one at module load, the server asserts its
// resolver map against it at startup, the parser asks it whether a token is a function.

import type { AnyFunctionManifest, Tier } from './manifest.js';
import type { AssetClass } from '../types/instrument.js';
import { sha256Hex } from '../hash/sha256.js';

/** Thrown by the constructor when two manifests claim the same code or alias. */
export class DuplicateFunctionCodeError extends Error {
  readonly token: string;
  readonly first: string;
  readonly second: string;

  constructor(token: string, first: string, second: string) {
    super(
      `duplicate function token '${token}': claimed by both ${first} and ${second} ` +
        `(codes and aliases share one case-insensitive namespace — FUNCTIONS.md §1.2 invariant 1)`,
    );
    this.name = 'DuplicateFunctionCodeError';
    this.token = token;
    this.first = first;
    this.second = second;
  }
}

/** Catalogue order: tier ascending, then the order the manifests were given in (FUNCTIONS.md §6). */
const catalogueOrder = (manifests: readonly AnyFunctionManifest[]): AnyFunctionManifest[] =>
  manifests
    .map((m, index) => ({ m, index }))
    .sort((a, b) => a.m.tier - b.m.tier || a.index - b.index)
    .map((entry) => entry.m);

export class FunctionRegistry {
  /** Catalogue order. */
  readonly #manifests: readonly AnyFunctionManifest[];
  /** Uppercased code or alias → manifest. */
  readonly #byToken: ReadonlyMap<string, AnyFunctionManifest>;

  /**
   * sha1 of the sorted `${code}@${payloadVersion}` list in the design; `packages/core` has no sha1
   * (and no `node:crypto`), so this is the leading 40 hex characters of the sha256 of the same
   * string — same length, same purpose: the `registryVersion` of `/status` and the `/functions` ETag.
   */
  readonly version: string;

  constructor(manifests: readonly AnyFunctionManifest[]) {
    const ordered = catalogueOrder(manifests);
    const byToken = new Map<string, AnyFunctionManifest>();

    for (const manifest of ordered) {
      for (const token of [manifest.code, ...manifest.aliases]) {
        const key = token.toUpperCase();
        const existing = byToken.get(key);
        if (existing !== undefined) {
          throw new DuplicateFunctionCodeError(key, existing.code, manifest.code);
        }
        byToken.set(key, manifest);
      }
    }

    this.#manifests = ordered;
    this.#byToken = byToken;
    this.version = sha256Hex(
      ordered
        .map((m) => `${m.code}@${m.payloadVersion}`)
        .sort()
        .join('\n'),
    ).slice(0, 40);
  }

  /** Case-insensitive; aliases resolve to their manifest (`'ib'` → MSG). */
  get(codeOrAlias: string): AnyFunctionManifest | undefined {
    return this.#byToken.get(codeOrAlias.trim().toUpperCase());
  }

  /** `'ib'` → `'MSG'`; `undefined` when the token is not a function. */
  canonical(codeOrAlias: string): string | undefined {
    return this.get(codeOrAlias)?.code;
  }

  /** Catalogue order (tier, then §6 order). */
  all(): AnyFunctionManifest[] {
    return [...this.#manifests];
  }

  byTier(t: Tier): AnyFunctionManifest[] {
    return this.#manifests.filter((m) => m.tier === t);
  }

  /**
   * Functions offered for a loaded security's asset class. `null` (no security loaded) →
   * the functions that take none (`'none'`) or take one optionally (`'any'`).
   */
  applicable(assetClass: AssetClass | null): AnyFunctionManifest[] {
    if (assetClass === null) {
      return this.#manifests.filter((m) => m.assetClasses === 'none' || m.assetClasses === 'any');
    }
    return this.#manifests.filter(
      (m) =>
        m.assetClasses === 'any' ||
        (m.assetClasses !== 'none' && m.assetClasses.includes(assetClass)),
    );
  }

  /** Exact code/alias match, case-insensitive (parser §2.3). */
  isFunctionToken(token: string): boolean {
    return this.#byToken.has(token.trim().toUpperCase());
  }

  /** Codes and aliases, catalogue order, each manifest's code before its aliases (autocomplete). */
  codes(): string[] {
    return this.#manifests.flatMap((m) => [m.code, ...m.aliases]);
  }

  /** Number of manifests in the catalogue. */
  get size(): number {
    return this.#manifests.length;
  }
}
