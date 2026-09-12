const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");

const {
  verifySignature,
  isOwnerPhone,
} = require("../agent/webhook");
const {
  processWebhookPayload,
  processIncomingMessage,
  missingConfiguration,
} = require("../index");

test("verifies Meta webhook signatures with HMAC", () => {
  const body = Buffer.from('{"hello":"world"}');
  const secret = "test-secret";
  const digest = crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifySignature(body, `sha256=${digest}`, secret), true);
  assert.equal(verifySignature(body, "sha256=bad", secret), false);
  assert.equal(verifySignature(body, `sha256=${digest}`, "wrong"), false);
});

test("authorizes only the configured owner phone", () => {
  assert.equal(isOwnerPhone("+33 6 12 34 56 78", "+33612345678"), true);
  assert.equal(isOwnerPhone("+33600000000", "+33612345678"), false);
});

test("processes webhook batches and deduplicates message IDs", async () => {
  const handled = [];
  const sent = [];
  const claimed = new Set();
  const message = {
    id: "wamid-1",
    from: "33612345678",
    type: "text",
    text: { body: "save this" },
  };
  const body = {
    entry: [
      { changes: [{ value: { messages: [message] } }] },
      { changes: [{ value: { messages: [{ ...message, id: "wamid-2", text: { body: "and this" } }] } }] },
    ],
  };

  const dependencies = {
    isOwnerPhone: () => true,
    claimMessage: (id) => !claimed.has(id) && (claimed.add(id), true),
    handleMessage: async (_from, text) => (handled.push(text), `ok:${text}`),
    sendMessage: async (_from, text) => sent.push(text),
  };

  const first = await processWebhookPayload(body, dependencies);
  const second = await processWebhookPayload(body, dependencies);
  assert.deepEqual(handled, ["save this", "and this"]);
  assert.deepEqual(sent, ["ok:save this", "ok:and this"]);
  assert.deepEqual(first.map((item) => item.status), ["processed", "processed"]);
  assert.deepEqual(second.map((item) => item.status), ["duplicate", "duplicate"]);
});

test("surfaces agent failures to the owner without exposing stack traces", async () => {
  const sent = [];
  const result = await processIncomingMessage(
    {
      id: "wamid-failure",
      from: "33612345678",
      type: "text",
      text: { body: "do it" },
    },
    {
      isOwnerPhone: () => true,
      claimMessage: () => true,
      handleMessage: async () => { throw new Error("secret stack detail"); },
      sendMessage: async (_from, text) => sent.push(text),
    }
  );
  assert.equal(result.status, "failed");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /couldn’t complete/i);
  assert.doesNotMatch(sent[0], /secret stack detail/i);
});

test("startup validation reports missing critical configuration", () => {
  const missing = missingConfiguration({});
  assert.ok(missing.includes("WHATSAPP_APP_SECRET"));
  assert.ok(missing.includes("WHATSAPP_OWNER_PHONE"));
  assert.ok(missing.includes("OPENAI_API_KEY"));

  const routerMissing = missingConfiguration({ LLM_PROVIDER: "openrouter" });
  assert.ok(routerMissing.includes("OPENROUTER_API_KEY"));
});
