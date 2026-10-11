/**
 * Every console read passes its answer through the one redaction walk before a cell, a row or a document is made of
 * it. A Secret pin that greps a grid cannot show that, because most grids never print data or annotations; an answer
 * nested deeper than the walk follows can, since only the walk refuses it.
 */
import { describe, expect, test } from "bun:test";
import { runKubectl } from "@/lib/db/providers/platform/kubernetes/console/run";
import { consoleContext, routes, tableAnswer, textAnswer } from "../../../../helpers/kubernetes-console";
import { CORE_DISCOVERY, GROUPS_DISCOVERY } from "../../../../helpers/kubernetes-discovery";
import { jsonAnswer, type KubernetesAnswerFn } from "../../../../helpers/kubernetes-transport";

const NESTED_TOO_DEEP = /nested deeper than any Kubernetes response/;

/** An object 12 `items` deep, past the walk's cap of 8 and far below the client's 1,000 levels. */
function deepObject(): unknown {
  let value: unknown = { kind: "Pod", metadata: { name: "web" } };
  for (let level = 0; level < 12; level += 1) value = { items: [value] };
  return value;
}

/** What `kubectl describe pod web` reads, each read answered plainly except the one whose line starts with `deep`. */
function describeAnswer(deep?: string): KubernetesAnswerFn {
  return (_request, line) => {
    if (deep !== undefined && line.startsWith(deep)) return jsonAnswer(deepObject());
    if (line === "GET /api") return jsonAnswer(CORE_DISCOVERY);
    if (line === "GET /apis") return jsonAnswer(GROUPS_DISCOVERY);
    if (line === "GET /api/v1/namespaces/shop/pods/web?includeObject=None") {
      return tableAnswer([{ name: "Name" }], [{ cells: ["web"] }]);
    }
    if (line === "GET /api/v1/namespaces/shop/pods/web") {
      return jsonAnswer({ kind: "Pod", metadata: { name: "web", namespace: "shop", uid: "u" } });
    }
    if (line.startsWith("GET /api/v1/namespaces/shop/events?")) return tableAnswer([{ name: "Name" }], []);
    return textAnswer("404 page not found", 404);
  };
}

describe("every console read goes through the redaction walk", () => {
  test.each([
    ["get, the list form", "kubectl get pods"],
    ["get, the named form", "kubectl get pods web"],
    ["get -o yaml", "kubectl get pods -o yaml"],
    ["describe", "kubectl describe pod web"],
    ["top pod", "kubectl top pod"],
    ["top node", "kubectl top node"],
    ["events", "kubectl events"],
    ["logs of a named pod", "kubectl logs web"],
    ["logs of a selector's pods", "kubectl logs -l app=web"],
    ["logs of a workload's pods", "kubectl logs deploy/web"],
  ])("%s refuses an answer nested past the walk's cap", async (_label, text) => {
    const { context } = consoleContext((_request, line) => {
      if (line === "GET /api") return jsonAnswer(CORE_DISCOVERY);
      if (line === "GET /apis") return jsonAnswer(GROUPS_DISCOVERY);
      return jsonAnswer(deepObject());
    });
    await expect(runKubectl(context, text)).rejects.toThrow(NESTED_TOO_DEEP);
  });

  test.each([
    ["the events list it reads for its Events rows", "GET /api/v1/namespaces/shop/events?"],
    ["its Table read", "GET /api/v1/namespaces/shop/pods/web?includeObject=None"],
  ])("describe refuses %s nested past the walk's cap while its other reads answer plainly", async (_label, deep) => {
    const { context } = consoleContext(describeAnswer(deep));
    await expect(runKubectl(context, "kubectl describe pod web")).rejects.toThrow(NESTED_TOO_DEEP);
  });

  test("describe answers when none of its reads is deep, so the cases above fail on the depth alone", async () => {
    const { context } = consoleContext(describeAnswer());
    await expect(runKubectl(context, "kubectl describe pod web")).resolves.toBeDefined();
  });

  test("get -w refuses a watch event nested past the walk's cap", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods?limit=500&includeObject=None": tableAnswer(
        [{ name: "Name" }],
        [{ cells: ["web"] }],
      ),
      "GET /api/v1/namespaces/shop/pods?watch=1&allowWatchBookmarks=true&resourceVersion=100&timeoutSeconds=10&includeObject=None":
        textAnswer(`${JSON.stringify({ type: "ADDED", object: deepObject() })}\n`),
    });
    const { context } = consoleContext(answer);
    await expect(runKubectl(context, "kubectl get pods -w")).rejects.toThrow(NESTED_TOO_DEEP);
  });
});
