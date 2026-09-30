// packages/web/src/widgets.tsx — the `WidgetRegistry` construction site (CLIENT.md §10.2, §11;
// `screen/widgets/registry.ts` is the contract this file satisfies).
//
// `screen/widgets/registry.ts` says it plainly: "a registry with nothing in it is the state WP-12
// ships in, and each widget then renders a placeholder that names what it is waiting for". Nothing
// in fourteen work packages ever built one, so every grid on all 38 screens drew "waiting for
// LiveGrid (WP-13)" and every chart "waiting for ChartCanvas (WP-14)" — with both components
// present, tested and unreachable. This file is the two lines that were missing, plus the one thing
// that is not a line: the `custom` nodes.
//
// ## Why `custom` matters more than `chart` here
//
// `WidgetRegistry.ChartCanvas` serves the `chart` NODE — and **no screen emits one**. Every chart in
// this product is a `custom` node: `GP` and `GIP` emit `PriceChart`, `GC` and `CRVF` emit
// `CurveChart`, `OMON` and `OVML` emit `OptionSurface`, each with `props: { spec }` carrying the
// `ChartSpec` its own `*ChartSpec()` builder produced. A registry that filled `ChartCanvas` and left
// `custom` empty would therefore satisfy the letter of §10.2 and still leave every chart screen in
// the terminal on a placeholder. `ChartCanvas` is registered anyway, because the contract is the
// contract and a screen added later may well use the node.
//
// The three chart-shaped `custom` components are one adapter: take `props.spec`, hand it to
// `ChartCanvas`. They are registered under three names rather than one because the screens address
// them by name and a name with nothing behind it is a placeholder.
//
// ## The two `custom` names that used to be missing, and what they are now
//
//   * **`Sparkline`** (DES `rate`, ECO, EE) is `screen/widgets/Sparkline.tsx`. It was left out here
//     because the node passes `{ points: [{t, v}], fmt }` with no `provIdx` on any point, and
//     DATA-10 does not allow a drawn number whose source cannot be named. That reasoning holds for
//     the numbers and not for the picture, which is the distinction the component is built on: it
//     draws the shape with WP-14's own `SERIES_DRAWS.line` and prints no number at all — no axis, no
//     tick label, no readout — and carries no `data-prov-idx`, so `Ctrl+I` on it reports that it
//     cites no provenance. The values themselves are printed, with their own indexes, in the kv and
//     grid blocks beside it on all three screens. Its header has the measurements behind not using
//     `Renderer` directly.
//   * **`Composer`** (MSG, FXC) is `screen/widgets/Composer.tsx`, and it is MSG's message draft
//     only. FXC addresses the same name for a currency cross matrix — "a keyboard-driven editor
//     grid", its own comment says — and the component recognises that shape and names it rather than
//     drawing a message box over it. MSG's composer drafts, keeps the draft across a payload
//     refresh, prints MSG-03's disclaimer and the `sendBlockedReason` gate, and states plainly that
//     it cannot send: there is no messaging port in the widget tree and `AppSdk` declares no
//     `messaging.send`, so a GO wired to an injected port would be dead in the product. Both limits
//     are in that file's header.
//
// Neither component approximates anything: what cannot be attributed is not printed, and what has no
// component still says what it is waiting for.

import { useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactElement } from 'react';

import { ChartCanvas } from './chart/index.js';
import type { ChartParamsPatch } from './chart/index.js';
import { LiveGrid } from './grid/LiveGrid.js';
import { Composer } from './screen/widgets/Composer.js';
import { Sparkline } from './screen/widgets/Sparkline.js';
import type { ChartSpec } from './screen/types.js';
import type { CustomComponentProps, WidgetRegistry } from './screen/widgets/registry.js';
import { usePanelsStore } from './state/panels.js';

/* ---------------------------------------------------------------------------------------------- */
/* What a chart needs from the shell                                                                */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The two things `ChartCanvas` needs that a `custom` node cannot carry.
 *
 * `CustomComponentProps` hands a component its id, its props and a `ScreenActions` — and
 * `ScreenActions` is four methods (`navigate`, `navigateNext`, `openUrl`, `provenance`), none of
 * which is `setParams`. So the `T A N L S` keys of CLIENT §11.9 (series type, adjustment,
 * normalisation, log scale, studies) have nowhere to report to, and `Ctrl+S` has no `instrumentId`
 * to save an annotation against. Both are per PANEL, and the panel is what the widget tree does not
 * know: `ScreenRenderer` is handed one `ScreenActions` per panel and the node sits several widgets
 * below it.
 *
 * So the adapter asks the DOM. `shell/Panel.tsx` writes `data-panel={panelId}` on the panel
 * `<section>`, which is the nearest ancestor of every node it renders, and that attribute is the
 * authority the shell itself routes keys by. It is one `closest()` per chart mount, and it is exact:
 * a chart is inside exactly one panel and cannot move between panels without remounting.
 */
export interface ChartHost {
  /** `ScreenCtx.setParams` for the panel the chart is drawn in — §11.9's round trip. */
  setParams(panelId: string, patch: ChartParamsPatch): void;
  /** `instruments.instrument_id` of that panel's frame, for `chart_annotations` (CHRT-05). */
  instrumentId(panelId: string): number | undefined;
}

/**
 * A chart with no shell behind it: the keys still cycle the series type on screen, and nothing is
 * persisted. This is what a component test gets, and it is honest — `onParamsChange` is documented
 * as being for "a host that can reach `ScreenCtx.setParams`".
 */
export const INERT_CHART_HOST: ChartHost = {
  setParams: () => undefined,
  instrumentId: () => undefined,
};

/** The panels store's own answer, so the adapter never holds a stale instrument id. */
export const STORE_CHART_HOST = (setParams: ChartHost['setParams']): ChartHost => ({
  setParams,
  instrumentId: (panelId) => {
    const panel = usePanelsStore.getState().panels[panelId];
    const frame = panel === undefined ? undefined : panel.frameStack[panel.index];
    return frame?.security?.id ?? undefined;
  },
});

/* ---------------------------------------------------------------------------------------------- */
/* `props.spec` → `ChartSpec`                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Is this the `ChartSpec` a chart screen builds?
 *
 * `Node.props` is `unknown` — FUNCTIONS §1.5 gives the `custom` escape hatch no schema — so the
 * adapter checks the five structural members `Renderer.setSpec` dereferences before it draws
 * anything. A wrong guess here is not a type error, it is a throw inside a `useLayoutEffect` during
 * the first frame, which in this shell is a dead panel; and the skeleton case (`spec: null`, which
 * `GP` and `GIP` both emit while the run is in flight) is a normal state that must not be mistaken
 * for a broken one.
 */
export function isChartSpec(value: unknown): value is ChartSpec {
  if (typeof value !== 'object' || value === null) return false;
  const spec = value as Partial<ChartSpec>;
  return (
    typeof spec.kind === 'string' &&
    typeof spec.xAxis === 'object' &&
    spec.xAxis !== null &&
    Array.isArray(spec.yAxes) &&
    Array.isArray(spec.panes) &&
    Array.isArray(spec.series)
  );
}

/** `{ spec }` out of a `custom` node's props; `null` for the skeleton and for anything unexpected. */
export function chartSpecOf(props: unknown): ChartSpec | null {
  if (typeof props !== 'object' || props === null) return null;
  const spec = (props as { spec?: unknown }).spec;
  return isChartSpec(spec) ? spec : null;
}

/* ---------------------------------------------------------------------------------------------- */
/* The adapter                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/** The panel this element is inside, read once it is in the document (see {@link ChartHost}). */
function usePanelOf(ref: { current: HTMLElement | null }): string | null {
  const [panelId, setPanelId] = useState<string | null>(null);
  useEffect(() => {
    const panel = ref.current?.closest<HTMLElement>('[data-panel]');
    const id = panel?.dataset.panel;
    if (id !== undefined && id !== '') setPanelId(id);
    // `ref` is stable and the panel of a mounted node never changes; this runs once per chart.
  }, [ref]);
  return panelId;
}

/**
 * One of `PriceChart` / `CurveChart` / `OptionSurface`: a `ChartSpec` on a canvas.
 *
 * The three differ only in which screens emit them and what their specs contain (`kind: 'price'`,
 * `'curve'`, `'surface'` — which the renderer already switches on), so they share one component and
 * differ by the name it was registered under. That name is reported in the loading state, because
 * "PriceChart — the run has not answered yet" and "CurveChart — …" are different sentences to a
 * reader looking at a blank pane.
 */
function ChartFromSpec({ id, component, props, host }: CustomComponentProps & { host: ChartHost }): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const panelId = usePanelOf(hostRef);
  const spec = chartSpecOf(props);
  const instrumentId = panelId === null ? undefined : host.instrumentId(panelId);

  if (spec === null) {
    // `GP`/`GIP` emit `props: { spec: null }` for the frame that exists before its payload does.
    // This is the skeleton, NOT a missing component: it carries no `data-pending`, because that
    // attribute means "nothing is registered for this node" and something is.
    return (
      <div
        className="chart-host chart-host--empty"
        data-chart-state="empty"
        data-chart-component={component}
        role="group"
        aria-label={`${component} ${id} — no series to draw`}
      >
        <p className="pending__note">{`${component}: no series yet. Nothing is plotted — a placeholder curve would be read as a price.`}</p>
      </div>
    );
  }

  return (
    <div className="chart-host" data-chart-state="drawn" data-chart-component={component} ref={hostRef}>
      <ChartCanvas
        id={id}
        spec={spec}
        {...(instrumentId === undefined ? {} : { instrumentId })}
        onParamsChange={(patch: ChartParamsPatch): void => {
          // A patch with no panel to send it to is dropped rather than sent to a guess: the keys
          // have already changed what is on the canvas, and re-running the function against the
          // wrong panel's frame would replace a screen the user did not touch.
          if (panelId !== null) host.setParams(panelId, patch);
        }}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* The registry                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

export interface WidgetRegistryOptions {
  /** Omitted in a component test: the chart then draws and persists nothing (see {@link ChartHost}). */
  chartHost?: ChartHost | undefined;
}

/**
 * THE registry: WP-13's `LiveGrid`, WP-14's `ChartCanvas`, and the three chart-shaped `custom`
 * components the 38 screens actually address.
 *
 * Built by a function rather than exported as a constant because the `custom` components close over
 * the {@link ChartHost}, and because a registry object that changed identity on every render would
 * remount every grid and every chart in the terminal — `App.tsx` builds it once per page.
 *
 * `ChartCanvas` needs no studies registry from here: `ChartCanvas.tsx` already calls
 * `renderer.setPlugins({ studies: STUDY_REGISTRY, annotations: … })` itself (ChartCanvas.tsx:1770),
 * so all twenty-two studies are wired by the component, not by its host.
 */
export function buildWidgetRegistry(options: WidgetRegistryOptions = {}): WidgetRegistry {
  const host = options.chartHost ?? INERT_CHART_HOST;
  const chart: ComponentType<CustomComponentProps> = (props) => <ChartFromSpec {...props} host={host} />;
  return {
    LiveGrid,
    ChartCanvas,
    custom: {
      PriceChart: chart,
      CurveChart: chart,
      OptionSurface: chart,
      // Neither of these two takes a `ChartSpec`, and neither takes the chart adapter: `Sparkline`
      // owns its own canvas (no axes, no numbers) and `Composer` is a text control. See the header.
      Sparkline,
      Composer,
    },
  };
}
