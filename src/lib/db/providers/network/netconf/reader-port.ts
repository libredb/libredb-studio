/**
 * The XML reader this provider uses, as an interface rather than an implementation
 * (issue #1724, decision K-10).
 *
 * The reader itself is written once for the repository by another session and inherited here. This
 * file is the shape this provider needs from it, so that the session and the row builder can be
 * written and tested now and bound to the real reader when it lands. Nothing here parses XML.
 *
 * What this provider needs beyond what the repository's S3 reader does today, measured on
 * 2026-10-13: attributes and namespace prefixes. The S3 reader refuses a DOCTYPE and entities,
 * which is what NETCONF needs too, but it drops attributes and prefixes, and NETCONF carries both:
 * an identityref value such as `ianaift:ethernetCsmacd` means nothing without the `xmlns:ianaift`
 * binding that was in scope where it appeared.
 */

export interface XmlLimits {
  /** Deepest element nesting accepted. A document past it is refused, not truncated. */
  readonly maxDepth: number;
  /** Elements accepted in one document. */
  readonly maxElements: number;
  /** Bytes accepted in one text node. */
  readonly maxTextBytes: number;
}

export interface XmlElement {
  /** The local name, without its prefix. */
  readonly name: string;
  /** The namespace the element resolved to, from the bindings in scope. */
  readonly namespace?: string;
  /** Attributes by local name. Namespace declarations are resolved, not returned here. */
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
  /** Text content, already decoded. Absent for an element that holds only elements. */
  readonly text?: string;
  /**
   * The namespace bindings in scope at this element, prefix to namespace.
   *
   * Needed because a value can carry a prefix: an identityref or an instance-identifier is text
   * that means nothing without the binding that was in scope where it appeared.
   */
  readonly bindings: ReadonlyMap<string, string>;
}

export type XmlFault =
  | { readonly kind: "doctype" }
  | { readonly kind: "entity"; readonly name: string }
  | { readonly kind: "too-deep"; readonly depth: number }
  | { readonly kind: "too-many-elements"; readonly elements: number }
  | { readonly kind: "text-too-large"; readonly bytes: number }
  | { readonly kind: "not-well-formed"; readonly detail: string };

export class XmlReaderError extends Error {
  readonly fault: XmlFault;
  constructor(fault: XmlFault) {
    super(`the reader refused this message: ${fault.kind}`);
    this.fault = fault;
  }
}

export interface XmlReaderPort {
  /**
   * Parses one NETCONF message.
   *
   * Throws `XmlReaderError` for a DOCTYPE, for an entity declaration, and for a document past any
   * of the limits. STANDARD: RFC 6241 section 3.2 states that document type declarations MUST NOT
   * appear in NETCONF content, so refusing one is the specification's rule and not a precaution.
   */
  parse(message: string, limits: XmlLimits): XmlElement;
}

/** The limits this provider asks for. Every read is bounded, requirement NC-S5. */
export const READER_LIMITS: XmlLimits = Object.freeze({
  maxDepth: 64,
  maxElements: 500_000,
  maxTextBytes: 4 * 1024 * 1024,
});
