const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const pending = require("../agent/pending");

test("pending calendar actions are scoped, durable, and expire", () => {
  try {
    fs.unlinkSync(pending.PENDING_PATH);
  } catch {
    // Test state was not present.
  }

  const created = pending.create("owner", {
    tool: "create_calendar_event",
    args: { name: "Demo", startDate: "2026-09-12T10:00:00Z" },
  }, 1_000, 100);
  assert.equal(created.userId, "owner");
  assert.equal(pending.get("owner", 1_050).tool, "create_calendar_event");
  assert.equal(pending.get("other", 1_050), null);
  assert.equal(pending.get("owner", 1_101), null);

  try {
    fs.unlinkSync(pending.PENDING_PATH);
  } catch {
    // Cleanup is best effort.
  }
});
