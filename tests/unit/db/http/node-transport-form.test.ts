/**
 * NodeRequest.form over plaintext, against a local listener (InfluxDB SPEC 3.3 and E8, R14).
 *
 * The transport serialises the fields with URLSearchParams and sends them under the form content type with their UTF-8
 * byte length, as it sends a JSON body today. A request with both `body` and `form` is refused before any socket, so
 * neither is ever dropped silently; the listener counts the connections it accepts, so "no socket" is measured.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import { createNodeTransport, type NodeRequest, type NodeTransport } from "@/lib/db/http/node-transport";
import { closeAll, httpListener, jsonAnswer, type Listener } from "../../../helpers/node-transport-fixtures";

const SECRET = "node-transport-form-secret";
const MIB = 1024 * 1024;

const transports: NodeTransport[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.close();
  await closeAll();
});

function connect(listener: Listener) {
  const origin = httpOrigin("http", "127.0.0.1", listener.port);
  const transport = createNodeTransport({ origin, tls: null, maxSockets: 4, headers: { authorization: SECRET } });
  transports.push(transport);
  return { transport, url: (path: string, params?: URLSearchParams) => endpointUrl(origin, path, params) };
}

function post(url: string, extra: Partial<NodeRequest> = {}): NodeRequest {
  return { method: "POST", url, signal: AbortSignal.timeout(5000), maxResponseBytes: MIB, ...extra };
}

describe("a form body", () => {
  test("is serialised with URLSearchParams under the form content type and its byte length", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    const form = { db: "home", q: 'SELECT "temp" FROM "we""ird name;x" WHERE a = \'b & c\'' };
    const answer = await transport.request(post(url("/query"), { form }));
    expect(answer.status).toBe(200);
    const [seen] = listener.seen;
    const expected = new URLSearchParams(form).toString();
    expect(seen.body).toBe(expected);
    expect(seen.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(seen.headers["content-length"]).toBe(String(new TextEncoder().encode(expected).length));
    expect(Object.fromEntries(new URLSearchParams(seen.body))).toEqual(form);
  });

  test("a non-ASCII value arrives percent-encoded as UTF-8, and the length counts its bytes", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    await transport.request(post(url("/query"), { form: { q: "ü€" } }));
    const [seen] = listener.seen;
    expect(seen.body).toBe("q=%C3%BC%E2%82%AC");
    expect(seen.headers["content-length"]).toBe("17");
  });

  test("never adds a URL query string the request did not carry, and keeps one it did", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    await transport.request(post(url("/query"), { form: { db: "home", q: "SHOW DATABASES" } }));
    await transport.request(post(url("/query", new URLSearchParams({ chunked: "true" })), { form: { q: "x" } }));
    expect(listener.seen.map(({ url: path }) => path)).toEqual(["/query", "/query?chunked=true"]);
  });

  test("a form of no fields sends an empty body with length 0", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    await transport.request(post(url("/query"), { form: {} }));
    const [seen] = listener.seen;
    expect(seen.body).toBe("");
    expect(seen.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(seen.headers["content-length"]).toBe("0");
  });

  test("a JSON body keeps its own content type, and a GET with neither sends no content type", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    await transport.request(post(url("/points"), { body: '{"a":1}' }));
    await transport.request(post(url("/health"), { method: "GET" }));
    expect(listener.seen.map(({ headers }) => headers["content-type"])).toEqual(["application/json", undefined]);
    expect(listener.seen[1].body).toBe("");
  });

  test("a request with both body and form is refused before any socket, naming neither value", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    let error: unknown;
    try {
      await transport.request(post(url("/query"), { body: '{"q":"secret-body"}', form: { q: "secret-form" } }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect((error as Error).message).toBe("Invalid request: give a body or form fields, not both");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(listener.accepted()).toBe(0);
    expect(listener.seen).toHaveLength(0);
  });
});
