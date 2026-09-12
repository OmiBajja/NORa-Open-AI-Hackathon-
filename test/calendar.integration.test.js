const assert = require("node:assert/strict");
const test = require("node:test");

process.env.WHATSAPP_OWNER_PHONE = "33123456789";
process.env.NOTION_API_TOKEN = "test-token";

const calendar = require("../agent/tools/calendar");
const pending = require("../agent/pending");

const OWNER = "33123456789";
const DATA_SOURCE = "3d85ad1d-54b2-80f0-b9fa-000b754c7555";
let pages = new Map();
let nextId = 1;
let ignorePatches = false;

function page(id, name, start, end, archived = false) {
  return {
    id,
    archived,
    parent: { type: "data_source_id", data_source_id: DATA_SOURCE },
    properties: {
      "Content name": { title: [{ plain_text: name }] },
      Name: { rich_text: [{ plain_text: name }] },
      Date: { date: { start, end } },
      Description: { rich_text: [] },
      Alert: { checkbox: false },
    },
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test.beforeEach(() => {
  pages = new Map();
  nextId = 1;
  ignorePatches = false;
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === `/v1/data_sources/${DATA_SOURCE}/query`) {
      return response({ results: [...pages.values()].filter((item) => !item.archived) });
    }
    if (parsed.pathname === "/v1/pages" && options.method === "POST") {
      const body = JSON.parse(options.body);
      const date = body.properties.Date.date;
      const name = body.properties.Name.rich_text[0].text.content;
      const created = page(`p${nextId++}`, name, date.start, date.end);
      pages.set(created.id, created);
      return response(created);
    }
    const id = parsed.pathname.split("/").pop();
    const existing = pages.get(id);
    if (!existing) return response({ message: "not found" }, 404);
    if ((options.method || "GET") === "GET") return response(existing);
    if (options.method === "PATCH") {
      const body = JSON.parse(options.body);
      if (ignorePatches) return response(existing);
      if (body.archived !== undefined) existing.archived = body.archived;
      if (body.properties?.Date?.date) existing.properties.Date.date = body.properties.Date.date;
      if (body.properties?.Name?.rich_text) existing.properties.Name.rich_text = body.properties.Name.rich_text.map((x) => ({ plain_text: x.text.content }));
      if (body.properties?.["Content name"]?.title) existing.properties["Content name"].title = body.properties["Content name"].title.map((x) => ({ plain_text: x.text.content }));
      return response(existing);
    }
    return response(existing);
  };
});

test("create uses 30-minute default and verifies persisted values", async () => {
  const result = await calendar.createCalendarEvent({ name: "Salsa", startDate: "2026-09-13T14:00:00+02:00" }, OWNER);
  assert.equal(result.success, true);
  assert.equal(result.changed, true);
  assert.equal(result.event.date, "2026-09-13T12:00:00.000Z");
  assert.equal(result.event.endDate, "2026-09-13T12:30:00.000Z");
});

test("create supports explicit duration and end, and rejects invalid intervals", async () => {
  let result = await calendar.createCalendarEvent({ name: "Long", startDate: "2026-09-13T14:00:00+02:00", durationMinutes: 90 }, OWNER);
  assert.equal(result.event.endDate, "2026-09-13T13:30:00.000Z");
  result = await calendar.createCalendarEvent({ name: "Explicit", startDate: "2026-09-14T14:00:00+02:00", endDate: "2026-09-14T16:00:00+02:00" }, OWNER);
  assert.equal(result.event.endDate, "2026-09-14T14:00:00.000Z");
  result = await calendar.createCalendarEvent({ name: "Invalid", startDate: "2026-09-15T14:00:00+02:00", endDate: "2026-09-15T12:30:00+02:00" }, OWNER);
  assert.equal(result.success, false);
  assert.equal(result.validation_error, true);
});

test("overlap rejects creation, adjacency is allowed, and timezone offsets are equivalent", async () => {
  await calendar.createCalendarEvent({ name: "Salsa", startDate: "2026-09-16T14:00:00+02:00" }, OWNER);
  let result = await calendar.createCalendarEvent({ name: "Dog", startDate: "2026-09-16T14:15:00+02:00" }, OWNER);
  assert.equal(result.conflict, true);
  assert.equal(pages.size, 1);
  result = await calendar.createCalendarEvent({ name: "Adjacent", startDate: "2026-09-16T14:30:00+02:00" }, OWNER);
  assert.equal(result.success, true);
  assert.equal(calendar.datesOverlap("2026-09-13T14:00:00+02:00", "2026-09-13T14:30:00+02:00", "2026-09-13T12:00:00Z", "2026-09-13T12:30:00Z"), true);
});

test("model-generated Z timestamps are interpreted as user-local calendar times", async () => {
  await calendar.createCalendarEvent({ name: "Bobby", startDate: "2026-09-21T15:00:00+02:00" }, OWNER);
  const result = await calendar.createCalendarEvent({ name: "Japanese", startDate: "2026-09-21T15:15:00Z" }, OWNER);
  assert.equal(result.success, false);
  assert.equal(result.conflict, true);
  assert.equal(result.requestedEvent.startDate, "2026-09-21T13:15:00.000Z");
});

test("button choice moves only the selected conflicting event to the next safe slot", async () => {
  await calendar.createCalendarEvent({ name: "Bobby", startDate: "2026-09-22T15:00:00+02:00" }, OWNER);
  const conflict = await calendar.createCalendarEvent({ name: "Japanese", startDate: "2026-09-22T15:15:00Z" }, OWNER);
  assert.equal(conflict.conflict, true);

  const moved = await calendar.resolveConflictChoice(OWNER, "existing");
  assert.equal(moved.success, true);
  assert.equal(moved.movedEvent.name, "Bobby");
  assert.equal(moved.movedEvent.date, "2026-09-22T13:45:00.000Z");
  assert.equal(moved.movedEvent.endDate, "2026-09-22T14:15:00.000Z");
  assert.equal(pages.size, 2);
  assert.equal([...pages.values()].find((page) => page.properties.Name.rich_text[0].plain_text === "Japanese").properties.Date.date.start, "2026-09-22T13:15:00.000Z");
});

test("edit preserves duration, detects conflicts, and reports already-correct", async () => {
  const created = await calendar.createCalendarEvent({ name: "Dog", startDate: "2026-09-17T16:00:00+02:00", durationMinutes: 90 }, OWNER);
  let result = await calendar.editCalendarEvent({ pageId: created.event.pageId, startDate: "2026-09-17T18:00:00+02:00" }, OWNER);
  assert.equal(result.success, true);
  assert.equal(result.event.date, "2026-09-17T16:00:00.000Z");
  assert.equal(result.event.endDate, "2026-09-17T17:30:00.000Z");
  result = await calendar.editCalendarEvent({ pageId: created.event.pageId, startDate: "2026-09-17T18:00:00+02:00" }, OWNER);
  assert.equal(result.changed, false);
  assert.equal(result.already_exists, true);
});

test("edit conflict leaves the original event untouched", async () => {
  const salsa = await calendar.createCalendarEvent({ name: "Salsa", startDate: "2026-09-19T14:00:00+02:00" }, OWNER);
  const dog = await calendar.createCalendarEvent({ name: "Dog", startDate: "2026-09-19T16:00:00+02:00" }, OWNER);
  const result = await calendar.editCalendarEvent({ pageId: dog.event.pageId, startDate: "2026-09-19T14:15:00+02:00" }, OWNER);
  assert.equal(result.success, false);
  assert.equal(result.conflict, true);
  assert.deepEqual(result.conflictingEvents.map((event) => event.name), ["Salsa"]);
  assert.equal(pages.get(dog.event.pageId).properties.Date.date.start, "2026-09-19T14:00:00.000Z");
  assert.equal(pages.get(salsa.event.pageId).properties.Date.date.start, "2026-09-19T12:00:00.000Z");
});

test("delete is verified and ownership is enforced", async () => {
  const created = await calendar.createCalendarEvent({ name: "Delete me", startDate: "2026-09-18T10:00:00+02:00" }, OWNER);
  const result = await calendar.deleteCalendarEvent({ pageId: created.event.pageId }, OWNER);
  assert.equal(result.success, true);
  assert.equal((await calendar.searchCalendar({}, OWNER)).events.length, 0);
  await assert.rejects(() => calendar.searchCalendar({}, "33999999999"), /restricted/);
  pending.clear(OWNER);
});

test("update verification failure is never reported as success", async () => {
  const created = await calendar.createCalendarEvent({ name: "Verify", startDate: "2026-09-20T10:00:00+02:00" }, OWNER);
  ignorePatches = true;
  const result = await calendar.editCalendarEvent({ pageId: created.event.pageId, startDate: "2026-09-20T11:00:00+02:00" }, OWNER);
  assert.equal(result.success, false);
  assert.equal(result.update_not_verified, true);
});
