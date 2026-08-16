/**
 * Regression tests for the Gateway API route surface of the chart
 * (templates/route.yaml), added by #362 and corrected by #366:
 *
 *   1. The top-level `route.labels` / `route.annotations` keys are documented
 *      in values.schema.json as applying to *all* route resources, but the
 *      template only ever read the per-route keys, so they were silently
 *      dropped. They must be merged into every enabled route, with the
 *      per-route value winning on a key collision - and the literal keys
 *      `labels` and `annotations` must never be mistaken for route names by
 *      the template's `range` over `.Values.route`.
 *   2. An enabled route with no `parentRefs` used to render a valid but inert
 *      HTTPRoute: attached to no Gateway, it does nothing, so the install
 *      succeeds and the app stays unreachable. That must fail the render
 *      loudly instead. `parentRefs` cannot be defaulted (it is specific to
 *      the cluster's Gateway install), but the *disabled* default route must
 *      of course still render nothing and must not fail.
 *   3. `kind` was overridable while only an HTTPRoute-shaped body was ever
 *      rendered, so `kind: GRPCRoute` emitted a manifest the API server
 *      rejects (GRPCRoute matches on `method`, not `path`). `kind` is
 *      constrained to HTTPRoute in the schema; `apiVersion` stays free
 *      because v1 and v1alpha2 are both legitimate for HTTPRoute.
 *
 * Exercises the real `helm template` output against the actual chart - no
 * reimplementation of the templating logic (same approach as
 * helm-chart-openshift.test.ts). This file is also the baseline coverage for
 * the feature #362 shipped, which had no tests at all.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");

const MAIN_ENABLED = ["--set", "route.main.enabled=true", "--set", "route.main.parentRefs[0].name=gw"];

interface RouteRule {
  backendRefs?: Array<{ name: string; port: number; kind: string; group?: string; weight?: number }>;
  matches?: Array<{ path?: { type?: string; value?: string } }>;
  filters?: Array<{ type?: string; requestRedirect?: Record<string, unknown> }>;
}

interface RenderedManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: {
    parentRefs?: Array<{ name: string }>;
    hostnames?: string[];
    rules?: RouteRule[];
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
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr}`);
  }
  return parseAllDocuments(run.stdout)
    .map((doc) => doc.toJSON() as RenderedManifest)
    .filter((doc) => doc != null);
}

function routes(args: string[]): RenderedManifest[] {
  return renderDocs(args).filter((doc) => doc.kind === "HTTPRoute" || doc.kind === "GRPCRoute");
}

function onlyRoute(args: string[]): RenderedManifest {
  const rendered = routes(args);
  expect(rendered).toHaveLength(1);
  return rendered[0];
}

describe("charts/libredb-studio route baseline (#362)", () => {
  test("default values render no route at all", () => {
    expect(routes([])).toHaveLength(0);
  });

  test("an enabled route with parentRefs renders a well-formed HTTPRoute", () => {
    const route = onlyRoute(MAIN_ENABLED);
    expect(route.apiVersion).toBe("gateway.networking.k8s.io/v1");
    expect(route.kind).toBe("HTTPRoute");
    expect(route.metadata.name).toBe("release-under-test-libredb-studio");
    expect(route.metadata.labels).toMatchObject({
      "app.kubernetes.io/name": "libredb-studio",
      "app.kubernetes.io/instance": "release-under-test",
      "app.kubernetes.io/managed-by": "Helm",
    });
    expect(route.spec?.parentRefs).toEqual([{ name: "gw" }]);
    const rule = route.spec?.rules?.[0];
    expect(rule?.backendRefs?.[0]).toMatchObject({
      name: "release-under-test-libredb-studio",
      port: 80,
      kind: "Service",
    });
    expect(rule?.matches).toEqual([{ path: { type: "PathPrefix", value: "/" } }]);
  });
});

describe("charts/libredb-studio route shared labels and annotations (#366 item 1)", () => {
  test("top-level route.labels and route.annotations land on an enabled route", () => {
    const route = onlyRoute([
      ...MAIN_ENABLED,
      "--set",
      "route.labels.team=platform",
      "--set",
      "route.annotations.owner=infra",
    ]);
    expect(route.metadata.labels?.team).toBe("platform");
    expect(route.metadata.annotations?.owner).toBe("infra");
  });

  test("top-level route.labels and route.annotations land on every enabled route", () => {
    const rendered = routes([
      ...MAIN_ENABLED,
      "--set",
      "route.extra.enabled=true",
      "--set",
      "route.extra.parentRefs[0].name=gw",
      "--set",
      "route.labels.team=platform",
      "--set",
      "route.annotations.owner=infra",
    ]);
    expect(rendered).toHaveLength(2);
    for (const route of rendered) {
      expect(route.metadata.labels?.team).toBe("platform");
      expect(route.metadata.annotations?.owner).toBe("infra");
    }
  });

  test("a per-route label wins over the top-level label with the same key", () => {
    const route = onlyRoute([
      ...MAIN_ENABLED,
      "--set",
      "route.labels.team=platform",
      "--set",
      "route.main.labels.team=main-only",
    ]);
    expect(route.metadata.labels?.team).toBe("main-only");
  });

  test("a per-route annotation wins over the top-level annotation with the same key", () => {
    const route = onlyRoute([
      ...MAIN_ENABLED,
      "--set",
      "route.annotations.owner=infra",
      "--set",
      "route.main.annotations.owner=main-only",
    ]);
    expect(route.metadata.annotations?.owner).toBe("main-only");
  });

  // A `labels`/`annotations` map without an `enabled` key is skipped by the
  // `if $route.enabled` guard whether or not the template reserves the name, so
  // asserting on that shape proves nothing. `--set-string` gets a truthy string
  // `enabled` past both the schema (these maps are string-valued) and the guard,
  // which is the only shape that actually exercises the reserved-key list.
  test("a truthy `enabled` under route.labels still renders no -labels route", () => {
    const run = helmTemplate([...MAIN_ENABLED, "--set-string", "route.labels.enabled=true"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain("release-under-test-libredb-studio-labels");
  });

  test("a truthy `enabled` under route.annotations still renders no -annotations route", () => {
    const run = helmTemplate([...MAIN_ENABLED, "--set-string", "route.annotations.enabled=true"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain("release-under-test-libredb-studio-annotations");
  });

  // Helm's `merge` mutates its destination, so a shared map taken straight from
  // `.Values` and merged into per iteration leaks the first route's labels onto
  // every later route. Only a two-route render catches it.
  test("a per-route label does not leak onto another route", () => {
    const rendered = routes([
      ...MAIN_ENABLED,
      "--set",
      "route.main.labels.only-main=yes",
      "--set",
      "route.extra.enabled=true",
      "--set",
      "route.extra.parentRefs[0].name=gw",
    ]);
    expect(rendered).toHaveLength(2);
    const extra = rendered.find((route) => route.metadata.name.endsWith("-extra"));
    expect(extra?.metadata.labels).not.toHaveProperty("only-main");
    const main = rendered.find((route) => !route.metadata.name.endsWith("-extra"));
    expect(main?.metadata.labels?.["only-main"]).toBe("yes");
  });

  // Emitting a colliding user key alongside the chart's own would produce a
  // duplicate YAML mapping key, which the API server rejects outright.
  test("a chart label cannot be overwritten or duplicated by route.labels", () => {
    const args = [...MAIN_ENABLED, "--set", "route.labels.app\\.kubernetes\\.io/name=hijacked"];
    expect(onlyRoute(args).metadata.labels?.["app.kubernetes.io/name"]).toBe("libredb-studio");
    // Rendered in isolation so the count cannot pick up the Deployment/Service
    // selector labels: the key must appear once, not once per source.
    const routeOnly = helmTemplate([...args, "-s", "templates/route.yaml"]).stdout;
    expect(routeOnly.split("app.kubernetes.io/name:").length - 1).toBe(1);
    expect(routeOnly).not.toContain("hijacked");
  });
});

describe("charts/libredb-studio route parentRefs guard (#366 item 2)", () => {
  test("an enabled route with no parentRefs fails the render, naming what to set", () => {
    const run = helmTemplate(["--set", "route.main.enabled=true"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("route.main.parentRefs");
  });

  test("a disabled route with no parentRefs renders nothing and does not fail", () => {
    const run = helmTemplate([]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain("kind: HTTPRoute");
  });

  // A message that says "a route" leaves the user grepping their values file.
  test("the failure names which route is at fault, not just that one is", () => {
    const run = helmTemplate([...MAIN_ENABLED, "--set", "route.admin.enabled=true"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("route.admin");
    expect(run.stderr).not.toContain("route.main is enabled but sets no parentRefs");
  });

  // An httpsRedirect route attaches to a Gateway like any other: without
  // parentRefs it redirects nothing, so the guard must not skip that branch.
  test("an httpsRedirect route still needs parentRefs", () => {
    const run = helmTemplate(["--set", "route.main.enabled=true", "--set", "route.main.httpsRedirect=true"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("parentRefs");
  });
});

describe("charts/libredb-studio route block edge cases", () => {
  // The shared labels/annotations are read before the range, so an unguarded
  // dereference of a null `route` aborts the whole chart, not just this template.
  test("a null route block renders the rest of the chart and emits no route", () => {
    const run = helmTemplate(["--set", "route=null"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain("kind: HTTPRoute");
    expect(run.stdout).toContain("kind: Deployment");
  });
});

describe("charts/libredb-studio route kind constraint (#366 item 3)", () => {
  test("kind=GRPCRoute fails schema validation", () => {
    const run = helmTemplate([...MAIN_ENABLED, "--set", "route.main.kind=GRPCRoute"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("kind");
  });

  test("kind=HTTPRoute is accepted", () => {
    const route = onlyRoute([...MAIN_ENABLED, "--set", "route.main.kind=HTTPRoute"]);
    expect(route.kind).toBe("HTTPRoute");
  });

  test("apiVersion stays free: v1alpha2 still renders", () => {
    const route = onlyRoute([...MAIN_ENABLED, "--set", "route.main.apiVersion=gateway.networking.k8s.io/v1alpha2"]);
    expect(route.apiVersion).toBe("gateway.networking.k8s.io/v1alpha2");
  });
});

describe("charts/libredb-studio multiple routes and httpsRedirect (#362)", () => {
  test("a second named route renders with the -extra name suffix", () => {
    const rendered = routes([
      ...MAIN_ENABLED,
      "--set",
      "route.extra.enabled=true",
      "--set",
      "route.extra.parentRefs[0].name=gw-extra",
    ]);
    expect(rendered.map((route) => route.metadata.name).sort()).toEqual([
      "release-under-test-libredb-studio",
      "release-under-test-libredb-studio-extra",
    ]);
    const extra = rendered.find((route) => route.metadata.name.endsWith("-extra"));
    expect(extra?.spec?.parentRefs).toEqual([{ name: "gw-extra" }]);
  });

  test("httpsRedirect renders the RequestRedirect filter instead of backendRefs", () => {
    const route = onlyRoute([...MAIN_ENABLED, "--set", "route.main.httpsRedirect=true"]);
    const rule = route.spec?.rules?.[0];
    expect(rule?.backendRefs).toBeUndefined();
    expect(rule?.filters?.[0]).toMatchObject({
      type: "RequestRedirect",
      requestRedirect: { scheme: "https", statusCode: 301 },
    });
  });
});
