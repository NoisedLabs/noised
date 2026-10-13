# Mainnet deployment

Status on 2026-10-13. All five Noised programs are deployed on **Solana mainnet-beta**:
- **Built in CI, not on a laptop.** Every binary comes from the verifiable release dry run [38432874027](https://github.com/NoisedLabs/noised/actions/runs/38432874027) of commit [`e673175979e0cfbdc6979dc9cd98f7fd2a3444d9`](https://github.com/NoisedLabs/noised/commit/e673175979e0cfbdc6979dc9cd98f7fd2a3444d9): `solana-verify` 0.5.2 (Docker), SBPF v3.
- **Checked byte for byte.** After each deploy, the on-chain program was dumped with `solana program dump`, and the SHA-256 of the dump equals the SHA-256 of the release file.
- **Upgradeable, not finalized.** Every program's upgrade authority is `EXgNtEcJ2Co61EQUHfNFN7z8SC3RpmhYKrqcMVcPpJqz`, a single key (the deployer's), not a multisig. Until a program is finalized, whoever holds that key can replace its code, and every guarantee that program enforces is only as strong as that key.
- **The protocol is not initialized.** `initialize_protocol` has not run, so the `Protocol` account (`BTiVRCENNQB8wnDCbAAoufHX3EgDKG9AioTu3BiDKc5M`) does not exist and `create_launch` fails: **no launch can be created on mainnet yet.** The vault and the shield do not read the `Protocol` account, so they work on their own.
- **Not audited.** No independent audit has been completed. The reviews in [AUDIT.md](AUDIT.md) are internal.
- **No QSL-1 level yet.** Level 1 requires finalized programs (condition C1.24), so until finalization a verifier reports "candidate" at most, on mainnet too ([standard/QSL-1.md](standard/QSL-1.md)).
- **Clients of this commit or later.** The deployed autopilot judges a price condition across every price observed in its window (review F1). The published `@noisedlabs/sdk` 0.9.0 and `@noisedlabs/mcp` 0.2.0 predate that change and judge it on the reference price alone, so they can show a price-gated step as due when the program would refuse it. The SDK's unreleased changes ([sdk/CHANGELOG.md](../sdk/CHANGELOG.md)) mirror the program; they touch only the autopilot.

The program ids are the same on every cluster. Devnet still runs the older builds listed in [DEVNET.md](DEVNET.md), without the shield.

## Programs

Each program was deployed with `solana program deploy --max-len <size of its .so>`, so its program data holds exactly the release file, with no padding.

| Program | Program id | ProgramData | Deploy slot | Bytes | SHA-256 of the `.so` (= on-chain dump) |
|---|---|---|---|---|---|
| `noised_launchpad` | [`CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc`](https://explorer.solana.com/address/CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc) | `7F533qLZoXf4cEGnywZ4H4p2fkTUC7MkQghm8VwBzYnv` | 456,526,204 | 189,168 | `b7823d236d1d0a16d367daf98fb0c6f37643a3dca15690b7d21782640e8b13a7` |
| `noised_autopilot` | [`D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx`](https://explorer.solana.com/address/D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx) | `CzC1TELZTPPUVYENqJbRGunsGJH8zegfKTsoda2RXcR8` | 456,526,320 | 112,168 | `b4ad632f9de89ad9c6eb4e3be8f9c871b423edc83bef95409d2106c5458fced9` |
| `noised_shield` | [`BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9`](https://explorer.solana.com/address/BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9) | `9vYFX965RrzFJzvsrerNgtf5cgfcXjDjCGXDA1b7p6YN` | 456,526,384 | 71,112 | `cd59daa8ab6fabe3f28d44f4edf12740e306c685c787ce21224586c87bcd8919` |
| `noised_vault` | [`7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb`](https://explorer.solana.com/address/7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb) | `AXNGGsEypP6ocuiAkm3EMuABGGkFGL4F88cmG8A8dwS7` | 456,526,449 | 62,416 | `fde35f7dfcf8ca096d3d404308a021c3d71dc6000de9a1f98510ce12a165daf8` |
| `noised_hook` | [`cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia`](https://explorer.solana.com/address/cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia) | `CPh2VRvpRG1Utp8kkPtxvsEM2kvyHeBJLdXojn33Jowx` | 456,526,515 | 46,952 | `d43da765ef46f9e61e49f8f80bbfc2319285c60ceb912369a7275005f087a7d8` |

The release run's `EXECUTABLE_HASHES`: what `solana-verify get-executable-hash` prints for each release file, and so what `solana-verify get-program-hash -um <program id>` must print for the deployed program. It differs from the plain SHA-256 above because solana-verify strips trailing zero bytes before hashing.

| Program | Executable hash (solana-verify) |
|---|---|
| `noised_launchpad` | `84c8ed8ec4e4efeb3e7fa41be09911c3a7734b880530664c2baba8e16bcfd2d8` |
| `noised_autopilot` | `17673bea51478287cfbe0b6d59052d1f9b090c7eb80bcc50c775bc285915091d` |
| `noised_shield` | `da89a1ddb1e5af24e768c42f51adfa00aeb37f7a135bdbef43e3eae2dd8795f4` |
| `noised_vault` | `ee46c829c714d90f167281f428de0f506d06bd2e7866bf7890e9c76f6b3a095c` |
| `noised_hook` | `b5eba6c7c8f72fd73a517ec2df651eab55e851cb28c5fe3ecef3940be591783b` |

Deploy transactions:

| Program | Transaction |
|---|---|
| `noised_launchpad` | [`vVnAAJQu…`](https://explorer.solana.com/tx/vVnAAJQuyp7kpLSPHHCygbEUR26ThVMRRpevi5s3iK1Pih7N6A83ufE8jiazqFS2SKyMnrgqxFHuMVzE3nkihhe) |
| `noised_autopilot` | [`4i8nwUkV…`](https://explorer.solana.com/tx/4i8nwUkVMy6pmS3CRhRkVJpPqtHBg4arYXZajg4ygfKbeRvYW4PsjY5KMxZWE8rFeSYvBgch5yi8scGpsNMw8LrJ) |
| `noised_shield` | [`3vgu1KG2…`](https://explorer.solana.com/tx/3vgu1KG2TBaSZKYf9GBojNCQ7ernEVyCcmzqmBdcRWjUNhQ7Px2JYZH2apGHoQaMsWfZyNkkcLJqJv8WDwsQkoMd) |
| `noised_vault` | [`676Ju6Tz…`](https://explorer.solana.com/tx/676Ju6TzUvmcNuzQYiHhoQjG3kU2ukbhi5pUFYL6gEQxviRH2n2pdvToJpBXxmRjZHUxCfxY2AEuGRrahznxFL6z) |
| `noised_hook` | [`3sodSPyE…`](https://explorer.solana.com/tx/3sodSPyEW8p4eKKX4bRFcUgGyZzeMQYkYDuz7gpntjKTjBddghDTNeddWVafEBkrQGAiPzbebnWUkmsuaobUKRTB) |

**Cost.** 2.45618508 SOL of rent is locked in the five programs: 2.45201948 in their program data accounts and 5 × 0.00083312 in the program accounts, at mainnet's 5,080 lamports per byte. The deployer went from 3.000001 to 0.541163065 SOL; the remaining 0.002652855 SOL went on transaction and priority fees. No deploy buffer was left open.

## Verify it yourself

Nothing here signs or sends anything. With the Solana CLI:

```bash
# 1. The bytes on chain: dump each program and hash the dump (compare with the table above)
solana program dump CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc launchpad.so -u mainnet-beta
sha256sum launchpad.so        # b7823d236d1d0a16d367daf98fb0c6f37643a3dca15690b7d21782640e8b13a7

# 2. Who can still change it: the upgrade authority and the slot of the last deploy
solana program show CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc -u mainnet-beta
#   Authority: EXgNtEcJ2Co61EQUHfNFN7z8SC3RpmhYKrqcMVcPpJqz   ("none" only after finalization)
#   Last Deployed In Slot: 456526204                         (a later slot means it was upgraded since)

# 3. Whether the protocol is initialized (an "AccountNotFound" error means: not yet)
solana account BTiVRCENNQB8wnDCbAAoufHX3EgDKG9AioTu3BiDKc5M -u mainnet-beta
```

Repeat 1 and 2 for every program id in the table.

That the bytes come from this repository's source is a separate check: rebuild them at the commit with `solana-verify` (Docker, Linux) and compare executable hashes.

```bash
cargo install solana-verify --locked --version 0.5.2
git clone https://github.com/NoisedLabs/noised && cd noised
git checkout e673175979e0cfbdc6979dc9cd98f7fd2a3444d9
solana-verify build --library-name noised_launchpad --arch v3    # repeat for each library name
solana-verify get-executable-hash target/deploy/noised_launchpad.so
solana-verify get-program-hash -um CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc   # must print the same hash
```

The library names are `noised_launchpad`, `noised_autopilot`, `noised_shield`, `noised_vault` and `noised_hook`. `--arch v3` is required: solana-verify builds SBPF v0 without it. `solana-verify verify-from-repo -um --program-id <id> https://github.com/NoisedLabs/noised --library-name <lib> --arch v3 --commit-hash e673175979e0cfbdc6979dc9cd98f7fd2a3444d9` runs the same build and comparison in one command; writing its verification record on chain is the owner's step 3 below. Every build parameter (mount path, Docker image and digest) is listed in [OPERATIONS.md, Verifiable builds](OPERATIONS.md#verifiable-builds-linux-ci).

## What is left, in order

1. **Initialize the protocol, before finalizing anything.** Open the treasury, a PQ vault of wSOL whose 24-word phrase is generated and backed up offline, then run `initialize_protocol(platform_fee_bps)` signed by the launchpad's upgrade authority, and check the `Protocol` account with the SDK's `fetchProtocol` ([OPERATIONS.md, The treasury and `initialize_protocol`](OPERATIONS.md#the-treasury-and-initialize_protocol)). The treasury and the fee are set once, forever. Until this lands, no launch can be created, and the app shows "Launches open soon" instead of the launch form. After the launchpad is finalized it can never land.
2. **Run the devnet live flows on the same binaries.** Devnet runs the older builds of [DEVNET.md](DEVNET.md) (and no shield). Put these five release files on devnet, keeping the [deployment invariants](OPERATIONS.md#deployment-invariants) in mind for the programs already there, then run Flow A (through graduation, migration and the Autopilot buyback) and Flow B live, and a Shield round trip.
3. **Publish the verification with OtterSec.** While the upgrade authority still exists, upload each program's verification record (`solana-verify verify-from-repo` with the parameters above, signed by the upgrade authority) and queue OtterSec's remote job (`solana-verify remote submit-job --program-id <id> --uploader EXgNtEcJ2Co61EQUHfNFN7z8SC3RpmhYKrqcMVcPpJqz`). The repository must be public at the commit. After finalization only OtterSec's operator can attach a record.
4. **Finalize each program, and only on the owner's explicit confirmation.** `solana program set-upgrade-authority <PROGRAM_ID> --final` removes the upgrade authority forever: no bug can be fixed in place afterwards. Do the launchpad last, and never before the `Protocol` account from step 1 is verified ([OPERATIONS.md, Release and finalization](OPERATIONS.md#release-and-finalization)). Then confirm `Authority: none` for all five and publish it. Only then can a token reach a QSL-1 level.

## For the owner to decide before finalizing

- **The upgrade authority is a single key.** The release checklist ([OPERATIONS.md](OPERATIONS.md#release-and-finalization), step 4) asks for a multisig with a timelock until finalization. Moving the authority to one is an on-chain `set-upgrade-authority`, signed by the current key.
- **No `security.txt` in the binaries.** The deployed programs do not embed one (checklist step 2). Adding it means a new build and an upgrade before finalization, with new hashes in this document.
- **Independent audits.** None has been completed. The release checklist lists them before finalization (step 1).
- **An RPC provider for the app.** The mainnet build of the app defaults to Solana's public endpoint, which rate-limits and is not meant for production. See [app/README.md](../app/README.md#mainnet-build).
