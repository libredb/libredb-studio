import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { FIRESTORE_TYPE } from "@/lib/db/providers/document/firestore/constants";
import {
  type CredentialRules,
  GOOGLE_CREDENTIAL_SENTENCES as S,
  parseCredentialText,
  parseMetadataHost,
  readServerIdentity,
} from "@/lib/db/providers/document/firestore/google-credentials";
import { fakeSeams } from "../../../helpers/firestore-seams";

const QUOTA_RULE = "6 to 30 lowercase letters, digits or hyphens";
const rules: CredentialRules = {
  provider: FIRESTORE_TYPE,
  quotaProjectRefusal: (id) => (/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(id) ? null : QUOTA_RULE),
};

const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";
const SECRETS = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "kid-123", "user-secret-value", "1//refresh-token-value"];

const serviceAccount = {
  type: "service_account",
  project_id: "demo-p",
  private_key_id: "kid-123",
  private_key: PEM,
  client_email: "reader@demo-p.iam.gserviceaccount.com",
  client_id: "100000000000000000001",
  auth_uri: "https://evil.example/auth",
  token_uri: "https://evil.example/token",
  auth_provider_x509_cert_url: "https://evil.example/certs",
  client_x509_cert_url: "https://evil.example/x509",
  universe_domain: "evil.example",
};
const expectedServiceAccount = {
  type: "service_account",
  clientEmail: "reader@demo-p.iam.gserviceaccount.com",
  privateKey: PEM,
  privateKeyId: "kid-123",
} as const;
const authorizedUser = {
  type: "authorized_user",
  client_id: "cid.apps.googleusercontent.com",
  client_secret: "user-secret-value",
  refresh_token: "1//refresh-token-value",
  account: "",
  universe_domain: "googleapis.com",
};
const expectedAuthorizedUser = {
  type: "authorized_user",
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "user-secret-value",
  refreshToken: "1//refresh-token-value",
} as const;
const externalAccount = {
  type: "external_account",
  audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q",
  subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  token_url: "https://evil.example/sts",
  credential_source: { url: "http://evil.example/token", headers: { Metadata: "True" } },
};
const TOKEN = "ya29.a0AfB_byC-test-token_value.123";
const WELL_KNOWN = "/home/studio/.config/gcloud/application_default_credentials.json";

function refusal(run: () => unknown): DatabaseConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof DatabaseConfigError) return error;
    throw error;
  }
  throw new Error("expected a DatabaseConfigError");
}

/** The text cut into lines of `width` characters, as a terminal wraps a long paste. */
function wrap(text: string, width: number): string {
  const lines: string[] = [];
  for (let at = 0; at < text.length; at += width) lines.push(text.slice(at, at + width));
  return lines.join("\n");
}

describe("firestore parseCredentialText accepts", () => {
  test("a service-account key, keeping only what it signs with and dropping every URL field", () => {
    const parsed = parseCredentialText(JSON.stringify(serviceAccount), rules);
    expect(parsed).toEqual(expectedServiceAccount);
    expect(JSON.stringify(parsed)).not.toContain("evil.example");
  });

  test("the key pretty-printed, with CRLF line ends, terminal-wrapped, stripped of line feeds, or padded", () => {
    const pretty = JSON.stringify(serviceAccount, null, 2);
    const shapes = [
      pretty,
      pretty.replace(/\n/g, "\r\n"),
      wrap(JSON.stringify(serviceAccount), 64),
      wrap(pretty, 61).replace(/\n/g, "\r\n"),
      pretty.replace(/\n/g, ""),
      `\n  ${pretty}\n\n`,
    ];
    for (const shape of shapes) expect(parseCredentialText(shape, rules)).toEqual(expectedServiceAccount);
  });

  test("a key without private_key_id leaves privateKeyId out", () => {
    const rest = { ...serviceAccount, private_key_id: undefined };
    const expected = {
      type: "service_account",
      clientEmail: expectedServiceAccount.clientEmail,
      privateKey: PEM,
    } as const;
    expect(parseCredentialText(JSON.stringify(rest), rules)).toEqual(expected);
  });

  test("an authorized-user JSON, with and without a quota project that passes the rule", () => {
    expect(parseCredentialText(JSON.stringify(authorizedUser), rules)).toEqual(expectedAuthorizedUser);
    const withQuota = { ...authorizedUser, quota_project_id: "demo-quota-1" };
    expect(parseCredentialText(JSON.stringify(withQuota, null, 2), rules)).toEqual({
      ...expectedAuthorizedUser,
      quotaProjectId: "demo-quota-1",
    });
  });

  test("an access token, bare, padded or after Bearer in any case", () => {
    for (const text of [TOKEN, `Bearer ${TOKEN}`, `bearer   ${TOKEN}`, `  ${TOKEN}\n`, `Bearer\n${TOKEN}`]) {
      expect(parseCredentialText(text, rules)).toEqual({ type: "access_token", token: TOKEN });
    }
  });
});

describe("firestore parseCredentialText refuses", () => {
  const noKey = { ...serviceAccount, private_key: undefined };
  const noRefresh = { ...authorizedUser, refresh_token: undefined };
  const cases: readonly (readonly [string, string, string])[] = [
    ["an empty text", "", S.notACredential],
    ["a word", "hello", S.notACredential],
    ["a token with spaces inside", "ya29.abc def ghi jkl mno pqr", S.notACredential],
    ["a JSON array", "[1,2,3]", S.notACredential],
    ["broken JSON", '{"type": "service_account", "private_key": "not-a-key', S.notJson],
    ["JSON with no type", JSON.stringify({ client_email: "a@b.c" }), S.noType],
    ["JSON with a numeric type", JSON.stringify({ type: 7 }), S.noType],
    ["an external_account file", JSON.stringify(externalAccount), S.unsupportedType("external_account")],
    [
      "an impersonated_service_account file",
      JSON.stringify({
        type: "impersonated_service_account",
        service_account_impersonation_url: "https://evil.example",
      }),
      S.unsupportedType("impersonated_service_account"),
    ],
    [
      "an external_account_authorized_user file",
      JSON.stringify({ type: "external_account_authorized_user", token_url: "https://evil.example" }),
      S.unsupportedType("external_account_authorized_user"),
    ],
    ["an unknown type", JSON.stringify({ type: "gdch_service_account" }), S.unsupportedType("gdch_service_account")],
    ["a type that is not a name", JSON.stringify({ type: "<img src=x onerror=alert(1)>" }), S.unknownType],
    ["a key without private_key", JSON.stringify(noKey), S.serviceAccountFields],
    [
      "a key with an empty client_email",
      JSON.stringify({ ...serviceAccount, client_email: "" }),
      S.serviceAccountFields,
    ],
    [
      "a PKCS #1 key",
      JSON.stringify({ ...serviceAccount, private_key: PEM.replace(/PRIVATE KEY/g, "RSA PRIVATE KEY") }),
      S.privateKeyShape,
    ],
    ["a user file without refresh_token", JSON.stringify(noRefresh), S.authorizedUserFields],
    [
      "a user file whose quota project fails the rule",
      JSON.stringify({ ...authorizedUser, quota_project_id: "Bad Quota" }),
      S.quotaProject(QUOTA_RULE),
    ],
    [
      "a user file whose quota project is not a string",
      JSON.stringify({ ...authorizedUser, quota_project_id: 42 }),
      S.quotaProject("it is not a string"),
    ],
  ];

  for (const [label, text, sentence] of cases) {
    test(`${label}, with its own sentence and no secret in it`, () => {
      const error = refusal(() => parseCredentialText(text, rules));
      expect(error.message).toBe(sentence);
      expect(error.provider).toBe(FIRESTORE_TYPE);
      for (const secret of SECRETS) expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain("evil.example");
    });
  }
});

describe("firestore readServerIdentity", () => {
  test("GOOGLE_APPLICATION_CREDENTIALS names the file read first", () => {
    const io = fakeSeams({
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/srv/key.json" },
      files: { "/srv/key.json": JSON.stringify(serviceAccount, null, 2), [WELL_KNOWN]: JSON.stringify(authorizedUser) },
    });
    expect(readServerIdentity(io, rules)).toEqual(expectedServiceAccount);
    expect(io.fileReads).toEqual(["/srv/key.json"]);
  });

  test("a named file that cannot be read is an error, never the metadata server", () => {
    const io = fakeSeams({ env: { GOOGLE_APPLICATION_CREDENTIALS: "/srv/missing.json", GCE_METADATA_HOST: "meta" } });
    expect(refusal(() => readServerIdentity(io, rules)).message).toBe(S.namedFileUnreadable);
    expect(io.fileReads).toEqual(["/srv/missing.json"]);
  });

  test("a named file holding an ADC user JSON or an external_account JSON is read or refused as pasted", () => {
    const user = fakeSeams({
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/srv/adc.json" },
      files: { "/srv/adc.json": JSON.stringify({ ...authorizedUser, quota_project_id: "demo-quota-1" }, null, 2) },
    });
    expect(readServerIdentity(user, rules)).toEqual({ ...expectedAuthorizedUser, quotaProjectId: "demo-quota-1" });
    const external = fakeSeams({
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/srv/wif.json" },
      files: { "/srv/wif.json": JSON.stringify(externalAccount) },
    });
    expect(refusal(() => readServerIdentity(external, rules)).message).toBe(S.unsupportedType("external_account"));
  });

  test("a credentials file that is not a JSON object is refused", () => {
    const io = fakeSeams({
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/srv/token.txt" },
      files: { "/srv/token.txt": TOKEN },
    });
    expect(refusal(() => readServerIdentity(io, rules)).message).toBe(S.fileNotJson);
  });

  test("without the variable, gcloud's well-known file under the home directory, HOME first", () => {
    const io = fakeSeams({ files: { [WELL_KNOWN]: JSON.stringify(authorizedUser) } });
    expect(readServerIdentity(io, rules)).toEqual(expectedAuthorizedUser);
    expect(io.fileReads).toEqual([WELL_KNOWN]);
    const home = fakeSeams({ env: { HOME: "/home/ana" } });
    readServerIdentity(home, rules);
    expect(home.fileReads).toEqual(["/home/ana/.config/gcloud/application_default_credentials.json"]);
  });

  test("on Windows, the well-known file under %APPDATA%", () => {
    const path = "C:\\Users\\ana\\AppData\\Roaming\\gcloud\\application_default_credentials.json";
    const io = fakeSeams({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\ana\\AppData\\Roaming" },
      files: { [path]: JSON.stringify(authorizedUser) },
    });
    expect(readServerIdentity(io, rules)).toEqual(expectedAuthorizedUser);
    expect(io.fileReads).toEqual([path]);
  });

  test("on Windows without APPDATA, no file is read and the metadata server answers", () => {
    const io = fakeSeams({ platform: "win32" });
    expect(readServerIdentity(io, rules)).toEqual({ type: "metadata", host: "metadata.google.internal" });
    expect(io.fileReads).toEqual([]);
  });

  test("an absent well-known file falls through to the metadata server, GCE_METADATA_HOST first", () => {
    expect(readServerIdentity(fakeSeams(), rules)).toEqual({ type: "metadata", host: "metadata.google.internal" });
    const notADirectory = fakeSeams({
      fileErrors: { [WELL_KNOWN]: "ENOTDIR" },
      env: { GCE_METADATA_HOST: " 169.254.169.254:8080 " },
    });
    expect(readServerIdentity(notADirectory, rules)).toEqual({ type: "metadata", host: "169.254.169.254:8080" });
  });

  test("a well-known file that exists but cannot be read is an error", () => {
    const io = fakeSeams({ fileErrors: { [WELL_KNOWN]: "EACCES" } });
    expect(refusal(() => readServerIdentity(io, rules)).message).toBe(S.wellKnownUnreadable);
  });

  test("a GCE_METADATA_HOST that is not a host and optional port is refused before any token request", () => {
    const io = fakeSeams({ env: { GCE_METADATA_HOST: "http://evil.example" } });
    expect(refusal(() => readServerIdentity(io, rules)).message).toBe(S.metadataHost);
    // Another provider's label, so the assertion proves the label is passed through rather than defaulted.
    expect(refusal(() => readServerIdentity(io, { ...rules, provider: "bigquery" })).provider).toBe("bigquery");
  });
});

describe("firestore parseMetadataHost", () => {
  test("a name, an address and a bracketed IPv6 address, with or without a port", () => {
    expect(parseMetadataHost("metadata.google.internal")).toEqual({
      scheme: "http",
      host: "metadata.google.internal",
      port: 80,
    });
    expect(parseMetadataHost("169.254.169.254:8080")).toEqual({ scheme: "http", host: "169.254.169.254", port: 8080 });
    expect(parseMetadataHost("[fd00:ec2::254]:80")).toEqual({ scheme: "http", host: "[fd00:ec2::254]", port: 80 });
  });

  test("anything else is refused", () => {
    for (const value of [
      "",
      "http://meta",
      "meta/path",
      "meta:0",
      "meta:70000",
      "user@meta",
      "fd00::1",
      "[zz]:80",
      "meta:80a",
    ]) {
      expect(refusal(() => parseMetadataHost(value)).message).toBe(S.metadataHost);
    }
  });

  test("a refusal carries the provider it is given, on the shape check and on the host and port check", () => {
    expect(refusal(() => parseMetadataHost("http://meta", "bigquery")).provider).toBe("bigquery");
    expect(refusal(() => parseMetadataHost("meta:0", "bigquery")).provider).toBe("bigquery");
  });
});
