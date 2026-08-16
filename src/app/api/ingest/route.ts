import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { ingestSource } from "@/lib/ingest";
import { userNamespace } from "@/lib/namespace";
import { attachSource } from "@/lib/projects";
import { ingestRateLimiter } from "@/lib/ratelimit";

// Ingesting a full page (chunking + one embedding call per chunk) can take
// longer than the platform's default timeout for larger sources.
export const maxDuration = 60;

export async function POST(req: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Sign in with GitHub to add your own sources." },
      { status: 401 },
    );
  }

  const { success, reset } = await ingestRateLimiter.limit(session.user.id);

  if (!success) {
    const retryAfterMinutes = Math.max(1, Math.ceil((reset - Date.now()) / 60_000));
    return NextResponse.json(
      { error: `You've hit the ingestion limit. Try again in ${retryAfterMinutes}m.` },
      { status: 429 },
    );
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const websiteUrl =
      formData.get("websiteUrl") ||
      formData.get("website") ||
      formData.get("url");
    const youtubeUrl =
      formData.get("youtubeUrl") ||
      formData.get("youtube") ||
      formData.get("videoUrl");
    const projectId = formData.get("projectId");

    const namespace = userNamespace(session.user.id);

    const result = await ingestSource({
      namespace,
      file: file instanceof File ? file : null,
      websiteUrl: typeof websiteUrl === "string" ? websiteUrl : null,
      youtubeUrl: typeof youtubeUrl === "string" ? youtubeUrl : null,
    });

    if (typeof projectId === "string" && projectId) {
      await attachSource(namespace, projectId, result.id);
    }

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("Ingestion failed:", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Something went wrong while ingesting the source.",
      },
      { status: 500 },
    );
  }
}
