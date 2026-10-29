/**
 * The operator's OpenShift catalog metadata: the feature annotations and the version floor.
 *
 * OperatorHub on OpenShift reads seven features.operators.openshift.io annotations from the CSV
 * (preflight's RequiredAnnotations check), and each one must be a string. All seven are "false" in
 * this release: the bundle lists no relatedImages or digests (disconnected), the image is not
 * built for FIPS mode, Studio's token exchange and API calls do not go through a cluster proxy on
 * purpose (proxy-aware), it does not follow the cluster's TLS profile, and it uses no cloud
 * token authentication. They live in the base CSV, so make -C operator bundle carries them into
 * the bundle CSV. The console plugin annotation belongs to the plugin release and is absent.
 *
 * com.redhat.openshift.versions names the oldest OpenShift release the bundle is offered for:
 * 4.16, since no lab runs 4.14 or 4.15, which stay untested. operator-sdk rewrites bundle/metadata/annotations.yaml
 * on every run, so the bundle target stamps it afterwards and checks it landed once; a missing or
 * unparseable value would only be warned about by the catalog tooling.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dir, "../..");
const CSVS = {
  base: join(ROOT, "operator/config/manifests/bases/libredb-studio-operator.clusterserviceversion.yaml"),
  bundle: join(ROOT, "operator/bundle/manifests/libredb-studio-operator.clusterserviceversion.yaml"),
};
const BUNDLE_ANNOTATIONS = join(ROOT, "operator/bundle/metadata/annotations.yaml");
const MAKEFILE = join(ROOT, "operator/Makefile");

const FEATURE_ANNOTATIONS = {
  "features.operators.openshift.io/disconnected": "false",
  "features.operators.openshift.io/fips-compliant": "false",
  "features.operators.openshift.io/proxy-aware": "false",
  "features.operators.openshift.io/tls-profiles": "false",
  "features.operators.openshift.io/token-auth-aws": "false",
  "features.operators.openshift.io/token-auth-azure": "false",
  "features.operators.openshift.io/token-auth-gcp": "false",
};

interface Csv {
  metadata: { annotations: Record<string, unknown> };
  spec: { customresourcedefinitions: { owned: Array<{ kind: string; description: string }> } };
}

function csv(file: string): Csv {
  return parse(readFileSync(file, "utf8")) as Csv;
}

describe.each(Object.entries(CSVS))("the %s CSV", (_name, file) => {
  test("declares exactly the seven OpenShift feature annotations, each the string false", () => {
    const annotations = csv(file).metadata.annotations;
    const features = Object.fromEntries(
      Object.entries(annotations).filter(([key]) => key.startsWith("features.operators.openshift.io/")),
    );
    expect(features).toEqual(FEATURE_ANNOTATIONS);
  });

  test("declares no console plugin", () => {
    expect(Object.keys(csv(file).metadata.annotations)).not.toContain("console.openshift.io/plugins");
  });

  test("tells a resource author which values the operator refuses", () => {
    const owned = csv(file).spec.customresourcedefinitions.owned.find((crd) => crd.kind === "LibreDBStudio");
    expect(owned?.description).toContain("extraObjects");
    expect(owned?.description).toContain("bundled PostgreSQL");
  });
});

describe("the bundle metadata", () => {
  test("offers the bundle from OpenShift 4.16 on", () => {
    const annotations = (parse(readFileSync(BUNDLE_ANNOTATIONS, "utf8")) as { annotations: Record<string, unknown> })
      .annotations;
    expect(annotations["com.redhat.openshift.versions"]).toBe("v4.16");
  });

  test("gets the floor from the bundle target, which checks it landed exactly once", () => {
    const makefile = readFileSync(MAKEFILE, "utf8");
    expect(makefile).toContain("OPENSHIFT_VERSIONS ?= v4.16\n");
    expect(makefile).toMatch(/grep -c '\^ {2}com\.redhat\.openshift\.versions: "\$\(OPENSHIFT_VERSIONS\)"\$\$'/);
  });
});
