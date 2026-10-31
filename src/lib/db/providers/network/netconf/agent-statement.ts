/**
 * The agent's reader of one NETCONF request: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure. Two request shapes and nothing else, each a JSON object:
 *
 *   {"datastore": D, "path": P, "limit": N}   the console's own read request, read by the console's own parser
 *                                             (`parseReadRequest` in `index.ts`), so a request is read by one grammar
 *                                             wherever it is written: `<get-config>` for running, candidate and
 *                                             startup, `<get-data>` for operational and intended
 *   {"schema": M}                             one module's YANG text, `<get-schema>`, as the Source tab reads it
 *
 * A field either shape does not name is refused, where the console ignores it, so a model is never answered a read it
 * believes it narrowed. A path must name its module on its first node, as the console's reader needs. A path into, or a
 * schema of, ietf-keystore or ietf-netconf-acm is refused here by name; every other withheld node is decided after the
 * device's own modules are read (`agent-withheld.ts`), still before the read is sent.
 *
 * Not the boundary. The boundary is the provider's structural closed table: the agent's requests reach the session only
 * through `NetconfAgentClient` (`agent-client.ts`), whose requests are the reads of `requests.ts`, the one builder of
 * element text, which holds four reads and a close and no write. This is what lets the model read why it was refused,
 * before anything is sent.
 */
import { QueryError } from "@/lib/db/errors";
import { NETCONF_WITHHELD_TEXT } from "./agent-withheld";
import { parseReadRequest } from "./read-request";
import { assertYangIdentifier, type PathNode } from "./keypath";

export type NetconfAgentRefusalCode = "request" | "withheld";

export type NetconfAgentDatastore = "running" | "candidate" | "startup" | "operational" | "intended";
const DATASTORES: ReadonlySet<string> = new Set(["running", "candidate", "startup", "operational", "intended"]);

/** One read the agent may send. */
export type NetconfAgentPlan =
  | {
      readonly kind: "read";
      readonly datastore: NetconfAgentDatastore;
      readonly path: readonly PathNode[];
      /** The request's own bound, when it wrote one; the row budget bounds it either way. */
      readonly limit?: number;
    }
  | { readonly kind: "schema"; readonly module: string };

export type NetconfAgentReading =
  | { readonly ok: true; readonly plan: NetconfAgentPlan }
  | { readonly ok: false; readonly code: NetconfAgentRefusalCode; readonly message: string };

const NOTHING_SENT = "Nothing was sent.";

const AGENT_READS = `Agent mode on NETCONF reads with one JSON request per read: {"datastore": "running", "path": "ietf-interfaces:interfaces", "limit": 100} reads the configuration (running, candidate or startup, with get-config) or the configuration and state (operational or intended, with get-data) under a path that names its module on its first node, one more name per level and a list entry's keys after = (interface=eth0), with a key's "/" written %2F (interface=ge-0%2F0%2F0), and a list holding more entries than the limit or the row budget is refused rather than cut; {"schema": "ietf-interfaces"} reads one module's YANG text (get-schema). No other operation and no other field is sent. ${NETCONF_WITHHELD_TEXT}`;

export const NETCONF_AGENT_SENTENCES = {
  reads: AGENT_READS,
  /** `message` is the console parser's refusal, or the agent's own; the list of reads follows it. */
  request: (message: string): string => `${message.replace(/\.$/, "")}. ${AGENT_READS} ${NOTHING_SENT}`,
  /** A path into, or the schema of, a module withheld whole. */
  withheldModule: (module: string): string =>
    `${module} is withheld from agent mode whole, so nothing of it is read, its YANG text included. ${AGENT_READS} ${NOTHING_SENT}`,
} as const;

const SHAPE =
  "The request is neither a read request naming a datastore and a path nor a schema request naming one module";
const WITHHELD_MODULE_NAMES: ReadonlySet<string> = new Set(["ietf-keystore", "ietf-netconf-acm"]);

function refuse(code: NetconfAgentRefusalCode, message: string): NetconfAgentReading {
  return { ok: false, code, message };
}

function readOf(body: Record<string, unknown>, text: string): NetconfAgentReading {
  const extra = Object.keys(body).filter((key) => key !== "datastore" && key !== "path" && key !== "limit");
  if (extra.length > 0) {
    return refuse(
      "request",
      NETCONF_AGENT_SENTENCES.request(`The read request holds a field agent mode does not read (${extra.join(", ")})`),
    );
  }
  const request = parseReadRequest(text);
  if (!DATASTORES.has(request.datastore)) {
    return refuse("request", NETCONF_AGENT_SENTENCES.request(`NETCONF has no datastore named ${request.datastore}`));
  }
  const [first] = request.path;
  if (first?.module === undefined) {
    return refuse(
      "request",
      NETCONF_AGENT_SENTENCES.request("A read names its module on its first node, as in ietf-interfaces:interfaces"),
    );
  }
  // RFC 6242 section 4.3 keeps the end-of-message separator out of the data, and the session refuses a request holding
  // one; the agent is told why here instead.
  if (request.path.some((node) => (node.keys ?? []).some((key) => key.includes("]]>]]>")))) {
    return refuse(
      "request",
      NETCONF_AGENT_SENTENCES.request(
        "A key value holds ]]>]]>, the end-of-message separator NETCONF keeps out of its data",
      ),
    );
  }
  const withheld = request.path.find((node) => node.module !== undefined && WITHHELD_MODULE_NAMES.has(node.module));
  if (withheld?.module !== undefined)
    return refuse("withheld", NETCONF_AGENT_SENTENCES.withheldModule(withheld.module));
  return {
    ok: true,
    plan: {
      kind: "read",
      datastore: request.datastore as NetconfAgentDatastore,
      path: request.path,
      ...(body["limit"] === undefined ? {} : { limit: request.limit }),
    },
  };
}

function schemaOf(body: Record<string, unknown>): NetconfAgentReading {
  if (Object.keys(body).length !== 1 || typeof body["schema"] !== "string") {
    return refuse(
      "request",
      NETCONF_AGENT_SENTENCES.request(
        'A schema request names one module and nothing else, as in {"schema": "ietf-interfaces"}',
      ),
    );
  }
  const named = assertYangIdentifier(body["schema"]);
  if (WITHHELD_MODULE_NAMES.has(named)) return refuse("withheld", NETCONF_AGENT_SENTENCES.withheldModule(named));
  return { ok: true, plan: { kind: "schema", module: named } };
}

/** One agent request read to the read the provider sends, or to why it sends nothing. Never sends anything. */
export function readNetconfAgentStatement(text: string): NetconfAgentReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("request", NETCONF_AGENT_SENTENCES.request("The request is not JSON"));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("request", NETCONF_AGENT_SENTENCES.request(SHAPE));
  }
  const body = parsed as Record<string, unknown>;
  try {
    if ("schema" in body) return schemaOf(body);
    if ("datastore" in body || "path" in body) return readOf(body, text);
    return refuse("request", NETCONF_AGENT_SENTENCES.request(SHAPE));
  } catch (error) {
    // The console's parser and the identifier grammar refuse with a QueryError only; anything else is a defect.
    if (!(error instanceof QueryError)) throw error;
    return refuse("request", NETCONF_AGENT_SENTENCES.request(error.message));
  }
}
