// SPDX-License-Identifier: MIT
// Shared "what calendar date is it" helper for every date-defaulting command (MIL-206).
//
// `new Date().toISOString().slice(0, 10)` reads the UTC calendar date, not the caller's. After
// ~17:00 in the Americas (any zone west of UTC), that's already tomorrow: someone ratifying a
// slice at 6pm local time on the 6th got `ratifiedOn: 2026-09-07` stamped instead. Build the
// string from the local getters instead, so the default always matches what the caller's own
// clock and calendar say "today" is. A caller who wants UTC (or any other zone) can still pass
// an explicit date through `--on`.

/** `YYYY-MM-DD` for `d`'s local calendar date (default: now). Zero-pads month/day. */
export function localIsoDate(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
