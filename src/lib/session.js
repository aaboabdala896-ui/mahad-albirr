const SESSION_KEY = "mahad-albirr-session-v1";
const APP_CACHE_KEY = "mahad-albirr-cache-v1";
const REGISTRATIONS_CACHE_KEY = "mahad-albirr-registrations-cache-v1";
const NOTIFICATION_TOKEN_KEY = "mahad-albirr-notification-token-v1";

export function readStoredSession() {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function persistSession(user) {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
  } catch {
    // Ignore storage quota errors in private browsing or restricted contexts.
  }
}

export function clearSession() {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore storage errors.
  }
}

export function readAppCache() {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(APP_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function persistAppCache(data) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(APP_CACHE_KEY, JSON.stringify(data));
  } catch {
    // Ignore quota errors in restricted/mobile contexts.
  }
}

export function clearAppCache() {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(APP_CACHE_KEY);
    window.localStorage.removeItem(REGISTRATIONS_CACHE_KEY);
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore storage cleanup failures.
  }
}

export function readNotificationToken() {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage.getItem(NOTIFICATION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function persistNotificationToken(token) {
  if (typeof window === "undefined" || !token) return;

  try {
    window.localStorage.setItem(NOTIFICATION_TOKEN_KEY, token);
  } catch {
    // Ignore storage errors.
  }
}

export function clearNotificationToken() {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(NOTIFICATION_TOKEN_KEY);
  } catch {
    // Ignore storage errors.
  }
}

export { SESSION_KEY, APP_CACHE_KEY, REGISTRATIONS_CACHE_KEY, NOTIFICATION_TOKEN_KEY };
