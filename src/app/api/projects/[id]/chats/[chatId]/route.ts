import type { UIMessage } from "ai";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { deleteChat, loadChatMessages, saveChat } from "@/lib/chat-history";
import { userNamespace } from "@/lib/namespace";

async function requireNamespace() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return userNamespace(session.user.id);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; chatId: string }> },
) {
  const namespace = await requireNamespace();
  if (!namespace) {
    return NextResponse.json({ error: "Sign in with GitHub to view chat history." }, { status: 401 });
  }

  const { id: projectId, chatId } = await params;
  const messages = await loadChatMessages(namespace, projectId, chatId);

  if (!messages) {
    return NextResponse.json({ error: "Chat not found." }, { status: 404 });
  }

  return NextResponse.json({ messages });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string; chatId: string }> },
) {
  const namespace = await requireNamespace();
  if (!namespace) {
    return NextResponse.json({ error: "Sign in with GitHub to save chat history." }, { status: 401 });
  }

  const { id: projectId, chatId } = await params;
  const { messages }: { messages: UIMessage[] } = await req.json();

  await saveChat(namespace, projectId, chatId, messages);

  return NextResponse.json({ success: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; chatId: string }> },
) {
  const namespace = await requireNamespace();
  if (!namespace) {
    return NextResponse.json({ error: "Sign in with GitHub to manage chat history." }, { status: 401 });
  }

  const { id: projectId, chatId } = await params;
  await deleteChat(namespace, projectId, chatId);

  return NextResponse.json({ success: true });
}
