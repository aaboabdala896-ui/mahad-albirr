import React, { useState, useEffect, useCallback } from "react";
import {
  BookOpen, Shield, GraduationCap, Heart, LogIn, LogOut, Users, UserPlus,
  ClipboardCheck, Star, MessageSquare, Calendar, ChevronLeft, Check, X,
  Loader2, Plus, Trash2, Save, Sparkles, Phone, ArrowLeft
} from "lucide-react";
import { supabase } from "./supabaseClient";

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
  level: r.level || "", nextLesson: r.next_lesson || "", behavior: r.behavior ?? 70,
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

  const fetchAll = useCallback(async () => {
    const [usersR, teachersR, parentsR, studentsR, regsR] = await Promise.all([
      supabase.from("users").select("*"),
      supabase.from("teachers").select("*"),
      supabase.from("parents").select("*"),
      supabase.from("students").select("*"),
      supabase.from("registrations").select("*").order("created_at", { ascending: false }),
    ]);
    return {
      users: usersR.data || [],
      teachers: teachersR.data || [],
      parents: parentsR.data || [],
      students: (studentsR.data || []).map(studentFromRow),
      registrations: (regsR.data || []).map(regFromRow),
    };
  }, []);

  useEffect(() => {
    let channels = [];
    let cancelled = false;

    (async () => {
      try {
        const fresh = await fetchAll();
        if (!cancelled) setData(fresh);
      } catch (e) {
        console.error("Supabase load failed", e);
        if (!cancelled) {
          setData({ users: [], teachers: [], parents: [], students: [], registrations: [] });
          setPersistent(false);
        }
      }
      if (!cancelled) setStatus("ready");

      const refresh = async () => {
        try {
          setData(await fetchAll());
        } catch (e) {
          console.error("Supabase refresh failed", e);
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
        .insert({ username: form.username, password: form.password, role: "teacher", name: form.name })
        .select().single();
      if (e1) throw e1;
      const { error: e2 } = await supabase.from("teachers")
        .insert({ id: row.id, name: form.name, subject: form.subject || "تحفيظ القرآن الكريم" });
      if (e2) throw e2;
    }),
    addParent: (form) => mutate(async () => {
      const { data: row, error: e1 } = await supabase.from("users")
        .insert({ username: form.username, password: form.password, role: "parent", name: form.name })
        .select().single();
      if (e1) throw e1;
      const { error: e2 } = await supabase.from("parents")
        .insert({ id: row.id, name: form.name, phone: form.phone || "" });
      if (e2) throw e2;
    }),
    deleteTeacher: (id) => mutate(async () => {
      const { error } = await supabase.from("users").delete().eq("id", id);
      if (error) throw error;
    }),
    deleteParent: (id) => mutate(async () => {
      const { error } = await supabase.from("users").delete().eq("id", id);
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

function BehaviorBar({ value }) {
  const color = value >= 75 ? "var(--green-500)" : value >= 40 ? "var(--yellow-500)" : "var(--red-500)";
  const label = value >= 75 ? "ممتاز" : value >= 40 ? "متوسط" : "بحاجة متابعة";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>سلوك الطالب</span>
        <span style={{ fontSize: 13, fontWeight: 700, color }}>{value}% · {label}</span>
      </div>
      <div style={{ height: 12, borderRadius: 999, background: "#EDE8DA", overflow: "hidden", boxShadow: "inset 0 1px 3px rgba(0,0,0,0.08)" }}>
        <div style={{
          width: `${value}%`, height: "100%", borderRadius: 999, background: color,
          transition: "width 0.6s cubic-bezier(.4,0,.2,1), background 0.4s",
        }} />
      </div>
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
            <div className="brand-mark"><BookOpen size={22} color="#fff" /></div>
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
              <input className="input" required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="05xxxxxxxx" />
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
  const [error, setError] = useState("");

  const roles = [
    { id: "admin", label: "المدير", icon: Shield },
    { id: "teacher", label: "المعلم", icon: GraduationCap },
    { id: "parent", label: "ولي الأمر", icon: Heart },
  ];

  const submit = (e) => {
    e.preventDefault();
    const user = users.find((u) => u.username === username && u.password === password && u.role === role);
    if (!user) { setError("بيانات الدخول غير صحيحة، يرجى المحاولة مرة أخرى."); return; }
    setError("");
    onLogin(user);
  };

  return (
    <div className="login-wrap">
      <button className="btn btn-ghost" onClick={onBack} style={{ position: "absolute", top: 18, right: 18 }}>
        <ArrowLeft size={16} style={{ transform: "scaleX(-1)" }} /> الرئيسية
      </button>
      <div className="login-card">
        <div className="brand-mark" style={{ margin: "0 auto 14px" }}><BookOpen size={24} color="#fff" /></div>
        <h2 className="login-title">تسجيل الدخول</h2>
        <p className="login-sub">اختر بوابتك ثم أدخل بيانات الدخول</p>

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
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
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

function DashboardShell({ title, subtitle, icon: Icon, user, onLogout, children, data, api }) {
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  return (
    <div className="dash">
      <header className="dash-header">
        <div className="dash-header-left">
          <div className="brand-mark small"><Icon size={18} color="#fff" /></div>
          <div>
            <div className="dash-title">{title}</div>
            <div className="dash-sub">{subtitle}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
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
  const [teacherForm, setTeacherForm] = useState({ name: "", username: "", password: "", subject: "" });
  const [parentForm, setParentForm] = useState({ name: "", username: "", password: "", phone: "" });
  const [accountError, setAccountError] = useState("");
  const [busyId, setBusyId] = useState(null);

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
    setTeacherForm({ name: "", username: "", password: "", subject: "" });
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

  const clearDemoData = async () => {
    if (!window.confirm("سيتم حذف الحسابات والطلاب التجريبيين نهائيًا (لن يبقى إلا حساب المدير). هل أنت متأكد؟")) return;
    await api.clearDemoData();
  };

  const pending = data.registrations.filter((r) => r.status === "pending");
  const hasDemoData = data.users.some((u) => u.username === "teacher1" || u.username === "parent1");

  return (
    <DashboardShell title="لوحة المدير" subtitle="إدارة عامة للمعهد" icon={Shield} user={user} onLogout={onLogout} data={data} api={api}>
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
          {data.students.map((s) => (
            <div className="list-row" key={s.id}>
              <div>
                <div className="list-row-title">{s.name} <span className="muted">· {s.age} سنة</span></div>
                <div className="list-row-sub">{s.level}</div>
              </div>
              <div style={{ width: 140 }}><BehaviorBar value={s.behavior} /></div>
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
    </DashboardShell>
  );
}

/* ============================= TEACHER DASHBOARD ============================= */

function TeacherDashboard({ data, api, user, onLogout }) {
  const myStudents = data.students.filter((s) => s.teacherId === user.id);
  const [selectedId, setSelectedId] = useState(myStudents[0]?.id || null);
  const [saving, setSaving] = useState(false);
  const selected = data.students.find((s) => s.id === selectedId);

  const save = async (updated) => {
    setSaving(true);
    await api.updateStudent(updated.id, updated);
    setSaving(false);
  };

  return (
    <DashboardShell title="لوحة المعلم" subtitle={user.name} icon={GraduationCap} user={user} onLogout={onLogout} data={data} api={api}>
      <div className="teacher-layout">
        <div className="student-list-col">
          <div className="col-heading">طلابي ({myStudents.length})</div>
          {myStudents.map((s) => (
            <button key={s.id} className={`student-pick ${selectedId === s.id ? "active" : ""}`} onClick={() => setSelectedId(s.id)}>
              <span>{s.name}</span>
              <span className="mini-dot" style={{ background: s.behavior >= 75 ? "var(--green-500)" : s.behavior >= 40 ? "var(--yellow-500)" : "var(--red-500)" }} />
            </button>
          ))}
          {myStudents.length === 0 && <div className="empty-note">لا يوجد طلاب مرتبطون بحسابك بعد.</div>}
        </div>
        <div className="student-detail-col">
          {selected ? (
            <StudentCard key={selected.id} student={selected} teacherName={user.name} editable onSave={save} saving={saving} />
          ) : <div className="empty-note">اختر طالبًا من القائمة لعرض بياناته وتحديثها.</div>}
        </div>
      </div>
    </DashboardShell>
  );
}

/* ============================= PARENT DASHBOARD ============================= */

function ParentDashboard({ data, api, user, onLogout }) {
  const myChildren = data.students.filter((s) => s.parentId === user.id);
  return (
    <DashboardShell title="بوابة ولي الأمر" subtitle={user.name} icon={Heart} user={user} onLogout={onLogout} data={data} api={api}>
      {myChildren.length === 0 ? (
        <div className="empty-note">لا يوجد أبناء مرتبطون بحسابك حاليًا.</div>
      ) : (
        <div className="parent-grid">
          {myChildren.map((s) => {
            const teacher = data.teachers.find((t) => t.id === s.teacherId);
            return <StudentCard key={s.id} student={s} teacherName={teacher?.name} editable={false} />;
          })}
        </div>
      )}
    </DashboardShell>
  );
}

/* ============================= APP ROOT ============================= */

export default function App() {
  const { data, status, api, persistent } = useAppData();
  const [view, setView] = useState("home"); // home | login | dashboard
  const [currentUser, setCurrentUser] = useState(null);
  const [registering, setRegistering] = useState(false);

  const handleRegister = async (form) => {
    setRegistering(true);
    await api.submitRegistration(form);
    setRegistering(false);
  };

  const handleLogin = (user) => { setCurrentUser(user); setView("dashboard"); };
  const handleLogout = () => { setCurrentUser(null); setView("home"); };

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
          {view === "dashboard" && currentUser?.role === "admin" && (
            <AdminDashboard data={data} api={api} user={currentUser} onLogout={handleLogout} />
          )}
          {view === "dashboard" && currentUser?.role === "teacher" && (
            <TeacherDashboard data={data} api={api} user={currentUser} onLogout={handleLogout} />
          )}
          {view === "dashboard" && currentUser?.role === "parent" && (
            <ParentDashboard data={data} api={api} user={currentUser} onLogout={handleLogout} />
          )}
        </>
      )}
    </div>
  );
}
