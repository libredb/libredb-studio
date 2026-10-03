/**
 * The one boundary a server's own text crosses before Studio shows, logs or audits it.
 *
 * A text that holds any form of the configured secret is withheld whole, never masked in part, because a partial
 * mask still shows the secret's length and its neighbours.
 */
import { describe, expect, test } from "bun:test";
import { secretForms, serverText } from "@/lib/db/utils/server-text";

const WITHHELD = "(the server's text was withheld because it contained the configured credential)";
const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

describe("secretForms", () => {
  test("lists the secret, its base64 without padding and its URI-encoded form", () => {
    expect(secretForms(["p@ss"])).toEqual(["p@ss", "cEBzcw", "p%40ss"]);
  });

  test("adds each segment of a value shaped as a JWT", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
    const forms = secretForms([token]);
    for (const segment of token.split(".")) expect(forms).toContain(segment);
  });

  test("adds no segment of a dotted value that is not shaped as a JWT", () => {
    // `encodeURIComponent("my.pass")` is `my.pass`, already listed, and its base64 is `bXkucGFzcw==`.
    expect(secretForms(["my.pass"])).toEqual(["my.pass", "bXkucGFzcw"]);
  });

  test("adds no segment of a dotted value whose segments are not base64url JSON, as a JWT's header and claims are", () => {
    expect(secretForms(["my.company.com"])).toEqual(["my.company.com", "bXkuY29tcGFueS5jb20"]);
    expect(secretForms(["a.b.c"])).toEqual(["a.b.c", "YS5iLmM"]);
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

  test("withholds a text holding one segment of a configured JWT", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
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
