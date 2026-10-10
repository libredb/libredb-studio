/**
 * The S3 fixtures in database-compose.yml and the files of docker/minio, docker/s3 and tests/live/s3-*.ts, held to
 * the rules below.
 *
 * MinIO is built here from its last community release, because MinIO publishes no community image any more; that
 * build is frozen and unpatched, so it runs only behind its own profiles, never restarts with the daemon, and a plain
 * `up` builds nothing from source. Silo, Garage and RustFS are pulled and pinned by tag and digest. Every port is on
 * 127.0.0.1, every server is bounded, and every one-shot creates what is missing and leaves what exists.
 *
 * Each rule is a pure function from the parsed fixtures to a list of findings, so it is proven both ways: the real
 * tree gives none, and a planted copy with one fault gives the finding that names it.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { rfc3986Path, validateHost } from "@/lib/db/http/endpoint";
import type { NodeByteTransportOptions, RequestSigner } from "@/lib/db/http/node-transport";
import { S3_PREVIEW_LIMITS } from "@/lib/db/providers/objectstore/s3/constants";
import { SeedConfigSchema } from "@/lib/seed/types";
import { S3_CAPTURES_MAX_BYTES, S3_EXCHANGE_BODY_MAX_BYTES, scrubCapture } from "../../../helpers/s3-evidence-scrub";
import {
  captureFilesOnDisk,
  loadS3Capture,
  readDigestTable,
  S3_CAPTURE_TARGETS,
  S3_CAPTURES_ROOT,
} from "../../../helpers/s3-fixtures";
import {
  bodyBytes,
  type S3RecordedAnswer,
  type S3RecordedRequest,
  type S3TransportFactory,
  scriptedS3Transport,
  signingInput,
} from "../../../helpers/s3-wire";
import { runS3Scenario, S3_LIVE_ONLY_ROWS, scenariosFor } from "../../../live/s3-evidence-plan";
import {
  checkS3Step,
  levelPageDefect,
  readmeRows,
  readS3Principals,
  renderS3Acceptance,
  replayPrincipals,
  S3_ACCEPTANCE,
  S3_ACCEPTANCE_GROUPS,
  S3_FIXTURE_BUCKETS,
  S3_RUNNERS,
  S3_TARGET_NAMES,
  s3Fingerprint,
  s3LiveConnection,
  s3Recorder,
  type S3RunContext,
  sentenceRefFinding,
  wireViolations,
} from "../../../live/s3-live-support";

const ROOT = path.resolve(import.meta.dir, "../../../..");

interface ComposeLimits {
  readonly cpus?: string;
  readonly memory?: string;
}

interface ComposeService {
  readonly image?: string;
  readonly build?: { readonly context?: string; readonly target?: string };
  readonly pull_policy?: string;
  readonly container_name?: string;
  readonly profiles?: readonly string[];
  readonly restart?: string;
  readonly entrypoint?: readonly string[];
  readonly command?: readonly string[];
  readonly ports?: readonly string[];
  readonly volumes?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly healthcheck?: {
    readonly test?: readonly string[];
    readonly start_period?: string;
    readonly start_interval?: string;
    readonly interval?: string;
    readonly timeout?: string;
    readonly retries?: number;
  };
  readonly depends_on?: Readonly<Record<string, { readonly condition: string }>>;
  readonly deploy?: { readonly resources?: { readonly limits?: ComposeLimits } };
  readonly memswap_limit?: string;
}

interface S3Fixtures {
  /** Every compose service this part adds, by name (the names of S3_SERVICES). */
  readonly services: Readonly<Record<string, ComposeService>>;
  /** The names of the compose file's top-level volumes. */
  readonly volumes: readonly string[];
  /** The compose file's comment block directly under `volumes:`, before the first volume entry. */
  readonly volumesComment: string;
  /** Repository-relative path to text, for docker/minio/*, docker/s3/** except data/, and tests/live/s3-*.ts. */
  readonly files: Readonly<Record<string, string>>;
  /** docker/s3/data/<name> to its bytes. */
  readonly data: Readonly<Record<string, Uint8Array>>;
}

/** Writable all the way down, except the data bytes, which a planted change replaces whole. */
type Mutable<T> = T extends Uint8Array ? T : { -readonly [K in keyof T]: Mutable<T[K]> };

const S3_SERVERS = ["minio", "minio-region", "silo", "silo-tls", "garage", "rustfs"] as const;
const S3_ONE_SHOTS = [
  "minio-principals",
  "minio-seed",
  "minio-region-principals",
  "minio-region-seed",
  "silo-principals",
  "silo-seed",
  "s3-certs",
  "garage-keys",
  "garage-setup",
  "garage-seed",
  "rustfs-principals",
  "rustfs-seed",
] as const;
const S3_SERVICES: readonly string[] = [...S3_SERVERS, ...S3_ONE_SHOTS];
const MINIO_COMMIT = "9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a";
const MC_COMMIT = "7394ce0dd2a80935aded936b09fa12cbb3cb8096";
const ALPINE_PIN = "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8";

/** Every file under `dir`, repository-relative, recursively, skipping the directories named in `skip`. */
function walk(dir: string, skip: readonly string[] = []): string[] {
  const absolute = path.join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return skip.includes(relative) ? [] : walk(relative, skip);
    return [relative];
  });
}

function loadS3Fixtures(): S3Fixtures {
  const composeText = readFileSync(path.join(ROOT, "database-compose.yml"), "utf8");
  // `merge: true` because the file shares settings through `<<:` merge keys.
  const compose = parseYaml(composeText, { merge: true }) as {
    readonly services: Readonly<Record<string, ComposeService>>;
    readonly volumes: Readonly<Record<string, unknown>>;
  };
  const services = Object.fromEntries(Object.entries(compose.services).filter(([name]) => S3_SERVICES.includes(name)));
  // The volumes comment sits under `volumes:` (database-compose.yml:3102-3117): every line up to the first entry.
  const volumesAt = composeText.indexOf("\nvolumes:\n");
  const afterVolumes = composeText.slice(volumesAt + "\nvolumes:".length).split("\n");
  const firstEntry = afterVolumes.findIndex((line, index) => index > 0 && !/^\s*#/.test(line));
  const textFiles = [
    ...walk("docker/minio"),
    ...walk("docker/s3", ["docker/s3/data"]),
    ...walk("tests/live").filter((file) => path.basename(file).startsWith("s3-") && file.endsWith(".ts")),
  ];
  const files = Object.fromEntries(textFiles.map((file) => [file, readFileSync(path.join(ROOT, file), "utf8")]));
  const data = Object.fromEntries(
    walk("docker/s3/data").map((file) => [path.basename(file), new Uint8Array(readFileSync(path.join(ROOT, file)))]),
  );
  return {
    services,
    volumes: Object.keys(compose.volumes ?? {}),
    volumesComment: afterVolumes.slice(0, firstEntry).join("\n"),
    files,
    data,
  };
}

/** A deep copy with one change, for the planted half of each rule. */
function planted(fixtures: S3Fixtures, change: (draft: Mutable<S3Fixtures>) => void): S3Fixtures {
  const draft = structuredClone(fixtures) as Mutable<S3Fixtures>;
  change(draft);
  return draft;
}

function clean(findings: readonly string[]): void {
  expect(findings).toEqual([]);
}

/** Asserts that one finding names every needle. */
function finds(findings: readonly string[], ...needles: string[]): void {
  expect({ findings, named: findings.some((finding) => needles.every((needle) => finding.includes(needle))) }).toEqual({
    findings,
    named: true,
  });
}

const real = loadS3Fixtures();

// -- docker/minio ------------------------------------------------------------------------------------------------

/** The stages of a Dockerfile: each `FROM ... AS <name>` with the lines up to the next FROM. */
function stages(dockerfile: string): { readonly name: string; readonly from: string; readonly body: string }[] {
  const lines = dockerfile.split("\n");
  const result: { name: string; from: string; body: string }[] = [];
  for (const line of lines) {
    const from = /^FROM (\S+) AS (\S+)$/.exec(line);
    if (from) result.push({ name: from[2], from: from[1], body: "" });
    else if (result.length > 0) result[result.length - 1].body += `${line}\n`;
  }
  return result;
}

function dockerfileFindings({ files }: S3Fixtures): string[] {
  const dockerfile = files["docker/minio/Dockerfile"];
  if (dockerfile === undefined) return ["docker/minio/Dockerfile is missing"];
  const findings: string[] = [];
  const byName = Object.fromEntries(stages(dockerfile).map((stage) => [stage.name, stage]));
  for (const name of ["build-minio", "build-mc", "server", "mc"])
    if (byName[name] === undefined) findings.push(`the Dockerfile has no stage ${name}`);
  for (const stage of stages(dockerfile)) {
    if (!/@sha256:[0-9a-f]{64}$/.test(stage.from))
      findings.push(`stage ${stage.name} is FROM ${stage.from}, not pinned by digest`);
  }
  for (const name of ["build-minio", "build-mc"]) {
    const body = byName[name]?.body ?? "";
    for (const setting of ["CGO_ENABLED=0", "GOTOOLCHAIN=local", "GOSUMDB=sum.golang.org", "GOFLAGS=-trimpath"])
      if (!body.includes(setting)) findings.push(`stage ${name} does not set ${setting}`);
    if (!/^FROM golang:1\.24\.\d+-alpine3\.22@sha256:[0-9a-f]{64} AS /m.test(dockerfile))
      findings.push("the build stages are not FROM a golang:1.24.13-alpine3.22 image pinned by digest");
  }
  if (!(byName["build-minio"]?.body ?? "").includes(`go install github.com/minio/minio@${MINIO_COMMIT}`))
    findings.push(`stage build-minio does not install minio at ${MINIO_COMMIT}`);
  if (!(byName["build-mc"]?.body ?? "").includes(`go install github.com/minio/mc@${MC_COMMIT}`))
    findings.push(`stage build-mc does not install mc at ${MC_COMMIT}`);
  for (const name of ["build-mc", "mc"])
    if (
      (byName[name]?.body ?? "").includes("github.com/minio/minio") ||
      (byName[name]?.body ?? "").includes("build-minio")
    )
      findings.push(`stage ${name} reaches the minio server build, so building mc compiles the server`);
  for (const name of ["server", "mc"]) {
    const stage = byName[name];
    if (stage !== undefined && stage.from !== ALPINE_PIN)
      findings.push(`stage ${name} is FROM ${stage.from}, not ${ALPINE_PIN}`);
    if (stage !== undefined && !stage.body.includes("USER 10001:10001"))
      findings.push(`stage ${name} does not run as 10001`);
  }
  return findings;
}

function minioReadmeFindings({ files }: S3Fixtures): string[] {
  const readme = files["docker/minio/README.md"];
  if (readme === undefined) return ["docker/minio/README.md is missing"];
  const needles = [
    "RELEASE.2025-10-15T17-29-55Z",
    "RELEASE.2025-08-13T08-35-41Z",
    "It is frozen: nothing upstream will patch it.",
    "GHSA-hv4r-mvr4-25vw",
    "s3-minio",
    "s3-region",
    'restart: "no"',
    "127.0.0.1",
    "proxy.golang.org",
  ];
  return needles
    .filter((needle) => !readme.includes(needle))
    .map((needle) => `docker/minio/README.md does not say ${needle}`);
}

describe("the MinIO source build in docker/minio", () => {
  test("two targets in separate stages, every FROM pinned by digest, both installs by commit, non-root runtime", () => {
    clean(dockerfileFindings(real));
    const unpinned = planted(real, (draft) => {
      draft.files["docker/minio/Dockerfile"] = draft.files["docker/minio/Dockerfile"].replace(
        `${ALPINE_PIN} AS server`,
        "alpine:3.22 AS server",
      );
    });
    finds(dockerfileFindings(unpinned), "stage server is FROM alpine:3.22, not pinned by digest");
    const moved = planted(real, (draft) => {
      draft.files["docker/minio/Dockerfile"] = draft.files["docker/minio/Dockerfile"].replace(
        `@${MC_COMMIT}`,
        "@latest",
      );
    });
    finds(dockerfileFindings(moved), "stage build-mc does not install mc at");
    const joined = planted(real, (draft) => {
      draft.files["docker/minio/Dockerfile"] = draft.files["docker/minio/Dockerfile"].replace(
        "COPY --from=build-mc",
        "COPY --from=build-minio /go/bin/minio /usr/bin/\nCOPY --from=build-mc",
      );
    });
    finds(dockerfileFindings(joined), "stage mc reaches the minio server build");
    const root = planted(real, (draft) => {
      draft.files["docker/minio/Dockerfile"] = draft.files["docker/minio/Dockerfile"].replace(
        /USER 10001:10001\nEXPOSE/,
        "EXPOSE",
      );
    });
    finds(dockerfileFindings(root), "stage server does not run as 10001");
    const toolchain = planted(real, (draft) => {
      draft.files["docker/minio/Dockerfile"] = draft.files["docker/minio/Dockerfile"].replaceAll(
        "GOTOOLCHAIN=local",
        "GOTOOLCHAIN=auto",
      );
    });
    finds(dockerfileFindings(toolchain), "does not set GOTOOLCHAIN=local");
  });

  test("the README says why it is built here, that it is frozen and unpatched, and where it may run", () => {
    clean(minioReadmeFindings(real));
    const silent = planted(real, (draft) => {
      draft.files["docker/minio/README.md"] = draft.files["docker/minio/README.md"].replace(
        "GHSA-hv4r-mvr4-25vw",
        "an advisory",
      );
    });
    finds(minioReadmeFindings(silent), "GHSA-hv4r-mvr4-25vw");
  });
});

// -- database-compose.yml ---------------------------------------------------------------------------------------

const SILO_PIN =
  "pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46";
const SILO_MC_PIN =
  "pgsty/mc:RELEASE.2026-09-16T00-00-00Z@sha256:cfc83108c3abb371f8fb84d99c1fdc88f8c237e022409b0081fb7c0a3be634dd";
const GARAGE_PIN = "dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020";
const RUSTFS_PIN = "rustfs/rustfs:1.0.1@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c";
const CURL_PIN = "alpine/curl:8.21.0@sha256:a1c44bab54d88e18ea9a6a4ecefab7f2d230b968567b78960fcaff8d51b7f067";
const OPENSSL_PIN = "alpine/openssl:3.5.8@sha256:3f25da71f70eba788067daac3f3df03bd1de7a7c52ed89fa93b94ad2c92d986b";
const MINIO_IMAGE = "libredb-fixture/minio:RELEASE.2025-10-15T17-29-55Z";
const MC_IMAGE = "libredb-fixture/mc:RELEASE.2025-08-13T08-35-41Z";

/** What each service runs: an image pinned by digest, or a local build that is never pulled. */
const IMAGES: Readonly<Record<string, string>> = {
  minio: MINIO_IMAGE,
  "minio-region": MINIO_IMAGE,
  "minio-principals": MC_IMAGE,
  "minio-region-principals": MC_IMAGE,
  "minio-seed": CURL_PIN,
  "minio-region-seed": CURL_PIN,
  silo: SILO_PIN,
  "silo-tls": SILO_PIN,
  "silo-principals": SILO_MC_PIN,
  "silo-seed": CURL_PIN,
  "s3-certs": OPENSSL_PIN,
  "garage-keys": OPENSSL_PIN,
  garage: GARAGE_PIN,
  "garage-setup": CURL_PIN,
  "garage-seed": CURL_PIN,
  rustfs: RUSTFS_PIN,
  "rustfs-principals": SILO_MC_PIN,
  "rustfs-seed": CURL_PIN,
};
const BUILT: Readonly<Record<string, string>> = {
  minio: "server",
  "minio-region": "server",
  "minio-principals": "mc",
  "minio-region-principals": "mc",
};
const PROFILES: Readonly<Record<string, readonly string[] | undefined>> = {
  minio: ["s3-minio"],
  "minio-principals": ["s3-minio"],
  "minio-seed": ["s3-minio"],
  "minio-region": ["s3-region"],
  "minio-region-principals": ["s3-region"],
  "minio-region-seed": ["s3-region"],
  "s3-certs": ["s3-tls"],
  "silo-tls": ["s3-tls"],
};
const PORTS: Readonly<Record<string, readonly string[]>> = {
  minio: ["127.0.0.1:9000:9000"],
  "minio-region": ["127.0.0.1:9030:9000"],
  silo: ["127.0.0.1:9010:9000"],
  "silo-tls": ["127.0.0.1:9443:9000"],
  garage: ["127.0.0.1:3900:3900"],
  rustfs: ["127.0.0.1:9020:9000"],
};
const DEPENDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "minio-principals": { minio: "service_healthy" },
  "minio-seed": { minio: "service_healthy" },
  "minio-region-principals": { "minio-region": "service_healthy" },
  "minio-region-seed": { "minio-region": "service_healthy" },
  "silo-principals": { silo: "service_healthy" },
  "silo-seed": { silo: "service_healthy" },
  "silo-tls": { "s3-certs": "service_completed_successfully" },
  garage: { "garage-keys": "service_completed_successfully" },
  "garage-setup": { garage: "service_started" },
  "garage-seed": { "garage-setup": "service_completed_successfully" },
  "rustfs-principals": { rustfs: "service_healthy" },
  "rustfs-seed": { rustfs: "service_healthy" },
};
const HEALTH: Readonly<Record<string, readonly string[]>> = {
  minio: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:9000/minio/health/ready"],
  "minio-region": ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:9000/minio/health/ready"],
  silo: ["CMD", "curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:9000/minio/health/ready"],
  "silo-tls": [
    "CMD",
    "curl",
    "-fsS",
    "-o",
    "/dev/null",
    "--cacert",
    "/certs/CAs/ca.crt",
    "https://localhost:9000/minio/health/ready",
  ],
  garage: ["CMD", "/garage", "json-api", "GetClusterHealth"],
  rustfs: ["CMD", "curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:9000/health/ready"],
};

function serviceSetFindings({ services }: S3Fixtures): string[] {
  return S3_SERVICES.filter((name) => services[name] === undefined).map((name) => `${name} is missing`);
}

function imageFindings({ services }: S3Fixtures): string[] {
  const findings: string[] = [];
  for (const name of S3_SERVICES) {
    const service = services[name];
    if (service === undefined) continue;
    if (service.image !== IMAGES[name]) findings.push(`${name} runs ${service.image}, not ${IMAGES[name]}`);
    if (service.container_name !== `libredb-${name}`) findings.push(`${name} is named ${service.container_name}`);
    const target = BUILT[name];
    if (target === undefined) {
      if (!/@sha256:[0-9a-f]{64}$/.test(service.image ?? "")) findings.push(`${name} is not pinned by digest`);
      if (service.build !== undefined) findings.push(`${name} is built from source`);
    } else {
      if (service.build?.context !== "./docker/minio" || service.build.target !== target)
        findings.push(`${name} is not built from docker/minio target ${target}`);
      if (service.pull_policy !== "build") findings.push(`${name} may pull ${service.image} from a registry`);
    }
  }
  return findings;
}

/** A plain `up` starts every service with no profile, so none of those may build anything from source. */
function plainUpBuildFindings({ services }: S3Fixtures): string[] {
  return S3_SERVICES.filter(
    (name) => services[name]?.build !== undefined && (services[name]?.profiles ?? []).length === 0,
  ).map((name) => `${name} is built from source and starts on a plain up`);
}

function profileFindings({ services }: S3Fixtures): string[] {
  return S3_SERVICES.filter(
    (name) => services[name] !== undefined && !Bun.deepEquals(services[name]?.profiles, PROFILES[name]),
  ).map(
    (name) =>
      `${name} has the profiles ${JSON.stringify(services[name]?.profiles)}, not ${JSON.stringify(PROFILES[name])}`,
  );
}

function restartFindings({ services }: S3Fixtures): string[] {
  const mustNotRestart = ["minio", "minio-region", ...S3_ONE_SHOTS];
  return mustNotRestart
    .filter((name) => services[name] !== undefined && services[name]?.restart !== "no")
    .map((name) => `${name} restarts (${services[name]?.restart}), so the daemon may start it again`);
}

function portFindings({ services }: S3Fixtures): string[] {
  const findings: string[] = [];
  for (const name of S3_SERVICES) {
    const ports = services[name]?.ports;
    if (ports === undefined && PORTS[name] === undefined) continue;
    if (!Bun.deepEquals(ports, PORTS[name]))
      findings.push(`${name} publishes ${JSON.stringify(ports)}, not ${JSON.stringify(PORTS[name])}`);
    for (const port of ports ?? [])
      if (!port.startsWith("127.0.0.1:")) findings.push(`${name} publishes ${port} beyond loopback`);
  }
  return findings;
}

function boundFindings({ services }: S3Fixtures): string[] {
  const findings: string[] = [];
  for (const name of S3_SERVICES) {
    const service = services[name];
    if (service === undefined) continue;
    const limits = service.deploy?.resources?.limits;
    if (limits?.cpus === undefined || limits.memory === undefined) findings.push(`${name} is not bounded`);
    else if (service.memswap_limit !== limits.memory) findings.push(`${name} may swap past its bound`);
  }
  return findings;
}

function healthFindings({ services }: S3Fixtures): string[] {
  const findings: string[] = [];
  for (const name of S3_SERVERS) {
    const check = services[name]?.healthcheck;
    if (!Bun.deepEquals(check?.test, HEALTH[name]))
      findings.push(`${name} does not probe ${JSON.stringify(HEALTH[name])}`);
    const timing = { start_period: "30s", start_interval: "1s", interval: "30s", timeout: "5s", retries: 3 };
    for (const [field, value] of Object.entries(timing))
      if (check?.[field as keyof typeof timing] !== value)
        findings.push(`${name} has ${field} ${String(check?.[field as keyof typeof timing])}, not ${value}`);
  }
  return findings;
}

function dependsFindings({ services }: S3Fixtures): string[] {
  return Object.entries(DEPENDS)
    .filter(([name]) => services[name] !== undefined)
    .filter(([name, wanted]) => {
      const actual = Object.fromEntries(
        Object.entries(services[name]?.depends_on ?? {}).map(([key, value]) => [key, value.condition]),
      );
      return !Bun.deepEquals(actual, wanted);
    })
    .map(([name, wanted]) => `${name} does not wait for ${JSON.stringify(wanted)}`);
}

function volumeFindings({ volumes, volumesComment }: S3Fixtures): string[] {
  const findings = ["s3-garage-keys", "s3-certs"]
    .filter((name) => !volumes.includes(name))
    .map((name) => `the volume ${name} is missing`);
  const sentence =
    "s3-garage-keys keeps Garage's generated RPC secret, admin and metrics tokens and its four key secrets, and s3-certs the TLS fixture's generated CA and certificate.";
  if (!volumesComment.replace(/\n\s*#\s*/g, " ").includes(sentence))
    findings.push("the volumes comment does not describe s3-garage-keys and s3-certs");
  return findings;
}

function consolePortFindings({ services }: S3Fixtures): string[] {
  return S3_SERVERS.flatMap((name) =>
    (services[name]?.ports ?? [])
      .filter((port) => /:(9001|9091|3903|3901)$/.test(port))
      .map((port) => `${name} publishes the console or admin port ${port}`),
  );
}

describe("the S3 services in database-compose.yml", () => {
  test("every S3 fixture service is present", () => {
    clean(serviceSetFindings(real));
    finds(
      serviceSetFindings(planted(real, (draft) => void delete draft.services["garage-setup"])),
      "garage-setup is missing",
    );
  });

  test("each pulled image is pinned by digest; MinIO and its mc are built locally and never pulled", () => {
    clean(imageFindings(real));
    finds(
      imageFindings(planted(real, (draft) => void (draft.services.silo.image = "pgsty/silo:latest"))),
      "silo runs pgsty/silo:latest",
    );
    finds(imageFindings(planted(real, (draft) => void delete draft.services.minio.pull_policy)), "minio may pull");
  });

  test("a plain up builds nothing from source", () => {
    clean(plainUpBuildFindings(real));
    finds(
      plainUpBuildFindings(planted(real, (draft) => void delete draft.services.minio.profiles)),
      "minio is built from source and starts on a plain up",
    );
  });

  test("MinIO behind s3-minio, its region variant behind s3-region, the TLS fixture behind s3-tls, the rest on a plain up", () => {
    clean(profileFindings(real));
    finds(
      profileFindings(planted(real, (draft) => void (draft.services.rustfs.profiles = ["s3"]))),
      "rustfs has the profiles",
    );
  });

  test("the frozen MinIO and every one-shot never restart", () => {
    clean(restartFindings(real));
    finds(
      restartFindings(planted(real, (draft) => void (draft.services["minio-region"].restart = "unless-stopped"))),
      "minio-region restarts",
    );
  });

  test("every published port is on 127.0.0.1 and no console or admin port is published", () => {
    clean(portFindings(real));
    clean(consolePortFindings(real));
    finds(
      portFindings(planted(real, (draft) => void (draft.services.garage.ports = ["3900:3900"]))),
      "garage publishes 3900:3900 beyond loopback",
    );
    finds(
      consolePortFindings(planted(real, (draft) => void draft.services.silo.ports?.push("127.0.0.1:9011:9001"))),
      "silo publishes the console",
    );
  });

  test("every service is bounded with no swap past its bound", () => {
    clean(boundFindings(real));
    finds(
      boundFindings(planted(real, (draft) => void (draft.services["rustfs-seed"].memswap_limit = "1G"))),
      "rustfs-seed may swap",
    );
  });

  test("every server has its measured probe and the five timing fields", () => {
    clean(healthFindings(real));
    finds(
      healthFindings(planted(real, (draft) => void (draft.services.garage.healthcheck = { test: ["CMD", "true"] }))),
      "garage does not probe",
    );
  });

  test("each one-shot waits for the right condition, and nothing waits for Garage to be healthy before its layout exists", () => {
    clean(dependsFindings(real));
    const deadlock = planted(
      real,
      (draft) => void (draft.services["garage-setup"].depends_on = { garage: { condition: "service_healthy" } }),
    );
    finds(dependsFindings(deadlock), "garage-setup does not wait for");
  });

  test("the two named volumes exist and the comment says what each holds", () => {
    clean(volumeFindings(real));
    finds(
      volumeFindings(
        planted(real, (draft) => void (draft.volumes = draft.volumes.filter((name) => name !== "s3-certs"))),
      ),
      "the volume s3-certs is missing",
    );
  });
});

// -- docker/s3 principals, Garage and TLS material -------------------------------------------------------------

const GARAGE_KEY_FILES = [
  "rpc.secret",
  "admin.token",
  "metrics.token",
  "rw.secret",
  "browse.secret",
  "scoped.secret",
  "none.secret",
];
const GARAGE_KEY_IDS = [
  "GK000000000000000000000001",
  "GK000000000000000000000002",
  "GK000000000000000000000003",
  "GK000000000000000000000004",
];

/** A shell script without its whole-line comments, so a comment that names a tool is not a call to it. */
function shellCode(script: string): string {
  return script
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function garageConfigFindings({ files, services }: S3Fixtures): string[] {
  const toml = files["docker/s3/garage.toml"];
  if (toml === undefined) return ["docker/s3/garage.toml is missing"];
  const findings: string[] = [];
  for (const key of ["rpc_secret", "admin_token", "metrics_token"])
    if (new RegExp(`^\\s*${key}\\s*=`, "m").test(toml)) findings.push(`garage.toml sets ${key}, a secret`);
  for (const line of [
    's3_region = "garage"',
    'api_bind_addr = "[::]:3900"',
    'api_bind_addr = "[::]:3903"',
    "replication_factor = 1",
  ])
    if (!toml.includes(line)) findings.push(`garage.toml does not set ${line}`);
  if (/root_domain/.test(toml)) findings.push("garage.toml sets root_domain, an untested virtual-hosted listener");
  const environment = services.garage?.environment ?? {};
  for (const [name, file] of [
    ["GARAGE_RPC_SECRET_FILE", "/keys/rpc.secret"],
    ["GARAGE_ADMIN_TOKEN_FILE", "/keys/admin.token"],
    ["GARAGE_METRICS_TOKEN_FILE", "/keys/metrics.token"],
  ] as const)
    if (environment[name] !== file) findings.push(`garage does not read ${name} from ${file}`);
  return findings;
}

function garageKeysFindings({ files }: S3Fixtures): string[] {
  const script = files["docker/s3/garage-keys.sh"];
  if (script === undefined) return ["docker/s3/garage-keys.sh is missing"];
  const findings = GARAGE_KEY_FILES.filter((name) => !script.includes(name)).map(
    (name) => `garage-keys.sh does not write ${name}`,
  );
  if (!script.includes("openssl rand -hex 32"))
    findings.push("garage-keys.sh does not draw each secret with openssl rand -hex 32");
  if (!script.includes('[ -s "$DIR/$name" ] && continue'))
    findings.push("garage-keys.sh rewrites a secret that exists");
  if (!script.includes("chmod 0600")) findings.push("garage-keys.sh leaves a secret readable");
  return findings;
}

function garageSetupFindings({ files }: S3Fixtures): string[] {
  const script = files["docker/s3/garage-setup.sh"];
  if (script === undefined) return ["docker/s3/garage-setup.sh is missing"];
  const calls = [
    "/v2/GetClusterStatus",
    "/v2/UpdateClusterLayout",
    "/v2/ApplyClusterLayout",
    "/v2/GetBucketInfo",
    "/v2/CreateBucket",
    "/v2/GetKeyInfo",
    "/v2/ImportKey",
    "/v2/AllowBucketKey",
    "/v2/AddBucketAlias",
    "/v2/GetClusterHealth",
  ];
  const findings = calls.filter((call) => !script.includes(call)).map((call) => `garage-setup.sh never calls ${call}`);
  for (const id of GARAGE_KEY_IDS) if (!script.includes(id)) findings.push(`garage-setup.sh does not import ${id}`);
  if (!script.includes("scoped-local")) findings.push("garage-setup.sh does not add the local alias scoped-local");
  if (/\bjq\b/.test(shellCode(script))) findings.push("garage-setup.sh calls jq, which alpine/curl does not carry");
  const code = shellCode(script);
  if (!code.includes(`s/": /":/g`)) findings.push("garage-setup.sh does not flatten Garage's pretty-printed answers");
  if (code.includes(`"alias":"scoped-local"`) || !code.includes(`"bucketLocalAliases":["scoped-local"`))
    findings.push("garage-setup.sh reads the scoped-local alias from a field GetBucketInfo does not answer");
  return findings;
}

function principalsFindings({ files }: S3Fixtures): string[] {
  const script = files["docker/s3/principals.sh"];
  if (script === undefined) return ["docker/s3/principals.sh is missing"];
  const findings: string[] = [];
  for (const user of ["studio-browse", "studio-scoped", "studio-getonly"])
    if (!script.includes(user)) findings.push(`principals.sh does not add ${user}`);
  for (const policy of ["studio-browse", "studio-scoped", "readonly"])
    if (!script.includes(`attach ${policy === "readonly" ? "studio-getonly readonly" : `${policy} ${policy}`}`))
      findings.push(`principals.sh does not attach ${policy}`);
  if (/\bgrep\b/.test(shellCode(script)))
    findings.push("principals.sh calls grep, which the Silo-line mc image may not carry");
  const code = shellCode(script);
  if (!code.includes(`"policyName"`) || code.includes(`*"\\"$2\\""*`))
    findings.push("principals.sh matches the policy anywhere in the user info answer, not in its policyName field");
  return findings;
}

function policyFindings({ files }: S3Fixtures): string[] {
  const findings: string[] = [];
  const browse = files["docker/s3/policies/studio-browse.json"];
  const scoped = files["docker/s3/policies/studio-scoped.json"];
  if (browse === undefined) return ["docker/s3/policies/studio-browse.json is missing"];
  if (scoped === undefined) return ["docker/s3/policies/studio-scoped.json is missing"];
  const actions = (text: string) =>
    (JSON.parse(text) as { Statement: { Action: string[] }[] }).Statement.flatMap(
      (statement) => statement.Action,
    ).sort();
  const browseActions = [
    "s3:GetBucketLocation",
    "s3:GetObject",
    "s3:GetObjectVersion",
    "s3:ListAllMyBuckets",
    "s3:ListBucket",
    "s3:ListBucketVersions",
  ];
  if (!Bun.deepEquals(actions(browse), browseActions))
    findings.push(`studio-browse allows ${actions(browse).join(", ")}`);
  if (!Bun.deepEquals(actions(scoped), ["s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket"]))
    findings.push(`studio-scoped allows ${actions(scoped).join(", ")}`);
  if (!scoped.includes("arn:aws:s3:::studio-scoped") || scoped.includes("arn:aws:s3:::*"))
    findings.push("studio-scoped reaches beyond studio-scoped");
  return findings;
}

function certsFindings({ files }: S3Fixtures): string[] {
  const script = files["docker/s3/certs.sh"];
  if (script === undefined) return ["docker/s3/certs.sh is missing"];
  const findings: string[] = [];
  for (const name of ["public.crt", "private.key", "CAs/ca.crt", "ca.pem"])
    if (!script.includes(name)) findings.push(`certs.sh does not write ${name}`);
  for (const san of ["DNS:localhost", "IP:127.0.0.1", "DNS:silo-tls"])
    if (!script.includes(san)) findings.push(`certs.sh does not name ${san}`);
  if (!script.includes("chmod 0600")) findings.push("certs.sh leaves the private key readable");
  return findings;
}

describe("the principals, Garage and TLS material of docker/s3", () => {
  test("garage.toml holds no secret, and Garage reads its three secrets from the keys volume", () => {
    clean(garageConfigFindings(real));
    const leaked = planted(real, (draft) => void (draft.files["docker/s3/garage.toml"] += '\nrpc_secret = "00"\n'));
    finds(garageConfigFindings(leaked), "garage.toml sets rpc_secret");
    const unread = planted(real, (draft) => void delete draft.services.garage.environment?.GARAGE_ADMIN_TOKEN_FILE);
    finds(garageConfigFindings(unread), "garage does not read GARAGE_ADMIN_TOKEN_FILE");
  });

  test("garage-keys.sh writes the seven secrets only when missing, private to the volume", () => {
    clean(garageKeysFindings(real));
    const rewrite = planted(real, (draft) => {
      draft.files["docker/s3/garage-keys.sh"] = draft.files["docker/s3/garage-keys.sh"].replace(
        '[ -s "$DIR/$name" ] && continue',
        ":",
      );
    });
    finds(garageKeysFindings(rewrite), "rewrites a secret that exists");
  });

  test("garage-setup.sh makes every admin API call the Garage setup needs, and no jq", () => {
    clean(garageSetupFindings(real));
    finds(
      garageSetupFindings(planted(real, (draft) => void (draft.files["docker/s3/garage-setup.sh"] += "\njq .\n"))),
      "calls jq",
    );
    clean(
      garageSetupFindings(
        planted(
          real,
          (draft) => void (draft.files["docker/s3/garage-setup.sh"] += "\n  # alpine/curl carries no jq\n"),
        ),
      ),
    );
    const unflattened = planted(real, (draft) => {
      draft.files["docker/s3/garage-setup.sh"] = draft.files["docker/s3/garage-setup.sh"].replaceAll(
        `s/": /":/g`,
        "s/x/x/",
      );
    });
    finds(garageSetupFindings(unflattened), "does not flatten Garage's pretty-printed answers");
    const oldAlias = planted(
      real,
      (draft) =>
        void (draft.files["docker/s3/garage-setup.sh"] += `\ncase "$scoped" in *'"alias":"scoped-local"'*) ;; esac\n`),
    );
    finds(garageSetupFindings(oldAlias), "reads the scoped-local alias from a field GetBucketInfo does not answer");
  });

  test("principals.sh adds the three users and attaches their policies, with no grep", () => {
    clean(principalsFindings(real));
    finds(
      principalsFindings(planted(real, (draft) => void (draft.files["docker/s3/principals.sh"] += "\ngrep x\n"))),
      "calls grep",
    );
    clean(
      principalsFindings(
        planted(
          real,
          (draft) => void (draft.files["docker/s3/principals.sh"] += "\n# not every mc image carries grep\n"),
        ),
      ),
    );
    const wholeAnswer = planted(
      real,
      (draft) => void (draft.files["docker/s3/principals.sh"] += `\ncase "$info" in *"\\"$2\\""*) return 0 ;; esac\n`),
    );
    finds(principalsFindings(wholeAnswer), "matches the policy anywhere in the user info answer");
  });

  test("the browse policy is the least privilege Studio needs and the scoped one names one bucket", () => {
    clean(policyFindings(real));
    const wider = planted(real, (draft) => {
      draft.files["docker/s3/policies/studio-browse.json"] = draft.files[
        "docker/s3/policies/studio-browse.json"
      ].replace('"s3:GetObject",', '"s3:GetObject", "s3:PutObject",');
    });
    finds(policyFindings(wider), "studio-browse allows", "s3:PutObject");
  });

  test("certs.sh names localhost, 127.0.0.1 and silo-tls and keeps the key private", () => {
    clean(certsFindings(real));
    finds(
      certsFindings(
        planted(
          real,
          (draft) =>
            void (draft.files["docker/s3/certs.sh"] = draft.files["docker/s3/certs.sh"].replace(
              "DNS:silo-tls",
              "DNS:silo",
            )),
        ),
      ),
      "DNS:silo-tls",
    );
  });
});

// -- docker/s3/data -------------------------------------------------------------------------------------------------

const DATA_FILES = [
  "bomb.ndjson.gz",
  "noext",
  "one-mib.bin",
  "rows-partial.ndjson",
  "truncated.json",
  "truncated.parquet",
  "utf8-boundary.txt",
] as const;
const DATA_MAX_BYTES = 2.5 * 1024 * 1024;
const DERIVED_MULTIPART = "derived/multipart.bin";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** SHA256SUMS as name to digest. */
function sums(data: S3Fixtures["data"]): Map<string, string> {
  const text = new TextDecoder().decode(data.SHA256SUMS ?? new Uint8Array());
  return new Map(
    text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [digest, name] = line.split("  ");
        return [name, digest] as const;
      }),
  );
}

function dataFindings({ data }: S3Fixtures): string[] {
  if (data.SHA256SUMS === undefined) return ["docker/s3/data/SHA256SUMS is missing"];
  const findings: string[] = [];
  const listed = sums(data);
  for (const name of DATA_FILES) if (data[name] === undefined) findings.push(`docker/s3/data/${name} is missing`);
  for (const [name, bytes] of Object.entries(data)) {
    if (name === "SHA256SUMS") continue;
    if (!(DATA_FILES as readonly string[]).includes(name))
      findings.push(`docker/s3/data/${name} is not a file make-data.ts writes`);
    if (listed.get(name) !== sha256(bytes)) findings.push(`docker/s3/data/${name} does not match its SHA256SUMS line`);
    if (bytes.length > DATA_MAX_BYTES)
      findings.push(`docker/s3/data/${name} holds ${bytes.length} bytes, over 2.5 MiB`);
  }
  for (const name of listed.keys())
    if (name !== DERIVED_MULTIPART && data[name] === undefined)
      findings.push(`SHA256SUMS lists ${name}, which is not on disk`);
  const one = data["one-mib.bin"];
  if (one !== undefined) {
    const six = new Uint8Array(one.length * 6);
    for (let part = 0; part < 6; part++) six.set(one, part * one.length);
    if (listed.get(DERIVED_MULTIPART) !== sha256(six))
      findings.push(`SHA256SUMS ${DERIVED_MULTIPART} is not one-mib.bin six times over`);
  }
  return findings;
}

/** The first byte of the 4-byte character must start within the 3 bytes before the text read cap. */
function utf8BoundaryFindings({ data }: S3Fixtures, cap: number): string[] {
  const bytes = data["utf8-boundary.txt"];
  if (bytes === undefined) return ["docker/s3/data/utf8-boundary.txt is missing"];
  const at = bytes.findIndex((byte) => byte >= 0xf0);
  if (at < cap - 3 || at >= cap)
    return [
      `utf8-boundary.txt starts its 4-byte character at ${at}, not within the 3 bytes before ${cap}: run bun docker/s3/make-data.ts`,
    ];
  return [];
}

describe("the seed's own sample files in docker/s3/data", () => {
  test("every file is make-data.ts's, listed with its digest, at most 2.5 MiB, and the multipart digest is derived", () => {
    clean(dataFindings(real));
    finds(
      dataFindings(planted(real, (draft) => void (draft.data.noext = new Uint8Array([1])))),
      "noext does not match",
    );
    finds(
      dataFindings(planted(real, (draft) => void (draft.data["big.bin"] = new Uint8Array(3 * 1024 * 1024)))),
      "big.bin is not a file",
    );
    finds(
      dataFindings(planted(real, (draft) => void (draft.data["big.bin"] = new Uint8Array(3 * 1024 * 1024)))),
      "big.bin holds 3145728 bytes",
    );
  });

  test("the UTF-8 boundary file follows the provider's text read cap", () => {
    clean(utf8BoundaryFindings(real, S3_PREVIEW_LIMITS.textFetchBytes));
    finds(utf8BoundaryFindings(real, S3_PREVIEW_LIMITS.textFetchBytes + 64), "run bun docker/s3/make-data.ts");
  });
});

// -- docker/s3/seed.sh ----------------------------------------------------------------------------------------------

const SEED = "docker/s3/seed.sh";
const OUTCOME = /^(stored|measure|[45]\d\d:[A-Za-z]+)$/;
const LAST_OBJECTS = ["parquet/truncated.parquet", "b-only/table.csv", "ver/zz-last.txt", "mixed/k-1199/inner.txt"];
const PARTIAL_SENTENCE = "studio-versions holds a partial seed; reset the server with rm -s -f -v and run again";

/** `abcdefghijklmnopqrstuvwxyz` repeated and cut to n characters, as seed.sh's seg() writes it. */
function segment(n: number): string {
  return "abcdefghijklmnopqrstuvwxyz".repeat(10).slice(0, n);
}
const LONG = `${segment(250)}/${segment(250)}/${segment(250)}/${segment(245)}`;

interface SpecialKey {
  readonly wire: string;
  readonly outcomes: readonly string[];
}

/** The rows of seed.sh's SPECIAL_KEYS table, with @LONG@ expanded as seed.sh expands it. */
function specialKeys(script: string): SpecialKey[] {
  const table = /^SPECIAL_KEYS='\n([\s\S]*?)\n'$/m.exec(script)?.[1] ?? "";
  return table
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [wire, ...outcomes] = line.split("|");
      return { wire: wire.replace("@LONG@", LONG), outcomes };
    });
}

/** Percent-decodes a wire form to its UTF-8 text, or undefined when the bytes are not text. */
function decodeWire(wire: string): string | undefined {
  const bytes: number[] = [];
  for (let at = 0; at < wire.length; at++) {
    if (wire[at] === "%") {
      bytes.push(Number.parseInt(wire.slice(at + 1, at + 3), 16));
      at += 2;
    } else bytes.push(wire.charCodeAt(at));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
}

function seedFindings({ files }: S3Fixtures): string[] {
  const script = files[SEED];
  if (script === undefined) return [`${SEED} is missing`];
  const findings: string[] = [];
  script.split("\n").forEach((line, index) => {
    if (/^\s*#/.test(line) || !/\bcurl\b/.test(line)) return;
    if (!line.includes("--path-as-is")) findings.push(`${SEED}:${index + 1} runs curl without --path-as-is`);
  });
  const keys = specialKeys(script);
  if (keys.length !== 14) findings.push(`${SEED} lists ${keys.length} special keys, not 14`);
  for (const { wire, outcomes } of keys) {
    const decoded = decodeWire(wire);
    if (decoded === undefined) findings.push(`the special key ${wire} is not UTF-8 text`);
    else if (rfc3986Path(decoded.split("/")).slice(1) !== wire)
      findings.push(`the special key ${wire} is not the RFC 3986 form of ${JSON.stringify(decoded)}`);
    if (outcomes.length !== 4 || !outcomes.every((outcome) => OUTCOME.test(outcome)))
      findings.push(`the special key ${wire} has the outcomes ${outcomes.join("|")}`);
  }
  const long = keys.find((key) => key.wire.startsWith("long/"));
  if (long === undefined || new TextEncoder().encode(long.wire).length !== 1_003)
    findings.push("the long key is not 1,003 bytes");
  for (const last of LAST_OBJECTS)
    if (!script.includes(`/${last}`)) findings.push(`${SEED} never checks the last object ${last}`);
  if (!script.includes(PARTIAL_SENTENCE)) findings.push(`${SEED} does not stop on a partial studio-versions`);
  if (!/-H 'x-amz-meta-[a-z]+: [^'\n]*[^\x00-\x7f][^'\n]*'/.test(script))
    findings.push(`${SEED} gives meta/tagged.txt no user metadata value with non-ASCII UTF-8 text`);
  if (!script.includes("measured $SERVER studio-demo/meta/tagged.txt"))
    findings.push(`${SEED} does not print each server's answer to the non-ASCII metadata value`);
  return findings;
}

function seedSourceFindings({ files }: S3Fixtures): string[] {
  const script = files[SEED] ?? "";
  const findings: string[] = [];
  for (const [, name] of script.matchAll(/\/preview\/([A-Za-z0-9._-]+)/g))
    if (!existsSync(path.join(ROOT, "tests/fixtures/s3/preview", name)))
      findings.push(`${SEED} uploads /preview/${name}, which is not committed`);
  for (const [, name] of script.matchAll(/\/s3\/data\/([A-Za-z0-9._-]+)/g))
    if (!(DATA_FILES as readonly string[]).includes(name))
      findings.push(`${SEED} uploads /s3/data/${name}, which make-data.ts does not write`);
  return findings;
}

describe("the object seed docker/s3/seed.sh", () => {
  test("every curl keeps dot segments, every special key is sent in its RFC 3986 form, and each bucket ends on a known object", () => {
    clean(seedFindings(real));
    const resolving = planted(real, (draft) => {
      draft.files[SEED] = draft.files[SEED].replace("curl --path-as-is", "curl");
    });
    finds(seedFindings(resolving), "runs curl without --path-as-is");
    const plus = planted(real, (draft) => {
      draft.files[SEED] = draft.files[SEED].replace("sp/plus%2Bsign.txt|", "sp/plus+sign.txt|");
    });
    finds(seedFindings(plus), "sp/plus+sign.txt is not the RFC 3986 form");
    const lower = planted(real, (draft) => {
      draft.files[SEED] = draft.files[SEED].replace("%C3%BCn", "%c3%bcn");
    });
    finds(seedFindings(lower), "is not the RFC 3986 form");
  });

  test("meta/tagged.txt carries one user metadata value with non-ASCII UTF-8 text, and each server's answer is printed", () => {
    const ascii = planted(real, (draft) => {
      draft.files[SEED] = draft.files[SEED].replace("café", "cafe");
    });
    finds(seedFindings(ascii), "no user metadata value with non-ASCII UTF-8 text");
    const silent = planted(real, (draft) => {
      draft.files[SEED] = draft.files[SEED].replaceAll("measured $SERVER studio-demo/meta/tagged.txt", "stored");
    });
    finds(seedFindings(silent), "does not print each server's answer");
  });

  test("every file the seed uploads exists: the committed preview fixtures and make-data.ts's files", () => {
    clean(seedSourceFindings(real));
    const missing = planted(real, (draft) => void (draft.files[SEED] += "\n# /preview/no-such.parquet\n"));
    finds(seedSourceFindings(missing), "/preview/no-such.parquet, which is not committed");
  });

  test("the script parses under sh", () => {
    const parsed = Bun.spawnSync(["sh", "-n", path.join(ROOT, SEED)]);
    expect({ exit: parsed.exitCode, stderr: parsed.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
  });
});

// -- docker/s3/README.md --------------------------------------------------------------------------------------------

const README = "docker/s3/README.md";
type S3RoleName = "root" | "browse" | "scoped" | "getonly";
const ROLE_NAMES: readonly S3RoleName[] = ["root", "browse", "scoped", "getonly"];
const SILO_TLS_LINES = [
  "$P run --rm --no-deps -T -v libredb-studio_s3-certs:/certs:ro -e SSL_CERT_FILE=/certs/CAs/ca.crt --entrypoint sh silo-principals /s3/principals.sh https://silo-tls:9000",
  "$P run --rm --no-deps -T -v libredb-studio_s3-certs:/certs:ro -e S3_SEED_CA=/certs/CAs/ca.crt --entrypoint sh silo-seed /s3/seed.sh https://silo-tls:9000 us-east-1 silo",
];
const README_HEADINGS = [
  "## The servers",
  "## Bringing them up",
  "## The scripts",
  "## Principals and keys",
  "## Seeded data",
  "## Special keys",
  "## Bounds, as measured",
  "## Telemetry",
  "## First-run measurements",
  "## The SSH bastion of the tunnel check",
];

/** The rows `| <role> | `<access key>` | `<password>` | `<Garage key id>` (...) | ... |` of the principals table. */
function readmePrincipals(
  readme: string,
): Partial<Record<S3RoleName, { accessKeyId: string; secret: string; garageKeyId: string }>> {
  const rows: Partial<Record<S3RoleName, { accessKeyId: string; secret: string; garageKeyId: string }>> = {};
  for (const line of readme.split("\n")) {
    const row = /^\| (root|browse|scoped|getonly) \| `([^`]+)` \| `([^`]+)` \| `(GK[0-9a-f]{24})`/.exec(line);
    if (row) rows[row[1] as S3RoleName] = { accessKeyId: row[2], secret: row[3], garageKeyId: row[4] };
  }
  return rows;
}

function readmeFindings({ files, services }: S3Fixtures): string[] {
  const readme = files[README];
  if (readme === undefined) return [`${README} is missing`];
  const findings: string[] = [];
  for (const heading of README_HEADINGS)
    if (!readme.split("\n").includes(heading)) findings.push(`${README} has no ${heading}`);
  for (const line of SILO_TLS_LINES)
    if (!readme.includes(line)) findings.push(`${README} does not carry the silo-tls line ${line.slice(0, 60)}`);
  for (const name of S3_SERVICES) if (!readme.includes(`\`${name}\``)) findings.push(`${README} never names ${name}`);
  const principals = readmePrincipals(readme);
  for (const role of ROLE_NAMES)
    if (principals[role] === undefined) findings.push(`${README} has no principals row for ${role}`);
  const root = principals.root;
  const env = services.minio?.environment ?? {};
  if (root !== undefined && (env.MINIO_ROOT_USER !== root.accessKeyId || env.MINIO_ROOT_PASSWORD !== root.secret))
    findings.push("the README's root principal is not the compose file's MinIO root");
  const rustfs = services.rustfs?.environment ?? {};
  if (root !== undefined && (rustfs.RUSTFS_ACCESS_KEY !== root.accessKeyId || rustfs.RUSTFS_SECRET_KEY !== root.secret))
    findings.push("the README's root principal is not the compose file's RustFS root");
  const principalsScript = files["docker/s3/principals.sh"] ?? "";
  for (const role of ["browse", "scoped", "getonly"] as const) {
    const row = principals[role];
    if (row !== undefined && !principalsScript.includes(`"${row.accessKeyId} ${row.secret}"`))
      findings.push(`principals.sh does not create ${row.accessKeyId} with the README's password`);
  }
  GARAGE_KEY_IDS.forEach((id, index) => {
    if (principals[ROLE_NAMES[index]]?.garageKeyId !== id)
      findings.push(`the README's ${ROLE_NAMES[index]} row does not name ${id}`);
  });
  return findings;
}

describe("the fixtures README docker/s3/README.md", () => {
  test("names every service, carries the bring-up lines, and its principals are the ones the compose file and scripts create", () => {
    clean(readmeFindings(real));
    const drifted = planted(real, (draft) => {
      draft.files[README] = draft.files[README].replace("`Browse123pass!`", "`Browse124pass!`");
    });
    finds(readmeFindings(drifted), "principals.sh does not create studio-browse");
    const lost = planted(real, (draft) => {
      draft.files[README] = draft.files[README].replace(SILO_TLS_LINES[1], "");
    });
    finds(readmeFindings(lost), "does not carry the silo-tls line");
  });
});

// -- docker/s3/seed-connections.yaml --------------------------------------------------------------------------------

const SEED_CONNECTIONS = "docker/s3/seed-connections.yaml";
const SEED_TARGETS = [
  { target: "minio", port: 9000, region: "us-east-1" },
  { target: "minio-region", port: 9030, region: "eu-central-1" },
  { target: "silo", port: 9010, region: "us-east-1" },
  { target: "garage", port: 3900, region: "garage" },
  { target: "rustfs", port: 9020, region: "us-east-1" },
] as const;
const SEED_SUFFIXES = [
  { suffix: "root", role: "root", pin: undefined },
  { suffix: "browse", role: "browse", pin: undefined },
  { suffix: "browse-demo", role: "browse", pin: "studio-demo" },
  { suffix: "scoped", role: "scoped", pin: undefined },
  { suffix: "scoped-pin", role: "scoped", pin: "studio-scoped" },
  { suffix: "getonly", role: "getonly", pin: "studio-demo" },
] as const;
const GARAGE_ENV: Readonly<Record<S3RoleName, string>> = {
  root: "${LIBREDB_S3_GARAGE_ROOT_SECRET}",
  browse: "${LIBREDB_S3_GARAGE_BROWSE_SECRET}",
  scoped: "${LIBREDB_S3_GARAGE_SCOPED_SECRET}",
  getonly: "${LIBREDB_S3_GARAGE_GETONLY_SECRET}",
};

interface SeedRow {
  readonly id: string;
  readonly type: string;
  readonly host: string;
  readonly port: number;
  readonly region?: string;
  readonly user?: string;
  readonly password?: string;
  readonly database?: string;
  readonly roles: readonly string[];
  readonly managed?: boolean;
  readonly readOnly?: boolean;
  readonly allowInsecureAuth?: boolean;
  readonly ssl?: { readonly mode: string; readonly caCert?: string };
}

function seedConnectionFindings({ files }: S3Fixtures): string[] {
  const text = files[SEED_CONNECTIONS];
  if (text === undefined) return [`${SEED_CONNECTIONS} is missing`];
  const file = parseYaml(text) as { connections: SeedRow[] };
  const findings: string[] = [];
  const parsed = SeedConfigSchema.safeParse(file);
  if (!parsed.success)
    findings.push(`${SEED_CONNECTIONS} does not load: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  const principals = readmePrincipals(files[README] ?? "");
  const byId = new Map(file.connections.map((row) => [row.id, row]));
  const expected: Record<string, Partial<SeedRow>> = {};
  for (const { target, port, region } of SEED_TARGETS)
    for (const { suffix, role, pin } of SEED_SUFFIXES) {
      const principal = principals[role];
      expected[`s3-${target}-${suffix}`] = {
        port,
        region,
        user: target === "garage" ? principal?.garageKeyId : principal?.accessKeyId,
        password: target === "garage" ? GARAGE_ENV[role] : principal?.secret,
        database: pin,
      };
    }
  expected["s3-silo-tls-browse"] = {
    port: 9443,
    region: "us-east-1",
    user: principals.browse?.accessKeyId,
    password: principals.browse?.secret,
  };
  for (const [id, want] of Object.entries(expected)) {
    const row = byId.get(id);
    if (row === undefined) {
      findings.push(`${SEED_CONNECTIONS} has no ${id}`);
      continue;
    }
    for (const [field, value] of Object.entries(want))
      if (row[field as keyof SeedRow] !== value)
        findings.push(
          `${id} has ${field} ${JSON.stringify(row[field as keyof SeedRow])}, not ${JSON.stringify(value)}`,
        );
  }
  for (const row of file.connections) {
    if (expected[row.id] === undefined) findings.push(`${SEED_CONNECTIONS} holds ${row.id}, which no rule names`);
    if (row.type !== "s3" || row.host !== "localhost") findings.push(`${row.id} is not an s3 connection to localhost`);
    if (row.managed !== true || row.readOnly !== true) findings.push(`${row.id} is not managed and read-only`);
    if (!Bun.deepEquals(row.roles, ["*"])) findings.push(`${row.id} is not offered to every role`);
    if (row.allowInsecureAuth !== undefined)
      findings.push(`${row.id} sets allowInsecureAuth, which a loopback target never needs`);
    if (row.region === undefined) findings.push(`${row.id} leaves region implicit`);
  }
  const tls = byId.get("s3-silo-tls-browse")?.ssl;
  if (tls?.mode !== "verify-ca" || tls.caCert !== "${LIBREDB_S3_TLS_CA}")
    findings.push("s3-silo-tls-browse does not verify the CA of LIBREDB_S3_TLS_CA");
  if (/\b[0-9a-f]{64}\b/.test(text))
    findings.push(`${SEED_CONNECTIONS} holds a 64-hex value, which only a generated Garage secret would be`);
  return findings;
}

describe("the seed connections docker/s3/seed-connections.yaml", () => {
  test("load as a seed file, one per target and principal, managed, read-only, with the README's principals", () => {
    clean(seedConnectionFindings(real));
    const leaked = planted(real, (draft) => {
      draft.files[SEED_CONNECTIONS] = draft.files[SEED_CONNECTIONS].replace(
        "${LIBREDB_S3_GARAGE_ROOT_SECRET}",
        "a".repeat(64),
      );
    });
    finds(seedConnectionFindings(leaked), "holds a 64-hex value");
    const consent = planted(real, (draft) => {
      draft.files[SEED_CONNECTIONS] = draft.files[SEED_CONNECTIONS].replace(
        'id: "s3-silo-root"',
        'id: "s3-silo-root"\n    allowInsecureAuth: true',
      );
    });
    finds(seedConnectionFindings(consent), "s3-silo-root sets allowInsecureAuth");
  });
});

// -- tests/live/s3-*.ts ---------------------------------------------------------------------------------------------

const SEED_RAW = "tests/live/s3-seed-raw.ts";
const SOCKET_IMPORTS = /from\s+"(node:)?(http|https|net|tls|dgram|http2)"|\bfetch\s*\(|new\s+WebSocket\b/;

function seedRawFindings({ files }: S3Fixtures): string[] {
  const script = files[SEED_RAW];
  if (script === undefined) return [`${SEED_RAW} is missing`];
  const findings: string[] = [];
  if (SOCKET_IMPORTS.test(script)) findings.push(`${SEED_RAW} can open a socket`);
  if (/from\s+"@\/lib\/db\/providers\//.test(script)) findings.push(`${SEED_RAW} imports a provider module`);
  return findings;
}

/** No file of tests/live/s3-*.ts names a method other than GET or HEAD in a request it builds. */
function liveMethodFindings({ files }: S3Fixtures): string[] {
  const findings: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (!file.startsWith("tests/live/s3-")) continue;
    for (const [match] of text.matchAll(/method:\s*"([A-Z]+)"/g))
      if (!/"(GET|HEAD)"/.test(match)) findings.push(`${file} builds a ${match} request`);
  }
  return findings;
}

describe("the run-time object generator tests/live/s3-seed-raw.ts", () => {
  test("opens no socket and imports no provider module: the target's own seed one-shot uploads", () => {
    clean(seedRawFindings(real));
    finds(
      seedRawFindings(planted(real, (draft) => void (draft.files[SEED_RAW] += '\nimport http from "node:http";\n'))),
      "can open a socket",
    );
    finds(
      seedRawFindings(planted(real, (draft) => void (draft.files[SEED_RAW] += "\nawait fetch(url);\n"))),
      "can open a socket",
    );
  });

  test("no live S3 file builds a request with a method other than GET or HEAD", () => {
    clean(liveMethodFindings(real));
    finds(
      liveMethodFindings(planted(real, (draft) => void (draft.files[SEED_RAW] += '\nconst r = { method: "PUT" };\n'))),
      "builds a method:",
    );
  });

  test("refuses silo-tls and any target outside the loopback table before anything runs", () => {
    for (const target of ["silo-tls", "10.0.0.5:9000", "aws"]) {
      const run = Bun.spawnSync([process.execPath, path.join(ROOT, SEED_RAW), "--target", target], {
        cwd: ROOT,
        env: { ...process.env, PATH: "/nonexistent" },
      });
      expect({ target, exit: run.exitCode }).toEqual({ target, exit: 2 });
      expect(run.stderr.toString()).toContain(
        "s3-seed-raw.ts: --target must be one of minio, minio-region, silo, garage, rustfs",
      );
    }
  });
});

// -- tests/live/s3-live-support.ts: the acceptance matrix -----------------------------------------------------------

const DOC = "docs/providers/s3.md";
const BEGIN = "<!-- s3-acceptance:begin -->";
const END = "<!-- s3-acceptance:end -->";

function matrixDocFindings(doc: string): string[] {
  const begin = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (begin === -1 || end < begin) return [`${DOC} has no ${BEGIN} ... ${END} block`];
  return doc.slice(begin + BEGIN.length, end).trim() === renderS3Acceptance()
    ? []
    : [`the matrix in ${DOC} is not renderS3Acceptance(): render the matrix into the doc again`];
}

function matrixShapeFindings(): string[] {
  const findings: string[] = [];
  const ids = S3_ACCEPTANCE.map((row) => row.id);
  for (const id of new Set(ids))
    if (ids.filter((other) => other === id).length > 1) findings.push(`${id} appears twice in S3_ACCEPTANCE`);
  const grouped = S3_ACCEPTANCE_GROUPS.flatMap((group) => group.rows);
  for (const id of ids)
    if (grouped.filter((other) => other === id).length !== 1) findings.push(`${id} is not in exactly one group`);
  for (const row of S3_ACCEPTANCE)
    for (const target of S3_TARGET_NAMES) {
      const cell = row.expect[target];
      if (cell.length === 0) findings.push(`${row.id} has an empty cell on ${target}`);
      for (const { outcome } of cell) {
        if (outcome.kind !== "refused" && outcome.kind !== "refused-before-request") continue;
        const finding = sentenceRefFinding(outcome.sentence);
        if (finding !== undefined) findings.push(`${row.id} on ${target}: ${finding}`);
      }
      for (const { outcome } of cell)
        if (outcome.kind === "ok" && "notice" in outcome.check) {
          const finding = sentenceRefFinding(outcome.check.notice);
          if (finding !== undefined) findings.push(`${row.id} on ${target}: ${finding}`);
        }
    }
  return findings;
}

describe("the acceptance matrix S3_ACCEPTANCE", () => {
  test("docs/providers/s3.md carries exactly the matrix renderS3Acceptance renders", () => {
    const doc = readFileSync(path.join(ROOT, DOC), "utf8");
    expect(matrixDocFindings(doc)).toEqual([]);
    expect(matrixDocFindings(doc.replace("| A1 |", "| A1x |"))[0]).toContain("is not renderS3Acceptance()");
  });

  test("every row is unique, in one group, has a cell on every target, and names only sentences the provider exports", () => {
    expect(matrixShapeFindings()).toEqual([]);
    expect(sentenceRefFinding("notice:N-NO-SUCH")).toBe("the preview exports no sentence N-NO-SUCH");
    expect(sentenceRefFinding('server:{"operation":"PutObject","status":200}')).toContain("names no S3Operation");
    expect(sentenceRefFinding("retyped sentence")).toBe("retyped sentence is not a sentence ref");
  });

  test("the live support reads the README's principals, the ones the compose file and seed connections use", () => {
    const principals = readS3Principals("silo");
    expect(principals.root).toEqual({ accessKeyId: "libredb", secretAccessKey: "Probe123pass!" });
    expect(principals.browse.accessKeyId).toBe("studio-browse");
  });

  test("the evaluator: a refusal before any request must be the provider's own sentence with no request and no socket", () => {
    const connection = s3LiveConnection("silo", readS3Principals("silo"), { role: "root", host: "2852039166" });
    const sentence = (() => {
      try {
        validateHost("2852039166");
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    })();
    const expectation = { kind: "refused-before-request", sentence: "endpoint:host:2852039166" } as const;
    expect(checkS3Step(expectation, { step: "x", refused: sentence, exchanges: 0 }, { connection }, 0)).toBeUndefined();
    expect(checkS3Step(expectation, { step: "x", refused: sentence, exchanges: 1 }, { connection }, 0)).toContain(
      "1 request(s)",
    );
    expect(checkS3Step(expectation, { step: "x", refused: sentence, exchanges: 0 }, { connection }, 1)).toContain(
      "1 socket(s)",
    );
    expect(
      checkS3Step(expectation, { step: "x", refused: "another sentence", exchanges: 0 }, { connection }, 0),
    ).toContain("which is not");
    expect(
      checkS3Step(
        { kind: "refused", sentence: "not:endpoint:host:2852039166" },
        { step: "x", refused: "connect ECONNREFUSED", exchanges: 1 },
        { connection },
        1,
      ),
    ).toBeUndefined();
  });

  test("the evaluator: rows, names in order, pages with no repeat, headers", () => {
    const connection = s3LiveConnection("silo", readS3Principals("silo"), { role: "root" });
    const at = (check: Parameters<typeof checkS3Step>[0], ok: object) =>
      checkS3Step(check, { step: "x", ok, exchanges: 1 }, { connection }, 1);
    expect(at({ kind: "ok", detail: "", check: { rows: 5 } }, { rows: 5 })).toBeUndefined();
    expect(at({ kind: "ok", detail: "", check: { rows: 5 } }, { rows: 4 })).toBe("4 rows, expected 5");
    expect(at({ kind: "ok", detail: "", check: { names: ["a", "c"] } }, { names: ["a", "b", "c"] })).toBeUndefined();
    expect(at({ kind: "ok", detail: "", check: { names: ["c", "a"] } }, { names: ["a", "b", "c"] })).toContain(
      "in order",
    );
    expect(
      at({ kind: "ok", detail: "", check: { pages: [2, 1], noRepeat: true } }, { pages: [2, 1], repeats: 1 }),
    ).toContain("1 repeat(s)");
    expect(
      at({ kind: "ok", detail: "", check: { headers: { Status: "Enabled" } } }, { headers: { Status: "Suspended" } }),
    ).toBe('Status is "Suspended", expected "Enabled"');
    expect(
      checkS3Step(
        { kind: "ok", detail: "", check: { rows: 1 } },
        { step: "x", refused: "no", exchanges: 1 },
        { connection },
        1,
      ),
    ).toBe("refused: no");
    expect(
      checkS3Step({ kind: "not-applicable", why: "w" }, { step: "x", ok: {}, exchanges: 0 }, { connection }, 0),
    ).toContain("not applicable");
  });
});

// -- tests/live/s3-live-support.ts: the runners, and tests/live/s3-evidence-plan.ts ---------------------------------

/** Every applicable step of every cell has a runner, and every runner step is some cell's. */
function runnerCoverageFindings(
  rows: readonly (typeof S3_ACCEPTANCE)[number][],
  runners: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): string[] {
  const findings: string[] = [];
  const used = new Set<string>();
  for (const row of rows)
    for (const target of S3_TARGET_NAMES)
      for (const { step, outcome } of row.expect[target]) {
        if (outcome.kind === "not-applicable") continue;
        used.add(`${row.id} ${step}`);
        if (runners[row.id]?.[step] === undefined) findings.push(`${row.id} on ${target}: no runner for step ${step}`);
      }
  for (const [id, steps] of Object.entries(runners))
    for (const step of Object.keys(steps))
      if (!used.has(`${id} ${step}`)) findings.push(`${id} has a runner for step ${step}, which no cell runs`);
  return findings;
}

function request(overrides: Partial<S3RecordedRequest>): S3RecordedRequest {
  return {
    method: "GET",
    path: "/studio-demo",
    query: "",
    headers: { host: "127.0.0.1:9010", "x-amz-date": "20261009T141900Z", "x-amz-content-sha256": "e3b0" },
    authorization: {
      scheme: "AWS4-HMAC-SHA256",
      credential: "libredb/20261009/us-east-1/s3/aws4_request",
      signedHeaders: ["host", "x-amz-content-sha256", "x-amz-date"],
    },
    ...overrides,
  };
}

describe("the runners and the scenario list", () => {
  test("every applicable step of every cell has a runner, so no applicable cell drops out of the live check's total", () => {
    expect(runnerCoverageFindings(S3_ACCEPTANCE, S3_RUNNERS)).toEqual([]);
    const extra = {
      ...S3_ACCEPTANCE[0],
      expect: {
        ...S3_ACCEPTANCE[0].expect,
        silo: [{ step: "unrunnable", outcome: { kind: "ok", detail: "", check: { rows: 1 } } }],
      },
    } as unknown as (typeof S3_ACCEPTANCE)[number];
    expect(runnerCoverageFindings([extra], S3_RUNNERS)).toContain("A1 on silo: no runner for step unrunnable");
    expect(
      runnerCoverageFindings(S3_ACCEPTANCE, { ...S3_RUNNERS, A1: { ...S3_RUNNERS.A1, dead: S3_RUNNERS.A1.test } }),
    ).toContain("A1 has a runner for step dead, which no cell runs");
  });

  test("the wire rules each find the request that breaks them, and only that one", () => {
    const clean = request({});
    expect(wireViolations("A26", [clean, request({ query: "list-type=2&max-keys=0" })])).toEqual([
      "GET /studio-demo?list-type=2&max-keys=0",
    ]);
    expect(
      wireViolations("A26", [request({ query: "max-keys=1001" }), request({ query: "max-keys=1000" })]),
    ).toHaveLength(1);
    expect(wireViolations("A27", [request({ query: "list-type=2&start-after=a" })])).toHaveLength(1);
    expect(wireViolations("A33", [request({ headers: { ...clean.headers, range: "bytes=0-1,4-5" } })])).toHaveLength(1);
    expect(wireViolations("A45", [request({ query: "attributes=" })])).toHaveLength(1);
    expect(wireViolations("A52", [request({ method: "PUT" as "GET" })])).toHaveLength(1);
    expect(
      wireViolations("A53", [request({ headers: { ...clean.headers, "x-amz-checksum-mode": "ENABLED" } })]),
    ).toHaveLength(1);
    expect(
      wireViolations("A54", [request({ headers: { host: "127.0.0.1:9010", "x-amz-date": "20261009T141900Z" } })]),
    ).toHaveLength(1);
    for (const row of ["A26", "A27", "A33", "A45", "A52", "A53", "A54"] as const)
      expect(wireViolations(row, [clean])).toEqual([]);
  });

  test("a Keys panel walk holds every level page to the keys route's checks and names the first defect", () => {
    const page = (keys: string[], prefixes: string[] = []) => ({ keys, prefixes });
    expect(levelPageDefect("b/dir/", 3, page(["b/dir/", "b/dir/a.txt"], ["b/dir/sub/"]))).toBeUndefined();
    expect(levelPageDefect("b/dir/", 2, page(["b/dir/a.txt", "b/dir/b.txt"], ["b/dir/sub/"]))).toBe(
      "the level page holds 3 entries, more than its count of 2",
    );
    expect(levelPageDefect("b/dir/", 9, page([], ["b/dir/sub/deeper/"]))).toBe(
      'the level page holds the folder "b/dir/sub/deeper/", which is outside the level of "b/dir/"',
    );
    expect(levelPageDefect("b/dir/", 9, page([], ["b/other/"]))).toContain("outside the level");
    expect(levelPageDefect("b/dir/", 9, page([], ["b/dir/sub"]))).toContain("outside the level");
    expect(levelPageDefect("b/dir/", 9, page([], ["b/dir/sub/", "b/dir/sub/"]))).toBe(
      'the level page holds "b/dir/sub/" twice',
    );
    expect(levelPageDefect("b/dir/", 9, page(["b/dir/sub/a.txt"]))).toBe(
      'the level page holds the key "b/dir/sub/a.txt", which is outside the level of "b/dir/"',
    );
    expect(levelPageDefect("", 9, page([""]))).toContain("outside the level");
    expect(levelPageDefect("b/dir/", 9, page(["b/dir/a.txt", "b/dir/a.txt"]))).toBe(
      'the level page holds "b/dir/a.txt" twice',
    );
  });

  test("every capture target records the surface and the recorded rows; live-only rows are never recorded", () => {
    for (const target of S3_CAPTURE_TARGETS) {
      const names = scenariosFor(target).map(({ scenario }) => scenario.name);
      expect(names).toContain("surface");
      expect(names).toContain("A21");
      for (const row of S3_LIVE_ONLY_ROWS) expect(names).not.toContain(row);
      expect(names.includes("A8-behind")).toBe(target === "garage");
    }
    const a37 = scenariosFor("silo").find(({ scenario }) => scenario.name === "A37");
    expect(a37?.steps).toEqual(["csv", "tsv", "json"]);
    const a23b = scenariosFor("garage").find(({ scenario }) => scenario.name === "A23b");
    expect(a23b).toBeUndefined();
  });

  test("a console run records the sockets its own step opened, not the run's running total", async () => {
    const planned = scenariosFor("minio").find(({ scenario }) => scenario.name === "console-head-object");
    if (planned === undefined) throw new Error("minio records no console-head-object scenario");
    const transport = scriptedS3Transport([
      {
        expect: { method: "GET", path: "/", query: "max-buckets=10000" },
        answer: {
          status: 200,
          headers: [["content-type", "application/xml"]],
          headersTruncated: false,
          contentType: "application/xml",
          contentEncoding: null,
          retryAfter: null,
          truncated: false,
          body: {
            text: '<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>o</ID></Owner><Buckets><Bucket><Name>studio-demo</Name><CreationDate>2026-10-01T00:00:00.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>',
          },
        },
        synthetic: true,
        source: "MinIO, measured live: the unpinned connect probe",
      },
      {
        expect: { method: "HEAD", path: "/studio-demo/data/table.csv" },
        answer: {
          status: 200,
          headers: [
            ["content-length", "12"],
            ["etag", '"0f343b0931126a20f133d67c2b018a3b"'],
            ["last-modified", "Fri, 09 Oct 2026 14:19:00 GMT"],
          ],
          headersTruncated: false,
          contentType: null,
          contentEncoding: null,
          retryAfter: null,
          truncated: false,
          body: { text: "" },
        },
        synthetic: true,
        source: "MinIO, measured live: HeadObject on a seeded key",
      },
    ]);
    const run: S3RunContext = {
      target: "minio",
      principals: replayPrincipals("minio"),
      createTransport: transport.createTransport,
      clockFor: () => () => new Date("2026-10-09T14:19:00.000Z"),
      signerWrapper: (signer) => signer,
      setStep: (step) => transport.setStep(step),
      sockets: () => 3,
      recorded: () => transport.sent,
    };
    const runs = await runS3Scenario(planned.scenario, run, planned.steps, {
      assertSurface: () => Promise.resolve(),
    });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.map((stepRun) => stepRun.sockets)).toEqual(runs.map(() => 0));
    transport.assertConsumed();
  });
});

// -- tests/live/s3-live-support.ts: the bucket fingerprint ----------------------------------------------------------

function xmlAnswer(status: number, body: string): S3RecordedAnswer {
  return {
    status,
    headers: [["date", "Fri, 09 Oct 2026 14:19:00 GMT"]],
    headersTruncated: false,
    contentType: "application/xml",
    contentEncoding: null,
    retryAfter: null,
    truncated: false,
    body: { text: body },
  };
}

/** A one-key ListBucketResult page, in the shape MinIO answers with encoding-type=url. */
function listing(bucket: string, key: string, etag: string): S3RecordedAnswer {
  return xmlAnswer(
    200,
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix></Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated><Contents><Key>${key}</Key><LastModified>2026-10-09T14:19:00.000Z</LastModified><ETag>&quot;${etag}&quot;</ETag><Size>12</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>`,
  );
}

const NOT_IMPLEMENTED = xmlAnswer(
  501,
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NotImplemented</Code><Message>Not implemented</Message></Error>',
);
const ACCESS_DENIED = xmlAnswer(
  403,
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied.</Message></Error>',
);

function fingerprintSteps(versions: S3RecordedAnswer, etag = "0f343b0931126a20f133d67c2b018a3b") {
  return S3_FIXTURE_BUCKETS.flatMap((bucket) => [
    {
      answer: listing(bucket, "root.txt", etag),
      synthetic: true as const,
      source: "MinIO, measured live",
      expect: { path: `/${bucket}` },
    },
    ...(bucket === "studio-versions"
      ? [
          {
            answer: versions,
            synthetic: true as const,
            source: "Garage, measured live: ListObjectVersions answers 501",
            expect: { path: "/studio-versions" },
          },
        ]
      : []),
  ]);
}

describe("the bucket fingerprint", () => {
  test("a 501 to ListObjectVersions leaves versions out, and the fingerprint still covers every bucket", async () => {
    const scripted = scriptedS3Transport(fingerprintSteps(NOT_IMPLEMENTED));
    const fingerprint = await s3Fingerprint("garage", { ...readS3Principals("silo") }, scripted.createTransport);
    expect(Object.keys(fingerprint)).toEqual([...S3_FIXTURE_BUCKETS]);
    scripted.assertConsumed();
    expect(scripted.sent.every((request) => request.method === "GET")).toBe(true);
  });

  test("any other error to ListObjectVersions fails the fingerprint", async () => {
    const scripted = scriptedS3Transport(fingerprintSteps(ACCESS_DENIED));
    await expect(s3Fingerprint("garage", { ...readS3Principals("silo") }, scripted.createTransport)).rejects.toThrow();
  });

  test("a changed ETag changes that bucket's fingerprint", async () => {
    const first = await s3Fingerprint(
      "garage",
      { ...readS3Principals("silo") },
      scriptedS3Transport(fingerprintSteps(NOT_IMPLEMENTED)).createTransport,
    );
    const second = await s3Fingerprint(
      "garage",
      { ...readS3Principals("silo") },
      scriptedS3Transport(fingerprintSteps(NOT_IMPLEMENTED, "1f343b0931126a20f133d67c2b018a3b")).createTransport,
    );
    expect(second["studio-demo"]).not.toBe(first["studio-demo"]);
  });
});

// -- tests/fixtures/s3/captures -------------------------------------------------------------------------------------

const EVIDENCE = "tests/live/s3-evidence.ts";

/** The committed captures, held to the capture rules of the scrub; nothing to check before the first recording. */
function captureFindings(root: string): string[] {
  if (!existsSync(root)) return [];
  const findings: string[] = [];
  const onDisk = captureFilesOnDisk(root);
  const table = readDigestTable(readFileSync(path.join(root, "README.md"), "utf8"));
  const listed = new Map(table.map((row) => [row.file, row.sha256]));
  for (const file of onDisk) {
    const bytes = readFileSync(path.join(root, file));
    if (listed.get(file) !== sha256(bytes))
      findings.push(`${file} is not in the captures README's digest table with its sha256`);
  }
  for (const { file } of table)
    if (!onDisk.includes(file)) findings.push(`the digest table lists ${file}, which is not on disk`);
  const rows = readmeRows();
  const secrets = (["root", "browse", "scoped", "getonly"] as const).map((role) => ({
    label: `${role} password`,
    value: rows[role].secret,
  }));
  let total = 0;
  for (const file of onDisk) {
    total += statSync(path.join(root, file)).size;
    if (file.endsWith("/manifest.json")) continue;
    const capture = loadS3Capture(file, root);
    let rendered = "";
    try {
      rendered = scrubCapture(capture, secrets);
    } catch (error) {
      findings.push((error as Error).message);
      continue;
    }
    if (rendered !== readFileSync(path.join(root, file), "utf8"))
      findings.push(`${file} does not render unchanged through the scrub`);
    for (const exchange of capture.exchanges) {
      if (exchange.request.method !== "GET" && exchange.request.method !== "HEAD")
        findings.push(`${file} records a ${exchange.request.method} request`);
      if (bodyBytes(exchange.answer.body).length > S3_EXCHANGE_BODY_MAX_BYTES)
        findings.push(`${file} step ${exchange.step} records a body over 512 KiB`);
    }
  }
  if (total > S3_CAPTURES_MAX_BYTES) findings.push(`tests/fixtures/s3/captures holds ${total} bytes, over 8 MiB`);
  return findings;
}

describe("the S3 captures and their harness", () => {
  test("every capture is in the digest table, renders unchanged through the scrub, holds only GET and HEAD, and stays under the caps", () => {
    expect(captureFindings(S3_CAPTURES_ROOT)).toEqual([]);
  });

  test("a capture with a secret, or one the table does not list, is found", () => {
    const root = mkdtempSync(path.join(tmpdir(), "s3-captures-rule-"));
    const set = "silo-2026-10-12-RELEASE.2026-09-16T00-00-00Z";
    mkdirSync(path.join(root, set));
    const file = `${set}/A1.json`;
    writeFileSync(
      path.join(root, file),
      `${JSON.stringify({ file, scenario: "A1", target: "silo", clockOffsetMs: 0, exchanges: [], result: ["Probe123pass!"] }, null, 2)}\n`,
    );
    writeFileSync(path.join(root, "README.md"), "# S3 captures\n");
    const findings = captureFindings(root);
    expect(findings).toContain(`${file} is not in the captures README's digest table with its sha256`);
    expect(findings.some((finding) => finding.includes("holds the fixture secret root password raw"))).toBe(true);
  });

  test("the recorder pairs each request with its one signer record, and fails by name when a request left none or two", async () => {
    const authorization =
      "AWS4-HMAC-SHA256 Credential=AK/20261009/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=ab12";
    const signer: RequestSigner = {
      headerNames: ["authorization", "x-amz-date"],
      sign: () => ({ authorization, "x-amz-date": "20261009T141900Z" }),
    };
    const fake =
      (signs: number): S3TransportFactory =>
      (options) => ({
        async request(sent) {
          for (let at = 0; at < signs; at += 1) options.signer?.sign(signingInput(options, sent, undefined));
          return {
            status: 200,
            contentType: "application/xml",
            contentEncoding: null,
            retryAfter: null,
            headers: [],
            headersTruncated: false,
            bytes: Buffer.from("<ok/>"),
            truncated: false,
          };
        },
        close: () => undefined,
      });
    const options = (recording: ReturnType<typeof s3Recorder>, signed: boolean): NodeByteTransportOptions => ({
      origin: { scheme: "http", host: "127.0.0.1", port: 9010 },
      tls: null,
      maxSockets: 1,
      headers: {},
      ...(signed ? { signer: recording.signerWrapper(signer) } : {}),
    });
    const sent = {
      method: "GET" as const,
      target: { path: "/studio-public", query: "list-type=2" },
      signal: new AbortController().signal,
      maxResponseBytes: 1024,
    };

    const recording = s3Recorder(fake(1), "A1");
    recording.setStep("list");
    await recording.createTransport(options(recording, true)).request(sent);
    await recording.createTransport(options(recording, false)).request(sent);
    expect(
      recording.exchanges.map(({ step, request, answer }) => ({
        step,
        authorization: request.authorization,
        date: "x-amz-date" in request.headers ? request.headers["x-amz-date"] : null,
        body: answer.body,
      })),
    ).toEqual([
      {
        step: "list",
        authorization: {
          scheme: "AWS4-HMAC-SHA256",
          credential: "AK/20261009/us-east-1/s3/aws4_request",
          signedHeaders: ["host", "x-amz-date"],
        },
        date: "20261009T141900Z",
        body: { text: "<ok/>" },
      },
      { step: "list", authorization: null, date: null, body: { text: "<ok/>" } },
    ]);

    for (const signs of [0, 2]) {
      const broken = s3Recorder(fake(signs), "A1");
      broken.setStep("list");
      await expect(broken.createTransport(options(broken, true)).request(sent)).rejects.toThrow(
        `A1 step list: a signed request left ${signs} signer records, not exactly one`,
      );
      expect(broken.exchanges).toEqual([]);
    }
  });

  test("the harness refuses an argument it does not accept before anything runs", () => {
    for (const args of [["--target", "silo-tls"], ["--target", "aws"], ["--target"], ["--only", "A1"]]) {
      const run = Bun.spawnSync([process.execPath, path.join(ROOT, EVIDENCE), ...args], {
        cwd: ROOT,
        env: { ...process.env, PATH: "/nonexistent" },
      });
      expect({ args, exit: run.exitCode }).toEqual({ args, exit: 2 });
    }
  });
});

// -- tests/live/s3-live-check.ts ------------------------------------------------------------------------------------

const LIVE_CHECK = "tests/live/s3-live-check.ts";

describe("the live check tests/live/s3-live-check.ts", () => {
  test("refuses an argument it does not accept before any socket opens", () => {
    for (const args of [
      ["--target", "aws"],
      ["--target", "10.0.0.5:9000"],
      [],
      ["--target", "silo", "--endpoint", "http://x"],
    ]) {
      const run = Bun.spawnSync([process.execPath, path.join(ROOT, LIVE_CHECK), ...args], { cwd: ROOT });
      expect({ args, exit: run.exitCode }).toEqual({ args, exit: 2 });
    }
  });

  test("silo-tls needs --ca and garage needs --garage-keys, each refused before any socket opens", () => {
    for (const [args, message] of [
      [["--target", "silo-tls"], "--ca"],
      [["--target", "garage"], "--garage-keys"],
    ] as const) {
      const run = Bun.spawnSync([process.execPath, path.join(ROOT, LIVE_CHECK), ...args], { cwd: ROOT });
      expect(run.exitCode).toBe(2);
      expect(run.stderr.toString()).toContain(message);
    }
  });
});

// -- tests/live/s3-tunnel-check.ts ----------------------------------------------------------------------------------

const TUNNEL_CHECK = "tests/live/s3-tunnel-check.ts";

describe("the tunnel check tests/live/s3-tunnel-check.ts", () => {
  test("has no default for any credential: without LIVE_SSH_PASSWORD or --ca it exits 2 before dialling", () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "LIVE_SSH_PASSWORD"));
    const noPassword = Bun.spawnSync([process.execPath, path.join(ROOT, TUNNEL_CHECK), "--ca", "/nonexistent/ca.pem"], {
      cwd: ROOT,
      env,
    });
    expect(noPassword.exitCode).toBe(2);
    expect(noPassword.stderr.toString()).toContain("Set LIVE_SSH_PASSWORD");
    const noCa = Bun.spawnSync([process.execPath, path.join(ROOT, TUNNEL_CHECK)], {
      cwd: ROOT,
      env: { ...env, LIVE_SSH_PASSWORD: "x" },
    });
    expect(noCa.exitCode).toBe(2);
    expect(noCa.stderr.toString()).toContain("--ca");
  });

  test("names no password, key or token literal", () => {
    const text = real.files[TUNNEL_CHECK] ?? "";
    expect(/password:\s*"[^"$]/.test(text)).toBe(false);
  });

  // A text pin stands in for a run, because the script dials a real bastion as soon as it is imported.
  test("counts every socket but the bastion's with a node:net connect spy, so the link-local refusal must come before any socket to the local forward", () => {
    const text = real.files[TUNNEL_CHECK] ?? "";
    expect(text).toMatch(/net\.Socket\.prototype\.connect = function/);
    expect(text).toContain("sockets: () => sockets,");
    expect(text).toContain("checkS3Step(outcome, stepRun.summary, stepRun.context, stepRun.sockets)");
    expect(text).toContain('const BASTION = { host: "127.0.0.1", port: 12222 };');
    expect(text).toMatch(/sshTunnel: \{\s*enabled: true,\s*host: BASTION\.host,\s*port: BASTION\.port,/);
    expect(text).toContain("target.host === BASTION.host && target.port === BASTION.port");
  });
});
