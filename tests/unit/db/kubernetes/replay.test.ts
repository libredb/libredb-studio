import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeRequest, NodeResponse, NodeTransport } from "@/lib/db/http/node-transport";
import type { KubernetesExchange } from "../../../helpers/kubernetes-evidence-scrub";
import {
  readCapture,
  recordingTransport,
  NOT_ACCEPTABLE_ANSWER,
  replayAnswer,
  replayTransport,
  requestKey,
  UNRECORDED_ANSWER,
} from "../../../helpers/kubernetes-replay";

/** The replay of captures, which the integration test and the end-to-end stub server both answer through. */

const answer = (text: string, status = 200): NodeResponse => ({
  status,
  contentType: "application/json",
  retryAfter: null,
  text,
});

const recorded = (method: "GET" | "POST", path: string, text: string): KubernetesExchange => ({
  request: { method, path },
  response: answer(text),
});

function request(url: string, method: "GET" | "POST" = "GET", extra: Partial<NodeRequest> = {}): NodeRequest {
  return { method, url, signal: new AbortController().signal, maxResponseBytes: 1024, ...extra };
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("requestKey", () => {
  test("sorts the query pairs by name, then by value, and keeps a path without a query as it is", () => {
    expect(requestKey("GET", "/api/v1/pods?limit=500&continue=a%26b%3Dc&labelSelector=app%3Dweb")).toBe(
      "GET /api/v1/pods?continue=a%26b%3Dc&labelSelector=app%3Dweb&limit=500",
    );
    expect(requestKey("GET", "/api/v1/pods?x=2&x=1")).toBe("GET /api/v1/pods?x=1&x=2");
    expect(requestKey("POST", "/apis")).toBe("POST /apis");
  });

  test("a POST's body is part of its key, a GET's never is", () => {
    expect(requestKey("POST", "/apis/x?b=1&a=2", '{"spec":{}}')).toBe('POST /apis/x?a=2&b=1 {"spec":{}}');
    expect(requestKey("GET", "/apis/x", "ignored")).toBe("GET /apis/x");
  });
});

describe("replayAnswer", () => {
  test("answers by key, in recorded order, repeating the last answer once they run out", () => {
    const replay = replayAnswer([
      recorded("GET", "/api?b=2&a=1", "first"),
      recorded("GET", "/api?a=1&b=2", "second"),
      recorded("POST", "/api?a=1&b=2", "posted"),
      { request: { method: "POST", path: "/reviews", body: '{"verb":"get"}' }, response: answer("get") },
      { request: { method: "POST", path: "/reviews", body: '{"verb":"list"}' }, response: answer("list") },
    ]);
    expect(replay("GET", "/api?a=1&b=2").text).toBe("first");
    expect(replay("GET", "/api?b=2&a=1").text).toBe("second");
    expect(replay("GET", "/api?a=1&b=2").text).toBe("second");
    expect(replay("POST", "/api?a=1&b=2").text).toBe("posted");
    expect(replay("POST", "/reviews", '{"verb":"list"}').text).toBe("list");
    expect(replay("POST", "/reviews", '{"verb":"get"}').text).toBe("get");
  });

  test("a request whose Accept differs from the recorded one answers a 406, not the recorded answer", () => {
    const replay = replayAnswer([
      {
        request: {
          method: "GET",
          path: "/api/v1/namespaces/shop/pods/web/log?container=web",
          accept: "application/json",
        },
        response: { ...answer("line\n"), contentType: "text/plain" },
      },
      recorded("GET", "/version", "{}"),
    ]);
    const refused = replay("GET", "/api/v1/namespaces/shop/pods/web/log?container=web", undefined, "text/plain");
    expect(refused).toBe(NOT_ACCEPTABLE_ANSWER);
    expect(refused.status).toBe(406);
    expect(JSON.parse(refused.text)).toMatchObject({ kind: "Status", reason: "NotAcceptable", code: 406 });
    expect(replay("GET", "/api/v1/namespaces/shop/pods/web/log?container=web", undefined, undefined)).toBe(
      NOT_ACCEPTABLE_ANSWER,
    );
    expect(
      replay("GET", "/api/v1/namespaces/shop/pods/web/log?container=web", undefined, "application/json").text,
    ).toBe("line\n");
    expect(replay("GET", "/version", undefined, "text/plain").text).toBe("{}");
  });

  test("a request nobody recorded answers a text/plain 404", () => {
    expect(replayAnswer([])("GET", "/apis/unknown")).toBe(UNRECORDED_ANSWER);
    expect(UNRECORDED_ANSWER.status).toBe(404);
    expect(UNRECORDED_ANSWER.contentType).toStartWith("text/plain");
  });
});

describe("replayTransport", () => {
  test("answers the provider's requests from the exchanges and records the keys it was asked for", async () => {
    const replay = replayTransport([recorded("GET", "/api/v1/namespaces?limit=500", "{}")]);
    const transport = replay.factory({ origin: { protocol: "https", host: "127.0.0.1", port: 6443 } } as never);
    expect((await transport.request(request("https://127.0.0.1:6443/api/v1/namespaces?limit=500"))).text).toBe("{}");
    expect((await transport.request(request("https://127.0.0.1:6443/apis"))).status).toBe(404);
    transport.close();
    expect(replay.asked).toEqual(["GET /api/v1/namespaces?limit=500", "GET /apis"]);
    expect(replay.missed).toEqual(["GET /apis"]);
  });

  test("a request whose Accept differs from the recording is missed, with the Accept it sent", async () => {
    const replay = replayTransport([
      { request: { method: "GET", path: "/api/v1/pods", accept: "application/json" }, response: answer("{}") },
    ]);
    const transport = replay.factory({} as never);
    const sent = await transport.request(
      request("https://127.0.0.1:6443/api/v1/pods", "GET", { headers: { accept: "text/plain" } }),
    );
    expect(sent.status).toBe(406);
    expect(
      (
        await transport.request(
          request("https://127.0.0.1:6443/api/v1/pods", "GET", { headers: { accept: "application/json" } }),
        )
      ).text,
    ).toBe("{}");
    expect(replay.missed).toEqual(["GET /api/v1/pods accept: text/plain"]);
  });
});

describe("recordingTransport", () => {
  test("keeps each exchange as a fixture holds it, path and query without the origin, Accept and body only", async () => {
    const sink: KubernetesExchange[] = [];
    let closed = 0;
    const inner = (): NodeTransport => ({
      async request() {
        return answer('{"ok":true}', 201);
      },
      close() {
        closed += 1;
      },
    });
    const transport = recordingTransport(inner, sink)({} as never);
    await transport.request(
      request("https://127.0.0.1:6443/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", "POST", {
        body: '{"spec":{}}',
        headers: { accept: "application/json" },
      }),
    );
    await transport.request(request("https://127.0.0.1:6443/version?x=1"));
    transport.close();
    expect(closed).toBe(1);
    expect(sink).toEqual([
      {
        request: {
          method: "POST",
          path: "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
          accept: "application/json",
          body: '{"spec":{}}',
        },
        response: answer('{"ok":true}', 201),
      },
      { request: { method: "GET", path: "/version?x=1" }, response: answer('{"ok":true}', 201) },
    ]);
  });
});

describe("readCapture", () => {
  test("reads a capture file as the capture script writes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "k8s-capture-"));
    dirs.push(dir);
    const file = join(dir, "reader.json");
    const capture = { persona: "reader", exchanges: [recorded("GET", "/version", "{}")] };
    writeFileSync(file, `${JSON.stringify(capture, null, 2)}\n`);
    expect(readCapture(file)).toEqual(capture);
  });
});
