/**
 * The operator's OpenShift catalog metadata: the feature annotations and the version floor.
 *
 * OperatorHub on OpenShift reads seven features.operators.openshift.io annotations from the CSV
 * (preflight's RequiredAnnotations check), and each one must be a string. All seven are "false" in
 * this release: Studio's own image is still a tag, only the plugin's is in relatedImages by digest (disconnected), the image is not
 * built for FIPS mode, Studio's token exchange and API calls do not go through a cluster proxy on
 * purpose (proxy-aware), it does not follow the cluster's TLS profile, and it uses no cloud
 * token authentication. They live in the base CSV, so make -C operator bundle carries them into
 * the bundle CSV.
 *
 * The CSV declares the console plugin libredb-studio (console.openshift.io/plugins), so OperatorHub
 * offers its toggle in the install form, off by default on a community catalog. The controller
 * carries the plugin image as RELATED_IMAGE_PLUGIN, the same reference the chart pins, which
 * operator/watches.yaml hands the chart; the plugin's namespace is WATCH_NAMESPACE, the operator's own,
 * so the controller has no second namespace variable.
 *
 * com.redhat.openshift.versions names the oldest OpenShift release the bundle is offered for:
 * 4.16, since no lab runs 4.14 or 4.15, which stay untested. operator-sdk rewrites bundle/metadata/annotations.yaml
 * on every run, so the bundle target stamps it afterwards and checks it landed once; a missing or
 * unparseable value would only be warned about by the catalog tooling.
 *
 * The operator manages only its own namespace. The CSV supports the OwnNamespace install mode and no
 * other, and suggests the namespace libredb-studio, which the console's install form preselects and
 * creates when it does not exist. The controller watches only the namespace its pod runs in:
 * helm-operator reads WATCH_NAMESPACE, and the bundle's Deployment sets it from the downward API
 * field metadata.namespace, which is one name and never empty (empty would mean every namespace).
 * The install modes and that variable are pinned together, so adding another install mode forces
 * revisiting the variable. operator-sdk generate bundle rewrites every WATCH_NAMESPACE it finds to
 * the annotation olm.targetNamespaces, which is empty outside OLM and for an all-namespaces group,
 * where empty means every namespace; the bundle target puts the pod's namespace back and checks it
 * landed exactly once.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";

const ROOT = join(import.meta.dir, "../..");
const CSVS = {
  base: join(ROOT, "operator/config/manifests/bases/libredb-studio-operator.clusterserviceversion.yaml"),
  bundle: join(ROOT, "operator/bundle/manifests/libredb-studio-operator.clusterserviceversion.yaml"),
};
const BUNDLE_ANNOTATIONS = join(ROOT, "operator/bundle/metadata/annotations.yaml");
const ROLE = join(ROOT, "operator/config/rbac/role.yaml");
const MANAGER = join(ROOT, "operator/config/manager/manager.yaml");
const PLUGIN_IMAGE = (
  parse(readFileSync(join(ROOT, "charts/libredb-studio/values.yaml"), "utf8")) as {
    openshift: { consolePlugin: { image: string } };
  }
).openshift.consolePlugin.image;
const PLUGIN_ENV = [{ name: "RELATED_IMAGE_PLUGIN", value: PLUGIN_IMAGE }];

interface Rule {
  apiGroups?: string[];
  resources?: string[];
  resourceNames?: string[];
  verbs?: string[];
}

interface Container {
  name: string;
  env?: EnvVar[];
}
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

const INSTALL_MODES = [
  { supported: true, type: "OwnNamespace" },
  { supported: false, type: "SingleNamespace" },
  { supported: false, type: "MultiNamespace" },
  { supported: false, type: "AllNamespaces" },
];

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: unknown;
}

interface Csv {
  metadata: { annotations: Record<string, unknown> };
  spec: {
    description: string;
    installModes: Array<{ supported: boolean; type: string }>;
    customresourcedefinitions: { owned: Array<{ kind: string; description: string }> };
    install: {
      spec: {
        clusterPermissions?: Array<{ rules: Rule[] }>;
        deployments: Array<{ spec: { template: { spec: { containers: Container[] } } } }>;
      };
    };
  };
}

function consolePluginRules(rules: Rule[]): Rule[] {
  return rules.filter((rule) => rule.resources?.includes("consoleplugins"));
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

  test("declares the console plugin libredb-studio", () => {
    const plugins = csv(file).metadata.annotations["console.openshift.io/plugins"];
    expect(typeof plugins).toBe("string");
    expect(JSON.parse(plugins as string)).toEqual(["libredb-studio"]);
  });

  test("tells the admin how the plugin is turned on, and on which OpenShift", () => {
    const description = csv(file).spec.description;
    expect(description).toContain("defaults to Disabled");
    expect(description).toContain("Console plugins");
    expect(description).toContain("OpenShift 4.19");
    expect(description).toContain("openshift.consolePlugin.enabled");
  });

  test("tells a resource author which values the operator refuses", () => {
    const owned = csv(file).spec.customresourcedefinitions.owned.find((crd) => crd.kind === "LibreDBStudio");
    expect(owned?.description).toContain("extraObjects");
    expect(owned?.description).toContain("bundled PostgreSQL");
  });

  test("supports the OwnNamespace install mode and no other", () => {
    expect(csv(file).spec.installModes).toEqual(INSTALL_MODES);
  });

  test("suggests the libredb-studio namespace, which the console creates when it does not exist", () => {
    expect(csv(file).metadata.annotations["operatorframework.io/suggested-namespace"]).toBe("libredb-studio");
  });

  test("says the operator manages only its own namespace, that teams use the Helm chart, and how 1.1.0 moves", () => {
    const description = csv(file).spec.description;
    expect(description).toContain("manages only its own namespace");
    expect(description).toContain("Helm chart");
    expect(description).toContain("1.1.0");
    expect(description).toContain("docs/OPENSHIFT.md#moving-from-operator-110");
  });

  test("tells a resource author that only the operator's namespace is reconciled", () => {
    const owned = csv(file).spec.customresourcedefinitions.owned.find((crd) => crd.kind === "LibreDBStudio");
    expect(owned?.description).toContain("Reconciled only in the namespace the operator is installed in.");
  });
});

describe("the bundle CSV's controller", () => {
  const deployments = csv(CSVS.bundle).spec.install.spec.deployments;
  const manager = deployments[0]?.spec.template.spec.containers.find((container) => container.name === "manager");

  test("is the one Deployment, with a manager container", () => {
    expect(deployments).toHaveLength(1);
    expect(manager).toBeDefined();
  });

  test("watches only the namespace its pod runs in, from the downward API", () => {
    expect(manager?.env?.filter((env) => env.name === "WATCH_NAMESPACE")).toEqual([
      { name: "WATCH_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
    ]);
  });

  test("gets the pod's namespace back from the bundle target, which checks it landed exactly once", () => {
    const makefile = readFileSync(MAKEFILE, "utf8");
    expect(makefile).toContain(
      `sed -e "s|fieldPath: metadata.annotations\\['olm.targetNamespaces'\\]$$|fieldPath: metadata.namespace|"`,
    );
    expect(makefile).toContain(`grep -c "olm.targetNamespaces"`);
    expect(makefile).toContain(`grep -A3 -e '- name: WATCH_NAMESPACE$$'`);
  });

  test("reads no Subscription variable for the cluster Studio namespace", () => {
    expect(manager?.env?.map((env) => env.name)).not.toContain("LIBREDB_CLUSTER_STUDIO_NAMESPACE");
  });
});

describe("the controller's plugin environment", () => {
  test("the manager carries WATCH_NAMESPACE and RELATED_IMAGE_PLUGIN, the chart's plugin image, and no OPERATOR_NAMESPACE", () => {
    const docs = parseAllDocuments(readFileSync(MANAGER, "utf8")).map(
      (doc) => doc.toJSON() as { kind: string; spec?: { template: { spec: { containers: Container[] } } } },
    );
    const manager = docs
      .find((doc) => doc.kind === "Deployment")
      ?.spec?.template.spec.containers.find((container) => container.name === "manager");
    expect(manager?.env).toEqual([
      { name: "WATCH_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
      ...PLUGIN_ENV,
    ]);
  });

  test("the bundle CSV's install deployment carries the same two variables and no OPERATOR_NAMESPACE", () => {
    const deployments = csv(CSVS.bundle).spec.install.spec.deployments;
    expect(deployments).toHaveLength(1);
    const manager = deployments[0].spec.template.spec.containers.find((container) => container.name === "manager");
    expect(manager?.env).toEqual(expect.arrayContaining(PLUGIN_ENV));
    expect(manager?.env?.map((env) => env.name)).toEqual(["WATCH_NAMESPACE", "RELATED_IMAGE_PLUGIN"]);
  });

  test("the bundle CSV's clusterPermissions carry both consoleplugins rules exactly as role.yaml", () => {
    const role = (parse(readFileSync(ROLE, "utf8")) as { rules: Rule[] }).rules;
    const bundle = (csv(CSVS.bundle).spec.install.spec.clusterPermissions ?? []).flatMap((entry) => entry.rules);
    expect(consolePluginRules(role)).toHaveLength(2);
    expect(consolePluginRules(bundle)).toEqual(consolePluginRules(role));
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
