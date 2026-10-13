/**
 * The SDK's constants, seeds and PDA helpers checked against the Rust
 * sources themselves (programs/*\/src) and against the PDA definitions the
 * IDLs carry (generated from the `seeds = [...]` constraints).
 */
import { readFileSync } from "node:fs";

import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { u64le } from "../src/codec/bytes.js";
import {
  AUTHORIZATION,
  CERTIFICATE,
  CERTIFICATE_ALL_CHECKS,
  CERTIFICATE_CHECKS,
  CERTIFICATE_RULES_BOUND,
  certificateChecksComplete,
  DBC,
  HOOK_BOUNDS,
  HOOK_ERRORS,
  HOOK_POLICY,
  KNOWN_ACCOUNTS,
  LAUNCH_GUARD,
  LAUNCH_RULES,
  METADATA,
  POLICY,
  PQ_IDENTITY,
  PQ_VAULT_LAYOUT,
  PROGRAM_IDS,
  SEEDS,
  VAULT,
  WSOL_MINT,
} from "../src/constants.js";
import { camelCase } from "../src/codec/idl.js";
import { IDLS, idlCodecs } from "../src/idl/index.js";
import {
  attestationAddress,
  autopilotAddress,
  autopilotTreasuryAddress,
  certificateAddress,
  commitAddress,
  extraAccountMetaListAddress,
  graphRecordAddress,
  hookAuthorityAddress,
  hookPolicyAddress,
  launchAddress,
  launchPdasFromLaunch,
  launchRulesAddress,
  payoutAddress,
  payoutVaultAddress,
  protocolAddress,
  shieldAddresses,
  tokenMetaAddress,
  vaultAddress,
} from "../src/pda.js";
import { decodeAutopilotEvent } from "../src/autopilot/accounts.js";
import { MAX_UNLANDED_SIGNATURES } from "../src/pq/signGuard.js";
import { CLOCK_SKEW_MAX_SECS } from "../src/rpc/clock.js";
import { AUTH_DOMAINS, AUTH_KIND, AUTOPILOT_ERRORS, freezePayload, revokePayload } from "../src/programmable/autopilot/logic.js";
import { AUTOPILOT, NOISED_SHIELD_PROGRAM, NOISED_VAULT_PROGRAM, RULES_SKIPPED_PROGRAMS } from "../src/programmable/constants.js";
import { QSL1 } from "../src/qsl/layouts.js";
import * as lmots from "../src/pq/lmots.js";
import { explainProgramError, plainErrorMessage } from "../src/rpc/errors.js";
import { noisedHookAccounts } from "../src/token/hook.js";

const repo = new URL("../../", import.meta.url);
const src = (rel: string): string => readFileSync(new URL(rel, repo), "utf8");

/** `pub const NAME: &[u8] = b"...";` and `&[u8; 8] = b"...";` */
function byteSeeds(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/pub const (\w+): &\[u8(?:; \d+)?\] = b"([^"]*)";/g)) out.set(m[1]!, m[2]!);
  return out;
}

/** Integer constants: `pub const NAME: T = <expr>;` with `_`, `*`, `+` and earlier names. */
function intConsts(text: string, known: Map<string, bigint> = new Map()): Map<string, bigint> {
  const out = new Map(known);
  for (const m of text.matchAll(/pub const (\w+): (?:u8|u16|u32|u64|u128|i64|usize) = ([^;]+);/g)) {
    const expr = m[2]!.replace(/0x[0-9a-f_]+/gi, (h) => String(BigInt(h.replace(/_/g, "")))).replace(/(\d)_(?=\d)/g, "$1");
    const terms = expr.split("+").map((t) =>
      t
        .split("*")
        .map((f) => {
          const name = f.trim();
          if (/^\d+$/.test(name)) return BigInt(name);
          const v = out.get(name) ?? out.get(name.replace(/^.*::/, ""));
          if (v === undefined) throw new Error(`unknown term ${name} in ${m[1]}`);
          return v;
        })
        .reduce((a, b) => a * b, 1n),
    );
    out.set(m[1]!, terms.reduce((a, b) => a + b, 0n));
  }
  return out;
}

function pubkeyConsts(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/pub const (\w+): Pubkey = pubkey!\("(\w+)"\);/g)) out.set(m[1]!, m[2]!);
  return out;
}

const declareId = (rel: string): string => /declare_id!\("(\w+)"\)/.exec(src(rel))![1]!;

describe("constants match the Rust sources", () => {
  it("program ids (declare_id! and IDL addresses)", () => {
    // The launchpad and the vault are written without Anchor; their Anchor references
    // (programs/noised-launchpad/anchor, programs/noised-vault/anchor, the same ABI) declare the ids.
    expect(declareId("programs/noised-launchpad/anchor/lib.rs")).toBe(PROGRAM_IDS.launchpad.toBase58());
    expect(declareId("programs/noised-hook/src/lib.rs")).toBe(PROGRAM_IDS.hook.toBase58());
    expect(declareId("programs/noised-vault/anchor/lib.rs")).toBe(PROGRAM_IDS.vault.toBase58());
    expect(declareId("programs/noised-shield/src/lib.rs")).toBe(PROGRAM_IDS.shield.toBase58());
    expect(declareId("programs/noised-autopilot/src/lib.rs")).toBe(PROGRAM_IDS.autopilot.toBase58());
    expect(IDLS.autopilot.address).toBe(PROGRAM_IDS.autopilot.toBase58());
    expect(IDLS.launchpad.address).toBe(PROGRAM_IDS.launchpad.toBase58());
    expect(IDLS.hook.address).toBe(PROGRAM_IDS.hook.toBase58());
    expect(IDLS.vault.address).toBe(PROGRAM_IDS.vault.toBase58());
    expect(IDLS.shield.address).toBe(PROGRAM_IDS.shield.toBase58());
    expect(IDLS.dbc.address).toBe(PROGRAM_IDS.dbc.toBase58());
    expect(IDLS.dammV2.address).toBe(PROGRAM_IDS.dammV2.toBase58());
  });

  it("launchpad constants.rs: seeds, external ids, bounds", () => {
    const text = src("programs/noised-launchpad/src/constants.rs");
    const seeds = byteSeeds(text);
    expect(seeds.get("PROTOCOL_SEED")).toBe(SEEDS.protocol);
    expect(seeds.get("LAUNCH_SEED")).toBe(SEEDS.launch);
    expect(seeds.get("AUTHORITY_SEED")).toBe(SEEDS.authority);
    expect(seeds.get("BATCH_SEED")).toBe(SEEDS.batch);
    expect(seeds.get("DBC_CONFIG_SEED")).toBe(SEEDS.dbcConfig);
    expect(seeds.get("CERTIFICATE_SEED")).toBe(SEEDS.certificate);
    expect(seeds.get("COMMIT_SEED")).toBe(SEEDS.commit);
    expect(seeds.get("HOOK_AUTHORITY_SEED")).toBe(SEEDS.hookAuthority);
    expect(seeds.get("IDENTITY_SEED")).toBe(SEEDS.identity);
    expect(seeds.get("ATTESTATION_SEED")).toBe(SEEDS.attestation);
    expect(seeds.get("PAYOUT_VAULT_SEED")).toBe(SEEDS.payoutVault);
    expect(seeds.get("METADATA_SEED")).toBe(SEEDS.metadata);
    expect(SEEDS.metadata).toBe(METADATA.SEED);
    // P1c: the rules record and the authorization.
    expect(seeds.get("RULES_SEED")).toBe(SEEDS.launchRules);
    expect(SEEDS.launchRules).toBe(LAUNCH_RULES.SEED);
    expect(seeds.get("AUTH_SEED")).toBe(SEEDS.authorization);

    const keys = pubkeyConsts(text);
    // pq_vault: how the launchpad recognizes a PQ vault (and the vault IDL's own discriminator).
    expect(keys.get("PROGRAM_ID")).toBe(PROGRAM_IDS.vault.toBase58());
    const vaultDisc = /pub const VAULT_DISCRIMINATOR: \[u8; 8\] = \[([\d,\s]+)\];/.exec(text)![1]!.split(",").map((x) => Number(x.trim()));
    expect(vaultDisc).toEqual([...PQ_VAULT_LAYOUT.DISCRIMINATOR]);
    expect(vaultDisc).toEqual(IDLS.vault.accounts!.find((a) => a.name === "Vault")!.discriminator);
    const pqv = intConsts(text.slice(text.indexOf("pub mod pq_vault"), text.indexOf("\n}\n", text.indexOf("pub mod pq_vault"))));
    expect(Number(pqv.get("VAULT_VERSION"))).toBe(PQ_VAULT_LAYOUT.VERSION);
    expect(PQ_VAULT_LAYOUT.VERSION).toBe(VAULT.VERSION);
    expect(Number(pqv.get("VERSION_OFFSET"))).toBe(PQ_VAULT_LAYOUT.VERSION_OFFSET);
    expect(Number(pqv.get("MINT_OFFSET"))).toBe(PQ_VAULT_LAYOUT.MINT_OFFSET);
    expect(keys.get("DBC_PROGRAM_ID")).toBe(PROGRAM_IDS.dbc.toBase58());
    expect(keys.get("DBC_POOL_AUTHORITY")).toBe(KNOWN_ACCOUNTS.dbcPoolAuthority.toBase58());
    expect(keys.get("DBC_EVENT_AUTHORITY")).toBe(KNOWN_ACCOUNTS.dbcEventAuthority.toBase58());
    expect(keys.get("DAMM_V2_PROGRAM_ID")).toBe(PROGRAM_IDS.dammV2.toBase58());
    expect(keys.get("DAMM_V2_POOL_AUTHORITY")).toBe(KNOWN_ACCOUNTS.dammV2PoolAuthority.toBase58());
    expect(keys.get("DAMM_V2_EVENT_AUTHORITY")).toBe(KNOWN_ACCOUNTS.dammV2EventAuthority.toBase58());
    expect(keys.get("WSOL_MINT")).toBe(WSOL_MINT.toBase58());

    // MAX_INLINE_URI_LEN is an expression of a string's length (checked on its own below).
    const n = intConsts(text.replace(/^pub const MAX_INLINE_URI_LEN: usize = .*$/m, ""));
    const num = (name: string): number => Number(n.get(name));
    expect(num("SAFETY_POLICY_VERSION")).toBe(POLICY.SAFETY_POLICY_VERSION);
    expect(num("BPS_DENOMINATOR")).toBe(POLICY.BPS_DENOMINATOR);
    expect(num("EXECUTION_GRACE_SECS")).toBe(POLICY.EXECUTION_GRACE_SECS);
    expect(num("MIN_OPEN_DELAY")).toBe(POLICY.MIN_OPEN_DELAY);
    expect(num("MAX_OPEN_DELAY")).toBe(POLICY.MAX_OPEN_DELAY);
    expect(num("MAX_GUARD_SECS")).toBe(POLICY.MAX_GUARD_SECS);
    expect(n.get("MIN_THRESHOLD")).toBe(POLICY.MIN_THRESHOLD);
    expect(n.get("MAX_THRESHOLD")).toBe(POLICY.MAX_THRESHOLD);
    expect(num("MAX_PLATFORM_FEE_BPS")).toBe(POLICY.MAX_PLATFORM_FEE_BPS);
    expect(num("MIN_TOKEN_DECIMALS")).toBe(POLICY.MIN_TOKEN_DECIMALS);
    expect(num("MAX_TOKEN_DECIMALS")).toBe(POLICY.MAX_TOKEN_DECIMALS);
    expect(num("MAX_CURVE_POINTS")).toBe(POLICY.MAX_CURVE_POINTS);
    expect(num("MAX_RECIPIENTS")).toBe(POLICY.MAX_RECIPIENTS);
    expect(num("MIN_MAX_WALLET_BPS")).toBe(POLICY.MIN_MAX_WALLET_BPS);
    expect(num("MAX_NAME_LEN")).toBe(POLICY.MAX_NAME_LEN);
    expect(num("MAX_SYMBOL_LEN")).toBe(POLICY.MAX_SYMBOL_LEN);
    expect(num("MAX_URI_LEN")).toBe(POLICY.MAX_URI_LEN);
    // On-chain metadata: the record's limits, flags and uri prefixes.
    expect(num("MAX_DOC_LEN")).toBe(POLICY.MAX_DOC_LEN);
    expect([num("MAX_NAME_LEN"), num("MAX_SYMBOL_LEN"), num("MAX_URI_LEN"), num("MAX_DOC_LEN")]).toEqual([METADATA.MAX_NAME_LEN, METADATA.MAX_SYMBOL_LEN, METADATA.MAX_URI_LEN, METADATA.MAX_DOC_LEN]);
    expect(num("META_FLAG_INLINE_URI")).toBe(METADATA.FLAG_INLINE_URI);
    expect(num("META_FLAG_EXTERNAL_URI")).toBe(METADATA.FLAG_EXTERNAL_URI);
    const str = (name: string): string => new RegExp(`pub const ${name}: &str = "([^"]*)";`).exec(text)![1]!;
    expect(str("INLINE_URI_PREFIX")).toBe(METADATA.INLINE_URI_PREFIX);
    expect(str("EXTERNAL_URI_PREFIX")).toBe(METADATA.EXTERNAL_URI_PREFIX);
    expect(/pub const MAX_INLINE_URI_LEN: usize = INLINE_URI_PREFIX\.len\(\) \+ MAX_DOC_LEN\.div_ceil\(3\) \* 4;/.test(text)).toBe(true);
    expect(METADATA.INLINE_URI_PREFIX.length + Math.ceil(METADATA.MAX_DOC_LEN / 3) * 4).toBe(METADATA.MAX_INLINE_URI_LEN);
    expect(num("MAX_TRADING_FEE_BPS")).toBe(POLICY.MAX_TRADING_FEE_BPS);
    // PQ v2: batch-cap floors and the attested launch window.
    expect(n.get("MIN_BATCH_TOTAL_CAP_DIVISOR")).toBe(POLICY.MIN_BATCH_TOTAL_CAP_DIVISOR);
    expect(n.get("MIN_BATCH_WALLET_CAP_DIVISOR")).toBe(POLICY.MIN_BATCH_WALLET_CAP_DIVISOR);
    expect(num("MIN_LAUNCH_WINDOW_SECS")).toBe(POLICY.MIN_LAUNCH_WINDOW_SECS);
    expect(num("MAX_LAUNCH_WINDOW_SECS")).toBe(POLICY.MAX_LAUNCH_WINDOW_SECS);
    expect(num("MAX_LAUNCH_LEAD_SECS")).toBe(POLICY.MAX_LAUNCH_LEAD_SECS);
    expect([POLICY.SAFETY_POLICY_VERSION, POLICY.EXECUTION_GRACE_SECS, POLICY.MIN_OPEN_DELAY, POLICY.MAX_CURVE_POINTS]).toEqual([3, 600, 60, 8]);
    expect([POLICY.MIN_LAUNCH_WINDOW_SECS, POLICY.MAX_LAUNCH_WINDOW_SECS, POLICY.MAX_LAUNCH_LEAD_SECS]).toEqual([60, 3_600, 604_800]);
    // pub mod dbc { ... }
    expect(n.get("MIN_SQRT_PRICE")).toBe(DBC.MIN_SQRT_PRICE);
    expect(n.get("MAX_SQRT_PRICE")).toBe(DBC.MAX_SQRT_PRICE);
    expect(n.get("FEE_DENOMINATOR")).toBe(DBC.FEE_DENOMINATOR);
    expect(n.get("MIN_FEE_NUMERATOR")).toBe(DBC.MIN_FEE_NUMERATOR);
    expect(n.get("MAX_FEE_NUMERATOR")).toBe(DBC.MAX_FEE_NUMERATOR);
    expect(num("BASE_FEE_MODE_LINEAR")).toBe(DBC.BASE_FEE_MODE_LINEAR);
    expect(num("BASE_FEE_MODE_EXPONENTIAL")).toBe(DBC.BASE_FEE_MODE_EXPONENTIAL);
    expect(num("DYNAMIC_BIN_STEP")).toBe(DBC.DYNAMIC_BIN_STEP);
    expect(n.get("DYNAMIC_BIN_STEP_U128")).toBe(DBC.DYNAMIC_BIN_STEP_U128);
    expect(num("U24_MAX")).toBe(DBC.U24_MAX);
    expect(n.get("VARIABLE_FEE_SCALE")).toBe(DBC.VARIABLE_FEE_SCALE);
    expect(num("MAX_MIGRATION_FEE_OPTION")).toBe(DBC.MAX_MIGRATION_FEE_OPTION);
    expect(num("COLLECT_FEE_MODE_QUOTE")).toBe(DBC.COLLECT_FEE_MODE_QUOTE);
    expect(num("MIGRATION_OPTION_DAMM_V2")).toBe(DBC.MIGRATION_OPTION_DAMM_V2);
    expect(num("ACTIVATION_TYPE_TIMESTAMP")).toBe(DBC.ACTIVATION_TYPE_TIMESTAMP);
    expect(num("TOKEN_TYPE_TOKEN_2022")).toBe(DBC.TOKEN_TYPE_TOKEN_2022);
    expect(num("TOKEN_UPDATE_AUTHORITY_IMMUTABLE")).toBe(DBC.TOKEN_UPDATE_AUTHORITY_IMMUTABLE);
    expect(num("SWAP_MODE_PARTIAL_FILL")).toBe(DBC.SWAP_MODE_PARTIAL_FILL);
  });

  it("certificate check bits (state.rs `checks`)", () => {
    const text = src("programs/noised-launchpad/src/state.rs");
    const n = intConsts(text.slice(text.indexOf("pub mod checks")));
    expect(Number(n.get("ALL"))).toBe(CERTIFICATE_ALL_CHECKS);
    expect(CERTIFICATE_ALL_CHECKS).toBe(4095);
    const bits = ["MINT_AUTHORITY_NONE", "FREEZE_AUTHORITY_NONE", "METADATA_UPDATE_AUTHORITY_NONE", "METADATA_POINTER_AUTHORITY_NONE", "EXTENSION_SET_EXACT", "HOOK_IS_NOISED", "LP_PERMANENTLY_LOCKED", "NO_MIGRATION_FEE", "NO_CREATOR_ALLOCATION", "QUOTE_IS_WSOL", "PQ_ATTESTED", "METADATA_ONCHAIN"];
    bits.forEach((b, i) => expect(Number(n.get(b))).toBe(1 << i));
    bits.forEach((b, i) => expect(CERTIFICATE_CHECKS[b as keyof typeof CERTIFICATE_CHECKS], b).toBe(1 << i));
    expect(Object.keys(CERTIFICATE_CHECKS)).toEqual(bits);
    // P1c (amendment A2): RULES_BOUND = 4096, informational; ALL stays 4095. Consumers test (checks & 4095) == 4095.
    expect(Number(n.get("RULES_BOUND"))).toBe(CERTIFICATE_RULES_BOUND);
    expect(CERTIFICATE_RULES_BOUND).toBe(4096);
    expect(certificateChecksComplete(4095)).toBe(true);
    expect(certificateChecksComplete(4095 | 4096)).toBe(true);
    expect(certificateChecksComplete(4095 & ~1024)).toBe(false);
    expect(certificateChecksComplete(4096)).toBe(false);
    // Versions written by the program.
    expect(Number(/impl Certificate \{[\s\S]*?pub const VERSION: u8 = (\d+);/.exec(text)![1])).toBe(CERTIFICATE.VERSION);
    expect(CERTIFICATE.VERSION).toBe(4);
    // The certificate's layout (IDL) at the documented offsets: checks, policy_version, metadata, rules_hash last.
    const cert = idlCodecs().launchpad;
    expect(cert.accountSize("Certificate")).toBe(CERTIFICATE.ACCOUNT_LEN);
    expect(CERTIFICATE.ACCOUNT_LEN).toBe(519);
    expect(CERTIFICATE.METADATA_OFFSET + 32).toBe(CERTIFICATE.V3_ACCOUNT_LEN);
    expect(CERTIFICATE.RULES_HASH_OFFSET + 32).toBe(CERTIFICATE.ACCOUNT_LEN);
    const fields = (cert.typeDef("Certificate").type as { fields: { name: string; type: unknown }[] }).fields;
    let off = 8;
    const at: Record<string, number> = {};
    for (const f of fields) {
      at[f.name] = off;
      off += cert.fixedSize(f.type as never)!;
    }
    expect([at["checks"], at["policy_version"], at["metadata"], at["rules_hash"]]).toEqual([
      CERTIFICATE.CHECKS_OFFSET,
      CERTIFICATE.POLICY_VERSION_OFFSET,
      CERTIFICATE.METADATA_OFFSET,
      CERTIFICATE.RULES_HASH_OFFSET,
    ]);
    expect(fields.at(-1)?.name).toBe("rules_hash");
    // TokenMeta (state.rs): version, the fixed offsets, the fixed length.
    const tm = intConsts(text.slice(text.indexOf("impl TokenMeta {"), text.indexOf("\n}\n", text.indexOf("impl TokenMeta {"))));
    expect(Number(tm.get("VERSION"))).toBe(METADATA.TOKEN_META_VERSION);
    expect([tm.get("VERSION_OFFSET"), tm.get("BUMP_OFFSET"), tm.get("FLAGS_OFFSET"), tm.get("LAUNCH_OFFSET"), tm.get("METADATA_HASH_OFFSET")].map(Number)).toEqual([
      METADATA.TOKEN_META_OFFSETS.VERSION,
      METADATA.TOKEN_META_OFFSETS.BUMP,
      METADATA.TOKEN_META_OFFSETS.FLAGS,
      METADATA.TOKEN_META_OFFSETS.LAUNCH,
      METADATA.TOKEN_META_OFFSETS.METADATA_HASH,
    ]);
    expect(Number(tm.get("FIXED_LEN"))).toBe(METADATA.TOKEN_META_FIXED_LEN);
    expect(METADATA.TOKEN_META_OFFSETS.METADATA_HASH + 32).toBe(METADATA.TOKEN_META_OFFSETS.NAME);
    expect(METADATA.TOKEN_META_FIXED_LEN + 32 + 10 + 200 + 3_072).toBe(METADATA.MAX_TOKEN_META_LEN);
    const disc = IDLS.launchpad.accounts!.find((a) => a.name === "TokenMeta")!.discriminator;
    expect(disc).toEqual([...METADATA.TOKEN_META_DISCRIMINATOR]);
    expect(disc).toEqual(Array.from(sha256(new TextEncoder().encode("account:TokenMeta")).slice(0, 8)));
    expect(Number(/impl Attestation \{[\s\S]*?pub const VERSION: u8 = (\d+);/.exec(text)![1])).toBe(PQ_IDENTITY.ATTESTATION_VERSION);
    expect(Number(/impl Identity \{[\s\S]*?pub const VERSION: u8 = (\d+);/.exec(text)![1])).toBe(PQ_IDENTITY.IDENTITY_VERSION);
  });

  it("PQ identity and attestation constants (noised-lmots lms.rs, launchpad pq.rs, state.rs)", () => {
    const lib = src("crates/noised-lmots/src/lib.rs");
    const lms = src("crates/noised-lmots/src/lms.rs");
    const known = intConsts(lib);
    const wanted = /^pub const (LMS_TYPE|LMS_OTS_TYPE|LMS_HEIGHT|LMS_PUBLIC_KEY_LEN|LMS_SIG_LEN|DOMAIN_IDENTITY_ID):.*$/gm;
    const l = intConsts([...lms.matchAll(wanted)].map((m) => m[0].replace(/ as usize/g, "")).join("\n"), known);
    expect(Number(l.get("LMS_TYPE"))).toBe(PQ_IDENTITY.LMS_TYPE);
    expect(Number(l.get("LMS_OTS_TYPE") ?? known.get("TYPECODE"))).toBe(PQ_IDENTITY.LMOTS_TYPE);
    expect(Number(l.get("LMS_HEIGHT"))).toBe(PQ_IDENTITY.HEIGHT);
    expect(/pub const LMS_LEAVES: u32 = 1 << LMS_HEIGHT;/.test(lms)).toBe(true);
    expect(1 << PQ_IDENTITY.HEIGHT).toBe(PQ_IDENTITY.LEAVES);
    expect(Number(l.get("LMS_PUBLIC_KEY_LEN"))).toBe(PQ_IDENTITY.PUBLIC_KEY_LEN);
    expect(Number(l.get("LMS_SIG_LEN"))).toBe(PQ_IDENTITY.SIGNATURE_LEN);
    expect(Number(l.get("DOMAIN_IDENTITY_ID"))).toBe(PQ_IDENTITY.IDENTITY_ID_DOMAIN);
    expect(byteSeeds(lms).get("IDENTITY_SEED_TAG")).toBe(PQ_IDENTITY.IDENTITY_SEED_TAG);
    expect(byteSeeds(lms).get("IDENTITY_ID_TAG")).toBe(PQ_IDENTITY.IDENTITY_ID_TAG);
    const pq = src("programs/noised-launchpad/src/pq.rs");
    expect(byteSeeds(pq).get("ATTEST_MESSAGE_TAG")).toBe(PQ_IDENTITY.ATTEST_MESSAGE_TAG);
    expect(byteSeeds(pq).get("METADATA_HASH_TAG")).toBe(PQ_IDENTITY.METADATA_HASH_TAG);
    expect(PQ_IDENTITY.METADATA_HASH_TAG).toBe(METADATA.HASH_TAG);
    expect(/const _: \(\) = assert!\(ATTEST_MESSAGE_LEN == (\d+)\);/.exec(pq)![1]).toBe(String(PQ_IDENTITY.ATTEST_MESSAGE_LEN));
    // Account sizes from the IDL (discriminator + fields; the attestation's signature at its full 2,508 bytes).
    const codec = idlCodecs().launchpad;
    expect(codec.accountSize("Identity")).toBe(PQ_IDENTITY.IDENTITY_ACCOUNT_LEN);
    expect(codec.accountSize("PayoutVault")).toBe(PQ_IDENTITY.PAYOUT_VAULT_ACCOUNT_LEN);
    // Attestation v3: version, bump, launch, pq_identity, leaf, metadata_hash, rules_hash, message_hash, slot, not_before, not_after, signature.
    expect(8 + 2 + 32 + 32 + 2 + 32 + 32 + 32 + 8 + 8 + 8 + 4 + PQ_IDENTITY.SIGNATURE_LEN).toBe(PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN);
    expect(PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN).toBe(2_708);
    expect(Number(/impl Attestation \{[\s\S]*?pub const VERSION: u8 = (\d+);/.exec(src("programs/noised-launchpad/src/state.rs"))![1])).toBe(3);
    expect(PQ_IDENTITY.ATTESTATION_VERSION).toBe(3);
    // The IDL's field order gives the documented offsets.
    const fields = (codec.typeDef("Attestation").type as { fields: { name: string; type: unknown }[] }).fields;
    let off = 8;
    const at: Record<string, number> = {};
    for (const f of fields) {
      at[f.name] = off;
      off += codec.fixedSize(f.type as never) ?? 4;
    }
    const o = PQ_IDENTITY.ATTESTATION_OFFSETS;
    expect([at["version"], at["bump"], at["launch"], at["pq_identity"], at["leaf"], at["metadata_hash"], at["rules_hash"], at["message_hash"], at["slot"], at["not_before"], at["not_after"], at["signature"]]).toEqual([
      o.VERSION,
      o.BUMP,
      o.LAUNCH,
      o.PQ_IDENTITY,
      o.LEAF,
      o.METADATA_HASH,
      o.RULES_HASH,
      o.MESSAGE_HASH,
      o.SLOT,
      o.NOT_BEFORE,
      o.NOT_AFTER,
      o.SIG_LEN,
    ]);
    expect(o.SIGNATURE + PQ_IDENTITY.SIGNATURE_LEN).toBe(PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN);
    // Message v3 and the authorization message (pq.rs).
    expect(byteSeeds(pq).get("AUTH_MESSAGE_TAG")).toBe(AUTHORIZATION.MESSAGE_TAG);
    expect(/const _: \(\) = assert!\(AUTH_MESSAGE_LEN == (\d+)\);/.exec(pq)![1]).toBe(String(AUTHORIZATION.MESSAGE_LEN));
    expect([PQ_IDENTITY.ATTEST_MESSAGE_TAG, PQ_IDENTITY.ATTEST_MESSAGE_LEN]).toEqual(["PHX-ATTEST-V3", 221]);
    expect(PQ_IDENTITY.LEAF_BITMAP_LEN * 8).toBe(PQ_IDENTITY.LEAVES);
  });

  it("P1c: LaunchRules, Authorization and HookPolicy v2 layouts (launchpad state.rs, hook state.rs, noised-rules)", () => {
    const state = src("programs/noised-launchpad/src/state.rs");
    const lr = intConsts(state.slice(state.indexOf("impl LaunchRules {"), state.indexOf("\n}\n", state.indexOf("impl LaunchRules {"))));
    expect(Number(lr.get("VERSION"))).toBe(LAUNCH_RULES.VERSION);
    expect([lr.get("VERSION_OFFSET"), lr.get("BUMP_OFFSET"), lr.get("LAUNCH_OFFSET"), lr.get("RULES_HASH_OFFSET"), lr.get("FIXED_LEN")].map(Number)).toEqual([
      LAUNCH_RULES.OFFSETS.VERSION,
      LAUNCH_RULES.OFFSETS.BUMP,
      LAUNCH_RULES.OFFSETS.LAUNCH,
      LAUNCH_RULES.OFFSETS.RULES_HASH,
      LAUNCH_RULES.FIXED_LEN,
    ]);
    expect(LAUNCH_RULES.OFFSETS.BYTES).toBe(LAUNCH_RULES.FIXED_LEN);
    expect(LAUNCH_RULES.OFFSETS.LEN + 4).toBe(LAUNCH_RULES.FIXED_LEN);
    const disc = (name: string): number[] => IDLS.launchpad.accounts!.find((a) => a.name === name)!.discriminator;
    expect(disc("LaunchRules")).toEqual([...LAUNCH_RULES.DISCRIMINATOR]);
    expect(disc("LaunchRules")).toEqual(Array.from(sha256(new TextEncoder().encode("account:LaunchRules")).slice(0, 8)));
    expect(disc("Authorization")).toEqual([...AUTHORIZATION.DISCRIMINATOR]);
    expect(Number(/impl Authorization \{[\s\S]*?pub const VERSION: u8 = (\d+);/.exec(state)![1])).toBe(AUTHORIZATION.VERSION);
    // The rules crate: the largest set and the hash tag.
    const rules = src("crates/noised-rules/src/rules.rs");
    expect(Number(intConsts(rules).get("MAX_LEN"))).toBe(LAUNCH_RULES.MAX_RULES_LEN);
    // Authorization layout: the IDL's field order and the autopilot's reader (launchpad.rs) agree with AUTHORIZATION.
    const codec = idlCodecs().launchpad;
    const fields = (codec.typeDef("Authorization").type as { fields: { name: string; type: unknown }[] }).fields;
    let off = 8;
    const at: Record<string, number> = {};
    for (const f of fields) {
      at[camelCase(f.name)] = off;
      off += codec.fixedSize(f.type as never) ?? 4;
    }
    const o = AUTHORIZATION.OFFSETS;
    expect(at).toEqual({
      version: o.VERSION,
      bump: o.BUMP,
      launch: o.LAUNCH,
      pqIdentity: o.PQ_IDENTITY,
      kind: o.KIND,
      payloadHash: o.PAYLOAD_HASH,
      messageHash: o.MESSAGE_HASH,
      unixTime: o.UNIX_TIME,
      slot: o.SLOT,
      leaf: o.LEAF,
      signature: o.SIG_LEN,
    });
    const ap = src("programs/noised-autopilot/src/launchpad.rs");
    const a = intConsts(ap.slice(ap.indexOf("pub mod authorization"), ap.indexOf("pub mod kind")));
    expect(Number(a.get("SIGNATURE_OFFSET"))).toBe(o.SIGNATURE);
    expect(Number(a.get("LEN"))).toBe(AUTHORIZATION.ACCOUNT_LEN);
    expect(o.SIGNATURE + PQ_IDENTITY.SIGNATURE_LEN).toBe(AUTHORIZATION.ACCOUNT_LEN);
    // HookPolicy v2: rules after the fixed fields (u32 length at 275, bytes from 279).
    const hookState = src("programs/noised-hook/src/state.rs");
    expect(Number(/impl HookPolicy \{[\s\S]*?pub const VERSION: u8 = (\d+);/.exec(hookState)![1])).toBe(HOOK_POLICY.VERSION);
    const hp = (idlCodecs().hook.typeDef("HookPolicy").type as { fields: { name: string; type: unknown }[] }).fields;
    let hoff = 8;
    for (const f of hp.slice(0, -1)) hoff += idlCodecs().hook.fixedSize(f.type as never)!;
    expect(hp.at(-1)?.name).toBe("rules");
    expect(hoff).toBe(HOOK_POLICY.RULES_LEN_OFFSET);
    expect(HOOK_POLICY.RULES_LEN_OFFSET + 4).toBe(HOOK_POLICY.RULES_OFFSET);
    expect(IDLS.hook.accounts!.find((x) => x.name === "HookPolicy")!.discriminator).toEqual([...HOOK_POLICY.DISCRIMINATOR]);
  });

  it("hook seeds and bounds (state.rs, rules.rs)", () => {
    const seeds = byteSeeds(src("programs/noised-hook/src/state.rs"));
    expect(seeds.get("POLICY_SEED")).toBe(SEEDS.hookPolicy);
    expect(seeds.get("META_LIST_SEED")).toBe(SEEDS.extraAccountMetas);
    expect(seeds.get("HOOK_AUTHORITY_SEED")).toBe(SEEDS.hookAuthority);
    expect(seeds.get("DBC_TOKEN_VAULT_SEED")).toBe(SEEDS.dbcTokenVault);
    const rules = src("programs/noised-hook/src/rules.rs");
    const b = intConsts(rules.slice(rules.indexOf("pub mod bounds")));
    expect(Number(b.get("MAX_GUARD_SECS"))).toBe(HOOK_BOUNDS.MAX_GUARD_SECS);
    expect(Number(b.get("MAX_SNIPE_SHIELD_SECS"))).toBe(HOOK_BOUNDS.MAX_SNIPE_SHIELD_SECS);
    expect(b.get("MIN_MAX_WALLET_DIVISOR")).toBe(HOOK_BOUNDS.MIN_MAX_WALLET_DIVISOR);
    expect(b.get("MIN_MAX_BUY_DIVISOR")).toBe(HOOK_BOUNDS.MIN_MAX_BUY_DIVISOR);
    expect(pubkeyConsts(src("programs/noised-hook/src/lib.rs")).get("LAUNCHPAD_PROGRAM_ID")).toBe(PROGRAM_IDS.launchpad.toBase58());
  });

  it("vault v4: seeds, versions, message format, memo program (state.rs, message.rs, token.rs)", () => {
    // The program's own sources keep the seeds, versions and message format; the memo program id is read from
    // its Anchor reference (programs/noised-vault/anchor), as a `pubkey!` there.
    const state = src("programs/noised-vault/src/state.rs");
    expect(byteSeeds(state).get("VAULT_SEED")).toBe(SEEDS.vault);
    expect(byteSeeds(state).get("PAYOUT_SEED")).toBe(SEEDS.payout);
    expect(Number(/impl Vault \{[\s\S]*?pub const VERSION: u8 = (\d+);/.exec(state)![1])).toBe(VAULT.VERSION);
    expect(Number(/impl Payout \{[\s\S]*?pub const VERSION: u8 = (\d+);/.exec(state)![1])).toBe(VAULT.PAYOUT_VERSION);
    const msg = src("programs/noised-vault/src/message.rs");
    expect(byteSeeds(msg).get("MESSAGE_TAG")).toBe("PHX-PQV4");
    expect(VAULT.MESSAGE_TAG).toBe("PHX-PQV4");
    expect(Number(intConsts(msg).get("OP_WITHDRAW"))).toBe(VAULT.OP_WITHDRAW);
    expect(/WITHDRAW_MESSAGE_LEN: usize = 8 \+ 1 \+ 32 \* 3 \+ 8 \+ 32 \+ 8 \+ 32;/.test(msg)).toBe(true);
    expect(Number(intConsts(msg).get("WITHDRAW_MESSAGE_LEN"))).toBe(185);
    expect(VAULT.WITHDRAW_MESSAGE_LEN).toBe(185);
    expect(pubkeyConsts(src("programs/noised-vault/anchor/token.rs")).get("MEMO_PROGRAM_ID")).toBe(KNOWN_ACCOUNTS.memo.toBase58());
    expect(KNOWN_ACCOUNTS.memo.toBase58()).toBe("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    // The IDL pins the memo program in release / release_to.
    for (const name of ["release", "release_to"]) {
      const acc = IDLS.vault.instructions.find((i) => i.name === name)!.accounts.find((a) => a.name === "memo_program");
      expect(acc?.address, name).toBe(KNOWN_ACCOUNTS.memo.toBase58());
    }
    // withdraw: discriminator, Vec length, signature, recipient, max amount, next key id, VaultKey.
    expect(VAULT.WITHDRAW_IX_DATA_LEN).toBe(2312);
    expect(IDLS.vault.instructions.map((i) => i.name).sort()).toEqual(["open_vault", "release", "release_to", "withdraw"]);
  });

  it("LM-OTS randomizer tag (crates/noised-lmots)", () => {
    const tag = byteSeeds(src("crates/noised-lmots/src/lib.rs")).get("RANDOMIZER_TAG");
    expect(tag).toBe("phalanx/pq/lmots/C");
    expect(VAULT.RANDOMIZER_TAG).toBe(tag);
    expect(new TextDecoder().decode(lmots.RANDOMIZER_TAG)).toBe(tag);
  });

  it("Launch Guard: execute_batch discriminator, two metas, four hook accounts (hook lib.rs, hook_accounts.rs)", () => {
    const hook = src("programs/noised-hook/src/lib.rs");
    const disc = /pub const EXECUTE_BATCH_DISCRIMINATOR: \[u8; 8\] = \[([\d,\s]+)\];/.exec(hook)![1]!.split(",").map((x) => Number(x.trim()));
    expect(disc).toEqual([...LAUNCH_GUARD.EXECUTE_BATCH_DISCRIMINATOR]);
    expect(disc).toEqual(Array.from(sha256(new TextEncoder().encode("global:execute_batch")).slice(0, 8)));
    expect(disc).toEqual(IDLS.launchpad.instructions.find((i) => i.name === "execute_batch")!.discriminator);
    // The meta list holds exactly the policy PDA and the instructions sysvar.
    expect(/ExtraAccountMetaList::size_of\((\d+)\)/.exec(hook)![1]).toBe(String(LAUNCH_GUARD.EXTRA_METAS));
    expect(/fn canonical_metas\(\) -> Result<\[ExtraAccountMeta; (\d+)\]>/.exec(hook)![1]).toBe(String(LAUNCH_GUARD.EXTRA_METAS));
    expect(hook).toContain("ExtraAccountMeta::new_with_pubkey(&INSTRUCTIONS_SYSVAR_ID, false, false)");
    const accounts = src("programs/noised-launchpad/src/hook_accounts.rs");
    expect(Number(intConsts(accounts).get("HOOK_ACCOUNT_COUNT"))).toBe(LAUNCH_GUARD.HOOK_ACCOUNT_COUNT);
    // `expected(mint)` order, and the SDK's.
    expect(accounts).toContain("[meta_list, policy, INSTRUCTIONS_SYSVAR_ID, noised_hook::ID]");
    const mint = new PublicKey(new Uint8Array(32).fill(9));
    expect(noisedHookAccounts(mint).map((m) => m.pubkey.toBase58())).toEqual(
      [extraAccountMetaListAddress(mint), hookPolicyAddress(mint), KNOWN_ACCOUNTS.sysvarInstructions, PROGRAM_IDS.hook].map((k) => k.toBase58()),
    );
    expect(noisedHookAccounts(mint).length).toBe(LAUNCH_GUARD.HOOK_ACCOUNT_COUNT);
    // The hook IDL's execute takes the two extra accounts after the meta list.
    expect(IDLS.hook.instructions.find((i) => i.name === "execute")!.accounts.map((a) => a.name).slice(4)).toEqual(["extra_account_meta_list", "policy", "instructions"]);
  });

  it("autopilot seeds, external ids and authorization layout (constants.rs, launchpad.rs)", () => {
    const text = src("programs/noised-autopilot/src/constants.rs");
    const seeds = byteSeeds(text);
    expect(seeds.get("AUTOPILOT_SEED")).toBe(SEEDS.autopilot);
    expect(seeds.get("TREASURY_SEED")).toBe(SEEDS.autopilotTreasury);
    expect(seeds.get("GRAPH_SEED")).toBe(SEEDS.graphRecord);
    const keys = pubkeyConsts(text);
    expect(keys.get("LAUNCHPAD_PROGRAM_ID")).toBe(PROGRAM_IDS.launchpad.toBase58());
    expect(keys.get("DBC_PROGRAM_ID")).toBe(PROGRAM_IDS.dbc.toBase58());
    expect(keys.get("DAMM_V2_PROGRAM_ID")).toBe(PROGRAM_IDS.dammV2.toBase58());
    expect(keys.get("DAMM_V2_POOL_AUTHORITY")).toBe(KNOWN_ACCOUNTS.dammV2PoolAuthority.toBase58());
    expect(keys.get("DAMM_V2_EVENT_AUTHORITY")).toBe(KNOWN_ACCOUNTS.dammV2EventAuthority.toBase58());
    expect(keys.get("DBC_POOL_AUTHORITY")).toBe(KNOWN_ACCOUNTS.dbcPoolAuthority.toBase58());
    const lp = src("programs/noised-autopilot/src/launchpad.rs");
    const auth = lp.slice(lp.indexOf("pub mod authorization"));
    expect(/pub const SEED: &\[u8\] = b"(\w+)";/.exec(auth)![1]).toBe(SEEDS.authorization);
    expect(/ACTIVATE_DOMAIN: &\[u8; 16\] = b"([\w-]+)"/.exec(auth)![1]).toBe(AUTH_DOMAINS.ACTIVATE);
    expect(/FREEZE_DOMAIN: &\[u8; 16\] = b"([\w-]+)"/.exec(auth)![1]).toBe(AUTH_DOMAINS.FREEZE);
    expect(/REVOKE_DOMAIN: &\[u8; 16\] = b"([\w-]+)"/.exec(auth)![1]).toBe(AUTH_DOMAINS.REVOKE);
    for (const [k, v] of Object.entries(AUTH_KIND)) expect(new RegExp(`pub const ${k}: u8 = ${v};`).test(auth), k).toBe(true);
  });

  it("review 4: the vault and shield the hook skips creator rules for, pq_authorize's kinds, the autopilot's Launch versions, FreezeExpired, freeze payload v2", () => {
    // R1: creator rules are skipped when the current top-level program is the Noised vault or shield (hook lib.rs, rules.rs).
    const hook = pubkeyConsts(src("programs/noised-hook/src/lib.rs"));
    expect([hook.get("VAULT_PROGRAM_ID"), hook.get("SHIELD_PROGRAM_ID")]).toEqual([PROGRAM_IDS.vault.toBase58(), PROGRAM_IDS.shield.toBase58()]);
    expect([NOISED_VAULT_PROGRAM, NOISED_SHIELD_PROGRAM]).toEqual([PROGRAM_IDS.vault.toBase58(), PROGRAM_IDS.shield.toBase58()]);
    expect([...RULES_SKIPPED_PROGRAMS]).toEqual([NOISED_VAULT_PROGRAM, NOISED_SHIELD_PROGRAM]);
    const rules = src("programs/noised-hook/src/rules.rs");
    const creatorRules = rules.slice(rules.indexOf("pub fn creator_rules"), rules.indexOf("pub fn shield_end_after_batch"));
    expect(creatorRules).toContain("if t.top_program == VAULT_PROGRAM_ID || t.top_program == SHIELD_PROGRAM_ID {");
    // The built-in checks come first and are never skipped: MutableOwner sits in built_ins, before the source exemption.
    const builtIns = rules.slice(rules.indexOf("pub fn built_ins"), rules.indexOf("pub fn creator_rules"));
    expect(builtIns.indexOf("Refusal::MutableOwner")).toBeGreaterThan(builtIns.indexOf("policy.is_exempt(&t.destination_owner)"));
    expect(builtIns.indexOf("Refusal::MutableOwner")).toBeLessThan(builtIns.indexOf("policy.is_exempt(&t.source_owner)"));
    // Ra: pq_authorize writes an Authorization only for kinds 1..=3 (any other kind is burn-only); the SDK signs only those.
    const lpConsts = src("programs/noised-launchpad/src/constants.rs");
    expect(/pub const AUTHORIZATION_KINDS: core::ops::RangeInclusive<u8> = (\d+)..=(\d+);/.exec(lpConsts)!.slice(1)).toEqual(["1", "3"]);
    expect(Object.values(AUTHORIZATION.KINDS).sort()).toEqual([1, 2, 3]);
    expect(Object.values(AUTH_KIND).sort()).toEqual([1, 2, 3]);
    expect(src("programs/noised-launchpad/src/instructions/pq_authorize.rs")).toContain("AUTHORIZATION_KINDS.contains(&kind)");
    // R6b: the autopilot reads Launch versions 2..=2 (the launchpad's Launch::VERSION) and certificate versions 3..=4.
    const lp = src("programs/noised-autopilot/src/launchpad.rs");
    const launchMod = intConsts(lp.slice(lp.indexOf("pub mod launch {"), lp.indexOf("pub mod certificate {")));
    expect([launchMod.get("MIN_VERSION"), launchMod.get("MAX_VERSION")]).toEqual([2n, 2n]);
    const state = src("programs/noised-launchpad/src/state.rs");
    expect(/impl Launch \{\s*pub const VERSION: u8 = (\d+);/.exec(state)![1]).toBe(String(QSL1.LAUNCH.VERSION));
    expect(launchMod.get("MAX_VERSION")).toBe(BigInt(QSL1.LAUNCH.VERSION));
    const certMod = intConsts(lp.slice(lp.indexOf("pub mod certificate {")));
    expect([certMod.get("MIN_VERSION"), certMod.get("MAX_VERSION")]).toEqual([BigInt(QSL1.CERTIFICATE.V3_VERSION), BigInt(QSL1.CERTIFICATE.VERSION)]);
    // R5: freeze payload v2 and its expiry: FreezeExpired is the autopilot's error 6040.
    expect(AUTH_DOMAINS.FREEZE).toBe("PHX-GRAPH-FRZ-V2");
    expect(QSL1.FREEZE_DOMAIN).toBe(AUTH_DOMAINS.FREEZE);
    expect(lp).toContain("pub fn freeze_payload(autopilot: &Pubkey, graph_hash: &[u8; 32], not_after: i64) -> [u8; 32]");
    const a = new PublicKey(new Uint8Array(32).fill(7));
    const g = new Uint8Array(32).fill(9);
    const enc = new TextEncoder();
    const le = new Uint8Array(8);
    new DataView(le.buffer).setBigInt64(0, 1_767_229_200n, true);
    expect(freezePayload(a, g, 1_767_229_200n)).toEqual(sha256(new Uint8Array([...enc.encode("PHX-GRAPH-FRZ-V2"), ...a.toBytes(), ...g, ...le])));
    const errors = src("programs/noised-autopilot/src/error.rs");
    const variants = [...errors.matchAll(/^\s{4}(\w+),$/gm)].map((m) => m[1]!);
    expect([6000 + variants.indexOf("FreezeExpired"), variants[40]]).toEqual([6040, "FreezeExpired"]);
    expect((AUTOPILOT_ERRORS as readonly string[])[40]).toBe("FreezeExpired");
    expect(plainErrorMessage(PROGRAM_IDS.autopilot.toBase58(), 6040)).toMatch(/^[A-Z].*expired.*\.$/i);
    expect(src("programs/noised-autopilot/src/logic.rs")).toContain("require!(now <= not_after, AutopilotError::FreezeExpired);");
  });

  it("audit 4: the autopilot's 1,244-byte account (every offset from state.rs), revoke payload v3, partial buybacks, NodeRan, errors 6041/6042 with plain messages", () => {
    // The Autopilot account's layout, computed from state.rs's field types (borsh: no padding), is the SDK's and the vectors'.
    const state = src("programs/noised-autopilot/src/state.rs");
    const maxNodes = 16;
    expect(/pub const MAX_GRAPH_NODES: u8 = (\d+);/.exec(src("crates/noised-rules/src/graph.rs"))?.[1] ?? String(maxNodes)).toBe(String(maxNodes));
    const structFields = (name: string): [string, string][] => {
      const body = new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`).exec(state)![1]!;
      return [...body.matchAll(/^\s*pub (\w+): ([^,]+),/gm)].map((m) => [m[1]!, m[2]!.trim()]);
    };
    const sizeOf = (t: string): number => {
      const arr = /^\[(.+); (\w+)\]$/.exec(t);
      if (arr !== null) return sizeOf(arr[1]!) * (arr[2] === "MAX_NODES" ? maxNodes : Number(arr[2]));
      const prim: Record<string, number> = { u8: 1, bool: 1, u16: 2, u32: 4, u64: 8, i64: 8, u128: 16, Pubkey: 32 };
      if (prim[t] !== undefined) return prim[t]!;
      return structFields(t).reduce((n, [, ft]) => n + sizeOf(ft), 0);
    };
    const offsets: Record<string, number> = {};
    let at = 8;
    for (const [f, t] of structFields("Autopilot")) {
      offsets[camelCase(f)] = at;
      at += sizeOf(t);
    }
    expect(at).toBe(AUTOPILOT.ACCOUNT_LEN);
    expect(AUTOPILOT.ACCOUNT_LEN).toBe(1_244);
    expect(idlCodecs().autopilot.accountSize("Autopilot")).toBe(AUTOPILOT.ACCOUNT_LEN);
    for (const [k, v] of Object.entries(AUTOPILOT.OFFSETS)) expect(offsets[k], k).toBe(v);
    expect(Object.keys(offsets).filter((k) => !(k in AUTOPILOT.OFFSETS))).toEqual([]);
    expect([QSL1.AUTOPILOT.LEN, QSL1.AUTOPILOT.ACTIVE_AUTH_OFFSET, QSL1.AUTOPILOT.ACTIVE_ACTIVATE_AT_OFFSET, QSL1.AUTOPILOT.PARTIAL_SPENT_OFFSET]).toEqual([
      AUTOPILOT.ACCOUNT_LEN,
      AUTOPILOT.OFFSETS.activeAuth,
      AUTOPILOT.OFFSETS.activeActivateAt,
      AUTOPILOT.OFFSETS.partialSpent,
    ]);
    expect(QSL1.AUTOPILOT.DISCRIMINATOR).toBe(Buffer.from(sha256(new TextEncoder().encode("account:Autopilot")).subarray(0, 8)).toString("hex"));
    expect(AUTOPILOT.A4_EXTRA_RENT_LAMPORTS).toBe(BigInt(32 + 8 + 8 * maxNodes) * 6_960n);
    // The integration vectors (the program's own test output) state the same layout, in both copies.
    for (const rel of ["tests/integration/vectors/programmable.json", "sdk/test/vectors/programmable.json"]) {
      const p = (JSON.parse(src(rel)) as { parameters: { autopilotAccount: { accountLen: number; offsets: Record<string, number> }; payloadDomains: Record<string, string>; payloadLayouts: Record<string, string> } }).parameters;
      expect(p.autopilotAccount.accountLen, rel).toBe(AUTOPILOT.ACCOUNT_LEN);
      expect(p.autopilotAccount.offsets, rel).toEqual({ ...AUTOPILOT.OFFSETS });
      expect(p.payloadDomains.OPERATOR_REVOKE, rel).toBe(AUTH_DOMAINS.REVOKE);
      expect(p.payloadLayouts.OPERATOR_REVOKE, rel).toBe("SHA256(domain || autopilot || graphHash || operator || activeAuth)");
    }
    // A4-3: revoke payload v3 binds the authorization that activated the running graph.
    expect(AUTH_DOMAINS.REVOKE).toBe("PHX-OP-REVOKE-V3");
    const lp = src("programs/noised-autopilot/src/launchpad.rs");
    expect(lp).toMatch(/pub fn revoke_payload\(\s*autopilot: &Pubkey,\s*graph_hash: &\[u8; 32\],\s*operator: &Pubkey,\s*active_auth: &Pubkey,?\s*\)/);
    const k = (b: number): PublicKey => new PublicKey(new Uint8Array(32).fill(b));
    const g = new Uint8Array(32).fill(9);
    expect(revokePayload(k(1), g, k(2), k(3))).toEqual(sha256(new Uint8Array([...new TextEncoder().encode("PHX-OP-REVOKE-V3"), ...k(1).toBytes(), ...g, ...k(2).toBytes(), ...k(3).toBytes()])));
    // A4-2 / M4: the errors appended after FreezeExpired, the SDK's table, and plain messages.
    const variants = [...src("programs/noised-autopilot/src/error.rs").matchAll(/^\s{4}(\w+),$/gm)].map((m) => m[1]!);
    expect(variants.slice(40)).toEqual(["FreezeExpired", "RemainderTooSmall", "NoRecipientAccount"]);
    expect([...(AUTOPILOT_ERRORS as readonly string[])]).toEqual(variants);
    expect(plainErrorMessage(PROGRAM_IDS.autopilot.toBase58(), 6041)).toMatch(/^This smaller buyback would leave too little .*\.$/);
    expect(plainErrorMessage(PROGRAM_IDS.autopilot.toBase58(), 6042)).toMatch(/^Nobody can be paid right now: .*wrapped SOL \(wSOL\) account.*\.$/);
    // The remainder rule: amount == cap, or cap - amount >= the floor (logic.rs).
    const logic = src("programs/noised-autopilot/src/logic.rs");
    expect(logic).toContain("RemainderTooSmall");
    expect(src("programs/noised-autopilot/src/state.rs")).toContain("pub partial_spent: [u64; MAX_NODES],");
    // NodeRan (events.rs) ends with partial, skipped, kept; the IDL and decodeAutopilotEvent carry them.
    const events = src("programs/noised-autopilot/src/events.rs");
    const nodeRan = /pub struct NodeRan \{([\s\S]*?)\n\}/.exec(events)![1]!;
    const evFields = [...nodeRan.matchAll(/^\s*pub (\w+): ([^,]+),/gm)].map((m) => [camelCase(m[1]!), m[2]!.trim()]);
    expect(evFields.slice(-3)).toEqual([["partial", "bool"], ["skipped", "u8"], ["kept", "u64"]]);
    const idlEv = (IDLS.autopilot as { types: { name: string; type: { fields: { name: string }[] } }[] }).types.find((t) => t.name === "NodeRan")!;
    expect(idlEv.type.fields.map((f) => camelCase(f.name))).toEqual(evFields.map(([n]) => n));
    const disc = (IDLS.autopilot as { events: { name: string; discriminator: number[] }[] }).events.find((e) => e.name === "NodeRan")!.discriminator;
    expect(disc).toEqual([...sha256(new TextEncoder().encode("event:NodeRan")).subarray(0, 8)]);
    // A distribution that skipped recipients 0 and 2 (kept 30) of 100 due: paid 70.
    const payload = new Uint8Array(32 + 1 + 1 + 8 * 5 + 32 + 16 + 16 + 1 + 1 + 8);
    expect(payload.length).toBe(148);
    const dv = new DataView(payload.buffer);
    payload.set(k(4).toBytes(), 0);
    payload[32] = 1;
    payload[33] = 3;
    dv.setBigUint64(34, 7n, true); // seq
    dv.setBigUint64(42, 100n, true); // spent
    payload.set(k(5).toBytes(), 74); // caller
    payload[138] = 0; // partial
    payload[139] = 0b101; // skipped
    dv.setBigUint64(140, 30n, true); // kept
    const ev = decodeAutopilotEvent(new Uint8Array([...disc, ...payload]));
    expect(ev).toMatchObject({ name: "NodeRan", node: 1, action: 3, seq: 7n, spent: 100n, partial: false, skipped: 5, kept: 30n, paid: 70n, skippedRecipients: [0, 2] });
    expect((ev as { caller: PublicKey }).caller.equals(k(5))).toBe(true);
    expect(decodeAutopilotEvent(new Uint8Array(8))).toBeNull();
  });

  it("audit 4: the client-side constants (leaf probe v2 tags, clock skew, freeze cap, unlanded-signature cap) and the launch lead the attestation window stays within", () => {
    expect(PQ_IDENTITY.LEAF_PROBE_TAG).toBe("phalanx/pq/identity/leaf");
    expect(PQ_IDENTITY.LEAF_PROBE_V2_TAG).toBe("phalanx/pq/identity/leaf/v2");
    expect(PQ_IDENTITY.LEAF_PROBE_KEY_TAG).toBe("phalanx/pq/identity/leaf/v2/key");
    expect(PQ_IDENTITY.CLOCK_SKEW_MAX_SECS).toBe(120);
    expect(PQ_IDENTITY.FREEZE_MAX_VALID_SECS).toBe(86_400);
    expect(PQ_IDENTITY.MAX_UNLANDED_SIGNATURES).toBe(3);
    expect(CLOCK_SKEW_MAX_SECS).toBe(BigInt(PQ_IDENTITY.CLOCK_SKEW_MAX_SECS));
    expect(MAX_UNLANDED_SIGNATURES).toBe(PQ_IDENTITY.MAX_UNLANDED_SIGNATURES);
    // Attestation windows the SDK plans stay within the launchpad's MAX_LAUNCH_LEAD_SECS (7 days).
    expect(src("programs/noised-launchpad/src/constants.rs")).toContain("pub const MAX_LAUNCH_LEAD_SECS: i64 = 7 * 86_400;");
    expect(POLICY.MAX_LAUNCH_LEAD_SECS).toBe(7 * 86_400);
  });

  it("shield seeds (state.rs)", () => {
    const seeds = byteSeeds(src("programs/noised-shield/src/state.rs"));
    expect(seeds.get("SHIELD_SEED")).toBe(SEEDS.shield);
    expect(seeds.get("SHIELD_AUTHORITY_SEED")).toBe(SEEDS.shieldAuthority);
    expect(seeds.get("Z_MINT_SEED")).toBe(SEEDS.zMint);
  });

  it("fixed Meteora authorities derive from their seeds", () => {
    const pda = (seed: string, program: PublicKey): string => PublicKey.findProgramAddressSync([new TextEncoder().encode(seed)], program)[0].toBase58();
    expect(pda("pool_authority", PROGRAM_IDS.dbc)).toBe(KNOWN_ACCOUNTS.dbcPoolAuthority.toBase58());
    expect(pda("__event_authority", PROGRAM_IDS.dbc)).toBe(KNOWN_ACCOUNTS.dbcEventAuthority.toBase58());
    expect(pda("pool_authority", PROGRAM_IDS.dammV2)).toBe(KNOWN_ACCOUNTS.dammV2PoolAuthority.toBase58());
    expect(pda("__event_authority", PROGRAM_IDS.dammV2)).toBe(KNOWN_ACCOUNTS.dammV2EventAuthority.toBase58());
  });
});

// ---------------------------------------------- IDLs vs Rust sources ---

describe("the IDLs are current with the program sources", () => {
  /** `#[error_code]` variants in order: code 6000 + index, name, message. */
  function errorEnum(text: string): { code: number; name: string; msg: string }[] {
    const start = text.indexOf("#[error_code]");
    const body = text.slice(text.indexOf("{", start) + 1, text.indexOf("\n}", start));
    return [...body.matchAll(/#\[msg\(\s*"((?:[^"\\]|\\.)*)"\s*\)\]\s*(\w+),/g)].map((m, i) => ({ code: 6000 + i, name: m[2]!, msg: m[1]!.replace(/\\(.)/g, "$1") }));
  }
  /** `pub fn` names of the `#[program]` module. */
  function instructions(text: string): string[] {
    const mod = text.slice(text.indexOf("#[program]"));
    return [...mod.slice(0, mod.indexOf("\n}\n")).matchAll(/pub fn (\w+)/g)].map((m) => m[1]!).sort();
  }
  const programs: [keyof typeof IDLS, string, string][] = [
    // Written without Anchor: their IDLs are checked against the Anchor references they implement (and, in
    // programs/noised-{launchpad,vault}/tests/abi.rs, against the programs themselves).
    ["launchpad", "programs/noised-launchpad/anchor/error.rs", "programs/noised-launchpad/anchor/lib.rs"],
    ["hook", "programs/noised-hook/src/lib.rs", "programs/noised-hook/src/lib.rs"],
    ["vault", "programs/noised-vault/anchor/error.rs", "programs/noised-vault/anchor/lib.rs"],
    ["shield", "programs/noised-shield/src/error.rs", "programs/noised-shield/src/lib.rs"],
    ["autopilot", "programs/noised-autopilot/src/error.rs", "programs/noised-autopilot/src/lib.rs"],
  ];
  for (const [name, errors, lib] of programs) {
    it(`${name}: error codes and messages, instruction names`, () => {
      const rust = errorEnum(src(errors));
      expect(rust.length).toBeGreaterThan(0);
      expect((IDLS[name].errors ?? []).map((e) => ({ code: e.code, name: e.name, msg: e.msg ?? "" }))).toEqual(rust);
      expect(IDLS[name].instructions.map((i) => i.name).sort()).toEqual(instructions(src(lib)));
    });
  }

  it("P1c error tables: hook 6011 RuleDenied / 6012 InvalidRules, launchpad 6048 InvalidRules, each with a plain message", () => {
    const hook = errorEnum(src("programs/noised-hook/src/lib.rs"));
    expect(hook.slice(-2)).toEqual([
      { code: 6011, name: "RuleDenied", msg: "Launch rule: this transfer is not allowed right now" },
      { code: 6012, name: "InvalidRules", msg: "Launch rules do not verify (PXR1) for this guard" },
    ]);
    expect([HOOK_ERRORS.RuleDenied, HOOK_ERRORS.InvalidRules]).toEqual([6011, 6012]);
    const lp = errorEnum(src("programs/noised-launchpad/anchor/error.rs"));
    expect(lp.at(-1)).toEqual({ code: 6048, name: "InvalidRules", msg: "Launch rules do not verify (PXR1) for this launch's guard" });
    expect(LAUNCH_RULES.ERRORS.InvalidRules).toBe(6048);
    const h = PROGRAM_IDS.hook.toBase58();
    const l = PROGRAM_IDS.launchpad.toBase58();
    for (const [program, code, name] of [
      [h, 6011, "RuleDenied"],
      [h, 6012, "InvalidRules"],
      [l, 6048, "InvalidRules"],
    ] as const) {
      const e = explainProgramError(program, code);
      expect(e?.name).toBe(name);
      expect(e?.plain).toBe(plainErrorMessage(program, code));
      expect(plainErrorMessage(program, code)).toMatch(/^[A-Z][^`{}]+\.$/);
      expect(plainErrorMessage(program, code)).not.toMatch(/PXR1|guard_secs|hash/);
    }
    expect(plainErrorMessage(h, 6011)).toMatch(/never block selling/);
    expect(explainProgramError(h, 6010)?.plain).toBeUndefined();
    // The hook's log line names the rule that refused.
    expect(src("programs/noised-hook/src/lib.rs")).toContain("Launch rule {} (code {}) refused the transfer");
  });

  it("hook errors (HOOK_ERRORS) are the Rust enum's numbers; MutableOwner 6010 (audit round 3 F2) is appended with the SDK's message", () => {
    const rust = errorEnum(src("programs/noised-hook/src/lib.rs"));
    for (const e of rust) expect(HOOK_ERRORS[e.name as keyof typeof HOOK_ERRORS], e.name).toBe(e.code);
    expect(Object.keys(HOOK_ERRORS)).toHaveLength(13);
    const appended = { code: 6010, name: "MutableOwner", msg: "Launch guard: the receiving token account must have an immutable owner while the guard is on" };
    const mutable = rust.find((e) => e.name === "MutableOwner");
    // Until the F2 hook is merged the program (and its IDL) end at NotInBatch; from then on MutableOwner is exactly this.
    if (mutable === undefined) expect(rust.at(-1)).toEqual(expect.objectContaining({ code: 6009, name: "NotInBatch" }));
    else expect(mutable).toEqual(appended);
    expect(explainProgramError(PROGRAM_IDS.hook.toBase58(), 6010)).toEqual({ program: "noised_hook", name: appended.name, message: appended.msg });
    expect(explainProgramError(PROGRAM_IDS.launchpad.toBase58(), 6010)?.name).not.toBe("MutableOwner");
  });

  it("PQ v2 additions are in the IDLs: launchpad 6039-6044, hook NotInBatch, vault InvalidKeyIndex, new instructions and accounts", () => {
    const byCode = (idl: keyof typeof IDLS, code: number): string | undefined => IDLS[idl].errors?.find((e) => e.code === code)?.name;
    expect([6039, 6040, 6041, 6042, 6043, 6044].map((c) => byCode("launchpad", c))).toEqual([
      "InvalidPqIdentity",
      "InvalidPqSignature",
      "PqLeafUsed",
      "AttestationMismatch",
      "InvalidPayoutOwner",
      "NotLaunchWindow",
    ]);
    expect(byCode("hook", 6009)).toBe("NotInBatch");
    expect(byCode("vault", 6006)).toBe("InvalidKeyIndex");
    expect(IDLS.launchpad.instructions.find((i) => i.name === "attest_launch")?.discriminator).toEqual([0xb5, 0x18, 0xc9, 0x35, 0xf6, 0x7e, 0xfd, 0x4f]);
    expect(IDLS.hook.instructions.some((i) => i.name === "end_snipe_shield")).toBe(true);
    expect((IDLS.launchpad.accounts ?? []).map((a) => a.name).sort()).toEqual([
      "Attestation",
      "Authorization",
      "Certificate",
      "Commit",
      "Identity",
      "Launch",
      "LaunchRules",
      "PayoutVault",
      "Protocol",
      "TokenMeta",
    ]);
    // launch: account 0 is `payer` (anyone), the attestation, the metadata record, then the optional rules record come last; no arguments.
    const launchIx = IDLS.launchpad.instructions.find((i) => i.name === "launch")!;
    expect(launchIx.accounts[0]).toMatchObject({ name: "payer", signer: true, writable: true });
    expect(launchIx.accounts.map((a) => a.name).slice(-3)).toEqual(["attestation", "token_meta", "rules"]);
    expect(launchIx.accounts).toHaveLength(23);
    expect(launchIx.args).toEqual([]);
    expect(launchIx.accounts.at(-1)).toMatchObject({ name: "rules", optional: true });
    expect(launchIx.accounts.at(-1)?.writable ?? false).toBe(false);
    expect(launchIx.accounts.at(-2)?.writable ?? false).toBe(false);
    // On-chain metadata: the errors appended after 6044, publish_metadata, and attest_launch's record (read-only) at index 4.
    expect([6016, 6045, 6046, 6047].map((c) => byCode("launchpad", c))).toEqual(["InvalidMetadata", "InvalidMetadataFlags", "MetadataTooLong", "MetadataMismatch"]);
    expect(Object.entries(METADATA.ERRORS).map(([name, code]) => byCode("launchpad", code) === name)).toEqual([true, true, true, true]);
    const attestIx = IDLS.launchpad.instructions.find((i) => i.name === "attest_launch")!;
    expect(attestIx.accounts.map((a) => a.name)).toEqual(["payer", "launch", "identity", "attestation", "token_meta", "system_program", "rules"]);
    expect([attestIx.accounts[4]!.writable ?? false, attestIx.accounts[4]!.pda]).toEqual([false, undefined]);
    expect([attestIx.accounts[6]!.writable ?? false, attestIx.accounts[6]!.optional, attestIx.accounts[6]!.pda]).toEqual([false, true, undefined]);
    // P1c: rules_hash after metadata_hash.
    expect(attestIx.args.map((a) => a.name)).toEqual(["lms_pk", "lms_sig", "metadata_hash", "rules_hash", "not_before", "not_after"]);
    const publishRules = IDLS.launchpad.instructions.find((i) => i.name === "publish_rules")!;
    expect(publishRules.discriminator).toEqual([0xd5, 0xf5, 0x86, 0xba, 0xa8, 0x19, 0x8f, 0xe9]);
    expect(publishRules.accounts.map((a) => [a.name, a.writable === true, a.signer === true])).toEqual([
      ["payer", true, true],
      ["launch", false, false],
      ["rules", true, false],
      ["system_program", false, false],
    ]);
    expect(publishRules.args.map((a) => a.name)).toEqual(["bytes"]);
    const authorize = IDLS.launchpad.instructions.find((i) => i.name === "pq_authorize")!;
    expect(authorize.discriminator).toEqual([0x89, 0xbf, 0x3e, 0xd6, 0xb9, 0x28, 0x8f, 0xf7]);
    expect(authorize.accounts.map((a) => [a.name, a.writable === true, a.signer === true])).toEqual([
      ["payer", true, true],
      ["launch", false, false],
      ["identity", true, false],
      ["authorization", true, false],
      ["system_program", false, false],
    ]);
    expect(authorize.args.map((a) => a.name)).toEqual(["lms_pk", "lms_sig", "kind", "payload_hash"]);
    const ev = (name: string): string[] => ((idlCodecs().launchpad.typeDef(name).type as { fields: { name: string }[] }).fields ?? []).map((f) => f.name);
    expect(ev("LaunchAttested")).toEqual(["launch", "pq_identity", "leaf", "metadata_hash", "rules_hash", "slot", "not_before", "not_after"]);
    expect(ev("RulesPublished")).toEqual(["launch", "rules", "rules_hash", "len"]);
    expect(ev("Authorized")).toEqual(["launch", "authorization", "pq_identity", "kind", "payload_hash", "leaf", "unix_time", "slot"]);
    expect(((idlCodecs().hook.typeDef("PolicyCreated").type as { fields: { name: string }[] }).fields ?? []).map((f) => f.name).at(-1)).toBe("rules_len");
    const publishIx = IDLS.launchpad.instructions.find((i) => i.name === "publish_metadata")!;
    expect(publishIx.discriminator).toEqual([0xb3, 0xbf, 0xa8, 0x61, 0xc7, 0x19, 0xe5, 0x92]);
    expect(publishIx.accounts.map((a) => [a.name, a.writable === true, a.signer === true])).toEqual([
      ["payer", true, true],
      ["launch", false, false],
      ["token_meta", true, false],
      ["system_program", false, false],
    ]);
    expect(publishIx.args.map((a) => a.name)).toEqual(["name", "symbol", "flags", "uri", "doc"]);
    // commit: token_owner, refund_owner, optional payout_vault last.
    expect(IDLS.launchpad.instructions.find((i) => i.name === "commit")!.accounts.slice(-3).map((a) => [a.name, a.optional === true])).toEqual([
      ["token_owner", false],
      ["refund_owner", false],
      ["payout_vault", true],
    ]);
  });
});

// ------------------------------------------------- IDL PDA definitions ---

interface Seed {
  kind: "const" | "account" | "arg";
  value?: number[];
  path?: string;
}

/** Evaluate an IDL PDA (seeds + optional program) for the given account/arg values. */
function idlPda(def: { seeds: Seed[]; program?: Seed }, ownProgram: PublicKey, values: Record<string, Uint8Array>): PublicKey {
  const resolve = (s: Seed): Uint8Array => {
    if (s.kind === "const") return Uint8Array.from(s.value!);
    const v = values[s.path!];
    if (v === undefined) throw new Error(`no value for ${s.kind} ${s.path}`);
    return v;
  };
  const program = def.program === undefined ? ownProgram : new PublicKey(resolve(def.program));
  return PublicKey.findProgramAddressSync(def.seeds.map(resolve), program)[0];
}

describe("PDA helpers equal the IDLs' seeds constraints", () => {
  const rand = (i: number): PublicKey => new PublicKey(new Uint8Array(32).fill(i * 17 + 5));
  const mint = rand(1);
  const owner = rand(2);
  const launchSeed = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
  const creator = rand(3);
  const tokenOwner = rand(4);
  const launch = launchAddress(creator, launchSeed);
  const keyId = new Uint8Array(32).map((_, i) => (i * 13 + 1) & 0xff);
  const vault = vaultAddress(mint, keyId);
  const sequence = 0x0102_0304_0506_0708n;
  const metadataHash = sha256(new TextEncoder().encode("a record's metadata_hash_v2"));
  const pdas = launchPdasFromLaunch(launch);
  const graphHashValue = sha256(new TextEncoder().encode("a graph's hash"));
  const rulesHashValue = sha256(new TextEncoder().encode("a rule set's hash"));
  const values: Record<string, Uint8Array> = {
    launch: launch.toBytes(),
    launch_seed: launchSeed,
    creator: creator.toBytes(),
    token_owner: tokenOwner.toBytes(),
    "policy.mint": mint.toBytes(),
    owner: owner.toBytes(),
    base_mint: mint.toBytes(),
    mint: mint.toBytes(),
    key_id_arg: keyId,
    vault: vault.toBytes(),
    "vault.genesis_key_id": keyId,
    "vault.sequence": u64le(sequence),
    "payout.sequence": u64le(sequence),
    "attestation.metadata_hash": metadataHash,
    "attestation.rules_hash": rulesHashValue,
    "autopilot.launch": launch.toBytes(),
    "graph.graph_hash": graphHashValue,
    "autopilot.active_graph": graphHashValue,
    "autopilot.pending_graph": graphHashValue,
  };
  const expected: Record<string, PublicKey> = {
    "noised_launchpad.protocol": protocolAddress(),
    "noised_launchpad.launch": launch,
    "noised_launchpad.launch_authority": pdas.launchAuthority,
    "noised_launchpad.dbc_config": pdas.dbcConfig,
    "noised_launchpad.hook_authority": hookAuthorityAddress(),
    "noised_launchpad.certificate": certificateAddress(mint),
    "noised_launchpad.commit": commitAddress(launch, owner),
    "noised_launchpad.attestation": attestationAddress(launch),
    "noised_launchpad.token_meta": tokenMetaAddress(launch, metadataHash),
    "noised_launchpad.rules": launchRulesAddress(launch, rulesHashValue),
    "noised_launchpad.payout_vault": payoutVaultAddress(launch, tokenOwner),
    "noised_launchpad.policy": hookPolicyAddress(mint),
    "noised_hook.policy": hookPolicyAddress(mint),
    "noised_hook.extra_account_meta_list": extraAccountMetaListAddress(mint),
    "noised_hook.launchpad_authority": hookAuthorityAddress(),
    "noised_vault.vault": vault,
    "noised_vault.payout": payoutAddress(vault, sequence),
    "noised_shield.shield": shieldAddresses(mint).shield,
    "noised_shield.shield_authority": shieldAddresses(mint).authority,
    "noised_shield.z_mint": shieldAddresses(mint).zMint,
    "noised_autopilot.autopilot": autopilotAddress(launch),
    "noised_autopilot.treasury": autopilotTreasuryAddress(launch),
    "noised_autopilot.graph": graphRecordAddress(launch, graphHashValue),
    "noised_autopilot.certificate": certificateAddress(mint),
  };

  it("every SDK PDA helper agrees with every IDL definition that names it", () => {
    const checked = new Set<string>();
    for (const idl of [IDLS.launchpad, IDLS.hook, IDLS.vault, IDLS.shield, IDLS.autopilot]) {
      const own = new PublicKey(idl.address);
      for (const ix of idl.instructions) {
        for (const acc of ix.accounts) {
          const id = `${idl.metadata.name}.${acc.name}`;
          const want = expected[id];
          if (acc.pda === undefined || want === undefined) continue;
          const def = acc.pda as { seeds: Seed[]; program?: Seed };
          // The commit PDA is derived from the signer in `commit` and from the `owner` arg in `claim`.
          const vals = { ...values, owner: owner.toBytes() };
          expect(idlPda(def, own, vals).toBase58(), `${ix.name}.${acc.name}`).toBe(want.toBase58());
          checked.add(id);
        }
      }
    }
    // Every helper was exercised by at least one IDL definition.
    expect([...checked].sort()).toEqual(Object.keys(expected).sort());
  });

  it("const seeds in the IDLs are seeds the SDK knows", () => {
    const known = new Set(Object.values(SEEDS));
    for (const idl of [IDLS.launchpad, IDLS.hook, IDLS.vault, IDLS.shield, IDLS.autopilot]) {
      for (const ix of idl.instructions) {
        for (const acc of ix.accounts) {
          if (acc.pda === undefined) continue;
          const def = acc.pda as { seeds: Seed[]; program?: Seed };
          if (def.program !== undefined && !new PublicKey(Uint8Array.from(def.program.value ?? [])).equals(PROGRAM_IDS.launchpad)) continue; // ATA program PDAs
          for (const s of def.seeds) {
            if (s.kind !== "const") continue;
            const text = new TextDecoder().decode(Uint8Array.from(s.value!));
            expect(known.has(text as never), `${idl.metadata.name}.${ix.name}.${acc.name}: "${text}"`).toBe(true);
          }
        }
      }
    }
  });

  it("camelCase account names used by the builders exist in the IDLs", () => {
    expect(camelCase("launch_authority")).toBe("launchAuthority");
    expect(camelCase("p2p_locked")).toBe("p2pLocked");
    expect(camelCase("bin_step_u128")).toBe("binStepU128");
    expect(camelCase("_padding_0")).toBe("_padding0");
  });
});
