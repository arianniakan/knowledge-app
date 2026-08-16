import OpenAI from "openai";

import { pinecone, pineconeIndex } from "@/lib/pinecone";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const CANDIDATE_POOL_SIZE = 15;
const RERANK_MODEL = "pinecone-rerank-v0";

export type RetrievedChunk = {
  id: string;
  text: string;
  source: string;
  score: number;
};

export type RetrieveOptions = {
  topN?: number;
  /** Restrict retrieval to chunks from these source ids. An empty array means "no sources", not "all sources". */
  sourceIds?: string[];
};

export async function retrieve(
  query: string,
  namespace: string,
  options: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  const { topN = 3, sourceIds } = options;

  if (sourceIds && sourceIds.length === 0) {
    return [];
  }

  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });

  const queryVector = embeddingResponse.data[0]?.embedding ?? [];

  const queryResult = await pineconeIndex.namespace(namespace).query({
    topK: CANDIDATE_POOL_SIZE,
    vector: queryVector,
    includeMetadata: true,
    ...(sourceIds ? { filter: { sourceId: { $in: sourceIds } } } : {}),
  });

  const candidates = queryResult.matches
    .map((match) => ({
      id: match.id,
      text: (match.metadata?.text as string | undefined) ?? "",
      source: (match.metadata?.source as string | undefined) ?? "",
    }))
    .filter((candidate) => candidate.text);

  if (candidates.length === 0) {
    return [];
  }

  const rerankResult = await pinecone.inference.rerank({
    model: RERANK_MODEL,
    query,
    documents: candidates,
    topN: Math.min(topN, candidates.length),
    rankFields: ["text"],
  });

  return rerankResult.data.map((item) => ({
    ...candidates[item.index],
    score: item.score ?? 0,
  }));
}
