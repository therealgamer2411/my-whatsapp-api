"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./platform.css";

const ENV_API = process.env.NEXT_PUBLIC_PLATFORM_API_URL || "";
const blankForm = { fullName: "", email: "", password: "", workspaceName: "" };

export default function PlatformPage() {
  const [apiUrl, setApiUrl] = useState(ENV_API);
  const [token, setToken] = useState("");
  const [user, setUser] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [mode, setMode] = useState("register");
  const [form, setForm] = useState(blankForm);
  const [view, setView] = useState("overview");
  const [sessions, setSessions] = useState([]);
  const [overview, setOverview] = useState(null);
  const [selectedSession, setSelectedSession] = useState("");
  const [sessionStatus, setSessionStatus] = useState("");
  const [qr, setQr] = useState("");
  const [sessionLabel, setSessionLabel] = useState("واتساب الشركة");
  const [conversations, setConversations] = useState([]);
  const [syncingChats, setSyncingChats] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const syncStartedRef = useRef(new Set());
  const [activeContact, setActiveContact] = useState("");
  const [messages, setMessages] = useState([]);
  const [audioUrls, setAudioUrls] = useState({});
  const audioObjectUrlsRef = useRef(new Map());
  const [messageDraft, setMessageDraft] = useState("");
  const [assistant, setAssistant] = useState({
    enabled: false,
    provider: "openai-compatible",
    model: "",
    base_url: "",
    system_prompt: "أنت مساعد خدمة عملاء محترف. تحدث باللغة المناسبة للعميل، ولا تخترع أسعارًا أو معلومات غير موجودة.",
    apiKey: "",
    has_api_key: false
  });
  const [campaigns, setCampaigns] = useState([]);
  const [campaignContacts, setCampaignContacts] = useState([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [campaignRecipients, setCampaignRecipients] = useState([]);
  const [campaignSearch, setCampaignSearch] = useState("");
  const [campaignTitle, setCampaignTitle] = useState("");
  const [campaignBody, setCampaignBody] = useState("");
  const [campaignDelay, setCampaignDelay] = useState(10000);
  const [campaignConfirmed, setCampaignConfirmed] = useState(false);
  const [campaignSecretaryId, setCampaignSecretaryId] = useState("");
  const [secretaries, setSecretaries] = useState([]);
  const [editingSecretaryId, setEditingSecretaryId] = useState("");
  const [secretaryForm, setSecretaryForm] = useState({ name: "", category: "", description: "", systemPrompt: "", keywords: "" });
  const [importPhones, setImportPhones] = useState("");
  const [importSessionId, setImportSessionId] = useState("");
  const [consentSource, setConsentSource] = useState("نموذج موافقة موثق من العميل");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const base = useMemo(() => String(apiUrl || "").trim().replace(/\/+$/, ""), [apiUrl]);

  useEffect(() => {
    try {
      const savedToken = localStorage.getItem("mf-platform-token") || "";
      const savedApi = localStorage.getItem("mf-platform-api") || "";
      if (!ENV_API && savedApi) setApiUrl(savedApi);
      if (savedToken) setToken(savedToken);
    } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem("mf-platform-api", base); } catch {}
  }, [base]);

  const request = useCallback(async (route, options = {}) => {
    if (!base) throw new Error("أدخل رابط خادم المنصة أولًا.");
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (token) headers.Authorization = "Bearer " + token;
    const response = await fetch(base + route, {
      ...options,
      headers,
      cache: "no-store",
      body: options.body ? options.body : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "تعذر تنفيذ الطلب (" + response.status + ").");
    return data;
  }, [base, token]);

  const flash = (message, isError = false) => {
    setError(isError ? message : "");
    setNotice(isError ? "" : message);
    window.setTimeout(() => {
      setNotice((v) => v === message ? "" : v);
      setError((v) => v === message ? "" : v);
    }, 5000);
  };

  const loadOverview = useCallback(async () => {
    const [stats, sessionData, inboxData] = await Promise.all([
      request("/v1/overview"),
      request("/v1/whatsapp/sessions"),
      request("/v1/conversations")
    ]);
    setOverview(stats);
    setSessions(sessionData.sessions || []);
    setConversations(inboxData.conversations || []);
  }, [request]);

  useEffect(() => {
    if (!token || !base) return;
    let active = true;
    request("/v1/auth/me").then((data) => {
      if (!active) return;
      setUser(data.user);
      setWorkspace(data.workspace);
    }).then(() => loadOverview()).catch((e) => {
      if (!active) return;
      localStorage.removeItem("mf-platform-token");
      setToken("");
      setUser(null);
      setWorkspace(null);
      flash(e.message, true);
    });
    return () => { active = false; };
  }, [token, base, request, loadOverview]);

  useEffect(() => {
    if (!token || !base || view !== "whatsapp" || !selectedSession) return;
    let active = true;
    const poll = async () => {
      try {
        const status = await request("/v1/whatsapp/sessions/" + selectedSession);
        if (!active) return;
        setSessionStatus(status.status || "");
        if (["SCAN_QR_CODE", "STARTING", "UNKNOWN", "FAILED"].includes(status.status)) {
          const qrData = await request("/v1/whatsapp/sessions/" + selectedSession + "/qr");
          if (active) setQr(qrData.dataUrl || "");
        } else {
          setQr("");
        }
        const list = await request("/v1/whatsapp/sessions");
        if (active) setSessions(list.sessions || []);
      } catch {}
    };
    poll();
    const timer = window.setInterval(poll, 3500);
    return () => { active = false; window.clearInterval(timer); };
  }, [token, base, view, selectedSession, request]);

  const syncSessionChats = useCallback(async (sessionId, offset = 0) => {
    setSyncingChats(true);
    setSyncMessage("جارٍ استيراد المحادثات من واتساب...");
    try {
      const result = await request("/v1/whatsapp/sessions/" + sessionId + "/sync", {
        method: "POST", body: JSON.stringify({ limit: 100, offset })
      });
      const data = await request("/v1/conversations");
      setConversations(data.conversations || []);
      setSyncMessage("تمت مزامنة " + result.imported + " محادثة و" + result.messagesImported + " رسالة" + (result.hasMore ? " — توجد محادثات أخرى يمكن تحميلها." : "."));
      return result;
    } catch (e) {
      setSyncMessage(e.message);
      return null;
    } finally {
      setSyncingChats(false);
    }
  }, [request]);

  useEffect(() => {
    if (!token || view !== "inbox") return;
    const connected = sessions.filter(s => ["WORKING", "CONNECTED"].includes(String(s.status).toUpperCase()));
    for (const session of connected) {
      if (syncStartedRef.current.has(session.id)) continue;
      syncStartedRef.current.add(session.id);
      syncSessionChats(session.id, 0);
    }
  }, [token, view, sessions, syncSessionChats]);

  useEffect(() => {
    if (!token || view !== "inbox") return;
    let active = true;
    const load = async () => {
      try {
        const data = await request("/v1/conversations");
        if (active) setConversations(data.conversations || []);
        if (activeContact) {
          const detail = await request("/v1/conversations/" + activeContact + "/messages");
          if (active) setMessages(detail.messages || []);
        }
      } catch {}
    };
    load();
    const timer = window.setInterval(load, 4500);
    return () => { active = false; window.clearInterval(timer); };
  }, [token, view, activeContact, request]);

  useEffect(() => {
    if (!token || !["secretaries", "campaigns", "inbox"].includes(view)) return;
    let active = true;
    request("/v1/secretaries").then((data) => {
      if (active) setSecretaries(data.secretaries || []);
    }).catch((e) => { if (active) flash(e.message, true); });
    return () => { active = false; };
  }, [token, view, request]);

  useEffect(() => {
    let cancelled = false;
    const voiceMessages = messages.filter((m) =>
      m.has_media && String(m.media_mimetype || "").toLowerCase().startsWith("audio/")
    );
    for (const message of voiceMessages) {
      if (audioObjectUrlsRef.current.has(message.id)) continue;
      fetch(base + "/v1/conversations/" + activeContact + "/messages/" + message.id + "/media", {
        headers: token ? { Authorization: "Bearer " + token } : {},
        cache: "no-store"
      }).then(async (response) => {
        if (!response.ok) throw new Error("Voice media unavailable");
        return URL.createObjectURL(await response.blob());
      }).then((url) => {
        if (cancelled) { URL.revokeObjectURL(url); return; }
        audioObjectUrlsRef.current.set(message.id, url);
        setAudioUrls((old) => ({ ...old, [message.id]: url }));
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [messages, activeContact, base, token]);

  useEffect(() => () => {
    for (const url of audioObjectUrlsRef.current.values()) URL.revokeObjectURL(url);
    audioObjectUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    if (!token || view !== "assistant") return;
    request("/v1/assistant/settings").then((data) => {
      if (!data.settings) return;
      setAssistant((old) => ({ ...old, ...data.settings, apiKey: "", has_api_key: data.settings.has_api_key }));
    }).catch((e) => flash(e.message, true));
  }, [token, view, request]);

  useEffect(() => {
    if (!token || view !== "campaigns") return;
    let active = true;
    const load = async () => {
      try {
        const [c, contacts, directory] = await Promise.all([request("/v1/campaigns"), request("/v1/conversations"), request("/v1/contacts?limit=5000")]);
        if (active) { setCampaigns(c.campaigns || []); setConversations(contacts.conversations || []); setCampaignContacts(directory.contacts || []); }
      } catch (e) { if (active) flash(e.message, true); }
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [token, view, request]);

  async function authenticate(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!base) throw new Error("أدخل رابط خادم المنصة.");
      const response = await fetch(base + "/v1/auth/" + mode, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "register" ? form : { email: form.email, password: form.password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "تعذر تسجيل الدخول.");
      localStorage.setItem("mf-platform-token", data.token);
      setToken(data.token);
      setUser({ fullName: data.user.full_name || data.user.fullName, email: data.user.email });
      setWorkspace(data.workspace);
      setForm(blankForm);
      flash("تم تسجيل الدخول بنجاح.");
    } catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  }

  function logout() {
    localStorage.removeItem("mf-platform-token");
    setToken(""); setUser(null); setWorkspace(null);
    setSessions([]); setConversations([]); setView("overview");
  }

  async function createSession(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await request("/v1/whatsapp/sessions", {
        method: "POST",
        body: JSON.stringify({ label: sessionLabel })
      });
      setSelectedSession(data.session.id);
      setSessionStatus(data.session.status || "STARTING");
      setQr("");
      await loadOverview();
      flash("تم إنشاء جلسة واتساب. جارٍ تجهيز QR.");
    } catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  }

  async function deleteSession(session) {
    if (!window.confirm("حذف رقم " + session.label + "؟ سيتم تسجيل خروجه وحذف محادثاته وسجل رسائله من مساحة العمل.")) return;
    setBusy(true);
    try {
      await request("/v1/whatsapp/sessions/" + session.id, { method: "DELETE" });
      if (selectedSession === session.id) { setSelectedSession(""); setQr(""); setSessionStatus(""); }
      await loadOverview();
      flash("تم حذف حساب واتساب.");
    } catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  }

  async function setMarketingConsent(contact, enabled) {
    try {
      await request("/v1/contacts/" + contact.id + "/marketing-consent", {
        method: "PATCH", body: JSON.stringify({ enabled, source: enabled ? "confirmed-in-dashboard" : "" })
      });
      setConversations(old => old.map(c => c.id === contact.id ? { ...c, marketing_opt_in: enabled } : c));
      setCampaignContacts(old => old.map(c => c.id === contact.id ? { ...c, marketing_opt_in: enabled } : c));
      flash(enabled ? "تم تسجيل موافقة جهة الاتصال." : "تم سحب الموافقة.");
    } catch (e) { flash(e.message, true); }
  }

  async function importContacts(event) {
    event.preventDefault();
    const phones = importPhones.split(/[\\s,;]+/).map(x => x.trim()).filter(Boolean);
    if (!phones.length) { flash("أدخل أرقام الهواتف أولًا.", true); return; }
    if (!window.confirm("هل تؤكد أن كل رقم في القائمة وافق صراحةً على استقبال رسائل تسويقية؟")) return;
    setBusy(true);
    try {
      const result = await request("/v1/contacts/import", { method: "POST", body: JSON.stringify({
        phones, sessionId: importSessionId, consentSource, confirmOptIn: true
      })});
      setImportPhones("");
      await loadOverview();
      flash("تم استيراد " + result.imported + " رقم. أرقام غير صالحة: " + result.invalid);
    } catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  }

  async function createCampaign(event) {
    event.preventDefault();
    const selected = conversations.filter(c => c.marketing_opt_in && ["WORKING","CONNECTED"].includes(String(c.session_status).toUpperCase())).map(c => c.id);
    if (!selected.length) { flash("لا توجد جهات اتصال لديها موافقة مسجلة ورقم متصل.", true); return; }
    setBusy(true);
    try {
      await request("/v1/campaigns", { method: "POST", body: JSON.stringify({
        title: campaignTitle, body: campaignBody, delayMs: Number(campaignDelay),
        secretaryId: campaignSecretaryId || null,
        allOptedIn: true, confirmOptIn: campaignConfirmed
      })});
      setCampaignTitle(""); setCampaignBody(""); setCampaignSecretaryId(""); setCampaignConfirmed(false);
      const data = await request("/v1/campaigns"); setCampaigns(data.campaigns || []);
      flash("تم إنشاء الحملة. بدأ الإرسال وفق قائمة الموافقات المسجلة.");
    } catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  }

  async function saveSecretary(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = {
        ...secretaryForm,
        keywords: secretaryForm.keywords.split(/[,،؛]+/).map(x => x.trim()).filter(Boolean)
      };
      const route = editingSecretaryId ? "/v1/secretaries/" + editingSecretaryId : "/v1/secretaries";
      const data = await request(route, {
        method: editingSecretaryId ? "PATCH" : "POST",
        body: JSON.stringify(payload)
      });
      const directory = await request("/v1/secretaries");
      setSecretaries(directory.secretaries || []);
      setSecretaryForm({ name: "", category: "", description: "", systemPrompt: "", keywords: "" });
      setEditingSecretaryId("");
      flash(editingSecretaryId ? "تم تحديث السكرتير ومعرفته." : "تم إنشاء السكرتير المتخصص.");
    } catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  }

  function editSecretary(secretary) {
    setEditingSecretaryId(secretary.id);
    setSecretaryForm({
      name: secretary.name || "",
      category: secretary.category || "",
      description: secretary.description || "",
      systemPrompt: secretary.system_prompt || "",
      keywords: Array.isArray(secretary.keywords) ? secretary.keywords.join("، ") : ""
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function deleteSecretary(secretary) {
    if (!window.confirm("حذف السكرتير «" + secretary.name + "»؟ ستعود المحادثات المرتبطة به إلى التوجيه الذكي التلقائي.")) return;
    try {
      await request("/v1/secretaries/" + secretary.id, { method: "DELETE" });
      const directory = await request("/v1/secretaries");
      setSecretaries(directory.secretaries || []);
      flash("تم حذف السكرتير.");
    } catch (e) { flash(e.message, true); }
  }

  async function assignConversationSecretary(secretaryId) {
    if (!activeContact) return;
    try {
      await request("/v1/conversations/" + activeContact + "/secretary", {
        method: "PATCH", body: JSON.stringify({ secretaryId: secretaryId || null })
      });
      const data = await request("/v1/conversations");
      setConversations(data.conversations || []);
      flash(secretaryId ? "تم تخصيص السكرتير لهذه المحادثة." : "تم تفعيل التوجيه الذكي التلقائي.");
    } catch (e) { flash(e.message, true); }
  }

  async function campaignAction(id, action) {
    try {
      await request("/v1/campaigns/" + id + "/" + action, { method: "POST", body: "{}" });
      const data = await request("/v1/campaigns"); setCampaigns(data.campaigns || []);
      flash("تم تحديث حالة الحملة.");
    } catch (e) { flash(e.message, true); }
  }

  async function loadCampaignRecipients(id = selectedCampaignId, search = campaignSearch) {
    if (!id) return;
    try {
      const data = await request("/v1/campaigns/" + id + "/recipients?search=" + encodeURIComponent(search));
      setCampaignRecipients(data.recipients || []);
    } catch (e) { flash(e.message, true); }
  }

  async function searchCampaignLog(event) {
    event.preventDefault();
    await loadCampaignRecipients(selectedCampaignId, campaignSearch);
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!activeContact || !messageDraft.trim()) return;
    setBusy(true);
    try {
      await request("/v1/conversations/" + activeContact + "/messages", {
        method: "POST", body: JSON.stringify({ text: messageDraft.trim() })
      });
      setMessageDraft("");
      const data = await request("/v1/conversations/" + activeContact + "/messages");
      setMessages(data.messages || []);
      flash("تم إرسال الرسالة.");
    } catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  }

  async function saveAssistant(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = {
        enabled: assistant.enabled,
        provider: assistant.provider,
        model: assistant.model,
        baseUrl: assistant.base_url,
        systemPrompt: assistant.system_prompt,
        apiKey: assistant.apiKey
      };
      await request("/v1/assistant/settings", { method: "POST", body: JSON.stringify(payload) });
      setAssistant((old) => ({ ...old, apiKey: "", has_api_key: old.has_api_key || Boolean(payload.apiKey) }));
      flash("تم حفظ إعدادات المساعد. الرد التلقائي " + (assistant.enabled ? "مفعّل." : "متوقف."));
    } catch (e) { flash(e.message, true); }
    finally { setBusy(false); }
  }

  async function togglePause(contact, resume) {
    try {
      await request("/v1/conversations/" + contact + (resume ? "/resume" : "/pause"), { method: "POST", body: "{}" });
      const data = await request("/v1/conversations");
      setConversations(data.conversations || []);
    } catch (e) { flash(e.message, true); }
  }

  if (!token || !user) {
    return (
      <main className="mf-platform auth-screen" dir="rtl">
        <div className="auth-brand">
          <div className="mf-mark">MF</div>
          <div><span>MEDIA FIRST</span><small>AI SECRETARY PLATFORM</small></div>
        </div>
        <section className="auth-card">
          <div className="eyebrow">WORKSPACE ACCESS</div>
          <h1>{mode === "register" ? "ابدأ مساحة عمل شركتك" : "مرحبًا بعودتك"}</h1>
          <p className="muted">منصة موحدة لإدارة واتساب ومحادثات العملاء والمساعد الذكي.</p>
          <div className="auth-tabs">
            <button className={mode === "register" ? "selected" : ""} onClick={() => setMode("register")}>حساب جديد</button>
            <button className={mode === "login" ? "selected" : ""} onClick={() => setMode("login")}>تسجيل الدخول</button>
          </div>
          <form onSubmit={authenticate} className="mf-form">
            {mode === "register" && <>
              <label>اسمك<input required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} placeholder="الاسم الكامل"/></label>
              <label>اسم الشركة أو النشاط<input required value={form.workspaceName} onChange={(e) => setForm({ ...form, workspaceName: e.target.value })} placeholder="اسم مساحة العمل"/></label>
            </>}
            <label>البريد الإلكتروني<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@company.com" dir="ltr"/></label>
            <label>كلمة المرور<input required type="password" minLength={mode === "register" ? 10 : 1} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={mode === "register" ? "10 أحرف على الأقل" : "كلمة المرور"}/></label>
            <button className="mf-primary full" disabled={busy}>{busy ? "جارٍ التنفيذ..." : mode === "register" ? "إنشاء مساحة العمل" : "دخول"}</button>
          </form>
          {!ENV_API && <label className="api-config">رابط خادم المنصة<input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://your-platform-api.up.railway.app" dir="ltr"/></label>}
          {error && <div className="mf-alert error">{error}</div>}
          {notice && <div className="mf-alert">{notice}</div>}
          <p className="auth-foot">Media First · Stack Core Systems</p>
        </section>
      </main>
    );
  }

  const nav = [
    ["overview", "نظرة عامة", "⌂"],
    ["whatsapp", "حسابات واتساب", "◉"],
    ["inbox", "صندوق المحادثات", "▤"],
    ["secretaries", "السكرتيرون المتخصصون", "✧"],
    ["assistant", "المساعد الذكي", "✧"],
    ["campaigns", "الحملات الجماعية", "▣"]
  ];

  return (
    <main className="mf-platform" dir="rtl">
      <aside className="mf-sidebar">
        <div className="mf-brand">
          <div className="mf-mark">MF</div>
          <div><b>MEDIA FIRST</b><small>AI SECRETARY</small></div>
        </div>
        <div className="workspace-tag"><span className="live-dot"></span><div><small>مساحة العمل</small><strong>{workspace?.name || "شركتك"}</strong></div></div>
        <nav>
          {nav.map(([key,label,icon]) => <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}><span>{icon}</span>{label}</button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile-mini"><div className="avatar">{(user.fullName || "م").slice(0,1)}</div><div><b>{user.fullName}</b><small>{user.email}</small></div></div>
          <button className="logout" onClick={logout}>تسجيل الخروج ↗</button>
        </div>
      </aside>

      <section className="mf-main">
        <header className="mf-topbar">
          <div><span className="eyebrow">MEDIA FIRST / SAAS</span><h1>{nav.find((x) => x[0] === view)?.[1]}</h1></div>
          <div className="topbar-meta"><span className="plan-chip">خطة تجريبية</span><span className="user-chip">{user.fullName}</span></div>
        </header>

        {notice && <div className="mf-alert">{notice}</div>}
        {error && <div className="mf-alert error">{error}</div>}

        {view === "overview" && <div className="mf-content">
          <section className="welcome-panel">
            <div><span className="eyebrow">INTELLIGENT CUSTOMER OPERATIONS</span><h2>كل محادثات عملك، في مكان واحد.</h2><p>اربط أرقام واتساب، تابع العملاء، وشغّل مساعدك الذكي من لوحة واحدة.</p><button className="mf-primary" onClick={() => setView("whatsapp")}>ربط حساب واتساب <span>←</span></button></div>
            <div className="welcome-orb">✧<i></i></div>
          </section>
          <div className="metric-grid">
            <Metric label="حسابات واتساب" value={overview?.sessions?.total ?? "—"} note={(overview?.sessions?.connected ?? 0) + " متصل"} icon="◉"/>
            <Metric label="جهات الاتصال" value={overview?.contacts ?? "—"} note="العملاء المسجلون" icon="♙"/>
            <Metric label="الرسائل خلال 30 يومًا" value={overview?.messages30d ?? "—"} note="الواردة والصادرة" icon="▤"/>
          </div>
          <section className="panel">
            <div className="panel-head"><div><span className="eyebrow">WORKSPACE</span><h3>مساحة العمل الحالية</h3></div><span className="state-pill">نشطة</span></div>
            <div className="workspace-details"><div><small>الشركة</small><b>{workspace?.name}</b></div><div><small>المعرّف</small><b dir="ltr">{workspace?.slug}</b></div><div><small>الباقة</small><b>{overview?.subscription?.name || "Starter"}</b></div></div>
          </section>
          <div className="hint-panel"><span>ⓘ</span><p>الرد الآلي يبدأ متوقفًا. اختبر ربط الرقم وإعدادات الذكاء الاصطناعي أولًا، ثم فعّله يدويًا عندما تكون مستعدًا.</p></div>
        </div>}

        {view === "whatsapp" && <div className="mf-content two-column">
          <section className="panel">
            <div className="panel-head"><div><span className="eyebrow">CONNECTED ACCOUNTS</span><h3>حسابات واتساب</h3></div><span className="count-badge">{sessions.length}</span></div>
            <form className="inline-create" onSubmit={createSession}><input value={sessionLabel} onChange={(e) => setSessionLabel(e.target.value)} placeholder="اسم الرقم / الفرع"/><button className="mf-primary" disabled={busy}>إضافة رقم +</button></form>
            <div className="session-list">
              {sessions.length === 0 && <div className="empty-state">لم تتم إضافة أي رقم بعد. أنشئ أول جلسة لبدء الربط.</div>}
              {sessions.map((s) => <div key={s.id} className="session-entry">
                <button className={"session-row " + (selectedSession === s.id ? "chosen" : "")} onClick={() => { setSelectedSession(s.id); setQr(""); }}>
                  <div className="whatsapp-icon">◉</div><div className="session-info"><b>{s.label}</b><small dir="ltr">{s.phone_number || s.engine || "بانتظار الربط"}</small></div><span className={"mini-status " + (["WORKING","CONNECTED"].includes(s.status) ? "ok" : "")}>{s.status}</span>
                </button>
                <button type="button" className="session-delete" disabled={busy} onClick={() => deleteSession(s)} title="إزالة حساب واتساب من مساحة العمل"><span aria-hidden="true">×</span> إزالة الحساب</button>
              </div>)}
            </div>
          </section>
          <section className="panel pairing-panel">
            <div className="panel-head"><div><span className="eyebrow">DEVICE PAIRING</span><h3>ربط الهاتف</h3></div></div>
            {!selectedSession ? <div className="empty-qr"><div>▦</div><b>اختر حسابًا من القائمة</b><p>بعد إنشاء الجلسة، سيظهر رمز الربط هنا.</p></div> :
              <div className="qr-stage">
                {qr ? <img src={qr} alt="WhatsApp QR code"/> : <div className="qr-placeholder"><span className="spinner"></span><b>{sessionStatus || "جارٍ انتظار رمز QR"}</b><small>يتم تحديث حالة الجلسة تلقائيًا</small></div>}
                <div className="pairing-status"><span className={["WORKING","CONNECTED"].includes(sessionStatus) ? "connected" : ""}></span>{["WORKING","CONNECTED"].includes(sessionStatus) ? "واتساب متصل" : "في انتظار مسح الرمز"}</div>
                <p>افتح واتساب على هاتفك ← الأجهزة المرتبطة ← ربط جهاز، ثم امسح الرمز.</p>
              </div>}
            <div className="note-small">تُحفظ بيانات الجلسة على الخادم، ولا يحتاج العميل إلى إبقاء جهازه مفتوحًا.</div>
          </section>
        </div>}

        {view === "inbox" && <div className="mf-content inbox-layout">
          <section className="panel conversation-list">
            <div className="panel-head"><div><span className="eyebrow">CUSTOMER MESSAGES</span><h3>المحادثات</h3></div><div className="inbox-head-actions"><span className="count-badge">{conversations.length}</span><button type="button" className="mf-secondary" disabled={syncingChats} onClick={() => { const s=sessions.find(x => ["WORKING","CONNECTED"].includes(String(x.status).toUpperCase())); if (s) syncSessionChats(s.id, 0); else setSyncMessage("لا يوجد رقم واتساب متصل حاليًا."); }}>{syncingChats ? "جارٍ المزامنة..." : "مزامنة واتساب ↻"}</button></div></div>
            {syncMessage && <div className="sync-feedback">{syncMessage}</div>}
            {conversations.length === 0 && <div className="empty-state">لا توجد رسائل واردة بعد. اربط رقم واتساب لتبدأ.</div>}
            {conversations.map((c) => <button key={c.id} className={"conversation-row " + (activeContact === c.id ? "chosen" : "")} onClick={async () => { setActiveContact(c.id); try { const d = await request("/v1/conversations/" + c.id + "/messages?sync=1"); setMessages(d.messages || []); } catch (e) { flash(e.message,true); } }}>
              <div className="avatar contact-avatar">{(c.display_name || "ع").slice(0,1)}</div><div className="conversation-copy"><b>{c.display_name}</b><small>{c.last_message || c.phone_number || "لا توجد رسائل"}</small></div><span className="conversation-mark">{c.is_paused ? "يدوي" : (c.secretary_name || "توجيه ذكي")}</span>
            </button>)}
          </section>
          <section className="panel chat-panel">
            {!activeContact ? <div className="empty-qr"><div>▤</div><b>اختر محادثة</b><p>حدد عميلًا من القائمة لعرض الرسائل والرد عليه.</p></div> : <>
              <div className="chat-head">
                <div><b>{conversations.find((c) => c.id === activeContact)?.display_name || "محادثة العميل"}</b><span>{conversations.find((c) => c.id === activeContact)?.phone_number}</span></div>
                <label className="secretary-inline-select">السكرتير المسؤول
                  <select value={["manual", "campaign"].includes(conversations.find((c) => c.id === activeContact)?.secretary_assignment) ? (conversations.find((c) => c.id === activeContact)?.secretary_id || "") : ""} onChange={(e) => assignConversationSecretary(e.target.value)}>
                    <option value="">توجيه ذكي تلقائي</option>
                    {secretaries.filter(s => s.enabled).map(s => <option key={s.id} value={s.id}>{s.name}{s.is_default ? " (عام)" : ""}</option>)}
                  </select>
                </label>
                <small className="secretary-route-note">التصنيف: {conversations.find((c) => c.id === activeContact)?.secretary_category || "بانتظار التصنيف"} · {conversations.find((c) => c.id === activeContact)?.secretary_assignment === "manual" ? "يدوي" : conversations.find((c) => c.id === activeContact)?.secretary_assignment === "campaign" ? "حملة" : conversations.find((c) => c.id === activeContact)?.secretary_assignment === "ai" ? "ذكاء اصطناعي" : "تلقائي"}</small>
              </div>
              <div className="chat-messages">{messages.map((m) => {
                const isVoice = String(m.message_type || "").toLowerCase().startsWith("ptt") ||
                  String(m.message_type || "").toLowerCase() === "audio" ||
                  String(m.media_mimetype || "").toLowerCase().startsWith("audio/");
                return <div key={m.id} className={"chat-bubble " + (m.direction === "outbound" ? "out" : "in") + (isVoice ? " voice-bubble" : "")}>
                  {isVoice && <div className="voice-message-title">🎤 رسالة صوتية</div>}
                  {isVoice && audioUrls[m.id] && <audio className="voice-audio-player" controls preload="none" src={audioUrls[m.id]} />}
                  <p>{m.body}</p>
                  {isVoice && m.transcription_status === "pending" && <small className="voice-status">جارٍ تحويل الصوت إلى نص...</small>}
                  {isVoice && m.transcription_status === "failed" && <small className="voice-status failed">تعذر تفريغ الصوت؛ تم إبلاغ العميل بإعادة الإرسال.</small>}
                  <small>{new Date(m.sent_at).toLocaleString("ar-EG")}</small>
                </div>;
              })}</div>
              <form className="composer" onSubmit={sendMessage}><input value={messageDraft} onChange={(e) => setMessageDraft(e.target.value)} placeholder="اكتب رسالة للعميل..." /><button className="mf-primary" disabled={busy || !messageDraft.trim()}>إرسال</button></form>
              <div className="takeover-row"><span>{conversations.find((c) => c.id === activeContact)?.is_paused ? "المساعد متوقف لهذه المحادثة بسبب التدخل اليدوي." : "المساعد الذكي يعمل تلقائيًا على هذه المحادثة."}</span><button type="button" onClick={() => togglePause(activeContact, !conversations.find((c) => c.id === activeContact)?.is_paused)}>{conversations.find((c) => c.id === activeContact)?.is_paused ? "استئناف المساعد" : "إيقاف المساعد"}</button></div>
            </>}
          </section>
        </div>}


        {view === "campaigns" && <div className="mf-content">
          <section className="panel campaign-panel">
            <div className="panel-head"><div><span className="eyebrow">CONSENT-BASED OUTREACH</span><h3>إنشاء حملة رسائل موحدة</h3></div><span className="count-badge">{campaignContacts.filter(c => c.marketing_opt_in).length} موافق</span></div>
            <p className="muted">تُرسل الرسالة نفسها فقط لجهات الاتصال التي سجلت موافقتها. الإرسال متدرج، ويمكن إيقاف الحملة. أي خطأ من مزود واتساب يوقف الحملة تلقائيًا.</p>
            <form className="mf-form" onSubmit={createCampaign}>
              <label>اسم الحملة<input required value={campaignTitle} onChange={e=>setCampaignTitle(e.target.value)} placeholder="مثال: عرض نهاية الشهر"/></label>
              <label>نص الرسالة<textarea required rows={4} maxLength={4000} value={campaignBody} onChange={e=>setCampaignBody(e.target.value)} placeholder="اكتب الرسالة الموحدة هنا"/></label>
              <label>السكرتير المسؤول عن ردود الحملة<select value={campaignSecretaryId} onChange={e=>setCampaignSecretaryId(e.target.value)}><option value="">يختار الذكاء الاصطناعي السكرتير المناسب</option>{secretaries.filter(s=>s.enabled).map(s=><option key={s.id} value={s.id}>{s.name}{s.is_default?" (عام)":""}</option>)}</select></label>
              <label>الفاصل التشغيلي بين الرسائل<select value={campaignDelay} onChange={e=>setCampaignDelay(Number(e.target.value))}><option value={10000}>10 ثوانٍ</option><option value={15000}>15 ثانية</option><option value={30000}>30 ثانية</option><option value={60000}>60 ثانية</option></select></label>
              <label className="consent-confirm"><input type="checkbox" checked={campaignConfirmed} onChange={e=>setCampaignConfirmed(e.target.checked)}/> أؤكد أن كل المستلمين وافقوا صراحةً على استقبال رسائل من هذا النشاط، وأن الرسالة متوافقة مع تفضيلاتهم.</label>
              <button className="mf-primary" disabled={busy || !campaignConfirmed}>إنشاء الحملة وإرسالها إلى جميع جهات الاتصال صاحبة الموافقة</button>
            </form>
          </section>
          <section className="panel campaign-panel">
            <div className="panel-head"><div><span className="eyebrow">CONTACT PERMISSIONS</span><h3>إدارة موافقات جهات الاتصال</h3></div></div>
            <div className="consent-list">
              {campaignContacts.map(c=><div className="consent-row" key={c.id}>
                <div><b>{c.display_name}</b><small dir="ltr">{c.phone_number}</small></div>
                <label><input type="checkbox" checked={Boolean(c.marketing_opt_in)} onChange={e=>setMarketingConsent(c,e.target.checked)}/> موافق على الرسائل</label>
              </div>)}
              {!conversations.length && <div className="empty-state">لا توجد جهات اتصال بعد.</div>}
            </div>
          </section>
          <section className="panel campaign-panel">
            <div className="panel-head"><div><span className="eyebrow">CAMPAIGN HISTORY</span><h3>سجل الحملات</h3></div></div>
            <div className="campaign-list">{campaigns.map(c=><div className="campaign-row" key={c.id}>
              <div><b>{c.title}</b><small>{c.status} · {c.sent_count}/{c.total_count} تم الإرسال · {c.failed_count} أخطاء</small></div>
              <div className="campaign-actions"><button onClick={()=>{setSelectedCampaignId(c.id);setCampaignSearch("");loadCampaignRecipients(c.id,"");}}>سجل الرسائل</button>{c.status==="running"||c.status==="queued"? <button onClick={()=>campaignAction(c.id,"pause")}>إيقاف مؤقت</button>:null}{c.status==="paused"? <button onClick={()=>campaignAction(c.id,"resume")}>استئناف</button>:null}{["running","queued","paused"].includes(c.status)?<button onClick={()=>campaignAction(c.id,"cancel")}>إلغاء</button>:null}</div>
            </div>)}</div>
            {selectedCampaignId && <div className="campaign-recipient-log">
              <div className="panel-head"><div><span className="eyebrow">MESSAGE AUDIT TRAIL</span><h3>سجل الرسائل التفصيلي</h3></div><button onClick={()=>{setSelectedCampaignId("");setCampaignRecipients([]);}}>إغلاق السجل</button></div>
              <form className="campaign-search" onSubmit={searchCampaignLog}><input value={campaignSearch} onChange={e=>setCampaignSearch(e.target.value)} placeholder="ابحث بالرقم المرجعي أو الهاتف أو الاسم أو نص الرسالة"/><button className="mf-primary">بحث</button></form>
              <div className="campaign-log-list">{campaignRecipients.map(r=><article className="campaign-log-item" key={r.id}>
                <div className="campaign-log-meta"><b dir="ltr">{r.reference_code || "لم يُخصص رقم بعد"}</b><span dir="ltr">{r.phone_number}</span><span>{r.display_name}</span><span>{r.status==="sent"?"تم الإرسال":r.status==="failed"?"فشل":r.status==="skipped"?"تخطي":"في الانتظار"}</span></div>
                <p>{r.sent_body || "لم تُجهز الرسالة للإرسال بعد."}</p>
                <small>{r.sent_at ? new Date(r.sent_at).toLocaleString("ar-EG") : ""}{r.provider_message_id ? " · ID: "+r.provider_message_id : ""}{r.error ? " · "+r.error : ""}</small>
                <button type="button" onClick={()=>navigator.clipboard?.writeText(r.reference_code || "")} disabled={!r.reference_code}>نسخ الرقم المرجعي</button>
              </article>)}
              {!campaignRecipients.length && <div className="empty-state">لا توجد نتائج مطابقة.</div>}</div>
            </div>}
          </section>
          <div className="hint-panel"><span>ⓘ</span><p>الفواصل الزمنية هنا لتنظيم الحملات والتحكم في الحمل على الخادم، وليست وسيلة لتجاوز قيود واتساب أو ضمان عدم الحظر. أوقف الإرسال عند ظهور قيود أو شكاوى، واحترم طلبات إلغاء الاشتراك.</p></div>
        </div>}
\n        {view === "secretaries" && <div className="mf-content">
          <section className="panel assistant-panel">
            <div className="panel-head"><div><span className="eyebrow">SPECIALIZED AI SECRETARIES</span><h3>{editingSecretaryId ? "تعديل سكرتير متخصص" : "إنشاء سكرتير متخصص"}</h3></div><span className="state-pill">{secretaries.length} سكرتير</span></div>
            <p className="muted">اكتب مجال السكرتير وشخصيته ومعلوماته وتعليماته. سيستخدمه نظام التوجيه الذكي عندما يكتشف أن المحادثة تناسب هذا التخصص.</p>
            <form className="mf-form settings-form" onSubmit={saveSecretary}>
              <label>اسم السكرتير<input required minLength={2} maxLength={100} value={secretaryForm.name} onChange={e=>setSecretaryForm({...secretaryForm,name:e.target.value})} placeholder="مثال: سكرتير مبيعات MSS"/></label>
              <label>نوع المحادثات / التخصص<input required minLength={2} maxLength={80} value={secretaryForm.category} onChange={e=>setSecretaryForm({...secretaryForm,category:e.target.value})} placeholder="مثال: مبيعات طبية، دعم فني، حجوزات"/></label>
              <label>وصف دوره ومتى يجب اختياره<textarea required rows={3} maxLength={1200} value={secretaryForm.description} onChange={e=>setSecretaryForm({...secretaryForm,description:e.target.value})} placeholder="يختص بالعملاء الذين يسألون عن نظام MSS الطبي، التخصصات، الأسعار، التشغيل والتعاقد."/></label>
              <label>كلمات مفتاحية تساعد على التوجيه<input value={secretaryForm.keywords} onChange={e=>setSecretaryForm({...secretaryForm,keywords:e.target.value})} placeholder="MSS، عيادات، إدارة طبية، نظام طبي"/></label>
              <label>معرفة السكرتير وتعليماته<textarea required rows={8} maxLength={12000} value={secretaryForm.systemPrompt} onChange={e=>setSecretaryForm({...secretaryForm,systemPrompt:e.target.value})} placeholder="ضع هنا معلومات المنتج والخدمات والمميزات والأسعار والسياسات والأسئلة الشائعة، ثم حدد أسلوب الرد وما يجب ألا يعد به العميل."/></label>
              <div className="form-actions"><button className="mf-primary" disabled={busy}>{busy ? "جارٍ الحفظ..." : editingSecretaryId ? "حفظ التعديلات" : "إنشاء السكرتير"}</button>{editingSecretaryId && <button type="button" className="mf-secondary" onClick={()=>{setEditingSecretaryId("");setSecretaryForm({name:"",category:"",description:"",systemPrompt:"",keywords:""});}}>إلغاء التعديل</button>}</div>
            </form>
          </section>
          <section className="panel campaign-panel">
            <div className="panel-head"><div><span className="eyebrow">SECRETARY DIRECTORY</span><h3>السكرتيرون المتاحون للتوجيه</h3></div></div>
            <div className="campaign-list">{secretaries.map(s=><article className="campaign-row" key={s.id}>
              <div><b>{s.name}{s.is_default ? " · الافتراضي" : ""}</b><small>{s.category} · {s.description}</small></div>
              <div className="campaign-actions"><button type="button" onClick={()=>editSecretary(s)}>تعديل المعرفة</button>{!s.is_default && <button type="button" onClick={()=>deleteSecretary(s)}>حذف</button>}</div>
            </article>)}</div>
            {!secretaries.length && <div className="empty-state">لم يتم تحميل السكرتيرين بعد.</div>}
          </section>
          <div className="hint-panel"><span>ⓘ</span><p>التوجيه الذكي يختار من السكرتيرين المفعّلين فقط. التخصيص اليدوي للمحادثة يتقدم على تصنيف الذكاء الاصطناعي، والسكرتير المربوط بالحملة يتولى محادثات مستلميها. السكرتير العام بديل عند انخفاض الثقة.</p></div>
        </div>}

        {view === "assistant" && <div className="mf-content">
          <section className="panel assistant-panel">
            <div className="panel-head"><div><span className="eyebrow">AI CONFIGURATION</span><h3>إعدادات المساعد الذكي</h3></div><span className={assistant.enabled ? "state-pill" : "state-pill muted-state"}>{assistant.enabled ? "مفعّل" : "متوقف"}</span></div>
            <p className="muted">اختر محرك ذكاء اصطناعي يمكن استضافته ذاتيًا مثل Ollama أو vLLM عبر واجهة OpenAI-compatible، أو اربط مزودًا خارجيًا. مفتاح كل مساحة عمل يُخزّن مشفرًا.</p>
            <form className="mf-form settings-form" onSubmit={saveAssistant}>
              <label>مزود الذكاء الاصطناعي<select value={assistant.provider} onChange={(e) => setAssistant({ ...assistant, provider: e.target.value })}><option value="openai-compatible">محرك ذاتي / OpenAI-compatible (Ollama, vLLM)</option><option value="gemini">Google Gemini API</option></select></label>
              {assistant.provider === "openai-compatible" && <>
                <label>عنوان API<input dir="ltr" value={assistant.base_url} onChange={(e) => setAssistant({ ...assistant, base_url: e.target.value })} placeholder="http://inference-server:11434/v1"/></label>
                <label>اسم النموذج<input dir="ltr" value={assistant.model} onChange={(e) => setAssistant({ ...assistant, model: e.target.value })} placeholder="qwen2.5:14b أو اسم النموذج"/></label>
              </>}
              {assistant.provider === "gemini" && <label>اسم النموذج<input dir="ltr" value={assistant.model} onChange={(e) => setAssistant({ ...assistant, model: e.target.value })} placeholder="gemini-2.5-flash"/></label>}
              <label>مفتاح API {assistant.has_api_key && <small className="saved-key">يوجد مفتاح محفوظ</small>}<input type="password" autoComplete="new-password" value={assistant.apiKey} onChange={(e) => setAssistant({ ...assistant, apiKey: e.target.value })} placeholder="اتركه فارغًا للإبقاء على المفتاح الحالي"/></label>
              <label>تعليمات شخصية المساعد<textarea rows={5} value={assistant.system_prompt} onChange={(e) => setAssistant({ ...assistant, system_prompt: e.target.value })}/></label>
              <div className="switch-line"><div><b>تشغيل الرد التلقائي</b><small>لا يتم الرد إلا بعد تفعيل هذا الخيار وربط جلسة واتساب.</small></div><button type="button" role="switch" aria-checked={assistant.enabled} className={"switch " + (assistant.enabled ? "on" : "")} onClick={() => setAssistant({ ...assistant, enabled: !assistant.enabled })}><i/></button></div>
              <button className="mf-primary" disabled={busy}>حفظ إعدادات المساعد</button>
            </form>
          </section>
          <div className="hint-panel"><span>ⓘ</span><p>استخدام نموذج مستضاف على خوادم Media First يزيل رسوم API الخارجية، لكنه يتطلب موارد GPU/CPU وذاكرة مناسبة. لم يتم تشغيل نموذج محلي فعلي بعد.</p></div>
        </div>}
      </section>
    </main>
  );
}

function Metric({ label, value, note, icon }) {
  return <article className="metric-card"><div className="metric-icon">{icon}</div><small>{label}</small><strong>{value}</strong><span>{note}</span></article>;
}
