// @requires helm
/**
 * How Studio's Deployment rolls when one pod holds the /app/data volume claim.
 *
 * Without a strategy, Kubernetes rolls one replica with maxSurge 1 and maxUnavailable 0: the old pod
 * keeps running until the new one is ready. With persistence on, the new pod needs the claim the old
 * pod holds, and where that claim is exclusive it never gets it: a ReadWriteOnce volume attached to
 * another node (Longhorn, a cloud block volume) or a ReadWriteOncePod claim. Every upgrade and every
 * restart then waits until helm --wait gives up. Rancher mode runs exactly that shape, one replica
 * with persistence on. MEASURED on k3s 1.35.5 with Helm 4.1.3, chart 0.1.108: a ReadWriteOncePod
 * claim on one node left the new pod Pending ("PersistentVolumeClaim with ReadWriteOncePod access
 * mode already in-use by another pod") and the upgrade failed.
 *
 * So one pod on a claim rolls with maxSurge 0 and maxUnavailable 1: the old pod stops first, and the
 * new one waits for the claim instead of the old one waiting for the new one. The type stays
 * RollingUpdate on purpose. The API server defaults rollingUpdate on every Deployment the chart
 * already installed, and a server-side apply, which Helm 4 and Rancher's Apps page use, cannot remove
 * a field no manager owns, so an upgrade to type Recreate is refused with "spec.strategy.rollingUpdate:
 * Forbidden: may not be specified when strategy `type` is 'Recreate'". MEASURED on the same cluster,
 * with and without rollingUpdate: null; maxSurge 0 upgraded the stuck release and later ones through
 * both server-side and client-side apply.
 *
 * Exercises real `helm template` output, no reimplementation of the logic.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { howItFailed } from "../helpers/spawn-outcome";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const RELEASE = "release-under-test";
const NAMESPACE = "libredb-studio";
const JWT = ["--set", "secrets.jwtSecret=not-a-secret-helm-template-fixture-value"];

/** The old pod stops before the new one is created, and the type stays RollingUpdate (see above). */
const STOP_FIRST = { type: "RollingUpdate", rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } };

interface RenderedDeployment {
  kind: string;
  metadata: { name: string };
  spec: { strategy?: unknown };
}

/**
 * The values the LibreDB Rancher extension's setup wizard installs with single sign-on on, as its
 * services/setup/values.ts builds them: one replica, persistence on, discovery and the access review.
 */
const RANCHER_WIZARD_VALUES = {
  authProvider: "oidc",
  config: {
    allowCustomConnections: false,
    oidcIssuer: "https://rancher.example.com/oidc",
    oidcScope: "openid profile groups",
    oidcPrompt: "omit",
    oidcAutoRedirect: true,
    oidcRoleClaim: "",
    sessionTtlSeconds: 900,
  },
  secrets: { oidcExistingSecret: "libredb-studio-oidc" },
  accessReview: { enabled: true, cacheSeconds: 15 },
  agent: { enabled: false },
  mcp: { enabled: false },
  persistence: { enabled: true },
  seedConnections: { cacheTTL: 10000 },
  discovery: { kubernetes: { enabled: true, namespaces: ["team-a", "team-b"] } },
  rancher: { navLink: { enabled: true } },
  ingress: {
    enabled: true,
    className: "traefik",
    annotations: {},
    hosts: [{ host: "studio.example.com", paths: [{ path: "/", pathType: "Prefix" }] }],
    tls: [{ secretName: "libredb-studio-tls", hosts: ["studio.example.com"] }],
  },
};

let valuesDir: string;
let rancherValuesFile: string;

beforeAll(() => {
  valuesDir = mkdtempSync(join(tmpdir(), "helm-rollout-strategy-"));
  rancherValuesFile = join(valuesDir, "rancher-wizard.yaml");
  // JSON is YAML, so the object above is the values file as it is.
  writeFileSync(rancherValuesFile, JSON.stringify(RANCHER_WIZARD_VALUES));
});

afterAll(() => {
  rmSync(valuesDir, { recursive: true, force: true });
});

function deployments(args: string[]): RenderedDeployment[] {
  const run = Bun.spawnSync(["helm", "template", RELEASE, CHART_DIR, "--namespace", NAMESPACE, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) {
    throw new Error(`helm template ${howItFailed(run)}: ${run.stderr.toString()}`);
  }
  return parseAllDocuments(run.stdout.toString())
    .map((doc) => doc.toJSON() as RenderedDeployment)
    .filter((doc) => doc?.kind === "Deployment");
}

/** Studio's own Deployment, never the discovery exporter's. */
function studio(args: string[]): RenderedDeployment {
  const deployment = deployments(args).find((doc) => !doc.metadata.name.endsWith("-discovery"));
  if (!deployment) throw new Error("no Studio Deployment found in rendered chart output");
  return deployment;
}

describe("the Deployment's rollout strategy", () => {
  test("an install without a volume claim keeps the Kubernetes default, so its rollout overlaps", () => {
    expect(studio([]).spec.strategy).toBeUndefined();
  });

  test("one pod on a claim stops the old pod first, with maxSurge 0 rather than type Recreate", () => {
    expect(studio(["--set", "persistence.enabled=true"]).spec.strategy).toEqual(STOP_FIRST);
  });

  test("SQLite storage, which turns persistence on, and an existing claim stop the old pod first too", () => {
    expect(studio(["--set", "config.storageProvider=sqlite"]).spec.strategy).toEqual(STOP_FIRST);
    const existing = ["--set", "persistence.enabled=true", "--set", "persistence.existingClaim=studio-data"];
    expect(studio(existing).spec.strategy).toEqual(STOP_FIRST);
  });

  test("the values of the Rancher setup wizard stop the old pod first, and the exporter, which has no claim, keeps the default", () => {
    const rendered = deployments(["--values", rancherValuesFile]);
    const exporter = rendered.find((doc) => doc.metadata.name.endsWith("-discovery"));
    expect(studio(["--values", rancherValuesFile]).spec.strategy).toEqual(STOP_FIRST);
    expect(exporter).toBeDefined();
    expect(exporter?.spec.strategy).toBeUndefined();
  });

  test("more than one replica shares the claim, which only ReadWriteMany allows, and keeps the default", () => {
    const shared = ["--set", "persistence.enabled=true", "--set", "replicaCount=2", ...JWT];
    expect(studio(shared).spec.strategy).toBeUndefined();
  });

  test("an autoscaled release counts its ceiling: above one pod keeps the default, a ceiling of one stops the old pod first", () => {
    const autoscaled = ["--set", "persistence.enabled=true", "--set", "autoscaling.enabled=true", ...JWT];
    expect(studio([...autoscaled, "--set", "autoscaling.maxReplicas=3"]).spec.strategy).toBeUndefined();
    const ceilingOfOne = ["--set", "autoscaling.minReplicas=1", "--set", "autoscaling.maxReplicas=1"];
    expect(studio([...autoscaled, ...ceilingOfOne]).spec.strategy).toEqual(STOP_FIRST);
  });
});
