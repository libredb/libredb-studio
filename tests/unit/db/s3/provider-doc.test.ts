/**
 * `docs/providers/s3.md` quotes numbers, sentences, commands and declarations the S3 provider's modules own
 * and is held to them here, in the shape of `tests/unit/db/oxia/provider-doc.test.ts`.
 *
 * A value copied into prose is true only until the code moves, so every bound, refusal, sentence, command row,
 * capability and label the doc quotes is read back here from the module that owns it, and the SECURITY rows, the
 * backlog entries and the other docs that state an S3 fact are read here too.
 * The client, console, preview and fixture changes add their cases to this file, each in a describe block of its
 * own, and reuse the helpers above the first describe.
 *
 * The doc test never reaches a server: every provider it builds has a transport factory that throws or a fake one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const DOC = read("docs/providers/s3.md");
const PROVIDER_DIRECTORY = "src/lib/db/providers/objectstore/s3";

/** Prose is one sentence per line, so a sentence that spans lines is compared with its line breaks read as spaces. */
const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ").replace(/\\([<>])/g, "$1");
/** A count with an en-US thousands separator, as the doc writes every number. */
const n = (count: number): string => count.toLocaleString("en-US");

/** Whether line `at` of `lines` is inside a fenced block. */
const inFence = (lines: readonly string[], at: number): boolean =>
  lines.slice(0, at).filter((line) => line.startsWith("```")).length % 2 === 1;

/** The heading lines of `text`, outside fenced blocks. */
function headings(text: string): string[] {
  const lines = text.split("\n");
  return lines.filter((line, at) => /^#{1,6} /.test(line) && !inFence(lines, at));
}

/** The section under the heading line `heading`, up to the next heading of its level or above. */
function sectionOf(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`no heading ${heading}`);
  const level = heading.indexOf(" ");
  const end = lines.findIndex(
    (line, at) => at > start && /^#{1,6} /.test(line) && line.indexOf(" ") <= level && !inFence(lines, at),
  );
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

/** The table row of `text` whose first cell is exactly `cell`. */
const rowOf = (text: string, cell: string): string | undefined =>
  text.split("\n").find((line) => line.startsWith(`| ${cell} |`));

const OUTLINE: readonly string[] = [
  "# S3-compatible object storage Provider",
  "## Before you connect",
  "## 1. Overview",
  "### Concept mapping",
  "## 2. Architecture",
  "### 2.1 Where it sits",
  "### 2.2 Modules",
  "### 2.3 Registration & lifecycle",
  "### 2.4 The client, and why",
  "## 3. Design decisions",
  "### 3.1 Read-only v1",
  "### 3.2 Only typed credentials sign",
  "### 3.3 Path style and the region",
  "### 3.4 Link-local networks are always refused",
  "### 3.5 The read-only mode",
  "### 3.6 Machine access",
  "### 3.7 The Keys panel cursor",
  "## 4. Connection",
  "### 4.1 Configuration fields",
  "### 4.2 Authentication",
  "### 4.3 TLS",
  "### 4.4 One endpoint, path style and the region",
  "### 4.5 SSH tunnel",
  "### 4.6 Plain HTTP off this machine needs consent",
  "### 4.7 Pasting an address",
  "### 4.8 Server versions",
  "### 4.9 What is not verified",
  "## 5. Query interface",
  "### 5.1 The command",
  "### 5.2 Commands and flags",
  "### 5.3 Refused commands",
  "### 5.4 Examples",
  "### 5.5 Result shape",
  "### 5.6 Bounds",
  "### 5.7 Pagination and the starting token",
  "### 5.8 Cancellation and the confirmation gate",
  "## 6. Schema introspection",
  "### 6.1 The object surface",
  "### 6.2 Object source",
  "#### Object preview",
  "### 6.3 Generated commands",
  "### 6.4 The Keys panel",
  "### 6.5 Object edit (#789): nothing to write",
  "## 7. Monitoring & health",
  "## 8. Maintenance",
  "## 9. Capabilities & labels",
  "## 10. Error handling",
  "## 11. Testing",
  "### 11.1 How the tests work",
  "### 11.2 Run it",
  "### 11.3 The live fixtures",
  "### 11.4 The evidence harness and the live check",
  "### 11.5 The acceptance matrix",
  "## 12. Running an S3-compatible server for Studio",
  "## 13. Known limitations",
  "## 14. References",
];

/** The "Before you connect" block, exactly. */
const BEFORE_YOU_CONNECT = [
  "## Before you connect",
  "",
  "Seven facts decide whether the first connection works.",
  "",
  "1. Type the server's S3 API address, not its web console's: Endpoint host and Port, or paste `http://host:port` or `https://host:port` into Endpoint host.",
  "   Where Studio runs decides what to type in Endpoint host:",
  "",
  "| Where the server and Studio run | Endpoint host |",
  "|---|---|",
  "| Both on this machine | `localhost` |",
  "| The server on this machine, Studio in Docker | `host.docker.internal`; on Linux, start Studio's container with `--add-host=host.docker.internal:host-gateway` |",
  "| The server elsewhere | its address, over TLS |",
  "",
  "2. Studio addresses every object as `<endpoint>/<bucket>/<key>`, path style, and never by a bucket host name, so a server that answers only virtual-hosted requests cannot be read.",
  "3. Region: Studio signs for `us-east-1` unless you type another region. A server that keeps a fixed region refuses a request signed for any other, and only some servers name the region they expect in the error; section 4.4 says which of the verified servers enforce a region and which name it.",
  "4. Credentials: put the access key ID in Access key ID and the secret access key in Secret access key.",
  "   Only the keys you type sign a request: Studio never reads the server's environment, shared credential files or instance role, and with both fields empty it sends unsigned requests, which only a public bucket answers, and Garage answers none.",
  "   Temporary credentials that need a session token cannot be used in this version.",
  "5. Bucket: leave it empty to list every bucket the credential may list, or name one bucket to browse only that one. This is a convenience, not a boundary (section 13).",
  "   MinIO, Silo, Garage and RustFS list a limited key's own buckets; AWS S3 and some hosted services refuse the listing to such a key (not verified here), so name the bucket there.",
  "6. TLS: Studio refuses plain HTTP to a host that is neither this machine nor reached through an SSH tunnel unless you tick Connect without TLS, because bucket and object names, listings and previews cross the network in the clear, and anyone who captures a signed request can send it again for minutes, and on some servers for hours.",
  "7. What this version does not do: write, run SQL over files, sign with temporary credentials, or use virtual-hosted addressing; and it has been verified on MinIO, Silo, Garage and RustFS only, not on AWS S3, a hosted service or any other server.",
].join("\n");

/** Section 4.9, "What is not verified", exactly. */
const NOT_VERIFIED = [
  "### 4.9 What is not verified",
  "",
  "Studio has not been run against AWS S3, any hosted S3-compatible service, or any self-hosted server other than the four of section 4.8, such as Ceph RGW or SeaweedFS, so none of them is claimed.",
  "These behaviours exist on AWS and were never exercised:",
  "",
  "- a `301 PermanentRedirect` for a bucket in another region, which Studio refuses rather than follows;",
  "- virtual-hosted addressing on real DNS, and bucket names with dots over TLS;",
  "- temporary credentials from STS, which need a session token Studio cannot send;",
  "- ListBuckets paging, which AWS requires above 10,000 buckets and every verified server ignores;",
  "- objects in an archive storage class, which answer a read with `403 InvalidObjectState`;",
  "- the checksum headers AWS SDKs send by default;",
  "- keys with `.`, `..` or `//` segments, which AWS accepts and MinIO, Silo and RustFS refuse.",
  "",
  "Cloudflare R2 signs for the region `auto`, and DigitalOcean Spaces asks clients to sign for `us-east-1`; neither was tried.",
].join("\n");

/** The probe paragraph of section 7, exactly. */
const PROBE_PARAGRAPH = [
  "Test Connection and every connect send one probe, and the answer must be an S3 listing.",
  "With a pinned bucket, the probe is ListObjectsV2 on that bucket with `max-keys=1`, `delimiter=/` and `encoding-type=url`, and its answer must parse as `ListBucketResult`.",
  "With no pinned bucket, the probe is ListBuckets, and its answer must parse as `ListAllMyBucketsResult`.",
  "A connection whose probe did not parse as S3 XML never reads an object, so a host that answers HTTP but does not speak S3 shows no body.",
  "Both probes need the permission browsing needs (`s3:ListBucket` on a pinned bucket), so a key that can browse can always pass the test.",
  "A 403 from the probe never says that the pinned bucket exists.",
].join("\n");

/** The closing paragraph of section 10, exactly. */
const SERVER_TEXT_PARAGRAPH = [
  "A server's own message is shown only when Studio's sentence quotes it: a signing-scope refusal that names no other region, a server failure, and an error code Studio does not recognise; it follows Studio's sentence, cut to the length the provider exports, and a text that holds the secret access key or the access key ID in any form Studio sends is withheld whole.",
  "The secret access key never reaches an error, a result, a log line, an audit row or a notice.",
].join("\n");

describe("docs/providers/s3.md: shape and fixed text", () => {
  test("1. the header and every section and subsection, in order", () => {
    expect(headings(DOC)).toEqual([...OUTLINE]);
    expect(DOC).toMatch(
      /^The `s3` type-id: read-only browsing of buckets, folders and objects, object metadata and capped previews over the S3 REST API, verified on MinIO \S+, Silo \S+, Garage \S+ and RustFS \S+, and not on AWS S3 or any hosted service\.$/m,
    );
    expect(DOC).toContain(
      `Source: [\`${PROVIDER_DIRECTORY}/\`](../../${PROVIDER_DIRECTORY}/).\nTests: [\`tests/unit/db/s3/\`](../../tests/unit/db/s3/) and [\`tests/integration/db/s3-provider.test.ts\`](../../tests/integration/db/s3-provider.test.ts).`,
    );
  });

  test("2. the fixed blocks are word for word", () => {
    expect(DOC).toContain(BEFORE_YOU_CONNECT);
    expect(DOC).toContain(NOT_VERIFIED);
    expect(sectionOf(DOC, "## 7. Monitoring & health")).toContain(PROBE_PARAGRAPH);
    expect(sectionOf(DOC, "## 10. Error handling")).toContain(SERVER_TEXT_PARAGRAPH);
  });

  test("3. the acceptance matrix has its two markers, in order", () => {
    const matrix = sectionOf(DOC, "### 11.5 The acceptance matrix");
    const begin = matrix.indexOf("<!-- s3-acceptance:begin -->");
    const end = matrix.indexOf("<!-- s3-acceptance:end -->");
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
  });

  test("4. nothing the doc must not say", () => {
    expect(DOC).not.toMatch(/[\u2013\u2014]/);
    expect(DOC).not.toMatch(/\.(?:tsx?|mjs|md|ya?ml|json):\d/);
    expect(DOC).not.toContain("S3-compatible storage");
    expect(DOC).not.toContain("/tmp/");
    expect(DOC).not.toContain("scratchpad");
    const lines = DOC.split("\n");
    const bareTags = lines.filter(
      (line, at) =>
        !line.startsWith("```") &&
        !inFence(lines, at) &&
        !line.startsWith("<!-- ") &&
        /(?<!\\)<[A-Za-z]/.test(line.replace(/`[^`]*`/g, "").replace(/\]\([^)]*\)/g, "")),
    );
    expect(bareTags, "a placeholder outside a code span is written \\<name\\>").toEqual([]);
    lines.forEach((line, at) => {
      if (!line.startsWith("## ") || inFence(lines, at)) return;
      const next = lines.slice(at + 1).find((candidate) => candidate.trim() !== "");
      expect(next?.startsWith("#"), `${line} is followed by text`).toBe(false);
    });
  });
});
