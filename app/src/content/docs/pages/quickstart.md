---
title: Quickstart
summary: Install the TypeScript SDK, connect to a cluster, read launches and verify a mint against the live chain.
---

`@noisedlabs/sdk` is the TypeScript client for Noised: launch builders, an independent on-chain verifier, the PQ vault client and the shield client. It is strict TypeScript, ESM only, uses `@solana/web3.js` 1.98 (`PublicKey`, `Transaction`, `Connection`) and `bigint` for every u64, u128 and i64.

## Install

The SDK is not published to npm yet. Build it from a checkout of the Noised repository and add it to your project as a local package. It needs Node 22.12 or newer, or a modern browser bundler.

```bash title="terminal"
cd sdk
pnpm install --frozen-lockfile
pnpm build                       # dist/: ESM + .d.ts + the IDL JSON files

cd ../your-app
pnpm add file:../noised/sdk     # the path to the sdk folder of your checkout
```

Every dependency is pinned exactly and nothing runs install scripts. Meteora's DBC SDK is loaded with a dynamic `import()` only by `buildSwapTx`, so code that never swaps never pays for it.

:::note Safety policy 3
The programs of this release enforce safety policy 3: a 60-second minimum commit window, a 10-minute execution window that the batch ends early, batch-cap floors, a post-quantum attestation before every launch, and token metadata stored on-chain and certified on the mint. The SDK (`@noisedlabs/sdk` 0.4) mirrors the bounds in `POLICY` (`POLICY.SAFETY_POLICY_VERSION`) and `METADATA`. The [SDK reference](/docs/sdk) always lists what your build exports, and the [changelog](/docs/changelog) tracks the rest.
:::

## Connect

Use your own RPC endpoint for anything that matters, and a second, independent one to cross-check verification results.

```ts title="connect.ts"
import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_IDS, CLUSTERS } from "@noisedlabs/sdk";

const conn = new Connection("https://api.devnet.solana.com", "confirmed");

console.log(PROGRAM_IDS.launchpad.toBase58()); // CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc
console.log(CLUSTERS.devnet);                  // { id: 1, label: "Devnet" }
```

## Read launches

`listLaunches` reads every `Launch` account of the launchpad in one `getProgramAccounts` call and adds a market snapshot (name, symbol, reserves, price, curve and migration state) for live launches. `launchPhase` places a launch on its timeline from its own timestamps.

```ts title="launches.ts"
import { clusterUnixTime, listLaunches, launchPhase, expectedBatchFill } from "@noisedlabs/sdk";

const now = await clusterUnixTime(conn); // bigint unix seconds, the cluster's clock (unixNowSecs() for this device's)
for (const launch of await listLaunches(conn)) {
  const phase = launchPhase(launch, now); // configured | commit | execute | guarded | open | graduated
  const fill = expectedBatchFill(launch);
  console.log(
    launch.market?.symbol ?? "(not live)",
    phase,
    `${fill.totalCommitted} lamports committed`,
    fill.oversubscribed ? `filled ${fill.fillBps / 100}%` : "",
  );
}
```

`fetchLaunch(conn, launch)` reads one launch by its address, and `fetchLaunchByMint(conn, mint)` finds the launch that certified a mint, or returns `null` when the mint is not a Noised launch. Every "now" in the SDK is a `bigint` of unix seconds: a `number` or a millisecond value throws instead of giving a wrong answer.

A token's icon, description and links are an [on-chain record](/docs/concepts/token-metadata): read them through the certificate (`fetchTokenMetaForMint`) or the verifier below, never by searching a launch's records.

## Verify a mint

Never trust a token page, ours included. `verifyLaunch` recomputes every guarantee from live accounts: the mint, the DBC config and pool, the hook policy and its meta list, the batch accounting, the phase and, after migration, the DAMM v2 position lock. It re-verifies the creator's post-quantum signature over data rebuilt from the chain, re-reads the token's metadata record, and lists who can still change the outcome.

```ts title="verify.ts"
import { verifyLaunch } from "@noisedlabs/sdk";

const mint = new PublicKey(process.argv[2] ?? "");
const report = await verifyLaunch(conn, mint);

console.log(`overall: ${report.overall} (phase ${report.phase ?? "unknown"})`);
for (const check of report.checks) {
  console.log(`${check.status.padEnd(4)} ${check.id.padEnd(24)} ${check.label}`);
}
for (const party of report.trustedParties) {
  console.log(`trusted: ${party.name} (${party.kind})`);
}
if (report.pqOrigin?.verified) console.log(`post-quantum origin: leaf ${report.pqOrigin.leaf} of identity ${report.pqOrigin.identity.toBase58()}`);
if (report.metadata?.verified) console.log(`on-chain metadata: ${report.metadata.document?.description ?? "(no description)"}`);
```

Treat `overall: "fail"` as "not a safe Noised launch". A mint without a launchpad-owned certificate at `["certificate", mint]` is not a Noised launch at all. `warn` is meaningful too: our programs are upgradeable until finalized, and any change to Meteora's DBC or DAMM v2 code since the reviewed slot is flagged. The full list of checks is in [Verify any mint](/docs/guides/verify-a-mint).

## Simulate before you sign

Every builder returns an unsigned transaction. Run `simulateAndExplain` on it before asking a wallet to sign: it maps the error codes of our programs, DBC, DAMM v2, Anchor and SPL Token to names and messages, and lists the signers, writable accounts and any program it does not recognize.

```ts title="simulate.ts"
import { buildCommitTx, simulateAndExplain } from "@noisedlabs/sdk";

const tx = await buildCommitTx(conn, wallet.publicKey, launchAddress, 500_000_000n); // 0.5 SOL
const sim = await simulateAndExplain(conn, tx);
if (!sim.ok) throw new Error(sim.error ?? "simulation failed");
if (sim.unknownPrograms.length > 0) throw new Error("refusing: unknown program in the transaction");
// now ask the wallet to sign tx, then sendAndConfirm(conn, signed)
```

## Next steps

- Learn the [launch lifecycle](/docs/concepts/lifecycle), then follow [Launch a token](/docs/guides/launch-a-token).
- Keep tokens in [post-quantum custody](/docs/concepts/pq-vault).
- Browse the [SDK reference](/docs/sdk) and the [programs reference](/docs/programs).
