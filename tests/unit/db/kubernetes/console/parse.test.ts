/**
 * The kubectl parser: every reading rule, every pflag form, every command of v1 with its flags, and every refusal
 * sentence, none of which quotes a value the user typed.
 */
import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_FLAGS,
  KUBECTL_COMMAND_TABLE,
  KUBECTL_MAX_LABEL_COLUMNS,
  KUBECTL_MAX_TEXT_BYTES,
  KUBECTL_SENTENCES as S,
  commandSpec,
  connectionFlagSentence,
  echoName,
  notInV1CommandSentence,
  notInV1FlagSentence,
  notInV1OutputSentence,
  notReadOnlySentence,
  tooManyNamesSentence,
} from "@/lib/db/providers/platform/kubernetes/console/commands";
import { KUBERNETES_LOG_LIMIT_BYTES, KUBERNETES_LOG_TAIL_MAX } from "@/lib/db/providers/platform/kubernetes/limits";
import {
  goDurationMs,
  isPageable,
  type KubectlStatement,
  parseKubectl,
} from "@/lib/db/providers/platform/kubernetes/console/parse";

const MARKER = "marker-value-never-echoed";

function parsed(text: string): KubectlStatement {
  const result = parseKubectl(text);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(text)} to parse, got: ${result.refusal.message}`);
  return result.statement;
}

function refusal(text: string): { readonly code: string; readonly message: string } {
  const result = parseKubectl(text);
  if (result.ok) throw new Error(`expected ${JSON.stringify(text)} to be refused`);
  expect(result.refusal.message).not.toContain(MARKER);
  return result.refusal;
}

const GET_DEFAULTS = {
  command: "get",
  names: [],
  allNamespaces: false,
  output: "table",
  showLabels: false,
  labelColumns: [],
  ignoreNotFound: false,
  watch: false,
} as const;

describe("the reading rules", () => {
  test.each([
    "get pods -n shop",
    "kubectl get pods -n shop",
    "$ kubectl get pods -n shop",
    "% get pods -n shop",
    "# the shop's pods\nkubectl get pods -n shop",
    "kubectl get pods \\\n  -n shop",
    "kubectl -n shop get pods",
    "kubectl get -n shop pods",
    'kubectl "-n" shop get pods',
  ])("%j reads as get pods in shop", (text) => {
    expect(parsed(text)).toEqual({ ...GET_DEFAULTS, type: "pods", namespace: "shop" });
  });

  test("an empty text, a comment alone and flags alone are refused", () => {
    expect(refusal("")).toEqual({ code: "empty", message: S.empty });
    expect(refusal("# nothing")).toEqual({ code: "empty", message: S.empty });
    expect(refusal("kubectl -n shop")).toEqual({ code: "no-command", message: S.noCommand });
  });

  test("the shared reader's refusals pass through: a pipe, a second command, an unclosed quote, a $", () => {
    expect(refusal("kubectl get pods | head").code).toBe("shell");
    expect(refusal("get pods\nget nodes").code).toBe("shell");
    expect(refusal("get pods -l 'app=web").code).toBe("shell");
    expect(refusal("get pods -n $NS").code).toBe("shell");
  });

  test("a text over the byte bound is refused before it is read", () => {
    expect(refusal(`get pods # ${"x".repeat(KUBECTL_MAX_TEXT_BYTES)}`)).toEqual({
      code: "too-large",
      message: "The statement is longer than 65536 bytes, the most this console reads. Nothing was sent.",
    });
  });

  test("-- ends the flags, so a later dash word is an argument", () => {
    expect(parsed("get pods -- -x")).toMatchObject({ names: ["-x"] });
    expect(parsed("kubectl -- get pods")).toMatchObject({ command: "get", type: "pods" });
  });
});

describe("the pflag forms", () => {
  test.each([
    ["get pods -n shop", { namespace: "shop" }],
    ["get pods -n=shop", { namespace: "shop" }],
    ["get pods -nshop", { namespace: "shop" }],
    ["get pods --namespace shop", { namespace: "shop" }],
    ["get pods --namespace=shop", { namespace: "shop" }],
    ["get pods -o=yaml", { output: "yaml" }],
    ["get pods -oyaml", { output: "yaml" }],
    ["get pods --output yaml", { output: "yaml" }],
    ["get pods -lapp=web", { labelSelector: "app=web" }],
    ["get pods --selector app=web", { labelSelector: "app=web" }],
    ["get pods -A", { allNamespaces: true }],
    ["get pods --all-namespaces", { allNamespaces: true }],
    ["get pods --all-namespaces=false", { allNamespaces: false }],
    ["get pods -A=true", { allNamespaces: true }],
    ["get pods -Aw", { allNamespaces: true, watch: true }],
    ["get pods --watch", { watch: true }],
    ["get pods -Aowide", { allNamespaces: true, output: "wide" }],
    ["get pods -L app -L tier,zone", { labelColumns: ["app", "tier", "zone"] }],
    ["get pods --label-columns=app.kubernetes.io/name", { labelColumns: ["app.kubernetes.io/name"] }],
    ["get pods --show-labels", { showLabels: true }],
    ["get pods --field-selector status.phase=Running", { fieldSelector: "status.phase=Running" }],
    ["get pods --request-timeout=5s", { requestTimeoutSeconds: 5 }],
    ["get pods --request-timeout 30", { requestTimeoutSeconds: 30 }],
    ["get pods --request-timeout=1m30s", { requestTimeoutSeconds: 90 }],
    ["get pod web --ignore-not-found", { names: ["web"], ignoreNotFound: true }],
  ])("%j", (text, expected) => {
    expect(parsed(text)).toMatchObject(expected);
  });

  test("a flag given twice is refused; a list flag adds up", () => {
    expect(refusal("get pods -n a -n b")).toEqual({
      code: "repeated-flag",
      message: "The flag -n is given twice: give it once. Nothing was sent.",
    });
    expect(refusal("get pods -A --all-namespaces").code).toBe("repeated-flag");
  });

  test("a value flag at the end and a boolean with another value are refused, naming the flag only", () => {
    expect(refusal("get pods -n")).toEqual({
      code: "bad-value",
      message: "The flag -n needs a value. Nothing was sent.",
    });
    expect(refusal(`get pods --show-labels=${MARKER}`)).toEqual({
      code: "bad-value",
      message: "The flag --show-labels takes true or false. Nothing was sent.",
    });
    expect(refusal(`get pods -A=${MARKER}`).code).toBe("bad-value");
  });
});

describe("get", () => {
  test("the list form, names and TYPE/NAME", () => {
    expect(parsed("get deploy")).toEqual({ ...GET_DEFAULTS, type: "deploy" });
    expect(parsed("get pod web api")).toMatchObject({ type: "pod", names: ["web", "api"] });
    expect(parsed("get pod/web pod/api")).toMatchObject({ type: "pod", names: ["web", "api"] });
    expect(parsed("get widgets.probe.libredb.dev")).toMatchObject({ type: "widgets.probe.libredb.dev" });
  });

  test("the named form reads at most 500 names, whatever the output, and one more is refused", () => {
    const names = (count: number, prefix = "") =>
      Array.from({ length: count }, (_unused, index) => `${prefix}p${index}`).join(" ");
    expect(parsed(`get pods ${names(500)}`)).toMatchObject({ type: "pods", names: expect.arrayContaining(["p499"]) });
    expect(parsed(`get pods ${names(500)} -o yaml`)).toMatchObject({ output: "yaml" });
    for (const output of ["", " -o wide", " -o name", " -o json", " -o yaml"]) {
      expect(refusal(`get pods ${names(501)}${output}`)).toEqual({
        code: "bad-arguments",
        message: tooManyNamesSentence(500),
      });
    }
    expect(refusal(`get ${names(501, "pod/")}`).message).toBe(tooManyNamesSentence(500));
  });

  test("one type per statement: get all, TYPE,TYPE and two TYPE/NAME types", () => {
    for (const text of ["get all -n shop", "get ALL", "get pods,services"]) {
      expect(refusal(text)).toEqual({ code: "one-type", message: S.oneType });
    }
  });

  test("TYPE/NAME arguments spelling their type two ways answer their own sentence", () => {
    for (const text of ["get po/web pods/api", "get pod/web svc/web"])
      expect(refusal(text)).toEqual({ code: "one-type", message: S.typeSpelling });
    expect(S.typeSpelling).toBe(
      "Write each resource/name argument with the same type spelling, such as pods/web pods/api: kubectl get reads one type per statement in v1. Nothing was sent.",
    );
  });

  test("the argument shapes kubectl refuses", () => {
    expect(refusal("get")).toEqual({ code: "bad-arguments", message: S.getNeedsType });
    expect(refusal("get pod/web api")).toEqual({ code: "bad-arguments", message: S.typeNameMixed });
    expect(refusal("get pod web/api")).toEqual({ code: "bad-arguments", message: S.typeNameMixed });
    expect(refusal("get pod/")).toEqual({ code: "bad-arguments", message: S.typeNameForm });
    expect(refusal("get pod/a/b")).toEqual({ code: "bad-arguments", message: S.typeNameForm });
    expect(refusal("get pod web -A")).toEqual({ code: "bad-arguments", message: S.namesAcrossNamespaces });
    expect(refusal("get pod web -l app=web")).toEqual({ code: "bad-arguments", message: S.namesWithSelector });
    expect(refusal("get pod web --field-selector a=b")).toEqual({
      code: "bad-arguments",
      message: S.namesWithSelector,
    });
    expect(refusal("get pod web -w")).toEqual({ code: "bad-arguments", message: S.watchListOnly });
  });

  test("-o takes wide, name, json and yaml; the template formats are named in their refusal", () => {
    for (const format of ["wide", "name", "json", "yaml"])
      expect(parsed(`get pods -o ${format}`)).toMatchObject({ output: format });
    expect(refusal("kubectl get pods -o jsonpath='{.items[*].metadata.name}'")).toEqual({
      code: "not-in-v1",
      message: notInV1OutputSentence("jsonpath"),
    });
    for (const format of ["jsonpath-file", "custom-columns", "go-template", "go-template-file", "template"]) {
      expect(refusal(`get pods -o ${format}=x`).message).toBe(notInV1OutputSentence(format));
    }
    expect(refusal(`get pods -o ${MARKER}`)).toEqual({ code: "not-in-v1", message: S.outputFormat });
  });

  test("-w takes the table or -o wide; label columns take the table", () => {
    expect(parsed("get pods -w -o wide")).toMatchObject({ watch: true, output: "wide" });
    expect(refusal("get pods -w -o yaml")).toEqual({ code: "not-in-v1", message: S.watchOutput });
    expect(refusal("get pods --show-labels -o name")).toEqual({ code: "bad-arguments", message: S.labelColumnsOutput });
    expect(refusal("get pods -L app -o json").code).toBe("bad-arguments");
    expect(refusal("get pods -L 'a b'")).toEqual({ code: "bad-value", message: S.labelColumns });
  });

  test("-L keys are deduplicated in order, and more than 16 distinct keys are refused", () => {
    const keys = (count: number) => Array.from({ length: count }, (_unused, index) => `k${index}`);
    expect(KUBECTL_MAX_LABEL_COLUMNS).toBe(16);
    expect(parsed(`get pods -L ${keys(16).join(",")} -L k0,k15 -L k3`)).toMatchObject({ labelColumns: keys(16) });
    expect(parsed("get pods -L app,tier,app")).toMatchObject({ labelColumns: ["app", "tier"] });
    expect(refusal(`get pods -L ${keys(17).join(",")}`)).toEqual({ code: "bad-value", message: S.labelColumnsCount });
    expect(refusal(`get pods -L ${keys(16).join(",")} -L extra`).message).toBe(S.labelColumnsCount);
  });

  test("with -w, --request-timeout is the watch window and takes whole seconds, at least 1", () => {
    expect(parsed("get pods -w --request-timeout=5s")).toMatchObject({ watch: true, requestTimeoutSeconds: 5 });
    expect(parsed("get pods -w --request-timeout 30")).toMatchObject({ requestTimeoutSeconds: 30 });
    expect(parsed("get pods -w --request-timeout=2000ms")).toMatchObject({ requestTimeoutSeconds: 2 });
    for (const timeout of ["2.5s", "1500ms", "500ms"])
      expect(refusal(`get pods -w --request-timeout=${timeout}`)).toEqual({
        code: "bad-value",
        message: S.watchWindow,
      });
    expect(parsed("get pods --request-timeout=2.5s")).toMatchObject({ watch: false, requestTimeoutSeconds: 2.5 });
  });

  test("values outside their rule are refused without the value", () => {
    expect(refusal(`get pods -n ${MARKER.toUpperCase()}`)).toEqual({ code: "bad-value", message: S.namespace });
    expect(refusal("get pods -l ''")).toEqual({ code: "bad-value", message: S.selector });
    expect(refusal("get pods --request-timeout=0")).toEqual({ code: "bad-value", message: S.requestTimeout });
    expect(refusal("get pods --request-timeout=soon")).toEqual({ code: "bad-value", message: S.requestTimeout });
  });

  test("--sort-by, --raw and -f are not in v1 on get, named in the sentence", () => {
    expect(refusal("kubectl get events --sort-by=.lastTimestamp")).toEqual({
      code: "not-in-v1",
      message: notInV1FlagSentence("--sort-by", "get"),
    });
    expect(refusal("get --raw /metrics").message).toBe(notInV1FlagSentence("--raw", "get"));
    expect(refusal("get -f pod.yaml").message).toBe(notInV1FlagSentence("-f", "get"));
  });
});

describe("describe", () => {
  test("one object, TYPE NAME or TYPE/NAME, with -n", () => {
    expect(parsed("describe pod web -n shop")).toEqual({
      command: "describe",
      type: "pod",
      name: "web",
      namespace: "shop",
    });
    expect(parsed("describe clusterrole/system:aggregate-to-view")).toEqual({
      command: "describe",
      type: "clusterrole",
      name: "system:aggregate-to-view",
    });
  });

  test("a prefix, a selector, two objects or one type alone are refused", () => {
    for (const text of ["describe pods", "describe pod a b", "describe pod/a pod/b", "describe -l app=web pods"]) {
      expect(refusal(text)).toMatchObject({ message: S.describeOne });
    }
    expect(refusal("describe all")).toEqual({ code: "bad-arguments", message: S.describeOne });
    expect(refusal("describe all x").code).toBe("one-type");
  });
});

describe("logs", () => {
  test("a pod, TYPE/NAME, or a selector, with every flag of the column", () => {
    expect(parsed("logs web -n shop")).toEqual({
      command: "logs",
      target: { name: "web" },
      namespace: "shop",
      allContainers: false,
      allPods: false,
      previous: false,
    });
    expect(
      parsed("logs deploy/web -c app --all-pods -p --tail=20 --since=1h30m --timestamps --limit-bytes 4096"),
    ).toMatchObject({
      target: { type: "deploy", name: "web" },
      container: "app",
      allPods: true,
      previous: true,
      tail: 20,
      sinceSeconds: 5_400,
      limitBytes: 4_096,
    });
    expect(parsed("logs -l app=web --all-containers --since-time 2026-10-10T12:00:00Z")).toMatchObject({
      labelSelector: "app=web",
      allContainers: true,
      sinceTime: "2026-10-10T12:00:00Z",
    });
    expect(parsed("logs web --since=1500ms")).toMatchObject({ sinceSeconds: 2 });
  });

  test("follow is refused with its own sentence", () => {
    expect(refusal("kubectl logs -f deploy/web")).toEqual({ code: "follow", message: S.follow });
    expect(refusal("logs web --follow")).toEqual({ code: "follow", message: S.follow });
    expect(S.follow).toBe(
      "follow is not available in v1; remove -f to read the latest lines, and run again to refresh.",
    );
  });

  test("--tail and --limit-bytes take their caps from limits.ts, at the cap and one past it", () => {
    expect(parsed(`logs web --tail=${KUBERNETES_LOG_TAIL_MAX}`)).toMatchObject({ tail: KUBERNETES_LOG_TAIL_MAX });
    expect(refusal(`logs web --tail=${KUBERNETES_LOG_TAIL_MAX + 1}`)).toEqual({ code: "bad-value", message: S.tail });
    expect(parsed(`logs web --limit-bytes=${KUBERNETES_LOG_LIMIT_BYTES}`)).toMatchObject({
      limitBytes: KUBERNETES_LOG_LIMIT_BYTES,
    });
    expect(refusal(`logs web --limit-bytes=${KUBERNETES_LOG_LIMIT_BYTES + 1}`)).toEqual({
      code: "bad-value",
      message: S.limitBytes,
    });
  });

  test("values above a cap, zero and kubectl's -1 are refused, never clamped", () => {
    for (const tail of ["0", "-1", "5001", "x"])
      expect(refusal(`logs web --tail=${tail}`)).toEqual({ code: "bad-value", message: S.tail });
    expect(parsed("logs web --tail 5000")).toMatchObject({ tail: 5_000 });
    expect(refusal("logs web --tail -1")).toEqual({ code: "bad-value", message: S.tail });
    expect(refusal("logs web --limit-bytes=1048577")).toEqual({ code: "bad-value", message: S.limitBytes });
    expect(parsed("logs web --limit-bytes=1048576")).toMatchObject({ limitBytes: 1_048_576 });
    expect(refusal("logs web --since=0s")).toEqual({ code: "bad-value", message: S.since });
    expect(refusal("logs web --since=400ms")).toEqual({ code: "bad-value", message: S.since });
    expect(refusal("logs web --since=1d")).toEqual({ code: "bad-value", message: S.since });
    expect(refusal("logs web --since-time=yesterday")).toEqual({ code: "bad-value", message: S.sinceTime });
    expect(refusal("logs web --since=1h --since-time=2026-10-10T12:00:00Z")).toEqual({
      code: "bad-arguments",
      message: S.sinceBoth,
    });
  });

  test("the argument shapes kubectl refuses", () => {
    expect(refusal("logs")).toEqual({ code: "bad-arguments", message: S.logsTarget });
    expect(refusal("logs web -l app=web")).toEqual({ code: "bad-arguments", message: S.logsSelectorAndName });
    expect(refusal("logs web sidecar")).toEqual({ code: "bad-arguments", message: S.logsContainerArgument });
    expect(refusal("logs web -c app --all-containers")).toEqual({
      code: "bad-arguments",
      message: S.logsContainerAndAll,
    });
    expect(refusal("logs web -c App")).toEqual({ code: "bad-value", message: S.container });
  });
});

describe("top, events, api-resources, api-versions, explain, auth and version", () => {
  test("top pod and top node take kubectl's aliases and --sort-by cpu or memory", () => {
    expect(parsed("top pods -A --sort-by=memory")).toEqual({
      command: "top",
      resource: "pod",
      allNamespaces: true,
      sortBy: "memory",
    });
    expect(parsed("top no -l role=worker")).toEqual({
      command: "top",
      resource: "node",
      allNamespaces: false,
      labelSelector: "role=worker",
    });
    expect(refusal("top pod --sort-by=name")).toEqual({ code: "bad-value", message: S.topSortBy });
    expect(refusal("top pod web")).toEqual({ code: "bad-arguments", message: S.topArguments });
    expect(refusal("top service").message).toBe(notInV1CommandSentence("top with this subcommand"));
    expect(refusal("top").message).toBe(notInV1CommandSentence("top"));
  });

  test("events takes -n, -A, --for and --types", () => {
    expect(parsed("events -n shop --for pod/web --types=Warning,normal --types warning")).toEqual({
      command: "events",
      namespace: "shop",
      allNamespaces: false,
      forObject: { type: "pod", name: "web" },
      types: ["Warning", "Normal"],
    });
    expect(refusal("events --for web")).toEqual({ code: "bad-value", message: S.eventsFor });
    expect(refusal("events --types=Error")).toEqual({ code: "bad-value", message: S.eventsTypes });
    expect(refusal("events pod")).toEqual({ code: "bad-arguments", message: S.eventsArguments });
    expect(refusal("events -w").message).toBe(notInV1FlagSentence("-w", "events"));
  });

  test("api-resources and api-versions", () => {
    expect(parsed("api-resources --namespaced=false --api-group= --verbs=list,watch -o wide")).toEqual({
      command: "api-resources",
      namespaced: false,
      apiGroup: "",
      verbs: ["list", "watch"],
      output: "wide",
    });
    expect(parsed("api-resources")).toEqual({ command: "api-resources", verbs: [], output: "table" });
    expect(refusal("api-resources -o json")).toEqual({ code: "not-in-v1", message: S.apiResourcesOutput });
    expect(refusal("api-resources --api-group=Apps")).toEqual({ code: "bad-value", message: S.apiGroup });
    expect(refusal("api-resources --verbs=GET")).toEqual({ code: "bad-value", message: S.verbs });
    expect(parsed("api-versions")).toEqual({ command: "api-versions" });
    expect(refusal("api-versions x")).toEqual({ code: "bad-arguments", message: S.noArguments });
  });

  test("explain takes one resource and a field path, --recursive and --api-version", () => {
    expect(parsed("explain pods.spec.containers --recursive --api-version=v1")).toEqual({
      command: "explain",
      type: "pods",
      fieldPath: ["spec", "containers"],
      recursive: true,
      apiVersion: "v1",
    });
    expect(parsed("explain widgets --api-version probe.libredb.dev/v1")).toMatchObject({
      apiVersion: "probe.libredb.dev/v1",
    });
    expect(refusal("explain")).toEqual({ code: "bad-arguments", message: S.explainTarget });
    expect(refusal("explain pods..spec")).toEqual({ code: "bad-arguments", message: S.explainTarget });
    expect(refusal("explain pods --api-version=apps/one")).toEqual({ code: "bad-value", message: S.apiVersion });
  });

  test("auth can-i reads TYPE/NAME as a name, takes --subresource, -n, -A and --list", () => {
    expect(parsed("auth can-i get pods/exec -n shop")).toEqual({
      command: "auth-can-i",
      check: { verb: "get", type: "pods", name: "exec" },
      namespace: "shop",
      allNamespaces: false,
    });
    expect(parsed("auth can-i create pods --subresource=exec -A")).toMatchObject({
      allNamespaces: true,
      subresource: "exec",
    });
    expect(parsed("auth can-i '*' '*'")).toMatchObject({ check: { verb: "*", type: "*" } });
    expect(parsed("auth can-i --list -n shop")).toEqual({
      command: "auth-can-i",
      namespace: "shop",
      allNamespaces: false,
    });
    expect(refusal("auth can-i --list -A")).toEqual({ code: "bad-arguments", message: S.canIList });
    expect(refusal("auth can-i get")).toEqual({ code: "bad-arguments", message: S.canIArguments });
    expect(refusal("auth can-i GET pods")).toEqual({ code: "bad-value", message: S.canIVerb });
    expect(refusal("auth can-i get /healthz")).toEqual({ code: "not-in-v1", message: S.nonResourceUrl });
    expect(refusal("auth can-i get pods --subresource=Exec")).toEqual({ code: "bad-value", message: S.subresource });
  });

  test("auth whoami and version take nothing", () => {
    expect(parsed("auth whoami")).toEqual({ command: "auth-whoami" });
    expect(parsed("kubectl version")).toEqual({ command: "version" });
    expect(refusal("version --client").message).toBe(notInV1FlagSentence("--client", "version"));
    expect(refusal("auth whoami -o json").message).toBe(notInV1FlagSentence("-o", "auth whoami"));
  });
});

describe("refused commands", () => {
  test.each([
    "delete",
    "apply",
    "edit",
    "patch",
    "scale",
    "exec",
    "attach",
    "cp",
    "port-forward",
    "proxy",
    "debug",
    "run",
    "drain",
  ])("%s is not read-only", (word) => {
    expect(refusal(`kubectl ${word} pod web`)).toEqual({ code: "not-read-only", message: notReadOnlySentence(word) });
  });

  test("exec with its own flags and command is refused by the command, before any flag", () => {
    expect(refusal("kubectl exec -it pod/x -- sh")).toEqual({
      code: "not-read-only",
      message: notReadOnlySentence("exec"),
    });
  });

  test("rollout and auth are read by their subcommand", () => {
    expect(refusal("rollout status deploy/web").message).toBe(notInV1CommandSentence("rollout status"));
    expect(refusal("rollout history deploy/web").message).toBe(notInV1CommandSentence("rollout history"));
    expect(refusal("rollout restart deploy/web").message).toBe(notReadOnlySentence("rollout restart"));
    expect(refusal("rollout").message).toBe(notReadOnlySentence("rollout"));
    expect(refusal("auth reconcile -f x").message).toBe(notReadOnlySentence("auth reconcile"));
    expect(refusal("auth login").message).toBe(notInV1CommandSentence("auth with this subcommand"));
    expect(refusal("auth 'Weird Sub'").message).toBe(notInV1CommandSentence("auth with this subcommand"));
  });

  test("a flag and its value before the subcommand of top, auth or rollout are skipped, and never echoed", () => {
    expect(parsed("kubectl top -n kube-system pod")).toEqual({
      command: "top",
      resource: "pod",
      namespace: "kube-system",
      allNamespaces: false,
    });
    expect(parsed("kubectl top -l app=web --sort-by cpu no")).toMatchObject({ resource: "node", sortBy: "cpu" });
    expect(parsed("kubectl top -nshop pods")).toMatchObject({ resource: "pod", namespace: "shop" });
    expect(parsed("kubectl auth -n shop can-i list pods")).toEqual({
      command: "auth-can-i",
      check: { verb: "list", type: "pods" },
      namespace: "shop",
      allNamespaces: false,
    });
    expect(parsed("kubectl auth --subresource=log -n shop can-i get pods")).toMatchObject({ subresource: "log" });
    expect(refusal("kubectl rollout -n acme-corp status deploy/web")).toEqual({
      code: "not-in-v1",
      message: notInV1CommandSentence("rollout status"),
    });
    expect(refusal("kubectl rollout --selector app=web restart")).toEqual({
      code: "not-read-only",
      message: notReadOnlySentence("rollout restart"),
    });
    for (const text of [
      "kubectl top -n customer-acme service",
      "kubectl top customer-acme",
      "kubectl auth -n customer-acme login",
      "kubectl rollout -n customer-acme",
      "kubectl rollout customer-acme",
    ])
      expect(refusal(text).message).not.toContain("customer-acme");
  });

  test.each(["config view", "cluster-info", "wait --for=condition=Ready pod/web", "diff -f x.yaml", "kustomize ."])(
    "%s is not in v1",
    (text) => {
      expect(refusal(text).code).toBe("not-in-v1");
    },
  );

  test("an unknown command is named only when it reads as a name", () => {
    expect(refusal("gett pods").message).toBe(
      '"gett" is not a kubectl command this console runs: it runs get, describe, logs, top pod, top node, events, api-resources, api-versions, explain, auth can-i, auth whoami and version. Nothing was sent.',
    );
    expect(refusal(`'${MARKER}=1' pods`).message).toStartWith("The first word is not a kubectl command");
  });
});

describe("the connection's flags", () => {
  test.each([
    "--kubeconfig",
    "--context",
    "--cluster",
    "--user",
    "--token",
    "--server",
    "-s",
    "--as",
    "--as-group",
    "--as-uid",
    "--as-user-extra",
    "--username",
    "--password",
    "--certificate-authority",
    "--client-certificate",
    "--client-key",
    "--tls-server-name",
    "--cache-dir",
    "--kuberc",
    "-v",
  ])("%s is refused, its value never quoted", (spelling) => {
    expect(refusal(`kubectl get pods ${spelling}=${MARKER}`)).toEqual({
      code: "connection-flag",
      message: connectionFlagSentence(spelling),
    });
  });

  test("--insecure-skip-tls-verify takes no value and is refused the same way, before or after the command", () => {
    expect(refusal("kubectl --insecure-skip-tls-verify get pods").message).toBe(
      connectionFlagSentence("--insecure-skip-tls-verify"),
    );
    expect(refusal(`kubectl --token ${MARKER} get pods`).message).toBe(connectionFlagSentence("--token"));
  });

  test("the six credential flags are the ones history masks", () => {
    expect(CREDENTIAL_FLAGS).toEqual([
      "--token",
      "--password",
      "--client-key",
      "--client-certificate",
      "--from-literal",
      "--docker-password",
    ]);
  });
});

describe("the table, the echo rule and the helpers", () => {
  test("every command of the table, with its usage", () => {
    expect(KUBECTL_COMMAND_TABLE.map((entry) => entry.command)).toEqual([
      "get",
      "describe",
      "logs",
      "top pod",
      "top node",
      "events",
      "api-resources",
      "api-versions",
      "explain",
      "auth can-i",
      "auth whoami",
      "version",
    ]);
    expect(KUBECTL_COMMAND_TABLE[0].flags).toContain("-w|--watch");
    expect(commandSpec("logs").flags.map((spec) => spec.name)).toContain("namespace");
  });

  test("a name is echoed only when it reads as one", () => {
    expect(echoName("--sort-by")).toBe("--sort-by");
    expect(echoName("a=b")).toBeUndefined();
    expect(echoName(`--${"x".repeat(41)}`)).toBeUndefined();
    expect(notInV1FlagSentence("--a=b", "get")).toBe(
      "A flag of kubectl get is not in v1 of this console. Nothing was sent.",
    );
  });

  test("Go durations", () => {
    expect(goDurationMs("1h30m")).toBe(5_400_000);
    expect(goDurationMs("1.5s")).toBe(1_500);
    expect(goDurationMs("250us")).toBe(0.25);
    expect(goDurationMs("100ns")).toBeCloseTo(0.0001);
    expect(goDurationMs("-1s")).toBe(-1_000);
    expect(goDurationMs("0")).toBe(0);
    expect(goDurationMs("5")).toBeUndefined();
  });

  test("only the list form of a get shown as a table or names is pageable", () => {
    expect(isPageable(parsed("get pods"))).toBe(true);
    expect(isPageable(parsed("get pods -o wide -A --show-labels"))).toBe(true);
    expect(isPageable(parsed("get pods -o name"))).toBe(true);
    expect(isPageable(parsed("get pods -o yaml"))).toBe(false);
    expect(isPageable(parsed("get pods -w"))).toBe(false);
    expect(isPageable(parsed("get pod web"))).toBe(false);
    expect(isPageable(parsed("describe pod web"))).toBe(false);
  });
});
