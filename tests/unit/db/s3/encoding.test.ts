/**
 * Request targets: path style only, a key's "/" sent as a literal "/", every other byte
 * outside the unreserved set as upper-case %XX once, "." and ".." key segments byte-exact, and a bucket that fails
 * the bucket rule refused before any request whatever the caller.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { compareEncodedPairs, objectPath, s3Query } from "@/lib/db/providers/objectstore/s3/encoding";
import { sourceAddressSentence } from "@/lib/db/providers/objectstore/s3/names";

describe("objectPath", () => {
  test.each([
    ["keys/plus+sign.txt", "/b/keys/plus%2Bsign.txt"],
    ["keys/lit%2Fname.txt", "/b/keys/lit%252Fname.txt"],
    ["with space.txt", "/b/with%20space.txt"],
    ["ü.txt", "/b/%C3%BC.txt"],
    ["a/./b", "/b/a/./b"],
    ["x/../y", "/b/x/../y"],
    ["a//c", "/b/a//c"],
    ["tilde~-._", "/b/tilde~-._"],
  ])("key %p is sent as %p", (key, path) => {
    expect(objectPath("b", key)).toBe(path);
  });

  test("a bucket alone is /<bucket>", () => {
    expect(objectPath("sales")).toBe("/sales");
  });

  test.each([[".."], ["a b"], ["a".repeat(256)]])("bucket %p is refused before any request", (bucket) => {
    let caught: unknown;
    try {
      objectPath(bucket, "k");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseConfigError);
    expect((caught as DatabaseConfigError).provider as string).toBe("s3");
    expect((caught as Error).message).toBe(sourceAddressSentence("bucket-pattern", { bucket, key: "k" }));
  });

  test("a key whose dot segments leave its bucket is refused before any request, whoever the caller", () => {
    let caught: unknown;
    try {
      objectPath("sales", "../other/x");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseConfigError);
    expect((caught as DatabaseConfigError).provider as string).toBe("s3");
    expect((caught as Error).message).toBe(
      sourceAddressSentence("key-dot-segments", { bucket: "sales", key: "../other/x" }),
    );
    expect(() => objectPath("sales", "")).toThrow(
      sourceAddressSentence("key-dot-segments", { bucket: "sales", key: "" }),
    );
  });

  test("a key whose dot segments stay inside its bucket is sent as given", () => {
    expect(objectPath("sp", "x/../dotdot.txt")).toBe("/sp/x/../dotdot.txt");
  });

  test("a backslash counts as a separator: backslash dot segments that leave the bucket are refused before any request", () => {
    for (const key of ["..\\other\\x", "a\\..\\..\\b", "\\.."]) {
      expect(() => objectPath("sales", key), key).toThrow(
        sourceAddressSentence("key-dot-segments", { bucket: "sales", key }),
      );
    }
  });

  test("a key with backslashes whose dot segments stay inside its bucket is sent, each backslash encoded", () => {
    expect(objectPath("sales", "dir\\file.txt")).toBe("/sales/dir%5Cfile.txt");
    expect(objectPath("sales", "a\\b\\..\\c")).toBe("/sales/a%5Cb%5C..%5Cc");
  });
});

describe("s3Query", () => {
  test("encodes each side and sorts by encoded name, then encoded value", () => {
    expect(
      s3Query([
        ["prefix", "a b/"],
        ["list-type", "2"],
        ["encoding-type", "url"],
        ["delimiter", "/"],
      ]),
    ).toBe("delimiter=%2F&encoding-type=url&list-type=2&prefix=a%20b%2F");
  });

  test("a subresource is written name=", () => {
    expect(s3Query([["versions", ""]])).toBe("versions=");
  });

  test("two values of one name are ordered by encoded value", () => {
    expect(
      s3Query([
        ["a", "z"],
        ["a", "b"],
      ]),
    ).toBe("a=b&a=z");
  });

  test("no pairs give the empty query", () => {
    expect(s3Query([])).toBe("");
  });
});

test("compareEncodedPairs is plain code-unit order on the name, then the value", () => {
  expect(compareEncodedPairs(["a", "1"], ["b", "0"])).toBeLessThan(0);
  expect(compareEncodedPairs(["B", "1"], ["a", "0"])).toBeLessThan(0);
  expect(compareEncodedPairs(["a", "2"], ["a", "1"])).toBeGreaterThan(0);
  expect(compareEncodedPairs(["a", "1"], ["a", "1"])).toBe(0);
});
