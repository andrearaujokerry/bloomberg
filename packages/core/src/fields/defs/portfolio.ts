// packages/core/src/fields/defs/portfolio.ts — field_class 'portfolio'
//
// Tenant analytics computed over a firm's own positions (PORT_WEIGHT, PORT_MV, PORT_PNL_1D,
// PORT_ACTIVE_WEIGHT, PORT_CONTRIB_TE and the rest of API.md §7). They are a separate field class
// because they are a separate entitlement dimension: portfolio data never leaves the firm, is never
// licensed from a provider, and is never exported outside it.
//
// WP-01 seeds the dictionary with the field ids CONTRACTS §4.3 lists, and §4.3 declares none of this
// class yet — the PORT_* ids arrive with the portfolio functions (WORKPLAN §18.1 gives this file its
// single later owner). The empty array is therefore the correct seed, not a gap: the class file
// exists so that the dictionary, the generator and `GET /fields?fieldClass=portfolio` all have the
// same eight class files to work with.

import type { FieldDef } from '../../types/fields.js';

export const portfolioFields: readonly FieldDef[] = [];
