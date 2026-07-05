const fs = require("fs");
const path = require("path");

const HEARTBEAT_FILE = path.join(__dirname, "data", "heartbeat.json");
const EVENTS_FILE = path.join(__dirname, "data", "events.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getHeartbeat() {
  return readJson(HEARTBEAT_FILE, null);
}
function saveHeartbeat(hb) {
  writeJson(HEARTBEAT_FILE, hb);
}
function getEvents() {
  return readJson(EVENTS_FILE, []);
}
function pushEvents(newEvents) {
  if (!newEvents || !newEvents.length) return;
  const events = getEvents();
  events.push(...newEvents);
  writeJson(EVENTS_FILE, events.slice(-500)); // 최근 500개만 보관
}

module.exports = { getHeartbeat, saveHeartbeat, getEvents, pushEvents };
