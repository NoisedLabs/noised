---
title: Run a keeper
summary: Open attested launches inside their window, execute fair-open batches on time, crank claims, migrations and fees. Every crank is permissionless, so anyone can run one and no keeper holds a privileged key.
---

A keeper is a small process that watches launches and sends the permissionless instructions that keep them moving. Nothing it does needs a privileged key: its own fee-paying key only pays transaction fees and rent for accounts it creates. Run at least two independent keepers.

## Jobs

| Job | When | If missed |
|---|---|---|
| `launch` (no arguments) | inside an attested window `[not_before, not_after]` | the window passes unused; the creator signs a new one (audit round 3, fix F1) |
| `execute_batch`, as a **top-level** instruction | inside `[commit_end_ts, execute_end_ts)`, a 10-minute window | the batch expires, everyone is refunded in full and trading opens without a batch buy |
| `claim(owner)` for every commit | after execution or expiry | users can claim themselves; nothing is lost |
| DBC `migration_damm_v2` | when a curve completes | swaps revert between completion and migration |
| `claim_fees`, `claim_surplus` (after completion), `claim_lp_fees` (after migration), `distribute` | periodically | fees accumulate; nothing is lost |
| vault `release` of pending payouts | after a withdrawal sent without `release` | the payout stays reserved; anyone can release it later |

## The loop

`getLaunchFlowStatus` places each launch on its timeline from live accounts and the **cluster** clock, so the keeper never compares chain timestamps with its own clock.

```ts title="keeper.ts"
import { Connection, Keypair, type Transaction } from "@solana/web3.js";
import { buildExecuteBatchTx, buildLaunchTx, getLaunchFlowStatus, listLaunches, sendAndConfirm, simulateAndExplain } from "@noisedlabs/sdk";

const conn = new Connection(process.env.RPC_URL ?? "", "confirmed");
const keeper = Keypair.fromSecretKey(loadKeeperKey()); // fees and rent only: no authority anywhere
const computeUnitPrice = 50_000n;                       // micro-lamports per CU: a priority fee

async function tick(): Promise<void> {
  for (const l of await listLaunches(conn)) {
    const s = await getLaunchFlowStatus(conn, l.publicKey);
    try {
      if (s.step === "launch") {
        // Inside the attested window: anyone may open it; the first launch to land wins.
        const { tx } = await buildLaunchTx(conn, keeper.publicKey, l.publicKey, Keypair.generate(), { computeUnitPrice });
        tx.partialSign(keeper);                         // keep the fresh mint's signature
        await send(tx);
      } else if (s.step === "execute") {
        const tx = await buildExecuteBatchTx(conn, keeper.publicKey, l.publicKey, { computeUnitPrice });
        tx.sign(keeper);
        await send(tx);
      }
    } catch (e) {
      // Another keeper may have won; PoolAlreadyTraded means the batch can only refund: raise an alert, never loop.
      console.warn(l.publicKey.toBase58(), s.step, e instanceof Error ? e.message : e);
    }
  }
}

async function send(tx: Transaction): Promise<void> {
  const sim = await simulateAndExplain(conn, tx);
  if (!sim.ok) throw new Error(sim.error ?? "would fail");
  await sendAndConfirm(conn, tx);
}

setInterval(() => void tick().catch(console.error), 2_000);
```

`buildExecuteBatchTx` refuses a batch that already executed, holds nothing, or whose pool was traded before it (`PoolAlreadyTraded`: the batch can then only expire and refund in full; alert, do not retry). `buildLaunchTx` refuses a launch without an attestation or a record, and a time outside the window, judged on the cluster clock.

## Opening launches

Inside an attested window, `launch` is permissionless: the creator's app sends it, and so may you. The transaction is a constant 987-byte legacy transaction with no metadata argument; the token's name and symbol come from the record the attestation names. Two things to know:

- **The payer pays the launch's rent**: the pool, its vaults, the mint, the hook's meta list and policy and the certificate. Measured at LiteSVM's default rent, that was 20,288,480 lamports for a typical token with the empty uri, and 48,998,480 with the largest inline uri. Nothing of it comes back.
- **Compute.** `COMPUTE_UNITS.launch` is 300,000. A launch costs a constant base per record plus 1,500 CU per extra bump-search step of the mint's addresses: measured launches used 148,672 to 221,107 CU, and the bound for 47 extra steps (probability under one in a million) is 258,607 CU at the largest inline uri.

`buildLaunchCommitBundleV1(conn, payer, launch, baseMint, lamports)` sends `[launch, commit]` as one signed v1 transaction (1,149 bytes, 430,000 CU), for a keeper or a script that also commits.

## Getting the batch included

- **Top level only.** The hook recognizes the batch buy only when `execute_batch` is the transaction's currently executing top-level instruction. Never wrap it in your own program; a CPI'd call has its buy refused.
- **Compute.** The SDK sets a 220,000 CU limit (`COMPUTE_UNITS.executeBatch`); on the final build a batch measured 136k to 160k CU.
- **Priority fees.** Anyone can write-lock the batch's accounts and fill their per-block compute budget. The 10-minute window makes forcing an expiry cost ten minutes of that contention, but keepers still need priority fees and tight compute limits to win it. The same holds for `launch` inside its window.
- **Several keepers.** Running two or more independent keepers on different RPC providers costs little: the first `execute_batch` wins and the others fail harmlessly with `AlreadyExecuted`.

## Errors

| Error | What to do |
|---|---|
| `NotLaunchWindow` (6044) | `launch` outside the attested window; check `not_before` and `not_after` against the cluster clock |
| `AccountNotInitialized` (3012) / `ConstraintSeeds` (2006) on `launch` | no attestation or record at the derived address, or another record: rebuild with the SDK |
| `NotExecuteWindow` (6024) | too early or too late; check `commit_end_ts` and `execute_end_ts` against the cluster clock |
| `AlreadyExecuted` (6025) | someone else executed it; move on |
| `EmptyBatch` (6026) | nothing was committed; there is nothing to do |
| `EmptySwap` (6027) | the cap bought nothing; the batch will expire and refund |
| `PoolAlreadyTraded` (6038) | something traded the pool before the batch, which the hook should make impossible: do not retry, raise an alert; committers are refunded in full after `execute_end_ts` |
| `SnipeShield` (hook 6000) | the call was not top-level |
