/**
 * Where the parity vectors live. The SDK keeps its own copies of the crate's
 * `crates/noised-rules/tests/vectors/*.json` in `test/vectors/programmable`
 * (SDK tests never read outside sdk/). `vectors.test.ts` pins the SHA-256 of
 * each copy (`VECTOR_SHA256`): when the crate's vectors change, copy the new
 * files and update the pins together. `$NOISED_RULES_VECTORS` points the
 * tests at another directory (opt-in, for a crate checkout).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const VECTOR_FILES = ["rules.json", "graph.json", "differential.json"] as const;
export type VectorFile = (typeof VECTOR_FILES)[number];

/** The SDK's copies. */
export const LOCAL_VECTORS_DIR = fileURLToPath(new URL("../vectors/programmable/", import.meta.url));

/**
 * SHA-256 (hex) of each copy with LF line endings: the files copied from
 * crates/noised-rules/tests/vectors when the module was merged (0.6.0).
 */
export const VECTOR_SHA256: Readonly<Record<VectorFile, string>> = {
  "rules.json": "bff3bf6337a49a0fe99e6cfbe6cd3d204e5290656f276c66f044de88007e96f8",
  "graph.json": "f0f9d9dc7c90c8cf257921cd8f462cd8465b1efb9a3232978fc7a7de2b9bb406",
  "differential.json": "47eb405652f11f908578d9e18648a18706eb5ef588e76f6fd7fa961348a2689c",
};

/** The directory the tests read: $NOISED_RULES_VECTORS, else the SDK's copies. */
export const VECTORS_DIR: string = process.env["NOISED_RULES_VECTORS"] ?? process.env["PHALANX_RULES_VECTORS"] ?? LOCAL_VECTORS_DIR;

/** File text with LF line endings (a Windows checkout may convert them). */
export const readVectorText = (dir: string, f: VectorFile): string => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n");

/* eslint-disable @typescript-eslint/no-explicit-any */
export const loadVectors = (f: VectorFile): any => JSON.parse(readVectorText(VECTORS_DIR, f));
