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
  sentLines,
  tableAnswer,
  textAnswer,
} from "../../../../helpers/kubernetes-console";
import { KUBERNETES_SAMPLE_MARKERS as M } from "../../../../helpers/kubernetes-markers";
import { jsonAnswer, type KubernetesAnswerFn, statusAnswer } from "../../../../helpers/kubernetes-transport";

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

/** A list line answered the same whether the editor (500 a page) or the agent (its budget plus one) sends it. */
function bothLimits(path: string, query: string, answer: ReturnType<typeof tableAnswer>) {
  return {
    [`GET ${path}?limit=500${query}`]: answer,
    [`GET ${path}?limit=${MACHINE.maxRows + 1}${query}`]: answer,
  };
}

const SECRET_COLUMNS = [{ name: "Name" }, { name: "Type" }, { name: "Data", type: "integer" }, { name: "Age" }];

/** A Secret Table row named `M.secretName` in shop, its metadata carried when the request asked for it. */
const secretRow = (metadata: boolean) => ({
  cells: [M.secretName, "Opaque", 1, "5m"],
  ...(metadata
    ? { object: { kind: "PartialObjectMetadata", metadata: { name: M.secretName, namespace: "shop" } } }
    : {}),
});

describe("Tables", () => {
  test.each([
    [
      "get secrets -n shop",
      bothLimits(
        "/api/v1/namespaces/shop/secrets",
        "&includeObject=None",
        tableAnswer(SECRET_COLUMNS, [secretRow(false)]),
      ),
    ],
    [
      "get secrets -n shop -o name",
      bothLimits(
        "/api/v1/namespaces/shop/secrets",
        "&includeObject=None",
        tableAnswer(SECRET_COLUMNS, [secretRow(false)]),
      ),
    ],
    [
      "get secrets -A",
      bothLimits("/api/v1/secrets", "&includeObject=Metadata", tableAnswer(SECRET_COLUMNS, [secretRow(true)])),
    ],
    [
      "get secret db -n shop",
      {
        "GET /api/v1/namespaces/shop/secrets/db?includeObject=None": tableAnswer(SECRET_COLUMNS, [secretRow(false)]),
      },
    ],
  ])("%s: no Secret name reaches the machine grid; the editor shows it", async (statement, answer) => {
    const { editor, machine } = await both(answer, statement);
    expect(editor).toContain(M.secretName);
    expect(machine).not.toContain(M.secretName);
    expect(machine).toContain(MACHINE_REDACTED);
    if (statement.endsWith("-o name")) expect(machine).toBe(JSON.stringify([{ name: `secret/${MACHINE_REDACTED}` }]));
    if (statement.endsWith("-A")) expect(machine).toContain(`"NAMESPACE":"shop","Name":"${MACHINE_REDACTED}"`);
  });

  test("get secret NAME --ignore-not-found on a missing name writes no row and no name", async () => {
    const answer = { "GET /api/v1/namespaces/shop/secrets/db?includeObject=None": statusAnswer(404, "NotFound") };
    const agent = consoleContext(routes(answer));
    const grid = await runKubectl({ ...agent.context, machine: MACHINE }, "get secret db -n shop --ignore-not-found");
    expect(grid.rows).toEqual([]);
    expect(JSON.stringify(grid)).not.toMatch(/\bdb\b/);
  });

  test("a custom resource's Table keeps Name and Age; its fields stay readable through -o yaml under the rules", async () => {
    const columns = [{ name: "Name" }, { name: "Color" }, { name: "Owner" }, { name: "Age" }];
    const widgets = "/apis/probe.libredb.dev/v1/namespaces/shop/widgets";
    const list = await both(
      bothLimits(widgets, "&includeObject=None", tableAnswer(columns, [{ cells: ["w1", "teal", M.envValue, "2d"] }])),
      "get widgets -n shop",
    );
    expect(list.editor).toContain(M.envValue);
    expect(list.editor).toContain('"Color":"teal"');
    expect(list.machine).toBe(JSON.stringify([{ Name: "w1", Age: "2d" }]));
    const widget = {
      apiVersion: "probe.libredb.dev/v1",
      kind: "Widget",
      metadata: { name: "w1", namespace: "shop" },
      spec: { color: "teal", podTemplate: { spec: plantedPodSpec() } },
    };
    const document = await both({ [`GET ${widgets}/w1`]: jsonAnswer(widget) }, "get widget w1 -n shop -o yaml");
    expect(document.machine).toContain("color: teal");
    expectMasked(document.editor, document.machine, "MARKER_ENV", M.envValue);
  });

  test("get events: a Secret's object cell and the event's name are masked, a Pod's are not", async () => {
    const columns = [
      { name: "Last Seen" },
      { name: "Type" },
      { name: "Reason" },
      { name: "Object" },
      { name: "Message" },
      { name: "Name", priority: 1 },
    ];
    const events = tableAnswer(columns, [
      { cells: ["1m", "Warning", "Failed", `secret/${M.secretName}`, "m", `${M.secretName}.18dd5319a2f7a81e`] },
      { cells: ["2m", "Normal", "Started", "pod/web", "started", "web.18dd5319a2f7a81f"] },
    ]);
    const { editor, machine } = await both(
      bothLimits("/api/v1/namespaces/shop/events", "&includeObject=None", events),
      "get events -n shop -o wide",
    );
    expect(editor).toContain(`secret/${M.secretName}`);
    expect(machine).not.toContain(M.secretName);
    expect(machine).toContain(`"Object":"secret/${MACHINE_REDACTED}"`);
    expect(machine).toContain(`"Name":"${MACHINE_REDACTED}"`);
    expect(machine).toContain('"Object":"pod/web"');
    expect(machine).toContain('"Name":"web.18dd5319a2f7a81f"');
  });

  test("get events -A -o name: a Secret event's name never reaches the machine grid", async () => {
    const columns = [
      { name: "Last Seen" },
      { name: "Type" },
      { name: "Reason" },
      { name: "Object" },
      { name: "Message" },
    ];
    const eventMetadata = (name: string) => ({
      object: { kind: "PartialObjectMetadata", metadata: { name, namespace: "shop" } },
    });
    const events = tableAnswer(columns, [
      { cells: ["1m", "Warning", "Failed", `secret/${M.secretName}`, "m"], ...eventMetadata(`${M.secretName}.18dd`) },
      { cells: ["2m", "Normal", "Started", "pod/web", "started"], ...eventMetadata("web.18de") },
    ]);
    const { editor, machine } = await both(
      bothLimits("/api/v1/events", "&includeObject=Metadata", events),
      "get events -A -o name",
    );
    expect(editor).toContain(`event/${M.secretName}.18dd`);
    expect(machine).not.toContain(M.secretName);
    expect(machine).toBe(JSON.stringify([{ name: `event/${MACHINE_REDACTED}` }, { name: "event/web.18de" }]));
  });
});

/** Answers the events list of any page size; every other line through `routes`. */
function withEvents(map: Parameters<typeof routes>[0], path: string, items: readonly unknown[]) {
  const fixed = routes(map);
  const answer: KubernetesAnswerFn = (request, line) =>
    line.startsWith(`GET ${path}?`) ? listAnswer(items) : fixed(request, line);
  return answer;
}

const secretEvent = {
  type: "Warning",
  reason: "Rotated",
  message: "rotation finished",
  involvedObject: { kind: "Secret", name: "db", namespace: "shop", uid: "uid-secret" },
  lastTimestamp: "2026-10-10T11:59:00Z",
};

describe("describe", () => {
  test("describe secret: the Summary name is masked, annotation keys kept, and its events are still found", async () => {
    const secret = markerSecret("db");
    (secret.metadata as Record<string, unknown>).annotations = {
      ...((secret.metadata as Record<string, unknown>).annotations as Record<string, string>),
      "probe.libredb.dev/owner": "ops",
    };
    const map = {
      "GET /api/v1/namespaces/shop/secrets/db?includeObject=None": tableAnswer(
        [{ name: "Name" }, { name: "Type" }, { name: "Data", type: "integer" }],
        [{ cells: ["db", "Opaque", 2] }],
      ),
      "GET /api/v1/namespaces/shop/secrets/db": jsonAnswer(secret),
    };
    const events = "/api/v1/namespaces/shop/events";
    const editor = consoleContext(withEvents(map, events, [secretEvent]));
    const agent = consoleContext(withEvents(map, events, [secretEvent]));
    const editorGrid = JSON.stringify((await runKubectl(editor.context, "describe secret db -n shop")).rows);
    const machineGrid = (await runKubectl({ ...agent.context, machine: MACHINE }, "describe secret db -n shop")).rows;
    const machine = JSON.stringify(machineGrid);
    const eventsLine = sentLines(agent.transport).find((line) => line.startsWith(`GET ${events}?`));
    expect(eventsLine).toContain("involvedObject.name%3Ddb%2C");
    expect(eventsLine).toContain("involvedObject.uid%3Duid-secret");
    expect(machineGrid).toContainEqual({
      SECTION: "Events",
      FIELD: "Warning Rotated",
      VALUE: "60s ago: rotation finished",
    });
    expect(editorGrid).toContain('"FIELD":"Name","VALUE":"db"');
    expect(editorGrid).toContain("team=payments");
    expect(machine).not.toMatch(/\bdb\b/);
    expect(machineGrid).toContainEqual({ SECTION: "Summary", FIELD: "Name", VALUE: MACHINE_REDACTED });
    expect(machineGrid).toContainEqual({ SECTION: "Summary", FIELD: "Annotation", VALUE: `team=${MACHINE_REDACTED}` });
    expect(machineGrid).toContainEqual({
      SECTION: "Summary",
      FIELD: "Annotation",
      VALUE: `probe.libredb.dev/owner=${MACHINE_REDACTED}`,
    });
    expect(machineGrid).toContainEqual({ SECTION: "Summary", FIELD: "Label", VALUE: "app=web" });
    expect(machine).not.toContain(SECRET_MARKER);
  });

  test("describe pod: annotation values and Secret owner names masked, labels and condition messages pass", async () => {
    const pod = {
      kind: "Pod",
      apiVersion: "v1",
      metadata: {
        ...metadata(),
        uid: "uid-web",
        creationTimestamp: "2026-10-10T09:00:00Z",
        ownerReferences: [
          { kind: "ReplicaSet", name: "web-6d4f", controller: true },
          { kind: "Secret", name: M.secretName },
        ],
        finalizers: ["probe.libredb.dev/hold"],
      },
      spec: plantedPodSpec(),
      status: {
        conditions: [
          {
            type: "Ready",
            status: "False",
            reason: "ContainersNotReady",
            message: "containers with unready status: [web]",
          },
        ],
      },
    };
    const map = {
      "GET /api/v1/namespaces/shop/pods/web?includeObject=None": tableAnswer(
        [{ name: "Name" }, { name: "Ready" }, { name: "Status" }],
        [{ cells: ["web", "0/1", "Running"] }],
      ),
      "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(pod),
    };
    const events = "/api/v1/namespaces/shop/events";
    const editor = consoleContext(withEvents(map, events, []));
    const agent = consoleContext(withEvents(map, events, []));
    const editorGrid = JSON.stringify((await runKubectl(editor.context, "describe pod web -n shop")).rows);
    const machineGrid = (await runKubectl({ ...agent.context, machine: MACHINE }, "describe pod web -n shop")).rows;
    const machine = JSON.stringify(machineGrid);
    expectMasked(editorGrid, machine, M.annotationKey, M.annotationValue);
    expectMasked(editorGrid, machine, "Secret/", M.secretName);
    expect(machineGrid).toContainEqual({ SECTION: "Summary", FIELD: "Name", VALUE: "web" });
    expect(machineGrid).toContainEqual({ SECTION: "Summary", FIELD: "Label", VALUE: `${M.labelKey}=${M.labelValue}` });
    expect(machineGrid).toContainEqual({
      SECTION: "Summary",
      FIELD: "Annotation",
      VALUE: `${M.annotationKey}=${MACHINE_REDACTED}`,
    });
    expect(machineGrid).toContainEqual({ SECTION: "Summary", FIELD: "Owner", VALUE: `Secret/${MACHINE_REDACTED}` });
    expect(machineGrid).toContainEqual({
      SECTION: "Summary",
      FIELD: "Owner",
      VALUE: "ReplicaSet/web-6d4f (controller)",
    });
    expect(machineGrid).toContainEqual({ SECTION: "Summary", FIELD: "Finalizer", VALUE: "probe.libredb.dev/hold" });
    expect(machineGrid).toContainEqual({
      SECTION: "Conditions",
      FIELD: "Ready",
      VALUE: "False (ContainersNotReady: containers with unready status: [web])",
    });
    expect(sentLines(agent.transport).find((line) => line.startsWith(`GET ${events}?`))).toContain(
      "involvedObject.uid%3Duid-web",
    );
  });

  test("logs still chooses the annotated default container on the agent path", async () => {
    const pod = {
      metadata: {
        name: "web",
        namespace: "shop",
        creationTimestamp: "2026-10-10T09:00:00Z",
        annotations: { "kubectl.kubernetes.io/default-container": "sidecar" },
      },
      spec: { containers: [{ name: "app" }, { name: "sidecar" }] },
      status: { phase: "Running", containerStatuses: [{ name: "app", restartCount: 0 }] },
    };
    const fixed = routes({ "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(pod) });
    const agent = consoleContext((request, line) =>
      line.startsWith("GET /api/v1/namespaces/shop/pods/web/log?") ? textAnswer("") : fixed(request, line),
    );
    await runKubectl({ ...agent.context, machine: MACHINE }, "logs pod/web -n shop");
    const logLine = sentLines(agent.transport).find((line) => line.includes("/log?"));
    expect(logLine).toStartWith("GET /api/v1/namespaces/shop/pods/web/log?container=sidecar&");
  });
});
