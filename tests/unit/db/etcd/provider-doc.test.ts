/**
 * `docs/providers/etcd.md`, `docs/SEED_CONNECTIONS.md` and `docs/SECURITY.md` quote sentences, numbers and a
 * recipe the code owns (#1089), the shape of `tests/unit/db/kafka/provider-doc.test.ts`.
 *
 * A value copied into prose is true only until the code moves, and nothing else goes red when it stops being
 * true. So the read-only refusals are read back from `write-policy.ts`, the marker and the Operations line from
 * the components that draw them, the recipe parsed by the seed schema with `managed: true` required on both of
 * its seeds, the MCP refusal from the seed schema, the dialog's field hints from `DB_UI_CONFIG`, the host
 * refusal from the connection rules, and the value edit's unit and sentences from a build through the real
 * provider. `docs/SECURITY.md`'s read-only control, its note and its three limits are each pinned where they
 * stand, the limits inside the one bullet they qualify.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYAML } from "yaml";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { MCP_EXPOSABLE, READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
import type { EtcdClient } from "@/lib/db/providers/keyvalue/etcd/client";
import { buildEtcdConnectionOptions, ETCD_DEFAULT_PORT } from "@/lib/db/providers/keyvalue/etcd/connection-options";
import { EtcdProvider } from "@/lib/db/providers/keyvalue/etcd/index";
import { readOnlySentence } from "@/lib/db/providers/keyvalue/etcd/write-policy";
import type { ObjectEditBuild } from "@/lib/db/types";
import { SeedConfigSchema } from "@/lib/seed/types";
import type { DatabaseConnection } from "@/lib/types";
import { ETCD_KEY_SCAN } from "@/lib/db/providers/keyvalue/etcd/key-scan";
import { ETCD_READ_BOUNDS } from "@/lib/db/providers/keyvalue/etcd/execute";
import { ETCD_RECEIVE_CAP_BYTES } from "@/lib/db/providers/keyvalue/etcd/connection-options";
import {
  ETCD_GROUP_CAP,
  ETCD_WALK_FIRST_PAGE,
  ETCD_WALK_KEY_CAP,
  ETCD_WALK_SEGMENT_BUDGET,
} from "@/lib/db/providers/keyvalue/etcd/objects";
import { ETCD_TABLE_STATS_CONCURRENCY } from "@/lib/db/providers/keyvalue/etcd/monitoring-reads";
import { ETCD_MAINTENANCE_SPECS } from "@/lib/db/providers/keyvalue/etcd/maintenance";
import { PROTECTED_KEYS, PROTECTED_PREFIXES, SECRET_ROOTS } from "@/lib/db/providers/keyvalue/etcd/keys";
import {
  ETCD_COMMAND_TABLE,
  ETCD_REFUSED_COMMANDS,
  ETCD_REFUSED_GLOBAL_FLAGS,
} from "@/lib/db/providers/keyvalue/etcd/commands";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";

import { PROGRAMME_CONTROL_IDS } from "../../../../scripts/security-check.mjs";
import { createFakeEtcdClient } from "../../../helpers/etcd-fake-client";
import { KEY_SPACE_HEADER } from "../../../helpers/etcd-key-space";
import { EXPECTED_EDITABLE_KINDS } from "../../../helpers/object-edit-expectation";

const ROOT = path.resolve(import.meta.dir, "../../../..");

/** A connection with no credential and no TLS, which etcd's connection rules take as it is (#1089 E1, E2). */
const ETCD: DatabaseConnection = {
  id: "etcd-doc",
  name: "etcd",
  type: "etcd",
  host: "etcd.internal",
  port: 2379,
  createdAt: new Date(0),
};
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const DOC = read("docs/providers/etcd.md");
const SEEDS = read("docs/SEED_CONNECTIONS.md");
const SECURITY = read("docs/SECURITY.md");

/** The section under the heading line `heading`, up to the next heading of its level or above, or undefined. */
function sectionOf(text: string, heading: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) return undefined;
  const level = heading.indexOf(" ");
  const end = lines.findIndex(
    (line, at) => at > start && /^#{1,6} /.test(line) && line.indexOf(" ") <= level && !inFence(lines, at),
  );
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

/** Whether line `at` sits inside a fenced block, where a `#` line is a comment and never a heading. */
function inFence(lines: readonly string[], at: number): boolean {
  return lines.slice(0, at).filter((line) => line.startsWith("```")).length % 2 === 1;
}

/** The table row of `text` whose first cell is exactly `cell`, or undefined. */
const rowOf = (text: string, cell: string): string | undefined =>
  text.split("\n").find((line) => line.startsWith(`| ${cell} |`));

/** The body of the first ```yaml block of `text`, or undefined. */
function yamlBlockOf(text: string): string | undefined {
  const match = /```yaml\n([\s\S]*?)\n```/.exec(text);
  return match?.[1];
}

/** The bullet of `text` that starts with `head`, up to the next top-level bullet or heading, or undefined. */
function bulletOf(text: string, head: string): string | undefined {
  const start = text.indexOf(`\n- ${head}`);
  if (start < 0) return undefined;
  const rest = text.slice(start + 1);
  const end = rest.search(/\n(- |#)/);
  return end < 0 ? rest : rest.slice(0, end);
}

const READ_ONLY = sectionOf(DOC, "### 3.4 The read-only mode (E6)") ?? "";
const MACHINE = sectionOf(DOC, "### 3.5 Machine access (E12)") ?? "";
const FIELDS = sectionOf(DOC, "### 4.1 Configuration fields") ?? "";
const EDIT = sectionOf(DOC, "### 6.3 Object edit (#789)") ?? "";
const RECIPE = sectionOf(SEEDS, "### A read-only cluster for everyone") ?? "";
const ANY_HOST = bulletOf(SECURITY, "**A `user` can connect to any host and port and run any statement.**") ?? "";

describe("the readers find what exists and nothing that does not", () => {
  test("sectionOf, rowOf, yamlBlockOf and bulletOf", () => {
    // Every section this file reads is there and ends before the next one.
    for (const section of [READ_ONLY, MACHINE, FIELDS, EDIT, RECIPE]) expect(section.length).toBeGreaterThan(0);
    expect(READ_ONLY).not.toContain("### 3.5");
    expect(sectionOf(DOC, "### 9.9 No such section")).toBeUndefined();
    // A `#` comment inside a fenced block is no heading: the recipe's block holds none, so a fixture does.
    expect(sectionOf("## A\n```yaml\n# a comment\n```\nafter\n## B", "## A")).toBe(
      "## A\n```yaml\n# a comment\n```\nafter",
    );
    expect(rowOf(FIELDS, "Host")).toBeDefined();
    expect(rowOf(FIELDS, "Database")).toBeUndefined();
    expect(yamlBlockOf("no block")).toBeUndefined();
    expect(ANY_HOST.length).toBeGreaterThan(0);
    expect(bulletOf(SECURITY, "**No such limit.**")).toBeUndefined();
    // The bullet ends where the next one starts.
    expect(ANY_HOST).not.toContain("Env-mode local passwords are not hashed");
  });
});

describe("docs/providers/etcd.md section 3.4 states the read-only mode the provider keeps (E6)", () => {
  test("each refusal is the sentence write-policy.ts gives for where the mode was set", () => {
    expect(rowOf(READ_ONLY, "The operator's seed file")).toBe(
      `| The operator's seed file | ${readOnlySentence("seed")} |`,
    );
    expect(rowOf(READ_ONLY, "A connection of the user's own")).toBe(
      `| A connection of the user's own | ${readOnlySentence("connection")} |`,
    );
    expect(rowOf(READ_ONLY, "An agent execution profile, on a connection that is not read-only")).toBe(
      `| An agent execution profile, on a connection that is not read-only | ${readOnlySentence("execution-profile")} |`,
    );
  });

  test("where a connection's own mode and a profile's both hold, the connection's sentence is the one given", () => {
    expect(READ_ONLY).toContain(
      "Where a connection's own mode and a profile's both hold, the connection's sentence is the one given.",
    );
    const context = { executionReadOnly: true, queryTimeout: 30_000 };
    expect(buildEtcdConnectionOptions({ ...ETCD, readOnly: true }, context).readOnly).toBe("connection");
    expect(buildEtcdConnectionOptions({ ...ETCD, readOnly: true, seedId: "cluster" }, context).readOnly).toBe("seed");
    expect(buildEtcdConnectionOptions(ETCD, context).readOnly).toBe("execution-profile");
  });

  test("the marker's title and the Operations tab's line are the ones the components draw", () => {
    const marker = "Writes, value edits and maintenance are refused on this connection";
    const operations = "This connection is read-only: use a read-write connection for maintenance";
    expect(read("src/components/read-only-marker.tsx")).toContain(`title="${marker}"`);
    expect(read("src/components/admin/tabs/OperationsTab.tsx")).toContain(operations);
    expect(READ_ONLY).toContain(`titled "${marker}"`);
    expect(READ_ONLY).toContain(`shows "${operations}"`);
  });

  test("etcd's provider is one that keeps the mode, and an engine whose provider does not is refused it", () => {
    expect(READ_ONLY_ENFORCED.etcd).toBe(true);
    expect(READ_ONLY_ENFORCED.postgres).toBe(false);
  });
});

/** A recipe block parsed as the seed loader parses a file, or the issues it was refused with. */
function seedFile(block: string | undefined) {
  if (block === undefined) throw new Error("the section holds no ```yaml block");
  return SeedConfigSchema.safeParse(parseYAML(block));
}

describe("the read-only recipe, in the provider doc and in docs/SEED_CONNECTIONS.md (E6)", () => {
  test("the two documents carry the same recipe", () => {
    expect(yamlBlockOf(READ_ONLY)).toBeDefined();
    expect(yamlBlockOf(RECIPE)).toBe(yamlBlockOf(READ_ONLY));
  });

  test("it loads as a seed file, with managed: true on both seeds and readOnly on the one every role reaches", () => {
    const parsed = seedFile(yamlBlockOf(RECIPE));
    expect(parsed.error?.issues ?? []).toEqual([]);
    const [reader, writer] = parsed.data?.connections ?? [];
    expect(parsed.data?.connections).toHaveLength(2);
    expect(reader).toMatchObject({ type: "etcd", roles: ["*"], managed: true, readOnly: true });
    expect(writer).toMatchObject({ type: "etcd", roles: ["admin"], managed: true });
    expect(writer?.readOnly).toBeUndefined();
  });

  test("managed: true is load-bearing: the same file under defaults.managed: false without it is refused", () => {
    const recipe = parseYAML(yamlBlockOf(RECIPE) ?? "") as {
      connections: Array<Record<string, unknown>>;
    };
    const withoutManaged = {
      ...recipe,
      defaults: { managed: false },
      connections: recipe.connections.map((connection) =>
        Object.fromEntries(Object.entries(connection).filter(([field]) => field !== "managed")),
      ),
    };
    const refused = SeedConfigSchema.safeParse(withoutManaged);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.path.join("."))).toEqual(["connections.0.readOnly"]);
    // And with them written out, as the recipe has them, the same defaults load.
    expect(SeedConfigSchema.safeParse({ ...recipe, defaults: { managed: false } }).success).toBe(true);
    expect(RECIPE).toContain("`managed: true` is written out on both, although it is the default");
    expect(READ_ONLY).toContain("`managed: true` is written out on both, although it is the default");
  });

  test("readOnly in defaults is refused, as the recipe says", () => {
    const recipe = parseYAML(yamlBlockOf(RECIPE) ?? "") as Record<string, unknown>;
    const refused = SeedConfigSchema.safeParse({ ...recipe, defaults: { readOnly: true } });
    expect(refused.success).toBe(false);
    expect(RECIPE).toContain("`readOnly` is set per connection and never in `defaults`, which the load refuses");
  });
});

describe("docs/providers/etcd.md section 3.5 states the machine access the product refuses (E12)", () => {
  test("no agent execution and no MCP for etcd", () => {
    expect(AGENT_EXECUTION_ENGINES).not.toContain("etcd");
    expect(MCP_EXPOSABLE.etcd).toBe(false);
    expect(MACHINE).toContain("the agent's execution mode refuses etcd");
  });

  test("the MCP refusal quoted is the one the seed schema gives", () => {
    const parsed = SeedConfigSchema.safeParse({
      version: "1",
      connections: [{ id: "cluster", name: "Cluster", type: "etcd", host: "etcd.internal", roles: ["*"], mcp: true }],
    });
    const message = parsed.error?.issues[0]?.message;
    expect(message).toBeDefined();
    expect(MACHINE).toContain(`"${message}"`);
  });
});

describe("docs/providers/etcd.md section 4.1 states the dialog's fields and the host refusal (6.1)", () => {
  const etcd = DB_UI_CONFIG.etcd;

  test.each(["host", "user", "password"] as const)("the %s row carries the dialog's own hint", (field) => {
    const cell = field === "host" ? "Host" : field === "user" ? "User" : "Password";
    expect(rowOf(FIELDS, cell)).toBe(`| ${cell} | ${etcd.fieldHints?.[field]} |`);
  });

  test("the port is the dialog's and the provider's", () => {
    expect(etcd.defaultPort).toBe(String(ETCD_DEFAULT_PORT));
    expect(rowOf(FIELDS, "Port")).toContain(`\`${ETCD_DEFAULT_PORT}\` by default`);
  });

  test("no Database field and no connection string, as the dialog declares", () => {
    expect(etcd.connectionFields).not.toContain("database");
    expect(etcd.showConnectionStringToggle).toBe(false);
    expect(FIELDS).toContain("There is no Database field and no connection string");
  });

  test("the host refusal is the one connect() raises, before any client exists", () => {
    const refusal = (() => {
      try {
        buildEtcdConnectionOptions(
          { ...ETCD, host: "https://10.0.0.5" },
          { executionReadOnly: false, queryTimeout: 30_000 },
        );
        return undefined;
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(refusal).toBeDefined();
    expect(FIELDS).toContain(`is refused with "${refusal}"`);
  });
});

describe("docs/providers/etcd.md section 6.3 states the value edit the provider builds (#789)", () => {
  /** A key at mod_revision 7 holding `stored`, served by a cluster with authentication off. */
  const clientHolding = (stored: Uint8Array): EtcdClient =>
    createFakeEtcdClient({
      authStatus: async () => ({ enabled: false, authRevision: "1" }),
      status: async () => ({
        header: KEY_SPACE_HEADER,
        version: "3.7.2",
        dbSize: "20480",
        dbSizeInUse: "16384",
        dbSizeQuota: "0",
        leader: "10276657743932975437",
        raftIndex: "40",
        raftTerm: "2",
        raftAppliedIndex: "40",
        errors: [],
        isLearner: false,
        storageVersion: "3.7.0",
      }),
      range: async () => ({
        header: KEY_SPACE_HEADER,
        kvs: [
          {
            key: new TextEncoder().encode("/app/cfg"),
            value: stored,
            createRevision: "7",
            modRevision: "7",
            version: "1",
            lease: "0",
          },
        ],
        more: false,
        count: "1",
      }),
      close: async () => {},
    });

  async function build(stored: Uint8Array, request: { partId: string; text: string }): Promise<ObjectEditBuild> {
    const provider = new EtcdProvider(ETCD, {}, {}, async () => clientHolding(stored));
    await provider.connect();
    try {
      return await provider.buildObjectEdit({ path: ["/app/cfg"], kind: "key", ...request });
    } finally {
      await provider.disconnect();
    }
  }

  const text = (value: string): Uint8Array => new TextEncoder().encode(value);

  test("the preview's example is the unit the provider builds, in the dialog's form", async () => {
    const edited = "hello world!";
    const built = await build(text("hello"), { partId: "value", text: edited });
    if (!built.built) throw new Error(`the build refused: ${built.refusal.sentence}`);
    const unit = built.plan.unit;
    if (unit.medium !== "command") throw new Error("the unit is not a command");
    expect(unit.name).toBe("txn");
    expect(unit.arguments).toEqual(['mod("/app/cfg") = "7"', "put", "--ignore-lease", "/app/cfg"]);
    expect(unit.trailing).toEqual(["get", "/app/cfg"]);
    // ApplyPreviewDialog's summary: the name, the arguments, the payload counted, then the trailing words.
    const preview = `${unit.name} ${unit.arguments.join(" ")} <${unit.payloadLabel}, ${edited.length} characters> ${(unit.trailing ?? []).join(" ")}`;
    expect(EDIT).toContain(`for example \`${preview}\``);
    expect(built.plan.strategy).toBe("guarded-atomic-batch");
  });

  test.each([
    ["a key's metadata", text("hello"), { partId: "metadata", text: "x" }],
    ["a value that is not UTF-8 text", Uint8Array.of(0xff, 0xfe), { partId: "value", text: "x" }],
    ["a text identical to the stored value", text("hello"), { partId: "value", text: "hello" }],
  ] as const)("the sentence quoted for %s is the build's own", async (_label, stored, request) => {
    const built = await build(stored, request);
    if (built.built) throw new Error("the build issued a plan");
    expect(EDIT).toContain(`"${built.refusal.sentence}"`);
  });

  test("the editable pair the section names is the census's", () => {
    expect(EXPECTED_EDITABLE_KINDS).toContainEqual(["etcd", "key"]);
    expect(EDIT).toContain('The pair `["etcd", "key"]` in `EXPECTED_EDITABLE_KINDS`');
  });
});

describe("docs/SECURITY.md carries the read-only control, its note and its three limits (E6, E17)", () => {
  test("row 3.8 is a Partial control the checker counts, verified by the end-to-end test", () => {
    const row = rowOf(SECURITY, "3.8");
    expect(row).toBeDefined();
    expect(row?.split(" | ")[2]).toBe("Partial");
    expect(row).toContain("tests/unit/db/etcd/read-only-end-to-end.test.ts");
    expect(PROGRAMME_CONTROL_IDS).toContain("3.8");
  });

  test("its note states the precondition, and names the function and the map that keep the mode", () => {
    const note = SECURITY.split("\n\n").find((paragraph) => paragraph.startsWith("**3.8.**"));
    expect(note).toBeDefined();
    expect(note).toContain("the mode is a boundary only on a managed seed");
    expect(note).toContain("`assertReadOnlyHonoured`");
    expect(note).toContain("`READ_ONLY_ENFORCED`");
    expect(read("src/lib/db/factory.ts")).toContain("export function assertReadOnlyHonoured");
  });

  test.each([
    [
      "the read-only precondition",
      "An etcd connection's read-only mode (row 3.8) does not narrow this: it binds a `user` only on a managed seed and only where etcd authenticates the client with a secret only the seeds hold",
    ],
    ["the cancelled write", "Cancelling an etcd write in the editor shows it as cancelled even when etcd applied it"],
    [
      "the cases the Kubernetes write protection does not recognise",
      "The etcd provider's Kubernetes write protection is by prefix, and by content only where a single-key write meets a stored Kubernetes envelope",
    ],
  ])("the any-host limitation states %s", (_label, sentence) => {
    expect(ANY_HOST).toContain(sentence);
  });
});

const ETCD_DOC_LINES = DOC.split("\n");

/** The bounds-table row whose first cell is exactly `cell`, or undefined. */
const boundRow = (cell: string): string | undefined => ETCD_DOC_LINES.find((line) => line.startsWith(`| ${cell} |`));

/** A heading's words without its `#` marks and its section number: "## 12. Connecting to ..." reads "Connecting to ...". */
const headingWords = (line: string): string => line.replace(/^#+ /, "").replace(/^\d+(?:\.\d+)*\.?\s+/, "");

/** The text of the section headed `heading` (any level, numbered or not), up to the next heading of the same or a higher level. */
function docSection(text: string, heading: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^#{2,4} /.test(line) && headingWords(line) === headingWords(heading));
  if (start < 0) return undefined;
  const level = /^#+/.exec(lines[start])?.[0].length ?? 2;
  const end = lines.findIndex(
    (line, index) => index > start && /^#+ /.test(line) && (/^#+/.exec(line)?.[0].length ?? 9) <= level,
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const en = (value: number) => value.toLocaleString("en-US");

describe("the bounds docs/providers/etcd.md quotes are the constants (spec 5.4, 11, KE1 to KE5)", () => {
  test("the readers find what exists and nothing that does not", () => {
    // Control: a reader that matched nothing would fail every row below loudly, but one that
    // matched everything would pass them all.
    expect(boundRow("`ETCD_GROUP_CAP`")).toBeDefined();
    expect(boundRow("`ETCD_NO_SUCH_CONSTANT`")).toBeUndefined();
    expect(docSection(DOC, "Connecting to a Kubernetes control-plane etcd")).toBeDefined();
    expect(docSection(DOC, "No such section")).toBeUndefined();
  });

  test.each([
    ["`DEFAULT_QUERY_LIMIT`", DEFAULT_QUERY_LIMIT],
    ["`ETCD_READ_BOUNDS.firstPageSize`", ETCD_READ_BOUNDS.firstPageSize],
    ["`ETCD_READ_BOUNDS.maxPageSize`", ETCD_READ_BOUNDS.maxPageSize],
    ["`ETCD_READ_BOUNDS.byteBudget`", ETCD_READ_BOUNDS.byteBudget],
    ["`ETCD_READ_BOUNDS.cellLimit`", ETCD_READ_BOUNDS.cellLimit],
    ["`ETCD_READ_BOUNDS.watchMarginMs`", ETCD_READ_BOUNDS.watchMarginMs],
    ["`ETCD_RECEIVE_CAP_BYTES`", ETCD_RECEIVE_CAP_BYTES],
    ["`ETCD_GROUP_CAP`", ETCD_GROUP_CAP],
    ["`ETCD_WALK_KEY_CAP`", ETCD_WALK_KEY_CAP],
    ["`ETCD_WALK_SEGMENT_BUDGET`", ETCD_WALK_SEGMENT_BUDGET],
    ["`ETCD_WALK_FIRST_PAGE`", ETCD_WALK_FIRST_PAGE],
    ["`ETCD_KEY_SCAN.defaultCount`", ETCD_KEY_SCAN.defaultCount],
    ["`ETCD_KEY_SCAN.maxCount`", ETCD_KEY_SCAN.maxCount],
    ["`ETCD_TABLE_STATS_CONCURRENCY`", ETCD_TABLE_STATS_CONCURRENCY],
  ])("the %s row states %d", (cell, value) => {
    const row = boundRow(cell);
    expect(row).toBeDefined();
    // The second cell, not anywhere in the row: a row whose reason happened to hold the number
    // would pass a containment check over the whole line.
    expect(row?.split(" | ")[1]).toBe(en(value));
  });

  test("the walk's bounds keep the order spec 4.3 requires: P below S, G below INVENTORY_LIMIT", () => {
    expect(ETCD_WALK_SEGMENT_BUDGET).toBeLessThan(ETCD_WALK_KEY_CAP);
    expect(ETCD_GROUP_CAP).toBeLessThan(5000);
  });
});

describe("docs/providers/etcd.md states the grammar and the maintenance wording the code holds (spec 5.1, 7.2)", () => {
  const grammar = docSection(DOC, "5.1 The grammar") ?? "";
  const maintenance = docSection(DOC, "8. Maintenance") ?? "";

  test("every command of the subset is in the commands table, spelled as etcdctl spells it", () => {
    const missing = ETCD_COMMAND_TABLE.filter((entry) => !grammar.includes(`| \`${entry.words.join(" ")}\` |`)).map(
      (entry) => entry.words.join(" "),
    );
    expect(missing).toEqual([]);
  });

  test("every command refused by name, and every refused global flag, is named", () => {
    const commands = ETCD_REFUSED_COMMANDS.filter((entry) => !grammar.includes(`\`${entry.words.join(" ")}\``));
    const flags = ETCD_REFUSED_GLOBAL_FLAGS.filter((entry) => !grammar.includes(`\`${entry.flag}\``));
    expect(commands.map((entry) => entry.words.join(" "))).toEqual([]);
    expect(flags.map((entry) => entry.flag)).toEqual([]);
  });

  test("each maintenance card's label, title and description is quoted exactly", () => {
    for (const type of ["compact", "defragment", "disarm"] as const) {
      const spec = ETCD_MAINTENANCE_SPECS[type];
      expect(spec?.title).toBeDefined();
      expect(maintenance).toContain(`"${spec?.label}"`);
      expect(maintenance).toContain(`"${spec?.title}"`);
      expect(maintenance).toContain(`"${spec?.description}"`);
    }
  });
});

describe("the protected set is stated where an operator reads it (spec E8, E9, 12)", () => {
  test("the provider doc names every protected prefix, the protected key and every secrets root", () => {
    const writes = docSection(DOC, "3.2 Kubernetes writes are refused (E8)") ?? "";
    const values = docSection(DOC, "3.3 Values that are never shown (E9)") ?? "";
    for (const prefix of PROTECTED_PREFIXES) expect(writes).toContain(`\`${prefix}\``);
    for (const key of PROTECTED_KEYS) expect(writes).toContain(`\`${key}\``);
    for (const root of SECRET_ROOTS) expect(values).toContain(`\`${root}\``);
  });

  test("docs/SECURITY.md carries the control row and its note, naming the same set", () => {
    const row = SECURITY.split("\n").find(
      (line) => /^\| \d+\.\d+ \|/.test(line) && line.includes("Kubernetes storage prefix"),
    );
    expect(row).toBeDefined();
    const id = row?.split(" | ")[0].replace("| ", "");
    expect(row).toContain("tests/unit/db/etcd/write-policy.test.ts");
    const note = SECURITY.split("\n\n").find((paragraph) => paragraph.startsWith(`**${id}.**`));
    expect(note).toBeDefined();
    for (const prefix of PROTECTED_PREFIXES) expect(note).toContain(`\`${prefix}\``);
    for (const key of PROTECTED_KEYS) expect(note).toContain(`\`${key}\``);
  });
});

describe("docs/providers/etcd.md states the limits of spec E17 and the Kubernetes path of spec 12", () => {
  const limits = docSection(DOC, "13. Known limitations") ?? "";
  const kubernetes = docSection(DOC, "Connecting to a Kubernetes control-plane etcd") ?? "";

  test.each([
    "A `put`'s value is part of the statement text, so it reaches query history and saved queries, as a Redis `SET` does.",
    "The editor path writes no audit event for any engine: only the value edit of the Source tab and the maintenance cards are audited.",
    "Cancelling a write in the editor shows it as cancelled even when etcd applied it: read the key again before you run the command again.",
    "A read-only seed restrains only the seeded connection: a `user` can post a connection of their own to the same host and port.",
  ])("E17: %s", (sentence) => {
    expect(limits).toContain(sentence);
  });

  test.each([
    "/etc/kubernetes/pki/etcd/ca.crt",
    "/etc/kubernetes/pki/etcd/healthcheck-client.crt",
    "/etc/kubernetes/pki/etcd/healthcheck-client.key",
    "/var/lib/rancher/k3s/server/tls/etcd/server-ca.crt",
    "/var/lib/rancher/k3s/server/tls/etcd/client.crt",
    "/var/lib/rancher/k3s/server/tls/etcd/client.key",
  ])("the Kubernetes section names %s", (path) => {
    expect(kubernetes).toContain(`\`${path}\``);
  });

  test("the Kubernetes section keeps the key out of the ConfigMap and says the API server compacts", () => {
    expect(kubernetes).toContain("Never put the client key in `seedConnections.config`");
    expect(kubernetes).toContain("kube-apiserver compacts etcd every 5 minutes");
    expect(kubernetes).toContain("verify-full");
  });
});

describe("docs/providers/etcd.md carries no authoring instruction", () => {
  test("no scratch path and no placeholder note reaches the published doc", () => {
    expect(DOC).not.toContain("$S/");
    expect(DOC).not.toContain("angle-bracketed");
  });
});
