// Removes dist/ before a build so no stale file survives a rename.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

rmSync(fileURLToPath(new URL("../dist", import.meta.url)), { recursive: true, force: true });
