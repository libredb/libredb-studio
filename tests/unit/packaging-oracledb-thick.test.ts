/**
 * Unit test for the Oracle Thick-mode packaging wiring (#538).
 *
 * `oracledb` runs in pure-JS Thin mode by default, so for most of this
 * project's life the driver needed no packaging at all. `ORACLE_CLIENT_LIB_DIR`
 * changed that: `initOracleClient()` makes node-oracledb load its own native
 * addon, and that addon is invisible to both build stages.
 *
 * Two independent blind spots, both measured on the published images:
 *
 * 1. Turbopack bundled the driver into the server chunk and rewrote its
 *    `__dirname` to the literal `/ROOT/node_modules/oracledb/lib`, so the addon
 *    was looked for under `/ROOT/...` and `initOracleClient()` died with
 *    `NJS-045` before the Instant Client was ever consulted. `oracledb` has to
 *    be in `serverExternalPackages` for the path to be a real one.
 * 2. Once external, Next's output file tracing copies the package's JavaScript
 *    but NOT `build/Release/*.node`, because the driver reaches the addon
 *    through a computed `require(path)`. Every packaging site must copy the
 *    package explicitly, the way better-sqlite3, `@libredb/libredb` and the
 *    `@duckdb` scope already are.
 *
 * The copy is the WHOLE package directory on purpose: `build/Release` holds a
 * binary per platform/arch, so naming one would break the ARM64 image leg.
 *
 * Asserted as text because a real image build and a real Instant Client are
 * both out of reach in a unit test; the runtime proofs are the payload
 * `--smoke` probe and a live Thick-mode connection.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

describe("Oracle Thick-mode packaging", () => {
  test("Next.js externalizes the driver so its __dirname stays real", () => {
    const nextConfig = readRepoFile("next.config.ts");
    const externals = /serverExternalPackages:\s*\[([^\]]*)\]/.exec(nextConfig)?.[1];

    expect(externals).toContain('"oracledb"');
  });

  test("tsup leaves the driver out of the published bundles", () => {
    expect(readRepoFile("tsup.config.ts")).toContain('"oracledb"');
  });

  test("the Dockerfile runner copies the whole driver package, arch-agnostically", () => {
    const dockerfile = readRepoFile("Dockerfile");

    expect(dockerfile).toContain("/usr/src/app/node_modules/oracledb ./node_modules/oracledb");
    // build/Release carries one binary per platform/arch. Naming any of them
    // here would break the ARM64 leg.
    expect(dockerfile).not.toContain("oracledb-6");
    expect(dockerfile).not.toContain("build/Release/oracledb");
  });

  test("the standalone payload copies the driver and probes its binary", () => {
    const script = readRepoFile("scripts/build-standalone-payload.sh");

    // The header manifest claims to mirror the Dockerfile runner stage exactly.
    expect(script).toContain("node_modules/oracledb");
    expect(script).toContain('cp -R node_modules/oracledb "$PAYLOAD_DIR/node_modules/oracledb"');
    // Instant Client is not installed on a build runner, so Thick mode cannot
    // actually be entered here. What CAN be checked is the file tracing drops:
    // the addon for the target platform must exist in the copied package.
    expect(script).toContain("build/Release");
  });

  test("the docs recipe carries the three Linux loader steps", () => {
    const doc = readRepoFile("docs/providers/oracle.md");

    // `initOracleClient({ libDir })` alone cannot load Instant Client on Linux:
    // libclntsh.so has no RUNPATH, so its siblings are found only through the
    // system library search path.
    expect(doc).toContain("ldconfig");
    expect(doc).toContain("/etc/ld.so.conf.d/");
    // Debian 13 ships libaio.so.1t64 only; the SONAME the client needs is
    // libaio.so.1.
    expect(doc).toContain("libaio.so.1");
  });
});
