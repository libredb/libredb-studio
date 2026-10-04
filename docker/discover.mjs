/**
 * CapRover discovery exporter (docs/SEED_CONNECTIONS.md, "Platform discovery (CapRover)").
 *
 * The auto-connect CapRover template runs this file as a second app next to Studio, with the Docker
 * socket mounted and as root: the template's `command` replaces the image ENTRYPOINT, so the gosu drop
 * in docker-entrypoint.sh never happens. Every few seconds it lists the Swarm services on CapRover's
 * overlay network and writes what Studio needs to connect to their databases into one file on a volume
 * the two apps share. Studio's web process reads that file and never touches the socket.
 *
 * The socket is root on the host, so this file is kept small and dull on purpose:
 *   - it issues GET requests only, to exactly two Engine API paths pinned to /v1.44, the version
 *     CapRover itself pins;
 *   - it copies only the ten allow-listed environment keys, and the one thing it derives from a
 *     command line is the NAME of the variable a Redis `--requirepass` reads, never a value;
 *   - it interprets nothing else: engine detection, credential mapping, staleness and validation live
 *     in src/lib/seed/, where the coverage gate measures them;
 *   - it never logs an environment value: log lines carry counts, codes and paths only;
 *   - it refuses to start when the output directory could be written by anyone but itself, and it
 *     writes through an O_EXCL | O_NOFOLLOW temp file, so the web process cannot plant a link that the
 *     root exporter follows.
 *
 * Like docker/bind-address.mjs it is hand-written ESM on Node core modules only, every API it uses exists
 * in Node 24 (Dockerfile.alpine-slim ships Alpine's nodejs 24), it sits outside src/ and outside the
 * standalone payload, and every I/O dependency is a seam so tests/unit/docker-discover.test.ts can drive
 * it without Docker.
 */
import nodeFs, { constants as fsConstants, realpathSync } from "node:fs";
import http from "node:http";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The only environment keys that leave a service spec, case-sensitive. DFLY_requirepass is mixed case on
 * purpose: an uppercase-only list would silently drop Dragonfly's password. Adding a key widens what
 * reaches the shared volume, so it is a separate, reviewed change.
 */
export const ENV_ALLOW_LIST = Object.freeze([
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "MYSQL_ROOT_PASSWORD",
  "MONGO_INITDB_ROOT_USERNAME",
  "MONGO_INITDB_ROOT_PASSWORD",
  "REDIS_PASSWORD",
  "VALKEY_EXTRA_FLAGS",
  "KEYDB_PASSWORD",
  "DFLY_requirepass",
]);

/** What every DISCOVERY_* variable means when it is unset or blank. */
export const DEFAULTS = Object.freeze({
  output: "/app/discovery/services.json",
  network: "captain-overlay-network",
  intervalMs: 10000,
  minIntervalMs: 2000,
  socket: "/var/run/docker.sock",
  fileUid: 1001,
  fileGid: 1001,
});

/** Every bound the exporter enforces; Studio enforces the same ones again on its side. */
export const LIMITS = Object.freeze({
  services: 500,
  envValueBytes: 1024,
  name: 63,
  host: 253,
  image: 512,
  fileBytes: 2097152,
  responseBytes: 16777216,
  requestTimeoutMs: 10000,
  messageChars: 512,
});

/** The longest delay setTimeout honours: a longer one, and Infinity, becomes 1 ms, a back-to-back rescan. */
const MAX_TIMER_DELAY_MS = 2147483647;

/** The largest owner id fchownSync can set: 4294967295 reads as "leave the owner as it is", and more throws. */
const MAX_OWNER_ID = 4294967294;

const SYSTEM_SERVICE_PREFIX = "captain-";
const SERVICE_ALIAS_PREFIX = "srv-captain--";
const STUDIO_REPOSITORY = "libredb/libredb-studio";
const REQUIREPASS_PATTERN = /--requirepass\s+["']?\$\{?([A-Z_][A-Z0-9_]*)\}?/;
const SOCKET_HINTS = Object.freeze({
  ENOENT: "the Docker socket is not mounted into this app",
  EACCES: "the Docker socket cannot be opened: the exporter is not running as root",
  ECONNREFUSED: "the Docker daemon refused the connection on its socket",
  ETIMEDOUT: `the Docker daemon did not answer within ${LIMITS.requestTimeoutMs} ms`,
});

/** Trim a possibly-undefined env value down to a usable string, or "". */
function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Render an unknown throwable as a short, log-safe single-line string. */
function describeError(error) {
  if (!error) return "unknown error";
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" && error.message ? error.message : String(error);
  if (code && !message.includes(code)) return `${code} (${message})`;
  return message;
}

/** At most LIMITS.messageChars UTF-16 units, the unit Studio's schema counts, never ending on half a pair. */
function clip(message) {
  if (message.length <= LIMITS.messageChars) return message;
  const cut = message.slice(0, LIMITS.messageChars);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * A non-negative integer read from the environment, or `fallback` when the variable is unset or blank.
 * `maximum` is the largest value the setting can be used with. Left out, it is the largest integer a double
 * holds exactly, so a digit string that Number() reads as Infinity is refused either way.
 */
function integerSetting(env, name, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = trimmed(env[name]);
  if (raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}, got "${raw}"`);
  }
  if (Number(raw) > maximum) {
    throw new Error(`${name} must be an integer of at most ${maximum}, got "${raw}"`);
  }
  return Number(raw);
}

/** Comma-separated CapRover app names; blanks and empty items are ignored. */
export function parseExcludeList(raw) {
  const names = new Set();
  for (const item of trimmed(raw).split(",")) {
    const name = item.trim();
    if (name) names.add(name);
  }
  return names;
}

/**
 * The exporter's configuration. Throws on a value it cannot honour rather than guessing: a typo in
 * DISCOVERY_INTERVAL_MS must stop the app with a reason in its log, not run it at some other rate.
 */
export function readConfig(env) {
  const source = env ?? {};
  return {
    output: trimmed(source.DISCOVERY_OUTPUT) || DEFAULTS.output,
    network: trimmed(source.DISCOVERY_NETWORK) || DEFAULTS.network,
    intervalMs: integerSetting(
      source,
      "DISCOVERY_INTERVAL_MS",
      DEFAULTS.intervalMs,
      DEFAULTS.minIntervalMs,
      MAX_TIMER_DELAY_MS,
    ),
    exclude: parseExcludeList(source.DISCOVERY_EXCLUDE),
    socket: trimmed(source.DOCKER_SOCKET) || DEFAULTS.socket,
    fileUid: integerSetting(source, "DISCOVERY_FILE_UID", DEFAULTS.fileUid, 0, MAX_OWNER_ID),
    fileGid: integerSetting(source, "DISCOVERY_FILE_GID", DEFAULTS.fileGid, 0, MAX_OWNER_ID),
    once: trimmed(source.DISCOVERY_ONCE) === "1",
  };
}

/**
 * The network named exactly `name`. GET /networks?filters={"name":[...]} matches substrings, so
 * "captain" would also return "captain-overlay-network"; only an exact Name counts, and a swarm-scoped
 * one wins over a local one of the same name.
 */
export function selectNetwork(networks, name) {
  if (!Array.isArray(networks)) return null;
  const exact = networks.filter((entry) => entry && entry.Name === name && typeof entry.Id === "string");
  const chosen = exact.find((entry) => entry.Scope === "swarm") ?? exact[0];
  return chosen ? { id: chosen.Id, name: chosen.Name } : null;
}

/** `repo` of `repo:tag@digest`, keeping a registry port such as `localhost:5000/x`. */
function repositoryOf(image) {
  const withoutDigest = image.split("@")[0];
  const colon = withoutDigest.lastIndexOf(":");
  return colon > withoutDigest.lastIndexOf("/") ? withoutDigest.slice(0, colon) : withoutDigest;
}

/** Studio's own image, which runs both the web app and this exporter: never exported. */
export function isStudioImage(image) {
  if (typeof image !== "string" || image === "") return false;
  const repository = repositoryOf(image);
  return repository === STUDIO_REPOSITORY || repository.endsWith(`/${STUDIO_REPOSITORY}`);
}

/** The CapRover app name: the service name without the legacy `srv-captain--` prefix. For ids and display only. */
export function appNameOf(serviceName) {
  return serviceName.startsWith(SERVICE_ALIAS_PREFIX) ? serviceName.slice(SERVICE_ALIAS_PREFIX.length) : serviceName;
}

/** The attachment of `spec` to `network`, matched by id or, for robustness, by name. */
function attachmentOf(spec, network) {
  const attachments = spec?.TaskTemplate?.Networks;
  if (!Array.isArray(attachments)) return null;
  return attachments.find((entry) => entry && (entry.Target === network.id || entry.Target === network.name)) ?? null;
}

/**
 * The name Studio dials. The `srv-captain--<app>` alias when the attachment carries one, else the service
 * name: a legacy app is named `srv-captain--<app>` and has no alias, and an app deployed before CapRover
 * added the alias resolves by its bare name. Never derived by adding or stripping the prefix.
 */
export function hostOf(serviceSpec, network) {
  const aliases = attachmentOf(serviceSpec, network)?.Aliases;
  const alias = Array.isArray(aliases)
    ? aliases.find((entry) => typeof entry === "string" && entry.startsWith(SERVICE_ALIAS_PREFIX))
    : undefined;
  return alias ?? serviceSpec.Name;
}

/**
 * The allow-listed subset of a service's `KEY=value` entries. Split on the first "=", so a value keeps
 * any "=" and every space byte for byte; an entry without "=" is skipped; the last duplicate wins, as it
 * does for the container. A value over LIMITS.envValueBytes UTF-8 bytes is dropped and counted.
 */
export function projectEnv(envList, allowList) {
  const latest = new Map();
  if (Array.isArray(envList)) {
    for (const entry of envList) {
      if (typeof entry !== "string") continue;
      const separator = entry.indexOf("=");
      if (separator <= 0) continue;
      const key = entry.slice(0, separator);
      if (allowList.includes(key)) latest.set(key, entry.slice(separator + 1));
    }
  }
  const env = {};
  let dropped = 0;
  for (const key of allowList) {
    if (!latest.has(key)) continue;
    const value = latest.get(key);
    if (Buffer.byteLength(value, "utf8") > LIMITS.envValueBytes) dropped += 1;
    else env[key] = value;
  }
  return { env, dropped };
}

/**
 * The NAME of the allow-listed variable a `--requirepass $NAME` in the command line reads, else null.
 * The redis one-click template starts `sh -c 'redis-server --requirepass $REDIS_PASSWORD'`, and the
 * official image ignores REDIS_PASSWORD without it. The raw command is never exported: commands of other
 * apps can carry literal secrets.
 */
export function requirepassEnvOf(containerSpec, allowList) {
  const words = [containerSpec?.Command, containerSpec?.Args]
    .filter(Array.isArray)
    .flat()
    .filter((word) => typeof word === "string");
  const match = REQUIREPASS_PATTERN.exec(words.join(" "));
  return match && allowList.includes(match[1]) ? match[1] : null;
}

/** A Docker task count, or 0 when the daemon sent none. */
function taskCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * The services to export: on `network`, not a CapRover system service, not Studio itself, not excluded
 * by app name. Every such service is exported, database or not; only its env is filtered. A service whose
 * image or app name is empty (a service named exactly `srv-captain--` has no app name), or whose name,
 * host or image is over its bound, is left out and counted in droppedValues with the oversized env values:
 * Studio's schema refuses such an entry for the whole file, so one odd service must not reach it.
 * Sorted by name; past LIMITS.services the rest is cut and `truncated` is set.
 * `excluded` names the apps DISCOVERY_EXCLUDE left out, sorted, once each and at most LIMITS.services of
 * them, so Studio can report them as skipped. The bound checks run first, so every name in it is 1 to
 * LIMITS.name characters long.
 */
export function selectServices(services, network, exclude) {
  const selected = [];
  const excluded = new Set();
  let droppedValues = 0;
  for (const service of Array.isArray(services) ? services : []) {
    const spec = service?.Spec;
    const name = spec?.Name;
    if (typeof service?.ID !== "string" || typeof name !== "string") continue;
    if (!attachmentOf(spec, network)) continue;
    if (name.startsWith(SYSTEM_SERVICE_PREFIX)) continue;
    const containerSpec = spec.TaskTemplate?.ContainerSpec;
    const image = typeof containerSpec?.Image === "string" ? containerSpec.Image : "";
    if (isStudioImage(image)) continue;
    const appName = appNameOf(name);
    const host = hostOf(spec, network);
    if (
      image === "" ||
      appName === "" ||
      name.length > LIMITS.name ||
      host.length > LIMITS.host ||
      image.length > LIMITS.image
    ) {
      droppedValues += 1;
      continue;
    }
    if (exclude.has(appName)) {
      excluded.add(appName);
      continue;
    }
    const projected = projectEnv(containerSpec?.Env, ENV_ALLOW_LIST);
    droppedValues += projected.dropped;
    selected.push({
      id: service.ID,
      name,
      appName,
      host,
      image,
      env: projected.env,
      requirepassEnv: requirepassEnvOf(containerSpec, ENV_ALLOW_LIST),
      tasks: {
        running: taskCount(service.ServiceStatus?.RunningTasks),
        desired: taskCount(service.ServiceStatus?.DesiredTasks),
      },
    });
  }
  selected.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return {
    services: selected.slice(0, LIMITS.services),
    excluded: [...excluded].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)).slice(0, LIMITS.services),
    droppedValues,
    truncated: selected.length > LIMITS.services,
  };
}

/** The status object as the export file carries it. */
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
 * The export file's content (version 1). `now` is the epoch milliseconds of this attempt; `generatedAt`
 * is the ISO time of the last successful listing, or null before the first, in which case no service and
 * no excluded app is exported whatever `services` and `excluded` hold. `excluded` is always written, right
 * after `services`, because Studio's schema requires it.
 */
export function buildExport({ now, network, services, excluded, status, generatedAt }) {
  return {
    version: 1,
    platform: "caprover",
    generatedAt,
    checkedAt: new Date(now).toISOString(),
    status: normalizeStatus(status),
    network: network ? { name: network.name, id: network.id } : null,
    services: generatedAt === null ? [] : services,
    excluded: generatedAt === null ? [] : excluded,
  };
}

/**
 * The status for a failed Docker call. HTTP answers keep their status: 503 is a node that is not a swarm
 * manager (or a locked swarm), with the daemon's message verbatim; 400 is an API version the daemon does
 * not serve. Socket errors name the likely cause, "not running as root" included.
 */
export function classifyDockerError(error) {
  const statusCode = error?.statusCode;
  if (Number.isInteger(statusCode)) {
    const message = clip(
      typeof error.message === "string" && error.message ? error.message : `Docker answered HTTP ${statusCode}`,
    );
    if (statusCode === 503) return { ok: false, code: "swarm_unavailable", httpStatus: statusCode, message };
    if (statusCode === 400) return { ok: false, code: "api_version", httpStatus: statusCode, message };
    return { ok: false, code: "docker_error", httpStatus: statusCode, message };
  }
  const code = typeof error?.code === "string" ? error.code : "";
  if (Object.hasOwn(SOCKET_HINTS, code)) {
    return { ok: false, code: "socket_unavailable", message: clip(`${SOCKET_HINTS[code]} (${describeError(error)})`) };
  }
  if (code === "ERESPONSETOOLARGE") return { ok: false, code: "limit_exceeded", message: clip(describeError(error)) };
  return { ok: false, code: "docker_error", message: clip(describeError(error)) };
}

const API_PREFIX = "/v1.44";

/** An Error carrying a Node-style `code`, which classifyDockerError reads. */
function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

/** The daemon's own `{"message": ...}` text, or a generic line when the body carries none. */
function daemonMessage(text, statusCode) {
  try {
    const body = JSON.parse(text);
    if (body && typeof body.message === "string" && body.message) return body.message;
  } catch {
    // Not JSON: the generic line below says what is known, without echoing an unknown body.
  }
  return `Docker answered HTTP ${statusCode}`;
}

/**
 * A GET-only Engine API client over the unix socket. node:http and not fetch: global fetch cannot use a
 * unix socket without undici. `agent: false` gives each request its own connection that closes with it,
 * so nothing keeps the process alive after the last scan. Each request is bounded in time (the whole
 * request, not idle time) and in body size. A non-2xx answer rejects with `statusCode` and the daemon's
 * message; a socket failure rejects with its errno `code`. `abort()` ends every request in flight, so a
 * signal never waits on the daemon.
 */
export function createDockerClient({ socket, request, timeoutMs, maxBytes } = {}) {
  const send = request ?? http.request;
  const budgetMs = timeoutMs ?? LIMITS.requestTimeoutMs;
  const cap = maxBytes ?? LIMITS.responseBytes;
  const inFlight = new Set();

  function get(path) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let outgoing = null;
      const timer = setTimeout(
        () => fail(codedError(`Docker did not answer GET ${path} within ${budgetMs} ms`, "ETIMEDOUT")),
        budgetMs,
      );
      const entry = { abort: () => fail(codedError(`GET ${path} aborted`, "EABORTED")) };
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
        const text = Buffer.concat(chunks).toString("utf8");
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(Object.assign(new Error(daemonMessage(text, statusCode)), { statusCode }));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(codedError(`Docker answered GET ${path} with a body that is not JSON`, "EBADJSON"));
        }
      }
      try {
        outgoing = send(
          { socketPath: socket, path, method: "GET", headers: { Host: "docker" }, agent: false },
          (response) => {
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
              size += chunk.length;
              if (size > cap) {
                fail(codedError(`Docker answered GET ${path} with more than ${cap} bytes`, "ERESPONSETOOLARGE"));
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
      outgoing.end();
    });
  }

  function abort() {
    for (const entry of [...inFlight]) entry.abort();
  }

  return { get, abort };
}

/** One listing: the network, then the services on it. Never throws; a failure comes back as a status. */
export async function scanOnce({ client, config }) {
  try {
    const filters = encodeURIComponent(JSON.stringify({ name: [config.network] }));
    const network = selectNetwork(await client.get(`${API_PREFIX}/networks?filters=${filters}`), config.network);
    if (!network) {
      return {
        ok: false,
        status: {
          ok: false,
          code: "network_not_found",
          message: clip(`no network is named exactly ${config.network}`),
        },
      };
    }
    const services = await client.get(`${API_PREFIX}/services?status=true`);
    if (!Array.isArray(services)) {
      return {
        ok: false,
        status: {
          ok: false,
          code: "docker_error",
          message: "Docker answered GET /services with something other than a list",
        },
      };
    }
    return { ok: true, network, ...selectServices(services, network, config.exclude) };
  } catch (error) {
    return { ok: false, status: classifyDockerError(error) };
  }
}

/**
 * The output directory must be a real directory owned by this process and not writable by group or
 * others. Otherwise the web process, or anyone else, could plant a link there for this root process to
 * follow, so the exporter writes nothing and exits. The images never create /app/discovery, so Docker
 * creates the named volume's root as root:root 0755, which passes.
 */
export function checkOutputDir(dir, { fs, uid }) {
  let stats;
  try {
    stats = fs.lstatSync(dir);
  } catch (error) {
    return { ok: false, reason: `cannot read the output directory ${dir}: ${describeError(error)}` };
  }
  if (!stats.isDirectory()) return { ok: false, reason: `${dir} is not a directory` };
  if (stats.uid !== uid) {
    return { ok: false, reason: `${dir} is owned by uid ${stats.uid}, not by this process (uid ${uid})` };
  }
  if ((stats.mode & 0o022) !== 0) {
    return { ok: false, reason: `${dir} is writable by group or others (mode ${(stats.mode & 0o777).toString(8)})` };
  }
  return { ok: true };
}

/** `<dir>/.<base>.tmp`, in the same directory so the rename is atomic. */
function tempPathOf(path) {
  return join(dirname(path), `.${basename(path)}.tmp`);
}

/** Run one write step; a failure is rethrown with the step's name first, which is what gets logged. */
function runStep(name, action) {
  try {
    return action();
  } catch (error) {
    throw new Error(`${name}: ${describeError(error)}`, { cause: error });
  }
}

const OPEN_FLAGS = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;

/**
 * Replace `path` with `data` atomically: unlink whatever sits at the temp path (a crash leftover or a
 * planted link), create the temp file with O_EXCL | O_NOFOLLOW and mode 0600, fchown it through the
 * descriptor, write, fsync, close, rename over `path`. On a failure the previous file stays in place,
 * the temp file is removed, and the error names the failing step.
 */
export function writeExportAtomic(path, data, { fs, uid, gid }) {
  const temp = tempPathOf(path);
  const leftover = runStep("lstat", () => {
    try {
      fs.lstatSync(temp);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  });
  if (leftover) runStep("unlink", () => fs.unlinkSync(temp));
  const fd = runStep("open", () => fs.openSync(temp, OPEN_FLAGS, 0o600));
  let open = true;
  try {
    runStep("fchown", () => fs.fchownSync(fd, uid, gid));
    runStep("write", () => fs.writeFileSync(fd, data, "utf8"));
    runStep("fsync", () => fs.fsyncSync(fd));
    open = false;
    runStep("close", () => fs.closeSync(fd));
    runStep("rename", () => fs.renameSync(temp, path));
  } catch (error) {
    // Cleanup only: the step error below is what gets reported, and the next scan unlinks any leftover.
    if (open) {
      try {
        fs.closeSync(fd);
      } catch {
        // The descriptor is unusable either way.
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // Already gone, or the next scan's leftover check removes it.
    }
    throw error;
  }
}

const LIMIT_STATUS_MESSAGE = `the export would exceed ${LIMITS.fileBytes} bytes; the rest was left out`;

/**
 * The file text, at most LIMITS.fileBytes bytes. Over the bound, services are kept in name order while
 * they fit, and an ok status becomes limit_exceeded; a status that is already an error keeps its code.
 * Only services are trimmed: every other field, the excluded list included (at most 500 names of at most
 * 63 characters), is kept whole and in place, and its size is taken out of the budget first.
 */
export function serializeExport(data) {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text, "utf8") <= LIMITS.fileBytes) return text;
  const status = data.status.ok ? { ok: false, code: "limit_exceeded", message: LIMIT_STATUS_MESSAGE } : data.status;
  let budget = LIMITS.fileBytes - Buffer.byteLength(JSON.stringify({ ...data, status, services: [] }), "utf8");
  const kept = [];
  for (const service of data.services) {
    const size = Buffer.byteLength(JSON.stringify(service), "utf8") + (kept.length > 0 ? 1 : 0);
    if (size > budget) break;
    budget -= size;
    kept.push(service);
  }
  return JSON.stringify({ ...data, status, services: kept });
}

const LOG_PREFIX = "libredb-discovery:";

/**
 * The one-line summary of a scan. A good scan logs counts only. A failed one logs its status code and
 * message: the daemon's own error text, a socket error or one of this file's fixed lines. The body of a
 * 2xx answer, where the environment values are, never reaches a message, so none reaches the log.
 */
function summarize(result) {
  if (!result.ok) return `scan failed: ${result.status.code}: ${result.status.message}`;
  const cut = result.truncated ? `, cut to the first ${LIMITS.services} by name` : "";
  return `scan ok: ${result.services.length} services exported, ${result.droppedValues} values dropped${cut}`;
}

/**
 * Entry point. Checks the output directory, then scans and writes every DISCOVERY_INTERVAL_MS until
 * SIGTERM or SIGINT. It runs as PID 1 in its container, where the kernel ignores a signal that has no
 * handler, so without these handlers a redeploy would wait for Swarm's SIGKILL. A write is synchronous,
 * so a signal can never land in the middle of one; a request in flight is aborted and its scan writes
 * nothing. With DISCOVERY_ONCE=1 it scans once and resolves 0 when the file was written, 1 when not.
 * Exit codes: 2 for a configuration it cannot honour, 1 for an output directory it must not use.
 * A failed scan keeps the last good services, excluded apps and generatedAt, and updates status and
 * checkedAt; a network_not_found scan also clears the network, because the file must say none matched.
 */
export async function main({ env, request, fs, now, stdout, stderr, signals } = {}) {
  const environment = env ?? process.env;
  const files = fs ?? nodeFs;
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
  const directory = checkOutputDir(dirname(config.output), { fs: files, uid: process.getuid?.() });
  if (!directory.ok) {
    warn(`refusing to start: ${directory.reason}`);
    return 1;
  }

  const client = createDockerClient({ socket: config.socket, request });
  const last = { generatedAt: null, network: null, services: [], excluded: [], summary: "" };
  let stopping = false;

  async function scanAndWrite() {
    const result = await scanOnce({ client, config });
    if (stopping) return false;
    const checkedAt = clock();
    let status = result.status;
    if (result.ok) {
      last.generatedAt = new Date(checkedAt).toISOString();
      last.network = result.network;
      last.services = result.services;
      last.excluded = result.excluded;
      status = result.truncated
        ? { ok: false, code: "limit_exceeded", message: `more than ${LIMITS.services} services on ${config.network}` }
        : { ok: true };
    } else if (result.status.code === "network_not_found") {
      // Spec section 8.5: network is null when no exact match was found; services, excluded and
      // generatedAt stay those of the last good scan.
      last.network = null;
    }
    const data = buildExport({
      now: checkedAt,
      network: last.network,
      services: last.services,
      excluded: last.excluded,
      status,
      generatedAt: last.generatedAt,
    });
    try {
      writeExportAtomic(config.output, serializeExport(data), { fs: files, uid: config.fileUid, gid: config.fileGid });
    } catch (error) {
      warn(`write failed at ${describeError(error)}`);
      return false;
    }
    const summary = summarize(result);
    if (summary !== last.summary) {
      last.summary = summary;
      if (result.ok) info(summary);
      else warn(summary);
    }
    return true;
  }

  info(`watching ${config.network} every ${config.intervalMs} ms, writing ${config.output}`);
  if (config.once) return (await scanAndWrite()) ? 0 : 1;

  return new Promise((resolve) => {
    let timer = null;
    function stop(signal) {
      stopping = true;
      clearTimeout(timer);
      events.removeListener("SIGTERM", onTerm);
      events.removeListener("SIGINT", onInt);
      client.abort();
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
      await scanAndWrite();
      if (!stopping) timer = setTimeout(loop, config.intervalMs);
    }
    events.once("SIGTERM", onTerm);
    events.once("SIGINT", onInt);
    loop();
  });
}

/**
 * Whether this module is the program being run, rather than an import. Copied from
 * docker/bind-address.mjs, not imported, so each file in /usr/local/lib/libredb-studio stands alone; the
 * reasons for realpath and pathToFileURL are in that file's docblock.
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
