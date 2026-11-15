/**
 * BigQuery's credential policy over the shared Google auth: its pins (the kinds it accepts, its opt-in, its three
 * sentences and their quotes in docs/providers/bigquery.md, its project id rule, its token deps and their production
 * transport factory), and the credential a connection resolves to, read through a fake IO, plus the real IO it reads
 * at each connect.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { acceptedKindSentences, GOOGLE_CREDENTIAL_SENTENCES as G } from "@/lib/db/auth/google/credentials";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createNodeTransport } from "@/lib/db/http/node-transport";
import {
  BIGQUERY_CREDENTIAL_RULES,
  BIGQUERY_CREDENTIAL_SENTENCES as S,
  BIGQUERY_SCOPE,
  bigQueryCredentialIo,
  bigQueryTokenSourceDeps,
  projectIdRefusal,
  resolveBigQueryCredential,
} from "@/lib/db/providers/sql/bigquery/credential-policy";
import { logger } from "@/lib/logger";
import { LITERAL_SEED_FILE } from "@/lib/types";
import { type FakeIoOptions, fakeIo } from "../../../helpers/auth-fakes";

const OPT_IN = { BIGQUERY_SERVER_CREDENTIALS: "true" };
const K = acceptedKindSentences(["service_account", "authorized_user", "access_token"]);
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";
const key = { type: "service_account", client_email: "sa@p.iam.gserviceaccount.com", private_key: PEM };
const KEY = JSON.stringify(key);
const user = { type: "authorized_user", client_id: "id", client_secret: "secret-value", refresh_token: "1//refresh" };
const TOKEN = "ya29.a0AfH6SMBx-example_token~value";
const WELL_KNOWN = "/home/studio/.config/gcloud/application_default_credentials.json";

/** What a connection resolves to, its IO faked. */
const resolve = (password: string | undefined, managed: boolean | undefined, io: FakeIoOptions = {}) =>
  resolveBigQueryCredential({ password, managed }, fakeIo(io));
/** The server's own identity: an empty password on a managed connection, the opt-in set. */
const server = (io: FakeIoOptions = {}) => resolve("", true, { ...io, env: { ...OPT_IN, ...io.env } });

function refusal(run: () => unknown): DatabaseConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof DatabaseConfigError) return error;
    throw error;
  }
  throw new Error("expected a DatabaseConfigError");
}

describe("bigquery credential policy pins", () => {
  test("the three server-identity sentences, byte for byte", () => {
    expect(S.browserEmpty).toBe(
      "BigQuery needs a service-account key or an access token in the password field: the server's own credentials are used only for operator-seeded connections",
    );
    expect(S.seedWithoutOptIn).toBe(
      "BigQuery needs a service-account key in the password field. To use the server's own credentials (ADC or Workload Identity) instead, set BIGQUERY_SERVER_CREDENTIALS=true on the server.",
    );
    expect(S.literalSeedFile).toBe(
      "BigQuery needs a service-account key or an access token in the password field: the server's own credentials are not used for a connection read from a seed file in literal mode (SEED_LITERAL_VALUES)",
    );
  });

  test("the rules accept exactly the three kinds and gate the server's identity on BigQuery's opt-in", () => {
    expect(BIGQUERY_CREDENTIAL_RULES.provider).toBe("bigquery");
    expect(BIGQUERY_CREDENTIAL_RULES.accepts).toEqual(["service_account", "authorized_user", "access_token"]);
    expect(BIGQUERY_CREDENTIAL_RULES.quotaProjectRefusal).toBe(projectIdRefusal);
    expect(BIGQUERY_CREDENTIAL_RULES.serverIdentity).toEqual({
      optIn: "BIGQUERY_SERVER_CREDENTIALS",
      unmanaged: S.browserEmpty,
      withoutOptIn: S.seedWithoutOptIn,
      literalSeedFile: S.literalSeedFile,
    });
  });

  test("docs/providers/bigquery.md quotes each of the three sentences as the code words it", () => {
    const doc = readFileSync(join(import.meta.dir, "../../../../docs/providers/bigquery.md"), "utf8");
    for (const sentence of [S.browserEmpty, S.seedWithoutOptIn, S.literalSeedFile]) {
      expect({ sentence, quoted: doc.includes(`"${sentence}"`) }).toEqual({ sentence, quoted: true });
    }
  });

  test("the token deps carry BigQuery's scope and label, and createNodeTransport itself in production", async () => {
    const deps = bigQueryTokenSourceDeps();
    expect(BIGQUERY_SCOPE).toBe("https://www.googleapis.com/auth/bigquery");
    expect(deps.scope).toBe(BIGQUERY_SCOPE);
    expect(deps.provider).toBe("bigquery");
    expect(deps.maxResponseBytes).toBe(64 * 1024);
    expect(deps.createTransport).toBe(createNodeTransport);
    const before = Date.now();
    expect(deps.now()).toBeGreaterThanOrEqual(before);
    const signal = deps.timeoutSignal(60_000);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    // The shared refresh's deadline: a signal that never fires would leave a hung refresh joined until close().
    const short = deps.timeoutSignal(1);
    await new Promise((resolve) => short.addEventListener("abort", resolve, { once: true }));
    expect(short.reason).toBeInstanceOf(DOMException);
    expect((short.reason as DOMException).name).toBe("TimeoutError");
  });

  test("the project id rule: a letter first, then letters, digits, colons, dots or hyphens", () => {
    for (const id of ["my-proj-123", "example.com:my-proj", "a"]) expect(projectIdRefusal(id)).toBeNull();
    for (const id of ["..", ".", "a/b", "", "1abc", "a b", "a?b", `a${"b".repeat(201)}`]) {
      expect(projectIdRefusal(id)).toBe("a letter, then at most 200 letters, digits, colons, dots or hyphens");
    }
  });
});

describe("bigquery resolveBigQueryCredential", () => {
  test("a pasted key wins and needs no opt-in, on a browser-sent connection too", () => {
    expect(resolve(KEY, false)).toEqual({ type: "service_account", clientEmail: key.client_email, privateKey: PEM });
  });

  test("a pasted access token is taken as is, with or without a Bearer prefix, and needs no opt-in", () => {
    expect(resolve(TOKEN, undefined)).toEqual({ type: "access_token", token: TOKEN });
    expect(resolve(`Bearer ${TOKEN}`, undefined)).toEqual({ type: "access_token", token: TOKEN });
    expect(resolve(`  ${TOKEN}\n`, undefined)).toEqual({ type: "access_token", token: TOKEN });
  });

  test("an empty password on a connection that is not operator-seeded is refused, the opt-in notwithstanding", () => {
    for (const managed of [false, undefined]) {
      const error = refusal(() => resolve(" ", managed, { env: OPT_IN }));
      expect(error.message).toBe(S.browserEmpty);
      expect(error.provider).toBe("bigquery");
    }
  });

  test("an empty password on an operator seed without the opt-in is refused, and no file is read", () => {
    const io = fakeIo({ env: { BIGQUERY_SERVER_CREDENTIALS: "1" } });
    const error = refusal(() => resolveBigQueryCredential({ password: undefined, managed: true }, io));
    expect(error.message).toBe(S.seedWithoutOptIn);
    expect(io.fileReads).toEqual([]);
  });

  test("an empty password on a seed-file row read in literal mode is refused with its own sentence, the opt-in notwithstanding, and no file is read", () => {
    const io = fakeIo({ env: OPT_IN, files: { [WELL_KNOWN]: KEY } });
    const error = refusal(() =>
      resolveBigQueryCredential({ password: "", managed: true, [LITERAL_SEED_FILE]: true }, io),
    );
    expect(error.message).toBe(S.literalSeedFile);
    expect(error.provider).toBe("bigquery");
    expect(io.envReads).toEqual([]);
    expect(io.fileReads).toEqual([]);
  });

  test("a pasted key on a seed-file row read in literal mode is used as written", () => {
    expect(resolveBigQueryCredential({ password: KEY, managed: true, [LITERAL_SEED_FILE]: true }, fakeIo())).toEqual({
      type: "service_account",
      clientEmail: key.client_email,
      privateKey: PEM,
    });
  });

  test("GOOGLE_APPLICATION_CREDENTIALS is read when opted in", () => {
    const io = { env: { GOOGLE_APPLICATION_CREDENTIALS: "/etc/sa.json" }, files: { "/etc/sa.json": KEY } };
    expect(server(io).type).toBe("service_account");
  });

  test("a named file that cannot be read is an error that names no path, and nothing is logged", () => {
    const warn = spyOn(logger, "warn");
    try {
      const error = refusal(() => server({ env: { GOOGLE_APPLICATION_CREDENTIALS: "/nope/sa.json" } }));
      expect(error.message).toBe(G.namedFileUnreadable);
      expect(error.message).not.toContain("/nope");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("no file at all falls back to the metadata server", () => {
    expect(server({ env: { GCE_METADATA_HOST: "169.254.169.254:8080" } })).toEqual({
      type: "metadata",
      host: "169.254.169.254:8080",
    });
    expect(server()).toEqual({ type: "metadata", host: "metadata.google.internal" });
  });
});

describe("bigquery credentials: the changes of the move to the shared Google auth", () => {
  test("1: parse refusals use the shared sentences", () => {
    expect(refusal(() => resolve("{nope", false)).message).toBe(K.notJson);
    expect(refusal(() => resolve("not a token", false)).message).toBe(K.notACredential);
    expect(refusal(() => resolve("short", false)).message).toBe(K.notACredential);
    expect(refusal(() => resolve(JSON.stringify({ type: "external_account" }), false)).message).toBe(
      K.unsupportedType("external_account"),
    );
    expect(refusal(() => resolve(JSON.stringify({ client_email: "x" }), false)).message).toBe(K.noType);
  });

  test("2: empty fields are refused", () => {
    expect(refusal(() => resolve(JSON.stringify({ ...key, client_email: "" }), false)).message).toBe(
      G.serviceAccountFields,
    );
    expect(refusal(() => resolve(JSON.stringify({ ...user, refresh_token: "" }), false)).message).toBe(
      G.authorizedUserFields,
    );
  });

  test("3: a PKCS #1 key is refused at parse", () => {
    const pkcs1 = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\n";
    expect(refusal(() => resolve(JSON.stringify({ ...key, private_key: pkcs1 }), false)).message).toBe(
      G.privateKeyShape,
    );
  });

  test("4: private_key_id is kept for the assertion's kid", () => {
    expect(resolve(JSON.stringify({ ...key, private_key_id: "kid-1" }), false)).toMatchObject({
      privateKeyId: "kid-1",
    });
  });

  test("5: quota_project_id is checked with BigQuery's project rule and kept", () => {
    expect(resolve(JSON.stringify({ ...user, quota_project_id: "example.com:quota-1" }), false)).toEqual({
      type: "authorized_user",
      clientId: "id",
      clientSecret: "secret-value",
      refreshToken: "1//refresh",
      quotaProjectId: "example.com:quota-1",
    });
    expect(refusal(() => resolve(JSON.stringify({ ...user, quota_project_id: "1 bad" }), false)).message).toBe(
      G.quotaProject("a letter, then at most 200 letters, digits, colons, dots or hyphens"),
    );
  });

  test("6: a raw line feed inside a JSON string, as in a terminal-wrapped key, is removed before parsing", () => {
    const wrapped = KEY.replace("sa@p.iam", "sa@p\n.iam").replace("MIIEvQIB", "MIIE\r\nvQIB");
    expect(resolve(wrapped, false)).toMatchObject({ type: "service_account", clientEmail: key.client_email });
  });

  test("7: an ADC file holding a bare token is refused, and leading whitespace is trimmed", () => {
    const named = (text: string) =>
      server({ env: { GOOGLE_APPLICATION_CREDENTIALS: "/etc/adc" }, files: { "/etc/adc": text } });
    expect(refusal(() => named(TOKEN)).message).toBe(G.fileNotJson);
    expect(named(`\n  ${KEY}\n`).type).toBe("service_account");
  });

  test("8: a blank GOOGLE_APPLICATION_CREDENTIALS and a blank HOME count as unset", () => {
    expect(
      server({ env: { GOOGLE_APPLICATION_CREDENTIALS: "  ", HOME: " " }, files: { [WELL_KNOWN]: KEY } }).type,
    ).toBe("service_account");
  });

  test("9: a well-known file that exists and cannot be read is refused, while an absent one moves on", () => {
    expect(refusal(() => server({ fileErrors: { [WELL_KNOWN]: "EACCES" } })).message).toBe(G.wellKnownUnreadable);
    expect(server({ fileErrors: { [WELL_KNOWN]: "ENOENT" } }).type).toBe("metadata");
  });

  test("10: on Windows the well-known file is read under %APPDATA%", () => {
    const io = fakeIo({
      env: { ...OPT_IN, APPDATA: "C:\\Users\\s\\AppData\\Roaming" },
      platform: "win32",
      files: { "C:\\Users\\s\\AppData\\Roaming\\gcloud\\application_default_credentials.json": KEY },
    });
    expect(resolveBigQueryCredential({ password: "", managed: true }, io).type).toBe("service_account");
  });

  test("11: GCE_METADATA_HOST is validated: [::1]:8080 is kept, a scheme is refused", () => {
    expect(server({ env: { GCE_METADATA_HOST: "[::1]:8080" } })).toEqual({ type: "metadata", host: "[::1]:8080" });
    expect(refusal(() => server({ env: { GCE_METADATA_HOST: "http://x" } })).message).toBe(G.metadataHost);
  });

  test("13: a long or markup type is not echoed", () => {
    for (const type of ["<script>alert(1)</script>", `a${"b".repeat(80)}`]) {
      const error = refusal(() => resolve(JSON.stringify({ type }), false));
      expect(error.message).toBe(K.unknownType);
      expect(error.message).not.toContain(type);
    }
  });
});

describe("bigquery real credential IO", () => {
  test("reads the process environment, UTF-8 files, the home directory and the platform", () => {
    const io = bigQueryCredentialIo();
    expect(io.env).toBe(process.env);
    expect(io.homeDir()).toBe(homedir());
    expect(io.platform).toBe(process.platform);
    const file = join(mkdtempSync(join(tmpdir(), "bq-")), "sa.json");
    writeFileSync(file, KEY);
    expect(io.readFile(file)).toBe(KEY);
    expect(() => io.readFile(join(file, "missing"))).toThrow();
  });

  test("is the default IO, read at each call", () => {
    expect(resolveBigQueryCredential({ password: TOKEN, managed: false })).toEqual({
      type: "access_token",
      token: TOKEN,
    });
  });
});
