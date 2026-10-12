/**
 * MOCK mint registry: what the simulated chain knows about each mint (owner
 * program, authorities, Token-2022 extensions). Noised launch mints and
 * zToken mints are derived from the mock state; the demo mints below exist
 * only to exercise `checkVaultMint` (eligible, warned and refused cases).
 */
import { KNOWN_ACCOUNTS, PROGRAM_IDS, shieldAddresses, WSOL_MINT } from "@noisedlabs/sdk";
import type { PublicKey } from "@solana/web3.js";

import type { MintInfo } from "../backend/types";
import { demoKey } from "./keys";
import type { MockState } from "./store";

export type MockExtension =
  | { type: "MetadataPointer"; authority: PublicKey | null; address: PublicKey }
  | { type: "TokenMetadata"; updateAuthority: PublicKey | null }
  | { type: "TransferHook"; programId: PublicKey | null; authority: PublicKey | null }
  | { type: "TransferFeeConfig"; configAuthority: PublicKey | null; withdrawAuthority: PublicKey | null; feeBps: number }
  | { type: "PermanentDelegate"; delegate: PublicKey }
  | { type: "NonTransferable" }
  | { type: "Pausable"; authority: PublicKey | null; paused: boolean }
  | { type: "DefaultAccountState"; frozen: boolean }
  | { type: "MintCloseAuthority"; authority: PublicKey | null }
  | { type: "ConfidentialTransferMint"; authority: PublicKey | null; auditor: boolean };

export interface MockMint {
  address: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  supply: bigint;
  mintAuthority: PublicKey | null;
  freezeAuthority: PublicKey | null;
  extensions: MockExtension[];
  symbol: string;
  name: string;
  /** Demo-only mint (not a Noised launch, zToken or wSOL). */
  demo: boolean;
}

const T22 = KNOWN_ACCOUNTS.token2022;
const SPL = KNOWN_ACCOUNTS.splToken;

/** Demo mints that cover every branch of `open_vault`'s mint policy. */
export const DEMO_MINTS: readonly MockMint[] = [
  {
    address: demoKey("mint/demo-usd"),
    tokenProgram: SPL,
    decimals: 6,
    supply: 25_000_000_000_000n,
    mintAuthority: demoKey("authority/demo-usd"),
    freezeAuthority: demoKey("authority/demo-usd-freeze"),
    extensions: [],
    symbol: "dUSD",
    name: "Demo Dollar (freezable stablecoin)",
    demo: true,
  },
  {
    address: demoKey("mint/demo-pausable"),
    tokenProgram: T22,
    decimals: 9,
    supply: 1_000_000_000_000_000n,
    mintAuthority: null,
    freezeAuthority: null,
    extensions: [{ type: "Pausable", authority: demoKey("authority/demo-pause"), paused: false }],
    symbol: "dPAU",
    name: "Demo Pausable",
    demo: true,
  },
  {
    address: demoKey("mint/demo-delegate"),
    tokenProgram: T22,
    decimals: 6,
    supply: 9_000_000_000_000n,
    mintAuthority: null,
    freezeAuthority: null,
    extensions: [{ type: "PermanentDelegate", delegate: demoKey("authority/demo-delegate") }],
    symbol: "dPDG",
    name: "Demo Permanent Delegate",
    demo: true,
  },
  {
    address: demoKey("mint/demo-fee"),
    tokenProgram: T22,
    decimals: 6,
    supply: 4_000_000_000_000n,
    mintAuthority: null,
    freezeAuthority: null,
    extensions: [{ type: "TransferFeeConfig", configAuthority: demoKey("authority/demo-fee"), withdrawAuthority: demoKey("authority/demo-fee"), feeBps: 100 }],
    symbol: "dFEE",
    name: "Demo Transfer Fee (live authority)",
    demo: true,
  },
  {
    address: demoKey("mint/demo-soulbound"),
    tokenProgram: T22,
    decimals: 0,
    supply: 500n,
    mintAuthority: demoKey("authority/demo-soulbound"),
    freezeAuthority: null,
    extensions: [{ type: "NonTransferable" }],
    symbol: "dSBT",
    name: "Demo Soulbound",
    demo: true,
  },
  {
    address: demoKey("mint/demo-closable"),
    tokenProgram: T22,
    decimals: 6,
    supply: 2_000_000_000_000n,
    mintAuthority: null,
    freezeAuthority: null,
    extensions: [{ type: "MintCloseAuthority", authority: demoKey("authority/demo-close") }],
    symbol: "dCLS",
    name: "Demo Closable (close authority)",
    demo: true,
  },
];

const WSOL: MockMint = {
  address: WSOL_MINT,
  tokenProgram: SPL,
  decimals: 9,
  supply: 0n,
  mintAuthority: null,
  freezeAuthority: null,
  extensions: [],
  symbol: "wSOL",
  name: "Wrapped SOL",
  demo: false,
};

/** Everything the mock chain knows about `mint`, or null if no such mint exists. */
export function mockMint(s: MockState, mint: PublicKey): MockMint | null {
  if (mint.equals(WSOL_MINT)) return WSOL;
  const demo = DEMO_MINTS.find((m) => m.address.equals(mint));
  if (demo) return demo;
  for (const l of Object.values(s.launches)) {
    if (l.state.status !== "live" || !l.state.baseMint.equals(mint) || l.meta === null) continue;
    const graduated = l.curveComplete;
    return {
      address: mint,
      tokenProgram: T22,
      decimals: l.state.tokenDecimal,
      supply: l.initialSupply,
      mintAuthority: null,
      freezeAuthority: null,
      extensions: [
        { type: "MetadataPointer", authority: null, address: mint },
        { type: "TokenMetadata", updateAuthority: null },
        // DBC revokes the hook (program and authority) in the swap that completes the curve.
        { type: "TransferHook", programId: graduated ? null : PROGRAM_IDS.hook, authority: graduated ? null : KNOWN_ACCOUNTS.dbcPoolAuthority },
      ],
      symbol: l.meta.symbol,
      name: l.meta.name,
      demo: false,
    };
  }
  for (const sh of Object.values(s.shields)) {
    if (!sh.account.zMint.equals(mint)) continue;
    const base = mockMint(s, sh.account.baseMint);
    const symbol = `z${base?.symbol ?? "TOKEN"}`.slice(0, 10);
    return {
      address: mint,
      tokenProgram: T22,
      decimals: sh.account.decimals,
      supply: sh.zSupply,
      // Only `wrap` ever mints, signed by the shield authority PDA.
      mintAuthority: shieldAuthorityOf(sh.account.baseMint),
      freezeAuthority: null,
      extensions: [
        { type: "ConfidentialTransferMint", authority: null, auditor: false },
        { type: "MetadataPointer", authority: null, address: mint },
        { type: "TokenMetadata", updateAuthority: null },
      ],
      symbol,
      name: `Shielded ${base?.name ?? "token"}`.slice(0, 32),
      demo: false,
    };
  }
  return null;
}

function shieldAuthorityOf(baseMint: PublicKey): PublicKey {
  return shieldAddresses(baseMint).authority;
}

export function toMintInfo(m: MockMint): MintInfo {
  return { address: m.address, tokenProgram: m.tokenProgram, decimals: m.decimals, supply: m.supply, symbol: m.symbol, name: m.name };
}

const fmt = (k: PublicKey): string => k.toBase58();

/**
 * Mint powers that can delay a payout (the SDK's `releaseDelayWarnings`):
 * freeze, pause, a transfer hook and default-frozen accounts. None of them
 * can block `withdraw`, which moves no token.
 */
export function payoutDelayWarnings(m: MockMint): string[] {
  const warnings: string[] = [];
  if (m.freezeAuthority !== null) {
    warnings.push(`Freeze authority ${fmt(m.freezeAuthority)} can freeze the vault's or the recipient's token account and delay payouts until thawed.`);
  }
  for (const e of m.extensions) {
    if (e.type === "Pausable") {
      warnings.push(`Pause authority ${e.authority ? fmt(e.authority) : "(none)"} can halt all transfers of this token and delay payouts${e.paused ? "; the mint is paused right now" : ""}.`);
    } else if (e.type === "TransferHook") {
      if (e.programId !== null) {
        warnings.push(`Transfer hook program ${fmt(e.programId)} runs on every transfer and can refuse a payout for a while (the payout stays reserved; release it later, never re-sign).`);
      }
      if (e.authority !== null) warnings.push(`Transfer-hook authority ${fmt(e.authority)} can ${e.programId === null ? "install" : "replace"} the hook program.`);
    } else if (e.type === "DefaultAccountState" && e.frozen) {
      warnings.push("New token accounts start frozen: a recipient's new account must be thawed by the freeze authority before a payout can land.");
    }
  }
  return warnings;
}

/**
 * Line for line with programs/noised-vault/src/token.rs `require_supported_mint`
 * (refusals), plus the warnings SPEC §3.5 asks clients to show, in the
 * SDK's `vaultMintPolicy` order. Freeze, pause and hooks can only delay a
 * payout; none of them can block `withdraw` or take vaulted tokens.
 */
export function vaultMintPolicy(m: MockMint, ctx: { guardEndTs: bigint | null; p2pLocked: boolean; nowSecs: number }): { refusals: string[]; warnings: string[] } {
  const refusals: string[] = [];
  const warnings: string[] = [];
  if (!m.tokenProgram.equals(T22) && !m.tokenProgram.equals(SPL)) {
    refusals.push(`Not a token mint: owned by ${fmt(m.tokenProgram)}.`);
    return { refusals, warnings };
  }
  const ext = <T extends MockExtension["type"]>(type: T): Extract<MockExtension, { type: T }> | undefined =>
    m.extensions.find((e) => e.type === type) as Extract<MockExtension, { type: T }> | undefined;

  // The refusals of `require_supported_mint`.
  if (ext("NonTransferable")) refusals.push("NonTransferable: tokens could never leave the vault.");
  const delegate = ext("PermanentDelegate");
  if (delegate) refusals.push(`PermanentDelegate (${fmt(delegate.delegate)}): an Ed25519 key could move tokens out of any account, the vault's included.`);
  const close = ext("MintCloseAuthority");
  if (close?.authority) {
    refusals.push(
      `MintCloseAuthority ${fmt(close.authority)}: at zero supply the mint could be closed and re-created at the same address with a permanent delegate, which would drain the vault.`,
    );
  }
  const fee = ext("TransferFeeConfig");
  if (fee) {
    if (fee.configAuthority !== null) refusals.push(`TransferFeeConfig authority ${fmt(fee.configAuthority)} could raise the fee to 100% and take payouts.`);
    if (fee.withdrawAuthority !== null) refusals.push(`Withdraw-withheld authority ${fmt(fee.withdrawAuthority)} could collect fees withheld from the vault's transfers.`);
    if (fee.configAuthority === null && fee.withdrawAuthority === null && fee.feeBps > 0) {
      warnings.push(`A fixed transfer fee of up to ${fee.feeBps} bps applies to deposits and payouts; no authority can change it.`);
    }
  }

  // Powers that can dilute or delay a payout.
  if (m.mintAuthority !== null) warnings.push(`Mint authority ${fmt(m.mintAuthority)} can mint more tokens (dilution); it cannot take vaulted tokens.`);
  if (m.freezeAuthority !== null) {
    warnings.push(`Freeze authority ${fmt(m.freezeAuthority)} can freeze the vault's or the recipient's token account and delay payouts until thawed.`);
  }
  const pause = ext("Pausable");
  if (pause) {
    warnings.push(`Pause authority ${pause.authority ? fmt(pause.authority) : "(none)"} can halt all transfers of this token and delay payouts${pause.paused ? "; the mint is paused right now" : ""}.`);
  }
  const hook = ext("TransferHook");
  if (hook?.programId) {
    if (hook.programId.equals(PROGRAM_IDS.hook)) {
      const until = ctx.guardEndTs === null ? "" : ` until ${new Date(Number(ctx.guardEndTs) * 1000).toISOString().replace(".000Z", "Z")}`;
      const paused = ctx.guardEndTs !== null && BigInt(ctx.nowSecs) < ctx.guardEndTs && ctx.p2pLocked;
      warnings.push(
        `Transfer hook: the Noised Launch Guard runs on every transfer until graduation; its rules end with the guard${until}.` +
          (paused
            ? " Wallet-to-wallet transfers are paused right now, so deposits into a vault and payout deliveries are refused until the guard ends; a withdrawal still executes and reserves its payout."
            : "") +
          " A hook can only refuse or delay a transfer; it cannot take tokens.",
      );
    } else {
      warnings.push(`Transfer hook program ${fmt(hook.programId)} runs on every transfer and can refuse a payout for a while (the payout stays reserved; release it later, never re-sign).`);
    }
    if (hook.authority !== null) warnings.push(`Transfer-hook authority ${fmt(hook.authority)} can replace the hook program.`);
  }
  if (ext("DefaultAccountState")?.frozen === true) {
    warnings.push("New token accounts start frozen: a recipient's new account must be thawed by the freeze authority before a payout can land.");
  }
  if (ext("ConfidentialTransferMint")) warnings.push("Confidential balances: a vault holds only public balance. Move tokens to your public balance before depositing.");
  if (m.tokenProgram.equals(T22)) warnings.push("Token-2022 is upgradeable by a 4-of-6 multisig of Ed25519 keys; SPL Token mints (e.g. wSOL) give the strongest custody.");
  return { refusals, warnings };
}
