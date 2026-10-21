// The database containers of the integration and e2e legs (part 5, "Integration leg"): each engine's image and
// environment come from the repository's database-compose.yml, so the legs and the dev stack cannot drift.
// Every container carries RUN_LABEL with its run's id and is removed by its own id, never by label or name: another
// worktree's run may be live on the same machine.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);

/** database-compose.yml's service names. */
export type EngineService = "postgres" | "mssql" | "mysql" | "mongodb";

export interface EngineLimits {
  cpus: string;
  memory: string;
  /** Variables beside the compose file's that keep the engine inside its container's memory. */
  environment: Readonly<Record<string, string>>;
}

/**
 * CPU and memory caps per container, since the machine is shared.
 * SQL Server sizes its memory from the host rather than from its container, so MSSQL_MEMORY_LIMIT_MB keeps it below
 * its 2 GB cap; the image refuses to start below 2,000 MB, and the compose file caps it at 4 CPUs and 4G.
 */
export const ENGINE_LIMITS: Readonly<Record<EngineService, EngineLimits>> = {
  postgres: { cpus: "1", memory: "512m", environment: {} },
  mssql: { cpus: "2", memory: "2g", environment: { MSSQL_MEMORY_LIMIT_MB: "1536" } },
  mysql: { cpus: "1", memory: "1g", environment: {} },
  mongodb: { cpus: "1", memory: "1g", environment: {} },
};

export const RUN_LABEL = "org.libredb.vscode-extension.integration";

/** How long an engine has to accept TCP, and then a login, from its docker run. */
export const START_DEADLINE_MS = 180_000;

export interface ComposeService {
  image: string;
  environment: Readonly<Record<string, string>>;
  containerPort: number;
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The image, environment and first published container port of one database-compose.yml service. */
export function composeService(name: EngineService, composeYaml: string): ComposeService {
  const services: unknown = (parse(composeYaml) as { services?: unknown } | null)?.services;
  const service = isMap(services) ? services[name] : undefined;
  if (!isMap(service)) throw new Error(`database-compose.yml has no ${name} service.`);
  const { image, environment = {}, ports } = service;
  if (typeof image !== "string") throw new Error(`database-compose.yml's ${name} service names no image.`);
  if (!isMap(environment) || !Object.values(environment).every((value) => typeof value === "string")) {
    throw new Error(
      `database-compose.yml's ${name} service sets its environment as something other than a map of strings.`,
    );
  }
  if (!Array.isArray(ports) || ports.length === 0) {
    throw new Error(`database-compose.yml's ${name} service publishes no port.`);
  }
  const published = String(ports[0]);
  const containerPort = /(\d+)(\/tcp)?$/.exec(published)?.[1];
  if (containerPort === undefined) {
    throw new Error(`database-compose.yml's ${name} service publishes "${published}", which names no container port.`);
  }
  return { image, environment: environment as Record<string, string>, containerPort: Number(containerPort) };
}

/** `docker run` for one engine: detached, removed once stopped, labelled with the run, capped, on a loopback port. */
export function dockerRunArgs(name: EngineService, service: ComposeService, runId: string): string[] {
  const { cpus, memory, environment } = ENGINE_LIMITS[name];
  const variables = Object.entries({ ...service.environment, ...environment }).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);
  return [
    "run",
    "-d",
    "--rm",
    "--label",
    `${RUN_LABEL}=${runId}`,
    "--cpus",
    cpus,
    "--memory",
    memory,
    "-p",
    `127.0.0.1::${service.containerPort}`,
    ...variables,
    service.image,
  ];
}

export interface RunningEngine {
  service: EngineService;
  containerId: string;
  host: "127.0.0.1";
  port: number;
  environment: Readonly<Record<string, string>>;
}

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** Resolves once something accepts a TCP connection on host:port, polling until deadlineMs have passed. */
export async function waitForTcp(host: string, port: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const accepted = await new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      // A dial that neither connects nor fails ends with the deadline.
      socket.setTimeout(Math.max(1, deadline - Date.now()), () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (accepted) return;
    if (Date.now() >= deadline) {
      throw new Error(`Nothing accepted a TCP connection on ${host}:${port} within ${deadlineMs} ms.`);
    }
    await delay(100);
  }
}

/**
 * Starts one engine from database-compose.yml, which lies beside the extension's directory, and resolves once its
 * loopback port accepts TCP. The extension root is a parameter because the e2e leg runs this module bundled into
 * out/test/e2e/, so no path relative to the module's own directory holds in both legs.
 */
export async function startEngine(name: EngineService, runId: string, extensionRoot: string): Promise<RunningEngine> {
  const started = Date.now();
  const service = composeService(name, readFileSync(join(extensionRoot, "..", "database-compose.yml"), "utf8"));
  const containerId = await docker(dockerRunArgs(name, service, runId));
  try {
    const published = await docker(["port", containerId, `${service.containerPort}/tcp`]);
    const port = Number(/:(\d+)$/m.exec(published)?.[1]);
    if (!Number.isInteger(port)) throw new Error(`docker port answered "${published}" for ${name}'s container.`);
    await waitForTcp("127.0.0.1", port, START_DEADLINE_MS);
    console.log(`${name}: ${service.image} listening on 127.0.0.1:${port} after ${Date.now() - started} ms`);
    return { service: name, containerId, host: "127.0.0.1", port, environment: service.environment };
  } catch (error) {
    await docker(["rm", "-f", containerId]);
    throw error;
  }
}

/** Removes the engine's container by its id. */
export async function stopEngine(engine: RunningEngine): Promise<void> {
  await docker(["rm", "-f", engine.containerId]);
}

/** docker exec <id> psql -U <POSTGRES_USER> -d <POSTGRES_DB> -tAc <sql>: an independent session the child does not own. */
export async function psql(engine: RunningEngine, sql: string): Promise<string> {
  if (engine.service !== "postgres") throw new Error(`psql runs in the postgres container, not in ${engine.service}.`);
  const { POSTGRES_USER, POSTGRES_DB } = engine.environment;
  return await docker(["exec", engine.containerId, "psql", "-U", POSTGRES_USER, "-d", POSTGRES_DB, "-tAc", sql]);
}
