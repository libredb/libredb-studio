/**
 * Unit test for the musl pruning of the desktop AppImage payload.
 *
 * linuxdeploy walks every ELF file in the AppDir and treats a dependency it cannot resolve as
 * fatal, so a musl build of a native module in a glibc bundle ends the build with a bare
 * "failed to run linuxdeploy". bun installs an optional bindings package by platform and arch but
 * ignores its `libc` field, so a Linux tree carries the glibc and the musl build side by side.
 *
 * `@platformatic/kafka` (the Kafka provider's client) requires `@node-rs/crc32` when it loads, and
 * bun installs `@node-rs/crc32-linux-<arch>-gnu` and `@node-rs/crc32-linux-<arch>-musl` beside it.
 * Measured: the musl `crc32.linux-x64-musl.node` needs `libc.so` (musl), which a glibc AppDir cannot
 * resolve, and the Flatpak Smoke AppImage jobs failed on exactly that while the same workflow passed
 * on main. The client falls back to its WebAssembly CRC32C when the native module is absent, so
 * pruning the musl builds costs no function, and no positive check is needed, unlike DuckDB's.
 * Asserted as text, as `tests/unit/packaging-duckdb-native.test.ts` does, because a real AppImage
 * build is out of reach in a unit test; the runtime proof is the Flatpak Smoke workflow.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = readFileSync(join(import.meta.dir, "../../scripts/build-desktop-appimage.sh"), "utf8");
const NODE_RS_PRUNE = 'rm -rf "$STAGE_PAYLOAD"/node_modules/@node-rs/*-musl';

describe("the AppImage payload prunes the musl builds of @node-rs", () => {
  test("every @node-rs musl bindings package is removed from the staged payload", () => {
    expect(script).toContain(NODE_RS_PRUNE);
  });

  test("the pruning runs while the payload is staged, before the bundler drives linuxdeploy", () => {
    const pruneIndex = script.indexOf(NODE_RS_PRUNE);
    expect(pruneIndex).toBeGreaterThan(script.indexOf('STAGE_PAYLOAD="$TAURI_DIR/payload"'));
    expect(pruneIndex).toBeLessThan(script.indexOf('bunx "@tauri-apps/cli'));
  });
});
