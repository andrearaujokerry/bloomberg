// packages/web/src/screen/widgets/Split.tsx — layout, and nothing else.
//
// A `split` is the one `Node` with no id: it is not addressable, never takes focus and has no
// keyboard behaviour of its own. Its children keep their document order, which is what makes `Tab`
// move through a screen in reading order without the renderer maintaining a focus list.

import type { ReactElement } from 'react';

import type { Node } from '../types.js';

export interface SplitProps {
  node: Extract<Node, { kind: 'split' }>;
  renderNode: (node: Node, key: string) => ReactElement;
}

export function Split({ node, renderNode }: SplitProps): ReactElement {
  return (
    <div
      className={`split split--${node.dir}`}
      style={{ display: 'flex', flexDirection: node.dir === 'row' ? 'row' : 'column' }}
    >
      {node.children.map((child, i) => (
        <div
          key={`${node.dir}:${String(i)}`}
          className="split__pane"
          // `sizes` are fractions summing to 1; a missing entry shares what is left evenly.
          style={{
            flexGrow: node.sizes[i] ?? 1 / Math.max(node.children.length, 1),
            flexBasis: 0,
            minWidth: 0,
            minHeight: 0,
          }}
        >
          {renderNode(child, `${node.dir}:${String(i)}`)}
        </div>
      ))}
    </div>
  );
}
