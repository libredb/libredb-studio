/**
 * `docs/AGENT.md` states what agent mode does on a MongoDB connection, and each claim it makes is read back here from
 * the code that decides it, the shape of `tests/unit/db/kubernetes/provider-doc.test.ts`: a claim copied into prose
 * is true only until the code moves. The section's tool table is the manifest's mongo variants, its command argument
 * is the language's, the tools and the setting it says are not offered are not, each with the backlog entry that
 * records why, its refusals end in the run reasons the runtime records for their codes, and the posture table carries
 * the row the safety strip renders.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_LANGUAGE_COPY, AGENT_WORKFLOW_VARIANTS } from "@/lib/agent/agent-manifest";
import { agentPosture } from "@/lib/agent/posture";
import { MCP_STATEMENT_ARMS } from "@/lib/mcp/tools/statement-arms";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (file: string): string => readFileSync(path.join(ROOT, file), "utf8");
const AGENT_DOC = read("docs/AGENT.md");
const BACKLOG = read("docs/BACKLOG.md");

const HEADING = "### On a MongoDB connection";
/** The section, from its heading to the next heading of its level or above. */
const SECTION = AGENT_DOC.split(`\n${HEADING}\n`)[1]?.split(/^#{2,3} /m)[0] ?? "";

const cells = (row: string): string[] =>
  row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
const ticked = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

/** The M2 backlog entry an id names, by its title, or undefined when the section holds no such entry. */
function m2Title(id: string): string | undefined {
  const m2 = BACKLOG.split(/^## Agent M2 deferrals/m)[1]?.split(/^## /m)[0] ?? "";
  return m2
    .split("\n")
    .find((line) => line.startsWith(`### ${id}. `))
    ?.slice(`### ${id}. `.length);
}

/** The backlog id the first sentence of the section matching `subject` cites. */
function citedFor(subject: RegExp): string {
  const sentence = SECTION.split("\n").find((line) => subject.test(line)) ?? "";
  const id = /\b(B\d+)\b/.exec(sentence)?.[1];
  if (id === undefined) throw new Error(`docs/AGENT.md "${HEADING}" cites no backlog entry beside ${subject}`);
  return id;
}

describe("docs/AGENT.md has a MongoDB section", () => {
  test("it exists, and the table of contents reaches it", () => {
    expect(SECTION.length).toBeGreaterThan(0);
    // The entry itself, nested under the tool set as the heading is. The engine paragraph and the descriptor paragraph
    // link the section too, so a match anywhere in the file would pass with the entry gone.
    const toc = AGENT_DOC.split(/^## Table of Contents$/m)[1]?.split(/^## /m)[0] ?? "";
    expect(toc).toMatch(/^ {4}- \[On a MongoDB connection\]\(#on-a-mongodb-connection\)$/m);
  });
});

describe("the section's tool table is the manifest's mongo variants", () => {
  const variants = AGENT_WORKFLOW_VARIANTS.mongo;
  const workflows = Object.keys(variants).filter((workflow) => workflow !== "operations");

  test("every statement workflow has a variant to compare against", () => {
    expect(workflows.length).toBe(4);
  });

  test.each(workflows)("%s lists its tools and its narrowed extras", (workflow) => {
    const variant = variants[workflow as keyof typeof variants];
    const row = SECTION.split("\n").find((line) => line.startsWith(`| \`${workflow}\``));
    expect(row).toBeDefined();
    const [, tools, extras] = cells(row ?? "");
    expect(ticked(tools).sort()).toEqual([...(variant?.tools ?? [])].sort());
    const narrowed = [...(variant?.narrowedExtras ?? [])].sort();
    if (narrowed.length === 0) expect(extras).toBe("none");
    else expect(ticked(extras).sort()).toEqual(narrowed);
  });

  test("the command arrives in the argument the language names", () => {
    expect(AGENT_LANGUAGE_COPY.mongo.argument).toBe("command");
    expect(SECTION).toContain("`command`");
  });
});

describe("what a MongoDB run is not offered is not offered, and the backlog says why", () => {
  test("compare_plans: no mongo variant offers it, and the entry the section cites is about it", () => {
    for (const variant of Object.values(AGENT_WORKFLOW_VARIANTS.mongo)) {
      expect(variant?.tools ?? []).not.toContain("compare_plans");
    }
    expect(m2Title(citedFor(/`compare_plans`/))).toContain("compare_plans");
  });

  test("auto-execute: no mongo variant offers it, and the entry the section cites is about it", () => {
    for (const variant of Object.values(AGENT_WORKFLOW_VARIANTS.mongo)) expect(variant?.canAutoExecute).toBe(false);
    const id = citedFor(/[Aa]uto-execute/);
    expect(m2Title(id)).toContain("auto-execute");
    // The mongo client pack's docblock names the change that would turn it on by the same entry.
    expect(read("src/lib/agent/languages/mongo/client.ts")).toMatch(new RegExp(`BACKLOG\\.md\`?[\\s*]+${id}\\b`));
  });

  test("MCP: the section names the tool the mongo language's MCP arm registers, and cites no backlog entry for it", () => {
    const tool = MCP_STATEMENT_ARMS.mongo?.tool;
    expect(tool).toBe("run_mongo_command");
    const sentence = SECTION.split("\n").find((line) => /\bMCP\b/.test(line)) ?? "";
    expect(sentence).toContain(`\`${tool}\``);
    expect(sentence).toContain("`MCP_STATEMENT_ARMS`");
    expect(sentence).toContain("`src/lib/agent/languages/mongo/mcp.ts`");
    expect(sentence).not.toMatch(/\bB\d+\b/);
  });
});

describe("the section's refusals end in the run reasons the runtime records", () => {
  /** `PROFILE_REFUSAL_REASON` in `src/lib/agent/runtime.ts`, read from the source: the map is module-private. */
  const reasons = ((): ReadonlyMap<string, string> => {
    const body = /PROFILE_REFUSAL_REASON[^=]*= Object\.freeze\(\{([\s\S]*?)\}/.exec(
      read("src/lib/agent/runtime.ts"),
    )?.[1];
    if (body === undefined) throw new Error("src/lib/agent/runtime.ts: PROFILE_REFUSAL_REASON is not where it was");
    return new Map([...body.matchAll(/(\w+): "([a-z-]+)"/g)].map((match) => [match[1], match[2]]));
  })();
  const header = "| Cause | Deny code | Run reason |";
  const rows = (SECTION.split(header)[1]?.split(/\n\n/)[0] ?? "")
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
    .map(cells);

  test("the runtime's map was read, and the table has a row for each code the profile raises at open", () => {
    expect(reasons.size).toBeGreaterThan(0);
    expect(rows.map((row) => ticked(row[1])[0]).sort()).toEqual([
      "PROFILE_PRIVILEGES_TOO_BROAD",
      "PROFILE_PRIVILEGES_TOO_NARROW",
      "PROFILE_SERVER_UNENFORCED",
      "PROFILE_UNSUPPORTED_TARGET",
    ]);
  });

  test("each row's run reason is the one the runtime records for its code", () => {
    const documented = Object.fromEntries(rows.map((row) => [ticked(row[1])[0], ticked(row[2])[0]]));
    // A code the runtime does not map is left out of the second record, so the comparison names it.
    const recorded = Object.fromEntries([...reasons].filter(([code]) => Object.hasOwn(documented, code)));
    expect(documented).toEqual(recorded);
  });
});

describe("the posture table carries the mongo reads arm in the words the strip renders", () => {
  test("its row names the boundary the qualifier names", () => {
    const posture = agentPosture({ mode: "agent", engine: "mongodb", engineLabel: "MongoDB", handover: false });
    const boundary = posture.qualifier.split(", ").at(-1) ?? "";
    expect(boundary).toContain("server");
    const row = AGENT_DOC.split("\n").find((line) => line.startsWith("| `reads`") && line.includes(`*${boundary}*`));
    expect(row).toBeDefined();
    expect(row).toContain("MongoDB");
  });
});
