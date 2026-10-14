/**
 * Where Noised's code lives, the packages developers install, and how anyone can check that what runs on Solana is
 * that code. Plain links only: the app fetches none of them (its CSP allows no third-party requests); each opens in a
 * new tab when clicked.
 */

/** The source code: every program, this app, the SDK, the MCP server and the crates (Apache-2.0). */
export const REPO_URL = "https://github.com/NoisedLabs/noised";

export interface DevTool {
  id: "sdk" | "agents" | "rust" | "source";
  label: string;
  title: string;
  text: string;
  /** What to paste into a terminal. */
  command: string;
  links: readonly { label: string; href: string }[];
}

/** "Build with Noised": what to install, in one line each. */
export const DEV_TOOLS: readonly DevTool[] = [
  {
    id: "sdk",
    label: "TypeScript",
    title: "SDK",
    text: "Check tokens, build launches, and use vaults and Shield from your own app.",
    command: "npm i @noisedlabs/sdk",
    links: [{ label: "npm", href: "https://www.npmjs.com/package/@noisedlabs/sdk" }],
  },
  {
    id: "agents",
    label: "AI agents",
    title: "MCP server",
    text: "Lets your AI agent read and check tokens and launches. It never signs. Works with LangGraph.",
    command: "npx -y @noisedlabs/mcp",
    links: [{ label: "npm", href: "https://www.npmjs.com/package/@noisedlabs/mcp" }],
  },
  {
    id: "rust",
    label: "Rust",
    title: "Crates",
    text: "The post-quantum signatures and launch rules the programs run on, for your own Rust code.",
    command: "cargo add noised-lmots",
    links: [
      { label: "noised-lmots", href: "https://crates.io/crates/noised-lmots" },
      { label: "noised-rules", href: "https://crates.io/crates/noised-rules" },
    ],
  },
  {
    id: "source",
    label: "Open source",
    title: "Source code",
    text: "Every program, this site and the tools, free to read, build and reuse.",
    command: `git clone ${REPO_URL}`,
    links: [{ label: "GitHub", href: REPO_URL }],
  },
];

/**
 * The five Noised programs on Solana mainnet. Each is a verified build: on 13 Oct 2026 OtterSec rebuilt every one from
 * the public source (commit e673175) and got exactly the program on chain (docs/MAINNET.md).
 */
export const VERIFIED_PROGRAMS = [
  { name: "Launchpad", id: "CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc" },
  { name: "Autopilot", id: "D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx" },
  { name: "Shield", id: "BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9" },
  { name: "Vault", id: "7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb" },
  { name: "Hook", id: "cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia" },
] as const;

/** When OtterSec verified the five builds. */
export const VERIFIED_ON = "13 Oct 2026";

/** OtterSec's public record of a program's verified build. */
export function verifiedBuildUrl(programId: string): string {
  return `https://verify.osec.io/status/${programId}`;
}

/** The program's page on Solana Explorer, on mainnet (where the verified builds run), whatever this build's network. */
export function mainnetExplorerUrl(programId: string): string {
  return `https://explorer.solana.com/address/${programId}`;
}

/** A program id, short: the first six and the last four characters. */
export function shortProgramId(programId: string): string {
  return programId.length > 12 ? `${programId.slice(0, 6)}…${programId.slice(-4)}` : programId;
}
