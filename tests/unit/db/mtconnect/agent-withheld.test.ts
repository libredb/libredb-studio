/**
 * What an agent-mode handle withholds, decided from the agent's own model and stream rather than from a name list, and
 * how an asset document is rendered as text. Over the Institute's demo capture (`tests/fixtures/mtconnect/2.8.0.3/`),
 * whose Agent device reads two adapters.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderXmlElement } from "@/lib/db/providers/industrial/mtconnect/agent-read";
import {
  isUrlAttribute,
  itemWithheld,
  observationWithheld,
  withheldUrlWarning,
  withheldWarning,
  withoutAttributeSecrets,
  withoutUrlFieldSecrets,
  withoutUrlSecrets,
  withoutUrlSecretsAcross,
} from "@/lib/db/providers/industrial/mtconnect/agent-withheld";
import { indexMtconnectModel, type MtcModel } from "@/lib/db/providers/industrial/mtconnect/model";
import { readMtconnectXml, type MtcElement, type MtcObservation } from "@/lib/db/providers/industrial/mtconnect/xml";

const DEMO = path.resolve(import.meta.dir, "..", "..", "..", "fixtures", "mtconnect", "2.8.0.3");

function demoModel(): MtcModel {
  const read = readMtconnectXml(new Uint8Array(readFileSync(path.join(DEMO, "probe.xml"))));
  if (!read.ok) throw new Error(read.reason);
  const model = indexMtconnectModel(read.root);
  if (model === undefined) throw new Error("not a model");
  return model;
}

const observation = (componentType: string | undefined): MtcObservation => ({
  element: "AdapterURI",
  attributes: { dataItemId: "unknown_to_the_model" },
  text: "shdr://plant-adapter:7878",
  componentType,
  children: [],
});

describe("the adapter connections, read from the agent's own model", () => {
  test("every item inside an Adapter component is withheld, and only those", () => {
    const items = [...demoModel().items.values()];
    const withheld = items.filter(itemWithheld);
    // MEASURED on the demo: two adapters, okuma:7878 and mazak:7878, each with its own items.
    expect(withheld.length).toBeGreaterThan(0);
    for (const item of withheld) {
      expect(item.deviceName).toBe("Agent");
      expect(item.componentType).toBe("Adapter");
      expect(item.dataItemId).toMatch(/^_(okuma|mazak)_7878_/);
    }
    const kept = items.filter((item) => !itemWithheld(item));
    for (const item of kept) expect(item.dataItemId).not.toMatch(/_7878/);
    expect(kept.some((item) => item.deviceName === "Agent")).toBe(true);
  });

  test("an observation is withheld by its own component stream, even one the model does not know", () => {
    expect(observationWithheld(observation("Adapter"), undefined)).toBe(true);
    expect(observationWithheld(observation("Adapters"), undefined)).toBe(true);
    expect(observationWithheld(observation("Linear"), undefined)).toBe(false);
    expect(observationWithheld(observation(undefined), undefined)).toBe(false);
    const adapterItem = [...demoModel().items.values()].find(itemWithheld);
    expect(observationWithheld(observation("Linear"), adapterItem)).toBe(true);
  });

  test("the warning counts what was withheld, in the singular and the plural", () => {
    expect(withheldWarning(1, "observation")).toStartWith(
      "1 observation of the agent's adapter connections was withheld from this answer.",
    );
    expect(withheldWarning(4, "data item")).toStartWith(
      "4 data items of the agent's adapter connections were withheld from this answer.",
    );
  });
});

describe("a URL in an asset, its user name, password, query and fragment withheld", () => {
  test.each([
    ["ftp://not-a-real-user:not-a-real-password@files.example/p.nc", "ftp://[withheld]@files.example/p.nc", 1],
    ["https://files.example/p.nc?token=not-a-real-token", "https://files.example/p.nc?[withheld]", 1],
    ["https://files.example/p.nc#token=not-a-real-token", "https://files.example/p.nc#[withheld]", 1],
    ["HTTPS://u@files.example:8443/a/b?x=1#part", "HTTPS://[withheld]@files.example:8443/a/b?[withheld]", 2],
    ["see https://a.example/x and s3://u:p@bucket/key", "see https://[withheld]@bucket/key", 1],
    ["https://files.example/p.nc?a=1 and file:///opt/p.nc", "https://files.example/p.nc?[withheld]", 1],
    ["mail ops@plant.example or ftp://files.example/p.nc", "mail ops@plant.example or ftp://files.example/p.nc", 0],
  ])("%s reads %s", (text, kept, withheld) => {
    expect(withoutUrlSecrets(text)).toEqual({ text: kept, withheld });
  });

  // Each password is one WHATWG URL parsing accepts, or one a client that splits at the last @ would send: the values
  // are decoded attribute and element text, so a quote or an angle bracket is a character of the URL like any other.
  test.each([
    ["an @", "ftp://not-a-real-user:not@a@real@files.example/p.nc"],
    ["a single quote", "ftp://not-a-real-user:not'a'real@files.example/p.nc"],
    ["a double quote", 'ftp://not-a-real-user:not"a"real@files.example/p.nc'],
    ["angle brackets", "ftp://not-a-real-user:not<a>real@files.example/p.nc"],
    ["a slash", "ftp://not-a-real-user:not/a/real@files.example/p.nc"],
    ["a hash", "ftp://not-a-real-user:not#a#real@files.example/p.nc"],
    ["a question mark", "ftp://not-a-real-user:not?a?real@files.example/p.nc"],
    ["a space", "ftp://not-a-real-user:not a real@files.example/p.nc"],
  ])("a password holding %s leaves no part of the user name or password", (_what, text) => {
    const { text: kept, withheld } = withoutUrlSecrets(text);
    expect(kept).toBe("ftp://[withheld]@files.example/p.nc");
    expect(withheld).toBe(1);
    for (const part of ["not-a-real-user", "not", "real"]) expect(kept).not.toContain(part);
  });

  test("a URL with no scheme in front of its :// is still kept to what follows its last @", () => {
    expect(withoutUrlSecrets("://not-a-real-user:not-a-real-password@files.example/p.nc")).toEqual({
      text: "://[withheld]@files.example/p.nc",
      withheld: 1,
    });
  });

  // MEASURED with `new URL()` in Bun and Node: each of these yields the user name and the password. For http, https,
  // ws, wss and ftp any run of `/` or `\\` after the colon, or none, starts the authority, a scheme is read in any case,
  // and a tab or a line break anywhere is dropped before parsing; against a base URL of those schemes, two slashes or
  // backslashes start an authority too.
  test.each([
    [
      "two backslashes",
      "http:\\\\not-a-real-user:not-a-real-password@files.example/x",
      "http:\\\\[withheld]@files.example/x",
    ],
    [
      "mixed case and mixed slashes",
      "HTTP:\\/not-a-real-user:not-a-real-password@files.example",
      "HTTP:\\/[withheld]@files.example",
    ],
    ["four backslashes", "https:\\\\\\\\not-a-real-user:not-a-real-password@h", "https:\\\\\\\\[withheld]@h"],
    ["a tab between the slashes", "http:/\t/not-a-real-user:not-a-real-password@h", "http:/\t/[withheld]@h"],
    ["two slashes and no scheme", "//not-a-real-user:not-a-real-password@h/x", "//[withheld]@h/x"],
    ["two backslashes and no scheme", "\\\\not-a-real-user:not-a-real-password@h/x", "\\\\[withheld]@h/x"],
    ["a tab between two slashes and no scheme", "/\t/not-a-real-user:not-a-real-password@h/x", "/\t/[withheld]@h/x"],
    ["a URL after text", "at http:\\\\not-a-real-user:not-a-real-password@h", "at http:\\\\[withheld]@h"],
  ])("%s keeps no part of the user name or password", (_what, text, kept) => {
    expect(withoutUrlSecrets(text)).toEqual({ text: kept, withheld: 1 });
    for (const part of ["not-a-real-user", "not-a-real-password"]) expect(kept).not.toContain(part);
  });

  // A scheme with fewer than two slashes after its colon is withheld with the user name: `login:pw@h` and `ftp:pw@h`
  // cannot be told apart, so the word is cut from its start. These withheld only what followed the colon before.
  test.each([
    ["one slash", "http:/not-a-real-user:not-a-real-password@files.example/x", "[withheld]@files.example/x"],
    ["no slash", "http:not-a-real-user:not-a-real-password@files.example/x", "[withheld]@files.example/x"],
    ["ftp with no slash", "ftp:not-a-real-user:not-a-real-password@h", "[withheld]@h"],
    ["ws with no slash", "ws:not-a-real-user:not-a-real-password@h/x", "[withheld]@h/x"],
    ["wss with a backslash", "wss:\\not-a-real-user:not-a-real-password@h", "[withheld]@h"],
    ["mixed-case ftp, one slash", "FtP:/not-a-real-user:not-a-real-password@h", "[withheld]@h"],
    ["https with a port", "https:not-a-real-user:not-a-real-password@h:8443/a", "[withheld]@h:8443/a"],
    ["a tab in the scheme", "http\t:not-a-real-user:not-a-real-password@h", "[withheld]@h"],
    ["a line break in the scheme", "ht\ntp:not-a-real-user:not-a-real-password@h", "[withheld]@h"],
    ["a word after text", "see ftp:not-a-real-user:not-a-real-password@h", "see [withheld]@h"],
  ])("%s is withheld from the word's start", (_what, text, kept) => {
    expect(withoutUrlSecrets(text)).toEqual({ text: kept, withheld: 1 });
    for (const part of ["not-a-real-user", "not-a-real-password"]) expect(kept).not.toContain(part);
  });

  test("a URL with no slash still has its query and fragment withheld", () => {
    expect(withoutUrlSecrets("https:not-a-real-user:not-a-real-password@h/a?sig=not-a-real-signature#t")).toEqual({
      text: "[withheld]@h/a?[withheld]",
      withheld: 2,
    });
    expect(withoutUrlSecrets("http:files.example/p.nc?token=not-a-real-token")).toEqual({
      text: "http:files.example/p.nc?[withheld]",
      withheld: 1,
    });
  });

  // MEASURED: `new URL()` reads no user name or password from these, but the cut is by position and withholds them too.
  test.each([
    ["a mailto value", "mailto:operator@plant.example", "[withheld]@plant.example"],
    ["a urn value", "urn:not-a-real-user:not-a-real-password@h", "[withheld]@h"],
    ["a label before a mail address", "Contact: operator@plant.example", "Contact:[withheld]@plant.example"],
  ])("%s with an @ after its colon loses what lies before the @", (_what, text, kept) => {
    expect(withoutUrlSecrets(text)).toEqual({ text: kept, withheld: 1 });
  });

  // Every rule reads the value after NFKC and percent-decoding, and cuts each range it finds from the value as written.
  test.each([
    [
      "percent-encoded delimiters",
      "https%3A%2F%2Fnot-a-real-user%3Anot-a-real-password%40files.example",
      "https%3A%2F%2F[withheld]%40files.example",
      1,
    ],
    [
      "an encoded @ inside the password and a plain one after it",
      "ftp://not-a-real-user:not%40a-real-password@files.example/p.nc",
      "ftp://[withheld]@files.example/p.nc",
      1,
    ],
    [
      "lower-case escapes",
      "https%3a%2f%2fnot-a-real-user%3anot-a-real-password%40h",
      "https%3a%2f%2f[withheld]%40h",
      1,
    ],
    [
      "an escape encoded twice",
      "ftp%253A%252F%252Fnot-a-real-user%253Anot-a-real-password%2540h",
      "ftp%253A%252F%252F[withheld]%2540h",
      1,
    ],
    [
      "a fullwidth scheme",
      "\uff48\uff54\uff54\uff50\uff53\uff1a\uff0f\uff0fnot-a-real-user:not-a-real-password@h",
      "\uff48\uff54\uff54\uff50\uff53\uff1a\uff0f\uff0f[withheld]@h",
      1,
    ],
    ["a fullwidth @", "login not-a-real-user:not-a-real-password\uff20h", "login [withheld]\uff20h", 1],
    [
      "a fullwidth @ percent-encoded",
      "login not-a-real-user:not-a-real-password%EF%BC%A0h",
      "login [withheld]%EF%BC%A0h",
      1,
    ],
    ["a fullwidth query", "files.example/x.nc\uff1ftoken=not-a-real-token", "files.example/x.nc\uff1f[withheld]", 1],
  ])("%s keeps no secret", (_what, text, kept, withheld) => {
    expect(withoutUrlSecrets(text)).toEqual({ text: kept, withheld });
    for (const part of ["not-a-real-user", "not-a-real-password", "not-a-real-token"]) expect(kept).not.toContain(part);
  });

  test.each([
    ["a % that starts no escape", "100% at files.example/x", 0],
    ["a broken UTF-8 sequence", "see %C3%28 and %E2%82", 0],
    ["a truncated escape", "files%2", 0],
    ["a lone surrogate", "tool \ud800 note", 0],
    ["a compatibility character that expands", "\u3392 rated", 0],
  ])("%s is left as written", (_what, text, withheld) => {
    expect(withoutUrlSecrets(text)).toEqual({ text, withheld });
  });

  test("a character that expands under NFKC is withheld whole when a cut lands inside it", () => {
    // U+2100 reads "a/c": the slash inside it makes the word a path, so the query after it is withheld.
    expect(withoutUrlSecrets("\u2100?token=not-a-real-token")).toEqual({ text: "\u2100?[withheld]", withheld: 1 });
    // U+33C2 reads "a.m.": a cut that starts inside it takes the whole character.
    expect(withoutUrlSecrets("x:\u33c2@h")).toEqual({ text: "[withheld]@h", withheld: 1 });
  });

  test("a value still holding an escape after eight rounds of decoding is withheld whole", () => {
    let nested = "%40";
    for (let round = 0; round < 8; round += 1) nested = nested.replace("%", "%25");
    expect(withoutUrlSecrets(`not-a-real-user:not-a-real-password${nested}h`)).toEqual({
      text: "[withheld]",
      withheld: 1,
    });
    expect(withoutUrlSecrets(`x${"%25".repeat(1)}40`)).toEqual({ text: "x%2540", withheld: 0 });
  });

  test.each([
    [
      "a user name and password after a word",
      "login not-a-real-user:not-a-real-password@host",
      "login [withheld]@host",
    ],
    ["after a quote", "see 'not-a-real-user:not-a-real-password@host'", "see [withheld]@host'"],
    ["in brackets", "[not-a-real-user:not-a-real-password@host]", "[withheld]@host]"],
    ["a user name holding a slash", "x not/a-real-user:not-a-real-password@host", "x [withheld]@host"],
    ["a password starting with a slash", "x not-a-real-user:/not-a-real-password@host", "x [withheld]@host"],
    [
      "a scheme with two slashes keeps them",
      "x 'https://not-a-real-user:not-a-real-password@host'",
      "x 'https://[withheld]@host'",
    ],
  ])("a word holding an @ with a : before it: %s", (_what, text, kept) => {
    expect(withoutUrlSecrets(text)).toEqual({ text: kept, withheld: 1 });
  });

  test.each([
    ["a schemeless path", "files.example/x.nc?token=not-a-real-token", "files.example/x.nc?[withheld]"],
    ["a fragment", "files.example/x.nc#token=not-a-real-token", "files.example/x.nc#[withheld]"],
    ["a backslash path", "files.example\\x.nc?token=not-a-real-token", "files.example\\x.nc?[withheld]"],
    ["a word in prose", "get files.example/x.nc?token=not-a-real-token now", "get files.example/x.nc?[withheld] now"],
    ["a query holding an @", "a/b?t=not-a-real-token@h", "a/b?[withheld]"],
    ["a mail address and a path", "bob@plant.example/x?token=not-a-real-token", "bob@plant.example/x?[withheld]"],
  ])("a word holding a slash before a ? or #: %s", (_what, text, kept) => {
    expect(withoutUrlSecrets(text)).toEqual({ text: kept, withheld: 1 });
  });

  test.each([
    ["a question with no slash", "is T2 worn? yes"],
    ["a hash with no slash", "tool #4 of 12"],
    ["a ? before the slash", "why? a/b"],
  ])("%s is left as written", (_what, text) => {
    expect(withoutUrlSecrets(text)).toEqual({ text, withheld: 0 });
  });

  test("a password holding a ? keeps the host after its @", () => {
    expect(withoutUrlSecrets("x ftp://not-a-real-user:not?a#real@files.example/p.nc")).toEqual({
      text: "x ftp://[withheld]@files.example/p.nc",
      withheld: 1,
    });
    // A slash and then a ? in the password read as a path and its query, so the cut runs to the word's end.
    expect(withoutUrlSecrets("x not-a-real-user:not/a?real@files.example?t=not-a-real-token")).toEqual({
      text: "x [withheld]",
      withheld: 1,
    });
  });

  test("a query holding an @ of its own is withheld to its end, and so is the host the last @ leaves in between", () => {
    for (const text of [
      "https://not-a-real-user:p@h/x?t=not-a-real-token@not-a-real-tail",
      "https://not-a-real-user:p w@h/x?t=not-a-real-token@not-a-real-tail",
    ]) {
      expect(withoutUrlSecrets(text)).toEqual({ text: "https://[withheld]", withheld: 1 });
    }
  });

  test("a scheme after the last @ withholds nothing before it", () => {
    expect(withoutUrlSecrets("operator@plant.example via http:files.example/p.nc")).toEqual({
      text: "operator@plant.example via http:files.example/p.nc",
      withheld: 0,
    });
  });

  test.each([
    ["a URL with neither", "https://files.example/programs/p.nc"],
    ["a file URL", "file:///opt/programs/p.nc"],
    ["a mail address", "operator@plant.example"],
    ["a UNC path", "//fileserver/tools/T2.pdf"],
    ["a backslash UNC path", "\\\\fileserver\\tools\\T2.pdf"],
    ["a relative path", "tools/T2.pdf"],
    ["a time of day", "changed at 12:00 by the second shift"],
    ["plain text", "NEW & used"],
  ])("%s is left as written", (_what, text) => {
    expect(withoutUrlSecrets(text)).toEqual({ text, withheld: 0 });
  });

  // A consumer reads an element's text as one string, its children's text in place, so a URL split by the markup is read
  // over the joined text and each withheld part is cut out of every piece it touches.
  test("a part that crosses pieces is withheld from each of them, and counted once", () => {
    expect(
      withoutUrlSecretsAcross([
        "see https://not-a-real-user:",
        "not-a-",
        "real-password@files.example/x?sig=",
        "s",
        "ig",
      ]),
    ).toEqual({
      texts: [
        "see https://[withheld]",
        "[withheld]",
        "[withheld]@files.example/x?[withheld]",
        "[withheld]",
        "[withheld]",
      ],
      withheld: 2,
    });
  });

  test("an empty piece inside a withheld part stays empty", () => {
    expect(withoutUrlSecretsAcross(["http://not-a-real-user:", "", "not-a-real-password@h"])).toEqual({
      texts: ["http://[withheld]", "", "[withheld]@h"],
      withheld: 1,
    });
  });

  test("a later piece's ? or # widens the cut into it, since the pieces are one text", () => {
    expect(withoutUrlSecretsAcross(["http://files.example/x", "T#2 insert"])).toEqual({
      texts: ["http://files.example/x", "T#[withheld]"],
      withheld: 1,
    });
  });

  test("a URL inside one piece leaves the other pieces as written", () => {
    expect(
      withoutUrlSecretsAcross(["Manual at ", "http://not-a-real-user:not-a-real-password@h/m.pdf", " for T1"]),
    ).toEqual({
      texts: ["Manual at ", "http://[withheld]@h/m.pdf", " for T1"],
      withheld: 1,
    });
  });

  test("an empty part is withheld in the piece that holds the character before it", () => {
    expect(withoutUrlSecretsAcross(["http://", "@h/x", "?", ""])).toEqual({
      texts: ["http://[withheld]", "@h/x", "?[withheld]", ""],
      withheld: 2,
    });
    expect(withoutUrlSecretsAcross(["", "plain", ""])).toEqual({ texts: ["", "plain", ""], withheld: 0 });
  });

  test("the slashes after a scheme may sit in the next piece", () => {
    expect(withoutUrlSecretsAcross(["http:", "//not-a-real-user:", "not-a-real-password", "@h"])).toEqual({
      texts: ["http:", "//[withheld]", "[withheld]", "@h"],
      withheld: 1,
    });
  });

  test("the warning counts what was withheld, in the singular and the plural", () => {
    expect(withheldUrlWarning(1)).toStartWith(
      "1 user name and password, query string or fragment of a URL in an asset or an asset reference was withheld",
    );
    expect(withheldUrlWarning(3)).toStartWith(
      "3 user names and passwords, query strings or fragments of URLs in assets or asset references were withheld",
    );
  });
});

describe("a URL-typed field, withheld by its structure whatever its spelling", () => {
  test("href and xlink:href, under any prefix and in any case, are the URL-typed attributes", () => {
    for (const name of ["href", "xlink:href", "x:href", "HREF"]) expect(isUrlAttribute(name)).toBe(true);
    for (const name of ["source", "hrefs", "url", "xlinkhref"]) expect(isUrlAttribute(name)).toBe(false);
  });

  // The adversarial spellings that touch an href: an @ written as a character reference, which a URL parser reads as
  // text, and a colon or slash in a lookalike form; each leaves a value the parser refuses, so it is withheld whole.
  test.each([
    ["a decimal reference for @", "https://not-a-real-user:not-a-real-password&#64;h.example/x.nc"],
    ["a named reference for @", "https://not-a-real-user:not-a-real-password&commat;h.example/x.nc"],
    ["a hex reference for @", "https://not-a-real-user:not-a-real-password&#x40;h.example/x.nc"],
    ["a reference for @ with no password", "https://not-a-real-user&#64;h.example/x.nc"],
    [
      "a confusable colon and slashes",
      "https\ua789\u2215\u2215not-a-real-user\ua789not-a-real-password@h.example/x.nc",
    ],
    ["a value that is no URL", "not-a-real-user not-a-real-password"],
    ["a relative reference with no authority", "./objs/not-a-real-user:not-a-real-password@h"],
    ["a value the text rule leaves without its scheme", "x-file:not-a-real-user:not-a-real-password@h"],
    ["a scheme with no slashes and a user name the parser reads as a host", "https:not-a-real-user?n@h.example/x"],
  ])("%s is withheld whole", (_, value) => {
    expect(withoutUrlFieldSecrets(value)).toEqual({ text: "[withheld]", withheld: 1 });
  });

  test.each([
    [
      "a user name, a password and a query",
      "ftp://not-a-real-user:not-a-real-password@files.example/p.nc?token=not-a-real-token",
      "ftp://[withheld]@files.example/p.nc?[withheld]",
      2,
    ],
    [
      "backslashes and a mixed-case scheme, as the parser reads them",
      "HTTP:\\/not-a-real-user:not-a-real-password@files.example/p.nc",
      "http://[withheld]@files.example/p.nc",
      1,
    ],
    [
      "a password holding an @ and a quote, and a fragment",
      "ftp://not-a-real-user:odd@x'w@files.example/p3.nc#token=not-a-real-token",
      "ftp://[withheld]@files.example/p3.nc#[withheld]",
      2,
    ],
    [
      "a lookalike colon inside the user information",
      "https://not-a-real-user\ua789not-a-real-password@h.example/x.nc",
      "https://[withheld]@h.example/x.nc",
      1,
    ],
    [
      "a scheme-relative reference",
      "//not-a-real-user:not-a-real-password@h.example/x?not-a-real-token",
      "//[withheld]@h.example/x?[withheld]",
      2,
    ],
    ["an empty query", "http://h.example/?", "http://h.example/?[withheld]", 1],
    [
      "an encoded query in the path, read by the text rule first",
      "https://h.example/x%3Ftoken%3Dnot-a-real-token",
      "https://h.example/x%3F[withheld]",
      1,
    ],
    [
      "a user name the parser reads as a host, cut by the text rule first",
      "https://not-a-real-user?not-a-real-name@h.example/x.nc?token=not-a-real-token",
      "https://[withheld]@h.example/x.nc?[withheld]",
      2,
    ],
    ["a file location", "file:///opt/programs/p.nc", "file:///opt/programs/p.nc", 0],
    [
      "an IPv6 host and a port",
      "http://not-a-real-user:not-a-real-password@[::1]:8080/x",
      "http://[withheld]@[::1]:8080/x",
      1,
    ],
    [
      "an international host, serialized by the parser",
      "https://b\u00fccher.example/x",
      "https://xn--bcher-kva.example/x",
      0,
    ],
  ])("%s keeps the scheme, host, port and path", (_, value, kept, withheld) => {
    expect(withoutUrlFieldSecrets(value)).toEqual({ text: kept, withheld });
    expect(kept).not.toContain("not-a-real");
  });

  test.each([
    ["two slashes", "//not-a-real-user:not-a-real-password@h.example/x"],
    ["two backslashes", "\\\\not-a-real-user:not-a-real-password@h.example/x"],
  ])("a scheme-relative reference with %s reads its credentials against an https base, and loses them", (_, value) => {
    // An https base is a special scheme as http is, so the parser reads the reference's own authority the same way.
    const url = new URL(value, "https://a.invalid/");
    expect([url.username, url.password, url.host]).toEqual(["not-a-real-user", "not-a-real-password", "h.example"]);
    expect(withoutUrlFieldSecrets(value)).toEqual({ text: "//[withheld]@h.example/x", withheld: 1 });
  });

  test("an attribute that is not URL-typed keeps the text rule", () => {
    expect(withoutAttributeSecrets("source", "see https://not-a-real-user:x@h.example/x")).toEqual({
      text: "see https://[withheld]@h.example/x",
      withheld: 1,
    });
    expect(withoutAttributeSecrets("href", "see https://not-a-real-user:x@h.example/x")).toEqual({
      text: "[withheld]",
      withheld: 1,
    });
  });
});

describe("an asset's document rendered as text", () => {
  const element = (
    name: string,
    attributes: Record<string, string>,
    text: string,
    children: MtcElement[] = [],
    childOffsets: number[] = children.map(() => text.length),
  ): MtcElement => ({ name, attributes, text, children, childOffsets });

  test("an empty element closes itself, and attribute values are escaped", () => {
    expect(renderXmlElement(element("Tool", { note: 'a "b" & <c>' }, ""))).toBe(
      '<Tool note="a &quot;b&quot; &amp; &lt;c&gt;"/>',
    );
  });

  test("text before children, both escaped, a prefixed name kept as written", () => {
    expect(renderXmlElement(element("x:Life", {}, "1 < 2", [element("Status", {}, "NEW & used")]))).toBe(
      "<x:Life>1 &lt; 2<Status>NEW &amp; used</Status></x:Life>",
    );
  });

  test("text and children in the order the document holds them", () => {
    const mixed = element("Description", {}, "see  & more", [element("b", {}, "bold"), element("i", {}, "it")], [4, 6]);
    expect(renderXmlElement(mixed)).toBe("<Description>see <b>bold</b> &amp;<i>it</i> more</Description>");
  });
});
