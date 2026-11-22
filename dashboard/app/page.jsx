"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const PREF_KEY = "mf-secretary-dashboard-v1";
const DEFAULT_SETTINGS = {
  managerName: "المستشار أحمد",
  managerRole: "مدير متابعة العملاء",
  managerPhone: "",
  geminiModel: "gemini-3.8-flash",
  audioModel: "gemini-3.5-transcribe",
  ttsModel: "gemini-3.8-flash-tts",
  ttsVoice: "Kore",
  voiceReplyMode: "mirror",
  voiceReplyIncludeText: false,
  autoReplyEnabled: false
};

const NAV = [
  { id: "home", label: "الرئيسية", icon: "⌂" },
  { id: "connection", label: "واتساب", icon: "◉" },
  { id: "leads", label: "العملاء", icon: "♙" },
  { id: "settings", label: "الإعدادات", icon: "⚙" }
];

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function localPreferences() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PREF_KEY) || "{}");
    return {
      workerUrl: saved.workerUrl || "",
      settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) }
    };
  } catch {
    return { workerUrl: "", settings: DEFAULT_SETTINGS };
  }
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function Switch({ checked, onChange, title, description }) {
  return (
    <div className="switch-row">
      <div className="switch-copy">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </div>
      <button
        className={"switch " + (checked ? "is-on" : "")}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

export default function Home() {
  const [page, setPage] = useState("home");
  const [workerUrl, setWorkerUrl] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [apiKey, setApiKey] = useState("");
  const [health, setHealth] = useState(null);
  const [serviceEnabled, setServiceEnabled] = useState(true);
  const [serviceStarting, setServiceStarting] = useState(false);
  const [qr, setQr] = useState("");
  const [leads, setLeads] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [lastSync, setLastSync] = useState(null);

  useEffect(() => {
    const saved = localPreferences();
    setWorkerUrl(saved.workerUrl);
    setSettings(saved.settings);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(PREF_KEY, JSON.stringify({ workerUrl, settings }));
    } catch {}
  }, [workerUrl, settings]);

  const base = useMemo(() => cleanBaseUrl(workerUrl), [workerUrl]);

  const announce = useCallback((kind, text) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice((current) => current?.text === text ? null : current), 5200);
  }, []);

  const request = useCallback(async (route, options = {}) => {
    if (!base) throw new Error("أضف رابط خادم واتساب أولًا.");
    const headers = { ...(options.headers || {}) };
    // HTTP headers are Latin-1 only. Encode the UTF-8 admin token before placing it in a header.
    if (options.auth !== false && adminToken) {
      // Preserve the legacy Bearer format for ordinary ASCII tokens; encode Unicode safely.
      if (/^[\\x00-\\x7F]*$/.test(adminToken)) {
        headers.Authorization = "Bearer " + adminToken;
      } else {
        const bytes = new TextEncoder().encode(adminToken);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
        headers.Authorization = "Bearer-UTF8 " + btoa(binary);
      }
    }
    if (options.body) headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(base + route, {
        ...options,
        headers,
        signal: controller.signal,
        mode: "cors",
        cache: "no-store"
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 202) throw new Error(data.error || "تعذر تنفيذ الطلب (" + response.status + ").");
      return data;
    } finally {
      window.clearTimeout(timeout);
    }
  }, [base, adminToken]);

  const checkHealth = useCallback(async (showNotice = true) => {
    setBusy(true);
    try {
      const data = await request("/health", { method: "GET", auth: false });
      setHealth(data);
      if (typeof data.whatsappServiceEnabled === "boolean") setServiceEnabled(data.whatsappServiceEnabled);
      setServiceStarting(Boolean(data.whatsappInitializing));
      setLastSync(new Date());
      if (showNotice) announce("success", data.whatsapp === "ready" ? "اتصال واتساب يعمل." : "وصلنا إلى الخادم، لكن واتساب غير متصل بعد.");
      return data;
    } catch (error) {
      setHealth(null);
      if (showNotice) announce("error", error.message || "تعذر الوصول إلى الخادم.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [request, announce]);

  const refreshPrivateData = useCallback(async () => {
    if (!adminToken) {
      announce("warning", "أدخل رمز الإدارة أولًا لعرض QR والعملاء.");
      return;
    }
    setBusy(true);
    try {
      const [qrData, leadsData, conversationsData, settingsData] = await Promise.all([
        request("/admin/qr"),
        request("/admin/leads"),
        request("/admin/conversations"),
        request("/admin/settings")
      ]);
      setQr(qrData.qr || "");
      setLeads(leadsData.leads || []);
      setConversations(conversationsData.conversations || []);
      if (settingsData.settings) {
        setSettings((current) => ({
          ...current,
          managerName: settingsData.settings.managerName || current.managerName,
          managerRole: settingsData.settings.managerRole || current.managerRole,
          managerPhone: settingsData.settings.managerPhone || "",
          geminiModel: settingsData.settings.geminiModel || current.geminiModel,
          audioModel: settingsData.settings.audioModel || current.audioModel,
          ttsModel: settingsData.settings.ttsModel || current.ttsModel,
          ttsVoice: settingsData.settings.ttsVoice || current.ttsVoice,
          voiceReplyMode: settingsData.settings.voiceReplyMode || current.voiceReplyMode,
          voiceReplyIncludeText: Boolean(settingsData.settings.voiceReplyIncludeText),
          autoReplyEnabled: Boolean(settingsData.settings.autoReplyEnabled)
        }));
      }
      await checkHealth(false);
      setLastSync(new Date());
      announce("success", "تم تحديث بيانات لوحة التحكم.");
    } catch (error) {
      announce("error", error.message || "تعذر تحميل بيانات الخادم.");
    } finally {
      setBusy(false);
    }
  }, [request, adminToken, checkHealth, announce]);

  const saveSettings = async (event) => {
    event.preventDefault();
    if (!adminToken) {
      announce("warning", "أدخل رمز الإدارة الذي وضعته في ملف .env على خادم واتساب.");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        MANAGER_NAME: settings.managerName,
        MANAGER_ROLE: settings.managerRole,
        MANAGER_PHONE: settings.managerPhone,
        GEMINI_MODEL: settings.geminiModel,
        GEMINI_AUDIO_MODEL: settings.audioModel,
        GEMINI_TTS_MODEL: settings.ttsModel,
        GEMINI_TTS_VOICE: settings.ttsVoice,
        VOICE_REPLY_MODE: settings.voiceReplyMode,
        VOICE_REPLY_INCLUDE_TEXT: String(settings.voiceReplyIncludeText),
        AUTO_REPLY_ENABLED: String(settings.autoReplyEnabled)
      };
      if (apiKey.trim()) payload.GEMINI_API_KEY = apiKey.trim();

      const data = await request("/admin/settings", {
        method: "POST",
        body: JSON.stringify({ settings: payload })
      });
      setApiKey("");
      announce("success", data.automaticReplies
        ? "تم حفظ الإعدادات وتشغيل الرد الآلي."
        : "تم حفظ الإعدادات على خادم واتساب.");
      await checkHealth(false);
    } catch (error) {
      announce("error", error.message || "فشل حفظ الإعدادات.");
    } finally {
      setBusy(false);
    }
  };

  const loadQr = async () => {
    if (!adminToken) {
      announce("warning", "أدخل رمز الإدارة أولًا.");
      return;
    }
    setBusy(true);
    try {
      let data = null;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        data = await request("/admin/qr");
        if (data.qr || data.connected || !data.waiting) break;
        if (attempt < 79) await new Promise((resolve) => window.setTimeout(resolve, 1500));
      }
      setQr(data?.qr || "");
      await checkHealth(false);
      announce("success", data?.connected ? "واتساب متصل بالفعل." : data?.qr ? "رمز الربط جاهز للمسح." : "المحرك يعمل، لكنه لم يصدر QR حتى الآن. راجع حالة التشغيل والسجل.");
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy(false);
    }
  };

  const controlWhatsApp = async (action) => {
    if (!adminToken) {
      announce("warning", "أدخل رمز الإدارة أولًا.");
      return;
    }
    setBusy(true);
    try {
      const data = await request("/admin/whatsapp/" + action, { method: "POST" });
      setServiceEnabled(Boolean(data.enabled));
      setServiceStarting(Boolean(data.starting));
      if (action === "stop") {
        setQr("");
        setHealth((current) => current ? { ...current, whatsapp: "disconnected", whatsappServiceEnabled: false, whatsappInitializing: false } : current);
        announce("success", "تم إيقاف اتصال واتساب. لوحة التحكم والخادم ما زالا يعملان.");
      } else {
        announce("success", "أرسلنا أمر تشغيل واتساب. انتظر بدء المتصفح ثم اطلب عرض QR.");
        await checkHealth(false);
      }
    } catch (error) {
      announce("error", error.message || "تعذر التحكم في خدمة واتساب.");
    } finally {
      setBusy(false);
    }
  };

  const updateSetting = (key, value) => setSettings((current) => ({ ...current, [key]: value }));

  const downloadEnv = () => {
    const lines = {
      MANAGER_NAME: settings.managerName,
      MANAGER_ROLE: settings.managerRole,
      MANAGER_PHONE: settings.managerPhone,
      GEMINI_MODEL: settings.geminiModel,
      GEMINI_AUDIO_MODEL: settings.audioModel,
      GEMINI_TTS_MODEL: settings.ttsModel,
      GEMINI_TTS_VOICE: settings.ttsVoice,
      VOICE_REPLY_MODE: settings.voiceReplyMode,
      VOICE_REPLY_INCLUDE_TEXT: String(settings.voiceReplyIncludeText),
      AUTO_REPLY_ENABLED: String(settings.autoReplyEnabled)
    };
    if (apiKey.trim()) lines.GEMINI_API_KEY = apiKey.trim();
    const content = Object.entries(lines).map(([key, value]) => {
      const safe = String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
      return key + '="' + safe + '"';
    }).join("\n") + "\n";
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = ".env.secretary";
    link.click();
    URL.revokeObjectURL(url);
    announce("success", "تم تجهيز ملف إعدادات. انقله إلى مجلد محرك واتساب وادمج محتواه مع .env.");
  };

  const activePage = NAV.find((item) => item.id === page)?.label || "الرئيسية";
  const isConnected = health?.whatsapp === "ready";
  const connectionLabel = isConnected ? "متصل" : health?.whatsappLastError ? "فشل التشغيل" : serviceStarting ? "جارٍ التشغيل" : serviceEnabled ? "يعمل - بانتظار الربط" : "متوقف";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">MF</div>
          <div>
            <div className="brand-name">MEDIA FIRST</div>
            <div className="brand-subtitle">مكتب المهندس محمد عبداللاه</div>
          </div>
        </div>
        <div className="top-actions">
          <span className={"status-pill " + (isConnected ? "online" : "offline")}>
            <i />{connectionLabel}
          </span>
          <button className="icon-button" title="تحديث" onClick={() => checkHealth(true)}>↻</button>
        </div>
      </header>

      <section className="page-heading">
        <div>
          <div className="eyebrow">PERSONAL SECRETARY</div>
          <h1>{page === "home" ? "مساء الخير، محمد" : activePage}</h1>
          <p>{page === "home" ? "إدارة مساعدك الذكي ومحادثات العملاء من مكان واحد." : "تحكم مباشر في إعدادات السكرتير الذكي."}</p>
        </div>
        <div className="date-chip">{new Intl.DateTimeFormat("ar-EG", { day: "numeric", month: "short" }).format(new Date())}</div>
      </section>

      {notice ? <div className={"notice " + notice.kind}>{notice.text}</div> : null}

      {page === "home" && (
        <>
          <section className="hero-card">
            <div className="hero-copy">
              <span className="hero-kicker">AI OFFICE ASSISTANT</span>
              <h2>سكرتيرك الذكي،<br/>متاح لمتابعة عملائك.</h2>
              <p>يفهم الرسائل النصية والصوتية، يرد بطريقتك، ويحوّل العملاء الجاهزين إلى المستشار أحمد.</p>
              <button className="primary-button hero-button" onClick={() => setPage("connection")}>إعداد اتصال واتساب <span>←</span></button>
            </div>
            <div className="hero-orbit" aria-hidden="true">
              <div className="orbit-ring ring-one" />
              <div className="orbit-ring ring-two" />
              <div className="assistant-orb"><span>م</span><i /></div>
              <div className="orbit-dot dot-one" />
              <div className="orbit-dot dot-two" />
            </div>
          </section>

          <section className="section-block">
            <div className="section-title-row">
              <div><span className="eyebrow">OVERVIEW</span><h2>نظرة عامة</h2></div>
              <span className="muted-small">{lastSync ? "آخر تحديث " + lastSync.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }) : "لم يتم التحديث"}</span>
            </div>
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-icon blue">♙</div>
                <span>العملاء المحوّلون</span>
                <strong>{leads.length}</strong>
                <small>إلى المستشار أحمد</small>
              </div>
              <div className="stat-card">
                <div className="stat-icon green">◌</div>
                <span>المحادثات</span>
                <strong>{conversations.length}</strong>
                <small>سجل المحادثات المحفوظ</small>
              </div>
              <div className="stat-card">
                <div className="stat-icon amber">♫</div>
                <span>الرد الصوتي</span>
                <strong>{settings.voiceReplyMode === "never" ? "متوقف" : settings.voiceReplyMode === "always" ? "دائمًا" : "ذكي"}</strong>
                <small>{settings.voiceReplyMode === "mirror" ? "حسب نوع رسالة العميل" : "حسب اختيارك"}</small>
              </div>
            </div>
          </section>

          <section className="section-block">
            <div className="section-title-row">
              <div><span className="eyebrow">QUICK ACTIONS</span><h2>اختصارات</h2></div>
            </div>
            <div className="action-grid">
              <button className="action-card" onClick={() => setPage("connection")}><span className="action-icon whatsapp">◉</span><strong>ربط واتساب</strong><small>QR وحالة الاتصال</small><b>←</b></button>
              <button className="action-card" onClick={() => setPage("settings")}><span className="action-icon settings">⚙</span><strong>إعدادات الذكاء</strong><small>API والصوت والأرقام</small><b>←</b></button>
              <button className="action-card" onClick={() => { setPage("leads"); if (adminToken) refreshPrivateData(); }}><span className="action-icon leads">♙</span><strong>العملاء</strong><small>المتابعات والتحويلات</small><b>←</b></button>
            </div>
          </section>

          <section className="callout">
            <div className="callout-icon">✦</div>
            <div><strong>تحكم آمن في الردود</strong><p>الرد التلقائي متوقف افتراضيًا إلى أن تختبر الاتصال وتؤكد بيانات المستشار أحمد.</p></div>
          </section>
        </>
      )}

      {page === "connection" && (
        <section className="content-stack">
          <div className="panel-card">
            <div className="panel-title">
              <div><span className="eyebrow">WHATSAPP LINK</span><h2>ربط رقمك الشخصي</h2></div>
              <span className={"status-pill " + (isConnected ? "online" : "offline")}><i />{connectionLabel}</span>
            </div>
            <p className="panel-description">اربط رقمك الحالي كجهاز مرتبط. ستظل تستخدم تطبيق واتساب على هاتفك كالمعتاد.</p>
            {health?.whatsappLastError && <p className="notice error" role="alert">تعذر تشغيل واتساب: {health.whatsappLastError}</p>}
            <Field label="رابط محرك واتساب" hint="عنوان HTTPS للخادم الذي يشغّل محرك WhatsApp Web، وليس رابط لوحة Vercel.">
              <input className="text-input" dir="ltr" placeholder="https://your-worker.example.com" value={workerUrl} onChange={(e) => setWorkerUrl(e.target.value)} />
            </Field>
            <Field label="رمز الإدارة" hint="نفس قيمة ADMIN_TOKEN الموجودة في ملف .env على محرك واتساب. لا يتم حفظها في المتصفح.">
              <input className="text-input" type="password" dir="ltr" autoComplete="off" placeholder="Bearer token" value={adminToken} onChange={(e) => setAdminToken(e.target.value)} />
            </Field>
            <div className="button-row">
              <button className="primary-button" disabled={busy || serviceEnabled} onClick={() => controlWhatsApp("start")}>▶ تشغيل واتساب</button>
              <button className="secondary-button" disabled={busy || !serviceEnabled} onClick={() => controlWhatsApp("stop")}>■ إيقاف واتساب</button>
              <button className="secondary-button" disabled={busy} onClick={() => checkHealth(true)}>تحديث الحالة</button>
            </div>
            <div className="button-row">
              <button className="secondary-button" disabled={busy || !serviceEnabled || isConnected} onClick={loadQr}>عرض / تحديث QR</button>
            </div>
            {health ? (
              <div className="health-box">
                <div><span>الخادم</span><strong className="healthy">يستجيب</strong></div>
                <div><span>واتساب</span><strong>{health.whatsapp === "ready" ? "متصل" : "بانتظار الربط"}</strong></div>
                <div><span>Gemini API</span><strong>{health.aiConfigured ? "مُعد" : "غير مُعد"}</strong></div>
                <div><span>الرد الآلي</span><strong>{health.automaticReplies ? "مفعّل" : "متوقف"}</strong></div>
              </div>
            ) : null}
            {qr ? (
              <div className="qr-box">
                <img src={qr} alt="رمز QR لربط واتساب" />
                <strong>امسح الرمز من هاتفك</strong>
                <p>واتساب ← الأجهزة المرتبطة ← ربط جهاز</p>
              </div>
            ) : null}
            {isConnected ? <div className="success-line">✓ رقم واتساب متصل بمحرك السكرتير.</div> : null}
          </div>
          <div className="steps-card">
            <h3>خطوات الربط</h3>
            <ol>
              <li><b>شغّل المحرك</b><span>على جهازك أو خادم دائم التشغيل.</span></li>
              <li><b>أدخل رابط الخادم ورمز الإدارة</b><span>تأكد أن الرابط يستخدم HTTPS وأن CORS يسمح بعنوان لوحة التحكم.</span></li>
              <li><b>اعرض QR وامسحه</b><span>من قائمة الأجهزة المرتبطة داخل واتساب.</span></li>
              <li><b>اختبر قبل التفعيل</b><span>أرسل رسالة من رقم تجريبي وتأكد من الرد الصحيح.</span></li>
            </ol>
          </div>
        </section>
      )}

      {page === "leads" && (
        <section className="content-stack">
          <div className="panel-card">
            <div className="section-title-row">
              <div><span className="eyebrow">SALES HANDOFF</span><h2>العملاء المحوّلون</h2></div>
              <button className="small-button" onClick={refreshPrivateData} disabled={busy}>تحديث ↻</button>
            </div>
            <p className="panel-description">العملاء الذين طلبوا المعاينة أو أعلنوا استعدادهم للشراء النهائي، وتم تحويلهم إلى المستشار أحمد.</p>
            {!adminToken ? <div className="empty-state"><span>♙</span><strong>يلزم تسجيل اتصال الإدارة</strong><p>اذهب إلى صفحة واتساب وأدخل رابط الخادم ورمز الإدارة لعرض العملاء.</p><button className="secondary-button" onClick={() => setPage("connection")}>إعداد الاتصال</button></div> :
              leads.length === 0 ? <div className="empty-state"><span>☷</span><strong>لا توجد تحويلات حتى الآن</strong><p>ستظهر هنا بيانات العميل وملخص المحادثة عند تحويله إلى المستشار أحمد.</p></div> :
              <div className="lead-list">{leads.map((lead) => (
                <article className="lead-item" key={lead.id}>
                  <div className="lead-avatar">{String(lead.customerName || "ع").slice(0,1)}</div>
                  <div className="lead-main"><strong>{lead.customerName || "عميل"}</strong><span dir="ltr">{lead.customerPhone}</span><p>{lead.summary}</p><small>{lead.createdAt ? new Date(lead.createdAt).toLocaleString("ar-EG") : ""}</small></div>
                  <span className="lead-status">تم التحويل</span>
                </article>
              ))}</div>
            }
          </div>
          <div className="panel-card">
            <div className="section-title-row"><h2>المحادثات الأخيرة</h2><span className="muted-small">{conversations.length} محادثة</span></div>
            {conversations.length === 0 ? <p className="panel-description">لا توجد محادثات لعرضها أو لم يتم تحميل بياناتها بعد.</p> :
              <div className="conversation-list">{conversations.slice(0,12).map((item) => (
                <div className="conversation-item" key={item.chatId}><div><strong>{item.customerName || "عميل"}</strong><small>{item.messages?.at(-1)?.text || "—"}</small></div><span className={item.handedOff ? "handoff-tag" : item.paused ? "paused-tag" : "active-tag"}>{item.handedOff ? "تم التحويل" : item.paused ? "متوقف" : "نشط"}</span></div>
              ))}</div>
            }
          </div>
        </section>
      )}

      {page === "settings" && (
        <form className="content-stack" onSubmit={saveSettings}>
          <div className="panel-card">
            <div className="panel-title"><div><span className="eyebrow">AI CONFIGURATION</span><h2>الذكاء الاصطناعي</h2></div><span className="panel-icon">✦</span></div>
            <Field label="Gemini API Key" hint="يُرسل مباشرة إلى محرك واتساب ويُحفظ في ملف .env على الخادم. لا نخزنه في المتصفح.">
              <input className="text-input" type="password" dir="ltr" autoComplete="new-password" placeholder="AIza..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </Field>
            <div className="field-note">اترك الحقل فارغًا للاحتفاظ بالمفتاح الموجود حاليًا على الخادم.</div>
            <Field label="نموذج المحادثة">
              <select className="text-input" value={settings.geminiModel} onChange={(e) => updateSetting("geminiModel", e.target.value)}>
                <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
                <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
              </select>
            </Field>
            <Field label="نموذج فهم الرسائل الصوتية">
              <input className="text-input" dir="ltr" value={settings.audioModel} onChange={(e) => updateSetting("audioModel", e.target.value)} />
            </Field>
            <Field label="نموذج توليد الصوت">
              <input className="text-input" dir="ltr" value={settings.ttsModel} onChange={(e) => updateSetting("ttsModel", e.target.value)} />
            </Field>
          </div>

          <div className="panel-card">
            <div className="panel-title"><div><span className="eyebrow">VOICE EXPERIENCE</span><h2>إعدادات الصوت</h2></div><span className="panel-icon">♫</span></div>
            <Field label="طريقة الرد">
              <select className="text-input" value={settings.voiceReplyMode} onChange={(e) => updateSetting("voiceReplyMode", e.target.value)}>
                <option value="mirror">ذكي: صوت على الصوت ونص على النص</option>
                <option value="always">رد صوتي دائمًا</option>
                <option value="never">نص فقط</option>
              </select>
            </Field>
            <Field label="صوت المساعد">
              <select className="text-input" dir="ltr" value={settings.ttsVoice} onChange={(e) => updateSetting("ttsVoice", e.target.value)}>
                <option value="Kore">Kore — دافئ وواضح</option>
                <option value="Puck">Puck — حيوي</option>
                <option value="Charon">Charon — عميق</option>
                <option value="Aoede">Aoede — هادئ</option>
                <option value="Fenrir">Fenrir — قوي</option>
              </select>
            </Field>
            <Switch checked={settings.voiceReplyIncludeText} onChange={(v) => updateSetting("voiceReplyIncludeText", v)} title="إرسال النص بجانب الصوت" description="العميل يستلم التسجيل ومعه نص الرد." />
          </div>

          <div className="panel-card">
            <div className="panel-title"><div><span className="eyebrow">HUMAN HANDOFF</span><h2>بيانات المستشار أحمد</h2></div><span className="panel-icon">♙</span></div>
            <Field label="اسم المسؤول">
              <input className="text-input" value={settings.managerName} onChange={(e) => updateSetting("managerName", e.target.value)} />
            </Field>
            <Field label="المسمى الوظيفي">
              <input className="text-input" value={settings.managerRole} onChange={(e) => updateSetting("managerRole", e.target.value)} />
            </Field>
            <Field label="رقم الهاتف الدولي" hint="مثال: 2010XXXXXXXX من دون + أو مسافات.">
              <input className="text-input" dir="ltr" inputMode="tel" placeholder="2010XXXXXXXX" value={settings.managerPhone} onChange={(e) => updateSetting("managerPhone", e.target.value)} />
            </Field>
          </div>

          <div className="panel-card">
            <div className="panel-title"><div><span className="eyebrow">AUTOMATION CONTROL</span><h2>التحكم في الأتمتة</h2></div><span className="panel-icon">⚡</span></div>
            <Switch checked={settings.autoReplyEnabled} onChange={(v) => updateSetting("autoReplyEnabled", v)} title="تفعيل الرد التلقائي" description="عند التفعيل، يبدأ السكرتير بالرد على الرسائل الواردة فور وصولها." />
            {settings.autoReplyEnabled ? <div className="warning-note">تأكد من اختبار رقم تجريبي وإضافة رقم أحمد ومفتاح Gemini قبل تشغيله.</div> : <div className="safe-note">الردود التلقائية متوقفة حاليًا. يمكنك حفظ الإعدادات واختبارها أولًا.</div>}
          </div>
          <div className="sticky-actions">
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "جارٍ الحفظ..." : "حفظ الإعدادات على الخادم"}</button>
            <button className="secondary-button" type="button" onClick={downloadEnv}>تصدير ملف الإعدادات</button>
          </div>
          <p className="privacy-note">مفتاح Gemini ورمز الإدارة لا يُحفظان في مساحة تخزين المتصفح. مفتاح Gemini يُرسل إلى محركك عند الضغط على حفظ الإعدادات.</p>
        </form>
      )}

      <nav className="bottom-nav" aria-label="التنقل الرئيسي">
        {NAV.map((item) => (
          <button key={item.id} className={page === item.id ? "nav-item selected" : "nav-item"} onClick={() => setPage(item.id)}>
            <span className="nav-icon">{item.icon}</span><span>{item.label}</span>
          </button>
        ))}
      </nav>
      <footer className="app-footer">MEDIA FIRST <span>•</span> THE COMMERCIAL FRONT OF DIGITAL SOVEREIGNTY</footer>
    </main>
  );
}
