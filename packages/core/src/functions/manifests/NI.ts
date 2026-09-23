// packages/core/src/functions/manifests/NI.ts
//
// `NI` — News by Topic (FUNCTIONS_TIER1.md §NI L1370-1512, FUNCTIONS.md §6 L1085).
//
// NI is the topic browser: every topic the platform links headlines to, how many arrived in the
// last 24 hours and 7 days, and the headline list for the selected topic.
//
// The payload's unusual member is `NiTopicNode.reason`. A topic reaches headlines two ways — a
// feed mapping (every item from a publisher feed belongs to the topic) or a narrow keyword match
// on the headline — and two of the seeded topics have neither in v1. Those nodes are **listed,
// greyed, with the reason**, and their counts are `0`/`null` rather than absent: a topic that
// silently showed no stories is indistinguishable from a quiet day, and NEWS-02's precision-first
// linking means "no source" is a design decision the screen has to be able to state.

import { z } from 'zod';

import type { NewsRow } from '../shared/news.js';
import { newsCsvColumns, newsCsvRow } from '../shared/news.js';
import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import type { FieldId } from '../../types/fields.js';
import type { TopFeedHealth } from './TOP.js';
import { topAsOfCompact } from './TOP.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§NI "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const NI_KINDS = ['story', 'video', 'filing', 'press_release', 'fed_release'] as const;

export const NiParams = z.object({
  /** `topics.code`, case-insensitive on input; absent → the browser with no selection. */
  topic: z.string().max(32).optional(),
  limit: z.number().int().min(10).max(100).default(40),
  kinds: z.array(z.enum(NI_KINDS)).default([]),
  /** Roll child topics (`topics.parent_topic_id`) into the headline list. */
  includeChildren: z.boolean().default(true),
});
export type NiParams = z.infer<typeof NiParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§NI "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type NiTopicKind = 'feed' | 'sector' | 'theme' | 'region' | 'event' | 'release';

/** How headlines reach a topic; `[]` means no source (see `reason`). */
export type NiLinkMethod = 'feed_topic' | 'keyword' | 'manual';

/** One node of the topic browser; `count24h` is the headline count in the last 24 h at `asOf`. */
export interface NiTopicNode {
  topicId: number;
  code: string;
  name: string;
  kind: NiTopicKind;
  parentCode: string | null;
  childCodes: string[];
  linkMethods: NiLinkMethod[];
  count24h: number;
  count7d: number;
  lastPublishedAt: string | null;
  /** Set when `linkMethods` is empty — the node is listed and greyed, never hidden. */
  reason: 'TOPIC_NO_SOURCE' | null;
}

export interface NiPayload {
  variant: 'default';
  /** The whole tree, parents before children, alphabetical within a level. */
  topics: NiTopicNode[];
  /** `null` → browser only, and `rows` is `[]`. */
  selected: NiTopicNode | null;
  /** `selected.code` plus its descendants when `includeChildren`. */
  rolledCodes: string[];
  rows: NewsRow[];
  /** `'n:topic:<code>'` when a topic is selected, else `null`. */
  liveSubject: string | null;
  feedHealth: TopFeedHealth[];
  suppressed: { entitlement: number; kindFilter: number };
  asOf: string;
}

/** §NI step 5: `topics.parent_topic_id` is walked to this depth and no further. */
export const NI_MAX_DEPTH = 3;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§NI "CSV") — long format, `section` first
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Static and payload-independent: the union of both blocks' columns, with the block that does not
 * own a column left empty (§1.6 rule 3). A `topic` row fills the nine topic columns; a `news` row
 * fills `newsCsvColumns`.
 */
export const niCsvColumns: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'code', label: 'Code', type: 'string' },
  { id: 'name', label: 'Name', type: 'string' },
  { id: 'topicKind', label: 'Topic kind', type: 'string' },
  { id: 'parentCode', label: 'Parent', type: 'string' },
  { id: 'linkMethods', label: 'Link methods', type: 'string' },
  { id: 'count24h', label: '24h', type: 'number' },
  { id: 'count7d', label: '7d', type: 'number' },
  { id: 'lastPublishedAt', label: 'Last published', type: 'datetime' },
  { id: 'topicReason', label: 'Reason', type: 'string' },
  ...newsCsvColumns,
];

const NI_TOPIC_BLANKS: null[] = new Array<null>(newsCsvColumns.length).fill(null);
const NI_NEWS_BLANKS: null[] = new Array<null>(9).fill(null);

export function niCsvRows(payload: NiPayload): (string | number | boolean | null)[][] {
  const rows: (string | number | boolean | null)[][] = [];
  for (const node of payload.topics) {
    rows.push([
      'topic',
      node.code,
      node.name,
      node.kind,
      node.parentCode,
      node.linkMethods.join('|'),
      node.count24h,
      node.count7d,
      node.lastPublishedAt,
      node.reason,
      ...NI_TOPIC_BLANKS,
    ]);
  }
  for (const row of payload.rows) {
    rows.push(['news', ...NI_NEWS_BLANKS, ...newsCsvRow(row)]);
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live (§NI "Live")
// ─────────────────────────────────────────────────────────────────────────────────────────────

function niLive(_params: NiParams, payload: NiPayload): LiveSpec | null {
  const subject = payload.liveSubject;
  if (subject === null) return null;
  return { subjects: [subject], fields: [], essential: [subject] };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const NI = defineFunction<typeof NiParams, NiPayload>({
  code: 'NI',
  name: 'News by Topic',
  aliases: ['NEWSI'],
  tier: 1,
  category: 'news',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: NiParams,
  paramGrammar: {
    positional: [{ name: 'topic', type: 'topic', optional: true }],
    keyed: {
      N: { name: 'limit', type: 'int' },
      KIND: { name: 'kinds', type: 'enum', values: NI_KINDS },
      CHILDREN: { name: 'includeChildren', type: 'boolean' },
    },
  },
  /** Empty for the same reason as TOP: news is evaluated per source, not per field. */
  fieldIds: (): FieldId[] => [],
  pageable: false,
  live: niLive,
  csv: {
    filename: (params, ctx): string =>
      `NI_${(params.topic ?? 'BROWSE').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_` +
      `${topAsOfCompact(ctx.asOf)}.csv`,
    columns: niCsvColumns,
    rows: (payload): (string | number | boolean | null)[][] => niCsvRows(payload),
  },
  help: {
    summary: 'Browse the topic tree and read the headline feed for one topic',
    description:
      'NI is the topic browser: every topic the platform links headlines to, with how many ' +
      'arrived in the last 24 hours and 7 days, and the headline list for the topic you select. ' +
      'Topics reach headlines two ways — a feed mapping, where every item from a publisher feed ' +
      'belongs to the topic, and a keyword match on the headline, which is deliberately narrow so ' +
      'a topic never collects stories it does not own. Topics that have neither are listed greyed ' +
      'with the reason rather than shown empty: nothing on this screen is inferred. Selecting a ' +
      'topic streams new headlines into the list as they arrive. Press N to search inside the ' +
      'topic, T for the ranked view, A to be alerted on the next headline.',
    params: [
      { name: 'topic', text: 'topic code', example: 'FED' },
      { name: 'limit', text: '10–100 headlines', example: 'N=100' },
      { name: 'kinds', text: 'item kinds, repeatable', example: 'KIND=FILING' },
      { name: 'includeChildren', text: 'roll child topics into the list', example: 'CHILDREN=N' },
    ],
    keys: [
      { key: 'Enter', action: 'select the focused topic, or open the focused story' },
      { key: 'Shift+Enter', action: 'the same topic or the story’s security in the next panel' },
      { key: 'Ctrl+I', action: 'provenance of the headline, or of the feed behind a topic' },
      { key: 'C', action: 'toggle child topics' },
      { key: 'K', action: 'cycle kinds all / stories / filings' },
      { key: '+ / -', action: 'twenty more or fewer headlines' },
      { key: 'A', action: 'alert on this topic (NEWS-07)' },
      { key: 'N', action: 'search inside this topic (N)' },
      { key: 'T', action: 'ranked view of this topic (TOP)' },
      { key: 'Home / End', action: 'first / last topic' },
    ],
    sources: ['bbg.rss', 'sec.atom', 'fed.rss'],
    related: ['TOP', 'N', 'CN', 'ECO', 'DES'],
  },
  keymap: [
    { key: 'C', action: 'toggle-children', description: 'Roll child topics in or out' },
    { key: 'K', action: 'cycle-kinds', description: 'Cycle kinds all / stories / filings' },
    { key: '+', action: 'more', description: 'Twenty more headlines (max 100)' },
    { key: '-', action: 'fewer', description: 'Twenty fewer headlines (min 10)' },
    { key: 'A', action: 'alert-on-topic', description: 'Alert on the next headline of this topic' },
    { key: 'N', action: 'open-n', description: 'Search inside this topic (N)' },
    { key: 'T', action: 'open-top', description: 'Ranked view of this topic (TOP)' },
    { key: 'Home', action: 'first-topic', when: 'grid', description: 'Move to the first topic' },
    { key: 'End', action: 'last-topic', when: 'grid', description: 'Move to the last topic' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default NI;
