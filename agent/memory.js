const fs = require("fs");
const path = require("path");
const { atomicWriteJson } = require("./persistence");

const DB_PATH = path.join(__dirname, "..", "data", "memory.json");
const SHORT_TERM_LIMIT = 12; // last N messages kept verbatim per user

function loadDB() {
  if (!fs.existsSync(DB_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } catch (error) {
    const wrapped = new Error("Conversation memory is corrupted and was not replaced.");
    wrapped.code = "CORRUPT_PERSISTENCE";
    wrapped.cause = error;
    throw wrapped;
  }
}

function saveDB(db) {
  atomicWriteJson(DB_PATH, db);
}

function getUser(userId) {
  const db = loadDB();
  if (!db[userId]) {
    db[userId] = {
      shortTerm: [],       // [{ role: "user"|"model", text, ts }]
      longTerm: {
        summary: "",        // rolling narrative summary
        facts: [],           // discrete facts: ["prefers concise replies", ...]
      },
    };
    saveDB(db);
  }
  return db[userId];
}

function addMessage(userId, role, text) {
  const db = loadDB();
  const user = db[userId] || getUser(userId);
  user.shortTerm.push({ role, text, ts: Date.now() });
  if (user.shortTerm.length > SHORT_TERM_LIMIT) {
    user.shortTerm = user.shortTerm.slice(-SHORT_TERM_LIMIT);
  }
  db[userId] = user;
  saveDB(db);
}

function getShortTerm(userId) {
  return getUser(userId).shortTerm;
}

function getLongTerm(userId) {
  return getUser(userId).longTerm;
}

function updateLongTerm(userId, { summary, facts }) {
  const db = loadDB();
  const user = db[userId] || getUser(userId);
  if (summary) user.longTerm.summary = summary;
  if (facts && facts.length) {
    // merge, dedupe
    const merged = new Set([...user.longTerm.facts, ...facts]);
    user.longTerm.facts = Array.from(merged);
  }
  db[userId] = user;
  saveDB(db);
}

module.exports = {
  addMessage,
  getShortTerm,
  getLongTerm,
  updateLongTerm,
};
