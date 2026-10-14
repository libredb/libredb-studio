import { describe, expect, test } from "bun:test";
import { MACHINE_MAX_NESTING, maskObjectForMachine } from "@/lib/db/providers/platform/kubernetes/machine-redaction";
import { MACHINE_REDACTED } from "@/lib/db/providers/platform/kubernetes/redaction";
import { KUBERNETES_SAMPLE_MARKERS as M } from "../../../helpers/kubernetes-markers";

const PODS = { group: "", resource: "pods" };
const DEPLOYMENTS = { group: "apps", resource: "deployments" };
const PODTEMPLATES = { group: "", resource: "podtemplates" };
const REVISIONS = { group: "apps", resource: "controllerrevisions" };
const CONFIGMAPS = { group: "", resource: "configmaps" };
const WIDGETS = { group: "example.com", resource: "widgets" };

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
