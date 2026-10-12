# Third-party notices

The Noised web app is a static bundle. Everything it runs or draws ships in the
bundle itself: there are no third-party scripts, styles, fonts, images or
analytics at runtime (the Content-Security-Policy only allows `'self'`, `data:`
images and the configured RPC endpoints; see `build/csp.ts`).

Sounds are synthesized at runtime with the Web Audio API (`src/fx/sfx.ts`): no
audio files are shipped (`media-src 'none'`). Visual effects (dot fields, the
WebGL point cloud, grain, scanlines) are generated in code or with inline `data:`
SVG; there are no third-party images.

## Fonts (SIL Open Font License 1.1)

Vendored under `src/assets/fonts/`, each with its `LICENSE` file; provenance and
SHA-256 hashes are in `src/assets/fonts/FONTS.md`.

| Font | Copyright | License |
|---|---|---|
| Geist Pixel | Copyright 2026 The Geist Project Authors (https://github.com/vercel/geist-font) | SIL OFL 1.1 |
| Jersey 10 | Copyright 2023 The Soft Type Project Authors (https://github.com/scfried/soft-type-jersey) | SIL OFL 1.1 |
| Geist | Copyright 2024 The Geist Project Authors | SIL OFL 1.1 |
| Geist Mono | Copyright 2024 The Geist Project Authors | SIL OFL 1.1 |

## Runtime libraries bundled into the app

| Package | Version | License |
|---|---|---|
| react, react-dom | 19.3.0 | MIT |
| react-router | 7.18.4 | MIT |
| motion | 13.5.0 | MIT |
| lucide-react | 1.49.0 | ISC |
| @solana/web3.js | 1.98.4 | MIT |
| @solana/wallet-adapter-react | 0.15.39 | Apache-2.0 |
| @solana/wallet-adapter-base | 0.9.27 | Apache-2.0 |
| bs58 | 6.0.0 | MIT |
| buffer | 6.0.3 | MIT |
| @noble/hashes | 2.4.0 | MIT |

Their transitive dependencies are pinned in `pnpm-lock.yaml`; each package's
license text is in its folder under `node_modules` and is preserved in the
bundle's license comments where the package ships one.

## Meteora program interfaces (MIT)

The bundle embeds the IDLs of Meteora's Dynamic Bonding Curve and DAMM v2
programs (through `@noisedlabs/sdk`, which takes them from Meteora's MIT-licensed
SDKs) to build and read their instructions and accounts. Meteora's license
text ships with the site at `/licenses/LICENSE-meteora.txt` (a copy of the
SDK's `src/idl/LICENSE-meteora`; `test/notices.test.ts` keeps them equal).
