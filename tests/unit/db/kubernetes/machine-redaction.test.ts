import { describe, expect, test } from "bun:test";
import {
  coversSecrets,
  MACHINE_MAX_NESTING,
  maskObjectForMachine,
  maskTableForMachine,
} from "@/lib/db/providers/platform/kubernetes/machine-redaction";
import { MACHINE_REDACTED } from "@/lib/db/providers/platform/kubernetes/redaction";
import type { KubeTable } from "@/lib/db/providers/platform/kubernetes/table";
import { KUBERNETES_SAMPLE_MARKERS as M } from "../../../helpers/kubernetes-markers";

const PODS = { group: "", resource: "pods" };
const DEPLOYMENTS = { group: "apps", resource: "deployments" };
const PODTEMPLATES = { group: "", resource: "podtemplates" };
const REVISIONS = { group: "apps", resource: "controllerrevisions" };
const CONFIGMAPS = { group: "", resource: "configmaps" };
const WIDGETS = { group: "example.com", resource: "widgets" };
const SECRETS = { group: "", resource: "secrets" };
const PVS = { group: "", resource: "persistentvolumes" };
const ROLES = { group: "rbac.authorization.k8s.io", resource: "roles" };
const EVENTS = { group: "", resource: "events" };
const SERVICEACCOUNTS = { group: "", resource: "serviceaccounts" };
const INGRESSES = { group: "networking.k8s.io", resource: "ingresses" };

/** A pod spec carrying a planted value in every value rule's field. */
const plantedPodSpec = () => ({
  containers: [
    {
      name: "web",
      image: "nginx:1.27",
      command: ["/bin/sh", "-c", `serve --password=${M.envValue}`],
      args: [`--token=${M.envValue}`],
      env: [
        { name: "MARKER_ENV", value: M.envValue },
        { name: "FROM_SECRET", valueFrom: { secretKeyRef: { name: M.secretName, key: "k" } } },
      ],
      readinessProbe: { httpGet: { path: "/", port: 80, httpHeaders: [{ name: "Authorization", value: M.envValue }] } },
      livenessProbe: { exec: { command: ["check", M.envValue] } },
      lifecycle: { preStop: { exec: { command: ["drain", M.envValue] } } },
    },
  ],
});

const metadata = () => ({
  name: "web",
  namespace: "shop",
  labels: { [M.labelKey]: M.labelValue },
  annotations: { [M.annotationKey]: M.annotationValue },
});

const json = (value: unknown) => JSON.stringify(value);

/** Each rule's three assertions: the control holds the value, the masked copy keeps the key and carries the marker. */
function expectMasked(control: unknown, masked: unknown, key: string, value: string) {
  expect(json(control)).toContain(value);
  expect(json(masked)).toContain(key);
  expect(json(masked)).not.toContain(value);
  expect(json(masked)).toContain(MACHINE_REDACTED);
}

describe("value rules, at any depth", () => {
  test.each([
    ["a Pod", PODS, { kind: "Pod", metadata: metadata(), spec: plantedPodSpec() }],
    [
      "a Deployment's template",
      DEPLOYMENTS,
      {
        kind: "Deployment",
        metadata: metadata(),
        spec: { template: { metadata: metadata(), spec: plantedPodSpec() } },
      },
    ],
    [
      "a PodTemplate",
      PODTEMPLATES,
      { kind: "PodTemplate", metadata: metadata(), template: { metadata: metadata(), spec: plantedPodSpec() } },
    ],
    [
      "a ControllerRevision's data",
      REVISIONS,
      {
        kind: "ControllerRevision",
        metadata: metadata(),
        data: { spec: { template: { metadata: metadata(), spec: plantedPodSpec() } } },
      },
    ],
    [
      "a custom resource embedding a pod spec",
      WIDGETS,
      { kind: "Widget", metadata: metadata(), spec: { podTemplate: { spec: plantedPodSpec() } } },
    ],
  ] as const)(
    "%s: env, headers, command, args, exec and annotations are masked; keys and labels pass",
    (_name, target, object) => {
      const masked = maskObjectForMachine(target, object);
      expectMasked(object, masked, "MARKER_ENV", M.envValue);
      expectMasked(object, masked, "Authorization", M.envValue);
      expectMasked(object, masked, M.annotationKey, M.annotationValue);
      expect(json(masked)).toContain(M.labelKey);
      expect(json(masked)).toContain(M.labelValue);
      expect(json(masked)).toContain('"name":"web"');
    },
  );

  test("command and args keep their length, element by element", () => {
    const masked = maskObjectForMachine(PODS, { kind: "Pod", metadata: metadata(), spec: plantedPodSpec() });
    const container = (masked.spec as { containers: { command: string[]; args: string[] }[] }).containers[0];
    expect(container.command).toEqual([MACHINE_REDACTED, MACHINE_REDACTED, MACHINE_REDACTED]);
    expect(container.args).toEqual([MACHINE_REDACTED]);
  });

  test("ConfigMap data and binaryData values are masked, keys kept, by kind or by request target", () => {
    const configMap = {
      metadata: metadata(),
      data: { [M.configMapKey]: M.configMapValue },
      binaryData: { blob: "aGVsbG8=" },
    };
    const byTarget = maskObjectForMachine(CONFIGMAPS, configMap);
    const byKind = maskObjectForMachine(PODS, { kind: "ConfigMap", ...configMap });
    for (const masked of [byTarget, byKind]) {
      expectMasked(configMap, masked, M.configMapKey, M.configMapValue);
      expect(json(masked)).not.toContain("aGVsbG8=");
    }
  });

  test("the input is not changed, so routing can still read it", () => {
    const object = { kind: "Pod", metadata: metadata(), spec: plantedPodSpec() };
    const before = json(object);
    maskObjectForMachine(PODS, object);
    expect(json(object)).toBe(before);
  });

  test("an object nested past the cap is refused, never read past", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let level = 0; level < 100; level += 1) deep = (deep.next = {}) as Record<string, unknown>;
    expect(() => maskObjectForMachine(PODS, root)).toThrow("nested deeper");
  });

  test("the cap is the last level walked: one level more is refused", () => {
    const chain = (levels: number) => {
      const root: Record<string, unknown> = {};
      let node = root;
      for (let level = 0; level < levels; level += 1) node = (node.next = {}) as Record<string, unknown>;
      return root;
    };
    expect(json(maskObjectForMachine(PODS, chain(MACHINE_MAX_NESTING)))).toBe(json(chain(MACHINE_MAX_NESTING)));
    expect(() => maskObjectForMachine(PODS, chain(MACHINE_MAX_NESTING + 1))).toThrow("nested deeper");
  });
});

describe("Secret names, wherever a field is defined to hold one", () => {
  test("in a pod spec: env secretKeyRef, envFrom secretRef, secret volumes, projected sources, CSI, imagePullSecrets", () => {
    const spec = plantedPodSpec();
    const pod = {
      kind: "Pod",
      metadata: metadata(),
      spec: {
        ...spec,
        containers: [{ ...spec.containers[0], envFrom: [{ secretRef: { name: M.secretName } }] }],
        imagePullSecrets: [{ name: M.secretName }],
        volumes: [
          { name: "a", secret: { secretName: M.secretName } },
          { name: "b", projected: { sources: [{ secret: { name: M.secretName } }] } },
          { name: "c", csi: { driver: "d", nodePublishSecretRef: { name: M.secretName } } },
          { name: "d", azureFile: { secretName: M.secretName, shareName: "s" } },
          { name: "e", cephfs: { monitors: ["m"], secretRef: { name: M.secretName } } },
        ],
      },
    };
    const masked = maskObjectForMachine(PODS, pod);
    expectMasked(pod, masked, "secretName", M.secretName);
    expect(json(masked)).toContain("nodePublishSecretRef");
    expect(json(masked)).not.toContain(M.secretName);
  });

  test("a PersistentVolume's CSI and secretRef forms", () => {
    const pv = {
      kind: "PersistentVolume",
      metadata: { name: "pv-1" },
      spec: {
        csi: { driver: "d", controllerExpandSecretRef: { name: M.secretName, namespace: "shop" } },
        rbd: { secretRef: { name: M.secretName } },
      },
    };
    expectMasked(pv, maskObjectForMachine(PVS, pv), "controllerExpandSecretRef", M.secretName);
  });

  test("an Ingress tls secretName and a ServiceAccount's secrets", () => {
    const ingress = {
      kind: "Ingress",
      metadata: { name: "web" },
      spec: { tls: [{ hosts: ["a"], secretName: M.secretName }] },
    };
    const account = { kind: "ServiceAccount", metadata: { name: "sa" }, secrets: [{ name: M.secretName }] };
    expectMasked(ingress, maskObjectForMachine(INGRESSES, ingress), "secretName", M.secretName);
    expectMasked(account, maskObjectForMachine(SERVICEACCOUNTS, account), "secrets", M.secretName);
  });

  test("owner and event references of kind Secret, and only those", () => {
    const owned = {
      kind: "ConfigMap",
      metadata: {
        name: "c",
        ownerReferences: [
          { kind: "Secret", name: M.secretName },
          { kind: "Deployment", name: "web" },
        ],
      },
    };
    const masked = maskObjectForMachine(CONFIGMAPS, owned);
    expect(json(masked)).not.toContain(M.secretName);
    expect(json(masked)).toContain('"name":"web"');
    const event = {
      kind: "Event",
      metadata: { name: `${M.secretName}.18dd5319a2f7a81e` },
      involvedObject: { kind: "Secret", name: M.secretName },
      related: { kind: "Secret", name: M.secretName },
      message: "m",
    };
    expectMasked(event, maskObjectForMachine(EVENTS, event), "involvedObject", M.secretName);
  });

  test("a Role's resourceNames on a rule that reaches Secrets, and not on one that does not", () => {
    const role = {
      kind: "Role",
      metadata: { name: "r" },
      rules: [
        { apiGroups: [""], resources: ["secrets"], resourceNames: [M.secretName], verbs: ["get"] },
        { apiGroups: [""], resources: ["configmaps"], resourceNames: ["shop-config"], verbs: ["get"] },
      ],
    };
    const masked = maskObjectForMachine(ROLES, role);
    expectMasked(role, masked, "resourceNames", M.secretName);
    expect(json(masked)).toContain("shop-config");
  });

  test.each([
    [{ apiGroups: ["*"], resources: ["secrets"] }],
    [{ apiGroups: [""], resources: ["*"] }],
    [{ apiGroups: [""], resources: ["secrets/status"] }],
    [{ resources: ["secrets"] }],
  ])("a rule covering Secrets by wildcard, subresource or an absent group is masked: %j", (rule) => {
    const role = {
      kind: "ClusterRole",
      metadata: { name: "r" },
      rules: [{ ...rule, resourceNames: [M.secretName], verbs: ["get"] }],
    };
    expect(json(maskObjectForMachine(ROLES, role))).not.toContain(M.secretName);
  });

  test("a rule in another group naming secrets is not masked", () => {
    const rule = { apiGroups: ["example.com"], resources: ["secrets"], resourceNames: ["kept"], verbs: ["get"] };
    expect(coversSecrets(rule)).toBe(false);
  });

  test("a Secret's own name, by request target or by kind, with no kind on a list item", () => {
    const item = { metadata: { name: M.secretName, namespace: "shop" }, type: "Opaque" };
    expect(json(maskObjectForMachine(SECRETS, item))).not.toContain(M.secretName);
    expect(json(maskObjectForMachine(PODS, { kind: "Secret", ...item }))).not.toContain(M.secretName);
    expect(json(maskObjectForMachine(SECRETS, { kind: "PartialObjectMetadata", ...item }))).not.toContain(M.secretName);
  });
});

describe("Tables, masked by what the request targeted", () => {
  const columns = (...specs: readonly (string | [string, number])[]) =>
    specs.map((spec) => {
      const [name, priority] = typeof spec === "string" ? [spec, 0] : spec;
      return { name, type: "string", format: "", priority };
    });

  test("a Secret list: every Name cell and every row's metadata masked, Type kept", () => {
    const table: KubeTable = {
      columns: columns("Name", "Type", "Data", "Age"),
      rows: [
        {
          cells: [M.secretName, "Opaque", 2, "5m"],
          object: { kind: "PartialObjectMetadata", metadata: { name: M.secretName, namespace: "shop" } },
        },
        { cells: ["db", "kubernetes.io/tls", 2, "1d"] },
      ],
      continueToken: "next",
    };
    const masked = maskTableForMachine(SECRETS, table);
    expect(masked.columns.map((column) => column.name)).toEqual(["Name", "Type", "Data", "Age"]);
    expect(masked.rows.map((row) => row.cells)).toEqual([
      [MACHINE_REDACTED, "Opaque", 2, "5m"],
      [MACHINE_REDACTED, "kubernetes.io/tls", 2, "1d"],
    ]);
    expect(masked.rows[0].object).toEqual({
      kind: "PartialObjectMetadata",
      metadata: { name: MACHINE_REDACTED, namespace: "shop" },
    });
    expect("object" in masked.rows[1]).toBe(false);
    expect(masked.continueToken).toBe("next");
    expect(json(table)).toContain(M.secretName);
  });

  test("a custom resource's Table keeps only Name and Age, whatever its printer columns echo", () => {
    const table: KubeTable = {
      columns: columns("Name", "Color", "Owner", "Age"),
      rows: [{ cells: ["w1", "blue", M.envValue, "2d"] }],
    };
    const masked = maskTableForMachine(WIDGETS, table);
    expect(masked.columns.map((column) => column.name)).toEqual(["Name", "Age"]);
    expect(masked.rows.map((row) => row.cells)).toEqual([["w1", "2d"]]);
  });

  test("a built-in kind's resource name in another group is a custom resource's Table", () => {
    const table: KubeTable = { columns: columns("Name", "Data", "Age"), rows: [{ cells: ["x", M.envValue, "1m"] }] };
    const masked = maskTableForMachine({ group: "example.com", resource: "secrets" }, table);
    expect(masked.rows.map((row) => row.cells)).toEqual([["x", "1m"]]);
  });

  test("a built-in kind's Table keeps every column", () => {
    const table: KubeTable = {
      columns: columns("Name", "Ready", "Status", ["IP", 1]),
      rows: [{ cells: ["web", "1/1", "Running", "10.0.0.1"] }],
    };
    expect(maskTableForMachine(PODS, table)).toEqual(table);
  });

  test("events: a Secret's Object cell and the event's own name are masked, a Pod's are not", () => {
    const table: KubeTable = {
      columns: columns("Last Seen", "Type", "Reason", "Object", "Message", ["Name", 1]),
      rows: [
        {
          cells: ["1m", "Warning", "Failed", "secret/db", "m", "db.18dd5319a2f7a81e"],
          object: { kind: "PartialObjectMetadata", metadata: { name: "db.18dd5319a2f7a81e", namespace: "shop" } },
        },
        { cells: ["2m", "Normal", "Started", "pod/web", "started", "web.18dd5319a2f7a81f"] },
      ],
    };
    const masked = maskTableForMachine(EVENTS, table);
    expect(masked.columns).toEqual(table.columns);
    expect(masked.rows[0].cells).toEqual([
      "1m",
      "Warning",
      "Failed",
      `secret/${MACHINE_REDACTED}`,
      "m",
      MACHINE_REDACTED,
    ]);
    expect(masked.rows[1].cells).toEqual(table.rows[1].cells);
  });

  test("events: a Secret event's row object loses its name though the metadata names no involved object", () => {
    const table: KubeTable = {
      columns: columns("Last Seen", "Type", "Reason", "Object", "Message"),
      rows: [
        {
          cells: ["1m", "Warning", "Failed", "secret/db", "m"],
          object: { kind: "PartialObjectMetadata", metadata: { name: "db.18dd5319a2f7a81e", namespace: "shop" } },
        },
        {
          cells: ["2m", "Normal", "Started", "pod/web", "started"],
          object: { kind: "PartialObjectMetadata", metadata: { name: "web.18dd5319a2f7a81f", namespace: "shop" } },
        },
      ],
    };
    const masked = maskTableForMachine(EVENTS, table);
    expect(masked.rows[0].object).toEqual({
      kind: "PartialObjectMetadata",
      metadata: { name: MACHINE_REDACTED, namespace: "shop" },
    });
    expect(masked.rows[1].object).toEqual(table.rows[1].object);
    expect(json(masked)).not.toContain("db.18dd5319a2f7a81e");
  });

  test("every row's object is masked by the object rules", () => {
    const table: KubeTable = {
      columns: columns("Name"),
      rows: [{ cells: ["web"], object: { kind: "PartialObjectMetadata", metadata: metadata() } }],
    };
    const masked = maskTableForMachine(PODS, table);
    expectMasked(table, masked, M.annotationKey, M.annotationValue);
    expect(masked.rows[0].cells).toEqual(["web"]);
  });
});
