/**
 * A byte transport refused when it is built leaves no Agent behind: every check runs before the connection's Agent is
 * constructed, the response-header selection and the signer included.
 *
 * node:http is mocked with an Agent that counts its constructions, so a refusal that came after the Agent was built is
 * seen even though such an Agent opens no socket. The runner starts a process per file, so the mock reaches no other
 * test file.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

const realHttp = { ...(await import("node:http")) };
let constructed = 0;

class CountingAgent extends realHttp.Agent {
  constructor(...args: ConstructorParameters<typeof realHttp.Agent>) {
    super(...args);
    constructed += 1;
  }
}

mock.module("node:http", () => ({ ...realHttp, Agent: CountingAgent }));

const { DatabaseConfigError } = await import("@/lib/db/errors");
const { httpOrigin } = await import("@/lib/db/http/endpoint");
const { createNodeByteTransport } = await import("@/lib/db/http/node-transport");
type ByteOptions = Parameters<typeof createNodeByteTransport>[0];

const transports: Array<{ close(): void }> = [];
afterEach(() => {
  for (const transport of transports.splice(0)) transport.close();
  constructed = 0;
});

function build(extra: Partial<ByteOptions>): Error | undefined {
  try {
    transports.push(
      createNodeByteTransport({
        origin: httpOrigin("http", "127.0.0.1", 9000),
        tls: null,
        maxSockets: 1,
        headers: { "x-api": "k" },
        ...extra,
      }),
    );
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

describe("a byte transport refused when it is built constructs no Agent", () => {
  test.each([
    ["a signer with no names", { signer: { headerNames: [], sign: () => ({}) } }],
    ["a signer naming a connection header", { signer: { headerNames: ["x-api"], sign: () => ({}) } }],
    ["a selection naming location", { responseHeaders: { names: ["location"] } }],
  ] as const)("%s", (_label, extra) => {
    const error = build(extra as Partial<ByteOptions>);
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(constructed).toBe(0);
  });

  test("a transport that passes every check constructs exactly one, the control for the refusals above", () => {
    expect(build({ signer: { headerNames: ["authorization"], sign: () => ({}) } })).toBeUndefined();
    expect(constructed).toBe(1);
  });
});
