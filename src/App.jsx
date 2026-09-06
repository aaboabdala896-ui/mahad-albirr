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
                <opti
