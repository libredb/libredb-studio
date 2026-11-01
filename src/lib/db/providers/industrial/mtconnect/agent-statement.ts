/**
 * The agent's reader of one MTConnect request line: what the agent read-only profile sends, read before anything is
 * sent.
 *
 * Pure. The request is the console's own, one request line in the agent's URL grammar with GET implied, read by the
 * console's own guard (`guardRequestLine` in `guard.ts`) against the console's own closed route table
 * (`MTC_ROUTES` in `routes.ts`), so a request is read by one grammar wherever it is written. The request line is the
 * statement, as a command line is on kubectl and S3. The guard refuses, before anything is sent, every method but GET,
 * a second request line, a route outside the nine, a scheme or a host, a fragment, a trailing slash, every streaming
 * parameter (`interval`, `heartbeat`, `frequency`) and the other parameters it refuses by name, a key the route does
 * not take, a repeated key, a path parameter longer than its bound and a `path` outside the measured subset.
 *
 * Two rules are the agent's own. A path parameter written `.` or `..` is refused here in agent mode's words. The shared
 * endpoint builder refuses such a request too, since the URL it would send is not the path that was written, but in
 * the transport's words. And a `path` is narrower than the console's: `//DataItem` alternatives whose predicate tests
 * an attribute for equality with a quoted value, each value one a data item agent mode reads holds. The console's
 * `contains()` and `starts-with()`, and a test on any element but a data item, would let a model-written path ask the
 * agent whether a withheld adapter id or name holds a text, and read the answer from a hit or a miss, so they are not
 * sent; and since every value must be a value of an item the model may read anyway, whether a value is admitted is
 * decided from what agent mode answers, never from what it withholds.
 *
 * The admission has no connection in hand, so it reads the device name's shape only; the provider reads the same text
 * against the agent's device model again before anything is sent, and refuses a device the model does not hold.
 *
 * Not the boundary. The boundary is the provider's structural closed route table: the client has one operation, a GET
 * of a route from the table, with no method argument and no body parameter. This is what lets the model read why it was
 * refused, before anything is sent.
 */
import { guardRequestLine, MtcRefusal, type MtcGuardOptions, type MtcRequest } from "./guard";
import { MTC_REFUSED_KEYS, MTC_ROUTES } from "./routes";

const NOTHING_SENT = "Nothing was sent.";
/** A refusal decided from the device model is made after the model read, so it cannot say nothing was sent. */
const MODEL_READ_ONLY = "Only the device model was read, with GET /probe; the request itself was not sent.";

/** The attributes an agent-mode path may test, each a field of a data item in the device model. */
export const MTCONNECT_AGENT_PATH_ATTRIBUTES = Object.freeze(["id", "name", "type", "subType", "category"] as const);
export type MtconnectAgentPathAttribute = (typeof MTCONNECT_AGENT_PATH_ATTRIBUTES)[number];

/** One equality test of an agent-mode path. */
export interface MtconnectAgentPathTest {
  readonly attribute: MtconnectAgentPathAttribute;
  readonly value: string;
}

/** What an agent-mode path may be, in the words every path refusal and the list of reads repeat. */
export const MTCONNECT_AGENT_PATH_RULE = `A path in agent mode is one or more //DataItem alternatives joined by |, each with at most one [...] predicate of equality tests @attribute="value" on ${MTCONNECT_AGENT_PATH_ATTRIBUTES.map((name) => `@${name}`).join(", ")}, joined by and or or, and every value is one a data item agent mode reads holds, as /probe lists it; no function and no other element is sent`;

/** Each route of the table as the console writes it, with the keys it takes. */
function routeList(): string {
  return MTC_ROUTES.map((route) => {
    const keys = Object.keys(route.query);
    return keys.length === 0 ? `/${route.template}` : `/${route.template} (${keys.join(", ")})`;
  }).join("; ");
}

/** What agent mode reads on MTConnect, in the words every refusal of the reader repeats. */
export const MTCONNECT_AGENT_READS = `Agent mode on MTConnect reads with one request line per read, written as the console writes it, GET implied: ${routeList()}. A {device} is a device name or uuid the agent's model holds, {assetIds} one asset id or several joined by ;. ${MTCONNECT_AGENT_PATH_RULE}. Only GET is sent; ${Object.keys(MTC_REFUSED_KEYS).join(", ")} and /cancel are refused, and so is every other route, method and key.`;

const MTCONNECT_AGENT_SENTENCES = {
  reads: MTCONNECT_AGENT_READS,
  /** `message` is the console guard's refusal; the list of reads and what was sent follow it. */
  request: (message: string, sent: string): string => `${message.replace(/\.$/, "")}. ${MTCONNECT_AGENT_READS} ${sent}`,
  dotSegment: (name: string): string =>
    `${name} is a dot segment, which a URL resolves to another path, so what would be sent is not the route that was written`,
  path: `The path is outside what agent mode sends. ${MTCONNECT_AGENT_PATH_RULE}`,
  unreadValue: (test: MtconnectAgentPathTest): string =>
    `The path's test @${test.attribute}="${test.value}" names a value no data item agent mode reads holds, so it is not sent: a value is the ${test.attribute} of a data item of this agent's device model other than its withheld adapter connections`,
} as const;

const PATH_SPACE = /\s/;
const ATTRIBUTE_CHAR = /[A-Za-z]/;

/**
 * An agent-mode path read to its equality tests, or undefined when it is outside the subset. Read after the console's
 * guard, so its length, its quotes and its alternatives are already bounded.
 */
function readMtconnectAgentPath(path: string): readonly MtconnectAgentPathTest[] | undefined {
  const tests: MtconnectAgentPathTest[] = [];
  let at = 0;
  const space = (): void => {
    while (at < path.length && PATH_SPACE.test(path[at])) at++;
  };
  const take = (word: string): boolean => {
    if (!path.startsWith(word, at)) return false;
    at += word.length;
    return true;
  };
  const test = (): boolean => {
    space();
    if (!take("@")) return false;
    const start = at;
    while (at < path.length && ATTRIBUTE_CHAR.test(path[at])) at++;
    const attribute = MTCONNECT_AGENT_PATH_ATTRIBUTES.find((name) => name === path.slice(start, at));
    if (attribute === undefined) return false;
    space();
    if (!take("=")) return false;
    space();
    const quote = path[at];
    if (quote !== '"' && quote !== "'") return false;
    // The guard has refused an unclosed quote, so the closing one is there.
    const close = path.indexOf(quote, at + 1);
    tests.push({ attribute, value: path.slice(at + 1, close) });
    at = close + 1;
    return true;
  };
  for (;;) {
    space();
    if (!take("//DataItem")) return undefined;
    space();
    if (take("[")) {
      for (;;) {
        if (!test()) return undefined;
        space();
        if (take("]")) break;
        if (!take("and") && !take("or")) return undefined;
      }
      space();
    }
    if (at === path.length) return tests;
    if (!take("|")) return undefined;
  }
}

export type MtconnectAgentReading =
  | { readonly ok: true; readonly request: MtcRequest }
  | { readonly ok: false; readonly code: "request"; readonly message: string };

/** The rows a read may answer at most, read by the guard's `count` check: the console's own cap. */
const ADMISSION_ROW_CAP = 10_000;

/** The reader's options: the guard's, and, when the reader has the agent's model, the values a path may test. */
export interface MtconnectAgentStatementOptions extends MtcGuardOptions {
  /** Whether a data item agent mode reads holds this value in this attribute; absent, a path's shape alone is read. */
  readonly readable?: (test: MtconnectAgentPathTest) => boolean;
  /** True when the reader is called after the device model read, so a refusal says that read was sent. */
  readonly afterModelRead?: boolean;
}

/**
 * One agent request line read to the request the provider sends, or to why it sends nothing. Never sends anything.
 * `options` carries the agent's device names and readable values when the reader has its model; absent, a device
 * name's and a path's shape is read.
 */
export function readMtconnectAgentStatement(
  text: string,
  options: MtconnectAgentStatementOptions = { rowCap: ADMISSION_ROW_CAP },
): MtconnectAgentReading {
  const sent = options.afterModelRead === true ? MODEL_READ_ONLY : NOTHING_SENT;
  let request: MtcRequest;
  try {
    request = guardRequestLine(text, options);
  } catch (error) {
    // The guard refuses with an MtcRefusal only; anything else is a defect.
    if (!(error instanceof MtcRefusal)) throw error;
    return { ok: false, code: "request", message: MTCONNECT_AGENT_SENTENCES.request(error.message, sent) };
  }
  for (const [name, value] of Object.entries(request.params)) {
    if (value === "." || value === "..") {
      return {
        ok: false,
        code: "request",
        message: MTCONNECT_AGENT_SENTENCES.request(MTCONNECT_AGENT_SENTENCES.dotSegment(name), sent),
      };
    }
  }
  const path = request.query.path;
  if (path !== undefined) {
    const tests = readMtconnectAgentPath(path);
    if (tests === undefined) {
      return {
        ok: false,
        code: "request",
        message: MTCONNECT_AGENT_SENTENCES.request(MTCONNECT_AGENT_SENTENCES.path, sent),
      };
    }
    const readable = options.readable;
    const unread = readable === undefined ? undefined : tests.find((test) => !readable(test));
    if (unread !== undefined) {
      return {
        ok: false,
        code: "request",
        message: MTCONNECT_AGENT_SENTENCES.request(MTCONNECT_AGENT_SENTENCES.unreadValue(unread), sent),
      };
    }
  }
  return { ok: true, request };
}
