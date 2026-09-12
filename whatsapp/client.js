const fs = require("fs");
const path = require("path");

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const META_TIMEOUT_MS = Number(process.env.META_TIMEOUT_MS || 15000);

async function fetchWithTimeout(url, options = {}, timeoutMs = META_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`Meta request timed out after ${timeoutMs}ms`);
      timeoutError.code = "ETIMEDOUT";
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function sendMessage(to, text) {
  const res = await fetchWithTimeout(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    }
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`WhatsApp send failed: ${res.status} ${errBody}`);
  }

  return res.json();
}

async function sendInteractiveButtons(to, bodyText, buttons) {
  const res = await fetchWithTimeout(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.slice(0, 3).map((button) => ({
              type: "reply",
              reply: {
                id: button.id,
                title: button.title,
              },
            })),
          },
        },
      }),
    }
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`WhatsApp interactive send failed: ${res.status} ${errBody}`);
  }

  return res.json();
}

async function getMediaUrl(mediaId) {
  const res = await fetchWithTimeout(
    `https://graph.facebook.com/v21.0/${mediaId}`,
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    }
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`WhatsApp media lookup failed: ${res.status} ${errBody}`);
  }

  const data = await res.json();

  if (!data.url) {
    throw new Error("WhatsApp media response did not contain a URL.");
  }

  return data.url;
}

async function downloadMedia(mediaId, outputPath) {
  const mediaUrl = await getMediaUrl(mediaId);

  const res = await fetchWithTimeout(mediaUrl, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(
      `WhatsApp media download failed: ${res.status} ${errBody}`
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  await fs.promises.mkdir(path.dirname(outputPath), {
    recursive: true,
  });

  await fs.promises.writeFile(outputPath, buffer);

  return outputPath;
}

module.exports = {
  sendMessage,
  sendInteractiveButtons,
  getMediaUrl,
  downloadMedia,
  fetchWithTimeout,
};
