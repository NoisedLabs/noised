// Solana libraries the app bundles (Anchor's instruction coder, the SPL token helpers, the SDK's swap builder)
// read the Node global `Buffer` when they build a transaction. Browsers have none, so a buy failed with
// "Buffer is not defined" in production while every test (which runs under Node) passed. Install the `buffer`
// package's implementation before any app module runs: main.tsx imports this file first.
import { Buffer } from "buffer";

const scope = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (typeof scope.Buffer === "undefined") scope.Buffer = Buffer;
