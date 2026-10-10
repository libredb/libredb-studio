import { describe, expect, test } from "bun:test";
import { AuthenticationError, QueryError } from "@/lib/db/errors";
import { ACCEPT_DISCOVERY, createKubernetesClient } from "@/lib/db/providers/platform/kubernetes/client";
import { readClusterEndpoint } from "@/lib/db/providers/platform/kubernetes/connection-options";
import {
  DISCOVERY_FLOOR_SENTENCE,
  DiscoveryCache,
  findResource,
  parseDiscovery,
  readDiscovery,
  requireSupportedServer,
  type ResourceIndex,
  VERSION_FLOOR_SENTENCE,
  withTypeRefresh,
} from "@/lib/db/providers/platform/kubernetes/discovery";
import { KubernetesRequestError } from "@/lib/db/providers/platform/kubernetes/errors";
import { expectCalls } from "../../../helpers/call-log";
import { kubernetesConnection } from "../../../helpers/kubernetes-connection";
import { CORE_DISCOVERY, discoveryList, GROUPS_DISCOVERY, resource } from "../../../helpers/kubernetes-discovery";
import {
  jsonAnswer,
  recordingKubernetesTransport,
  statusAnswer,
  testSeams,
} from "../../../helpers/kubernetes-transport";

const EMPTY_GROUPS = discoveryList([]);

/** What a 1.27 server answers: the beta aggregated form, and SelfSubjectReview only as v1beta1 and v1alpha1. */
const BETA = "apidiscovery.k8s.io/v2beta1";
const CORE_1_27 = discoveryList(
  [{ versions: [{ version: "v1", resources: [resource("pods", "Pod", "Namespaced")] }] }],
  BETA,
);
const GROUPS_1_27 = discoveryList(
  [
    {
      name: "authentication.k8s.io",
      versions: [
        { version: "v1", resources: [resource("tokenreviews", "TokenReview", "Cluster", { verbs: ["create"] })] },
        {
          version: "v1beta1",
          resources: [resource("selfsubjectreviews", "SelfSubjectReview", "Cluster", { verbs: ["create"] })],
        },
        {
          version: "v1alpha1",
          resources: [resource("selfsubjectreviews", "SelfSubjectReview", "Cluster", { verbs: ["create"] })],
        },
      ],
    },
  ],
  BETA,
);

describe("parseDiscovery", () => {
  test("indexes core first, then the groups, with scope, verbs, singular, kind, short names and categories", () => {
    const index = parseDiscovery(CORE_DISCOVERY, GROUPS_DISCOVERY);
    expect(index.dropped).toBe(0);
    expect(index.resources[0]).toEqual({
      group: "",
      version: "v1",
      resource: "pods",
      namespaced: true,
      verbs: ["get", "list", "watch"],
      singular: "pod",
      kind: "Pod",
      shortNames: ["po"],
      categories: ["all"],
    });
    expect(findResource(index, "apps", "deployments")?.shortNames).toEqual(["deploy"]);
    expect(findResource(index, "", "nodes")?.namespaced).toBe(false);
    expect(findResource(index, "apps", "pods")).toBeUndefined();
    expect(index.groupVersions.slice(0, 3)).toEqual(["v1", "apps/v1", "batch/v1"]);
  });

  test("a resource's version is the first of its group that lists it and is not Stale", () => {
    const groups = discoveryList([
      {
        name: "autoscaling",
        versions: [
          {
            version: "v3",
            freshness: "Stale",
            resources: [resource("horizontalpodautoscalers", "HorizontalPodAutoscaler", "Namespaced")],
          },
          { version: "v2", resources: [resource("horizontalpodautoscalers", "HorizontalPodAutoscaler", "Namespaced")] },
          { version: "v1", resources: [resource("horizontalpodautoscalers", "HorizontalPodAutoscaler", "Namespaced")] },
        ],
      },
    ]);
    const index = parseDiscovery(discoveryList([]), groups);
    expect(index.resources.map((entry) => `${entry.group}/${entry.version}/${entry.resource}`)).toEqual([
      "autoscaling/v2/horizontalpodautoscalers",
    ]);
    expect(index.groupVersions).toEqual(["autoscaling/v2", "autoscaling/v1"]);
  });

  test("the v2beta1 form of 1.28 and 1.29 is read the same way", () => {
    const beta = discoveryList(
      [{ versions: [{ version: "v1", resources: [resource("pods", "Pod", "Namespaced")] }] }],
      "apidiscovery.k8s.io/v2beta1",
    );
    expect(parseDiscovery(beta, EMPTY_GROUPS).resources.map((entry) => entry.resource)).toEqual(["pods"]);
  });

  test("an unaggregated answer is refused with the 1.30 floor sentence", () => {
    const legacy = { kind: "APIVersions", versions: ["v1"], serverAddressByClientCIDRs: [] };
    expect(() => parseDiscovery(legacy, EMPTY_GROUPS)).toThrow(QueryError);
    expect(() => parseDiscovery(legacy, EMPTY_GROUPS)).toThrow(DISCOVERY_FLOOR_SENTENCE);
    expect(() => parseDiscovery(CORE_DISCOVERY, { kind: "APIGroupList", groups: [] })).toThrow(
      DISCOVERY_FLOOR_SENTENCE,
    );
    expect(() => parseDiscovery(null, EMPTY_GROUPS)).toThrow(DISCOVERY_FLOOR_SENTENCE);
  });

  test("malformed groups, versions and resources are dropped and counted, never repaired", () => {
    const groups = {
      kind: "APIGroupDiscoveryList",
      apiVersion: "apidiscovery.k8s.io/v2",
      items: [
        {
          metadata: { name: "Bad_Group" },
          versions: [{ version: "v1", resources: [resource("things", "Thing", "Namespaced")] }],
        },
        "not an object",
        { metadata: { name: "good.example" }, versions: ["x", { version: "1", resources: [] }] },
        {
          metadata: { name: "ok.example" },
          versions: [
            {
              version: "v1",
              resources: [
                resource("Things", "Thing", "Namespaced"),
                resource("things", "Thing", "Somewhere" as never),
                resource("things", "9Thing", "Namespaced"),
                { ...resource("things", "Thing", "Namespaced"), singularResource: "Thing" },
                { ...resource("things", "Thing", "Namespaced"), verbs: ["GET"] },
                { ...resource("things", "Thing", "Namespaced"), shortNames: ["a b"] },
                { ...resource("things", "Thing", "Namespaced"), categories: "all" },
                { ...resource("things", "Thing", "Namespaced"), responseKind: null },
                7,
                { ...resource("gadgets", "Gadget", "Cluster"), singularResource: "", shortNames: null },
              ],
            },
          ],
        },
      ],
    };
    const index = parseDiscovery(discoveryList([]), groups);
    expect(index.resources.map((entry) => [entry.resource, entry.singular, entry.shortNames])).toEqual([
      ["gadgets", "gadgets", []],
    ]);
    expect(index.dropped).toBe(13);
  });

  test("the empty group comes only from /api: a nameless /apis item and a named /api item are dropped, not repaired", () => {
    const pods = [resource("pods", "Pod", "Namespaced")];
    const index = parseDiscovery(
      discoveryList([{ name: "apps", versions: [{ version: "v1", resources: pods }] }]),
      discoveryList([{ versions: [{ version: "v1", resources: pods }] }]),
    );
    expect(index).toEqual({ resources: [], groupVersions: [], dropped: 2 });
  });

  test("a body with no items and a group with no versions index nothing", () => {
    const index = parseDiscovery(
      { kind: "APIGroupDiscoveryList", apiVersion: "apidiscovery.k8s.io/v2" },
      {
        kind: "APIGroupDiscoveryList",
        apiVersion: "apidiscovery.k8s.io/v2",
        items: [{ metadata: { name: "x.example" } }],
      },
    );
    expect(index).toEqual({ resources: [], groupVersions: [], dropped: 0 });
  });
});

describe("readDiscovery", () => {
  test("two GETs with the aggregated Accept", async () => {
    const transport = recordingKubernetesTransport((_request, line) =>
      jsonAnswer(line.startsWith("GET /apis") ? GROUPS_DISCOVERY : CORE_DISCOVERY),
    );
    const endpoint = readClusterEndpoint(kubernetesConnection(), { queryTimeout: 30_000, appVersion: null });
    const client = createKubernetesClient(endpoint, testSeams(transport));
    const index = await readDiscovery(client, { signal: new AbortController().signal, timeoutMs: 5_000 });
    expect(findResource(index, "probe.libredb.dev", "widgets")?.shortNames).toEqual(["wd"]);
    expectCalls(transport, ["GET /api", "GET /apis"]);
    expect(transport.requests.map((request) => request.headers?.accept)).toEqual([ACCEPT_DISCOVERY, ACCEPT_DISCOVERY]);
  });

  test("a rejected token is exactly one request: /apis is read only after /api answered", async () => {
    const transport = recordingKubernetesTransport(() => statusAnswer(401, "Unauthorized"));
    const endpoint = readClusterEndpoint(kubernetesConnection(), { queryTimeout: 30_000, appVersion: null });
    const client = createKubernetesClient(endpoint, testSeams(transport));
    await expect(
      readDiscovery(client, { signal: new AbortController().signal, timeoutMs: 5_000 }),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expectCalls(transport, ["GET /api"]);
  });
});

describe("requireSupportedServer", () => {
  test("a 1.28 or later index, which lists authentication.k8s.io/v1 selfsubjectreviews, passes", () => {
    expect(() => requireSupportedServer(parseDiscovery(CORE_DISCOVERY, GROUPS_DISCOVERY))).not.toThrow();
  });

  test("a 1.27 server, which answers the beta aggregated form, is refused with the sentence naming the floor", () => {
    const index = parseDiscovery(CORE_1_27, GROUPS_1_27);
    expect(findResource(index, "authentication.k8s.io", "selfsubjectreviews")?.version).toBe("v1beta1");
    expect(() => requireSupportedServer(index)).toThrow(QueryError);
    expect(() => requireSupportedServer(index)).toThrow(VERSION_FLOOR_SENTENCE);
    expect(() => requireSupportedServer(parseDiscovery(CORE_DISCOVERY, EMPTY_GROUPS))).toThrow(VERSION_FLOOR_SENTENCE);
  });
});

describe("DiscoveryCache", () => {
  const index = (dropped: number): ResourceIndex => ({ resources: [], groupVersions: [], dropped });

  test("keeps an index for 10 minutes, reads again after, and on an explicit refresh", async () => {
    let now = 0;
    let loads = 0;
    const cache = new DiscoveryCache(
      async () => index(++loads),
      () => now,
    );
    expect((await cache.get()).dropped).toBe(1);
    now = 10 * 60 * 1000 - 1;
    expect((await cache.get()).dropped).toBe(1);
    now = 10 * 60 * 1000;
    expect((await cache.get()).dropped).toBe(2);
    expect((await cache.refresh()).dropped).toBe(3);
    cache.clear();
    expect((await cache.get()).dropped).toBe(4);
  });

  test("concurrent reads share one load, and a failed load is not kept", async () => {
    let loads = 0;
    let fail = true;
    const cache = new DiscoveryCache(
      async () => {
        loads += 1;
        if (fail) throw new Error("down");
        return index(loads);
      },
      () => 0,
    );
    await expect(Promise.all([cache.get(), cache.get()])).rejects.toThrow("down");
    expect(loads).toBe(1);
    fail = false;
    expect((await cache.get()).dropped).toBe(2);
  });
});

describe("withTypeRefresh", () => {
  const typeMissing = new KubernetesRequestError(
    'the server doesn\'t have a resource type "widgets"',
    404,
    undefined,
    true,
  );
  const objectMissing = new KubernetesRequestError("not found", 404, "NotFound", false);

  test("a text/plain 404 reads discovery again once and runs the work once more", async () => {
    let loads = 0;
    const cache = new DiscoveryCache(
      async () => ({ resources: [], groupVersions: [], dropped: ++loads }),
      () => 0,
    );
    let runs = 0;
    const result = await withTypeRefresh(cache, async (current) => {
      runs += 1;
      if (runs === 1) throw typeMissing;
      return current.dropped;
    });
    expect([result, runs, loads]).toEqual([2, 2, 2]);
  });

  test("a Status 404 refreshes nothing, and a second missing type is the answer", async () => {
    let loads = 0;
    const cache = new DiscoveryCache(
      async () => ({ resources: [], groupVersions: [], dropped: ++loads }),
      () => 0,
    );
    await expect(withTypeRefresh(cache, async () => Promise.reject(objectMissing))).rejects.toBe(objectMissing);
    expect(loads).toBe(1);
    await expect(withTypeRefresh(cache, async () => Promise.reject(typeMissing))).rejects.toBe(typeMissing);
    expect(loads).toBe(2);
  });
});
