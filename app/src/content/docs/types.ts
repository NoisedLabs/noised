/**
 * Shapes of the generated reference data (generated/sdk.ts, generated/programs.ts, written by
 * scripts/gen-docs-reference.mjs) and of the docs navigation (nav.ts). Plain data: strings and numbers only.
 */

// ------------------------------------------------------------------ SDK ---

export type SdkKind = "function" | "const" | "class" | "interface" | "type" | "namespace";

export interface SdkMember {
  name: string;
  kind: SdkKind;
  signature: string;
  doc: string;
  deprecated: boolean;
}

export interface SdkEntry {
  name: string;
  kind: SdkKind;
  /** Source module, relative to sdk/src without the extension (e.g. "launch/builders"). */
  module: string;
  /** Reference section id (SdkReference.groups). */
  group: string;
  /** Declaration as written (bodies removed; one parameter per line when long). */
  signature: string;
  /** JSDoc of the declaration. Markdown-ish: `code`, **bold**, paragraphs. */
  doc: string;
  /** Integrator notes from sdk/README.md for this name (Markdown-ish), or "". */
  notes: string;
  deprecated: boolean;
  /** Exported as a type only (`import type`). */
  typeOnly: boolean;
  /** Members of a namespace export (`lmots`). */
  members: SdkMember[];
}

export interface SdkReference {
  packageName: string;
  version: string;
  groups: { id: string; title: string }[];
  entries: SdkEntry[];
}

// ------------------------------------------------------------- programs ---

export interface ProgramAccountMeta {
  index: number;
  name: string;
  /** Anchor account type with lifetimes removed (e.g. "Box<Account<Launch>>"). */
  type: string;
  signer: boolean;
  writable: boolean;
  optional: boolean;
  /** "init", "init_if_needed" or "". */
  init: string;
  /** Seeds for a PDA, readable form (e.g. ["\"launch\"", "creator", "launch_seed"]); [] when not a PDA. */
  seeds: string[];
  /** `seeds::program` when the PDA belongs to another program. */
  seedsProgram: string;
  /** The `#[account(...)]` constraints as written (whitespace collapsed). */
  constraints: string;
  docs: string;
}

export interface ProgramInstruction {
  name: string;
  /** Doc comment of the program function. */
  docs: string;
  /** Doc comment of its `handle_*` function, when the logic lives in instructions/<name>.rs. */
  handlerDocs: string;
  /** Source file of the handler (or of the accounts struct). */
  file: string;
  args: { name: string; type: string }[];
  accountsStruct: string;
  /** `#[instruction(...)]` arguments of the accounts struct, when it reads instruction data. */
  instructionAttr: string;
  /** A custom discriminator (`#[instruction(discriminator = ...)]`), e.g. the SPL transfer-hook `Execute`. */
  customDiscriminator: string;
  accounts: ProgramAccountMeta[];
}

export interface ProgramField {
  name: string;
  type: string;
  docs: string;
  maxLen?: string;
  /** Bytes (borsh / Anchor InitSpace) when computable. */
  size?: number;
}

export interface ProgramStateAccount {
  name: string;
  docs: string;
  file: string;
  /** Total bytes including the 8-byte discriminator, or null if not computable. */
  size: number | null;
  version?: string;
  fields: ProgramField[];
}

export interface ProgramType {
  name: string;
  kind: "struct" | "enum";
  docs: string;
  file: string;
  fields: ProgramField[];
}

export interface ProgramEvent {
  name: string;
  docs: string;
  file: string;
  fields: ProgramField[];
}

export interface ProgramError {
  code: number;
  name: string;
  msg: string;
  docs: string;
}

export interface ProgramPda {
  seeds: string[];
  /** Owning program when not this one (`seeds::program`). */
  program: string;
  /** Account names this PDA appears under in instructions. */
  names: string[];
  /** Other spellings of the same seeds in other instructions (e.g. "vault", mint, vault.genesis_key_id). */
  forms: string[];
  docs: string;
}

export interface ProgramConstant {
  /** Module path, e.g. "constants::MIN_OPEN_DELAY" or "constants::dbc::MIN_FEE_NUMERATOR". */
  path: string;
  type: string;
  value: string;
  docs: string;
}

export interface ProgramDoc {
  slug: string;
  crate: string;
  title: string;
  dir: string;
  programId: string;
  /** Crate-level docs (//! of lib.rs). */
  docs: string;
  instructions: ProgramInstruction[];
  accounts: ProgramStateAccount[];
  types: ProgramType[];
  events: ProgramEvent[];
  errorEnum: string;
  errors: ProgramError[];
  pdas: ProgramPda[];
  constants: ProgramConstant[];
}

// ------------------------------------------------------------ navigation ---

export interface DocHeading {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface DocPageMeta {
  /** Route under /docs ("" for the introduction). */
  slug: string;
  title: string;
  /** One sentence for the page header, search results and link cards. */
  summary: string;
  /** Section headings, in order: the "On this page" outline and the command palette index. */
  headings: DocHeading[];
  /** Shown as "Rolling out" in the sidebar: describes what lands in this release. */
  rollingOut?: boolean;
}

export interface DocSection {
  id: string;
  title: string;
  pages: DocPageMeta[];
}
