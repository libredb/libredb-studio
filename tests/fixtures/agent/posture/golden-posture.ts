/**
 * The behaviour-neutral oracle of the agent safety strip's posture: what `agentPosture` answers for every engine
 * `AGENT_STATEMENT_LANGUAGE` lists, in every arm, and for no resolved connection.
 *
 * The arms are the ones `posture.ts` orders: plan mode, with and without the hand-over ticked; agent mode without the
 * hand-over (reads), with it (widened), and on a connection whose last run was refused for the connection itself;
 * an engine with no statement language is blocked in each agent-mode arm. Each engine is named by its product label,
 * as the strip is. Distinct answers are written once and each engine's arm names its answer by index, because one
 * language's engines read alike and the file would otherwise repeat each answer per engine.
 *
 * `golden-posture.json` beside this file is this module's output on the commit before core derived the tone and the
 * headline, and `tests/unit/lib/agent/posture.test.ts` holds every engine and arm to it. A change that means to move
 * an answer regenerates the file from the base it starts from, with that base's code, and commits it on its own first:
 *
 *   bun tests/fixtures/agent/posture/golden-posture.ts > tests/fixtures/agent/posture/golden-posture.json
 *
 * Nothing here builds a provider or reaches a database: `agentPosture` is a pure function of its input.
 */
import { AGENT_STATEMENT_LANGUAGE } from "@/lib/db/compatibility";
import { agentPosture } from "@/lib/agent/posture";
import { getDBConfig } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";

/** The refusal the refused arm quotes: a sentence of the connection refusal's shape, fixed so the answer is too. */
export const POSTURE_REFUSAL =
  "The credential this run would execute as, a database user or a token, holds privileges the read-only boundary cannot contain.";

/** The arms of an engine's posture, in the order the golden file lists them. */
export const POSTURE_ARMS = ["plan", "plan-handover", "reads", "widened", "refused"] as const;
export type PostureArm = (typeof POSTURE_ARMS)[number];

/** The arms with no resolved connection: plan mode, and agent mode, which cannot name an engine. */
export const UNRESOLVED_ARMS = ["plan", "agent"] as const;
export type UnresolvedArm = (typeof UNRESOLVED_ARMS)[number];

/** Every engine the walk covers: each key of the record the strip reads, in its order. */
export const POSTURE_ENGINES = Object.keys(AGENT_STATEMENT_LANGUAGE) as DatabaseType[];

/** What the strip renders for one engine in one arm. */
export function postureOf(engine: DatabaseType, arm: PostureArm) {
  const base = { engine, engineLabel: getDBConfig(engine).label };
  switch (arm) {
    case "plan":
      return agentPosture({ ...base, mode: "planning", handover: false });
    case "plan-handover":
      return agentPosture({ ...base, mode: "planning", handover: true });
    case "reads":
      return agentPosture({ ...base, mode: "agent", handover: false });
    case "widened":
      return agentPosture({ ...base, mode: "agent", handover: true });
    case "refused":
      return agentPosture({ ...base, mode: "agent", handover: false, refusedHere: POSTURE_REFUSAL });
  }
}

/** What the strip renders with no resolved connection. The label is a label for nothing, so it is empty. */
export function unresolvedPostureOf(arm: UnresolvedArm) {
  return agentPosture({ mode: arm === "plan" ? "planning" : "agent", engine: null, engineLabel: "", handover: false });
}

export function goldenPosture(): string {
  const answers: string[] = [];
  const indexOf = (posture: ReturnType<typeof postureOf>): number => {
    const text = JSON.stringify(posture);
    const found = answers.indexOf(text);
    if (found !== -1) return found;
    answers.push(text);
    return answers.length - 1;
  };
  const engines = Object.fromEntries(
    POSTURE_ENGINES.map((engine) => [
      engine,
      Object.fromEntries(POSTURE_ARMS.map((arm) => [arm, indexOf(postureOf(engine, arm))])),
    ]),
  );
  const unresolved = Object.fromEntries(UNRESOLVED_ARMS.map((arm) => [arm, indexOf(unresolvedPostureOf(arm))]));
  const result = { engines, unresolved, answers: answers.map((text) => JSON.parse(text)) };
  return `${JSON.stringify(result, null, 2)}\n`;
}

if (import.meta.main) process.stdout.write(goldenPosture());
