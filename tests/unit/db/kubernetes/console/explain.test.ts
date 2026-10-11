/**
 * `explain` from OpenAPI v3: the index read as JSON whatever its content type, the hashed group document cached by
 * its URL, kubectl's type words, --recursive with full dotted paths and no descent into a schema that repeats, the
 * 4 MiB bound at its edge, --api-version, and the sentences for a field, a document or a schema that is not there.
 */
import { describe, expect, test } from "bun:test";
import type { NodeRequest, NodeResponse } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { explain } from "@/lib/db/providers/platform/kubernetes/console/explain";
import { type KubectlStatement, parseKubectl } from "@/lib/db/providers/platform/kubernetes/console/parse";
import { consoleContext, routes, textAnswer } from "../../../../helpers/kubernetes-console";
import { jsonAnswer } from "../../../../helpers/kubernetes-transport";

type Explain = Extract<KubectlStatement, { readonly command: "explain" }>;

function explainOf(text: string): Explain {
  const parsed = parseKubectl(text);
  if (!parsed.ok || parsed.statement.command !== "explain") throw new Error(`not explain: ${text}`);
  return parsed.statement;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const CORE_DOCUMENT = {
  components: {
    schemas: {
      "io.k8s.api.core.v1.Pod": {
        description: "Pod is a collection of containers.",
        type: "object",
        properties: {
          apiVersion: { type: "string", description: "APIVersion defines the versioned schema." },
          kind: { type: "string", description: "Kind is a string value." },
          metadata: {
            allOf: [ref("io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta")],
            default: {},
            description: "Standard object's metadata.",
          },
          spec: {
            allOf: [ref("io.k8s.api.core.v1.PodSpec")],
            description: "Specification of the desired behavior of the pod.",
          },
        },
        "x-kubernetes-group-version-kind": [{ group: "", kind: "Pod", version: "v1" }],
      },
      "io.k8s.api.core.v1.PodSpec": {
        type: "object",
        required: ["containers"],
        properties: {
          containers: {
            type: "array",
            items: { allOf: [ref("io.k8s.api.core.v1.Container")] },
            description: "List of containers.",
          },
          priority: { type: "integer", format: "int32", description: "The priority value." },
        },
      },
      "io.k8s.api.core.v1.Container": {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "Name of the container." },
          port: { "x-kubernetes-int-or-string": true, description: "A port." },
          resources: { allOf: [ref("io.k8s.api.core.v1.ResourceRequirements")], description: "Compute resources." },
        },
      },
      "io.k8s.api.core.v1.ResourceRequirements": {
        type: "object",
        properties: {
          limits: {
            type: "object",
            additionalProperties: ref("io.k8s.apimachinery.pkg.api.resource.Quantity"),
            description: "Limits.",
          },
        },
      },
      "io.k8s.apimachinery.pkg.api.resource.Quantity": { oneOf: [{ type: "string" }, { type: "number" }] },
      "io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta": {
        type: "object",
        properties: {
          labels: { type: "object", additionalProperties: { type: "string", default: "" }, description: "Labels." },
          creationTimestamp: { allOf: [ref("io.k8s.apimachinery.pkg.apis.meta.v1.Time")], description: "Created." },
        },
      },
      "io.k8s.apimachinery.pkg.apis.meta.v1.Time": { type: "string", format: "date-time" },
    },
  },
};

const WIDGET_DOCUMENT = {
  components: {
    schemas: {
      "dev.libredb.probe.v1.Widget": {
        type: "object",
        properties: { spec: ref("dev.libredb.probe.v1.Tree") },
        "x-kubernetes-group-version-kind": [{ group: "probe.libredb.dev", kind: "Widget", version: "v1" }],
      },
      "dev.libredb.probe.v1.Tree": {
        type: "object",
        description: "A tree.",
        properties: { child: ref("dev.libredb.probe.v1.Tree"), value: { type: "integer" } },
      },
    },
  },
};

const INDEX = {
  paths: {
    "api/v1": { serverRelativeURL: "/openapi/v3/api/v1?hash=ABC123" },
    "apis/probe.libredb.dev/v1": { serverRelativeURL: "/openapi/v3/apis/probe.libredb.dev/v1?hash=BEEF" },
  },
};

/** Answers a body past `maxResponseBytes` as the transport does: with a too-large failure. */
function capped(response: NodeResponse) {
  return (request: NodeRequest): NodeResponse => {
    if (Buffer.byteLength(response.text) > request.maxResponseBytes) throw new TransportError("too-large", "x");
    return response;
  };
}

function cluster(extra: Record<string, NodeResponse | ((request: NodeRequest) => NodeResponse)> = {}) {
  return routes({
    "GET /openapi/v3": textAnswer(JSON.stringify(INDEX)),
    "GET /openapi/v3/api/v1?hash=ABC123": capped(jsonAnswer(CORE_DOCUMENT)),
    "GET /openapi/v3/apis/probe.libredb.dev/v1?hash=BEEF": jsonAnswer(WIDGET_DOCUMENT),
    ...extra,
  });
}

describe("explain", () => {
  test("a resource: the index as text/plain, then the hashed group document; the resource and its fields", async () => {
    const { context, transport } = consoleContext(cluster());
    const grid = await explain(context, explainOf("kubectl explain pods"));
    expect(transport.calls.map((call) => call.method).slice(2)).toEqual([
      "GET /openapi/v3",
      "GET /openapi/v3/api/v1?hash=ABC123",
    ]);
    expect(grid.fields).toEqual(["FIELD", "TYPE", "DESCRIPTION"]);
    expect(grid.rows.map((row) => [row.FIELD, row.TYPE])).toEqual([
      ["Pod", "<Pod>"],
      ["apiVersion", "<string>"],
      ["kind", "<string>"],
      ["metadata", "<ObjectMeta>"],
      ["spec", "<PodSpec>"],
    ]);
    expect(grid.rows[0].DESCRIPTION).toBe("Pod is a collection of containers.");
  });

  test("a field path through an array: kubectl's type words and -required-", async () => {
    const { context } = consoleContext(cluster());
    const grid = await explain(context, explainOf("explain pods.spec.containers"));
    expect(grid.rows.map((row) => [row.FIELD, row.TYPE])).toEqual([
      ["Pod.spec.containers", "<[]Container> -required-"],
      ["name", "<string> -required-"],
      ["port", "<IntOrString>"],
      ["resources", "<ResourceRequirements>"],
    ]);
    expect(grid.rows[0].DESCRIPTION).toBe("List of containers.");
  });

  test("--recursive: every field below by its full dotted path", async () => {
    const { context } = consoleContext(cluster());
    const grid = await explain(context, explainOf("explain pods.metadata --recursive"));
    expect(grid.rows.map((row) => [row.FIELD, row.TYPE])).toEqual([
      ["Pod.metadata", "<ObjectMeta>"],
      ["metadata.creationTimestamp", "<string>"],
      ["metadata.labels", "<map[string]string>"],
    ]);
    const deep = await explain(context, explainOf("explain pods.spec --recursive"));
    expect(deep.rows.map((row) => row.FIELD)).toEqual([
      "Pod.spec",
      "spec.containers",
      "spec.containers.name",
      "spec.containers.port",
      "spec.containers.resources",
      "spec.containers.resources.limits",
      "spec.priority",
    ]);
    expect(deep.rows.find((row) => row.FIELD === "spec.containers.resources.limits")?.TYPE).toBe(
      "<map[string]Quantity>",
    );
  });

  test("a schema that refers back to itself is not descended into again", async () => {
    const { context } = consoleContext(cluster());
    const grid = await explain(context, explainOf("explain widgets --recursive"));
    expect(grid.rows.map((row) => [row.FIELD, row.TYPE])).toEqual([
      ["Widget", "<Widget>"],
      ["spec", "<Tree>"],
      ["spec.child", "<Tree>"],
      ["spec.value", "<integer>"],
    ]);
  });

  test("a type defined through itself, by array items or map values, answers a sentence, not a stack overflow", async () => {
    const sentence = "The server's OpenAPI document defines a type through itself, so explain cannot print it.";
    for (const loop of [
      { type: "array", items: ref("dev.libredb.probe.v1.Loop") },
      { type: "object", additionalProperties: ref("dev.libredb.probe.v1.Loop") },
    ]) {
      const document = {
        components: {
          schemas: {
            "dev.libredb.probe.v1.Widget": {
              type: "object",
              properties: { spec: ref("dev.libredb.probe.v1.Loop") },
              "x-kubernetes-group-version-kind": [{ group: "probe.libredb.dev", kind: "Widget", version: "v1" }],
            },
            "dev.libredb.probe.v1.Loop": loop,
          },
        },
      };
      const { context } = consoleContext(
        cluster({ "GET /openapi/v3/apis/probe.libredb.dev/v1?hash=BEEF": jsonAnswer(document) }),
      );
      for (const text of ["explain widgets", "explain widgets.spec", "explain widgets --recursive"])
        await expect(explain(context, explainOf(text))).rejects.toThrow(sentence);
    }
  });

  test("the group document is cached by its hashed URL: a second explain reads only the index", async () => {
    const { context, transport } = consoleContext(cluster());
    await explain(context, explainOf("explain pods"));
    const before = transport.calls.length;
    await explain(context, explainOf("explain pods.spec"));
    expect(transport.calls.slice(before).map((call) => call.method)).toEqual(["GET /openapi/v3"]);
    expect(context.explainCache.size).toBe(1);
  });

  test("a document of exactly 4 MiB is read; one byte more answers the sentence", async () => {
    const base = JSON.stringify({ ...CORE_DOCUMENT, padding: "" });
    const exact = JSON.stringify({ ...CORE_DOCUMENT, padding: "x".repeat(4 * 1024 * 1024 - Buffer.byteLength(base)) });
    expect(Buffer.byteLength(exact)).toBe(4 * 1024 * 1024);
    const atEdge = consoleContext(
      cluster({
        "GET /openapi/v3/api/v1?hash=ABC123": capped({
          status: 200,
          contentType: "application/json",
          retryAfter: null,
          text: exact,
        }),
      }),
    );
    expect((await explain(atEdge.context, explainOf("explain pods"))).rows[0].FIELD).toBe("Pod");
    const over = consoleContext(
      cluster({
        "GET /openapi/v3/api/v1?hash=ABC123": capped({
          status: 200,
          contentType: "application/json",
          retryAfter: null,
          text: `${exact} `,
        }),
      }),
    );
    await expect(explain(over.context, explainOf("explain pods"))).rejects.toThrow(
      "The OpenAPI document for api/v1 is larger than 4 MiB, the most explain reads.",
    );
  });

  test("--api-version picks the group version; one the server does not serve answers a sentence", async () => {
    const { context, transport } = consoleContext(cluster());
    await explain(context, explainOf("explain widgets --api-version=probe.libredb.dev/v1"));
    expect(transport.calls.at(-1)?.method).toBe("GET /openapi/v3/apis/probe.libredb.dev/v1?hash=BEEF");
    await expect(explain(context, explainOf("explain pods --api-version=v2"))).rejects.toThrow(
      "This server serves no such resource type in v2; list the types with kubectl api-resources.",
    );
  });

  test("an unknown field, a group the index does not list and a document without the kind each answer a sentence", async () => {
    const { context } = consoleContext(cluster());
    await expect(explain(context, explainOf("explain pods.spec.nope"))).rejects.toThrow('field "nope" does not exist');
    const unlisted = consoleContext(cluster({ "GET /openapi/v3": jsonAnswer({ paths: {} }) }));
    await expect(explain(unlisted.context, explainOf("explain deployments"))).rejects.toThrow(
      "The server's OpenAPI index lists no hashed document for apis/apps/v1, so explain cannot read it.",
    );
    const empty = consoleContext(
      cluster({ "GET /openapi/v3/api/v1?hash=ABC123": jsonAnswer({ components: { schemas: {} } }) }),
    );
    await expect(explain(empty.context, explainOf("explain configmaps"))).rejects.toThrow(
      "The OpenAPI document of v1 holds no schema for ConfigMap.",
    );
  });

  test("another failure of the document read is raised as it came", async () => {
    const failing = consoleContext(
      cluster({
        "GET /openapi/v3/api/v1?hash=ABC123": () => {
          throw new TransportError("tls", "certificate rejected");
        },
      }),
    );
    await expect(explain(failing.context, explainOf("explain pods"))).rejects.toThrow("certificate rejected");
  });

  test("more than 5,000 fields answer the sentence to explain a narrower path", async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 5_001 }, (_unused, index) => [`f${index}`, { type: "string" }]),
    );
    const wide = {
      components: {
        schemas: {
          "io.k8s.api.core.v1.Pod": {
            type: "object",
            properties,
            "x-kubernetes-group-version-kind": [{ group: "", kind: "Pod", version: "v1" }],
          },
        },
      },
    };
    const { context } = consoleContext(cluster({ "GET /openapi/v3/api/v1?hash=ABC123": jsonAnswer(wide) }));
    await expect(explain(context, explainOf("explain pods"))).rejects.toThrow(
      "explain reaches more than 5,000 fields here: explain a narrower field path, such as pods.spec, instead.",
    );
  });
});
