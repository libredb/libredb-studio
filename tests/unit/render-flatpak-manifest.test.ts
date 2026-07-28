/**
 * Unit tests for the Flatpak manifest renderer
 * (scripts/render-flatpak-manifest.mjs, issue #232). Renders the real template
 * against fixture checksums and asserts the result is a valid manifest for the
 * AppImage-repack pattern - pure string/YAML work, no network.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import {
  APP_ID,
  appImageName,
  localizeFlatpakManifest,
  renderFlatpakManifest,
} from "../../scripts/render-flatpak-manifest.mjs";

const TEMPLATE_PATH = path.join(__dirname, "../../packaging/flatpak/org.libredb.Studio.yml.tmpl");
const template = fs.readFileSync(TEMPLATE_PATH, "utf8");

const VERSION = "0.9.60";
const DIGESTS = { x64: "a".repeat(64), arm64: "b".repeat(64) };

function fixtureSums(digests: Record<string, string> = DIGESTS, version = VERSION): string {
  return (
    Object.entries(digests)
      .map(([arch, digest]) => `${digest}  libredb-studio-desktop-${version}-linux-${arch}.AppImage`)
      .join("\n") + "\n"
  );
}

interface ManifestSource {
  type: string;
  "only-arches"?: string[];
  url?: string;
  sha256?: string;
  path?: string;
  "dest-filename"?: string;
  "x-checker-data"?: { type: string; url: string; "version-query": string; "url-query": string };
}

interface Manifest {
  "app-id": string;
  runtime: string;
  "runtime-version": string;
  sdk: string;
  command: string;
  "finish-args": string[];
  modules: { name: string; buildsystem: string; "build-commands": string[]; sources: ManifestSource[] }[];
}

function renderAndParse(sums = fixtureSums(), version = VERSION): Manifest {
  return parseYaml(renderFlatpakManifest(template, sums, version)) as Manifest;
}

describe("appImageName", () => {
  test("mirrors the release asset naming convention", () => {
    expect(appImageName("0.9.60", "x64")).toBe("libredb-studio-desktop-0.9.60-linux-x64.AppImage");
    expect(appImageName("0.9.60", "arm64")).toBe("libredb-studio-desktop-0.9.60-linux-arm64.AppImage");
  });
});

describe("renderFlatpakManifest", () => {
  test("fills the version and both architecture digests", () => {
    const rendered = renderFlatpakManifest(template, fixtureSums(), VERSION);
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain("}}");

    const manifest = parseYaml(rendered) as Manifest;
    const sources = manifest.modules[0].sources;
    const x64 = sources.find((source) => source["only-arches"]?.includes("x86_64"));
    const arm64 = sources.find((source) => source["only-arches"]?.includes("aarch64"));

    expect(x64?.url).toBe(
      `https://github.com/libredb/libredb-studio/releases/download/${VERSION}/${appImageName(VERSION, "x64")}`,
    );
    expect(x64?.sha256).toBe(DIGESTS.x64);
    expect(arm64?.url).toBe(
      `https://github.com/libredb/libredb-studio/releases/download/${VERSION}/${appImageName(VERSION, "arm64")}`,
    );
    expect(arm64?.sha256).toBe(DIGESTS.arm64);
  });

  test("keeps the manifest shape Flathub requires", () => {
    const manifest = renderAndParse();
    expect(manifest["app-id"]).toBe(APP_ID);
    // Tauri links against the system WebKitGTK, which only the GNOME runtime ships.
    expect(manifest.runtime).toBe("org.gnome.Platform");
    expect(manifest.sdk).toBe("org.gnome.Sdk");
    expect(manifest["runtime-version"]).toBe("50");
    expect(manifest.command).toBe("libredb-studio");
    expect(manifest.modules).toHaveLength(1);
    expect(manifest.modules[0].buildsystem).toBe("simple");
  });

  test("requests the minimum sandbox permissions and no filesystem access", () => {
    const finishArgs = renderAndParse()["finish-args"];
    expect(finishArgs).toEqual(
      expect.arrayContaining([
        "--share=ipc",
        "--share=network",
        "--socket=wayland",
        "--socket=fallback-x11",
        "--device=dri",
      ]),
    );
    // Static host/home access is the most-scrutinized Flathub permission; the
    // desktop app connects over TCP and documents `flatpak override` instead.
    expect(finishArgs.some((arg) => arg.startsWith("--filesystem="))).toBe(false);
  });

  test("wires the external data checker at the release asset for each arch", () => {
    const sources = renderAndParse().modules[0].sources;
    for (const [assetArch, flatpakArch] of [
      ["x64", "x86_64"],
      ["arm64", "aarch64"],
    ]) {
      const source = sources.find((entry) => entry["only-arches"]?.includes(flatpakArch));
      expect(source?.["dest-filename"]).toBe("libredb-studio.AppImage");
      const checker = source?.["x-checker-data"];
      expect(checker?.type).toBe("json");
      expect(checker?.url).toBe("https://api.github.com/repos/libredb/libredb-studio/releases/latest");
      // Release tags in this repo carry no "v" prefix, so no jq stripping.
      expect(checker?.["version-query"]).toBe(".tag_name");
      expect(checker?.["url-query"]).toContain(`libredb-studio-desktop-" + $version + "-linux-${assetArch}.AppImage`);
    }
  });

  test("ships the desktop entry, metainfo and launcher as local sources", () => {
    const paths = renderAndParse()
      .modules[0].sources.map((source) => source.path)
      .filter(Boolean);
    expect(paths).toEqual(
      expect.arrayContaining(["libredb-studio.sh", "org.libredb.Studio.desktop", "org.libredb.Studio.metainfo.xml"]),
    );
  });

  test("throws when a digest for an architecture is missing", () => {
    const partial = { x64: DIGESTS.x64 };
    expect(() => renderFlatpakManifest(template, fixtureSums(partial), VERSION)).toThrow(
      `has no entry for ${appImageName(VERSION, "arm64")}`,
    );
  });

  test("throws when the version is not release semver", () => {
    expect(() => renderFlatpakManifest(template, fixtureSums(), "v0.9.60")).toThrow("not a valid semver");
    expect(() => renderFlatpakManifest(template, fixtureSums(), "0.9")).toThrow("not a valid semver");
  });

  test("throws when the digests belong to a different version", () => {
    expect(() => renderFlatpakManifest(template, fixtureSums(DIGESTS, "0.9.59"), VERSION)).toThrow("has no entry for");
  });

  test("throws when a placeholder survives rendering", () => {
    const broken = `${template}\n# stray {{SHA256_LINUX_RISCV}}\n`;
    expect(() => renderFlatpakManifest(broken, fixtureSums(), VERSION)).toThrow("Unfilled placeholder");
  });
});

describe("localizeFlatpakManifest", () => {
  const rendered = renderFlatpakManifest(template, fixtureSums(), VERSION);

  test("swaps the remote source for a local file and drops the other arch", () => {
    const localized = parseYaml(localizeFlatpakManifest(rendered, "x86_64", "libredb-studio.AppImage")) as Manifest;
    const sources = localized.modules[0].sources;
    const appImage = sources.find((source) => source["dest-filename"] === "libredb-studio.AppImage");

    expect(appImage?.path).toBe("libredb-studio.AppImage");
    expect(appImage?.url).toBeUndefined();
    expect(appImage?.sha256).toBeUndefined();
    // A local build must not consult the update checker either.
    expect(appImage?.["x-checker-data"]).toBeUndefined();
    expect(appImage?.["only-arches"]).toBeUndefined();
    expect(sources.filter((source) => source["dest-filename"] === "libredb-studio.AppImage")).toHaveLength(1);
  });

  test("keeps the launcher, desktop entry and metainfo sources", () => {
    const localized = parseYaml(localizeFlatpakManifest(rendered, "aarch64", "../../dist/local.AppImage")) as Manifest;
    const paths = localized.modules[0].sources.map((source) => source.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "../../dist/local.AppImage",
        "libredb-studio.sh",
        "org.libredb.Studio.desktop",
        "org.libredb.Studio.metainfo.xml",
      ]),
    );
  });

  test("throws for an architecture the manifest does not build", () => {
    expect(() => localizeFlatpakManifest(rendered, "riscv64", "local.AppImage")).toThrow("riscv64");
  });
});
