// @requires helm
/**
 * The pod's API token mount follows serviceAccount.automountServiceAccountToken whichever account the pod runs as.
 *
 * The value used to reach only the ServiceAccount this chart renders. With serviceAccount.create=false the pod runs as
 * an account the chart does not render, usually the namespace's default one, and that account's own setting decided,
 * so the pod mounted its token, which Studio reads only for Vault Kubernetes auth (VAULT_ROLE). The pod spec now
 * carries the value itself, and only an explicit true mounts the token.
 *
 * Exercises real `helm template` output, no reimplementation of the logic.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");

interface Manifest {
  readonly kind?: string;
  readonly automountServiceAccountToken?: boolean | null;
  readonly spec?: {
    readonly template: {
      readonly spec: { readonly serviceAccountName: string; readonly automountServiceAccountToken?: boolean | null };
    };
  };
}

interface Rendered {
  readonly serviceAccount: Manifest | undefined;
  readonly pod: { readonly serviceAccountName: string; readonly automountServiceAccountToken?: boolean | null };
}

function render(extraArgs: string[] = []): Rendered {
  const run = Bun.spawnSync(["helm", "template", "release-under-test", CHART_DIR, ...extraArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr.toString()}`);
  }
  const docs = parseAllDocuments(run.stdout.toString())
    .map((doc) => doc.toJSON() as Manifest | null)
    .filter((doc): doc is Manifest => doc !== null);
  const deployment = docs.find((doc) => doc.kind === "Deployment");
  if (!deployment?.spec) throw new Error("no Deployment manifest found in rendered chart output");
  return { serviceAccount: docs.find((doc) => doc.kind === "ServiceAccount"), pod: deployment.spec.template.spec };
}

describe("serviceAccount.automountServiceAccountToken on the pod spec", () => {
  test("the default install mounts no token, on the ServiceAccount and on the pod", () => {
    const { serviceAccount, pod } = render();
    expect(serviceAccount?.automountServiceAccountToken).toBe(false);
    expect(pod).toMatchObject({ serviceAccountName: "release-under-test-libredb-studio" });
    expect(pod.automountServiceAccountToken).toBe(false);
  });

  test("with serviceAccount.create=false the pod runs as the default account and still mounts no token", () => {
    const { serviceAccount, pod } = render(["--set", "serviceAccount.create=false"]);
    expect(serviceAccount).toBeUndefined();
    expect(pod.serviceAccountName).toBe("default");
    expect(pod.automountServiceAccountToken).toBe(false);
  });

  test("with serviceAccount.create=false and a named account, the pod mounts no token either", () => {
    const { pod } = render(["--set", "serviceAccount.create=false", "--set", "serviceAccount.name=studio-runner"]);
    expect(pod.serviceAccountName).toBe("studio-runner");
    expect(pod.automountServiceAccountToken).toBe(false);
  });

  test("an explicit true mounts the token, with a rendered account and with an account the chart does not create", () => {
    const created = render(["--set", "serviceAccount.automountServiceAccountToken=true"]);
    expect(created.serviceAccount?.automountServiceAccountToken).toBe(true);
    expect(created.pod.automountServiceAccountToken).toBe(true);
    const own = render([
      "--set",
      "serviceAccount.create=false",
      "--set",
      "serviceAccount.name=studio-runner",
      "--set",
      "serviceAccount.automountServiceAccountToken=true",
    ]);
    expect(own.pod.automountServiceAccountToken).toBe(true);
  });

  test("a values set with the key removed renders false on the pod, never an empty field the kubelet reads as mount", () => {
    const own = render([
      "--set",
      "serviceAccount.create=false",
      "--set",
      "serviceAccount.automountServiceAccountToken=null",
    ]);
    expect(own.pod.automountServiceAccountToken).toBe(false);
    // The created ServiceAccount renders an empty field here; the pod field overrides it, so no token is mounted.
    const created = render(["--set", "serviceAccount.automountServiceAccountToken=null"]);
    expect(created.pod.automountServiceAccountToken).toBe(false);
  });
});
