/** BPF upgradeable loader (loader-v3) account layouts: Program and ProgramData. */
import { PublicKey } from "@solana/web3.js";

import { KNOWN_ACCOUNTS } from "../constants.js";
import type { RawAccount } from "./fetch.js";

export interface UpgradeableProgramInfo {
  program: PublicKey;
  executable: boolean;
  programData: PublicKey;
  /** Slot of the last deploy or upgrade. */
  lastDeploySlot: bigint;
  /** None once finalized (`solana program set-upgrade-authority --final`). */
  upgradeAuthority: PublicKey | null;
}

/** Program account: `u32 LE 2 (Program) || programdata address`. */
export function parseProgramAccount(acc: RawAccount): PublicKey {
  if (!acc.owner.equals(KNOWN_ACCOUNTS.bpfLoaderUpgradeable)) throw new Error(`${acc.address.toBase58()} is not owned by the upgradeable loader`);
  if (acc.data.length < 36) throw new Error("program account too short");
  const tag = new DataView(acc.data.buffer, acc.data.byteOffset, 4).getUint32(0, true);
  if (tag !== 2) throw new Error(`${acc.address.toBase58()} is not a loader-v3 program account (tag ${tag})`);
  return new PublicKey(acc.data.slice(4, 36));
}

/** ProgramData: `u32 LE 3 || slot u64 LE || Option<Pubkey> upgrade authority || ELF`. */
export function parseProgramData(acc: RawAccount): { lastDeploySlot: bigint; upgradeAuthority: PublicKey | null } {
  if (!acc.owner.equals(KNOWN_ACCOUNTS.bpfLoaderUpgradeable)) throw new Error("ProgramData is not owned by the upgradeable loader");
  if (acc.data.length < 45) throw new Error("ProgramData account too short");
  const view = new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength);
  const tag = view.getUint32(0, true);
  if (tag !== 3) throw new Error(`not a ProgramData account (tag ${tag})`);
  const option = acc.data[12]!;
  if (option > 1) throw new Error("invalid upgrade-authority option tag");
  return {
    lastDeploySlot: view.getBigUint64(4, true),
    upgradeAuthority: option === 1 ? new PublicKey(acc.data.slice(13, 45)) : null,
  };
}

export function upgradeableProgramInfo(program: RawAccount, programData: RawAccount): UpgradeableProgramInfo {
  const pd = parseProgramAccount(program);
  if (!pd.equals(programData.address)) throw new Error("ProgramData address does not match the program account");
  return { program: program.address, executable: program.executable, programData: pd, ...parseProgramData(programData) };
}
