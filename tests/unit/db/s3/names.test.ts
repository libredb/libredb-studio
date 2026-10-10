/**
 * The virtual key space `<bucket>/<key>`: how a Keys panel name splits, which names Studio
 * addresses, the Source tab's sentence for each refusal, how a name is shown in a sentence, and how a listed name is
 * decoded from `encoding-type=url`.
 */
import { describe, expect, test } from "bun:test";
import {
  bucketAddressRefusal,
  decodeListedName,
  joinVirtualKey,
  objectAddressRefusal,
  shellSpelling,
  shownName,
  sourceAddressSentence,
  splitVirtualKey,
} from "@/lib/db/providers/objectstore/s3/names";

describe("splitVirtualKey and joinVirtualKey", () => {
  test("a bucket alone, with or without its slash, is the bucket's own folder", () => {
    expect(splitVirtualKey("sales")).toEqual({ bucket: "sales", key: "" });
    expect(splitVirtualKey("sales/")).toEqual({ bucket: "sales", key: "" });
  });

  test("the first slash ends the bucket; the rest is the key, byte for byte", () => {
    expect(splitVirtualKey("sales/2026/a.csv")).toEqual({ bucket: "sales", key: "2026/a.csv" });
  });

  test.each([
    ["b", "/x"],
    ["b", "a//c"],
    ["b", "./x"],
    ["b", ""],
    ["b", "plus+sign and space ünïcødé-日本.txt"],
  ])("bucket %p and key %p round-trip", (bucket, key) => {
    expect(joinVirtualKey(bucket, key)).toBe(`${bucket}/${key}`);
    expect(splitVirtualKey(joinVirtualKey(bucket, key))).toEqual({ bucket, key });
  });

  test("b//x is the key /x of bucket b", () => {
    expect(splitVirtualKey("b//x")).toEqual({ bucket: "b", key: "/x" });
  });
});

describe("the addressability verdicts", () => {
  test("an addressable bucket and object answer undefined", () => {
    expect(bucketAddressRefusal("sales")).toBeUndefined();
    expect(objectAddressRefusal("sales", "2026/a.csv")).toBeUndefined();
    expect(objectAddressRefusal("sales", "a/./b/../c//d")).toBeUndefined();
  });

  test("a bucket failing the bucket rule is refused, and the bucket is checked before the key", () => {
    expect(bucketAddressRefusal("a b")).toBe("bucket-pattern");
    expect(bucketAddressRefusal("..")).toBe("bucket-pattern");
    expect(objectAddressRefusal("a b", "/x")).toBe("bucket-pattern");
    expect(objectAddressRefusal("a b", "")).toBe("bucket-pattern");
  });

  test("an empty key and a key beginning with / are refused", () => {
    expect(objectAddressRefusal("sales", "")).toBe("key-empty");
    expect(objectAddressRefusal("sales", "/root.txt")).toBe("key-leading-slash");
  });

  test("a key whose dot segments, empty segments dropped, climb out of its bucket or name the bucket itself is refused", () => {
    expect(objectAddressRefusal("sales", "../x")).toBe("key-dot-segments");
    expect(objectAddressRefusal("sales", "x/../../y")).toBe("key-dot-segments");
    expect(objectAddressRefusal("sales", "a/..")).toBe("key-dot-segments");
    expect(objectAddressRefusal("sales", "../other/x")).toBe("key-dot-segments");
    expect(objectAddressRefusal("sales", "./")).toBe("key-dot-segments");
    expect(objectAddressRefusal("sales", "a/../")).toBe("key-dot-segments");
    expect(objectAddressRefusal("sales", "a/b/../../")).toBe("key-dot-segments");
    expect(objectAddressRefusal("sales", "a//..")).toBe("key-dot-segments");
    expect(objectAddressRefusal("sales", "x//../../y")).toBe("key-dot-segments");
    expect(objectAddressRefusal("sales", "x//../../other/secret")).toBe("key-dot-segments");
  });

  test("a key whose dot segments resolve inside its bucket opens", () => {
    expect(objectAddressRefusal("sales", "a/../b")).toBeUndefined();
    expect(objectAddressRefusal("sales", "./x")).toBeUndefined();
    expect(objectAddressRefusal("sales", "sp/x/../dotdot.txt")).toBeUndefined();
    expect(objectAddressRefusal("sales", "sp/./dot.txt")).toBeUndefined();
    expect(objectAddressRefusal("sales", "a//")).toBeUndefined();
  });

  test("a backslash counts as a separator, so backslash dot segments that leave the bucket are refused", () => {
    expect(objectAddressRefusal("sales", "..\\other\\x")).toBe("key-dot-segments");
    expect(objectAddressRefusal("sales", "a\\..\\..\\b")).toBe("key-dot-segments");
    expect(objectAddressRefusal("sales", "\\..")).toBe("key-dot-segments");
    expect(objectAddressRefusal("sales", "a/b\\..\\..\\..\\c")).toBe("key-dot-segments");
  });

  test("a key with backslashes whose dot segments stay inside its bucket opens", () => {
    expect(objectAddressRefusal("sales", "dir\\file.txt")).toBeUndefined();
    expect(objectAddressRefusal("sales", "a\\b\\..\\c")).toBeUndefined();
  });

  test("a verdict is one of four fixed words and carries no character of the names passed", () => {
    const verdicts = [
      objectAddressRefusal("zz top", "q"),
      objectAddressRefusal("qq", "/zz"),
      objectAddressRefusal("qq", ""),
      objectAddressRefusal("qq", "../zz"),
    ];
    expect(verdicts).toEqual(["bucket-pattern", "key-leading-slash", "key-empty", "key-dot-segments"]);
    for (const verdict of verdicts) expect(verdict).not.toMatch(/z|q/);
  });
});

describe("sourceAddressSentence", () => {
  test("each verdict's sentence, verbatim", () => {
    expect(sourceAddressSentence("key-leading-slash", { bucket: "sales", key: "/root.txt" })).toBe(
      'Studio does not open "/root.txt": it begins with /, and a measured S3 server read a different key for such a name (Silo reads the key without its leading slash).',
    );
    expect(sourceAddressSentence("key-empty", { bucket: "sales", key: "" })).toBe(
      "A bucket's own folder has no object to open.",
    );
    expect(sourceAddressSentence("bucket-pattern", { bucket: "a b", key: "k" })).toBe(
      'Studio does not open bucket "a b": a bucket it addresses is 1 to 255 letters, digits, dots, hyphens or underscores, starting and ending with a letter or digit.',
    );
    expect(sourceAddressSentence("outside-pin", { bucket: "other", key: "k", pin: "sales" })).toBe(
      'This connection reads only bucket "sales"; bucket "other" is outside it.',
    );
    expect(sourceAddressSentence("key-dot-segments", { bucket: "sales", key: "../other/x" })).toBe(
      'Studio does not open "../other/x": once its . and .. segments are resolved, it names no object inside bucket "sales", and a server or proxy that resolves them would read something else.',
    );
  });

  test("an outside-pin call without a pin is a type error and throws, never a sentence about an empty bucket", () => {
    // @ts-expect-error the outside-pin case requires the pin
    expect(() => sourceAddressSentence("outside-pin", { bucket: "other", key: "k" })).toThrow();
  });
});

describe("shellSpelling", () => {
  test("spells a name as quoteShellWord does, and gives undefined for a CR, a NUL or a lone surrogate", () => {
    expect(shellSpelling("sales")).toBe("sales");
    expect(shellSpelling("a b")).toBe("'a b'");
    expect(shellSpelling("\ud83d\ude00")).toBe("\ud83d\ude00");
    for (const name of ["a\rb", "a\u0000b", "x\ud800", "\ud800x", "x\udc00", "\ud83d"]) {
      expect(shellSpelling(name)).toBeUndefined();
    }
  });
});

describe("shownName", () => {
  test("a short name is quoted as JSON", () => {
    expect(shownName('a"b\u0001')).toBe(JSON.stringify('a"b\u0001'));
  });

  test("a long name is cut at 120 code points, never inside a surrogate pair", () => {
    const name = `${"a".repeat(119)}\u{1F600}tail`;
    expect(shownName(name)).toBe(JSON.stringify(`${"a".repeat(119)}\u{1F600}`));
    expect(shownName("b".repeat(121))).toBe(JSON.stringify("b".repeat(120)));
  });
});

describe("decodeListedName", () => {
  test("MinIO's form style and Garage's percent style give the same name", () => {
    expect(decodeListedName("sp/with+space.txt")).toBe("sp/with space.txt");
    expect(decodeListedName("sp%2Fwith%20space.txt")).toBe("sp/with space.txt");
  });

  test("%2B is a plus, %25 a percent sign, and UTF-8 escapes decode", () => {
    expect(decodeListedName("plus%2Bsign")).toBe("plus+sign");
    expect(decodeListedName("percent%25sign")).toBe("percent%sign");
    expect(decodeListedName("%C3%BCn%C3%AFc%C3%B8d%C3%A9-%E6%97%A5%E6%9C%AC.txt")).toBe("ünïcødé-日本.txt");
  });

  test("a leading byte order mark is kept, never dropped", () => {
    expect(decodeListedName("%EF%BB%BFk")).toBe("\uFEFFk");
  });

  test.each(["bad%", "bad%2", "bad%G1", "%C3", "%FF", "%C3%28"])("%p is not text, so it is undefined", (encoded) => {
    expect(decodeListedName(encoded)).toBeUndefined();
  });
});
