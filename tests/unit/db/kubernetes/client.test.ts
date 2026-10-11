import { describe, expect, spyOn, test } from "bun:test";
import { AuthenticationError, QueryError, TimeoutError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  ACCEPT_DISCOVERY,
  ACCEPT_JSON,
  ACCEPT_TABLE,
  createKubernetesClient,
  DEFAULT_KUBERNETES_SEAMS,
  retryAfterMs,
} from "@/lib/db/providers/platform/kubernetes/client";
import { readClusterEndpoint } from "@/lib/db/providers/platform/kubernetes/connection-options";
import { ANONYMOUS_UNAUTHORIZED_SENTENCE, UNAUTHORIZED_SENTENCE } from "@/lib/db/providers/platform/kubernetes/errors";
import type { ResourceRef } from "@/lib/db/providers/platform/kubernetes/request-policy";
import { expectCalls } from "../../../helpers/call-log";
import { kubernetesConnection, TEST_TOKEN } from "../../../helpers/kubernetes-connection";
import {
  jsonAnswer,
  recordingKubernetesTransport,
  statusAnswer,
  testSeams,
} from "../../../helpers/kubernetes-transport";

const PODS: ResourceRef = {
  group: "",
  version: "v1",
  resource: "pods",
  namespaced: true,
  verbs: ["get", "list", "watch"],
};
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

function call(overrides: Partial<{ accept: string; maxResponseBytes: number; timeoutMs: number }> = {}) {
  return { signal: new AbortController().signal, timeoutMs: 5_000, ...overrides };
}

function clientWith(
  answer: Parameters<typeof recordingKubernetesTransport>[0],
  connection = kubernetesConnection(),
  random = 0,
) {
  const transport = recordingKubernetesTransport(answer);
  const seams = testSeams(transport, { now: NOW, random });
  const endpoint = readClusterEndpoint(connection, { queryTimeout: 30_000, appVersion: "0.18.2" });
  return { client: createKubernetesClient(endpoint, seams), transport, seams };
}

describe("the transport the client builds", () => {
  test("one transport per client, refusing link-local addresses and upgrades, with accept the one request header", () => {
    const { client, transport } = clientWith(() => jsonAnswer({}));
    expect(transport.built).toHaveLength(1);
    const [options] = transport.built;
    expect(options.refusesLinkLocal).toBe(true);
    expect(options.refusesUpgrade).toBe(true);
    expect(options.requestHeaderNames).toEqual(["accept"]);
    expect(options.headers).toEqual({
      authorization: `Bearer ${TEST_TOKEN}`,
      "user-agent": "libredb-studio/0.18.2 (kubernetes)",
    });
    expect(options.maxSockets).toBe(4);
    client.close();
    expect(transport.closed()).toBe(1);
  });
});

describe("send", () => {
  test("joins the API path, sends the Accept it is given and the byte cap, and resolves a 2xx answer", async () => {
    const { client, transport } = clientWith(
      () => jsonAnswer({ kind: "Table" }),
      kubernetesConnection({ apiPath: "/k8s/clusters/c-1" }),
    );
    const answer = await client.send(
      { op: "list", target: PODS, namespace: "shop", query: { limit: 500, includeObject: "None" } },
      call({ accept: ACCEPT_TABLE, maxResponseBytes: 1024 }),
    );
    expect(answer.status).toBe(200);
    expectCalls(transport, ["GET /k8s/clusters/c-1/api/v1/namespaces/shop/pods?limit=500&includeObject=None"]);
    const [request] = transport.requests;
    expect(request.headers).toEqual({ accept: ACCEPT_TABLE });
    expect(request.maxResponseBytes).toBe(1024);
    expect(new URL(request.url).origin).toBe("https://api.example:6443");
  });

  test("the byte cap is never above 16 MiB, and JSON is the default Accept", async () => {
    const { client, transport } = clientWith(() => jsonAnswer({}));
    await client.send({ op: "version" }, call({ maxResponseBytes: 64 * 1024 * 1024 }));
    expect(transport.requests[0].maxResponseBytes).toBe(16 * 1024 * 1024);
    expect(transport.requests[0].headers).toEqual({ accept: ACCEPT_JSON });
  });

  test("a continue token holding & and = travels as one query value and adds no key", async () => {
    const { client, transport } = clientWith(() => jsonAnswer({}));
    await client.send({ op: "list", target: PODS, namespace: "shop", query: { continue: "a&watch=1&b=c" } }, call());
    const url = new URL(transport.requests[0].url);
    expect([...url.searchParams.keys()]).toEqual(["continue"]);
    expect(url.searchParams.get("continue")).toBe("a&watch=1&b=c");
  });

  test("a POST review carries its JSON body", async () => {
    const { client, transport } = clientWith(() => jsonAnswer({ status: { allowed: true } }, 201));
    await client.send({ op: "review", review: "selfsubjectreviews", body: { kind: "SelfSubjectReview" } }, call());
    expectCalls(transport, [
      { method: "POST /apis/authentication.k8s.io/v1/selfsubjectreviews", args: ['{"kind":"SelfSubjectReview"}'] },
    ]);
  });

  test("a refused request sends nothing", async () => {
    const { client, transport } = clientWith(() => jsonAnswer({}));
    await expect(
      client.send({ op: "get", target: PODS, namespace: "shop", name: "a/b" }, call()),
    ).rejects.toBeInstanceOf(QueryError);
    expect(transport.calls).toEqual([]);
  });

  test("the client's own gate refuses a final path and a query value before the transport", async () => {
    const transport = recordingKubernetesTransport(() => jsonAnswer({}));
    const endpoint = readClusterEndpoint(kubernetesConnection(), { queryTimeout: 30_000, appVersion: "0.18.2" });
    const escaping = createKubernetesClient({ ...endpoint, apiPath: "/k8s/.." }, testSeams(transport));
    await expect(escaping.send({ op: "version" }, call())).rejects.toThrow(
      "The request path holds a character or a segment Studio never sends. Nothing was sent.",
    );
    const client = createKubernetesClient(endpoint, testSeams(transport));
    await expect(
      client.send({ op: "logs", namespace: "shop", pod: "web", query: { container: "App" } }, call()),
    ).rejects.toThrow("The value of the query key container is outside what Studio sends. Nothing was sent.");
    expect(transport.calls).toEqual([]);
  });

  test("a 401 sends exactly one request and answers the expiry sentence", async () => {
    const { client, transport } = clientWith(() => statusAnswer(401, "Unauthorized"));
    const failure = client.send({ op: "discovery", root: "api" }, call());
    await expect(failure).rejects.toBeInstanceOf(AuthenticationError);
    await expect(failure).rejects.toThrow(UNAUTHORIZED_SENTENCE);
    expect(transport.calls).toHaveLength(1);
  });

  test("a connection that sends no credential is told its 401 and 403 went out anonymous", async () => {
    const anonymous = kubernetesConnection({ password: "" });
    const unauthorized = clientWith(() => statusAnswer(401, "Unauthorized"), anonymous);
    await expect(unauthorized.client.send({ op: "discovery", root: "api" }, call())).rejects.toThrow(
      ANONYMOUS_UNAUTHORIZED_SENTENCE,
    );
    expect(unauthorized.transport.calls).toHaveLength(1);
    const forbidden = clientWith(() => statusAnswer(403, "Forbidden"), anonymous);
    await expect(forbidden.client.send({ op: "discovery", root: "api" }, call())).rejects.toThrow(
      "The API server saw an anonymous request, which may not read the API's discovery at /api (403 Forbidden): this connection sends no token and no client certificate.",
    );
  });

  test("a 403 answers Studio's sentence, never the Status message", async () => {
    const { client } = clientWith(() => statusAnswer(403, "Forbidden"));
    const error = await client.send({ op: "list", target: PODS, namespace: "shop" }, call()).then(
      () => new Error("expected a refusal"),
      (refusal: Error) => refusal,
    );
    expect(error.message).toBe("This connection's identity may not list pods in the namespace shop (403 Forbidden).");
    expect(error.message).not.toContain("leaked-status-message");
  });

  test("a body over the cap and a deadline are worded by errors.ts; any other transport failure passes", async () => {
    const tooLarge = clientWith(() => {
      throw new TransportError("too-large", "x");
    });
    await expect(tooLarge.client.send({ op: "list", target: PODS }, call())).rejects.toThrow("larger than 16 MiB");
    const late = clientWith(() => {
      throw new TransportError("timeout", "x");
    });
    await expect(late.client.send({ op: "version" }, call())).rejects.toBeInstanceOf(TimeoutError);
    const tls = new TransportError("tls", "certificate rejected");
    const broken = clientWith(() => {
      throw tls;
    });
    await expect(broken.client.send({ op: "version" }, call())).rejects.toBe(tls);
  });

  test("json parses the body whatever its content type, and words a body that is not JSON", async () => {
    const parsed = clientWith(() => ({
      status: 200,
      contentType: "text/plain",
      retryAfter: null,
      text: '{"paths":{}}',
    }));
    expect(await parsed.client.json({ op: "openapi-index" }, call())).toEqual({ paths: {} });
    const broken = clientWith(() => ({
      status: 200,
      contentType: "application/json",
      retryAfter: null,
      text: "<html>",
    }));
    await expect(broken.client.json({ op: "version" }, call())).rejects.toThrow(
      "The API server answered the request to read the server's version at /version with a body that is not JSON.",
    );
  });

  test("json refuses a body nested deeper than 1,000 levels, so no renderer meets one, and reads one at 1,000", async () => {
    const nested = (levels: number) => `${'{"a":'.repeat(levels - 1)}[]${"}".repeat(levels - 1)}`;
    const answers = [nested(10_000), `[${nested(1_000)}]`, nested(1_000)];
    const reader = clientWith(() => ({
      status: 200,
      contentType: "application/json",
      retryAfter: null,
      text: answers.shift() as string,
    }));
    const sentence =
      "The API server answered the request to read the server's version at /version with JSON nested deeper than 1,000 levels, deeper than any Kubernetes object, so Studio shows nothing of it.";
    await expect(reader.client.json({ op: "version" }, call())).rejects.toThrow(sentence);
    await expect(reader.client.json({ op: "version" }, call())).rejects.toThrow(sentence);
    expect(await reader.client.json({ op: "version" }, call())).toBeDefined();
  });

  test("the discovery Accept asks for v2, then v2beta1, then plain JSON", () => {
    expect(ACCEPT_DISCOVERY).toBe(
      "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json;g=apidiscovery.k8s.io;v=v2beta1;as=APIGroupDiscoveryList,application/json",
    );
  });
});

describe("429 and Retry-After", () => {
  test("Retry-After in seconds is waited once, with the injected jitter, then the request is sent again", async () => {
    let first = true;
    const { client, transport, seams } = clientWith(
      () => {
        const answer = first ? statusAnswer(429, "TooManyRequests", "2") : jsonAnswer({});
        first = false;
        return answer;
      },
      kubernetesConnection(),
      0.5,
    );
    await client.send({ op: "version" }, call());
    expect(transport.calls).toHaveLength(2);
    expect(seams.sleeps).toEqual([2_125]);
  });

  test("Retry-After as an HTTP date waits until that moment", async () => {
    let first = true;
    const date = new Date(NOW + 3_000).toUTCString();
    const { client, seams } = clientWith(() => {
      const answer = first ? statusAnswer(429, "TooManyRequests", date) : jsonAnswer({});
      first = false;
      return answer;
    });
    await client.send({ op: "version" }, call());
    expect(seams.sleeps).toEqual([3_000]);
  });

  test("an absent Retry-After waits 1 s; a second 429 answers the sentence", async () => {
    const { client, transport, seams } = clientWith(() => statusAnswer(429, "TooManyRequests"));
    await expect(client.send({ op: "version" }, call())).rejects.toThrow(
      "The API server is limiting requests and did not read the server's version at /version (HTTP 429, reason TooManyRequests); run it again in a few seconds.",
    );
    expect(seams.sleeps).toEqual([1_000]);
    expect(transport.calls).toHaveLength(2);
  });

  test("a Retry-After above 5 s answers the sentence at once, with no wait and no second request", async () => {
    const { client, transport, seams } = clientWith(() => statusAnswer(429, "TooManyRequests", "6"));
    await expect(client.send({ op: "version" }, call())).rejects.toThrow(
      "The API server is limiting requests and asked Studio to wait 6 s before it would read the server's version at /version, longer than the 5 s Studio waits; run it again later.",
    );
    expect(seams.sleeps).toEqual([]);
    expect(transport.calls).toHaveLength(1);
  });

  /** A client over a clock that the first answer and every wait move forward. */
  function clockedClient(firstTakesMs: number, retryAfter: string) {
    let clock = NOW;
    let first = true;
    const transport = recordingKubernetesTransport(() => {
      if (first) {
        first = false;
        clock += firstTakesMs;
        return statusAnswer(429, "TooManyRequests", retryAfter);
      }
      throw new TransportError("timeout", "x");
    });
    const sleeps: number[] = [];
    const seams = {
      ...testSeams(transport, { now: NOW }),
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    };
    const endpoint = readClusterEndpoint(kubernetesConnection(), { queryTimeout: 30_000, appVersion: "0.18.2" });
    return { client: createKubernetesClient(endpoint, seams), transport, sleeps };
  }

  test("the request sent again after a wait gets only the time the call has left", async () => {
    const { client, transport, sleeps } = clockedClient(400, "0");
    await expect(client.send({ op: "version" }, call({ timeoutMs: 500 }))).rejects.toThrow(
      "The API server did not answer the request to read the server's version at /version within 0.1 s.",
    );
    expect(sleeps).toEqual([0]);
    expect(transport.calls).toHaveLength(2);
  });

  test("a Retry-After the call has no time left for answers the 429 sentence after one request", async () => {
    const { client, transport, sleeps } = clockedClient(400, "2");
    await expect(client.send({ op: "version" }, call({ timeoutMs: 2_000 }))).rejects.toThrow(
      "The API server is limiting requests and did not read the server's version at /version (HTTP 429, reason TooManyRequests); run it again in a few seconds.",
    );
    expect(sleeps).toEqual([]);
    expect(transport.calls).toHaveLength(1);
  });

  test("the wait with jitter never passes 5 s", async () => {
    let first = true;
    const { client, seams } = clientWith(
      () => {
        const answer = first ? statusAnswer(429, "TooManyRequests", "5") : jsonAnswer({});
        first = false;
        return answer;
      },
      kubernetesConnection(),
      0.99,
    );
    await client.send({ op: "version" }, call({ timeoutMs: 30_000 }));
    expect(seams.sleeps).toEqual([5_000]);
  });

  test("retryAfterMs reads seconds, a date, a past date, an absent and an unreadable value", () => {
    expect(retryAfterMs("4", NOW)).toBe(4_000);
    expect(retryAfterMs(new Date(NOW + 1_500).toUTCString(), NOW)).toBe(1_000);
    expect(retryAfterMs(new Date(NOW - 60_000).toUTCString(), NOW)).toBe(0);
    expect(retryAfterMs(null, NOW)).toBe(1_000);
    expect(retryAfterMs("soon", NOW)).toBe(1_000);
  });
});

describe("the default seams", () => {
  test("sleep resolves after its time, and rejects at once on an aborted signal or when aborted while waiting", async () => {
    await DEFAULT_KUBERNETES_SEAMS.sleep(1, new AbortController().signal);
    const aborted = new AbortController();
    aborted.abort(new Error("stopped"));
    await expect(DEFAULT_KUBERNETES_SEAMS.sleep(1, aborted.signal)).rejects.toThrow("stopped");
    const later = new AbortController();
    const waiting = DEFAULT_KUBERNETES_SEAMS.sleep(10_000, later.signal);
    later.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(DEFAULT_KUBERNETES_SEAMS.random()).toBeLessThan(1);
    expect(DEFAULT_KUBERNETES_SEAMS.now()).toBeGreaterThan(0);
  });

  test("the retry jitter draws from crypto.getRandomValues, never Math.random, and stays in [0, 1)", () => {
    const mathRandom = spyOn(Math, "random");
    try {
      for (let draw = 0; draw < 50; draw += 1) {
        const value = DEFAULT_KUBERNETES_SEAMS.random();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
      expect(mathRandom).not.toHaveBeenCalled();
    } finally {
      mathRandom.mockRestore();
    }
  });
});
