# Examples

Small scripts that use the SDK the way an integrator would. Each file starts with a comment that lists its environment variables and the safety rules it follows.

| Example | What it does | Signs with |
|---|---|---|
| [`verify-mint.ts`](verify-mint.ts) | Re-checks a launch from live chain data (`verifyLaunch`), including its post-quantum origin and its on-chain metadata record (name, symbol, description, icon, links; nothing is fetched), then checks it against QSL-1 and prints the badge (`checkQsl1`, `qslBadge`). | nothing (read-only) |
| [`launch-with-pq-identity.ts`](launch-with-pq-identity.ts) | Launches a token: fee vault, the metadata document (`buildMetadataDoc`), plan, `create_launch`, `publish_metadata` (waits until it is final), `attest_launch` signed by the creator's LMS identity, the sweep of the throwaway payer, the wait for the window, then `launch`. It resumes after an interruption, and signs a new opening time when a window passed without a launch. | the creator's wallet; the PQ identity (through the leaf ledger); a throwaway fee payer kept in `STATE_DIR` until swept |
| [`commit-and-claim-into-vault.ts`](commit-and-claim-into-vault.ts) | Commits SOL to the fair-open batch with the tokens and the refund paid into the committer's PQ vaults, then claims. | the committer's wallet |
| [`vault-withdraw.ts`](vault-withdraw.ts) | Withdraws from a PQ vault: recipient check and the user's three confirmations (`--confirm-recipient-warnings`, `--confirm-mint-warnings`, `--confirm-off-curve`) passed to `prepareWithdrawal` as `confirm`, the vault-key ledger (with `IMPORT_LEDGER` / `EXPORT_LEDGER` to carry signed records between two machines holding the phrase; an import reporting `unverifiable` keys stops it, and an export first completes records an older SDK wrote without their key), history search, one deterministic LM-OTS signature recorded before it exists and before it is broadcast, withdrawal plus release, fee-payer refund. | the PQ vault key (once); a throwaway fee payer |
| [`keeper-execute-batch.ts`](keeper-execute-batch.ts) | Executes a launch's batch as soon as its commit window closes. | the keeper's wallet |

`shared.ts` holds the helpers the examples share: configuration, keypair files, simulate-then-sign-then-send, and durable on-disk stores for the leaf and vault-key ledgers (one store interface) and the LMS tree cache.

## Running them

From `sdk/`, after `pnpm install` and `pnpm build` (the examples import `@noisedlabs/sdk`, which resolves to `dist/` through the package's own `exports`):

```bash
RPC_URL=https://api.devnet.solana.com MINT=<mint address> node examples/verify-mint.ts
```

Node 22.18 and later run TypeScript files directly. On Node 22.12 to 22.17, add `--experimental-strip-types`. In your own project, install the SDK and copy the example you need: the imports stay the same.

Start on devnet (`NOISED_CLUSTER=devnet`, the default) or a local validator (`NOISED_CLUSTER=localnet`). The scripts that sign read secrets from files (`*_KEYPAIR`, `PQ_PHRASE_FILE`), never from environment variables or arguments. Their `STATE_DIR` holds records that prevent a one-time key from signing twice, so keep that directory, and a backup of it.

`pnpm typecheck` type-checks the examples against the SDK's sources (`examples/tsconfig.json`), so they cannot drift from the API. The tests never run them: every example talks to an RPC.
