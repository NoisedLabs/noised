---
title: Introduction
summary: Noised is a token launchpad on Solana where no key, the creator's included, can rug a launch, and where launches and vaults are protected by hash-based, post-quantum signatures.
---

Noised launches tokens on Meteora's Dynamic Bonding Curve (DBC) through one program that fixes every dangerous setting, holds every privileged role itself through program-derived addresses (PDAs, which have no private key), opens trading with a fair pro-rata batch and writes an on-chain certificate that anyone can re-check against the live chain. Value you want to keep can sit in a **PQ vault** that only a hash-based signature (LM-OTS, RFC 8554) can open.

These docs are the technical side of Noised. The app explains things in plain words; here you get account layouts, instruction arguments, error codes, byte formats and the reasons behind each rule. For the long-form argument, with proofs and figures, read the [whitepaper](/whitepaper).

::figure programs

## What every launch guarantees

Each line holds for every mint that has a Noised certificate, and each is enforced on-chain by code you can read in the [programs reference](/docs/programs).

- **Fixed supply, no freezes.** Mint and freeze authorities are None, checked by `launch` on the live mint before the certificate is written.
- **No hidden powers.** The mint has exactly three Token-2022 extensions (metadata pointer, metadata, transfer hook). Extensions cannot be added later.
- **Metadata stored on-chain.** The name, symbol, description, icon and links are one record on Solana at the address of its own hash, signed by the creator's post-quantum identity, and the mint shows exactly that record. No link, no server. See [Token metadata](/docs/concepts/token-metadata).
- **No early buyers.** Until the fair open, the Launch Guard hook refuses every buy except the batch's single purchase, made inside the launchpad's own top-level `execute_batch`. See [Snipe shield & Launch Guard](/docs/concepts/launch-guard).
- **One price for the batch.** Everyone in the batch pays the same average price, pro rata to what they committed. See [Fair-open batch](/docs/concepts/fair-open-batch).
- **Selling is never blocked** by Noised, and every launch rule ends at most 72 hours after launch.
- **Liquidity locked forever.** At graduation 100% of the liquidity moves to a Meteora DAMM v2 pool and is permanently locked under a PDA with no withdraw instruction.
- **Fees by fixed rules.** Recipients and shares are set at creation and can never change; fees paid in the launched token are burned.
- **No admin.** No pause, no settings update, no privileged withdrawal.
- **Post-quantum origin.** Every launch is signed by its creator's hash-based identity, over its parameters, metadata and opening window, and the launchpad verifies that signature on-chain before the launch can go live. See [Post-quantum creator identity](/docs/concepts/pq-identity).

:::warn Status: not yet finalized
The programs are not yet finalized (made immutable). They have had three rounds of internal adversarial review by AI agents ([Security](/docs/security#internal-reviews)). Until their upgrade authority is set to None, whoever holds it can replace the code. Check any program with `solana program show <program id>`: the line `Authority:` must read `none`. Do not use Noised with funds you cannot afford to lose until then.
:::

## How these docs are organized

::figure doc-map

Press <kbd>Ctrl</kbd> <kbd>K</kbd> (or <kbd>/</kbd>) anywhere to search pages, headings, SDK functions, instructions and error codes.

## Words used precisely

- **must**: enforced on-chain by a Noised program. **should**: what the SDK and the app do.
- **Batch**: the fair-open batch, one pooled purchase at the open.
- **Guard**: the Launch Guard rules (max wallet, max buy, optional wallet-to-wallet pause) that run from the launch until `guard_end_ts`.
- **Graduation**: the bonding curve reaches its threshold, DBC removes the hook and the liquidity migrates to DAMM v2.
- **PQ**: post-quantum. Here it always means hash-based signatures (LM-OTS and LMS, RFC 8554), whose security rests on SHA-256 alone.
