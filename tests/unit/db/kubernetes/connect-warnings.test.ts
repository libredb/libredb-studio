import { describe, expect, test } from "bun:test";
import {
  accessReviewBody,
  CHECKED_RIGHTS,
  kubernetesConnectWarnings,
  NAMESPACE_CAP_NOTICE,
} from "@/lib/db/providers/platform/kubernetes/connect-warnings";
import { QueryError } from "@/lib/db/errors";
import { fakeCluster, manyRows, testSurface } from "../../../helpers/kubernetes-cluster";
import { statusAnswer } from "../../../helpers/kubernetes-transport";

const INDEX = { resources: [], groupVersions: [], dropped: 0 };
const REVIEW = "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews";

describe("the six access reviews", () => {
  test("are sent byte for byte as these bodies, in this order", async () => {
    const { surface, transport } = testSurface(fakeCluster({ lists: { "/api/v1/namespaces": [] } }), {
      database: "shop",
    });
    await kubernetesConnectWarnings(surface, INDEX);
    const bodies = transport.calls.filter((entry) => entry.method === REVIEW).map((entry) => entry.args?.[0]);
    expect(bodies).toEqual([
      '{"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","spec":{"resourceAttributes":{"verb":"create","resource":"pods","subresource":"exec","namespace":"shop"}}}',
      '{"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","spec":{"resourceAttributes":{"verb":"get","resource":"pods","subresource":"exec","namespace":"shop"}}}',
      '{"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","spec":{"resourceAttributes":{"verb":"get","resource":"nodes","subresource":"proxy"}}}',
      '{"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","spec":{"resourceAttributes":{"verb":"*","group":"*","resource":"*"}}}',
      '{"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","spec":{"resourceAttributes":{"verb":"list","resource":"secrets","namespace":"shop"}}}',
      '{"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","spec":{"resourceAttributes":{"verb":"list","resource":"secrets"}}}',
    ]);
    expect(CHECKED_RIGHTS).toHaveLength(6);
    expect(accessReviewBody({ verb: "get" })).toEqual({
      apiVersion: "authorization.k8s.io/v1",
      kind: "SelfSubjectAccessReview",
      spec: { resourceAttributes: { verb: "get" } },
    });
  });
});

describe("kubernetesConnectWarnings", () => {
  test("a view token holds none of the rights and gets no warning", async () => {
    const { surface } = testSurface(fakeCluster({ lists: { "/api/v1/namespaces": [] } }));
    expect(await kubernetesConnectWarnings(surface, INDEX)).toEqual([]);
  });

  test("a cluster-admin token is told every right it holds, in one warning", async () => {
    const { surface } = testSurface(fakeCluster({ lists: { "/api/v1/namespaces": [] }, allows: () => true }));
    expect(await kubernetesConnectWarnings(surface, INDEX)).toEqual([
      {
        message:
          "This connection's identity may run commands in pods (create pods/exec in the namespace default); open exec sessions on clusters before 1.35 (get pods/exec in the namespace default); reach every node's kubelet API (get nodes/proxy); do anything to every resource (* on *); read every Secret value in the namespace default (list secrets); read every Secret value in the cluster (list secrets). Studio stays read-only and never uses these rights, but a token bound to view or studio-reader is safer.",
      },
    ]);
  });

  test("a namespace edit token is told the namespace rights only", async () => {
    const { surface } = testSurface(
      fakeCluster({ lists: { "/api/v1/namespaces": [] }, allows: (attributes) => attributes.namespace === "shop" }),
      { database: "shop" },
    );
    const [warning] = await kubernetesConnectWarnings(surface, INDEX);
    expect(warning.message).toContain("create pods/exec in the namespace shop");
    expect(warning.message).not.toContain("nodes/proxy");
    expect(warning.message).not.toContain("in the cluster (list secrets)");
  });

  test("a namespace-bound identity gets the namespace notice; with the Namespaces field it does not", async () => {
    const bound = testSurface(fakeCluster({ forbidden: ["/api/v1/namespaces"] }), { database: "shop" });
    expect(await kubernetesConnectWarnings(bound.surface, INDEX)).toEqual([
      {
        message:
          "This identity may not list namespaces, so the tree shows the Default namespace (shop) alone; list the others in the connection's Namespaces field.",
      },
    ]);
    const listed = testSurface(fakeCluster({ forbidden: ["/api/v1/namespaces"] }), {
      database: "shop",
      namespaces: "shop",
    });
    expect(await kubernetesConnectWarnings(listed.surface, INDEX)).toEqual([]);
  });

  test("a cluster with more than 1,000 namespaces gets the notice that points to the Namespaces field", async () => {
    const { surface } = testSurface(fakeCluster({ lists: { "/api/v1/namespaces": manyRows("ns", 1_001) } }));
    expect(await kubernetesConnectWarnings(surface, INDEX)).toEqual([{ message: NAMESPACE_CAP_NOTICE }]);
  });

  test("dropped discovery entries are counted in a warning", async () => {
    const { surface } = testSurface(fakeCluster({ lists: { "/api/v1/namespaces": [] } }));
    expect(await kubernetesConnectWarnings(surface, { ...INDEX, dropped: 1 })).toEqual([
      {
        message:
          "Discovery listed 1 entry Studio could not read as a resource type; it is left out of the console and the Custom Resources folder.",
      },
    ]);
    expect((await kubernetesConnectWarnings(surface, { ...INDEX, dropped: 3 }))[0].message).toContain("3 entries");
  });

  test("a review the server refuses becomes a warning; a body without status is no right; other errors raise", async () => {
    const refused = testSurface((request, line) =>
      line === REVIEW
        ? statusAnswer(403, "Forbidden")
        : fakeCluster({ lists: { "/api/v1/namespaces": [] } })(request, line),
    );
    expect(await kubernetesConnectWarnings(refused.surface, INDEX)).toEqual([
      {
        message:
          "Studio could not check which rights this identity holds: This connection's identity may not create selfsubjectaccessreviews.authorization.k8s.io in the cluster (403 Forbidden).",
      },
    ]);
    const bare = testSurface((request, line) =>
      line === REVIEW
        ? { status: 201, contentType: "application/json", retryAfter: null, text: "null" }
        : fakeCluster({ lists: { "/api/v1/namespaces": [] } })(request, line),
    );
    expect(await kubernetesConnectWarnings(bare.surface, INDEX)).toEqual([]);
    const broken = testSurface((request, line) => {
      if (line === REVIEW) throw new QueryError("reset");
      return fakeCluster({ lists: { "/api/v1/namespaces": [] } })(request, line);
    });
    await expect(kubernetesConnectWarnings(broken.surface, INDEX)).rejects.toThrow("reset");
  });
});
