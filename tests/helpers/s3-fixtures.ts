/**
 * The S3 captures the replay reads: the digest table of
 * tests/fixtures/s3/captures/README.md, the capture sets on disk, each capture and each set's manifest.
 *
 * tests/live/s3-evidence.ts is the only writer of that directory, and renders its README with renderCapturesReadme,
 * so the table the replay checks is the table the harness wrote. Nothing here reads sigv4-suite.json, xml/ or
 * preview/, the other parts' entries of tests/fixtures/s3/.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { S3Capture } from "./s3-wire";

export const S3_CAPTURES_ROOT = path.resolve(import.meta.dir, "../fixtures/s3/captures");
export const S3_CAPTURE_TARGETS = ["minio", "minio-region", "silo", "garage", "rustfs"] as const;
export type S3CaptureTarget = (typeof S3_CAPTURE_TARGETS)[number];

export interface S3CaptureSet {
  readonly name: string;
  readonly target: S3CaptureTarget;
  /** The UTC day of the run. */
  readonly date: string;
  /** The server's version: MinIO's and Silo's RELEASE tag, Garage's and RustFS's version. */
  readonly version: string;
}

export interface S3DigestRow {
  readonly file: string;
  readonly sha256: string;
}

export interface S3Manifest {
  readonly target: S3CaptureTarget;
  /** The Studio commit the harness ran from. */
  readonly commit: string;
  /** Harness files that differ from that commit or are not in it. */
  readonly uncommitted: readonly string[];
  /** `tag@digest`, or for MinIO the image id and its buildinfo lines. */
  readonly image: string;
  readonly version: string;
  readonly date: string;
  readonly scenarios: readonly {
    readonly name: string;
    readonly ms: number;
    readonly exchanges: number;
    readonly clockOffsetMs: number;
  }[];
}

const SET_NAME = /^(minio-region|minio|silo|garage|rustfs)-(\d{4}-\d{2}-\d{2})-(\S+)$/;

export function parseSetName(name: string): S3CaptureSet | undefined {
  const match = SET_NAME.exec(name);
  if (match === null) return undefined;
  return { name, target: match[1] as S3CaptureTarget, date: match[2], version: match[3] };
}

/** The rows `| <set>/<file>.json | <sha256> |` of the README's digest table. */
export function readDigestTable(readme: string): S3DigestRow[] {
  return readme
    .split("\n")
    .map((line) => /^\| (\S+\/\S+\.json) \| ([0-9a-f]{64}) \|$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ file: match[1], sha256: match[2] }));
}

/** Every `<set>/<file>.json` under the root, sorted; the README is not a capture. */
export function captureFilesOnDisk(root: string = S3_CAPTURES_ROOT): string[] {
  return readdirSync(root)
    .filter((entry) => statSync(path.join(root, entry)).isDirectory())
    .flatMap((set) =>
      readdirSync(path.join(root, set))
        .filter((file) => file.endsWith(".json"))
        .map((file) => `${set}/${file}`),
    )
    .sort();
}

export function captureSets(root: string = S3_CAPTURES_ROOT): S3CaptureSet[] {
  return readdirSync(root)
    .filter((entry) => statSync(path.join(root, entry)).isDirectory())
    .sort()
    .map((entry) => {
      const set = parseSetName(entry);
      if (set === undefined) throw new Error(`${path.join(root, entry)} is not a <target>-<date>-<version> set`);
      return set;
    });
}

export function loadS3Capture(file: string, root: string = S3_CAPTURES_ROOT): S3Capture {
  const capture = JSON.parse(readFileSync(path.join(root, file), "utf8")) as S3Capture;
  if (capture.file !== file) throw new Error(`${file} names itself ${capture.file}`);
  return capture;
}

/** A set's manifest; one naming a target other than its set name's is refused. */
export function loadManifest(set: string, root: string = S3_CAPTURES_ROOT): S3Manifest {
  const manifest = JSON.parse(readFileSync(path.join(root, set, "manifest.json"), "utf8")) as S3Manifest;
  const target = parseSetName(set)?.target;
  if (manifest.target !== target)
    throw new Error(`${set}/manifest.json names target ${manifest.target}, not ${target}`);
  return manifest;
}

export function renderCapturesReadme(
  sets: readonly { readonly set: S3CaptureSet; readonly manifest: S3Manifest }[],
  digests: readonly S3DigestRow[],
  scenarios: readonly { readonly name: string; readonly shows: string }[],
): string {
  const lines = [
    "# S3 captures",
    "",
    "What each S3 fixture server answered the real `s3` provider, one scenario per file, written only by `tests/live/s3-evidence.ts`.",
    "`tests/integration/db/s3-provider.test.ts` replays every file through the same runner the live check calls; no test here reaches a live server.",
    "Each file holds only what a server answered: synthetic answers live in the unit tests, never here.",
    "",
    "## Sets",
    "",
    "| Set | Target | Version | Image | Date | Scenarios |",
    "|---|---|---|---|---|---|",
    ...sets.map(
      ({ set, manifest }) =>
        `| \`${set.name}\` | \`${set.target}\` | \`${set.version}\` | \`${manifest.image}\` | ${set.date} | ${manifest.scenarios.length} |`,
    ),
    "",
    "## The scrub",
    "",
    "Every exchange passes through `tests/helpers/s3-evidence-scrub.ts` before it is written.",
    "The signature never reaches a file: a request keeps its authorization's scheme, credential scope and SignedHeaders only.",
    "`x-amz-date`, the scope's date and the answer's `date` are kept; request ids become `<request-id>`.",
    "Only the answer headers the provider asks for are kept, read from the provider's `S3_RESPONSE_HEADERS`.",
    "Continuation tokens are kept byte for byte; an exchange body over 512 KiB is refused; nothing is written while a file would hold a fixture secret in any encoding.",
    "",
    "## The scenarios",
    "",
    "| Scenario | What it shows |",
    "|---|---|",
    ...scenarios.map(({ name, shows }) => `| \`${name}\` | ${shows} |`),
    "",
    "## Digests",
    "",
    "| File | sha256 |",
    "|---|---|",
    ...digests.map(({ file, sha256 }) => `| ${file} | ${sha256} |`),
    "",
  ];
  return lines.join("\n");
}
