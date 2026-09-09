import { supabase } from "./supabaseClient";

// VAPID public key only. The matching private key stays in Supabase Edge Function secrets.
const VAPID_PUBLIC_KEY =
  "BMqHNM8AY7rMj5PSqwfvqA6LwpS_TSIKKMQmhFqz24ewgCKS-P9rpfT9qBzFuAIJki2skcOxSn8p6EcVaFhhwod8";

const SESSION_STORAGE_KEY = "mahad-albirr:session";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function getCurrentUser() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    const user = raw ? JSON.parse(raw) : null;
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) throw new Error("هذا المتصفح لا يدعم Service Worker.");
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

async function saveSubscription(userId, subscription) {
  const json = subscription.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) throw new Error("بيانات اشتراك الإشعارات غير مكتملة.");

  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: userId,
      endpoint,
      p256dh,
      auth,
      user_agent: navigator.userAgent,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,endpoint" }
  );
  if (error) throw error;
}

export async function enablePushNotifications() {
  const user = getCurrentUser();
  if (!user) throw new Error("سجّل الدخول أولًا ثم فعّل الإشعارات.");
  if (!("Notification" in window)) throw new Error("هذا المتصفح لا يدعم الإشعارات.");
  if (!("PushManager" in window)) throw new Error("هذا المتصفح لا يدعم Web Push.");
  if (!window.isSecureContext) throw new Error("الإشعارات تحتاج إلى اتصال HTTPS.");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("لم يتم السماح بالإشعارات.");

  const registration = await registerServiceWorker();
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    }));

  await saveSubscription(user.id, subscription);
  return { ok: true, subscription };
}

function createNotificationButton() {
  if (document.getElementById("mahad-push-enable")) return;
  const button = document.createElement("button");
  button.id = "mahad-push-enable";
  button.type = "button";
  button.textContent = "🔔 تفعيل الإشعارات";
  Object.assign(button.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: "9999",
    border: "0",
    borderRadius: "999px",
    padding: "12px 18px",
    background: "#0B3D2E",
    color: "#fff",
    fontFamily: "Cairo, sans-serif",
    fontSize: "14px",
    fontWeight: "700",
    boxShadow: "0 8px 24px rgba(0,0,0,.18)",
    cursor: "pointer",
  });
  button.addEventListener("click", async () => {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "جارٍ التفعيل…";
    try {
      await enablePushNotifications();
      button.textContent = "✓ الإشعارات مفعّلة";
      button.style.background = "#145C43";
      setTimeout(() => button.remove(), 1800);
    } catch (error) {
      console.error("Push setup failed", error);
      button.disabled = false;
      button.textContent = original;
      window.alert(error?.message || "تعذر تفعيل الإشعارات.");
    }
  });
  document.body.appendChild(button);
}

async function syncPushButton() {
  const user = getCurrentUser();
  const button = document.getElementById("mahad-push-enable");

  if (!user) {
    button?.remove();
    return;
  }

  if (!("Notification" in window) || !("PushManager" in window) || !window.isSecureContext) {
    return;
  }

  // The browser's PushSubscription is the source of truth after a page refresh.
  // If it exists, keep Supabase synchronized and do not show the activation button again.
  try {
    const registration = await registerServiceWorker();

    if (Notification.permission === "granted") {
      const browserSubscription = await registration.pushManager.getSubscription();

      if (browserSubscription) {
        await saveSubscription(user.id, browserSubscription);
        button?.remove();
        return;
      }
    }
  } catch (error) {
    console.warn("Push subscription sync failed", error);
  }

  // Permission denied means the browser has blocked notifications; don't keep
  // presenting an activation button that cannot open the permission prompt.
  if (Notification.permission === "denied") {
    button?.remove();
    return;
  }

  createNotificationButton();
}

export function initPushNotifications() {
  if (typeof window === "undefined") return () => {};

  registerServiceWorker().catch((error) => console.warn("Service worker registration failed", error));
  const interval = window.setInterval(() => {
    syncPushButton().catch((error) => console.warn("Push UI sync failed", error));
  }, 1000);
  syncPushButton().catch((error) => console.warn("Push UI sync failed", error));

  return () => window.clearInterval(interval);
}
