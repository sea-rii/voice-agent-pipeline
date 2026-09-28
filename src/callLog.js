const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'call-logs');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Twilio Call SIDs are always "CA" + 32 hex characters. Anything else is
// rejected, so a request can never write files outside call-logs/.
const CALL_SID_PATTERN = /^CA[0-9a-f]{32}$/i;

function isValidCallSid(callSid) {
  return typeof callSid === 'string' && CALL_SID_PATTERN.test(callSid);
}

function filePathFor(callSid) {
  if (!isValidCallSid(callSid)) throw new Error(`Invalid CallSid: ${callSid}`);
  return path.join(LOG_DIR, `${callSid}.json`);
}

/**
 * Merges `data` into whatever's already stored for this call (or creates a
 * new record). Safe to call multiple times as different pieces arrive — the
 * transcript is known when the call ends, the recording URL a few seconds later.
 * Returns the merged record, or null if the CallSid is invalid.
 */
function saveCallLog(callSid, data) {
  if (!isValidCallSid(callSid)) {
    console.warn('[CALLLOG] Refusing to save log for invalid CallSid:', callSid);
    return null;
  }

  const filePath = filePathFor(callSid);
  let existing = {};

  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      existing = {};
    }
  }

  const merged = { ...existing, ...data, callSid, updatedAt: new Date().toISOString() };
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));
  return merged;
}

function loadCallLog(callSid) {
  if (!isValidCallSid(callSid)) return null;
  const filePath = filePathFor(callSid);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadAllCallLogs() {
  return fs
    .readdirSync(LOG_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(LOG_DIR, f), 'utf8'));
      } catch {
        return null; // skip corrupted files instead of crashing
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

module.exports = { saveCallLog, loadCallLog, loadAllCallLogs, isValidCallSid };