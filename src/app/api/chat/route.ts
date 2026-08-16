import { createOpenAI } from "@ai-sdk/openai";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

import { resolveNamespace } from "@/lib/namespace";
import { getProject } from "@/lib/projects";
import { retrieve, type RetrievedChunk } from "@/lib/rag";
import { chatRateLimiter, demoChatRateLimiter, getClientIp } from "@/lib/ratelimit";

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: Request) {
  const { messages, projectId }: { messages: UIMessage[]; projectId?: string } = await req.json();

  const latestMessage = [...messages].reverse().find((message) => message.role === "user");
  const latestText =
    latestMessage?.parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ") ?? "";

  const { namespace, isDemo, userId } = await resolveNamespace();

  const limiter = isDemo ? demoChatRateLimiter : chatRateLimiter;
  const identifier = userId ?? getClientIp(req);
  const { success, reset } = await limiter.limit(identifier);

  if (!success) {
    const retryAfterSeconds = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    return new Response(
      JSON.stringify({
        error: `You're sending messages too quickly. Try again in ${retryAfterSeconds}s.`,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfterSeconds),
        },
      },
    );
  }

  let sourceIds: string[] | undefined;

  if (!isDemo) {
    const project = projectId ? await getProject(namespace, projectId) : null;
    sourceIds = project?.sourceIds ?? [];
  }

  let chunks: RetrievedChunk[] = [];

  if (latestText.trim()) {
    try {
      chunks = await retrieve(latestText, namespace, { sourceIds });
    } catch (error) {
      console.error("Retrieval failed:", error);
    }
  }

  const contextText = chunks
    .map((chunk) => chunk.text)
    .join("\n\n")
    .trim();

  const instructions = `Answer the user based on this context: ${
    contextText || "No relevant context was found. Use general knowledge if needed."
  }`;

  const seenSources = new Set<string>();
  const sourceChunks: UIMessageChunk[] = [];

  for (const chunk of chunks) {
    if (!chunk.source || seenSources.has(chunk.source)) continue;
    seenSources.add(chunk.source);

    sourceChunks.push({
      type: "source-url",
      sourceId: chunk.id,
      url: chunk.source,
      title: chunk.source,
    });
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const result = streamText({
        model: openai("gpt-4o-mini"),
        messages: await convertToModelMessages(messages),
        instructions,
      });

      // Inject citation chunks right after the "start" chunk so they land in
      // the same assistant message instead of arriving before it exists.
      const withSources = result.toUIMessageStream().pipeThrough(
        new TransformStream<UIMessageChunk, UIMessageChunk>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            if (chunk.type === "start") {
              for (const sourceChunk of sourceChunks) {
                controller.enqueue(sourceChunk);
              }
            }
          },
        }),
      );

      writer.merge(withSources);
    },
  });

  return createUIMessageStreamResponse({ stream });
}
