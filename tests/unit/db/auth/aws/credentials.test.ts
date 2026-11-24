/**
 * Typed AWS keys: resolveAwsCredentials admits a key pair, with a session token when one is typed, and refuses half a
 * pair, a token without a pair and an empty pair, and every value outside its format rule; no refusal repeats a value,
 * which hostile values in each field prove. awsCredentialSecrets lists the secrets for secretForms in a fixed order.
 */
import { describe, expect, test } from "bun:test";
import {
  AWS_CREDENTIAL_SENTENCES,
  type AwsCredentialInput,
  awsCredentialSecrets,
  resolveAwsCredentials,
} from "@/lib/db/auth/aws/credentials";
import { DatabaseConfigError } from "@/lib/db/errors";

const ID = "AKIDEXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const TOKEN = "IQoJb3JpZ2luX2VjEXAMPLE//////////wEaCXVzLWVhc3QtMSJHMEUCIQ+EXAMPLE=";

const input = (over: Partial<AwsCredentialInput>): AwsCredentialInput => ({
  accessKeyId: ID,
  secretAccessKey: SECRET,
  sessionToken: undefined,
  ...over,
});

function refusal(run: () => unknown): DatabaseConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof DatabaseConfigError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const S = AWS_CREDENTIAL_SENTENCES;

describe("resolveAwsCredentials admits typed keys", () => {
  test("a key pair, with no session token", () => {
    const credentials = resolveAwsCredentials(input({}), "postgres");
    expect(credentials).toEqual({ accessKeyId: ID, secretAccessKey: SECRET });
    expect(Object.hasOwn(credentials, "sessionToken")).toBe(false);
  });

  test("a key pair with a session token", () => {
    expect(resolveAwsCredentials(input({ sessionToken: TOKEN }), undefined)).toEqual({
      accessKeyId: ID,
      secretAccessKey: SECRET,
      sessionToken: TOKEN,
    });
  });

  test("an empty session token is no session token", () => {
    expect(resolveAwsCredentials(input({ sessionToken: "" }), undefined)).toEqual({
      accessKeyId: ID,
      secretAccessKey: SECRET,
    });
  });

  test("the bounds of each rule: a 3- and a 512-character key ID, LocalStack's test, an 8192-character token", () => {
    for (const accessKeyId of ["abc", "x".repeat(512), "test", "!#$%&'()*+-.0:;<>?@[\\]^_`{|}~"]) {
      expect(resolveAwsCredentials(input({ accessKeyId }), undefined).accessKeyId).toBe(accessKeyId);
    }
    const sessionToken = "T".repeat(8192);
    expect(resolveAwsCredentials(input({ sessionToken }), undefined).sessionToken).toBe(sessionToken);
    expect(resolveAwsCredentials(input({ secretAccessKey: "s" }), undefined).secretAccessKey).toBe("s");
    expect(resolveAwsCredentials(input({ secretAccessKey: "sécrêt \u{1f511}" }), undefined).secretAccessKey).toBe(
      "sécrêt \u{1f511}",
    );
  });

  test("the result is frozen", () => {
    expect(Object.isFrozen(resolveAwsCredentials(input({ sessionToken: TOKEN }), undefined))).toBe(true);
    expect(Object.isFrozen(resolveAwsCredentials(input({}), undefined))).toBe(true);
  });
});

describe("resolveAwsCredentials refuses", () => {
  test.each<[string, Partial<AwsCredentialInput>, string]>([
    ["an empty pair", { accessKeyId: undefined, secretAccessKey: undefined }, S.keysRequired],
    ["an empty pair of empty strings", { accessKeyId: "", secretAccessKey: "" }, S.keysRequired],
    [
      "a token without a pair",
      { accessKeyId: undefined, secretAccessKey: "", sessionToken: TOKEN },
      S.tokenWithoutPair,
    ],
    ["a key ID without a secret", { secretAccessKey: undefined }, S.secretMissing],
    ["a key ID with an empty secret", { secretAccessKey: "" }, S.secretMissing],
    ["a secret without a key ID", { accessKeyId: undefined }, S.accessKeyIdMissing],
    ["a secret with an empty key ID", { accessKeyId: "" }, S.accessKeyIdMissing],
    ["a half pair with a token", { accessKeyId: "", sessionToken: TOKEN }, S.accessKeyIdMissing],
    ["a 2-character key ID", { accessKeyId: "ab" }, S.accessKeyIdShape],
    ["a 513-character key ID", { accessKeyId: "x".repeat(513) }, S.accessKeyIdShape],
    ["a key ID with a space", { accessKeyId: "AKID EXAMPLE" }, S.accessKeyIdShape],
    ["a key ID with a comma", { accessKeyId: "AKID,EXAMPLE" }, S.accessKeyIdShape],
    ["a key ID with a slash", { accessKeyId: "AKID/EXAMPLE" }, S.accessKeyIdShape],
    ["a key ID with an equals sign", { accessKeyId: "AKID=EXAMPLE" }, S.accessKeyIdShape],
    ["a key ID with a line feed", { accessKeyId: "AKID\nEXAMPLE" }, S.accessKeyIdShape],
    ["a key ID outside ASCII", { accessKeyId: "AKIDéXAMPLE" }, S.accessKeyIdShape],
    ["a secret with a lone surrogate", { secretAccessKey: "abc\ud800def" }, S.secretShape],
    ["a token with a space", { sessionToken: "IQoJ b3Jp" }, S.sessionTokenShape],
    ["a token with a line feed", { sessionToken: "IQoJ\nb3Jp" }, S.sessionTokenShape],
    ["a token outside ASCII", { sessionToken: "IQoJé" }, S.sessionTokenShape],
    ["an 8193-character token", { sessionToken: "T".repeat(8193) }, S.sessionTokenShape],
  ])("%s", (_label, over, sentence) => {
    const error = refusal(() => resolveAwsCredentials(input(over), "postgres"));
    expect(error.message).toBe(sentence);
    expect(error.provider).toBe("postgres");
  });

  test("the sentences", () => {
    expect(S).toEqual({
      keysRequired: "An AWS access key ID and secret access key are required",
      tokenWithoutPair:
        "An AWS session token was given without an access key ID and secret access key: a session token signs only with its key pair",
      accessKeyIdMissing: "The AWS secret access key was given without an access key ID",
      secretMissing: "The AWS access key ID was given without a secret access key",
      accessKeyIdShape:
        "The AWS access key ID must be 3 to 512 visible ASCII characters with no space, comma, slash or equals sign",
      secretShape: "The AWS secret access key is not well-formed text",
      sessionTokenShape: "The AWS session token must be at most 8192 visible ASCII characters with no space",
    });
    expect(Object.isFrozen(S)).toBe(true);
  });
});

describe("no refusal repeats a value", () => {
  // Each hostile value fails its own field's rule, carries a marker that must never surface, and looks like markup.
  const MARK = "LEAKMARK";
  const hostile: readonly [string, Partial<AwsCredentialInput>][] = [
    ["key ID", { accessKeyId: `<b>${MARK}</b> id` }],
    ["key ID, too long", { accessKeyId: `${MARK}${"x".repeat(600)}` }],
    ["secret", { secretAccessKey: `${MARK}\ud800` }],
    ["token", { sessionToken: `${MARK} "token"` }],
    ["token, too long", { sessionToken: `${MARK}${"T".repeat(9000)}` }],
    ["token without a pair", { accessKeyId: "", secretAccessKey: undefined, sessionToken: `${MARK}token` }],
    ["half pair, key ID", { accessKeyId: `${MARK}id`, secretAccessKey: "" }],
    ["half pair, secret", { accessKeyId: undefined, secretAccessKey: `${MARK}secret` }],
  ];

  test.each(hostile)("%s", (_label, over) => {
    const error = refusal(() => resolveAwsCredentials(input(over), "postgres"));
    expect(error.message).not.toContain(MARK);
    expect(JSON.stringify(error)).not.toContain(MARK);
    expect(String(error.stack)).not.toContain(MARK);
  });
});

describe("awsCredentialSecrets", () => {
  test("the secret access key, the session token when present, then the access key ID", () => {
    expect(awsCredentialSecrets({ accessKeyId: ID, secretAccessKey: SECRET })).toEqual([SECRET, ID]);
    expect(awsCredentialSecrets({ accessKeyId: ID, secretAccessKey: SECRET, sessionToken: TOKEN })).toEqual([
      SECRET,
      TOKEN,
      ID,
    ]);
  });

  test("never throws, whatever it is handed", () => {
    const odd = [
      { accessKeyId: "", secretAccessKey: "" },
      { accessKeyId: "a", secretAccessKey: "\ud800", sessionToken: "" },
      Object.freeze({ accessKeyId: ID, secretAccessKey: SECRET, sessionToken: TOKEN }),
    ];
    for (const credentials of odd) expect(() => awsCredentialSecrets(credentials)).not.toThrow();
    expect(awsCredentialSecrets({ accessKeyId: "a", secretAccessKey: "b", sessionToken: "" })).toEqual(["b", "", "a"]);
  });
});
