/**
 * Positioning (LAYER_V1 §B.1): Noised is the quantum security layer for Solana, with four products on it: Launch,
 * Vault, Shield (private balances) and Verify. The words the shell and the home page use, in one place.
 */
export const SITE_TITLE = "Noised: the quantum security layer for Solana";

/** The layer's products, then how it is checked. The brand goes home, where the live launches are. */
export const NAV = [
  { to: "/create", label: "Launch", hint: "Launch a token signed with your quantum key" },
  { to: "/vault", label: "Vault", hint: "A vault only your quantum key opens" },
  { to: "/shield", label: "Shield", hint: "Private balances" },
  { to: "/verify", label: "Verify", hint: "Check any token against QSL-1" },
  { to: "/security", label: "Security", hint: "What is protected, and who you still trust" },
  { to: "/docs", label: "Docs", hint: "For developers" },
] as const;

/**
 * The official Noised mark, a hexagon of dots, next to the NOISED wordmark in the navbar, the mobile menu and the
 * footer: black dots on the light theme (Paper), white dots on the dark one (Graphite). Each file is pre-scaled for one
 * screen density (1x, 2x, 3x of `size` CSS pixels) from the 512 px originals in public/brand, so the browser never
 * resamples the fine dots. The paths are relative: the site works from any path (IPFS gateways).
 */
export const BRAND_MARK = {
  size: 26,
  light: ["brand/noised-mark-nav-26.png", "brand/noised-mark-nav-52.png", "brand/noised-mark-nav-78.png"],
  dark: ["brand/noised-mark-white-nav-26.png", "brand/noised-mark-white-nav-52.png", "brand/noised-mark-white-nav-78.png"],
} as const;

/** The footer's one line about Noised. */
export const TAGLINE = "The quantum security layer for Solana. Launch, store, shield and verify tokens, with every rule checked on-chain.";

/**
 * What the app says while no launch can be created on its network yet (the launchpad's one-time setup has not run):
 * plain words, no protocol or account names. The Launch page shows it instead of the forms, and the launch buttons read
 * `title`.
 */
export const LAUNCHES_SOON = {
  title: "Launches open soon",
  text: "Noised is live on Solana, and token launches are almost ready. Come back soon to launch yours.",
  meanwhile: "Your vault, the Shield and Verify already work.",
} as const;

/** The home hero's headline (two lines) and the sentence under it: what the layer is, then its products in plain words. */
export const HERO_TITLE = ["Quantum security ", "for Solana."] as const;
export const HERO_SUB =
  "Noised is the quantum security layer for Solana. Launch tokens signed with a quantum key, keep coins in a vault only that key opens, hold balances privately, automate your token and check any token in one click.";
