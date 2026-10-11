/**
 * The commands that read what the server is rather than what it holds: `api-resources` and `api-versions` from a
 * fresh discovery read (kubectl invalidates its cache for both), and `version` from `/version`.
 *
 * `api-resources` prints kubectl's columns (NAME, SHORTNAMES, APIVERSION, NAMESPACED, KIND; VERBS and CATEGORIES with
 * -o wide; one name column with -o name), filtered by --namespaced, --api-group and --verbs, and sorted as kubectl
 * sorts it: by group, then by name. `api-versions` is sorted as kubectl sorts it. `version` names Studio as the
 * client, since no kubectl runs, and the server's build in its fields.
 */
import type { IndexedResource } from "../discovery";
import { byCodeUnit, type KubectlContext, type KubectlGrid, goList, objectOf, stringOf, textGrid } from "./context";
import type { KubectlStatement } from "./parse";

type ApiResourcesStatement = Extract<KubectlStatement, { readonly command: "api-resources" }>;

const groupVersion = (resource: IndexedResource): string =>
  resource.group === "" ? resource.version : `${resource.group}/${resource.version}`;

export async function apiResources(context: KubectlContext, statement: ApiResourcesStatement): Promise<KubectlGrid> {
  const index = await context.surface.discovery.refresh();
  const kept = index.resources
    .filter((resource) => resource.verbs.length > 0)
    .filter((resource) => statement.apiGroup === undefined || resource.group === statement.apiGroup)
    .filter((resource) => statement.namespaced === undefined || resource.namespaced === statement.namespaced)
    .filter((resource) => statement.verbs.every((verb) => resource.verbs.includes(verb)));
  // kubectl's stable sort: by group, and by name within a group.
  const sorted = [...kept].sort((a, b) => byCodeUnit(a.group, b.group) || byCodeUnit(a.resource, b.resource));
  if (statement.output === "name")
    return textGrid(
      ["NAME"],
      sorted.map((resource) => [resource.group === "" ? resource.resource : `${resource.resource}.${resource.group}`]),
    );
  const wide = statement.output === "wide";
  return textGrid(
    ["NAME", "SHORTNAMES", "APIVERSION", "NAMESPACED", "KIND", ...(wide ? ["VERBS", "CATEGORIES"] : [])],
    sorted.map((resource) => {
      const cells: unknown[] = [
        resource.resource,
        resource.shortNames.join(","),
        groupVersion(resource),
        String(resource.namespaced),
        resource.kind,
      ];
      if (wide) cells.push(goList(resource.verbs), resource.categories.join(","));
      return cells;
    }),
  );
}

export async function apiVersions(context: KubectlContext): Promise<KubectlGrid> {
  const index = await context.surface.discovery.refresh();
  return textGrid(
    ["APIVERSION"],
    [...new Set(index.groupVersions)].sort(byCodeUnit).map((version) => [version]),
  );
}

export async function version(context: KubectlContext): Promise<KubectlGrid> {
  const body = objectOf(await context.surface.client.json({ op: "version" }, context.call())) ?? {};
  const field = (key: string): string => stringOf(body[key]) ?? "";
  return textGrid(
    ["FIELD", "VALUE"],
    [
      ["Client Version", `LibreDB Studio ${context.appVersion ?? "(version not recorded)"}, which runs no kubectl`],
      ["Server Version", field("gitVersion")],
      ["Server Git Commit", field("gitCommit")],
      ["Server Build Date", field("buildDate")],
      ["Server Go Version", field("goVersion")],
      ["Server Platform", field("platform")],
    ],
  );
}
