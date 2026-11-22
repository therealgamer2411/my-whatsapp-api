const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(process.env.DATA_DIR || './data');
const file = path.join(dir, 'secretary-state.json');
fs.mkdirSync(dir, { recursive: true });

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      conversations: raw.conversations || {},
      leads: Array.isArray(raw.leads) ? raw.leads : [],
      seen: Array.isArray(raw.seen) ? raw.seen : []
    };
  } catch {
    return { conversations: {}, leads: [], seen: [] };
  }
}

const state = load();
let timer;

function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      const temp = file + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) {
      console.error('[storage] save failed:', error.message);
    }
  }, 100);
}

function conversation(chatId) {
  if (!state.conversations[chatId]) {
    state.conversations[chatId] = {
      messages: [], paused: false, handedOff: false,
      pauseReason: null, pausedUntil: null, customerName: null,
      updatedAt: new Date().toISOString()
    };
  }
  return state.conversations[chatId];
}

function addMessage(chatId, role, text) {
  const item = conversation(chatId);
  item.messages.push({ role, text: String(text || '').slice(0, 2500), at: new Date().toISOString() });
  item.messages = item.messages.slice(-Number(process.env.MAX_HISTORY_MESSAGES || 12));
  item.updatedAt = new Date().toISOString();
  save();
}

function seen(id) {
  return Boolean(id) && state.seen.includes(id);
}

function markSeen(id) {
  if (!id) return;
  state.seen.push(id);
  state.seen = state.seen.slice(-500);
  save();
}

function addLead(lead) {
  state.leads.push(lead);
  state.leads = state.leads.slice(-500);
  save();
}

function flush() {
  clearTimeout(timer);
  try {
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    console.error('[storage] flush failed:', error.message);
  }
}

module.exports = { state, conversation, addMessage, seen, markSeen, addLead, save, flush };
