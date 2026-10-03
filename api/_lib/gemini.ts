/**
 * Minimal Gemini client over the REST API (no SDK), streaming via SSE.
 * https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
};

export type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

export type FunctionDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type StreamRequest = {
  systemInstruction: string;
  contents: GeminiContent[];
  functionDeclarations: FunctionDeclaration[];
  signal?: AbortSignal;
};

type StreamChunk = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
};

export class GeminiError extends Error {
  /** True when Gemini was overloaded or out of quota, not a real failure. */
  busy: boolean;
  constructor(message: string, busy = false) {
    super(message);
    this.busy = busy;
  }
}

/**
 * Models to try in order. Each has its own free-tier quota, so when the
 * primary is overloaded (503) or out of quota (429) the fallback still answers.
 */
export function modelChain(): string[] {
  const primary = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const fallback = process.env.GEMINI_FALLBACK_MODEL ?? "gemini-3.5-flash-lite";
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

/**
 * Yields every non-thought part the model streams back, in order.
 * Text arrives in many small parts; function calls arrive whole.
 *
 * Tries each of `models` until one accepts the request and reports which one
 * via `onModel`. Later turns of the same conversation should pass only that
 * model, because function-call signatures are tied to the model that made them.
 */
export async function* streamGemini(
  req: StreamRequest & { models: string[]; onModel?: (model: string) => void },
): AsyncGenerator<GeminiPart> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiError("GEMINI_API_KEY is not set");

  let res: Response | null = null;
  for (const model of req.models) {
    res = await fetch(`${API_BASE}/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      signal: req.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.systemInstruction }] },
        contents: req.contents,
        tools: [{ functionDeclarations: req.functionDeclarations }],
        generationConfig: { maxOutputTokens: 2048 },
      }),
    });

    if (res.ok && res.body) {
      req.onModel?.(model);
      break;
    }

    const detail = await res.text().catch(() => "");
    const busy = res.status === 429 || res.status === 503;
    console.warn(`Gemini ${model} responded ${res.status}: ${detail.slice(0, 300)}`);
    if (!busy) throw new GeminiError(`Gemini ${model} responded ${res.status}`);
    res = null;
  }

  if (!res?.body) throw new GeminiError("Every Gemini model is busy", true);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by a blank line.
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";

    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;

      const chunk = JSON.parse(data) as StreamChunk;
      if (chunk.promptFeedback?.blockReason) {
        throw new GeminiError(`Prompt blocked: ${chunk.promptFeedback.blockReason}`);
      }
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (!part.thought) yield part;
      }
    }
  }
}
