// packages/web/src/shell/HelpOverlay.tsx — HELP ×1 (TERM-09, FUNCTIONS.md §4 L989-1010,
// CLIENT.md §15 L1160-1170).
//
// One press of `F1` answers "what am I looking at". It is rendered over the right third of the
// focused panel rather than replacing it, because the answer is only useful next to the question:
// a user reading a `YAS` screen wants to know what `Z-SPREAD` means *while looking at the number*.
//
// What it shows is fixed by §4 and none of it is decoration:
//
//   * the summary and description of the function, from its manifest;
//   * its params, each with its documented text, an example, **and the value this panel is
//     currently running with** — the difference between "what this parameter does" and "what it is
//     set to right now" is most of what a help press is actually asking;
//   * the merged keymap (manifest + screen), because the keys are the interface;
//   * the definition of every `fieldId` on the screen, with the source and the attribution that
//     licence terms require to be shown (API-07, DATA-10);
//   * the related codes, which `Enter` launches — help that tells you where to go next;
//   * the last trace id, which is what turns a support conversation into a lookup.
//
// The second press is not this component's decision. `keyboard/dispatcher.ts` owns the 10-second
// window (`nextHelpEffect`) and opens `TicketDialog` instead; the footer line here says so, and the
// `onTicket` prop exists so the overlay's own button does the identical thing. Two components each
// deciding whether they are "the second press" would eventually disagree, and the disagreement
// would be a ticket opened by someone who wanted an explanation.
//
// IO: none directly. `loadHelp()` is the one call site for `GET /help/:code` and goes through the
// injected SDK (API-05); the component itself renders whatever it is handed.

import { useEffect, useRef } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';

import type { RequestOptions } from '@terminal/sdk';
import type { HelpResponse } from '@terminal/sdk/wire/rest/functions';

/* ---------------------------------------------------------------------------------------------- */
/* Loading                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** The slice of the SDK the overlay's content comes from (`Rest.Help.Get`, API.md §5.12). */
export interface HelpSdk {
  help: {
    get(
      args: { params: { code: string }; query?: { assetClass?: string } },
      init?: RequestOptions,
    ): Promise<unknown>;
  };
}

export interface HelpRequest {
  code: string;
  /** The panel security's asset class: the same function documents itself differently per class. */
  assetClass?: string | undefined;
  traceId?: string | undefined;
}

/**
 * `GET /help/:code?assetClass=` — the one call site.
 *
 * The response is the wire `HelpResponse`; a caller that has it already (the `HELP` screen renders
 * the same payload) passes it straight to the component instead.
 */
export async function loadHelp(sdk: HelpSdk, request: HelpRequest): Promise<HelpResponse> {
  const init: RequestOptions = request.traceId === undefined ? {} : { traceId: request.traceId };
  const response = await sdk.help.get(
    {
      params: { code: request.code },
      ...(request.assetClass === undefined ? {} : { query: { assetClass: request.assetClass } }),
    },
    init,
  );
  return response as HelpResponse;
}

/* ---------------------------------------------------------------------------------------------- */
/* Props                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

export interface HelpOverlayProps {
  panelId: string;
  /** `null` while loading, or when the request failed. */
  help: HelpResponse | null;
  status?: 'loading' | 'ready' | 'error';
  error?: { code: string; message: string } | null;
  /** The panel's current params, shown beside each documented param (FUNCTIONS §4). */
  params?: Record<string, unknown>;
  /** The `fieldId`s actually on screen; the dictionary rows are narrowed to these when given. */
  visibleFields?: readonly string[];
  /** The frame's trace id — the last line of the overlay, and what a ticket quotes. */
  traceId?: string | null;
  onClose: () => void;
  /** `Enter` on a related code launches it in this panel. */
  onLaunch: (code: string) => void;
  /** HELP again: the ticket (TERM-09). */
  onTicket: () => void;
  /** Reported once when the overlay opens, so the Shell can emit `fn.help` (FUNCTIONS §1.10). */
  onOpened?: (mode: 'function') => void;
}

/* ---------------------------------------------------------------------------------------------- */
/* Presentation                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

const PANEL: CSSProperties = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  width: 'min(34%, 48ch)',
  minWidth: '32ch',
  zIndex: 30,
  overflowY: 'auto',
  padding: '0 1ch',
  background: 'var(--c-bg-header)',
  borderLeft: '1px solid var(--c-grid-line)',
  color: 'var(--c-value)',
};

const H: CSSProperties = { margin: '0.5em 0 0', color: 'var(--c-label)', fontSize: '1rem' };
const DL: CSSProperties = { margin: 0 };
const DT: CSSProperties = { color: 'var(--c-label)' };
const DD: CSSProperties = { margin: '0 0 0.25em 0' };
const MUTED: CSSProperties = { color: 'var(--c-muted)' };
const LIST: CSSProperties = { margin: 0, padding: 0, listStyle: 'none' };

/* ---------------------------------------------------------------------------------------------- */
/* The overlay                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

export function HelpOverlay({
  panelId,
  help,
  status = help === null ? 'loading' : 'ready',
  error = null,
  params = {},
  visibleFields,
  traceId = null,
  onClose,
  onLaunch,
  onTicket,
  onOpened,
}: HelpOverlayProps): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Focus moves into the overlay (FUNCTIONS §4). `focus.ts#openOverlay` remembers what was focused
  // underneath, so `Escape` puts the user back on the grid row they pressed F1 from.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || help === null) return;
    opened.current = true;
    onOpened?.('function');
  }, [help, onOpened]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    // Tab is trapped: an overlay the user can Tab out of, while the screen behind it still answers
    // the arrows, is how a keyboard UI loses track of where it is (CLIENT §3.4).
    if (e.key === 'Tab') trapTab(e, rootRef.current);
  };

  const fields =
    visibleFields === undefined || help === null
      ? (help?.fields ?? [])
      : help.fields.filter((f) => visibleFields.includes(f.id));

  return (
    <div
      className="help"
      role="dialog"
      aria-modal="false"
      aria-label={help === null ? 'Help' : `Help · ${help.code}`}
      tabIndex={-1}
      ref={rootRef}
      style={PANEL}
      data-panel-id={panelId}
      onKeyDown={onKeyDown}
    >
      {status === 'loading' && help === null ? (
        <p style={MUTED}>Loading help…</p>
      ) : status === 'error' || help === null ? (
        <p role="alert" style={{ color: 'var(--c-error)' }}>
          {error === null ? 'Help is unavailable.' : `${error.code}: ${error.message}`}
        </p>
      ) : (
        <>
          <h2 style={{ ...H, marginTop: 0 }}>{`${help.code} · ${help.name}`}</h2>
          <p>{help.summary}</p>
          {help.description === '' ? null : <p style={MUTED}>{help.description}</p>}

          {help.params.length === 0 ? null : (
            <>
              <h3 style={H}>Parameters</h3>
              <dl style={DL}>
                {help.params.map((param) => (
                  <div key={param.name}>
                    <dt style={DT}>{param.name}</dt>
                    <dd style={DD}>
                      {param.text}
                      {param.example === undefined ? null : (
                        <span style={MUTED}>{` · e.g. ${param.example}`}</span>
                      )}
                      <span className="help__current">{` · now: ${valueText(params[param.name])}`}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}

          {help.keys.length === 0 ? null : (
            <>
              <h3 style={H}>Keys</h3>
              <ul style={LIST}>
                {help.keys.map((key) => (
                  <li key={`${key.key}:${key.action}`}>
                    <span style={DT}>{key.key}</span>
                    {` ${key.action}`}
                  </li>
                ))}
              </ul>
            </>
          )}

          {fields.length === 0 ? null : (
            <>
              <h3 style={H}>Fields on this screen</h3>
              <dl style={DL}>
                {fields.map((field) => (
                  <div key={field.id}>
                    <dt style={DT}>{`${field.label} (${field.id})`}</dt>
                    <dd style={DD}>
                      {field.definition}
                      <span style={MUTED}>{` · ${field.attribution}`}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}

          {help.sources.length === 0 ? null : (
            <>
              <h3 style={H}>Sources</h3>
              <ul style={LIST}>
                {help.sources.map((source) => (
                  <li key={source} style={MUTED}>
                    {source}
                  </li>
                ))}
              </ul>
            </>
          )}

          {help.related.length === 0 ? null : (
            <>
              <h3 style={H}>Related</h3>
              <ul style={{ ...LIST, display: 'flex', flexWrap: 'wrap', gap: '1ch' }}>
                {help.related.map((code) => (
                  <li key={code}>
                    <button
                      type="button"
                      className="help__related"
                      style={{ font: 'inherit', color: 'var(--c-label)', background: 'transparent', border: '1px solid var(--c-grid-line)' }}
                      onClick={() => {
                        onLaunch(code);
                      }}
                    >
                      {code}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <footer style={{ ...MUTED, borderTop: '1px solid var(--c-grid-line)', marginTop: '0.5em' }}>
        <p style={{ margin: 0 }}>{`trace ${traceId ?? '—'}`}</p>
        <button
          type="button"
          className="help__ticket"
          style={{ font: 'inherit', color: 'var(--c-label)', background: 'transparent', border: '1px solid var(--c-grid-line)' }}
          onClick={onTicket}
        >
          HELP again — open a ticket
        </button>
        <button
          type="button"
          className="help__close"
          style={{ font: 'inherit', color: 'var(--c-muted)', background: 'transparent', border: 'none' }}
          onClick={onClose}
        >
          Close (Esc)
        </button>
      </footer>
    </div>
  );
}

/** A param's current value, printed the way the command line would accept it back. */
function valueText(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value === '' ? '—' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => valueText(v)).join(',');
  return JSON.stringify(value);
}

/**
 * Keep `Tab` inside a dialog (CLIENT §3.4).
 *
 * Exported because `TicketDialog` traps the same way, and two implementations of a focus trap in
 * one shell is one too many.
 */
export function trapTab(e: ReactKeyboardEvent<HTMLElement>, root: HTMLElement | null): void {
  if (root === null) return;
  const focusable = [
    ...root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => !el.hasAttribute('disabled'));
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) return;

  const active = root.ownerDocument.activeElement;
  e.stopPropagation();
  if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault();
    last.focus();
    return;
  }
  if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
    return;
  }
  if (active === root) {
    e.preventDefault();
    first.focus();
  }
}

export default HelpOverlay;
