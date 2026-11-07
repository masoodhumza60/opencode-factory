#!/usr/bin/env node
// Serve a static fixture, drive it through every declared state at the three
// widths the web profile requires, and write the evidence: one screenshot per
// state and width, plus one axe report over the default state.
//
// It never attests. Attestation is a separate, named act (factory-attest), and
// a capture that failed must leave the bead with nothing to attest.
import { createServer } from "node:http";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const STATES = ["default", "loading", "empty", "error", "disabled"];
export const WIDTHS = [1440, 768, 390];
const SETTLE_MS = 5000;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const USAGE = `usage: node scripts/factory-capture.mjs --fixture <dir> [--out <dir>] [--bead <bead>] [--state <state>]

  --fixture <dir>  the static app to serve and capture (required)
  --out <dir>      where artifacts go (default: out/capture; with --bead,
                   .factory/<bead>/capture)
  --bead <bead>    label the run for a bead; it does not attest anything
  --state <state>  capture a single state instead of all five; the state is
                   passed through to the fixture as ?state= (test probe)

Writes <out>/<state>-<width>.png for ${STATES.join(", ")} at ${WIDTHS.join("/")},
and <out>/axe.json. Then prints the artifact list. It never attests; run
factory-attest with the paths it prints.`;

function parseArgs(argv) {
  const args = { fixture: null, out: null, bead: null, state: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { args.help = true; continue; }
    const take = () => {
      const v = argv[i + 1];
      if (v === undefined) { console.error(`ERROR: ${a} is missing its value\n\n${USAGE}`); process.exit(1); }
      i += 1;
      return v;
    };
    if (a === "--fixture") args.fixture = take();
    else if (a === "--out") args.out = take();
    else if (a === "--bead") args.bead = take();
    else if (a === "--state") args.state = take();
    else { console.error(`ERROR: unknown flag "${a}"\n\n${USAGE}`); process.exit(1); }
  }
  return args;
}

function serve(fixtureRoot) {
  const root = resolve(fixtureRoot);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const raw = decodeURIComponent(url.pathname);
    const rel = normalize(raw === "/" ? "index.html" : raw.replace(/^\/+/, ""));
    const abs = join(root, rel);
    if (!abs.startsWith(root + sep)) { res.writeHead(403).end("forbidden"); return; }
    try {
      const body = await readFile(abs);
      res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      done({ server, base: `http://127.0.0.1:${port}/` });
    });
  });
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (e) {
    throw new Error(
      `SKIPPED: no browser - playwright is not installed (${e.message}). ` +
      "Run npm install && npx playwright install chromium");
  }
}

export async function capture({ fixture, out, state = null }) {
  // stat is promise-based; awaiting it here is what makes this refusal real
  // instead of a TypeError on a Promise with no isDirectory.
  const info = existsSync(fixture) ? await stat(fixture) : null;
  if (!info || !info.isDirectory()) {
    throw new Error(`${fixture} does not exist or is not a directory: point --fixture at the app to capture`);
  }
  const states = state ? [state] : STATES;
  for (const s of states) {
    if (!STATES.includes(s) && s !== "console-error") {
      throw new Error(`state "${s}" is not one of ${STATES.join(", ")} (or the console-error probe)`);
    }
  }

  const playwright = await loadPlaywright();
  const { AxeBuilder } = await import("@axe-core/playwright").catch((e) => {
    throw new Error(`SKIPPED: no browser - @axe-core/playwright is not installed (${e.message}). Run npm install`);
  });

  await mkdir(out, { recursive: true });
  const { server, base } = await serve(fixture);
  const written = [];
  const consoleErrors = [];
  let browser;
  let context;
  try {
    try {
      browser = await playwright.chromium.launch();
    } catch (e) {
      throw new Error(`SKIPPED: no browser - chromium did not launch (${e.message}). Run npx playwright install chromium`);
    }
    // Axe opens a blank page of its own to inject its runner, so it needs a
    // browser context, not the implicit one browser.newPage() used to make.
    context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(`${page.url()} -> ${msg.text()}`);
    });
    page.on("pageerror", (err) => consoleErrors.push(`${page.url()} -> ${err.message}`));

    for (const s of states) {
      for (const width of WIDTHS) {
        const url = `${base}?state=${encodeURIComponent(s)}`;
        await page.setViewportSize({ width, height: 900 });
        consoleErrors.length = 0;
        await page.goto(url, { waitUntil: "load" });
        try {
          await page.waitForFunction(
            (want) => document.body?.dataset?.state === want, s, { timeout: SETTLE_MS });
        } catch {
          const seen = await page.evaluate(() => document.body?.dataset?.state ?? "<none>").catch(() => "<unreachable>");
          throw new Error(
            `state "${s}" never settled at ${width}px (body[data-state] is ${seen} after ${SETTLE_MS}ms)`);
        }
        const file = join(out, `${s}-${width}.png`);
        await page.screenshot({ path: file, fullPage: true });
        written.push(file);
        if (consoleErrors.length) {
          throw new Error(
            `state "${s}" at ${width}px logged ${consoleErrors.length} console error(s):\n  ${consoleErrors.join("\n  ")}`);
        }
      }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    consoleErrors.length = 0;
    await page.goto(`${base}?state=default`, { waitUntil: "load" });
    await page.waitForFunction(() => document.body?.dataset?.state === "default", null, { timeout: SETTLE_MS });
    const result = await new AxeBuilder({ page }).analyze();
    const axeFile = join(out, "axe.json");
    await writeFile(axeFile, `${JSON.stringify({
      url: `${base}?state=default`,
      generated_at: new Date().toISOString(),
      rules: result.violations.length + result.passes.length + result.incomplete.length,
      violations: result.violations.map((v) => ({
        id: v.id, impact: v.impact ?? null, help: v.help,
        nodes: v.nodes.map((n) => ({ target: n.target, html: n.html })),
      })),
      // The rules that were checked and passed are evidence too: a report with
      // no passes cannot be told from a report that never ran.
      passes: result.passes.map((p) => ({ id: p.id, help: p.help })),
      incomplete: result.incomplete.map((v) => ({ id: v.id, help: v.help, count: v.nodes.length })),
    }, null, 2)}\n`, "utf8");
    written.push(axeFile);
    if (consoleErrors.length) {
      throw new Error(`the axe page logged console error(s):\n  ${consoleErrors.join("\n  ")}`);
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((done) => server.close(done));
  }  return written;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (!args.fixture) { console.error(`ERROR: --fixture is required\n\n${USAGE}`); return 1; }
  const out = args.out ?? (args.bead ? join(".factory", args.bead, "capture") : join("out", "capture"));
  try {
    const written = await capture({ fixture: args.fixture, out, state: args.state });
    for (const f of written) console.log(f);
    console.log(`captured ${written.length} artifacts in ${out} - none attested; run factory-attest with these paths`);
    return 0;
  } catch (e) {
    if (String(e.message).startsWith("SKIPPED: no browser")) {
      console.error(e.message);
      return 1;
    }
    console.error(`ERROR: ${e.message}`);
    return 1;
  }
}

// Comparing import.meta.url with a hand-built "file://" + path is wrong on
// Windows (file:///C:/... vs file://C:/...), so the entrypoint would never run.
// pathToFileURL produces the same form Node does.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
