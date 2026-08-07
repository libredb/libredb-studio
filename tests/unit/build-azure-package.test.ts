/**
 * Unit tests for the Azure Marketplace package builder
 * (scripts/build-azure-package.mjs).
 *
 * The pure pieces (argument parsing, image-ref parsing, placeholder filling,
 * the apiVersion age gate) are exercised directly; digest resolution runs
 * against an injected fetch that never touches the network; the end-to-end
 * build runs against a throwaway temp-dir fixture repo and the system
 * zip/unzip binaries (the same ones the build itself uses). The CLI error
 * path runs the real script as a subprocess.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_IMAGE_REPO,
  CADDY_IMAGE_REF,
  buildPackage,
  checkApiVersionAges,
  fillInstallScript,
  parseArgs,
  parseImageRef,
  pinnedRef,
  resolveImageDigest,
} from "../../scripts/build-azure-package.mjs";

const SCRIPT = join(import.meta.dir, "../../scripts/build-azure-package.mjs");
const REPO_ROOT = join(import.meta.dir, "../..");

const APP_DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CADDY_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** ISO date string exactly `days` days before `now`. */
function daysAgo(now: number, days: number): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A fetch stand-in that answers the two registry token exchanges and the two
 * manifest HEADs the builder performs, and nothing else — an unexpected URL
 * fails the test instead of silently hitting the real network.
 */
function registryFetch({
  appDigest = APP_DIGEST,
  caddyDigest = CADDY_DIGEST,
  tokenStatus = 200,
  omitDigestHeader = false,
}: {
  appDigest?: string;
  caddyDigest?: string;
  tokenStatus?: number;
  omitDigestHeader?: boolean;
} = {}): typeof fetch {
  const impl = async (url: string): Promise<Response> => {
    if (url.startsWith("https://ghcr.io/token") || url.startsWith("https://auth.docker.io/token")) {
      return new Response(JSON.stringify({ token: "anonymous-pull-token" }), { status: tokenStatus });
    }
    // startsWith on the whole origin, not includes: a substring test on a URL
    // is the pattern CodeQL flags as incomplete sanitization, and the origin is
    // exactly what distinguishes the two registries here anyway.
    const digest = url.startsWith("https://registry-1.docker.io/") ? caddyDigest : appDigest;
    if (url.includes("/manifests/")) {
      return new Response(null, {
        status: 200,
        headers: omitDigestHeader ? {} : { "docker-content-digest": digest },
      });
    }
    throw new Error(`unexpected URL in test: ${url}`);
  };
  // The builder only ever calls fetch(url, init); the fetch statics
  // (preconnect) are irrelevant to it, hence the cast.
  return impl as unknown as typeof fetch;
}

describe("parseArgs", () => {
  test("reads --version and --package-version", () => {
    expect(parseArgs(["--version", "0.9.66", "--package-version", "1.0.0"])).toEqual({
      version: "0.9.66",
      packageVersion: "1.0.0",
    });
  });

  test("both flags are optional (defaults come from the repo)", () => {
    expect(parseArgs([])).toEqual({ version: undefined, packageVersion: undefined });
  });

  test("rejects a package version that is not integer.integer.integer", () => {
    expect(() => parseArgs(["--package-version", "1.0"])).toThrow(/integer\.integer\.integer/);
    expect(() => parseArgs(["--package-version", "v1.0.0"])).toThrow(/integer\.integer\.integer/);
    expect(() => parseArgs(["--package-version", "1.0.0-beta"])).toThrow(/integer\.integer\.integer/);
  });

  test("rejects an unknown flag instead of ignoring it", () => {
    expect(() => parseArgs(["--verison", "0.9.66"])).toThrow(/unknown argument/);
  });

  test("rejects a flag without a value", () => {
    expect(() => parseArgs(["--version"])).toThrow(/needs a value/);
  });
});

describe("parseImageRef", () => {
  test("parses a ghcr.io ref", () => {
    expect(parseImageRef("ghcr.io/libredb/libredb-studio:0.9.66")).toEqual({
      registry: "ghcr.io",
      repository: "libredb/libredb-studio",
      tag: "0.9.66",
    });
  });

  test("parses a docker.io library ref", () => {
    expect(parseImageRef("docker.io/library/caddy:2-alpine")).toEqual({
      registry: "docker.io",
      repository: "library/caddy",
      tag: "2-alpine",
    });
  });

  test("rejects a ref without an explicit registry or tag", () => {
    expect(() => parseImageRef("caddy:2-alpine")).toThrow(/registry/);
    expect(() => parseImageRef("ghcr.io/libredb/libredb-studio")).toThrow(/tag/);
  });

  test("rejects a tag outside the OCI tag grammar", () => {
    // The tag is the only part of the app ref that does not come from a
    // constant - it is package.json's version or --version - so it is the only
    // place a stray path segment could reshape the registry URL the builder
    // then fetches. An invalid tag must fail the build, not travel into a URL.
    expect(() => parseImageRef("ghcr.io/libredb/libredb-studio:0.9.66/../../evil")).toThrow(/tag/);
    expect(() => parseImageRef("ghcr.io/libredb/libredb-studio:-leading-dash")).toThrow(/tag/);
    expect(() => parseImageRef("ghcr.io/libredb/libredb-studio:has space")).toThrow(/tag/);
  });
});

describe("resolveImageDigest", () => {
  test("resolves a ghcr.io tag through the anonymous token flow", async () => {
    const digest = await resolveImageDigest(`${APP_IMAGE_REPO}:0.9.66`, registryFetch());
    expect(digest).toBe(APP_DIGEST);
  });

  test("resolves a docker.io tag through auth.docker.io/registry-1.docker.io", async () => {
    const digest = await resolveImageDigest(CADDY_IMAGE_REF, registryFetch());
    expect(digest).toBe(CADDY_DIGEST);
  });

  test("fails loudly when the token exchange fails", async () => {
    await expect(resolveImageDigest(CADDY_IMAGE_REF, registryFetch({ tokenStatus: 503 }))).rejects.toThrow(/token/);
  });

  test("fails loudly when the registry omits the digest header", async () => {
    await expect(resolveImageDigest(CADDY_IMAGE_REF, registryFetch({ omitDigestHeader: true }))).rejects.toThrow(
      /docker-content-digest/,
    );
  });
});

describe("pinnedRef", () => {
  test("pins by digest, dropping the tag", () => {
    expect(pinnedRef("ghcr.io/libredb/libredb-studio:0.9.66", APP_DIGEST)).toBe(
      `ghcr.io/libredb/libredb-studio@${APP_DIGEST}`,
    );
  });
});

describe("fillInstallScript", () => {
  const script = 'APP_IMAGE="__APP_IMAGE__"\nCADDY_IMAGE="__CADDY_IMAGE__"\n';

  test("replaces both placeholders", () => {
    const filled = fillInstallScript(script, "app@sha256:a", "caddy@sha256:b");
    expect(filled).toBe('APP_IMAGE="app@sha256:a"\nCADDY_IMAGE="caddy@sha256:b"\n');
  });

  test("throws when a placeholder is missing from the script", () => {
    expect(() => fillInstallScript('APP_IMAGE="__APP_IMAGE__"\n', "a", "b")).toThrow(/__CADDY_IMAGE__/);
  });

  test("throws when an unexpected placeholder survives", () => {
    expect(() => fillInstallScript(`${script}EXTRA="__EXTRA__"\n`, "a", "b")).toThrow(/__EXTRA__/);
  });
});

describe("checkApiVersionAges (the 540/700-day gate)", () => {
  const NOW = Date.parse("2026-08-05T12:00:00Z");

  function template(apiVersion: string): string {
    return JSON.stringify({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [{ type: "Microsoft.Network/virtualNetworks", apiVersion }],
    });
  }

  test("a fresh apiVersion passes silently", () => {
    const result = checkApiVersionAges(template(daysAgo(NOW, 100)), NOW);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("~600 days old: build passes but warns", () => {
    const result = checkApiVersionAges(template(daysAgo(NOW, 600)), NOW);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("600");
    expect(result.warnings[0]).toContain("700");
  });

  test("~710 days old: build fails", () => {
    const result = checkApiVersionAges(template(daysAgo(NOW, 710)), NOW);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("710");
  });

  test("the 2019-04-01 $schema and contentVersion are not apiVersions and are ignored", () => {
    const result = checkApiVersionAges(template(daysAgo(NOW, 100)), NOW);
    expect([...result.errors, ...result.warnings].join("")).not.toContain("2019-04-01");
  });
});

describe("buildPackage (end to end against a fixture repo)", () => {
  const NOW = Date.parse("2026-08-05T12:00:00Z");

  function makeFixtureRepo({ apiVersion = "2025-07-01" }: { apiVersion?: string } = {}): string {
    const root = mkdtempSync(join(tmpdir(), "azure-package-"));
    const src = join(root, "deploy/azure/src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.9.66" }));
    writeFileSync(join(root, "deploy/azure/package-version.txt"), "1.2.3\n");
    writeFileSync(
      join(src, "install.sh"),
      '#!/usr/bin/env bash\nAPP_IMAGE="__APP_IMAGE__"\nCADDY_IMAGE="__CADDY_IMAGE__"\necho ok\n',
    );
    writeFileSync(
      join(src, "mainTemplate.json"),
      JSON.stringify(
        {
          $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
          contentVersion: "1.0.0.0",
          variables: { installScriptB64: "__INSTALL_SCRIPT_B64__" },
          resources: [{ type: "Microsoft.Network/virtualNetworks", apiVersion }],
        },
        null,
        2,
      ),
    );
    writeFileSync(join(src, "createUiDefinition.json"), JSON.stringify({ handler: "Microsoft.Azure.CreateUIDef" }));
    return root;
  }

  test("produces a zip whose root holds exactly the two package files", async () => {
    const root = makeFixtureRepo();
    const result = await buildPackage({ root, fetchImpl: registryFetch(), now: NOW, log: () => {} });

    expect(result.packageVersion).toBe("1.2.3");
    expect(result.zipPath).toBe(join(root, "dist/azure/libredb-studio-azure-1.2.3.zip"));
    expect(existsSync(result.zipPath)).toBe(true);

    const listing = execFileSync("unzip", ["-l", result.zipPath], { encoding: "utf8" });
    const entries = listing
      .split("\n")
      .map((line) => line.trim().split(/\s+/).slice(3).join(" "))
      .filter((name) => name.endsWith(".json"));
    expect(entries.sort()).toEqual(["createUiDefinition.json", "mainTemplate.json"]);
  });

  test("embeds the digest-pinned images through the base64 install script", async () => {
    const root = makeFixtureRepo();
    await buildPackage({ root, fetchImpl: registryFetch(), now: NOW, log: () => {} });

    const template = JSON.parse(readFileSync(join(root, "dist/azure/package/mainTemplate.json"), "utf8"));
    const b64 = template.variables.installScriptB64;
    expect(b64).not.toBe("__INSTALL_SCRIPT_B64__");
    const script = Buffer.from(b64, "base64").toString("utf8");
    expect(script).toContain(`ghcr.io/libredb/libredb-studio@${APP_DIGEST}`);
    expect(script).toContain(`docker.io/library/caddy@${CADDY_DIGEST}`);
    expect(script).not.toContain("__APP_IMAGE__");
  });

  test("writes a metadata file next to the zip, for the job summary and for provenance", async () => {
    const root = makeFixtureRepo();
    const result = await buildPackage({ root, fetchImpl: registryFetch(), now: NOW, log: () => {} });

    const metadata = JSON.parse(readFileSync(join(root, "dist/azure/build-metadata.json"), "utf8"));
    expect(metadata).toEqual({
      packageVersion: "1.2.3",
      appVersion: "0.9.66",
      appImage: `ghcr.io/libredb/libredb-studio@${APP_DIGEST}`,
      caddyImage: `docker.io/library/caddy@${CADDY_DIGEST}`,
      zip: "libredb-studio-azure-1.2.3.zip",
      zipSha256: result.zipSha256,
    });
    // The hash has to describe the file a human actually uploads to Partner
    // Center, so compare it against the bytes on disk rather than trusting the
    // builder's own report of it.
    expect(metadata.zipSha256).toBe(createHash("sha256").update(readFileSync(result.zipPath)).digest("hex"));
    expect(metadata.zipSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("explicit --version wins over package.json for the app image tag", async () => {
    const root = makeFixtureRepo();
    const seen: string[] = [];
    const fetchImpl = (async (url: string): Promise<Response> => {
      seen.push(url);
      return registryFetch()(url);
    }) as unknown as typeof fetch;
    await buildPackage({ root, version: "0.9.99", fetchImpl, now: NOW, log: () => {} });
    expect(seen.some((url) => url.includes("/manifests/0.9.99"))).toBe(true);
  });

  test("refuses to build when an apiVersion is past the 700-day gate", async () => {
    const root = makeFixtureRepo({ apiVersion: daysAgo(NOW, 710) });
    await expect(buildPackage({ root, fetchImpl: registryFetch(), now: NOW, log: () => {} })).rejects.toThrow(
      /apiVersion/,
    );
  });

  test("passes the warning band through to the log without failing", async () => {
    const root = makeFixtureRepo({ apiVersion: daysAgo(NOW, 600) });
    const logged: string[] = [];
    await buildPackage({ root, fetchImpl: registryFetch(), now: NOW, log: (line: string) => logged.push(line) });
    expect(logged.join("\n")).toContain("700");
  });
});

describe("CLI", () => {
  test("a malformed package version exits 1 with the reason", () => {
    const result = spawnSync("node", [SCRIPT, "--package-version", "not-a-version"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("integer.integer.integer");
  });

  test("the full success path works end to end against a local registry stub", async () => {
    const NOW = Date.parse("2026-08-05T12:00:00Z");
    const root = mkdtempSync(join(tmpdir(), "azure-package-cli-"));
    const src = join(root, "deploy/azure/src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.9.66" }));
    writeFileSync(join(root, "deploy/azure/package-version.txt"), "9.9.9\n");
    writeFileSync(join(src, "install.sh"), 'APP_IMAGE="__APP_IMAGE__"\nCADDY_IMAGE="__CADDY_IMAGE__"\n');
    writeFileSync(
      join(src, "mainTemplate.json"),
      JSON.stringify({
        variables: { installScriptB64: "__INSTALL_SCRIPT_B64__" },
        resources: [{ apiVersion: daysAgo(NOW, 30) }],
      }),
    );
    writeFileSync(join(src, "createUiDefinition.json"), "{}");

    // The same hermetic pattern distribution-check.test.ts uses: the real CLI,
    // the real fetch, a local server standing in for both registries.
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/token") {
          return new Response(JSON.stringify({ token: "stub-token" }), { status: 200 });
        }
        if (url.pathname.includes("/manifests/")) {
          const digest = url.pathname.includes("caddy") ? CADDY_DIGEST : APP_DIGEST;
          return new Response(null, { status: 200, headers: { "docker-content-digest": digest } });
        }
        return new Response("unexpected", { status: 500 });
      },
    });
    try {
      // Bun.spawn, not spawnSync: a synchronous child would block this very
      // process — the one serving the registry stub — into a deadlock.
      const child = Bun.spawn(["node", SCRIPT, "--version", "0.9.77", "--package-version", "2.0.0"], {
        cwd: root,
        env: { ...process.env, LIBREDB_REGISTRY_STUB: `http://127.0.0.1:${server.port}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toContain(`ghcr.io/libredb/libredb-studio@${APP_DIGEST}`);
      expect(stdout).toContain(`docker.io/library/caddy@${CADDY_DIGEST}`);
      expect(stdout).toContain("packageVersion: 2.0.0");
      expect(existsSync(join(root, "dist/azure/libredb-studio-azure-2.0.0.zip"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("listing texts stay inside the Partner Center limits", () => {
  const listingDir = join(REPO_ROOT, "deploy/azure/listing");

  test("description.html is at most 5000 characters", () => {
    const html = readFileSync(join(listingDir, "description.html"), "utf8");
    expect(html.length).toBeLessThanOrEqual(5000);
  });

  test("the summary lines in listing-fields.md respect their limits", () => {
    const fields = readFileSync(join(listingDir, "listing-fields.md"), "utf8");
    const summary = fields.match(/<!-- limit:100 -->\n(.+)/)?.[1] ?? "";
    const short = fields.match(/<!-- limit:256 -->\n(.+)/)?.[1] ?? "";
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(100);
    expect(short.length).toBeGreaterThan(0);
    expect(short.length).toBeLessThanOrEqual(256);
  });
});

describe("the shipped template sources agree with each other", () => {
  const srcDir = join(REPO_ROOT, "deploy/azure/src");
  const readSrc = (name: string): string => readFileSync(join(srcDir, name), "utf8");

  /**
   * The ARM type every wizard output must land on. Comparing key names alone
   * lets `enableHttps` drift from `bool` to `string` while the wizard keeps
   * emitting a boolean - a mismatch ARM only rejects at deployment time, long
   * after certification passed.
   */
  const EXPECTED_PARAMETER_TYPES: Record<string, string> = {
    location: "string",
    vmName: "string",
    vmSize: "string",
    osDiskSizeGb: "int",
    adminUsername: "string",
    authenticationType: "string",
    adminPasswordOrKey: "securestring",
    dnsLabelPrefix: "string",
    appAdminEmail: "string",
    appAdminPassword: "securestring",
    enableHttps: "bool",
    acmeContactEmail: "string",
    appSourceAddressPrefix: "string",
    sshSourceAddressPrefix: "string",
  };

  test("every createUiDefinition output maps to a mainTemplate parameter", () => {
    const template = JSON.parse(readSrc("mainTemplate.json"));
    const ui = JSON.parse(readSrc("createUiDefinition.json"));
    const outputs = Object.keys(ui.parameters.outputs).sort();
    const params = Object.keys(template.parameters).sort();
    expect(outputs).toEqual(params);
    expect(outputs).toEqual(Object.keys(EXPECTED_PARAMETER_TYPES).sort());
  });

  test("every mainTemplate parameter declares the type its wizard control produces", () => {
    const template = JSON.parse(readSrc("mainTemplate.json"));
    for (const [name, expectedType] of Object.entries(EXPECTED_PARAMETER_TYPES)) {
      expect(template.parameters[name].type).toBe(expectedType);
    }
  });

  test("the controls behind the non-string parameters really emit that type", () => {
    type Element = Record<string, unknown> & { name: string };
    const ui = JSON.parse(readSrc("createUiDefinition.json"));
    const elements: Element[] = ui.parameters.steps.flatMap((step: { elements: Element[] }) => step.elements);
    const byName = (name: string): Element => {
      const found = elements.find((element) => element.name === name);
      if (!found) throw new Error(`no wizard element named ${name}`);
      return found;
    };

    const allowedValues = (byName("enableHttps").constraints as { allowedValues: Array<{ value: unknown }> })
      .allowedValues;
    for (const allowed of allowedValues) {
      expect(typeof allowed.value).toBe("boolean");
    }
    const diskSlider = byName("osDiskSizeGb");
    for (const bound of [diskSlider.defaultValue, diskSlider.min, diskSlider.max]) {
      expect(Number.isInteger(bound)).toBe(true);
    }
  });

  /*
   * The next three read install.sh as text rather than running it: the repo has
   * no harness that can execute a first-boot installer (it apt-installs Docker
   * and talks to systemd), so these pin the shape that the reviewed design
   * depends on. They are the cheapest guard against the drift class that
   * produced the findings in PR #307.
   */
  test("the TLS fallback is Caddy's issuer chain, not a config rewrite", () => {
    const install = readSrc("install.sh");
    expect(install).toContain("issuer acme");
    expect(install).toContain("issuer internal");
    // Rewriting the Caddyfile after the health gate is what coupled the proxy
    // config to the app's cookie policy and to the ARM output strings - and
    // then drifted from both. Caddy falls back on its own; bash must not.
    expect(install).not.toContain("Caddyfile.fallback");
    expect(install).not.toContain("Caddyfile.https");
    expect(install).not.toContain("WEB_SOURCE");
  });

  test("a plain-HTTP deployment, and only that, drops the Secure cookie flag", () => {
    // NODE_ENV=production marks auth cookies Secure for every non-loopback host
    // (src/lib/auth.ts, shouldMarkCookieSecure), so on http:// the browser
    // discards the login cookie and the sign-in loops back to the login page.
    const install = readSrc("install.sh");
    expect(install.match(/AUTH_COOKIE_SECURE/g)).toHaveLength(1);
    expect(install).toMatch(/\[ "\$SITE_ADDRESS" = ":80" \][\s\S]{0,200}AUTH_COOKIE_SECURE=false/);
  });

  test("the directories that hold secrets are created private", () => {
    // /opt/libredb/data carries the SQLite store, whose connection records hold
    // plaintext passwords and connection strings (DatabaseConnection in
    // src/lib/types.ts), and /opt/libredb/caddy/data carries the TLS private keys
    // and the ACME account key. A world-traversable parent is what exposes those
    // to every local account, and the mode of the files inside follows the
    // containers' umask rather than anything this installer controls - so the
    // directory mode is the control point, and it is pinned here.
    const install = readSrc("install.sh");
    const shared = install.match(/install -d -m 0755 (.+)/)?.[1] ?? "";
    const private_ = install.match(/install -d -m 0700 (.+)/)?.[1] ?? "";
    for (const secretDir of ["/opt/libredb/data", "/opt/libredb/caddy/data"]) {
      expect(private_).toContain(secretDir);
      expect(shared).not.toContain(secretDir);
    }
  });

  test("mainTemplate passes exactly the arguments install.sh reads", () => {
    const command = JSON.parse(readSrc("mainTemplate.json")).resources.at(-1).properties.protectedSettings
      .commandToExecute;
    const passed = (command.match(/base64\(/g) ?? []).length;
    const read = new Set([...readSrc("install.sh").matchAll(/\$\{(\d):-\}/g)].map((match) => match[1]));
    expect([...read].sort()).toEqual(["1", "2", "3", "4"]);
    expect(passed).toBe(read.size);
  });

  test("the template never declares a Microsoft.Resources/deployments resource (usage attribution rule)", () => {
    const raw = readFileSync(join(srcDir, "mainTemplate.json"), "utf8");
    expect(raw).not.toContain("Microsoft.Resources/deployments");
  });

  test("no securestring parameter carries a default value", () => {
    const template = JSON.parse(readFileSync(join(srcDir, "mainTemplate.json"), "utf8"));
    for (const spec of Object.values(template.parameters) as Array<Record<string, unknown>>) {
      if (String(spec.type).toLowerCase() === "securestring") {
        expect(spec.defaultValue).toBeUndefined();
      }
    }
  });
});
