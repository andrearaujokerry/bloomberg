// GENERATED — do not edit.
//
// Written by `scripts/gen-function-index.ts` (`npm run gen:functions`), WORKPLAN §1.10.
// Glob: packages/sdk/src/wire/rest/*.ts (minus index.ts)
// One module per route group; `client/rest.ts` indexes the group objects these namespaces contain.
//
// Add a module by adding the file and re-running the generator. Hand edits are
// overwritten and fail CI, which re-runs the generator and diffs the result.

import * as admin from './admin.js';
import * as alerts from './alerts.js';
import * as auth from './auth.js';
import * as data from './data.js';
import * as $export from './export.js';
import * as fields from './fields.js';
import * as functions from './functions.js';
import * as help from './help.js';
import * as messages from './messages.js';
import * as news from './news.js';
import * as portfolios from './portfolios.js';
import * as reference from './reference.js';
import * as search from './search.js';
import * as status from './status.js';
import * as usage from './usage.js';
import * as watchlists from './watchlists.js';
import * as workspaces from './workspaces.js';

export {
  admin,
  alerts,
  auth,
  data,
  $export,
  fields,
  functions,
  help,
  messages,
  news,
  portfolios,
  reference,
  search,
  status,
  usage,
  watchlists,
  workspaces,
};

/** Every module the glob matched, keyed by its file (or directory) name. */
export const restModules = {
  admin,
  alerts,
  auth,
  data,
  $export,
  fields,
  functions,
  help,
  messages,
  news,
  portfolios,
  reference,
  search,
  status,
  usage,
  watchlists,
  workspaces,
} as const;
