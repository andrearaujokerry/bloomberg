// packages/web/src/screens/W/Screen.tsx — Watchlists (FUNCTIONS_TIER1 §W "Screen").
//
// The list of lists on the left, the active list as a live monitor on the right, and two editor
// views (`manage`, `share`) that swap the grid for a form.
//
// The grid builders come from `QM/Screen.tsx`: W's rows are `MonitorRow`s with three extra keys, so
// a second copy of the column mapping would be a second place for a monitor to drift.
//
// A form's `onSubmit` sets the params the screen owns and returns to the grid. It does not write:
// the mutations (`rename`, `share`, `add-column`, `add-row`) are shell actions bound to the
// manifest keymap, because a screen is a pure function and does no IO.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type {
  Badge,
  FormField,
  FunctionScreen,
  GridRow,
  Node,
  ScreenSpec,
} from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import { monitorColumns, monitorRows } from '../QM/Screen.js';
import {
  entitlementBadges,
  footer,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'W'>;
type Payload = PayloadOf<'W'>;

/** `list#lists` — one item per watchlist, the active one highlighted by its badge. */
function listsNode(p: Payload): Node {
  return {
    kind: 'list',
    id: 'lists',
    items: p.watchlists.map((w) => ({
      id: `wl:${String(w.watchlistId)}`,
      primary: w.name,
      secondary: `${String(w.itemCount)} items · ${w.ownerDisplay}`,
      ts: w.updatedAt,
      badges: [
        { text: w.sharedScope, tone: w.sharedScope === 'private' ? ('info' as const) : ('ok' as const) },
        ...(w.isOwner ? [] : [{ text: 'shared with you', tone: 'stale' as const, title: 'read only' }]),
        ...(p.active !== null && p.active.watchlistId === w.watchlistId
          ? [{ text: 'active', tone: 'ok' as const }]
          : []),
      ],
      command: `W ${w.name}`,
    })),
  };
}

/** `grid#rows` — the active list. A formula row shows its formula as the key with a `ƒ` badge. */
function rowsNode(p: Payload): Node {
  const active = p.active;
  if (active === null) {
    return {
      kind: 'text',
      id: 'rows',
      text: 'No watchlist selected — pick one on the left, or press Ctrl+N to create one.',
      tone: 'muted',
    };
  }
  const rows = monitorRows(active.rows, active.columns, active.groupBy ?? 'none').map(
    (row, i): GridRow => {
      const source = active.rows[i];
      if (source === undefined) return row;
      if (source.formula === null) return row;
      return {
        ...row,
        cells: { ...row.cells, key: textCell(source.formula), name: textCell(source.label ?? 'ƒ') },
        tone: 'highlight',
      };
    },
  );
  return {
    kind: 'grid',
    id: 'rows',
    frozenColumns: 2,
    columns: monitorColumns(active.columns),
    rows,
    selectable: true,
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    emptyText: 'Empty list — Insert adds a security',
    ...(active.sort[0] === undefined ? {} : { sort: active.sort[0] }),
    ...(active.groupBy === null ? {} : { groupBy: active.groupBy }),
  };
}

function manageForm(p: Payload, onSubmit: (values: Record<string, unknown>) => void): Node {
  const active = p.active;
  const fields: FormField[] = [
    { id: 'name', label: 'Name', type: 'text', value: active?.name ?? '' },
    {
      id: 'groupBy',
      label: 'Group by',
      type: 'text',
      value: active?.groupBy ?? '',
    },
    {
      id: 'sort',
      label: 'Sort',
      type: 'text',
      value: active?.sort.map((s) => `${s.col} ${s.dir}`).join(', ') ?? '',
    },
    ...(active?.columns ?? []).map(
      (c, i): FormField => ({
        id: `column:${String(i)}`,
        label: c.label,
        type: c.formula === undefined ? 'field' : 'text',
        value: c.formula ?? c.fieldId ?? c.id,
        readonly: active?.isOwner !== true,
      }),
    ),
  ];
  return { kind: 'form', id: 'manage', fields, submitLabel: 'Save', onSubmit };
}

function shareForm(p: Payload, onSubmit: (values: Record<string, unknown>) => void): Node {
  const active = p.active;
  const fields: FormField[] = [
    {
      id: 'sharedScope',
      label: 'Scope',
      type: 'enum',
      value: active?.sharedScope ?? 'private',
      values: ['private', 'firm', 'users'] as const,
      readonly: active?.isOwner !== true,
    },
    {
      id: 'sharedUserIds',
      label: 'Users (same firm only — SEC-05)',
      type: 'text',
      value: active?.sharedUserIds.join(', ') ?? '',
      readonly: active?.isOwner !== true,
    },
  ];
  return { kind: 'form', id: 'share', fields, submitLabel: 'Share', onSubmit };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta, ctx }) => {
  const submit = (values: Record<string, unknown>): void => {
    const patch: Partial<Params> = { view: 'grid' };
    const name = values.name;
    if (typeof name === 'string' && name.length > 0) patch.watchlist = { name };
    ctx.setParams(patch);
  };

  if (payload === undefined) {
    return {
      title: 'W · Watchlists',
      subtitle: 'loading…',
      body: stack(
        'row',
        [
          { kind: 'list', id: 'lists', items: [] },
          {
            kind: 'grid',
            id: 'rows',
            columns: [{ id: 'key', label: 'Security', align: 'left' }],
            rows: Array.from({ length: 8 }, (_v, i) => ({
              id: `skeleton:${String(i)}`,
              cells: { key: textCell(null) },
              tone: 'muted' as const,
            })),
            emptyText: 'loading…',
          },
        ],
        [0.22, 0.78],
      ),
      footer: footer(undefined),
      initialFocus: 'lists',
    } satisfies ScreenSpec;
  }

  const active = payload.active;
  const right: Node =
    params.view === 'manage'
      ? manageForm(payload, submit)
      : params.view === 'share'
        ? shareForm(payload, submit)
        : rowsNode(payload);

  const chips: Badge[] = [
    ...(active?.formulaErrors ?? []).map((e) => ({
      text: `${e.where}: ${e.message}`,
      tone: 'warn' as const,
      title: 'CHRT-07 formula error',
    })),
    ...entitlementBadges(meta),
    ...unavailableBadges(meta),
    ...stalenessBadges(meta),
  ];

  const left = listsNode(payload);
  const split = stack('row', [left, right], [0.22, 0.78]);
  const body: Node =
    chips.length === 0
      ? split
      : stack('col', [{ kind: 'badges', id: 'errors', items: chips }, split], [0.06, 0.94]);

  const focusId = params.view === 'manage' ? 'manage' : params.view === 'share' ? 'share' : active === null ? 'lists' : 'rows';

  return {
    title: active === null ? 'W · Watchlists' : `W · ${active.name}`,
    subtitle:
      active === null
        ? `${String(payload.watchlists.length)} lists`
        : `${String(active.rows.length)} rows · ${active.sharedScope} · owner ${payload.watchlists.find((w) => w.watchlistId === active.watchlistId)?.ownerDisplay ?? '—'} · updated ${active.updatedAt}`,
    body,
    footer: footer(meta),
    initialFocus: focusId,
    // Dynamic addition: `Escape` only means "leave the editor" while an editor is on screen.
    ...(params.view === 'grid'
      ? {}
      : {
          keymap: [
            {
              key: 'Escape',
              action: 'close-editor',
              when: 'form' as const,
              description: 'Leave the editor without saving',
            },
          ],
        }),
  } satisfies ScreenSpec;
};

export default Screen;
