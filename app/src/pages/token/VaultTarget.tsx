/**
 * "Send it to my quantum vault": the token page's choice to receive a batch
 * share or a buy straight into the user's PQ vault (vault account #0 of the
 * quantum key, for the launch's token) instead of the wallet. Only an
 * opened vault can receive (the launchpad and the SDK refuse an unopened
 * one), so it offers to open it first.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router";

import { useAsync } from "../../app/hooks";
import { CLUSTER } from "../../app/settings";
import { useTx } from "../../app/tx";
import { useOwner } from "../../app/wallet";
import { Address, Button } from "../../components/ui";
import { buildOpenVaultTx, fetchVault } from "../../lib/noised";
import { usePqKey, vaultPublicKey } from "../../lib/pqKey";
import { Reason, Toggle } from "../inner/kit";

export interface VaultTargetState {
  /** The quantum key is locked: the vault's address is unknown. */
  locked: boolean;
  /** Vault account #0 of the quantum key for this mint (null while locked). */
  vault: PublicKey | null;
  /** The vault is open on chain (null while reading). */
  opened: boolean | null;
  reload: () => void;
}

/** The user's vault for `mint` (account #0), when the quantum key is unlocked. */
export function useVaultTarget(mint: PublicKey): VaultTargetState {
  const { connection } = useConnection();
  const key = usePqKey();
  const genesis = useMemo(() => (key.status === "unlocked" ? vaultPublicKey(CLUSTER, mint, 0) : null), [key, mint]);
  const vault = genesis?.vault ?? null;
  const info = useAsync(() => (vault === null ? Promise.resolve(null) : fetchVault(connection, vault)), [connection, vault?.toBase58()], { enabled: vault !== null });
  return { locked: genesis === null, vault, opened: vault === null || info.loading ? null : info.data !== null && info.data !== undefined, reload: info.reload };
}

/**
 * The toggle and what it needs: unlock the key, open the vault. `fixed`:
 * the destination can no longer change (a batch commit's first commit fixed
 * it), shown read-only.
 */
export function VaultChoice({
  mint,
  symbol,
  target,
  checked,
  onChange,
  label,
  fixed = false,
}: {
  mint: PublicKey;
  symbol: string;
  target: VaultTargetState;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  fixed?: boolean;
}): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const me = owner.publicKey;
  return (
    <div className="tk-vault-choice">
      <Toggle checked={checked} onChange={fixed ? () => undefined : onChange}>
        {label}
      </Toggle>
      {checked && target.locked ? (
        <Reason>
          <Link to="/vault" className="link">
            Unlock your quantum key
          </Link>{" "}
          to use your vault.
        </Reason>
      ) : null}
      {checked && target.vault !== null && target.opened === false ? (
        <div className="pg-stack-sm">
          <p className="pg-note">Your {symbol} vault is not open yet: open it once, then it can receive.</p>
          <Button
            size="sm"
            className="pg-self-start"
            disabled={!me}
            onClick={() => {
              if (!me || target.locked) return;
              const genesis = vaultPublicKey(CLUSTER, mint, 0);
              void run({
                title: `Open your ${symbol} vault`,
                summary: [`Creates your quantum vault for ${symbol} and its deposit account. Only your quantum key can move tokens out of it.`, "You pay its rent once."],
                build: () => buildOpenVaultTx(connection, me, mint, genesis.pk),
              }).then(() => target.reload());
            }}
          >
            Open my vault
          </Button>
        </div>
      ) : null}
      {checked && target.vault !== null && target.opened === true ? (
        <p className="pg-note">
          Goes to your vault <Address value={target.vault} />: only your quantum key can move it out.
        </p>
      ) : null}
    </div>
  );
}
