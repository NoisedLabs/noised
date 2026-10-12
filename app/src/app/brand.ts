/**
 * Positioning (LAYER_V1 §B.1): Noised is the quantum security layer for Solana, with four products on it: Launch,
 * Vault, Shield (private balances) and Verify. The words the shell and the home page use, in one place.
 */
export const SITE_TITLE = "Noised: the quantum security layer for Solana";

/** The layer's products, then how it is checked. The brand goes home, where the live launches are. */
export const NAV = [
  { to: "/create", label: "Launch", hint: "Launch a token nobody can rug" },
  { to: "/vault", label: "Vault", hint: "A vault only your quantum key opens" },
  { to: "/shield", label: "Shield", hint: "Private balances" },
  { to: "/verify", label: "Verify", hint: "Check any token against QSL-1" },
  { to: "/security", label: "Security", hint: "What is protected, and who you still trust" },
  { to: "/docs", label: "Docs", hint: "For developers" },
] as const;

/** The footer's one line about Noised. */
export const TAGLINE = "The quantum security layer for Solana. Launch, store, shield and verify tokens, with every rule checked on-chain.";

/** The home hero's headline (two lines) and the sentence under it: what the layer is, then its products in plain words. */
export const HERO_TITLE = ["Quantum security ", "for Solana."] as const;
export const HERO_SUB =
  "Noised is the quantum security layer for Solana. Launch tokens nobody can rug, keep coins in a vault only your quantum key opens, hold balances privately and check any token in one click.";
