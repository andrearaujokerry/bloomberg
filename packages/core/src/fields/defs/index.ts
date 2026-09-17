// GENERATED — do not edit.
//
// Written by `scripts/gen-fields.ts` (`npm run gen:fields`), WORKPLAN §1.10.
// Glob: packages/core/src/fields/defs/*.ts (minus index.ts) — one file per field_class.
//
// `fields/dictionary.ts` imports the class files directly, not this barrel: the assembled
// dictionary must exist before the generator ever runs. This barrel is for everything else
// that wants the per-class arrays or to enumerate the classes the glob matched.

import { analyticFields } from './analytic.js';
import { derivedFields } from './derived.js';
import { econFields } from './econ.js';
import { fundamentalFields } from './fundamental.js';
import { newsFields } from './news.js';
import { portfolioFields } from './portfolio.js';
import { priceFields } from './price.js';
import { referenceFields } from './reference.js';

export {
  analyticFields,
  derivedFields,
  econFields,
  fundamentalFields,
  newsFields,
  portfolioFields,
  priceFields,
  referenceFields,
};

/** Every class array the glob matched, keyed by `field_class`. */
export const fieldDefsByClass = {
  analytic: analyticFields,
  derived: derivedFields,
  econ: econFields,
  fundamental: fundamentalFields,
  news: newsFields,
  portfolio: portfolioFields,
  price: priceFields,
  reference: referenceFields,
} as const;
