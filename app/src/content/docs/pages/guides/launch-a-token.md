---
title: Launch a token
summary: Create your post-quantum identity, write the token's metadata, create the launch, publish the record, attest it and take it live inside its window, step by step.
---

This guide follows a launch from your identity to the open. Each step names the instruction it runs and the SDK function that builds it. The app's create wizard runs the same flow. Your wallet signs only two legacy transactions (creating the launch and funding a throwaway fee payer); everything post-quantum is signed by your identity and relayed by that throwaway key.

## Quick launch or Custom launch

The app offers two ways in. **Quick launch** is one short form: a name, a ticker, a logo, optional links, the trading fee (0.25% to 5%) and where your share of the fees goes: to your wallet, back into the token, or a split. "Back into the token" makes the launch's own Autopilot treasury a fee recipient and, right after the launch opens, your identity switches on a daily buyback and burn (a first Autopilot has no waiting period). Everything else is the Fair preset. **Custom launch** is the full wizard: price curve, fee schedule, launch rules and an optional Autopilot graph.

`planQuickLaunch` plans a quick launch from the same form, purely: the parameters, the fee recipients (the treasury is `autopilotTreasuryAddress(launch)`, known before the launch exists), the metadata record and the buyback graph.

```ts title="quick.ts"
import { planQuickLaunch } from "@noisedlabs/sdk";

const quick = planQuickLaunch({
  name: "Quantum Lantern", symbol: "QLTN", iconPng, website: "https://example.org", x: "https://x.com/qltn",
  feeBps: 100,                         // 1%
  feeDestination: { split: 6_000 },    // 60% to the wallet, 40% back into the token
  creator: wallet.publicKey, identity,
});
// quick.params, quick.recipients, quick.treasury, quick.metadata, quick.graph (the daily buyback and burn)
```

```text title="the flow"
identity → metadata document → planLaunch → create_launch (wallet; wait until finalized)
→ fund the throwaway payer (wallet) → publish_metadata (payer; wait until finalized)
→ attest_launch (identity signs, payer relays) → sweep the payer → wait for the window → launch (anyone)
```

:::steps
### Create your post-quantum identity

Your identity is an LMS key with 1,024 one-time leaves. It never comes from your wallet. Pick one source:

- **Passkey:** the app derives it from your authenticator's WebAuthn PRF output (Face ID, Touch ID, Windows Hello or a security key). No new words to write down; you can export a 24-word backup.
- **Recovery phrase:** a separate 24-word phrase. The identity uses its own path (`phalanx/pq/identity/v1`), so the same phrase can also hold your PQ vaults without sharing keys.

```ts title="identity.ts"
import { pqIdentity } from "@noisedlabs/sdk";

const secret = pqIdentity.importMaster(phrase);                          // or pqIdentity.deriveMasterFromPasskeyAssertion(…)
const identity = await pqIdentity.deriveIdentity(secret.master, "mainnet", 0, { onProgress: (done, total) => {} });
console.log(identity.identityId);                                         // pq_identity = SHA256(0x21 ‖ LMS public key)
```

Why not a wallet-derived key: see [Post-quantum creator identity](/docs/concepts/pq-identity#where-the-key-comes-from).

### Write the token's metadata

The name, symbol, description, icon and links become one [on-chain record](/docs/concepts/token-metadata). Build the document once and keep its exact bytes: they are what your identity signs.

```ts title="metadata.ts"
import { buildMetadataDoc, encodeIndexedPng, validateMetadataDoc, validateTokenMeta } from "@noisedlabs/sdk";

const iconPng = await encodeIndexedPng(iconRgba, 32, 32, 16); // a 16-colour palette PNG, about 130 to 700 bytes
const input = { name: "Aegis", symbol: "AEGS", description: "A fair-launched token.", iconPng, links: { website: "https://aegis.example" } };
const check = validateMetadataDoc(input);                       // live form feedback: every problem at once
if (!check.ok) throw new Error(check.errors.join("\n"));
const doc = buildMetadataDoc(input);                            // compact JSON, at most 3,072 bytes

const metadata = { name: "Aegis", symbol: "AEGS", doc };       // flags 0: the mint's uri stays empty
const record = validateTokenMeta(metadata);                     // exactly what publish_metadata will check
if (!record.ok) throw new Error(record.errors.join("\n"));
```

Leave the uri mode at its default (`flags: 0`). Wallets then show the name and symbol from the mint, and the icon, description and links show in Noised and anything that reads the record.

### Plan the launch

`planLaunch` is pure: it validates everything like the programs do and fixes the launch address, the parameters hash, the record's bytes and hash, its address, and the exact 189-byte message your identity will sign. Start from a preset; every preset passes `validateLaunchParams` once you add your fee recipients.

| Preset | Commit window | Guard | Max wallet | Batch cap per wallet |
|---|---|---|---|---|
| `fair` | 5 min | 6 h | 1% | 5 SOL |
| `community` | 30 min | 24 h, wallet-to-wallet paused | 2% | 2 SOL |
| `turbo` | 1 min | 1 h | 3% | none |

```ts title="plan.ts"
import { checkFeeRecipients, clusterUnixTime, planLaunch, prepareFeeVault, vaultFeeRecipients } from "@noisedlabs/sdk";

// Creator fees into your own wSOL PQ vault (send feeVault.openTx first if it is not open yet).
const feeVault = await prepareFeeVault(conn, { master: secret.master, cluster: "mainnet", payer: creator });
const recipients = vaultFeeRecipients(feeVault.vault);
const fees = await checkFeeRecipients(conn, recipients);       // refuses a vault of another mint (its share would be lost)
if (!fees.ok) throw new Error(fees.refusals.join("\n"));

const now = await clusterUnixTime(conn);                        // the CLUSTER clock, bigint seconds
const plan = planLaunch({ creator, identity, preset: "fair", recipients, metadata, opensAt: now + 900n, nowSecs: now });
// window: [opensAt, opensAt + 3,600]; keep `plan` (and its launch seed) until the launch is live
```

Fee recipients are fixed forever once the launch is created.

### Create the launch

`create_launch` validates your parameters and creates the DBC config. Your wallet signs one legacy transaction (at most 1,107 bytes, even at 8 curve points and 4 recipients). Wait until it is **finalized**: the identity signs only a finalized launch.

```ts title="create.ts"
import { buildPlannedCreateLaunchTx, sendAndConfirm, simulateAndExplain } from "@noisedlabs/sdk";

const created = await buildPlannedCreateLaunchTx(conn, plan);
const sim = await simulateAndExplain(conn, created.tx);
if (!sim.ok) throw new Error(sim.error ?? "create_launch would fail");
await sendAndConfirm(conn, await wallet.signTransaction(created.tx), { commitment: "finalized" });
```

### Fund a throwaway fee payer

One throwaway key publishes the record and relays the attestation. It has no authority over anything: it only pays. `throwawayPayerFunding` adds up the record's rent, the identity's and attestation's rents and both fees, read from the cluster.

```ts title="fund.ts"
import { Keypair } from "@solana/web3.js";
import { buildFundThrowawayPayerTx, throwawayPayerFunding } from "@noisedlabs/sdk";

const payer = Keypair.generate();                               // persist its secret until it is swept
const funding = await throwawayPayerFunding(conn, { metadata: plan.metadata, launch: plan.launch, lmsPublicKey: identity.publicKey });
const fund = await buildFundThrowawayPayerTx(conn, creator, payer.publicKey, { lamports: funding.lamports });
await sendAndConfirm(conn, await wallet.signTransaction(fund.tx));
```

Keep the payer's key (the app keeps it in this browser) until the sweep below: a reload in between would otherwise strand its lamports.

### Publish the record

`publish_metadata` writes the record at the address of its own hash, in one v1 transaction (309 to 3,621 bytes). It is idempotent: if the record is already there, nothing is sent. Then wait until it is **finalized**: a record lost in a dropped fork would turn your attestation into a burn.

```ts title="publish.ts"
import { buildPlannedPublishTx, sendPublishMetadataTx, waitForTokenMeta } from "@noisedlabs/sdk";

const published = await buildPlannedPublishTx(conn, plan, payer); // "ready" or "already-published"
if (published.status === "ready") await sendPublishMetadataTx(conn, published);
await waitForTokenMeta(conn, plan.launch, plan.metadataHash);    // until finalized, about 13 s
```

### Attest the launch

Your identity signs the 189-byte message: the launch, its `params_hash`, you as creator, the record's hash and the **launch window**. The leaf ledger reserves the leaf for this message before the signature exists and records the signature before it is returned. Use one durable ledger per identity (the app keeps it in this browser's IndexedDB, behind a cross-tab lock).

```ts title="attest.ts"
import { buildPlannedAttestTx, leafLedger, sendAttestLaunchTx } from "@noisedlabs/sdk";

const ledger = leafLedger.createLeafLedger(store, { lock: (name, fn) => navigator.locks.request(name, fn) });
const built = await buildPlannedAttestTx(conn, plan, { identity, ledger, payer });
if (built.status === "ready") {
  const outcome = await sendAttestLaunchTx(conn, built, { ledger }); // "attested", "burned" or "pending"
  if (outcome.status !== "attested") throw new Error(outcome.detail);
}
```

What can go wrong, and why it is safe:

- **A signature that cannot attest still lands and burns its leaf** (record missing, window invalid). Nothing launches; the SDK says why, and stops after two such landings for one launch (`AttestRetryLimitError`) until you fix the cause.
- **`ConstraintSeeds` (2006):** someone relayed your signature with a wrong account. Nothing was burned; the SDK resends the same signature with the right accounts. It never signs again for this.
- **`PqLeafUsed`:** that leaf already landed. The SDK reads the outcome from the attestation instead of signing again.

### Sweep the throwaway payer

```ts title="sweep.ts"
import { buildSweepPayerTx } from "@noisedlabs/sdk";

const sweep = await buildSweepPayerTx(conn, payer, creator);   // what is left goes back to you
if (sweep !== null) await sendAndConfirm(conn, sweep.tx);
```

### Go live

Inside the attested window, **anyone** may run `launch`: it creates the pool and the mint (a fresh keypair) with your record's name and symbol, installs the Launch Guard policy, checks the mint and writes the certificate, atomically. It takes no metadata argument and needs no creator signature. The first `launch` to land inside the window wins, so send it as the window opens, with a priority fee. The app does this for you, and so may any keeper.

```ts title="launch.ts"
import { Keypair } from "@solana/web3.js";
import { buildPlannedLaunchTx, waitForLaunchWindow } from "@noisedlabs/sdk";

await waitForLaunchWindow(conn, plan.launch);                   // polls the cluster clock
const baseMint = Keypair.generate();
const { tx } = await buildPlannedLaunchTx(conn, plan, creator, baseMint, { computeUnitPrice: 50_000n });
// partially signed by baseMint: do not modify it, only add the payer's signature (a constant 987-byte transaction, 300,000 CU)
await sendAndConfirm(conn, await wallet.signTransaction(tx));
```

**If the window passed unused** (`getLaunchFlowStatus` reports `window-missed`, "Window passed: sign a new opening time"), sign a new window for the same launch and record: `replanLaunchWindow(plan, { opensAt, nowSecs })`, fund the payer again, then `buildPlannedAttestTx` with the new plan. The new attestation replaces the unused one (audit round 3, fix F1). A window needs at least 60 seconds left when its attestation lands.

### Watch the open

- **Commit window** (your `open_delay_secs`): anyone, you included, commits SOL to the batch. You get no allocation and no head start; commit like everyone else if you want tokens.
- **Execution window** (10 minutes): make sure `execute_batch` runs. The app sends it; [run a keeper](/docs/guides/keeper) for certainty. If it never runs, everyone is refunded in full and trading opens without a batch.
- **Guard** (your `guard_secs`): the rules you chose apply; sells always pass. Your own launch rules never apply to holders moving tokens through the Noised quantum vault or the Shield (the built-in guard limits still do), so a rule on wallet-to-wallet transfers or on who may hold can be routed around: wrap into the Shield, pass the zTokens on, unwrap.
- **Fees:** anyone can crank `claim_fees` and `distribute` at any time; your share goes to the recipients you fixed.
:::

## Checklist

- [ ] Recipients are wallets or wSOL PQ vaults you control, `checkFeeRecipients` passes, and their shares are final.
- [ ] `batch_total_cap` is a meaningful share of the threshold (the policy floor is 10%).
- [ ] The identity backup (passkey export or phrase) and the leaf ledger are stored safely; the identity is used from one ledger only.
- [ ] The record is finalized before the identity signs, and the document bytes are the ones you reviewed.
- [ ] The window opens far enough ahead for the attestation to land with at least 60 seconds of it left.
- [ ] Someone will send `launch` in the window, and a keeper will execute the batch.
