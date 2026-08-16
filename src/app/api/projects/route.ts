import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { userNamespace } from "@/lib/namespace";
import { createProject, getProject, listProjects, seedProjectFromDemo } from "@/lib/projects";
import { redis } from "@/lib/redis";

export async function GET() {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Sign in with GitHub to view projects." }, { status: 401 });
  }

  const projects = await listProjects(userNamespace(session.user.id));

  return NextResponse.json({ projects });
}

export async function POST(req: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Sign in with GitHub to create a project." }, { status: 401 });
  }

  const { name, seed }: { name?: string; seed?: boolean } = await req.json();

  if (!name?.trim()) {
    return NextResponse.json({ error: "A project name is required." }, { status: 400 });
  }

  const namespace = userNamespace(session.user.id);

  if (seed) {
    // Guard against concurrent "bootstrap my first project" requests (double effect
    // firing, a double-click, two tabs) racing each other into creating duplicates.
    const lockKey = `knowledge-app:bootstrap-lock:${namespace}`;
    const acquiredLock = await redis.set(lockKey, "1", { nx: true, ex: 30 });

    if (!acquiredLock) {
      const existing = await listProjects(namespace);
      if (existing.length > 0) {
        return NextResponse.json({ project: existing[0] });
      }
      // Rare: lock held but nothing created yet — fall through rather than stall the user.
    }
  }

  const project = await createProject(namespace, name);

  if (seed) {
    await seedProjectFromDemo(namespace, project.id);
  }

  const freshProject = seed ? ((await getProject(namespace, project.id)) ?? project) : project;

  return NextResponse.json({ project: freshProject });
}
