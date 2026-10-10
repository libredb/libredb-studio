/**
 * The scenarios tests/live/s3-evidence.ts records and tests/integration/db/s3-provider.test.ts replays: one per row of S3_ACCEPTANCE that a capture can hold, plus the object-surface scenario, plus the
 * scenarios the provider core, the console and the preview contribute, each with a runner of its own.
 *
 * A row is not recorded when it needs the live process (A9's ambient credentials and canary, A56's host address, A65's
 * search of every message), the tunnel (A63), wall-clock timing (A57), when its exchanges pass the scrub's 512 KiB
 * cap (A39's first row groups), or when it is a rule over every request (A26, A27, A33, A45, A53, A54), which the
 * replay checks over every capture instead. A37 records only the steps that read less than 512 KiB.
 */
import type { S3CaptureTarget } from "../helpers/s3-fixtures";
import { S3_CAPTURE_TARGETS } from "../helpers/s3-fixtures";
import {
  applicableSteps,
  runS3Row,
  runS3Surface,
  S3_ACCEPTANCE,
  type S3AcceptanceRow,
  type S3RunContext,
  type S3StepRun,
} from "./s3-live-support";
import type { S3Provider } from "@/lib/db/providers/objectstore/s3/index";

export interface S3ScenarioExtras {
  /** assertObjectSurface with S3_CONFORMANCE, passed in by a Bun caller, so this module loads under Node. */
  readonly assertSurface: (provider: S3Provider) => Promise<void>;
}

export interface S3Scenario {
  readonly name: string;
  /** The matrix row the scenario runs; absent for a scenario with a runner of its own. */
  readonly row?: S3AcceptanceRow["id"];
  /** A contributed scenario's own runner. */
  readonly runner?: (run: S3RunContext, extras: S3ScenarioExtras) => Promise<readonly S3StepRun[]>;
  /** The steps recorded; absent: every applicable step of the row's cell on the target. */
  readonly steps?: readonly string[];
  /** The clock offset the scenario injects, which the capture records. */
  readonly clockOffsetMs: number;
  /** Only these targets; absent: all five. */
  readonly targets?: readonly S3CaptureTarget[];
  /** The README's "What it shows" cell. */
  readonly shows: string;
}

export const S3_LIVE_ONLY_ROWS: readonly string[] = [
  "A9",
  "A26",
  "A27",
  "A33",
  "A39",
  "A45",
  "A53",
  "A54",
  "A56",
  "A57",
  "A63",
  "A65",
];

const RECORDED_STEPS: Readonly<Record<string, readonly string[]>> = {
  A8: ["ahead"],
  A37: ["csv", "tsv", "json"],
  A52: ["readonly-off"],
};

export const S3_SCENARIOS: readonly S3Scenario[] = [
  {
    name: "surface",
    runner: (run, extras) => runS3Surface(run, extras.assertSurface),
    clockOffsetMs: 0,
    shows:
      "The object-surface contract: the bucket kind counted and listed, the object kind reached through the Keys panel sample",
  },
  ...S3_ACCEPTANCE.filter((row) => !S3_LIVE_ONLY_ROWS.includes(row.id)).map(
    (row): S3Scenario => ({
      name: row.id,
      row: row.id,
      ...(RECORDED_STEPS[row.id] === undefined ? {} : { steps: RECORDED_STEPS[row.id] }),
      clockOffsetMs: row.id === "A8" ? 1_200_000 : 0,
      shows: row.behaviour,
    }),
  ),
  {
    name: "A8-behind",
    row: "A8",
    steps: ["behind"],
    clockOffsetMs: -90_000_000,
    targets: ["garage"],
    shows: "The clock 25 hours behind, which only Garage bounds",
  },
];

/** The scenarios a target records, each with the steps it records there; a scenario with no step there is left out. */
export function scenariosFor(target: S3CaptureTarget): { scenario: S3Scenario; steps: readonly string[] }[] {
  if (!S3_CAPTURE_TARGETS.includes(target)) throw new Error(`${target} records no captures`);
  return S3_SCENARIOS.flatMap((scenario) => {
    if (scenario.targets !== undefined && !scenario.targets.includes(target)) return [];
    if (scenario.row === undefined) return [{ scenario, steps: [scenario.name] }];
    const row = S3_ACCEPTANCE.find((candidate) => candidate.id === scenario.row);
    if (row === undefined) throw new Error(`${scenario.name} names ${scenario.row}, which S3_ACCEPTANCE does not hold`);
    const applicable = applicableSteps(row, target);
    const steps = (scenario.steps ?? applicable).filter((step) => applicable.includes(step));
    return steps.length === 0 ? [] : [{ scenario, steps }];
  });
}

export function runS3Scenario(
  scenario: S3Scenario,
  run: S3RunContext,
  steps: readonly string[],
  extras: S3ScenarioExtras,
): Promise<readonly S3StepRun[]> {
  if (scenario.runner !== undefined) return scenario.runner(run, extras);
  if (scenario.row === undefined) throw new Error(`${scenario.name} has neither a row nor a runner`);
  return runS3Row(scenario.row, run, steps);
}
