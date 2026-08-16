import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { deleteAllChatsForProject } from "@/lib/chat-history";
import { userNamespace } from "@/lib/namespace";
import { attachSource, deleteProject, detachSource, getProject, renameProject } from "@/lib/projects";

async function requireNamespace() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return userNamespace(session.user.id);
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const namespace = await requireNamespace();
  if (!namespace) {
    return NextResponse.json({ error: "Sign in with GitHub to view this project." }, { status: 401 });
  }

  const { id } = await params;
  const project = await getProject(namespace, id);

  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  return NextResponse.json({ project });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const namespace = await requireNamespace();
  if (!namespace) {
    return NextResponse.json({ error: "Sign in with GitHub to manage this project." }, { status: 401 });
  }

  const { id } = await params;
  const body: { name?: string; addSourceId?: string; removeSourceId?: string } = await req.json();

  let project = null;

  if (body.name) {
    project = await renameProject(namespace, id, body.name);
  }
  if (body.addSourceId) {
    project = await attachSource(namespace, id, body.addSourceId);
  }
  if (body.removeSourceId) {
    project = await detachSource(namespace, id, body.removeSourceId);
  }

  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  return NextResponse.json({ project });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const namespace = await requireNamespace();
  if (!namespace) {
    return NextResponse.json({ error: "Sign in with GitHub to manage this project." }, { status: 401 });
  }

  const { id } = await params;

  await deleteAllChatsForProject(namespace, id);
  await deleteProject(namespace, id);

  return NextResponse.json({ success: true });
}
