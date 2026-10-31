/**
 * The agent's reader of one OPC UA request: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure. Two of its three reads are the console's own, read by the console's own parser (`readRequest` in
 * `read-request.ts`), so they are read by one grammar wherever they are written; the third is the Keys panel's level,
 * one Browse of one node, written as JSON in the same style:
 *
 *   {"read": ["ns=3;s=SlowUInt1", ...]}                             current values, one row per node
 *   {"history": "ns=3;s=HistorianInt32", "start", "end", "limit"}  raw history of one node, one row per value
 *   {"browse": "i=85"}                                              the children of one node, one row per reference
 *
 * The console's parser is strict already: a key a shape does not name is refused, so an index range, a data encoding,
 * an attribute id, a browse direction or a mask cannot be written; those are fixed by `session.ts` for every request.
 * Every node id is put in the one spelling the agent path compares (`canonicalNodeId`), and an `nsu=` id outside
 * namespace 0 is refused, since which index it names would take a read of the server's namespace table.
 *
 * A history read or a browse of a withheld root (`agent-withheld.ts`) is refused here with its reason, before anything
 * is sent. A value read naming one is admitted, and that node is never sent: its row is answered withheld
 * (`agent-read.ts`). The nodes beneath a root have server-chosen ids, so they are decided by the provider on the read's
 * own session.
 *
 * Not the boundary. The boundary is the provider's structural closed seam: `OpcuaReadOnlyClient` (`client.ts`) holds
 * eight read services and nothing that writes, calls a method or subscribes. This is what lets the model read why it
 * was refused, before anything is sent.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { canonicalNodeId, OPCUA_WITHHELD_SENTENCE, withheldReason, withheldRootOf } from "./agent-withheld";
import { isNodeId, type OpcuaNodeId } from "./node-id";
import { readRequest } from "./read-request";

const NOTHING_SENT = "Nothing was sent.";

/** What agent mode reads on OPC UA, in the words every refusal of the reader repeats. */
export const OPCUA_AGENT_READS = `Agent mode on OPC UA reads with one JSON request per read: {"read": ["ns=3;s=SlowUInt1", ...]} reads the current value of each node, with its engineering units and EU range where the server publishes them; {"history": "ns=3;s=HistorianInt32", "start": "2026-10-31T00:00:00Z", "end": "2026-10-31T01:00:00Z", "limit": 100} reads one node's raw history (start, end and limit optional); {"browse": "i=85"} lists the children of one node, starting from the Objects folder i=85. A node id is written with its namespace index (ns=3;s=...), or in namespace 0 with no prefix (i=2256). Only Browse, BrowseNext, Read and HistoryRead are sent, never a Write, a method Call, a subscription or a node change. ${OPCUA_WITHHELD_SENTENCE}`;

export const OPCUA_AGENT_SENTENCES = {
  reads: OPCUA_AGENT_READS,
  /** `message` is the parser's refusal; the list of reads follows it. */
  request: (message: string): string => `${message.replace(/\.$/, "")}. ${OPCUA_AGENT_READS} ${NOTHING_SENT}`,
  /** A history read or a browse of a withheld root. */
  withheld: (reason: string): string => `${reason} ${NOTHING_SENT}`,
} as const;

/** One read the agent's request names. Node ids are canonical (`canonicalNodeId`). */
export type OpcuaAgentPlan =
  | { readonly kind: "read"; readonly nodeIds: readonly OpcuaNodeId[] }
  | {
      readonly kind: "history";
      readonly nodeId: OpcuaNodeId;
      readonly start?: Date;
      readonly end?: Date;
      readonly limit: number;
      /** Whether the request wrote its own limit, which decides whether a read that reaches it was cut. */
      readonly limitStated: boolean;
    }
  | { readonly kind: "browse"; readonly nodeId: OpcuaNodeId };

export type OpcuaAgentReading =
  | { readonly ok: true; readonly plan: OpcuaAgentPlan }
  | { readonly ok: false; readonly code: "request" | "withheld"; readonly message: string };

const BROWSE_KEYS: ReadonlySet<string> = new Set(["browse"]);

class AgentRequestRefusal extends Error {}

const refuse = (message: string): never => {
  throw new AgentRequestRefusal(message);
};

/** One node id in the agent's spelling, or the refusal of an `nsu=` id outside namespace 0. */
function agentNodeId(nodeId: OpcuaNodeId): OpcuaNodeId {
  const canonical = canonicalNodeId(nodeId);
  if (canonical === undefined)
    refuse(
      `${nodeId} names its namespace by URI. Agent mode reads a node id written with its namespace index (ns=3;s=...), or in namespace 0 with no prefix (i=2256).`,
    );
  return canonical as OpcuaNodeId;
}

/** The top-level keys of a JSON object, or undefined for text that is not one: the console's parser words those. */
function objectKeys(text: string): readonly string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function planOf(text: string): OpcuaAgentPlan {
  const keys = objectKeys(text);
  if (keys !== undefined && keys.length > 0) {
    const named = keys.filter((key) => key === "read" || key === "history" || key === "browse");
    if (named.length === 0) refuse(`A request names "read", "history" or "browse", and this names "${keys[0]}".`);
    if (keys.includes("browse")) {
      if (named.length > 1) refuse("A request reads values, history or one level of nodes, one at a time.");
      for (const key of keys)
        if (!BROWSE_KEYS.has(key)) refuse(`A browse takes "browse" only, and this names "${key}".`);
      const nodeId: unknown = (JSON.parse(text) as Record<string, unknown>).browse;
      if (typeof nodeId !== "string" || !isNodeId(nodeId))
        refuse('"browse" is one node id, such as "i=85" for the Objects folder.');
      return { kind: "browse", nodeId: agentNodeId(nodeId as string) };
    }
  }
  const request = readRequest(text);
  if (request.kind === "read") return { kind: "read", nodeIds: request.nodeIds.map(agentNodeId) };
  const limitStated = (JSON.parse(text) as Record<string, unknown>).limit !== undefined;
  return {
    kind: "history",
    nodeId: agentNodeId(request.nodeId),
    ...(request.start === undefined ? {} : { start: request.start }),
    ...(request.end === undefined ? {} : { end: request.end }),
    limit: request.limit,
    limitStated,
  };
}

/** One agent request read to the read the provider sends, or to why it sends nothing. Never sends anything. */
export function readOpcuaAgentStatement(text: string): OpcuaAgentReading {
  let plan: OpcuaAgentPlan;
  try {
    plan = planOf(text);
  } catch (error) {
    // The console's parser refuses with a DatabaseConfigError and this reader with its own; anything else is a defect.
    if (!(error instanceof AgentRequestRefusal) && !(error instanceof DatabaseConfigError)) throw error;
    return { ok: false, code: "request", message: OPCUA_AGENT_SENTENCES.request(error.message) };
  }
  if (plan.kind !== "read") {
    const root = withheldRootOf(plan.nodeId);
    if (root !== undefined)
      return { ok: false, code: "withheld", message: OPCUA_AGENT_SENTENCES.withheld(withheldReason(root)) };
  }
  return { ok: true, plan };
}
