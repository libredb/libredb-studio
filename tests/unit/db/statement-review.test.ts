import { describe, expect, test } from "bun:test";
import { AGENT_EXECUTION_ENGINES, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { ExecutionProfileError, UnknownProviderError } from "@/lib/db/errors";
import {
  acquireExecutionProfileProvider,
  type ExecutionProfile,
  executionContextFor,
  getExecutionProfileCacheStats,
} from "@/lib/db/factory";
import { assertStatementsReviewed } from "@/lib/db/statement-review";
import { unknownTypeSentence } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * The one core assertion every agent and MCP statement gate reads: an engine Studio's review record
 * (`AGENT_EXECUTION_ENGINES` in `src/lib/db/compatibility.ts`) does not list is refused by name, whatever its provider
 * implements. The refused set is computed from the shipped types minus the record, never written here, so an engine
 * added to either side is measured without an edit to this file.
 */

/** Settles a call and answers what it threw, or `null`, so the refusal is asserted after it settles. */
function thrownBy(call: () => void): unknown {
  try {
    call();
    return null;
  } catch (error) {
    return error;
  }
}

const unreviewed: readonly DatabaseType[] = SHIPPED_DATABASE_TYPES.filter(
  (type) => !AGENT_EXECUTION_ENGINES.includes(type),
);

describe("the review record of agent and MCP statements", () => {
  test("admits every engine on the review record", () => {
    for (const type of AGENT_EXECUTION_ENGINES) expect(thrownBy(() => assertStatementsReviewed(type))).toBeNull();
  });

  test("refuses by name, with a deny code of its own, every shipped type the record does not list", () => {
    expect(unreviewed.length).toBeGreaterThan(0);
    for (const type of unreviewed) {
      const error = thrownBy(() => assertStatementsReviewed(type));
      expect(error).toBeInstanceOf(ExecutionProfileError);
      expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_ENGINE_NOT_REVIEWED");
      expect((error as ExecutionProfileError).message).toBe(
        `Provider type "${type}" is not on the review record of engines that run agent and MCP statements, so no statement is sent on it, whatever its provider implements`,
      );
    }
  });

  test("refuses a string that is not a type id by name before the record is read", () => {
    const error = thrownBy(() => assertStatementsReviewed("acmefoo" as DatabaseType));
    expect(error).toBeInstanceOf(UnknownProviderError);
    expect((error as UnknownProviderError).message).toBe(unknownTypeSentence("acmefoo"));
    expect((error as UnknownProviderError).typeId).toBe("acmefoo");
  });
});

/**
 * Every profile, placed in a table the compiler holds total over `ExecutionProfile`, so a new profile fails the
 * typecheck here until it is placed. Whether one sends statements is read from `executionContextFor`, never written.
 */
const PROFILES = Object.keys({
  "agent-read-only": true,
  "agent-handover": true,
  "agent-operations": true,
} satisfies Record<ExecutionProfile, true>) as ExecutionProfile[];

/** Settles an acquisition as the deny code it was refused with, or a line naming what it answered instead. */
async function refusalOf(call: Promise<unknown>): Promise<string> {
  const settledAs = await call.then(
    () => null,
    (error: unknown) => error,
  );
  if (settledAs instanceof ExecutionProfileError) return settledAs.reasonCode;
  return `not an execution-profile refusal: ${String(settledAs)}`;
}

describe("the acquisition reads the review record", () => {
  /**
   * The census needs no server, file or provider build. Each connection carries a connection string and an agent user,
   * so the first refusal after the review gate is the credential check in `resolveAgentCredential`
   * (`AGENT_CREDENTIAL_WITH_CONNECTION_STRING`), which runs before any tunnel or provider build and builds nothing. An
   * engine the gate admits therefore answers that code, and an engine it refuses answers `PROFILE_ENGINE_NOT_REVIEWED`;
   * the profiled cache stays empty throughout.
   */
  test("under each profile that sends statements the acquisition admits exactly the engines on the record, and under agent-operations the record is never asked", async () => {
    const cases = PROFILES.flatMap((profile) => SHIPPED_DATABASE_TYPES.map((type) => ({ profile, type })));
    const answers = await Promise.all(
      cases.map(async ({ profile, type }) => {
        const connection = {
          ...CENSUS_CONNECTION[type],
          id: `census-${type}-${profile}`,
          connectionString: `census://${crypto.randomUUID()}`,
          agentUser: crypto.randomUUID(),
        };
        return `${profile} ${type}: ${await refusalOf(acquireExecutionProfileProvider(connection, profile))}`;
      }),
    );
    const expected = cases.map(({ profile, type }) => {
      const refusedByRecord = executionContextFor(profile).sendsStatements && !AGENT_EXECUTION_ENGINES.includes(type);
      return `${profile} ${type}: ${refusedByRecord ? "PROFILE_ENGINE_NOT_REVIEWED" : "AGENT_CREDENTIAL_WITH_CONNECTION_STRING"}`;
    });
    expect(PROFILES.some((profile) => executionContextFor(profile).sendsStatements)).toBe(true);
    expect(PROFILES.some((profile) => !executionContextFor(profile).sendsStatements)).toBe(true);
    expect(answers).toEqual(expected);
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });
});
