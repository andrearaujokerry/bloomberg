/**
 * `wire/rest/alerts.ts` — `Rest.Alerts.*`: the 11 alert and saved-search routes.
 *
 * Schemas and routes transcribed from API.md §5.11 L732-756 (NEWS-07).
 * Owned by WP-01 now, by WP-09 (`server/src/http/routes/alerts.ts`) afterwards.
 *
 * Fired alerts stream on the WS `alerts:me` subject as `alert` messages (API.md §6.9).
 *
 * Route descriptor shape used by every `wire/rest/*` group (consumed by `client/rest.ts`):
 *   { method, path, params?, query?, body?, response, status, format? }
 */
import { z } from 'zod';

import { FieldId, SecurityRefInput } from '../common.js';
import { NewsQuery } from './news.js';

/* ------------------------------------------------------------------ schemas */

export const AlertDelivery = z.enum(['inapp', 'email', 'push']);
export type AlertDelivery = z.infer<typeof AlertDelivery>;

export const AlertStatus = z.enum(['armed', 'paused', 'fired', 'deleted']);
export type AlertStatus = z.infer<typeof AlertStatus>;

/** API.md §5.11 L735-740, verbatim. */
export const AlertCondition = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('price'),
    security: SecurityRefInput,
    field: FieldId.default('PX_LAST'),
    op: z.enum(['>=', '<=', 'crosses']),
    value: z.number(),
  }),
  z.object({
    kind: z.literal('news'),
    savedSearchId: z.number().int().optional(),
    query: NewsQuery.pick({ q: true, instrumentId: true, topic: true, feed: true }).optional(),
  }),
  z.object({
    kind: z.literal('filing'),
    ciks: z.array(z.string()).optional(),
    instrumentIds: z.array(z.number().int()).optional(),
    forms: z.array(z.string()).default(['8-K']),
    items: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('calendar'),
    releaseId: z.number().int(),
    minutesBefore: z.number().int().min(0).max(1440).default(15),
  }),
]);
export type AlertCondition = z.infer<typeof AlertCondition>;

export const Alert = z.object({
  alertId: z.number().int(),
  condition: AlertCondition,
  delivery: z.array(AlertDelivery),
  status: AlertStatus,
  oneShot: z.boolean(),
  createdAt: z.iso.datetime(),
  lastFiredAt: z.iso.datetime().nullable(),
});
export type Alert = z.infer<typeof Alert>;

export const AlertEvent = z.object({
  eventId: z.number().int(),
  alertId: z.number().int(),
  firedAt: z.iso.datetime(),
  payload: z.object({
    value: z.number().optional(),
    newsId: z.number().int().optional(),
    accessionNo: z.string().optional(),
    eventId: z.number().int().optional(),
    provenanceId: z.number().int().optional(),
    summary: z.string(),
  }),
  /** delivery channel → timestamp, or null when the intent was recorded but not delivered */
  delivered: z.record(z.string(), z.iso.datetime().nullable()),
  acknowledgedAt: z.iso.datetime().nullable(),
});
export type AlertEvent = z.infer<typeof AlertEvent>;

export const AlertListResponse = z.object({ items: z.array(Alert) });
export type AlertListResponse = z.infer<typeof AlertListResponse>;

export const CreateAlertRequest = z.object({
  condition: AlertCondition,
  delivery: z.array(AlertDelivery).default(['inapp']),
  oneShot: z.boolean().default(false),
});
export type CreateAlertRequest = z.infer<typeof CreateAlertRequest>;

export const UpdateAlertRequest = z.object({
  condition: AlertCondition.optional(),
  delivery: z.array(AlertDelivery).optional(),
  status: z.enum(['armed', 'paused']).optional(),
});
export type UpdateAlertRequest = z.infer<typeof UpdateAlertRequest>;

export const AlertParams = z.object({ alertId: z.number().int().positive() });
export type AlertParams = z.infer<typeof AlertParams>;

/** In-app delivery record; email/push are recorded intents in v1. */
export const AlertEventQuery = z.object({
  since: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type AlertEventQuery = z.infer<typeof AlertEventQuery>;

export const AlertEventListResponse = z.object({ items: z.array(AlertEvent) });
export type AlertEventListResponse = z.infer<typeof AlertEventListResponse>;

export const AlertEventParams = z.object({ eventId: z.number().int().positive() });
export type AlertEventParams = z.infer<typeof AlertEventParams>;

export const SavedSearchKind = z.enum(['news', 'eqs', 'srch']);
export type SavedSearchKind = z.infer<typeof SavedSearchKind>;

/**
 * `saved_searches` (DATA_MODEL §16). `query` is the news filter for `kind:'news'` and a
 * `ScreenCriteria` object (FUNCTIONS.md) for `eqs`/`srch`, so it stays an open record here.
 */
export const SavedSearch = z.object({
  searchId: z.number().int(),
  ownerUserId: z.number().int(),
  kind: SavedSearchKind,
  name: z.string(),
  query: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SavedSearch = z.infer<typeof SavedSearch>;

export const SavedSearchQuery = z.object({ kind: SavedSearchKind.optional() });
export type SavedSearchQuery = z.infer<typeof SavedSearchQuery>;

export const SavedSearchListResponse = z.object({ items: z.array(SavedSearch) });
export type SavedSearchListResponse = z.infer<typeof SavedSearchListResponse>;

export const CreateSavedSearchRequest = z.object({
  kind: SavedSearchKind,
  name: z.string().min(1).max(120),
  query: z.record(z.string(), z.unknown()),
});
export type CreateSavedSearchRequest = z.infer<typeof CreateSavedSearchRequest>;

export const SavedSearchParams = z.object({ searchId: z.number().int().positive() });
export type SavedSearchParams = z.infer<typeof SavedSearchParams>;

/* ------------------------------------------------------------------- routes */

/** The 11 routes of API.md §5.11 (`http/routes/alerts.ts`). */
export const Alerts = {
  List: {
    method: 'GET',
    path: '/alerts',
    response: AlertListResponse,
    status: 200,
  },
  Create: {
    method: 'POST',
    path: '/alerts',
    body: CreateAlertRequest,
    response: Alert,
    status: 201,
  },
  Get: {
    method: 'GET',
    path: '/alerts/:alertId',
    params: AlertParams,
    response: Alert,
    status: 200,
  },
  Update: {
    method: 'PUT',
    path: '/alerts/:alertId',
    params: AlertParams,
    body: UpdateAlertRequest,
    response: Alert,
    status: 200,
  },
  /** Soft delete: the row moves to `status='deleted'`. */
  Delete: {
    method: 'DELETE',
    path: '/alerts/:alertId',
    params: AlertParams,
    response: z.void(),
    status: 204,
  },
  /** In-app delivery record; email/push are recorded intents in v1. */
  Events: {
    method: 'GET',
    path: '/alerts/events',
    query: AlertEventQuery,
    response: AlertEventListResponse,
    status: 200,
  },
  Ack: {
    method: 'POST',
    path: '/alerts/events/:eventId/ack',
    params: AlertEventParams,
    response: z.void(),
    status: 204,
  },
  ListSavedSearches: {
    method: 'GET',
    path: '/saved-searches',
    query: SavedSearchQuery,
    response: SavedSearchListResponse,
    status: 200,
  },
  CreateSavedSearch: {
    method: 'POST',
    path: '/saved-searches',
    body: CreateSavedSearchRequest,
    response: SavedSearch,
    status: 201,
  },
  GetSavedSearch: {
    method: 'GET',
    path: '/saved-searches/:searchId',
    params: SavedSearchParams,
    response: SavedSearch,
    status: 200,
  },
  DeleteSavedSearch: {
    method: 'DELETE',
    path: '/saved-searches/:searchId',
    params: SavedSearchParams,
    response: z.void(),
    status: 204,
  },
} as const;
