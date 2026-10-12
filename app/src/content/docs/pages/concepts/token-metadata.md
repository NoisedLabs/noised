---
title: Token metadata
summary: A token's name, symbol, description, icon and links are one record on Solana, at the address of its own hash, signed by the creator's post-quantum identity. No link, no server, no IPFS.
---

Noised stores a token's metadata itself, on-chain, as a **record** the launchpad writes once and never changes. The record lives at an address derived from the hash of its own content, the creator's post-quantum identity signs that hash, and `launch` copies the record's name and symbol into the mint. Nothing has to stay online for a token to keep its face.

## The record: `TokenMeta`

`publish_metadata` writes the whole record in one transaction, at

```text
["metadata", launch, metadata_hash]          (launchpad PDA, canonical bump)

metadata_hash = SHA256( "PHX-META-V2"
                        ‖ u32le(len name)   ‖ name
                        ‖ u32le(len symbol) ‖ symbol
                        ‖ u8 flags
                        ‖ u32le(len uri)    ‖ uri
                        ‖ u32le(len doc)    ‖ doc )      lengths in UTF-8 bytes
```

| Offset | Field | Notes |
|---:|---|---|
| 0 | discriminator | `8257ae23152c5c13` (`sha256("account:TokenMeta")[..8]`) |
| 8 | `version` | 1 |
| 9 | `bump` | the canonical bump of the address |
| 10 | `flags` | the uri mode: 0, `INLINE_URI` (1) or `EXTERNAL_URI` (2) |
| 11 | `launch` | the launch it belongs to |
| 43 | `metadata_hash` | equals the third seed |
| 75 | `name`, `symbol`, `uri`, `doc` | borsh strings, in that order |

The account is exactly `91 + name + symbol + uri + doc` bytes (93 to 3,405) and is never modified or closed. Because the address *is* the hash, nobody can put other bytes at an address the identity signed: that would take a SHA-256 second preimage.

### Rules

`publish_metadata` checks the record in this order and answers with the first error, which `validateTokenMeta` reproduces exactly:

1. `flags` is 0, 1 or 2, else `InvalidMetadataFlags` (6045).
2. The document is at most 3,072 bytes and the uri at most 200 bytes, else `MetadataTooLong` (6046).
3. The name is 1 to 32 bytes and the symbol 1 to 10 bytes, else `InvalidMetadata` (6016); with `EXTERNAL_URI`, the uri is `https://` plus at least one byte, every byte printable ASCII (`0x21`..`0x7E`), else `InvalidMetadata`.
4. A non-empty uri without `EXTERNAL_URI`, or `INLINE_URI` with an empty document, gives `InvalidMetadataFlags`.

The launch must still be `Configured` (`WrongLaunchState`). Publishing is permissionless and **idempotent**: a record that already exists is left as it is (anyone may have published it, and it holds exactly these bytes), and an address someone pre-funded is taken over. The transaction is a v1 transaction of 309 to 3,621 bytes and 12.7k to 23.8k CU, paid by the same throwaway key that relays the attestation; the event `MetadataPublished` reports the launch, the record, its hash, the flags and the uri and document lengths.

## How it is bound to the launch

1. **Publish** the record (`publish_metadata`), and wait until it is finalized.
2. **Sign.** The identity's attestation message v2 contains `metadata_hash` (see [Post-quantum creator identity](/docs/concepts/pq-identity#the-attestation)). `attest_launch` attests only if the record at `["metadata", launch, metadata_hash]` exists: owned by the launchpad, with the `TokenMeta` discriminator, version 1, this launch and this hash, at its canonical address. Otherwise the signature only burns its leaf. Any other account in that position fails the whole transaction with `ConstraintSeeds` (2006) and burns nothing.
3. **Launch.** `launch` takes no arguments. Its 22nd account is the record the attestation names; it passes the record's name, symbol and derived uri to Meteora DBC, then re-reads the mint's Token-2022 `TokenMetadata` and requires exactly those values and no additional metadata (`MetadataMismatch`, which an honest DBC never triggers). It sets certificate bit **2048** (`METADATA_ONCHAIN`) and records the record's address in `Certificate.metadata`.

The mint's metadata update authority and pointer authority are None (certificate bits 4 and 8), so nothing about the token's name, symbol or uri can change afterwards.

## The uri: empty by default

The signed `flags` byte chooses what `launch` writes into the mint's `uri`:

| Mode | Mint uri | Who shows the icon |
|---|---|---|
| none (0, the default) | `""` | the Noised app, the SDK and anything that reads the record |
| `INLINE_URI` (1) | `data:application/json;base64,` + base64 of the document, at most 4,125 bytes | possibly some readers; no wallet is known to show it |
| `EXTERNAL_URI` (2) | the record's own `https://` link, at most 200 bytes | wallets that fetch the link; its content can change |

What wallets and indexers really do today:

- **Every wallet and indexer shows the name and symbol**, which the mint holds itself. With an empty uri that is all they show: no icon, but nothing can break. The open-source DAS indexer explicitly skips an empty uri.
- **Icons in third-party wallets come from https-hosted JSON or from their own registries.** That is a limit of the ecosystem, not of Noised. An external link puts the icon back in those wallets, but the file behind it depends on DNS, TLS and a server, and can change after launch: only the link is signed.
- **An inline uri** is accepted by Token-2022 and DBC (DBC takes uris up to 8,685 bytes, 2.1 times the largest inline uri), but no Solana token with a `data:` uri is known to display anywhere, and an indexer that stores uris in a `varchar(200)` column may drop the token entirely.

The app offers neither uri mode: the default empty uri is the only one it uses. `INLINE_URI` stays out of the app until a wallet and indexer check on mainnet shows such tokens listed everywhere an ordinary token is.

## The document

The record's `doc` is an SDK-defined JSON document; the program treats it as opaque UTF-8 and only limits its size. `buildMetadataDoc` writes it in one canonical form (compact, keys in a fixed order, empty parts left out), so the same input always gives the same bytes:

```json title="doc"
{"name":"Aegis","symbol":"AEGS","description":"…","image":"data:image/png;base64,iVBORw0KGgo…","external_url":"https://…","extensions":{"x":"https://x.com/…","telegram":"https://t.me/…"}}
```

| Part | Limit |
|---|---|
| `name`, `symbol` | equal to the record's own |
| `description` | at most 500 bytes |
| `image` | a PNG inline as `data:image/png;base64,`, at most 64 × 64 pixels; never SVG, never a link |
| links | `https://` only; X and Telegram links must go to their own hosts |
| whole document | at most 3,072 bytes |

The icon is a palette PNG: a 32 × 32 icon with 16 colours is about 130 to 700 bytes (`encodeIndexedPng`). The app's icon editor makes exactly that, and keeps the bytes it signed: another encoder could produce other bytes, and so another hash.

## Reading a token's metadata

:::warn Resolve the record only through the attestation or the certificate
Anyone may publish records under any launch, each at its own address. They are inert: `attest_launch` and `launch` only ever use the hash the identity signed. A reader must do the same: before launch, through `Attestation.metadata_hash`; after launch, through `Certificate.metadata`. Never by searching a launch's records with `getProgramAccounts`.
:::

```ts title="read-metadata.ts"
import { fetchTokenMetaForMint, parseMetadataDoc, verifyLaunch } from "@noisedlabs/sdk";

const report = await verifyLaunch(conn, mint);
if (report.metadata?.verified === true && report.metadata.document?.ok === true) {
  const doc = report.metadata.document;
  console.log(doc.name, doc.symbol, doc.description);
  // doc.icon.dataUri: render it only as <img src> (a CSP with img-src data: allows it)
  for (const link of doc.links) console.log(`${link.url} (goes to ${link.host})`); // inert text, never opened automatically
}

// The raw record, by the certificate (after launch):
const found = await fetchTokenMetaForMint(conn, mint);
const parsed = found ? parseMetadataDoc(found.tokenMeta.doc, { name: found.tokenMeta.name, symbol: found.tokenMeta.symbol }) : null;
```

`parseMetadataDoc` never fetches anything. It caps the size, parses strictly, accepts only a well-formed PNG of at most 64 × 64 pixels as the image, drops unusable links with a warning, and reports a name or symbol that differs from the record's as a problem. Before launch, `verifyAttestation(conn, launch)` re-verifies the attestation, its identity, its record and its signature: show an upcoming launch's record only when it says `verified`.

## Costs

| Item | Size | Measured |
|---|---|---|
| Typical record (name, symbol, a 672-byte PNG, a short description) | 1,244 bytes | rent 6,969,760 lamports at mainnet's rate; `publish_metadata` 1,460 bytes, 15,364 CU |
| Largest record (32 / 10 / 200 / 3,072) | 3,405 bytes | rent 17,947,640 lamports; `publish_metadata` 3,621 bytes, 23.0k to 23.8k CU |
| The mint | `386 + name + symbol + uri` bytes | 409 bytes for an 18-byte name and 5-byte symbol with the empty uri |

Rent is `(128 + size) × 5,080` lamports at mainnet's rate, paid once by the throwaway payer and never refunded: a record is never closed. `throwawayPayerFunding` adds it to the attestation's own rent so one funding transaction covers both.

## Elsewhere

- **The Shield** copies a base mint's uri into its zToken only if it is at most 200 bytes with no invisible character. The empty uri and external uris are copied; an inline uri only for a document of at most 126 bytes.
- **Integrators** read `name` and `symbol` from the mint (`tokenMetadataOf`) or the record, treat an empty `uri` as normal, and remember that only the mint address and its certificate identify a Noised launch: anyone can create a token with the same name and symbol.

## Reference

- Instructions: [`publish_metadata`](/docs/programs/launchpad#ix-publish_metadata), [`attest_launch`](/docs/programs/launchpad#ix-attest_launch), [`launch`](/docs/programs/launchpad#ix-launch); account [`TokenMeta`](/docs/programs/launchpad#acc-TokenMeta).
- Errors: `InvalidMetadata` (6016), `InvalidMetadataFlags` (6045), `MetadataTooLong` (6046), `MetadataMismatch` (6047). Event: `MetadataPublished`.
- SDK: [On-chain metadata](/docs/sdk/metadata).
