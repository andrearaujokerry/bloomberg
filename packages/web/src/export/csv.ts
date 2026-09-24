// packages/web/src/export/csv.ts — PRINT and the grid data export (FUNC-03, CLIENT.md §13,
// API.md §9, FUNCTIONS.md §2.6 `Ctrl+P` / `Ctrl+E`).
//
// THE ONE RULE: **this file never serialises a CSV.** It asks the server for one and saves the
// bytes the server sent, unmodified.
//
// That is not a style preference, it is the reason the rule exists. The server re-checks
// entitlement on export against `usage:'export'` and `purpose:'export:<CODE>'`, and **any** denied
// field fails the whole export with `403 ENTITLEMENT_DENIED` (ARCHITECTURE §10 rule 2,
// `wire/rest/export.ts`). A client-side serialiser would walk the payload that is already on
// screen — which is a *display* payload, already downgraded, already carrying blanked cells — and
// write a file that never passed the export check at all. The user would get a CSV of everything
// the screen happened to hold, under a licence that forbids exactly that, with no access-log row
// behind it. So: no `toCsv` here, no join on commas, no quoting. The server runs
// `core/functions/csv.ts#toCsv` over the cached payload and this file moves the result to disk.
//
// The second consequence of the same rule: the numbers in the file are the screen's numbers. Both
// sides ran the one exporter over the one payload, so a figure cannot read `1,234.50` on screen and
// `1234.4999` in the file (FUNCTIONS.md §1.6).
//
// IO: every request goes through the injected `@terminal/sdk` client (API-05). The only browser
// APIs touched are `Blob`, `URL.createObjectURL` and an `<a download>` click, which move bytes
// already in memory to the user's disk — no network call is made by this module outside the SDK.

import type { RequestOptions } from '@terminal/sdk';

/* ---------------------------------------------------------------------------------------------- */
/* What this module needs                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** The slice of a frame an export reads (`state/panels.ts#Frame`, API.md §5.7). */
export interface ExportFrame {
  fn: string | null;
  params: Record<string, unknown>;
  security: { id: number | null; display: string; ref?: string } | null;
  resultId: string | null;
  /** The payload's `meta`; `asOf` is what the re-resolve form is anchored to. */
  meta?: { resultId?: string; asOf?: { validAt: string; knownAt: string } } | undefined;
}

/**
 * The slice of `TerminalClient` this module calls.
 *
 * `fn.csv` is `GET /functions/:code/csv` (`Functions.Csv`) and `data.csv` is `POST /data/csv`
 * (`Data.Csv`); both are declared `format: 'csv'` on the wire and resolve to the document text.
 */
export interface ExportSdk {
  rest: { url(routeId: string, args?: { params?: unknown; query?: unknown }): string };
  fn: {
    csv(
      args: { params: { code: string }; query: Record<string, unknown> },
      init?: RequestOptions,
    ): Promise<unknown>;
  };
  data: {
    csv(args: { body: unknown }, init?: RequestOptions): Promise<unknown>;
  };
}

export interface ExportDeps {
  sdk: ExportSdk;
  /** The panel footer line (CLIENT §14): `NOTHING TO PRINT`, `EXPORT DENIED: …`. */
  footer(message: string): void;
  /** Transient notices — the `x-regenerated: true` toast of CLIENT §13.1 step 2. */
  toast?(message: string): void;
  /** Hands the finished document to the user. Defaults to a `Blob` + `<a download>` click. */
  save?(filename: string, text: string): void;
  /** Epoch milliseconds; injected so the 10-minute staleness rule is testable. */
  now?(): number;
  /** The frame's trace id, so the export shares the run's id (OPS-07). */
  traceId?: string | undefined;
}

export type ExportOutcome =
  | { kind: 'saved'; filename: string; bytes: number; regenerated: boolean; traceId: string | null }
  | { kind: 'nothing'; reason: string }
  | { kind: 'failed'; message: string; code: string; traceId: string | null };

/** CLIENT §13.1 step 2: a result older than this is re-resolved at its own as-of instead. */
export const RESULT_TTL_MS = 10 * 60_000;

/** What the footer says when PRINT is pressed on a panel with nothing in it. */
export const NOTHING_TO_PRINT = 'NOTHING TO PRINT';

/* ---------------------------------------------------------------------------------------------- */
/* PRINT — `Ctrl+P`, the key bar's PRINT, `ScreenCtx.export()` (CLIENT §13.1)                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Export the panel's current result as CSV.
 *
 * The request is made **through the SDK** rather than by navigating the browser to
 * `csvUrlFor(...)`. CLIENT §13.1 describes a navigation with a fetch behind it on failure, and the
 * navigation cannot be observed: an `<a download>` click reports neither its status nor its body,
 * so a `403 ENTITLEMENT_DENIED` would land as a browser error page or a zero-byte file and step 4
 * of that same section — the `EXPORT DENIED: PX_BID LICENCE_FORBIDS_USAGE (trace 3f2a)` footer —
 * could never be rendered. One request, whose envelope is readable, satisfies both steps. The URL
 * builder stays exported for the callers that want the browser's own download manager
 * (`csvUrlFor`), and neither path serialises anything locally.
 */
export async function exportResult(deps: ExportDeps, frame: ExportFrame): Promise<ExportOutcome> {
  const code = frame.fn;
  if (code === null || code === '') return nothing(deps, NOTHING_TO_PRINT);

  const query = csvQueryFor(frame, deps.now?.() ?? Date.now());
  if (query === null) return nothing(deps, NOTHING_TO_PRINT);

  let headers: Record<string, string> = {};
  const init: RequestOptions = {
    onResponseHeaders: (h) => {
      headers = h;
    },
    ...(deps.traceId === undefined ? {} : { traceId: deps.traceId }),
  };

  try {
    const text = textOf(await deps.sdk.fn.csv({ params: { code }, query }, init));
    const filename = filenameFrom(headers['content-disposition'], code, frame);
    (deps.save ?? saveTextAsFile)(filename, text);
    const regenerated = headers['x-regenerated'] === 'true';
    if (regenerated) {
      deps.toast?.(`${code} re-resolved at its original as-of — the export is regenerated.`);
    }
    return {
      kind: 'saved',
      filename,
      bytes: text.length,
      regenerated,
      traceId: headers['x-trace-id'] ?? deps.traceId ?? null,
    };
  } catch (error) {
    return failed(deps, error, code);
  }
}

/**
 * The URL `GET /functions/:code/csv` resolves to, for a caller that would rather navigate than
 * fetch (a very large export, where the browser's download manager is the better tool).
 *
 * Returns `null` when the frame has nothing exportable, which is the same `NOTHING TO PRINT`
 * condition `exportResult` reports.
 */
export function csvUrlFor(sdk: ExportSdk, frame: ExportFrame, nowMs: number): string | null {
  const code = frame.fn;
  if (code === null || code === '') return null;
  const query = csvQueryFor(frame, nowMs);
  if (query === null) return null;
  return sdk.rest.url('Functions.Csv', { params: { code }, query });
}

/**
 * `FunctionCsvQuery` (`wire/rest/export.ts`): the `resultId` while the cached result is fresh, and
 * the re-resolve tuple once it is older than {@link RESULT_TTL_MS}.
 *
 * The re-resolve carries `validAt`/`knownAt` from the payload's own `asOf`, so the server resolves
 * **at the instant the screen was resolved at** rather than at now. An export that silently moved
 * to a later as-of would disagree with the screen it was taken from, which is the one thing a
 * point-in-time system may not do.
 */
function csvQueryFor(frame: ExportFrame, nowMs: number): Record<string, unknown> | null {
  const resultId = frame.meta?.resultId ?? frame.resultId;
  const asOf = frame.meta?.asOf;
  const knownAtMs = asOf === undefined ? Number.NaN : Date.parse(asOf.knownAt);
  const stale = Number.isFinite(knownAtMs) && nowMs - knownAtMs > RESULT_TTL_MS;

  if (typeof resultId === 'string' && resultId !== '' && !stale) return { resultId };

  // No result and no as-of to re-resolve against: there is genuinely nothing to print.
  if (asOf === undefined) return null;

  const security = frame.security;
  const ref = security === null ? undefined : (security.ref ?? security.display);
  return {
    params: base64UrlJson(frame.params),
    ...(ref === undefined || ref === '' ? {} : { security: ref }),
    validAt: asOf.validAt,
    knownAt: asOf.knownAt,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* `Ctrl+E` — the focused grid's data (CLIENT §13.2)                                                 */
/* ---------------------------------------------------------------------------------------------- */

/** The instrument × field shape `POST /data/csv` takes; anything else is PRINT's job. */
export interface GridExportRequest {
  securities: readonly { id: number }[];
  fields: readonly string[];
  /** Defaults to `'realtime'`; a historical grid passes its own kind and window. */
  kind?: string;
  /** Extra `DataRequest` members (`asOf`, `start`, `end`, `frequency`) for non-realtime kinds. */
  extra?: Record<string, unknown>;
  /** Names the saved file; the server's `content-disposition` wins when it sends one. */
  filename?: string;
}

/**
 * Export the focused grid's rows and columns.
 *
 * Only grids whose rows carry an instrument and whose columns carry a field id can be expressed as
 * a `DataRequest`; the long-format screens (FA statements and the like) have no `Ctrl+E` at all and
 * are covered by PRINT. The caller decides that — it is the grid that knows — and passes `null`
 * here when the grid does not qualify, which is reported as a footer line rather than silence.
 */
export async function exportGrid(
  deps: ExportDeps,
  request: GridExportRequest | null,
): Promise<ExportOutcome> {
  if (request === null || request.securities.length === 0 || request.fields.length === 0) {
    return nothing(deps, 'NOTHING TO EXPORT');
  }

  const body = {
    kind: request.kind ?? 'realtime',
    securities: request.securities.map((s) => ({ id: s.id })),
    fields: [...request.fields],
    usage: 'export',
    ...(request.extra ?? {}),
  };

  let headers: Record<string, string> = {};
  const init: RequestOptions = {
    onResponseHeaders: (h) => {
      headers = h;
    },
    ...(deps.traceId === undefined ? {} : { traceId: deps.traceId }),
  };

  try {
    const text = textOf(await deps.sdk.data.csv({ body }, init));
    const filename =
      dispositionFilename(headers['content-disposition']) ?? request.filename ?? 'data.csv';
    (deps.save ?? saveTextAsFile)(filename, text);
    return {
      kind: 'saved',
      filename,
      bytes: text.length,
      regenerated: false,
      traceId: headers['x-trace-id'] ?? deps.traceId ?? null,
    };
  } catch (error) {
    return failed(deps, error, 'DATA');
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Saving (CLIENT §13, `export/save.ts`'s job — see the note in the work-package report)             */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Hand server-produced text to the user as a file.
 *
 * `text` is always a response body. Nothing in this package ever composes one.
 */
export function saveTextAsFile(filename: string, text: string, doc: Document = document): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    clickDownload(url, filename, doc);
  } finally {
    // Revoking immediately is safe: the click has already started the download synchronously.
    URL.revokeObjectURL(url);
  }
}

/** Navigate to a URL as a download — the hidden `<a href download>` click of CLIENT §13.1 step 3. */
export function navigateToDownload(url: string, filename: string, doc: Document = document): void {
  clickDownload(url, filename, doc);
}

function clickDownload(url: string, filename: string, doc: Document): void {
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------------------------------------------------------------------------------------------- */
/* Internals                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

function nothing(deps: ExportDeps, reason: string): ExportOutcome {
  deps.footer(reason);
  return { kind: 'nothing', reason };
}

/**
 * The denial footer of CLIENT §13.1 step 4.
 *
 * The client decides nothing here: `details.reasons[]` is the server's list of the fields it
 * refused and why, and it is printed as sent (ENTL-05, "the screen only renders the badge").
 */
function failed(deps: ExportDeps, error: unknown, code: string): ExportOutcome {
  const api = error as
    | { code?: unknown; message?: unknown; traceId?: unknown; details?: Record<string, unknown> }
    | null;
  const apiCode = typeof api?.code === 'string' ? api.code : 'INTERNAL';
  const traceId = typeof api?.traceId === 'string' ? api.traceId : (deps.traceId ?? null);
  const message =
    typeof api?.message === 'string' && api.message !== ''
      ? api.message
      : `${code} export failed`;

  const denied = apiCode === 'ENTITLEMENT_DENIED';
  const reasons = denied ? reasonList(api?.details) : '';
  const short = traceId === null ? '' : ` (trace ${traceId.slice(0, 4)})`;
  const line = denied
    ? `EXPORT DENIED: ${reasons === '' ? message : reasons}${short}`
    : `EXPORT FAILED: ${message}${short}`;

  deps.footer(line);
  return { kind: 'failed', message: line, code: apiCode, traceId };
}

/** `[{ fieldId, reason }]` → `PX_BID LICENCE_FORBIDS_USAGE`, in the server's own words. */
function reasonList(details: Record<string, unknown> | undefined): string {
  const reasons = details?.reasons;
  if (!Array.isArray(reasons)) return '';
  const parts: string[] = [];
  for (const entry of reasons) {
    if (typeof entry === 'string') {
      parts.push(entry);
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const bag = entry as Record<string, unknown>;
    const field = typeof bag.fieldId === 'string' ? bag.fieldId : '';
    const reason = typeof bag.reason === 'string' ? bag.reason : '';
    const text = [field, reason].filter((p) => p !== '').join(' ');
    if (text !== '') parts.push(text);
  }
  return parts.join(', ');
}

/** A `CsvDocument` route answers with the validated text; a route without one answers `{text}`. */
function textOf(response: unknown): string {
  if (typeof response === 'string') return response;
  const bag = response as { text?: unknown } | null;
  return typeof bag?.text === 'string' ? bag.text : '';
}

function filenameFrom(
  disposition: string | undefined,
  code: string,
  frame: ExportFrame,
): string {
  const fromServer = dispositionFilename(disposition);
  if (fromServer !== undefined) return fromServer;
  // The server names the file (`manifest.csv.filename`). This is only for a response that did not.
  const security = frame.security?.display ?? '';
  const stem = [code, security].filter((p) => p !== '').join('_').replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${stem === '' ? 'export' : stem}.csv`;
}

/** `attachment; filename="HP_AAPL_US_Equity_20260915T184128Z.csv"` → the filename. */
function dispositionFilename(disposition: string | undefined): string | undefined {
  if (disposition === undefined || disposition === '') return undefined;
  const quoted = /filename\*?=(?:UTF-8'')?"([^"]+)"/i.exec(disposition);
  if (quoted?.[1] !== undefined) return decodeFilename(quoted[1]);
  const bare = /filename\*?=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (bare?.[1] === undefined) return undefined;
  const trimmed = bare[1].trim();
  return trimmed === '' ? undefined : decodeFilename(trimmed);
}

function decodeFilename(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `FunctionCsvQuery.params` is base64url JSON (`wire/rest/export.ts`). */
function base64UrlJson(value: unknown): string {
  const json = JSON.stringify(value ?? {});
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
