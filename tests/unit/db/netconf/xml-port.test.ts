/**
 * What the XML port refuses, and which refusal it reports.
 *
 * The port borrows the MTConnect reader and translates that reader's refusal into this port's
 * fault. The translation is the whole of what is held here: every arm is reached through a real
 * document rather than through a stubbed reason, because a mapping tested against its own enum
 * would pass even if no document could ever produce the reason it maps.
 *
 * The bounds are passed per call, so the documents stay small: a four-element limit is reached by
 * five elements, not by five hundred thousand.
 */
import { test } from "bun:test";
import { expectBe, expectEqual, expectThrows } from "./helpers";
import { READER_LIMITS, type XmlLimits, XmlReaderError } from "@/lib/db/providers/network/netconf/reader-port";
import { netconfXmlPort } from "@/lib/db/providers/network/netconf/xml";

const SMALL: XmlLimits = Object.freeze({ maxDepth: 3, maxElements: 4, maxTextBytes: 12 });

/** The fault a document is refused with, or a failure naming what came back instead. */
function faultOf(message: string, limits: XmlLimits = READER_LIMITS): unknown {
  try {
    netconfXmlPort.parse(message, limits);
  } catch (error) {
    if (error instanceof XmlReaderError) return error.fault;
    throw error;
  }
  throw new Error(`the port accepted a message it was expected to refuse: ${message.slice(0, 60)}`);
}

test("a DOCTYPE is refused, which RFC 6241 section 3.2 requires", () => {
  expectEqual(faultOf("<!DOCTYPE a><a/>"), { kind: "doctype" });
});

test("an entity reference is refused without a name, because the reader did not read one", () => {
  // The empty name is deliberate: inventing one here would read as though the document had been
  // inspected for it. The port's own comment says so, and this is what makes that visible.
  expectEqual(faultOf("<a>&x;</a>"), { kind: "entity", name: "" });
});

test("an entity DECLARATION is reported as a doctype, because it cannot appear outside one", () => {
  // Not a translation this port chooses. An internal subset only exists inside a DOCTYPE, so the
  // reader refuses the DOCTYPE before it reaches the declaration, and the `entity-declaration` arm
  // is unreachable through a document.
  //
  // It is NOT dead code to delete: it shares its `return` with `case "entity"`, so no line is lost
  // to it and no gate will ever point at it. If the reader stops refusing the DOCTYPE first, that
  // arm is what answers, and this test is what says so.
  expectEqual(faultOf('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'), { kind: "doctype" });
});

test("a document past the depth bound is refused, with no depth claimed", () => {
  // -1 rather than 4: the inherited reader stops at the bound and does not report where, and a
  // number invented here would be read as the document's own.
  expectEqual(faultOf("<a><b><c><d><e/></d></c></b></a>", SMALL), { kind: "too-deep", depth: -1 });
});

test("a document past the element bound is refused, with no count claimed", () => {
  expectEqual(faultOf("<a><b/><c/><d/><e/><f/></a>", SMALL), { kind: "too-many-elements", elements: -1 });
});

test("text past the bound is refused by the scanner, with no byte count claimed", () => {
  expectEqual(faultOf(`<a>${"z".repeat(50)}</a>`, SMALL), { kind: "text-too-large", bytes: -1 });
});

test("text inside the scanner's bound but over the byte bound is refused by the port, WITH its bytes", () => {
  // The unit changes between the two: the scanner counts UTF-16 code units and the port counts
  // UTF-8 bytes. Ten of U+4E2D are ten units and thirty bytes, so the scanner passes it
  // under a bound of twenty and the port's own check is the only thing that can see it. The byte
  // count is real here, which is what separates this refusal from the one above.
  const fault = faultOf(`<a>${"\u{4E2D}".repeat(10)}</a>`, { maxDepth: 64, maxElements: 100, maxTextBytes: 20 });
  expectEqual(fault, { kind: "text-too-large", bytes: 30 });
});

test("every other refusal keeps the reader's own reason instead of being flattened", () => {
  // "malformed" for all of them would lose what each one says about the document.
  expectEqual(faultOf("<a/><b/>"), { kind: "not-well-formed", detail: "two-roots" });
  expectEqual(faultOf("<a><!-- hi --></a>"), { kind: "not-well-formed", detail: "comment" });
});

test("a prefix bound to no namespace is refused, and the port is the only place that can see it", () => {
  // The inherited reader keeps names as written and resolves nothing, so without this arm the
  // element would carry no namespace and be read as belonging to the default one.
  expectEqual(faultOf("<x:a/>"), {
    kind: "not-well-formed",
    detail: 'the prefix "x" is bound to no namespace',
  });
});

test("a document inside every bound is parsed, so the refusals above are not the only outcome", () => {
  const root = netconfXmlPort.parse('<a xmlns="urn:x"><b>v</b></a>', READER_LIMITS);
  expectBe(root.name, "a");
  expectBe(root.namespace, "urn:x");
  expectBe(root.children.length, 1);
  expectBe(root.children[0]?.text, "v");
});

test("the fault's message names the kind, so a log line carries it without the fault object", () => {
  expectThrows(() => netconfXmlPort.parse("<!DOCTYPE a><a/>", READER_LIMITS), {
    message: "the reader refused this message: doctype",
  });
});
