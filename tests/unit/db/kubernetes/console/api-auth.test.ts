/**
 * api-resources, api-versions and version from discovery and `/version`; auth can-i and auth whoami as self reviews
 * whose bodies Studio builds as JSON, the subresource hint, and the rules list.
 */
import { describe, expect, test } from "bun:test";
import { apiResources, apiVersions, version } from "@/lib/db/providers/platform/kubernetes/console/api";
import { canI, whoami } from "@/lib/db/providers/platform/kubernetes/console/auth";
import { type KubectlStatement, parseKubectl } from "@/lib/db/providers/platform/kubernetes/console/parse";
import { consoleContext, routes } from "../../../../helpers/kubernetes-console";
import { jsonAnswer } from "../../../../helpers/kubernetes-transport";

function statement<C extends KubectlStatement["command"]>(
  text: string,
  command: C,
): Extract<KubectlStatement, { command: C }> {
  const parsed = parseKubectl(text);
  if (!parsed.ok || parsed.statement.command !== command) throw new Error(`not ${command}: ${text}`);
  return parsed.statement as Extract<KubectlStatement, { command: C }>;
}

describe("api-resources", () => {
  test("reads discovery afresh and prints kubectl's columns, by group then name", async () => {
    const { context, transport } = consoleContext(routes({}));
    const grid = await apiResources(context, statement("kubectl api-resources", "api-resources"));
    expect(transport.calls.map((call) => call.method)).toEqual(["GET /api", "GET /apis"]);
    expect(grid.fields).toEqual(["NAME", "SHORTNAMES", "APIVERSION", "NAMESPACED", "KIND"]);
    expect(grid.rows[0]).toEqual({
      NAME: "configmaps",
      SHORTNAMES: "cm",
      APIVERSION: "v1",
      NAMESPACED: "true",
      KIND: "ConfigMap",
    });
    const groups = grid.rows.map((row) => String(row.APIVERSION).split("/")[0]);
    expect(groups.indexOf("v1")).toBe(0);
    expect(grid.rows.find((row) => row.NAME === "deployments")).toEqual({
      NAME: "deployments",
      SHORTNAMES: "deploy",
      APIVERSION: "apps/v1",
      NAMESPACED: "true",
      KIND: "Deployment",
    });
  });

  test("--namespaced, --api-group and --verbs filter; -o wide adds verbs and categories; -o name names", async () => {
    const { context } = consoleContext(routes({}));
    const wide = await apiResources(
      context,
      statement("api-resources --api-group=apps --namespaced --verbs=list,watch -o wide", "api-resources"),
    );
    expect(wide.rows.map((row) => row.NAME)).toEqual([
      "controllerrevisions",
      "daemonsets",
      "deployments",
      "replicasets",
      "statefulsets",
    ]);
    expect(wide.rows[2]).toMatchObject({ VERBS: "[get list watch]", CATEGORIES: "all" });
    const cluster = await apiResources(
      context,
      statement("api-resources --namespaced=false --api-group=", "api-resources"),
    );
    expect(cluster.rows.map((row) => row.NAME)).toEqual(["namespaces", "nodes", "persistentvolumes"]);
    const names = await apiResources(context, statement("api-resources --api-group=batch -o name", "api-resources"));
    expect(names).toMatchObject({ fields: ["NAME"], rows: [{ NAME: "cronjobs.batch" }, { NAME: "jobs.batch" }] });
    const core = await apiResources(
      context,
      statement("api-resources --api-group= -o name --verbs=watch", "api-resources"),
    );
    expect(core.rows[0]).toEqual({ NAME: "configmaps" });
  });
});

describe("api-versions and version", () => {
  test("api-versions: every served group version, sorted", async () => {
    const { context } = consoleContext(routes({}));
    const grid = await apiVersions(context);
    expect(grid.fields).toEqual(["APIVERSION"]);
    const versions = grid.rows.map((row) => row.APIVERSION);
    expect(versions).toContain("v1");
    expect(versions).toContain("autoscaling/v1");
    expect([...versions].sort()).toEqual(versions);
  });

  test("version: Studio as the client, the server's build fields", async () => {
    const answer = routes({
      "GET /version": jsonAnswer({
        gitVersion: "v1.35.5+k3s1",
        gitCommit: "abc",
        buildDate: "2026-09-01",
        goVersion: "go1.25",
        platform: "linux/amd64",
      }),
    });
    const { context } = consoleContext(answer);
    expect((await version(context)).rows).toEqual([
      { FIELD: "Client Version", VALUE: "LibreDB Studio 0.18.2, which runs no kubectl" },
      { FIELD: "Server Version", VALUE: "v1.35.5+k3s1" },
      { FIELD: "Server Git Commit", VALUE: "abc" },
      { FIELD: "Server Build Date", VALUE: "2026-09-01" },
      { FIELD: "Server Go Version", VALUE: "go1.25" },
      { FIELD: "Server Platform", VALUE: "linux/amd64" },
    ]);
    const unnamed = consoleContext(routes({ "GET /version": jsonAnswer({}) }));
    const built = { ...unnamed.context, appVersion: null };
    expect((await version(built)).rows[0].VALUE).toBe("LibreDB Studio (version not recorded), which runs no kubectl");
  });
});

describe("auth can-i", () => {
  test("a resource check: the body is Studio's JSON, the answer and the server's reason", async () => {
    const answer = routes({
      "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews": jsonAnswer(
        { status: { allowed: true, reason: 'RBAC: allowed by RoleBinding "view/shop"' } },
        201,
      ),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await canI(context, statement("kubectl auth can-i list deploy", "auth-can-i"));
    expect(grid.rows).toEqual([{ ANSWER: "yes", REASON: 'RBAC: allowed by RoleBinding "view/shop"' }]);
    expect(JSON.parse(String(transport.calls.at(-1)?.args?.[0]))).toEqual({
      apiVersion: "authorization.k8s.io/v1",
      kind: "SelfSubjectAccessReview",
      spec: { resourceAttributes: { namespace: "shop", verb: "list", group: "apps", resource: "deployments" } },
    });
  });

  test("a quote in a name stays a string of the JSON body", async () => {
    const answer = routes({
      "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews": jsonAnswer({ status: {} }, 201),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await canI(context, statement(`auth can-i get 'configmaps/a"b' -A`, "auth-can-i"));
    expect(grid.rows).toEqual([{ ANSWER: "no", REASON: "" }]);
    expect(JSON.parse(String(transport.calls.at(-1)?.args?.[0])).spec.resourceAttributes).toEqual({
      namespace: "",
      verb: "get",
      group: "",
      resource: "configmaps",
      name: 'a"b',
    });
  });

  test("get pods/exec asks about a pod named exec, with kubectl's reading as a hint", async () => {
    const answer = routes({
      "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews": jsonAnswer({ status: { allowed: false } }, 201),
    });
    const { context } = consoleContext(answer);
    const grid = await canI(context, statement("auth can-i get pods/exec", "auth-can-i"));
    expect(grid.warnings).toEqual([
      {
        message:
          "kubectl reads pods/exec as the object named exec, not the exec subresource; ask about the subresource with auth can-i get pods --subresource=exec.",
      },
    ]);
    const odd = await canI(context, statement("auth can-i get 'po d/log'", "auth-can-i"));
    expect(odd.warnings?.at(-1)?.message).toContain("kubectl reads TYPE/log");
  });

  test("--subresource, * and an unknown type are asked about as written", async () => {
    const answer = routes({
      "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews": jsonAnswer({ status: { allowed: true } }, 201),
    });
    const { context, transport } = consoleContext(answer);
    await canI(context, statement("auth can-i create pods --subresource=exec -n web", "auth-can-i"));
    expect(JSON.parse(String(transport.calls.at(-1)?.args?.[0])).spec.resourceAttributes).toEqual({
      namespace: "web",
      verb: "create",
      group: "",
      resource: "pods",
      subresource: "exec",
    });
    await canI(context, statement("auth can-i '*' '*'", "auth-can-i"));
    expect(JSON.parse(String(transport.calls.at(-1)?.args?.[0])).spec.resourceAttributes.resource).toBe("*");
    const unknown = await canI(context, statement("auth can-i get Gizmos", "auth-can-i"));
    expect(JSON.parse(String(transport.calls.at(-1)?.args?.[0])).spec.resourceAttributes.resource).toBe("gizmos");
    expect(unknown.warnings).toEqual([
      { message: "The server doesn't have this resource type; the review asks about it as written." },
    ]);
  });

  test("--list: the rules of the namespace, one row each, and the incomplete warning", async () => {
    const answer = routes({
      "POST /apis/authorization.k8s.io/v1/selfsubjectrulesreviews": jsonAnswer(
        {
          status: {
            resourceRules: [
              {
                verbs: ["get", "list"],
                apiGroups: ["", "apps"],
                resources: ["pods", "deployments"],
                resourceNames: [],
              },
              { verbs: ["get"], resources: ["configmaps"], resourceNames: ["conf"] },
            ],
            nonResourceRules: [{ verbs: ["get"], nonResourceURLs: ["/healthz"] }],
            incomplete: true,
            evaluationError: "leaked-evaluation-text",
          },
        },
        201,
      ),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await canI(context, statement("auth can-i --list", "auth-can-i"));
    expect(JSON.parse(String(transport.calls.at(-1)?.args?.[0]))).toEqual({
      apiVersion: "authorization.k8s.io/v1",
      kind: "SelfSubjectRulesReview",
      spec: { namespace: "shop" },
    });
    expect(grid.rows).toEqual([
      {
        Resources: "pods, pods.apps, deployments, deployments.apps",
        "Non-Resource URLs": "[]",
        "Resource Names": "[]",
        Verbs: "[get list]",
      },
      { Resources: "configmaps", "Non-Resource URLs": "[]", "Resource Names": "[conf]", Verbs: "[get]" },
      { Resources: "", "Non-Resource URLs": "[/healthz]", "Resource Names": "[]", Verbs: "[get]" },
    ]);
    expect(JSON.stringify(grid)).not.toContain("leaked-evaluation-text");
    expect(grid.warnings?.[0].message).toContain("may be incomplete");
    const complete = consoleContext(
      routes({ "POST /apis/authorization.k8s.io/v1/selfsubjectrulesreviews": jsonAnswer({ status: {} }, 201) }),
    );
    expect((await canI(complete.context, statement("auth can-i --list", "auth-can-i"))).warnings).toBeUndefined();
  });
});

describe("auth whoami", () => {
  test("the user, uid, groups and extra, as kubectl prints them", async () => {
    const answer = routes({
      "POST /apis/authentication.k8s.io/v1/selfsubjectreviews": jsonAnswer(
        {
          status: {
            userInfo: {
              username: "system:serviceaccount:shop:studio",
              uid: "u-1",
              groups: ["system:serviceaccounts", "system:authenticated"],
              extra: { "authentication.kubernetes.io/pod-name": ["studio-0"] },
            },
          },
        },
        201,
      ),
    });
    const { context, transport } = consoleContext(answer);
    expect((await whoami(context)).rows).toEqual([
      { ATTRIBUTE: "Username", VALUE: "system:serviceaccount:shop:studio" },
      { ATTRIBUTE: "UID", VALUE: "u-1" },
      { ATTRIBUTE: "Groups", VALUE: "[system:serviceaccounts system:authenticated]" },
      { ATTRIBUTE: "Extra: authentication.kubernetes.io/pod-name", VALUE: "[studio-0]" },
    ]);
    expect(JSON.parse(String(transport.calls.at(-1)?.args?.[0]))).toEqual({
      apiVersion: "authentication.k8s.io/v1",
      kind: "SelfSubjectReview",
    });
    const bare = consoleContext(
      routes({ "POST /apis/authentication.k8s.io/v1/selfsubjectreviews": jsonAnswer({}, 201) }),
    );
    expect((await whoami(bare.context)).rows).toEqual([
      { ATTRIBUTE: "Username", VALUE: "" },
      { ATTRIBUTE: "Groups", VALUE: "[]" },
    ]);
  });
});
