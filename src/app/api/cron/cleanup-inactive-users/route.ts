import { NextResponse } from "next/server";

import { deleteAllChatsForProject } from "@/lib/chat-history";
import { DEMO_NAMESPACE } from "@/lib/namespace";
import { pineconeIndex } from "@/lib/pinecone";
import { listProjects, projectsKey } from "@/lib/projects";
import { redis, sourcesKey } from "@/lib/redis";
import { forgetUser, getLastActive, listKnownNamespaces } from "@/lib/user-activity";

export const maxDuration = 60;

const INACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function cleanupNamespace(namespace: string) {
  const projects = await listProjects(namespace);
  await Promise.all(projects.map((project) => deleteAllChatsForProject(namespace, project.id)));

  await pineconeIndex.namespace(namespace).deleteAll();
  await redis.del(sourcesKey(namespace), projectsKey(namespace));
  await forgetUser(namespace);
}

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const namespaces = await listKnownNamespaces();
  const now = Date.now();
  const cleaned: string[] = [];
  const failed: string[] = [];

  for (const namespace of namespaces) {
    // Never touch the shared demo namespace — it isn't sign-in-tracked and
    // should never end up in this set, but this is cheap insurance either way.
    if (namespace === DEMO_NAMESPACE) continue;

    const lastActive = await getLastActive(namespace);
    const isStale = lastActive === null || now - lastActive > INACTIVITY_WINDOW_MS;
    if (!isStale) continue;

    try {
      await cleanupNamespace(namespace);
      cleaned.push(namespace);
    } catch (error) {
      console.error(`Failed to clean up inactive namespace ${namespace}:`, error);
      failed.push(namespace);
    }
  }

  return NextResponse.json({ checked: namespaces.length, cleaned: cleaned.length, failed });
}
