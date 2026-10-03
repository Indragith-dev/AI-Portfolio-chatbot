/**
 * POST /api/contact
 *
 * Body: { name, email, message, website }. `website` is a honeypot and must be empty.
 * Success: 200 { ok: true }. Failure: non-2xx { error }.
 * Delivers the message by email through Resend's REST API.
 */

import { clientIp, json, preflight, readJsonPost } from "./_lib/http.js";
import { rateLimit } from "./_lib/rate-limit.js";

const RATE_LIMIT = 3; // submissions per IP
const RATE_WINDOW_SECONDS = 60 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function OPTIONS(request: Request): Response {
  return preflight(request);
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");

  const parsed = await readJsonPost(request, 16_000);
  if ("error" in parsed) return parsed.error;

  const body = (parsed.body ?? {}) as Record<string, unknown>;
  const field = (key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");

  // Bots fill every field. Pretend it worked so they don't adapt.
  if (field("website")) return json({ ok: true }, 200, origin);

  const name = field("name");
  const email = field("email");
  const message = field("message");

  if (!name || name.length > 100) {
    return json({ error: "Please enter your name (up to 100 characters)." }, 400, origin);
  }
  if (!EMAIL_RE.test(email) || email.length > 200) {
    return json({ error: "Please enter a valid email address." }, 400, origin);
  }
  if (message.length < 10 || message.length > 3000) {
    return json({ error: "Your message should be between 10 and 3000 characters." }, 400, origin);
  }

  const limit = await rateLimit(`contact:${clientIp(request)}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
  if (!limit.allowed) {
    return json(
      { error: "You've sent a few messages already. Please try again later or email Indran directly." },
      429,
      origin,
      { "Retry-After": String(limit.retryAfterSeconds) },
    );
  }

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO_EMAIL;
  if (!apiKey || !to) {
    console.error("RESEND_API_KEY or CONTACT_TO_EMAIL is not set");
    return json({ error: "The contact form isn't available right now. Please email Indran directly." }, 503, origin);
  }

  const details = {
    name,
    email,
    message,
    sentAt: new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "short",
    }) + " IST",
    page: request.headers.get("referer") || origin || "unknown",
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.CONTACT_FROM_EMAIL || "AIRA Contact <onboarding@resend.dev>",
      to: [to],
      // Hitting Reply in the inbox answers the visitor directly.
      reply_to: email,
      subject: `New portfolio message from ${name.replace(/[\r\n]+/g, " ")}`,
      text: emailText(details),
      html: emailHtml(details),
    }),
  });

  if (!res.ok) {
    console.error(`Resend responded ${res.status}: ${await res.text().catch(() => "")}`);
    return json({ error: "Your message couldn't be sent. Please try again in a moment." }, 502, origin);
  }

  const { id } = (await res.json().catch(() => ({}))) as { id?: string };
  console.log(`Contact email sent (Resend id ${id ?? "unknown"}) from ${email}`);
  return json({ ok: true }, 200, origin);
}

type Details = { name: string; email: string; message: string; sentAt: string; page: string };

function emailText(d: Details): string {
  return [
    "New message from your portfolio contact form",
    "",
    `Name:    ${d.name}`,
    `Email:   ${d.email}`,
    `Sent:    ${d.sentAt}`,
    `Page:    ${d.page}`,
    "",
    "Message:",
    d.message,
    "",
    "Reply to this email to answer them directly.",
  ].join("\n");
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function emailHtml(d: Details): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#666;font-size:13px;vertical-align:top;white-space:nowrap">${label}</td>` +
    `<td style="padding:6px 0;font-size:14px;color:#111">${value}</td></tr>`;
  const email = escapeHtml(d.email);

  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden">
  <div style="background:#111;color:#fff;padding:16px 24px;font-size:16px;font-weight:bold">New portfolio message</div>
  <div style="padding:20px 24px">
    <table style="border-collapse:collapse;width:100%">
      ${row("Name", escapeHtml(d.name))}
      ${row("Email", `<a href="mailto:${email}" style="color:#2563eb">${email}</a>`)}
      ${row("Sent", escapeHtml(d.sentAt))}
      ${row("Page", escapeHtml(d.page))}
    </table>
    <div style="margin-top:16px;padding:16px;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;font-size:14px;line-height:1.6;color:#111;white-space:pre-wrap">${escapeHtml(d.message)}</div>
    <p style="margin:16px 0 0;font-size:12px;color:#888">Reply to this email to answer ${escapeHtml(d.name)} directly.</p>
  </div>
</div></body></html>`;
}
