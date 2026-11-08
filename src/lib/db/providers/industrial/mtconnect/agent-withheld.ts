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
 * `[withheld]`, and the answer counts them. In text, the cut is made by position, never by parsing the URL, and leans to
 * withholding more: the values are decoded text, in which a password may hold an `@`, a quote, a slash, a `#`, a `?`
 * or a space that a URL client still sends. A URL starts at the first scheme and colon in the value, in any case, or
 * at its first two slashes or backslashes, since a WHATWG URL parser reads `http:\\u:p@h`, `http:/u:p@h` and
 * `http:u:p@h` as `http://u:p@h` and, against a base, `//u:p@h` too; everything after that start and the slashes or
 * backslashes that follow it, up to the last `@` in the value, is withheld, and so is everything from the first `?` or
 * `#` after that to the end of the value. Two word rules add to it, a word being a run of the value between spaces (a
 * tab or a line break is part of a word, as a URL parser drops it): a word holding an `@` with a `:` before it is
 * withheld from its start to its last `@`, keeping only an opening quote or bracket, a scheme and its colon and two or
 * more slashes or backslashes it starts with, since `login USER:PASS@host` and `ftp:USER:PASS@host` hold a user name
 * where a scheme would stand; and a word holding a slash before a `?` or `#` is withheld from that `?` or `#` to its
 * end, so `files.example/x.nc?token=T` keeps no token. A label and a colon before a mail address loses what lies
 * between them; a mail address with no `:` before its `@`, a UNC path and a path with no query are kept.
 * Every rule reads the value through a view of it: its NFKC form, so a fullwidth `ｈｔｔｐｓ：／／` reads as `https://`,
 * then percent-decoded wherever an escape is valid, again until none is left, so `https%3A%2F%2FUSER%3APASS%40host`
 * reads as its URL. Each unit of the view remembers the characters of the value it was read from, and a withheld part
 * is cut from the value as written over all of them; a value still holding an escape after eight rounds is withheld
 * whole. MEASURED on the same image: an asset put with a URL as its id is named whole by the `AssetChanged` value of
 * `/current` and `/sample`, so an observation that names assets (`observationNamesAssets`) is read the same way.
 * An asset document's text is read as one string, as a consumer reads it: each element's own text, CDATA sections and
 * references included, with its children's text in the place each child holds, in document order, so a URL split by
 * the markup is read whole and each withheld part is cut out of every element's text it lands in; an `@`, `?` or `#`
 * in a later element's text widens the cut into it. An attribute value is one string of its own. An attribute the
 * standard types as a URI, `href` and `xlink:href`, is the credential channel the standard defines, and is withheld by
 * structure rather than by position: it is parsed by the WHATWG URL parser and keeps its scheme, host, port and path as
 * the parser serializes them, or is withheld whole when it does not parse, whatever its spelling
 * (`withoutUrlFieldSecrets`).
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
  "Agent mode keeps each URL in an asset, and in an asset id or asset type an observation names, to its scheme, host, port and path, read after Unicode compatibility normalization and percent-decoding. A URL starts at a scheme and its colon, such as http: in any case, or at two slashes or backslashes; everything after that start and the slashes or backslashes that follow it, up to the last @ in the value, its user name and password, and everything from the first ? or # after that to the end of the value, its query string and fragment, where a credential, a signature or a token travels, is withheld. A word holding an @ with a : before it is withheld from its start to its last @, keeping only a scheme and two slashes it starts with, and a word holding a slash before a ? or # is withheld from that ? or # to its end. An href attribute, the field the standard types as a URI, is read as one URL by a WHATWG URL parser: it keeps its scheme, host, port and path and loses its user name, password, query string and fragment, and is withheld whole when it does not parse.";

const isLetter = (c: string): boolean => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z");
const isSlash = (c: string): boolean => c === "/" || c === "\\";
const isDropped = (c: string): boolean => c === "\t" || c === "\n" || c === "\r";
const isSchemeTail = (c: string): boolean =>
  isLetter(c) || (c >= "0" && c <= "9") || c === "+" || c === "." || c === "-" || isDropped(c);
/** What ends a word: white space, but not a tab or a line break, which a URL parser drops from inside a URL. */
const endsWord = (c: string): boolean => /\s/.test(c) && !isDropped(c);

interface Range {
  readonly from: number;
  readonly to: number;
}

/** One character of the view a value is read through, and the span of the value's own text it was read from. */
interface ViewUnit {
  readonly c: string;
  readonly from: number;
  readonly to: number;
}

/** The rounds of percent-decoding a value is read through; a value still holding an escape after them is withheld whole. */
const DECODE_ROUNDS = 8;
const ESCAPES = /^(?:%[0-9A-Fa-f]{2})+$/;

/** `text`, read from `from` to `to` of the value, in its Unicode compatibility form (NFKC), one unit per code unit. */
function pushNormalized(units: ViewUnit[], text: string, from: number, to: number): void {
  const normal = text.normalize("NFKC");
  for (const c of normal.split("")) units.push({ c, from, to });
}

/** The value one code point at a time in its NFKC form, so a fullwidth or other compatibility spelling reads as ASCII. */
function normalizedUnits(text: string): ViewUnit[] {
  const units: ViewUnit[] = [];
  for (let at = 0; at < text.length; ) {
    const code = text.codePointAt(at) as number;
    const point = String.fromCodePoint(code);
    if (code < 0x80) units.push({ c: point, from: at, to: at + 1 });
    else pushNormalized(units, point, at, at + point.length);
    at += point.length;
  }
  return units;
}

/** How many bytes the UTF-8 sequence a lead byte opens takes: one for ASCII, else two to four. */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  return 2;
}

/**
 * The character the valid escape at `at` stands for, in its NFKC form, and how many units the escape takes: one `%XX`
 * for an ASCII byte, or the two to four of one UTF-8 sequence. Undefined where no valid escape starts there.
 */
function escapeAt(
  units: readonly ViewUnit[],
  at: number,
): { readonly text: string; readonly length: number } | undefined {
  const head = units
    .slice(at, at + 3)
    .map((unit) => unit.c)
    .join("");
  if (!ESCAPES.test(head)) return undefined;
  const bytes = sequenceLength(Number.parseInt(head.slice(1), 16));
  const escapes = units
    .slice(at, at + 3 * bytes)
    .map((unit) => unit.c)
    .join("");
  if (escapes.length !== 3 * bytes || !ESCAPES.test(escapes)) return undefined;
  try {
    return { text: decodeURIComponent(escapes), length: 3 * bytes };
  } catch {
    // Not one valid UTF-8 sequence: left as written, as a URL client sends it.
    return undefined;
  }
}

/** One round of percent-decoding over the view, or undefined when it holds no valid escape. */
function decodeOnce(units: readonly ViewUnit[]): ViewUnit[] | undefined {
  const out: ViewUnit[] = [];
  let decoded = false;
  for (let at = 0; at < units.length; ) {
    const escape = escapeAt(units, at);
    if (escape === undefined) {
      out.push(units[at]);
      at += 1;
      continue;
    }
    pushNormalized(out, escape.text, units[at].from, units[at + escape.length - 1].to);
    decoded = true;
    at += escape.length;
  }
  return decoded ? out : undefined;
}

/**
 * The view a value is read through: NFKC, then percent-decoding of every valid escape, again until none is left, with
 * each unit's span in the value. `whole` is true when escapes are still left after `DECODE_ROUNDS` rounds, so the value
 * is withheld whole rather than read through a view it may still hide a URL from.
 */
function viewOf(text: string): { readonly units: readonly ViewUnit[]; readonly whole: boolean } {
  let units = normalizedUnits(text);
  for (let round = 0; round < DECODE_ROUNDS; round += 1) {
    const next = decodeOnce(units);
    if (next === undefined) return { units, whole: false };
    units = next;
  }
  return { units, whole: decodeOnce(units) !== undefined };
}

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
    const second = isSlash(c) ? secondSlash(text, at) : -1;
    if (second !== -1) return pastSlashes(text, second + 1);
    scheme = isSchemeTail(c) ? scheme || isLetter(c) : false;
  }
  return -1;
}

/** Where a second slash or backslash follows the one at `at`, past any tab or line break between them, or -1. */
function secondSlash(text: string, at: number): number {
  let next = at + 1;
  while (next < text.length && isDropped(text[next])) next += 1;
  return next < text.length && isSlash(text[next]) ? next : -1;
}

function pastSlashes(text: string, from: number): number {
  let at = from;
  while (at < text.length && (isSlash(text[at]) || isDropped(text[at]))) at += 1;
  return at;
}

/** The first `?` or `#` in `text` from `from` up to `to`, or -1. */
function queryAt(text: string, from: number, to: number): number {
  for (let at = from; at < to; at += 1) if (text[at] === "?" || text[at] === "#") return at;
  return -1;
}

/**
 * What a word's user information cut keeps at its start: an opening quote or bracket, a scheme and its colon, or a
 * colon alone, and then two or more slashes or backslashes, the authority form whose scheme a URL keeps. Anything less
 * keeps nothing, since `login:pw@h` and `ftp:pw@h` cannot be told apart.
 */
const KEPT_PREFIX = /^["'(<[{]*(?:[A-Za-z][A-Za-z0-9+.\-\t\n\r]*:|:)?[\t\n\r]*[/\\](?:[\t\n\r]*[/\\])+[\t\n\r]*/;

/** The scheme rule's ranges over the whole view: the user information of its first URL, then its query and fragment. */
function schemeRanges(view: string, ranges: Range[]): void {
  const start = urlStart(view);
  if (start === -1) return;
  const at = view.lastIndexOf("@");
  const userinfo = at >= start;
  if (userinfo) ranges.push({ from: start, to: at });
  const query = queryAt(view, userinfo ? at + 1 : start, view.length);
  if (query !== -1) ranges.push({ from: query + 1, to: view.length });
}

/** Where the word starting at `from` ends, its first `:` and its last `@`, each -1 when it has none. */
function wordAt(view: string, from: number): { readonly to: number; readonly colon: number; readonly at: number } {
  let to = from;
  let colon = -1;
  let at = -1;
  for (; to < view.length && !endsWord(view[to]); to += 1) {
    if (view[to] === ":" && colon === -1) colon = to;
    if (view[to] === "@") at = to;
  }
  return { to, colon, at };
}

/** The word rules' ranges over the word from `from`: its user information, then its query after a slash. */
function wordRanges(view: string, from: number, ranges: Range[]): number {
  const { to, colon, at } = wordAt(view, from);
  // The prefix holds no @, so it ends before the word's last @ whenever the word has one.
  const kept = from + (KEPT_PREFIX.exec(view.slice(from, to))?.[0].length ?? 0);
  if (colon !== -1 && colon < at) ranges.push({ from: kept, to: at });
  let slash = kept;
  while (slash < to && !isSlash(view[slash])) slash += 1;
  // From the first ? or # after a slash, whether or not an @ follows it: a query may hold an @ of its own.
  const query = queryAt(view, slash + 1, to);
  if (slash < to && query !== -1) ranges.push({ from: query + 1, to });
  return to;
}

/** The ranges of the view to withhold: the scheme rule over the whole value, then the word rules over each word. */
function viewRanges(view: string): Range[] {
  const ranges: Range[] = [];
  schemeRanges(view, ranges);
  for (let from = 0; from < view.length; ) from = wordRanges(view, from, ranges) + 1;
  return ranges;
}

/** `ranges` sorted, with every two that overlap or touch made one. */
function merged(ranges: readonly Range[]): Range[] {
  const out: Range[] = [];
  for (const range of [...ranges].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const last = out.at(-1);
    if (last !== undefined && range.from <= last.to)
      out[out.length - 1] = { from: last.from, to: Math.max(last.to, range.to) };
    else out.push(range);
  }
  return out;
}

/**
 * Where the URL secrets of `text` lie, as ranges of it to withhold. Every rule reads the view (`viewOf`), and each
 * range it finds is cut from the value's own text, over every character it was read from. A range may be empty
 * (`http://@h`, `http://h/?`), and is withheld all the same, so a marker shows where it was.
 */
function secretRanges(text: string): readonly Range[] {
  const { units, whole } = viewOf(text);
  if (whole) return [{ from: 0, to: text.length }];
  const position = (at: number): number => (at < units.length ? units[at].from : text.length);
  return merged(
    viewRanges(units.map((unit) => unit.c).join("")).map((range) =>
      range.from === range.to
        ? { from: position(range.from), to: position(range.from) }
        : { from: units[range.from].from, to: units[range.to - 1].to },
    ),
  );
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

/** The two bases a reference without a scheme is read against: one with its own authority reads the same host on both. */
const URL_BASES = ["https://a.invalid/", "https://b.invalid/"] as const;

/** A host and port a URL field keeps: a bracketed IP address or a run of the characters a host name is spelled in. */
const KEPT_HOST = /^(?:\[[\dA-Fa-f:.]+\]|[A-Za-z\d._~-]*)(?::\d+)?$/;

/**
 * Whether an attribute is one the standard types as a URI, so its value is read as one URL by a WHATWG URL parser rather
 * than as text: `href` and `xlink:href`, under whatever prefix the agent wrote, since a prefix is never resolved.
 */
export function isUrlAttribute(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "href" || lower.endsWith(":href");
}

/**
 * `value` read as the WHATWG URL parser a URL client uses reads it (`new URL`): absolute, or against a base when it has
 * an authority of its own (`//host`). Undefined when it does not parse, or is a reference with no authority.
 */
function parsedUrl(value: string): { readonly url: URL; readonly schemeRelative: boolean } | undefined {
  try {
    return { url: new URL(value), schemeRelative: false };
  } catch {
    // Not an absolute URL: read against two bases below.
  }
  try {
    const [first, second] = URL_BASES.map((base) => new URL(value, base));
    return first.host === second.host ? { url: first, schemeRelative: true } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a part the parser cut holds more than the markers the text rule already left and the marks around them. */
const holdsMore = (part: string): boolean =>
  part.replace(/\[withheld\]|%5Bwithheld%5D/g, "").replace(/[:?#]/g, "") !== "";

/**
 * A URL-typed field (`isUrlAttribute`) withheld by structure, whatever its spelling. The text rule (`withoutUrlSecrets`)
 * reads the value first, as it reads any text; what it leaves is parsed by the WHATWG URL parser a URL client uses, and
 * when it parses it keeps its scheme, host, port and path, as the parser serializes them, while its user name and
 * password and its query string and fragment read `[withheld]`. When it does not parse, is a reference with neither a
 * scheme nor an authority, or names a host outside a host name's characters, the whole value is withheld. A part the
 * parser cuts is counted unless the text rule already withheld all of it.
 */
export function withoutUrlFieldSecrets(value: string): { readonly text: string; readonly withheld: number } {
  const read = withoutUrlSecrets(value);
  const parsed = parsedUrl(read.text);
  if (parsed === undefined || !KEPT_HOST.test(parsed.url.host)) return { text: "[withheld]", withheld: 1 };
  const { url, schemeRelative } = parsed;
  const noUser = new URL(url.href);
  noUser.username = "";
  noUser.password = "";
  const kept = new URL(noUser.href);
  kept.search = "";
  kept.hash = "";
  const userinfo = noUser.href !== url.href;
  const tail = noUser.href.slice(kept.href.length);
  const href = schemeRelative ? kept.href.slice(kept.protocol.length) : kept.href;
  // With an authority the user information marker stands after the slashes.
  const start = href.indexOf("//") + 2;
  const authority = userinfo ? `${href.slice(0, start)}[withheld]@${href.slice(start)}` : href;
  const marker = tail === "" ? "" : `${tail[0]}[withheld]`;
  return {
    text: `${authority}${marker}`,
    withheld:
      read.withheld +
      (userinfo && holdsMore(`${url.username}:${url.password}`) ? 1 : 0) +
      (tail !== "" && holdsMore(tail) ? 1 : 0),
  };
}

/** An attribute value with its URL secrets withheld: by structure for a URL-typed attribute, by the text rule otherwise. */
export function withoutAttributeSecrets(
  name: string,
  value: string,
): { readonly text: string; readonly withheld: number } {
  return isUrlAttribute(name) ? withoutUrlFieldSecrets(value) : withoutUrlSecrets(value);
}

/**
 * Whether an observation reports on assets, so its value or its keys are an asset id or an asset type the system that
 * wrote the asset chose: its data item's type, or its own, starts `ASSET_` (`ASSET_CHANGED`, `ASSET_REMOVED`,
 * `ASSET_COUNT`), or its element name starts `Asset`. MEASURED on the pinned image with `AllowPut = true`: an asset put
 * with a URL as its id is named whole by the `AssetChanged` value of `/current` and `/sample`, and by `AssetRemoved`
 * once removed, so these are read as an asset's own text is.
 */
export function observationNamesAssets(observation: MtcObservation, item: MtcDataItem | undefined): boolean {
  const type = item?.type ?? observation.attributes.type ?? "";
  return type.startsWith("ASSET_") || observation.element.startsWith("Asset");
}

/** The warning an answer carries for the user names and passwords, query strings and fragments it withheld. */
export function withheldUrlWarning(count: number): string {
  return count === 1
    ? `1 user name and password, query string or fragment of a URL in an asset or an asset reference was withheld from this answer. ${MTCONNECT_WITHHELD_URL_SENTENCE}`
    : `${count} user names and passwords, query strings or fragments of URLs in assets or asset references were withheld from this answer. ${MTCONNECT_WITHHELD_URL_SENTENCE}`;
}
