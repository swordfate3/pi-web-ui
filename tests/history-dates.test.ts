import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarRange, dateInputValue, recentHistoryRange } from "../src/web/src/core/history-dates.ts";

test("recent range spans local calendar midnights, including DST rather than 72 hours", () => {
  const old = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    assert.deepEqual(recentHistoryRange(new Date("2026-03-09T18:00:00Z")), {
      from: Date.parse("2026-03-07T05:00:00Z"),
      to: Date.parse("2026-03-10T04:00:00Z"),
    });
    assert.deepEqual(calendarRange("2026-03-08", "2026-03-08"), {
      from: Date.parse("2026-03-08T05:00:00Z"),
      to: Date.parse("2026-03-09T04:00:00Z"),
    });
    assert.equal(dateInputValue(Date.parse("2026-03-09T03:00:00Z")), "2026-03-08");
    assert.throws(() => calendarRange("2026-02-30", "2026-03-01"), /date/i);
    assert.throws(() => calendarRange("2026-03-10", "2026-03-08"), /date|range/i);
    assert.throws(() => calendarRange("", "2026-03-08"), /date/i);
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
});
