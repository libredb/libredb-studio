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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

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
