/**
 * Unit tests for the published image variants (issue #840).
 *
 * The product ships three images out of one repository: `Dockerfile` (Debian
 * trixie-slim, the default tag), `Dockerfile.alpine` (musl, same engine set)
 * and `Dockerfile.alpine-slim` (musl, engines traded for size). They are three
 * files rather than one `ARG VARIANT` because Dependabot's docker ecosystem
 * cannot follow an ARG-interpolated `FROM` tag, and a variant that exists for
 * its CVE posture must keep receiving base bumps.
 *
 * Three files also means every invariant this project relies on now has three
 * places to hold. The population is read off the repo root rather than listed
 * here, so a fourth variant inherits every assertion below on the day it lands,
 * and the one list that does name them (the CI build matrix) is checked against
 * that same population.
 *
 * The Monaco assertion is a regression test with a measured cause. The first
 * `-alpine-slim` build deleted `*.worker*.js` from the staged `public/monaco`
 * tree, on the theory that a SQL editor never consults the TypeScript language
 * service. `editor.main.js` bundles the json, css, html and typescript
 * contributions; each one's mode chunk declares its worker stub as a hard AMD
 * dependency (`vs/jsonMode-<hash>` requires `./json.worker-<hash>`), and the
 * loader resolves that graph when the editor loads, not when a buffer of that
 * language is opened. One missing chunk therefore rejected `loader.init()` and
 * no editor mounted at all: the image booted, served /login, seeded the sample
 * database, and had no query editor. It is asserted as text because a real
 * image build is not viable in a unit test; the runtime proof is the Channel
 * E2E job, which runs `e2e/embedded-samples.spec.ts` (it waits on
 * `.monaco-editor`) against every variant this workflow pushes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** Every Dockerfile at the repo root, which is every image this project publishes. */
const VARIANTS = readdirSync(ROOT)
  .filter((entry) => entry === "Dockerfile" || entry.startsWith("Dockerfile."))
  .sort();

/**
 * Instruction lines: comments dropped first, then backslash continuations joined,
 * exactly as the daemon reads the file. Both steps matter here - a comment may
 * legitimately say "the Monaco workers are not pruned", and the prune that broke
 * the editor was one instruction spread over eight physical lines.
 */
function instructions(dockerfile: string): string[] {
  return dockerfile
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/\\\r?\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The shell commands inside those instructions. One `RUN` is a single
 * instruction once its continuations are joined, and these files put a dozen
 * commands in one, so an instruction-level check would read "this RUN mentions
 * the Monaco tree and also contains an rm" and flag a file that does neither
 * thing to the other. Split on the separators that end a command, never on the
 * pipe: `find <tree> | xargs rm` is one command and is exactly the shape of the
 * defect this file guards.
 */
function commands(dockerfile: string): string[] {
  return instructions(dockerfile)
    .flatMap((line) => line.split(/;|&&/))
    .map((command) => command.trim())
    .filter(Boolean);
}

interface DockerWorkflow {
  on: unknown;
  jobs: Record<
    string,
    {
      if?: string;
      strategy?: { matrix?: unknown };
      steps?: { id?: string; run?: string }[];
    }
  >;
}

const dockerWorkflow = parseYaml(
  readFileSync(join(ROOT, ".github/workflows/docker-build-push.yml"), "utf8"),
) as DockerWorkflow;

/**
 * The variant table the build matrix is generated from.
 *
 * It lives in the `prepare` job's shell rather than in `strategy.matrix`,
 * because a workflow_dispatch may ask for one variant and GitHub cannot filter
 * a literal matrix by an input. Read back out of that script here, so the guard
 * that this list matches the repo root survives the indirection.
 */
function matrixVariants(): { variant: string; dockerfile: string; suffix: string }[] {
  const step = (dockerWorkflow.jobs["prepare"]?.steps ?? []).find((entry) => entry.id === "variants");
  const table = /VARIANTS='(\[[^']*\])'/.exec(step?.run ?? "")?.[1];
  if (!table) throw new Error("prepare has no `variants` step declaring a VARIANTS='[...]' table");
  return JSON.parse(table) as { variant: string; dockerfile: string; suffix: string }[];
}

describe("published image variants", () => {
  test("the repo root holds exactly the three variants that are published", () => {
    // Pinned so a new Dockerfile is a conscious edit: it has to be added to the
    // CI matrix, the tag tables in DOCKERHUB.md and docs/DISTRIBUTION.md, and
    // the payload deny-list, none of which this file can do for it.
    expect(VARIANTS).toEqual(["Dockerfile", "Dockerfile.alpine", "Dockerfile.alpine-slim"]);
  });

  test.each(VARIANTS)("%s stages Monaco before its direct next build", (variant) => {
    // Instructions, not the raw text: every one of these files explains in prose
    // why it calls `next build` directly, and a comment that names the step ahead
    // of the staging line would pass or fail this on its wording.
    const build = instructions(readRepoFile(variant)).join("\n");

    expect(build).toContain("scripts/copy-monaco.mjs");
    expect(build.indexOf("scripts/copy-monaco.mjs")).toBeLessThan(build.indexOf("next build"));
  });

  test.each(VARIANTS)("%s removes nothing from the staged Monaco tree", (variant) => {
    const touchingMonaco = commands(readRepoFile(variant)).filter((line) => line.includes("public/monaco"));

    // The whole staged tree, not just the workers: `copy-monaco.mjs` stages what
    // the AMD loader resolves, and which parts of it a given page pulls is the
    // loader's business, not a packaging decision. An instruction that ASSERTS
    // the tree's contents is fine and is what this file's slim variant uses.
    for (const line of touchingMonaco) {
      expect(line).not.toMatch(/\brm\b|-delete\b|\bmv\b/);
    }
  });

  test.each(VARIANTS)("%s copies the shared entrypoint and the bind-address resolver", (variant) => {
    const dockerfile = readRepoFile(variant);

    expect(dockerfile).toContain("docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh");
    expect(dockerfile).toContain("docker/bind-address.mjs /usr/local/lib/libredb-studio/bind-address.mjs");
    expect(dockerfile).toContain('ENTRYPOINT ["docker-entrypoint.sh"]');
    expect(dockerfile).toContain('CMD ["node", "server.js"]');
  });

  test.each(VARIANTS)("%s starts as root so the entrypoint can chown the volume and drop privileges", (variant) => {
    const dockerfile = readRepoFile(variant);

    // docker-entrypoint.sh branches on `id -u`: as root it chowns the mounted
    // data directory and execs through gosu, otherwise it just execs. A USER
    // instruction would take the first branch away silently, and a root-owned
    // volume would then fail with "unable to open database file".
    expect(instructions(dockerfile).some((line) => /^USER\s/.test(line))).toBe(false);
    // The "nobody chose" sentinel for the bind resolver (issue #432).
    expect(dockerfile).toContain('ENV HOSTNAME=""');
  });

  test.each(VARIANTS)("%s prunes the repo tree out of the payload it ships", (variant) => {
    // Next's output file tracing sweeps the repository root into
    // `.next/standalone`, which the runner unpacks onto /app, so without this
    // step every image carries `src/`, `scripts/`, the lockfile, the tooling
    // configs and its own Dockerfiles. Shipping application source in a
    // production image is a security property before it is a size one, and the
    // deny-list already exists for the release tarballs (issue #124) - the
    // images invoke it rather than reimplementing it, so one list serves both
    // artifact families.
    const prunes = commands(readRepoFile(variant)).some((line) => line.includes("prune-standalone-payload.sh"));

    expect(prunes).toBe(true);
  });

  test.each(VARIANTS)("%s drops the README artwork no running container serves", (variant) => {
    // 4.4 MB of screenshots for the README and the marketing pages.
    // src/app/layout.tsx points social previews at raw.githubusercontent.com, so
    // nothing ever requests them from the app's own origin.
    const drops = commands(readRepoFile(variant)).some((line) => /rm -rf[^;]*public\/screenshots/.test(line));

    expect(drops).toBe(true);
  });

  test.each(VARIANTS)("%s ships only the native payload it can load", (variant) => {
    const cmds = commands(readRepoFile(variant));
    const removes = (needle: RegExp) => cmds.some((line) => needle.test(line) && /\brm\b|-delete\b/.test(line));

    // Measured in the published Debian image on 2026-09-18: 71 MB of musl
    // DuckDB bindings, 19 MB of musl libvips and six unloadable better-sqlite3
    // prebuilds, none of which any process in a glibc image can open. Neither
    // DuckDB bindings package declares a libc field, so bun installs both
    // whatever the stage runs on, and sharp ships the same way.
    expect(removes(/@duckdb/)).toBe(true);
    expect(removes(/@img/)).toBe(true);
    expect(removes(/better-sqlite3\/prebuilds/)).toBe(true);
    // The SQLite amalgamation the package would COMPILE from. better-sqlite3 13
    // is N-API and loads a prebuild, so it is 9.9 MB of C nothing reads.
    expect(removes(/better-sqlite3\/deps/)).toBe(true);
  });

  test.each(VARIANTS)("%s derives the surviving prebuild from the build arch", (variant) => {
    // A literal arch would silently break the arm64 leg of the manifest, which
    // is built on the same file by the same job.
    expect(readRepoFile(variant)).toContain("node -p 'process.arch'");
  });

  test.each(VARIANTS)("%s names no per-arch native package", (variant) => {
    // The deps stage installs only the package matching the build arch, so a
    // hardcoded platform name silently breaks the arm64 leg of the manifest.
    // Instructions only: the comments name the literal precisely because it is
    // the one that must not be executed.
    for (const line of instructions(readRepoFile(variant))) {
      expect(line).not.toContain("node-bindings-linux-x64");
    }
  });

  // db2-node (#786) is one package with eight addons at its root, and file
  // tracing copies all eight into the standalone tree, so every variant prunes
  // that tree to the one addon its libc and arch can load, then proves it.
  const db2Libc = (variant: string) => (variant === "Dockerfile" ? "gnu" : "musl");

  test.each(VARIANTS)("%s prunes db2-node to the addon it loads", (variant) => {
    const cmds = commands(readRepoFile(variant));
    const keep = `! -name "db2-node.linux-\${ARCH}-${db2Libc(variant)}.node" -delete`;

    expect(cmds.some((line) => line.includes(".next/standalone/node_modules/db2-node") && line.includes(keep))).toBe(
      true,
    );
  });

  test.each(VARIANTS)("%s asserts the one db2-node addon in the standalone tree", (variant) => {
    const cmds = commands(readRepoFile(variant));

    // The standalone path, not the builder's own node_modules: that is the tree
    // the runner copies, and asserting the other one proves nothing about it.
    expect(cmds).toContain(
      `test -f ".next/standalone/node_modules/db2-node/db2-node.linux-\${ARCH}-${db2Libc(variant)}.node"`,
    );
    expect(cmds).toContain(`test "$(find .next/standalone/node_modules/db2-node -name '*.node' | wc -l)" -eq 1`);
  });

  test.each(VARIANTS)("%s load-probes db2-node with the runtime that serves it", (variant) => {
    const lines = instructions(readRepoFile(variant));
    if (variant === "Dockerfile.alpine-slim") {
      // The runner is alpine with Alpine's own nodejs, not the builder's node
      // image, so only a probe in the runner proves the addon's libgcc_s.
      const copy = lines.findIndex((line) => line.includes("/usr/src/app/.next/standalone ./"));
      const probe = lines.indexOf(`RUN node -e "require('/app/node_modules/db2-node')"`);
      expect(copy).toBeGreaterThan(-1);
      expect(probe).toBeGreaterThan(copy);
    } else {
      expect(commands(readRepoFile(variant))).toContain(
        `node -e "require('/usr/src/app/.next/standalone/node_modules/db2-node')"`,
      );
    }
  });

  test.each(VARIANTS)("%s names no per-arch db2-node addon", (variant) => {
    for (const line of instructions(readRepoFile(variant))) {
      expect(line).not.toMatch(/db2-node\.linux-(x64|arm64)/);
    }
  });

  test.each(VARIANTS)("%s ships the third-party notices", (variant) => {
    // The db2-node tarball carries no notices for the crates in its addons.
    expect(instructions(readRepoFile(variant))).toContainEqual(
      expect.stringMatching(/^COPY .*\/usr\/src\/app\/THIRD_PARTY_NOTICES\.txt \.\/THIRD_PARTY_NOTICES\.txt$/),
    );
  });

  test("the Docker build matrix builds every variant, and only those", () => {
    expect(
      matrixVariants()
        .map((entry) => entry.dockerfile)
        .sort(),
    ).toEqual(VARIANTS);
  });

  test("the Channel E2E runs against exactly the matrix the build job used", () => {
    // Not "the same list" but the same OUTPUT: a single-variant re-dispatch must
    // browser-test the variant it rebuilt, and no other. The browser test is
    // what would have caught the editor defect above, and it only catches it on
    // the image it is pointed at.
    const built = String(dockerWorkflow.jobs["build-and-push"]?.strategy?.matrix ?? "");
    const tested = String(dockerWorkflow.jobs["channel-e2e"]?.strategy?.matrix ?? "");

    expect(built).toContain("needs.prepare.outputs.variants");
    expect(tested).toBe(built);
  });

  test("each variant publishes under its own tag suffix, cached in its own scope", () => {
    const included = matrixVariants();
    const suffixes = included.map((entry) => entry.suffix ?? "");

    // The default image keeps the bare tag; the others must differ from it and
    // from each other, or one variant overwrites another's `latest`.
    expect(new Set(suffixes).size).toBe(included.length);
    expect(suffixes).toContain("");
    // A shared gha cache scope makes three builds evict each other's layers.
    expect(new Set(included.map((entry) => entry.variant)).size).toBe(included.length);
  });

  test("one variant can be rebuilt on its own, without touching the others' tags", () => {
    // The recovery this exists for: `fail-fast: false` means a failed leg can sit
    // beside two that published, and re-dispatching all three would re-push
    // version tags the Docker Hub mirror has already frozen (its immutability
    // rule is semver-scoped, and `0.16.1-alpine` matches it). buildx exports
    // every tag in one step, so one rejected mirror tag fails the whole job.
    const input = (dockerWorkflow.on as { workflow_dispatch?: { inputs?: Record<string, unknown> } })?.workflow_dispatch
      ?.inputs?.variant;
    const resolve = (dockerWorkflow.jobs["prepare"]?.steps ?? []).find((step) => step.id === "variants");

    expect(input).toBeDefined();
    // An unrecognized variant must stop the run rather than silently build none.
    expect(resolve?.run).toContain("exit 1");
  });

  test("a single-variant rebuild does not re-release the chart", () => {
    // helm-release deploys the image; dispatching it again for a re-pushed
    // -alpine tag would republish a chart whose contents did not change, and
    // #167 then blocks the retry that a real chart change needs.
    const dispatch = dockerWorkflow.jobs["dispatch-helm-release"];

    expect(String(dispatch?.if)).toContain("variant");
  });

  test("the payload deny-list drops every root Dockerfile, not just the default one", () => {
    const prune = readRepoFile("scripts/lib/prune-standalone-payload.sh");

    // Next's output file tracing sweeps the repo root into `.next/standalone`,
    // so each of these ships inside every payload-derived artifact (release
    // tarballs, .deb/.rpm, snap, npx cache) unless the deny-list covers it. A
    // literal `Dockerfile` entry covered one of three.
    expect(prune).toContain('"$PAYLOAD_DIR"/Dockerfile*');
  });
});
