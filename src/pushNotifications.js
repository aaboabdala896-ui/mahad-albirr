import { supabase } from "./supabaseClient";

const VAPID_PUBLIC_KEY =
  "BMqHNM8AY7rMj5PSqwfvqA6LwpS_TSIKKMQmhFqz24ewgCKS-P9rpfT9qBzFuAIJki2skcOxSn8p6EcVaFhhwod8";

const SESSION_STORAGE_KEY = "mahad-albirr:session";
const AUTH_CHANGED_EVENT = "mahad:auth-changed";

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

// --- Session bridge, used by App.jsx -----------------------------------
// This is the ONLY place that owns the "mahad-albirr:session" key, so the
// login screen and the push-notification code can never disagree about
// whether someone is logged in. Previously nothing in the app ever wrote
// this key, so getCurrentUser() always returned null after a refresh.
export function restoreSession() {
  return getCurrentUser();
}

export function saveSession(user) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(user));
  } catch (error) {
    console.warn("Could not persist session:", error);
  }
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch (error) {
    console.warn("Could not clear session:", error);
  }
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) throw new Error("هذا المتصفح لا يدعم Service Worker.");
  // register() resolves as soon as a registration OBJECT exists, even if the
  // worker itself is still "installing". pushManager calls on a
  // not-yet-active worker are where cross-browser flakiness creeps in, so we
  // wait for navigator.serviceWorker.ready, which only resolves once there is
  // an ACTIVE worker controlling this scope. register() is still called
  // first so a first-time visitor's worker actually gets installed.
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
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

function getDashboardNotificationButtons() {
  return [...document.querySelectorAll("button")].filter((button) => {
    const text = button.textContent?.trim() || "";
    return text === "تفعيل الإشعارات" || text === "🔔 تفعيل الإشعارات" || text === "الإشعارات مفعّلة" || text === "✓ الإشعارات مفعّلة";
  });
}

function setDashboardNotificationState(enabled) {
  getDashboardNotificationButtons().forEach((button) => {
    if (enabled) {
      button.textContent = "✓ الإشعارات مفعّلة";
      button.disabled = true;
      button.style.cursor = "default";
      button.title = "الإشعارات مفعّلة على هذا الجهاز";
    } else {
      button.textContent = "🔔 تفعيل الإشعارات";
      button.disabled = false;
      button.style.cursor = "pointer";
      button.title = "اضغط لتفعيل الإشعارات";
    }
  });
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

  // The browser subscription is what actually matters (it's what real push
  // delivery is keyed on). Supabase sync is best-effort: if it fails here,
  // syncPushButton() will retry it later, but we must not throw and roll
  // the UI back to "enable" when the device is already subscribed.
  try {
    await saveSubscription(user.id, subscription);
  } catch (error) {
    console.warn("Could not sync push subscription with Supabase:", error);
  }
  setDashboardNotificationState(true);
  return { ok: true, subscription };
}

function styleNotificationButton(button, active) {
  button.textContent = active ? "✓ الإشعارات مفعّلة" : "🔔 تفعيل الإشعارات";
  button.style.background = active ? "#145C43" : "#0B3D2E";
  button.style.cursor = active ? "default" : "pointer";
  button.disabled = active;
  button.title = active ? "الإشعارات مفعّلة على هذا الجهاز" : "اضغط لتفعيل الإشعارات";
}

function createNotificationButton(active = false) {
  const existing = document.getElementById("mahad-push-enable");
  if (existing) {
    styleNotificationButton(existing, active);
    return existing;
  }

  const button = document.createElement("button");
  button.id = "mahad-push-enable";
  button.type = "button";
  Object.assign(button.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: "9999",
    border: "0",
    borderRadius: "999px",
    padding: "12px 18px",
    color: "#fff",
    fontFamily: "Cairo, sans-serif",
    fontSize: "14px",
    fontWeight: "700",
    boxShadow: "0 8px 24px rgba(0,0,0,.18)",
    transition: "all .2s ease",
  });
  styleNotificationButton(button, active);

  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "جارٍ التفعيل…";
    try {
      await enablePushNotifications();
      styleNotificationButton(button, true);
    } catch (error) {
      console.error("Push setup failed", error);
      button.disabled = false;
      button.textContent = original;
      window.alert(error?.message || "تعذر تفعيل الإشعارات.");
    }
  });

  document.body.appendChild(button);
  return button;
}

async function syncPushButton() {
  const user = getCurrentUser();

  if (!user) {
    document.getElementById("mahad-push-enable")?.remove();
    return;
  }

  if (!("Notification" in window) || !("PushManager" in window) || !window.isSecureContext) {
    return;
  }

  try {
    const registration = await registerServiceWorker();

    if (Notification.permission === "granted") {
      const browserSubscription = await registration.pushManager.getSubscription();

      if (browserSubscription) {
        // The browser subscription is the source of truth: show the
        // enabled state immediately, and KEEP the button visible rather
        // than removing it — removing it is what made a page refresh look
        // like notifications had turned back off.
        createNotificationButton(true);
        setDashboardNotificationState(true);

        try {
          await saveSubscription(user.id, browserSubscription);
        } catch (syncError) {
          console.warn("Could not sync push subscription with Supabase:", syncError);
        }
        return;
      }
    }
  } catch (error) {
    console.warn("Push subscription sync failed", error);
  }

  if (Notification.permission === "denied") {
    document.getElementById("mahad-push-enable")?.remove();
    return;
  }

  createNotificationButton(false);
}

export function initPushNotifications() {
  if (typeof window === "undefined") return () => {};

  const runSync = () => syncPushButton().catch((error) => console.warn("Push UI sync failed", error));

  // Run once immediately, and again the moment login/logout happens (see
  // saveSession/clearSession above) or the tab regains focus/visibility —
  // this reacts instantly instead of waiting on a fixed-interval timer.
  // A slow background poll is kept only as a safety net (e.g. the browser
  // permission was changed from the address-bar UI while the tab was open).
  runSync();
  window.addEventListener(AUTH_CHANGED_EVENT, runSync);
  window.addEventListener("focus", runSync);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") runSync();
  });
  const interval = window.setInterval(runSync, 30000);

  return () => {
    window.clearInterval(interval);
    window.removeEventListener(AUTH_CHANGED_EVENT, runSync);
    window.removeEventListener("focus", runSync);
  };
}
