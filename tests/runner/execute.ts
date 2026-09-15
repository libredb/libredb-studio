/**
 * Running the files: one bun process per test file, several at a time.
 *
 * One process per file is not a performance choice, it is the isolation the suite
 * needs. bun's `mock.module()` is process-wide with no undo, and whole-module mocks
 * are the standard pattern in `tests/api/` (29 of its files mock `@/lib/auth`, and 36
 * files do across the whole suite), so
 * any file that needs the real module fails when it shares a process with one that
 * mocked it. bun 1.4.2 has `--isolate`, which resets the module registry per file
 * in ONE process, and it does contain `mock.module`, but it is also the subject of
 * oven-sh/bun#41655 (a NAPI finalizer SIGSEGV that reproduces serially on 1.4.2)
 * and this suite loads three NAPI addons: `better-sqlite3`, `oracledb` and
 * `@duckdb/node-api`. A process boundary needs no upstream fix, so that is what
 * this uses, and the concurrency is what pays for it.
 *
 * Spawning is injected so this module can be tested without processes.
 */
import { parseSkippedTests, readTestReport } from "./report";

export type TestCounts = { pass: number; fail: number; skip: number; todo: number };

export type SpawnOutcome = {
  exitCode: number | null;
  signal: string | null;
  /** Everything the child printed, for a reader. Nothing is decided from it. */
  output: string;
  durationMs: number;
  timedOut: boolean;
  /** The junit report the child wrote, or null when it wrote none. */
  junitReport: string | null;
};

export type FileOutcome = {
  file: string;
  status: "passed" | "failed" | "timed-out";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  output: string;
  counts: TestCounts | null;
  /** Whether the file's junit report was read, missing, or there but unreadable. */
  report: "read" | "missing" | "unreadable";
  skippedTests: string[];
};

export type RunSummary = {
  outcomes: FileOutcome[];
  failures: FileOutcome[];
  durationMs: number;
  jobs: number;
  /** The per-file budget a timed-out file ran into. */
  timeoutMs: number;
  totals: {
    files: number;
    filesPassed: number;
    filesFailed: number;
    filesTimedOut: number;
    filesWithoutCounts: number;
    tests: TestCounts;
  };
};

export type RunFile = (input: {
  file: string;
  index: number;
  coverageDir: string | null;
  timeoutMs: number;
}) => Promise<SpawnOutcome>;

export type RunTestFilesInput = {
  files: string[];
  jobs: number;
  timeoutMs: number;
  coverage: boolean;
  coverageDir: string;
  coverageExempt: readonly string[];
  runFile: RunFile;
  /**
   * Asked before a worker picks up a file: true stops the run where it is.
   *
   * It is what a stop signal needs, and it is here rather than in the caller because
   * only this loop knows when the next file would start. The files already running
   * are not this gate's business; the signal handler kills those children itself.
   */
  shouldStop?: () => boolean;
  onResult?: (outcome: FileOutcome, position: number, total: number) => void;
  now?: () => number;
};

function toOutcome(file: string, spawned: SpawnOutcome): FileOutcome {
  const { state, counts } = readTestReport(spawned.junitReport);
  // A signal death arrives as exitCode null. `exitCode === 0` is correctly false for
  // it, but any reading that coerces (`exitCode || 0`, `!exitCode`) turns a SIGSEGV
  // into a pass, so the status is derived once, here.
  //
  // Three more shapes are failures although the child exited 0:
  //
  // - No report, or one that cannot be read. bun writes the report when it reaches
  //   the end of a file, so its absence means the process left early: a test calling
  //   `process.exit(0)` does it (measured 1.4.2: exit 0, no report, and the tests
  //   after it never run), and so would a native addon calling exit(). Reporting
  //   that as a pass is how this runner would turn a red tree green, for every shape
  //   the report can see; the one it cannot see is `.only`, which bun honours, so a
  //   file with a committed `it.only` writes a report naming that test alone and
  //   exits 0 (measured 1.4.2: four other registered tests, one of them failing,
  //   absent from the report, from the totals and from the verdict). Nothing here can
  //   tell that report from a file that really holds one test, so a committed `.only`
  //   has to be refused before the run, not read out of what the run wrote.
  // - A report saying zero of everything. The runner's own rule is that a
  //   discovered file runs, so a file that registered nothing is either a
  //   registration that silently stopped happening or a file that should not exist.
  // - A report that records a failure. The counts are what the verdict is read from,
  //   so a green exit code does not overrule them: otherwise the summary would print
  //   that failure in its own totals under a passing file line.
  const registeredNothing = counts !== null && counts.pass + counts.fail + counts.skip + counts.todo === 0;
  // `timedOut` is the runner's own flag, set when it fired the kill. A child that
  // finished cleanly in the same millisecond still exited 0, and it did not time out.
  const killedByTimeout = spawned.timedOut && spawned.exitCode !== 0;
  const status = killedByTimeout
    ? "timed-out"
    : spawned.exitCode === 0 && counts !== null && !registeredNothing && counts.fail === 0
      ? "passed"
      : "failed";

  return {
    file,
    status,
    exitCode: spawned.exitCode,
    signal: spawned.signal,
    durationMs: spawned.durationMs,
    output: spawned.output,
    counts,
    report: state,
    // Read even from a report the counts could not be taken from: what it did reach
    // still names tests, and this is the only place a skip's reason is ever printed.
    // The summary prints those titles under an unknown count rather than dropping them
    // (see formatSummary), so this parse is read by someone in that case too.
    skippedTests: spawned.junitReport === null ? [] : parseSkippedTests(spawned.junitReport),
  };
}

/**
 * The per-file coverage directory, or null for a file that must not be measured.
 *
 * The index is the file's position in the sorted selection, which is what makes the
 * directory names stable and collision-free for `scripts/merge-lcov.mjs` to read
 * back.
 */
export function coverageDirFor(
  file: string,
  index: number,
  { coverage, coverageDir, coverageExempt }: Pick<RunTestFilesInput, "coverage" | "coverageDir" | "coverageExempt">,
): string | null {
  if (!coverage || coverageExempt.includes(file)) return null;
  return `${coverageDir}/file-${index + 1}`;
}

export async function runTestFiles(input: RunTestFilesInput): Promise<RunSummary> {
  const { files, jobs, timeoutMs, runFile, onResult, shouldStop, now = () => Date.now() } = input;
  if (files.length === 0) {
    throw new Error("The runner was handed no test files, so there is nothing to report as passing.");
  }

  const startedAt = now();
  const outcomes: FileOutcome[] = [];
  let next = 0;
  let finished = 0;

  async function worker(): Promise<void> {
    while (next < files.length) {
      if (shouldStop?.()) return;
      const index = next;
      next += 1;
      const file = files[index] as string;
      // oxlint-disable-next-line no-await-in-loop -- one file at a time per worker; the jobs come from the workers.
      const spawned = await runFile({ file, index, coverageDir: coverageDirFor(file, index, input), timeoutMs });
      const outcome = toOutcome(file, spawned);
      finished += 1;
      onResult?.(outcome, finished, files.length);
      // Every outcome is kept until the run ends, and nothing reads a passing file's
      // output after it has been reported, so it is dropped here rather than carried:
      // otherwise the runner's memory grows with the whole run's output, passing
      // files included (measured on 1.4.2: four passing files printing 100 MB each
      // peaked at 406 MB, against 249 MB for one).
      outcomes.push(outcome.status === "passed" ? { ...outcome, output: "" } : outcome);
    }
  }

  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, () => worker()));

  const totals = {
    files: files.length,
    filesPassed: outcomes.filter((outcome) => outcome.status === "passed").length,
    filesFailed: outcomes.filter((outcome) => outcome.status === "failed").length,
    filesTimedOut: outcomes.filter((outcome) => outcome.status === "timed-out").length,
    filesWithoutCounts: outcomes.filter((outcome) => outcome.counts === null).length,
    tests: outcomes.reduce<TestCounts>(
      (sum, outcome) => ({
        pass: sum.pass + (outcome.counts?.pass ?? 0),
        fail: sum.fail + (outcome.counts?.fail ?? 0),
        skip: sum.skip + (outcome.counts?.skip ?? 0),
        todo: sum.todo + (outcome.counts?.todo ?? 0),
      }),
      { pass: 0, fail: 0, skip: 0, todo: 0 },
    ),
  };

  // Failures in the order the files were selected, not the order they happened to
  // finish in, so two runs of the same red tree print the same list.
  const order = new Map(files.map((file, index) => [file, index]));
  const failures = outcomes
    .filter((outcome) => outcome.status !== "passed")
    .sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0));

  return { outcomes, failures, durationMs: now() - startedAt, jobs, timeoutMs, totals };
}
