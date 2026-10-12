/**
 * A token's own details from its on-chain metadata record (icon, description,
 * links), read through the SDK and only the way it allows: after launch
 * through the mint's certificate (`fetchTokenMetaForMint`), before launch
 * through the attestation, and then only when the attestation re-verifies
 * (`verifyAttestation`). Never by searching a launch's records (anyone may
 * publish junk ones). The document is parsed defensively and nothing in it
 * is ever fetched: the icon is a PNG inside it, shown as an <img> of its
 * data URI (CSP img-src data:), pixel-crisp; links are inert text with their
 * domain spelled out.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import type { Connection, PublicKey } from "@solana/web3.js";
import type { ReactNode } from "react";

import { useAsync } from "../app/hooks";
import { fetchTokenMetaForMint, parseMetadataDoc, verifyAttestation, type AttestationVerification, type MetadataIcon, type MetadataLink, type TokenMetaAccount } from "../lib/noised";
import "./tokenMeta.css";

/** What the app shows of a record: never more than what parsed cleanly. */
export interface TokenMetaView {
  name: string;
  symbol: string;
  description: string | null;
  icon: MetadataIcon | null;
  links: MetadataLink[];
}

/** The record's parts that are safe to show (a part with a problem is left out). */
export function tokenMetaView(record: TokenMetaAccount): TokenMetaView {
  const doc = parseMetadataDoc(record.doc, { name: record.record.name, symbol: record.record.symbol });
  return { name: record.name, symbol: record.symbol, description: doc.description, icon: doc.icon, links: doc.links };
}

/** An upcoming launch's details from its attestation's verification: only when it verified (the record its identity signed). */
export function verifiedTokenMeta(v: Pick<AttestationVerification, "verified" | "tokenMeta">): TokenMetaView | null {
  return v.verified && v.tokenMeta !== null ? tokenMetaView(v.tokenMeta) : null;
}

/** Records never change (a mint's for good; an upcoming launch's only when its creator signs a new opening): cached. */
const MINT_CACHE = new Map<string, Promise<TokenMetaView | null>>();
const LAUNCH_CACHE = new Map<string, { at: number; p: Promise<TokenMetaView | null> }>();
const LAUNCH_TTL_MS = 60_000;
/** At most this many record reads at once (a launch list reads one per card). */
const LIMIT = 3;
let running = 0;
const queue: (() => void)[] = [];

function limited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      running++;
      task()
        .then(resolve, reject)
        .finally(() => {
          running--;
          queue.shift()?.();
        });
    };
    if (running < LIMIT) start();
    else queue.push(start);
  });
}

/** A live mint's details, through its certificate (null: not a Noised mint). */
export function mintTokenMeta(conn: Connection, mint: PublicKey): Promise<TokenMetaView | null> {
  const id = mint.toBase58();
  let p = MINT_CACHE.get(id);
  if (p === undefined) {
    p = limited(async () => {
      const r = await fetchTokenMetaForMint(conn, mint);
      return r === null ? null : tokenMetaView(r.tokenMeta);
    });
    MINT_CACHE.set(id, p);
    p.catch(() => MINT_CACHE.delete(id));
  }
  return p;
}

/** An upcoming launch's details: only when its attestation re-verifies (null otherwise). */
export function launchTokenMeta(conn: Connection, launch: PublicKey): Promise<TokenMetaView | null> {
  const id = launch.toBase58();
  const hit = LAUNCH_CACHE.get(id);
  if (hit !== undefined && Date.now() - hit.at < LAUNCH_TTL_MS) return hit.p;
  const p = limited(async () => verifiedTokenMeta(await verifyAttestation(conn, launch)));
  LAUNCH_CACHE.set(id, { at: Date.now(), p });
  p.catch(() => LAUNCH_CACHE.delete(id));
  return p;
}

/** A launch's details: through the certificate once live, through the verified attestation before. */
export function useTokenMeta(target: { mint: PublicKey } | { launch: PublicKey } | null): TokenMetaView | null {
  const { connection } = useConnection();
  const key = target === null ? "" : "mint" in target ? `m:${target.mint.toBase58()}` : `l:${target.launch.toBase58()}`;
  const r = useAsync(
    () => (target === null ? Promise.resolve(null) : "mint" in target ? mintTokenMeta(connection, target.mint) : launchTokenMeta(connection, target.launch)),
    [connection, key],
    { enabled: target !== null, watchChain: target !== null && !("mint" in target) },
  );
  return r.data ?? null;
}

/** The token's own icon, pixel-crisp (a data: URI from its record; never fetched). */
export function TokenImage({ icon, size, className = "" }: { icon: MetadataIcon; size: number; className?: string }): ReactNode {
  return <img className={`tk-img ${className}`} src={icon.dataUri} width={size} height={size} alt="" decoding="async" draggable={false} />;
}

const LINK_KIND: Record<MetadataLink["kind"], string> = { website: "Website", x: "X", telegram: "Telegram" };

/** The description and links, as text: a link is never clickable here, and its domain is spelled out. */
export function TokenAbout({ meta }: { meta: TokenMetaView }): ReactNode {
  if (meta.description === null && meta.links.length === 0) return null;
  return (
    <div className="tm-about">
      {meta.description !== null ? <p className="tm-desc">{meta.description}</p> : null}
      {meta.links.length > 0 ? (
        <ul className="tm-links" aria-label="Links (shown as text, not opened)">
          {meta.links.map((l) => (
            <li key={`${l.kind}:${l.url}`}>
              <span className="tm-link-kind">{LINK_KIND[l.kind]}</span>
              <span className="tm-link-host">{l.host}</span>
              <span className="tm-link-url">{l.url}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
