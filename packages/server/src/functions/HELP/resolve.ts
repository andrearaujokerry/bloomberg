/**
 * `functions/HELP/resolve.ts` — HELP (FUNCTIONS_TIER1.md §HELP L2111-2119, FUNCTIONS.md §4).
 *
 * Four views, one variant. Everything HELP shows is read from something that *runs*: the function
 * registry the runner dispatches through, the field dictionary the entitlement evaluator resolves
 * against, and `field_licence ⋈ licence_registry`, which is the same join DATA-09 makes the
 * attribution strip out of. Nothing here is a second copy of the documentation, which is the only
 * reason HELP cannot drift from behaviour.
 *
 * Three decisions worth stating:
 *
 *  1. **`view:'function'` is built here, not from `routes/functions.ts#helpFor`.** That builder
 *     answers `GET /functions/:code/help` and needs a `LicenceRegistry`; a resolver is handed a
 *     `ResolveContext`, which has no registry in it. §HELP's resolver step 2 specifies the read as
 *     "1 DB round-trip (`field_licence` ⋈ `licence_registry`)", and that is what this file does —
 *     the same two tables the registry loads, at `ctx.asOf` (the registry is a cache of them).
 *  2. **An unknown `code` is `404 FUNCTION_NOT_FOUND`**, the same code the runner raises at step 1,
 *     so the client's error map does not have to tell an unknown function from a missing help
 *     entry (§HELP L2113). An `assetClass` the manifest does not cover is *not* an error: the
 *     entry is still returned with a `NOT_APPLICABLE` note, so the overlay explains why the
 *     command was rejected instead of refusing to explain anything.
 *  3. **`ctx.entitle` here decorates, it does not gate.** HELP returns no value, so the secondary
 *     decision exists only to label each `fields[]` row `delayed ✓` / `eod (TIER_EOD)` /
 *     `blocked (NO_FIRM_ENTITLEMENT)` — which is how a user finds out why a cell on the previous
 *     screen was blank (ENTL-05, TERM-11).
 *
 * HELP touches no provider and carries no `ValueCell`: its payload is documentation.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';

// `FunctionTier` (1 | 2 | 3), not the quote `Tier` the barrel exports under that name: the
// catalogue tier a manifest carries is a build-order rank, not an entitlement latency.
import type { AnyFunctionManifest, AssetClass, FieldId, FunctionTier } from '@terminal/core';
import { registry } from '@terminal/core';
import { jaccard, trigramsOf } from '@terminal/core';
import { fieldDefs, getField } from '@terminal/core/fields/dictionary';
import type {
  HelpFieldRow,
  HelpFunctionBlock,
  HelpIndexEntry,
  HelpParams,
  HelpPayload,
  HelpSearchHit,
  HelpTicketRow,
} from '@terminal/core/functions/manifests/HELP';

import type { FunctionServerModule, ResolveContext } from '../context.js';
import { NotFoundError } from '../../http/errors.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Static documentation (FUNCTIONS.md §2.6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The shell words of §2.6 L792-795, each with its one-line text. */
export const SHELL_WORDS: readonly { word: string; text: string }[] = Object.freeze([
  { word: '/layout 1|2h|2v|4', text: 'Choose the panel layout.' },
  { word: '/panel 1..8', text: 'Focus a panel.' },
  { word: '/conflate <ms>', text: 'Set this session’s conflation interval (50–5000 ms).' },
  { word: '/theme dark|light|system', text: 'Switch the colour theme.' },
  { word: '/clear', text: 'Empty the focused panel’s frame stack.' },
  { word: '/logout', text: 'End the session on this device.' },
  { word: '/trace', text: 'Show the last trace id, for a support ticket.' },
  { word: '/version', text: 'Show the build id and the registry version.' },
]);

/** The reserved global key map of §2.6 L797-812; a function keymap may not bind these. */
export const RESERVED_KEYS: readonly { key: string; action: string }[] = Object.freeze([
  { key: 'Enter', action: 'GO — execute the command line or the selected autocomplete row' },
  { key: 'Escape', action: 'CANCEL / MENU — close overlay, clear the draft, then go back' },
  { key: 'F1', action: 'HELP — explain this screen; a second press within 10 s opens a ticket' },
  { key: 'F2…F11', action: 'Yellow sector keys — insert the sector token after the ticker' },
  { key: 'Ctrl+P', action: 'PRINT — export the focused panel’s result as CSV' },
  { key: 'PageDown / PageUp', action: 'PAGE FWD / PAGE BACK' },
  { key: 'Alt+ArrowLeft / Alt+ArrowRight', action: 'Frame back / forward' },
  { key: 'Alt+1…Alt+8', action: 'Focus panel 1…8' },
  { key: 'Ctrl+Tab / Ctrl+Shift+Tab', action: 'Next / previous panel' },
  { key: 'Tab / Shift+Tab', action: 'Next / previous focus region' },
  { key: 'Ctrl+I', action: 'Provenance panel for the focused cell' },
  { key: 'Ctrl+L', action: 'Focus the panel’s command line' },
  { key: 'Ctrl+E', action: 'Export the focused grid as /data/csv' },
]);

/** §HELP L2181: TERM-09 is met as a mechanism, not as staffing (BRIEF §1). */
export const NO_LIVE_ANALYST_DESK_DETAIL =
  "no 24/7 staffed desk in this build: tickets are answered by the firm's helpdesk users " +
  '(BRIEF §1)';

/** The roles that answer tickets, and therefore the roles that see the firm's whole queue. */
const DESK_ROLES: readonly string[] = ['helpdesk', 'admin'];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// view: 'index'
// ─────────────────────────────────────────────────────────────────────────────────────────────

function indexView(): HelpPayload {
  const tiers: { tier: FunctionTier; functions: HelpIndexEntry[] }[] = [];
  for (const tier of [1, 2, 3] as const) {
    tiers.push({
      tier,
      functions: registry.byTier(tier).map((m) => ({
        code: m.code,
        name: m.name,
        summary: m.help.summary,
        aliases: [...m.aliases],
      })),
    });
  }
  return {
    variant: 'default',
    view: 'index',
    tiers,
    shell: SHELL_WORDS.map((w) => ({ ...w })),
    keys: RESERVED_KEYS.map((k) => ({ ...k })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// view: 'function'
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One row of `field_licence ⋈ licence_registry`, as-of `ctx.asOf` (DATA-09). */
interface LicenceJoinRow extends Record<string, unknown> {
  field_id: string;
  source_id: string;
  attribution: string;
  provenance_id: string | null;
  tx_from: string;
}

/**
 * The attribution for each field, in one statement.
 *
 * `asset_class IS NULL OR asset_class = <class>` mirrors evaluator rule 1's two lookups: a caller
 * naming a class gets that class's row, and a caller naming none gets the field-wide one. The
 * `licence_registry` side is read at `tx_to = 'infinity'` — the current terms — because that is
 * what the screen footer must print today.
 */
async function licenceRows(
  ctx: ResolveContext,
  fieldIds: readonly FieldId[],
  assetClass: AssetClass | null,
): Promise<Map<string, LicenceJoinRow>> {
  const out = new Map<string, LicenceJoinRow>();
  if (fieldIds.length === 0) return out;
  const ids = sql.join(
    fieldIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const classFilter =
    assetClass === null ? sql`TRUE` : sql`fl.asset_class = ${assetClass}::asset_class`;
  const res = await ctx.db.execute<LicenceJoinRow>(sql`
    SELECT fl.field_id, fl.source_id, lr.attribution,
           lr.provenance_id::text AS provenance_id,
           to_char(lr.tx_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS tx_from
      FROM field_licence fl
      JOIN licence_registry lr
        ON lr.source_id = fl.source_id AND lr.tx_to = 'infinity'
     WHERE fl.field_id IN (${ids}) AND (${classFilter})`);
  for (const row of res.rows) if (!out.has(row.field_id)) out.set(row.field_id, row);
  return out;
}

/** `z.toJSONSchema` per param key, with the default the schema itself produces. */
function paramRows(manifest: AnyFunctionManifest): HelpFunctionBlock['params'] {
  const shape = (manifest.params as z.ZodObject<z.ZodRawShape>).shape;
  // The defaults, read out of the schema rather than out of `_def`: parsing the empty object is
  // the schema's own statement of what every optional key means when it is not supplied.
  const parsed = (manifest.params as z.ZodType<unknown>).safeParse({});
  const defaults = (parsed.success ? parsed.data : {}) as Record<string, unknown>;
  const rows: HelpFunctionBlock['params'] = [];
  for (const [name, schema] of Object.entries(shape)) {
    rows.push({
      name,
      schema: z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
      default: defaults[name] ?? null,
    });
  }
  return rows;
}

async function functionView(ctx: ResolveContext, params: HelpParams): Promise<HelpPayload> {
  const code = params.code ?? '';
  const manifest = registry.get(code);
  if (manifest === undefined) {
    throw new NotFoundError(`no function ${code}`, 'FUNCTION_NOT_FOUND', { code });
  }

  const assetClass = params.assetClass ?? null;
  const classes = manifest.assetClasses;
  const covers =
    assetClass === null ||
    classes === 'any' ||
    (classes !== 'none' && classes.includes(assetClass));
  if (!covers) {
    ctx.unavailable.add({
      field: 'function',
      reason: 'NOT_APPLICABLE',
      detail: `${manifest.code} does not apply to ${assetClass ?? 'this asset class'}`,
    });
  }

  const fieldIds = manifest.fieldIds(covers ? assetClass : null);
  const licences = await licenceRows(ctx, fieldIds, covers ? assetClass : null);

  // The decision that labels each row. It returns no value, so nothing is served under it; it is
  // the `access_log` row any read would have produced, which is what makes the label truthful.
  const decisions = new Map<
    string,
    { decision: HelpFieldRow['decision']; reason: HelpFieldRow['reason'] }
  >();
  if (fieldIds.length > 0) {
    const decision = await ctx.entitle([...fieldIds], 'display');
    for (const field of decision.fields) {
      decisions.set(field.fieldId, { decision: field.decision, reason: field.reason });
    }
  }

  const fields: HelpFieldRow[] = [];
  for (const fieldId of fieldIds) {
    const def = getField(fieldId);
    if (def === undefined) continue;
    const licence = licences.get(fieldId);
    if (licence === undefined) {
      ctx.unavailable.add({
        field: `fields.${fieldId}.attribution`,
        reason: 'NO_SOURCE',
        detail: `no field_licence row for ${fieldId} × ${assetClass ?? 'any asset class'}`,
      });
    } else if (licence.provenance_id !== null) {
      // The bootstrap registry versions carry `provenance_id NULL` (DATA_MODEL §2: they are the
      // only rows allowed to), so this cites a row only once the terms have been re-published
      // from a real exchange. `ctx.prov.add` on a null id would name a provenance row that does
      // not exist, which the runner refuses — correctly.
      ctx.prov.add({
        sourceId: licence.source_id,
        provenanceId: Number(licence.provenance_id),
        capturedAt: new Date(licence.tx_from),
        sourceTs: null,
        st: 'closed',
        tier: 'eod',
      });
    }
    const verdict = decisions.get(fieldId);
    fields.push({
      id: fieldId,
      label: def.label,
      definition: def.definition,
      sourceId: licence?.source_id ?? '',
      attribution: licence?.attribution ?? '',
      decision: verdict?.decision ?? 'allow',
      reason: verdict?.reason ?? 'OK',
    });
  }

  // ENTL-05, honestly: the evaluator's rule 1 keys on `(fieldId, assetClass)` and the asset class
  // it is given is the *panel security's*, which a help request does not carry (`assetClasses:
  // 'none'` ⇒ the runner passes `instrument: null`). A field whose per-class rows name different
  // sources — `PX_LAST` is Cboe on an equity and CoinGecko on a coin — therefore comes back
  // `FIELD_UNKNOWN` rather than with this firm's real verdict. The row still renders, and the note
  // says why the column is blank instead of letting it read as "you are blocked".
  if (fields.some((row) => row.reason === 'FIELD_UNKNOWN')) {
    ctx.unavailable.add({
      field: 'fields.decision',
      reason: 'NOT_APPLICABLE',
      detail:
        'the per-field entitlement decision is evaluated against the panel security’s asset ' +
        'class; a help request carries no security, so a field whose licence differs by asset ' +
        'class is reported FIELD_UNKNOWN rather than with this firm’s verdict',
    });
  }

  // A REST caller has no panel, so there is no dynamic screen keymap to merge (§HELP L2182).
  ctx.unavailable.add({
    field: 'function.keys',
    reason: 'NOT_APPLICABLE',
    detail: 'screen keymap unavailable — REST callers see manifest keys only',
  });

  return {
    variant: 'default',
    view: 'function',
    function: {
      code: manifest.code,
      name: manifest.name,
      tier: manifest.tier,
      variant: assetClass === null ? null : (manifest.variants[assetClass] ?? null),
      help: {
        summary: manifest.help.summary,
        description: manifest.help.description,
        params: manifest.help.params.map((p) => ({ ...p })),
        keys: manifest.help.keys.map((k) => ({ ...k })),
        sources: [...manifest.help.sources],
        related: [...manifest.help.related],
      },
      params: paramRows(manifest),
      csvColumns:
        typeof manifest.csv.columns === 'function'
          ? null
          : manifest.csv.columns.map((c) => ({ ...c })),
      fields,
      keys: manifest.keymap.map((k) => ({ ...k })),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// view: 'search'
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface HelpDoc {
  kind: HelpSearchHit['kind'];
  id: string;
  title: string;
  /** Everything the scorer reads; the snippet window is cut out of this. */
  text: string;
}

/** The documents §HELP L2114 names, in one array; built per run and cheap (≈ 400 rows). */
function helpDocuments(): HelpDoc[] {
  const docs: HelpDoc[] = [];
  for (const m of registry.all()) {
    docs.push({
      kind: 'function',
      id: m.code,
      title: `${m.code} — ${m.name}`,
      text: [m.name, m.help.summary, m.help.description, ...m.help.params.map((p) => p.text)].join(
        ' ',
      ),
    });
  }
  for (const def of fieldDefs) {
    docs.push({
      kind: 'field',
      id: def.id,
      title: `${def.id} — ${def.label}`,
      text: `${def.label} ${def.definition}`,
    });
  }
  for (const word of SHELL_WORDS) {
    docs.push({ kind: 'shell', id: word.word, title: word.word, text: word.text });
  }
  return docs;
}

/**
 * The 120-character window around the best match, with the matched span marked.
 *
 * `«…»` rather than HTML: the payload is data, and a screen that renders it is responsible for
 * the highlight. Marking it here is what lets the CSV export show *why* a row matched.
 */
function snippetOf(text: string, query: string): string {
  const haystack = text.replace(/\s+/g, ' ').trim();
  const at = haystack.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return haystack.slice(0, 120);
  const start = Math.max(0, at - 40);
  const end = Math.min(haystack.length, start + 120);
  const marked =
    haystack.slice(start, at) +
    '«' +
    haystack.slice(at, at + query.length) +
    '»' +
    haystack.slice(at + query.length, end);
  return (start > 0 ? '…' : '') + marked + (end < haystack.length ? '…' : '');
}

/**
 * Trigram similarity over the help corpus, using the *same* scorer `rank()` uses
 * (`core/command/index.ts#jaccard` over `trigramsOf`), so "searching help" and "completing a
 * command" agree about what resembles what.
 *
 * A substring hit scores above every trigram hit: a user who typed a word that literally appears
 * in a definition is not guessing.
 */
function searchHelp(docs: readonly HelpDoc[], query: string, limit: number): HelpSearchHit[] {
  const q = query.trim();
  if (q === '') return [];
  const needle = q.toLowerCase();
  const qGrams = trigramsOf(q);
  const hits: HelpSearchHit[] = [];
  for (const doc of docs) {
    const hay = `${doc.title} ${doc.text}`;
    const lower = hay.toLowerCase();
    let score = 0;
    if (doc.id.toLowerCase() === needle) score = 1;
    else if (lower.includes(needle)) score = 0.8;
    else if (qGrams.length > 0) {
      const similarity = jaccard(qGrams, trigramsOf(hay));
      if (similarity >= 0.15) score = similarity * 0.5;
    }
    if (score <= 0) continue;
    hits.push({ kind: doc.kind, id: doc.id, title: doc.title, snippet: snippetOf(hay, q), score });
  }
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits.slice(0, limit);
}

interface TopicRow extends Record<string, unknown> {
  code: string;
  name: string;
  keywords: string[] | null;
}

async function searchView(ctx: ResolveContext, params: HelpParams): Promise<HelpPayload> {
  const query = params.query ?? '';
  const docs = helpDocuments();

  // The one DB round-trip of §HELP step 3: the topic corpus.
  const topics = await ctx.db.execute<TopicRow>(sql`
    SELECT code, name, keywords FROM topics ORDER BY code`);
  for (const topic of topics.rows) {
    docs.push({
      kind: 'topic',
      id: topic.code,
      title: `${topic.code} — ${topic.name}`,
      text: `${topic.name} ${(topic.keywords ?? []).join(' ')}`,
    });
  }

  const hits = searchHelp(docs, query, 25);
  if (hits.length === 0) {
    ctx.unavailable.add({
      field: 'hits',
      reason: 'NO_SOURCE',
      detail: `no help text matches "${query}"`,
    });
  }
  return { variant: 'default', view: 'search', query, hits };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// view: 'tickets'
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface TicketSqlRow extends Record<string, unknown> {
  ticket_id: string;
  opened_at: string;
  function_code: string | null;
  question: string;
  status: HelpTicketRow['status'];
  room_id: string | null;
  answer: string | null;
  answered_at: string | null;
}

async function ticketsView(ctx: ResolveContext): Promise<HelpPayload> {
  const desk = DESK_ROLES.includes(ctx.user.role);
  // `help_tickets_scope` (migration 0015) restricts to the firm; the `own` scope adds the user.
  // Restated here because RLS is not applied to the role that owns the tables.
  const scope = desk
    ? sql`(user_id = ${String(ctx.user.userId)}::bigint OR firm_id = ${String(ctx.user.firmId)}::bigint)`
    : sql`user_id = ${String(ctx.user.userId)}::bigint`;
  const res = await ctx.db.execute<TicketSqlRow>(sql`
    SELECT ticket_id::text AS ticket_id,
           to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS opened_at,
           function_code, question, status, room_id::text AS room_id, answer,
           to_char(answered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS answered_at
      FROM help_tickets
     WHERE ${scope}
     ORDER BY opened_at DESC, ticket_id DESC
     LIMIT 200`);

  ctx.unavailable.add({
    field: 'tickets',
    reason: 'NOT_APPLICABLE',
    detail: NO_LIVE_ANALYST_DESK_DETAIL,
  });

  return {
    variant: 'default',
    view: 'tickets',
    tickets: res.rows.map((row) => ({
      ticketId: Number(row.ticket_id),
      openedAt: row.opened_at,
      functionCode: row.function_code,
      question: row.question,
      status: row.status,
      roomId: row.room_id === null ? null : Number(row.room_id),
      answer: row.answer,
      answeredAt: row.answered_at,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: HelpParams): Promise<HelpPayload> {
  switch (params.view) {
    case 'function':
      return functionView(ctx, params);
    case 'search':
      return searchView(ctx, params);
    case 'tickets':
      return ticketsView(ctx);
    case 'index':
      return Promise.resolve(indexView());
  }
}

const module_: FunctionServerModule<HelpParams, HelpPayload> = { resolve };

export default module_;
