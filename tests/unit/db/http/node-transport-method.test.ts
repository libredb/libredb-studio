/**
 * createNodeTransport's method check.
 *
 * NodeRequest types the method as "GET" | "POST", and the byte transport already checks its own pair at runtime. A
 * method that reaches the text transport past the type, through a cast or a value read from elsewhere, is refused
 * before any socket, so a read-only caller cannot send DELETE by mistake. The listeners count the connections they
 * accept, so "no socket" is measured on the server side.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import { createNodeTransport, type NodeRequest, type NodeTransport } from "@/lib/db/http/node-transport";
import { closeAll, httpListener, jsonAnswer, type Listener } from "../../../helpers/node-transport-fixtures";

const MIB = 1024 * 1024;
const INVALID_METHOD = "Invalid method: this transport sends GET and POST only";

const transports: NodeTransport[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.close();
  await closeAll();
});

function connect(listener: Listener) {
  const origin = httpOrigin("http", "127.0.0.1", listener.port);
  const transport = createNodeTransport({ origin, tls: null, maxSockets: 4, headers: {} });
  transports.push(transport);
  return { transport, url: (path: string) => endpointUrl(origin, path) };
}

function get(url: string, extra: Partial<NodeRequest> = {}): NodeRequest {
  return { method: "GET", url, signal: AbortSignal.timeout(5000), maxResponseBytes: MIB, ...extra };
}

async function failure(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to reject");
}

describe("a method other than GET or POST is refused before any socket", () => {
  test.each([
    ["DELETE", "DELETE"],
    ["PUT", "PUT"],
    ["PATCH", "PATCH"],
    ["HEAD", "HEAD"],
    ["OPTIONS", "OPTIONS"],
    ["a lower-case get, which node:http would send upper-cased", "get"],
    ["an empty method", ""],
    ["no method, which node:http would send as GET", undefined],
  ])("%s", async (_label, method) => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    const error = await failure(() =>
      transport.request(get(url("/items"), { method: method as unknown as NodeRequest["method"] })),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(INVALID_METHOD);
    expect(listener.accepted()).toBe(0);
    expect(listener.seen).toEqual([]);
  });

  test("the method is checked before the cap and the URL: a DELETE with a zero cap and a foreign URL names the method", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport } = connect(listener);
    const error = await failure(() =>
      transport.request(
        get(`http://127.0.0.1:${listener.port + 1}/items`, {
          method: "DELETE" as unknown as NodeRequest["method"],
          maxResponseBytes: 0,
        }),
      ),
    );
    expect(error.message).toBe(INVALID_METHOD);
    expect(listener.accepted()).toBe(0);
  });

  test("GET and POST are still sent as given", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    await transport.request(get(url("/read")));
    await transport.request(get(url("/write"), { method: "POST", body: "{}" }));
    expect(listener.seen.map(({ method, url: path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/read" },
      { method: "POST", path: "/write" },
    ]);
  });

  test("the method is read once, so a method that answers GET and then DELETE is sent as GET", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    let reads = 0;
    const request = { ...get(url("/items")) };
    Object.defineProperty(request, "method", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? "GET" : "DELETE";
      },
    });
    await transport.request(request);
    expect(listener.seen.map(({ method }) => method)).toEqual(["GET"]);
    expect(reads).toBe(1);
  });
});
