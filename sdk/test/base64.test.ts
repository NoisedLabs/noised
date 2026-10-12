/**
 * Standard base64 (src/codec/base64.ts): RFC 4648 §10's test vectors, the
 * alphabet and padding of the launchpad's `base64.rs` (an inline uri) and a
 * strict decoder that accepts exactly one text per byte string.
 */
import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";

import { base64Length, decodeBase64, encodeBase64 } from "../src/codec/base64.js";
import { toHex, utf8 } from "../src/codec/bytes.js";

describe("base64", () => {
  it("RFC 4648 §10 test vectors, both ways", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "Zg=="],
      ["fo", "Zm8="],
      ["foo", "Zm9v"],
      ["foob", "Zm9vYg=="],
      ["fooba", "Zm9vYmE="],
      ["foobar", "Zm9vYmFy"],
    ];
    for (const [raw, b64] of vectors) {
      expect(encodeBase64(utf8(raw)), raw).toBe(b64);
      expect(toHex(decodeBase64(b64)!), raw).toBe(toHex(utf8(raw)));
      expect(base64Length(raw.length)).toBe(b64.length);
    }
  });

  it("every byte value and length agrees with Node's encoder (the standard alphabet with + and /, padded)", () => {
    for (let n = 0; n < 70; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n * 31 + 255) & 0xff);
      const text = encodeBase64(b);
      expect(text, String(n)).toBe(Buffer.from(b).toString("base64"));
      expect(toHex(decodeBase64(text)!), String(n)).toBe(toHex(b));
    }
    expect(encodeBase64(Uint8Array.of(0xfb, 0xff))).toBe("+/8=");
    expect(() => encodeBase64("abc" as never)).toThrow(TypeError);
  });

  it("decodes only canonical text: padding, the alphabet, zero pad bits, a multiple of four", () => {
    for (const bad of ["Zg", "Zg=", "Zg===", "Zh==", "Zm9=", "Zm8", "Z===", "====", "Zm 9v", "Zm9v\n", "Zm-_", "Zm=v", "=Zm9", 5 as never]) {
      expect(decodeBase64(bad), String(bad)).toBeNull();
    }
    expect(toHex(decodeBase64("Zm8=")!)).toBe(toHex(utf8("fo")));
    expect(decodeBase64("")!.length).toBe(0);
  });
});
