/**
 * What the operator-facing files say about S3: the read-only seed fixture, the S3 control rows, notes and Known limits
 * of `docs/SECURITY.md`, and the s3 rows of `docs/SEED_CONNECTIONS.md`, loaded and resolved as the seed loader does.
 */
import { LINK_LOCAL_NETWORKS } from "@/lib/db/http/egress-policy";
import { resolveConnectionCredentials } from "@/lib/seed/credential-resolver";
import { SeedConfigSchema } from "@/lib/seed/types";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const PROVIDER_DIRECTORY = "src/lib/db/providers/objectstore/s3";
/** Prose is one sentence per line, so a sentence that spans lines is compared with its line breaks read as spaces. */
const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ").replace(/\\([<>])/g, "$1");
/** Whether line `at` of `lines` is inside a fenced block. */
const inFence = (lines: readonly string[], at: number): boolean =>
  lines.slice(0, at).filter((line) => line.startsWith("```")).length % 2 === 1;
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
/** How a prose list names each entry of LINK_LOCAL_NETWORKS: a /128 as the address, the NAT64 range by name. */
function networkWords(): string[] {
  return LINK_LOCAL_NETWORKS.map(([network, prefix]) =>
    prefix === 128 ? network : network.startsWith("64:ff9b:") ? "NAT64" : `${network}/${prefix}`,
  );
}
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
/** The SEED_CONNECTIONS `connections[].region` row, exactly. */
const SEED_REGION_ROW =
  "| `connections[].region` | No | absent | S3-compatible object storage only: the region every request is signed for; absent means `us-east-1`. Garage refuses any region but its s3_region; a MinIO or Silo started with a site region refuses bucket and object reads signed for another ([providers/s3.md](providers/s3.md)). A `${ENV}` or `${vault:...}` reference is resolved, as in `host`. A region name, neither a credential nor an address; not a secret |";

describe("the seed fixture, SECURITY.md and SEED_CONNECTIONS.md on S3", () => {
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
    const refused = SeedConfigSchema.safeParse(withMcp);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.path.at(-1))).toContain("mcp");
  });

  test("SECURITY.md rows 3.18 and 3.19 carry the S3 controls, with files that exist", () => {
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

  test("the key and Parquet clauses name the modules that enforce them and the tests that verify them", () => {
    for (const file of ["names.ts", "encoding.ts"])
      expect(controlRow("3.18").enforcedIn).toContain(`${PROVIDER_DIRECTORY}/${file}`);
    for (const file of ["names", "encoding", "objects"])
      expect(controlRow("3.18").verifiedBy).toContain(`tests/unit/db/s3/${file}.test.ts`);
    for (const file of ["parquet-thrift-guard.ts", "preview-parquet.ts", "preview-cells.ts"])
      expect(controlRow("3.19").enforcedIn).toContain(`${PROVIDER_DIRECTORY}/${file}`);
    for (const file of ["parquet-thrift-guard", "preview-parquet", "preview-cells"])
      expect(controlRow("3.19").verifiedBy).toContain(`tests/unit/db/s3/${file}.test.ts`);
  });

  test("SECURITY.md rows 3.19 and 0.6 name the networks of LINK_LOCAL_NETWORKS", () => {
    for (const words of networkWords()) {
      expect(controlRow("3.19").control, words).toContain(words);
      expect(controlRow("0.6").control, words).toContain(words);
    }
  });

  test("SECURITY.md row 3.8 and its note name S3", () => {
    expect(controlRow("3.8").verifiedBy).toContain("tests/unit/db/s3/read-only-end-to-end.test.ts");
    const start = SECURITY.indexOf("**3.8.**");
    const note = flat(SECURITY.slice(start, SECURITY.indexOf("\n\n", start)));
    expect(note).toContain(
      "S3's runs reads only, so the mode changes nothing a request can do ([`docs/providers/s3.md`](./providers/s3.md) section 3.5).",
    );
  });

  test("SECURITY.md notes 3.18 and 3.19 are word for word", () => {
    expect(SECURITY).toContain(
      [
        "**3.18.** The S3 client is built over a method set of GET and HEAD alone, so no code path in Studio can send a write to an S3 server, whatever the parser or the mode decide.",
        "The console's commands are a closed table, and a command or flag outside it is refused before any request with the sentence its row names.",
        "A key's `.` and `..` segments are resolved with empty segments skipped, the reading with the fewest levels, so a key that stays inside its bucket on a server that keeps empty segments cannot leave it through a proxy that merges slashes; `objectPath` applies the same check to every caller, so a caller that skips the Source tab's check still cannot build such a path.",
        "",
        "**3.19.** An S3 provider that fell back to the server's own credentials would hand every Studio user the server's cloud identity, so Studio has no such fallback: an empty key pair is an unsigned request, never an ambient one.",
        "With the HTTP guard off, an endpoint of `http://169.254.169.254` would put instance metadata one GET away, which is why the byte transport S3 uses refuses the link-local networks and AWS's IPv6 metadata address whether or not the guard is on (row 0.6), before the S3-proving connect probe ever runs, while loopback and private addresses stay usable for local servers.",
        "Elsewhere, the connect probe is what keeps a host that does not speak S3 from having a body read: a connection reads no object until its probe parsed as S3 XML.",
        "A metadata service a cloud serves outside those networks is not refused; none is claimed.",
        "A Parquet footer and its page headers are data the object supplies, so the preview checks them before its decoder reads them: a varint longer than its type allows or a long-form field id outside 1 to 32,767 is refused, so the check and the decoder read the same values, and a size, count or offset that is negative or above 2^53 - 1 is refused, so no value can lower a sum below its cap.",
        "A rendered cell is cut while its string is escaped, never escaped whole and cut afterwards, so a decoded string far past the cell bound costs no more memory than the cell.",
        "",
        "",
      ].join("\n"),
    );
  });

  test("SECURITY.md's Known limits name S3 where they list the engines, and give S3's own limits", () => {
    expect(knownLimit("**The HTTP destination guard is opt-in and address-based.**")).toContain(
      "Qdrant, Weaviate, InfluxDB (InfluxQL), InfluxDB 3 (SQL), S3-compatible object storage and Kubernetes HTTP requests",
    );
    expect(knownLimit("**A statement the editor refuses is never sent and never written to history.**")).toContain(
      "The Milvus, Qdrant, Weaviate, InfluxDB (InfluxQL), Oxia, S3, Kubernetes and Firestore rows declare both, and the Redis row declares a refusal and no bound; no other shipped engine declares either.",
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

  const seed = read("docs/SEED_CONNECTIONS.md");
  test("SEED_CONNECTIONS.md names s3 and region wherever it lists the types or the fields", () => {
    expect(seed).toContain("|influxdb|influxdb3|oxia|databend|s3|kubernetes\n");
    expect(seed).toContain("`oxia`, `databend`, `s3`, `kubernetes` |");
    expect(rowOf(seed, "`connections[].region`")).toBe(SEED_REGION_ROW);
    expect(rowOf(seed, "`connections[].database`")).toContain("S3: the optional pinned bucket");
    expect(rowOf(seed, "`connections[].user`")).toContain("S3: the access key ID");
    expect(rowOf(seed, "`connections[].password`")).toContain("S3: the secret access key");
    // The readOnly row names no engine: it points at the Write reach table, whose S3 row the record holds.
    expect(rowOf(seed, "`connections[].readOnly`")).toContain("[write reach](DATABASE_PROVIDERS.md#write-reach)");
    expect(seed).toContain("both InfluxDB types, Oxia, S3 and Kubernetes keep it (");
    expect(seed.split("`dataServers`, `warehouse`, `region`, `apiPath`, `tlsServerName`, `amqpPort`")).toHaveLength(3);
  });

  test("a seed written from the s3 rows loads and resolves, and mcp: true on it is refused without an agent key", () => {
    const connection = {
      id: "s3-doc",
      name: "S3 seed",
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
    process.env.S3_DOC_SECRET = crypto.randomUUID();
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
      'Seed connection "s3-doc" sets mcp: true on s3 without a read credential of its own (agentUser and agentPassword): MCP reads this engine only under that credential, whose grants are what bound what it reads. Set agentUser and agentPassword to a read credential, or remove mcp from this connection.',
    );
    const agentKey = { agentUser: "studio-agent", agentPassword: "${S3_DOC_AGENT_SECRET}" };
    const opted = SeedConfigSchema.safeParse({
      version: "1",
      connections: [{ ...connection, ...agentKey, mcp: true }],
    });
    expect(opted.success, JSON.stringify(opted.error?.issues)).toBe(true);
  });
});
