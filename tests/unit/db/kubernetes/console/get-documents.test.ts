/**
 * `get -o json` and `get -o yaml`: one row per object, documents written by Studio after redaction, the 500-object
 * bound and the 1 MiB cell, with the planted Secret marker absent from every cell.
 */
import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { getDocuments } from "@/lib/db/providers/platform/kubernetes/console/get-documents";
import { type KubectlStatement, parseKubectl } from "@/lib/db/providers/platform/kubernetes/console/parse";
import {
  consoleContext,
  listAnswer,
  markerSecret,
  routes,
  SECRET_MARKER,
  sentLines,
} from "../../../../helpers/kubernetes-console";
import { jsonAnswer, statusAnswer } from "../../../../helpers/kubernetes-transport";

type Get = Extract<KubectlStatement, { readonly command: "get" }>;

function get(text: string): Get {
  const parsed = parseKubectl(text);
  if (!parsed.ok || parsed.statement.command !== "get") throw new Error(`not a get: ${text}`);
  return parsed.statement;
}

const configMap = (name: string, extra: Record<string, unknown> = {}) => ({
  metadata: { name, namespace: "shop", managedFields: [{ manager: "x" }] },
  data: { key: "value" },
  ...extra,
});

describe("the list form", () => {
  test("one row per object, the resource's apiVersion and kind first, no managedFields", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/configmaps?limit=500": listAnswer([configMap("a"), configMap("b")]),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await getDocuments(context, get("get cm -o json"));
    expect(sentLines(transport)).toEqual(["GET /api/v1/namespaces/shop/configmaps?limit=500"]);
    expect(grid.fields).toEqual(["NAMESPACE", "NAME", "DOCUMENT"]);
    expect(grid.rows.map((row) => row.NAME)).toEqual(["a", "b"]);
    expect(JSON.parse(grid.rows[0].DOCUMENT as string)).toEqual({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "a", namespace: "shop" },
      data: { key: "value" },
    });
    expect(grid.warnings).toBeUndefined();
  });

  test("YAML is written by Studio, with the group's apiVersion", async () => {
    const answer = routes({
      "GET /apis/apps/v1/namespaces/shop/deployments?limit=500&labelSelector=app%3Dweb": listAnswer([
        { metadata: { name: "web", namespace: "shop" }, spec: { replicas: 2 } },
      ]),
    });
    const { context } = consoleContext(answer);
    const grid = await getDocuments(context, get("get deploy -l app=web -o yaml"));
    expect(parseYaml(grid.rows[0].DOCUMENT as string)).toEqual({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "web", namespace: "shop" },
      spec: { replicas: 2 },
    });
  });

  test.each(["json", "yaml"])(
    "a Secret list as %s never carries a value, stringData or the last-applied annotation",
    async (format) => {
      const answer = routes({
        "GET /api/v1/namespaces/shop/secrets?limit=500": jsonAnswer({
          kind: "SecretList",
          metadata: {},
          items: [{ ...markerSecret(), kind: undefined }],
        }),
      });
      const { context } = consoleContext(answer);
      const grid = await getDocuments(context, get(`kubectl get secrets -o ${format}`));
      expect(grid.rows).toHaveLength(1);
      expect(JSON.stringify(grid)).not.toContain(SECRET_MARKER);
      expect(grid.rows[0].DOCUMENT as string).toContain("team");
    },
  );

  test("a list of more than 500 objects answers the sentence to narrow it", async () => {
    const page = (start: number, count: number, next?: string) =>
      listAnswer(
        Array.from({ length: count }, (_unused, index) => configMap(`c-${start + index}`)),
        next === undefined ? {} : { continue: next },
      );
    const answer = routes({
      "GET /api/v1/namespaces/shop/configmaps?limit=500": page(0, 500, "500"),
      "GET /api/v1/namespaces/shop/configmaps?limit=1&continue=500": page(500, 1),
    });
    const { context } = consoleContext(answer);
    await expect(getDocuments(context, get("get cm -o yaml"))).rejects.toThrow(
      "The list holds more than 500 objects, the most -o json and -o yaml show",
    );
    const exact = consoleContext(routes({ "GET /api/v1/namespaces/shop/configmaps?limit=500": page(0, 500) }));
    expect((await getDocuments(exact.context, get("get cm -o yaml"))).rows).toHaveLength(500);
  });

  test("a document over 1 MiB is replaced by a sentence and a warning; one at 1 MiB is shown", async () => {
    const big = configMap("big", { data: { key: "x".repeat(1024 * 1024) } });
    const answer = routes({
      "GET /api/v1/namespaces/shop/configmaps?limit=500": listAnswer([big, configMap("small")]),
    });
    const { context } = consoleContext(answer);
    const grid = await getDocuments(context, get("get cm -o json"));
    expect(grid.rows[0].DOCUMENT).toBe(
      "This document is larger than 1 MiB, the most one cell holds, so it is not shown; read the object with kubectl describe, or narrow -o json to fewer objects.",
    );
    expect(grid.rows[1].DOCUMENT as string).toContain('"small"');
    expect(grid.warnings).toEqual([
      { message: "1 document is larger than 1 MiB and not shown; each such cell says so." },
    ]);
    const twoBig = consoleContext(
      routes({ "GET /api/v1/namespaces/shop/configmaps?limit=500": listAnswer([big, big]) }),
    );
    expect((await getDocuments(twoBig.context, get("get cm -o json"))).warnings?.[0].message).toBe(
      "2 documents are larger than 1 MiB and not shown; each such cell says so.",
    );
  });

  test("a document exactly at 1 MiB is shown", async () => {
    const shell = JSON.stringify(
      { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "edge" }, data: { key: "" } },
      null,
      2,
    );
    const room = 1024 * 1024 - new TextEncoder().encode(shell).length;
    const edge = { metadata: { name: "edge" }, data: { key: "y".repeat(room) } };
    const { context } = consoleContext(
      routes({ "GET /api/v1/namespaces/shop/configmaps?limit=500": listAnswer([edge]) }),
    );
    const grid = await getDocuments(context, get("get cm -o json"));
    expect(new TextEncoder().encode(grid.rows[0].DOCUMENT as string).length).toBe(1024 * 1024);
    expect(grid.warnings).toBeUndefined();
  });
});

describe("the named form", () => {
  test("one JSON read per name; a Secret by name is redacted", async () => {
    const answer = routes({ "GET /api/v1/namespaces/shop/secrets/db": jsonAnswer(markerSecret()) });
    const { context, transport } = consoleContext(answer);
    const grid = await getDocuments(context, get("kubectl get secret db -o yaml"));
    expect(sentLines(transport)).toEqual(["GET /api/v1/namespaces/shop/secrets/db"]);
    expect(grid.rows[0]).toMatchObject({ NAMESPACE: "shop", NAME: "db" });
    expect(JSON.stringify(grid)).not.toContain(SECRET_MARKER);
  });

  test("--ignore-not-found skips a missing object; without it the statement fails", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/configmaps/gone": statusAnswer(404, "NotFound"),
      "GET /api/v1/namespaces/shop/configmaps/here": jsonAnswer(configMap("here")),
    });
    const skipping = consoleContext(answer);
    expect(
      (await getDocuments(skipping.context, get("get cm gone here -o json --ignore-not-found"))).rows,
    ).toHaveLength(1);
    const failing = consoleContext(answer);
    await expect(getDocuments(failing.context, get("get cm gone -o json"))).rejects.toThrow("(404 Not Found)");
  });

  test("a cluster-scoped object has no namespace", async () => {
    const answer = routes({ "GET /api/v1/nodes/n1": jsonAnswer({ metadata: { name: "n1" } }) });
    const { context } = consoleContext(answer);
    expect((await getDocuments(context, get("get node n1 -o json"))).rows[0]).toMatchObject({
      NAMESPACE: null,
      NAME: "n1",
    });
  });
});
