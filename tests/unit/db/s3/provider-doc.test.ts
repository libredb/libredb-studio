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
import { MCP_EXPOSABLE, READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
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
import { SeedConfigSchema } from "@/lib/seed/types";
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
