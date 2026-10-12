import { sendJson } from "../http.js";

export function signIn(auth, req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let name = "";
    try {
      name = (JSON.parse(body || "{}").name || "").trim();
    } catch {
      return sendJson(res, 400, { error: "body was not JSON" });
    }
    const token = auth.signIn(name);
    if (!token) return sendJson(res, 401, { error: "unknown user" });
    return sendJson(res, 200, { token });
  });
}
