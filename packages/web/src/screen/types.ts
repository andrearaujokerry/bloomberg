// packages/web/src/screen/types.ts — the screen contract (FUNCTIONS.md §1.5 L369-473).
//
// A `FunctionScreen` is a PURE function of its props: it returns a `ScreenSpec` — data describing
// what to show and which cells are live — and never touches the DOM, holds state or does IO. That
// is what lets a screen be written and tested before `ScreenRenderer.tsx` exists: the test asserts
// the spec, not the pixels.
//
// Ownership: WP-09 adds this file and nothing else under `screen/`; WP-12 owns `ScreenRenderer.tsx`
// and the widget set that consumes these types.
//
// Two departures from the §1.5 listing, both forced and both narrow:
//   * `ValueCell` is imported from `@terminal/core`, not `@terminal/sdk`. The SDK does not export a
//     `ValueCell` (it is a TypeScript interface in `core/types/function.ts`, not a wire schema), so
//     the §1.5 import line does not resolve as written. `FieldId`, `ValueState`, `ReasonCode`,
//     `KeyBinding` and `CsvColumn` come from core for the same reason — one definition, not two.
//   * `ChartSpec` and its satellites are declared here rather than imported from
//     `web/src/chart/spec.ts`, which WP-13 owns and which does not exist yet. The declarations are
//     the §1.5 text verbatim; when WP-13 lands, `chart/spec.ts` should re-export them from here
//     rather than declare a second copy.

import type { InstrumentSummary, PayloadMeta } from '@terminal/sdk';
import type { CsvColumn, FieldId, KeyBinding, ValueCell, ValueState } from '@terminal/core';

export interface LiveView {
  /** Latest value for a (subject, field) from the SDK QuoteCache, or the payload cell when no delta has arrived. Recomputed staleness every 1 s. */
  get(subject: string, field: FieldId): ValueCell;
  state(subject: string): ValueState; // subject-level verdict (status frames 'shed'/'gone' → 'blank')
}

export interface ScreenCtx<P> {
  panelId: string; // 'p1'..'p8'
  /**
   * → re-run with `launchKind:'param'` (usage `fn.param`), keeps the frame.
   *
   * `P[K] | undefined` rather than `Partial<P>`: the patch is merged `{ ...frame.params, ...patch }`
   * and sent as JSON, which drops an `undefined`, so a key set to `undefined` CLEARS that param.
   * `Partial<P>` cannot spell that under `exactOptionalPropertyTypes` — and the clear is needed:
   * GP's `R` cycling off `range: 'CUSTOM'` has to drop the `start`/`end` it was pinned to, or the
   * next range is measured back from the custom end date instead of from today.
   */
  setParams(patch: { [K in keyof P]?: P[K] | undefined }): void;
  navigate(command: string): void; // executes a command line string in THIS panel ('AAPL US Equity GP 1Y')
  navigateNext(command: string): void; // same, in the next panel (Shift+Enter conventions)
  export(): void; // PRINT → sdk.fn.csvUrl({ resultId }) (never serialises locally)
  page(direction: 'fwd' | 'back'): void; // → POST /functions/:code/page
  focus(nodeId: string): void; // move keyboard focus to a node id in the ScreenSpec
  /** modal typeahead prompt */
  prompt(
    kind: 'security' | 'date' | 'text' | 'field' | 'watchlist',
    opts?: { label?: string; initial?: string },
  ): Promise<string | null>;
  provenance(provIdx: number): void; // opens the provenance panel (Ctrl+I)
  openUrl(url: string): void; // external link (SEC, Bloomberg RSS) in a new tab
}

export interface ScreenProps<P, T> {
  payload: T | undefined; // undefined while loading → the screen returns its skeleton spec
  params: P;
  instrument: InstrumentSummary | null;
  meta: PayloadMeta | undefined;
  live: LiveView;
  /** last run error for this frame (rendered by the shell footer; screens may add context) */
  error?: { code: string; message: string; traceId: string };
  ctx: ScreenCtx<P>;
}

export type FunctionScreen<P, T> = (props: ScreenProps<P, T>) => ScreenSpec;

export interface ScreenSpec {
  title: string; // 'DES · AAPL US Equity · Apple Inc'
  subtitle?: string;
  body: Node;
  /** attribution strip (licence_registry.attribution), knownAt for PIT screens */
  footer?: { sources: string[]; asOf?: string; notes?: string[] };
  keymap?: KeyBinding[]; // additions to manifest.keymap (dynamic, e.g. per tab)
  initialFocus?: string; // node id
  /**
   * Handlers for the `action` ids of `manifest.keymap` and `keymap` above, keyed by action id.
   *
   * THIS IS THE CHANNEL A SCREEN'S OWN KEYS ARRIVE ON, and for fifteen packages it did not exist: a
   * manifest declared `{ key: 'R', action: 'cycle-range' }`, the dispatcher matched it, and
   * `KeyboardHost.screenAction` had nowhere to send it, so every one of them answered
   * `NOT_APPLICABLE: declared by the screen but not wired yet`. GP's toolbar titled every range chip
   * "press R to cycle" against a key that did nothing.
   *
   * A closure and not a `(action: string) => void` switch, because the spec is rebuilt whenever the
   * params or the payload change (`shell/Panel.tsx`'s `spec` memo) and a handler built here closes
   * over the params THIS spec was built from. A screen that read its params out of a long-lived
   * callback would cycle from whatever was current when the callback was made.
   *
   * Only `when`-matching bindings reach here — the dispatcher has already resolved the region — and
   * an action with no entry still gets the footer hint, so a partially wired screen says which of
   * its keys work rather than pretending about all of them.
   */
  actions?: Readonly<Record<string, () => void>>;
}

export type Node =
  // sizes are fractions summing to 1
  | { kind: 'split'; dir: 'row' | 'col'; sizes: number[]; children: Node[] }
  | {
      kind: 'kv';
      id: string;
      title?: string;
      columns?: 1 | 2 | 3;
      rows: { label: string; value: Cell; provIdx?: number; fieldId?: FieldId }[];
    }
  | {
      kind: 'grid';
      id: string;
      columns: GridColumn[];
      rows: GridRow[];
      live?: { subjectOf: (row: GridRow) => string | null };
      sort?: { col: string; dir: 'asc' | 'desc' };
      groupBy?: string;
      frozenColumns?: number;
      selectable?: boolean;
      // command strings
      onEnter?: (row: GridRow) => string | null;
      onShiftEnter?: (row: GridRow) => string | null;
      emptyText?: string;
      page?: { index: number; count: number };
    }
  // small static table
  | { kind: 'table'; id: string; columns: CsvColumn[]; rows: Cell[][]; caption?: string }
  | { kind: 'chart'; id: string; spec: ChartSpec }
  | {
      kind: 'tabs';
      id: string;
      tabs: { id: string; label: string; key?: string; body: Node }[];
      active: string;
      onChange?: (id: string) => void;
    }
  | {
      kind: 'form';
      id: string;
      fields: FormField[];
      submitLabel?: string;
      onSubmit: (values: Record<string, unknown>) => void;
    }
  | {
      kind: 'text';
      id: string;
      text: string;
      mono?: boolean;
      tone?: 'normal' | 'muted' | 'warn' | 'error';
    }
  | {
      kind: 'list';
      id: string;
      items: {
        id: string;
        primary: string;
        secondary?: string;
        ts?: string;
        badges?: Badge[];
        command?: string;
        url?: string;
      }[];
      live?: { subject: string };
    }
  | { kind: 'badges'; id: string; items: Badge[] }
  | {
      kind: 'custom';
      id: string;
      component: 'PriceChart' | 'CurveChart' | 'OptionSurface' | 'Sparkline' | 'Composer';
      props: unknown;
    };

export interface Cell extends ValueCell {
  fmt?: 'px' | 'pct' | 'bp' | 'int' | 'ccy' | 'date' | 'datetime' | 'text' | 'shares';
  decimals?: number;
  dir?: 'up' | 'down' | 'flat';
  fieldId?: FieldId;
  command?: string;
}

export interface GridColumn {
  id: string;
  label: string;
  fieldId?: FieldId;
  width?: number;
  align?: 'left' | 'right';
  fmt?: Cell['fmt'];
  decimals?: number;
  sortable?: boolean;
  live?: boolean;
}

export interface GridRow {
  id: string;
  cells: Record<string, Cell>;
  group?: string;
  subject?: string;
  instrumentId?: number;
  command?: string;
  tone?: 'normal' | 'muted' | 'highlight';
}

export interface FormField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'enum' | 'security' | 'boolean' | 'field';
  value: unknown;
  values?: readonly string[];
  step?: number;
  bigStep?: number;
  unit?: string;
  readonly?: boolean;
}

export interface Badge {
  text: string;
  tone: 'info' | 'ok' | 'warn' | 'error' | 'stale' | 'blocked';
  title?: string;
}

// ---------------------------------------------------------------------------------------------
// ChartSpec (FUNCTIONS.md §1.5 L455-473). Declared here until WP-13's `web/src/chart/spec.ts`
// lands; `chart` nodes of GP, GIP and HP are typed against these shapes today.
// ---------------------------------------------------------------------------------------------

/** CHRT-01 */
export type SeriesType =
  | 'line'
  | 'area'
  | 'mountain'
  | 'candle'
  | 'ohlc'
  | 'bar'
  | 'step'
  | 'scatter'
  | 'tick'
  | 'pnf'
  | 'profile'
  | 'heatmap';

export interface ChartSeries {
  id: string;
  label: string;
  type: SeriesType;
  pane: string;
  yAxis: string;
  /** epoch ms (time axis), days (tenor axis) or category index */
  x: Float64Array | number[];
  /** close/level; NaN = gap */
  y: Float64Array | number[];
  ohlc?: { o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array };
  volume?: Float64Array;
  provIdx: number;
  currency?: string;
  calendarId?: string;
  /** CHRT-02 streaming without full re-render */
  live?: { subject: string; field: FieldId; mode: 'append-forming-bar' | 'replace-last' };
  style?: {
    color?: 'auto' | 'up' | 'down' | 'neutral' | `#${string}`;
    width?: number;
    dashed?: boolean;
  };
}

export interface ChartSpec {
  kind: 'price' | 'intraday' | 'curve' | 'surface' | 'sparkline' | 'bar';
  xAxis: {
    type: 'time' | 'tenor' | 'category';
    tz?: string;
    calendarId?: string;
    categories?: string[];
    sessions?: { start: number; end: number; kind: 'pre' | 'regular' | 'post' }[];
  };
  /** CHRT-03 independent axes */
  yAxes: {
    id: string;
    side: 'left' | 'right';
    scale: 'linear' | 'log';
    fmt: Cell['fmt'];
    decimals?: number;
    normalise?: 'none' | 'pct' | 'base100';
  }[];
  /** `height` is a fraction */
  panes: { id: string; height: number; title?: string }[];
  series: ChartSeries[];
  /** computed client-side in chart/studies (CHRT-04) */
  studies?: { id: string; params: Record<string, number>; pane: string; inputSeriesId: string }[];
  /** CHRT-06 click-through */
  events?: {
    t: number;
    kind:
      'earnings' | 'dividend' | 'split' | 'news' | 'filing' | 'index_add' | 'index_drop' | 'fomc';
    label: string;
    command: string;
    provIdx: number;
  }[];
  /** CHRT-05 */
  annotations?: {
    annotationId: number | null;
    kind: 'trendline' | 'hline' | 'vline' | 'fib' | 'text' | 'regression_channel' | 'rect';
    anchors: { t: number; v: number }[];
    label?: string;
    editable: boolean;
  }[];
  /** prev close, par rate, strike */
  reference?: { yAxis: string; v: number; label: string }[];
  crosshair: boolean;
  range?: [number, number];
  logScale?: boolean;
  onEvent?: (e: { kind: 'event' | 'annotation-save' | 'crosshair'; payload: unknown }) => void;
}

/**
 * `ScreenSpec.body` is a single `Node`; a screen with several stacked blocks says so with a split.
 * This is the one-liner that saves every screen writing the same literal.
 */
export function stack(dir: 'row' | 'col', children: Node[], sizes?: number[]): Node {
  const even = children.length === 0 ? [] : children.map(() => 1 / children.length);
  return { kind: 'split', dir, sizes: sizes ?? even, children };
}
