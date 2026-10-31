/**
 * Path segment names follow the YANG identifier grammar, RFC 7950 section 6.2.
 *
 * A node name in a path becomes an element name in the subtree filter, and a module name is a YANG
 * identifier too, so both are held to `[A-Za-z_][A-Za-z0-9_.-]*` before any request is built. Key
 * values are data, not names, and keep any text: they are percent-decoded and then written as an
 * element body, escaped.
 *
 * Two facts shape the cases below. A read names a module on its first node, because the reader
 * selects the module by it, so every editor path here starts with `ietf-interfaces:`. And `/` is
 * the segment separator in all three grammars, so a name can never hold one: the segment the
 * refusal names is the piece between two separators.
 */
import { test } from "bun:test";
import { expectBe, expectEqual, expectMatch, expectRejects, expectThrows, expectTruthy } from "./helpers";
import { QueryError } from "@/lib/db/errors";
import { EOM } from "@/lib/db/providers/network/netconf/framing";
import { NetconfProvider, parseReadRequest, type DeviceReader } from "@/lib/db/providers/network/netconf/index";
import { parseKeyPath } from "@/lib/db/providers/network/netconf/keypath";
import { buildRpc, rememberNamespace } from "@/lib/db/providers/network/netconf/requests";
import { NetconfSession, type Transport } from "@/lib/db/providers/network/netconf/session";
import type { DatabaseConnection } from "@/lib/db/types";

/** Names outside the grammar, each with the reason it is outside. */
const OUTSIDE = [
  ["a less-than sign", "inter<face"],
  ["a greater-than sign", "inter>face"],
  ["an ampersand", "inter&face"],
  ["a double quote", 'inter"face'],
  ["a space", "inter face"],
  ["the end-of-message separator", `inter${EOM}face`],
  ["a leading digit", "1interface"],
  ["a leading hyphen", "-interface"],
  ["a non-ASCII letter", "interfacé"],
] as const;

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expectTruthy(error instanceof QueryError, `refused with ${String(error)}, not a QueryError`);
    return error.message;
  }
  throw new Error("the call was not refused");
}

test("the editor query refuses a node name outside the identifier grammar, and names the segment", () => {
  for (const [what, name] of OUTSIDE) {
    const message = refusal(() =>
      parseReadRequest(JSON.stringify({ datastore: "running", path: `ietf-interfaces:interfaces/${name}` })),
    );
    expectBe(message.includes(JSON.stringify(name)), true, `${what}: the refusal does not name the segment`);
    expectMatch(message, /YANG identifier/);
  }
});

test("the editor query refuses a module name outside the grammar, an empty one included", () => {
  expectMatch(
    refusal(() => parseReadRequest('{"datastore":"running","path":"ietf<x:interfaces"}')),
    /"ietf<x:interfaces"/,
  );
  expectMatch(
    refusal(() => parseReadRequest('{"datastore":"running","path":":interfaces"}')),
    /":interfaces"/,
  );
});

test("the editor query accepts the names the grammar allows, and key values keep any text", () => {
  const request = parseReadRequest(
    JSON.stringify({
      datastore: "running",
      path: "ietf-interfaces:interfaces/_list.v2-x=a%3Cb%3E%5D%5D%3E%5D%5D%3E%26,ge-0%2F0%2F0",
    }),
  );
  expectEqual(request.path, [
    { module: "ietf-interfaces", name: "interfaces" },
    { name: "_list.v2-x", keys: [`a<b>${EOM}&`, "ge-0/0/0"] },
  ]);
});

test("a slash always separates segments, so the refusal names the piece before it", () => {
  // `a</b` cannot be one name: the slash ends the segment, and the piece left over is refused.
  const message = refusal(() => parseReadRequest('{"datastore":"running","path":"ietf-interfaces:interfaces/a</b"}'));
  expectMatch(message, /"a<"/);
});

test("the key path grammar refuses the same names, and accepts the same names", () => {
  for (const [what, name] of OUTSIDE) {
    const message = refusal(() => parseKeyPath(`ietf-interfaces:interfaces/${name}=x`));
    expectBe(message.includes(JSON.stringify(`${name}=x`)), true, `${what}: the refusal does not name the segment`);
  }
  expectMatch(
    refusal(() => parseKeyPath(":interfaces")),
    /":interfaces"/,
  );
  expectMatch(
    refusal(() => parseKeyPath("ietf-interfaces:interfaces//interface")),
    /""/,
  );
  expectEqual(parseKeyPath("ietf-interfaces:interfaces/interface=ge-0%2F0%2F0"), [
    { module: "ietf-interfaces", name: "interfaces" },
    { name: "interface", keys: ["ge-0/0/0"] },
  ]);
});

test("the request builder refuses a node name or a key name outside the grammar, whatever built the node", () => {
  rememberNamespace("ietf-interfaces", "urn:ietf:params:xml:ns:yang:ietf-interfaces");
  for (const [what, name] of OUTSIDE) {
    const message = refusal(() => buildRpc({ operation: "get", filter: { nodes: [{ name }] } }, 1));
    expectBe(message.includes(JSON.stringify(name)), true, `${what}: the refusal does not name the node`);
  }
  expectMatch(
    refusal(() =>
      buildRpc({ operation: "get", filter: { nodes: [{ name: "interface", keys: ["x"], keyNames: ["na me"] }] } }, 1),
    ),
    /"na me"/,
  );
  // Key values are escaped, as they were: they are data, not names.
  const rpc = buildRpc(
    {
      operation: "get-config",
      source: "running",
      filter: { nodes: [{ module: "ietf-interfaces", name: "interface", keys: [`a<b>${EOM}`] }] },
    },
    1,
  );
  expectBe(rpc.includes(EOM), false);
  expectMatch(rpc, /<name>a&lt;b&gt;\]\]&gt;\]\]&gt;<\/name>/);
});

const BASE10 = "urn:ietf:params:netconf:base:1.0";

class FakeTransport implements Transport {
  written: string[] = [];
  private data: ((chunk: string) => void) | null = null;
  write(text: string): void {
    this.written.push(text);
  }
  onData(handler: (chunk: string) => void): void {
    this.data = handler;
  }
  onClose(): void {}
  close(): void {}
  send(chunk: string): void {
    this.data?.(chunk);
  }
}

test("on an end-of-message session a refused name writes nothing after the hello", async () => {
  const transport = new FakeTransport();
  const opening = NetconfSession.open(transport, {
    maxMessageBytes: 1024 * 1024,
    maxBufferBytes: 4 * 1024 * 1024,
    helloMs: 500,
    requestMs: 500,
  });
  transport.send(
    `<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities><capability>${BASE10}</capability></capabilities><session-id>7</session-id></hello>${EOM}`,
  );
  const { session } = await opening;
  expectBe(transport.written.length, 1);
  expectThrows(
    () =>
      session.request({
        operation: "get-config",
        source: "running",
        filter: { nodes: [{ module: "ietf-interfaces", name: `x${EOM}y` }] },
      }),
    QueryError,
  );
  expectBe(transport.written.length, 1, "a request reached the transport");
});

const facts = {
  datastores: ["running", "operational"],
  modules: ["ietf-interfaces"],
  nmda: true,
  capabilities: [],
  sessionId: "7",
};

const connection = { type: "netconf", name: "n", host: "h" } as unknown as DatabaseConnection;

/** A device whose every read fails the test, so a refusal is proven to come before any request. */
function untouchedDevice(): DeviceReader {
  const reached = async (): Promise<never> => {
    throw new Error("a read reached the device");
  };
  return {
    facts,
    topLevelNodes: reached,
    children: reached,
    rows: reached,
    moduleText: reached,
    sourceXml: reached,
    close: async () => {},
  };
}

async function openProvider(): Promise<NetconfProvider> {
  const provider = new NetconfProvider(connection, {}, {}, async () => untouchedDevice());
  await provider.connect();
  return provider;
}

test("the editor, the Keys panel and the Source tab each refuse the name before any read", async () => {
  const provider = await openProvider();
  await expectRejects(
    provider.query('{"datastore":"running","path":"ietf-interfaces:interfaces/inter face"}'),
    /"inter face"/,
  );
  await expectRejects(
    provider.scanKeysPage({ cursor: "0", pattern: "running/ietf-interfaces:inter face/", count: 10, level: true }),
    /"ietf-interfaces:inter face"/,
  );
  await expectRejects(
    provider.readObjectSource(["running/ietf-interfaces:interfaces/inter&face"], "key"),
    /"inter&face"/,
  );
});
