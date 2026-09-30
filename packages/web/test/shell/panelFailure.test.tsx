/**
 * packages/web/test/shell/panelFailure.test.tsx — a panel whose run failed must not say `loading…`
 * (TERM-12's register, applied to the screen body rather than to a cell).
 *
 * All thirty-eight screens draw a skeleton for an absent payload, and the skeleton says `loading…`.
 * That is true while a run is in flight and false the moment it has failed, and the two states are
 * indistinguishable in the payload: both are "no payload". Measured on the running terminal with
 * `SRCH` answering `500 INTERNAL` — the panel body read
 * `SRCH · US Treasuries loading… Types On-the-run … CUSIP SECURITY_TYP …` over a grid of em dashes,
 * while the footer alert read `SRCH failed. · trace a13fd835`. Two contradictory claims at once, and
 * the body is the larger of the two by an order of magnitude.
 *
 * The test drives both states in order on the SAME frame, because only the pair proves anything: an
 * assertion that a failed panel does not say `loading…` would also pass against a panel that says
 * nothing at all, or against a screen registry that never drew a skeleton in the first place. So the
 * skeleton is asserted PRESENT while the frame is loading and ABSENT once it has failed.
 *
 * `SRCH` on purpose: it is the screen the defect was measured on, and it is a real registered screen
 * with a real manifest, so the skeleton here is the one a user saw.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Shell } from '../../src/shell/Shell.js';
import { usePanelsStore } from '../../src/state/panels.js';
import { useSessionStore } from '../../src/state/session.js';
import { useSettingsStore } from '../../src/state/settings.js';
import { useSubscriptionsStore } from '../../src/state/subscriptions.js';
import { useWorkspaceStore } from '../../src/state/workspace.js';

const TRACE = 'a13fd835-9c21-4f55-8a0e-6d1b2c3d4e5f';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(dirname(TEST_DIR))));

/** The committed `SRCH` payload, so the "still has a payload" case renders the real screen. */
function srchGolden(): unknown {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'fixtures', 'golden', 'functions', 'SRCH.default.json'), 'utf8'),
  );
}

beforeEach(() => {
  useWorkspaceStore.getState().reset();
  usePanelsStore.getState().reset();
  useSessionStore.getState().reset();
  useSubscriptionsStore.getState().reset();
  useSettingsStore.getState().reset();
});

afterEach(() => {
  usePanelsStore.getState().reset();
  useWorkspaceStore.getState().reset();
});

describe('a panel whose function failed', () => {
  it('stops claiming the data is on its way, and says what happened instead', () => {
    render(<Shell />);
    const body = screen.getByTestId('panel-body-p1');

    act(() => {
      usePanelsStore.getState().pushFrame('p1', {
        security: null,
        fn: 'SRCH',
        params: {},
        traceId: TRACE,
      });
    });

    // The precondition, asserted rather than assumed: while the run is in flight the screen really
    // does draw the skeleton, and the skeleton really does say `loading…`.
    expect(
      within(body).getAllByText(/loading…/).length,
      'SRCH drew no skeleton, so the assertion below could not fail',
    ).toBeGreaterThan(0);

    act(() => {
      usePanelsStore.getState().replaceFrame('p1', {
        status: 'error',
        error: { code: 'INTERNAL', message: 'SRCH failed.', traceId: TRACE },
      });
    });

    expect(within(body).queryAllByText(/loading…/)).toEqual([]);
    expect(screen.getByTestId('panel-failed-p1')).toHaveTextContent(
      'SRCH could not be run — INTERNAL · SRCH failed.',
    );
    // The trace id is the one thing a user is asked to read out (OPS-07), so it is on the screen and
    // not only in the footer.
    expect(body).toHaveTextContent('Trace a13fd835');
    // The footer alert stays: the body explains, the footer is the `role="alert"` a screen reader is
    // told about.
    expect(screen.getByTestId('panel-error-p1')).toHaveTextContent('INTERNAL · SRCH failed.');
  });

  it('keeps a screen that still has a payload, and reports the failed refresh beside it', () => {
    render(<Shell />);
    const body = screen.getByTestId('panel-body-p1');

    act(() => {
      usePanelsStore.getState().pushFrame('p1', {
        security: null,
        fn: 'SRCH',
        params: {},
        traceId: TRACE,
      });
      // A payload arrives, and a later refresh of the same frame fails. The panel has something true
      // to show and must go on showing it — this is the case the branch above must NOT take.
      usePanelsStore.getState().replaceFrame('p1', { status: 'ready', payload: srchGolden() });
      usePanelsStore.getState().replaceFrame('p1', {
        status: 'error',
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'the curve feed is down.', traceId: TRACE },
      });
    });

    expect(screen.queryByTestId('panel-failed-p1')).toBeNull();
    expect(screen.getByTestId('panel-error-p1')).toHaveTextContent('PROVIDER_UNAVAILABLE');
    // The screen it drew before the failed refresh is still on screen, and it is not a skeleton.
    expect(within(body).queryAllByText(/loading…/)).toEqual([]);
    // A value only the payload can supply: `pricing.curveId` from the committed golden.
    expect(body).toHaveTextContent('UST_PAR');
  });
});
