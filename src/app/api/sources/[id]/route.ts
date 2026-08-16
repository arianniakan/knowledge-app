import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { userNamespace } from "@/lib/namespace";
import { pineconeIndex } from "@/lib/pinecone";
import { removeSourceFromAllProjects } from "@/lib/projects";
import { redis, sourcesKey, type SourceRecord } from "@/lib/redis";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Sign in with GitHub to manage your sources." },
      { status: 401 },
    );
  }

  const namespace = userNamespace(session.user.id);
  const { id } = await params;

  const raw = await redis.hget<SourceRecord>(sourcesKey(namespace), id);

  if (!raw) {
    return NextResponse.json({ error: "Source not found." }, { status: 404 });
  }

  const chunkIds = Array.from({ length: raw.chunkCount }, (_, index) => `${id}::${index}`);

  await pineconeIndex.namespace(namespace).deleteMany({ ids: chunkIds });
  await redis.hdel(sourcesKey(namespace), id);
  await removeSourceFromAllProjects(namespace, id);

  return NextResponse.json({ success: true });
}
