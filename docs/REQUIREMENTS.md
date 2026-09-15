# Rebuilding the Bloomberg Terminal — Engineering Requirements

_Converted from the scoping artifact. 158 requirements across 23 subsystems, grouped by four-letter function code._

## SCOPE — Product definition and the honest framing

Before requirements, the framing that determines whether any of them matter. The Terminal is not primarily a software artifact. It is a data-rights portfolio, a manually-curated reference database, and a closed communications network, with a keyboard-driven client attached. A developer can write the client. The rest is procurement, headcount and time.

> **What you cannot code your way around**
>
> - **Exchange and vendor licensing.** Redistributing real-time prices from ~350 venues requires a separately negotiated agreement, fee schedule and audit obligation per venue. Lead times run months to years; some venues will not license a startup at all.
> - **Manually-curated reference data.** Bloomberg's advantage in corporate actions, bond terms & conditions, ownership, supply chain and private-company data comes from a data-operations organisation of several thousand people entering and reconciling it by hand. There is no feed you can buy that replicates it.
> - **The network effect of IB.** The instant-messaging network is the stickiest component. A messaging product with zero counterparties on it has zero value, and that is a cold-start problem, not an engineering one.
> - **Trust in the number.** Users will not trade off your price until years of clean history prove it. Data-quality reputation is earned in calendar time and cannot be parallelised.

### Requirements

- **SCOPE-01** — Define the initial asset-class and geographic wedge explicitly. **Do not attempt global multi-asset coverage in v1.** A defensible wedge is one asset class (e.g. US corporate credit, or LatAm equities) where incumbent coverage is weakest.
- **SCOPE-02** — Define the target user persona down to the desk: buy-side PM, sell-side trader, credit analyst, corporate treasurer and economist have almost disjoint function requirements.
- **SCOPE-03** — Document explicit non-goals for v1. Recommended non-goals: order execution, sell-side research distribution, chat federation, mobile parity.
- **SCOPE-04** — Establish the competitive claim in one sentence — cheaper, better in one vertical, or open. “Bloomberg but everything” is not fundable.
- **SCOPE-05** — Ratify the build/buy line per subsystem. Reference-data vendors (ICE, LSEG, FactSet, S&P, SIX) can be resold under licence and will beat an in-house build for years. [Decision gate]

## DATA — Market data acquisition and licensing

The single largest line item in both cost and calendar. Start this workstream on day one, in parallel with everything else, because legal lead times dominate engineering lead times.

### Requirements

- **DATA-01** — Negotiate direct exchange agreements or aggregator licences for every venue in the v1 wedge. Distinguish **display use**, **non-display use**, **derived data** and **redistribution** — they are priced separately and audited separately. [Blocker]
- **DATA-02** — Implement per-venue usage reporting: exchanges require monthly declarations of entitled user counts, often per product and per data class, with the right to audit and to bill retroactively for under-reporting.
- **DATA-03** — Licence consolidated tapes where applicable (US SIPs: CTA/UTP for equities, OPRA for options) and evaluate direct feeds where latency or depth matters.
- **DATA-04** — Source fixed-income pricing. There is no exchange for most bonds — you need evaluated-pricing vendors, TRACE for US corporates/treasuries/agencies, MSRB EMMA for munis, and dealer-contributed runs.
- **DATA-05** — Source OTC derivatives and FX: interbank FX feeds, swap curves, SDR/DTCC trade repository data, ISDA definitions and CDS composites.
- **DATA-06** — Source fundamentals and filings: SEC EDGAR, non-US regulator filings, exchange disclosure portals, plus a standardised-fundamentals vendor. Raw filings alone are not usable — standardisation is the product.
- **DATA-07** — Source macroeconomic series: central banks, national statistics offices, IMF/World Bank/OECD/Eurostat, and commercial forecast panels for consensus estimates.
- **DATA-08** — Build a corporate-actions capability covering dividends, splits, mergers, tender offers, calls, conversions and capital restructurings, with pre-announcement and confirmed states. Budget for a manual review desk — automated extraction alone produces an unacceptable error rate.
- **DATA-09** — Maintain a machine-readable licence registry mapping every field in the system to its source, contractual permissions, redistribution rights and retention limits. Every downstream entitlement decision reads from it. [Regulatory]
- **DATA-10** — Implement source-level provenance on every stored value: which vendor, which message, which timestamp, which contract. Required for audits, disputes and vendor-contract renegotiation.

## FEED — Feed handlers and normalization

One handler per venue protocol, each a separate long-lived engineering commitment. Exchanges change message specs on a published schedule and you must be certified against the new spec before cutover.

### Requirements

- **FEED-01** — Implement protocol decoders for the binary formats in scope — Nasdaq ITCH, NYSE Pillar/XDP, CME MDP 3.0 (SBE), Eurex EOBI/EMDI, FIX/FAST, plus per-venue proprietary formats.
- **FEED-02** — Support UDP multicast ingest with sequence-gap detection, A/B line arbitration, retransmission requests and snapshot-channel recovery. Silent gap-fill is a correctness bug, not a feature.
- **FEED-03** — Normalize to a single internal instrument-and-quote model spanning quotes, trades, order-book deltas, auction imbalances, halts, and venue status. The normalization schema is the hardest irreversible design decision in the system. [Architecturally load-bearing]
- **FEED-04** — Maintain full-depth order books per venue with correct handling of implied orders, hidden liquidity, odd lots and price bands.
- **FEED-05** — Preserve three timestamps on every message: exchange-published, capture, and publication. Clock-sync to hardware time source; `ntpd` alone is inadequate for sub-millisecond attribution.
- **FEED-06** — Handle venue session lifecycle — pre-open, auctions, continuous trading, halts, LULD bands, circuit breakers, closing auction, post-close — per venue calendar and per instrument.
- **FEED-07** — Implement trade-condition and sale-condition handling so that last-price, VWAP and volume aggregates only include qualifying prints, per venue rules.
- **FEED-08** — Provide a deterministic replay harness: capture raw wire bytes and replay any trading session bit-exact for debugging and regression testing.
- **FEED-09** — Run hot-hot redundant handlers in at least two datacenters per venue with automatic arbitration on first-arrival.
- **FEED-10** — Budget for annual exchange conformance certification per venue, with a staging environment that connects to each exchange's test facility.

## REF — Security master and reference data

The unglamorous core. Every function in the product resolves through this layer, and every data-quality complaint you will ever receive traces back to it.

### Requirements

- **REF-01** — Build a security master keyed on an internal immutable identifier, cross-referenced to ISIN, CUSIP, SEDOL, FIGI, RIC, ticker+exchange, LEI and MIC. Never key on ticker — tickers are reused.
- **REF-02** — Model the issuer/issue/instrument/listing hierarchy correctly: one issuer may have many issues, one issue many listings, one listing many market-data lines.
- **REF-03** — Make every record **bitemporal** — valid time and transaction time. “What did we believe this bond's coupon was on 14 March, as of what we knew then?” must be answerable. [Cannot be retrofitted]
- **REF-04** — Capture fixed-income terms & conditions in full: coupon type and schedule, day count, business-day convention, call/put/sink schedules, amortisation, covenants, guarantors, seniority, collateral, make-whole provisions.
- **REF-05** — Capture derivatives contract specs: underlying, multiplier, tick size, expiry and settlement rules, exercise style, delivery, first notice date, roll conventions.
- **REF-06** — Maintain global calendars: exchange trading days, settlement calendars, currency holiday calendars, and the combination rules used by every analytic.
- **REF-07** — Maintain classification schemes (GICS, ICB, NAICS, SIC, internal sectors) and index constituents with historical membership and weights.
- **REF-08** — Maintain entity data: corporate hierarchies, ownership, subsidiaries, management, board, supply-chain relationships and private-company records.
- **REF-09** — Apply corporate actions to all historical series with a switchable adjustment policy (price-adjusted, total-return, unadjusted) computed on read, not baked in on write.
- **REF-10** — Staff and tool a data-operations function: exception queues, dual-key entry on high-impact fields, source-conflict resolution, and an SLA on correcting reported errors.

## BUS — Ticker plant and real-time distribution

### Requirements

- **BUS-01** — Build a ticker plant maintaining the current composite state of every instrument in memory, serving both snapshot-on-subscribe and subsequent deltas.
- **BUS-02** — Implement subject-based publish/subscribe with per-instrument and per-field-set granularity, so a client subscribing to last price does not receive full book.
- **BUS-03** — Implement **conflation**: a human watching a screen cannot perceive more than a few updates per second. Conflate per subscriber at a configurable rate, guaranteeing the latest value is never dropped. Without this the client is unusable on active names.
- **BUS-04** — Apply backpressure and slow-consumer handling: disconnect or downgrade rather than allowing one slow client to stall the plant.
- **BUS-05** — Support composite/consolidated views (best bid and offer across venues, consolidated volume) computed centrally with documented rules.
- **BUS-06** — Support delayed and end-of-day tiers, generated by a policy engine from the same source, since most users are only licensed for delayed data.
- **BUS-07** — Provide guaranteed recovery: if a client disconnects, reconnect must resynchronise to a correct snapshot without gaps or duplicate application of deltas.
- **BUS-08** — Support at least 10,000 concurrent subscriptions per client session and tens of millions of active subscriptions per plant.

## STOR — Storage architecture

Four distinct stores with genuinely different access patterns. Attempting to serve all four from one database is a common and expensive early mistake.

### Requirements

- **STOR-01** — Tick store: append-only, column-oriented, partitioned by date and instrument, capable of ingesting the full firehose and serving arbitrary historical windows. Expect petabyte scale at full global coverage.
- **STOR-02** — Time-series store for bars, fundamentals, economics and analytics outputs, with native bitemporal query support and point-in-time restatement history.
- **STOR-03** — Reference/entity store: relational, strongly-constrained, fully audited, the system of record for the security master.
- **STOR-04** — Document and search store for news, filings, research and transcripts with full-text and vector search.
- **STOR-05** — Implement tiered retention: hot in-memory (today), warm SSD (weeks), cold object storage (years), with query transparency across tiers.
- **STOR-06** — Guarantee **point-in-time correctness** for all backtest-facing reads. Serving restated fundamentals as if they were known historically silently invalidates every customer backtest. [Correctness]
- **STOR-07** — Enforce retention and deletion policies per source contract — some vendors prohibit storing history beyond a stated window.

## ENTL — Entitlements and permissioning

### Requirements

- **ENTL-01** — Enforce entitlements at the data layer, evaluated per user, per instrument, per field, per latency tier, per usage type. Client-side filtering is a licence breach waiting to be found in an audit. [Regulatory]
- **ENTL-02** — Model entitlements as the intersection of the user's subscription, their firm's contract, and each venue's own permissioning rules.
- **ENTL-03** — Bind licences to a natural person, not a seat or a device. Exchange contracts price per individual and prohibit sharing; detection of concurrent use is expected of you.
- **ENTL-04** — Log every data access with user, instrument, field, timestamp and purpose, retained for the audit window in every vendor contract.
- **ENTL-05** — Support automatic downgrade: an unentitled real-time request returns delayed or blank with a clear reason code, never a stale value.
- **ENTL-06** — Generate per-venue monthly usage declarations directly from the access log, with reconciliation against billing.

## TERM — The terminal client

The interaction model is the product's identity and the reason users tolerate a forty-year-old aesthetic. It is optimised for one thing: an expert who knows what they want reaching it in under a second without touching a mouse.

### Requirements

- **TERM-01** — Implement the **mnemonic command line** as the primary navigation surface: `<TICKER> <MARKET SECTOR> <FUNCTION> <GO>`. Everything reachable by menu must also be reachable by typed code.
- **TERM-02** — Implement autocomplete that resolves partial and ambiguous input against instruments, functions, people and topics in a single ranked list, updating per keystroke.
- **TERM-03** — Maintain per-user context so that entering a function code alone applies it to the currently loaded security, and entering a security alone reloads the current function.
- **TERM-04** — Support four (or more) independent panels per session, each with its own command line, history and back-stack, sharing a single authenticated connection.
- **TERM-05** — Persist full workspace layout server-side: panel arrangement, loaded functions, monitor layouts, watchlists, chart settings. A user logging in from any machine gets their desk back.
- **TERM-06** — Make the client fully keyboard-operable, including every grid, dialog, chart and form. Mouse-only affordances are defects.
- **TERM-07** — Provide dedicated action keys — GO, CANCEL, MENU, HELP, PRINT, PAGE FWD/BACK — mapped to physical keys and to on-screen equivalents. Custom hardware keyboards are optional; the key semantics are not.
- **TERM-08** — Build a high-density real-time grid component rendering thousands of live cells with per-cell flash-on-change, sortable and groupable, without dropping frames. This component will consume more engineering time than expected. [High effort]
- **TERM-09** — Implement `HELP` semantics: one press explains the current screen, two presses opens a ticket to a live human analyst. 24/7 staffed support is part of the product, not an add-on.
- **TERM-10** — Support multi-monitor operation with independent OS-level windows, per-monitor DPI, and layout restoration on reconnect.
- **TERM-11** — Design for information density over whitespace, with a legible-at-density type stack and colour used semantically (up/down, entitled/blocked, stale/live) rather than decoratively.
- **TERM-12** — Render every value with explicit staleness state. A number that silently stops updating is worse than no number. [Correctness]
- **TERM-13** — Ship a thin-client or browser variant for locked-down enterprise desktops, with feature parity on the top 50 functions.

## FUNC — Function catalog and build order

Bloomberg exposes on the order of 30,000 functions. Roughly 200 account for the overwhelming majority of use. Build in strict priority order and instrument usage from day one so the tail is prioritised by evidence rather than opinion.

**Minimum viable function set, by tier**

| Code | Function | Notes on scope |
| --- | --- | --- |
| **Tier 1 — a terminal is not credible without these** | | |
| DES | Security description | Canonical landing screen per instrument; differs entirely by asset class. |
| GP | Price graph | Intraday to multi-decade, overlays, events, multi-security. |
| HP | Historical price table | Any periodicity, any adjustment basis, exportable. |
| Q / QM | Quote / quote monitor | Live composite and per-venue quote with depth. |
| W | Watchlists | User-defined, shareable, with computed columns. |
| TOP / N | Top news / news search | Ranked headline feed with instrument and topic filters. |
| MSG / IB | Messaging and chat | Compliant person-to-person and room messaging. |
| WEI | World equity indices | Global market monitor, the default morning screen. |
| **Tier 2 — required for analyst and PM workflows** | | |
| FA | Financial analysis | Standardised statements, ratios, segments, as-reported toggle. |
| EE | Earnings estimates | Consensus, dispersion, revisions, surprise history. |
| EQS | Equity screening | Arbitrary multi-factor screens over the full universe. |
| RV | Relative valuation | Peer-set construction plus comparative multiples. |
| CN / CACS | Company news & corporate actions | Event timeline with confirmed/estimated states. |
| ECO | Economic calendar | Releases, consensus, actual, revisions, by country. |
| PORT | Portfolio analytics | Attribution, exposure, tracking error, scenarios. |
| HDS / MEMB | Holders and index members | Ownership and constituent analysis with history. |
| **Tier 3 — asset-class depth, where the moat actually is** | | |
| YAS | Yield and spread analysis | Bond pricing across yield, spread, price and Z-spread. |
| SWPM | Swap manager | Multi-curve swap pricing and structuring. |
| OVML | Option valuation | Vanilla and exotic pricing with full greeks. |
| CRVF / ICVS | Curve construction | Bootstrapped and multi-curve frameworks by currency. |
| SRCH | Fixed-income search | Screening across the full bond universe by T&C. |
| WIRP | Rate probability | Implied central-bank path from futures and OIS. |
| MA / LEAG | M&A and league tables | Deal database with role and fee attribution. |

### Requirements

- **FUNC-01** — Build functions on a shared internal framework — a function is a declared screen with a data contract, not a bespoke application. Without this, function 300 costs the same as function 3.
- **FUNC-02** — Make every function polymorphic by asset class: `DES` on an equity, a bond, a swap and a fund are four different screens behind one code.
- **FUNC-03** — Every function must support export to Excel and CSV with the same numbers the screen shows, including entitlement checks on export.
- **FUNC-04** — Instrument every function launch, parameter change and export so the roadmap is driven by measured usage.

## CHRT — Charting and technical analysis

### Requirements

- **CHRT-01** — Render tick, bar, candle, line, area, mountain, OHLC, point-and-figure, market-profile and heatmap chart types over arbitrary ranges.
- **CHRT-02** — Stream live updates into a chart holding millions of points without re-rendering the full series; GPU-accelerated canvas rendering required.
- **CHRT-03** — Support multi-security overlays with independent axes, normalisation bases, currency conversion and correct alignment of differing trading calendars.
- **CHRT-04** — Ship ~100 standard technical studies, each parameterised and stackable in linked sub-panes.
- **CHRT-05** — Support persistent annotations — trendlines, Fibonacci, text, regression channels — anchored to data coordinates and shareable between users.
- **CHRT-06** — Overlay event markers: earnings, dividends, splits, news, ratings, index adds/drops, with click-through to the source function.
- **CHRT-07** — Provide a formula language for computed series (spreads, ratios, custom baskets) usable anywhere a security can be entered.

## ANAL — Analytics and pricing engines

These must be numerically correct, independently validated, and identical across screen, API and Excel. A discrepancy of one basis point between two surfaces of your own product destroys credibility permanently.

### Requirements

- **ANAL-01** — Fixed income: price/yield conversion, accrued interest, all major day-count and business-day conventions, duration, convexity, DV01, key-rate durations, OAS with a term-structure model for callables.
- **ANAL-02** — Curve construction: deposit/futures/swap bootstrapping, OIS discounting, multi-curve frameworks, cross-currency basis, and configurable interpolation.
- **ANAL-03** — Derivatives: Black-Scholes-Merton, Black-76, binomial/trinomial trees, Monte Carlo with variance reduction, PDE solvers for path-dependence, and full greeks.
- **ANAL-04** — Volatility surfaces: construction from listed option chains, arbitrage-free smoothing, SABR or SVI parameterisation, and historical surface storage.
- **ANAL-05** — Credit: CDS bootstrapping to hazard rates, ISDA standard model conformance, recovery assumptions, and structured-product cashflow waterfalls.
- **ANAL-06** — Structured finance: ABS/MBS/CLO cashflow engines with prepayment and default vectors, deal-specific waterfall logic, and loan-level tape ingestion.
- **ANAL-07** — Statistics: returns, volatility, correlation, beta, factor regression, drawdown, Sharpe/Sortino/information ratio, with explicit and consistent conventions.
- **ANAL-08** — Every engine must expose its full input set and be reproducible: given the same inputs and valuation timestamp, the same output, forever. [Correctness]
- **ANAL-09** — Validate all engines against published benchmark cases and an independent implementation before release. Maintain a regression suite of priced instruments with expected values.

## PORT — Portfolio and risk

### Requirements

- **PORT-01** — Ingest client portfolios by upload, scheduled file drop, custodian/administrator feed and API, with position-level reconciliation and error reporting.
- **PORT-02** — Support multi-asset, multi-currency portfolios with lot-level cost basis, accruals, cash, and derivatives exposure modelling.
- **PORT-03** — Compute performance attribution: Brinson sector/security, fixed-income attribution by curve/spread/carry, and currency attribution.
- **PORT-04** — Provide multi-factor risk models with tracking error, factor exposures, marginal and component contribution to risk.
- **PORT-05** — Provide scenario and stress analysis: parallel and non-parallel curve shifts, spread widening, equity shocks, FX moves, and historical-episode replays.
- **PORT-06** — Compute VaR by historical, parametric and Monte Carlo methods with documented assumptions and backtesting of exceptions.
- **PORT-07** — Treat all client portfolio data as strictly confidential and tenant-isolated. Any perception that holdings are visible to the vendor, or inferable from its other products, is existential. [Existential]

## NEWS — News, research and documents

### Requirements

- **NEWS-01** — Aggregate wire feeds, licensed publishers, regulatory disclosure services, press-release distributors and web sources into a single normalised stream.
- **NEWS-02** — Perform entity resolution on every story, linking it to security-master identifiers, people and topics, with precision prioritised over recall.
- **NEWS-03** — Deliver headline latency of under one second from publisher receipt to user screen for market-moving wires.
- **NEWS-04** — Ingest, parse and index regulatory filings, extracting structured financials with human review on the extraction exception queue.
- **NEWS-05** — Ingest earnings-call audio and transcripts with speaker attribution, timestamped text and searchable archive.
- **NEWS-06** — Support sell-side research distribution with per-publisher entitlements, since research access is contractual and asymmetric.
- **NEWS-07** — Provide saved searches and alerting with user-defined triggers on news, prices, filings and calendar events, delivered in-app, by email and by push.
- **NEWS-08** — Where language models summarise or extract, cite the source passage and mark output as machine-generated. Never allow a generated number to enter the same visual hierarchy as a sourced one. [Trust]

## MSG — Messaging and the network

Commercially the most valuable subsystem and technically among the simplest. Plan the go-to-market for it, not the architecture.

### Requirements

- **MSG-01** — Provide person-to-person and multi-party chat with a verified global directory of users, firms and desk roles.
- **MSG-02** — Archive every message immutably in WORM-compliant storage with supervisory review queues, lexicon-based surveillance and legal hold. [SEC 17a-4 / FINRA 3110]
- **MSG-03** — Support firm-level compliance policy: retention periods, permitted counterparties, disclaimers, ethical walls between desks.
- **MSG-04** — Support inline sharing of securities, charts, portfolios and functions that render live in the recipient's client within their own entitlements.
- **MSG-05** — Evaluate federation to existing networks (Symphony, Microsoft Teams, ICE Chat). Federating concedes the network effect but is the only realistic cold-start answer. [Strategic]
- **MSG-06** — Support structured trade-negotiation messages parseable into order tickets where execution is in scope.

## API — Data APIs and desktop integration

For most quantitative users, the API is the product and the terminal UI is the licence check. Treat it as a first-class surface, not an export feature.

### Requirements

- **API-01** — Provide a desktop API bound to the logged-in user's entitlements, plus a server-side API for unattended enterprise use, licensed and priced separately.
- **API-02** — Expose reference-data, historical-data, intraday-bar, tick and real-time subscription request types under one consistent request/response model.
- **API-03** — Ship maintained client libraries for Python, R, Java, C++, C# and JavaScript, with a stable field dictionary and deprecation policy.
- **API-04** — Ship an Excel add-in with live-updating worksheet formulas, an array/bulk-data form, and a formula builder. Excel is where the work is actually done.
- **API-05** — Guarantee that a field returns an identical value via terminal, API and Excel at the same valuation timestamp. [Correctness]
- **API-06** — Implement per-user quotas on daily unique securities, monthly data points and concurrent subscriptions, enforced server-side with clear limit errors.
- **API-07** — Publish a complete, versioned field dictionary with definitions, units, source, update frequency and worked examples.

## EXEC — Order and execution management

Optional in v1, and recommended as a non-goal. Adding execution converts the company from a data vendor into a regulated financial entity in every jurisdiction it operates in.

### Requirements

- **EXEC-01** — Obtain the required registrations before writing code — broker-dealer, ATS, MTF, or the local equivalent, per jurisdiction. [Regulatory]
- **EXEC-02** — Implement FIX connectivity to brokers and venues with per-counterparty session management, certification and drop-copy.
- **EXEC-03** — Implement a full order lifecycle — staging, routing, amendment, cancellation, partial fills, allocation and settlement instruction — with an immutable audit trail.
- **EXEC-04** — Implement pre-trade risk controls: fat-finger limits, notional and position limits, restricted lists, kill switch. [SEC 15c3-5]
- **EXEC-05** — Produce best-execution analysis and regulatory reporting to the standard required in each jurisdiction.
- **EXEC-06** — Maintain the order audit trail in the prescribed format and retention window (e.g. CAT in the US).

## SEC — Identity and security

### Requirements

- **SEC-01** — Bind every account to a verified individual with documented onboarding, and support enterprise SSO/SCIM for provisioning and immediate deprovisioning.
- **SEC-02** — Require phishing-resistant multi-factor authentication. Bloomberg's B-Unit performs biometric plus possession verification; FIDO2/WebAuthn with a hardware authenticator is the modern equivalent and is sufficient.
- **SEC-03** — Detect and block concurrent sessions and credential sharing, since per-person licensing is contractually mandated by data sources.
- **SEC-04** — Encrypt in transit (TLS 1.3, mutual TLS for enterprise links) and at rest, with customer-managed keys available for portfolio data.
- **SEC-05** — Enforce strict tenant isolation for all client-supplied data, with tested controls, not merely a `tenant_id` column.
- **SEC-06** — Maintain internal ethical walls between any news organisation and the client-data platform, with technical enforcement and documented policy. Bloomberg's 2013 reporter-access incident is the case study; assume clients will ask about it.
- **SEC-07** — Obtain SOC 2 Type II and ISO 27001. Enterprise procurement will not proceed without them. Run annual penetration tests and a vulnerability disclosure programme. [Sales blocker]

## REG — Regulatory and compliance obligations

### Requirements

- **REG-01** — Meet books-and-records and communications retention requirements in every jurisdiction served, in non-rewriteable non-erasable form with prompt production on request. [SEC 17a-3/17a-4]
- **REG-02** — Where benchmarks or indices are published, comply with the applicable benchmark regulation, including governance, methodology publication and administrator authorisation. [EU BMR]
- **REG-03** — Where credit ratings or evaluated prices are produced, assess whether rating-agency or pricing-service registration applies.
- **REG-04** — Comply with GDPR, CCPA and equivalents for all personal data, including the entity database, with lawful basis documented per field. [Privacy]
- **REG-05** — Implement market-abuse controls covering the handling and dissemination of inside information across news, chat and research. [MAR]
- **REG-06** — Screen all users and entities against sanctions lists (OFAC, EU, UN, UK) at onboarding and continuously.
- **REG-07** — Meet data-residency requirements where clients or regulators mandate in-country storage and processing.
- **REG-08** — Where the service becomes material to clients' operations, expect designation as a critical third party and the operational-resilience obligations that follow. [DORA / FCA CTP]

## NFR — Performance and scale targets

Targets a professional user will notice being missed. These are service objectives for the full path, not micro-benchmarks.

**Latency and capacity budget**

| Path | Target | Measured as |
| --- | --- | --- |
| Feed handler: wire to normalized | < 100 µs p99 | Per venue, hardware-timestamped |
| Ticker plant: ingest to publish | < 1 ms p99 | In-datacenter |
| Plant to client screen | < 50 ms p99 | Same region, excludes client WAN tail |
| Keystroke to visual feedback | < 16 ms | One frame at 60 Hz |
| Autocomplete result set | < 80 ms p95 | Per keystroke, full universe |
| Function launch to first paint | < 500 ms p95 | Cold context, Tier 1 functions |
| Historical query, 1 yr daily bars | < 200 ms p95 | Single security |
| Tick query, one session, one name | < 2 s p95 | Full depth |
| News wire to headline on screen | < 1 s p95 | From publisher receipt |
| Peak ingest, consolidated US options | 10–100M msg/s | OPRA peak-rate guidance, sized ahead |
| Concurrent subscriptions per plant | > 10M | Active, post-conflation |
| Platform availability, market hours | 99.99% | Regional, excluding venue outages |

### Requirements

- **NFR-01** — Size capacity against **peak** message rates, not average. The ratio between a quiet afternoon and an FOMC release or an index rebalance close exceeds 100×.
- **NFR-02** — Degrade gracefully under overload: widen conflation, shed non-essential subscriptions, preserve last-price correctness. Never drop silently.
- **NFR-03** — Deploy points of presence near major financial centres — NY/NJ, Chicago, London, Frankfurt, Tokyo, Hong Kong, Singapore, São Paulo — and route users to the nearest.

## OPS — Operations and resilience

### Requirements

- **OPS-01** — Run 24×6 follow-the-sun operations. Markets are open somewhere for almost the entire week and a maintenance window that suits New York breaks Tokyo.
- **OPS-02** — Deploy without disconnecting users: rolling upgrades, client version negotiation, and backward-compatible wire protocols across at least two versions.
- **OPS-03** — Monitor data quality as a first-class signal: stale-tick detection, cross-source price divergence, missing-close alarms, field-population rates, and per-venue message-rate anomaly detection.
- **OPS-04** — Provide a status page and proactive incident communication. Clients discovering a data outage before you do is a renewal risk.
- **OPS-05** — Maintain a documented, regularly exercised disaster-recovery plan with a market-hours RTO measured in minutes, plus annual industry-wide DR test participation.
- **OPS-06** — Staff a 24/7 analyst helpdesk. A significant share of perceived product quality is how fast a human answers a question about a number.
- **OPS-07** — Maintain full distributed tracing from client keystroke through to data source, so “why is this number wrong?” is answerable in minutes.

## QA — Testing and data quality assurance

### Requirements

- **QA-01** — Maintain a golden-dataset regression suite: known instruments with known correct analytics at known valuation dates, run on every build.
- **QA-02** — Replay captured production sessions against every release candidate and diff all outputs. Any unexplained diff blocks release.
- **QA-03** — Reconcile continuously against at least one independent data source and alert on divergence beyond tolerance, per asset class.
- **QA-04** — Load-test at peak-day rates plus a safety factor before each market-structure event with known volume implications.
- **QA-05** — Fuzz all feed decoders. Malformed or out-of-spec exchange messages occur in production and must never crash a handler.
- **QA-06** — Track a public data-quality SLA with measured error rates and correction turnaround, reported to clients.

## BIZ — Cost, staffing and the incumbent's shape

Orders of magnitude for planning. Treat every figure as an estimate requiring direct quotes before it enters a business case.

**Planning envelope**

| Dimension | Order of magnitude |
| --- | --- |
| Incumbent seat price | Roughly $30k per user per year, minimal discounting |
| Incumbent installed base | Approximately 350,000 seats |
| Incumbent annual revenue | Around $13 billion |
| Incumbent engineering + data staff | Thousands of engineers, plus a comparably large manual data-operations organisation |
| Incumbent head start | Continuous development since 1981; first terminals shipped 1982 |
| Your data licensing, narrow wedge | Low seven figures per year |
| Your data licensing, broad global coverage | Eight figures per year and upward |
| Engineering team for a credible v1 wedge | 40–80 people across feeds, platform, client, analytics, data ops |
| Time to a credible single-vertical product | 24–36 months |
| Time to anything resembling parity | Not achievable by a startup; assume never, and compete on a wedge |

### Requirements

- **BIZ-01** — Budget data licensing as a recurring cost of goods sold that scales with seats, not as a fixed platform cost. It will dominate gross margin.
- **BIZ-02** — Hire domain specialists, not only engineers. A team that has never priced a callable bond will ship a plausible and wrong `YAS`.
- **BIZ-03** — Staff data operations from the beginning. The ratio of data-ops to engineering at a mature vendor is closer to 1:1 than to 1:10.
- **BIZ-04** — Plan a sales motion for a compliance-gated enterprise purchase: 6–18 month cycles, security review, procurement, and a trial on real portfolios.

## PLAN — Phased delivery

A genuine sequence, where each phase is gated on the previous one being in production with real users. The licensing workstream runs continuously from Phase 0 and is the critical path throughout.

> **The one-line version**
>
> The buildable part of this specification is roughly a quarter of the problem. Sections TERM, FUNC, CHRT and API are conventional, difficult, well-understood software engineering, and a strong team of forty can ship them in two years.
> Sections DATA, REF and MSG are not engineering problems. They are a licensing portfolio, a permanent manual-curation organisation, and a two-sided network. Those are what the incumbent actually sells, and they are why every well-funded attempt at this over the last two decades has ended up competing on a single vertical rather than on the terminal itself.
> Plan accordingly: build the wedge, buy the reference data, and treat the Terminal's UI as the easy part — because it is.

**Build sequence**

| Phase | Focus | Duration | Exit criteria |
| --- | --- | --- | --- |
| 0 | Licensing and wedge definition | 3–6 mo | Signed agreements for the v1 venue set; wedge and persona ratified; build/buy line fixed. |
| 1 | Data spine | 6–9 mo | Security master, bitemporal store, two feed handlers in production, corporate actions applied correctly, reconciliation against an independent source passing. |
| 2 | Terminal and Tier 1 functions | 6–9 mo | Mnemonic command line, four-panel client, entitlements enforced server-side, Tier 1 catalog live, API and Excel add-in shipping identical numbers. |
| 3 | Depth in the wedge | 9–12 mo | Tier 2 and the asset-class-specific Tier 3 functions; analytics independently validated; SOC 2 Type II awarded; first paying desks in production. |
| 4 | Network and expansion | 12 mo+ | Compliant messaging with federation, portfolio and risk, second asset class or region, data-quality SLA published. |
