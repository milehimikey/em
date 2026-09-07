// SPDX-License-Identifier: MIT
// Coverage for src/util/localDate.ts (MIL-206): every date-defaulting command
// (`em slice review`/`ratify`, `em state set-phase`/`set-conformance`/`set-review`,
// `em state log-usage`, `em conform-supersede`, `em scaffold`) shares this one helper so "today"
// always means the caller's own calendar date, never UTC's (which is already tomorrow after
// ~17:00 in the Americas). CLI-level coverage that the default actually reaches the stamped
// field lives in test/cli.test.ts's ratify block.
import { describe, it, expect } from "vitest";
import { localIsoDate } from "../src/util/localDate.js";

describe("localIsoDate", () => {
  it("builds YYYY-MM-DD from the local calendar date, not the UTC one", () => {
    // 2026-09-06 23:30 *local* — the exact evening-ratification shape from MIL-206's report:
    // toISOString().slice(0, 10) reads this as a UTC instant that has already rolled to the
    // 7th anywhere at or west of UTC, while the local calendar date is still the 6th.
    expect(localIsoDate(new Date(2026, 8, 6, 23, 30))).toBe("2026-09-06");
  });

  it("zero-pads single-digit months and days", () => {
    expect(localIsoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("defaults to the current local date when called with no argument", () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}`;
    expect(localIsoDate()).toBe(expected);
  });
});
