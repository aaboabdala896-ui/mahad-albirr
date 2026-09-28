import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  BookOpen, Shield, GraduationCap, Heart, LogIn, LogOut, Users, UserPlus,
  ClipboardCheck, Star, MessageSquare, Calendar, ChevronLeft, Check, X,
  Loader2, Plus, Trash2, Save, Sparkles, Phone, ArrowLeft, Eye, EyeOff, Search, Bell, Home, ClipboardList, MoreHorizontal
} from "lucide-react";
import { supabase } from "./supabaseClient";
import {
  clearSession, persistSession, readStoredSession,
  clearAppCache, persistAppCache, readAppCache,
  readNotificationToken, persistNotificationToken, clearNotificationToken
} from "./lib/session";
import { canUseNotifications, requestNotificationPermission, showBrowserNotification } from "./lib/notifications";
import { canAccessRole, getSafeRole, normalizeUser, validateLogin } from "./lib/auth";
import { attachExistingParentToStudent, createStudentWithParent, findParentByPhone, normalizePhone, phonesMatch } from "./lib/studentParentLinking";

/* ============================= DESIGN TOKENS =============================
  Palette:
    --ink        #1B2A22  (near-black green ink for text)
    --bg         #FBF8F1  (warm ivory)
    --surface    #FFFFFF
    --green-900  #0B3D2E  (royal green, deep)
    --green-700  #145C43
    --green-500  #1F7A5C
    --gold-500   #C9A227
    --gold-300   #E7CC7A
    --muted      #7C8A80
    --red-500    #C24A3D
    --yellow-500 #D9A441
  Type: Tajawal (display, geometric modern) + Cairo (UI/body sans)
  Signature: pointed-arch (mihrab) card headers used for every student
  profile — ties every dashboard back to the institute's architecture.
=========================================================================== */

const FONT_IMPORT = `
@import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&family=Cairo:wght@400;500;600;700;800&display=swap');
`;

const studentFromRow = (r) => ({
  id: r.id, name: r.name, age: r.age, teacherId: r.teacher_id, parentId: r.parent_id,
  gender: r.gender || "male", level: r.level || "", nextLesson: r.next_lesson || "", behavior: r.behavior ?? 70,
  notes: r.notes || "", updatedAt: r.updated_at,
});

const regFromRow = (r) => ({
  id: r.id, name: r.name, age: r.age, phone: r.phone, level: r.level,
  status: r.status, createdAt: r.created_at,
});

/* ============================= SUPABASE DATA HOOK =============================
  Real relational tables (users / teachers / parents / students /
  registrations) instead of one shared JSON blob. Every write below touches
  only the one row it changes, then refetches from the database — the
  source of truth — so two teachers saving different students at the same
  moment can never overwrite each other's work. That silent-overwrite risk
  is exactly what a single shared blob has at real scale (200+ students,
  several teachers working at once), so this hook is the actual fix for it,
  not a cosmetic one.
================================================================================= */
function useAppData() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready
  const [persistent, setPersistent] = useState(true);

  const clearStaleClientCache = useCallback(() => {
    try {
      clearAppCache();
      if (typeof window !== "undefined") {
        sessionStorage.clear();
        localStorage.removeItem("mahad-albirr-registrations-cache-v1");
        localStorage.removeItem("mahad-albirr-cache-v1");
      }
    } catch {
      // Ignore cleanup failures in restricted browser contexts.
    }
  }, []);

  const fetchAll = useCallback(async () => {
    const [usersR, teachersR, parentsR, studentsR, regsR] = await Promise.all([
      supabase.from("users").select("*"),
      supabase.from("teachers").select("*"),
      supabase.from("parents").select("*"),
      supabase.from("students").select("*"),
      supabase.from("registrations").select("*").order("created_at", { ascending: false }),
    ]);

    if (usersR.error || teachersR.error || parentsR.error || studentsR.error || regsR.error) {
      const issues = [usersR.error, teachersR.error, parentsR.error, studentsR.error, regsR.error].filter(Boolean);
      throw new Error(issues[0]?.message || "تعذّر الاتصال بقاعدة البيانات.");
    }

    const next = {
      users: usersR.data || [],
      teachers: teachersR.data || [],
      parents: parentsR.data || [],
      students: (studentsR.data || []).map(studentFromRow),
      registrations: (regsR.data || []).map(regFromRow),
    };

    persistAppCache(next);
    return next;
  }, []);

  useEffect(() => {
    let channels = [];
    let cancelled = false;

    (async () => {
      try {
        const fresh = await fetchAll();
        if (!cancelled) {
          setData(fresh);
          setStatus("ready");
          setPersistent(true);
        }
      } catch (e) {
        console.error("Supabase load failed", e);
        if (!cancelled) {
          clearStaleClientCache();
          const cached = readAppCache();
          setData(cached || { users: [], teachers: [], parents: [], students: [], registrations: [] });
          setPersistent(false);
          setStatus("error");
        }
        return;
      }

      const refresh = async () => {
        try {
          setData(await fetchAll());
          setPersistent(true);
        } catch (e) {
          console.error("Supabase refresh failed", e);
          clearStaleClientCache();
          const cached = readAppCache();
          setData(cached || { users: [], teachers: [], parents: [], students: [], registrations: [] });
          setPersistent(false);
        }
      };
      ["students", "teachers", "parents", "registrations", "users"].forEach((table) => {
        const ch = supabase
          .channel(`${table}_changes`)
          .on("postgres_changes", { event: "*", schema: "public", table }, refresh)
          .subscribe();
        channels.push(ch);
      });
    })();

    return () => {
      cancelled = true;
      channels.forEach((c) => supabase.removeChannel(c));
    };
  }, [fetchAll]);

  // Every mutation runs its Supabase write, then reloads from the database
  // rather than guessing the new local shape — this is what keeps every
  // open screen correct once there are hundreds of rows and several
  // people editing at once.
  const mutate = useCallback(async (fn) => {
    try {
      await fn();
      setData(await fetchAll());
      return { ok: true };
    } catch (e) {
      console.error("Supabase write failed", e);
      setPersistent(false);
      return { ok: false, code: e.code, message: e.message || "حدث خطأ غير متوقع." };
    }
  }, [fetchAll]);

  const api = {
    updateStudent: (id, patch) => mutate(async () => {
      const { error } = await supabase.from("students").update({
        name: patch.name, age: patch.age, level: patch.level, next_lesson: patch.nextLesson,
        behavior: patch.behavior, notes: patch.notes, updated_at: new Date().toISOString(),
      }).eq("id", id);
      if (error) throw error;
    }),
    assignStudent: (id, { teacherId, parentId }) => mutate(async () => {
      const patch = { updated_at: new Date().toISOString() };
      if (teacherId !== undefined) patch.teacher_id = teacherId || null;
      if (parentId !== undefined) patch.parent_id = parentId || null;
      const { error } = await supabase.from("students").update(patch).eq("id", id);
      if (error) throw error;
    }),
    approveRegistration: (reg, teacherId) => mutate(async () => {
      const { error: e1 } = await supabase.from("students").insert({
        name: reg.name, age: Number(reg.age) || 0, teacher_id: teacherId || null, parent_id: null,
        level: reg.level, next_lesson: "سيتم تحديد الدرس القادم من قبل المعلم", behavior: 70, notes: "",
      });
      if (e1) throw e1;
      const { error: e2 } = await supabase.from("registrations").update({ status: "approved" }).eq("id", reg.id);
      if (e2) throw e2;
    }),
    rejectRegistration: (reg) => mutate(async () => {
      const { error } = await supabase.from("registrations").update({ status: "rejected" }).eq("id", reg.id);
      if (error) throw error;
    }),
    submitRegistration: (form) => mutate(async () => {
      const { error } = await supabase.from("registrations").insert({
        name: form.name, age: Number(form.age) || 0, phone: form.phone, level: form.level, status: "pending",
      });
      if (error) throw error;
    }),
    addTeacher: (form) => mutate(async () => {
      const { data: row, error: e1 } = await supabase.from("users")
        .insert({ username: form.username, password: form.password, role: "teacher", name: form.name, gender: form.gender || "male" })
        .select().single();
      if (e1) throw e1;
      const { error: e2 } = await supabase.from("teachers")
        .insert({ id: row.id, name: form.name, subject: form.subject || "تحفيظ القرآن الكريم", gender: form.gender || "male" });
      if (e2) throw e2;
    }),
    addParent: (form) => mutate(async () => {
      const { data: row, error: e1 } = await supabase.from("users")
        .insert({ username: form.username, password: form.password, role: "parent", name: form.name, gender: form.gender || "female" })
        .select().single();
      if (e1) throw e1;
      const { error: e2 } = await supabase.from("parents")
        .insert({ id: row.id, name: form.name, phone: normalizePhone(form.phone || "") });
      if (e2) throw e2;
    }),
    addStudentForTeacher: ({ teacherId, student, existingParentId, parentPhone, parentName, username, password }) => mutate(async () => {
      if (existingParentId) {
        const result = await attachExistingParentToStudent({
          supabase,
          student,
          teacherId,
          parentId: existingParentId,
        });
        return result;
      }

      const result = await createStudentWithParent({
        supabase,
        student,
        teacherId,
        parentPhone,
        parentName,
        username,
        password,
        existingParentId,
      });
      return result;
    }),
    deleteTeacher: (id) => mutate(async () => {
      const { error } = await supabase.from("users").delete().eq("id", id);
      if (error) throw error;
    }),
    deleteParent: (id) => mutate(async () => {
      const { error } = await supabase.from("users").delete().eq("id", id);
      if (error) throw error;
    }),
    deleteStudent: (id) => mutate(async () => {
      const { error } = await supabase.from("students").delete().eq("id", id);
      if (error) throw error;
    }),
    clearDemoData: () => mutate(async () => {
      const { error } = await supabase.from("users").delete().in("username", ["teacher1", "parent1"]);
      if (error) throw error;
    }),
    changePassword: (userId, newPassword) => mutate(async () => {
      const { error } = await supabase.from("users").update({ password: newPassword }).eq("id", userId);
      if (error) throw error;
    }),
  };

  return { data, status, persistent, api };
}

/* ============================= SMALL UI ATOMS ============================= */

function CardHeader({ children, tone = "green", className = "" }) {
  const tones = {
    green: "linear-gradient(135deg, var(--green-500), var(--green-900))",
    gold: "linear-gradient(135deg, var(--gold-300), var(--gold-500))",
  };
  return (
    <div className={`card-header-panel ${className}`} style={{ background: tones[tone] }}>
      {children}
    </div>
  );
}

function BehaviorBar({ value, showPercent = false }) {
  const color = value >= 75 ? "var(--green-500)" : value >= 40 ? "var(--yellow-500)" : "var(--red-500)";
  const label = value >= 75 ? "ممتاز" : value >= 40 ? "متوسط" : "بحاجة متابعة";
  return (
    <div className="behavior-meter">
      <div className="behavior-head">
        <span className="behavior-title">سلوك الطالب</span>
        <span className="behavior-status" style={{ color }}>{showPercent ? `${value}% · ` : ""}{label}</span>
      </div>
      <div className="behavior-track"><div className="behavior-fill" style={{ width: `${value}%`, background: color }} /></div>
    </div>
  );
}

function StudentCard({ student, teacherName, editable, onChange, onSave, saving }) {
  const [local, setLocal] = useState(student);
  useEffect(() => setLocal(student), [student.id]);

  const commit = (patch) => {
    const next = { ...local, ...patch };
    setLocal(next);
    onChange && onChange(next);
  };

  return (
    <div className="card student-card">
      <CardHeader>
        <div className="card-avatar"><GraduationCap size={22} color="var(--green-900)" /></div>
        <div>
          <div style={{ fontFamily: "'Tajawal', sans-serif", fontSize: 21, fontWeight: 800, color: "#fff" }}>{local.name}</div>
          <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.85)" }}>العمر {local.age} سنة · {teacherName || "—"}</div>
        </div>
      </CardHeader>

      <div className="card-body">
        <div className="field-row">
          <label className="field-label"><Star size={14} /> المستوى الحالي في الحفظ</label>
          {editable ? (
            <input className="input" value={local.level} onChange={(e) => commit({ level: e.target.value })} />
          ) : (
            <div className="value-pill">{local.level}</div>
          )}
        </div>

        <div className="tomorrow-box">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <Calendar size={16} color="var(--gold-500)" />
            <span style={{ fontWeight: 800, color: "var(--green-900)", fontSize: 14 }}>درس الغد</span>
          </div>
          {editable ? (
            <textarea className="input" rows={2} value={local.nextLesson} onChange={(e) => commit({ nextLesson: e.target.value })} />
          ) : (
            <div style={{ fontSize: 14.5, color: "var(--ink)", lineHeight: 1.7 }}>{local.nextLesson}</div>
          )}
        </div>

        <div className="field-row">
          {editable ? (
            <>
              <label className="field-label">نسبة سلوك الطالب</label>
              <input
                type="range" min={0} max={100} value={local.behavior}
                onChange={(e) => commit({ behavior: Number(e.target.value) })}
                style={{ width: "100%", accentColor: "var(--green-700)" }}
              />
            </>
          ) : null}
          <BehaviorBar value={local.behavior} />
        </div>

        <div className="field-row">
          <label className="field-label"><MessageSquare size={14} /> ملاحظات المعلم لولي الأمر</label>
          {editable ? (
            <textarea className="input" rows={3} value={local.notes} onChange={(e) => commit({ notes: e.target.value })} placeholder="اكتب توجيهاتك هنا..." />
          ) : (
            <div className="value-pill" style={{ minHeight: 44, lineHeight: 1.7 }}>{local.notes || "لا توجد ملاحظات بعد."}</div>
          )}
        </div>

        {editable && (
          <button className="btn btn-primary" style={{ width: "100%", marginTop: 4 }} onClick={() => onSave(local)} disabled={saving}>
            {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            {saving ? "جارٍ الحفظ..." : "حفظ التحديثات"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ============================= HOME PAGE ============================= */

function WhatsAppButton() {
  const phone = "447523663121";
  const message = encodeURIComponent("السلام عليكم، أحتاج مساعدة بخصوص معهد البر.");
  return (
    <a
      className="whatsapp-fab"
      href={`https://wa.me/${phone}?text=${message}`}
      target="_blank"
      rel="noopener noreferrer"
      title="التواصل مع الدعم"
    >
      <svg viewBox="0 0 32 32" width="26" height="26" fill="#fff" aria-hidden="true">
        <path d="M16.02 3C9.4 3 4 8.36 4 15c0 2.34.66 4.53 1.8 6.4L4 29l7.8-1.75A11.9 11.9 0 0 0 16.02 27C22.64 27 28 21.64 28 15S22.64 3 16.02 3zm0 21.7c-1.98 0-3.83-.55-5.4-1.5l-.39-.23-4.37.98.94-4.27-.25-.4A9.62 9.62 0 0 1 6.4 15c0-5.3 4.32-9.62 9.62-9.62S25.64 9.7 25.64 15s-4.32 9.7-9.62 9.7zm5.3-7.24c-.29-.15-1.7-.84-1.96-.93-.26-.1-.46-.15-.65.14-.19.29-.75.93-.92 1.12-.17.19-.34.22-.63.07-.29-.15-1.22-.45-2.32-1.44-.86-.77-1.44-1.71-1.6-2-.17-.29-.02-.44.13-.59.13-.13.29-.34.44-.51.15-.17.19-.29.29-.48.1-.19.05-.36-.02-.51-.07-.15-.65-1.58-.9-2.16-.24-.57-.48-.49-.65-.5h-.56c-.19 0-.51.07-.78.36-.26.29-1.02 1-1.02 2.44s1.05 2.83 1.19 3.03c.15.19 2.06 3.16 5 4.43.7.3 1.24.48 1.67.61.7.22 1.34.19 1.84.11.56-.08 1.7-.7 1.94-1.37.24-.68.24-1.26.17-1.37-.07-.12-.26-.19-.55-.34z"/>
      </svg>
    </a>
  );
}

function HomePage({ onGoLogin, onRegister, registering, pendingCount }) {
  const [form, setForm] = useState({ name: "", age: "", phone: "", level: "" });
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.age || !form.phone || !form.level) return;
    await onRegister(form);
    setSent(true);
    setForm({ name: "", age: "", phone: "", level: "" });
    setTimeout(() => setSent(false), 4000);
  };

  return (
    <div>
      {/* NAV */}
      <header className="nav">
        <div className="nav-inner">
          <button className="btn btn-ghost" style={{ position: "relative" }} onClick={onGoLogin}>
            <LogIn size={16} /> تسجيل الدخول
            {pendingCount > 0 && (
              <span className="notif-dot" title={`${pendingCount} طلب تسجيل جديد`}>{pendingCount}</span>
            )}
          </button>
          <div className="brand">
            <div>
              <div className="brand-title">معهد البر</div>
              <div className="brand-sub">لتعليم القرآن الكريم والسنة النبوية</div>
            </div>
            <div className="brand-mark"><img src="/icons/icon-512.png" alt="معهد البر" /></div>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="hero">
        <div className="hero-grid">
          <div className="hero-text">
            <div className="badge">التسجيل مفتوح للفصل الجديد</div>
            <h1 className="hero-title">متابعة حفظ القرآن<br />أصبحت أوضح وأسرع</h1>
            <p className="hero-desc">
              معهد البر يجمع الطالب والمعلم وولي الأمر في مكان واحد — مستوى الحفظ،
              درس الغد، وسلوك الطالب، محدَّث لحظيًا وبلا تعقيد.
            </p>
            <div className="hero-actions">
              <a href="#register" className="btn btn-primary">سجّل الآن <ArrowLeft size={16} /></a>
              <button className="btn btn-outline" onClick={onGoLogin}>دخول المنتسبين</button>
            </div>
            <div className="hero-stats">
              <div><b>+300</b><span>طالب وطالبة</span></div>
              <div><b>يومي</b><span>تحديث المتابعة</span></div>
              <div><b>3</b><span>بوابات مستقلة</span></div>
            </div>
          </div>

          <div className="hero-visual">
            <div className="preview-card">
              <div className="preview-head">
                <div className="preview-avatar"><GraduationCap size={18} color="#fff" /></div>
                <div>
                  <div className="preview-name">محمد العتيبي</div>
                  <div className="preview-sub">حفظ جزء عمّ — مراجعة</div>
                </div>
              </div>
              <div className="preview-tomorrow">
                <Calendar size={14} color="var(--gold-500)" />
                <span>درس الغد: سورة الملك 1–12</span>
              </div>
              <div className="preview-bar-label">
                <span>سلوك الطالب</span><span className="preview-percent">88%</span>
              </div>
              <div className="preview-bar-track"><div className="preview-bar-fill" /></div>
            </div>
            <div className="preview-chip preview-chip-1"><Check size={13} /> تم حفظ التحديث</div>
            <div className="preview-chip preview-chip-2"><Heart size={13} /> وصل لولي الأمر</div>
          </div>
        </div>
      </section>

      {/* ABOUT / HOW IT WORKS */}
      <section className="section">
        <div className="section-head">
          <h2>كيف يعمل المعهد</h2>
          <p>ثلاث خطوات تربط الطالب بمعلمه وولي أمره، بمتابعة محدَّثة أولًا بأول.</p>
        </div>
        <div className="steps">
          <div className="step-card">
            <span className="step-num">01</span>
            <h3>يسجّل الطالب</h3>
            <p>تعبئة نموذج بسيط ببيانات الطالب ومستوى حفظه الحالي.</p>
          </div>
          <div className="step-arrow"><ArrowLeft size={18} /></div>
          <div className="step-card">
            <span className="step-num">02</span>
            <h3>يتابع المعلم يوميًا</h3>
            <p>تحديث المستوى، درس الغد، وسلوك الطالب من لوحة المعلم.</p>
          </div>
          <div className="step-arrow"><ArrowLeft size={18} /></div>
          <div className="step-card">
            <span className="step-num">03</span>
            <h3>يطّلع ولي الأمر فورًا</h3>
            <p>كل تحديث يصل لبوابة ولي الأمر لحظيًا دون انتظار.</p>
          </div>
        </div>
      </section>

      {/* REGISTER FORM */}
      <section className="section section-alt" id="register">
        <div className="section-head">
          <h2>نموذج تسجيل الطلاب</h2>
          <p>عبّئ البيانات التالية وسيتواصل معك فريق المعهد خلال 24 ساعة.</p>
        </div>
        <form className="card form-card" onSubmit={submit}>
          <div className="form-grid">
            <div className="field-row">
              <label className="field-label">اسم الطالب</label>
              <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="الاسم الكامل" />
            </div>
            <div className="field-row">
              <label className="field-label">العمر</label>
              <input className="input" required type="number" min={4} max={80} value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })} placeholder="مثال: 9" />
            </div>
            <div className="field-row">
              <label className="field-label"><Phone size={14} /> رقم التواصل</label>
              <input className="input" required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="رقم الجوال بالصيغة الدولية، مثال: +966501234567" />
            </div>
            <div className="field-row">
              <label className="field-label">مستوى الحفظ الحالي</label>
              <select className="input" required value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>
                <option value="">اختر المستوى</option>
                <option>مبتدئ — بدون حفظ سابق</option>
                <option>حفظ جزء عمّ</option>
                <option>حفظ من 1 إلى 5 أجزاء</option>
                <option>حفظ أكثر من 5 أجزاء</option>
                <option>حافظ لكتاب الله كاملاً</option>
              </select>
            </div>
          </div>
          <button className="btn btn-primary" style={{ width: "100%" }} disabled={registering}>
            {registering ? <Loader2 size={16} className="spin" /> : <UserPlus size={16} />}
            {registering ? "جارٍ الإرسال..." : "إرسال طلب التسجيل"}
          </button>
          {sent && (
            <div className="success-note"><Check size={15} /> تم استلام طلبك بنجاح، سنتواصل معك قريبًا بإذن الله.</div>
          )}
        </form>
      </section>

      <footer className="footer">
        <span>© معهد البر لتعليم القرآن الكريم والسنة — جميع الحقوق محفوظة</span>
        <div className="signature">صُمم وأُشرف عليه بواسطة <b>أبو عبدالله</b></div>
      </footer>
    </div>
  );
}

/* ============================= LOGIN ============================= */

function LoginPage({ users, onLogin, onBack, pendingCount }) {
  const [role, setRole] = useState("admin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");

  const roles = [
    { id: "admin", label: "المدير", icon: Shield },
    { id: "teacher", label: "المعلم", icon: GraduationCap },
    { id: "parent", label: "ولي الأمر", icon: Heart },
  ];

  const submit = (e) => {
    e.preventDefault();
    const user = validateLogin(users, username, password, role);
    if (!user) {
      setError("بيانات الدخول غير صحيحة، يرجى المحاولة مرة أخرى.");
      return;
    }
    setError("");
    onLogin(normalizeUser(user));
  };

  return (
    <div className="login-wrap">
      <button className="btn btn-ghost" onClick={onBack} style={{ position: "absolute", top: 18, right: 18 }}>
        <ArrowLeft size={16} style={{ transform: "scaleX(-1)" }} /> الرئيسية
      </button>
      <div className="login-card">
        <div className="login-logo"><img src="/icons/icon-512.png" alt="معهد البر" /></div>
        <div className="login-kicker">بوابة معهد البر</div>
        <h2 className="login-title">مرحبًا بك</h2>
        <p className="login-sub">اختر بوابتك للوصول إلى المتابعة والتعليم</p>

        <div className="role-tabs">
          {roles.map((r) => (
            <button type="button" key={r.id} className={`role-tab ${role === r.id ? "active" : ""}`} style={{ position: "relative" }} onClick={() => setRole(r.id)}>
              <r.icon size={18} />
              {r.label}
              {r.id === "admin" && pendingCount > 0 && <span className="notif-dot" style={{ top: -6, left: -6 }}>{pendingCount}</span>}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="field-row" style={{ marginTop: 6 }}>
          <label className="field-label">اسم المستخدم</label>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="اسم المستخدم" />
          <label className="field-label" style={{ marginTop: 10 }}>كلمة المرور</label>
          <div className="password-wrap">
            <input className="input" type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            <button type="button" className="password-toggle" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}>
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
          {error && <div className="error-note"><X size={14} /> {error}</div>}
          <button className="btn btn-primary" style={{ width: "100%", marginTop: 14 }}>
            <LogIn size={16} /> دخول
          </button>
        </form>
      </div>
    </div>
  );
}

/* ============================= SHARED DASHBOARD SHELL ============================= */

function ChangePasswordModal({ user, data, api, onClose }) {
  const [current, setCurrent] = useState("");
  const [next1, setNext1] = useState("");
  const [next2, setNext2] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const me = data.users.find((u) => u.id === user.id);
    if (!me || me.password !== current) { setError("كلمة المرور الحالية غير صحيحة."); return; }
    if (next1.length < 4) { setError("كلمة المرور الجديدة قصيرة جدًا (4 أحرف على الأقل)."); return; }
    if (next1 !== next2) { setError("كلمتا المرور الجديدتان غير متطابقتين."); return; }
    setError("");
    setSaving(true);
    const result = await api.changePassword(user.id, next1);
    setSaving(false);
    if (!result.ok) { setError("تعذّر الحفظ، حاول مرة أخرى."); return; }
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 style={{ fontSize: 18, color: "var(--green-900)" }}>تغيير كلمة المرور</h3>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={submit}>
          <div className="field-row">
            <label className="field-label">كلمة المرور الحالية</label>
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
          </div>
          <div className="field-row">
            <label className="field-label">كلمة المرور الجديدة</label>
            <input className="input" type="password" value={next1} onChange={(e) => setNext1(e.target.value)} />
          </div>
          <div className="field-row">
            <label className="field-label">تأكيد كلمة المرور الجديدة</label>
            <input className="input" type="password" value={next2} onChange={(e) => setNext2(e.target.value)} />
          </div>
          {error && <div className="error-note"><X size={14} /> {error}</div>}
          <button className="btn btn-primary" style={{ width: "100%", marginTop: 6 }} disabled={saving}>
            {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            {saving ? "جارٍ الحفظ..." : "حفظ كلمة المرور"}
          </button>
        </form>
      </div>
    </div>
  );
}

function ParentCredentialsModal({ credentials, onClose }) {
  const [copied, setCopied] = useState(false);

  const copyAll = async () => {
    const text = [
      `اسم ولي الأمر: ${credentials.parentName}`,
      `اسم المستخدم: ${credentials.username}`,
      `كلمة المرور: ${credentials.password}`,
      `رقم الهاتف: ${credentials.phone}`,
      `رابط تسجيل الدخول: ${credentials.loginLink || "https://example.com"}`,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const whatsappUrl = `https://wa.me/${credentials.phone.replace(/\D/g, "")}?text=${encodeURIComponent(
    `السلام عليكم، هذه بيانات حساب ولي الأمر في معهد البر:\nاسم المستخدم: ${credentials.username}\nكلمة المرور: ${credentials.password}\nرقم الهاتف: ${credentials.phone}`
  )}`;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 style={{ fontSize: 18, color: "var(--green-900)" }}>بيانات الحساب</h3>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="field-row">
          <label className="field-label">اسم ولي الأمر</label>
          <div className="value-pill">{credentials.parentName}</div>
        </div>
        <div className="field-row">
          <label className="field-label">اسم المستخدم</label>
          <div className="value-pill">{credentials.username}</div>
        </div>
        <div className="field-row">
          <label className="field-label">كلمة المرور</label>
          <div className="value-pill">{credentials.password}</div>
        </div>
        <div className="field-row">
          <label className="field-label">رقم الهاتف</label>
          <div className="value-pill">{credentials.phone}</div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          <button className="btn btn-primary btn-sm" onClick={copyAll}>{copied ? "تم النسخ" : "نسخ البيانات"}</button>
          <a href={whatsappUrl} className="btn btn-outline btn-sm" target="_blank" rel="noreferrer">إرسال عبر الواتساب</a>
        </div>
      </div>
    </div>
  );
}

function DashboardShell({ title, subtitle, icon: Icon, user, onLogout, children, data, api }) {
  const [showPasswordModal, setShowPasswordModal] = useState(false);

  const handleBellClick = async () => {
    if (!canUseNotifications()) return;

    const granted = await requestNotificationPermission();
    if (granted === "granted") {
      showBrowserNotification("معهد البر", {
        body: "تم تفعيل الإشعارات. ستصل لك التحديثات المهمة فورًا.",
        icon: "/icons/icon-192.png",
      });
    }
  };

  return (
    <div className="dash">
      <header className="dash-header">
        <div className="dash-header-left">
          <div className="brand-mark small"><img src="/icons/icon-512.png" alt="معهد البر" /></div>
          <div>
            <div className="dash-title">{title}</div>
            <div className="dash-sub">{subtitle}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button className="icon-btn header-bell" type="button" title="الإشعارات" onClick={handleBellClick}>
            <Bell size={17} />
          </button>
          <span className="dash-user">{user.name}</span>
          {data && api && (
            <button className="btn btn-ghost" onClick={() => setShowPasswordModal(true)}>
              <Shield size={15} /> كلمة المرور
            </button>
          )}
          <button className="btn btn-ghost" onClick={onLogout}><LogOut size={15} /> خروج</button>
        </div>
      </header>
      <main className="dash-body">{children}</main>
      {showPasswordModal && (
        <ChangePasswordModal user={user} data={data} api={api} onClose={() => setShowPasswordModal(false)} />
      )}
    </div>
  );
}

/* ============================= ADMIN DASHBOARD ============================= */

function AdminDashboard({ data, api, user, onLogout }) {
  const [tab, setTab] = useState("overview");
  const [showAddTeacher, setShowAddTeacher] = useState(false);
  const [showAddParent, setShowAddParent] = useState(false);
  const [parentForm, setParentForm] = useState({ name: "", username: "", password: "", phone: "" });
  const [accountError, setAccountError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [teacherForm, setTeacherForm] = useState({ name: "", username: "", password: "", subject: "", gender: "male" });

  const approve = async (reg) => {
    setBusyId(reg.id);
    await api.approveRegistration(reg, data.teachers[0]?.id || null);
    setBusyId(null);
  };

  const dismiss = async (reg) => {
    setBusyId(reg.id);
    await api.rejectRegistration(reg);
    setBusyId(null);
  };

  const usernameTaken = (username) => data.users.some((u) => u.username === username);

  const friendlyError = (result) =>
    result.code === "23505" ? "اسم المستخدم هذا مستخدم بالفعل." : "تعذّر حفظ الحساب، حاول مرة أخرى.";

  const addTeacher = async (e) => {
    e.preventDefault();
    setAccountError("");
    if (!teacherForm.name || !teacherForm.username || !teacherForm.password) { setAccountError("عبّئ كل الحقول المطلوبة."); return; }
    if (usernameTaken(teacherForm.username)) { setAccountError("اسم المستخدم هذا مستخدم بالفعل."); return; }
    const result = await api.addTeacher(teacherForm);
    if (!result.ok) { setAccountError(friendlyError(result)); return; }
    setTeacherForm({ name: "", username: "", password: "", subject: "", gender: "male" });
    setShowAddTeacher(false);
  };

  const addParent = async (e) => {
    e.preventDefault();
    setAccountError("");
    if (!parentForm.name || !parentForm.username || !parentForm.password) { setAccountError("عبّئ كل الحقول المطلوبة."); return; }
    if (usernameTaken(parentForm.username)) { setAccountError("اسم المستخدم هذا مستخدم بالفعل."); return; }
    const result = await api.addParent(parentForm);
    if (!result.ok) { setAccountError(friendlyError(result)); return; }
    setParentForm({ name: "", username: "", password: "", phone: "" });
    setShowAddParent(false);
  };

  const deleteTeacher = async (id) => {
    if (!window.confirm("هل تريد حذف حساب هذا المعلم؟ سيُنسب طلابه إلى \"بلا معلم\" حتى تعيّن غيره.")) return;
    await api.deleteTeacher(id);
  };

  const deleteParent = async (id) => {
    if (!window.confirm("هل تريد حذف حساب ولي الأمر؟")) return;
    await api.deleteParent(id);
  };

  const deleteStudent = async (id) => {
    if (!window.confirm("هل تريد حذف هذا الطالب نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.")) return;
    await api.deleteStudent(id);
  };

  const clearDemoData = async () => {
    if (!window.confirm("سيتم حذف الحسابات والطلاب التجريبيين نهائيًا (لن يبقى إلا حساب المدير). هل أنت متأكد؟")) return;
    await api.clearDemoData();
  };

  const pending = data.registrations.filter((r) => r.status === "pending");
  const hasDemoData = data.users.some((u) => u.username === "teacher1" || u.username === "parent1");

  return (
    <DashboardShell title="لوحة المدير" subtitle="إدارة عامة للمعهد" icon={Shield} user={user} onLogout={onLogout} data={data} api={api}>
      <section className="dash-welcome admin-welcome">
        <div><span className="eyebrow">نظرة سريعة</span><h1>لوحة إدارة المعهد</h1><p>كل ما تحتاجه لإدارة الطلاب والمعلمين وطلبات التسجيل في مكان واحد.</p></div>
        <div className="welcome-mark"><Shield size={26} /></div>
      </section>
      <div className="stat-row">
        <div className="stat-card"><Users size={20} /><div><div className="stat-num">{data.students.length}</div><div className="stat-label">طالب</div></div></div>
        <div className="stat-card"><GraduationCap size={20} /><div><div className="stat-num">{data.teachers.length}</div><div className="stat-label">معلم</div></div></div>
        <div className="stat-card"><Heart size={20} /><div><div className="stat-num">{data.parents.length}</div><div className="stat-label">ولي أمر</div></div></div>
        <div className="stat-card"><ClipboardCheck size={20} /><div><div className="stat-num">{pending.length}</div><div className="stat-label">طلب معلّق</div></div></div>
      </div>

      <div className="tabs">
        {[["overview", "طلبات التسجيل"], ["students", "الطلاب"], ["teachers", "المعلمون"], ["accounts", "الحسابات"]].map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
            {label}
            {id === "overview" && pending.length > 0 && <span className="tab-count">{pending.length}</span>}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="list">
          {data.registrations.length === 0 && <div className="empty-note">لا توجد طلبات تسجيل بعد.</div>}
          {data.registrations.map((r) => (
            <div className="list-row" key={r.id}>
              <div>
                <div className="list-row-title">{r.name} <span className="muted">· {r.age} سنة</span></div>
                <div className="list-row-sub">{r.level} · {r.phone}</div>
              </div>
              {r.status === "pending" ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => approve(r)} disabled={busyId === r.id}>
                    {busyId === r.id ? <Loader2 size={14} className="spin" /> : <Check size={14} />} قبول
                  </button>
                  <button className="btn btn-outline btn-sm" onClick={() => dismiss(r)} disabled={busyId === r.id}><X size={14} /> رفض</button>
                </div>
              ) : (
                <span className={`status-badge ${r.status}`}>{r.status === "approved" ? "مقبول" : "مرفوض"}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "students" && (
        <div className="list">
          {data.students.length === 0 && <div className="empty-note">لا يوجد طلاب بعد.</div>}
          {data.students.map((s) => (
            <div className="list-row student-assign-row" key={s.id}>
              <div>
                <div className="list-row-title">{s.name} <span className="muted">· {s.age} سنة</span></div>
                <div className="list-row-sub">{s.level}</div>
              </div>
              <div className="assign-selects">
                <select
                  className="input input-sm"
                  value={s.teacherId || ""}
                  onChange={(e) => api.assignStudent(s.id, { teacherId: e.target.value || null })}
                >
                  <option value="">بلا معلم</option>
                  {data.teachers.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <select
                  className="input input-sm"
                  value={s.parentId || ""}
                  onChange={(e) => api.assignStudent(s.id, { parentId: e.target.value || null })}
                >
                  <option value="">بلا ولي أمر</option>
                  {data.parents.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div style={{ width: 120 }}><BehaviorBar value={s.behavior} /></div>
              <button className="btn btn-outline btn-sm" onClick={() => deleteStudent(s.id)}><Trash2 size={14} /> حذف</button>
            </div>
          ))}
        </div>
      )}

      {tab === "teachers" && (
        <div className="list">
          {data.teachers.map((t) => {
            const count = data.students.filter((s) => s.teacherId === t.id).length;
            return (
              <div className="list-row" key={t.id}>
                <div>
                  <div className="list-row-title">{t.name}</div>
                  <div className="list-row-sub">{t.subject}</div>
                </div>
                <span className="value-pill" style={{ margin: 0 }}>{count} طالب</span>
              </div>
            );
          })}
        </div>
      )}

      {tab === "accounts" && (
        <div>
          <div className="accounts-section">
            <div className="accounts-section-head">
              <h3>حسابات المعلمين</h3>
              <button className="btn btn-primary btn-sm" onClick={() => { setShowAddTeacher((v) => !v); setAccountError(""); }}>
                <Plus size={14} /> إضافة معلم
              </button>
            </div>
            {showAddTeacher && (
              <form className="inline-form" onSubmit={addTeacher}>
                <div className="form-grid">
                  <div className="field-row">
                    <label className="field-label">اسم المعلم</label>
                    <input className="input" value={teacherForm.name} onChange={(e) => setTeacherForm({ ...teacherForm, name: e.target.value })} />
                  </div>
                  <div className="field-row">
                    <label className="field-label">نوع المعلم</label>
                    <select className="input" value={teacherForm.gender} onChange={(e) => setTeacherForm({ ...teacherForm, gender: e.target.value })}>
                      <option value="male">ذكر</option>
                      <option value="female">أنثى</option>
                    </select>
                  </div>
                  <div className="field-row">
                    <label className="field-label">التخصص (اختياري)</label>
                    <input className="input" value={teacherForm.subject} onChange={(e) => setTeacherForm({ ...teacherForm, subject: e.target.value })} placeholder="تحفيظ القرآن الكريم" />
                  </div>
                  <div className="field-row">
                    <label className="field-label">اسم المستخدم</label>
                    <input className="input" value={teacherForm.username} onChange={(e) => setTeacherForm({ ...teacherForm, username: e.target.value })} />
                  </div>
                  <div className="field-row">
                    <label className="field-label">كلمة المرور</label>
                    <input className="input" type="password" value={teacherForm.password} onChange={(e) => setTeacherForm({ ...teacherForm, password: e.target.value })} />
                  </div>
                </div>
                {accountError && <div className="error-note"><X size={14} /> {accountError}</div>}
                <button className="btn btn-primary" style={{ width: "100%", marginTop: 6 }}><Save size={15} /> حفظ حساب المعلم</button>
              </form>
            )}
            <div className="list">
              {data.teachers.length === 0 && <div className="empty-note">لا يوجد معلمون بعد.</div>}
              {data.teachers.map((t) => (
                <div className="list-row" key={t.id}>
                  <div>
                    <div className="list-row-title">{t.name}</div>
                    <div className="list-row-sub">{t.subject} · {data.users.find((u) => u.id === t.id)?.username}</div>
                  </div>
                  <button className="btn btn-outline btn-sm" onClick={() => deleteTeacher(t.id)}><Trash2 size={14} /> حذف</button>
                </div>
              ))}
            </div>
          </div>

          <div className="accounts-section">
            <div className="accounts-section-head">
              <h3>حسابات أولياء الأمور</h3>
              <button className="btn btn-primary btn-sm" onClick={() => { setShowAddParent((v) => !v); setAccountError(""); }}>
                <Plus size={14} /> إضافة ولي أمر
              </button>
            </div>
            {showAddParent && (
              <form className="inline-form" onSubmit={addParent}>
                <div className="form-grid">
                  <div className="field-row">
                    <label className="field-label">اسم ولي الأمر</label>
                    <input className="input" value={parentForm.name} onChange={(e) => setParentForm({ ...parentForm, name: e.target.value })} />
                  </div>
                  <div className="field-row">
                    <label className="field-label">رقم التواصل (اختياري)</label>
                    <input className="input" value={parentForm.phone} onChange={(e) => setParentForm({ ...parentForm, phone: e.target.value })} />
                  </div>
                  <div className="field-row">
                    <label className="field-label">اسم المستخدم</label>
                    <input className="input" value={parentForm.username} onChange={(e) => setParentForm({ ...parentForm, username: e.target.value })} />
                  </div>
                  <div className="field-row">
                    <label className="field-label">كلمة المرور</label>
                    <input className="input" type="password" value={parentForm.password} onChange={(e) => setParentForm({ ...parentForm, password: e.target.value })} />
                  </div>
                </div>
                {accountError && <div className="error-note"><X size={14} /> {accountError}</div>}
                <button className="btn btn-primary" style={{ width: "100%", marginTop: 6 }}><Save size={15} /> حفظ حساب ولي الأمر</button>
              </form>
            )}
            <div className="list">
              {data.parents.length === 0 && <div className="empty-note">لا يوجد أولياء أمور بعد.</div>}
              {data.parents.map((p) => (
                <div className="list-row" key={p.id}>
                  <div>
                    <div className="list-row-title">{p.name}</div>
                    <div className="list-row-sub">{p.phone} · {data.users.find((u) => u.id === p.id)?.username}</div>
                  </div>
                  <button className="btn btn-outline btn-sm" onClick={() => deleteParent(p.id)}><Trash2 size={14} /> حذف</button>
                </div>
              ))}
            </div>
          </div>

          {hasDemoData && (
            <div className="danger-zone">
              <h4>البيانات التجريبية</h4>
              <p>لسا موجود حساب المعلم وولي الأمر التجريبيين (teacher1 / parent1) مع طالبيهما. احذفهم قبل تسليم المعهد للاستخدام الفعلي.</p>
              <button className="btn btn-danger btn-sm" onClick={clearDemoData}><Trash2 size={14} /> حذف البيانات التجريبية نهائيًا</button>
            </div>
          )}
        </div>
      )}
      <MobileNav
        role="admin"
        onHome={() => { setTab("overview"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
        onStudents={() => { setTab("students"); setTimeout(() => document.querySelector(".tabs")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0); }}
        onReports={() => { setTab("overview"); setTimeout(() => document.querySelector(".tabs")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0); }}
        onMore={() => { setTab("accounts"); setTimeout(() => document.querySelector(".tabs")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0); }}
      />
    </DashboardShell>
  );
}

/* ============================= TEACHER DASHBOARD ============================= */

function TeacherDashboard({ data, api, user, onLogout }) {
  const teacherGender = user.gender || "male";
  const myStudents = data.students.filter((s) => s.teacherId === user.id && (!teacherGender || s.gender === teacherGender));
  const [selectedId, setSelectedId] = useState(myStudents[0]?.id || null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [showAddStudent, setShowAddStudent] = useState(false);
  const [studentForm, setStudentForm] = useState({ name: "", age: "", gender: teacherGender === "female" ? "female" : "male", parentPhone: "", parentName: "", level: "", nextLesson: "", notes: "" });
  const [phoneStatus, setPhoneStatus] = useState({ loading: false, foundParent: null, mode: "idle" });
  const parentsRef = useRef(data.parents);
  parentsRef.current = data.parents;
  const [parentDecision, setParentDecision] = useState(null);
  const [confirmParentLink, setConfirmParentLink] = useState(false);
  const [credentials, setCredentials] = useState(null);
  const selected = data.students.find((s) => s.id === selectedId);
  const filteredStudents = myStudents.filter((s) => s.name.toLowerCase().includes(search.trim().toLowerCase()));
  const excellent = myStudents.filter((s) => s.behavior >= 75).length;
  const needsFollowUp = myStudents.filter((s) => s.behavior < 40).length;

  const save = async (updated) => {
    setSaving(true);
    try { await api.updateStudent(updated.id, updated); } finally { setSaving(false); }
  };

  useEffect(() => {
    const phone = studentForm.parentPhone || "";
    if (phone.length < 7) {
      setPhoneStatus({ loading: false, foundParent: null, mode: "idle" });
      return;
    }

    let cancelled = false;
    const run = async () => {
      setPhoneStatus((prev) => ({ ...prev, loading: true }));
      try {
        let parent = null;
        try { parent = await findParentByPhone(supabase, phone); } catch { parent = null; }
        if (!parent) {
          // احتياط: ابحث محليًا بمطابقة ذكية للرقم (تتجاهل رمز الدولة والصفر الأول) لو اختلفت صيغة التخزين
          parent = (parentsRef.current || []).find((p) => phonesMatch(p.phone || "", phone)) || null;
        }
        if (cancelled) return;
        setConfirmParentLink(false);
        setPhoneStatus({ loading: false, foundParent: parent, mode: parent ? "existing" : "new" });
      } catch {
        if (cancelled) return;
        setConfirmParentLink(false);
        setPhoneStatus({ loading: false, foundParent: null, mode: "new" });
      }
    };

    const timer = setTimeout(run, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [studentForm.parentPhone]);

  const handleAddStudent = async (e) => {
    e.preventDefault();
    if (!studentForm.name || !studentForm.age || !studentForm.parentPhone || !studentForm.level) {
      setParentDecision({ type: "error", message: "يرجى تعبئة الاسم والعمر ورقم الهاتف والمستوى." });
      return;
    }

    const phone = normalizePhone(studentForm.parentPhone);
    const parent = phoneStatus.foundParent;

    if (parent && !confirmParentLink) {
      setParentDecision({ type: "error", message: `رقم الهاتف هذا مربوط بولي الأمر ${parent.name}. الرجاء تأكيد الربط قبل الحفظ.` });
      return;
    }

    try {
      if (parent) {
        const result = await api.addStudentForTeacher({
          teacherId: user.id,
          student: {
            name: studentForm.name,
            age: studentForm.age,
            gender: studentForm.gender,
            level: studentForm.level,
            nextLesson: studentForm.nextLesson,
            notes: studentForm.notes,
            behavior: 70,
          },
          existingParentId: parent.id,
          parentPhone: phone,
          parentName: parent.name,
          username: "",
          password: "",
        });
        if (!result.ok) throw new Error(result.message || "تعذّر حفظ الطالب.");
        setParentDecision({ type: "success", message: `تم ربط الطالب بحساب ولي الأمر ${parent.name} بنجاح.` });
      } else {
        const username = `${studentForm.name.replace(/\s+/g, "").toLowerCase()}${Math.floor(Math.random() * 90 + 10)}`;
        const password = `P@${Math.random().toString(36).slice(2, 8)}`;
        const result = await api.addStudentForTeacher({
          teacherId: user.id,
          student: {
            name: studentForm.name,
            age: studentForm.age,
            gender: studentForm.gender,
            level: studentForm.level,
            nextLesson: studentForm.nextLesson,
            notes: studentForm.notes,
            behavior: 70,
          },
          existingParentId: null,
          parentPhone: phone,
          parentName: `${studentForm.parentName || "ولي الأمر"}`,
          username,
          password,
        });
        if (!result.ok) throw new Error(result.message || "تعذّر إنشاء الحساب.");
        setCredentials({
          parentName: studentForm.parentName || "ولي الأمر",
          username,
          password,
          phone: phone,
          loginLink: window.location.origin,
        });
        setParentDecision({ type: "success", message: "تم إنشاء حساب ولي الأمر وربطه بالطالب بنجاح." });
      }

      setShowAddStudent(false);
      setStudentForm({ name: "", age: "", gender: teacherGender === "female" ? "female" : "male", parentPhone: "", parentName: "", level: "", nextLesson: "", notes: "" });
      setPhoneStatus({ loading: false, foundParent: null, mode: "idle" });
      setConfirmParentLink(false);
      setParentDecision(null);
    } catch (error) {
      const msg = String(error.message || "");
      setParentDecision({
        type: "error",
        message: msg.includes("idx_parents_phone_unique")
          ? "رقم الهاتف هذا مسجّل لولي أمر موجود. أعد كتابة الرقم لتظهر رسالة الربط، ثم اضغط «تأكيد الربط»."
          : (msg || "حدث خطأ غير متوقع."),
      });
    }
  };

  const parentNameLabel = phoneStatus.foundParent ? phoneStatus.foundParent.name : (studentForm.parentName || "ولي الأمر");

  return (
    <DashboardShell title="لوحة المعلم" subtitle={user.name} icon={GraduationCap} user={user} onLogout={onLogout} data={data} api={api}>
      <section className="dash-welcome">
        <div>
          <span className="eyebrow">متابعة اليوم</span>
          <h1>السلام عليكم، {user.name}</h1>
          <p>تابع طلابك وحدّث بياناتهم بسرعة من مكان واحد.</p>
        </div>
        <div className="welcome-mark"><GraduationCap size={28} /></div>
      </section>

      <div className="teacher-summary" id="teacher-summary">
        <div><span>{myStudents.length}</span><small>طلاب اليوم</small></div>
        <div><span>{excellent}</span><small>ممتاز</small></div>
        <div><span>{needsFollowUp}</span><small>يحتاج متابعة</small></div>
      </div>

      <div style={{ marginBottom: 18 }}>
        <button className="btn btn-primary btn-sm" onClick={() => setShowAddStudent((v) => !v)}>
          <Plus size={14} /> إضافة طالب جديد
        </button>
      </div>

      {showAddStudent && (
        <div className="card" style={{ padding: 18, marginBottom: 20 }}>
          <form onSubmit={handleAddStudent}>
            <div className="form-grid">
              <div className="field-row">
                <label className="field-label">اسم الطالب</label>
                <input className="input" value={studentForm.name} onChange={(e) => setStudentForm({ ...studentForm, name: e.target.value })} />
              </div>
              <div className="field-row">
                <label className="field-label">العمر</label>
                <input type="number" className="input" value={studentForm.age} onChange={(e) => setStudentForm({ ...studentForm, age: e.target.value })} />
              </div>
              <div className="field-row">
                <label className="field-label">الجنس</label>
                <select className="input" value={studentForm.gender} onChange={(e) => setStudentForm({ ...studentForm, gender: e.target.value })}>
                  <option value="male">ذكر</option>
                  <option value="female">أنثى</option>
                </select>
              </div>
              <div className="field-row">
                <label className="field-label">رقم هاتف ولي الأمر</label>
                <input className="input" value={studentForm.parentPhone} onChange={(e) => setStudentForm({ ...studentForm, parentPhone: e.target.value })} placeholder="رقم الجوال بالصيغة الدولية، مثال: +966501234567" />
              </div>
              <div className="field-row">
                <label className="field-label">المستوى الحالي</label>
                <input className="input" value={studentForm.level} onChange={(e) => setStudentForm({ ...studentForm, level: e.target.value })} />
              </div>
              <div className="field-row">
                <label className="field-label">درس الغد (اختياري)</label>
                <input className="input" value={studentForm.nextLesson} onChange={(e) => setStudentForm({ ...studentForm, nextLesson: e.target.value })} />
              </div>
            </div>

            {phoneStatus.loading && <div className="error-note">جارٍ البحث عن رقم الهاتف…</div>}
            {phoneStatus.mode === "existing" && phoneStatus.foundParent && (
              <div className="success-note" style={{ marginBottom: 12, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Check size={15} /> رقم الهاتف هذا مربوط بولي الأمر {phoneStatus.foundParent.name}. هل تريد ربط هذا الطالب بحسابه؟
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => { setConfirmParentLink(true); setParentDecision({ type: "success", message: `سيتم ربط الطالب بحساب ${phoneStatus.foundParent.name}.` }); }}>تأكيد الربط</button>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => { setConfirmParentLink(false); setParentDecision({ type: "error", message: "تم إلغاء الربط، يمكنك إنشاء حساب جديد إذا لزم الأمر." }); }}>إلغاء</button>
                </div>
              </div>
            )}
            {phoneStatus.mode === "new" && (
              <div className="field-row" style={{ marginTop: 8 }}>
                <label className="field-label">اسم ولي الأمر الكامل</label>
                <input className="input" value={studentForm.parentName || ""} onChange={(e) => setStudentForm({ ...studentForm, parentName: e.target.value })} placeholder="اسم ولي الأمر" />
              </div>
            )}
            {parentDecision && (
              <div className={`error-note ${parentDecision.type === "success" ? "success-note" : ""}`}><X size={14} /> {parentDecision.message}</div>
            )}

            <button className="btn btn-primary" style={{ width: "100%" }} type="submit">
              <Save size={15} /> حفظ الطالب وربطه بالوالد
            </button>
          </form>
        </div>
      )}

      {credentials && (
        <ParentCredentialsModal credentials={credentials} onClose={() => setCredentials(null)} />
      )}

      <div className="teacher-layout" id="teacher-students">
        <div className="student-list-col">
          <div className="student-list-head">
            <div><div className="col-heading">طلابي</div><span className="muted">{myStudents.length} طالب</span></div>
          </div>
          <div className="search-wrap">
            <input className="input student-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث عن طالب..." aria-label="البحث عن طالب" />
          </div>
          {filteredStudents.map((s) => (
            <button key={s.id} className={`student-pick ${selectedId === s.id ? "active" : ""}`} onClick={() => setSelectedId(s.id)}>
              <span className="student-pick-name">{s.name}</span>
              <span className="student-pick-meta">{s.level || "لم يحدد المستوى"}</span>
              <span className={`mini-dot ${s.behavior >= 75 ? "good" : s.behavior >= 40 ? "mid" : "low"}`} />
            </button>
          ))}
          {filteredStudents.length === 0 && <div className="empty-note">لا توجد نتائج مطابقة.</div>}
        </div>
        <div className="student-detail-col">
          {selected ? (
            <StudentCard key={selected.id} student={selected} teacherName={user.name} editable onSave={save} saving={saving} />
          ) : <div className="empty-note">اختر طالبًا من القائمة لعرض بياناته وتحديثها.</div>}
        </div>
      </div>
      <MobileNav
        role="teacher"
        onHome={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        onStudents={() => document.getElementById("teacher-students")?.scrollIntoView({ behavior: "smooth", block: "start" })}
        onReports={() => document.getElementById("teacher-summary")?.scrollIntoView({ behavior: "smooth", block: "center" })}
        onMore={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      />
    </DashboardShell>
  );
}

/* ============================= PARENT DASHBOARD ============================= */

function ParentDashboard({ data, api, user, onLogout }) {
  const myChildren = data.students.filter((s) => s.parentId === user.id);
  return (
    <DashboardShell title="بوابة ولي الأمر" subtitle={user.name} icon={Heart} user={user} onLogout={onLogout} data={data} api={api}>
      <section className="dash-welcome parent-welcome">
        <div>
          <span className="eyebrow">متابعة الأبناء</span>
          <h1>مرحبًا، {user.name}</h1>
          <p>اطّلع على مستوى الحفظ ودرس الغد وملاحظات المعلم بكل وضوح.</p>
        </div>
        <div className="welcome-mark"><Heart size={26} /></div>
      </section>
      {myChildren.length === 0 ? (
        <div className="empty-state"><Heart size={28} /><strong>لا يوجد أبناء مرتبطون بحسابك حاليًا</strong><span>سيظهر الطلاب هنا بعد ربطهم بحساب ولي الأمر.</span></div>
      ) : (
        <div className="parent-grid" id="parent-children">
          {myChildren.map((s) => {
            const teacher = data.teachers.find((t) => t.id === s.teacherId);
            return <StudentCard key={s.id} student={s} teacherName={teacher?.name} editable={false} />;
          })}
        </div>
      )}
      <MobileNav
        role="parent"
        onHome={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        onStudents={() => document.getElementById("parent-children")?.scrollIntoView({ behavior: "smooth", block: "start" })}
        onReports={() => document.getElementById("parent-children")?.scrollIntoView({ behavior: "smooth", block: "start" })}
        onMore={() => document.querySelector(".header-bell")?.click()}
      />
    </DashboardShell>
  );
}

function MobileNav({ role, onHome, onStudents, onReports, onMore }) {
  const [active, setActive] = useState("home");
  const wrap = (id, fn) => () => { setActive(id); fn?.(); };
  const items = role === "admin"
    ? [["home", "الرئيسية", Home, wrap("home", onHome)], ["students", "الطلاب", Users, wrap("students", onStudents)], ["reports", "الطلبات", ClipboardList, wrap("reports", onReports)], ["more", "المزيد", MoreHorizontal, wrap("more", onMore)]]
    : role === "teacher"
      ? [["home", "الرئيسية", Home, wrap("home", onHome)], ["students", "طلابي", Users, wrap("students", onStudents)], ["reports", "المتابعة", ClipboardList, wrap("reports", onReports)], ["more", "المزيد", MoreHorizontal, wrap("more", onMore)]]
      : [["home", "الرئيسية", Home, wrap("home", onHome)], ["students", "أبنائي", Users, wrap("students", onStudents)], ["reports", "التقارير", ClipboardList, wrap("reports", onReports)], ["more", "المزيد", MoreHorizontal, wrap("more", onMore)]];
  return <nav className="mobile-bottom-nav" aria-label="التنقل الرئيسي">{items.map(([id,label,Icon,fn]) => (
    <button key={id} className={`mobile-nav-item ${active === id ? "active" : ""}`} onClick={fn} type="button">
      <span className="mobile-nav-icon"><Icon size={19} /></span><span>{label}</span>
    </button>
  ))}</nav>;
}

/* ============================= APP ROOT ============================= */

export default function App() {
  const { data, status, api, persistent } = useAppData();
  const [view, setView] = useState("home"); // home | login | dashboard
  const [currentUser, setCurrentUser] = useState(null);
  const [registering, setRegistering] = useState(false);

  useEffect(() => {
    const stored = readStoredSession();
    const safeUser = normalizeUser(stored);
    if (safeUser) {
      setCurrentUser(safeUser);
      setView("dashboard");
    }
  }, []);

  useEffect(() => {
    if (!currentUser || !canUseNotifications()) return;

    const syncNotificationToken = async () => {
      try {
        const existingToken = readNotificationToken();
        if (Notification.permission === "default") {
          const result = await requestNotificationPermission();
          if (result === "granted") {
            const token = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            persistNotificationToken(token);
          }
        } else if (Notification.permission === "granted") {
          if (!existingToken) {
            const token = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            persistNotificationToken(token);
          }
        }
      } catch {
        // Ignore notification setup errors.
      }
    };

    syncNotificationToken();
  }, [currentUser]);

  const handleRegister = async (form) => {
    setRegistering(true);
    try {
      await api.submitRegistration(form);
    } finally {
      setRegistering(false);
    }
  };

  const handleLogin = (user) => {
    const safeUser = normalizeUser(user);
    if (!safeUser) return;
    persistSession(safeUser);
    setCurrentUser(safeUser);
    setView("dashboard");
  };

  const handleLogout = () => {
    clearSession();
    clearNotificationToken();
    setCurrentUser(null);
    setView("home");
  };

  return (
    <div dir="rtl" className="app-root">
      <style>{`
        ${FONT_IMPORT}
        :root {
          --ink: #14231C; --bg: #F6F7F1; --surface: #FFFFFF;
          --green-900: #0E4430; --green-700: #128257; --green-500: #22A06B; --green-400: #35B37E;
          --gold-500: #C9A227; --gold-300: #E7CC7A;
          --muted: #75847A; --red-500: #D65D4D; --yellow-500: #E0A83F;
          --border: #E7E7DD;
        }
        * { box-sizing: border-box; }
        .app-root { font-family: 'Cairo', sans-serif; background: var(--bg); color: var(--ink); min-height: 100%; }
        h1,h2,h3 { font-family: 'Tajawal', sans-serif; margin: 0; font-weight: 800; }
        p { margin: 0; }
        button { font-family: inherit; cursor: pointer; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* NAV */
        .nav { background: rgba(255,255,255,0.82); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid rgba(231,225,210,0.7); position: sticky; top: 0; z-index: 20; }
        .nav-inner { max-width: 1080px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; }
        .brand { display: flex; align-items: center; gap: 10px; }
        .brand-title { font-family: 'Tajawal', sans-serif; font-weight: 800; font-size: 19px; color: var(--green-900); }
        .brand-sub { font-size: 11.5px; color: var(--muted); }
        .brand-mark { width: 42px; height: 42px; border-radius: 12px; background: linear-gradient(160deg, var(--green-500), var(--green-900)); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .brand-mark.small { width: 34px; height: 34px; border-radius: 10px; }

        /* HERO */
        .hero { padding: 70px 24px 90px; overflow: hidden; }
        .hero-grid { max-width: 1120px; margin: 0 auto; display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 48px; align-items: center; }
        .badge { display: inline-block; padding: 7px 16px; background: #E9F6EE; color: var(--green-700); border-radius: 999px; font-size: 12.5px; font-weight: 700; margin-bottom: 20px; }
        .hero-title { font-size: clamp(30px, 4.2vw, 46px); line-height: 1.28; color: var(--ink); margin-bottom: 18px; letter-spacing: -0.5px; }
        .hero-desc { color: var(--muted); font-size: 16px; line-height: 1.85; max-width: 480px; margin-bottom: 30px; }
        .hero-actions { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 40px; }
        .hero-stats { display: flex; gap: 30px; flex-wrap: wrap; }
        .hero-stats div { display: flex; flex-direction: column; gap: 2px; }
        .hero-stats b { font-size: 20px; font-weight: 800; color: var(--green-900); font-family: 'Tajawal', sans-serif; }
        .hero-stats span { font-size: 12px; color: var(--muted); }

        .hero-visual { position: relative; display: flex; justify-content: center; align-items: center; min-height: 340px; }
        .hero-visual::before { content: ''; position: absolute; width: 320px; height: 320px; border-radius: 50%;
          background: radial-gradient(circle, rgba(34,160,107,0.16), transparent 70%); }
        .preview-card { position: relative; width: 100%; max-width: 300px; background: var(--surface); border: 1px solid var(--border);
          border-radius: 20px; padding: 20px; box-shadow: 0 20px 50px rgba(14,68,48,0.14); animation: float-card 5s ease-in-out infinite; }
        @keyframes float-card { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
        .preview-head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
        .preview-avatar { width: 38px; height: 38px; border-radius: 12px; background: linear-gradient(160deg, var(--green-500), var(--green-900)); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .preview-name { font-weight: 800; font-size: 14.5px; color: var(--ink); }
        .preview-sub { font-size: 11.5px; color: var(--muted); }
        .preview-tomorrow { display: flex; align-items: center; gap: 6px; background: #FBF6E8; border: 1px solid var(--gold-300); border-radius: 10px; padding: 9px 12px; font-size: 12px; color: var(--ink); margin-bottom: 14px; font-weight: 600; }
        .preview-bar-label { display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; color: var(--ink); margin-bottom: 6px; }
        .preview-percent { color: var(--green-500); }
        .preview-bar-track { height: 9px; border-radius: 999px; background: #EDE8DA; overflow: hidden; }
        .preview-bar-fill { width: 88%; height: 100%; border-radius: 999px; background: var(--green-500); animation: grow-bar 1.4s ease .3s both; }
        @keyframes grow-bar { from { width: 0; } to { width: 88%; } }
        .preview-chip { position: absolute; display: flex; align-items: center; gap: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 7px 12px; font-size: 11.5px; font-weight: 700; color: var(--green-700); box-shadow: 0 10px 24px rgba(14,68,48,0.12); }
        .preview-chip-1 { top: 6%; left: -6%; animation: float-chip 4.5s ease-in-out infinite; }
        .preview-chip-2 { bottom: 10%; right: -8%; animation: float-chip 4.5s ease-in-out 1.2s infinite; }
        @keyframes float-chip { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }

        /* BUTTONS */
        .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 22px; border-radius: 13px; font-size: 14.5px; font-weight: 700; border: none; transition: transform .18s ease, box-shadow .18s ease, opacity .15s; }
        .btn:hover { transform: translateY(-1.5px); }
        .btn:active { transform: scale(0.97); }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .btn-sm { padding: 8px 14px; font-size: 13px; }
        .btn-primary { background: linear-gradient(160deg, var(--green-500), var(--green-900)); color: #fff; box-shadow: 0 8px 20px rgba(11,61,46,0.28); }
        .btn-primary:hover { box-shadow: 0 12px 26px rgba(11,61,46,0.34); }
        .btn-gold { background: linear-gradient(160deg, var(--gold-300), var(--gold-500)); color: #2b2205; box-shadow: 0 8px 20px rgba(201,162,39,0.4); }
        .btn-gold:hover { box-shadow: 0 12px 26px rgba(201,162,39,0.48); }
        .btn-ghost { background: transparent; color: var(--green-900); border: 1px solid var(--border); }
        .btn-outline { background: transparent; color: var(--green-900); border: 1.5px solid var(--green-700); }
        .btn-outline-light { background: transparent; color: #fff; border: 1.5px solid rgba(255,255,255,0.55); }
        .notif-dot { position: absolute; top: -7px; left: -7px; background: var(--red-500); color: #fff; font-size: 10.5px; font-weight: 800; min-width: 19px; height: 19px; border-radius: 999px; display: flex; align-items: center; justify-content: center; padding: 0 4px; border: 2px solid var(--surface); animation: pulse-dot 1.8s ease-in-out infinite; }
        @keyframes pulse-dot { 0%,100% { transform: scale(1); } 50% { transform: scale(1.15); } }
        .tab-count { background: var(--red-500); color: #fff; font-size: 11px; font-weight: 800; min-width: 18px; height: 18px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; padding: 0 5px; margin-right: 6px; }
        .persist-warning { background: #FDF3E7; color: #8A5A12; border-bottom: 1px solid #F0DDB8; font-size: 12.5px; text-align: center; padding: 8px 14px; font-weight: 600; }
        .whatsapp-fab { position: fixed; bottom: 22px; left: 22px; width: 58px; height: 58px; border-radius: 50%; background: linear-gradient(160deg, #25D366, #1DA851); display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 24px rgba(29,168,81,0.45); z-index: 50; animation: fab-pop .5s ease; }
        .whatsapp-fab:hover { transform: translateY(-2px) scale(1.04); box-shadow: 0 14px 30px rgba(29,168,81,0.55); }
        @keyframes fab-pop { from { transform: scale(0); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        .signature { font-size: 11.5px; color: var(--muted); letter-spacing: .2px; }
        .signature b { color: var(--green-700); font-weight: 800; }

        /* SECTIONS */
        .section { max-width: 1080px; margin: 0 auto; padding: 64px 24px; }
        .section-alt { background: var(--surface); max-width: none; padding: 64px 24px; }
        .section-head { text-align: center; max-width: 560px; margin: 0 auto 40px; }
        .section-head h2 { font-size: 28px; color: var(--green-900); margin-bottom: 10px; }
        .section-head p { color: var(--muted); font-size: 14.5px; line-height: 1.8; }
        .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
        .feature-card { background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 28px 24px; text-align: center; transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease; }
        .feature-card:hover { transform: translateY(-3px); box-shadow: 0 16px 32px rgba(11,61,46,0.1); border-color: var(--gold-300); }
        .steps { display: flex; align-items: stretch; gap: 14px; max-width: 1080px; margin: 0 auto; }
        .step-card { flex: 1; background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 26px 22px; transition: transform .2s ease, box-shadow .2s ease; }
        .step-card:hover { transform: translateY(-3px); box-shadow: 0 16px 32px rgba(11,68,48,0.09); }
        .step-num { display: inline-block; font-family: 'Tajawal', sans-serif; font-weight: 900; font-size: 26px; color: var(--gold-500); margin-bottom: 10px; }
        .step-card h3 { font-size: 16.5px; color: var(--green-900); margin-bottom: 8px; }
        .step-card p { font-size: 13.5px; color: var(--muted); line-height: 1.8; }
        .step-arrow { display: flex; align-items: center; color: var(--border); flex-shrink: 0; transform: scaleX(-1); }
        .feature-icon { color: var(--gold-500); margin-bottom: 12px; }
        .feature-card h3 { font-size: 17px; color: var(--green-900); margin-bottom: 8px; }
        .feature-card p { font-size: 13.5px; color: var(--muted); line-height: 1.8; }

        /* FORM CARD */
        .card { background: var(--surface); border-radius: 20px; border: 1px solid var(--border); overflow: hidden; box-shadow: 0 10px 30px rgba(11,61,46,0.08); transition: box-shadow .2s ease; }
        .form-card { max-width: 640px; margin: 0 auto; padding: 30px; }
        .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
        .field-row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
        .field-label { font-size: 13px; font-weight: 700; color: var(--green-900); display: flex; align-items: center; gap: 6px; }
        .input { width: 100%; padding: 11px 14px; border-radius: 10px; border: 1.5px solid var(--border); font-family: inherit; font-size: 14px; background: #fff; color: var(--ink); resize: vertical; }
        .input:focus { outline: none; border-color: var(--green-500); box-shadow: 0 0 0 3px rgba(31,122,92,0.15); }
        .success-note { margin-top: 14px; display: flex; align-items: center; gap: 8px; color: var(--green-700); font-size: 13.5px; font-weight: 600; }
        .error-note { margin-top: 4px; display: flex; align-items: center; gap: 6px; color: var(--red-500); font-size: 13px; font-weight: 600; }
        .modal-overlay { position: fixed; inset: 0; background: rgba(14,68,48,0.45); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 20px; }
        .modal-card { background: var(--surface); border-radius: 18px; padding: 24px; max-width: 380px; width: 100%; box-shadow: 0 24px 60px rgba(0,0,0,0.3); }
        .modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
        .icon-btn { background: none; border: none; color: var(--muted); padding: 4px; border-radius: 8px; }
        .icon-btn:hover { background: #F3F1E9; }
        .accounts-section { margin-bottom: 26px; }
        .accounts-section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
        .accounts-section-head h3 { font-size: 15px; color: var(--green-900); }
        .inline-form { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 16px; margin-bottom: 14px; }
        .inline-form .form-grid { margin-bottom: 12px; }
        .danger-zone { border: 1.5px dashed var(--red-500); border-radius: 14px; padding: 16px; margin-top: 20px; }
        .danger-zone h4 { color: var(--red-500); font-size: 14px; margin-bottom: 6px; }
        .danger-zone p { font-size: 12.5px; color: var(--muted); margin-bottom: 10px; line-height: 1.7; }
        .btn-danger { background: var(--red-500); color: #fff; }
        .assign-selects { display: flex; gap: 8px; flex-wrap: wrap; }
        .input-sm { width: auto; min-width: 150px; padding: 8px 10px; font-size: 12.5px; }
        .student-assign-row { align-items: center; }
        .footer { text-align: center; padding: 26px; color: var(--muted); font-size: 12.5px; background: var(--surface); border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }

        /* LOGIN */
        .login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; position: relative; background: radial-gradient(ellipse at 50% 0%, #E9F6EE 0%, var(--bg) 55%); padding: 24px; }
        .login-card { background: var(--surface); border-radius: 22px; padding: 34px 28px; max-width: 380px; width: 100%; text-align: center; box-shadow: 0 20px 50px rgba(14,68,48,0.14); border: 1px solid var(--border); }
        .login-title { color: var(--green-900); font-size: 22px; margin-bottom: 4px; }
        .login-sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
        .role-tabs { display: flex; gap: 8px; margin-bottom: 18px; }
        .role-tab { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 4px; border-radius: 12px; border: 1.5px solid var(--border); background: #fff; color: var(--muted); font-size: 12px; font-weight: 700; }
        .role-tab.active { border-color: var(--green-700); color: var(--green-900); background: #F3F8F5; }

        /* DASHBOARD SHELL */
        .dash { min-height: 100vh; background: var(--bg); }
        .dash-header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 22px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 10; }
        .dash-header-left { display: flex; align-items: center; gap: 12px; }
        .dash-title { font-weight: 800; color: var(--green-900); font-size: 15.5px; }
        .dash-sub { font-size: 12px; color: var(--muted); }
        .dash-user { font-size: 13px; font-weight: 700; color: var(--green-700); }
        .dash-body { max-width: 1080px; margin: 0 auto; padding: 24px 20px 60px; }

        /* STATS + TABS + LISTS */
        .stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 24px; }
        .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 16px; display: flex; align-items: center; gap: 12px; color: var(--green-700); }
        .stat-num { font-size: 20px; font-weight: 800; color: var(--green-900); }
        .stat-label { font-size: 12px; color: var(--muted); }
        .tabs { display: flex; gap: 8px; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
        .tab { padding: 10px 16px; background: none; border: none; font-size: 13.5px; font-weight: 700; color: var(--muted); border-bottom: 2px solid transparent; }
        .tab.active { color: var(--green-900); border-color: var(--gold-500); }
        .list { display: flex; flex-direction: column; gap: 10px; }
        .list-row { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
        .list-row-title { font-weight: 700; color: var(--ink); font-size: 14.5px; }
        .list-row-sub { font-size: 12.5px; color: var(--muted); margin-top: 2px; }
        .muted { color: var(--muted); font-weight: 400; }
        .status-badge { font-size: 12px; font-weight: 700; padding: 5px 12px; border-radius: 999px; }
        .status-badge.approved { background: #E6F4EC; color: var(--green-700); }
        .status-badge.rejected { background: #FBEAE7; color: var(--red-500); }
        .empty-note { color: var(--muted); font-size: 13.5px; padding: 20px; text-align: center; }

        /* TEACHER LAYOUT */
        .teacher-layout { display: grid; grid-template-columns: 240px 1fr; gap: 20px; align-items: start; }
        .col-heading { font-weight: 800; color: var(--green-900); font-size: 13.5px; margin-bottom: 10px; }
        .student-list-col { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 6px; }
        .student-pick { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-radius: 10px; border: none; background: transparent; font-size: 13.5px; font-weight: 600; color: var(--ink); text-align: right; }
        .student-pick.active { background: #F3F8F5; color: var(--green-900); }
        .mini-dot { width: 9px; height: 9px; border-radius: 50%; }

        /* STUDENT CARD */
        .card-header-panel { border-radius: 20px 20px 0 0; padding: 22px 24px; display: flex; align-items: center; gap: 14px; }
        .card-avatar { width: 46px; height: 46px; border-radius: 13px; background: #fff; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .card-body { padding: 20px; }
        .value-pill { background: #F6F3E9; border-radius: 10px; padding: 10px 14px; font-size: 14px; color: var(--ink); }
        .tomorrow-box { background: linear-gradient(180deg, #FCF8EC, #F8F1DC); border: 1px solid var(--gold-300); border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; }
        .parent-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; }

        @media (max-width: 760px) {
          .grid-3 { grid-template-columns: 1fr; }
          .form-grid { grid-template-columns: 1fr; }
          .stat-row { grid-template-columns: repeat(2, 1fr); }
          .teacher-layout { grid-template-columns: 1fr; }
          .hero-grid { grid-template-columns: 1fr; text-align: center; }
          .hero-desc { margin-left: auto; margin-right: auto; }
          .hero-actions { justify-content: center; }
          .hero-stats { justify-content: center; }
          .hero-visual { margin-top: 20px; }
          .preview-chip-1, .preview-chip-2 { display: none; }
          .steps { flex-direction: column; }
          .step-arrow { display: none; }
        }
      /* ============================= MODERN 2026 REDESIGN ============================= */
      :root {
        --ink: #163329;
        --bg: #F7F3E8;
        --surface: #FFFFFF;
        --green-900: #0B4A36;
        --green-700: #116B4D;
        --green-500: #18815D;
        --green-400: #2B9B73;
        --gold-500: #C7A23A;
        --gold-300: #E5D29A;
        --muted: #718078;
        --red-500: #C6534B;
        --yellow-500: #C89431;
        --border: #E7E0D0;
        --shadow-soft: 0 10px 35px rgba(11,74,54,.08);
        --shadow-deep: 0 22px 60px rgba(11,74,54,.14);
      }
      body { margin: 0; background: var(--bg); }
      .app-root { background: var(--bg); color: var(--ink); }
      .brand-mark { width: 46px; height: 46px; border-radius: 15px; overflow: hidden; background: var(--green-900); box-shadow: 0 7px 18px rgba(11,74,54,.16); }
      .brand-mark.small { width: 40px; height: 40px; border-radius: 13px; }
      .brand-mark img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .nav { background: rgba(247,243,232,.9); border-bottom: 1px solid rgba(199,162,58,.18); }
      .nav-inner { max-width: 1160px; padding: 14px 24px; }
      .brand-title { font-size: 20px; }
      .brand-sub { font-size: 11px; }
      .btn { min-height: 44px; border-radius: 14px; padding: 11px 19px; transition: transform .18s ease, box-shadow .18s ease, background .18s ease; }
      .btn-primary { background: var(--green-900); box-shadow: 0 8px 20px rgba(11,74,54,.18); }
      .btn-primary:hover { background: var(--green-700); box-shadow: 0 12px 28px rgba(11,74,54,.22); }
      .btn-gold { background: var(--gold-500); box-shadow: none; }
      .btn-outline { border-color: var(--green-700); color: var(--green-900); }
      .btn-ghost { background: rgba(255,255,255,.55); border-color: var(--border); }
      .hero { padding: 74px 24px 88px; }
      .hero-grid { max-width: 1160px; gap: 64px; }
      .hero-title { color: var(--green-900); font-size: clamp(34px, 5vw, 54px); letter-spacing: -.8px; }
      .badge { background: rgba(17,107,77,.08); color: var(--green-700); border: 1px solid rgba(199,162,58,.25); }
      .hero-visual::before { background: radial-gradient(circle, rgba(199,162,58,.15), transparent 68%); }
      .preview-card { border: 1px solid rgba(199,162,58,.22); border-radius: 24px; box-shadow: var(--shadow-deep); }
      .preview-avatar { background: var(--green-900); }
      .section { max-width: 1160px; }
      .feature-card, .step-card, .card, .stat-card, .list-row, .student-list-col { border-color: var(--border); box-shadow: var(--shadow-soft); }
      .feature-card, .step-card, .card { border-radius: 22px; }
      .section-alt { background: #F1EBDD; }
      .form-card { max-width: 700px; }
      .input { min-height: 46px; border-radius: 13px; border-color: #DED7C8; background: #FFFDF9; }
      .input:focus { border-color: var(--green-500); box-shadow: 0 0 0 4px rgba(24,129,93,.10); }
      .login-wrap { background: var(--green-900); padding: 24px; overflow: hidden; }
      .login-wrap::before { content: ''; position: absolute; inset: 0; background: radial-gradient(circle at 15% 15%, rgba(199,162,58,.18), transparent 30%), radial-gradient(circle at 85% 85%, rgba(255,255,255,.05), transparent 35%); pointer-events: none; }
      .login-card { position: relative; z-index: 1; max-width: 430px; border-radius: 28px; padding: 38px 30px 32px; background: #FFFDF8; border: 1px solid rgba(229,210,154,.55); box-shadow: 0 28px 80px rgba(0,0,0,.22); }
      .login-logo { width: 88px; height: 88px; border-radius: 26px; overflow: hidden; margin: 0 auto 18px; box-shadow: 0 14px 30px rgba(11,74,54,.18); }
      .login-logo img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .login-kicker { color: var(--gold-500); font-size: 12px; font-weight: 800; margin-bottom: 5px; }
      .login-title { font-size: 29px; color: var(--green-900); margin-bottom: 5px; }
      .login-sub { margin-bottom: 24px; }
      .role-tabs { gap: 9px; }
      .role-tab { min-height: 78px; border-radius: 16px; background: #fff; border-color: var(--border); }
      .role-tab.active { background: #EEF5F0; border-color: var(--green-500); box-shadow: inset 0 0 0 1px rgba(24,129,93,.1); }
      .dash { background: var(--bg); }
      .dash-header { background: rgba(255,253,248,.92); backdrop-filter: blur(16px); border-bottom-color: var(--border); padding: 12px 24px; }
      .dash-body { max-width: 1160px; padding: 28px 22px 72px; }
      .dash-title { font-size: 16px; }
      .dash-user { background: #EEF5F0; padding: 8px 12px; border-radius: 999px; }
      .dash-welcome { display: flex; align-items: center; justify-content: space-between; gap: 20px; background: var(--green-900); color: #fff; border-radius: 26px; padding: 26px 28px; margin-bottom: 22px; box-shadow: var(--shadow-deep); position: relative; overflow: hidden; }
      .dash-welcome::after { content: ''; position: absolute; width: 190px; height: 190px; border-radius: 50%; background: rgba(199,162,58,.12); left: -60px; bottom: -100px; }
      .dash-welcome h1 { font-size: 27px; margin: 5px 0 5px; color: #fff; position: relative; z-index: 1; }
      .dash-welcome p { color: rgba(255,255,255,.75); font-size: 13px; position: relative; z-index: 1; }
      .eyebrow { color: var(--gold-300); font-size: 11px; font-weight: 800; position: relative; z-index: 1; }
      .welcome-mark { width: 58px; height: 58px; border: 1px solid rgba(229,210,154,.35); border-radius: 18px; display: grid; place-items: center; color: var(--gold-300); flex-shrink: 0; position: relative; z-index: 1; }
      .stat-row { gap: 16px; margin-bottom: 28px; }
      .stat-card { min-height: 92px; border-radius: 18px; background: #FFFDF9; }
      .stat-card svg { color: var(--gold-500); }
      .stat-num { font-size: 25px; }
      .tabs { gap: 5px; border-bottom: 1px solid var(--border); margin-bottom: 18px; overflow-x: auto; }
      .tab { border-radius: 12px 12px 0 0; padding: 12px 17px; white-space: nowrap; }
      .tab.active { color: var(--green-900); background: #EEE8DA; border-color: var(--gold-500); }
      .list { gap: 12px; }
      .list-row { border-radius: 17px; padding: 16px 18px; background: #FFFDF9; }
      .status-badge { padding: 6px 12px; }
      .teacher-summary { display: grid; grid-template-columns: repeat(3,1fr); gap: 12px; margin-bottom: 22px; }
      .teacher-summary > div { background: #FFFDF9; border: 1px solid var(--border); border-radius: 18px; padding: 16px 18px; box-shadow: var(--shadow-soft); }
      .teacher-summary span { display: block; color: var(--green-900); font: 800 25px 'Tajawal',sans-serif; }
      .teacher-summary small { color: var(--muted); font-size: 11.5px; }
      .teacher-layout { grid-template-columns: 285px 1fr; gap: 22px; }
      .student-list-col { border-radius: 20px; padding: 16px; background: #FFFDF9; }
      .student-list-head { display: flex; justify-content: space-between; margin-bottom: 12px; }
      .student-list-head .col-heading { margin-bottom: 0; }
      .search-wrap { margin-bottom: 8px; }
      .student-search { min-height: 42px; font-size: 12.5px; }
      .student-pick { position: relative; display: grid; grid-template-columns: 1fr auto; grid-template-areas: 'name dot' 'meta dot'; gap: 1px 8px; text-align: right; padding: 12px 12px; border-radius: 14px; border: 1px solid transparent; }
      .student-pick.active { background: #EAF3ED; border-color: rgba(24,129,93,.14); }
      .student-pick-name { grid-area: name; font-weight: 800; }
      .student-pick-meta { grid-area: meta; font-size: 10.5px; color: var(--muted); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .mini-dot { grid-area: dot; align-self: center; width: 9px; height: 9px; }
      .mini-dot.good { background: var(--green-500); }
      .mini-dot.mid { background: var(--yellow-500); }
      .mini-dot.low { background: var(--red-500); }
      .student-detail-col .card { box-shadow: var(--shadow-deep); }
      .card-header-panel { background: var(--green-900) !important; padding: 24px; }
      .card-avatar { border-radius: 15px; }
      .card-body { padding: 24px; }
      .value-pill { background: #F2EEE3; border-radius: 13px; }
      .tomorrow-box { background: #FBF6E7; border-color: var(--gold-300); border-radius: 16px; }
      .parent-grid { grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 22px; }
      .parent-grid .student-card { box-shadow: var(--shadow-soft); }
      .empty-state { min-height: 220px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; background: #FFFDF9; border: 1px dashed var(--border); border-radius: 22px; color: var(--muted); }
      .empty-state svg { color: var(--gold-500); }
      .empty-state strong { color: var(--green-900); font-family: 'Tajawal',sans-serif; font-size: 17px; }
      .whatsapp-fab { width: 54px; height: 54px; bottom: 18px; left: 18px; }
      .footer { background: #0B4A36; color: rgba(255,255,255,.72); border-top: none; }
      .footer .signature b { color: var(--gold-300); }
      @media (max-width: 760px) {
        .nav-inner { padding: 12px 16px; }
        .brand-sub { display: none; }
        .brand-title { font-size: 18px; }
        .hero { padding: 46px 18px 62px; }
        .hero-title { font-size: 34px; }
        .hero-actions .btn { flex: 1; }
        .dash-header { padding: 10px 14px; }
        .dash-header-left { gap: 9px; }
        .dash-user { display: none; }
        .dash-header .btn { padding: 9px 11px; min-height: 40px; }
        .dash-body { padding: 18px 14px 88px; }
        .dash-welcome { border-radius: 21px; padding: 22px 20px; }
        .dash-welcome h1 { font-size: 23px; }
        .teacher-summary { gap: 8px; }
        .teacher-summary > div { padding: 13px; }
        .teacher-summary span { font-size: 22px; }
        .teacher-layout { grid-template-columns: 1fr; }
        .student-list-col { order: 1; }
        .student-detail-col { order: 2; }
        .stat-row { gap: 9px; }
        .stat-card { padding: 13px; min-height: 82px; }
        .tabs { margin-inline: -4px; }
        .tab { padding: 10px 13px; font-size: 12.5px; }
        .parent-grid { grid-template-columns: 1fr; }
        .login-card { padding: 32px 20px 26px; }
        .role-tab { min-height: 72px; font-size: 11.5px; }
      }
      @media (prefers-reduced-motion: reduce) { * { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; } }

      /* FINAL POLISH */
      .password-wrap { position: relative; }
      .password-wrap .input { padding-left: 48px; }
      .password-toggle { position: absolute; left: 7px; top: 50%; transform: translateY(-50%); width: 36px; height: 36px; border: 0; background: transparent; color: var(--muted); border-radius: 10px; display: grid; place-items: center; }
      .password-toggle:hover { background: #F1EBDD; color: var(--green-900); }
      .header-bell { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 12px; background: #FFFDF9; }
      .behavior-meter { margin-top: 2px; }
      .behavior-head { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:7px; }
      .behavior-title { font-size: 12px; color: var(--muted); font-weight: 700; }
      .behavior-status { font-size: 12px; font-weight: 800; }
      .behavior-track { height: 8px; background:#ECE8DD; border-radius:999px; overflow:hidden; }
      .behavior-fill { height:100%; border-radius:999px; transition:width .45s ease; }
      .mobile-bottom-nav { display:none; }
      .card-header-panel { background: var(--green-900) !important; }
      .btn-primary { background: var(--green-900); }
      .btn-primary:hover { background: var(--green-700); }
      .btn-gold { color: var(--green-900); }
      .role-tab { transition: transform .18s ease, border-color .18s ease, background .18s ease; }
      .role-tab:hover { transform: translateY(-1px); }
      .login-card { box-shadow: 0 30px 90px rgba(4,40,28,.30); }
      .dash-welcome { border: 1px solid rgba(229,210,154,.12); }
      .list-row:hover, .stat-card:hover, .student-pick:hover { transform: translateY(-1px); }
      .list-row, .stat-card, .student-pick { transition: transform .18s ease, box-shadow .18s ease, background .18s ease; }
      .empty-state { background: rgba(255,253,249,.7); }
      @media (max-width:760px) {
        .dash-body { padding-bottom: 105px; }
        .dash-header { position: sticky; top:0; z-index:50; }
        .header-bell { width:38px; height:38px; }
        .mobile-bottom-nav { position:fixed; display:grid; grid-template-columns:repeat(4,1fr); bottom:12px; left:12px; right:12px; z-index:100; background:rgba(255,253,248,.94); backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px); border:1px solid rgba(199,162,58,.20); border-radius:20px; padding:7px; box-shadow:0 16px 45px rgba(11,74,54,.16); }
        .mobile-nav-item { border:0; background:transparent; color:var(--muted); border-radius:15px; min-height:56px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; font-size:10px; font-weight:700; }
        .mobile-nav-item.active { color:var(--green-900); background:#EEF5F0; }
        .mobile-nav-icon { width:30px; height:26px; display:grid; place-items:center; }
        .dash-title { font-size:14px; }
        .dash-sub { font-size:10px; }
        .dash-header .btn-ghost { font-size:10.5px; padding:8px 9px; }
        .dash-welcome { min-height:150px; }
        .teacher-summary { grid-template-columns:repeat(3,1fr); }
        .teacher-summary > div { min-width:0; }
        .teacher-summary small { font-size:10px; }
        .parent-grid { gap:14px; }
        .card-header-panel { padding:20px; }
        .card-body { padding:18px; }
      }
      `}</style>

      {status === "loading" && (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Loader2 size={30} className="spin" color="var(--green-700)" />
        </div>
      )}

      {status === "error" && (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
          تعذّر تحميل البيانات. حاول تحديث الصفحة.
        </div>
      )}

      {status === "ready" && data && (
        <>
          <WhatsAppButton />
          {!persistent && (
            <div className="persist-warning">
              تنبيه: تعذّر الاتصال بقاعدة البيانات، قد لا تُحفظ آخر التحديثات.
            </div>
          )}
          {view === "home" && (
            <HomePage
              onGoLogin={() => setView("login")}
              onRegister={handleRegister}
              registering={registering}
              pendingCount={data.registrations.filter((r) => r.status === "pending").length}
            />
          )}
          {view === "login" && (
            <LoginPage
              users={data.users}
              onLogin={handleLogin}
              onBack={() => setView("home")}
              pendingCount={data.registrations.filter((r) => r.status === "pending").length}
            />
          )}

          {view === "dashboard" && currentUser && (
            <>
              {currentUser.role === "admin" && (
                <AdminDashboard data={data} api={api} user={currentUser} onLogout={handleLogout} />
              )}
              {currentUser.role === "teacher" && (
                <TeacherDashboard data={data} api={api} user={currentUser} onLogout={handleLogout} />
              )}
              {currentUser.role === "parent" && (
                <ParentDashboard data={data} api={api} user={currentUser} onLogout={handleLogout} />
              )}
              {!["admin", "teacher", "parent"].includes(currentUser.role) && (
                <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  غير مصرح لك بالدخول.
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
