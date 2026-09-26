# TRACEABILITY — every requirement mapped to a status, a mechanism and a test

This is the BRIEF §7 deliverable and milestone I13 of [WORKPLAN.md](./WORKPLAN.md) §15. It maps all
**158** requirement ids in [REQUIREMENTS.md](./REQUIREMENTS.md) to exactly one status.

## How to read this

The repository currently contains the design spine and the work plan; `packages/` does not exist
yet. A status here therefore grades **the design and its assigned test**, not running code — with one
exception, added by WP-15 once there was an application to run: [Running-application
gaps](#running-application-gaps-wp-15) grades what the composed app actually does, and the three rows
it corrects (TERM-06, TERM-07, MSG-01) say so in their notes. This paragraph is what WP-15's
regeneration of this file has to replace, since fourteen packages now exist.

| Status | Means |
| --- | --- |
| **implemented** | A concrete named mechanism exists in the spine (a table, column, module, route, wire message or engine named in CONTRACTS.md) **and** a named acceptance test in WORKPLAN.md §2 or TESTING.md covers it, owned by a work package. Nothing is marked implemented on the strength of prose alone. |
| **partial** | A mechanism exists but is narrower than the requirement — usually because the reachable keyless sources (BRIEF §2) cannot supply what the requirement assumes, or because a clause of the requirement (staffing, certification, hardware) is not a software artefact. The `note` column states what exists and what the gap is. |
| **out-of-scope** | Ruled out, with the reason quoted from BRIEF §1 non-goals where BRIEF names it. Three rows (REG-02, REG-08, OPS-01) are out of scope for a reason BRIEF §1 does **not** state; those notes say so explicitly rather than pretending a quote exists. |

Five SCOPE rows and four BIZ rows are document or business decisions with no code and no executable
check; their `test` column reads `n/a (document decision)` and they are broken out separately in the
summary. Where WORKPLAN.md and TESTING.md name the same test at different paths, both are given
(see Open questions #1).

Sources checked for every row: WORKPLAN.md §2/§15/§18/§19, TESTING.md §7–§18, ARCHITECTURE.md §13,
DATA_MODEL.md, API.md, FUNCTIONS.md, CLIENT.md §11.11/§18, parts/PROVIDERS.a-b, parts/TIER1-3.

---

## SCOPE — product definition

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| SCOPE-01 | implemented | BRIEF §1: US-listed equities and ETFs, US Treasuries and money-market rates, with global equity indices, G10 FX and listed US equity options as context. Encoded as the `asset_class` enum (10 values) and the seeded universe (DATA_MODEL §18) | `packages/server/test/integration/seed/volumes.test.ts` | The wedge is enforced by what the seed may contain: ≈36 k instruments, 503×2 index memberships, 3,510 option contracts, no non-US listings. |
| SCOPE-02 | implemented | BRIEF §1: buy-side equity PM / analyst on a desk; secondary rates analyst | `packages/e2e/tests/desk-flow.spec.ts` (TESTING §14) | The persona is proved only by the journey test (login → DES → GP → HP/PRINT → W → WEI → panels → HELP); the rates analyst's path is `quote.spec.ts`/`rates.spec.ts`. |
| SCOPE-03 | implemented | BRIEF §1 non-goals list; ARCHITECTURE §13 restates each as a bypass-proof mechanism or an absence | n/a (document decision) | Nine non-goals: EXEC-*, API-04, MSG-05, mobile parity, NEWS-06, SEC-07, FEED-01/02/09/10, NFR-03, OPS-06/TERM-09-staffing, DATA-04. Every one appears below with the quote. |
| SCOPE-04 | implemented | BRIEF §1: "an open, keyboard-first terminal whose every number carries source-level provenance and is served from official primary sources" | `packages/server/test/integration/seed/idempotent.test.ts` | The claim's testable half is provenance: the test asserts every seeded value has a `provenance_id` resolving to a recorded fixture. |
| SCOPE-05 | implemented | BRIEF §1 build/buy line: "everything is built here; there is no budget for vendors"; ARCHITECTURE §13 marks the [Decision gate] closed | n/a (document decision) | Reference identifiers come from OpenFIGI, fundamentals from SEC XBRL — the two places a vendor would otherwise sit. |

## DATA — market data acquisition and licensing

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| DATA-01 | partial | `licence_registry` (33 rows; `licence_kind`, `display`, `non_display`, `derived`, `redistribution`, `export_allowed`, `api_allowed`, `max_tier`, `contract_ref`); `entitlements/evaluator.ts` rules 3–4 | `packages/server/test/integration/seed/licences.test.ts` | ARCHITECTURE §13: "Cannot be met by software." Exists: the registry shape, the ceiling rule and the declarations query, so a licensed venue plugs in unchanged. Gap: **`contract_ref` is NULL for all 33 v1 sources** — no negotiated agreement exists; display/non-display/derived/redistribution are recorded, never purchased. |
| DATA-02 | implemented | `usage_declarations` (month × source × firm × field_class × tier, `query_sql_hash`, `seat_count`, `billing_ref`); `entitlements/declarations.ts`; `ingest/jobs/usageDeclarations.ts`; `admin.ts` route | `packages/server/test/integration/entitlements/declarations.test.ts` | Declarations are a query over `access_log`, reconciled against `firms.seat_count`; the SQL text's sha256 is stored so a declaration is reproducible. |
| DATA-03 | partial | Cboe delayed quotes and full option chain (`cboe.quotes`, `cboe.options` `md_lines`), `quote_ticks`, `option_quotes` | `packages/server/test/replay/normalisers.test.ts`; `packages/server/test/integration/functions/OMON.test.ts` | Exchange-published 15-minute data from one venue family. Gap: no CTA/UTP SIP tape, no OPRA; "consolidated" in this build means two delayed providers merged by `md_lines.priority`, not a tape. |
| DATA-04 | out-of-scope | BRIEF §1 non-goals: "evaluated fixed-income pricing vendors (DATA-04 — Treasuries only)" | `packages/server/test/integration/functions/YAS.test.ts` | Not silently dropped: TIER3.d forces `pricing.basis='curve_derived_no_market_quotes'` and a `NO_BOND_PRICE_SOURCE` amber badge on every YAS payload, so no derived yield can pass as an evaluated price. |
| DATA-05 | partial | FX spot: `fx_rates`, `frankfurter` + `yahoo.chart` lines, `FXC`. Swaps: `SOFR_OIS` curve from NY Fed fixings, `SWPM` | `packages/server/test/integration/functions/FXC.test.ts`; `packages/core/test/analytics/swap/ois.test.ts` | Exists: G10 spot with crosses derived via USD, and one OIS curve. Gap: no interbank depth (`NO_FX_DEPTH_SOURCE`), no forwards (TIER2.f: "FX forwards and the swap curve are out of scope (DATA-05, BRIEF §1)"), no SDR/DTCC, no ISDA definitions, no CDS composites. |
| DATA-06 | partial | `secSubmissions`, `secCompanyFacts`, `secFrames` jobs → `filings`, `xbrl_facts`, `xbrl_frames`; standardisation through `xbrl_concept_map` (`mapping_version 'std-map/2026.09'`) → `fin_statements` | `packages/server/test/replay/fundamentals/companyfacts.test.ts`; `packages/server/test/integration/functions/FA.test.ts` | Exists: US filings ingested, XBRL standardised in-house, as-reported toggle from `fin_statements.as_reported`. Gap: SEC EDGAR only — no non-US regulator filings, no exchange disclosure portals, no standardised-fundamentals vendor. |
| DATA-07 | partial | `econ_series` / `econ_observations` (vintaged) / `econ_releases` / `econ_release_events`; jobs `fredSeries`, `blsSeries`, `worldMacro`, `econCalendar`, `fedRates`, `treasuryCurves` | `packages/server/test/replay/rates/fredSeries.test.ts`; `packages/server/test/integration/functions/ECO.test.ts` | Exists: FRED CSV, BLS v2, NY Fed, Fed H.15, World Bank, IMF, US Treasury, all with vintage detection. Gap: **no consensus source** — `econ_release_events.consensus` is always NULL with `consensus_unavailable_reason` populated (BRIEF §2); no commercial forecast panel. |
| DATA-08 | partial | `corporate_actions` (15 `ca_type` values, `ca_status` estimated→announced→confirmed→paid→cancelled, `review_state`/`reviewed_by`/`reviewed_at` dual key) | `packages/server/test/integration/functions/CACS.test.ts`; `packages/server/test/integration/refdata/corporateActions.test.ts` | Exists: the full state machine and the dual-key review column. Gap: only dividends and splits have a feed (`yahoo.chart` events, `sec.atom` 8-K); mergers, tenders, calls, conversions, rights and spinoffs have schema and no source, and the manual review desk is staffing (see REF-10, BIZ-03). |
| DATA-09 | implemented | `licence_registry` + `field_licence`; `providers/licences.ts` (the 33 `source_id` values); `entitlements/licenceRegistry.ts` with `config_versions` bump invalidation; `assert_source_known` trigger | `packages/server/test/integration/seed/licences.test.ts` | The test asserts the 33 rows and the field matrix seed, and that `assert_source_known` rejects an unknown `source_id` — no value can enter the system under an unregistered source. |
| DATA-10 | implemented | `provenance` table (`request_key`, `request_url`, `response_sha256`, `captured_at`, `source_ts`, `adapter_version`, `trace_id`, `run_id`); `providers/provenance.ts#insertProvenance`; `PayloadMeta.provenance[]`; `Ctrl+I` panel | `packages/server/test/integration/seed/idempotent.test.ts`; `packages/web/test/screen/renderer.test.tsx` | Every stored value carries a `provenance_id`; every screen cell carries an index into `meta.provenance[]`; `provenance_worm` blocks UPDATE/DELETE. |

## FEED — feed handlers and normalization

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| FEED-01 | out-of-scope | BRIEF §1: "binary exchange protocols and multicast (FEED-01/02/09/10 — replaced by HTTP feed handlers over the same normalisation model)" | — | The seventeen `providers/<name>/{adapter,parse}.ts` pairs are the HTTP replacement; the `NormalisedUpdate` boundary is identical to what an ITCH decoder would emit. |
| FEED-02 | out-of-scope | BRIEF §1, same clause | — | The no-silent-gap-fill principle survives: the plant drops `src_seq ≤ last` and counts `plant_updates_dropped_total{reason="stale_seq"}` (ARCHITECTURE L794, "FEED-02 analogue"). Nothing is invented. |
| FEED-03 | partial | `core/types/quote.ts` (`QuoteState`, `LineState`, `NormalisedUpdate`, `Timestamps3`), `core/types/instrument.ts`; adapters emit nothing else | `packages/server/test/replay/normalisers.test.ts`; `packages/core/test/quote/merge.test.ts` | ARCHITECTURE §13 [Architecturally load-bearing]. Exists: quotes, trades, summaries, session state and halts as one model; raw provider shapes live only inside `parse.ts`. Gap: the model carries **no order-book delta and no auction-imbalance message type** — no reachable source publishes either. |
| FEED-04 | partial | `quote_ticks.bid/ask/bid_size/ask_size` (top of book, Cboe delayed); `Q` composite + per-line view | `packages/server/test/integration/functions/Q.test.ts` | Gap: no full-depth book anywhere, therefore no implied orders, hidden liquidity, odd-lot or price-band handling. `oc:<instrumentId>` carries the option chain, not depth. |
| FEED-05 | partial | `Timestamps3 { src, cap, pub }`; `quote_ticks.source_ts/capture_ts/publish_ts`; `bars_daily.source_ts/capture_ts`; `provenance.source_ts/captured_at`; wire `Ts` schema | `packages/server/test/integration/functions/Q.test.ts`; `packages/server/test/replay/normalisers.test.ts` | Exists: all three timestamps preserved end to end, and the conversion rules (Cboe `last_trade_time` ET→UTC, Yahoo `meta.regularMarketTime`×1000) are part of the normaliser goldens. Gap: **no hardware time source** — capture is the Node clock. Sub-millisecond attribution is meaningless against 15-minute delayed HTTP polls, but the clause is unmet. |
| FEED-06 | partial | `core/quote/session.ts#sessionState`, `session_state` enum (`pre open auction halted closed post unknown`), `calendars` / `calendar_sessions` / `calendar_holidays` | `packages/core/test/quote/session.test.ts`; `packages/core/test/calendars/nyse.test.ts` | Exists: per-calendar, per-instrument session lifecycle including early closes and pre/post. Gap: `halted` is modelled but never set — no source publishes halts, LULD bands or circuit breakers. |
| FEED-07 | partial | `quote_ticks.conditions text[]` with documented values `'delayed'`, `'synthetic_from_poll'` | — (no named test) | DATA_MODEL calls the column a placeholder outright: no reachable provider publishes sale conditions, so last-price / VWAP / volume qualification rules cannot be applied. WORKPLAN §19.7 asks WP-06 to confirm no screen renders a condition the feed cannot supply. |
| FEED-08 | implemented | `providers/replayStore.ts` (`requestKey = sha256(providerId\|METHOD\|url-sorted-query\|sha256(body))`, `fixtures/providers/manifest.json`, replay-mode-is-a-wall); `replay/harness.ts`, `replay/diff.ts`, `replay/cli.ts`; `fixtures/sessions/*` | `packages/server/test/replay/determinism.test.ts`; `packages/server/test/replay/harness.test.ts`; `packages/server/test/replay/no-network.test.ts` | Replays recorded HTTP responses and plant sessions bit-identically; a miss throws rather than falling through to the network. Not exchange wire bytes — there is no wire protocol. |
| FEED-09 | out-of-scope | BRIEF §1, same clause as FEED-01; ARCHITECTURE L1207 restates "multi-datacentre feed redundancy (FEED-09) … out of v1 scope per BRIEF §1" | — | Single process, single region. |
| FEED-10 | out-of-scope | BRIEF §1, same clause | — | No exchange connection exists to certify; the provider replay goldens are the standing conformance check against the recorded response shapes. |

## REF — security master and reference data

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| REF-01 | implemented | `instruments.instrument_id` (immutable, bitemporal); `identifiers` keyed `(scheme, value, qualifier)` over the 14-value `id_scheme` enum; `refdata/master.ts`, `refdata/identifiers.ts`, `refdata/resolve.ts` | `packages/server/test/integration/refdata/resolve.test.ts`; `packages/server/test/integration/refdata/identifiers.test.ts`; `packages/core/test/ids/checkdigits.test.ts` | Ticker is never a key: `TICKER_EXCH` is one scheme among fourteen, qualified by exch code and time-boxed by the exclusion constraint. `RIC` and `LEI` columns exist with no keyless source to populate them. |
| REF-02 | implemented | `issuers` → `issues` → `instruments` → `listings` → `md_lines`, each bitemporal with its own id column | `packages/server/test/integration/refdata/resolve.test.ts`; `packages/server/test/integration/db/migrate.test.ts` | One issue may have many listings and one listing many market-data lines (`md_lines.line_kind` composite / venue / derived / reference). |
| REF-03 | implemented | The `-- [BT]` column block on 16 tables; `bt_as_of()`, `bt_guard_update` triggers, `*_bt_excl` EXCLUDE USING gist constraints; `db/bitemporal.ts#writeVersion/upsertVersion` | `packages/server/test/integration/db/bitemporal.test.ts` (the DATA_MODEL §1.4 worked query); `packages/server/test/integration/refdata/bitemporal-write.test.ts` | ARCHITECTURE §13 [Cannot be retrofitted]: `asOf()` is the only read predicate the `refdata/*` repositories offer and no non-bitemporal master exists. |
| REF-04 | partial | `govt_terms` carries every REF-04 field: `coupon_type`, `coupon_freq`, `day_count`, `business_day_conv`, `call_schedule`, `put_schedule`, `sink_schedule`, `amortisation`, `make_whole`, `covenants`, `guarantors`, `seniority`, `collateral` | `packages/server/test/integration/functions/YAS.test.ts`; `packages/core/test/analytics/bond/price.test.ts` | Exists: the full shape, populated for US Treasuries. Gap: the schedule columns are "empty for modern Treasuries; kept for REF-04 shape" — there is no corporate-bond T&C source, so covenants, calls and seniority are never exercised with real data. |
| REF-05 | partial | `option_terms` (OCC symbol, strike, expiry, exercise style, settlement, multiplier, tick size, last trade date) populated from `cboe.options`; `future_terms` declared | `packages/core/test/ids/occ.test.ts` (3,510 contract symbols round-trip); `packages/server/test/integration/functions/OMON.test.ts` | Gap: BRIEF §5.1 makes `future` "shape only" — `future_terms.first_notice_date`, `first_delivery_date`, `delivery_months` and `roll_convention` have no source and are never populated. |
| REF-06 | implemented | `calendars` (`XNYS XNAS XCBO SIFMA USGOVT FX_USD TARGET2 XLON WEEKEND`), `calendar_sessions`, `calendar_holidays` (≈1,300 rows from rule generators 1990-2040); `core/calendars/**`; `combine()` | `packages/core/test/calendars/nyse.test.ts` | Proves Juneteenth from 2022 only, NYSE early closes, and that `combine()` unions holidays — the combination rule every analytic uses. |
| REF-07 | partial | `classification_schemes` / `classification_codes` / `entity_classifications` (bitemporal); `indices`, `index_members` (weight, shares, market_value, `as_of_date`) from SEC N-PORT and the SPDR daily file | `packages/server/test/integration/refdata/indexMembership.test.ts` (503 members as-of two dates, adds/drops, weights ≈1); `packages/server/test/integration/functions/MEMB.test.ts` | Gap: GICS **names** come from `wiki.sp500` (cc_by_sa), not the licensed GICS scheme; ICB and NAICS have schemes and no source; membership history is two dated snapshots of one ETF, not a historical membership series. |
| REF-08 | partial | `people` ("REF-08 minimal: officers from SEC 8-K item 5.02, news authors, directory users"), `entity_relations` (8 relation kinds, "v1 populated from N-PORT: fund holds issuer; ETF tracks index"), `issuer_aliases`; `GET /issuers/:issuerId` | `packages/server/test/integration/functions/DES.test.ts` | Gap: no corporate hierarchies or subsidiaries, no board, no supply chain, no private-company records. REQUIREMENTS §SCOPE names this as the manually-curated moat, not an engineering problem. |
| REF-09 | implemented | `core/adjust/corporateActions.ts#adjustmentFactors/applyAdjustment`, policies `unadjusted \| price \| total_return`, computed on read in `data/historical.ts`; `bars_daily.src_adj_close` is reconciliation only and never served | `packages/core/test/adjust/corporateActions.test.ts` (AAPL 7:1 2014-06-09 and 4:1 2020-08-31 plus 20 dividends); `packages/server/test/integration/data/historical.test.ts`; `packages/server/test/integration/functions/HP.test.ts` | One implementation, switchable at read time; nothing is baked in on write. |
| REF-10 | partial | `data_exceptions` (`source_conflict`, `missing_field`, `parse_error`, `manual_review`, `reported_error`, `unresolved_identifier`, `ca_review`; `assignee_user_id`, `sla_due_at`, `resolution`); `corporate_actions.review_state` dual key; `users.role='dataops'`; `admin.ts` review routes | `packages/server/test/integration/refdata/corporateActions.test.ts`; `packages/server/test/integration/portfolio/import.test.ts` (unresolved identifier → `data_exceptions`) | Exists: exception queues, dual-key column, source-conflict candidates and an SLA due-date field. Gap: the staffing half cannot be built, and no data-ops screen exists in the 38-function catalogue — the queue is API-only. |

## BUS — ticker plant and real-time distribution

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| BUS-01 | implemented | `plant/tickerPlant.ts` (`Map<subject, QuoteState>`, `apply`, `snapshot`, `subscribe`, per-subject monotonic `seq`); `plant/warm.ts` warm start from `quote_snapshots` | `packages/server/test/unit/plant/tickerPlant.test.ts`; `packages/server/test/integration/ws/handshake.test.ts` | Snapshot-on-subscribe then deltas is the only subscription shape; `snapshot(subject)` equals the applied state. |
| BUS-02 | implemented | `plant/subjects.ts` grammar (`q: l: b1m: oc: c: r: e: n: alerts:me room: sys:status`) matching the `SubjectId` regex in `sdk/wire/ws.ts`; `Uint32Array` field masks in `ws/session.ts` | `packages/server/test/unit/plant/subjects.test.ts` | A client subscribing to `PX_LAST` receives only that field: `sub {subjects[], fields[]}` compiles to a mask applied at flush time. |
| BUS-03 | implemented | `ws/conflator.ts` `Conflator` — dirty-mask conflation at `CONFLATION_MS_DEFAULT`, values read at flush time and never queued | `packages/server/test/unit/plant/conflator.test.ts` (WORKPLAN) / `packages/server/test/unit/ws/conflator.test.ts` + `conflator.prop.test.ts` (TESTING) | The latest-value guarantee is the property the test pins: N updates inside one window emit one frame carrying the latest value of every changed field. |
| BUS-04 | implemented | `ws/session.ts` backpressure state machine, slow-consumer downgrade, `essential` flag; `usage_events.kind='ws.slow'`; `dq_events.kind='ws_backpressure'` | `packages/server/test/integration/ws/backpressure.test.ts`; `packages/server/test/integration/ws/overload.test.ts` | Downgrade, never a silent drop — the test asserts both the usage event and the DQ event are written. |
| BUS-05 | partial | `core/quote/merge.ts` (line priority from `md_lines.priority`, per-field last-writer-wins by `ts.src`, `srcSeq` tiebreak, provenance retained per line); `plant/composite.ts` | `packages/core/test/quote/merge.test.ts`; `packages/server/test/integration/functions/Q.test.ts` | Exists: a documented, tested composite with per-field provenance. Gap: the "venues" merged are two delayed providers (Cboe priority 10, Yahoo 20), so there is **no real NBBO and no consolidated volume across venues**. |
| BUS-06 | implemented | `plant/policyTier.ts#view(state, tier)`; `plant/eod.ts` → `eod_snapshots.fields`; `tier` enum `eod \| delayed \| realtime` with `tier_rank()` | `packages/server/test/integration/ws/entitlement.test.ts` (an eod user gets frozen values) | Delayed and EOD tiers are generated from one source by policy, which is what the requirement asks for. WORKPLAN §19.5: `realtime` is structurally unreachable in v1 because `licence_registry.max_tier` caps every source — it has no positive test case. |
| BUS-07 | implemented | `prev`-chained `delta` frames, forced resync on a gap, resubscribe-on-reconnect; `sdk/client/ws.ts` `LiveClient` applies the prev-chain rule and never silently applies a gapped delta | `packages/server/test/integration/ws/resync.test.ts`; `packages/sdk/test/client/ws.test.ts`; `packages/e2e/tests/ws-resync.spec.ts` | The e2e kills the socket mid-session and asserts every visible cell matches a fresh REST snapshot afterwards, with no value regressing. |
| BUS-08 | partial | Enforced limits: 10,000 subjects per web session, 2,000 per api session, 100 fields per subject (ARCHITECTURE L921, API L996); `quota_limits.concurrent_subscriptions` | `packages/server/test/integration/ws/limits.test.ts` | The per-session half of the requirement is met and tested. Gap: "tens of millions of active subscriptions per plant" is unreachable — one Node process, and the standing load profile is SimFeed at 200 Hz × 500 subjects (TESTING §15). |

## STOR — storage architecture

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| STOR-01 | partial | `quote_ticks` — append-only, `PARTITION BY RANGE (capture_ts)`, PK `(capture_ts, tick_id)`; `db/partitions.ts#ensurePartitions/dropExpired` | `packages/server/test/integration/ingest/partitions.test.ts` | DATA_MODEL calls it a "STOR-01 analogue" in the DDL comment. Gap: row-store Postgres 14 (no TimescaleDB, no columnar engine); the "firehose" is a 10-second poll of delayed quotes; 30-day retention from `cboe.quotes`. Petabyte scale is not attempted. |
| STOR-02 | partial | `bars_daily` / `bars_intraday` (partitioned); vintaged series: `econ_observations.vintage_at/is_latest`, `rate_fixings.vintage_at`, `curve_points.vintage_at`; `xbrl_facts.filed_at`; `fin_statements` PK includes `filed_at` | `packages/server/test/replay/rates/fredSeries.test.ts`; `packages/server/test/integration/data/fundamentals.test.ts` | Exists: point-in-time restatement history where it matters (fundamentals, econ, rates, curves). Gap: **bars themselves are not bitemporal** — a restated bar overwrites; bitemporality is per-table convention, not a store feature. |
| STOR-03 | implemented | Postgres relational master with `btree_gist` exclusion constraints, `bt_guard_update` triggers, `provenance_id` on every row, `provenance_worm` trigger, `*_now` views | `packages/server/test/integration/db/migrate.test.ts` (every table, enum, view, trigger and function in CONTRACTS §1.2/§1.3 asserted from `information_schema`/`pg_trigger`); `packages/server/test/integration/refdata/bitemporal-write.test.ts` | Strongly constrained and fully audited: the exclusion constraints make an overlapping version physically impossible, not merely discouraged. |
| STOR-04 | partial | `news_items.tsv` (STORED GENERATED `tsvector`, headline weight A, summary weight B), `pg_trgm`, `filings` | `packages/server/test/integration/news/ingest.test.ts` (tsv search returns the expected story) | Gap: **pgvector is not available** on this Postgres, so there is no vector search — DATA_MODEL L1570 and L2553 both record this as a TRACEABILITY gap. No research or transcript corpus exists either (NEWS-05, NEWS-06). |
| STOR-05 | partial | Hot = plant `Map<subject, QuoteState>` in memory; warm = `quote_snapshots`; partitions dropped by `partitionMaintenance` per `licence_registry.retention_days` | `packages/server/test/integration/ingest/partitions.test.ts` | Gap: **no cold object-storage tier**, therefore no query transparency across tiers — data past retention is dropped, not demoted. |
| STOR-06 | implemented | `data/fundamentals.ts` — ARCHITECTURE §13: "`fundamentals.facts(…, knownAt)` has no overload without `knownAt`"; `xbrl_facts.filed_at` filter inside the service; FA/EE echo `meta.asOf.knownAt`; `bt_as_of()` for reference reads | `packages/server/test/integration/data/fundamentals.test.ts`; `packages/server/test/integration/pit.fundamentals.test.ts`; `packages/server/test/integration/functions/FA.test.ts` | [Correctness]. The test inserts a restatement and proves the earlier `knownAt` still returns the originally filed value. TESTING §17.15 notes the restatement row is synthesised by the test — the recorded fixture contains no restatement. |
| STOR-07 | implemented | `licence_registry.retention_days` is the **only** retention input; `db/partitions.ts#dropExpired`; `ingest/jobs/retentionPurge.ts` | `packages/server/test/integration/ingest/partitions.test.ts` (`dropExpired` respects `retention_days`; a non-empty default partition raises `dq_events.kind='default_partition_nonempty'`) | Retention cannot be set anywhere except the licence row for the governing source. |

## ENTL — entitlements and permissioning

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| ENTL-01 | implemented | `entitlements/evaluator.ts#evaluate()` precedes every data-service call and every WS `sub`; ESLint zone forbids `db/client.ts` in resolvers; the web bundle cannot open a socket or fetch outside the SDK | `packages/server/test/unit/entitlements/evaluator.test.ts`; `packages/server/test/unit/entitlement.guard.test.ts`; `packages/web/test/no-direct-io.test.ts` | [Regulatory]. The client renders reasons only; no filtering decision is ever made there. |
| ENTL-02 | implemented | `entitlement_grants` (`subject_kind IN ('user','firm')`) intersected with `licence_registry.max_tier` as the source/venue ceiling, in the normative rule order 1–5 | `packages/server/test/integration/entitlements/evaluator.test.ts` (the five rules in order; `SOURCE_TIER_CAP` beats a generous grant) | The venue's own permissioning rules are represented by the source ceiling rather than a venue permission service — there is no venue to talk to (DATA-01). |
| ENTL-03 | implemented | `users.person_verified_at`/`verified_by`; single active session with `sessions.revoke_reason='superseded'` and `superseded_count`; `sessions.device_id`/`ip`; WS close code `4003` on a second socket | `packages/server/test/integration/auth/session.test.ts`; `packages/server/test/integration/entitlements/session.test.ts` | Concurrent-use detection is enforced, which is the clause the requirement says is "expected of you". Verification evidence is an attestation column, not a KYC flow (see SEC-01). |
| ENTL-04 | implemented | `access_log` (user, firm, session, instrument, field, field_class, source, requested/granted tier, usage, purpose, decision, reason, trace) partitioned by `ts` with `access_log_worm`; `entitlements/accessLog.ts` ring buffer flushing at 1 s or 5,000 rows, never on the request path | `packages/server/test/integration/entitlements/accessLog.test.ts` | The test also proves the WORM trigger rejects UPDATE and DELETE (REG-01). Retention floor 7 years (DATA_MODEL §19). |
| ENTL-05 | implemented | `ReasonCode` union; `FieldDecision.decision='downgrade'`; WS `notice` frame and `Status.st='blank'`; `ValueState 'blank'` renders `—` in `--c-blocked` with the reason code on focus — **never a stale higher-tier number** (CLIENT §12.1 rule, §14.2) | `packages/server/test/integration/ws/entitlement.test.ts`; `packages/server/test/integration/entitlements/denial.test.ts`; `packages/e2e/tests/entitlement.spec.ts` | The most-cited requirement in the corpus (≈220 citations across the tier files); every function payload has a defined downgrade rendering. |
| ENTL-06 | implemented | `entitlements/declarations.ts` — the monthly declaration as a query over `access_log` into `usage_declarations`, with `query_sql_hash` and `seat_count` reconciliation | `packages/server/test/integration/entitlements/declarations.test.ts` | Same mechanism as DATA-02; billing reconciliation is `usage_declarations.billing_ref` + `reconciled_at`. |

## TERM — the terminal client

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| TERM-01 | implemented | `core/command/{tokenizer,grammar,parser}.ts` — `[SECURITY] [SECTOR] [FUNCTION] [ARGS] <GO>`, `parse()` returns ranked interpretations and never throws; `web/src/shell/CommandLine.tsx` | `packages/core/test/command/parser.test.ts` (every worked example in FUNCTIONS §2.7); `packages/e2e/tests/command-line.spec.ts` | Everything reachable by menu is reachable by code: `ScreenSpec` nodes carry `command` strings and the `Escape` ladder is the only menu. |
| TERM-02 | implemented | `core/command/rank.ts` + `index.ts` (prefix arrays, word index, trigram fallback, MRU boost) over instruments + functions + people + topics in one ≤12 list; `web/src/command/localIndex.ts` builds it in a Worker from `/universe/snapshot` with ETag + IndexedDB; `GET /api/v1/search` fallback ≥3 chars | `packages/core/test/command/rank.test.ts`; `packages/core/test/command/command.bench.ts` (≤4 ms p95 on 45 k entries); `packages/server/test/integration/search.test.ts`; `packages/e2e/tests/autocomplete.spec.ts` | Three independent measurements of the <80 ms p95 budget (TESTING §15). |
| TERM-03 | implemented | `web/src/command/dispatch.ts` context rules over `PanelContext`: function-only applies to the panel's current security, security-only reloads the panel's current function | `packages/web/test/command/dispatch.test.ts` (the FUNCTIONS §2.5 context-rule table); `packages/e2e/tests/command-line.spec.ts` | Context is per panel, not per session, so four panels hold four securities. |
| TERM-04 | implemented | `shell/PanelGrid.tsx` 1/2/4 layouts, per-panel frame stack with back/forward and its own command line; one WebSocket for the whole session (`rt/wsBridge.ts`) | `packages/web/test/shell/panels.test.tsx`; `packages/e2e/tests/panels.spec.ts` | API §6.3 closes a second socket with `4003`, so the single-connection rule is enforced server-side too. |
| TERM-05 | partial | `workspaces.layout` jsonb (panels, frame stacks, monitors, chart settings, focus) + `version` optimistic concurrency; `PUT /workspaces/:workspaceId` returns 409 on a stale version | `packages/web/test/shell/panels.test.tsx` (409 surfaces); `packages/e2e/tests/panels.spec.ts` (persistence across reload) | Gap, stated by CLIENT §18.8: grid column widths outside `MonitorSpec.columns` live in `localStorage`, and theme/density are per device (§18.1) — "not 'the desk back on any machine' in the strict TERM-05 sense". |
| TERM-06 | partial | `keyboard/{keymap,dispatcher,focus}.ts`; the `ScreenRenderer` keyboard-operability contract (CLIENT §5.4) covering every `Node` kind; chart keyboard map (CLIENT §11.9); grid keyboard map | `packages/web/test/keyboard/keymap.test.ts`; `packages/web/test/screen/renderer.test.tsx` ("every Node kind keyboard-operable"); `packages/web/test/grid/LiveGrid.keyboard.test.tsx` | A mouse-only affordance fails the renderer test, which is the point. **Gap (WP-15, measured in real Chrome):** the window-level `keyboard/dispatcher.ts` is never attached, so `F1`, `PRINT`/`Ctrl+P`, `PAGE FWD`/`BACK`, the `Alt+n` panel chords and TERM-06's type-anywhere routing do nothing at all — zero requests, no focus move. See [Running-application gaps (WP-15)](#running-application-gaps-wp-15). Every region's own keys work at the element, which is why the terminal feels usable until a global key is pressed. |
| TERM-07 | partial | Reserved global keys GO / CANCEL / MENU / HELP / PRINT / PAGE FWD/BACK (CLIENT §5.2), each with an on-screen key-bar equivalent | `packages/web/test/keyboard/keymap.test.ts` (reserved keys, Escape priority, yellow keys, typing-anywhere routing) | CLIENT §18.6: `F11` (Curncy) is not interceptable on macOS Chrome; the key bar is the guaranteed path for that one key. **Gap (WP-15):** the reserved keys are mapped and unit-tested but not BOUND — the dispatcher is unattached (TERM-06) — and `KeyBar.tsx` was never written, so there is no on-screen equivalent either. `GO`, `CANCEL` and the yellow keys work because `CommandLine.tsx` owns them at the element; `HELP` is reachable as a command, `PAGE` from a screen's own control, and `PRINT` only from a screen's own control (FUNC-03 has no key path). |
| TERM-08 | implemented | `web/src/grid/**` — `LiveGrid.tsx`, `GridModel.ts`, `virtualiser.ts`, `cellRegistry.ts`, `flash.ts`, `sort.ts`, `group.ts`; imperative DOM cell updates outside React, cells keyed `(subject, fieldId)` | `packages/web/test/grid/LiveGrid.flash.test.tsx`; `packages/web/test/grid/LiveGrid.raf.test.tsx`; `packages/web/test/grid.frame-budget.test.ts` (2,000 cells, 5,000 changes/s); `packages/e2e/tests/live-grid.spec.ts` | [High effort] — its own work package (WP-13) as ARCHITECTURE §13 prescribes. A delta touches only the cells that changed. |
| TERM-09 | partial | `HelpSpec` per manifest; one press opens the context overlay, two presses open `TicketDialog` → `help_tickets` (with `screen_state`, `trace_id`) and a `rooms.kind='helpdesk'` room | `packages/server/test/integration/functions/HELP.test.ts`; `packages/e2e/tests/help.spec.ts` | The software half is complete and tested. Gap quoted from BRIEF §1 non-goals: "24/7 human helpdesk (TERM-09 second press opens a ticket record instead)" — a ticket record, not a live analyst. |
| TERM-10 | partial | `WorkspaceLayout.windows[{windowId, screen, bounds, panelIds}]` (API L622); CLIENT §7.4 Web Locks leader + BroadcastChannel relay, one WebSocket per session; `devicePixelRatio`-aware canvas | `packages/web/test/shell/panels.test.tsx` (layout round-trip) | Gap: browser windows, not OS-level windows; and CLIENT §18.2 states multi-window has no e2e coverage — two windows sharing `navigator.locks` needs a persistent Playwright context, which is not in the v1 e2e set. |
| TERM-11 | implemented | `theme/tokens.css` — colour is semantic only (up/down, entitled/blocked, stale/live, focus, error); `theme/type.ts` + `density.ts` density stack; no decorative colour | `packages/web/test/screen/renderer.test.tsx` ("each Cell state renders distinctly") | Dark is the default; light exists for TERM-13 locked-down desktops. |
| TERM-12 | implemented | `core/quote/staleness.ts#valueState` — **one implementation**, limit `3 × expectedIntervalMs`; `st` on every WS frame; a 1 s client ticker calling the same function; `ValueState` on every `Cell`; CSV carries the same staleness | `packages/core/test/quote/staleness.test.ts`; `packages/web/test/grid/LiveGrid.staleness.test.tsx`; `packages/e2e/tests/live-grid.spec.ts` | [Correctness]. A dead socket cannot leave a "live" number: a subject that is `resyncing` or whose socket is closed renders `stale` within 1 s (CLIENT §12.1 rule 1). |
| TERM-13 | implemented | The only client is a browser client (`packages/web`, Vite + React 19); a light theme exists specifically "for TERM-13 locked-down desktops" (CLIENT §12.2) | `packages/web/test/**` and `packages/e2e/tests/**` (the whole suite) | Parity on the top 50 functions is trivially satisfied: all 38 v1 functions run in the browser and nowhere else. There is no thick client to be at parity with, and no separate thin variant. |

## FUNC — function catalog and build order

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| FUNC-01 | implemented | `core/functions/manifest.ts` — `defineFunction({code, name, tier, assetClasses, params (zod), ParamGrammar, LiveSpec, CsvSpec, HelpSpec, KeyBinding[]})`; `FunctionRegistry`; `functions/runner.ts` (the eleven steps of FUNCTIONS §1.4.3) | `packages/server/test/unit/functions/runner.test.ts` (steps 1-11 including every error code, alias params and the variant assertion) | A function is a manifest plus `resolve`, `Screen` and `toCsv`; adding one touches no shared file except the generated barrels. |
| FUNC-02 | implemented | `FunctionServerModule.variants?: Partial<Record<AssetClass, FunctionResolver>>`; DES has 8 variants (equity, index, fx, govt, option, crypto, rate, econ), GP 7, HP 2 | `packages/server/test/integration/functions/DES.test.ts` ("all eight variants resolve for seeded securities") | The runner selects the variant by the resolved security's `asset_class`; the tier files may not narrow or widen the manifest's `assetClasses`. |
| FUNC-03 | partial | `core/functions/csv.ts#toCsv/writeCsv` (RFC 4180, CRLF, UTF-8 no BOM, `#` attribution lines); `functions/export.ts` re-checks entitlement with `usage='export'` and refuses per field when `export_allowed` is false; `web/export/csv.ts` never serialises locally | `packages/core/test/functions/csv.test.ts`; `packages/server/test/integration/functions/export.test.ts`; `packages/e2e/tests/export.spec.ts` (CSV equals the visible grid cell for cell) | CSV half implemented with entitlement checks. Gap quoted from BRIEF §1 non-goals: "Excel add-in (API-04 — replaced by CSV export and the JS SDK)". |
| FUNC-04 | implemented | `usage_events` partitioned, `kind` CHECK `fn.launch fn.param fn.page fn.export fn.help search.select cmd.parse_error panel.switch ws.subscribe ws.slow ws.resync ticket.open`; `observability/usageEvents.ts` batched writer; `params_hash` | `packages/server/test/integration/observability/usage.test.ts` (one row per launch/param/page/export, `params_hash` stability, the client batch route) | Instrumented from day one, which is what makes CHRT-04's remaining ~78 studies a roadmap question rather than an opinion (CLIENT §18.4). |

## CHRT — charting and technical analysis

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| CHRT-01 | partial | `SeriesType` union rendered by `web/src/chart/renderer.ts`: line, area, mountain, candle, ohlc, bar, step, scatter, tick, pnf, profile, heatmap | `packages/web/test/chart/renderer.test.ts` (golden-pixel snapshot per `SeriesType`) | All twelve types render. Gap stated by CLIENT §11.11: heatmap exists for surfaces but not as a price-chart type, and market profile is intraday only (no multi-day profile). |
| CHRT-02 | partial | `chart/streaming.ts` append/replace with last-slot redraw; `downsample.ts` M4; typed arrays; two canvas layers, redraw only dirty layers | `packages/web/test/chart/streaming.test.ts`; `packages/web/test/chart/chart.bench.ts` (10 years of daily bars pan/zoom inside the frame budget) | Gap stated by CLIENT §11.11: **no WebGL** (the requirement says GPU-accelerated), and tested to 1 M points, not "millions". CLIENT §17 records the decision: one Canvas 2D renderer serves price, curve, surface and sparkline. |
| CHRT-03 | partial | `chart/scales.ts` — independent axes (4 rendered), normalisation bases (log, percent, indexed-to-100), calendar alignment by union of timestamps, currency labels with conversion server-side | `packages/web/test/chart/scales.test.ts` (session-gap collapsing, axis ticks at three zoom levels) | Gap stated by CLIENT §11.11: intersection alignment is a server option only, and there is no per-series time-zone shift. |
| CHRT-04 | partial | `chart/studies/**` — 22 studies with an incremental `update()` contract, stackable in linked sub-panes, parameterised; study maths that is not display-only lives in `core/analytics/stats` | `packages/web/test/chart/studies.test.ts` (each study against a hand-computed series; multi-pane layout) | **22 of ~100** (CLIENT §11.11, §18.4). No user-defined studies. The registry shape scales; the catalogue is to be prioritised from `usage_events` `fn.param` with `changed:['studies']`. |
| CHRT-05 | implemented | `chart_annotations` — kinds `trendline hline vline fib text regression_channel rect`, `anchors [{t: epoch_ms, v}]` in data coordinates, `shared_scope private\|firm\|users`; keyboard draw mode | `packages/web/test/chart/annotations.test.ts` (anchors survive a zoom/pan round-trip and serialise to the `chart_annotations.anchors` shape); `packages/e2e/tests/chart.spec.ts` | Every kind the requirement names — trendlines, Fibonacci, text, regression channels — is shipped and shareable. CLIENT notes no free-hand and no annotation on curves or surfaces. |
| CHRT-06 | partial | `chart/events.ts` — 8 marker kinds (`earnings dividend split news filing index_add index_drop fomc`) with hit test, focus cycling and click-through (`Enter` executes `event.command`, e.g. `CACS` for a dividend) | `packages/web/test/chart/events.test.ts` (CLIENT §1 test listing) | Gap stated by CLIENT §11.11: **ratings markers have no source** and are absent. Every other marker kind click-throughs to its source function. |
| CHRT-07 | implemented | `core/formula/{lexer,parser,ast,evaluator}.ts` — security refs, arithmetic, `RATIO`, `SPREAD`, `NORM`, `MA`; usable wherever a security is entered; persisted in `watchlists.columns[].formula` and `watchlist_items.formula` | `packages/core/test/formula/evaluator.test.ts`; `packages/core/test/formula/formula.fuzz.test.ts`; `packages/e2e/tests/desk-flow.spec.ts` step 5 (a live formula column) | CLIENT §11.11 notes the *client* evaluates formulas only for watchlist columns over live fields; server-side formula series are the general path. |

## ANAL — analytics and pricing engines

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| ANAL-01 | partial | `core/analytics/bill.ts`, `bond/{price,risk,cashflows}.ts` — bills either side of 182 days, street-convention price↔yield, accrued with odd first/last coupons, the six `govt_terms.day_count` conventions, duration / modified duration / convexity / DV01 / key-rate durations | `packages/core/test/analytics/bill.test.ts`; `bond/price.test.ts`; `bond/risk.test.ts`; `packages/core/test/daycount/conventions.test.ts`; `packages/server/test/integration/functions/YAS.test.ts` | Gap: **no OAS and no term-structure model for callables**. WP-02's module list has no `oas.ts`, and no callable instrument exists in the seeded universe (REF-04). |
| ANAL-02 | partial | `core/analytics/curve/{bootstrap,interp,curve}.ts` — bills + par coupons → discount factors, OIS from SOFR fixings + par OIS, interpolation `linear_zero \| log_linear_df \| monotone_convex`, `Curve.df/zero/fwd/snapshot`; persisted as `curve_builds.nodes` | `packages/core/test/analytics/curve/bootstrap.test.ts` (reprices its own inputs to zero error); `curve/interp.test.ts`; `packages/server/test/integration/functions/CRVF.test.ts` | Gap: no futures strip (no futures source), **no cross-currency basis, no non-USD curve** — `curves` holds five USD curve ids. "Multi-curve" means OIS discounting against par, not a currency matrix. |
| ANAL-03 | partial | `core/analytics/options/{bsm,tree,mc}.ts` — BSM with continuous `q`, Black-76, full greeks, implied vol by Brent+Newton, CRR binomial and trinomial with American exercise, seeded antithetic + control-variate Monte Carlo | `packages/core/test/analytics/options/bsm.test.ts`; `tree.test.ts`; `mc.test.ts`; `packages/core/test/analytics/bsm.crosscheck.test.ts` | Gap: **no PDE solver** for path-dependence. Trees cover American exercise; exotics beyond that are not attempted. |
| ANAL-04 | partial | `core/analytics/vol/surface.ts` — chain → forward by put-call parity → SVI slice fit → calendar and butterfly arbitrage checks; persisted to `vol_surfaces.svi {a,b,rho,m,sigma,rmse,n}` keyed `(underlying, as_of, expiry)` | `packages/core/test/analytics/vol/surface.test.ts` (no calendar or butterfly arbitrage on the recorded AAPL chain; `rmse` recorded) | Gap: **SVI only, no SABR**; smoothing is per-slice, so arbitrage is checked after the fit rather than guaranteed by construction. Historical surface storage exists (`as_of` in the PK). |
| ANAL-05 | out-of-scope | BRIEF §1 wedge: "One asset-class-first terminal, not global multi-asset" — US equities/ETFs, Treasuries and money-market rates. `Corp` is a `market_sector` value with no instrument, no source and no function | — | No CDS bootstrapping, no ISDA standard model, no structured-product waterfalls. DATA-05 confirms there is no CDS composite source; zero citations of ANAL-05 anywhere in the design spine. |
| ANAL-06 | out-of-scope | BRIEF §1 wedge, same clause; `Mtge` is a `market_sector` value with no instrument and no source | — | No ABS/MBS/CLO cashflow engine, no prepayment or default vectors, no loan-level tape. Zero citations in the spine. |
| ANAL-07 | implemented | `core/analytics/stats/index.ts` — simple/log returns, vol, correlation, beta, OLS factor regression, drawdown, Sharpe / Sortino / information ratio, each echoing its `Conventions` object in the output | `packages/core/test/analytics/stats/index.test.ts` (WORKPLAN) / `packages/core/test/analytics/stats.test.ts` (TESTING §7.8) | "Explicit and consistent conventions" is enforced structurally: outputs carry the convention set that produced them, including `Conventions.ddof` (TESTING §17.17). |
| ANAL-08 | implemented | `defineEngine(name, version, fn) → EngineResult {inputs, outputs, engine{name,version}, valuationTs, inputsHash}` with a seeded xoshiro128\*\* PRNG; `inputs_hash char(64)` stored on `vol_surfaces`, `fin_statements` and `curve_builds`; no `Date.now()` in `core`; `meta.engines[]` on every payload | `packages/core/test/analytics/engine.test.ts` (hash stable across process restarts; any input change changes it); `packages/core/test/no-io.test.ts` | [Correctness]. Every engine is wrapped; `replay:diff` catches drift between releases. |
| ANAL-09 | partial | `fixtures/golden/analytics/<engine>/<case>.json` `{inputs, valuationTs, expected}` with documented tolerances (TESTING §7.1); second methods in-repo — tree vs closed form, MC vs BSM, finite-difference vs analytic greeks, Newton vs bisection | `packages/core/test/analytics/golden.test.ts`; `packages/core/test/analytics/bsm.crosscheck.test.ts` | Gap, stated by TESTING §18.5: the "independent implementation" is **in the same repository**. A genuinely independent oracle would mean committing values produced by an external library at fixture-capture time; that has not been done. The regression suite itself exists. |

## PORT — portfolio and risk

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| PORT-01 | partial | `portfolio/service.ts` CSV upload → `portfolio_imports` with per-row `errors [{row, identifier, column, reason}]` and `reconciliation {matched, added, removed, quantityDiffs}`; `positions.recon_status`; `POST /portfolios/:portfolioId/import` | `packages/server/test/integration/portfolio/import.test.ts` (a bad identifier yields `status='partial'`, an error row and a `data_exceptions` entry; re-upload is idempotent) | `portfolio_imports.channel` allows `upload \| file_drop \| api \| manual`, but only `upload` and `api` have a route. Gap: no custodian/administrator feed and no scheduled file-drop runner. |
| PORT-02 | partial | `positions` (lot_id, quantity, cost_price, cost_currency, trade/settle date, `accrued`, `is_cash`, `cash_currency`), `lots` (open_date, unit_cost, closed_date); `portfolios.base_currency` | `packages/server/test/integration/portfolio/import.test.ts`; `packages/server/test/integration/functions/PORT.test.ts` | Lot-level cost basis, accruals, cash and multi-currency are modelled. Gap: derivatives exposure modelling is delta-from-`option_quotes` only — no futures (REF-05 shape only), no FX forwards (DATA-05). |
| PORT-03 | partial | `core/analytics/portfolio/attribution.ts` — Brinson-Fachler allocation + selection + interaction by sector and security; TIER2.d `view === 'attribution'` over adjusted bars | `packages/core/test/analytics/portfolio/attribution.test.ts` (terms sum to total active return); `packages/server/test/integration/portfolio/analytics.test.ts`; `packages/server/test/integration/functions/PORT.attribution.test.ts` | Gap: **no fixed-income attribution by curve/spread/carry and no currency attribution** — both need return decompositions the sources cannot supply. |
| PORT-04 | partial | `core/analytics/portfolio/risk.ts` — ex-post tracking error, beta, vol, correlation, r², Sharpe, information ratio, max drawdown against the benchmark instrument | `packages/server/test/integration/portfolio/analytics.test.ts` (tracking error against a golden portfolio) | Gap: **there is no factor model**. No factor returns source exists, so factor exposures and marginal/component contribution to risk are absent; only ex-post statistics are computed. |
| PORT-05 | partial | TIER2.d step 10 — named scenarios `UST_PARALLEL_UP_100`, `UST_PARALLEL_DN_100`, `UST_STEEPEN_50` repricing `govt` holdings through `core/analytics/bond/risk` DV01 against `curve_points` | `packages/server/test/integration/portfolio/analytics.test.ts` | Parallel and non-parallel curve shifts and equity shocks exist. Gap: no spread widening (no spread source), no historical-episode replay. |
| PORT-06 | partial | `core/analytics/portfolio/risk.ts` — historical and parametric VaR with documented assumptions | `packages/server/test/integration/portfolio/analytics.test.ts` (PORT-03..06 row) | Gap: **no Monte Carlo VaR** in WP-02's module list and **no backtesting of exceptions** — neither the exception count nor a Kupiec-style test is specified anywhere. |
| PORT-07 | implemented | Postgres RLS policies keyed on `current_setting('app.firm_id')` / `app.user_id`, set per request transaction in `db/client.ts`; `firm_id` on `portfolios`, `positions`, `lots`, `portfolio_imports`, `messages`, `workspaces`, `watchlists`; the app role cannot bypass RLS | `packages/server/test/integration/entitlements/rls.test.ts`; `packages/server/test/integration/rls.isolation.test.ts`; `packages/server/test/integration/portfolio/isolation.test.ts` (another firm's user gets 404, not 403-with-data) | [Existential]. ARCHITECTURE §13 requires the test to attempt cross-tenant reads *as another firm under the app role* and expect zero rows — not merely a `tenant_id` column. |

## NEWS — news, research and documents

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| NEWS-01 | partial | `news_items` keyed `(source_id, provider_guid)` from `bbg.rss` (6 feeds), `sec.atom` (8-K) and `fed.rss`; `news/ingest.ts` strips HTML, detects corrections; `topics` tree | `packages/server/test/integration/news/ingest.test.ts` (dedupe, correction detection, tsv search) | One normalised stream with a `kind` CHECK (`story video filing press_release fed_release`). Gap: no licensed wires, no press-release distributors, no web sources, no regulatory disclosure services outside SEC. 160 seeded stories. |
| NEWS-02 | implemented | `news/entityLink.ts` → `news_entity_links` with the fixed `method`/confidence pairs: `cik` 1.0, `ticker_exact` 1.0, `name_exact` 0.95, `name_alias` 0.9; **links below 0.9 are never written**; uses `refdata/newsDict.ts` and `core/text/normName.ts` | `packages/server/test/integration/news/entityLink.test.ts` (over the 160 seeded stories every written link is ≥0.9; a known ambiguous headline produces **no** link) | Precision prioritised over recall, exactly as the requirement asks, and the test is written as a precision test rather than a coverage test. |
| NEWS-03 | partial | `n:<scope>` subjects are **not conflated** — one `delta` per headline in `published_at` order (API §6.1); `news/ranker.ts` live prepend | `packages/e2e/tests/news.spec.ts` (a replayed headline appears at the top within 1 s); CLIENT §16.1 budget `n:*` delta → row painted ≤100 ms | The plant-to-screen leg is under 1 s and measured. Gap: the clock starts at **our RSS poll**, not at publisher receipt — the Bloomberg RSS poll cadence (minutes) dominates end-to-end latency and cannot be improved without a wire feed. |
| NEWS-04 | partial | `secSubmissions` job → `filings` (form, items, accession, `accepted_at` as the public-knowledge instant) and `news_items` kind `filing`; `secCompanyFacts` → `xbrl_facts` → `fin_statements`; `data_exceptions.kind IN ('parse_error','manual_review')` queue | `packages/server/test/replay/fundamentals/companyfacts.test.ts`; `packages/server/test/integration/news/ingest.test.ts` | Exists: ingest, index and structured-financial extraction with an exception queue. Gap: extraction is **XBRL-only** — already-structured data. Nothing parses narrative text out of a non-XBRL filing, so the human review queue has almost nothing to review. |
| NEWS-05 | out-of-scope | No earnings-call audio or transcript source is reachable keyless (BRIEF §2 source table); BRIEF §1 build/buy line: "everything is built here; there is no budget for vendors" | — | Not named as a BRIEF §1 non-goal, but there is no source and no vendor budget. Zero citations in the design spine. Speaker attribution and a searchable audio archive are absent entirely. |
| NEWS-06 | out-of-scope | BRIEF §1 non-goals: "sell-side research distribution (NEWS-06)" | — | The per-publisher entitlement machinery would be `entitlement_grants` × `source_id`, which exists; no research corpus does. |
| NEWS-07 | partial | `saved_searches` (`news \| eqs \| srch`), `alerts` (`price \| news \| filing \| calendar` with typed `condition` jsonb), `alert_events`, `alerts/engine.ts` evaluating on plant deltas, `alerts:me` WS subject | `packages/server/test/integration/alerts/engine.test.ts` (a price alert fires once when `one_shot`, writes `alert_events` and reaches `alerts:me`) | All four trigger types and in-app delivery are implemented. Gap: `alerts.delivery` accepts `email` and `push`, but DATA_MODEL states these are **recorded intents in v1** — no mail transport, no push service. |
| NEWS-08 | implemented | `news_items.machine_generated` (always false in v1 — the column exists so the render rule is enforceable); no LLM summarisation or extraction anywhere; missing numbers are `meta.unavailable[]` with an `UnavailableReason`, never a generated value; `ValueState 'na'` has its own render class outside the numeric hierarchy | `packages/server/test/integration/functions/EE.test.ts` (estimate columns carry `NO_SOURCE` with a reason string — never blank, never zero) | [Trust]. The strongest form of compliance: there is nothing generated to mark, and the mechanism that would mark it is already load-bearing for EE's unavailable consensus. |

## MSG — messaging and the network

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| MSG-01 | partial | `rooms` (`dm group firm helpdesk`), `room_members` with roles, `messages` with per-room `seq` and idempotent `client_msg_id`, `message_reads`; `users` directory with `desk` and `role`; people appear in autocomplete as `Candidate.kind='person'` | `packages/server/test/integration/messaging/chain.test.ts`; `packages/server/test/integration/messaging/policy.test.ts` | Person-to-person and multi-party chat with a directory. Gap: the "verified global directory of users, firms and desk roles" is **two seeded firms and seven users** — REQUIREMENTS §SCOPE calls this a cold-start problem, not an engineering one, and nothing in v1 changes that. Second gap (WP-15): **MSG has no message composer in the running application** — the `Composer` custom widget does not exist, so the screen's central node draws the WP-12 placeholder. Pinned by `packages/web/test/app/App.test.tsx` ("leaves MSG and FXC on the WP-12 placeholder"), which is an INVERTED assertion and fails the day a `Composer` is registered. |
| MSG-02 | implemented | `messages_worm` trigger (app role has no UPDATE/DELETE grant); `messages_chain` hash chain `hash = sha256(prev_hash \|\| room_id \|\| seq \|\| sender \|\| sent_at \|\| body \|\| attachments)`; `surveillance_lexicon` / `surveillance_hits`; `message_reviews` (`lexicon \| random_sample \| manual`); `legal_holds`; `GET /api/v1/admin/export/messages?room&from&to` | `packages/server/test/integration/messaging/chain.test.ts` (the chain verifies over a room; an attempted UPDATE is blocked by the WORM trigger; a broken chain is detectable) | [SEC 17a-4 / FINRA 3110]. "Non-rewriteable non-erasable" is enforced by trigger plus role grants on Postgres, not by WORM storage media — a deployment note, not a design gap. |
| MSG-03 | implemented | `firms.policy {permittedCounterpartyFirms, disclaimer, ethicalWalls}`; `rooms.retention_days` (floor 7 years, never lowered), `rooms.disclaimer`, `rooms.wall_tag` enforced in `messaging/service.ts`; `users.desk` is the ethical-wall unit | `packages/server/test/integration/messaging/policy.test.ts` (ethical wall blocks a cross-desk room join; external-firm policy enforced; retention floor cannot be lowered) | All four clauses — retention, permitted counterparties, disclaimers, ethical walls — have a column and an assertion. |
| MSG-04 | partial | `messages.attachments jsonb` — `[{kind:'security'\|'chart'\|'function'\|'portfolio'\|'watchlist', ref, params}]`, documented as rendered live within the recipient's entitlements; `POST /messages` schema in API §5.10 | — (no named test) | The shape, the route and the entitlement rule are specified, but **no acceptance test in WORKPLAN §2 or TESTING asserts that a shared attachment re-renders under the recipient's own entitlements** rather than the sender's. That assertion is the whole requirement. |
| MSG-05 | out-of-scope | BRIEF §1 non-goals: "chat federation (MSG-05)"; ARCHITECTURE §13 [Strategic]: "Decided in BRIEF §1 (no federation, everything built)" | — | REQUIREMENTS itself calls federation "the only realistic cold-start answer"; the decision is taken with eyes open and is the main reason MSG-01 stays partial. |
| MSG-06 | partial | `messages.structured jsonb` — `{type:'ioi'\|'rfq', side, instrumentId, qty, price}`, explicitly "shape only … display only, no execution" | — (no named test) | Gap: nothing parses a structured message into an order ticket, because there is no order ticket — see EXEC-*. ARCHITECTURE §13 states the rule: "MSG-06 structured trade messages are parsed for display only". |

## API — data APIs and desktop integration

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| API-01 | implemented | Cookie sessions for the desktop/web surface bound to the logged-in user; `api_keys` (`key_hash`, `scopes {fn:run, ws:subscribe}`) for unattended use; `sessions.client_kind IN ('web','api')` with separate subscription ceilings; `entitlement_grants.usage_api` | `packages/server/test/integration/auth/apikeys.test.ts` (bearer key scopes gate `fn:run` and `ws:subscribe`; a revoked key 401s) | Both surfaces read the same evaluator, so an API key can never exceed its user's entitlements. |
| API-02 | implemented | `wire/dataRequest.ts` — one request model over `reference \| historical \| intraday \| tick \| snapshot \| subscription`; `POST /data` and `POST /api/v1/data`; `data/request.ts` dispatcher | `packages/server/test/integration/functions/data-request.test.ts` (the API §12.1 worked example returns the documented envelope with `asOf` and adjustment applied); `packages/server/test/integration/data/request.test.ts` | All five request types plus real-time subscription share one envelope and one error shape. |
| API-03 | partial | `@terminal/sdk` — `RestClient`, `LiveClient`, `QuoteCache`, `FieldsApi`, `FunctionRegistry`, wire types; `GET /fields/changelog`; deprecation policy: `deprecated` for at least two dictionary minor versions and six months (API §7) | `packages/sdk/test/wire-roundtrip.test.ts`; `packages/sdk/test/client/ws.test.ts`; `packages/core/test/fields/dictionary.test.ts` | JavaScript/TypeScript only, with a stable field dictionary and a written deprecation policy. Gap, stated by API L1206: "Python/R/Java/C++/C# clients (API-03) are out of v1 scope." |
| API-04 | out-of-scope | BRIEF §1 non-goals: "Excel add-in (API-04 — replaced by CSV export and the JS SDK)" | — | The substitute is real: `FUNC-03` CSV export is entitlement-checked and byte-compared against the screen in `export.spec.ts`. |
| API-05 | implemented | One data path — the web client cannot bypass the SDK (`packages/web/test/no-direct-io.test.ts`); screen, CSV and API read the same cached `resultId` payload; `core/functions/csv.ts#toCsv` is the only serialiser | `packages/server/test/parity/fn-parity.test.ts` — every manifest × every seeded security through resolver → JSON → CSV → WS snapshot at a frozen clock, asserting numeric equality (milestone I11, all 38 manifests) | [Correctness]. The "and Excel" clause is moot: there is no Excel surface to disagree with (API-04). |
| API-06 | implemented | `quota_limits` (daily unique instruments, monthly data points, concurrent subscriptions) × `quota_counters` × `quota_instruments_seen`; evaluator rule 5; `GET /usage/quota` live counters; 429 envelope (API §8) | `packages/server/test/integration/entitlements/quotas.test.ts` (all three caps plus the 429 envelope shape) | Enforced server-side with a distinct limit error per cap; `subAck.rejected[code:'QUOTA_EXCEEDED']` on the WS side. |
| API-07 | implemented | `core/fields/defs/*.ts` split by `field_class` → generated `dictionary.ts`; `FieldDef` carries definition, units, source, update frequency; `GET /fields` and `GET /fields/changelog`; versioned with a changelog route | `packages/core/test/fields/dictionary.test.ts` (every field id in CONTRACTS §4.3 resolves; `gen:fields` output matches the committed `fields.json`) | The dictionary is shared through the SDK, so terminal and API cannot disagree about a field's meaning. Worked examples per field are part of `FieldDef` but are not separately asserted. |

## EXEC — order and execution management

All six rows are out of scope for one reason, quoted from BRIEF §1 non-goals: **"order execution (EXEC-*)"**.
ARCHITECTURE §13 makes it structural: *"no order routes exist; MSG-06 structured trade messages are parsed for display only."*

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| EXEC-01 | out-of-scope | BRIEF §1: "order execution (EXEC-*)" | — | [Regulatory] broker-dealer / ATS / MTF registration. Adding execution converts the product into a regulated financial entity; not attempted. |
| EXEC-02 | out-of-scope | BRIEF §1, same clause | — | No FIX connectivity, no counterparty sessions, no drop-copy. |
| EXEC-03 | out-of-scope | BRIEF §1, same clause | — | No order lifecycle. The immutable-audit-trail machinery that would serve it exists for messages (`messages_chain`, WORM) if execution ever lands. |
| EXEC-04 | out-of-scope | BRIEF §1, same clause; ARCHITECTURE §13 [SEC 15c3-5]: "Out of scope with EXEC-*" | — | No pre-trade risk controls, no kill switch. |
| EXEC-05 | out-of-scope | BRIEF §1, same clause | — | No best-execution analysis or regulatory reporting. |
| EXEC-06 | out-of-scope | BRIEF §1, same clause | — | No CAT reporting. |

## SEC — identity and security

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| SEC-01 | partial | `users.person_verified_at` / `verified_by` (onboarding evidence), `POST /admin/users`, `users.status active \| suspended \| deprovisioned` with `deprovisioned_at`; sessions revoked with `revoke_reason='deprovisioned'` | `packages/server/test/integration/auth/session.test.ts` | Account-to-person binding and immediate deprovisioning exist. Gap: `users.scim_external_id` is documented as "SSO/SCIM (out of scope; column reserved)" — there is **no SSO and no SCIM provisioning**, and verification is an attestation timestamp, not a documented KYC flow. |
| SEC-02 | implemented | `http/auth/webauthn.ts` FIDO2 registration and assertion against `user_credentials` (`credential_id`, `public_key`, `sign_count`, `aaguid`, `transports`); `users.mfa_required`; `sessions.mfa_verified`; password login is dev-only via pgcrypto `crypt(…, gen_salt('bf',12))` | `packages/server/test/integration/auth/webauthn.test.ts` (registration and assertion; a `sign_count` rollback is rejected) | WebAuthn with a hardware authenticator is what the requirement itself names as sufficient. The library choice (`@simplewebauthn/server ^13`) is WORKPLAN §18.9 — an addition, no spine document names a dependency. |
| SEC-03 | implemented | Single active session per user; a second login supersedes with `revoke_reason='superseded'` and increments `superseded_count`; `sessions.device_id` / `ip` / `user_agent`; a second WebSocket is closed with code `4003` | `packages/server/test/integration/auth/session.test.ts`; `packages/server/test/integration/entitlements/session.test.ts` | Detection *and* blocking, as the per-person licensing contracts require (ENTL-03). |
| SEC-04 | partial | Session tokens stored only as `digest(token,'sha256')`; passwords as bcrypt via pgcrypto; TLS termination assumed in front (ARCHITECTURE §13, SEC-07 row) | — (no named test) | **The weakest row in this table.** Zero citations of SEC-04 in any design document. No at-rest encryption design, no mutual TLS for enterprise links, no customer-managed keys for portfolio data — which PORT-07 calls existential. What exists protects credentials, not data. |
| SEC-05 | implemented | Postgres row-level security on every tenant table keyed on `current_setting('app.firm_id')`; app role cannot bypass RLS; `firm_id` denormalised onto `positions` and `lots` specifically so RLS can see it | `packages/server/test/integration/rls.isolation.test.ts`; `packages/server/test/integration/entitlements/rls.test.ts` | "Tested controls, not merely a `tenant_id` column" is the requirement's own wording, and the test is written as an attack: read another firm's rows under the app role, expect zero. |
| SEC-06 | implemented | `users.role='newsroom'` as the wall marker (DATA_MODEL comment: "'newsroom' = SEC-06 wall"); `rooms.wall_tag` ethical walls enforced in `messaging/service.ts`; RLS prevents any role reaching another firm's portfolios | `packages/server/test/integration/messaging/policy.test.ts`; `packages/server/test/integration/entitlements/rls.test.ts` | Technical enforcement exists ahead of the organisation: there is no news organisation in v1, but a `newsroom` role can never reach client data by construction. |
| SEC-07 | out-of-scope | BRIEF §1 non-goals: "SOC 2 / ISO certification (SEC-07)" | — | ARCHITECTURE §13 [Sales blocker]: the controls an auditor would test — TLS termination in front, session hashing with pgcrypto, RLS tenant isolation, the access log, immutable messages — are built so certification can follow. Penetration tests and a disclosure programme are absent. |

## REG — regulatory and compliance obligations

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| REG-01 | implemented | WORM triggers on `messages`, `access_log`, `provenance`, `usage_events`, `xbrl_facts`; `messages_chain` hash chain; retention floors ≥7 years on `firms.retention_days` and `rooms.retention_days` (never lowered); production on request via `GET /api/v1/admin/export/messages` | `packages/server/test/integration/entitlements/accessLog.test.ts` (the WORM trigger rejects UPDATE/DELETE); `packages/server/test/integration/messaging/chain.test.ts` | [SEC 17a-3/17a-4]. Non-rewriteable and non-erasable is enforced in the database, and "prompt production" is a route rather than a runbook. |
| REG-02 | out-of-scope | **Not a BRIEF §1 non-goal.** Out of scope because the precondition never occurs: ARCHITECTURE §13 — "No index or benchmark is published; curves (`c:UST_PAR`, `c:SOFR_OIS`) are labelled derived from official Treasury/NY Fed inputs with `attribution` and are not redistributed (`licence_registry.redistribution=false`)" | — | [EU BMR] would bite only if a curve were published as a benchmark. `redistribution=false` on every licence row is the mechanism that keeps it that way. |
| REG-03 | partial | TIER3.d forces `pricing.basis='curve_derived_no_market_quotes'` and a `NO_BOND_PRICE_SOURCE` amber badge on every YAS payload; `licence_registry.redistribution=false`; nothing is sold or published as an evaluated price or a rating | `packages/server/test/integration/functions/YAS.test.ts` | The technical half — never presenting a derived yield as an evaluated price — is implemented and asserted. Gap: the assessment itself ("assess whether rating-agency or pricing-service registration applies") is a legal task with no software artefact and has not been done. |
| REG-04 | partial | DATA_MODEL §19 — lawful basis documented per column for every personal-data field; `users.anonymised_at` erasure (email/display_name → `user-<id>`) via `DELETE /api/v1/admin/users/:id`, preserving `access_log` integrity under legal obligation; `sessions.ip` purged 90 days after revocation | — (no named test) | The documentation requirement is fully met and the erasure route exists. Gap: **no acceptance test covers erasure** — nothing asserts that anonymisation leaves the audit log referentially intact, which is the only tricky part. |
| REG-05 | partial | `messaging/surveillance.ts` — `surveillance_lexicon` (per-firm regex, severity) → `surveillance_hits` with review states `pending \| escalated \| cleared`; `message_reviews` supports random sampling; `legal_holds` | — (no named test for lexicon hits) | ARCHITECTURE §13: "Mechanism-level only … recorded as gaps in TRACEABILITY.md." Chat is covered by design; **news and research have no market-abuse controls at all**, and no inside-information handling model exists across surfaces. |
| REG-06 | partial | `users.sanctions_screened_at`, `users.sanctions_status CHECK ('clear','review','blocked')`; lawful basis recorded in DATA_MODEL §19 | — (no named test) | DATA_MODEL calls it "REG-06 mechanism (manual attestation in v1)" and ARCHITECTURE §13 says plainly "no sanctions screening". No OFAC/EU/UN/UK list ingestion, no onboarding check, no continuous re-screening. |
| REG-07 | partial | `firms.data_residency` — "REG-07 recorded; single region in v1" | — (no named test) | The column records the client's requirement; nothing enforces it, because there is one deployment region and no routing layer (see NFR-03, out of scope). |
| REG-08 | out-of-scope | **Not a BRIEF §1 non-goal.** ARCHITECTURE §13 [DORA / FCA CTP]: "Out of scope; status endpoint and DR notes only" | — | Designation as a critical third party presupposes clients material enough to trigger it. `status_incidents` and `GET /api/v1/status` are the only operational-resilience artefacts (see OPS-04, OPS-05). |

## NFR — performance and scale targets

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| NFR-01 | partial | `fixtures/sessions/sim-ws-burst` — the standing burst profile: SimFeed at `rateHz = 200` across 500 subjects for 60 virtual seconds; `providers/sim/prng.ts` seeded and bit-identical across runs | `packages/server/test/perf/plant.perf.test.ts` (`plant_publish_latency_ms` p99 over a 100 k-update burst) | TESTING §15 states the gap in its own words: "It exercises NFR-02 degradation but does not size real capacity (NFR-01); that gap is recorded in `docs/TRACEABILITY.md` as partially implemented." A 100× quiet-to-FOMC ratio cannot be rehearsed against a 10-second delayed poll. |
| NFR-02 | implemented | Conflation widening under load, `essential`-flag subscription shedding, slow-consumer downgrade, `dq_events.kind='plant_degraded'` and `'ws_backpressure'`; last-price correctness preserved; nothing dropped silently | `packages/server/test/integration/ws/overload.test.ts`; `packages/server/test/integration/ws/backpressure.test.ts`; `packages/web/test/grid.frame-budget.test.ts` | Degradation is observable by design — every shed or downgrade writes both a usage event and a DQ event. |
| NFR-03 | out-of-scope | BRIEF §1 non-goals: "multi-datacentre PoPs (NFR-03)"; ARCHITECTURE L1206 restates it | — | Single region. This is also why REG-07 (residency) stays partial. |

## OPS — operations and resilience

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| OPS-01 | out-of-scope | **Not named in BRIEF §1 verbatim.** Adjacent to the quoted non-goal "24/7 human helpdesk (TERM-09 second press opens a ticket record instead)": follow-the-sun operations is staffing, not software | — | The software prerequisites it would need — a maintenance window that does not break Tokyo — reduce to OPS-02, which is partial. No rota, no on-call, no regional handover exists. |
| OPS-02 | partial | WS close code `1001` on SIGTERM with client reconnect + resync (clients survive a restart); versioned `/ws/v1` path and `/api/v1` prefix; API §11 versioning and compatibility policy | `packages/server/test/integration/ws/resync.test.ts` (reconnect and resync without gaps or duplicate deltas) | Users are not *disconnected destructively* — they resync. Gap: **only one protocol version exists**, so "backward-compatible across at least two versions" has no test case, and there is no rolling-upgrade orchestration (single process, ARCHITECTURE §12). |
| OPS-03 | implemented | `dq_events` with 13 `kind` values — `stale_tick`, `cross_source_divergence`, `missing_close`, `field_population`, `poll_anomaly`, `provider_circuit_open`, `reconcile_mismatch`, `parse_error`, `default_partition_nonempty`, `ref_orphans`, `ws_backpressure`, `plant_degraded`, `replay_diff`; `observability/dq.ts`; `ingest/jobs/dqMonitors.ts`; surfaced on `GET /api/v1/status` and `sys:status` | `packages/server/test/integration/ingest/reconcile.test.ts` (Cboe vs Yahoo close divergence >0.5 % writes `cross_source_divergence`); `packages/server/test/integration/ingest/partitions.test.ts` | Every signal the requirement lists has a `kind` value and a monitor. Data quality is a first-class table, not a log line. |
| OPS-04 | partial | `status_incidents` (component, severity `info \| degraded \| outage`, `updates` jsonb); `GET / POST /admin/incidents` and `/admin/incidents/:id/updates`; `GET /api/v1/status` and the `sys:status` subject | — (no named test) | The status page's data model and routes exist and feed from `dq_events`. Gap: **no acceptance test names `status.ts`**, and "proactive incident communication" is a process with no delivery channel (see NEWS-07 — email and push are recorded intents). |
| OPS-05 | partial | Committed SQL migrations plus a deterministic offline seed make a full rebuild reproducible (`npm run db:reset && db:migrate && db:seed`, WORKPLAN §15.1); `status_incidents` for communication | `packages/server/test/integration/seed/idempotent.test.ts`; `packages/server/test/integration/db/migrate.test.ts` | Rebuild-from-zero is genuinely tested, which is most of an RTO story for a stateless read-mostly system. Gap: **no documented DR plan, no stated RTO, no backup/restore procedure, no exercise schedule and no industry DR test participation.** ARCHITECTURE §13 concedes "DR notes only". |
| OPS-06 | out-of-scope | BRIEF §1 non-goals: "24/7 human helpdesk (TERM-09 second press opens a ticket record instead)" | — | `help_tickets` captures the question, the screen state and the trace id so a human could answer later; `users.role='helpdesk'` and the helpdesk room exist for when one is hired. |
| OPS-07 | implemented | One `trace_id` minted client-side in `command/dispatch.ts`, carried as `x-trace-id` and stored on `access_log.trace_id`, `usage_events.trace_id`, `provenance.trace_id`, `ingest_runs.trace_id` and `messages.trace_id`; `observability/traceQuery.ts` behind `GET /api/v1/admin/trace/:traceId`; pino child bindings | `packages/server/test/integration/observability/trace.test.ts` (one `x-trace-id` threads through `access_log`, `usage_events` and `provenance`, and `/admin/trace/:traceId` returns all three) | "Why is this number wrong?" is answerable in one query: the trace joins the keystroke to the provider response hash. WORKPLAN §15.1 step 10 walks it by hand. |

## QA — testing and data quality assurance

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| QA-01 | partial | `fixtures/golden/analytics/<engine>/<case>.json` — the `GoldenCase` record `{inputs, valuationTs, expected}` with per-field tolerance semantics (TESTING §7.1), run on every build; `golden:update` gated by `ALLOW_GOLDEN_UPDATE` | `packages/core/test/analytics/golden.test.ts` | The harness, the record shape, the tolerance rules and the CI gate all exist. Gap, flagged by WORKPLAN §18.16: **the expected values do not exist in any input document.** WP-02 must derive every case from a published worked example (Treasury bill formulas, ICMA conventions, textbook BSM/CRR) and record the source in the file — never from its own implementation's output, which would make the suite circular. |
| QA-02 | implemented | `replay/harness.ts` + `diff.ts` + `cli.ts` backing `npm run replay:run` / `replay:diff`; `replay/diff.ts` prints the **first** divergence and writes `dq_events.kind='replay_diff'`; the release gate in TESTING §6.2 blocks on any unexplained diff | `packages/server/test/replay/determinism.test.ts`; `packages/server/test/replay/sessions.test.ts`; `packages/server/test/replay/normalisers.test.ts`; `packages/server/test/replay/harness.test.ts` | Milestone I12: two runs over every session in `fixtures/sessions/` produce identical output, and an injected change produces exactly one reported divergence. |
| QA-03 | partial | `ingest/jobs/reconcile.ts` — Cboe vs Yahoo close divergence beyond 0.5 % writes `dq_events.kind='cross_source_divergence'`; SEC frames vs companyfacts for fundamentals | `packages/server/test/integration/ingest/reconcile.test.ts` | Gap, stated as an open question by TESTING §18.3: offline there are only two independent sources for a handful of equity closes and one for fundamentals. There is **no per-asset-class tolerance table** and no continuous reconciliation for Treasuries, FX, rates or econ — most of which have exactly one source. |
| QA-04 | partial | `fixtures/sessions/sim-ws-burst`, SimFeed 200 Hz × 500 subjects × 60 virtual seconds; `SIM_FEED=1` | `packages/server/test/perf/plant.perf.test.ts`; `packages/web/test/grid.frame-budget.test.ts` | TESTING §18.4: "SimFeed proves graceful degradation but not capacity." No peak-day load harness, no safety factor, no pre-event load exercise. This is the same gap as NFR-01 seen from the test side. |
| QA-05 | implemented | Every `parse.ts` is pure and is a fuzz target; the four shared parsers `providers/{xml,html,csv}.ts` + `ssga/xlsx.ts` too; seeded corpus mutator `packages/server/test/fuzz/mutate.ts` driven by `providers/sim/prng.ts`; `FUZZ_ITERATIONS` env | 16 files `packages/server/test/fuzz/*.fuzz.test.ts` (cboe.quotes, cboe.options, cboe.symbolbook, yahoo.chart, yahoo.search, sec.json, sec.xml, openfigi, nyfed, treasury, rss, csv, html, xlsx, json.misc); plus `packages/core/test/command/parser.fuzz.test.ts`, `ids/ids.fuzz.test.ts`, `formula/formula.fuzz.test.ts`; `packages/server/test/unit/providers/parse.fuzz.test.ts` | A malformed response must return a parse-error result and a `dq_events.kind='parse_error'` row, never throw. Seeds are printed and a failing seed is committed as a regression case. |
| QA-06 | partial | `data_exceptions.sla_due_at` (the correction SLA clock), `dq_events` (measured error signals), `status_incidents` (public-facing incidents), `usage_declarations` | — (no named test) | The substrate to measure error rates and correction turnaround exists. Gap: **no SLA is defined, no error-rate metric is computed, no report is produced and nothing is published to clients.** Zero citations of QA-06 anywhere in the design spine — the largest documentation gap in this table. |

## BIZ — cost, staffing and the incumbent's shape

All four are commercial or organisational requirements with no software artefact. BRIEF §1 build/buy
line: **"everything is built here; there is no budget for vendors."** The hooks where each would
attach are named so they are not lost.

| ID | status | where | test | note |
| --- | --- | --- | --- | --- |
| BIZ-01 | out-of-scope | BRIEF §1: "there is no budget for vendors" — every v1 source is keyless and public, so licensing COGS is zero by construction | n/a (document decision) | Hook: `licence_registry.contract_ref` (NULL for all 33 rows) and `usage_declarations.seat_count` / `billing_ref` are where a per-seat COGS model attaches when a paid source lands. |
| BIZ-02 | out-of-scope | BRIEF §1 build/buy line; staffing, not software | n/a (document decision) | The requirement's own example — "a team that has never priced a callable bond will ship a plausible and wrong YAS" — is mitigated structurally instead: ANAL-09 goldens from published worked examples, and TIER3.d refuses to present a curve-derived yield as a market price. |
| BIZ-03 | out-of-scope | BRIEF §1 build/buy line; staffing, not software | n/a (document decision) | The tooling half is REF-10 (partial): `data_exceptions` queues, dual-key review on `corporate_actions`, `users.role='dataops'` and `sla_due_at` all exist with nobody to work them. |
| BIZ-04 | out-of-scope | BRIEF §1 build/buy line; there is no commercial motion in v1 | n/a (document decision) | Hooks that a compliance-gated enterprise sale would consume already exist: SEC-05 tenant isolation tests, ENTL-04 access log, MSG-02 WORM archive, REG-04 lawful-basis table — the SEC-07 row lists them as "built so certification can follow". |

## PLAN — phased delivery

REQUIREMENTS.md §PLAN defines **no numbered requirement ids** — it is a five-row phase table, so it
contributes 0 of the 158. The rows below map each phase to the WORKPLAN.md structure that replaces
it. WORKPLAN.md compresses the 33-48-month sequence into two waves of parallel agents (§16), because
the licensing critical path that gates the original sequence does not exist here (DATA-01).

| Phase | status | where | test | note |
| --- | --- | --- | --- | --- |
| Phase 0 — licensing and wedge definition | out-of-scope (licensing) / implemented (wedge) | BRIEF §1 fixes wedge, persona, non-goals, competitive claim and build/buy line (SCOPE-01..05) | n/a (document decision) | Exit criterion "signed agreements for the v1 venue set" is unmeetable and is DATA-01's gap; the other three exit criteria are ratified in BRIEF §1. |
| Phase 1 — data spine | partial | WP-01 (schema, 16 migrations), WP-04 (security master, bitemporal, data services), WP-05 (17 provider adapters, replay store, ingest runtime), WP-15 (seed) | Milestones I1-I3: `db/migrate.test.ts`, `db/schema-drift.test.ts`, provenance round-trip, `refdata/resolve.test.ts` after `db:seed` | "Two feed handlers in production" becomes seventeen HTTP adapters; "reconciliation against an independent source passing" is QA-03, partial. |
| Phase 2 — terminal and Tier 1 | partial | WP-06 (plant, WS), WP-07 (entitlements, auth), WP-08 (runner, routes), WP-09 (14 Tier 1 codes, news, messaging), WP-12 (shell, command line), WP-13 (LiveGrid, SDK live client) | Milestones I4-I9; `packages/e2e/tests/desk-flow.spec.ts` | Exit criteria met except "Excel add-in shipping identical numbers" — API-04 is out of scope, replaced by CSV parity (`fn-parity.test.ts`). |
| Phase 3 — depth in the wedge | partial | WP-10 (14 Tier 2 codes, fundamentals, portfolios), WP-11 (10 Tier 3 codes, curves/rates/econ), WP-14 (chart engine, 22 studies) | Milestones I10-I11; the per-code tests in WORKPLAN §2 WP-10/WP-11 | Exit criteria "analytics independently validated" is ANAL-09 (partial: in-repo second methods), "SOC 2 Type II awarded" is SEC-07 (out of scope), "first paying desks" has no software artefact. |
| Phase 4 — network and expansion | out-of-scope / partial | Messaging ships in WP-09 **without** federation (MSG-05 out of scope); portfolio and risk ship in WP-10 (PORT-01..07, mostly partial) | `messaging/chain.test.ts`, `messaging/policy.test.ts`, `portfolio/analytics.test.ts` | "Second asset class or region" contradicts BRIEF §1's one-asset-class wedge; "data-quality SLA published" is QA-06, partial. |

---

## Summary

| Status | Count | Share |
| --- | --- | --- |
| implemented | 64 | 40.5 % |
| partial | 67 | 42.4 % |
| out-of-scope | 27 | 17.1 % |
| **total** | **158** | **100 %** |

Per subsystem:

| Subsystem | implemented | partial | out-of-scope | total |
| --- | --- | --- | --- | --- |
| SCOPE | 5 | 0 | 0 | 5 |
| DATA | 3 | 6 | 1 | 10 |
| FEED | 1 | 5 | 4 | 10 |
| REF | 5 | 5 | 0 | 10 |
| BUS | 6 | 2 | 0 | 8 |
| STOR | 3 | 4 | 0 | 7 |
| ENTL | 6 | 0 | 0 | 6 |
| TERM | 8 | 5 | 0 | 13 |
| FUNC | 3 | 1 | 0 | 4 |
| CHRT | 2 | 5 | 0 | 7 |
| ANAL | 2 | 5 | 2 | 9 |
| PORT | 1 | 6 | 0 | 7 |
| NEWS | 2 | 4 | 2 | 8 |
| MSG | 2 | 3 | 1 | 6 |
| API | 5 | 1 | 1 | 7 |
| EXEC | 0 | 0 | 6 | 6 |
| SEC | 4 | 2 | 1 | 7 |
| REG | 1 | 5 | 2 | 8 |
| NFR | 1 | 1 | 1 | 3 |
| OPS | 2 | 3 | 2 | 7 |
| QA | 2 | 4 | 0 | 6 |
| BIZ | 0 | 0 | 4 | 4 |
| **total** | **66** | **65** | **27** | **158** |

**Two** of the 66 implemented rows carry `n/a (document decision)` in the test column — SCOPE-03
(the non-goals list) and SCOPE-05 (the build/buy line). The other **64** each name at least one
acceptance test file. The four BIZ rows also carry `n/a`, but they are out of scope, not implemented.

**Twelve rows have no named test at all.** Ten are partial — FEED-07, MSG-04, MSG-06, SEC-04, REG-04,
REG-05, REG-06, REG-07, OPS-04, QA-06 — and two are the document decisions above. Every one of the
ten appears in the risk section or the open questions below. No row is marked implemented without a
test except those two.

The 27 out-of-scope rows split into three groups: **seventeen** whose id BRIEF §1 names verbatim
(EXEC-01..06, FEED-01/02/09/10, DATA-04, API-04, MSG-05, NEWS-06, SEC-07, NFR-03, OPS-06); **seven**
ruled out by the BRIEF §1 wedge or build/buy sentences without naming the id (ANAL-05, ANAL-06,
NEWS-05, BIZ-01..04); and **three** ruled out for a reason BRIEF §1 does not state at all — REG-02,
REG-08 and OPS-01, whose notes say so explicitly rather than borrowing a quote.

## Running-application gaps (WP-15)

Three gaps that only a running application can show, recorded here because the rows above would
otherwise read as complete. Each is measured against the composed app (`packages/web/src/App.tsx`),
not inferred from a comment, and each has a test that fails the day it is closed or re-opened.

| Gap | Where it shows | Evidence | Pinned by |
| --- | --- | --- | --- |
| **The window keyboard dispatcher is not attached** (TERM-06, TERM-07, FUNC-03) | `F1` opens no overlay; `Ctrl+P` issues no `/functions/:code/csv`; `PageDown` issues no `/page`; `Alt+1` does not move the panel focus; a printable key pressed on a `gridcell` does not reach the command line | Five keys driven in real Chrome on QM with a `role="gridcell"` focused: zero `/api/v1` requests, focus unmoved, command draft still `''` | — (no test; `keyboard/dispatcher.ts` is unit-tested against a fake host, which is exactly why an unattached dispatcher stayed green) |
| **`Composer` is not in the `WidgetRegistry`** (MSG-01) | MSG has no message composer and FXC no editor grid: one `[data-pending="Composer"]` where the widget should be | `widgets.tsx` header states the reason — two unrelated prop shapes (a currency matrix; a message draft with attachments and a send gate) and no component for either in the repo | `packages/web/test/app/App.test.tsx` — "leaves MSG and FXC on the WP-12 placeholder" (inverted) |
| **`Sparkline` is not in the `WidgetRegistry`** (CHRT-01 shape, no requirement of its own) | DES (`rate` variant), ECO and EE leave a placeholder where a small series would be drawn | The node passes `{ points: [{t, v}], fmt }` with no `provIdx` on any point, and every `ChartSeries` in a `ChartSpec` carries a mandatory one: DATA-10 forbids drawing a number whose source cannot be named. Closing it means the three screens passing the provenance index they already hold for the series they plot, not a change to `widgets.tsx` | — (no test; the screens' specs are asserted, the registry's omission is not) |

What the first row needs, stated once so it is not re-derived: `keyboard/dispatcher.ts` is complete,
but `KeyboardHost.region()`, `screenBindings()`, `capturesTypedText()` and `screenAction()` all need
the focus model `keyboard/focus.ts` defines, and the only place a `FocusState` and
`collectFocusNodes(spec.body)` both exist is `shell/Panel.tsx`, which keeps them in private component
state. So `Panel` must publish its focus and its merged bindings (a callback prop, or a focus slice on
`state/panels.ts`) before the composition root can build a host at all. Re-deriving the focused node's
KIND from the DOM is not an alternative: it is a second focus model, disagreeing with the first at
exactly the moments the first was written to get right. The remaining decision, which is a design
decision and not a wiring one, is what stage 4 (`regionKey`) does when the grid, the chart, the form
and the command line already answer their own keys at the element.

## Highest-risk partials

Ranked by what breaks if the gap is not closed before the first external user.

1. **SEC-04 (encryption at rest / mTLS / customer-managed keys)** — zero design coverage, no test, and
   it sits directly under PORT-07, which REQUIREMENTS marks [Existential]. Tenant isolation is proved
   at the row level but the bytes underneath are unaddressed. This is the only requirement with a
   [security] consequence and no mechanism at all.
2. **QA-01 (golden analytics values)** — the harness exists; the numbers do not (WORKPLAN §18.16).
   If WP-02 generates the expected values from its own implementation, the entire ANAL family's
   evidence becomes circular and ANAL-09 is worthless. Each case must cite a published source in the
   file, and that is an unbudgeted research task on the critical path of WP-02, WP-11 and the I11
   parity milestone.
3. **MSG-04 (attachments rendered within the recipient's entitlements)** — a specified rule with no
   test. A shared chart or portfolio attachment that renders with the *sender's* entitlements is a
   licence breach of exactly the kind ENTL-01 exists to prevent, and nothing would catch it.
4. **QA-03 (continuous reconciliation)** — most values in the system have exactly one source, so
   "reconcile against at least one independent source" is unachievable for Treasuries, rates, FX and
   econ. TESTING §18.3 asks whether fixture-scale reconciliation is sufficient evidence; until that is
   answered, the terminal's core claim (SCOPE-04: "every number carries source-level provenance") is
   provenance without corroboration.
5. **DATA-07 / DATA-08 source gaps that reach the screen** — consensus estimates are structurally
   absent (EE, ECO) and corporate actions beyond dividends and splits have schema without a feed. Both
   are handled honestly through `meta.unavailable[]` rather than blanks, but a PM who opens `CACS`
   expecting a tender offer sees nothing, and no test distinguishes "no event" from "no source".
6. **BUS-05 / DATA-03 (composite is not a consolidated tape)** — the merge across `md_lines` is real
   and tested, but two delayed providers are not venues. Any screen labelled "composite" invites the
   inference that it is an NBBO. TERM-12 staleness and the `DELAYED 15m` badge mitigate; the wording
   on Q and QM should be audited before a user sees it.
7. **STOR-02 (bars are not bitemporal)** — fundamentals, econ, rates and curves all carry vintages;
   bars do not. A restated or corrected daily bar silently overwrites, which quietly breaks the
   STOR-06 promise for any backtest that reads prices rather than fundamentals.
8. **OPS-05 (no DR plan)** — the rebuild path is reproducible and tested, which is unusually strong,
   but there is no RTO, no backup procedure and no exercise. The gap is cheap to close and is a
   standing item in every enterprise security review (BIZ-04).
9. **NFR-01 / QA-04 (capacity unknown)** — the system degrades gracefully under a 200 Hz synthetic
   burst and nobody knows what it does at an FOMC release. The risk is bounded only because the
   providers are 15-minute polls; it becomes acute the moment a real feed is licensed.
10. **CHRT-02 / CHRT-04 (chart depth)** — 22 of ~100 studies and no GPU path. Neither breaks
    correctness, and FUNC-04 usage instrumentation exists precisely to prioritise the tail, but
    "~100 standard technical studies" is a checklist item in competitive evaluations.

## Additions required

Names this document needed that CONTRACTS.md does not define. None invents a table, column, route,
enum or wire type.

1. **Status vocabulary.** CONTRACTS.md defines no `implemented | partial | out-of-scope` enumeration;
   BRIEF §7 names the three words in prose and this file fixes their meaning in the table above.
2. **`n/a (document decision)` as a test value** for requirements whose deliverable is a written
   decision (SCOPE-03, SCOPE-05, the four BIZ rows). No spine document contemplates a requirement with
   no executable check.
3. **The PLAN table has no requirement ids.** REQUIREMENTS.md §PLAN is a phase table; this file maps
   its five phases to WORKPLAN waves and milestones rather than to ids, and states that PLAN
   contributes 0 of the 158.
4. **`packages/e2e/tests/news.spec.ts`, `chart.spec.ts`, `quote.spec.ts`, `rates.spec.ts`,
   `watchlist.spec.ts`, `fa-pit.spec.ts`** are cited above from TESTING §14 and parts/TIER1.b; they
   are not in the seven-spec list of ARCHITECTURE §3.5 that WORKPLAN WP-15 owns. WP-15's e2e scope is
   larger than its own bullet states.
5. **`packages/web/test/chart/events.test.ts`** (the CHRT-06 evidence) appears only in the CLIENT.md §1
   directory listing, not in any acceptance-test table. WP-14's test table should name it.
6. **`packages/server/test/integration/functions/PORT.attribution.test.ts`** appears only in
   parts/TIER2.d; WORKPLAN WP-10 names `portfolio/analytics.test.ts` instead. Both are cited above.
7. **A machine-readable form of this file.** WORKPLAN §0.5 says TRACEABILITY.md "is generated from
   those citations" (inline `(REF-03)`-style comments in code and test names). No generator script is
   named in ARCHITECTURE's `scripts/` listing and none exists; this file is written by hand from the
   design corpus. If the generated form is wanted, `scripts/gen-traceability.ts` is an addition and
   needs a citation-comment convention that the ESLint config can enforce.

## Open questions

1. **Two test paths for the same test.** WORKPLAN §2 and TESTING §17 disagree on at least six files:
   `unit/plant/conflator.test.ts` vs `unit/ws/conflator.test.ts`; `unit/entitlements/evaluator.test.ts`
   vs `integration/entitlements/evaluator.test.ts`; `sdk/test/client/quoteCache.test.ts` vs
   `sdk/test/quoteCache.test.ts`; `core/test/analytics/options/bsm.test.ts` vs
   `core/test/analytics/bsm.test.ts`; `core/test/analytics/bond/{price,risk}.test.ts` vs
   `bond.price.test.ts` / `bond.risk.test.ts`; `web/test/grid/liveGrid.test.tsx` vs
   `web/test/grid/LiveGrid.flash.test.tsx`. Both spellings are cited above. One of the two documents
   must win before WP-02, WP-06, WP-07 and WP-13 create files, or four packages will write eight
   files where four were intended.
2. **Does a mechanism without a test count as implemented?** This file says no, which pushed MSG-04,
   MSG-06, SEC-04, REG-04..07, OPS-04, QA-06 and FEED-07 into `partial`. If the intended reading is
   "specified counts", six of those become implemented and the summary shifts by six rows. The
   stricter reading is used here because BRIEF §7 asks for test names.
3. **QA-03 offline (carried from TESTING §18.3).** Is a fixture-scale reconciliation test — a seeded
   1 % disagreement raising `dq_events.kind='cross_source_divergence'` — sufficient evidence for QA-03,
   or does it stay partial? This file keeps it partial.
4. **QA-04 / NFR-01 (carried from TESTING §18.4).** Accept NFR-01 as out of scope for v1, or add a
   throwaway load harness? This file keeps both partial rather than out of scope, because BRIEF §1
   does not list them and a partial row is the honest record of an unmeasured system.
5. **ANAL-09's independent implementation (carried from TESTING §18.5).** Is the closed-form +
   second-method pairing enough, or must external-library values be committed at fixture-capture time
   for the BSM and bond files? The answer decides whether ANAL-09 can ever become implemented.
6. **Is `realtime` reachable at all (carried from WORKPLAN §19.5)?** Every licence row caps at
   `exchange_delayed` or slower, so `policyTier.view(state,'realtime')` and the `NOT_ENTITLED_TIER` vs
   `SOURCE_TIER_CAP` distinction have no positive test case. BUS-06 is marked implemented on the
   delayed/EOD path; if the answer is "structurally unreachable", that should be stated in the licence
   registry seed rather than discovered by a failing test.
7. **Work-package numbering.** ARCHITECTURE §14 and WORKPLAN §2 both enumerate fourteen packages and
   assign **different numbers to the same work** (ARCHITECTURE's WP-02 is core ids/command; WORKPLAN's
   WP-02 is core analytics). Every `where` column above uses WORKPLAN numbering. One of the two tables
   should be corrected before agents cite a WP id in a commit message.
8. **Who owns the REG rows?** REG-03..07 are five partials whose gaps are legal or organisational
   (an assessment, an erasure test, a sanctions list, a residency policy). No work package owns them:
   WP-07 owns the compliance *code*, nobody owns the compliance *decisions*. They will stay partial
   through Wave 2 by default unless assigned.
