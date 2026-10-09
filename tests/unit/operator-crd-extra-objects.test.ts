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
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dir, "../..");
const CRDS = {
  source: join(ROOT, "operator/config/crd/bases/studio.libredb.org_libredbstudios.yaml"),
  bundle: join(ROOT, "operator/bundle/manifests/studio.libredb.org_libredbstudios.yaml"),
};

interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
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

test("the refused field is a value the embedded chart renders, so the guard guards something", () => {
  const chart = join(ROOT, "operator/helm-charts/libredb-studio");
  expect(parse(readFileSync(join(chart, "values.yaml"), "utf8"))).toHaveProperty("extraObjects");
  expect(readFileSync(join(chart, "templates/extra-objects.yaml"), "utf8")).toContain(".Values.extraObjects");
});
