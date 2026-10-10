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
