// WP-01 scaffold — CLIENT.md §2 L172-210 ("Bootstrap and session gate").
//
// Two things are real here and stay real: exactly one `RestClient` per page (API-05 — the web
// package never touches `fetch`/`WebSocket` itself), and the session gate that asks the plant who
// we are before anything else runs. Everything below `<ShellPlaceholder/>` is a placeholder for
// WP-12's `<Shell/>`: a header, one panel with a working command line, and a status bar. The
// command line is the element the WP-01 smoke spec looks for
// (`[data-testid="command-line"]`, role `textbox`, accessible name "Command line").

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';

import { RestClient, TerminalApiError } from '@terminal/sdk';

/** Injected by vite (`define` in `vite.config.ts`) from `package.json#version`. */
declare const __APP_VERSION__: string;

// ---------------------------------------------------------------------------------------------
// The one client for the page (CLIENT.md §2 L174-190)
// ---------------------------------------------------------------------------------------------

let client: RestClient | undefined;

/**
 * The single `RestClient` of the page, built on first use. WP-12 moves this to
 * `bootstrap/client.ts` and upgrades it to the full `createClient()` (REST + live + fields), but
 * the contract does not change: one instance, same-origin, cookie session.
 */
export function restClient(): RestClient {
  client ??= new RestClient({
    // `/api/v1` is appended by the client; the dev server proxies it to the plant on :8080.
    baseUrl: window.location.origin,
    clientVersion: `web/${__APP_VERSION__}`,
    credentials: 'include',
    traceId: () => crypto.randomUUID(), // one id per user action (OPS-07)
  });
  return client;
}

// ---------------------------------------------------------------------------------------------
// Session gate
// ---------------------------------------------------------------------------------------------

/** The slice of `SessionInfo` (API.md §1.3) this scaffold displays. */
export interface SessionSummary {
  readonly email: string;
  readonly displayName: string;
  readonly firmName: string;
  readonly role: string;
  readonly defaultTier: string;
}

export type GateState =
  | { readonly status: 'loading' }
  | { readonly status: 'authenticated'; readonly session: SessionSummary }
  | { readonly status: 'anonymous'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly message: string };

function str(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** `GET /auth/session` → the fields the status bar shows; unknown shapes degrade, never throw. */
export function toSessionSummary(raw: unknown): SessionSummary {
  const source: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const entitlements = source.entitlementSummary;
  const tier =
    typeof entitlements === 'object' && entitlements !== null
      ? str(entitlements as Record<string, unknown>, 'defaultTier', 'unknown')
      : 'unknown';
  return {
    email: str(source, 'email', 'unknown'),
    displayName: str(source, 'displayName', 'unknown'),
    firmName: str(source, 'firmName', 'unknown'),
    role: str(source, 'role', 'unknown'),
    defaultTier: tier,
  };
}

function describe(err: unknown): GateState {
  if (err instanceof TerminalApiError) {
    // 401 AUTH_REQUIRED / SESSION_EXPIRED / SESSION_SUPERSEDED → the login branch (WP-12).
    if (err.status === 401 || err.status === 403) {
      return { status: 'anonymous', reason: err.code };
    }
    const trace = err.traceId.slice(0, 8);
    return { status: 'unavailable', message: `${err.code} · ${err.message} · trace ${trace}` };
  }
  return { status: 'unavailable', message: err instanceof Error ? err.message : String(err) };
}

/**
 * Asks the plant for the current session. `RestClient.call()` (untyped) rather than
 * `request('Auth.Session')` so this file compiles before the generated route barrel lands;
 * WP-12 switches it to the typed form.
 */
export function useSessionGate(rest: RestClient): {
  gate: GateState;
  reload: () => void;
} {
  const [gate, setGate] = useState<GateState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const aborter = new AbortController();
    setGate({ status: 'loading' });
    void (async () => {
      try {
        const raw = await rest.call('Auth.Session', {}, { signal: aborter.signal });
        if (aborter.signal.aborted) return;
        setGate({ status: 'authenticated', session: toSessionSummary(raw) });
      } catch (err) {
        if (aborter.signal.aborted) return;
        setGate(describe(err));
      }
    })();
    return () => {
      aborter.abort();
    };
  }, [rest, attempt]);

  const reload = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  return { gate, reload };
}

// ---------------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------------

const S = {
  app: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: 'var(--c-bg)',
    color: 'var(--c-value)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '1ch',
    height: 'var(--header-px)',
    padding: '0 1ch',
    background: 'var(--c-bg-header)',
    color: 'var(--c-label)',
    fontWeight: 600,
  },
  spacer: { flex: '1 1 auto' },
  main: { flex: '1 1 auto', display: 'flex', minHeight: 0, padding: '2px', gap: '2px' },
  panel: {
    flex: '1 1 auto',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    background: 'var(--c-bg-panel)',
    border: '1px solid var(--c-grid-line)',
  },
  panelHeader: {
    display: 'flex',
    gap: '1ch',
    height: 'var(--header-px)',
    alignItems: 'center',
    padding: '0 1ch',
    background: 'var(--c-bg-header)',
    color: 'var(--c-label)',
  },
  cmdRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '1ch',
    padding: `0 var(--cell-pad-ch)`,
    borderBottom: '1px solid var(--c-grid-line)',
    height: 'var(--row-px)',
  },
  prompt: { color: 'var(--c-label)', fontWeight: 500 },
  input: { flex: '1 1 auto', minWidth: 0, color: 'var(--c-value)', caretColor: 'var(--c-label)' },
  body: { flex: '1 1 auto', overflow: 'auto', padding: '1ch' },
  muted: { color: 'var(--c-muted)' },
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '2ch',
    height: 'var(--row-px)',
    padding: '0 1ch',
    background: 'var(--c-bg-header)',
    color: 'var(--c-muted)',
  },
  banner: {
    padding: '0 1ch',
    height: 'var(--row-px)',
    display: 'flex',
    alignItems: 'center',
    gap: '1ch',
    background: 'var(--c-bg-header)',
  },
  action: { color: 'var(--c-focus)', cursor: 'pointer', textDecoration: 'underline' },
} satisfies Record<string, CSSProperties>;

function sessionLine(gate: GateState): string {
  switch (gate.status) {
    case 'loading':
      return 'SESSION · checking…';
    case 'authenticated':
      return `${gate.session.displayName} · ${gate.session.firmName} · ${gate.session.role.toUpperCase()} · ${gate.session.defaultTier.toUpperCase()}`;
    case 'anonymous':
      return `SIGNED OUT · ${gate.reason}`;
    case 'unavailable':
      return `PLANT UNAVAILABLE · ${gate.message}`;
  }
}

/**
 * Stand-in for WP-12's `<Shell/>`. It renders one panel whose command line accepts input and
 * echoes what was entered, so the scaffold is demonstrably wired end to end without pretending to
 * execute functions.
 */
function ShellPlaceholder({ gate, onRetry }: { gate: GateState; onRetry: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [log, setLog] = useState<readonly string[]>([]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    if (event.key === 'Enter') {
      event.preventDefault();
      const value = input.value.trim();
      if (value.length === 0) return;
      setLog((entries) => [...entries.slice(-19), value.toUpperCase()]);
      input.value = '';
    } else if (event.key === 'Escape') {
      event.preventDefault();
      input.value = '';
    } else if (event.key === 'l' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      input.select();
    }
  }, []);

  return (
    <div style={S.app}>
      <header style={S.header}>
        <span>TERMINAL</span>
        <span style={S.muted}>web/{__APP_VERSION__}</span>
        <span style={S.spacer} />
        <span style={S.muted}>{sessionLine(gate)}</span>
      </header>

      {gate.status === 'anonymous' || gate.status === 'unavailable' ? (
        <div style={S.banner} role="status">
          <span style={{ color: gate.status === 'anonymous' ? 'var(--c-warn)' : 'var(--c-error)' }}>
            {gate.status === 'anonymous'
              ? 'No session — sign-in arrives with the shell work package.'
              : 'The plant did not answer /auth/session.'}
          </span>
          <span style={S.muted}>{sessionLine(gate)}</span>
          <button type="button" style={S.action} onClick={onRetry}>
            RETRY
          </button>
        </div>
      ) : null}

      <main style={S.main}>
        <section
          style={S.panel}
          data-panel="p1"
          aria-label="Panel 1"
          data-testid="shell-entry-point"
        >
          <div style={S.panelHeader}>
            <span>1</span>
            <span style={S.muted}>SHELL ENTRY POINT</span>
          </div>
          <div style={S.cmdRow}>
            <span style={S.prompt} aria-hidden="true">
              1&gt;
            </span>
            <input
              ref={inputRef}
              style={S.input}
              data-testid="command-line"
              aria-label="Command line"
              name="command"
              type="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="AAPL US Equity DES <GO>"
              onKeyDown={onKeyDown}
            />
          </div>
          <div style={S.body} data-testid="panel-frame">
            {log.length === 0 ? (
              <p style={S.muted}>
                Scaffold shell. The command line is live; function execution, panels, grids and
                charts are rendered by the shell work package.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {log.map((entry, i) => (
                  <li key={`${String(i)}:${entry}`}>
                    <span style={S.prompt}>{entry}</span>{' '}
                    <span style={S.muted}>· NOT IMPLEMENTED (no function registry yet)</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>

      <footer style={S.statusBar} data-testid="status-bar">
        <span>{sessionLine(gate)}</span>
        <span style={S.spacer} />
        <span>HELP for assistance</span>
      </footer>
    </div>
  );
}

/**
 * The session gate: one `RestClient`, one `GET /auth/session`, then the shell. The gate result is
 * surfaced rather than blocking, because the scaffold has no login form yet — WP-12 replaces the
 * `anonymous` branch with `<Login/>` and the shell placeholder with the real `<Shell/>`.
 */
export function App() {
  const rest = restClient();
  const { gate, reload } = useSessionGate(rest);
  return <ShellPlaceholder gate={gate} onRetry={reload} />;
}

export default App;
