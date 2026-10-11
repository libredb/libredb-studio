/**
 * `kubectl logs`: kubectl's pod choice (`GetFirstPod` over `podutils.ByLogging`, pinned rule by rule), its container
 * choice, the 5-stream fan-out, the tails, the query each stream sends, and the time-ordered merge.
 */
import { describe, expect, test } from "bun:test";
import { type NodeRequest, TransportError } from "@/lib/db/http/node-transport";
import {
  compareForLogging,
  readLogs,
  selectorText,
  splitTimestamp,
  stripTerminalEscapes,
} from "@/lib/db/providers/platform/kubernetes/console/logs";
import { type KubectlStatement, parseKubectl } from "@/lib/db/providers/platform/kubernetes/console/parse";
import { consoleContext, listAnswer, routes, sentLines, textAnswer } from "../../../../helpers/kubernetes-console";
import { jsonAnswer } from "../../../../helpers/kubernetes-transport";

type Logs = Extract<KubectlStatement, { readonly command: "logs" }>;

function logs(text: string): Logs {
  const parsed = parseKubectl(text);
  if (!parsed.ok || parsed.statement.command !== "logs") throw new Error(`not logs: ${text}`);
  return parsed.statement;
}

interface PodShape {
  readonly name: string;
  readonly node?: string;
  readonly phase?: string;
  readonly ready?: string;
  readonly restarts?: number;
  readonly created?: string;
  readonly containers?: readonly string[];
  readonly init?: readonly string[];
  readonly ephemeral?: readonly string[];
  readonly defaultContainer?: string;
}

function pod(shape: PodShape) {
  return {
    metadata: {
      name: shape.name,
      namespace: "shop",
      creationTimestamp: shape.created ?? "2026-10-10T09:00:00Z",
      ...(shape.defaultContainer === undefined
        ? {}
        : { annotations: { "kubectl.kubernetes.io/default-container": shape.defaultContainer } }),
    },
    spec: {
      ...(shape.node === undefined ? {} : { nodeName: shape.node }),
      containers: (shape.containers ?? ["app"]).map((name) => ({ name })),
      ...(shape.init === undefined ? {} : { initContainers: shape.init.map((name) => ({ name })) }),
      ...(shape.ephemeral === undefined ? {} : { ephemeralContainers: shape.ephemeral.map((name) => ({ name })) }),
    },
    status: {
      phase: shape.phase ?? "Running",
      conditions: shape.ready === undefined ? [] : [{ type: "Ready", status: "True", lastTransitionTime: shape.ready }],
      containerStatuses: [{ name: "app", restartCount: shape.restarts ?? 0 }],
    },
  };
}

const logLine = (pod: string, container: string, tail = 500) =>
  `GET /api/v1/namespaces/shop/pods/${pod}/log?container=${container}&tailLines=${tail}&limitBytes=1048576&timestamps=true`;

describe("one pod", () => {
  test("a pod name reads the pod, then its first container's last 500 lines, with the notice and the tail warning", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(pod({ name: "web", containers: ["app", "sidecar"] })),
      [logLine("web", "app")]: textAnswer(
        "2026-10-10T11:59:58.5Z started\n2026-10-10T11:59:59.000000001Z serving on :8080\n",
      ),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await readLogs(context, logs("kubectl logs web"));
    expect(sentLines(transport)).toEqual(["GET /api/v1/namespaces/shop/pods/web", logLine("web", "app")]);
    expect(grid.fields).toEqual(["TIME", "POD", "CONTAINER", "LINE"]);
    expect(grid.rows).toEqual([
      { TIME: "2026-10-10T11:59:58.5Z", POD: "web", CONTAINER: "app", LINE: "started" },
      { TIME: "2026-10-10T11:59:59.000000001Z", POD: "web", CONTAINER: "app", LINE: "serving on :8080" },
    ]);
    expect(grid.warnings).toEqual([
      { message: 'Defaulted container "app" out of: app, sidecar' },
      {
        message:
          "kubectl reads every line when --tail is absent; Studio read the last 500 lines of each stream. Ask for up to 5,000 with --tail.",
      },
    ]);
  });

  test("a log is asked for with the JSON Accept, since an API server answers Accept text/plain with a 406", async () => {
    // Measured on k3s 1.29, 1.30 and 1.35: the log endpoint refuses text/plain and answers the log as text/plain.
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(pod({ name: "web" })),
      [logLine("web", "app")]: (request) =>
        request.headers?.accept === "application/json"
          ? textAnswer("2026-10-10T11:59:58.5Z started\n")
          : jsonAnswer({ kind: "Status", status: "Failure", reason: "NotAcceptable", code: 406 }, 406),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await readLogs(context, logs("kubectl logs web --tail=500"));
    expect(transport.requests.at(-1)?.headers?.accept).toBe("application/json");
    expect(grid.rows).toEqual([{ TIME: "2026-10-10T11:59:58.5Z", POD: "web", CONTAINER: "app", LINE: "started" }]);
  });

  test("the default-container annotation picks the container when it names one; -c always does", async () => {
    const annotated = pod({ name: "web", containers: ["app", "sidecar"], defaultContainer: "sidecar" });
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(annotated),
      [logLine("web", "sidecar")]: textAnswer(""),
      [logLine("web", "app", 20)]: textAnswer("2026-10-10T11:00:00Z x"),
    });
    const { context, transport } = consoleContext(answer);
    expect((await readLogs(context, logs("logs pod/web"))).rows).toEqual([]);
    expect(sentLines(transport).at(-1)).toBe(logLine("web", "sidecar"));
    const chosen = await readLogs(context, logs("logs web -c app --tail=20"));
    expect(chosen.rows).toEqual([{ TIME: "2026-10-10T11:00:00Z", POD: "web", CONTAINER: "app", LINE: "x" }]);
    expect(chosen.warnings).toBeUndefined();
    const stale = consoleContext(
      routes({
        "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(
          pod({ name: "web", containers: ["app"], defaultContainer: "gone" }),
        ),
        [logLine("web", "app")]: textAnswer(""),
      }),
    );
    await readLogs(stale.context, logs("logs web"));
    expect(sentLines(stale.transport).at(-1)).toBe(logLine("web", "app"));
  });

  test("-c naming no container of the pod answers a sentence that does not repeat it", async () => {
    const { context } = consoleContext(
      routes({ "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(pod({ name: "web" })) }),
    );
    await expect(readLogs(context, logs("logs web -c nosuch"))).rejects.toThrow(
      "The container named by -c is not a container of pod web.",
    );
  });

  test("every flag reaches the query: previous, since, limit-bytes; and since-time", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(pod({ name: "web" })),
      "GET /api/v1/namespaces/shop/pods/web/log?container=app&tailLines=5&limitBytes=2048&sinceSeconds=5400&previous=true&timestamps=true":
        textAnswer(""),
      "GET /api/v1/namespaces/shop/pods/web/log?container=app&tailLines=500&limitBytes=1048576&sinceTime=2026-10-10T11%3A00%3A00Z&timestamps=true":
        textAnswer(""),
    });
    const { context } = consoleContext(answer);
    await readLogs(context, logs("logs web -p --tail=5 --since=1h30m --limit-bytes=2048 --timestamps"));
    await readLogs(context, logs("logs web --since-time=2026-10-10T11:00:00Z"));
  });

  test("--all-containers reads init, regular and ephemeral containers; past 5 streams it answers a sentence", async () => {
    const four = pod({ name: "web", init: ["setup"], containers: ["app", "sidecar"], ephemeral: ["debug"] });
    const map: Record<string, ReturnType<typeof textAnswer>> = {};
    for (const container of ["setup", "app", "sidecar", "debug"]) map[logLine("web", container)] = textAnswer("");
    const { context, transport } = consoleContext(
      routes({ "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(four), ...map }),
    );
    await readLogs(context, logs("logs web --all-containers"));
    expect(sentLines(transport).slice(1)).toEqual(
      ["setup", "app", "sidecar", "debug"].map((name) => logLine("web", name)),
    );
    const six = pod({ name: "web", init: ["a", "b"], containers: ["c", "d", "e"], ephemeral: ["f"] });
    const wide = consoleContext(routes({ "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(six) }));
    await expect(readLogs(wide.context, logs("logs web --all-containers"))).rejects.toThrow(
      "This statement would read 6 log streams, more than the 5 Studio reads at once: name one container with -c, or narrow the selector.",
    );
    expect(sentLines(wide.transport)).toEqual(["GET /api/v1/namespaces/shop/pods/web"]);
  });
});

describe("the 5,000 rows of one statement", () => {
  const five = pod({ name: "web", containers: ["a", "b", "c", "d", "e"] });

  test("streams times --tail past 5,000 lines answer a sentence before any log is read", async () => {
    const { context, transport } = consoleContext(routes({ "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(five) }));
    await expect(readLogs(context, logs("logs web --all-containers --tail=5000"))).rejects.toThrow(
      "This statement would read up to 25,000 lines across 5 log streams, more than the 5,000 one statement shows: lower --tail, name one container with -c, or narrow the selector. No log was read.",
    );
    expect(sentLines(transport)).toEqual(["GET /api/v1/namespaces/shop/pods/web"]);
  });

  test("streams times --tail of exactly 5,000 lines are read", async () => {
    const map: Record<string, ReturnType<typeof textAnswer>> = {};
    const lines = (container: string) =>
      Array.from({ length: 1_000 }, (_unused, index) => `2026-10-10T11:00:00Z ${container}${index}`).join("\n");
    for (const container of ["a", "b", "c", "d", "e"])
      map[logLine("web", container, 1_000)] = textAnswer(`${lines(container)}\n`);
    const { context } = consoleContext(routes({ "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(five), ...map }));
    expect((await readLogs(context, logs("logs web --all-containers --tail=1000"))).rows).toHaveLength(5_000);
  });

  test("a stream answering more lines than it was asked for stops at 5,000 with a sentence", async () => {
    const flood = Array.from({ length: 5_001 }, (_unused, index) => `line ${index}`).join("\n");
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(pod({ name: "web" })),
      [logLine("web", "app", 10)]: textAnswer(flood),
    });
    const { context } = consoleContext(answer);
    await expect(readLogs(context, logs("logs web --tail=10"))).rejects.toThrow(
      "The log streams answered more than the 5,000 lines one statement shows: lower --tail, name one container with -c, or narrow the selector.",
    );
  });
});

describe("TYPE/NAME: kubectl's GetFirstPod", () => {
  const SELECTOR = "GET /api/v1/namespaces/shop/pods?limit=500&labelSelector=app%3Dweb%2Ctier+in+%28back%2Cfront%29";

  function deployment(pods: readonly unknown[]) {
    return routes({
      "GET /apis/apps/v1/namespaces/shop/deployments/web": jsonAnswer({
        spec: {
          selector: {
            matchLabels: { app: "web" },
            matchExpressions: [{ key: "tier", operator: "In", values: ["front", "back"] }],
          },
        },
      }),
      [SELECTOR]: listAnswer(pods),
      ...Object.fromEntries(
        ["p-a", "p-b", "p-c", "p-d", "p-e"].map((name) => [
          logLine(name, "app"),
          textAnswer(`2026-10-10T11:00:00Z ${name}`),
        ]),
      ),
    });
  }

  const candidates = [
    pod({ name: "p-a", phase: "Pending" }),
    pod({ name: "p-b", node: "n1", phase: "Pending" }),
    pod({ name: "p-c", node: "n1", phase: "Running" }),
    pod({ name: "p-d", node: "n1", phase: "Running", ready: "2026-10-10T11:00:00Z" }),
    pod({ name: "p-e", node: "n1", phase: "Running", ready: "2026-10-10T10:00:00Z" }),
  ];

  test("deploy/web reads its selector's pods and the one ByLogging puts first", async () => {
    const { context, transport } = consoleContext(deployment(candidates));
    const grid = await readLogs(context, logs("kubectl logs deploy/web"));
    expect(sentLines(transport)).toEqual([
      "GET /apis/apps/v1/namespaces/shop/deployments/web",
      SELECTOR,
      logLine("p-e", "app"),
    ]);
    expect(grid.rows).toEqual([{ TIME: "2026-10-10T11:00:00Z", POD: "p-e", CONTAINER: "app", LINE: "p-e" }]);
  });

  test("--all-pods reads every selected pod, in ByLogging's order", async () => {
    const { context, transport } = consoleContext(deployment(candidates));
    await readLogs(context, logs("logs deploy/web --all-pods"));
    expect(sentLines(transport).slice(2)).toEqual(
      ["p-e", "p-d", "p-c", "p-b", "p-a"].map((name) => logLine(name, "app")),
    );
  });

  test("a Service reads the pods of its plain selector", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/services/web": jsonAnswer({ spec: { selector: { app: "web" } } }),
      "GET /api/v1/namespaces/shop/pods?limit=500&labelSelector=app%3Dweb": listAnswer([
        pod({ name: "p-c", node: "n1" }),
      ]),
      [logLine("p-c", "app")]: textAnswer(""),
    });
    const { context, transport } = consoleContext(answer);
    await readLogs(context, logs("logs svc/web"));
    expect(sentLines(transport).at(-1)).toBe(logLine("p-c", "app"));
  });

  test("an empty selector, no matching pod, and a kind without pods each answer a sentence", async () => {
    const empty = consoleContext(routes({ "GET /api/v1/namespaces/shop/services/web": jsonAnswer({ spec: {} }) }));
    await expect(readLogs(empty.context, logs("logs svc/web"))).rejects.toThrow(
      "services/web selects no pods (its selector is empty), so it has no logs to read; name a pod instead.",
    );
    const none = consoleContext(deployment([]));
    await expect(readLogs(none.context, logs("logs deploy/web"))).rejects.toThrow(
      "No pod matches the selector of deployments/web in the namespace shop, so there are no logs to read.",
    );
    const cron = consoleContext(routes({}));
    await expect(readLogs(cron.context, logs("logs cronjob/nightly"))).rejects.toThrow(
      "kubectl logs reads the pods of a deployment, replica set, stateful set, daemon set, job, replication controller or service; cronjobs has none to read.",
    );
    expect(sentLines(cron.transport)).toEqual([]);
  });
});

describe("-l: every selected pod", () => {
  test("ten lines per pod as kubectl reads them, no tail warning, lines merged by time", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods?limit=500&labelSelector=app%3Dweb": listAnswer([
        pod({ name: "p1" }),
        pod({ name: "p2" }),
      ]),
      [logLine("p1", "app", 10)]: textAnswer("2026-10-10T11:00:02Z b\n2026-10-10T11:00:00.9Z a2\n"),
      [logLine("p2", "app", 10)]: textAnswer("2026-10-10T11:00:00.10Z a1\nno timestamp\n"),
    });
    const { context } = consoleContext(answer);
    const grid = await readLogs(context, logs("logs -l app=web"));
    expect(grid.rows.map((row) => `${row.POD}:${row.LINE}`)).toEqual(["p2:no timestamp", "p2:a1", "p1:a2", "p1:b"]);
    expect(grid.warnings).toBeUndefined();
  });

  test("a page of pods past the byte cap is read again at half the page size, and the logs are still read", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods?limit=500&labelSelector=app%3Dweb": () => {
        throw new TransportError("too-large", "x");
      },
      "GET /api/v1/namespaces/shop/pods?limit=250&labelSelector=app%3Dweb": listAnswer([pod({ name: "p1" })]),
      [logLine("p1", "app", 10)]: textAnswer("2026-10-10T11:00:00Z a\n"),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await readLogs(context, logs("logs -l app=web"));
    expect(grid.rows.map((row) => row.LINE)).toEqual(["a"]);
    expect(sentLines(transport)).toEqual([
      "GET /api/v1/namespaces/shop/pods?limit=500&labelSelector=app%3Dweb",
      "GET /api/v1/namespaces/shop/pods?limit=250&labelSelector=app%3Dweb",
      logLine("p1", "app", 10),
    ]);
  });

  test("a selector matching more than five streams answers the sentence before any log is read", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods?limit=500&labelSelector=app%3Dweb": listAnswer(
        Array.from({ length: 6 }, (_unused, index) => pod({ name: `p${index}` })),
      ),
    });
    const { context, transport } = consoleContext(answer);
    await expect(readLogs(context, logs("logs -l app=web"))).rejects.toThrow("would read 6 log streams");
    expect(sentLines(transport)).toHaveLength(1);
  });
});

describe("the pieces", () => {
  test("ByLogging, rule by rule", () => {
    const sort = (pods: readonly ReturnType<typeof pod>[]) =>
      [...pods].sort(compareForLogging).map((entry) => entry.metadata.name);
    expect(sort([pod({ name: "unassigned" }), pod({ name: "assigned", node: "n" })])).toEqual([
      "assigned",
      "unassigned",
    ]);
    expect(
      sort([
        pod({ name: "pending", node: "n", phase: "Pending" }),
        pod({ name: "unknown", node: "n", phase: "Unknown" }),
        pod({ name: "running", node: "n" }),
      ]),
    ).toEqual(["running", "unknown", "pending"]);
    // A phase ByLogging does not rank (Succeeded, Failed) ranks with Running, as Go's zero value does.
    expect(
      sort([
        pod({ name: "unknown", node: "n", phase: "Unknown" }),
        pod({ name: "done", node: "n", phase: "Succeeded" }),
      ]),
    ).toEqual(["done", "unknown"]);
    expect(
      sort([pod({ name: "not-ready", node: "n" }), pod({ name: "ready", node: "n", ready: "2026-10-10T10:00:00Z" })]),
    ).toEqual(["ready", "not-ready"]);
    expect(
      sort([
        pod({ name: "newer", node: "n", ready: "2026-10-10T11:00:00Z" }),
        pod({ name: "older", node: "n", ready: "2026-10-10T10:00:00Z" }),
      ]),
    ).toEqual(["older", "newer"]);
    expect(sort([pod({ name: "calm", node: "n" }), pod({ name: "restarting", node: "n", restarts: 4 })])).toEqual([
      "restarting",
      "calm",
    ]);
    expect(
      sort([
        pod({ name: "young", node: "n", created: "2026-10-10T11:00:00Z" }),
        pod({ name: "old", node: "n", created: "2026-10-10T08:00:00Z" }),
      ]),
    ).toEqual(["old", "young"]);
    expect(sort([pod({ name: "b", node: "n" }), pod({ name: "a", node: "n" })])).toEqual(["b", "a"]);
    // kubectl's afterOrZero: a zero time, a ready pod with no lastTransitionTime or a pod with no creationTimestamp,
    // sorts after any real one.
    const untimed = pod({ name: "ready-untimed", node: "n", ready: "2026-10-10T10:00:00Z" });
    delete (untimed.status.conditions[0] as { lastTransitionTime?: string }).lastTransitionTime;
    const timed = pod({ name: "ready-timed", node: "n", ready: "2026-10-10T11:00:00Z" });
    expect(sort([untimed, timed])).toEqual(["ready-timed", "ready-untimed"]);
    expect(sort([timed, untimed])).toEqual(["ready-timed", "ready-untimed"]);
    const unborn = pod({ name: "no-creation", node: "n" });
    delete (unborn.metadata as { creationTimestamp?: string }).creationTimestamp;
    const born = pod({ name: "created", node: "n", created: "2026-10-10T11:00:00Z" });
    expect(sort([unborn, born])).toEqual(["created", "no-creation"]);
    expect(sort([born, unborn])).toEqual(["created", "no-creation"]);
  });

  test("selectors as the API reads them, sorted by key", () => {
    expect(
      selectorText({
        matchLabels: { tier: "front", app: "web" },
        matchExpressions: [
          { key: "zone", operator: "NotIn", values: ["b", "a"] },
          { key: "canary", operator: "DoesNotExist" },
          { key: "env", operator: "Exists" },
          { key: "x", operator: "Bogus" },
        ],
      }),
    ).toBe("app=web,!canary,env,tier=front,zone notin (a,b)");
  });

  test("the timestamp prefix is split from the line", () => {
    expect(splitTimestamp("2026-10-10T11:00:00.123Z hello world")).toEqual({
      time: "2026-10-10T11:00:00.123Z",
      text: "hello world",
    });
    expect(splitTimestamp("2026-10-10T11:00:00+02:00 x")).toEqual({ time: "2026-10-10T11:00:00+02:00", text: "x" });
    expect(splitTimestamp("plain")).toEqual({ time: null, text: "plain" });
  });

  test("a prefix without two-digit hour, minute and second is text, so the merge never meets a short time", async () => {
    expect(splitTimestamp("2026-10-10T1:00:00Z x")).toEqual({ time: null, text: "2026-10-10T1:00:00Z x" });
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(pod({ name: "web" })),
      [logLine("web", "app")]: textAnswer("2026-10-10T1:00:00Z first\n2026-10-10T1:00:01Z second\n"),
    });
    const { context } = consoleContext(answer);
    const grid = await readLogs(context, logs("kubectl logs web"));
    expect(grid.rows.map((row) => row.LINE)).toEqual(["2026-10-10T1:00:00Z first", "2026-10-10T1:00:01Z second"]);
  });

  test("more than 5,000 selected pods answer a sentence before any log is read", async () => {
    const pods = (request: NodeRequest) => {
      const search = new URL(request.url).searchParams;
      const start = Number(search.get("continue") ?? "0");
      const count = Number(search.get("limit"));
      return listAnswer(
        Array.from({ length: count }, (_unused, index) => pod({ name: `p${start + index}` })),
        { continue: String(start + count) },
      );
    };
    const { context, transport } = consoleContext((request, line) =>
      line.startsWith("GET /api/v1/namespaces/shop/pods?") ? pods(request) : routes({})(request, line),
    );
    await expect(readLogs(context, logs("logs -l app=web"))).rejects.toThrow(
      "More than 5,000 pods match the selector: narrow it before reading their logs.",
    );
    expect(sentLines(transport).every((line) => !line.includes("/log?"))).toBe(true);
  });
});

/**
 * kubectl's notice when it defaults the container (`logsForObjectWithClient` in `pkg/polymorphichelpers/logsforobject.go`
 * and `AllContainerNames` in `pkg/cmd/util/podcmd/podcmd.go`): printed when no container is named, the annotation names
 * none of the pod's, and the pod has more than one container, or any init or ephemeral container.
 */
describe("the defaulted container notice", () => {
  const JENKINS = pod({
    name: "jenkins-0",
    containers: ["jenkins", "config-reload", "kube-app-server", "ci-utility-proxy", "config-reload-jobs"],
    init: ["init"],
  });

  async function warningsOf(shape: ReturnType<typeof pod>, statement: string, container: string) {
    const name = shape.metadata.name;
    const { context, transport } = consoleContext(
      routes({
        [`GET /api/v1/namespaces/shop/pods/${name}`]: jsonAnswer(shape),
        [logLine(name, container, 50)]: textAnswer("2026-10-10T11:00:00Z x\n"),
      }),
    );
    const grid = await readLogs(context, logs(statement));
    expect(sentLines(transport).at(-1)).toBe(logLine(name, container, 50));
    return grid.warnings;
  }

  test("several containers and no -c: kubectl's sentence, the measured jenkins-0 case", async () => {
    expect(await warningsOf(JENKINS, "kubectl logs pod/jenkins-0 -n shop --tail=50", "jenkins")).toEqual([
      {
        message:
          'Defaulted container "jenkins" out of: jenkins, config-reload, kube-app-server, ci-utility-proxy, config-reload-jobs, init (init)',
      },
    ]);
  });

  test("-c, --all-containers, an annotation naming a container of the pod, and one plain container say nothing", async () => {
    expect(await warningsOf(JENKINS, "logs jenkins-0 -c config-reload --tail=50", "config-reload")).toBeUndefined();
    const annotated = pod({ name: "web", containers: ["app", "sidecar"], defaultContainer: "sidecar" });
    expect(await warningsOf(annotated, "logs web --tail=50", "sidecar")).toBeUndefined();
    expect(await warningsOf(pod({ name: "web" }), "logs web --tail=50", "app")).toBeUndefined();
    const two = pod({ name: "web", containers: ["app", "sidecar"] });
    const { context } = consoleContext(
      routes({
        "GET /api/v1/namespaces/shop/pods/web": jsonAnswer(two),
        [logLine("web", "app", 50)]: textAnswer(""),
        [logLine("web", "sidecar", 50)]: textAnswer(""),
      }),
    );
    expect((await readLogs(context, logs("logs web --all-containers --tail=50"))).warnings).toBeUndefined();
  });

  test("one container and an init container alone is enough, and the init container reads (init)", async () => {
    const shape = pod({ name: "web", containers: ["app"], init: ["setup"] });
    expect(await warningsOf(shape, "logs web --tail=50", "app")).toEqual([
      { message: 'Defaulted container "app" out of: app, setup (init)' },
    ]);
  });

  test("containers, then ephemeral containers with (ephem), then init containers with (init)", async () => {
    const shape = pod({ name: "web", containers: ["app"], init: ["setup", "migrate"], ephemeral: ["debug"] });
    expect(await warningsOf(shape, "logs web --tail=50", "app")).toEqual([
      { message: 'Defaulted container "app" out of: app, debug (ephem), setup (init), migrate (init)' },
    ]);
  });

  test("an annotation naming no container of the pod is said, and the first container is defaulted with the notice", async () => {
    const shape = pod({ name: "web", containers: ["app", "sidecar"], defaultContainer: "gone" });
    expect(await warningsOf(shape, "logs web --tail=50", "app")).toEqual([
      { message: 'Default container name "gone" not found in pod web' },
      { message: 'Defaulted container "app" out of: app, sidecar' },
    ]);
    const single = pod({ name: "web", containers: ["app"], defaultContainer: "gone" });
    expect(await warningsOf(single, "logs web --tail=50", "app")).toEqual([
      { message: 'Default container name "gone" not found in pod web' },
    ]);
  });

  test("an empty annotation is no choice: only the first container is defaulted, as kubectl checks a non-empty name", async () => {
    const shape = pod({ name: "web", containers: ["app", "sidecar"], defaultContainer: "" });
    expect(await warningsOf(shape, "logs web --tail=50", "app")).toEqual([
      { message: 'Defaulted container "app" out of: app, sidecar' },
    ]);
  });

  test("-l says it once for pods that default alike; --all-pods says nothing, as kubectl prints nothing there", async () => {
    const two = [
      pod({ name: "p1", containers: ["app", "sidecar"] }),
      pod({ name: "p2", containers: ["app", "sidecar"] }),
    ];
    const selected = consoleContext(
      routes({
        "GET /api/v1/namespaces/shop/pods?limit=500&labelSelector=app%3Dweb": listAnswer(two),
        [logLine("p1", "app", 10)]: textAnswer(""),
        [logLine("p2", "app", 10)]: textAnswer(""),
      }),
    );
    expect((await readLogs(selected.context, logs("logs -l app=web"))).warnings).toEqual([
      { message: 'Defaulted container "app" out of: app, sidecar' },
    ]);
    const all = consoleContext(
      routes({
        "GET /apis/apps/v1/namespaces/shop/deployments/web": jsonAnswer({
          spec: { selector: { matchLabels: { app: "web" } } },
        }),
        "GET /api/v1/namespaces/shop/pods?limit=500&labelSelector=app%3Dweb": listAnswer(two),
        [logLine("p1", "app", 50)]: textAnswer(""),
        [logLine("p2", "app", 50)]: textAnswer(""),
      }),
    );
    expect((await readLogs(all.context, logs("logs deploy/web --all-pods --tail=50"))).warnings).toBeUndefined();
  });
});

/**
 * Terminal escape sequences in a log line: kubectl writes the bytes to a terminal, which draws the colors; the grid
 * cannot, so the sequences are removed and every other character stays as the server sent it.
 */
describe("terminal escape sequences", () => {
  const ESC = "\u001b";

  test("the measured frp line loses its SGR codes and keeps its text", () => {
    expect(
      stripTerminalEscapes(
        `2026/10/11 10:21:12 ${ESC}[1;34m[I] [service.go:304] [f366ca8bcfd892f8] login to server success, get run id [f366ca8bcfd892f8], server udp port [0]${ESC}[0m`,
      ),
    ).toBe(
      "2026/10/11 10:21:12 [I] [service.go:304] [f366ca8bcfd892f8] login to server success, get run id [f366ca8bcfd892f8], server udp port [0]",
    );
  });

  test("256-color and truecolor SGR, and a CSI with intermediates", () => {
    expect(stripTerminalEscapes(`${ESC}[38;5;196mred${ESC}[0m`)).toBe("red");
    expect(stripTerminalEscapes(`${ESC}[38;2;255;128;0morange${ESC}[m`)).toBe("orange");
    expect(stripTerminalEscapes(`a${ESC}[2 qb${ESC}[?25lc`)).toBe("abc");
  });

  test("an OSC 8 hyperlink, ended by ST or by BEL, keeps only its text", () => {
    expect(stripTerminalEscapes(`see ${ESC}]8;;https://example.com/x${ESC}\\docs${ESC}]8;;${ESC}\\ here`)).toBe(
      "see docs here",
    );
    expect(stripTerminalEscapes(`${ESC}]0;title\u0007text`)).toBe("text");
  });

  test("the other two-byte sequences are removed", () => {
    expect(stripTerminalEscapes(`${ESC}7saved${ESC}8 ${ESC}Mup ${ESC}=keypad`)).toBe("saved up keypad");
  });

  test("nF sequences such as the ESC ( B that tput sgr0 writes before ESC [ m are removed", () => {
    expect(stripTerminalEscapes(`${ESC}[1mbold${ESC}(B${ESC}[m rest`)).toBe("bold rest");
    expect(stripTerminalEscapes(`a${ESC})0b`)).toBe("ab");
    expect(stripTerminalEscapes(`a${ESC}%Gb${ESC}$(Bc`)).toBe("abc");
  });

  test("a line with no escape is unchanged, tabs and spaces included, and an unfinished sequence stays", () => {
    expect(stripTerminalEscapes("a\tb  c [0m")).toBe("a\tb  c [0m");
    expect(stripTerminalEscapes(`done${ESC}`)).toBe(`done${ESC}`);
    expect(stripTerminalEscapes(`${ESC}]8;;https://example.com no end`)).toBe(`${ESC}]8;;https://example.com no end`);
  });

  test("100,000 characters of ESC [ and digits with no final byte finish in well under a second", () => {
    const one = `${ESC}[${"1".repeat(99_998)}`;
    const many = `${ESC}[1`.repeat(33_334).slice(0, 100_000);
    for (const line of [one, many]) {
      expect(line).toHaveLength(100_000);
      const started = performance.now();
      expect(stripTerminalEscapes(line)).toBe(line);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  test("readLogs removes them from each LINE, after the timestamp is split off", async () => {
    const { context } = consoleContext(
      routes({
        "GET /api/v1/namespaces/shop/pods/frps": jsonAnswer(pod({ name: "frps" })),
        [logLine("frps", "app", 50)]: textAnswer(`2026-10-11T10:21:12Z ${ESC}[1;34m[I] login\tok${ESC}[0m\n`),
      }),
    );
    const grid = await readLogs(context, logs("logs frps --tail=50"));
    expect(grid.rows).toEqual([{ TIME: "2026-10-11T10:21:12Z", POD: "frps", CONTAINER: "app", LINE: "[I] login\tok" }]);
  });
});
