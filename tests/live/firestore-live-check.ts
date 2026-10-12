/**
 * Hand-run live check of the real Firestore provider against a running emulator; not in `bun run test`.
 *
 *   docker compose -f database-compose.yml up -d firestore firestore-seed
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8380 bun tests/live/firestore-live-check.ts
 *
 * It builds the provider through the factory, as the server does, and runs the plan's browse and console scenarios
 * (tests/live/firestore-evidence-plan.ts) step by step, printing PASS or FAIL per step. Exits 1 on any failed step,
 * 2 without FIRESTORE_EMULATOR_HOST. FIRESTORE_LIVE_PROJECT overrides the seed's project id.
 */
import { createDatabaseProvider } from "@/lib/db/factory";
import type { FirestoreProvider } from "@/lib/db/providers/document/firestore/index";
import type { DatabaseConnection } from "@/lib/types";
import { runStep } from "./firestore-evidence";
import { FIRESTORE_EMULATOR, FIRESTORE_SCENARIOS } from "./firestore-evidence-plan";

export type LiveTarget =
  | { readonly host: string; readonly project: string }
  | { readonly exit: 2; readonly message: string };

export function liveTarget(env: Readonly<Record<string, string | undefined>>): LiveTarget {
  const host = env.FIRESTORE_EMULATOR_HOST?.trim();
  if (host === undefined || host === "") {
    return {
      exit: 2,
      message:
        "firestore-live-check: set FIRESTORE_EMULATOR_HOST (e.g. 127.0.0.1:8380 for the compose fixture) to a running emulator holding docker/firestore/seed.json",
    };
  }
  return { host, project: env.FIRESTORE_LIVE_PROJECT?.trim() || FIRESTORE_EMULATOR.project };
}

async function main(): Promise<number> {
  const target = liveTarget(process.env);
  if ("exit" in target) {
    console.error(target.message);
    return target.exit;
  }
  const connection: DatabaseConnection = {
    id: "firestore-live-check",
    name: "Firestore emulator",
    type: "firestore",
    database: target.project,
    createdAt: new Date(),
  };
  let failed = 0;
  for (const scenario of FIRESTORE_SCENARIOS.filter((candidate) => ["browse", "console"].includes(candidate.name))) {
    // oxlint-disable-next-line no-await-in-loop -- one provider per scenario, in the plan's order.
    const provider = (await createDatabaseProvider(connection)) as FirestoreProvider;
    try {
      for (const step of scenario.steps) {
        const started = performance.now();
        try {
          // oxlint-disable-next-line no-await-in-loop -- a step reads the session the steps before it opened.
          await runStep(provider, step);
          console.log(`PASS ${scenario.name} ${step.op} (${Math.round(performance.now() - started)} ms)`);
        } catch (error) {
          failed += 1;
          console.log(`FAIL ${scenario.name} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      // oxlint-disable-next-line no-await-in-loop -- the session ends before the next scenario opens one.
      await provider.disconnect();
    }
  }
  console.log(failed === 0 ? `all steps passed against ${target.host}` : `${failed} step(s) failed`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
