import { supabase } from "./supabaseClient";

const SESSION_KEY = "mahad-albirr:session";
const VAPID_PUBLIC_KEY = "BEru2qidulN7jy7Bg_eAVD6v1R__kAnOuZV69RoSV_7kzWF2-6S88sKB2JLC-dBLWvcdlOhA6dPKtZnFVYIxNj4";

const session = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; } };
const today = () => new Date().toISOString().slice(0, 10);
const esc = (v) => String(v ?? "").replace(/[&<>\"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[c]));
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));

async function enablePush(user, button) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return alert("الإشعارات غير مدعومة على هذا الجهاز أو المتصفح.");
  button.disabled = true; button.textContent = "جارٍ التفعيل...";
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("permission denied");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(VAPID_PUBLIC_KEY) });
    const data = sub.toJSON();
    const { error } = await supabase.from("push_subscriptions").upsert({ user_id: user.id, endpoint: data.endpoint, p256dh: data.keys?.p256dh || "", auth: data.keys?.auth || "", user_agent: navigator.userAgent, updated_at: new Date().toISOString() }, { onConflict: "user_id,endpoint" });
    if (error) throw error;
    button.textContent = "✓ الإشعارات مفعّلة";
  } catch (e) { console.error(e); button.disabled = false; button.textContent = "تفعيل الإشعارات"; alert("تعذر تفعيل الإشعارات. تأكد من السماح بالإشعارات."); }
}

function addPushButton(user) {
  if (document.querySelector("[data-push-feature]")) return;
  const header = document.querySelector(".dash-header > div:last-child");
  if (!header) return;
  const b = document.createElement("button"); b.className = "btn btn-ghost"; b.dataset.pushFeature = "1"; b.textContent = "تفعيل الإشعارات"; b.onclick = () => enablePush(user, b); header.prepend(b);
}

async function loadAnnouncements(role) {
  const { data } = await supabase.from("announcements").select("*").order("created_at", { ascending: false }).limit(20);
  return (data || []).filter(a => a.target_role === "all" || a.target_role === role);
}

function renderFeed(list) {
  if (!list.length || document.querySelector("[data-announcement-feed]")) return;
  const main = document.querySelector(".dash-body"); if (!main) return;
  const box = document.createElement("section"); box.dataset.announcementFeed = "1"; box.className = "announcement-feed";
  box.innerHTML = `<div class="section-kicker">📢 إعلانات المعهد</div><h3 style="margin:0 0 10px;color:var(--green-900);font-size:18px">آخر الإعلانات</h3><div class="announcement-list">${list.map(a => `<article class="announcement-card"><div class="announcement-icon">📢</div><div><h4>${esc(a.title)}</h4><p>${esc(a.body)}</p><small>${new Date(a.created_at).toLocaleDateString("ar-EG")}</small></div></article>`).join("")}</div>`;
  main.prepend(box);
}

function announcementModal(user) {
  if (document.querySelector("[data-announcement-modal]")) return;
  const wrap = document.createElement("div"); wrap.dataset.announcementModal = "1"; wrap.className = "modal-overlay";
  wrap.innerHTML = `<div class="modal-card"><div class="modal-head"><h3 style="color:var(--green-900)">نشر إعلان للمعهد</h3><button class="icon-btn" data-close>×</button></div><form><div class="field-row"><label class="field-label">العنوان</label><input class="input" name="title" required placeholder="مثال: دوام المعهد غدًا" /></div><div class="field-row"><label class="field-label">المستهدفون</label><select class="input" name="target_role"><option value="all">الجميع</option><option value="parent">أولياء الأمور</option><option value="teacher">المعلمون</option></select></div><div class="field-row"><label class="field-label">نص الإعلان</label><textarea class="input" name="body" rows="5" required placeholder="اكتب الإعلان هنا..."></textarea></div><button class="btn btn-primary" type="submit">نشر الإعلان وإرسال الإشعار</button></form></div>`;
  document.body.appendChild(wrap);
  wrap.querySelector("[data-close]").onclick = () => wrap.remove();
  wrap.querySelector("form").onsubmit = async (e) => {
    e.preventDefault(); const fd = new FormData(e.currentTarget); const btn = e.currentTarget.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = "جارٍ النشر...";
    const { data: a, error } = await supabase.from("announcements").insert({ title: fd.get("title"), body: fd.get("body"), target_role: fd.get("target_role"), created_by: user.id }).select().single();
    if (error) { alert("تعذر نشر الإعلان: " + error.message); btn.disabled = false; btn.textContent = "نشر الإعلان وإرسال الإشعار"; return; }
    await supabase.functions.invoke("send-push", { body: { type: "announcement", sender_user_id: user.id, announcement_id: a.id } });
    wrap.remove(); location.reload();
  };
}

function addAnnouncementButton(user) {
  if (document.querySelector("[data-announcement-admin]")) return;
  const body = document.querySelector(".dash-body"); if (!body) return;
  const b = document.createElement("button"); b.dataset.announcementAdmin = "1"; b.className = "btn btn-gold"; b.textContent = "📢 نشر إعلان جديد"; b.style.marginBottom = "14px"; b.onclick = () => announcementModal(user); body.prepend(b);
}

async function addAttendancePanel(user) {
  if (user.role !== "teacher" || document.querySelector("[data-attendance-feature]")) return;
  const active = document.querySelector(".student-pick.active"); const detail = document.querySelector(".student-detail-col"); if (!active || !detail) return;
  const name = active.querySelector("span")?.textContent?.trim(); if (!name) return;
  const { data: student } = await supabase.from("students").select("id,name").eq("teacher_id", user.id).eq("name", name).maybeSingle(); if (!student) return;
  const { data: rec } = await supabase.from("attendance").select("status").eq("student_id", student.id).eq("date", today()).maybeSingle();
  const box = document.createElement("div"); box.dataset.attendanceFeature = "1"; box.className = "attendance-panel";
  box.innerHTML = `<div><div class="section-kicker">✓ حضور اليوم</div><strong data-att-status>${rec?.status === "present" ? "حاضر اليوم" : rec?.status === "absent" ? "غائب اليوم" : "لم يُسجل الحضور بعد"}</strong></div><div class="attendance-actions"><button class="btn btn-primary" data-status="present">✓ حاضر</button><button class="btn btn-outline" data-status="absent">✕ غائب</button></div>`;
  detail.prepend(box);
  box.querySelectorAll("[data-status]").forEach(btn => btn.onclick = async () => {
    box.querySelectorAll("button").forEach(x => x.disabled = true);
    const status = btn.dataset.status;
    const { error } = await supabase.from("attendance").upsert({ student_id: student.id, teacher_id: user.id, date: today(), status, updated_at: new Date().toISOString() }, { onConflict: "student_id,date" });
    if (error) alert("تعذر تسجيل الحضور: " + error.message);
    else { box.querySelector("[data-att-status]").textContent = status === "present" ? "حاضر اليوم" : "غائب اليوم"; if (status === "absent") await supabase.functions.invoke("send-push", { body: { type: "attendance", sender_user_id: user.id, student_id: student.id, status, date: today() } }); }
    box.querySelectorAll("button").forEach(x => x.disabled = false);
  });
}

async function addDeleteStudentButtons(user) {
  if (user.role !== "admin") return;
  const rows = [...document.querySelectorAll(".list-row")];
  for (const row of rows) {
    if (row.querySelector("[data-delete-student]") || !row.querySelector(".list-row-title")) continue;
    const title = row.querySelector(".list-row-title"); const text = title.textContent.trim(); const name = text.split("·")[0].trim();
    if (!name) continue;
    const { data: student } = await supabase.from("students").select("id").eq("name", name).maybeSingle(); if (!student) continue;
    const b = document.createElement("button"); b.dataset.deleteStudent = "1"; b.className = "btn btn-outline btn-sm"; b.textContent = "حذف الطالب";
    b.onclick = async () => { if (!confirm(`سيتم حذف الطالب ${name} نهائيًا. هل أنت متأكد؟`)) return; b.disabled = true; const { error } = await supabase.from("students").delete().eq("id", student.id); if (error) { alert("تعذر حذف الطالب: " + error.message); b.disabled = false; } else row.remove(); };
    row.lastElementChild?.appendChild(b);
  }
}

async function enhance() {
  const user = session(); if (!user || !document.querySelector(".dash")) return;
  addPushButton(user);
  const announcements = await loadAnnouncements(user.role); renderFeed(announcements);
  if (user.role === "admin") addAnnouncementButton(user);
  await addAttendancePanel(user);
  await addDeleteStudentButtons(user);
}

let timer;
const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(enhance, 350); });
observer.observe(document.documentElement, { childList: true, subtree: true });
setTimeout(enhance, 500);
