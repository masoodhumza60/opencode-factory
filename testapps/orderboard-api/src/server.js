// Nothing in this file runs on import. An earlier version started the server as
// a side effect of being loaded, which bound a port during `node --test` and
// left the process alive after every test had already passed. The entry point
// is scripts/start.js.
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb, migrate } from "./db.js";
import { config, ROOT } from "./config.js";
import { makeSessions, sessionForToken, can } from "./auth.js";
import { sendJson, serveStatic } from "./http.js";
import { listOrders, getOrder } from "./routes/orders.js";
import { signIn } from "./routes/auth.js";

const WEB = join(ROOT, "src", "web");

export function createApp({ db, auth = makeSessions() }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    const p = url.pathname;
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const session = sessionForToken(token, auth.sessions);

    if (p === "/api/session" && req.method === "GET") {
      if (!session) return sendJson(res, 401, { error: "not signed in" });
      return sendJson(res, 200, {
        role: session.role,
        name: session.name,
        can: { export: can(session, "orders.export") },
      });
    }
    if (p === "/api/session" && req.method === "POST") return signIn(auth, req, res);
    if (p === "/api/orders" && req.method === "GET") return listOrders(db, req, res, session);
    if (p.startsWith("/api/orders/") && req.method === "GET") {
      return getOrder(db, req, res, session, decodeURIComponent(p.slice("/api/orders/".length)));
    }
    if (p.startsWith("/api/")) return sendJson(res, 404, { error: "no such endpoint" });

    if (serveStatic(res, WEB, p)) return;
    return sendJson(res, 404, { error: "not found" });
  });
}

export function start({ db, auth } = {}) {
  mkdirSync(dirname(config.database), { recursive: true });
  const handle = db || openDb(config.database);
  migrate(handle);
  const server = createApp({ db: handle, auth });
  server.listen(config.port, config.host, () => {
    console.log("orderboard-api listening on http://" + config.host + ":" + config.port);
  });
  return server;
}
