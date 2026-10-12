# Contributing to Noised

Thank you for helping. Noised holds other people's money and its programs are meant to become unchangeable, so changes are held to a high bar. **Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue or pull request.**

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Where to start

| You want to change | Read first |
|---|---|
| A program (`programs/`) or a shared crate (`crates/`) | [docs/SPEC.md](docs/SPEC.md) (the implementation contract), [docs/SECURITY_GUARANTEES.md](docs/SECURITY_GUARANTEES.md), [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| The TypeScript SDK (`sdk/`) | [sdk/CONTRIBUTING.md](sdk/CONTRIBUTING.md) |
| The MCP server (`packages/noised-mcp/`) | [packages/noised-mcp/README.md](packages/noised-mcp/README.md#development-and-supply-chain) |
| The web app (`app/`) | [app/README.md](app/README.md) |
| The QSL-1 standard (`docs/standard/`) | [docs/standard/QSL-1.md](docs/standard/QSL-1.md) |

Build and test instructions for Linux and Windows are in the [README](README.md#build-and-test-from-source). CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs every check on every pull request.

## Rules for every change

- **One topic per pull request**, with the reason for the change. For a protocol change, say which program change it mirrors.
- **Security-relevant changes need a test that fails without the change.** Program fixes also get a LiteSVM regression test against the mainnet binaries, and the mutation checks must still kill every mutant.
- **Formats are permanent.** Never change a signed message format, a PDA seed or an account layout in place, and never renumber an error: append new ones (OPERATIONS.md, "Deployment invariants").
- **Dependencies are pinned exactly** (`=` in Cargo, exact versions with lockfiles in JavaScript), with no install scripts and a 7-day minimum release age. Do not add or upgrade a dependency without saying why and which version you reviewed.
- **No code from Meteora's program repositories.** They are under a non-commercial license. The IDLs in `idls/` come from Meteora's MIT-licensed SDKs.
- **Never commit secrets or machine-specific files**: keypairs (`.keys/`, `*-keypair.json`, deployer or wallet files), seed or PQ phrases, `.env` files, logs, local paths. `.gitignore` covers the usual ones; check `git status` before you commit.
- Keep claims precise. Documentation that overstates a guarantee is a bug.

## Checks before you open a pull request

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
# plus the suites your change touches: the LiteSVM workspaces, sdk/, app/, packages/noised-mcp/ (see the README)
```

## License

By contributing, you agree that your contributions are licensed under the [Apache License, Version 2.0](LICENSE), as section 5 of the license states. There is no separate contributor agreement.
