import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { composeService, dockerRunArgs, ENGINE_LIMITS, RUN_LABEL, waitForTcp } from "../integration/containers";

const compose = readFileSync(join(__dirname, "..", "..", "..", "database-compose.yml"), "utf8");

describe("the integration leg's containers", () => {
  it("reads PostgreSQL's image, environment and port from database-compose.yml", () => {
    assert.deepEqual(composeService("postgres", compose), {
      image: "postgres:18",
      environment: { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "postgres", POSTGRES_DB: "postgres" },
      containerPort: 5432,
    });
  });

  it("reads SQL Server's port and EULA acceptance, and MongoDB's image by digest", () => {
    const mssql = composeService("mssql", compose);
    assert.equal(mssql.containerPort, 1433);
    assert.equal(mssql.environment.ACCEPT_EULA, "Y");
    assert.ok(composeService("mongodb", compose).image.startsWith("mongo:9.0.4@sha256:"));
    assert.equal(composeService("mysql", compose).containerPort, 3306);
  });

  it("refuses a service the file lacks, one that publishes no port, and an environment that is not a map of strings", () => {
    assert.throws(() => composeService("mysql", "services:\n  postgres:\n    image: postgres:18\n"), {
      message: "database-compose.yml has no mysql service.",
    });
    assert.throws(() => composeService("postgres", "services:\n  postgres:\n    image: postgres:18\n"), {
      message: "database-compose.yml's postgres service publishes no port.",
    });
    assert.throws(
      () =>
        composeService(
          "postgres",
          "services:\n  postgres:\n    image: postgres:18\n    environment:\n      - A=b\n    ports:\n      - 5432:5432\n",
        ),
      {
        message:
          "database-compose.yml's postgres service sets its environment as something other than a map of strings.",
      },
    );
  });

  it("starts each container detached, removed on stop, labelled with the run, capped and bound to loopback", () => {
    assert.equal(RUN_LABEL, "org.libredb.vscode-extension.integration");
    assert.deepEqual(dockerRunArgs("postgres", composeService("postgres", compose), "77-1"), [
      "run",
      "-d",
      "--rm",
      "--label",
      "org.libredb.vscode-extension.integration=77-1",
      "--cpus",
      "1",
      "--memory",
      "512m",
      "-p",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_USER=postgres",
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-e",
      "POSTGRES_DB=postgres",
      "postgres:18",
    ]);
  });

  it("caps each engine for a shared machine, SQL Server's own memory limit below its container's", () => {
    assert.deepEqual(ENGINE_LIMITS, {
      postgres: { cpus: "1", memory: "512m", environment: {} },
      mssql: { cpus: "2", memory: "2g", environment: { MSSQL_MEMORY_LIMIT_MB: "1536" } },
      mysql: { cpus: "1", memory: "1g", environment: {} },
      mongodb: { cpus: "1", memory: "1g", environment: {} },
    });
    const args = dockerRunArgs("mssql", composeService("mssql", compose), "77-1");
    assert.deepEqual(args.slice(5, 11), ["--cpus", "2", "--memory", "2g", "-p", "127.0.0.1::1433"]);
    assert.deepEqual(args.slice(-3), [
      "-e",
      "MSSQL_MEMORY_LIMIT_MB=1536",
      "mcr.microsoft.com/mssql/server:2022-latest",
    ]);
  });

  it("waits for a port that accepts, and names the address when nothing does by the deadline", async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    await waitForTcp("127.0.0.1", port, 2000);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await assert.rejects(waitForTcp("127.0.0.1", port, 300), {
      message: `Nothing accepted a TCP connection on 127.0.0.1:${port} within 300 ms.`,
    });
  });
});
