// @requires helm
/**
 * docs/OPENSHIFT.md, the operator's install and the move from 1.1.0.
 *
 * The operator's limits rest on its namespace being one only cluster admins write and on the cluster having one
 * install of it, so the install steps must give the checks that show both, cluster-wide grants included.
 *
 * "Moving from operator 1.1.0", step 4, makes each team Studio a Helm release.
 * The values file of that step is the LibreDBStudio's spec, which anyone who may edit the team's namespace wrote, and
 * the 1.1.0 CRD keeps every key of it, so Helm must apply it with the team's own rights, never a cluster admin's.
 * These tests take the step's commands from the doc as written: the patch, applied as a JSON merge patch to a spec
 * that sets every value that reaches outside the namespace, and the Helm command's --set flags must together render
 * only objects in the team's namespace, so the team's own run needs no other right; and the step must say that the
 * team runs it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { howItFailed } from "../helpers/spawn-outcome";

const DOC = join(import.meta.dir, "../../docs/OPENSHIFT.md");
const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const TEAM = "team-a";

/** A spec the 1.1.0 CRD accepts, with every value that places an object outside the resource's namespace. */
const TEAM_SPEC = {
  persistence: { enabled: true, size: "1Gi" },
  postgresql: {
    enabled: true,
    extraDeploy: [
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "ClusterRoleBinding",
        metadata: { name: "probe" },
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "view" },
        subjects: [{ kind: "User", name: "dev-a", apiGroup: "rbac.authorization.k8s.io" }],
      },
    ],
    namespaceOverride: "other-ns",
    metrics: {
      enabled: true,
      serviceMonitor: { enabled: true, namespace: "other-ns" },
      prometheusRule: { enabled: true, namespace: "other-ns" },
    },
  },
  discovery: { kubernetes: { enabled: true, namespaces: ["other-ns"] } },
  openshift: { consoleLink: { enabled: true } },
  openshiftRoute: { enabled: true, host: "studio-team-a.apps.example.com" },
  global: { compatibility: { openshift: { apis: "force" } } },
};

const CLUSTER_SCOPED = new Set([
  "ClusterRole",
  "ClusterRoleBinding",
  "ConsoleLink",
  "ConsolePlugin",
  "Namespace",
  "NavLink",
  "CustomResourceDefinition",
  "PersistentVolume",
  "StorageClass",
  "PriorityClass",
  "ValidatingWebhookConfiguration",
  "MutatingWebhookConfiguration",
]);

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`no "${heading}" in docs/OPENSHIFT.md`);
  const rest = markdown.slice(start + heading.length + 2);
  const end = rest.search(/\n#{2,3} /);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The text of numbered step `n`, up to the next top-level step. */
function step(text: string, n: number): string {
  const start = text.search(new RegExp(`^${n}\\. `, "m"));
  if (start < 0) throw new Error(`no step ${n}`);
  const rest = text.slice(start);
  const end = rest.slice(2).search(/^\d+\. /m);
  return end < 0 ? rest : rest.slice(0, end + 2);
}

function shellLines(text: string): string[] {
  const block = text.match(/```sh\n([\s\S]*?)```/);
  if (!block) throw new Error("no sh block");
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** RFC 7386 JSON merge patch, the `--type merge` of `oc patch`. */
function mergePatch(target: Json, patch: Json): Json {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: { [key: string]: Json } =
    target !== null && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key] ?? null, value);
  }
  return out;
}

type Rendered = { kind: string; metadata: { name: string; namespace?: string } };

/** Renders the chart for the team's namespace with `values` as a values file and `flags` after it. */
function render(values: Json, flags: string[]): Rendered[] {
  const dir = mkdtempSync(join(tmpdir(), "operator-openshift-install-docs-"));
  try {
    const file = join(dir, "values.json");
    writeFileSync(file, JSON.stringify(values));
    const run = Bun.spawnSync(["helm", "template", "team", CHART_DIR, "--namespace", TEAM, "-f", file, ...flags], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (run.exitCode !== 0) throw new Error(`helm template ${howItFailed(run)}: ${run.stderr.toString()}`);
    return parseAllDocuments(run.stdout.toString())
      .map((doc) => doc.toJSON() as Rendered | null)
      .filter((doc): doc is Rendered => Boolean(doc));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every rendered object that is cluster-scoped or lives outside the team's namespace. */
function outside(docs: Rendered[]): string[] {
  return docs
    .filter((doc) => CLUSTER_SCOPED.has(doc.kind) || (doc.metadata.namespace ?? TEAM) !== TEAM)
    .map((doc) => `${doc.kind}/${doc.metadata.namespace ?? ""}/${doc.metadata.name}`);
}

const MOVE = section(readFileSync(DOC, "utf8"), "### Moving from operator 1.1.0");
const STEP4 = step(MOVE, 4);
const LINES = shellLines(STEP4);

describe("the move's step 4 as the doc words it", () => {
  test("the team spec, unpatched, renders objects outside the team's namespace", () => {
    expect(outside(render(TEAM_SPEC as Json, []))).toEqual(
      expect.arrayContaining([
        "ClusterRoleBinding//probe",
        "ConsoleLink//libredb-studio",
        "StatefulSet/other-ns/team-postgresql",
      ]),
    );
  });

  test("the team runs the commands with its own rights, after a cluster admin removed what lies outside the namespace", () => {
    expect(STEP4).toContain("Helm applies a release with the rights of whoever runs it");
    expect(STEP4).toMatch(/the team runs [^.]*with its own rights, never a cluster admin/);
    expect(MOVE).not.toContain("stays a cluster admin's to upgrade");
  });

  test("the patch comes before the values file is written, and the Helm upgrade last", () => {
    const at = (prefix: string) => LINES.findIndex((line) => line.startsWith(prefix));
    expect(at("oc patch libredbstudio")).toBeGreaterThanOrEqual(0);
    expect(at("oc patch libredbstudio")).toBeLessThan(at("oc get libredbstudio"));
    expect(at("oc get libredbstudio")).toBeLessThan(at("oc delete libredbstudio"));
    expect(at("helm upgrade")).toBe(LINES.length - 1);
  });

  test("the patch and the Helm flags render nothing outside the team's namespace from a spec that reaches out", () => {
    const patchLine = LINES.find((line) => line.startsWith("oc patch libredbstudio"));
    const patchJson = patchLine?.match(/-p '([^']+)'/)?.[1];
    if (!patchJson) throw new Error("no patch JSON in step 4");
    const patch = JSON.parse(patchJson) as { metadata?: { finalizers?: null }; spec?: Json };
    expect(patch.metadata).toEqual({ finalizers: null });
    const values = patch.spec === undefined ? (TEAM_SPEC as Json) : mergePatch(TEAM_SPEC as Json, patch.spec);

    const helmLine = LINES[LINES.length - 1];
    const sets = [...helmLine.matchAll(/--set (\S+)/g)].flatMap((match) => ["--set", match[1]]);
    expect(sets.length).toBeGreaterThan(0);

    const docs = render(values, sets);
    expect(docs.some((doc) => doc.kind === "Deployment")).toBe(true);
    expect(outside(docs)).toEqual([]);
  });
});

describe("the OperatorHub install", () => {
  const INSTALL = section(readFileSync(DOC, "utf8"), "## Install from OperatorHub");

  test("step 2 checks cluster-wide grants on the namespace, not only its RoleBindings", () => {
    const check = step(INSTALL, 2);
    expect(check).toContain("oc adm policy who-can create pods -n libredb-studio");
    expect(check).toContain("oc adm policy who-can update secrets -n libredb-studio");
  });

  test("the cluster has one install, and an OperatorGroup where others edit names a service account", () => {
    expect(INSTALL).toContain("oc get csv -A | grep libredb-studio-operator");
    expect(INSTALL).toContain("`serviceAccountName`");
  });

  test("the resource is not said to leave the operator no choice of namespace", () => {
    expect(INSTALL).not.toContain("cannot change where the operator puts objects");
  });
});

describe("security control 3.36", () => {
  const SECURITY = readFileSync(join(import.meta.dir, "../../docs/SECURITY.md"), "utf8");

  test("its row names every cluster-wide right, the namespace read and the metrics auth reviews included", () => {
    const row = SECURITY.split("\n").find((line) => line.startsWith("| 3.36 |")) ?? "";
    expect(row).toContain("`get` Secrets, Services and Namespaces");
    expect(row).toContain("token and subject access reviews");
  });

  test("its note is a paragraph of its own and states the premises the install steps check", () => {
    expect(SECURITY).toContain("\n\n**3.36.** ");
    const note = SECURITY.slice(SECURITY.indexOf("**3.36.** "));
    const text = note.slice(0, note.indexOf("\n\n"));
    expect(text).toContain("`oc adm policy who-can`");
    expect(text).toContain("one install");
    expect(text).toContain("`serviceAccountName`");
  });
});

describe("the Helm install section", () => {
  test("names no cluster admin install of a team Studio", () => {
    const helm = section(readFileSync(DOC, "utf8"), "## Install with Helm");
    expect(helm).not.toContain("unless a cluster admin installs it");
  });
});
