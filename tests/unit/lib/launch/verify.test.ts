import { beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { SignJWT } from "jose";
import type { ReadyLaunchConfig } from "@/lib/launch/config";
import { claimLaunchJti, clearLaunchReplayState, MAX_REMEMBERED_LAUNCHES } from "@/lib/launch/replay";
import {
  LAUNCH_CLOCK_TOLERANCE_SECONDS,
  LAUNCH_MAX_LIFETIME_SECONDS,
  LaunchTokenError,
  type LaunchTokenFailure,
  verifyLaunchToken,
} from "@/lib/launch/verify";

// Built rather than written out, so no literal here reads as a credential to a secret scanner.
const SECRET = "k".repeat(32);
const OTHER_SECRET = "o".repeat(32);
const LAUNCH_TYPE = "libredb-launch+jwt";
const CONFIG: ReadyLaunchConfig = {
  state: "ready",
  secret: new TextEncoder().encode(SECRET),
  audience: "studio-1",
  issuer: "platform",
};
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const IAT = NOW / 1000;

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "platform",
    aud: "studio-1",
    sub: "platform-user-1",
    email: "ada@example.com",
    role: "user",
    conn: "orders-db",
    jti: `jti-${Math.random().toString(36).slice(2)}`,
    iat: IAT,
    exp: IAT + LAUNCH_MAX_LIFETIME_SECONDS,
    ...overrides,
  };
}

function sign(payload: Record<string, unknown>, alg = "HS256", secret = SECRET, typ = LAUNCH_TYPE): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg, typ }).sign(new TextEncoder().encode(secret));
}

/** A token SignJWT refuses to produce: an HS256 signature over any header and payload text. */
function craft(header: Record<string, unknown>, payloadText: string): string {
  const head = Buffer.from(JSON.stringify(header)).toString("base64url");
  const body = Buffer.from(payloadText).toString("base64url");
  const signature = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}

/** An unsecured token of the launch type, which UnsecuredJWT cannot produce: it writes no typ. */
function unsigned(payload: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: "none", typ: LAUNCH_TYPE })).toString("base64url");
  return `${head}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`;
}

async function refusal(token: string, now = NOW): Promise<LaunchTokenFailure> {
  try {
    await verifyLaunchToken(token, CONFIG, now);
  } catch (error) {
    if (error instanceof LaunchTokenError) return error.reason;
    throw error;
  }
  throw new Error("expected the token to be refused");
}

beforeEach(() => {
  clearLaunchReplayState();
});

describe("verifyLaunchToken", () => {
  test("answers the verified claims of a well-formed token", async () => {
    const payload = claims();
    expect(await verifyLaunchToken(await sign(payload), CONFIG, NOW)).toEqual({
      sub: "platform-user-1",
      email: "ada@example.com",
      role: "user",
      conn: "orders-db",
      jti: payload.jti as string,
      iat: IAT,
      exp: IAT + 60,
    });
  });

  test("leaves conn out when the token names no connection", async () => {
    const verified = await verifyLaunchToken(await sign(claims({ conn: undefined, role: "admin" })), CONFIG, NOW);
    expect(verified.role).toBe("admin");
    expect("conn" in verified).toBe(false);
  });

  test("refuses an unsigned token and one signed with another algorithm before reading any claim", async () => {
    expect(await refusal(unsigned(claims()))).toBe("launch_token_signature");
    expect(await refusal(await sign(claims(), "HS512"))).toBe("launch_token_signature");
    expect(await refusal(await sign(claims({ aud: "another-studio" }), "HS384"))).toBe("launch_token_signature");
  });

  test("refuses a token signed with another secret", async () => {
    expect(await refusal(await sign(claims(), "HS256", OTHER_SECRET))).toBe("launch_token_signature");
  });

  test("refuses a token of another JWT type before its signature is checked", async () => {
    expect(await refusal(await sign(claims(), "HS256", SECRET, "JWT"))).toBe("launch_token_type");
    expect(await refusal(await sign(claims(), "HS256", OTHER_SECRET, "JWT"))).toBe("launch_token_type");
    expect(await refusal(await sign(claims(), "HS256", SECRET, "LIBREDB-LAUNCH+JWT"))).toBe("launch_token_type");
    expect(await refusal(await sign(claims(), "HS256", SECRET, `application/${LAUNCH_TYPE}`))).toBe(
      "launch_token_type",
    );
    expect(await refusal(craft({ alg: "HS256" }, JSON.stringify(claims())))).toBe("launch_token_type");
  });

  test("refuses a token from another issuer or for another audience", async () => {
    expect(await refusal(await sign(claims({ iss: "someone-else" })))).toBe("launch_token_issuer");
    expect(await refusal(await sign(claims({ aud: "studio-2" })))).toBe("launch_token_audience");
    expect(await refusal(await sign(claims({ aud: ["studio-1", "studio-2"] })))).toBe("launch_token_audience");
  });

  test("accepts a token up to the clock tolerance past its expiry and refuses it after", async () => {
    const tolerance = LAUNCH_CLOCK_TOLERANCE_SECONDS * 1000;
    const late = claims();
    expect((await verifyLaunchToken(await sign(late), CONFIG, NOW + 60_000 + tolerance - 1000)).jti).toBe(
      late.jti as string,
    );
    expect(await refusal(await sign(claims()), NOW + 60_000 + tolerance)).toBe("launch_token_expired");
  });

  test("refuses a token issued or valid from further in the future than the tolerance", async () => {
    expect(await refusal(await sign(claims({ iat: IAT + 30, exp: IAT + 90 })))).toBe("launch_token_premature");
    expect(await refusal(await sign(claims({ nbf: IAT + 30 })))).toBe("launch_token_premature");
    expect((await verifyLaunchToken(await sign(claims({ iat: IAT + 4, exp: IAT + 64 })), CONFIG, NOW)).iat).toBe(
      IAT + 4,
    );
  });

  test("a token issued more than 5 seconds ahead of this server's clock names the clock difference", async () => {
    // The platform host's clock running ahead: 5 seconds is still tolerated, 6 is not.
    expect((await verifyLaunchToken(await sign(claims({ iat: IAT + 5, exp: IAT + 65 })), CONFIG, NOW)).iat).toBe(
      IAT + 5,
    );
    const error = await verifyLaunchToken(await sign(claims({ iat: IAT + 6, exp: IAT + 66 })), CONFIG, NOW).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(LaunchTokenError);
    expect((error as LaunchTokenError).reason).toBe("launch_token_premature");
    expect((error as LaunchTokenError).message).toBe(
      "This launch link is not valid yet: the clocks of the platform and this Studio disagree.",
    );
    expect((error as LaunchTokenError).message).not.toBe(new LaunchTokenError("launch_token_malformed").message);
  });

  test("refuses a token issued for longer than 60 seconds, whether or not it has expired yet", async () => {
    expect(await refusal(await sign(claims({ exp: IAT + 61 })))).toBe("launch_token_lifetime");
    expect(await refusal(await sign(claims({ exp: IAT + 3600 })))).toBe("launch_token_lifetime");
    expect(await refusal(await sign(claims({ iat: IAT - 70, exp: IAT + 10 })))).toBe("launch_token_lifetime");
  });

  test("refuses a token that is not a compact JWS with a JSON claims set", async () => {
    expect(await refusal("")).toBe("launch_token_malformed");
    expect(await refusal("not-a-token")).toBe("launch_token_malformed");
    expect(await refusal(craft({ alg: "HS256", typ: LAUNCH_TYPE }, "[1]"))).toBe("launch_token_malformed");
    expect(await refusal(craft({ alg: "HS256", typ: LAUNCH_TYPE, crit: ["x"], x: 1 }, JSON.stringify(claims())))).toBe(
      "launch_token_malformed",
    );
  });

  test("refuses a token missing a required claim or carrying one of the wrong type", async () => {
    const variants = [
      ...["sub", "jti", "iat", "exp", "iss", "aud"].map((name) => ({ [name]: undefined })),
      { iat: `${IAT}` },
    ];
    const tokens = await Promise.all(variants.map((overrides) => sign(claims(overrides))));
    const reasons = await Promise.all(tokens.map((token) => refusal(token)));
    expect(reasons).toEqual(variants.map(() => "launch_token_malformed"));
  });

  test("refuses a token whose identity claims are not the shape a launch needs", async () => {
    const malformed = [
      { sub: "" },
      { sub: 42 },
      { email: undefined },
      { email: "no-at-sign" },
      { email: "two words@example.com" },
      { email: `${"a".repeat(250)}@example.com` },
      { role: "owner" },
      { role: undefined },
      { conn: "Upper_Case" },
      { conn: "a".repeat(65) },
      { conn: 7 },
      { jti: "" },
      { jti: "j".repeat(129) },
    ];
    const tokens = await Promise.all(malformed.map((overrides) => sign(claims(overrides))));
    const reasons = await Promise.all(tokens.map((token) => refusal(token)));
    expect(reasons).toEqual(malformed.map(() => "launch_token_malformed"));
  });

  test("a token is single use, including inside the tolerance after its expiry", async () => {
    const token = await sign(claims());
    await verifyLaunchToken(token, CONFIG, NOW);
    expect(await refusal(token, NOW + 1000)).toBe("launch_token_replayed");
    expect(await refusal(token, NOW + 64_000)).toBe("launch_token_replayed");
  });

  // jose floors the current time, so a fractional exp still verifies until ceil(exp) plus the tolerance.
  test("a token with a fractional expiry stays spent for as long as it could still verify", async () => {
    const token = await sign(claims({ exp: IAT + 30.5 }));
    await verifyLaunchToken(token, CONFIG, NOW + 1000);
    expect(await refusal(token, NOW + 35_600)).toBe("launch_token_replayed");
  });

  test("a refused token does not spend its jti", async () => {
    const jti = "jti-shared";
    expect(await refusal(await sign(claims({ jti, email: "no-at-sign" })))).toBe("launch_token_malformed");
    expect((await verifyLaunchToken(await sign(claims({ jti })), CONFIG, NOW)).jti).toBe(jti);
  });

  test("a valid token is refused while the replay memory is full, and signs in once there is room", async () => {
    for (let index = 0; index < MAX_REMEMBERED_LAUNCHES; index += 1) {
      claimLaunchJti(`filler-${index}`, NOW + 30_000, NOW);
    }
    const payload = claims();
    const token = await sign(payload);
    const error = await verifyLaunchToken(token, CONFIG, NOW).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(LaunchTokenError);
    expect((error as LaunchTokenError).reason).toBe("launch_capacity_exceeded");
    expect((error as LaunchTokenError).message).toBe(
      "Too many launches arrived at this Studio in the last minute. Wait a minute, then open Studio again.",
    );
    expect((await verifyLaunchToken(token, CONFIG, NOW + 30_000)).jti).toBe(payload.jti as string);
  });

  test("each refusal carries the message the launch page shows", async () => {
    const error = await verifyLaunchToken(await sign(claims({ aud: "studio-2" })), CONFIG, NOW).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(LaunchTokenError);
    expect((error as LaunchTokenError).name).toBe("LaunchTokenError");
    expect((error as LaunchTokenError).message).toBe("This launch link was issued for a different Studio.");
  });

  test("an error that is not jose's verdict on the token propagates unchanged", async () => {
    const broken = { ...CONFIG, secret: "not-a-key" as unknown as Uint8Array };
    const error = await verifyLaunchToken(await sign(claims()), broken, NOW).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TypeError);
  });
});
