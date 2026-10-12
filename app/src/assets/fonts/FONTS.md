# Bundled fonts

The app ships its own fonts (the CSP is `font-src 'self'`: nothing is loaded from
a third party). Every file here is an unmodified copy from an npm tarball; only
the Latin and Latin Extended subsets (and, for Geist Mono, the box-drawing
"symbols2" subset) are kept. The `@font-face` rules with matching
`unicode-range` are in `src/styles.css`. A browser downloads a file only when
the page uses one of its characters in that family.

| Family | Role (PIXEL_V6 section 1) |
|---|---|
| Geist Pixel (`"Geist Pixel"`) | headlines and big numbers. One weight (400). Its pixel is 38/1000 em, so it is pixel-exact at 26.3158px x n (`--px-1` .. `--px-5`). The `@font-face` declares `font-weight: 100 900` so browsers never synthesise a fake bold |
| Jersey 10 (`"Jersey 10"`) | small pixel UI text: navigation, buttons, labels, chips, badges. One weight (400). Its pixel is 75/1400 em: pixel-exact at 18.6667px (`--ui-px`) and 37.3333px |
| Geist (`"Geist Variable"`) | paragraphs, long text (docs, whitepaper) and form values. Variable `wght` 100-900 |
| Geist Mono (`"Geist Mono Variable"`) | addresses, hashes and code on technical pages only. Variable `wght` 100-900 |

All four families are licensed under the SIL Open Font License 1.1 (the
`LICENSE` file next to each family is copied from the same tarball, and each
package's `package.json` declares `OFL-1.1`). None declares a Reserved Font
Name.

How the pixel faces were chosen (2026-10-09): Geist Pixel, Pixelify Sans,
Silkscreen, Jersey 10, Jersey 15, Tiny5 and Micro 5 were compared in
screenshots at 1440 and 390 px (Departure Mono has no npm package, so it could
not be fetched and verified the same way). Geist Pixel reads the most premium
at headline sizes; at 12-14px it renders like a plain sans (half a screen pixel
per font pixel), so the small UI text uses Jersey 10 at its native size, where
one font pixel is one screen pixel. The specimen screenshots are kept by the
maintainers.

Removed on 2026-10-09 (v6): Saira, Barlow, Barlow Semi Condensed and Chakra
Petch (v5.1). Removed earlier (v5.1): Manrope, Unbounded, Inter, Inter Tight,
Instrument Serif, Doto.

## Sources

| Folder | npm package | Tarball SHA-256 | Font copyright |
|---|---|---|---|
| `geist-pixel/` | `@fontsource/geist-pixel@5.3.0` | `6d57e913d3034a69323f86fc98051c8adc884986cd5ec6553b661b9550d2a29a` | Copyright 2026 The Geist Project Authors (https://github.com/vercel/geist-font) |
| `jersey-10/` | `@fontsource/jersey-10@5.3.0` | `c32f312efdc4741e0a48f9840c2420d86b65819c070b3beca692f677c1a80f90` | Copyright 2023 The Soft Type Project Authors (https://github.com/scfried/soft-type-jersey) |
| `geist/` | `@fontsource-variable/geist@5.3.0` | `533dd66117795ac12316fb05fce27736c4bc63c31613b302d0a5285ca3a291d7` | Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font) |
| `geist-mono/` | `@fontsource-variable/geist-mono@5.3.0` | `af7a9f156602b859efa95cd1acb824a5322c51a1eca53afb38ed033885736a70` | Copyright 2024 The Geist Project Authors |

Reproduce: in an empty folder run `npm pack <package>@<version> --ignore-scripts`,
check the tarball SHA-256 above, extract it, and compare `package/files/<file>`
and `package/LICENSE` with the hashes below. (The v6 families were fetched on
2026-10-09 into empty folders outside the repository.)

## Files (SHA-256)

```
91908116d010c831ee9c5b8a2c2d4a75960c3d1a7fae10cc2cda1ab2427758e1  geist-pixel/geist-pixel-latin-400-normal.woff2
1c39e955df2196b750d3d1b0b0524be4616937f326dc372a8f0fc9feab5a695f  geist-pixel/geist-pixel-latin-ext-400-normal.woff2
a34971681b85fa8d07ab3a336df38f8359297b6fd3cad6ebff5f4f47b61a35fc  geist-pixel/LICENSE
a606eb9b440abe7386c0e8aa2c081fb40d4a241758e2b0e49fdd963741ac4590  jersey-10/jersey-10-latin-400-normal.woff2
0c561e6128a15fceb1f9717fd76655c972d7b3cd52e590b3610b528545e5ef65  jersey-10/jersey-10-latin-ext-400-normal.woff2
73d891f0c6636c8251e35c38d7fd4412304dfc74efb0f3cc4bbefadff8dc0e8e  jersey-10/LICENSE
19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1  geist/geist-latin-wght-normal.woff2
824f485b5d26e2f2da3c2b236132ece1bc8e4e43373452950bb0e40548b4313f  geist/geist-latin-ext-wght-normal.woff2
71609cbb5c78b5870d712eab73a31d76622635c6ed034ab5cee3b9ecbda8685f  geist/LICENSE
684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc  geist-mono/geist-mono-latin-wght-normal.woff2
1a189eb997c3e2ece68373e387afaec9e8617424186c4b1ab3cff7c54ba6223b  geist-mono/geist-mono-latin-ext-wght-normal.woff2
5bb66d8319ba1602bb2eb67dce8d79c2b4687be8ce183a0574433e949b3c60ad  geist-mono/geist-mono-symbols2-wght-normal.woff2
cc815ed4fc045f0e991abb10395b7932bd028c6a067deb13316d6002105074e6  geist-mono/LICENSE
```
