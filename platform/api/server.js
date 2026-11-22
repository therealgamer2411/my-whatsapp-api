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
  const r=await pool.query('SELECT c.id,c.session_id,c.chat_id,c.phone_number,c.display_name,c.is_paused,c.marketing_opt_in,c.last_message_at,s.label AS session_label,s.status AS session_status,m.body AS last_message,m.direction AS last_direction,m.sent_at AS last_message_time FROM contacts c JOIN wa_sessions s ON s.id=c.session_id LEFT JOIN LATERAL(SELECT body,direction,sent_at FROM messages WHERE contact_id=c.id ORDER BY sent_at DESC LIMIT 1)m ON TRUE WHERE c.workspace_id=$1 ORDER BY c.last_message_at DESC NULLS LAST LIMIT 150',[req.actor.workspaceId]);
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
 const r=await pool.query('SELECT id,title,status,total_count,sent_count,failed_count,delay_ms,created_at,updated_at FROM campaigns WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100',[req.actor.workspaceId]);
 res.json({campaigns:r.rows});
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
   const item=(await pool.query("SELECT cr.id AS rid,cr.contact_id,cr.session_id,c.chat_id,c.marketing_opt_in,s.waha_name,s.status AS session_status FROM campaign_recipients cr JOIN contacts c ON c.id=cr.contact_id AND c.workspace_id=cr.workspace_id JOIN wa_sessions s ON s.id=cr.session_id AND s.workspace_id=cr.workspace_id WHERE cr.campaign_id=$1 AND cr.status='queued' ORDER BY cr.id LIMIT 1",[campaignId])).rows[0];
   if(!item){await pool.query("UPDATE campaigns SET status='completed',updated_at=NOW() WHERE id=$1 AND status='running'",[campaignId]);break;}
   if(!item.marketing_opt_in||!['WORKING','CONNECTED'].includes(String(item.session_status).toUpperCase())){
    await pool.query("UPDATE campaign_recipients SET status='skipped',error='Consent missing or session disconnected.' WHERE id=$1",[item.rid]);continue;
   }
   try{
    const sent=await waha('POST','/api/sendText',{session:item.waha_name,chatId:item.chat_id,text:c.body});
    await pool.query("INSERT INTO messages(id,workspace_id,session_id,contact_id,wamid,direction,message_type,body,status) VALUES($1,$2,$3,$4,$5,'outbound','text',$6,'sent') ON CONFLICT(session_id,wamid) DO NOTHING",[newId(),workspaceId,item.session_id,item.contact_id,String(sent?.id||'campaign-'+newId()),c.body]);
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
  await client.query("INSERT INTO campaigns(id,workspace_id,title,body,status,delay_ms,total_count) VALUES($1,$2,$3,$4,'queued',$5,$6)",[id,req.actor.workspaceId,title,body,delay,recipients.rowCount]);
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
  app.listen(Number(process.env.PORT || 3000),'0.0.0.0',()=>console.log('[Media First Platform API] listening.'));
}
start().catch(e=>{console.error('[Startup]',e);process.exit(1);});
