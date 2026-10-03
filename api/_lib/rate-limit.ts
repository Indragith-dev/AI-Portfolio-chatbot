/**
 * Fixed-window rate limiter.
 *
 * Uses Upstash Redis over its REST API when UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN are set, so limits hold across instances. Without
 * them it falls back to memory, which is per instance and resets on cold starts.
 */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const memory = new Map<string, { count: number; resetAt: number }>();

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      return await upstashLimit(key, limit, windowSeconds);
    } catch (err) {
      // Never take the API down because Redis is unreachable.
      console.error("Upstash rate limit failed, using memory", err);
    }
  }
  return memoryLimit(key, limit, windowSeconds);
}

function memoryLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): RateLimitResult {
  const now = Date.now();
  let entry = memory.get(key);

  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowSeconds * 1000 };
    memory.set(key, entry);
  }
  entry.count++;

  // Keep the map from growing without bound on a long-lived instance.
  if (memory.size > 5000) {
    for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
  }

  return {
    allowed: entry.count <= limit,
    retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
  };
}

async function upstashLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const redisKey = `aira:rl:${key}`;
  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      ["INCR", redisKey],
      ["EXPIRE", redisKey, String(windowSeconds), "NX"],
      ["TTL", redisKey],
    ]),
  });
  if (!res.ok) throw new Error(`Upstash responded ${res.status}`);

  const [incr, , ttl] = (await res.json()) as { result: number }[];
  return {
    allowed: incr.result <= limit,
    retryAfterSeconds: ttl.result > 0 ? ttl.result : windowSeconds,
  };
}
