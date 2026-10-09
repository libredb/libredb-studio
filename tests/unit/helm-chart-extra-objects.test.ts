// @requires helm
/**
 * extraObjects (#1526).
 *
 * Plain Kubernetes manifests shipped with the release, so they are installed,
 * upgraded and removed with it. Each item goes through tpl: an object can use
 * release values and the chart's helpers, and a string is taken as a template
 * as it is. Empty by default, so a default install renders no extra document.
 *
 * Exercises real `helm template` output, no reimplementation of the logic.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const RELEASE = "release-under-test";

interface Manifest {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  data?: Record<string, string>;
  stringData?: Record<string, string>;
}

function render(extraArgs: string[] = []): { docs: Manifest[]; sources: string[] } {
  const run = Bun.spawnSync(["helm", "template", RELEASE, CHART_DIR, "--namespace", "studio", ...extraArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr.toString()}`);
  }
  const out = run.stdout.toString();
  return {
    docs: parseAllDocuments(out)
      .map((doc) => doc.toJSON() as Manifest)
      .filter(Boolean),
    sources: [...out.matchAll(/^# Source: (.+)$/gm)].map((match) => match[1]),
  };
}

const CONFIG_MAP = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "my-config" },
  data: { greeting: "hello" },
};

const SECRET = {
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name: "my-secret" },
  stringData: { token: "abc" },
};

function extraObjects(...items: unknown[]): string[] {
  return ["--set-json", `extraObjects=${JSON.stringify(items)}`];
}

describe("extraObjects (#1526)", () => {
  test("the default install renders no extra document", () => {
    expect(render().sources).not.toContain("libredb-studio/templates/extra-objects.yaml");
  });

  test("an object item is rendered as it is", () => {
    const { docs } = render(extraObjects(CONFIG_MAP));
    expect(docs.find((doc) => doc.metadata?.name === "my-config")).toEqual(CONFIG_MAP);
  });

  test("each item is its own document", () => {
    const { docs } = render(extraObjects(CONFIG_MAP, SECRET));
    expect(docs.find((doc) => doc.metadata?.name === "my-config")).toEqual(CONFIG_MAP);
    expect(docs.find((doc) => doc.metadata?.name === "my-secret")).toEqual(SECRET);
  });

  test("an object item can use release values and the chart's helpers through tpl", () => {
    const configMap = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "{{ .Release.Name }}-extra", namespace: "{{ .Release.Namespace }}" },
      data: { serviceAccount: '{{ include "libredb-studio.serviceAccountName" . }}' },
    };
    const { docs } = render(extraObjects(configMap));
    expect(docs.find((doc) => doc.metadata?.name === `${RELEASE}-extra`)).toEqual({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: `${RELEASE}-extra`, namespace: "studio" },
      data: { serviceAccount: `${RELEASE}-libredb-studio` },
    });
  });

  test("a string item is taken as a template", () => {
    const configMap = [
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: {{ .Release.Name }}-extra",
      "data:",
      "  namespace: {{ .Release.Namespace }}",
    ].join("\n");
    const { docs } = render(extraObjects(configMap));
    const rendered = docs.find((doc) => doc.metadata?.name === `${RELEASE}-extra`);
    expect(rendered?.kind).toBe("ConfigMap");
    expect(rendered?.data).toEqual({ namespace: "studio" });
  });

  test('a literal {{ fails the render, and the README\'s {{ "{{" }} escape keeps it', () => {
    const alertText = (summary: string) => ({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "alert-text" },
      data: { summary },
    });
    expect(() => render(extraObjects(alertText("{{ $labels.instance }} is down")))).toThrow(
      'undefined variable "$labels"',
    );
    const { docs } = render(extraObjects(alertText('{{ "{{" }} $labels.instance }} is down')));
    expect(docs.find((doc) => doc.metadata?.name === "alert-text")?.data).toEqual({
      summary: "{{ $labels.instance }} is down",
    });
  });
});
