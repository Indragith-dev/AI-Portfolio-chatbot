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

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.CONTACT_FROM_EMAIL || "AIRA Contact <onboarding@resend.dev>",
      to: [to],
      reply_to: email,
      subject: `Portfolio message from ${name.replace(/[\r\n]+/g, " ")}`,
      text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
    }),
  });

  if (!res.ok) {
    console.error(`Resend responded ${res.status}: ${await res.text().catch(() => "")}`);
    return json({ error: "Your message couldn't be sent. Please try again in a moment." }, 502, origin);
  }

  return json({ ok: true }, 200, origin);
}
