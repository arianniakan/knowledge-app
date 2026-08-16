import * as cheerio from "cheerio";
import OpenAI from "openai";
import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript";
import { PDFParse } from "pdf-parse";

import { pineconeIndex } from "@/lib/pinecone";
import { redis, sourcesKey, type SourceRecord, type SourceType } from "@/lib/redis";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function chunkText(text: string, chunkSize = 1000) {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (!normalized) return [];

  if (normalized.length <= chunkSize) return [normalized];

  const chunks: string[] = [];

  for (let index = 0; index < normalized.length; index += chunkSize) {
    const chunk = normalized.slice(index, index + chunkSize).trim();
    if (chunk) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

async function extractWebsiteText(url: string) {
  let response: Response;

  try {
    response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
  } catch {
    throw new Error("Couldn't reach that website. Check the URL and try again.");
  }

  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      throw new Error(
        "This website is blocking automated access, so it can't be added as a source. Try a different site.",
      );
    }
    if (response.status === 404) {
      throw new Error("That page couldn't be found (404). Check the URL and try again.");
    }
    throw new Error(`Failed to fetch website: HTTP ${response.status}.`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  return $("body")
    .text()
    .replace(/\s+/g, " ")
    .trim();
}

async function extractPdfText(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  const parser = new PDFParse({ data: Buffer.from(arrayBuffer) });

  try {
    const result = await parser.getText();
    return result.text.replace(/\s+/g, " ").trim();
  } finally {
    await parser.destroy();
  }
}

async function extractYoutubeText(url: string) {
  let transcript: Awaited<ReturnType<typeof fetchTranscript>>;

  try {
    transcript = await fetchTranscript(url);
  } catch (error) {
    if (
      error instanceof YoutubeTranscriptDisabledError ||
      error instanceof YoutubeTranscriptNotAvailableError ||
      error instanceof YoutubeTranscriptNotAvailableLanguageError
    ) {
      throw new Error("This video doesn't have captions available, so a transcript can't be extracted.");
    }
    if (error instanceof YoutubeTranscriptVideoUnavailableError) {
      throw new Error("That YouTube video is unavailable or private.");
    }
    if (error instanceof YoutubeTranscriptTooManyRequestError) {
      throw new Error("YouTube is temporarily rate-limiting transcript requests. Try again in a bit.");
    }
    if (error instanceof YoutubeTranscriptError) {
      throw new Error("That doesn't look like a valid YouTube URL. Check the link and try again.");
    }
    throw new Error("Couldn't retrieve a transcript for that video. Try a different one.");
  }

  return transcript
    .map((entry) => entry.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export type IngestInput = {
  namespace: string;
  file?: File | null;
  websiteUrl?: string | null;
  youtubeUrl?: string | null;
};

export type IngestResult = {
  id: string;
  source: string;
  type: SourceType;
  chunks: number;
};

export async function ingestSource({
  namespace,
  file,
  websiteUrl,
  youtubeUrl,
}: IngestInput): Promise<IngestResult> {
  let sourceType: SourceType = "website";
  let sourceLabel = "source";
  let rawText = "";

  if (file) {
    sourceType = "pdf";
    sourceLabel = file.name;
    rawText = await extractPdfText(file);
  } else if (websiteUrl?.trim()) {
    sourceType = "website";
    sourceLabel = websiteUrl;
    rawText = await extractWebsiteText(websiteUrl);
  } else if (youtubeUrl?.trim()) {
    sourceType = "youtube";
    sourceLabel = youtubeUrl;
    rawText = await extractYoutubeText(youtubeUrl);
  } else {
    throw new Error("No valid PDF, website URL, or YouTube URL was provided.");
  }

  if (!rawText.trim()) {
    throw new Error("No text could be extracted from the provided source.");
  }

  const chunks = chunkText(rawText, 1000);
  const sourceId = crypto.randomUUID();

  const records = await Promise.all(
    chunks.map(async (chunk, index) => {
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: chunk,
      });

      const embedding = embeddingResponse.data[0]?.embedding ?? [];

      return {
        id: `${sourceId}::${index}`,
        values: embedding,
        metadata: {
          text: chunk,
          source: sourceLabel,
          type: sourceType,
          sourceId,
        },
      };
    }),
  );

  await pineconeIndex.namespace(namespace).upsert({ records });

  const sourceRecord: SourceRecord = {
    id: sourceId,
    label: sourceLabel,
    type: sourceType,
    chunkCount: chunks.length,
    createdAt: Date.now(),
  };

  await redis.hset(sourcesKey(namespace), { [sourceId]: JSON.stringify(sourceRecord) });

  return { id: sourceId, source: sourceLabel, type: sourceType, chunks: chunks.length };
}
