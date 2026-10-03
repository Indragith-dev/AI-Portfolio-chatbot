/**
 * POST /api/chat
 *
 * Body: { messages: [{ role: "user" | "assistant", content: string }] }
 * Streams NDJSON, one object per line:
 *   { type: "text", text }
 *   { type: "action", name: "focus_project" | "highlight_skill", args }
 *   { type: "error", message }
 */

import { clientIp, corsHeaders, json, preflight, readJsonPost } from "./_lib/http.js";
import { rateLimit } from "./_lib/rate-limit.js";
import { PROJECT_IDS, SYSTEM_PROMPT } from "./_lib/profile.js";
import {
  streamGemini,
  type FunctionDeclaration,
  type GeminiContent,
  type GeminiPart,
} from "./_lib/gemini.js";

const MAX_MESSAGES = 12;
const MAX_CHARS = 500;
const RATE_LIMIT = 10; // messages per IP
const RATE_WINDOW_SECONDS = 60 * 60;
/** Model turns per request: one to call tools, one to answer after them. */
const MAX_ROUNDS = 3;

const FUNCTIONS: FunctionDeclaration[] = [
  {
    name: "focus_project",
    description: "Move the portfolio's 3D camera to one of Indran's projects.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", enum: [...PROJECT_IDS], description: "Project id" },
      },
      required: ["id"],
    },
  },
  {
    name: "highlight_skill",
    description: "Highlight one of Indran's skills or technologies in the 3D scene.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name as written in the profile, e.g. React" },
      },
      required: ["name"],
    },
  },
];

type ChatMessage = { role: "user" | "assistant"; content: string };

export function OPTIONS(request: Request): Response {
  return preflight(request);
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");

  const parsed = await readJsonPost(request, 32_000);
  if ("error" in parsed) return parsed.error;

  const messages = parseMessages(parsed.body);
  if (!messages) {
    return json(
      { error: "Send a list of messages ending with a question from you." },
      400,
      origin,
    );
  }

  const limit = await rateLimit(`chat:${clientIp(request)}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
  if (!limit.allowed) {
    const minutes = Math.max(1, Math.ceil(limit.retryAfterSeconds / 60));
    return json(
      {
        error: `You've reached the chat limit for now. Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}, or reach Indran directly through the contact form.`,
      },
      429,
      origin,
      { "Retry-After": String(limit.retryAfterSeconds) },
    );
  }

  const contents: GeminiContent[] = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

      try {
        await runConversation(contents, send, request.signal);
      } catch (err) {
        if (request.signal.aborted) return;
        console.error("Chat failed", err);
        send({
          type: "error",
          message: "AIRA is having trouble answering right now. Please try again in a moment.",
        });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed because the client went away.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(origin),
    },
  });
}

async function runConversation(
  contents: GeminiContent[],
  send: (obj: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  let sentText = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const modelParts: GeminiPart[] = [];
    const calls: { name: string; args: Record<string, unknown> }[] = [];

    for await (const part of streamGemini({
      systemInstruction: SYSTEM_PROMPT,
      contents,
      functionDeclarations: FUNCTIONS,
      signal,
    })) {
      // Kept verbatim (including thoughtSignature) so the follow-up turn is valid.
      modelParts.push(part);

      if (part.text) {
        send({ type: "text", text: part.text });
        sentText = true;
      } else if (part.functionCall) {
        const call = { name: part.functionCall.name, args: part.functionCall.args ?? {} };
        calls.push(call);
        const action = toAction(call);
        if (action) send({ type: "action", ...action });
      }
    }

    if (calls.length === 0) break;

    // Report the tool results back so the model can finish its answer in text.
    contents = [
      ...contents,
      { role: "model", parts: modelParts },
      {
        role: "user",
        parts: calls.map((c) => ({
          functionResponse: {
            name: c.name,
            response: { result: toAction(c) ? "Done, the scene was updated." : "Unknown target, nothing changed." },
          },
        })),
      },
    ];
  }

  if (!sentText) {
    send({ type: "text", text: "Sorry, I couldn't come up with an answer. Could you rephrase that?" });
  }
}

/** Validates a model function call before it reaches the browser. */
function toAction(call: {
  name: string;
  args: Record<string, unknown>;
}): { name: string; args: Record<string, unknown> } | null {
  if (call.name === "focus_project") {
    const id = String(call.args.id ?? "").toLowerCase();
    return (PROJECT_IDS as readonly string[]).includes(id) ? { name: call.name, args: { id } } : null;
  }
  if (call.name === "highlight_skill") {
    const name = String(call.args.name ?? "").trim().slice(0, 60);
    return name ? { name: call.name, args: { name } } : null;
  }
  return null;
}

/** Returns the trimmed, capped history, or null if the body is unusable. */
function parseMessages(body: unknown): ChatMessage[] | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = (body as { messages?: unknown }).messages;
  if (!Array.isArray(raw)) return null;

  const messages: ChatMessage[] = [];
  for (const m of raw.slice(-MAX_MESSAGES)) {
    if (typeof m !== "object" || m === null) return null;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    const text = content.trim().slice(0, MAX_CHARS);
    if (text) messages.push({ role, content: text });
  }

  // Gemini needs the conversation to start with a user turn.
  while (messages.length && messages[0].role !== "user") messages.shift();

  if (!messages.length || messages[messages.length - 1].role !== "user") return null;
  return messages;
}
