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
  test("milvus and qdrant are the shipped types that declare credential warnings (vector-family spec 3.12)", () => {
    expect(Object.keys(CREDENTIAL_WARNINGS)).toEqual(["milvus", "qdrant"]);
    expect(CREDENTIAL_WARNINGS.milvus?.map((entry) => entry.kind)).toEqual(["pair", "no-secret"]);
    expect(CREDENTIAL_WARNINGS.qdrant?.map((entry) => entry.kind)).toEqual(["jwt", "no-secret"]);
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
