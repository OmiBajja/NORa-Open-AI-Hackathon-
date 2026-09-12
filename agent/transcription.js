const fs = require("fs");
const Groq = require("groq-sdk");
const { withTimeout } = require("./persistence");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

async function transcribeAudio(filePath, language = null) {
  console.log(`[Transcription] Transcribing ${filePath}`);

  const transcription = await withTimeout(
    groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-large-v3-turbo",
      response_format: "json",
      ...(language ? { language } : {}),
      temperature: 0,
    }),
    Number(process.env.GROQ_TIMEOUT_MS || 30000),
    "Groq transcription"
  );

  const text = transcription.text?.trim();

  if (!text) {
    throw new Error("Groq returned an empty transcription.");
  }

  console.log(`[Transcription] "${text}"`);

  return text;
}

module.exports = {
  transcribeAudio,
};
