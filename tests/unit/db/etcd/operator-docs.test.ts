/**
 * What the operator-facing documents say about etcd: the read-only recipe of `docs/SEED_CONNECTIONS.md`, loaded as
 * the seed loader loads a file, and the read-only control row 3.8, its note, the any-host limitation and the protected
 * Kubernetes storage set of `docs/SECURITY.md`.
 */
import { PROGRAMME_CONTROL_IDS } from "../../../../scripts/security-check.mjs";
import { PROTECTED_KEYS, PROTECTED_PREFIXES } from "@/lib/db/providers/keyvalue/etcd/keys";
import { SeedConfigSchema } from "@/lib/seed/types";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYAML } from "yaml";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
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
const RECIPE = sectionOf(SEEDS, "### A read-only cluster for everyone") ?? "";
const ANY_HOST = bulletOf(SECURITY, "**A `user` can connect to any host and port and run any statement.**") ?? "";
/** A recipe block parsed as the seed loader parses a file, or the issues it was refused with. */
function seedFile(block: string | undefined) {
  if (block === undefined) throw new Error("the section holds no ```yaml block");
  return SeedConfigSchema.safeParse(parseYAML(block));
}

describe("SEED_CONNECTIONS.md's read-only etcd recipe and SECURITY.md's etcd controls", () => {
  test("the readers find what exists and nothing that does not", () => {
    // A `#` comment inside a fenced block is no heading: the recipe's block holds none, so a fixture does.
    expect(sectionOf("## A\n```yaml\n# a comment\n```\nafter\n## B", "## A")).toBe(
      "## A\n```yaml\n# a comment\n```\nafter",
    );
    expect(yamlBlockOf("no block")).toBeUndefined();
    expect(ANY_HOST.length).toBeGreaterThan(0);
    expect(bulletOf(SECURITY, "**No such limit.**")).toBeUndefined();
    // The bullet ends where the next one starts.
    expect(ANY_HOST).not.toContain("Env-mode local passwords are not hashed");
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
  });

  test("readOnly in defaults is refused, as the recipe says", () => {
    const recipe = parseYAML(yamlBlockOf(RECIPE) ?? "") as Record<string, unknown>;
    const refused = SeedConfigSchema.safeParse({ ...recipe, defaults: { readOnly: true } });
    expect(refused.success).toBe(false);
    expect(RECIPE).toContain("`readOnly` is set per connection and never in `defaults`, which the load refuses");
  });

  test("the seed schema refuses an etcd seed with mcp: true", () => {
    const parsed = SeedConfigSchema.safeParse({
      version: "1",
      connections: [
        {
          id: "cluster",
          name: "Cluster",
          type: "etcd",
          host: "etcd.internal",
          user: "root",
          password: "${ETCD_ROOT_PASSWORD}",
          roles: ["*"],
          mcp: true,
        },
      ],
    });
    const message = parsed.error?.issues[0]?.message;
    expect(message).toBeDefined();
  });

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
    // The provider sentences that follow the pointer to the Write reach table name the noun they belong to.
    expect(note).toContain("Of the providers that keep it, etcd's names where the mode was set in every refusal");
    expect(read("src/lib/db/open-check.ts")).toContain("export function assertReadOnlyHonoured");
  });

  test.each([
    [
      "the read-only precondition",
      "An etcd connection's read-only mode (row 3.8) does not narrow this: it binds a `user` only on a managed seed and only where etcd authenticates the client with a secret only the seeds hold",
    ],
    [
      "the cancelled write",
      "An etcd write cannot be cancelled once it has been sent: the provider's cancel answers false",
    ],
    [
      "the cases the Kubernetes write protection does not recognise",
      "The etcd provider's Kubernetes write protection is by prefix, and by content only where a single-key write meets a stored Kubernetes envelope",
    ],
  ])("the any-host limitation states %s", (_label, sentence) => {
    expect(ANY_HOST).toContain(sentence);
  });

  test("SECURITY.md carries the Kubernetes storage prefix control row and its note, naming the protected set", () => {
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
