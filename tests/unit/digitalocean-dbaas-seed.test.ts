/**
 * Executes the DigitalOcean Managed Database helper
 * (deploy/digitalocean/droplet/files/usr/local/sbin/libredb-do-dbaas-seed) against
 * credentials files in the shapes DigitalOcean is known to write, and checks what a buyer's
 * Droplet would get: a seed file Studio's own schema accepts, passwords only in the env lines,
 * the admin role, and an explicit refusal for anything the helper does not know.
 *
 * The quoted shape (`db_protocol="postgresql"`) is the one DigitalOcean's own Marketplace
 * images parse in digitalocean/droplet-1-clicks; the bare shape is the one the
 * digitalocean/marketplace-partners README prints. The keystore fields are the ones the
 * Airflow image reads for a Managed Valkey.
 *
 * The output is parsed with the SeedConfigSchema of this commit, while a snapshot runs the image
 * version Packer pins. So this checks the file against the schema of the commit the snapshot is
 * built from, which holds only when a snapshot is built from the tag that matches its pinned
 * version.
 *
 * Windows has no bash on PATH and no mode bits, so the suite says why it is skipped there
 * instead of failing as if the helper were broken.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse as parseYAML } from "yaml";
import { SeedConfigSchema } from "@/lib/seed/types";
import { MISSING_POSIX_FILE_MODES, describeIf, missingPosixShell, posixShell } from "../helpers/posix-tools";

const HELPER = path.join(__dirname, "../../deploy/digitalocean/droplet/files/usr/local/sbin/libredb-do-dbaas-seed");
const BASH = posixShell("bash");
// Named stand-ins in the repository's TEST_PASSWORD style, never realistic values: a scanner reads a
// realistic password in a fixture as a leaked one. Each is distinct, so a leak check can find it.
const TEST_PASSWORD = "password-of-the-database";
const TEST_PASSWORD_KEYSTORE = "password-of-the-keystore";
// The characters an env file or a shell could mangle, to prove the value is passed through verbatim.
const TEST_PASSWORD_QUOTED = 'password-with-$-and-"';

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  seed: string | null;
  seedMode: number | null;
  status: string;
}

interface Options {
  /** A status file left by an earlier run, as on a Droplet created from a customer's snapshot. */
  staleStatus?: string;
  /** Put the seed file in a directory that does not exist, so the helper's own write fails. */
  unwritableSeed?: boolean;
}

function run(credentials: string, options: Options = {}): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "do-dbaas-"));
  fixtures.push(dir);
  const creds = path.join(dir, "credentials");
  const seed = options.unwritableSeed
    ? path.join(dir, "missing", "connections.yaml")
    : path.join(dir, "connections.yaml");
  const status = path.join(dir, "dbaas.status");
  fs.writeFileSync(creds, credentials);
  if (options.staleStatus !== undefined) fs.writeFileSync(status, options.staleStatus);
  const result = Bun.spawnSync([BASH!, HELPER, creds, seed, status]);
  const exists = fs.existsSync(seed);
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    seed: exists ? fs.readFileSync(seed, "utf8") : null,
    seedMode: exists ? fs.statSync(seed).mode & 0o777 : null,
    status: fs.readFileSync(status, "utf8"),
  };
}

/** The seed file through Studio's own schema: a schema error would hide every seeded connection. */
function connections(seed: string | null) {
  const parsed = SeedConfigSchema.safeParse(parseYAML(seed ?? ""));
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data.connections;
}

const POSTGRES = [
  'db_protocol="postgresql"',
  'db_username="doadmin"',
  `db_password="${TEST_PASSWORD}"`,
  'db_host="db-postgresql-nyc3-12345-do-user-1-0.b.db.ondigitalocean.com"',
  'db_port="25060"',
  'db_database="defaultdb"',
].join("\n");

const VALKEY = [
  'keystore_name="valkey-1"',
  'keystore_protocol="rediss"',
  'redis_host="db-valkey-nyc3-1-do-user-1-0.b.db.ondigitalocean.com"',
  'redis_port="25061"',
  'redis_username="default"',
  `redis_password="${TEST_PASSWORD_KEYSTORE}"`,
].join("\n");

describeIf(missingPosixShell("bash") ?? MISSING_POSIX_FILE_MODES, "DigitalOcean Managed Database seed helper", () => {
  test("a PostgreSQL cluster becomes one admin-only managed connection over TLS", () => {
    const result = run(`${POSTGRES}\n`);
    expect(result.exitCode).toBe(0);
    const [conn, ...rest] = connections(result.seed);
    expect(rest).toEqual([]);
    expect(conn).toMatchObject({
      id: "do-managed-postgres",
      type: "postgres",
      host: "db-postgresql-nyc3-12345-do-user-1-0.b.db.ondigitalocean.com",
      port: 25060,
      database: "defaultdb",
      user: "doadmin",
      password: "${LIBREDB_DO_DB_PASSWORD}",
      roles: ["admin"],
      managed: true,
      ssl: { mode: "require" },
    });
    // The password reaches the env file through stdout and nowhere else.
    expect(result.stdout).toBe(`LIBREDB_DO_DB_PASSWORD=${TEST_PASSWORD}\n`);
    expect(result.seed).not.toContain(TEST_PASSWORD);
    expect(result.status).not.toContain(TEST_PASSWORD);
    expect(result.seedMode).toBe(0o600);
    expect(result.status.split("\n")[0]).toBe("DBAAS=connected");
  });

  test("the bare key=value shape is read too, and a password is passed through verbatim", () => {
    const result = run(
      [
        "db_protocol=mysql",
        "db_username=doadmin",
        `db_password=${TEST_PASSWORD_QUOTED}`,
        "db_host=db-mysql-nyc3-1-do-user-1-0.b.db.ondigitalocean.com",
        "db_port=25060",
        "db_database=defaultdb",
      ].join("\n"),
    );
    expect(result.exitCode).toBe(0);
    expect(connections(result.seed)[0]).toMatchObject({ id: "do-managed-mysql", type: "mysql", port: 25060 });
    // docker --env-file takes the rest of the line literally, so nothing may be escaped.
    expect(result.stdout).toBe(`LIBREDB_DO_DB_PASSWORD=${TEST_PASSWORD_QUOTED}\n`);
  });

  test("a Valkey keystore next to the database becomes a second connection with its own password", () => {
    const result = run(`${POSTGRES}\n\n${VALKEY}\n`);
    expect(result.exitCode).toBe(0);
    const list = connections(result.seed);
    expect(list.map((c) => c.id)).toEqual(["do-managed-postgres", "do-managed-valkey"]);
    expect(list[1]).toMatchObject({
      type: "redis",
      port: 25061,
      user: "default",
      password: "${LIBREDB_DO_KEYSTORE_PASSWORD}",
      roles: ["admin"],
      managed: true,
      ssl: { mode: "require" },
    });
    expect(list[1].database).toBeUndefined();
    expect(result.stdout).toBe(
      `LIBREDB_DO_DB_PASSWORD=${TEST_PASSWORD}\nLIBREDB_DO_KEYSTORE_PASSWORD=${TEST_PASSWORD_KEYSTORE}\n`,
    );
  });

  test("keystore keys that are present but empty add no connection", () => {
    const result = run(`${POSTGRES}\nkeystore_protocol=""\nredis_host=""\n`);
    expect(result.exitCode).toBe(0);
    expect(connections(result.seed).map((c) => c.id)).toEqual(["do-managed-postgres"]);
  });

  for (const [title, credentials, reason] of [
    ["an engine the helper does not know", POSTGRES.replace("postgresql", "mongodb"), 'db_protocol "mongodb"'],
    [
      "a keystore protocol the helper does not know",
      `${POSTGRES}\n${VALKEY.replace("rediss", "memcached")}`,
      "keystore_protocol",
    ],
    [
      "a host that would break out of its YAML string",
      POSTGRES.replace(/db_host=.*/, 'db_host="h\\" roles: [\\"*\\"]"'),
      "db_host",
    ],
    ["a port that is not a port", POSTGRES.replace('"25060"', '"70000"'), "db_port"],
    ["a missing password", POSTGRES.replace(/db_password=.*\n/, ""), "db_password is missing"],
    ["a file that names no engine at all", 'db_host="h"\n', "names no db_protocol"],
  ] as const) {
    test(`refuses ${title}, writes no seed and says why`, () => {
      const result = run(credentials);
      expect(result.exitCode).toBe(1);
      expect(result.seed).toBeNull();
      expect(result.stdout).toBe("");
      expect(result.status.split("\n")[0]).toBe("DBAAS=error");
      expect(result.status).toContain(reason);
      expect(result.stderr).toContain(reason);
      // A refusal is printed in the MOTD and the journal, so it must never carry a password.
      expect(result.status + result.stderr).not.toContain(TEST_PASSWORD);
    });
  }

  test("a write that fails before any refusal still replaces an earlier status with an error", () => {
    // per-instance runs again on a Droplet created from a customer's snapshot, so a status
    // file saying "connected" can already be there. A failure the helper did not foresee
    // (here the seed directory is missing) must not leave that claim for the MOTD to print.
    const result = run(`${POSTGRES}\n`, {
      staleStatus: "DBAAS=connected\nDBAAS_CONNECTION=DigitalOcean Managed PostgreSQL: database old, user old\n",
      unwritableSeed: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.seed).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.status.split("\n")[0]).toBe("DBAAS=error");
    expect(result.status).not.toContain("database old");
    expect(result.status + result.stderr).not.toContain(TEST_PASSWORD);
  });

  test("a value printed in a refusal cannot carry a control sequence into the MOTD", () => {
    const result = run(POSTGRES.replace("postgresql", "\u001b[31mevil"));
    expect(result.exitCode).toBe(1);
    expect(result.status).not.toContain("\u001b");
    expect(result.status).toContain('db_protocol "31mevil"');
  });
});
