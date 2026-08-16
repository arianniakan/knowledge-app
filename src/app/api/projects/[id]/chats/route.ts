import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { listChats } from "@/lib/chat-history";
import { userNamespace } from "@/lib/namespace";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Sign in with GitHub to view chat history." }, { status: 401 });
  }

  const { id: projectId } = await params;
  const chats = await listChats(userNamespace(session.user.id), projectId);

  return NextResponse.json({ chats });
}
