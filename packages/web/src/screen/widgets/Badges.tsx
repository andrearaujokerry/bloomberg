// packages/web/src/screen/widgets/Badges.tsx — the entitlement, staleness and toolbar chips.
//
// CLIENT.md §5.4 names "badge reason" as an affordance that must be reachable by keyboard: a badge
// whose explanation only appears on hover is a mouse-only affordance, which TERM-06 calls a defect.
// So each badge is a roving tab stop, its `title` is both the `title` attribute (pointer) and a
// visually-hidden phrase (keyboard and screen reader), and the arrow keys walk the strip.

import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';

import type { Node } from '../types.js';
import { rovingKey, useRoving } from './roving.js';

export interface BadgesProps {
  node: Extract<Node, { kind: 'badges' }>;
}

export function Badges({ node }: BadgesProps): ReactElement {
  const roving = useRoving(node.items.length);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (rovingKey(e.key, roving, node.items.length, 'horizontal')) e.preventDefault();
  };

  // One tab stop in every state, empty included — see `KeyValue.tsx`.
  const isEmpty = node.items.length === 0;

  return (
    <div
      className="badges"
      data-node-id={node.id}
      role="list"
      aria-label={`Badges ${node.id}`}
      {...(isEmpty ? { tabIndex: 0 } : {})}
    >
      {isEmpty ? <p className="widget__empty">No badges.</p> : null}
      {node.items.map((badge, i) => (
        <span
          key={`${badge.tone}:${badge.text}:${String(i)}`}
          className="badge"
          role="listitem"
          data-tone={badge.tone}
          tabIndex={roving.tabIndex(i)}
          ref={roving.register(i)}
          onFocus={() => {
            roving.set(i);
          }}
          onKeyDown={onKeyDown}
          {...(badge.title === undefined ? {} : { title: badge.title })}
        >
          {badge.text}
          {badge.title === undefined ? null : (
            <span className="sr-only">{` — ${badge.title}`}</span>
          )}
        </span>
      ))}
    </div>
  );
}
