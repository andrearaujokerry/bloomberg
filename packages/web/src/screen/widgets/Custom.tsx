// packages/web/src/screen/widgets/Custom.tsx — the escape hatch, kept narrow.
//
// `custom` is the only `Node` whose body WP-12 cannot know: its five component names
// (`PriceChart`, `CurveChart`, `OptionSurface`, `Sparkline`, `Composer`) belong to WP-14's chart
// package and to the MSG composer. The widget looks the name up in the registry and renders what it
// finds; with nothing registered it names the component it is waiting for, and stays focusable so a
// screen whose whole body is a chart is still a keyboard-reachable screen.

import type { ReactElement } from 'react';

import type { Node } from '../types.js';
import type { CustomComponentProps } from './registry.js';
import { useScreenActions, useWidgetRegistry } from './registry.js';

export interface CustomProps {
  node: Extract<Node, { kind: 'custom' }>;
}

export function Custom({ node }: CustomProps): ReactElement {
  const registry = useWidgetRegistry();
  const actions = useScreenActions();
  const Component = registry.custom?.[node.component];

  if (Component !== undefined) {
    const props: CustomComponentProps = {
      id: node.id,
      component: node.component,
      props: node.props,
      actions,
    };
    return (
      <div className="custom-host" data-node-id={node.id}>
        <Component {...props} />
      </div>
    );
  }

  return (
    <div
      className="pending pending--custom"
      data-node-id={node.id}
      data-pending={node.component}
      role="group"
      aria-label={`${node.component} ${node.id} — waiting for its component`}
      tabIndex={0}
    >
      <p className="pending__head">{`${node.component} — waiting for its component`}</p>
      <p className="pending__note">
        {node.component === 'Composer'
          ? 'The MSG composer is part of the shell; nothing is registered for it yet.'
          : 'The chart components arrive with WP-14; nothing is registered for this one yet.'}
      </p>
    </div>
  );
}
