/**
 * Runs the NETCONF agent's own reads through the provider against the Netopeer2 fixture that
 * tests/fixtures/netconf/2.8.7/agent-boundary/run.sh started, reads the withheld nodes raw, sends one raw edit-config,
 * and writes what each answered into that run.sh's directory as boundary.json.
 *
 *   bun tests/live/netconf-agent-boundary.ts
 *
 * The environment names the device: NETCONF_AGENT_PORT (its SSH port on 127.0.0.1), NETCONF_AGENT_OUT (the directory
 * to write), NETCONF_AGENT_PASSWORD (the read-only account's password, generated per run by run.sh) and
 * NETCONF_AGENT_FINGERPRINT (the host key pin, read out of band). The capture records no credential value at all, not
 * even a placeholder: a raw read is recorded by the element paths it answered and how many of each, never by a value,
 * and before anything is written the whole capture is checked for the password, the fingerprint and every value the
 * raw reads held under a withheld node, and the script stops if any is there.
 *
 * The raw reads go through the provider's own session (`openNetconfSession`), never through the agent path, which is
 * the point: what is measured is what the device answers a raw read of each withheld node under the fixture's
 * read-only account. The raw edit-config is written by this script on an SSH channel of its own, never by Studio,
 * whose request builder cannot build one.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the device holds then.
import { writeFileSync } from "node:fs";
import { posix } from "node:path";
import { Client } from "ssh2";
import { NETCONF_WITHHELD_REASONS, NetconfWithheldPolicy } from "@/lib/db/providers/network/netconf/agent-withheld";
import { createNetconfAgentClient } from "@/lib/db/providers/network/netconf/agent-client";
import { fingerprintOf } from "@/lib/db/providers/network/netconf/hostkey";
import { NetconfProvider } from "@/lib/db/providers/network/netconf/index";
import { nodeSocketPort, nodeSshPort } from "@/lib/db/providers/network/netconf/node-ports";
import { openNetconfReader, openNetconfSession } from "@/lib/db/providers/network/netconf/open";
import type { XmlElement } from "@/lib/db/providers/network/netconf/reader-port";
import { netconfXmlPort } from "@/lib/db/providers/network/netconf/xml";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const PORT = Number(env("NETCONF_AGENT_PORT"));
const OUT = env("NETCONF_AGENT_OUT");
const PASSWORD = env("NETCONF_AGENT_PASSWORD");
const FINGERPRINT = env("NETCONF_AGENT_FINGERPRINT");
const DATE = new Date().toISOString().slice(0, 10);
const AGENT: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 50, maxResultBytes: 1_000_000, statementTimeoutMs: 20_000 };
const ports = { xml: netconfXmlPort, ssh: nodeSshPort, socket: nodeSocketPort };

const connection = {
  id: "agent-boundary",
  name: "fixture",
  type: "netconf",
  host: "127.0.0.1",
  port: PORT,
  user: "ro-pass",
  password: PASSWORD,
  hostKeyFingerprint: FINGERPRINT,
} as unknown as DatabaseConnection;

/** Every value a raw read answered under a withheld node, kept in memory only, to prove none reaches the capture. */
const secrets = new Set<string>([PASSWORD, FINGERPRINT]);

/** The element paths of a raw answer and how many of each, with every leaf value under a withheld node remembered. */
function shape(data: XmlElement, policy: NetconfWithheldPolicy): Record<string, number> {
  const counts: Record<string, number> = {};
  const walk = (element: XmlElement, chain: string[], withheld: boolean): void => {
    for (const child of element.children) {
      const here = [...chain, child.name];
      const node = policy.chainMatch(here) !== undefined;
      const inside = withheld || node;
      const key = here.join("/");
      counts[key] = (counts[key] ?? 0) + 1;
      // Every value under a withheld node, and under a module withheld whole every value of a leaf that can hold key or
      // password material; a key's name and format are names the device also answers elsewhere, outside the module.
      const material =
        policy.moduleOf(child.namespace) !== undefined &&
        (child.name.endsWith("key") || ["private", "password", "secret"].some((word) => child.name.includes(word)));
      if ((inside || material) && child.text !== undefined && child.text.trim() !== "") secrets.add(child.text.trim());
      walk(child, here, inside);
    }
  };
  walk(data, [], false);
  return counts;
}

async function agentRead(statement: string): Promise<Record<string, unknown>> {
  const provider = new NetconfProvider(
    connection,
    {},
    AGENT,
    async (config) => openNetconfReader(config, ports),
    async (config) => createNetconfAgentClient(await openNetconfSession(config, ports), netconfXmlPort),
  );
  await provider.connect();
  const started = Date.now();
  try {
    const result = await provider.queryReadOnly(statement, BUDGET);
    return {
      statement: JSON.parse(statement),
      fields: result.fields,
      rows: result.rows.length,
      withheldCells: result.rows.reduce<number>(
        (sum, row) => sum + Object.values(row).filter((cell) => cell === "[withheld]").length,
        0,
      ),
      warnings: (result.warnings ?? []).map((warning) => warning.message),
      // The interface row as answered; any other read only by whether it holds the marker, so no key material, public
      // or not, is written into a committed file.
      firstRow: statement.includes("ietf-interfaces:interfaces") ? result.rows[0] : undefined,
      holdsWithheldMarker: JSON.stringify(result.rows).includes("[withheld]"),
      ms: Date.now() - started,
    };
  } catch (error) {
    return { statement: JSON.parse(statement), refused: (error as Error).name, message: (error as Error).message };
  } finally {
    await provider.disconnect();
  }
}

/** The raw edit-config, on an SSH channel of this script's own: base 1.0, end-of-message framing. */
async function rawEditConfig(): Promise<string> {
  const client = new Client();
  return new Promise<string>((resolve, reject) => {
    client.on("error", reject);
    client.on("ready", () => {
      client.subsys("netconf", (error, stream) => {
        if (error) return reject(error);
        let buffer = "";
        stream.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const replies = buffer.split("]]>]]>");
          if (replies.length >= 3) {
            client.end();
            const tag = /<(?:\w+:)?error-tag>([^<]*)</.exec(replies[1] ?? "")?.[1];
            resolve(tag === undefined ? (/<(?:\w+:)?ok\/>/.test(replies[1] ?? "") ? "ok" : "no error-tag") : tag);
          }
        });
        stream.write(
          '<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities></hello>]]>]]>',
        );
        stream.write(
          '<rpc message-id="1" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><edit-config><target><running/></target><config><interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"><interface><name>ge-0/0/0</name><description>changed by the capture</description></interface></interfaces></config></edit-config></rpc>]]>]]>',
        );
      });
    });
    client.connect({
      host: "127.0.0.1",
      port: PORT,
      username: "ro-pass",
      password: PASSWORD,
      hostVerifier: (key: Buffer) => fingerprintOf(key) === FINGERPRINT,
    });
  });
}

// The device's own modules, read once here for the raw shapes; the agent path reads them again on every read.
const raw = createNetconfAgentClient(await openNetconfSession(connection, ports), netconfXmlPort);
const library = await raw.library();
const texts: { name: string; text: string }[] = [];
for (const entry of library.modules.flatMap((module) => [module, ...module.submodules])) {
  texts.push({ name: entry.name, text: await raw.schema(entry.name, entry.revision) });
}
const policy = NetconfWithheldPolicy.compile(library.modules, texts);
const namespaces = new Map(
  library.modules.flatMap((module) =>
    module.namespace === undefined ? [] : [[module.name, module.namespace] as const],
  ),
);
const rawRead = async (datastore: "running" | "operational", module: string, name: string) =>
  shape(await raw.read(datastore, [{ module, name }], namespaces), policy);
const rawReads = {
  "running ietf-keystore:keystore": await rawRead("running", "ietf-keystore", "keystore"),
  "running ietf-netconf-acm:nacm": await rawRead("running", "ietf-netconf-acm", "nacm"),
  "operational ietf-netconf-server:netconf-server": await rawRead(
    "operational",
    "ietf-netconf-server",
    "netconf-server",
  ),
};
await raw.close();
const before = await agentRead('{"datastore": "running", "path": "ietf-interfaces:interfaces/interface=ge-0%2F0%2F0"}');
const editConfig = await rawEditConfig();
const after = await agentRead('{"datastore": "running", "path": "ietf-interfaces:interfaces/interface=ge-0%2F0%2F0"}');

const capture = {
  measured: DATE,
  device:
    "docker/netconf (Netopeer2 2.8.7, sysrepo 5.1.0), account ro-pass under the fixture's read-only NACM rule list",
  budget: BUDGET,
  library: {
    modules: library.modules.length,
    texts: texts.length,
    bytes: texts.reduce((sum, entry) => sum + entry.text.length, 0),
    nmda: library.nmda,
  },
  withheldKinds: Object.keys(NETCONF_WITHHELD_REASONS),
  raw: rawReads,
  rawEditConfig: {
    sentBy: "this script, on its own SSH channel, never by Studio",
    errorTag: editConfig,
    unchanged: JSON.stringify(before.firstRow) === JSON.stringify(after.firstRow) && before.firstRow !== undefined,
  },
  agent: [
    await agentRead('{"datastore": "running", "path": "ietf-interfaces:interfaces"}'),
    await agentRead(
      '{"datastore": "operational", "path": "ietf-netconf-server:netconf-server/listen/endpoints/endpoint/ssh/ssh-server-parameters/client-authentication/users"}',
    ),
    // The SSH host key's central-keystore-reference is RFC 9642's asymmetric-key-ref, a leafref into the keystore.
    await agentRead(
      '{"datastore": "operational", "path": "ietf-netconf-server:netconf-server/listen/endpoints/endpoint/ssh/ssh-server-parameters/server-identity"}',
    ),
    await agentRead('{"schema": "ietf-interfaces"}'),
    await agentRead('{"datastore": "running", "path": "ietf-keystore:keystore"}'),
    await agentRead(
      '{"datastore": "running", "path": "ietf-netconf-server:netconf-server/listen/endpoints/endpoint/ssh/ssh-server-parameters/client-authentication/users/user=ro-pass/password/hashed-password"}',
    ),
    await agentRead('{"datastore": "running", "path": "ietf-interfaces:interfaces", "operation": "edit-config"}'),
  ],
};

const text = `${JSON.stringify(capture, null, 2)}\n`;
for (const secret of secrets) {
  if (secret.length >= 4 && text.includes(secret)) {
    const at = text.indexOf(secret);
    const line = text.slice(0, at).split("\n").length;
    throw new Error(
      `the capture holds a credential or a withheld value (${secret.length} characters, line ${line}); nothing was written`,
    );
  }
}
writeFileSync(posix.join(OUT.replaceAll("\\", "/"), "boundary.json"), text);
console.log(
  `wrote boundary.json: ${capture.agent.length} agent reads, ${Object.keys(rawReads).length} raw reads, edit-config ${editConfig}`,
);
