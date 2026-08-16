import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

import { DEMO_NAMESPACE } from "@/lib/namespace";
import { retrieve } from "@/lib/rag";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

type EvalItem = {
  question: string;
  expectedSource: string;
  expectedAnswer: string;
};

type EvalResult = EvalItem & {
  retrievedSources: string[];
  retrievalHit: boolean;
  actualAnswer: string;
  judgeVerdict: "yes" | "no";
  retrievalMs: number;
  generationMs: number;
};

const datasetPath = path.join(import.meta.dirname, "eval-dataset.json");
const dataset: EvalItem[] = JSON.parse(readFileSync(datasetPath, "utf-8"));

async function judgeAnswer(question: string, expected: string, actual: string): Promise<"yes" | "no"> {
  const { text } = await generateText({
    model: openai("gpt-4o-mini"),
    prompt: `Question: ${question}\n\nExpected answer: ${expected}\n\nActual answer: ${actual}\n\nDoes the actual answer agree with the expected answer? Respond with only YES or NO.`,
  });

  return text.trim().toUpperCase().startsWith("Y") ? "yes" : "no";
}

async function runEval() {
  const results: EvalResult[] = [];

  for (const item of dataset) {
    const retrievalStart = Date.now();
    const chunks = await retrieve(item.question, DEMO_NAMESPACE);
    const retrievalMs = Date.now() - retrievalStart;

    const retrievedSources = [...new Set(chunks.map((chunk) => chunk.source))];
    const retrievalHit = retrievedSources.includes(item.expectedSource);

    const contextText = chunks
      .map((chunk) => chunk.text)
      .join("\n\n")
      .trim();
    const instructions = `Answer the user based on this context: ${
      contextText || "No relevant context was found. Use general knowledge if needed."
    }`;

    const generationStart = Date.now();
    const { text: actualAnswer } = await generateText({
      model: openai("gpt-4o-mini"),
      instructions,
      prompt: item.question,
    });
    const generationMs = Date.now() - generationStart;

    const judgeVerdict = await judgeAnswer(item.question, item.expectedAnswer, actualAnswer);

    results.push({
      ...item,
      retrievedSources,
      retrievalHit,
      actualAnswer,
      judgeVerdict,
      retrievalMs,
      generationMs,
    });

    console.log(
      `${retrievalHit ? "✓" : "✗"} retrieval  ${judgeVerdict === "yes" ? "✓" : "✗"} correctness  — ${item.question}`,
    );
  }

  const hits = results.filter((result) => result.retrievalHit).length;
  const correct = results.filter((result) => result.judgeVerdict === "yes").length;
  const avgRetrievalMs = results.reduce((sum, result) => sum + result.retrievalMs, 0) / results.length;
  const avgGenerationMs = results.reduce((sum, result) => sum + result.generationMs, 0) / results.length;

  const summary = {
    total: results.length,
    retrievalHitRate: Math.round((hits / results.length) * 100),
    correctnessRate: Math.round((correct / results.length) * 100),
    avgRetrievalMs: Math.round(avgRetrievalMs),
    avgGenerationMs: Math.round(avgGenerationMs),
  };

  console.log("\nSummary:");
  console.log(`  Retrieval hit-rate: ${summary.retrievalHitRate}% (${hits}/${results.length})`);
  console.log(`  Answer correctness: ${summary.correctnessRate}% (${correct}/${results.length})`);
  console.log(`  Avg retrieval latency: ${summary.avgRetrievalMs}ms`);
  console.log(`  Avg generation latency: ${summary.avgGenerationMs}ms`);

  const outputPath = path.join(import.meta.dirname, "..", "eval-results.json");
  writeFileSync(outputPath, JSON.stringify({ summary, results }, null, 2));
  console.log(`\nWrote ${outputPath}`);
}

runEval().catch((error) => {
  console.error(error);
  process.exit(1);
});
