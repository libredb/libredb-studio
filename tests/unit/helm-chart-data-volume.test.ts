/**
 * /app/data volume knobs from the Rancher E2E follow-ups (issue #170).
 *
 * - persistence.emptyDirSizeLimit caps the default install's writable volume.
 *   /app/data is the first volume a user can grow (seeded SQLite samples,
 *   storageProvider=sqlite), and an unbounded emptyDir consumes node
 *   ephemeral storage. Off by default: capping it retroactively would start
 *   evicting pods that are fine today.
 * - persistence.fixPermissions chowns the mounted volume before the app
 *   starts. The kubelet does not apply fsGroup to hostPath volumes, so a
 *   statically provisioned PV lands the app on an unwritable /app/data
 *   (EACCES) until someone chowns it by hand. Off by default and scoped to a
 *   real volume: it needs a root init container, which the restricted-v2 SCC
 *   on OpenShift rejects, and an emptyDir already gets fsGroup applied.
 *
 * Exercises real `helm template` output, no reimplementation of the logic.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");

interface Container {
  name: string;
  image?: string;
  command?: string[];
  securityContext?: {
    runAsUser?: number;
    runAsNonRoot?: boolean;
    readOnlyRootFilesystem?: boolean;
    allowPrivilegeEscalation?: boolean;
    capabilities?: { drop?: string[]; add?: string[] };
  };
  volumeMounts?: Array<{ name: string; mountPath: string }>;
}

interface RenderedDeployment {
  kind: string;
  spec: {
    template: {
      spec: {
        initContainers?: Container[];
        containers: Container[];
        volumes: Array<{
          name: string;
          emptyDir?: { sizeLimit?: string } | null;
          persistentVolumeClaim?: { claimName: string };
        }>;
      };
    };
  };
}

function podSpec(extraArgs: string[] = []): RenderedDeployment["spec"]["template"]["spec"] {
  const run = Bun.spawnSync(["helm", "template", "release-under-test", CHART_DIR, ...extraArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr.toString()}`);
  }
  const docs = parseAllDocuments(run.stdout.toString()).map((doc) => doc.toJSON() as RenderedDeployment);
  const deployment = docs.find((doc) => doc?.kind === "Deployment");
  if (!deployment) throw new Error("no Deployment manifest found in rendered chart output");
  return deployment.spec.template.spec;
}

function dataVolume(spec: RenderedDeployment["spec"]["template"]["spec"]) {
  return spec.volumes.find((volume) => volume.name === "data");
}

describe("persistence.emptyDirSizeLimit (#170)", () => {
  test("the default install leaves the /app/data emptyDir uncapped", () => {
    const volume = dataVolume(podSpec());
    expect(volume?.emptyDir).toBeDefined();
    expect(volume?.emptyDir?.sizeLimit).toBeUndefined();
  });

  test("a size limit reaches the emptyDir as a quantity", () => {
    const volume = dataVolume(podSpec(["--set", "persistence.emptyDirSizeLimit=512Mi"]));
    expect(volume?.emptyDir?.sizeLimit).toBe("512Mi");
  });

  test("the limit does not turn a PVC install back into an emptyDir", () => {
    const volume = dataVolume(
      podSpec(["--set", "persistence.enabled=true", "--set", "persistence.emptyDirSizeLimit=512Mi"]),
    );
    expect(volume?.persistentVolumeClaim).toBeDefined();
    expect(volume?.emptyDir).toBeUndefined();
  });
});

describe("persistence.fixPermissions (#170)", () => {
  test("no init container by default", () => {
    expect(podSpec(["--set", "persistence.enabled=true"]).initContainers).toBeUndefined();
  });

  test("chowns the mounted volume to the pod's user and fsGroup", () => {
    const spec = podSpec(["--set", "persistence.enabled=true", "--set", "persistence.fixPermissions=true"]);
    const init = spec.initContainers?.find((container) => container.name === "fix-data-permissions");
    expect(init).toBeDefined();
    expect(init?.command?.join(" ")).toContain("chown -R 1001:1001 /app/data");
    expect(init?.volumeMounts).toEqual([{ name: "data", mountPath: "/app/data" }]);
    // Reuses the app image: an extra image would have to be mirrored for
    // air-gapped installs, and this one already ships coreutils.
    expect(init?.image).toBe(spec.containers[0].image);
  });

  test("the init container takes only the privileges a chown needs", () => {
    const spec = podSpec(["--set", "persistence.enabled=true", "--set", "persistence.fixPermissions=true"]);
    const security = spec.initContainers?.[0].securityContext;
    expect(security?.runAsUser).toBe(0);
    expect(security?.runAsNonRoot).toBe(false);
    expect(security?.allowPrivilegeEscalation).toBe(false);
    expect(security?.readOnlyRootFilesystem).toBe(true);
    expect(security?.capabilities?.drop).toEqual(["ALL"]);
    expect(security?.capabilities?.add).toEqual(["CHOWN", "FOWNER", "DAC_OVERRIDE"]);
  });

  test("honours a custom runAsUser and fsGroup", () => {
    const spec = podSpec([
      "--set",
      "persistence.enabled=true",
      "--set",
      "persistence.fixPermissions=true",
      "--set",
      "podSecurityContext.runAsUser=2000",
      "--set",
      "podSecurityContext.fsGroup=3000",
    ]);
    expect(spec.initContainers?.[0].command?.join(" ")).toContain("chown -R 2000:3000 /app/data");
  });

  test("is ignored without a real volume - an emptyDir already gets fsGroup", () => {
    expect(podSpec(["--set", "persistence.fixPermissions=true"]).initContainers).toBeUndefined();
  });

  test("refuses the OpenShift security-context adaptation instead of rendering a wrong chown", () => {
    // With the adaptation on, the SCC assigns the pod's UID/GID from the
    // namespace range and podSecurityContext.runAsUser/fsGroup are dropped - so
    // a chown to those values targets the wrong owner, and restricted-v2 rejects
    // the root init container regardless. Fail at render, loudly.
    const run = Bun.spawnSync(
      [
        "helm",
        "template",
        "release-under-test",
        CHART_DIR,
        "--set",
        "persistence.enabled=true",
        "--set",
        "persistence.fixPermissions=true",
        "--set",
        "global.compatibility.openshift.adaptSecurityContext=force",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("persistence.fixPermissions");
    expect(run.stderr.toString()).toContain("OpenShift");
  });

  test("stays available when the OpenShift adaptation is explicitly disabled", () => {
    const spec = podSpec([
      "--set",
      "persistence.enabled=true",
      "--set",
      "persistence.fixPermissions=true",
      "--set",
      "global.compatibility.openshift.adaptSecurityContext=disabled",
    ]);
    expect(spec.initContainers?.[0].name).toBe("fix-data-permissions");
  });
});
