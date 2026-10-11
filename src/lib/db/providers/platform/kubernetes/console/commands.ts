/**
 * The kubectl subset this console runs, as data: each command with its words, its arguments and the flags of its v1
 * column, the commands and flags it refuses, and every refusal sentence.
 *
 * Pure, and shipped to the browser: the parser (`parse.ts`), the confirmation gate's row and the plan-mode sentence
 * of `labels.ts` read the same table, so what the editor refuses, what plan mode is told and what runs cannot drift.
 * A refusal names a command or a flag and never quotes a value the user typed.
 */

/** The longest text a statement may hold, in UTF-8 bytes: the bound the Oxia and Milvus consoles declare. */
export const KUBECTL_MAX_TEXT_BYTES = 65_536;

/** The distinct -L label keys one statement may add as columns: each adds a cell to every row. */
export const KUBECTL_MAX_LABEL_COLUMNS = 16;

/** A flag of a command's v1 column, by its long name. */
export type KubectlFlagName =
  | "namespace"
  | "all-namespaces"
  | "selector"
  | "field-selector"
  | "output"
  | "show-labels"
  | "label-columns"
  | "ignore-not-found"
  | "request-timeout"
  | "watch"
  | "container"
  | "all-containers"
  | "all-pods"
  | "previous"
  | "tail"
  | "since"
  | "since-time"
  | "timestamps"
  | "limit-bytes"
  | "sort-by"
  | "for"
  | "types"
  | "namespaced"
  | "api-group"
  | "verbs"
  | "recursive"
  | "api-version"
  | "subresource"
  | "list";

export interface KubectlFlagSpec {
  readonly name: KubectlFlagName;
  readonly shorthand?: string;
  /** `value` takes one value, `boolean` none (or `=true`/`=false`), `list` a comma list and may repeat. */
  readonly takes: "value" | "boolean" | "list";
}

/** The commands of v1, each one statement kind. */
export type KubectlCommandName =
  | "get"
  | "describe"
  | "logs"
  | "top pod"
  | "top node"
  | "events"
  | "api-resources"
  | "api-versions"
  | "explain"
  | "auth can-i"
  | "auth whoami"
  | "version";

export interface KubectlCommandSpec {
  readonly command: KubectlCommandName;
  /** The arguments as a usage line writes them. */
  readonly arguments: string;
  readonly flags: readonly KubectlFlagSpec[];
}

const flag = (name: KubectlFlagName, takes: KubectlFlagSpec["takes"], shorthand?: string): KubectlFlagSpec =>
  Object.freeze(shorthand === undefined ? { name, takes } : { name, takes, shorthand });

const NAMESPACE = flag("namespace", "value", "n");
const ALL_NAMESPACES = flag("all-namespaces", "boolean", "A");
const SELECTOR = flag("selector", "value", "l");
const OUTPUT = flag("output", "value", "o");

const command = (name: KubectlCommandName, args: string, flags: readonly KubectlFlagSpec[]): KubectlCommandSpec =>
  Object.freeze({ command: name, arguments: args, flags: Object.freeze([...flags]) });

/** Every command of v1 with the flags of its column. */
const KUBECTL_COMMANDS: readonly KubectlCommandSpec[] = Object.freeze([
  command("get", "TYPE [NAME ...] | TYPE/NAME ...", [
    NAMESPACE,
    ALL_NAMESPACES,
    SELECTOR,
    flag("field-selector", "value"),
    OUTPUT,
    flag("show-labels", "boolean"),
    flag("label-columns", "list", "L"),
    flag("ignore-not-found", "boolean"),
    flag("request-timeout", "value"),
    flag("watch", "boolean", "w"),
  ]),
  command("describe", "TYPE NAME | TYPE/NAME", [NAMESPACE]),
  // -n is in the column too: the Logs row action writes it, as every namespaced command takes it.
  command("logs", "POD | TYPE/NAME", [
    NAMESPACE,
    flag("container", "value", "c"),
    flag("all-containers", "boolean"),
    flag("all-pods", "boolean"),
    flag("previous", "boolean", "p"),
    flag("tail", "value"),
    flag("since", "value"),
    flag("since-time", "value"),
    flag("timestamps", "boolean"),
    flag("limit-bytes", "value"),
    SELECTOR,
  ]),
  command("top pod", "", [NAMESPACE, ALL_NAMESPACES, SELECTOR, flag("sort-by", "value")]),
  command("top node", "", [NAMESPACE, ALL_NAMESPACES, SELECTOR, flag("sort-by", "value")]),
  command("events", "", [NAMESPACE, ALL_NAMESPACES, flag("for", "value"), flag("types", "list")]),
  command("api-resources", "", [
    flag("namespaced", "boolean"),
    flag("api-group", "value"),
    flag("verbs", "list"),
    OUTPUT,
  ]),
  command("api-versions", "", []),
  command("explain", "TYPE[.FIELD ...]", [flag("recursive", "boolean"), flag("api-version", "value")]),
  command("auth can-i", "VERB TYPE[/NAME]", [
    NAMESPACE,
    ALL_NAMESPACES,
    flag("subresource", "value"),
    flag("list", "boolean"),
  ]),
  command("auth whoami", "", []),
  command("version", "", []),
]);

/** The words `top` takes for its two resources, as kubectl's aliases spell them. */
export const TOP_RESOURCE_WORDS: Readonly<Record<"top pod" | "top node", readonly string[]>> = Object.freeze({
  "top pod": Object.freeze(["pod", "pods", "po"]),
  "top node": Object.freeze(["node", "nodes", "no"]),
});

/**
 * Commands that write, run code or open a tunnel (kubectl's own grouping): refused as not read-only. `rollout` and
 * `auth` are read by their subcommand: `rollout status` and `rollout history` only read, and `auth reconcile` writes.
 */
export const NOT_READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "create",
  "expose",
  "run",
  "set",
  "edit",
  "delete",
  "scale",
  "autoscale",
  "certificate",
  "cordon",
  "uncordon",
  "drain",
  "taint",
  "apply",
  "patch",
  "replace",
  "label",
  "annotate",
  "debug",
  "exec",
  "attach",
  "cp",
  "port-forward",
  "proxy",
]);

/** Read-only kubectl commands this console does not run: refused as not in v1. */
export const NOT_IN_V1_COMMANDS: ReadonlySet<string> = new Set([
  "config",
  "cluster-info",
  "wait",
  "diff",
  "completion",
  "options",
  "plugin",
  "kustomize",
  "alpha",
  "help",
]);

/** The subcommands of `rollout` that only read. */
export const READ_ONLY_ROLLOUT_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "history"]);

/**
 * kubectl's global flags that choose the cluster, the identity or the client's own files: the connection decides
 * each, so a statement may not. `--v` is the long spelling of `-v`.
 */
export const CONNECTION_FLAGS: ReadonlySet<string> = new Set([
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
  "--insecure-skip-tls-verify",
  "--tls-server-name",
  "--cache-dir",
  "--kuberc",
  "-v",
  "--v",
]);

/**
 * The flags whose values are credentials, the connection's and a Secret-creating command's, all refused: query history
 * keeps none of their values.
 */
export const CREDENTIAL_FLAGS: readonly string[] = Object.freeze([
  "--token",
  "--password",
  "--client-key",
  "--client-certificate",
  "--from-literal",
  "--docker-password",
]);

/** The `-o` formats kubectl has and this console does not, named in their refusal. */
export const NOT_IN_V1_OUTPUT_FORMATS: ReadonlySet<string> = new Set([
  "jsonpath",
  "jsonpath-file",
  "jsonpath-as-json",
  "custom-columns",
  "custom-columns-file",
  "go-template",
  "go-template-file",
  "template",
  "templatefile",
]);

// ============================================================================
// Sentences
// ============================================================================

const NOTHING_SENT = "Nothing was sent.";

/** The commands of v1 as a sentence lists them. */
const V1_COMMANDS_WORDS =
  "get, describe, logs, top pod, top node, events, api-resources, api-versions, explain, auth can-i, auth whoami and version";

/** A word of the text, echoed only when it reads as a command or flag name and at most 40 characters. */
export function echoName(text: string): string | undefined {
  return /^-{0,2}[A-Za-z][A-Za-z0-9-]{0,39}$/.test(text) ? text : undefined;
}

export const KUBECTL_SENTENCES = Object.freeze({
  empty: `The statement holds no kubectl command: write one read, such as kubectl get pods. ${NOTHING_SENT}`,
  noCommand: `The statement holds flags but no command: write one of ${V1_COMMANDS_WORDS}. ${NOTHING_SENT}`,
  follow: "follow is not available in v1; remove -f to read the latest lines, and run again to refresh.",
  oneType: `kubectl get reads one type per statement in v1: name one resource type, and run one statement per type (get all and TYPE,TYPE are not in v1). ${NOTHING_SENT}`,
  typeSpelling: `Write each resource/name argument with the same type spelling, such as pods/web pods/api: kubectl get reads one type per statement in v1. ${NOTHING_SENT}`,
  outputFormat: `The output format given to -o is not in v1 of this console: -o takes wide, name, json or yaml. ${NOTHING_SENT}`,
  watchListOnly: `get -w watches the list form only: remove the names, or drop -w. ${NOTHING_SENT}`,
  watchOutput: `get -w shows the table, or -o wide; -o name, json and yaml with -w are not in v1. ${NOTHING_SENT}`,
  labelColumnsOutput: `--show-labels and -L add table columns, so they do not combine with -o name, json or yaml. ${NOTHING_SENT}`,
  namesAcrossNamespaces: `A resource cannot be read by name across all namespaces: drop -A, or name the namespace with -n. ${NOTHING_SENT}`,
  namesWithSelector: `Names and a selector (-l or --field-selector) do not combine: give one or the other. ${NOTHING_SENT}`,
  getNeedsType: `kubectl get needs a resource type, such as kubectl get pods. ${NOTHING_SENT}`,
  typeNameForm: `Arguments in resource/name form must each have a single resource and name, such as pod/web. ${NOTHING_SENT}`,
  typeNameMixed: `Resource/name arguments and a separate resource type do not combine: write TYPE NAME or TYPE/NAME. ${NOTHING_SENT}`,
  describeOne: `kubectl describe takes exactly one object in v1: describe TYPE NAME or describe TYPE/NAME, with the whole name; a name prefix or a selector is not in v1. ${NOTHING_SENT}`,
  logsTarget: `kubectl logs needs one pod, a TYPE/NAME such as deployment/web, or -l with a selector. ${NOTHING_SENT}`,
  logsSelectorAndName: `kubectl logs takes a pod name or a selector (-l), not both. ${NOTHING_SENT}`,
  logsContainerArgument: `kubectl logs takes the container with -c in v1, such as logs web -c sidecar. ${NOTHING_SENT}`,
  logsContainerAndAll: `-c names one container, so it does not combine with --all-containers. ${NOTHING_SENT}`,
  sinceBoth: `--since and --since-time do not combine, as the API server refuses both: give one. ${NOTHING_SENT}`,
  tail: `--tail takes a number of lines from 1 to 5,000: Studio reads at most 5,000 lines of a log, and kubectl's -1 for every line is not in v1. ${NOTHING_SENT}`,
  limitBytes: `--limit-bytes takes a number of bytes from 1 to 1,048,576 (1 MiB), the most Studio reads of one log. ${NOTHING_SENT}`,
  since: `--since takes a duration of at least one second, such as 30s, 5m or 1h30m. ${NOTHING_SENT}`,
  sinceTime: `--since-time takes an RFC 3339 time, such as 2026-10-10T12:00:00Z. ${NOTHING_SENT}`,
  container: `-c takes a container name: a DNS-1123 label of lower-case letters, digits and hyphens. ${NOTHING_SENT}`,
  namespace: `-n takes a namespace name: a DNS-1123 label of at most 63 lower-case letters, digits and hyphens. ${NOTHING_SENT}`,
  requestTimeout: `--request-timeout takes a positive duration, such as 10s or 1m, or a number of seconds. ${NOTHING_SENT}`,
  watchWindow: `--request-timeout with -w sets the watch window and takes whole seconds, at least 1, such as 5s or 30. ${NOTHING_SENT}`,
  labelColumns: `-L takes label keys, such as app or app.kubernetes.io/name, separated by commas. ${NOTHING_SENT}`,
  labelColumnsCount: `-L takes at most ${KUBECTL_MAX_LABEL_COLUMNS} label keys in one statement. ${NOTHING_SENT}`,
  selector: `A selector flag needs a selector, such as app=web. ${NOTHING_SENT}`,
  topArguments: `kubectl top pod and top node list every object they read in v1: narrow them with -l, not with a name. ${NOTHING_SENT}`,
  topSortBy: `--sort-by takes cpu or memory. ${NOTHING_SENT}`,
  eventsArguments: `kubectl events takes no arguments: name an object with --for TYPE/NAME. ${NOTHING_SENT}`,
  eventsFor: `--for takes one object in resource/name form, such as pod/web. ${NOTHING_SENT}`,
  eventsTypes: `valid --types are Normal or Warning. ${NOTHING_SENT}`,
  noArguments: `This command takes no arguments. ${NOTHING_SENT}`,
  apiGroup: `--api-group takes an API group such as apps, or an empty value for the core group. ${NOTHING_SENT}`,
  verbs: `--verbs takes verbs such as get,list, in lower-case letters. ${NOTHING_SENT}`,
  apiResourcesOutput: `api-resources takes -o wide or -o name in v1. ${NOTHING_SENT}`,
  explainTarget: `kubectl explain takes one resource with an optional field path, such as explain pods.spec.containers. ${NOTHING_SENT}`,
  apiVersion: `--api-version takes a group version such as apps/v1, or v1 for the core group. ${NOTHING_SENT}`,
  canIArguments: `kubectl auth can-i takes a verb and a resource, such as auth can-i list pods or auth can-i get pods/web. ${NOTHING_SENT}`,
  canIList: `auth can-i --list takes no arguments and does not combine with -A or --subresource. ${NOTHING_SENT}`,
  canIVerb: `auth can-i takes a verb of lower-case letters, such as get or list, or *. ${NOTHING_SENT}`,
  nonResourceUrl: `auth can-i on a non-resource URL is not in v1 of this console: ask about a resource. ${NOTHING_SENT}`,
  subresource: `--subresource takes a subresource name such as log or status. ${NOTHING_SENT}`,
});

export function notReadOnlySentence(name: string): string {
  return `kubectl ${name} is refused: it is not read-only, and this console only reads the cluster. ${NOTHING_SENT}`;
}

export function notInV1CommandSentence(name: string): string {
  return `kubectl ${name} is not in v1 of this console, which runs ${V1_COMMANDS_WORDS}. ${NOTHING_SENT}`;
}

export function unknownCommandSentence(word: string): string {
  const named = echoName(word);
  const what = named === undefined ? "The first word" : `"${named}"`;
  return `${what} is not a kubectl command this console runs: it runs ${V1_COMMANDS_WORDS}. ${NOTHING_SENT}`;
}

export function notInV1FlagSentence(spelling: string, name: KubectlCommandName): string {
  const named = echoName(spelling);
  const what = named === undefined ? "A flag" : `The flag ${named}`;
  return `${what} of kubectl ${name} is not in v1 of this console. ${NOTHING_SENT}`;
}

export function connectionFlagSentence(spelling: string): string {
  return `The flag ${spelling} is refused: the connection decides this. ${NOTHING_SENT}`;
}

export function notInV1OutputSentence(format: string): string {
  return `-o ${format} is not in v1 of this console: -o takes wide, name, json or yaml. ${NOTHING_SENT}`;
}

export function tooManyNamesSentence(cap: number): string {
  return `kubectl get reads at most ${cap} objects by name in one statement, one request each: name fewer, or read the list form with -l or --field-selector. ${NOTHING_SENT}`;
}

export function repeatedFlagSentence(spelling: string): string {
  return `The flag ${spelling} is given twice: give it once. ${NOTHING_SENT}`;
}

export function missingValueSentence(spelling: string): string {
  return `The flag ${spelling} needs a value. ${NOTHING_SENT}`;
}

export function booleanValueSentence(spelling: string): string {
  return `The flag ${spelling} takes true or false. ${NOTHING_SENT}`;
}

/** A flag as a usage line prints it: `-n|--namespace`, or `--field-selector` for a flag with no shorthand. */
const usageSpelling = (spec: KubectlFlagSpec): string =>
  spec.shorthand === undefined ? `--${spec.name}` : `-${spec.shorthand}|--${spec.name}`;

/** The table as usage lines, for labels.ts and the provider doc. */
export const KUBECTL_COMMAND_TABLE: ReadonlyArray<{
  readonly command: KubectlCommandName;
  readonly arguments: string;
  readonly flags: readonly string[];
}> = Object.freeze(
  KUBECTL_COMMANDS.map((spec) =>
    Object.freeze({
      command: spec.command,
      arguments: spec.arguments,
      flags: Object.freeze(spec.flags.map(usageSpelling)),
    }),
  ),
);

export function commandSpec(name: KubectlCommandName): KubectlCommandSpec {
  return KUBECTL_COMMANDS.find((spec) => spec.command === name) as KubectlCommandSpec;
}
