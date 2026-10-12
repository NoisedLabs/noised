# Security policy

Noised is security-critical software that holds other people's money. If you find a vulnerability, please tell us privately first. We will work with you to fix it and credit you.

## Reporting

- **Email:** `security@noised.fun`.
- **GitHub:** a private report through [GitHub's private vulnerability reporting](https://github.com/NoisedLabs/noised/security/advisories/new) (only the maintainers can read it).
- **Encryption:** no PGP key is published yet. Until one is, send a short first message without details and we will set up an end-to-end encrypted channel.
- **Please include:**
  - the affected component (program, crate, SDK, app) and the commit or deployed program ID
  - a description of the impact
  - step-by-step reproduction, ideally a LiteSVM test or a local-validator script
  - any suggested fix

Please do **not** open a public issue, pull request or social-media post about an unfixed vulnerability.

## What to expect and disclosure policy

| Step | Target time |
|---|---|
| Acknowledgement | within 72 hours |
| Initial assessment (valid / severity / scope) | within 7 days |
| Fix or mitigation plan | depends on severity; critical issues are worked on immediately |
| Public disclosure | coordinated with you, by default 90 days after the report or after a fix ships, whichever is first |

We will keep you informed and credit you in the advisory unless you prefer otherwise. Fixed vulnerabilities are disclosed in a GitHub security advisory and in [docs/AUDIT.md](docs/AUDIT.md), with the affected versions or program deployments. A program that is already finalized cannot be patched in place: the advisory then says so plainly and gives users the safe course of action.

**No bug bounty is live yet.** When one launches, its terms will be published here. Reports made before then will be considered for retroactive rewards.

## Important: our programs have no pause button

By design, Noised programs have no admin, no pause and, once finalized, no upgrade path. See [docs/SECURITY_GUARANTEES.md](docs/SECURITY_GUARANTEES.md). After finalization, **an exploitable bug cannot be stopped or patched on-chain by anyone**, including us. Responsible disclosure is therefore even more important than usual. Never run an exploit against mainnet, even "just to check". Use a local validator, LiteSVM or devnet.

## Scope

**In scope**

| Component | Location |
|---|---|
| `noised_launchpad` | `programs/noised-launchpad`, program `CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc` |
| `noised_hook` (Launch Guard) | `programs/noised-hook`, program `cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia` |
| `noised_vault` (PQ vault) | `programs/noised-vault`, program `7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb` |
| `noised_shield` | `programs/noised-shield`, program `BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9` |
| `noised_autopilot` | `programs/noised-autopilot`, program `D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx` |
| Launch rules and autopilot graphs (PXR1, PXG1) | `crates/noised-rules`, `sdk/src/programmable` |
| LM-OTS and LMS signatures (PQ vault, launch identities, autopilot authorizations) | `crates/noised-lmots`, `sdk/src/pq` |
| SDK | `sdk/` (transaction builders, the launch flow, `verifyLaunch`, PQ identity and vault key derivation, the leaf and vault-key ledgers, signing, autopilot builders and keepers) |
| MCP server | `packages/noised-mcp` (what it builds, untrusted on-chain text, cluster checks) |
| Frontend | `app/` (transaction construction, displayed safety information, CSP) |
| Documentation | a claim in `docs/` (the QSL-1 standard in `docs/standard/` included) or this repository's READMEs that is false, or that would lead users to an unsafe action |

Examples of what we especially want to hear about:
- a way to move funds held by Noised PDAs other than the paths listed in SPEC §7, invariant 6
- a launch that passes the certificate checks but violates the safety policy
- a launch that goes live without a valid attestation by the identity its parameters name, outside the window that identity signed, or with metadata other than the record that identity signed
- an LMS or LM-OTS forgery; a way to make the launchpad accept a second signature at a leaf; a valid signature that cannot land and burn its leaf; a way for whoever relays an attestation to change what it does (rather than only delay it)
- a way to change a metadata record after it is written, or to make a launch use a record other than the one its attestation names
- a way to make an attested launch unable ever to go live, other than by paying to crowd out each of its windows; a way to replace the attestation of a launch that is `Live`, or one whose window has not ended, or to replace it with anything but a valid signature of the launch's identity ([docs/AUDIT.md](docs/AUDIT.md) §14, F1)
- a transfer the Launch Guard refuses that is a sell, or that happens after the guard ends; a creator rule that refuses a sell, a batch claim, the batch buy, a transfer after the guard, or a PQ vault or Shield exit sent straight to those programs; a launch whose hook policy holds rules other than the bytes its identity attested, or a certificate whose `rules_hash` or `RULES_BOUND` says otherwise; a way to end or move a snipe shield other than the launchpad's own `execute_batch` moving it earlier; a transfer during the guard, other than a sell or a zero amount, that lands in a token account whose owner can be reassigned (outside the launchpad's exempt accounts; F2), or a token account the hook wrongly reads as having an immutable owner
- a token that the QSL-1 verification algorithm ([docs/standard/QSL-1.md](docs/standard/QSL-1.md) §7) places at a level whose conditions it does not meet, or a condition of the standard that does not deliver what its level claims
- any buy other than the batch buy that the Launch Guard lets through before the snipe shield ends, even one that receives no tokens; a way to make `execute_batch` buy after another swap of the pool; or any other way to gain an edge in the fair-open batch
- any accounting error in the fair-open batch or fee distribution; a way to redirect a commit's payouts away from the owners its first commit fixed; a way for one vault to receive more than one wallet's batch cap; a way for one party to block another's claim
- a message-binding gap, a key-index bypass or a key-reuse path in the PQ vault
- a way to make a correctly signed vault withdrawal fail permanently, to move vault tokens other than by delivering a signed payout to its recipient, or to make `reserved` exceed the vault's balance
- a client path (SDK or app) that can produce a second signature with one PQ key or one LMS leaf, including a signer whose randomizer differs from the known answer in SPEC §3.10, or a way around the SDK's ledgers, recipient confirmation or cluster check
- a way to break the shield's supply invariant
- a way to move value out of an autopilot treasury other than a burn, a buyback whose tokens are burned in the same instruction on the launch's own pool, a payment to the active graph's recipients or a bounded tip; a way for the treasury to sell the token; a buyback outside its price bound
- a way to change, unfreeze or replace an autopilot graph without a fresh authorization by the launch's identity, before the 72-hour timelock, or after a freeze; a way to reuse an authorization, use a freeze after its `not_after`, or give a revoked operator power again; an operator acting outside its node's bounds
- an `Authorization` written by `pq_authorize` for another identity, another kind than 1 to 3, or twice at one address
- the SDK reporting a launch as safe when it is not, or showing a programmable launch as safer than its level

**Out of scope** (please report to the owner instead)

| Issue | Report to |
|---|---|
| Meteora DBC, DAMM v2 and other Meteora programs | Meteora |
| Token-2022, SPL Token, the ATA program, the ZK ElGamal proof program, the Solana runtime | Anza / Solana Foundation |
| Wallet software, passkey authenticators and sync providers, RPC providers, Squads | their vendors |

Also out of scope:
- Issues our internal reviews ([docs/AUDIT.md](docs/AUDIT.md)) list as fixed or accepted, unless you show that the fix does not hold. Risks already documented as residual in [docs/AUDIT.md](docs/AUDIT.md) §6, [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and [docs/SECURITY_GUARANTEES.md](docs/SECURITY_GUARANTEES.md), such as Meteora's upgrade authority and operator powers, Sybil splitting of max-wallet limits and of the batch's per-wallet cap, write-lock contention during the commit and execution windows, the first transaction in a launch window winning, a relayer delaying a signed transaction, an older attestation signature that never landed taking the slot of a window that passed (within the windows and records the identity signed), two devices that do not share their one-time-key ledgers, a vault's batch quota used up by other people's commits, shared accounts (such as the Shield escrow) filled to max-wallet during the guard, control of a position changing during the guard without a token transfer (several people sharing one wallet, PDA or smart-wallet owners, a PQ vault's key rotated to another party, delegate approvals), guarded transfers into accounts without an immutable owner waiting for the guard to end, creator rules that restrict buys to listed wallets or refuse nothing (disclosed, not prevented), creator rules being routed around through the PQ vault or the Shield (never the built-in checks), the autopilot's reference-price and keeper residuals (a sandwich bounded by the premium, a sole observer moving the reference at most 5% an hour or pricing a buyback at a stale reference after a fall nobody else observed, buybacks delayed by a dumped pool, keepers splitting a buyback into partial runs, distributions skipping recipients without a wSOL account), withheld autopilot authorizations used later within their validity, automation that nobody runs, an operator or keeper key being classical, Ed25519 wallets not being post-quantum, wallets not showing a token's icon, or SOL and other mints sent to a vault PDA being unrecoverable. A new way to *exploit* one of them in a way we have not described, or one that is much cheaper than documented, is in scope. The client findings of audit round 4 ([docs/AUDIT.md](docs/AUDIT.md) §16: among them a dishonest RPC steering a second device onto a used leaf, RPC-clock-signed times and the pending-signature race in SDK 0.8 and earlier) are known and fixed in SDK 0.9.0, `@noisedlabs/mcp` 0.2.0 and the app; a way around those fixes is in scope.
- Denial of service by spamming the network, social engineering of our team, and physical attacks.
- Tokens or pools created outside Noised, including pools created by third parties on a Noised DBC config without a Noised certificate. A way to make such a pool *appear* certified is in scope. Metadata records published by third parties under a launch are expected; a way to make a reader that follows the attestation or the certificate show one is in scope.

## Safe harbour

If you act in good faith and follow this policy, we will:
- not pursue or support legal action against you for your research;
- consider your research authorized for the purposes of anti-hacking laws, as far as we are able to;
- work with you to understand and fix the issue quickly.

Good faith means:
- only testing on local validators, LiteSVM or devnet, or on accounts you own;
- never accessing, moving or freezing other people's funds;
- never spending other people's one-time keys or identity leaves;
- if you accidentally gain access to funds or data, stopping at once, telling us, and not keeping or using them;
- not degrading service for others;
- giving us reasonable time to fix the issue before disclosure.

This safe harbour cannot bind third parties such as Meteora or Anza, and it does not override applicable law.

## Supported versions

Only the latest commit on the main branch and the currently deployed program versions are supported. Once a program's upgrade authority is set to None, its deployed version can no longer be changed. A fix for a finalized program means deploying a new program, plus migration guidance for users.
