export function canUseNotifications() {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function requestNotificationPermission() {
  if (!canUseNotifications()) return "unsupported";

  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";

  return Notification.requestPermission();
}

export function showBrowserNotification(title, options = {}) {
  if (!canUseNotifications() || Notification.permission !== "granted") return null;

  return new Notification(title, {
    body: options.body || "",
    icon: options.icon || "/icons/icon-192.png",
  });
}
