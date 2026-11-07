import { extname, join, normalize } from "node:path";
import { readFileSync } from "node:fs";

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

export function sendText(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// Serving a static file by joining a caller-supplied URL onto a root is how
// directory traversal gets in. normalize plus a containment check closes it;
// a handler that forgets the check is the defect.
export function serveStatic(res, root, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, rel === "/" || rel === "\\" ? "index.html" : rel);
  if (!file.startsWith(normalize(root))) return false;
  const type = MIME[extname(file)] || "application/octet-stream";
  let body;
  try {
    body = readFileSync(file);
  } catch {
    return false;
  }
  res.writeHead(200, { "content-type": type, "content-length": body.length });
  res.end(body);
  return true;
}
