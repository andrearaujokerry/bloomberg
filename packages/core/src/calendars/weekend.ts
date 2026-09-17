/**
 * `WEEKEND` — the degenerate calendar: Saturday and Sunday are non-business days, every other day
 * is open, and there are no `calendar_holidays` rows at all (`kind = 'weekend'`, CONTRACTS L110).
 *
 * It is the identity element of {@link combine}: `combine([WEEKEND, X])` has exactly the holidays of
 * `X`. Analytics that must not assume a venue — a generic ACT/360 accrual, a synthetic curve pillar
 * — roll on this calendar so the result is venue-independent and reproducible.
 */

import type { Calendar } from './calendar.js';
import { makeRuleCalendar, registerCalendar, weekdaySessions } from './calendar.js';

/** `WEEKEND` — Saturday/Sunday only, no holidays, 24-hour weekday sessions. */
export const WEEKEND: Calendar = registerCalendar(
  makeRuleCalendar({
    id: 'WEEKEND',
    name: 'Weekends only',
    tz: 'UTC',
    kind: 'weekend',
    rule: () => [],
    sessions: weekdaySessions({ open: '00:00', close: '24:00' }),
  }),
);
