/**
 * The hand-run Spark live tools' inputs: the variables tests/helpers/spark-live.ts reads, each refused with
 * exit code 2 before any socket, naming the variable and never its value; the mask every printed line passes; the
 * compose fixture's four services as pinned; and docker/spark/make-certs.sh, which writes the proxy's throwaway
 * certificates outside the repository.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  maskSparkLive,
  readSparkLiveArguments,
  type SparkLiveArguments,
  sparkLiveSecrets,
} from "../../../helpers/spark-live";
import { describeIf, MISSING_POSIX_FILE_MODES, missingPosixShell, posixShell } from "../../../helpers/posix-tools";

const ROOT = path.resolve(import.meta.dir, "../../../..");
// 27 characters, a multiple of 3, so its base64 carries no `=` padding and masks whole.
const TOKEN = "studio-live-token-012345678";
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function tlsDir(files: readonly string[] = ["ca.pem", "server.pem", "server.key"]): string {
  const directory = mkdtempSync(path.join(tmpdir(), "spark-tls-"));
  temporary.push(directory);
  for (const file of files) writeFileSync(path.join(directory, file), "test material\n");
  return directory;
}
function environment(overrides: Readonly<Record<string, string | undefined>> = {}) {
  return {
    SPARK_CONNECT_TOKEN: TOKEN,
    SPARK_TLS_DIR: tlsDir(),
    SPARK_LIVE_TARGET: "127.0.0.1:15002",
    SPARK_LIVE_TARGET_41: "127.0.0.1:15003",
    SPARK_LIVE_TARGET_AUTH: "127.0.0.1:15004",
    SPARK_LIVE_TARGET_TLS: "127.0.0.1:15005",
    SPARK_LIVE_UI: "http://127.0.0.1:4040",
    SPARK_LIVE_UI_41: "http://127.0.0.1:4041",
    ...overrides,
  };
}

describe("readSparkLiveArguments", () => {
  test("reads every variable into the four targets and the two driver UIs", () => {
    const env = environment();
    const args = readSparkLiveArguments(env) as SparkLiveArguments;
    expect(args).toEqual({
      token: TOKEN,
      tlsDir: env.SPARK_TLS_DIR as string,
      targets: {
        spark: { host: "127.0.0.1", port: 15002 },
        "spark-4-1": { host: "127.0.0.1", port: 15003 },
        "spark-auth": { host: "127.0.0.1", port: 15004 },
        "spark-tls": { host: "127.0.0.1", port: 15005 },
      },
      driverUi: { spark: "http://127.0.0.1:4040", "spark-4-1": "http://127.0.0.1:4041" },
    });
  });

  test.each([
    "SPARK_CONNECT_TOKEN",
    "SPARK_TLS_DIR",
    "SPARK_LIVE_TARGET",
    "SPARK_LIVE_TARGET_41",
    "SPARK_LIVE_TARGET_AUTH",
    "SPARK_LIVE_TARGET_TLS",
    "SPARK_LIVE_UI",
    "SPARK_LIVE_UI_41",
  ])("%s unset or blank is refused with exit code 2, naming it", (name) => {
    for (const value of [undefined, "", "   "]) {
      expect(readSparkLiveArguments(environment({ [name]: value }))).toEqual({
        exitCode: 2,
        message: `${name} is not set; nothing was sent.`,
      });
    }
  });

  test("a token that is short or holds a character a header cannot carry is refused without repeating it", () => {
    for (const token of ["short", `${TOKEN}\n`, `${TOKEN} x`]) {
      const refusal = readSparkLiveArguments(environment({ SPARK_CONNECT_TOKEN: token }));
      expect(refusal).toEqual({
        exitCode: 2,
        message:
          "SPARK_CONNECT_TOKEN must be 16 to 256 letters, digits or the characters . _ ~ + / = -; nothing was sent.",
      });
    }
  });

  test("a TLS directory that is relative, inside the repository or without ca.pem is refused", () => {
    const outside =
      "SPARK_TLS_DIR must be an absolute directory outside the repository that holds ca.pem, server.pem and server.key; nothing was sent.";
    for (const dir of ["relative/certs", path.join(ROOT, "docker", "spark"), tlsDir(["server.pem", "server.key"])]) {
      expect(readSparkLiveArguments(environment({ SPARK_TLS_DIR: dir }))).toEqual({ exitCode: 2, message: outside });
    }
  });

  test("a target that is not a loopback host and port is refused, since the tools reach local fixtures only", () => {
    for (const target of [
      "spark.example.com:15002",
      "10.0.0.5:15002",
      "127.0.0.1",
      "127.0.0.1:0",
      "127.0.0.1:70000",
      "http://127.0.0.1:15002",
    ]) {
      expect(readSparkLiveArguments(environment({ SPARK_LIVE_TARGET_AUTH: target }))).toEqual({
        exitCode: 2,
        message: "SPARK_LIVE_TARGET_AUTH must be a loopback host and port such as 127.0.0.1:15004; nothing was sent.",
      });
    }
    const args = readSparkLiveArguments(
      environment({ SPARK_LIVE_TARGET: "localhost:15002", SPARK_LIVE_TARGET_41: "[::1]:15003" }),
    ) as SparkLiveArguments;
    expect(args.targets.spark).toEqual({ host: "localhost", port: 15002 });
    expect(args.targets["spark-4-1"]).toEqual({ host: "::1", port: 15003 });
  });

  test("a driver UI that is not http on a loopback host with no path is refused", () => {
    for (const ui of [
      "https://127.0.0.1:4040",
      "http://spark.example.com:4040",
      "http://127.0.0.1:4040/jobs",
      "127.0.0.1:4040",
    ]) {
      expect(readSparkLiveArguments(environment({ SPARK_LIVE_UI_41: ui }))).toEqual({
        exitCode: 2,
        message:
          "SPARK_LIVE_UI_41 must be http:// on a loopback host and port with no path, such as http://127.0.0.1:4041; nothing was sent.",
      });
    }
  });
});

describe("the mask", () => {
  test("the secrets are the token's forms, and every one is masked in a printed line", () => {
    const args = readSparkLiveArguments(environment()) as SparkLiveArguments;
    const secrets = sparkLiveSecrets(args);
    expect(secrets).toContain(TOKEN);
    expect(secrets).toContain(Buffer.from(TOKEN).toString("base64").replace(/=+$/, ""));
    const line = `authorization: Bearer ${TOKEN}; echoed ${Buffer.from(TOKEN).toString("base64")}`;
    const masked = maskSparkLive(line, secrets);
    expect(masked).not.toContain(TOKEN);
    expect(masked).toBe("authorization: Bearer <masked>; echoed <masked>");
    expect(maskSparkLive("nothing secret", secrets)).toBe("nothing secret");
    expect(maskSparkLive("kept", ["", "x".repeat(0)])).toBe("kept");
  });
});

/** The lines of one top-level service of database-compose.yml, from its key to the next service key. */
function serviceBlock(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`database-compose.yml has no service ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z0-9-]+:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("the compose fixture", () => {
  const compose = readFileSync(path.join(ROOT, "database-compose.yml"), "utf8");
  const SPARK_42 = "apache/spark:4.2.0@sha256:fc64959c04bd87b0ac686be9aaa9008b69cdb1afc695400528279c8b01f43d89";
  const SPARK_413 = "apache/spark:4.1.3@sha256:bf9d035a7c32a8ca46aa58d6348182ffd7d2dff6409206ecfbb3915ff1fef211";
  const NGINX =
    "public.ecr.aws/docker/library/nginx:stable-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94";

  test.each([
    ["spark", SPARK_42, ['"127.0.0.1:15002:15002"', '"127.0.0.1:4040:4040"'], undefined],
    ["spark-4-1", SPARK_413, ['"127.0.0.1:15003:15002"', '"127.0.0.1:4041:4040"'], "spark-4-1"],
    ["spark-auth", SPARK_42, ['"127.0.0.1:15004:15002"'], "spark-auth"],
    ["spark-tls", NGINX, ['"127.0.0.1:15005:15005"'], "spark-auth"],
  ] as const)("%s runs its pinned image on 127.0.0.1 ports", (name, image, ports, profile) => {
    const block = serviceBlock(compose, name);
    expect(block).toContain(`    image: ${image}`);
    expect(block).toContain(`    container_name: libredb-${name}`);
    for (const port of ports) expect(block).toContain(`      - ${port}`);
    expect(block).toContain("    mem_limit:");
    if (profile === undefined) expect(block).not.toContain("profiles:");
    else expect(block).toContain(`    profiles: ["${profile}"]`);
  });

  test("the three Spark servers start in the foreground with an init process, a 2g driver and the unloaded catalog", () => {
    for (const name of ["spark", "spark-4-1", "spark-auth"]) {
      const block = serviceBlock(compose, name);
      expect(block).toContain("    init: true");
      expect(block).toContain("    mem_limit: 4g");
      expect(block).toContain("/opt/spark/sbin/start-connect-server.sh --wait --master local[4] --driver-memory 2g");
      expect(block).toContain(
        "--conf spark.sql.catalog.studio_unloaded=org.apache.spark.sql.execution.datasources.v2.jdbc.JDBCTableCatalog",
      );
    }
    expect(serviceBlock(compose, "spark-auth")).toContain("--conf spark.driver.maxResultSize=4m");
    expect(serviceBlock(compose, "spark-auth")).toContain("--conf spark.connect.grpc.arrow.maxBatchSize=1m");
    for (const name of ["spark", "spark-4-1"]) {
      expect(serviceBlock(compose, name)).not.toContain("maxResultSize");
      expect(serviceBlock(compose, name)).not.toContain("maxBatchSize");
    }
  });

  test("no Spark service needs a variable to parse, and none holds a token-shaped literal", () => {
    const blocks = ["spark", "spark-4-1", "spark-auth", "spark-tls"]
      .map((name) => serviceBlock(compose, name))
      .join("\n");
    // A ${VAR:?...} anywhere makes every docker compose command on the file fail without VAR (measured, Compose v5.6.0).
    expect(blocks).not.toContain(":?");
    expect(serviceBlock(compose, "spark-auth")).toContain("SPARK_CONNECT_AUTHENTICATE_TOKEN: ${SPARK_CONNECT_TOKEN:-}");
    expect(serviceBlock(compose, "spark-tls")).toContain("source: ${SPARK_TLS_DIR:-/nonexistent/set-SPARK_TLS_DIR}");
    expect(serviceBlock(compose, "spark-tls")).toContain("create_host_path: false");
    expect(serviceBlock(compose, "spark-tls")).toContain("./docker/spark/nginx.conf:/etc/nginx/nginx.conf:ro");
  });

  test("the proxy terminates TLS with HTTP/2, passes gRPC to spark-auth and allows a 300 s silent stream", () => {
    const conf = readFileSync(path.join(ROOT, "docker", "spark", "nginx.conf"), "utf8");
    for (const line of [
      "listen 15005 ssl;",
      "http2 on;",
      "ssl_certificate /etc/nginx/certs/server.pem;",
      "ssl_certificate_key /etc/nginx/certs/server.key;",
      "grpc_read_timeout 300s;",
      "grpc_send_timeout 300s;",
      "grpc_pass grpc://spark-auth:15002;",
    ]) {
      expect(conf).toContain(line);
    }
  });
});

// The script resolves POSIX paths and sets POSIX file modes on what it writes, so it runs where those exist; on
// Windows the skip names why, as every packaging script test here does.
const BASH = posixShell("bash");

describeIf(missingPosixShell("bash") ?? MISSING_POSIX_FILE_MODES, "docker/spark/make-certs.sh", () => {
  const SCRIPT = path.join(ROOT, "docker", "spark", "make-certs.sh");

  test("refuses a directory inside the repository and writes nothing there", () => {
    const run = spawnSync(BASH!, [SCRIPT, path.join(ROOT, "docker", "spark", "certs")], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("outside the repository");
    expect(readdirSync(path.join(ROOT, "docker", "spark")).sort()).toEqual(["make-certs.sh", "nginx.conf"]);
  });

  test("refuses a nested directory inside the repository before creating any level of it", () => {
    const run = spawnSync(BASH!, [SCRIPT, path.join(ROOT, "docker", "spark", "certs", "nested")], {
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("outside the repository");
    expect(readdirSync(path.join(ROOT, "docker", "spark")).sort()).toEqual(["make-certs.sh", "nginx.conf"]);
  });

  test("refuses a path that climbs back through a level it would create, and creates nothing", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "spark-certs-"));
    temporary.push(parent);
    const climb = "../".repeat(parent.split("/").length);
    const run = spawnSync(BASH!, [SCRIPT, `${parent}/missing/${climb}${ROOT.slice(1)}/docker/spark/certs`], {
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
    expect(readdirSync(parent)).toEqual([]);
    expect(readdirSync(path.join(ROOT, "docker", "spark")).sort()).toEqual(["make-certs.sh", "nginx.conf"]);
  });

  test("writes a CA and a server certificate for localhost and 127.0.0.1 signed by it, and nothing else", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "spark-certs-"));
    temporary.push(directory);
    const run = spawnSync(BASH!, [SCRIPT, directory], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(readdirSync(directory).sort()).toEqual(["ca.pem", "server.key", "server.pem"]);
    const san = execFileSync(
      "openssl",
      ["x509", "-in", path.join(directory, "server.pem"), "-noout", "-ext", "subjectAltName"],
      {
        encoding: "utf8",
      },
    );
    expect(san).toContain("DNS:localhost");
    expect(san).toContain("IP Address:127.0.0.1");
    const verified = execFileSync(
      "openssl",
      ["verify", "-CAfile", path.join(directory, "ca.pem"), path.join(directory, "server.pem")],
      { encoding: "utf8" },
    );
    expect(verified.trim()).toEndWith(": OK");
  });
});
