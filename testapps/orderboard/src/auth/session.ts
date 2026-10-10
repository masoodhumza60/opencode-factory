export type Role = "admin" | "staff" | "viewer";

export interface Session {
  username: string;
  role: Role;
}

const KEY = "orderboard.session";

/** Read the current session from localStorage. Null when signed out. */
export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return parsed && typeof parsed.username === "string" ? parsed : null;
  } catch {
    // A corrupt session must read as signed out, never crash a page render.
    return null;
  }
}

export function writeSession(session: Session | null): void {
  if (session === null) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(session));
}

/**
 * The app's one permission convention: a capability check reads the session and
 * returns a boolean. Features that are role-restricted call this rather than
 * branching on `session.role` themselves, so a new capability does not add a
 * second place where the rule is written down.
 */
export function can(session: Session | null, capability: "export_orders" | "edit_orders"): boolean {
  if (!session) return false;
  if (capability === "export_orders") return session.role === "admin";
  return session.role === "admin" || session.role === "staff";
}
