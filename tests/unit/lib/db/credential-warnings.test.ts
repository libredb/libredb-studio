import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { CREDENTIAL_WARNINGS, credentialWarningFor, readOnlySeedRefusal } from "@/lib/db/credential-warnings";
import {
  declareCredentialWarnings,
  SYNTHETIC_JWT,
  SYNTHETIC_NO_SECRET,
  SYNTHETIC_PAIR,
  SYNTHETIC_PASSWORD,
} from "../../../helpers/synthetic-credential-warnings";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

const PAIR_SENTENCE = `Credential warning: ${SYNTHETIC_PAIR.message}`;
const JWT_SENTENCE = `Credential warning: ${SYNTHETIC_JWT.message}`;
const NO_SECRET_SENTENCE = `Credential warning: ${SYNTHETIC_NO_SECRET.message}`;

const EXP = 4102444800;
const b64url = (claims: unknown): string => Buffer.from(JSON.stringify(claims)).toString("base64url");
const jwt = (claims: unknown): string => `e30.${b64url(claims)}.sig`;
/** Manage access and no `exp`, with a payload whose base64url holds both "-" and "_" and needs padding. */
const MANAGE_NO_EXP_URL_SAFE = "e30.eyJhY2Nlc3MiOiJtIiwic3ViIjoieHg_Pz8_Pz4-In0.sig";

type Credential = { user?: string; password?: string };

describe("CREDENTIAL_WARNINGS", () => {
  test("milvus, qdrant, influxdb, influxdb3, oxia, databend and s3 are the shipped types that declare credential warnings (vector-family spec 3.12, InfluxDB spec E12, SB3-1.5, Databend design 7.2)", () => {
    expect(Object.keys(CREDENTIAL_WARNINGS)).toEqual([
      "milvus",
      "qdrant",
      "influxdb",
      "influxdb3",
      "oxia",
      "databend",
      "s3",
    ]);
    expect(CREDENTIAL_WARNINGS.milvus?.map((entry) => entry.kind)).toEqual(["pair", "no-secret"]);
    expect(CREDENTIAL_WARNINGS.qdrant?.map((entry) => entry.kind)).toEqual(["jwt", "no-secret"]);
    expect(CREDENTIAL_WARNINGS.oxia?.map((entry) => entry.kind)).toEqual(["jwt"]);
    expect(CREDENTIAL_WARNINGS.s3?.map((entry) => entry.kind)).toEqual(["pair", "pair"]);
  });
});

/**
 * Oxia's row (SB3-1.5, DECISIONS O7): Oxia has no authorization, so a token's claims never narrow what it reaches,
 * and only a token without `exp` warns; no `no-secret` row, so a read-only seed without a token is not refused.
 */
describe("the oxia row", () => {
  const OXIA_SENTENCE =
    "Credential warning: This token declares no expiry, so it stays valid until the identity provider's signing key changes, and Oxia has no authorization, so it reads and writes every namespace. Prefer a token with an expiry.";

  test("a token without exp warns with the framed sentence", () => {
    expect(credentialWarningFor("oxia", { password: jwt({ sub: "svc" }) })).toBe(OXIA_SENTENCE);
  });

  test("a token with exp does not warn, whatever its claims", () => {
    expect(credentialWarningFor("oxia", { password: jwt({ sub: "svc", exp: EXP }) })).toBeUndefined();
    expect(credentialWarningFor("oxia", { password: jwt({ access: "m", exp: EXP }) })).toBeUndefined();
  });

  test("an opaque token does not warn", () => {
    expect(credentialWarningFor("oxia", { password: "opaque-token" })).toBeUndefined();
  });

  test("a read-only seed without a token is not refused", () => {
    expect(readOnlySeedRefusal("oxia", { password: "" })).toBeUndefined();
    expect(readOnlySeedRefusal("oxia", {})).toBeUndefined();
  });

  test("influxdb and influxdb3 each declare one no-secret entry (InfluxDB spec E12)", () => {
    const record: Readonly<Record<string, readonly { readonly kind: string }[] | undefined>> = CREDENTIAL_WARNINGS;
    expect(record.influxdb?.map((entry) => entry.kind)).toEqual(["no-secret"]);
    expect(record.influxdb3?.map((entry) => entry.kind)).toEqual(["no-secret"]);
  });
});

/**
 * The S3 rows: MinIO and RustFS start with a documented default credential, so each pair warns
 * in the dialog and refuses a read-only seed. No no-secret row: an unsigned connection is anonymous to the server.
 */
describe("the s3 rows", () => {
  const MINIO_SENTENCE =
    "Credential warning: This is the documented default root credential a MinIO server starts with when MINIO_ROOT_USER and MINIO_ROOT_PASSWORD are not set, so anyone who knows MinIO can sign in with it as the administrator. Set both on the server, or connect with an access key of your own.";
  const RUSTFS_SENTENCE =
    "Credential warning: This is the documented default credential a RustFS server starts with when RUSTFS_ACCESS_KEY and RUSTFS_SECRET_KEY are not set, so anyone who knows RustFS can sign in with it. Set both on the server, or connect with an access key of your own.";

  test("the MinIO and RustFS default pairs warn with their framed sentences", () => {
    expect(credentialWarningFor("s3", { user: "minioadmin", password: "minioadmin" })).toBe(MINIO_SENTENCE);
    expect(credentialWarningFor("s3", { user: "rustfsadmin", password: "rustfsadmin" })).toBe(RUSTFS_SENTENCE);
  });

  test("a default access key with another secret does not warn", () => {
    expect(credentialWarningFor("s3", { user: "minioadmin", password: "rotated-secret" })).toBeUndefined();
    expect(credentialWarningFor("s3", { user: "rustfsadmin", password: "minioadmin" })).toBeUndefined();
  });

  test("a read-only seed with a default pair is refused, and an unsigned one is not", () => {
    expect(readOnlySeedRefusal("s3", { user: "minioadmin", password: "minioadmin" })).toBe(MINIO_SENTENCE);
    expect(readOnlySeedRefusal("s3", {})).toBeUndefined();
    expect(readOnlySeedRefusal("s3", { user: "", password: "" })).toBeUndefined();
  });
});

/**
 * Databend's row (design 6.4 and 7.2, probe UC1): a `root` user with no password is `no_password` on the server,
 * which then accepts any password or none for it, so the dialog warns before Test Connection.
 */
describe("the databend row", () => {
  const ROOT_SENTENCE =
    "Credential warning: Signing in as root with no password works only when the server's root user has no password, and such a user accepts any password or none, so anyone who can reach the server signs in as its administrator. Set a password for root on the server, or connect as a user of your own.";

  test("declares one pair entry, root with an empty password", () => {
    expect(CREDENTIAL_WARNINGS.databend).toEqual([
      expect.objectContaining({ kind: "pair", user: "root", password: "" }),
    ]);
  });

  test("root with no password, or an empty one, warns with the framed sentence", () => {
    expect(credentialWarningFor("databend", { user: "root" })).toBe(ROOT_SENTENCE);
    expect(credentialWarningFor("databend", { user: "root", password: "" })).toBe(ROOT_SENTENCE);
  });

  test("root with a password, or another user with none, does not warn", () => {
    expect(credentialWarningFor("databend", { user: "root", password: "x" })).toBeUndefined();
    expect(credentialWarningFor("databend", { user: "reader" })).toBeUndefined();
    expect(credentialWarningFor("databend", {})).toBeUndefined();
  });
});

describe("credentialWarningFor: a declared pair", () => {
  const CASES: [string, Credential, string | undefined][] = [
    ["the declared pair", { user: "root", password: SYNTHETIC_PASSWORD }, PAIR_SENTENCE],
    ["the declared user with another password", { user: "root", password: "Other1" }, undefined],
    ["another user with the declared password", { user: "alice", password: SYNTHETIC_PASSWORD }, undefined],
    [
      "an empty user with user:password as the password",
      { user: "", password: `root:${SYNTHETIC_PASSWORD}` },
      PAIR_SENTENCE,
    ],
    ["no user with user:password as the password", { password: `root:${SYNTHETIC_PASSWORD}` }, PAIR_SENTENCE],
    ["user:password split at the first colon only", { user: "", password: `root:${SYNTHETIC_PASSWORD}:x` }, undefined],
    ["a named user keeps a colon in its password", { user: "root", password: `root:${SYNTHETIC_PASSWORD}` }, undefined],
    ["nothing typed", {}, undefined],
  ];
  test.each(CASES)("%s", (_label, credential, expected) => {
    restores.push(declareCredentialWarnings("etcd", [SYNTHETIC_PAIR]));
    expect(credentialWarningFor("etcd", credential)).toBe(expected);
  });

  test("a type that declares nothing never warns", () => {
    expect(credentialWarningFor("postgres", { user: "root", password: SYNTHETIC_PASSWORD })).toBeUndefined();
  });
});

/** The eleven cases: the ten of the pre-spec check (R46) and a url-safe payload with no padding. */
describe("credentialWarningFor: a declared jwt entry", () => {
  const CASES: [string, string, boolean][] = [
    ["global manage access with an expiry", jwt({ access: "m", exp: EXP }), true],
    ["no access claim", jwt({ exp: EXP }), true],
    ["read access with an expiry", jwt({ access: "r", exp: EXP }), false],
    [
      "a collection-scoped access list with an expiry",
      jwt({ access: [{ collection: "c", access: "r" }], exp: EXP }),
      false,
    ],
    ["no expiry", jwt({ access: "r" }), true],
    ["an opaque key", "opaque-api-key", false],
    ["a malformed three-part string", "a.b.c", false],
    ["an empty string", "", false],
    ["a non-numeric exp", jwt({ access: "r", exp: "4102444800" }), true],
    [
      "extra claims beside read access and an expiry",
      jwt({ access: "r", exp: EXP, sub: "svc", iss: "i", aud: "a" }),
      false,
    ],
    ["manage access, no expiry, a url-safe payload with no padding", MANAGE_NO_EXP_URL_SAFE, true],
  ];
  test.each(CASES)("%s", (_label, password, warns) => {
    restores.push(declareCredentialWarnings("druid", [SYNTHETIC_JWT]));
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      expect(credentialWarningFor("druid", { password })).toBe(warns ? JWT_SENTENCE : undefined);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("the url-safe case carries - and _ and no padding, so it exercises the mapping", () => {
    const payload = MANAGE_NO_EXP_URL_SAFE.split(".")[1];
    expect(payload).toContain("-");
    expect(payload).toContain("_");
    expect(payload).not.toContain("=");
    expect(payload.length % 4).not.toBe(0);
  });

  test("the sentence names no claim value", () => {
    restores.push(declareCredentialWarnings("druid", [SYNTHETIC_JWT]));
    const warning = credentialWarningFor("druid", { password: jwt({ access: "m", sub: "svc-account-7" }) });
    expect(warning).toBe(JWT_SENTENCE);
    expect(warning).not.toContain("svc-account-7");
  });

  test.each([jwt(1), jwt(null), jwt([1]), jwt("text")])(
    "a payload that is not a JSON object gives no warning: %s",
    (password) => {
      restores.push(declareCredentialWarnings("druid", [SYNTHETIC_JWT]));
      expect(credentialWarningFor("druid", { password })).toBeUndefined();
    },
  );

  test("a type with no pair entry does not read user:password", () => {
    restores.push(declareCredentialWarnings("druid", [SYNTHETIC_JWT]));
    expect(credentialWarningFor("druid", { user: "", password: `root:${SYNTHETIC_PASSWORD}` })).toBeUndefined();
  });
});

describe("credentialWarningFor: a no-secret entry", () => {
  test("never warns in the dialog, whatever is typed", () => {
    restores.push(declareCredentialWarnings("etcd", [SYNTHETIC_NO_SECRET]));
    expect(credentialWarningFor("etcd", {})).toBeUndefined();
    expect(credentialWarningFor("etcd", { password: "" })).toBeUndefined();
    expect(credentialWarningFor("etcd", { password: "x" })).toBeUndefined();
  });
});

describe("readOnlySeedRefusal", () => {
  test("refuses the declared pair with the dialog's own sentence", () => {
    restores.push(declareCredentialWarnings("etcd", [SYNTHETIC_PAIR]));
    const credential = { user: "root", password: SYNTHETIC_PASSWORD };
    expect(readOnlySeedRefusal("etcd", credential)).toBe(PAIR_SENTENCE);
    expect(readOnlySeedRefusal("etcd", credential)).toBe(credentialWarningFor("etcd", credential));
  });

  test("refuses the pair written as user:password with an empty user", () => {
    restores.push(declareCredentialWarnings("etcd", [SYNTHETIC_PAIR]));
    expect(readOnlySeedRefusal("etcd", { user: "", password: `root:${SYNTHETIC_PASSWORD}` })).toBe(PAIR_SENTENCE);
  });

  test("accepts the declared user with another password", () => {
    restores.push(declareCredentialWarnings("etcd", [SYNTHETIC_PAIR]));
    expect(readOnlySeedRefusal("etcd", { user: "root", password: "Other1" })).toBeUndefined();
  });

  test("refuses no password, and an empty one, where the type declares no-secret", () => {
    restores.push(declareCredentialWarnings("etcd", [SYNTHETIC_PAIR, SYNTHETIC_NO_SECRET]));
    expect(readOnlySeedRefusal("etcd", { user: "reader" })).toBe(NO_SECRET_SENTENCE);
    expect(readOnlySeedRefusal("etcd", { user: "reader", password: "" })).toBe(NO_SECRET_SENTENCE);
    expect(readOnlySeedRefusal("etcd", { user: "reader", password: "x" })).toBeUndefined();
  });

  test("accepts no password where the type declares no no-secret entry", () => {
    restores.push(declareCredentialWarnings("etcd", [SYNTHETIC_PAIR]));
    expect(readOnlySeedRefusal("etcd", {})).toBeUndefined();
  });

  test("a jwt entry refuses nothing", () => {
    restores.push(declareCredentialWarnings("druid", [SYNTHETIC_JWT]));
    expect(readOnlySeedRefusal("druid", { password: jwt({ access: "m" }) })).toBeUndefined();
  });

  test("a type that declares nothing refuses nothing", () => {
    expect(readOnlySeedRefusal("postgres", {})).toBeUndefined();
  });
});
