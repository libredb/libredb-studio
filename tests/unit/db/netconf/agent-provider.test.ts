/**
 * The provider class on an agent-mode handle: `queryReadOnly` only under the agent read-only profile, refusals before
 * anything is sent, the read through the agent's own door, and the surfaces an agent-mode handle answers with their
 * reason rather than pass a device's answer, or a filled-in figure, past the withheld-node check.
 */
import { describe, expect, test } from "bun:test";
import { QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { createNetconfAgentClient } from "@/lib/db/providers/network/netconf/agent-client";
import { NETCONF_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/network/netconf/agent-read";
import { NETCONF_AGENT_SENTENCES } from "@/lib/db/providers/network/netconf/agent-statement";
import { NETCONF_AGENT_WITHHELD } from "@/lib/db/providers/network/netconf/agent-surface";
import { NETCONF_METADATA_ONLY } from "@/lib/db/providers/network/netconf/agent-withheld";
import {
  NETCONF_PROVIDER_SENTENCES,
  NetconfProvider,
  type DeviceReader,
} from "@/lib/db/providers/network/netconf/index";
import { netconfXmlPort } from "@/lib/db/providers/network/netconf/xml";
import type { DatabaseConnection, ProviderExecutionContext } from "@/lib/db/types";
import { FAKE_SECRET, fakeNetconfDevice, interfacesData } from "../../../helpers/netconf-fake-device";

const BUDGET = { maxResultRows: 10, maxResultBytes: 100_000, statementTimeoutMs: 2_000 };
const READ = '{"datastore": "running", "path": "ex-if:interfaces"}';
const AGENT: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true, sendsStatements: false };
const connection = {
  type: "netconf",
  name: "n",
  host: "h",
  password: "not-a-real-password",
} as unknown as DatabaseConnection;

const editorReader: DeviceReader = {
  facts: { datastores: ["running"], modules: ["ex-if"], nmda: false, capabilities: [], sessionId: "1" },
  topLevelNodes: async () => [{ module: "ex-if", name: "interfaces" }],
  children: async () => [],
  rows: async () => ({ fields: ["name"], rows: [{ name: FAKE_SECRET }], rowCount: 1, executionTime: 0 }),
  moduleText: async () => "module ex-if { }",
  sourceXml: async () => `<secret>${FAKE_SECRET}</secret>`,
  close: async () => {},
};

async function provider(execution: ProviderExecutionContext, data = interfacesData(2)) {
  const device = fakeNetconfDevice({ data });
  const opened = new NetconfProvider(
    connection,
    {},
    execution,
    async () => editorReader,
    async () => createNetconfAgentClient(device.session, netconfXmlPort),
  );
  await opened.connect();
  return { provider: opened, device };
}

describe("queryReadOnly", () => {
  test("refuses a handle not opened under the agent read-only profile, the editor's and the operations profile's", async () => {
    for (const execution of [{}, OPERATIONS]) {
      const { provider: handle, device } = await provider(execution);
      await expect(handle.queryReadOnly(READ, BUDGET)).rejects.toThrow(
        new RefusedBeforeSendError(NETCONF_PROVIDER_SENTENCES.profileRequired),
      );
      expect(device.sent).toEqual([]);
    }
  });

  test("refuses a closed connection, a bad budget, an estimate and an unreadable request before anything is sent", async () => {
    const closed = new NetconfProvider(connection, {}, AGENT, async () => editorReader);
    await expect(closed.queryReadOnly(READ, BUDGET)).rejects.toThrow("This connection is not open.");
    const { provider: handle, device } = await provider(AGENT);
    await expect(handle.queryReadOnly(READ, { ...BUDGET, maxResultRows: 0 })).rejects.toThrow();
    await expect(handle.queryReadOnly(READ, BUDGET, "estimate-plan")).rejects.toThrow(
      new RefusedBeforeSendError(NETCONF_PROVIDER_SENTENCES.noEstimate),
    );
    const refusal = await handle
      .queryReadOnly('{"datastore": "running", "path": "ietf-keystore:keystore"}', BUDGET)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RefusedBeforeSendError);
    expect((refusal as Error).message).toBe(NETCONF_AGENT_SENTENCES.withheldModule("ietf-keystore"));
    expect(device.sent).toEqual([]);
  });

  test("answers through the agent's own door, values in, withheld nodes out, and warned", async () => {
    const { provider: handle, device } = await provider(AGENT);
    const result = await handle.queryReadOnly(READ, BUDGET);
    expect(result.rows).toEqual([
      { name: "ge-0", description: "port 0", secret: "[withheld]", pw: "[withheld]" },
      { name: "ge-1", description: "port 1", secret: "[withheld]", pw: "[withheld]" },
    ]);
    expect(result.rowCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET);
    expect(result.warnings).toHaveLength(4);
    expect(device.sent.at(-1)?.operation).toBe("get-config");
  });

  test("the default door dials with the connection's own settings, and a setting it cannot use is worded by category", async () => {
    const handle = new NetconfProvider(
      { ...connection, host: "" } as DatabaseConnection,
      {},
      AGENT,
      async () => editorReader,
    );
    await handle.connect();
    await expect(handle.queryReadOnly(READ, BUDGET)).rejects.toThrow(NETCONF_AGENT_FAILURE_SENTENCES.settings);
  });
});

describe("an agent-mode handle's other surfaces", () => {
  test("the console, a source and the overview answer their reason on every agent-mode profile, never the device's answer", async () => {
    for (const execution of [AGENT, OPERATIONS]) {
      const { provider: handle } = await provider(execution);
      await expect(handle.query(READ)).rejects.toThrow(new RefusedBeforeSendError(NETCONF_AGENT_WITHHELD.query));
      await expect(handle.readObjectSource(["running/ex-if:interfaces"], "key")).rejects.toThrow(
        new QueryError(NETCONF_AGENT_WITHHELD.source),
      );
      await expect(handle.getOverview()).rejects.toThrow(new QueryError(NETCONF_AGENT_WITHHELD.overview));
      // Names only, as on every handle.
      expect(await handle.listObjects(["running", "ex-if"], "node")).toEqual([
        { path: ["running", "ex-if", "interfaces"], name: "interfaces", kind: "node" },
      ]);
    }
  });

  test("the editor's handle keeps every surface", async () => {
    const { provider: handle } = await provider({});
    expect((await handle.query(READ)).rows).toEqual([{ name: FAKE_SECRET }]);
    expect((await handle.getOverview()).version).toBe("NETCONF without NMDA");
  });

  test("the capability states the withheld report's columns", () => {
    expect(new NetconfProvider(connection).getCapabilities().metadataOnly).toBe(NETCONF_METADATA_ONLY);
  });
});
