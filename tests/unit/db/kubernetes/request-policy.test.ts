import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  admitRequest,
  fieldSelectorValue,
  finalPathRefusal,
  type KubernetesRequest,
  planRequest,
  type ResourceRef,
} from "@/lib/db/providers/platform/kubernetes/request-policy";

const PODS: ResourceRef = {
  group: "",
  version: "v1",
  resource: "pods",
  namespaced: true,
  verbs: ["get", "list", "watch"],
};
const NODES: ResourceRef = { group: "", version: "v1", resource: "nodes", namespaced: false, verbs: ["get", "list"] };
const DEPLOYMENTS: ResourceRef = {
  group: "apps",
  version: "v1",
  resource: "deployments",
  namespaced: true,
  verbs: ["get", "list", "watch"],
};
const CLUSTER_ROLES: ResourceRef = {
  group: "rbac.authorization.k8s.io",
  version: "v1",
  resource: "clusterroles",
  namespaced: false,
  verbs: ["get", "list"],
};

function refused(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message.endsWith("Nothing was sent.")).toBe(true);
    return (error as Error).message;
  }
  throw new Error("expected a refusal, and the request was admitted");
}

describe("planRequest builds every allowed row", () => {
  test.each<[string, KubernetesRequest, string, string[][]]>([
    ["discovery /api", { op: "discovery", root: "api" }, "/api", []],
    ["discovery /apis", { op: "discovery", root: "apis" }, "/apis", []],
    ["version", { op: "version" }, "/version", []],
    ["readyz verbose", { op: "readyz", verbose: true }, "/readyz", [["verbose", "true"]]],
    ["openapi index", { op: "openapi-index" }, "/openapi/v3", []],
    [
      "openapi core",
      { op: "openapi-group", group: "", version: "v1", hash: "ABC123" },
      "/openapi/v3/api/v1",
      [["hash", "ABC123"]],
    ],
    [
      "openapi group",
      { op: "openapi-group", group: "apps", version: "v1", hash: "0f" },
      "/openapi/v3/apis/apps/v1",
      [["hash", "0f"]],
    ],
    [
      "list in a namespace",
      { op: "list", target: PODS, namespace: "shop", query: { limit: 500, includeObject: "None" } },
      "/api/v1/namespaces/shop/pods",
      [
        ["limit", "500"],
        ["includeObject", "None"],
      ],
    ],
    ["list across namespaces", { op: "list", target: PODS }, "/api/v1/pods", []],
    [
      "list cluster-scoped in a group",
      { op: "list", target: CLUSTER_ROLES },
      "/apis/rbac.authorization.k8s.io/v1/clusterroles",
      [],
    ],
    [
      "watch",
      { op: "watch", target: DEPLOYMENTS, namespace: "shop", query: { resourceVersion: "42", timeoutSeconds: 10 } },
      "/apis/apps/v1/namespaces/shop/deployments",
      [
        ["watch", "1"],
        ["allowWatchBookmarks", "true"],
        ["resourceVersion", "42"],
        ["timeoutSeconds", "10"],
      ],
    ],
    [
      "get one object",
      { op: "get", target: PODS, namespace: "shop", name: "web-1" },
      "/api/v1/namespaces/shop/pods/web-1",
      [],
    ],
    [
      "get a cluster-scoped object with a colon in its name",
      { op: "get", target: CLUSTER_ROLES, name: "system:aggregate-to-view" },
      "/apis/rbac.authorization.k8s.io/v1/clusterroles/system:aggregate-to-view",
      [],
    ],
    [
      "logs",
      { op: "logs", namespace: "shop", pod: "web-1", query: { container: "app", tailLines: 500, timestamps: true } },
      "/api/v1/namespaces/shop/pods/web-1/log",
      [
        ["container", "app"],
        ["tailLines", "500"],
        ["timestamps", "true"],
      ],
    ],
  ])("%s", (_name, request, path, query) => {
    const planned = planRequest(request);
    expect(planned.method).toBe("GET");
    expect(planned.path).toBe(path);
    expect(planned.query.map((pair) => pair.join("="))).toEqual(query.map((pair) => pair.join("=")));
  });

  test("the three self reviews are POSTs to exact paths with a JSON body Studio builds", () => {
    const body = { kind: "SelfSubjectAccessReview", spec: { resourceAttributes: { name: 'we"ird' } } };
    const planned = planRequest({ op: "review", review: "selfsubjectaccessreviews", body });
    expect(planned.method).toBe("POST");
    expect(planned.path).toBe("/apis/authorization.k8s.io/v1/selfsubjectaccessreviews");
    expect(JSON.parse(planned.body as string)).toEqual(body);
    expect(planRequest({ op: "review", review: "selfsubjectreviews", body: {} }).path).toBe(
      "/apis/authentication.k8s.io/v1/selfsubjectreviews",
    );
    expect(planRequest({ op: "review", review: "selfsubjectrulesreviews", body: {} }).context).toEqual({
      verb: "create",
      resource: "selfsubjectrulesreviews",
      group: "authorization.k8s.io",
    });
  });

  test("each request carries the context its error sentence names", () => {
    expect(planRequest({ op: "list", target: DEPLOYMENTS, namespace: "shop" }).context).toEqual({
      verb: "list",
      resource: "deployments",
      group: "apps",
      namespace: "shop",
    });
    expect(planRequest({ op: "logs", namespace: "shop", pod: "web-1", query: {} }).context).toEqual({
      verb: "get",
      resource: "pods/log",
      group: "",
      namespace: "shop",
      name: "web-1",
    });
  });
});

describe("planRequest refuses before a path is built", () => {
  test("a verb discovery does not list", () => {
    expect(
      refused(() => planRequest({ op: "watch", target: NODES, query: { resourceVersion: "1", timeoutSeconds: 10 } })),
    ).toBe("Discovery does not list watch for nodes. Nothing was sent.");
  });
  test("a namespace on a cluster-scoped resource, and no namespace on a namespaced get", () => {
    expect(refused(() => planRequest({ op: "list", target: NODES, namespace: "shop" }))).toContain("cluster-scoped");
    expect(refused(() => planRequest({ op: "get", target: PODS, name: "web-1" }))).toContain("needs its namespace");
  });
  test.each(["Shop", "shop/x", "..", "a%2Fb", "%2E%2E", "shop;x"])("a namespace %s", (namespace) => {
    expect(refused(() => planRequest({ op: "list", target: PODS, namespace }))).toBe(
      "A namespace must be a DNS-1123 label. Nothing was sent.",
    );
  });
  test.each(["a/b", ".", "..", "%2F", "%2f", "%2E%2E", "a;b", "a b", ""])("an object name %s", (name) => {
    expect(refused(() => planRequest({ op: "get", target: NODES, name }))).toContain("An object name may hold");
  });
  test("a pod name that is not a DNS-1123 subdomain", () => {
    expect(refused(() => planRequest({ op: "get", target: PODS, namespace: "shop", name: "Web" }))).toBe(
      "A pod name must be a DNS-1123 subdomain. Nothing was sent.",
    );
    expect(refused(() => planRequest({ op: "logs", namespace: "shop", pod: "web:1", query: {} }))).toContain(
      "pod name",
    );
  });
  test("a malformed group, version or resource", () => {
    expect(refused(() => planRequest({ op: "list", target: { ...DEPLOYMENTS, group: "Apps" } }))).toContain(
      "API group",
    );
    expect(refused(() => planRequest({ op: "list", target: { ...DEPLOYMENTS, version: "1" } }))).toContain(
      "API version",
    );
    expect(refused(() => planRequest({ op: "list", target: { ...DEPLOYMENTS, resource: "Deployments" } }))).toContain(
      "resource name",
    );
    expect(refused(() => planRequest({ op: "openapi-group", group: "Apps", version: "v1", hash: "0" }))).toContain(
      "API group",
    );
    expect(refused(() => planRequest({ op: "openapi-group", group: "apps", version: "x", hash: "0" }))).toContain(
      "API version",
    );
  });
  test("a container name that is not a label, and a log query value outside its rule", () => {
    expect(refused(() => planRequest({ op: "logs", namespace: "shop", pod: "web", query: { container: "App" } }))).toBe(
      "The value of the query key container is outside what Studio sends. Nothing was sent.",
    );
    expect(
      refused(() => planRequest({ op: "logs", namespace: "shop", pod: "web", query: { sinceTime: "yesterday" } })),
    ).toContain("sinceTime");
  });
  test("an OpenAPI hash that is not hex", () => {
    expect(refused(() => planRequest({ op: "openapi-group", group: "apps", version: "v1", hash: "x y" }))).toContain(
      "hash",
    );
  });
});

describe("admitRequest, the allowlist on the final strings", () => {
  test.each([
    ["exec", "/api/v1/namespaces/shop/pods/web/exec"],
    ["attach", "/api/v1/namespaces/shop/pods/web/attach"],
    ["portforward", "/api/v1/namespaces/shop/pods/web/portforward"],
    ["proxy", "/api/v1/namespaces/shop/pods/web/proxy"],
    ["proxy", "/api/v1/namespaces/shop/services/web/proxy/x"],
    ["proxy", "/api/v1/nodes/n1/proxy"],
    ["token", "/api/v1/namespaces/shop/serviceaccounts/sa/token"],
    ["eviction", "/api/v1/namespaces/shop/pods/web/eviction"],
    ["binding", "/api/v1/namespaces/shop/pods/web/binding"],
  ])("the %s subresource is refused by name", (name, path) => {
    expect(refused(() => admitRequest("GET", path, []))).toBe(
      `The ${name} subresource is never requested. Nothing was sent.`,
    );
  });

  test("a name that spells a subresource is still a name", () => {
    admitRequest("GET", "/api/v1/namespaces/proxy/configmaps/token", []);
    admitRequest("GET", "/api/v1/namespaces/exec/pods", []);
  });

  test("any other subresource, method or path is refused", () => {
    expect(refused(() => admitRequest("GET", "/api/v1/nodes/n1/status", []))).toBe(
      "Studio reads no subresource but a pod's log. Nothing was sent.",
    );
    expect(refused(() => admitRequest("DELETE", "/api/v1/namespaces/shop/pods/web", []))).toContain("no other method");
    expect(refused(() => admitRequest("PUT", "/api/v1/namespaces/shop/pods/web", []))).toContain("no other method");
    expect(refused(() => admitRequest("GET", "/healthz", []))).toBe(
      "Studio sends no request to this path. Nothing was sent.",
    );
    expect(refused(() => admitRequest("GET", "relative", []))).toContain("no request to this path");
    expect(refused(() => admitRequest("GET", "/openapi/v2", []))).toContain("no request to this path");
    expect(refused(() => admitRequest("GET", "/openapi/v3/apis/apps", []))).toContain("no request to this path");
    expect(refused(() => admitRequest("GET", "/api/x/pods", []))).toContain("no request to this path");
    expect(refused(() => admitRequest("GET", "/api/v1/Pods", []))).toContain("no request to this path");
    expect(refused(() => admitRequest("GET", "/api/v1/namespaces/Shop/pods", []))).toContain("no request to this path");
    expect(refused(() => admitRequest("GET", "/api/v1/pods/a b", []))).toContain("a segment Studio never sends");
  });

  test("a namespace's own subresources and a dot segment as a name are refused, never read as a collection or an object", () => {
    expect(refused(() => admitRequest("GET", "/api/v1/namespaces/shop/status", []))).toBe(
      "Studio reads no subresource but a pod's log. Nothing was sent.",
    );
    expect(refused(() => admitRequest("GET", "/api/v1/namespaces/shop/finalize", []))).toBe(
      "Studio reads no subresource but a pod's log. Nothing was sent.",
    );
    expect(refused(() => admitRequest("GET", "/api/v1/namespaces/shop/status/x", []))).toContain("no subresource");
    expect(refused(() => admitRequest("GET", "/api/v1/namespaces/shop/pods/..", []))).toBe(
      "The request path holds a character or a segment Studio never sends. Nothing was sent.",
    );
    expect(refused(() => admitRequest("GET", "/api/v1/nodes/.", []))).toContain("a segment Studio never sends");
    admitRequest("GET", "/api/v1/namespaces/shop", []);
    admitRequest("GET", "/apis/apps/v1/namespaces/shop/deployments", []);
  });

  test("POST goes only to the three reviews, with no query", () => {
    expect(refused(() => admitRequest("POST", "/api/v1/namespaces/shop/pods", []))).toContain("three self reviews");
    expect(
      refused(() =>
        admitRequest("POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", [["dryRun", "All"]]),
      ),
    ).toContain("three self reviews");
  });

  test("query keys are per row, once each, and follow is never sent", () => {
    expect(refused(() => admitRequest("GET", "/api/v1/namespaces/shop/pods/web/log", [["follow", "true"]]))).toBe(
      "The query key follow is not sent on this request. Nothing was sent.",
    );
    expect(refused(() => admitRequest("GET", "/api/v1/pods", [["tailLines", "5"]]))).toContain("tailLines");
    expect(
      refused(() =>
        admitRequest("GET", "/api/v1/pods", [
          ["limit", "5"],
          ["limit", "6"],
        ]),
      ),
    ).toContain("at most once");
    expect(refused(() => admitRequest("GET", "/api/v1/pods", [["includeObject", "Object"]]))).toContain(
      "includeObject",
    );
    expect(refused(() => admitRequest("GET", "/api/v1/pods", [["watch", "true"]]))).toContain("watch");
    expect(refused(() => admitRequest("GET", "/openapi/v3/api/v1", []))).toBe(
      "An OpenAPI group document is read only with its hash. Nothing was sent.",
    );
    expect(refused(() => admitRequest("GET", "/version", [["verbose", "true"]]))).toContain("verbose");
  });
});

describe("the final path and field selectors", () => {
  test.each(["/k8s/%2Fx/api", "/k8s//api", "/k8s/;/api", "/k8s/./api", "/k8s/../api", "/k8s/a b"])(
    "%s is refused",
    (path) => {
      expect(finalPathRefusal(path)).toBe(
        "The request path holds a character or a segment Studio never sends. Nothing was sent.",
      );
    },
  );
  test("a clean prefix and path pass", () => {
    expect(finalPathRefusal("/k8s/clusters/c-1/api/v1/namespaces/shop/pods")).toBeUndefined();
  });
  test("a name inside a field selector escapes backslash, comma and equals", () => {
    expect(fieldSelectorValue("a,b=c\\d")).toBe("a\\,b\\=c\\\\d");
  });
});
