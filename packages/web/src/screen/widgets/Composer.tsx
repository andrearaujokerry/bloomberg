// packages/web/src/screen/widgets/Composer.tsx — the `custom#Composer` component: MSG's message
// draft (MSG-01, MSG-03, TERM-06; FUNCTIONS_TIER1 §MSG L1704, CLIENT.md §10.3).
//
// MSG's right pane ended in a grey box reading "Composer — waiting for its component", because
// `widgets.tsx` registered nothing for the name. This file is the component. Three things about it
// are decisions rather than details, and each is a limit of the composition root rather than of the
// design, so each is stated here and in the DOM instead of being papered over.
//
// ## 1. It composes; it cannot send, and it says so
//
// §MSG L1704 specifies the send: `POST /rooms/:roomId/messages { clientMsgId, body, attachments,
// structured }`, retried on the same `clientMsgId` because the route is idempotent on it (API.md
// §5.10). A `custom` component is handed `{ id, component, props, actions }` and nothing else —
// `ScreenActions` is `navigate`, `navigateNext`, `openUrl`, `provenance` — so there is no messaging
// port in the widget tree at all, and `App.tsx`'s `AppSdk` does not carry one either: the routes it
// declares are the eight this application calls, and `messaging.send` is not among them.
//
// The choice was therefore between a send button wired to an injected port that NO product call site
// provides — dead code with a test that proves nothing about the running terminal — and a composer
// that states the gap in one sentence beside the control. This is the second. What the user gets is
// the draft, the policy they are drafting under, and the truth about the button; what they do not get
// is a GO that appears to send and does not. The seam to close is named in `data-send-state` and in
// the note: one port on the registry, one route on `AppSdk`, one line in `buildRuntime`.
//
// ## 2. The draft outlives a payload refresh, and lives nowhere else
//
// `props.draftKey` is `msg:<panelId>:<roomId>` — a key per panel per room, which is what tells this
// component that a draft is expected to survive things. It survives the one thing that would
// otherwise eat it: MSG re-runs (a new message arrives, `Alt+U` toggles, the room list refreshes) and
// the screen rebuilds its `ScreenSpec`, remounting this node. The draft is held in a module-scope
// `Map` for exactly that, and NOT in `localStorage`: an unsent message in a WORM-archived,
// surveilled product (MSG-02, MSG-05) is not something to leave on a shared terminal's disk, and no
// requirement asks for it to outlive the page.
//
// ## 3. Attachments are not rendered, because none can exist yet
//
// `props.attachments` is `PendingAttachment[]` and both MSG call sites pass `[]` — always. An
// attachment is collected by `Alt+S` / `Alt+F` / `Alt+W` (§MSG's keyboard table), which need
// `ctx.prompt`, a thing no `custom` component is given. A chip renderer here would be a branch no
// payload reaches. The count is reported when a payload ever carries one, which is a statement, not
// a renderer.
//
// ## Keyboard (TERM-06, TERM-07)
//
// `Enter` sends, `Shift+Enter` is a newline — §MSG's keyboard table, and the same split
// `TicketDialog` uses, for the same reason (a message worth writing often needs two lines). The
// textarea is the node's one tab stop, so `ScreenRenderer#focusNode` reaches it for `initialFocus`
// and `Tab`. Printable keys are safe here without any work by this file:
// `keyboard/focus.ts#capturesTypedText` already treats a `custom` node whose component is `Composer`
// as text, so the window dispatcher's type-anywhere routing leaves it alone.
//
// ## FXC also emits `custom#Composer`, and this is not its component
//
// `FXC/Screen.tsx` uses the name for a 9×9 currency cross matrix — "a keyboard-driven editor grid",
// its own comment says — passing `{ ccys, rows }` of `ValueCell`s, an unrelated shape. Drawing a
// message composer over it would be worse than the placeholder it has today, so the FX shape is
// recognised and reported as what it is: a node whose component is not written, named precisely, with
// the size of the matrix it is holding. It keeps its own `data-composer-state`, so the two gaps stay
// distinguishable in a test and in a ticket.

import { useCallback, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';

import type { CustomComponentProps } from './registry.js';

/* ---------------------------------------------------------------------------------------------- */
/* The two prop shapes that arrive under this one name                                              */
/* ---------------------------------------------------------------------------------------------- */

/** MSG's draft (§MSG L1704), as far as this component reads it. */
export interface ComposerDraftProps {
  readonly roomId: number | null;
  readonly canSend: boolean;
  /** `NOT_A_MEMBER`, `MESSAGE_POLICY_BLOCKED`, … — shown whenever `canSend` is false (ENTL-05). */
  readonly sendBlockedReason: string;
  readonly disclaimer: string | null;
  readonly draftKey: string;
  readonly maxLength: number;
  readonly attachments: number;
  /** MSG's skeleton passes `placeholder: 'loading…'`. */
  readonly placeholder: string | null;
}

/** FXC's matrix, as far as this component needs to NAME it. */
export interface ComposerMatrixProps {
  readonly ccys: readonly string[];
  readonly rows: number;
}

export type ComposerShape =
  | { readonly kind: 'draft'; readonly draft: ComposerDraftProps }
  | { readonly kind: 'matrix'; readonly matrix: ComposerMatrixProps }
  | { readonly kind: 'unreadable' };

/** `SendMessageRequest.body` is `z.string().max(8000)`; a bigger `maxLength` would be refused. */
export const MAX_BODY = 8_000;

/**
 * Which of the two shapes this is.
 *
 * `draftKey` is the discriminator because it is the member FXC cannot have — it is the per-panel,
 * per-room draft identity — and because a shape test on `roomId` alone would accept the skeleton's
 * `roomId: null` from either screen.
 */
export function composerShapeOf(props: unknown): ComposerShape {
  if (typeof props !== 'object' || props === null) return { kind: 'unreadable' };
  const bag = props as Record<string, unknown>;

  if (typeof bag.draftKey === 'string' && bag.draftKey !== '') {
    const limit = typeof bag.maxLength === 'number' && bag.maxLength > 0 ? bag.maxLength : MAX_BODY;
    return {
      kind: 'draft',
      draft: {
        roomId: typeof bag.roomId === 'number' ? bag.roomId : null,
        canSend: bag.canSend === true,
        sendBlockedReason:
          typeof bag.sendBlockedReason === 'string' && bag.sendBlockedReason !== ''
            ? bag.sendBlockedReason
            : 'NOT_A_MEMBER',
        disclaimer: typeof bag.disclaimer === 'string' && bag.disclaimer !== '' ? bag.disclaimer : null,
        draftKey: bag.draftKey,
        // Clamped to the wire schema's own ceiling: a screen that asked for more would be writing a
        // draft the route refuses, and the user would learn that only on GO.
        maxLength: Math.min(limit, MAX_BODY),
        attachments: Array.isArray(bag.attachments) ? bag.attachments.length : 0,
        placeholder: typeof bag.placeholder === 'string' && bag.placeholder !== '' ? bag.placeholder : null,
      },
    };
  }

  if (Array.isArray(bag.ccys) && Array.isArray(bag.rows)) {
    return {
      kind: 'matrix',
      matrix: {
        ccys: bag.ccys.filter((c): c is string => typeof c === 'string'),
        rows: bag.rows.length,
      },
    };
  }

  return { kind: 'unreadable' };
}

/* ---------------------------------------------------------------------------------------------- */
/* The drafts                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Unsent text, per `draftKey`, for the lifetime of the page.
 *
 * Module scope rather than component state because the point is to survive the remount that MSG's
 * next payload causes (see the header), and rather than a store because nothing else in the
 * application has any business reading a half-written message.
 */
const drafts = new Map<string, string>();

/** What is held for this key right now — exported so a test can assert the survival, not the Map. */
export function composerDraft(draftKey: string): string {
  return drafts.get(draftKey) ?? '';
}

/** Forget every draft. Called by a test's `afterEach`; nothing in the product clears them all. */
export function clearComposerDrafts(): void {
  drafts.clear();
}

/* ---------------------------------------------------------------------------------------------- */
/* Presentation                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

const S = {
  host: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25em',
    minHeight: 0,
    height: '100%',
    padding: '0 1ch',
  },
  disclaimer: { margin: 0, color: 'var(--c-warn)' },
  note: { margin: 0, color: 'var(--c-muted)' },
  blocked: { margin: 0, color: 'var(--c-blocked)' },
  area: {
    font: 'inherit',
    flex: '1 1 auto',
    minHeight: '2.5em',
    resize: 'none',
    background: 'var(--c-bg-panel)',
    color: 'var(--c-value)',
    border: '1px solid var(--c-grid-line)',
  },
  footer: { display: 'flex', alignItems: 'baseline', gap: '1ch', color: 'var(--c-muted)' },
  count: { marginLeft: 'auto' },
} satisfies Record<string, CSSProperties>;

/* ---------------------------------------------------------------------------------------------- */
/* The component                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `custom#Composer`.
 *
 * The three states are the payload's, not this file's: a room that admits the caller (`canSend`), a
 * room that does not (`sendBlockedReason` — printed, never a silent disabled control), and MSG's
 * skeleton, which passes `roomId: null` with `placeholder: 'loading…'` while the run is in flight.
 */
export function Composer({ id, props }: CustomComponentProps): ReactElement {
  const shape = composerShapeOf(props);

  if (shape.kind === 'matrix') {
    const { ccys, rows } = shape.matrix;
    return (
      <div
        className="composer composer--matrix"
        data-composer-state="matrix-not-implemented"
        data-composer-rows={String(rows)}
        role="group"
        aria-label={`Currency cross matrix ${id} — its component is not written`}
        tabIndex={0}
      >
        <p style={S.note}>
          {`Cross matrix ${id}: ${String(ccys.length)} currencies × ${String(rows)} rows are in hand and not drawn.`}
        </p>
        <p style={S.note}>
          FXC addresses this node as `Composer`, but it is a keyboard-driven rate grid, not a message
          composer, and no component for it exists. Nothing is plotted or printed here: a blank grid
          with the right shape would read as a matrix of missing rates.
        </p>
      </div>
    );
  }

  if (shape.kind === 'unreadable') {
    return (
      <div
        className="composer composer--unreadable"
        data-composer-state="unreadable"
        role="group"
        aria-label={`Composer ${id} — its props are neither a message draft nor a rate matrix`}
        tabIndex={0}
      >
        <p style={S.note}>{`Composer ${id}: these props carry no \`draftKey\`, so nothing is composed here.`}</p>
      </div>
    );
  }

  return <Draft id={id} draft={shape.draft} />;
}

interface DraftProps {
  id: string;
  draft: ComposerDraftProps;
}

function Draft({ id, draft }: DraftProps): ReactElement {
  const [text, setText] = useState(() => composerDraft(draft.draftKey));
  // `sent` is deliberately absent: nothing here can send. What this holds is the one thing a key
  // press can truthfully report — that GO was pressed and had nowhere to go.
  const [attempted, setAttempted] = useState(false);

  const write = useCallback(
    (value: string): void => {
      const clipped = value.slice(0, draft.maxLength);
      drafts.set(draft.draftKey, clipped);
      setText(clipped);
      setAttempted(false);
    },
    [draft.draftKey, draft.maxLength],
  );

  const send = useCallback((): void => {
    // The route this would call is `POST /rooms/:roomId/messages` with a fresh `clientMsgId`
    // (§MSG L1704). There is no port to call it through (file header), so the only honest thing a
    // press can do is say so. The draft is kept: a message the terminal could not send must not
    // disappear from the box the user typed it into.
    setAttempted(true);
  }, []);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      // §MSG: `Enter` on the composer is `send`. Stopped as well as prevented, because the panel and
      // the window dispatcher both sit above this element and `Enter` means something to both
      // (`keyboard/dispatcher.ts` returns on `defaultPrevented` — the element wins).
      e.preventDefault();
      e.stopPropagation();
      send();
    },
    [send],
  );

  const blocked = !draft.canSend;
  const room = draft.roomId === null ? null : `room ${String(draft.roomId)}`;

  return (
    <div
      className="composer"
      style={S.host}
      data-composer-state={blocked ? 'blocked' : 'ready'}
      data-send-state="unwired"
      data-room-id={draft.roomId === null ? '' : String(draft.roomId)}
      data-draft-key={draft.draftKey}
    >
      {draft.disclaimer === null ? null : (
        // Before the box, not after it: MSG-03's disclaimer is a condition of writing, and a
        // condition printed under the control it applies to has already been missed.
        <p style={S.disclaimer} data-testid="composer-disclaimer">
          {draft.disclaimer}
        </p>
      )}

      {blocked ? (
        <p style={S.blocked} role="status" data-testid="composer-blocked">
          {`Sending is blocked by policy: ${draft.sendBlockedReason}. The draft below is kept and not sent.`}
        </p>
      ) : null}

      <label htmlFor={`composer-${id}`} style={S.note}>
        {room === null ? 'Message (no room open)' : `Message to ${room}`}
      </label>
      <textarea
        id={`composer-${id}`}
        className="composer__body"
        style={S.area}
        rows={3}
        maxLength={draft.maxLength}
        value={text}
        placeholder={draft.placeholder ?? 'Enter sends · Shift+Enter is a new line'}
        aria-describedby={`composer-note-${id}`}
        onChange={(e) => {
          write(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />

      <div style={S.footer}>
        <button
          type="button"
          className="composer__send"
          style={{ font: 'inherit', color: 'var(--c-label)', background: 'transparent', border: '1px solid var(--c-grid-line)' }}
          // Not `disabled`: a disabled control with no explanation is the failure mode this build
          // treats as worse than a refusal. It is pressable, and pressing it says what happened.
          onClick={send}
        >
          GO — send
        </button>
        <span style={S.count} data-testid="composer-count">
          {`${String(text.length)}/${String(draft.maxLength)}`}
        </span>
      </div>

      <p id={`composer-note-${id}`} style={S.note} data-testid="composer-transport">
        {attempted
          ? 'Not sent: this build wires no messaging transport into the widget tree (POST /rooms/:roomId/messages). Your draft is kept.'
          : 'Drafting only — this build has no messaging transport wired (POST /rooms/:roomId/messages).'}
      </p>
      {draft.attachments === 0 ? null : (
        <p style={S.note} data-testid="composer-attachments">
          {`${String(draft.attachments)} attachment(s) pending; no attachment renderer exists (Alt+S/F/W are unbound).`}
        </p>
      )}
    </div>
  );
}

export default Composer;
