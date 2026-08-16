import type { UIMessage } from "ai";

import { redis } from "@/lib/redis";

export const CHAT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
export const MAX_CHATS_PER_PROJECT = 30;

export function chatIndexKey(namespace: string, projectId: string) {
  return `knowledge-app:chats:${namespace}:${projectId}`;
}

export function chatMessagesKey(namespace: string, projectId: string, chatId: string) {
  return `knowledge-app:chat-messages:${namespace}:${projectId}:${chatId}`;
}

export type ChatSummary = {
  id: string;
  title: string;
  updatedAt: number;
};

function deriveTitle(messages: UIMessage[]): string {
  const firstUserText = messages
    .find((message) => message.role === "user")
    ?.parts.find((part) => part.type === "text")?.text;

  if (!firstUserText?.trim()) return "New chat";

  const trimmed = firstUserText.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
}

export async function listChats(namespace: string, projectId: string): Promise<ChatSummary[]> {
  const entries = await redis.hgetall<Record<string, ChatSummary>>(
    chatIndexKey(namespace, projectId),
  );
  return Object.values(entries ?? {}).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadChatMessages(
  namespace: string,
  projectId: string,
  chatId: string,
): Promise<UIMessage[] | null> {
  return redis.get<UIMessage[]>(chatMessagesKey(namespace, projectId, chatId));
}

export async function deleteChat(namespace: string, projectId: string, chatId: string) {
  await redis.del(chatMessagesKey(namespace, projectId, chatId));
  await redis.hdel(chatIndexKey(namespace, projectId), chatId);
}

export async function deleteAllChatsForProject(namespace: string, projectId: string) {
  const chats = await listChats(namespace, projectId);
  await Promise.all(chats.map((chat) => deleteChat(namespace, projectId, chat.id)));
  await redis.del(chatIndexKey(namespace, projectId));
}

async function enforceChatCap(namespace: string, projectId: string) {
  const chats = await listChats(namespace, projectId);
  if (chats.length <= MAX_CHATS_PER_PROJECT) return;

  const excess = chats.slice(MAX_CHATS_PER_PROJECT);
  await Promise.all(excess.map((chat) => deleteChat(namespace, projectId, chat.id)));
}

export async function saveChat(
  namespace: string,
  projectId: string,
  chatId: string,
  messages: UIMessage[],
) {
  const summary: ChatSummary = {
    id: chatId,
    title: deriveTitle(messages),
    updatedAt: Date.now(),
  };

  await redis.set(chatMessagesKey(namespace, projectId, chatId), JSON.stringify(messages), {
    ex: CHAT_TTL_SECONDS,
  });
  await redis.hset(chatIndexKey(namespace, projectId), { [chatId]: JSON.stringify(summary) });
  await redis.hexpire(chatIndexKey(namespace, projectId), chatId, CHAT_TTL_SECONDS);

  await enforceChatCap(namespace, projectId);
}
