/**
 * Unit tests for the Db2 native-driver packaging wiring (issue #786).
 *
 * `db2-node` is the third native module in the payload, and it is shaped like
 * neither of the first two. It is ONE package with no per-platform optional
 * packages: eight prebuilt N-API addons sit at its root
 * (`db2-node.<platform>-<arch>[-gnu|-musl|-msvc].node`), and its generated
 * index.js reaches each one through a static `require('./db2-node.<triple>.node')`
 * literal. Next's file tracing therefore delivers all eight into the standalone
 * output with no explicit COPY (unlike `oracledb` and the `@duckdb` scope), and
 * every channel's job is the opposite one: prune to the one or two addons it
 * can load, then prove that the survivor loads. A pruned-away file fails at
 * require time, because index.js falls back to `db2-node-<triple>` packages
 * that do not exist.
 *
 * The addons statically link Rust crates whose notices the npm tarball does
 * not carry, so THIRD_PARTY_NOTICES.txt travels with every artifact instead.
 *
 * Asserted as text where a real image, payload, AppImage or Windows build is
 * out of reach in a unit test; the prune script itself runs against a fixture.
 * The runtime proofs are the image build asserts, the payload `--smoke` probe,
 * the Windows zip probe and the engine-smoke Db2 connection.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeIfPosixShell, posixShell } from "../helpers/posix-tools";

const ROOT = join(import.meta.dir, "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

const ADDONS = [
  "db2-node.linux-x64-gnu.node",
  "db2-node.linux-x64-musl.node",
  "db2-node.linux-arm64-gnu.node",
  "db2-node.linux-arm64-musl.node",
  "db2-node.darwin-x64.node",
  "db2-node.darwin-arm64.node",
  "db2-node.win32-x64-msvc.node",
  "db2-node.win32-arm64-msvc.node",
];

describe("db2-node dependency", () => {
  const pkg = JSON.parse(readRepoFile("package.json")) as {
    dependencies: Record<string, string>;
    trustedDependencies: string[];
    "//dependencies": string;
  };

  test("is pinned exactly, because the provider was measured against one version", () => {
    expect(pkg.dependencies["db2-node"]).toBe("1.0.25");
    expect(pkg["//dependencies"]).toContain("db2-node is pinned exactly");
  });

  test("needs no install-time script allowance", () => {
    // Measured on 1.0.25: the scripts block holds only build, build:debug, prepublishOnly and test,
    // and the package ships no binding.gyp, so bun runs nothing on install.
    expect(pkg.trustedDependencies).not.toContain("db2-node");
  });
});

describe("db2-node bundling", () => {
  test("Next.js externalizes the driver", () => {
    const nextConfig = readRepoFile("next.config.ts");
    const externals = /serverExternalPackages:\s*\[([^\]]*)\]/.exec(nextConfig)?.[1];

    expect(externals).toContain('"db2-node"');
    // The trace reaches all eight addons on its own; an include rule would mean
    // it stopped doing so and someone patched round it.
    expect(nextConfig).not.toContain("outputFileTracingIncludes");
  });

  test("tsup leaves the driver out of the published bundles", () => {
    const external = /external:\s*\[([\s\S]*?)\n {2}\]/.exec(readRepoFile("tsup.config.ts"))?.[1];

    expect(external).toContain('"db2-node"');
  });
});

describe("the standalone payload", () => {
  const script = readRepoFile("scripts/build-standalone-payload.sh");
  const smoke = script.slice(script.indexOf('if [ "$RUN_SMOKE" = "true" ]'));
  const build = script.slice(0, script.indexOf('if [ "$RUN_SMOKE" = "true" ]'));

  test("prunes db2-node to the target through the shared script", () => {
    expect(build).toContain('"$ROOT_DIR/scripts/lib/prune-db2-node.sh" "$PAYLOAD_DIR" "$OS" "$ARCH"');
    // The prune has to see the payload after the traced copy landed in it.
    expect(build.indexOf("prune-db2-node.sh")).toBeGreaterThan(build.indexOf("cp -R .next/standalone/."));
    // The header manifest claims to mirror what the payload ships.
    expect(script).toContain("node_modules/db2-node");
  });

  test("ships the traced copy and never a second, explicit one", () => {
    // The Dockerfile runners have no COPY for it either; an explicit copy here
    // would ship all eight addons again over the pruned tree.
    expect(script).not.toMatch(/cp -R[^\n]*node_modules\/db2-node/);
  });

  test("load-probes the pruned driver on the build host", () => {
    expect(build).toContain(`(cd "$PAYLOAD_DIR" && node -e "require('db2-node')")`);
  });

  test("smoke-tests the extracted archive's driver", () => {
    expect(smoke).toContain('cd "$SMOKE_DIR"');
    expect(smoke).toContain(
      `node -e "const m = require('db2-node'); if (typeof m.Client !== 'function') { throw new Error('db2-node loaded without Client'); }"`,
    );
  });

  test("carries the third-party notices to the payload root and checks they arrived", () => {
    expect(build).toContain('cp THIRD_PARTY_NOTICES.txt "$PAYLOAD_DIR/THIRD_PARTY_NOTICES.txt"');
    expect(build.indexOf("cp THIRD_PARTY_NOTICES.txt")).toBeGreaterThan(build.indexOf("prune-standalone-payload.sh"));
    expect(smoke).toContain('test -f "$SMOKE_DIR/THIRD_PARTY_NOTICES.txt"');
  });
});

describe("the desktop AppImage", () => {
  const script = readRepoFile("scripts/build-desktop-appimage.sh");
  const PRUNE = `! -name "db2-node.linux-\${ARCH}-gnu.node" -delete`;

  test("keeps only the glibc addon for the build arch, and fails without it", () => {
    expect(script).toContain(PRUNE);
    expect(script).toContain('[ ! -f "$DB2_NODE_DIR/db2-node.linux-${ARCH}-gnu.node" ]');
  });

  test("prunes while the payload is staged, before the bundler drives linuxdeploy", () => {
    // linuxdeploy treats the musl addons' unresolvable libc as fatal.
    const pruneIndex = script.indexOf(PRUNE);
    expect(pruneIndex).toBeGreaterThan(script.indexOf('STAGE_PAYLOAD="$TAURI_DIR/payload"'));
    expect(pruneIndex).toBeLessThan(script.indexOf('bunx "@tauri-apps/cli'));
  });
});

describe("the Windows zip", () => {
  test("load-probes the driver with the bundled node.exe", () => {
    const workflow = readRepoFile(".github/workflows/release-artifacts.yml");

    expect(workflow).toContain(
      `(cd "$SMOKE_DIR" && ./node/node.exe -e "const m = require('db2-node'); if (typeof m.Client !== 'function') { throw new Error('db2-node loaded without Client'); } console.log('db2-node probe ok')")`,
    );
    expect(workflow).not.toContain("ONLY native binding");
  });
});

describe("the engine smoke", () => {
  test("drives a db2 connection through the server and expects a network failure", () => {
    const script = readRepoFile("scripts/engine-smoke.sh");

    expect(script).toContain('"type":"db2"');
    expect(script).toContain('"host":"127.0.0.1","port":1');
    // A loaded driver refuses a closed port; a missing addon never gets that far.
    expect(script).toMatch(/check "db2[^"]*" "\$DB2_BODY" "Connection refused"/);
    expect(script).toMatch(/check_absent "[^"]*" "\$DB2_BODY" "Cannot find module"/);
    expect(script).toMatch(/check_absent "[^"]*" "\$DB2_BODY" "Failed to load native binding"/);
  });
});

describe("third-party notices", () => {
  const notices = readRepoFile("THIRD_PARTY_NOTICES.txt");

  test("carry db2-node's MIT text and the notices of the crates its addons link", () => {
    expect(notices).toContain("db2-node 1.0.25 (https://github.com/gurungabit/db2-node, gitHead ae5730e1)");
    expect(notices).toContain("Copyright (c) 2026 Abit Gurung");
    for (const crate of ["rustls 0.23.45", "rustls-webpki 0.103.15", "ring 0.17.14", "decnumber-sys 0.1.6"]) {
      expect(notices).toContain(`\n${crate}\nLicense: `);
    }
    // decnumber-sys vendors IBM's decNumber under the ICU license.
    expect(notices).toContain("International Business Machines Corporation");
  });

  test("name the generator, which is the only way the file changes", () => {
    expect(notices).toContain("Generated by scripts/generate-db2-node-notices.sh; do not edit by hand.");
    expect(existsSync(join(ROOT, "scripts/generate-db2-node-notices.sh"))).toBe(true);
  });

  test("are summarised in docs/THIRD_PARTY_LICENSES.md", () => {
    const doc = readRepoFile("docs/THIRD_PARTY_LICENSES.md");

    expect(doc).toContain("`db2-node`");
    expect(doc).toContain("THIRD_PARTY_NOTICES.txt");
    expect(doc).toContain("`decnumber-sys`");
  });

  test("survive the Docker build context", () => {
    // .dockerignore drops *.md, so the notices are a .txt file and the
    // context must not exclude it.
    expect(readRepoFile(".dockerignore")).not.toMatch(/^\*\.txt$|^THIRD_PARTY_NOTICES/m);
  });
});

const SHELL = posixShell("bash");
const PRUNE_SCRIPT = join(ROOT, "scripts/lib/prune-db2-node.sh");

describeIfPosixShell("bash", "scripts/lib/prune-db2-node.sh", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const fixtureRoot of fixtureRoots.splice(0)) rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function makePayload(options: { addons?: string[]; indexJs?: boolean } = {}): string {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "prune-db2-node-"));
    fixtureRoots.push(fixtureRoot);
    const packageDir = join(fixtureRoot, "payload", "node_modules", "db2-node");
    mkdirSync(packageDir, { recursive: true });
    if (options.indexJs ?? true) writeFileSync(join(packageDir, "index.js"), "// fixture");
    for (const addon of options.addons ?? ADDONS) writeFileSync(join(packageDir, addon), "");
    return join(fixtureRoot, "payload");
  }

  function prune(...args: string[]) {
    return Bun.spawnSync([SHELL!, PRUNE_SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  }

  function addonsLeft(payload: string): string[] {
    return readdirSync(join(payload, "node_modules", "db2-node"))
      .filter((file) => file.endsWith(".node"))
      .sort();
  }

  test("linux keeps both libcs for the arch, because one tarball serves glibc and Alpine", () => {
    const payload = makePayload();

    const run = prune(payload, "linux", "x64");
    expect(run.exitCode).toBe(0);
    expect(addonsLeft(payload)).toEqual(["db2-node.linux-x64-gnu.node", "db2-node.linux-x64-musl.node"]);
  });

  test("linux arm64 keeps the arm64 pair", () => {
    const payload = makePayload();

    expect(prune(payload, "linux", "arm64").exitCode).toBe(0);
    expect(addonsLeft(payload)).toEqual(["db2-node.linux-arm64-gnu.node", "db2-node.linux-arm64-musl.node"]);
  });

  test("darwin keeps the one addon for the arch", () => {
    const payload = makePayload();

    expect(prune(payload, "darwin", "arm64").exitCode).toBe(0);
    expect(addonsLeft(payload)).toEqual(["db2-node.darwin-arm64.node"]);
  });

  test("win32 keeps the msvc addon for the arch", () => {
    const payload = makePayload();

    expect(prune(payload, "win32", "x64").exitCode).toBe(0);
    expect(addonsLeft(payload)).toEqual(["db2-node.win32-x64-msvc.node"]);
  });

  test("fails when the addon the target needs is missing", () => {
    const payload = makePayload({ addons: ADDONS.filter((addon) => addon !== "db2-node.linux-x64-musl.node") });

    const run = prune(payload, "linux", "x64");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("db2-node.linux-x64-musl.node");
  });

  test("fails when tracing no longer delivers the package", () => {
    const payload = makePayload({ indexJs: false });

    const run = prune(payload, "linux", "x64");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("file tracing");
  });

  test("win32 also prunes a hashed external that the Windows build turned into a real copy", () => {
    // Turbopack links each serverExternalPackages entry under .next/node_modules/<name>-<hash> and the
    // server chunks require that name. Git Bash's cp -R copies the link as a real directory, so on the
    // Windows runner the payload holds a second copy of the package, and it is the one the server loads.
    const payload = makePayload();
    const hashed = join(payload, ".next", "node_modules", "db2-node-0123abcd");
    mkdirSync(hashed, { recursive: true });
    writeFileSync(join(hashed, "index.js"), "// fixture");
    for (const addon of ADDONS) writeFileSync(join(hashed, addon), "");

    const run = prune(payload, "win32", "x64");
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    expect(addonsLeft(payload)).toEqual(["db2-node.win32-x64-msvc.node"]);
    expect(readdirSync(hashed).filter((file) => file.endsWith(".node"))).toEqual(["db2-node.win32-x64-msvc.node"]);
  });

  test("leaves a hashed external that is still a link alone, and counts its addons once", () => {
    const payload = makePayload();
    const hashedParent = join(payload, ".next", "node_modules");
    mkdirSync(hashedParent, { recursive: true });
    symlinkSync(join(payload, "node_modules", "db2-node"), join(hashedParent, "db2-node-0123abcd"));

    const run = prune(payload, "linux", "x64");
    expect(run.exitCode).toBe(0);
    expect(addonsLeft(payload)).toEqual(["db2-node.linux-x64-gnu.node", "db2-node.linux-x64-musl.node"]);
  });

  test("fails when a real copy of the package lacks the addon the target needs", () => {
    const payload = makePayload();
    const hashed = join(payload, ".next", "node_modules", "db2-node-0123abcd");
    mkdirSync(hashed, { recursive: true });
    writeFileSync(join(hashed, "index.js"), "// fixture");
    writeFileSync(join(hashed, "db2-node.darwin-x64.node"), "");

    const run = prune(payload, "win32", "x64");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("db2-node-0123abcd");
  });

  test("fails when an addon sits outside every copy of the package", () => {
    // A directory with no index.js is no copy of the package, so its addon would ship beside the
    // ones the target loads.
    const payload = makePayload();
    const hashed = join(payload, ".next", "node_modules", "db2-node-0123abcd");
    mkdirSync(hashed, { recursive: true });
    writeFileSync(join(hashed, "db2-node.darwin-x64.node"), "");

    const run = prune(payload, "linux", "x64");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("db2-node-0123abcd");
  });

  test("rejects an unknown target", () => {
    const payload = makePayload();

    const run = prune(payload, "freebsd", "x64");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("freebsd");
    expect(addonsLeft(payload)).toHaveLength(ADDONS.length);
  });

  test("rejects a wrong number of arguments", () => {
    const run = prune();
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("Usage:");
  });
});
