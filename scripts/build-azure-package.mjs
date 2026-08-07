#!/usr/bin/env node
/**
 * Azure Marketplace solution-template package builder (deploy/azure/README.md).
 *
 * Produces the two-file zip Partner Center expects — mainTemplate.json and
 * createUiDefinition.json at the zip ROOT, no binaries — from the sources in
 * deploy/azure/src:
 *
 *   1. resolve the app image tag (ghcr) and the Caddy tag (Docker Hub) to
 *      manifest digests, so the shipped package deploys exactly the images it
 *      was built and tested against;
 *   2. inject the digest-pinned refs into install.sh, base64 the script and
 *      embed it into the template's installScriptB64 variable;
 *   3. gate on apiVersion age — certification policy 300.4.5 rejects versions
 *      older than 730 days, so the build WARNS from day 540 and FAILS from day
 *      700, leaving a 30-day certification buffer (only "apiVersion" keys are
 *      scanned: the 2019-04-01 in $schema is a schema URI, not an apiVersion);
 *   4. write dist/azure/package/ and zip it as
 *      dist/azure/libredb-studio-azure-<packageVersion>.zip.
 *
 * The digest resolution deliberately does not reuse the ghcr-tag-digest probe
 * in distribution-check.mjs: that probe compares latest-vs-tag for drift
 * against URLs stored in channels.yaml, while this builder resolves one ref on
 * two different registries (ghcr and Docker Hub) from the ref string alone.
 *
 * Everything network- or clock-dependent is injectable (fetchImpl, now) and
 * unit tested in tests/unit/build-azure-package.test.ts.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_IMAGE_REPO = "ghcr.io/libredb/libredb-studio";
/**
 * Tracking "2-alpine" keeps every build on the current Caddy 2 stable; the
 * resolved digest pins whatever that was at build time into the package.
 */
export const CADDY_IMAGE_REF = "docker.io/library/caddy:2-alpine";

const SRC_DIR = "deploy/azure/src";
const PACKAGE_VERSION_FILE = "deploy/azure/package-version.txt";
const WARN_AGE_DAYS = 540;
const FAIL_AGE_DAYS = 700;
const POLICY_AGE_DAYS = 730;

/** Partner Center requires integer.integer.integer, increased on every publish. */
const PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * The OCI tag grammar. The tag is the one part of the app ref that is not a
 * constant here — it arrives from package.json or --version — and it is
 * interpolated into the registry URLs below, so an invalid tag has to fail the
 * build rather than reshape a URL path.
 */
const OCI_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** @returns {{ version: string | undefined, packageVersion: string | undefined }} */
export function parseArgs(argv) {
  /** @type {{ version: string | undefined, packageVersion: string | undefined }} */
  const parsed = { version: undefined, packageVersion: undefined };
  const flags = { "--version": "version", "--package-version": "packageVersion" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]];
    if (!key) {
      throw new Error(`unknown argument: ${argv[i]} (expected --version or --package-version)`);
    }
    if (argv[i + 1] === undefined) {
      throw new Error(`${argv[i]} needs a value`);
    }
    parsed[key] = argv[i + 1];
  }
  if (parsed.packageVersion !== undefined && !PACKAGE_VERSION_RE.test(parsed.packageVersion)) {
    throw new Error(`package version "${parsed.packageVersion}" must be integer.integer.integer (Partner Center rule)`);
  }
  return parsed;
}

export function parseImageRef(ref) {
  const slash = ref.indexOf("/");
  if (slash === -1 || !ref.slice(0, slash).includes(".")) {
    throw new Error(`image ref "${ref}" must spell out its registry host (e.g. docker.io/library/caddy:2)`);
  }
  const registry = ref.slice(0, slash);
  const rest = ref.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  if (colon === -1 || colon === rest.length - 1) {
    throw new Error(`image ref "${ref}" is missing a tag`);
  }
  const tag = rest.slice(colon + 1);
  if (!OCI_TAG_RE.test(tag)) {
    throw new Error(`image ref "${ref}" has a tag that is not a valid OCI tag: "${tag}"`);
  }
  return { registry, repository: rest.slice(0, colon), tag };
}

/**
 * Docker Hub fronts its registry API with a separate auth host and the
 * registry-1 endpoint; ghcr serves both from one host. Both hand anonymous
 * pull tokens for public repositories.
 *
 * LIBREDB_REGISTRY_STUB exists for the unit tests only: it points both hosts
 * at a local Bun.serve instance so the real CLI path can run end to end with
 * no network — the same approach distribution-check takes with its
 * channels.yaml probe URLs.
 */
function registryEndpoints({ registry, repository }) {
  const stub = process.env.LIBREDB_REGISTRY_STUB;
  if (stub) {
    return {
      token: `${stub}/token?service=${registry}&scope=repository:${repository}:pull`,
      manifestHost: stub,
    };
  }
  if (registry === "docker.io") {
    return {
      token: `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
      manifestHost: "https://registry-1.docker.io",
    };
  }
  return {
    token: `https://${registry}/token?service=${registry}&scope=repository:${repository}:pull`,
    manifestHost: `https://${registry}`,
  };
}

export async function resolveImageDigest(ref, fetchImpl = fetch) {
  const parsed = parseImageRef(ref);
  const endpoints = registryEndpoints(parsed);

  const tokenResponse = await fetchImpl(endpoints.token);
  const tokenBody = tokenResponse.ok ? await tokenResponse.json() : null;
  if (typeof tokenBody?.token !== "string") {
    throw new Error(`anonymous pull token exchange failed for ${ref} (status ${tokenResponse.status})`);
  }

  const manifestUrl = `${endpoints.manifestHost}/v2/${parsed.repository}/manifests/${parsed.tag}`;
  const response = await fetchImpl(manifestUrl, {
    method: "HEAD",
    headers: {
      authorization: `Bearer ${tokenBody.token}`,
      // Without these the registry answers with a single-platform manifest
      // whose digest is NOT what `docker pull <repo>@sha256:...` expects.
      accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
      ].join(","),
    },
  });
  const digest = response.headers.get("docker-content-digest");
  if (!response.ok || !digest) {
    throw new Error(
      `no docker-content-digest for ${ref} (status ${response.status}) — does the tag exist on the registry?`,
    );
  }
  return digest;
}

export function pinnedRef(ref, digest) {
  const parsed = parseImageRef(ref);
  return `${parsed.registry}/${parsed.repository}@${digest}`;
}

export function fillInstallScript(script, appImage, caddyImage) {
  for (const placeholder of ["__APP_IMAGE__", "__CADDY_IMAGE__"]) {
    if (!script.includes(placeholder)) {
      throw new Error(`install.sh no longer contains the ${placeholder} placeholder`);
    }
  }
  const filled = script.replaceAll("__APP_IMAGE__", appImage).replaceAll("__CADDY_IMAGE__", caddyImage);
  const leftover = filled.match(/__[A-Z0-9_]+__/);
  if (leftover) {
    throw new Error(`install.sh still contains an unfilled placeholder: ${leftover[0]}`);
  }
  return filled;
}

/**
 * Scans ONLY "apiVersion" keys. $schema and contentVersion are exempt by
 * construction: the 2019-04-01 inside the $schema URI is correct and must
 * never trip the gate (arm-ttk's schema test expects exactly that value for
 * resource-group deployments).
 */
export function checkApiVersionAges(templateText, now = Date.now()) {
  const errors = [];
  const warnings = [];
  for (const match of templateText.matchAll(/"apiVersion"\s*:\s*"(\d{4}-\d{2}-\d{2})"/g)) {
    const value = match[1];
    const ageDays = Math.floor((now - Date.parse(`${value}T00:00:00Z`)) / 86_400_000);
    if (ageDays >= FAIL_AGE_DAYS) {
      errors.push(
        `apiVersion ${value} is ${ageDays} days old — past the ${FAIL_AGE_DAYS}-day build gate ` +
          `(certification rejects at ${POLICY_AGE_DAYS}); refresh it against \`az provider show\``,
      );
    } else if (ageDays >= WARN_AGE_DAYS) {
      warnings.push(
        `apiVersion ${value} is ${ageDays} days old; the build gate closes at ${FAIL_AGE_DAYS} days — refresh soon`,
      );
    }
  }
  return { errors, warnings };
}

/**
 * @param {{ root: string, version?: string, packageVersion?: string,
 *           fetchImpl?: typeof fetch, now?: number,
 *           log?: (line: string) => void }} options
 */
export async function buildPackage({
  root,
  version,
  packageVersion,
  fetchImpl = fetch,
  now = Date.now(),
  log = console.log,
}) {
  const resolvedVersion = version ?? JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const resolvedPackageVersion =
    packageVersion ?? fs.readFileSync(path.join(root, PACKAGE_VERSION_FILE), "utf8").trim();
  if (!PACKAGE_VERSION_RE.test(resolvedPackageVersion)) {
    throw new Error(
      `package version "${resolvedPackageVersion}" must be integer.integer.integer (Partner Center rule)`,
    );
  }

  const appRef = `${APP_IMAGE_REPO}:${resolvedVersion}`;
  const [appDigest, caddyDigest] = await Promise.all([
    resolveImageDigest(appRef, fetchImpl),
    resolveImageDigest(CADDY_IMAGE_REF, fetchImpl),
  ]);
  const appImage = pinnedRef(appRef, appDigest);
  const caddyImage = pinnedRef(CADDY_IMAGE_REF, caddyDigest);

  const srcDir = path.join(root, SRC_DIR);
  const installScript = fillInstallScript(
    fs.readFileSync(path.join(srcDir, "install.sh"), "utf8"),
    appImage,
    caddyImage,
  );
  const scriptB64 = Buffer.from(installScript, "utf8").toString("base64");

  const templateSource = fs.readFileSync(path.join(srcDir, "mainTemplate.json"), "utf8");
  if (!templateSource.includes("__INSTALL_SCRIPT_B64__")) {
    throw new Error("mainTemplate.json no longer contains the __INSTALL_SCRIPT_B64__ placeholder");
  }
  const template = templateSource.replace("__INSTALL_SCRIPT_B64__", scriptB64);

  const ages = checkApiVersionAges(template, now);
  for (const warning of ages.warnings) {
    log(`WARNING: ${warning}`);
  }
  if (ages.errors.length > 0) {
    throw new Error(ages.errors.join("\n"));
  }

  const uiDefinition = fs.readFileSync(path.join(srcDir, "createUiDefinition.json"), "utf8");
  // Both files must be valid JSON — a stray comment or a broken replacement
  // must fail the build, not certification.
  JSON.parse(template);
  JSON.parse(uiDefinition);

  const packageDir = path.join(root, "dist/azure/package");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "mainTemplate.json"), template);
  fs.writeFileSync(path.join(packageDir, "createUiDefinition.json"), uiDefinition);

  const zipPath = path.join(root, `dist/azure/libredb-studio-azure-${resolvedPackageVersion}.zip`);
  fs.rmSync(zipPath, { force: true });
  // -j strips directories, which is exactly the Partner Center requirement:
  // both files at the zip root, no folder nesting, no binaries.
  execFileSync(
    "zip",
    ["-j", "-X", zipPath, path.join(packageDir, "mainTemplate.json"), path.join(packageDir, "createUiDefinition.json")],
    {
      stdio: "ignore",
    },
  );

  return { zipPath, packageVersion: resolvedPackageVersion, version: resolvedVersion, appImage, caddyImage };
}

async function main(argv) {
  const args = parseArgs(argv);
  // cwd, not the script's location: every sibling script (chart sync, the
  // distribution checker) runs against the checkout it is invoked from, and
  // the tests exercise the CLI against fixture repos the same way.
  const result = await buildPackage({
    root: process.cwd(),
    version: args.version,
    packageVersion: args.packageVersion,
  });
  console.log(`app image:      ${result.appImage}`);
  console.log(`caddy image:    ${result.caddyImage}`);
  console.log(`packageVersion: ${result.packageVersion}`);
  console.log(`zip:            ${result.zipPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`build-azure-package: ${error.message}`);
    process.exit(1);
  });
}
