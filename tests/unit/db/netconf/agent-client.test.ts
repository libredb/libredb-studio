/**
 * The agent's NETCONF client: the full RPC body of every request it can send, pinned through the one builder, the
 * library it reads, and its refusals by error-tag alone, never by the device's own words.
 */
import { describe, expect, test } from "bun:test";
import {
  createNetconfAgentClient,
  NetconfAgentError,
  NETCONF_AGENT_CLIENT_SENTENCES,
} from "@/lib/db/providers/network/netconf/agent-client";
import type { SessionPort } from "@/lib/db/providers/network/netconf/reader";
import { buildRpc, type NetconfRequest } from "@/lib/db/providers/network/netconf/requests";
import { netconfXmlPort } from "@/lib/db/providers/network/netconf/xml";

const BASE = 'xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"';
const LIBRARY_REPLY = `<rpc-reply ${BASE}><data><modules-state xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-library">
  <module-set-id>9</module-set-id>
  <module><name>ietf-interfaces</name><revision>2018-02-20</revision><namespace>urn:ietf:params:xml:ns:yang:ietf-interfaces</namespace><conformance-type>implement</conformance-type></module>
  <module><name>vendor</name><revision></revision><namespace>urn:example:vendor</namespace><submodule><name>vendor-sub</name><revision>2020-01-01</revision></submodule><submodule><name>vendor-bare</name></submodule><submodule><revision>2020</revision></submodule></module>
  <module><revision>2020</revision></module>
  <module><name>ietf-netconf-nmda</name><namespace>urn:ietf:params:xml:ns:yang:ietf-netconf-nmda</namespace></module>
</modules-state></data></rpc-reply>`;

/** A session that records every request it is asked and answers from `replies`, in order. */
function sessionOf(replies: string[]): { session: SessionPort; sent: NetconfRequest[]; closed: { count: number } } {
  const sent: NetconfRequest[] = [];
  const closed = { count: 0 };
  return {
    sent,
    closed,
    session: {
      request: async (request) => {
        sent.push(request);
        const reply = replies.shift();
        if (reply === undefined) throw new Error("no reply scripted");
        return reply;
      },
      close: async () => void (closed.count += 1),
    },
  };
}

const rpcs = (sent: NetconfRequest[]) => sent.map((request, index) => buildRpc(request, index + 1));

describe("the requests it sends, as full RPC bodies", () => {
  test("the library read, a schema with and without its revision, get-config with this session's namespace, get-data and the close", async () => {
    const data = `<rpc-reply ${BASE}><data><interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"/></data></rpc-reply>`;
    const yang = `<rpc-reply ${BASE}><data xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring">module x { }</data></rpc-reply>`;
    const { session, sent, closed } = sessionOf([LIBRARY_REPLY, yang, yang, data, data]);
    const client = createNetconfAgentClient(session, netconfXmlPort);
    const library = await client.library();
    expect(await client.schema("vendor-sub", "2020-01-01")).toBe("module x { }");
    expect(await client.schema("vendor", undefined)).toBe("module x { }");
    const namespaces = new Map([["ietf-interfaces", "urn:example:per-read"]]);
    const path = [
      { module: "ietf-interfaces", name: "interfaces" },
      { name: "interface", keys: ['a<b>&"c'] },
    ];
    await client.read("running", path, namespaces);
    await client.read("operational", path, namespaces);
    await client.close();
    expect(closed.count).toBe(1);
    expect(library).toEqual({
      nmda: true,
      modules: [
        {
          name: "ietf-interfaces",
          revision: "2018-02-20",
          namespace: "urn:ietf:params:xml:ns:yang:ietf-interfaces",
          submodules: [],
        },
        {
          name: "vendor",
          namespace: "urn:example:vendor",
          submodules: [{ name: "vendor-sub", revision: "2020-01-01" }, { name: "vendor-bare" }],
        },
        { name: "ietf-netconf-nmda", namespace: "urn:ietf:params:xml:ns:yang:ietf-netconf-nmda", submodules: [] },
      ],
    });
    const filter =
      '<interfaces xmlns="urn:example:per-read"><interface><name>a&lt;b&gt;&amp;&quot;c</name></interface></interfaces>';
    expect(rpcs(sent)).toEqual([
      `<rpc message-id="1" ${BASE}><get><filter type="subtree"><modules-state></modules-state></filter></get></rpc>`,
      `<rpc message-id="2" ${BASE}><get-schema xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring"><identifier>vendor-sub</identifier><version>2020-01-01</version><format>yang</format></get-schema></rpc>`,
      `<rpc message-id="3" ${BASE}><get-schema xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring"><identifier>vendor</identifier><format>yang</format></get-schema></rpc>`,
      `<rpc message-id="4" ${BASE}><get-config><source><running/></source><filter type="subtree">${filter}</filter></get-config></rpc>`,
      `<rpc message-id="5" ${BASE}><get-data xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-nmda" xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores"><datastore>ds:operational</datastore><subtree-filter>${filter}</subtree-filter></get-data></rpc>`,
    ]);
  });

  test("candidate and startup are read with get-config, and a module this read's library does not name is never guessed", async () => {
    const data = `<rpc-reply ${BASE}><data/></rpc-reply>`;
    const { session, sent } = sessionOf([data, data]);
    const client = createNetconfAgentClient(session, netconfXmlPort);
    await client.read("candidate", [{ name: "x" }], new Map());
    await client.read("startup", [{ name: "x" }], new Map());
    expect(sent.map((request) => request.operation === "get-config" && request.source)).toEqual([
      "candidate",
      "startup",
    ]);
    // The builder takes the namespace from this read's library alone, and refuses a module it does not name.
    expect(() =>
      buildRpc(
        {
          operation: "get-config",
          source: "running",
          filter: { nodes: [{ module: "unlisted", name: "x" }], namespaces: new Map() },
        },
        1,
      ),
    ).toThrow("does not name module unlisted");
  });
});

describe("what it refuses", () => {
  test("get-data on a device whose library lists no ietf-netconf-nmda, before anything is sent", async () => {
    const plain = LIBRARY_REPLY.replace(/<module><name>ietf-netconf-nmda[\s\S]*?<\/module>/, "");
    const { session, sent } = sessionOf([plain]);
    const client = createNetconfAgentClient(session, netconfXmlPort);
    expect((await client.library()).nmda).toBe(false);
    await expect(client.read("intended", [{ name: "x" }], new Map())).rejects.toThrow(
      NETCONF_AGENT_CLIENT_SENTENCES.noNmda("intended"),
    );
    expect(sent).toHaveLength(1);
  });

  test("an rpc-error by its RFC 6241 error-tag alone, never by the device's message, path or info", async () => {
    const SECRET = "not-a-real-secret";
    const error = (tag: string) =>
      `<rpc-reply ${BASE}><rpc-error><error-type>application</error-type><error-tag>${tag}</error-tag><error-path>/x[name='${SECRET}']</error-path><error-message>${SECRET}</error-message></rpc-error></rpc-reply>`;
    const { session } = sessionOf([error("access-denied"), error(SECRET), `<rpc-reply ${BASE}><ok/></rpc-reply>`]);
    const client = createNetconfAgentClient(session, netconfXmlPort);
    for (const expected of [
      NETCONF_AGENT_CLIENT_SENTENCES.rpcError("access-denied"),
      NETCONF_AGENT_CLIENT_SENTENCES.rpcError(undefined),
      NETCONF_AGENT_CLIENT_SENTENCES.noData,
    ]) {
      const caught = await client.read("running", [{ name: "x" }], new Map()).catch((failure: unknown) => failure);
      expect(caught).toBeInstanceOf(NetconfAgentError);
      expect((caught as Error).message).toBe(expected);
      expect((caught as Error).message).not.toContain(SECRET);
    }
    expect(NETCONF_AGENT_CLIENT_SENTENCES.rpcError("access-denied")).toStartWith(
      "The device refused the read with the NETCONF error-tag access-denied.",
    );
  });

  test("a library with no modules-state and a schema with no text", async () => {
    const { session } = sessionOf([`<rpc-reply ${BASE}><data/></rpc-reply>`, `<rpc-reply ${BASE}><data/></rpc-reply>`]);
    const client = createNetconfAgentClient(session, netconfXmlPort);
    await expect(client.library()).rejects.toThrow(NETCONF_AGENT_CLIENT_SENTENCES.noLibrary);
    await expect(client.schema("m", undefined)).rejects.toThrow(NETCONF_AGENT_CLIENT_SENTENCES.noText("m"));
  });
});
