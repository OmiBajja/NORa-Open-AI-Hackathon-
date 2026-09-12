const notes = require("./notes");
const reminders = require("./reminders");
const calendar = require("./calendar");

const tools = [
  ...notes,
  reminders,
  ...calendar,
];

const schemas = tools.map((t) => t.schema);

async function callTool(name, args, userId) {
  const tool = tools.find(
    (t) => t.schema.name === name
  );

  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  try {
    return await tool.execute(args, userId);
  } catch (error) {
    if (name.endsWith("_calendar_event") || name === "search_calendar") {
      console.error(`[Calendar] ${name} failed:`, error);
      return {
        success: false,
        external_error: true,
        timeout: error?.code === "ETIMEDOUT" || error?.status === 504,
        message: error?.code === "ETIMEDOUT"
          ? "The calendar service timed out. Nothing was changed."
          : "The calendar service could not complete that operation. Nothing was changed.",
      };
    }
    throw error;
  }
}

module.exports = {
  schemas,
  callTool,
  resolveCalendarConflict: calendar.resolveConflictChoice,
};
