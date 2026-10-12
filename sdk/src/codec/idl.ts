/**
 * Minimal, strict codec driven by Anchor IDLs (spec 0.1.0, as written by
 * `anchor idl build` 1.x and by Meteora's SDK repos).
 *
 * The same IDL files the programs are built from (ours) or declared against
 * (Meteora's, through `declare_program!`) drive every account decode and
 * instruction encode here, so field order and widths cannot drift from the
 * Rust structs. Values: u8..u32/i8..i32 -> number, 64/128-bit -> bigint,
 * pubkey -> PublicKey, [u8; N] / bytes -> Uint8Array, option -> value | null,
 * structs -> objects with camelCase keys, enums -> { kind, fields? }.
 *
 * Zero-copy (bytemuck, repr(C)) types are decoded sequentially, exactly like
 * Anchor's TypeScript coder. That is only correct for types without implicit
 * padding; `bytemuckLayoutProblems` reports any type where C layout would
 * insert padding (the test suite requires it to report none).
 */
import { BorshError, BorshReader, BorshWriter } from "./borsh.js";
import { bytesEqual } from "./bytes.js";

export type IdlType =
  | "bool"
  | "u8"
  | "i8"
  | "u16"
  | "i16"
  | "u32"
  | "i32"
  | "u64"
  | "i64"
  | "u128"
  | "i128"
  | "f32"
  | "f64"
  | "u256"
  | "i256"
  | "bytes"
  | "string"
  | "pubkey"
  | { option: IdlType }
  | { coption: IdlType }
  | { vec: IdlType }
  | { array: [IdlType, number | { generic: string }] }
  | { defined: { name: string; generics?: unknown[] } }
  | { generic: string };

export interface IdlField {
  name: string;
  docs?: string[];
  type: IdlType;
}

export type IdlDefinedFields = IdlField[] | IdlType[];

export interface IdlTypeDef {
  name: string;
  docs?: string[];
  serialization?: string | { custom: unknown };
  repr?: { kind: string; packed?: boolean; align?: number };
  generics?: unknown[];
  type:
    | { kind: "struct"; fields?: IdlDefinedFields }
    | { kind: "enum"; variants: { name: string; fields?: IdlDefinedFields }[] }
    | { kind: "type"; alias: IdlType };
}

export interface IdlInstructionAccount {
  name: string;
  docs?: string[];
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
  pda?: { seeds: unknown[]; program?: unknown };
  relations?: string[];
  accounts?: IdlInstructionAccount[];
}

export interface IdlInstruction {
  name: string;
  docs?: string[];
  discriminator: number[];
  accounts: IdlInstructionAccount[];
  args: IdlField[];
}

export interface Idl {
  address: string;
  metadata: { name: string; version: string; spec: string; description?: string };
  instructions: IdlInstruction[];
  accounts?: { name: string; discriminator: number[] }[];
  events?: { name: string; discriminator: number[] }[];
  errors?: { code: number; name: string; msg?: string }[];
  types?: IdlTypeDef[];
}

export interface EnumValue {
  kind: string;
  fields?: Record<string, unknown> | unknown[];
}

export class IdlCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdlCodecError";
  }
}

/**
 * `snake_case` to `camelCase`; leading underscores are kept (`_padding_0` ->
 * `_padding0`) so they never collide with an unprefixed field.
 */
export function camelCase(name: string): string {
  const prefix = /^_*/.exec(name)![0];
  const parts = name.slice(prefix.length).split("_").filter((p) => p !== "");
  return prefix + parts.map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1))).join("");
}

function isNamedFields(fields: IdlDefinedFields): fields is IdlField[] {
  return fields.length > 0 && typeof fields[0] === "object" && fields[0] !== null && "name" in fields[0] && "type" in fields[0];
}

function primitiveSize(t: string): number | null {
  switch (t) {
    case "bool":
    case "u8":
    case "i8":
      return 1;
    case "u16":
    case "i16":
      return 2;
    case "u32":
    case "i32":
      return 4;
    case "u64":
    case "i64":
      return 8;
    case "u128":
    case "i128":
      return 16;
    case "pubkey":
      return 32;
    default:
      return null;
  }
}

/** Natural alignment of a primitive under C layout (u128 aligned to 16, as on x86_64). */
function primitiveAlign(t: string): number {
  return t === "pubkey" ? 1 : Math.min(primitiveSize(t) ?? 1, 16);
}

export class IdlCodec {
  readonly idl: Idl;
  private readonly types = new Map<string, IdlTypeDef>();

  constructor(idl: Idl) {
    this.idl = idl;
    for (const t of idl.types ?? []) {
      if (this.types.has(t.name)) throw new IdlCodecError(`${idl.metadata.name}: duplicate type ${t.name}`);
      if (t.generics !== undefined && t.generics.length > 0) continue; // never used by our decoders
      this.types.set(t.name, t);
      this.checkFieldNames(t);
    }
  }

  get name(): string {
    return this.idl.metadata.name;
  }

  private checkFieldNames(t: IdlTypeDef): void {
    const check = (fields: IdlDefinedFields | undefined, where: string): void => {
      if (fields === undefined || !isNamedFields(fields)) return;
      const seen = new Set<string>();
      for (const f of fields) {
        const c = camelCase(f.name);
        if (seen.has(c)) throw new IdlCodecError(`${this.name}: field name collision after camelCase in ${where}: ${f.name}`);
        seen.add(c);
      }
    };
    if (t.type.kind === "struct") check(t.type.fields, t.name);
    if (t.type.kind === "enum") for (const v of t.type.variants) check(v.fields, `${t.name}::${v.name}`);
  }

  typeDef(name: string): IdlTypeDef {
    const t = this.types.get(name);
    if (t === undefined) throw new IdlCodecError(`${this.name}: unknown type ${name}`);
    return t;
  }

  // ------------------------------------------------------------ decode ---

  decode(type: IdlType, r: BorshReader): unknown {
    if (typeof type === "string") {
      switch (type) {
        case "bool":
          return r.bool();
        case "u8":
          return r.u8();
        case "i8":
          return r.i8();
        case "u16":
          return r.u16();
        case "i16":
          return r.i16();
        case "u32":
          return r.u32();
        case "i32":
          return r.i32();
        case "u64":
          return r.u64();
        case "i64":
          return r.i64();
        case "u128":
          return r.u128();
        case "i128":
          return r.i128();
        case "pubkey":
          return r.pubkey();
        case "bytes":
          return r.bytes();
        case "string":
          return r.string();
        default:
          throw new IdlCodecError(`${this.name}: unsupported type ${type}`);
      }
    }
    if ("option" in type) return r.optionTag() ? this.decode(type.option, r) : null;
    if ("coption" in type) {
      const tag = r.u32();
      if (tag > 1) throw new BorshError(`invalid COption tag ${tag}`);
      const value = this.decode(type.coption, r);
      return tag === 1 ? value : null;
    }
    if ("vec" in type) {
      const n = r.u32();
      if (type.vec === "u8") return r.fixed(n);
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push(this.decode(type.vec, r));
      return out;
    }
    if ("array" in type) {
      const [inner, len] = type.array;
      if (typeof len !== "number") throw new IdlCodecError(`${this.name}: generic array length`);
      if (inner === "u8") return r.fixed(len);
      const out: unknown[] = [];
      for (let i = 0; i < len; i++) out.push(this.decode(inner, r));
      return out;
    }
    if ("defined" in type) return this.decodeDefined(this.typeDef(type.defined.name), r);
    throw new IdlCodecError(`${this.name}: unsupported generic type`);
  }

  private decodeFields(fields: IdlDefinedFields | undefined, r: BorshReader): Record<string, unknown> | unknown[] {
    if (fields === undefined || fields.length === 0) return {};
    if (isNamedFields(fields)) {
      const out: Record<string, unknown> = {};
      for (const f of fields) out[camelCase(f.name)] = this.decode(f.type, r);
      return out;
    }
    return (fields as IdlType[]).map((t) => this.decode(t, r));
  }

  private decodeDefined(def: IdlTypeDef, r: BorshReader): unknown {
    switch (def.type.kind) {
      case "struct":
        return this.decodeFields(def.type.fields, r);
      case "enum": {
        const index = r.u8();
        const variant = def.type.variants[index];
        if (variant === undefined) throw new BorshError(`${def.name}: invalid enum variant ${index}`);
        const value: EnumValue = { kind: variant.name };
        if (variant.fields !== undefined && variant.fields.length > 0) value.fields = this.decodeFields(variant.fields, r);
        return value;
      }
      case "type":
        return this.decode(def.type.alias, r);
    }
  }

  // ------------------------------------------------------------ encode ---

  encode(type: IdlType, value: unknown, w: BorshWriter, path = "value"): void {
    const fail = (expected: string): never => {
      throw new TypeError(`${path}: expected ${expected}`);
    };
    if (typeof type === "string") {
      switch (type) {
        case "bool":
          if (typeof value !== "boolean") fail("boolean");
          w.bool(value as boolean);
          return;
        case "u8":
          w.u8(value as number);
          return;
        case "i8":
          w.i8(value as number);
          return;
        case "u16":
          w.u16(value as number);
          return;
        case "i16":
          w.i16(value as number);
          return;
        case "u32":
          w.u32(value as number);
          return;
        case "i32":
          w.i32(value as number);
          return;
        case "u64":
          w.u64(value as bigint);
          return;
        case "i64":
          w.i64(value as bigint);
          return;
        case "u128":
          w.u128(value as bigint);
          return;
        case "i128":
          w.i128(value as bigint);
          return;
        case "pubkey": {
          const k = value as { toBytes?: () => Uint8Array };
          if (typeof k !== "object" || k === null || typeof k.toBytes !== "function") fail("PublicKey");
          const bytes = (k as { toBytes: () => Uint8Array }).toBytes();
          w.fixed(bytes, 32);
          return;
        }
        case "bytes":
          if (!(value instanceof Uint8Array)) fail("Uint8Array");
          w.bytes(value as Uint8Array);
          return;
        case "string":
          if (typeof value !== "string") fail("string");
          w.string(value as string);
          return;
        default:
          throw new IdlCodecError(`${this.name}: unsupported type ${type}`);
      }
    }
    if ("option" in type) {
      if (value === null || value === undefined) {
        w.u8(0);
      } else {
        w.u8(1);
        this.encode(type.option, value, w, path);
      }
      return;
    }
    if ("coption" in type) throw new IdlCodecError(`${this.name}: COption encoding is not supported`);
    if ("vec" in type) {
      if (type.vec === "u8") {
        if (!(value instanceof Uint8Array)) fail("Uint8Array");
        w.bytes(value as Uint8Array);
        return;
      }
      if (!Array.isArray(value)) fail("array");
      const arr = value as unknown[];
      w.u32(arr.length);
      arr.forEach((v, i) => this.encode(type.vec, v, w, `${path}[${i}]`));
      return;
    }
    if ("array" in type) {
      const [inner, len] = type.array;
      if (typeof len !== "number") throw new IdlCodecError(`${this.name}: generic array length`);
      if (inner === "u8") {
        if (!(value instanceof Uint8Array)) fail(`Uint8Array(${len})`);
        w.fixed(value as Uint8Array, len);
        return;
      }
      if (!Array.isArray(value) || value.length !== len) fail(`array of ${len}`);
      (value as unknown[]).forEach((v, i) => this.encode(inner, v, w, `${path}[${i}]`));
      return;
    }
    if ("defined" in type) {
      this.encodeDefined(this.typeDef(type.defined.name), value, w, path);
      return;
    }
    throw new IdlCodecError(`${this.name}: unsupported generic type`);
  }

  private encodeFields(fields: IdlDefinedFields | undefined, value: unknown, w: BorshWriter, path: string): void {
    if (fields === undefined || fields.length === 0) return;
    if (isNamedFields(fields)) {
      if (typeof value !== "object" || value === null) throw new TypeError(`${path}: expected an object`);
      const obj = value as Record<string, unknown>;
      for (const f of fields) {
        const key = camelCase(f.name);
        if (!(key in obj)) throw new TypeError(`${path}.${key}: missing`);
        this.encode(f.type, obj[key], w, `${path}.${key}`);
      }
      return;
    }
    if (!Array.isArray(value) || value.length !== fields.length) throw new TypeError(`${path}: expected a tuple`);
    (fields as IdlType[]).forEach((t, i) => this.encode(t, (value as unknown[])[i], w, `${path}[${i}]`));
  }

  private encodeDefined(def: IdlTypeDef, value: unknown, w: BorshWriter, path: string): void {
    switch (def.type.kind) {
      case "struct":
        this.encodeFields(def.type.fields, value, w, path);
        return;
      case "enum": {
        const v = value as EnumValue;
        if (typeof v !== "object" || v === null || typeof v.kind !== "string") throw new TypeError(`${path}: expected { kind }`);
        const index = def.type.variants.findIndex((x) => x.name === v.kind);
        if (index < 0) throw new TypeError(`${path}: unknown variant ${v.kind}`);
        w.u8(index);
        this.encodeFields(def.type.variants[index]!.fields, v.fields ?? {}, w, `${path}.${v.kind}`);
        return;
      }
      case "type":
        this.encode(def.type.alias, value, w, path);
        return;
    }
  }

  // -------------------------------------------------------------- sizes ---

  /** Serialized size of a fixed-size type, or null if it has variable length. */
  fixedSize(type: IdlType): number | null {
    if (typeof type === "string") return primitiveSize(type);
    if ("option" in type || "coption" in type || "vec" in type) return null;
    if ("array" in type) {
      const [inner, len] = type.array;
      const s = this.fixedSize(inner);
      return s === null || typeof len !== "number" ? null : s * len;
    }
    if ("defined" in type) {
      const def = this.typeDef(type.defined.name);
      switch (def.type.kind) {
        case "struct": {
          const fields = def.type.fields ?? [];
          let total = 0;
          for (const f of fields) {
            const s = this.fixedSize(isNamedFields([f as IdlField]) ? (f as IdlField).type : (f as IdlType));
            if (s === null) return null;
            total += s;
          }
          return total;
        }
        case "enum": {
          const unit = def.type.variants.every((v) => v.fields === undefined || v.fields.length === 0);
          return unit ? 1 : null;
        }
        case "type":
          return this.fixedSize(def.type.alias);
      }
    }
    return null;
  }

  /**
   * Fields of bytemuck/repr(C) types whose offset is not a multiple of the
   * field's natural alignment (u128 at 16): C layout would insert padding there
   * and the sequential decode would be wrong. Empty for a padding-free IDL.
   */
  bytemuckLayoutProblems(): string[] {
    const problems: string[] = [];
    const alignOf = (t: IdlType): number => {
      if (typeof t === "string") return primitiveAlign(t);
      if ("array" in t) return alignOf(t.array[0]);
      if ("defined" in t) {
        const d = this.typeDef(t.defined.name);
        if (d.type.kind !== "struct") return 1;
        let a = 1;
        for (const f of (d.type.fields ?? []) as IdlField[]) a = Math.max(a, alignOf(f.type));
        return a;
      }
      return 1;
    };
    for (const def of this.types.values()) {
      const ser = typeof def.serialization === "string" ? def.serialization : "";
      if (!ser.startsWith("bytemuck") || def.type.kind !== "struct") continue;
      let offset = 0;
      for (const f of (def.type.fields ?? []) as IdlField[]) {
        const a = alignOf(f.type);
        if (offset % a !== 0) problems.push(`${def.name}.${f.name} at offset ${offset} (align ${a})`);
        const s = this.fixedSize(f.type);
        if (s === null) {
          problems.push(`${def.name}.${f.name} has variable size`);
          break;
        }
        offset += s;
      }
      const structAlign = alignOf({ defined: { name: def.name } });
      if (offset % structAlign !== 0) problems.push(`${def.name} size ${offset} not a multiple of align ${structAlign}`);
    }
    return problems;
  }

  // ----------------------------------------------------------- accounts ---

  accountDiscriminator(name: string): Uint8Array {
    const a = (this.idl.accounts ?? []).find((x) => x.name === name);
    if (a === undefined) throw new IdlCodecError(`${this.name}: unknown account ${name}`);
    return Uint8Array.from(a.discriminator);
  }

  /** Total account size (discriminator + data) of a fixed-size account type. */
  accountSize(name: string): number {
    const s = this.fixedSize({ defined: { name } });
    if (s === null) throw new IdlCodecError(`${this.name}: account ${name} has variable size`);
    return this.accountDiscriminator(name).length + s;
  }

  hasDiscriminator(name: string, data: Uint8Array): boolean {
    const d = this.accountDiscriminator(name);
    return data.length >= d.length && bytesEqual(data.subarray(0, d.length), d);
  }

  /**
   * Decode an account: discriminator must match, data must be long enough.
   * Trailing bytes are allowed (Anchor allocates `8 + space`; zero-copy
   * readers check `len >= 8 + size_of`).
   */
  decodeAccount<T>(name: string, data: Uint8Array): T {
    const d = this.accountDiscriminator(name);
    if (!this.hasDiscriminator(name, data)) throw new IdlCodecError(`${this.name}: not a ${name} account (discriminator mismatch)`);
    const r = new BorshReader(data.subarray(d.length));
    return this.decode({ defined: { name } }, r) as T;
  }

  // ------------------------------------------------------- instructions ---

  instruction(name: string): IdlInstruction {
    const ix = this.idl.instructions.find((x) => x.name === name);
    if (ix === undefined) throw new IdlCodecError(`${this.name}: unknown instruction ${name}`);
    return ix;
  }

  /** `discriminator || borsh(args...)`; `args` keys are the camelCase argument names. */
  encodeInstruction(name: string, args: Record<string, unknown> = {}): Uint8Array {
    const ix = this.instruction(name);
    const w = new BorshWriter();
    w.raw(Uint8Array.from(ix.discriminator));
    for (const a of ix.args) {
      const key = camelCase(a.name);
      if (!(key in args)) throw new TypeError(`${name}: missing argument ${key}`);
      this.encode(a.type, args[key], w, `${name}.${key}`);
    }
    const extra = Object.keys(args).filter((k) => !ix.args.some((a) => camelCase(a.name) === k));
    if (extra.length > 0) throw new TypeError(`${name}: unexpected argument(s) ${extra.join(", ")}`);
    return w.toBytes();
  }

  /** Encode a defined type alone (e.g. `LaunchParams` for the params hash). */
  encodeType(name: string, value: unknown): Uint8Array {
    const w = new BorshWriter();
    this.encode({ defined: { name } }, value, w, name);
    return w.toBytes();
  }

  decodeType<T>(name: string, data: Uint8Array): T {
    return this.decode({ defined: { name } }, new BorshReader(data)) as T;
  }

  errorByCode(code: number): { name: string; msg: string | null } | null {
    const e = (this.idl.errors ?? []).find((x) => x.code === code);
    return e === undefined ? null : { name: e.name, msg: e.msg ?? null };
  }
}
