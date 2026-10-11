/**
 * Reads a pasted kubeconfig, in the browser, into one connection entry per context: the connection dialog's import for
 * Kubernetes (`connectionImport` on its `DB_UI_CONFIG` entry), loaded only when the import opens.
 *
 * Pure and browser-safe: it imports the `yaml` parser, the import's types and the paste cap, and nothing that reaches a
 * provider's server code or a `node:` module. It sends nothing, logs nothing and stores nothing, and it never throws.
 *
 * The text is read as data, never as a program: aliases, merge keys, an explicit `%YAML` directive, a `%TAG`
 * directive and every tag outside the standard `!!` set are refused, a duplicate key fails the parse, and values are
 * read through the Document API at the paths a kubeconfig defines, each one checked to be text. A parser error's
 * message can quote the text and so a token in it, so only its code and position are read, and no reference to it is
 * kept.
 *
 * What a context fills: the cluster's server split into host, port and API path, the TLS mode its scheme, CA and
 * `insecure-skip-tls-verify` call for, the TLS server name, the user's bearer token or client certificate pair, and
 * the context's namespace. A user that signs in through a credential plugin (`exec`, `auth-provider`) is imported
 * without a credential, a context that yields no credential at all is told its requests would go out anonymous, and
 * every setting Studio does not take (a file path, a proxy, an impersonation, a basic-auth
 * pair) is named in the context's notice. No sentence quotes a value of the text: a refused context is named by its
 * place in the list.
 */
import { type Document, isAlias, isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, type YAMLMap } from "yaml";
import type { ConnectionImportResult, ImportedContext, ImportedField, ImportedSsl } from "@/lib/connection-import";
import {
  KUBERNETES_KUBECONFIG_MAX_BYTES,
  KUBERNETES_KUBECONFIG_MAX_DEPTH,
} from "@/lib/db/providers/platform/kubernetes/limits";

/** Every fixed sentence of the import, so the dialog's tests and the provider doc can be held to the same words. */
export const KUBECONFIG_IMPORT_SENTENCES = Object.freeze({
  notText: "The import reads text: paste the contents of the kubeconfig file.",
  tooLarge:
    "The pasted kubeconfig is larger than 1 MiB, the most Studio reads: paste the part that holds your cluster.",
  tooDeep:
    "The pasted kubeconfig nests deeper than 100 levels, the most Studio reads: a kubeconfig kubectl writes nests fewer than 20.",
  notAConfig: "The text is not a kubeconfig: its top level is not a mapping of clusters, users and contexts.",
  directive:
    "The kubeconfig starts with a %YAML directive, which Studio does not read: remove the directive line and paste it again.",
  tag: "The kubeconfig uses a %TAG directive or a tag outside the standard !! tags, which Studio does not read: remove the tag and paste it again.",
  alias:
    "The kubeconfig uses a YAML alias (*name), which Studio does not read: write each value out where it is used and paste it again.",
  mergeKey:
    "The kubeconfig uses a YAML merge key (<<), which Studio does not read: write each value out where it is used and paste it again.",
  noContexts: "The kubeconfig lists no contexts, so there is nothing to import.",
  noCurrentContext: "The kubeconfig names no current-context: choose one of the contexts below.",
  unknownCurrentContext:
    "The kubeconfig's current-context names no context it lists: choose one of the contexts below.",
  credentialPlugin:
    "This context's user signs in through a credential plugin (exec or auth-provider), which Studio does not run, so the Token is empty. Create a ServiceAccount token bound to the view or studio-reader ClusterRole and paste it under Token, as docs/providers/kubernetes.md shows; on your own machine, kubectl proxy is another way in.",
  noCredential:
    "This context gives no token and no client certificate and key that Studio imports, so its requests would reach the API server as an anonymous user, which most clusters refuse. Create a ServiceAccount token bound to the view or studio-reader ClusterRole and paste it under Token, as the ServiceAccount token section of docs/providers/kubernetes.md shows.",
  insecure:
    "This context sets insecure-skip-tls-verify, so SSL mode is require, which a Studio server refuses unless its operator sets KUBERNETES_ALLOW_INSECURE_TLS=true. Add the cluster's CA under SSL / TLS and choose verify-full instead.",
  plaintext:
    "This context's server is plain http, so SSL mode is disable, which Studio accepts only for an address on this machine, such as kubectl proxy, and only when its operator sets KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT=true.",
});

/** Why one context was not imported; each completes "Context N was not imported: ". */
export const KUBECONFIG_CONTEXT_REFUSALS = Object.freeze({
  shape: "it is not a mapping with a name and a context.",
  name: "its name is missing or is not text.",
  clusterMissing: "it names a cluster the kubeconfig does not list.",
  clusterRepeated: "it names a cluster the kubeconfig lists twice.",
  userMissing: "it names a user the kubeconfig does not list.",
  userRepeated: "it names a user the kubeconfig lists twice.",
  noServer: "its cluster has no server.",
  scheme: "its server is not an https:// or http:// address.",
  userinfo: "its server carries a user name or a password, which Studio does not take.",
  queryOrFragment: "its server carries a query or a fragment, which Studio does not take.",
  host: "its server names no valid host and port.",
  serverPath: "its server's path is not a plain path such as /k8s/clusters/c-1.",
  clientPair: "its user gives a client certificate without its key, or a key without its certificate.",
  namespace: "its namespace is not a DNS-1123 label of at most 63 lower-case letters, digits or hyphens.",
  insecureFlag: "its insecure-skip-tls-verify is not true or false.",
});

/** The sentence for a context's field that is not text where text is required; `field` is a kubeconfig key. */
export function notTextRefusal(field: string): string {
  return `its ${field} is not text.`;
}

/** The sentence for a `*-data` field that is not base64 of PEM text; `field` is a kubeconfig key. */
export function notPemRefusal(field: string): string {
  return `its ${field} is not base64 of PEM text.`;
}

/** The notice naming the settings of one context that were not imported, in the kubeconfig's own key names. */
export function notImportedNotice(fields: readonly string[]): string {
  return `Not imported: ${fields.join(", ")}. Studio reads no local file, runs no credential plugin, sends no request through a proxy, impersonates no one and takes no user name and password.`;
}

/**
 * The notice naming the TLS settings of one context that its SSL mode leaves unused, in the kubeconfig's own key names:
 * a plain http server takes neither a CA nor a client pair, and `insecure-skip-tls-verify` checks no CA.
 */
export function unusedTlsNotice(fields: readonly string[], mode: "disable" | "require"): string {
  return mode === "disable"
    ? `Not imported: ${fields.join(", ")}. The server is plain http, so Studio sends no client certificate and checks no CA.`
    : `Not imported: ${fields.join(", ")}. insecure-skip-tls-verify is true, so SSL mode require checks no CA: paste the CA under SSL / TLS with verify-full to use it.`;
}

/** A parse failure as "<code> at line L, column C", never the parser's own message. */
export function parseFailureSentence(code: string, line: number, column: number): string {
  return `The kubeconfig could not be read: ${code} at line ${line}, column ${column}.`;
}

/** Cluster keys Studio does not take; `disable-compression` and `extensions` are ignored without a notice. */
const REFUSED_CLUSTER_FIELDS = ["certificate-authority", "proxy-url"] as const;
/** The user keys a kubeconfig may set that Studio does not take. */
const REFUSED_USER_FIELDS = [
  "exec",
  "auth-provider",
  "client-certificate",
  "client-key",
  "tokenFile",
  "token-file",
  "username",
  "password",
  "as",
  "as-uid",
  "as-groups",
  "as-user-extra",
] as const;

/** A namespace name: what `database` takes for this type. */
const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** Standard base64, as a kubeconfig's `*-data` fields hold it once line breaks are taken out. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** The YAML core schema's own tags, which the `!!` handle names. */
const STANDARD_TAG_PREFIX = "tag:yaml.org,2002:";
const SERVER_SCHEME = /^(https?):\/\//i;
/** What a URL parser would drop, decode or read as a separator, so a server holding one is refused, never rewritten. */
const SERVER_REWRITTEN = /[\\\s\u0000-\u001f\u007f]/;

/** A refusal of the whole text, or the document to read. */
type Checked = { readonly refusal: string } | { readonly root: YAMLMap };

/** What one walk of the parsed nodes found: the first duplicate key, and the first alias or merge key. */
interface NodeFindings {
  readonly duplicate?: string;
  readonly aliasOrMerge?: string;
}

/**
 * One walk of the parsed nodes, in document order, with an explicit stack, so its cost is linear in the nodes at any
 * depth (the yaml package's `visit` copies its ancestor path at every level). A duplicate key is told as the parser's
 * `uniqueKeys` tells it: scalar keys by `===` on their values (so `1` and `"1"` differ, and NaN never repeats), other
 * keys never. An alias and a `<<` merge key are refused as the first of them met.
 */
function walkNodes(document: Document.Parsed, lineCounter: LineCounter): NodeFindings {
  let aliasOrMerge: string | undefined;
  const stack: unknown[] = [document.contents];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isAlias(node)) {
      aliasOrMerge ??= KUBECONFIG_IMPORT_SENTENCES.alias;
    } else if (isMap(node)) {
      const seen = new Set<unknown>();
      for (const pair of node.items) {
        if (!isScalar(pair.key) || Number.isNaN(pair.key.value)) continue;
        if (seen.has(pair.key.value)) {
          const position = lineCounter.linePos(pair.key.range?.[0] ?? 0);
          return { duplicate: parseFailureSentence("DUPLICATE_KEY", position.line, position.col) };
        }
        seen.add(pair.key.value);
      }
      for (let at = node.items.length - 1; at >= 0; at -= 1) stack.push(node.items[at]);
    } else if (isPair(node)) {
      if (isScalar(node.key) && node.key.value === "<<") aliasOrMerge ??= KUBECONFIG_IMPORT_SENTENCES.mergeKey;
      stack.push(node.value, node.key);
    } else if (isSeq(node)) {
      for (let at = node.items.length - 1; at >= 0; at -= 1) stack.push(node.items[at]);
    }
  }
  return aliasOrMerge === undefined ? {} : { aliasOrMerge };
}

/**
 * Whether the text nests deeper than the cap, in one pass and before the parser, which recurses once per level.
 * A line's depth is its indentation in spaces, plus the run of `-`, `?` and `:` indicators that opens it, plus the
 * flow brackets still open. That never undercounts: a bracket inside a quoted value or after a `#` counts as well,
 * and only a line that is all comment is skipped.
 */
function nestsTooDeep(text: string): boolean {
  let flow = 0;
  for (const line of text.split("\n")) {
    let at = 0;
    while (line[at] === " ") at += 1;
    if (line[at] === "#") continue;
    let depth = at;
    while ((line[at] === "-" || line[at] === "?" || line[at] === ":") && (line[at + 1] ?? " ").trim() === "") {
      depth += 1;
      at += 1;
      while (line[at] === " ") at += 1;
    }
    if (depth + flow > KUBERNETES_KUBECONFIG_MAX_DEPTH) return true;
    for (; at < line.length; at += 1) {
      const char = line[at];
      if (char === "[" || char === "{") {
        flow += 1;
        if (depth + flow > KUBERNETES_KUBECONFIG_MAX_DEPTH) return true;
      } else if ((char === "]" || char === "}") && flow > 0) flow -= 1;
    }
  }
  return false;
}

/** The document's top level, after every rule of the text as a whole: size, parse, directive, tags, aliases. */
function checkText(text: unknown): Checked {
  if (typeof text !== "string") return { refusal: KUBECONFIG_IMPORT_SENTENCES.notText };
  if (new TextEncoder().encode(text).byteLength > KUBERNETES_KUBECONFIG_MAX_BYTES) {
    return { refusal: KUBECONFIG_IMPORT_SENTENCES.tooLarge };
  }
  if (nestsTooDeep(text)) return { refusal: KUBECONFIG_IMPORT_SENTENCES.tooDeep };
  // The parser's own duplicate check scans a mapping's keys once per key, so a flat mapping near the cap would hold
  // the browser's main thread for tens of seconds; walkNodes below is the same rule in one pass.
  const lineCounter = new LineCounter();
  const document: Document.Parsed = parseDocument(text, { logLevel: "error", uniqueKeys: false, lineCounter });
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem !== undefined) {
    const position = problem.linePos?.[0];
    return { refusal: parseFailureSentence(problem.code, position?.line ?? 1, position?.col ?? 1) };
  }
  const found = walkNodes(document, lineCounter);
  if (found.duplicate !== undefined) return { refusal: found.duplicate };
  if (document.directives.yaml.explicit) return { refusal: KUBECONFIG_IMPORT_SENTENCES.directive };
  // A tag the core schema does not know, a local `!name` or a verbatim one, is already a warning above; what is
  // left is a %TAG directive, which could point a handle, `!!` included, at another tag prefix.
  const handles = Object.entries(document.directives.tags);
  if (handles.some(([handle, prefix]) => handle !== "!!" || prefix !== STANDARD_TAG_PREFIX)) {
    return { refusal: KUBECONFIG_IMPORT_SENTENCES.tag };
  }
  if (found.aliasOrMerge !== undefined) return { refusal: found.aliasOrMerge };
  if (!isMap(document.contents)) return { refusal: KUBECONFIG_IMPORT_SENTENCES.notAConfig };
  return { root: document.contents };
}

/** What a key holds: absent (missing or null), text, another value, or a mapping. */
type Value =
  | { readonly kind: "absent" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "map"; readonly map: YAMLMap }
  | { readonly kind: "other"; readonly value: unknown };

function valueOf(map: YAMLMap, key: string): Value {
  const node: unknown = map.get(key, true);
  if (node === undefined || (isScalar(node) && node.value === null)) return { kind: "absent" };
  if (isScalar(node)) {
    return typeof node.value === "string" ? { kind: "text", text: node.value } : { kind: "other", value: node.value };
  }
  if (isMap(node)) return { kind: "map", map: node };
  return { kind: "other", value: node };
}

/** The named entries of a list (`clusters`, `users`, `contexts`), by name, and the names listed twice. */
interface NamedEntries {
  readonly byName: Map<string, YAMLMap>;
  readonly repeated: Set<string>;
}

function namedEntries(root: YAMLMap, list: string, inner: string): NamedEntries {
  const byName = new Map<string, YAMLMap>();
  const repeated = new Set<string>();
  const node: unknown = root.get(list, true);
  if (!isSeq(node)) return { byName, repeated };
  for (const item of node.items) {
    if (!isMap(item)) continue;
    const name = valueOf(item, "name");
    const body = valueOf(item, inner);
    if (name.kind !== "text" || body.kind !== "map") continue;
    if (byName.has(name.text)) repeated.add(name.text);
    else byName.set(name.text, body.map);
  }
  return { byName, repeated };
}

/** A context's own refusal, or what it fills. */
type Read = { readonly refusal: string } | { readonly context: ImportedContext };

/** A `*-data` field as PEM text, absent, or refused. */
function pemOf(map: YAMLMap, key: string): { readonly pem?: string } | { readonly refusal: string } {
  const value = valueOf(map, key);
  if (value.kind === "absent") return {};
  if (value.kind !== "text") return { refusal: notTextRefusal(key) };
  const encoded = value.text.replace(/[\r\n]/g, "");
  if (encoded === "" || !BASE64.test(encoded)) return { refusal: notPemRefusal(key) };
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  let pem: string;
  try {
    pem = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { refusal: notPemRefusal(key) };
  }
  if (!pem.includes("-----BEGIN ") || !pem.includes("-----END ")) return { refusal: notPemRefusal(key) };
  return { pem };
}

/** The server split into the fields it fills, and whether it is plain http; or the refusal. */
function serverOf(
  cluster: YAMLMap,
):
  | { readonly fields: Partial<Record<ImportedField, string>>; readonly plaintext: boolean }
  | { readonly refusal: string } {
  const value = valueOf(cluster, "server");
  if (value.kind === "absent") return { refusal: KUBECONFIG_CONTEXT_REFUSALS.noServer };
  if (value.kind !== "text") return { refusal: notTextRefusal("server") };
  const scheme = SERVER_SCHEME.exec(value.text);
  if (scheme === null) return { refusal: KUBECONFIG_CONTEXT_REFUSALS.scheme };
  if (/[?#]/.test(value.text)) return { refusal: KUBECONFIG_CONTEXT_REFUSALS.queryOrFragment };
  // The text is checked as written: a URL parser resolves `.` and `..` segments, `%2e` among them, drops tabs and
  // reads a backslash as a slash, so what it hands back can name another host or path than the file does.
  const rest = value.text.slice(scheme[0].length);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const rawPath = slash === -1 ? "" : rest.slice(slash);
  if (SERVER_REWRITTEN.test(authority)) return { refusal: KUBECONFIG_CONTEXT_REFUSALS.host };
  if (rawPath !== "" && rawPath !== "/") {
    const segments = (rawPath.endsWith("/") ? rawPath.slice(1, -1) : rawPath.slice(1)).split("/");
    if (
      SERVER_REWRITTEN.test(rawPath) ||
      rawPath.includes("%") ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      return { refusal: KUBECONFIG_CONTEXT_REFUSALS.serverPath };
    }
  }
  if (!URL.canParse(value.text)) return { refusal: KUBECONFIG_CONTEXT_REFUSALS.host };
  const url = new URL(value.text);
  if (url.username !== "" || url.password !== "") return { refusal: KUBECONFIG_CONTEXT_REFUSALS.userinfo };
  if (url.hostname === "") return { refusal: KUBECONFIG_CONTEXT_REFUSALS.host };
  const plaintext = scheme[1].toLowerCase() === "http";
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return {
    plaintext,
    fields: {
      host: url.hostname,
      port: url.port === "" ? (plaintext ? "80" : "443") : url.port,
      ...(path === "" ? {} : { apiPath: path }),
    },
  };
}

/** Which of `fields` the map sets to something other than null, in the list's order. */
function presentFields(map: YAMLMap | undefined, fields: readonly string[]): string[] {
  if (map === undefined) return [];
  return fields.filter((field) => valueOf(map, field).kind !== "absent");
}

/** One context, read against the kubeconfig's clusters and users. */
function readContext(item: unknown, clusters: NamedEntries, users: NamedEntries): Read {
  if (!isMap(item)) return { refusal: KUBECONFIG_CONTEXT_REFUSALS.shape };
  const name = valueOf(item, "name");
  if (name.kind !== "text" || name.text === "") return { refusal: KUBECONFIG_CONTEXT_REFUSALS.name };
  const body = valueOf(item, "context");
  if (body.kind !== "map") return { refusal: KUBECONFIG_CONTEXT_REFUSALS.shape };

  const clusterName = valueOf(body.map, "cluster");
  if (clusterName.kind !== "text") return { refusal: notTextRefusal("cluster") };
  if (clusters.repeated.has(clusterName.text)) return { refusal: KUBECONFIG_CONTEXT_REFUSALS.clusterRepeated };
  const cluster = clusters.byName.get(clusterName.text);
  if (cluster === undefined) return { refusal: KUBECONFIG_CONTEXT_REFUSALS.clusterMissing };

  const userName = valueOf(body.map, "user");
  let user: YAMLMap | undefined;
  if (userName.kind === "text") {
    if (users.repeated.has(userName.text)) return { refusal: KUBECONFIG_CONTEXT_REFUSALS.userRepeated };
    user = users.byName.get(userName.text);
    if (user === undefined) return { refusal: KUBECONFIG_CONTEXT_REFUSALS.userMissing };
  } else if (userName.kind !== "absent") {
    return { refusal: notTextRefusal("user") };
  }

  const server = serverOf(cluster);
  if ("refusal" in server) return server;
  const fields: Partial<Record<ImportedField, string>> = { ...server.fields };
  const notices: string[] = [];

  const namespace = valueOf(body.map, "namespace");
  if (namespace.kind === "text") {
    if (!DNS1123_LABEL.test(namespace.text)) return { refusal: KUBECONFIG_CONTEXT_REFUSALS.namespace };
    fields.database = namespace.text;
  } else if (namespace.kind !== "absent") {
    return { refusal: notTextRefusal("namespace") };
  }

  const serverName = valueOf(cluster, "tls-server-name");
  if (serverName.kind === "text") fields.tlsServerName = serverName.text;
  else if (serverName.kind !== "absent") return { refusal: notTextRefusal("tls-server-name") };

  const flag = valueOf(cluster, "insecure-skip-tls-verify");
  const flagIsBoolean = flag.kind === "other" && typeof flag.value === "boolean";
  if (flag.kind !== "absent" && !flagIsBoolean) return { refusal: KUBECONFIG_CONTEXT_REFUSALS.insecureFlag };
  const insecure = flag.kind === "other" && flag.value === true;

  const ca = pemOf(cluster, "certificate-authority-data");
  if ("refusal" in ca) return ca;

  const plugin = user !== undefined && presentFields(user, ["exec", "auth-provider"]).length > 0;
  const ssl: Partial<ImportedSsl> = {};
  let clientPair = false;
  if (!plugin && user !== undefined) {
    const token = valueOf(user, "token");
    // An empty token is no token: the connection would send none, so it is left out and the notice below is given.
    if (token.kind === "text") {
      if (token.text !== "") fields.password = token.text;
    } else if (token.kind !== "absent") return { refusal: notTextRefusal("token") };
    const certificate = pemOf(user, "client-certificate-data");
    if ("refusal" in certificate) return certificate;
    const key = pemOf(user, "client-key-data");
    if ("refusal" in key) return key;
    if ((certificate.pem === undefined) !== (key.pem === undefined)) {
      return { refusal: KUBECONFIG_CONTEXT_REFUSALS.clientPair };
    }
    clientPair = certificate.pem !== undefined && key.pem !== undefined;
    if (certificate.pem !== undefined && key.pem !== undefined && !server.plaintext) {
      ssl.clientCert = certificate.pem;
      ssl.clientKey = key.pem;
    }
  }

  if (server.plaintext) {
    ssl.mode = "disable";
    notices.push(KUBECONFIG_IMPORT_SENTENCES.plaintext);
    const unused = [
      ...(ca.pem === undefined ? [] : ["certificate-authority-data"]),
      ...(clientPair ? ["client-certificate-data", "client-key-data"] : []),
    ];
    if (unused.length > 0) notices.push(unusedTlsNotice(unused, "disable"));
  } else if (insecure) {
    ssl.mode = "require";
    notices.push(KUBECONFIG_IMPORT_SENTENCES.insecure);
    if (ca.pem !== undefined) notices.push(unusedTlsNotice(["certificate-authority-data"], "require"));
  } else if (ca.pem !== undefined) {
    ssl.mode = "verify-full";
    ssl.caCert = ca.pem;
  } else {
    ssl.mode = "verify-system";
  }

  const refused = [...presentFields(cluster, REFUSED_CLUSTER_FIELDS), ...presentFields(user, REFUSED_USER_FIELDS)];
  if (refused.length > 0) notices.push(notImportedNotice(refused));
  if (plugin) notices.push(KUBECONFIG_IMPORT_SENTENCES.credentialPlugin);
  // Over plain http the address is kubectl proxy on this machine, which signs every request in as the kubectl user.
  else if (!server.plaintext && fields.password === undefined && ssl.clientCert === undefined)
    notices.push(KUBECONFIG_IMPORT_SENTENCES.noCredential);

  return { context: { name: name.text, fields, ssl, notices } };
}

/** "Contexts 2 and 5", "Contexts 1, 3 and 4": the places of contexts that share a name. */
function placesOf(places: readonly number[]): string {
  const head = places.slice(0, -1).join(", ");
  return `Contexts ${head} and ${places[places.length - 1]}`;
}

/**
 * The connection entries of a pasted kubeconfig, the current context first, and a sentence for everything that was not
 * imported. Never throws.
 */
export function importKubeconfig(text: string): ConnectionImportResult {
  const checked = checkText(text);
  if ("refusal" in checked) return { contexts: [], refusals: [checked.refusal] };
  const { root } = checked;

  const list: unknown = root.get("contexts", true);
  const items = isSeq(list) ? list.items : [];
  if (items.length === 0) return { contexts: [], refusals: [KUBECONFIG_IMPORT_SENTENCES.noContexts] };

  const clusters = namedEntries(root, "clusters", "cluster");
  const users = namedEntries(root, "users", "user");
  const refusals: string[] = [];

  const places = new Map<string, number[]>();
  items.forEach((item, index) => {
    if (!isMap(item)) return;
    const name = valueOf(item, "name");
    if (name.kind === "text") places.set(name.text, [...(places.get(name.text) ?? []), index + 1]);
  });
  const shared = new Set<string>();
  for (const [name, where] of places) {
    if (where.length < 2) continue;
    shared.add(name);
    refusals.push(`${placesOf(where)} share one name, so none of them was imported: give each context its own name.`);
  }

  const contexts: ImportedContext[] = [];
  items.forEach((item, index) => {
    if (isMap(item)) {
      const name = valueOf(item, "name");
      if (name.kind === "text" && shared.has(name.text)) return;
    }
    const read = readContext(item, clusters, users);
    if ("refusal" in read) refusals.push(`Context ${index + 1} was not imported: ${read.refusal}`);
    else contexts.push(read.context);
  });

  const current = valueOf(root, "current-context");
  const currentName = current.kind === "text" && current.text !== "" ? current.text : undefined;
  if (currentName === undefined) {
    refusals.push(KUBECONFIG_IMPORT_SENTENCES.noCurrentContext);
  } else if (!places.has(currentName)) {
    refusals.push(KUBECONFIG_IMPORT_SENTENCES.unknownCurrentContext);
  }
  const ordered = [
    ...contexts.filter((context) => context.name === currentName),
    ...contexts.filter((context) => context.name !== currentName),
  ];
  return { contexts: ordered, refusals };
}
