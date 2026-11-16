import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless signed session cookies (HMAC-SHA256 with SESSION_SECRET),
 * session-bound CSRF tokens and same-origin checks. Participant and staff
 * sessions use different cookie names and subjects; a tracking number alone
 * never grants access.
 */
export const PARTICIPANT_COOKIE = "ufr_participant";
export const STAFF_COOKIE = "ufr_staff";
export const PARTICIPANT_TTL_MS = 30 * 60 * 1000;
export const STAFF_TTL_MS = 8 * 60 * 60 * 1000;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const eq = (a, b) => {
  const x = createHash("sha256").update(String(a)).digest();
  const y = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(x, y);
};

export function createAuth({ secret, staffUsername, staffPassword, secureCookies = true, now = Date.now }) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const mac = (value) => createHmac("sha256", secret).update(value).digest("base64url");
  const staffConfigured = typeof staffUsername === "string" && staffUsername.trim() !== "" &&
    typeof staffPassword === "string" && staffPassword.trim().length >= 16;

  function issue(name, kind, subject, ttl) {
    const body = b64(JSON.stringify({ k: kind, s: subject, e: now() + ttl, n: randomBytes(8).toString("hex") }));
    const value = `${body}.${mac(body)}`;
    return { value, header: `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}${secureCookies ? "; Secure" : ""}` };
  }
  function read(cookies, name, kind) {
    const value = cookies[name];
    if (typeof value !== "string" || value.length > 1024) return null;
    const [body, sig] = value.split(".");
    if (!body || !sig || !eq(mac(body), sig)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
    if (data?.k !== kind || typeof data.s !== "string" || !Number.isSafeInteger(data.e) || data.e < now()) return null;
    return { subject: data.s, csrf: mac("csrf:" + value) };
  }
  return {
    staffConfigured,
    parseCookies(header) {
      const out = {};
      for (const part of String(header ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
      }
      return out;
    },
    issueParticipant: (rootId) => issue(PARTICIPANT_COOKIE, "p", rootId, PARTICIPANT_TTL_MS),
    issueStaff: (username) => issue(STAFF_COOKIE, "s", username, STAFF_TTL_MS),
    participant: (cookies) => read(cookies, PARTICIPANT_COOKIE, "p"),
    staff: (cookies) => read(cookies, STAFF_COOKIE, "s"), // account existence and roles are checked against staff_users per request
    clear: (name) => `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookies ? "; Secure" : ""}`,
    checkStaffPassword(username, password) {
      if (!staffConfigured) return false;
      const u = eq(username ?? "", staffUsername.trim());
      const p = eq(password ?? "", staffPassword);
      return u && p;
    },
    csrfValid: (session, token) => Boolean(session) && typeof token === "string" && eq(session.csrf, token),
  };
}

/** Same-origin check for every state-changing request (in addition to SameSite=Strict). */
export function sameOrigin(req, publicOrigin) {
  const expected = publicOrigin ?? `http://${req.headers.host}`;
  const origin = req.headers.origin;
  if (typeof origin === "string") return origin === expected;
  return req.headers["sec-fetch-site"] === "same-origin";
}

export function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (/^[0-9a-fA-F:.]{2,45}$/.test(forwarded)) return forwarded;
  }
  return req.socket.remoteAddress ?? "unknown";
}
