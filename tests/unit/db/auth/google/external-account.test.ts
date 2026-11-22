/**
 * The external-account credential's parse: a closed world, read with no request. What it accepts, every field it
 * refuses and the sentence each refusal carries, under a neutral provider label.
 */
import { describe, expect, test } from "bun:test";
import {
  GOOGLE_EXTERNAL_ACCOUNT_SENTENCES as S,
  GOOGLE_STS_URL,
  parseExternalAccount,
} from "@/lib/db/auth/google/external-account";
import { DatabaseConfigError } from "@/lib/db/errors";

const AUDIENCE = "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/acme/providers/people";
const JWT = "urn:ietf:params:oauth:token-type:jwt";
const SOURCE_URL = "https://tokens.example/subject/alice?for=studio";

type Json = Record<string, unknown>;

/** A config that parses, with `over` laid on top; a key set to undefined is removed. */
function config(over: Json = {}, source: Json = {}): Json {
  const merged: Json = {
    type: "external_account",
    audience: AUDIENCE,
    subject_token_type: JWT,
    token_url: GOOGLE_STS_URL,
    credential_source: { url: SOURCE_URL, ...source },
    ...over,
  };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged;
}

const parse = (json: Json) => parseExternalAccount(json, "firestore");

function refusal(json: Json): string {
  try {
    parse(json);
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect((error as DatabaseConfigError).provider).toBe("firestore");
    return (error as Error).message;
  }
  throw new Error("the config was accepted");
}

describe("an external-account config that parses", () => {
  test("the shape gcloud writes: the audience, the subject type and a text source on its own origin", () => {
    expect(parse(config())).toEqual({
      type: "external_account",
      audience: AUDIENCE,
      subjectTokenType: JWT,
      source: {
        url: SOURCE_URL,
        origin: { scheme: "https", host: "tokens.example", port: 443 },
        headers: {},
        format: { type: "text" },
      },
    });
  });

  test("the two fields gcloud adds are accepted at their fixed values only", () => {
    const written = config({
      universe_domain: "googleapis.com",
      token_info_url: "https://sts.googleapis.com/v1/introspect",
    });
    expect(parse(written).audience).toBe(AUDIENCE);
    expect(refusal(config({ universe_domain: "example.com" }))).toBe(S.universe);
    expect(refusal(config({ token_info_url: "https://evil.example/introspect" }))).toBe(S.tokenInfoUrl);
  });

  test("an id_token subject, a port, a json format and headers in any case", () => {
    const parsed = parse(
      config(
        { subject_token_type: "urn:ietf:params:oauth:token-type:id_token" },
        {
          url: "https://tokens.example:8443/subject",
          headers: { "X-Pool": "acme", accept: "application/json" },
          format: { type: "json", subject_token_field_name: "id_token" },
        },
      ),
    );
    expect(parsed.subjectTokenType).toBe("urn:ietf:params:oauth:token-type:id_token");
    expect(parsed.source).toEqual({
      url: "https://tokens.example:8443/subject",
      origin: { scheme: "https", host: "tokens.example", port: 8443 },
      headers: { "x-pool": "acme", accept: "application/json" },
      format: { type: "json", field: "id_token" },
    });
    expect(Object.isFrozen(parsed.source.headers)).toBe(true);
  });

  test("an explicit text format is the default", () => {
    expect(parse(config({}, { format: { type: "text" } })).source.format).toEqual({ type: "text" });
  });

  test("plain http is accepted when the host is this machine, on its default port or another", () => {
    expect(parse(config({}, { url: "http://127.0.0.1:8099/subject" })).source.origin).toEqual({
      scheme: "http",
      host: "127.0.0.1",
      port: 8099,
    });
    expect(parse(config({}, { url: "http://localhost/subject" })).source.origin.port).toBe(80);
  });
});

describe("a closed world: a field that is not read is refused", () => {
  test.each([
    "service_account_impersonation_url",
    "service_account_impersonation",
    "client_id",
    "client_secret",
    "quota_project_id",
    "workforce_pool_user_project",
    "scopes",
  ])("%s", (field) => {
    expect(refusal(config({ [field]: "x" }))).toBe(S.unreadField(field));
  });

  test("a field name that is not shaped like one is not quoted back", () => {
    expect(refusal(config({ "<script>alert(1)</script>": 1 }))).toBe(S.unreadField("a field"));
    expect(refusal(config({ ["x".repeat(200)]: 1 }))).toBe(S.unreadField("a field"));
  });
});

describe("the audience, the subject type and the exchange URL", () => {
  test.each([
    ["a workforce pool", "//iam.googleapis.com/locations/global/workforcePools/staff/providers/okta", S.workforce],
    ["a project id in place of its number", AUDIENCE.replace("123456", "my-project"), S.audience],
    ["another service", AUDIENCE.replace("iam.googleapis.com", "iam.example.com"), S.audience],
    ["a trailing path", `${AUDIENCE}/extra`, S.audience],
    ["a number", 7, S.audience],
    ["nothing", undefined, S.audience],
  ])("an audience that is %s", (_name, audience, sentence) => {
    expect(refusal(config({ audience }))).toBe(sentence);
  });

  test.each([
    ["urn:ietf:params:aws:token-type:aws4_request"],
    ["urn:ietf:params:oauth:token-type:saml2"],
    [undefined],
    [7],
  ])("a subject_token_type of %p", (type) => {
    expect(refusal(config({ subject_token_type: type }))).toBe(S.subjectTokenType);
  });

  test.each([
    ["https://evil.example/v1/token"],
    ["https://sts.googleapis.com/v1/token/"],
    ["http://sts.googleapis.com/v1/token"],
    [undefined],
  ])("a token_url of %p", (url) => {
    expect(refusal(config({ token_url: url }))).toBe(S.tokenUrl);
  });
});

describe("the subject source is one URL", () => {
  test.each([
    ["no source", undefined],
    ["a source that is not a record", "https://tokens.example/subject"],
    ["a file", { file: "/var/run/secrets/token" }],
    ["an executable beside the URL", { url: SOURCE_URL, executable: { command: "/bin/token" } }],
    ["a cloud metadata source", { environment_id: "aws1", regional_cred_verification_url: "https://sts.example" }],
  ])("%s", (_name, source) => {
    expect(refusal(config({ credential_source: source }))).toBe(S.sourceUrlOnly);
  });

  test.each([
    ["not a URL", "not a url"],
    ["another scheme", "ftp://tokens.example/subject"],
    ["a user and password", "https://user:pw@tokens.example/subject"],
    ["a fragment", "https://tokens.example/subject#x"],
    ["a port out of range", "https://tokens.example:99999/subject"],
    ["a number", 7],
    ["longer than 2048 characters", `https://tokens.example/${"a".repeat(2048)}`],
  ])("a URL that is %s", (_name, url) => {
    expect(refusal(config({}, { url }))).toBe(S.sourceUrl);
  });

  test("a host the endpoint rules refuse is refused the same way", () => {
    expect(refusal(config({}, { url: "https://tokens_example!/subject" }))).toBe(S.sourceUrl);
  });

  test("plain http to another machine is refused, because the subject token is a credential", () => {
    expect(refusal(config({}, { url: "http://tokens.internal/subject" }))).toBe(S.sourceUrlPlaintext);
    expect(refusal(config({}, { url: "http://10.0.0.5:8080/subject" }))).toBe(S.sourceUrlPlaintext);
  });
});

describe("the subject headers", () => {
  test.each([
    ["not a record", ["x-pool", "acme"]],
    ["a value that is not a string", { "x-pool": 7 }],
    ["a value with a line break", { "x-pool": "acme\r\nx-evil: 1" }],
    ["a value longer than 1024 bytes", { "x-pool": "a".repeat(1025) }],
    ["a name that is not a token", { "x pool": "acme" }],
    ["a name longer than 128 characters", { ["x".repeat(129)]: "acme" }],
  ])("%s", (_name, headers) => {
    expect(refusal(config({}, { headers }))).toBe(S.headersShape);
  });

  test.each(["authorization", "Host", "content-type", "proxy-authorization", "connection"])(
    "%s is the transport's own",
    (name) => {
      expect(refusal(config({}, { headers: { [name]: "x" } }))).toBe(S.headerOwned(name.toLowerCase()));
    },
  );

  test("one name written twice, in two cases", () => {
    expect(refusal(config({}, { headers: { "X-Pool": "a", "x-pool": "b" } }))).toBe(S.headerRepeated("x-pool"));
  });

  test("no refusal repeats a header's value", () => {
    const secret = "s3cr3t-value-of-a-header";
    expect(refusal(config({}, { headers: { "x-pool": secret, authorization: secret } }))).not.toContain(secret);
  });
});

describe("the subject format", () => {
  test.each([
    ["not a record", "json"],
    ["json with no field name", { type: "json" }],
    ["json with an empty field name", { type: "json", subject_token_field_name: "" }],
    ["json with a field name that is not a string", { type: "json", subject_token_field_name: 7 }],
    ["json with a field name longer than 128 characters", { type: "json", subject_token_field_name: "f".repeat(129) }],
    ["text with a field name", { type: "text", subject_token_field_name: "token" }],
    ["another type", { type: "xml" }],
    ["a field that is not read", { type: "text", encoding: "base64" }],
  ])("%s", (_name, format) => {
    expect(refusal(config({}, { format }))).toBe(S.format);
  });
});
