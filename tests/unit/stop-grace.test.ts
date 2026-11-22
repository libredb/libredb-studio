/**
 * Every grace this repository sets between a stop signal and SIGKILL for a Studio server covers Studio's shutdown
 * (docs/DISTRIBUTION.md, "Stopping the server"): the request drain, the shutdown hooks and the provider closes, each
 * bounded, plus 5 s for the process to start and end around them. Each channel's file is read as data where a parser
 * exists here (YAML, TOML, JSON) and as text otherwise (Rust, Ruby, systemd units), so raising a bound fails every
 * channel by name, and a Compose file added with a Studio service is found by the scan. The platform defaults that
 * already give 30 s or more (Kubernetes, snapd, Render, the distributions' systemd) are set nowhere here and are
 * stated in the documentation's table instead.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("Compose files", () => {
  const STUDIO_DOCKERFILES = new Set(["Dockerfile", "Dockerfile.alpine", "Dockerfile.alpine-slim"]);
  type Service = { image?: string; build?: { dockerfile?: string }; stop_grace_period?: unknown };
  const studioServices = readdirSync(REPO_ROOT)
    .filter((name) => /^docker-compose.*\.ya?ml$/.test(name))
    .sort()
    .flatMap((file) => {
      const { services } = Bun.YAML.parse(read(file)) as { services: Record<string, Service> };
      return Object.entries(services)
        .filter(
          ([, service]) =>
            service.image?.startsWith("ghcr.io/libredb/libredb-studio") ||
            STUDIO_DOCKERFILES.has(service.build?.dockerfile ?? ""),
        )
        .map(([name, service]) => [file, name, service] as const);
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
    const value = service.stop_grace_period;
    if (typeof value !== "string") throw new Error(`${file}: the ${name} service sets no stop_grace_period`);
    expect(seconds(`${file}/${name}`, value, /^(\d+)s$/)).toBeGreaterThanOrEqual(FLOOR_SECONDS);
  });
});

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

test.each([
  "deploy/aws/ami/files/etc/systemd/system/libredb-studio.service",
  "deploy/digitalocean/droplet/files/etc/systemd/system/libredb-studio.service",
  "deploy/azure/src/install.sh",
])("the %s unit starts the container with --stop-timeout and stops it without overriding it", (relative) => {
  const unit = vmUnit(relative);
  const start = /^ExecStart=\/usr\/bin\/docker run ([\s\S]*?)(?=\n[A-Z]\w*=)/m.exec(unit)?.[1];
  if (start === undefined) throw new Error(`${relative}: no ExecStart=/usr/bin/docker run`);
  expect(seconds(relative, start, /--stop-timeout (\d+)\b/)).toBeGreaterThanOrEqual(FLOOR_SECONDS);
  // A plain docker stop waits the container's own StopTimeout; -t, --time or --timeout would replace it.
  const stop = /^ExecStop=(.*)$/m.exec(unit)?.[1];
  expect(stop).toBe("/usr/bin/docker stop libredb-studio");
});

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

test("docs/DISTRIBUTION.md's grace table states each grace this repository sets", () => {
  const desktop = /^pub const SHUTDOWN_GRACE: Duration = Duration::from_secs\((\d+)\);$/m.exec(
    read("desktop/src-tauri/src/sidecar.rs"),
  )?.[1];
  const brew = /^\s*stop_timeout (\d+)$/m.exec(read("packaging/homebrew/libredb-studio.rb.tmpl"))?.[1];
  const { kill_timeout } = Bun.TOML.parse(read("fly.toml")) as { kill_timeout: number };
  const railway = (
    JSON.parse(read("deploy/railway/template.json")) as {
      services: { name: string; variables: Record<string, string> }[];
    }
  ).services.find((service) => service.name === "libredb-studio")?.variables.RAILWAY_DEPLOYMENT_DRAINING_SECONDS;
  const vm = /--stop-timeout (\d+)\b/.exec(read("deploy/aws/ami/files/etc/systemd/system/libredb-studio.service"))?.[1];
  const compose = (
    Bun.YAML.parse(read("docker-compose.example.yml")) as { services: Record<string, { stop_grace_period: string }> }
  ).services["libredb-studio"].stop_grace_period;

  expect(graceRow("Desktop app")).toContain(`| ${desktop} s |`);
  expect(graceRow("Homebrew service")).toContain(`${brew} s: \`stop_timeout ${brew}\``);
  expect(graceRow("Fly.io")).toContain(`${kill_timeout} s: \`kill_timeout = ${kill_timeout}\``);
  expect(graceRow("Railway")).toContain(`${railway} s: \`RAILWAY_DEPLOYMENT_DRAINING_SECONDS\``);
  expect(graceRow("AWS, DigitalOcean and Azure")).toContain(
    `${vm} s: their unit starts the container with \`--stop-timeout ${vm}\``,
  );
  expect(graceRow("`docker stop`")).toContain(`\`stop_grace_period: ${compose}\``);
});
