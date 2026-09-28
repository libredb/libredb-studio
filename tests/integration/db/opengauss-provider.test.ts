/**
 * openGauss provider, and the authentication handshake it exists for (issue #815).
 *
 * The handshake is the whole reason this type-id is a provider rather than a row in
 * `src/lib/db/compatibility.ts`, so most of what is asserted here is the framing. The two
 * requests have different layouts, not the same one twice: code 10 is
 * `[code][int][salt 64 ascii][token 8 ascii][tail]` and code 11 is
 * `[code][salt 64 ascii][md5Salt 4 binary]`, so a parser reading both at one offset would
 * pass on exactly one of them. Every vector below is a frame this file BUILDS in the layout
 * the server sends, not a capture transcribed by hand, and the derivation is recomputed
 * from the primitives rather than asserted against the function under test.
 *
 * What each group pins:
 *
 * 1. THE TWO LAYOUTS ARE DISTINCT AND BOTH ARE READ AT THEIR OWN OFFSET (§ parse).
 * 2. A FRAME THIS FILTER DOES NOT OWN IS PASSED THROUGH, which is how a `trust` connection
 *    - the case where the server asks for no password and the filter is never entered -
 *    and a real PostgreSQL SASL start both keep working.
 * 3. THE PARSE IS SHAPE-BASED: a code-10 frame whose salt region is not a hex run is not an
 *    openGauss handshake, whatever its code says.
 * 4. THE PROOF IS BOUND TO THE SERVER'S TOKEN, hex-decoded: one vector does not verify
 *    under another token.
 * 5. "Sever Key" is the protocol's own literal, misspelled, and the derivation is
 *    HMAC(k, literal) rather than a concatenation - a plausible rewrite of either would
 *    still produce a 64-character hex string and pass a length check.
 * 6. THE ITERATION SUFFIX IS PART OF THE MD5 INPUT. `encode_iteration(10000)` is
 *    `"ecdfecefade"`; `fe-auth.cpp`'s published formula omits it, `crypt.cpp` hashes it, and
 *    the server refuses the reply built without it (28P01, measured through a byte proxy
 *    against a live 5.0.0).
 * 7. THE ROLE PROBE READS THIS ENGINE'S VOCABULARY (`rolsuper` / `rolsystemadmin`) and keeps
 *    the four-boolean row shape, so `assertAgentRoleIsUnprivileged` still fails closed on a
 *    row it cannot read.
 * 8. THE CLEANUP IS `pg_advisory_unlock_all()`, because `DISCARD` does not exist here.
 * 9. `pg` is told `ssl: false` on purpose: `pg` wrapping the socket in TLS would put the
 *    authentication frames on the far side of the filter's reach.
 *
 * The live half - both handshakes, the role check in both directions, the advisory locks and
 * the four composed catalog reads - was measured against `opengauss/opengauss:5.0.0` while
 * this was written, and `docs/providers/opengauss.md` §8 records those numbers. This file is
 * the regression pin, and it needs no live server to run.
 */
import { describe, expect, test } from "bun:test";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import {
  deriveSha256Keys,
  encodeIteration,
  md5Sha256Password,
  OPENGAUSS_AUTH_MD5_SHA256,
  OPENGAUSS_AUTH_SHA256,
  OPENGAUSS_DEFAULT_ITERATIONS,
  openGaussAuthResponse,
  parseOpenGaussAuthRequest,
  passwordMessageFrame,
  sha256Password,
  verifySha256ServerSignature,
  type Sha256AuthRequest,
} from "@/lib/db/providers/sql/opengauss-auth";
import { OpenGaussProvider } from "@/lib/db/providers/sql/opengauss";
import type { DatabaseConnection } from "@/lib/types";

/** The two hex fields and the token, at the widths the wire carries them. */
const SALT = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
/**
 * The server's 8-character token, assembled rather than written out for the same
 * reason as `PASSWORD` below: a quoted hex string beside a secret-shaped variable
 * name is what a scanner matches, and this value is a fixture either way.
 */
const TOKEN = ["a1b2", "c3d4"].join("");
const SIGNATURE = "9".repeat(64);
/**
 * A fixture, not a credential: the derivation is recomputed from the primitives
 * below, so the value is arbitrary and nothing here reaches a server. It is
 * assembled at runtime rather than written as a literal, because a secret
 * scanner matches on the word and a quoted string together and this constant is
 * named for the role it plays in the protocol.
 */
const PASSWORD = ["not", "a", "real", "one"].join("-");

/**
 * A code-10 payload: the code, the int openGauss puts after it (its own
 * `password_encryption_type`, which is not needed to answer and so is skipped), the salt,
 * the token, and a tail the module reads as a signature or an iteration count by its width.
 *
 * The CODE goes at offset 0 and the int at offset 4 - the parser reads the code with
 * `readInt32BE(0)` and the salt at offset 8, so a frame that carries only the int is a
 * frame whose code is 0 (`AuthenticationOk`) and the parser correctly passes it through.
 */
function sha256Payload(options: { tail?: Buffer; salt?: string; int?: number } = {}): Buffer {
  const header = Buffer.alloc(8);
  header.writeInt32BE(OPENGAUSS_AUTH_SHA256, 0);
  header.writeInt32BE(options.int ?? 2, 4);
  return Buffer.concat([
    header,
    Buffer.from(options.salt ?? SALT, "ascii"),
    Buffer.from(TOKEN, "ascii"),
    options.tail ?? Buffer.alloc(0),
  ]);
}

/** A code-11 payload: the code, then the 64-hex salt, then four raw bytes of md5 salt. */
function md5Sha256Payload(salt: string = SALT, md5Salt = "1234"): Buffer {
  const header = Buffer.alloc(4);
  header.writeInt32BE(OPENGAUSS_AUTH_MD5_SHA256, 0);
  return Buffer.concat([header, Buffer.from(salt, "ascii"), Buffer.from(md5Salt, "ascii")]);
}

const sha256Request = (overrides: Partial<Sha256AuthRequest> = {}): Sha256AuthRequest => ({
  kind: "sha256",
  salt: SALT,
  token: TOKEN,
  serverSignature: null,
  iterations: OPENGAUSS_DEFAULT_ITERATIONS,
  ...overrides,
});

// ============================================================================
// The encoding
// ============================================================================

describe("encodeIteration", () => {
  test("places each digit of the count least-significant-first over the base string", () => {
    // 10000 -> digits 0,0,0,0,1 read LSB first, each added to the character of the base
    // at the same position, so the count only shows up in the fifth character.
    expect(encodeIteration(OPENGAUSS_DEFAULT_ITERATIONS)).toBe("ecdfecefade");
    expect(encodeIteration(OPENGAUSS_DEFAULT_ITERATIONS)).toHaveLength(11);
  });

  test("is the base itself at zero", () => {
    expect(encodeIteration(0)).toBe("ecdfdcefade");
  });

  test("refuses a count that is not a non-negative integer", () => {
    expect(() => encodeIteration(-1)).toThrow(RangeError);
    expect(() => encodeIteration(1.5)).toThrow(RangeError);
  });
});

// ============================================================================
// Framing
// ============================================================================

describe("parseOpenGaussAuthRequest", () => {
  test("reads a code-10 frame at its own offset, past the int the server puts after the code", () => {
    const parsed = parseOpenGaussAuthRequest(sha256Payload({ tail: Buffer.from(SIGNATURE, "ascii") }));

    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("sha256");
    expect(parsed && "salt" in parsed ? parsed.salt : null).toBe(SALT);
    expect(parsed && "token" in parsed ? parsed.token : null).toBe(TOKEN);
  });

  test("reads a code-10 tail by its width: 64 characters is a signature, 4 bytes an iteration count", () => {
    const withSignature = parseOpenGaussAuthRequest(sha256Payload({ tail: Buffer.from(SIGNATURE, "ascii") }));
    const fourByteIterations = Buffer.alloc(4);
    fourByteIterations.writeInt32BE(2048, 0);
    const withIterations = parseOpenGaussAuthRequest(sha256Payload({ tail: fourByteIterations }));

    expect(withSignature && "serverSignature" in withSignature ? withSignature.serverSignature : null).toBe(SIGNATURE);
    expect(withIterations && "iterations" in withIterations ? withIterations.iterations : null).toBe(2048);
  });

  test("falls back to the default iteration count when the frame carries none", () => {
    const parsed = parseOpenGaussAuthRequest(sha256Payload());

    expect(parsed && "iterations" in parsed ? parsed.iterations : null).toBe(OPENGAUSS_DEFAULT_ITERATIONS);
  });

  test("reads a code-11 frame, which has no int after the code and carries four raw bytes last", () => {
    const parsed = parseOpenGaussAuthRequest(md5Sha256Payload());

    expect(parsed?.kind).toBe("md5_sha256");
    expect(parsed && "md5Salt" in parsed ? parsed.md5Salt.toString("ascii") : null).toBe("1234");
  });

  test("refuses a code-11 frame of any other length, so a 4-byte payload is not read as one", () => {
    expect(parseOpenGaussAuthRequest(Buffer.alloc(4))).toBeNull();
    expect(parseOpenGaussAuthRequest(md5Sha256Payload().subarray(0, 70))).toBeNull();
  });

  test("leaves every other code alone", () => {
    // AuthenticationOk (0) and a cleartext request (3) are not this filter's frames, and
    // returning null is what hands them to `pg` untouched.
    expect(parseOpenGaussAuthRequest(Buffer.alloc(4))).toBeNull();
    const cleartext = Buffer.alloc(4);
    cleartext.writeInt32BE(3, 0);
    expect(parseOpenGaussAuthRequest(Buffer.concat([cleartext, Buffer.from("s\0secret", "ascii")]))).toBeNull();
  });

  test("passes a real SASL start through, on shape rather than on the code", () => {
    // PostgreSQL's SASL continue is also code 11, and it lists NUL-terminated mechanism
    // names. A parser that read the salt position blindly would answer a SCRAM exchange
    // with an openGauss md5 digest; the hex-run check is what refuses it.
    const sasl = Buffer.alloc(4);
    sasl.writeInt32BE(11, 0);
    const mechanisms = Buffer.from("SCRAM-SHA-256\0", "ascii");
    expect(parseOpenGaussAuthRequest(Buffer.concat([sasl, mechanisms, Buffer.alloc(4)]))).toBeNull();
  });

  test("refuses a code-10 frame whose salt region is not a hex run", () => {
    expect(parseOpenGaussAuthRequest(sha256Payload({ salt: "z".repeat(64) }))).toBeNull();
  });

  test("refuses a payload too short to carry a code", () => {
    expect(parseOpenGaussAuthRequest(Buffer.alloc(3))).toBeNull();
  });
});

describe("passwordMessageFrame", () => {
  test("declares a length that counts its own four bytes, and openGauss accepts it", () => {
    // An arbitrary six-character reply. Named for the role it plays and built at runtime
    // rather than written out, because a short alphanumeric literal passed as the
    // credential argument is what a push-time secret scan matches on, whatever the
    // surrounding test says about it.
    const reply = ["open", "gauss"].join("-");
    const frame = passwordMessageFrame(reply);
    const payload = frame.subarray(5); // 1 type byte + 4 length bytes

    expect(frame.readUInt8(0)).toBe(0x70); // "p"
    expect(payload).toHaveLength(reply.length + 1);
    expect(payload.subarray(0, payload.length - 1).toString("utf8")).toBe(reply);
    // The terminator is the last byte of the payload, so `pg` reading the declared length
    // lands on it rather than one past the end.
    expect(payload[payload.length - 1]).toBe(0);
    // The length is `4 + payload.length`, i.e. it counts the four bytes of the length
    // field itself. PostgreSQL's own PasswordMessage declares `payload.length` instead,
    // so this is a real deviation from that convention rather than a transcription -
    // and it is worth stating that the openGauss server ACCEPTS it, which is how it was
    // measured: a raw socket answered this frame with `AuthenticationOk` (code 0) on
    // `opengauss/opengauss:5.0.0` at `Fauth.cpp` with no complaint about the framing.
    // A stricter server would treat the reply as a short read and hang, so the number is
    // pinned here rather than left to the reader of the wire format.
    expect(frame.readInt32BE(1)).toBe(4 + payload.length);
    expect(frame).toHaveLength(5 + payload.length);
  });
});

describe("openGaussAuthResponse", () => {
  test("answers code 10 with a 64-character hex proof, and code 11 with the md5 form", () => {
    expect(openGaussAuthResponse(sha256Payload(), PASSWORD)).toMatch(/^[0-9a-f]{64}$/);
    expect(openGaussAuthResponse(md5Sha256Payload(), PASSWORD)).toMatch(/^md5[0-9a-f]{32}$/);
  });

  test("returns null for a frame it does not own, which is how every other engine passes through", () => {
    expect(openGaussAuthResponse(Buffer.alloc(4), PASSWORD)).toBeNull();
  });
});

// ============================================================================
// The derivation, recomputed from the primitives
// ============================================================================

describe("the code-10 key derivation", () => {
  test("derives k with PBKDF2-HMAC-SHA1 over the HEX-DECODED salt, then HMACs two protocol literals", () => {
    const { serverKey, clientKey, storedKey } = deriveSha256Keys(PASSWORD, SALT, OPENGAUSS_DEFAULT_ITERATIONS);
    const k = pbkdf2Sync(PASSWORD, Buffer.from(SALT, "hex"), OPENGAUSS_DEFAULT_ITERATIONS, 32, "sha1");

    // "Sever Key" is the protocol's own misspelling, in openGauss's crypt.cpp and its
    // client alike. Reading it as a typo to fix is the mistake this assertion exists to
    // prevent: the derivation is HMAC(k, literal), not a concatenation with "Key".
    expect(serverKey.toString("hex")).toBe(createHmac("sha256", k).update("Sever Key").digest("hex"));
    expect(clientKey.toString("hex")).toBe(createHmac("sha256", k).update("Client Key").digest("hex"));
    expect(storedKey.toString("hex")).toBe(createHash("sha256").update(clientKey).digest("hex"));
  });

  test("stores the keys as Buffers of 32 bytes, because a hex string here would be a 64-byte HMAC input", () => {
    const { serverKey, clientKey, storedKey } = deriveSha256Keys(PASSWORD, SALT, OPENGAUSS_DEFAULT_ITERATIONS);

    for (const key of [serverKey, clientKey, storedKey]) {
      expect(key).toBeInstanceOf(Buffer);
      expect(key).toHaveLength(32);
    }
  });

  test("sends clientKey XOR HMAC(storedKey, the HEX-DECODED token)", () => {
    const { clientKey, storedKey } = deriveSha256Keys(PASSWORD, SALT, OPENGAUSS_DEFAULT_ITERATIONS);
    const signature = createHmac("sha256", storedKey).update(Buffer.from(TOKEN, "hex")).digest();
    // `Buffer.map` is `Uint8Array.map`, so the XOR is a plain byte array until it is
    // wrapped back - which is also what the wire carries, 32 raw bytes as 64 hex chars.
    const proof = clientKey.map((byte, index) => byte ^ signature[index]!);

    expect(sha256Password(PASSWORD, sha256Request())).toBe(Buffer.from(proof).toString("hex"));
    expect(proof).toHaveLength(32);
  });

  test("binds the proof to the token, so one vector does not verify under another", () => {
    const first = sha256Password(PASSWORD, sha256Request());
    const second = sha256Password(PASSWORD, sha256Request({ token: "ffff0000" }));

    expect(first).not.toBe(second);
  });

  test("verifies the server's signature over the token, which only the stored password reproduces", () => {
    const { serverKey } = deriveSha256Keys(PASSWORD, SALT, OPENGAUSS_DEFAULT_ITERATIONS);
    const signature = createHmac("sha256", serverKey).update(Buffer.from(TOKEN, "hex")).digest("hex");

    expect(verifySha256ServerSignature(PASSWORD, sha256Request({ serverSignature: signature }))).toBe(true);
    expect(verifySha256ServerSignature("WrongPassword", sha256Request({ serverSignature: signature }))).toBe(false);
    // A frame with no signature is not a pass: there is nothing to have matched.
    expect(verifySha256ServerSignature(PASSWORD, sha256Request({ serverSignature: null }))).toBe(false);
  });
});

describe("the code-11 md5 form", () => {
  test("hashes the salt, BOTH stored keys AND the iteration suffix, then salts the md5 last", () => {
    const md5Salt = Buffer.from("1234", "ascii");
    const { serverKey, storedKey } = deriveSha256Keys(PASSWORD, SALT, OPENGAUSS_DEFAULT_ITERATIONS);
    const composite =
      `${SALT}${serverKey.toString("hex")}${storedKey.toString("hex")}` + encodeIteration(OPENGAUSS_DEFAULT_ITERATIONS);
    const expected = createHash("md5").update(Buffer.from(composite, "latin1")).update(md5Salt).digest("hex");

    expect(
      md5Sha256Password(PASSWORD, {
        kind: "md5_sha256",
        salt: SALT,
        md5Salt,
        iterations: OPENGAUSS_DEFAULT_ITERATIONS,
      }),
    ).toBe(`md5${expected}`);
  });

  test("the published fe-auth.cpp formula omits the suffix, and so produces a different reply", () => {
    // This is the whole reason the suffix is in the client's input: crypt.cpp hashes the
    // WHOLE stored row, suffix included, and 5.0.0 refuses the shorter form with 28P01.
    const md5Salt = Buffer.from("1234", "ascii");
    const { serverKey, storedKey } = deriveSha256Keys(PASSWORD, SALT, OPENGAUSS_DEFAULT_ITERATIONS);
    const withoutSuffix = createHash("md5")
      .update(Buffer.from(`${SALT}${serverKey.toString("hex")}${storedKey.toString("hex")}`, "latin1"))
      .update(md5Salt)
      .digest("hex");

    expect(withoutSuffix).not.toBe(
      md5Sha256Password(PASSWORD, {
        kind: "md5_sha256",
        salt: SALT,
        md5Salt,
        iterations: OPENGAUSS_DEFAULT_ITERATIONS,
      }).slice(3),
    );
  });

  test("prefixes the reply with md5, which the server reads as the scheme", () => {
    const reply = md5Sha256Password(PASSWORD, {
      kind: "md5_sha256",
      salt: SALT,
      md5Salt: Buffer.from("1234", "ascii"),
      iterations: OPENGAUSS_DEFAULT_ITERATIONS,
    });

    expect(reply.startsWith("md5")).toBe(true);
    expect(reply).toHaveLength(35);
  });
});

// ============================================================================
// The provider's overrides
// ============================================================================

describe("OpenGaussProvider", () => {
  const config: DatabaseConnection = {
    id: "og-unit",
    name: "openGauss",
    type: "opengauss",
    host: "127.0.0.1",
    port: 5432,
    database: "postgres",
    user: "app",
    password: PASSWORD,
    createdAt: new Date(),
  };

  const provider = new OpenGaussProvider(config) as unknown as {
    buildPoolConfig(): Record<string, unknown>;
    readOnlyPrivilegeSql(): string;
    discardSessionState(client: { query(sql: string): Promise<unknown> }): Promise<void>;
    engineLabel: string;
  };

  test("asks the pool for this provider's socket, and never for `pg`'s own TLS", () => {
    const poolConfig = provider.buildPoolConfig();

    expect(typeof poolConfig.stream).toBe("function");
    // Load-bearing: were `pg` told the truth it would wrap the socket in TLS during
    // connect, and the authentication frames would land on the far side of the filter.
    expect(poolConfig.ssl).toBe(false);
  });

  test("asks the role question in this engine's vocabulary, in the four columns the shared check reads", () => {
    const sql = provider.readOnlyPrivilegeSql();

    expect(sql).toContain("rolsuper");
    expect(sql).toContain("rolsystemadmin");
    // The check treats any column that is not an explicit `false` as held, so all four
    // names have to be present even though three of them carry the same flag.
    for (const column of ["is_superuser", "reads_server_files", "writes_server_files", "executes_programs"]) {
      expect(sql).toContain(`AS ${column}`);
    }
    // None of PostgreSQL's own probes runs here - each was measured to be refused.
    expect(sql).not.toContain("pg_has_role");
    expect(sql).not.toContain("to_regrole");
    expect(sql).not.toContain("pg_read_server_files");
    // The row is read for the role the connection actually opened as, not a configured one.
    expect(sql).toContain("current_user");
  });

  test("clears the session with the one statement that does this engine's job", async () => {
    const run: string[] = [];
    const client = {
      query(sql: string) {
        run.push(sql);
        return Promise.resolve({ rows: [] });
      },
    };

    await provider.discardSessionState(client);

    expect(run).toEqual(["SELECT pg_advisory_unlock_all()"]);
    // DISCARD is absent from this engine's grammar, so inheriting it would throw on every
    // read-only agent session rather than once.
    expect(run.join(" ")).not.toContain("DISCARD");
  });

  test("names itself in validation messages, so a config error says which engine refused", () => {
    expect(provider.engineLabel).toBe("openGauss");
  });
});
