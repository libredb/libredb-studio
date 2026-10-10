/**
 * One console run: every command reaches its reader, the paging clause reaches the list form only, a refused
 * statement sends nothing, and a type the server stopped serving reads discovery again once and runs once more.
 */
import { describe, expect, test } from "bun:test";
import { PAGING_CLAUSE_SENTENCE } from "@/lib/db/providers/platform/kubernetes/console/paging";
import { runKubectl } from "@/lib/db/providers/platform/kubernetes/console/run";
import {
  consoleContext,
  listAnswer,
  routes,
  sentLines,
  tableAnswer,
  textAnswer,
} from "../../../../helpers/kubernetes-console";
import { jsonAnswer } from "../../../../helpers/kubernetes-transport";

const NAME = [{ name: "Name" }];

const CLUSTER = routes({
  "GET /api/v1/namespaces/shop/pods?limit=2&includeObject=None": tableAnswer(NAME, [
    { cells: ["a"] },
    { cells: ["b"] },
  ]),
  "GET /api/v1/namespaces/shop/pods?limit=500&includeObject=None": tableAnswer(NAME, [{ cells: ["a"] }]),
  "GET /api/v1/namespaces/shop/pods/a?includeObject=None": tableAnswer(NAME, [{ cells: ["a"] }]),
  "GET /api/v1/namespaces/shop/pods/a": jsonAnswer({
    metadata: { name: "a", uid: "u" },
    spec: { containers: [{ name: "app" }] },
  }),
  "GET /api/v1/namespaces/shop/pods?watch=1&allowWatchBookmarks=true&resourceVersion=100&timeoutSeconds=10&includeObject=None":
    textAnswer(""),
  "GET /api/v1/namespaces/shop/pods/a/log?container=app&tailLines=500&limitBytes=1048576&timestamps=true":
    textAnswer("2026-10-10T11:00:00Z hi\n"),
  "GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=involvedObject.kind%3DPod%2CinvolvedObject.name%3Da%2CinvolvedObject.namespace%3Dshop%2CinvolvedObject.uid%3Du":
    listAnswer([]),
  "GET /api/v1/namespaces/shop/events?limit=500": listAnswer([]),
  "GET /apis/metrics.k8s.io/v1beta1/namespaces/shop/pods?limit=500": listAnswer([]),
  "GET /version": jsonAnswer({ gitVersion: "v1.35.5" }),
  "GET /openapi/v3": jsonAnswer({ paths: { "api/v1": { serverRelativeURL: "/openapi/v3/api/v1?hash=AB" } } }),
  "GET /openapi/v3/api/v1?hash=AB": jsonAnswer({
    components: {
      schemas: {
        Pod: { type: "object", "x-kubernetes-group-version-kind": [{ group: "", version: "v1", kind: "Pod" }] },
      },
    },
  }),
  "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews": jsonAnswer({ status: { allowed: true } }, 201),
  "POST /apis/authentication.k8s.io/v1/selfsubjectreviews": jsonAnswer(
    { status: { userInfo: { username: "u" } } },
    201,
  ),
});

describe("runKubectl", () => {
  test.each([
    ["kubectl get pods\n# libredb:page offset=1 limit=1", ["Name"], [{ Name: "b" }]],
    ["get pods", ["Name"], [{ Name: "a" }]],
    ["get pod a", ["Name"], [{ Name: "a" }]],
    ["get pod a -o json", ["NAMESPACE", "NAME", "DOCUMENT"], undefined],
    ["get pods -w", ["EVENT", "Name"], [{ EVENT: null, Name: "a" }]],
    ["describe pod a", ["SECTION", "FIELD", "VALUE"], undefined],
    [
      "logs a",
      ["TIME", "POD", "CONTAINER", "LINE"],
      [{ TIME: "2026-10-10T11:00:00Z", POD: "a", CONTAINER: "app", LINE: "hi" }],
    ],
    ["top pod", ["NAME", "CPU(cores)", "MEMORY(bytes)"], []],
    ["events", ["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"], []],
    ["api-resources -o name --api-group=batch", ["NAME"], [{ NAME: "cronjobs.batch" }, { NAME: "jobs.batch" }]],
    ["api-versions", ["APIVERSION"], undefined],
    ["explain pods", ["FIELD", "TYPE", "DESCRIPTION"], [{ FIELD: "Pod", TYPE: "<Pod>", DESCRIPTION: "" }]],
    ["auth can-i list pods", ["ANSWER", "REASON"], [{ ANSWER: "yes", REASON: "" }]],
    [
      "auth whoami",
      ["ATTRIBUTE", "VALUE"],
      [
        { ATTRIBUTE: "Username", VALUE: "u" },
        { ATTRIBUTE: "Groups", VALUE: "[]" },
      ],
    ],
    ["version", ["FIELD", "VALUE"], undefined],
  ])("%j", async (text, fields, rows) => {
    const { context } = consoleContext(CLUSTER);
    const grid = await runKubectl(context, text);
    expect(grid.fields).toEqual(fields);
    if (rows !== undefined) expect(grid.rows).toEqual(rows);
  });

  test("a refused statement and a paging line on any other statement send nothing", async () => {
    const { context, transport } = consoleContext(CLUSTER);
    await expect(runKubectl(context, "kubectl get all -n shop")).rejects.toThrow("one type per statement in v1");
    await expect(runKubectl(context, "describe pod a\n# libredb:page offset=0 limit=5")).rejects.toThrow(
      PAGING_CLAUSE_SENTENCE,
    );
    expect(transport.calls).toEqual([]);
  });

  test("a type the server stopped serving reads discovery again once and runs once more", async () => {
    let served = false;
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods/a?includeObject=None": () => {
        if (served) return tableAnswer(NAME, [{ cells: ["a"] }]);
        served = true;
        return textAnswer("404 page not found", 404);
      },
    });
    const { context, transport } = consoleContext(answer);
    expect((await runKubectl(context, "get pod a")).rows).toEqual([{ Name: "a" }]);
    expect(transport.calls.map((call) => call.method)).toEqual([
      "GET /api",
      "GET /apis",
      "GET /api/v1/namespaces/shop/pods/a?includeObject=None",
      "GET /api",
      "GET /apis",
      "GET /api/v1/namespaces/shop/pods/a?includeObject=None",
    ]);
    expect(sentLines(transport)).toHaveLength(2);
  });
});
