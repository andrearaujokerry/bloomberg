// packages/web/src/screen/widgets/index.ts — the fixed widget set.
//
// Eleven widgets, one per `Node` kind, and nothing else: the set *is* the contract the 38 screens
// were written against, so a twelfth widget here would be a kind no screen can ask for and a
// twelfth `Node` kind would be a screen no renderer can draw.

export { Badges } from './Badges.js';
export {
  CellFormatContext,
  CellReasonContext,
  CellView,
  cellText,
  cellTooltip,
  reasonOfCell,
  useCellFormat,
  useCellReason,
} from './CellView.js';
export type { CellFormatContextValue, CellReasonResolver, CellViewProps } from './CellView.js';
export { Chart } from './Chart.js';
export { Custom } from './Custom.js';
export { Form } from './Form.js';
export { Grid } from './Grid.js';
export { KeyValue } from './KeyValue.js';
export { List } from './List.js';
export { Split } from './Split.js';
export { Table } from './Table.js';
export { Tabs } from './Tabs.js';
export { Text } from './Text.js';

export {
  EMPTY_REGISTRY,
  INERT_ACTIONS,
  ScreenActionsContext,
  WidgetRegistryContext,
  useScreenActions,
  useWidgetRegistry,
} from './registry.js';
export type {
  ChartCanvasProps,
  CustomComponentName,
  CustomComponentProps,
  LiveGridProps,
  ScreenActions,
  WidgetRegistry,
} from './registry.js';
export { rovingKey, useRoving } from './roving.js';
export type { Roving } from './roving.js';
