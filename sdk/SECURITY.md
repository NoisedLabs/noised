# Security policy: @noisedlabs/sdk

This SDK builds the transactions Noised users sign, makes their post-quantum signatures and produces the verification reports they rely on. A bug here can lose funds or make an unsafe launch look safe, so please report vulnerabilities **privately**. The project-wide policy (scope of the programs, safe harbour, disclosure timeline) is [SECURITY.md at the repository root](../SECURITY.md); this file adds what is specific to the SDK.

## Reporting a vulnerability

- **Email:** `security@noised.fun`.
- **GitHub:** a private report through [GitHub's private vulnerability reporting](https://github.com/NoisedLabs/noised/security/advisories/new).
- **Encryption:** no PGP key is published yet. Until one is, send a short first message without details and we will set up an end-to-end encrypted channel.
- Include the SDK version (or commit), the function involved, the impact, and a reproduction: ideally a failing vitest test with a mocked connection, or a script against a local validator or devnet.

Do **not** open a public issue, pull request or post about an unfixed vulnerability. Never run an exploit against mainnet, even "just to check".

Targets: acknowledgement within 72 hours, initial assessment within 7 days, coordinated disclosure (by default 90 days after the report or after a fix ships, whichever is first). No bug bounty is live yet; reports made before one launches will be considered for retroactive rewards.

## In scope

- **Post-quantum keys:** any path that can make one LM-OTS vault key, or one LMS identity leaf, sign two different messages (including across retries, tabs, processes or clusters); a signer whose bytes differ from the Rust reference (`crates/noised-lmots`) or from the known answers; a key derivation that differs from the specification; a way to make `prepareWithdrawal`, `signWithdrawal`, `buildAttestLaunchTx` or the leaf ledger sign without the checks they document (cluster genesis hash, key index, history search, ledger reservation).
- **Verification:** `verifyLaunch` or `checkPqOrigin` reporting a launch, a post-quantum origin or an off-chain metadata document as safe or verified when it is not.
- **Transaction builders:** a builder that produces a transaction doing something other than what its documentation says (other accounts, amounts, recipients or programs), pays the wrong party, or strands funds that its checks claim to protect (payout owners, fee recipients, swap recipients, vault recipients).
- **Parsing:** account or transaction decoding that accepts forged or malformed data a correct client must refuse.
- **Packaging:** the published tarball containing anything that is not built from this repository's sources (see "Checking the package" below).

## Out of scope

- Bugs in the on-chain programs themselves: report them under the root policy (they are in scope there).
- Meteora, Token-2022, `@solana/web3.js`, wallets and RPC providers: report to their maintainers.
- Risks the documentation already states as residual (see the root policy), such as the trusted parties `verifyLaunch` lists, or a dishonest RPC (the report is only as honest as the RPC: compare two). A new way to exploit them is in scope.
- Misuse the documentation warns against, such as signing with `LmsKeyPair.sign` and a chosen randomizer, or a leaf-ledger store whose `add` is not atomic.

## Supported versions

Only the latest `0.x` release (or the main branch, until the first release) receives fixes. The SDK and the programs are **pre-audit**: no independent audit has been completed and the programs are not finalized.

## Checking the package

Releases are published only by this repository's release workflow (`.github/workflows/release.yml`), from a version tag on `main`, with npm provenance through npm trusted publishing: no npm token is stored anywhere. Before upgrading, run `npm audit signatures` and check that the provenance points at this repository and at the tagged commit. To use an unreleased commit, build it from a reviewed checkout (`pnpm install --frozen-lockfile && pnpm build && pnpm pack`). The tarball must contain only `package.json`, `README.md`, `LICENSE`, `NOTICE`, `CHANGELOG.md`, `SECURITY.md`, `dist/` and `src/`.
