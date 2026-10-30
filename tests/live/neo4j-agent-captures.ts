/**
 * The capture harness of the Neo4j agent boundary: what three digest-pinned 5.26.31 servers answer each agent
 * principal, sent raw, with no Studio policy in front. `tests/fixtures/neo4j/5.26.31/agent-boundary/run.sh` starts the
 * servers and runs this script; it writes one directory per principal under that directory, one file per statement,
 * in the encoding of every other Neo4j capture (`tests/fixtures/neo4j/5.26.31/README.md`) plus a `principal`
 * sentence, so `recordedGraphClient` replays a principal's server from its directory.
 *
 * The servers: `enterprise`, a stock Enterprise server; `extension`, the same image with the test extension of
 * `extension/` in its plugins directory; `community`, the Community image with every database read-only. The
 * administrator's password arrives in the environment (NEO4J_ADMIN_PASSWORD); each user's password is generated here
 * for the run, and the script refuses to write a file that holds any of them.
 *
 * What it records, per principal: the five proof reads of `agent-boundary.ts`, `LOAD CSV` from `file:///` and from
 * the server's own HTTP port, writes in a READ session and in a WRITE session (the principal's own refusal, not the
 * session's), `CALL { } IN TRANSACTIONS`, `USE` of another database, a write procedure, the reader-executable
 * built-ins with a side effect, the test extension's procedure and function, and the comment and carriage return
 * forms of the agent's fence. On the stock server `PUBLIC` still holds `LOAD ON ALL DATA` when `reader` is captured,
 * then the administrator revokes it, as the provider doc tells an operator to. `widened` is captured, granted a role
 * holding LOAD, and captured again. The node counts of both databases and the extension's marker files are read
 * before and after into `state-before.json` and `state-after.json`.
 *
 * Run by `run.sh`, never by `bun run test` (tests/runner/discover.ts excludes tests/live/).
 */
// oxlint-disable no-await-in-loop -- captures run one at a time, so each answer is the server's to that statement alone.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import neo4j from "neo4j-driver-lite";
import { createBoltClient } from "@/lib/db/graph/bolt/bolt-client";
import { type GraphClient, GraphClientError } from "@/lib/db/graph/bolt/client";
import {
  NEO4J_AGENT_PROOF_ROW_BOUND,
  NEO4J_AGENT_PROOF_STATEMENTS,
} from "@/lib/db/providers/graph/neo4j/agent-boundary";
import { howItFailed } from "../helpers/spawn-outcome";

const ROOT = join(import.meta.dir, "..", "..");
const OUT = join(ROOT, "tests", "fixtures", "neo4j", "5.26.31", "agent-boundary");
const TIMEOUT_MS = 30_000;
const STATEMENT_ROWS = 100;
const DATABASE = "neo4j";
const USER_AGENT = "libredb-studio-agent-captures";
const KEPT: ReadonlySet<string> = new Set(["run.sh", "extension", "README.md"]);

const IMAGES = {
  enterprise: "neo4j:5.26.31-enterprise@sha256:02d30e0a80f0aaed71cfdfaa85c8ea01cf44aacd55510d4a2b4a53f9f1a2e1ad",
  extension: "neo4j:5.26.31-enterprise@sha256:02d30e0a80f0aaed71cfdfaa85c8ea01cf44aacd55510d4a2b4a53f9f1a2e1ad",
  community: "neo4j:5.26.31-community@sha256:d9cfe82983d27f5a75b3aaae8f316d04f9a698a3b7f6103a508f7caf8362f255",
} as const;
type Server = keyof typeof IMAGES;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const prefix = process.env.NEO4J_PREFIX ?? "libredb-agent-";
const ports: Record<Server, string> = {
  enterprise: required("NEO4J_EE_PORT"),
  extension: required("NEO4J_EXT_PORT"),
  community: required("NEO4J_CE_PORT"),
};
const containers: Record<Server, string> = {
  enterprise: `${prefix}neo4j-ee`,
  extension: `${prefix}neo4j-ext`,
  community: `${prefix}neo4j-ce`,
};
const adminPassword = required("NEO4J_ADMIN_PASSWORD");
const secrets: string[] = [adminPassword];

function password(): string {
  const value = randomBytes(16).toString("hex");
  secrets.push(value);
  return value;
}

/**
 * An administrator's statement through cypher-shell in the container, which must succeed. A database created a moment
 * ago may not be routable yet, so that one answer is retried for up to 30 seconds.
 */
function admin(server: Server, statement: string, database = "system"): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return adminOnce(server, statement, database);
    } catch (error) {
      if (attempt >= 30 || !String(error).includes("Unable to get a routing table")) throw error;
      Bun.sleepSync(1000);
    }
  }
}

function adminOnce(server: Server, statement: string, database: string): string {
  const out = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "NEO4J_USERNAME=neo4j",
      "-e",
      "NEO4J_PASSWORD",
      containers[server],
      "cypher-shell",
      "-d",
      database,
    ],
    { encoding: "utf8", input: statement, env: { ...process.env, NEO4J_PASSWORD: adminPassword } },
  );
  if (out.status !== 0)
    throw new Error(`admin ${statement.split(" ", 3).join(" ")} ${howItFailed(out)}: ${out.stderr}`);
  return out.stdout;
}

function containerHas(server: Server, path: string): boolean {
  return spawnSync("docker", ["exec", containers[server], "test", "-f", path]).status === 0;
}

function write(file: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  for (const secret of secrets) {
    if (text.includes(secret)) throw new Error(`${file} would hold a password; nothing was written`);
  }
  writeFileSync(file, text);
}

function errorOf(error: unknown): { category: string; code: string | null; message: string } {
  if (error instanceof GraphClientError) {
    return { category: error.category, code: error.code ?? null, message: error.message };
  }
  const fields = (error ?? {}) as { code?: unknown; message?: unknown };
  return {
    category: "query",
    code: typeof fields.code === "string" ? fields.code : null,
    message: typeof fields.message === "string" ? fields.message : String(error),
  };
}

interface Principal {
  readonly name: string;
  readonly server: Server;
  readonly user: string;
  readonly password: string;
  /** What the principal holds, as a capture states it. */
  readonly rights: string;
}

/** One principal's capture directory and its Bolt client, opened on its own driver. */
class Recorder {
  private readonly client: GraphClient;
  private readonly dir: string;
  private readonly names = new Set<string>();

  constructor(
    private readonly principal: Principal,
    directory: string = principal.name,
  ) {
    this.dir = join(OUT, directory);
    mkdirSync(this.dir, { recursive: true });
    this.client = createBoltClient({
      uri: `bolt://127.0.0.1:${ports[principal.server]}`,
      user: principal.user,
      password: principal.password,
      connectionTimeoutMs: TIMEOUT_MS,
      userAgent: USER_AGENT,
    });
  }

  private head(statement: string | undefined, maxRows: number | undefined) {
    return {
      $captured: {
        image: IMAGES[this.principal.server].split("@")[0],
        digest: IMAGES[this.principal.server].split("@")[1],
        date: new Date().toISOString(),
        database: statement === undefined ? null : DATABASE,
      },
      principal: `${this.principal.user}: ${this.principal.rights}`,
      ...(statement === undefined ? {} : { statement, options: { database: DATABASE, maxRows } }),
    };
  }

  async verify(): Promise<void> {
    write(join(this.dir, "verify.json"), {
      ...this.head(undefined, undefined),
      surface: "verify",
      outcome: "pass",
      result: await this.client.verify(),
    });
  }

  /** One statement in a READ session, as the provider sends it. */
  async capture(name: string, statement: string, maxRows = STATEMENT_ROWS): Promise<boolean> {
    if (this.names.has(name)) throw new Error(`two captures named ${name} for ${this.principal.name}`);
    this.names.add(name);
    const file = join(this.dir, `${name}.json`);
    try {
      const result = await this.client.run(statement, { database: DATABASE, timeoutMs: TIMEOUT_MS, maxRows });
      write(file, { ...this.head(statement, maxRows), outcome: "pass", result });
      return true;
    } catch (error) {
      write(file, { ...this.head(statement, maxRows), outcome: "fail", error: errorOf(error) });
      return false;
    }
  }

  /** The five proof reads, under the proof's own row bound. */
  async proof(): Promise<void> {
    const reads = NEO4J_AGENT_PROOF_STATEMENTS;
    await this.capture("proof-components", reads.components, NEO4J_AGENT_PROOF_ROW_BOUND);
    await this.capture("proof-current-user", reads.currentUser, NEO4J_AGENT_PROOF_ROW_BOUND);
    await this.capture("proof-privileges", reads.privileges, NEO4J_AGENT_PROOF_ROW_BOUND);
    await this.capture("proof-procedures", reads.procedures, NEO4J_AGENT_PROOF_ROW_BOUND);
    await this.capture("proof-functions", reads.functions, NEO4J_AGENT_PROOF_ROW_BOUND);
  }

  /**
   * One statement in a WRITE session on a driver of its own, outside the Bolt client: what the principal itself is
   * refused when the session does not stop the write first. Recorded in the same encoding, under `write-session/`, where no replay reads it.
   */
  async writeSession(name: string, statement: string): Promise<void> {
    mkdirSync(join(this.dir, "write-session"), { recursive: true });
    const file = join(this.dir, "write-session", `${name}.json`);
    const driver = neo4j.driver(
      `bolt://127.0.0.1:${ports[this.principal.server]}`,
      neo4j.auth.basic(this.principal.user, this.principal.password),
      { userAgent: USER_AGENT, telemetryDisabled: true, maxTransactionRetryTime: 0 },
    );
    const session = driver.session({ database: DATABASE, defaultAccessMode: neo4j.session.WRITE });
    const head = { ...this.head(statement, STATEMENT_ROWS), session: "WRITE" };
    try {
      const result = await session.run(statement);
      write(file, {
        ...head,
        outcome: "pass",
        result: {
          fields: result.records[0]?.keys ?? [],
          rows: result.records.length,
          counters: result.summary.counters.updates(),
        },
      });
    } catch (error) {
      write(file, { ...head, outcome: "fail", error: errorOf(error) });
    } finally {
      await session.close();
      await driver.close();
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** What a READ session refuses or answers, past Studio's policy: each the boundary must hold without the fence. */
const BOUNDARY_STATEMENTS: readonly (readonly [string, string])[] = [
  ["load-csv-file", "LOAD CSV FROM 'file:///probe.csv' AS row RETURN row"],
  ["load-csv-http", "LOAD CSV FROM 'http://127.0.0.1:7474/' AS row RETURN count(row) AS lines"],
  ["load-csv-lower-case", "load csv from 'file:///probe.csv' as row return row"],
  ["load-csv-after-with", "WITH 'file:///probe.csv' AS url LOAD CSV FROM url AS row RETURN row"],
  ["load-csv-in-call", "CALL { LOAD CSV FROM 'file:///probe.csv' AS row RETURN row } RETURN row"],
  ["create", "CREATE (:LibredbProbe {at: 1})"],
  ["merge", "MERGE (:LibredbProbe {at: 2})"],
  ["set", "MATCH (n:Person) SET n.libredbProbe = 1"],
  ["delete", "MATCH (n:Person) DETACH DELETE n"],
  ["call-in-transactions", "UNWIND [1] AS x CALL { WITH x CREATE (:LibredbProbe {at: x}) } IN TRANSACTIONS RETURN x"],
  ["use-other", "USE other MATCH (n) RETURN count(n) AS n"],
  ["call-create-label", "CALL db.createLabel('LibredbProbe')"],
  ["call-checkpoint", "CALL db.checkpoint()"],
  ["call-resample-outdated-indexes", "CALL db.resampleOutdatedIndexes()"],
  ["call-set-config", "CALL dbms.setConfigValue('db.logs.query.enabled', 'OFF')"],
  ["call-set-metadata", "CALL tx.setMetaData({probe: 1})"],
  ["read", "MATCH (n:Person) RETURN n.name AS name ORDER BY name"],
];

/** The comment and line-break forms the agent's fence reads: one column to a reader that runs the comment on. */
const FENCE_STATEMENTS: readonly (readonly [string, string])[] = [
  ["fence-line-comment-lf", "RETURN 1 AS x // c\n, 2 AS y"],
  ["fence-line-comment-lone-cr", "RETURN 1 AS x // c\r, 2 AS y"],
  ["fence-line-comment-crlf", "RETURN 1 AS x // c\r\n, 2 AS y"],
  ["fence-line-comment-u2028", "RETURN 1 AS x // c , 2 AS y"],
  ["fence-line-comment-u0085", "RETURN 1 AS x // c\u0085, 2 AS y"],
  ["fence-block-comment", "RETURN 1 AS x /* c */, 2 AS y"],
  ["fence-block-comment-nested", "RETURN 1 AS x /* a /* b */, 2 AS y /* c */"],
  ["fence-block-comment-holding-cr", "RETURN 1 AS x /* c\r */, 2 AS y"],
  ["fence-lone-cr-between-tokens", "RETURN 1 AS x,\r2 AS y"],
];

const EXTENSION_STATEMENTS: readonly (readonly [string, string])[] = [
  ["call-extension-procedure", "CALL libredbtest.touch()"],
  ["call-extension-function", "RETURN libredbtest.touchFn() AS path"],
];

async function state(server: Server): Promise<unknown> {
  const count = (database: string) =>
    admin(server, "MATCH (n) RETURN count(n) AS n;", database).trim().split("\n").at(-1);
  return {
    server,
    nodes: { neo4j: count("neo4j"), other: server === "community" ? null : count("other") },
    markers:
      server === "extension"
        ? {
            procedure: containerHas(server, "/tmp/libredbtest-procedure"),
            function: containerHas(server, "/tmp/libredbtest-function"),
          }
        : null,
  };
}

function user(server: Server, name: string, rights: string, roles: readonly string[]): Principal {
  const secret = password();
  admin(server, `CREATE USER ${name} SET PASSWORD '${secret}' CHANGE NOT REQUIRED;`);
  for (const role of roles) admin(server, `GRANT ROLE ${role} TO ${name};`);
  return { name, server, user: name, password: secret, rights };
}

async function capturePrincipal(principal: Principal, statements: readonly (readonly [string, string])[] = []) {
  const recorder = new Recorder(principal);
  try {
    await recorder.verify();
    await recorder.proof();
    for (const [name, statement] of statements) await recorder.capture(name, statement);
  } finally {
    await recorder.close();
  }
}

async function capture(): Promise<void> {
  // Every earlier capture goes; run.sh, the extension's source and the README stay.
  for (const entry of readdirSync(OUT)) {
    if (!KEPT.has(entry)) rmSync(join(OUT, entry), { recursive: true, force: true });
  }

  // The seed: a second database and a few nodes in each, and the file LOAD CSV reads.
  for (const server of ["enterprise", "extension"] as const) {
    admin(server, "CREATE DATABASE other IF NOT EXISTS WAIT;");
    admin(server, "CREATE (:Person {name: 'Ada'})-[:KNOWS]->(:Person {name: 'Bob'});", "neo4j");
    admin(server, "CREATE (:Elsewhere {name: 'other'});", "other");
    admin(server, "CREATE ROLE agent_reader IF NOT EXISTS AS COPY OF reader;");
  }
  write(join(OUT, "state-before.json"), [
    await state("enterprise"),
    await state("extension"),
    await state("community"),
  ]);

  // The stock server, PUBLIC still holding LOAD ON ALL DATA: the role `reader` alone.
  const enterprise = "enterprise" as const;
  admin(enterprise, "CREATE ROLE csv_loader IF NOT EXISTS;");
  admin(enterprise, "GRANT LOAD ON ALL DATA TO csv_loader;");
  admin(enterprise, "CREATE ROLE cidr_loader IF NOT EXISTS;");
  admin(enterprise, "GRANT LOAD ON CIDR '10.0.0.0/8' TO cidr_loader;");
  admin(enterprise, "CREATE ROLE no_load IF NOT EXISTS;");
  admin(enterprise, "DENY LOAD ON ALL DATA TO no_load;");
  admin(enterprise, "CREATE ROLE boosted IF NOT EXISTS;");
  admin(enterprise, "GRANT EXECUTE BOOSTED PROCEDURE * ON DBMS TO boosted;");
  const reader = user(enterprise, "reader_stock", "role reader, PUBLIC holding LOAD ON ALL DATA", ["reader"]);
  await capturePrincipal(reader, BOUNDARY_STATEMENTS.slice(0, 2));

  // What the provider doc tells an operator: revoke LOAD from PUBLIC.
  admin(enterprise, "REVOKE GRANT LOAD ON ALL DATA FROM PUBLIC;");
  const agent = user(enterprise, "agent", "role agent_reader (a copy of reader), PUBLIC's LOAD revoked", [
    "agent_reader",
  ]);
  await capturePrincipal(agent, [...BOUNDARY_STATEMENTS, ...FENCE_STATEMENTS]);
  const agentWrites = new Recorder(agent);
  for (const [name, statement] of BOUNDARY_STATEMENTS.slice(5, 10)) await agentWrites.writeSession(name, statement);
  await agentWrites.close();

  const roles: readonly [string, string, readonly string[], boolean][] = [
    ["loader", "agent_reader and csv_loader (GRANT LOAD ON ALL DATA)", ["agent_reader", "csv_loader"], true],
    ["cidr", "agent_reader and cidr_loader (GRANT LOAD ON CIDR 10.0.0.0/8)", ["agent_reader", "cidr_loader"], false],
    [
      "denied",
      "agent_reader, csv_loader and no_load (DENY LOAD ON ALL DATA)",
      ["agent_reader", "csv_loader", "no_load"],
      true,
    ],
    ["editor", "role editor", ["editor"], false],
    ["boosted", "agent_reader and boosted (GRANT EXECUTE BOOSTED PROCEDURE *)", ["agent_reader", "boosted"], false],
  ];
  for (const [name, rights, granted, loads] of roles) {
    const principal = user(enterprise, name, rights, granted);
    await capturePrincipal(principal, loads ? BOUNDARY_STATEMENTS.slice(0, 1) : []);
    if (name === "editor") {
      const writes = new Recorder(principal);
      await writes.writeSession("create", "CREATE (:LibredbProbe {at: 3}) RETURN 1 AS created");
      await writes.close();
      admin(enterprise, "MATCH (n:LibredbProbe) DELETE n;", "neo4j");
    }
  }
  const administrator: Principal = {
    name: "admin",
    server: enterprise,
    user: "neo4j",
    password: adminPassword,
    rights: "role admin",
  };
  await capturePrincipal(administrator, [["show-procedures-all", "SHOW PROCEDURES YIELD name"]]);
  const all = new Recorder(administrator);
  await all.capture("show-functions-all", "SHOW FUNCTIONS YIELD name", NEO4J_AGENT_PROOF_ROW_BOUND);
  await all.close();

  // Privileges widened after acquisition: captured, granted a role holding LOAD, captured again.
  const widened = user(enterprise, "widened", "role agent_reader, then also csv_loader", ["agent_reader"]);
  const before = new Recorder(widened, "widened-before");
  await before.verify();
  await before.proof();
  await before.close();
  admin(enterprise, "GRANT ROLE csv_loader TO widened;");
  const after = new Recorder(
    { ...widened, rights: "role agent_reader and csv_loader, granted after the first proof" },
    "widened-after",
  );
  await after.verify();
  await after.proof();
  await after.capture("load-csv-file", BOUNDARY_STATEMENTS[0][1]);
  await after.close();

  // The server with the test extension: a reader, and a reader denied the extension's procedure and function.
  const extension = "extension" as const;
  admin(extension, "REVOKE GRANT LOAD ON ALL DATA FROM PUBLIC;");
  admin(extension, "CREATE ROLE no_extension IF NOT EXISTS;");
  admin(extension, "DENY EXECUTE PROCEDURE libredbtest.* ON DBMS TO no_extension;");
  admin(extension, "DENY EXECUTE USER DEFINED FUNCTION libredbtest.* ON DBMS TO no_extension;");
  const extensionDenied = user(extension, "ext_denied", "agent_reader and no_extension (DENY EXECUTE libredbtest.*)", [
    "agent_reader",
    "no_extension",
  ]);
  await capturePrincipal(extensionDenied, EXTENSION_STATEMENTS);
  const extensionAgent = user(extension, "ext_agent", "role agent_reader on a server with the test extension", [
    "agent_reader",
  ]);
  await capturePrincipal(extensionAgent, EXTENSION_STATEMENTS);

  // Community: one user, implied administrator, every database read-only.
  const community: Principal = {
    name: "community",
    server: "community",
    user: "neo4j",
    password: adminPassword,
    rights: "the only user of Community Edition, every database read-only",
  };
  await capturePrincipal(community, BOUNDARY_STATEMENTS.slice(0, 2).concat([BOUNDARY_STATEMENTS[5]]));
  const communityWrites = new Recorder(community);
  await communityWrites.writeSession("create", BOUNDARY_STATEMENTS[5][1]);
  await communityWrites.close();

  write(join(OUT, "state-after.json"), [await state("enterprise"), await state("extension"), await state("community")]);
}

await capture();
