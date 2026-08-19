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
 *   5. A dual-stack Service in front of a container that only bound 0.0.0.0
 *      advertises an IPv6 address that answers every connection with a TCP
 *      RST: Kubernetes never checks what the process bound, the pod has an
 *      IPv6 address on a dual-stack cluster, so the IPv6 EndpointSlice is
 *      populated and kube-proxy routes to a port nothing listens on - and
 *      kubelet's probes only ever hit the primary podIP, so the pod stays
 *      Ready forever. The documented recipe is therefore the pair: the
 *      Service fields plus `extraEnv: HOSTNAME: "::"`, which wins over the
 *      ConfigMap's HOSTNAME because an explicit `env` entry beats `envFrom`.
 *      That pairing is locked here so the recipe in the chart README cannot
 *      rot away from the templates.
 *   6. Because that pairing is silent when it is broken - green install, IPv6
 *      EndpointSlice populated, pod Ready, every IPv6 connection refused - the
 *      install notes have to say so at the moment somebody asks for it. Any
 *      values that give the Service an IPv6 address without a HOSTNAME override
 *      must print the warning, and setting the override must silence it, the
 *      way NOTES.txt already warns about the other two combinations the chart
 *      renders but cannot make work (sqlite + replicas, sqlite + autoscaling).
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

describe("charts/libredb-studio dual-stack needs the pod to listen on :: (#432)", () => {
  function appEnv(args: string[]): Array<{ name: string; value?: string }> {
    const deployment = renderDocs(args).find((doc) => doc.kind === "Deployment");
    return deployment?.spec?.template?.spec?.containers?.[0]?.env ?? [];
  }

  // The image and the chart ConfigMap both say 0.0.0.0, which is IPv4 only.
  // Nothing about enabling dual-stack Services may change that on its own.
  test("the dual-stack Service alone does not touch the container's bind address", () => {
    expect(appEnv(DUAL_STACK).find((entry) => entry.name === "HOSTNAME")).toBeUndefined();
  });

  // The documented recipe: an explicit env entry beats the envFrom ConfigMap
  // key of the same name, so extraEnv is all it takes.
  test("extraEnv HOSTNAME=:: renders alongside the dual-stack Service", () => {
    const args = [...DUAL_STACK, "--set", "extraEnv[0].name=HOSTNAME", "--set-string", "extraEnv[0].value=::"];
    expect(appEnv(args).find((entry) => entry.name === "HOSTNAME")?.value).toBe("::");
    expect(service(args).spec?.ipFamilies).toEqual(["IPv4", "IPv6"]);
  });
});

describe("charts/libredb-studio install notes warn about an unbound IPv6 address (#432)", () => {
  // `helm template` never emits NOTES.txt and `helm install --dry-run=client`
  // cannot render it without a cluster: Helm 3.16 - the version CI pins - calls
  // IsReachable() before it renders anything, so the dry run dies on
  // "Kubernetes cluster unreachable" even for a chart created by `helm create`.
  // (Helm 4 does not, which is exactly how this went green locally and red in
  // CI.) So render the real NOTES.txt through the one path that needs no
  // cluster on either version: a throwaway copy of the chart in which the
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

  const HOSTNAME_ENV = ["--set", "extraEnv[0].name=HOSTNAME", "--set-string", "extraEnv[0].value=::"];

  test("the default install prints no address-family warning", () => {
    expect(notes([])).not.toContain("IPv6");
  });

  // The single most likely way to hold this wrong: the policy alone renders
  // cleanly, so nothing else in the terminal ever mentions the bind address.
  test("ipFamilyPolicy=PreferDualStack alone warns", () => {
    const output = notes(["--set", "service.ipFamilyPolicy=PreferDualStack"]);
    expect(output).toContain("WARNING");
    expect(output).toContain("HOSTNAME");
  });

  test("RequireDualStack alone warns", () => {
    expect(notes(["--set", "service.ipFamilyPolicy=RequireDualStack"])).toContain("HOSTNAME");
  });

  // A single IPv6 family needs no policy, so the render guard never sees it.
  test("a single IPv6 family with no policy warns", () => {
    expect(notes(["--set-json", 'service.ipFamilies=["IPv6"]'])).toContain("HOSTNAME");
  });

  test("both fields together warn", () => {
    expect(notes(DUAL_STACK)).toContain("HOSTNAME");
  });

  test("the warning carries the recipe that fixes it", () => {
    const output = notes(DUAL_STACK);
    expect(output).toContain("extraEnv[0].name=HOSTNAME");
    expect(output).toContain("::");
  });

  test("an explicit SingleStack policy does not warn", () => {
    expect(notes(["--set", "service.ipFamilyPolicy=SingleStack"])).not.toContain("IPv6");
  });

  test("a single IPv4 family does not warn", () => {
    expect(notes(["--set-json", 'service.ipFamilies=["IPv4"]'])).not.toContain("IPv6");
  });

  // The pair is complete: warning gone once the bind address is set.
  test("extraEnv HOSTNAME silences the warning", () => {
    expect(notes([...DUAL_STACK, ...HOSTNAME_ENV])).not.toContain("WARNING");
  });

  test("extraEnv HOSTNAME silences it for the policy-only case too", () => {
    expect(notes(["--set", "service.ipFamilyPolicy=PreferDualStack", ...HOSTNAME_ENV])).not.toContain("WARNING");
  });

  // Only the key is read: an operator who set HOSTNAME at all decided the bind
  // address deliberately, whatever they chose.
  test("a HOSTNAME entry after another extraEnv entry still silences it", () => {
    const output = notes([
      ...DUAL_STACK,
      "--set",
      "extraEnv[0].name=ALLOWED_ORIGINS",
      "--set",
      "extraEnv[0].value=https://libredb.example.com",
      "--set",
      "extraEnv[1].name=HOSTNAME",
      "--set-string",
      "extraEnv[1].value=::",
    ]);
    expect(output).not.toContain("WARNING");
  });

  test("an unrelated extraEnv entry does not silence it", () => {
    const output = notes([
      ...DUAL_STACK,
      "--set",
      "extraEnv[0].name=ALLOWED_ORIGINS",
      "--set",
      "extraEnv[0].value=https://libredb.example.com",
    ]);
    expect(output).toContain("HOSTNAME");
  });
});

// scripts/sync-chart-version.mjs holds the operator's embedded chart
// byte-for-byte identical to charts/libredb-studio. That copy carries no
// vendored subchart, so it cannot be rendered here; the three files this
// feature touches are compared byte-for-byte instead, which catches a hand-edit
// that reached only one of the two trees.
describe("operator/helm-charts/libredb-studio mirrors the dual-stack surface (#432)", () => {
  for (const file of [
    "templates/service.yaml",
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
