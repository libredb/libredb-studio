/**
 * The S3 connection's options and every connect-time refusal, each asserted with its exact
 * sentence and in its order. The builder takes no transport, so nothing can be sent here; a refusal never names the
 * value it refuses.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { nodeTlsMaterial } from "@/lib/db/http/node-transport";
import * as constants from "@/lib/db/providers/objectstore/s3/constants";
import {
  buildS3ConnectionOptions,
  S3_ACCESS_KEY_ID_PATTERN,
  S3_BUCKET_PATTERN,
  S3_CONNECTION_SENTENCES as S,
  S3_REGION_PATTERN,
  type S3ConnectionOptions,
  s3EndpointText,
} from "@/lib/db/providers/objectstore/s3/connection-options";
import { secretForms } from "@/lib/db/utils/server-text";
import { type DatabaseConnection, TUNNEL_FAR_END, type WithTunnelFarEnd } from "@/lib/types";
import { s3Connection } from "../../../helpers/s3-connection";
import {
  declareCredentialWarnings,
  SYNTHETIC_PAIR,
  SYNTHETIC_PASSWORD,
} from "../../../helpers/synthetic-credential-warnings";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

const CONTEXT = { executionReadOnly: false, queryTimeout: 30_000 };
const fixtures = loadTlsFixtures();
const FAR_END = { [TUNNEL_FAR_END]: { host: "s3.internal", port: 9000 } };
const TUNNEL = { ...FAR_END, host: "127.0.0.1", port: 41000, sshTunnel: { enabled: true } };
const REMOTE = { host: "s3.example.com" };

type Overrides = Record<string | symbol, unknown>;

function build(overrides: Overrides = {}, context = CONTEXT): S3ConnectionOptions {
  const config = s3Connection(overrides as Partial<DatabaseConnection>) as DatabaseConnection & WithTunnelFarEnd;
  return buildS3ConnectionOptions(config, context);
}

/** The refusal of `overrides`, which must be S3's DatabaseConfigError and must name none of the values it was given. */
function refusal(overrides: Overrides, context = CONTEXT): string {
  let caught: unknown;
  try {
    build(overrides, context);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DatabaseConfigError);
  const error = caught as DatabaseConfigError;
  expect(error.provider as string).toBe("s3");
  for (const value of Object.values(overrides)) {
    if (typeof value === "string" && value.trim().length > 3) expect(error.message).not.toContain(value.trim());
  }
  return error.message;
}

let undo: (() => void) | undefined;
afterEach(() => {
  undo?.();
  undo = undefined;
});

describe("what a connection builds", () => {
  test("a signed connection to this machine, with every default", () => {
    const options = build();
    expect(options).toEqual({
      origin: { scheme: "http", host: "localhost", port: 9000 },
      endpoint: { scheme: "http", host: "localhost", port: 9000 },
      tunnelled: false,
      tls: null,
      region: "us-east-1",
      credentials: { accessKeyId: "AKIDTESTKEY", secretAccessKey: "test-secret-key" },
      allowInsecureAuth: false,
      callTimeoutMs: 30_000,
      surfaceTimeoutMs: 10_000,
      secretForms: secretForms(["test-secret-key", "AKIDTESTKEY"]),
    });
    expect(s3EndpointText(options)).toBe("http://localhost:9000");
  });

  test("a blank pair sends unsigned requests and has no secret forms", () => {
    const options = build({ user: "", password: "" });
    expect(options.credentials).toBeNull();
    expect(options.secretForms).toEqual([]);
  });

  test("Bucket and Region are read; a short query timeout caps the surface deadline", () => {
    const options = build(
      { database: "sales", region: "garage-probe" },
      { executionReadOnly: false, queryTimeout: 2_000 },
    );
    expect(options).toMatchObject({
      pinnedBucket: "sales",
      region: "garage-probe",
      callTimeoutMs: 2_000,
      surfaceTimeoutMs: 2_000,
    });
  });

  test("an IPv6 endpoint is kept without brackets and written with them", () => {
    const options = build({ host: "::1" });
    expect(options.endpoint.host).toBe("::1");
    expect(s3EndpointText(options)).toBe("http://[::1]:9000");
  });

  test("under a tunnel the local forward is dialled; TLS identity, the plaintext rule and sentences use the far end", () => {
    const options = build({ ...TUNNEL, ssl: { mode: "verify-full", caCert: fixtures.ca } });
    expect(options.origin).toEqual({ scheme: "https", host: "127.0.0.1", port: 41000 });
    expect(options.endpoint).toEqual({ scheme: "https", host: "s3.internal", port: 9000 });
    expect(options.tunnelled).toBe(true);
    expect(options.tls?.identity).toBe("s3.internal");
    expect(s3EndpointText(options)).toBe("https://s3.internal:9000");
    expect(build(TUNNEL).tunnelled).toBe(true);
  });

  test("read-only sources: the connection's own flag, a seed's, then the execution profile's", () => {
    expect(build({ readOnly: true }).readOnly).toBe("connection");
    expect(build({ readOnly: true, seedId: "seed-1" }).readOnly).toBe("seed");
    expect(build({}, { executionReadOnly: true, queryTimeout: 30_000 }).readOnly).toBe("execution-profile");
    expect(build({ readOnly: false }).readOnly).toBeUndefined();
  });

  test("a field the provider does not read is not refused", () => {
    expect(build({ apiKeyId: 42 } as Overrides).region).toBe("us-east-1");
  });
});

describe("the refusals, in order", () => {
  test("row 1: a read field of the wrong type", () => {
    expect(refusal({ user: 5 })).toBe(S.wrongType("user", "a string"));
    expect(refusal({ password: 5 })).toBe("The connection's password must be a string; nothing was sent.");
    expect(refusal({ database: 1 })).toBe(S.wrongType("database", "a string"));
    expect(refusal({ region: true })).toBe(S.wrongType("region", "a string"));
    expect(refusal({ allowInsecureAuth: "yes" })).toBe(S.wrongType("allowInsecureAuth", "true or false"));
    expect(refusal({ seedId: 7 })).toBe(S.wrongType("seedId", "a string"));
    expect(refusal({ sshTunnel: "on" })).toBe(S.wrongType("sshTunnel", "an object"));
    expect(refusal({ sshTunnel: { enabled: "yes" } })).toBe(S.wrongType("sshTunnel.enabled", "true or false"));
  });

  test("row 2: a tunnel that did not open", () => {
    expect(refusal({ sshTunnel: { enabled: true } })).toBe(
      "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so the S3 server was not dialled directly: the tunnel opens only when both Host and Port are set.",
    );
  });

  test("row 3: the shared host and port sentences, dialled and far end", () => {
    expect(refusal({ host: "bad host" })).toBe("Invalid host: expected a hostname, an IPv4 address or an IPv6 address");
    expect(refusal({ port: 70000 })).toBe("Invalid port: expected an integer from 1 to 65535");
    expect(refusal({ ...TUNNEL, [TUNNEL_FAR_END]: { host: "bad host", port: 9000 } })).toBe(
      "Invalid host: expected a hostname, an IPv4 address or an IPv6 address",
    );
  });

  test("row 4: a link-local far end under a tunnel", () => {
    expect(refusal({ ...TUNNEL, [TUNNEL_FAR_END]: { host: "169.254.169.254", port: 80 } })).toBe(
      "Invalid host: this connection never reaches a link-local address or AWS's IPv6 instance metadata address, whatever DB_HTTP_BLOCK_PRIVATE_HOSTS says",
    );
  });

  test("row 5: half a key pair", () => {
    const sentence =
      "Access key ID and Secret access key go together: fill in both to sign requests, or clear both to send unsigned requests. Nothing was sent.";
    expect(refusal({ password: "" })).toBe(sentence);
    expect(refusal({ user: "" })).toBe(sentence);
  });

  test("row 6: an access key ID with a character the Credential parameter cannot carry", () => {
    const sentence =
      "Access key ID must be printable ASCII without spaces, commas, equals signs or slashes, because it is sent inside the signed Authorization header. Nothing was sent.";
    expect(refusal({ user: "AKID=1" })).toBe(sentence);
    expect(refusal({ user: "AKID,1" })).toBe(sentence);
    expect(refusal({ user: "AKID/1" })).toBe(sentence);
  });

  test("a pasted access key ID with a trailing space or newline", () => {
    expect(refusal({ user: "AKIDTESTKEY " })).toBe(S.accessKeyIdCharacters);
    expect(refusal({ user: "AKIDTESTKEY\n" })).toBe(S.accessKeyIdCharacters);
  });

  test("row 6b: 3 to 512 characters", () => {
    const sentence =
      "Access key ID holds 3 to 512 characters, because S3 servers issue no shorter ID and it is sent inside the signed Authorization header. Nothing was sent.";
    expect(constants.S3_ACCESS_KEY_ID_MIN_CHARS).toBe(3);
    expect(constants.S3_ACCESS_KEY_ID_MAX_CHARS).toBe(512);
    expect(refusal({ user: "ab" })).toBe(sentence);
    expect(refusal({ user: "a".repeat(513) })).toBe(sentence);
    expect(build({ user: "abc" }).credentials?.accessKeyId).toBe("abc");
    expect(build({ user: "a".repeat(512) }).credentials?.accessKeyId).toHaveLength(512);
  });

  test("row 7: a secret with a lone surrogate", () => {
    expect(refusal({ password: "abc\uD800" })).toBe(
      "Secret access key holds a broken character, a lone UTF-16 surrogate, which cannot be used to sign; re-enter it. Nothing was sent.",
    );
  });

  test("row 8: a bucket outside the bucket rule, spaces included", () => {
    const sentence =
      "Bucket must be 1 to 255 letters, digits, dots, hyphens or underscores, starting and ending with a letter or digit. Nothing was sent.";
    expect(refusal({ database: "a b" })).toBe(sentence);
    expect(refusal({ database: ".." })).toBe(sentence);
    expect(refusal({ database: "   " })).toBe(sentence);
  });

  test("row 9: a region outside the region rule, spaces included", () => {
    const sentence =
      "Region must be 1 to 64 letters, digits, hyphens or underscores, such as us-east-1. Nothing was sent.";
    expect(refusal({ region: "us east" })).toBe(sentence);
    expect(refusal({ region: "   " })).toBe(sentence);
  });

  test("row 10: the SSL panel's own refusal, unchanged", () => {
    let expected = "";
    try {
      nodeTlsMaterial({ mode: "bogus" } as never, "localhost");
    } catch (error) {
      expected = (error as Error).message;
    }
    expect(expected).not.toBe("");
    expect(refusal({ ssl: { mode: "bogus" } })).toBe(expected);
  });

  test("row 11: plain HTTP to a host that is not this machine, signed or not", () => {
    const sentence =
      "This connection would reach a host that is not this machine over plain HTTP, where anyone on the path can read bucket and object names, listings and previews, and replay a signed request. Choose an SSL mode under SSL / TLS, connect through an SSH tunnel, or tick Connect without TLS. Nothing was sent.";
    expect(refusal(REMOTE)).toBe(sentence);
    expect(refusal({ ...REMOTE, user: "", password: "" })).toBe(sentence);
    expect(refusal({ ...REMOTE, ssl: { mode: "disable" } })).toBe(sentence);
  });

  test("row 11 holds for loopback names, an IPv4-mapped loopback and a tunnel; the consent and TLS lift it", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(build({ host }).tls).toBeNull();
    expect(build({ ...TUNNEL }).tunnelled).toBe(true);
    expect(build({ ...REMOTE, allowInsecureAuth: true }).allowInsecureAuth).toBe(true);
    // The consent lifts row 11 only.
    expect(refusal({ ...REMOTE, allowInsecureAuth: true, region: "us east" })).toBe(S.region);
    expect(refusal({ ...REMOTE, allowInsecureAuth: true, password: "" })).toBe(S.keyPair);
    expect(build({ ...REMOTE, ssl: { mode: "require" } }).origin.scheme).toBe("https");
  });

  test("row 12: readOnly that is not a boolean", () => {
    expect(refusal({ readOnly: "yes" })).toBe("readOnly must be true or false.");
  });

  test("row 13: a read-only seed with a credential the warnings refuse", () => {
    undo = declareCredentialWarnings(constants.S3_TYPE, [SYNTHETIC_PAIR]);
    expect(refusal({ readOnly: true, seedId: "seed-1", user: "root", password: SYNTHETIC_PASSWORD })).toBe(
      `Credential warning: ${SYNTHETIC_PAIR.message} This read-only seed connection is refused with this credential, because the mode would promise a boundary the server does not keep; nothing was sent.`,
    );
    expect(build({ readOnly: true, user: "root", password: SYNTHETIC_PASSWORD }).readOnly).toBe("connection");
  });

  test("row 14: a query timeout outside its range", () => {
    expect(refusal({}, { executionReadOnly: false, queryTimeout: 0 })).toBe(
      "Query timeout must be a whole number between 1 and 2147483647 milliseconds.",
    );
  });

  test("an earlier row wins over a later one", () => {
    expect(refusal({ user: 5, sshTunnel: { enabled: true } })).toBe(S.wrongType("user", "a string"));
    expect(refusal({ sshTunnel: { enabled: true }, host: "bad host" })).toBe(S.tunnelNotOpened);
    expect(refusal({ host: "bad host", password: "" })).toBe(
      "Invalid host: expected a hostname, an IPv4 address or an IPv6 address",
    );
    expect(refusal({ password: "", database: "a b" })).toBe(S.keyPair);
    expect(refusal({ user: "a=b", database: "a b" })).toBe(S.accessKeyIdCharacters);
    expect(refusal({ database: "a b", region: "us east" })).toBe(S.bucket);
    expect(refusal({ region: "us east", ...REMOTE })).toBe(S.region);
    expect(refusal({ ...REMOTE, readOnly: "yes" })).toBe(S.plaintext);
    expect(refusal({ readOnly: "yes" }, { executionReadOnly: false, queryTimeout: 0 })).toBe(S.readOnlyNotBoolean);
  });
});

test("the patterns are the constants module's own objects", () => {
  expect(S3_ACCESS_KEY_ID_PATTERN).toBe(constants.S3_ACCESS_KEY_ID_PATTERN);
  expect(S3_BUCKET_PATTERN).toBe(constants.S3_BUCKET_PATTERN);
  expect(S3_REGION_PATTERN).toBe(constants.S3_REGION_PATTERN);
});
