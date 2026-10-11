/**
 * `auth can-i` and `auth whoami`: the self reviews, each a POST whose body Studio builds as JSON from the parsed
 * statement, so a quote or a brace in a name stays a string and never shapes the body.
 *
 * `auth can-i VERB TYPE[/NAME]` reads TYPE/NAME as kubectl does: the part after the slash is a resource name. When
 * that name is a subresource's (exec, attach, portforward, proxy, log), the answer carries a hint that kubectl reads
 * it as a name and that --subresource asks about the subresource. A type discovery does not know is asked about as
 * written, with kubectl's warning. `--list` is a SelfSubjectRulesReview of the namespace, its rules one row each as
 * the server answers them. `auth whoami` is a SelfSubjectReview.
 */
import type { QueryWarning } from "@/lib/types";
import { resolveResource } from "../resolve";
import { byCodeUnit, type KubectlContext, type KubectlGrid, goList, objectOf, stringOf, textGrid } from "./context";
import type { KubectlStatement } from "./parse";

type CanIStatement = Extract<KubectlStatement, { readonly command: "auth-can-i" }>;

type Json = Readonly<Record<string, unknown>>;

/** The subresources whose names, written after a slash, kubectl reads as a resource name instead. */
const SUBRESOURCE_NAMES: ReadonlySet<string> = new Set(["exec", "attach", "portforward", "proxy", "log"]);

const array = (value: unknown): readonly Json[] =>
  Array.isArray(value) ? value.map((entry) => objectOf(entry) ?? {}) : [];

const strings = (value: unknown): readonly string[] => (Array.isArray(value) ? value.map(String) : []);

/** kubectl's resource column: each resource with each of its groups, `pods` or `deployments.apps`. */
function resourceGroups(resources: readonly string[], groups: readonly string[]): string {
  const combined = resources.flatMap((resource) =>
    (groups.length === 0 ? [""] : groups).map((group) => (group === "" ? resource : `${resource}.${group}`)),
  );
  return combined.join(", ");
}

async function rulesList(context: KubectlContext, statement: CanIStatement): Promise<KubectlGrid> {
  const namespace = statement.namespace ?? context.surface.endpoint.defaultNamespace;
  const answer = objectOf(
    await context.surface.client.json(
      {
        op: "review",
        review: "selfsubjectrulesreviews",
        body: {
          apiVersion: "authorization.k8s.io/v1",
          kind: "SelfSubjectRulesReview",
          spec: { namespace },
        },
      },
      context.call(),
    ),
  );
  const status = objectOf(answer?.status) ?? {};
  const rows = [
    ...array(status.resourceRules).map((rule) => [
      resourceGroups(strings(rule.resources), strings(rule.apiGroups)),
      "[]",
      goList(strings(rule.resourceNames)),
      goList(strings(rule.verbs)),
    ]),
    ...array(status.nonResourceRules).map((rule) => [
      "",
      goList(strings(rule.nonResourceURLs)),
      "[]",
      goList(strings(rule.verbs)),
    ]),
  ];
  const grid = textGrid(["Resources", "Non-Resource URLs", "Resource Names", "Verbs"], rows);
  return status.incomplete === true
    ? {
        ...grid,
        warnings: [{ message: "The server says this list may be incomplete: an authorizer could not list its rules." }],
      }
    : grid;
}

export async function canI(context: KubectlContext, statement: CanIStatement): Promise<KubectlGrid> {
  const check = statement.check;
  if (check === undefined) return rulesList(context, statement);
  const warnings: QueryWarning[] = [];
  let group = "";
  let resource = check.type;
  if (check.type !== "*") {
    const resolution = resolveResource(await context.surface.discovery.get(), check.type);
    if (resolution.kind === "resource") {
      group = resolution.resource.group;
      resource = resolution.resource.resource;
    } else {
      resource = check.type.toLowerCase();
      warnings.push({ message: "The server doesn't have this resource type; the review asks about it as written." });
    }
  }
  const namespace = statement.allNamespaces ? "" : (statement.namespace ?? context.surface.endpoint.defaultNamespace);
  const attributes = {
    namespace,
    verb: check.verb,
    group,
    resource,
    ...(statement.subresource === undefined ? {} : { subresource: statement.subresource }),
    ...(check.name === undefined ? {} : { name: check.name }),
  };
  const answer = objectOf(
    await context.surface.client.json(
      {
        op: "review",
        review: "selfsubjectaccessreviews",
        body: {
          apiVersion: "authorization.k8s.io/v1",
          kind: "SelfSubjectAccessReview",
          spec: { resourceAttributes: attributes },
        },
      },
      context.call(),
    ),
  );
  const status = objectOf(answer?.status) ?? {};
  if (check.name !== undefined && SUBRESOURCE_NAMES.has(check.name)) {
    // The type is echoed only in a resource name's shape; the verb and the name already passed their rules.
    const type = /^[A-Za-z0-9.-]{1,253}$/.test(check.type) ? check.type : "TYPE";
    warnings.push({
      message: `kubectl reads ${type}/${check.name} as the object named ${check.name}, not the ${check.name} subresource; ask about the subresource with auth can-i ${check.verb} ${type} --subresource=${check.name}.`,
    });
  }
  const grid = textGrid(
    ["ANSWER", "REASON"],
    [[status.allowed === true ? "yes" : "no", stringOf(status.reason) ?? ""]],
  );
  return warnings.length === 0 ? grid : { ...grid, warnings };
}

export async function whoami(context: KubectlContext): Promise<KubectlGrid> {
  const answer = objectOf(
    await context.surface.client.json(
      {
        op: "review",
        review: "selfsubjectreviews",
        body: { apiVersion: "authentication.k8s.io/v1", kind: "SelfSubjectReview" },
      },
      context.call(),
    ),
  );
  const user = objectOf(objectOf(answer?.status)?.userInfo) ?? {};
  const rows: unknown[][] = [["Username", stringOf(user.username) ?? ""]];
  if (stringOf(user.uid) !== undefined && user.uid !== "") rows.push(["UID", user.uid]);
  rows.push(["Groups", goList(strings(user.groups))]);
  const extra = objectOf(user.extra) ?? {};
  for (const key of Object.keys(extra).sort(byCodeUnit)) rows.push([`Extra: ${key}`, goList(strings(extra[key]))]);
  return textGrid(["ATTRIBUTE", "VALUE"], rows);
}
