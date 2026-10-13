/**
 * The Create wizard's editable draft (strings as typed) and its exact
 * conversion into `LaunchParamsInput` and the token's metadata record.
 * Amounts never pass through floating point; prices go through
 * `designCurve` (exact bigint).
 */
import { PublicKey } from "@solana/web3.js";

import { parsePercentToBps, parseUnits, SOL_DECIMALS } from "../../lib/amounts";
import {
  buildMetadataDoc,
  DBC,
  designCurve,
  dynamicFeeFor,
  encodeIndexedPng,
  METADATA,
  PRESETS,
  priceFromSqrtPrice,
  tokenMetaSpace,
  validateLaunchParams,
  validateMetadataDoc,
  validateTokenMeta,
  type DynamicFeeParams,
  type LaunchParamsInput,
  type MetadataDocInput,
  type PresetName,
  type TokenMetaInput,
} from "../../lib/noised";
import { iconByteBudget, type LogoFitter, type LogoIcon } from "./logoIcon";
import { generateIcon, ICON_MAX_COLORS, ICON_SIZE, iconRgba, isBlank, seedOf, type IconDraft } from "./pixelIcon";

export interface RecipientDraft {
  wallet: string;
  /** Percent of the creator share, up to 2 decimals. */
  pct: string;
}

/**
 * What Noised stores about the token itself, on Solana (PIXEL_V6 §4): no
 * metadata link, no IPFS. They go into the document of the token's on-chain
 * metadata record (`buildMetadataDoc`: the icon as a small PNG, the
 * description, the links), which the creator's quantum key signs by its hash
 * together with the name and symbol. The mint's link stays empty.
 */
export interface TokenMetaDraft {
  /** Pixel art (drawn or made for you): the icon when there is no uploaded logo. Blank: none. */
  icon: IconDraft;
  /**
   * An uploaded picture (./logoIcon.ts): when set, it is the token's icon, stored as the best smooth picture that fits
   * next to the description and links (up to 64 x 64; never pixel art). Kept in memory only.
   */
  logo: LogoFitter | null;
  /** At most DESCRIPTION_MAX bytes of UTF-8. */
  description: string;
  /** Optional https:// link. */
  website: string;
  /** Optional X handle, with or without "@". */
  x: string;
}

/** The longest description the record's document takes, in bytes of UTF-8 (the SDK's limit). */
export const DESCRIPTION_MAX = METADATA.MAX_DESCRIPTION_LEN;

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** The X handle as typed, without "@" and spaces. */
export const xHandle = (m: Pick<TokenMetaDraft, "x">): string => m.x.trim().replace(/^@/, "");

// icon seed kept from the original name: changing it changes the default generated token icon
export const defaultMeta = (): TokenMetaDraft => ({ icon: generateIcon(seedOf("phalanx#0")), logo: null, description: "", website: "", x: "" });

/** Whether the token has an icon: an uploaded logo, or pixel art that is not blank. */
export const hasIcon = (m: Pick<TokenMetaDraft, "icon" | "logo">): boolean => m.logo !== null || !isBlank(m.icon.pixels);

/**
 * Problems with the optional fields, in plain words (shown under them). They go into the record's document, so a
 * problem here blocks the launch until it is fixed or the field is emptied.
 */
export function metaProblems(m: TokenMetaDraft): { description: string | null; website: string | null; x: string | null } {
  const bytes = utf8Bytes(m.description);
  let website: string | null = null;
  const w = m.website.trim();
  if (w !== "") {
    try {
      const u = new URL(w);
      if (u.protocol !== "https:") website = "Use an https:// link.";
      else if (u.username !== "" || u.password !== "") website = "Leave out the user name and password.";
      else if (!/^[\x21-\x7e]+$/.test(w)) website = "A link cannot have spaces or special characters.";
      else if (w.length > METADATA.MAX_URI_LEN) website = `At most ${METADATA.MAX_URI_LEN} characters.`;
    } catch {
      website = "Enter a full link, like https://example.com.";
    }
  }
  const x = xHandle(m);
  return {
    description: bytes > DESCRIPTION_MAX ? `At most ${DESCRIPTION_MAX} bytes (now ${bytes}).` : null,
    website,
    x: x === "" || /^[A-Za-z0-9_]{1,15}$/.test(x) ? null : "An X handle has 1 to 15 letters, digits or underscores.",
  };
}

/**
 * The document's input for `buildMetadataDoc`: the record's name and symbol, and the optional parts that are filled
 * in (the icon as its PNG bytes, the X handle as an x.com link). `iconPng` null: no icon.
 */
export function docInput(d: Pick<Draft, "name" | "symbol" | "meta">, iconPng: Uint8Array | null): MetadataDocInput {
  const description = d.meta.description.trim();
  const website = d.meta.website.trim();
  const x = xHandle(d.meta);
  const links = { ...(website === "" ? {} : { website }), ...(x === "" ? {} : { x: `https://x.com/${x}` }) };
  return {
    name: d.name,
    symbol: d.symbol,
    ...(description === "" ? {} : { description }),
    ...(iconPng === null ? {} : { iconPng }),
    ...(Object.keys(links).length === 0 ? {} : { links }),
  };
}

/** Whether the draft has anything for the document (else the record holds the name and symbol only, no document). */
export function hasDocument(d: Pick<Draft, "meta">): boolean {
  return hasIcon(d.meta) || d.meta.description.trim() !== "" || d.meta.website.trim() !== "" || xHandle(d.meta) !== "";
}

/** The document's problems in the wizard's words, by the field that shows them ("description", "website", "x", "icon"). */
function documentErrors(input: MetadataDocInput, logo: boolean): string[] {
  const v = validateMetadataDoc(input);
  if (v.ok) return [];
  const out: string[] = [];
  for (const e of v.errors) {
    const i = e.indexOf(": ");
    const field = i < 0 ? "" : e.slice(0, i);
    const message = i < 0 ? e : e.slice(i + 2);
    // The name and symbol are the record's own: their problems are reported once, by `metadataErrors`.
    if (field === "name" || field === "symbol") continue;
    if (field === "description") out.push(`description: must be at most ${DESCRIPTION_MAX} bytes (is ${utf8Bytes(input.description ?? "")})`);
    else if (field === "links.website") out.push(`website: ${message}`);
    else if (field === "links.x") out.push(`x: ${message}`);
    else if (field === "iconPng") out.push(`icon: ${message}`);
    else if (field === "document") {
      const size = /is (\d+) bytes/.exec(message)?.[1] ?? "?";
      // An uploaded logo is already as small as it gets (48 x 48, 64 colours): only the words can make room.
      if (logo) out.push(input.description === undefined ? `icon: ${LOGO_TOO_DETAILED}` : `icon: ${LOGO_NO_ROOM}`);
      else out.push(`icon: your icon, description and links take ${size} bytes together; at most ${METADATA.MAX_DOC_LEN} fit on Solana. Shorten the description or use fewer colours in the icon`);
    } else out.push(e);
  }
  return out;
}

/** When an uploaded logo and the description do not fit on Solana together, even with the logo at its smallest. */
export const LOGO_NO_ROOM = "your logo and description are too big to keep on Solana together. Shorten the description to make room";
/** When an uploaded logo does not fit even without a description. */
export const LOGO_TOO_DETAILED = "this picture has too much fine detail to keep on Solana. Zoom in on it, or choose a simpler picture";

export interface Draft {
  preset: PresetName;
  name: string;
  symbol: string;
  /** Icon, description and links: kept with the draft, not sent at launch yet (see TokenMetaDraft). */
  meta: TokenMetaDraft;
  tokenDecimal: string;
  startPrice: string;
  graduationPrice: string;
  thresholdSol: string;
  migrationFeeOption: string;
  rawCurve: boolean;
  sqrtStartPrice: string;
  curve: { sqrtPrice: string; liquidity: string }[];
  cliffFeePct: string;
  feeMode: string;
  feePeriods: string;
  feePeriodSecs: string;
  feeReduction: string;
  dynamicFee: boolean;
  dynFilterPeriod: string;
  dynDecayPeriod: string;
  dynReductionFactor: string;
  dynMaxVolatilityAccumulator: string;
  dynVariableFeeControl: string;
  openDelaySecs: string;
  guardSecs: string;
  maxWalletPct: string;
  maxBuyPct: string;
  p2pLocked: boolean;
  batchWalletCapSol: string;
  batchTotalCapSol: string;
  recipients: RecipientDraft[];
}

/** Plain decimal string for a display price (no exponent). */
export function priceString(p: number): string {
  if (!(p > 0) || !Number.isFinite(p)) return "";
  const rounded = Number(p.toPrecision(6));
  const digits = Math.min(20, Math.max(0, 6 - Math.floor(Math.log10(rounded))));
  const s = rounded.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

const solString = (lamports: bigint): string => {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
};

const pctString = (bps: number): string => {
  const whole = Math.floor(bps / 100);
  const frac = (bps % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return frac === "" ? `${whole}` : `${whole}.${frac}`;
};

/** Fee numerator (over 1e9) as a percent string with up to 7 decimals. */
export const feePctString = (numerator: bigint): string => {
  const whole = numerator / 10_000_000n;
  const frac = (numerator % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
};

export function draftFromPreset(name: PresetName, keep?: Pick<Draft, "name" | "symbol" | "meta" | "recipients">): Draft {
  const p = PRESETS[name].params;
  const d = p.dynamicFee;
  const first = p.curve[0];
  return {
    preset: name,
    name: keep?.name ?? "",
    symbol: keep?.symbol ?? "",
    meta: keep?.meta ?? defaultMeta(),
    tokenDecimal: String(p.tokenDecimal),
    startPrice: priceString(priceFromSqrtPrice(p.sqrtStartPrice, p.tokenDecimal)),
    graduationPrice: first ? priceString(priceFromSqrtPrice(first.sqrtPrice, p.tokenDecimal)) : "",
    thresholdSol: solString(p.migrationQuoteThreshold),
    migrationFeeOption: String(p.migrationFeeOption),
    rawCurve: false,
    sqrtStartPrice: p.sqrtStartPrice.toString(),
    curve: p.curve.map((c) => ({ sqrtPrice: c.sqrtPrice.toString(), liquidity: c.liquidity.toString() })),
    cliffFeePct: feePctString(p.baseFee.cliffFeeNumerator),
    feeMode: String(p.baseFee.baseFeeMode),
    feePeriods: String(p.baseFee.firstFactor),
    feePeriodSecs: p.baseFee.secondFactor.toString(),
    feeReduction: p.baseFee.thirdFactor.toString(),
    dynamicFee: d !== null,
    dynFilterPeriod: String(d?.filterPeriod ?? 10),
    dynDecayPeriod: String(d?.decayPeriod ?? 120),
    dynReductionFactor: String(d?.reductionFactor ?? 5000),
    dynMaxVolatilityAccumulator: String(d?.maxVolatilityAccumulator ?? 14_460_000),
    dynVariableFeeControl: String(d?.variableFeeControl ?? 0),
    openDelaySecs: String(p.openDelaySecs),
    guardSecs: String(p.guardSecs),
    maxWalletPct: pctString(p.maxWalletBps),
    maxBuyPct: pctString(p.maxBuyBps),
    p2pLocked: p.p2pLocked,
    batchWalletCapSol: solString(p.batchWalletCap),
    batchTotalCapSol: solString(p.batchTotalCap),
    recipients: keep?.recipients ?? [{ wallet: "", pct: "100" }],
  };
}

/** Dynamic-fee fields recomputed so the maximum dynamic fee is 20% of the cliff fee. */
export function dynamicDraftFor(cliffFeePct: string): Partial<Draft> | null {
  try {
    const d: DynamicFeeParams = dynamicFeeFor(parseUnits(cliffFeePct, 7));
    return {
      dynFilterPeriod: String(d.filterPeriod),
      dynDecayPeriod: String(d.decayPeriod),
      dynReductionFactor: String(d.reductionFactor),
      dynMaxVolatilityAccumulator: String(d.maxVolatilityAccumulator),
      dynVariableFeeControl: String(d.variableFeeControl),
    };
  } catch {
    return null;
  }
}

export interface Conversion {
  /** Null only when a value could not be turned into a parameter at all. */
  params: LaunchParamsInput | null;
  /**
   * The token's metadata record as `planLaunch` takes it: the name and symbol and, when the draft has an icon, a
   * description or links, the document (`buildMetadataDoc`). Never a uri mode: the mint's link stays empty.
   */
  metadata: TokenMetaInput & { name: string; symbol: string };
  /** False while the icon's PNG is still being made (the record is not final yet). */
  metadataReady: boolean;
  /** Bytes the record takes on Solana (`tokenMetaSpace`), and of them the document's. */
  recordBytes: number;
  docBytes: number;
  /** Input errors keyed by the validator field they stand for. */
  inputErrors: Record<string, string>;
  /** `validateLaunchParams(params).errors` and the record's name and symbol problems ("fieldName: message"). */
  policyErrors: string[];
}

function uint(text: string, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return Number.isSafeInteger(n) && n <= max ? n : null;
}

function big(text: string): bigint | null {
  return /^\d+$/.test(text.trim()) ? BigInt(text.trim()) : null;
}

/**
 * The name and symbol problems of the metadata record (`validateTokenMeta`, which the program applies when the record
 * is published), in the wizard's words: "is required" for an empty field, the byte limit for a long one.
 */
function metadataErrors(metadata: { name: string; symbol: string }): string[] {
  const v = validateTokenMeta(metadata);
  if (v.ok) return [];
  const out: string[] = [];
  const fields = [
    ["name", metadata.name, METADATA.MAX_NAME_LEN],
    ["symbol", metadata.symbol, METADATA.MAX_SYMBOL_LEN],
  ] as const;
  for (const [field, text, max] of fields) {
    const own = v.errors.filter((e) => splitError(e).field === field);
    const first = own[0];
    if (first === undefined) continue;
    const len = new TextEncoder().encode(text).length;
    out.push(len === 0 ? `${field}: is required` : len > max ? `${field}: must be at most ${max} bytes of UTF-8 (is ${len})` : first);
  }
  return out;
}

/**
 * Convert the draft. Fields that do not parse are reported and replaced by a
 * value the policy also rejects. `pqIdentity` is the id of the creator's
 * quantum key identity (lib/pqKey.ts): only it can sign the launch so that
 * it can go live; without one, the launch cannot be created. `iconPng` is
 * the icon's PNG (`iconPng` in ./pixelIcon.ts): null for no icon, undefined
 * while it is being made (a blank icon needs none).
 */
export function convertDraft(d: Draft, pqIdentity: Uint8Array | null = null, iconPng?: Uint8Array | null): Conversion {
  const inputErrors: Record<string, string> = {};
  const fail = (field: string, message: string): void => {
    if (inputErrors[field] === undefined) inputErrors[field] = message;
  };
  if (pqIdentity === null) fail("pqIdentity", "Unlock your quantum key first: it signs the launch so that it can go live.");

  const tokenDecimal = uint(d.tokenDecimal, 255) ?? 0;

  let thresholdLamports = 0n;
  try {
    thresholdLamports = parseUnits(d.thresholdSol, SOL_DECIMALS);
  } catch (e) {
    fail("migrationQuoteThreshold", e instanceof Error ? e.message : "Enter an amount of SOL");
  }

  let sqrtStartPrice = 0n;
  let curve: { sqrtPrice: bigint; liquidity: bigint }[] = [];
  if (d.rawCurve) {
    const s = big(d.sqrtStartPrice);
    if (s === null) fail("sqrtStartPrice", "Enter an unsigned integer (Q64.64 sqrt price)");
    else sqrtStartPrice = s;
    curve = d.curve.map((c, i) => {
      const sp = big(c.sqrtPrice);
      const liq = big(c.liquidity);
      if (sp === null) fail(`curve[${i}].sqrtPrice`, "Enter an unsigned integer");
      if (liq === null) fail(`curve[${i}].liquidity`, "Enter an unsigned integer");
      return { sqrtPrice: sp ?? 0n, liquidity: liq ?? 0n };
    });
  } else {
    try {
      const design = designCurve(tokenDecimal >= 6 && tokenDecimal <= 9 ? tokenDecimal : 6, d.startPrice, d.graduationPrice, thresholdLamports > 0n ? thresholdLamports : 1n);
      sqrtStartPrice = design.sqrtStartPrice;
      curve = design.curve;
    } catch (e) {
      fail("curve", e instanceof Error ? e.message : "Check the prices");
    }
  }

  let cliff = 0n;
  try {
    cliff = parseUnits(d.cliffFeePct, 7);
  } catch {
    fail("baseFee.cliffFeeNumerator", "Enter a percentage like 1 or 0.25");
  }
  const mode = uint(d.feeMode, 255) ?? 255;
  const periods = uint(d.feePeriods, 0xffff);
  if (periods === null) fail("baseFee.firstFactor", "Enter a whole number of periods (0 to 65,535)");
  const periodSecs = big(d.feePeriodSecs);
  if (periodSecs === null) fail("baseFee.secondFactor", "Enter a whole number of seconds");
  const reduction = big(d.feeReduction);
  if (reduction === null) fail("baseFee.thirdFactor", "Enter a whole number");

  let dynamicFee: DynamicFeeParams | null = null;
  if (d.dynamicFee) {
    const num = (text: string, field: string, max: number): number => {
      const v = uint(text, max);
      if (v === null) fail(field, `Enter a whole number up to ${max.toLocaleString("en-US")}`);
      return v ?? max + 1;
    };
    dynamicFee = {
      binStep: DBC.DYNAMIC_BIN_STEP,
      binStepU128: DBC.DYNAMIC_BIN_STEP_U128,
      filterPeriod: num(d.dynFilterPeriod, "dynamicFee.filterPeriod", 0xffff),
      decayPeriod: num(d.dynDecayPeriod, "dynamicFee.decayPeriod", 0xffff),
      reductionFactor: num(d.dynReductionFactor, "dynamicFee.reductionFactor", 0xffff),
      maxVolatilityAccumulator: num(d.dynMaxVolatilityAccumulator, "dynamicFee.maxVolatilityAccumulator", 0xffff_ffff),
      variableFeeControl: num(d.dynVariableFeeControl, "dynamicFee.variableFeeControl", 0xffff_ffff),
    };
  }

  const openDelaySecs = uint(d.openDelaySecs, 0xffff_ffff);
  if (openDelaySecs === null) fail("openDelaySecs", "Enter a whole number of seconds");
  const guardSecs = uint(d.guardSecs, 0xffff_ffff);
  if (guardSecs === null) fail("guardSecs", "Enter a whole number of seconds");

  const pct = (text: string, field: string): number => {
    try {
      return parsePercentToBps(text);
    } catch (e) {
      fail(field, e instanceof Error ? e.message : "Enter a percentage");
      return 10_001;
    }
  };
  const maxWalletBps = pct(d.maxWalletPct, "maxWalletBps");
  const maxBuyBps = pct(d.maxBuyPct, "maxBuyBps");

  const sol = (text: string, field: string): bigint => {
    try {
      return parseUnits(text, SOL_DECIMALS);
    } catch (e) {
      fail(field, e instanceof Error ? e.message : "Enter an amount of SOL");
      return (1n << 64n) - 1n;
    }
  };
  const batchWalletCap = sol(d.batchWalletCapSol, "batchWalletCap");
  const batchTotalCap = sol(d.batchTotalCapSol, "batchTotalCap");

  const recipients = d.recipients.map((r, i) => {
    let wallet = PublicKey.default;
    try {
      wallet = new PublicKey(r.wallet.trim());
    } catch {
      fail(`recipients[${i}].wallet`, r.wallet.trim() === "" ? "Enter a wallet address" : "Not a valid Solana address");
    }
    let bps = 0;
    try {
      bps = parsePercentToBps(r.pct);
    } catch (e) {
      fail(`recipients[${i}].bps`, e instanceof Error ? e.message : "Enter a percentage");
    }
    return { wallet, bps };
  });

  const params: LaunchParamsInput = {
    tokenDecimal,
    sqrtStartPrice,
    curve,
    migrationQuoteThreshold: thresholdLamports,
    baseFee: { cliffFeeNumerator: cliff, firstFactor: periods ?? 0, secondFactor: periodSecs ?? 0n, thirdFactor: reduction ?? 0n, baseFeeMode: mode },
    dynamicFee,
    migrationFeeOption: uint(d.migrationFeeOption, 255) ?? 255,
    openDelaySecs: openDelaySecs ?? 0,
    guardSecs: guardSecs ?? 0,
    maxWalletBps,
    maxBuyBps,
    p2pLocked: d.p2pLocked,
    batchWalletCap,
    batchTotalCap,
    recipients,
    pqIdentity: pqIdentity ?? new Uint8Array(32),
  };
  // Noised keeps the token's metadata itself (TokenMetaDraft) in the record's document: no uri mode, no off-chain link.
  const png = hasIcon(d.meta) ? iconPng : null;
  const base = { name: d.name, symbol: d.symbol };
  const input = docInput(d, png ?? null);
  const docProblems = hasDocument(d) ? documentErrors(input, d.meta.logo !== null) : [];
  const nameProblems = metadataErrors(base);
  let metadata: TokenMetaInput & { name: string; symbol: string } = base;
  if (hasDocument(d) && png !== undefined && docProblems.length === 0 && nameProblems.length === 0) metadata = { ...base, doc: buildMetadataDoc(input) };
  const docBytes = metadata.doc instanceof Uint8Array ? metadata.doc.length : 0;
  const v = validateLaunchParams(params);
  return {
    params,
    metadata,
    metadataReady: png !== undefined,
    recordBytes: nameProblems.length === 0 ? tokenMetaSpace(metadata) : 0,
    docBytes,
    inputErrors,
    policyErrors: [...nameProblems, ...docProblems, ...v.errors],
  };
}

/** Split a policy error "fieldName: message" into its parts. */
export function splitError(e: string): { field: string; message: string } {
  const i = e.indexOf(": ");
  return i < 0 ? { field: "", message: e } : { field: e.slice(0, i), message: e.slice(i + 2) };
}

/**
 * Messages for the fields an input stands for: its own input error first,
 * otherwise the policy errors whose field matches exactly.
 */
export function messagesFor(conv: Conversion, fields: readonly string[]): string[] {
  for (const f of fields) {
    const own = conv.inputErrors[f];
    if (own !== undefined) return [own];
  }
  return conv.policyErrors.map(splitError).filter((e) => fields.includes(e.field)).map((e) => e.message);
}

/** Which wizard step owns a policy field. */
export function stepOfField(field: string): StepId {
  if (field === "name" || field === "symbol" || field === "uri" || field === "tokenDecimal") return "token";
  if (field === "description" || field === "website" || field === "x" || field === "icon") return "token";
  if (field === "sqrtStartPrice" || field.startsWith("curve") || field === "migrationQuoteThreshold" || field === "migrationFeeOption") return "curve";
  if (field.startsWith("baseFee") || field.startsWith("dynamicFee")) return "fees";
  if (field.startsWith("recipients")) return "recipients";
  if (field === "pqIdentity") return "key";
  return "guard";
}

export type StepId = "preset" | "token" | "curve" | "fees" | "guard" | "recipients" | "key" | "review";

/**
 * The icon's PNG for the record's document (null for a blank icon): an indexed PNG of its exact colours (up to 16 and
 * transparent), made by the SDK's deterministic encoder. Keep the bytes: the record's hash covers exactly them.
 */
export async function iconPng(icon: IconDraft): Promise<Uint8Array | null> {
  if (isBlank(icon.pixels)) return null;
  return encodeIndexedPng(iconRgba(icon), ICON_SIZE, ICON_SIZE, ICON_MAX_COLORS + 1);
}

/** The icon that goes into the document: none, the pixel art, or the uploaded logo's best fit. */
export type StoredIcon =
  | { kind: "none"; png: null }
  | { kind: "pixel"; png: Uint8Array }
  /** `fits` false: even the smallest variant leaves no room (`png` is that variant, and `convertDraft` says why). */
  | { kind: "logo"; png: Uint8Array; logo: LogoIcon; fits: boolean };

/** The bytes the icon's PNG may take next to the draft's name, symbol, description and links. */
export const iconBudgetOf = (d: Pick<Draft, "name" | "symbol" | "meta">): number => iconByteBudget(docInput(d, null));

/** Changes exactly when `storedIcon` would give another result (the logo and its budget, or the drawing). */
export function storedIconKey(d: Pick<Draft, "name" | "symbol" | "meta">): string {
  const m = d.meta;
  if (m.logo !== null) return `logo:${m.logo.id}:${iconBudgetOf(d)}`;
  return isBlank(m.icon.pixels) ? "none" : `pixel:${m.icon.palette.join(",")}|${m.icon.pixels}`;
}

/**
 * The icon the record will store for this draft: an uploaded logo as the best smooth picture that fits next to the
 * name, symbol, description and links (re-fitted when they change; ./logoIcon.ts), else the pixel art, else none.
 */
export async function storedIcon(d: Pick<Draft, "name" | "symbol" | "meta">): Promise<StoredIcon> {
  const m = d.meta;
  if (m.logo !== null) {
    const fit = await m.logo.fit(iconBudgetOf(d));
    const logo = fit ?? (await m.logo.smallest());
    return { kind: "logo", png: logo.png, logo, fits: fit !== null };
  }
  const png = await iconPng(m.icon);
  return png === null ? { kind: "none", png: null } : { kind: "pixel", png };
}
