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

export class GeminiError extends Error {}

/**
 * Yields every non-thought part the model streams back, in order.
 * Text arrives in many small parts; function calls arrive whole.
 */
export async function* streamGemini(req: StreamRequest): AsyncGenerator<GeminiPart> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiError("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const res = await fetch(`${API_BASE}/${model}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    signal: req.signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.systemInstruction }] },
      contents: req.contents,
      tools: [{ functionDeclarations: req.functionDeclarations }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new GeminiError(`Gemini responded ${res.status}: ${detail.slice(0, 500)}`);
  }

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
