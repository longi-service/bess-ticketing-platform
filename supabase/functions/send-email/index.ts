/* ============================================================================
 * send-email — Supabase Edge Function (Deno)
 *
 * Sends one notification email through the company SMTP mailbox using
 * implicit TLS (SMTP over 465). No third-party HTTP email API is used.
 *
 * Secrets (Supabase dashboard → Edge Functions → Secrets, NOT in code):
 *   SMTP_HOST   e.g. smtp.longi.com
 *   SMTP_PORT   e.g. 465 (implicit TLS)
 *   SMTP_USER   mailbox login (e.g. dingyao@longi.com, later the dedicated
 *               mailbox — the FROM address can be changed without a
 *               redeploy, only the secret changes)
 *   SMTP_PASS   app-specific password (专用密码)
 *   SMTP_FROM   optional display FROM, defaults to SMTP_USER
 *
 * Request (POST, JSON, caller JWT required):
 *   {
 *     "to": "a@b.com" | ["a@b.com", "c@d.com"],
 *     "subject": "...",                    // direct send
 *     "html": "<p>...</p>",                // direct send
 *     // …or render from a DB template:
 *     "template_key": "ticket_created",    // email_templates.key
 *     "lang": "en" | "zh",
 *     "variables": { "ticket_no": "T-1", ... },
 *     "ticket_id": "<uuid>",               // for email_log
 *     "event_key": "ticket_created"        // for email_log
 *   }
 *
 * Response: 200 { ok, sent, failed, results: [{to, ok, error}] }
 *           401 when the JWT is missing/invalid, 500 on config/SMTP errors.
 * ========================================================================== */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const SMTP_HOST = Deno.env.get("SMTP_HOST") || "";
const SMTP_PORT = parseInt(Deno.env.get("SMTP_PORT") || "465", 10);
const SMTP_USER = Deno.env.get("SMTP_USER") || "";
const SMTP_PASS = Deno.env.get("SMTP_PASS") || "";
const SMTP_FROM = Deno.env.get("SMTP_FROM") || SMTP_USER;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

/* ---------- small base64 (Deno has no Buffer) ---------- */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] +
      (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=") +
      (i + 2 < bytes.length ? B64[c & 63] : "=");
  }
  return out;
}
const b64 = (s: string) => base64Encode(new TextEncoder().encode(s));

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderTpl(text: string, vars: Record<string, unknown>, escape: boolean): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k) => {
    const v = vars[k];
    if (v == null) return "";
    return escape ? escapeHtml(String(v)) : String(v);
  });
}

/* ---------- minimal SMTP client over implicit TLS ---------- */
class Smtp {
  private conn!: Deno.TlsConn;
  private buf = "";
  private dec = new TextDecoder();
  private enc = new TextEncoder();

  async connect() {
    this.conn = await Deno.connectTls({ hostname: SMTP_HOST, port: SMTP_PORT });
    const code = await this.readReply();
    if (code !== 220) throw new Error("SMTP greeting failed: " + code);
  }
  async readReply(): Promise<number> {
    for (;;) {
      const lines = this.buf.split("\r\n");
      for (const line of lines) {
        const m = line.match(/^(\d{3}) /);
        if (m) { this.buf = this.buf.slice(this.buf.indexOf(line) + line.length + 2); return parseInt(m[1], 10); }
      }
      const chunk = new Uint8Array(4096);
      const n = await this.conn.read(chunk);
      if (n === null) throw new Error("SMTP connection closed by server");
      this.buf += this.dec.decode(chunk.subarray(0, n));
    }
  }
  async cmd(line: string, expect: number[]): Promise<number> {
    await this.conn.write(this.enc.encode(line + "\r\n"));
    const code = await this.readReply();
    if (!expect.includes(code)) throw new Error(`SMTP '${line.split(" ")[0]}' failed: ${code}`);
    return code;
  }
  async login() {
    await this.cmd("EHLO bess-ticketing", [250]);
    // Prefer AUTH LOGIN, fall back to AUTH PLAIN.
    try {
      await this.cmd("AUTH LOGIN", [334]);
      await this.cmd(b64(SMTP_USER), [334]);
      await this.cmd(b64(SMTP_PASS), [235]);
    } catch (e) {
      await this.cmd("AUTH PLAIN " + b64("\0" + SMTP_USER + "\0" + SMTP_PASS), [235]).catch(() => {
        throw e;
      });
    }
  }
  async sendMail(from: string, toList: string[], subject: string, html: string): Promise<void> {
    await this.cmd(`MAIL FROM:<${from}>`, [250]);
    for (const to of toList) await this.cmd(`RCPT TO:<${to}>`, [250, 251]);
    await this.cmd("DATA", [354]);
    const date = new Date().toUTCString();
    const msgId = `<${crypto.randomUUID()}@${SMTP_HOST}>`;
    const subj = /[^\x00-\x7F]/.test(subject) ? `=?UTF-8?B?${b64(subject)}?=` : subject;
    // Dot-stuffing: a body line starting with '.' would terminate DATA early.
    const stuffed = html.replace(/(^|\r\n)\./g, "$1..");
    const msg =
      `From: ${from}\r\nTo: ${toList.join(", ")}\r\nSubject: ${subj}\r\n` +
      `Date: ${date}\r\nMessage-ID: ${msgId}\r\nMIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n` +
      `${stuffed}\r\n.`;
    await this.cmd(msg, [250]);
  }
  async quit() {
    try { await this.cmd("QUIT", [221]); } catch { /* best effort */ }
    try { this.conn.close(); } catch { /* already closed */ }
  }
}

/* ---------- auth ---------- */
async function callerId(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") || "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  // service_role callers (e.g. future cron) are allowed.
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1]));
    if (payload && payload.role === "service_role") return "service_role";
  } catch { /* not a parseable JWT — fall through to user check */ }
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: auth } } });
    const { data, error } = await sb.auth.getUser(jwt);
    if (error || !data?.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

/* ---------- handler ---------- */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false, error: "method not allowed" });

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return json(500, { ok: false, error: "SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing)" });
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(500, { ok: false, error: "SUPABASE_URL / SUPABASE_ANON_KEY missing" });
  }

  const uid = await callerId(req);
  if (!uid) return json(401, { ok: false, error: "invalid or missing JWT" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: "invalid JSON" }); }

  const toList: string[] = (Array.isArray(body.to) ? body.to : [body.to])
    .filter((x: unknown) => typeof x === "string" && /.+@.+\..+/.test(x as string));
  if (!toList.length) return json(400, { ok: false, error: "'to' is required" });

  let subject: string = body.subject || "";
  let html: string = body.html || "";
  const vars: Record<string, unknown> = body.variables || {};

  if (body.template_key && (!subject || !html)) {
    // Render server-side from email_templates (RLS: authenticated read).
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const { data, error } = await sb.from("email_templates")
      .select("subject,body_html")
      .eq("key", body.template_key)
      .eq("lang", body.lang === "zh" ? "zh" : "en")
      .eq("is_active", true)
      .maybeSingle();
    if (error || !data) {
      return json(400, { ok: false, error: "template not found: " + body.template_key });
    }
    subject = renderTpl(data.subject, vars, false);
    html = renderTpl(data.body_html, vars, true);
  }
  if (!subject || !html) return json(400, { ok: false, error: "'subject' and 'html' (or a template) are required" });

  // One SMTP session, one DATA block, multiple RCPTs.
  const smtp = new Smtp();
  try {
    await smtp.connect();
    await smtp.login();
    await smtp.sendMail(SMTP_FROM, toList, subject, html);
  } catch (e) {
    await smtp.quit();
    await logAll(body, toList, subject, uid, "failed", String(e?.message || e), req);
    return json(500, { ok: false, error: "SMTP send failed: " + (e?.message || e) });
  }
  await smtp.quit();

  await logAll(body, toList, subject, uid, "sent", null, req);
  return json(200, {
    ok: true, sent: toList.length, failed: 0,
    results: toList.map((t) => ({ to: t, ok: true })),
  });
});

async function logAll(body: any, toList: string[], subject: string, uid: string,
  status: "sent" | "failed", error: string | null, req: Request) {
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const rows = toList.map((t) => ({
      ticket_id: body.ticket_id || null,
      event_key: body.event_key || body.template_key || null,
      recipient: t,
      subject,
      status,
      error,
      created_by: uid === "service_role" ? null : uid,
    }));
    await sb.from("email_log").insert(rows);
  } catch { /* log failure must never break the response */ }
}
