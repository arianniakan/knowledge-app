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
