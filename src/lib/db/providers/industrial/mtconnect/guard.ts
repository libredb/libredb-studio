/**
 * Phase 0: everything refused before a socket is opened (MT-S2, MT-S3).
 *
 * Nothing here sends anything. A user's mistake gets Studio's own sentence rather than the agent's,
 * and three measurements say why that is worth the code.
 *
 * The agent ignores a parameter that is not its route's. MEASURED on the demo:
 * `/current?path=//DataItem[@category="CONDITION"]&count=2` answered 200 with 31 observations,
 * because `count` is not a parameter of `current`. The user had every reason to think the answer was
 * limited to two.
 *
 * The agent takes the first of a repeated key. MEASURED on the pinned agent: `count=1&count=5`
 * returned 1 observation and `count=5&count=1` returned 5.
 *
 * And a `path` is code that runs on the agent, which serves the plant's own clients too. MEASURED on
 * the pinned agent: while a 300 alternative path ran in a loop, the median of `sample?count=1` on
 * the same agent rose from 1.4 ms to 74.1 ms, a factor of 51.
 *
 * Browser-safe: no Node built-in, no server module.
 */
import { MTC_REFUSED_KEYS, MTC_ROUTES, type MtcOp, type MtcRoute } from "./routes";

export type MtcRefusalCode =
  | "method"
  | "absolute-url"
  | "fragment"
  | "trailing-slash"
  | "unknown-route"
  | "refused-key"
  | "unknown-key"
  | "repeated-key"
  | "bad-encoding"
  | "bad-sequence"
  | "bad-count"
  | "bad-boolean"
  | "window"
  | "unknown-device"
  | "path-syntax"
  | "path-attribute-step"
  | "path-literal"
  | "path-function"
  | "path-predicate-path"
  | "path-too-many-alternatives"
  | "path-too-long"
  | "param-too-long"
  | "two-requests"
  | "request-too-long";

export class MtcRefusal extends Error {
  constructor(
    readonly code: MtcRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "MtcRefusal";
  }
}

/** What the Header of a read without `from` and `to` said. Buffer facts come only from such a read. */
export interface MtcWindow {
  readonly instanceId: string;
  readonly firstSequence: bigint;
  readonly lastSequence: bigint;
  readonly nextSequence: bigint;
  readonly bufferSize: bigint;
}

export interface MtcRequest {
  readonly op: MtcOp;
  readonly route: MtcRoute;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
}

/** Sequence numbers are decimal strings from 1 to 2^64 - 1 (MT-S2). */
const MAX_SEQUENCE = BigInt("18446744073709551615");
const DECIMAL = /^[0-9]+$/;
const SIGNED_DECIMAL = /^-?[0-9]+$/;

/**
 * The functions a `path` may name. MEASURED on the pinned agent against a 2,142 item model, median
 * of five: `starts-with(@id,...)` 3.3 ms and `contains(@name,...)` 3.8 ms, both cheaper than a
 * single attribute test at 4.8 ms. So the list costs nothing measurable at this size, and anything
 * outside it is refused because its cost was never measured.
 */
const ALLOWED_FUNCTIONS: readonly string[] = Object.freeze(["starts-with", "contains"]);

/**
 * The cap on `or` alternatives inside one path.
 *
 * This is a choice inside a measured range rather than a measured limit, and it is written down as
 * such. MEASURED on a 2,142 item model: 10 alternatives 7.4 ms, 50 at 30.8 ms, 150 at 79.7 ms, 300
 * at 163.3 ms, so about 0.54 ms an alternative, and cost grows with the expression rather than with
 * the answer. The issue's own 4,974 item model measured roughly twice that per alternative. 32 keeps
 * a filtered read on either model within a small multiple of an unfiltered `current`, which measured
 * 12.2 ms on the smaller one.
 */
export const MAX_ALTERNATIVES = 32;

/**
 * The cap on the encoded path.
 *
 * MEASURED on the pinned agent with a raw socket: a request whose whole header block was 8,153
 * bytes was answered, and one of 8,216 bytes got no answer at all, the agent writing zero bytes and
 * closing the connection. The limit is on the header block, not on the path, so this number is what
 * is left of an 8 KiB budget after a route, a device name, the other parameters and the headers.
 * There is no error document to read in that case, which is the other reason to
 * stay well inside it.
 */
const MAX_PATH_BYTES = 4096;

/**
 * The bound on one path parameter, encoded.
 *
 * A device name and an asset id reach the route as path segments, and until this bound existed they
 * had none: a five thousand character asset id passed the guard and was stopped only by the request
 * budget in the client. MEASURED, the real ones are short: the demo's device names are `Agent`,
 * `OKUMA` and `Mazak`, its uuids `OKUMA.123456` and `Mazak`, and its asset ids of the form
 * `123456.2207`. 256 bytes is far above every measured one and far below the request budget.
 */
const MAX_PARAM_BYTES = 256;

/**
 * The bound on the whole request line, before any of it is read.
 *
 * Every other bound in this file is measured after the line has been split, trimmed and matched,
 * so until this one existed the guard did that work on text of any length: a pasted megabyte
 * reached three regular expressions before the first refusal. The bound is on the line rather
 * than on the path because it has to come first to be worth anything.
 *
 * MEASURED, the widest request this provider can legitimately send is a `/sample` with a path
 * parameter at `MAX_PATH_BYTES`, a device segment at `MAX_PARAM_BYTES`, and `from`, `count` and
 * `interval` beside it: 4,096 + 256 + the route and the three numbers, under 4,500 bytes. 8,192 is
 * above every such line and below the agent's own header budget of about 8 KiB,
 * so a line this guard accepts is a line the agent would still answer.
 */
const MAX_REQUEST_BYTES = 8192;

/** The three character classes the path's function-name scan walks, compiled once. */
const WHITESPACE = /\s/;
const NAME_CHAR = /[A-Za-z0-9-]/;
const NAME_HEAD = /[A-Za-z]/;

function refuse(code: MtcRefusalCode, message: string): never {
  throw new MtcRefusal(code, message);
}

/** One percent-decoded key or value; a broken escape is refused by name rather than thrown as a bare URIError. */
function decodedPart(text: string, pair: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return refuse("bad-encoding", `The query holds a % that does not start a valid escape such as %22: ${pair}`);
  }
}

/** Match a route by segment count, preferring the template with more literal segments. */
function matchRoute(relative: string): { route: MtcRoute; params: Record<string, string> } | undefined {
  const segments = relative.split("/");
  let best: { route: MtcRoute; params: Record<string, string>; literals: number } | undefined;
  for (const route of MTC_ROUTES) {
    const template = route.template.split("/");
    if (template.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let literals = 0;
    let matches = true;
    for (let index = 0; index < template.length && matches; index++) {
      const name = /^\{([A-Za-z0-9_]+)\}$/.exec(template[index]);
      if (name !== null) {
        if (segments[index] === "") matches = false;
        else params[name[1]] = segments[index];
      } else if (template[index] === segments[index]) literals++;
      else matches = false;
    }
    if (matches && (best === undefined || literals > best.literals)) best = { route, params, literals };
  }
  return best === undefined ? undefined : { route: best.route, params: best.params };
}

/**
 * Check a `path` against the subset the provider forwards.
 *
 * The subset is ours, not the agent's: READ in cppagent's source, the expression goes to libxml2's
 * `xmlXPathEvalExpression`, so the agent accepts whatever libxml2 does. What the agent does do is
 * REWRITE the expression first, inserting `m:` after every `/` and `|` by a textual pass that is
 * blind to string literals. The three functions were translated from the source and run, which is
 * where two of the refusals below come from:
 *
 *     //DataItem/@id            becomes  //m:DataItem/m:@id       which is not valid XPath
 *     //DataItem[@name="a/b"]   becomes  //m:DataItem[@name="a/m:b"]
 */
export function assertPathInSubset(path: string): void {
  if (path.trim() === "") refuse("path-syntax", "A path cannot be empty. Leave it out to read everything.");
  // The bound is on the ENCODED path, because that is what goes on the wire. The two are not the
  // same length: `URLSearchParams` writes a space as `+`, one byte, and a quote as `%22`, three. A
  // path of 3,000 spaces stays 3,000 bytes while one of 3,000 quotes becomes 9,000. Measuring the
  // text would let the second one through to a request the agent answers with a closed socket.
  const bytes = new URLSearchParams({ path }).toString().length - "path=".length;
  if (bytes > MAX_PATH_BYTES) {
    refuse(
      "path-too-long",
      `A path may be at most ${MAX_PATH_BYTES} bytes once encoded, and this one is ${bytes} encoded. The agent answers nothing at all past about 8 KiB of request headers: it closes the connection without an error document.`,
    );
  }

  // Walk the expression once, tracking whether we are inside a literal and inside a predicate.
  let quote: '"' | "'" | undefined;
  let depth = 0;
  let alternatives = 1;
  for (let index = 0; index < path.length; index++) {
    const ch = path[index];
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else if (ch === "/" || ch === "|") {
        refuse(
          "path-literal",
          `A quoted value in a path cannot contain ${ch}: the agent rewrites the inside of the quotes, so what runs there is not what you wrote.`,
        );
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "|" && depth === 0) alternatives++;
    else if (ch === "/" && depth > 0) {
      refuse(
        "path-predicate-path",
        "A path inside a predicate is outside the subset this provider sends: its cost on the agent was never measured.",
      );
    } else if (ch === "@" && path[index - 1] === "/") {
      refuse(
        "path-attribute-step",
        "A path cannot end in an attribute step such as /@id: the agent rewrites it into m:@id, which it then refuses, and a path selects data items rather than attributes in any case.",
      );
    }
  }
  if (quote !== undefined) refuse("path-syntax", "A quoted value in the path is not closed.");

  const orCount = (path.match(/\bor\b/g) ?? []).length;
  if (alternatives + orCount > MAX_ALTERNATIVES) {
    refuse(
      "path-too-many-alternatives",
      `A path may name at most ${MAX_ALTERNATIVES} alternatives, and this one names ${alternatives + orCount}. The agent's cost grows with the expression rather than with the answer, about half a millisecond an alternative, and it serves the machine's own clients too.`,
    );
  }

  for (const name of pathFunctionNames(path)) {
    if (name === "and" || name === "or") continue;
    if (!ALLOWED_FUNCTIONS.includes(name)) {
      refuse(
        "path-function",
        `${name}() is not a function this provider sends. It takes ${ALLOWED_FUNCTIONS.join(" and ")}, whose cost on the agent was measured.`,
      );
    }
  }
}

/**
 * READ EACH NAME BACKWARDS FROM ITS OWN `(`, RATHER THAN SCANNING FORWARD FOR A NAME. The
 * forward form was `path.matchAll(/([A-Za-z][A-Za-z0-9-]*)\s*\(/g)`, and on a path that holds no
 * `(` at all every position started a name that ran to the end before failing, which is quadratic
 * in the length of the path: MEASURED at 9.9 ms for 4,096 characters, 38 ms for 8,192 and 38 s for
 * 262,144. `MAX_PATH_BYTES` kept that bounded, but the bound was the only thing keeping it
 * bounded, and it is declared a hundred lines away from the loop it was protecting. Walking back
 * from each `(` reads every character a constant number of times, because the walk stops at the
 * previous `(`. The two forms accept and refuse exactly the same names, which is pinned by a
 * differential test over a generated corpus rather than by reading the two expressions.
 */
export function pathFunctionNames(path: string): readonly string[] {
  const names: string[] = [];
  for (let open = path.indexOf("("); open !== -1; open = path.indexOf("(", open + 1)) {
    let end = open;
    while (end > 0 && WHITESPACE.test(path[end - 1] ?? "")) end -= 1;
    let start = end;
    while (start > 0 && NAME_CHAR.test(path[start - 1] ?? "")) start -= 1;
    // A name begins with a letter, so `9foo(` names `foo` exactly as the forward form did.
    while (start < end && !NAME_HEAD.test(path[start] ?? "")) start += 1;
    if (start === end) continue;
    names.push(path.slice(start, end));
  }
  return names;
}

/** A sequence number as the provider will send it, or a refusal. */
export function assertSequence(key: string, value: string, window?: MtcWindow): bigint {
  if (!DECIMAL.test(value)) {
    refuse("bad-sequence", `${key} takes a sequence number written in decimal digits, not ${JSON.stringify(value)}.`);
  }
  const sequence = BigInt(value);
  if (sequence < BigInt(1) || sequence > MAX_SEQUENCE) {
    refuse("bad-sequence", `${key} takes a sequence number from 1 to ${MAX_SEQUENCE}.`);
  }
  if (window === undefined) return sequence;
  if (sequence < window.firstSequence) {
    refuse(
      "window",
      `${key} is ${sequence}, and the agent's buffer now begins at ${window.firstSequence}, so ${window.firstSequence - sequence} observations were lost before this read.`,
    );
  }
  if (sequence > window.nextSequence) {
    refuse("window", `${key} is ${sequence}, past the agent's next sequence number of ${window.nextSequence}.`);
  }
  return sequence;
}

/**
 * `count` is a non zero integer, and it may be negative: MEASURED on the pinned agent,
 * `count=-3` answered 200 with the newest three and a `nextSequence` one below the oldest returned.
 */
export function assertCount(value: string, window: MtcWindow | undefined, rowCap: number): number {
  if (!SIGNED_DECIMAL.test(value)) {
    refuse("bad-count", `count takes a whole number, not ${JSON.stringify(value)}.`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count === 0) {
    refuse("bad-count", "count takes a whole number other than zero. A negative count reads the newest rows.");
  }
  const size = Math.abs(count);
  if (window !== undefined && BigInt(size) > window.bufferSize) {
    refuse("bad-count", `count may not be larger than the agent's buffer of ${window.bufferSize} observations.`);
  }
  if (size > rowCap) refuse("bad-count", `count may not be larger than this read's row cap of ${rowCap}.`);
  return count;
}

export interface MtcGuardOptions {
  readonly window?: MtcWindow;
  readonly rowCap: number;
  /** Device names and uuids the held model knows, so an unknown device is refused before a request. */
  readonly knownDevices?: ReadonlySet<string>;
}

/**
 * Read one request line and refuse it, or return the request the client will build from it.
 *
 * A trailing slash is refused rather than trimmed. MEASURED on the demo: the agent accepts it and
 * answers the same bytes, so this is the provider's rule and not the agent's. Trimming would open
 * another place where what is sent is not what was written, and once one variant is accepted there
 * is no principled end to `/probe//` or `/./probe`.
 */
export function guardRequestLine(line: string, options: MtcGuardOptions): MtcRequest {
  // COMMENT LINES FIRST, BECAUSE THE DIALECT PROMISES THEM. `MTC_CONSOLE_DIALECT` declares `#` as a
  // comment marker, so the editor draws a `#` line as a comment and the tree's generator writes one
  // above the request it builds. Without this the whole text reached the `#` rule below and every
  // generated request was refused as carrying a fragment, which is a sentence about a URL and not
  // about a comment. A `#` after the route is still a fragment and still refused.
  // LENGTH FIRST, BECAUSE EVERYTHING BELOW READS THE WHOLE LINE. The split, the trims and the
  // method match each walk the text end to end, so a bound that comes after them is not a bound on
  // the work. This one is measured against the widest request the provider can send, not against
  // what an editor can hold.
  if (line.length > MAX_REQUEST_BYTES) {
    refuse(
      "request-too-long",
      `A request may be at most ${MAX_REQUEST_BYTES} bytes, and this one is ${line.length}. The agent answers nothing at all past about 8 KiB of request headers: it closes the connection without an error document.`,
    );
  }
  const lines = line
    .split("\n")
    .map((text) => text.trim())
    .filter((text) => text !== "" && !text.startsWith("#"));
  if (lines.length > 1) {
    refuse("two-requests", `A run sends one request. This text holds ${lines.length} lines that are not comments.`);
  }
  const trimmed = (lines[0] ?? "").trim();
  /*
   * The method is read with a LOOKAHEAD rather than a second group, so the two quantifiers never
   * hand work back to each other.
   *
   * THE PATTERN THIS REPLACED WAS NOT QUADRATIC HERE, and the comment that first stood in this
   * place said it was. `/^([A-Za-z]+)\s+(.*)$/` was fed the input CodeQL names - a line that
   * begins `A\t` and carries many `\t\t` - with no bound in the way, each timing the smallest of
   * five runs under Bun 1.4.2: 65,536 characters 0.027 ms, 131,072 0.056, 262,144 0.111, 524,288
   * 0.224, 1,048,576 0.444. A doubling factor of 2.0 at every step, and the same in four shapes,
   * including the two that make it backtrack (a letter after the tabs, a line terminator the `.`
   * cannot cross). A megabyte of the named input costs 0.44 ms. Two measurements under 0.02 ms
   * cannot tell linear from quadratic apart; five points across sixteen-fold input can.
   *
   * And the named input cannot reach this line in any case: `trimmed` comes from the split and
   * the trims above, so it holds no newline and cannot end in whitespace.
   *
   * IT IS STILL READ WITH A LOOKAHEAD, for the reason the earlier comment had right: a scanner
   * cannot read a bound, the alert is a required check on this repository, and `[A-Za-z]+(?=\s)`
   * cannot hand work back at all. What changed is the claim, not the decision. A comment that
   * states a defect the code does not have is the expensive kind: nothing goes red, and the next
   * reader is sent somewhere the problem is not.
   *
   * The two forms are not identical, and the difference is pinned by the case
   * `tests/unit/db/mtconnect/guard.test.ts` names: a line whose tail holds a bare CR.
   */
  const methodHead = /^[A-Za-z]+(?=\s)/.exec(trimmed);
  const withMethod =
    methodHead === null ? null : ([trimmed, methodHead[0], trimmed.slice(methodHead[0].length).trim()] as const);
  let target = trimmed;
  if (withMethod !== null) {
    if (withMethod[1].toUpperCase() !== "GET") {
      refuse(
        "method",
        `${withMethod[1].toUpperCase()} is not a method this provider sends. It sends GET and nothing else.`,
      );
    }
    target = withMethod[2].trim();
  }
  if (target === "") refuse("unknown-route", "A request needs a route.");
  if (target.includes("://") || target.startsWith("//")) {
    refuse("absolute-url", "A request names a route only, never a scheme or a host: the connection supplies both.");
  }
  if (target.includes("#")) refuse("fragment", "A route takes no # fragment.");

  const question = target.indexOf("?");
  const path = question === -1 ? target : target.slice(0, question);
  const queryText = question === -1 ? "" : target.slice(question + 1);

  if (path.length > 1 && path.endsWith("/")) {
    refuse("trailing-slash", `A route is written without a trailing slash: ${path.slice(0, -1)}.`);
  }
  if (!path.startsWith("/")) refuse("unknown-route", `A route begins with /, so ${JSON.stringify(path)} is not one.`);

  const matched = matchRoute(path.slice(1));
  if (matched === undefined) refuse("unknown-route", `GET ${path} is not a route this provider runs.`);
  const { route, params } = matched;

  for (const [name, value] of Object.entries(params)) {
    const encoded = encodeURIComponent(value).length;
    if (encoded > MAX_PARAM_BYTES) {
      refuse(
        "param-too-long",
        `${name} may be at most ${MAX_PARAM_BYTES} bytes once encoded, and this one is ${encoded}.`,
      );
    }
  }

  if (params.device !== undefined && options.knownDevices !== undefined && !options.knownDevices.has(params.device)) {
    refuse("unknown-device", `This agent serves no device named ${JSON.stringify(params.device)}.`);
  }

  const query: Record<string, string> = {};
  if (queryText !== "") {
    for (const pair of queryText.split("&")) {
      if (pair === "") continue;
      const equals = pair.indexOf("=");
      const key = decodedPart(equals === -1 ? pair : pair.slice(0, equals), pair);
      const value = equals === -1 ? "" : decodedPart(pair.slice(equals + 1).replace(/\+/g, " "), pair);
      if (Object.prototype.hasOwnProperty.call(query, key)) {
        refuse(
          "repeated-key",
          // What the agent does with a repeat is NOT defined: the standard says each parameter
          // appears once in the query (1.4.0 8.3.2.2), so there is no required behaviour to
          // report. What we have is one measurement - `count=1&count=5` returned one observation
          // on the pinned 2.8.0.3 agent - and the sentence says that rather than predicting what
          // the agent in front of this reader will do with it.
          `${key} is given twice, and a query carries each parameter once. Which one an agent honours is not defined: the one measured here (2.8.0.3) took the first and dropped the second without saying so.`,
        );
      }
      const why = MTC_REFUSED_KEYS[key];
      if (why !== undefined) refuse("refused-key", `${key} is not sent by this provider: ${why}.`);
      if (!Object.prototype.hasOwnProperty.call(route.query, key)) {
        const accepted = Object.keys(route.query);
        refuse(
          "unknown-key",
          accepted.length === 0
            ? `${path} takes no query keys.`
            : `${path} does not take ${key}. It takes ${accepted.join(", ")}.`,
        );
      }
      query[key] = value;
    }
  }

  if (query.path !== undefined) assertPathInSubset(query.path);
  if (query.from !== undefined) assertSequence("from", query.from, options.window);
  if (query.at !== undefined) assertSequence("at", query.at, options.window);
  if (query.to !== undefined) {
    const to = assertSequence("to", query.to, options.window);
    if (query.from !== undefined && to < BigInt(query.from)) {
      refuse("window", "to may not be below from.");
    }
  }
  if (query.count !== undefined) assertCount(query.count, options.window, options.rowCap);
  if (query.removed !== undefined && query.removed !== "true" && query.removed !== "false") {
    refuse("bad-boolean", "removed takes true or false.");
  }

  return { op: route.op, route, params, query };
}
