/**
 * The egress guard on the shared REST transport, unmocked (vector-family spec 3.7, R44 QM1).
 *
 * The transport decides by the egress decision it is handed in its options' `egress` and reads no setting, so each
 * case hands one and the variable it would otherwise read is set against it. With a blocking decision, an IP literal
 * is refused when the transport is built, before any socket, because a literal never reaches a lookup; a name is
 * refused by the guard's lookup, which runs on the connection's own Agent. Built without a decision, the transport
 * refuses by name. The listeners count what reaches them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { BLOCKED_HOST as BLOCKED, EGRESS_DECISION_MISSING } from "@/lib/db/http/egress-policy";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import { createNodeTransport, type NodeTransport, type NodeTransportOptions } from "@/lib/db/http/node-transport";
import { closeAll, httpListener, jsonAnswer } from "../../../helpers/node-transport-fixtures";
import { setEgressFlag } from "../../../helpers/egress-flag";
import { ALLOWS_PRIVATE_HOSTS, BLOCKS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";

const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[FLAG];
const transports: NodeTransport[] = [];

afterEach(async () => {
  setEgressFlag(original);
  for (const transport of transports.splice(0)) transport.close();
  await closeAll();
});

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

describe("built without an egress decision", () => {
  test("a text transport built without an egress decision refuses by name, before any Agent is built", () => {
    setEgressFlag(undefined);
    const origin = httpOrigin("http", "db.example.com", 6333, ALLOWS_PRIVATE_HOSTS);
    // A JavaScript caller, or a cast: the type asks for the decision.
    const options = { origin, tls: null, maxSockets: 4, headers: {} } as unknown as NodeTransportOptions;
    const error = refusal(() => createNodeTransport(options));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(EGRESS_DECISION_MISSING);
  });
});

describe("handed a blocking decision", () => {
  test("127.0.0.1 is refused when a transport handed a blocking decision is built, before any socket, while DB_HTTP_BLOCK_PRIVATE_HOSTS is unset", async () => {
    setEgressFlag(undefined);
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const origin = httpOrigin("http", "127.0.0.1", listener.port, ALLOWS_PRIVATE_HOSTS);
    const error = refusal(() =>
      createNodeTransport({ origin, tls: null, maxSockets: 4, egress: BLOCKS_PRIVATE_HOSTS, headers: {} }),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(BLOCKED);
    expect(listener.accepted()).toBe(0);
  });

  test.each(["[::1]", "10.0.0.5", "169.254.169.254"])("%s is refused the same way", (host) => {
    setEgressFlag(undefined);
    const origin = httpOrigin("http", host, 6333, ALLOWS_PRIVATE_HOSTS);
    const error = refusal(() =>
      createNodeTransport({ origin, tls: null, maxSockets: 4, egress: BLOCKS_PRIVATE_HOSTS, headers: {} }),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(BLOCKED);
  });

  test("a name that resolves to loopback is refused by the guard's lookup on the Agent of a transport handed a blocking decision, with the guard's own error", async () => {
    setEgressFlag(undefined);
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const origin = httpOrigin("http", "localhost", listener.port, ALLOWS_PRIVATE_HOSTS);
    const transport = createNodeTransport({
      origin,
      tls: null,
      maxSockets: 4,
      egress: BLOCKS_PRIVATE_HOSTS,
      headers: { "api-key": crypto.randomUUID() },
    });
    transports.push(transport);
    let error: Error | undefined;
    try {
      await transport.request({
        method: "GET",
        url: endpointUrl(origin, "/"),
        signal: AbortSignal.timeout(5000),
        maxResponseBytes: 1024,
      });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error?.message).toBe(BLOCKED);
    expect(listener.accepted()).toBe(0);
  });
});

describe("handed an allowing decision", () => {
  test("127.0.0.1 reaches the listener for a transport handed an allowing decision while DB_HTTP_BLOCK_PRIVATE_HOSTS is true", async () => {
    setEgressFlag("true");
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const origin = httpOrigin("http", "127.0.0.1", listener.port, ALLOWS_PRIVATE_HOSTS);
    const transport = createNodeTransport({
      origin,
      tls: null,
      maxSockets: 4,
      egress: ALLOWS_PRIVATE_HOSTS,
      headers: {},
    });
    transports.push(transport);
    const answer = await transport.request({
      method: "GET",
      url: endpointUrl(origin, "/"),
      signal: AbortSignal.timeout(5000),
      maxResponseBytes: 1024,
    });
    expect(answer.status).toBe(200);
    expect(listener.accepted()).toBe(1);
  });
});
