/**
 * `ProviderRegistry` — PROVIDERS.a §1.1 L95-98, §2.6, ARCHITECTURE §7.1.
 *
 * A `Map<ProviderId, ProviderAdapter>` built once at startup. `JobContext.providers` is this
 * registry plus the read-through cache of PROVIDERS.a §2.6; nothing outside `ingest/jobs/*` and
 * that read-through may call `adapter.fetch` — function resolvers reach data only through
 * `DataServices` (FUNCTIONS §1.4).
 *
 * Registration is where three cheap invariants are enforced, because each of them is otherwise
 * discovered at 3 a.m. in a job log:
 *
 *  1. **one adapter per id.** A duplicate `register()` throws instead of replacing: two adapters
 *     for `yahoo.chart` means one of them silently stops receiving traffic, and which one depends
 *     on module load order.
 *  2. **the licence row exists.** `adapter.sourceId` must be in `licence_registry`
 *     (`providers/licences.ts`); the database enforces the same thing through
 *     `assert_source_known` on every `provenance` insert (DATA-09), but by then a job has already
 *     spent its rate-limit budget.
 *  3. **`adapter_version` is `'<family>/<semver>'`** (§1.4), because it is written verbatim to
 *     `provenance.adapter_version` and is the key by which a re-parse of history is scoped.
 */

import type { AnyProviderAdapter, ProviderAdapter, ProviderId } from './types.js';
import { isLicensedSource, PROVIDER_IDS } from './types.js';

/** `'cboe/1.0.0'` — family, slash, semver. §1.4. */
const ADAPTER_VERSION_RE = /^[a-z][a-zA-Z0-9]*\/\d+\.\d+\.\d+$/;

/** Registering a second adapter for an id already held. */
export class DuplicateProviderError extends Error {
  constructor(readonly providerId: ProviderId) {
    super(
      `provider '${providerId}' is already registered — one adapter per ProviderId ` +
        '(PROVIDERS.a §1.1); registering a second one would make traffic depend on load order',
    );
    this.name = 'DuplicateProviderError';
  }
}

/** Asking the registry for an id nothing has registered. */
export class UnknownProviderError extends Error {
  constructor(
    readonly providerId: string,
    readonly registered: readonly ProviderId[],
  ) {
    super(
      `no adapter registered for provider '${providerId}' ` +
        `(registered: ${registered.length > 0 ? registered.join(', ') : 'none'})`,
    );
    this.name = 'UnknownProviderError';
  }
}

/** Per-adapter registration flags. */
export interface ProviderRegistration {
  /**
   * PROVIDERS.a §2.6: a source whose fetch is slow (the Treasury yield-curve XML takes ≈ 18 s) is
   * scheduler-only — the interactive read-through never fetches it, it serves what the tables hold
   * and the screen shows the age.
   */
  readonly schedulerOnly?: boolean;
}

interface Entry {
  readonly adapter: AnyProviderAdapter;
  readonly registration: ProviderRegistration;
}

export class ProviderRegistry {
  readonly #entries = new Map<ProviderId, Entry>();

  /**
   * Add an adapter. Generic so a concrete `ProviderAdapter<Req, Rows>` keeps its types at the call
   * site; stored erased, because a registry of heterogeneous adapters has no other honest shape.
   *
   * @throws DuplicateProviderError when the id is already registered.
   * @throws Error when the licence row is missing or `adapterVersion` is malformed.
   */
  register<Req, Rows>(
    adapter: ProviderAdapter<Req, Rows>,
    registration: ProviderRegistration = {},
  ): this {
    if (this.#entries.has(adapter.id)) throw new DuplicateProviderError(adapter.id);

    if (!isLicensedSource(adapter.sourceId)) {
      throw new Error(
        `adapter '${adapter.id}' cites source_id '${adapter.sourceId}', which is not in the ` +
          'licence registry (packages/server/src/providers/licences.ts) — assert_source_known ' +
          'would reject every provenance row it writes (DATA-09)',
      );
    }
    if (!ADAPTER_VERSION_RE.test(adapter.adapterVersion)) {
      throw new Error(
        `adapter '${adapter.id}' has adapter_version '${adapter.adapterVersion}'; ` +
          "PROVIDERS.a §1.4 requires '<family>/<semver>', e.g. 'cboe/1.0.0'",
      );
    }

    // `AnyProviderAdapter` is `ProviderAdapter<never, unknown>`: method parameters are bivariant
    // and `Rows` appears only in a return position, so every concrete adapter is assignable to it
    // without a cast — which is the whole reason the registry does not store `any`. Reads go back
    // through `require<Req, Rows>()`, whose caller states the types it expects.
    this.#entries.set(adapter.id, { adapter, registration });
    return this;
  }

  /** The adapter, or `undefined`. */
  get(id: ProviderId): AnyProviderAdapter | undefined {
    return this.#entries.get(id)?.adapter;
  }

  /**
   * The adapter, typed as the caller expects it. The caller is the job that owns the adapter and
   * therefore knows its request and row types; a wrong claim here is a compile-time error at the
   * job's own `fetch` call, not a runtime surprise.
   *
   * @throws UnknownProviderError when nothing is registered for `id`.
   */
  require<Req = never, Rows = unknown>(id: ProviderId): ProviderAdapter<Req, Rows> {
    const entry = this.#entries.get(id);
    if (entry === undefined) throw new UnknownProviderError(id, this.ids());
    return entry.adapter as unknown as ProviderAdapter<Req, Rows>;
  }

  has(id: ProviderId): boolean {
    return this.#entries.has(id);
  }

  /** PROVIDERS.a §2.6 — `false` for an unregistered id, which cannot be read through either. */
  isSchedulerOnly(id: ProviderId): boolean {
    return this.#entries.get(id)?.registration.schedulerOnly === true;
  }

  /** Registered ids, in `PROVIDER_IDS` order so logs and `/health` output are stable. */
  ids(): ProviderId[] {
    return PROVIDER_IDS.filter((id) => this.#entries.has(id));
  }

  /** Adapters, in `PROVIDER_IDS` order. */
  all(): AnyProviderAdapter[] {
    return this.ids().map((id) => this.#entries.get(id)!.adapter);
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Ids that are declared but have no adapter yet. Startup logs this; an empty list is the goal,
   * and a non-empty one names exactly which screens will read stale tables.
   */
  missing(): ProviderId[] {
    return PROVIDER_IDS.filter((id) => !this.#entries.has(id));
  }
}

/** Build a registry from a list of adapters — the startup path (ARCHITECTURE §12.1). */
export function createProviderRegistry(
  adapters: readonly AnyProviderAdapter[] = [],
): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}
