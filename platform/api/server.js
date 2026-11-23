'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_MAX || 10), idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
const allowedOrigins = String(process.env.DASHBOARD_ORIGINS || 'https://media-first-secretary.vercel.app').split(',').map(x => x.trim()).filter(Boolean);
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin) || /^https:\/\/[a-z0-9-]+-thegamer2411-gmailcoms-projects\.vercel\.app$/i.test(origin)) return cb(null, true);
    return cb(new Error('Origin is not allowed.'));
  },
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  maxAge: 600
}));

const newId = () => crypto.randomUUID();
function same(a,b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x,y);
}
function encrypt(value) {
  if (!value) return '';
  const key = Buffer.from(process.env.SECRET_ENCRYPTION_KEY || '', 'hex');
  if (key.length !== 32) throw new Error('Encryption key must be 64 hexadecimal characters.');
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(value),'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}
function decrypt(value) {
  if (!value) return '';
  const key = Buffer.from(process.env.SECRET_ENCRYPTION_KEY || '', 'hex'), parts = value.split('.');
  if (key.length !== 32 || parts.length !== 3) throw new Error('Unable to decrypt provider key.');
  const dec = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0],'base64'));
  dec.setAuthTag(Buffer.from(parts[1],'base64'));
  return Buffer.concat([dec.update(Buffer.from(parts[2],'base64')),dec.final()]).toString('utf8');
}
function makeSlug(value) {
  const base = String(value || 'workspace').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,38) || 'workspace';
  return base + '-' + crypto.randomBytes(3).toString('hex');
}
function tokenFor(user, workspace, role) {
  return jwt.sign({sub:user.id,workspaceId:workspace.id,email:user.email,role}, process.env.JWT_SECRET, {expiresIn:'12h',issuer:'media-first-platform'});
}
function auth(req,res,next) {
  const h=req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({error:'سجّل الدخول أولًا.'});
  try { req.actor=jwt.verify(h.slice(7),process.env.JWT_SECRET,{issuer:'media-first-platform'}); next(); }
  catch { res.status(401).json({error:'انتهت جلسة الدخول. سجّل الدخول مرة أخرى.'}); }
}
const roles = allowed => (req,res,next) => allowed.includes(req.actor.role) ? next() : res.status(403).json({error:'ليس لديك صلاحية لهذا الإجراء.'});
const rate = rateLimit({windowMs:900000,limit:30,standardHeaders:'draft-8',legacyHeaders:false});
function wahaHeaders(extra) { return Object.assign({'X-Api-Key':process.env.WAHA_API_KEY,'Content-Type':'application/json'},extra || {}); }
async function waha(method,route,body,timeoutMs=25000) {
  const base=String(process.env.WAHA_URL || '').replace(/\/+$/,'');
  if (!base) throw new Error('WhatsApp gateway is not configured.');
  const response=await fetch(base+route,{method,headers:wahaHeaders(),body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
  const raw=await response.text(); let result=null;
  try { result=raw?JSON.parse(raw):null; } catch { result=raw; }
  if (!response.ok) throw new Error(String(result?.message || result?.error || 'WAHA HTTP '+response.status).slice(0,300));
  return result;
}
async function getSession(workspaceId,sid) {
  const r=await pool.query('SELECT * FROM wa_sessions WHERE workspace_id=$1 AND id=$2',[workspaceId,sid]);
  return r.rows[0] || null;
}
async function getContact(workspaceId,cid) {
  const r=await pool.query('SELECT c.*,s.waha_name,s.status AS session_status FROM contacts c JOIN wa_sessions s ON s.id=c.session_id WHERE c.workspace_id=$1 AND c.id=$2',[workspaceId,cid]);
  return r.rows[0] || null;
}
async function upsertContact(client,session,chatId,name) {
  const phone=String(chatId).split('@')[0].split(':')[0].replace(/\D/g,'');
  const r=await client.query(
    "INSERT INTO contacts(id,workspace_id,session_id,chat_id,phone_number,display_name,last_message_at) VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(session_id,chat_id) DO UPDATE SET display_name=EXCLUDED.display_name,last_message_at=NOW() RETURNING *",
    [newId(),session.workspace_id,session.id,chatId,phone,String(name || 'عميل').slice(0,120)]);
  return r.rows[0];
}
async function ensureDefaultSecretary(workspaceId) {
  await pool.query(`
    INSERT INTO ai_secretaries(id,workspace_id,name,category,description,system_prompt,is_default)
    SELECT gen_random_uuid(),a.workspace_id,'السكرتير العام','general',
      'السكرتير الافتراضي للمحادثات التي لا تحتاج إلى تخصص محدد.',a.system_prompt,TRUE
    FROM assistant_settings a
    WHERE a.workspace_id=$1
      AND NOT EXISTS (SELECT 1 FROM ai_secretaries s WHERE s.workspace_id=a.workspace_id AND s.is_default=TRUE)
    ON CONFLICT DO NOTHING
  `,[workspaceId]);
}
function verifyWebhook(raw,headers) {
  if (!same(headers['x-mf-webhook-secret'],process.env.WAHA_WEBHOOK_HEADER_SECRET)) return false;
  const expected=crypto.createHmac('sha512',process.env.WAHA_WEBHOOK_HMAC_KEY).update(raw).digest('hex');
  return same(headers['x-webhook-hmac'],expected);
}
async function aiCompletion(settings,history) {
  const systemPrompt=customerArabicPrompt(settings.system_prompt);
  const messages=[{role:'system',content:systemPrompt}];
  for (const row of history) messages.push({role:row.direction==='inbound'?'user':'assistant',content:row.body});
  if (settings.provider==='gemini') {
    const key=decrypt(settings.api_key_ciphertext);
    if (!key) throw new Error('Gemini API key is missing.');
    const configured=String(settings.model || 'gemini-3.8-flash').replace(/^models\//,'');
    const api='https://generativelanguage.googleapis.com/v1beta';
    let discovered=[];
    try {
      const listResponse=await fetch(api+'/models?pageSize=1000&key='+encodeURIComponent(key),{signal:AbortSignal.timeout(12000)});
      const listData=await listResponse.json().catch(()=>({}));
      if (listResponse.ok && Array.isArray(listData.models)) {
        discovered=listData.models
          .filter(m=>String(m.name||'').startsWith('models/gemini') && (m.supportedGenerationMethods||[]).includes('generateContent'))
          .map(m=>String(m.name).replace(/^models\//,''));
      } else {
        console.warn('[Gemini model discovery]',listData.error?.message || ('HTTP '+listResponse.status));
      }
    } catch(e) { console.warn('[Gemini model discovery]',e.message); }
    const preferred=[configured,'gemini-3.8-flash','gemini-3.1-flash-lite','gemini-2.5-flash','gemini-2.5-flash-lite'];
    const ordered=[...new Set([...preferred,...discovered])].filter(Boolean);
    const available=discovered.length?ordered.filter(m=>preferred.includes(m)||discovered.includes(m)):ordered;
    const contents=history.map(row=>({role:row.direction==='inbound'?'user':'model',parts:[{text:String(row.body||'')}]})).filter(x=>x.parts[0].text);
    if (!contents.length) throw new Error('No conversation content to send to Gemini.');
    const failures=[];
    for (const model of available) {
      try {
        const response=await fetch(api+'/models/'+encodeURIComponent(model)+':generateContent?key='+encodeURIComponent(key),{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            systemInstruction:{parts:[{text:systemPrompt}]},
            contents,
            generationConfig:{temperature:0.4,maxOutputTokens:900}
          }),
          signal:AbortSignal.timeout(22000)
        });
        const data=await response.json().catch(()=>({}));
        if (!response.ok) {
          const reason=String(data.error?.message||('HTTP '+response.status));
          failures.push(model+': '+reason);
          console.warn('[Gemini model failed]',model,reason);
          if ([400,401,403].includes(response.status) && /API_KEY_INVALID|API key not valid|permission|leaked/i.test(reason)) break;
          continue;
        }
        const answer=String(data.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'').trim();
        if (answer) {
          console.log('[Gemini model selected]',model);
          return whatsappText(answer);
        }
        failures.push(model+': empty response');
      } catch(e) {
        failures.push(model+': '+e.message);
        console.warn('[Gemini model failed]',model,e.message);
      }
    }
    throw new Error('All compatible Gemini models failed: '+failures.slice(0,8).join(' | ').slice(0,1200));
  }
  const base=String(settings.base_url || '').replace(/\/+$/,''), model=String(settings.model || '');
  if (!base || !model) throw new Error('أدخل عنوان محرك الذكاء الاصطناعي واسم النموذج.');
  const key=decrypt(settings.api_key_ciphertext);
  const response=await fetch(base+'/chat/completions',{
    method:'POST',headers:Object.assign({'Content-Type':'application/json'},key?{Authorization:'Bearer '+key}:{}),
    body:JSON.stringify({model,messages,temperature:0.4,max_tokens:900}),signal:AbortSignal.timeout(60000)
  });
  const data=await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error?.message || 'AI provider request failed.');
  return whatsappText(data.choices?.[0]?.message?.content || '');
}
async function classifySecretary(settings,candidates,history) {
  const fallback=candidates.find(s=>s.is_default) || candidates[0];
  if (!fallback) throw new Error('No secretary profile is configured.');
  const specialists=candidates.filter(s=>!s.is_default);
  if (!specialists.length) return {secretary:fallback,category:'general',confidence:1,reason:'لا توجد سكرتارية متخصصة مفعّلة.',source:'auto'};
  const payload={
    recentConversation:history.slice(-10).map(m=>({from:m.direction==='inbound'?'customer':'business',text:String(m.body||'').slice(0,1400)})),
    availableSecretaries:candidates.map(s=>({
      id:s.id,name:s.name,category:s.category,description:s.description,
      keywords:Array.isArray(s.keywords)?s.keywords:[]
    }))
  };
  const classifierPrompt=[
    'أنت محرك توجيه محادثات لخدمة عملاء متعددة السكرتارية.',
    'حلل موضوع العميل ونيته من الرسائل الأخيرة والسياق، واختر سكرتيرًا واحدًا فقط من القائمة.',
    'لا تخترع معرفًا ولا تخترع تخصصًا. استخدم السكرتير العام إذا كان الموضوع غير واضح أو لا يناسب أي تخصص.',
    'يمكن أن تكون الرسائل باللهجة المصرية أو العربية أو الإنجليزية، وقد تكون قصيرة أو بها أخطاء إملائية.',
    'أعد JSON صالحًا فقط دون Markdown أو أي نص إضافي، بالحقول: secretary_id (المعرف حرفيًا من القائمة)، category (اسم التصنيف المختصر)، confidence (رقم من 0 إلى 1)، reason (سبب موجز بالعربية).'
  ].join('\n');
  const raw=await aiCompletion(
    {...settings,system_prompt:classifierPrompt},
    [{direction:'inbound',body:JSON.stringify(payload)}]
  );
  let parsed;
  try {
    const match=String(raw||'').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Classifier did not return JSON.');
    parsed=JSON.parse(match[0]);
  } catch(e) {
    console.warn('[Secretary classifier parse failed]',e.message);
    return {secretary:fallback,category:'general',confidence:0,reason:'تعذر قراءة نتيجة التصنيف؛ تم استخدام السكرتير العام.',source:'auto'};
  }
  const chosen=candidates.find(s=>s.id===String(parsed.secretary_id||''));
  let confidence=Number(parsed.confidence);
  if (confidence>1 && confidence<=100) confidence/=100;
  if (!Number.isFinite(confidence)) confidence=0;
  confidence=Math.max(0,Math.min(1,confidence));
  if (!chosen || confidence<0.58) {
    return {secretary:fallback,category:String(parsed.category||'general').slice(0,80),confidence,reason:String(parsed.reason||'التصنيف غير مؤكد؛ تم استخدام السكرتير العام.').slice(0,500),source:'auto'};
  }
  return {
    secretary:chosen,
    category:String(parsed.category||chosen.category||'general').slice(0,80),
    confidence,
    reason:String(parsed.reason||'تم اختيار السكرتير وفق موضوع المحادثة.').slice(0,500),
    source:chosen.is_default?'auto':'ai'
  };
}
async function resolveSecretary(session,contact,settings,history) {
  await ensureDefaultSecretary(session.workspace_id);
  if (contact.secretary_assignment==='manual' && contact.secretary_id) {
    const manual=(await pool.query(
      'SELECT * FROM ai_secretaries WHERE id=$1 AND workspace_id=$2 AND enabled=TRUE',
      [contact.secretary_id,session.workspace_id]
    )).rows[0];
    if (manual) return {secretary:manual,source:'manual',category:manual.category,confidence:1,reason:'تخصيص يدوي من لوحة التحكم.'};
  }
  const campaignSecretary=(await pool.query(`
    SELECT s.*,c.title AS campaign_title
    FROM campaign_recipients cr
    JOIN campaigns c ON c.id=cr.campaign_id AND c.workspace_id=cr.workspace_id
    JOIN ai_secretaries s ON s.id=c.secretary_id AND s.workspace_id=c.workspace_id AND s.enabled=TRUE
    WHERE cr.contact_id=$1 AND cr.workspace_id=$2 AND cr.status='sent'
    ORDER BY cr.sent_at DESC NULLS LAST
    LIMIT 1
  `,[contact.id,session.workspace_id])).rows[0];
  if (campaignSecretary) {
    const reason='مخصص للحملة: '+String(campaignSecretary.campaign_title||'').slice(0,180);
    await pool.query(
      "UPDATE contacts SET secretary_id=$1,secretary_assignment='campaign',secretary_category=$2,secretary_confidence=1,secretary_reason=$3 WHERE id=$4",
      [campaignSecretary.id,campaignSecretary.category,reason,contact.id]
    );
    return {secretary:campaignSecretary,source:'campaign',category:campaignSecretary.category,confidence:1,reason};
  }
  const candidates=(await pool.query(
    'SELECT * FROM ai_secretaries WHERE workspace_id=$1 AND enabled=TRUE ORDER BY is_default DESC,created_at ASC LIMIT 30',
    [session.workspace_id]
  )).rows;
  if (!candidates.length) throw new Error('No active secretary profile exists.');
  let route;
  try {
    route=await classifySecretary(settings,candidates,history);
  } catch(e) {
    const fallback=candidates.find(s=>s.is_default)||candidates[0];
    route={secretary:fallback,source:'auto',category:'general',confidence:0,reason:'تعذر التصنيف مؤقتًا؛ تم تحويل المحادثة إلى السكرتير العام.'};
    console.warn('[Secretary classifier fallback]',e.message);
  }
  await pool.query(
    'UPDATE contacts SET secretary_id=$1,secretary_assignment=$2,secretary_category=$3,secretary_confidence=$4,secretary_reason=$5 WHERE id=$6',
    [route.secretary.id,route.source,route.category,route.confidence,route.reason,contact.id]
  );
  return route;
}
function customerArabicPrompt(prompt) {
  return String(prompt || 'أنت مساعد خدمة عملاء محترف. أجب بناءً على معلومات المنتج المتاحة ولا تخترع بيانات.') +
    '\n\nتعليمات أسلوب إلزامية: تحدث مع العملاء باللهجة المصرية الطبيعية المهذبة والواضحة، وليس بالفصحى الرسمية. استخدم تعبيرات مصرية بسيطة مثل أهلاً بيك، تحت أمرك، تحب تعرف، من غير مبالغة أو افتعال. لا تطلب اسم المنتج أو رقم الموديل إذا كانت معلومات المنتج موجودة في تعليماتك أو سياق المحادثة؛ اشرح المنتج مباشرة، واسأل فقط عن معلومة ناقصة فعلًا. لا تستخدم Markdown مثل ** أو ## أو علامات backticks. اجعل الرد مناسبًا لرسائل واتساب، مختصرًا ومنظمًا، ولا تخترع مواصفات أو أسعارًا غير متاحة.';
}
function whatsappText(value) {
  return String(value || '')
    .replace(/\*\*(.*?)\*\*/gs,'*$1*')
    .replace(/__(.*?)__/gs,'_$1_')
    .replace(/^#{1,6}\s*/gm,'')
    .replace(/^\s*[-•]\s+/gm,'• ')
    .replace(/\x60([^\x60]+)\x60/g,'$1')
    .trim();
}
function isVoiceMessage(payload) {
  const type=String(payload?.type || '').toLowerCase();
  const mime=String(payload?.media?.mimetype || payload?.mimetype || '').toLowerCase();
  return mime.startsWith('audio/') || ['ptt','audio','voice','voice_note','voicenote'].includes(type);
}
function wahaMediaPath(value) {
  if (!value) return '';
  let pathname='';
  try {
    const parsed=new URL(String(value));
    pathname=parsed.pathname+parsed.search;
  } catch {
    pathname=String(value).startsWith('/')?String(value):'/'+String(value);
  }
  if (!pathname.startsWith('/api/files/') || pathname.includes('/../')) return '';
  return pathname;
}
async function resolveVoiceMedia(session,payload,chatId) {
  let source=payload||{}, media=source.media||{};
  // Some WAHA event payloads contain hasMedia/mimetype but no downloaded URL.
  // Re-fetch that exact message with downloadMedia=true instead of dropping it.
  if ((!media.url || media.error) && source.id && chatId) {
    const messageId=typeof source.id==='string'?source.id:(source.id?._serialized || source.id?.id || '');
    if (messageId) {
      try {
        const route='/api/'+encodeURIComponent(session.waha_name)+'/chats/'+encodeURIComponent(chatId)+'/messages/'+encodeURIComponent(messageId)+'?downloadMedia=true&downloadMediaMimetypes=audio';
        const hydrated=await waha('GET',route);
        if (hydrated && typeof hydrated==='object') {
          source=hydrated;
          media=hydrated.media || media;
        }
      } catch(e) {
        console.warn('[Voice media hydration failed]',e.message);
      }
    }
  }
  const mimeRaw=String(media.mimetype || source.mimetype || 'audio/ogg').toLowerCase().split(';')[0];
  const mime=mimeRaw==='audio/opus'?'audio/ogg':(mimeRaw.startsWith('audio/')?mimeRaw:'audio/ogg');
  const mediaPath=wahaMediaPath(media.url || source.mediaUrl || '');
  if (!mediaPath) throw new Error(String(media.error || 'WAHA did not provide a downloadable audio URL.'));
  const base=String(process.env.WAHA_URL || '').replace(/\/+$/,'');
  if (!base) throw new Error('WhatsApp gateway is not configured.');
  let lastError='Media download failed.';
  for (let attempt=1;attempt<=3;attempt++) {
    try {
      const response=await fetch(base+mediaPath,{
        headers:{'X-Api-Key':process.env.WAHA_API_KEY},
        signal:AbortSignal.timeout(60000)
      });
      if (!response.ok) {
        lastError='WAHA media HTTP '+response.status;
        if (attempt<3) { await new Promise(resolve=>setTimeout(resolve,attempt*1200)); continue; }
        throw new Error(lastError);
      }
      const bytes=Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw new Error('Downloaded voice message is empty.');
      if (bytes.length>20*1024*1024) throw new Error('Voice message exceeds the 20 MB inline transcription limit.');
      return {bytes,mime,mediaPath};
    } catch(e) {
      lastError=e.message;
      if (attempt===3) throw new Error('Could not download voice media: '+lastError);
      await new Promise(resolve=>setTimeout(resolve,attempt*1200));
    }
  }
  throw new Error(lastError);
}
async function transcribeVoiceMessage(session,payload,chatId) {
  const media=await resolveVoiceMedia(session,payload,chatId);
  const keyResult=await pool.query('SELECT api_key_ciphertext,model FROM assistant_settings WHERE workspace_id=$1',[session.workspace_id]);
  const key=decrypt(keyResult.rows[0]?.api_key_ciphertext || '');
  if (!key) throw new Error('Gemini API key is missing for voice transcription.');
  const configured=String(keyResult.rows[0]?.model || 'gemini-3.8-flash').replace(/^models\//,'');
  const models=[...new Set([configured,'gemini-3.8-flash','gemini-3.5-flash-lite','gemini-3.1-flash-lite'])];
  const api='https://generativelanguage.googleapis.com/v1beta';
  const failures=[];
  for (const model of models) {
    try {
      const response=await fetch(api+'/models/'+encodeURIComponent(model)+':generateContent?key='+encodeURIComponent(key),{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({contents:[{role:'user',parts:[
          {text:'حوّل الرسالة الصوتية التالية إلى نص حرفي كما قاله المتحدث، باللغة العربية ولهجته الأصلية، وخصوصًا اللهجة المصرية. لا تلخص ولا تجب عن السؤال. أعد الكلام المنطوق فقط دون مقدمات. إذا لم يوجد كلام مفهوم فأعد [الصوت غير واضح].'},
          {inlineData:{mimeType:media.mime,data:media.bytes.toString('base64')}}
        ]}],generationConfig:{temperature:0,maxOutputTokens:1000}}),
        signal:AbortSignal.timeout(90000)
      });
      const data=await response.json().catch(()=>({}));
      if (!response.ok) {
        const reason=String(data.error?.message || 'Gemini HTTP '+response.status);
        failures.push(model+': '+reason);
        console.warn('[Voice transcription model failed]',model,reason);
        if ([401,403].includes(response.status) && /API_KEY_INVALID|API key not valid|permission|leaked/i.test(reason)) break;
        continue;
      }
      const transcript=String(data.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'').trim();
      if (transcript && transcript!=='[الصوت غير واضح]') {
        console.log('[Voice transcription complete]',{model,bytes:media.bytes.length,mime:media.mime});
        return {transcript,mediaPath:media.mediaPath,mime:media.mime};
      }
      failures.push(model+': empty or unclear transcription');
    } catch(e) {
      failures.push(model+': '+e.message);
      console.warn('[Voice transcription model failed]',model,e.message);
    }
  }
  throw new Error('Voice transcription failed: '+failures.slice(0,6).join(' | ').slice(0,1200));
}
async function sendVoiceFailureReply(session,contact) {
  const settings=(await pool.query('SELECT enabled FROM assistant_settings WHERE workspace_id=$1',[session.workspace_id])).rows[0];
  const fresh=await getContact(session.workspace_id,contact.id);
  if (!settings?.enabled || fresh?.is_paused) return;
  const text='وصلتني رسالتك الصوتية، بس مقدرتش أحولها لنص بوضوح. ممكن تبعتها تاني أو تكتبلي سؤالك؟';
  try {
    const sent=await waha('POST','/api/sendText',{session:session.waha_name,chatId:contact.chat_id,text});
    await pool.query(
      "INSERT INTO messages(id,workspace_id,session_id,contact_id,wamid,direction,message_type,body,status) VALUES($1,$2,$3,$4,$5,'outbound','text',$6,'sent') ON CONFLICT(session_id,wamid) DO NOTHING",
      [newId(),session.workspace_id,session.id,contact.id,String(sent?.id || 'voice-fallback-'+newId()),text]
    );
  } catch(e) { console.error('[Voice fallback reply failed]',e.message); }
}
async function processIncomingVoice(session,contact,messageRowId,payload) {
  try {
    const result=await transcribeVoiceMessage(session,payload,contact.chat_id);
    const body='🎤 رسالة صوتية:\n'+result.transcript;
    await pool.query(
      "UPDATE messages SET body=$1,media_url=$2,media_mimetype=$3,transcription_status='completed' WHERE id=$4",
      [body,result.mediaPath,result.mime,messageRowId]
    );
    console.log('[Voice message saved and transcribed]',{contactId:contact.id,messageId:messageRowId,transcriptLength:result.transcript.length});
    const fresh=await getContact(session.workspace_id,contact.id);
    if (fresh) await assistantReply(session,fresh);
  } catch(e) {
    await pool.query(
      "UPDATE messages SET body='🎤 رسالة صوتية (تعذر تحويلها إلى نص تلقائيًا)',transcription_status='failed' WHERE id=$1",
      [messageRowId]
    ).catch(dbError=>console.error('[Voice status save failed]',dbError.message));
    console.error('[Voice message processing]',e.message);
    await sendVoiceFailureReply(session,contact);
  }
}
async function generateAssistantVoice(settings,text) {
  const key=decrypt(settings.api_key_ciphertext || '');
  if (!key) throw new Error('Gemini API key is missing for voice generation.');
  const spoken=String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g,'')
    .replace(/[*_~\x60#]/g,'')
    .trim()
    .slice(0,5000);
  if (!spoken) throw new Error('Assistant response is empty; cannot synthesize voice.');
  const api='https://generativelanguage.googleapis.com/v1beta/interactions';
  const preferred=String(process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts').trim();
  const models=[...new Set([preferred,'gemini-3.8-flash-lite-tts','gemini-3.8-flash-tts'])];
  const voiceName=String(process.env.GEMINI_TTS_VOICE || 'Kore').trim();
  const failures=[];
  for (const model of models) {
    try {
      const response=await fetch(api,{
        method:'POST',
        headers:{'Content-Type':'application/json','x-goog-api-key':key},
        body:JSON.stringify({
          model,
          input:[{type:'user_input',content:[{
            type:'text',
            text:spoken,
            annotations:[{
              type:'speech_metadata',
              style:'Speak naturally in a warm, clear Egyptian Arabic dialect (Masri), like a helpful and confident customer-service representative. Keep a moderate pace and pronounce Arabic names clearly.'
            }]
          }]}],
          response_format:{type:'audio'},
          generation_config:{speech_config:[{voice:voiceName}]}
        }),
        signal:AbortSignal.timeout(90000)
      });
      const data=await response.json().catch(()=>({}));
      if (!response.ok) {
        const reason=String(data.error?.message || data.message || 'Gemini TTS HTTP '+response.status);
        failures.push(model+': '+reason);
        console.warn('[Gemini TTS model failed]',model,reason);
        if ([401,403].includes(response.status) && /API_KEY_INVALID|API key not valid|permission|leaked/i.test(reason)) break;
        continue;
      }
      const audioPart=(data.steps || [])
        .filter(step=>step.type==='model_output')
        .flatMap(step=>step.content || [])
        .filter(part=>part.type==='audio' && part.data)
        .slice(-1)[0];
      const base64=String(audioPart?.data || data.output_audio?.data || '');
      if (!base64) {
        failures.push(model+': no audio data in Gemini response');
        continue;
      }
      const bytes=Buffer.from(base64,'base64');
      if (!bytes.length || bytes.length>18*1024*1024) throw new Error('Generated audio is empty or larger than 18 MB.');
      return {base64,mimeType:'audio/wav',bytes:bytes.length};
    } catch(e) {
      failures.push(model+': '+e.message);
      console.warn('[Gemini TTS model failed]',model,e.message);
    }
  }
  throw new Error('Gemini voice generation failed: '+failures.slice(0,5).join(' | ').slice(0,1000));
}

async function assistantReply(session,contact) {
  const sr=await pool.query('SELECT * FROM assistant_settings WHERE workspace_id=$1',[session.workspace_id]), settings=sr.rows[0];
  if (!settings || !settings.enabled || contact.is_paused) return;
  const mr=await pool.query('SELECT direction,body FROM messages WHERE contact_id=$1 ORDER BY sent_at DESC LIMIT 14',[contact.id]);
  if (!mr.rowCount) return;
  try {
    const history=mr.rows.reverse();
    const route=await resolveSecretary(session,contact,settings,history);
    const secretary=route.secretary;
    const lastInboundMessage=[...history].reverse().find(message=>message.direction==='inbound');
    const isReplyingToVoice=String(lastInboundMessage?.body || '').startsWith('🎤 رسالة صوتية:');
    const effectiveSettings={
      ...settings,
      system_prompt:[settings.system_prompt,secretary.system_prompt].filter(Boolean).join('\n\n')
    };
    console.log('[Secretary routed]',{
      contactId:contact.id,secretaryId:secretary.id,secretaryName:secretary.name,
      source:route.source,category:route.category,confidence:route.confidence
    });
    const answer=await aiCompletion(effectiveSettings,history);
    if (!answer) return;
    if (isReplyingToVoice) {
      const audio=await generateAssistantVoice(settings,answer);
      const sent=await waha('POST','/api/sendVoice',{
        session:session.waha_name,
        chatId:contact.chat_id,
        file:{mimetype:audio.mimeType,filename:'media-first-reply.wav',data:audio.base64},
        convert:true
      },90000);
      const wamid=String(sent?.id || sent?.key?.id || 'assistant-voice-'+newId());
      const mediaPath=wahaMediaPath(sent?.media?.url || sent?.mediaUrl || '');
      await pool.query(
        "INSERT INTO messages(id,workspace_id,session_id,contact_id,wamid,direction,message_type,body,status,sent_at,media_url,media_mimetype,transcription_status) VALUES($1,$2,$3,$4,$5,'outbound','ptt',$6,'sent',NOW(),$7,'audio/ogg','none') ON CONFLICT(session_id,wamid) DO NOTHING",
        [newId(),session.workspace_id,session.id,contact.id,wamid,answer,mediaPath]
      );
      console.log('[Voice reply sent]',{contactId:contact.id,messageId:wamid,audioBytes:audio.bytes});
      return;
    }
    const sent=await waha('POST','/api/sendText',{session:session.waha_name,chatId:contact.chat_id,text:whatsappText(answer)});
    await pool.query(
      "INSERT INTO messages(id,workspace_id,session_id,contact_id,wamid,direction,message_type,body,status) VALUES($1,$2,$3,$4,$5,'outbound','text',$6,'sent') ON CONFLICT(session_id,wamid) DO NOTHING",
      [newId(),session.workspace_id,session.id,contact.id,String(sent?.id || 'assistant-'+newId()),answer]);
  } catch(e) { console.error('[Assistant]',e.message); }
}

app.get('/health',async (req,res)=>{
  try { await pool.query('SELECT 1'); res.json({ok:true,service:'media-first-platform-api',database:'ready',whatsappGatewayConfigured:Boolean(process.env.WAHA_URL&&process.env.WAHA_API_KEY),time:new Date().toISOString()}); }
  catch { res.status(503).json({ok:false,database:'unavailable'}); }
});

/* Webhook route precedes express.json so signatures are checked against raw bytes. */
app.post('/webhooks/waha',express.raw({type:'application/json',limit:'2mb'}),async (req,res)=>{
  const raw=Buffer.isBuffer(req.body)?req.body:Buffer.from('');
  if (!verifyWebhook(raw,req.headers)) return res.status(401).json({error:'Invalid webhook signature.'});
  let event;
  try { event=JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({error:'Invalid JSON.'}); }
  const eventType=String(event.event || ''), sessionName=String(event.session || '');
  const requestId=String(req.headers['x-webhook-request-id'] || crypto.createHash('sha256').update(raw).digest('hex'));
  const inserted=await pool.query('INSERT INTO webhook_events(id,request_id,event_type,session_name) VALUES($1,$2,$3,$4) ON CONFLICT(request_id) DO NOTHING RETURNING id',[newId(),requestId,eventType,sessionName]);
  if (!inserted.rowCount) return res.status(200).json({ok:true,duplicate:true});
  const sr=await pool.query('SELECT * FROM wa_sessions WHERE waha_name=$1 LIMIT 1',[sessionName]), session=sr.rows[0];
  if (!session) return res.status(200).json({ok:true,ignored:true});
  if (eventType==='session.status') {
    const status=String(event.payload?.status || 'UNKNOWN');
    await pool.query('UPDATE wa_sessions SET status=$1,updated_at=NOW(),last_error=$2 WHERE id=$3',[status,status==='FAILED'?String(event.payload?.reason || ''):'',session.id]);
    return res.status(200).json({ok:true});
  }
  if (eventType!=='message') return res.status(200).json({ok:true,ignored:true});
  const p=event.payload || {};
  if (p.fromMe) return res.status(200).json({ok:true,ignored:true});
  const chatId=String(p.from || p.chatId || '');
  if (!chatId || chatId.endsWith('@g.us') || chatId==='status@broadcast') return res.status(200).json({ok:true,ignored:true});
  let body=String(p.body || p.caption || '').trim();
  const isVoice=isVoiceMessage(p);
  if (!body && !isVoice) return res.status(200).json({ok:true,ignored:true});
  if (isVoice) body='🎤 رسالة صوتية (جارٍ تحويلها إلى نص...)';
  const client=await pool.connect(); let contact, messageRowId, wasInserted=false;
  try {
    await client.query('BEGIN');
    contact=await upsertContact(client,session,chatId,p.pushName || p._data?.notifyName || 'عميل');
    if (/^(STOP|UNSUBSCRIBE|إلغاء|الغاء|توقف|إيقاف|ايقاف)$/i.test(String(p.body || '').trim())) {
      await client.query("UPDATE contacts SET marketing_opt_in=FALSE,marketing_opt_in_at=NULL,marketing_opt_in_source='customer-opt-out' WHERE id=$1",[contact.id]);
    }
    const rawId=typeof p.id==='string'?p.id:(p.id?._serialized || p.id?.id || newId());
    const messageId=newId();
    const mediaPath=wahaMediaPath(p.media?.url || p.mediaUrl || '');
    const mime=String(p.media?.mimetype || (isVoice?'audio/ogg':'')).toLowerCase().split(';')[0];
    const type=isVoice && !String(p.type||'').trim()? 'ptt' : String(p.type || (isVoice?'ptt':'text'));
    const saved=await client.query(
      "INSERT INTO messages(id,workspace_id,session_id,contact_id,wamid,direction,message_type,body,status,sent_at,media_url,media_mimetype,transcription_status) VALUES($1,$2,$3,$4,$5,'inbound',$6,$7,'received',NOW(),$8,$9,$10) ON CONFLICT(session_id,wamid) DO NOTHING RETURNING id",
      [messageId,session.workspace_id,session.id,contact.id,String(rawId),type,body,mediaPath,mime,isVoice?'pending':'none']
    );
    if (saved.rowCount) { messageRowId=saved.rows[0].id; wasInserted=true; }
    else {
      const existing=await client.query("SELECT id,transcription_status FROM messages WHERE session_id=$1 AND wamid=$2",[session.id,String(rawId)]);
      messageRowId=existing.rows[0]?.id;
      wasInserted=false;
    }
    await client.query('COMMIT');
  } catch(e) {
    await client.query('ROLLBACK'); console.error('[Webhook]',e.message); return res.status(500).json({error:'Could not save message.'});
  } finally { client.release(); }
  res.status(200).json({ok:true,voiceQueued:isVoice});
  if (isVoice && messageRowId) {
    setImmediate(async()=>{
      try {
        const current=(await pool.query('SELECT transcription_status FROM messages WHERE id=$1',[messageRowId])).rows[0];
        if (current?.transcription_status!=='completed') await processIncomingVoice(session,contact,messageRowId,p);
      } catch(e) { console.error('[Voice worker]',e.message); }
    });
  } else if (wasInserted) {
    setImmediate(()=>assistantReply(session,contact).catch(e=>console.error('[Assistant]',e.message)));
  }
});

app.use(express.json({limit:'1mb'}));
app.use('/v1/auth',rate);

app.post('/v1/auth/register',async (req,res)=>{
  const fullName=String(req.body.fullName || '').trim(), email=String(req.body.email || '').trim().toLowerCase();
  const password=String(req.body.password || ''), workspaceName=String(req.body.workspaceName || '').trim();
  if (fullName.length<2 || !email.includes('@') || password.length<10 || workspaceName.length<2)
    return res.status(400).json({error:'أكمل الاسم والبريد واسم الشركة، وكلمة المرور لا تقل عن 10 أحرف.'});
  const client=await pool.connect(), userId=newId(), workspaceId=newId();
  try {
    await client.query('BEGIN');
    const hash=await bcrypt.hash(password,12);
    const u=await client.query('INSERT INTO users(id,full_name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id,full_name,email',[userId,fullName,email,hash]);
    const w=await client.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3) RETURNING id,name,slug',[workspaceId,workspaceName,makeSlug(workspaceName)]);
    await client.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspaceId,userId,'owner']);
    await client.query('INSERT INTO assistant_settings(workspace_id) VALUES($1)',[workspaceId]);
    await client.query("INSERT INTO ai_secretaries(id,workspace_id,name,category,description,system_prompt,is_default) VALUES($1,$2,'السكرتير العام','general','السكرتير الافتراضي للمحادثات العامة.','',TRUE)",[newId(),workspaceId]);
    await client.query("INSERT INTO workspace_subscriptions(workspace_id,plan_id,status) VALUES($1,'starter','trial')",[workspaceId]);
    await client.query('COMMIT');
    res.status(201).json({token:tokenFor(u.rows[0],w.rows[0],'owner'),user:u.rows[0],workspace:w.rows[0]});
  } catch(e) {
    await client.query('ROLLBACK');
    if (e.code==='23505') return res.status(409).json({error:'هذا البريد الإلكتروني مسجل بالفعل.'});
    console.error('[Register]',e.message); res.status(500).json({error:'تعذر إنشاء الحساب الآن.'});
  } finally { client.release(); }
});
app.post('/v1/auth/login',async (req,res)=>{
  const email=String(req.body.email || '').trim().toLowerCase(), password=String(req.body.password || '');
  const r=await pool.query('SELECT u.id,u.full_name,u.email,u.password_hash,w.id AS wid,w.name AS wname,w.slug,m.role FROM users u JOIN workspace_members m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id WHERE u.email=$1 ORDER BY m.created_at LIMIT 1',[email]);
  const x=r.rows[0];
  if (!x || !(await bcrypt.compare(password,x.password_hash))) return res.status(401).json({error:'البريد الإلكتروني أو كلمة المرور غير صحيحة.'});
  const user={id:x.id,full_name:x.full_name,email:x.email}, workspace={id:x.wid,name:x.wname,slug:x.slug};
  res.json({token:tokenFor(user,workspace,x.role),user,workspace});
});
app.get('/v1/auth/me',auth,async (req,res)=>{
  const r=await pool.query('SELECT u.id,u.full_name,u.email,w.id AS wid,w.name AS wname,w.slug,m.role FROM users u JOIN workspace_members m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id WHERE u.id=$1 AND w.id=$2',[req.actor.sub,req.actor.workspaceId]);
  const x=r.rows[0]; if (!x) return res.status(401).json({error:'الحساب غير موجود.'});
  res.json({user:{id:x.id,fullName:x.full_name,email:x.email},workspace:{id:x.wid,name:x.wname,slug:x.slug,role:x.role}});
});
app.get('/v1/overview',auth,async (req,res)=>{
  const w=req.actor.workspaceId;
  const [s,c,m,p]=await Promise.all([
    pool.query("SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status IN ('WORKING','CONNECTED'))::int AS connected FROM wa_sessions WHERE workspace_id=$1",[w]),
    pool.query('SELECT COUNT(*)::int AS total FROM contacts WHERE workspace_id=$1',[w]),
    pool.query("SELECT COUNT(*)::int AS total FROM messages WHERE workspace_id=$1 AND sent_at>=NOW()-INTERVAL '30 days'",[w]),
    pool.query('SELECT p.id,p.name,p.monthly_price_egp,s.status FROM workspace_subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.workspace_id=$1',[w])
  ]);
  res.json({sessions:s.rows[0],contacts:c.rows[0].total,messages30d:m.rows[0].total,subscription:p.rows[0] || {id:'starter',name:'Starter',status:'trial'}});
});

app.get('/v1/whatsapp/sessions',auth,async (req,res)=>{
  const r=await pool.query('SELECT id,label,phone_number,engine,status,last_error,created_at,updated_at FROM wa_sessions WHERE workspace_id=$1 ORDER BY created_at DESC',[req.actor.workspaceId]);
  res.json({sessions:r.rows});
});
app.post('/v1/whatsapp/sessions',auth,roles(['owner','admin']),async (req,res)=>{
  const sid=newId(), name='mf_'+sid.replace(/-/g,''), label=String(req.body.label || 'واتساب الشركة').trim().slice(0,80);
  const webhook={url:String(process.env.PUBLIC_API_URL).replace(/\/+$/,'')+'/webhooks/waha',events:['message','session.status'],hmac:{key:process.env.WAHA_WEBHOOK_HMAC_KEY},customHeaders:[{name:'X-MF-Webhook-Secret',value:process.env.WAHA_WEBHOOK_HEADER_SECRET}],retries:{policy:'exponential',delaySeconds:2,attempts:8}};
  try {
    const remote=await waha('POST','/api/sessions',{name,config:{webhooks:[webhook],noweb:{store:{enabled:true,fullSync:false}}}});
    // Explicitly start newly created or restored sessions that WAHA reports as STOPPED.
    let started=remote;
    if (String(remote?.status || '').toUpperCase()==='STOPPED' || !remote?.status) {
      started=await waha('POST','/api/sessions/'+encodeURIComponent(name)+'/start',{});
    }
    const r=await pool.query('INSERT INTO wa_sessions(id,workspace_id,waha_name,label,engine,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,label,phone_number,engine,status,created_at',
      [sid,req.actor.workspaceId,name,label,String(process.env.WAHA_DEFAULT_ENGINE || 'NOWEB'),String(started?.status || 'STARTING')]);
    res.status(201).json({session:r.rows[0]});
  } catch(e) { console.error('[Create session]',e.message); res.status(502).json({error:'تعذر إنشاء جلسة واتساب: '+e.message}); }
});
app.get('/v1/whatsapp/sessions/:id',auth,async (req,res)=>{
  const row=await getSession(req.actor.workspaceId,req.params.id);
  if (!row) return res.status(404).json({error:'الجلسة غير موجودة.'});
  try {
    let remote=await waha('GET','/api/sessions/'+encodeURIComponent(row.waha_name));
    // Recover a stopped session during polling instead of leaving the UI stuck forever.
    if (String(remote?.status || '').toUpperCase()==='STOPPED') {
      await waha('POST','/api/sessions/'+encodeURIComponent(row.waha_name)+'/start',{});
      remote=await waha('GET','/api/sessions/'+encodeURIComponent(row.waha_name));
    }
    const status=String(remote?.status || row.status), phone=String(remote?.me?.id || '').split('@')[0].split(':')[0];
    await pool.query('UPDATE wa_sessions SET status=$1,phone_number=$2,updated_at=NOW() WHERE id=$3',[status,phone,row.id]);
    res.json({id:row.id,label:row.label,status,phoneNumber:phone,engine:remote?.engine?.engine || row.engine});
  } catch(e) { res.status(502).json({error:'تعذر قراءة حالة الجلسة: '+e.message}); }
});
app.post('/v1/whatsapp/sessions/:id/sync',auth,async (req,res)=>{
  const session=await getSession(req.actor.workspaceId,req.params.id);
  if (!session) return res.status(404).json({error:'الجلسة غير موجودة.'});
  if (!['WORKING','CONNECTED'].includes(String(session.status).toUpperCase())) return res.status(409).json({error:'يجب أن يكون واتساب متصلًا قبل مزامنة المحادثات.'});
  const limit=Math.max(1,Math.min(100,Number(req.body?.limit)||100));
  const offset=Math.max(0,Number(req.body?.offset)||0);
  try {
    const route='/api/'+encodeURIComponent(session.waha_name)+'/chats/overview?limit='+limit+'&offset='+offset;
    const remote=await waha('GET',route);
    const chats=Array.isArray(remote)?remote:(remote?.chats || remote?.data || []);
    let imported=0, messagesImported=0;
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      for (const chat of chats) {
        const chatId=String(chat?.id || chat?.chatId || '');
        if (!chatId || chatId==='status@broadcast' || chatId.endsWith('@newsletter')) continue;
        const last=chat.lastMessage || null;
        const contact=await upsertContact(client,session,chatId,chat.name || chat.pushName || last?.pushName || 'عميل');
        if (last) {
          const body=String(last.body || last.caption || (last.hasMedia ? '[مرفق]' : '')).trim();
          const rawId=last.id;
          const wamid=typeof rawId==='string'?rawId:(rawId?._serialized || rawId?.id || 'sync-'+String(last.timestamp || Date.now())+'-'+chatId);
          if (body) {
            const timestamp=Number(last.timestamp);
            const sentAt=Number.isFinite(timestamp)&&timestamp>0?new Date(timestamp*1000):new Date();
            const saved=await client.query(
              "INSERT INTO messages(id,workspace_id,session_id,contact_id,wamid,direction,message_type,body,status,sent_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(session_id,wamid) DO NOTHING RETURNING id",
              [newId(),session.workspace_id,session.id,contact.id,String(wamid),last.fromMe?'outbound':'inbound',String(last.type || (last.hasMedia?'media':'text')),body,last.fromMe?'sent':'received',sentAt]);
            if (saved.rowCount) messagesImported++;
          }
        }
        imported++;
      }
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    res.json({ok:true,imported,messagesImported,offset,nextOffset:offset+chats.length,hasMore:chats.length===limit});
  } catch(e) {
    console.error('[Chat sync]',e.message);
    res.status(502).json({error:'تعذرت مزامنة محادثات واتساب: '+e.message});
  }
});

app.get('/v1/whatsapp/sessions/:id/qr',auth,async (req,res)=>{
  const row=await getSession(req.actor.workspaceId,req.params.id);
  if (!row) return res.status(404).json({error:'الجلسة غير موجودة.'});
  try {
    const base=String(process.env.WAHA_URL).replace(/\/+$/,'');
    const r=await fetch(base+'/api/'+encodeURIComponent(row.waha_name)+'/auth/qr',{headers:wahaHeaders({Accept:'image/png'}),signal:AbortSignal.timeout(15000)});
    if (!r.ok) return res.status(r.status).json({error:await r.text() || 'QR غير جاهز بعد.'});
    const data=Buffer.from(await r.arrayBuffer());
    if (data.length<100) return res.status(202).json({waiting:true});
    res.json({dataUrl:'data:'+(r.headers.get('content-type') || 'image/png')+';base64,'+data.toString('base64')});
  } catch(e) { res.status(502).json({error:'تعذر جلب رمز الربط: '+e.message}); }
});
app.post('/v1/whatsapp/sessions/:id/restart',auth,roles(['owner','admin']),async (req,res)=>{
  const row=await getSession(req.actor.workspaceId,req.params.id);
  if (!row) return res.status(404).json({error:'الجلسة غير موجودة.'});
  try { await waha('POST','/api/sessions/'+encodeURIComponent(row.waha_name)+'/restart',{}); await pool.query("UPDATE wa_sessions SET status='STARTING',updated_at=NOW() WHERE id=$1",[row.id]); res.json({ok:true}); }
  catch(e) { res.status(502).json({error:e.message}); }
});
app.delete('/v1/whatsapp/sessions/:id',auth,roles(['owner','admin']),async (req,res)=>{
  const row=await getSession(req.actor.workspaceId,req.params.id);
  if (!row) return res.status(404).json({error:'الجلسة غير موجودة.'});
  try { await waha('POST','/api/sessions/'+encodeURIComponent(row.waha_name)+'/logout',{}); } catch(e) { console.warn('[Logout]',e.message); }
  await pool.query('DELETE FROM wa_sessions WHERE id=$1 AND workspace_id=$2',[row.id,req.actor.workspaceId]);
  res.json({ok:true});
});

app.get('/v1/secretaries',auth,async(req,res)=>{
  try {
    await ensureDefaultSecretary(req.actor.workspaceId);
    const r=await pool.query(
      'SELECT id,name,category,description,system_prompt,keywords,enabled,is_default,created_at,updated_at FROM ai_secretaries WHERE workspace_id=$1 ORDER BY is_default DESC,created_at ASC',
      [req.actor.workspaceId]
    );
    res.json({secretaries:r.rows});
  } catch(e) { console.error('[Secretaries list]',e.message); res.status(500).json({error:'تعذر تحميل السكرتيرين.'}); }
});
app.post('/v1/secretaries',auth,roles(['owner','admin']),async(req,res)=>{
  const x=req.body||{},name=String(x.name||'').trim().slice(0,100);
  const category=String(x.category||'').trim().slice(0,80);
  const description=String(x.description||'').trim().slice(0,1200);
  const prompt=String(x.systemPrompt||'').trim().slice(0,12000);
  const keywords=Array.isArray(x.keywords)?x.keywords.map(v=>String(v).trim().slice(0,60)).filter(Boolean).slice(0,40):[];
  if(name.length<2||category.length<2||description.length<8||prompt.length<10)
    return res.status(400).json({error:'أدخل اسم السكرتير وتصنيفه ووصفه وتعليماته التفصيلية.'});
  try {
    const r=await pool.query(
      'INSERT INTO ai_secretaries(id,workspace_id,name,category,description,system_prompt,keywords) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,category,description,system_prompt,keywords,enabled,is_default,created_at',
      [newId(),req.actor.workspaceId,name,category,description,prompt,keywords]
    );
    res.status(201).json({secretary:r.rows[0]});
  } catch(e) {
    if(e.code==='23505') return res.status(409).json({error:'يوجد سكرتير بهذا الاسم بالفعل.'});
    console.error('[Secretary create]',e.message);res.status(500).json({error:'تعذر إنشاء السكرتير.'});
  }
});
app.patch('/v1/secretaries/:id',auth,roles(['owner','admin']),async(req,res)=>{
  const x=req.body||{},name=String(x.name||'').trim().slice(0,100),category=String(x.category||'').trim().slice(0,80);
  const description=String(x.description||'').trim().slice(0,1200),prompt=String(x.systemPrompt||'').trim().slice(0,12000);
  const keywords=Array.isArray(x.keywords)?x.keywords.map(v=>String(v).trim().slice(0,60)).filter(Boolean).slice(0,40):[];
  if(name.length<2||category.length<2||description.length<8||prompt.length<10)return res.status(400).json({error:'أكمل بيانات السكرتير.'});
  const r=await pool.query(
    'UPDATE ai_secretaries SET name=$1,category=$2,description=$3,system_prompt=$4,keywords=$5,updated_at=NOW() WHERE id=$6 AND workspace_id=$7 RETURNING id,name,category,description,system_prompt,keywords,enabled,is_default',
    [name,category,description,prompt,keywords,req.params.id,req.actor.workspaceId]
  );
  if(!r.rowCount)return res.status(404).json({error:'السكرتير غير موجود.'});
  res.json({secretary:r.rows[0]});
});
app.delete('/v1/secretaries/:id',auth,roles(['owner','admin']),async(req,res)=>{
  const r=await pool.query('DELETE FROM ai_secretaries WHERE id=$1 AND workspace_id=$2 AND is_default=FALSE RETURNING id',[req.params.id,req.actor.workspaceId]);
  if(!r.rowCount)return res.status(404).json({error:'السكرتير غير موجود أو لا يمكن حذف السكرتير العام.'});
  await pool.query("UPDATE contacts SET secretary_assignment='auto',secretary_category='general',secretary_confidence=0,secretary_reason='تم حذف السكرتير السابق.' WHERE workspace_id=$1 AND secretary_id IS NULL",[req.actor.workspaceId]);
  res.json({ok:true});
});

app.get('/v1/conversations',auth,async (req,res)=>{
  const r=await pool.query('SELECT c.id,c.session_id,c.chat_id,c.phone_number,c.display_name,c.is_paused,c.marketing_opt_in,c.secretary_id,c.secretary_assignment,c.secretary_category,c.secretary_confidence,c.secretary_reason,sec.name AS secretary_name,c.last_message_at,s.label AS session_label,s.status AS session_status,m.body AS last_message,m.direction AS last_direction,m.sent_at AS last_message_time FROM contacts c JOIN wa_sessions s ON s.id=c.session_id LEFT JOIN ai_secretaries sec ON sec.id=c.secretary_id LEFT JOIN LATERAL(SELECT body,direction,sent_at FROM messages WHERE contact_id=c.id ORDER BY sent_at DESC LIMIT 1)m ON TRUE WHERE c.workspace_id=$1 ORDER BY c.last_message_at DESC NULLS LAST LIMIT 150',[req.actor.workspaceId]);
  res.json({conversations:r.rows});
});
app.patch('/v1/conversations/:id/secretary',auth,async(req,res)=>{
  const contact=await getContact(req.actor.workspaceId,req.params.id);
  if(!contact)return res.status(404).json({error:'المحادثة غير موجودة.'});
  const secretaryId=String(req.body?.secretaryId||'').trim();
  if(!secretaryId){
    await pool.query("UPDATE contacts SET secretary_id=NULL,secretary_assignment='auto',secretary_category='general',secretary_confidence=0,secretary_reason='تم تفعيل التوجيه الذكي التلقائي.' WHERE id=$1",[contact.id]);
    return res.json({ok:true,assignment:'auto'});
  }
  const secretary=(await pool.query('SELECT id,name,category FROM ai_secretaries WHERE id=$1 AND workspace_id=$2 AND enabled=TRUE',[secretaryId,req.actor.workspaceId])).rows[0];
  if(!secretary)return res.status(400).json({error:'السكرتير المحدد غير متاح في مساحة العمل.'});
  await pool.query(
    "UPDATE contacts SET secretary_id=$1,secretary_assignment='manual',secretary_category=$2,secretary_confidence=1,secretary_reason='تخصيص يدوي من لوحة التحكم.' WHERE id=$3",
    [secretary.id,secretary.category,contact.id]
  );
  res.json({ok:true,assignment:'manual',secretary});
});

app.get('/v1/conversations/:id/messages',auth,async (req,res)=>{
  const c=await getContact(req.actor.workspaceId,req.params.id);
  if (!c) return res.status(404).json({error:'المحادثة غير موجودة.'});
  if (req.query.sync==='1') {
    const pendingVoices=[];
    try {
      const route='/api/'+encodeURIComponent(c.waha_name)+'/chats/'+encodeURIComponent(c.chat_id)+'/messages?limit=100&downloadMedia=true&downloadMediaMimetypes=audio';
      const remote=await waha('GET',route), rows=Array.isArray(remote)?remote:(remote?.messages || remote?.data || []);
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        for (const msg of rows) {
          const voice=isVoiceMessage(msg);
          const rawId=msg.id, wamid=typeof rawId==='string'?rawId:(rawId?._serialized || rawId?.id || 'sync-'+String(msg.timestamp || Date.now())+'-'+c.chat_id);
          const body=voice&&!msg.fromMe?'🎤 رسالة صوتية (جارٍ تحويلها إلى نص...)':String(msg.body || msg.caption || (msg.hasMedia?'[مرفق]':'')).trim();
          if (!body && !voice) continue;
          const timestamp=Number(msg.timestamp), sentAt=Number.isFinite(timestamp)&&timestamp>0?new Date(timestamp*1000):new Date();
          const mediaPath=wahaMediaPath(msg.media?.url || msg.mediaUrl || '');
          const mime=String(msg.media?.mimetype || (voice?'audio/ogg':'')).toLowerCase().split(';')[0];
          const messageType=voice?'ptt':String(msg.type || (msg.hasMedia?'media':'text'));
          const saved=await client.query(
            "INSERT INTO messages(id,workspace_id,session_id,contact_id,wamid,direction,message_type,body,status,sent_at,media_url,media_mimetype,transcription_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(session_id,wamid) DO NOTHING RETURNING id",
            [newId(),c.workspace_id,c.session_id,c.id,String(wamid),msg.fromMe?'outbound':'inbound',messageType,body,msg.fromMe?'sent':'received',sentAt,mediaPath,mime,voice&&!msg.fromMe?'pending':'none']
          );
          let rowId=saved.rows[0]?.id;
          if (!rowId && voice && !msg.fromMe) {
            const existing=await client.query("SELECT id,transcription_status FROM messages WHERE session_id=$1 AND wamid=$2",[c.session_id,String(wamid)]);
            rowId=existing.rows[0]?.id;
            if (rowId && existing.rows[0].transcription_status!=='completed') {
              await client.query("UPDATE messages SET media_url=CASE WHEN $1='' THEN media_url ELSE $1 END,media_mimetype=CASE WHEN $2='' THEN media_mimetype ELSE $2 END WHERE id=$3",[mediaPath,mime,rowId]);
            } else {
              rowId=null;
            }
          }
          if (rowId && voice && !msg.fromMe) pendingVoices.push({id:rowId,payload:msg});
        }
        await client.query('UPDATE contacts SET last_message_at=COALESCE((SELECT MAX(sent_at) FROM messages WHERE contact_id=$1),last_message_at) WHERE id=$1',[c.id]);
        await client.query('COMMIT');
      } catch(e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
      if (pendingVoices.length) {
        const session=await getSession(c.workspace_id,c.session_id);
        if (session) for (const item of pendingVoices) {
          setImmediate(()=>processIncomingVoice(session,c,item.id,item.payload).catch(e=>console.error('[Voice history worker]',e.message)));
        }
      }
    } catch(e) { console.error('[Message history sync]',e.message); }
  }
  const r=await pool.query("SELECT id,direction,message_type,body,status,sent_at,media_mimetype,transcription_status,(media_url<>'' OR message_type IN ('ptt','audio')) AS has_media FROM messages WHERE contact_id=$1 ORDER BY sent_at ASC LIMIT 500",[c.id]);
  res.json({contact:{id:c.id,name:c.display_name,phoneNumber:c.phone_number,isPaused:c.is_paused},messages:r.rows});
});
app.get('/v1/conversations/:id/messages/:messageId/media',auth,async(req,res)=>{
  const contact=await getContact(req.actor.workspaceId,req.params.id);
  if(!contact)return res.status(404).json({error:'المحادثة غير موجودة.'});
  const row=(await pool.query(
    "SELECT wamid,message_type,media_url,media_mimetype FROM messages WHERE id=$1 AND contact_id=$2 AND workspace_id=$3",
    [req.params.messageId,contact.id,req.actor.workspaceId]
  )).rows[0];
  if(!row)return res.status(404).json({error:'الرسالة غير موجودة.'});
  let mediaPath=wahaMediaPath(row.media_url);
  try {
    if(!mediaPath && ['ptt','audio'].includes(String(row.message_type||'').toLowerCase())) {
      const route='/api/'+encodeURIComponent(contact.waha_name)+'/chats/'+encodeURIComponent(contact.chat_id)+'/messages/'+encodeURIComponent(row.wamid)+'?downloadMedia=true&downloadMediaMimetypes=audio';
      const hydrated=await waha('GET',route);
      mediaPath=wahaMediaPath(hydrated?.media?.url || hydrated?.mediaUrl || '');
      const mime=String(hydrated?.media?.mimetype || row.media_mimetype || 'audio/ogg').toLowerCase().split(';')[0];
      if(mediaPath) await pool.query("UPDATE messages SET media_url=$1,media_mimetype=$2 WHERE id=$3",[mediaPath,mime,req.params.messageId]);
    }
    if(!mediaPath)return res.status(404).json({error:'ملف الصوت غير متاح.'});
    const base=String(process.env.WAHA_URL||'').replace(/\/+$/,'');
    const remote=await fetch(base+mediaPath,{headers:{'X-Api-Key':process.env.WAHA_API_KEY},signal:AbortSignal.timeout(60000)});
    if(!remote.ok)return res.status(remote.status).json({error:'تعذر تحميل الملف الصوتي.'});
    const bytes=Buffer.from(await remote.arrayBuffer());
    res.setHeader('Content-Type',row.media_mimetype || remote.headers.get('content-type') || 'audio/ogg');
    res.setHeader('Content-Length',String(bytes.length));
    res.setHeader('Cache-Control','private, no-store');
    res.status(200).send(bytes);
  } catch(e) { console.error('[Voice media proxy]',e.message);res.status(502).json({error:'تعذر تحميل الملف الصوتي.'}); }
});

app.post('/v1/conversations/:id/messages',auth,async (req,res)=>{
  const c=await getContact(req.actor.workspaceId,req.params.id), text=String(req.body.text || '').trim();
  if (!c) return res.status(404).json({error:'المحادثة غير موجودة.'});
  if (!text || text.length>4000) return res.status(400).json({error:'الرسالة فارغة أو أطول من المسموح.'});
  try {
    const sent=await waha('POST','/api/sendText',{session:c.waha_name,chatId:c.chat_id,text});
    await pool.query("INSERT INTO messages(id,workspace_id,session_id,contact_id,wamid,direction,message_type,body,status) VALUES($1,$2,$3,$4,$5,'outbound','text',$6,'sent') ON CONFLICT(session_id,wamid) DO NOTHING",
      [newId(),req.actor.workspaceId,c.session_id,c.id,String(sent?.id || 'manual-'+newId()),text]);
    await pool.query("UPDATE contacts SET is_paused=TRUE,paused_reason='human_takeover' WHERE id=$1",[c.id]);
    res.status(201).json({ok:true});
  } catch(e) { res.status(502).json({error:'تعذر إرسال الرسالة: '+e.message}); }
});
app.post('/v1/conversations/:id/pause',auth,async (req,res)=>{
  const c=await getContact(req.actor.workspaceId,req.params.id); if (!c) return res.status(404).json({error:'المحادثة غير موجودة.'});
  await pool.query("UPDATE contacts SET is_paused=TRUE,paused_reason='human_takeover' WHERE id=$1",[c.id]); res.json({ok:true,paused:true});
});
app.post('/v1/conversations/:id/resume',auth,async (req,res)=>{
  const c=await getContact(req.actor.workspaceId,req.params.id); if (!c) return res.status(404).json({error:'المحادثة غير موجودة.'});
  await pool.query("UPDATE contacts SET is_paused=FALSE,paused_reason='' WHERE id=$1",[c.id]); res.json({ok:true,paused:false});
});


app.get('/v1/contacts',auth,async(req,res)=>{
 const limit=Math.max(1,Math.min(5000,Number(req.query.limit||5000)));
 const r=await pool.query('SELECT id,session_id,phone_number,display_name,marketing_opt_in,marketing_opt_in_at,marketing_opt_in_source FROM contacts WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT $2',[req.actor.workspaceId,limit]);
 res.json({contacts:r.rows});
});
app.post('/v1/contacts/import',auth,roles(['owner','admin']),async(req,res)=>{
 const sessionId=String(req.body?.sessionId||''), source=String(req.body?.consentSource||'').trim().slice(0,160);
 const phones=Array.isArray(req.body?.phones)?req.body.phones:[];
 if(req.body?.confirmOptIn!==true||source.length<3)return res.status(400).json({error:'يلزم تأكيد الموافقة وتحديد مصدرها.'});
 if(!phones.length||phones.length>5000)return res.status(400).json({error:'أدخل من 1 إلى 5000 رقم في كل عملية استيراد.'});
 const session=await getSession(req.actor.workspaceId,sessionId);
 if(!session||!['WORKING','CONNECTED'].includes(String(session.status).toUpperCase()))return res.status(400).json({error:'اختر رقم واتساب متصلًا.'});
 const client=await pool.connect();let imported=0,invalid=0;
 try{
  await client.query('BEGIN');
  for(const raw of phones){
   const phone=String(raw||'').replace(/[^0-9]/g,'');
   if(phone.length<8||phone.length>15){invalid++;continue;}
   const chatId=phone+'@c.us';
   await client.query("INSERT INTO contacts(id,workspace_id,session_id,chat_id,phone_number,display_name,marketing_opt_in,marketing_opt_in_at,marketing_opt_in_source) VALUES($1,$2,$3,$4,$5,$5,TRUE,NOW(),$6) ON CONFLICT(session_id,chat_id) DO UPDATE SET marketing_opt_in=TRUE,marketing_opt_in_at=NOW(),marketing_opt_in_source=EXCLUDED.marketing_opt_in_source",
    [newId(),req.actor.workspaceId,sessionId,chatId,phone,source]);
   imported++;
  }
  await client.query('COMMIT');res.status(201).json({ok:true,imported,invalid});
 }catch(e){await client.query('ROLLBACK');console.error('[Contact import]',e.message);res.status(500).json({error:'تعذر استيراد جهات الاتصال.'});}
 finally{client.release();}
});
app.patch('/v1/contacts/:id/marketing-consent',auth,roles(['owner','admin']),async (req,res)=>{
 const enabled=req.body?.enabled===true, source=String(req.body?.source||'').trim().slice(0,160);
 const r=await pool.query('UPDATE contacts SET marketing_opt_in=$1,marketing_opt_in_at=CASE WHEN $1 THEN NOW() ELSE NULL END,marketing_opt_in_source=$2 WHERE id=$3 AND workspace_id=$4 RETURNING id,phone_number,marketing_opt_in,marketing_opt_in_at',[enabled,enabled?source:'',req.params.id,req.actor.workspaceId]);
 if(!r.rowCount) return res.status(404).json({error:'جهة الاتصال غير موجودة.'});
 res.json({contact:r.rows[0]});
});
app.get('/v1/campaigns',auth,async (req,res)=>{
 const r=await pool.query('SELECT c.id,c.title,c.status,c.total_count,c.sent_count,c.failed_count,c.delay_ms,c.secretary_id,s.name AS secretary_name,c.created_at,c.updated_at FROM campaigns c LEFT JOIN ai_secretaries s ON s.id=c.secretary_id WHERE c.workspace_id=$1 ORDER BY c.created_at DESC LIMIT 100',[req.actor.workspaceId]);
 res.json({campaigns:r.rows});
});
app.get('/v1/campaigns/:id/recipients',auth,async(req,res)=>{
 const search=String(req.query.search||'').trim().slice(0,160), limit=Math.max(1,Math.min(200,Number(req.query.limit||100)));
 const exists=await pool.query('SELECT id FROM campaigns WHERE id=$1 AND workspace_id=$2',[req.params.id,req.actor.workspaceId]);
 if(!exists.rowCount)return res.status(404).json({error:'الحملة غير موجودة.'});
 const r=await pool.query(`SELECT cr.id,cr.reference_code,cr.sent_body,cr.provider_message_id,cr.status,cr.error,cr.sent_at,c.phone_number,c.display_name
  FROM campaign_recipients cr JOIN contacts c ON c.id=cr.contact_id AND c.workspace_id=cr.workspace_id
  WHERE cr.campaign_id=$1 AND cr.workspace_id=$2 AND ($3='' OR cr.reference_code ILIKE '%'||$3||'%' OR c.phone_number ILIKE '%'||$3||'%' OR c.display_name ILIKE '%'||$3||'%' OR cr.sent_body ILIKE '%'||$3||'%')
  ORDER BY cr.sent_at DESC NULLS LAST, c.phone_number LIMIT $4`,[req.params.id,req.actor.workspaceId,search,limit]);
 res.json({recipients:r.rows});
});
const campaignWorkers=new Set(), sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function runCampaign(campaignId,workspaceId) {
 if(campaignWorkers.has(campaignId)) return; campaignWorkers.add(campaignId);
 try {
  const c=(await pool.query('SELECT * FROM campaigns WHERE id=$1 AND workspace_id=$2',[campaignId,workspaceId])).rows[0];
  if(!c||!['queued','running'].includes(c.status)) return;
  await pool.query("UPDATE campaigns SET status='running',updated_at=NOW() WHERE id=$1",[campaignId]);
  while(true) {
   const state=(await pool.query('SELECT status,delay_ms FROM campaigns WHERE id=$1 AND workspace_id=$2',[campaignId,workspaceId])).rows[0];
   if(!state||state.status==='cancelled'||state.status==='paused') break;
   const item=(await pool.query("SELECT cr.id AS rid,cr.contact_id,cr.session_id,cr.reference_code,cr.sent_body,c.chat_id,c.marketing_opt_in,s.waha_name,s.status AS session_status FROM campaign_recipients cr JOIN contacts c ON c.id=cr.contact_id AND c.workspace_id=cr.workspace_id JOIN wa_sessions s ON s.id=cr.session_id AND s.workspace_id=cr.workspace_id WHERE cr.campaign_id=$1 AND cr.status='queued' ORDER BY cr.id LIMIT 1",[campaignId])).rows[0];
   if(!item){await pool.query("UPDATE campaigns SET status='completed',updated_at=NOW() WHERE id=$1 AND status='running'",[campaignId]);break;}
   if(!item.marketing_opt_in||!['WORKING','CONNECTED'].includes(String(item.session_status).toUpperCase())){
    await pool.query("UPDATE campaign_recipients SET status='skipped',error='Consent missing or session disconnected.' WHERE id=$1",[item.rid]);continue;
   }
   try{
    let referenceCode=item.reference_code, finalBody=item.sent_body;
    if(!referenceCode){
     const seq=(await pool.query("SELECT nextval('message_reference_seq') AS n")).rows[0].n;
     referenceCode='MF-'+new Date().getFullYear()+'-'+String(seq).padStart(8,'0');
     finalBody=referenceCode+' - '+c.body;
     await pool.query("UPDATE campaign_recipients SET reference_code=$1,sent_body=$2 WHERE id=$3",[referenceCode,finalBody,item.rid]);
    }
    const sent=await waha('POST','/api/sendText',{session:item.waha_name,chatId:item.chat_id,text:finalBody});
    const providerId=String(sent?.id||'campaign-'+newId());
    await pool.query("INSERT INTO messages(id,workspace_id,session_id,contact_id,wamid,direction,message_type,body,status) VALUES($1,$2,$3,$4,$5,'outbound','text',$6,'sent') ON CONFLICT(session_id,wamid) DO NOTHING",[newId(),workspaceId,item.session_id,item.contact_id,providerId,finalBody]);
    await pool.query("UPDATE campaign_recipients SET provider_message_id=$1 WHERE id=$2",[providerId,item.rid]);
    await pool.query("UPDATE campaign_recipients SET status='sent',sent_at=NOW() WHERE id=$1",[item.rid]);
    await pool.query('UPDATE campaigns SET sent_count=sent_count+1,updated_at=NOW() WHERE id=$1',[campaignId]);
   }catch(e){
    await pool.query("UPDATE campaign_recipients SET status='failed',error=$1 WHERE id=$2",[String(e.message).slice(0,500),item.rid]);
    await pool.query("UPDATE campaigns SET failed_count=failed_count+1,status='paused',updated_at=NOW() WHERE id=$1",[campaignId]);
    console.error('[Campaign paused after provider error]',campaignId,e.message);break;
   }
   await sleep(state.delay_ms);
  }
 }catch(e){console.error('[Campaign worker]',campaignId,e.message);await pool.query("UPDATE campaigns SET status='failed',updated_at=NOW() WHERE id=$1",[campaignId]).catch(()=>{});}
 finally{campaignWorkers.delete(campaignId);}
}
app.post('/v1/campaigns',auth,roles(['owner','admin']),async (req,res)=>{
 const title=String(req.body?.title||'').trim().slice(0,120), body=String(req.body?.body||'').trim(), delay=Math.max(5000,Math.min(60000,Number(req.body?.delayMs||10000)));
 const secretaryId=String(req.body?.secretaryId||'').trim()||null;
 if(secretaryId){
  const valid=await pool.query('SELECT id FROM ai_secretaries WHERE id=$1 AND workspace_id=$2 AND enabled=TRUE',[secretaryId,req.actor.workspaceId]);
  if(!valid.rowCount)return res.status(400).json({error:'السكرتير المحدد للحملة غير موجود أو غير مفعّل.'});
 }
 if(!title||!body||body.length>4000)return res.status(400).json({error:'أدخل اسم الحملة ورسالة صحيحة لا تتجاوز 4000 حرف.'});
 if(req.body?.confirmOptIn!==true)return res.status(400).json({error:'أكد أن جميع المستلمين وافقوا صراحةً على استقبال الرسائل.'});
 const ids=Array.isArray(req.body?.contactIds)?[...new Set(req.body.contactIds.map(String))].slice(0,5000):[];
 if(req.body?.allOptedIn!==true&&!ids.length)return res.status(400).json({error:'حدد جهات اتصال لديها موافقة تسويقية مسجلة.'});
 const client=await pool.connect(), id=newId();
 try{
  await client.query('BEGIN');
  const recipients=req.body?.allOptedIn===true
   ? await client.query("SELECT c.id,c.session_id FROM contacts c JOIN wa_sessions s ON s.id=c.session_id WHERE c.workspace_id=$1 AND c.marketing_opt_in=TRUE AND s.status IN ('WORKING','CONNECTED') ORDER BY c.created_at LIMIT 5000",[req.actor.workspaceId])
   : await client.query("SELECT c.id,c.session_id FROM contacts c JOIN wa_sessions s ON s.id=c.session_id WHERE c.workspace_id=$1 AND c.id=ANY($2::uuid[]) AND c.marketing_opt_in=TRUE AND s.status IN ('WORKING','CONNECTED')",[req.actor.workspaceId,ids]);
  if(!recipients.rowCount){await client.query('ROLLBACK');return res.status(400).json({error:'لا توجد جهات اتصال مؤهلة: يلزم تسجيل الموافقة وربط رقم متصل.'});}
  await client.query("INSERT INTO campaigns(id,workspace_id,title,body,status,delay_ms,total_count,secretary_id) VALUES($1,$2,$3,$4,'queued',$5,$6,$7)",[id,req.actor.workspaceId,title,body,delay,recipients.rowCount,secretaryId]);
  for(const row of recipients.rows)await client.query("INSERT INTO campaign_recipients(id,campaign_id,workspace_id,contact_id,session_id) VALUES($1,$2,$3,$4,$5)",[newId(),id,req.actor.workspaceId,row.id,row.session_id]);
  await client.query('COMMIT');res.status(201).json({ok:true,campaign:{id,totalCount:recipients.rowCount,status:'queued',delayMs:delay}});
  setImmediate(()=>runCampaign(id,req.actor.workspaceId));
 }catch(e){await client.query('ROLLBACK');console.error('[Campaign create]',e.message);res.status(500).json({error:'تعذر إنشاء الحملة.'});}
 finally{client.release();}
});
app.post('/v1/campaigns/:id/pause',auth,roles(['owner','admin']),async(req,res)=>{
 const r=await pool.query("UPDATE campaigns SET status='paused',updated_at=NOW() WHERE id=$1 AND workspace_id=$2 AND status IN ('queued','running') RETURNING id,status",[req.params.id,req.actor.workspaceId]);
 if(!r.rowCount)return res.status(404).json({error:'الحملة غير موجودة أو لا يمكن إيقافها.'});res.json({ok:true,campaign:r.rows[0]});
});
app.post('/v1/campaigns/:id/resume',auth,roles(['owner','admin']),async(req,res)=>{
 const r=await pool.query("UPDATE campaigns SET status='queued',updated_at=NOW() WHERE id=$1 AND workspace_id=$2 AND status='paused' RETURNING id,status",[req.params.id,req.actor.workspaceId]);
 if(!r.rowCount)return res.status(404).json({error:'الحملة غير موجودة أو ليست متوقفة.'});res.json({ok:true,campaign:r.rows[0]});setImmediate(()=>runCampaign(req.params.id,req.actor.workspaceId));
});
app.post('/v1/campaigns/:id/cancel',auth,roles(['owner','admin']),async(req,res)=>{
 const r=await pool.query("UPDATE campaigns SET status='cancelled',updated_at=NOW() WHERE id=$1 AND workspace_id=$2 AND status IN ('queued','running','paused') RETURNING id,status",[req.params.id,req.actor.workspaceId]);
 if(!r.rowCount)return res.status(404).json({error:'الحملة غير موجودة أو انتهت.'});res.json({ok:true,campaign:r.rows[0]});
});

app.get('/v1/assistant/settings',auth,async (req,res)=>{
  const r=await pool.query("SELECT enabled,provider,model,base_url,system_prompt,(api_key_ciphertext<>'') AS has_api_key,updated_at FROM assistant_settings WHERE workspace_id=$1",[req.actor.workspaceId]);
  res.json({settings:r.rows[0] || null});
});
app.post('/v1/assistant/settings',auth,roles(['owner','admin']),async (req,res)=>{
  const x=req.body || {}, provider=['gemini','openai-compatible'].includes(x.provider)?x.provider:'openai-compatible';
  const model=String(x.model || '').trim().slice(0,120), base=String(x.baseUrl || '').trim().replace(/\/+$/,'').slice(0,300);
  const prompt=String(x.systemPrompt || '').trim().slice(0,6000), enabled=x.enabled===true;
  const current=await pool.query('SELECT api_key_ciphertext FROM assistant_settings WHERE workspace_id=$1',[req.actor.workspaceId]);
  const apiKey=String(x.apiKey || '').trim(), cipher=apiKey?encrypt(apiKey):(current.rows[0]?.api_key_ciphertext || '');
  if (enabled && provider==='openai-compatible' && (!base || !model)) return res.status(400).json({error:'أدخل عنوان محرك الذكاء الاصطناعي واسم النموذج قبل التفعيل.'});
  if (enabled && provider==='gemini' && !cipher) return res.status(400).json({error:'أدخل مفتاح Gemini قبل التفعيل.'});
  await pool.query("UPDATE assistant_settings SET enabled=$1,provider=$2,model=$3,base_url=$4,system_prompt=$5,api_key_ciphertext=$6,updated_at=NOW() WHERE workspace_id=$7",
    [enabled,provider,model,base,prompt || 'أنت مساعد خدمة عملاء محترف. لا تخترع معلومات أو أسعارًا.',cipher,req.actor.workspaceId]);
  res.json({ok:true,enabled,hasApiKey:Boolean(cipher)});
});

app.use((err,req,res,next)=>{
  console.error('[HTTP]',err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({error:'حدث خطأ غير متوقع في الخادم.'});
});
async function start() {
  const needed=['DATABASE_URL','JWT_SECRET','SECRET_ENCRYPTION_KEY'];
  for (const key of needed) if (!process.env[key]) throw new Error(key+' is required.');
  await pool.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
  await pool.query("INSERT INTO ai_secretaries(id,workspace_id,name,category,description,system_prompt,is_default) SELECT gen_random_uuid(),a.workspace_id,'السكرتير العام','general','السكرتير الافتراضي للمحادثات العامة.',a.system_prompt,TRUE FROM assistant_settings a WHERE NOT EXISTS (SELECT 1 FROM ai_secretaries s WHERE s.workspace_id=a.workspace_id AND s.is_default=TRUE) ON CONFLICT DO NOTHING");
  await pool.query("UPDATE assistant_settings SET model='gemini-3.8-flash',updated_at=NOW() WHERE provider='gemini' AND model IN ('gemini-2.5-flash','models/gemini-2.5-flash')");
  // Recover queued work after a process restart; campaign state is durable in PostgreSQL.
  await pool.query("UPDATE campaigns SET status='queued',updated_at=NOW() WHERE status='running'");
  const pending=(await pool.query("SELECT id,workspace_id FROM campaigns WHERE status='queued' ORDER BY created_at")).rows;
  app.listen(Number(process.env.PORT || 3000),'0.0.0.0',()=>{
    console.log('[Media First Platform API] listening.');
    for(const c of pending) setImmediate(()=>runCampaign(c.id,c.workspace_id));
  });
}
start().catch(e=>{console.error('[Startup]',e);process.exit(1);});
