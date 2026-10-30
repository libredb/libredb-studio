/**
 * The operator's LibreDBStudio API refuses spec.extraObjects (#1526).
 *
 * The CR spec is passed to the embedded chart as its values, and the chart
 * renders every extraObjects item as a manifest. Through plain Helm that is
 * the installer applying objects with their own credentials. Through the
 * operator it is not: the controller applies the release with its own
 * cluster-wide service account, which may create Roles, RoleBindings, Secrets
 * and workloads in any namespace. Accepting the value would let anyone who
 * may write a LibreDBStudio create those objects with the operator's rights
 * instead of their own, which the editor role is documented never to grant.
 *
 * So the CRD declares the field and refuses any item, and the API server
 * rejects the resource on write with a message that says why. Every other
 * value still passes through unchanged, because spec keeps preserving
 * unknown fields.
 *
 * The items carry `type: object` because the API server cannot compile a CEL
 * rule over untyped items: without it, applying the CRD itself fails with
 * "unable to convert structural schema to CEL declarations" (measured on
 * k3s v1.35.5). A string item, which the chart would take as a template, is
 * then refused by that type instead of by the rule's message.
 *
 * The chart's route template takes the rendered object's apiVersion and kind
 * from route.<name>.apiVersion and route.<name>.kind, so the same cluster-wide
 * service account would create whatever kind those name. The CRD accepts only
 * the Gateway API route kinds the chart supports, and only in the
 * gateway.networking.k8s.io group; `labels` and `annotations` under route are
 * shared settings rather than routes, so the rules skip them. A rule over
 * every key of an unbounded map exceeds the API server's CEL cost budget
 * (applying the CRD fails with "estimated rule cost exceeds budget", measured
 * on kube-apiserver 1.29.4 and 1.35.0), so route takes at most 64 keys. The
 * rules are checked here by evaluating the same predicate over sample values;
 * against those two API servers the CRD applies, HTTPRoute is accepted and
 * kind Secret is refused with the message.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dir, "../..");
const CHART = join(ROOT, "operator/helm-charts/libredb-studio");
/** The route kinds the chart renders a body for, as its values.schema.json enforces them. */
const ROUTE_KINDS = ["HTTPRoute"];
/** The gateway.networking.k8s.io versions that have served HTTPRoute. */
const ROUTE_API_VERSIONS = [
  "gateway.networking.k8s.io/v1",
  "gateway.networking.k8s.io/v1beta1",
  "gateway.networking.k8s.io/v1alpha2",
];
const ROUTE_KIND_RULE = `self.all(name, name in ['labels', 'annotations'] || !has(self[name].kind) || self[name].kind in ['', ${ROUTE_KINDS.map((k) => `'${k}'`).join(", ")}])`;
const ROUTE_API_VERSION_RULE = `self.all(name, name in ['labels', 'annotations'] || !has(self[name].apiVersion) || self[name].apiVersion in ['', ${ROUTE_API_VERSIONS.map((v) => `'${v}'`).join(", ")}])`;

const CRDS = {
  source: join(ROOT, "operator/config/crd/bases/studio.libredb.org_libredbstudios.yaml"),
  bundle: join(ROOT, "operator/bundle/manifests/studio.libredb.org_libredbstudios.yaml"),
};

interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: Schema;
  maxProperties?: number;
  "x-kubernetes-preserve-unknown-fields"?: boolean;
  "x-kubernetes-validations"?: Array<{ rule: string; message?: string }>;
}

function specSchema(file: string): Schema {
  const crd = parse(readFileSync(file, "utf8")) as {
    spec: { versions: Array<{ name: string; schema: { openAPIV3Schema: Schema } }> };
  };
  const version = crd.spec.versions.find((v) => v.name === "v1alpha1");
  const spec = version?.schema.openAPIV3Schema.properties?.spec;
  if (!spec) throw new Error(`no v1alpha1 spec schema in ${file}`);
  return spec;
}

describe.each(Object.entries(CRDS))("the %s CRD", (_name, file) => {
  test("refuses any extraObjects item, with a message that names the reason", () => {
    const field = specSchema(file).properties?.extraObjects;
    expect(field?.type).toBe("array");
    expect(field?.items?.type).toBe("object");
    expect(field?.["x-kubernetes-validations"]).toEqual([
      expect.objectContaining({ rule: "size(self) == 0", message: expect.stringContaining("service account") }),
    ]);
  });

  test("keeps passing every other chart value through", () => {
    expect(specSchema(file)["x-kubernetes-preserve-unknown-fields"]).toBe(true);
  });
});

/**
 * The two rules' predicate, evaluated the way the API server evaluates them over a spec.route map:
 * the reserved keys are skipped, an unset or empty value renders the chart default, and any other
 * value must be in the allowed list.
 */
function routeAccepted(route: Record<string, Record<string, unknown>>): { kind: boolean; apiVersion: boolean } {
  const check = (field: "kind" | "apiVersion", allowed: string[]) =>
    Object.entries(route).every(
      ([name, value]) =>
        ["labels", "annotations"].includes(name) ||
        !(field in value) ||
        ["", ...allowed].includes(value[field] as string),
    );
  return { kind: check("kind", ROUTE_KINDS), apiVersion: check("apiVersion", ROUTE_API_VERSIONS) };
}

describe.each(Object.entries(CRDS))("the %s CRD's route values", (_name, file) => {
  const route = () => {
    const schema = specSchema(file).properties?.route;
    if (!schema) throw new Error(`no spec.route schema in ${file}`);
    return schema;
  };

  test("type each route's kind and apiVersion as strings and keep every other route value whole", () => {
    expect(route().type).toBe("object");
    expect(route().maxProperties).toBe(64);
    expect(route().additionalProperties).toEqual({
      type: "object",
      "x-kubernetes-preserve-unknown-fields": true,
      properties: { apiVersion: { type: "string" }, kind: { type: "string" } },
    });
  });

  test("accept only the Gateway API route kinds the chart supports, skipping labels and annotations", () => {
    expect(route()["x-kubernetes-validations"]).toEqual([
      { rule: ROUTE_KIND_RULE, message: expect.stringContaining("route.<name>.kind must be HTTPRoute") },
      {
        rule: ROUTE_API_VERSION_RULE,
        message: expect.stringContaining("route.<name>.apiVersion must be a gateway.networking.k8s.io version"),
      },
    ]);
  });
});

describe("the route rules' predicate", () => {
  test("accepts the chart default, an unset or empty value and every supported version", () => {
    expect(routeAccepted({ main: { enabled: true } })).toEqual({ kind: true, apiVersion: true });
    expect(routeAccepted({ main: { kind: "", apiVersion: "" } })).toEqual({ kind: true, apiVersion: true });
    for (const apiVersion of ROUTE_API_VERSIONS) {
      expect(routeAccepted({ main: { kind: "HTTPRoute", apiVersion }, extra: { kind: "HTTPRoute" } })).toEqual({
        kind: true,
        apiVersion: true,
      });
    }
  });

  test("refuses any other kind or group on any route name", () => {
    expect(routeAccepted({ main: { kind: "Secret" } }).kind).toBe(false);
    expect(routeAccepted({ main: { kind: "HTTPRoute" }, other: { kind: "ClusterRoleBinding" } }).kind).toBe(false);
    expect(routeAccepted({ main: { kind: "GRPCRoute" } }).kind).toBe(false);
    expect(routeAccepted({ main: { apiVersion: "v1" } }).apiVersion).toBe(false);
    expect(routeAccepted({ main: { apiVersion: "rbac.authorization.k8s.io/v1" } }).apiVersion).toBe(false);
    expect(routeAccepted({ main: { apiVersion: "gateway.networking.k8s.io/v9" } }).apiVersion).toBe(false);
  });

  test("skips the shared labels and annotations, whose keys are not route fields", () => {
    expect(routeAccepted({ labels: { kind: "Secret", apiVersion: "v1" }, annotations: { kind: "Secret" } })).toEqual({
      kind: true,
      apiVersion: true,
    });
  });
});

test("the allowed route kinds are exactly the ones the chart's values schema accepts", () => {
  const schema = JSON.parse(readFileSync(join(CHART, "values.schema.json"), "utf8"));
  expect(schema.properties.route.additionalProperties.properties.kind.enum).toEqual(ROUTE_KINDS);
  expect(schema.properties.route.properties.main.properties.kind.enum).toEqual(ROUTE_KINDS);
});

test("the route template takes its apiVersion and kind from those values, so the rules guard something", () => {
  const template = readFileSync(join(CHART, "templates/route.yaml"), "utf8");
  expect(template).toContain('apiVersion: {{ $route.apiVersion | default "gateway.networking.k8s.io/v1" }}');
  expect(template).toContain('kind: {{ $route.kind | default "HTTPRoute" }}');
  expect(template).toContain('$reserved := list "labels" "annotations"');
});

test("the refused field is a value the embedded chart renders, so the guard guards something", () => {
  expect(parse(readFileSync(join(CHART, "values.yaml"), "utf8"))).toHaveProperty("extraObjects");
  expect(readFileSync(join(CHART, "templates/extra-objects.yaml"), "utf8")).toContain(".Values.extraObjects");
});
