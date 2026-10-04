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
