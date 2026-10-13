/**
 * The MTConnect reader against the real answers, and against the hostile inputs of MT-S5.
 *
 * The thirteen fixtures under `tests/fixtures/mtconnect/2.8.0.3/` are verbatim answers from the
 * Institute's demo agent (their provenance is in that directory's README). They are here because
 * the reader's whole reason for existing is a measurement: S3's reader refuses seven of these at
 * the `<?xml-stylesheet?>` instruction and returns the other six with every attribute dropped, so
 * nothing usable comes out of any of the thirteen. This suite holds the new reader to the opposite:
 * all thirteen parse AND the data is reachable.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readMtconnectXml,
  streamMtconnectObservations,
  type MtcElement,
} from "@/lib/db/providers/industrial/mtconnect/xml";
import { MTC_XML_BOUNDS } from "@/lib/db/providers/industrial/mtconnect/xml-bounds";

const DIR = join(import.meta.dir, "../../../fixtures/mtconnect/2.8.0.3");
const FIXTURES = readdirSync(DIR)
  .filter((name) => name.endsWith(".xml"))
  .sort();
const bytes = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));
const child = (element: MtcElement, name: string): MtcElement | undefined =>
  element.children.find((candidate) => candidate.name === name);

describe("the captured answers", () => {
  test("there are thirteen of them", () => {
    expect(FIXTURES.length).toBe(13);
  });

  test.each(FIXTURES)("%s parses", (name) => {
    const result = readMtconnectXml(bytes(name));
    expect(result.ok).toBe(true);
  });

  test.each(FIXTURES)("%s keeps its root's attributes, prefixes included", (name) => {
    const result = readMtconnectXml(bytes(name));
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    const keys = Object.keys(result.root.attributes);
    // Every document declares the default namespace, the `m` prefix and the schema location.
    expect(keys).toContain("xmlns");
    expect(keys).toContain("xmlns:m");
    expect(keys).toContain("xsi:schemaLocation");
    expect(result.root.name).toMatch(/^MTConnect(Devices|Streams|Assets|Error)$/);
  });

  test.each(FIXTURES)("%s has a readable Header", (name) => {
    const result = readMtconnectXml(bytes(name));
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    const header = child(result.root, "Header");
    expect(header).toBeDefined();
    // Header attributes S3's reader dropped. These three are on every document.
    expect(header?.attributes.instanceId).toBe("1791206842");
    expect(header?.attributes.version).toBe("2.8.0.3");
    expect(header?.attributes.sender).toBe("demo.mtconnect.org");
  });

  test("the Header's attribute set depends on the document, MEASURED", () => {
    // Twelve of the thirteen carry `bufferSize`; the assets document carries none of the buffer
    // or sequence fields and answers with the asset counters instead. So buffer facts cannot be
    // taken from an assets read, the way they cannot be taken from a `from`/`to` read.
    const assets = readMtconnectXml(bytes("assets.xml"));
    if (!assets.ok) throw new Error(assets.reason);
    const assetHeader = child(assets.root, "Header");
    expect(assetHeader?.attributes.bufferSize).toBeUndefined();
    expect(assetHeader?.attributes.firstSequence).toBeUndefined();
    expect(assetHeader?.attributes.assetBufferSize).toBe("1024");
    expect(assetHeader?.attributes.assetCount).toBe("66");

    for (const name of FIXTURES.filter((candidate) => candidate !== "assets.xml")) {
      const result = readMtconnectXml(bytes(name));
      if (!result.ok) throw new Error(result.reason);
      expect(child(result.root, "Header")?.attributes.bufferSize).toBe("131072");
    }
  });
});

describe("the data behind the attributes", () => {
  test("probe reaches a data item's attributes twelve levels down", () => {
    const result = readMtconnectXml(bytes("probe.xml"));
    if (!result.ok) throw new Error(result.reason);
    let deepest = 0;
    let dataItems = 0;
    const walk = (element: MtcElement, depth: number): void => {
      deepest = Math.max(deepest, depth);
      if (element.name === "DataItem") {
        dataItems++;
        expect(element.attributes.id).toBeTruthy();
        expect(element.attributes.category).toMatch(/^(SAMPLE|EVENT|CONDITION)$/);
      }
      for (const kid of element.children) walk(kid, depth + 1);
    };
    walk(result.root, 1);
    expect(dataItems).toBe(244);
    expect(deepest).toBe(12);
  });

  test("current carries one observation for every data item, each with its own id", () => {
    const ids = new Set<string>();
    const result = streamMtconnectObservations(bytes("current.xml"), (observation) => {
      const id = observation.attributes.dataItemId;
      expect(id).toBeTruthy();
      ids.add(id);
    });
    expect(result).toEqual({ ok: true, count: 244 });
    expect(ids.size).toBe(244);
  });

  test("an asset document keeps its nested elements and their attributes", () => {
    const result = readMtconnectXml(bytes("assets.xml"));
    if (!result.ok) throw new Error(result.reason);
    // The assets are under an <Assets> wrapper, not directly under the root.
    const wrapper = child(result.root, "Assets");
    expect(wrapper).toBeDefined();
    const first = wrapper?.children.find((element) => element.name === "CuttingTool");
    expect(first?.attributes.assetId).toBeTruthy();
    expect(first?.attributes.toolId).toBeTruthy();
    expect(first?.attributes.deviceUuid).toBeTruthy();
    const lifeCycle = first ? child(first, "CuttingToolLifeCycle") : undefined;
    expect(lifeCycle).toBeDefined();
    expect(wrapper?.children.filter((element) => element.name === "CuttingTool").length).toBe(66);
  });

  test("a typed error keeps the bounds its QueryParameter carries", () => {
    const result = readMtconnectXml(bytes("error-out-of-range.xml"));
    if (!result.ok) throw new Error(result.reason);
    const errors = child(result.root, "Errors");
    const outOfRange = errors ? child(errors, "OutOfRange") : undefined;
    expect(outOfRange?.attributes.errorCode).toBe("OUT_OF_RANGE");
    const parameter = outOfRange ? child(outOfRange, "QueryParameter") : undefined;
    expect(parameter?.attributes.name).toBe("from");
    // These two are how the provider tells "nothing new" from "rows were missed" without a
    // second Header read: Minimum is firstSequence, Maximum is nextSequence.
    expect(child(parameter as MtcElement, "Minimum")?.text).toBe("29516471");
    expect(child(parameter as MtcElement, "Maximum")?.text).toBe("29647543");
  });

  test("the other typed error's QueryParameter carries a different child set", () => {
    const result = readMtconnectXml(bytes("error-invalid-parameter-value.xml"));
    if (!result.ok) throw new Error(result.reason);
    const parameter = child(
      child(child(result.root, "Errors") as MtcElement, "InvalidParameterValue") as MtcElement,
      "QueryParameter",
    );
    expect(child(parameter as MtcElement, "Format")?.text).toBe("int32");
    expect(child(parameter as MtcElement, "Type")?.text).toBe("integer");
    expect(child(parameter as MtcElement, "Minimum")).toBeUndefined();
  });
});

describe("the stylesheet instruction is optional per document", () => {
  test("probe carries one and assets does not, and both parse", () => {
    const probe = new TextDecoder().decode(bytes("probe.xml"));
    const assets = new TextDecoder().decode(bytes("assets.xml"));
    expect(probe).toContain("<?xml-stylesheet");
    expect(assets).not.toContain("<?xml-stylesheet");
    expect(readMtconnectXml(bytes("probe.xml")).ok).toBe(true);
    expect(readMtconnectXml(bytes("assets.xml")).ok).toBe(true);
  });
});

describe("the walker inherits what the observation does not carry", () => {
  test("component identity comes from the enclosing ComponentStream", () => {
    const seen: Array<{ element: string; componentId?: string; componentType?: string; device?: string }> = [];
    streamMtconnectObservations(bytes("current.xml"), (observation) => {
      // MEASURED: the observation element carries none of these three.
      expect(observation.attributes.componentId).toBeUndefined();
      expect(observation.attributes.component).toBeUndefined();
      seen.push({
        element: observation.element,
        componentId: observation.componentId,
        componentType: observation.componentType,
        device: observation.deviceName,
      });
    });
    expect(seen.length).toBe(244);
    expect(seen.every((row) => row.componentId !== undefined)).toBe(true);
    expect(seen.every((row) => row.componentType !== undefined)).toBe(true);
    expect(new Set(seen.map((row) => row.device))).toEqual(new Set(["Agent", "OKUMA", "Mazak"]));
  });

  test("a DATA_SET observation hands back its entries as children", () => {
    const sets: Array<readonly MtcElement[]> = [];
    streamMtconnectObservations(bytes("current.xml"), (observation) => {
      if (observation.children.length > 0) sets.push(observation.children);
    });
    // COUNTED: exactly 3 of the 244 observations carry children, and the fixture is thin here on
    // purpose rather than by accident. That thinness is the point: a reader that treated every
    // observation as a container would report 244 and fail this line.
    expect(sets).toHaveLength(3);
    expect(sets.every((entries) => entries.every((entry) => entry.name === "Entry"))).toBe(true);
    expect(sets.every((entries) => entries.every((entry) => entry.attributes.key !== undefined))).toBe(true);
    // The entries are not all one key, so a reader returning a constant key fails too.
    const keys = sets.flatMap((entries) => entries.map((entry) => entry.attributes.key));
    expect(new Set(keys).size).toBeGreaterThan(1);
  });

  test("returning false stops the walk, which is how a row cap ends a read", () => {
    let seen = 0;
    const result = streamMtconnectObservations(bytes("current.xml"), () => {
      seen++;
      return seen < 10;
    });
    expect(seen).toBe(10);
    expect(result).toEqual({ ok: true, count: 10 });
  });

  test("every Streams fixture walks, and the count of each is pinned", () => {
    // COUNTED on each document. "More than zero" would pass for a walker that emitted the wrappers
    // as observations as well, which is the mistake this walker exists to avoid, so each number is
    // written down instead.
    const expected: Readonly<Record<string, number>> = {
      "current.xml": 244,
      "sample-count-1.xml": 1,
      "sample-count-200.xml": 200,
      "sample-count-negative.xml": 3,
      "sample-from-next-sequence.xml": 100,
      "current-path-condition.xml": 31,
    };
    for (const [name, count] of Object.entries(expected)) {
      const result = streamMtconnectObservations(bytes(name), () => undefined);
      expect(result).toEqual({ ok: true, count });
    }
    // And the counts differ from one another, so a walker returning a constant fails here.
    expect(new Set(Object.values(expected)).size).toBe(Object.keys(expected).length);
  });
});

describe("MT-S5: a document is parsed as untrusted input", () => {
  const utf8 = (text: string) => new Uint8Array(new TextEncoder().encode(text));
  const refusal = (text: string) => {
    const result = readMtconnectXml(utf8(text));
    return result.ok ? "accepted" : result.reason;
  };

  test("a DTD bomb is refused before parsing", () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">' +
      '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>' +
      "<MTConnectDevices>&lol2;</MTConnectDevices>";
    expect(refusal(bomb)).toBe("doctype");
  });

  test("an external entity is refused and its URL is never read", () => {
    const external =
      '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "http://169.254.169.254/latest/meta-data">]>' +
      "<MTConnectDevices>&x;</MTConnectDevices>";
    expect(refusal(external)).toBe("doctype");
  });

  test("an external DTD is refused", () => {
    expect(refusal('<!DOCTYPE d SYSTEM "http://example.invalid/d.dtd"><MTConnectDevices/>')).toBe("doctype");
  });

  test("a parameter entity is refused", () => {
    expect(refusal('<!DOCTYPE d [<!ENTITY % p "x">]><MTConnectDevices/>')).toBe("doctype");
  });

  test("an ENTITY declaration without a DOCTYPE is refused by name", () => {
    expect(refusal('<!ENTITY x "y"><MTConnectDevices/>')).toBe("entity-declaration");
  });

  test("an undeclared entity in content is refused", () => {
    expect(refusal("<MTConnectDevices>&bogus;</MTConnectDevices>")).toBe("entity");
  });

  test("deep nesting is refused at the depth bound, not by the stack", () => {
    const depth = MTC_XML_BOUNDS.maxDepth + 10;
    const deep = "<a>".repeat(depth) + "x" + "</a>".repeat(depth);
    expect(refusal(deep)).toBe("too-deep");
  });

  test("two hundred thousand levels are refused the same way", () => {
    const deep = "<a>".repeat(200_000) + "</a>".repeat(200_000);
    expect(refusal(deep)).toBe("too-deep");
  });

  test("an oversized attribute is refused", () => {
    const big = `<MTConnectDevices a="${"x".repeat(MTC_XML_BOUNDS.maxAttributeLength + 1)}"/>`;
    expect(refusal(big)).toBe("attribute-too-long");
  });

  test("two roots are refused", () => {
    expect(refusal("<MTConnectDevices/><MTConnectDevices/>")).toBe("two-roots");
  });

  test("an unescaped ampersand is refused", () => {
    expect(refusal("<MTConnectDevices>a & b</MTConnectDevices>")).toBe("entity");
  });

  test("text after the root is refused", () => {
    expect(refusal("<MTConnectDevices/>trailing")).toBe("trailing-content");
  });

  test("a document cut before its root end tag is refused", () => {
    const whole = new TextDecoder().decode(bytes("sample-count-1.xml"));
    const half = whole.slice(0, Math.floor(whole.length / 2));
    expect(refusal(half)).toBe("malformed");
  });

  test("a comment is refused by name", () => {
    expect(refusal("<MTConnectDevices><!-- hello --></MTConnectDevices>")).toBe("comment");
  });

  test("a processing instruction inside the document is refused", () => {
    expect(refusal("<MTConnectDevices><?php echo 1; ?></MTConnectDevices>")).toBe("processing-instruction");
  });

  test("a control character is refused", () => {
    expect(refusal("<MTConnectDevices>\u0001</MTConnectDevices>")).toBe("character");
  });

  test("a repeated attribute name is refused", () => {
    expect(refusal('<MTConnectDevices a="1" a="2"/>')).toBe("malformed");
  });

  test("a raw ]]> in content is refused", () => {
    expect(refusal("<MTConnectDevices>a]]>b</MTConnectDevices>")).toBe("malformed");
  });
});

describe("what an agent really sends and the reader must keep", () => {
  const utf8 = (text: string) => new Uint8Array(new TextEncoder().encode(text));

  test("CDATA is accepted and its text is kept", () => {
    const result = readMtconnectXml(utf8("<Message><![CDATA[a ]]]]><![CDATA[> b & <c>]]></Message>"));
    if (!result.ok) throw new Error(result.reason);
    expect(result.root.text).toBe("a ]]> b & <c>");
  });

  test("the five predefined entities and numeric references resolve, and nothing else does", () => {
    const result = readMtconnectXml(utf8("<M>&amp;&lt;&gt;&quot;&apos;&#65;&#x42;</M>"));
    if (!result.ok) throw new Error(result.reason);
    expect(result.root.text).toBe("&<>\"'AB");
  });

  test("a prefixed element name is kept, never resolved", () => {
    const result = readMtconnectXml(utf8('<CuttingTool xmlns:x="urn:x"><x:Color>mavi</x:Color></CuttingTool>'));
    if (!result.ok) throw new Error(result.reason);
    expect(result.root.children[0].name).toBe("x:Color");
    expect(result.root.attributes["xmlns:x"]).toBe("urn:x");
  });

  test("invalid UTF-8 arrives as U+FFFD and the document still parses", () => {
    const raw = new Uint8Array([
      ...new TextEncoder().encode("<M>"),
      0x61,
      0xc3,
      0x28,
      0xff,
      0xfe,
      0x62,
      ...new TextEncoder().encode("</M>"),
    ]);
    const result = readMtconnectXml(raw);
    if (!result.ok) throw new Error(result.reason);
    expect(result.root.text).toContain("�");
    expect(result.root.text.startsWith("a")).toBe(true);
    expect(result.root.text.endsWith("b")).toBe(true);
  });

  test("a 64 KB value survives, as one an adapter published did", () => {
    const value = "X".repeat(65_536);
    const result = readMtconnectXml(utf8(`<Message>${value}</Message>`));
    if (!result.ok) throw new Error(result.reason);
    expect(result.root.text.length).toBe(65_536);
  });
});
