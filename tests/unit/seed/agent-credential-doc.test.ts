/**
 * The "An agent credential" subsection of docs/SEED_CONNECTIONS.md names, per form, the engines whose seed takes it,
 * and the engines on which the credential narrows agent runs only or `inspect_schema` and agent runs. Each list is
 * derived here from `SEED_AGENT_CREDENTIAL` and the MCP registries, so a row that changes fails this until the
 * document follows.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MCP_EXPOSABLE, MCP_STATEMENT_READ, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { SEED_AGENT_CREDENTIAL } from "@/lib/db/connection-fields";
import type { DatabaseType } from "@/lib/types";

const DOC = readFileSync(path.resolve(import.meta.dir, "../../../docs/SEED_CONNECTIONS.md"), "utf8");
const SECTION = DOC.split("### An agent credential\n")[1]?.split(/^### /m)[0] ?? "";

/** The backticked type-ids of the one line that starts with `lead`. */
function namedOn(lead: string): string[] {
  const line = SECTION.split("\n").find((candidate) => candidate.startsWith(lead)) ?? "";
  return [...line.matchAll(/`([a-z0-9]+)`/g)]
    .map((match) => match[1])
    .filter((name) => (SHIPPED_DATABASE_TYPES as readonly string[]).includes(name))
    .sort();
}

const where = (keep: (type: DatabaseType) => boolean): string[] => SHIPPED_DATABASE_TYPES.filter(keep).sort();

describe("docs/SEED_CONNECTIONS.md: an agent credential", () => {
  test("names the engines of each form from SEED_AGENT_CREDENTIAL", () => {
    expect(namedOn("- `agentUser` and `agentPassword` together:")).toEqual(
      where((type) => SEED_AGENT_CREDENTIAL[type]?.form === "pair"),
    );
    expect(namedOn("- `agentUser` and `agentPassword` together, with an `agentUser` other than `user`:")).toEqual(
      where((type) => SEED_AGENT_CREDENTIAL[type]?.form === "dedicated-pair"),
    );
    expect(namedOn("- `agentPassword` alone")).toEqual(where((type) => SEED_AGENT_CREDENTIAL[type]?.form === "secret"));
    expect(namedOn("- Neither:")).toEqual(where((type) => SEED_AGENT_CREDENTIAL[type] === null));
  });

  test("names where the credential narrows agent runs only and where inspect_schema too, from the MCP registries", () => {
    const line =
      SECTION.split("\n").find((candidate) => candidate.startsWith("MCP reads under the agent credential")) ?? "";
    const [runsOnly, inspectToo] = line.split(", and on ");
    const named = (text: string | undefined) =>
      [...(text ?? "").matchAll(/`([a-z0-9]+)`/g)]
        .map((match) => match[1])
        .filter((name) => name !== "inspect_schema")
        .sort();
    expect(named(runsOnly)).toEqual(where((type) => SEED_AGENT_CREDENTIAL[type] !== null && !MCP_EXPOSABLE[type]));
    expect(named(inspectToo)).toEqual(
      where((type) => SEED_AGENT_CREDENTIAL[type] !== null && MCP_EXPOSABLE[type] && !MCP_STATEMENT_READ[type]),
    );
  });
});
