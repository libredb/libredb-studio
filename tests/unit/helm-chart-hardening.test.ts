/**
 * Regression tests for issue #45: Helm chart hardening items deferred from
 * the chart-introduction review (#44).
 *
 *   1. values.schema.json covered only a subset of values.yaml, so a
 *      wrong-typed value for common keys rendered silently instead of
 *      failing schema validation.
 *   2. The documented jwtSecret length (min 32 chars) was prose-only; the
 *      schema must reject 1-31 char secrets while keeping "" valid (the
 *      zero-config default generates a secret on first start).
 *   3. templates/pdb.yaml used a truthiness check, so an explicit
 *      minAvailable: 0 rendered nothing, and nothing enforced the
 *      minAvailable/maxUnavailable mutual exclusivity.
 *   4. templates/hpa.yaml rendered a multi-replica HPA even with
 *      single-writer sqlite storage.
 *
 * Exercises the real `helm template` output against the actual chart - no
 * reimplementation of the templating logic. Failure assertions check the
 * offending key name in stderr (present in both helm 3 and helm 4 schema
 * error formats), never exact message text.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");

const MINIMAL_ARGS = [
  "--set",
  "secrets.jwtSecret=0123456789abcdef0123456789abcdef",
  "--set",
  "secrets.adminPassword=test-admin-pass",
];

interface RenderedManifest {
  kind: string;
  metadata: { name: string };
  spec?: {
    replicas?: number;
    minAvailable?: number;
    maxUnavailable?: number;
    maxReplicas?: number;
  };
}

function helmTemplate(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", "release-under-test", CHART_DIR, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function renderDocs(args: string[]): RenderedManifest[] {
  const run = helmTemplate(args);
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr}`);
  }
  return parseAllDocuments(run.stdout)
    .map((doc) => doc.toJSON() as RenderedManifest)
    .filter((doc) => doc != null);
}

function findKind(docs: RenderedManifest[], kind: string): RenderedManifest | undefined {
  return docs.find((doc) => doc.kind === kind);
}

describe("charts/libredb-studio hardening (#45)", () => {
  describe("values.schema.json coverage", () => {
    // One wrong-typed probe per key the schema previously did not cover.
    const wrongTypedProbes: Array<[string, string]> = [
      ["serviceAccount.create", 'serviceAccount.create="yes"'],
      ["serviceAccount.automountServiceAccountToken", 'serviceAccount.automountServiceAccountToken="no"'],
      ["podSecurityContext", 'podSecurityContext="broken"'],
      ["securityContext", 'securityContext="broken"'],
      ["imagePullSecrets", 'imagePullSecrets="broken"'],
      ["tolerations", 'tolerations="broken"'],
      ["affinity", 'affinity="broken"'],
      ["topologySpreadConstraints", 'topologySpreadConstraints="broken"'],
      ["networkPolicy.enabled", 'networkPolicy.enabled="yes"'],
      ["networkPolicy.additionalIngress", 'networkPolicy.additionalIngress="broken"'],
      ["service.annotations", 'service.annotations="broken"'],
      ["ingress.hosts", 'ingress.hosts="broken"'],
      ["ingress.tls", 'ingress.tls="broken"'],
      ["persistence.accessModes", 'persistence.accessModes="broken"'],
      ["persistence.annotations", 'persistence.annotations="broken"'],
      ["extraEnv", 'extraEnv="broken"'],
      ["extraEnvFrom", 'extraEnvFrom="broken"'],
      ["podDisruptionBudget.maxUnavailable", 'podDisruptionBudget.maxUnavailable="broken"'],
    ];

    for (const [key, probe] of wrongTypedProbes) {
      test(`a wrong-typed ${key} fails schema validation`, () => {
        const run = helmTemplate([...MINIMAL_ARGS, "--set-json", probe]);
        expect(run.exitCode).not.toBe(0);
        expect(run.stderr).toContain(key.split(".")[0]);
      });
    }

    test("valid values for the newly covered keys still render", () => {
      const docs = renderDocs([
        ...MINIMAL_ARGS,
        "--set-json",
        'imagePullSecrets=[{"name":"regcred"}]',
        "--set-json",
        'tolerations=[{"key":"dedicated","operator":"Equal","value":"db","effect":"NoSchedule"}]',
        "--set-json",
        'affinity={"nodeAffinity":{"requiredDuringSchedulingIgnoredDuringExecution":{"nodeSelectorTerms":[]}}}',
        "--set-json",
        'topologySpreadConstraints=[{"maxSkew":1,"topologyKey":"kubernetes.io/hostname","whenUnsatisfiable":"ScheduleAnyway"}]',
        "--set-json",
        'service.annotations={"example.com/note":"x"}',
        "--set-json",
        'persistence.annotations={"example.com/note":"x"}',
        "--set-json",
        'extraEnv=[{"name":"MY_VAR","value":"v"}]',
        "--set-json",
        'extraEnvFrom=[{"configMapRef":{"name":"my-config"}}]',
        "--set",
        "networkPolicy.enabled=true",
        "--set",
        "ingress.enabled=true",
      ]);
      expect(findKind(docs, "Deployment")).toBeDefined();
    });
  });

  describe("secrets.jwtSecret length (schema-enforced)", () => {
    test("a 31-char jwtSecret fails schema validation", () => {
      const run = helmTemplate([
        "--set",
        "secrets.jwtSecret=0123456789abcdef0123456789abcde",
        "--set",
        "secrets.adminPassword=test-admin-pass",
      ]);
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("jwtSecret");
    });

    test("an empty jwtSecret (zero-config default install) still renders", () => {
      const docs = renderDocs([]);
      expect(findKind(docs, "Deployment")).toBeDefined();
    });

    test("a 32-char jwtSecret renders", () => {
      const docs = renderDocs(MINIMAL_ARGS);
      expect(findKind(docs, "Deployment")).toBeDefined();
    });
  });

  describe("podDisruptionBudget zero-value and mutual exclusivity", () => {
    const pdbArgs = (extra: string[]) => [...MINIMAL_ARGS, "--set", "podDisruptionBudget.enabled=true", ...extra];

    test("an explicit minAvailable: 0 renders minAvailable: 0", () => {
      const docs = renderDocs(pdbArgs(["--set", "podDisruptionBudget.minAvailable=0"]));
      const pdb = findKind(docs, "PodDisruptionBudget");
      expect(pdb).toBeDefined();
      expect(pdb?.spec?.minAvailable).toBe(0);
      expect(pdb?.spec?.maxUnavailable).toBeUndefined();
    });

    test("maxUnavailable with the minAvailable default unset renders maxUnavailable only", () => {
      const docs = renderDocs(
        pdbArgs(["--set", "podDisruptionBudget.minAvailable=null", "--set", "podDisruptionBudget.maxUnavailable=1"]),
      );
      const pdb = findKind(docs, "PodDisruptionBudget");
      expect(pdb).toBeDefined();
      expect(pdb?.spec?.maxUnavailable).toBe(1);
      expect(pdb?.spec?.minAvailable).toBeUndefined();
    });

    test("setting both minAvailable and maxUnavailable fails the render", () => {
      // minAvailable stays at its values.yaml default (1), so both end up set.
      const run = helmTemplate(pdbArgs(["--set", "podDisruptionBudget.maxUnavailable=1"]));
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("minAvailable");
      expect(run.stderr).toContain("maxUnavailable");
    });

    test("enabling the PDB with neither minAvailable nor maxUnavailable fails the render", () => {
      const run = helmTemplate(pdbArgs(["--set", "podDisruptionBudget.minAvailable=null"]));
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("minAvailable");
    });
  });

  describe("autoscaling vs single-writer sqlite storage", () => {
    test("sqlite storage renders no HPA and pins the deployment to replicaCount", () => {
      const docs = renderDocs([
        ...MINIMAL_ARGS,
        "--set",
        "autoscaling.enabled=true",
        "--set",
        "config.storageProvider=sqlite",
      ]);
      expect(findKind(docs, "HorizontalPodAutoscaler")).toBeUndefined();
      expect(findKind(docs, "Deployment")?.spec?.replicas).toBe(1);
    });

    test("non-sqlite storage still renders the HPA and omits deployment replicas", () => {
      const docs = renderDocs([...MINIMAL_ARGS, "--set", "autoscaling.enabled=true"]);
      const hpa = findKind(docs, "HorizontalPodAutoscaler");
      expect(hpa).toBeDefined();
      expect(hpa?.spec?.maxReplicas).toBeGreaterThan(1);
      expect(findKind(docs, "Deployment")?.spec?.replicas).toBeUndefined();
    });
  });
});
