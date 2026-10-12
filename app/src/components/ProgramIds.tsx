import { PublicKey } from "@solana/web3.js";
import { useMemo, type ReactNode } from "react";

import { useNetwork } from "../app/network";
import { ADAPTER_MODE, KNOWN_ACCOUNTS, PROGRAM_IDS, WSOL_MINT, type ProgramStatus } from "../lib/noised";
import { Chip, PixelMark } from "../pages/inner/kit";
import { Address } from "./ui";

export const PROGRAM_ROWS: { label: string; note: string; id: string }[] = [
  { label: "Noised launchpad", note: "launches, fair-open batch, fee routing, certificates", id: PROGRAM_IDS.launchpad.toBase58() },
  { label: "Noised Launch Guard hook", note: "transfer hook while the curve runs", id: PROGRAM_IDS.hook.toBase58() },
  { label: "Noised PQ vault", note: "LM-OTS (RFC 8554) vaults", id: PROGRAM_IDS.vault.toBase58() },
  { label: "Noised shield", note: "zToken wrapper with confidential balances", id: PROGRAM_IDS.shield.toBase58() },
  { label: "Meteora DBC", note: "bonding curve (third party, upgradeable)", id: PROGRAM_IDS.dbc.toBase58() },
  { label: "Meteora DAMM v2", note: "graduated pools (third party, upgradeable)", id: PROGRAM_IDS.dammV2.toBase58() },
  { label: "Token-2022", note: "token program (upgradeable by multisig)", id: KNOWN_ACCOUNTS.token2022.toBase58() },
  { label: "SPL Token", note: "token program of wSOL", id: KNOWN_ACCOUNTS.splToken.toBase58() },
  { label: "wSOL mint", note: "quote token of every launch", id: WSOL_MINT.toBase58() },
];

/**
 * Every program id the app talks to, each with its mark (the same identicon as everywhere else: white for
 * Noised's own programs, grey for third parties), copy buttons, explorer links and (with `status`) the live
 * deployment state.
 */
export function ProgramIdList({ full = false, status = false }: { full?: boolean; status?: boolean }): ReactNode {
  const rows = useMemo(() => PROGRAM_ROWS.map((r) => ({ ...r, key: new PublicKey(r.id), own: r.label.startsWith("Noised") })), []);
  return (
    <ul className="pgx pg-progs" aria-label="Programs and accounts this app may use">
      {rows.map((r) => (
        <li key={r.id} className="pg-prog">
          <PixelMark address={r.key} size={40} ink={r.own ? "--text" : "--text-dim"} />
          <div className="pg-prog-name">
            <span className="pg-prog-label">{r.label}</span>
            {full ? <span className="pg-prog-note">{r.note}</span> : null}
          </div>
          <div className="pg-prog-id">
            <Address value={r.id} full={full} explorer />
            {status ? <DeploymentStatus id={r.id} /> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function DeploymentStatus({ id }: { id: string }): ReactNode {
  const { programs, programsError } = useNetwork();
  if (id === WSOL_MINT.toBase58()) return null;
  if (ADAPTER_MODE === "mock") return <p className="pg-prog-status">simulated chain</p>;
  if (programsError !== null) return <p className="pg-prog-status pg-warn">status unreadable: {programsError}</p>;
  const p = programs?.find((x) => x.programId.toBase58() === id);
  if (p === undefined) return <p className="pg-prog-status">checking the cluster…</p>;
  return <p className="pg-prog-status">{describe(p)}</p>;
}

function describe(p: ProgramStatus): ReactNode {
  if (p.state === "missing") return <Chip tone="warn">not deployed on this cluster</Chip>;
  if (p.state === "not-executable") return <Chip tone="danger">account exists but is not executable</Chip>;
  if (p.state === "unreadable") return <Chip tone="warn">deployed; upgrade state unreadable</Chip>;
  if (p.upgradeable === false && p.upgradeAuthority === null && p.lastDeploySlot === null) {
    return <Chip tone="ok">deployed, not upgradeable (loader {p.loader?.toBase58().slice(0, 8) ?? "?"}…)</Chip>;
  }
  const slot = p.lastDeploySlot === null ? "" : `last deployed at slot ${p.lastDeploySlot.toLocaleString("en-US")}`;
  if (p.upgradeAuthority === null) {
    return (
      <>
        <Chip tone="ok">deployed, immutable</Chip> <span>{slot}</span>
      </>
    );
  }
  return (
    <>
      <Chip tone="warn">upgradeable</Chip> <span>by</span> <Address value={p.upgradeAuthority} explorer /> <span>{slot}</span>
    </>
  );
}
