import { beforeEach, describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import {
  forgetUsedRunConfirmations,
  mintRunConfirmation,
  RUN_CONFIRMATION_TTL_SECONDS,
  type RunConfirmationBinding,
  verifyRunConfirmation,
} from "@/lib/api/run-confirmation-token";
import { sha256Hex } from "@/lib/api/utf16-digest";
import { signJWT } from "@/lib/auth";
import { getJwtSecret } from "@/lib/config/auth-env";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import type { DatabaseConnection } from "@/lib/types";

/** One clock for a whole test: a token is minted and verified at the moment the test names. */
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const at = (ms: number) => () => ms;

function connection(): DatabaseConnection {
  return {
    id: "run-confirmation-1",
    name: "Orders",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    database: "orders",
    user: "app",
    createdAt: new Date(0),
  };
}

function binding(): RunConfirmationBinding {
  return {
    session: { username: "alice", role: "user", iat: 1_700_000_000 },
    connection: connection(),
    catalog: undefined,
    route: "query",
    statement: "DELETE FROM t",
    params: undefined,
    verdict: { decision: "confirm", unreadable: false, typedConfirmation: null, classificationFailed: false },
  };
}

async function minted(from: RunConfirmationBinding = binding()): Promise<string> {
  return (await mintRunConfirmation(from, at(NOW))).token;
}

/** The claims a token carries, read without its key, as anyone holding the token can. */
function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

/** HMAC-SHA-256 of `text` under `key`, lowercase hex. */
async function hmacHex(key: BufferSource, text: string): Promise<string> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const tag = await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(text));
  return Buffer.from(tag).toString("hex");
}

async function refusal(token: string, offered: RunConfirmationBinding, clock = at(NOW)): Promise<string | undefined> {
  const verdict = await verifyRunConfirmation(token, offered, clock);
  return verdict.valid ? undefined : verdict.reason;
}

describe("the run confirmation token (FND-5)", () => {
  beforeEach(() => {
    forgetUsedRunConfirmations();
  });

  test("a token verifies once for the request it was minted for", async () => {
    const issued = await mintRunConfirmation(binding(), at(NOW));
    expect(issued.expiresAt).toBe(Math.floor(NOW / 1000) + RUN_CONFIRMATION_TTL_SECONDS);
    expect(RUN_CONFIRMATION_TTL_SECONDS).toBe(300);
    expect(await verifyRunConfirmation(issued.token, binding(), at(NOW + 1000))).toEqual({ valid: true });
  });

  test("refused for another username", async () => {
    const token = await minted();
    const offered = { ...binding(), session: { ...binding().session, username: "bob" } };
    expect(await refusal(token, offered)).toBe("this confirmation was issued for another session");
  });

  test("refused for another role", async () => {
    const token = await minted();
    const offered: RunConfirmationBinding = { ...binding(), session: { ...binding().session, role: "admin" } };
    expect(await refusal(token, offered)).toBe("this confirmation was issued for another session");
  });

  test("refused for another session issue time", async () => {
    const token = await minted();
    const offered = { ...binding(), session: { ...binding().session, iat: 1_700_000_001 } };
    expect(await refusal(token, offered)).toBe("this confirmation was issued for another session");
  });

  test("refused for a session that carries no issue time, by name rather than bound to a default", async () => {
    const offered = { ...binding(), session: { username: "alice", role: "user" as const } };
    await expect(mintRunConfirmation(offered, at(NOW))).rejects.toThrow(
      "The session carries no issue time, so a run confirmation cannot be bound to it",
    );
  });

  test.each([
    ["host", { host: "db2.internal" }],
    ["database", { database: "billing" }],
    ["user", { user: "admin" }],
    ["connectionString", { connectionString: "postgres://app@db.internal/orders" }],
    [
      "tunnel route",
      { sshTunnel: { enabled: true, host: "bastion", port: 22, username: "ops", authMethod: "password" } },
    ],
  ] as const)("refused for another connection: %s alone", async (_field, change) => {
    const token = await minted();
    const offered = { ...binding(), connection: { ...connection(), ...change } as DatabaseConnection };
    expect(await refusal(token, offered)).toBe("this confirmation was issued for another connection");
  });

  test("the connection's id is not its identity: another id on the same server verifies", async () => {
    const token = await minted();
    const offered = { ...binding(), connection: { ...connection(), id: "typed-by-the-caller" } };
    expect(await refusal(token, offered)).toBeUndefined();
  });

  test("refused for another catalog", async () => {
    const token = await minted({ ...binding(), catalog: "orders" });
    expect(await refusal(token, { ...binding(), catalog: "billing" })).toBe(
      "this confirmation was issued for another connection",
    );
    expect(await refusal(token, binding())).toBe("this confirmation was issued for another connection");
  });

  test("refused for another route", async () => {
    const token = await minted({ ...binding(), route: "transaction" });
    expect(await refusal(token, binding())).toBe("this confirmation was issued for another route");
  });

  test("refused for another statement", async () => {
    const token = await minted();
    expect(await refusal(token, { ...binding(), statement: "DELETE FROM u" })).toBe(
      "this confirmation was issued for another statement",
    );
  });

  test("refused for a lone surrogate swapped", async () => {
    // TextEncoder maps every unpaired surrogate to U+FFFD while JSON on the wire keeps the code unit, so the digest is
    // taken over UTF-16 code units, as the object edit plan's is.
    const token = await minted({ ...binding(), statement: "DELETE FROM t WHERE a = 'A\uD800B'" });
    expect(await refusal(token, { ...binding(), statement: "DELETE FROM t WHERE a = 'A\uDC00B'" })).toBe(
      "this confirmation was issued for another statement",
    );
  });

  test("refused for another bound parameter, its value or its type", async () => {
    const token = await minted({ ...binding(), statement: "DELETE FROM t WHERE id = $1", params: [1] });
    const base = { ...binding(), statement: "DELETE FROM t WHERE id = $1" };
    expect(await refusal(token, { ...base, params: [2] })).toBe("this confirmation was issued for another statement");
    expect(await refusal(token, { ...base, params: ["1"] })).toBe("this confirmation was issued for another statement");
    expect(await refusal(token, { ...base, params: [1, null] })).toBe(
      "this confirmation was issued for another statement",
    );
    expect(await refusal(token, { ...base, params: undefined })).toBe(
      "this confirmation was issued for another statement",
    );
    expect(await refusal(token, { ...base, params: [1] })).toBeUndefined();
  });

  test("refused for another verdict", async () => {
    const token = await minted();
    const confirm = binding().verdict;
    if (confirm.decision !== "confirm") throw new Error("the fixture's verdict asks");
    for (const verdict of [
      { ...confirm, unreadable: true },
      { ...confirm, classificationFailed: true },
      { ...confirm, typedConfirmation: { type: "text" as const, expected: "/App/" } },
      { decision: "run" as const },
    ]) {
      expect(await refusal(token, { ...binding(), verdict })).toBe(
        "this confirmation was issued for another reading of the statement",
      );
    }
    const typed = await minted({
      ...binding(),
      verdict: { ...confirm, typedConfirmation: { type: "connection-name", expected: "Orders", targets: ["a"] } },
    });
    expect(
      await refusal(typed, {
        ...binding(),
        verdict: { ...confirm, typedConfirmation: { type: "connection-name", expected: "Orders", targets: ["b"] } },
      }),
    ).toBe("this confirmation was issued for another reading of the statement");
  });

  test("refused once expired", async () => {
    const token = await minted();
    expect(await refusal(token, binding(), at(NOW + (RUN_CONFIRMATION_TTL_SECONDS + 1) * 1000))).toBe(
      "this confirmation has expired",
    );
  });

  test("refused on its second use", async () => {
    const token = await minted();
    expect(await refusal(token, binding())).toBeUndefined();
    expect(await refusal(token, binding())).toBe("this confirmation has already been used");
  });

  test("a refused token is not spent: the same token verifies afterwards for the request it was minted for", async () => {
    const token = await minted();
    expect(await refusal(token, { ...binding(), statement: "DELETE FROM u" })).toBe(
      "this confirmation was issued for another statement",
    );
    expect(await refusal(token, binding())).toBeUndefined();
  });

  test("a used token is forgotten once it has expired, and is then refused as expired", async () => {
    const token = await minted();
    expect(await refusal(token, binding())).toBeUndefined();
    // Another token verified after the first one's expiry prunes it from the record of used tokens.
    const later = NOW + (RUN_CONFIRMATION_TTL_SECONDS + 1) * 1000;
    const next = (await mintRunConfirmation(binding(), at(later))).token;
    expect(await refusal(next, binding(), at(later))).toBeUndefined();
    expect(await refusal(token, binding(), at(later))).toBe("this confirmation has expired");
  });

  test("a token signed with the session key is not verifiable", async () => {
    const issuedAt = Math.floor(NOW / 1000);
    const forged = await new SignJWT({ v: 1, rt: "query" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 60)
      .setJti(crypto.randomUUID())
      .sign(getJwtSecret());
    expect(await refusal(forged, binding())).toBe("this confirmation could not be verified");
  });

  test("a session cookie is not a token", async () => {
    const cookie = await signJWT({ username: "alice", role: "user" });
    expect(await refusal(cookie, binding(), Date.now)).toBe("this confirmation could not be verified");
    expect(await refusal(crypto.randomUUID(), binding())).toBe("this confirmation could not be verified");
  });

  test("a token of another claim version is not verifiable, even under the run confirmation key", async () => {
    // The key is HMAC(JWT_SECRET, its label), derived here as the module derives it, so only the version differs.
    const base = await crypto.subtle.importKey(
      "raw",
      getJwtSecret().slice().buffer as ArrayBuffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const key = new Uint8Array(
      await crypto.subtle.sign("HMAC", base, new TextEncoder().encode("libredb.run-confirmation.v1")),
    );
    const issued = await minted();
    const claims = JSON.parse(Buffer.from(issued.split(".")[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const resigned = (version: number) =>
      new SignJWT({ ...claims, v: version }).setProtectedHeader({ alg: "HS256" }).sign(key);
    expect(await refusal(await resigned(2), binding())).toBe("this confirmation could not be verified");
    // The control: the same claims at version 1 under the same key verify, so the version alone was refused.
    expect(await refusal(await resigned(1), binding())).toBeUndefined();
  });

  test("no binding claim can be reproduced from the binding without the server key", async () => {
    // A token's payload is readable by whoever holds it, so each binding claim is keyed: without the server key the
    // payload says nothing about the session, the connection, the statement or the verdict it was minted for.
    const target: DatabaseConnection = {
      ...connection(),
      type: "mongodb",
      connectionString: `mongodb://app:${crypto.randomUUID()}@db.internal:27017/shop`,
    };
    const offered: RunConfirmationBinding = { ...binding(), connection: target };
    const claims = claimsOf(await minted(offered));
    const frame = (value: string) => `${value.length}:${value}`;
    const server = await connectionFingerprint(target);
    const unkeyed = {
      sid: await sha256Hex(frame("alice") + frame("user") + frame("1700000000")),
      cid: await sha256Hex(frame(server) + frame("catalog:none")),
      sd: await sha256Hex(frame("DELETE FROM t") + frame("params:none")),
      vd: await sha256Hex(frame("confirm") + frame("false") + frame("false") + frame("typed:none")),
    };
    for (const [name, digest] of Object.entries(unkeyed)) expect(claims[name]).not.toBe(digest);
    // The control: under the binding key, HMAC(JWT_SECRET, its label), each claim is the HMAC of that same digest, so
    // the key and nothing else is what a reader of the token lacks.
    const bindingKey = Buffer.from(
      await hmacHex(getJwtSecret().slice().buffer as ArrayBuffer, "libredb.run-confirmation.binding.v1"),
      "hex",
    );
    for (const [name, digest] of Object.entries(unkeyed)) expect(claims[name]).toBe(await hmacHex(bindingKey, digest));
  });
});
