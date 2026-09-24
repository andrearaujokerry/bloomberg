// packages/web/src/shell/TicketDialog.tsx — HELP ×2 (TERM-09, FUNCTIONS.md §4 L991-992,
// CLIENT.md §15 L1166-1169).
//
// The second `F1` says "the explanation did not answer it". What makes the ticket worth opening is
// what travels with it: the panel, the function, the params it is running with, the fields actually
// on the screen **with their provenance indexes**, the trace id, and the last error. A helpdesk
// user opening it can therefore reproduce the exact screen — same function, same security, same
// params, same as-of, same sources — without a single round of "what were you looking at?".
//
// There is no 24/7 desk behind this (BRIEF §1). Tickets are rows answered by `helpdesk` users at
// `HELP TICKETS`, and the confirmation hands back the `ticketId` and the `roomId` of the room the
// server opened, which the Shell turns into `MSG` in the next panel. That is why `onOpened` carries
// both ids rather than this component navigating on its own: which panel is "next" is the Shell's
// business, not a dialog's.
//
// `ticket.open` is NOT emitted here. FUNCTIONS §1.10 assigns that event to the server's
// `POST /help/tickets`, which is also the only side that knows the `ticketId` it must carry. A
// client-side copy would double-count every ticket in the roadmap query.
//
// IO: one call, `sdk.help.openTicket`, through the injected port (API-05).

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';

import type { RequestOptions } from '@terminal/sdk';
import type { SecurityRefInput } from '@terminal/sdk/wire/common';
import type { TicketCreatedResponse, TicketRequest } from '@terminal/sdk/wire/rest/help';

import { trapTab } from './HelpOverlay.js';

/* ---------------------------------------------------------------------------------------------- */
/* What the ticket carries                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** One value the user can see, and where its number came from (DATA-10). */
export interface VisibleField {
  /** The `fieldId` when the element named one, else the row label — something a human can search. */
  id: string;
  /** Index into `meta.provenance[]`; `-1` is a pending value, which is itself worth reporting. */
  provIdx: number;
}

/** `TicketRequest.screenState`, pre-filled from the panel (FUNCTIONS §4). */
export interface ScreenState extends Record<string, unknown> {
  fields: VisibleField[];
  nodes: string[];
}

export interface TicketDraft {
  panelId: string;
  functionCode?: string | undefined;
  security?: SecurityRefInput | undefined;
  params?: Record<string, unknown> | undefined;
  screenState: ScreenState | Record<string, unknown>;
  traceId?: string | undefined;
  lastError?: { code: string; message: string } | null;
}

/** The slice of the SDK this dialog calls (`Rest.Help.OpenTicket`, API.md §5.12). */
export interface TicketSdk {
  help: {
    openTicket(args: { body: TicketRequest }, init?: RequestOptions): Promise<unknown>;
  };
}

export interface TicketDialogProps {
  draft: TicketDraft;
  sdk: TicketSdk;
  onClose: () => void;
  /** The server opened a room for this ticket: the Shell runs `MSG` on it in the next panel. */
  onOpened?: (result: TicketCreatedResponse) => void;
}

/** `TicketRequest.question` is `.min(1).max(4000)`. */
export const MAX_QUESTION = 4_000;

/* ---------------------------------------------------------------------------------------------- */
/* Harvesting the screen (FUNCTIONS §4: "visible field ids + their provIdx")                         */
/* ---------------------------------------------------------------------------------------------- */

/** How many values are worth attaching before the ticket stops being readable. */
export const MAX_VISIBLE_FIELDS = 200;

/**
 * Read the visible values and their provenance indexes out of a rendered panel.
 *
 * The renderer already publishes both: every element standing for a value carries `data-prov-idx`
 * (`screen/ScreenRenderer.tsx`, DATA-10) and a live cell carries `data-field`. Harvesting the DOM
 * rather than walking the `ScreenSpec` is deliberate — what is in the DOM is what the user can
 * actually see, including the tab that happens to be open and the rows that are scrolled into view,
 * and it needs no per-widget cooperation to stay true.
 */
export function collectScreenState(root: HTMLElement | null): ScreenState {
  const fields: VisibleField[] = [];
  const nodes: string[] = [];
  if (root === null) return { fields, nodes };

  for (const node of root.querySelectorAll<HTMLElement>('[data-node-id]')) {
    const id = node.dataset.nodeId;
    if (id !== undefined && id !== '' && !nodes.includes(id)) nodes.push(id);
  }

  for (const element of root.querySelectorAll<HTMLElement>('[data-prov-idx]')) {
    if (fields.length >= MAX_VISIBLE_FIELDS) break;
    const raw = element.dataset.provIdx;
    if (raw === undefined) continue;
    const provIdx = Number.parseInt(raw, 10);
    if (Number.isNaN(provIdx)) continue;
    const named = element.querySelector<HTMLElement>('[data-field]');
    const id =
      named?.dataset.field ??
      element.dataset.field ??
      (element.textContent ?? '').trim().split('\n')[0]?.slice(0, 40) ??
      '';
    if (id === '') continue;
    fields.push({ id, provIdx });
  }

  return { fields, nodes };
}

/* ---------------------------------------------------------------------------------------------- */
/* Presentation                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

const BACKDROP: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 40,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0, 0, 0, 0.5)',
};

const DIALOG: CSSProperties = {
  width: 'min(72ch, 92%)',
  maxHeight: '90%',
  overflowY: 'auto',
  padding: '0 1ch',
  background: 'var(--c-bg-header)',
  border: '1px solid var(--c-grid-line)',
  color: 'var(--c-value)',
};

const LABEL: CSSProperties = { color: 'var(--c-label)' };
const MUTED: CSSProperties = { color: 'var(--c-muted)' };
const BUTTON: CSSProperties = {
  font: 'inherit',
  color: 'var(--c-label)',
  background: 'transparent',
  border: '1px solid var(--c-grid-line)',
};

/* ---------------------------------------------------------------------------------------------- */
/* The dialog                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

export function TicketDialog({ draft, sdk, onClose, onOpened }: TicketDialogProps): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const questionRef = useRef<HTMLTextAreaElement | null>(null);
  const [state, setState] = useState<'editing' | 'sending' | 'sent' | 'failed'>('editing');
  const [created, setCreated] = useState<TicketCreatedResponse | null>(null);
  const [failure, setFailure] = useState<string>('');

  useEffect(() => {
    questionRef.current?.focus();
  }, []);

  const submit = (): void => {
    const question = (questionRef.current?.value ?? '').trim();
    if (question === '' || state === 'sending') return;

    const body: TicketRequest = {
      panelId: draft.panelId,
      screenState: withError(draft.screenState, draft.lastError ?? null),
      question: question.slice(0, MAX_QUESTION),
      ...(draft.functionCode === undefined ? {} : { functionCode: draft.functionCode }),
      ...(draft.security === undefined ? {} : { security: draft.security }),
      ...(draft.params === undefined ? {} : { params: draft.params }),
      ...(draft.traceId === undefined ? {} : { traceId: draft.traceId }),
    };

    setState('sending');
    const init: RequestOptions = draft.traceId === undefined ? {} : { traceId: draft.traceId };
    void sdk.help
      .openTicket({ body }, init)
      .then((response) => {
        const result = response as TicketCreatedResponse;
        setCreated(result);
        setState('sent');
        onOpened?.(result);
      })
      .catch((error: unknown) => {
        const api = error as { code?: unknown; message?: unknown } | null;
        const code = typeof api?.code === 'string' ? api.code : 'INTERNAL';
        const message = typeof api?.message === 'string' ? api.message : 'the ticket was not opened';
        setFailure(`${code}: ${message}`);
        setState('failed');
      });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      trapTab(e, rootRef.current);
      return;
    }
    // GO submits (FUNCTIONS §4). `Shift+Enter` stays a newline: a question worth asking often
    // needs two lines, and losing one to an accidental submit is worse than an extra keystroke.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
  };

  const fields = fieldsOf(draft.screenState);

  return (
    <div className="ticket__backdrop" style={BACKDROP}>
      <div
        className="ticket"
        role="dialog"
        aria-modal="true"
        aria-label="Open a helpdesk ticket"
        tabIndex={-1}
        ref={rootRef}
        style={DIALOG}
        data-panel-id={draft.panelId}
        onKeyDown={onKeyDown}
      >
        <h2 style={{ ...LABEL, fontSize: '1rem', margin: '0.5em 0' }}>Open a ticket</h2>

        {state === 'sent' && created !== null ? (
          <div role="status">
            <p>{`Ticket ${String(created.ticketId)} opened.`}</p>
            <p style={MUTED}>
              {`The helpdesk room is open in the next panel (MSG room ${String(created.roomId)}). Answers arrive there.`}
            </p>
            <button type="button" style={BUTTON} onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <>
            <dl style={{ margin: '0 0 0.5em' }}>
              <dt style={LABEL}>Panel</dt>
              <dd style={{ margin: 0 }}>{draft.panelId}</dd>
              <dt style={LABEL}>Function</dt>
              <dd style={{ margin: 0 }}>{draft.functionCode ?? '—'}</dd>
              <dt style={LABEL}>Security</dt>
              <dd style={{ margin: 0 }}>{securityText(draft.security)}</dd>
              <dt style={LABEL}>Params</dt>
              <dd style={{ margin: 0 }}>{paramsText(draft.params)}</dd>
              <dt style={LABEL}>Fields attached</dt>
              <dd style={{ margin: 0 }}>
                {`${String(fields.length)} value${fields.length === 1 ? '' : 's'} with provenance`}
              </dd>
              <dt style={LABEL}>Trace</dt>
              <dd style={{ margin: 0 }}>{draft.traceId ?? '—'}</dd>
              {draft.lastError == null ? null : (
                <>
                  <dt style={LABEL}>Last error</dt>
                  <dd style={{ margin: 0, color: 'var(--c-error)' }}>
                    {`${draft.lastError.code}: ${draft.lastError.message}`}
                  </dd>
                </>
              )}
            </dl>

            <label htmlFor={`ticket-question-${draft.panelId}`} style={LABEL}>
              Question
            </label>
            <textarea
              id={`ticket-question-${draft.panelId}`}
              ref={questionRef}
              className="ticket__question"
              rows={5}
              maxLength={MAX_QUESTION}
              style={{
                font: 'inherit',
                width: '100%',
                background: 'var(--c-bg-panel)',
                color: 'var(--c-value)',
                border: '1px solid var(--c-grid-line)',
              }}
              placeholder="What did you expect to see, and what did you see instead?"
            />

            {state === 'failed' ? (
              <p role="alert" style={{ color: 'var(--c-error)' }}>
                {failure}
              </p>
            ) : null}

            <p style={MUTED}>
              The panel, function, params, the visible fields with their provenance indexes and the
              trace id are attached, so the desk can reproduce this screen exactly.
            </p>

            <div style={{ display: 'flex', gap: '1ch', paddingBottom: '0.5em' }}>
              <button
                type="button"
                className="ticket__submit"
                style={BUTTON}
                disabled={state === 'sending'}
                onClick={submit}
              >
                {state === 'sending' ? 'Sending…' : 'GO — open ticket'}
              </button>
              <button type="button" className="ticket__cancel" style={BUTTON} onClick={onClose}>
                Cancel (Esc)
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The last error rides in `screenState`: the wire schema has no field of its own for it. */
function withError(
  screenState: Record<string, unknown>,
  lastError: { code: string; message: string } | null,
): Record<string, unknown> {
  return lastError === null ? { ...screenState } : { ...screenState, lastError };
}

function fieldsOf(screenState: Record<string, unknown>): VisibleField[] {
  const fields = screenState.fields;
  return Array.isArray(fields) ? (fields as VisibleField[]) : [];
}

function securityText(security: SecurityRefInput | undefined): string {
  if (security === undefined) return '—';
  if ('id' in security) return `#${String(security.id)}`;
  if ('ref' in security) return security.ref;
  return security.formula;
}

function paramsText(params: Record<string, unknown> | undefined): string {
  if (params === undefined) return '—';
  const entries = Object.entries(params);
  if (entries.length === 0) return '—';
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(' ');
}

export default TicketDialog;
