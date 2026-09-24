// packages/web/src/screen/widgets/Chart.tsx — the `chart` node, which WP-12 does not draw.
//
// Same rule as `Grid.tsx`, for the same reason. The canvas renderer, its scales, calendar alignment,
// downsampling, studies, event markers and annotations are WP-14's (CLIENT.md §11); a chart drawn
// here would be a chart a trader could read a level off. The widget hands `ChartCanvas` the
// `ChartSpec` when one is registered, and otherwise states what it is waiting for and what the spec
// contains — series, panes, axis type — which is the honest half of the picture.

import type { ReactElement } from 'react';

import type { Node } from '../types.js';
import type { ChartCanvasProps } from './registry.js';
import { useWidgetRegistry } from './registry.js';

export interface ChartProps {
  node: Extract<Node, { kind: 'chart' }>;
}

export function Chart({ node }: ChartProps): ReactElement {
  const registry = useWidgetRegistry();
  const ChartCanvas = registry.ChartCanvas;
  const spec = node.spec;

  if (ChartCanvas !== undefined) {
    const props: ChartCanvasProps = {
      id: node.id,
      spec,
      ...(spec.onEvent === undefined ? {} : { onEvent: spec.onEvent }),
    };
    return (
      <div className="chart-host" data-node-id={node.id}>
        <ChartCanvas {...props} />
      </div>
    );
  }

  const summary = [
    `${spec.kind} chart`,
    `${spec.xAxis.type} axis`,
    `${String(spec.series.length)} series`,
    `${String(spec.panes.length)} panes`,
    `${String(spec.yAxes.length)} y axes`,
    spec.crosshair ? 'crosshair' : 'no crosshair',
  ].join(' · ');
  // A chart cites provenance through its series, one index each, and the node can carry only one.
  //
  // So it carries one only when there is one to carry: every series agreeing on a source. Naming
  // series 0's source for a chart drawn from three sources would present one attribution as the
  // attribution for everything on the canvas, which is the opposite of what DATA-10 asks for, and
  // an empty chart answering `-1` would print the *Pending* copy — "this value has not been
  // attributed yet" — about a chart that has no values at all. Both of those cases answer `-2`,
  // "this element cites no provenance", which is true; and the series list below names each
  // series' source in full, so nothing is hidden while the canvas is WP-14's.
  const seriesLabels = spec.series
    .map((s) => `${s.label} (${s.type}, source ${String(s.provIdx)})`)
    .join(', ');
  const distinctProv = new Set(spec.series.map((s) => s.provIdx));
  const provIdx = distinctProv.size === 1 ? ([...distinctProv][0] ?? -2) : -2;

  return (
    <div
      className="pending pending--chart"
      data-node-id={node.id}
      data-pending="ChartCanvas"
      data-prov-idx={provIdx}
      role="group"
      aria-label={`Chart ${node.id} — waiting for ChartCanvas`}
      tabIndex={0}
    >
      <p className="pending__head">{`Chart ${node.id} — waiting for ChartCanvas (WP-14)`}</p>
      <p className="pending__body">{summary}</p>
      {seriesLabels === '' ? null : <p className="pending__body">{`Series: ${seriesLabels}`}</p>}
      <p className="pending__note">
        No series are plotted here. A placeholder curve would be read as a price.
      </p>
    </div>
  );
}
