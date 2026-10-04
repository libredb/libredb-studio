/**
 * The `milvus` credential record (vector-family spec 3.12, E22), over the real row: the dialog's warning, the seed
 * refusal's sentence, and the provider's own connect() stage with zero client calls. The documented default pair is
 * read from the record by reference and never written here.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

const debug = mock(() => {});
const info = mock(() => {});
const warn = mock(() => {});
const error = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { debug, info, warn, error } }));

import {
  CREDENTIAL_WARNINGS,
  type CredentialWarning,
  credentialWarningFor,
  readOnlySeedRefusal,
} from "@/lib/db/credential-warnings";
import { getDBConfig } from "@/lib/db-ui-config";
import { MilvusProvider } from "@/lib/db/providers/vector/milvus/index";
import { resolveConnectionCredentials } from "@/lib/seed/credential-resolver";
import { SeedConnectionSchema } from "@/lib/seed/types";
import type { DatabaseConnection } from "@/lib/types";

const TEST_PASSWORD = "password";

const entries = CREDENTIAL_WARNINGS.milvus ?? [];
const pair = entries.find((entry): entry is Extract<CredentialWarning, { kind: "pair" }> => entry.kind === "pair");
const noSecret = entries.find((entry) => entry.kind === "no-secret");
if (pair === undefined || noSecret === undefined) throw new Error("the milvus record declares no pair or no no-secret");

const PAIR_SENTENCE = `Credential warning: ${pair.message}`;
const NO_SECRET_SENTENCE = `Credential warning: ${noSecret.message}`;

describe("the dialog's warning reads the real milvus record", () => {
  test("DB_UI_CONFIG takes the record by reference", () => {
    expect(getDBConfig("milvus").credentialWarnings).toBe(CREDENTIAL_WARNINGS.milvus);
  });

  test("the record declares the pair and no-secret, in that order (vector-family spec 3.12)", () => {
    expect(entries.map((entry) => entry.kind)).toEqual(["pair", "no-secret"]);
    expect(pair.user).toBe("root");
  });

  test("the declared pair warns, with the sentence the seed refusal gives", () => {
    const credential = { user: pair.user, password: pair.password };
    expect(credentialWarningFor("milvus", credential)).toBe(PAIR_SENTENCE);
    expect(readOnlySeedRefusal("milvus", credential)).toBe(PAIR_SENTENCE);
  });

  test("an empty user with the token user:password is read as the pair", () => {
    const credential = { user: "", password: `${pair.user}:${pair.password}` };
    expect(credentialWarningFor("milvus", credential)).toBe(PAIR_SENTENCE);
    expect(readOnlySeedRefusal("milvus", credential)).toBe(PAIR_SENTENCE);
  });

  test("the declared user with another password, and a user of its own, give no warning", () => {
    expect(credentialWarningFor("milvus", { user: pair.user, password: TEST_PASSWORD })).toBeUndefined();
    expect(credentialWarningFor("milvus", { user: "reader", password: TEST_PASSWORD })).toBeUndefined();
    expect(readOnlySeedRefusal("milvus", { user: pair.user, password: TEST_PASSWORD })).toBeUndefined();
  });

  test("an empty password gives no dialog warning, since no-secret is the seed refusal's alone", () => {
    expect(credentialWarningFor("milvus", { user: pair.user, password: "" })).toBeUndefined();
    expect(readOnlySeedRefusal("milvus", { user: "reader" })).toBe(NO_SECRET_SENTENCE);
  });

  test("the sentences never spell the pair out", () => {
    // The password is also the product's name, which the sentences say, so the pair's written forms are what is held.
    for (const entry of entries) {
      for (const form of [`${pair.user}:${pair.password}`, `${pair.user}/${pair.password}`, `"${pair.password}"`]) {
        expect(entry.message).not.toContain(form);
      }
    }
  });
});

describe("connect(): the provider's own stage, after resolution", () => {
  /** A read-only seed connection on this machine, so the plaintext rule lets a secret through to the seed stage. */
  const seed = (credential: { user?: string; password?: string }): DatabaseConnection =>
    ({
      id: "vectors-read",
      name: "Vectors",
      type: "milvus",
      host: "127.0.0.1",
      port: 19530,
      ...credential,
      seedId: "vectors-read",
      readOnly: true,
      createdAt: new Date(0),
    }) as DatabaseConnection;

  const refusingFactory = () =>
    mock(async () => {
      throw new Error("no client may be built");
    });

  test.each([
    ["the pair as user and password", () => ({ user: pair.user, password: pair.password }), PAIR_SENTENCE],
    ["the pair as the token user:password", () => ({ password: `${pair.user}:${pair.password}` }), PAIR_SENTENCE],
    ["a user with no password", () => ({ user: "reader" }), NO_SECRET_SENTENCE],
    ["no credential at all", () => ({}), NO_SECRET_SENTENCE],
  ])(
    "refuses a resolved read-only seed with %s before any client exists (E22)",
    async (_label, credential, sentence) => {
      const createClient = refusingFactory();
      const provider = new MilvusProvider(seed(credential()), {}, {}, createClient);
      await expect(provider.connect()).rejects.toThrow(sentence);
      expect(createClient).toHaveBeenCalledTimes(0);
    },
  );

  test("a read-only seed with a user of its own reaches the client", async () => {
    const createClient = refusingFactory();
    const provider = new MilvusProvider(seed({ user: "reader", password: TEST_PASSWORD }), {}, {}, createClient);
    await expect(provider.connect()).rejects.toThrow();
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});

const seedRow = {
  id: "vectors-read",
  name: "Vectors",
  type: "milvus",
  host: "milvus.internal",
  port: 19530,
  roles: ["*"],
  managed: true,
  readOnly: true,
} as const;

function issuesOf(candidate: Record<string, unknown>): [string, string][] {
  const result = SeedConnectionSchema.safeParse(candidate);
  return result.success ? [] : result.error.issues.map((issue) => [issue.path.join("."), issue.message]);
}

function refusedAtLoad(refusal: string): string {
  return `Seed connection "vectors-read": ${refusal} readOnly: true is refused with this credential, because the mode would promise a boundary the server does not keep. Give this connection a credential of its own, or remove readOnly.`;
}

describe("load: the seed file refuses what it shows (vector-family spec 3.12)", () => {
  test("the literal pair on a read-only seed is refused naming the connection and the field, never the pair", () => {
    const issues = issuesOf({ ...seedRow, user: pair.user, password: pair.password });
    expect(issues).toEqual([["password", refusedAtLoad(PAIR_SENTENCE)]]);
    for (const form of [`${pair.user}:${pair.password}`, `${pair.user}/${pair.password}`, `"${pair.password}"`]) {
      expect(JSON.stringify(issues)).not.toContain(form);
    }
  });

  test("the pair written as one token in the password with no user is refused", () => {
    expect(issuesOf({ ...seedRow, password: `${pair.user}:${pair.password}` })).toEqual([
      ["password", refusedAtLoad(PAIR_SENTENCE)],
    ]);
  });

  test("the declared user with another password loads", () => {
    expect(issuesOf({ ...seedRow, user: pair.user, password: TEST_PASSWORD })).toEqual([]);
  });

  test("a read-only seed with no password is refused, and one without readOnly loads", () => {
    expect(issuesOf({ ...seedRow, user: "reader" })).toEqual([["password", refusedAtLoad(NO_SECRET_SENTENCE)]]);
    expect(issuesOf({ ...seedRow, readOnly: undefined, user: "reader" })).toEqual([]);
  });
});

describe("resolution: what the file does not show (vector-family spec 3.12)", () => {
  afterEach(() => {
    delete process.env.MILVUS_SEED_PASSWORD;
  });

  test("a ${ENV} reference that resolves to the pair is refused after resolution", () => {
    process.env.MILVUS_SEED_PASSWORD = pair.password;
    const parsed = SeedConnectionSchema.parse({ ...seedRow, user: pair.user, password: "${MILVUS_SEED_PASSWORD}" });
    expect(readOnlySeedRefusal("milvus", resolveConnectionCredentials(parsed))).toBe(PAIR_SENTENCE);
  });

  test("a ${ENV} reference that resolves to the token form is refused after resolution", () => {
    process.env.MILVUS_SEED_PASSWORD = `${pair.user}:${pair.password}`;
    const parsed = SeedConnectionSchema.parse({ ...seedRow, password: "${MILVUS_SEED_PASSWORD}" });
    expect(readOnlySeedRefusal("milvus", resolveConnectionCredentials(parsed))).toBe(PAIR_SENTENCE);
  });
});
