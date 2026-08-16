import { Ratelimit } from "@upstash/ratelimit";

import { redis } from "@/lib/redis";

export const chatRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, "1 m"),
  prefix: "knowledge-app:ratelimit:chat",
  analytics: true,
});

export const demoChatRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "1 m"),
  prefix: "knowledge-app:ratelimit:chat-demo",
  analytics: true,
});

export const ingestRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 h"),
  prefix: "knowledge-app:ratelimit:ingest",
  analytics: true,
});

export function getClientIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}
