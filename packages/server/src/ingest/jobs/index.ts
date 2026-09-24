// GENERATED — do not edit.
//
// Written by `scripts/gen-function-index.ts` (`npm run gen:functions`), WORKPLAN §1.10.
// Glob: packages/server/src/ingest/jobs/*.ts (minus index.ts)
// One module per row of the ingest job table (PROVIDERS §13). `IngestJob.id` is the module basename.
//
// Add a module by adding the file and re-running the generator. Hand edits are
// overwritten and fail CI, which re-runs the generator and diffs the result.

import * as blsSeries from './blsSeries.js';
import * as cboeEuIndices from './cboeEuIndices.js';
import * as cboeOptions from './cboeOptions.js';
import * as cboeQuotes from './cboeQuotes.js';
import * as crypto from './crypto.js';
import * as dqMonitors from './dqMonitors.js';
import * as econCalendar from './econCalendar.js';
import * as fedRates from './fedRates.js';
import * as fredSeries from './fredSeries.js';
import * as fxEod from './fxEod.js';
import * as fxIntraday from './fxIntraday.js';
import * as newsRss from './newsRss.js';
import * as partitionMaintenance from './partitionMaintenance.js';
import * as reconcile from './reconcile.js';
import * as retentionPurge from './retentionPurge.js';
import * as secCompanyFacts from './secCompanyFacts.js';
import * as secFrames from './secFrames.js';
import * as secNport from './secNport.js';
import * as secSubmissions from './secSubmissions.js';
import * as shortInterest from './shortInterest.js';
import * as ssgaHoldings from './ssgaHoldings.js';
import * as symbologyRefresh from './symbologyRefresh.js';
import * as treasuryCurves from './treasuryCurves.js';
import * as universeSymbolBook from './universeSymbolBook.js';
import * as usageDeclarations from './usageDeclarations.js';
import * as worldMacro from './worldMacro.js';
import * as yahooDaily from './yahooDaily.js';
import * as yahooIntraday from './yahooIntraday.js';

export {
  blsSeries,
  cboeEuIndices,
  cboeOptions,
  cboeQuotes,
  crypto,
  dqMonitors,
  econCalendar,
  fedRates,
  fredSeries,
  fxEod,
  fxIntraday,
  newsRss,
  partitionMaintenance,
  reconcile,
  retentionPurge,
  secCompanyFacts,
  secFrames,
  secNport,
  secSubmissions,
  shortInterest,
  ssgaHoldings,
  symbologyRefresh,
  treasuryCurves,
  universeSymbolBook,
  usageDeclarations,
  worldMacro,
  yahooDaily,
  yahooIntraday,
};

/** Every module the glob matched, keyed by its file (or directory) name. */
export const ingestJobModules = {
  blsSeries,
  cboeEuIndices,
  cboeOptions,
  cboeQuotes,
  crypto,
  dqMonitors,
  econCalendar,
  fedRates,
  fredSeries,
  fxEod,
  fxIntraday,
  newsRss,
  partitionMaintenance,
  reconcile,
  retentionPurge,
  secCompanyFacts,
  secFrames,
  secNport,
  secSubmissions,
  shortInterest,
  ssgaHoldings,
  symbologyRefresh,
  treasuryCurves,
  universeSymbolBook,
  usageDeclarations,
  worldMacro,
  yahooDaily,
  yahooIntraday,
} as const;
