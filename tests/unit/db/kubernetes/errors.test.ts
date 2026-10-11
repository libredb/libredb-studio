import { describe, expect, test } from "bun:test";
import { AuthenticationError, QueryError, TimeoutError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  ANONYMOUS_UNAUTHORIZED_SENTENCE,
  answerFailure,
  anonymousForbiddenSentence,
  forbiddenSentence,
  type KubernetesRequestContext,
  KubernetesRequestError,
  KubernetesResponseTooLargeError,
  notServedSentence,
  requestWords,
  resourceName,
  statusReason,
  transportFailure,
  typeMissingSentence,
  UNAUTHORIZED_SENTENCE,
  watchEventFailure,
} from "@/lib/db/providers/platform/kubernetes/errors";
import { type KubernetesRequest, planRequest } from "@/lib/db/providers/platform/kubernetes/request-policy";

const LIST_DEPLOYMENTS: KubernetesRequestContext = {
  verb: "list",
  resource: "deployments",
  group: "apps",
  namespace: "shop",
};
const GET_POD: KubernetesRequestContext = {
  verb: "get",
  resource: "pods",
  group: "",
  namespace: "shop",
  name: "web-1",
};
const LIST_NODES: KubernetesRequestContext = { verb: "list", resource: "nodes", group: "" };
/** A Status whose message names the identity and echoes a value: none of it may reach a sentence. */
const LEAKY_MESSAGE = 'secrets "db" is forbidden: User "system:serviceaccount:shop:leaky" cannot get value hunter2';

function status(code: number, reason?: string): string {
  return JSON.stringify({ kind: "Status", apiVersion: "v1", status: "Failure", message: LEAKY_MESSAGE, reason, code });
}

const json = (code: number, reason?: string) => ({
  status: code,
  contentType: "application/json",
  text: status(code, reason),
});

describe("request words", () => {
  test("name the verb, the resource with its group, the name and the scope", () => {
    expect(requestWords(LIST_DEPLOYMENTS)).toBe("list deployments.apps in the namespace shop");
    expect(requestWords(GET_POD)).toBe("get pods web-1 in the namespace shop");
    expect(requestWords(LIST_NODES)).toBe("list nodes in the cluster");
    expect(resourceName({ resource: "pods", group: "" })).toBe("pods");
  });
});

describe("a read outside the resource API is worded as what it reads", () => {
  const words = (request: KubernetesRequest) => requestWords(planRequest(request).context);

  test("discovery is reading the API's discovery, not getting a resource named api", () => {
    expect(words({ op: "discovery", root: "api" })).toBe("read the API's discovery at /api");
    expect(words({ op: "discovery", root: "apis" })).toBe("read the API's discovery at /apis");
  });

  test("version, readiness and the OpenAPI documents name what they read and where", () => {
    expect(words({ op: "version" })).toBe("read the server's version at /version");
    expect(words({ op: "readyz" })).toBe("read the server's readiness at /readyz");
    expect(words({ op: "readyz", verbose: true })).toBe("read the server's readiness at /readyz");
    expect(words({ op: "openapi-index" })).toBe("read the API's OpenAPI index at /openapi/v3");
    expect(words({ op: "openapi-group", group: "apps", version: "v1", hash: "abc" })).toBe(
      "read the API's OpenAPI schema at /openapi/v3/apis/apps/v1",
    );
    expect(words({ op: "openapi-group", group: "", version: "v1", hash: "abc" })).toBe(
      "read the API's OpenAPI schema at /openapi/v3/api/v1",
    );
  });

  test("a 403 to a discovery read says the identity may not read the API's discovery", () => {
    const discovery = planRequest({ op: "discovery", root: "api" }).context;
    expect(answerFailure(discovery, json(403, "Forbidden")).message).toBe(
      "This connection's identity may not read the API's discovery at /api (403 Forbidden).",
    );
  });
});

describe("a connection that sends no credential", () => {
  const discovery = planRequest({ op: "discovery", root: "api" }).context;

  test("a 401 says the server rejected an anonymous request and that the connection sends no credential", () => {
    const error = answerFailure(GET_POD, json(401, "Unauthorized"), true);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(
      "The API server rejected an anonymous request (401 Unauthorized): this connection sends no token and no client certificate. Create a ServiceAccount token and paste it in the connection's Token field, as docs/providers/kubernetes.md shows.",
    );
    expect(error.message).toBe(ANONYMOUS_UNAUTHORIZED_SENTENCE);
  });

  test("a 403 says the server saw an anonymous request, names the request, and says the connection sends no credential", () => {
    const error = answerFailure(discovery, json(403, "Forbidden"), true) as KubernetesRequestError;
    expect(error).toBeInstanceOf(KubernetesRequestError);
    expect(error.message).toBe(
      "The API server saw an anonymous request, which may not read the API's discovery at /api (403 Forbidden): this connection sends no token and no client certificate. Create a ServiceAccount token and paste it in the connection's Token field, as docs/providers/kubernetes.md shows.",
    );
    expect(error.message).toBe(anonymousForbiddenSentence(discovery));
    expect(error.message).toBe(forbiddenSentence(discovery, true));
    expect([error.status, error.reason, error.typeMissing]).toEqual([403, "Forbidden", false]);
  });

  test("with a credential, 401 and 403 keep the identity's sentences", () => {
    expect(answerFailure(GET_POD, json(401), false).message).toBe(UNAUTHORIZED_SENTENCE);
    expect(answerFailure(discovery, json(403), false).message).toBe(forbiddenSentence(discovery));
    expect(forbiddenSentence(discovery, false)).toBe(forbiddenSentence(discovery));
  });

  test("every other status reads the same with or without a credential", () => {
    for (const code of [400, 404, 409, 410, 422, 429, 500]) {
      expect(answerFailure(LIST_NODES, json(code), true).message).toBe(answerFailure(LIST_NODES, json(code)).message);
    }
  });
});

describe("statusReason", () => {
  test("reads a one-word CamelCase reason from a JSON Status", () => {
    expect(statusReason(json(403, "Forbidden"))).toBe("Forbidden");
  });
  test("drops a reason that is not one CamelCase word, a body that is not JSON and a non-JSON content type", () => {
    expect(statusReason(json(403, "Forbidden: hunter2"))).toBeUndefined();
    expect(statusReason({ status: 500, contentType: "application/json", text: "not json" })).toBeUndefined();
    expect(statusReason({ status: 500, contentType: "application/json", text: "[1]" })).toBeUndefined();
    expect(statusReason({ status: 404, contentType: "text/plain", text: status(404, "NotFound") })).toBeUndefined();
    expect(statusReason({ status: 404, contentType: null, text: status(404, "NotFound") })).toBeUndefined();
  });
});

describe("answerFailure", () => {
  test("401 is an AuthenticationError with the expiry sentence", () => {
    const error = answerFailure(GET_POD, json(401, "Unauthorized"));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(UNAUTHORIZED_SENTENCE);
    expect(String(error.provider)).toBe("kubernetes");
  });

  test("403 names the verb, the resource and the namespace", () => {
    const error = answerFailure(LIST_DEPLOYMENTS, json(403, "Forbidden")) as KubernetesRequestError;
    expect(error).toBeInstanceOf(KubernetesRequestError);
    expect(error.message).toBe(
      "This connection's identity may not list deployments.apps in the namespace shop (403 Forbidden).",
    );
    expect(error.message).toBe(forbiddenSentence(LIST_DEPLOYMENTS));
    expect([error.status, error.reason, error.typeMissing]).toEqual([403, "Forbidden", false]);
  });

  test("a text/plain 404 is a missing type; a Status 404 names the missing object", () => {
    const missingType = answerFailure(LIST_DEPLOYMENTS, {
      status: 404,
      contentType: "text/plain; charset=utf-8",
      text: "404 page not found",
    });
    expect((missingType as KubernetesRequestError).typeMissing).toBe(true);
    expect(missingType.message).toBe('the server doesn\'t have a resource type "deployments.apps"');
    expect(missingType.message).toBe(typeMissingSentence("deployments.apps"));
    const missingObject = answerFailure(GET_POD, json(404, "NotFound")) as KubernetesRequestError;
    expect(missingObject.typeMissing).toBe(false);
    expect(missingObject.message).toBe("pods web-1 was not found in the namespace shop (404 Not Found).");
    expect(answerFailure(LIST_NODES, json(404)).message).toBe(
      "The API server found nothing to list nodes in the cluster (404 Not Found).",
    );
  });

  test("400, 422, 410, 429, 5xx and any other status carry the status and the reason", () => {
    expect(answerFailure(LIST_DEPLOYMENTS, json(422, "Invalid")).message).toBe(
      "The API server refused to list deployments.apps in the namespace shop as invalid (HTTP 422, reason Invalid).",
    );
    expect(answerFailure(LIST_DEPLOYMENTS, json(400)).message).toBe(
      "The API server refused to list deployments.apps in the namespace shop as invalid (HTTP 400).",
    );
    expect(answerFailure(LIST_DEPLOYMENTS, json(410, "Expired")).message).toBe(
      "The list changed on the server while Studio read it page by page, so it cannot list deployments.apps in the namespace shop from where it stopped (HTTP 410, reason Expired).",
    );
    expect(answerFailure(LIST_DEPLOYMENTS, json(429, "TooManyRequests")).message).toBe(
      "The API server is limiting requests and did not list deployments.apps in the namespace shop (HTTP 429, reason TooManyRequests); run it again in a few seconds.",
    );
    expect(answerFailure(LIST_NODES, json(503, "ServiceUnavailable")).message).toBe(
      "The API server failed to list nodes in the cluster (HTTP 503, reason ServiceUnavailable).",
    );
    expect(answerFailure(LIST_NODES, json(409, "Conflict")).message).toBe(
      "The API server did not list nodes in the cluster (HTTP 409, reason Conflict).",
    );
  });

  test("no sentence carries the server's Status message", () => {
    for (const code of [400, 403, 404, 409, 410, 422, 429, 500, 504]) {
      const message = answerFailure(GET_POD, json(code, "Forbidden")).message;
      expect(message).not.toContain("hunter2");
      expect(message).not.toContain("system:serviceaccount");
    }
  });
});

describe("transportFailure", () => {
  const caps = { maxResponseBytes: 16 * 1024 * 1024, timeoutMs: 30_000 };
  test("a body over the cap names the cap and how to narrow", () => {
    const error = transportFailure(LIST_DEPLOYMENTS, new TransportError("too-large", "x"), caps) as QueryError;
    expect(error).toBeInstanceOf(KubernetesResponseTooLargeError);
    expect(error.message).toBe(
      "The answer to list deployments.apps in the namespace shop is larger than 16 MiB, the most Studio reads in one response; narrow it with -l or --field-selector.",
    );
  });
  test("a deadline is a TimeoutError naming the seconds", () => {
    const error = transportFailure(LIST_NODES, new TransportError("timeout", "x"), caps) as TimeoutError;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe("The API server did not answer the request to list nodes in the cluster within 30 s.");
  });
  test("every other failure passes as raised", () => {
    const tls = new TransportError("tls", "certificate rejected");
    expect(transportFailure(LIST_NODES, tls, caps)).toBe(tls);
    const plain = new Error("boom");
    expect(transportFailure(LIST_NODES, plain, caps)).toBe(plain);
  });
});

describe("watchEventFailure and notServedSentence", () => {
  test("an ERROR event answers its code and reason, never its message", () => {
    const watch: KubernetesRequestContext = { verb: "watch", resource: "pods", group: "", namespace: "shop" };
    expect(watchEventFailure(watch, { code: 410, reason: "Expired", message: LEAKY_MESSAGE } as never).message).toBe(
      "The watch to watch pods in the namespace shop ended with an error event from the API server (code 410, reason Expired); run it again to read from now.",
    );
    expect(watchEventFailure(watch, { code: "x", reason: "two words" }).message).toBe(
      "The watch to watch pods in the namespace shop ended with an error event from the API server; run it again to read from now.",
    );
  });
  test("a kind the server does not serve names its label and the resource", () => {
    expect(notServedSentence("Ingresses", { resource: "ingresses", group: "networking.k8s.io" })).toBe(
      "This server does not serve Ingresses: discovery lists no ingresses.networking.k8s.io.",
    );
  });
});
