// @requires helm
/**
 * config.passkeyOrigin (#785).
 *
 * The value is written to PASSKEY_ORIGIN only when set, so every install that
 * does not ask for passkeys renders exactly as before. The app validates the
 * value itself; the schema only insists on a string. NOTES.txt warns about a
 * value that cannot work (a browser-local store, or OIDC sign-in) and suggests
 * one built from the ingress host when everything else a passkey needs is
 * already configured.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const RELEASE = "release-under-test";
const ORIGIN = ["--set", "config.passkeyOrigin=https://studio.example.com"];

interface RenderedManifest {
  kind: string;
  metadata: { name: string };
  data?: Record<string, string>;
}

function template(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", RELEASE, CHART_DIR, ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

/** The rendered ConfigMap's data map. */
function configMapData(args: string[]): Record<string, string> {
  const run = template(args);
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr}`);
  }
  const docs = parseAllDocuments(run.stdout).map((doc) => doc.toJSON() as RenderedManifest);
  const configMap = docs.find((doc) => doc?.kind === "ConfigMap" && doc.metadata.name.endsWith("-config"));
  if (!configMap) throw new Error("no ConfigMap manifest found in rendered chart output");
  return configMap.data ?? {};
}

describe("config.passkeyOrigin renders to the ConfigMap only when set", () => {
  test("unset writes no PASSKEY_ORIGIN", () => {
    expect(configMapData([])).not.toHaveProperty("PASSKEY_ORIGIN");
  });

  test("a value is written to the ConfigMap as given", () => {
    expect(configMapData(ORIGIN).PASSKEY_ORIGIN).toBe("https://studio.example.com");
  });

  test("the schema refuses a non-string value", () => {
    const run = template(["--set-json", "config.passkeyOrigin=1"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("/config/passkeyOrigin");
  });
});

describe("install notes about passkeys", () => {
  // helm template never emits NOTES.txt, so the real file is wrapped in a named
  // template inside a throwaway copy of the chart and rendered as a ConfigMap,
  // the technique tests/unit/helm-chart-dualstack.test.ts documents.
  const PROBE_TEMPLATE = "templates/zz-notes-probe.yaml";
  let notesChart: string;

  beforeAll(() => {
    notesChart = mkdtempSync(join(tmpdir(), "libredb-passkey-notes-probe-"));
    cpSync(CHART_DIR, notesChart, { recursive: true });
    writeFileSync(
      join(notesChart, PROBE_TEMPLATE),
      `{{- define "notesProbe" -}}\n${readFileSync(join(CHART_DIR, "templates/NOTES.txt"), "utf8")}\n{{- end -}}\n` +
        'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: notes-probe\ndata:\n  notes: {{ include "notesProbe" . | quote }}\n',
    );
  });

  afterAll(() => rmSync(notesChart, { recursive: true, force: true }));

  function notes(args: string[]): string {
    const run = Bun.spawnSync(["helm", "template", RELEASE, notesChart, "--show-only", PROBE_TEMPLATE, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (run.exitCode !== 0) {
      throw new Error(`helm template of the notes probe failed (exit ${run.exitCode}): ${run.stderr.toString()}`);
    }
    const rendered = parseAllDocuments(run.stdout.toString())
      .map((document) => document.toJS() as { data?: { notes?: string } } | null)
      .find((document) => document?.data?.notes !== undefined);
    if (!rendered) {
      throw new Error(`the notes probe rendered no ConfigMap: ${run.stdout.toString()}`);
    }
    return rendered.data?.notes ?? "";
  }

  const TLS_INGRESS = [
    "--set",
    "ingress.enabled=true",
    "--set",
    "ingress.hosts[0].host=libredb.example.com",
    "--set",
    "ingress.tls[0].secretName=t",
    "--set",
    "ingress.tls[0].hosts[0]=libredb.example.com",
  ];
  const SUGGESTION = "config.passkeyOrigin=https://libredb.example.com";

  test("NOTES say nothing about passkeys by default", () => {
    expect(notes([]).toLowerCase()).not.toContain("passkey");
  });

  test("NOTES warn when passkeyOrigin is set but the storage provider is local", () => {
    const output = notes(ORIGIN);
    expect(output).toContain("WARNING");
    expect(output).toContain("config.storageProvider");
    expect(output.match(/WARNING/g)).toHaveLength(1);
  });

  test("NOTES stay quiet when passkeyOrigin is set with a server store and local auth", () => {
    expect(notes([...ORIGIN, "--set", "config.storageProvider=sqlite"]).toLowerCase()).not.toContain("passkey");
  });

  test("NOTES warn when passkeyOrigin is set with an auth provider other than local", () => {
    const output = notes([...ORIGIN, "--set", "authProvider=oidc", "--set", "config.storageProvider=postgres"]);
    expect(output).toContain("WARNING");
    expect(output).toContain("authProvider");
    expect(output.match(/WARNING/g)).toHaveLength(1);
  });

  test("NOTES suggest passkeyOrigin from the ingress host when a server store is configured and it is empty", () => {
    const lines = notes(["--set", "postgresql.enabled=true", ...TLS_INGRESS])
      .split("\n")
      .filter((line) => line.includes(SUGGESTION));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("--set config.passkeyOrigin=https://libredb.example.com");
  });

  test("NOTES suggest nothing when the first ingress host is empty or missing", () => {
    const tls = [
      "--set",
      "postgresql.enabled=true",
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.tls[0].secretName=t",
    ];
    for (const hosts of ['ingress.hosts=[{"host":""}]', 'ingress.hosts=[{"paths":[]}]', "ingress.hosts=[]"]) {
      const output = notes([...tls, "--set-json", hosts]);
      expect(output).not.toContain("passkeyOrigin=https://");
      expect(output.toLowerCase()).not.toContain("passkey");
    }
  });

  test("NOTES suggest nothing when passkeyOrigin is already set", () => {
    const output = notes(["--set", "postgresql.enabled=true", ...TLS_INGRESS, ...ORIGIN]);
    expect(output).not.toContain(SUGGESTION);
    expect(output).not.toContain("WARNING");
  });

  test("NOTES suggest nothing behind a plain-http ingress", () => {
    const output = notes([
      "--set",
      "postgresql.enabled=true",
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.hosts[0].host=libredb.example.com",
    ]);
    expect(output.toLowerCase()).not.toContain("passkey");
  });

  test("NOTES suggest nothing with a browser-local store or with OIDC sign-in", () => {
    expect(notes(TLS_INGRESS).toLowerCase()).not.toContain("passkey");
    expect(notes(["--set", "postgresql.enabled=true", "--set", "authProvider=oidc", ...TLS_INGRESS])).not.toContain(
      SUGGESTION,
    );
  });
});

describe("the chart documents config.passkeyOrigin", () => {
  test("values.yaml carries the key, empty by default", async () => {
    const values = await Bun.file(join(CHART_DIR, "values.yaml")).text();
    expect(values).toContain('passkeyOrigin: ""');
  });
});
