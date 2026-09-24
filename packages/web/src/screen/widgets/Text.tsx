// packages/web/src/screen/widgets/Text.tsx — prose, a formula, an error line.
//
// Keyboard-operable means focusable here: a text node has nothing to activate, but it must still be
// reachable by `Tab` so that `Ctrl+I` can be pressed on it and so that a screen made only of text
// is not a keyboard dead end.

import type { ReactElement } from 'react';

import type { Node } from '../types.js';

export interface TextProps {
  node: Extract<Node, { kind: 'text' }>;
}

export function Text({ node }: TextProps): ReactElement {
  const tone = node.tone ?? 'normal';
  const className = `text text--${tone}${node.mono === true ? ' text--mono' : ''}`;
  const body = node.mono === true ? <pre className="text__pre">{node.text}</pre> : node.text;
  return (
    <div
      className={className}
      data-node-id={node.id}
      data-tone={tone}
      role="note"
      tabIndex={0}
      {...(tone === 'error' ? { 'aria-live': 'polite' as const } : {})}
    >
      {body}
    </div>
  );
}
