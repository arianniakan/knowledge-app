// pdfjs-dist also lazily loads its own worker script via a dynamically-computed
// path at parse time ("Setting up fake worker failed: Cannot find module
// .../pdf.worker.mjs"), which Vercel's file tracer can't detect since it's not
// a static import. Its own fallback checks globalThis.pdfjsWorker first, before
// attempting that dynamic import — so importing the worker module ourselves (a
// real static import, which the tracer *does* detect and bundle) and
// registering it there skips the broken path entirely.
// @ts-expect-error no type declarations ship for this internal worker entry point
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";

// @ts-expect-error pdfjsWorker is not a typed global — this is pdfjs-dist's
// documented Node.js integration point, not our own API surface.
globalThis.pdfjsWorker ??= pdfjsWorker;

// pdfjs-dist (used by pdf-parse) tries to require the optional native package
// "@napi-rs/canvas" at import time to polyfill DOMMatrix/ImageData/Path2D for
// PDF rendering. We only ever call getText() — never rendering — but pdfjs-dist
// still crashes with "ReferenceError: DOMMatrix is not defined" if that package
// isn't present, which it isn't in Vercel's deployed bundle (it's only reachable
// via a dynamic require() inside pdfjs-dist, so Next.js's file tracer never
// detects it as a real dependency to include). Pre-defining no-op stubs makes
// pdfjs-dist skip that code path entirely.
if (typeof globalThis.DOMMatrix === "undefined") {
  // @ts-expect-error minimal stub — pdf-parse's text extraction never renders
  globalThis.DOMMatrix = class DOMMatrix {};
}
if (typeof globalThis.ImageData === "undefined") {
  // @ts-expect-error minimal stub — pdf-parse's text extraction never renders
  globalThis.ImageData = class ImageData {};
}
if (typeof globalThis.Path2D === "undefined") {
  // @ts-expect-error minimal stub — pdf-parse's text extraction never renders
  globalThis.Path2D = class Path2D {};
}
