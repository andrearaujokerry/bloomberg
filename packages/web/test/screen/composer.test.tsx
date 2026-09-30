/**
 * packages/web/test/screen/composer.test.tsx — the `custom#Composer` component (MSG-01, MSG-03,
 * TERM-06; FUNCTIONS_TIER1 §MSG L1704).
 *
 * MSG's right pane ended in "Composer — waiting for its component". What this file pins is the three
 * things that make the replacement worth having and honest: the draft is keyboard-operable and
 * survives the remount MSG's next payload causes, the policy the user is drafting under is on screen
 * BEFORE the box, and the component never claims to have sent anything — there is no messaging
 * transport in the widget tree, and saying so is the feature.
 *
 * The props are the ones MSG and FXC really pass, taken from each shipped `Screen.tsx` handed its own
 * committed golden payload. The FXC half matters as much as the MSG half: both screens address the
 * same component NAME with unrelated shapes, so a component that matched loosely would draw a message
 * box over a 9 × 9 rate matrix.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifests } from '@terminal/core';
import type { FunctionCode, ParamsOf, PayloadOf } from '@terminal/core';
import type { PayloadMeta } from '@terminal/sdk';
import { render } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { ScreenRenderer } from '../../src/screen/ScreenRenderer.js';
import type { Node, ScreenCtx, ScreenSpec } from '../../src/screen/types.js';
import { Composer, clearComposerDrafts, composerDraft, composerShapeOf } from '../../src/screen/widgets/Composer.js';
import type { CustomComponentProps } from '../../src/screen/widgets/registry.js';
import { screenModules } from '../../src/screens/index.js';
import { buildWidgetRegistry } from '../../src/widgets.js';

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(dirname(TEST_DIR))));
const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'golden', 'functions');

function golden<C extends FunctionCode>(file: string): PayloadOf<C> {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, file), 'utf8')) as PayloadOf<C>;
}

const META: PayloadMeta = {
  traceId: '11111111-2222-4333-8444-555555555555',
  resultId: '01J00000000000000000000MSG',
  asOf: { validAt: '2026-09-15T18:41:28.000Z', knownAt: '2026-09-15T18:41:28.000Z' },
  tier: 'delayed',
  staleness: 'live',
  provenance: Array.from({ length: 8 }, (_v, idx) => ({
    idx,
    sourceId: `source.${String(idx)}`,
    provenanceId: 900 + idx,
    capturedAt: '2026-09-15T18:41:28.000Z',
    sourceTs: '2026-09-15T18:26:26.000Z',
    attribution: `Attribution ${String(idx)}`,
    requestKey: `key:${String(idx)}`,
    responseSha256: 'f'.repeat(64),
    adapterVersion: '1',
  })),
  unavailable: [],
  entitlement: [],
  engines: [],
  servedAt: '2026-09-15T18:41:28.100Z',
};

function specOf(code: 'MSG' | 'FXC', file: string, params: Record<string, unknown>): ScreenSpec {
  const module = screenModules[code];
  const parsed = manifests[code].params.parse(params) as ParamsOf<typeof code>;
  const ctx = {
    panelId: 'p1',
    code,
    params: parsed,
    setParams: () => undefined,
    navigate: () => undefined,
    navigateNext: () => undefined,
    openUrl: () => undefined,
    provenance: () => undefined,
  } as unknown as ScreenCtx<never>;
  return module.Screen({ payload: golden(file), params: parsed, meta: META, ctx } as never);
}

function composerNodes(spec: ScreenSpec): Extract<Node, { kind: 'custom' }>[] {
  const found: Extract<Node, { kind: 'custom' }>[] = [];
  const walk = (node: Node): void => {
    if (node.kind === 'custom' && node.component === 'Composer') found.push(node);
    if (node.kind === 'split') node.children.forEach(walk);
    if (node.kind === 'tabs') node.tabs.forEach((tab) => walk(tab.body));
  };
  walk(spec.body);
  return found;
}

const nodeProps = (props: unknown, id = 'composer'): CustomComponentProps => ({
  id,
  component: 'Composer',
  props,
  actions: {
    navigate: () => undefined,
    navigateNext: () => undefined,
    openUrl: () => undefined,
    provenance: () => undefined,
  },
});

/** MSG's own props for a room the caller may write to, as `MSG/Screen.tsx#composer` builds them. */
const OPEN_ROOM = {
  roomId: 7,
  canSend: true,
  sendBlockedReason: 'NOT_A_MEMBER',
  disclaimer: 'Messages are archived and monitored.',
  draftKey: 'msg:p1:7',
  maxLength: 8000,
  attachments: [],
};

afterEach(() => {
  clearComposerDrafts();
});

/* ---------------------------------------------------------------------------------------------- */
/* The two shapes                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

describe('the props MSG and FXC pass under the one name', () => {
  it('reads MSG’s draft out of the shipped screen', () => {
    const nodes = composerNodes(specOf('MSG', 'MSG.default.json', {}));
    expect(nodes.map((n) => n.id)).toEqual(['composer']);
    const shape = composerShapeOf(nodes[0]?.props);
    expect(shape.kind).toBe('draft');
    if (shape.kind !== 'draft') throw new Error('unreachable');
    // `msg:<panelId>:<roomId>` — the identity the draft is kept under (§MSG L1704). The committed
    // golden carries `<DM>` where the room id is, because `golden.ts` substitutes database ids for
    // stable tokens before a payload is written down (BUILD_STATUS: the substitution is key-aware).
    // So the shape of the key is what can be asserted from a golden, and the numeric case is covered
    // by the draft tests below with MSG's own literal props.
    expect(shape.draft.draftKey).toMatch(/^msg:p1:.+$/);
    expect(shape.draft.maxLength).toBe(8000);
    // The payload's own gate, carried rather than recomputed: the seeded DM admits `pm@demo.terminal`
    // (`canSend: true`, `sendBlockedReason: 'OK'`).
    const payload = golden<'MSG'>('MSG.default.json') as {
      active: { canSend: boolean; sendBlockedReason: string } | null;
    };
    expect(shape.draft.canSend).toBe(payload.active?.canSend ?? false);
    expect(shape.draft.sendBlockedReason).toBe(payload.active?.sendBlockedReason);
  });

  it('recognises FXC’s matrix as the other shape and refuses to compose over it', () => {
    const nodes = composerNodes(specOf('FXC', 'FXC.default.json', {}));
    expect(nodes.map((n) => n.id)).toEqual(['matrix']);
    const shape = composerShapeOf(nodes[0]?.props);
    expect(shape.kind).toBe('matrix');
    if (shape.kind !== 'matrix') throw new Error('unreachable');
    expect(shape.matrix.ccys.length).toBeGreaterThan(1);
    expect(shape.matrix.rows).toBe(shape.matrix.ccys.length);

    const { container } = render(<Composer {...nodeProps(nodes[0]?.props, 'matrix')} />);
    const host = container.querySelector<HTMLElement>('.composer--matrix');
    expect(host?.dataset.composerState).toBe('matrix-not-implemented');
    // No message box, no fake grid: the count of what is in hand, and the reason it is not drawn.
    expect(container.querySelector('textarea')).toBeNull();
    expect(host?.textContent).toContain('not a message composer');
    expect(host?.textContent).toContain(`${String(shape.matrix.ccys.length)} currencies`);
    expect(host?.tabIndex).toBe(0);
  });

  it('is what the shipped registry serves the node with', () => {
    expect(buildWidgetRegistry().custom?.Composer).toBe(Composer);
    const spec = specOf('MSG', 'MSG.default.json', {});
    const { container } = render(<ScreenRenderer spec={spec} meta={META} widgets={buildWidgetRegistry()} />);
    // The placeholder is gone from MSG, and the composer is real.
    expect([...container.querySelectorAll<HTMLElement>('[data-pending]')].map((el) => el.dataset.pending)).toEqual([]);
    expect(container.querySelector('textarea.composer__body')).not.toBeNull();
  });

  it('says which node it is when the props are neither shape', () => {
    const { container } = render(<Composer {...nodeProps({ spec: null })} />);
    expect(container.querySelector<HTMLElement>('.composer--unreadable')).not.toBeNull();
    expect(container.textContent).toContain('no `draftKey`');
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The draft (TERM-06)                                                                              */
/* ---------------------------------------------------------------------------------------------- */

describe('drafting a message', () => {
  const type = userEvent.setup({ delay: null });

  it('takes typed text, counts it, and is the node’s tab stop', async () => {
    const { container } = render(<Composer {...nodeProps(OPEN_ROOM)} />);
    const area = container.querySelector<HTMLTextAreaElement>('textarea.composer__body');
    expect(area).not.toBeNull();
    if (area === null) throw new Error('unreachable');

    area.focus();
    expect(document.activeElement).toBe(area);
    await type.type(area, 'flagging the print on the open');
    expect(area.value).toBe('flagging the print on the open');
    expect(container.querySelector('[data-testid="composer-count"]')?.textContent).toBe(
      `${String('flagging the print on the open'.length)}/8000`,
    );
  });

  it('keeps the draft across the remount MSG’s next payload causes', async () => {
    const first = render(<Composer {...nodeProps(OPEN_ROOM)} />);
    const area = first.container.querySelector<HTMLTextAreaElement>('textarea.composer__body');
    if (area === null) throw new Error('unreachable');
    await type.type(area, 'half a sentence');
    expect(composerDraft('msg:p1:7')).toBe('half a sentence');

    // What a re-run does: the screen rebuilds its spec and this node is a NEW component instance.
    first.unmount();
    const second = render(<Composer {...nodeProps({ ...OPEN_ROOM })} />);
    expect(second.container.querySelector<HTMLTextAreaElement>('textarea.composer__body')?.value).toBe(
      'half a sentence',
    );

    // …and a different room is a different draft, because the key carries the room.
    const other = render(<Composer {...nodeProps({ ...OPEN_ROOM, roomId: 9, draftKey: 'msg:p1:9' })} />);
    expect(other.container.querySelectorAll<HTMLTextAreaElement>('textarea.composer__body')[0]?.value).toBe('');
  });

  it('sends on Enter and newlines on Shift+Enter, and stops the key at the element', async () => {
    // §MSG's keyboard table. `stopPropagation` matters in the shell: the window dispatcher returns on
    // `defaultPrevented`, so a composer that let `Enter` through would hand GO to whatever is above
    // it while the user was mid-sentence.
    const seen: string[] = [];
    const { container } = render(
      <div
        onKeyDown={(e) => {
          seen.push(e.key);
        }}
      >
        <Composer {...nodeProps(OPEN_ROOM)} />
      </div>,
    );
    const area = container.querySelector<HTMLTextAreaElement>('textarea.composer__body');
    if (area === null) throw new Error('unreachable');
    area.focus();

    await type.type(area, 'one');
    await type.keyboard('{Shift>}{Enter}{/Shift}');
    await type.type(area, 'two');
    expect(area.value).toBe('one\ntwo');
    // The newline reached the element, so its own key was not stopped.
    expect(seen).toContain('Enter');

    seen.length = 0;
    await type.keyboard('{Enter}');
    // GO: nothing was appended, and the key did not escape to the ancestor.
    expect(area.value).toBe('one\ntwo');
    expect(seen, 'Enter escaped the composer to the shell above it').toEqual([]);
    expect(container.querySelector('[data-testid="composer-transport"]')?.textContent).toContain('Not sent');
    // The draft is still there: a message the terminal could not send must not vanish.
    expect(composerDraft('msg:p1:7')).toBe('one\ntwo');
  });

  it('never claims to have sent anything, before or after GO', async () => {
    const { container } = render(<Composer {...nodeProps(OPEN_ROOM)} />);
    expect(container.querySelector<HTMLElement>('.composer')?.dataset.sendState).toBe('unwired');
    const note = container.querySelector('[data-testid="composer-transport"]');
    expect(note?.textContent).toContain('no messaging transport');
    expect(note?.textContent).toContain('POST /rooms/:roomId/messages');

    const send = container.querySelector<HTMLButtonElement>('button.composer__send');
    if (send === null) throw new Error('the composer has no send control');
    await type.click(send);
    expect(container.textContent).not.toContain('Sent');
    expect(container.querySelector('[data-testid="composer-transport"]')?.textContent).toContain(
      'Your draft is kept',
    );
  });

  it('clips at the room’s own limit, and never above the wire schema’s', () => {
    const shape = composerShapeOf({ ...OPEN_ROOM, maxLength: 50_000 });
    if (shape.kind !== 'draft') throw new Error('unreachable');
    // `SendMessageRequest.body` is `.max(8000)`: a screen asking for more would be drafting something
    // the route refuses, and the user would find out only on GO.
    expect(shape.draft.maxLength).toBe(8000);

    const { container } = render(<Composer {...nodeProps({ ...OPEN_ROOM, maxLength: 12 })} />);
    const area = container.querySelector<HTMLTextAreaElement>('textarea.composer__body');
    expect(area?.maxLength).toBe(12);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The policy the user is drafting under (MSG-03, ENTL-05)                                          */
/* ---------------------------------------------------------------------------------------------- */

describe('the send gate', () => {
  it('prints the disclaimer above the box, not under it', () => {
    const { container } = render(<Composer {...nodeProps(OPEN_ROOM)} />);
    const host = container.querySelector<HTMLElement>('.composer');
    const children = [...(host?.children ?? [])];
    const disclaimer = container.querySelector('[data-testid="composer-disclaimer"]');
    const area = container.querySelector('textarea.composer__body');
    if (disclaimer === null || area === null) throw new Error('the composer drew neither');
    expect(disclaimer.textContent).toBe('Messages are archived and monitored.');
    expect(children.indexOf(disclaimer)).toBeLessThan(children.indexOf(area));
  });

  it('states the reason when the room refuses the caller, and still keeps the draft', async () => {
    const { container } = render(
      <Composer {...nodeProps({ ...OPEN_ROOM, canSend: false, sendBlockedReason: 'MESSAGE_POLICY_BLOCKED' })} />,
    );
    expect(container.querySelector<HTMLElement>('.composer')?.dataset.composerState).toBe('blocked');
    const blocked = container.querySelector('[data-testid="composer-blocked"]');
    // Never a disabled control with no words: the reason is the thing the user can act on (ENTL-05's
    // rule, applied to a send instead of to a cell).
    expect(blocked?.textContent).toContain('MESSAGE_POLICY_BLOCKED');
    const area = container.querySelector<HTMLTextAreaElement>('textarea.composer__body');
    if (area === null) throw new Error('unreachable');
    await userEvent.setup({ delay: null }).type(area, 'still typeable');
    expect(area.value).toBe('still typeable');
  });

  it('renders MSG’s skeleton as a skeleton: no room, the screen’s own placeholder', () => {
    // What MSG emits while the run is in flight (`payload === undefined`).
    const { container } = render(
      <Composer
        {...nodeProps({
          roomId: null,
          canSend: false,
          sendBlockedReason: 'NOT_A_MEMBER',
          disclaimer: null,
          draftKey: 'msg:p1:0',
          maxLength: 8000,
          attachments: [],
          placeholder: 'loading…',
        })}
      />,
    );
    expect(container.querySelector<HTMLElement>('.composer')?.dataset.roomId).toBe('');
    expect(container.querySelector('label')?.textContent).toBe('Message (no room open)');
    expect(container.querySelector<HTMLTextAreaElement>('textarea.composer__body')?.placeholder).toBe('loading…');
  });
});
