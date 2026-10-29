/**
 * Kubernetes discovery exporter (docs/SEED_CONNECTIONS.md, "Platform discovery (Kubernetes)").
 *
 * It runs as a Deployment of its own, beside Studio, from the same image, with a ServiceAccount of its own. Every
 * interval it lists the supported database resources in the namespaces a cluster owner opted in, gets each one's
 * credential Secret by the name the contract gives it, keeps only the contract's keys, and writes one export document
 * into a Secret in Studio's namespace. The kubelet projects that Secret into Studio's pod as a read-only file, which
 * Studio's Kubernetes discovery source reads. Studio's web process never holds this exporter's token.
 *
 * Its token reads the credentials of every opted-in namespace, so this file is kept small and dull on purpose:
 *   - it asks for three things only: a paged `list` of each contract kind per namespace, a `get` of each credential
 *     Secret by name, and a `get` and an `update` of the export Secret; it never lists Secrets and never watches;
 *   - it keeps a Secret only when it belongs to the resource that names it (an ownerReference or CloudNativePG's
 *     label naming it, or, for an initdb Secret tied to nothing, the basic-auth type), so a Cluster cannot point it at
 *     another workload's Secret;
 *   - one namespace's answers never decide another's: a refusal, a list page over the size bound or a list that does
 *     not end withdraws that namespace alone, and the database and export bounds are shared fairly among the
 *     namespaces, so the editors of one namespace cannot push another's databases out of the export;
 *   - it keeps only the contract's keys of a Secret, decoded, each at most LIMITS.valueBytes and valid UTF-8, and of a
 *     resource only the contract's fields; it interprets nothing else: the mapping to a connection, the id rule,
 *     staleness and validation live in src/lib/seed/, where the coverage gate measures them;
 *   - it never logs a value: no part of a 2xx answer's body reaches a log line or a status message;
 *   - it reads its token and its CA again for every request, and refuses a CA file that holds no certificate before
 *     any connection, so a projected token is used as soon as the kubelet rotates it and TLS never falls back to the
 *     public roots;
 *   - it writes with the export Secret's resourceVersion as a precondition, keeps the Secret's metadata, which Helm
 *     owns, and retries a conflict once.
 *
 * The contract rows below are the same data as src/lib/seed/kubernetes-discovery-contract.ts; a unit test holds the
 * two together. Like docker/discover.mjs it is hand-written ESM on Node core modules only, every API it uses exists
 * in Node 24, it sits outside src/ and outside the standalone payload, and every I/O dependency is a seam so
 * tests/unit/docker-discover-kubernetes.test.ts can drive it against a fake API server.
 */
import nodeFs, { realpathSync } from "node:fs";
import https from "node:https";
import { pathToFileURL } from "node:url";

/** A Kubernetes name: an RFC 1123 label (namespaces) or subdomain (object names). */
const LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const MAX_SUBDOMAIN = 253;

function isLabel(value) {
  return typeof value === "string" && LABEL.test(value);
}

function isObjectName(value) {
  return typeof value === "string" && value.length <= MAX_SUBDOMAIN && SUBDOMAIN.test(value);
}

/** `value` when it is a non-empty string, else undefined. */
function text(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The contract table, one row per supported kind: the exporter's copy of KUBERNETES_CONTRACT in
 * src/lib/seed/kubernetes-discovery-contract.ts. Adding a row or a key widens what leaves the opted-in namespaces,
 * so it is a separate, reviewed change on both sides.
 */
export const CONTRACT = Object.freeze([
  Object.freeze({
    slug: "cnpg",
    group: "postgresql.cnpg.io",
    version: "v1",
    plural: "clusters",
    secretKeys: Object.freeze(["username", "password", "dbname", "port"]),
    /** `.spec.bootstrap.initdb.secret.name` when set, otherwise the `<name>-app` Secret CloudNativePG writes. */
    secretName(resource) {
      return text(resource?.spec?.bootstrap?.initdb?.secret?.name) ?? `${resource.metadata.name}-app`;
    },
    /**
     * Whether `secret` belongs to the Cluster `resource` prunes, whose UID is `uid`, so a Cluster cannot point the
     * exporter at another workload's Secret of its namespace. A Secret tied to this Cluster, by an ownerReference to
     * its UID or the label cnpg.io/cluster=<name> CloudNativePG writes, belongs to it. A Secret named by initdb that is
     * tied to nothing at all, no ownerReference and no cnpg.io/cluster label, belongs to it when it is of type
     * kubernetes.io/basic-auth, as CloudNativePG requires. Any other Secret does not: another Cluster's `<name>-app`
     * is basic-auth too, and owned by that Cluster.
     */
    owns(secret, resource, uid) {
      const references = Array.isArray(secret?.metadata?.ownerReferences) ? secret.metadata.ownerReferences : [];
      const label = secret?.metadata?.labels?.["cnpg.io/cluster"];
      const ownedHere = uid !== undefined && references.some((reference) => reference?.uid === uid);
      const labelledHere = typeof label === "string" && label === resource.metadata.name;
      if (ownedHere || labelledHere) return true;
      if (text(resource.spec?.bootstrap?.initdb?.secret?.name) === undefined) return false;
      return secret?.type === "kubernetes.io/basic-auth" && references.length === 0 && label === undefined;
    },
    /**
     * The resource with only the fields the contract reads, or null when it has no namespace and name, or names an
     * initdb database that is not 1 to 63 characters, PostgreSQL's identifier bound: Studio's schema would refuse the
     * whole export for it, and dropping it would connect to another database.
     */
    prune(resource) {
      const namespace = resource?.metadata?.namespace;
      const name = resource?.metadata?.name;
      if (typeof namespace !== "string" || typeof name !== "string") return null;
      const initdb = resource.spec?.bootstrap?.initdb;
      const database = initdb?.database;
      if (database !== undefined && !(typeof database === "string" && database.length >= 1 && database.length <= 63)) {
        return null;
      }
      const kept = {
        ...(text(initdb?.database) === undefined ? {} : { database: initdb.database }),
        ...(text(initdb?.secret?.name) === undefined ? {} : { secret: { name: initdb.secret.name } }),
      };
      return {
        metadata: { namespace, name },
        ...(Object.keys(kept).length === 0 ? {} : { spec: { bootstrap: { initdb: kept } } }),
      };
    },
  }),
]);

/** What every KUBERNETES_DISCOVERY_* variable means when it is unset or blank. */
export const DEFAULTS = Object.freeze({
  intervalMs: 30000,
  minIntervalMs: 5000,
  apiUrl: "https://kubernetes.default.svc",
  tokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
  caPath: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
  exportKey: "export.json",
});

/** Every bound the exporter enforces; Studio enforces the export's again on its side. */
export const LIMITS = Object.freeze({
  namespaces: 256,
  databases: 500,
  valueBytes: 1024,
  // A Secret holds at most 1 MiB; this leaves room for the key.
  exportBytes: 983040,
  responseBytes: 16777216,
  // etcd keeps no object over 1.5 MiB by default, so a full page stays under responseBytes.
  pageSize: 10,
  pages: 100,
  requestTimeoutMs: 10000,
  messageChars: 512,
});

/**
 * The export format, Studio's KUBERNETES_DISCOVERY_EXPORT_VERSION, which a unit test holds equal. Studio reads this
 * version only, so an exporter and a Studio of different versions fail closed: no discovered connection is listed.
 */
export const EXPORT_VERSION = 2;

/** The longest delay setTimeout honours: a longer one, and Infinity, becomes 1 ms, a back-to-back rescan. */
const MAX_TIMER_DELAY_MS = 2147483647;
const LOG_PREFIX = "libredb-kubernetes-discovery:";
/** How a status says a bound was shared among the namespaces (fairShares). */
const FAIR_CUT = "each namespace kept a fair share and the rest was left out";
const CERTIFICATE_BLOCK = "-----BEGIN CERTIFICATE-----";
const EXPORT_SECRET_MESSAGE =
  "KUBERNETES_DISCOVERY_EXPORT_SECRET must name the export Secret as <namespace>/<name>, such as libredb-studio/libredb-studio-discovery-export";
const API_URL_MESSAGE =
  "KUBERNETES_DISCOVERY_API_URL must be an https URL without a user name, password, query or fragment, such as https://kubernetes.default.svc";
/** The error codes this file gives its own failures; any other code is the network's or TLS's. */
const OWN_CODES = new Set(["ETOKEN", "ECA", "ERESPONSETOOLARGE", "EBADJSON", "EBADLIST", "ETIMEDOUT", "EABORTED"]);

/** Trim a possibly-undefined env value down to a usable string, or "". */
function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Render an unknown throwable as a short, log-safe single-line string. */
function describeError(error) {
  if (!error) return "unknown error";
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" && error.message ? error.message : String(error);
  if (code && !OWN_CODES.has(code) && !message.includes(code)) return `${code} (${message})`;
  return message;
}

/** At most LIMITS.messageChars UTF-16 units, the unit Studio's schema counts, never ending on half a pair. */
function clip(message) {
  if (message.length <= LIMITS.messageChars) return message;
  const cut = message.slice(0, LIMITS.messageChars);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** An Error carrying a Node-style `code`, which classifyApiError reads. */
function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

/** Comma-separated items; blanks and empty items are ignored, repeats kept once, sorted. */
function listSetting(raw) {
  return [...new Set(trimmed(raw).split(",").map((item) => item.trim()).filter((item) => item !== ""))].sort();
}

/** A non-negative integer from the environment, or `fallback` when unset or blank. */
function integerSetting(env, name, fallback, minimum, maximum) {
  const raw = trimmed(env[name]);
  if (raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}, got "${raw}"`);
  }
  if (Number(raw) > maximum) throw new Error(`${name} must be an integer of at most ${maximum}, got "${raw}"`);
  return Number(raw);
}

/** `path` without its trailing slashes, in one pass. */
function withoutTrailingSlashes(path) {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}

function apiUrlSetting(raw) {
  const value = trimmed(raw) || DEFAULTS.apiUrl;
  const url = URL.parse(value);
  const valid =
    url !== null &&
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    !value.includes("?") &&
    !value.includes("#");
  if (!valid) throw new Error(API_URL_MESSAGE);
  return `${url.protocol}//${url.host}${withoutTrailingSlashes(url.pathname)}`;
}

/**
 * The exporter's configuration. Throws on a value it cannot honour rather than guessing: a typo in a namespace must
 * stop the exporter with a reason in its log, not export another set.
 */
export function readConfig(env) {
  const source = env ?? {};
  const namespaces = listSetting(source.KUBERNETES_DISCOVERY_NAMESPACES);
  if (namespaces.length === 0) throw new Error("KUBERNETES_DISCOVERY_NAMESPACES must name at least one namespace");
  const odd = namespaces.find((namespace) => !isLabel(namespace));
  if (odd !== undefined) {
    throw new Error(
      `KUBERNETES_DISCOVERY_NAMESPACES names "${odd}", which is not a namespace name: lowercase letters, digits and inner hyphens, at most 63`,
    );
  }
  if (namespaces.length > LIMITS.namespaces) {
    throw new Error(`KUBERNETES_DISCOVERY_NAMESPACES names more than ${LIMITS.namespaces} namespaces`);
  }

  const parts = trimmed(source.KUBERNETES_DISCOVERY_EXPORT_SECRET).split("/");
  if (parts.length !== 2 || !isLabel(parts[0]) || !isObjectName(parts[1])) throw new Error(EXPORT_SECRET_MESSAGE);

  const known = CONTRACT.map((row) => row.slug).join(", ");
  let kinds = CONTRACT;
  if (trimmed(source.KUBERNETES_DISCOVERY_KINDS) !== "") {
    const slugs = listSetting(source.KUBERNETES_DISCOVERY_KINDS);
    if (slugs.length === 0) throw new Error(`KUBERNETES_DISCOVERY_KINDS must name at least one kind: ${known}`);
    const unknown = slugs.find((slug) => !CONTRACT.some((row) => row.slug === slug));
    if (unknown !== undefined) {
      throw new Error(`KUBERNETES_DISCOVERY_KINDS names "${unknown}", which is not a supported kind: ${known}`);
    }
    kinds = CONTRACT.filter((row) => slugs.includes(row.slug));
  }

  return {
    namespaces,
    exportSecret: { namespace: parts[0], name: parts[1] },
    kinds,
    intervalMs: integerSetting(
      source,
      "KUBERNETES_DISCOVERY_INTERVAL_MS",
      DEFAULTS.intervalMs,
      DEFAULTS.minIntervalMs,
      MAX_TIMER_DELAY_MS,
    ),
    apiUrl: apiUrlSetting(source.KUBERNETES_DISCOVERY_API_URL),
    tokenPath: trimmed(source.KUBERNETES_DISCOVERY_TOKEN_PATH) || DEFAULTS.tokenPath,
    caPath: trimmed(source.KUBERNETES_DISCOVERY_CA_PATH) || DEFAULTS.caPath,
    once: trimmed(source.KUBERNETES_DISCOVERY_ONCE) === "1",
  };
}

/** The API server's own Status message for a refusal, or "" when the body carries none. */
function statusMessage(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON: the request line and the status say what is known, without echoing an unknown body.
  }
  return "";
}

function readFileText(path) {
  return nodeFs.promises.readFile(path, "utf8");
}

/**
 * A client of the Kubernetes API over node:https, with the token and the CA read again for every request.
 * `agent: false` gives each request its own connection that closes with it, so nothing keeps the process alive after
 * the last scan. Each request is bounded in time (the whole request) and in body size, and a redirect is never
 * followed. A non-2xx answer rejects with `statusCode` and the API server's Status message; any other failure rejects
 * with a `code`. `abort()` ends every request in flight, so a signal never waits on the API server.
 */
export function createApiClient({ apiUrl, tokenPath, caPath, request, readFile, timeoutMs, maxBytes } = {}) {
  const send = request ?? https.request;
  const read = readFile ?? readFileText;
  const budgetMs = timeoutMs ?? LIMITS.requestTimeoutMs;
  const cap = maxBytes ?? LIMITS.responseBytes;
  const base = new URL(apiUrl);
  const prefix = base.pathname === "/" ? "" : base.pathname;
  const inFlight = new Set();

  async function credentials() {
    let token;
    try {
      token = (await read(tokenPath)).trim();
    } catch {
      throw codedError(`the token file ${tokenPath} cannot be read`, "ETOKEN");
    }
    if (token === "") throw codedError(`the token file ${tokenPath} is empty`, "ETOKEN");
    let ca;
    try {
      ca = await read(caPath);
    } catch {
      throw codedError(`the CA file ${caPath} cannot be read`, "ECA");
    }
    // A `ca` without a certificate must never reach node:https: depending on the runtime an empty one is ignored,
    // and the public roots would then vouch for the API server.
    if (!ca.includes(CERTIFICATE_BLOCK)) throw codedError(`the CA file ${caPath} holds no certificate`, "ECA");
    return { token, ca };
  }

  function exchange(method, path, payload, { token, ca }) {
    const line = `${method} ${path.split("?")[0]}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let outgoing = null;
      const timer = setTimeout(
        () => fail(codedError(`the API server did not answer ${line} within ${budgetMs} ms`, "ETIMEDOUT")),
        budgetMs,
      );
      const entry = { abort: () => fail(codedError(`${line} aborted`, "EABORTED")) };
      inFlight.add(entry);
      function settle() {
        settled = true;
        clearTimeout(timer);
        inFlight.delete(entry);
      }
      function fail(error) {
        if (settled) return;
        settle();
        outgoing?.destroy();
        reject(error);
      }
      function finish(response, chunks) {
        if (settled) return;
        settle();
        const body = Buffer.concat(chunks).toString("utf8");
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          const said = statusMessage(body);
          const message = `${line} answered HTTP ${statusCode}${said ? `: ${said}` : ""}`;
          reject(Object.assign(new Error(message), { statusCode }));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(codedError(`${line} answered with a body that is not JSON`, "EBADJSON"));
        }
      }
      const headers = { accept: "application/json", authorization: `Bearer ${token}` };
      if (payload !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = Buffer.byteLength(payload);
      }
      try {
        outgoing = send(
          {
            method,
            hostname: base.hostname.replace(/^\[|\]$/g, ""),
            port: base.port === "" ? 443 : Number(base.port),
            path: `${prefix}${path}`,
            headers,
            ca,
            agent: false,
          },
          (response) => {
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
              size += chunk.length;
              if (size > cap) {
                fail(codedError(`${line} answered with more than ${cap} bytes`, "ERESPONSETOOLARGE"));
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () => finish(response, chunks));
            response.on("error", fail);
          },
        );
      } catch (error) {
        fail(error);
        return;
      }
      outgoing.on("error", fail);
      outgoing.end(payload);
    });
  }

  async function call(method, path, body) {
    const secrets = await credentials();
    return exchange(method, path, body === undefined ? undefined : JSON.stringify(body), secrets);
  }

  return {
    get: (path) => call("GET", path),
    put: (path, body) => call("PUT", path, body),
    abort() {
      for (const entry of [...inFlight]) entry.abort();
    },
  };
}

/** The export's status for a failed request: who failed, from what this file can tell. */
export function classifyApiError(error) {
  const message = clip(describeError(error));
  const statusCode = error?.statusCode;
  if (Number.isInteger(statusCode)) {
    return { ok: false, code: statusCode === 401 ? "unauthorized" : "api_error", httpStatus: statusCode, message };
  }
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "ETOKEN" || code === "ECA") return { ok: false, code: "credentials_unavailable", message };
  if (code === "ERESPONSETOOLARGE") return { ok: false, code: "limit_exceeded", message };
  if (code === "EBADJSON" || code === "EBADLIST") return { ok: false, code: "api_error", message };
  return { ok: false, code: "api_unreachable", message };
}

/** The Secret's contract keys, decoded, or the first key whose value is over the bound or not UTF-8 text. */
function keepSecretData(row, secret) {
  const data = secret?.data && typeof secret.data === "object" ? secret.data : {};
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const kept = {};
  for (const key of row.secretKeys) {
    const encoded = data[key];
    if (typeof encoded !== "string") continue;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > LIMITS.valueBytes) return { problem: "invalid_value", key };
    try {
      kept[key] = decoder.decode(bytes);
    } catch {
      return { problem: "invalid_value", key };
    }
  }
  return { data: kept };
}

/**
 * The credential Secret of a listed resource: its kept keys, or the problem that stopped the exporter keeping them. A
 * Secret that does not belong to the resource is kept whole out of the export.
 */
async function readCredentialSecret(client, { row, resource, uid, secretName }) {
  try {
    const secret = await client.get(`/api/v1/namespaces/${resource.metadata.namespace}/secrets/${secretName}`);
    if (!row.owns(secret, resource, uid)) return { name: secretName, problem: "not_owned" };
    return { name: secretName, ...keepSecretData(row, secret) };
  } catch (error) {
    if (error?.statusCode === 404) return { name: secretName, problem: "not_found" };
    if (error?.statusCode === 403) return { name: secretName, problem: "forbidden" };
    throw error;
  }
}

/**
 * How many of each group's items to keep under `budget`, shared max-min fairly: `sizes[g]` lists the sizes of group
 * g's items in order, and each group keeps the longest prefix of them its share holds. The groups are served from the
 * smallest total up, each with an equal part of what is left, so a group that needs less than its part leaves the rest
 * to the larger ones, and every group's share is an equal part of the budget at least, or all it needs. The exporter
 * shares its database and export bounds among the namespaces this way, so one namespace's editors cannot push another
 * namespace's databases out of the export by creating resources.
 */
export function fairShares(sizes, budget) {
  const totals = sizes.map((items) => items.reduce((sum, size) => sum + size, 0));
  const order = totals.map((_, index) => index).sort((a, b) => totals[a] - totals[b] || a - b);
  const kept = sizes.map(() => 0);
  let left = budget;
  for (const [served, group] of order.entries()) {
    const share = Math.floor(left / (order.length - served));
    let used = 0;
    for (const size of sizes[group]) {
      if (used + size > share) break;
      used += size;
      kept[group] += 1;
    }
    left -= used;
  }
  return kept;
}

/** The status of a failed list that answers for its namespace alone, or null for a failure that fails the scan. */
function namespaceRefusal(error, row, namespace) {
  const what = `${row.plural}.${row.group}`;
  if (error?.statusCode === 403) {
    return {
      ok: false,
      code: "forbidden",
      httpStatus: 403,
      message: `the exporter may not list ${what} in ${namespace} (HTTP 403): grant its ServiceAccount list on them there`,
    };
  }
  if (error?.statusCode === 404) {
    return {
      ok: false,
      code: "crd_missing",
      httpStatus: 404,
      message: `the API server does not serve ${what} (HTTP 404): install the operator, or leave ${row.slug} out of KUBERNETES_DISCOVERY_KINDS`,
    };
  }
  if (error?.code === "ERESPONSETOOLARGE") {
    return { ok: false, code: "limit_exceeded", message: `${what} in ${namespace} are too large to list: ${error.message}` };
  }
  return null;
}

/**
 * One namespace's resources of every kind, in list order: at most `limits.databases` of them, and whether it holds
 * more, which ends its reading, since no share of the bound could take them. A 403, a 404, a page over the response
 * bound and a list that does not end within `limits.pages` answer for this namespace alone, whose editors decide how
 * many and how large its resources are: the namespace gets that status and none of its resources, those of earlier
 * pages included. Any other failure throws and fails the scan.
 */
async function listNamespace({ client, config, namespace, limits }) {
  const found = [];
  let leftOut = 0;
  for (const row of config.kinds) {
    const path = `/apis/${row.group}/${row.version}/namespaces/${namespace}/${row.plural}`;
    let continueToken = "";
    for (let page = 0; ; page += 1) {
      if (page >= limits.pages) {
        const message = `${row.plural}.${row.group} in ${namespace} are too many to list: GET ${path} did not end within ${limits.pages} pages`;
        return { status: { ok: false, code: "limit_exceeded", message } };
      }
      const query = `?limit=${limits.pageSize}${continueToken === "" ? "" : `&continue=${encodeURIComponent(continueToken)}`}`;
      let list;
      try {
        // oxlint-disable-next-line no-await-in-loop -- pages come one after another by their continue token.
        list = await client.get(`${path}${query}`);
      } catch (error) {
        const status = namespaceRefusal(error, row, namespace);
        if (status === null) throw error;
        return { status };
      }
      if (!Array.isArray(list?.items)) {
        throw codedError(`GET ${path} answered with something other than a list`, "EBADLIST");
      }
      for (const item of list.items) {
        const resource = row.prune(item);
        if (resource === null || resource.metadata.namespace !== namespace || !isObjectName(resource.metadata.name)) {
          leftOut += 1;
          continue;
        }
        const secretName = row.secretName(resource);
        if (!isObjectName(secretName)) {
          leftOut += 1;
          continue;
        }
        if (found.length === limits.databases) return { status: { ok: true }, found, more: true, leftOut };
        found.push({ row, resource, uid: text(item?.metadata?.uid), secretName });
      }
      continueToken = typeof list.metadata?.continue === "string" ? list.metadata.continue : "";
      if (continueToken === "") break;
    }
  }
  return { status: { ok: true }, found, more: false, leftOut };
}

/**
 * One listing of every namespace and kind. Never throws; a failure comes back as a status. An answer about one
 * namespace withdraws its databases and leaves the others (listNamespace); any other failure fails the whole scan,
 * and the caller keeps its last good one. A resource without Kubernetes names is left out and counted, and no request
 * is built from one. Past `limits.databases` the namespaces share the bound fairly (fairShares), only the databases
 * within a share have their Secret read, and `truncated` is set.
 */
export async function scanOnce({ client, config, limits = LIMITS }) {
  const namespaces = [];
  const listings = [];
  let leftOut = 0;
  try {
    for (const namespace of config.namespaces) {
      // oxlint-disable-next-line no-await-in-loop -- one namespace at a time keeps the API server's load flat.
      const listing = await listNamespace({ client, config, namespace, limits });
      namespaces.push({ name: namespace, status: listing.status });
      if (!listing.status.ok) continue;
      leftOut += listing.leftOut;
      listings.push(listing);
    }
    // A namespace that holds more than it kept counts one more, so its share is always short of what it holds.
    const held = listings.map((listing) => listing.found.length + (listing.more ? 1 : 0));
    const shares = fairShares(
      held.map((count) => new Array(count).fill(1)),
      limits.databases,
    );
    const databases = [];
    for (const [index, listing] of listings.entries()) {
      for (const candidate of listing.found.slice(0, shares[index])) {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time keeps the API server's load flat.
        const secret = await readCredentialSecret(client, candidate);
        databases.push({ kind: candidate.row.slug, resource: candidate.resource, secret });
      }
    }
    const truncated = held.some((count, index) => shares[index] < count);
    return { ok: true, namespaces, databases, truncated, leftOut };
  } catch (error) {
    return { ok: false, status: classifyApiError(error) };
  }
}

/** The status object as the export carries it. */
function normalizeStatus(status) {
  if (status.ok) return { ok: true };
  return {
    ok: false,
    code: status.code,
    ...(status.httpStatus === undefined ? {} : { httpStatus: status.httpStatus }),
    message: clip(String(status.message)),
  };
}

/**
 * The export's content, at EXPORT_VERSION. `now` is the epoch milliseconds of this attempt; `generatedAt` is the ISO
 * time of the last successful scan, or null before the first, in which case no namespace and no database is exported.
 */
export function buildExport({ now, status, generatedAt, namespaces, databases }) {
  return {
    version: EXPORT_VERSION,
    platform: "kubernetes",
    generatedAt,
    checkedAt: new Date(now).toISOString(),
    status: normalizeStatus(status),
    namespaces: generatedAt === null ? [] : namespaces,
    databases: generatedAt === null ? [] : databases,
  };
}

/**
 * The export's text, at most `limits.exportBytes` bytes. Over the bound, the namespaces share it fairly (fairShares),
 * each keeping its databases in order while they fit its share, and an ok status becomes limit_exceeded; a status
 * that is already an error keeps its code.
 */
export function serializeExport(data, limits = LIMITS) {
  const whole = JSON.stringify(data);
  if (Buffer.byteLength(whole, "utf8") <= limits.exportBytes) return whole;
  const status = data.status.ok
    ? {
        ok: false,
        code: "limit_exceeded",
        message: `the export would exceed ${limits.exportBytes} bytes; ${FAIR_CUT}`,
      }
    : data.status;
  const budget = limits.exportBytes - Buffer.byteLength(JSON.stringify({ ...data, status, databases: [] }), "utf8");
  const groups = [...Map.groupBy(data.databases, (database) => database.resource.metadata.namespace).values()];
  // Each database costs its own bytes and at most one comma.
  const sizes = groups.map((group) => group.map((database) => Buffer.byteLength(JSON.stringify(database), "utf8") + 1));
  const shares = fairShares(sizes, budget);
  return JSON.stringify({ ...data, status, databases: groups.flatMap((group, index) => group.slice(0, shares[index])) });
}

/**
 * Writes `text` into the export Secret: a get, then an update of that same object with only its data replaced, so
 * the metadata Helm owns stays as it is and its resourceVersion is the precondition. A conflict, another writer in
 * between, re-reads and retries once; any other failure, and a second conflict, rejects. The Secret is never created
 * here: whoever installs the exporter creates it empty, and a Role limited to its name cannot create.
 */
export async function writeExport({ client, config, text }) {
  const path = `/api/v1/namespaces/${config.exportSecret.namespace}/secrets/${config.exportSecret.name}`;
  const encoded = Buffer.from(text, "utf8").toString("base64");
  for (let attempt = 0; ; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- the retry re-reads the Secret the conflict changed.
    const secret = await client.get(path);
    // managedFields is the API server's own bookkeeping: an update that omits it keeps it as it is.
    const metadata = { ...secret.metadata };
    delete metadata.managedFields;
    try {
      // oxlint-disable-next-line no-await-in-loop -- the update needs the object it just read.
      await client.put(path, { ...secret, metadata, data: { [DEFAULTS.exportKey]: encoded } });
      return;
    } catch (error) {
      if (error?.statusCode !== 409 || attempt > 0) throw error;
    }
  }
}

/** The one-line summary of a scan: counts only for a good one, its status code and message for a failed one. */
function summarize(result, limits) {
  if (!result.ok) return `scan failed: ${result.status.code}: ${result.status.message}`;
  const unreadable = result.namespaces.filter((namespace) => !namespace.status.ok).length;
  const counts = `scan ok: ${result.databases.length} databases in ${result.namespaces.length} namespaces exported`;
  if (unreadable === 0 && result.leftOut === 0 && !result.truncated) return counts;
  const cut = result.truncated ? `, cut to fair shares of ${limits.databases}` : "";
  return `${counts}, ${unreadable} namespaces could not be read, ${result.leftOut} resources left out${cut}`;
}

/**
 * The scan-and-write step. A failed scan keeps the last good namespaces, databases and generatedAt, and updates the
 * status and checkedAt. A summary is logged when it changes; a write that fails is logged every time.
 */
export function createExporter({ config, client, now, info, warn, limits = LIMITS }) {
  const last = { generatedAt: null, namespaces: [], databases: [], summary: "" };
  let stopping = false;

  async function scanAndWrite() {
    const result = await scanOnce({ client, config, limits });
    if (stopping) return false;
    const checkedAt = now();
    let status = result.status;
    if (result.ok) {
      last.generatedAt = new Date(checkedAt).toISOString();
      last.namespaces = result.namespaces;
      last.databases = result.databases;
      status = result.truncated
        ? {
            ok: false,
            code: "limit_exceeded",
            message: `more than ${limits.databases} databases in the discovered namespaces; ${FAIR_CUT}`,
          }
        : { ok: true };
    }
    const data = buildExport({
      now: checkedAt,
      status,
      generatedAt: last.generatedAt,
      namespaces: last.namespaces,
      databases: last.databases,
    });
    try {
      await writeExport({ client, config, text: serializeExport(data, limits) });
    } catch (error) {
      if (stopping) return false;
      const failure = classifyApiError(error);
      warn(`write failed: ${failure.code}: ${failure.message}`);
      return false;
    }
    const summary = summarize(result, limits);
    if (summary !== last.summary) {
      last.summary = summary;
      if (result.ok) info(summary);
      else warn(summary);
    }
    return true;
  }

  return {
    scanAndWrite,
    stop() {
      stopping = true;
      client.abort();
    },
  };
}

/**
 * Entry point. Reads the configuration, then scans and writes every KUBERNETES_DISCOVERY_INTERVAL_MS until SIGTERM or
 * SIGINT. It runs as PID 1 in its container, where the kernel ignores a signal that has no handler, so without these
 * handlers a rollout would wait for the kubelet's SIGKILL. A request in flight is aborted and its scan writes nothing.
 * With KUBERNETES_DISCOVERY_ONCE=1 it scans once and resolves 0 when the export was written, 1 when not. Exit code 2
 * is a configuration it cannot honour.
 */
export async function main({ env, request, readFile, now, stdout, stderr, signals } = {}) {
  const environment = env ?? process.env;
  const clock = now ?? Date.now;
  const out = stdout ?? ((chunk) => process.stdout.write(chunk));
  const err = stderr ?? ((chunk) => process.stderr.write(chunk));
  const events = signals ?? process;
  const info = (line) => out(`${LOG_PREFIX} ${line}\n`);
  const warn = (line) => err(`${LOG_PREFIX} ${line}\n`);

  let config;
  try {
    config = readConfig(environment);
  } catch (error) {
    warn(`invalid configuration: ${describeError(error)}`);
    return 2;
  }

  const client = createApiClient({
    apiUrl: config.apiUrl,
    tokenPath: config.tokenPath,
    caPath: config.caPath,
    request,
    readFile,
  });
  const exporter = createExporter({ config, client, now: clock, info, warn });
  const { namespace, name } = config.exportSecret;
  info(
    `watching ${config.namespaces.length} namespaces (${config.namespaces.join(", ")}) for ${config.kinds.map((row) => row.slug).join(", ")} every ${config.intervalMs} ms, writing ${namespace}/${name}`,
  );
  if (config.once) return (await exporter.scanAndWrite()) ? 0 : 1;

  return new Promise((resolve) => {
    let timer = null;
    let stopped = false;
    function stop(signal) {
      stopped = true;
      clearTimeout(timer);
      events.removeListener("SIGTERM", onTerm);
      events.removeListener("SIGINT", onInt);
      exporter.stop();
      info(`received ${signal}, exiting`);
      resolve(0);
    }
    function onTerm() {
      stop("SIGTERM");
    }
    function onInt() {
      stop("SIGINT");
    }
    async function loop() {
      await exporter.scanAndWrite();
      if (!stopped) timer = setTimeout(loop, config.intervalMs);
    }
    events.once("SIGTERM", onTerm);
    events.once("SIGINT", onInt);
    loop();
  });
}

/**
 * Whether this module is the program being run, rather than an import. Copied from docker/bind-address.mjs, not
 * imported, so each file in /usr/local/lib/libredb-studio stands alone; the reasons for realpath and pathToFileURL are
 * in that file's docblock.
 */
export function isDirectExecution(argv1, moduleUrl) {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === moduleUrl;
  } catch {
    // An unreadable or vanished argv[1] is not this module, and must not throw.
    return false;
  }
}

// Run only when executed directly, so importing this file in a test is inert.
if (isDirectExecution(process.argv[1], import.meta.url)) {
  process.exitCode = await main({});
}
