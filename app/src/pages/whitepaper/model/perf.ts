/**
 * Measured compute units and transaction sizes (whitepaper sections 5, 10 and 13). Nothing here is modelled except
 * `launchCuBound`, which is the measured per-record base plus the measured cost of a bump-search step: every other
 * number is a LiteSVM 0.17 measurement against the mainnet DBC 0.2.1, DAMM v2, Token-2022 v11 and SPL Token (p-token)
 * binaries with the mainnet feature set and SBPF v3 builds. Three sources:
 *   "r1b"    the round-1b code, 2026-10-08, as published in docs/SPEC.md §3.9, docs/POST_QUANTUM.md §6 and docs/HOOKS.md §7;
 *   "v2"     the protocol-v2 integration build (post-quantum attestation, round-2 fixes), 2026-10-09, from the
 *            launchpad, integration and shield LiteSVM suites (ranges over every run that printed the instruction);
 *   "final"  the final programs with on-chain metadata (safety policy 3), 2026-10-09, after the metadata review fix:
 *            the "measured" lists of the on-chain metadata stage reports (META_RESULT: implementation, integration,
 *            LiteSVM and fix stages; the fix stage wins where they differ) and docs/AUDIT.md §11. Measured before
 *            audit round 3's F1 and F2 were merged; they add a few checks to attest_launch and to the hook's evaluate and
 *            are not re-measured here.
 * Ranges come from bump-search differences between random addresses and, for signature verification, from the
 * digest (the work depends on the message).
 */

export type Source = "r1b" | "v2" | "final";

export interface Measured {
  key: string;
  label: string;
  /** Program or path. */
  group: "launch" | "trade" | "vault" | "hook" | "shield";
  cuLo: number;
  cuHi: number;
  /** A typical (median or mean, as the note says) value when known. */
  cuMid?: number | undefined;
  /** Transaction size in bytes (serialized, as sent). */
  bytes?: number | undefined;
  /** Legacy (1,232-byte limit) or v1 (4,096-byte limit). */
  format: "legacy" | "v1";
  source: Source;
  note?: string | undefined;
}

export const MEASURED: readonly Measured[] = [
  { key: "create", label: "create_launch", group: "launch", cuLo: 57_163, cuHi: 60_602, bytes: 931, format: "legacy", source: "v2", note: "2-point preset curves; the largest accepted (8 points, 4 recipients, dynamic fee) is 83,777 CU and 1,107 bytes" },
  { key: "publish", label: "publish_metadata", group: "launch", cuLo: 12_668, cuHi: 23_799, cuMid: 15_364, bytes: 3_621, format: "v1", source: "final", note: "309 to 3,621 bytes; the typical record (1,244 bytes, a 672-byte PNG) is 1,460 bytes and 15,364 CU; the largest record (3,405 bytes) 3,621 bytes and 22,991-23,799 CU" },
  { key: "attest", label: "attest_launch", group: "launch", cuLo: 79_772, cuHi: 114_476, cuMid: 95_439, bytes: 3_005, format: "v1", source: "final", note: "every one of the vector identity's 1,024 leaves (mean 95,439 CU); 41 signatures with the largest metadata: 86,869-109,305 (median 97,063); worst-case projection at 990 chain steps 169,882; a constant 2,972 bytes for every record" },
  { key: "launch", label: "launch", group: "launch", cuLo: 148_672, cuHi: 221_107, bytes: 987, format: "legacy", source: "final", note: "every uri mode; a base per record (142,672 with no uri, 188,107 at the largest inline uri) plus 1,500 CU per extra bump-search step; a constant 987 bytes for every record" },
  { key: "commit", label: "commit", group: "launch", cuLo: 43_977, cuHi: 43_977, bytes: 685, format: "legacy", source: "v2", note: "naming two PQ vaults as payout owners; 39k-48k for a first commit on the final build" },
  { key: "execute", label: "execute_batch", group: "launch", cuLo: 120_657, cuHi: 167_613, bytes: 946, format: "legacy", source: "v2", note: "DBC swap 58-87k (hook 5,777), end_snipe_shield 13,653, escrow ATA 17,907-19,407, launchpad 45,764-59,287; 136k-160k on the final build" },
  { key: "claim", label: "claim (into two vaults)", group: "launch", cuLo: 63_986, cuHi: 63_986, bytes: 973, format: "legacy", source: "v2", note: "76k-117k for claims on the final build" },
  { key: "claimfees", label: "claim_fees", group: "launch", cuLo: 84_277, cuHi: 84_277, bytes: 779, format: "legacy", source: "v2" },
  { key: "distribute", label: "distribute", group: "launch", cuLo: 50_902, cuHi: 78_369, bytes: 746, format: "legacy", source: "v2", note: "50,902 CU when the treasury and a recipient are PQ vaults" },
  { key: "migrate", label: "migration_damm_v2 (DBC)", group: "launch", cuLo: 149_541, cuHi: 155_605, bytes: 1_107, format: "legacy", source: "final", note: "at the largest records: 151,105-155,605 CU with the largest inline uri (a 4,553-byte mint), 149,541 with a 200-byte external uri" },
  { key: "lpfees", label: "claim_lp_fees", group: "launch", cuLo: 46_935, cuHi: 46_935, bytes: 812, format: "legacy", source: "v2" },
  { key: "buy", label: "public DBC buy (hooked)", group: "trade", cuLo: 58_953, cuHi: 59_233, bytes: 867, format: "legacy", source: "v2", note: "the hook's share is 3,207 CU; also into a PQ vault; 53k-65k on the final build" },
  { key: "dammbuy", label: "DAMM v2 buy into a vault", group: "trade", cuLo: 19_824, cuHi: 19_824, bytes: 695, format: "legacy", source: "v2", note: "after graduation: no hook" },
  { key: "withdraw", label: "vault withdraw", group: "vault", cuLo: 79_000, cuHi: 106_000, bytes: 2_693, format: "v1", source: "r1b", note: "26 runs; LM-OTS verification dominates; 2,777 bytes as a (non-sendable) legacy encoding" },
  { key: "release", label: "vault release, SPL Token", group: "vault", cuLo: 34_000, cuHi: 58_000, bytes: 522, format: "v1", source: "r1b", note: "creating the recipient's ATA" },
  { key: "release22", label: "vault release, Token-2022 + hook", group: "vault", cuLo: 63_000, cuHi: 97_000, bytes: 654, format: "v1", source: "r1b" },
  { key: "wr", label: "withdraw + release, SPL", group: "vault", cuLo: 121_000, cuHi: 172_000, bytes: 2_845, format: "v1", source: "r1b" },
  { key: "wr22", label: "withdraw + release, T-2022 + hook", group: "vault", cuLo: 145_000, cuHi: 190_000, bytes: 2_977, format: "v1", source: "r1b" },
  { key: "t22", label: "transfer, Token-2022 + Launch Guard", group: "hook", cuLo: 15_878, cuHi: 23_378, format: "legacy", source: "r1b", note: "every rule evaluated; the hook's own execute is 3,228 CU; plain Token-2022 is 2,046" },
  { key: "endshield", label: "end_snipe_shield (CPI)", group: "hook", cuLo: 11_847, cuHi: 13_653, format: "legacy", source: "v2" },
  { key: "createshield", label: "create_shield", group: "shield", cuLo: 68_501, cuHi: 94_166, format: "legacy", source: "v2", note: "76.8k-94.8k for a base mint with a 4,125-byte uri on the final build" },
  { key: "wrap", label: "shield wrap / unwrap (launch token)", group: "shield", cuLo: 49_373, cuHi: 58_637, format: "legacy", source: "r1b", note: "through the hook; 19,138 / 19,402 CU for an SPL Token base; 46.4k-49.7k with a 4,125-byte-uri base mint on the final build" },
];

/**
 * `launch` compute on the final build: a constant base per record (measured, within 8 CU over 18 launches) plus
 * 1,500 CU per extra bump-search step of the six mint-derived addresses. More than 47 extra steps has probability
 * below one in a million.
 */
export const LAUNCH_CU = {
  base: { none: 142_672, inline: 188_107, external: 143_996 },
  perExtraStep: 1_500,
  rareSteps: 47,
  /** The SDK's limit (`COMPUTE_UNITS.launch`). */
  limit: 300_000,
} as const;

/** The `launch` compute of a record with base `base` after `steps` extra bump-search steps. */
export function launchCuBound(base: number, steps: number): number {
  return base + LAUNCH_CU.perExtraStep * steps;
}

/** Sizes and rents of the final build (bytes; lamports at mainnet's 5,080 per byte unless noted). */
export const FINAL_SIZES = {
  attestTx: 3_005,
  launchTx: 987,
  launchCommitV1: 1_149,
  publishTx: { min: 309, typical: 1_460, max: 3_621 },
  tokenMeta: { fixed: 91, min: 93, typical: 1_244, max: 3_405 },
  attestation: 2_708,
  certificate: 519,
  identity: 196,
  mintBase: 386,
  maxInlineUri: 4_125,
  dbcMaxUri: 8_685,
  rent: { typicalRecord: 6_969_760, largestRecord: 17_947_640, firstAttestation: 16_057_800 },
} as const;

/** Mainnet rent-exempt balance of an account of `size` bytes: (128 + size) x 5,080 lamports. */
export function mainnetRent(size: number): number {
  return (128 + size) * 5_080;
}

/** Test results quoted in section 12. */
export const TESTS = {
  r1b: {
    date: "2026-10-08",
    host: 78,
    lmots: 12,
    integration: 64,
    mutantsKilled: 59,
    mutantsTotal: 59,
    launchpadSvm: 17,
    shieldSvm: 13,
    sdk: 225,
  },
  v2: {
    date: "2026-10-09",
    hostLaunchpad: 64,
    hostHook: 19,
    hostShield: 17,
    hostVault: 6,
    lmotsUnit: 8,
    lmotsKat: 10,
    lmsTests: 16,
    integration: 84,
    launchpadSvm: 46,
    shieldSvm: 13,
    itMutantsKilled: 102,
    itMutantsTotal: 102,
    lmsMutantsKilled: 31,
    lmsMutantsTotal: 31,
    /** SDK 0.3, the same day. */
    sdk: 467,
  },
  /** The final programs (docs/AUDIT.md §11, final verification) and SDK 0.4.0. */
  final: {
    date: "2026-10-09",
    host: 151,
    kat: 35,
    integration: 98,
    launchpadSvm: 59,
    shieldSvm: 17,
    itMutantsKilled: 148,
    itMutantsTotal: 148,
    svmMutantsKilled: 23,
    svmMutantsTotal: 23,
    sdk: 545,
    sdkMutantsKilled: 128,
    sdkMutantsTotal: 131,
  },
} as const;

/** LMS verification compute, measured fit on SBF (lms.rs docs): 8,674 + 137 * chain steps, residual <= 14 CU. */
export function lmsVerifyCU(steps: number): number {
  return 8_674 + 137 * steps;
}

/** sol_sha256 syscall price per call: 85 + sum over slices of max(10, floor(len / 2)) (FACTS #5). */
export function sha256SyscallCU(sliceLens: readonly number[]): number {
  return 85 + sliceLens.reduce((a, l) => a + Math.max(10, Math.floor(l / 2)), 0);
}
