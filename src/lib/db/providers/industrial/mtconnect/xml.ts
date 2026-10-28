/**
 * The XML reader of MTConnect answers.
 *
 * S3's reader (`src/lib/db/providers/objectstore/s3/xml.ts`) cannot be reused, MEASURED: given the
 * thirteen answers captured from the Institute's demo agent, it refuses seven at the
 * `<?xml-stylesheet?>` instruction, and the six it accepts come back unusable because it parses
 * attributes for syntax and then drops them, and strips any "prefix:" from a name. MTConnect keeps
 * everything in attributes - the demo's `probe` carries 1,658 attributes over 749 elements - and
 * `xsi:schemaLocation` appears on every document, so a reader that drops attributes and prefixes
 * reads nothing. Changing S3's reader would touch the S3 provider (#1085 3.5), so this is a reader
 * of this provider's own, with no dependency added (issue #1722 section 6 item 6).
 *
 * What it accepts, each because an agent was measured sending it:
 * - Attributes, with their names as written, `xsi:schemaLocation` and `xmlns:m` included.
 * - Element names as written: a prefix is kept, never resolved. cppagent answers the demo's
 *   documents unprefixed while declaring `xmlns:m`, and an adapter's extension element arrives
 *   unprefixed with its declaration still in place, so the reader never classifies by namespace.
 * - CDATA sections, which an adapter's value can carry.
 * - One `<?xml?>` declaration and any further processing instruction in the prolog. The
 *   `<?xml-stylesheet?>` instruction is OPTIONAL per document, MEASURED: the same agent emits it on
 *   `probe`, `current` and `sample` and not on `assets`.
 * - Invalid UTF-8, as U+FFFD, because a fake agent's `61 c3 28 ff fe 62` reached the reader that way
 *   under both runtimes and the document still parsed.
 *
 * What it refuses, by name, before or during parsing (MT-S5):
 * - A DOCTYPE or an ENTITY declaration, refused by a scan of the text BEFORE any parsing, so a
 *   billion-laughs DTD is never expanded and an external entity is never fetched.
 * - Any entity but the five predefined and numeric character references. Nothing is resolved
 *   outside the document.
 * - A comment. No measured agent sends one; refusing is the narrow reading, and a named refusal is
 *   how we would hear about an agent that does.
 * - A processing instruction after the root element has opened.
 * - Two roots, text after the root, and any other malformed input.
 * - Anything past the bounds of `MTC_XML_BOUNDS`, each bound named in the refusal.
 *
 * Browser-safe: no Node built-in, no server module, no `Buffer`.
 */
import { MTC_XML_BOUNDS, type MtcXmlBounds } from "./xml-bounds";

/** One element, with its attributes and its own character data. */
export interface MtcElement {
  /** The name as written: a "prefix:" is KEPT, never resolved. */
  readonly name: string;
  /** Attribute names as written, prefixed ones included; values with entities resolved. */
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly MtcElement[];
  /** Character data of this element alone, CDATA included, entities resolved, whitespace kept. */
  readonly text: string;
}

export type MtcXmlRefusal =
  | "doctype"
  | "entity-declaration"
  | "entity"
  | "comment"
  | "processing-instruction"
  | "markup"
  | "malformed"
  | "two-roots"
  | "trailing-content"
  | "character"
  | "too-deep"
  | "too-many-elements"
  | "too-many-attributes"
  | "name-too-long"
  | "text-too-long"
  | "attribute-too-long";

/**
 * WHO REFUSED, for every reason above, and why a reader has to be told.
 *
 * Half of these refusals are STUDIO'S RULE applied to a document that is perfectly well-formed
 * XML, and often perfectly valid MTConnect: a DOCTYPE is refused before parsing so no DTD is ever
 * expanded or fetched, an XML comment is refused because no measured agent sends one and a named
 * refusal is how we would hear about an agent that does, and each bound of `MTC_XML_BOUNDS` is a
 * number this repository chose. The other half are the DOCUMENT'S OWN DEFECT: text after the root,
 * two roots, a character XML 1.0 does not allow, anything else malformed.
 *
 * They used to reach the reader as one sentence - "The answer could not be read as an MTConnect
 * document (doctype)" - which tells a plant operator that their agent sent something broken. It
 * did not. An operator who reads that goes to their vendor with our rule in their hand, and the
 * vendor finds nothing wrong, because there is nothing wrong. A refusal that is ours says so.
 */
export const MTC_XML_REFUSAL_OWNER = Object.freeze({
  // Studio's rules. Each one refuses input that is well-formed XML.
  doctype: "studio",
  "entity-declaration": "studio",
  entity: "studio",
  comment: "studio",
  "processing-instruction": "studio",
  "too-deep": "studio",
  "too-many-elements": "studio",
  "too-many-attributes": "studio",
  "name-too-long": "studio",
  "text-too-long": "studio",
  "attribute-too-long": "studio",
  // The document's own defects: none of these is readable XML at all.
  markup: "document",
  malformed: "document",
  "two-roots": "document",
  "trailing-content": "document",
  character: "document",
} as const satisfies Readonly<Record<MtcXmlRefusal, "studio" | "document">>);

/**
 * The reasons Studio refuses by its own rule, as a TYPE.
 *
 * Derived from the table above rather than written again, so the sentence table in `client.ts` can
 * be `Record<StudioRefusal, string>` and the compiler can hold the two together. MEASURED before
 * this existed: flipping an entry of the table one at a time, 10 of the 16 flips changed nothing a
 * test could see - the suite pinned six by hand - and a flipped entry reports a rule of ours as
 * the agent's defect, which is the defect the table was added to fix.
 */
export type StudioRefusal = {
  [K in MtcXmlRefusal]: (typeof MTC_XML_REFUSAL_OWNER)[K] extends "studio" ? K : never;
}[MtcXmlRefusal];

export type MtcXmlResult =
  | { readonly ok: true; readonly root: MtcElement }
  | { readonly ok: false; readonly reason: MtcXmlRefusal };

/** Thrown inside the scanner and turned into a refusal at the one entry point. */
class Refused {
  constructor(readonly reason: MtcXmlRefusal) {}
}

/** The five predefined entities. Nothing else is resolved. */
const PREDEFINED: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
});

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_:.]/;

/**
 * A DOCTYPE or ENTITY declaration is refused before parsing, so nothing in it is ever expanded.
 * The scan is over the decoded text and case-insensitive on the keyword, as XML spells both in
 * upper case but a hostile document need not.
 */
function refuseDeclarations(text: string): void {
  const markup = /<!\s*(DOCTYPE|ENTITY|\[CDATA\[|--)/gi;
  for (let hit = markup.exec(text); hit !== null; hit = markup.exec(text)) {
    const kind = hit[1].toUpperCase();
    if (kind === "DOCTYPE") throw new Refused("doctype");
    if (kind === "ENTITY") throw new Refused("entity-declaration");
  }
  // Any other `<!` construct is refused by the scanner, which names it rather than guessing here.
}

/** Decoded text, with invalid bytes as U+FFFD (MEASURED: the document still parses). */
function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** XML 1.0 `Char`: a control character other than tab, newline and carriage return is refused. */
function assertChar(code: number): void {
  const allowed =
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff);
  if (!allowed) throw new Refused("character");
}

interface Open {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly children: MtcElement[];
  text: string;
}

/** What a caller of `scan` is told as the scanner walks. */
interface Sink {
  open(name: string, attributes: Readonly<Record<string, string>>, depth: number): void;
  close(name: string, depth: number): void;
  text(chunk: string, depth: number): void;
}

class Scanner {
  private at = 0;
  private elements = 0;
  private depth = 0;
  private rootSeen = false;
  private rootClosed = false;
  private readonly stack: string[] = [];

  constructor(
    private readonly src: string,
    private readonly bounds: MtcXmlBounds,
    private readonly sink: Sink,
  ) {}

  run(): void {
    while (this.at < this.src.length) {
      if (this.src[this.at] === "<") {
        this.markup();
      } else {
        this.characters();
      }
    }
    if (!this.rootSeen || !this.rootClosed || this.depth !== 0) throw new Refused("malformed");
  }

  private markup(): void {
    const next = this.src[this.at + 1];
    if (next === "?") return this.instruction();
    if (next === "!") {
      // `refuseDeclarations` has already refused DOCTYPE and ENTITY; CDATA and comments remain.
      if (this.src.startsWith("<![CDATA[", this.at)) return this.cdata();
      if (this.src.startsWith("<!--", this.at)) throw new Refused("comment");
      throw new Refused("markup");
    }
    if (next === "/") return this.endTag();
    return this.startTag();
  }

  private instruction(): void {
    if (this.rootSeen) throw new Refused("processing-instruction");
    const end = this.src.indexOf("?>", this.at + 2);
    if (end === -1) throw new Refused("malformed");
    this.at = end + 2;
  }

  private cdata(): void {
    if (!this.rootSeen || this.rootClosed) throw new Refused("malformed");
    const end = this.src.indexOf("]]>", this.at + 9);
    if (end === -1) throw new Refused("malformed");
    const body = this.src.slice(this.at + 9, end);
    for (const ch of body) assertChar(ch.codePointAt(0) as number);
    this.sink.text(body, this.depth);
    this.at = end + 3;
  }

  private name(): string {
    const start = this.at;
    if (start >= this.src.length || !NAME_START.test(this.src[start])) throw new Refused("malformed");
    let i = start + 1;
    while (i < this.src.length && NAME_CHAR.test(this.src[i])) i++;
    const name = this.src.slice(start, i);
    if (name.length > this.bounds.maxNameLength) throw new Refused("name-too-long");
    this.at = i;
    return name;
  }

  private skipSpace(): void {
    while (this.at < this.src.length && /[\s]/.test(this.src[this.at])) this.at++;
  }

  private startTag(): void {
    if (this.rootClosed) throw new Refused("two-roots");
    this.at++; // "<"
    const name = this.name();
    const attributes: Record<string, string> = {};
    let count = 0;
    for (;;) {
      this.skipSpace();
      const ch = this.src[this.at];
      if (ch === undefined) throw new Refused("malformed");
      if (ch === ">" || (ch === "/" && this.src[this.at + 1] === ">")) break;
      const key = this.name();
      this.skipSpace();
      if (this.src[this.at] !== "=") throw new Refused("malformed");
      this.at++;
      this.skipSpace();
      const quote = this.src[this.at];
      if (quote !== '"' && quote !== "'") throw new Refused("malformed");
      const end = this.src.indexOf(quote, this.at + 1);
      if (end === -1) throw new Refused("malformed");
      const raw = this.src.slice(this.at + 1, end);
      if (raw.includes("<")) throw new Refused("malformed");
      if (raw.length > this.bounds.maxAttributeLength) throw new Refused("attribute-too-long");
      const value = this.resolve(raw);
      for (const c of value) assertChar(c.codePointAt(0) as number);
      // A name repeated on one element is not well-formed XML.
      if (Object.prototype.hasOwnProperty.call(attributes, key)) throw new Refused("malformed");
      attributes[key] = value;
      if (++count > this.bounds.maxAttributes) throw new Refused("too-many-attributes");
      this.at = end + 1;
    }
    const selfClosing = this.src[this.at] === "/";
    this.at += selfClosing ? 2 : 1;

    if (++this.elements > this.bounds.maxElements) throw new Refused("too-many-elements");
    if (++this.depth > this.bounds.maxDepth) throw new Refused("too-deep");
    this.rootSeen = true;
    this.stack.push(name);
    this.sink.open(name, attributes, this.depth);
    if (selfClosing) this.finish(name);
  }

  private endTag(): void {
    this.at += 2; // "</"
    const name = this.name();
    this.skipSpace();
    if (this.src[this.at] !== ">") throw new Refused("malformed");
    this.at++;
    if (this.stack[this.stack.length - 1] !== name) throw new Refused("malformed");
    this.finish(name);
  }

  private finish(name: string): void {
    this.stack.pop();
    this.sink.close(name, this.depth);
    this.depth--;
    if (this.depth === 0) this.rootClosed = true;
  }

  private characters(): void {
    const next = this.src.indexOf("<", this.at);
    const end = next === -1 ? this.src.length : next;
    const raw = this.src.slice(this.at, end);
    this.at = end;
    if (raw.includes("]]>")) throw new Refused("malformed");
    if (!this.rootSeen || this.rootClosed) {
      // Only whitespace may sit outside the root.
      if (raw.trim() !== "") throw new Refused(this.rootClosed ? "trailing-content" : "malformed");
      return;
    }
    const value = this.resolve(raw);
    for (const c of value) assertChar(c.codePointAt(0) as number);
    this.sink.text(value, this.depth);
  }

  /** The five predefined entities and numeric references; anything else is refused. */
  private resolve(raw: string): string {
    if (!raw.includes("&")) return raw;
    let out = "";
    let i = 0;
    while (i < raw.length) {
      const amp = raw.indexOf("&", i);
      if (amp === -1) {
        out += raw.slice(i);
        break;
      }
      out += raw.slice(i, amp);
      const semi = raw.indexOf(";", amp);
      if (semi === -1) throw new Refused("entity");
      const body = raw.slice(amp + 1, semi);
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const digits = hex ? body.slice(2) : body.slice(1);
        if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) throw new Refused("entity");
        const code = Number.parseInt(digits, hex ? 16 : 10);
        if (!Number.isFinite(code) || code > 0x10ffff) throw new Refused("entity");
        assertChar(code);
        out += String.fromCodePoint(code);
      } else {
        const resolved = Object.prototype.hasOwnProperty.call(PREDEFINED, body) ? PREDEFINED[body] : undefined;
        if (resolved === undefined) throw new Refused("entity");
        out += resolved;
      }
      i = semi + 1;
    }
    return out;
  }
}

/** Build the whole document as a tree: `probe`, `current`, `assets` and the error documents. */
export function readMtconnectXml(bytes: Uint8Array, bounds: MtcXmlBounds = MTC_XML_BOUNDS): MtcXmlResult {
  try {
    const text = decode(bytes);
    refuseDeclarations(text);
    let root: MtcElement | undefined;
    const open: Open[] = [];
    const sink: Sink = {
      open(name, attributes) {
        open.push({ name, attributes: { ...attributes }, children: [], text: "" });
      },
      close() {
        const done = open.pop();
        if (!done) throw new Refused("malformed");
        const element = Object.freeze({
          name: done.name,
          attributes: Object.freeze(done.attributes),
          children: Object.freeze(done.children),
          text: done.text,
        } satisfies MtcElement);
        const parent = open[open.length - 1];
        if (parent) parent.children.push(element);
        else root = element;
      },
      text(chunk) {
        const holder = open[open.length - 1];
        if (!holder) throw new Refused("malformed");
        holder.text += chunk;
        if (holder.text.length > bounds.maxTextLength) throw new Refused("text-too-long");
      },
    };
    new Scanner(text, bounds, sink).run();
    if (!root) throw new Refused("malformed");
    return { ok: true, root };
  } catch (error) {
    // A Refused is the only throw this walk raises; any other one, a defect of ours or a throw from the
    // caller's own bounds, leaves as itself rather than as a reason the agent would wear.
    if (!(error instanceof Refused)) throw error;
    return { ok: false, reason: error.reason };
  }
}

/** One observation, with the identity its wrappers carry (MEASURED: the observation has none). */
export interface MtcObservation {
  /** The element name as written: `Position`, `Load`, `Fault`, `VariableDataSet`. */
  readonly element: string;
  readonly attributes: Readonly<Record<string, string>>;
  /** Character data of the observation element alone. */
  readonly text: string;
  /** `<DeviceStream name=...>`; undefined only in a document that carries none. */
  readonly deviceName?: string;
  readonly deviceUuid?: string;
  /** `<ComponentStream component=... name=... componentId=...>`. */
  readonly componentType?: string;
  readonly componentName?: string;
  readonly componentId?: string;
  /** Children, for the shapes that carry them: `Entry` of a DATA_SET, `Cell` of a TABLE. */
  readonly children: readonly MtcElement[];
}

export type MtcStreamResult =
  | { readonly ok: true; readonly root: string; readonly count: number }
  | { readonly ok: false; readonly reason: MtcXmlRefusal };

const WRAPPERS = new Set(["MTConnectStreams", "Header", "Streams", "DeviceStream", "ComponentStream"]);

/**
 * Walk a Streams document and hand back one observation at a time, without building the whole tree.
 *
 * This is the shape `sample` needs: the whole-buffer answer measured 19,072,397 bytes, which as a
 * tree left 363 MiB of peak RSS under Node against 149 MiB counted by a streaming parser, so the
 * row cap has to be met while reading rather than afterwards (MT-S4).
 *
 * The identity of the device and the component is NOT on the observation, MEASURED: the observation
 * carries `dataItemId`, `name`, `sequence`, `timestamp` and, with `Validation = true`, `quality`,
 * while `component`, `name` and `componentId` sit on the enclosing `<ComponentStream>` and the
 * device's on `<DeviceStream>`. So the walker keeps those wrappers on a stack and hands each
 * observation the four inherited fields; a caller building rows never has to look upwards.
 *
 * `onObservation` returning `false` stops the walk, which is how a row cap ends a read early.
 *
 * The root is reported as soon as the scanner opens it, and only a `MTConnectStreams` document is
 * walked: any other root emits nothing. That is what lets a caller tell an `MTConnectError` answer
 * or a proxy's page from a stream in this one pass, instead of building the whole answer as a tree
 * first just to read its root (#1787). The scanner still runs to the end of a document it does not
 * walk, so a result that is `ok` always means the whole document was well-formed.
 */
export function streamMtconnectObservations(
  bytes: Uint8Array,
  onObservation: (observation: MtcObservation) => boolean | void,
  bounds: MtcXmlBounds = MTC_XML_BOUNDS,
): MtcStreamResult {
  try {
    const text = decode(bytes);
    refuseDeclarations(text);

    let root: string | undefined;
    let device: { name?: string; uuid?: string } = {};
    let component: { type?: string; name?: string; id?: string } = {};
    let count = 0;
    let stopped = false;
    /** The observation being read, and its children, while inside one. */
    const open: Open[] = [];

    const sink: Sink = {
      open(name, attributes, depth) {
        if (depth === 1) {
          root = name;
          // Not a stream of observations: nothing in it is handed out as one.
          if (name !== "MTConnectStreams") stopped = true;
        }
        if (stopped) return;
        if (open.length === 0 && WRAPPERS.has(name)) {
          if (name === "DeviceStream") device = { name: attributes.name, uuid: attributes.uuid };
          if (name === "ComponentStream") {
            component = { type: attributes.component, name: attributes.name, id: attributes.componentId };
          }
          return;
        }
        if (open.length === 0 && (name === "Samples" || name === "Events" || name === "Condition")) return;
        open.push({ name, attributes: { ...attributes }, children: [], text: "" });
      },
      close() {
        if (stopped) return;
        if (open.length === 0) return;
        const done = open.pop();
        if (!done) throw new Refused("malformed");
        const element = Object.freeze({
          name: done.name,
          attributes: Object.freeze(done.attributes),
          children: Object.freeze(done.children),
          text: done.text,
        } satisfies MtcElement);
        const parent = open[open.length - 1];
        if (parent) {
          parent.children.push(element);
          return;
        }
        count++;
        const keep = onObservation({
          element: element.name,
          attributes: element.attributes,
          text: element.text,
          deviceName: device.name,
          deviceUuid: device.uuid,
          componentType: component.type,
          componentName: component.name,
          componentId: component.id,
          children: element.children,
        });
        if (keep === false) stopped = true;
      },
      text(chunk) {
        if (stopped) return;
        const holder = open[open.length - 1];
        if (!holder) return; // whitespace between wrappers
        holder.text += chunk;
        if (holder.text.length > bounds.maxTextLength) throw new Refused("text-too-long");
      },
    };

    new Scanner(text, bounds, sink).run();
    if (!root) throw new Refused("malformed");
    return { ok: true, root, count };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    throw error;
  }
}
