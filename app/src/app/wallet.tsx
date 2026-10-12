/**
 * Wallet connection. Only Wallet Standard wallets are offered (Phantom,
 * Solflare, Backpack and every other wallet that registers itself), plus the
 * Solana Mobile Wallet Adapter on Android, which @solana/wallet-adapter-react
 * adds on its own. No wallet SDK that loads third-party code is bundled.
 *
 * This app never asks a wallet to sign a message: only transactions, each
 * one simulated and reviewed first (see ./tx.tsx).
 */
import { WalletReadyState, type WalletError, type WalletName } from "@solana/wallet-adapter-base";
import { ConnectionProvider, useWallet, WalletProvider } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { Alert, Button, Modal } from "../components/ui";
import { WalletIcon } from "../components/icons";
import { shortKey } from "../lib/format";
import { ADAPTER_MODE, fundDemoWallet } from "../lib/noised";
import { readString, writeString } from "../lib/storage";
import { Comment } from "../pages/inner/kit";
import { useSettings } from "./settings";

const DEMO_OWNER_KEY = "noised.demo-owner";

export interface Owner {
  /** The account the app acts for: the connected wallet, or the demo account in mock mode. */
  publicKey: PublicKey | null;
  source: "wallet" | "demo" | null;
  walletName: string | null;
  walletIcon: string | null;
  connecting: boolean;
  openConnect: () => void;
  disconnect: () => void;
}

const OwnerContext = createContext<Owner | null>(null);

export function useOwner(): Owner {
  const o = useContext(OwnerContext);
  if (!o) throw new Error("useOwner outside WalletProviders");
  return o;
}

export function WalletProviders({ children }: { children: ReactNode }): ReactNode {
  const { endpoint } = useSettings();
  // No adapter list: Wallet Standard detection only (see the module comment).
  const adapters = useMemo(() => [], []);
  const [walletError, setWalletError] = useState<string | null>(null);
  const onError = useCallback((e: WalletError) => {
    setWalletError(e.message === "" ? e.name : e.message);
  }, []);
  return (
    // web3.js retries HTTP 429 (rate limited) with backoff; public endpoints rate-limit often, and
    // a retried read or an identical signed transaction re-sent is harmless.
    <ConnectionProvider endpoint={endpoint.url} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={adapters} autoConnect localStorageKey="noised.wallet" onError={onError}>
        <OwnerProvider walletError={walletError} clearWalletError={() => setWalletError(null)}>
          {children}
        </OwnerProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

function loadDemoOwner(): PublicKey | null {
  const text = readString(DEMO_OWNER_KEY);
  if (text === null) return null;
  try {
    return new PublicKey(text);
  } catch {
    return null;
  }
}

function OwnerProvider({ children, walletError, clearWalletError }: { children: ReactNode; walletError: string | null; clearWalletError: () => void }): ReactNode {
  const wallet = useWallet();
  const [demo, setDemo] = useState<PublicKey | null>(() => (ADAPTER_MODE === "mock" ? loadDemoOwner() : null));
  const [dialogOpen, setDialogOpen] = useState(false);

  const publicKey = wallet.publicKey ?? demo;
  const source: Owner["source"] = wallet.publicKey ? "wallet" : demo ? "demo" : null;

  // Mock mode: give any account the app acts for some demo balances (local, simulated).
  useEffect(() => {
    if (ADAPTER_MODE === "mock" && publicKey) fundDemoWallet(publicKey);
  }, [publicKey]);

  useEffect(() => {
    if (wallet.connected) setDialogOpen(false);
  }, [wallet.connected]);

  const startDemo = useCallback(() => {
    // Only a public key: the demo account has no private key, because the
    // simulated chain never checks signatures from it.
    const key = Keypair.generate().publicKey;
    writeString(DEMO_OWNER_KEY, key.toBase58());
    setDemo(key);
    setDialogOpen(false);
  }, []);

  const disconnect = useCallback(() => {
    if (wallet.connected || wallet.wallet) void wallet.disconnect().catch(() => undefined);
    writeString(DEMO_OWNER_KEY, null);
    setDemo(null);
  }, [wallet]);

  const value = useMemo<Owner>(
    () => ({
      publicKey,
      source,
      walletName: wallet.wallet?.adapter.name ?? (demo ? "Demo account" : null),
      walletIcon: wallet.wallet?.adapter.icon ?? null,
      connecting: wallet.connecting,
      openConnect: () => {
        clearWalletError();
        setDialogOpen(true);
      },
      disconnect,
    }),
    [publicKey, source, wallet.wallet, wallet.connecting, demo, disconnect, clearWalletError],
  );

  return (
    <OwnerContext.Provider value={value}>
      {children}
      <WalletDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onDemo={startDemo} error={walletError} />
    </OwnerContext.Provider>
  );
}

function WalletDialog({ open, onClose, onDemo, error }: { open: boolean; onClose: () => void; onDemo: () => void; error: string | null }): ReactNode {
  const { wallets, select, connecting, wallet: selected } = useWallet();
  const usable = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  const choose = (name: WalletName): void => {
    // autoConnect is on, so selecting a wallet connects it.
    select(name);
  };
  return (
    <Modal open={open} onClose={onClose} title="Connect a wallet">
      <div className="pgx pg-wallet">
        {ADAPTER_MODE === "mock" ? (
          <Alert tone="info" title="Demo mode">
            The app runs against a simulated chain. Connecting only reads your wallet's public key: no transaction is ever sent to your wallet for
            signing in demo mode.
          </Alert>
        ) : null}
        {usable.length === 0 ? (
          <p className="pg-wallet-none">
            No Solana wallet was detected in this browser. Install a wallet that supports the Wallet Standard (most Solana wallets do) and reload
            this page.
          </p>
        ) : (
          <ul className="pg-wallet-list" aria-label="Detected wallets">
            {usable.map((w) => (
              <li key={w.adapter.name}>
                <button
                  type="button"
                  className="pg-wallet-row"
                  onClick={() => choose(w.adapter.name)}
                  disabled={connecting}
                  aria-busy={connecting && selected?.adapter.name === w.adapter.name}
                >
                  {w.adapter.icon.startsWith("data:image/") ? <img src={w.adapter.icon} alt="" className="pg-wallet-icon" /> : <WalletIcon className="pg-wallet-icon" />}
                  <span className="pg-wallet-name">{w.adapter.name}</span>
                  <span className="pg-wallet-state">{w.readyState === WalletReadyState.Installed ? "Detected" : "Available"}</span>
                  <span className="pg-wallet-go" aria-hidden="true">
                    →
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {error ? <Alert tone="fail" title="The wallet reported an error">{error}</Alert> : null}
        <Comment>
          Noised never asks you to sign a message. Every transaction is test-run and shown to you before your wallet is asked to sign it. Your wallet pays
          the fees; your quantum-safe keys never come from it.
        </Comment>
        {ADAPTER_MODE === "mock" ? (
          <div className="pg-wallet-demo">
            <Button variant="secondary" onClick={onDemo} className="pg-wide">
              Use a demo account instead (no wallet needed)
            </Button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/** Header control: connect, or show the connected account. */
export function WalletButton(): ReactNode {
  const owner = useOwner();
  const [menu, setMenu] = useState(false);
  if (!owner.publicKey) {
    return (
      <Button variant="primary" size="sm" onClick={owner.openConnect} loading={owner.connecting}>
        <WalletIcon />
        <span>Connect</span>
      </Button>
    );
  }
  const key = owner.publicKey.toBase58();
  return (
    <div className="relative">
      <Button size="sm" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-haspopup="true">
        {owner.walletIcon?.startsWith("data:image/") ? <img src={owner.walletIcon} alt="" className="h-4 w-4 rounded" /> : <WalletIcon />}
        <span className="mono">{shortKey(key, 4)}</span>
        {owner.source === "demo" ? <span className="badge badge-info">demo</span> : null}
      </Button>
      {menu ? (
        <div className="pgx pg-wmenu glass" role="menu">
          <p className="pg-wmenu-name">{owner.walletName}</p>
          <p className="pg-wmenu-key">{key}</p>
          <div className="pg-wmenu-actions">
            <Button
              size="sm"
              role="menuitem"
              onClick={() => {
                void navigator.clipboard?.writeText(key);
                setMenu(false);
              }}
            >
              Copy address
            </Button>
            <Button
              size="sm"
              variant="danger"
              role="menuitem"
              onClick={() => {
                owner.disconnect();
                setMenu(false);
              }}
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
