/**
 * Spec E9's ordered table and the cell bound of 5.4, one rule for every surface (spec 5.2).
 *
 * Each row is tested in its place in the order, beside the row it must win against, and every
 * withheld view is searched for the fixture's secret marker, which must never appear (R12 SEC-4).
 */
import { describe, expect, test } from "bun:test";
import type { EtcdBytes } from "@/lib/db/providers/keyvalue/etcd/client";
import {
  envelopeTypeMeta,
  isKubernetesEncrypted,
  isKubernetesEnvelope,
  viewKey,
  viewValue,
  withheldLabel,
} from "@/lib/db/providers/keyvalue/etcd/values";

const utf8 = (text: string): EtcdBytes => new TextEncoder().encode(text);
const bytes = (...parts: ReadonlyArray<string | readonly number[]>): EtcdBytes =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? Array.from(utf8(part)) : Array.from(part))));
const CELL = 65_536;
/** The marker spec 9's seed writes into every secret and envelope, which no answer may show. */
const SECRET = "libredb-fixture-secret";

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
}

/** One length-delimited protobuf field. */
const field = (number: number, content: readonly number[]): number[] => [
  number * 8 + 2,
  ...varint(content.length),
  ...content,
];

/**
 * A Kubernetes protobuf envelope, `k8s\x00` then a `runtime.Unknown` (SRC
 * landscape/k8s-v1.37.1__staging_src_k8s.io_apimachinery_pkg_runtime_generated.proto), whose raw
 * object carries the secret marker, grown to exactly `size` bytes when a size is given.
 */
function envelope(meta: { readonly apiVersion?: string; readonly kind?: string }, size?: number): EtcdBytes {
  const typeMeta = [
    ...(meta.apiVersion === undefined ? [] : field(1, Array.from(utf8(meta.apiVersion)))),
    ...(meta.kind === undefined ? [] : field(2, Array.from(utf8(meta.kind)))),
  ];
  const build = (padding: number) =>
    Uint8Array.from([
      0x6b,
      0x38,
      0x73,
      0x00,
      ...field(1, typeMeta),
      ...field(2, [...Array.from(utf8(SECRET)), ...new Array<number>(padding).fill(0x42)]),
      ...field(4, Array.from(utf8("application/vnd.kubernetes.protobuf"))),
    ]);
  if (size === undefined) return build(0);
  let padding = 0;
  while (build(padding).length !== size) padding += size - build(padding).length;
  return build(padding);
}

/** An encryption-at-rest value: the prefix kube-apiserver writes, then ciphertext, to `size` bytes. */
const encrypted = (prefix: string, size: number): EtcdBytes =>
  bytes(prefix, new Array<number>(size - utf8(prefix).length).fill(0x9c));

describe("the envelope and encryption recognisers (spec E9 rows 2 and 3)", () => {
  test("isKubernetesEncrypted and isKubernetesEnvelope read the two byte markers", () => {
    expect(isKubernetesEncrypted(utf8("k8s:enc:aescbc:v1:key1:xyz"))).toBe(true);
    expect(isKubernetesEncrypted(utf8("k8s:encrypted"))).toBe(false);
    expect(isKubernetesEnvelope(envelope({ apiVersion: "v1", kind: "Pod" }))).toBe(true);
    expect(isKubernetesEnvelope(utf8("k8s:x"))).toBe(false);
    expect(isKubernetesEnvelope(utf8("k8s"))).toBe(false);
  });

  test("envelopeTypeMeta reads the apiVersion and kind of the runtime.Unknown header, and nothing of the object", () => {
    expect(envelopeTypeMeta(envelope({ apiVersion: "v1", kind: "Pod" }))).toEqual({ apiVersion: "v1", kind: "Pod" });
    expect(envelopeTypeMeta(envelope({ apiVersion: "apps/v1" }))).toEqual({ apiVersion: "apps/v1" });
    expect(envelopeTypeMeta(envelope({ kind: "ConfigMap" }))).toEqual({ kind: "ConfigMap" });
  });

  test("envelopeTypeMeta reads the two fields in either order", () => {
    const typeMeta = [...field(2, Array.from(utf8("Pod"))), ...field(1, Array.from(utf8("v1")))];
    expect(envelopeTypeMeta(bytes([0x6b, 0x38, 0x73, 0x00], field(1, typeMeta)))).toEqual({
      apiVersion: "v1",
      kind: "Pod",
    });
  });

  test("envelopeTypeMeta answers undefined for a value that is no envelope, and {} for a header it cannot read", () => {
    expect(envelopeTypeMeta(utf8('{"kind":"Pod"}'))).toBeUndefined();
    const magic = [0x6b, 0x38, 0x73, 0x00];
    expect(envelopeTypeMeta(bytes(magic))).toEqual({});
    // Each case below would read as TypeMeta { apiVersion: "v1" } to a reader that ignored the rule it names.
    // A field that is not length-delimited ends the read.
    expect(envelopeTypeMeta(bytes(magic, [0x08, 0x04, 0x0a, 0x02], "v1"))).toEqual({});
    // A length that runs past the end of the value ends the read.
    expect(envelopeTypeMeta(bytes(magic, [0x0a, 0x10, 0x0a, 0x02], "v1"))).toEqual({});
    // A tag longer than five bytes is no header this reader reads.
    expect(envelopeTypeMeta(bytes(magic, [0x8a, 0x80, 0x80, 0x80, 0x80, 0x00, 0x04, 0x0a, 0x02], "v1"))).toEqual({});
    expect(envelopeTypeMeta(bytes(magic, [0x0a, 0xff]))).toEqual({});
  });

  test("a header name that is not plain bounded text is left out of the label", () => {
    const withControl = [...field(1, Array.from(utf8("v\n1"))), ...field(2, Array.from(utf8("Pod")))];
    expect(envelopeTypeMeta(bytes([0x6b, 0x38, 0x73, 0x00], field(1, withControl)))).toEqual({ kind: "Pod" });
    // DEL and the C1 controls, U+0085 among them, are control characters as well.
    for (const apiVersion of ["v\u007f1", "v\u00851"]) {
      const typeMeta = [...field(1, Array.from(utf8(apiVersion))), ...field(2, Array.from(utf8("Pod")))];
      expect(envelopeTypeMeta(bytes([0x6b, 0x38, 0x73, 0x00], field(1, typeMeta)))).toEqual({ kind: "Pod" });
    }
    const tooLong = [...field(1, Array.from(utf8("v".repeat(129)))), ...field(2, [0xff])];
    expect(envelopeTypeMeta(bytes([0x6b, 0x38, 0x73, 0x00], field(1, tooLong)))).toEqual({});
    const typeMetaWithMore = [...field(1, Array.from(utf8("v1"))), ...field(3, Array.from(utf8("ignored")))];
    expect(envelopeTypeMeta(bytes([0x6b, 0x38, 0x73, 0x00], field(1, typeMetaWithMore)))).toEqual({ apiVersion: "v1" });
  });
});

describe("spec E9's ordered table, row by row", () => {
  test("row 1: a key under a secrets root is withheld whatever its bytes", () => {
    const view = viewValue(
      utf8("/registry/secrets/default/token"),
      bytes(SECRET, new Array<number>(318 - SECRET.length).fill(0x41)),
      CELL,
    );
    expect(view).toEqual({
      text: "Kubernetes secret, 318 bytes",
      encoding: "withheld",
      withheld: "kubernetes-secret",
      byteLength: 318,
      cut: false,
    });
    expect(viewValue(utf8("registry/secrets/default/s"), utf8('{"a":1}'), CELL).encoding).toBe("withheld");
    expect(viewValue(utf8("/bootstrap/9f8b1c"), utf8("x"), CELL).text).toBe("Kubernetes secret, 1 byte");
    expect(viewValue(utf8("/kubernetes.io/secrets/ns/s"), new Uint8Array(), CELL).text).toBe(
      "Kubernetes secret, 0 bytes",
    );
  });

  test("row 1 wins over rows 2 to 5: a secret holding an envelope, an encrypted value, CBOR or JSON is a secret", () => {
    const key = utf8("/registry/secrets/default/token");
    for (const value of [
      envelope({ apiVersion: "v1", kind: "Secret" }),
      encrypted("k8s:enc:aescbc:v1:key1:", 64),
      bytes([0xd9, 0xd9, 0xf7, 0xa0]),
      utf8("{}"),
    ]) {
      expect(viewValue(key, value, CELL).withheld).toBe("kubernetes-secret");
    }
  });

  test("row 2: a k8s:enc: value is withheld, labelled with its provider and key name", () => {
    const view = viewValue(utf8("/registry/configmaps/default/cm"), encrypted("k8s:enc:aescbc:v1:key1:", 512), CELL);
    expect(view).toEqual({
      text: "Kubernetes encrypted (aescbc, key1), 512 bytes",
      encoding: "withheld",
      withheld: "kubernetes-encrypted",
      byteLength: 512,
      cut: false,
    });
    expect(viewValue(utf8("/x"), encrypted("k8s:enc:kms:v2:my-plugin:", 40), CELL).text).toBe(
      "Kubernetes encrypted (kms, my-plugin), 40 bytes",
    );
  });

  test("row 2 without readable names still withholds, and names only the size", () => {
    for (const prefix of [
      "k8s:enc:",
      "k8s:enc:aescbc:v1:",
      "k8s:enc::v1:key1:",
      `k8s:enc:${"p".repeat(129)}:v1:key1:`,
      // A last field that no colon closes is ciphertext, not a key name, so the label repeats none of it.
      `k8s:enc:aescbc:v1:${SECRET}`,
    ]) {
      const view = viewValue(utf8("/x"), utf8(prefix), CELL);
      expect(view).toMatchObject({ encoding: "withheld", withheld: "kubernetes-encrypted" });
      expect(view.text).toBe(`Kubernetes encrypted, ${utf8(prefix).length} bytes`);
      expect(JSON.stringify(view)).not.toContain(SECRET);
    }
  });

  test("row 3: a k8s\\x00 envelope is withheld, labelled with its TypeMeta", () => {
    const view = viewValue(
      utf8("/registry/pods/default/nginx"),
      envelope({ apiVersion: "v1", kind: "Pod" }, 1_204),
      CELL,
    );
    expect(view).toEqual({
      text: "Kubernetes protobuf (v1, Pod), 1,204 bytes",
      encoding: "withheld",
      withheld: "kubernetes-protobuf",
      byteLength: 1_204,
      cut: false,
    });
    expect(viewValue(utf8("/x"), bytes([0x6b, 0x38, 0x73, 0x00]), CELL).text).toBe("Kubernetes protobuf, 4 bytes");
  });

  test("rows 2 and 3 withhold under any prefix, the custom --etcd-prefix of spec 9 included", () => {
    expect(
      viewValue(utf8("/tenant-a/configmaps/default/cm"), envelope({ apiVersion: "v1", kind: "ConfigMap" }), CELL)
        .withheld,
    ).toBe("kubernetes-protobuf");
    expect(
      viewValue(utf8("/tenant-a/configmaps/default/cm-encrypted"), encrypted("k8s:enc:aescbc:v1:key1:", 30), CELL)
        .withheld,
    ).toBe("kubernetes-encrypted");
  });

  test("row 4: CBOR under a protected prefix is base64 as kubernetes-cbor, and outside one it is plain base64", () => {
    const cbor = bytes([0xd9, 0xd9, 0xf7, 0xa1, 0x64], "kind");
    expect(viewValue(utf8("/registry/example.com/widgets/default/w"), cbor, CELL)).toEqual({
      text: Buffer.from(cbor).toString("base64"),
      encoding: "kubernetes-cbor",
      byteLength: cbor.length,
      cut: false,
    });
    expect(viewValue(utf8("/app/cbor"), cbor, CELL).encoding).toBe("base64");
    // The tag is all three bytes d9 d9 f7: a value that shares only the first two is no CBOR.
    expect(viewValue(utf8("/registry/x/y"), bytes([0xd9, 0xd9, 0x00, 0x01]), CELL).encoding).toBe("base64");
  });

  test("row 5: JSON under a protected prefix is kubernetes-json, the slash-less roots included", () => {
    expect(viewValue(utf8("/registry/example.com/widgets/default/w"), utf8('{"kind":"Widget"}'), CELL)).toEqual({
      text: '{"kind":"Widget"}',
      encoding: "kubernetes-json",
      byteLength: 17,
      cut: false,
    });
    expect(viewValue(utf8("k3s/apiaddresses"), utf8('["10.0.0.5:6443"]'), CELL).encoding).toBe("kubernetes-json");
    expect(viewValue(utf8("/registry/health"), utf8("ok"), CELL).encoding).toBe("text");
    expect(viewValue(utf8("/registry/raw"), bytes([0xff]), CELL).encoding).toBe("base64");
  });

  test("row 6: any other JSON is json, UTF-8 text is text, and the rest is base64", () => {
    expect(viewValue(utf8("/apisix/routes/1"), utf8('{"uri":"/*"}'), CELL).encoding).toBe("json");
    expect(viewValue(utf8("compact_rev_key"), utf8("12345"), CELL)).toMatchObject({ text: "12345", encoding: "json" });
    expect(viewValue(utf8("/service/batman/leader"), utf8("postgresql0"), CELL)).toMatchObject({
      text: "postgresql0",
      encoding: "text",
    });
    expect(viewValue(utf8("/values/empty"), new Uint8Array(), CELL)).toEqual({
      text: "",
      encoding: "text",
      byteLength: 0,
      cut: false,
    });
    expect(viewValue(utf8("/values/bom"), utf8("\uFEFF{}"), CELL)).toMatchObject({
      text: "\uFEFF{}",
      encoding: "text",
    });
    expect(viewValue(utf8("/values/binary"), bytes([0xff, 0x00, 0x01]), CELL)).toMatchObject({
      text: "/wAB",
      encoding: "base64",
    });
  });

  test("withheldLabel answers the three labels, and undefined for a value that is shown", () => {
    expect(withheldLabel(utf8("/registry/secrets/a/b"), utf8("x"))).toBe("Kubernetes secret, 1 byte");
    expect(withheldLabel(utf8("/x"), encrypted("k8s:enc:aescbc:v1:key1:", 30))).toBe(
      "Kubernetes encrypted (aescbc, key1), 30 bytes",
    );
    expect(withheldLabel(utf8("/x"), envelope({ apiVersion: "v1", kind: "Pod" }, 200))).toBe(
      "Kubernetes protobuf (v1, Pod), 200 bytes",
    );
    // A header that holds only its kind, or only its apiVersion, is labelled with the one name it holds.
    const kindOnly = envelope({ kind: "Pod" });
    expect(withheldLabel(utf8("/x"), kindOnly)).toBe(`Kubernetes protobuf (Pod), ${kindOnly.length} bytes`);
    const apiVersionOnly = envelope({ apiVersion: "apps/v1" });
    expect(withheldLabel(utf8("/x"), apiVersionOnly)).toBe(
      `Kubernetes protobuf (apps/v1), ${apiVersionOnly.length} bytes`,
    );
    expect(withheldLabel(utf8("/registry/example.com/w"), utf8("{}"))).toBeUndefined();
    expect(withheldLabel(utf8("/app/x"), utf8("plain"))).toBeUndefined();
  });

  test("no withheld view carries a byte of the value, the fixture's secret marker included (R12 SEC-4)", () => {
    const withheld = [
      viewValue(utf8("/registry/secrets/default/token"), utf8(`{"token":"${SECRET}"}`), 8),
      viewValue(utf8("/registry/pods/default/nginx"), envelope({ apiVersion: "v1", kind: "Pod" }), 8),
      viewValue(utf8("/tenant-a/cm"), bytes("k8s:enc:aescbc:v1:key1:", SECRET), 8),
    ];
    for (const view of withheld) {
      const serialised = JSON.stringify(view);
      expect(serialised).not.toContain(SECRET);
      expect(serialised).not.toContain(Buffer.from(SECRET).toString("base64").slice(0, 12));
      expect(view.cut).toBe(false);
    }
  });
});

describe("the cell bound (spec 5.2, 5.4)", () => {
  test("text past the bound is cut at the bound, and its byte length is the whole value's", () => {
    expect(viewValue(utf8("/a"), utf8("abcdefghij"), 4)).toEqual({
      text: "abcd",
      encoding: "text",
      byteLength: 10,
      cut: true,
    });
    expect(viewValue(utf8("/a"), utf8('{"a":"bcdefg"}'), 5)).toMatchObject({
      text: '{"a":',
      encoding: "json",
      cut: true,
    });
    expect(viewValue(utf8("/a"), utf8("abcd"), 4)).toMatchObject({ text: "abcd", cut: false });
  });

  test("the cut never splits a surrogate pair", () => {
    expect(viewValue(utf8("/a"), utf8("a\u{1D11E}b"), 2)).toEqual({
      text: "a",
      encoding: "text",
      byteLength: 6,
      cut: true,
    });
    expect(viewValue(utf8("/a"), utf8("a\u{1D11E}b"), 3)).toMatchObject({ text: "a\u{1D11E}", cut: true });
  });

  test("base64 past the bound keeps whole 3-byte groups, so the cut cell still decodes to the value's first bytes", () => {
    const value = Uint8Array.from([0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const view = viewValue(utf8("/a"), value, 8);
    expect(view).toEqual({
      text: Buffer.from(value.subarray(0, 6)).toString("base64"),
      encoding: "base64",
      byteLength: 10,
      cut: true,
    });
    expect(Buffer.from(view.text, "base64")).toEqual(Buffer.from(value.subarray(0, 6)));
    expect(viewValue(utf8("/a"), Uint8Array.from([0xff, 1, 2]), 4)).toMatchObject({ text: "/wEC", cut: false });
    // Five bytes fit a bound of 6, but their base64 is 8 characters, so the bound counts the base64.
    expect(viewValue(utf8("/a"), Uint8Array.from([0xff, 1, 2, 3, 4]), 6)).toEqual({
      text: "/wEC",
      encoding: "base64",
      byteLength: 5,
      cut: true,
    });
  });

  test("a withheld label is never cut, whatever the bound", () => {
    expect(viewValue(utf8("/registry/secrets/a/b"), utf8("x"), 1)).toMatchObject({
      text: "Kubernetes secret, 1 byte",
      cut: false,
    });
  });

  test("Infinity is no bound: the whole text and the whole base64, never cut", () => {
    const long = "x".repeat(200_000);
    expect(viewValue(utf8("/a"), utf8(long), Number.POSITIVE_INFINITY)).toEqual({
      text: long,
      encoding: "text",
      byteLength: 200_000,
      cut: false,
    });
    expect(viewValue(utf8("/a"), new Uint8Array(3_000).fill(0xff), Number.POSITIVE_INFINITY)).toMatchObject({
      encoding: "base64",
      cut: false,
    });
  });

  test.each([0, -1, 2.5, Number.NaN, Number.NEGATIVE_INFINITY])("refuses the cell bound %p", (cellLimit) => {
    expect(() => viewValue(utf8("/a"), utf8("x"), cellLimit)).toThrow(
      "The cell bound is a whole number of characters, 1 or more, or Infinity for none",
    );
  });
});

describe("viewKey (spec 5.2's key_encoding)", () => {
  test("a key is text, or base64 when it is not UTF-8, and is never withheld or cut", () => {
    expect(viewKey(utf8("/registry/secrets/default/token"))).toEqual({
      text: "/registry/secrets/default/token",
      encoding: "text",
    });
    expect(viewKey(bytes("/", [0xff, 0xfe], "/x"))).toEqual({
      text: Buffer.from(bytes("/", [0xff, 0xfe], "/x")).toString("base64"),
      encoding: "base64",
    });
    expect(viewKey(utf8("x".repeat(100_000))).text.length).toBe(100_000);
  });
});

describe("bytes that are a view into a larger buffer", () => {
  test("a value and a key are read from their own byteOffset, whole or cut", () => {
    // protobufjs decodes a bytes field as Buffer.prototype.slice of the message, a view at a nonzero byteOffset.
    const message = Uint8Array.from([0x0a, 0x03, 0xff, 0xfe, 0xfd, 0x12]);
    const view = message.subarray(2, 5);
    expect(viewValue(utf8("/a"), view, CELL)).toMatchObject({ text: "//79", encoding: "base64" });
    expect(viewKey(view)).toEqual({ text: "//79", encoding: "base64" });
    expect(viewValue(utf8("/a"), Uint8Array.from([9, 0xff, 1, 2, 3, 4]).subarray(1), 4)).toMatchObject({
      text: "/wEC",
      cut: true,
    });
  });
});
