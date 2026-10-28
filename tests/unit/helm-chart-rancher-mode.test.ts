// @requires helm
/**
 * The first half of the chart's Rancher mode: five values a Rancher install sets and every
 * other install leaves alone.
 *
 *  - config.allowCustomConnections and config.seedLiteralValues wire ALLOW_CUSTOM_CONNECTIONS
 *    and SEED_LITERAL_VALUES, which until now were reachable only through extraEnv.
 *  - seedConnections.existingSecret mounts the seed file from a Secret, because a seed file
 *    that holds passwords does not belong in a ConfigMap.
 *  - secrets.oidcExistingSecret takes only OIDC_CLIENT_ID and OIDC_CLIENT_SECRET from a named
 *    Secret. secrets.existingSecret is all or nothing: pointed at a Secret that a setup tool
 *    wrote with the client credentials alone, it would also take the JWT secret and the
 *    admin password from there and find neither.
 *  - rancher.navLink renders a ui.cattle.io/v1 NavLink, Rancher's cluster-scoped link
 *    resource, only where the cluster serves that API.
 *
 * Every value is off by default, so the default install that every other channel renders is
 * unchanged; the first block pins that.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { howItFailed } from "../helpers/spawn-outcome";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const RELEASE = "release-under-test";
const NAMESPACE = "libredb-studio";
const NAVLINK_API = ["--api-versions", "ui.cattle.io/v1/NavLink"];

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean } };
}

interface Volume {
  name: string;
  configMap?: { name: string };
  secret?: { secretName: string };
}

interface RenderedManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  data?: Record<string, string>;
  spec?: {
    label?: string;
    group?: string;
    target?: string;
    toURL?: string;
    iconSrc?: string;
    template?: {
      spec: {
        containers: Array<{ name: string; env?: EnvVar[]; volumeMounts?: Array<{ name: string; mountPath: string }> }>;
        volumes?: Volume[];
      };
    };
  };
}

function template(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", RELEASE, CHART_DIR, "--namespace", NAMESPACE, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function render(args: string[]): RenderedManifest[] {
  const run = template(args);
  if (run.exitCode !== 0) {
    throw new Error(`helm template ${howItFailed(run)}: ${run.stderr}`);
  }
  return parseAllDocuments(run.stdout)
    .map((doc) => doc.toJSON() as RenderedManifest)
    .filter(Boolean);
}

function configMapData(args: string[]): Record<string, string> {
  const configMap = render(args).find((doc) => doc.kind === "ConfigMap" && doc.metadata.name.endsWith("-config"));
  if (!configMap) throw new Error("no ConfigMap manifest found in rendered chart output");
  return configMap.data ?? {};
}

function podSpec(args: string[]) {
  const deployment = render(args).find((doc) => doc.kind === "Deployment");
  const spec = deployment?.spec?.template?.spec;
  if (!spec) throw new Error("no Deployment pod spec found in rendered chart output");
  return spec;
}

function env(args: string[]): EnvVar[] {
  return podSpec(args).containers[0]?.env ?? [];
}

function navLinks(args: string[]): RenderedManifest[] {
  return render(args).filter((doc) => doc.kind === "NavLink");
}

function refused(args: string[], ...needles: string[]): void {
  const run = template(args);
  expect(run.exitCode).not.toBe(0);
  for (const needle of needles) expect(run.stderr).toContain(needle);
}

const OIDC = ["--set", "authProvider=oidc", "--set", "config.oidcIssuer=https://rancher.example.com/oidc"];
const INGRESS = ["--set", "ingress.enabled=true", "--set", "ingress.hosts[0].host=studio.example.com"];
const LOGO = readFileSync(join(import.meta.dir, "../../public/logo.svg"));
const LOGO_DATA_URI = `data:image/svg+xml;base64,${LOGO.toString("base64")}`;

describe("Rancher mode values are off by default", () => {
  test("the default install writes none of the new keys, objects or references", () => {
    const docs = render(NAVLINK_API);
    expect(docs.some((doc) => doc.kind === "NavLink")).toBe(false);
    const data = configMapData([]);
    expect(data).not.toHaveProperty("ALLOW_CUSTOM_CONNECTIONS");
    expect(data).not.toHaveProperty("SEED_LITERAL_VALUES");
    expect(env([]).some((entry) => entry.name.startsWith("OIDC_"))).toBe(false);
  });

  test("values.yaml documents every new key", async () => {
    const values = await Bun.file(join(CHART_DIR, "values.yaml")).text();
    for (const key of [
      "allowCustomConnections: null",
      "seedLiteralValues: false",
      'oidcExistingSecret: ""',
      "navLink:",
    ]) {
      expect(values).toContain(key);
    }
    expect(values).toMatch(/seedConnections:[\s\S]*existingSecret: ""/);
  });
});

describe("config.allowCustomConnections renders three-state", () => {
  test("an explicit null is the same as unset", () => {
    expect(configMapData(["--set", "config.allowCustomConnections=null"])).not.toHaveProperty(
      "ALLOW_CUSTOM_CONNECTIONS",
    );
  });

  test("false is written, the arm a truthiness condition would drop", () => {
    expect(configMapData(["--set", "config.allowCustomConnections=false"]).ALLOW_CUSTOM_CONNECTIONS).toBe("false");
  });

  test("true is written", () => {
    expect(configMapData(["--set", "config.allowCustomConnections=true"]).ALLOW_CUSTOM_CONNECTIONS).toBe("true");
  });

  test("a string spelling is refused by the schema, since the app reads an unknown value as off", () => {
    refused(["--set-string", "config.allowCustomConnections=off"], "/config/allowCustomConnections");
  });

  test("governance refuses true, which the app's governance preflight would refuse at start", () => {
    refused(
      [
        "--set",
        "governance.enabled=true",
        "--set",
        "config.allowCustomConnections=true",
        ...OIDC,
        "--set",
        "config.oidcRoleClaim=roles",
        "--set",
        "config.oidcUserRoles=user",
        "--set",
        "config.storagePostgresSchema=studio",
        "--set",
        "secrets.governancePostgresUrl=postgresql://studio@db.example.com/studio",
        "--set",
        "secrets.governancePrivateKeys=not-a-real-keyring",
        "--set",
        "config.storageProvider=postgres",
        "--set",
        "secrets.storagePostgresUrl=postgresql://studio@db.example.com/studio",
      ],
      "config.allowCustomConnections",
    );
  });
});

describe("config.seedLiteralValues", () => {
  test("true writes SEED_LITERAL_VALUES", () => {
    expect(configMapData(["--set", "config.seedLiteralValues=true"]).SEED_LITERAL_VALUES).toBe("true");
  });

  test("false writes nothing", () => {
    expect(configMapData(["--set", "config.seedLiteralValues=false"])).not.toHaveProperty("SEED_LITERAL_VALUES");
  });

  test("a string is refused by the schema", () => {
    refused(["--set-string", "config.seedLiteralValues=yes"], "/config/seedLiteralValues");
  });
});

describe("seedConnections.existingSecret", () => {
  const SEED_SECRET = ["--set", "seedConnections.enabled=true", "--set", "seedConnections.existingSecret=seeds"];

  test("mounts the named Secret at /app/config and renders no seed ConfigMap", () => {
    const docs = render(SEED_SECRET);
    expect(docs.some((doc) => doc.kind === "ConfigMap" && doc.metadata.name.endsWith("-seed-connections"))).toBe(false);
    const spec = podSpec(SEED_SECRET);
    const volume = spec.volumes?.find((entry) => entry.name === "seed-config");
    expect(volume?.secret?.secretName).toBe("seeds");
    expect(volume?.configMap).toBeUndefined();
    expect(spec.containers[0]?.volumeMounts?.find((mount) => mount.name === "seed-config")?.mountPath).toBe(
      "/app/config",
    );
    expect(env(SEED_SECRET).find((entry) => entry.name === "SEED_CONFIG_PATH")?.value).toBe(
      "/app/config/seed-connections.yaml",
    );
  });

  test("the file key follows seedConnections.configMapKey", () => {
    const args = [...SEED_SECRET, "--set", "seedConnections.configMapKey=connections.yaml"];
    expect(env(args).find((entry) => entry.name === "SEED_CONFIG_PATH")?.value).toBe("/app/config/connections.yaml");
  });

  test("satisfies the source guard on its own", () => {
    expect(template(SEED_SECRET).exitCode).toBe(0);
  });

  test("refuses a second source beside it, rather than picking one silently", () => {
    refused([...SEED_SECRET, "--set", "seedConnections.existingConfigMap=other"], "seedConnections.existingSecret");
    refused([...SEED_SECRET, "--set", "seedConnections.config.version=1"], "seedConnections.existingSecret");
  });

  test("the existing ConfigMap path is unchanged", () => {
    const args = ["--set", "seedConnections.enabled=true", "--set", "seedConnections.existingConfigMap=my-seeds"];
    expect(podSpec(args).volumes?.find((entry) => entry.name === "seed-config")?.configMap?.name).toBe("my-seeds");
  });
});

describe("secrets.oidcExistingSecret", () => {
  const OIDC_SECRET = [...OIDC, "--set", "secrets.oidcExistingSecret=libredb-studio-oidc"];

  test("sources only the two OIDC variables from the named Secret, never optional", () => {
    const vars = env(OIDC_SECRET);
    for (const [name, key] of [
      ["OIDC_CLIENT_ID", "oidc-client-id"],
      ["OIDC_CLIENT_SECRET", "oidc-client-secret"],
    ] as const) {
      const ref = vars.find((entry) => entry.name === name)?.valueFrom?.secretKeyRef;
      expect(ref).toEqual({ name: "libredb-studio-oidc", key });
    }
    for (const entry of vars) {
      if (entry.name.startsWith("OIDC_")) continue;
      expect(entry.valueFrom?.secretKeyRef?.name).not.toBe("libredb-studio-oidc");
    }
  });

  test("keeps the chart's own Secret for everything else, with no OIDC key in it", () => {
    const secret = render(OIDC_SECRET).find((doc) => doc.kind === "Secret");
    expect(secret?.metadata.name).toBe(`${RELEASE}-libredb-studio`);
    expect(Object.keys(secret?.data ?? {})).not.toContain("oidc-client-id");
    expect(Object.keys(secret?.data ?? {})).not.toContain("oidc-client-secret");
  });

  test("the key names follow secrets.existingSecretKeys", () => {
    const args = [...OIDC_SECRET, "--set", "secrets.existingSecretKeys.oidcClientId=client-id"];
    expect(env(args).find((entry) => entry.name === "OIDC_CLIENT_ID")?.valueFrom?.secretKeyRef?.key).toBe("client-id");
  });

  test("refuses secrets.existingSecret beside it", () => {
    refused([...OIDC_SECRET, "--set", "secrets.existingSecret=all-in-one"], "secrets.oidcExistingSecret");
  });

  test("refuses an inline client id or secret beside it", () => {
    refused([...OIDC_SECRET, "--set", "secrets.oidcClientId=inline-id"], "secrets.oidcExistingSecret");
    refused([...OIDC_SECRET, "--set", "secrets.oidcClientSecret=not-a-real-secret"], "secrets.oidcExistingSecret");
  });

  test("refuses a provider other than oidc, which would never read it", () => {
    refused(["--set", "secrets.oidcExistingSecret=libredb-studio-oidc"], "secrets.oidcExistingSecret", "oidc");
  });
});

describe("rancher.navLink", () => {
  const NAVLINK = [...INGRESS, "--set", "rancher.navLink.enabled=true"];

  test("renders a cluster-scoped NavLink when the cluster serves the API", () => {
    const [link, ...rest] = navLinks([...NAVLINK, ...NAVLINK_API]);
    expect(rest).toHaveLength(0);
    expect(link?.apiVersion).toBe("ui.cattle.io/v1");
    expect(link?.metadata.name).toBe(`${NAMESPACE}.${RELEASE}-libredb-studio`);
    expect(link?.metadata.namespace).toBeUndefined();
    expect(link?.metadata.labels?.["app.kubernetes.io/name"]).toBe("libredb-studio");
    expect(link?.metadata.labels?.["app.kubernetes.io/instance"]).toBe(RELEASE);
    expect(link?.spec).toEqual({
      label: "LibreDB Studio",
      group: "Databases",
      target: "_blank",
      toURL: "https://studio.example.com",
      iconSrc: LOGO_DATA_URI,
    });
  });

  test("the icon is the LibreDB logo the app serves, inline so no host has to reach a URL", () => {
    // Without iconSrc Rancher draws its default book icon beside the link.
    expect(readFileSync(join(CHART_DIR, "files/logo.svg"))).toEqual(LOGO);
    const [link] = navLinks([...NAVLINK, ...NAVLINK_API]);
    expect(link?.spec?.iconSrc).toBe(LOGO_DATA_URI);
  });

  test("iconSrc is a value", () => {
    const [link] = navLinks([
      ...NAVLINK,
      ...NAVLINK_API,
      "--set",
      "rancher.navLink.iconSrc=https://icons.example.com/studio.svg",
    ]);
    expect(link?.spec?.iconSrc).toBe("https://icons.example.com/studio.svg");
  });

  test("label, group and target are values", () => {
    const [link] = navLinks([
      ...NAVLINK,
      ...NAVLINK_API,
      "--set",
      "rancher.navLink.label=SQL",
      "--set",
      "rancher.navLink.group=Tools",
      "--set",
      "rancher.navLink.target=studio",
    ]);
    expect(link?.spec).toMatchObject({ label: "SQL", group: "Tools", target: "studio" });
  });

  test("toURL carries config.basePath", () => {
    const [link] = navLinks([...NAVLINK, ...NAVLINK_API, "--set", "config.basePath=/studio"]);
    expect(link?.spec?.toURL).toBe("https://studio.example.com/studio");
  });

  test("the name keeps the namespace and the full name apart, uncut", () => {
    // Namespace a-b with full name c and namespace a with full name b-c would both be a-b-c
    // with a hyphen. A namespace never holds a dot, so the dot cannot be read two ways.
    const name = (namespace: string, fullname: string) => {
      const run = Bun.spawnSync(
        [
          "helm",
          "template",
          RELEASE,
          CHART_DIR,
          "--namespace",
          namespace,
          ...NAVLINK,
          ...NAVLINK_API,
          "--set",
          `fullnameOverride=${fullname}`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(run.exitCode).toBe(0);
      const link = parseAllDocuments(run.stdout.toString())
        .map((doc) => doc.toJSON() as RenderedManifest)
        .find((doc) => doc?.kind === "NavLink");
      return link?.metadata.name;
    };
    expect(name("a-b", "c")).toBe("a-b.c");
    expect(name("a", "b-c")).toBe("a.b-c");
    const long = "x".repeat(62);
    expect(name(NAMESPACE, `${long}1`)).toBe(`${NAMESPACE}.${long}1`);
    expect(name(NAMESPACE, `${long}2`)).toBe(`${NAMESPACE}.${long}2`);
  });

  test("keeps the label the extension selects on when nameOverride is set", () => {
    const [link] = navLinks([...NAVLINK, ...NAVLINK_API, "--set", "nameOverride=foo"]);
    expect(link?.metadata.labels?.["app.kubernetes.io/name"]).toBe("libredb-studio");
    expect(link?.metadata.labels?.["app.kubernetes.io/instance"]).toBe(RELEASE);
    const deployment = render([...NAVLINK, ...NAVLINK_API, "--set", "nameOverride=foo"]).find(
      (doc) => doc.kind === "Deployment",
    );
    expect(deployment?.metadata.labels?.["app.kubernetes.io/name"]).toBe("foo");
  });

  test("renders nothing where the cluster does not serve the API", () => {
    expect(navLinks(NAVLINK)).toHaveLength(0);
  });

  test("refuses to render without an ingress host to link to", () => {
    refused(["--set", "rancher.navLink.enabled=true", ...NAVLINK_API], "rancher.navLink", "ingress");
    refused(
      [
        "--set",
        "rancher.navLink.enabled=true",
        "--set",
        "ingress.enabled=true",
        "--set",
        "ingress.hosts[0].host=",
        ...NAVLINK_API,
      ],
      "rancher.navLink",
      "ingress.hosts",
    );
  });

  test("refuses a wildcard first ingress host, which is no address to open", () => {
    refused(
      [
        "--set",
        "rancher.navLink.enabled=true",
        "--set",
        "ingress.enabled=true",
        "--set",
        "ingress.hosts[0].host=*.example.com",
        ...NAVLINK_API,
      ],
      "rancher.navLink.enabled requires a concrete first ingress host, not a wildcard",
    );
  });

  test("the schema refuses an unknown key under rancher.navLink", () => {
    refused(["--set", "rancher.navLink.url=https://elsewhere.example.com"], "url");
  });
});

describe("install notes about the NavLink", () => {
  // helm template never emits NOTES.txt, so the real file is wrapped in a named template inside a
  // throwaway copy of the chart and rendered as a ConfigMap, as tests/unit/helm-chart-passkey.test.ts does.
  const PROBE_TEMPLATE = "templates/zz-notes-probe.yaml";
  const NAVLINK = [...INGRESS, "--set", "rancher.navLink.enabled=true"];
  const WARNING = "this cluster serves no ui.cattle.io/v1 NavLink";
  let notesChart: string;

  beforeAll(() => {
    notesChart = mkdtempSync(join(tmpdir(), "libredb-navlink-notes-probe-"));
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
      throw new Error(`helm template of the notes probe ${howItFailed(run)}: ${run.stderr.toString()}`);
    }
    const rendered = parseAllDocuments(run.stdout.toString())
      .map((document) => document.toJS() as { data?: { notes?: string } } | null)
      .find((document) => document?.data?.notes !== undefined);
    return rendered?.data?.notes ?? "";
  }

  test("say the link was not created where the cluster does not serve the API", () => {
    expect(notes(NAVLINK)).toContain(WARNING);
  });

  test("say nothing about it where the API is served, or when the link is off", () => {
    expect(notes([...NAVLINK, ...NAVLINK_API])).not.toContain(WARNING);
    expect(notes([])).not.toContain(WARNING);
  });
});
