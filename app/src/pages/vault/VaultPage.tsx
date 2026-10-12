import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useState, type ReactNode } from "react";

import { useAsync } from "../../app/hooks";
import { useLedgers, type LedgersState } from "../../app/ledgers";
import { CLUSTER } from "../../app/settings";
import { Alert, Button } from "../../components/ui";
import { ADAPTER_MODE, demoMints, listLaunches, WSOL_MINT } from "../../lib/noised";
import { usePqKey, vaultMaster } from "../../lib/pqKey";
import { archiveOtherClusterRecords } from "../../lib/storage";
import { Comment, Feats, Fold, PageHead, Panel, type FeatItem } from "../inner/kit";
import { PageArt } from "../inner/art";
import { DotGlyph } from "../inner/glyphs";
import { QuantumKeyPanel } from "../quantumkey/QuantumKeyPanel";
import { KeyRecords } from "./KeyRecords";
import { MintVaults } from "./MintVaults";
import { DeliverAnyPayout } from "./Payouts";
import { needsAttention, PendingWithdrawals, RetiredWithdrawals, useStoredWithdrawals } from "./PendingWithdrawals";
import "./vault.css";

export function VaultPage(): ReactNode {
  // The key's secret lives only in lib/pqKey's memory; locking wipes it and unmounts everything that used it.
  const key = usePqKey();
  const master = key.status === "unlocked" ? vaultMaster() : null;
  const ledgers = useLedgers();
  // Records made for another cluster can never execute here: they move to the archive (L2).
  useEffect(() => {
    archiveOtherClusterRecords(CLUSTER);
  }, []);
  // Signed withdrawals waiting to be sent come first; an empty list goes below.
  const pendingFirst = useStoredWithdrawals().some(needsAttention);
  return (
    <div className="pg pg-vault">
      <PageHead
        art={<PageArt scene="vault" />}
        eyebrow="Vault"
        title={
          <>
            Your <span className="pg-title-grad">quantum-proof</span> vault
          </>
        }
        lede="Keep tokens where even a quantum computer can't reach them. Only a one-time key made from your quantum key can move them out."
      />
      <Feats items={STEPS} label="How the vault works in three steps" />

      {pendingFirst ? <PendingWithdrawals ledgers={ledgers} /> : null}

      {ADAPTER_MODE === "mock" ? (
        <Alert tone="warn" title="Demo mode signs with real keys">
          The simulated chain is fake, but the vault keys and their signatures are real. Use a throwaway key here, never one that protects real vaults:
          each key signs only once, and a demo withdrawal uses it up.
        </Alert>
      ) : null}
      {ledgers.error !== null ? (
        <Alert tone="fail" title="This browser cannot sign withdrawals">
          {ledgers.error}
        </Alert>
      ) : null}

      <QuantumKeyPanel use="It opens your vaults: every withdrawal is signed by a fresh one-time key made from it." />

      {master !== null ? <TokenPicker master={master} ledgers={ledgers} /> : null}

      {pendingFirst ? null : <PendingWithdrawals ledgers={ledgers} />}

      <DeliverAnyPayout />

      <KeyRecords ledgers={ledgers} />

      <RetiredWithdrawals />

      <Fold label="How the vault works" status="Details">
        <HowItWorks />
      </Fold>
    </div>
  );
}

const STEPS: readonly FeatItem[] = [
  {
    title: "Make your quantum key",
    text: "A passkey or 24 words, separate from your wallet. Nobody else ever sees it.",
    icon: <DotGlyph name="phrase" />,
  },
  {
    title: "Deposit tokens",
    text: "Open a vault for a token and send tokens in. Anyone can deposit.",
    icon: <DotGlyph name="deposit" />,
  },
  {
    title: "Withdraw with a one-time key",
    text: "Each withdrawal is signed by a fresh key made from your quantum key. Your wallet only pays the fee.",
    icon: <DotGlyph name="key" />,
  },
];

function TokenPicker({ master, ledgers }: { master: Uint8Array; ledgers: LedgersState }): ReactNode {
  const { connection } = useConnection();
  const launches = useAsync(() => listLaunches(connection), [connection], { watchChain: false });
  const [mintText, setMintText] = useState("");
  const [mint, setMint] = useState<PublicKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const options = [
    { mint: WSOL_MINT, label: "wSOL: wrapped SOL (your SOL is wrapped automatically)" },
    ...(launches.data ?? []).filter((l) => l.status === "live" && l.market).map((l) => ({ mint: l.baseMint, label: `${l.market?.symbol ?? "?"}: ${l.market?.name ?? ""}` })),
    ...(ADAPTER_MODE === "mock" ? demoMints().map((m) => ({ mint: m.address, label: `${m.symbol}: ${m.name} (demo token)` })) : []),
  ];

  return (
    <>
      <Panel id="pick-token" title="Choose a token" description="Each token has its own vaults. Pick one to see yours.">
        <form
          className="pg-pick"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              setMint(new PublicKey(mintText.trim()));
              setError(null);
            } catch {
              setError("Enter a valid token address.");
            }
          }}
        >
          <div>
            <label className="label" htmlFor="vault-mint-pick">
              Choose a token
            </label>
            <select
              id="vault-mint-pick"
              className="select"
              value={mint?.toBase58() ?? ""}
              onChange={(e) => {
                if (e.target.value === "") return;
                setMint(new PublicKey(e.target.value));
                setMintText("");
                setError(null);
              }}
            >
              <option value="">Choose a token…</option>
              {options.map((o) => (
                <option key={o.mint.toBase58()} value={o.mint.toBase58()}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="vault-mint-text">
              Or paste a token address
            </label>
            <input
              id="vault-mint-text"
              className="input mono"
              value={mintText}
              onChange={(e) => setMintText(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={error !== null}
              aria-describedby={error ? "vault-mint-error" : undefined}
            />
          </div>
          <Button type="submit">Use this token</Button>
          {error ? (
            <p id="vault-mint-error" className="field-error pg-span-all">
              {error}
            </p>
          ) : null}
        </form>
        <Comment>{`Your vault keys are made for ${CLUSTER}. Vaults on other networks use different keys.`}</Comment>
      </Panel>
      {mint ? <MintVaults key={mint.toBase58()} master={master} mint={mint} ledgers={ledgers} /> : null}
    </>
  );
}

function HowItWorks(): ReactNode {
  return (
    <div className="pg-stack">
      <Comment>What is protected, and what you must do right. The technical version.</Comment>
      <ul className="pg-facts">
        <li>
          <strong>One vault, one address.</strong> Vault account #n of your key lives at one address for good, and so does its deposit address: the
          vault's token account for the mint. Send only that mint there. SOL or tokens of another mint sent to the vault address itself cannot be
          recovered. wSOL deposits made here wrap automatically.
        </li>
        <li>
          <strong>One key, one signature.</strong> Each withdrawal is signed by account #n's key for the vault's current sequence: a 185-byte message
          ("PHX-PQV4", vault, mint, sequence, recipient wallet, maximum amount, next key id). The vault then switches to the next key. This browser keeps
          a record of every one-time key it used (IndexedDB, shared by its tabs): a key is reserved for its message before it signs, and the signature
          is recorded before it is used, so a key never signs two messages. Signing is deterministic: the same message gives the identical signature.
          The vault's history is searched first, so a signature already made elsewhere is re-broadcast instead of signing again.
        </li>
        <li>
          <strong>Several devices.</strong> Each browser keeps its own records. Before you withdraw on another device with the same key, move this
          browser's records there ("Use your key on another device"), or that device could sign a second message with a key used here.
        </li>
        <li>
          <strong>Withdraw, then deliver.</strong> A withdrawal only reserves min(maximum, available) for the recipient wallet and rotates the key, so
          nothing a recipient or a token authority does can make a signed withdrawal fail. Delivery is separate: anyone can deliver a payout to the
          recipient's canonical token account (this app does it in the same transaction when it can), and the recipient can receive it into another
          account. A recipient can delay only its own payout.
        </li>
        <li>
          <strong>Check the recipient.</strong> The program cannot tell a wallet from a token account, a mint or a vault, and a signed message cannot be
          changed, so the recipient is checked before signing: refusals block signing, and each kind of warning needs its own confirmation.
        </li>
        <li>
          <strong>Throwaway fee payer.</strong> A withdrawal carries a 2,176-byte hash-based (LM-OTS, RFC 8554) signature, so it travels in a v1
          transaction (up to 4,096 bytes). A fresh Ed25519 key you fund with about 0.01 SOL pays it and gets the payout account's rent back on
          delivery; refund it afterwards. It has no authority over the vault.
        </li>
        <li>
          <strong>A separate key.</strong> Vault keys come from your quantum key (24 words, or a passkey's PRF secret turned into 24 words), bound to the
          cluster, the mint, the vault account and the sequence, never from your wallet's seed: an Ed25519 key reveals nothing a quantum attacker could
          use against it.
        </li>
        <li>
          <strong>What it does not protect.</strong> The token's own authorities (freeze, pause, transfer hooks) can delay a payout, the network and
          Token-2022 still run on Ed25519-secured infrastructure, and anyone who sees your backup words controls your vaults.
        </li>
      </ul>
      {ADAPTER_MODE === "mock" ? (
        <Alert tone="info">Demo mode: the signatures and the v1 transaction bytes are real, but the vault program runs in a simulation in this browser.</Alert>
      ) : null}
    </div>
  );
}
