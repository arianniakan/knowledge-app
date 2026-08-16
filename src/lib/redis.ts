import { Redis } from "@upstash/redis";

export const redis = Redis.fromEnv();

export function sourcesKey(namespace: string) {
  return `knowledge-app:sources:${namespace}`;
}

export type SourceType = "pdf" | "website" | "youtube";

export type SourceRecord = {
  id: string;
  label: string;
  type: SourceType;
  chunkCount: number;
  createdAt: number;
};
