require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const ngrok = require("@ngrok/ngrok");
const fs = require("fs");
const path = require("path");

const { handleMessage } = require("./agent/core");
const {
  sendMessage,
  sendInteractiveButtons,
  downloadMedia,
} = require("./whatsapp/client");
const { transcribeAudio } = require("./agent/transcription");
const { startReminderScheduler } = require("./agent/tools/reminders");
const { isOwnerPhone, verifySignature, claimMessage } = require("./agent/webhook");
const pending = require("./agent/pending");

const app = express();
app.use(express.json({
  verify: (request, _response, buffer) => {
    request.rawBody = Buffer.from(buffer);
  },
}));

const PORT = Number(process.env.PORT || 8085);
const REQUIRED_ENVIRONMENT = [
  "VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_OWNER_PHONE",
  "GROQ_API_KEY",
  "NOTION_API_TOKEN",
  "NOTION_PARENT_PAGE_ID",
  "NOTION_CALENDAR_DATA_SOURCE_ID",
];

function missingConfiguration(environment = process.env) {
  const missing = REQUIRED_ENVIRONMENT.filter((key) => !environment[key]);
  const provider = environment.LLM_PROVIDER ||
    (environment.OPENROUTER_API_KEY ? "openrouter" : "openai");
  if (provider === "openrouter" && !environment.OPENROUTER_API_KEY) {
    missing.push("OPENROUTER_API_KEY");
  }
  if (provider === "openai" && !environment.OPENAI_API_KEY) {
    missing.push("OPENAI_API_KEY");
  }
  return missing;
}

function messageKey(message) {
  if (message?.id) return message.id;
  return crypto.createHash("sha256").update(JSON.stringify(message || {})).digest("hex");
}

async function sendRecoveryMessage(to, text, send = sendMessage) {
  try {
    await send(to, text);
  } catch (error) {
    console.error(`[WhatsApp] Failed to send recovery message to ${to}:`, error);
  }
}

async function sendAgentReply(to, reply, send, sendInteractive) {
  let pendingAction = null;
  try {
    pendingAction = pending.get(to);
  } catch (error) {
    console.error("[Pending] Failed to read pending action:", error);
  }

  if (
    pendingAction &&
    sendInteractive &&
    pendingAction.tool?.includes("calendar") &&
    /conflict|overlap|already scheduled|existing event|conflit/i.test(String(reply || ""))
  ) {
    const existingName = pendingAction.conflicts?.length === 1
      ? String(pendingAction.conflicts[0].name || "existing event")
      : "existing event";
    const requestedName = String(pendingAction.args?.name || "new event");
    const title = (name) => `Move ${name}`.slice(0, 20);
    try {
      await sendInteractive(to, reply, [
        { id: "calendar_move_existing", title: title(existingName) },
        { id: "calendar_move_requested", title: title(requestedName) },
        { id: "calendar_cancel", title: "Cancel" },
      ]);
      return;
    } catch (error) {
      console.error("[WhatsApp] Interactive send failed; falling back to text:", error);
    }
  }
  await send(to, reply);
}

async function processIncomingMessage(message, dependencies = {}) {
  const agent = dependencies.handleMessage || handleMessage;
  const send = dependencies.sendMessage || sendMessage;
  const download = dependencies.downloadMedia || downloadMedia;
  const transcribe = dependencies.transcribeAudio || transcribeAudio;
  const sendInteractive = dependencies.sendInteractiveButtons || sendInteractiveButtons;
  const claim = dependencies.claimMessage || claimMessage;
  const ownerCheck = dependencies.isOwnerPhone || isOwnerPhone;
  const from = message?.from;

  if (!from || !ownerCheck(from, dependencies.ownerPhone)) {
    console.warn(`[Security] Ignoring WhatsApp message from unauthorized sender ${from || "unknown"}.`);
    return { status: "unauthorized" };
  }

  const id = messageKey(message);
  if (!claim(id)) {
    console.log(`[Webhook] Ignoring duplicate WhatsApp message ${id}.`);
    return { status: "duplicate" };
  }

  try {
    if (message.type === "text") {
      const userText = message.text?.body?.trim();
      if (!userText) return { status: "empty" };
      console.log(`📩 ${from}: ${userText}`);
      const reply = await agent(from, userText);
      console.log(`🤖 Reply: ${reply}`);
      await sendAgentReply(from, reply, send, sendInteractive);
      return { status: "processed", reply };
    }

    if (message.type === "interactive") {
      const buttonId = message.interactive?.button_reply?.id;
      if (!buttonId) return { status: "empty" };
      const reply = await agent(from, buttonId);
      await sendAgentReply(from, reply, send, sendInteractive);
      return { status: "processed", reply };
    }

    if (message.type === "audio") {
      const mediaId = message.audio?.id;
      if (!mediaId) {
        await sendRecoveryMessage(from, "I couldn’t read that voice note. Please send it again or type the request.", send);
        return { status: "invalid_audio" };
      }

      const audioDir = path.join(__dirname, "data", "audio");
      await fs.promises.mkdir(audioDir, { recursive: true });
      const extension = message.audio?.mime_type?.includes("mp4") ? "m4a" : "ogg";
      const filePath = path.join(audioDir, `${mediaId}.${extension}`);

      try {
        console.log(`🎤 ${from}: receiving voice message ${mediaId}`);
        try {
          await send(from, "🎤 I’m transcribing your voice note and taking care of it…");
        } catch (feedbackError) {
          console.error("[Voice] Could not send processing acknowledgement:", feedbackError);
        }
        await download(mediaId, filePath);
        const transcript = await transcribe(filePath);
        const reply = await agent(from, transcript);
        console.log(`🤖 Reply: ${reply}`);
        await sendAgentReply(from, reply, send, sendInteractive);
        return { status: "processed", transcript, reply };
      } catch (error) {
        console.error(`[Voice] Failed to process ${mediaId}:`, error);
        await sendRecoveryMessage(from, "I couldn’t process that voice note. Please try recording it again, or send the request as text.", send);
        return { status: "voice_failed" };
      } finally {
        try {
          await fs.promises.unlink(filePath);
        } catch {
          // The file may not have been created.
        }
      }
    }

    console.log(`ℹ️ Ignoring unsupported message type: ${message.type}`);
    return { status: "unsupported" };
  } catch (error) {
    console.error(`[Webhook] Failed to process message ${id}:`, error);
    await sendRecoveryMessage(from, "I couldn’t complete that request. Nothing was confirmed as completed; please try again.", send);
    return { status: "failed" };
  }
}

async function processWebhookPayload(body, dependencies = {}) {
  const messages = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      for (const message of change?.value?.messages || []) messages.push(message);
    }
  }

  const results = [];
  for (const message of messages) {
    results.push(await processIncomingMessage(message, dependencies));
  }
  return results;
}

app.get("/", (_request, response) => {
  response.send("WhatsApp AI backend is running!");
});

app.get("/webhook", (request, response) => {
  const mode = request.query["hub.mode"];
  const token = request.query["hub.verify_token"];
  const challenge = request.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return response.status(200).send(challenge);
  }
  return response.sendStatus(403);
});

app.post("/webhook", (request, response) => {
  const signature = request.get("X-Hub-Signature-256");
  if (!verifySignature(request.rawBody, signature)) {
    console.warn("[Security] Rejected webhook with invalid signature.");
    return response.sendStatus(401);
  }

  response.sendStatus(200);
  processWebhookPayload(request.body).catch((error) => {
    console.error("[Webhook] Background processing failed:", error);
  });
});

async function startServer() {
  const missing = missingConfiguration();
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  app.listen(PORT, async () => {
    console.log(`Local server: http://localhost:${PORT}`);
    startReminderScheduler();
    console.log("⏰ Persistent reminder system is active.");

    try {
      const forwarder = await ngrok.forward({
        addr: `localhost:${PORT}`,
        domain: process.env.NGROK_DOMAIN,
        authtoken_from_env: true,
      });
      console.log(`Public URL: ${forwarder.url()}`);
    } catch (error) {
      console.error("❌ Failed to start ngrok:", error?.message || error);
    }
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(`❌ Startup configuration failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  missingConfiguration,
  messageKey,
  processIncomingMessage,
  processWebhookPayload,
  sendRecoveryMessage,
  startServer,
};
