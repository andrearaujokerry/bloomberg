/**
 * `wire/rest/workspaces.ts` — `Rest.Workspaces.*`: workspace persistence and chart annotations
 * (TERM-04, TERM-05, TERM-10, CHRT-05).
 *
 * Schemas transcribed from API.md §5.7 L599-630, routes from L632-641. The two multi-method
 * rows (`GET / PUT / DELETE /workspaces/:workspaceId` and
 * `POST / PUT / DELETE /annotations[, /annotations/:annotationId]`) are expanded into one
 * descriptor per method.
 * Owned by WP-01 now, by WP-08 (`server/src/http/routes/workspaces.ts`) afterwards.
 *
 * Routes covered (12):
 *   GET    /workspace                        PUT    /workspace
 *   GET    /workspaces                       POST   /workspaces
 *   GET    /workspaces/:workspaceId          PUT    /workspaces/:workspaceId
 *   DELETE /workspaces/:workspaceId          POST   /workspaces/:workspaceId/activate
 *   GET    /annotations                      POST   /annotations
 *   PUT    /annotations/:annotationId        DELETE /annotations/:annotationId
 *
 * Route descriptor shape: { method, path, params?, query?, body?, response, status, format? }.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ schemas */

export const Frame = z.object({
  /** resolved instrument (never a bare ticker, REF-01) */
  security: z.object({ id: z.number().int(), display: z.string() }).nullable(),
  /** function code */
  fn: z.string().nullable(),
  params: z.record(z.string(), z.unknown()).default({}),
  /** last result (stale-while-revalidate hint; may be expired) */
  resultId: z.string().nullable().default(null),
  scroll: z.number().int().default(0),
});
export type Frame = z.infer<typeof Frame>;

export const PanelState = z.object({
  id: z.string().regex(/^p[1-8]$/),
  /** back-stack + position (PAGE BACK/FWD) */
  frameStack: z.array(Frame).max(50),
  index: z.number().int().min(0),
  /** command-line history */
  history: z.array(z.string()).max(100),
  commandDraft: z.string().max(200).default(''),
});
export type PanelState = z.infer<typeof PanelState>;

export const MonitorSpec = z.object({
  id: z.string(),
  title: z.string(),
  watchlistId: z.number().int().nullable(),
  columns: z.array(z.string()),
  sort: z.object({ col: z.string(), dir: z.enum(['asc', 'desc']) }).nullable(),
  groupBy: z.string().nullable(),
});
export type MonitorSpec = z.infer<typeof MonitorSpec>;

export const WorkspaceLayout = z.object({
  /** layout schema version (migrated client-side on load) */
  schema: z.literal(1),
  mode: z.enum(['1', '2h', '2v', '4']),
  panels: z.array(PanelState).min(1).max(8),
  /** panel id */
  focus: z.string(),
  monitors: z.array(MonitorSpec).default([]),
  chart: z
    .object({
      defaultRange: z.string().default('1Y'),
      defaultType: z.string().default('line'),
      studies: z.array(z.string()).default([]),
    })
    // API.md writes `.default({})`; in zod 4 a `default` must be the parsed (output) value,
    // so `prefault` is the faithful spelling: `{}` is fed through the schema and the three
    // inner defaults fill it in.
    .prefault({}),
  conflationMs: z.number().int().min(50).max(5000).default(250),
  /** TERM-10 shape */
  windows: z
    .array(
      z.object({
        windowId: z.string(),
        screen: z.string(),
        bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        panelIds: z.array(z.string()),
      }),
    )
    .default([]),
});
export type WorkspaceLayout = z.infer<typeof WorkspaceLayout>;

export const Workspace = z.object({
  workspaceId: z.number().int(),
  name: z.string(),
  isActive: z.boolean(),
  version: z.number().int(),
  layout: WorkspaceLayout,
  updatedAt: z.iso.datetime(),
});
export type Workspace = z.infer<typeof Workspace>;

/** `GET /workspaces` omits the layouts. */
export const WorkspaceSummary = Workspace.omit({ layout: true });
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const ChartAnnotation = z.object({
  annotationId: z.number().int(),
  instrumentId: z.number().int(),
  ownerUserId: z.number().int(),
  kind: z.enum(['trendline', 'hline', 'vline', 'fib', 'text', 'regression_channel', 'rect']),
  anchors: z.array(z.object({ t: z.number(), v: z.number() })),
  style: z.record(z.string(), z.unknown()),
  label: z.string().nullable(),
  sharedScope: z.enum(['private', 'firm', 'users']),
  sharedUserIds: z.array(z.number().int()),
  updatedAt: z.iso.datetime(),
});
export type ChartAnnotation = z.infer<typeof ChartAnnotation>;

/** `ChartAnnotation` minus the ids the server owns (API.md §5.7 L641). */
export const ChartAnnotationInput = ChartAnnotation.omit({
  annotationId: true,
  ownerUserId: true,
  updatedAt: true,
});
export type ChartAnnotationInput = z.infer<typeof ChartAnnotationInput>;

/** Autosave body; `409 WORKSPACE_VERSION_CONFLICT` carries `details.current` (the server copy). */
export const PutWorkspaceRequest = z.object({
  version: z.number().int(),
  layout: WorkspaceLayout,
});
export type PutWorkspaceRequest = z.infer<typeof PutWorkspaceRequest>;

export const PutWorkspaceResponse = z.object({
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type PutWorkspaceResponse = z.infer<typeof PutWorkspaceResponse>;

/** `409 DUPLICATE_NAME` when the name is taken. */
export const CreateWorkspaceRequest = z.object({
  name: z.string().min(1).max(80),
  layout: WorkspaceLayout,
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

export const UpdateWorkspaceRequest = z.object({
  version: z.number().int(),
  name: z.string().min(1).max(80).optional(),
  layout: WorkspaceLayout.optional(),
});
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequest>;

export const WorkspaceListResponse = z.object({ items: z.array(WorkspaceSummary) });
export const AnnotationListResponse = z.object({ items: z.array(ChartAnnotation) });

const WorkspaceIdParam = z.object({ workspaceId: z.coerce.number().int() });
const AnnotationIdParam = z.object({ annotationId: z.coerce.number().int() });

/* ------------------------------------------------------------------- routes */

/** The 12 routes of API.md §5.7 (`http/routes/workspaces.ts`). */
export const Workspaces = {
  /** The active workspace (created from `fixtures/seed/workspaces.json` on first login). */
  GetActive: {
    method: 'GET',
    path: '/workspace',
    response: Workspace,
    status: 200,
  },
  /** Autosave, debounced 2 s; `409 WORKSPACE_VERSION_CONFLICT` → client merges and retries. */
  PutActive: {
    method: 'PUT',
    path: '/workspace',
    body: PutWorkspaceRequest,
    response: PutWorkspaceResponse,
    status: 200,
  },
  /** Layouts omitted. */
  List: {
    method: 'GET',
    path: '/workspaces',
    response: WorkspaceListResponse,
    status: 200,
  },
  Create: {
    method: 'POST',
    path: '/workspaces',
    body: CreateWorkspaceRequest,
    response: Workspace,
    status: 201,
  },
  Get: {
    method: 'GET',
    path: '/workspaces/:workspaceId',
    params: WorkspaceIdParam,
    response: Workspace,
    status: 200,
  },
  Update: {
    method: 'PUT',
    path: '/workspaces/:workspaceId',
    params: WorkspaceIdParam,
    body: UpdateWorkspaceRequest,
    response: Workspace,
    status: 200,
  },
  Delete: {
    method: 'DELETE',
    path: '/workspaces/:workspaceId',
    params: WorkspaceIdParam,
    response: z.void(),
    status: 204,
  },
  /** Flips `is_active`. */
  Activate: {
    method: 'POST',
    path: '/workspaces/:workspaceId/activate',
    params: WorkspaceIdParam,
    response: Workspace,
    status: 200,
  },
  /** Own + shared-with-me + firm annotations for one instrument (CHRT-05). */
  Annotations: {
    method: 'GET',
    path: '/annotations',
    query: z.object({ instrumentId: z.coerce.number().int() }),
    response: AnnotationListResponse,
    status: 200,
  },
  CreateAnnotation: {
    method: 'POST',
    path: '/annotations',
    body: ChartAnnotationInput,
    response: ChartAnnotation,
    status: 201,
  },
  UpdateAnnotation: {
    method: 'PUT',
    path: '/annotations/:annotationId',
    params: AnnotationIdParam,
    body: ChartAnnotationInput,
    response: ChartAnnotation,
    status: 200,
  },
  DeleteAnnotation: {
    method: 'DELETE',
    path: '/annotations/:annotationId',
    params: AnnotationIdParam,
    response: z.void(),
    status: 204,
  },
} as const;
