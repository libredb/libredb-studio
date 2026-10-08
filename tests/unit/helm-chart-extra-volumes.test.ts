// @requires helm
/**
 * extraVolumes / extraVolumeMounts (#1526).
 *
 * A private CA has no way into the pod otherwise: the only mounted ConfigMap
 * is the seed connections one, so a CA for NODE_EXTRA_CA_CERTS forced
 * seedConnections.existingConfigMap. Both values are empty by default and
 * are appended after the chart's own volumes and mounts.
 *
 * Exercises real `helm template` output, no reimplementation of the logic.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");

interface PodSpec {
  initContainers?: Array<{ name: string; volumeMounts?: Array<{ name: string; mountPath: string }> }>;
  containers: Array<{ name: string; volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> }>;
  volumes: Array<{ name: string; configMap?: { name: string }; secret?: { secretName: string } }>;
}

function podSpec(extraArgs: string[] = []): PodSpec {
  const run = Bun.spawnSync(["helm", "template", "release-under-test", CHART_DIR, ...extraArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr.toString()}`);
  }
  const docs = parseAllDocuments(run.stdout.toString()).map(
    (doc) => doc.toJSON() as { kind?: string; spec?: { template: { spec: PodSpec } } },
  );
  const deployment = docs.find((doc) => doc?.kind === "Deployment");
  if (!deployment?.spec) throw new Error("no Deployment manifest found in rendered chart output");
  return deployment.spec.template.spec;
}

const CA_VOLUME = '[{"name":"internal-ca","configMap":{"name":"internal-ca"}}]';
const CA_MOUNT = '[{"name":"internal-ca","mountPath":"/etc/ssl/internal","readOnly":true}]';

describe("extraVolumes and extraVolumeMounts (#1526)", () => {
  test("the default install adds no volume and no mount", () => {
    const spec = podSpec();
    expect(spec.volumes.map((volume) => volume.name)).toEqual(["next-cache", "tmp", "data"]);
    expect(spec.containers[0].volumeMounts.map((mount) => mount.name)).toEqual(["next-cache", "tmp", "data"]);
  });

  test("a volume and its mount reach the pod and the app container", () => {
    const spec = podSpec(["--set-json", `extraVolumes=${CA_VOLUME}`, "--set-json", `extraVolumeMounts=${CA_MOUNT}`]);
    expect(spec.volumes).toContainEqual({ name: "internal-ca", configMap: { name: "internal-ca" } });
    expect(spec.containers[0].volumeMounts).toContainEqual({
      name: "internal-ca",
      mountPath: "/etc/ssl/internal",
      readOnly: true,
    });
  });

  test("they come after the chart's own entries, which stay as they are", () => {
    const spec = podSpec([
      "--set",
      "seedConnections.enabled=true",
      "--set",
      "seedConnections.existingConfigMap=seed",
      "--set-json",
      `extraVolumes=${CA_VOLUME}`,
      "--set-json",
      `extraVolumeMounts=${CA_MOUNT}`,
    ]);
    expect(spec.volumes.map((volume) => volume.name)).toEqual([
      "next-cache",
      "tmp",
      "data",
      "seed-config",
      "internal-ca",
    ]);
    expect(spec.containers[0].volumeMounts.map((mount) => mount.name)).toEqual([
      "next-cache",
      "tmp",
      "data",
      "seed-config",
      "internal-ca",
    ]);
  });

  test("the mount goes to the app container only, not to an init container", () => {
    const spec = podSpec([
      "--set",
      "persistence.enabled=true",
      "--set",
      "persistence.fixPermissions=true",
      "--set-json",
      `extraVolumes=${CA_VOLUME}`,
      "--set-json",
      `extraVolumeMounts=${CA_MOUNT}`,
    ]);
    expect(spec.initContainers?.[0].volumeMounts?.map((mount) => mount.name)).toEqual(["data"]);
  });

  test("the schema refuses an entry that is not an object", () => {
    const run = Bun.spawnSync(
      ["helm", "template", "release-under-test", CHART_DIR, "--set-json", 'extraVolumes=["internal-ca"]'],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("extraVolumes");
  });
});
