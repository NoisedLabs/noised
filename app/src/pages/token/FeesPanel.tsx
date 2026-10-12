/** Where the trading fees go (fixed at launch), and the buttons anyone can press to move them along. */
import { useConnection } from "@solana/wallet-adapter-react";
import type { CSSProperties, ReactNode } from "react";

import { useTx } from "../../app/tx";
import { useOwner } from "../../app/wallet";
import { Address, Button } from "../../components/ui";
import { autopilotTreasuryAddress, buildClaimFeesTx, buildClaimLpFeesTx, buildDistributeTx, type LaunchAccount } from "../../lib/noised";
import { Comment, Fold, Readout, Row } from "../inner/kit";

export function FeesPanel({ launch, symbol }: { launch: LaunchAccount; symbol: string }): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const me = owner.publicKey;

  /**
   * The SDK builds one transaction per liquidity position that has fees (anyone may give the launch more
   * positions, so one transaction each keeps every claim small and lets one failing position never block the
   * others). Each is reviewed on its own: claim the first, then build again for the ones left.
   */
  const claimLpFees = async (): Promise<void> => {
    if (!me) return;
    let total: number | null = null;
    for (let done = 0; total === null || done < total; done++) {
      let left = 0;
      const o = await run({
        title: total === null || total === 1 ? "Claim LP fees from DAMM v2" : `Claim LP fees from DAMM v2 (${done + 1} of ${total})`,
        summary: [
          "Claims the fees earned by one of the launch authority's permanently locked DAMM v2 positions (wSOL and the launched token).",
          "The locked liquidity itself never moves. Permissionless.",
        ],
        build: async () => {
          let txs: Awaited<ReturnType<typeof buildClaimLpFeesTx>>;
          try {
            txs = await buildClaimLpFeesTx(connection, me, launch.publicKey);
          } catch (e) {
            throw new Error(/no launch-authority LP position has fees/.test(e instanceof Error ? e.message : "") ? "There are no liquidity fees to claim right now." : e instanceof Error ? e.message : String(e));
          }
          left = txs.length;
          total ??= txs.length;
          const first = txs[0];
          if (first === undefined) throw new Error("There are no liquidity fees to claim right now.");
          return { tx: first, notice: txs.length > 1 ? `${txs.length} positions have fees: this claims the first one, and the next follows once it is confirmed.` : null };
        },
      });
      if (o.status !== "confirmed" || left <= 1) break;
    }
  };
  const recipients = launch.recipients.slice(0, launch.recipientCount);
  // The launch's own Autopilot treasury, when it is a recipient: its share goes back into the token (buybacks that burn).
  const treasury = autopilotTreasuryAddress(launch.publicKey);
  const migrated = launch.market?.migrated === true;
  const creatorShare = 100 - launch.platformFeeBps / 100;

  return (
    <Fold id="fees" label="Where the fees go" status={`treasury + ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`}>
      <p className="pg-text">
        <strong>Fixed when the launch was created: nobody can change the recipients or their shares.</strong> Trading fees (in wSOL) collect at the launch
        authority, a program address no key controls. {launch.platformFeeBps / 100}% goes to the Noised treasury (the share recorded when the launch was
        created); the other {creatorShare}% is split between the recipients below. {symbol} received as liquidity fees after graduation is burned, never sold.
      </p>
      <div className="tk-split" aria-hidden="true" style={{ "--t": launch.platformFeeBps / 10_000 } as CSSProperties}>
        <span className="tk-split-bar">
          <i data-k="treasury" />
          <i data-k="creator" />
        </span>
        <span className="tk-split-legend">
          <span data-k="treasury">Treasury {launch.platformFeeBps / 100}%</span>
          <span data-k="creator">Creator share {creatorShare}%</span>
        </span>
      </div>
      <Readout label="Fee recipients" className="pg-well">
        <Row k={`Treasury (${launch.platformFeeBps / 100}%)`}>
          <Address value={launch.treasury} explorer />
        </Row>
        {recipients.map((r, i) => (
          <Row key={r.wallet.toBase58()} k={r.wallet.equals(treasury) ? `Back into ${symbol}: its Autopilot treasury (${r.bps / 100}% of ${creatorShare}%)` : `Recipient ${i + 1} (${r.bps / 100}% of ${creatorShare}%)`}>
            <Address value={r.wallet} explorer />
          </Row>
        ))}
      </Readout>
      <div className="pg-btns">
        {!migrated ? (
          <Button
            size="sm"
            disabled={!me}
            onClick={() =>
              me &&
              void run({
                title: "Claim trading fees from Meteora DBC",
                summary: ["Moves the launch's partner trading fees (wSOL) from the DBC pool to the launch authority PDA.", "Permissionless: anyone can run it; you pay only the network fee."],
                build: () => buildClaimFeesTx(connection, me, launch.publicKey),
              })
            }
          >
            Claim DBC fees
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!me}
            onClick={() => void claimLpFees()}
          >
            Claim LP fees
          </Button>
        )}
        <Button
          size="sm"
          disabled={!me}
          onClick={() =>
            me &&
            void run({
              title: "Distribute collected fees",
              summary: [
                `Pays ${launch.platformFeeBps / 100}% of the launch authority's wSOL to the treasury and splits the rest between the ${recipients.length} fixed recipient(s).`,
                `Burns every ${symbol} the launch authority holds.`,
                "Permissionless; missing recipient token accounts are created at your expense.",
              ],
              build: () => buildDistributeTx(connection, me, launch.publicKey),
            })
          }
        >
          Distribute
        </Button>
      </div>
      <Comment>Anyone can press these. Each one is simulated first: if there is nothing to claim or distribute, the review says so and nothing is signed.</Comment>
    </Fold>
  );
}
