/**
 * The agent's NETCONF client: the only way an agent read reaches the session.
 *
 * It holds three reads and the session's close, each built by `buildRpc` in `requests.ts`, the one module that
 * produces element text, from typed arguments: `<get>` of the YANG library (`modules-state`, the read every console
 * connection makes first), `<get-schema>` of one module or submodule, and the data read the console makes,
 * `<get-config>` for running, candidate and startup and `<get-data>` for operational and intended. No function here
 * takes element text, and none names an operation outside `ALLOWED_OPERATIONS`, which holds no write.
 *
 * One client per agent read, over a session opened for that read alone and closed when it ends, so no session, message
 * id, namespace or module text of one read reaches the next. The filter carries this session's own library namespaces
 * (`SubtreeFilter.namespaces`), never the module-scoped map another connection may have filled.
 *
 * A reply that is an `rpc-error` is refused by its error-tag alone, when the tag is one RFC 6241 Appendix A defines,
 * and never by the device's own message, path or info, which can echo a node or a value.
 */
import { QueryError } from "@/lib/db/errors";
import type { NetconfAgentDatastore } from "./agent-statement";
import type { NetconfLibraryModule } from "./agent-withheld";
import type { PathNode } from "./keypath";
import type { SessionPort } from "./reader";
import { READER_LIMITS, type XmlElement, type XmlReaderPort } from "./reader-port";

/** The device's YANG library, as the agent's check needs it. */
export interface NetconfAgentLibrary {
  readonly modules: readonly NetconfLibraryModule[];
  /** True when the library lists ietf-netconf-nmda, so `<get-data>` is served (`docs/providers/netconf.md` 3.2). */
  readonly nmda: boolean;
}

export interface NetconfAgentClient {
  readonly library: () => Promise<NetconfAgentLibrary>;
  readonly schema: (identifier: string, revision: string | undefined) => Promise<string>;
  readonly read: (
    datastore: NetconfAgentDatastore,
    path: readonly PathNode[],
    namespaces: ReadonlyMap<string, string>,
  ) => Promise<XmlElement>;
  readonly close: () => Promise<void>;
}

/** RFC 6241 Appendix A's error-tags: the only text of an `rpc-error` an agent answer may name. */
const ERROR_TAGS: ReadonlySet<string> = new Set([
  "in-use",
  "invalid-value",
  "too-big",
  "missing-attribute",
  "bad-attribute",
  "unknown-attribute",
  "missing-element",
  "bad-element",
  "unknown-element",
  "unknown-namespace",
  "access-denied",
  "lock-denied",
  "resource-denied",
  "rollback-failed",
  "data-exists",
  "data-missing",
  "operation-not-supported",
  "operation-failed",
  "partial-operation",
  "malformed-message",
]);

const NO_DEVICE_TEXT = "Studio quotes nothing of the device's own error text, which can name a node or a value.";

export const NETCONF_AGENT_CLIENT_SENTENCES = {
  rpcError: (tag: string | undefined): string =>
    tag !== undefined && ERROR_TAGS.has(tag)
      ? `The device refused the read with the NETCONF error-tag ${tag}. ${NO_DEVICE_TEXT}`
      : `The device refused the read with an error-tag NETCONF does not define. ${NO_DEVICE_TEXT}`,
  noData: `The device answered the read with neither data nor an error, so it was not answered. ${NO_DEVICE_TEXT}`,
  noText: (module: string): string => `The device answered no YANG text for the module ${module}.`,
  noLibrary: "The device answered no YANG library (modules-state).",
  noNmda: (datastore: string): string =>
    `The device does not serve the ${datastore} datastore: its YANG library lists no ietf-netconf-nmda, so get-data is not sent.`,
} as const;

/** A refusal or failure worded by Studio. The class tells a caller that nothing in it came from the device's bytes. */
export class NetconfAgentError extends QueryError {
  constructor(message: string) {
    super(message, "netconf");
    this.name = "NetconfAgentError";
    Object.setPrototypeOf(this, NetconfAgentError.prototype);
  }
}

const childText = (element: XmlElement, name: string): string | undefined =>
  element.children.find((child) => child.name === name)?.text;

/** A library entry's revision, an empty one read as none. */
const revisionOf = (entry: XmlElement): string | undefined => {
  const revision = childText(entry, "revision");
  return revision === "" ? undefined : revision;
};

/** One `module` entry of `modules-state`, with its submodules. */
function libraryEntry(entry: XmlElement): NetconfLibraryModule {
  const submodules: { name: string; revision?: string }[] = [];
  for (const sub of entry.children) {
    const name = sub.name === "submodule" ? childText(sub, "name") : undefined;
    if (name === undefined) continue;
    const revision = revisionOf(sub);
    submodules.push(revision === undefined ? { name } : { name, revision });
  }
  const read: { name: string; revision?: string; namespace?: string; submodules: typeof submodules } = {
    name: childText(entry, "name") as string,
    submodules,
  };
  const revision = revisionOf(entry);
  const namespace = childText(entry, "namespace");
  if (revision !== undefined) read.revision = revision;
  if (namespace !== undefined) read.namespace = namespace;
  return read;
}

/** The `<data>` of one reply, or the read's refusal by its error-tag. */
function dataOf(xml: XmlReaderPort, reply: string): XmlElement {
  const root = xml.parse(reply, READER_LIMITS);
  const error = root.children.find((child) => child.name === "rpc-error");
  if (error !== undefined)
    throw new NetconfAgentError(NETCONF_AGENT_CLIENT_SENTENCES.rpcError(childText(error, "error-tag")));
  const data = root.children.find((child) => child.name === "data");
  if (data === undefined) throw new NetconfAgentError(NETCONF_AGENT_CLIENT_SENTENCES.noData);
  return data;
}

const CONFIG_DATASTORES: ReadonlySet<string> = new Set(["running", "candidate", "startup"]);
const NMDA_MODULE = "ietf-netconf-nmda";

/** The agent's reads over one session. */
export function createNetconfAgentClient(session: SessionPort, xml: XmlReaderPort): NetconfAgentClient {
  let nmda = false;
  return Object.freeze<NetconfAgentClient>({
    library: async () => {
      const data = dataOf(
        xml,
        await session.request({ operation: "get", filter: { nodes: [{ name: "modules-state" }] } }),
      );
      const state = data.children.find((child) => child.name === "modules-state");
      if (state === undefined) throw new NetconfAgentError(NETCONF_AGENT_CLIENT_SENTENCES.noLibrary);
      const modules = state.children
        .filter((child) => child.name === "module" && childText(child, "name") !== undefined)
        .map(libraryEntry);
      nmda = modules.some((entry) => entry.name === NMDA_MODULE);
      return { modules, nmda };
    },
    schema: async (identifier, revision) => {
      const data = dataOf(
        xml,
        await session.request({
          operation: "get-schema",
          identifier,
          ...(revision === undefined ? {} : { version: revision }),
        }),
      );
      if (data.text === undefined || data.text === "")
        throw new NetconfAgentError(NETCONF_AGENT_CLIENT_SENTENCES.noText(identifier));
      return data.text;
    },
    read: async (datastore, path, namespaces) => {
      const filter = { nodes: path, namespaces };
      if (CONFIG_DATASTORES.has(datastore)) {
        const source = datastore as "running" | "candidate" | "startup";
        return dataOf(xml, await session.request({ operation: "get-config", source, filter }));
      }
      if (!nmda) throw new NetconfAgentError(NETCONF_AGENT_CLIENT_SENTENCES.noNmda(datastore));
      return dataOf(
        xml,
        await session.request({ operation: "get-data", datastore: datastore as "operational" | "intended", filter }),
      );
    },
    close: () => session.close(),
  });
}
