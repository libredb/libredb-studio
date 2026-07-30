/**
 * Unit tests for the staged FlatPark registry descriptor set
 * (packaging/flatpark, issue #241).
 *
 * FlatPark repackages a published release asset as Flatpak extra-data: the
 * manifest pins a .deb by URL and digest, the user's machine downloads it at
 * install time, and apply_extra unpacks it inside the sandbox with only the
 * tools org.gnome.Platform provides. Nothing here reaches the network - these
 * assert the internal consistency that a typo would otherwise break only on
 * someone else's machine, days later, in an upstream PR.
 *
 * Deliberately NOT asserted: that the pinned version equals package.json. The
 * GUI .deb first ships in a later release than the one this branch sits on, and
 * once the upstream PR merges FlatPark's own bot owns the pin - see
 * packaging/flatpark/README.md.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

const APP_ID = "org.libredb.Studio";
const DIR = path.join(__dirname, "../../packaging/flatpark");

const read = (name: string): string => fs.readFileSync(path.join(DIR, name), "utf8");

interface ExtraDataSource {
  type: string;
  filename?: string;
  url?: string;
  sha256?: string;
  size?: number;
  path?: string;
  "only-arches"?: string[];
}

interface Manifest {
  id: string;
  runtime: string;
  "runtime-version": string;
  sdk: string;
  command: string;
  "finish-args": string[];
  modules: { name: string; buildsystem: string; "build-commands": string[]; sources: ExtraDataSource[] }[];
}

const descriptor = parseYaml(read("flatpark.yml")) as {
  id: string;
  name: string;
  summary: string;
  website: string;
  source_url: string;
  build: { manifest: string; branch: string; mode: string };
  catalog: { category: string; tags: string[] };
  update: { command: string };
  policy: { proprietary: boolean; extra_data_first: boolean; dangerous_permissions: string[] };
};
const manifest = parseYaml(read(`${APP_ID}.yml`)) as Manifest;
const module0 = manifest.modules[0];
const extraData = module0.sources.filter((s) => s.type === "extra-data");
const fileSources = module0.sources.filter((s) => s.type === "file");

describe("flatpark.yml catalog descriptor (#241)", () => {
  test("identifies the app by the same id the manifest and file names use", () => {
    expect(descriptor.id).toBe(APP_ID);
    expect(descriptor.build.manifest).toBe(`${APP_ID}.yml`);
    expect(manifest.id).toBe(APP_ID);
  });

  test("declares the fields FlatPark's descriptor reader requires", () => {
    expect(descriptor.name).toBeTruthy();
    expect(descriptor.summary).toBeTruthy();
    expect(descriptor.website).toStartWith("https://");
    expect(descriptor.source_url).toStartWith("https://");
    expect(descriptor.build.branch).toBe("stable");
    expect(descriptor.build.mode).toBe("extra-data");
    expect(descriptor.catalog.tags.length).toBeGreaterThan(0);
  });

  test("points update.command at a resolver that exists and is executable", () => {
    // FlatPark runs this relative to the registry directory.
    expect(descriptor.update.command).toMatch(/^\.\/[A-Za-z0-9._-]+$/);
    const resolver = descriptor.update.command.replace(/^\.\//, "");
    const stat = fs.statSync(path.join(DIR, resolver));
    expect(stat.isFile()).toBe(true);
    // Any execute bit: FlatPark invokes it directly, not through a shell.
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  test("stays readable by a line scanner, not just by a YAML parser", () => {
    // FlatPark's read-descriptor.mjs scans lines with regexes rather than
    // parsing YAML, so constructs a real parser accepts - flow style, anchors,
    // block scalars - would round-trip fine here and still read as empty
    // upstream. The file says so in a comment; this is what enforces it.
    const raw = read("flatpark.yml");
    const body = raw.split("\n").filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));

    for (const line of body) {
      // Anchors and aliases.
      expect(line).not.toMatch(/:\s*[&*]/);
      // Flow style with content. A bare `[]` is fine and is what the reference
      // descriptors use for an empty dangerous_permissions.
      expect(line).not.toMatch(/:\s*\[\s*[^\]\s]/);
      expect(line).not.toMatch(/:\s*\{/);
      // Block scalars.
      expect(line).not.toMatch(/:\s*[|>][-+]?\s*$/);
      // Two-space block indentation only: a tab, or an odd indent, is exactly
      // what a naive scanner misreads.
      expect(line).not.toContain("\t");
      expect((line.match(/^ */) as RegExpMatchArray)[0].length % 2).toBe(0);
    }

    // The keys their scanner extracts must each sit on their own plain line.
    expect(raw).toMatch(/^id: org\.libredb\.Studio$/m);
    expect(raw).toMatch(/^name: .+$/m);
    expect(raw).toMatch(/^summary: .+$/m);
    expect(raw).toMatch(/^ {2}manifest: .+$/m);
    expect(raw).toMatch(/^ {2}command: \.\/.+$/m);
  });

  test("claims no dangerous permissions, matching finish-args", () => {
    expect(descriptor.policy.proprietary).toBe(false);
    expect(descriptor.policy.extra_data_first).toBe(true);
    expect(descriptor.policy.dangerous_permissions).toEqual([]);
  });
});

describe("org.libredb.Studio.yml manifest (#241)", () => {
  test("targets the GNOME runtime, which is the only one shipping webkit2gtk-4.1", () => {
    expect(manifest.runtime).toBe("org.gnome.Platform");
    expect(manifest.sdk).toBe("org.gnome.Sdk");
    // Quoted in YAML so it stays a string: an unquoted 50 parses as a number
    // and flatpak-builder then refuses the manifest.
    expect(manifest["runtime-version"]).toBe("50");
    expect(typeof manifest["runtime-version"]).toBe("string");
  });

  test("runs the wrapper, not the shell binary directly", () => {
    expect(manifest.command).toBe("libredb-studio");
    expect(module0["build-commands"]).toContain("install -Dm755 libredb-studio-wrapper /app/bin/libredb-studio");
  });

  test("keeps the managed extra-data markers FlatPark's bot rewrites between", () => {
    const raw = read(`${APP_ID}.yml`);
    expect(raw).toContain("# BEGIN MANAGED EXTRA-DATA");
    expect(raw).toContain("# END MANAGED EXTRA-DATA");
    expect(raw.indexOf("# BEGIN MANAGED EXTRA-DATA")).toBeLessThan(raw.indexOf("# END MANAGED EXTRA-DATA"));
  });

  test("pins exactly one extra-data archive, fully specified", () => {
    expect(extraData).toHaveLength(1);
    const [source] = extraData;
    expect(source.filename).toBe("libredb-studio-desktop.deb");
    expect(source["only-arches"]).toEqual(["x86_64"]);
    // A digest of all digits parses as a number unless it is quoted, and
    // flatpak-builder then rejects the manifest.
    expect(typeof source.sha256).toBe("string");
    expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof source.size).toBe("number");
  });

  test("the pin is either fully resolved or plainly unresolved, never half", () => {
    // The GUI .deb ships from a release later than this branch, so the pin is a
    // documented placeholder until then. What must never happen is a real digest
    // next to a zero size (or the reverse): Flatpak validates both, and a
    // half-updated pin fails on the user's machine at install time, not here.
    const [source] = extraData;
    const placeholderDigest = source.sha256 === "0".repeat(64);
    const placeholderSize = source.size === 0;
    expect(placeholderDigest).toBe(placeholderSize);
  });

  test("pins the desktop GUI package, never the headless server deb or the AppImage", () => {
    const [source] = extraData;
    expect(source.url).toStartWith("https://github.com/libredb/libredb-studio/releases/download/");
    // The GUI package name carries the -desktop suffix; the server package is
    // libredb-studio_<version>_<arch>.deb and would install a systemd unit.
    expect(source.url).toMatch(/\/libredb-studio-desktop_[0-9]+\.[0-9]+\.[0-9]+_amd64\.deb$/);
    expect(source.url).not.toContain(".AppImage");
  });

  test("pins a version the metainfo also lists as its newest release", () => {
    // FlatPark compares resolve-update.sh's resolved version against the
    // newest <release> in the metainfo, so a manifest pinned at a version the
    // metainfo has never heard of fails their audit.
    const [source] = extraData;
    const pinned = source.url?.match(/download\/([0-9]+\.[0-9]+\.[0-9]+)\//)?.[1];
    const newest = read(`${APP_ID}.metainfo.xml`).match(/<release version="([^"]+)"/)?.[1];
    expect(pinned).toBeTruthy();
    expect(newest).toBe(pinned);
  });

  test("asks for no permission that would defeat the sandbox", () => {
    const args = manifest["finish-args"];
    expect(args).toContain("--share=network");
    expect(args).toContain("--socket=wayland");
    expect(args).toContain("--socket=fallback-x11");
    for (const forbidden of [
      "--filesystem=host",
      "--filesystem=home",
      "--filesystem=/",
      "--talk-name=org.freedesktop.Flatpak",
      "--socket=session-bus",
      "--device=all",
    ]) {
      expect(args).not.toContain(forbidden);
    }
  });

  test("ships every local source it references, and references every file it ships", () => {
    const referenced = fileSources.map((s) => s.path).sort();
    for (const name of referenced) {
      expect(fs.existsSync(path.join(DIR, name as string))).toBe(true);
    }
    // Everything else in the directory has to be a declared source, or it is
    // simply not in the built app - an orphan file silently does nothing.
    // Excluded: README.md (ours, dropped when staging), flatpark.yml and the
    // manifest (read by FlatPark, not installed), and resolve-update.sh (run by
    // FlatPark's update bot outside any build).
    const notBuildInputs = ["README.md", "flatpark.yml", `${APP_ID}.yml`, "resolve-update.sh"];
    const onDisk = fs
      .readdirSync(DIR)
      .filter((f) => !notBuildInputs.includes(f))
      .sort();
    expect(referenced).toEqual(onDisk);
  });

  test("installs the desktop entry, metainfo and icon at build time", () => {
    // extra-data is fetched on the user's machine after the ref is built, so
    // anything Flatpak has to export must come from the manifest instead.
    const commands = module0["build-commands"].join("\n");
    expect(commands).toContain(`/app/share/applications/${APP_ID}.desktop`);
    expect(commands).toContain(`/app/share/metainfo/${APP_ID}.metainfo.xml`);
    expect(commands).toContain(`/app/share/icons/hicolor/256x256/apps/${APP_ID}.png`);
    expect(commands).toContain("install -Dm755 apply_extra.sh /app/bin/apply_extra");
  });
});

describe("apply_extra.sh install-time unpack (#241)", () => {
  const script = read("apply_extra.sh");

  test("unpacks with bsdtar, because the runtime has no ar or dpkg", () => {
    expect(script).toContain("bsdtar");
    expect(script).not.toMatch(/^\s*ar\s+x/m);
    expect(script).not.toContain("dpkg-deb");
  });

  test("drops archive ownership, which a system-wide install cannot restore", () => {
    expect(script).toContain("--no-same-owner");
  });

  test("verifies all three payload pieces before committing the unpack", () => {
    // A partially-extracted tree that still launches is the worst outcome: the
    // window opens and every query fails.
    expect(script).toContain("stage/usr/bin/libredb-studio-desktop");
    expect(script).toContain("stage/usr/bin/libredb-studio-node");
    expect(script).toContain("stage/usr/lib/libredb-studio-desktop/payload/server.js");
  });

  test("keeps the whole usr tree, which the shell's resource lookup depends on", () => {
    // The shell resolves resources as <exe dir>/../lib/<product name>, so
    // usr/bin has to stay next to usr/lib/libredb-studio-desktop.
    expect(script).toContain("mv stage/usr usr");
  });

  test("never bundles a sidecar named plain node", () => {
    // /usr/bin/node in a .deb collides with the distro nodejs package and makes
    // the package uninstallable on most developer machines.
    expect(script).not.toMatch(/\busr\/bin\/node\b/);
  });
});

describe("wrapper and update resolver (#241)", () => {
  test("the wrapper disables the DMABUF renderer, which paints a blank window", () => {
    const wrapper = read("libredb-studio-wrapper");
    expect(wrapper).toContain("export WEBKIT_DISABLE_DMABUF_RENDERER=1");
    expect(wrapper).toContain("exec /app/extra/usr/bin/libredb-studio-desktop");
  });

  test("the resolver emits the contract FlatPark parses, and hashes nothing", () => {
    const resolver = read("resolve-update.sh");
    expect(resolver).toContain("libredb/libredb-studio");
    expect(resolver).toContain('filename:"libredb-studio-desktop.deb"');
    // FlatPark downloads the URL and computes sha256/size itself.
    expect(resolver).not.toContain("sha256sum");
  });

  test("the resolver selects the GUI deb and cannot match the server deb", () => {
    const resolver = read("resolve-update.sh");
    const pattern = resolver.match(/test\("([^"]+)"\)/)?.[1];
    expect(pattern).toBeTruthy();
    const assetRe = new RegExp((pattern as string).replaceAll("\\\\", "\\"));
    expect(assetRe.test("libredb-studio-desktop_0.9.62_amd64.deb")).toBe(true);
    expect(assetRe.test("libredb-studio_0.9.62_amd64.deb")).toBe(false);
    expect(assetRe.test("libredb-studio-desktop_0.9.62_arm64.deb")).toBe(false);
    expect(assetRe.test("libredb-studio-desktop-0.9.62-linux-x64.AppImage")).toBe(false);
  });

  test("release tags are bare semver, so the resolver must not strip a v prefix", () => {
    expect(read("resolve-update.sh")).not.toContain('ltrimstr("v")');
  });
});

describe("release wiring for the pinned artifact (#241)", () => {
  const buildScript = fs.readFileSync(path.join(__dirname, "../../scripts/build-desktop-appimage.sh"), "utf8");
  const releaseWorkflow = fs.readFileSync(
    path.join(__dirname, "../../.github/workflows/release-artifacts.yml"),
    "utf8",
  );

  test("the build script emits the asset name the resolver looks for", () => {
    // These three have to agree or the channel breaks silently: the bundler
    // writes a name, release CI requires that name, and FlatPark's bot resolves
    // it. Only the last failure is visible to users.
    expect(buildScript).toContain('ASSET_DEB="libredb-studio-desktop_${VERSION}_${DEB_ARCH}.deb"');
    const built = "libredb-studio-desktop_0.9.62_amd64.deb";
    const pattern = read("resolve-update.sh").match(/test\("([^"]+)"\)/)?.[1] as string;
    expect(new RegExp(pattern.replaceAll("\\\\", "\\")).test(built)).toBe(true);
  });

  test("the desktop job builds into a scratch dir it can safely upload with a glob", () => {
    // The upload is `gh release upload <tag> <dir>/*`, so <dir> must contain
    // nothing but the artifacts. Pointing it at a tracked source directory
    // (desktop/ is the Tauri project) hands gh the repo's own files and
    // subdirectories: gh does not reject directory arguments, it fails while
    // reading them, which fails the job and blocks publish-release.
    const outDir = releaseWorkflow.match(/bash scripts\/build-desktop-appimage\.sh (\S+)/)?.[1];
    // Anchored on the step name: several jobs in this file upload with a glob,
    // and an unanchored match picks up whichever comes first.
    const uploadDir = releaseWorkflow.match(
      /Upload the desktop artifacts[\s\S]*?gh release upload "\$TAG" (\S+)\/\*/,
    )?.[1];
    expect(outDir).toBeTruthy();
    expect(uploadDir).toBe(outDir);
    const root = path.join(__dirname, "../..");
    // Nothing tracked lives under it. This is the hazard itself - a glob over a
    // directory holding checked-in files hands gh the repo's own sources - and
    // it reads the index, so it does not care whether the directory exists.
    const tracked = Bun.spawnSync(["git", "ls-files", "--", outDir as string], { cwd: root });
    expect(tracked.stdout.toString().trim()).toBe("");
    // And git is configured to keep it that way. The trailing slash is
    // load-bearing: .gitignore lists a directory-only pattern, and without it
    // check-ignore treats the argument as a file and misses on a fresh checkout
    // where the build has not run yet.
    const ignored = Bun.spawnSync(["git", "check-ignore", "-q", `${outDir}/`], { cwd: root });
    expect(ignored.exitCode).toBe(0);
  });

  test("release CI refuses to publish without both GUI debs", () => {
    for (const arch of ["amd64", "arm64"]) {
      expect(releaseWorkflow).toContain(`"libredb-studio-desktop_\${TAG}_${arch}.deb"`);
      expect(releaseWorkflow).toContain(`"libredb-studio-desktop_\${TAG}_${arch}.deb.sha256"`);
    }
  });

  test("the sidecar name is the same in the bundler config, the script and the shell", () => {
    const tauriConf = fs.readFileSync(path.join(__dirname, "../../desktop/src-tauri/tauri.conf.json"), "utf8");
    const layout = fs.readFileSync(path.join(__dirname, "../../desktop/src-tauri/src/layout.rs"), "utf8");
    expect(JSON.parse(tauriConf).bundle.externalBin).toEqual(["bin/libredb-studio-node"]);
    expect(buildScript).toContain('NODE_BIN="libredb-studio-node"');
    expect(layout).toContain('pub const NODE_BIN: &str = "libredb-studio-node";');
  });

  test("the Flathub manifest tolerates both sidecar names across the rename", () => {
    // Flathub's checker can re-render this template against a release from
    // before 0.9.62, whose AppImage still carries the old name.
    const tmpl = fs.readFileSync(path.join(__dirname, "../../packaging/flatpak/org.libredb.Studio.yml.tmpl"), "utf8");
    expect(tmpl).toContain("for candidate in libredb-studio-node node; do");
  });
});

describe("desktop entry and metainfo (#241)", () => {
  test("the desktop entry launches the wrapper and matches the exported icon name", () => {
    const desktop = read(`${APP_ID}.desktop`);
    expect(desktop).toContain("Exec=libredb-studio\n");
    expect(desktop).toContain(`Icon=${APP_ID}\n`);
    // Wayland/X11 window matching needs the binary's own class, not the app id.
    expect(desktop).toContain("StartupWMClass=libredb-studio-desktop\n");
  });

  test("the metainfo declares the id and launchable Flatpak exports it under", () => {
    const metainfo = read(`${APP_ID}.metainfo.xml`);
    expect(metainfo).toContain(`<id>${APP_ID}</id>`);
    expect(metainfo).toContain(`<launchable type="desktop-id">${APP_ID}.desktop</launchable>`);
    expect(metainfo).toContain('<content_rating type="oars-1.1"');
    expect(metainfo).toContain("<project_license>MIT</project_license>");
  });

  test("the metainfo documents the override users need for local SQLite files", () => {
    // The manifest deliberately grants no home access, so the escape hatch has
    // to be discoverable from the store listing itself.
    expect(read(`${APP_ID}.metainfo.xml`)).toContain("flatpak override");
  });

  test("the icon is the 256x256 PNG the registry convention expects", () => {
    const png = fs.readFileSync(path.join(DIR, `${APP_ID}.png`));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    // IHDR width/height are big-endian u32 at offsets 16 and 20.
    expect(png.readUInt32BE(16)).toBe(256);
    expect(png.readUInt32BE(20)).toBe(256);
  });
});
