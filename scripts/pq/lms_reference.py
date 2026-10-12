"""Independent RFC 8554 reference for crates/noised-lmots (LMS and LM-OTS).

Written from the RFC text, not from the Rust crate, to cross-check it:

  python -I scripts/pq/lms_reference.py appendix-f crates/noised-lmots/tests/rfc8554_appendix_f.json
      verifies all four LMS levels of RFC 8554 Appendix F (W4 and W8, H10 and
      H5) and rebuilds Test Case 2's two trees and signatures from SEED and I;

  python -I scripts/pq/lms_reference.py vectors crates/noised-lmots/tests/rfc8554_appendix_f.json
      prints the known answers pinned in crates/noised-lmots/tests/lms.rs:
      identity ids, the creator-identity derivation (PQ_V2 amendment A12) and
      deterministic signatures of one derived identity.

  python -I scripts/pq/lms_reference.py extract <rfc8554.txt> <out.json>
      regenerates rfc8554_appendix_f.json from the RFC text ("the
      concatenation of all of the values within a public key or signature
      produces that public key or signature").

  python -I scripts/pq/lms_reference.py attest-vectors tests/integration/vectors/lms.json
      recomputes the SDK's launch-attestation vectors (PQ_V2 amendments A4,
      A5, A12, A13, A14, A16, with the adversarial review's fixes, and the
      on-chain metadata record of METADATA_PROGRAM.md) from their
      definitions: the identity derivations, the localnet identity's tree,
      public key, identity id and tree digest, the metadata record's hash
      (metadata_hash_v2) and address, the 221-byte attestation message v3
      (with the launch window and the creator rules hash, zero there), the
      leaf probe start (from the identity and
      the message), the deterministic signatures at every listed leaf (byte
      for byte), the attest_launch instruction data and accounts and the
      layout of its v1 transaction (SPEC section 3; not the Ed25519
      signature), the Launch, TokenMeta, Identity and Attestation account
      bytes and offsets from the Rust structs' field lists, every program
      address and bump (create_program_address, with the Ed25519 curve
      equation), the event payloads, the leaf selection cases, every
      rejection case (the strict verifier refuses it), every burn-only case
      (a valid signature, by the right or another identity, that the program
      lands without attesting: a record that cannot exist or was never
      published, creator rules never published, the window bounds, the
      identity), the metadata examples,
      the bitmap positions and the passkey HKDF (with RFC 5869 test case 1).

  python -I scripts/pq/lms_reference.py metadata-vectors tests/integration/vectors/metadata.json
      recomputes the on-chain metadata vectors: the icon PNG from its rules
      (zlib inflates it), every record's borsh encoding, metadata_hash_v2,
      TokenMeta address, bump and account bytes, the uri launch derives
      (base64 from the standard library), publish_metadata's data and the
      MetadataPublished event; the error of every invalid record (the
      validation rules written out again); the record addresses of other
      launches; the typical record's attestation message v3, signature (the
      vector identity's tree rebuilt) and attest_launch data and accounts;
      and launch's data and accounts.

  python -I scripts/pq/lms_reference.py programmable-vectors tests/integration/vectors/programmable.json
      recomputes the programmable-launch vectors (PROGRAMMABLE_V1 sections
      1.2 and 2, amendments A1 and A2): every PXR1 rule set verified by a
      verifier written from section 1.2 (layout, limits, windows inside the
      launch's guard, effects and caps, contiguous conditions, known leaves
      and their operands, the stack), its rules hash, record address, bump,
      account bytes, publish_rules data and accounts and RulesPublished
      payload; the attestation message v3 binding the rules, its leaf and
      signature (the vector identity's tree rebuilt), attest_launch data and
      accounts (the rules record last), the Attestation bytes and
      LaunchAttested payload; the autopilot's three payload hashes, the
      140-byte authorization messages, their leaves and signatures,
      pq_authorize data and accounts, the Authorization bytes (the layout the
      autopilot reads) and Authorized payloads; the identity's bitmap; and
      the documented offsets, lengths, check bits and error numbers.

Standard library only.
"""
import base64
import hashlib
import hmac
import json
import math
import re
import struct
import sys
import zlib

H = lambda *p: hashlib.sha256(b"".join(p)).digest()
u32 = lambda x: struct.pack(">I", x)
u16 = lambda x: struct.pack(">H", x)
D_PBLC, D_MESG, D_LEAF, D_INTR = b"\x80\x80", b"\x81\x81", b"\x82\x82", b"\x83\x83"
OTS = {3: (32, 4, 67, 4), 4: (32, 8, 34, 0)}  # typecode: (n, w, p, ls)
LMS = {5: 5, 6: 10}  # typecode: h


def coef(s, i, w):
    return (s[(i * w) // 8] >> (8 - (w * (i % (8 // w)) + w))) & ((1 << w) - 1)


def cksm(s, w, n, ls):
    return u16((sum((1 << w) - 1 - coef(s, i, w) for i in range(n * 8 // w)) << ls) & 0xFFFF)


def ots_candidate(ots, I, q, msg, c, ys):
    """RFC 8554 Algorithm 4b."""
    n, w, p, ls = OTS[ots]
    Q = H(I, u32(q), D_MESG, c, msg)
    v = Q + cksm(Q, w, n, ls)
    z = []
    for i in range(p):
        t = ys[i]
        for j in range(coef(v, i, w), (1 << w) - 1):
            t = H(I, u32(q), u16(i), bytes([j]), t)
        z.append(t)
    return H(I, u32(q), D_PBLC, *z)


def ots_secret(I, q, i, seed):
    """RFC 8554 Appendix A."""
    return H(I, u32(q), u16(i), b"\xff", seed)


def ots_public(ots, I, q, seed):
    """RFC 8554 Algorithm 1."""
    n, w, p, ls = OTS[ots]
    z = []
    for i in range(p):
        t = ots_secret(I, q, i, seed)
        for j in range((1 << w) - 1):
            t = H(I, u32(q), u16(i), bytes([j]), t)
        z.append(t)
    return H(I, u32(q), D_PBLC, *z)


def ots_sign(ots, I, q, seed, msg, c):
    """RFC 8554 Algorithm 3: u32str(type) || C || y."""
    n, w, p, ls = OTS[ots]
    Q = H(I, u32(q), D_MESG, c, msg)
    v = Q + cksm(Q, w, n, ls)
    ys = []
    for i in range(p):
        t = ots_secret(I, q, i, seed)
        for j in range(coef(v, i, w)):
            t = H(I, u32(q), u16(i), bytes([j]), t)
        ys.append(t)
    return u32(ots) + c + b"".join(ys)


def root_from_path(I, q, h, kc, path):
    """RFC 8554 Algorithm 6a, step 4."""
    node = (1 << h) + q
    tmp = H(I, u32(node), D_LEAF, kc)
    for p in path:
        tmp = H(I, u32(node // 2), D_INTR, p, tmp) if node % 2 else H(I, u32(node // 2), D_INTR, tmp, p)
        node //= 2
    return tmp


def parse_lms_sig(b):
    q = int.from_bytes(b[0:4], "big")
    ots = int.from_bytes(b[4:8], "big")
    p = OTS[ots][2]
    off = 8 + 32 * (p + 1)
    lms = int.from_bytes(b[off : off + 4], "big")
    h = LMS[lms]
    return {
        "q": q,
        "ots": ots,
        "c": b[8:40],
        "ys": [b[40 + 32 * i : 72 + 32 * i] for i in range(p)],
        "lms": lms,
        "path": [b[off + 4 + 32 * i : off + 36 + 32 * i] for i in range(h)],
        "len": off + 4 + 32 * h,
    }


def lms_verify(pk, msg, sig):
    """RFC 8554 Algorithms 6 and 6a; returns q or None."""
    lms, ots = int.from_bytes(pk[0:4], "big"), int.from_bytes(pk[4:8], "big")
    s = parse_lms_sig(sig)
    if s["ots"] != ots or s["lms"] != lms or s["len"] != len(sig) or s["q"] >= (1 << LMS[lms]):
        return None
    kc = ots_candidate(ots, pk[8:24], s["q"], msg, s["c"], s["ys"])
    return s["q"] if root_from_path(pk[8:24], s["q"], LMS[lms], kc, s["path"]) == pk[24:56] else None


def build_tree(lms, ots, I, seed):
    """RFC 8554 section 5.3: T[r] at index r."""
    h = LMS[lms]
    T = [None] * (1 << (h + 1))
    for q in range(1 << h):
        T[(1 << h) + q] = H(I, u32((1 << h) + q), D_LEAF, ots_public(ots, I, q, seed))
    for r in range((1 << h) - 1, 0, -1):
        T[r] = H(I, u32(r), D_INTR, T[2 * r], T[2 * r + 1])
    return T


def lms_sign(lms, ots, I, seed, T, q, msg, c):
    """RFC 8554 section 5.4.1 with the Appendix D path."""
    h = LMS[lms]
    path = [T[((1 << h) + q >> i) ^ 1] for i in range(h)]
    return u32(q) + ots_sign(ots, I, q, seed, msg, c) + u32(lms) + b"".join(path)


def randomizer(seed, I, q, msg):
    """Noised's deterministic C: HMAC-SHA256(SEED, "phalanx/pq/lmots/C" || I || u32str(q) || msg)."""
    # protocol constant: kept from the original name; changing it changes signatures
    return hmac.new(seed, b"phalanx/pq/lmots/C" + I + u32(q) + msg, hashlib.sha256).digest()


def derive_identity(master, cluster, index):
    """PQ_V2 amendment A12: (SEED, I) of creator identity `index` on `cluster`."""
    path = bytes([cluster]) + index.to_bytes(4, "little")
    # protocol constant: kept from the original name; changing it changes every key derived from a phrase or passkey
    return H(b"phalanx/pq/identity/v1/seed", master, path), H(b"phalanx/pq/identity/v1/id", master, path)[:16]


def hss_levels(tc):
    """[(pk, msg, sig)] of a two-level HSS test case (RFC 8554 section 6)."""
    pk = bytes.fromhex(tc["hss_public_key"])
    msg = bytes.fromhex(tc["message"])
    sig = bytes.fromhex(tc["hss_signature"])
    assert int.from_bytes(pk[:4], "big") == 2 and int.from_bytes(sig[:4], "big") == 1
    n0 = parse_lms_sig(sig[4:])["len"]
    pub1 = sig[4 + n0 : 4 + n0 + 56]
    return [(pk[4:60], pub1, sig[4 : 4 + n0]), (pub1, msg, sig[4 + n0 + 56 :])]


def check_appendix_f(path):
    d = json.load(open(path))
    for name in ("test_case_1", "test_case_2"):
        for level, (pk, msg, sig) in enumerate(hss_levels(d[name])):
            q = lms_verify(pk, msg, sig)
            assert q is not None, (name, level)
            print(f"{name} level {level}: LMS type {pk[3]}, LM-OTS type {pk[7]}, q = {q}: verifies")
    tc = d["test_case_2"]
    (pk0, msg0, sig0), (pk1, msg1, sig1) = hss_levels(tc)
    for (pk, msg, sig), seed, I in (
        ((pk0, msg0, sig0), tc["top_level_seed"], tc["top_level_i"]),
        ((pk1, msg1, sig1), tc["second_level_seed"], tc["second_level_i"]),
    ):
        seed, I = bytes.fromhex(seed), bytes.fromhex(I)
        lms, ots = pk[3], pk[7]
        T = build_tree(lms, ots, I, seed)
        assert T[1] == pk[24:56], "root"
        q = int.from_bytes(sig[:4], "big")
        assert lms_sign(lms, ots, I, seed, T, q, msg, sig[8:40]) == sig, "signature"
    print("test_case_2: both trees rebuilt from SEED and I; both signatures reproduced byte for byte")


def print_vectors(path):
    d = json.load(open(path))
    tc2_pk = bytes.fromhex(d["test_case_2"]["hss_public_key"])[4:60]
    print("identity_id(Test Case 2 top-level pk):", H(b"\x21", tc2_pk).hex())
    print("SHA256(0x20 || that pk) (key_id domain):", H(b"\x20", tc2_pk).hex())
    master = bytes(range(64))
    for cluster in (0, 1, 2):
        for index in (0, 1):
            seed, I = derive_identity(master, cluster, index)
            print(f"derive_identity(00..3f, cluster {cluster}, index {index}): SEED {seed.hex()} I {I.hex()}")
    seed, I = derive_identity(master, 2, 0)
    T = build_tree(6, 3, I, seed)
    pk = u32(6) + u32(3) + I + T[1]
    print("localnet identity 0: pk", pk.hex())
    print("localnet identity 0: identity_id", H(b"\x21", pk).hex())
    msg = b"PHX-ATTEST-V1" + b"".join(bytes([f]) * 32 for f in range(1, 6))
    for q in (0, 1, 511, 512, 1023):
        c = randomizer(seed, I, q, msg)
        sig = lms_sign(6, 3, I, seed, T, q, msg, c)
        assert lms_verify(pk, msg, sig) == q
        print(f"  leaf {q}: C {c.hex()} SHA256(signature) {H(sig).hex()}")


def hkdf_sha256(ikm, salt, info, length):
    """RFC 5869 with HMAC-SHA256."""
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm, block, counter = b"", b"", 1
    while len(okm) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        okm += block
        counter += 1
    return okm[:length]


def borsh_str(s):
    b = s.encode("utf-8")
    return struct.pack("<I", len(b)) + b


def strict_verify(pk, msg, sig):
    """lms_verify for LMS_SHA256_M32_H10 / LMOTS_SHA256_N32_W4 only, with the
    strict parsing of PQ_V2 amendment A1: anything malformed is None."""
    if len(pk) != 56 or pk[:8] != u32(6) + u32(3):
        return None
    if len(sig) != 2508 or sig[4:8] != u32(3) or sig[2184:2188] != u32(6):
        return None
    if int.from_bytes(sig[:4], "big") >= 1024:
        return None
    return lms_verify(pk, msg, sig)


def discriminator(namespace, name):
    """Anchor: sha256("<namespace>:<name>")[..8]."""
    return hashlib.sha256(f"{namespace}:{name}".encode()).digest()[:8]


B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58decode(s):
    n = 0
    for ch in s:
        n = n * 58 + B58.index(ch)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\0" * (len(s) - len(s.lstrip("1"))) + raw


# noised_launchpad::state::Launch (version 2), field by field: (name, bytes).
LAUNCH_FIELDS = [
    ("discriminator", 8), ("version", 1), ("bump", 1), ("authority_bump", 1), ("batch_bump", 1),
    ("config_bump", 1), ("status", 1), ("launch_seed", 32), ("creator", 32), ("dbc_config", 32),
    ("launch_authority", 32), ("batch_authority", 32), ("base_mint", 32), ("pool", 32),
    ("treasury", 32), ("platform_fee_bps", 2), ("recipients", 4 * (32 + 2)), ("recipient_count", 1),
    ("token_decimal", 1), ("migration_quote_threshold", 8), ("migration_fee_option", 1),
    ("open_delay_secs", 4), ("guard_secs", 4), ("max_wallet_bps", 2), ("max_buy_bps", 2),
    ("p2p_locked", 1), ("batch_wallet_cap", 8), ("batch_total_cap", 8), ("params_hash", 32),
    ("launch_ts", 8), ("commit_end_ts", 8), ("execute_end_ts", 8), ("guard_end_ts", 8),
    ("total_committed", 8), ("executed", 1), ("quote_spent", 8), ("tokens_out", 8),
    ("tokens_claimed", 8), ("quote_refunded", 8), ("pq_identity", 32),
]


def layout(fields):
    """{field: (offset, length)} and the total length."""
    out, at = {}, 0
    for name, n in fields:
        out[name] = (at, n)
        at += n
    return out, at


def apply_patch(b, ops):
    """The `rejections` patch format: set / xor at an offset, truncate, append."""
    b = bytearray(b)
    for op in ops:
        if op["op"] == "set":
            h = bytes.fromhex(op["hex"])
            b[op["offset"] : op["offset"] + len(h)] = h
        elif op["op"] == "xor":
            for i, c in enumerate(bytes.fromhex(op["hex"])):
                b[op["offset"] + i] ^= c
        elif op["op"] == "truncate":
            del b[op["length"] :]
        elif op["op"] == "append":
            b += bytes.fromhex(op["hex"])
        else:
            raise ValueError(op)
    return bytes(b)


def bitmap_of(leaves):
    used = bytearray(128)
    for q in leaves:
        used[q >> 3] |= 1 << (q & 7)
    return bytes(used)


def popcount(b):
    return sum(bin(c).count("1") for c in b)


def next_free_leaf(used, start):
    """PQ_V2 amendment A13: the first clear bit from `start`, +1 with wrap-around."""
    for i in range(1024):
        q = (start + i) % 1024
        if not used[q >> 3] & (1 << (q & 7)):
            return q
    return None


def parse_v1_message(m):
    """A v1 message per SPEC section 3: 0x81 || header (3) || config mask u32 ||
    blockhash || n_ix || n_addr || addresses || config values (mask order) ||
    instruction headers || instruction accounts and data."""
    assert m[0] == 0x81, "v1 version byte"
    header = list(m[1:4])
    mask = struct.unpack("<I", m[4:8])[0]
    blockhash = m[8:40]
    n_ix, n_addr = m[40], m[41]
    at = 42
    keys = [m[at + 32 * i : at + 32 * (i + 1)] for i in range(n_addr)]
    at += 32 * n_addr
    config = {}
    if mask & 0b11:
        config["priority_fee"] = struct.unpack("<Q", m[at : at + 8])[0]
        at += 8
    for bit, name in ((2, "compute_unit_limit"), (3, "loaded_accounts_data_size_limit"), (4, "heap_size")):
        if mask & (1 << bit):
            config[name] = struct.unpack("<I", m[at : at + 4])[0]
            at += 4
    heads = []
    for _ in range(n_ix):
        program, n_accounts, data_len = m[at], m[at + 1], struct.unpack("<H", m[at + 2 : at + 4])[0]
        heads.append((program, n_accounts, data_len))
        at += 4
    ixs = []
    for program, n_accounts, data_len in heads:
        accounts = list(m[at : at + n_accounts])
        at += n_accounts
        ixs.append((program, accounts, m[at : at + data_len]))
        at += data_len
    assert at == len(m), "the whole message is consumed"
    return {"header": header, "mask": mask, "blockhash": blockhash, "keys": keys, "config": config, "ixs": ixs}


# --- Solana program-derived addresses (no Ed25519 library: the on-curve test
# is the curve equation itself) -------------------------------------------

ED_P = 2**255 - 19
ED_D = (-121665 * pow(121666, ED_P - 2, ED_P)) % ED_P


def on_curve(b):
    """Whether 32 bytes decompress to an Ed25519 point (curve25519-dalek's
    CompressedEdwardsY::decompress, which create_program_address refuses):
    y is the low 255 bits, taken mod p, and x^2 = (y^2 - 1) / (d y^2 + 1)
    must be a square (zero included)."""
    y = (int.from_bytes(b, "little") & ((1 << 255) - 1)) % ED_P
    u = (y * y - 1) % ED_P
    v = (ED_D * y * y + 1) % ED_P
    x2 = u * pow(v, ED_P - 2, ED_P) % ED_P
    return x2 == 0 or pow(x2, (ED_P - 1) // 2, ED_P) == 1


def create_program_address(seeds, program_id):
    h = H(*seeds, program_id, b"ProgramDerivedAddress")
    return None if on_curve(h) else h


def find_program_address(seeds, program_id):
    """(address bytes, bump): the first bump from 255 down off the curve."""
    for bump in range(255, -1, -1):
        address = create_program_address(list(seeds) + [bytes([bump])], program_id)
        if address is not None:
            return address, bump
    raise ValueError("no program address")


# --- The on-chain metadata record (METADATA_PROGRAM.md) ----------------------

META_TAG = b"PHX-META-V2"
INLINE_URI_PREFIX = b"data:application/json;base64,"
FLAG_INLINE, FLAG_EXTERNAL = 1, 2
LIMITS = {"name": 32, "symbol": 10, "uri": 200, "doc": 3072}
ERROR_NUMBERS = {"InvalidMetadata": 6016, "InvalidMetadataFlags": 6045, "MetadataTooLong": 6046, "MetadataMismatch": 6047}


def lv(b):
    """A borsh string or byte vector: u32le length, then the bytes."""
    return struct.pack("<I", len(b)) + b


def record_borsh(name, symbol, flags, uri, doc):
    return lv(name) + lv(symbol) + bytes([flags]) + lv(uri) + lv(doc)


def metadata_hash_v2(name, symbol, flags, uri, doc):
    return H(META_TAG, record_borsh(name, symbol, flags, uri, doc))


def record_error(name, symbol, flags, uri, doc):
    """The error publish_metadata refuses a record with (None: accepted),
    in the program's order. Not UTF-8: the strings never deserialize."""
    for s in (name, symbol, uri, doc):
        s.decode("utf-8")
    if flags not in (0, FLAG_INLINE, FLAG_EXTERNAL):
        return "InvalidMetadataFlags"
    if len(doc) > LIMITS["doc"] or len(uri) > LIMITS["uri"]:
        return "MetadataTooLong"
    if not (0 < len(name) <= LIMITS["name"] and 0 < len(symbol) <= LIMITS["symbol"]):
        return "InvalidMetadata"
    if flags == FLAG_EXTERNAL:
        if not (len(uri) > 8 and uri.startswith(b"https://") and all(0x21 <= c <= 0x7E for c in uri)):
            return "InvalidMetadata"
    elif uri:
        return "InvalidMetadataFlags"
    if flags == FLAG_INLINE and not doc:
        return "InvalidMetadataFlags"
    return None


def record_ok(name, symbol, flags, uri, doc):
    try:
        return record_error(name, symbol, flags, uri, doc) is None
    except UnicodeDecodeError:
        return False


def token_uri(flags, uri, doc):
    """What launch writes into the mint's uri (standard base64 from the
    standard library)."""
    if flags == FLAG_INLINE:
        return INLINE_URI_PREFIX + base64.b64encode(doc)
    return uri if flags == FLAG_EXTERNAL else b""


def token_meta_bytes(bump, flags, launch, name, symbol, uri, doc):
    """TokenMeta: discriminator, version 1, bump, flags, launch, hash, the
    four strings."""
    return (
        discriminator("account", "TokenMeta") + bytes([1, bump, flags]) + launch
        + metadata_hash_v2(name, symbol, flags, uri, doc) + lv(name) + lv(symbol) + lv(uri) + lv(doc)
    )


def record_of(r):
    """(name, symbol, flags, uri, doc) bytes of a vector record."""
    x = bytes.fromhex
    return x(r["nameHex"]), x(r["symbolHex"]), r["flags"], x(r["uriHex"]), x(r["docHex"])


def check_attest_vectors(path):
    v = json.load(open(path, encoding="utf-8"))
    x = bytes.fromhex
    par = v["parameters"]
    program = b58decode(par["launchpad"])
    assert (par["lmsType"], par["otsType"], par["height"], par["leaves"]) == (6, 3, 10, 1024)
    assert (par["publicKeyLen"], par["signatureLen"], par["attestMessageLen"]) == (56, 2508, 221)
    assert (par["attestMessageTag"], par["metadataHashTag"]) == ("PHX-ATTEST-V3", "PHX-META-V2")
    assert (par["rulesHashTag"], par["noRulesHash"]) == ("PHX-RULES-V1", bytes(32).hex())
    assert par["launchSeeds"] == ["launch", "creator", "launchSeed"]
    assert par["payoutVaultSeeds"] == ["payout-vault", "launch", "vault"]
    assert par["tokenMetaSeeds"] == ["metadata", "launch", "metadataHash"]
    win = par["launchWindow"]
    assert (win["minSecs"], win["maxSecs"], win["maxLeadSecs"]) == (60, 3600, 604800)

    def window_ok(now, start, end):
        """A window an attestation landing at `now` records: a minute of it is left."""
        return (win["minSecs"] <= end - start <= win["maxSecs"] and max(now, start) + win["minSecs"] <= end
                and start <= now + win["maxLeadSecs"])

    d = v["derivation"]
    master = x(d["master"])
    assert (d["seedTag"], d["idTag"]) == ("phalanx/pq/identity/v1/seed", "phalanx/pq/identity/v1/id")
    for case in d["cases"]:
        seed, I = derive_identity(master, case["cluster"], case["index"])
        assert case["path"] == (bytes([case["cluster"]]) + case["index"].to_bytes(4, "little")).hex()
        assert (case["seed"], case["i"]) == (seed.hex(), I.hex()), case
    print(f"derivation: {len(d['cases'])} identities match")

    ident = v["identity"]
    seed, I = derive_identity(master, ident["cluster"], ident["index"])
    assert (ident["seed"], ident["i"]) == (seed.hex(), I.hex())
    T = build_tree(6, 3, I, seed)
    pk = u32(6) + u32(3) + I + T[1]
    assert ident["publicKey"] == pk.hex() and ident["root"] == T[1].hex()
    identity_id = H(b"\x21", pk)
    assert ident["identityId"] == identity_id.hex()
    print("identity: tree rebuilt (1,024 leaves); public key and identity id match")

    a = v["attestation"]
    launch = x(a["launchBytes"])
    launch_address, launch_bump = find_program_address([b"launch", x(a["creatorBytes"]), x(a["launchSeed"])], program)
    assert launch_address == launch == b58decode(a["launch"])
    identity_address, identity_bump = find_program_address([b"identity", identity_id], program)
    assert identity_address == b58decode(ident["identityAccount"])
    attestation_address, attestation_bump = find_program_address([b"attestation", launch], program)
    assert attestation_address == b58decode(a["attestationAccount"])

    m = v["metadata"]
    record = (m["name"].encode(), m["symbol"].encode(), m["flags"], m["uri"].encode(), m["doc"].encode())
    borsh = record_borsh(*record)
    assert m["borsh"] == borsh.hex()
    meta_hash = metadata_hash_v2(*record)
    assert m["hash"] == meta_hash.hex() and record_error(*record) is None
    token_meta_address, token_meta_bump = find_program_address([b"metadata", launch, meta_hash], program)
    assert m["tokenMetaAccount"] == v["accounts"]["tokenMeta"]["address"]
    assert b58decode(m["tokenMetaAccount"]) == token_meta_address

    assert a["metadataHash"] == meta_hash.hex()
    no_rules = bytes(32)
    assert a["rulesHash"] == no_rules.hex()
    lands_at = a["landsAt"]
    assert window_ok(lands_at, a["notBefore"], a["notAfter"])

    def message(meta_h, rules_h, not_before, not_after):
        """Attestation message v3: 221 bytes."""
        return (
            b"PHX-ATTEST-V3" + x(a["programBytes"]) + launch + x(a["paramsHash"]) + x(a["creatorBytes"])
            + meta_h + rules_h + struct.pack("<q", not_before) + struct.pack("<q", not_after)
        )

    assert x(a["programBytes"]) == program

    def probe_start(I_, msg_):
        """The review's leaf probe: u16be(SHA256(tag || I || message)) mod 1024."""
        return int.from_bytes(H(par["leafProbeTag"].encode(), I_, msg_)[:2], "big") % 1024

    msg = message(meta_hash, no_rules, a["notBefore"], a["notAfter"])
    assert len(msg) == 221 and a["message"] == msg.hex()
    assert a["messageHash"] == H(msg).hex()
    assert a["leafProbeStart"] == probe_start(I, msg)
    print("metadata record hash and address, attestation message (221 bytes), its hash and the leaf probe start match")

    for sig_case in v["signatures"]:
        q = sig_case["q"]
        c = randomizer(seed, I, q, msg)
        sig = lms_sign(6, 3, I, seed, T, q, msg, c)
        assert sig_case["c"] == c.hex(), q
        assert sig_case["signature"] == sig.hex(), q
        assert sig_case["sha256"] == H(sig).hex(), q
        assert lms_verify(pk, msg, sig) == q
        bad = bytearray(sig)
        bad[100] ^= 1
        assert lms_verify(pk, msg, bytes(bad)) is None
    print(f"signatures: {len(v['signatures'])} leaves reproduced byte for byte and verified")

    def ix_data(pk_, sig_, meta_h, rules_h, not_before, not_after):
        disc = discriminator("global", "attest_launch")
        return disc + pk_ + lv(sig_) + meta_h + rules_h + struct.pack("<q", not_before) + struct.pack("<q", not_after)

    ix = v["attestLaunch"]
    q = ix["q"]
    sig = lms_sign(6, 3, I, seed, T, q, msg, randomizer(seed, I, q, msg))
    data = ix_data(pk, sig, meta_hash, no_rules, a["notBefore"], a["notAfter"])
    assert ix["data"] == data.hex()
    assert [(a_["isSigner"], a_["isWritable"]) for a_ in ix["accounts"]] == [
        (True, True), (False, False), (False, True), (False, True), (False, False), (False, False), (False, False)
    ]
    assert [b58decode(a_["pubkey"]) for a_ in ix["accounts"][1:5]] == [
        launch, identity_address, attestation_address, token_meta_address
    ]
    # No rules: the program id in the rules slot (Anchor's None).
    assert b58decode(ix["accounts"][6]["pubkey"]) == program
    print("attest_launch instruction data and accounts match")

    for b in v["bitmap"]:
        assert (b["byte"], b["mask"]) == (b["q"] >> 3, 1 << (b["q"] & 7))

    pk_ = v["passkey"]
    entropy = hkdf_sha256(x(pk_["prfOutput"]), pk_["hkdfSalt"].encode(), pk_["hkdfInfo"].encode(), pk_["length"])
    assert pk_["entropy"] == entropy.hex()
    r = pk_["rfc5869Case1"]
    assert hkdf_sha256(x(r["ikm"]), x(r["salt"]), x(r["info"]), r["length"]).hex() == r["okm"]
    print("passkey HKDF (and RFC 5869 test case 1) match")

    # What the launchpad writes and what clients choose.
    assert ident["nodesSha256"] == H(b"".join(T[1:])).hex()
    d = par["discriminators"]
    for key, (ns, name) in {
        "attestLaunch": ("global", "attest_launch"),
        "publishMetadata": ("global", "publish_metadata"),
        "launch": ("account", "Launch"),
        "tokenMeta": ("account", "TokenMeta"),
        "identity": ("account", "Identity"),
        "attestation": ("account", "Attestation"),
        "payoutVault": ("account", "PayoutVault"),
        "launchAttested": ("event", "LaunchAttested"),
        "pqLeafConsumed": ("event", "PqLeafConsumed"),
        "metadataPublished": ("event", "MetadataPublished"),
    }.items():
        assert d[key] == discriminator(ns, name).hex(), key
    for e in par["errors"]:
        if e["name"] in ERROR_NUMBERS:
            assert e["number"] == ERROR_NUMBERS[e["name"]], e
    assert {"InvalidMetadataFlags", "MetadataTooLong", "MetadataMismatch"} <= {e["name"] for e in par["errors"]}
    lim = par["metadataLimits"]
    assert lim["utf8Required"] and "UTF-8 bytes" in lim["unit"]
    assert (lim["maxNameLen"], lim["maxSymbolLen"], lim["maxUriLen"], lim["maxDocLen"]) == (32, 10, 200, 3072)
    for ex in lim["examples"]:
        rec = record_of(ex["metadata"])
        nb, sb = rec[0], rec[1]
        assert ex["valid"] == record_ok(*rec), ex["name"]
        assert (ex["nameBytes"], ex["symbolBytes"]) == (len(nb), len(sb)), ex["name"]
        assert (ex["nameChars"], ex["symbolChars"]) == (len(nb.decode()), len(sb.decode())), ex["name"]
    print(f"metadata limits: {len(lim['examples'])} examples, in UTF-8 bytes")

    att_offsets = par["attestationOffsets"]
    fields, total = layout(LAUNCH_FIELDS)
    offsets = par["launchOffsets"]
    assert total == par["launchAccountLen"]
    for key, field in (("status", "status"), ("creator", "creator"), ("paramsHash", "params_hash"), ("pqIdentity", "pq_identity")):
        assert offsets[key] == fields[field][0], key
    acc = v["accounts"]
    assert (acc["launch"]["bump"], acc["identity"]["bump"], acc["attestation"]["bump"]) == (
        launch_bump, identity_bump, attestation_bump
    )
    launch_bytes = bytearray(total)
    for field, value in (
        ("discriminator", discriminator("account", "Launch")),
        ("version", b"\x02"),
        ("bump", bytes([launch_bump])),
        ("status", b"\x00"),
        ("launch_seed", x(a["launchSeed"])),
        ("creator", x(a["creatorBytes"])),
        ("params_hash", x(a["paramsHash"])),
        ("pq_identity", identity_id),
    ):
        at, n = fields[field]
        assert len(value) == n, field
        launch_bytes[at : at + n] = value
    assert acc["launch"]["status"] == "Configured" and acc["launch"]["data"] == launch_bytes.hex()
    tm = acc["tokenMeta"]
    assert tm["bump"] == token_meta_bump and b58decode(tm["address"]) == token_meta_address
    tm_bytes = token_meta_bytes(token_meta_bump, record[2], launch, record[0], record[1], record[3], record[4])
    assert len(tm_bytes) == par["tokenMetaFixedLen"] + len(record[0]) + len(record[1]) + len(record[3]) + len(record[4])
    assert tm["data"] == tm_bytes.hex()

    used = bitmap_of(acc["identity"]["usedLeaves"])
    identity_bytes = (
        discriminator("account", "Identity") + bytes([1, identity_bump]) + pk + used + struct.pack("<H", popcount(used))
    )
    assert len(identity_bytes) == par["identityAccountLen"] and acc["identity"]["data"] == identity_bytes.hex()
    att = acc["attestation"]
    sig = lms_sign(6, 3, I, seed, T, att["leaf"], msg, randomizer(seed, I, att["leaf"], msg))
    attestation_fields = [
        ("discriminator", discriminator("account", "Attestation")),
        ("version", bytes([par["attestationVersion"]])),
        ("bump", bytes([attestation_bump])),
        ("launch", launch),
        ("pqIdentity", identity_id),
        ("leaf", struct.pack("<H", att["leaf"])),
        ("metadataHash", meta_hash),
        ("rulesHash", no_rules),
        ("messageHash", H(msg)),
        ("slot", struct.pack("<Q", att["slot"])),
        ("notBefore", struct.pack("<q", a["notBefore"])),
        ("notAfter", struct.pack("<q", a["notAfter"])),
        ("signatureLen", struct.pack("<I", len(sig))),
        ("signature", sig),
    ]
    assert par["attestationVersion"] == 3
    at_ = 0
    for name, value in attestation_fields:
        if name in att_offsets:
            assert att_offsets[name] == at_, name
        at_ += len(value)
    assert set(att_offsets) <= {name for name, _ in attestation_fields}
    attestation_bytes = b"".join(value for _, value in attestation_fields)
    assert len(attestation_bytes) == par["attestationAccountLen"] == 2708
    assert att["data"] == attestation_bytes.hex()
    ev = v["events"]
    assert (ev["launchAttested"]["leaf"], ev["launchAttested"]["slot"]) == (att["leaf"], att["slot"])
    assert ev["launchAttested"]["data"] == (
        launch + identity_id + struct.pack("<H", att["leaf"]) + meta_hash + no_rules + struct.pack("<Q", att["slot"])
        + struct.pack("<q", a["notBefore"]) + struct.pack("<q", a["notAfter"])
    ).hex()
    assert ev["pqLeafConsumed"]["data"] == (identity_id + struct.pack("<H", ev["pqLeafConsumed"]["leaf"]) + launch).hex()
    print("tree digest, discriminators, PDAs and bumps, Launch / TokenMeta / Identity / Attestation bytes and event payloads match")

    v1 = ix["v1"]
    wire, message_ = x(v1["wire"]), x(v1["message"])
    assert wire[: len(message_)] == message_ and len(wire) == len(message_) + 64 * v1["header"][0]
    pm = parse_v1_message(message_)
    assert pm["header"] == v1["header"] and pm["blockhash"] == b58decode(v1["recentBlockhash"])
    assert pm["config"] == {
        "compute_unit_limit": par["attestCuLimit"],
        "loaded_accounts_data_size_limit": par["attestLoadedAccountsDataLimit"],
    }
    assert [k.hex() for k in pm["keys"]] == [b58decode(k).hex() for k in v1["accountKeys"]]
    assert pm["keys"][0] == b58decode(ix["payer"]), "the throwaway payer pays"
    ((program_index, accounts, ix_data_),) = pm["ixs"]
    assert pm["keys"][program_index] == program and ix_data_ == data
    assert [pm["keys"][i] for i in accounts] == [b58decode(meta["pubkey"]) for meta in ix["accounts"]]
    print(f"attest_launch v1 transaction: {len(wire)} bytes, SPEC section 3 layout, A14 config words")

    landed = bitmap_of([s_["q"] for s_ in v["signatures"]])
    assert any(case["used"] == landed.hex() for case in v["leafSelection"])
    for case in v["leafSelection"]:
        used_ = x(case["used"])
        assert case["usedCount"] == popcount(used_), case["name"]
        assert case["next"] == next_free_leaf(used_, case["probeStart"]), case["name"]
    assert v["leafSelection"][0]["probeStart"] == a["leafProbeStart"]
    print(f"leaf selection: {len(v['leafSelection'])} cases match")

    for case in v["rejections"]:
        pk2 = apply_patch(pk, case["publicKeyPatch"])
        sig2 = apply_patch(sig, case["signaturePatch"])
        msg2 = message(metadata_hash_v2(*record_of(case["metadata"])), no_rules, a["notBefore"], a["notAfter"])
        assert case["verify"] is None and strict_verify(pk2, msg2, sig2) is None, case["name"]
        assert case["programError"] == "InvalidPqSignature", case["name"]
    assert strict_verify(pk, msg, sig) == att["leaf"]
    print(f"rejections: {len(v['rejections'])} cases refused by the strict verifier (InvalidPqSignature)")

    # Burn-only landings: valid signatures that attest nothing, landed in
    # order with the vector record published; each takes the first clear
    # leaf of its identity from its message's probe start.
    burn = v["burnOnly"]
    assert burn["landsAt"] == lands_at
    trees = {pk: (seed, I, T)}
    bitmaps = {}
    for case in burn["cases"]:
        pkc = x(case["publicKey"])
        if pkc not in trees:
            found = [
                (s_, i_) for s_, i_ in (derive_identity(master, ident["cluster"], n_) for n_ in range(4))
                if i_ == pkc[8:24]
            ]
            assert len(found) == 1, case["name"]
            s_, i_ = found[0]
            t_ = build_tree(6, 3, i_, s_)
            assert u32(6) + u32(3) + i_ + t_[1] == pkc, case["name"]
            trees[pkc] = (s_, i_, t_)
        sc, ic, tc = trees[pkc]
        idc = H(b"\x21", pkc)
        assert case["identityId"] == idc.hex()
        assert b58decode(case["identityAccount"]) == find_program_address([b"identity", idc], program)[0]
        rec = record_of(case["metadata"])
        mh = metadata_hash_v2(*rec)
        assert case["metadataHash"] == mh.hex()
        assert b58decode(case["tokenMetaAccount"]) == find_program_address([b"metadata", launch, mh], program)[0]
        t = case["terms"]
        rh = x(t["rulesHash"])
        rules_account = program if rh == no_rules else find_program_address([b"rules", launch, rh], program)[0]
        assert b58decode(case["rulesAccount"]) == rules_account, case["name"]
        msgc = message(mh, rh, t["notBefore"], t["notAfter"])
        assert case["message"] == msgc.hex(), case["name"]
        start = probe_start(ic, msgc)
        used_ = bitmaps.setdefault(idc, bytearray(128))
        qc = next_free_leaf(bytes(used_), start)
        assert (case["probeStart"], case["q"]) == (start, qc), case["name"]
        used_[qc >> 3] |= 1 << (qc & 7)
        sigc = lms_sign(6, 3, ic, sc, tc, qc, msgc, randomizer(sc, ic, qc, msgc))
        assert case["signature"] == sigc.hex() and strict_verify(pkc, msgc, sigc) == qc, case["name"]
        assert case["data"] == ix_data(pkc, sigc, mh, rh, t["notBefore"], t["notAfter"]).hex()
        assert case["event"] == (idc + struct.pack("<H", qc) + launch).hex(), case["name"]
        # Only the vector record exists and no rules record: any other hash
        # names nothing.
        attests = (idc == identity_id and mh == meta_hash and rh == no_rules
                   and window_ok(lands_at, t["notBefore"], t["notAfter"]))
        assert not attests, case["name"]
        assert mh == meta_hash or record_ok(*rec) == ("never published" in case["name"]), case["name"]
    empty = discriminator("account", "Attestation") + bytes([0, attestation_bump])
    assert burn["emptyAttestation"] == (empty + bytes(par["attestationAccountLen"] - len(empty))).hex()
    print(f"burn-only: {len(burn['cases'])} valid signatures reproduced; none attests (record, rules, window or identity)")
    print("lms.json: every checked value matches the independent implementation")


def icon_png(icon):
    """The documented 32x32 4-bit indexed icon, rebuilt from its rules with
    the standard library's zlib (CRC-32, Adler-32)."""
    palette = b"".join(bytes([10 + 15 * i, 44 + 13 * i, 90 + 10 * i]) for i in range(16))
    assert icon["palette"] == palette.hex()

    def pixel(x_, y_):
        return 15 - min(15, math.isqrt((2 * x_ - 31) ** 2 + (2 * y_ - 31) ** 2) // 2)

    rows = b"".join(
        b"\x00" + bytes((pixel(x_, y_) << 4) | pixel(x_ + 1, y_) for x_ in range(0, 32, 2)) for y_ in range(32)
    )
    assert len(rows) == 544 and icon["scanlinesSha256"] == H(rows).hex()
    stored = b"\x78\x01\x01" + struct.pack("<HH", len(rows), len(rows) ^ 0xFFFF) + rows + struct.pack(">I", zlib.adler32(rows))
    assert zlib.decompress(stored) == rows

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    ihdr = struct.pack(">II", 32, 32) + bytes([4, 3, 0, 0, 0])
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"PLTE", palette) + chunk(b"IDAT", stored) + chunk(b"IEND", b"")


def check_metadata_vectors(path):
    v = json.load(open(path, encoding="utf-8"))
    x = bytes.fromhex
    par = v["parameters"]
    program = b58decode(par["launchpad"])
    assert (par["metadataHashTag"], par["metadataSeed"], par["attestMessageTag"], par["attestMessageLen"]) == (
        "PHX-META-V2", "metadata", "PHX-ATTEST-V3", 221
    )
    assert par["tokenMetaSeeds"] == ["metadata", "launch", "metadataHash"]
    assert par["flags"] == {"none": 0, "inlineUri": FLAG_INLINE, "externalUri": FLAG_EXTERNAL}
    assert (par["maxNameLen"], par["maxSymbolLen"], par["maxUriLen"], par["maxDocLen"]) == (32, 10, 200, 3072)
    assert (par["externalUriPrefix"], par["inlineUriPrefix"]) == ("https://", INLINE_URI_PREFIX.decode())
    assert par["maxInlineUriLen"] == len(INLINE_URI_PREFIX) + len(base64.b64encode(bytes(3072))) == 4125
    assert (par["tokenMetaVersion"], par["tokenMetaFixedLen"]) == (1, 91)
    assert par["tokenMetaOffsets"] == {"version": 8, "bump": 9, "flags": 10, "launch": 11, "metadataHash": 43, "name": 75}
    cert = par["certificate"]
    assert (cert["version"], cert["accountLen"], cert["metadataOffset"], cert["metadataOnchainCheck"], cert["allChecks"]) == (
        4, 519, 455, 2048, 4095
    )
    assert (cert["rulesHashOffset"], cert["rulesBoundCheck"], cert["safetyPolicyVersion"]) == (487, 4096, 3)
    for key, (ns, name) in {
        "publishMetadata": ("global", "publish_metadata"),
        "attestLaunch": ("global", "attest_launch"),
        "launch": ("global", "launch"),
        "tokenMeta": ("account", "TokenMeta"),
        "metadataPublished": ("event", "MetadataPublished"),
        "certificate": ("account", "Certificate"),
    }.items():
        assert par["discriminators"][key] == discriminator(ns, name).hex(), key
    assert {e["name"]: e["number"] for e in par["errors"]} == ERROR_NUMBERS

    icon = v["icon"]
    png = icon_png(icon)
    assert icon["png"] == png.hex() and icon["pngLen"] == len(png) == 672 and icon["pngSha256"] == H(png).hex()
    assert (icon["width"], icon["height"], icon["bitDepth"], icon["colourType"]) == (32, 32, 4, 3)
    assert icon["dataUri"] == "data:image/png;base64," + base64.b64encode(png).decode()
    print(f"icon: the 32x32 16-colour PNG ({len(png)} bytes) rebuilt from its rules; zlib inflates its IDAT")

    launch_v = v["launch"]
    launch = x(launch_v["launchBytes"])
    assert launch == b58decode(launch_v["address"])
    assert find_program_address([b"launch", b58decode(launch_v["creator"]), x(launch_v["launchSeed"])], program)[0] == launch
    for case in v["cases"]:
        r = case["record"]
        rec = record_of(r)
        name, symbol, flags, uri, doc = rec
        for key, b in (("name", name), ("symbol", symbol), ("uri", uri), ("doc", doc)):
            assert r[key] == b.decode("utf-8"), (case["name"], key)
        assert r["nameChars"] == len(name.decode()), case["name"]
        assert record_error(*rec) is None, case["name"]
        assert case["borsh"] == record_borsh(*rec).hex(), case["name"]
        mh = metadata_hash_v2(*rec)
        assert case["metadataHash"] == mh.hex(), case["name"]
        address, bump = find_program_address([b"metadata", launch, mh], program)
        tm = case["tokenMeta"]
        assert (b58decode(tm["address"]), tm["bump"]) == (address, bump), case["name"]
        data = token_meta_bytes(bump, flags, launch, name, symbol, uri, doc)
        assert tm["data"] == data.hex() and tm["space"] == len(data) == 91 + len(name) + len(symbol) + len(uri) + len(doc)
        turi = token_uri(flags, uri, doc)
        assert case["tokenUri"] == turi.decode("ascii") and case["tokenUriLen"] == len(turi), case["name"]
        if flags == FLAG_INLINE:
            assert base64.b64decode(turi[len(INLINE_URI_PREFIX):], validate=True) == doc
        assert case["publishData"] == (discriminator("global", "publish_metadata") + record_borsh(*rec)).hex()
        assert case["metadataPublishedEvent"] == (
            launch + address + mh + bytes([flags]) + struct.pack("<HH", len(uri), len(doc))
        ).hex(), case["name"]
        if doc:
            parsed = json.loads(doc)
            assert (parsed["name"], parsed["symbol"]) == (name.decode(), symbol.decode()), case["name"]
            assert list(parsed)[:3] == ["name", "symbol", "description"], case["name"]
            if "image" in parsed:
                assert parsed["image"] == icon["dataUri"], case["name"]
    sizes = sorted(c["tokenMeta"]["space"] for c in v["cases"])
    assert sizes[-1] == 3405 and max(c["tokenUriLen"] for c in v["cases"]) == 4125
    print(f"cases: {len(v['cases'])} records: hash, address and bump, account bytes, token uri, publish data and event match")

    for case in v["invalid"]:
        rec = record_of(case["record"])
        err = record_error(*rec)
        assert err is not None and case["error"] == err and case["errorNumber"] == ERROR_NUMBERS[err], case["name"]
        assert case["publishData"] == (discriminator("global", "publish_metadata") + record_borsh(*rec)).hex()
    assert {c["error"] for c in v["invalid"]} == {"InvalidMetadata", "InvalidMetadataFlags", "MetadataTooLong"}
    print(f"invalid: {len(v['invalid'])} records refused with the vectors' errors")

    for case in v["pdas"]:
        lp = x(case["launchBytes"])
        assert lp == b58decode(case["launch"])
        address, bump = find_program_address([b"metadata", lp, x(case["metadataHash"])], program)
        assert (b58decode(case["address"]), case["bump"]) == (address, bump), case["name"]
    print(f"pdas: {len(v['pdas'])} record addresses match")

    typical = next(c for c in v["cases"] if c["name"].startswith("typical: "))
    pub = v["publishTypical"]
    assert pub["data"] == typical["publishData"]
    assert [(m_["isSigner"], m_["isWritable"]) for m_ in pub["accounts"]] == [(True, True), (False, False), (False, True), (False, False)]
    assert [b58decode(m_["pubkey"]) for m_ in pub["accounts"]][1:] == [
        launch, b58decode(typical["tokenMeta"]["address"]), bytes(32)
    ]

    a = v["attestation"]
    assert a["record"] == typical["name"] and a["metadataHash"] == typical["metadataHash"]
    mh = x(a["metadataHash"])
    rh = x(a["rulesHash"])
    assert rh == bytes(32), "no creator rules"
    msg = (
        b"PHX-ATTEST-V3" + program + launch + x(a["paramsHash"]) + x(a["creatorBytes"]) + mh + rh
        + struct.pack("<q", a["notBefore"]) + struct.pack("<q", a["notAfter"])
    )
    assert len(msg) == 221 and a["message"] == msg.hex() and a["messageHash"] == H(msg).hex()
    seed, I = derive_identity(bytes(range(64)), 2, 0)
    T = build_tree(6, 3, I, seed)
    pk = u32(6) + u32(3) + I + T[1]
    assert a["publicKey"] == pk.hex()
    q = int.from_bytes(H(b"phalanx/pq/identity/leaf", I, msg)[:2], "big") % 1024
    assert a["q"] == q
    sig = lms_sign(6, 3, I, seed, T, q, msg, randomizer(seed, I, q, msg))
    assert a["signature"] == sig.hex() and strict_verify(pk, msg, sig) == q
    data = discriminator("global", "attest_launch") + pk + lv(sig) + mh + rh + struct.pack("<qq", a["notBefore"], a["notAfter"])
    assert a["data"] == data.hex()
    identity_address = find_program_address([b"identity", H(b"\x21", pk)], program)[0]
    attestation_address = find_program_address([b"attestation", launch], program)[0]
    token_meta_address = find_program_address([b"metadata", launch, mh], program)[0]
    assert [b58decode(a[k]) for k in ("identityAccount", "attestationAccount", "tokenMetaAccount")] == [
        identity_address, attestation_address, token_meta_address
    ]
    assert [b58decode(m_["pubkey"]) for m_ in a["accounts"]][1:] == [
        launch, identity_address, attestation_address, token_meta_address, bytes(32), program
    ]
    assert [(m_["isSigner"], m_["isWritable"]) for m_ in a["accounts"]] == [
        (True, True), (False, False), (False, True), (False, True), (False, False), (False, False), (False, False)
    ]
    print("attestation of the typical record: message v3, signature, data and accounts match")

    li = v["launchInstruction"]
    assert li["data"] == discriminator("global", "launch").hex()
    assert len(li["accounts"]) == 23 and [m_["name"] for m_ in li["accounts"][-3:]] == ["attestation", "token_meta", "rules"]
    assert all(not m_["isSigner"] and not m_["isWritable"] for m_ in li["accounts"][-3:])
    assert (b58decode(li["attestationAccount"]), b58decode(li["tokenMetaAccount"])) == (attestation_address, token_meta_address)
    print("launch: no arguments (its discriminator), the metadata and rules records last of 23 accounts")
    print("metadata.json: every checked value matches the independent implementation")


# PXR1 (PROGRAMMABLE_V1 section 1.2), written from the specification.
PXR1_MAX_GUARD = 72 * 3600
RULE_LEAVES = range(0x10, 0x1A)


def pxr1_verify(b, guard_secs):
    """None if `b` is a valid PXR1 rule set for this guard, else a reason."""
    if len(b) < 12:
        return "TooShort"
    if b[:4] != b"PXR1":
        return "BadMagic"
    version, n_keys, n_rules, n_nodes = b[4], b[5], b[6], b[7]
    if version != 1:
        return "BadVersion"
    if b[8:12] != bytes(4):
        return "ReservedNonZero"
    if n_keys > 8 or not 1 <= n_rules <= 16 or n_nodes > 64:
        return "Limits"
    if len(b) != 12 + 32 * n_keys + 20 * n_rules + 10 * n_nodes:
        return "BadLength"
    keys = [b[12 + 32 * i : 44 + 32 * i] for i in range(n_keys)]
    if any(k == bytes(32) for k in keys) or len(set(keys)) != len(keys):
        return "Keys"
    at = 12 + 32 * n_keys
    rules = [struct.unpack("<IIBBBBQ", b[at + 20 * i : at + 20 * i + 20]) for i in range(n_rules)]
    at += 20 * n_rules
    nodes = [(b[at + 10 * i], b[at + 10 * i + 1], struct.unpack("<Q", b[at + 10 * i + 2 : at + 10 * i + 10])[0]) for i in range(n_nodes)]
    guard = min(guard_secs, PXR1_MAX_GUARD)
    all_keys = (1 << n_keys) - 1
    used_keys, nxt = 0, 0

    def bps_ok(arg):
        return arg & ~((1 << 63) | 0xFFFF) == 0 and 1 <= arg & 0xFFFF <= 10000

    for frm, to, off, ln, effect, code, arg in rules:
        if not frm < to <= guard:
            return "Window"
        if code > 63:
            return "BadCode"
        if effect == 1:
            if arg:
                return "DenyArgNonZero"
        elif effect in (2, 3):
            if (arg >> 63 and not bps_ok(arg)) or arg == 0:
                return "Cap"
        else:
            return "UnknownEffect"
        if ln == 0 or off != nxt or off + ln > n_nodes:
            return "Condition"
        depth = 0
        for op, a, x_ in nodes[off : off + ln]:
            if op in (0, 1, 2, 3, 4):
                if a or x_:
                    return "NonZeroOperand"
                pops = {0: 0, 1: 0, 2: 2, 3: 2, 4: 1}[op]
            elif op in RULE_LEAVES:
                pops = 0
                if op in (0x10, 0x11) and (a or x_):
                    return "NonZeroOperand"
                if op in (0x12, 0x13, 0x14, 0x15, 0x19) and a:
                    return "NonZeroOperand"
                if op in (0x12, 0x13) and x_ > guard:
                    return "TimeOutOfRange"
                if op in (0x14, 0x15) and x_ >> 63 and not bps_ok(x_):
                    return "BadBps"
                if op in (0x16, 0x17, 0x18):
                    if x_:
                        return "NonZeroOperand"
                    if a == 0 or a & ~all_keys:
                        return "BadKeyMask"
                    used_keys |= a
            else:
                return "UnknownOp"
            if depth < pops:
                return "StackUnderflow"
            depth -= pops
            if depth >= 16:
                return "StackOverflow"
            depth += 1
        if depth != 1:
            return "LeftoverValues"
        nxt = off + ln
    if nxt != n_nodes:
        return "UnreferencedNode"
    if used_keys != all_keys:
        return "UnusedKey"
    return None


def check_programmable_vectors(path):
    v = json.load(open(path, encoding="utf-8"))
    x = bytes.fromhex
    par = v["parameters"]
    program = b58decode(par["launchpad"])
    autopilot_program = b58decode(par["autopilot"])
    assert (par["rulesHashTag"], par["authMessageTag"], par["attestMessageLen"], par["authMessageLen"]) == (
        "PHX-RULES-V1", "PHX-AUTH-V1", 221, 140
    )
    assert par["payloadDomains"] == {
        "GRAPH_ACTIVATE": "PHX-GRAPH-ACT-V1", "GRAPH_FREEZE": "PHX-GRAPH-FRZ-V2", "OPERATOR_REVOKE": "PHX-OP-REVOKE-V3"
    }
    # The autopilot's `Autopilot` account (audit 4 appended activeAuth, activeActivateAt, partialSpent).
    ap_layout = [("discriminator", 8), ("version", 1), ("bump", 1), ("treasuryBump", 1), ("launch", 32), ("mint", 32),
                 ("dammPool", 32), ("activeGraph", 32), ("pendingGraph", 32), ("pendingActivateAt", 8),
                 ("pendingOperator", 32), ("activatedAt", 8), ("frozen", 1), ("operator", 32),
                 ("authMarks", 3 * (8 + 32)), ("seq", 8), ("refSqrtPrice", 16), ("refUpdatedAt", 8),
                 ("refAllowance", 8), ("refAllowanceAt", 8), ("observations", 2 * (8 + 8 + 16 + 16)),
                 ("tipEpochStart", 8), ("tipsInEpoch", 8), ("nodes", 16 * (8 + 8 + 8 + 2 + 8)), ("activeAuth", 32),
                 ("activeActivateAt", 8), ("partialSpent", 16 * 8)]
    at_, ap_offsets = 0, {}
    for name, n in ap_layout:
        ap_offsets[name] = at_
        at_ += n
    del ap_offsets["discriminator"]
    assert par["autopilotAccount"] == {"version": 1, "accountLen": at_, "offsets": ap_offsets} and at_ == 1244
    assert (ap_offsets["activeAuth"], ap_offsets["activeActivateAt"], ap_offsets["partialSpent"]) == (1076, 1108, 1116)
    assert par["launchRules"] == {"version": 1, "fixedLen": 78, "offsets": {
        "version": 8, "bump": 9, "launch": 10, "rulesHash": 42, "bytesLen": 74, "bytes": 78}}
    auth_layout = [("discriminator", 8), ("version", 1), ("bump", 1), ("launch", 32), ("pqIdentity", 32), ("kind", 1),
                   ("payloadHash", 32), ("messageHash", 32), ("unixTime", 8), ("slot", 8), ("leaf", 2),
                   ("signatureLen", 4), ("signature", 2508)]
    at_, offsets = 0, {}
    for name, n in auth_layout:
        offsets[name] = at_
        at_ += n
    del offsets["discriminator"]
    assert par["authorization"] == {"version": 1, "accountLen": at_, "offsets": offsets} and at_ == 2669
    cert = par["certificate"]
    assert (cert["version"], cert["accountLen"], cert["checksOffset"], cert["metadataOffset"], cert["rulesHashOffset"]) == (
        4, 519, 187, 455, 487
    )
    assert (cert["allChecks"], cert["rulesBound"], cert["withRules"]) == (4095, 4096, 4095 | 4096)
    assert (par["hookPolicy"]["version"], par["hookPolicy"]["rulesLenOffset"], par["hookPolicy"]["rulesOffset"]) == (2, 275, 279)
    errors = {(e["program"], e["name"]): e["number"] for e in par["errors"]}
    assert errors == {("launchpad", "InvalidRules"): 6048, ("hook", "RuleDenied"): 6011, ("hook", "InvalidRules"): 6012}
    for key, (ns, name) in {
        "publishRules": ("global", "publish_rules"), "pqAuthorize": ("global", "pq_authorize"),
        "attestLaunch": ("global", "attest_launch"), "launchRules": ("account", "LaunchRules"),
        "authorization": ("account", "Authorization"), "rulesPublished": ("event", "RulesPublished"),
        "authorized": ("event", "Authorized"), "launchAttested": ("event", "LaunchAttested"),
        "pqLeafConsumed": ("event", "PqLeafConsumed"), "hookPolicy": ("account", "HookPolicy"),
        "policyCreated": ("event", "PolicyCreated"), "autopilotAccount": ("account", "Autopilot"),
    }.items():
        assert par["discriminators"][key] == discriminator(ns, name).hex(), key

    ln = v["launch"]
    creator, seed_, params_hash = x(ln["creatorBytes"]), x(ln["launchSeed"]), x(ln["paramsHash"])
    launch, launch_bump = find_program_address([b"launch", creator, seed_], program)
    assert launch == b58decode(ln["address"])
    seed, I = derive_identity(bytes(range(64)), 2, 0)
    T = build_tree(6, 3, I, seed)
    pk = u32(6) + u32(3) + I + T[1]
    identity_id = H(b"\x21", pk)
    assert (ln["publicKey"], ln["pqIdentity"]) == (pk.hex(), identity_id.hex())
    fields, total = layout(LAUNCH_FIELDS)
    assert fields["guard_secs"][0] == par["launchGuardSecsOffset"] == 423
    launch_bytes = bytearray(total)
    for field, value in (
        ("discriminator", discriminator("account", "Launch")), ("version", b"\x02"), ("bump", bytes([launch_bump])),
        ("status", b"\x00"), ("launch_seed", seed_), ("creator", creator), ("params_hash", params_hash),
        ("pq_identity", identity_id), ("guard_secs", struct.pack("<I", ln["guardSecs"])),
    ):
        at, n = fields[field]
        launch_bytes[at : at + n] = value
    assert ln["data"] == launch_bytes.hex()
    record = (b"Phalanx Vector Token", b"PHXV", 0, b"", b'{"name":"Phalanx Vector Token","symbol":"PHXV","description":"PQ v2 test vectors"}')
    mh = metadata_hash_v2(*record)
    tm_address, tm_bump = find_program_address([b"metadata", launch, mh], program)
    assert (ln["metadataHash"], b58decode(ln["tokenMeta"])) == (mh.hex(), tm_address)
    assert ln["tokenMetaData"] == token_meta_bytes(tm_bump, 0, launch, record[0], record[1], record[3], record[4]).hex()
    payer = b58decode(ln["payer"])
    system = bytes(32)
    print("launch, metadata record and identity rebuilt")

    rule_hashes = []
    for r in v["rules"]:
        b = x(r["bytes"])
        assert pxr1_verify(b, ln["guardSecs"]) is None, r["name"]
        assert pxr1_verify(b, 60) is not None, r["name"]  # windows past a one-minute guard
        rh = H(b"PHX-RULES-V1", b)
        rule_hashes.append(rh)
        address, bump = find_program_address([b"rules", launch, rh], program)
        assert (r["rulesHash"], b58decode(r["address"]), r["bump"], r["len"]) == (rh.hex(), address, bump, len(b))
        data = discriminator("account", "LaunchRules") + bytes([1, bump]) + launch + rh + lv(b)
        assert r["accountData"] == data.hex() and len(data) == 78 + len(b), r["name"]
        pr = r["publishRules"]
        assert pr["data"] == (discriminator("global", "publish_rules") + lv(b)).hex()
        assert [(b58decode(m_["pubkey"]), m_["isSigner"], m_["isWritable"]) for m_ in pr["accounts"]] == [
            (payer, True, True), (launch, False, False), (address, False, True), (system, False, False)
        ]
        assert r["rulesPublished"] == (launch + address + rh + struct.pack("<H", len(b))).hex()
    assert max(len(x(r["bytes"])) for r in v["rules"]) == 1228
    print(f"rules: {len(v['rules'])} PXR1 rule sets verify; hashes, records, publish_rules and events match")

    used = bytearray(128)

    def take_leaf(msg_):
        q_ = next_free_leaf(bytes(used), int.from_bytes(H(b"phalanx/pq/identity/leaf", I, msg_)[:2], "big") % 1024)
        used[q_ >> 3] |= 1 << (q_ & 7)
        return q_

    a = v["attestation"]
    rh = rule_hashes[0]
    assert a["rulesHash"] == rh.hex()
    msg = (b"PHX-ATTEST-V3" + program + launch + params_hash + creator + mh + rh
           + struct.pack("<qq", a["notBefore"], a["notAfter"]))
    assert len(msg) == 221 and (a["message"], a["messageHash"]) == (msg.hex(), H(msg).hex())
    q = take_leaf(msg)
    sig = lms_sign(6, 3, I, seed, T, q, msg, randomizer(seed, I, q, msg))
    assert (a["q"], a["signature"]) == (q, sig.hex()) and strict_verify(pk, msg, sig) == q
    identity_address, identity_bump = find_program_address([b"identity", identity_id], program)
    attestation_address, attestation_bump = find_program_address([b"attestation", launch], program)
    rules_address = find_program_address([b"rules", launch, rh], program)[0]
    al = a["attestLaunch"]
    assert al["data"] == (discriminator("global", "attest_launch") + pk + lv(sig) + mh + rh
                          + struct.pack("<qq", a["notBefore"], a["notAfter"])).hex()
    assert [(b58decode(m_["pubkey"]), m_["isSigner"], m_["isWritable"]) for m_ in al["accounts"]] == [
        (payer, True, True), (launch, False, False), (identity_address, False, True),
        (attestation_address, False, True), (tm_address, False, False), (system, False, False),
        (rules_address, False, False),
    ]
    slot, lands_at = ln["slot"], ln["landsAt"]
    att = (discriminator("account", "Attestation") + bytes([3, attestation_bump]) + launch + identity_id
           + struct.pack("<H", q) + mh + rh + H(msg) + struct.pack("<Qqq", slot, a["notBefore"], a["notAfter"]) + lv(sig))
    assert len(att) == 2708 and a["accountData"] == att.hex() and b58decode(a["address"]) == attestation_address
    assert a["launchAttested"] == (launch + identity_id + struct.pack("<H", q) + mh + rh
                                   + struct.pack("<Qqq", slot, a["notBefore"], a["notAfter"])).hex()
    print("attestation v3 binding the rules: message, leaf, signature, data, accounts, account bytes and event match")

    au = v["authorizations"]
    autopilot = find_program_address([b"autopilot", launch], autopilot_program)[0]
    assert autopilot == b58decode(au["autopilot"])
    graph, operator = x(au["graphHash"]), b58decode(au["operator"])
    activation = H(b"PHX-GRAPH-ACT-V1", autopilot, graph, struct.pack("<q", au["activateAt"]))
    # Payload v3 of a revocation names the authorization that activated the graph (audit 4, A4-3).
    active_auth = find_program_address([b"auth", launch, bytes([1]), activation], program)[0]
    assert b58decode(au["activeAuth"]) == active_auth
    payloads = {
        1: activation,
        2: H(b"PHX-GRAPH-FRZ-V2", autopilot, graph, struct.pack("<q", au["freezeNotAfter"])),
        3: H(b"PHX-OP-REVOKE-V3", autopilot, graph, operator, active_auth),
    }
    for case in au["cases"]:
        kind = case["kind"]
        payload = payloads[kind]
        assert case["payloadHash"] == payload.hex(), case["name"]
        m = b"PHX-AUTH-V1" + program + launch + creator + bytes([kind]) + payload
        assert len(m) == 140 and (case["message"], case["messageHash"]) == (m.hex(), H(m).hex())
        q = take_leaf(m)
        sig = lms_sign(6, 3, I, seed, T, q, m, randomizer(seed, I, q, m))
        assert (case["q"], case["signature"]) == (q, sig.hex()) and strict_verify(pk, m, sig) == q
        address, bump = find_program_address([b"auth", launch, bytes([kind]), payload], program)
        assert (b58decode(case["address"]), case["bump"]) == (address, bump)
        pa = case["pqAuthorize"]
        assert pa["data"] == (discriminator("global", "pq_authorize") + pk + lv(sig) + bytes([kind]) + payload).hex()
        assert [(b58decode(m_["pubkey"]), m_["isSigner"], m_["isWritable"]) for m_ in pa["accounts"]] == [
            (payer, True, True), (launch, False, False), (identity_address, False, True),
            (address, False, True), (system, False, False),
        ]
        data = (discriminator("account", "Authorization") + bytes([1, bump]) + launch + identity_id + bytes([kind])
                + payload + H(m) + struct.pack("<qQH", lands_at, slot, q) + lv(sig))
        assert len(data) == 2669 and case["accountData"] == data.hex(), case["name"]
        assert case["authorized"] == (launch + address + identity_id + bytes([kind]) + payload
                                      + struct.pack("<Hqq", q, lands_at, slot)).hex(), case["name"]
    ident = v["identity"]
    assert b58decode(ident["address"]) == identity_address
    assert ident["data"] == (discriminator("account", "Identity") + bytes([1, identity_bump]) + pk + bytes(used)
                             + struct.pack("<H", popcount(bytes(used)))).hex()
    assert popcount(bytes(used)) == 1 + len(au["cases"])
    print(f"authorizations: {len(au['cases'])} kinds: payloads, messages, leaves, signatures, data, accounts, account bytes and events match")
    print("programmable.json: every checked value matches the independent implementation")


def extract(rfc_txt, out):
    text = open(rfc_txt, encoding="ascii").read()
    body = text[text.index("Appendix F.  Test Cases\n\n   This section") :]
    body = body[: body.find("Acknowledgements")] if "Acknowledgements" in body else body
    lines = [l for l in body.splitlines() if not l.startswith("McGrew, et al.") and not l.startswith("RFC 8554 ")]
    secs, title = {}, None
    for l in lines:
        m = re.match(r"^   (Test Case [12] (Public Key|Message|Signature|Private Key))\s*$", l)
        if m:
            title = m.group(1)
            secs[title] = []
        elif title:
            secs[title].append(l)

    def values(sec, message=False):
        out, label = [], None
        for l in sec:
            s = re.sub(r"\s+#.*$", "", re.sub(r"\s+\|.*\|\s*$", "", l.rstrip()))
            toks = s.split()
            if not toks or set(s.strip()) == {"-"}:
                continue
            tok = toks[-1]
            if re.match(r"^[0-9a-f]+$", tok) and len(tok) % 2 == 0 and (message or len(tok) % 8 == 0):
                label = " ".join(toks[:-1]) or label
                out.append((label, tok))
        return out

    result = {
        "source": "RFC 8554 Appendix F, Test Cases 1 and 2: every value of each public key, message and HSS "
        "signature concatenated in order, as the appendix specifies (parsed from the RFC text). "
        "HSS public key = u32str(L) || LMS public key; HSS signature = u32str(Nspk) || sig[0] || pub[1] || sig[1].",
    }
    for n in (1, 2):
        tc = {
            "hss_public_key": "".join(t for _, t in values(secs[f"Test Case {n} Public Key"])),
            "message": "".join(t for _, t in values(secs[f"Test Case {n} Message"], message=True)),
            "hss_signature": "".join(t for _, t in values(secs[f"Test Case {n} Signature"])),
        }
        if f"Test Case {n} Private Key" in secs:
            seeds, ids, prev = [], [], None
            for label, tok in values(secs[f"Test Case {n} Private Key"]):
                if label == "SEED":
                    if prev == "SEED" and len(seeds[-1]) < 64:
                        seeds[-1] += tok
                    else:
                        seeds.append(tok)
                elif label == "I":
                    ids.append(tok)
                prev = label
            tc["top_level_seed"], tc["second_level_seed"] = seeds
            tc["top_level_i"], tc["second_level_i"] = ids
        result[f"test_case_{n}"] = tc
    with open(out, "w", encoding="ascii", newline="\n") as f:
        json.dump(result, f, indent=2)
        f.write("\n")
    check_appendix_f(out)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "appendix-f":
        check_appendix_f(sys.argv[2])
    elif cmd == "vectors":
        print_vectors(sys.argv[2])
    elif cmd == "extract":
        extract(sys.argv[2], sys.argv[3])
    elif cmd == "attest-vectors":
        check_attest_vectors(sys.argv[2])
    elif cmd == "metadata-vectors":
        check_metadata_vectors(sys.argv[2])
    elif cmd == "programmable-vectors":
        check_programmable_vectors(sys.argv[2])
    else:
        raise SystemExit(__doc__)
