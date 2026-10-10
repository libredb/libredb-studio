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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { connectionFieldHint, DB_UI_CONFIG, hostUriSchemes, offersSshTunnel, readOnlyHint } from "@/lib/db-ui-config";
import {
  connectableProductCount,
  EXTERNAL_DATABASE_TYPES,
  MCP_EXPOSABLE,
  READ_ONLY_ENFORCED,
  SHIPPED_DATABASE_TYPES,
  WIRE_COMPATIBLE_ENGINES,
} from "@/lib/db/compatibility";
import { consoleTextByteLimit } from "@/lib/db/destructive-commands";
import { assertNotLinkLocalLiteral, LINK_LOCAL_NETWORKS } from "@/lib/db/http/egress-policy";
import {
  type NodeByteRequest,
  type NodeByteResponse,
  type NodeByteTransport,
  TransportError,
} from "@/lib/db/http/node-transport";
import type { S3ClientContext } from "@/lib/db/providers/objectstore/s3/client";
import { buildS3ConnectionOptions } from "@/lib/db/providers/objectstore/s3/connection-options";
import { S3_COMMAND_TABLE, type S3FlagSpec } from "@/lib/db/providers/objectstore/s3/console/commands";
import {
  S3_ECHO_WORD_CHARS,
  S3_MAX_BUCKET_BYTES,
  S3_MAX_PAGES_PER_RUN,
  S3_MAX_TEXT_BYTES,
  S3_MAX_TOKEN_CHARS,
} from "@/lib/db/providers/objectstore/s3/console/constants";
import { S3_REPEATED_TOKEN_SENTENCE } from "@/lib/db/providers/objectstore/s3/console/execute";
import { s3Refusal } from "@/lib/db/providers/objectstore/s3/console/guard";
import { S3_CONSOLE_NOTICES } from "@/lib/db/providers/objectstore/s3/console/results";
import {
  S3_ACCESS_KEY_ID_MAX_CHARS,
  S3_ACCESS_KEY_ID_MIN_CHARS,
  S3_BUCKET_LIST_RESPONSE_BYTES,
  S3_CELL_CHARS,
  S3_CURSOR_TOKEN_MAX_CHARS,
  S3_DEFAULT_PORT,
  S3_DEFAULT_REGION,
  S3_HEALTH_DEADLINE_MS,
  S3_KEY_MAX_BYTES,
  S3_KEY_SCAN_MAX_COUNT,
  S3_LIST_RESPONSE_BYTES,
  S3_MAX_BUCKETS_READ,
  S3_PARQUET_DECODE_SLOTS,
  S3_PREVIEW_DEFAULT_ROWS,
  S3_PREVIEW_LIMITS,
  S3_RESULT_MAX_ROWS,
  S3_SERVER_TEXT_CHARS,
  S3_SHOWN_NAME_CHARS,
  S3_SMALL_RESPONSE_BYTES,
  S3_SURFACE_DEADLINE_MS,
  S3_XML_MAX_DEPTH,
  S3_XML_MAX_ELEMENTS,
} from "@/lib/db/providers/objectstore/s3/constants";
import { S3ServerError, toProviderError } from "@/lib/db/providers/objectstore/s3/errors";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import { S3_LABELS } from "@/lib/db/providers/objectstore/s3/labels";
import { S3_OBJECTS_LISTED_ELSEWHERE } from "@/lib/db/providers/objectstore/s3/objects";
import { S3_PREVIEW_SENTENCES } from "@/lib/db/providers/objectstore/s3/preview-render";
import { DEFAULT_QUERY_TIMEOUT } from "@/lib/db/types";
import { resolveConnectionCredentials } from "@/lib/seed/credential-resolver";
import { SeedConfigSchema } from "@/lib/seed/types";
import { readsSqlText } from "@/lib/sql/grammar";
import type { DatabaseConnection, WithTunnelFarEnd } from "@/lib/types";

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

/** An unsigned connection to a loopback endpoint: every builder check passes, so an override isolates one rule. */
const CONNECTION = {
  id: "s3-doc",
  name: "S3 doc test",
  type: "s3",
  host: "localhost",
  port: 9000,
  user: "",
  password: "",
} as DatabaseConnection;

/** The sentence `buildS3ConnectionOptions` refuses a connection with `overrides` with. */
function builderRefusal(overrides: Record<string, unknown>): string {
  try {
    buildS3ConnectionOptions({ ...CONNECTION, ...overrides } as DatabaseConnection & WithTunnelFarEnd, {
      executionReadOnly: false,
      queryTimeout: DEFAULT_QUERY_TIMEOUT,
    });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected the builder to refuse ${JSON.stringify(overrides)}`);
}

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

const UNITS = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** An English numeral as the copy spells it, for 1 to 99: `twenty-eight`, `fifty-five`. */
function word(count: number): string {
  if (!Number.isInteger(count) || count < 1 || count > 99) throw new Error(`no numeral for ${count}`);
  if (count < 20) return UNITS[count];
  const unit = count % 10;
  return unit === 0 ? TENS[Math.floor(count / 10)] : `${TENS[Math.floor(count / 10)]}-${UNITS[unit]}`;
}

/** The same numeral at the start of a sentence. */
const Word = (count: number): string => `${word(count).charAt(0).toUpperCase()}${word(count).slice(1)}`;

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

  test("the read-only recipe loads as a seed file, read-only and managed, signing from the environment", () => {
    const fixture = "tests/fixtures/seed-connections/s3-read-only-config.yaml";
    const file = parseYaml(read(fixture)) as { connections: Record<string, unknown>[] };
    const parsed = SeedConfigSchema.safeParse(file);
    expect(parsed.success).toBe(true);
    const connections = parsed.data?.connections ?? [];
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      id: "s3-read-only",
      type: "s3",
      managed: true,
      readOnly: true,
      database: "reports",
      region: "us-east-1",
      user: "${S3_ACCESS_KEY_ID}",
      password: "${S3_SECRET_ACCESS_KEY}",
      ssl: { mode: "verify-full" },
    });
    const withMcp = { ...file, connections: [{ ...file.connections[0], mcp: true }] };
    expect(SeedConfigSchema.safeParse(withMcp).success).toBe(false);
  });
});

describe("docs/providers/s3.md: the connection, as the dialog and the builder state it", () => {
  const fields = sectionOf(DOC, "### 4.1 Configuration fields");

  test("5. the label is the outward name, and every dialog label has its row", () => {
    const config = DB_UI_CONFIG.s3;
    expect(config.label).toBe("S3-compatible object storage");
    expect(config.fieldLabels).toEqual({
      host: "Endpoint host",
      user: "Access key ID",
      password: "Secret access key",
      database: "Bucket",
      region: "Region",
      allowInsecureAuth: "Connect without TLS",
    });
    for (const label of Object.values(config.fieldLabels ?? {})) expect(fields).toContain(`| ${label}`);
    expect(config.defaultPort).toBe(String(S3_DEFAULT_PORT));
    expect(rowOf(fields, "Endpoint host, Port")).toContain(`\`${config.defaultPort}\``);
  });

  test("6. every dialog hint is quoted in section 4.1", () => {
    for (const field of ["host", "user", "password", "database", "region", "allowInsecureAuth"] as const) {
      const hint = connectionFieldHint(DB_UI_CONFIG.s3, field);
      expect(hint, field).toBeDefined();
      expect(flat(fields), field).toContain(hint ?? "");
    }
  });

  test("7. the access key ID bound and its one refusal are the builder's", () => {
    const short = builderRefusal({ user: "a".repeat(S3_ACCESS_KEY_ID_MIN_CHARS - 1), password: "secret" });
    const long = builderRefusal({ user: "a".repeat(S3_ACCESS_KEY_ID_MAX_CHARS + 1), password: "secret" });
    expect(short).toBe(long);
    expect(rowOf(fields, "Access key ID")).toContain(
      `${S3_ACCESS_KEY_ID_MIN_CHARS} to ${S3_ACCESS_KEY_ID_MAX_CHARS} characters`,
    );
    expect(flat(fields)).toContain(short);
    expect(flat(fields)).toContain(builderRefusal({ user: "has space", password: "secret" }));
  });

  test("8. the bucket and region refusals are the builder's, and the default region is the constant", () => {
    expect(flat(fields)).toContain(builderRefusal({ database: "-not-a-bucket" }));
    expect(flat(fields)).toContain(builderRefusal({ region: "us east 1" }));
    expect(S3_DEFAULT_REGION).toBe("us-east-1");
    expect(rowOf(fields, "Region")).toContain(`\`${S3_DEFAULT_REGION}\``);
    expect(flat(sectionOf(DOC, "### 4.4 One endpoint, path style and the region"))).toContain(
      `\`${S3_DEFAULT_REGION}\``,
    );
  });

  test("9. the key-pair and plain-HTTP refusals are the builder's", () => {
    expect(flat(sectionOf(DOC, "### 4.2 Authentication"))).toContain(
      builderRefusal({ user: "studio-browse", password: "" }),
    );
    expect(flat(sectionOf(DOC, "### 4.6 Plain HTTP off this machine needs consent"))).toContain(
      builderRefusal({ host: "s3.example.com" }),
    );
  });

  test("10. the region table has one row per verified server", () => {
    const region = sectionOf(DOC, "### 4.4 One endpoint, path style and the region");
    expect(region).toContain("| Server | Region enforced | Region named in the error |");
    for (const server of ["MinIO", "Silo", "Garage", "RustFS"]) expect(rowOf(region, server), server).toBeDefined();
    expect(rowOf(region, "Garage")).toContain("Yes, on a GET");
    expect(rowOf(region, "Garage")).not.toContain("HEAD");
    expect(rowOf(region, "RustFS")).not.toContain("RUSTFS_REGION");
  });

  test("11. the tunnel and the address paste are what the dialog offers", () => {
    expect(offersSshTunnel("s3")).toBe(true);
    expect(flat(sectionOf(DOC, "### 4.5 SSH tunnel"))).toContain(
      "The dialog offers the SSH tunnel on every S3-compatible object storage connection.",
    );
    expect(hostUriSchemes("s3")).toEqual(["http", "https"]);
    expect(flat(sectionOf(DOC, "### 4.7 Pasting an address"))).toContain(
      "Endpoint host takes a pasted `http://` or `https://` address",
    );
  });

  test("12. the read-only mode and machine access are what the records say", () => {
    expect(READ_ONLY_ENFORCED.s3).toBe(true);
    const mode = flat(sectionOf(DOC, "### 3.5 The read-only mode"));
    expect(mode).toContain(readOnlyHint(DB_UI_CONFIG.s3));
    expect(mode).toContain("`READ_ONLY_ENFORCED.s3` is true");
    expect(MCP_EXPOSABLE.s3).toBe(false);
    expect(AGENT_EXECUTION_ENGINES).not.toContain("s3");
    const machine = flat(sectionOf(DOC, "### 3.6 Machine access"));
    expect(machine).toContain("No agent execution and no MCP");
    expect(machine).toContain("`MCP_EXPOSABLE.s3` is false");
  });

  test("13. section 4.3 lists the shared SSL panel's modes in the dialog's order", () => {
    const literal = read("src/components/ConnectionModal.tsx").match(/\[([^\]]*)\]\s*as SSLMode\[\]/);
    if (!literal) throw new Error("the SSL panel's `as SSLMode[]` literal was not found in ConnectionModal.tsx");
    const modes = [...(literal[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(modes.length).toBeGreaterThan(0);
    expect(flat(sectionOf(DOC, "### 4.3 TLS"))).toContain(
      `The SSL panel is the shared one: ${modes.map((m) => `\`${m}\``).join(", ")}, with a custom CA and a client certificate.`,
    );
  });
});

/** A flag as section 5.2 writes it: the name, then what it takes and whether it is required. */
function flagCell(flag: S3FlagSpec): string {
  const takes: string[] = [];
  if (flag.takes === "boolean") takes.push("no value");
  if (flag.values !== undefined) takes.push(flag.values.map((value) => `\`${value}\``).join(" or "));
  if (flag.integer !== undefined) takes.push(`${n(flag.integer.min)} to ${n(flag.integer.max)}`);
  if (flag.required === true) takes.push("required");
  return takes.length === 0 ? `\`${flag.name}\`` : `\`${flag.name}\` (${takes.join(", ")})`;
}

/** One row of section 5.2, built from one entry of the exported command table. */
function commandRow(entry: (typeof S3_COMMAND_TABLE)[number]): string {
  const lead = entry.service === "studio" ? entry.operation : `aws ${entry.service} ${entry.operation}`;
  const command = entry.arguments === "" ? lead : `${lead} ${entry.arguments}`;
  const flags = entry.flags.length === 0 ? "none" : entry.flags.map(flagCell).join("; ");
  return `| \`${command}\` | ${flags} |`;
}

/** The commands section 5.3 must cover: one per refusal family of the console (writes, unknown commands, flags). */
const REQUIRED_REFUSALS: readonly string[] = [
  "aws s3 rm s3://sales/2026/orders.csv",
  "aws s3 cp s3://sales/2026/orders.csv .",
  "aws s3 presign s3://sales/2026/orders.csv",
  "aws s3api put-object --bucket sales --key a.txt",
  "aws s3api get-object --bucket sales --key a.txt a.txt",
  "aws s3api get-object-attributes --bucket sales --key a.txt",
  "aws s3api select-object-content --bucket sales --key a.csv",
  "aws s3api list-objects --bucket sales",
  "aws s3api get-bucket-policy --bucket sales",
  "aws ec2 describe-instances",
  "aws preview s3://sales/2026/orders.csv",
  "aws s3 ls --profile prod",
  "aws s3 ls --no-sign-request",
  "aws s3 ls --debug",
  "aws s3api list-buckets --query Buckets",
  "aws s3api list-objects-v2 --bucket sales --start-after 2026/",
  "aws s3api list-object-versions --bucket sales --page-size 10",
  "aws s3api head-object --bucket sales --key a.txt --version-id 1",
  "aws s3api head-object --bucket sales --key a.txt --sse-customer-key k",
];

/** Every bound section 5.6 names, with the value its module exports. */
const BOUNDS: Readonly<Record<string, number>> = {
  S3_MAX_TEXT_BYTES,
  S3_RESULT_MAX_ROWS,
  S3_KEY_SCAN_MAX_COUNT,
  S3_PREVIEW_DEFAULT_ROWS,
  S3_KEY_MAX_BYTES,
  S3_CELL_CHARS,
  S3_MAX_PAGES_PER_RUN,
  S3_MAX_TOKEN_CHARS,
  S3_CURSOR_TOKEN_MAX_CHARS,
  S3_MAX_BUCKET_BYTES,
  S3_ECHO_WORD_CHARS,
  S3_MAX_BUCKETS_READ,
  S3_BUCKET_LIST_RESPONSE_BYTES,
  S3_LIST_RESPONSE_BYTES,
  S3_SMALL_RESPONSE_BYTES,
  S3_XML_MAX_DEPTH,
  S3_XML_MAX_ELEMENTS,
  S3_SURFACE_DEADLINE_MS,
  S3_HEALTH_DEADLINE_MS,
  S3_SERVER_TEXT_CHARS,
  S3_SHOWN_NAME_CHARS,
};

describe("docs/providers/s3.md: the query interface, as the console's modules state it", () => {
  test("15. section 5.2 has exactly one row per command of the exported table", () => {
    const commands = sectionOf(DOC, "### 5.2 Commands and flags");
    const rows = commands.split("\n").filter((line) => /^\| `(aws |preview)/.test(line));
    expect(rows).toEqual(S3_COMMAND_TABLE.map(commandRow));
  });

  test("16. every row of section 5.3 is the console's own refusal of its input, and every family is there", () => {
    const refused = sectionOf(DOC, "### 5.3 Refused commands");
    const rows = refused.split("\n").filter((line) => /^\| `[^`]+` \| /.test(line));
    const inputs = rows.map((line) => /^\| `([^`]+)` \| /.exec(line)?.[1] ?? "");
    for (const input of REQUIRED_REFUSALS) expect(inputs, input).toContain(input);
    for (const [at, input] of inputs.entries()) {
      const sentence = s3Refusal(input);
      expect(sentence, input).toBeDefined();
      expect(rows[at], input).toBe(`| \`${input}\` | ${sentence} |`);
    }
  });

  test("17. every bound of section 5.6 is its constant, and the text bound is the editor's", () => {
    const bounds = sectionOf(DOC, "### 5.6 Bounds");
    for (const [name, value] of Object.entries(BOUNDS)) {
      const row = rowOf(bounds, `\`${name}\``);
      expect(row, name).toBeDefined();
      expect(row, name).toContain(`| ${n(value)} |`);
    }
    expect(consoleTextByteLimit("s3")).toBe(S3_MAX_TEXT_BYTES);
  });

  test("18. section 5.5 states the three size spellings", () => {
    expect(flat(sectionOf(DOC, "### 5.5 Result shape"))).toContain(
      "`ls --human-readable` writes the AWS CLI's spelling (1,280 bytes is `1.2 KiB`), the Keys panel writes Studio's shared spelling (`1.25 KB`), and the Metadata part and the `s3api` grids write bytes.",
    );
  });

  test("19. every example of section 5.4 is a command the console accepts", () => {
    const examples = sectionOf(DOC, "### 5.4 Examples");
    const blocks = [...examples.matchAll(/```s3\n([\s\S]*?)```/g)].map((match) => match[1].trimEnd());
    expect(blocks.length).toBeGreaterThanOrEqual(9);
    for (const block of blocks) expect(s3Refusal(block), block).toBeUndefined();
  });
});

describe("docs/providers/s3.md: the console's notices, as its modules state them", () => {
  test("section 5.5 quotes every fixed notice a console result carries", () => {
    const shape = flat(sectionOf(DOC, "### 5.5 Result shape"));
    for (const [name, notice] of Object.entries(S3_CONSOLE_NOTICES)) expect(shape, name).toContain(notice);
  });

  test("section 5.7 quotes the repeated-token failure", () => {
    expect(flat(sectionOf(DOC, "### 5.7 Pagination and the starting token"))).toContain(S3_REPEATED_TOKEN_SENTENCE);
  });
});

/** The provider every declaration case reads; it has no transport, so a call that would send fails loudly. */
const provider = new S3Provider(
  CONNECTION,
  {},
  {},
  {
    createTransport: () => {
      throw new Error("the doc test never connects");
    },
  },
);

/** The client, console and preview modules a browser bundle may import. */
const BROWSER_SET: ReadonlySet<string> = new Set([
  "constants.ts",
  "names.ts",
  "xml.ts",
  "shapes.ts",
  "headers.ts",
  "labels.ts",
  "console/constants.ts",
  "console/lexer.ts",
  "console/paths.ts",
  "console/token.ts",
  "console/commands.ts",
  "console/guard.ts",
  "console/format.ts",
  "console/generators.ts",
  "console/statement-language.ts",
  "preview-detect.ts",
  "preview-text.ts",
  "preview-csv.ts",
  "preview-json.ts",
  "parquet-schema.ts",
  "parquet-thrift-guard.ts",
  "preview-cells.ts",
  "preview-render.ts",
]);

/** Every `.ts` file under `directory`, as a path relative to it. */
function typescriptFiles(directory: string, prefix = ""): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return typescriptFiles(path.join(directory, entry.name), `${prefix}${entry.name}/`);
    return entry.name.endsWith(".ts") ? [`${prefix}${entry.name}`] : [];
  });
}

describe("docs/providers/s3.md: the provider's shape, as the built provider declares it", () => {
  test("20. the module table names every module of the provider directory, and where it runs", () => {
    const modules = sectionOf(DOC, "### 2.2 Modules");
    const files = typescriptFiles(PROVIDER_DIRECTORY);
    for (const file of files) {
      const row = rowOf(modules, `\`${file}\``);
      expect(row, file).toBeDefined();
      const where = BROWSER_SET.has(file) ? "browser" : "server";
      expect(row?.endsWith(`| ${where} |`), `${file} runs on the ${where}`).toBe(true);
    }
    const documented = modules.split("\n").filter((line) => /^\| `[a-z0-9/-]+\.ts` \|/.test(line));
    expect(documented).toHaveLength(files.length);
  });

  test("21. the Keys panel declarations are getCapabilities()'s, and the doc says each", () => {
    const capabilities = provider.getCapabilities();
    expect(capabilities.supportsResultPagination).toBe(false);
    expect(capabilities.containerLevels).toEqual([]);
    const keyScan = capabilities.keyScan;
    expect(keyScan?.levels?.rootKind).toBe("bucket");
    const keys = flat(sectionOf(DOC, "### 6.4 The Keys panel"));
    expect(keys).toContain(`separator \`${keyScan?.separator}\``);
    expect(keys).toContain(`cursor \`${keyScan?.cursor}\``);
    expect(keys).toContain(`pattern \`${keyScan?.pattern}\``);
    expect(keys).toContain(`totalScope \`${keyScan?.totalScope}\``);
    expect(keys).toContain(`levels.rootKind \`${keyScan?.levels?.rootKind}\``);
    expect(keys).toContain(`defaultCount ${n(keyScan?.defaultCount ?? 0)}`);
    expect(keys).toContain(`maxCount ${n(keyScan?.maxCount ?? 0)}`);
    expect(keys).toContain("`containerLevels` is empty");
    expect(keys).toContain("valid in every process that serves the connection");
    expect(flat(sectionOf(DOC, "### 6.1 The object surface"))).toContain(S3_OBJECTS_LISTED_ELSEWHERE);
  });

  test("22. the cursor section states the cursor envelope", () => {
    const cursor = flat(sectionOf(DOC, "### 3.7 The Keys panel cursor"));
    expect(cursor).toContain("a stateless, scope-bound envelope with no MAC");
    expect(cursor).toContain("valid in every process that serves the connection");
    expect(cursor).toContain("a hand-written cursor of the right shape and scope can reach the server");
  });

  test("23. the object preview's limits table holds every limit, with its value", () => {
    const preview = sectionOf(DOC, "#### Object preview");
    for (const [name, value] of Object.entries(S3_PREVIEW_LIMITS)) {
      const row = rowOf(preview, `\`${name}\``);
      expect(row, name).toBeDefined();
      expect(row, name).toContain(`| ${n(value as number)} |`);
    }
  });

  test("23b. the Parquet limits claim measurement only where the decode runs varied them", () => {
    const summary = flat(DOC)
      .split(/(?<=\.) /)
      .find((sentence) => sentence.startsWith("A Parquet file whose first row group does not fit"));
    expect(summary).toBeDefined();
    for (const limit of ["read", "decode", "leaf-column", "value"]) expect(summary).toContain(limit);
    expect(summary).not.toContain("fetch budget");
    const preview = sectionOf(DOC, "#### Object preview");
    const lead = preview.split("\n").find((line) => line.startsWith("The Parquet value"));
    expect(lead).toBeDefined();
    const measured = lead?.split(" were measured")[0];
    expect(measured).toBeDefined();
    expect(measured).not.toMatch(/fetch|decode/);
    for (const name of ["parquetFetchBudget", "parquetDecodeBudget"]) {
      const basis = rowOf(preview, `\`${name}\``)?.split("|")[3]?.trim();
      expect(basis, name).toBeDefined();
      expect(basis?.startsWith("Measured"), name).toBe(false);
    }
  });
});

describe("docs/providers/s3.md: the object preview's sentences, read back from preview-render.ts", () => {
  test("every preview sentence is its row of the Object preview table, verbatim", () => {
    const preview = sectionOf(DOC, "#### Object preview");
    for (const [id, sentence] of Object.entries(S3_PREVIEW_SENTENCES)) {
      expect(rowOf(preview, id), id).toBe(`| ${id} | \`${sentence}\` |`);
    }
  });

  test("the table holds no sentence row the module does not export", () => {
    const preview = sectionOf(DOC, "#### Object preview");
    const ids = preview
      .split("\n")
      .filter((line) => /^\| [NR]-[A-Z0-9-]+ \| `/.test(line))
      .map((line) => line.slice(2, line.indexOf(" |", 2)));
    expect(ids.sort()).toEqual(Object.keys(S3_PREVIEW_SENTENCES).sort());
  });
});

/** A transport that records every request and answers each with `status` and `body`. */
function probeTransport(status: number, body: string): { sent: NodeByteRequest[]; create: () => NodeByteTransport } {
  const sent: NodeByteRequest[] = [];
  const answer: NodeByteResponse = {
    status,
    contentType: "application/xml",
    contentEncoding: null,
    retryAfter: null,
    headers: [],
    headersTruncated: false,
    bytes: Buffer.from(body),
    truncated: false,
  };
  const transport: NodeByteTransport = {
    request: async (request) => {
      sent.push(request);
      return answer;
    },
    close: () => {},
  };
  return { sent, create: () => transport };
}

const LIST_BUCKET_RESULT =
  '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>studio-demo</Name><Prefix></Prefix><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><Delimiter>/</Delimiter><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated></ListBucketResult>';
const LIST_ALL_MY_BUCKETS_RESULT =
  '<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>studio</ID></Owner><Buckets></Buckets></ListAllMyBucketsResult>';

/** The context every error row is worded for: a signed connection to localhost:9000 that signs for us-east-1. */
const ERROR_CONTEXT: S3ClientContext = {
  region: "us-east-1",
  signs: true,
  clock: () => new Date("2026-10-09T12:00:00Z"),
  secretForms: [],
  endpointText: "http://localhost:9000",
};

/** The message `toProviderError` words for one server answer. */
function serverError(fields: ConstructorParameters<typeof S3ServerError>[0]): string {
  const error = toProviderError(new S3ServerError(fields), fields.operation, ERROR_CONTEXT);
  return (error as Error).message;
}

/** The rows of section 10: the answer as the doc names it, and the sentence Studio gives for it. */
const ERROR_ROWS: ReadonlyArray<readonly [string, () => string]> = [
  [
    "403 `SignatureDoesNotMatch`",
    () =>
      serverError({
        operation: "ListBuckets",
        method: "GET",
        status: 403,
        code: "SignatureDoesNotMatch",
        message: "The request signature we calculated does not match the signature you provided.",
      }),
  ],
  [
    "403 `InvalidAccessKeyId`",
    () =>
      serverError({
        operation: "ListBuckets",
        method: "GET",
        status: 403,
        code: "InvalidAccessKeyId",
        message: "The Access Key Id you provided does not exist in our records.",
      }),
  ],
  [
    "403 `AccessDenied` on a bucket",
    () =>
      serverError({
        operation: "ListObjectsV2",
        method: "GET",
        status: 403,
        code: "AccessDenied",
        message: "Access Denied.",
        bucket: "sales",
      }),
  ],
  [
    "404 `NoSuchBucket`",
    () =>
      serverError({
        operation: "ListObjectsV2",
        method: "GET",
        status: 404,
        code: "NoSuchBucket",
        message: "The specified bucket does not exist",
        bucket: "sales",
      }),
  ],
  [
    "404 `NoSuchKey`",
    () =>
      serverError({
        operation: "GetObject",
        method: "GET",
        status: 404,
        code: "NoSuchKey",
        message: "The specified key does not exist.",
        bucket: "sales",
        key: "2026/orders.csv",
      }),
  ],
  [
    "400 `AuthorizationHeaderMalformed` naming another region",
    () =>
      serverError({
        operation: "ListObjectsV2",
        method: "GET",
        status: 400,
        code: "AuthorizationHeaderMalformed",
        message: "The authorization header is malformed.",
        region: "eu-central-1",
        bucket: "sales",
      }),
  ],
  [
    "403 `RequestTimeTooSkewed`",
    () =>
      serverError({
        operation: "GetObject",
        method: "GET",
        status: 403,
        code: "RequestTimeTooSkewed",
        message: "The difference between the request time and the server's time is too large.",
        bucket: "sales",
        key: "2026/orders.csv",
      }),
  ],
  [
    "400 `XMinioInvalidResourceName`",
    () =>
      serverError({
        operation: "ListObjectsV2",
        method: "GET",
        status: 400,
        code: "XMinioInvalidResourceName",
        message: "Object name contains unsupported characters.",
        bucket: "sales",
      }),
  ],
  [
    "501 `NotImplemented` on a continuation token",
    () =>
      serverError({
        operation: "ListObjectsV2",
        method: "GET",
        status: 501,
        code: "NotImplemented",
        message: "A header you provided implies functionality that is not implemented",
        bucket: "sales",
        sentToken: true,
      }),
  ],
  [
    "HEAD 403 with no body and no code",
    () =>
      serverError({ operation: "HeadObject", method: "HEAD", status: 403, bucket: "sales", key: "2026/orders.csv" }),
  ],
  [
    "501 `NotImplemented` on `list-object-versions`",
    () =>
      serverError({
        operation: "ListObjectVersions",
        method: "GET",
        status: 501,
        code: "NotImplemented",
        message: "A header you provided implies functionality that is not implemented",
        bucket: "sales",
      }),
  ],
  [
    "Any 3xx",
    () =>
      (
        toProviderError(
          new TransportError("redirect", "redirect", {
            redirect: { status: 301, headers: [], headersTruncated: false },
          }),
          "ListBuckets",
          ERROR_CONTEXT,
        ) as Error
      ).message,
  ],
];

describe("docs/providers/s3.md: the probe, the declarations and the errors, as the code answers them", () => {
  test("24. the pinned probe is one ListObjectsV2 with the three parameters, and a non-S3 body fails it", async () => {
    const good = probeTransport(200, LIST_BUCKET_RESULT);
    const pinned = new S3Provider({ ...CONNECTION, database: "studio-demo" }, {}, {}, { createTransport: good.create });
    await pinned.connect();
    expect(good.sent).toHaveLength(1);
    expect(good.sent[0].method).toBe("GET");
    expect(good.sent[0].target.path).toBe("/studio-demo");
    for (const parameter of ["max-keys=1", "delimiter=%2F", "encoding-type=url"]) {
      expect(good.sent[0].target.query.split("&")).toContain(parameter);
    }
    await pinned.disconnect();
    const html = probeTransport(200, "<html><body>not S3</body></html>");
    const fake = new S3Provider({ ...CONNECTION, database: "studio-demo" }, {}, {}, { createTransport: html.create });
    await expect(fake.connect()).rejects.toThrow();
    expect(html.sent).toHaveLength(1);
  });

  test("25. the unpinned probe is one ListBuckets, and its root element is the one section 7 names", async () => {
    const good = probeTransport(200, LIST_ALL_MY_BUCKETS_RESULT);
    const unpinned = new S3Provider(CONNECTION, {}, {}, { createTransport: good.create });
    await unpinned.connect();
    expect(good.sent).toHaveLength(1);
    expect(good.sent[0].target.path).toBe("/");
    await unpinned.disconnect();
    const wrongRoot = probeTransport(200, LIST_BUCKET_RESULT);
    const fake = new S3Provider(CONNECTION, {}, {}, { createTransport: wrongRoot.create });
    await expect(fake.connect()).rejects.toThrow();
  });

  test("26. section 9 is the built provider's capabilities and labels, whole", () => {
    const declared = sectionOf(DOC, "## 9. Capabilities & labels");
    const blocks = [...declared.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    expect(blocks).toEqual([
      JSON.stringify(provider.getCapabilities(), null, 2),
      JSON.stringify(provider.getLabels(), null, 2),
    ]);
    expect(provider.getLabels()).toEqual(S3_LABELS);
  });

  test("27. section 8 is runMaintenance()'s refusal", async () => {
    expect(flat(sectionOf(DOC, "## 8. Maintenance"))).toContain(S3_LABELS.vacuumGlobalDesc);
  });

  test("28. every row of section 10 is the sentence the error mapping gives for that answer", () => {
    const errors = sectionOf(DOC, "## 10. Error handling");
    for (const [answer, sentence] of ERROR_ROWS) {
      expect(rowOf(errors, answer), answer).toBe(`| ${answer} | ${sentence()} |`);
    }
    expect(errors).toContain(`cut to ${S3_SERVER_TEXT_CHARS} characters`);
    expect(errors).not.toContain("| 416");
  });

  test("29. the refusals before any connection are the transport's and the builder's", () => {
    const errors = flat(sectionOf(DOC, "## 10. Error handling"));
    let linkLocal = "";
    try {
      assertNotLinkLocalLiteral("169.254.169.254");
    } catch (error) {
      linkLocal = (error as Error).message;
    }
    expect(linkLocal).not.toBe("");
    expect(errors).toContain(linkLocal);
    expect(errors).toContain(builderRefusal({ host: "s3.example.com" }));
  });
});

/**
 * The backlog ids section 13 cites, each as a link to its entry (Task 9 holds the anchors), under the PR's id mapping;
 * D273 and D274 are the Parquet schema and row-group entries the measured caps left.
 */
const LIMITATION_IDS: readonly string[] = [
  "D261",
  "D262",
  "D263",
  "D264",
  "D265",
  "D267",
  "D270",
  "D271",
  "D273",
  "D274",
  "U109",
  "B104",
];

/** How a prose list names each entry of LINK_LOCAL_NETWORKS: a /128 as the address, the NAT64 range by name. */
function networkWords(): string[] {
  return LINK_LOCAL_NETWORKS.map(([network, prefix]) =>
    prefix === 128 ? network : network.startsWith("64:ff9b:") ? "NAT64" : `${network}/${prefix}`,
  );
}

describe("docs/providers/s3.md: networks, tests, limits and references", () => {
  test("30. section 3.4 names exactly the networks the byte transport refuses", () => {
    const networks = sectionOf(DOC, "### 3.4 Link-local networks are always refused");
    expect(LINK_LOCAL_NETWORKS).toHaveLength(4);
    for (const [network, prefix] of LINK_LOCAL_NETWORKS) expect(networks).toContain(`\`${network}/${prefix}\``);
    expect(networks).not.toContain("cloud metadata addresses");
  });

  test("31. the slow-link bullet's numbers are the budget's and the deadline's", () => {
    const seconds = S3_SURFACE_DEADLINE_MS / 1000;
    const rate = Math.ceil((S3_PREVIEW_LIMITS.parquetFetchBudget * 8) / seconds / 1_000_000);
    expect(flat(sectionOf(DOC, "## 13. Known limitations"))).toContain(
      `A Parquet preview that reads the whole fetch budget needs a link of about ${rate} Mbit/s to finish within the Source tab's ${seconds}-second deadline; on a slower link it ends with the timeout sentence, and the console's \`preview --columns\` or \`--schema\` reads less.`,
    );
  });

  test("32. section 13 cites exactly its backlog ids, each as a link", () => {
    const limits = sectionOf(DOC, "## 13. Known limitations");
    const cited = new Set([...limits.matchAll(/\b([DUB]\d+)\b/g)].map((match) => match[1]));
    expect([...cited].sort()).toEqual([...LIMITATION_IDS].sort());
    for (const id of LIMITATION_IDS) expect(limits, id).toContain(`([${id}](../BACKLOG.md#`);
    expect(flat(limits)).toContain(`at most ${S3_PARQUET_DECODE_SLOTS} at a time`);
    const leaves = S3_PREVIEW_LIMITS.parquetMaxLeafColumns;
    expect(flat(limits)).toContain(
      `A Parquet preview shows at most ${n(leaves)} leaf columns, the leaf-column bound the decode measurement set, and refuses a schema of more than ${n(leaves * 8)} elements, eight times it`,
    );
    expect(flat(limits)).toContain("previews fewer columns");
    expect(flat(limits)).toContain("only its schema and statistics when its first column alone");
    expect(flat(limits)).toContain("is refused when one page declares more values than a preview allows");
    expect(limits).toContain("(../BACKLOG.md#d274-large-parquet-row-groups-preview-fewer-columns-or-none)");
    const rowGroups = limits.split("\n").find((line) => line.includes("[D274]"));
    expect(rowGroups).toBeDefined();
    expect(rowGroups).not.toContain("previews as its schema and statistics without rows");
    expect(flat(limits)).toContain(`names at most ${n(S3_PREVIEW_LIMITS.maxColumns * 8)} columns`);
  });

  test("33. the testing section names files that exist", () => {
    const testing = sectionOf(DOC, "## 11. Testing");
    for (const file of [
      "docker/s3/README.md",
      "tests/live/s3-evidence.ts",
      "tests/live/s3-live-check.ts",
      "tests/integration/db/s3-provider.test.ts",
    ]) {
      expect(testing, file).toContain(`\`${file}\``);
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    }
    expect(testing).toContain("bun tests/run-tests.ts tests/integration/db/s3-provider.test.ts");
  });
});

const BACKLOG = read("docs/BACKLOG.md");
const AGENT_DOC = read("docs/AGENT.md");

/** A BACKLOG entry, from its heading to the next heading, as one line. */
function backlogEntry(id: string): string {
  const start = BACKLOG.indexOf(`\n### ${id}. `);
  if (start < 0) throw new Error(`docs/BACKLOG.md has no entry ${id}`);
  const end = BACKLOG.indexOf("\n#", start + 1);
  return flat(BACKLOG.slice(start, end));
}

/** GitHub's heading anchor: lower case, spaces to `-`, everything but letters, digits, `-` and `_` dropped. */
const anchorOf = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/[^a-z0-9_-]/g, "");

/** The anchor of BACKLOG entry `id`, from its heading. */
function backlogAnchor(id: string): string {
  const heading = BACKLOG.split("\n").find((line) => line.startsWith(`### ${id}. `));
  if (heading === undefined) throw new Error(`docs/BACKLOG.md has no entry ${id}`);
  return anchorOf(heading.slice("### ".length));
}

/** The entries this part files in PR 3, with a phrase each must hold. */
const S3_ENTRIES: Readonly<Record<string, string>> = {
  D261: "No SQL over files in an S3 bucket",
  D262: "S3 connections cannot use temporary credentials",
  D263: "S3 connections address buckets by path only",
  D264: "S3 connections cannot write",
  D265: "The S3 provider is not verified on AWS S3 or any hosted service",
  D266: "Each provider carries its own UTF-8 helpers",
  D267: "The MinIO fixture is a frozen build of an archived project",
  D268: "The CLI lead and verb-role tokenizer exists twice",
  D269: "Four providers carry private byte-size formatters",
  D270: "The HTTP egress guard is the same for every role",
  D271: "Parquet previews decode on the server's main thread",
  D273: "Wide Parquet schemas are refused above 1,024 elements",
  D274: "Large Parquet row groups preview fewer columns or none",
  U109: "The object tree is not paged, so an account with thousands of buckets lists them in one folder",
  U110: "Databend declares a User placeholder the dialog never draws",
  B104: "S3-compatible object storage has no agent execution and no MCP surface",
};

describe("the backlog record of the S3 provider", () => {
  test("34. every entry exists under its title, with a Done when", () => {
    for (const [id, title] of Object.entries(S3_ENTRIES)) {
      expect(BACKLOG, id).toContain(`\n### ${id}. ${title}\n`);
      expect(backlogEntry(id), id).toContain("**Done when:**");
    }
  });

  test("35. every backlog link the provider doc holds lands on an entry", () => {
    const anchors = BACKLOG.split("\n")
      .filter((line) => line.startsWith("### "))
      .map((line) => anchorOf(line.slice("### ".length)));
    for (const [, anchor] of DOC.matchAll(/\]\(\.\.\/BACKLOG\.md#([^)]+)\)/g))
      expect(anchors, anchor).toContain(anchor);
    for (const id of LIMITATION_IDS) {
      expect(sectionOf(DOC, "## 13. Known limitations"), id).toContain(`[${id}](../BACKLOG.md#${backlogAnchor(id)})`);
    }
  });

  test("36. D223 carries the S3 hex-dump sentence and U82 the amendment", () => {
    expect(backlogEntry("D223")).toContain(
      "The S3 object preview's hex dump carries the same caption (src/lib/db/providers/objectstore/s3/preview-render.ts).",
    );
    expect(backlogEntry("U82")).toContain(
      "Since the S3 provider the label is declarable: the dialog draws DB_UI_CONFIG.<type>.fieldLabels.allowInsecureAuth when a type declares it, and S3 declares Connect without TLS.",
    );
    expect(backlogEntry("U82")).toContain(
      "**Done when:** Oxia, influxdb and influxdb3 each declare a fieldLabels.allowInsecureAuth that names their token, every refusal that quotes the label quotes the new one, and a test renders the dialog for a password type and a token type and asserts each label.",
    );
  });

  test("37. docs/AGENT.md cites B104 with its reason, after B103", () => {
    const b103 = AGENT_DOC.indexOf("- **B103**:");
    const b104 = AGENT_DOC.indexOf("- **B104**:");
    expect(b103).toBeGreaterThan(-1);
    expect(b104).toBeGreaterThan(b103);
    expect(AGENT_DOC).toContain(
      "- **B104**: S3-compatible object storage is served by plan mode only: MCP is not offered for it (`MCP_EXPOSABLE.s3` is false), and its provider implements no `queryReadOnly`, so agent execution and MCP `run_read_query` refuse it, because no MCP surface that never returns a key is designed yet (`docs/providers/s3.md` section 3.6).",
    );
  });
});

const SECURITY = read("docs/SECURITY.md");

/** One row of the SECURITY control table, split into its five cells. */
interface ControlRow {
  readonly control: string;
  readonly status: string;
  readonly enforcedIn: readonly string[];
  readonly verifiedBy: readonly string[];
}

/** The repository paths a cell links, read from its `](../path)` targets. */
const linkedPaths = (cell: string): string[] => [...cell.matchAll(/\]\(\.\.\/([^)]+)\)/g)].map((match) => match[1]);

/** The control table row of `id`. */
function controlRow(id: string): ControlRow {
  const line = rowOf(SECURITY, id);
  if (line === undefined) throw new Error(`docs/SECURITY.md has no row ${id}`);
  const cells = line.slice(2, -2).split(" | ");
  expect(cells, id).toHaveLength(5);
  return { control: cells[1], status: cells[2], enforcedIn: linkedPaths(cells[3]), verifiedBy: linkedPaths(cells[4]) };
}

/** The Known limits bullet that begins with `lead`, up to the next bullet, as one line. */
function knownLimit(lead: string): string {
  const limits = sectionOf(SECURITY, "## Known limits");
  const start = limits.indexOf(`- ${lead}`);
  if (start < 0) throw new Error(`no Known limits bullet ${lead}`);
  const end = limits.indexOf("\n- ", start + 1);
  return flat(limits.slice(start, end < 0 ? limits.length : end));
}

/** Row 3.18's Control text, exactly. */
const CONTROL_3_18 =
  "On an S3-compatible object storage connection, a console command runs only when it is one of the nine closed AWS CLI read commands (`aws s3 ls`, `aws s3api list-buckets`, `aws s3api list-objects-v2`, `aws s3api list-object-versions`, `aws s3api head-bucket`, `aws s3api head-object`, `aws s3api get-object-tagging`, `aws s3api get-bucket-location`, `aws s3api get-bucket-versioning`) or Studio's own `preview`, with only the flags its row declares, and it fits the console's text bound; the client sends only GET and HEAD requests, to ListBuckets, HeadBucket, GetBucketLocation, GetBucketVersioning, ListObjectsV2, ListObjectVersions, HeadObject, a ranged GetObject and GetObjectTagging; a command the editor refuses is never sent and never written to history; a command refused only on the server, because it names an endpoint, a region or a bucket other than the connection's, is not sent either, and history keeps its text whole with the refusal sentence as its error, as it does for every statement the editor accepts; and a key whose `.` and `..` segments, resolved with empty segments skipped, leave its bucket or name the bucket itself is refused before any request wherever an object path is built, so the bucket pin holds under a server or proxy that resolves dot segments or merges slashes";
/** Row 3.19's Control text, exactly. */
const CONTROL_3_19 =
  "On an S3-compatible object storage connection, a request is signed only with the access key pair typed into the connection, and an empty pair sends it unsigned: no environment variable, shared credential or config file, container credential endpoint or instance metadata is ever read; an endpoint that is or resolves to an address in 169.254.0.0/16 (also in its IPv4-mapped and NAT64 forms) or fe80::/10, or to fd00:ec2::254, is refused before any connection by the byte transport (row 0.6), whatever `DB_HTTP_BLOCK_PRIVATE_HOSTS` says, and through an SSH tunnel the far end's address literal is checked the same way; a request is not sent over plain HTTP to a host that is neither loopback nor tunnelled unless the connection consents, whether or not it is signed; no object is read on a connection whose connect probe did not parse as S3 XML (ListObjectsV2 on the pinned bucket as `ListBucketResult`, else ListBuckets as `ListAllMyBucketsResult`); every XML answer is read by a reader that refuses a document type declaration and every entity; and the object preview hands a Parquet footer or page header to its decoder only when its Thrift encoding reads to the same values in the decoder as in Studio's check, refuses a footer whose sizes, counts or offsets are not non-negative safe integers or whose fields pass a fixed bound, parses each footer inside the two decode slots the decodes share, and bounds every decode and every rendered cell before the work, not after";

describe("docs/SECURITY.md: the S3 rows and limits", () => {
  test("38. rows 3.18 and 3.19 carry the S3 controls, with files that exist", () => {
    for (const [id, control] of [
      ["3.18", CONTROL_3_18],
      ["3.19", CONTROL_3_19],
    ] as const) {
      const row = controlRow(id);
      expect(row.control).toBe(control);
      expect(row.status).toBe("Implemented");
      expect(row.enforcedIn.length).toBeGreaterThan(0);
      expect(row.verifiedBy.length).toBeGreaterThan(0);
      for (const file of [...row.enforcedIn, ...row.verifiedBy])
        expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    }
    expect(controlRow("3.18").verifiedBy).toContain("tests/unit/db/s3/read-only-end-to-end.test.ts");
    expect(controlRow("3.18").control).toContain("never written to history");
    expect(controlRow("3.18").control).not.toContain("is what history records");
  });

  test("38a. the key and Parquet clauses name the modules that enforce them and the tests that verify them", () => {
    for (const file of ["names.ts", "encoding.ts"])
      expect(controlRow("3.18").enforcedIn).toContain(`${PROVIDER_DIRECTORY}/${file}`);
    for (const file of ["names", "encoding", "objects"])
      expect(controlRow("3.18").verifiedBy).toContain(`tests/unit/db/s3/${file}.test.ts`);
    for (const file of ["parquet-thrift-guard.ts", "preview-parquet.ts", "preview-cells.ts"])
      expect(controlRow("3.19").enforcedIn).toContain(`${PROVIDER_DIRECTORY}/${file}`);
    for (const file of ["parquet-thrift-guard", "preview-parquet", "preview-cells"])
      expect(controlRow("3.19").verifiedBy).toContain(`tests/unit/db/s3/${file}.test.ts`);
  });

  test("39. row 3.19 and row 0.6 name the networks of LINK_LOCAL_NETWORKS", () => {
    for (const words of networkWords()) {
      expect(controlRow("3.19").control, words).toContain(words);
      expect(controlRow("0.6").control, words).toContain(words);
    }
  });

  test("40. row 3.8 and its note name S3", () => {
    expect(controlRow("3.8").verifiedBy).toContain("tests/unit/db/s3/read-only-end-to-end.test.ts");
    const start = SECURITY.indexOf("**3.8.**");
    const note = flat(SECURITY.slice(start, SECURITY.indexOf("\n\n", start)));
    expect(note).toContain(
      "S3's runs reads only, so the mode changes nothing a request can do ([`docs/providers/s3.md`](./providers/s3.md) section 3.5).",
    );
  });

  test("41. the notes 3.18 and 3.19 are word for word", () => {
    expect(SECURITY).toContain(
      "**3.18.** The S3 client is built over a method set of GET and HEAD alone, so no code path in Studio can send a write to an S3 server, whatever the parser or the mode decide.\nThe console's commands are a closed table, and a command or flag outside it is refused before any request with the sentence its row names.",
    );
    expect(SECURITY).toContain(
      "A key's `.` and `..` segments are resolved with empty segments skipped, the reading with the fewest levels, so a key that stays inside its bucket on a server that keeps empty segments cannot leave it through a proxy that merges slashes; `objectPath` applies the same check to every caller, so a caller that skips the Source tab's check still cannot build such a path.",
    );
    expect(SECURITY).toContain(
      "**3.19.** An S3 provider that fell back to the server's own credentials would hand every Studio user the server's cloud identity, so Studio has no such fallback: an empty key pair is an unsigned request, never an ambient one.",
    );
    expect(SECURITY).toContain(
      "A metadata service a cloud serves outside those networks is not refused; none is claimed.",
    );
    expect(SECURITY).toContain(
      "A Parquet footer and its page headers are data the object supplies, so the preview checks them before its decoder reads them: a varint longer than its type allows or a long-form field id outside 1 to 32,767 is refused, so the check and the decoder read the same values, and a size, count or offset that is negative or past 2^53 is refused, so no value can lower a sum below its cap.",
    );
    expect(SECURITY).toContain(
      "A rendered cell is cut while its string is escaped, never escaped whole and cut afterwards, so a decoded string far past the cell bound costs no more memory than the cell.",
    );
  });

  test("42. the Known limits name S3 where they list the engines, and state S3's own limits", () => {
    expect(knownLimit("**The HTTP destination guard is opt-in and address-based.**")).toContain(
      "Qdrant, InfluxDB (InfluxQL), InfluxDB 3 (SQL) and S3-compatible object storage HTTP requests",
    );
    expect(knownLimit("**A statement the editor refuses is never sent and never written to history.**")).toContain(
      "The Milvus, Qdrant, InfluxDB (InfluxQL), Oxia and S3 rows declare both (rows 3.11, 3.12, 3.15 and 3.18); no other shipped engine declares either.",
    );
    const s3 = knownLimit("**S3-compatible object storage is reached over a REST client of Studio's own.**");
    expect(s3).toContain("14 minutes of skew were accepted and 20 refused on MinIO, Silo and RustFS");
    expect(s3).toContain("a policy that differs by role is a backlog entry (D270)");
    expect(s3).toContain("it is a scope, not an access boundary");
    expect(s3).toContain(
      "A key whose `.` and `..` segments, resolved with empty segments skipped, climb out of its bucket or name the bucket itself is refused wherever an object path is built, on every connection and before any request, so the scope holds under a server or proxy that resolves dot segments or merges slashes; such a key is listed but not opened.",
    );
    expect(s3).toContain("[`docs/providers/s3.md`](./providers/s3.md) section 13 lists the same limits.");
  });
});

describe("packaging and listing copy no count gate reads", () => {
  test("43. every exhaustive engine list in the packaging and listing descriptions names S3", () => {
    for (const file of [
      "snap/snapcraft.yaml",
      "deploy/railway/TEMPLATE_OVERVIEW.md",
      "deploy/koyeb/CATALOG_SUBMISSION.md",
      "packaging/flatpak/org.libredb.Studio.metainfo.xml",
      "packaging/flatpark/org.libredb.Studio.metainfo.xml",
    ]) {
      expect(read(file), file).toContain("S3-compatible object storage");
    }
    for (const file of [
      "desktop/src-tauri/desktop-entry.hbs",
      "packaging/flatpak/org.libredb.Studio.desktop",
      "packaging/flatpark/org.libredb.Studio.desktop",
    ]) {
      expect(read(file), file).toContain(";Qdrant;Oxia;S3;ObjectStorage;MinIO;IDE;");
    }
  });

  test("44. the numerals no gate reads count the external engines", () => {
    const engines = word(EXTERNAL_DATABASE_TYPES.length);
    expect(read("deploy/railway/TEMPLATE_OVERVIEW.md")).toContain(`any of the ${engines} engines above`);
    expect(read("packaging/aur/README.md")).toContain(`The files here name ${engines} engines`);
    expect(read("packaging/aur/.SRCINFO")).toContain(`for ${engines} database engines`);
  });
});

/** The part of `database-compose.yml` the fixture tables are held to. */
interface ComposeService {
  readonly ports?: readonly string[];
  readonly profiles?: readonly string[];
  readonly restart?: string;
}
const COMPOSE = parseYaml(read("database-compose.yml"), { merge: true }) as {
  readonly services: Readonly<Record<string, ComposeService>>;
};

/** The host port compose publishes for `service`, from `127.0.0.1:<host>:<container>`. */
function hostPort(service: string): string {
  const published = COMPOSE.services[service]?.ports?.[0];
  if (published === undefined) throw new Error(`database-compose.yml publishes no port for ${service}`);
  return published.split(":").at(-2) ?? "";
}

/** The six S3 fixture targets, by the name the fixture tables give each. */
const S3_FIXTURES: ReadonlyArray<{ readonly name: string; readonly service: string }> = [
  { name: "MinIO", service: "minio" },
  { name: "MinIO with a site region", service: "minio-region" },
  { name: "Silo", service: "silo" },
  { name: "Silo over TLS", service: "silo-tls" },
  { name: "Garage", service: "garage" },
  { name: "RustFS", service: "rustfs" },
];

/** A README fixture row's first cell: the bold engine name, the target, and its compose profile when it has one. */
function fixtureCell(fixture: (typeof S3_FIXTURES)[number]): string {
  const profile = COMPOSE.services[fixture.service]?.profiles?.[0];
  return `**S3-compatible object storage**, ${fixture.name}${profile === undefined ? "" : ` (profile \`${profile}\`)`}`;
}

/** The README line inserted above Databend's, exactly. */
const README_S3_LINE =
  "S3-compatible object storage is the newest: AWS CLI read commands typed in the editor, such as `aws s3api list-buckets`, `aws s3 ls`, `aws s3api head-object` and `aws s3api list-object-versions`, and Studio's own `preview` read buckets and objects over the S3 REST API with no SDK, signed by Studio's own code with only the keys typed into the connection; the tree shows buckets, the Keys panel walks folders one level at a time, and an object opens with its metadata and a capped preview of text, JSON, CSV or Parquet, read-only by construction, because Studio sends only GET and HEAD requests; it is verified on MinIO, Silo, Garage and RustFS, and not on AWS S3 or any hosted service.";

/** The README engine-table row, exactly. */
const README_S3_ROW =
  "| **S3-compatible object storage** | none, HTTP (the S3 REST API, path style, signed by Studio's own SigV4 code; `hyparquet` for Parquet previews) | Read-only AWS CLI read commands such as `aws s3api list-buckets`, `aws s3 ls`, `aws s3api head-object` and `aws s3api list-object-versions`, plus Studio's own `preview`; buckets in the tree and folders in the Keys panel, one level at a time; an object's metadata and a capped preview of text, JSON, NDJSON, CSV, TSV and Parquet, hex for anything else. Only the keys typed into the connection sign, never the server's own AWS identity, and the link-local networks, where AWS, Azure and Google Cloud serve instance metadata, are always refused, as is AWS's IPv6 metadata address. Verified on MinIO, Silo, Garage and RustFS; AWS S3 and hosted services are not verified |";

describe("README.md and its translations", () => {
  const readme = read("README.md");
  const engines = EXTERNAL_DATABASE_TYPES.length;

  test("45. each README numeral counts its own denominator", () => {
    expect(readme).toContain(`${Word(engines)} engines share one interface:`);
    expect(readme).toContain(`Three of the ${word(engines)} are read-only because their own SQL is`);
    expect(readme).toContain(`- **${Word(engines)} engines, one interface**:`);
    expect(readme).toContain(`> **${Word(WIRE_COMPATIBLE_ENGINES.length)} more engines have no driver of their own.**`);
    expect(readme).toContain(`The ${word(engines)} above are the drivers this build ships.`);
    expect(readme).toContain(
      `so ${word(engines)} drivers reach ${word(connectableProductCount())} named engines in all.`,
    );
  });

  test("46. the S3 line and row are word for word, and the row's networks are LINK_LOCAL_NETWORKS", () => {
    expect(readme).toContain(`${README_S3_LINE}\nDatabend came before S3-compatible object storage:`);
    const lines = readme.split("\n");
    const oxia = lines.findIndex((line) => line.startsWith("| **Oxia** | `@grpc/grpc-js`"));
    expect(lines[oxia + 1]).toBe(README_S3_ROW);
    // The row names the networks in words: "the link-local networks" are 169.254.0.0/16 with its NAT64 form and
    // fe80::/10, and "AWS's IPv6 metadata address" is fd00:ec2::254. A network added to LINK_LOCAL_NETWORKS fails
    // here until the row's words are re-read against it.
    expect([...networkWords()].sort()).toEqual(["169.254.0.0/16", "NAT64", "fd00:ec2::254", "fe80::/10"].sort());
  });

  test("47. every S3 fixture row names the port compose publishes", () => {
    for (const file of ["README.md", "README_zh.md"]) {
      const lines = read(file).split("\n");
      for (const fixture of S3_FIXTURES) {
        const row = lines.find((line) => line.startsWith(`| ${fixtureCell(fixture)} |`));
        expect(row, `${file} ${fixture.service}`).toBeDefined();
        expect(row?.split(" | ")[2], `${file} ${fixture.service}`).toBe(hostPort(fixture.service));
      }
    }
  });

  test("48. every translation carries the S3 row under the same bold name", () => {
    for (const file of [
      "README_zh.md",
      "README_ja.md",
      "README_es.md",
      "README_ur.md",
      "README_hi.md",
      "README_pt.md",
      "README_ru.md",
      "README_ko.md",
    ]) {
      const rows = read(file)
        .split("\n")
        .filter((line) => line.startsWith("| **S3-compatible object storage** |"));
      expect(rows, file).toHaveLength(1);
    }
  });
});

describe("DOCKERHUB.md", () => {
  test("49. the S3 row, the numerals and the read-only sentence", () => {
    const hub = read("DOCKERHUB.md");
    const lines = hub.split("\n");
    const oxia = lines.findIndex((line) => line.startsWith("| **Oxia** |"));
    expect(lines[oxia + 1]).toBe(
      "| **S3-compatible object storage** | none, HTTP | Read-only AWS CLI commands, bucket and folder browser, object preview |",
    );
    expect(hub).toContain("Qdrant, Oxia and S3-compatible object storage** from your browser");
    expect(hub).toContain(`${Word(EXTERNAL_DATABASE_TYPES.length)} external engines share one interface.`);
    // The ordinal counts the table's rows: every external engine, then the embedded store.
    expect(SHIPPED_DATABASE_TYPES).toHaveLength(EXTERNAL_DATABASE_TYPES.length + 1);
    expect(hub).toContain(
      `The ${word(SHIPPED_DATABASE_TYPES.length).replace(/-nine$/, "-ninth")} row is the embedded LibreDB store`,
    );
    expect(hub).toContain(
      "Prometheus, InfluxDB, Apache Kafka, Oxia and S3-compatible object storage are read-only too",
    );
    expect(hub).toContain(`of one of the ${word(EXTERNAL_DATABASE_TYPES.length)} drivers above`);
  });
});

/** The chart description, exactly. */
const CHART_DESCRIPTION =
  "Web-based SQL IDE for cloud-native teams supporting twenty-eight engines - PostgreSQL, MySQL, SQLite, DuckDB, Oracle, Db2 LUW, SQL Server, MongoDB, Redis, Couchbase, ClickHouse, Apache Druid, Elasticsearch, OpenSearch, Trino, Apache Cassandra, libSQL, Prometheus, Apache Kafka, etcd, Neo4j, Milvus, Qdrant, InfluxDB, InfluxDB 3, Oxia, Databend and S3-compatible object storage";

describe("the chart and the operator name S3 where an evaluator searches", () => {
  test("50. the description, the three keywords, the mirror and both CSV descriptions", () => {
    const chart = parseYaml(read("charts/libredb-studio/Chart.yaml")) as {
      readonly description: string;
      readonly version: string;
      readonly keywords: readonly string[];
    };
    expect(chart.description).toBe(CHART_DESCRIPTION);
    expect(chart.description).toContain(` ${word(EXTERNAL_DATABASE_TYPES.length)} engines - `);
    const databend = chart.keywords.indexOf("databend");
    expect(chart.keywords.slice(databend + 1, databend + 4)).toEqual(["s3", "object-storage", "minio"]);
    const readme = read("charts/libredb-studio/README.md");
    expect(readme).toContain(`supporting ${word(EXTERNAL_DATABASE_TYPES.length)} engines - `);
    expect(readme).toContain("InfluxDB 3, Oxia, Databend and S3-compatible object storage.");
    expect(readme).toContain(`--version ${chart.version} \\`);
    expect(read("operator/helm-charts/libredb-studio/Chart.yaml")).toBe(read("charts/libredb-studio/Chart.yaml"));
    const csv = parseYaml(
      read("operator/config/manifests/bases/libredb-studio-operator.clusterserviceversion.yaml"),
    ) as {
      readonly metadata: { readonly annotations: { readonly description: string } };
      readonly spec: { readonly description: string };
    };
    expect(csv.metadata.annotations.description).toContain(`for ${word(EXTERNAL_DATABASE_TYPES.length)} engines - `);
    expect(csv.metadata.annotations.description).toContain(
      "Oxia, Databend and S3-compatible object storage - with AI-powered query assistance.",
    );
    expect(flat(csv.spec.description)).toContain("Oxia, Databend and S3-compatible object storage from the browser");
  });
});

/** The FEATURES group, exactly. */
const FEATURES_GROUP = [
  "*   **Object Storage:**",
  "    *   **S3-compatible object storage:** Read-only over the S3 REST API with **no SDK and no driver**: Studio's own SigV4 code signs each request with the access key pair typed into the connection, never with the server's environment, shared credential files or instance role, and an empty pair sends unsigned requests.",
  "        AWS CLI read commands in the editor, such as `aws s3api list-buckets`, `aws s3 ls`, `aws s3api head-object` and `aws s3api list-object-versions`, plus Studio's own `preview`; buckets in the tree, or the one bucket the connection names; folders and objects in the Keys panel, one folder level at a time with a Load more per level.",
  "        An object opens with its metadata and a capped preview of text, JSON, NDJSON, CSV, TSV and Parquet (through `hyparquet`, with Snappy, gzip, zstd, brotli and LZ4 pages), and a hex dump for anything else.",
  "        Path-style addressing only, a Region field that defaults to `us-east-1`, and link-local addresses (169.254.0.0/16 and fe80::/10) and AWS's IPv6 metadata address refused whatever the egress setting.",
  "        Verified on MinIO, Silo, Garage and RustFS ([providers/s3.md](./providers/s3.md)); AWS S3 and hosted services are not verified.",
].join("\n");

/** BRAND_MESSAGING rule 9, exactly. */
const BRAND_RULE_9 =
  '9. **Studio\'s S3 provider is read-only object browsing on S3-compatible servers, verified on four of them.** Write "S3-compatible object storage", never "S3" alone as a supported product, and never "AWS S3" or "Amazon S3" as one, because Studio was verified on MinIO, Silo, Garage and RustFS and not on AWS S3 or any hosted service. Never write that Studio queries files in a bucket with SQL; it previews them.';

describe("FEATURES, BRAND_MESSAGING and API_DOCS", () => {
  const engines = EXTERNAL_DATABASE_TYPES.length;

  test("51. FEATURES has the Object Storage group in its place, naming the networks of LINK_LOCAL_NETWORKS", () => {
    const features = read("docs/FEATURES.md");
    expect(features).toContain(FEATURES_GROUP);
    expect(features.indexOf("*   **Vector Databases:**")).toBeLessThan(features.indexOf("*   **Object Storage:**"));
    expect(features.indexOf("*   **Object Storage:**")).toBeLessThan(features.indexOf("*   **Embedded Stores:**"));
    // The group names the two link-local CIDRs and AWS's IPv6 metadata address in words; the NAT64 entry is a form
    // of 169.254.0.0/16. A network added to LINK_LOCAL_NETWORKS fails case 46 until this group is re-read too.
    for (const words of networkWords().filter((words) => words !== "NAT64")) {
      expect(FEATURES_GROUP, words).toContain(words === "fd00:ec2::254" ? "AWS's IPv6 metadata address" : words);
    }
    expect(flat(features)).toContain(
      "Milvus, Qdrant, Oxia and S3-compatible object storage have no count grammar here",
    );
  });

  test("52. BRAND_MESSAGING counts the external engines and carries rule 9", () => {
    const brand = read("docs/BRAND_MESSAGING.md");
    expect(brand).toContain(`2. One tab, ${word(engines)} engines.`);
    expect(brand).toContain(`### Door 2: One tab, ${word(engines)} engines.`);
    expect(brand).toContain(`- **Promise:** ${word(engines)} engines in one interface`);
    expect(brand).toContain(`- **Proof:** ${word(engines)} providers, each with its own reference document`);
    expect(brand).toContain(`| ${Word(engines)} database engines | One reference document per engine:`);
    expect(brand).toContain(
      "Qdrant, Oxia, S3-compatible object storage. A twenty-ninth, `libredb.md`, is the embedded provider",
    );
    expect(brand).toContain(`against ${word(engines)} here.`);
    expect(brand).toContain(`"${Word(engines)} engines" beats "extensive database support".`);
    expect(brand).toContain(`against ${word(engines)} shipped.`);
    expect(brand).not.toContain("twenty-seven");
    const rules = brand.split("\n");
    const rule8 = rules.findIndex((line) => line.startsWith("8. **AI is not described as magic.**"));
    expect(rules[rule8 + 1]).toBe(BRAND_RULE_9);
  });

  test("53. API_DOCS names S3 where it lists engines and states S3's declarations", () => {
    const api = read("docs/API_DOCS.md");
    const capabilities = provider.getCapabilities();
    const keyScan = capabilities.keyScan;
    expect(api).toContain("Milvus, Qdrant, Oxia, Databend and S3-compatible object storage.");
    expect(api).toMatch(
      new RegExp(
        `- \\*\\*Multi-Database Support\\*\\* - ${Word(engines)} engines: .*, Databend, S3-compatible object storage$`,
        "m",
      ),
    );
    expect(capabilities.supportsResultPagination).toBe(false);
    expect(api).toContain("Milvus, Qdrant, Oxia and S3-compatible object storage ignore it.");
    expect(capabilities.containerLevels).toEqual([]);
    expect(api).toContain(
      "etcd, Oxia and S3-compatible object storage declare the walk and no container level, because one connection is one key space (one etcd cluster, one Oxia namespace, one S3 endpoint), so they refuse the field as well.",
    );
    expect(api).toContain(
      "| The provider declares `keyScan` and no container level (etcd, Oxia, S3-compatible object storage) | `400` |",
    );
    expect(consoleTextByteLimit("s3")).toBe(S3_MAX_TEXT_BYTES);
    expect(api).toContain(
      `InfluxDB (InfluxQL), Oxia and S3-compatible object storage one of ${n(S3_MAX_TEXT_BYTES)} bytes each`,
    );
    expect(api).toContain(
      `S3-compatible object storage declares \`{ "defaultCount": ${keyScan?.defaultCount}, "maxCount": ${keyScan?.maxCount} }\` ([providers/s3.md](./providers/s3.md), section 6.4).`,
    );
    expect(api).toContain(
      `S3-compatible object storage declares \`"${keyScan?.separator}"\`, \`"${keyScan?.cursor}"\`, \`"${keyScan?.pattern}"\` and \`"${keyScan?.totalScope}"\` too, with \`levels.rootKind\` \`"${keyScan?.levels?.rootKind}"\`: one folder level at a time, a cursor only it can read, a literal prefix, and no count.`,
    );
    expect(api).toContain("Cassandra: the KEYSPACE; S3: the optional pinned bucket)");
    const union = /^type DatabaseType = (.+);$/m.exec(api)?.[1] ?? "";
    expect(
      union
        .split(" | ")
        .map((member) => member.replace(/'/g, ""))
        .sort(),
    ).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });
});

/** The SEED_CONNECTIONS `connections[].region` row, exactly. */
const SEED_REGION_ROW =
  "| `connections[].region` | No | absent | S3-compatible object storage only: the region every request is signed for; absent means `us-east-1`. Garage refuses any region but its s3_region; a MinIO or Silo started with a site region refuses bucket and object reads signed for another ([providers/s3.md](providers/s3.md)). A `${ENV}` or `${vault:...}` reference is resolved, as in `host`. A region name, neither a credential nor an address; not a secret |";

describe("docs/SEED_CONNECTIONS.md and the seed schema agree on s3", () => {
  const seed = read("docs/SEED_CONNECTIONS.md");

  test("54. every place that lists the types or the fields names s3 and region", () => {
    expect(seed).toContain("|influxdb|influxdb3|oxia|databend|s3\n");
    expect(seed).toContain("`oxia`, `databend`, `s3` |");
    expect(rowOf(seed, "`connections[].region`")).toBe(SEED_REGION_ROW);
    expect(rowOf(seed, "`connections[].database`")).toContain("S3: the optional pinned bucket");
    expect(rowOf(seed, "`connections[].user`")).toContain("S3: the access key ID");
    expect(rowOf(seed, "`connections[].password`")).toContain("S3: the secret access key");
    expect(rowOf(seed, "`connections[].readOnly`")).toContain(
      "InfluxDB 3 (SQL), Oxia and S3-compatible object storage)",
    );
    expect(seed).toContain("both InfluxDB types', Oxia's and S3's do today");
    expect(rowOf(seed, "`connections[].mcp`")).toContain(
      "An etcd, Oxia or S3 connection refuses `mcp: true` when the file loads",
    );
    expect(seed).toContain(
      "| `mcp: true` on an etcd, Oxia or S3 connection | The whole file fails like any invalid config, and the error names `mcp` and the type, `etcd`, `oxia` or `s3` |",
    );
    expect(seed.split("`dataServers`, `warehouse`, `region`, `apiKeyId`")).toHaveLength(3);
  });

  test("55. a seed written from the s3 rows loads and resolves, and mcp: true on it is refused", () => {
    const connection = {
      id: "s3-doc",
      name: "S3 doc",
      type: "s3",
      host: "localhost",
      port: 9000,
      user: "studio-browse",
      password: "${S3_DOC_SECRET}",
      database: "studio-demo",
      region: "${S3_DOC_REGION}",
      allowInsecureAuth: false,
      roles: ["user"],
      managed: true,
      readOnly: true,
    };
    const parsed = SeedConfigSchema.safeParse({ version: "1", connections: [connection] });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    process.env.S3_DOC_SECRET = "doc-test-secret";
    process.env.S3_DOC_REGION = "eu-central-1";
    try {
      const [loaded] = parsed.data?.connections ?? [];
      const resolved = resolveConnectionCredentials(loaded);
      expect(resolved.region).toBe("eu-central-1");
      expect(resolved.database).toBe("studio-demo");
    } finally {
      delete process.env.S3_DOC_SECRET;
      delete process.env.S3_DOC_REGION;
    }
    const refused = SeedConfigSchema.safeParse({ version: "1", connections: [{ ...connection, mcp: true }] });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.message)).toContain(
      "mcp is not offered for s3: the product does not expose this engine to MCP clients. Remove mcp from this connection.",
    );
  });
});

/** The providers index row, exactly. */
const PROVIDERS_INDEX_ROW =
  "| S3-compatible object storage | `s3` | Object storage | none, REST over the shared `node:http(s)` transport, signed by Studio's own SigV4 code; `hyparquet` for Parquet previews | AWS CLI read commands (a subset, read-only) | [s3.md](./s3.md) |";

describe("docs/providers/README.md", () => {
  test("56. the index row, the directory note and every fixture row match the code and the compose file", () => {
    const index = read("docs/providers/README.md");
    const lines = index.split("\n");
    const influxdb3 = lines.findIndex((line) => line.startsWith("| InfluxDB 3 (SQL) | `influxdb3` |"));
    expect(lines[influxdb3 + 1]).toBe(PROVIDERS_INDEX_ROW);
    expect(lines[influxdb3 + 2].startsWith("| LibreDB | `libredb` |")).toBe(true);
    expect(index).toContain("Qdrant, InfluxDB, Oxia, Databend and S3 are)");
    for (const fixture of S3_FIXTURES) {
      const row = lines.find((line) =>
        line.startsWith(`| S3-compatible object storage, ${fixture.name} | \`${fixture.service}\` |`),
      );
      expect(row, fixture.service).toBeDefined();
      const cells = row?.split(" | ") ?? [];
      expect(cells[3], fixture.service).toBe(hostPort(fixture.service));
      const profile = COMPOSE.services[fixture.service]?.profiles?.[0];
      expect(cells.at(-1), fixture.service).toBe(profile === undefined ? "*none* |" : `\`${profile}\` |`);
    }
    const paragraph = flat(index.slice(index.indexOf("**S3-compatible object storage has six fixtures")));
    for (const fixture of S3_FIXTURES) expect(paragraph, fixture.service).toContain(`\`${fixture.service}\``);
    expect(paragraph).toContain("](../../docker/s3/README.md)");
    // A plain `up` starts every service with no profile; the one-shots are the ones that never restart.
    const alwaysOn = Object.entries(COMPOSE.services).filter(([, service]) => service.profiles === undefined);
    const oneShots = alwaysOn.filter(([, service]) => service.restart === "no").map(([name]) => name);
    const services = flat(index);
    expect(services).toContain(`Start the ${word(alwaysOn.length)} always-on services with a plain`);
    expect(services).toContain(`${word(alwaysOn.length - oneShots.length)} engine containers plus the one-shot`);
    const sidecars = lines.find((line) => line.includes("engine containers plus the one-shot")) ?? "";
    for (const name of oneShots) expect(sidecars, name).toContain(`\`${name}\``);
  });
});

describe("the architecture, provider, editor and guide docs", () => {
  const ids = SHIPPED_DATABASE_TYPES.length;

  test("57. CLAUDE.md, ARCHITECTURE and DATABASE_PROVIDERS count the ids and draw S3", () => {
    const claude = read("CLAUDE.md");
    expect(claude).toContain(
      `${word(EXTERNAL_DATABASE_TYPES.length)} external engines, plus the embedded LibreDB store`,
    );
    expect(claude).toContain("`oxia`, `milvus`, `qdrant`, `s3`, `libredb`) extend `BaseDatabaseProvider` directly");
    const architecture = read("docs/ARCHITECTURE.md");
    expect(architecture).toContain(`It supports **${ids} database backends**`);
    expect(architecture).toContain("Milvus, Qdrant, Oxia, S3-compatible object storage, LibreDB.");
    expect(architecture).toContain("        DBFactory --> ObjectStore[Object Storage Providers]");
    expect(architecture).toContain("        ObjectStore --> S3[(S3-compatible object storage)]");
    expect(architecture).toContain("    BaseDatabaseProvider <|-- S3Provider");
    expect(architecture).toContain("│   │   ├── objectstore/ # s3/");
    expect(architecture).toContain("the LibreDB, Redis, etcd, Oxia and S3 command languages");
    const providers = read("docs/DATABASE_PROVIDERS.md");
    // Two pairs of type-ids share one module each: elasticsearch and opensearch, influxdb and influxdb3.
    expect(providers).toContain(`${Word(ids)} type-ids are supported by ${word(ids - 2)} provider modules:`);
    expect(providers).toContain("│   ├── objectstore/            # Object Storage Providers");
    expect(providers).toContain(
      "├── S3Provider ─────────────────────────────┤ Object storage (AWS CLI read commands over the S3 REST API, read-only)",
    );
    expect(providers).toContain(
      "| S3-compatible object storage | `s3` | Object storage (AWS CLI read commands over the S3 REST API, read-only) | [providers/s3.md](./providers/s3.md) |",
    );
    expect(providers).toContain(
      "- **S3-compatible object storage** (one AWS CLI read command, or Studio's own `preview`): [providers/s3.md](./providers/s3.md).",
    );
    expect(flat(providers)).toContain("Qdrant, Oxia, Databend, S3-compatible object storage, or LibreDB.");
  });

  test("58. the editor and schema-diff docs name the S3 module, the non-SQL count and the pagination count", () => {
    expect(read("docs/editor/README.md")).toContain(
      "`src/lib/editor/oxia-language.ts`, `src/lib/editor/s3-language.ts` |",
    );
    const nonSql = SHIPPED_DATABASE_TYPES.filter((type) => !readsSqlText(type)).length;
    const optimization = read("docs/editor/query-optimization.md");
    expect(optimization).toContain(
      `Qdrant, Oxia and S3-compatible object storage are the ${word(nonSql)} types whose query text is not SQL at all**`,
    );
    expect(optimization).toContain(`holds exactly those ${word(nonSql)},`);
    expect(provider.getCapabilities().supportsResultPagination).toBe(false);
    expect(optimization).toContain("Fourteen providers cannot serve page two.");
    expect(optimization).toContain("Qdrant, Oxia and S3-compatible object storage answer it with page one.");
    expect(optimization).toContain("The S3 row names no operation and, like the Oxia row, is the gate's whole answer:");
    expect(optimization).toContain(
      "a Qdrant request, an `oxia client` read command or an AWS CLI read command is not judged by a SQL reader",
    );
    expect(flat(read("docs/SCHEMA_DIFF.md"))).toContain(
      "Qdrant, Oxia and S3-compatible object storage receive an explanatory",
    );
  });

  test("59. ADDING_A_PROVIDER records what S3 shows about auth and dependencies", () => {
    const guide = read("docs/ADDING_A_PROVIDER.md");
    expect(guide).toContain(
      "S3 shows it need not: its SigV4 is Studio's own `node:crypto` code, tested on the AWS suite vectors |",
    );
    expect(guide).toContain(
      "      `s3` needs no driver but adds the Parquet decoders `hyparquet` and `hyparquet-compressors`, with their `//dependencies` note.",
    );
    expect(guide).toContain(
      "      each add nothing here (`milvus` and `oxia` only extend the `//dependencies` note).\n      `s3` needs no driver",
    );
    expect(guide).toContain(
      "is a library, and that is usually where the no-dependency promise ends. S3 shows it need not",
    );
    // The thirteen HTTP-only and built-in ids the paragraph names, plus s3, which reaches its server over node:https.
    expect(flat(guide)).toContain("Fourteen shipped type-ids need no driver:");
    expect(flat(guide)).toContain(
      "and S3-compatible object storage over the S3 REST API, signed by Studio's own SigV4 code ([s3.md](./providers/s3.md)).",
    );
  });
});

/** The installed manifest of `name`: hoisted, or nested under hyparquet-compressors. */
function installed(name: string): { readonly version: string; readonly license: string } {
  for (const at of [
    `node_modules/${name}/package.json`,
    `node_modules/hyparquet-compressors/node_modules/${name}/package.json`,
  ]) {
    if (existsSync(path.join(ROOT, at))) return JSON.parse(read(at)) as { version: string; license: string };
  }
  throw new Error(`${name} is not installed`);
}

describe("docs/THIRD_PARTY_LICENSES.md", () => {
  test("60. the four Parquet packages are recorded at the versions and licences installed", () => {
    const licenses = read("docs/THIRD_PARTY_LICENSES.md");
    const manifest = JSON.parse(read("package.json")) as { readonly dependencies: Readonly<Record<string, string>> };
    // The preview imports fzstd itself only when it loads the codecs by path, and then package.json pins it.
    const codecsByPath = "fzstd" in manifest.dependencies;
    const direct = codecsByPath
      ? ["hyparquet", "hyparquet-compressors", "fzstd"]
      : ["hyparquet", "hyparquet-compressors"];
    for (const name of direct) {
      expect(manifest.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(installed(name).version, name).toBe(manifest.dependencies[name]);
    }
    for (const [name, reached] of [
      ["hyparquet", "direct dependency"],
      ["hyparquet-compressors", "direct dependency"],
      [
        "fzstd",
        codecsByPath ? "direct dependency (the preview imports it directly)" : "dependency of `hyparquet-compressors`",
      ],
      ["hysnappy", "dependency of `hyparquet-compressors`"],
    ] as const) {
      const row = licenses.split("\n").find((line) => line.startsWith(`| [\`${name}\`](`));
      expect(row, name).toBeDefined();
      const cells = row?.split(" | ") ?? [];
      expect(cells[1], name).toBe(installed(name).version);
      expect(cells[2]?.startsWith(installed(name).license), name).toBe(true);
      expect(cells[3], name).toContain(reached);
    }
    expect(licenses).toContain(
      codecsByPath
        ? "Only `src/lib/db/providers/objectstore/s3/preview-parquet.ts` loads three of them, through a dynamic import"
        : "Only `src/lib/db/providers/objectstore/s3/preview-parquet.ts` loads the four, through a dynamic import",
    );
  });
});

/** A capture set's directory name: target, UTC date, then the version the server reported. */
const CAPTURE_SET = /^(minio-region|silo-tls|minio|silo|garage|rustfs)-(\d{4}-\d{2}-\d{2})-(.+)$/;
const VERIFIED_TARGETS = ["minio", "silo", "garage", "rustfs"] as const;
type VerifiedTarget = (typeof VERIFIED_TARGETS)[number];
const SERVER_NAMES: Readonly<Record<VerifiedTarget, string>> = {
  minio: "MinIO",
  silo: "Silo",
  garage: "Garage",
  rustfs: "RustFS",
};

/** The one version each verified target reported in the capture sets; two versions of one target fail. */
function capturedVersions(): Readonly<Record<VerifiedTarget, string>> {
  const found = new Map<string, Set<string>>();
  for (const entry of readdirSync(path.join(ROOT, "tests/fixtures/s3/captures"), { withFileTypes: true })) {
    const match = entry.isDirectory() ? CAPTURE_SET.exec(entry.name) : null;
    if (match === null) continue;
    const versions = found.get(match[1]) ?? new Set<string>();
    versions.add(match[3]);
    found.set(match[1], versions);
  }
  const versions = {} as Record<VerifiedTarget, string>;
  for (const target of VERIFIED_TARGETS) {
    const seen = [...(found.get(target) ?? [])];
    expect(seen, `${target} capture sets`).toHaveLength(1);
    versions[target] = seen[0];
  }
  return versions;
}

describe("docs/providers/s3.md: the servers it was verified on", () => {
  test("13. the header names each verified server with the version its capture set recorded", () => {
    const v = capturedVersions();
    expect(DOC).toContain(
      `verified on MinIO ${v.minio}, Silo ${v.silo}, Garage ${v.garage} and RustFS ${v.rustfs}, and not on AWS S3 or any hosted service.`,
    );
  });

  test("14. section 4.8 has one row per verified server, with that version", () => {
    const versions = sectionOf(DOC, "### 4.8 Server versions");
    const v = capturedVersions();
    for (const target of VERIFIED_TARGETS) {
      const row = rowOf(versions, SERVER_NAMES[target]);
      expect(row, target).toBeDefined();
      expect(row, target).toContain(`\`${v[target]}\``);
    }
    expect(versions).toContain("Node 24.14.0 and Bun 1.4.2");
  });
});

describe("the agent docs count the type-ids and name S3 where they list engines", () => {
  const ids = SHIPPED_DATABASE_TYPES.length;
  /** Ids an agent run cannot read through: every id outside AGENT_EXECUTION_ENGINES. */
  const refused = ids - AGENT_EXECUTION_ENGINES.length;
  /** Ids grounded through their own provider: every id but the two CATALOG_PLANS dialects, postgres and sqlite. */
  const provided = ids - 2;
  /** Ids with no statistics this run reads: every id but the three ESTIMATE_BUILDERS serves, postgres, sqlite and mssql. */
  const noStatistics = ids - 3;

  test("61. AGENT.md", () => {
    const agent = read("docs/AGENT.md");
    const prose = flat(agent);
    expect(prose).toContain(`reach the ${word(refused)} the read-only profile refuses`);
    expect(prose).toContain(`including the ${word(refused)} where an agent run cannot read anything at all`);
    expect(prose).toContain(`on the other ${word(noStatistics)} \`readSchemaStatistics\` answers`);
    expect(prose).toContain(`On the other ${word(provided)} it is **one**`);
    expect(prose).toContain(`the other ${word(noStatistics)} hold no statistics this run`);
    expect(prose).toContain(`so all ${word(ids)} ids pass it`);
    expect(prose).toContain(`Collapsing the other ${word(provided)} onto the composed one`);
    expect(agent).toContain(`four of the ${word(ids)}`);
  });

  test("62. AGENT_GUIDE and AGENT_DATA_FLOW", () => {
    const guide = flat(read("docs/AGENT_GUIDE.md"));
    expect(guide).toContain(`which is the other ${word(provided)} (MySQL,`);
    expect(guide).toContain("Qdrant, Oxia, Databend, S3-compatible object storage and the bundled LibreDB store)");
    expect(guide).toContain(`so it reaches all ${word(ids)} engines.`);
    expect(guide).toContain(
      "On S3-compatible object storage that is one AWS CLI read command, or Studio's own `preview`, in a block tagged `s3`, which the run never executes.",
    );
    expect(guide).toContain(`So on the other ${word(refused)} ids in the \`DatabaseType\` union`);
    expect(guide).toContain("Qdrant, Oxia, Databend, S3-compatible object storage and LibreDB. That");
    expect(guide).toContain(`no longer takes this path at all on the other ${word(provided)}:`);
    expect(guide).toContain(`on the other ${word(noStatistics)} the plan is told that this engine holds none`);
    const flow = flat(read("docs/AGENT_DATA_FLOW.md"));
    expect(flow).toContain(`and the other ${word(provided)} by asking the connection's own provider`);
    expect(flow).toContain(
      "Never an etcd, Milvus, Qdrant, InfluxDB (InfluxQL), Oxia or S3-compatible object storage statement",
    );
    expect(flow).toContain("which those six do");
    expect(flow).toContain("and an S3 command names buckets and object keys");
    expect(flow).toContain(
      `a server-side enum with ${word(ids)} members, so what it discloses is which of ${word(ids)} engines this`,
    );
    expect(flow).toContain(`And two of the ${word(provided)}, the embedded`);
    expect(flow).toContain(`On the other ${word(provided)} it invokes \`db.schema.read\``);
    expect(flow).toContain(
      `**${Word(provided)} counts type-ids the factory can build, not engines a user would name**`,
    );
    expect(flow).toContain(`\`SHIPPED\` holds ${word(ids)}, \`CATALOG_PLANS\` serves two of them`);
    expect(flow).toContain(`libSQL is one of the ${word(provided)} and not one of the two`);
    expect(flow).toContain(
      "- On S3-compatible object storage the grounding carries bucket names only, never an object key, a prefix, a size or any object content (objects are listed by the Keys panel, not by the object walk).",
    );
    expect(flow).toContain("On the twenty-one engines that declare no foreign keys at all");
    expect(flow).toContain("Qdrant, Oxia, Databend and S3-compatible object storage) this block carries no relations");
    expect(flow).toContain(`replaces them on the other ${word(provided)}.`);
    expect(flow).toContain(
      "nothing at all for an etcd, Milvus, Qdrant, InfluxDB (InfluxQL), Oxia or S3-compatible object storage statement",
    );
  });
});

describe("the complete engine lists outside the agent docs", () => {
  test("63. every list that names Databend and claims to be complete names S3 too", () => {
    const readme = read("README.md");
    expect(readme).toContain(
      "InfluxDB 3 (SQL), Oxia or S3-compatible object storage with SSL/TLS and SSH Tunnel support",
    );
    expect(readme).toContain("InfluxDB 3 (SQL), Oxia, S3-compatible object storage | Web, Mobile |");
    expect(readme).toContain("InfluxDB 3 (SQL), Oxia, or S3-compatible object storage)");
    const zh = read("README_zh.md");
    expect(zh).toContain("InfluxDB 3 (SQL)、Oxia 或 S3-compatible object storage，支持 SSL/TLS 与 SSH 隧道");
    expect(zh).toContain("InfluxDB 3 (SQL)、Oxia、S3-compatible object storage | Web、移动端 |");
    expect(zh).toContain("InfluxDB 3 (SQL)、Oxia 或 S3-compatible object storage）");
    expect(read("README_ko.md")).toContain("InfluxDB 3 (SQL), Oxia, S3-compatible object storage에 연결할 수 있으며");
    // The seed table's type list is the union's members, so every README that carries it names s3.
    for (const [file, separator] of [
      ["README.md", ", "],
      ["README_zh.md", "、"],
    ] as const) {
      const row = read(file)
        .split("\n")
        .find((line) => line.startsWith("| `connections[].type` |"));
      const listed = (row?.match(/`[a-z0-9]+`/g) ?? []).map((cell) => cell.slice(1, -1)).sort();
      expect(listed, file).toEqual([...SHIPPED_DATABASE_TYPES].sort());
      expect(row, file).toContain(`\`oxia\`${separator}\`s3\`${separator}\`libredb\``);
    }
    expect(read("docs/BRAND_MESSAGING.md")).toContain(
      "Milvus, Qdrant, Oxia and S3-compatible object storage, with SSO and audit",
    );
    expect(read("docs/FEATURES.md")).toContain(
      "Qdrant, Oxia, Databend, S3-compatible object storage and LibreDB show no editing control at all",
    );
    expect(provider.getCapabilities().supportsInlineRowEdit).toBe(false);
    const guide = read("docs/ADDING_A_PROVIDER.md");
    expect(guide).toContain("'oxia' | 'databend' | 's3';");
    expect(guide).toContain("'oxia' | 'databend' | 's3' | 'cockroachdb';");
    expect(guide).toContain("· oxia · databend · s3 · libredb");
  });
});
