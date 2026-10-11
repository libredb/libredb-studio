/**
 * One kubectl statement, as text, to a typed statement or a refusal sentence.
 *
 * Pure, and shipped to the browser: the confirmation gate's row reads the text with this parser, and the provider
 * reads it again on the server before any request, so what the editor refuses and what runs are one parse. The text
 * is read as the shell would pass it to kubectl (`lexer.ts`), and flags as cobra and pflag read them: anywhere among
 * the arguments, `--` ends them, a long flag takes `=value` or the next word, a short flag its attached rest
 * (`-nshop`, `-n=shop`) or the next word, short booleans may share one dash (`-Aw`), and a boolean flag takes no next
 * word but accepts `=true` or `=false`. Studio refuses a flag given twice, where pflag keeps the last, except the
 * list flags (`-L`, `--types`, `--verbs`), which add up as kubectl's do.
 *
 * Every flag or value outside a command's v1 column is refused, naming the flag; no refusal quotes a value. Nothing
 * here knows the cluster: a resource type is resolved through discovery when the statement runs.
 */
import type { ShellWord } from "@/lib/db/console/shell-words";
import {
  booleanValueSentence,
  CONNECTION_FLAGS,
  commandSpec,
  connectionFlagSentence,
  KUBECTL_MAX_LABEL_COLUMNS,
  KUBECTL_MAX_TEXT_BYTES,
  KUBECTL_SENTENCES as S,
  type KubectlCommandName,
  type KubectlFlagName,
  type KubectlFlagSpec,
  missingValueSentence,
  NOT_IN_V1_COMMANDS,
  NOT_IN_V1_OUTPUT_FORMATS,
  NOT_READ_ONLY_COMMANDS,
  notInV1CommandSentence,
  notInV1FlagSentence,
  notInV1OutputSentence,
  notReadOnlySentence,
  READ_ONLY_ROLLOUT_SUBCOMMANDS,
  repeatedFlagSentence,
  TOP_RESOURCE_WORDS,
  tooManyNamesSentence,
  unknownCommandSentence,
} from "./commands";
import {
  KUBERNETES_LOG_LIMIT_BYTES,
  KUBERNETES_LOG_TAIL_MAX,
  KUBERNETES_MAX_DOCUMENT_OBJECTS,
  KUBERNETES_PAGE_SIZE,
} from "../limits";
import { commandWordIndex, isKubectlFlagText, KUBECTL_VALUE_GLOBAL_FLAGS, kubectlWords } from "./lexer";

export type GetOutput = "table" | "wide" | "name" | "json" | "yaml";

export type KubectlStatement =
  | {
      readonly command: "get";
      readonly type: string;
      /** Empty for the list form. */
      readonly names: readonly string[];
      readonly namespace?: string;
      readonly allNamespaces: boolean;
      readonly labelSelector?: string;
      readonly fieldSelector?: string;
      readonly output: GetOutput;
      readonly showLabels: boolean;
      readonly labelColumns: readonly string[];
      readonly ignoreNotFound: boolean;
      /** Seconds; the watch window under -w, else each request's deadline. */
      readonly requestTimeoutSeconds?: number;
      readonly watch: boolean;
    }
  | { readonly command: "describe"; readonly type: string; readonly name: string; readonly namespace?: string }
  | {
      readonly command: "logs";
      /** Absent with -l. `type` is absent for a bare pod name. */
      readonly target?: { readonly type?: string; readonly name: string };
      readonly namespace?: string;
      readonly labelSelector?: string;
      readonly container?: string;
      readonly allContainers: boolean;
      readonly allPods: boolean;
      readonly previous: boolean;
      readonly tail?: number;
      readonly sinceSeconds?: number;
      readonly sinceTime?: string;
      readonly limitBytes?: number;
    }
  | {
      readonly command: "top";
      readonly resource: "pod" | "node";
      readonly namespace?: string;
      readonly allNamespaces: boolean;
      readonly labelSelector?: string;
      readonly sortBy?: "cpu" | "memory";
    }
  | {
      readonly command: "events";
      readonly namespace?: string;
      readonly allNamespaces: boolean;
      readonly forObject?: { readonly type: string; readonly name: string };
      readonly types: readonly ("Normal" | "Warning")[];
    }
  | {
      readonly command: "api-resources";
      readonly namespaced?: boolean;
      /** "" names the core group. */
      readonly apiGroup?: string;
      readonly verbs: readonly string[];
      readonly output: "table" | "wide" | "name";
    }
  | { readonly command: "api-versions" }
  | {
      readonly command: "explain";
      readonly type: string;
      readonly fieldPath: readonly string[];
      readonly recursive: boolean;
      readonly apiVersion?: string;
    }
  | {
      readonly command: "auth-can-i";
      /** Absent with --list. */
      readonly check?: { readonly verb: string; readonly type: string; readonly name?: string };
      readonly namespace?: string;
      readonly allNamespaces: boolean;
      readonly subresource?: string;
    }
  | { readonly command: "auth-whoami" }
  | { readonly command: "version" };

export type KubectlRefusalCode =
  | "shell"
  | "too-large"
  | "empty"
  | "no-command"
  | "unknown-command"
  | "not-read-only"
  | "not-in-v1"
  | "connection-flag"
  | "follow"
  | "one-type"
  | "repeated-flag"
  | "bad-value"
  | "bad-arguments";

export interface KubectlRefusal {
  readonly code: KubectlRefusalCode;
  readonly message: string;
}

export type KubectlParse =
  | { readonly ok: true; readonly statement: KubectlStatement }
  | { readonly ok: false; readonly refusal: KubectlRefusal };

const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS1123_SUBDOMAIN = /^(?=.{1,253}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const VERSION = /^v[0-9]+((alpha|beta)[0-9]+)?$/;
const LABEL_KEY =
  /^((?=[a-z0-9.-]{1,253}\/)[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const RFC3339 = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const DIGITS = /^[0-9]{1,10}$/;
const SIGNED_INTEGER = /^[+-]?[0-9]{1,12}$/;
const FIELD_SEGMENT = /^[A-Za-z0-9_$-]{1,253}$/;
const VERB = /^([a-z]{1,64}|\*)$/;
const SUBRESOURCE = /^[a-z]{1,63}$/;

/** A Go duration (`300ms`, `1h30m`, `-1.5h`) in milliseconds, or undefined when the text is not one. */
export function goDurationMs(text: string): number | undefined {
  const units: Readonly<Record<string, number>> = {
    ns: 1e-6,
    us: 1e-3,
    µs: 1e-3,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };
  const match = /^([+-]?)((?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:ns|us|µs|ms|s|m|h))+$/.exec(text);
  if (match === null) return text === "0" ? 0 : undefined;
  let total = 0;
  for (const part of text.replace(/^[+-]/, "").matchAll(/([0-9]+(?:\.[0-9]*)?|\.[0-9]+)(ns|us|µs|ms|s|m|h)/g)) {
    total += Number(part[1]) * units[part[2]];
  }
  return match[1] === "-" ? -total : total;
}

/** kubectl's --request-timeout: a plain number of seconds, or a Go duration; undefined when it is neither. */
function requestTimeoutSeconds(text: string): number | undefined {
  if (DIGITS.test(text)) return Number(text);
  const ms = goDurationMs(text);
  return ms === undefined ? undefined : ms / 1000;
}

/** The UTF-8 length of a text, counted without encoding it. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

class Refused extends Error {
  constructor(readonly refusal: KubectlRefusal) {
    super(refusal.message);
  }
}

function refuse(code: KubectlRefusalCode, message: string): never {
  throw new Refused({ code, message });
}

// ============================================================================
// The command words
// ============================================================================

const isFlagText = isKubectlFlagText;

/** The flags whose value may stand before the subcommand of `top`, `auth` or `rollout`: the global ones and theirs. */
const SUBCOMMAND_VALUE_FLAGS: ReadonlySet<string> = new Set([
  ...KUBECTL_VALUE_GLOBAL_FLAGS,
  "-l",
  "--selector",
  "--sort-by",
  "--subresource",
]);

/** The subcommand words a refusal may name; any other word is never echoed, as it may be a value. */
const KNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "can-i",
  "whoami",
  "reconcile",
  "status",
  "history",
  "restart",
  "undo",
  "pause",
  "resume",
  ...TOP_RESOURCE_WORDS["top pod"],
  ...TOP_RESOURCE_WORDS["top node"],
]);

/** The subcommand's word after the command at `at`: flags and the values they take are skipped. */
function subcommandIndex(words: readonly ShellWord[], at: number): number | undefined {
  const offset = commandWordIndex(
    words.slice(at + 1).map((word) => word.text),
    SUBCOMMAND_VALUE_FLAGS,
  );
  return offset === undefined ? undefined : at + 1 + offset;
}

/** The command a statement names and the indices of its words, or a refusal of the command itself. */
function classify(words: readonly ShellWord[]): { readonly name: KubectlCommandName; readonly at: readonly number[] } {
  const at = commandWordIndex(words.map((word) => word.text));
  if (at === undefined) refuse("no-command", S.noCommand);
  const word = words[at].text;
  const sub = subcommandIndex(words, at);
  const subText = sub === undefined ? undefined : words[sub].text;
  const subName = subText === undefined ? "" : ` ${KNOWN_SUBCOMMANDS.has(subText) ? subText : "with this subcommand"}`;
  if (NOT_READ_ONLY_COMMANDS.has(word)) refuse("not-read-only", notReadOnlySentence(word));
  if (word === "rollout") {
    if (subText !== undefined && READ_ONLY_ROLLOUT_SUBCOMMANDS.has(subText))
      refuse("not-in-v1", notInV1CommandSentence(`rollout ${subText}`));
    refuse("not-read-only", notReadOnlySentence(`rollout${subName}`));
  }
  if (word === "auth") {
    if (subText === "can-i") return { name: "auth can-i", at: [at, sub as number] };
    if (subText === "whoami") return { name: "auth whoami", at: [at, sub as number] };
    if (subText === "reconcile") refuse("not-read-only", notReadOnlySentence("auth reconcile"));
    refuse("not-in-v1", notInV1CommandSentence(`auth${subName}`));
  }
  if (word === "top") {
    for (const name of ["top pod", "top node"] as const) {
      if (subText !== undefined && TOP_RESOURCE_WORDS[name].includes(subText)) return { name, at: [at, sub as number] };
    }
    refuse("not-in-v1", notInV1CommandSentence(`top${subName}`));
  }
  if (NOT_IN_V1_COMMANDS.has(word)) refuse("not-in-v1", notInV1CommandSentence(word));
  const v1: readonly KubectlCommandName[] = [
    "get",
    "describe",
    "logs",
    "events",
    "api-resources",
    "api-versions",
    "explain",
    "version",
  ];
  const name = v1.find((candidate) => candidate === word);
  if (name === undefined) refuse("unknown-command", unknownCommandSentence(word));
  return { name, at: [at] };
}

// ============================================================================
// Flags
// ============================================================================

type FlagValue = string | true | false | readonly string[];

interface Scanned {
  readonly flags: ReadonlyMap<KubectlFlagName, FlagValue>;
  readonly positionals: readonly string[];
}

/** Takes one flag's value into `flags`, refusing a scalar given twice; list flags add up, comma-separated. */
function store(
  flags: Map<KubectlFlagName, FlagValue>,
  spec: KubectlFlagSpec,
  spelling: string,
  value: string | boolean,
): void {
  if (spec.takes === "list") {
    const before = (flags.get(spec.name) as readonly string[] | undefined) ?? [];
    flags.set(spec.name, [...before, ...String(value).split(",")]);
    return;
  }
  if (flags.has(spec.name)) refuse("repeated-flag", repeatedFlagSentence(spelling));
  flags.set(spec.name, value);
}

function booleanOf(spelling: string, inline: string | undefined): boolean {
  if (inline === undefined || inline === "true") return true;
  if (inline === "false") return false;
  refuse("bad-value", booleanValueSentence(spelling));
}

/** A flag the command's column does not hold: the connection's, follow on logs, or not in v1. */
function refuseFlag(spelling: string, name: KubectlCommandName): never {
  if (CONNECTION_FLAGS.has(spelling)) refuse("connection-flag", connectionFlagSentence(spelling));
  if (name === "logs" && (spelling === "-f" || spelling === "--follow")) refuse("follow", S.follow);
  if (name === "describe" && (spelling === "-l" || spelling === "--selector")) refuse("not-in-v1", S.describeOne);
  refuse("not-in-v1", notInV1FlagSentence(spelling, name));
}

function scanFlags(words: readonly ShellWord[], skip: readonly number[], name: KubectlCommandName): Scanned {
  const specs = commandSpec(name).flags;
  const flags = new Map<KubectlFlagName, FlagValue>();
  const positionals: string[] = [];
  let ended = false;
  for (let index = 0; index < words.length; index++) {
    if (skip.includes(index)) continue;
    const text = words[index].text;
    if (ended || !isFlagText(text)) {
      positionals.push(text);
      continue;
    }
    if (text === "--") {
      ended = true;
      continue;
    }
    const takeNext = (spelling: string): string => {
      const next = index + 1;
      if (next >= words.length || skip.includes(next)) refuse("bad-value", missingValueSentence(spelling));
      index = next;
      return words[next].text;
    };
    if (text.startsWith("--")) {
      const equals = text.indexOf("=");
      const spelling = equals === -1 ? text : text.slice(0, equals);
      const inline = equals === -1 ? undefined : text.slice(equals + 1);
      const spec = specs.find((entry) => `--${entry.name}` === spelling);
      if (spec === undefined) refuseFlag(spelling, name);
      if (spec.takes === "boolean") store(flags, spec, spelling, booleanOf(spelling, inline));
      else store(flags, spec, spelling, inline ?? takeNext(spelling));
      continue;
    }
    // A group of shorthands: booleans set in turn, and a value-taking one takes the rest of the word or the next word.
    for (let at = 1; at < text.length; at++) {
      const spelling = `-${text[at]}`;
      const spec = specs.find((entry) => entry.shorthand === text[at]);
      if (spec === undefined) refuseFlag(spelling, name);
      const rest = text.slice(at + 1);
      if (spec.takes === "boolean") {
        if (rest.startsWith("=")) {
          store(flags, spec, spelling, booleanOf(spelling, rest.slice(1)));
          break;
        }
        store(flags, spec, spelling, true);
        continue;
      }
      if (rest !== "") store(flags, spec, spelling, rest.startsWith("=") ? rest.slice(1) : rest);
      else store(flags, spec, spelling, takeNext(spelling));
      break;
    }
  }
  return { flags, positionals };
}

// ============================================================================
// Values
// ============================================================================

class Flags {
  constructor(private readonly scanned: Scanned) {}

  bool(name: KubectlFlagName): boolean {
    return this.scanned.flags.get(name) === true;
  }

  text(name: KubectlFlagName): string | undefined {
    const value = this.scanned.flags.get(name);
    return typeof value === "string" ? value : undefined;
  }

  list(name: KubectlFlagName): readonly string[] {
    return (this.scanned.flags.get(name) as readonly string[] | undefined) ?? [];
  }

  has(name: KubectlFlagName): boolean {
    return this.scanned.flags.has(name);
  }

  namespace(): string | undefined {
    const value = this.text("namespace");
    if (value !== undefined && !DNS1123_LABEL.test(value)) refuse("bad-value", S.namespace);
    return value;
  }

  selector(name: "selector" | "field-selector"): string | undefined {
    const value = this.text(name);
    if (value !== undefined && value.trim() === "") refuse("bad-value", S.selector);
    return value;
  }
}

const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

/** `TYPE/NAME` split, or undefined when the text holds no slash. */
function typeName(text: string): { readonly type: string; readonly name: string } | undefined {
  const slash = text.indexOf("/");
  if (slash === -1) return undefined;
  const type = text.slice(0, slash);
  const name = text.slice(slash + 1);
  if (type === "" || name === "" || name.includes("/")) refuse("bad-arguments", S.typeNameForm);
  return { type, name };
}

/** A type a statement may name: one type, never `all` or a comma list. */
function oneType(type: string): string {
  if (type.includes(",") || type.toLowerCase() === "all") refuse("one-type", S.oneType);
  return type;
}

// ============================================================================
// Each command
// ============================================================================

function parseGet(scanned: Scanned): KubectlStatement {
  const flags = new Flags(scanned);
  const [first, ...rest] = scanned.positionals;
  if (first === undefined) refuse("bad-arguments", S.getNeedsType);
  let type: string;
  let names: string[];
  const split = typeName(first);
  if (split !== undefined) {
    const others = rest.map((word) => typeName(word));
    if (others.some((entry) => entry === undefined)) refuse("bad-arguments", S.typeNameMixed);
    // Two spellings may name one resource (po and pods), which only discovery tells, so the spelling is compared.
    if (others.some((entry) => entry?.type !== split.type)) refuse("one-type", S.typeSpelling);
    type = oneType(split.type);
    names = [split.name, ...others.map((entry) => (entry as { readonly name: string }).name)];
  } else {
    type = oneType(first);
    if (rest.some((word) => word.includes("/"))) refuse("bad-arguments", S.typeNameMixed);
    names = rest;
  }
  const outputText = flags.text("output");
  let output: GetOutput = "table";
  if (outputText !== undefined) {
    const format = outputText.split("=")[0];
    if (NOT_IN_V1_OUTPUT_FORMATS.has(format)) refuse("not-in-v1", notInV1OutputSentence(format));
    if (outputText !== "wide" && outputText !== "name" && outputText !== "json" && outputText !== "yaml")
      refuse("not-in-v1", S.outputFormat);
    output = outputText;
  }
  // The named form sends one request per name, so its names are bounded before anything is sent: the objects -o json
  // and -o yaml show, else one page of the list form.
  const namesCap = output === "json" || output === "yaml" ? KUBERNETES_MAX_DOCUMENT_OBJECTS : KUBERNETES_PAGE_SIZE;
  if (names.length > namesCap) refuse("bad-arguments", tooManyNamesSentence(namesCap));
  // Repeats add no column, as kubectl's do not; past the bound each row would carry too many cells.
  const labelColumns = [...new Set(flags.list("label-columns").filter((key) => key !== ""))];
  if (labelColumns.some((key) => !LABEL_KEY.test(key))) refuse("bad-value", S.labelColumns);
  if (labelColumns.length > KUBECTL_MAX_LABEL_COLUMNS) refuse("bad-value", S.labelColumnsCount);
  const showLabels = flags.bool("show-labels");
  if ((showLabels || labelColumns.length > 0) && (output === "name" || output === "json" || output === "yaml"))
    refuse("bad-arguments", S.labelColumnsOutput);
  const watch = flags.bool("watch");
  if (watch && names.length > 0) refuse("bad-arguments", S.watchListOnly);
  if (watch && output !== "table" && output !== "wide") refuse("not-in-v1", S.watchOutput);
  const allNamespaces = flags.bool("all-namespaces");
  if (allNamespaces && names.length > 0) refuse("bad-arguments", S.namesAcrossNamespaces);
  const labelSelector = flags.selector("selector");
  const fieldSelector = flags.selector("field-selector");
  if (names.length > 0 && (labelSelector !== undefined || fieldSelector !== undefined))
    refuse("bad-arguments", S.namesWithSelector);
  const timeoutText = flags.text("request-timeout");
  const timeout = timeoutText === undefined ? undefined : requestTimeoutSeconds(timeoutText);
  if (timeoutText !== undefined && (timeout === undefined || timeout <= 0)) refuse("bad-value", S.requestTimeout);
  // The window is sent as the watch's timeoutSeconds, which the API server reads as whole seconds.
  if (watch && timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1)) refuse("bad-value", S.watchWindow);
  return {
    command: "get",
    type,
    names,
    ...optional("namespace", flags.namespace()),
    allNamespaces,
    ...optional("labelSelector", labelSelector),
    ...optional("fieldSelector", fieldSelector),
    output,
    showLabels,
    labelColumns,
    ignoreNotFound: flags.bool("ignore-not-found"),
    ...optional("requestTimeoutSeconds", timeout),
    watch,
  };
}

function parseDescribe(scanned: Scanned): KubectlStatement {
  const flags = new Flags(scanned);
  const { positionals } = scanned;
  let target: { readonly type: string; readonly name: string } | undefined;
  if (positionals.length === 1) target = typeName(positionals[0]);
  else if (positionals.length === 2 && !positionals[0].includes("/") && !positionals[1].includes("/"))
    target = { type: positionals[0], name: positionals[1] };
  if (target === undefined) refuse("bad-arguments", S.describeOne);
  return {
    command: "describe",
    type: oneType(target.type),
    name: target.name,
    ...optional("namespace", flags.namespace()),
  };
}

function parseLogs(scanned: Scanned): KubectlStatement {
  const flags = new Flags(scanned);
  const { positionals } = scanned;
  const labelSelector = flags.selector("selector");
  if (positionals.length > 1) refuse("bad-arguments", S.logsContainerArgument);
  if (positionals.length === 1 && labelSelector !== undefined) refuse("bad-arguments", S.logsSelectorAndName);
  if (positionals.length === 0 && labelSelector === undefined) refuse("bad-arguments", S.logsTarget);
  let target: { readonly type?: string; readonly name: string } | undefined;
  if (positionals.length === 1) {
    const split = typeName(positionals[0]);
    target = split === undefined ? { name: positionals[0] } : { type: oneType(split.type), name: split.name };
  }
  const container = flags.text("container");
  if (container !== undefined && !DNS1123_LABEL.test(container)) refuse("bad-value", S.container);
  const allContainers = flags.bool("all-containers");
  if (container !== undefined && allContainers) refuse("bad-arguments", S.logsContainerAndAll);
  const tailText = flags.text("tail");
  if (
    tailText !== undefined &&
    (!SIGNED_INTEGER.test(tailText) || Number(tailText) < 1 || Number(tailText) > KUBERNETES_LOG_TAIL_MAX)
  )
    refuse("bad-value", S.tail);
  const limitText = flags.text("limit-bytes");
  if (
    limitText !== undefined &&
    (!SIGNED_INTEGER.test(limitText) || Number(limitText) < 1 || Number(limitText) > KUBERNETES_LOG_LIMIT_BYTES)
  )
    refuse("bad-value", S.limitBytes);
  const sinceText = flags.text("since");
  const sinceTime = flags.text("since-time");
  if (sinceText !== undefined && sinceTime !== undefined) refuse("bad-arguments", S.sinceBoth);
  let sinceSeconds: number | undefined;
  if (sinceText !== undefined) {
    const ms = goDurationMs(sinceText);
    // kubectl rounds the duration to whole seconds before it sends it.
    sinceSeconds = ms === undefined ? undefined : Math.round(ms / 1000);
    if (sinceSeconds === undefined || sinceSeconds < 1) refuse("bad-value", S.since);
  }
  if (sinceTime !== undefined && !RFC3339.test(sinceTime)) refuse("bad-value", S.sinceTime);
  return {
    command: "logs",
    ...optional("target", target),
    ...optional("namespace", flags.namespace()),
    ...optional("labelSelector", labelSelector),
    ...optional("container", container),
    allContainers,
    allPods: flags.bool("all-pods"),
    previous: flags.bool("previous"),
    ...optional("tail", tailText === undefined ? undefined : Number(tailText)),
    ...optional("sinceSeconds", sinceSeconds),
    ...optional("sinceTime", sinceTime),
    ...optional("limitBytes", limitText === undefined ? undefined : Number(limitText)),
  };
}

function parseTop(scanned: Scanned, resource: "pod" | "node"): KubectlStatement {
  const flags = new Flags(scanned);
  if (scanned.positionals.length > 0) refuse("bad-arguments", S.topArguments);
  const sortText = flags.text("sort-by");
  const sortBy = sortText === "cpu" || sortText === "memory" ? sortText : undefined;
  if (sortText !== undefined && sortBy === undefined) refuse("bad-value", S.topSortBy);
  return {
    command: "top",
    resource,
    ...optional("namespace", flags.namespace()),
    allNamespaces: flags.bool("all-namespaces"),
    ...optional("labelSelector", flags.selector("selector")),
    ...(sortBy === undefined ? {} : { sortBy }),
  };
}

function parseEvents(scanned: Scanned): KubectlStatement {
  const flags = new Flags(scanned);
  if (scanned.positionals.length > 0) refuse("bad-arguments", S.eventsArguments);
  const forText = flags.text("for");
  let forObject: { readonly type: string; readonly name: string } | undefined;
  if (forText !== undefined) {
    const slash = forText.indexOf("/");
    const type = forText.slice(0, slash);
    const name = forText.slice(slash + 1);
    if (slash < 1 || name === "" || name.includes("/")) refuse("bad-value", S.eventsFor);
    forObject = { type: oneType(type), name };
  }
  const types = flags.list("types").map((entry) => {
    const lower = entry.toLowerCase();
    if (lower === "normal") return "Normal" as const;
    if (lower === "warning") return "Warning" as const;
    refuse("bad-value", S.eventsTypes);
  });
  return {
    command: "events",
    ...optional("namespace", flags.namespace()),
    allNamespaces: flags.bool("all-namespaces"),
    ...optional("forObject", forObject),
    types: [...new Set(types)],
  };
}

function parseApiResources(scanned: Scanned): KubectlStatement {
  const flags = new Flags(scanned);
  if (scanned.positionals.length > 0) refuse("bad-arguments", S.noArguments);
  const apiGroup = flags.text("api-group");
  if (apiGroup !== undefined && apiGroup !== "" && !DNS1123_SUBDOMAIN.test(apiGroup)) refuse("bad-value", S.apiGroup);
  const verbs = flags.list("verbs").filter((verb) => verb !== "");
  if (verbs.some((verb) => !/^[a-z]{1,32}$/.test(verb))) refuse("bad-value", S.verbs);
  const output = flags.text("output");
  if (output !== undefined && output !== "wide" && output !== "name") refuse("not-in-v1", S.apiResourcesOutput);
  return {
    command: "api-resources",
    ...optional("namespaced", flags.has("namespaced") ? flags.bool("namespaced") : undefined),
    ...optional("apiGroup", apiGroup),
    verbs,
    output: output ?? "table",
  };
}

function parseExplain(scanned: Scanned): KubectlStatement {
  const flags = new Flags(scanned);
  if (scanned.positionals.length !== 1) refuse("bad-arguments", S.explainTarget);
  const [type, ...fieldPath] = scanned.positionals[0].split(".");
  if (type === "" || fieldPath.some((segment) => !FIELD_SEGMENT.test(segment)))
    refuse("bad-arguments", S.explainTarget);
  const apiVersion = flags.text("api-version");
  if (apiVersion !== undefined) {
    const slash = apiVersion.indexOf("/");
    const group = slash === -1 ? "" : apiVersion.slice(0, slash);
    const version = slash === -1 ? apiVersion : apiVersion.slice(slash + 1);
    if ((slash !== -1 && !DNS1123_SUBDOMAIN.test(group)) || !VERSION.test(version)) refuse("bad-value", S.apiVersion);
  }
  return {
    command: "explain",
    type: oneType(type),
    fieldPath,
    recursive: flags.bool("recursive"),
    ...optional("apiVersion", apiVersion),
  };
}

function parseCanI(scanned: Scanned): KubectlStatement {
  const flags = new Flags(scanned);
  const list = flags.bool("list");
  const allNamespaces = flags.bool("all-namespaces");
  const subresource = flags.text("subresource");
  if (subresource !== undefined && !SUBRESOURCE.test(subresource)) refuse("bad-value", S.subresource);
  const namespace = flags.namespace();
  if (list) {
    if (scanned.positionals.length > 0 || allNamespaces || subresource !== undefined)
      refuse("bad-arguments", S.canIList);
    return { command: "auth-can-i", ...optional("namespace", namespace), allNamespaces: false };
  }
  if (scanned.positionals.length !== 2) refuse("bad-arguments", S.canIArguments);
  const [verb, resource] = scanned.positionals;
  if (!VERB.test(verb)) refuse("bad-value", S.canIVerb);
  if (resource.startsWith("/")) refuse("not-in-v1", S.nonResourceUrl);
  const slash = resource.indexOf("/");
  const type = slash === -1 ? resource : resource.slice(0, slash);
  const name = slash === -1 ? undefined : resource.slice(slash + 1);
  if (type === "" || name === "") refuse("bad-arguments", S.canIArguments);
  return {
    command: "auth-can-i",
    check: { verb, type: type === "*" ? type : oneType(type), ...optional("name", name) },
    ...optional("namespace", namespace),
    allNamespaces,
    ...optional("subresource", subresource),
  };
}

function noArguments(scanned: Scanned, statement: KubectlStatement): KubectlStatement {
  if (scanned.positionals.length > 0) refuse("bad-arguments", S.noArguments);
  return statement;
}

/** One kubectl statement: the typed statement, or the sentence it is refused with before anything is sent. */
export function parseKubectl(text: string): KubectlParse {
  if (utf8Bytes(text) > KUBECTL_MAX_TEXT_BYTES)
    return {
      ok: false,
      refusal: {
        code: "too-large",
        message: `The statement is longer than ${KUBECTL_MAX_TEXT_BYTES} bytes, the most this console reads. Nothing was sent.`,
      },
    };
  const read = kubectlWords(text);
  if (!read.ok) return { ok: false, refusal: { code: "shell", message: read.refusal.message } };
  if (read.words.length === 0) return { ok: false, refusal: { code: "empty", message: S.empty } };
  try {
    const { name, at } = classify(read.words);
    const scanned = scanFlags(read.words, at, name);
    switch (name) {
      case "get":
        return { ok: true, statement: parseGet(scanned) };
      case "describe":
        return { ok: true, statement: parseDescribe(scanned) };
      case "logs":
        return { ok: true, statement: parseLogs(scanned) };
      case "top pod":
        return { ok: true, statement: parseTop(scanned, "pod") };
      case "top node":
        return { ok: true, statement: parseTop(scanned, "node") };
      case "events":
        return { ok: true, statement: parseEvents(scanned) };
      case "api-resources":
        return { ok: true, statement: parseApiResources(scanned) };
      case "api-versions":
        return { ok: true, statement: noArguments(scanned, { command: "api-versions" }) };
      case "explain":
        return { ok: true, statement: parseExplain(scanned) };
      case "auth can-i":
        return { ok: true, statement: parseCanI(scanned) };
      case "auth whoami":
        return { ok: true, statement: noArguments(scanned, { command: "auth-whoami" }) };
      case "version":
        return { ok: true, statement: noArguments(scanned, { command: "version" }) };
    }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal };
    throw error;
  }
}

/** Whether the grid may page this statement: the list form of a single-type get, shown as a table or as names. */
export function isPageable(statement: KubectlStatement): boolean {
  return (
    statement.command === "get" &&
    statement.names.length === 0 &&
    !statement.watch &&
    (statement.output === "table" || statement.output === "wide" || statement.output === "name")
  );
}
