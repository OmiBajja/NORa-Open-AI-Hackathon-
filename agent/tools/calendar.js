const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";
const pending = require("../pending");
const { isOwnerPhone } = require("../webhook");
const configuredDurationMinutes = Number(
  process.env.DEFAULT_EVENT_DURATION_MINUTES || 30
);
const DEFAULT_EVENT_DURATION_MS = (
  Number.isFinite(configuredDurationMinutes) && configuredDurationMinutes > 0
    ? configuredDurationMinutes
    : 30
) * 60 * 1000;
const USER_TIMEZONE = process.env.USER_TIMEZONE || "Europe/Paris";

function pendingMatches(userId, tool, args) {
  if (!userId) return false;
  const action = pending.get(userId);
  if (!action || action.tool !== tool) return false;
  return JSON.stringify(action.args) === JSON.stringify(args);
}

function assertOwner(userId) {
  if (!isOwnerPhone(userId)) {
    const error = new Error("This personal assistant is restricted to its configured owner.");
    error.code = "UNAUTHORIZED_OWNER";
    throw error;
  }
}

const DATA_SOURCE_ID =
  process.env.NOTION_CALENDAR_DATA_SOURCE_ID ||
  "3d85ad1d-54b2-80f0-b9fa-000b754c7555";

function notionEnabled() {
  return Boolean(process.env.NOTION_API_TOKEN);
}

async function notionRequest(path, options = {}) {
  if (!notionEnabled()) {
    throw new Error("NOTION_API_TOKEN is not configured");
  }

  const controller = new AbortController();
  const timeoutMs = Number(process.env.NOTION_TIMEOUT_MS || 15000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetch(`${NOTION_API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.NOTION_API_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Notion calendar request timed out.");
      timeoutError.code = "ETIMEDOUT";
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `Notion API error ${response.status}: ${
        data.message || text
      }`
    );
  }

  return data;
}

function richTextToString(property) {
  if (!property?.rich_text) return "";

  return property.rich_text
    .map((item) => item.plain_text || "")
    .join("");
}

function titleToString(property) {
  if (!property?.title) return "";

  return property.title
    .map((item) => item.plain_text || "")
    .join("");
}

function pageToEvent(page) {
  const properties = page.properties || {};

  const date = properties.Date?.date;

  return {
    pageId: page.id,
    id: properties.ID?.unique_id?.number ?? null,
    name: richTextToString(properties.Name),
    date: normalizeDate(date?.start)?.toISOString() || null,
    endDate: normalizeDate(date?.end)?.toISOString() || null,
    description: richTextToString(
      properties.Description
    ),
    alert: properties.Alert?.checkbox ?? false,
    title: titleToString(properties["Content name"]),
  };
}

function resultError(code, message, extra = {}) {
  return { success: false, [code]: true, message, ...extra };
}

async function safeCalendarCall(operation) {
  try {
    return await operation();
  } catch (error) {
    console.error("[Calendar] external operation failed:", error);
    if (error?.code === "UNAUTHORIZED_OWNER" || error?.code === "NOT_OWNER_RESOURCE") {
      return resultError("unauthorized", "This calendar is restricted to the configured owner.");
    }
    return resultError(
      "external_error",
      error?.code === "ETIMEDOUT"
        ? "The calendar service timed out. Nothing was changed."
        : "The calendar service could not complete that operation. Nothing was changed.",
      { timeout: error?.code === "ETIMEDOUT" || error?.status === 504 }
    );
  }
}

function eventInterval(startDate, endDate, durationMinutes) {
  const start = normalizeUserCalendarDate(startDate);
  if (!start) return { error: "Invalid startDate." };

  let end = normalizeUserCalendarDate(endDate);
  if (endDate !== undefined && endDate !== null && !end) {
    return { error: "Invalid endDate." };
  }

  if (!end && durationMinutes !== undefined && durationMinutes !== null) {
    const minutes = Number(durationMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { error: "durationMinutes must be a positive number." };
    }
    end = new Date(start.getTime() + minutes * 60 * 1000);
  }

  if (!end) end = new Date(start.getTime() + DEFAULT_EVENT_DURATION_MS);
  if (end <= start) return { error: "endDate must be after startDate." };
  return { start, end, startDate: start.toISOString(), endDate: end.toISOString() };
}

function sameInstant(a, b) {
  const left = normalizeDate(a);
  const right = normalizeDate(b);
  return Boolean(left && right && left.getTime() === right.getTime());
}

function eventMatches(actual, expected) {
  return Boolean(
    actual && expected &&
    sameInstant(actual.date, expected.startDate) &&
    sameInstant(actual.endDate, expected.endDate)
  );
}

function localTimeRange(event) {
  if (!event?.date) return "";
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: USER_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
  const start = formatter.format(new Date(event.date));
  const end = event.endDate ? formatter.format(new Date(event.endDate)) : null;
  return end ? ` (${start}–${end})` : ` (${start})`;
}

function isOwnedCalendarPage(page) {
  return Boolean(
    page?.parent?.type === "data_source_id" &&
      page.parent.data_source_id === DATA_SOURCE_ID
  );
}

function normalizeDate(value) {
  if (!value) return null;

  let date;
  const raw = String(value);
  // ISO values without an explicit offset are user-local calendar values,
  // never server-local values. Resolve them in the configured timezone.
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?$/.test(raw)) {
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/);
    const [, y, mo, d, h = "00", mi = "00", s = "00", ms = "0"] = match;
    const candidate = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms.padEnd(3, "0"))));
    date = candidate;
    for (let i = 0; i < 3; i += 1) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: USER_TIMEZONE,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(date).reduce((acc, part) => {
        if (part.type !== "literal") acc[part.type] = Number(part.value);
        return acc;
      }, {});
      const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
      date = new Date(candidate.getTime() - (localAsUtc - date.getTime()));
    }
  } else {
    date = new Date(value);
  }

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function normalizeUserCalendarDate(value) {
  if (typeof value === "string" && /Z$/i.test(value)) {
    return normalizeDate(value.slice(0, -1));
  }
  return normalizeDate(value);
}

function effectiveEventEnd(startValue, endValue) {
  const start = normalizeDate(startValue);
  if (!start) return null;
  const end = normalizeDate(endValue);
  return end || new Date(start.getTime() + DEFAULT_EVENT_DURATION_MS);
}

function datesOverlap(
  startA,
  endA,
  startB,
  endB
) {
  const aStart = normalizeDate(startA);
  const aEnd = effectiveEventEnd(startA, endA);
  const bStart = normalizeDate(startB);
  const bEnd = effectiveEventEnd(startB, endB);

  if (!aStart || !aEnd || !bStart || !bEnd || aEnd <= aStart || bEnd <= bStart) {
    return false;
  }

  return (
    aStart < bEnd &&
    bStart < aEnd
  );
}

async function queryCalendar() {
  return notionRequest(
    `/data_sources/${DATA_SOURCE_ID}/query`,
    {
      method: "POST",
      body: JSON.stringify({
        page_size: 100,
      }),
    }
  );
}

async function getCalendarPage(pageId) {
  const page = await notionRequest(
    `/pages/${pageId}`,
    {
      method: "GET",
    }
  );

  if (!isOwnedCalendarPage(page)) {
    const error = new Error("The requested event is outside the configured calendar.");
    error.code = "NOT_OWNER_RESOURCE";
    throw error;
  }

  return page;
}

/**
 * Search calendar events.
 *
 * query:
 *   Optional text to search in event names/descriptions.
 *
 * startDate / endDate:
 *   Optional ISO dates defining the period to search.
 */
async function searchCalendar({
  query = "",
  startDate = null,
  endDate = null,
} = {}, userId) {
  assertOwner(userId);
  const data = await queryCalendar();

  const queryLower = query
    ? query.toLowerCase()
    : "";

  const start = startDate
    ? normalizeDate(startDate)
    : null;

  const end = endDate
    ? normalizeDate(endDate)
    : null;

  if ((startDate && !start) || (endDate && !end) || (start && end && end <= start)) {
    return resultError("validation_error", "Invalid calendar search range.");
  }

  const events = data.results
    .filter(isOwnedCalendarPage)
    .map(pageToEvent)
    .filter((event) => {
      if (queryLower) {
        const haystack = [
          event.name,
          event.description,
        ]
          .join(" ")
          .toLowerCase();

        if (!haystack.includes(queryLower)) {
          return false;
        }
      }

      if (start || end) {
        const eventStart = normalizeDate(
          event.date
        );

        const eventEnd = effectiveEventEnd(event.date, event.endDate);

        if (!eventStart) return false;

        if (
          end &&
          eventStart >= end
        ) {
          return false;
        }

        if (
          start &&
          eventEnd <= start
        ) {
          return false;
        }
      }

      return true;
    });

  return {
    success: true,
    events,
  };
}

/**
 * Check for overlapping events.
 */
async function findConflicts({
  startDate,
  endDate = null,
  excludePageId = null,
}, userId) {
  // Query the already scoped data source and apply exact interval semantics.
  // This avoids excluding events that start at the requested boundary.
  const result = await searchCalendar({}, userId);

  const conflicts = result.events.filter(
    (event) =>
      event.pageId !== excludePageId &&
      datesOverlap(
        startDate,
        endDate,
        event.date,
        event.endDate
      )
  );

  return conflicts;
}

/**
 * Create a calendar event.
 */
async function createCalendarEvent({
  name,
  startDate,
  endDate = null,
  durationMinutes = null,
  duration = null,
  description = "",
  alert = false,
  force = false,
}, userId) {
  assertOwner(userId);
  if (!name || !startDate) {
    return {
      success: false,
      message:
        "name and startDate are required.",
    };
  }

  const interval = eventInterval(startDate, endDate, durationMinutes ?? duration);
  if (interval.error) return resultError("validation_error", interval.error);
  const { startDate: normalizedStartDate, endDate: normalizedEndDate } = interval;

  if (force && !pendingMatches(userId, "create_calendar_event", {
    name,
    startDate: normalizedStartDate,
    endDate: normalizedEndDate,
    description,
    alert,
  })) {
    return {
      success: false,
      requiresConfirmation: true,
      message: "This calendar confirmation is missing or has expired. Please request the change again.",
    };
  }

  {
    const conflicts = await findConflicts({ startDate: normalizedStartDate, endDate: normalizedEndDate }, userId);

    if (conflicts.length > 0) {
      return {
        success: false,
        conflict: true,
        message: "This event conflicts with existing calendar events. Ask the user which event to move.",
        requestedEvent: { name, startDate: normalizedStartDate, endDate: normalizedEndDate },
        conflictingEvents: conflicts,
        conflicts,
        pendingAction: pending.create(userId, {
          tool: "create_calendar_event",
          args: { name, startDate: normalizedStartDate, endDate: normalizedEndDate, description, alert },
          conflicts,
        }),
      };
    }
  }

  const properties = {
    "Content name": {
      title: [
        {
          text: {
            content: name,
          },
        },
      ],
    },

    Name: {
      rich_text: [
        {
          text: {
            content: name,
          },
        },
      ],
    },

    Date: {
      date: {
        start: normalizedStartDate,
        end: normalizedEndDate,
      },
    },

    Description: {
      rich_text: description
        ? [
            {
              text: {
                content: description,
              },
            },
          ]
        : [],
    },

    Alert: {
      checkbox: Boolean(alert),
    },
  };

  const page = await notionRequest(
    "/pages",
    {
      method: "POST",
      body: JSON.stringify({
        parent: {
          data_source_id: DATA_SOURCE_ID,
        },
        properties,
      }),
    }
  );

  const persisted = await getCalendarPage(page.id);
  const event = pageToEvent(persisted);
  if (!eventMatches(event, { startDate: normalizedStartDate, endDate: normalizedEndDate })) {
    return resultError("create_not_verified", "The calendar write could not be verified.");
  }
  if (force && userId) pending.clear(userId);

  return {
    success: true,
    message: `Calendar event "${name}" created${localTimeRange(event)}.`,
    changed: true,
    event,
  };
}

/**
 * Edit an existing calendar event.
 */
async function editCalendarEvent({
  pageId,
  name,
  startDate,
  endDate,
  durationMinutes = null,
  duration = null,
  description,
  alert,
  force = false,
}, userId) {
  assertOwner(userId);
  if (!pageId) {
    return {
      success: false,
      message: "pageId is required.",
    };
  }

  const existing =
    await getCalendarPage(pageId);

  const current =
    pageToEvent(existing);

  const newStart = startDate || current.date;

  const normalizedNewStart = normalizeUserCalendarDate(newStart);
  if (!normalizedNewStart) {
    return {
      success: false,
      message: "The event does not have a valid date.",
    };
  }

  const currentStart = normalizeDate(current.date);
  const currentEnd = effectiveEventEnd(current.date, current.endDate);
  let newEnd = endDate;
  if (newEnd === undefined && (durationMinutes !== null || duration !== null)) {
    newEnd = new Date(normalizedNewStart.getTime() + Number(durationMinutes ?? duration) * 60 * 1000).toISOString().replace(/Z$/, "+00:00");
  } else if (newEnd === undefined && startDate !== undefined && currentStart && currentEnd) {
    newEnd = new Date(normalizedNewStart.getTime() + (currentEnd.getTime() - currentStart.getTime())).toISOString().replace(/Z$/, "+00:00");
  } else if (newEnd === undefined) {
    newEnd = current.endDate || null;
  }
  const interval = eventInterval(newStart, newEnd, null);
  if (interval.error) return resultError("validation_error", interval.error);
  const normalizedNewEnd = interval.end;

  const confirmedArgs = {
    pageId,
    ...(name !== undefined ? { name } : {}),
    startDate: interval.startDate,
    endDate: normalizedNewEnd.toISOString(),
    ...(description !== undefined ? { description } : {}),
    ...(alert !== undefined ? { alert } : {}),
  };

  if (force && !pendingMatches(userId, "edit_calendar_event", confirmedArgs)) {
    return {
      success: false,
      requiresConfirmation: true,
      message: "This calendar confirmation is missing or has expired. Please request the change again.",
    };
  }

  {
    const conflicts =
      await findConflicts({
        startDate: interval.startDate,
        endDate: interval.endDate,
        excludePageId: pageId,
      }, userId);

    if (conflicts.length > 0) {
      return {
        success: false,
        conflict: true,
        message: "This edit conflicts with existing calendar events. Ask the user for another time.",
        requestedEvent: { ...current, name: name ?? current.name, startDate: interval.startDate, endDate: interval.endDate },
        conflictingEvents: conflicts,
        conflicts,
        event: current,
        pendingAction: pending.create(userId, {
          tool: "edit_calendar_event",
          args: confirmedArgs,
          conflicts,
        }),
      };
    }
  }

  const properties = {};

  if (name !== undefined) {
    properties["Content name"] = {
      title: [
        {
          text: {
            content: name,
          },
        },
      ],
    };

    properties.Name = {
      rich_text: [
        {
          text: {
            content: name,
          },
        },
      ],
    };
  }

  if (startDate !== undefined || endDate !== undefined || durationMinutes !== null || duration !== null) {
    properties.Date = {
      date: {
        start: interval.startDate,
        end: interval.endDate,
      },
    };
  }

  if (description !== undefined) {
    properties.Description = {
      rich_text: description
        ? [
            {
              text: {
                content: description,
              },
            },
          ]
        : [],
    };
  }

  if (alert !== undefined) {
    properties.Alert = {
      checkbox: Boolean(alert),
    };
  }

  const timeRequested = startDate !== undefined || endDate !== undefined || durationMinutes !== null || duration !== null;
  const timeAlreadyCorrect = !timeRequested || eventMatches(current, { startDate: interval.startDate, endDate: interval.endDate });
  const otherFieldsAlreadyCorrect =
    (name === undefined || current.name === name) &&
    (description === undefined || current.description === description) &&
    (alert === undefined || current.alert === Boolean(alert));
  if (timeAlreadyCorrect && otherFieldsAlreadyCorrect) {
    return { success: true, changed: false, already_exists: true, event: current, message: `Calendar event "${current.name}" was already at that time${localTimeRange(current)}.` };
  }

  if (Object.keys(properties).length === 0) {
    return { success: true, changed: false, already_exists: true, event: current, message: `Calendar event "${current.name}" was already up to date.` };
  }

  const page = await notionRequest(`/pages/${pageId}`, { method: "PATCH", body: JSON.stringify({ properties }) });
  const persisted = await getCalendarPage(pageId);
  const event = pageToEvent(persisted);
  const expected = { startDate: interval.startDate, endDate: interval.endDate };
  if (startDate !== undefined || endDate !== undefined || durationMinutes !== null || duration !== null) {
    if (!eventMatches(event, expected)) return resultError("update_not_verified", "The calendar update could not be verified.");
  }
  if (name !== undefined && event.name !== name) return resultError("update_not_verified", "The calendar update could not be verified.");
  if (description !== undefined && event.description !== description) return resultError("update_not_verified", "The calendar update could not be verified.");
  if (alert !== undefined && event.alert !== Boolean(alert)) return resultError("update_not_verified", "The calendar update could not be verified.");

  if (force && userId) pending.clear(userId);

  return {
    success: true,
    changed: true,
    message: `Calendar event "${event.name}" updated${localTimeRange(event)}.`,
    event,
  };
}

/**
 * Delete an existing calendar event.
 */
async function deleteCalendarEvent({
  pageId,
}, userId) {
  assertOwner(userId);
  if (!pageId) {
    return {
      success: false,
      message: "pageId is required.",
    };
  }

  const existing =
    await getCalendarPage(pageId);

  const event =
    pageToEvent(existing);

  await notionRequest(
    `/pages/${pageId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        archived: true,
      }),
    }
  );

  const remaining = await searchCalendar({}, userId);
  if (remaining.events.some((candidate) => candidate.pageId === pageId)) {
    return resultError("delete_not_verified", "The calendar deletion could not be verified.", { event });
  }

  return {
    success: true,
    changed: true,
    message: `Calendar event "${event.name}" deleted${localTimeRange(event)}.`,
    event,
  };
}

function asAbsoluteInput(date) {
  return new Date(date).toISOString().replace(/Z$/, "+00:00");
}

async function resolveConflictChoice(userId, choice) {
  assertOwner(userId);
  const action = pending.get(userId);
  if (!action || action.tool !== "create_calendar_event" || !Array.isArray(action.conflicts)) {
    return resultError("validation_error", "There is no active calendar conflict to resolve.");
  }

  const requestedStart = normalizeDate(action.args.startDate);
  const requestedEnd = normalizeDate(action.args.endDate);
  if (!requestedStart || !requestedEnd || requestedEnd <= requestedStart) {
    return resultError("validation_error", "The pending calendar conflict is invalid.");
  }

  const target = choice === "existing" ? action.conflicts[0] : null;
  if (choice === "existing" && !target) {
    return resultError("not_found", "The conflicting event could not be found.");
  }

  const durationMs = target
    ? effectiveEventEnd(target.date, target.endDate).getTime() - normalizeDate(target.date).getTime()
    : requestedEnd.getTime() - requestedStart.getTime();
  let candidate = choice === "existing"
    ? new Date(requestedEnd)
    : new Date(Math.max(...action.conflicts.map((event) => effectiveEventEnd(event.date, event.endDate).getTime()), requestedStart.getTime()));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidateEnd = new Date(candidate.getTime() + durationMs);
    const conflicts = await findConflicts({
      startDate: asAbsoluteInput(candidate),
      endDate: asAbsoluteInput(candidateEnd),
      excludePageId: target?.pageId || null,
    }, userId);
    if (conflicts.length === 0) {
      let result;
      if (target) {
        const moved = await editCalendarEvent({ pageId: target.pageId, startDate: asAbsoluteInput(candidate) }, userId);
        if (!moved?.success) return moved;

        const created = await createCalendarEvent({
          ...action.args,
          startDate: asAbsoluteInput(requestedStart),
          endDate: asAbsoluteInput(requestedEnd),
        }, userId);
        if (!created?.success) {
          return {
            ...created,
            movedEvent: moved.event,
            message: `The existing event moved, but the requested event could not be created: ${created.message}`,
          };
        }
        result = {
          ...created,
          movedEvent: moved.event,
          message: `${moved.message} ${created.message}`,
        };
      } else {
        result = await createCalendarEvent({
          ...action.args,
          startDate: asAbsoluteInput(candidate),
          endDate: asAbsoluteInput(candidateEnd),
        }, userId);
      }
      if (result?.success) pending.clear(userId);
      return result;
    }
    candidate = new Date(Math.max(...conflicts.map((event) => effectiveEventEnd(event.date, event.endDate).getTime()), candidateEnd.getTime()));
  }

  return resultError("external_error", "No safe calendar slot was found.");
}

const tools = [
  {
    schema: {
      name: "search_calendar",
      description:
        "Search and inspect events in the user's Notion calendar. Use this to find existing events before creating, editing, or deleting calendar entries.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Optional text to search for in event names or descriptions.",
          },
          startDate: {
            type: "string",
            description:
              "Optional ISO 8601 start of the period to search.",
          },
          endDate: {
            type: "string",
            description:
              "Optional ISO 8601 end of the period to search.",
          },
        },
      },
    },

    execute: async (args, userId) =>
      safeCalendarCall(() => searchCalendar(args, userId)),
  },

  {
    schema: {
      name: "create_calendar_event",
      description:
        "Create a new event in the user's Notion calendar. Before creating, check for conflicts. If a conflict exists, do not create anything; return every conflict and ask which event should move.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Name of the calendar event.",
          },
          startDate: {
            type: "string",
            description:
              "Event start as a user-local ISO 8601 date/time. Use Europe/Paris by default; numeric offsets are preserved.",
          },
          endDate: {
            type: "string",
            description:
              "Optional event end as ISO 8601 date/time.",
          },
          durationMinutes: {
            type: "number",
            description: "Optional duration in minutes; used when endDate is omitted.",
          },
          description: {
            type: "string",
            description:
              "Optional event description.",
          },
          alert: {
            type: "boolean",
            description:
              "Whether the Alert checkbox should be enabled.",
          },
          force: {
            type: "boolean",
            description:
              "Legacy confirmation flag; conflicts are always rechecked and never bypassed.",
          },
        },
        required: [
          "name",
          "startDate",
        ],
      },
    },

    execute: async (args, userId) =>
      safeCalendarCall(() => createCalendarEvent(args, userId)),
  },

  {
    schema: {
      name: "edit_calendar_event",
      description:
        "Edit an existing calendar event. Always identify the exact event first. Check the new time for conflicts and never modify the event when the new interval overlaps another event.",
      parameters: {
        type: "object",
        properties: {
          pageId: {
            type: "string",
            description:
              "The Notion page ID of the exact event to edit.",
          },
          name: {
            type: "string",
            description:
              "Optional new event name.",
          },
          startDate: {
            type: "string",
            description:
              "Optional new start as a user-local ISO 8601 date/time. Use Europe/Paris by default; numeric offsets are preserved.",
          },
          endDate: {
            type: "string",
            description:
              "Optional new end as ISO 8601 date/time.",
          },
          durationMinutes: {
            type: "number",
            description: "Optional new duration in minutes; otherwise preserve the existing duration when moving.",
          },
          description: {
            type: "string",
            description:
              "Optional new description.",
          },
          alert: {
            type: "boolean",
            description:
              "Optional new Alert checkbox value.",
          },
          force: {
            type: "boolean",
            description:
              "Legacy confirmation flag; conflicts are always rechecked and never bypassed.",
          },
        },
        required: ["pageId"],
      },
    },

    execute: async (args, userId) =>
      safeCalendarCall(() => editCalendarEvent(args, userId)),
  },

  {
    schema: {
      name: "delete_calendar_event",
      description:
        "Delete an existing calendar event. The exact event must already be identified. If multiple events could match, ask the user to clarify first. Do not ask for an additional confirmation when the user explicitly requested deletion and the target is unambiguous.",
      parameters: {
        type: "object",
        properties: {
          pageId: {
            type: "string",
            description:
              "The Notion page ID of the exact event to delete.",
          },
        },
        required: ["pageId"],
      },
    },

    execute: async (args, userId) =>
      safeCalendarCall(() => deleteCalendarEvent(args, userId)),
  },
];

module.exports = tools;

module.exports.datesOverlap = datesOverlap;
module.exports.effectiveEventEnd = effectiveEventEnd;
module.exports.normalizeDate = normalizeDate;
module.exports.normalizeUserCalendarDate = normalizeUserCalendarDate;
module.exports.DEFAULT_EVENT_DURATION_MS = DEFAULT_EVENT_DURATION_MS;
module.exports.eventInterval = eventInterval;
module.exports.createCalendarEvent = createCalendarEvent;
module.exports.editCalendarEvent = editCalendarEvent;
module.exports.deleteCalendarEvent = deleteCalendarEvent;
module.exports.searchCalendar = searchCalendar;
module.exports.resolveConflictChoice = resolveConflictChoice;
