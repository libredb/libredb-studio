/**
 * Unit test for the DuckDB native-driver packaging wiring.
 *
 * `@duckdb/node-api` is the second native module in the payload, and it is not
 * shaped like the first: better-sqlite3 13 is ONE package carrying every
 * prebuild, while duckdb splits across `@duckdb/node-api` (JS) ->
 * `@duckdb/node-bindings` (JS loader) -> a per-platform
 * `@duckdb/node-bindings-<platform>-<arch>[-musl]` package holding
 * `duckdb.node` next to a ~70 MB `libduckdb.so`. The loader does a bare
 * top-level `require('@duckdb/node-bindings-<platform>-<arch>/duckdb.node')`,
 * so importing the API throws immediately when the platform package is absent,
 * and `duckdb.node` has `NEEDED libduckdb.so` with `RUNPATH $ORIGIN`, so the
 * two files must travel together.
 *
 * Every packaging site therefore has to copy the WHOLE `@duckdb` scope (plus
 * `detect-libc`, which the loader requires), never a single directory and never
 * a selective `*.node` copy. Asserted as text because a real image build, a
 * real payload build and a real AppImage run are all out of reach in a unit
 * test; the runtime proofs are the payload `--smoke` probe and the
 * engine-smoke DuckDB query.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

describe("DuckDB native driver packaging", () => {
  test("Next.js externalizes the driver and its binding loader", () => {
    const nextConfig = readRepoFile("next.config.ts");
    const externals = /serverExternalPackages:\s*\[([^\]]*)\]/.exec(nextConfig)?.[1];

    expect(externals).toContain('"@duckdb/node-api"');
    expect(externals).toContain('"@duckdb/node-bindings"');
  });

  test("tsup leaves the driver out of the published bundles", () => {
    expect(readRepoFile("tsup.config.ts")).toContain('"@duckdb/node-api"');
  });

  test("the Dockerfile runner copies the whole @duckdb scope, arch-agnostically", () => {
    const dockerfile = readRepoFile("Dockerfile");

    expect(dockerfile).toContain("/usr/src/app/node_modules/@duckdb ./node_modules/@duckdb");
    expect(dockerfile).toContain("/usr/src/app/node_modules/detect-libc ./node_modules/detect-libc");
    // A hardcoded platform package would break the ARM64 leg: the deps stage
    // installs only the bindings package matching the build arch.
    expect(dockerfile).not.toContain("node-bindings-linux-x64");
  });

  test("the standalone payload copies the whole @duckdb scope and probes it", () => {
    const script = readRepoFile("scripts/build-standalone-payload.sh");

    // The header manifest claims to mirror the Dockerfile runner stage exactly.
    expect(script).toContain("node_modules/@duckdb");
    expect(script).toContain('cp -R node_modules/@duckdb "$PAYLOAD_DIR/node_modules/@duckdb"');
    expect(script).toContain('cp -R node_modules/detect-libc "$PAYLOAD_DIR/node_modules/detect-libc"');
    // Stat-ing a directory is not enough: the binding is resolved by a bare
    // require at module load, so the guard has to actually import it.
    expect(script).toContain("require('@duckdb/node-api')");
  });

  test("the standalone payload smoke-tests the extracted tarball's binding", () => {
    const script = readRepoFile("scripts/build-standalone-payload.sh");
    const smoke = script.slice(script.indexOf('if [ "$RUN_SMOKE" = "true" ]'));

    expect(smoke).toContain("@duckdb/node-api");
    expect(smoke).toContain('cd "$SMOKE_DIR"');
  });

  test("the AppImage prunes the musl bindings package before linuxdeploy runs", () => {
    const script = readRepoFile("scripts/build-desktop-appimage.sh");

    // Whole directories, not `.node` files: deleting duckdb.node while leaving
    // the 70 MB libduckdb.so behind would keep the size and lose the function.
    expect(script).toContain('rm -rf "$STAGE_PAYLOAD"/node_modules/@duckdb/*-musl');
    expect(script).toContain("node_modules/@duckdb/node-bindings-linux-${ARCH}/duckdb.node");

    // Pruning has to happen while the payload is staged, before the bundler
    // (which drives linuxdeploy) walks the AppDir.
    const pruneIndex = script.indexOf('rm -rf "$STAGE_PAYLOAD"/node_modules/@duckdb/*-musl');
    expect(pruneIndex).toBeGreaterThan(-1);
    expect(pruneIndex).toBeLessThan(script.indexOf('bunx "@tauri-apps/cli'));
  });

  test("the driver needs no install-time script allowance", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      dependencies: Record<string, string>;
      trustedDependencies: string[];
    };

    expect(pkg.dependencies["@duckdb/node-api"]).toBeDefined();
    // Measured: no `scripts` block and no binding.gyp in any of the four
    // packages, so bun synthesizes no `node-gyp rebuild` and the allowlist
    // stays exactly the packages that ran scripts before the field existed.
    expect(pkg.trustedDependencies).not.toContain("@duckdb/node-api");
  });
});
