// packages/web/src/screens/HELP/Screen.tsx — Help (FUNCTIONS_TIER1 §HELP "Screen").
//
// One `Screen` for both mounts: the full screen a `HELP …` command opens and the `F1` overlay,
// which is the same spec rendered into a third of the focused panel.
//
// Entitlement is deliberately NOT applied to the help text — documentation is not licensed data.
// The `grid#fields` `entitlement` column instead prints each field's decision, so a reader learns
// exactly why a cell on the previous screen was blank (ENTL-05, TERM-11).

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type { FormField, FunctionScreen, GridRow, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import { countCell, footer, textCell, unavailableBadges } from '../shared/quoteHeader.js';

type Params = ParamsOf<'HELP'>;
type Payload = PayloadOf<'HELP'>;
type FunctionView = Extract<Payload, { view: 'function' }>;
type IndexView = Extract<Payload, { view: 'index' }>;
type SearchView = Extract<Payload, { view: 'search' }>;
type TicketsView = Extract<Payload, { view: 'tickets' }>;

/** `delayed ✓` · `eod (TIER_EOD)` · `blocked (NO_FIRM_ENTITLEMENT)` — what the reader needs. */
export function decisionText(row: FunctionView['function']['fields'][number]): string {
  switch (row.decision) {
    case 'allow':
      return 'allowed ✓';
    case 'downgrade':
      return `downgraded (${row.reason})`;
    case 'deny':
      return `blocked (${row.reason})`;
  }
}

function functionBody(p: FunctionView, params: Params): Node[] {
  const f = p.function;
  const fieldRows: GridRow[] = f.fields.map((row) => ({
    id: `field:${row.id}`,
    cells: {
      field: textCell(row.id),
      label: textCell(row.label),
      definition: textCell(row.definition),
      source: textCell(row.sourceId),
      attribution: textCell(row.attribution),
      entitlement: textCell(decisionText(row)),
    },
    tone: row.decision === 'deny' ? ('muted' as const) : ('normal' as const),
  }));

  return [
    { kind: 'text', id: 'summary', text: f.help.summary },
    { kind: 'text', id: 'description', text: f.help.description },
    {
      kind: 'table',
      id: 'params',
      caption: 'Parameters',
      columns: [
        { id: 'param', label: 'Param', type: 'string' },
        { id: 'what', label: 'What it does', type: 'string' },
        { id: 'example', label: 'Example', type: 'string' },
        { id: 'current', label: 'Current value', type: 'string' },
      ],
      rows: f.help.params.map((hp) => {
        const current = f.params.find((entry) => entry.name === hp.name);
        return [
          textCell(hp.name),
          textCell(hp.text),
          textCell(hp.example ?? null),
          textCell(current === undefined ? null : JSON.stringify(current.default)),
        ];
      }),
    },
    {
      kind: 'table',
      id: 'keys',
      caption: 'Keys',
      columns: [
        { id: 'key', label: 'Key', type: 'string' },
        { id: 'when', label: 'When', type: 'string' },
        { id: 'action', label: 'Action', type: 'string' },
      ],
      rows: f.keys.map((k) => [textCell(k.key), textCell(k.when ?? 'always'), textCell(k.description)]),
    },
    {
      kind: 'grid',
      id: 'fields',
      columns: [
        { id: 'field', label: 'Field', align: 'left', sortable: true },
        { id: 'label', label: 'Label', align: 'left' },
        { id: 'definition', label: 'Definition', align: 'left' },
        { id: 'source', label: 'Source', align: 'left' },
        { id: 'attribution', label: 'Attribution', align: 'left' },
        { id: 'entitlement', label: 'Entitlement', align: 'left' },
      ],
      rows: fieldRows,
      selectable: true,
      emptyText: 'This function cites no dictionary field.',
    },
    {
      kind: 'list',
      id: 'related',
      items: f.help.related.map((code) => ({
        id: `related:${code}`,
        primary: code,
        command: code,
      })),
    },
    {
      kind: 'text',
      id: 'csv',
      tone: 'muted',
      text:
        f.csvColumns === null
          ? 'PRINT is not offered for this function.'
          : `PRINT columns: ${f.csvColumns.map((c) => c.id).join(',')}`,
    },
    {
      kind: 'badges',
      id: 'notes',
      items: [
        {
          text: f.variant === null ? 'no asset-class variant' : `variant ${f.variant}`,
          tone: 'info',
        },
        ...(params.assetClass === undefined
          ? []
          : [{ text: `asset class ${params.assetClass}`, tone: 'info' as const }]),
        { text: 'F1 again opens a ticket', tone: 'info' },
      ],
    },
  ];
}

function indexBody(p: IndexView): Node[] {
  return [
    {
      kind: 'tabs',
      id: 'tiers',
      active: `tier${String(p.tiers[0]?.tier ?? 1)}`,
      tabs: p.tiers.map((t) => ({
        id: `tier${String(t.tier)}`,
        label: `Tier ${String(t.tier)}`,
        key: String(t.tier),
        body: {
          kind: 'grid',
          id: `tier${String(t.tier)}`,
          columns: [
            { id: 'code', label: 'Code', align: 'left', sortable: true },
            { id: 'aliases', label: 'Aliases', align: 'left' },
            { id: 'name', label: 'Name', align: 'left', sortable: true },
            { id: 'summary', label: 'Summary', align: 'left' },
          ],
          rows: t.functions.map((fn) => ({
            id: `fn:${fn.code}`,
            cells: {
              code: textCell(fn.code),
              aliases: textCell(fn.aliases.join(', ')),
              name: textCell(fn.name),
              summary: textCell(fn.summary),
            },
            command: `HELP ${fn.code}`,
          })),
          selectable: true,
          emptyText: 'No functions in this tier.',
        },
      })),
    },
    {
      kind: 'table',
      id: 'shell',
      caption: 'Shell words',
      columns: [
        { id: 'word', label: 'Word', type: 'string' },
        { id: 'text', label: 'What it does', type: 'string' },
      ],
      rows: p.shell.map((w) => [textCell(w.word), textCell(w.text)]),
    },
    {
      kind: 'table',
      id: 'keys',
      caption: 'Reserved keys',
      columns: [
        { id: 'key', label: 'Key', type: 'string' },
        { id: 'action', label: 'Action', type: 'string' },
      ],
      rows: p.keys.map((k) => [textCell(k.key), textCell(k.action)]),
    },
  ];
}

function searchBody(
  p: SearchView,
  onSubmit: (values: Record<string, unknown>) => void,
): Node[] {
  const fields: FormField[] = [{ id: 'query', label: 'Search', type: 'text', value: p.query }];
  return [
    { kind: 'form', id: 'q', fields, submitLabel: 'Search', onSubmit },
    {
      kind: 'list',
      id: 'hits',
      items: p.hits.map((h) => ({
        id: `hit:${h.kind}:${h.id}`,
        primary: h.title,
        secondary: h.snippet,
        badges: [{ text: h.kind, tone: 'info' as const, title: `score ${h.score.toFixed(3)}` }],
        ...(h.kind === 'function' ? { command: `HELP ${h.id}` } : {}),
      })),
    },
  ];
}

function ticketsBody(p: TicketsView): Node[] {
  return [
    {
      kind: 'grid',
      id: 'tickets',
      columns: [
        { id: 'ticketId', label: 'Ticket', fmt: 'int', align: 'right' },
        { id: 'openedAt', label: 'Opened', fmt: 'datetime', align: 'left', sortable: true },
        { id: 'functionCode', label: 'Function', align: 'left' },
        { id: 'question', label: 'Question', align: 'left' },
        { id: 'status', label: 'Status', align: 'left' },
        { id: 'answeredAt', label: 'Answered', fmt: 'datetime', align: 'left' },
      ],
      rows: p.tickets.map((t) => ({
        id: `ticket:${String(t.ticketId)}`,
        cells: {
          ticketId: countCell(t.ticketId),
          openedAt: textCell(t.openedAt, { fmt: 'datetime' }),
          functionCode: textCell(t.functionCode),
          question: textCell(t.question.length > 80 ? `${t.question.slice(0, 77)}…` : t.question),
          status: textCell(t.status),
          answeredAt: textCell(t.answeredAt, { fmt: 'datetime' }),
        },
        ...(t.roomId === null ? {} : { command: `MSG ROOM=${String(t.roomId)}` }),
      })),
      selectable: true,
      emptyText: 'No tickets — press F1 twice on any screen to open one',
    },
  ];
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta, ctx }) => {
  const submit = (values: Record<string, unknown>): void => {
    const query = values.query;
    ctx.setParams({ view: 'search', ...(typeof query === 'string' ? { query } : {}) });
  };

  if (payload === undefined) {
    return {
      title: 'HELP',
      subtitle: 'loading…',
      body: {
        kind: 'tabs',
        id: 'tiers',
        active: 'tier1',
        tabs: [1, 2, 3].map((tier) => ({
          id: `tier${String(tier)}`,
          label: `Tier ${String(tier)}`,
          key: String(tier),
          body: {
            kind: 'grid',
            id: `tier${String(tier)}`,
            columns: [{ id: 'code', label: 'Code', align: 'left' }],
            rows: Array.from({ length: tier === 3 ? 10 : 14 }, (_v, i) => ({
              id: `skeleton:${String(tier)}:${String(i)}`,
              cells: { code: textCell(null) },
              tone: 'muted' as const,
            })),
            emptyText: 'loading…',
          },
        })),
      },
      footer: footer(undefined),
      initialFocus: 'tiers',
    } satisfies ScreenSpec;
  }

  switch (payload.view) {
    case 'function': {
      const notes = unavailableBadges(meta);
      const body = functionBody(payload, params);
      return {
        title: `HELP · ${payload.function.code} · ${payload.function.name}`,
        subtitle: `tier ${String(payload.function.tier)} · ${payload.function.variant ?? 'no asset-class variant'} · trace ${meta?.traceId ?? '—'}`,
        body: stack('col', body),
        footer: footer(meta, notes.map((n) => `${n.text} — ${n.title ?? ''}`)),
        initialFocus: 'params',
      } satisfies ScreenSpec;
    }
    case 'index':
      return {
        title: 'HELP · Function index',
        subtitle: `${String(payload.tiers.reduce((n, t) => n + t.functions.length, 0))} functions`,
        body: stack('col', indexBody(payload)),
        footer: footer(meta),
        initialFocus: 'tiers',
      } satisfies ScreenSpec;
    case 'search':
      return {
        title: `HELP · Search · ${payload.query}`,
        subtitle: `${String(payload.hits.length)} hits`,
        body: stack('col', searchBody(payload, submit), [0.15, 0.85]),
        footer: footer(meta),
        initialFocus: 'hits',
      } satisfies ScreenSpec;
    case 'tickets':
      return {
        title: 'HELP · Tickets',
        subtitle: `${String(payload.tickets.length)} tickets`,
        body: stack('col', ticketsBody(payload)),
        footer: footer(meta),
        initialFocus: 'tickets',
      } satisfies ScreenSpec;
  }
};

export default Screen;
