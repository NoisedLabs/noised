# Noised app

Static Vite + React site (IPFS-deployable) for Noised, the quantum security layer for Solana: Launch (the launchpad, with a Simple mode of choices and sliders over the policy's safe values and the exact inputs under "Advanced"), Vault (the PQ vault), Shield (private balances) and Verify (any mint against the QSL-1 standard, `checkQsl1`; every token carries its QSL-1 badge). All chain access goes through `@noisedlabs/sdk` (`../sdk`). The pixel + glass interface uses local fonts (Geist Pixel, Jersey 10, Geist), a light (Paper) default theme and a dark (Graphite) one, and animations that respect reduced-motion settings.

## Build

```bash
cd ../sdk && pnpm install --frozen-lockfile && pnpm build   # the app installs ../sdk/dist
cd ../app && pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build
```

`@noisedlabs/sdk` is a `file:../sdk` dependency: pnpm copies the SDK's built `dist/` into `node_modules` at install time and resolves its dependencies together with the app's, so there is exactly one `@solana/web3.js`. Rebuild the SDK and run `pnpm install` again after SDK changes.

## Configuration (build time, see `.env.example`)

| Variable | Default | Effect |
|---|---|---|
| `VITE_RPC_URL` | the cluster's public RPC (devnet) | RPC endpoint(s); also the only hosts the CSP `connect-src` allows. |
| `VITE_NOISED_CLUSTER` | `devnet` | PQ key derivation cluster byte and explorer links. Checked against the endpoint's genesis hash at runtime; on a mismatch every transaction is refused. |
| `VITE_NOISED_MOCK` | unset | `1` builds the simulated-chain demo instead of the live SDK backend. |
| `VITE_NOISED_CSP_MWA` | `on` | `off` drops `ws://localhost:*` (Solana Mobile Wallet Adapter). |
| `NOISED_OUT_DIR` | `./dist` | Build output; must contain "dist". |

## Structure

- `src/lib/noised.ts`: the only module the UI uses for chain access. Pure functions and types are the SDK's; chain reads and transactions come from the backend selected at build time through the `#noised-backend` alias:
  - `src/lib/backend/live.ts` (default): the SDK against the configured endpoint, plus plain-words failure explanations, the genesis-hash cluster check, program deployment status, the cluster clock and the Launch Guard's effect on vault deposits and payouts (extra warnings). Vault reads, builders, the recipient check and the search for an already revealed signature (`findPendingWithdrawal`) are the SDK's own.
  - `src/lib/backend/mock.ts` (`VITE_NOISED_MOCK=1` only): the simulated chain in `src/lib/mock`. A live build fails if its code appears in the bundle.
- `src/app/tx.tsx`: the one transaction flow: build, simulate (`simulateAndExplain`), review (programs, signers, writable accounts, fee, size, logs), sign, send, confirm. Signing is offered only for the exact transaction that passed simulation and calls only known programs. A wallet that returns a different message is refused; a blockhash about to expire is rebuilt and re-simulated before the wallet sees it. The app never asks a wallet to sign a message.
- `src/lib/vaultFlow.ts`: the PQ vault (v4) withdrawal flow in its safe order: re-read the vault (`fetchVault`), check the recipient (`checkRecipient`: refusals block signing, warnings need the user's confirmation), look for a signature the vault's current key already revealed (`findPendingWithdrawal`: it is stored and re-broadcast, never re-signed), sign once (deterministic), store and read back; then broadcast withdraw + release in one v1 transaction, or the withdrawal alone with the same signature when the release would fail (`buildWithdrawTxWithFallback`). A record whose key already revealed a different signature is never broadcast. Chain access is injected, so the flow is tested against the simulated chain.
- `src/lib/storage.ts`: signed PQ withdrawals, one localStorage key per vault AND sequence (`noised.pq.withdrawal.v4:<vault>:<sequence>`), written and read back before any broadcast, never replaced by a different signature. Re-broadcast rebuilds the v1 transaction around the stored signature with a fresh blockhash; the key of a sequence never signs again. Vault v3 records (`noised.pq.withdrawal.v1:*` and the older list) are retired: listed read-only (download, fee-payer refund, removal), never broadcast or signed for.
- `src/pages/vault/`: vault accounts of a recovery phrase (`scanVaults`), the deposit address (the vault's token account; SOL or other tokens sent to the vault address itself are lost; wSOL deposits wrap automatically), deposits, the withdrawal flow, pending payouts (`listPayouts`) with a permissionless "Deliver" (`release`) and, for the recipient wallet, "Receive into another account" (`release_to`).

## Tests

`pnpm test` runs the SPEC §4.1 adapter conformance checks (vault v4 API), the live backend's logic against a stubbed `Connection` (including the SDK's pending-withdrawal search over Rust-built v1 bytes), the PQ functions against the Rust vectors in `../tests/integration/vectors/vault_withdraw.json` (key derivation on every cluster, the HMAC randomizer, deterministic signatures, the PHX-PQV4 message, v1 wire bytes), storage (v4 records, retired v3 records), the vault withdrawal flow, CSP/build checks, source boundaries and the simulated-chain flows (batch oversubscription, vault v4 payouts).

`pnpm test:browser` runs the dependency-free Chrome smoke suite in `scripts/browser-smoke.mjs`. First serve a demo build (`VITE_NOISED_MOCK=1`) at `http://127.0.0.1:5177/`, or set `NOISED_QA_URL` to its address. The suite refuses a live build before interacting with wallets. Set `CHROME_PATH` for a non-default Chrome installation and `NOISED_QA_DIR` for screenshots. It checks desktop/mobile layout, search, phase filters, mint validation, token details, wizard navigation, demo wallet connection, privacy/vault pages, themes and reduced motion. No real transactions are sent.
