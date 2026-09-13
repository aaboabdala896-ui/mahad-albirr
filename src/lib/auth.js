export function normalizeUser(user) {
  if (!user || typeof user !== "object") return null;

  return {
    id: user.id ?? user.user_id ?? null,
    name: user.name ?? "",
    role: user.role ?? "guest",
    username: user.username ?? "",
  };
}

export function validateLogin(users, username, password, role) {
  const cleanUsername = String(username ?? "").trim();
  const cleanPassword = String(password ?? "").trim();

  if (!cleanUsername || !cleanPassword) return null;

  return (
    users.find(
      (user) =>
        user.username === cleanUsername &&
        String(user.password) === cleanPassword &&
        user.role === role
    ) || null
  );
}

export function canAccessRole(user, allowedRoles = []) {
  if (!user) return false;
  if (allowedRoles.length === 0) return true;
  return allowedRoles.includes(user.role);
}

export function getRoleLabel(role) {
  const labels = {
    admin: "مدير",
    teacher: "معلم",
    parent: "ولي أمر",
    guest: "مستخدم",
  };

  return labels[role] || "مستخدم";
}

export function getSafeRole(user) {
  const normalized = normalizeUser(user);
  return normalized ? normalized.role : "guest";
}
