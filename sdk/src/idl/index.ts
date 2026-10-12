/**
 * The seven IDLs this SDK encodes and decodes with:
 *
 * - `noised_vault.json` (vault v4, key-index binding), `noised_hook.json`
 *   (`end_snipe_shield`), `noised_launchpad.json` (PQ v2: `attest_launch`,
 *   creator-seeded launches, payout owners and payout vaults; on-chain
 *   metadata: `publish_metadata`, `TokenMeta`, attestation message v2,
 *   `launch` without arguments), `noised_shield.json`: generated from
 *   programs/ with anchor-cli 1.2.1 after the PQ v2 fix stage (the launchpad
 *   after the metadata fix stage):
 *   `anchor idl build -p noised_vault|noised_hook|noised_launchpad|noised_shield -o <file>`
 *   (see CONTRIBUTING.md).
 * - `noised_autopilot.json`: the autopilot program (PXG1 graphs, treasury
 *   runs), generated with anchor-cli 1.2.1 from programs/noised-autopilot
 *   (the copy in idls/).
 * - `dynamic_bonding_curve.json` (DBC 0.2.1) and `cp_amm.json` (DAMM v2): the
 *   vendored copies in idls/, taken from Meteora's MIT-licensed SDKs. The
 *   launchpad program declares its CPI interface from the same files.
 */
import { IdlCodec, type Idl } from "../codec/idl.js";
import autopilotJson from "./noised_autopilot.json" with { type: "json" };
import cpAmmJson from "./cp_amm.json" with { type: "json" };
import dbcJson from "./dynamic_bonding_curve.json" with { type: "json" };
import hookJson from "./noised_hook.json" with { type: "json" };
import launchpadJson from "./noised_launchpad.json" with { type: "json" };
import shieldJson from "./noised_shield.json" with { type: "json" };
import vaultJson from "./noised_vault.json" with { type: "json" };

export const IDLS = {
  launchpad: launchpadJson as unknown as Idl,
  hook: hookJson as unknown as Idl,
  vault: vaultJson as unknown as Idl,
  shield: shieldJson as unknown as Idl,
  autopilot: autopilotJson as unknown as Idl,
  dbc: dbcJson as unknown as Idl,
  dammV2: cpAmmJson as unknown as Idl,
} as const;

let codecs: Readonly<Record<keyof typeof IDLS, IdlCodec>> | null = null;

/** Lazily built codecs, one per IDL. */
export function idlCodecs(): Readonly<Record<keyof typeof IDLS, IdlCodec>> {
  if (codecs === null) {
    codecs = {
      launchpad: new IdlCodec(IDLS.launchpad),
      hook: new IdlCodec(IDLS.hook),
      vault: new IdlCodec(IDLS.vault),
      shield: new IdlCodec(IDLS.shield),
      autopilot: new IdlCodec(IDLS.autopilot),
      dbc: new IdlCodec(IDLS.dbc),
      dammV2: new IdlCodec(IDLS.dammV2),
    };
  }
  return codecs;
}
