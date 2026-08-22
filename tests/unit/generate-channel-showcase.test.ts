/**
 * Unit tests for the login-page channel showcase generator
 * (scripts/generate-channel-showcase.mjs, distribution/channels.yaml ->
 * src/lib/distribution/channels.generated.ts).
 *
 * The building blocks (groupForCategory, buildShowcase, renderModule) are pure
 * and tested against inline yaml fixtures; the CLI describe block runs the real
 * script as a subprocess against throwaway temp-dir fixtures, exactly like
 * tests/unit/distribution-check.test.ts does. The last block is the one that
 * makes the committed artefact trustworthy in review: it regenerates from the
 * real inventory and asserts the checked-in module is byte-identical.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_CHANNELS, LIVE_PLATFORMS } from "../../src/lib/distribution/channels.generated";
import {
  CATEGORY_GROUPS,
  SHOWCASE_PLATFORMS,
  buildShowcase,
  groupForCategory,
  renderModule,
} from "../../scripts/generate-channel-showcase.mjs";

const SCRIPT = join(import.meta.dir, "../../scripts/generate-channel-showcase.mjs");
const REPO_ROOT = join(import.meta.dir, "../..");
const GENERATED = "src/lib/distribution/channels.generated.ts";

function channelsYaml(rows: string): string {
  return `channels:\n${rows}`;
}

/** Minimal row: only the fields the generator reads (the full schema is validated by distribution-check.mjs). */
function row({
  id,
  name,
  status = "live",
  category = "containers",
  platforms = "[container]",
  shortName,
}: {
  id: string;
  name: string;
  status?: string;
  category?: string;
  platforms?: string;
  shortName?: string;
}): string {
  const short = shortName === undefined ? "" : `    short_name: ${shortName}\n`;
  return `  - id: ${id}
    name: ${name}
${short}    status: ${status}
    category: ${category}
    platforms: ${platforms}
`;
}

describe("groupForCategory", () => {
  test("maps every category docs/CHANNELS.md defines onto a UI group", () => {
    expect(groupForCategory("containers")).toBe("containers");
    expect(groupForCategory("kubernetes-operators")).toBe("kubernetes");
    expect(groupForCategory("paas-catalogs")).toBe("paas");
    expect(groupForCategory("deploy-recipes")).toBe("paas");
    expect(groupForCategory("cloud-marketplaces")).toBe("paas");
    expect(groupForCategory("package-managers")).toBe("packages");
    expect(groupForCategory("os-desktop")).toBe("packages");
    expect(groupForCategory("registries-releases")).toBe("packages");
  });

  test("throws on an unknown category instead of defaulting it into a group", () => {
    expect(() => groupForCategory("browser-extensions")).toThrow(/unknown category 'browser-extensions'/);
  });

  test("the map covers exactly the categories the inventory uses", () => {
    const used = new Set(
      readFileSync(join(REPO_ROOT, "distribution/channels.yaml"), "utf8")
        .split("\n")
        .filter((line) => line.trimStart().startsWith("category:"))
        .map((line) => line.split(":")[1].trim()),
    );
    for (const category of used) {
      expect(Object.keys(CATEGORY_GROUPS)).toContain(category);
    }
  });
});

describe("buildShowcase", () => {
  test("keeps live channels and drops pending and deprecated ones", () => {
    const showcase = buildShowcase(
      channelsYaml(
        row({ id: "docker-ghcr", name: "Docker image" }) +
          row({ id: "chocolatey", name: "Chocolatey", status: "pending", category: "package-managers" }) +
          row({ id: "flathub", name: "Flathub", status: "deprecated", category: "package-managers" }),
      ),
    );
    expect(showcase.channels.map((channel: { id: string }) => channel.id)).toEqual(["docker-ghcr"]);
  });

  test("labels a channel with short_name, falling back to name", () => {
    const showcase = buildShowcase(
      channelsYaml(
        row({ id: "docker-ghcr", name: "Docker image (GHCR, canonical)", shortName: "Docker image (GHCR)" }) +
          row({ id: "railway", name: "Railway one-click template", category: "paas-catalogs", platforms: "[cloud]" }),
      ),
    );
    expect(showcase.channels).toEqual([
      { id: "docker-ghcr", label: "Docker image (GHCR)", group: "containers" },
      { id: "railway", label: "Railway one-click template", group: "paas" },
    ]);
  });

  test("deduplicates platforms and orders them canonically, ignoring yaml order", () => {
    const showcase = buildShowcase(
      channelsYaml(
        row({ id: "helm", name: "Helm chart", category: "kubernetes-operators", platforms: "[kubernetes]" }) +
          row({ id: "npm", name: "npm package", category: "registries-releases", platforms: "[windows, linux]" }) +
          row({ id: "brew", name: "Homebrew tap", category: "package-managers", platforms: "[macos, linux]" }),
      ),
    );
    expect(showcase.platforms).toEqual(["linux", "macos", "windows", "kubernetes"]);
  });

  test("counts platforms of live channels only", () => {
    const showcase = buildShowcase(
      channelsYaml(
        row({ id: "docker-ghcr", name: "Docker image" }) +
          row({
            id: "azure",
            name: "Azure Marketplace",
            status: "pending",
            category: "cloud-marketplaces",
            platforms: "[cloud]",
          }),
      ),
    );
    expect(showcase.platforms).toEqual(["container"]);
  });

  test("throws when the top-level channels list is missing", () => {
    expect(() => buildShowcase("channels: {}\n")).toThrow(/top-level 'channels' list is missing/);
  });

  test("throws on a platform outside the canonical list", () => {
    expect(() =>
      buildShowcase(channelsYaml(row({ id: "docker-ghcr", name: "Docker image", platforms: "[toaster]" }))),
    ).toThrow(/platforms entries must be one of/);
  });

  test("SHOWCASE_PLATFORMS is the canonical order documented in channels.yaml", () => {
    expect(SHOWCASE_PLATFORMS).toEqual(["linux", "macos", "windows", "container", "kubernetes", "cloud"]);
  });
});

describe("renderModule", () => {
  const rendered = renderModule(
    buildShowcase(channelsYaml(row({ id: "docker-ghcr", name: "Docker image", shortName: "Docker image (GHCR)" }))),
  );

  test("carries the do-not-edit banner naming the regenerating command", () => {
    expect(rendered.startsWith("// GENERATED FILE - do not edit. Run: bun run channels:showcase\n")).toBe(true);
  });

  test("emits the channel and platform constants", () => {
    expect(rendered).toContain(`{ id: "docker-ghcr", label: "Docker image (GHCR)", group: "containers" },`);
    expect(rendered).toContain(`export const LIVE_PLATFORMS: readonly ShowcasePlatform[] = ["container"];`);
  });

  test("ends with exactly one trailing newline", () => {
    expect(rendered.endsWith("];\n")).toBe(true);
    expect(rendered.endsWith("];\n\n")).toBe(false);
  });
});

describe("CLI (subprocess against temp fixtures)", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeFixture(rows: string): string {
    const root = mkdtempSync(join(tmpdir(), "channel-showcase-"));
    fixtureRoots.push(root);
    mkdirSync(join(root, "distribution"), { recursive: true });
    mkdirSync(join(root, "src/lib/distribution"), { recursive: true });
    writeFileSync(join(root, "distribution/channels.yaml"), channelsYaml(rows));
    return root;
  }

  function run(root: string, args: string[] = []) {
    return Bun.spawnSync(["node", SCRIPT, "--root", root, ...args], { stdout: "pipe", stderr: "pipe" });
  }

  test("writes the generated module and reports what it wrote", () => {
    const root = makeFixture(row({ id: "docker-ghcr", name: "Docker image" }));
    const result = run(root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(GENERATED);
    expect(readFileSync(join(root, GENERATED), "utf8")).toContain(`id: "docker-ghcr"`);
  });

  test("--check passes when the committed file is current", () => {
    const root = makeFixture(row({ id: "docker-ghcr", name: "Docker image" }));
    expect(run(root).exitCode).toBe(0);
    const result = run(root, ["--check"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("up to date");
  });

  test("--check exits 1 on drift and names the command that fixes it", () => {
    const root = makeFixture(row({ id: "docker-ghcr", name: "Docker image" }));
    expect(run(root).exitCode).toBe(0);
    writeFileSync(join(root, "distribution/channels.yaml"), channelsYaml(row({ id: "helm", name: "Helm chart" })));
    const result = run(root, ["--check"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("bun run channels:showcase");
  });

  test("--check exits 1 when the generated file does not exist yet", () => {
    const root = makeFixture(row({ id: "docker-ghcr", name: "Docker image" }));
    const result = run(root, ["--check"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("bun run channels:showcase");
  });

  test("a read failure that is not ENOENT surfaces instead of reading as stale", () => {
    // Only "the file is not there yet" may be swallowed. A directory sitting where the
    // generated module belongs is a broken checkout, and reporting it as drift would send
    // the reader off to run the generator - which would fail the same way, with no clue.
    const root = makeFixture(row({ id: "docker-ghcr", name: "Docker image" }));
    mkdirSync(join(root, GENERATED), { recursive: true });
    const result = run(root, ["--check"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("EISDIR");
    expect(result.stderr.toString()).not.toContain("bun run channels:showcase");
  });

  test("--root without a directory is a usage error", () => {
    const result = Bun.spawnSync(["node", SCRIPT, "--root"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("--root requires a directory path");
  });

  test("an unknown category fails the run loudly", () => {
    const root = makeFixture(row({ id: "extension", name: "Browser extension", category: "browser-extensions" }));
    const result = run(root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unknown category 'browser-extensions'");
  });
});

describe("committed artefact", () => {
  test("src/lib/distribution/channels.generated.ts matches a fresh generation", () => {
    const yamlText = readFileSync(join(REPO_ROOT, "distribution/channels.yaml"), "utf8");
    expect(readFileSync(join(REPO_ROOT, GENERATED), "utf8")).toBe(renderModule(buildShowcase(yamlText)));
  });

  test("exports the live inventory the login hero renders", () => {
    expect(LIVE_CHANNELS.length).toBeGreaterThan(0);
    expect(LIVE_PLATFORMS.length).toBeGreaterThan(0);
    // Every rendered group must be one the hero has a row for.
    for (const channel of LIVE_CHANNELS) {
      expect(["containers", "kubernetes", "paas", "packages"]).toContain(channel.group);
    }
    for (const platform of LIVE_PLATFORMS) {
      expect(SHOWCASE_PLATFORMS).toContain(platform);
    }
  });
});
