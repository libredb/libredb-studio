/**
 * Every grace this repository sets between a stop signal and SIGKILL for a Studio server covers Studio's shutdown
 * (docs/DISTRIBUTION.md, "Stopping the server"): the request drain, the shutdown hooks and the provider closes, each
 * bounded, plus 5 s for the process to start and end around them. Each channel's file is read as data where a parser
 * exists here (YAML, TOML, JSON) and as text otherwise (Rust, Ruby, systemd units), so raising a bound fails every
 * channel by name, and a Compose file added with a Studio service is found by the scan. The platform defaults that
 * already give 30 s or more (Kubernetes, snapd, Render, the distributions' systemd) are stated in the documentation's
 * table, and their files are read for a shorter grace of their own.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROVIDER_CACHE_CLOSE_DEADLINE_MS, SHUTDOWN_HOOKS_DEADLINE_MS } from "@/lib/shutdown";
import { DRAIN_DEADLINE_MS } from "@/lib/shutdown-drain";

const REPO_ROOT = join(import.meta.dir, "../..");
const read = (relative: string) => readFileSync(join(REPO_ROOT, relative), "utf8");

/** Studio's shutdown at its longest, in seconds. */
const SHUTDOWN_SECONDS = (DRAIN_DEADLINE_MS + SHUTDOWN_HOOKS_DEADLINE_MS + PROVIDER_CACHE_CLOSE_DEADLINE_MS) / 1000;
/** What the process needs around the bounded steps: its own start of the handler and its exit. */
const MARGIN_SECONDS = 5;
const FLOOR_SECONDS = SHUTDOWN_SECONDS + MARGIN_SECONDS;

/** The one number a pattern captures, failing by name when the pattern finds none. */
function seconds(where: string, text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  if (!match) throw new Error(`${where}: no ${pattern} found`);
  return Number(match[1]);
}

test("Studio's shutdown takes at most 25 s, and the grace this repository sets leaves 5 s over it", () => {
  expect(SHUTDOWN_SECONDS).toBe(25);
  expect(FLOOR_SECONDS).toBe(30);
});

test("the desktop app waits SHUTDOWN_GRACE between its SIGTERM and its SIGKILL", () => {
  const source = read("desktop/src-tauri/src/sidecar.rs");
  expect(
    seconds(
      "desktop/src-tauri/src/sidecar.rs",
      source,
      /^pub const SHUTDOWN_GRACE: Duration = Duration::from_secs\((\d+)\);$/m,
    ),
  ).toBeGreaterThanOrEqual(FLOOR_SECONDS);
});

test("brew services waits stop_timeout", () => {
  const template = read("packaging/homebrew/libredb-studio.rb.tmpl");
  const service = /\n\s*service do\n([\s\S]*?)\n\s*end\b/.exec(template)?.[1];
  if (service === undefined) throw new Error("no service block in packaging/homebrew/libredb-studio.rb.tmpl");
  expect(seconds("the Homebrew service block", service, /^\s*stop_timeout (\d+)$/m)).toBeGreaterThanOrEqual(
    FLOOR_SECONDS,
  );
});

/** The names Compose reads a project from, the ones it looks for first included, and their variants here. */
const COMPOSE_FILE = /^(?:docker-)?compose(?:[.-][^/]*)?\.ya?ml$/;
const STUDIO_DOCKERFILES = new Set(["Dockerfile", "Dockerfile.alpine", "Dockerfile.alpine-slim"]);
/** Studio's image by its repository path, on any registry, with or without a tag or a digest. */
const STUDIO_IMAGE = /^(?:[^/]+\/)?libredb\/libredb-studio(?:[:@]|$)/;
type ComposeService = {
  image?: string;
  build?: string | { context?: string; dockerfile?: string };
  stop_grace_period?: unknown;
};

/**
 * Whether a Compose service in `file` runs Studio: its image is Studio's, or it builds one of Studio's Dockerfiles in
 * this repository's root. Compose builds `Dockerfile` when `build` is a string, its context, or an object without
 * `dockerfile`. A value the scan cannot resolve, one that interpolates a variable, fails by name.
 */
function runsStudio(file: string, name: string, service: ComposeService): boolean {
  for (const value of [service.image, typeof service.build === "string" ? service.build : service.build?.context]) {
    if (value?.includes("${"))
      throw new Error(`${file}: the ${name} service names ${value}, which the scan cannot resolve`);
  }
  if (service.image !== undefined && STUDIO_IMAGE.test(service.image)) return true;
  if (service.build === undefined) return false;
  const { context = ".", dockerfile = "Dockerfile" } =
    typeof service.build === "string" ? { context: service.build } : service.build;
  return resolve(REPO_ROOT, context) === resolve(REPO_ROOT) && STUDIO_DOCKERFILES.has(dockerfile);
}

/** Every Studio service of every Compose file in the repository root, as [file, service name, service]. */
function composeStudioServices(): (readonly [string, string, ComposeService])[] {
  return readdirSync(REPO_ROOT)
    .filter((name) => COMPOSE_FILE.test(name))
    .sort()
    .flatMap((file) => {
      const { services } = Bun.YAML.parse(read(file)) as { services: Record<string, ComposeService> };
      return Object.entries(services)
        .filter(([name, service]) => runsStudio(file, name, service))
        .map(([name, service]) => [file, name, service] as const);
    });
}

describe("Compose files", () => {
  const studioServices = composeStudioServices();

  test.each(["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml", "compose.override.yaml"])(
    "the scan reads %s",
    (file) => {
      expect(COMPOSE_FILE.test(file)).toBe(true);
    },
  );

  test.each(["composer.yml", "docker-compose.yml.bak", "compose.json"])("the scan skips %s", (file) => {
    expect(COMPOSE_FILE.test(file)).toBe(false);
  });

  test.each<[string, ComposeService]>([
    ["build given as the root", { build: "." }],
    ["build given as the root with a trailing slash", { build: "./" }],
    ["a build object without dockerfile", { build: { context: "." } }],
    ["a build object without context", { build: { dockerfile: "Dockerfile.alpine" } }],
    ["the GHCR image", { image: "ghcr.io/libredb/libredb-studio:latest" }],
    ["the Docker Hub mirror", { image: "libredb/libredb-studio:latest" }],
    ["the Docker Hub mirror by its registry", { image: "docker.io/libredb/libredb-studio" }],
    ["the GHCR image by digest", { image: `ghcr.io/libredb/libredb-studio@sha256:${"0".repeat(64)}` }],
  ])("the scan classes %s as Studio", (_shape, service) => {
    expect(runsStudio("compose.yaml", "studio", service)).toBe(true);
  });

  test.each<[string, ComposeService]>([
    ["another image", { image: "postgres:18" }],
    ["an image whose name only starts with Studio's", { image: "ghcr.io/libredb/libredb-studio-operator:1" }],
    ["a build in another context", { build: "./operator" }],
    ["another Dockerfile in the root", { build: { context: ".", dockerfile: "operator/Dockerfile" } }],
  ])("the scan classes %s as not Studio", (_shape, service) => {
    expect(runsStudio("compose.yaml", "other", service)).toBe(false);
  });

  test.each<[string, ComposeService]>([
    ["image", { image: "${STUDIO_IMAGE}" }],
    ["build context", { build: { context: "${STUDIO_CONTEXT}" } }],
  ])("the scan fails by name on an interpolated %s", (_field, service) => {
    expect(() => runsStudio("compose.yaml", "studio", service)).toThrow("compose.yaml: the studio service names ${");
  });

  test("the Compose files' Studio services are the four this repository ships", () => {
    expect(studioServices.map(([file, name]) => `${file}/${name}`)).toEqual([
      "docker-compose.example.yml/libredb-studio",
      "docker-compose.oidc-demo.yml/libredb-studio",
      "docker-compose.vault-demo.yml/libredb-studio",
      "docker-compose.yml/app",
    ]);
  });

  test.each(studioServices)("%s's %s service waits stop_grace_period", (file, name, service) => {
    expect(composeGrace(file, name, service)).toBeGreaterThanOrEqual(FLOOR_SECONDS);
  });
});

/** A Studio service's stop_grace_period in seconds, failing by name when it sets none. */
function composeGrace(file: string, name: string, service: ComposeService): number {
  const value = service.stop_grace_period;
  if (typeof value !== "string") throw new Error(`${file}: the ${name} service sets no stop_grace_period`);
  return seconds(`${file}/${name}`, value, /^(\d+)s$/);
}

test("Fly.io waits kill_timeout", () => {
  const { kill_timeout } = Bun.TOML.parse(read("fly.toml")) as { kill_timeout?: unknown };
  if (typeof kill_timeout !== "number") throw new Error("fly.toml sets no kill_timeout");
  expect(kill_timeout).toBeGreaterThanOrEqual(FLOOR_SECONDS);
});

/** The systemd unit text of each virtual machine image; Azure's is a heredoc in its install script. */
function vmUnit(relative: string): string {
  const text = read(relative);
  if (!relative.endsWith(".sh")) return text;
  const unit = /cat > \/etc\/systemd\/system\/libredb-studio\.service <<EOF\n([\s\S]*?)\nEOF\n/.exec(text)?.[1];
  if (unit === undefined) throw new Error(`${relative}: no libredb-studio.service heredoc`);
  return unit;
}

const VM_UNITS = [
  "deploy/aws/ami/files/etc/systemd/system/libredb-studio.service",
  "deploy/digitalocean/droplet/files/etc/systemd/system/libredb-studio.service",
  "deploy/azure/src/install.sh",
];

/** The --stop-timeout a virtual machine image's unit starts the container with. */
function vmGrace(relative: string): number {
  const start = /^ExecStart=\/usr\/bin\/docker run ([\s\S]*?)(?=\n[A-Z]\w*=)/m.exec(vmUnit(relative))?.[1];
  if (start === undefined) throw new Error(`${relative}: no ExecStart=/usr/bin/docker run`);
  return seconds(relative, start, /--stop-timeout (\d+)\b/);
}

test.each(VM_UNITS)(
  "the %s unit starts the container with --stop-timeout and stops it without overriding it",
  (relative) => {
    const unit = vmUnit(relative);
    expect(vmGrace(relative)).toBeGreaterThanOrEqual(FLOOR_SECONDS);
    // A plain docker stop waits the container's own StopTimeout; -t, --time or --timeout would replace it.
    const stop = /^ExecStop=(.*)$/m.exec(unit)?.[1];
    expect(stop).toBe("/usr/bin/docker stop libredb-studio");
  },
);

test("the Railway template drains for RAILWAY_DEPLOYMENT_DRAINING_SECONDS, and PUBLISH.md enters the same value", () => {
  const template = JSON.parse(read("deploy/railway/template.json")) as {
    services: { name: string; variables: Record<string, string>; variableDescriptions: Record<string, string> }[];
  };
  const studio = template.services.find((service) => service.name === "libredb-studio");
  const value = studio?.variables.RAILWAY_DEPLOYMENT_DRAINING_SECONDS;
  if (value === undefined) throw new Error("deploy/railway/template.json sets no RAILWAY_DEPLOYMENT_DRAINING_SECONDS");
  expect(Number(value)).toBeGreaterThanOrEqual(FLOOR_SECONDS);
  expect(studio?.variableDescriptions.RAILWAY_DEPLOYMENT_DRAINING_SECONDS).toBeString();
  expect(read("deploy/railway/PUBLISH.md")).toContain(`| \`RAILWAY_DEPLOYMENT_DRAINING_SECONDS\` | \`${value}\` |`);
});

/** The row of docs/DISTRIBUTION.md's grace table ("Stopping the server") whose first cell starts with `label`. */
function graceRow(label: string): string {
  const doc = read("docs/DISTRIBUTION.md");
  const start = doc.indexOf("\n| Platform | Grace before SIGKILL |\n", doc.indexOf("\n## Stopping the server\n"));
  if (start === -1) throw new Error("docs/DISTRIBUTION.md: no grace table in Stopping the server");
  const table = doc.slice(start + 1, doc.indexOf("\n\n", start + 1));
  const row = table.split("\n").find((line) => line.startsWith(`| ${label}`));
  if (row === undefined) throw new Error(`docs/DISTRIBUTION.md: no grace table row starting with ${label}`);
  return row;
}

/** The one value every file of a channel sets, failing by the file that differs. */
function shared(channel: string, values: [string, number][]): number {
  const [[, first]] = values;
  if (values.some(([, value]) => value !== first)) {
    throw new Error(`${channel}: ${values.map(([where, value]) => `${where} sets ${value}`).join(", ")}`);
  }
  return first;
}

test("docs/DISTRIBUTION.md's grace table states each grace this repository sets, and they are all one value", () => {
  const desktop = seconds(
    "desktop/src-tauri/src/sidecar.rs",
    read("desktop/src-tauri/src/sidecar.rs"),
    /^pub const SHUTDOWN_GRACE: Duration = Duration::from_secs\((\d+)\);$/m,
  );
  const brew = seconds(
    "packaging/homebrew/libredb-studio.rb.tmpl",
    read("packaging/homebrew/libredb-studio.rb.tmpl"),
    /^\s*stop_timeout (\d+)$/m,
  );
  const { kill_timeout } = Bun.TOML.parse(read("fly.toml")) as { kill_timeout: number };
  const railway = Number(
    (
      JSON.parse(read("deploy/railway/template.json")) as {
        services: { name: string; variables: Record<string, string> }[];
      }
    ).services.find((service) => service.name === "libredb-studio")?.variables.RAILWAY_DEPLOYMENT_DRAINING_SECONDS,
  );
  const vm = shared(
    "the virtual machine units",
    VM_UNITS.map((relative) => [relative, vmGrace(relative)]),
  );
  const compose = shared(
    "the Compose files' Studio services",
    composeStudioServices().map(([file, name, service]) => [`${file}/${name}`, composeGrace(file, name, service)]),
  );

  expect(graceRow("Desktop app")).toContain(`| ${desktop} s |`);
  expect(graceRow("Homebrew service")).toContain(`${brew} s: \`stop_timeout ${brew}\``);
  expect(graceRow("Fly.io")).toContain(`${kill_timeout} s: \`kill_timeout = ${kill_timeout}\``);
  expect(graceRow("Railway")).toContain(`${railway} s: \`RAILWAY_DEPLOYMENT_DRAINING_SECONDS\``);
  expect(graceRow("AWS, DigitalOcean and Azure")).toContain(
    `${vm} s: their unit starts the container with \`--stop-timeout ${vm}\``,
  );
  expect(graceRow("`docker stop`")).toContain(`\`stop_grace_period: ${compose}s\``);
  const every = shared("the graces this repository sets", [
    ["desktop/src-tauri/src/sidecar.rs", desktop],
    ["packaging/homebrew/libredb-studio.rb.tmpl", brew],
    ["fly.toml", kill_timeout],
    ["deploy/railway/template.json", railway],
    ["the virtual machine units", vm],
    ["the Compose files", compose],
  ]);
  expect(read("docs/DISTRIBUTION.md")).toContain(`Every grace this repository sets is ${every} s,`);
});

/**
 * The channels whose grace the platform's default gives, which the documentation's table states: each holds no
 * shorter grace of its own, so a key added later with a value under the floor fails here by name.
 */
describe("the channels left to the platform's default set no shorter grace", () => {
  test("the .deb, .rpm and AUR unit", () => {
    const unit = read("packaging/linux/libredb-studio.service");
    for (const match of unit.matchAll(/^Timeout(?:Stop)?Sec=(.*)$/gm)) {
      expect(seconds("packaging/linux/libredb-studio.service", match[1], /^(\d+)s?$/)).toBeGreaterThanOrEqual(
        FLOOR_SECONDS,
      );
    }
  });

  test("the Snap daemon", () => {
    const { apps } = Bun.YAML.parse(read("snap/snapcraft.yaml")) as {
      apps: Record<string, { daemon?: string; "stop-timeout"?: unknown }>;
    };
    const daemons = Object.entries(apps).filter(([, app]) => app.daemon !== undefined);
    expect(daemons.map(([name]) => name)).toEqual(["libredb-studio"]);
    for (const [name, app] of daemons) {
      const value = app["stop-timeout"];
      if (value === undefined) continue;
      expect(seconds(`snap/snapcraft.yaml ${name}`, String(value), /^(\d+)s?$/)).toBeGreaterThanOrEqual(FLOOR_SECONDS);
    }
  });

  test("the Render service", () => {
    const { services } = Bun.YAML.parse(read("render.yaml")) as {
      services: { name: string; maxShutdownDelaySeconds?: unknown }[];
    };
    const studio = services.find((service) => service.name === "libredb-studio");
    if (studio === undefined) throw new Error("render.yaml: no libredb-studio service");
    if (studio.maxShutdownDelaySeconds !== undefined) {
      expect(Number(studio.maxShutdownDelaySeconds)).toBeGreaterThanOrEqual(FLOOR_SECONDS);
    }
  });

  // The operator is a Helm operator that renders its copy of the chart; its own manager pod's grace is not Studio's.
  test.each(["charts/libredb-studio", "operator/helm-charts"])("the Kubernetes pods %s renders", (directory) => {
    const files = readdirSync(join(REPO_ROOT, directory), { recursive: true, encoding: "utf8" }).filter((file) =>
      /\.(?:ya?ml|tpl)$/.test(file),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const match of read(join(directory, file)).matchAll(/terminationGracePeriodSeconds:\s*(\S+)/g)) {
        expect(seconds(join(directory, file), match[1], /^(\d+)$/)).toBeGreaterThanOrEqual(FLOOR_SECONDS);
      }
    }
  });
});
