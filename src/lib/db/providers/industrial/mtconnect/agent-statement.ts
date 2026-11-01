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
 * One rule is the agent's own: a path parameter written `.` or `..` is refused here in agent mode's words. The shared
 * endpoint builder refuses such a request too, since the URL it would send is not the path that was written, but in
 * the transport's words.
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

/** Each route of the table as the console writes it, with the keys it takes. */
function routeList(): string {
  return MTC_ROUTES.map((route) => {
    const keys = Object.keys(route.query);
    return keys.length === 0 ? `/${route.template}` : `/${route.template} (${keys.join(", ")})`;
  }).join("; ");
}

/** What agent mode reads on MTConnect, in the words every refusal of the reader repeats. */
export const MTCONNECT_AGENT_READS = `Agent mode on MTConnect reads with one request line per read, written as the console writes it, GET implied: ${routeList()}. A {device} is a device name or uuid the agent's model holds, {assetIds} one asset id or several joined by ;. Only GET is sent; ${Object.keys(MTC_REFUSED_KEYS).join(", ")} and /cancel are refused, and so is every other route, method and key.`;

const MTCONNECT_AGENT_SENTENCES = {
  reads: MTCONNECT_AGENT_READS,
  /** `message` is the console guard's refusal; the list of reads follows it. */
  request: (message: string): string => `${message.replace(/\.$/, "")}. ${MTCONNECT_AGENT_READS} ${NOTHING_SENT}`,
  dotSegment: (name: string): string =>
    `${name} is a dot segment, which a URL resolves to another path, so what would be sent is not the route that was written`,
} as const;

export type MtconnectAgentReading =
  | { readonly ok: true; readonly request: MtcRequest }
  | { readonly ok: false; readonly code: "request"; readonly message: string };

/** The rows a read may answer at most, read by the guard's `count` check: the console's own cap. */
const ADMISSION_ROW_CAP = 10_000;

/**
 * One agent request line read to the request the provider sends, or to why it sends nothing. Never sends anything.
 * `options` carries the agent's device names when the reader has its model; absent, a device name's shape is read.
 */
export function readMtconnectAgentStatement(
  text: string,
  options: MtcGuardOptions = { rowCap: ADMISSION_ROW_CAP },
): MtconnectAgentReading {
  let request: MtcRequest;
  try {
    request = guardRequestLine(text, options);
  } catch (error) {
    // The guard refuses with an MtcRefusal only; anything else is a defect.
    if (!(error instanceof MtcRefusal)) throw error;
    return { ok: false, code: "request", message: MTCONNECT_AGENT_SENTENCES.request(error.message) };
  }
  for (const [name, value] of Object.entries(request.params)) {
    if (value === "." || value === "..") {
      return {
        ok: false,
        code: "request",
        message: MTCONNECT_AGENT_SENTENCES.request(MTCONNECT_AGENT_SENTENCES.dotSegment(name)),
      };
    }
  }
  return { ok: true, request };
}
