# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev      # start dev server (Turbopack)
npm run build    # production build (also runs the TypeScript check)
npm run lint     # eslint
npm run seed     # (re)populate the shared "demo" namespace — clears it first, then re-ingests scripts/seed.ts's source list
npm run eval     # run the retrieval/answer-quality eval harness against the demo namespace, writes eval-results.json
```

There is no test suite/runner in this repo.

`npm run seed` and `npm run eval` run via `tsx` with `--env-file=.env.local` and use the `@/` path alias (resolved by tsx from `tsconfig.json`), so they don't need a build step.

## Architecture

RAG chat app (Next.js App Router). The core ideas that don't show up from reading any single file:

### Namespace = the tenancy boundary

Every piece of data (Pinecone vectors, Redis keys) is partitioned by a `namespace` string, resolved once per request in `src/lib/namespace.ts::resolveNamespace()`:
- Anonymous visitor → `"demo"` (shared, read-only, seeded by `npm run seed`)
- Signed-in user → `` `user:${session.user.id}` `` (GitHub account id from the JWT — there's no user database)

Every `src/lib/*.ts` data-access function takes `namespace` as an explicit parameter (`sourcesKey(namespace)`, `projectsKey(namespace)`, `chatIndexKey(namespace, projectId)`, `pineconeIndex.namespace(namespace)`, ...) rather than looking up auth state itself — this is what lets the exact same ingest/chat/retrieval code serve both the demo and every user without special-casing.

### Sources vs. Projects vs. Chats

These are three distinct, nested concepts — easy to conflate:
- **Sources** (`src/lib/redis.ts`, ingested via `src/lib/ingest.ts::ingestSource()`) are a flat per-namespace library of everything ever uploaded (PDF/website/YouTube), each chunked, embedded, and upserted into Pinecone with `sourceId` as explicit chunk metadata (needed because it's what retrieval filters on).
- **Projects** (`src/lib/projects.ts`) are named groups that reference a *subset* of a namespace's sources (`sourceIds: string[]`) — a source can belong to zero, one, or several projects without being re-ingested. Attaching/detaching a source from a project is just editing that array; deleting a source from the library also strips it out of every project that referenced it (`removeSourceFromAllProjects`).
- **Chats** (`src/lib/chat-history.ts`) belong to a project, not directly to a user — keys are `` `knowledge-app:chat*:${namespace}:${projectId}:...` ``. Deleting a project cascades to delete its chats but never touches the underlying sources.
- Signed-in users only: a brand-new user (zero projects) gets a project auto-created and seeded with a copy of the demo sources (`seedProjectFromDemo` in `src/lib/projects.ts`) — this copies Pinecone vectors directly via `fetch`/`upsert` rather than re-embedding, and is guarded by a Redis `SET NX EX` lock in `POST /api/projects` so a StrictMode double-effect or a double-click can't create duplicate "first" projects.
- Anonymous visitors don't have projects at all — the demo is a single, flat, read-only source list.

### Retrieval pipeline (`src/lib/rag.ts::retrieve()`)

Embed the query → Pinecone query (`topK: 15`, optionally `filter: { sourceId: { $in: sourceIds } }` when scoped to a project) → Pinecone's hosted `pinecone-rerank-v0` model reranks those 15 down to the real top 3 → the chat route (`src/app/api/chat/route.ts`) builds the system context from those chunks and separately writes them as `source-url` UI message parts (via `createUIMessageStream`, merged in *after* the stream's `start` chunk so they land in the same assistant message — merging before `start` puts them in a phantom empty message). The client renders those parts as citation chips, independent of the answer text.

### Chat persistence is two entirely different mechanisms

- **Signed-in**: server-side in Redis, scoped to `(namespace, projectId, chatId)`, 7-day TTL refreshed on every save (`HEXPIRE`/`EX`), capped at 30 chats per project (oldest evicted). Routes: `src/app/api/projects/[id]/chats/` and `.../[chatId]/`.
- **Anonymous**: client-side only, a single conversation in `localStorage` (`knowledge-app:guest-chat`) — never touches the server, so one demo visitor's chat is never visible to another.

`src/app/page.tsx` is a single large client component that branches on `useSession()` status for almost everything (which sidebar view, which persistence path, whether ingest controls are enabled) — it's the one file where both tenancy paths are visible side by side.

### Auth

Auth.js v5 (beta) with the GitHub provider, JWT session strategy, no database — see `src/auth.ts`. `session.user.id` (the GitHub account id) is the only per-user identity used anywhere (via `userNamespace()`).

### Rate limiting

`src/lib/ratelimit.ts` — sliding-window limits via `@upstash/ratelimit` on the same Redis instance used for everything else. Anonymous chat traffic is limited more tightly than signed-in traffic; ingestion is signed-in-only and limited per user.

## Known limitations (don't re-litigate these — they're accepted trade-offs)

- Server-side `fetch` can't ingest sites behind bot protection (e.g. Cloudflare-fronted wikis) — a real fix needs a headless browser, out of scope.
- PDF text extraction (`pdf-parse`/`pdfjs-dist`) doesn't reliably preserve glyph order for RTL scripts (Arabic, Persian, Hebrew) — text extracts without error but is unusable for retrieval. Needs a bidi-aware or OCR-based extractor to fix properly.
- YouTube transcript fetching (`youtube-transcript`) scrapes YouTube's undocumented endpoints, which sometimes serve a reduced page (missing caption data) to datacenter/cloud IPs like Vercel's even when the video genuinely has captions — indistinguishable on our end from "no captions," so the error message is deliberately non-committal rather than asserting the video has none. A real fix needs the official (quota-limited, OAuth-gated) YouTube Data API, out of scope.
- `src/lib/pdf-polyfills.ts` exists because `pdfjs-dist` (a `pdf-parse` dependency) does two things Vercel's serverless file tracer can't detect: (1) requires the optional native `@napi-rs/canvas` package at import time to polyfill `DOMMatrix`/`ImageData`/`Path2D`, and (2) dynamically imports its own worker script (`pdf.worker.mjs`) by a runtime-computed path. Both crash on Vercel (not locally, since `@napi-rs/canvas` happens to be present there transitively) because neither file makes it into the deployed bundle. Fixed by pre-defining no-op polyfill stubs (we only call `getText()`, never rendering) and statically importing the worker module ourselves so pdfjs-dist's own `globalThis.pdfjsWorker` check finds it before attempting the broken dynamic import. Don't remove this file or reorder its import in `ingest.ts` (it must run before `pdf-parse` is imported).

## Environment variables

`OPENAI_API_KEY`, `PINECONE_API_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` — see `README.md` for where to get each and full local setup steps. The Pinecone index must be named `knowledge-app`, dimension `1536`, metric `cosine`.
