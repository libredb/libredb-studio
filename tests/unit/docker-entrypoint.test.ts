/**
 * Unit tests for the container entrypoint's bind-address wiring (issue #432).
 *
 * The entrypoint is exercised as a real subprocess against a stub "node" that
 * either runs the resolver fixture or echoes the HOSTNAME it was started with -
 * no real server ever starts, and no /proc or network is touched. The resolver
 * itself is covered by tests/unit/docker-bind-address.test.ts; what is pinned
 * here is the glue: that the resolved address reaches the exec'd command, that
 * a broken resolver can never stop the container starting, and that argv is
 * forwarded verbatim (so `exec "$@"` keeps the app at PID 1 and SIGTERM keeps
 * being delivered straight to it).
 *
 * These tests run as a non-root user, so they take the plain `exec "$@"` path.
 * That is precisely why the resolution must sit ABOVE the `id -u` branch: there
 * is no USER instruction in the Dockerfile, so a plain `docker run` takes the
 * OTHER (root -> gosu) path, and resolution placed inside either branch would
 * silently apply to only half of the deployments.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRYPOINT = join(import.meta.dir, "../../docker-entrypoint.sh");

/**
 * A stub `node`: when handed the resolver path it runs the fixture as a shell
 * script (so a fixture can print an address, print nothing, or fail); otherwise
 * it stands in for `node server.js` and reports the environment it inherited.
 */
const STUB_NODE_SCRIPT = [
  "#!/bin/sh",
  'if [ -n "$LIBREDB_BIND_RESOLVER" ] && [ "$1" = "$LIBREDB_BIND_RESOLVER" ]; then',
  '  sh "$1"',
  "  exit $?",
  "fi",
  'echo "HOSTNAME=$HOSTNAME"',
  'echo "ARGS=$*"',
  "",
].join("\n");

describe("docker-entrypoint.sh bind address (#432)", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** Runs the entrypoint with a resolver fixture whose body is `resolverScript`. */
  function runEntrypoint(resolverScript: string | null, args: string[] = ["node", "server.js"]) {
    const root = mkdtempSync(join(tmpdir(), "libredb-entrypoint-"));
    fixtureRoots.push(root);
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const stubNode = join(binDir, "node");
    writeFileSync(stubNode, STUB_NODE_SCRIPT);
    chmodSync(stubNode, 0o755);

    const resolver = join(root, "bind-address.mjs");
    if (resolverScript !== null) writeFileSync(resolver, resolverScript);

    return Bun.spawnSync(["sh", ENTRYPOINT, ...args], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        LIBREDB_BIND_RESOLVER: resolver,
        HOSTNAME: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("exports the address the resolver chose", () => {
    const result = runEntrypoint('echo "::"');
    expect(result.stdout.toString()).toContain("HOSTNAME=::");
  });

  test("exports 0.0.0.0 just as faithfully - the resolver, not the entrypoint, decides", () => {
    const result = runEntrypoint('echo "0.0.0.0"');
    expect(result.stdout.toString()).toContain("HOSTNAME=0.0.0.0");
  });

  test("trims stray whitespace off the resolver's answer", () => {
    const result = runEntrypoint('printf "  ::  \\n"');
    expect(result.stdout.toString()).toContain("HOSTNAME=::");
  });

  test("passes the resolver's explanatory line through to the container log", () => {
    const result = runEntrypoint('echo "::"; echo "libredb-studio: bind address :: (dual-stack verified)" >&2');
    expect(result.stderr.toString()).toContain("libredb-studio: bind address ::");
  });

  test("a resolver that fails still starts the container, on the pre-#432 address", () => {
    const result = runEntrypoint('echo "::"; exit 3');
    expect(result.stdout.toString()).toContain("HOSTNAME=0.0.0.0");
    expect(result.stderr.toString()).toContain("bind resolver unavailable");
    expect(result.exitCode).toBe(0);
  });

  test("a resolver that prints nothing falls back the same way", () => {
    const result = runEntrypoint("exit 0");
    expect(result.stdout.toString()).toContain("HOSTNAME=0.0.0.0");
    expect(result.stderr.toString()).toContain("bind resolver unavailable");
  });

  test("a missing resolver file falls back rather than failing the start", () => {
    const result = runEntrypoint(null);
    expect(result.stdout.toString()).toContain("HOSTNAME=0.0.0.0");
    expect(result.exitCode).toBe(0);
  });

  test("forwards argv verbatim, so the app is still what gets exec'd", () => {
    const result = runEntrypoint('echo "::"', ["node", "server.js", "--extra"]);
    expect(result.stdout.toString()).toContain("ARGS=server.js --extra");
  });
});
