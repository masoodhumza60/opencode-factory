// Two roles, one permission table. The page decides what to render; the routes
// decide what is allowed. Both ask this module, so a permission cannot be
// enforced in one place and forgotten in the other.
const ROLE_PERMISSIONS = {
  admin: ["orders.read", "orders.write", "orders.export"],
  viewer: ["orders.read"],
};

// An absent session is NOT the same answer as a session with no permissions.
// A missing token must never read as allowed.
export function can(session, permission) {
  if (!session || !ROLE_PERMISSIONS[session.role]) return false;
  return ROLE_PERMISSIONS[session.role].includes(permission);
}

export function sessionForToken(token, sessions) {
  const s = sessions.get(token);
  return s ? { role: s.role, name: s.name } : null;
}

// A throwaway credential store. Sign-in maps a name to a fixed token so the
// admin page and the tests can both sign in without a password anywhere.
export function makeSessions() {
  const sessions = new Map([["tok_admin", { role: "admin", name: "Ada" }], ["tok_viewer", { role: "viewer", name: "Vic" }]]);
  return {
    sessions,
    signIn(name) {
      if (name === "admin") return "tok_admin";
      if (name === "viewer") return "tok_viewer";
      return null;
    },
  };
}
