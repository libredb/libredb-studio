/**
 * The narrow XML reader: every refusal row with a minimal document, the five
 * entities and numeric references, whitespace kept, namespace prefixes removed, the depth and element bounds exactly
 * at and one past the limit, and Garage's raw 0x01 body.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { S3_XML_MAX_DEPTH, S3_XML_MAX_ELEMENTS } from "@/lib/db/providers/objectstore/s3/constants";
import { readXml, type XmlElement, type XmlReadResult, type XmlRefusal } from "@/lib/db/providers/objectstore/s3/xml";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const read = (text: string): XmlReadResult => readXml(bytes(text));
const root = (text: string): XmlElement => {
  const result = read(text);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.root;
};

describe("refusals", () => {
  test.each<[string, Uint8Array, XmlRefusal]>([
    ["bytes that are not UTF-8", new Uint8Array([0x3c, 0x61, 0x3e, 0xff, 0x3c, 0x2f, 0x61, 0x3e]), "not-utf8"],
    ["a declaration naming ISO-8859-1", bytes('<?xml version="1.0" encoding="ISO-8859-1"?><a/>'), "not-utf8"],
    ["a DOCTYPE", bytes("<!DOCTYPE a><a/>"), "doctype"],
    ["an ENTITY", bytes('<a><!ENTITY x "y"></a>'), "doctype"],
    ["a comment", bytes("<a><!-- c --></a>"), "markup"],
    ["a CDATA section", bytes("<a><![CDATA[x]]></a>"), "markup"],
    ["a processing instruction", bytes("<a><?pi x?></a>"), "markup"],
    ["a second declaration", bytes('<?xml version="1.0"?><?xml version="1.0"?><a/>'), "markup"],
    ["an unknown entity", bytes("<a>&foo;</a>"), "entity"],
    ["&#1;", bytes("<a>&#1;</a>"), "character"],
    ["&#xD800;", bytes("<a>&#xD800;</a>"), "character"],
    ["&#x110000;", bytes("<a>&#x110000;</a>"), "character"],
    ["a raw 0x01", new Uint8Array([0x3c, 0x61, 0x3e, 0x01, 0x3c, 0x2f, 0x61, 0x3e]), "character"],
    ["crossed tags", bytes("<a><b></a></b>"), "malformed"],
    ["an unclosed root", bytes("<a><b/>"), "malformed"],
    ["a bad name", bytes("<1a/>"), "malformed"],
    ["an unquoted attribute", bytes("<a b=c/>"), "malformed"],
    ["text before the root", bytes("x<a/>"), "malformed"],
    ["text after the root", bytes("<a/>x"), "malformed"],
    ["an ampersand with no semicolon", bytes("<a>&amp</a>"), "malformed"],
    ["nothing at all", bytes(""), "malformed"],
    ["a malformed numeric reference", bytes("<a>&#xZZ;</a>"), "malformed"],
  ])("%s is refused", (_case, input, reason) => {
    expect(readXml(input)).toEqual({ ok: false, reason });
  });

  test("a billion-laughs document is refused as doctype before any expansion", () => {
    const laughs = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>',
      "<lolz>&lol1;</lolz>",
    ].join("");
    expect(read(laughs)).toEqual({ ok: false, reason: "doctype" });
  });

  test("Garage's raw 0x01 listing is refused as character", () => {
    const body = readFileSync(join(import.meta.dir, "../../../fixtures/s3/xml/garage-list-objects-ctrl-0x01.xml"));
    expect(readXml(new Uint8Array(body))).toEqual({ ok: false, reason: "character" });
  });
});

describe("what is read", () => {
  test("a declaration naming utf-8 in any case and a leading byte order mark are accepted", () => {
    expect(root('<?xml version="1.0" encoding="utf-8"?><a/>').name).toBe("a");
    expect(readXml(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("<a/>")]))).toEqual({
      ok: true,
      root: { name: "a", children: [], text: "" },
    });
  });

  test("the five entities and numeric references are resolved", () => {
    expect(root("<a>&lt;&gt;&amp;&quot;&apos;&#34;&#x41;</a>").text).toBe('<>&"\'"A');
  });

  test("whitespace inside a value is kept", () => {
    expect(root("<Key> a  b\t</Key>").text).toBe(" a  b\t");
  });

  test("a namespace prefix is removed and attributes are dropped", () => {
    const element = root("<s3:Root xmlns:s3=\"urn:x\" id='1'><s3:Key>k</s3:Key></s3:Root>");
    expect(element).toEqual({ name: "Root", children: [{ name: "Key", children: [], text: "k" }], text: "" });
  });

  test("an element's text is its own character data alone", () => {
    const element = root("<a>x<b>y</b>z</a>");
    expect(element.text).toBe("xz");
    expect(element.children[0].text).toBe("y");
  });

  test("whitespace around the root is allowed", () => {
    expect(root("\n <a/>\n").name).toBe("a");
  });
});

describe("bounds", () => {
  test("depth exactly at the limit is read, one past it refused", () => {
    const nested = (depth: number) => `${"<a>".repeat(depth)}${"</a>".repeat(depth)}`;
    expect(read(nested(S3_XML_MAX_DEPTH)).ok).toBe(true);
    expect(read(nested(S3_XML_MAX_DEPTH + 1))).toEqual({ ok: false, reason: "too-deep" });
  });

  test("elements exactly at the limit are read, one past it refused", () => {
    const many = (elements: number) => `<r>${"<e/>".repeat(elements - 1)}</r>`;
    expect(read(many(S3_XML_MAX_ELEMENTS)).ok).toBe(true);
    expect(read(many(S3_XML_MAX_ELEMENTS + 1))).toEqual({ ok: false, reason: "too-many" });
  });
});
