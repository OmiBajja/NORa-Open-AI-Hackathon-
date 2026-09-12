const assert = require("node:assert/strict");
const test = require("node:test");
const calendar = require("../agent/tools/calendar");

const { datesOverlap, effectiveEventEnd, DEFAULT_EVENT_DURATION_MS } = calendar;

test("calendar intervals detect exact same-time events", () => {
  assert.equal(
    datesOverlap("2026-09-12T10:00:00+02:00", null, "2026-09-12T10:00:00+02:00", null),
    true
  );
});

test("calendar intervals detect partial and containing overlaps", () => {
  assert.equal(
    datesOverlap("2026-09-12T10:00:00Z", "2026-09-12T11:00:00Z", "2026-09-12T10:30:00Z", "2026-09-12T12:00:00Z"),
    true
  );
  assert.equal(
    datesOverlap("2026-09-12T10:00:00Z", "2026-09-12T13:00:00Z", "2026-09-12T11:00:00Z", "2026-09-12T12:00:00Z"),
    true
  );
});

test("adjacent and different-day calendar events do not overlap", () => {
  assert.equal(
    datesOverlap("2026-09-12T10:00:00Z", "2026-09-12T10:30:00Z", "2026-09-12T10:30:00Z", "2026-09-12T11:00:00Z"),
    false
  );
  assert.equal(
    datesOverlap("2026-09-12T10:00:00Z", "2026-09-12T11:00:00Z", "2026-09-13T10:00:00Z", "2026-09-13T11:00:00Z"),
    false
  );
});

test("missing event end uses the documented default duration", () => {
  const end = effectiveEventEnd("2026-09-12T10:00:00Z", null);
  assert.equal(end.getTime(), new Date("2026-09-12T10:00:00Z").getTime() + DEFAULT_EVENT_DURATION_MS);
});

test("timezone offsets are compared by their instant", () => {
  assert.equal(
    datesOverlap("2026-09-12T10:00:00+02:00", "2026-09-12T11:00:00+02:00", "2026-09-12T08:30:00Z", "2026-09-12T09:00:00Z"),
    true
  );
});

test("timezone-less user times are interpreted in Europe/Paris", () => {
  assert.equal(
    calendar.normalizeDate("2026-09-13T14:00").toISOString(),
    "2026-09-13T12:00:00.000Z"
  );
});
