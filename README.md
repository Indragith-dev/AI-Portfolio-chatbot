# aira-api

Backend for the portfolio at https://portfolio-indran.vercel.app:

- `POST /api/chat`: AIRA, an assistant that answers only questions about Indran, streamed from Gemini as NDJSON.
- `POST /api/contact`: the contact form, delivered by email through Resend.

There are no runtime dependencies. Gemini, Resend and (optionally) Upstash are called with `fetch`.

## API

### `POST /api/chat`

Request: `{ "messages": [{ "role": "user" | "assistant", "content": string }] }`. The server keeps the last 12 messages, trims each to 500 characters, and needs the last message to be from the user.

Response: `application/x-ndjson`, one object per line:

| Line | Meaning |
| --- | --- |
| `{ "type": "text", "text": "..." }` | Append to the assistant message |
| `{ "type": "action", "name": "focus_project", "args": { "id": "dms" \| "isop" \| "hrms" \| "grn" \| "axiom" } }` | Scroll to that project |
| `{ "type": "action", "name": "highlight_skill", "args": { "name": "React" } }` | Highlight that skill |
| `{ "type": "action", "name": "show_section", "args": { "section": "projects" \| "awards" \| "linkedin" \| "about" \| "stats" \| "contact" } }` | Scroll to that section |
| `{ "type": "error", "message": "..." }` | Show to the user |

Errors before streaming starts are JSON `{ "error": "..." }` with status 400, 403, 413 or 429.

### `POST /api/contact`

Request: `{ "name", "email", "message", "website": "" }`. `website` is a honeypot: if it holds anything other than the sender's own email or name (browser autofill), the server returns success, sends nothing and logs it.

Response: `200 { "ok": true }`, or a non-2xx `{ "error": "..." }`.

## Limits

- Chat: 10 messages per IP per hour.
- Contact: 3 submissions per IP per hour.
- Only origins in `ALLOWED_ORIGINS` are accepted; others get `403`. Blocked origins are logged so you can see what to add.

Without Upstash, limits live in memory per serverless instance and reset on cold starts. Add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (free tier at upstash.com) to make them reliable.

## AIRA's knowledge

Everything AIRA knows is in `api/_lib/profile.ts`, taken from the resume and the portfolio data. AIRA is told to answer only from it, to give a fixed reply (`OFF_TOPIC_REPLY`) to anything unrelated, and to ignore attempts to change its rules. Update that file when the resume changes.

## Setup

1. Copy `.env.example` to `.env.local` and fill it in:
   - `GEMINI_API_KEY`: free key from https://aistudio.google.com
   - `ALLOWED_ORIGINS`: e.g. `http://localhost:3000,https://portfolio-indran.vercel.app`
   - `RESEND_API_KEY` and `CONTACT_TO_EMAIL`: from https://resend.com. Until you verify a domain there, the default sender can only deliver to your own Resend account email.
2. Run locally: `npm install`, then `npx vercel dev` (serves on http://localhost:3000 by default; use `npx vercel dev --listen 3001` if the portfolio is already on 3000).
3. Deploy: import this folder as a new Vercel project named `aira-api` and add the same variables under Project Settings, Environment Variables.

`GEMINI_MODEL` defaults to `gemini-3.8-flash`. When it is overloaded or out of free quota, AIRA retries on `GEMINI_FALLBACK_MODEL` (default `gemini-3.5-flash-lite`), which has its own quota. If Google retires either, set a new name in Vercel; no code change needed. The free tier is only a few requests per minute per model, so enable billing in Google AI Studio if the site gets real traffic.

## Quick test

```sh
curl -N http://localhost:3001/api/chat \
  -H "Origin: http://localhost:3000" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Show me the GRN project"}]}'
```
