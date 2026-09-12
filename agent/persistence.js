const fs = require("fs");
const path = require("path");

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;

  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const wrapped = new Error(`Invalid JSON in ${filePath}`);
    wrapped.code = "CORRUPT_PERSISTENCE";
    wrapped.cause = error;
    throw wrapped;
  }
}

function atomicWriteJson(filePath, value) {
  ensureParent(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;

  try {
    fs.writeFileSync(temporaryPath, content, "utf8");
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

function withTimeout(promise, timeoutMs, label = "External operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      error.status = 504;
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = {
  readJson,
  atomicWriteJson,
  withTimeout,
};
