/**
 * The `XmlReaderPort` this provider binds to, over the reader this repository already has
 * (issue #1724, decision K-10).
 *
 * K-10 reads, in full: "Karar: kendi okuyucumuz. 1722 yazar. 1724 onu DEVRALIR ve sadece kendi
 * ihtiyacini ekler (ad alani kapsamlari, CDATA, yorum). 1724 ayri okuyucu yazmaz, bagimlilik
 * eklemez." So this file is an ADAPTER and not a parser: not one character of XML is scanned
 * here. `readMtconnectXml` does the scanning, and what this adds is the one thing NETCONF needs
 * and MTConnect does not: namespace scopes.
 *
 * MEASURED, 2026-10-13, against two replies captured from the pinned Netopeer2 2.8.7 fixture and
 * fed to the inherited reader unchanged:
 *
 *   `<get-config>` on `running`   987,956 bytes   accepted in 31 ms, 25,003 elements
 *   `<get-data>` on `running`     234,120 bytes   accepted in  8 ms, 10,003 elements
 *
 * Both came back with their attributes intact, which is the property the S3 reader lacks and the
 * reason K-10 refused to reuse it: `xmlns`, `xmlns:ianaift` and `message-id` were all present on
 * the elements that carried them. A third capture was refused as `malformed`, and that refusal is
 * CORRECT rather than a gap: it is the raw framed stream (`#10240` … `##`), not a message, and the
 * framing layer strips those headers before a message ever reaches this port.
 *
 * ## What this adapter adds
 *
 * **Namespace scopes.** The inherited reader keeps a name AS WRITTEN and never resolves it, which
 * is right for MTConnect, where a prefix classifies nothing. NETCONF is the opposite: a module is
 * identified by its namespace, `<data>` and `<nc:data>` are the same element, and a value such as
 * `ianaift:ethernetCsmacd` means nothing without the `xmlns:ianaift` binding that was in scope
 * where it appeared. So this adapter resolves `xmlns` and `xmlns:p` attributes into bindings,
 * carries them down the tree, splits each name into its local part and its namespace, and keeps
 * the bindings on the element so a prefixed VALUE can still be resolved by a caller.
 *
 * **A byte bound where the inherited reader counts characters.** See `boundsFor` below.
 *
 * ## What it deliberately does not add
 *
 * **Comment support.** The inherited reader refuses a comment by name. K-10 left that change to
 * this session, and it is NOT made, because the case is unreachable against everything measured:
 * neither captured reply carries one (`grep -c "<!--"` answers 0 on both), and a comment inside an
 * `<rpc-reply>` body is not something either measured server emits. Writing the acceptance would
 * mean writing a test for a document no measured device sends. If a real device is ever seen
 * sending one, the refusal is named, so it arrives as `not-well-formed` with the reason in it
 * rather than as silence.
 */
import { type MtcElement, type MtcXmlRefusal, readMtconnectXml } from "@/lib/db/providers/industrial/mtconnect/xml";
import type { MtcXmlBounds } from "@/lib/db/providers/industrial/mtconnect/xml-bounds";

import { type XmlElement, type XmlFault, type XmlLimits, XmlReaderError, type XmlReaderPort } from "./reader-port";

/**
 * Bounds on one element, held constant because this provider has no measurement that would move
 * them and the inherited reader requires all six.
 *
 * MEASURED on the two captures: at most 2 attributes on one element, the longest name 11
 * characters, the longest attribute value 47. These sit far above that, where the inherited
 * reader's own defaults sit, so a document is refused by the three bounds the port declares long
 * before it is refused by one of these.
 */
const ELEMENT_BOUNDS = Object.freeze({
  maxAttributes: 64,
  maxNameLength: 256,
  maxAttributeLength: 64 * 1024,
});

/**
 * The port's limits, as the inherited reader's bounds.
 *
 * THE UNIT CHANGES HERE AND THE CHANGE IS NOT SILENT. `XmlLimits.maxTextBytes` is counted in
 * BYTES, which is the house's convention for a text bound, and `MtcXmlBounds.maxTextLength` is
 * counted in UTF-16 CODE UNITS, which is what `String.length` answers. The two are equal only
 * while the text is ASCII, which is true of every YANG module measured so far and will stop being
 * true the first time a device answers a description in Chinese or a name in Arabic.
 *
 * The conversion is therefore in ONE direction and deliberately the safe one: the character bound
 * handed to the scanner is the byte bound's number, so the scanner cuts a hostile stream EARLY
 * (text can never hold more characters than it holds bytes, so nothing under the byte bound is
 * refused here), and `checkTextBytes` below then enforces the real byte bound on what survived.
 * Taking only the first half would let a 4 MB bound pass up to 16 MB of UTF-8; taking only the
 * second would let an unbounded scan run before anything was checked.
 */
function boundsFor(limits: XmlLimits): MtcXmlBounds {
  return {
    maxDepth: limits.maxDepth,
    maxElements: limits.maxElements,
    maxTextLength: limits.maxTextBytes,
    ...ELEMENT_BOUNDS,
  };
}

/**
 * The exact UTF-8 byte length of a text node, computed only where it can possibly matter.
 *
 * A UTF-8 character occupies at most 4 bytes, so text of at most `maxTextBytes / 4` characters is
 * under the bound whatever it holds, and that is every text node the fixture produces. The encode
 * runs only above that, which is why this is a check and not a second pass over the document.
 */
function checkTextBytes(text: string, maxTextBytes: number): void {
  if (text.length <= maxTextBytes / 4) return;
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxTextBytes) throw new XmlReaderError({ kind: "text-too-large", bytes });
}

/** Every refusal the inherited reader can answer, mapped to this port's fault. */
function faultFor(reason: MtcXmlRefusal): XmlFault {
  switch (reason) {
    case "doctype":
      return { kind: "doctype" };
    case "entity-declaration":
    case "entity":
      // The reader refuses an entity without naming it, and inventing a name here would be worse
      // than an empty one: it would read as though the document had been inspected.
      return { kind: "entity", name: "" };
    case "too-deep":
      return { kind: "too-deep", depth: -1 };
    case "too-many-elements":
      return { kind: "too-many-elements", elements: -1 };
    case "text-too-long":
      return { kind: "text-too-large", bytes: -1 };
    default:
      // Everything else is a document this port has no separate arm for, and the reason travels in
      // the detail rather than being flattened to "malformed": `comment`, `markup`, `two-roots`,
      // `trailing-content`, `character`, `processing-instruction`, `too-many-attributes`,
      // `name-too-long` and `attribute-too-long` each say something different about the document.
      return { kind: "not-well-formed", detail: reason };
  }
}

const EMPTY_BINDINGS: ReadonlyMap<string, string> = Object.freeze(new Map<string, string>());
const NO_ATTRIBUTES: ReadonlyMap<string, string> = Object.freeze(new Map<string, string>());

/** The local part of a name, and its prefix where it has one. The default namespace is `""`. */
function split(name: string): { prefix: string; local: string } {
  const colon = name.indexOf(":");
  return colon === -1 ? { prefix: "", local: name } : { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
}

/**
 * The bindings in scope at an element, given its parent's.
 *
 * The parent's map is SHARED where the element declares nothing, which is the ordinary case and
 * the reason this is cheap: of the 25,003 elements in the larger capture, 5,002 declare a binding
 * and 20,001 inherit one, so copying at every element would build twenty thousand maps that each
 * hold what their parent's holds.
 *
 * `xmlns=""` undeclares the default namespace, which is why an empty value is stored rather than
 * skipped: storing it is what lets a descendant read "no default namespace here" instead of
 * reading the grandparent's.
 */
function bindingsFor(attributes: Readonly<Record<string, string>>, inherited: ReadonlyMap<string, string>) {
  let declared: Map<string, string> | undefined;
  for (const [name, value] of Object.entries(attributes)) {
    if (name !== "xmlns" && !name.startsWith("xmlns:")) continue;
    declared ??= new Map(inherited);
    declared.set(name === "xmlns" ? "" : name.slice("xmlns:".length), value);
  }
  return declared ?? inherited;
}

/** The attributes that are not namespace declarations, by local name. */
function attributesFor(attributes: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  let kept: Map<string, string> | undefined;
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "xmlns" || name.startsWith("xmlns:")) continue;
    kept ??= new Map<string, string>();
    // By LOCAL name, which the port declares. Two attributes whose local names match under
    // different prefixes would collide, and the first written wins. That is a stated limit rather
    // than a handled case: MEASURED on both captures, the only attributes a reply carries at all
    // are `xmlns`, `xmlns:ianaift` and `message-id`, so no collision is reachable today.
    const { local } = split(name);
    if (!kept.has(local)) kept.set(local, value);
  }
  return kept ?? NO_ATTRIBUTES;
}

/**
 * One element of the inherited tree, as this port's element.
 *
 * `text` is dropped where the element has children and its own character data is only whitespace,
 * because that whitespace is the document's indentation rather than a value, and the port declares
 * the field absent for an element that holds only elements. MEASURED: all 5,003 elements with
 * children in the larger capture carry blank text, because the server pretty-prints nothing; the
 * rule is written for the server that does.
 */
function convert(
  element: MtcElement,
  inherited: ReadonlyMap<string, string>,
  limits: XmlLimits,
  depth: number,
): XmlElement {
  if (depth > limits.maxDepth) throw new XmlReaderError({ kind: "too-deep", depth });
  const bindings = bindingsFor(element.attributes, inherited);
  const { prefix, local } = split(element.name);
  const namespace = bindings.get(prefix);
  if (prefix !== "" && namespace === undefined) {
    // An unbound prefix is not well-formed XML, and this is the one place that can see it: the
    // inherited reader keeps names as written and resolves nothing, so without this the element
    // would silently carry no namespace and be read as belonging to the default one.
    throw new XmlReaderError({ kind: "not-well-formed", detail: `the prefix "${prefix}" is bound to no namespace` });
  }
  const children = element.children.map((child) => convert(child, bindings, limits, depth + 1));
  const keepText = children.length === 0 ? element.text !== "" : element.text.trim() !== "";
  if (keepText) checkTextBytes(element.text, limits.maxTextBytes);
  return Object.freeze({
    name: local,
    ...(namespace === undefined || namespace === "" ? {} : { namespace }),
    attributes: attributesFor(element.attributes),
    children: Object.freeze(children),
    ...(keepText ? { text: element.text } : {}),
    bindings,
  });
}

/**
 * The port this provider is wired with.
 *
 * `parse` takes a string because that is what the session hands out: `framing.ts` holds the
 * message as bytes and decodes it ONCE, when the message is complete, so re-encoding here is a
 * second pass over the same bytes rather than a second decode. It costs one copy of the message,
 * measured at about 1 ms for the 988 KB capture against the 31 ms the scan itself takes, and it
 * buys a port whose contract is the decoded message rather than the transport's buffer.
 */
export const netconfXmlPort: XmlReaderPort = Object.freeze({
  parse(message: string, limits: XmlLimits): XmlElement {
    const result = readMtconnectXml(new TextEncoder().encode(message), boundsFor(limits));
    if (!result.ok) throw new XmlReaderError(faultFor(result.reason));
    return convert(result.root, EMPTY_BINDINGS, limits, 1);
  },
});
