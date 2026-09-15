import { describe, expect, test } from "bun:test";
import type { SpawnOutcome } from "../runner/execute";
import { runTestFiles } from "../runner/execute";

/** A junit report in the shape bun 1.4.2 writes, with these counts. */
function junit({ pass = 0, fail = 0, skip = 0 }: { pass?: number; fail?: number; skip?: number }): string {
  const cases = [
    ...Array.from({ length: pass }, (_, index) => `    <testcase name="passes ${index}" classname="" />`),
    ...Array.from(
      { length: fail },
      (_, index) => `    <testcase name="fails ${index}" classname=""><failure type="AssertionError" /></testcase>`,
    ),
    ...Array.from(
      { length: skip },
      (_, index) => `    <testcase name="skipped ${index}" classname=""><skipped /></testcase>`,
    ),
  ];
  const tests = pass + fail + skip;
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="${tests}" failures="${fail}" skipped="${skip}">
  <testsuite name="a.test.ts" file="a.test.ts" tests="${tests}" failures="${fail}" skipped="${skip}">
${cases.join("\n")}
  </testsuite>
</testsuites>`;
}

function passed(overrides: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    exitCode: 0,
    signal: null,
    output: "(a passing file's output)",
    durationMs: 1,
    timedOut: false,
    junitReport: junit({ pass: 3 }),
    ...overrides,
  };
}

const files = ["tests/unit/a.test.ts", "tests/unit/b.test.ts", "tests/unit/c.test.ts"];

async function run(overrides: Partial<Parameters<typeof runTestFiles>[0]> = {}) {
  return runTestFiles({
    files,
    jobs: 2,
    timeoutMs: 1000,
    coverage: false,
    coverageDir: "coverage/raw",
    coverageExempt: [],
    runFile: async () => passed(),
    ...overrides,
  });
}

describe("running the files", () => {
  test("a run where every file passes is a pass, with the tests counted", async () => {
    const summary = await run();

    expect(summary.failures).toEqual([]);
    expect(summary.totals.files).toBe(3);
    expect(summary.totals.filesPassed).toBe(3);
    expect(summary.totals.tests.pass).toBe(9);
    expect(summary.totals.tests.fail).toBe(0);
  });

  test("never more than `jobs` files at once, and every file runs exactly once", async () => {
    let running = 0;
    let peak = 0;
    const seen: string[] = [];

    await run({
      jobs: 2,
      files: Array.from({ length: 9 }, (_, index) => `tests/unit/${index}.test.ts`),
      runFile: async ({ file }) => {
        seen.push(file);
        running += 1;
        peak = Math.max(peak, running);
        await Promise.resolve();
        await Promise.resolve();
        running -= 1;
        return passed();
      },
    });

    expect(peak).toBe(2);
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });

  test("a non-zero exit is a failed file, whatever the code is", async () => {
    // A test calling process.exit(7) propagates 7 verbatim: measured with bun 1.4.2.
    const summary = await run({
      runFile: async ({ file }) =>
        file.endsWith("b.test.ts") ? passed({ exitCode: 7, output: "boom", junitReport: null }) : passed(),
    });

    expect(summary.failures.map((outcome) => outcome.file)).toEqual(["tests/unit/b.test.ts"]);
    expect(summary.failures[0]?.status).toBe("failed");
    expect(summary.totals.filesFailed).toBe(1);
  });

  test("a child killed by a signal is a failed file, not a passed one", async () => {
    // bun reports a signal death as exitCode null; `exitCode === 0` is false for it,
    // but `exitCode || 0` would turn it into a pass, which is the trap this pins.
    const summary = await run({
      runFile: async ({ file }) =>
        file.endsWith("c.test.ts")
          ? passed({ exitCode: null, signal: "SIGSEGV", output: "", junitReport: null })
          : passed(),
    });

    expect(summary.failures.map((outcome) => outcome.file)).toEqual(["tests/unit/c.test.ts"]);
    expect(summary.failures[0]?.signal).toBe("SIGSEGV");
  });

  test("a file that outran the timeout is reported as timed out, with what it printed", async () => {
    const summary = await run({
      runFile: async ({ file }) =>
        file.endsWith("a.test.ts")
          ? passed({
              exitCode: null,
              signal: "SIGTERM",
              output: "hung here",
              durationMs: 1000,
              timedOut: true,
              junitReport: null,
            })
          : passed(),
    });

    expect(summary.failures[0]?.status).toBe("timed-out");
    expect(summary.failures[0]?.output).toBe("hung here");
    expect(summary.totals.filesTimedOut).toBe(1);
  });

  test("a failing file's counts are still read, so the summary is the whole run", async () => {
    const summary = await run({
      runFile: async ({ file }) =>
        file.endsWith("b.test.ts") ? passed({ exitCode: 1, junitReport: junit({ pass: 2, fail: 1 }) }) : passed(),
    });

    expect(summary.totals.tests.pass).toBe(8);
    expect(summary.totals.tests.fail).toBe(1);
  });

  test("a file that wrote no report is counted as unknown, never as zero", async () => {
    const summary = await run({
      runFile: async () => passed({ exitCode: 1, output: "segfault", junitReport: null }),
    });

    expect(summary.totals.tests.pass).toBe(0);
    expect(summary.totals.filesWithoutCounts).toBe(3);
    expect(summary.outcomes.map((outcome) => outcome.report)).toEqual(["missing", "missing", "missing"]);
  });

  test("console text that looks like a summary cannot make a file pass", async () => {
    // Measured on 1.4.2: a file that registers no test and prints " 1 pass" exits 0, and
    // so does a test that prints a whole summary on stderr and then calls process.exit(0).
    // Neither writes a junit report, and a console reader took both for a pass.
    const spoofed = " 1 pass\n 0 pass\n 0 fail\nRan 7 tests across 1 file. [3.00ms]\n";
    const summary = await run({
      runFile: async ({ file }) =>
        file.endsWith("a.test.ts") ? passed({ output: spoofed, junitReport: null }) : passed({ output: spoofed }),
    });

    expect(summary.failures.map((outcome) => outcome.file)).toEqual(["tests/unit/a.test.ts"]);
    expect(summary.totals.filesWithoutCounts).toBe(1);
    // The control: the same console text beside a real report changes nothing.
    expect(summary.totals.filesPassed).toBe(2);
    expect(summary.totals.tests.pass).toBe(6);
  });

  test("a passing file that prints ' 1 fail' has no failure in the totals", async () => {
    const summary = await run({
      runFile: async () => passed({ output: " 1 fail\n 0 pass\n 1 fail\n", junitReport: junit({ pass: 1 }) }),
    });

    expect(summary.failures).toEqual([]);
    expect(summary.totals.tests).toEqual({ pass: 3, fail: 0, skip: 0, todo: 0 });
  });

  test("a report that exists but cannot be read fails the file, and is told apart from a missing one", async () => {
    const summary = await run({
      runFile: async ({ file }) =>
        file.endsWith("b.test.ts") ? passed({ junitReport: '<testsuites name="bun test"' }) : passed(),
    });

    expect(summary.failures.map((outcome) => outcome.file)).toEqual(["tests/unit/b.test.ts"]);
    expect(summary.failures[0]?.report).toBe("unreadable");
    expect(summary.outcomes.filter((outcome) => outcome.report === "read")).toHaveLength(2);
  });

  test("the skipped titles come from the report too", async () => {
    const summary = await run({
      files: ["tests/unit/a.test.ts"],
      runFile: async () => passed({ junitReport: junit({ pass: 1, skip: 1 }) }),
    });

    expect(summary.outcomes[0]?.skippedTests).toEqual(["skipped 0"]);
    expect(summary.outcomes[0]?.counts).toEqual({ pass: 1, fail: 0, skip: 1, todo: 0 });
  });

  test("a passing file's output is not kept once it has been reported, while a failing file's is", async () => {
    // Every outcome lives until the run ends, so keeping the output of files nobody
    // will look at again is what makes the runner's memory grow with the file count:
    // measured on 1.4.2, four passing files printing 100 MB each peaked at 406 MB
    // against 249 MB for one.
    const reported: string[] = [];
    const summary = await run({
      jobs: 1,
      runFile: async ({ file }) =>
        file.endsWith("b.test.ts")
          ? passed({ exitCode: 1, output: "the failure diff", junitReport: junit({ fail: 1 }) })
          : passed({ output: "chatter" }),
      onResult: (outcome) => reported.push(outcome.output),
    });

    // The control: a passing file's output does reach whoever reports it.
    expect(reported).toEqual(["chatter", "the failure diff", "chatter"]);
    expect(summary.outcomes.map((outcome) => outcome.output)).toEqual(["", "the failure diff", ""]);
    expect(summary.failures[0]?.output).toBe("the failure diff");
  });

  test("each file is given its own coverage directory, and exempt files get none", async () => {
    const given: Array<string | null> = [];

    await run({
      coverage: true,
      coverageDir: "out/raw",
      coverageExempt: ["tests/unit/b.test.ts"],
      runFile: async ({ coverageDir }) => {
        given.push(coverageDir);
        return passed();
      },
    });

    expect(given.sort()).toEqual([null, "out/raw/file-1", "out/raw/file-3"]);
  });

  test("without --coverage no child is given a coverage directory", async () => {
    const given: Array<string | null> = [];

    await run({
      runFile: async ({ coverageDir }) => {
        given.push(coverageDir);
        return passed();
      },
    });

    expect(given).toEqual([null, null, null]);
  });

  test("every result is reported as it lands, with a running position", async () => {
    const progress: string[] = [];

    await run({
      jobs: 1,
      onResult: (outcome, position, total) => progress.push(`${position}/${total} ${outcome.file}`),
    });

    expect(progress).toEqual(["1/3 tests/unit/a.test.ts", "2/3 tests/unit/b.test.ts", "3/3 tests/unit/c.test.ts"]);
  });

  test("a file whose report counts no test at all is a failure, even though bun exits 0", async () => {
    // Measured with bun 1.4.2: a file with no test in it exits 0 and writes no report at
    // all, which the missing-report rule already fails. A report saying tests="0" gets
    // the same verdict: the runner's own rule is that a discovered file runs.
    const summary = await run({
      runFile: async ({ file }) => (file.endsWith("a.test.ts") ? passed({ junitReport: junit({}) }) : passed()),
    });

    expect(summary.failures.map((outcome) => outcome.file)).toEqual(["tests/unit/a.test.ts"]);
    expect(summary.totals.filesFailed).toBe(1);
  });

  test("a file that exits 0 without writing a report is a failure, not a pass", async () => {
    // A test calling process.exit(0) ends the process there: bun exits 0, writes no
    // report, and every test after that line never runs. Measured with bun 1.4.2.
    // Counting that as a pass is the one way this runner could report a green run over
    // a tree whose tests did not all run.
    const summary = await run({
      runFile: async ({ file }) =>
        file.endsWith("c.test.ts") ? passed({ output: "bun test v1.4.2\n", junitReport: null }) : passed(),
    });

    expect(summary.failures.map((outcome) => outcome.file)).toEqual(["tests/unit/c.test.ts"]);
    expect(summary.totals.filesWithoutCounts).toBe(1);
  });

  test("a file whose report records a failure is a failed file, whatever its exit code says", async () => {
    // The verdict is read from the report, so a report carrying a failure is a failure
    // even when the child exited 0: otherwise the same summary prints "1 fail" in its
    // totals under a green file line and a green run. I could not make bun 1.4.2 exit 0
    // with a failure in its report (process.on("exit") setting exitCode, a beforeExit
    // handler calling process.exit(0), a stubbed process.exit, test.failing, retry,
    // --todo and --bail all still exit 1), so this is injected: it is the guard for a
    // shape the next bun may allow, and the counts are what the runner trusts.
    const summary = await run({
      runFile: async ({ file }) =>
        file.endsWith("b.test.ts") ? passed({ exitCode: 0, junitReport: junit({ pass: 2, fail: 1 }) }) : passed(),
    });

    expect(summary.failures.map((outcome) => outcome.file)).toEqual(["tests/unit/b.test.ts"]);
    expect(summary.totals.filesFailed).toBe(1);
    // The control: the other two files exit 0 with a report holding no failure and pass.
    expect(summary.totals.filesPassed).toBe(2);
    expect(summary.totals.tests.fail).toBe(1);
  });

  test("a child that finished as the timeout fired is read by its exit code, not by the timer", async () => {
    const summary = await run({
      runFile: async () => passed({ timedOut: true }),
    });

    expect(summary.failures).toEqual([]);
    expect(summary.totals.filesTimedOut).toBe(0);
  });

  test("a run that has been stopped starts no further file", async () => {
    // What a stop signal needs: the handler kills the children it has and sets the
    // gate, and no worker may pick up the next file while the handler is writing its
    // last line and removing the run's scratch directory. Measured on 1.4.2 without
    // it: a Ctrl+C whose cleanup failed left the runner alive and the queue ran on.
    const started: string[] = [];
    let stop = false;

    const summary = await run({
      jobs: 1,
      runFile: async ({ file }) => {
        started.push(file);
        stop = true;
        return passed();
      },
      shouldStop: () => stop,
    });

    expect(started).toEqual(["tests/unit/a.test.ts"]);
    expect(summary.outcomes).toHaveLength(1);
  });

  test("a run nobody stopped runs every file", async () => {
    // The control for the case above: the same shape with the gate closed.
    const started: string[] = [];

    await run({ jobs: 1, runFile: async ({ file }) => (started.push(file), passed()), shouldStop: () => false });

    expect(started).toEqual(files);
  });

  test("a runner that is handed no files refuses rather than reporting a green run", async () => {
    await expect(run({ files: [] })).rejects.toThrow(/no test files/i);
  });
});
