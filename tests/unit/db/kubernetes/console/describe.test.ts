/**
 * `describe`: one grid of section, field and value from the one-row Table, the object and its events (selected by
 * kind, name, namespace and uid, escaped), a cluster-scoped object, an identity that may not list events, and the
 * planted Secret marker absent from every row.
 */
import { describe, expect, test } from "bun:test";
import type { NodeRequest } from "@/lib/db/http/node-transport";
import { describeObject } from "@/lib/db/providers/platform/kubernetes/console/describe";
import { type KubectlStatement, parseKubectl } from "@/lib/db/providers/platform/kubernetes/console/parse";
import {
  consoleContext,
  listAnswer,
  markerSecret,
  routes,
  SECRET_MARKER,
  sentLines,
  tableAnswer,
} from "../../../../helpers/kubernetes-console";
import { discoveryList, resource } from "../../../../helpers/kubernetes-discovery";
import { jsonAnswer, statusAnswer } from "../../../../helpers/kubernetes-transport";

type Describe = Extract<KubectlStatement, { readonly command: "describe" }>;

function describeOf(text: string): Describe {
  const parsed = parseKubectl(text);
  if (!parsed.ok || parsed.statement.command !== "describe") throw new Error(`not a describe: ${text}`);
  return parsed.statement;
}

const POD = {
  kind: "Pod",
  metadata: {
    name: "web",
    namespace: "shop",
    uid: "uid-1",
    creationTimestamp: "2026-10-10T11:00:00Z",
    labels: { tier: "front", app: "web" },
    ownerReferences: [
      { kind: "ReplicaSet", name: "web-6f7d", controller: true },
      { kind: "Node", name: "n1" },
    ],
    finalizers: ["example.com/keep"],
  },
  status: {
    conditions: [
      { type: "Ready", status: "True" },
      { type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/1 nodes are available" },
    ],
  },
};

const POD_SELECTOR =
  "involvedObject.kind%3DPod%2CinvolvedObject.name%3Dweb%2CinvolvedObject.namespace%3Dshop%2CinvolvedObject.uid%3Duid-1";

describe("describe", () => {
  test("Summary, Conditions and Events rows, from three reads", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods/web?includeObject=None": tableAnswer(
        [{ name: "Name" }, { name: "Ready" }, { name: "Restarts", type: "integer" }, { name: "IP", priority: 1 }],
        [{ cells: ["web", "1/1", 0, "10.0.0.1"] }],
      ),
      "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(POD),
      [`GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=${POD_SELECTOR}`]: listAnswer([
        {
          type: "Normal",
          reason: "Started",
          message: "Started container app ",
          lastTimestamp: "2026-10-10T11:58:00Z",
          source: { component: "kubelet" },
        },
        {
          type: "Normal",
          reason: "Scheduled",
          message: "Assigned shop/web to n1",
          lastTimestamp: null,
          eventTime: "2026-10-10T11:00:00.000000Z",
          reportingComponent: "default-scheduler",
        },
      ]),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await describeObject(context, describeOf("kubectl describe pod web -n shop"));
    expect(sentLines(transport)).toEqual([
      "GET /api/v1/namespaces/shop/pods/web?includeObject=None",
      "GET /api/v1/namespaces/shop/pods/web",
      `GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=${POD_SELECTOR}`,
    ]);
    expect(grid.fields).toEqual(["SECTION", "FIELD", "VALUE"]);
    expect(grid.rows.map((row) => [row.SECTION, row.FIELD, row.VALUE])).toEqual([
      ["Summary", "Name", "web"],
      ["Summary", "Ready", "1/1"],
      ["Summary", "Restarts", "0"],
      ["Summary", "IP", "10.0.0.1"],
      ["Summary", "Namespace", "shop"],
      ["Summary", "Created", "2026-10-10T11:00:00Z"],
      ["Summary", "Label", "app=web"],
      ["Summary", "Label", "tier=front"],
      ["Summary", "Annotation", "<none>"],
      ["Summary", "Owner", "ReplicaSet/web-6f7d (controller)"],
      ["Summary", "Owner", "Node/n1"],
      ["Summary", "Finalizer", "example.com/keep"],
      ["Conditions", "Ready", "True"],
      ["Conditions", "PodScheduled", "False (Unschedulable: 0/1 nodes are available)"],
      ["Events", "Normal Scheduled", "60m ago, from default-scheduler: Assigned shop/web to n1"],
      ["Events", "Normal Started", "2m ago, from kubelet: Started container app"],
    ]);
  });

  test("a cluster-scoped object is read without a namespace, and its events across the cluster", async () => {
    const selector = "involvedObject.kind%3DClusterRole%2CinvolvedObject.name%3Dsystem%3Aaggregate-to-view";
    const answer = routes({
      "GET /apis/rbac.authorization.k8s.io/v1/clusterroles/system:aggregate-to-view?includeObject=None": tableAnswer(
        [{ name: "Name" }],
        [{ cells: ["system:aggregate-to-view"] }],
      ),
      "GET /apis/rbac.authorization.k8s.io/v1/clusterroles/system:aggregate-to-view": jsonAnswer({
        metadata: { name: "system:aggregate-to-view" },
      }),
      [`GET /api/v1/events?limit=500&fieldSelector=${selector}`]: listAnswer([]),
    });
    const { context } = consoleContext(answer);
    const grid = await describeObject(context, describeOf("describe clusterrole/system:aggregate-to-view"));
    expect(grid.rows.map((row) => row.FIELD)).not.toContain("Namespace");
    expect(grid.rows.at(-1)).toEqual({ SECTION: "Events", FIELD: "Events", VALUE: "<none>" });
  });

  test("an identity that may not list events sees one row that says so", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods/web?includeObject=None": tableAnswer([{ name: "Name" }], [{ cells: ["web"] }]),
      "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(POD),
      [`GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=${POD_SELECTOR}`]: statusAnswer(403, "Forbidden"),
    });
    const { context } = consoleContext(answer);
    const grid = await describeObject(context, describeOf("describe pod/web"));
    expect(grid.rows.at(-1)).toEqual({
      SECTION: "Events",
      FIELD: "Events",
      VALUE: "This connection's identity may not list events in the namespace shop (403 Forbidden).",
    });
  });

  test("a missing object answers the 404 sentence and reads nothing more", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods/gone?includeObject=None": statusAnswer(404, "NotFound"),
    });
    const { context, transport } = consoleContext(answer);
    await expect(describeObject(context, describeOf("describe pod gone"))).rejects.toThrow(
      "pods gone was not found in the namespace shop (404 Not Found).",
    );
    expect(sentLines(transport)).toHaveLength(1);
  });

  test("a Secret: no value, no stringData, no last-applied annotation in any row", async () => {
    const secret = markerSecret();
    const selector =
      "involvedObject.kind%3DSecret%2CinvolvedObject.name%3Ddb%2CinvolvedObject.namespace%3Dshop%2CinvolvedObject.uid%3Duid-secret";
    const answer = routes({
      "GET /api/v1/namespaces/shop/secrets/db?includeObject=None": tableAnswer(
        [{ name: "Name" }, { name: "Type" }, { name: "Data", type: "integer" }],
        [{ cells: ["db", "Opaque", 2], object: secret }],
      ),
      "GET /api/v1/namespaces/shop/secrets/db": jsonAnswer(secret),
      [`GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=${selector}`]: listAnswer([]),
    });
    const { context } = consoleContext(answer);
    const grid = await describeObject(context, describeOf("kubectl describe secret/db"));
    expect(grid.rows).toContainEqual({ SECTION: "Summary", FIELD: "Annotation", VALUE: "team=payments" });
    expect(JSON.stringify(grid)).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(grid)).not.toContain("last-applied-configuration");
  });

  test("an object whose Table has no row still answers its metadata rows", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/configmaps/conf?includeObject=None": tableAnswer([{ name: "Name" }], []),
      "GET /api/v1/namespaces/shop/configmaps/conf": jsonAnswer({ metadata: { name: "conf", uid: "u" } }),
      "GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=involvedObject.kind%3DConfigMap%2CinvolvedObject.name%3Dconf%2CinvolvedObject.namespace%3Dshop%2CinvolvedObject.uid%3Du":
        listAnswer([]),
    });
    const { context } = consoleContext(answer);
    const grid = await describeObject(context, describeOf("describe cm conf"));
    expect(grid.rows[0]).toEqual({ SECTION: "Summary", FIELD: "Name", VALUE: "" });
    expect(grid.rows).toContainEqual({ SECTION: "Summary", FIELD: "Created", VALUE: "<unknown>" });
  });

  test("a server that serves no core events answers one row that says so", async () => {
    const answer = routes({
      "GET /api": jsonAnswer(
        discoveryList([{ versions: [{ version: "v1", resources: [resource("pods", "Pod", "Namespaced")] }] }]),
      ),
      "GET /api/v1/namespaces/shop/pods/web?includeObject=None": tableAnswer([{ name: "Name" }], [{ cells: ["web"] }]),
      "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(POD),
    });
    const { context } = consoleContext(answer);
    const grid = await describeObject(context, describeOf("describe pod web"));
    expect(grid.rows.at(-1)).toEqual({
      SECTION: "Events",
      FIELD: "Events",
      VALUE: "This server does not serve core events.",
    });
  });

  test("more than 5,000 events of the object end with a row that says only the first 5,000 are shown", async () => {
    const events = (request: NodeRequest) => {
      const search = new URL(request.url).searchParams;
      const start = Number(search.get("continue") ?? "0");
      const count = Number(search.get("limit"));
      return listAnswer(
        Array.from({ length: count }, () => ({
          type: "Normal",
          reason: "Pulled",
          message: "m",
          lastTimestamp: "2026-10-10T11:00:00Z",
        })),
        { continue: String(start + count) },
      );
    };
    const fixed = routes({
      "GET /api/v1/namespaces/shop/pods/web?includeObject=None": tableAnswer([{ name: "Name" }], [{ cells: ["web"] }]),
      "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(POD),
    });
    const { context } = consoleContext((request, line) =>
      line.startsWith("GET /api/v1/namespaces/shop/events?") ? events(request) : fixed(request, line),
    );
    const grid = await describeObject(context, describeOf("describe pod web"));
    expect(grid.rows.filter((row) => row.SECTION === "Events")).toHaveLength(5_001);
    expect(grid.rows.at(-1)).toEqual({
      SECTION: "Events",
      FIELD: "Events",
      VALUE: "More than 5,000 events name this object; the first 5,000 the server listed are shown.",
    });
  });
});
