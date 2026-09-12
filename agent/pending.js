const path = require("path");
const { readJson, atomicWriteJson } = require("./persistence");

const PENDING_PATH = path.join(__dirname, "..", "data", "pending_actions.json");
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function load() {
  const value = readJson(PENDING_PATH, {});
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pending action state must be an object.");
  }
  return value;
}

function save(value) {
  atomicWriteJson(PENDING_PATH, value);
}

function create(userId, action, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  if (!userId) throw new Error("userId is required for a pending action.");
  const state = load();
  state[userId] = {
    ...action,
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  save(state);
  return state[userId];
}

function get(userId, now = Date.now()) {
  const state = load();
  const action = state[userId];
  if (!action) return null;

  if (!action.expiresAt || new Date(action.expiresAt).getTime() <= now) {
    delete state[userId];
    save(state);
    return null;
  }

  return action;
}

function clear(userId) {
  const state = load();
  if (!state[userId]) return;
  delete state[userId];
  save(state);
}

module.exports = {
  create,
  get,
  clear,
  DEFAULT_TTL_MS,
  PENDING_PATH,
};
