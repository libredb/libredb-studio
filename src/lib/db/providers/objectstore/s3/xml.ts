/**
 * The narrow XML reader of S3 answers.
 *
 * S3 uses elements, character data, the five predefined entities, numeric references and `xmlns` attributes, and
 * nothing else, so everything else is refused: any `<!` construct (DOCTYPE, ENTITY, comment, CDATA), any processing
 * instruction but one leading declaration, any entity but the five, any character outside XML 1.0 `Char`. Nothing
 * is resolved outside the document, and the work is bounded by the caller's response cap, the depth bound and the
 * element bound. Attributes are parsed for syntax and dropped; names lose any "prefix:".
 *
 * Browser-safe: no Node built-in, no server module and no `Buffer`.
 */
import { S3_XML_MAX_DEPTH, S3_XML_MAX_ELEMENTS } from "./constants";

export interface XmlElement {
  /** Local name: any "prefix:" is removed. */
  readonly name: string;
  readonly children: readonly XmlElement[];
  /** Concatenated character data of this element alone, entities resolved, whitespace kept. */
  readonly text: string;
}

export type XmlReadResult =
  | { readonly ok: true; readonly root: XmlElement }
  | { readonly ok: false; readonly reason: XmlRefusal };
export type XmlRefusal =
  | "not-utf8"
  | "doctype"
  | "entity"
  | "markup"
  | "malformed"
  | "too-deep"
  | "too-many"
  | "character";

/** Thrown inside the parser and turned into the refusal at its one entry. */
class Refused {
  constructor(readonly reason: XmlRefusal) {}
}

const DECLARATION = /^<\?xml(?:[ \t\r\n][^?]*)?\?>/;
const ENCODING = /\bencoding[ \t\r\n]*=[ \t\r\n]*(["'])([^"']*)\1/;
const NAME = /[A-Za-z_][A-Za-z0-9._:-]*/y;
const SPACE = /[ \t\r\n]*/y;
/** Outside XML 1.0 Char: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]. */
const NOT_CHAR = /[^\t\n\r -\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const DECIMAL_REFERENCE = /^#([0-9]{1,7})$/;
const HEX_REFERENCE = /^#x([0-9A-Fa-f]{1,6})$/;
const ENTITIES: Readonly<Record<string, string>> = Object.freeze({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" });

export function readXml(bytes: Uint8Array): XmlReadResult {
  let text: string;
  try {
    // The default ignoreBOM: false removes a leading byte order mark.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not-utf8" };
  }
  let start = 0;
  const declaration = DECLARATION.exec(text);
  if (declaration !== null) {
    const encoding = ENCODING.exec(declaration[0]);
    if (encoding !== null && encoding[2].toLowerCase() !== "utf-8") return { ok: false, reason: "not-utf8" };
    start = declaration[0].length;
  }
  if (text.includes("<!DOCTYPE") || text.includes("<!ENTITY")) return { ok: false, reason: "doctype" };
  if (text.includes("<!") || text.indexOf("<?", start) >= 0) return { ok: false, reason: "markup" };
  if (NOT_CHAR.test(text)) return { ok: false, reason: "character" };
  try {
    return { ok: true, root: new Parser(text, start).document() };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    throw error;
  }
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

/** One reference's text, without its "&" and ";". */
function reference(body: string): string {
  if (body.startsWith("#")) {
    const decimal = DECIMAL_REFERENCE.exec(body);
    const hex = HEX_REFERENCE.exec(body);
    if (decimal === null && hex === null) throw new Refused("malformed");
    const point = decimal !== null ? Number(decimal[1]) : Number.parseInt((hex as RegExpExecArray)[1], 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Refused("character");
    const char = String.fromCodePoint(point);
    if (NOT_CHAR.test(char)) throw new Refused("character");
    return char;
  }
  if (!Object.hasOwn(ENTITIES, body)) throw new Refused("entity");
  return ENTITIES[body];
}

function resolveReferences(raw: string): string {
  if (!raw.includes("&")) return raw;
  let out = "";
  let at = 0;
  for (;;) {
    const amp = raw.indexOf("&", at);
    if (amp < 0) return out + raw.slice(at);
    const semicolon = raw.indexOf(";", amp);
    if (semicolon < 0) throw new Refused("malformed");
    out += raw.slice(at, amp) + reference(raw.slice(amp + 1, semicolon));
    at = semicolon + 1;
  }
}

interface Frame {
  readonly name: string;
  readonly children: XmlElement[];
  text: string;
}

class Parser {
  private pos: number;
  private count = 0;
  private readonly stack: Frame[] = [];

  constructor(
    private readonly text: string,
    start: number,
  ) {
    this.pos = start;
  }

  document(): XmlElement {
    this.space();
    if (this.text[this.pos] !== "<") throw new Refused("malformed");
    let root: XmlElement | undefined;
    while (root === undefined) {
      if (this.pos >= this.text.length) throw new Refused("malformed");
      if (this.text.startsWith("</", this.pos)) root = this.close();
      else if (this.text[this.pos] === "<") root = this.open();
      else this.characters();
    }
    this.space();
    if (this.pos !== this.text.length) throw new Refused("malformed");
    return root;
  }

  private open(): XmlElement | undefined {
    this.pos += 1;
    const name = this.name();
    this.count += 1;
    if (this.count > S3_XML_MAX_ELEMENTS) throw new Refused("too-many");
    if (this.stack.length + 1 > S3_XML_MAX_DEPTH) throw new Refused("too-deep");
    for (;;) {
      const spaced = this.space();
      if (this.text.startsWith("/>", this.pos)) {
        this.pos += 2;
        return this.finish(name, [], "");
      }
      if (this.text[this.pos] === ">") {
        this.pos += 1;
        this.stack.push({ name, children: [], text: "" });
        return undefined;
      }
      if (!spaced) throw new Refused("malformed");
      this.attribute();
    }
  }

  /** `name = "value"` or `name = 'value'`; read for syntax and dropped. */
  private attribute(): void {
    this.name();
    this.space();
    if (this.text[this.pos] !== "=") throw new Refused("malformed");
    this.pos += 1;
    this.space();
    const quote = this.text[this.pos];
    if (quote !== '"' && quote !== "'") throw new Refused("malformed");
    const end = this.text.indexOf(quote, this.pos + 1);
    if (end < 0) throw new Refused("malformed");
    const value = this.text.slice(this.pos + 1, end);
    if (value.includes("<")) throw new Refused("malformed");
    resolveReferences(value);
    this.pos = end + 1;
  }

  private close(): XmlElement | undefined {
    this.pos += 2;
    const name = this.name();
    this.space();
    if (this.text[this.pos] !== ">") throw new Refused("malformed");
    this.pos += 1;
    const frame = this.stack.pop();
    if (frame === undefined || frame.name !== name) throw new Refused("malformed");
    return this.finish(frame.name, frame.children, frame.text);
  }

  /** Adds a finished element to its parent, or answers it as the root. */
  private finish(name: string, children: XmlElement[], text: string): XmlElement | undefined {
    const element: XmlElement = { name: localName(name), children, text };
    const parent = this.stack[this.stack.length - 1];
    if (parent === undefined) return element;
    parent.children.push(element);
    return undefined;
  }

  private characters(): void {
    const end = this.text.indexOf("<", this.pos);
    const stop = end < 0 ? this.text.length : end;
    const raw = this.text.slice(this.pos, stop);
    this.pos = stop;
    const parent = this.stack[this.stack.length - 1];
    if (parent === undefined) throw new Refused("malformed");
    parent.text += resolveReferences(raw);
  }

  private name(): string {
    NAME.lastIndex = this.pos;
    const match = NAME.exec(this.text);
    if (match === null) throw new Refused("malformed");
    this.pos += match[0].length;
    return match[0];
  }

  /** Skips whitespace; true when any was skipped. */
  private space(): boolean {
    SPACE.lastIndex = this.pos;
    const skipped = (SPACE.exec(this.text) as RegExpExecArray)[0].length;
    this.pos += skipped;
    return skipped > 0;
  }
}
