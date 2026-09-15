#!/usr/bin/env bun
/**
 * The test runner: `bun run test`.
 *
 * It runs every test file in its own bun process, several files at a time, and it
 * is written in TypeScript rather than shell so that the one command a contributor
 * is told to run behaves the same on Linux, macOS and Windows. The two bash scripts
 * it replaces could not: `tests/run-core.sh` used `mapfile`, a bash 4 builtin, and
 * macOS ships bash 3.2, so the documented gate never ran there at all.
 *
 * Why a process per file rather than `bun test <dir>`: see the docblock in
 * `tests/runner/execute.ts`.
 *
 *   bun tests/run-tests.ts                       every test file
 *   bun tests/run-tests.ts tests/api             one layer
 *   bun tests/run-tests.ts tests/api/db.test.ts  one file
 *   bun tests/run-tests.ts --jobs=4              bound the concurrency
 *   bun tests/run-tests.ts --list                what would run
 *   bun tests/run-tests.ts --coverage --merge-into=coverage/lcov.info
 *   bun tests/run-tests.ts tests/unit -- --bail  pass flags to bun test
 *
 * That last one needs both halves as written: a selector before the `--`, and the
 * runner invoked directly. `bun run test -- --bail` does not work, because `bun run`
 * consumes the first `--` itself, and neither does a `--` straight after the script
 * path, for the same reason (measured on 1.4.2; the refusal in runner/options.ts says
 * so).
 *
 * It exits 0 when every file passed, 1 when a file failed, and 2 when the runner could
 * not do its job (a usage error, a selector that names nothing, a scratch directory it
 * could not remove, a write that failed for the runner's own reason such as a full
 * disk). A reader that goes away is NOT one of those: `bun run test | head -1` keeps
 * the run's own 0 or 1, because turning it into 2 would hide the very distinction the
 * 2 is for. Stopped by SIGINT, SIGTERM, SIGHUP or SIGBREAK, it stops scheduling, kills
 * the files still running, removes its scratch directory and exits 128 + the signal's
 * number: 130, 143, 129, and 149 for SIGBREAK on Windows (see tests/runner/signals.ts).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { captureBounded } from "./runner/capture";
import { assertCoverageDirIsOurs, assertMergeTargetIsOurs } from "./runner/coverage";
import { COVERAGE_EXEMPT_FILES, selectTestFiles } from "./runner/discover";
import { coverageDirFor, type RunFile, runTestFiles, type SpawnOutcome } from "./runner/execute";
import { parseRunnerArgs, type RunnerOptions } from "./runner/options";
import { formatFileLine, formatSummary } from "./runner/report";
import { missingHelm, planRequirements, requiredCapabilities, systemHelmProbe } from "./runner/requirements";
import { exitCodeForSignal, STOP_SIGNALS, type StopSignal } from "./runner/signals";

const root = path.resolve(import.meta.dir, "..");

/** How long a child that was asked to stop is given before it is killed outright. */
const KILL_ESCALATION_MS = 5_000;

/**
 * How long a signal's last line is given to reach its reader before the process ends
 * anyway.
 *
 * A signal has to end the run promptly whatever the reader is doing. Measured on bun
 * 1.4.2 with a consumer that had stopped reading: the handler's own write queued
 * behind a full pipe (64 KiB on Linux), the process sat there for the whole stall and
 * survived a second SIGINT, a SIGTERM and a SIGHUP, and when the consumer finally
 * drained it exited 1 with the run's summary and "Interrupted (SIGINT)." after it. So
 * the write is raced against this, and when it loses, the Interrupted line is lost:
 * the reader that was not reading is the one that does not get it, and the exit code
 * and the scratch-directory removal still say what happened. Three seconds is far more
 * than a reader that is reading needs, even on a loaded 4-CPU CI runner.
 */
const SIGNAL_WRITE_GRACE_MS = 3_000;

const live = new Set<Bun.Subprocess>();

/**
 * The run's own temporary directory (the children's junit reports), removed on every
 * way out: a normal end, an error (exit 2), and any of SIGINT, SIGTERM, SIGHUP and
 * SIGBREAK, which end the run with 128 + the signal's number (130, 143, 129) or with
 * exit 2 when the directory cannot be removed. The children themselves need no such
 * care, because `--no-orphans` takes them down with this process.
 */
let runScratch: string | null = null;

/**
 * Removes it, and answers with what went wrong rather than throwing.
 *
 * `force: true` only ignores a path that is not there; a directory that cannot be
 * removed (no write permission on its parent, a Windows handle still open on a junit
 * file) still throws. Every caller here is on its way out, two of them from a signal
 * listener, where a throw is worse than useless: measured on bun 1.4.2, a throw from
 * inside a SIGINT listener left the process RUNNING and the queue started the next
 * file. So the failure comes back as a sentence for the caller to print before it
 * exits 2, and is never swallowed.
 */
function removeRunScratch(): string | null {
  if (runScratch === null) return null;
  const directory = runScratch;
  runScratch = null;
  try {
    rmSync(directory, { recursive: true, force: true });
    return null;
  } catch (error) {
    return `The run's scratch directory ${directory} could not be removed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * True once the run has been stopped from outside (a signal, or an error that ends
 * it): no further file is started, and the results of the children being killed are
 * not printed as though they were the run's own verdict.
 */
let stopping = false;

/** True once the run's header has been written, so stdout has something to drain. */
let runStarted = false;

/** Stops scheduling and asks every running child to stop. */
function stopRun(): void {
  stopping = true;
  for (const child of live) child.kill("SIGTERM");
}

/**
 * Writes, and resolves when the bytes have actually left this process.
 *
 * bun writes to a pipe asynchronously, and `process.exit` throws away whatever is
 * still pending: measured on 1.4.2, a run whose stdout was a pipe (a CI log, `| tee`,
 * a test driving the runner) lost about a third of a failing file's megabyte of
 * output AND the whole summary with it, exit code intact. So every exit path writes
 * its last line through here first. The callback of a write waits for the writes
 * queued before it as well, which is what drains the output printed as files landed;
 * an EMPTY write's callback does not (measured), so this is only ever called with
 * text.
 *
 * What it covers is what THIS process writes. A child can still drop part of its own
 * queued console output when it exits under load, with no runner in the picture at
 * all (measured on 1.4.2, and filed as D96 in docs/BACKLOG.md), and no drain here can
 * put that back.
 */
function written(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * True when a write failed because the reader has gone rather than because this
 * process could not write: `| head -1`, a CI log tailer that stopped, a closed
 * terminal. Measured on bun 1.4.2, the write callback's error carries `code` "EPIPE"
 * for those, and a real runner problem carries its own ("ENOSPC" for a full disk,
 * measured against /dev/full), so the two are told apart by that and not by guesswork.
 * The other two names are reasoned rather than measured: neither came up here, and
 * both describe a descriptor that has gone rather than a run that could not be made.
 */
function readerHasGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "EBADF";
}

/** Writes and waits, treating a reader that has gone as nothing to report. */
async function writtenOrReaderGone(stream: NodeJS.WriteStream, text: string): Promise<void> {
  try {
    await written(stream, text);
  } catch (error) {
    if (!readerHasGone(error)) throw error;
  }
}

/**
 * The one way out: the last lines reach their reader, then the process ends.
 *
 * `graceMs` bounds the wait. Only the signal path passes it, because only the signal
 * path has something more urgent than its own last line (see SIGNAL_WRITE_GRACE_MS);
 * everywhere else the write is the reason the process is still alive.
 */
async function exitAfterWriting(
  code: number,
  text: { stdout?: string; stderr?: string },
  graceMs?: number,
): Promise<never> {
  const writes: Promise<void>[] = [];
  if (text.stdout !== undefined) writes.push(written(process.stdout, text.stdout));
  if (text.stderr !== undefined) writes.push(written(process.stderr, text.stderr));
  // allSettled, not all: the other stream still has something to say. A scratch
  // directory that could not be removed is explained on stderr while the run's last
  // line goes to stdout, and Promise.all would abandon one the moment the other broke.
  // Answered inside the promise rather than in a catch around the await, so the grace
  // below cannot walk away from a rejection and leave an unhandled one behind.
  const drained = Promise.allSettled(writes).then((results) =>
    // The stream that refused the bytes is the stream that would have carried the
    // explanation, so nothing more can be said there; what is left to say is said by
    // the exit code. A reader that went away is not the runner failing, and answering
    // 2 there would take the run's own verdict away from `bun run test | head -1`.
    // Any other write error IS the runner's problem, which is what 2 is for.
    results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .every((result) => readerHasGone(result.reason))
      ? code
      : 2,
  );
  process.exit(
    graceMs === undefined ? await drained : await Promise.race([drained, Bun.sleep(graceMs).then(() => code)]),
  );
}

/**
 * Children inherit the environment, plus one decision: `FORCE_COLOR` when this
 * runner is on a terminal. Each child's output is a pipe, so bun would drop its
 * colour and the failure diffs are much harder to read without it. `NO_COLOR` wins
 * over that, because it is the user's own word.
 *
 * Nothing else is set here. The environment tests run under is pinned by
 * `tests/setup.ts`, which bunfig preloads into every child.
 */
function childEnvironment(): Record<string, string | undefined> {
  const wantsColour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  return wantsColour ? { ...process.env, FORCE_COLOR: "1" } : { ...process.env };
}

function spawnTestFile(bunArgs: string[], junitDir: string): RunFile {
  return async ({ file, index, coverageDir, timeoutMs }): Promise<SpawnOutcome> => {
    const coverageArgs = coverageDir ? ["--coverage", "--coverage-reporter=lcov", `--coverage-dir=${coverageDir}`] : [];
    // Every child writes a junit report, and it is the runner's only source of truth
    // about what the file did: the counts, and the titles of the tests it skipped,
    // which bun names nowhere else. Its console output is for a reader and decides
    // nothing (see readTestReport). The file is small, even for a child that printed
    // hundreds of megabytes, and the whole directory is removed when the run ends.
    const junitPath = path.join(junitDir, `file-${index + 1}.xml`);

    const command = [
      process.execPath,
      // Reap whatever the file spawned (helm, node, sh) if this child is killed:
      // bun uses PR_SET_PDEATHSIG on Linux, EVFILT_PROC on macOS and a
      // kill-on-close Job Object on Windows, so a timeout leaves nothing behind.
      "--no-orphans",
      "test",
      ...bunArgs,
      // AFTER the user's arguments, because bun takes the last of a repeated option:
      // a forwarded `-- --reporter-outfile=x` would otherwise send the report
      // somewhere else and leave every file looking as though it wrote none.
      "--reporter=junit",
      `--reporter-outfile=${junitPath}`,
      ...coverageArgs,
      // "./" matters: bun reads a bare relative path as a SUBSTRING FILTER over the
      // whole tree, so `bun test tests/a/b.test.ts` also runs any other file whose
      // path contains that string. With the prefix it is a path, on every platform.
      `./${file}`,
    ];

    const startedAt = Date.now();
    const child = Bun.spawn(command, {
      // Every child runs from the repository root: bunfig.toml's preload, the `@/`
      // alias and the tests that read repository files all resolve from there.
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: childEnvironment(),
    });
    live.add(child);

    let timedOut = false;
    const softKill = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const hardKill = setTimeout(() => {
      if (timedOut) child.kill("SIGKILL");
    }, timeoutMs + KILL_ESCALATION_MS);

    // bun writes its file header, failure diffs and per-file summary to stderr, and
    // the tests' own console output to stdout, so both are captured. Each is bounded
    // at both ends rather than read whole: see tests/runner/capture.ts.
    const [stdout, stderr] = await Promise.all([
      captureBounded(child.stdout as ReadableStream<Uint8Array>, { name: "stdout" }),
      captureBounded(child.stderr as ReadableStream<Uint8Array>, { name: "stderr" }),
    ]);
    const exitCode = await child.exited;

    clearTimeout(softKill);
    clearTimeout(hardKill);
    live.delete(child);

    return {
      exitCode: child.signalCode ? null : exitCode,
      signal: child.signalCode,
      output: `${stderr}${stdout}`,
      durationMs: Date.now() - startedAt,
      timedOut,
      junitReport: existsSync(junitPath) ? readFileSync(junitPath, "utf8") : null,
    };
  };
}

function mergeCoverage(options: RunnerOptions, files: string[]): void {
  const reports = files
    .map((file, index) =>
      coverageDirFor(file, index, {
        coverage: options.coverage,
        coverageDir: options.coverageDir,
        coverageExempt: COVERAGE_EXEMPT_FILES,
      }),
    )
    .filter((directory): directory is string => directory !== null)
    .map((directory) => `${directory}/lcov.info`)
    // bun writes no report at all for a test file that covered no source file, so a
    // missing one is expected here rather than an error.
    // A coverage directory may be given as an absolute path, so resolve rather
    // than join: path.join("/repo", "/tmp/raw") is "/repo/tmp/raw".
    .filter((report) => existsSync(path.resolve(root, report)));

  if (reports.length === 0) {
    throw new Error(`No coverage report was written under ${options.coverageDir}.`);
  }

  // The list goes in a file rather than in argv: Windows caps a command line at
  // 32767 characters and this repository already has over 500 test files.
  const manifest = `${options.coverageDir}/inputs.txt`;
  writeFileSync(path.resolve(root, manifest), `${reports.join("\n")}\n`);

  const merged = Bun.spawnSync(
    ["node", "scripts/merge-lcov.mjs", `--inputs-from=${manifest}`, options.mergeInto as string],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (merged.exitCode !== 0) {
    // A child that died by a signal reports exitCode null and signalCode instead
    // (measured on bun 1.4.2), and a terminal Ctrl+C reaches this child too, because
    // it goes to the whole foreground group. "failed with exit null" names no cause.
    const how = merged.signalCode ? `was killed by ${merged.signalCode}` : `failed with exit ${merged.exitCode}`;
    throw new Error(`Merging ${reports.length} coverage reports ${how}.`);
  }
}

async function main(): Promise<number> {
  const options = parseRunnerArgs(process.argv.slice(2), { cpuCount: availableParallelism() });
  const files = selectTestFiles(root, options.selectors);

  if (options.list) {
    await writtenOrReaderGone(process.stdout, `${files.join("\n")}\n`);
    return 0;
  }

  // Decided before anything is deleted or started: a run that has to be refused (a CI job whose
  // Helm is missing) refuses with the coverage directory and the merged report still intact.
  const plan = planRequirements({
    files,
    readSource: (file) => readFileSync(path.join(root, file), "utf8"),
    missing: { helm: () => missingHelm(systemHelmProbe(root)) },
    required: requiredCapabilities(process.env),
  });

  if (options.coverage) {
    const coverageDir = path.resolve(root, options.coverageDir);
    // --coverage-dir is a path the caller chooses and this line deletes it, so it is
    // checked before it is emptied. See tests/runner/coverage.ts.
    if (existsSync(coverageDir)) assertCoverageDirIsOurs(options.coverageDir, readdirSync(coverageDir));
    rmSync(coverageDir, { recursive: true, force: true });
    mkdirSync(coverageDir, { recursive: true });
  }
  // The merged report goes too, and before the run rather than after it: a run that
  // ends red never reaches the merge, and a stale lcov left beside it is a report of
  // a tree that no longer exists, which `coverage:check` would happily pass.
  if (options.mergeInto) {
    const mergeTarget = path.resolve(root, options.mergeInto);
    if (existsSync(mergeTarget)) assertMergeTargetIsOurs(options.mergeInto, readFileSync(mergeTarget, "utf8"));
    rmSync(mergeTarget, { force: true });
  }

  const junitDir = mkdtempSync(path.join(tmpdir(), "libredb-test-junit-"));
  runScratch = junitDir;

  const selection = options.selectors.length > 0 ? options.selectors.join(" ") : "tests/";
  const notRunNote =
    plan.notRun.length > 0 ? ` (${plan.notRun.length} not run on this machine, listed at the end)` : "";
  runStarted = true;
  process.stdout.write(
    `bun ${Bun.version} on ${process.platform}-${process.arch}: ${plan.run.length} files from ${selection}${notRunNote}, ` +
      `${options.jobs} at a time${options.coverage ? ", with coverage" : ""}\n\n`,
  );

  const summary = await runTestFiles({
    files: plan.run,
    jobs: options.jobs,
    timeoutMs: options.fileTimeoutMs,
    coverage: options.coverage,
    coverageDir: options.coverageDir,
    coverageExempt: COVERAGE_EXEMPT_FILES,
    runFile: spawnTestFile(options.bunArgs, junitDir),
    shouldStop: () => stopping,
    onResult: (outcome, position, total) => {
      // Belt and braces. The intent is that what a child has just been killed for is
      // not this file's verdict, but by the time a killed child's outcome could arrive
      // the signal handler has usually already called process.exit, so removing this
      // guard leaves the whole suite green (measured by mutation). It is written from
      // the shape of the code, for the window where the handler's own exit is still
      // pending, and not from an observed behaviour.
      if (stopping) return;
      process.stdout.write(`${formatFileLine(outcome, position, total)}\n`);
      // A failing file's whole output is printed where it lands rather than kept for
      // the end: a CI log is read from the first red line downwards.
      if (outcome.status !== "passed") process.stdout.write(`${outcome.output}\n`);
    },
  });

  // A run that was signalled prints no summary and carries no code of its own: the
  // handler is already on its way out with 128 + the signal's number, and returning
  // its promise waits for it rather than reporting the files it had killed as
  // failures. Belt and braces like the guard above: the handler normally exits before
  // this is reached, so removing it leaves the suite green (measured by mutation).
  if (interruption !== null) return interruption;

  await writtenOrReaderGone(process.stdout, `${formatSummary(summary, plan.notRun)}\n`);
  // Looked at again, because a megabyte of summary takes a while to drain and a signal
  // taken while it did still owns the way out. Belt and braces once more: the window is
  // between this write resolving and the handler's own exit, and nothing here can drive
  // it to order, so no test pins this line.
  if (interruption !== null) return interruption;
  if (summary.failures.length > 0) return 1;

  if (options.mergeInto) {
    mergeCoverage(options, plan.run);
    // mergeCoverage is synchronous and merges 500+ reports, so a signal delivered
    // during it is still queued when it returns: measured on bun 1.4.2, the listener
    // has NOT run at that point, and without this turn of the event loop the
    // process.exit(0) below wins and the user's Ctrl+C vanishes with no Interrupted
    // line and a green exit. One setImmediate is enough (measured, 5 runs of 5),
    // because libuv polls its signal handles before the check phase.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (interruption !== null) return interruption;
  }
  return 0;
}

/**
 * Ends the run on a signal, with 128 + the signal's number, which is what a shell
 * reports: 130 for SIGINT, 143 for SIGTERM, 129 for SIGHUP (see tests/runner/signals.ts,
 * which also carries the number for SIGBREAK, that no POSIX table has).
 *
 * The children are asked to stop and are not waited for: `--no-orphans` takes every
 * child and its descendants down once this process has gone (measured), and on POSIX
 * a directory is removed happily while a dying child still holds a file in it open.
 * A removal that fails is named and exits 2 instead, never swallowed: a throw from
 * inside a signal listener leaves bun running, and the queue then starts the next
 * file (measured 1.4.2), which is worse than either.
 *
 * Nothing here waits on anything it does not control. The listeners come off first, so
 * the default disposition is back and a second Ctrl+C really kills (measured on 1.4.2:
 * removing every listener for a signal restores it, and the second SIGINT then ends the
 * process with 130 by itself). The last line is then raced against a grace, because a
 * reader that has stopped reading must not be able to keep a signalled run alive.
 */
function stopOnSignal(signal: StopSignal): Promise<never> {
  stopRun();
  for (const other of STOP_SIGNALS) process.removeAllListeners(other);
  const removal = removeRunScratch();
  return exitAfterWriting(
    removal === null ? exitCodeForSignal(signal) : 2,
    {
      stdout: `\nInterrupted (${signal}).\n`,
      stderr: removal === null ? undefined : `${removal}\n`,
    },
    SIGNAL_WRITE_GRACE_MS,
  );
}

/** Set once a signal has been taken: the run has no verdict of its own after that. */
let interruption: Promise<never> | null = null;

for (const signal of STOP_SIGNALS) {
  // The first signal owns the way out; a second one arriving while it writes its last
  // line must not start a second cleanup over the top of it. It is not swallowed
  // either: stopOnSignal has already put the default disposition back, so the second
  // one kills the process outright rather than reaching this listener at all.
  process.on(signal, () => {
    interruption ??= stopOnSignal(signal);
  });
}

try {
  const code = await main();
  const removal = removeRunScratch();
  // Usage and setup errors exit 2, so a caller can tell "the tests failed" (1) from
  // "the runner could not run them" (2). A scratch directory left behind is the
  // second kind, so it takes the run's own code away.
  if (removal !== null) await exitAfterWriting(2, { stderr: `${removal}\n` });
  // The last look: a signal taken in the turn between main's own final check and this
  // line still owns the way out, and this promise never resolves, so the handler's
  // exit is what happens. Belt and braces, like main's own two checks.
  if (interruption !== null) await interruption;
  process.exit(code);
} catch (error) {
  // The children are stopped before the message is written: the write is awaited, and
  // while it is, a worker would otherwise start the next file over a run that is over.
  stopRun();
  const removal = removeRunScratch();
  const reason = error instanceof Error ? error.message : String(error);
  await exitAfterWriting(2, {
    // Whoever is reading the run is reading stdout, and whatever landed there before
    // the error still has to reach them, which needs a write of its own.
    stdout: runStarted ? "\nThe run stopped before it finished; the reason is on stderr.\n" : undefined,
    stderr: `${[reason, removal].filter((line) => line !== null).join("\n")}\n`,
  });
}
