/**
 * CORS, client IP and JSON helpers shared by every route.
 * Files under api/_lib are not exposed as routes by Vercel.
 */

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function isAllowedOrigin(origin: string | null): boolean {
  return origin !== null && allowedOrigins.includes(origin);
}

export function json(
  body: unknown,
  status: number,
  origin: string | null,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
      ...extra,
    },
  });
}

/** Answers the CORS preflight. */
export function preflight(request: Request): Response {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/**
 * Runs the checks every POST route needs: allowed origin and a JSON body.
 * Returns either the parsed body or a ready-made error Response.
 */
export async function readJsonPost(
  request: Request,
  maxBytes: number,
): Promise<{ body: unknown } | { error: Response }> {
  const origin = request.headers.get("origin");

  if (!isAllowedOrigin(origin)) {
    // Logged so the allowlist can be fixed from the Vercel logs.
    console.warn(`Blocked origin: ${origin ?? "(none)"}`);
    return { error: json({ error: "This origin is not allowed." }, 403, origin) };
  }

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBytes) {
    return { error: json({ error: "Request is too large." }, 413, origin) };
  }

  try {
    const text = await request.text();
    if (text.length > maxBytes) {
      return { error: json({ error: "Request is too large." }, 413, origin) };
    }
    return { body: JSON.parse(text) };
  } catch {
    return { error: json({ error: "Invalid JSON body." }, 400, origin) };
  }
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
