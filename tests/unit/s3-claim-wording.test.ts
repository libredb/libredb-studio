/**
 * The S3 claim guard.
 *
 * Studio's S3 provider is verified on MinIO, Silo, Garage and RustFS and on no AWS or hosted service, so English
 * outward copy may name AWS S3 or Amazon S3 only in a sentence that says it is not verified, and may never put a
 * support verb in front of a bare S3. A corrected claim comes back unless a test holds it, which is why
 * `tests/unit/marketplace-copy.test.ts` holds the explanation and data-management claims the same way.
 *
 * The rules are English phrases, so the eight translated READMEs are outside `CLAIM_FILES`: a translated negation
 * would fail rule (a) for a sentence that is correct. Their own describe below holds them to one narrower rule.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

/** The engine count gate's files, read from its source, so the two lists cannot part. */
const COPY_FILES: readonly string[] = [
  ...read("tests/unit/lib/catalog-copy-engine-count.test.ts").matchAll(/\{ path: "([^"]+)"/g),
].map((match) => match[1]);

/** Every English file that publishes the engine set or the product's claims. */
const CLAIM_FILES: readonly string[] = [
  ...COPY_FILES,
  "README.md",
  "DOCKERHUB.md",
  "docs/FEATURES.md",
  "docs/BRAND_MESSAGING.md",
  "charts/libredb-studio/Chart.yaml",
  "charts/libredb-studio/README.md",
];

/** Rule (a): an AWS name for S3. */
const AWS_NAME = /\b(?:AWS|Amazon) S3\b/;
/** What rule (a) needs in the same sentence. */
const NEGATION = /not verified|not on AWS S3|not claimed/i;
/** Rule (b): a support verb in front of a bare S3. */
const SUPPORT_CLAIM = /\b(supports?|works with|compatible with|certified for)\s+(AWS |Amazon )?S3\b(?!-compatible)/i;
/** Rule (c): a YAML list item of one keyword, such as `  - s3`, is not a sentence. */
const KEYWORD_LINE = /^\s*-\s+[a-z0-9-]+\s*$/;

/** The sentences of `text`: one per line, keyword lines dropped (rule (c)), a line split again after a full stop, code spans and the API names out. */
function sentences(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !KEYWORD_LINE.test(line))
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z*"`[])/))
    .map((sentence) => sentence.replace(/`[^`]*`/g, "").replace(/\bS3 (?:REST )?API\b/g, ""));
}

/** Every sentence of `text` that breaks rule (a) or rule (b), named so the fix is obvious. */
function claimProblems(text: string, label: string): string[] {
  const problems: string[] = [];
  for (const sentence of sentences(text)) {
    if (AWS_NAME.test(sentence) && !NEGATION.test(sentence)) {
      problems.push(`${label}: names AWS S3 or Amazon S3 without "not verified": ${sentence.trim()}`);
    }
    const claim = SUPPORT_CLAIM.exec(sentence);
    if (claim !== null) problems.push(`${label}: "${claim[0]}" claims S3 support: ${sentence.trim()}`);
  }
  return problems;
}

describe("English outward copy claims no S3 support it was not verified on", () => {
  test("the file set is the gate's seventeen and six more", () => {
    expect(COPY_FILES).toHaveLength(17);
    expect(new Set(CLAIM_FILES).size).toBe(23);
  });

  test.each(CLAIM_FILES.map((file) => [file] as const))("%s", (file) => {
    expect(claimProblems(read(file), file)).toEqual([]);
  });
});

describe("the guard refuses the claims it exists to catch and accepts the S3 copy", () => {
  test.each([
    ["Supports AWS S3."],
    ["Works with Amazon S3."],
    ["Studio is compatible with S3."],
    ["Certified for S3 buckets."],
  ])("refuses %s", (sentence) => {
    expect(claimProblems(sentence, "fixture").length).toBeGreaterThan(0);
  });

  test.each([
    [
      "the README line",
      "S3-compatible object storage is the newest: AWS CLI read commands typed in the editor, such as `aws s3api list-buckets`, `aws s3 ls`, `aws s3api head-object` and `aws s3api list-object-versions`, and Studio's own `preview` read buckets and objects over the S3 REST API with no SDK, signed by Studio's own code with only the keys typed into the connection; the tree shows buckets, the Keys panel walks folders one level at a time, and an object opens with its metadata and a capped preview of text, JSON, CSV or Parquet, read-only by construction, because Studio sends only GET and HEAD requests; it is verified on MinIO, Silo, Garage and RustFS, and not on AWS S3 or any hosted service.",
    ],
    [
      "the README row",
      "| **S3-compatible object storage** | none, HTTP (the S3 REST API, path style, signed by Studio's own SigV4 code; `hyparquet` for Parquet previews) | Read-only AWS CLI read commands such as `aws s3api list-buckets`, `aws s3 ls`, `aws s3api head-object` and `aws s3api list-object-versions`, plus Studio's own `preview`; buckets in the tree and folders in the Keys panel, one level at a time; an object's metadata and a capped preview of text, JSON, NDJSON, CSV, TSV and Parquet, hex for anything else. Only the keys typed into the connection sign, never the server's own AWS identity, and the link-local networks, where AWS, Azure and Google Cloud serve instance metadata, are always refused, as is AWS's IPv6 metadata address. Verified on MinIO, Silo, Garage and RustFS; AWS S3 and hosted services are not verified |",
    ],
    [
      "the FEATURES group",
      "        Verified on MinIO, Silo, Garage and RustFS ([providers/s3.md](./providers/s3.md)); AWS S3 and hosted services are not verified.",
    ],
    [
      "BRAND rule 9",
      '9. **Studio\'s S3 provider is read-only object browsing on S3-compatible servers, verified on four of them.** Write "S3-compatible object storage", never "S3" alone as a supported product, and never "AWS S3" or "Amazon S3" as one, because Studio was verified on MinIO, Silo, Garage and RustFS and not on AWS S3 or any hosted service. Never write that Studio queries files in a bucket with SQL; it previews them.',
    ],
    [
      "the DOCKERHUB clause",
      "Prometheus, InfluxDB, Apache Kafka, Oxia and S3-compatible object storage are read-only too: Studio calls only read APIs.",
    ],
    ["a chart keyword", "  - s3"],
  ])("accepts %s", (_name, text) => {
    expect(claimProblems(text, "fixture")).toEqual([]);
  });
});

describe("a translated README names AWS S3 only in its S3 engine row", () => {
  // The English rules cannot read a translated negation, so a translation is held to a narrower rule: the one
  // line that may say AWS S3 is the S3 row, whose last sentence says, in that language, that AWS S3 is not verified.
  test.each(
    [
      "README_zh.md",
      "README_ja.md",
      "README_es.md",
      "README_ur.md",
      "README_hi.md",
      "README_pt.md",
      "README_ru.md",
      "README_ko.md",
    ].map((file) => [file] as const),
  )("%s", (file) => {
    const lines = read(file).split("\n");
    const row = lines.filter((line) => line.startsWith("| **S3-compatible object storage** |"));
    expect(row).toHaveLength(1);
    expect(lines.filter((line) => AWS_NAME.test(line))).toEqual(row);
  });
});
