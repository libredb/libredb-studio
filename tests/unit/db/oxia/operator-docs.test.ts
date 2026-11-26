/**
 * What the operator-facing files say about Oxia: the read-only seed fixture, the `dataServers` row of
 * `docs/SEED_CONNECTIONS.md`, and the control rows 3.8, 3.14 and 3.15 and the Known limits of `docs/SECURITY.md`.
 */
import { statementLanguageFamilyDirectory } from "../../../helpers/statement-language-family";
import { SeedConfigSchema } from "@/lib/seed/types";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const PROVIDER_DIRECTORY = "src/lib/db/providers/keyvalue/oxia";
/** The oxiacli statement language's core family module, whose modules the control rows name by repository path. */
const FAMILY_DIRECTORY = statementLanguageFamilyDirectory("oxiacli");
/**
 * Prose is one sentence per line, so a sentence that spans lines is compared with its line breaks read as spaces.
 * A placeholder outside a code span is written `\<n\>`, since a bare `<n>` is an HTML tag a renderer hides, and is
 * compared as the sentence writes it.
 */
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
const SECURITY = read("docs/SECURITY.md");
const SEED_FIXTURE = "tests/fixtures/seed-connections/oxia-read-only-config.yaml";
/** One row of the SECURITY control table, split into its five cells. */
interface ControlRow {
  readonly control: string;
  readonly status: string;
  readonly enforcedIn: readonly string[];
  readonly verifiedBy: readonly string[];
}
/** The repository paths a cell links, read from its `](../path)` targets. */
const linkedPaths = (cell: string): string[] => [...cell.matchAll(/\]\(\.\.\/([^)]+)\)/g)].map((match) => match[1]);
/** The control table row of `id`, or a failure naming the missing id. */
function controlRow(id: string): ControlRow {
  const line = rowOf(SECURITY, id);
  if (line === undefined) throw new Error(`docs/SECURITY.md has no row ${id}`);
  const cells = line.slice(2, -2).split(" | ");
  expect(cells, id).toHaveLength(5);
  return { control: cells[1], status: cells[2], enforcedIn: linkedPaths(cells[3]), verifiedBy: linkedPaths(cells[4]) };
}
/** The bullet of the Known limits section that begins with `lead`, up to the next bullet, as one line. */
function knownLimit(lead: string): string {
  const limits = sectionOf(SECURITY, "## Known limits");
  const start = limits.indexOf(`- ${lead}`);
  if (start < 0) throw new Error(`no Known limits bullet ${lead}`);
  const end = limits.indexOf("\n- ", start + 1);
  return flat(limits.slice(start, end < 0 ? limits.length : end));
}
/** The SB3-4.2 Control text of row 3.14. */
const CONTROL_3_14 =
  "On an Oxia connection, a shard leader is dialled only when its advertised address is byte-equal to the address the connection's bootstrap call was sent to, or is an exact entry of the connection's Data servers; every call's authority is the dialled host and port; every listed leader gets the connection's TLS mode, CA and client pair with its own host as TLS identity, and the plaintext-token refusal; a leader that fails the policy fails the operation before any call on it, and the token is never sent to it";
/** The SB3-4.2 Control text of row 3.15. */
const CONTROL_3_15 =
  "On an Oxia connection, the client can call only `GetShardAssignments`, `Read`, `List`, `RangeScan` and the health check, every key under `__oxia/` is refused before any call, internal keys are never requested, and the admin port is never dialled";

describe("the seed fixture, SEED_CONNECTIONS.md and SECURITY.md on Oxia", () => {
  test("the read-only seed fixture loads, and the same seed with mcp is refused", () => {
    const file = parseYaml(read(SEED_FIXTURE)) as { connections: Record<string, unknown>[] };
    const parsed = SeedConfigSchema.safeParse(file);
    expect(parsed.success).toBe(true);
    const connections = parsed.data?.connections ?? [];
    expect(connections).toHaveLength(1);
    const [connection] = connections;
    expect(connection).toMatchObject({ type: "oxia", readOnly: true, host: "localhost", port: 6648 });
    expect(connection.password).toBeUndefined();
    expect(connection.dataServers).toBeUndefined();
    const withMcp = { ...file, connections: [{ ...file.connections[0], mcp: true }] };
    const refused = SeedConfigSchema.safeParse(withMcp);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.message)).toContain(
      "mcp is not offered for oxia: the product does not expose this engine to MCP clients. Remove mcp from this connection.",
    );
  });

  test("SEED_CONNECTIONS.md has the dataServers row", () => {
    const row = rowOf(read("docs/SEED_CONNECTIONS.md"), "`connections[].dataServers`");
    expect(row).toBeDefined();
    for (const words of ["Oxia only", "resolved", "Not a secret"]) expect(row).toContain(words);
  });

  test("SECURITY.md rows 3.14 and 3.15 are Oxia's leader and call controls, with their files", () => {
    const expected = [
      {
        id: "3.14",
        control: CONTROL_3_14,
        enforcedIn: [
          `${PROVIDER_DIRECTORY}/connection-options.ts`,
          `${PROVIDER_DIRECTORY}/grpc-client.ts`,
          "src/lib/db/grpc/credentials.ts",
        ],
        verifiedBy: [
          "tests/unit/db/oxia/connection-options.test.ts",
          "tests/unit/db/oxia/grpc-client.test.ts",
          "tests/unit/db/oxia/cluster-policy.test.ts",
        ],
      },
      {
        id: "3.15",
        control: CONTROL_3_15,
        enforcedIn: [
          `${PROVIDER_DIRECTORY}/grpc-client.ts`,
          `${FAMILY_DIRECTORY}/commands.ts`,
          `${FAMILY_DIRECTORY}/guard.ts`,
        ],
        verifiedBy: [
          "tests/unit/db/oxia/seam-guard.test.ts",
          "tests/unit/db/oxia/grpc-client.test.ts",
          "tests/unit/db/oxia/guard.test.ts",
        ],
      },
    ];
    for (const row of expected) {
      const actual = controlRow(row.id);
      expect(actual.control).toBe(row.control);
      expect(actual.status).toBe("Implemented");
      expect(actual.enforcedIn).toEqual(row.enforcedIn);
      expect(actual.verifiedBy).toEqual(row.verifiedBy);
      for (const file of [...actual.enforcedIn, ...actual.verifiedBy])
        expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    }
    expect(rowOf(SECURITY, "3.14")).not.toContain("routing.ts");
  });

  test("SECURITY.md row 3.8 and its note name Oxia", () => {
    const row = controlRow("3.8");
    expect(row.enforcedIn).toContain(`${FAMILY_DIRECTORY}/guard.ts`);
    expect(row.enforcedIn).toContain(`${PROVIDER_DIRECTORY}/grpc-client.ts`);
    expect(row.verifiedBy).toContain("tests/unit/db/oxia/read-only-end-to-end.test.ts");
    const start = SECURITY.indexOf("**3.8.**");
    const note = flat(SECURITY.slice(start, SECURITY.indexOf("\n\n", start)));
    expect(note).toContain(
      "Oxia's names the read-only mode while it holds and says v1 reads only otherwise ([`docs/providers/oxia.md`](./providers/oxia.md) section 3.5).",
    );
  });

  test("SECURITY.md's Known limits give Oxia's two facts", () => {
    expect(knownLimit("**The HTTP destination guard is opt-in and address-based.**")).toContain(
      "Oxia is reached over gRPC, as Milvus is, and is outside this guard: grpc-js resolves names itself, so an address check would be believed and not hold; a pinned gRPC guard is a backlog entry (D212).",
    );
    expect(knownLimit("**Oxia has no authorization.**")).toBe(
      "- **Oxia has no authorization.** A token that authenticates reads and writes every namespace, so Studio's read-only mode is a property of what Studio sends (it has no write call at all, row 3.15), never of the token. A standalone server has no authentication. An advertised leader decides where reads go, which row 3.14 bounds, and a Data servers entry is the operator's statement that the token may go there.",
    );
    expect(knownLimit("**A statement the editor refuses is never sent and never written to history.**")).toContain(
      "The Milvus, Qdrant, Weaviate, InfluxDB (InfluxQL), Oxia, S3, Kubernetes and Firestore rows declare both, and the Redis row declares a refusal and no bound; no other shipped engine declares either.",
    );
  });
});
