# CLIENT — terminal client design (`packages/web`, `@terminal/web`)

This is the binding design for the browser terminal client of the clone described in
[BRIEF.md](./BRIEF.md) and [REQUIREMENTS.md](./REQUIREMENTS.md). It agrees by name with
[ARCHITECTURE.md](./ARCHITECTURE.md) (§3.4 module list, §5 keystroke lifecycle, §6.6 client real-time
path, §15 decisions), [API.md](./API.md) (§5.7 `WorkspaceLayout`, §6 WS frames, §10 `TerminalClient`,
`LiveClient`, `QuoteView`) and [FUNCTIONS.md](./FUNCTIONS.md) (§1.5 `ScreenSpec`/`Node`/`Cell`/`ChartSpec`,
§2.5 context rules, §2.6 reserved keys, §3 autocomplete, §4 HELP). It merges the client material of the
three candidates under `docs/design/candidate-{A,B,C}/`: the local universe index, uncontrolled command
line and chart key vocabulary from B; the DOM cell registry, rAF coalescing and staleness ticker from A
and C; the `essential`/`shed` viewport contract from C. Where they disagreed the choice is in §17.

Design rule (ARCHITECTURE §0): **a number exists once.** The client never computes a market value, never
formats a number outside `core/fields/format.ts`, never serialises a CSV, never filters an entitlement,
and never opens a socket or fetch of its own: every byte it shows arrived through `@terminal/sdk`
(ARCHITECTURE §1.1, API-05). The client's job is the interaction model: keyboard-first navigation
(TERM-01, TERM-06, TERM-07), four independent panels on one connection (TERM-04), a live grid and a
chart that stay under one frame per update (TERM-08, CHRT-02), and honest rendering of staleness and
entitlement state on every value (TERM-11, TERM-12, ENTL-05).

| Item | Value |
| --- | --- |
| Stack | Vite 8, React 19.3, zustand 5, TypeScript 5.9 strict, `@terminal/sdk` (peer `@terminal/core`); no chart or grid library (BRIEF §3) |
| Entry | `packages/web/index.html` → `src/main.tsx`; dev server `:5173` proxies `/api` → `:8080` and `/ws` → `ws://:8080` (ARCHITECTURE §12) |
| Client version | `web/<semver>` from `package.json`, sent as `x-client-version` and `hello.client` (API.md §11) |
| Fonts | self-hosted IBM Plex Mono woff2 under `public/fonts/` (no external font hosts in the CSP) |
| Owners | WP-11 (shell, keyboard, command, state, screen renderer), WP-12 (grid, rt, SDK client), WP-13 (chart), WP-10 (screens per function), WP-14 (e2e) — ARCHITECTURE §14 |
| Sections | §1 tree · §2 bootstrap · §3 shell · §4 command line & autocomplete · §5 keyboard · §6 context rules · §7 workspace · §8 state · §9 real-time bridge · §10 LiveGrid · §11 chart · §12 staleness, colour, type · §13 CSV · §14 errors & entitlement · §15 HELP · §16 performance · §17 decisions · §18 open questions |

---

## 1. Directory tree — `packages/web`

Every file below exists; a file not listed here is not part of the client. Paths named in
ARCHITECTURE §3.4 are kept verbatim; this tree refines them.

```
packages/web/
  index.html                          <div id="root">, <meta name="color-scheme">, preload of IBMPlexMono-Regular.woff2
  vite.config.ts                      proxy /api → http://localhost:8080, /ws → ws://localhost:8080; worker plugin; manualChunks: sdk, chart, grid
  package.json                        name @terminal/web; deps: @terminal/sdk, @terminal/core, react, react-dom, zustand
  tsconfig.json                       references: ../core, ../sdk; lib ["ES2022","DOM","DOM.Iterable","WebWorker"]
  public/fonts/IBMPlexMono-{Regular,Medium,SemiBold}.woff2
  src/
    main.tsx                          createRoot; installs keyboard dispatcher; mounts <App/>
    App.tsx                           session gate → <Login/> | <Shell/>; workspace load; version banner
    bootstrap/
      client.ts                       ONE createClient({ baseUrl: location.origin, clientVersion, conflationMs, onTrace, onVersion }) (API.md §10)
      session.ts                      sessionStore hydration from GET /auth/session; MFA gate; supersede handling
      login/Login.tsx                 email+password form, WebAuthn button; keyboard-only operable (Tab/Enter)
      deviceId.ts                     stable deviceId in localStorage ('terminal.deviceId'), deviceLabel from UA
    shell/
      Shell.tsx                       <PanelGrid/> + <StatusBar/> + <KeyBar/> + overlays root; owns the leader/WS lifecycle mount
      PanelGrid.tsx                   CSS grid for mode '1'|'2h'|'2v'|'4' (+ '8' when windows split, §7.4); focus ring
      Panel.tsx                       one panel: <PanelHeader/> <CommandLine/> <Autocomplete/> <ScreenHost/> <PanelFooter/>
      PanelHeader.tsx                 'p1 · DES · AAPL US Equity · Apple Inc' + tier badge + staleness badge + trace id (dimmed)
      PanelFooter.tsx                 attribution strip (ScreenSpec.footer), last error line, key hints of the focused node
      ScreenHost.tsx                  lazy-loads screens/<CODE>/Screen.tsx; builds ScreenProps; renders skeleton while loading
      CommandLine.tsx                 uncontrolled <input>; history (↑/↓); yellow-key insertion; typing-anywhere target
      Autocomplete.tsx                popup ≤ 12 rows; aria-listbox; row 0 = parse()[0]
      AutocompleteRow.tsx             memo(row): primary with `matched` highlight, secondary, kind glyph, tier badge, dim + reason, yahoo badge
      StatusBar.tsx                   connection state, conflation ms, staleness legend, quotas, sys:status sessions, clock, version badge
      KeyBar.tsx                      on-screen action keys GO CANCEL MENU HELP PRINT PGUP PGDN + yellow keys (TERM-07 guaranteed path)
      HelpOverlay.tsx                 HELP ×1 (FUNCTIONS §4)
      TicketDialog.tsx                HELP ×2 (FUNCTIONS §4)
      ProvenancePanel.tsx             Ctrl+I: meta.provenance[provIdx] + licence terms + request key (DATA-10)
      PromptDialog.tsx                ScreenCtx.prompt(): modal typeahead for security | date | text | field | watchlist
      Toast.tsx                       transient notices (downgrade, slow-consumer, superseded, reload)
      layouts.ts                      mode → grid-template-areas; panel visibility per mode
    keyboard/
      keys.ts                         KeyCombo type; parse('Ctrl+Shift+ArrowUp'); match(e: KeyboardEvent, combo) on KeyboardEvent.code
      keymap.ts                       RESERVED global bindings (FUNCTIONS §2.6) + region maps (grid, list, form, chart, dialog) — §5
      dispatcher.ts                   single window keydown listener; resolution order §5.1; typing-anywhere routing
      focus.ts                        FocusRegion model: panel → node ids in document order; roving tabindex; restore on frame change
    command/
      localIndex.ts                   loads /universe/snapshot (ETag), IndexedDB 'terminal.universe', swaps UniverseIndex from the worker
      indexWorker.ts                  Worker: builds core UniverseIndex from the snapshot tuples (< 300 ms)
      dispatch.ts                     ParsedCommand → panel action; TERM-03 rules; frame push; traceId; fn.launch event
      history.ts                      per-panel history ring (≤ 100), ↑/↓ recall, prefix filter
      mru.ts                          localStorage 'terminal.mru' (≤ 50), rebuilt from workspace history (FUNCTIONS §3.1)
    state/
      store.ts                        createStore helper: zustand create + subscribeWithSelector + devtools name
      session.ts panels.ts workspace.ts subscriptions.ts settings.ts usage.ts     §8
    rt/
      wsBridge.ts                     LiveClient events → cellRegistry / chart streaming / list prepend; status & downgrade handling
      leader.ts                       multi-window: Web Locks leader holds the WS; BroadcastChannel 'terminal.rt' relay (§7.4)
      stalenessTicker.ts              1 s: quoteCache.sweep(now) → cellRegistry.restyle(subjects) (TERM-12)
      conflation.ts                   effective conflation = min(LiveSpec.conflationMs of visible screens, workspace.conflationMs)
    screen/
      types.ts                        ScreenProps, ScreenCtx, ScreenSpec, Node, Cell, GridColumn, GridRow, FormField, Badge (FUNCTIONS §1.5, verbatim)
      ScreenRenderer.tsx              Node → widget; keyboard operability contract §5.4; registers Cell.live with cellRegistry
      liveView.ts                     LiveView over sdk quoteCache + payload cells
      nodeFocus.ts                    node registry per panel; focus(nodeId); document-order traversal
      customRegistry.ts               'PriceChart'|'CurveChart'|'OptionSurface'|'Sparkline'|'Composer' → component
      custom/Composer.tsx             MSG composer (textarea + attachment picker); the only place printable keys are not routed to the command line besides forms
      widgets/
        Split.tsx KeyValue.tsx Grid.tsx Table.tsx Chart.tsx Tabs.tsx Form.tsx Text.tsx List.tsx Badges.tsx Custom.tsx
        CellView.tsx                  renders one Cell: format(), state class, '—' + reason tooltip, dir arrow, command affordance
    grid/
      types.ts                        LiveGridProps, GridApi, RowKey, VisibleRow, CellRef, ChangeBatch
      LiveGrid.tsx                    React shell: header, body viewport, group rows, selection, keyboard; cells are refs
      GridModel.ts                    rows, sort, group → flat VisibleRow[]; pure; unit-tested
      virtualiser.ts                  fixed row height; visible window + overscan 10; essential set diffing
      cellRegistry.ts                 Map<subject, Map<fieldId, CellRef>>; apply(changes) coalesced to one rAF; sweep(states)
      flash.ts                        change → direction → class toggle; animationend cleanup; batch cap per frame
      sort.ts                         comparators per fmt; live re-sort throttle (1 000 ms)
      group.ts                        groupBy → header rows with count + per-column agg
      keyboard.ts                     grid region bindings (§5.3)
      columns.ts                      width resolution (ch units by fmt), frozen columns, column picker model
    chart/
      spec.ts                         ChartSpec, ChartSeries, SeriesType (FUNCTIONS §1.5, verbatim) + ChartState, Viewport
      ChartCanvas.tsx                 React shell: two <canvas> (base, overlay), ResizeObserver, DPR, focus, keymap → engine
      renderer.ts                     Renderer: layout(panes, axes) → draw(base) / drawOverlay(); dirty flags
      scales.ts                       TimeScale (calendar-compressed), TenorScale, CategoryScale, LinearScale, LogScale
      tradingDayIndex.ts              union of series timestamps → contiguous slot index (CHRT-03 calendar alignment)
      layers.ts                       Layer interface; GridLayer, AxisLayer, SeriesLayer, StudyLayer, EventLayer, AnnotationLayer, ReferenceLayer, CrosshairLayer, LegendLayer
      series.ts                       draw routines: line, area, mountain, candle, ohlc, bar, step, scatter, tick, pnf, profile, heatmap
      downsample.ts                   M4 per-pixel-column reduction for line/area; min/max/first/last for bars
      streaming.ts                    apply(UpdateEvent) → append-forming-bar | replace-last; partial redraw of the last slot
      events.ts                       event markers: placement, hit test, focus cycling, click-through command (CHRT-06)
      annotations.ts                  draw + keyboard draw mode + persistence via sdk.workspace.annotations (CHRT-05)
      crosshair.ts                    keyboard crosshair (slot index), readout, snap to nearest series point
      hitTest.ts                      pixel → slot/series/marker/annotation
      keyboard.ts                     chart region bindings (§5.3)
      legend.ts                       series/study legend with last values, colours, axis side
      studies/
        types.ts                      StudyDef, StudyInput, StudyOutput, StudyRegistry
        index.ts                      registry of the 22 studies of §11.6
        sma.ts ema.ts wma.ts bb.ts rsi.ts macd.ts stoch.ts atr.ts vwap.ts obv.ts roc.ts mom.ts cci.ts willr.ts adx.ts psar.ts ichimoku.ts donchian.ts keltner.ts vol.ts stddev.ts hvol.ts
      custom/
        PriceChart.tsx                GP/GIP custom node: ChartCanvas + range row + type/adjust/normalise badges + pickers
        CurveChart.tsx                CRVF/GC/ICVS: tenor axis, multiple dates, bp-change table
        OptionSurface.tsx             OMON smile / OVML scenario grid as heatmap + line
        Sparkline.tsx                 inline mini line (WEI, W) — same renderer, no axes
    screens/
      <CODE>/Screen.tsx               one per FUNCTIONS §6 code (38); variant branches per FUNCTIONS §1.9
      index.ts                        GENERATED by scripts/gen-function-index.ts: lazy import() per screen
    export/
      csv.ts                          PRINT → sdk.fn.csvUrl({ resultId }) → navigate; Ctrl+E → POST /data/csv text → save (§13)
      save.ts                         saveTextAsFile(name, text): Blob + <a download> (server-produced text only)
    format/index.ts                   fmtCell(cell, col), fmtField(fieldId, value, opts) — wrappers over sdk.fields.format(); no arithmetic
    theme/
      tokens.css                      colour + spacing + type tokens; [data-theme] and [data-density] variants (§12)
      colours.ts                      typed token names; stateClass(st), dirClass(dir)
      type.ts                         font stack constants, size table per density
      density.ts                      applies data-density to <html>; reads settings store
    perf/marks.ts                     performance.mark/measure names (§16.2); window.__terminalPerf ring buffer
  test/
    setup.ts                          jsdom, fake timers helper, canvas stub (vitest-canvas-mock is NOT used; a hand-written CanvasRenderingContext2D recorder)
    no-direct-io.test.ts              production bundle contains no `new WebSocket(`/`fetch(` outside the sdk chunk (ARCHITECTURE §1.1)
    keyboard/keymap.test.ts dispatcher.test.ts focus.test.ts
    command/localIndex.test.ts dispatch.test.ts history.test.ts
    shell/commandLine.test.tsx autocomplete.frame.test.tsx panels.test.tsx statusBar.test.tsx help.test.tsx
    state/*.test.ts                   every store; workspace merge; selectors referential stability
    screen/renderer.test.tsx          every Node kind keyboard-operable; Cell states; provenance panel
    grid/gridModel.test.ts virtualiser.test.ts cellRegistry.test.ts flash.test.ts sort.test.ts group.test.ts keyboard.test.tsx
    grid/frame-budget.test.ts         2 000 visible cells × 5 000 changes/s → rAF < 8 ms p95 (ARCHITECTURE §6.6)
    chart/scales.test.ts tradingDayIndex.test.ts downsample.test.ts series.test.ts streaming.test.ts studies/*.test.ts annotations.test.ts events.test.ts keyboard.test.tsx
    chart/render-budget.test.ts       1 y daily redraw < 4 ms; 1 M points line < 16 ms after downsample
    rt/wsBridge.test.ts leader.test.ts stalenessTicker.test.ts conflation.test.ts
    export/csv.test.ts
    screens/<CODE>.test.tsx           per function (FUNCTIONS §7 "screen" row)
```

Imports allowed: `@terminal/core`, `@terminal/sdk`, `react`, `react-dom`, `zustand`. Forbidden and
lint-enforced: `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, `navigator.sendBeacon` (all IO is
the SDK's), any chart/grid/table library, `Date.now()` outside `perf/` and `rt/stalenessTicker.ts`
(which pass `now` explicitly to core).

---

## 2. Bootstrap and session gate

`src/main.tsx` → `bootstrap/client.ts` constructs exactly one `TerminalClient` (API.md §10) for the page:

```ts
// src/bootstrap/client.ts
import { createClient, type TerminalClient } from '@terminal/sdk';
import { perf } from '../perf/marks';
import { useSessionStore } from '../state/session';

export const sdk: TerminalClient = createClient({
  baseUrl: window.location.origin,
  clientVersion: `web/${__APP_VERSION__}`,                 // vite define from package.json
  conflationMs: 250,
  traceId: () => crypto.randomUUID(),                      // one per user action (OPS-07)
  onTrace: (e) => perf.trace(e),                           // route, ms, status → status bar p95 and __terminalPerf
  onVersion: (v) => useSessionStore.getState().setServerVersion(v),   // reload badge when minClientVersion > ours (API.md §11)
});
```

`App.tsx` sequence (ARCHITECTURE §5, TERM-05):

1. `sdk.auth.session()` → `401` renders `<Login/>`; `MFA_REQUIRED` renders the WebAuthn step; success
   hydrates `sessionStore` (`SessionInfo`: entitlement summary, quotas, dictionary version).
2. `sdk.workspace.get()` → `workspaceStore.hydrate(ws)`; `panelsStore.fromLayout(ws.layout)` builds the
   runtime panels (frame stacks, histories, drafts). Panels whose top frame has `fn` re-run their
   function with `launchKind:'refresh'` so the desk comes back live (TERM-05).
3. `command/localIndex.ts` starts loading the universe snapshot (IndexedDB hit first, ETag revalidate);
   until the worker swaps the index in, autocomplete uses `sdk.search.query` (FUNCTIONS §3.4).
4. `rt/leader.ts` acquires the WS leadership lock (§7.4) and `sdk.live.connect()`; `StatusBar`
   subscribes `sys:status` with `f: []`.
5. `<Shell/>` mounts; focus goes to `layout.focus`'s command line (`Ctrl+L` semantics).

Login form (`bootstrap/login/Login.tsx`) sends `LoginRequest` with `deviceId` from `deviceId.ts` and a
`deviceLabel` such as `Chrome on macOS`. A `superseded` object in the response is shown once as a toast
("Signed out Chrome on macOS, last seen 17:02") — SEC-03 visibility. When *this* session is superseded
later (`401 SESSION_SUPERSEDED` on any route, or WS `bye 4003`), the shell freezes under a modal lock
screen naming `details.supersededBy.deviceLabel` with one action, `Enter` → sign in again; no data path
continues (ENTL-03).

---

## 3. The shell (TERM-04)

### 3.1 Panels

A workspace has 1–8 panels `p1`..`p8` (`WorkspaceLayout.panels`, API.md §5.7); the visible set is the
layout `mode`: `'1'` shows `p1`; `'2h'` `p1 p2` side by side; `'2v'` `p1` over `p2`; `'4'` the 2×2 grid
`p1 p2 / p3 p4`. Panels `p5`..`p8` exist for the second window (§7.4) and for `/panel 5..8`, which
switches the mode's slot to show them. Every panel owns (TERM-04):

- its own command line, draft and history (`PanelState.history`, `commandDraft`);
- its own back-stack (`frameStack`, `index`) and the frame's screen, params, result, scroll position;
- its own `PanelContext` (security, function, params) used by the parser and ranker (TERM-03);
- its own subscriptions, released when the frame changes (§9).

All panels share one authenticated session (cookie) and one WebSocket (API.md §6.3 rule 1); the SDK's
ref-counted `SubscriptionManager` means two panels on `AAPL US Equity` produce one `sub`.

```tsx
// src/shell/Panel.tsx — layout of one panel (heights in rows of the density table §12.3)
<section data-panel="p1" aria-label="Panel 1" className={focused ? 'panel focused' : 'panel'}>
  <PanelHeader/>                     {/* 1 row: id · CODE · security · name · [DELAYED 15m] [STALE ·] [trace 3f2a] */}
  <CommandLine/>                     {/* 1 row: amber prompt '>' + input; yellow-key hints on the right */}
  <Autocomplete/>                    {/* absolutely positioned under the command line, ≤ 12 rows */}
  <ScreenHost/>                      {/* flex: 1; the function screen; scroll container for non-grid nodes */}
  <PanelFooter/>                     {/* 1 row: sources · asOf · error line · key hints for the focused node */}
</section>
```

### 3.2 Focus model

Exactly one panel is *focused* (`layout.focus`); its border uses `--c-focus` and its command line is
the default target of printable keys. Within a panel, focus is a *region* (`keyboard/focus.ts`):

```ts
export type FocusRegion =
  | { kind: 'command' }                                   // the panel's command line
  | { kind: 'node'; nodeId: string }                      // a ScreenSpec node (grid, list, form, chart, tabs, kv, text, custom)
  | { kind: 'overlay'; overlay: 'help' | 'ticket' | 'prompt' | 'provenance' | 'picker' | 'lock' }
  | { kind: 'keybar' };
export interface FocusState { panelId: string; region: FocusRegion; lastNodeByPanel: Record<string, string | undefined> }
```

Roving `tabindex`: the focused element carries `tabIndex=0`, all other focusable elements `-1`, so the
browser's own Tab order never fights the dispatcher. Focus is restored per panel when a frame is popped
(`lastNodeByPanel`) and set to `ScreenSpec.initialFocus` when a new payload paints (FUNCTIONS §1.5).

### 3.3 Status bar and key bar

`StatusBar.tsx` (bottom, 1 row): `● LIVE` / `◐ RESYNC` / `○ OFFLINE` connection state from
`sdk.live.state`; `conf 250ms` (effective, orange when widened by a `notice`); staleness legend
(`live · stale · closed — blank`); `NYSE open · SIFMA open · FX open` from `sys:status`; quota gauges
from `SessionInfo.quotas` (web sessions: counted, not enforced, API.md §8); server clock; `web/0.1.0`
with a `RELOAD` badge when `minClientVersion` exceeds ours. `KeyBar.tsx` (above the status bar, 1 row,
hidden in density `compact` unless `/keybar on`): clickable and focusable buttons `GO` `CANCEL` `MENU`
`HELP` `PRINT` `PG▲` `PG▼` and the yellow sector keys `GOVT CORP MTGE M-MKT MUNI PFD EQUITY COMDTY INDEX
CURNCY` — the guaranteed path for TERM-07 when the browser swallows an F-key (FUNCTIONS §9).

### 3.4 Overlays

One overlay at a time per panel, rendered in the panel's own bounds (right third for HELP, centred for
dialogs), with a focus trap; `Escape` closes (CANCEL priority, §5.2). Overlays: `HelpOverlay`,
`TicketDialog`, `PromptDialog`, `ProvenancePanel`, pickers (column, study, overlay-security), and the
page-level `lock` screen. Toasts are non-modal, never take focus, and auto-dismiss in 6 s (8 s for
`downgrade` and `slow-consumer` notices, which also leave a badge in the status bar).

---

## 4. Command line and autocomplete (TERM-01, TERM-02)

### 4.1 `CommandLine.tsx`

An **uncontrolled** `<input>` (`ref`), so a keystroke never re-renders the React tree: `onInput` writes
`panelsStore.setDraft(panelId, value)` with zustand's transient set (no subscribers on `commandDraft`
except the autosave debounce) and calls `autocomplete.query(value)` synchronously.

```ts
// src/shell/CommandLine.tsx (behavioural contract)
onKeyDown(e):
  Enter          → GO: dispatch.execute(panelId, autocomplete.selected ?? parse(value)[0])         (§6)
  ArrowDown/Up   → if autocomplete open: move selection; else history.recall(panelId, ±1, prefix=value)
  Tab            → if autocomplete open: replace input with selected.insertText + ' ' (completion, no execute)
  Escape         → CANCEL ladder (§5.2)
  F2..F11        → insert the sector token after the typed ticker (FUNCTIONS §2.6); e.preventDefault() when the browser allows
  Ctrl+L         → select-all (already focused)
onInput(e):      panelsStore.setDraft(); perf.mark('cmd:input'); autocomplete.query(value, panelCtx)
```

Typing anywhere (TERM-01): `keyboard/dispatcher.ts` forwards any printable key (`e.key.length === 1`,
no `Ctrl`/`Alt`/`Meta`) pressed while focus is on a grid, list, kv, tabs, text, chart, badges or the
key bar to the focused panel's command line, which receives focus and the character. Exceptions: focus
inside a `form` field, the MSG `Composer`, a prompt dialog, or the login form.

### 4.2 Parse and rank (`core/command`, FUNCTIONS §2–§3)

`autocomplete.query(text, ctx)`:

1. `tokenize` + `parse(text, env)` where `env.registry = sdk.functions`, `env.panel = panelCtx`,
   `env.lookupTicker` hits the local `UniverseIndex` (FUNCTIONS §2.3).
2. `rank(q, index, rankCtx, registry)` with `rankCtx = { panel, hasPanelSecurity, watchlistIds (rows of
   the focused panel's QM/W grid), mru, sectorGiven, kinds }` → ≤ 12 `Candidate`s (FUNCTIONS §3.3).
3. Row 0 is `parse(text)[0]`'s leading candidate by construction; alternatives follow.
4. Server fallback (`sdk.search.query`) only when the index is not built, or `len(q) ≥ 3` with no local
   `match ≥ 60`, debounced 60 ms, `AbortController` per query; hits are merged below local rows and
   never reorder what is already shown (FUNCTIONS §3.4).
5. Budget: steps 1–2 ≤ 4 ms p95 on 45 k entries (core bench); render ≤ 16 ms (§16).

### 4.3 `Autocomplete.tsx`

```tsx
export interface AutocompleteProps { panelId: string; rows: Candidate[]; selected: number; open: boolean; onSelect(i: number): void; onExecute(i: number): void }
```

Rendering rules: `role="listbox"` with `aria-activedescendant`; each `AutocompleteRow` is `memo` keyed
on `kind:id`; `primary` with `matched` ranges wrapped in `<mark>`; `secondary` muted; kind glyph
(`▤` instrument, `ƒ` function, `☺` person, `#` topic); tier badge `T1/T2/T3` for functions;
`applicable:false` rows dimmed with the reason (`not applicable to Curncy`); `source:'yahoo'` rows carry a
`not in master` badge (they resolve through `/ref/resolve`, FUNCTIONS §3.4); a `NO SECURITY LOADED`
situation inserts the `SECF <text>` row (FUNCTIONS §2.5). The popup closes on GO, Escape, blur, or an
empty input. `search.select` usage events are emitted on GO with `{ kind, rank, queryLen, latencyMs, source }`
(FUNCTIONS §1.10).

### 4.4 History and MRU

`command/history.ts`: per-panel ring of ≤ 100 executed raw strings (persisted in `PanelState.history`);
`ArrowUp` with a non-empty draft filters by prefix. `command/mru.ts`: `terminal.mru` in localStorage,
≤ 50 `{ kind, id, lastUsed, count }`, bumped on every executed candidate, rebuilt from all panels'
histories on a machine without it (FUNCTIONS §3.1, TERM-05).

---

## 5. Keyboard map (TERM-06, TERM-07)

Keys are matched on `KeyboardEvent.code` (FUNCTIONS §2.6) through `keyboard/keys.ts`; `Ctrl` means
`ctrlKey` on every platform (`Meta` is not used, so macOS `Cmd` stays with the browser). Every binding
below has an on-screen equivalent: the key bar (§3.3), the panel footer key hints, and the HELP index.

### 5.1 Resolution order (`keyboard/dispatcher.ts`)

For one `keydown`, the first handler that returns `handled` wins:

1. Page lock screen (only `Enter`).
2. Open overlay of the focused panel (its own map; `Escape` always closes it).
3. Reserved global keys (§5.2) — function keymaps may not rebind them (FUNCTIONS §2.6).
4. The focused region map: command line (§4.1), grid (§5.3), list, form, tabs, kv/text, chart (§11.9), key bar.
5. The screen's `manifest.keymap` + `ScreenSpec.keymap` entries whose `when` matches the region
   (`'always'` matches any non-command region; a printable letter bound here is *not* routed to the command line).
6. Typing-anywhere routing to the command line (§4.1).

### 5.2 Reserved global keys

| Key | Action | Semantics |
| --- | --- | --- |
| `Enter` | **GO** | Command line: execute row 0 / selection. Grid, list, form, chart, tabs: the region's own Enter first (row command, submit, marker click-through); when the command line has text, GO executes it from any region (TERM-01). |
| `Escape` | **CANCEL** → **MENU** | Ladder, first that applies: close overlay → close autocomplete → clear the command draft → cancel an in-progress prompt/draw mode → **pop the frame stack one step** (MENU = previous screen, FUNCTIONS §2.6). Nothing to pop → no-op with a footer hint. |
| `F1` | **HELP** | HELP ×1 overlay; second press within 10 s or while open → ticket dialog (TERM-09, §15). |
| `F2 F3 F4 F5 F6 F7 F8 F9 F10 F11` | yellow keys | insert `Govt Corp Mtge M-Mkt Muni Pfd Equity Comdty Index Curncy` after the typed ticker; `preventDefault()` where the browser permits (FUNCTIONS §10 open question 5 for `F11`). |
| `Ctrl+P` | **PRINT** | export the focused panel's result as CSV (§13). |
| `PageDown` / `PageUp` | **PAGE FWD / PAGE BACK** | pageable functions: `ctx.page('fwd'|'back')`; other screens: scroll one viewport of the focused node. |
| `Alt+ArrowLeft` / `Alt+ArrowRight` | frame back / forward | walks `frameStack.index` without popping (§7.1). |
| `Alt+1` … `Alt+8` | focus panel `p1`..`p8` | emits `panel.switch`; a hidden panel is brought into the current mode's slot (`/panel n`). |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | next / previous visible panel | `panel.switch`. |
| `Tab` / `Shift+Tab` | next / previous focus region | command line → nodes in document order → key bar → command line. Inside a form: next/previous field (form owns Tab). |
| `Ctrl+I` | provenance | `ProvenancePanel` for the focused cell/row/series (`provIdx`) (DATA-10). |
| `Ctrl+L` | command line | focus the panel's command line, select all. |
| `Ctrl+E` | grid data export | `/data/csv` for the focused grid (§13.2). |
| `Ctrl+Enter` | GO in next panel | executes the command line's text in the next visible panel (same as `ScreenCtx.navigateNext`). |
| `Shift+Enter` | row → next panel | on a grid/list row: `onShiftEnter(row)` command in the next visible panel (FUNCTIONS §1.5). |

### 5.3 Region maps

**Grid** (`grid/keyboard.ts`; also `table`, which is a grid without live cells):

| Key | Action |
| --- | --- |
| `ArrowUp/Down` | move the focused row (wraps at group headers, which are focusable and show the aggregate) |
| `ArrowLeft/Right` | move the focused column (frozen columns included; horizontal scroll follows) |
| `Home` / `End` | first / last column; `Ctrl+Home` / `Ctrl+End` first / last row |
| `PageUp/Down` | one viewport of rows (non-pageable screens); pageable screens defer to PAGE FWD/BACK |
| `Space` | toggle row selection (`selectable`); `Shift+Space` extend |
| `Enter` / `Shift+Enter` | `onEnter(row)` / `onShiftEnter(row)` command; on a group header: collapse/expand |
| `S` | sort by the focused column (cycle asc → desc → none) — default binding unless the screen overrides |
| `G` | cycle `groupBy` over the columns marked `groupable` — default binding unless overridden |
| `Ctrl+ArrowLeft/Right` | move the focused column left/right (persisted in `MonitorSpec.columns` for QM/W) |
| `Insert` / `Delete` | screen-defined (add/remove row) when bound in the manifest keymap |
| `Ctrl+I` | provenance of the focused cell |

**List**: `ArrowUp/Down`, `Home/End`, `PageUp/Down`, `Enter` (command or `url` → `ctx.openUrl`),
`Shift+Enter`, `Ctrl+I`. Live lists (`n:*`) prepend new items above the focused item without moving it.

**Form**: `Tab/Shift+Tab` or `ArrowDown/Up` between fields; `enum`: `ArrowLeft/Right` or `Space`
cycles `values`, typing filters; `number`: `ArrowUp/Down` ± `step`, `Shift+Arrow` ± `bigStep`, typing
edits; `date`: typing accepts every FUNCTIONS §2.4 date syntax, `ArrowUp/Down` ± 1 business day
(NYSE calendar), `Shift` ± 1 month; `boolean`: `Space` toggles; `security`/`field`/`watchlist`:
`Enter` opens `PromptDialog` typeahead, result written back; `Enter` on any field submits when
`submitLabel` is set (otherwise `Ctrl+Enter` submits); `Escape` reverts the field to its last value.

**Tabs**: `ArrowLeft/Right` or digits `1`..`9` select (FUNCTIONS §7.2 rule 5); `Enter`/`ArrowDown`
moves into the tab body.

**KeyValue / Text / Badges**: `ArrowUp/Down` move the focused row/line/badge (scrolls); `Enter` on a
row with `value.command` executes it; `Ctrl+I` provenance; badges expose their `title` (reason) as the
footer hint when focused.

**Chart**: §11.9.

**Dialogs** (`PromptDialog`, `TicketDialog`, pickers): focus trapped; `Tab` cycles; `Enter` confirms;
`Escape` cancels (returns `null` to `ScreenCtx.prompt`); typeahead prompts use the autocomplete list
with `ArrowUp/Down`/`Tab` as in §4.

### 5.4 Keyboard operability contract for `ScreenRenderer`

`packages/web/test/screen/renderer.test.tsx` renders every `Node` kind and proves, with
`@testing-library/user-event` keyboard only: every node is reachable by `Tab`; every interactive
affordance (row command, tab, form field, badge reason, event marker, annotation, custom canvas action)
is reachable by the keys above; no handler is bound to `onClick` alone (mouse handlers always call the
same action function the key calls). A screen test that finds a mouse-only affordance fails
(`TERM-06: "Mouse-only affordances are defects"`).

---

## 6. Per-user context rules (TERM-03)

`command/dispatch.ts` implements FUNCTIONS §2.5 verbatim over the panel's `PanelContext`:

```ts
// src/command/dispatch.ts
export interface DispatchDeps { sdk: TerminalClient; panels: PanelsStore; usage: UsageStore; registry: FunctionRegistry }
export async function execute(deps: DispatchDeps, panelId: string, cmd: ParsedCommand): Promise<void>;
/** Pure decision: what to run, given the panel context (unit-tested against the §2.5 table). */
export function decide(cmd: ParsedCommand, panel: PanelContext, registry: FunctionRegistry):
  | { kind: 'run'; code: string; alias?: string; security: SecurityRefInput | null; params: Record<string, unknown>; newFrame: boolean }
  | { kind: 'shell'; word: string; args: string[] }
  | { kind: 'help'; code?: string; query?: string }
  | { kind: 'error'; problem: CommandProblem };
```

| Shape | Panel has security | Panel empty |
| --- | --- | --- |
| `function` | run on `panel.security` (ignored when `assetClasses:'none'`); `NOT_APPLICABLE` → footer `YAS applies to Govt`, not sent | `requiresSecurity` → footer `NO SECURITY LOADED` + `SECF <text>` row; else run with no security |
| `security` | run `panel.fn` with `panel.params` on the new security; if `panel.fn` is not applicable to the new asset class → `DES` | run `DES` |
| `security+function` | both replaced; params from args over manifest defaults (never over the panel's previous params) | same |
| `help` / `shell` | §15 / FUNCTIONS §2.6 | same |

Context is **per panel** (four panels can hold four securities) and the user-level context is the
*focused* panel: `panelSecurityId` and `panelFunction` are sent on `/search` and `/ref/resolve` for
ranking boosts (API.md §5.1–5.2), and `Shift+Enter` on a row carries that row's security into the next
panel's context. Every executed command pushes `Frame { security, fn, params, resultId:null, scroll:0 }`
onto `frameStack` (truncating forward history), appends the raw text to `history`, clears the draft,
mints `traceId`, and emits `fn.launch` with `durationMs` filled at first paint (FUNCTIONS §1.10). A
`param` change (`ScreenCtx.setParams`) or `page` replaces the current frame's `params`/`resultId` in
place — no new frame.

Shell commands (`/layout 1|2h|2v|4`, `/panel 1..8`, `/conflate <ms>`, `/theme dark|light|system`,
`/density compact|normal|comfortable`, `/keybar on|off`, `/clear`, `/logout`, `/trace`, `/version`)
act on the stores directly and never reach the SDK's function route; `/conflate` calls
`sdk.live.setConflation` and writes `layout.conflationMs`.

---

## 7. Workspace persistence contract (TERM-05, TERM-10)

### 7.1 What is persisted, where

| State | Store | Persisted in | Notes |
| --- | --- | --- | --- |
| Layout mode, focus, panels (frame stacks with `security {id, display}`, `fn`, `params`, `resultId`, `scroll`; history; draft) | `panelsStore` → `workspaceStore.layout` | `workspaces.layout` via `PUT /workspace` (API.md §5.7) | `resultId` is a stale-while-revalidate hint; expired ids are ignored on load |
| Monitor layouts (QM/W column order, widths in `ch`, sort, groupBy) | `workspaceStore.layout.monitors[]` | same | `MonitorSpec.columns` is column order; widths are appended as `columns[i] = 'PX_LAST:12'` — parsed by `grid/columns.ts` |
| Chart defaults (`defaultRange`, `defaultType`, `studies[]`) | `layout.chart` | same | per-instrument annotations are separate rows (`sdk.workspace.annotations`, CHRT-05) |
| Conflation preference | `layout.conflationMs` | same | applied on `hello` |
| Windows (`windowId`, `screen`, `bounds`, `panelIds`) | `layout.windows` | same | §7.4 |
| Watchlists, alerts, saved searches, portfolios | REST resources | own tables | not part of the layout |
| Theme, density, key bar visibility, MRU, universe snapshot cache, device id | `settingsStore` | `localStorage` / IndexedDB, per device | no server column exists for them (§18 Q1) |

### 7.2 Save protocol

```ts
// src/state/workspace.ts
export interface WorkspaceStore {
  workspaceId: number | null; name: string; version: number; serverLayout: WorkspaceLayout | null;
  dirty: Set<string>;                      // 'mode' | 'focus' | 'monitors' | 'chart' | 'conflationMs' | 'windows' | 'panel:p1' …
  status: 'idle' | 'saving' | 'conflict' | 'error'; lastSavedAt: number | null;
  hydrate(ws: Workspace): void;
  markDirty(key: string): void;            // schedules save: debounce 2 000 ms, max wait 10 000 ms
  saveNow(): Promise<void>;                // PUT { version, layout }; on 409 → merge (below) and retry once
  toLayout(): WorkspaceLayout;             // assembled from panelsStore + own fields; validated by Rest.Workspaces.Layout before send
}
```

1. Every mutation of a persisted field calls `markDirty(key)`; a trailing-edge debounce of 2 s (max
   wait 10 s) issues `sdk.workspace.put(version, toLayout())` (API.md §5.7 "autosave debounced 2 s").
2. `200 { version }` → `version` updated, `dirty` cleared, `serverLayout = sent layout`.
3. `409 WORKSPACE_VERSION_CONFLICT` → merge `details.current` with the local layout **per key**:
   keys in `dirty` keep the local value; every other key takes the server's; panels are merged by panel
   id (`panel:pN` dirty → local panel, else server panel; a panel present only on one side is kept).
   Retry once with `current.version`; a second 409 sets `status:'conflict'` and shows a toast with
   `R` (reload server copy) / `K` (keep mine, force by re-reading and re-sending).
4. `visibilitychange → hidden` and `pagehide` flush immediately when dirty (best effort; the request
   still carries `x-requested-with` because it goes through `RestClient`, so no `sendBeacon`).
5. Load applies `migrateLayout(raw)` (`state/workspace.ts`): `schema` other than `1` is migrated
   forward (today: identity; unknown → default layout from the seed shape with a toast), and every
   `Frame.security` is re-resolved through `sdk.ref.resolveMany` so a delisted instrument shows
   `SECURITY_NOT_FOUND` in the footer instead of a blank panel.

### 7.3 Multiple workspaces

`/workspaces` list/create/activate are exposed through the `HELP` index and the `WS` shell command
(`/ws list`, `/ws save <name>`, `/ws load <name>`): activation performs step 5 with the chosen layout
and releases all subscriptions of the previous one.

### 7.4 Multi-window (TERM-10) — one WebSocket per session

API.md §6.3 rule 1 closes the older socket when a second one opens for the same session (`4003
ws-replaced`), so a second browser window **must not** open its own `LiveClient`. `rt/leader.ts`:

```ts
// src/rt/leader.ts
export type RtRole = 'leader' | 'follower';
export interface RelayMsg =
  | { t: 'sub'; windowId: string; id: number; subjects: string[]; fields: FieldId[] | '*'; opts?: SubscribeOptions }
  | { t: 'unsub'; windowId: string; id: number }
  | { t: 'essential'; subjects: string[]; essential: boolean }
  | { t: 'update'; e: UpdateEvent }                                 // leader → followers (only subjects a follower asked for)
  | { t: 'status'; e: { subject: string; st: string; reason?: string } }
  | { t: 'downgrade' | 'notice' | 'state' | 'alert' | 'message'; e: unknown }
  | { t: 'who' } | { t: 'leader'; windowId: string };
export function startRuntime(sdk: TerminalClient): { role: RtRole; live: LiveLike };   // LiveLike = the LiveClient interface (API.md §10.2) implemented by the leader proxy or the relay client
```

`navigator.locks.request('terminal.ws', { mode: 'exclusive' })` elects the leader; the winner calls
`sdk.live.connect()` and relays over `new BroadcastChannel('terminal.rt')`; followers get a `LiveLike`
that speaks `RelayMsg`. When the leader window closes, the lock releases, the next window wins and
reconnects (fresh snapshots, BUS-07). Each window registers itself in `layout.windows` with
`windowId` (`crypto.randomUUID()` kept in `sessionStorage`), `screen` (`screen.label ?? 'primary'`),
`bounds = [screenX, screenY, outerWidth, outerHeight]` and its `panelIds`; on reconnect a window whose
`windowId` matches restores those panels, and per-monitor DPI is handled by the chart's
`devicePixelRatio` handling and CSS pixels elsewhere. **Gap:** v1 ships and e2e-tests the single-window
path; the relay is unit-tested in jsdom only (§18 Q2).

---

## 8. State management (zustand 5)

Six stores, created with `state/store.ts` (`create` + `subscribeWithSelector` + `devtools` in dev).
Rules: (1) nothing on the real-time hot path writes to a store — deltas go `LiveClient → cellRegistry
/ chart streaming` (§9), stores hold only what React renders; (2) components subscribe with selectors
and `useShallow`; (3) actions are the only writers; (4) stores never import React.

```ts
// src/state/session.ts
export interface SessionStore {
  status: 'unknown' | 'anonymous' | 'mfa' | 'ready' | 'locked';
  info: SessionInfo | null;                       // API.md §1.2
  server: { serverVersion: string; minClientVersion: string; dictionaryVersion: string } | null;
  lock: { supersededBy?: { deviceLabel: string; createdAt: string } } | null;
  setSession(i: SessionInfo | null): void; setServerVersion(v: SessionStore['server']): void; lockSuperseded(d?: SessionStore['lock']): void;
}
export const selectDefaultTier = (s: SessionStore) => s.info?.entitlementSummary.defaultTier ?? 'delayed';
export const selectNeedsReload = (s: SessionStore) => !!s.server && semverLt(__APP_VERSION__, s.server.minClientVersion);

// src/state/panels.ts
export interface Frame { security: { id: number; display: string } | null; fn: string | null; params: Record<string, unknown>; resultId: string | null; scroll: number;
  // runtime (not persisted)
  traceId: string; status: 'idle' | 'loading' | 'ready' | 'error'; payload?: unknown; meta?: PayloadMeta; instrument?: InstrumentSummary | null;
  error?: { code: string; message: string; traceId: string; details?: Record<string, unknown> }; startedAt?: number; firstPaintAt?: number }
export interface PanelRuntime { id: string; frameStack: Frame[]; index: number; history: string[]; commandDraft: string;
  overlay: FocusRegion & { kind: 'overlay' } | null; ac: { rows: Candidate[]; selected: number; open: boolean } }
export interface PanelsStore {
  panels: Record<string, PanelRuntime>; focus: string; mode: WorkspaceLayout['mode']; visible: string[];
  fromLayout(l: WorkspaceLayout): void; toLayout(): Pick<WorkspaceLayout, 'panels' | 'focus' | 'mode'>;
  setDraft(p: string, v: string): void;                   // transient (no autosave trigger; draft saved with the next save)
  setAc(p: string, ac: PanelRuntime['ac']): void;
  pushFrame(p: string, f: Omit<Frame, 'status'>): void;   // truncates forward history; marks 'panel:pN' dirty
  replaceFrame(p: string, patch: Partial<Frame>): void;   // param/page/result updates
  goBack(p: string): boolean; goForward(p: string): boolean; popFrame(p: string): boolean;   // Alt+←/→, Escape-MENU
  setFocus(p: string): void; setMode(m: WorkspaceLayout['mode']): void; showPanel(p: string): void;
  setOverlay(p: string, o: PanelRuntime['overlay']): void;
}
export const selectPanel = (id: string) => (s: PanelsStore) => s.panels[id];
export const selectFrame = (id: string) => (s: PanelsStore) => { const p = s.panels[id]; return p.frameStack[p.index]; };
export const selectPanelContext = (id: string) => (s: PanelsStore): PanelContext => { const f = selectFrame(id)(s);
  return { security: f?.instrument ? { instrumentId: f.instrument.instrumentId, assetClass: f.instrument.assetClass, marketSector: f.instrument.marketSector, display: f.instrument.display } : null, fn: f?.fn ?? null, params: f?.params ?? {} }; };
export const selectFocusedFrame = (s: PanelsStore) => selectFrame(s.focus)(s);

// src/state/subscriptions.ts — bookkeeping only; the SDK owns ref counts
export interface SubscriptionsStore {
  byPanel: Record<string, { sub: Subscription; spec: LiveSpec } | null>;
  acquire(panelId: string, spec: LiveSpec): void;         // unsubscribes the previous one for the panel; sets essential per spec
  release(panelId: string): void;
  effectiveConflationMs: number; setEffective(ms: number): void;
  shed: Set<string>;                                       // subjects in status 'shed' (re-sub when visible again)
}

// src/state/settings.ts — per device (localStorage 'terminal.settings')
export interface SettingsStore { theme: 'dark' | 'light' | 'system'; density: 'compact' | 'normal' | 'comfortable'; keybar: boolean; flashMs: 700 | 350 | 0;
  set<K extends keyof SettingsStore>(k: K, v: SettingsStore[K]): void }

// src/state/usage.ts — client usage events (FUNCTIONS §1.10)
export interface UsageStore { queue: UsageEvent[]; push(e: Omit<UsageEvent, 'ts'>): void; flush(): Promise<void> }   // 5 s / 100 events / pagehide via sdk.usage.events
```

`workspaceStore` is in §7.2. The `payload` of a frame is held in the store because the screen is a
pure function of it (FUNCTIONS §1.5); payloads are ≤ a few hundred KB and replaced, never mutated.
A per-panel LRU (`ScreenHost`, 8 entries keyed `(code, instrumentId, paramsHash)`) serves
stale-while-revalidate paints (ARCHITECTURE §5).

---

## 9. Real-time bridge (`rt/wsBridge.ts`, TERM-04, TERM-08, TERM-12, ENTL-05)

```
ScreenHost paints payload  →  manifest.live(params, payload) → LiveSpec | null
  → subscriptionsStore.acquire(panelId, spec)  → sdk.live.subscribe(subjects, fields, { essential, conflationMs })
  → rt/conflation.ts: effective = min(visible screens' conflationMs ?? layout.conflationMs) → sdk.live.setConflation(effective)   (FUNCTIONS §10 Q6)
sdk.live 'update' (subject, changed, state, kind)
  → cellRegistry.apply(subject, changed, state)           (grid/kv/list cells)            — no React
  → chart.streaming.apply(e)                              (series with live: {subject, field, mode})
  → list widgets with live: {subject: 'n:*'}: prepend headline (React state, one row, ≤ 1/s per list)
sdk.live 'status'  { st:'shed' | 'gone' | 'stale' | 'halted' | 'closed' | 'pending' | 'blank' }
  → cellRegistry.setSubjectStatus(subject, st): 'shed' → cells keep their last value, get class .st-shed and the '·' glyph; row header shows SHED
  → subscriptionsStore.shed.add(subject); virtualiser re-subscribes when the row scrolls into view (setEssential true) (API.md §10.2)
sdk.live 'downgrade' { s?, from, to, reason }
  → toast 'q:42 downgraded delayed → eod (NOT_ENTITLED_TIER)'; PanelHeader tier badge; the following snap replaces every value (never a stale higher-tier number)
sdk.live 'notice'  → StatusBar conflation badge (widened/restored), toast on 'shed' and 'disconnect-soon'
sdk.live 'state'   → StatusBar; 'resyncing' greys every live cell's state to 'stale' until its fresh snap arrives (BUS-07)
sdk.live 'alert'   → Toast + alerts badge; 'message' → MSG screen if mounted, else unread badge
rt/stalenessTicker.ts every 1 000 ms: subjects = sdk.live.quoteCache.sweep(now) → cellRegistry.restyle(subjects); chart legend restyle
```

`sdk.live.quoteCache` is `LiveClient`'s own `QuoteCache` instance, exposed as `readonly quoteCache:
QuoteCache` on the `LiveClient` declaration (API.md §10.2). The web client does **not** construct a second
cache: `LiveClient.get(subject)` reads that same `Map<subject, QuoteView>`, so the ticker sweeps exactly
the state the grid renders. `sweep(now)` returns the subjects whose `valueState`
(`core/quote/staleness.ts`) changed at this tick, which is the whole TERM-12 mechanism — one 1 s timer per
document, no per-cell timers.

`LiveView` (`screen/liveView.ts`) implements FUNCTIONS §1.5: `get(subject, field)` returns the SDK
`QuoteView` value as a `ValueCell` (`v = f[field]`, `st`, `r = r[field]`, `ts = fts[field]`, `provIdx`
from the payload cell) or the payload cell when no frame has arrived; `state(subject)` maps status
`shed`/`gone` → `'blank'`.

Essential flag (BUS-04, API.md §6.5): the grid's virtualiser marks rows in the viewport ± overscan as
essential and everything else non-essential (`sdk.live.setEssential`), so a slow consumer sheds
off-screen rows first; `LiveSpec.essential[]` subjects (header/kv blocks) are always essential.

---

## 10. LiveGrid (TERM-08)

### 10.1 Design

DOM cells updated imperatively outside React (ARCHITECTURE §15 "Live grid rendering"): React owns
structure (columns, sort, group, selection, focus, the virtual window), `cellRegistry` owns cell
*content and state classes*. A cell is a `<div role="gridcell">` whose `textContent` and
`data-st`/`data-dir` attributes are written directly. Layout is a CSS grid with fixed column widths
(`ch` units) and a fixed row height per density (§12.3), so a text change never triggers layout of
other cells; flashes use `background-color` animation only (compositor-friendly). Virtualisation
renders only the visible rows plus 10 overscan; scrolling is `transform: translateY` of the row block.

### 10.2 Component API

```ts
// src/grid/types.ts
import type { GridColumn, GridRow, Cell } from '../screen/types';
export interface LiveGridProps {
  id: string;                                              // ScreenSpec node id; used for focus and persistence
  columns: GridColumn[];                                   // FUNCTIONS §1.5; `live: true` columns are registered with cellRegistry
  rows: GridRow[];                                         // payload rows; `subject` for live rows; stable `id`
  live?: { subjectOf: (row: GridRow) => string | null };
  sort?: { col: string; dir: 'asc' | 'desc' } | null;      // controlled when provided with onSortChange, else internal
  groupBy?: string | null;
  frozenColumns?: number;                                  // default 1 (the key column)
  selectable?: boolean;
  page?: { index: number; count: number };
  emptyText?: string;
  rowHeight?: number;                                      // default from density (§12.3)
  onEnter?: (row: GridRow) => string | null;               // command string → ctx.navigate
  onShiftEnter?: (row: GridRow) => string | null;          // → ctx.navigateNext
  onSortChange?: (s: LiveGridProps['sort']) => void;       // fn.param when the screen persists it
  onGroupChange?: (g: string | null) => void;
  onColumnsChange?: (order: string[], widths: Record<string, number>) => void;   // Ctrl+←/→ and column picker
  onSelectionChange?: (rowIds: string[]) => void;
  onFocusCell?: (row: GridRow, col: GridColumn) => void;   // footer key hints + provenance target
  liveSortThrottleMs?: number;                             // default 1 000
  apiRef?: React.Ref<GridApi>;
}
export interface GridApi {
  focusRow(id: string): void; focusCell(rowId: string, colId: string): void; scrollToRow(id: string): void;
  getVisibleRange(): { start: number; end: number }; getSelection(): string[];
  exportModel(): { columns: GridColumn[]; rows: GridRow[] };   // the rows as the payload gave them (for Ctrl+E, §13.2)
}
export interface VisibleRow { kind: 'row'; row: GridRow; index: number } | { kind: 'group'; key: string; count: number; agg: Record<string, number | null>; collapsed: boolean; index: number }
export interface CellRef { el: HTMLElement; subject: string; fieldId: FieldId; fmt: Cell['fmt']; decimals?: number; priceDecimals?: number; last: FieldValue; lastTs: number | null; st: ValueState }
```

### 10.3 `GridModel.ts` (pure)

`buildVisible(rows, { sort, groupBy, collapsed, liveValues }) → VisibleRow[]`. Sorting uses
comparators by `fmt`: numeric for `px|pct|bp|int|ccy|shares`, ISO string for `date|datetime`,
locale-insensitive `localeCompare` for `text`; `null`/blank sorts last in both directions; ties break
on row order. Grouping produces one header per distinct `row.group ?? row.cells[groupBy].v` in sort
order with `count` and aggregates: `sum` for `int|shares|ccy`, `avg` for `pct|bp`, none for `px|text|date`.
Collapsed groups hide their rows and release their subjects' essential flag.

Live sorting: when `sort.col` is a live column, `sort.ts` re-evaluates the order from `cellRegistry`
values at most every `liveSortThrottleMs` (1 000 ms), and only when no key is held down in the grid;
rows that move do not flash; the focused row keeps focus (identity by `row.id`). A `Shift+S` binding
freezes/unfreezes live re-sorting (footer badge `SORT FROZEN`).

### 10.4 Update path and rAF batching (`cellRegistry.ts`, `flash.ts`)

```ts
// src/grid/cellRegistry.ts
export interface ChangeBatch { subject: string; changed: FieldId[]; state: QuoteView }
class CellRegistry {
  register(cell: CellRef): () => void;                     // called from LiveGrid row mount; returns unregister
  apply(b: ChangeBatch): void;                             // pushes onto `pending`; schedules ONE requestAnimationFrame if none is scheduled
  setSubjectStatus(subject: string, st: Status['st']): void;
  restyle(subjects: string[]): void;                       // staleness ticker: data-st only
  private flush(now: number): void;                        // the rAF callback:
  //   for each pending batch (deduped by subject, last wins — latest-value guarantee end-to-end):
  //     for each changed field with a registered cell:
  //       next = state.f[field]; if next === cell.last → skip (no flash on no-op)
  //       dir = fmt numeric && cell.last != null && next != null ? (next > last ? 'up' : 'down') : 'flat'
  //       cell.el.textContent = format(fieldId, next, { priceDecimals, decimals });  cell.el.dataset.st = state.st;  cell.el.dataset.dir = dir
  //       flash.trigger(cell.el, dir)   (unless settings.flashMs === 0)
  //       cell.last = next; cell.lastTs = state.fts[field] ?? null
  //   perf.measure('grid:raf', start)
}
```

`flash.ts`: `trigger(el, dir)` removes and re-adds `.flash-up|.flash-down` (forcing a restart via
`void el.offsetWidth` only when the class is already present), the CSS animation runs
`var(--flash-ms)` (700 ms default; 350 ms in `compact`) and the class is removed on `animationend`.
Per-frame cap: at most 2 500 cell writes per rAF; the remainder stays in `pending` for the next frame
(nothing is dropped — values are read from the latest `QuoteView` at write time, so a deferred cell
shows the latest value). Direction for `fmt:'text'|'date'` is `flat` (no colour flash, brief neutral
flash). Group aggregates are recomputed every 1 s from `cellRegistry` values, not per delta.

### 10.5 Virtualiser

Fixed `rowHeight`; `viewport.onScroll` (passive) computes `start = floor(scrollTop / rowHeight) −
overscan`, `end = start + ceil(height / rowHeight) + 2·overscan`; React renders only `visible[start..end]`;
rows keep DOM identity by `row.id` (`key`), so scrolling by one row re-mounts one row's cells (register
/ unregister). After each range change the virtualiser diffs the essential set and calls
`sdk.live.setEssential(added, true)` / `(removed, false)`, batched per animation frame by the SDK.
Header row is sticky; frozen columns use `position: sticky; left: 0` with a shadow.

### 10.6 Frame budget test

`test/grid/frame-budget.test.ts` mounts a 2 000-cell visible window (200 rows × 10 live columns),
drives `cellRegistry.apply` with 5 000 field changes/s from a synthetic `QuoteView` generator for 5 s
under fake `requestAnimationFrame` (16.67 ms tick) and asserts the p95 of `flush()` wall time
< 8 ms in jsdom (`performance.now()` around the callback). `packages/e2e/tests/live-grid.spec.ts` runs
QM over a replayed session and reads `window.__terminalPerf.measures('grid:raf')` p95 < 16 ms, and
proves flashes occur (`[data-dir=up]` count > 0) and staleness appears when the replay stops
(`[data-st=stale]` within 3 × interval + 1 s) (TERM-08, TERM-12).

---

## 11. Chart engine (CHRT-01..07)

### 11.1 Architecture

`ChartCanvas.tsx` owns two stacked `<canvas>` elements sized to the node with `ResizeObserver` and
`devicePixelRatio` (crisp on any monitor, TERM-10): the **base** canvas (grid, axes, series, studies,
events, annotations, reference lines, legend) is redrawn only when data, range, size, pane layout or
options change; the **overlay** canvas (crosshair, readout, forming bar, draw-mode preview, focus
rings) is redrawn per interaction frame. Everything is Canvas 2D (`getContext('2d', { alpha:false })`
for the base); Chrome composites canvases on the GPU, and the engine keeps every draw O(pixels) by
downsampling (§11.4), which is how CHRT-02's "millions of points without re-rendering the full
series" is met. **Gap (CHRT-02):** no WebGL path; a 5 M-point series downsamples in ~40 ms on first
load and thereafter streams incrementally; the test budget (§16) is 1 M points.

```ts
// src/chart/renderer.ts
export interface Viewport { slot0: number; slot1: number }              // visible slot range (TradingDayIndex units)
export interface ChartState { spec: ChartSpec; view: Viewport; crosshair: { slot: number; seriesId: string } | null; focus: ChartFocus; drawMode: DrawMode | null; collapsedPanes: Set<string> }
export type ChartFocus = { kind: 'plot' } | { kind: 'event'; index: number } | { kind: 'annotation'; index: number } | { kind: 'legend'; seriesId: string } | { kind: 'pane'; paneId: string };
export class Renderer {
  constructor(base: HTMLCanvasElement, overlay: HTMLCanvasElement, opts: { dpr: number; theme: ChartTheme; fonts: ChartFonts });
  setSpec(spec: ChartSpec): void;                          // rebuilds TradingDayIndex, scales, study outputs; marks base dirty
  setState(patch: Partial<ChartState>): void;              // view/crosshair/focus → marks base or overlay dirty as appropriate
  applyStream(e: StreamPatch): void;                       // §11.5; marks only the last-slot region dirty
  resize(w: number, h: number, dpr: number): void;
  frame(now: number): void;                                // rAF callback: redraw dirty canvases (base: full or last-slot clip; overlay: always when dirty)
  hitTest(px: number, py: number): Hit | null;
  layout(): PaneLayout[];                                  // pane rects, axis rects (for tests and for the legend DOM)
}
```

### 11.2 Scales and calendar alignment (CHRT-03)

- `TradingDayIndex` (`tradingDayIndex.ts`): the union of all series' `x` values, sorted, deduplicated →
  slot `0..n-1`. Time gaps (nights, weekends, holidays) are compressed: the x-axis is slot-linear, and
  tick labels come from the timestamps. Two securities with different calendars (`calendarId`) align by
  timestamp; a series without a point at a slot is drawn with a gap (`NaN`) or carried (`fill:'prev'`
  is a server option, API.md §4). Intraday specs use `xAxis.sessions` to shade pre/post sessions and
  to break lines at session boundaries.
- `TenorScale` (curves: x in days, log-ish tenor spacing 1M…30Y), `CategoryScale` (bar/heatmap).
- `LinearScale` / `LogScale` per `yAxes[]` entry; `side:'left'|'right'`; `normalise:'pct'|'base100'`
  rebases every series on that axis to the first *visible* point of the viewport (recomputed on pan);
  `fmt`/`decimals` label formatting through `sdk.fields.format` (`px` uses the series' `priceDecimals`).
- Overlays with independent axes: each `ChartSeries.yAxis` names an axis; up to 4 axes render (2 left,
  2 right, offset by 6 ch each); more are legal but share the outermost. Currency conversion is
  server-side (`currency` param in the run request); the client labels the axis with `series.currency`.

### 11.3 Series types (CHRT-01)

| `SeriesType` | Draw | Data | Status |
| --- | --- | --- | --- |
| `line` | polyline, width/dash from `style` | `x,y` | shipped |
| `area` | line + fill to the axis baseline (alpha 0.18) | `x,y` | shipped |
| `mountain` | area with vertical gradient (Bloomberg mountain) | `x,y` | shipped |
| `candle` | body (up/down fill), wicks; hollow up-candles in light theme | `ohlc` | shipped |
| `ohlc` | tick bars: vertical range, left tick open, right tick close | `ohlc` | shipped |
| `bar` | vertical bars from baseline (volume, econ) coloured by `dir` of the paired series or neutral | `x,y` | shipped |
| `step` | step-after line (rates, econ vintages) | `x,y` | shipped |
| `scatter` | 3 px squares (event studies, smile points) | `x,y` | shipped |
| `tick` | last-trade prints as a step line with size-scaled dots (from `quote_ticks`, Q/GIP tick mode) | `x,y` + `volume` | shipped |
| `pnf` | point-and-figure columns from close series: box size default `ATR(14)/2` rounded to tick, reversal 3; drawn as X/O glyphs on a category x-axis of columns | `x,y` (computed client-side in `series.ts#pnfColumns`) | shipped, no tests against a reference implementation (gap) |
| `profile` | market profile: 30-minute TPO letters bucketed by price from intraday bars; POC/value-area lines | `ohlc` intraday | shipped for GIP `TYPE=PROFILE` on 1-/5-day ranges only (gap: multi-day composites) |
| `heatmap` | category × category cells coloured on a sequential scale (OMON smile surface, OVML scenario grid, correlation) | `x` = column index, `y` = row index, `volume` = value | shipped for `OptionSurface`; not offered as a GP type (gap) |

Colour: `style.color` `'auto'` = series palette index; `'up'|'down'|'neutral'` = semantic tokens (§12);
`#rrggbb` literal for user overlays. Up/down candle colours are the `--c-up`/`--c-down` tokens.

### 11.4 Downsampling (`downsample.ts`)

When `visible points > 2 × plot width in px`, lines/areas are reduced per pixel column with M4 (first,
min, max, last), bars with min/max/first/last per column (a column shows the range candle), and
scatter/tick with a per-column count cap of 8. Reduction runs on typed arrays per series per viewport
and is cached by `(seriesId, view.slot0, view.slot1, width)`; a stream append invalidates only the
last column.

### 11.5 Streaming (`streaming.ts`, CHRT-02)

`ChartSeries.live = { subject, field, mode }` binds a series to a subject through the panel's
`LiveSpec` (`b1m:<id>` for the forming bar, `q:<id>` for last price). On `UpdateEvent`:

```ts
export type StreamPatch =
  | { seriesId: string; mode: 'append-forming-bar'; bar: { t: number; o: number; h: number; l: number; c: number; v: number; final: boolean } }   // from b1m: BAR_TS…IS_FINAL
  | { seriesId: string; mode: 'replace-last'; t: number; y: number };                                                                                // from q: PX_LAST
```

`append-forming-bar`: if `bar.t` equals the last slot's timestamp the last element of each typed array
is overwritten; otherwise the arrays grow (capacity doubling, `Float64Array` copy) and a slot is added
to the `TradingDayIndex`; `final:true` freezes it. `replace-last` updates the last `y` and the legend
value. The renderer redraws only the clip rect of the last two slots on the base canvas (plus the y-axis
when the value leaves the current range, which triggers a full redraw at most once per second), and the
overlay readout. Study outputs are updated incrementally for the last slot by the study's `update()`
(§11.6); studies without an incremental form recompute the last `window` points only. Auto-follow: when
the viewport's right edge is the last slot, it stays pinned on append; otherwise the view is unchanged.

### 11.6 Studies (`chart/studies/*`, CHRT-04)

```ts
// src/chart/studies/types.ts
export interface StudyInput { x: Float64Array; close: Float64Array; open?: Float64Array; high?: Float64Array; low?: Float64Array; volume?: Float64Array }
export interface StudyLine { id: string; label: string; y: Float64Array; style: { color: 'auto' | 'up' | 'down' | 'neutral' | `#${string}`; width?: number; dashed?: boolean; fillTo?: string } }
export interface StudyOutput { lines: StudyLine[]; bands?: Array<{ upper: string; lower: string; alpha: number }>; histogram?: { id: string; y: Float64Array }; levels?: number[] }
export interface StudyDef {
  id: string; name: string; pane: 'main' | 'sub';          // main = overlays the price; sub = its own linked pane (shared x-axis, own y-axis)
  params: Array<{ name: string; label: string; default: number; min: number; max: number; step: number }>;
  needs: Array<'close' | 'ohlc' | 'volume'>;
  compute(input: StudyInput, params: Record<string, number>): StudyOutput;
  update?(prev: StudyOutput, input: StudyInput, params: Record<string, number>, lastIndex: number): StudyOutput;   // incremental last-slot update (§11.5)
  yFmt?: 'px' | 'pct' | 'int' | 'ratio';
}
export const studies: Record<string, StudyDef>;            // index.ts
```

The initial registry (22; `~100` in CHRT-04 is a stated gap, §18 Q4). Parameter defaults are the
conventional ones; every study is golden-tested against `fixtures/golden/analytics/studies/<id>.json`
computed from `yahoo-chart-AAPL-max-1d.json` (QA-01), and where core has the same maths
(`core/analytics/stats`: returns, vol) the study calls core so screen and API agree (API-05).

| id | Name | Pane | Params (defaults) | Outputs |
| --- | --- | --- | --- | --- |
| `SMA` | Simple moving average | main | `n=20` | 1 line |
| `EMA` | Exponential moving average | main | `n=20` | 1 line |
| `WMA` | Weighted moving average | main | `n=20` | 1 line |
| `BB` | Bollinger bands | main | `n=20, k=2` | mid, upper, lower + band |
| `DONCHIAN` | Donchian channel | main | `n=20` | upper, lower, mid + band |
| `KELTNER` | Keltner channel | main | `n=20, atr=10, k=2` | mid, upper, lower + band |
| `PSAR` | Parabolic SAR | main | `af=0.02, max=0.2` | scatter line |
| `ICHIMOKU` | Ichimoku cloud | main | `tenkan=9, kijun=26, senkou=52` | 5 lines + cloud band |
| `VWAP` | Session VWAP | main | `anchor=0` (0 = session) | 1 line (intraday only; `needs volume`) |
| `VOL` | Volume with MA | sub | `n=20` | histogram (dir-coloured) + MA line |
| `RSI` | Relative strength index | sub | `n=14` | 1 line, levels 30/70 |
| `MACD` | MACD | sub | `fast=12, slow=26, signal=9` | macd, signal lines + histogram |
| `STOCH` | Stochastic %K/%D | sub | `k=14, d=3, smooth=3` | 2 lines, levels 20/80 |
| `ATR` | Average true range | sub | `n=14` | 1 line |
| `ADX` | Average directional index | sub | `n=14` | ADX, +DI, −DI |
| `CCI` | Commodity channel index | sub | `n=20` | 1 line, levels ±100 |
| `WILLR` | Williams %R | sub | `n=14` | 1 line, levels −20/−80 |
| `ROC` | Rate of change | sub | `n=12` | 1 line, level 0 |
| `MOM` | Momentum | sub | `n=10` | 1 line, level 0 |
| `OBV` | On-balance volume | sub | — | 1 line |
| `STDDEV` | Rolling standard deviation | sub | `n=20` | 1 line |
| `HVOL` | Historical volatility (annualised, log returns; `core/analytics/stats`) | sub | `n=30` | 1 line (`yFmt:'pct'`) |

Pane system: `ChartSpec.panes[]` with `height` fractions; a `sub` study adds a pane (`id = study id`,
default height 0.18 of the plot, main pane shrinks) — stackable: any number of sub panes, each with its
own y-axis, all sharing the x-scale, crosshair and viewport (linked). `main` studies draw on the price
pane's axis. Study parameters are edited in the study picker (`S`): a `form` node inside the picker
(number fields with `step`) — keyboard-operable per §5.3; changes call `ScreenCtx.setParams({ studies })`
so the study list persists in the frame's params and in `layout.chart.studies` as the default.

### 11.7 Event markers (CHRT-06)

`ChartSpec.events[]` (`earnings dividend split news filing index_add index_drop fomc`) render as glyphs
in a 1-row band at the bottom of the main pane at the slot of `t` (`E D S N F + − ●`), stacked when
several share a slot. Keyboard: `E` toggles the band; `Ctrl+ArrowLeft/Right` moves focus between
markers (crosshair follows); `Enter` on a focused marker executes `event.command` in this panel
(`Shift+Enter` next panel) — e.g. `AAPL US Equity CN` for a news marker, `CACS` for a dividend; `Ctrl+I`
opens provenance for `event.provIdx`. Hover/focus shows `label` in the readout.

### 11.8 Annotations (CHRT-05)

Anchored in data coordinates (`{ t, v }` → slot via `TradingDayIndex`, value via the series' y-axis).
Kinds: `trendline` (2 anchors, extended right by `Shift+X`), `hline` (1), `vline` (1), `fib` (2 anchors →
0/23.6/38.2/50/61.8/78.6/100 levels), `text` (1 + label), `regression_channel` (2 anchors → OLS of closes
between them ± 2σ), `rect` (2). Draw mode (`D`): the footer shows `TREND HLINE VLINE FIB TEXT REGR RECT`;
the letter picks the kind; the crosshair places anchors with `Enter`; `Escape` cancels; a placed
annotation is selected (`ArrowUp/Down` cycles selections; `Delete` removes; `M` moves the selected
anchor with the crosshair; `L` edits the label via `PromptDialog('text')`). `Ctrl+S` persists through
`sdk.workspace.annotations.create/update` (`ChartAnnotation`, API.md §5.7) with `sharedScope` from a
prompt (`private|firm|users`); shared annotations from others draw dashed with the owner's name in the
readout and `editable:false`. Annotations load with `sdk.workspace.annotations.list(instrumentId)` when
the GP screen mounts and are merged into `ChartSpec.annotations` (`annotationId` set → persisted).

### 11.9 Chart keyboard map (`chart/keyboard.ts`, when `chart` region is focused)

| Key | Action |
| --- | --- |
| `ArrowLeft/Right` | move crosshair one slot (readout shows every series/study value at the slot with its `st` colour) |
| `Shift+ArrowLeft/Right` | pan one tenth of the viewport |
| `+` / `-` | zoom in/out around the crosshair (or the right edge) |
| `Home` / `End` | jump to first / last slot; `End` re-enables auto-follow |
| `ArrowUp/Down` | cycle the crosshair's series (readout emphasis); with `Alt`: cycle pane focus |
| `1`..`9` | when the screen has tabs, tabs (FUNCTIONS §7.2); otherwise unbound |
| `T` `A` `N` `L` | cycle type / adjust / normalise / log scale via `ScreenCtx.setParams` (GP manifest keymap) |
| `S` | study picker (typeahead over the registry; `Enter` adds with defaults; parameters editable) |
| `O` | overlay picker (`PromptDialog('security')`, accepts formulas `<RATIO(...)>`, CHRT-07) |
| `E` | toggle event band; `Ctrl+ArrowLeft/Right` prev/next marker; `Enter` click-through |
| `D` | draw mode (§11.8); `Ctrl+S` save annotations; `Delete` remove selected |
| `Space` | toggle a collapsed sub pane (focus pane with `Alt+ArrowUp/Down`) |
| `Ctrl+I` | provenance of the crosshair series (`series.provIdx`) |
| `V` (GIP) | toggle VWAP; `P` (GIP) profile view |

Mouse is supported (wheel zoom, drag pan, click marker) but every action above is the same function the
key calls (TERM-06).

### 11.10 Formula series (CHRT-07)

Anywhere a security is entered for the chart (command line `<RATIO(AAPL US Equity, SPX Index)> GP`,
overlay picker, watchlist rows) the client passes `{ formula }` (API.md §3 `SecurityRefInput`); the
server evaluates `core/formula` and returns an ordinary series with `provIdx` citing both inputs. The
client never evaluates a formula over price history (a number exists once); the only client-side
formula evaluation is the watchlist computed column (`W`), which evaluates `core/formula` over the row's
*current* field values on each delta exactly as the server does for CSV (API.md §9).

### 11.11 Gaps against CHRT (stated)

| Req | Shipped | Gap |
| --- | --- | --- |
| CHRT-01 | line, area, mountain, candle, ohlc, bar, step, scatter, tick, pnf, profile (intraday), heatmap (surfaces) | heatmap as a price-chart type; multi-day market profile |
| CHRT-02 | streaming append/replace with last-slot redraw; M4 downsampling; typed arrays | no WebGL; tested to 1 M points, not "millions" |
| CHRT-03 | independent axes (4 rendered), normalisation, calendar alignment by union of timestamps, currency labels (conversion server-side) | intersection alignment is a server option only; no per-series time-zone shift |
| CHRT-04 | 22 studies, stackable linked sub panes, parameters | ~78 further studies; no user-defined studies |
| CHRT-05 | 7 annotation kinds, keyboard draw mode, persistence, sharing scopes | no free-hand; no annotation on curves/surfaces |
| CHRT-06 | 8 marker kinds with click-through | ratings markers (no source) |
| CHRT-07 | formula anywhere a security is entered | client evaluates formulas only for watchlist columns over live fields |

---

## 12. Staleness rendering, colour semantics, density and type (TERM-11, TERM-12)

### 12.1 Value state rendering — one rule for every surface

Every rendered value is a `Cell` (FUNCTIONS §1.5) or a live `QuoteView` field; `st` is computed by
`core/quote/staleness.ts` (server at publish, client every second) and never by a widget. `CellView.tsx`,
`cellRegistry`, the chart legend and the panel header apply the same mapping:

| `ValueState` | Text | Colour token | Glyph | Meaning shown to the user |
| --- | --- | --- | --- | --- |
| `live` | formatted value | `--c-value` (white) — direction flash `--c-up`/`--c-down` on change; `dir` arrows `▲▼` on `CHG_*` | none | updating on schedule at the granted tier |
| `stale` | last formatted value | `--c-stale` (grey) | `·` suffix; row/header badge `STALE` with age (`· 4m`) | no fresh capture within 3 × interval, source frozen, or provider down (`PROVIDER_DOWN` reason in the tooltip) |
| `closed` | last/official value | `--c-closed` (dim white) | none; header badge `CLOSED` / `POST` | session closed; not expected to change |
| `blank` | `—` | `--c-blocked` (violet) | badge with `ReasonCode` on focus/hover (`NO_FIRM_ENTITLEMENT`, `TIER_EOD`, …) | denied or unknown; never a number (ENTL-05) |
| `na` | `·` | `--c-muted` | tooltip `not applicable` | field not applicable to the instrument |

Rules: (1) a value whose subject is `resyncing` or whose socket is closed renders `stale` within
1 s (ticker) — a dead WebSocket cannot leave a "live" number (TERM-12); (2) `PanelHeader` shows the
worst `st` among the panel's cells and the `meta.staleness` of the payload; (3) tier is orthogonal and
shown as its own badge (`DELAYED 15m` from `snap.tier`/`meta.tier` + `delayMin`, `EOD`); (4) the grid
never hides a stale column; (5) the CSV carries the same `staleness` in its header (§13).

### 12.2 Colour tokens (`theme/tokens.css`)

Colour is semantic only (TERM-11): up/down, entitled/blocked, stale/live, focus, error. No decorative
colour; brand amber is used for labels and the prompt only. Dark is the default terminal look; light
exists for TERM-13 locked-down desktops. Tokens are defined once on `:root` and overridden under
`[data-theme="light"]`.

```css
/* src/theme/tokens.css — dark (default) */
:root {
  --c-bg: #000000;  --c-bg-panel: #0a0a0a;  --c-bg-header: #141414;  --c-bg-row-alt: #0e0e0e;  --c-bg-selected: #1c2a3a;
  --c-value: #f2f2f2;      /* live numbers */
  --c-label: #ffb000;      /* field labels, prompt, titles (terminal amber) */
  --c-muted: #8c8c8c;      /* secondary text, na */
  --c-up: #37d67a;  --c-down: #ff5252;  --c-flat: #f2f2f2;
  --c-stale: #9a9a9a;  --c-closed: #cfcfcf;  --c-blocked: #c48bff;  --c-pending: #6e6e6e;
  --c-focus: #4da3ff;  --c-error: #ff5252;  --c-warn: #ffb000;  --c-ok: #37d67a;  --c-info: #4da3ff;
  --c-grid-line: #1f1f1f;  --c-axis: #8c8c8c;  --c-crosshair: #ffb000;
  --c-series-1: #4da3ff; --c-series-2: #ffb000; --c-series-3: #37d67a; --c-series-4: #ff7ab6; --c-series-5: #c48bff; --c-series-6: #ffd166;
  --flash-up-bg: rgba(55,214,122,.35);  --flash-down-bg: rgba(255,82,82,.35);  --flash-flat-bg: rgba(242,242,242,.18);
  --flash-ms: 700ms;
}
:root[data-theme="light"] {
  --c-bg: #ffffff; --c-bg-panel: #fafafa; --c-bg-header: #ececec; --c-bg-row-alt: #f4f4f4; --c-bg-selected: #dbe9f7;
  --c-value: #111111; --c-label: #8a5a00; --c-muted: #6b6b6b;
  --c-up: #0f8a3c; --c-down: #c62828; --c-flat: #111111;
  --c-stale: #7a7a7a; --c-closed: #444444; --c-blocked: #6a1fbf; --c-pending: #9a9a9a;
  --c-focus: #1565c0; --c-error: #c62828; --c-warn: #8a5a00; --c-ok: #0f8a3c; --c-info: #1565c0;
  --c-grid-line: #e0e0e0; --c-axis: #6b6b6b; --c-crosshair: #8a5a00;
  --flash-up-bg: rgba(15,138,60,.25); --flash-down-bg: rgba(198,40,40,.25); --flash-flat-bg: rgba(17,17,17,.12);
}
[data-st="stale"]  { color: var(--c-stale); }   [data-st="stale"]::after  { content: " ·"; }
[data-st="closed"] { color: var(--c-closed); }
[data-st="blank"]  { color: var(--c-blocked); }
[data-st="na"]     { color: var(--c-muted); }
[data-dir="up"]   .chg { color: var(--c-up); }   [data-dir="down"] .chg { color: var(--c-down); }
.flash-up   { animation: flash-up   var(--flash-ms) ease-out 1; }
.flash-down { animation: flash-down var(--flash-ms) ease-out 1; }
@keyframes flash-up   { from { background-color: var(--flash-up-bg); }   to { background-color: transparent; } }
@keyframes flash-down { from { background-color: var(--flash-down-bg); } to { background-color: transparent; } }
@media (prefers-reduced-motion: reduce) { .flash-up, .flash-down { animation-duration: 120ms; } }
```

`theme/colours.ts` exports the token names as a typed enum for the canvas renderer, which reads them
once per theme change with `getComputedStyle(document.documentElement)`.

### 12.3 Density type stack (`theme/type.ts`, `theme/density.ts`)

Monospace everywhere numbers appear; tabular figures; no whitespace beyond one cell padding (TERM-11).

```ts
export const FONT_MONO = '"IBM Plex Mono", "JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
export const FONT_UI   = FONT_MONO;                                   // one family; UI text is mono too
export const DENSITY = {
  compact:     { fontPx: 11, rowPx: 16, cellPadCh: 0.5, headerPx: 18, flashMs: 350 },
  normal:      { fontPx: 12, rowPx: 18, cellPadCh: 0.5, headerPx: 20, flashMs: 700 },
  comfortable: { fontPx: 13, rowPx: 22, cellPadCh: 0.75, headerPx: 24, flashMs: 700 },
} as const;
// CSS: html { font: <fontPx>px/<rowPx>px var(--font-mono); font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1, "zero" 1; }
// weights: 400 body, 500 labels/headers, 600 focused row key and panel titles; no italics
```

Column widths are in `ch` derived from `fmt`: `px` 10, `pct` 8, `bp` 7, `int`/`shares` 12, `ccy` 12,
`date` 10, `datetime` 19, `text` from the column's longest header/value capped at 32; the key column is
frozen. Rows alternate `--c-bg-row-alt`; the focused row inverts label colour; selection uses
`--c-bg-selected`. Density is set on `<html data-density>` by `/density` or the settings store and is
per device (§7.1).

---

## 13. CSV export from the same payload (FUNC-03, API-05)

### 13.1 PRINT (`Ctrl+P`, key bar `PRINT`, `ScreenCtx.export()`)

`export/csv.ts#exportResult(panelId)`:

1. `frame = selectFrame(panelId)`; no `meta` → footer `NOTHING TO PRINT`.
2. `url = sdk.fn.csvUrl(frame.fn, { resultId: frame.meta.resultId })` (API.md §9, §10); when the result
   is older than 10 minutes the fallback form is used: `{ params: frame.params, security: frame.security
   ? { id } : undefined, validAt: meta.asOf.validAt, knownAt: meta.asOf.knownAt }` so the server
   re-resolves at the same as-of (`x-regenerated: true`, shown as a toast).
3. `save.navigate(url)` — a hidden `<a href download>` click; the response's `content-disposition`
   names the file. The client never builds CSV text: the server runs `core/functions/csv.ts#toCsv` on the
   cached payload, so the numbers are the screen's numbers.
4. `403 ENTITLEMENT_DENIED` (any denied field aborts the whole export, ARCHITECTURE §10 rule 2) is
   surfaced through `save.ts`'s error path (`fetch` of the URL is done by the SDK's `sdk.fn.csv` when the
   navigation would fail — the SDK requests first with `HEAD`-equivalent `csv()` on error to obtain the
   envelope) and rendered in the footer: `EXPORT DENIED: PX_BID LICENCE_FORBIDS_USAGE (trace 3f2a)` (§14).
5. `fn.export` is written by the server; the client emits nothing extra.

### 13.2 Grid data export (`Ctrl+E`)

For a focused `grid` whose rows carry `instrumentId` and whose columns carry `fieldId`, `export/csv.ts`
builds `DataRequest { kind:'realtime', securities: rows.map(r => ({ id })), fields: columns.map(c => c.fieldId), usage:'export' }`
and calls `sdk.rest.request('Data.Csv', …)` (`POST /data/csv`, API.md §9); the returned `text` is
handed to `save.saveTextAsFile(filename, text)` (server-produced bytes, unmodified). Grids without
instrument rows (e.g. FA statements) have no `Ctrl+E`; PRINT covers them.

---

## 14. Error and entitlement-downgrade display (ENTL-05)

### 14.1 Error surface

Every `TerminalApiError` (API.md §10.1) lands in `frame.error` and is shown on the panel footer as
`CODE · message · trace 3f2a…` with `message` verbatim (API.md §2); the trace id is copyable via
`/trace`. `retryable:true` adds `R RETRY` (footer key) honouring `retryAfterMs`. Specific behaviours:

| `ErrorCode` | Client behaviour |
| --- | --- |
| `VALIDATION_FAILED` (`location:'fnParams'`) | footer lists `details.issues` paths; `details.grammar` renders as a one-line usage hint (`GP [range] TYPE= ADJ= …`) |
| `AMBIGUOUS_SECURITY` | `PromptDialog` listing `details.candidates` (InstrumentSummary rows); `Enter` re-executes with `{ id }` |
| `SECURITY_NOT_FOUND` / `NOT_IN_UNIVERSE` | footer + autocomplete row `SECF <text>`; `NOT_IN_UNIVERSE` text names the sector (`Corp is not covered in v1`) |
| `NO_SECURITY_CONTEXT` | footer `NO SECURITY LOADED` (client-side `NO_SECURITY_LOADED` normally prevents the request) |
| `FUNCTION_NOT_APPLICABLE` | footer message + `details.applicable` + `help.related` codes as footer keys |
| `ENTITLEMENT_DENIED` (whole request or export) | footer `DENIED` + `details.reasons[]` as `field=reason` list; screen keeps the previous payload dimmed |
| `RESULT_EXPIRED` | transparent re-run with `launchKind:'refresh'` |
| `SESSION_EXPIRED` / `AUTH_REQUIRED` | login screen, drafts preserved in memory |
| `SESSION_SUPERSEDED` | lock screen with `details.supersededBy.deviceLabel` (§2) |
| `MFA_REQUIRED` | WebAuthn step |
| `QUOTA_EXCEEDED` / `RATE_LIMITED` | status bar quota gauge turns `--c-warn`; footer with `resetsAt`/`retryAfterMs` |
| `PROTOCOL_VERSION` | full-width banner `RELOAD FOR THE NEW VERSION` (`Enter` reloads); nothing else works |
| `PROVIDER_UNAVAILABLE` / `STARTING` | footer with `details.sourceId`; existing cells go `stale`; auto-retry after `retryAfterMs` up to 3 times |
| `WORKSPACE_VERSION_CONFLICT` | §7.2 merge |
| `MESSAGE_POLICY_BLOCKED` | MSG composer footer with `details.rule` |
| `INTERNAL` / `REPLAY_MISS` | footer + trace id; `REPLAY_MISS` is loud in dev (toast) |

WS `err { fatal:true }` shows a toast and the SDK reconnects; `bye` codes map to status-bar text
(`4008 SLOW CONSUMER — reconnecting with wider conflation`).

### 14.2 Entitlement state (never a stale higher-tier number)

| Source | Display |
| --- | --- |
| `meta.entitlement[]` `downgrade` | PanelHeader badge `DELAYED 15m` / `EOD` (`effectiveTier`), tooltip `reason`; footer note once per payload |
| `meta.entitlement[]` `deny` | the affected `Cell`s render `—` in `--c-blocked` with `r` in the tooltip; column header gets a `⊘` glyph when every row is denied |
| `snap.r` / `QuoteView.r` per field | same cell rule from the live path; `subAck.rejected[]` → row badge `NOT ENTITLED` / `UNKNOWN` / `QUOTA` and no subscription |
| WS `downgrade` frame | toast + header badge; every value of the subject is replaced by the next `snap` (rule 4, API.md §6.3) — cells show `pending` (`--c-pending`, text unchanged but `data-st=stale`) until it arrives |
| `status 'shed'` | row `SHED` badge, cells stale-grey; re-subscribed when visible (§9) |
| `meta.unavailable[]` | columns/fields render `—` with reason badge `NO_SOURCE` and the `detail` text in HELP (EE estimates, ECO consensus) |
| `meta.staleness` / `meta.tier` | header badges; CSV header lines carry the same (§13) |

The client never decides entitlement: it renders exactly the reason the server sent (ARCHITECTURE §10
"the screen only renders the badge").

---

## 15. HELP (TERM-09)

`F1`/`HELP` follows FUNCTIONS §4: `HelpOverlay` over the right third of the focused panel with the
`HelpPayload` `function` view (`sdk.fn.help(code, assetClass)`), the field definitions of the visible
`fieldId`s, the merged keymap (manifest + screen + region defaults), sources with attribution, related
codes (`Enter` launches), and the last trace id. A second `F1` within 10 s or while open opens
`TicketDialog` pre-filled with `panelId`, `functionCode`, `security`, `params`, `screenState` (visible
field ids + `provIdx`), `traceId`, last error; `GO` submits `sdk.help.openTicket`; the confirmation shows
`ticketId` and opens `MSG` on the helpdesk room in the next panel. `fn.help` and `ticket.open` events
per FUNCTIONS §1.10.

---

## 16. Performance budgets and measurement

### 16.1 Budgets (NFR table rows that touch the client)

| NFR row | Client budget | Where measured |
| --- | --- | --- |
| Keystroke to visual feedback < 16 ms | `cmd:input → ac:paint` ≤ 16 ms (one frame) for 95 % of keystrokes; parse+rank ≤ 4 ms p95 | `test/shell/autocomplete.frame.test.tsx` (jsdom timing, fails > 12 ms), `e2e/autocomplete.spec.ts` (Performance marks) |
| Autocomplete result set < 80 ms p95 | local path ≤ 16 ms; server fallback ≤ 80 ms including 60 ms debounce | `StatusResponse.timings.autocompleteP95Ms` + `search.select.latencyMs`; e2e asserts p95 < 80 ms over 200 keystrokes |
| Function launch to first paint < 500 ms p95 (Tier 1) | `go → fn:first-paint` ≤ 500 ms p95; client overhead (dispatch + resolve cache + skeleton) ≤ 25 ms | `usage fn.launch.durationMs` (client-reported); `e2e/command-line.spec.ts` over the 14 Tier-1 codes × seed securities |
| Plant to client screen < 50 ms p99 | client portion: WS frame decode → DOM write ≤ 1 frame (16.7 ms) p99 | `ws:frame → grid:raf-end` measure in `e2e/live-grid.spec.ts` |
| News wire to headline < 1 s p95 | `n:*` delta → list row painted ≤ 100 ms | `e2e/news.spec.ts` on replayed RSS |
| Grid (TERM-08) | 2 000 visible live cells at 5 000 changes/s: rAF callback < 8 ms p95 (jsdom) / < 16 ms (Chrome) | §10.6 |
| Chart (CHRT-02) | base redraw 1 y daily + 3 studies < 4 ms; 1 M-point line first draw < 16 ms after downsample; stream append < 2 ms | `test/chart/render-budget.test.ts` (recorded-context stub counts ops and times compute), `e2e/chart.spec.ts` |
| Universe index build | < 300 ms in the worker; main thread never blocked > 4 ms by the swap | `test/command/localIndex.test.ts` |
| Bundle | initial route chunk ≤ 300 KB gzip (shell + sdk + core command); `chart` and each Tier-3 screen lazy | `vite build --report` checked in CI (`scripts/check-bundle.ts`) |
| Memory | 4 panels of QM (500 rows each) + GP: heap < 150 MB, no growth over 10 min replay (leak test) | `e2e/soak.spec.ts` (nightly) |

### 16.2 Marks (`perf/marks.ts`)

`performance.mark` names: `cmd:input`, `ac:rank-end`, `ac:paint`, `go`, `fn:request`, `fn:response`,
`fn:first-paint`, `ws:frame`, `grid:raf-start`, `grid:raf-end`, `chart:draw-start`, `chart:draw-end`,
`ws:reconnect`. `performance.measure` pairs: `ac` (`cmd:input`→`ac:paint`), `launch` (`go`→`fn:first-paint`),
`grid:raf`, `chart:draw`. `window.__terminalPerf` keeps the last 2 000 measures with `p50/p95/p99`
accessors for Playwright; `fn.launch.durationMs` is the `launch` measure for that frame's trace id.
Marks are compiled out in production builds except `launch` (needed for FUNC-04).

---

## 17. Decision log

| Topic | Chosen | Why (one line) |
| --- | --- | --- |
| Grid rendering | DOM cells with imperative updates (A, C; ARCHITECTURE §15) not canvas (B) | keyboard focus, selection, text, accessibility come free; the flash path never touches React |
| Flash duration | 700 ms (A, ARCHITECTURE §6.6) not 150 ms (C); 350 ms in `compact` | 150 ms is invisible at 10 s poll cadence; density users trade motion for speed |
| Command input | uncontrolled input + transient store (B) | one keystroke must not re-render the panel tree |
| Autocomplete row 0 | always `parse(text)[0]` (FUNCTIONS §3.3) | GO never executes something other than what is shown first |
| MENU key | `Escape` ladder ending in frame pop (FUNCTIONS §9); `Alt+←/→` walk without popping | no spare physical key; the ladder matches Bloomberg's "previous screen" |
| Multi-window transport | Web Locks leader + BroadcastChannel relay, one WS per session | API.md §6.3 closes a second socket with `4003`; a SharedWorker would need its own WS client build |
| Theme/density persistence | per device (localStorage) | no `users` column exists (DATA_MODEL §11); a desk setting is a device preference |
| Chart canvas | Canvas 2D, two layers, M4 downsampling, no WebGL | one renderer for price, curve, surface and sparkline; WebGL would duplicate text/axis drawing |
| Studies count | 22 with an incremental `update()` contract | covers every study the Tier-1/2 screens name; the registry shape scales to CHRT-04's ~100 |
| Live sort | throttled re-sort (1 s), freezable | rows jumping on every delta defeats a monitor; the throttle keeps order honest |
| Provenance panel | `Ctrl+I` from any cell, row, series, marker | one gesture for DATA-10 everywhere |
| Ctrl+E | `POST /data/csv` for instrument×field grids only | PRINT is the general path; `Ctrl+E` exists for long-format screens (FUNCTIONS §2.6) |
| Payload in store | frame holds `payload` + `meta` in `panelsStore` | screens are pure functions of props; SWR cache lives in `ScreenHost` |
| Workspace conflict | per-key dirty-wins merge, then one retry | API.md §5.7 prescribes "last-writer-wins per panel and retry"; dirty keys make "writer" precise |

## 18. Open questions (not resolvable from the inputs)

1. **Server-side theme/density.** `users` has no preferences column and `WorkspaceLayout` is a closed
   `schema:1` shape; theme and density are therefore per device. Adding `layout.ui: { theme, density }`
   would need an API.md/DATA_MODEL change (schema 2) — cheap, but a contract change.
2. **Multi-window e2e (TERM-10).** The leader/relay design is specified and unit-tested; Playwright with
   two windows sharing `navigator.locks` needs a persistent context and is not in the v1 e2e set.
3. **`keepalive` on the final workspace save.** `RestClient.request` `init` (API.md §10.1) has no
   `keepalive` option; the `pagehide` flush may be cut off by the browser. Extending `init` with
   `keepalive?: boolean` is an SDK-only addition.
4. **Study catalogue (CHRT-04).** 22 of ~100; the remaining studies are a list to be prioritised by
   `usage_events` (`fn.param` with `changed:['studies']`) — the roadmap mechanism FUNC-04 was built for.
5. **PnF and market-profile reference values.** No independent implementation or golden exists for the
   `pnf`/`profile` transforms; they are tested for shape invariants only until a reference is chosen.
6. **`F11` (Curncy) on macOS Chrome** — FUNCTIONS §10 Q5; the key bar is the guaranteed path.
7. **Per-panel conflation.** The session-wide minimum (FUNCTIONS §10 Q6) means a `Q` screen with
   `conflationMs:100` speeds up every panel's deltas; per-subject conflation is a protocol addition.
8. **Column widths outside monitors.** Only QM/W (`MonitorSpec.columns`) persist widths server-side;
   other grids keep widths per device in `localStorage` (`terminal.grid.<CODE>.<nodeId>`), which is not
   "the desk back on any machine" in the strict TERM-05 sense.
