// test-factory-app.mjs - does the app this bundle ships actually run?
//
// WHY THIS EXISTS, in the only terms that matter: across four runs, dozens of
// commits, 500+ assertions and eight installs, testapps/ was never booted. It
// was not even copied - it sat in the smoke test's own SKIP list. The app's
// own suite reported `tests 11 / pass 11 / fail 0` while its entry point could
// not start, because createApp() was tested and start() was not. A file in this
// bundle that could not run, hidden behind a green suite, for the whole life of
// the project.
//
// WHAT IT IS NOT: this asserts about the APP. A broken factory would pass this.
// A broken app would fail it. That is the other half of what the smoke test
// covers, and neither half substitutes for the other.
//
// FALSIFIER: run with --no-seed, which deletes the app's seed script. The data
// assertions must go red. A gate that cannot fail when the thing it guards is
// broken is decoration.

import { mkdtempSync, mkdirSync, cpSync, rmSync, existsSync, readFileSync, rmSync as rm, writeFileSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as netServer } from "node:net";

// Derive the app from THIS FILE'S OWN location, never from a hard-coded path.
// When the installer runs the installed copy of this script, a hard-coded
// REPO boots the developer's checkout while claiming to check the install -
// the same mistake the smoke test was written to catch, in the test written
// to catch it. Running what you ship is the whole point.
const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_SRC = join(BUNDLE, "testapps", "orderboard-api");
const SCRATCH = join(tmpdir(), "opencode", "app");
const NO_SEED = process.argv.includes("--no-seed");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " -- " + detail : "")); }
};

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "app-"));
const db = join(dir, "orders.db");
const outLog = join(dir, "server.out.log");
const errLog = join(dir, "server.err.log");

// Find a port rather than assume one; two of these can run side by side.
// `createServer` from node:net, not require(): a require() in a file with
// top-level await makes Node refuse to pick a module format at all, and
// node --check reports the file as fine while it dies on line 1 of the call.
const freePort = () => new Promise((res, rej) => {
  const s = netServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  s.on("error", rej);
});

let child = null;
const stop = () => { if (child) { try { child.kill(); } catch {} } };

try {
  console.log("app dir: " + dir + "\n");

  // ---- the guards, before anything runs ----
  const pkg = JSON.parse(readFileSync(join(APP_SRC, "package.json"), "utf8"));
  const deps = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length;
  check("the test app declares no dependencies, so it needs no npm install",
    deps === 0, `${deps} declared`);

  // The bundle ships a populated database. If we reused that path we would be
  // reading the bundle's rows and calling them the seed's work.
  const shippedDb = join(APP_SRC, "data", "orders.db");
  check("the bundle ships a populated database we must not accidentally reuse",
    existsSync(shippedDb) && readFileSync(shippedDb).length > 0);
  check("the database path we name does not exist yet", !existsSync(db));

  cpSync(APP_SRC, dir, { recursive: true });
  if (NO_SEED) rmSync(join(dir, "scripts", "seed.js"), { force: true });

  const env = { ...process.env, DATABASE_PATH: db, HOST: "127.0.0.1" };
  const run = (args) => spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8", env, timeout: 60000 });

  const mig = run(["scripts/start.js", "--migrate-only"]);
  const migOut = (mig.stdout || "") + (mig.stderr || "");
  check("migrate applies every migration file",
    mig.status === 0 && migOut.includes("001_init.sql") && migOut.includes("002_orders_status_index.sql"),
    migOut.trim().slice(0, 160));
  check("migrate created the database at the path we named",
    existsSync(db), "nothing at " + db);

  // One set of assertions, always. There is deliberately no --no-seed branch
  // in any check below: the flag breaks the APP, never the expectations. My
  // first version inverted the assertions under --no-seed, which made the
  // falsifier green by construction - the one thing a falsifier must not be.
  const seed = run(["scripts/seed.js"]);
  const seedOut = (seed.stdout || "") + (seed.stderr || "");
  check("seed runs against the database we named", seed.status === 0, seedOut.trim().slice(0, 160));

  // ---- boot ----
  const port = await freePort();
  env.PORT = String(port);
  child = spawn(process.execPath, ["scripts/start.js"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  const captured = [];
  child.stdout.on("data", (d) => captured.push(d.toString()));
  child.stderr.on("data", (d) => captured.push("ERR " + d.toString()));
  writeFileSync(outLog, "");
  const stopWatch = setInterval(() => writeFileSync(outLog, captured.join("")), 250);

  const base = `http://127.0.0.1:${port}`;
  const alive = async () => {
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) return "exited";
      try { await fetch(base + "/api/orders"); return true; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    return false;
  };
  const up = await alive();
  if (up !== true) {
    check("the app answers on its port", false,
      `${up === "exited" ? "the process exited" : "nothing answered"} at ${base} - server log:\n` + captured.join("").slice(0, 900));
    throw new Error("cannot continue without a running app");
  }
  check("the app answers on its port", true, base);

  const get = async (p, token) => {
    const r = await fetch(base + p, { headers: token ? { Authorization: "Bearer " + token } : {} });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, type: r.headers.get("content-type") || "", text, json };
  };
  const post = async (p, body, token) => {
    const r = await fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, type: r.headers.get("content-type") || "", text, json };
  };

  // ---- auth: an absent session is not a session with no permissions ----
  const anon = await get("/api/orders");
  check("an unauthenticated request is refused", anon.status === 401, "got " + anon.status);
  check("the refusal is JSON, not an HTML error page", /application\/json/.test(anon.type), anon.type);
  const badTok = await get("/api/orders", "tok_nonsense");
  check("a token the app never issued is refused too", badTok.status === 401, "got " + badTok.status);

  // ---- the data the seed put there ----
  const rows = await get("/api/orders", "tok_viewer");
  check("a viewer may read orders", rows.status === 200, "got " + rows.status);
  const list = Array.isArray(rows.json) ? rows.json : (rows.json?.orders || []);
  check("the seeded orders are in the app", list.length === 5, "got " + list.length);
  check("the app read the database we named, not the one in the bundle",
    list.length === 5 && list.some((o) => o.id === "ord_1001"),
    "ids: " + JSON.stringify(list.map((o) => o.id)).slice(0, 120));

  const one = await get("/api/orders/ord_1001", "tok_viewer");
  // The envelope is `{ order: {...} }`, not a bare order. I asserted a bare one
  // first and it failed on a response that was plainly correct - so the
  // assertion was wrong, not the app. Read the shape, do not assume it.
  const ord = one.json?.order ?? one.json;
  check("one order can be fetched by id, inside the order envelope",
    one.status === 200 && ord?.id === "ord_1001" && ord?.customer === "Ada Lovelace",
    "got " + one.status + " " + one.text.slice(0, 110));
  const missing = await get("/api/orders/ord_9999", "tok_viewer");
  check("an unknown order id is a 404, not an empty 200", missing.status === 404, "got " + missing.status);

  // ---- the route-precedence hazard, asserted as what this app actually does ----
  // /api/orders/export matches startsWith("/api/orders/") with id="export",
  // so it 404s as a missing order. The real project added an exact-match guard
  // with a comment naming this exact trap. This snapshot has neither the guard
  // nor the feature, and asserting it here is the point: the reference app
  // demonstrates the failure mode its own successor documents.
  const exported = await get("/api/orders/export", "tok_admin");
  check("a sub-path of /api/orders is treated as an order id, not a route (documented hazard)",
    exported.status === 404, "got " + exported.status);

  // ---- session ----
  const sess = await get("/api/session", "tok_admin");
  check("the session endpoint names who you are", sess.status === 200 && sess.json?.name === "Ada",
    "got " + sess.status + " " + sess.text.slice(0, 100));
  const signIn = await post("/api/session", { name: "viewer" });
  check("signing in returns the viewer's token",
    signIn.status === 200 && (signIn.json?.token === "tok_viewer" || signIn.text.includes("tok_viewer")),
    "got " + signIn.status + " " + signIn.text.slice(0, 100));
  const badSignIn = await post("/api/session", { name: "root" });
  check("an unknown name does not become a session", badSignIn.status >= 400, "got " + badSignIn.status);

  // ---- the page is served too ----
  const page = await fetch(base + "/");
  const pageText = await page.text();
  check("the admin page is served", page.status === 200 && /<html/i.test(pageText), "got " + page.status);

  clearInterval(stopWatch);
  writeFileSync(outLog, captured.join(""));
  writeFileSync(errLog, captured.filter((l) => l.startsWith("ERR ")).join(""));
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("evidence kept at: " + dir);
} finally {
  stop();
  if (fail === 0) { try { rm(dir, { recursive: true, force: true, maxRetries: 5 }); } catch {} }
}

process.exit(fail ? 1 : 0);