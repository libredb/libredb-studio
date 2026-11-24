/**
 * The transaction facade's allowances with real timers, in a bounded Node child (src/lib/api/editor-transaction.ts;
 * docs/providers/CONTRACT.md, clause C-59): a rollback after a credential change that never answers is abandoned at its
 * 5 s allowance, and a COMMIT that never answers is stopped at its execute deadline, each set 50 ms out through the
 * facade's `now`, so the child answers within its spawn timeout. Without the host's wait the child waits until the
 * spawn timeout kills it, and the case fails within seconds; the child holds a referenced interval, so Node cannot exit
 * early on the unsettled call (tests/helpers/bounded-node-child.ts).
 *
 * `editor-transaction.test.ts` holds the same rules with a core of the test's own, in the test process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { EXECUTE_SLACK_MS } from "@/lib/api/editor-query";
import type {
  CREDENTIAL_CHANGE_ROLLBACK_MS,
  endTransaction,
  rollBackAfterCredentialChange,
} from "@/lib/api/editor-transaction";
import type { errorKind, errorOutcome } from "@/lib/db/error-record";
import type { createHostCore } from "@/lib/provider-host/core/host-core";
import type { installHostCore } from "@/lib/provider-host/instance";
import { boundedChild } from "../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly EXECUTE_SLACK_MS: typeof EXECUTE_SLACK_MS;
  readonly CREDENTIAL_CHANGE_ROLLBACK_MS: typeof CREDENTIAL_CHANGE_ROLLBACK_MS;
  readonly endTransaction: typeof endTransaction;
  readonly rollBackAfterCredentialChange: typeof rollBackAfterCredentialChange;
  readonly errorKind: typeof errorKind;
  readonly errorOutcome: typeof errorOutcome;
  readonly createHostCore: typeof createHostCore;
  readonly installHostCore: typeof installHostCore;
}

const SOURCE = path.join(import.meta.dir, "..", "..", "..", "..", "src");

const child = boundedChild({
  label: "editor-transaction-bounds",
  imports: [
    { from: path.join(SOURCE, "lib", "api", "editor-query.ts"), names: ["EXECUTE_SLACK_MS"] },
    {
      from: path.join(SOURCE, "lib", "api", "editor-transaction.ts"),
      names: ["CREDENTIAL_CHANGE_ROLLBACK_MS", "endTransaction", "rollBackAfterCredentialChange"],
    },
    { from: path.join(SOURCE, "lib", "db", "error-record.ts"), names: ["errorKind", "errorOutcome"] },
    { from: path.join(SOURCE, "lib", "provider-host", "core", "host-core.ts"), names: ["createHostCore"] },
    { from: path.join(SOURCE, "lib", "provider-host", "instance.ts"), names: ["installHostCore"] },
  ],
  runCase: async (deps: ChildDeps, name: string) => {
    deps.installHostCore(deps.createHostCore(), "test");
    const queryTimeout = 1_000;
    // A transaction provider in a transaction whose COMMIT and ROLLBACK never settle.
    const provider = {
      config: { id: "c", name: "c", type: "postgres", createdAt: new Date(0), queryTimeout },
      prepareQuery: (sql: string) => ({ query: sql, wasLimited: false, limit: 1, offset: 0 }),
      beginTransaction: async () => {},
      commitTransaction: () => new Promise<never>(() => {}),
      rollbackTransaction: () => new Promise<never>(() => {}),
      isInTransaction: () => true,
      queryInTransaction: () => new Promise<never>(() => {}),
    } as never;
    const describeError = (error: unknown) =>
      `${(error as Error).name} ${deps.errorKind(error)} ${deps.errorOutcome(error)} ${(error as Error).message}`;
    if (name === "credential-rollback-never-answers") {
      const answer = await deps.rollBackAfterCredentialChange(
        provider,
        "bounds",
        // The allowance ends 50 ms from now.
        Date.now() - deps.CREDENTIAL_CHANGE_ROLLBACK_MS + 50,
      );
      return answer.kind === "unconfirmed" ? `unconfirmed ${describeError(answer.error)}` : answer.kind;
    }
    const outcome = await deps.endTransaction(
      provider,
      "commit",
      { signal: new AbortController().signal, route: "bounds" },
      // The execute deadline, the statement timeout plus the slack, ends 50 ms from now.
      Date.now() - queryTimeout - deps.EXECUTE_SLACK_MS + 50,
    );
    return outcome.kind === "unanswered" ? `unanswered ${describeError(outcome.error)}` : outcome.kind;
  },
  heapLimitMiB: 256,
  timeoutMs: 3_000,
});

beforeAll(async () => {
  await child.build();
});

afterAll(() => {
  child.remove();
});

describe("the transaction facade's allowances in a bounded child", () => {
  test("a rollback after a credential change that never answers is abandoned at its 5 s allowance, unconfirmed", async () => {
    expect(await child.run<string>("credential-rollback-never-answers")).toBe(
      "unconfirmed TimeoutError studio-timeout-refusal unknown The rollback after a credential change did not answer within 5 seconds, so Studio stopped waiting for it.",
    );
  });

  test("a COMMIT that never answers is stopped at its deadline, its state unknown", async () => {
    expect(await child.run<string>("commit-never-answers")).toBe(
      "unanswered TimeoutError studio-timeout-refusal unknown The COMMIT did not answer within the statement timeout of 1 second and 10 seconds more for the engine's own answer, so Studio stopped waiting for it, and the transaction may have been committed or rolled back.",
    );
  });
});
