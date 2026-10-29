// @requires helm
/**
 * The chart's OpenShift Route under `openshiftRoute.*`, the native way to expose
 * a Service on OpenShift beside the Ingress (`ingress.*`) and the Gateway API
 * HTTPRoute (`route.*`). It is off by default, needs route.openshift.io/v1 (or
 * global.compatibility.openshift.apis=force for a GitOps or offline render), and
 * terminates TLS at the router (edge) with plain HTTP redirected.
 *
 * The timeout annotation matters: the router cuts a request after 30s by default,
 * and a Studio query may run for 60s or more, so the chart sets 120s.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { howItFailed } from "../helpers/spawn-outcome";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const FULLNAME = "release-under-test-libredb-studio";
const ROUTE_API = ["--api-versions", "route.openshift.io/v1"];
const ENABLED = ["--set", "openshiftRoute.enabled=true"];

interface RenderedManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: {
    host?: string;
    to?: Record<string, unknown>;
    port?: { targetPort?: string };
    tls?: Record<string, unknown>;
  };
}

function helmTemplate(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", "release-under-test", CHART_DIR, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function renderDocs(args: string[]): RenderedManifest[] {
  const run = helmTemplate(args);
  if (run.exitCode !== 0) {
    throw new Error(`helm template ${howItFailed(run)}: ${run.stderr}`);
  }
  return parseAllDocuments(run.stdout)
    .map((doc) => doc.toJSON() as RenderedManifest)
    .filter((doc) => doc != null);
}

function openshiftRoute(args: string[]): RenderedManifest {
  const routes = renderDocs(args).filter((doc) => doc.kind === "Route");
  if (routes.length !== 1) {
    throw new Error(`expected one Route, rendered ${routes.length}`);
  }
  return routes[0];
}

describe("charts/libredb-studio OpenShift Route", () => {
  test("default values render no Route, with and without the OpenShift API groups", () => {
    expect(renderDocs([]).some((doc) => doc.kind === "Route")).toBe(false);
    expect(renderDocs(ROUTE_API).some((doc) => doc.kind === "Route")).toBe(false);
  });

  test("an enabled Route points at the Service port with edge, Redirect and the timeout annotation", () => {
    const route = openshiftRoute([...ROUTE_API, ...ENABLED]);
    expect(route.apiVersion).toBe("route.openshift.io/v1");
    expect(route.metadata.name).toBe(FULLNAME);
    expect(route.spec?.to).toEqual({ kind: "Service", name: FULLNAME, weight: 100 });
    expect(route.spec?.port?.targetPort).toBe("http");
    expect(route.spec?.tls).toEqual({ termination: "edge", insecureEdgeTerminationPolicy: "Redirect" });
    expect(route.metadata.annotations?.["haproxy.router.openshift.io/timeout"]).toBe("120s");
    expect(route.metadata.annotations ?? {}).not.toHaveProperty("haproxy.router.openshift.io/hsts_header");
  });

  test("the Service the Route targets names its port http", () => {
    const service = renderDocs([]).find((doc) => doc.kind === "Service") as unknown as {
      spec: { ports: Array<{ name: string }> };
    };
    expect(service.spec.ports.map((port) => port.name)).toContain("http");
  });

  test("hstsHeader renders the hsts_header annotation only when set", () => {
    const route = openshiftRoute([
      ...ROUTE_API,
      ...ENABLED,
      "--set-string",
      "openshiftRoute.hstsHeader=max-age=31536000",
    ]);
    expect(route.metadata.annotations?.["haproxy.router.openshift.io/hsts_header"]).toBe("max-age=31536000");
  });

  test("an empty timeout renders no timeout annotation", () => {
    const route = openshiftRoute([...ROUTE_API, ...ENABLED, "--set-string", "openshiftRoute.timeout="]);
    expect(route.metadata.annotations ?? {}).not.toHaveProperty("haproxy.router.openshift.io/timeout");
  });

  test("an empty host renders no spec.host, a set host renders it", () => {
    expect(openshiftRoute([...ROUTE_API, ...ENABLED]).spec?.host).toBeUndefined();
    const route = openshiftRoute([...ROUTE_API, ...ENABLED, "--set", "openshiftRoute.host=studio.apps.example.com"]);
    expect(route.spec?.host).toBe("studio.apps.example.com");
  });

  test("insecureEdgeTerminationPolicy takes the value set", () => {
    const route = openshiftRoute([
      ...ROUTE_API,
      ...ENABLED,
      "--set",
      "openshiftRoute.tls.insecureEdgeTerminationPolicy=None",
    ]);
    expect(route.spec?.tls).toEqual({ termination: "edge", insecureEdgeTerminationPolicy: "None" });
  });

  test.each(["passthrough", "reencrypt"])("termination %s fails schema validation", (termination) => {
    const run = helmTemplate([...ROUTE_API, ...ENABLED, "--set", `openshiftRoute.tls.termination=${termination}`]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("openshiftRoute");
  });

  test("a timeout without a unit fails schema validation", () => {
    const run = helmTemplate([...ROUTE_API, ...ENABLED, "--set-string", "openshiftRoute.timeout=120"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("openshiftRoute");
  });

  test("an unknown openshiftRoute key fails schema validation", () => {
    const run = helmTemplate([...ROUTE_API, ...ENABLED, "--set", "openshiftRoute.hostname=studio.example.com"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("openshiftRoute");
  });

  test("an enabled Route without route.openshift.io/v1 fails the render and names the force switch", () => {
    const run = helmTemplate(ENABLED);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("openshiftRoute.enabled");
    expect(run.stderr).toContain("route.openshift.io/v1");
    expect(run.stderr).toContain("global.compatibility.openshift.apis=force");
  });

  test("apis=force renders the Route without detection", () => {
    const route = openshiftRoute([...ENABLED, "--set", "global.compatibility.openshift.apis=force"]);
    expect(route.apiVersion).toBe("route.openshift.io/v1");
  });

  test("route.main and openshiftRoute render independently", () => {
    const gateway = ["--set", "route.main.enabled=true", "--set", "route.main.parentRefs[0].name=gw"];
    const kinds = (args: string[]) =>
      renderDocs([...ROUTE_API, ...args])
        .map((doc) => doc.kind)
        .filter((kind) => kind === "HTTPRoute" || kind === "Route")
        .sort();
    expect(kinds([...gateway, ...ENABLED])).toEqual(["HTTPRoute", "Route"]);
    expect(kinds(gateway)).toEqual(["HTTPRoute"]);
    expect(kinds(ENABLED)).toEqual(["Route"]);
  });

  test("openshiftRoute.labels and .annotations land on the Route without displacing chart labels", () => {
    const route = openshiftRoute([
      ...ROUTE_API,
      ...ENABLED,
      "--set",
      "openshiftRoute.labels.team=data",
      "--set",
      "openshiftRoute.labels.app\\.kubernetes\\.io/name=other",
      "--set",
      "openshiftRoute.annotations.example\\.com/owner=data",
    ]);
    expect(route.metadata.labels?.team).toBe("data");
    expect(route.metadata.labels?.["app.kubernetes.io/name"]).toBe("libredb-studio");
    expect(route.metadata.labels?.["app.kubernetes.io/instance"]).toBe("release-under-test");
    expect(route.metadata.annotations?.["example.com/owner"]).toBe("data");
    expect(route.metadata.annotations?.["haproxy.router.openshift.io/timeout"]).toBe("120s");
  });

  test("a values set without openshiftRoute renders no Route", () => {
    expect(renderDocs([...ROUTE_API, "--set", "openshiftRoute=null"]).some((doc) => doc.kind === "Route")).toBe(false);
  });
});

/**
 * The install notes say where Studio answers. With a Route, that is its host:
 * the one set in openshiftRoute.host, or the one the router generates, which
 * exists only after the install, so the notes say how to read it.
 */
describe("install notes about the OpenShift Route", () => {
  // helm template never emits NOTES.txt, so the real file is wrapped in a named
  // template inside a private copy of the chart and rendered into a ConfigMap.
  const PROBE_TEMPLATE = "templates/zz-notes-probe.yaml";
  let notesChart: string;

  beforeAll(() => {
    notesChart = mkdtempSync(join(tmpdir(), "libredb-openshift-route-notes-probe-"));
    cpSync(CHART_DIR, notesChart, { recursive: true });
    writeFileSync(
      join(notesChart, PROBE_TEMPLATE),
      `{{- define "notesProbe" -}}\n${readFileSync(join(CHART_DIR, "templates/NOTES.txt"), "utf8")}\n{{- end -}}\n` +
        'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: notes-probe\ndata:\n  notes: {{ include "notesProbe" . | quote }}\n',
    );
  });

  afterAll(() => rmSync(notesChart, { recursive: true, force: true }));

  function notes(args: string[]): string {
    const run = Bun.spawnSync(
      ["helm", "template", "release-under-test", notesChart, "--show-only", PROBE_TEMPLATE, ...args],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (run.exitCode !== 0) {
      throw new Error(`helm template of the notes probe ${howItFailed(run)}: ${run.stderr.toString()}`);
    }
    const rendered = parseAllDocuments(run.stdout.toString())
      .map((document) => document.toJS() as { data?: { notes?: string } } | null)
      .find((document) => document?.data?.notes !== undefined);
    if (!rendered) {
      throw new Error(`the notes probe rendered no ConfigMap: ${run.stdout.toString()}`);
    }
    return rendered.data?.notes ?? "";
  }

  const READ_HOST = `oc get route --namespace default ${FULLNAME} -o jsonpath='{.spec.host}'`;

  test("a set host is named as the HTTPS address", () => {
    const text = notes([...ROUTE_API, ...ENABLED, "--set", "openshiftRoute.host=studio.apps.example.com"]);
    expect(text).toContain("Access LibreDB Studio via the OpenShift Route:\n  https://studio.apps.example.com\n");
    expect(text).not.toContain(READ_HOST);
  });

  test("a set host carries config.basePath", () => {
    const text = notes([
      ...ROUTE_API,
      ...ENABLED,
      "--set",
      "openshiftRoute.host=studio.apps.example.com",
      "--set",
      "config.basePath=/studio",
    ]);
    expect(text).toContain("  https://studio.apps.example.com/studio\n");
  });

  test("a generated host is read with oc get route", () => {
    const text = notes([...ROUTE_API, ...ENABLED]);
    expect(text).toContain("Access LibreDB Studio via the OpenShift Route:");
    expect(text).toContain(READ_HOST);
  });

  test("without an enabled Route the notes do not mention it", () => {
    for (const args of [[], ROUTE_API, [...ROUTE_API, "--set", "openshiftRoute=null"]]) {
      const text = notes(args);
      expect(text).not.toContain("OpenShift Route");
      expect(text).not.toContain("oc get route");
      expect(text).toContain("Access LibreDB Studio via port-forward:");
    }
  });

  test("an Ingress and a Route are both named", () => {
    const text = notes([
      ...ROUTE_API,
      ...ENABLED,
      "--set",
      "openshiftRoute.host=studio.apps.example.com",
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.hosts[0].host=libredb.example.com",
      "--set",
      "ingress.hosts[0].paths[0].path=/",
      "--set",
      "ingress.hosts[0].paths[0].pathType=Prefix",
    ]);
    expect(text).toContain("Access LibreDB Studio via Ingress:\n  http://libredb.example.com/");
    expect(text).toContain("  https://studio.apps.example.com\n");
  });
});
