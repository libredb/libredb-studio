/**
 * What an MTConnect handle opened for an agent-mode profile withholds, and why.
 *
 * VALUES ARE ANSWERED. An observation's value, timestamp and sequence and an asset's document are the machine's own
 * data, so the agent reads them, rendered as the console renders them.
 *
 * ONE THING IS NOT: the agent's own adapter connections. MEASURED on the pinned fixture (`mtconnect/agent:2.8.0.4`)
 * and on the Institute's demo agent: the agent writes an `Adapters` component under its own Agent device and one
 * `Adapter` component per adapter it reads from, and that component's name (`shdr://mtconnect-adapter:7878`), its id
 * (`_mtconnect-adapter_7878`), every one of its data item ids (`_mtconnect-adapter_7878_adapter_uri`) and the
 * `ADAPTER_URI` observation's value carry the network address of another system, the adapter. No column of such an
 * observation can be shown without the address, so the whole observation is withheld, and so is the data item in
 * the device model and in the tree: the read answers what it withheld as a count, with this reason, never a row.
 *
 * Decided by the agent's own answer, never by a name list Studio guesses: an item is withheld when the device model
 * places it inside an `Adapters` or `Adapter` component (`MtcDataItem.withinAdapter`), and an observation when its
 * `<ComponentStream>` says it belongs to one, which also covers an adapter the model read before the observation did
 * not know yet. The agent's other items (its availability, the devices it added, changed or removed, its asset counts)
 * carry no address and are answered.
 *
 * NOR IS A URL'S SECRET IN AN ASSET. MEASURED on the pinned image with `AllowPut = true`: a File asset whose
 * `FileLocation href` carries a user name and password is stored and served by `/assets` exactly as written, so an
 * asset's document and attributes can carry whatever credential the system that wrote the asset put in a URL. A URL
 * keeps its scheme and, after its user information, its host, port and path, which say where a file is; its user name
 * and password, its query string and its fragment, where a credential, a signature or a token travels, read
 * `[withheld]`, and the answer counts them. The cut is made by position, never by parsing the URL, and leans to
 * withholding more: the values are decoded text, in which a password may hold an `@`, a quote, a slash, a `#`, a `?`
 * or a space that a URL client still sends. A URL starts at the first scheme and colon in the value, in any case, or
 * at its first two slashes or backslashes, since a WHATWG URL parser reads `http:\\u:p@h`, `http:/u:p@h` and
 * `http:u:p@h` as `http://u:p@h` and, against a base, `//u:p@h` too; everything after that start and the slashes or
 * backslashes that follow it, up to the last `@` in the value, is withheld, and so is everything from the first `?` or
 * `#` after that to the end of the value. A `mailto:` or `urn:` value, or a label and a colon before a mail address,
 * loses what lies between its colon and its `@` too; a mail address or a path with no scheme before it is kept.
 * An asset document's text is read as one string, as a consumer reads it: each element's own text, CDATA sections and
 * references included, with its children's text in the place each child holds, in document order, so a URL split by
 * the markup is read whole and each withheld part is cut out of every element's text it lands in; an `@`, `?` or `#`
 * in a later element's text widens the cut into it. An attribute value is one string of its own.
 * MEASURED on the same image with an MQTT sink configured: the broker's address reaches no route of the table.
 *
 * Browser-safe: no Node built-in, no server module.
 */
import { MTC_ADAPTER_COMPONENTS, type MtcDataItem } from "./model";
import type { MtcObservation } from "./xml";

/** Why the adapter items are withheld, in the words every answer and the grounding repeat. */
export const MTCONNECT_WITHHELD_SENTENCE =
  "Agent mode withholds the agent's own adapter connections, the Adapter components under its Agent device: their component names, their data item ids and their ADAPTER_URI values carry the network address of the adapter the agent reads from, so none of their observations or data items is answered or listed. Every other device, component and data item is read.";

/** The warning an answer carries for the observations or data items it withheld. */
export function withheldWarning(count: number, noun: "observation" | "data item"): string {
  return `${count} ${noun}${count === 1 ? "" : "s"} of the agent's adapter connections ${count === 1 ? "was" : "were"} withheld from this answer. ${MTCONNECT_WITHHELD_SENTENCE}`;
}

/** Whether a data item of the model is withheld on an agent-mode handle. */
export function itemWithheld(item: MtcDataItem): boolean {
  return item.withinAdapter;
}

/** Whether an observation is withheld: its model item is, or its `<ComponentStream>` is an adapter's. */
export function observationWithheld(observation: MtcObservation, item: MtcDataItem | undefined): boolean {
  if (item?.withinAdapter === true) return true;
  return observation.componentType !== undefined && MTC_ADAPTER_COMPONENTS.has(observation.componentType);
}

/** Why a URL's user name, password, query string and fragment are withheld from an asset, in the words the warning repeats. */
const MTCONNECT_WITHHELD_URL_SENTENCE =
  "Agent mode keeps each URL in an asset to its scheme, host, port and path. A URL starts at a scheme and its colon, such as http: in any case, or at two slashes or backslashes; everything after that start and the slashes or backslashes that follow it, up to the last @ in the value, its user name and password, and everything from the first ? or # after that to the end of the value, its query string and fragment, where a credential, a signature or a token travels, is withheld.";

const isLetter = (c: string): boolean => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z");
const isSlash = (c: string): boolean => c === "/" || c === "\\";
const isDropped = (c: string): boolean => c === "\t" || c === "\n" || c === "\r";
const isSchemeTail = (c: string): boolean =>
  isLetter(c) || (c >= "0" && c <= "9") || c === "+" || c === "." || c === "-" || isDropped(c);

/**
 * Where the first URL in `text` starts its authority: the index after the first scheme and its colon (a letter, then
 * letters, digits, `+`, `.` or `-`, in any case) or after the first two slashes or backslashes, and after the run of
 * slashes and backslashes that follows. A tab or a line break inside either counts as part of it, since a URL parser
 * drops them. One pass over the text, so a long value costs no more than its length.
 */
function urlStart(text: string): number {
  let scheme = false;
  for (let at = 0; at < text.length; at += 1) {
    const c = text[at];
    if (c === ":" && scheme) return pastSlashes(text, at + 1);
    if (isSlash(c)) {
      let next = at + 1;
      while (next < text.length && isDropped(text[next])) next += 1;
      if (next < text.length && isSlash(text[next])) return pastSlashes(text, next + 1);
    }
    scheme = isSchemeTail(c) ? scheme || isLetter(c) : false;
  }
  return -1;
}

function pastSlashes(text: string, from: number): number {
  let at = from;
  while (at < text.length && (isSlash(text[at]) || isDropped(text[at]))) at += 1;
  return at;
}

/**
 * Where the URL secrets of `text` lie, as ranges of it to withhold: its user name and password, from the URL's start up
 * to the last `@`, and its query string and fragment, from after the first `?` or `#` past that to the end. A range may
 * be empty (`http://@h`, `http://h/?`), and is withheld all the same, so a marker shows where it was.
 */
function secretRanges(text: string): { readonly from: number; readonly to: number }[] {
  const start = urlStart(text);
  if (start === -1) return [];
  const at = text.lastIndexOf("@");
  const userinfo = at >= start;
  const ranges = userinfo ? [{ from: start, to: at }] : [];
  const rest = userinfo ? at + 1 : start;
  const tail = text.slice(rest).search(/[?#]/);
  if (tail !== -1) ranges.push({ from: rest + tail + 1, to: text.length });
  return ranges;
}

/**
 * `pieces`, read as one text in their order, with its URL secrets read `[withheld]`, and how many parts were withheld.
 * A part that crosses pieces is cut out of every piece it touches, each of which reads `[withheld]` in its place, and
 * is counted once; an empty part is marked in the piece holding the character before it. This is
 * how an element's text is read with its children's text in place, so a URL split by the markup keeps no secret.
 */
export function withoutUrlSecretsAcross(pieces: readonly string[]): {
  readonly texts: string[];
  readonly withheld: number;
} {
  const ranges = secretRanges(pieces.join(""));
  let from = 0;
  const texts = pieces.map((piece) => {
    const start = from;
    const end = start + piece.length;
    from = end;
    let out = "";
    let at = start;
    for (const range of ranges) {
      const touches =
        range.from === range.to
          ? range.from > start && range.from <= end
          : Math.max(range.from, start) < Math.min(range.to, end);
      if (!touches) continue;
      const cut = Math.max(range.from, start);
      out += `${piece.slice(at - start, cut - start)}[withheld]`;
      at = Math.min(range.to, end);
    }
    return `${out}${piece.slice(at - start)}`;
  });
  return { texts, withheld: ranges.length };
}

/**
 * `text` with its URL secrets read `[withheld]`, and how many parts were withheld. A URL starts at a scheme and its
 * colon or at two slashes or backslashes, with or without slashes after the colon, as a URL parser reads `http:`,
 * `http:/`, `http:\\` and `//` alike; a mail address or a path with neither before it is left as written.
 */
export function withoutUrlSecrets(text: string): { readonly text: string; readonly withheld: number } {
  const kept = withoutUrlSecretsAcross([text]);
  return { text: kept.texts[0], withheld: kept.withheld };
}

/** The warning an asset answer carries for the user names and passwords, query strings and fragments it withheld. */
export function withheldUrlWarning(count: number): string {
  return count === 1
    ? `1 user name and password, query string or fragment of a URL in an asset was withheld from this answer. ${MTCONNECT_WITHHELD_URL_SENTENCE}`
    : `${count} user names and passwords, query strings or fragments of URLs in assets were withheld from this answer. ${MTCONNECT_WITHHELD_URL_SENTENCE}`;
}
