// packages/web/src/shell/Panel.tsx — one panel: a header, a command line, a screen and a footer.
//
// CLIENT.md §3.1 L230-240. A panel is the unit of the terminal (TERM-04): its own frame stack, its
// own command line and history, its own context for the parser. This file is the frame stack and
// the screen; the command line and the overlays arrive through slots, because they are other files
// in this work package and a panel that imported them could not be built or tested before they
// landed.
//
// Three things worth stating, because each is a decision rather than an obvious translation:
//
//   1. **Back and forward are buttons, not only keys.** `Alt+←`/`Alt+→` reach them through the
//      dispatcher, but the browser and the OS both claim those chords, and CLIENT §3.3's key bar
//      exists precisely because a terminal may not depend on a key the host might swallow. So the
//      frame stack has a visible, focusable, disabled-when-empty control — the same reasoning as
//      the key bar, applied to the one navigation a user performs constantly.
//
//   2. **The footer's key hints follow real DOM focus**, not a modelled region. A `focusin`
//      listener reads the nearest `[data-node-id]`, and `keyboard/focus.ts#collectFocusNodes` says
//      what kind of node that is; `keymap.ts#bindingApplies` then filters the manifest's and the
//      screen's bindings the same way the dispatcher will. Hints that disagreed with what the keys
//      actually do would be worse than no hints.
//
//   3. **Everything that needs the network is a port.** `ScreenCtx` (FUNCTIONS.md §1.5) is ten
//      methods, and eight of them end in a request — `command/dispatch.ts` performs them, with the
//      SDK and the function registry in hand. The Shell builds that once and passes it down as
//      `PanelActions`; a Panel with no actions attached renders and navigates its frame stack
//      perfectly well and simply cannot run a new function, which is the truth about it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

import type { KeyBinding } from '@terminal/core';
import { registry } from '@terminal/core';

import { bindingApplies, formatCombo, parseCombo } from '../keyboard/keymap.js';
import type { KeyRegion } from '../keyboard/keymap.js';
import { collectFocusNodes } from '../keyboard/focus.js';
import { ScreenRenderer } from '../screen/ScreenRenderer.js';
import type { LiveView, ScreenCtx, ScreenProps, ScreenSpec } from '../screen/types.js';
import type { CellFormatContextValue } from '../screen/widgets/CellView.js';
import type { ScreenActions, WidgetRegistry } from '../screen/widgets/registry.js';
import { screenModules } from '../screens/index.js';
import type { Frame } from '../state/panels.js';
import { selectCanGoBack, selectCanGoForward, selectFrame, usePanelsStore } from '../state/panels.js';

/* ---------------------------------------------------------------------------------------------- */
/* Ports                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/** The screen registry, injectable so a test can render one screen instead of importing 38. */
export type AnyScreenProps = ScreenProps<Record<string, unknown>, unknown>;
export type AnyScreen = (props: AnyScreenProps) => ScreenSpec;
export type ScreenRegistry = Readonly<Record<string, { Screen: AnyScreen } | undefined>>;

/**
 * The 38 shipped screens, seen generically.
 *
 * Exactly one cast in this package, and it is here: each `Screen.tsx` is a
 * `FunctionScreen<Params, Payload>` for *its own* params and payload, and a registry keyed by a
 * runtime string cannot carry 38 different type arguments. The runner has already validated the
 * payload against the manifest before it reached the frame, so the pairing is checked — just
 * upstream of this line rather than on it.
 */
export const SCREENS: ScreenRegistry = screenModules as unknown as ScreenRegistry;

/**
 * What a panel asks the shell to do on a screen's behalf — `ScreenCtx` minus the two methods a
 * panel can honour by itself (`focus` is DOM, `provenance` is the renderer's own panel).
 *
 * Implemented by `Shell.tsx` over `command/dispatch.ts`.
 */
export interface PanelActions {
  /** Execute a command string in this panel. */
  navigate(panelId: string, command: string): void;
  /** Execute it in the next panel (the Shift+Enter convention). */
  navigateNext(panelId: string, command: string): void;
  /** Re-run the panel's function with patched params, keeping the frame (`fn.param`). */
  setParams(panelId: string, patch: Record<string, unknown>): void;
  /** `POST /functions/:code/page`. */
  page(panelId: string, direction: 'fwd' | 'back'): void;
  /** PRINT → the server's CSV export; never serialised locally (FUNC-03). */
  exportResult(panelId: string): void;
  /** The modal typeahead of `ScreenCtx.prompt`. */
  prompt(
    panelId: string,
    kind: 'security' | 'date' | 'text' | 'field' | 'watchlist',
    opts?: { label?: string; initial?: string },
  ): Promise<string | null>;
  /** An external link. */
  openUrl(url: string): void;
  /** A provenance panel was opened for `meta.provenance[provIdx]` (DATA-10) — for usage/telemetry. */
  provenance(panelId: string, provIdx: number): void;
}

/**
 * A shell with no dispatcher attached. `openUrl` is the one method that needs nothing else and so
 * is the one method that actually works; the rest do nothing, visibly, rather than pretending.
 */
export const INERT_PANEL_ACTIONS: PanelActions = {
  navigate: () => undefined,
  navigateNext: () => undefined,
  setParams: () => undefined,
  page: () => undefined,
  exportResult: () => undefined,
  prompt: () => Promise.resolve(null),
  openUrl: (url) => {
    globalThis.open?.(url, '_blank', 'noopener,noreferrer');
  },
  provenance: () => undefined,
};

/** What a slot is handed. */
export interface PanelSlotProps {
  readonly panelId: string;
  /** 1-based, as the header and the `/panel n` command name it. */
  readonly ordinal: number;
  readonly focused: boolean;
  readonly frame: Frame | undefined;
}

/**
 * The parts of a panel this file does not own: `CommandLine`/`Autocomplete` and the per-panel
 * overlays (`HelpOverlay`, `TicketDialog`, `PromptDialog`, the pickers). Shell passes them in once.
 */
export interface PanelSlots {
  commandLine?: (props: PanelSlotProps) => ReactNode;
  overlay?: (props: PanelSlotProps) => ReactNode;
  /** Extra header content — the tier and staleness badges of `PanelHeader` (CLIENT §3.1). */
  headerExtra?: (props: PanelSlotProps) => ReactNode;
}

/* ---------------------------------------------------------------------------------------------- */
/* The inert live view                                                                              */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `ScreenProps.live` before WP-13's socket exists.
 *
 * `blank` and not a fabricated value: `LiveView.get` is asked for the *current* value of a
 * (subject, field), and with no live client there is none. Returning the payload's last number
 * under `st: 'live'` is exactly the lie TERM-12 forbids, so the honest answer is the blank cell,
 * which every widget already renders as an em dash.
 */
export const NO_LIVE_VIEW: LiveView = {
  get: (subject, field) => ({ v: null, st: 'blank', provIdx: -1, live: { subject, field } }),
  state: () => 'blank',
};

/* ---------------------------------------------------------------------------------------------- */
/* Key hints                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

export interface KeyHint {
  readonly key: string;
  readonly description: string;
}

/** How many hints fit on a footer row before they stop being readable. */
export const MAX_KEY_HINTS = 6;

/**
 * The bindings active on `region`, rendered as `KEY description` pairs.
 *
 * Two orderings matter here and neither is arbitrary:
 *
 *   * The screen's own `keymap` comes after the manifest's and wins on a collision.
 *     `ScreenSpec.keymap` is documented as *additions* that may be dynamic (per tab), and a screen
 *     that rebinds a key for the tab it is showing must be what the footer reports.
 *   * Bindings scoped to the focused region (`when: 'grid' | 'chart' | 'form'`) are listed before
 *     the `always` ones. A manifest typically has a dozen `always` navigation keys and one or two
 *     that only work where the user is standing, and those one or two are exactly what a footer
 *     with room for six should show — dropping them off the end would leave the hints technically
 *     correct and practically useless.
 */
export function keyHints(
  manifestKeymap: readonly KeyBinding[],
  screenKeymap: readonly KeyBinding[] | undefined,
  region: KeyRegion | null,
): KeyHint[] {
  if (region === null) return [];
  const byKey = new Map<string, KeyBinding>();
  for (const binding of [...manifestKeymap, ...(screenKeymap ?? [])]) {
    if (!bindingApplies(binding, region)) continue;
    byKey.set(binding.key, binding);
  }
  const applicable = [...byKey.values()];
  const scoped = applicable.filter((b) => (b.when ?? 'always') !== 'always');
  const general = applicable.filter((b) => (b.when ?? 'always') === 'always');
  return [...scoped, ...general].slice(0, MAX_KEY_HINTS).map((binding) => ({
    key: displayKey(binding.key),
    description: binding.description,
  }));
}

/** `'Shift+ArrowUp'` → the canonical spelling `keymap.ts` prints, falling back to the raw text. */
function displayKey(spec: string): string {
  try {
    return formatCombo(parseCombo(spec));
  } catch {
    return spec;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Styles                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

const S = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    background: 'var(--c-bg-panel)',
    // Longhand, not the `border` shorthand: `focused` below overrides `borderColor` alone, and
    // React warns (correctly) about a rerender that removes a longhand while a shorthand is set.
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'var(--c-grid-line)',
    boxShadow: 'none',
    overflow: 'hidden',
  },
  focused: {
    // TERM-04: the ring is the answer to "where does the next keystroke go?". Two signals, because
    // a 1px border on a dark panel is easy to miss at a glance across four panels.
    borderColor: 'var(--c-focus)',
    boxShadow: 'inset 0 0 0 1px var(--c-focus)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '1ch',
    minHeight: 'var(--header-px)',
    padding: '0 1ch',
    background: 'var(--c-bg-header)',
    color: 'var(--c-label)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  },
  nav: { display: 'flex', gap: '0.5ch' },
  navButton: {
    color: 'var(--c-label)',
    cursor: 'pointer',
    padding: '0 0.5ch',
    lineHeight: 1,
  },
  navDisabled: { color: 'var(--c-pending)', cursor: 'default' },
  code: { fontWeight: 'var(--w-strong)' },
  muted: { color: 'var(--c-muted)' },
  spacer: { flex: '1 1 auto' },
  trace: { color: 'var(--c-pending)' },
  body: { position: 'relative', flex: '1 1 auto', minHeight: 0, overflow: 'auto' },
  empty: { padding: '1ch', color: 'var(--c-muted)' },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: '2ch',
    minHeight: 'var(--row-px)',
    padding: '0 1ch',
    borderTop: '1px solid var(--c-grid-line)',
    color: 'var(--c-muted)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  },
  error: { color: 'var(--c-error)' },
  hints: { display: 'flex', gap: '1.5ch' },
  hintKey: { color: 'var(--c-label)' },
} satisfies Record<string, CSSProperties>;

/* ---------------------------------------------------------------------------------------------- */
/* The panel                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

export interface PanelProps {
  panelId: string;
  ordinal: number;
  focused: boolean;
  /** Clicking or tabbing into a panel focuses it — the pointer path for TERM-04. */
  onFocus: (panelId: string) => void;
  actions?: PanelActions | undefined;
  slots?: PanelSlots | undefined;
  widgets?: WidgetRegistry | undefined;
  screens?: ScreenRegistry | undefined;
}

export function Panel({
  panelId,
  ordinal,
  focused,
  onFocus,
  actions = INERT_PANEL_ACTIONS,
  slots,
  widgets,
  screens = SCREENS,
}: PanelProps): ReactElement {
  const frame = usePanelsStore(selectFrame(panelId));
  const canGoBack = usePanelsStore(selectCanGoBack(panelId));
  const canGoForward = usePanelsStore(selectCanGoForward(panelId));

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  const slotProps: PanelSlotProps = { panelId, ordinal, focused, frame };

  /** `ScreenCtx` for this panel: the two methods a panel owns, the rest delegated. */
  const ctx = useMemo<ScreenCtx<Record<string, unknown>>>(
    () => ({
      panelId,
      setParams: (patch) => {
        actions.setParams(panelId, patch);
      },
      navigate: (command) => {
        actions.navigate(panelId, command);
      },
      navigateNext: (command) => {
        actions.navigateNext(panelId, command);
      },
      export: () => {
        actions.exportResult(panelId);
      },
      page: (direction) => {
        actions.page(panelId, direction);
      },
      focus: (nodeId) => {
        const root = bodyRef.current;
        if (root === null) return;
        const escaped = nodeId.replace(/["\\]/g, (c) => `\\${c}`);
        const node = root.querySelector<HTMLElement>(`[data-node-id="${escaped}"]`);
        const target =
          node === null
            ? null
            : node.tabIndex >= 0
              ? node
              : node.querySelector<HTMLElement>('[tabindex="0"], input, select, button, textarea');
        (target ?? node)?.focus();
      },
      prompt: (kind, opts) => actions.prompt(panelId, kind, opts),
      provenance: (provIdx) => {
        actions.provenance(panelId, provIdx);
      },
      openUrl: (url) => {
        actions.openUrl(url);
      },
    }),
    [actions, panelId],
  );

  const code = frame?.fn ?? null;
  const entry = code === null ? undefined : screens[code];
  const manifest = code === null ? undefined : registry.get(code);

  const spec: ScreenSpec | null = useMemo(() => {
    if (entry === undefined || frame === undefined) return null;
    const props: AnyScreenProps = {
      payload: frame.payload,
      params: frame.params,
      instrument: frame.instrument ?? null,
      meta: frame.meta,
      live: NO_LIVE_VIEW,
      ctx,
      ...(frame.error === undefined
        ? {}
        : {
            error: {
              code: frame.error.code,
              message: frame.error.message,
              traceId: frame.error.traceId,
            },
          }),
    };
    return entry.Screen(props);
  }, [entry, frame, ctx]);

  /** `instruments.currency` / `price_decimals` — what a `ccy` or `px` cell cannot carry itself. */
  const formatCtx = useMemo<CellFormatContextValue>(() => {
    const instrument = frame?.instrument ?? null;
    if (instrument === null) return {};
    return { currency: instrument.currency, priceDecimals: instrument.priceDecimals };
  }, [frame?.instrument]);

  // `ScreenCtx` already satisfies `ScreenActions` structurally; the four are re-wrapped rather
  // than referenced so that no method travels away from the object it was defined on.
  const screenActions = useMemo<ScreenActions>(
    () => ({
      navigate: (command) => {
        ctx.navigate(command);
      },
      navigateNext: (command) => {
        ctx.navigateNext(command);
      },
      openUrl: (url) => {
        ctx.openUrl(url);
      },
      provenance: (provIdx) => {
        ctx.provenance(provIdx);
      },
    }),
    [ctx],
  );

  // The footer's hints follow the element that actually has focus, which is what the dispatcher
  // will route the next key to.
  const focusNodes = useMemo(() => (spec === null ? [] : collectFocusNodes(spec.body)), [spec]);
  useEffect(() => {
    if (spec === null) setFocusedNodeId(null);
  }, [spec]);

  const onFocusIn = useCallback(
    (event: { target: EventTarget | null }): void => {
      onFocus(panelId);
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const node = target.closest<HTMLElement>('[data-node-id]');
      setFocusedNodeId(node?.dataset.nodeId ?? null);
    },
    [onFocus, panelId],
  );

  const region: KeyRegion | null = useMemo(() => {
    if (focusedNodeId === null) return null;
    const node = focusNodes.find((n) => n.id === focusedNodeId);
    return node === undefined ? null : node.kind;
  }, [focusNodes, focusedNodeId]);

  const hints = useMemo(
    () => keyHints(manifest?.keymap ?? [], spec?.keymap, region),
    [manifest, spec, region],
  );

  // Read through `getState()` rather than selecting the method: the store's actions are stable, so
  // subscribing to them buys nothing, and a selected method is a method separated from its object.
  const onBack = useCallback(() => {
    usePanelsStore.getState().goBack(panelId);
  }, [panelId]);
  const onForward = useCallback(() => {
    usePanelsStore.getState().goForward(panelId);
  }, [panelId]);

  const security = frame?.security?.display ?? frame?.instrument?.display ?? null;
  const traceId = frame?.traceId ?? '';

  return (
    <section
      style={focused ? { ...S.panel, ...S.focused } : S.panel}
      data-panel={panelId}
      data-focused={focused ? 'true' : 'false'}
      aria-label={`Panel ${String(ordinal)}`}
      {...(focused ? { 'aria-current': 'true' as const } : {})}
      onFocusCapture={onFocusIn}
      onMouseDown={() => {
        onFocus(panelId);
      }}
    >
      <div style={S.header}>
        <span style={S.nav} role="group" aria-label={`Panel ${String(ordinal)} history`}>
          <button
            type="button"
            style={canGoBack ? S.navButton : { ...S.navButton, ...S.navDisabled }}
            onClick={onBack}
            disabled={!canGoBack}
            aria-label={`Back in panel ${String(ordinal)}`}
            title="Back (Alt+←)"
          >
            ◀
          </button>
          <button
            type="button"
            style={canGoForward ? S.navButton : { ...S.navButton, ...S.navDisabled }}
            onClick={onForward}
            disabled={!canGoForward}
            aria-label={`Forward in panel ${String(ordinal)}`}
            title="Forward (Alt+→)"
          >
            ▶
          </button>
        </span>
        <span>{panelId}</span>
        <span style={S.code}>{code ?? '—'}</span>
        {security === null ? null : <span style={S.muted}>{security}</span>}
        {slots?.headerExtra?.(slotProps)}
        <span style={S.spacer} />
        {traceId === '' ? null : (
          <span style={S.trace} title={`Trace ${traceId}`}>
            {`trace ${traceId.slice(0, 8)}`}
          </span>
        )}
      </div>

      {slots?.commandLine?.(slotProps)}

      <div style={S.body} ref={bodyRef} data-testid={`panel-body-${panelId}`}>
        {spec !== null ? (
          <ScreenRenderer
            spec={spec}
            meta={frame?.meta}
            actions={screenActions}
            widgets={widgets}
            format={formatCtx}
          />
        ) : frame === undefined ? (
          <p style={S.empty}>{`Panel ${String(ordinal)} is empty — type a command and press GO.`}</p>
        ) : code === null ? (
          <p style={S.empty}>
            {security === null
              ? 'No function loaded in this panel.'
              : `${security} loaded — type a function code and press GO.`}
          </p>
        ) : (
          <p style={S.empty}>{`No screen is registered for ${code}.`}</p>
        )}
        {slots?.overlay?.(slotProps)}
      </div>

      <div style={S.footer} data-testid={`panel-footer-${panelId}`}>
        {spec?.footer === undefined ? null : (
          <span data-testid={`panel-sources-${panelId}`}>
            {[
              spec.footer.sources.join(' · '),
              ...(spec.footer.asOf === undefined ? [] : [`as of ${spec.footer.asOf}`]),
              ...(spec.footer.notes ?? []),
            ]
              .filter((part) => part !== '')
              .join(' · ')}
          </span>
        )}
        {frame?.error === undefined ? null : (
          <span style={S.error} role="alert" data-testid={`panel-error-${panelId}`}>
            {`${frame.error.code} · ${frame.error.message} · trace ${frame.error.traceId.slice(0, 8)}`}
          </span>
        )}
        <span style={S.spacer} />
        {hints.length === 0 ? null : (
          <span style={S.hints} role="group" aria-label="Key hints">
            {hints.map((hint) => (
              <span key={hint.key}>
                <span style={S.hintKey}>{hint.key}</span> {hint.description}
              </span>
            ))}
          </span>
        )}
      </div>
    </section>
  );
}

export default Panel;
