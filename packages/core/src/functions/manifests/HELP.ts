// packages/core/src/functions/manifests/HELP.ts
//
// HELP — Help (FUNCTIONS_TIER1.md §HELP L2068-2197, FUNCTIONS.md §4 and §6 L1088).
//
// HELP is the terminal's own documentation, served from the same manifests the functions run on,
// so it cannot drift from behaviour: every string it shows is a field of some `FunctionManifest`
// or a row of `core/fields/dictionary.ts`, read at request time.
//
// `assetClasses: 'none'` — one variant, `'default'`. The `view` param selects the payload branch
// and the `assetClass` param selects which variant of the *documented* function is described
// (FUNC-02); neither makes HELP itself polymorphic, which is why `variants` is empty and every
// branch below sets `variant: 'default'`.
//
// There is no `ValueCell` anywhere in this payload: HELP carries no market data, only
// documentation and, in `fields[]`, the dictionary entry plus its `licence_registry.attribution`
// (DATA-09). The one entitlement interaction is a *labelling* one — each field row carries the
// decision a read of it would get, so a user reading HELP learns exactly why a cell on the
// previous screen was blank (ENTL-05, TERM-11).

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { ReasonCode } from '../../types/entitlement.js';
import {
  defineFunction,
  type CsvColumn,
  type CsvDocument,
  type HelpSpec,
  type KeyBinding,
  type Tier,
} from '../manifest.js';
import { AssetClass } from '../schemas.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§HELP L2080-2089)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const HelpView = z.enum(['function', 'search', 'index', 'tickets']);
export type HelpView = z.infer<typeof HelpView>;

export const HelpParams = z.object({
  code: z.string().max(6).optional(),
  query: z.string().max(200).optional(),
  assetClass: AssetClass.optional(),
  view: HelpView.default('index'),
});
export type HelpParams = z.infer<typeof HelpParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§HELP L2092-2098)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One row of `grid#fields`: the dictionary entry, its licence attribution and its decision. */
export interface HelpFieldRow {
  id: FieldId;
  label: string;
  definition: string;
  sourceId: string;
  attribution: string;
  /**
   * The verdict a *read* of this field would get for the caller, purely as a label — no value is
   * returned by HELP, so nothing is served under it (ENTL-05). Addition to §HELP's payload
   * listing, which describes this column only in the Screen section.
   */
  decision: 'allow' | 'downgrade' | 'deny';
  reason: ReasonCode;
}

export interface HelpFunctionBlock {
  code: string;
  name: string;
  tier: Tier;
  /** `manifest.variants[assetClass]`, or `null` when none was asked for or none applies. */
  variant: string | null;
  help: HelpSpec;
  params: { name: string; schema: unknown; default: unknown }[];
  /** `null` when the manifest computes its columns from the payload. */
  csvColumns: CsvColumn[] | null;
  fields: HelpFieldRow[];
  keys: KeyBinding[];
}

export interface HelpSearchHit {
  kind: 'function' | 'field' | 'topic' | 'shell';
  id: string;
  title: string;
  snippet: string;
  score: number;
}

export interface HelpIndexEntry {
  code: string;
  name: string;
  summary: string;
  aliases: string[];
}

export interface HelpTicketRow {
  ticketId: number;
  openedAt: string;
  functionCode: string | null;
  question: string;
  status: 'open' | 'answered' | 'closed';
  roomId: number | null;
  answer: string | null;
  answeredAt: string | null;
}

export type HelpPayload =
  | { variant: 'default'; view: 'function'; function: HelpFunctionBlock }
  | { variant: 'default'; view: 'search'; query: string; hits: HelpSearchHit[] }
  | {
      variant: 'default';
      view: 'index';
      tiers: { tier: Tier; functions: HelpIndexEntry[] }[];
      shell: { word: string; text: string }[];
      keys: { key: string; action: string }[];
    }
  | { variant: 'default'; view: 'tickets'; tickets: HelpTicketRow[] };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§HELP L2165-2171)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const helpCsvColumns: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'text', label: 'Text', type: 'string' },
];

export function helpCsvRows(payload: HelpPayload): CsvDocument['rows'] {
  const rows: CsvDocument['rows'] = [];
  switch (payload.view) {
    case 'function': {
      const f = payload.function;
      rows.push(['meta', 'code', f.code]);
      rows.push(['meta', 'name', f.name]);
      rows.push(['meta', 'tier', String(f.tier)]);
      rows.push(['meta', 'variant', f.variant ?? '']);
      rows.push(['summary', '', f.help.summary]);
      rows.push(['description', '', f.help.description]);
      for (const p of f.help.params) {
        rows.push(['param', p.name, p.text + (p.example === undefined ? '' : ` — e.g. ${p.example}`)]);
      }
      for (const k of f.keys) {
        rows.push(['key', k.key, `${k.when ?? 'always'}: ${k.description}`]);
      }
      for (const field of f.fields) {
        rows.push(['field', field.id, `${field.label} — ${field.definition} [${field.sourceId}]`]);
      }
      for (const code of f.help.related) rows.push(['related', code, '']);
      for (const column of f.csvColumns ?? []) rows.push(['csvColumn', column.id, column.label]);
      return rows;
    }
    case 'index': {
      for (const tier of payload.tiers) {
        for (const fn of tier.functions) {
          rows.push([`tier${String(tier.tier)}`, fn.code, `${fn.name} — ${fn.summary}`]);
        }
      }
      for (const word of payload.shell) rows.push(['shell', word.word, word.text]);
      for (const key of payload.keys) rows.push(['key', key.key, key.action]);
      return rows;
    }
    case 'search': {
      rows.push(['query', '', payload.query]);
      for (const hit of payload.hits) {
        rows.push(['hit', hit.id, `${hit.kind}: ${hit.title} — ${hit.snippet}`]);
      }
      return rows;
    }
    case 'tickets': {
      for (const t of payload.tickets) {
        rows.push([
          'ticket',
          String(t.ticketId),
          `${t.openedAt} | ${t.functionCode ?? ''} | ${t.status} | ${t.question}`,
        ]);
        if (t.answer !== null) rows.push(['ticket-answer', String(t.ticketId), t.answer]);
      }
      return rows;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Keyboard (§HELP L2148-2163)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const HELP_KEYMAP: readonly KeyBinding[] = [
  { key: 'F1', action: 'open-ticket', when: 'always', description: 'Open an analyst ticket' },
  { key: 'Escape', action: 'close-overlay', when: 'always', description: 'Close the overlay' },
  { key: 'Enter', action: 'open-hit', when: 'grid', description: 'Open the focused hit' },
  { key: '1', action: 'tier-tab', when: 'always', description: 'Tier 1 tab' },
  { key: '2', action: 'tier-tab', when: 'always', description: 'Tier 2 tab' },
  { key: '3', action: 'tier-tab', when: 'always', description: 'Tier 3 tab' },
  { key: 'I', action: 'go-index', when: 'always', description: 'The function index' },
  { key: 'T', action: 'go-tickets', when: 'always', description: 'Your tickets' },
  { key: '/', action: 'go-search', when: 'always', description: 'Search the documentation' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const HELP = defineFunction<typeof HelpParams, HelpPayload>({
  code: 'HELP',
  name: 'Help',
  aliases: [],
  tier: 1,
  category: 'system',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: HelpParams,
  paramGrammar: {
    positional: [{ name: 'code', type: 'string', optional: true }],
    rest: { name: 'query', type: 'text' },
  },
  // HELP requests no market-data field, so the runner's entitlement pre-check is empty; the
  // `fields[]` block runs a *secondary* `ctx.entitle(screenFieldIds, 'display')` purely to label
  // each row with its decision (§HELP L2109).
  fieldIds: (): FieldId[] => [],
  pageable: false,
  live: null,
  csv: {
    filename: (params, ctx): string => {
      const what = params.view === 'function' ? (params.code ?? 'function') : params.view;
      return `HELP_${what}_${ctx.asOf.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.csv`;
    },
    columns: helpCsvColumns,
    rows: (payload): CsvDocument['rows'] => helpCsvRows(payload),
  },
  help: {
    summary: 'Explain this screen; press F1 twice to open an analyst ticket',
    description:
      'HELP is the terminal\'s own documentation, served from the same manifests the functions ' +
      'run on, so it cannot drift from behaviour. One press of F1 explains the function in the ' +
      'focused panel: what it does, every parameter with its current value and an example ' +
      'command line, every key it binds, and every field on the screen with its dictionary ' +
      'definition, its source, that source\'s licence attribution and whether you are entitled ' +
      'to it. A second press of F1 within ten seconds opens a ticket: the function, the ' +
      'security, the parameters, the visible fields with their provenance indexes and the trace ' +
      'id are attached automatically, a helpdesk room is created and the conversation continues ' +
      'in MSG. There is no 24-hour staffed desk in this build — the ticket is a durable record ' +
      "answered by the firm's helpdesk users, and HELP TICKETS lists yours with their answers. " +
      'HELP with no function loaded lists every function by tier with the shell words and ' +
      'reserved keys; HELP followed by words searches the documentation and the field dictionary.',
    params: [
      { name: 'code', text: 'a function code, or TICKETS', example: 'HELP GP' },
      {
        name: 'query',
        text: 'words to search help and field definitions',
        example: 'HELP dividend adjustment',
      },
      {
        name: 'assetClass',
        text: 'describe the variant for this asset class',
        example: 'HELP GP on an index panel',
      },
      { name: 'view', text: 'function, search, index or tickets', example: 'HELP TICKETS' },
    ],
    keys: HELP_KEYMAP.map((k) => ({ key: k.key, action: k.description })),
    sources: ['internal.derived'],
    related: ['MSG', 'SECF', 'TOP', 'DES'],
  },
  keymap: HELP_KEYMAP,
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default HELP;
