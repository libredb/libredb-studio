/**
 * Regression tests for the chart's dual-stack Service surface
 * (service.ipFamilyPolicy / service.ipFamilies), added for #432:
 *
 *   1. The default render must stay byte-unchanged. Kubernetes does not treat
 *      an omitted ipFamilyPolicy as a static SingleStack default: on CREATE it
 *      is SingleStack, but on UPDATE it is inherited from the live object, and
 *      an *explicit* SingleStack is read as clear intent to truncate - the API
 *      server trims spec.clusterIPs and spec.ipFamilies back to one entry,
 *      releasing the secondary clusterIP of a Service somebody else made
 *      dual-stack. So both fields must be rendered only when set, never
 *      defaulted, or every existing install gets a spec diff on `helm upgrade`
 *      and some get a silent downgrade.
 *   2. ipFamilies is ordered: entry 0 is the primary family, it is what
 *      spec.clusterIPs[0] (and the legacy spec.clusterIP every IPv4-only
 *      client reads) is allocated from, and it is immutable once set. A
 *      template that emitted the list in map/sorted order rather than the
 *      given order would silently hand users the other primary family.
 *   3. Two families with ipFamilyPolicy left at SingleStack is a hard API
 *      server rejection ("must be 'RequireDualStack' or 'PreferDualStack'
 *      when multiple IP families are specified"), and it is the most likely
 *      way to hold this feature wrong - set the families, forget the policy.
 *      The chart must refuse that at render time with a message that names
 *      both keys, the way templates/deployment.yaml refuses the other
 *      combinations it cannot ship working, instead of letting the error
 *      surface only against a live cluster at install time.
 *   4. The values.schema.json entries are what make `helm lint --strict` and
 *      every render reject a typo (`preferdualstack`, `ipv6`, three entries,
 *      a duplicate) before it reaches the API server.
 *   5. A dual-stack Service in front of a container that only bound an IPv4
 *      address advertises an IPv6 address that answers every connection with a
 *      TCP RST: Kubernetes never checks what the process bound, the pod has an
 *      IPv6 address on a dual-stack cluster, so the IPv6 EndpointSlice is
 *      populated and kube-proxy routes to a port nothing listens on - and
 *      kubelet's probes only ever hit the primary podIP, so the pod stays
 *      Ready forever. Since chart 0.1.41 the Service fields are the WHOLE
 *      recipe: the ConfigMap ships `HOSTNAME: ""`, the sentinel for "nobody
 *      chose", and the image's entrypoint resolves a bind address that it
 *      proves is dual-stack before it uses it. Three parts of that contract
 *      are locked here, because each can be broken silently: the default
 *      renders an EMPTY HOSTNAME (not `0.0.0.0`, and not an omitted key - an
 *      omitted key would let the container id or pod name a runtime injects
 *      reach the server as a bind address), `config.bindAddress` renders
 *      through to it, and an `extraEnv` HOSTNAME still overrides it because an
 *      explicit `env` entry beats `envFrom`.
 *   6. The pairing that stays silently broken is the INVERSE one: an IPv4
 *      literal pinned in `config.bindAddress`, or in an `extraEnv` HOSTNAME
 *      that wins over it, in front of a Service that asks for an IPv6 address -
 *      green install, IPv6 EndpointSlice populated, pod Ready, every IPv6
 *      connection refused. So the install notes must warn on exactly that
 *      pairing and on nothing else: the default dual-stack render must stay
 *      quiet (warning about it would train operators to ignore the notes),
 *      the way NOTES.txt already warns about the other two combinations the
 *      chart renders but cannot make work (sqlite + replicas, sqlite +
 *      autoscaling).
 *
 * Exercises the real `helm template` output against the actual chart - no
 * reimplementation of the templating logic (same approach as
 * helm-chart-route.test.ts and helm-chart-openshift.test.ts). The operator's
 * embedded copy of the chart is a byte-for-byte mirror enforced by
 * scripts/sync-chart-version.mjs, so the files this feature touches are
 * compared against it too: a hand-edit that reaches only one of the two trees
 * must fail here as well.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const OPERATOR_CHART_DIR = join(import.meta.dir, "../../operator/helm-charts/libredb-studio");

const DUAL_STACK = [
  "--set",
  "service.ipFamilyPolicy=PreferDualStack",
  "--set-json",
  'service.ipFamilies=["IPv4","IPv6"]',
];

interface RenderedManifest {
  kind: string;
  metadata: { name: string };
  data?: Record<string, string>;
  spec?: {
    type?: string;
    ipFamilyPolicy?: string;
    ipFamilies?: string[];
    ports?: Array<{ port: number; targetPort: number }>;
    template?: {
      spec?: {
        containers?: Array<{ env?: Array<{ name: string; value?: string }> }>;
      };
    };
  };
}

function helmTemplate(args: string[], chartDir = CHART_DIR): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", "release-under-test", chartDir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function renderDocs(args: string[], chartDir = CHART_DIR): RenderedManifest[] {
  const run = helmTemplate(args, chartDir);
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr}`);
  }
  return parseAllDocuments(run.stdout)
    .map((doc) => doc.toJSON() as RenderedManifest)
    .filter((doc) => doc != null);
}

function service(args: string[], chartDir = CHART_DIR): RenderedManifest {
  const svc = renderDocs(args, chartDir).find((doc) => doc.kind === "Service");
  if (!svc) {
    throw new Error("Service not found in render output");
  }
  return svc;
}

function serviceSource(args: string[], chartDir = CHART_DIR): string {
  const run = helmTemplate([...args, "-s", "templates/service.yaml"], chartDir);
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr}`);
  }
  return run.stdout;
}

describe("charts/libredb-studio Service address families: the default render (#432)", () => {
  // Absent, not falsy: an emitted `ipFamilyPolicy: SingleStack` is a live
  // instruction to the API server, not a no-op, and an emitted `ipFamilies: []`
  // is a spec diff on every existing install.
  test("the default Service carries neither ipFamilyPolicy nor ipFamilies", () => {
    const svc = service([]);
    expect(svc.spec).not.toHaveProperty("ipFamilyPolicy");
    expect(svc.spec).not.toHaveProperty("ipFamilies");
  });

  test("the default Service manifest mentions no address family at all", () => {
    expect(serviceSource([])).not.toContain("ipFamil");
  });

  // values.yaml ships the keys as empty ("" / []) so they are discoverable and
  // schema-typed; empty must render exactly like unset.
  test("explicitly empty values render nothing", () => {
    const source = serviceSource(["--set", "service.ipFamilyPolicy=", "--set-json", "service.ipFamilies=[]"]);
    expect(source).not.toContain("ipFamil");
  });

  test("the default Service is otherwise unchanged", () => {
    const svc = service([]);
    expect(svc.spec?.type).toBe("ClusterIP");
    expect(svc.spec?.ports?.[0]).toMatchObject({ port: 80, targetPort: 3000 });
  });
});

describe("charts/libredb-studio Service address families: opting in (#432)", () => {
  test("service.ipFamilyPolicy renders on its own", () => {
    const svc = service(["--set", "service.ipFamilyPolicy=PreferDualStack"]);
    expect(svc.spec?.ipFamilyPolicy).toBe("PreferDualStack");
    expect(svc.spec).not.toHaveProperty("ipFamilies");
  });

  test("RequireDualStack renders too", () => {
    expect(service(["--set", "service.ipFamilyPolicy=RequireDualStack"]).spec?.ipFamilyPolicy).toBe("RequireDualStack");
  });

  test("SingleStack renders when it is asked for explicitly", () => {
    expect(service(["--set", "service.ipFamilyPolicy=SingleStack"]).spec?.ipFamilyPolicy).toBe("SingleStack");
  });

  test("a single family renders under the default SingleStack policy", () => {
    expect(service(["--set-json", 'service.ipFamilies=["IPv6"]']).spec?.ipFamilies).toEqual(["IPv6"]);
  });

  // Entry 0 is the primary family: it decides which family spec.clusterIP gets,
  // and it can never be changed on a live Service.
  test("service.ipFamilies renders in the order given, IPv4 first", () => {
    const svc = service(DUAL_STACK);
    expect(svc.spec?.ipFamilyPolicy).toBe("PreferDualStack");
    expect(svc.spec?.ipFamilies).toEqual(["IPv4", "IPv6"]);
  });

  test("service.ipFamilies renders in the order given, IPv6 first", () => {
    const svc = service([
      "--set",
      "service.ipFamilyPolicy=PreferDualStack",
      "--set-json",
      'service.ipFamilies=["IPv6","IPv4"]',
    ]);
    expect(svc.spec?.ipFamilies).toEqual(["IPv6", "IPv4"]);
  });

  test("the address families apply to a NodePort Service as well", () => {
    const svc = service([...DUAL_STACK, "--set", "service.type=NodePort"]);
    expect(svc.spec?.type).toBe("NodePort");
    expect(svc.spec?.ipFamilies).toEqual(["IPv4", "IPv6"]);
  });
});

describe("charts/libredb-studio Service address families: the policy guard (#432)", () => {
  // The API server rejects this outright; catching it at render time turns a
  // failed `helm upgrade` against a live cluster into a message with both keys
  // in it.
  test("two families with the policy left unset fails the render", () => {
    const run = helmTemplate(["--set-json", 'service.ipFamilies=["IPv4","IPv6"]']);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("service.ipFamilyPolicy");
    expect(run.stderr).toContain("service.ipFamilies");
  });

  test("two families with an explicit SingleStack policy fails the render", () => {
    const run = helmTemplate([
      "--set",
      "service.ipFamilyPolicy=SingleStack",
      "--set-json",
      'service.ipFamilies=["IPv4","IPv6"]',
    ]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("service.ipFamilyPolicy");
  });

  test("the failure names the policies that would work", () => {
    const run = helmTemplate(["--set-json", 'service.ipFamilies=["IPv4","IPv6"]']);
    expect(run.stderr).toContain("PreferDualStack");
    expect(run.stderr).toContain("RequireDualStack");
  });

  test("PreferDualStack clears the guard", () => {
    expect(helmTemplate(DUAL_STACK).exitCode).toBe(0);
  });

  test("RequireDualStack clears the guard", () => {
    const run = helmTemplate([
      "--set",
      "service.ipFamilyPolicy=RequireDualStack",
      "--set-json",
      'service.ipFamilies=["IPv4","IPv6"]',
    ]);
    expect(run.exitCode).toBe(0);
  });
});

describe("charts/libredb-studio Service address families: schema validation (#432)", () => {
  test("an unknown ipFamilyPolicy fails schema validation", () => {
    const run = helmTemplate(["--set", "service.ipFamilyPolicy=DualStack"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("ipFamilyPolicy");
  });

  // Kubernetes matches the family names case-sensitively; a lowercase value is
  // the kind of typo that otherwise only fails on the cluster.
  test("a miscased ipFamilyPolicy fails schema validation", () => {
    const run = helmTemplate(["--set", "service.ipFamilyPolicy=preferDualStack"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("ipFamilyPolicy");
  });

  test("a scalar ipFamilies fails schema validation", () => {
    const run = helmTemplate(["--set", "service.ipFamilies=broken"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("ipFamilies");
  });

  test("an unknown family name fails schema validation", () => {
    const run = helmTemplate([
      "--set",
      "service.ipFamilyPolicy=PreferDualStack",
      "--set-json",
      'service.ipFamilies=["ipv6"]',
    ]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("ipFamilies");
  });

  // The API server allows at most two entries and rejects a repeat as a
  // Duplicate; the schema mirrors both checks.
  test("more than two families fails schema validation", () => {
    const run = helmTemplate([
      "--set",
      "service.ipFamilyPolicy=PreferDualStack",
      "--set-json",
      'service.ipFamilies=["IPv4","IPv6","IPv4"]',
    ]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("ipFamilies");
  });

  test("a repeated family fails schema validation", () => {
    const run = helmTemplate([
      "--set",
      "service.ipFamilyPolicy=PreferDualStack",
      "--set-json",
      'service.ipFamilies=["IPv6","IPv6"]',
    ]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("ipFamilies");
  });
});

describe("charts/libredb-studio config.bindAddress reaches the container (#432)", () => {
  function appEnv(args: string[]): Array<{ name: string; value?: string }> {
    const deployment = renderDocs(args).find((doc) => doc.kind === "Deployment");
    return deployment?.spec?.template?.spec?.containers?.[0]?.env ?? [];
  }

  function configData(args: string[]): Record<string, string> {
    const configMap = renderDocs(args).find((doc) => doc.kind === "ConfigMap" && doc.metadata.name.endsWith("-config"));
    if (!configMap) {
      throw new Error("app ConfigMap not found in render output");
    }
    return configMap.data ?? {};
  }

  // Empty, and PRESENT. Rendering "0.0.0.0" here would pin every install back
  // to IPv4 and undo #432; omitting the key entirely would be worse than
  // either, because the container then inherits whatever HOSTNAME the runtime
  // injects - a pod name or a container id - as its bind address.
  test("the default ConfigMap ships an empty HOSTNAME, not 0.0.0.0", () => {
    expect(configData([])).toHaveProperty("HOSTNAME", "");
  });

  test("the default render leaves the resolver in charge even with a dual-stack Service", () => {
    expect(configData(DUAL_STACK).HOSTNAME).toBe("");
    expect(appEnv(DUAL_STACK).find((entry) => entry.name === "HOSTNAME")).toBeUndefined();
  });

  // The chart-level way to overrule the resolver, in both directions.
  test("config.bindAddress=:: renders through to HOSTNAME", () => {
    expect(configData(["--set-string", "config.bindAddress=::"]).HOSTNAME).toBe("::");
  });

  test("config.bindAddress=0.0.0.0 pins the container back to IPv4", () => {
    expect(configData(["--set", "config.bindAddress=0.0.0.0"]).HOSTNAME).toBe("0.0.0.0");
  });

  // An explicit env entry beats the envFrom ConfigMap key of the same name, so
  // extraEnv remains the last word whatever the ConfigMap says.
  test("extraEnv HOSTNAME=:: renders alongside the dual-stack Service", () => {
    const args = [...DUAL_STACK, "--set", "extraEnv[0].name=HOSTNAME", "--set-string", "extraEnv[0].value=::"];
    expect(appEnv(args).find((entry) => entry.name === "HOSTNAME")?.value).toBe("::");
    expect(service(args).spec?.ipFamilies).toEqual(["IPv4", "IPv6"]);
  });

  test("extraEnv HOSTNAME still renders when config.bindAddress is set too", () => {
    const args = [
      "--set",
      "config.bindAddress=0.0.0.0",
      "--set",
      "extraEnv[0].name=HOSTNAME",
      "--set-string",
      "extraEnv[0].value=::",
    ];
    expect(configData(args).HOSTNAME).toBe("0.0.0.0");
    expect(appEnv(args).find((entry) => entry.name === "HOSTNAME")?.value).toBe("::");
  });

  test("a non-string bindAddress fails schema validation", () => {
    const run = helmTemplate(["--set-json", "config.bindAddress=true"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("bindAddress");
  });
});

describe("charts/libredb-studio install notes warn about an IPv4-pinned pod (#432)", () => {
  // `helm template` never emits NOTES.txt, and `helm install --dry-run=client`
  // renders it only on Helm 4: Helm 3.16 calls IsReachable() before it renders
  // anything, so the dry run dies on "Kubernetes cluster unreachable" even for
  // a chart created by `helm create`. CI's test lane now runs Helm 4, but
  // contributors run whatever helm they have, and helm-release's ct install job
  // is still Helm 3.16 on purpose - so this stays written to hold on BOTH
  // majors: render the real NOTES.txt through the one path that needs no
  // cluster on either version, a throwaway copy of the chart in which the
  // file's own bytes are wrapped in a named template and emitted as a
  // ConfigMap. Helm does the rendering, the template text is the shipped one,
  // and nothing here reimplements the condition under test.
  const notesChart = mkdtempSync(join(tmpdir(), "libredb-notes-probe-"));
  cpSync(CHART_DIR, notesChart, { recursive: true });
  const PROBE_TEMPLATE = "templates/zz-notes-probe.yaml";
  writeFileSync(
    join(notesChart, PROBE_TEMPLATE),
    `{{- define "notesProbe" -}}\n${readFileSync(join(CHART_DIR, "templates/NOTES.txt"), "utf8")}\n{{- end -}}\n` +
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: notes-probe\ndata:\n  notes: {{ include "notesProbe" . | quote }}\n',
  );
  afterAll(() => rmSync(notesChart, { recursive: true, force: true }));

  function notes(args: string[]): string {
    const run = Bun.spawnSync(
      ["helm", "template", "release-under-test", notesChart, "--show-only", PROBE_TEMPLATE, ...args],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (run.exitCode !== 0) {
      throw new Error(`helm template of the notes probe failed (exit ${run.exitCode}): ${run.stderr.toString()}`);
    }
    // Only the probe ConfigMap comes back, so unlike the full dry-run output
    // there is no surrounding manifest whose own "IPv6" and "HOSTNAME" strings
    // would satisfy the absence checks for the wrong reason.
    const rendered = parseAllDocuments(run.stdout.toString())
      .map((document) => document.toJS() as { data?: { notes?: string } } | null)
      .find((document) => document?.data?.notes !== undefined);
    if (!rendered) {
      throw new Error(`the notes probe rendered no ConfigMap: ${run.stdout.toString()}`);
    }
    return rendered.data?.notes ?? "";
  }

  /** The pin that must be warned about, delivered through the chart value. */
  const IPV4_PIN = ["--set", "config.bindAddress=0.0.0.0"];
  /** The same pin delivered through extraEnv, which wins over the value. */
  const IPV4_PIN_ENV = ["--set", "extraEnv[0].name=HOSTNAME", "--set-string", "extraEnv[0].value=0.0.0.0"];

  test("the default install prints no address-family warning", () => {
    expect(notes([])).not.toContain("IPv6");
  });

  // The whole point of #432: asking for a dual-stack Service is now ONE
  // setting, so the notes must stay quiet about it. A warning here would be
  // advice to do nothing, and notes that cry wolf stop being read.
  test("a dual-stack Service on its own prints no warning", () => {
    expect(notes(DUAL_STACK)).not.toContain("WARNING");
    expect(notes(["--set", "service.ipFamilyPolicy=PreferDualStack"])).not.toContain("WARNING");
    expect(notes(["--set", "service.ipFamilyPolicy=RequireDualStack"])).not.toContain("WARNING");
    expect(notes(["--set-json", 'service.ipFamilies=["IPv6"]'])).not.toContain("WARNING");
  });

  test("an explicitly dual-stack bind address prints no warning either", () => {
    expect(notes([...DUAL_STACK, "--set-string", "config.bindAddress=::"])).not.toContain("WARNING");
  });

  // The one pairing that is still silently broken: the Service advertises an
  // IPv6 address, the container is pinned to a listener that cannot answer it.
  test("an IPv4 pin under a dual-stack Service warns", () => {
    const output = notes([...DUAL_STACK, ...IPV4_PIN]);
    expect(output).toContain("WARNING");
    expect(output).toContain("0.0.0.0");
  });

  test("the policy alone plus an IPv4 pin warns", () => {
    expect(notes(["--set", "service.ipFamilyPolicy=PreferDualStack", ...IPV4_PIN])).toContain("WARNING");
  });

  test("RequireDualStack plus an IPv4 pin warns", () => {
    expect(notes(["--set", "service.ipFamilyPolicy=RequireDualStack", ...IPV4_PIN])).toContain("WARNING");
  });

  // A single IPv6 family needs no policy, so the render guard never sees it.
  test("a single IPv6 family with no policy warns about an IPv4 pin", () => {
    expect(notes(["--set-json", 'service.ipFamilies=["IPv6"]', ...IPV4_PIN])).toContain("WARNING");
  });

  // Any IPv4 literal, not just the old default: 127.0.0.1 in a container is
  // reachable from nothing at all, and the warning must name what it found.
  test("a loopback pin warns and names the address it found", () => {
    const output = notes([...DUAL_STACK, "--set-string", "config.bindAddress=127.0.0.1"]);
    expect(output).toContain("WARNING");
    expect(output).toContain("127.0.0.1");
  });

  test("the warning carries the recipe that fixes it", () => {
    const output = notes([...DUAL_STACK, ...IPV4_PIN]);
    expect(output).toContain("config.bindAddress");
    expect(output).toContain("::");
  });

  test("an IPv4 pin without an IPv6 Service does not warn", () => {
    expect(notes(IPV4_PIN)).not.toContain("WARNING");
  });

  // The chart and the container must agree on what counts as "the operator
  // chose an address". The resolver trims before deciding, so a whitespace-only
  // value is "nobody chose" there and the pod comes up dual-stack; a chart that
  // read it as an IPv4 literal would warn about a pin that does not exist, and
  // the two halves of #432's fix would be telling the operator different things.
  test("a whitespace-only bindAddress is not an IPv4 pin, matching the resolver's trim", () => {
    expect(notes([...DUAL_STACK, "--set-string", "config.bindAddress=   "])).not.toContain("WARNING");
  });

  test("a whitespace-only extraEnv HOSTNAME is not an IPv4 pin either", () => {
    const args = [...DUAL_STACK, "--set", "extraEnv[0].name=HOSTNAME", "--set-string", "extraEnv[0].value=  "];
    expect(notes(args)).not.toContain("WARNING");
  });

  test("an explicit SingleStack policy does not warn", () => {
    expect(notes(["--set", "service.ipFamilyPolicy=SingleStack", ...IPV4_PIN])).not.toContain("WARNING");
  });

  test("a single IPv4 family does not warn", () => {
    expect(notes(["--set-json", 'service.ipFamilies=["IPv4"]', ...IPV4_PIN])).not.toContain("WARNING");
  });

  // extraEnv beats envFrom in the cluster, so the resolver here must read it
  // the same way - in BOTH directions, or the warning follows the wrong value.
  test("an extraEnv HOSTNAME of :: silences a config.bindAddress pin", () => {
    const output = notes([
      ...DUAL_STACK,
      ...IPV4_PIN,
      "--set",
      "extraEnv[0].name=HOSTNAME",
      "--set-string",
      "extraEnv[0].value=::",
    ]);
    expect(output).not.toContain("WARNING");
  });

  test("an extraEnv HOSTNAME of 0.0.0.0 warns even when config.bindAddress is ::", () => {
    const output = notes([...DUAL_STACK, "--set-string", "config.bindAddress=::", ...IPV4_PIN_ENV]);
    expect(output).toContain("WARNING");
    expect(output).toContain("0.0.0.0");
  });

  // The helper scans the whole list, so a HOSTNAME that is not entry 0 counts.
  test("an IPv4 HOSTNAME after another extraEnv entry still warns", () => {
    const output = notes([
      ...DUAL_STACK,
      "--set",
      "extraEnv[0].name=ALLOWED_ORIGINS",
      "--set",
      "extraEnv[0].value=https://libredb.example.com",
      "--set",
      "extraEnv[1].name=HOSTNAME",
      "--set-string",
      "extraEnv[1].value=0.0.0.0",
    ]);
    expect(output).toContain("WARNING");
  });

  test("an unrelated extraEnv entry leaves the default unpinned and quiet", () => {
    const output = notes([
      ...DUAL_STACK,
      "--set",
      "extraEnv[0].name=ALLOWED_ORIGINS",
      "--set",
      "extraEnv[0].value=https://libredb.example.com",
    ]);
    expect(output).not.toContain("WARNING");
  });
});

describe("operator/helm-charts/libredb-studio mirrors the dual-stack surface (#432)", () => {
  for (const file of [
    "templates/service.yaml",
    // configmap.yaml carries `HOSTNAME: {{ .Values.config.bindAddress | quote }}`,
    // the single line that lets the image resolve its own bind address at all. A
    // mirror still pinning the old hardcoded 0.0.0.0 would ship this feature dead
    // to every operator install, with nothing else in the suite noticing.
    "templates/configmap.yaml",
    "templates/NOTES.txt",
    "templates/_helpers.tpl",
    "values.yaml",
    "values.schema.json",
  ]) {
    test(`${file} is byte-identical in the operator copy`, () => {
      expect(readFileSync(join(OPERATOR_CHART_DIR, file), "utf8")).toBe(readFileSync(join(CHART_DIR, file), "utf8"));
    });
  }

  test("the operator copy carries the address-family keys", () => {
    const values = readFileSync(join(OPERATOR_CHART_DIR, "values.yaml"), "utf8");
    expect(values).toContain("ipFamilyPolicy");
    expect(values).toContain("ipFamilies");
  });
});
