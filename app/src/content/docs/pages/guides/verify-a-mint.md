---
title: Verify any mint
summary: Check a launch yourself, against the live chain, with the SDK's verifier or with nothing but the Solana CLI, its post-quantum signature and on-chain metadata included.
---

You do not need the Noised website to check a launch. The certificate records what was verified at launch, but it is never trusted on its own: every check below is recomputed from live accounts.

## With the SDK

```ts title="verify.ts"
import { verifyLaunch } from "@noisedlabs/sdk";

const report = await verifyLaunch(conn, mint, { listOperators: true });
if (report.overall === "fail") console.error("NOT a safe Noised launch");
for (const c of report.checks.filter((c) => c.status !== "pass")) console.log(c.status, c.id, c.detail);

if (report.pqOrigin?.verified === true) {
  const o = report.pqOrigin;
  console.log(`signed by identity ${o.identity.toBase58()} at leaf ${o.leaf}, window ${o.window.notBefore}..${o.window.notAfter}`);
}
if (report.metadata?.verified === true) console.log(report.metadata.document?.description);
```

| Group | What is checked |
|---|---|
| `certificate.*` | the certificate exists at `["certificate", mint]`, belongs to this mint, launch and pool, has policy version 3, the launch's `params_hash`, and all twelve check bits (`(checks & 4095) === 4095`, `certificateChecksComplete`; a launch with creator rules also carries `RULES_BOUND`, so `checks = 8191`) |
| `mint.*` | owner Token-2022; mint and freeze authorities None; extension set exactly {MetadataPointer, TokenMetadata, TransferHook}, parsed twice (with `@solana/spl-token` and a strict parser that must agree; unknown types fail); pointer authority None pointing at the mint; metadata update authority None; decimals and supply against the certificate; hook = Launch Guard with DBC's pool authority while the curve runs, program and authority None once it completed |
| `pq.origin` | the attestation's LMS signature re-verified against the identity account's public key, over the 189-byte message **rebuilt from on-chain data** (the launch, its parameters hash and creator, the hash recomputed from the metadata record itself, and the window), at a leaf the identity's bitmap marks used; certificate, launch and attestation name the same identity, leaf, slot and record; the launch went live inside the window |
| `metadata.onchain` | certificate bit 2048 is set and `Certificate.metadata` is the record the identity signed (an external uri is a warning: what it serves can change) |
| `metadata.match` | the mint holds exactly the record's name, symbol and derived uri and no additional metadata, and the document agrees |
| `metadata.icon` | the document's icon is an inline PNG of at most 64 × 64 pixels; nothing is fetched |
| `dbc.*` | every fixed value of the safety policy, 100% LP permanently locked, no migration fee, no locked vesting, wSOL quote, the fee ceiling |
| pool, policy, meta list | the DBC pool; the hook policy's exact values and exempt list; the meta list byte for byte (the policy PDA and the instructions sysvar) |
| `batch.*` | the total cap as a share of the threshold (warns below 10%) and the wallet cap; `quote_spent <= min(total_committed, batch_total_cap)` and the payout totals; while pending, that nobody traded the pool yet |
| `damm.*` | after migration: a launch-authority position in the canonical (base, wSOL) pool with permanently locked liquidity; the pool's fee against its canonical migration config, default dynamic fee included |
| programs | our upgrade authorities (warn until finalized); DBC and DAMM v2 upgrade authority and last-deploy slots against the reviewed ones (`TRUST_ANCHORS`); Token-2022 |
| `rpc.clock` | a warning when the RPC's Clock sysvar is not plausible unix seconds (the RPC is broken or dishonest; this device's clock is used instead) |

`report.pqOrigin` and `report.metadata` carry what was verified; show a launch's origin, icon, description and links only when their `verified` is true. `report.trustedParties` lists who can still change the outcome: Meteora's upgrade multisig and operators, the Token-2022 multisig, our own upgrade authorities, validators and your RPC, host and wallet.

Before a launch goes live, `verifyAttestation(conn, launch)` re-verifies its attestation, identity, record and signature from live accounts, for an upcoming-launch list.

:::tip Use two RPCs
The report is only as honest as the RPC that served it. For large decisions, run it against two independent providers and compare.
:::

### Against the QSL-1 standard

`checkQsl1` (SDK 0.5.0) runs the verification algorithm of the [QSL-1 standard](/docs/standard/qsl-1) and returns a level instead of a list: 1 (No-rug), 2 (Quantum-attested) or 0, with every condition (`cluster`, `C1.1` to `C1.24`, `C2.1` to `C2.8`, `C3`) in plain words. It awards a level only on mainnet-beta with finalized programs; until then a token that passes everything else is a `candidate`. `qslBadge` gives the standard's own wording for it.

```ts title="qsl.ts"
import { checkQsl1, qslBadge } from "@noisedlabs/sdk";

const result = await checkQsl1(conn, mint); // reads at "finalized"; no getProgramAccounts, no URL
const badge = qslBadge(result); // badge.title: "QSL-1 · Quantum-attested", "QSL-1 candidate: not final yet", "Not QSL-1", ...
console.log(badge.title, result.reasons);
for (const c of result.checks.filter((c) => !c.ok)) console.log(c.id, c.plain);
```

## With the Solana CLI

```bash title="terminal"
# 1. Mint: authorities and extensions
spl-token display <MINT> --url mainnet-beta
#    expect: no mint authority, no freeze authority, extensions MetadataPointer + TokenMetadata + TransferHook,
#    metadata update authority none; transfer hook program = cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia
#    before graduation (authority FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM), none after.

# 2. Certificate, hook policy and attestation addresses
solana find-program-derived-address CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc string:certificate pubkey:<MINT>
solana find-program-derived-address cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia string:policy pubkey:<MINT>
solana find-program-derived-address CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc string:attestation pubkey:<LAUNCH>
#    a mint with no certificate account at that address is NOT a Noised launch.
#    The certificate's `checks` (bytes 187..191, u32 little-endian) must have all twelve bits of 4095 set (`(checks & 4095) == 4095`; 8191 when the launch has creator rules: bit 4096 RULES_BOUND), and `metadata`
#    (bytes 455..487) is the address of the TokenMeta record; the attestation keeps the full LMS signature.

# 3. The metadata record, read through the certificate (never by searching a launch's records)
solana account <CERTIFICATE.metadata> --url mainnet-beta --output json
#    owner: the launchpad; data from byte 75: borsh name, symbol, uri, doc (the JSON document)

# 4. Who can still change the code
solana program show CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc --url mainnet-beta   # Authority: none (after finalization)
solana program show cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia --url mainnet-beta
solana program show dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN --url mainnet-beta   # Meteora: upgradeable, note "Last Deployed In Slot"
```

The CLI cannot re-verify the LMS signature; the SDK's `verifyLaunch` (or any RFC 8554 verifier over the message rebuilt from the accounts) does.

## In the app

Every token page runs the same verifier and shows each check, and the command palette runs it too: press <kbd>Ctrl</kbd> <kbd>K</kbd> and type `verify` followed by a mint address or a symbol. [Verify](/verify) checks any mint against QSL-1 and explains the result in plain words, and every token carries its QSL-1 badge.
