/**
 * The console's output surfaces on the agent path: the same statement read through the editor (the control) and
 * through the agent's machine context, so each assertion shows the editor still carries what the agent's copy masks.
 */
import { describe, expect, test } from "bun:test";
import { runKubectl } from "@/lib/db/providers/platform/kubernetes/console/run";
import { MACHINE_REDACTED } from "@/lib/db/providers/platform/kubernetes/redaction";
import {
  consoleContext,
  listAnswer,
  markerSecret,
  routes,
  SECRET_MARKER,
} from "../../../../helpers/kubernetes-console";
import { KUBERNETES_SAMPLE_MARKERS as M } from "../../../../helpers/kubernetes-markers";
import { jsonAnswer } from "../../../../helpers/kubernetes-transport";

const MACHINE = { maxRows: 200, maxBytes: 262_144 };

/** The same statement through the editor (the control) and through the agent's machine context. */
async function both(answer: Parameters<typeof routes>[0], statement: string) {
  const editor = consoleContext(routes(answer));
  const agent = consoleContext(routes(answer));
  const editorGrid = await runKubectl(editor.context, statement);
  const machineGrid = await runKubectl({ ...agent.context, machine: MACHINE }, statement);
  return { editor: JSON.stringify(editorGrid.rows), machine: JSON.stringify(machineGrid.rows) };
}

/** The pod spec of `machine-redaction.test.ts`: a planted value in every value rule's field. */
const plantedPodSpec = () => ({
  containers: [
    {
      name: "web",
      image: "nginx:1.27",
      command: ["/bin/sh", "-c", `serve --password=${M.envValue}`],
      args: [`--token=${M.envValue}`],
      env: [{ name: "MARKER_ENV", value: M.envValue }],
    },
  ],
});

const metadata = () => ({
  name: "web",
  namespace: "shop",
  labels: { [M.labelKey]: M.labelValue },
  annotations: { [M.annotationKey]: M.annotationValue },
});

/** Each rule's three assertions: the control holds the value, the masked copy keeps the key and not the value. */
function expectMasked(control: string, masked: string, key: string, value: string) {
  expect(control).toContain(value);
  expect(masked).toContain(key);
  expect(masked).not.toContain(value);
  expect(masked).toContain(MACHINE_REDACTED);
}

describe("documents", () => {
  test("a Deployment's env value, annotation value and command are masked in -o yaml, keys kept", async () => {
    const deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: metadata(),
      spec: { template: { metadata: metadata(), spec: plantedPodSpec() } },
    };
    const { editor, machine } = await both(
      { "GET /apis/apps/v1/namespaces/shop/deployments/web": jsonAnswer(deployment) },
      "get deployment web -n shop -o yaml",
    );
    expectMasked(editor, machine, "MARKER_ENV", M.envValue);
    expectMasked(editor, machine, M.annotationKey, M.annotationValue);
    expect(editor).toContain("serve --password=");
    expect(machine).not.toContain("serve --password=");
    // Labels and the Deployment's own name pass, in its cells and its document.
    expect(machine).toContain(M.labelValue);
    expect(machine).toContain('"NAMESPACE":"shop","NAME":"web"');
  });

  test("get secrets -o json: names masked, keys kept, no value; the list item carries no kind", async () => {
    const list = listAnswer([{ ...markerSecret("db"), kind: undefined }]);
    const { editor, machine } = await both(
      {
        "GET /api/v1/namespaces/shop/secrets?limit=500": list,
        "GET /api/v1/namespaces/shop/secrets?limit=201": list,
      },
      "get secrets -n shop -o json",
    );
    expect(editor).toContain('"NAME":"db"');
    expect(editor).toContain('\\"name\\": \\"db\\"');
    expect(editor).not.toContain(SECRET_MARKER);
    expect(machine).not.toMatch(/\bdb\b/);
    expect(machine).toContain('"NAMESPACE":"shop","NAME":"<redacted>"');
    expect(machine).toContain('\\"password\\": \\"<redacted>\\"');
    expect(machine).toContain(MACHINE_REDACTED);
    expect(machine).not.toContain(SECRET_MARKER);
  });
});
