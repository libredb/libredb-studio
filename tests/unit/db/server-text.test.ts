/**
 * The one boundary a server's own text crosses before Studio shows, logs or audits it.
 *
 * A text that holds any form of the configured secret is withheld whole, never masked in part, because a partial
 * mask still shows the secret's length and its neighbours.
 */
import { describe, expect, test } from "bun:test";
import { holdsSecretForm, secretForms, serverText } from "@/lib/db/utils/server-text";

const WITHHELD = "(the server's text was withheld because it contained the configured credential)";
const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
const base64url = (value: string) => Buffer.from(value, "utf8").toString("base64url");
// Built from its parts, so no commit holds a literal shaped as a credential for the secret scan to report.
const fabricatedJwt = () => [base64url('{"alg":"HS256"}'), base64url('{"sub":"x"}'), base64url("signature")].join(".");
const unpadded = (value: string) => base64(value).replace(/=+$/, "");
/** The base64 of a value behind a prefix of `offset` bytes, without padding and without the characters the prefix touches. */
const base64At = (value: string, offset: 1 | 2) =>
  Buffer.concat([Buffer.alloc(offset), Buffer.from(value, "utf8")])
    .toString("base64")
    .replace(/=+$/, "")
    .slice(offset === 1 ? 2 : 3);
const hex = (length: number) => crypto.randomUUID().replace(/-/g, "").slice(0, length);

describe("secretForms", () => {
  test("lists the secret, its base64 at each byte offset without padding, and its URI-encoded form", () => {
    const secret = `${hex(8)}"<&\u00e9/\\${hex(8)}`;
    expect(secretForms([secret])).toEqual([
      secret,
      unpadded(secret),
      base64At(secret, 1),
      base64At(secret, 2),
      encodeURIComponent(secret),
    ]);
  });

  test("every form listed before is still listed", () => {
    const shapes = [
      () => crypto.randomUUID(),
      () => hex(12),
      () => `${hex(6)}"\\<>&/${hex(6)}`,
      () => `${hex(4)}.${hex(4)}`,
    ];
    for (let index = 0; index < 20; index++) {
      const secret = shapes[index % shapes.length]();
      const forms = secretForms([secret]);
      expect(forms).toContain(secret);
      expect(forms).toContain(unpadded(secret));
      expect(forms).toContain(encodeURIComponent(secret));
    }
  });

  test("adds each segment of a value shaped as a JWT", () => {
    const token = fabricatedJwt();
    const forms = secretForms([token]);
    for (const segment of token.split(".")) expect(forms).toContain(segment);
  });

  test("adds no segment of a dotted value that is not shaped as a JWT", () => {
    // Its `encodeURIComponent` form is the value itself, already listed.
    const value = `${hex(8)}.${hex(8)}`;
    expect(secretForms([value])).toEqual([value, unpadded(value), base64At(value, 1), base64At(value, 2)]);
  });

  test("adds no segment of a dotted value whose segments are not base64url JSON, as a JWT's header and claims are", () => {
    const value = `${hex(8)}.${hex(8)}.${hex(4)}`;
    expect(secretForms([value])).toEqual([value, unpadded(value), base64At(value, 1), base64At(value, 2)]);
  });

  test("skips an empty secret", () => {
    expect(secretForms([""])).toEqual([]);
  });
});

describe("serverText", () => {
  const secret = "s3cr3t/pass word";
  const forms = secretForms([secret]);

  test.each<[string, string]>([
    ["the secret itself", `auth failed for ${secret}`],
    ["its padded base64", `header Basic ${base64(secret)}`],
    ["its base64 without padding", `header Basic ${base64(secret).replace(/=+$/, "")}.`],
    ["its URI-encoded form", `GET /x?key=${encodeURIComponent(secret)}`],
  ])("withholds a text holding %s, whole", (_label, raw) => {
    expect(serverText(raw, forms)).toBe(WITHHELD);
  });

  test.each([0, 1, 2, 3, 4, 5])(
    "withholds an HTTP Basic header holding the secret behind a user name of length %d",
    (length) => {
      const generatedSecret = `${crypto.randomUUID()}"<&/`;
      const header = `Authorization: Basic ${base64(`${hex(length)}:${generatedSecret}`)}`;
      expect(serverText(header, secretForms([generatedSecret]))).toBe(WITHHELD);
    },
  );

  test("withholds an ApiKey header holding the secret behind its id", () => {
    // An id of 9 characters puts the secret 10 bytes in, where the base64 of the secret alone is not found.
    const generatedSecret = crypto.randomUUID();
    const header = `Authorization: ApiKey ${base64(`${hex(9)}:${generatedSecret}`)}`;
    expect(serverText(header, secretForms([generatedSecret]))).toBe(WITHHELD);
  });

  test("an offset form also matches a first character that differs from the secret's only in its top bits", () => {
    // A lowercase ASCII letter and its uppercase twin differ only in the bit 0x20, among the top 4 bits of the byte,
    // which the characters a one-byte prefix touches carry.
    const letter = String.fromCharCode(0x61 + Math.floor(Math.random() * 26));
    const rest = crypto.randomUUID();
    const header = `Authorization: Basic ${base64(`${hex(3)}:${letter.toUpperCase()}${rest}`)}`;
    expect(serverText(header, secretForms([`${letter}${rest}`]))).toBe(WITHHELD);
  });

  test("withholds a text holding one segment of a configured JWT", () => {
    const token = fabricatedJwt();
    expect(serverText("bad signature c2lnbmF0dXJl", secretForms([token]))).toBe(WITHHELD);
  });

  test("returns a text unchanged when only a short piece of a dotted password occurs in it", () => {
    const raw = "collection not found: comments";
    expect(serverText(raw, secretForms(["my.company.com"]))).toBe(raw);
    expect(serverText("unknown database", secretForms(["a.b.c"]))).toBe("unknown database");
  });

  test("returns a text with no form byte-identical", () => {
    const raw = "collection not found: docs (code 100)\n\ttrace 7f3a";
    expect(serverText(raw, forms)).toBe(raw);
  });

  test("withholds a one-character secret rather than skipping it", () => {
    expect(serverText("index out of range", secretForms(["x"]))).toBe(WITHHELD);
  });

  test("matches case-sensitively", () => {
    expect(serverText("secret rejected", secretForms(["Secret"]))).toBe("secret rejected");
  });

  test("reads a secret with pattern characters as plain text", () => {
    expect(serverText("rejected a+b(c)", secretForms(["a+b(c)"]))).toBe(WITHHELD);
    expect(serverText("rejected aab", secretForms(["a+b"]))).toBe("rejected aab");
  });

  test("serverText ignores an empty form", () => {
    expect(serverText("the server's own sentence", [""])).toBe("the server's own sentence");
  });
});

describe("holdsSecretForm", () => {
  test("holdsSecretForm is the predicate serverText applies", () => {
    const secret = `${crypto.randomUUID()}/pass word`;
    const forms = secretForms([secret]);
    for (const raw of [`auth failed for ${secret}`, "Secret rejected", "no form here", ""]) {
      expect(holdsSecretForm(raw, forms)).toBe(serverText(raw, forms) === WITHHELD);
    }
    expect(holdsSecretForm("anything", [""])).toBe(false);
    expect(holdsSecretForm(`rejected ${secret}`, forms)).toBe(true);
  });
});
