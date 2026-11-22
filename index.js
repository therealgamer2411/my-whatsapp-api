'use strict';

require('dotenv').config({ path: process.env.ENV_FILE || '.env' });

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { state, conversation, addMessage, seen, markSeen, addLead, save, flush } = require('./store');
const { getDecision, normalizePhone, handoffMessage, explicitHandoff } = require('./secretary');
const { transcribeAudio, synthesizeVoiceNote } = require('./voice');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
let autoReply = String(process.env.AUTO_REPLY_ENABLED || 'false').toLowerCase() === 'true';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MANAGER_NAME = process.env.MANAGER_NAME || 'المستشار أحمد';
const MANAGER_ROLE = process.env.MANAGER_ROLE || 'مدير متابعة العملاء';
const TAKEOVER_MINUTES = Math.max(5, Number(process.env.MANUAL_TAKEOVER_MINUTES || 120));

let ready = false;
let latestQr = null;
let whatsappServiceEnabled = true;
let whatsappInitializing = false;
let whatsappLastError = null;
let whatsappOperationId = 0;
let whatsappInitPromise = null;
const queues = new Map();
const botOutbox = new Map();

function fingerprint(chatId, body) {
  return chatId + '|' + String(body || '').replace(/\s+/g, ' ').trim();
}

async function sendBotMessage(chatId, text) {
  if (!ready) throw new Error('WhatsApp is not connected.');
  const body = String(text || '').trim();
  if (!body) throw new Error('Message is empty.');
  botOutbox.set(fingerprint(chatId, body), Date.now() + 120000);
  return client.sendMessage(chatId, body);
}

async function sendBotVoiceNote(chatId, oggBuffer) {
  if (!ready) throw new Error('WhatsApp is not connected.');
  if (!Buffer.isBuffer(oggBuffer) || oggBuffer.length < 100) {
    throw new Error('Voice-note audio is empty or invalid.');
  }
  const media = new MessageMedia('audio/ogg', oggBuffer.toString('base64'), 'secretary-reply.ogg');
  botOutbox.set(fingerprint(chatId, '[voice-note]'), Date.now() + 120000);
  return client.sendMessage(chatId, media, { sendAudioAsVoice: true, sendSeen: true });
}

async function sendAssistantReply(chatId, text, incomingWasVoice, options = {}) {
  const mode = String(process.env.VOICE_REPLY_MODE || 'mirror').toLowerCase();
  const useVoice = mode === 'always' || (mode === 'mirror' && incomingWasVoice);
  if (useVoice) {
    try {
      const spokenText = options.spokenText || text;
      const audio = await synthesizeVoiceNote(spokenText);
      await sendBotVoiceNote(chatId, audio);
      const includeText = options.includeText === true ||
        String(process.env.VOICE_REPLY_INCLUDE_TEXT || 'false').toLowerCase() === 'true';
      if (includeText) await sendBotMessage(chatId, text);
      return { mode: 'voice' };
    } catch (error) {
      console.error('[Voice] Generation or send failed; falling back to text:', error.message);
    }
  }
  await sendBotMessage(chatId, text);
  return { mode: 'text' };
}

function safeTokenEqual(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function adminOnly(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'ADMIN_TOKEN is not configured.' });
  const header = req.headers.authorization || '';
  let token = '';
  if (header.startsWith('Bearer-UTF8 ')) {
    try {
      const encoded = header.slice('Bearer-UTF8 '.length);
      token = Buffer.from(encoded, 'base64').toString('utf8');
      // Reject malformed/non-canonical UTF-8 encodings rather than silently replacing bytes.
      if (Buffer.from(token, 'utf8').toString('base64') !== encoded) token = '';
    } catch { token = ''; }
  } else if (header.startsWith('Bearer ')) {
    token = header.slice(7);
  }
  if (!safeTokenEqual(ADMIN_TOKEN, token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function enqueue(chatId, task) {
  const previous = queues.get(chatId) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(chatId, next);
  return next.finally(() => {
    if (queues.get(chatId) === next) queues.delete(chatId);
  });
}

async function customerName(message) {
  try {
    const contact = await message.getContact();
    return contact.pushname || contact.name || contact.shortName || message._data?.notifyName || 'عميل';
  } catch {
    return message._data?.notifyName || 'عميل';
  }
}

async function processMessage(message) {
  if (!autoReply || !ready || !message || message.fromMe || message.isGroupMsg) return;
  const chatId = message.from;
  if (!chatId || String(chatId).endsWith('@g.us') || chatId === 'status@broadcast') return;
  if (!String(chatId).endsWith('@c.us') && !String(chatId).endsWith('@lid')) return;

  const messageId = message.id && (message.id._serialized || message.id.id);
  if (seen(messageId)) return;
  markSeen(messageId);

  const incomingWasVoice = ['ptt', 'audio'].includes(String(message.type || '').toLowerCase());
  let body = String(message.body || message.caption || '').trim();
  const current = conversation(chatId);

  if (current.paused || current.handedOff) {
    if (current.pausedUntil && Date.now() > new Date(current.pausedUntil).getTime()) {
      current.paused = false;
      current.handedOff = false;
      current.pauseReason = null;
      current.pausedUntil = null;
      save();
    } else {
      return;
    }
  }

  if (incomingWasVoice) {
    try {
      const media = await message.downloadMedia();
      body = await transcribeAudio(media);
      if (!body) throw new Error('The voice message did not contain recognizable speech.');
      console.log('[Voice] Incoming audio transcribed for ' + chatId);
    } catch (error) {
      console.error('[Voice] Transcription failed:', error.message);
      const retry = 'وصلتني الرسالة الصوتية، لكن لم أتمكن من فهمها بوضوح. ممكن حضرتك تعيد إرسالها أو تكتب لي المطلوب في رسالة؟';
      await sendBotMessage(chatId, retry);
      addMessage(chatId, 'assistant', retry);
      return;
    }
  }

  if (!body) {
    const answer = 'وصلني مرفق من حضرتك. ممكن تكتب لي المطلوب في رسالة نصية أو تبعت رسالة صوتية؟';
    await sendBotMessage(chatId, answer);
    addMessage(chatId, 'assistant', answer);
    return;
  }

  addMessage(chatId, 'user', incomingWasVoice ? '[رسالة صوتية مفرغة]: ' + body : body);
  current.customerName = current.customerName || await customerName(message);

  let decision;
  try {
    decision = await getDecision(body, current.messages);
  } catch (error) {
    console.error('[AI] Request failed:', error.message);
    decision = {
      handoff: explicitHandoff(body),
      reply: 'أعتذر لحضرتك، حصلت مشكلة مؤقتة أثناء تجهيز الرد. ممكن توضح لي طلبك في رسالة مختصرة؟',
      lead_summary: body,
      reason: 'AI_ERROR'
    };
  }

  if (decision.handoff) {
    const managerPhone = normalizePhone(process.env.MANAGER_PHONE || '');
    const clientPhone = normalizePhone(String(chatId).split('@')[0]) || String(chatId);
    const name = current.customerName || 'عميل';

    current.paused = true;
    current.handedOff = true;
    current.pauseReason = 'handoff';
    current.pausedUntil = null;
    current.updatedAt = new Date().toISOString();

    addLead({
      id: crypto.randomUUID(),
      chatId,
      customerName: name,
      customerPhone: clientPhone,
      summary: decision.lead_summary || body,
      reason: decision.reason || 'handoff',
      createdAt: new Date().toISOString(),
      status: 'awaiting_manager'
    });

    const answer = handoffMessage(MANAGER_NAME, MANAGER_ROLE, managerPhone);
    await sendAssistantReply(chatId, answer, incomingWasVoice, {
      includeText: true,
      spokenText: 'تمام يا فندم، يسعدنا اهتمام حضرتك. هحوّل حضرتك للمستشار أحمد لمتابعة المعاينة أو استكمال الشراء. هتلاقي رقم التواصل المباشر ورابط الواتساب في الرسالة المكتوبة.'
    });
    addMessage(chatId, 'assistant', answer);

    if (managerPhone) {
      const internal = [
        '🔔 عميل جاهز للمتابعة',
        'الاسم: ' + name,
        'رقم العميل: ' + clientPhone,
        'المرحلة: معاينة / شراء نهائي',
        'ملخص الاحتياج: ' + (decision.lead_summary || body),
        'آخر رسالة: ' + body.slice(0, 600)
      ].join('\n');
      try {
        await sendBotMessage(managerPhone + '@c.us', internal);
      } catch (error) {
        console.error('[handoff] Could not notify manager:', error.message);
      }
    } else {
      console.warn('[handoff] Add MANAGER_PHONE to .env before enabling live customer replies.');
    }
    save();
    return;
  }

  const answer = decision.reply || 'شكرًا لتواصلك. ممكن توضح لي تفاصيل أكثر عن طلب حضرتك؟';
  await sendAssistantReply(chatId, answer, incomingWasVoice);
  addMessage(chatId, 'assistant', answer);
}

function createWhatsAppClient() {
  const instance = new Client({
  authStrategy: new LocalAuth({
    clientId: 'mohamed-secretary',
    dataPath: process.env.WWEBJS_AUTH_PATH || './.wwebjs_auth'
  }),
  // whatsapp-web.js 1.34.8 waits for the WhatsApp socket to open; cloud cold starts can exceed 30s.
  authTimeoutMs: Math.max(30000, Number(process.env.WWEBJS_AUTH_TIMEOUT_MS || 120000)),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling'
    ]
  },
  takeoverOnConflict: false
});

  instance.on('qr', (qr) => {
  latestQr = qr;
  whatsappInitializing = false;
  whatsappLastError = null;
  console.log('\nامسح QR من واتساب: الأجهزة المرتبطة ← ربط جهاز');
  qrcode.generate(qr, { small: true });
});
  instance.on('loading_screen', (percent, message) => {
  console.log('[WhatsApp] Loading ' + percent + '% ' + String(message || ''));
});
  instance.on('change_state', (state) => {
  console.log('[WhatsApp] State changed: ' + String(state));
});
  instance.on('inject_error', (error) => {
  console.error('[WhatsApp] Injection error:', error && (error.stack || error.message) || String(error));
});
  instance.on('authenticated', () => console.log('[WhatsApp] Authentication successful.'));
  instance.on('ready', () => {
  latestQr = null;
  ready = true;
  console.log('[WhatsApp] Connected and ready.');
  console.log('[Secretary] Auto replies: ' + (autoReply ? 'ON' : 'OFF'));
});
  instance.on('auth_failure', (message) => {
  ready = false;
  whatsappInitializing = false;
  whatsappLastError = String(message || 'Authentication failure');
  console.error('[WhatsApp] Authentication failure:', message);
});
  instance.on('disconnected', (reason) => {
  ready = false;
  whatsappInitializing = false;
  console.warn('[WhatsApp] Disconnected:', reason);
});

  instance.on('message', (message) => {
  const chatId = message && message.from;
  if (!chatId) return;
  enqueue(chatId, () => processMessage(message)).catch((error) => {
    console.error('[WhatsApp] Message handling failed:', error.message);
  });
});

// If Mohamed sends a manual reply from his phone, pause that conversation.
// Bot-generated messages are fingerprinted so they do not trigger this pause.
  instance.on('message_create', (message) => {
  if (!message || !message.fromMe || !message.to) return;
  const chatId = message.to;
  if (String(chatId).endsWith('@g.us')) return;
  const outgoingBody = message.body || (['ptt', 'audio'].includes(String(message.type || '').toLowerCase()) ? '[voice-note]' : '');
  const key = fingerprint(chatId, outgoingBody);
  const expires = botOutbox.get(key);
  if (expires && expires >= Date.now()) {
    botOutbox.delete(key);
    return;
  }
  const current = state.conversations[chatId];
  if (!current) return;
  current.paused = true;
  current.handedOff = false;
  current.pauseReason = 'manual_takeover';
  current.pausedUntil = new Date(Date.now() + TAKEOVER_MINUTES * 60000).toISOString();
  current.updatedAt = new Date().toISOString();
  save();
  console.log('[Secretary] Manual reply detected; paused chat ' + chatId);
});

  return instance;
}

let client = createWhatsAppClient();

function startWhatsApp() {
  // Never call initialize() twice on the same whatsapp-web.js Client.
  // A QR event does not mean initialize() has settled; it remains pending until auth/ready.
  if (whatsappServiceEnabled && (ready || whatsappInitializing || whatsappInitPromise)) return;

  const operationId = ++whatsappOperationId;
  whatsappServiceEnabled = true;
  whatsappInitializing = true;
  whatsappLastError = null;
  latestQr = null;
  console.log('[WhatsApp] Start requested; initialization lock acquired.');

  setTimeout(() => {
    if (!whatsappServiceEnabled || operationId !== whatsappOperationId) return;

    try {
      if (!client) client = createWhatsAppClient();
      const activeClient = client;
      const initPromise = Promise.resolve().then(() => activeClient.initialize());
      whatsappInitPromise = initPromise;

      initPromise.catch((error) => {
        if (operationId !== whatsappOperationId) return;
        ready = false;
        whatsappInitializing = false;
        whatsappLastError = error && error.message ? error.message : String(error || 'Initialization failed');
        console.error('[WhatsApp] Initialization failed:', error && error.stack ? error.stack : whatsappLastError);
      }).finally(() => {
        if (operationId !== whatsappOperationId) return;
        if (whatsappInitPromise === initPromise) whatsappInitPromise = null;
        if (ready || latestQr) whatsappInitializing = false;
      });
    } catch (error) {
      if (operationId !== whatsappOperationId) return;
      whatsappInitializing = false;
      whatsappLastError = error && error.message ? error.message : String(error || 'Initialization failed');
      console.error('[WhatsApp] Start failed:', whatsappLastError);
    }
  }, 250);
}

async function stopWhatsApp() {
  ++whatsappOperationId;
  whatsappServiceEnabled = false;
  whatsappInitializing = false;
  ready = false;
  latestQr = null;
  whatsappLastError = null;
  console.log('[WhatsApp] Stop requested from dashboard.');
  const oldClient = client;
  client = null;
  whatsappInitPromise = null;
  try { if (oldClient) await oldClient.destroy(); }
  catch (error) { console.warn('[WhatsApp] Stop cleanup:', error.message); }
}

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const allowedDashboardOrigins = String(process.env.DASHBOARD_ORIGINS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedDashboardOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});


app.get('/health', (req, res) => {
  res.json({
    ok: true,
    whatsapp: ready ? 'ready' : 'disconnected',
    whatsappServiceEnabled,
    whatsappInitializing,
    whatsappLastError,
    aiConfigured: Boolean(process.env.GEMINI_API_KEY),
    managerConfigured: Boolean(normalizePhone(process.env.MANAGER_PHONE || '')),
    automaticReplies: autoReply,
    voiceReplies: process.env.VOICE_REPLY_MODE || 'mirror',
    voiceModelConfigured: Boolean(process.env.GEMINI_API_KEY),
    timestamp: new Date().toISOString()
  });
});

app.post('/admin/whatsapp/start', adminOnly, (req, res) => {
  if (whatsappServiceEnabled && (ready || whatsappInitializing)) {
    return res.json({ ok: true, enabled: true, ready, starting: whatsappInitializing });
  }
  startWhatsApp();
  return res.json({ ok: true, enabled: true, ready: false, starting: true });
});

app.post('/admin/whatsapp/stop', adminOnly, async (req, res) => {
  await stopWhatsApp();
  return res.json({ ok: true, enabled: false, ready: false, starting: false });
});

app.get('/admin/conversations', adminOnly, (req, res) => {
  const conversations = Object.entries(state.conversations).map(([chatId, item]) => ({
    chatId,
    customerName: item.customerName,
    paused: item.paused,
    pauseReason: item.pauseReason,
    handedOff: item.handedOff,
    updatedAt: item.updatedAt,
    messages: (item.messages || []).slice(-4)
  })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.json({ conversations });
});

app.get('/admin/leads', adminOnly, (req, res) => {
  res.json({ leads: state.leads.slice(-100).reverse() });
});

app.get('/admin/qr', adminOnly, async (req, res) => {
  if (!whatsappServiceEnabled) return res.status(409).json({ connected: false, qr: null, waiting: false, error: 'WhatsApp service is stopped.' });
  if (ready) return res.json({ connected: true, qr: null });
  if (!latestQr) return res.status(202).json({ connected: false, qr: null, waiting: true });
  try {
    const dataUrl = await QRCode.toDataURL(latestQr, { errorCorrectionLevel: 'M', margin: 2, width: 280 });
    return res.json({ connected: false, qr: dataUrl, waiting: false });
  } catch (error) {
    return res.status(500).json({ error: 'Could not render QR code.' });
  }
});

const SETTINGS_KEYS = new Set([
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GEMINI_AUDIO_MODEL',
  'GEMINI_TTS_MODEL',
  'GEMINI_TTS_VOICE',
  'GEMINI_TTS_STYLE',
  'VOICE_REPLY_MODE',
  'VOICE_REPLY_INCLUDE_TEXT',
  'MANAGER_NAME',
  'MANAGER_ROLE',
  'MANAGER_PHONE',
  'AUTO_REPLY_ENABLED',
  'MAX_INCOMING_AUDIO_BYTES',
  'MAX_VOICE_REPLY_CHARS',
  'VOICE_BITRATE'
]);

function serializeEnvValue(value) {
  return '"' + String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"';
}

app.get('/admin/settings', adminOnly, (req, res) => {
  res.json({
    settings: {
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      audioModel: process.env.GEMINI_AUDIO_MODEL || 'gemini-3.5-transcribe',
      ttsModel: process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts',
      ttsVoice: process.env.GEMINI_TTS_VOICE || 'Kore',
      voiceReplyMode: process.env.VOICE_REPLY_MODE || 'mirror',
      voiceReplyIncludeText: String(process.env.VOICE_REPLY_INCLUDE_TEXT || 'false') === 'true',
      managerName: process.env.MANAGER_NAME || 'المستشار أحمد',
      managerRole: process.env.MANAGER_ROLE || 'مدير متابعة العملاء',
      managerPhone: process.env.MANAGER_PHONE || '',
      autoReplyEnabled: autoReply
    }
  });
});

app.post('/admin/settings', adminOnly, (req, res) => {
  const incoming = req.body && req.body.settings;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Provide a settings object.' });
  }

  const updates = {};
  for (const [key, raw] of Object.entries(incoming)) {
    if (!SETTINGS_KEYS.has(key)) continue;
    if (typeof raw !== 'string' && typeof raw !== 'boolean' && typeof raw !== 'number') continue;
    const value = String(raw).trim();
    if (value.length > 4000) return res.status(400).json({ error: 'A setting is too long: ' + key });
    updates[key] = value;
  }

  if (updates.VOICE_REPLY_MODE && !['mirror', 'always', 'never'].includes(updates.VOICE_REPLY_MODE)) {
    return res.status(400).json({ error: 'VOICE_REPLY_MODE must be mirror, always, or never.' });
  }
  if (updates.MANAGER_PHONE && !normalizePhone(updates.MANAGER_PHONE)) {
    return res.status(400).json({ error: 'MANAGER_PHONE must be a valid international number.' });
  }
  const enablingReplies = updates.AUTO_REPLY_ENABLED === 'true';
  const effectiveGeminiKey = updates.GEMINI_API_KEY !== undefined ? updates.GEMINI_API_KEY : process.env.GEMINI_API_KEY;
  const effectiveManagerPhone = updates.MANAGER_PHONE !== undefined ? updates.MANAGER_PHONE : process.env.MANAGER_PHONE;
  if (enablingReplies && !effectiveGeminiKey) {
    return res.status(400).json({ error: 'Add GEMINI_API_KEY before enabling automatic replies.' });
  }
  if (enablingReplies && !normalizePhone(effectiveManagerPhone || '')) {
    return res.status(400).json({ error: 'Add a valid MANAGER_PHONE before enabling automatic replies.' });
  }

  try {
    const envPath = path.resolve(process.env.ENV_FILE || '.env');
    let current = {};
    if (fs.existsSync(envPath)) {
      current = require('dotenv').parse(fs.readFileSync(envPath));
    }
    const merged = { ...current, ...updates };
    const output = Object.entries(merged).map(([key, value]) => key + '=' + serializeEnvValue(value)).join('\n') + '\n';
    const tempPath = envPath + '.tmp';
    fs.writeFileSync(tempPath, output, { mode: 0o600 });
    fs.renameSync(tempPath, envPath);

    for (const [key, value] of Object.entries(updates)) process.env[key] = value;
    autoReply = String(process.env.AUTO_REPLY_ENABLED || 'false').toLowerCase() === 'true';

    return res.json({
      ok: true,
      saved: Object.keys(updates).filter((key) => key !== 'GEMINI_API_KEY'),
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      automaticReplies: autoReply
    });
  } catch (error) {
    console.error('[Settings] Could not persist settings:', error.message);
    return res.status(500).json({ error: 'Settings could not be saved on the WhatsApp worker.' });
  }
});


app.post('/admin/resume', adminOnly, (req, res) => {
  const phone = normalizePhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Provide a valid international phone number.' });
  const chatId = phone + '@c.us';
  const item = state.conversations[chatId];
  if (!item) return res.status(404).json({ error: 'Conversation not found.' });
  item.paused = false;
  item.handedOff = false;
  item.pauseReason = null;
  item.pausedUntil = null;
  item.updatedAt = new Date().toISOString();
  save();
  res.json({ ok: true, resumed: true, chatId });
});

app.post('/admin/pause', adminOnly, (req, res) => {
  const phone = normalizePhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Provide a valid international phone number.' });
  const chatId = phone + '@c.us';
  const item = conversation(chatId);
  item.paused = true;
  item.handedOff = false;
  item.pauseReason = 'manual_admin';
  item.pausedUntil = null;
  item.updatedAt = new Date().toISOString();
  save();
  res.json({ ok: true, paused: true, chatId });
});

app.post('/send', adminOnly, async (req, res) => {
  const phone = normalizePhone(req.body && req.body.phone);
  const text = String((req.body && req.body.message) || '').trim();
  if (!phone || !text) return res.status(400).json({ error: 'Provide phone and message.' });
  if (!ready) return res.status(503).json({ error: 'WhatsApp is not connected.' });
  try {
    const id = await client.getNumberId(phone);
    if (!id) return res.status(404).json({ error: 'This number is not available on WhatsApp.' });
    const result = await sendBotMessage(id._serialized, text);
    res.json({ ok: true, messageId: result.id && result.id._serialized });
  } catch (error) {
    res.status(502).json({ error: 'Message could not be sent.', detail: error.message });
  }
});

async function runAiStartupDiagnostics() {
  const enabled = String(process.env.AI_STARTUP_DIAGNOSTICS || 'false').toLowerCase() === 'true';
  console.log('[AI Diagnostics] START enabled=' + enabled);
  if (!enabled) return;
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('[AI Diagnostics] KEY_MISSING');
    return;
  }

  console.log('[AI Diagnostics] CHAT_LOGIC_START');
  try {
    const decision = await getDecision('السلام عليكم، ممكن أعرف خدماتكم؟', []);
    if (!decision || !String(decision.reply || '').trim()) throw new Error('Assistant returned an empty reply.');
    console.log('[AI Diagnostics] CHAT_LOGIC_OK replyChars=' + decision.reply.length + ' reason=' + String(decision.reason || '').slice(0, 100));
  } catch (error) {
    console.error('[AI Diagnostics] CHAT_LOGIC_FAILED: ' + String(error.message || error).slice(0, 550));
  }

  console.log('[AI Diagnostics] TTS_START');
  let audio;
  try {
    audio = await synthesizeVoiceNote('ده اختبار صوتي قصير للسكرتير الذكي.');
    console.log('[AI Diagnostics] TTS_OK bytes=' + audio.length);
  } catch (error) {
    console.error('[AI Diagnostics] TTS_FAILED: ' + String(error.message || error).slice(0, 500));
    return;
  }

  console.log('[AI Diagnostics] STT_START');
  try {
    const transcript = await transcribeAudio({
      data: audio.toString('base64'),
      mimetype: 'audio/ogg'
    });
    console.log('[AI Diagnostics] STT_OK transcriptChars=' + transcript.length);
  } catch (error) {
    console.error('[AI Diagnostics] STT_FAILED: ' + String(error.message || error).slice(0, 500));
  }
}
app.listen(PORT, HOST, () => {
  console.log('[HTTP] Admin API: http://' + HOST + ':' + PORT);
  if (!ADMIN_TOKEN) console.warn('[Security] ADMIN_TOKEN missing; admin routes disabled.');
  if (!process.env.GEMINI_API_KEY) console.warn('[AI] GEMINI_API_KEY missing; only a fallback response is available.');
  else console.log('[AI] Gemini key loaded from the runtime environment.');
  if (!normalizePhone(process.env.MANAGER_PHONE || '')) console.warn('[Handoff] MANAGER_PHONE missing; configure it before live use.');
  else console.log('[Handoff] Manager contact configured: ' + MANAGER_NAME + ' (' + process.env.MANAGER_PHONE.slice(-4) + ').');
  if (!autoReply) console.log('[Secretary] AUTO_REPLY_ENABLED=false; no automatic replies will be sent.');

  runAiStartupDiagnostics().catch((error) => {
    console.error('[AI Diagnostics] Unexpected test failure:', error.message);
  });

  // Railway may briefly overlap two deployments while switching traffic. Wait for the old
  // Chromium process to release the shared LocalAuth profile before launching the new one.
  const browserStartDelay = Math.max(10000, Number(process.env.WHATSAPP_START_DELAY_MS || 15000));
  console.log('[WhatsApp] Browser initialization scheduled in ' + browserStartDelay + 'ms.');
  setTimeout(() => {
    startWhatsApp();
  }, browserStartDelay);
});

process.on('SIGINT', () => {
  console.log('\n[Shutdown] Saving local state...');
  flush();
  if (client) client.destroy().catch(() => {}).finally(() => process.exit(0));
  else process.exit(0);
});
