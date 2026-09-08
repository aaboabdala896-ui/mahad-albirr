import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY")!;
const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY")!;
const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const payload = await req.json();
    const senderId = payload.sender_user_id;
    if (!senderId) return json({ error: "sender_user_id is required" }, 400);
    const { data: sender } = await supabase.from("users").select("id,role").eq("id", senderId).maybeSingle();
    if (!sender || !["admin", "teacher"].includes(sender.role)) return json({ error: "not authorized" }, 403);

    let userIds: string[] = [];
    let title = "معهد البر";
    let body = "لديك إشعار جديد.";
    if (payload.type === "announcement") {
      if (sender.role !== "admin") return json({ error: "only admin can publish announcements" }, 403);
      const { data: a } = await supabase.from("announcements").select("title,body,target_role").eq("id", payload.announcement_id).maybeSingle();
      if (!a) return json({ error: "announcement not found" }, 404);
      title = a.title; body = a.body;
      const { data: users } = a.target_role === "all" ? await supabase.from("users").select("id").in("role", ["admin", "teacher", "parent"]) : await supabase.from("users").select("id").eq("role", a.target_role);
      userIds = (users || []).map((u) => u.id);
    } else if (payload.type === "attendance") {
      if (sender.role !== "teacher") return json({ error: "only teacher can send attendance notifications" }, 403);
      const { data: student } = await supabase.from("students").select("name,parent_id").eq("id", payload.student_id).maybeSingle();
      if (!student?.parent_id) return json({ sent: 0, reason: "student has no parent" });
      title = payload.status === "present" ? "تسجيل حضور" : "تسجيل غياب";
      body = payload.status === "present" ? `تم تسجيل حضور ${student.name} اليوم.` : `تم تسجيل غياب ${student.name} اليوم.`;
      userIds = [student.parent_id];
    } else return json({ error: "unknown notification type" }, 400);

    const { data: subscriptions } = await supabase.from("push_subscriptions").select("id,user_id,endpoint,p256dh,auth").in("user_id", userIds);
    let sent = 0;
    for (const sub of subscriptions || []) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({ title, body, url: "/" }));
        sent++;
      } catch (e) {
        if (e?.statusCode === 404 || e?.statusCode === 410) await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        console.warn("push failed", e?.statusCode, e?.message);
      }
    }
    return json({ sent });
  } catch (e) { console.error(e); return json({ error: e?.message || "internal error" }, 500); }
});
