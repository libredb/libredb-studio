import "../../setup-dom";

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { groupRowId } from "@/components/object-tree/flatten";
import { type ObjectReadRequest, type ObjectSource, useTreeNodes } from "@/components/object-tree/use-tree-nodes";
import type { DatabaseObject, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The tree's cache over containers that name their kinds and kinds drawn in groups, through an
 * injected object source rather than the HTTP routes: the reads it asks for are what is asserted.
 *
 * `Cluster` holds the cluster-scoped kind (`nodes`); the namespace `shop` holds the namespaced ones,
 * two of which share the Workloads group. The source refuses any other pair, as a provider must.
 */

const WORKLOADS = { id: "workloads", label: "Workloads" } as const;
const capabilities = {
  queryLanguage: "json",
  containerLevels: [{ id: "schema", label: "Namespace", labelPlural: "Namespaces" }],
  objectKinds: [
    { id: "pods", role: "config", label: "Pod", labelPlural: "Pods", group: WORKLOADS },
    { id: "deployments", role: "config", label: "Deployment", labelPlural: "Deployments", group: WORKLOADS },
    { id: "nodes", role: "config", label: "Node", labelPlural: "Nodes" },
  ],
} as unknown as ProviderCapabilities;

const connection: DatabaseConnection = { id: "k", name: "cluster", type: "postgres", createdAt: new Date(0) };

const listings: Record<string, DatabaseObject[]> = {
  "shop/pods": [{ path: ["shop", "pod/web-1"], name: "pod/web-1", kind: "pods" }],
  "shop/deployments": [{ path: ["shop", "deployment/web"], name: "deployment/web", kind: "deployments" }],
  "Cluster/nodes": [{ path: ["Cluster", "node/n1"], name: "node/n1", kind: "nodes" }],
};

/** A source answering like a provider whose containers name their kinds; every request is recorded. */
function clusterSource(containers: unknown = defaultContainers): { source: ObjectSource; asked: ObjectReadRequest[] } {
  const asked: ObjectReadRequest[] = [];
  const source: ObjectSource = async (_connection, request) => {
    asked.push(request);
    switch (request.route) {
      case "containers":
        return containers;
      case "counts":
        return request.container[0] === "Cluster"
          ? { nodes: { count: 1 } }
          : { pods: { count: 1 }, deployments: { count: 1 } };
      case "list": {
        const listed = listings[`${request.container[0]}/${request.kind}`];
        if (listed === undefined) throw new Error(`${request.container[0]} holds no ${request.kind}`);
        return listed;
      }
      case "describe":
        return { path: request.path, columns: [], indexes: [], foreignKeys: [] };
    }
  };
  return { source, asked };
}

const defaultContainers = [
  { path: ["Cluster"], name: "Cluster", level: 0, kinds: ["nodes"] },
  { path: ["shop"], name: "shop", level: 0, kinds: ["pods", "deployments"], isSessionDefault: true },
];

function mount(source: ObjectSource) {
  return renderHook(
    ({ query }: { query: string }) => useTreeNodes(connection, capabilities, false, source, false, query),
    {
      initialProps: { query: "" },
    },
  );
}

afterEach(cleanup);

describe("a tree over containers that name their kinds", () => {
  test("each container draws its own kinds, and the namespaced ones inside their group", async () => {
    const { source } = clusterSource();
    const hook = mount(source);
    await waitFor(() => expect(hook.result.current.rows.some((row) => row.kind === "group")).toBe(true));
    act(() => hook.result.current.toggle("Cluster"));
    act(() => hook.result.current.toggle(groupRowId(["shop"], "workloads")));
    await waitFor(() => expect(hook.result.current.rows.some((row) => row.label === "Nodes")).toBe(true));
    expect(hook.result.current.rows.map((row) => `${row.depth}:${row.label}`)).toEqual([
      "0:Cluster",
      "1:Nodes",
      "0:shop",
      "1:Workloads",
      "2:Pods",
      "2:Deployments",
    ]);
  });

  test("the filter's read action lists only the pairs each container holds", async () => {
    const { source, asked } = clusterSource();
    const hook = mount(source);
    await waitFor(() => expect(hook.result.current.rows.some((row) => row.kind === "group")).toBe(true));
    act(() => hook.result.current.toggle("Cluster"));
    await waitFor(() =>
      expect(asked.some((request) => request.route === "counts" && request.container[0] === "Cluster")).toBe(true),
    );
    hook.rerender({ query: "web" });

    act(() => hook.result.current.search?.readUnread());

    await waitFor(() => expect(hook.result.current.search).toMatchObject({ unread: 0, reading: 0, failed: 0 }));
    const lists = asked
      .filter((request) => request.route === "list")
      .map((request) => (request.route === "list" ? `${request.container[0]}/${request.kind}` : ""));
    expect(lists.sort()).toEqual(["Cluster/nodes", "shop/deployments", "shop/pods"]);
  });

  test("the filter opens the group around a match, and asks for nothing on a keystroke", async () => {
    const { source, asked } = clusterSource();
    const hook = mount(source);
    const group = groupRowId(["shop"], "workloads");
    await waitFor(() => expect(hook.result.current.rows.some((row) => row.id === group)).toBe(true));
    // Read the pods folder, then close it and its group, so the match sits behind two closed rows.
    act(() => hook.result.current.toggle(group));
    act(() => hook.result.current.toggle("shop/pods"));
    await waitFor(() => expect(hook.result.current.rows.some((row) => row.label === "pod/web-1")).toBe(true));
    act(() => hook.result.current.toggle("shop/pods"));
    act(() => hook.result.current.toggle(group));
    const before = asked.length;

    hook.rerender({ query: "web-1" });

    expect(hook.result.current.rows.map((row) => row.label)).toEqual(["shop", "Workloads", "Pods", "pod/web-1"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked.length).toBe(before);
  });

  test("closing a group while filtering is the filter's own, and clearing restores the reader's tree", async () => {
    const { source } = clusterSource();
    const hook = mount(source);
    const group = groupRowId(["shop"], "workloads");
    await waitFor(() => expect(hook.result.current.rows.some((row) => row.id === group)).toBe(true));
    act(() => hook.result.current.toggle(group));
    act(() => hook.result.current.toggle("shop/pods"));
    await waitFor(() => expect(hook.result.current.rows.some((row) => row.label === "pod/web-1")).toBe(true));
    const unfiltered = hook.result.current.rows.map((row) => [row.id, row.expanded]);

    hook.rerender({ query: "web" });
    act(() => hook.result.current.toggle(group));
    expect(hook.result.current.rows.map((row) => row.label)).toEqual(["shop", "Workloads"]);

    hook.rerender({ query: "" });
    expect(hook.result.current.rows.map((row) => [row.id, row.expanded])).toEqual(unfiltered);
  });

  test("a host answering kinds that are not a list of strings is reported, not rendered", async () => {
    const { source } = clusterSource([{ path: ["shop"], name: "shop", level: 0, kinds: 5 }]);
    const hook = mount(source);
    await waitFor(() =>
      expect(hook.result.current.rootFailure?.message).toBe(
        "The containers reading answered with a body this tree cannot render",
      ),
    );
    expect(hook.result.current.rows).toEqual([]);
  });

  test("a host answering a container path that is not a list of strings is reported, not rendered", async () => {
    const { source } = clusterSource([{ path: [1], name: "one", level: 0 }]);
    const hook = mount(source);
    await waitFor(() =>
      expect(hook.result.current.rootFailure?.message).toBe(
        "The containers reading answered with a body this tree cannot render",
      ),
    );
    expect(hook.result.current.rows).toEqual([]);
  });

  test("a group row asks for no read and offers no busy state", async () => {
    const { source, asked } = clusterSource();
    const hook = mount(source);
    const group = groupRowId(["shop"], "workloads");
    await waitFor(() => expect(hook.result.current.rows.some((row) => row.id === group)).toBe(true));
    const before = asked.length;
    act(() => hook.result.current.toggle(group));
    const row = hook.result.current.rows.find((candidate) => candidate.id === group);
    if (row === undefined) throw new Error("the group row is gone");
    expect(hook.result.current.isBusy(row)).toBe(false);
    expect(hook.result.current.failureFor(row)).toBeUndefined();
    expect(hook.result.current.objectFor(row)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked.length).toBe(before);
  });
});
