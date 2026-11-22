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
async function waha(method,route,body) {
  const base=String(process.env.WAHA_URL || '').replace(/\/+$/,'');
  if (!base) throw new Error('WhatsApp gateway is not configured.');
  const response=await fetch(base+route,{method,headers:wahaHeaders(),body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
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
function verifyWebhook(raw,headers) {
  if (!same(headers['x-mf-webhook-secret'],process.env.WAHA_WEBHOOK_HEADER_SECRET)) return false;
  const expected=crypto.createHmac('sha512',process.env.WAHA_WEBHOOK_HMAC_KEY).update(raw).digest('hex');
  return same(headers['x-webhook-hmac'],expected);
}
async function aiCompletion(settings,history) {
  const messages=[{role:'system',content:settings.system_prompt}];
  for (const row of history) messages.push({role:row.direction==='inbound'?'user':'assistant',content:row.body});
  if (settings.provider==='gemini') {
    const key=decrypt(settings.api_key_ciphertext), model=settings.model || 'gemini-2.5-flash';
    if (!key) throw new Error('Missing Gemini API key.');
    const contents=messages.filter(m=>m.role!=='system').map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}));
    const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent?key='+encodeURIComponent(key),{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({systemInstruction:{parts:[{text:settings.system_prompt}]},contents,generationConfig:{temperature:0.4,maxOutputTokens:700}}),
      signal:AbortSignal.timeout(45000)
    });
    const data=await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(data.error?.message || 'Gemini request failed.');
    return String(data.candidates?.[0]?.content?.parts?.map(p=>p.text || '').join('') || '').trim();
  }
  const base=String(settings.base_url || '').replace(/\/+$/,''), model=String(settings.model || '');
  if (!base || !model) throw new Error('أدخل عنوان محرك الذكاء الاصطناعي واسم النموذج.');
  const key=decrypt(settings.api_key_ciphertext);
  const response=await fetch(base+'/chat/completions',{
    method:'POST',headers:Object.assign({'Content-Type':'application/json'},key?{Authorization:'Bearer '+key}:{}),
    body:JSON.stringify({model,messages,temperature:0.4,max_tokens:700}),signal:AbortSignal.timeout(60000)
  });
  const data=await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error?.message || 'AI provider request failed.');
  return String(data.choices?.[0]?.message?.content || '').trim();
}
async function assistantReply(session,contact) {
  const sr=await pool.query('SELECT * FROM assistant_settings WHERE workspace_id=$1',[session.workspace_id]), settings=sr.rows[0];
  if (!settings || !settings.enabled || contact.is_paused) return;
  const mr=await pool.query('SELECT direction,body FROM messages WHERE contact_id=$1 ORDER BY sent_at DESC LIMIT 14',[contact.id]);
  if (!mr.rowCount) return;
  try {
    const answer=await aiCompletion(settings,mr.rows.reverse());
    if (!answer) return;
    const sent=await waha('POST','/api/sendText',{session:session.waha_name,chatId:contact.chat_id,text:answer});
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
  const body=String(p.body || p.caption || '').trim();
  if (!body) return res.status(200).json({ok:true,ignored:true});
  const client=await pool.connect(); let contact;
  try {
    await client.query('BEGIN');
    contact=await upsertContact(client,session,chatId,p.pushName || p._data?.notifyName || 'عميل');
    const wamid=typeof p.id==='string'?p.id:(p.id?._serialized || p.id?.id || newId());
    await client.query("INSERT INTO messages(id,workspace_id,session_id,contact_id,wamid,direction,message_type,body,status,sent_at) VALUES($1,$2,$3,$4,$5,'inbound',$6,$7,'received',NOW()) ON CONFLICT(session_id,wamid) DO NOTHING",
      [newId(),session.workspace_id,session.id,contact.id,String(wamid),String(p.type || 'text'),body]);
    await client.query('COMMIT');
  } catch(e) {
    await client.query('ROLLBACK'); console.error('[Webhook]',e.message); return res.status(500).json({error:'Could not save message.'});
  } finally { client.release(); }
  res.status(200).json({ok:true});
  setImmediate(()=>assistantReply(session,contact).catch(e=>console.error('[Assistant]',e.message)));
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
    const remote=await waha('POST','/api/sessions',{name,config:{webhooks:[webhook]}});
    const r=await pool.query('INSERT INTO wa_sessions(id,workspace_id,waha_name,label,engine,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,label,phone_number,engine,status,created_at',
      [sid,req.actor.workspaceId,name,label,String(process.env.WAHA_DEFAULT_ENGINE || 'NOWEB'),String(remote?.status || 'STARTING')]);
    res.status(201).json({session:r.rows[0]});
  } catch(e) { console.error('[Create session]',e.message); res.status(502).json({error:'تعذر إنشاء جلسة واتساب: '+e.message}); }
});
app.get('/v1/whatsapp/sessions/:id',auth,async (req,res)=>{
  const row=await getSession(req.actor.workspaceId,req.params.id);
  if (!row) return res.status(404).json({error:'الجلسة غير موجودة.'});
  try {
    const remote=await waha('GET','/api/sessions/'+encodeURIComponent(row.waha_name));
    const status=String(remote?.status || row.status), phone=String(remote?.me?.id || '').split('@')[0].split(':')[0];
    await pool.query('UPDATE wa_sessions SET status=$1,phone_number=$2,updated_at=NOW() WHERE id=$3',[status,phone,row.id]);
    res.json({id:row.id,label:row.label,status,phoneNumber:phone,engine:remote?.engine?.engine || row.engine});
  } catch(e) { res.status(502).json({error:'تعذر قراءة حالة الجلسة: '+e.message}); }
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

app.get('/v1/conversations',auth,async (req,res)=>{
  const r=await pool.query('SELECT c.id,c.session_id,c.chat_id,c.phone_number,c.display_name,c.is_paused,c.last_message_at,s.label AS session_label,s.status AS session_status,m.body AS last_message,m.direction AS last_direction,m.sent_at AS last_message_time FROM contacts c JOIN wa_sessions s ON s.id=c.session_id LEFT JOIN LATERAL(SELECT body,direction,sent_at FROM messages WHERE contact_id=c.id ORDER BY sent_at DESC LIMIT 1)m ON TRUE WHERE c.workspace_id=$1 ORDER BY c.last_message_at DESC NULLS LAST LIMIT 150',[req.actor.workspaceId]);
  res.json({conversations:r.rows});
});
app.get('/v1/conversations/:id/messages',auth,async (req,res)=>{
  const c=await getContact(req.actor.workspaceId,req.params.id);
  if (!c) return res.status(404).json({error:'المحادثة غير موجودة.'});
  const r=await pool.query('SELECT id,direction,message_type,body,status,sent_at FROM messages WHERE contact_id=$1 ORDER BY sent_at ASC LIMIT 500',[c.id]);
  res.json({contact:{id:c.id,name:c.display_name,phoneNumber:c.phone_number,isPaused:c.is_paused},messages:r.rows});
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
  app.listen(Number(process.env.PORT || 3000),'0.0.0.0',()=>console.log('[Media First Platform API] listening.'));
}
start().catch(e=>{console.error('[Startup]',e);process.exit(1);});
