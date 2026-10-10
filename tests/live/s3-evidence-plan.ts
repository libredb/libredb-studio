/**
 * The scenarios tests/live/s3-evidence.ts records and tests/integration/db/s3-provider.test.ts replays: one per row of S3_ACCEPTANCE that a capture can hold, plus the object-surface scenario, plus the
 * scenarios the provider core, the console and the preview contribute, each with a runner of its own.
 *
 * A row is not recorded when it needs the live process (A9's ambient credentials and canary, A56's host address, A65's
 * search of every message), the tunnel (A63), wall-clock timing (A57), when its exchanges pass the scrub's 512 KiB
 * cap (A39's first row groups, A30's one-MiB ranged read), when it walks many/, whose 210 KB pages a listing scenario
 * leaves to folders/ so the captures stay under 8 MiB (A21; A22 and A24b record the paged listing), or when it is a
 * rule over every request (A26, A27, A33, A45, A53, A54), which the replay checks over every capture instead. A28 and
 * A37 record only the steps that read less than 512 KiB.
 */
import { S3_CAPTURE_TARGETS, type S3CaptureTarget } from "../helpers/s3-fixtures";
import {
  applicableSteps,
  runS3Row,
  runS3Surface,
  S3_ACCEPTANCE,
  s3LiveConnection,
  type S3AcceptanceRow,
  type S3Observed,
  type S3RunContext,
  type S3StepRun,
} from "./s3-live-support";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import { joinVirtualKey } from "@/lib/db/providers/objectstore/s3/names";

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
  "A21",
  "A26",
  "A27",
  "A30",
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
  A28: ["tagged"],
  A37: ["csv", "tsv", "json"],
  A52: ["readonly-off"],
};

/** The console scenarios over the seeded buckets (studio-bulk for the paged listing): each step's name and its console text. */
const CONSOLE_SCENARIO_STEPS = {
  "console-ls": [["ls", "aws s3 ls s3://studio-demo/data/"]],
  "console-list-objects-v2-token": [
    ["first-page", "aws s3api list-objects-v2 --bucket studio-bulk --prefix folders/ --max-items 3 --page-size 2"],
    [
      "starting-token",
      "aws s3api list-objects-v2 --bucket studio-bulk --prefix folders/ --max-items 3 --page-size 2 --starting-token ",
    ],
  ],
  "console-head-object": [["head-object", "aws s3api head-object --bucket studio-demo --key data/table.csv"]],
  "console-preview": [["preview", "preview s3://studio-demo/data/table.csv --max-rows 20"]],
} as const satisfies Readonly<Record<string, readonly (readonly [string, string])[]>>;

type ConsoleScenarioName = keyof typeof CONSOLE_SCENARIO_STEPS;

/** The step that runs the previous step's command again with the token its read-on notice names, appended to its text. */
const CONSOLE_TOKEN_STEP = "starting-token";

/** The read-on notice for list-objects-v2 ends "to read on, run the command again with --starting-token <token>."; a token is base64. */
const READ_ON_TOKEN = /to read on, run the command again with --starting-token ([A-Za-z0-9+/=]+)\.$/;

/** The token of the one read-on notice among a step's notices; a step without exactly one is a failed scenario. */
function readOnToken(step: string, notices: readonly string[] | undefined): string {
  const tokens = (notices ?? []).flatMap((notice) => {
    const match = READ_ON_TOKEN.exec(notice);
    return match === null ? [] : [match[1]];
  });
  if (tokens.length !== 1)
    throw new Error(`${step} gave ${tokens.length} read-on tokens, not one: ${JSON.stringify(notices ?? [])}`);
  return tokens[0];
}

/** One console scenario's commands, in order, as the browse principal (the console's reader role). */
async function consoleRunner(context: S3RunContext, name: ConsoleScenarioName): Promise<readonly S3StepRun[]> {
  const connection = s3LiveConnection(context.target, context.principals, { role: "browse" }, context.ca);
  const provider = new S3Provider(
    connection,
    {},
    {},
    {
      createTransport: context.createTransport,
      clock: context.clockFor(0),
      signerWrapper: context.signerWrapper,
    },
  );
  const runs: S3StepRun[] = [];
  let token: string | undefined;
  context.setStep("connect");
  await provider.connect();
  try {
    for (const [step, written] of CONSOLE_SCENARIO_STEPS[name]) {
      if (step === CONSOLE_TOKEN_STEP && token === undefined)
        throw new Error(`${name} ${step} runs after a step whose notice names a token`);
      const text = step === CONSOLE_TOKEN_STEP ? `${written}${token}` : written;
      context.setStep(step);
      const before = context.recorded().length;
      const sockets = context.sockets();
      const result = await provider.query(text, [], `${name}-${step}`);
      const notices = (result.warnings ?? []).map((warning) => warning.message);
      const ok: S3Observed = {
        rows: result.rowCount,
        names: result.fields,
        ...(result.columnTypes === undefined ? {} : { headers: { ...result.columnTypes } }),
        notices,
      };
      if (step === "first-page") token = readOnToken(`${name} ${step}`, notices);
      runs.push({
        summary: { step, ok, exchanges: context.recorded().length - before },
        context: { connection, command: text },
        sockets: context.sockets() - sockets,
      });
    }
  } finally {
    await provider.disconnect();
  }
  return runs;
}

/**
 * The objects the replay case opens in the Source tab, each step named after one. data/one-mib.bin is not among them:
 * its Source tab reads 1,000,000 bytes, past the scrub's 512 KiB exchange cap, so row A30 checks it live only.
 */
const PREVIEW_SOURCE_OBJECTS: readonly (readonly [string, string])[] = [
  ["source-table-csv", "data/table.csv"],
  ["source-rows-ndjson", "data/rows.ndjson"],
  ["source-fx-zstd", "parquet/fx-zstd.parquet"],
];
const PREVIEW_PARQUET_COMMAND = "preview s3://studio-demo/parquet/fx-zstd.parquet";

/** The scenario: the Source tab of three objects as root, then the console's preview of the Parquet object. */
async function runPreviewSource(run: S3RunContext): Promise<readonly S3StepRun[]> {
  const connection = s3LiveConnection(run.target, run.principals, { role: "root" }, run.ca);
  const provider = new S3Provider(
    connection,
    {},
    {},
    {
      createTransport: run.createTransport,
      clock: run.clockFor(0),
      signerWrapper: run.signerWrapper,
    },
  );
  const runs: S3StepRun[] = [];
  const measured = async (step: string, command: string | undefined, act: () => Promise<S3Observed>): Promise<void> => {
    run.setStep(step);
    const before = run.recorded().length;
    const sockets = run.sockets();
    const ok = await act();
    runs.push({
      summary: { step, ok, exchanges: run.recorded().length - before },
      context: { connection, ...(command === undefined ? {} : { command }) },
      sockets: run.sockets() - sockets,
    });
  };
  run.setStep("connect");
  await provider.connect();
  try {
    for (const [step, key] of PREVIEW_SOURCE_OBJECTS) {
      await measured(step, undefined, async () => {
        const document = await provider.readObjectSource!([joinVirtualKey("studio-demo", key)], "object");
        return { names: document.parts.map((part) => part.id) };
      });
    }
    await measured("console-parquet", PREVIEW_PARQUET_COMMAND, async () => {
      const result = await provider.query(PREVIEW_PARQUET_COMMAND, [], "preview-source-parquet");
      return {
        rows: result.rowCount,
        names: result.fields,
        headers: { ...(result.columnTypes ?? {}) },
        notices: (result.warnings ?? []).map((warning) => warning.message),
      };
    });
  } finally {
    await provider.disconnect();
  }
  return runs;
}

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
  {
    name: "console-ls",
    runner: (run) => consoleRunner(run, "console-ls"),
    steps: ["ls"],
    clockOffsetMs: 0,
    shows: "The console's aws s3 ls s3://studio-demo/data/ as the browse principal",
  },
  {
    name: "console-list-objects-v2-token",
    runner: (run) => consoleRunner(run, "console-list-objects-v2-token"),
    steps: ["first-page", "starting-token"],
    clockOffsetMs: 0,
    shows:
      "aws s3api list-objects-v2 --bucket studio-bulk --prefix folders/ --max-items 3 --page-size 2, then the same command with the --starting-token its read-on notice names",
  },
  {
    name: "console-head-object",
    runner: (run) => consoleRunner(run, "console-head-object"),
    steps: ["head-object"],
    clockOffsetMs: 0,
    shows: "aws s3api head-object --bucket studio-demo --key data/table.csv",
  },
  {
    name: "console-preview",
    runner: (run) => consoleRunner(run, "console-preview"),
    steps: ["preview"],
    clockOffsetMs: 0,
    shows: "preview s3://studio-demo/data/table.csv --max-rows 20 from the console",
  },
  {
    name: "preview-source",
    runner: (run) => runPreviewSource(run),
    clockOffsetMs: 0,
    shows:
      "The Source tab of data/table.csv, data/rows.ndjson and parquet/fx-zstd.parquet, then the console's preview of the Parquet object",
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
