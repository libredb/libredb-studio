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
import { parse as parseYaml } from "yaml";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { connectionFieldHint, DB_UI_CONFIG, hostUriSchemes, offersSshTunnel, readOnlyHint } from "@/lib/db-ui-config";
import { MCP_EXPOSABLE, READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
import { buildS3ConnectionOptions } from "@/lib/db/providers/objectstore/s3/connection-options";
import {
  S3_ACCESS_KEY_ID_MAX_CHARS,
  S3_ACCESS_KEY_ID_MIN_CHARS,
  S3_DEFAULT_PORT,
  S3_DEFAULT_REGION,
} from "@/lib/db/providers/objectstore/s3/constants";
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
