/**
 * Kubernetes provider, end to end, on what real API servers answered.
 *
 * The real provider runs whole: the connection rules, the request allowlist, the client, discovery, the tree, the YAML
 * view, the console and every redaction. Only the server is replayed: tests/helpers/kubernetes-replay.ts hands the
 * provider a transport at its seam that answers each request from the capture of tests/fixtures/kubernetes/<set>/,
 * by method, path and sorted query (and body, for a POST), and answers a request nobody recorded with a `text/plain`
 * 404. `mock.module()` is not used.
 *
 * The captures were made by tests/live/kubernetes-evidence.ts from the throwaway k3s clusters of docker/kubernetes/,
 * seeded with docker/kubernetes/sample.yaml: `v1.35.5` (every persona), `v1.30.14` (the documented floor) and
 * `v1.29.15` (best effort). The manifest of each set names the image, the server version and the Studio commit.
 * Three answers no supported cluster gives are BUILT here instead, as tests/fixtures/kubernetes/README.md says: a
 * server that answers discovery only in its unaggregated form, a list answered as plain JSON where a Table was asked
 * for (the Accept fallback a 406 would otherwise force), and a group version marked Stale.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryError } from "@/lib/db/errors";
import { DISCOVERY_FLOOR_SENTENCE } from "@/lib/db/providers/platform/kubernetes/discovery";
import { forbiddenSentence } from "@/lib/db/providers/platform/kubernetes/errors";
import { KubernetesProvider } from "@/lib/db/providers/platform/kubernetes/index";
import { KUBERNETES_KIND_TABLE } from "@/lib/db/providers/platform/kubernetes/kinds";
import type { KindCount } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { runAsTheQueryRoute as run } from "../../live/kubernetes-evidence";
import { gridShows, READER_STATEMENT_FACTS, READER_STATEMENTS } from "../../live/kubernetes-evidence-plan";
import { discoveryList, GROUPS_DISCOVERY, resource } from "../../helpers/kubernetes-discovery";
import { fakeCluster } from "../../helpers/kubernetes-cluster";
import { kubernetesConnection } from "../../helpers/kubernetes-connection";
import { KUBERNETES_SAMPLE_MARKERS as M } from "../../helpers/kubernetes-markers";
import { readCapture, replayTransport } from "../../helpers/kubernetes-replay";
import { jsonAnswer, recordingKubernetesTransport, testSeams } from "../../helpers/kubernetes-transport";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

const FIXTURES = path.resolve(import.meta.dir, "../../fixtures/kubernetes");
const SECRET_VALUE_BASE64 = Buffer.from(M.secretValue, "utf8").toString("base64");
const REVIEWS = "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews";

type Persona = "admin" | "reader" | "viewer" | "shop-only" | "studio-reader";

/**
 * A provider that replays one persona's capture. The connection matches the capture's in what reaches a request: the
 * token personas default to the namespace shop, the admin to `default`. The token and the TLS panel reach no request
 * line, so the test connection's own stand in for them.
 */
function replayed(set: string, persona: Persona) {
  const capture = readCapture(path.join(FIXTURES, set, `${persona}.json`));
  const replay = replayTransport(capture.exchanges);
  const overrides: Partial<DatabaseConnection> = persona === "admin" ? {} : { database: "shop" };
  const provider = new KubernetesProvider(
    kubernetesConnection(overrides),
    { queryTimeout: 30_000 },
    {
      createTransport: replay.factory,
    },
  );
  return { provider, replay, capture };
}

function holdsSecretValue(text: string): boolean {
  return text.includes(M.secretValue) || text.includes(SECRET_VALUE_BASE64);
}

describe("v1.35.5, the reader: every read a user makes, on a real server's answers", () => {
  test("the capture holds the planted Secret value, so its absence below is redaction and not an empty fixture", () => {
    const raw = readFileSync(path.join(FIXTURES, "v1.35.5", "reader.json"), "utf8");
    expect(raw).toContain(SECRET_VALUE_BASE64);
  });

  test("connects, warns of the cluster-wide Secret list, and lists Cluster first, then the namespaces", async () => {
    const { provider, replay } = replayed("v1.35.5", "reader");
    await provider.connect();
    expect(
      provider
        .connectWarnings()
        .map((warning) => warning.message)
        .join("\n"),
    ).toContain("read every Secret value in the cluster (list secrets)");
    const containers = await provider.listContainers();
    expect(containers[0].path).toEqual(["Cluster"]);
    const names = containers.map((container) => container.path[0]);
    for (const namespace of ["analytics", "kube-system", "probe-auth", "restricted", "shop"]) {
      expect(names).toContain(namespace);
    }
    expect(containers.find((container) => container.path[0] === "shop")?.isSessionDefault).toBe(true);
    expect(replay.missed).toEqual([]);
    await provider.disconnect();
  });

  test("the namespace shop counts the sample data's objects, and lists the planted Secret by name only", async () => {
    const { provider, replay } = replayed("v1.35.5", "reader");
    await provider.connect();
    const counts = await provider.countObjects(["shop"]);
    expect(counts.deployments).toEqual({ count: 2 });
    expect(counts.statefulsets).toEqual({ count: 1 });
    expect(counts.daemonsets).toEqual({ count: 1 });
    expect(counts.cronjobs).toEqual({ count: 1 });
    expect(counts.secrets).toEqual({ count: 1 });
    expect(counts.services).toEqual({ count: 2 });
    const secrets = await provider.listObjects(["shop"], "secrets");
    expect(secrets.map((object) => object.path)).toEqual([["shop", `secret/${M.secretName}`]]);
    expect(holdsSecretValue(JSON.stringify(secrets))).toBe(false);
    const types = await provider.listObjects(["shop"], "customresources");
    expect(types.map((object) => object.path.at(-1))).toContain("widgets.probe.libredb.dev");
    expect(replay.missed).toEqual([]);
    await provider.disconnect();
  });

  test("the YAML view: a ConfigMap shows its data, a Secret its name and type with no data key and no value", async () => {
    const { provider, replay } = replayed("v1.35.5", "reader");
    await provider.connect();
    const configMap = JSON.stringify(await provider.readObjectSource(["shop", "configmap/shop-config"], "configmaps"));
    expect(configMap).toContain(M.configMapValue);
    const secret = JSON.stringify(await provider.readObjectSource(["shop", `secret/${M.secretName}`], "secrets"));
    expect(secret).toContain(M.secretName);
    expect(secret).toContain("type: Opaque");
    expect(secret).not.toContain(M.secretKey);
    expect(holdsSecretValue(secret)).toBe(false);
    expect(secret).not.toContain("last-applied-configuration");
    expect(replay.missed).toEqual([]);
    await provider.disconnect();
  });

  test.each([...READER_STATEMENTS])("%s answers its grid, with no Secret value in it", async (text) => {
    const { provider, replay } = replayed("v1.35.5", "reader");
    await provider.connect();
    const result = await run(provider, text);
    expect(result.fields.length).toBeGreaterThan(0);
    expect({ text, shows: gridShows(result.rows, READER_STATEMENT_FACTS[text]) }).toEqual({ text, shows: true });
    expect(holdsSecretValue(JSON.stringify(result))).toBe(false);
    expect(replay.missed).toEqual([]);
    await provider.disconnect();
  });

  test("the shared object-surface conformance holds on the namespace shop as the server answered it", async () => {
    // The counts and the containers are pinned in the tests above; what this run adds over the synthesized
    // conformance of tests/unit/db/kubernetes/provider-surface.test.ts is a real server's objects through every
    // listing, bulk description, description and YAML view, so the expectation is read off the same replay.
    const first = replayed("v1.35.5", "reader");
    await first.provider.connect();
    const containers = (await first.provider.listContainers()).map((container) => container.path);
    const counts: Record<string, KindCount> = await first.provider.countObjects(["shop"]);
    await first.provider.disconnect();
    const kinds = Object.fromEntries(
      Object.entries(counts).flatMap(([kind, count]) => ("count" in count ? [[kind, count.count]] : [])),
    );
    const emptyKinds = Object.fromEntries(
      KUBERNETES_KIND_TABLE.filter((entry) => kinds[entry.id] === 0).map((entry) => [
        entry.id,
        `The sample data of docker/kubernetes/sample.yaml creates no ${entry.labelPlural} in the namespace shop.`,
      ]),
    );
    const { provider, replay } = replayed("v1.35.5", "reader");
    await provider.connect();
    await assertObjectSurface(provider, {
      containers,
      container: ["shop"],
      kinds,
      sampleObject: { path: ["shop", "deployment/web"], kind: "deployments" },
      absentSource: { path: ["shop", "pod/does-not-exist"], kind: "pods" },
      emptyKinds,
      noColumnKinds: true,
    });
    expect(replay.missed).toEqual([]);
    await provider.disconnect();
  });
});

describe("v1.35.5, the other personas", () => {
  test("the admin's connect sends the six self access reviews, each once", async () => {
    const { provider, replay } = replayed("v1.35.5", "admin");
    await provider.connect();
    expect(replay.asked.filter((key) => key.startsWith(`${REVIEWS} `))).toHaveLength(6);
    expect(
      provider
        .connectWarnings()
        .map((warning) => warning.message)
        .join("\n"),
    ).toContain("do anything to every resource (* on *)");
    await provider.disconnect();
  });

  test("the viewer meets a lock on Secrets, in Studio's own sentence, in the tree and in the console", async () => {
    const { provider, replay } = replayed("v1.35.5", "viewer");
    await provider.connect();
    const sentence = forbiddenSentence({ verb: "list", resource: "secrets", group: "", namespace: "shop" });
    expect(await provider.countObjects(["shop"])).toMatchObject({ secrets: { unavailable: sentence } });
    const refused = await run(provider, "kubectl get secrets -n shop").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(QueryError);
    expect((refused as QueryError).message).toBe(sentence);
    expect(replay.missed).toEqual([]);
    await provider.disconnect();
  });

  test("shop-only may not list namespaces: Cluster and shop alone, the notice, and the console in shop", async () => {
    const { provider, replay } = replayed("v1.35.5", "shop-only");
    await provider.connect();
    expect(
      provider
        .connectWarnings()
        .map((warning) => warning.message)
        .join("\n"),
    ).toContain("may not list namespaces");
    expect((await provider.listContainers()).map((container) => container.path)).toEqual([["Cluster"], ["shop"]]);
    expect((await run(provider, "kubectl get pods")).rows.length).toBeGreaterThan(0);
    expect(replay.missed).toEqual([]);
    await provider.disconnect();
  });

  test("studio-reader reads nodes and is refused cluster roles", async () => {
    const { provider, replay } = replayed("v1.35.5", "studio-reader");
    await provider.connect();
    const counts = await provider.countObjects(["Cluster"]);
    expect(counts.nodes).toEqual({ count: 1 });
    expect(counts.clusterroles).toMatchObject({ unavailable: expect.any(String) });
    expect(replay.missed).toEqual([]);
    await provider.disconnect();
  });
});

describe("the documented floor and best effort", () => {
  test.each([
    ["v1.30.14", "v=v2;"],
    ["v1.29.15", "v=v2beta1;"],
  ])("%s answers aggregated discovery as %s and reads pods", async (set, version) => {
    const { provider, replay, capture } = replayed(set, "reader");
    const core = capture.exchanges.find((exchange) => exchange.request.path === "/api");
    expect(core?.response.contentType).toContain(version);
    await provider.connect();
    expect((await run(provider, "kubectl get pods -n shop")).rows.length).toBeGreaterThan(0);
    expect(replay.missed).toEqual([]);
    await provider.disconnect();
  });
});

describe("answers no supported cluster gives, built here", () => {
  test("a server that answers discovery only unaggregated is refused with the floor's sentence", async () => {
    const transport = recordingKubernetesTransport((request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api") return jsonAnswer({ kind: "APIVersions", versions: ["v1"] });
      if (pathname === "/apis") return jsonAnswer({ kind: "APIGroupList", groups: [] });
      return jsonAnswer({});
    });
    const provider = new KubernetesProvider(kubernetesConnection(), { queryTimeout: 30_000 }, testSeams(transport));
    await expect(provider.connect()).rejects.toThrow(DISCOVERY_FLOOR_SENTENCE);
  });

  test("a list answered as plain JSON where a Table was asked for reads as Name and Created", async () => {
    const widgets = {
      kind: "WidgetList",
      apiVersion: "probe.libredb.dev/v1",
      metadata: { resourceVersion: "7" },
      items: [{ metadata: { name: "widget-a", namespace: "shop", creationTimestamp: "2026-10-10T11:00:00Z" } }],
    };
    const server = fakeCluster({ lists: { "/api/v1/namespaces": [{ name: "shop" }] } });
    const transport = recordingKubernetesTransport((request, line) =>
      new URL(request.url).pathname === "/apis/probe.libredb.dev/v1/namespaces/shop/widgets"
        ? jsonAnswer(widgets)
        : server(request, line),
    );
    const provider = new KubernetesProvider(
      kubernetesConnection({ database: "shop" }),
      { queryTimeout: 30_000 },
      testSeams(transport),
    );
    await provider.connect();
    const result = await run(provider, "kubectl get widgets -n shop");
    expect(result.fields.slice(0, 2)).toEqual(["Name", "Created"]);
    expect(result.rows[0]).toMatchObject({ Name: "widget-a" });
    const asked = transport.requests.find((request) => request.url.includes("/widgets"));
    expect(asked?.headers?.accept).toContain(",application/json");
    await provider.disconnect();
  });

  test("a Stale group version is passed over for the next version the group lists", async () => {
    const widgets = resource("widgets", "Widget", "Namespaced", { shortNames: ["wd"] });
    const stale = discoveryList([
      {
        name: "probe.libredb.dev",
        versions: [
          { version: "v2", freshness: "Stale", resources: [widgets] },
          { version: "v1", resources: [widgets] },
        ],
      },
    ]) as { readonly items: readonly unknown[] };
    const base = GROUPS_DISCOVERY as { readonly items: readonly { readonly metadata: { readonly name?: string } }[] };
    const groups = {
      ...GROUPS_DISCOVERY,
      items: [...base.items.filter((group) => group.metadata.name !== "probe.libredb.dev"), ...stale.items],
    };
    const server = fakeCluster({
      groups,
      lists: {
        "/api/v1/namespaces": [{ name: "shop" }],
        "/apis/probe.libredb.dev/v1/namespaces/shop/widgets": [{ name: "widget-a" }],
      },
    });
    const transport = recordingKubernetesTransport(server);
    const provider = new KubernetesProvider(
      kubernetesConnection({ database: "shop" }),
      { queryTimeout: 30_000 },
      testSeams(transport),
    );
    await provider.connect();
    await run(provider, "kubectl get widgets -n shop");
    const lines = transport.calls.map((call) => call.method);
    expect(lines.some((line) => line.startsWith("GET /apis/probe.libredb.dev/v1/namespaces/shop/widgets?"))).toBe(true);
    expect(lines.some((line) => line.includes("/probe.libredb.dev/v2/"))).toBe(false);
    await provider.disconnect();
  });
});
