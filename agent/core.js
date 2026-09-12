const OpenAI = require("openai");
const memory = require("./memory");
const { schemas, callTool, resolveCalendarConflict } = require("./tools");
const pending = require("./pending");
const { withTimeout } = require("./persistence");

const LLM_PROVIDER = process.env.LLM_PROVIDER ||
  (process.env.OPENROUTER_API_KEY ? "openrouter" : "openai");
const LLM_API_KEY = LLM_PROVIDER === "openrouter"
  ? process.env.OPENROUTER_API_KEY
  : process.env.OPENAI_API_KEY;
const ai = new OpenAI({
  apiKey: LLM_API_KEY,
  baseURL: LLM_PROVIDER === "openrouter"
    ? (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1")
    : (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
});

// ------------------------------------------------------------
// Models
// ------------------------------------------------------------

const PRIMARY_MODEL = process.env.LLM_MODEL ||
  (LLM_PROVIDER === "openrouter"
    ? (process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini")
    : (process.env.OPENAI_MODEL || "gpt-4o-mini"));
const FALLBACK_MODEL = process.env.LLM_FALLBACK_MODEL || PRIMARY_MODEL;

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

const USER_TIMEZONE =
  process.env.USER_TIMEZONE ||
  "Europe/Paris";

// Maximum number of sequential tool calls for one message.
//
// Example:
//
// search_notes
// -> update_note
// -> create_reminder
//
// = 3 tool calls
//
// This protects against an accidental infinite loop.
const MAX_TOOL_CALLS = 8;

// ------------------------------------------------------------
// Retry configuration
// ------------------------------------------------------------

const RETRYABLE_STATUS_CODES = new Set([
  429,
  500,
  502,
  503,
  504,
]);

const MAX_RETRIES_PER_MODEL = 3;
const INITIAL_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 8000;

// ------------------------------------------------------------
// OpenAI-compatible tool declarations (used by OpenAI and OpenRouter).
// ------------------------------------------------------------

const toolDeclarations = schemas.map((schema) => ({ type: "function", function: schema }));

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function getErrorStatus(err) {
  return Number(
    err?.status ||
      err?.error?.code ||
      err?.response?.status ||
      0
  );
}

/**
 * Extract OpenAI-compatible assistant text and tool calls.
 */
function getResponseText(result) {
  return result?.choices?.[0]?.message?.content || "";
}

function getFunctionCalls(result) {
  return (result?.choices?.[0]?.message?.tool_calls || []).map((call) => {
    let args = {};
    try {
      args = JSON.parse(call.function?.arguments || "{}");
    } catch {
      args = {};
    }
    return { id: call.id, name: call.function?.name, args };
  });
}

// ------------------------------------------------------------
// Current date/time
// ------------------------------------------------------------

function getCurrentDateTimeContext() {
  const now = new Date();

  const formatted = new Intl.DateTimeFormat(
    "en-GB",
    {
      timeZone: USER_TIMEZONE,
      dateStyle: "full",
      timeStyle: "long",
    }
  ).format(now);

  return {
    iso: now.toISOString(),
    formatted,
    timezone: USER_TIMEZONE,
  };
}

// ------------------------------------------------------------
// OpenAI / OpenRouter generation with retry + fallback
// ------------------------------------------------------------

async function generateWithRetry(request) {
  const models = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL])];

  let lastError;

  for (const model of models) {
    for (
      let attempt = 0;
      attempt < MAX_RETRIES_PER_MODEL;
      attempt++
    ) {
      try {
        console.log(
          `[${LLM_PROVIDER}] Request using ${model} (attempt ${
            attempt + 1
          }/${MAX_RETRIES_PER_MODEL})`
        );

        const result = await withTimeout(
          ai.chat.completions.create({ ...request, model }),
          Number(process.env.LLM_TIMEOUT_MS || 30000),
          `${LLM_PROVIDER} ${model} request`
        );

        return result;
      } catch (err) {
        lastError = err;

        const status = getErrorStatus(err);

        console.error(
          `[${LLM_PROVIDER}] ${model} failed with status ${
            status || "unknown"
          }:`,
          err?.message || err
        );

        if (
          !RETRYABLE_STATUS_CODES.has(status)
        ) {
          throw err;
        }

        if (
          attempt ===
          MAX_RETRIES_PER_MODEL - 1
        ) {
          console.warn(
            `[${LLM_PROVIDER}] ${model} failed after ${MAX_RETRIES_PER_MODEL} attempts.`
          );

          break;
        }

        const delay = Math.min(
          INITIAL_RETRY_DELAY *
            2 ** attempt,
          MAX_RETRY_DELAY
        );

        console.warn(
          `[${LLM_PROVIDER}] Temporary error ${status}. Retrying in ${delay}ms...`
        );

        await sleep(delay);
      }
    }

    console.warn(
      `[${LLM_PROVIDER}] Falling back from ${model}...`
    );
  }

  throw lastError;
}

// ------------------------------------------------------------
// Normalize text for grounding checks
// ------------------------------------------------------------

function normalizeWords(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9à-ÿ]+/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// ------------------------------------------------------------
// Check whether reminder content is grounded in the CURRENT
// user message.
// ------------------------------------------------------------

function isReminderGroundedInCurrentMessage(
  reminderMessage,
  currentUserText
) {
  const reminderWords = normalizeWords(
    reminderMessage
  );

  const currentWords = new Set(
    normalizeWords(currentUserText)
  );

  if (
    reminderWords.length === 0 ||
    currentWords.size === 0
  ) {
    return false;
  }

  const ignoredWords = new Set([
    "remind",
    "reminder",
    "remember",
    "me",
    "please",
    "later",
    "today",
    "tomorrow",
    "tonight",
    "morning",
    "afternoon",
    "evening",
    "minute",
    "minutes",
    "second",
    "seconds",
    "hour",
    "hours",
    "the",
    "a",
    "an",
    "to",
    "at",
    "on",
    "in",
    "of",
    "for",
    "my",
    "i",
    "can",
    "you",
    "could",
    "would",
    "will",
  ]);

  const meaningfulReminderWords =
    reminderWords.filter(
      (word) =>
        word.length >= 3 &&
        !ignoredWords.has(word)
    );

  if (
    meaningfulReminderWords.length === 0
  ) {
    return false;
  }

  const matchingWords =
    meaningfulReminderWords.filter(
      (word) => currentWords.has(word)
    );

  return matchingWords.length >= 1;
}

// ------------------------------------------------------------
// Validate tool call against CURRENT user message
// ------------------------------------------------------------

function validateToolCall(
  call,
  currentUserText
) {
  if (!call) {
    return {
      valid: true,
    };
  }

  // ----------------------------------------------------------
  // Reminder protection
  // ----------------------------------------------------------

  if (
    call.name === "create_reminder"
  ) {
    const message =
      call.args?.message;

    const scheduledFor =
      call.args?.scheduledFor;

    if (
      typeof message !== "string" ||
      !message.trim()
    ) {
      return {
        valid: false,
        reason:
          "Reminder message is missing.",
      };
    }

    if (
      typeof scheduledFor !== "string" ||
      !scheduledFor.trim()
    ) {
      return {
        valid: false,
        reason:
          "Reminder scheduledFor is missing.",
      };
    }

    const date =
      new Date(scheduledFor);

    if (
      Number.isNaN(date.getTime())
    ) {
      return {
        valid: false,
        reason:
          "Reminder scheduledFor is not a valid datetime.",
      };
    }

    if (
      !isReminderGroundedInCurrentMessage(
        message,
        currentUserText
      )
    ) {
      console.error(
        "[Safety] Rejected reminder because its content was not grounded in the current user message."
      );

      console.error(
        `[Safety] Current user message: "${currentUserText}"`
      );

      console.error(
        `[Safety] Model reminder message: "${message}"`
      );

      return {
        valid: false,
        reason:
          "The reminder content does not appear to come from the current user message. Do not reuse an older reminder.",
      };
    }
  }

  return {
    valid: true,
  };
}

// ------------------------------------------------------------
// System prompt
// ------------------------------------------------------------

function buildSystemPrompt(longTerm) {
  const dateTime =
    getCurrentDateTimeContext();

  const factsBlock =
    longTerm.facts.length > 0
      ? `Known facts about the user:\n- ${longTerm.facts.join(
          "\n- "
        )}`
      : "No known facts about the user yet.";

  const summaryBlock = longTerm.summary
    ? `Conversation summary so far:\n${longTerm.summary}`
    : "No prior conversation summary.";

  return `
You are the user's personal second-brain assistant living inside WhatsApp.

Be concise, natural, and conversational.
Respond like a sharp personal assistant texting the user.
Do not sound like a formal chatbot.

--------------------------------------------------
CURRENT DATE AND TIME
--------------------------------------------------

Current date/time:
${dateTime.formatted}

Current ISO time:
${dateTime.iso}

User timezone:
${dateTime.timezone}

Use this information whenever the user refers to relative dates or times.

--------------------------------------------------
VERY IMPORTANT: CURRENT MESSAGE PRIORITY
--------------------------------------------------

The CURRENT user message is authoritative.

Older conversation is background context only.

Never copy an action, task, reminder, note, or reminder content from an older message into a new tool call unless the CURRENT user message explicitly refers to it.

In particular:

If an old conversation contains:
"remind me to check the microwave"

and the current user says:
"remind me in 30 seconds to write a letter to my grandmother"

the reminder MUST be:

"write a letter to my grandmother"

NOT:

"check the microwave"

Never reuse old reminder content just because it appears in conversation history.

--------------------------------------------------
TOOLS
--------------------------------------------------

You have real tools that execute actions:

- create_note
- search_notes
- update_note
- create_reminder
- search_calendar
- create_calendar_event
- edit_calendar_event
- delete_calendar_event

You MUST actually call the appropriate tool when one applies.

Never claim that something was saved, modified, or scheduled unless the tool was actually called successfully.

--------------------------------------------------
CREATE NOTE
--------------------------------------------------

Use create_note when the CURRENT user message clearly wants something captured or saved as a new note.

Examples:

- "write this down"
- "write down an idea"
- "save this idea"
- "make a note of this"
- "remember this idea"
- "note this"

If the current message clearly contains an idea that the user wants captured, call create_note.

Do NOT create a note merely because an old conversation contains a note.

When creating a note:

- Create a concise useful title.
- Preserve the user's actual idea.
- Add relevant tags when useful.
- Do not invent facts.

--------------------------------------------------
SEARCH NOTES
--------------------------------------------------

Use search_notes when the CURRENT user message refers to an existing note or information that NORA may have previously saved.

Examples:

- "What did I write about X?"
- "Find my note about Pokémon"
- "What was that idea I saved?"
- "Show me my note about the hackathon"

If the user asks to MODIFY, UPDATE, ADD TO, CORRECT, or otherwise change an existing note:

1. FIRST call search_notes.
2. Identify the correct existing note.
3. Use the page_id returned by search_notes.
4. THEN call update_note using that page_id.
5. Do NOT call create_note.

--------------------------------------------------
UPDATE NOTE
--------------------------------------------------

Use update_note when the CURRENT user message asks to modify an existing note.

Typical examples:

- "Modifie ma liste de Pokémon..."
- "Ajoute ça à ma note..."
- "Corrige ma note..."
- "Mets à jour ma liste..."
- "Ajoute les noms anglais à ma liste..."
- "Change le contenu de ma note..."

IMPORTANT:

If you don't already know the page_id of the note:

→ search_notes FIRST.

Then use the page_id returned by search_notes.

Never create a duplicate note when the user asks to modify an existing note.

When updating a note:

- Preserve the existing information unless the user asks to remove it.
- Apply the requested modification.
- Do not invent unrelated information.
- Keep the existing title unless changing it is useful or requested.
- Use the exact page_id returned by search_notes.

--------------------------------------------------
NOTE MODIFICATION WORKFLOW
--------------------------------------------------

For a request such as:

"Modifie ma liste de Pokémon pour ajouter les noms anglais"

the correct workflow is:

1. search_notes with a query related to the Pokémon list.
2. Read the returned note and its page_id.
3. Modify the existing content by adding the English names.
4. Call update_note with the existing page_id.
5. Only then tell the user that the note was updated.

Do NOT respond "Done" after search_notes alone.
You must actually perform the update.

--------------------------------------------------
CREATE REMINDER
--------------------------------------------------

Use create_reminder ONLY when the CURRENT user message explicitly asks for a reminder, alarm, follow-up, or future notification.

Examples:

- "remind me in 10 minutes"
- "remind me tomorrow"
- "set a reminder to call John"
- "remind me to check the oven"
- "remind me tomorrow at 9"
- "remind me in 30 seconds to write my grandmother"

The reminder MUST be based on the CURRENT user message.

The reminder message must describe what the user currently wants to be reminded about.

Never copy reminder content from older messages.

--------------------------------------------------
REMINDER TOOL FORMAT
--------------------------------------------------

The create_reminder tool requires:

message
scheduledFor

scheduledFor MUST be an absolute ISO 8601 datetime.

Example:

{
  "message": "Write a letter to my grandmother",
  "scheduledFor": "2026-09-11T16:00:00+02:00"
}

Never use delaySeconds.

Never invent reminder content.

If the user provides a relative time, convert it into an absolute datetime using the current date/time and timezone above.

--------------------------------------------------
AMBIGUOUS REMINDER
--------------------------------------------------

If the user clearly asks for a reminder but does not specify what they want to be reminded about, ask what they want the reminder to say.

If they specify the content but not the time, ask when they want the reminder.

Do not guess.

--------------------------------------------------
SEARCH CALENDAR
--------------------------------------------------

Use search_calendar when the CURRENT user message asks about events, appointments,
meetings, plans, or anything that may already exist in the calendar.

Examples:

- "what do I have tomorrow?"
- "what's on my calendar this afternoon?"
- "what do I have next week?"
- "when is my meeting with Olivier?"
- "do I have anything scheduled Friday?"
- "is there anything at 3pm tomorrow?"
- "when is my dentist appointment?"

If the user asks what is scheduled, ALWAYS consult the calendar with search_calendar.
Do not rely on memory or assumptions.

Use search_calendar before editing or deleting an event when the exact event
page_id is not already known.

When searching:

- Use the user's requested date/time range when one is provided.
- Use Europe/Paris as the default timezone.
- Search by event name or description when the user refers to a specific event.
- If multiple events match the user's request, do not guess which one they mean.
  Present the matching events and ask the user to clarify.
- Do not modify or delete anything with search_calendar.


--------------------------------------------------
CREATE CALENDAR EVENT
--------------------------------------------------

Use create_calendar_event when the CURRENT user message clearly asks to create,
add, schedule, or put something on the calendar.

Examples:

- "add a meeting tomorrow at 2pm"
- "schedule a dentist appointment Friday at 10"
- "put lunch with Alice on my calendar"
- "add a meeting with Olivier next Tuesday"
- "schedule this for tomorrow at 3pm"

When creating an event:

- Determine a concise event name from the user's message.
- Use Europe/Paris as the default timezone.
- Convert dates and times to ISO 8601 format.
- Set Alert to false unless the user explicitly asks to be notified or reminded.
- Include a description when the user provides useful additional information.
- Do not invent missing information.

Before creating an event, check for an existing event that overlaps the requested
time.

If the calendar tool reports a conflict:

- Do NOT use force=true and do NOT move either event automatically.
- Treat the conflict result as authoritative and mention every conflicting event.
- Ask which event the user wants to move (the existing event or the newly requested event).
- If they choose an event without giving a new time, ask what time to use.
- If they provide both an event and a new time, call edit_calendar_event and let the tool re-check conflicts.

Do not create an overlapping event merely because the user says "yes". The user must
choose which event to move; the calendar tool remains authoritative.


--------------------------------------------------
EDIT CALENDAR EVENT
--------------------------------------------------

Use edit_calendar_event when the CURRENT user message clearly asks to modify,
rename, move, reschedule, or otherwise change an existing calendar event.

Examples:

- "move my meeting with Olivier to 3pm"
- "reschedule my dentist appointment to Friday"
- "change the description of my meeting"
- "rename my meeting with Alice"
- "turn off the alert for my appointment"
- "move that meeting to tomorrow"

Before editing:

- Identify the exact existing event.
- If the event's page_id is not already known, use search_calendar first.
- If multiple events could match, ask the user which event they mean.
- Never guess which event should be modified.

If the edit changes the event's date or time:

- Check whether the new time overlaps an existing event.
- If there is a conflict, do NOT use force=true and do not move anything automatically.
- Tell the user about every conflicting event and ask for another time.

Never claim a calendar action succeeded unless the tool result contains success=true.
If the result has conflict, update_not_verified, delete_not_verified, validation_error,
or external_error, explain that nothing was changed and ask for recovery input.

Only modify the properties that the user actually asked to change.
Do not overwrite unrelated information.


--------------------------------------------------
DELETE CALENDAR EVENT
--------------------------------------------------

Use delete_calendar_event when the CURRENT user message clearly asks to remove,
delete, cancel, or erase an existing calendar event.

Examples:

- "delete my meeting with Olivier"
- "remove my dentist appointment"
- "cancel the meeting tomorrow at 3pm"
- "remove that event from my calendar"

Before deleting:

- Identify the exact event.
- If the event's page_id is not already known, use search_calendar first.
- If multiple events could match, ask the user which event they mean.
- Never guess which event should be deleted.

If the user explicitly asks to delete an unambiguous event:

- Delete it directly.
- Do NOT ask for an additional confirmation.
- Do not use force or any equivalent confirmation flag.

Never delete an event merely because it seems likely to be the one the user meant.

If the user asks to delete an event that does not exist:

- Tell the user that no matching event was found.
- Do not create or modify anything.


--------------------------------------------------
CALENDAR SAFETY RULES
--------------------------------------------------

Never silently overwrite, move onto, or delete an existing calendar event.

A calendar conflict means that two events overlap in time.
Events occurring on the same day do not necessarily conflict.

An explicit user confirmation applies only to the specific conflicting operation
currently being discussed.

Do not interpret a generic "yes" from an unrelated part of the conversation as
permission to perform a destructive or conflicting calendar operation.

The ID and Created by fields are managed automatically by Notion.
Never attempt to modify them.

The Alert field is only the calendar notification preference.
It should remain false unless the user explicitly requests an alert or reminder.

The Content name field is the internal Notion page title.
When creating or renaming an event, use the same value as the event name.

--------------------------------------------------
TOOL PRIORITY
--------------------------------------------------

If the CURRENT user message clearly requests a new note:
→ create_note.

If the CURRENT user message clearly requests information from an existing note:
→ search_notes.

If the CURRENT user message clearly requests a modification to an existing note:
→ search_notes first, then update_note.

If the CURRENT user message clearly requests a reminder:
→ create_reminder.

If the CURRENT user message clearly asks about events, appointments, meetings,
or the user's schedule:
→ search_calendar.

If the CURRENT user message clearly requests a new calendar event:
→ create_calendar_event.

If the CURRENT user message clearly requests a modification, move, or rescheduling
of an existing calendar event:
→ search_calendar first if the exact event is not already known, then
  edit_calendar_event.

If the CURRENT user message clearly requests deletion of an existing calendar event:
→ search_calendar first if the exact event is not already known, then
  delete_calendar_event.

For calendar creation or modification, always respect the calendar conflict rules.
Do not use force=true unless the user has explicitly confirmed that the conflicting
operation should proceed.

Do not use an unrelated tool because of something mentioned in older conversation.

If no tool applies:
→ answer normally.

--------------------------------------------------
USER CONTEXT
--------------------------------------------------

${factsBlock}

${summaryBlock}
`;
}

// ------------------------------------------------------------
// Convert memory messages into OpenAI-compatible chat messages
// ------------------------------------------------------------

function shortTermToContents(
  shortTerm
) {
  return shortTerm
    .filter((message) => {
      if (
        message.role !== "model"
      ) {
        return true;
      }

      const text =
        String(message.text || "")
          .toLowerCase();

      const reminderPatterns = [
        "reminder",
        "remind you",
        "remind me",
        "scheduled",
        "schedule",
        "⏰",
      ];

      return !reminderPatterns.some(
        (pattern) =>
          text.includes(pattern)
      );
    })
    .map((message) => ({
      role: message.role === "model" ? "assistant" : "user",
      content: String(message.text || ""),
    }));
}

// ------------------------------------------------------------
// Handle incoming WhatsApp message
// ------------------------------------------------------------

async function handleMessage(
  userId,
  userText
) {
  // Save user's message first.
  memory.addMessage(
    userId,
    "user",
    userText
  );

  const completedActions = [];

  try {
    const pendingAction = pending.get(userId);
    if (pendingAction && userText === "calendar_move_existing") {
      const result = await resolveCalendarConflict(userId, "existing");
      const reply = result?.success
        ? result.message
        : result?.message || "I couldn't move the conflicting event safely.";
      memory.addMessage(userId, "model", reply);
      return reply;
    }
    if (pendingAction && userText === "calendar_move_requested") {
      const result = await resolveCalendarConflict(userId, "requested");
      const reply = result?.success
        ? result.message
        : result?.message || "I couldn't move the new event safely.";
      memory.addMessage(userId, "model", reply);
      return reply;
    }
    if (pendingAction && isExplicitCancellation(userText)) {
      pending.clear(userId);
      const cancellationText = "Okay, I left the conflicting calendar action unchanged.";
      memory.addMessage(userId, "model", cancellationText);
      return cancellationText;
    }

    const longTerm =
      memory.getLongTerm(userId);

    const shortTerm =
      memory.getShortTerm(userId);

    const contents =
      shortTermToContents(shortTerm);

    // --------------------------------------------------------
    // Explicit current-message context
    // --------------------------------------------------------

    const currentMessageContent = {
      role: "user",
      content: `
CURRENT USER MESSAGE — THIS IS THE MESSAGE YOU MUST ACT ON:

"${userText}"

${pendingAction?.conflicts ? `There is a pending calendar conflict from the previous turn. The user must choose which event to move, then provide a new time. Pending requested event: ${pendingAction.args?.name || "new event"}. Conflicting events: ${pendingAction.conflicts.map((event) => event.name).join(", ")}. Do not create or move anything until the user chooses.` : ""}

IMPORTANT:
Only create a reminder or note based on this current message.
Do not reuse action content from older messages.
`,
    };

    /*
     * This is the conversation the model sees while handling
     * the current request.
     *
     * It grows when tools are called:
     *
     * user
     * -> model functionCall
     * -> function response
     * -> model functionCall
     * -> function response
     * -> model final answer
     */
    const conversationMessages = [
      { role: "system", content: buildSystemPrompt(longTerm) },
      ...contents,
      currentMessageContent,
    ];

    let result =
      await generateWithRetry({
        messages: conversationMessages,
        tools: toolDeclarations,
        tool_choice: "auto",
      });

    let replyText = "";
    let calendarConflictReply = null;

    let toolCallCount = 0;
    // --------------------------------------------------------
    // TOOL CALL LOOP
    // --------------------------------------------------------
    //
    // This is the important new part.
    //
    // The model can now do:
    //
    // search_notes
    // -> update_note
    // -> final answer
    //
    // instead of stopping after the first tool call.
    // --------------------------------------------------------

    while (
      toolCallCount < MAX_TOOL_CALLS
    ) {
      const functionCalls =
        getFunctionCalls(result);

      // ------------------------------------------------------
      // No more tools -> final answer
      // ------------------------------------------------------

      if (
        functionCalls.length === 0
      ) {
        replyText =
          getResponseText(result).trim();

        if (!replyText) {
          replyText = "Done.";
        }

        break;
      }

      // ------------------------------------------------------
      // Preserve the assistant message containing tool calls.
      // the functionCall.
      // ------------------------------------------------------

      const originalModelContent = result?.choices?.[0]?.message;

      if (!originalModelContent) {
        throw new Error(
          "The model returned a tool call but the assistant message was unavailable."
        );
      }

      conversationMessages.push(
        originalModelContent
      );

      // ------------------------------------------------------
      // Execute function calls
      // ------------------------------------------------------

      for (const call of functionCalls) {
        toolCallCount++;

        console.log(
          `[Tool] ${LLM_PROVIDER} requested: ${call.name}`,
          call.args
        );

        // ----------------------------------------------------
        // Safety validation
        // ----------------------------------------------------

        const validation =
          validateToolCall(
            call,
            userText
          );

        let toolResult;

        if (!validation.valid) {
          console.warn(
            `[Safety] Tool call rejected: ${validation.reason}`
          );

          toolResult = {
            success: false,
            error: validation.reason,
          };
        } else {
          try {
            toolResult =
              await callTool(
                call.name,
                call.args,
                userId
              );

            console.log(
              `[Tool] ${call.name} completed:`,
              toolResult
            );

            /*
             * Normalize simple string results.
             */
            if (
              typeof toolResult ===
              "string"
            ) {
              toolResult = {
                success: true,
                message: toolResult,
              };
            }

            if (
              toolResult?.success !== false &&
              [
                "create_note",
                "update_note",
                "create_reminder",
                "create_calendar_event",
                "edit_calendar_event",
                "delete_calendar_event",
              ].includes(call.name)
            ) {
              const message = toolResult?.message || String(toolResult);
              completedActions.push(message);
            }

            if (toolResult?.conflict === true) {
              calendarConflictReply = formatCalendarConflict(toolResult);
            }
          } catch (toolError) {
            console.error(
              `[Tool] ${call.name} failed:`,
              toolError
            );

            toolResult = {
              success: false,
              error:
                toolError?.message ||
                "The tool failed to execute.",
            };
          }
        }

        // ----------------------------------------------------
        // Send the result back to the model using the matching tool-call ID.
        // ----------------------------------------------------

        conversationMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(toolResult),
        });

        /*
         * Stop executing additional calls if we reached
         * the safety limit.
         */
        if (
          toolCallCount >=
          MAX_TOOL_CALLS
        ) {
          break;
        }

        if (calendarConflictReply) break;
      }

      if (calendarConflictReply) {
        replyText = calendarConflictReply;
        break;
      }

      // ------------------------------------------------------
      // If maximum number of tool calls was reached,
      // don't ask the model for another tool.
      // ------------------------------------------------------

      if (
        toolCallCount >=
        MAX_TOOL_CALLS
      ) {
        console.warn(
          `[${LLM_PROVIDER}] Maximum tool call limit (${MAX_TOOL_CALLS}) reached.`
        );

        replyText =
          "Je n'ai pas pu terminer cette action.";

        break;
      }

      // ------------------------------------------------------
      // Ask the model what to do next.
      //
      // This is where:
      //
      // search_notes -> update_note
      //
      // becomes possible.
      // ------------------------------------------------------

      result =
        await generateWithRetry({
          messages: conversationMessages,
          tools: toolDeclarations,
          tool_choice: "auto",
        });
    }

    // --------------------------------------------------------
    // Save assistant response
    // --------------------------------------------------------

    if (completedActions.length > 0) {
      const receiptLines = completedActions
        .filter(Boolean)
        .map((message) => `✅ ${message}`)
        .join("\n");
      replyText = `${replyText}\n\n${receiptLines}`.trim();
    }

    memory.addMessage(
      userId,
      "model",
      replyText
    );

    // --------------------------------------------------------
    // Background long-term memory refresh
    // --------------------------------------------------------

    const updatedShortTerm =
      memory.getShortTerm(userId);

    if (
      updatedShortTerm.length % 6 === 0
    ) {
      refreshLongTermMemory(
        userId
      ).catch((err) => {
        console.error(
          "[Memory] Background refresh failed:",
          err
        );
      });
    }

    return replyText;
  } catch (err) {
    const status =
      getErrorStatus(err);

    console.error(
      `[handleMessage] ${LLM_PROVIDER} request failed (${
        status || "unknown"
      }):`,
      err
    );

    if (completedActions.length > 0) {
      return `I completed these actions, but couldn't finish the response:\n${completedActions
        .map((message) => `✅ ${message}`)
        .join("\n")}`;
    }

    if (
      RETRYABLE_STATUS_CODES.has(status)
    ) {
      return "I'm having a temporary issue connecting to the AI service. Please try again in a moment.";
    }

    if (status === 400) {
      console.error(
        `[${LLM_PROVIDER}] The request was rejected as invalid.`
      );

      return "I couldn't process that request correctly. Please try again.";
    }

    return "Sorry, something went wrong while processing that.";
  }
}

function isExplicitCancellation(text) {
  return /^(no|n|non|cancel|cancelled|calendar_cancel|never mind|nevermind)$/i
    .test(String(text || "").trim());
}

function formatCalendarConflict(result) {
  const requested = result.requestedEvent || {};
  const conflicts = result.conflictingEvents || result.conflicts || [];
  const formatTime = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || "unknown time");
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: USER_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  };
  const describe = (event) => `${event.name || "Unnamed event"} from ${formatTime(event.date || event.startDate)}–${formatTime(event.endDate)}`;
  const requestedText = `${requested.name || "This event"} at ${formatTime(requested.startDate)}–${formatTime(requested.endDate)}`;
  if (conflicts.length === 0) return `${requestedText} conflicts with an existing event. Which event would you like me to move?`;
  return `${requestedText} conflicts with ${conflicts.map(describe).join(" and ")}. Which event would you like me to move — the existing event or ${requested.name || "the new event"}?`;
}

// ------------------------------------------------------------
// Long-term memory refresh
// ------------------------------------------------------------

async function refreshLongTermMemory(
  userId
) {
  try {
    const shortTerm =
      memory.getShortTerm(userId);

    const longTerm =
      memory.getLongTerm(userId);

    const transcript = shortTerm
      .map(
        (message) =>
          `${message.role}: ${message.text}`
      )
      .join("\n");

    const prompt = `
Update the user's long-term profile based on the existing profile and recent conversation.

Existing summary:
${longTerm.summary || "(none)"}

Existing facts:
${
  longTerm.facts.join(", ") ||
  "(none)"
}

Recent conversation:
${transcript}

Rules:
- Keep only useful long-term information.
- Do not invent facts.
- Do not store temporary conversation details as permanent facts.
- Do not store individual reminder messages as permanent facts unless they reveal a genuinely useful long-term preference.
- Keep the summary to 1-3 sentences.
- Facts should be short and useful.
- Return ONLY valid JSON.

Required format:
{
  "summary": "1-3 sentence updated summary",
  "facts": ["short fact 1", "short fact 2"]
}
`;

    const result =
      await generateWithRetry({
        messages: [
          { role: "system", content: "You update a personal-assistant memory profile. Return only valid JSON." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      });

    const resultText =
      getResponseText(result);

    if (!resultText) {
      throw new Error(
        "The model returned an empty response while refreshing memory."
      );
    }

    const cleanedText =
      resultText
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

    const parsed =
      JSON.parse(cleanedText);

    if (
      typeof parsed.summary !==
        "string" ||
      !Array.isArray(parsed.facts)
    ) {
      throw new Error(
        "Invalid long-term memory response shape."
      );
    }

    memory.updateLongTerm(
      userId,
      parsed
    );

    console.log(
      `[Memory] Long-term memory refreshed for ${userId}`
    );
  } catch (err) {
    console.error(
      "[Memory] Failed to refresh long-term memory:",
      err
    );
  }
}

// ------------------------------------------------------------
// Export
// ------------------------------------------------------------

module.exports = {
  handleMessage,
};
