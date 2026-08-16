import { NextResponse } from "next/server";

import { resolveNamespace } from "@/lib/namespace";
import { redis, sourcesKey, type SourceRecord } from "@/lib/redis";

export async function GET() {
  const { namespace, isDemo } = await resolveNamespace();

  const entries = await redis.hgetall<Record<string, SourceRecord>>(sourcesKey(namespace));
  const sources = Object.values(entries ?? {}).sort((a, b) => a.createdAt - b.createdAt);

  return NextResponse.json({ sources, isDemo });
}
