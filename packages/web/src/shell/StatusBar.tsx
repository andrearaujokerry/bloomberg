// packages/web/src/shell/StatusBar.tsx — the one row that says whether to trust the screen.
//
// CLIENT.md §3.3 L262-270, WORKPLAN L1376. Five things live here and each of them exists because a
// number on a terminal is only worth as much as what the user knows about it:
//
//   connection      `● LIVE` / `◐ RESYNC` / `○ OFFLINE` from `LiveClient.state`. A dead socket that
//                   still shows `LIVE` is TERM-12's defect in its purest form.
//   conflation      the effective interval, so "the price has not moved" and "the price is batched
//                   to 2 s because the plant is shedding" are distinguishable.
//   staleness       the legend. THE LEGEND IS THE POINT OF THIS FILE. `ScreenRenderer`'s cells are
//                   drawn in five states and the difference between them is colour plus a `·` —
//                   which is unreadable to anyone who has not been told what it means. So the
//                   legend names all five and renders each swatch with the SAME `data-st`
//                   attribute the cells carry, which is what `tokens.css` styles. There is no
//                   second set of colours here and there cannot be one: the swatch is styled by the
//                   same rule as the cell it explains, so the two cannot drift.
//   trace id        the focused frame's `traceId`, dimmed — what a user reads out to support, and
//                   what OPS-07 correlates the server logs by.
//   quotas          `SessionInfo.quotas`, counted and not enforced for a web session (API.md §8),
//                   shown as `used / limit` through `<meter>` so nothing here computes a ratio.
//
// And one thing that is not a status but an interruption: a workspace save that could not be
// reconciled (TERM-05). `state/workspace.ts` merges and retries once; a second 409 means somebody
// else is actively writing, and the user has to choose. That choice is offered here, as an `alert`
// with two buttons, because silently keeping either copy loses a desk layout without ever saying so.
//
// No arithmetic on any number a user reads: `format/index.ts` renders the integers and `<meter>`
// draws the gauge from `value`/`max`. Layout numbers (the row height) are the web package's own.

import { useCallback } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import type { ValueState } from '@terminal/core';
import type { LiveState } from '@terminal/sdk';

import { formatValue } from '../format/index.js';
import { selectFocusedFrame, usePanelsStore } from '../state/panels.js';
import { selectNeedsReload, useSessionStore } from '../state/session.js';
import { useSubscriptionsStore } from '../state/subscriptions.js';
import type { QuotaCounters } from '../state/session.js';
import { selectConflictMessage, useWorkspaceStore } from '../state/workspace.js';

/* ---------------------------------------------------------------------------------------------- */
/* Connection                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

export interface ConnectionDisplay {
  /** `●` / `◐` / `○` — shape as well as colour, so the state survives a monochrome screen. */
  readonly glyph: string;
  readonly label: string;
  /** The colour token, by name; `cssVar` is applied at the point of use. */
  readonly tone: '--c-ok' | '--c-warn' | '--c-error';
  /** What a screen reader and a test read. */
  readonly title: string;
}

/**
 * `LiveState` → the three states CLIENT §3.3 names. `connecting` and `resyncing` collapse onto
 * RESYNC deliberately: both mean "values on screen may be behind the plant", which is the only
 * distinction a trader acts on. `idle` and `closed` are both OFFLINE for the same reason — a socket
 * that was never opened and one that died show the same thing, because they mean the same thing.
 */
export function connectionOf(state: LiveState): ConnectionDisplay {
  switch (state) {
    case 'open':
      return { glyph: '●', label: 'LIVE', tone: '--c-ok', title: 'Connected to the live plant' };
    case 'connecting':
    case 'resyncing':
      return {
        glyph: '◐',
        label: 'RESYNC',
        tone: '--c-warn',
        title: 'Reconnecting — values may be behind the plant until the next snapshot',
      };
    case 'idle':
    case 'closed':
      return {
        glyph: '○',
        label: 'OFFLINE',
        tone: '--c-error',
        title: 'No live connection — nothing on screen is updating',
      };
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* The staleness legend (TERM-12)                                                                   */
/* ---------------------------------------------------------------------------------------------- */

export interface LegendEntry {
  readonly st: ValueState;
  /** The state's own name — the same word `CellView` puts in a cell's accessible description. */
  readonly label: string;
  /** What such a cell looks like: a number for the three that carry one, the glyph for the two. */
  readonly sample: string;
  readonly title: string;
}

/**
 * The five states, in the order a value degrades through them.
 *
 * `sample` deliberately shows the same number for `live`, `stale` and `closed`: what distinguishes
 * them is the treatment, not the digits, and a legend that used three different numbers would
 * suggest otherwise. The `·` suffix on the stale swatch is NOT written here — `tokens.css` appends
 * it with `[data-st='stale']::after`, exactly as it does on a cell, which is the whole point.
 */
export const STALENESS_LEGEND: readonly LegendEntry[] = Object.freeze([
  {
    st: 'live',
    label: 'live',
    sample: '104.25',
    title: 'Updating now',
  },
  {
    st: 'stale',
    label: 'stale',
    sample: '104.25',
    title: 'Last known value — no fresh update within the field’s staleness window',
  },
  {
    st: 'closed',
    label: 'closed',
    sample: '104.25',
    title: 'Session ended — the official close, not expected to change',
  },
  {
    st: 'blank',
    label: 'blank',
    sample: '—',
    title: 'Withheld — not entitled, or the source has nothing; never a number',
  },
  {
    st: 'na',
    label: 'na',
    sample: '·',
    title: 'Not applicable to this instrument',
  },
] satisfies readonly LegendEntry[]);

/* ---------------------------------------------------------------------------------------------- */
/* Quotas                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** The three counters, in the order API.md §5.13 lists them, with the labels the bar has room for. */
const QUOTA_ROWS: readonly { key: keyof QuotaCounters; label: string; title: string }[] =
  Object.freeze([
    {
      key: 'dailyUniqueInstruments',
      label: 'inst/d',
      title: 'Distinct instruments requested today',
    },
    { key: 'monthlyDataPoints', label: 'pts/mo', title: 'Data points served this month' },
    { key: 'concurrentSubscriptions', label: 'subs', title: 'Concurrent live subscriptions' },
  ]);

/* ---------------------------------------------------------------------------------------------- */
/* Styles                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

const S = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: '2ch',
    minHeight: 'var(--row-px)',
    padding: '0 1ch',
    background: 'var(--c-bg-header)',
    color: 'var(--c-muted)',
    borderTop: '1px solid var(--c-grid-line)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  },
  group: { display: 'flex', alignItems: 'center', gap: '1ch' },
  legend: { display: 'flex', alignItems: 'center', gap: '1.5ch' },
  legendItem: { display: 'inline-flex', alignItems: 'baseline', gap: '0.5ch' },
  legendLabel: { color: 'var(--c-muted)' },
  spacer: { flex: '1 1 auto' },
  trace: { color: 'var(--c-pending)' },
  meter: { width: '6ch', height: '0.8em', verticalAlign: 'middle' },
  conflict: {
    display: 'flex',
    alignItems: 'center',
    gap: '1ch',
    minHeight: 'var(--row-px)',
    padding: '0 1ch',
    background: 'var(--c-bg-header)',
    color: 'var(--c-warn)',
    borderTop: '1px solid var(--c-warn)',
  },
  action: {
    color: 'var(--c-focus)',
    textDecoration: 'underline',
    cursor: 'pointer',
    padding: '0 0.5ch',
  },
  reload: { color: 'var(--c-warn)', fontWeight: 'var(--w-strong)' },
} satisfies Record<string, CSSProperties>;

/* ---------------------------------------------------------------------------------------------- */
/* The bar                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

export interface StatusBarProps {
  /**
   * `LiveClient.state`. WP-13 owns the socket; until it is attached the honest answer is `idle`,
   * which renders OFFLINE — not a blank space and not an optimistic LIVE.
   */
  connection?: LiveState | undefined;
  /**
   * The trace id to show. Defaults to the focused panel's frame, which is the request a user is
   * looking at and therefore the one they would quote to support (OPS-07).
   */
  traceId?: string | null | undefined;
  /** The server clock, already formatted by its owner; omitted when there is nothing to show. */
  clock?: string | undefined;
  /** `web/0.1.0` — the running bundle, beside the RELOAD badge when the plant has moved past it. */
  clientVersion?: string | undefined;
}

export function StatusBar({
  connection = 'idle',
  traceId,
  clock,
  clientVersion,
}: StatusBarProps): ReactElement {
  const conflationMs = useSubscriptionsStore((s) => s.effectiveConflationMs);
  const quotas = useSessionStore((s) => s.quotas);
  const storeClientVersion = useSessionStore((s) => s.clientVersion);
  const needsReload = useSessionStore(selectNeedsReload);
  const focusedFrame = usePanelsStore(selectFocusedFrame);
  const conflictMessage = useWorkspaceStore(selectConflictMessage);


  const conn = connectionOf(connection);
  const shownTrace = traceId === undefined ? (focusedFrame?.traceId ?? null) : traceId;
  const version = clientVersion ?? storeClientVersion;

  // `getState()` rather than a selected method — the store's actions are stable.
  const onReload = useCallback(() => {
    void useWorkspaceStore.getState().resolveConflict('reload');
  }, []);
  const onKeepMine = useCallback(() => {
    void useWorkspaceStore.getState().resolveConflict('keep-mine');
  }, []);

  return (
    <div>
      {conflictMessage === null ? null : (
        // `role="alert"` and not a toast: a toast auto-dismisses, and a dismissed conflict is a
        // silently lost layout. It stays until the user answers.
        <div style={S.conflict} role="alert" data-testid="workspace-conflict">
          <span>{conflictMessage}</span>
          <button type="button" style={S.action} onClick={onReload}>
            Reload theirs
          </button>
          <button type="button" style={S.action} onClick={onKeepMine}>
            Keep mine
          </button>
        </div>
      )}

      <footer
        style={S.bar}
        role="status"
        aria-label="Terminal status"
        data-testid="status-bar"
      >
        <span
          style={{ ...S.group, color: `var(${conn.tone})` }}
          data-connection={conn.label}
          title={conn.title}
        >
          <span aria-hidden="true">{conn.glyph}</span>
          <span>{conn.label}</span>
        </span>

        <span style={S.group} data-testid="conflation" title="Effective conflation interval">
          {`conf ${formatValue('int', conflationMs)}ms`}
        </span>

        <span
          style={S.legend}
          role="group"
          aria-label="Staleness legend"
          data-testid="staleness-legend"
        >
          {STALENESS_LEGEND.map((entry) => (
            <span key={entry.st} style={S.legendItem} title={entry.title}>
              {/* Same `data-st` the cells carry: one rule in tokens.css styles both. */}
              <span data-st={entry.st} data-legend-swatch={entry.st}>
                {entry.sample}
              </span>
              <span style={S.legendLabel}>{entry.label}</span>
            </span>
          ))}
        </span>

        <span style={S.spacer} />

        <span style={S.group} role="group" aria-label="Quotas" data-testid="quotas">
          {quotas === null
            ? 'quotas —'
            : QUOTA_ROWS.map(({ key, label, title }) => {
                const usage = quotas[key];
                return (
                  <span key={key} style={S.legendItem} title={title} data-quota={key}>
                    <span>{label}</span>
                    <meter
                      style={S.meter}
                      min={0}
                      max={usage.limit}
                      value={usage.used}
                      aria-label={title}
                    />
                    <span>{`${formatValue('int', usage.used)}/${formatValue('int', usage.limit)}`}</span>
                  </span>
                );
              })}
        </span>

        {shownTrace === null || shownTrace === '' ? null : (
          <span style={S.trace} data-testid="trace-id" title={`Trace ${shownTrace}`}>
            {`trace ${shownTrace.slice(0, 8)}`}
          </span>
        )}

        {clock === undefined ? null : <span data-testid="clock">{clock}</span>}

        {version === null || version === undefined ? null : <span>{version}</span>}

        {needsReload ? (
          <span style={S.reload} role="alert" data-testid="reload-badge">
            RELOAD
          </span>
        ) : null}
      </footer>
    </div>
  );
}

export default StatusBar;
