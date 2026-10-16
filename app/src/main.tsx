// First: the browser has no Node `Buffer`, which the Solana libraries use when building transactions.
import "./polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import "./terminal.css";
// TEMP(dev-server dep cache repair): remove after the optimizer re-runs.
import "bs58";
import "buffer";
import "@noble/hashes/sha2.js";
// Before the app's modules: copies the Web Storage of the project's earlier name before any of them reads it (the
// rename to Noised).
import "./lib/legacyStorage";
import { App } from "./app/App";
import { applyInitialTheme } from "./app/settings";
import { prepareBoot } from "./fx/motion";
import { MotionRoot } from "./fx/MotionRoot";
import { installSoundUnlock } from "./fx/sfx";

function start(): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root element");
  // Clickjacking defense: a CSP delivered in a <meta> tag cannot carry
  // frame-ancestors, so the app refuses to run inside any frame.
  if (window.top !== window.self) {
    root.textContent = "Noised does not run inside a frame. Open it directly in its own tab.";
    return;
  }
  applyInitialTheme();
  // Decide before the first paint whether the once-per-session boot overlay runs (html[data-boot]).
  prepareBoot();
  // Sound effects start only after the first user gesture (and stay muted if the user muted them).
  installSoundUnlock();
  createRoot(root).render(
    <StrictMode>
      <MotionRoot>
        <App />
      </MotionRoot>
    </StrictMode>,
  );
}

start();
