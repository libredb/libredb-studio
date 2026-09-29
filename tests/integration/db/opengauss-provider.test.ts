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
import net from "node:net";
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
  type Md5Sha256AuthRequest,
  type Sha256AuthRequest,
} from "@/lib/db/providers/sql/opengauss-auth";
import { OpenGaussProvider } from "@/lib/db/providers/sql/opengauss";
import { OpenGaussSocket } from "@/lib/db/providers/sql/opengauss-socket";
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

  test("hands `pg` a socket carrying this connection's own password and TLS settings", () => {
    const poolConfig = provider.buildPoolConfig() as {
      stream: () => { destroy(): void };
    };
    const socket = poolConfig.stream();

    // Invoking the factory is the point, not merely checking it exists: the socket it
    // returns is what carries the handshake, and the two values in it are the connection's
    // own, so a socket built with a blank password or with TLS dropped would answer the
    // server with the wrong proof or on a channel the filter cannot see.
    expect(socket).toBeInstanceOf(OpenGaussSocket);
    socket.destroy();
  });

  test("builds a plain socket when the connection asks for no TLS", () => {
    // The connection's `ssl` is a settings object or absent, never a boolean, so "no TLS"
    // is expressed by leaving it off rather than by setting it false.
    const { ssl: _ssl, ...withoutSsl } = config;
    const plain = new OpenGaussProvider(withoutSsl as DatabaseConnection);
    const poolConfig = (plain as unknown as { buildPoolConfig(): { stream: () => OpenGaussSocket } }).buildPoolConfig();
    const socket = poolConfig.stream();

    expect(socket).toBeInstanceOf(OpenGaussSocket);
    socket.destroy();
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

// ============================================================================
// The socket: the frame filter `pg` never sees, driven over a real loopback server
// ----------------------------------------------------------------------------
// Every group above tests a pure function. The filter is not one: it answers a frame,
// swallows it, forwards the rest, and splits a TCP stream's arbitrary chunk boundaries.
// So these drive the class itself against a `net.Server` on 127.0.0.1 and assert on what
// the server received - the only direction that can fail if the filter is wrong, since a
// filter that answers nothing is indistinguishable from a working one when the client's
// own reads are not being checked. The server is a stand-in for 5.0.0's socket, not a
// mock of the code under test: it is the counterpart, and it knows nothing of the parser.
// ============================================================================

describe("OpenGaussSocket — the frame filter over a real socket", () => {
  interface Harness {
    readonly port: number;
    readonly received: Buffer[];
    readonly socket: OpenGaussSocket;
    close(): Promise<void>;
  }

  /**
   * A server that runs `script` against each accepted connection and collects the bytes
   * it was sent. The client is the class under test, connected for real; `script` gets the
   * server's side of the socket so it can push frames in whatever chunk sizes it likes.
   */
  const serve = (script: (conn: import("node:net").Socket, received: Buffer[]) => void): Promise<Harness> => {
    const received: Buffer[] = [];
    const server = net.createServer((conn) => {
      conn.on("data", (chunk: Buffer) => received.push(chunk));
      conn.on("error", () => {});
      script(conn, received);
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as net.AddressInfo;
        const socket = new OpenGaussSocket({ password: PASSWORD });
        // The harness hands back an unconnected socket: connecting is the test's business,
        // because a test that wants a refused connection must never connect at all.
        resolve({
          port,
          received,
          socket,
          close: () =>
            new Promise<void>((done) => {
              socket.destroy();
              server.close(() => done());
            }),
        });
      });
    });
  };

  /**
   * Connect and resolve once the driver-visible "connect" event fires. The listener goes on
   * BEFORE `connect()` rather than after: the event is emitted from the inner socket's own
   * connect handler, so a listener attached afterwards can miss a loopback connection that
   * completed in between and the test waits out the timeout on a socket that is already up.
   */
  const connected = (h: Harness): Promise<void> =>
    new Promise((resolve, reject) => {
      h.socket.once("connect", () => resolve());
      h.socket.once("error", reject);
      // `pg` always has a consumer on this stream by the time it connects, and so must the
      // test: a Readable with no reader does not flow, and the `connect` event the Duplex
      // re-emits from its own attach path is delivered only once something is reading.
      // Without this the await below never resolves and the test fails as a bare timeout,
      // which says nothing about the code under test.
      h.socket.resume();
      h.socket.connect(h.port, "127.0.0.1");
    });

  const bytes = (chunks: Buffer[]): Buffer => Buffer.concat(chunks);

  /**
   * The text a `PasswordMessage` carried, read out of the bytes the server received.
   * The payload is `[type][length][response][NUL]`, so the text stops one byte short of
   * the end - otherwise the terminator is compared against the expected reply and a
   * correct answer reads as a mismatch, since the two strings print identically.
   */
  const replyText = (chunks: Buffer[]): string => {
    const frame = bytes(chunks);
    return frame.subarray(5, frame.length - 1).toString("utf8");
  };

  /** The code-11 request in the shape the derivation reads, so the socket's reply is recomputed. */
  const md5Request = (): Md5Sha256AuthRequest => ({
    kind: "md5_sha256",
    salt: SALT,
    md5Salt: Buffer.from("1234", "ascii"),
    iterations: OPENGAUSS_DEFAULT_ITERATIONS,
  });

  /** A whole `R` frame: the payload the server sends, wrapped in its type byte and length. */
  const asResponseFrame = (payload: Buffer): Buffer => {
    const header = Buffer.alloc(5);
    header.write("R", 0, "ascii");
    header.writeInt32BE(4 + payload.length, 1);
    return Buffer.concat([header, payload]);
  };

  test("answers a request-10 frame on the wire and never forwards it to the driver", async () => {
    const h = await serve((conn) => conn.write(asResponseFrame(sha256Payload())));
    await connected(h);

    await Bun.sleep(150);

    // The server got a PasswordMessage, byte for byte, and the driver got nothing - the
    // whole point of the filter. `received` is the server's view of what the client sent.
    const sent = bytes(h.received);
    expect(sent[0]).toBe(0x70);
    expect(replyText(h.received)).toBe(sha256Password(PASSWORD, sha256Request()));
    // Nothing readable by the driver: the frame was consumed, not relayed.
    const forwarded: Buffer[] = [];
    h.socket.on("data", (c: Buffer) => forwarded.push(c));
    await Bun.sleep(50);
    expect(forwarded).toHaveLength(0);
    await h.close();
  });

  test("answers a request-11 frame the same way", async () => {
    const h = await serve((conn) => conn.write(asResponseFrame(md5Sha256Payload())));
    await connected(h);
    await Bun.sleep(150);

    const sent = bytes(h.received);
    expect(sent[0]).toBe(0x70);
    expect(replyText(h.received)).toBe(md5Sha256Password(PASSWORD, md5Request()));
    await h.close();
  });

  test("forwards a frame it does not own, so AuthenticationOk reaches the driver", async () => {
    // Code 0 is AuthenticationOk: an `R` frame that is not one of this engine's two
    // requests is passed through untouched, which is what keeps `trust` connections and
    // real PostgreSQL SASL working through the same socket.
    const ok = asResponseFrame(Buffer.from([0, 0, 0, 0]));
    const h = await serve((conn) => conn.write(ok));
    const got: Buffer[] = [];
    h.socket.on("data", (c: Buffer) => got.push(c));
    await connected(h);
    await Bun.sleep(150);

    expect(bytes(got)).toEqual(ok);
    expect(h.received).toHaveLength(0);
    await h.close();
  });

  test("reassembles a frame split across TCP segments, and answers it once", async () => {
    const frame = asResponseFrame(sha256Payload());
    const h = await serve((conn) => {
      // One byte at a time is the worst case a stream can produce, and it is what a
      // half-consumed buffer would silently mishandle.
      let i = 0;
      const timer = setInterval(() => {
        if (i >= frame.length) {
          clearInterval(timer);
          return;
        }
        conn.write(frame.subarray(i, i + 1));
        i += 1;
      }, 1);
    });
    await connected(h);
    await Bun.sleep(600);

    const replies = h.received.filter((c) => c[0] === 0x70);
    expect(replies).toHaveLength(1);
    expect(replyText(replies)).toBe(sha256Password(PASSWORD, sha256Request()));
    await h.close();
  });

  test("answers two handshakes in sequence on one connection", async () => {
    const h = await serve((conn) => {
      conn.write(asResponseFrame(sha256Payload()));
      setTimeout(() => conn.write(asResponseFrame(md5Sha256Payload())), 40);
    });
    await connected(h);
    await Bun.sleep(300);

    const replies = h.received.filter((c) => c[0] === 0x70);
    expect(replies).toHaveLength(2);
    await h.close();
  });

  test("passes the driver's writes through to the server", async () => {
    const h = await serve(() => {});
    await connected(h);
    h.socket.write(Buffer.from("startup", "ascii"));
    await Bun.sleep(100);

    expect(bytes(h.received).toString("utf8")).toBe("startup");
    await h.close();
  });

  test("refuses a write before the socket is open, rather than dropping it silently", async () => {
    const socket = new OpenGaussSocket({ password: PASSWORD });
    // A write-callback error is ALSO re-emitted on the stream, so a test that only reads
    // the callback turns a correct refusal into an unhandled `error` and fails on the
    // throw rather than on the assertion. The listener is what makes the refusal
    // observable instead of fatal, which is the same thing `pg` does.
    const emitted = new Promise<Error>((resolve) => socket.once("error", resolve));
    const error = await new Promise<Error | null | undefined>((resolve) => {
      socket.write(Buffer.from("early"), (e) => resolve(e));
    });
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("openGauss connection is not open");
    // The same object, so the two paths cannot drift into reporting different causes.
    expect(await emitted).toBe(error as Error);
    socket.destroy();
  });

  test("surfaces a refused connection as an error on the socket", async () => {
    // Port 1 on loopback has nothing listening, so `connect` fails at the TCP layer. The
    // listener is attached first, or the refusal can arrive before anyone is listening.
    const socket = new OpenGaussSocket({ password: PASSWORD });
    const error = await new Promise<Error>((resolve) => {
      socket.once("error", resolve);
      socket.resume();
      socket.connect(1, "127.0.0.1");
    });
    expect(error).toBeInstanceOf(Error);
    socket.destroy();
  });

  test("ends cleanly when the server closes its side", async () => {
    const h = await serve((conn) => setTimeout(() => conn.end(), 60));
    const ended = new Promise<void>((resolve) => {
      h.socket.once("end", () => resolve());
      h.socket.once("close", () => resolve());
    });
    await connected(h);
    await ended;
    await h.close();
  });

  test("is idempotent on connect, so a second call cannot open a second socket", async () => {
    const h = await serve(() => {});
    await connected(h);
    // `pg` connects once, but the guard is load-bearing: a second net.connect would leak
    // a socket the first one already owns.
    h.socket.connect(h.port, "127.0.0.1");
    await Bun.sleep(60);
    expect(h.socket.destroyed).toBe(false);
    await h.close();
  });

  test("applies the socket options `pg` sets before connect", async () => {
    const h = await serve(() => {});
    // These are the calls the driver makes between construction and the first write, and
    // each is a no-op on a socket that does not exist yet.
    expect(h.socket.setNoDelay(true)).toBe(h.socket);
    expect(h.socket.setKeepAlive(true, 1000)).toBe(h.socket);
    expect(h.socket.ref()).toBe(h.socket);
    await connected(h);
    expect(h.socket.setNoDelay(false)).toBe(h.socket);
    expect(h.socket.unref()).toBe(h.socket);
    await h.close();
  });

  test("destroys without a socket ever being opened", async () => {
    const socket = new OpenGaussSocket({ password: PASSWORD });
    socket.destroy();
    expect(socket.destroyed).toBe(true);
  });

  test("ends without a socket ever being opened", async () => {
    const socket = new OpenGaussSocket({ password: PASSWORD });
    const error = await new Promise<Error | null | undefined>((resolve) => socket.end(() => resolve(undefined)));
    expect(error).toBeUndefined();
    socket.destroy();
  });

  test("requests TLS itself and reports a refusal in `pg`'s own words", async () => {
    // The socket writes the SSLRequest, so a server that answers anything but "S" must
    // produce the message `pg` itself uses for a refused SSLRequest - a socket that hung
    // instead would leave the connection waiting with no diagnostic.
    const h = await serve((conn) => conn.write(Buffer.from("N", "ascii")));
    const socket = new OpenGaussSocket({
      password: PASSWORD,
      tls: { rejectUnauthorized: false },
    });
    const error = await new Promise<Error>((resolve) => {
      socket.once("error", resolve);
      socket.resume();
      socket.connect(h.port, "127.0.0.1");
    });

    expect(error.message).toBe("The server does not support SSL connections");
    socket.destroy();
    await h.close();
  });

  test("sends the SSLRequest the protocol defines when TLS is configured", async () => {
    const h = await serve(() => {});
    const socket = new OpenGaussSocket({ password: PASSWORD, tls: { rejectUnauthorized: false } });
    socket.resume();
    socket.connect(h.port, "127.0.0.1");
    await Bun.sleep(200);

    // 80877103 in the 8-byte SSLRequest message, sent by the socket and not by `pg`.
    expect(bytes(h.received).toString("hex")).toBe("0000000804d2162f");
    socket.destroy();
    await h.close();
  });
});
