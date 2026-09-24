// packages/web/src/screen/widgets/List.tsx — the news, message and watchlist lists.
//
// A listbox, because the interaction is "move through rows with the arrows and act on one", which
// is what `option` + roving tabindex describes. `Enter` runs the item's `command`, `Shift+Enter`
// runs it in the next panel, and `Alt+Enter` opens its external `url` — an item may carry both, and
// a headline that links out still needs its in-terminal command to be the default.

import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';

import type { Node } from '../types.js';
import { useScreenActions } from './registry.js';
import { rovingKey, useRoving } from './roving.js';

export interface ListProps {
  node: Extract<Node, { kind: 'list' }>;
}

export function List({ node }: ListProps): ReactElement {
  const actions = useScreenActions();
  const roving = useRoving(node.items.length);
  // `item.id` is the React key wherever the screen kept them unique, so a list that prepends a
  // headline keeps the identity (and the focus) of every row below it. A duplicate id — the MSG
  // golden redacts volatile message ids to one literal — falls back to position rather than
  // silently dropping a row.
  const idsAreUnique = new Set(node.items.map((i) => i.id)).size === node.items.length;

  const activate = (index: number, mode: 'this' | 'next' | 'url'): void => {
    const item = node.items[index];
    if (item === undefined) return;
    if (mode === 'url') {
      if (item.url !== undefined) actions.openUrl(item.url);
      return;
    }
    if (item.command !== undefined) {
      if (mode === 'next') actions.navigateNext(item.command);
      else actions.navigate(item.command);
      return;
    }
    if (item.url !== undefined) actions.openUrl(item.url);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>, i: number): void => {
    if (rovingKey(e.key, roving, node.items.length)) {
      e.preventDefault();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    activate(i, e.altKey ? 'url' : e.shiftKey ? 'next' : 'this');
  };

  // An empty list is still exactly one tab stop: the "No items." line is the answer to a question
  // the user asked, and an answer nobody can put the focus on is not an answer.
  const isEmpty = node.items.length === 0;

  return (
    <div
      className="list"
      data-node-id={node.id}
      role="listbox"
      aria-label={`List ${node.id}`}
      {...(node.live === undefined ? {} : { 'data-subject': node.live.subject })}
      {...(isEmpty ? { tabIndex: 0 } : {})}
    >
      {isEmpty ? (
        <p className="list__empty widget__empty">No items.</p>
      ) : (
        node.items.map((item, i) => (
          <div
            key={idsAreUnique ? item.id : `${item.id}:${String(i)}`}
            className="list__item"
            role="option"
            aria-selected={i === roving.index}
            tabIndex={roving.tabIndex(i)}
            ref={roving.register(i)}
            {...(item.command === undefined
              ? {}
              : { 'data-command': item.command, 'aria-keyshortcuts': 'Enter' })}
            {...(item.url === undefined ? {} : { 'data-url': item.url })}
            onFocus={() => {
              roving.set(i);
            }}
            onKeyDown={(e) => {
              onKeyDown(e, i);
            }}
            onClick={() => {
              activate(i, 'this');
            }}
          >
            <span className="list__primary">{item.primary}</span>
            {item.secondary === undefined ? null : (
              <span className="list__secondary">{item.secondary}</span>
            )}
            {item.ts === undefined ? null : (
              <time className="list__ts" dateTime={item.ts}>
                {item.ts}
              </time>
            )}
            {item.badges === undefined
              ? null
              : item.badges.map((badge, bi) => (
                  <span
                    key={`${badge.tone}:${badge.text}:${String(bi)}`}
                    className="badge badge--inline"
                    data-tone={badge.tone}
                    {...(badge.title === undefined ? {} : { title: badge.title })}
                  >
                    {badge.text}
                  </span>
                ))}
          </div>
        ))
      )}
    </div>
  );
}
