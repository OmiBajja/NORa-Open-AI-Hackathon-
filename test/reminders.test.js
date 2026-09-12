const assert = require("node:assert/strict");
const test = require("node:test");
const { processDueRemindersWith } = require("../agent/tools/reminders");

function store(initial) {
  let value = structuredClone(initial);
  return {
    load: () => structuredClone(value),
    save: (next) => { value = structuredClone(next); },
    read: () => value,
  };
}

test("overlapping scheduler calls claim a due reminder only once", async () => {
  const state = store([{
    id: "r1",
    userId: "owner",
    message: "demo",
    scheduledFor: "2026-09-12T10:00:00.000Z",
    status: "pending",
  }]);
  let sends = 0;
  const send = async () => {
    sends += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
  };

  await Promise.all([
    processDueRemindersWith({ send, ownerCheck: () => true, now: Date.parse("2026-09-12T10:01:00Z"), load: state.load, save: state.save }),
    processDueRemindersWith({ send, ownerCheck: () => true, now: Date.parse("2026-09-12T10:01:00Z"), load: state.load, save: state.save }),
  ]);
  assert.equal(sends, 1);
  assert.equal(state.read()[0].status, "sent");
});

test("reminder failures retry and eventually become terminal", async () => {
  const state = store([{
    id: "r2",
    userId: "owner",
    message: "demo",
    scheduledFor: "2026-09-12T10:00:00.000Z",
    status: "pending",
  }]);
  const send = async () => { throw new Error("network"); };
  const t0 = Date.parse("2026-09-12T10:01:00Z");

  await processDueRemindersWith({ send, ownerCheck: () => true, now: t0, load: state.load, save: state.save });
  assert.equal(state.read()[0].status, "pending");
  await processDueRemindersWith({ send, ownerCheck: () => true, now: t0 + 120_000, load: state.load, save: state.save });
  await processDueRemindersWith({ send, ownerCheck: () => true, now: t0 + 300_000, load: state.load, save: state.save });
  assert.equal(state.read()[0].status, "failed");
  assert.equal(state.read()[0].attempts, 3);
});

test("corrupt reminder state is surfaced instead of overwritten", async () => {
  let saved = false;
  await assert.rejects(
    processDueRemindersWith({
      send: async () => {},
      load: () => { throw new Error("corrupt state"); },
      save: () => { saved = true; },
      ownerCheck: () => true,
    }),
    /corrupt state/
  );
  assert.equal(saved, false);
});
