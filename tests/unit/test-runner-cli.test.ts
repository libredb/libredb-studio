import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

// The runner end to end, driven the way a contributor and CI drive it. The unit
// tests beside this one cover discovery, the command line, the pool and the
// report against injected data; these cases are here because three of the
// runner's decisions can only be wrong against the real bun binary: that a file
// is addressed as a path and not as a substring filter, that a child's exit code
// reaches the runner's own exit code, and that coverage lands where the merge
// expects it.
const root = path.resolve(import.meta.dir, "../..");
const RUNNER = "tests/run-tests.ts";

// The cases that need a deliberately failing, skipping or empty test file run the
// runner in a SANDBOX: a temporary directory holding a copy of tests/run-tests.ts and
// tests/runner/, whose own tests/ tree holds nothing but the fixture. The runner finds
// its root from its own location, so the copy discovers only that tree.
//
// The fixture used to be written into this repository's tests/unit/. That had two
// costs: a run interrupted between the write and the cleanup left a failing file the
// discovery rule then collects in every later run, and every other test file that
// walks tests/ while this one runs (the discovery test, the backlog guard, the
// security gate asking --list) could see a file that exists for half a second.
const sandboxes: string[] = [];

/** Private TMPDIRs, so a stopped run's scratch directory can be seen (or not) on its own. */
const privateTmpDirs: string[] = [];

afterEach(() => {
  for (const directory of privateTmpDirs.splice(0)) {
    // The removal-failure case takes the write permission away, and it has to come back
    // here: without it this cleanup would fail for the same reason the runner did.
    if (process.platform !== "win32") chmodSync(directory, 0o755);
    rmSync(directory, { recursive: true, force: true });
  }
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function sandboxWith(fixture: string): string {
  const sandbox = mkdtempSync(path.join(tmpdir(), "runner-sandbox-"));
  sandboxes.push(sandbox);
  cpSync(path.join(root, "tests/run-tests.ts"), path.join(sandbox, "tests/run-tests.ts"));
  cpSync(path.join(root, "tests/runner"), path.join(sandbox, "tests/runner"), { recursive: true });
  mkdirSync(path.join(sandbox, "tests/unit"), { recursive: true });
  // writeFileSync, not Bun.write: Bun.write returns a promise, and leaving it
  // unawaited let the runner start against a file that was still empty. bun then
  // ran 0 tests and exited 0, so this passed on Linux and failed on windows-latest
  // (measured 2026-09-15).
  writeFileSync(path.join(sandbox, "tests/unit/fixture.test.ts"), fixture);
  return sandbox;
}

function runInSandbox(
  sandbox: string,
  selectors: string[] = ["tests/unit/fixture.test.ts"],
  env: Record<string, string | undefined> = withoutRequirements(),
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, "tests/run-tests.ts", ...selectors], { cwd: sandbox, env });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/**
 * This process's environment without the run requirements CI sets. The CI job that runs this
 * file exports LIBREDB_REQUIRE_HELM=1 for the real suite, and a sandbox child inheriting it
 * would refuse to run for a reason that belongs to the parent, not to the case under test.
 */
function withoutRequirements(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.LIBREDB_REQUIRE_HELM;
  return env;
}

/** A test file that says it started and then waits for the runner to be stopped. */
function waitingFixture(name: string): string {
  return [
    'import { test } from "bun:test";',
    'import { writeFileSync } from "node:fs";',
    'import path from "node:path";',
    'test("waits to be interrupted", async () => {',
    `  writeFileSync(path.join(process.env.RUNNER_MARKERS as string, "${name}.started"), "");`,
    "  await Bun.sleep(30_000);",
    "}, 60_000);",
    "",
  ].join("\n");
}

type WaitingRun = { sandbox: string; markers: string; scratchParent: string };

/** Two waiting files, run one at a time, with a TMPDIR of this run's own. */
function sandboxThatWaits(): WaitingRun {
  const sandbox = sandboxWith(waitingFixture("fixture"));
  writeFileSync(path.join(sandbox, "tests/unit/second.test.ts"), waitingFixture("second"));
  const markers = path.join(sandbox, "markers");
  mkdirSync(markers);
  const scratchParent = mkdtempSync(path.join(tmpdir(), "runner-tmpdir-"));
  privateTmpDirs.push(scratchParent);
  return { sandbox, markers, scratchParent };
}

/**
 * A test file that prints `kibibytes` KiB on its own stdout and then fails.
 *
 * The pause before it fails is load-bearing, not politeness: measured, bun 1.4.2 drops
 * part of a child's queued stdout when the child exits under CPU load, and without the
 * pause 2 of 6 loaded runs delivered too little for the runner's own pipe to fill, so
 * the cases built on a stuck reader stopped being about a stuck reader at all.
 */
function floodingFixture(kibibytes: number): string {
  return [
    'import { expect, test } from "bun:test";',
    'test("prints a lot and then fails", async () => {',
    '  const line = `${"k".repeat(1023)}\\n`;',
    `  for (let index = 0; index < ${kibibytes}; index += 1) process.stdout.write(line);`,
    "  await Bun.sleep(500);",
    "  expect(1).toBe(2);",
    "});",
    "",
  ].join("\n");
}

/**
 * A run whose first file floods stdout and fails, and whose second file then waits.
 *
 * The flood is what makes a signal case about a STUCK reader: a pipe holds 64 KiB on
 * Linux, so once the first file's output has been printed and nobody is reading, the
 * runner's next write cannot complete until the reader comes back.
 */
function sandboxThatFloodsThenWaits(): WaitingRun {
  const sandbox = sandboxWith(floodingFixture(512));
  writeFileSync(path.join(sandbox, "tests/unit/second.test.ts"), waitingFixture("second"));
  const markers = path.join(sandbox, "markers");
  mkdirSync(markers);
  const scratchParent = mkdtempSync(path.join(tmpdir(), "runner-tmpdir-"));
  privateTmpDirs.push(scratchParent);
  return { sandbox, markers, scratchParent };
}

/**
 * A sandbox whose run reaches the coverage merge, with a merge script of its own.
 *
 * The merge only happens when there is something to merge, so the fixture has to cover
 * a source file: with no src/ the run ends at "No coverage report was written". The
 * script is spawned as `node scripts/merge-lcov.mjs` from the root the runner found
 * beside itself, which is this sandbox.
 */
function sandboxThatMerges(mergeScript: string): { sandbox: string; markers: string; args: string[] } {
  const sandbox = sandboxWith(
    'import { expect, test } from "bun:test";\n' +
      'import { covered } from "../../src/covered";\n' +
      'test("covers a source file", () => {\n  expect(covered()).toBe(1);\n});\n',
  );
  mkdirSync(path.join(sandbox, "src"), { recursive: true });
  writeFileSync(path.join(sandbox, "src/covered.ts"), "export function covered(): number {\n  return 1;\n}\n");
  mkdirSync(path.join(sandbox, "scripts"), { recursive: true });
  writeFileSync(path.join(sandbox, "scripts/merge-lcov.mjs"), mergeScript);
  const markers = path.join(sandbox, "markers");
  mkdirSync(markers);
  return {
    sandbox,
    markers,
    args: [
      "tests/unit/fixture.test.ts",
      "--coverage",
      `--coverage-dir=${path.join(sandbox, "raw")}`,
      `--merge-into=${path.join(sandbox, "lcov.info")}`,
    ],
  };
}

async function waitForFile(file: string, within = 15_000): Promise<void> {
  const deadline = Date.now() + within;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${file} was not written within ${within} ms`);
    // oxlint-disable-next-line no-await-in-loop -- polling: the next look has to come after this wait.
    await Bun.sleep(25);
  }
}

/** Starts the run, waits until its first file is running, then signals it. */
async function signalTheRun(
  { sandbox, markers, scratchParent }: WaitingRun,
  signal: NodeJS.Signals,
  beforeSignalling?: () => void,
): Promise<{ exitCode: number | null; signalCode: string | null; stdout: string; stderr: string }> {
  const runner = Bun.spawn([process.execPath, "tests/run-tests.ts", "--jobs=1", "tests/unit"], {
    cwd: sandbox,
    env: { ...withoutRequirements(), TMPDIR: scratchParent, RUNNER_MARKERS: markers },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForFile(path.join(markers, "fixture.started"));
  beforeSignalling?.();
  runner.kill(signal);

  const [stdout, stderr] = await Promise.all([
    new Response(runner.stdout as ReadableStream).text(),
    new Response(runner.stderr as ReadableStream).text(),
  ]);
  const exitCode = await runner.exited;
  return { exitCode, signalCode: runner.signalCode, stdout, stderr };
}

/**
 * Starts the run, waits until its SECOND file is running, and signals it without ever
 * reading stdout, so the runner is stuck on a write it cannot finish.
 *
 * node:child_process, not Bun.spawn: measured on bun 1.4.2, a Bun.spawn parent drains
 * a "pipe" stdout into a buffer of its own whether or not anything reads the stream, so
 * the child never meets backpressure and there is no stall to test. A node child's
 * stdio stream starts paused and stays paused, and the kernel pipe (64 KiB on Linux)
 * then fills behind the first file's 512 KiB.
 *
 * Nothing of that stdout is returned: measured, bun destroys the stream at the exit
 * event, so what the pipe still held is gone by the time there is anything to read it
 * with. How long the run took is the evidence instead, and it is the better evidence:
 * only a write that never completed can spend the whole grace.
 */
async function signalTheStuckRun(
  { sandbox, markers, scratchParent }: WaitingRun,
  signals: NodeJS.Signals[],
  gapMs = 500,
): Promise<{ exitCode: number | null; signalCode: string | null; elapsedMs: number }> {
  const runner = spawn(process.execPath, ["tests/run-tests.ts", "--jobs=1", "tests/unit"], {
    cwd: sandbox,
    env: { ...withoutRequirements(), TMPDIR: scratchParent, RUNNER_MARKERS: markers },
    stdio: ["ignore", "pipe", "pipe"] as const,
  });
  // stderr is read, so only stdout is the stuck stream: a scratch-removal failure
  // would otherwise be stuck too, and that is a different case, tested on its own.
  (runner.stderr as Readable).resume();
  await waitForFile(path.join(markers, "second.started"));

  const startedAt = Date.now();
  const ended = new Promise<{ exitCode: number | null; signalCode: string | null }>((resolve) => {
    runner.once("exit", (exitCode, signalCode) => resolve({ exitCode, signalCode }));
  });
  for (const [index, signal] of signals.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- the gap between two signals is the point.
    if (index > 0) await Bun.sleep(gapMs);
    runner.kill(signal);
  }
  const { exitCode, signalCode } = await ended;
  return { exitCode, signalCode, elapsedMs: Date.now() - startedAt };
}

/**
 * Drives the runner with a reader that is always a little behind, the way a CI log
 * consumer is: it takes a chunk, stops for a moment, and takes the next.
 *
 * node:child_process again, for the reason signalTheStuckRun gives: a Bun.spawn parent
 * drains the pipe itself, so there is no way to be behind it.
 */
async function runWithASlowReader(
  sandbox: string,
  args: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const runner = spawn(process.execPath, ["tests/run-tests.ts", ...args], {
    cwd: sandbox,
    env: withoutRequirements(),
    stdio: ["ignore", "pipe", "pipe"] as const,
  });
  const stdout = runner.stdout as Readable;
  const chunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    stdout.pause();
    setTimeout(() => stdout.resume(), 200);
  });

  const [stderr, exitCode] = await Promise.all([
    new Promise<string>((resolve, reject) => {
      const parts: Buffer[] = [];
      (runner.stderr as Readable).on("data", (chunk: Buffer) => parts.push(chunk));
      (runner.stderr as Readable).once("end", () => resolve(Buffer.concat(parts).toString()));
      (runner.stderr as Readable).once("error", reject);
    }),
    new Promise<number | null>((resolve) => {
      runner.once("close", (code) => resolve(code));
    }),
  ]);
  return { exitCode, stdout: Buffer.concat(chunks).toString(), stderr };
}

/** Drives the runner with a piped stdout, takes one chunk, and then goes away for good. */
async function runWithAReaderThatLeaves(
  sandbox: string,
  selectors: string[],
): Promise<{ exitCode: number | null; firstChunk: string; stderr: string }> {
  const runner = Bun.spawn([process.execPath, "tests/run-tests.ts", "--jobs=1", ...selectors], {
    cwd: sandbox,
    env: withoutRequirements(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = (runner.stdout as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  // Measured on bun 1.4.2: cancelling closes the read end, and the runner's next write
  // fails with EPIPE, which is exactly what `| head -1` does to it.
  await reader.cancel();
  const stderr = await new Response(runner.stderr as ReadableStream).text();
  const exitCode = await runner.exited;
  return { exitCode, firstChunk: new TextDecoder().decode(value), stderr };
}

function runRunner(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, RUNNER, ...args], { cwd: root });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("the test runner, end to end", () => {
  test("--list prints one repository-relative path per line and nothing else", () => {
    const { exitCode, stdout } = runRunner(["--list", "tests/unit/test-runner-cli.test.ts"]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("tests/unit/test-runner-cli.test.ts\n");
  });

  test("a passing file exits 0 and is reported with its test count", () => {
    const { exitCode, stdout } = runRunner(["tests/unit/test-runner-options.test.ts"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("tests/unit/test-runner-options.test.ts");
    expect(stdout).toContain("PASS");
    expect(stdout).toContain("1 file: 1 passed");
  });

  test("a single file is addressed as a path, so a name that is a substring of another does not drag it in", () => {
    // `bun test tests/unit/x.test.ts` without a leading ./ is a SUBSTRING FILTER,
    // which would also run every file whose path contains that string. The runner
    // passes ./<path>, so exactly one file runs. tests/unit/lib/auth.test.ts is the
    // live example: tests/unit/lib/auth-jwt-config.test.ts and
    // tests/unit/lib/auth-compare.test.ts share its prefix.
    const { exitCode, stdout } = runRunner(["tests/unit/lib/auth.test.ts"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("1 file: 1 passed");
    expect(stdout).not.toContain("auth-jwt-config");
  });

  test("a selector that names nothing exits 2 and says so, rather than passing an empty run", () => {
    const { exitCode, stdout, stderr } = runRunner(["tests/unit/there-is-no-such-file.test.ts"]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("matched no test files");
    // Nothing on stdout: the error path adds "the reason is on stderr" only once the
    // run has started and stdout has something of its own to drain, and this one never
    // started. The paired control is "an error after the run started", further down,
    // which reaches the same error path and DOES print that line.
    expect(stdout).toBe("");
  });

  test("an unknown option exits 2 and names the option", () => {
    const { exitCode, stderr } = runRunner(["--parallel"]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("--parallel");
  });

  test("a failing test file makes the runner exit 1 and prints the child's own failure output", () => {
    const sandbox = sandboxWith(
      'import { expect, test } from "bun:test";\ntest("deliberately failing fixture", () => {\n  expect(1).toBe(2);\n});\n',
    );
    const { exitCode, stdout, stderr } = runInSandbox(sandbox);

    expect(exitCode, `runner stderr: ${stderr}`).toBe(1);
    expect(stdout).toContain("FAIL");
    expect(stdout).toContain("deliberately failing fixture");
    expect(stdout).toContain("re-run alone with: bun tests/run-tests.ts tests/unit/fixture.test.ts");
  });

  test("a skipped test reaches the summary by name, because bun prints that name nowhere", () => {
    // The reason a test did not run lives in its title by convention here, and bun
    // reports only a count, so the runner reads its junit report. Without this, a
    // Windows run that skips a dozen files says "0 fail" and names nothing.
    // The second shape is the one the Windows packaging tests use: the reason sits on a
    // skipped DESCRIBE, and the test inside is named only for what it checks.
    const sandbox = sandboxWith(
      'import { describe, expect, test } from "bun:test";\n' +
        'test.skipIf(true)("needs a POSIX shell, which this platform has not", () => {\n' +
        "  expect(1).toBe(1);\n});\n" +
        'describe.skip("snap launcher [skipped: no sh on this platform]", () => {\n' +
        '  test("exports SNAP_DATA", () => {\n    expect(1).toBe(1);\n  });\n});\n' +
        'test("runs anyway", () => {\n  expect(1).toBe(1);\n});\n',
    );
    const { exitCode, stdout, stderr } = runInSandbox(sandbox);

    expect(exitCode, `runner stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain("Files with skipped tests:");
    expect(stdout).toContain("needs a POSIX shell, which this platform has not");
    expect(stdout).toContain("snap launcher [skipped: no sh on this platform] > exports SNAP_DATA");
  });

  test("the summary survives a failing file that printed a megabyte into a stdout that is a pipe", () => {
    // bun writes to a pipe asynchronously, so anything still pending when the runner
    // calls process.exit is thrown away. Measured on 1.4.2 through this same
    // Bun.spawnSync capture: a failing file printing 1 MiB lost about a third of it
    // AND the whole summary, so a CI log said the run was red and never said which
    // file or how to re-run it. A megabyte, not the 200 KB where the loss starts,
    // because the loss is timing dependent and every capture lost it at this size.
    //
    // What is asserted is what the RUNNER guarantees: its own last lines, and that the
    // child's output reached stdout at all. The exact line count is not guaranteed and
    // is not asserted: measured under CPU load, bun 1.4.2 drops part of a child's own
    // queued stdout when the child exits (3 of 10 loaded runs here lost between 20%
    // and 90% of it), and it does so with no runner in the picture at all, so the
    // runner's drain cannot fix it and a count would be red on a busy CI machine.
    const line = "k".repeat(1023);
    const sandbox = sandboxWith(
      'import { expect, test } from "bun:test";\n' +
        'test("prints a megabyte and then fails", () => {\n' +
        `  for (let index = 0; index < 1024; index += 1) process.stdout.write("${line}\\n");\n` +
        "  expect(1).toBe(2);\n});\n",
    );
    const { exitCode, stdout, stderr } = runInSandbox(sandbox);

    expect(exitCode, `runner stderr: ${stderr}`).toBe(1);
    expect(stdout).toContain("Failed files:");
    expect(stdout).toContain("re-run alone with: bun tests/run-tests.ts tests/unit/fixture.test.ts");
    expect(stdout).toContain("1 file: 0 passed, 1 failed");
    // The paired control for the assertions above: the child's output really was in
    // the way, so the summary was written after a megabyte rather than instead of it.
    expect(stdout).toContain(line);
  });

  test("a reader that takes one line and leaves keeps the run's own exit code, green and red", async () => {
    // `bun run test | head -1` answered 2, "the runner could not do its job", for a run
    // where every test passed: the awaited summary write got EPIPE and the error path
    // took the verdict away. The committed runner answered 0 and 1 here, so this was a
    // regression, and it destroys the one distinction exit code 2 exists to carry.
    const green = sandboxWith(
      'import { expect, test } from "bun:test";\n' +
        'test("takes a moment and passes", async () => {\n  await Bun.sleep(700);\n  expect(1).toBe(1);\n});\n',
    );
    const passing = await runWithAReaderThatLeaves(green, ["tests/unit/fixture.test.ts"]);

    expect({ exitCode: passing.exitCode, stderr: passing.stderr }).toEqual({ exitCode: 0, stderr: "" });
    // Not vacuous: the summary had NOT been written when the reader went, so the run
    // really did meet a broken pipe rather than finishing before the reader left.
    expect(passing.firstChunk).toContain("1 files from tests/unit/fixture.test.ts");
    expect(passing.firstChunk).not.toContain("1 file: 1 passed");

    // The paired control: the same sandbox, read to the end, is 0 WITH its summary.
    const drained = runInSandbox(green);
    expect(drained.exitCode).toBe(0);
    expect(drained.stdout).toContain("1 file: 1 passed");

    const red = sandboxWith(floodingFixture(512));
    const failing = await runWithAReaderThatLeaves(red, ["tests/unit/fixture.test.ts"]);

    expect(failing.exitCode).toBe(1);
    expect(failing.firstChunk).not.toContain("Failed files:");
    expect(runInSandbox(red).exitCode).toBe(1);
  }, 30_000);

  test("a file that prints more than the capture keeps is cut in the middle, and says so once", () => {
    // tests/runner/capture.ts keeps 1 MiB at each end of each stream. Nothing else
    // reaches that bound: the real tree's largest stdout is 154 KB, and the megabyte
    // case above sits exactly on the head limit, so without this case reverting the
    // two captureBounded calls to an unbounded read passes the whole suite (measured
    // by mutation) and no reader ever meets the elision line in a CI log.
    //
    // 6 MiB against a 2 MiB threshold, and a pause before the file ends: measured under
    // load, bun 1.4.2 loses part of a child's queued stdout at the child's own exit, so
    // the fixture gives the runner time to read it and keeps a 3x margin over the bound.
    const sandbox = sandboxWith(
      'import { expect, test } from "bun:test";\n' +
        'test("prints six mebibytes and then fails", async () => {\n' +
        '  const line = `${"k".repeat(1023)}\\n`;\n' +
        "  for (let index = 0; index < 6 * 1024; index += 1) process.stdout.write(line);\n" +
        "  await Bun.sleep(500);\n" +
        "  expect(1).toBe(2);\n});\n",
    );
    const { exitCode, stdout, stderr } = runInSandbox(sandbox);

    const elisions = stdout.match(/\[runner: \d+ bytes of stdout elided here\]/g) ?? [];
    expect({ exitCode, elisions: elisions.length }, `runner stderr: ${stderr}`).toEqual({ exitCode: 1, elisions: 1 });
    // The verdict is unchanged by the cut: nothing is decided from this text.
    expect(stdout).toContain("FAIL");
    expect(stdout).toContain("1 file: 0 passed, 1 failed  |  1 test: 0 pass, 1 fail");
    // The paired control for the count above: stderr stayed well inside its own bound,
    // so "exactly one" is a statement about which stream was cut, not about parsing.
    expect(stdout).not.toContain("bytes of stderr elided here");
  }, 60_000);

  test("a file that needs Helm is named as not run where Helm is unusable, and refused where it is required", () => {
    // The sandbox has no charts/ directory, so Helm is unusable in it on every machine: either
    // there is no helm binary, or there is one and no built chart dependency beside it.
    const sandbox = sandboxWith(
      'import { expect, test } from "bun:test";\ntest("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n',
    );
    writeFileSync(
      path.join(sandbox, "tests/unit/chart.test.ts"),
      [
        ["//", "@requires", "helm"].join(" "),
        'import { test } from "bun:test";',
        'test("renders", () => {});',
        "",
      ].join("\n"),
    );

    const relaxed = runInSandbox(sandbox, ["tests/unit"]);
    expect(relaxed.exitCode, `runner stderr: ${relaxed.stderr}`).toBe(0);
    expect(relaxed.stdout).toContain("Files not run on this machine:");
    expect(relaxed.stdout).toContain("tests/unit/chart.test.ts");
    expect(relaxed.stdout).toContain("1 file: 1 passed");

    const strict = runInSandbox(sandbox, ["tests/unit"], { ...withoutRequirements(), LIBREDB_REQUIRE_HELM: "1" });
    expect(strict.exitCode).toBe(2);
    expect(strict.stderr).toContain("tests/unit/chart.test.ts needs helm");
    expect(strict.stderr).toContain("LIBREDB_REQUIRE_HELM=1");
  });

  test("a file that registers no test is a failure, not a green line", () => {
    const sandbox = sandboxWith('import { expect } from "bun:test";\nexpect(1).toBe(1);\n');
    const { exitCode, stdout, stderr } = runInSandbox(sandbox);

    expect(exitCode, `runner stderr: ${stderr}`).toBe(1);
    expect(stdout).toContain("FAIL");
  });

  test("a file that registers no test but prints a count line is still a failure", () => {
    // Measured on 1.4.2 before the counts came from the junit report: this was PASS, exit 0.
    const sandbox = sandboxWith('console.log(" 1 pass");\n');
    const { exitCode, stdout, stderr } = runInSandbox(sandbox);

    expect(exitCode, `runner stderr: ${stderr}`).toBe(1);
    expect(stdout).toContain("FAIL");
    expect(stdout).toContain("wrote no test report");
  });

  test("a test that prints a whole summary on stderr and then exits 0 cannot turn the file green", () => {
    const sandbox = sandboxWith(
      'import { expect, test } from "bun:test";\n' +
        'test("a", () => {\n  expect(1).toBe(1);\n});\n' +
        'test("b", () => {\n  console.error("\\n 7 pass\\n 0 fail\\nRan 7 tests across 1 file.");\n  process.exit(0);\n});\n' +
        'test("c", () => {\n  throw new Error("never reached");\n});\n',
    );
    const { exitCode, stdout, stderr } = runInSandbox(sandbox);

    expect(exitCode, `runner stderr: ${stderr}`).toBe(1);
    expect(stdout).toContain("FAIL");
    // The spoofed block is printed as part of the failing file's output, which is the
    // control for the assertion that matters: none of it reached the run's totals.
    expect(stdout).toContain(" 7 pass");
    expect(stdout).toContain("1 file: 0 passed, 1 failed  |  0 tests: 0 pass");
  });

  test("a passing test that prints fail counts is reported with the counts bun recorded", () => {
    const sandbox = sandboxWith(
      'import { expect, test } from "bun:test";\n' +
        'test("a", () => {\n  console.log(" 1 fail");\n  console.error(" 1 fail");\n  expect(1).toBe(1);\n});\n',
    );
    const { exitCode, stdout, stderr } = runInSandbox(sandbox);

    expect(exitCode, `runner stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain("1 file: 1 passed  |  1 test: 1 pass  |");
    expect(stdout).not.toContain("1 pass 2 fail");
  });

  test("a --reporter-outfile forwarded to bun cannot move the report the runner reads", () => {
    const sandbox = sandboxWith(
      'import { expect, test } from "bun:test";\ntest("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n',
    );
    const elsewhere = path.join(sandbox, "elsewhere.xml");
    const { exitCode, stdout, stderr } = runInSandbox(sandbox, [
      "tests/unit/fixture.test.ts",
      "--",
      `--reporter-outfile=${elsewhere}`,
    ]);

    expect(exitCode, `runner stdout: ${stdout}\nrunner stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain("1 file: 1 passed  |  1 test: 1 pass  |");
    expect(existsSync(elsewhere)).toBe(false);
  });

  // Windows delivers none of these to a piped child (SIGINT and SIGBREAK come from a
  // console event the test would have to share a console to raise, and SIGTERM is never
  // delivered there at all), so the end-to-end cases are POSIX only. The stop gate they
  // rest on is unit-tested on every platform in tests/unit/test-runner-execute.test.ts.
  const onlyPosixSignals = process.platform === "win32";

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
    ["SIGINT", 130],
  ] as const) {
    test.skipIf(onlyPosixSignals)(
      `${signal} stops the run: exit ${code}, the scratch directory removed, and no further file started [skipped: Windows delivers no ${signal} to a piped child]`,
      async () => {
        const waiting = sandboxThatWaits();
        const { exitCode, signalCode, stdout } = await signalTheRun(waiting, signal);

        expect({ exitCode, signalCode }).toEqual({ exitCode: code, signalCode: null });
        expect(stdout).toContain(`Interrupted (${signal}).`);
        // Nothing of the run's own verdict: the files it killed are not failures.
        expect(stdout).not.toContain("Failed files:");
        expect(readdirSync(waiting.scratchParent)).toEqual([]);
        // The paired control for the negative: the first file did start, the second did not.
        expect(existsSync(path.join(waiting.markers, "fixture.started"))).toBe(true);
        expect(existsSync(path.join(waiting.markers, "second.started"))).toBe(false);
      },
      30_000,
    );
  }

  test.skipIf(onlyPosixSignals)(
    "SIGINT ends a run whose reader has stopped reading, rather than waiting for a write it cannot finish [skipped: Windows delivers no SIGINT to a piped child]",
    async () => {
      // Measured on bun 1.4.2 before this: with a consumer that had stopped reading,
      // the handler's own write queued behind the full pipe, the process sat there for
      // the whole stall, and when the consumer finally drained it exited 1 with the
      // run's summary and "Interrupted (SIGINT)." tacked on after it. The signal has
      // to win whatever the reader is doing, which costs the Interrupted line: that
      // line goes to the reader that is not reading, so it is dropped when the grace
      // runs out, and only the exit code and the cleanup are promised here.
      const waiting = sandboxThatFloodsThenWaits();
      const { exitCode, signalCode, elapsedMs } = await signalTheStuckRun(waiting, ["SIGINT"]);

      expect({ exitCode, signalCode }).toEqual({ exitCode: 130, signalCode: null });
      expect(readdirSync(waiting.scratchParent)).toEqual([]);
      expect(existsSync(path.join(waiting.markers, "second.started"))).toBe(true);
      // The control that makes the exit code non-vacuous: the run really was stuck on a
      // write. The handler's grace is 3 s, and only a write that never completed can
      // spend it, so anything at or above 2 s says the stall was real; a signal to a run
      // whose reader is reading is answered in tens of milliseconds. The upper bound is
      // deliberately loose: what the runner guarantees is that the grace ENDS the wait,
      // not that the process is reaped within any particular time on a loaded machine.
      expect({ stalled: elapsedMs >= 2_000, prompt: elapsedMs < 20_000, elapsedMs }).toEqual({
        stalled: true,
        prompt: true,
        elapsedMs,
      });
    },
    45_000,
  );

  test.skipIf(onlyPosixSignals)(
    "a signal to a run whose reader has left still exits 128 plus the signal, not 2 [skipped: Windows delivers no SIGINT to a piped child]",
    async () => {
      // The stalled case above is a write that cannot finish; this is a write that
      // cannot happen at all, because the reader closed the pipe. Both end the same
      // way: the run was stopped by a signal, and saying "the runner could not do its
      // job" instead would hide that from whoever reads the exit code.
      const waiting = sandboxThatWaits();
      const runner = Bun.spawn([process.execPath, "tests/run-tests.ts", "--jobs=1", "tests/unit"], {
        cwd: waiting.sandbox,
        env: { ...withoutRequirements(), TMPDIR: waiting.scratchParent, RUNNER_MARKERS: waiting.markers },
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = (runner.stdout as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      await reader.cancel();
      await waitForFile(path.join(waiting.markers, "fixture.started"));
      runner.kill("SIGINT");

      const stderr = await new Response(runner.stderr as ReadableStream).text();
      const exitCode = await runner.exited;

      expect({ exitCode, signalCode: runner.signalCode }, `runner stderr: ${stderr}`).toEqual({
        exitCode: 130,
        signalCode: null,
      });
      // The cleanup is still done, which is the part that does not depend on a reader.
      expect(readdirSync(waiting.scratchParent)).toEqual([]);
    },
    45_000,
  );

  test.skipIf(onlyPosixSignals)(
    "a second SIGINT kills a run whose first one cannot write [skipped: Windows delivers no SIGINT to a piped child]",
    async () => {
      // The first signal takes the way out and restores the default disposition, so a
      // user who presses Ctrl+C again is not told to go and find SIGKILL. Against the
      // reviewed code the second signal was swallowed by the `interruption ??=` guard
      // and by the listener still being installed.
      const waiting = sandboxThatFloodsThenWaits();
      const { exitCode, signalCode } = await signalTheStuckRun(waiting, ["SIGINT", "SIGINT"]);

      // A process that dies by the default action reports no exit code of its own,
      // which is what separates this from the handler's own process.exit(130) in the
      // case above. Both are 130 to a shell.
      expect({ exitCode, signalCode }).toEqual({ exitCode: null, signalCode: "SIGINT" });
    },
    45_000,
  );

  test.skipIf(onlyPosixSignals)(
    "a signal taken while the coverage merge is running still ends the run [skipped: Windows delivers no SIGINT to a piped child]",
    async () => {
      // `bun run test:coverage` ends in a synchronous Bun.spawnSync that merges 500+
      // reports. Measured on bun 1.4.2 before this: a SIGINT arriving during it was
      // queued behind the sync call, and the `await main()` continuation (a microtask)
      // called process.exit(0) before the signal listener (a macrotask) ever ran. The
      // run exited 0, said nothing, and the user's Ctrl+C had vanished.
      const merging = sandboxThatMerges(
        [
          'import { writeFileSync } from "node:fs";',
          'import path from "node:path";',
          'writeFileSync(path.join(process.env.RUNNER_MARKERS, "merging"), "");',
          "const until = Date.now() + 3000;",
          "while (Date.now() < until) {}",
          'writeFileSync(process.argv[3], "merged\\n");',
          "",
        ].join("\n"),
      );
      const runner = Bun.spawn([process.execPath, "tests/run-tests.ts", ...merging.args], {
        cwd: merging.sandbox,
        env: { ...withoutRequirements(), RUNNER_MARKERS: merging.markers },
        stdout: "pipe",
        stderr: "pipe",
      });
      await waitForFile(path.join(merging.markers, "merging"));
      runner.kill("SIGINT");

      const stdout = await new Response(runner.stdout as ReadableStream).text();
      const exitCode = await runner.exited;

      expect({ exitCode, signalCode: runner.signalCode }).toEqual({ exitCode: 130, signalCode: null });
      expect(stdout).toContain("Interrupted (SIGINT).");
      // The paired control: the merge did run and did finish, so this is a signal taken
      // DURING the merge and not one that arrived before it started.
      expect(existsSync(path.join(merging.sandbox, "lcov.info"))).toBe(true);
    },
    45_000,
  );

  test.skipIf(onlyPosixSignals)(
    "a coverage merge killed by a signal is reported by that signal, not as exit null [skipped: needs POSIX signal semantics]",
    async () => {
      // A terminal Ctrl+C goes to the whole foreground group, so the merge child dies
      // too. Bun.spawnSync then reports exitCode null, and "failed with exit null"
      // names no cause at all.
      const merging = sandboxThatMerges('process.kill(process.pid, "SIGKILL");\n');
      const { exitCode, stderr, stdout } = runInSandbox(merging.sandbox, merging.args);

      expect({ exitCode, stderr: stderr.trim() }).toEqual({
        exitCode: 2,
        stderr: "Merging 1 coverage reports was killed by SIGKILL.",
      });
      expect(stdout).toContain("The run stopped before it finished; the reason is on stderr.");
    },
    30_000,
  );

  test("a coverage merge that exits non-zero is still reported by its exit code", () => {
    // The paired control for the case above: the signal wording must not have taken
    // over the ordinary failure, which is the one the exit code can describe.
    const merging = sandboxThatMerges("process.exit(3);\n");
    const { exitCode, stderr } = runInSandbox(merging.sandbox, merging.args);

    expect({ exitCode, stderr: stderr.trim() }).toEqual({
      exitCode: 2,
      stderr: "Merging 1 coverage reports failed with exit 3.",
    });
  }, 30_000);

  test.skipIf(onlyPosixSignals || process.getuid?.() === 0)(
    "a scratch directory that cannot be removed is named, and ends the run with exit 2 [skipped: needs POSIX permissions and a non-root user]",
    async () => {
      const waiting = sandboxThatWaits();
      const { exitCode, stderr, stdout } = await signalTheRun(waiting, "SIGINT", () =>
        chmodSync(waiting.scratchParent, 0o555),
      );

      expect({ exitCode, stderr }).toEqual({ exitCode: 2, stderr: expect.stringContaining("could not be removed") });
      expect(stderr).toContain(path.join(waiting.scratchParent, "libredb-test-junit-"));
      expect(stdout).toContain("Interrupted (SIGINT).");
      expect(existsSync(path.join(waiting.markers, "second.started"))).toBe(false);
    },
    30_000,
  );

  test("the error path's last stdout line arrives behind 300 KB the merge left in the pipe", async () => {
    // The case below is the same error path with an empty pipe in front of it, and it
    // passes whether or not exitAfterWriting waits for its writes: measured on bun
    // 1.4.2, process.exit does flush a small write into a pipe that has room. So the
    // drain the docblock is written about is only observable with the pipe FULL when
    // the last line is written, and the merge child is the one writer that can leave it
    // that way, because it writes to the inherited descriptor directly and the runner's
    // own stream knows nothing about what it queued there.
    const merging = sandboxThatMerges(
      [
        "const line = `${'m'.repeat(1023)}\\n`;",
        "for (let index = 0; index < 300; index += 1) process.stdout.write(line);",
        "process.exit(3);",
        "",
      ].join("\n"),
    );
    const { exitCode, stdout, stderr } = await runWithASlowReader(merging.sandbox, merging.args);

    expect({ exitCode, last: stdout.trimEnd().split("\n").at(-1) }, `runner stderr: ${stderr}`).toEqual({
      exitCode: 2,
      last: "The run stopped before it finished; the reason is on stderr.",
    });
    expect(stderr).toContain("Merging 1 coverage reports failed with exit 3.");
    // The paired control: the merge's own output really was in front of the last line,
    // so this is a write that had to wait rather than one into an empty pipe. Far below
    // the 300 KB the script writes, because two things cut it and neither is guaranteed:
    // node drops its own queued stdout at process.exit, and whatever is still in the
    // pipe when the runner goes is lost to the reader. What IS guaranteed is that the
    // 64 KiB the pipe holds was accepted before the child left, and the runner's own
    // wait is what drains it, so the reader sees at least that.
    expect(stdout.length).toBeGreaterThan(60_000);
  }, 60_000);

  test("an error after the run started is reported on stderr, and stdout is told the run stopped", () => {
    // The error path exits 2 straight away rather than letting the run finish, so
    // whatever it has already printed to stdout has to be drained with a write of its
    // own. The sandbox has no src/, so no child covers a source file and the merge has
    // nothing to merge, which is the one error this can reach after the run has begun.
    const sandbox = sandboxWith(
      'import { expect, test } from "bun:test";\ntest("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n',
    );
    const { exitCode, stdout, stderr } = runInSandbox(sandbox, [
      "tests/unit/fixture.test.ts",
      "--coverage",
      `--coverage-dir=${path.join(sandbox, "raw")}`,
      `--merge-into=${path.join(sandbox, "lcov.info")}`,
    ]);

    expect(exitCode, `runner stdout: ${stdout}`).toBe(2);
    expect(stderr).toContain("No coverage report was written");
    expect(stdout).toContain("1 file: 1 passed");
    expect(stdout).toContain("The run stopped before it finished; the reason is on stderr.");
  });

  test("--coverage writes one report per file and --merge-into merges them", () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "runner-coverage-"));
    try {
      const rawDir = path.join(workDir, "raw");
      const merged = path.join(workDir, "lcov.info");
      const { exitCode, stdout } = runRunner([
        "tests/unit/test-runner-discovery.test.ts",
        "--coverage",
        `--coverage-dir=${rawDir}`,
        `--merge-into=${merged}`,
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("with coverage");
      expect(existsSync(path.join(rawDir, "file-1", "lcov.info"))).toBe(true);
      // The merged report keeps only src/ records, so the runner's own module is
      // absent from it by design; what matters here is that the merge ran and
      // wrote a report the coverage gate can read.
      expect(existsSync(merged)).toBe(true);
      expect(readFileSync(path.join(rawDir, "inputs.txt"), "utf8")).toContain("file-1/lcov.info");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  /*
    The Windows default the runner injects (perTestTimeoutArgs) is placed BEFORE the
    forwarded arguments, so a contributor's own --timeout still decides. That placement
    rests entirely on bun taking the LAST of a repeated option, which is a fact about the
    bun binary and not about this repository, so it is measured here against the real one
    rather than assumed. Both orders are run: without the second arm the first would pass
    just as well for a bun that took the FIRST and happened to time the fixture out anyway.
  */
  test("bun takes the last of a repeated --timeout, which is what lets a forwarded one override the default", () => {
    const sandbox = sandboxWith(
      [
        'import { test } from "bun:test";',
        'test("sleeps longer than the short timeout and less than the long one", async () => {',
        "  await Bun.sleep(400);",
        "});",
        "",
      ].join("\n"),
    );

    const shortLast = runInSandbox(sandbox, ["tests/unit/fixture.test.ts", "--", "--timeout=100000", "--timeout=50"]);
    expect(shortLast.exitCode).not.toBe(0);
    expect(`${shortLast.stdout}${shortLast.stderr}`).toContain("timed out after 50ms");

    const longLast = runInSandbox(sandbox, ["tests/unit/fixture.test.ts", "--", "--timeout=50", "--timeout=100000"]);
    expect(longLast.exitCode).toBe(0);
  });
});
