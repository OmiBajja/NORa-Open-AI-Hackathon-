const fs = require("fs");
const path = require("path");
const { sendMessage } = require("../../whatsapp/client");
const { readJson, atomicWriteJson } = require("../persistence");
const { isOwnerPhone } = require("../webhook");

const REMINDERS_PATH = path.join(
  __dirname,
  "..",
  "..",
  "data",
  "reminders.json"
);

function loadReminders() {
  const reminders = readJson(REMINDERS_PATH, []);
  if (!Array.isArray(reminders)) {
    throw new Error("Reminder persistence must contain an array.");
  }
  return reminders;
}

function saveReminders(reminders) {
  atomicWriteJson(REMINDERS_PATH, reminders);
}

const schema = {
  name: "create_reminder",
  description:
    "Create a persistent reminder when the user explicitly asks to be reminded of something. The reminder must contain the user's intended message and an absolute ISO 8601 date/time.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "What to remind the user about",
      },
      scheduledFor: {
        type: "string",
        description:
          "When the reminder should fire, as an ISO 8601 datetime.",
      },
    },
    required: ["message", "scheduledFor"],
  },
};

async function execute({ message, scheduledFor }, userId) {
  if (!isOwnerPhone(userId)) {
    const error = new Error("This personal assistant is restricted to its configured owner.");
    error.code = "UNAUTHORIZED_OWNER";
    throw error;
  }

  const date = new Date(scheduledFor);

  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `Invalid reminder date: ${scheduledFor}`
    );
  }

  if (date.getTime() <= Date.now()) {
    throw new Error(
      "Reminder time must be in the future."
    );
  }

  const reminders = loadReminders();

  const reminder = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId,
    message,
    scheduledFor: date.toISOString(),
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  reminders.push(reminder);

  saveReminders(reminders);

  console.log(
    `⏰ Reminder created: ${reminder.id}`
  );

  return `Okay, I'll remind you about "${message}" at ${date.toLocaleString()}.`;
}

async function processDueReminders() {
  return processDueRemindersWith({ send: sendMessage, now: Date.now() });
}

let schedulerRunning = false;

async function processDueRemindersWith({
  send,
  now = Date.now(),
  load = loadReminders,
  save = saveReminders,
  ownerCheck = isOwnerPhone,
}) {
  if (schedulerRunning) return { skipped: true, sent: 0 };
  schedulerRunning = true;
  let sent = 0;

  try {
    const loadState = load;
    const saveState = save;
    let reminders = loadState();
    const staleClaimCutoff = now - 5 * 60 * 1000;

    // Recover a claim left behind by a crashed process. A fresh "sending"
    // claim is never selected by a concurrent scheduler tick.
    reminders = reminders.map((reminder) => {
      if (
        reminder.status === "sending" &&
        new Date(reminder.claimedAt || 0).getTime() < staleClaimCutoff
      ) {
        return { ...reminder, status: "pending" };
      }
      return reminder;
    });
    saveState(reminders);

    for (const candidate of reminders) {
      if (!ownerCheck(candidate.userId)) {
        const unauthorized = reminders.find((item) => item.id === candidate.id);
        if (unauthorized && unauthorized.status === "pending") {
          unauthorized.status = "failed";
          unauthorized.failureReason = "Reminder recipient is not the configured owner";
          saveState(reminders);
        }
        continue;
      }

      const scheduledTime = new Date(candidate.scheduledFor).getTime();
      const nextAttempt = candidate.nextAttemptAt
        ? new Date(candidate.nextAttemptAt).getTime()
        : 0;

      if (
        candidate.status !== "pending" ||
        Number.isNaN(scheduledTime) ||
        scheduledTime > now ||
        nextAttempt > now
      ) {
        if (candidate.status === "pending" && Number.isNaN(scheduledTime)) {
          const invalid = reminders.find((item) => item.id === candidate.id);
          invalid.status = "failed";
          invalid.failureReason = "Invalid reminder date";
          saveState(reminders);
        }
        continue;
      }

      const live = loadState();
      const reminder = live.find((item) => item.id === candidate.id);
      if (!reminder || reminder.status !== "pending") continue;

      reminder.status = "sending";
      reminder.attempts = (reminder.attempts || 0) + 1;
      reminder.claimedAt = new Date(now).toISOString();
      saveState(live);

      try {
        await send(reminder.userId, `⏰ Reminder: ${reminder.message}`);
        const completed = loadState();
        const sentReminder = completed.find((item) => item.id === reminder.id);
        if (sentReminder) {
          sentReminder.status = "sent";
          sentReminder.sentAt = new Date().toISOString();
          delete sentReminder.claimedAt;
          saveState(completed);
        }
        sent += 1;
      } catch (error) {
        const failed = loadState();
        const failedReminder = failed.find((item) => item.id === reminder.id);
        if (!failedReminder) continue;

        const attempts = failedReminder.attempts || 1;
        if (attempts >= 3) {
          failedReminder.status = "failed";
          failedReminder.failureReason = error?.message || "Delivery failed";
          failedReminder.failedAt = new Date().toISOString();
        } else {
          failedReminder.status = "pending";
          failedReminder.nextAttemptAt = new Date(
            now + Math.min(60_000 * 2 ** (attempts - 1), 15 * 60_000)
          ).toISOString();
        }
        saveState(failed);
        console.error(`❌ Failed to send reminder ${reminder.id}:`, error);
      }
    }
  } finally {
    schedulerRunning = false;
  }

  return { skipped: false, sent };
}

function startReminderScheduler() {
  console.log("⏰ Reminder scheduler started.");

  // Check immediately when the server starts.
  processDueReminders().catch((err) => {
    console.error(
      "Reminder scheduler error:",
      err
    );
  });

  // Then check every 10 seconds.
  setInterval(() => {
    processDueReminders().catch((err) => {
      console.error(
        "Reminder scheduler error:",
        err
      );
    });
  }, 10_000);
}

module.exports = {
  schema,
  execute,
  startReminderScheduler,
  processDueRemindersWith,
  loadReminders,
  saveReminders,
  REMINDERS_PATH,
};
