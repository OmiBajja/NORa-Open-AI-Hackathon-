const crypto = require("crypto");
const path = require("path");
const { readJson, atomicWriteJson } = require("./persistence");

const PROCESSED_PATH = path.join(__dirname, "..", "data", "processed_messages.json");
const MAX_PROCESSED_MESSAGES = 10_000;

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function isOwnerPhone(phone, configuredOwner = process.env.WHATSAPP_OWNER_PHONE) {
  const actual = normalizePhone(phone);
  const allowed = String(configuredOwner || "")
    .split(",")
    .map(normalizePhone)
    .filter(Boolean);
  return Boolean(actual && allowed.includes(actual));
}

function verifySignature(rawBody, signature, appSecret = process.env.WHATSAPP_APP_SECRET) {
  if (!rawBody || !signature || !appSecret) return false;
  const expected = `sha256=${crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex")}`;

  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(String(signature), "utf8");
  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function claimMessage(messageId, now = Date.now()) {
  if (!messageId) throw new Error("A WhatsApp message ID is required.");
  const state = readJson(PROCESSED_PATH, { messages: {} });
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Processed-message state must be an object.");
  }
  if (!state.messages || typeof state.messages !== "object" || Array.isArray(state.messages)) {
    throw new Error("Processed-message state is malformed.");
  }

  if (state.messages[messageId]) return false;
  state.messages[messageId] = {
    status: "claimed",
    claimedAt: new Date(now).toISOString(),
  };

  const ids = Object.keys(state.messages);
  if (ids.length > MAX_PROCESSED_MESSAGES) {
    ids
      .sort((a, b) => new Date(state.messages[a].claimedAt) - new Date(state.messages[b].claimedAt))
      .slice(0, ids.length - MAX_PROCESSED_MESSAGES)
      .forEach((id) => delete state.messages[id]);
  }

  atomicWriteJson(PROCESSED_PATH, state);
  return true;
}

module.exports = {
  normalizePhone,
  isOwnerPhone,
  verifySignature,
  claimMessage,
  PROCESSED_PATH,
};
