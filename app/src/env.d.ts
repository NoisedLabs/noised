/// <reference types="vite/client" />

/** Build-time configuration injected by vite.config.ts (see build/csp.ts). */
declare const __NOISED_CLUSTER__: "mainnet" | "devnet" | "localnet";
declare const __NOISED_RPC_ENDPOINTS__: readonly { readonly label: string; readonly url: string }[];
declare const __NOISED_CSP__: string;
declare const __NOISED_VERSION__: string;
