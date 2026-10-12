// Unstable entry point. The two implementation barrels are separate build entries so a consumer
// that imports caller-side names does not retain the server graph. Every name remains available
// from `@dvmkit/sdk/internal`; only the emitted module boundary changes.
export * from "./caller.js";
export * from "./server.js";
