/**
 * `functions/shared/bondTerms.ts` — the one place that turns `govt_terms.last_regular_coupon` into
 * the engines' `BondTerms.penultimateCouponDate` (ANAL-09, FUNCTIONS_TIER3 §0).
 *
 * The two columns look like the same date and are not the same statement, and the mismatch was a
 * hard `500` on the seeded universe rather than a rounding difference:
 *
 *  - **`govt_terms.last_regular_coupon`** is the date of the last *regular* coupon. For an ordinary
 *    Treasury note every coupon is regular, including the final one, so the honest value of that
 *    column is the maturity date — which is exactly what `seed/rates.ts#noteTerms` stores, with its
 *    own comment saying so, for all seven seeded notes and bonds.
 *  - **`BondTerms.penultimateCouponDate`** is the schedule's backward anchor and exists only for an
 *    **odd last coupon** (`core/analytics/bond/cashflows.ts` L62-66): the schedule is generated
 *    backwards from it and maturity is *appended*. `validateTerms` therefore refuses a value that is
 *    not strictly before maturity, and it is right to — an anchor on the maturity date would emit
 *    maturity twice and the final period would have zero length.
 *
 * Feeding the column straight in made `RangeError: bond: penultimateCouponDate 2028-08-31 is not
 * before maturity 2028-08-31` the answer to `SRCH <GO>` and to `YAS` on every seeded note
 * (`test/parity/fn-parity.test.ts`'s census recorded both as `INTERNAL`). The fix is not to relax
 * the engine's check: a bond whose final coupon is regular has **no** penultimate anchor, and the
 * absent key is the correct way to say so under `exactOptionalPropertyTypes`.
 *
 * `>=` rather than `===` on purpose. A stored date *after* maturity is corrupt data, and the answer
 * to corrupt data here is still "no odd last coupon" — the schedule then runs off maturity, which is
 * the convention every other term on the row already assumes, instead of throwing out of a screen.
 */

import { compareDates, type IsoDate } from '@terminal/core/calendars/calendar';

/**
 * `{ penultimateCouponDate }` when the row really does describe an odd last coupon, and `{}`
 * otherwise — spread into a `BondTerms` literal.
 */
export function penultimateCouponOf(
  lastRegularCoupon: string | null,
  maturityDate: string,
): { penultimateCouponDate?: IsoDate } {
  if (lastRegularCoupon === null) return {};
  if (compareDates(lastRegularCoupon, maturityDate) >= 0) return {};
  return { penultimateCouponDate: lastRegularCoupon };
}
