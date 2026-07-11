/**
 * Regression test for issue #137: a default Helm install
 * (persistence.enabled=false) must render a writable mount at /app/data so
 * the embedded "Sample (LibreDB)" connection can seed under
 * readOnlyRootFilesystem, instead of the pod silently keeping /app/data
 * unwritable. Exercises the real `helm template` output against the actual
 * chart - no reimplementation of the templating logic.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");

interface VolumeMount {
  name: string;
  mountPath: string;
}

interface Volume {
  name: string;
  emptyDir?: Record<string, never>;
  persistentVolumeClaim?: { claimName: string };
}

interface RenderedDeployment {
  kind: string;
  spec: {
    template: {
      spec: {
        containers: Array<{ volumeMounts: VolumeMount[] }>;
        volumes: Volume[];
      };
    };
  };
}

function renderDeployment(extraArgs: string[] = []): RenderedDeployment {
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
  return deployment;
}

describe("charts/libredb-studio Deployment /app/data mount (#137)", () => {
  test("default install (persistence.enabled=false) mounts a writable emptyDir at /app/data", () => {
    const podSpec = renderDeployment().spec.template.spec;

    const dataMount = podSpec.containers[0].volumeMounts.find((m) => m.name === "data");
    expect(dataMount).toBeDefined();
    expect(dataMount?.mountPath).toBe("/app/data");

    const dataVolume = podSpec.volumes.find((v) => v.name === "data");
    expect(dataVolume).toBeDefined();
    expect(dataVolume?.emptyDir).toBeDefined();
    expect(dataVolume?.persistentVolumeClaim).toBeUndefined();
  });

  test("persistence.enabled=true still mounts the PVC at /app/data (no regression)", () => {
    const podSpec = renderDeployment(["--set", "persistence.enabled=true"]).spec.template.spec;

    const dataVolume = podSpec.volumes.find((v) => v.name === "data");
    expect(dataVolume).toBeDefined();
    expect(dataVolume?.persistentVolumeClaim).toBeDefined();
    expect(dataVolume?.emptyDir).toBeUndefined();
  });
});
