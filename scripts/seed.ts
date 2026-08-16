import { ingestSource } from "@/lib/ingest";
import { DEMO_NAMESPACE } from "@/lib/namespace";
import { pineconeIndex } from "@/lib/pinecone";
import { redis, sourcesKey, type SourceRecord } from "@/lib/redis";

const DEMO_SOURCE_URLS = [
  "https://en.wikipedia.org/wiki/Retrieval-augmented_generation",
  "https://en.wikipedia.org/wiki/Vector_database",
  "https://en.wikipedia.org/wiki/Prompt_engineering",
];

async function clearDemoNamespace() {
  const existing = await redis.hgetall<Record<string, SourceRecord>>(sourcesKey(DEMO_NAMESPACE));

  if (!existing) return;

  for (const [id, record] of Object.entries(existing)) {
    const chunkIds = Array.from({ length: record.chunkCount }, (_, index) => `${id}::${index}`);
    if (chunkIds.length > 0) {
      await pineconeIndex.namespace(DEMO_NAMESPACE).deleteMany({ ids: chunkIds });
    }
  }

  await redis.del(sourcesKey(DEMO_NAMESPACE));
}

async function seed() {
  console.log(`Clearing existing "${DEMO_NAMESPACE}" namespace...`);
  await clearDemoNamespace();

  for (const websiteUrl of DEMO_SOURCE_URLS) {
    console.log(`Ingesting ${websiteUrl}...`);
    const result = await ingestSource({ namespace: DEMO_NAMESPACE, websiteUrl });
    console.log(`  -> ${result.chunks} chunks (source id ${result.id})`);
  }

  console.log("Done.");
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
