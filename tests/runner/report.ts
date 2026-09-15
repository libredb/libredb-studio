/**
 * What the runner prints.
 *
 * The children's output is captured rather than inherited, because several files
 * run at once and interleaved output belongs to nobody. Each file therefore gets
 * one line when it lands, a failing file gets its whole output printed with it, and
 * the run ends with the population: how many files, how many tests, how many
 * skipped, and how to re-run any file that failed on its own.
 */
import type { FileOutcome, RunSummary, TestCounts } from "./execute";
import type { NotRunFile } from "./requirements";

/**
 * What a file's junit report said, or why it said nothing.
 *
 * "missing" and "unreadable" are told apart because they mean different things to
 * whoever reads the failure: a missing report is a child that never got to the end
 * (it registered no test, or a `process.exit` or a signal cut it short), while an
 * unreadable one is a report this parser does not understand, which is a defect in
 * the runner or a bun that changed its format. Neither ever becomes zero counts.
 */
export type TestReport = { state: "read"; counts: TestCounts } | { state: "missing" | "unreadable"; counts: null };

/**
 * The counts of one file, read from the junit report bun wrote for it.
 *
 * NOT from the console output, although bun prints " 13 pass" / " 1 fail" lines
 * there. Those lines are free-form text mixed with whatever the tests themselves
 * printed, and a test that prints one is indistinguishable from bun printing it:
 * measured on 1.4.2, a file that registered no test and printed " 1 pass" was
 * reported PASS with exit 0, and so was a test that printed a whole summary on
 * stderr and then called `process.exit(0)` so the tests after it never ran. Both
 * shapes defeat exactly the guards that keep this runner from turning a red tree
 * green. `--bail` makes the console reading wrong in the other direction: it prints
 * no count line at all, while the report still carries the failure.
 *
 * bun counts a todo test among the skipped ones and writes it as
 * `<skipped message="TODO" />`, so the todos are counted from the elements and
 * taken out of the skips. parseSkippedTests leaves them out of its titles for the
 * same reason, so the count and the list below it are the same tests.
 */
export function readTestReport(report: string | null): TestReport {
  if (report === null) return { state: "missing", counts: null };
  const unreadable: TestReport = { state: "unreadable", counts: null };
  const root = /<testsuites\b([^>]*)>/.exec(report);
  // The closing tag matters: the todo count comes from the elements, so a report cut
  // off half way (a child killed mid-write) would undercount rather than be unknown.
  if (root === null || !report.includes("</testsuites>")) return unreadable;

  const attributes = root[1] as string;
  const count = (name: string): number | null => {
    const raw = new RegExp(`\\b${name}="(\\d+)"`).exec(attributes)?.[1];
    return raw === undefined ? null : Number(raw);
  };
  const tests = count("tests");
  const failures = count("failures");
  const skipped = count("skipped");
  if (tests === null || failures === null || skipped === null) return unreadable;

  const todo = [...report.matchAll(/<skipped\b[^>]*\bmessage="TODO"/g)].length;
  const pass = tests - failures - skipped;
  const skip = skipped - todo;
  // Counts that contradict each other are not counts: reporting them would put a
  // negative number in the run's totals and call it measured.
  if (pass < 0 || skip < 0) return unreadable;
  return { state: "read", counts: { pass, fail: failures, skip, todo } };
}

const XML_ENTITY: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/**
 * The titles of the tests a file skipped, read from bun's own junit report.
 *
 * bun prints a skipped test's title NOWHERE: measured on 1.4.2 piped, with
 * FORCE_COLOR set, and under a real pty, the output carries the count (" 4 skip")
 * and nothing else. In this repository a skip always states its reason in its title
 * (a deb postinstall, a snap launcher, an AppImage permission audit: artifacts that
 * cannot exist on the platform), so the count alone hides the only thing worth
 * reading. The junit reporter names them, so the runner asks each child for one.
 *
 * The describe path matters as much as the name: a skip made with `describe.skip`
 * carries its reason in the DESCRIBE title, and the tests inside it are named only
 * for what they check. That path is read from the nested <testsuite> elements, one
 * per describe, and NOT from the `classname` attribute, which also lists them: in
 * classname bun joins the titles with " &gt; " and writes a literal ">" inside a
 * title as "&gt;" too, so the two cannot be told apart. Measured on 1.4.2, splitting
 * classname turned a describe titled "rows where count > 100" into
 * "100 > rows where count". The element nesting says it unambiguously.
 *
 * A todo is not here. bun writes one as `<skipped message="TODO" />`, and readTestReport
 * takes the todos out of the skip count, so listing them would put titles under a
 * header that does not count them. A todo also has no reason to state: it is work
 * nobody has written, which the "N todo" count says in full.
 *
 * A report that is missing or truncated (a child killed mid-write) names what it
 * reached, and raises nothing: the run's counts and verdict are read separately, by
 * readTestReport, which refuses a report it cannot read rather than guessing. Those
 * titles are printed under an unknown count (see formatSummary), which is why they are
 * worth reading out of a report nothing else could use.
 */
export function parseSkippedTests(report: string): string[] {
  const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITY[entity] as string);
  const skipped: string[] = [];
  // The outermost suite is the file itself, so the stack is read from its second
  // element on. `<testsuite\b` matches neither `<testsuites` nor `</testsuites>`.
  const suites: string[] = [];
  for (const match of report.matchAll(/<testsuite\b([^>]*)>|<\/testsuite>|<testcase\b([^>]*)>\s*<skipped\b([^>]*)>/g)) {
    const [element, suiteAttributes, caseAttributes, skippedAttributes] = match;
    if (element === "</testsuite>") {
      suites.pop();
      continue;
    }
    if (suiteAttributes !== undefined) {
      // A self-closing `<testsuite ... />` opens nothing: it has no `</testsuite>` to
      // close it, so treating it as a describe would put its name in front of every
      // title after it. bun 1.4.2 writes no element at all for an empty describe, so
      // this is a shape of the junit format that the parser tolerates, not one measured.
      if (!suiteAttributes.endsWith("/")) suites.push(decode(/\bname="([^"]*)"/.exec(suiteAttributes)?.[1] ?? ""));
      continue;
    }
    // A todo is `<skipped message="TODO" />`, the same element with a message. It is
    // counted separately by readTestReport and it has no reason to state, so it is left
    // out here too: a list that names it under a "(N skipped)" header states one number
    // and shows another.
    if ((skippedAttributes as string).includes('message="TODO"')) continue;
    const name = /\bname="([^"]*)"/.exec(caseAttributes as string)?.[1];
    if (name === undefined) continue;
    skipped.push([...suites.slice(1), decode(name)].join(" > "));
  }
  return skipped;
}

function seconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function countsSuffix(outcome: FileOutcome): string {
  const counts = outcome.counts;
  if (!counts) return outcome.report === "missing" ? "no test report" : "unreadable test report";
  const parts = [`${counts.pass} pass`];
  if (counts.fail > 0) parts.push(`${counts.fail} fail`);
  if (counts.skip > 0) parts.push(`${counts.skip} skip`);
  if (counts.todo > 0) parts.push(`${counts.todo} todo`);
  return parts.join(" ");
}

const STATUS_LABEL = { passed: "PASS", failed: "FAIL", "timed-out": "TIMEOUT" } as const;

export function formatFileLine(outcome: FileOutcome, position: number, total: number): string {
  const width = String(total).length;
  const place = `[${String(position).padStart(width)}/${total}]`;
  const label = STATUS_LABEL[outcome.status].padEnd(7);
  return `${place} ${label} ${seconds(outcome.durationMs).padStart(6)}  ${outcome.file}  ${countsSuffix(outcome)}`;
}

function failureReason(outcome: FileOutcome, timeoutMs: number): string {
  // The BUDGET, not the elapsed time: a killed child is given a few more seconds to
  // die before SIGKILL, so the elapsed time is always the larger, unrelated number.
  if (outcome.status === "timed-out") return `timed out, the budget is ${seconds(timeoutMs)} per file`;
  // The runner sends SIGKILL itself only to a child that outran its budget, and that
  // child is reported above as timed out. So a SIGKILL here came from outside, and on
  // Linux that is nearly always the OOM killer: measured, a real kernel OOM kill of
  // one child read only "killed by SIGKILL", which tells a reader nothing to act on.
  if (outcome.signal === "SIGKILL")
    return "killed by SIGKILL from outside the runner (its own timeout kill is reported as a timeout); on Linux that is usually the OOM killer, so re-run with a lower --jobs=N";
  if (outcome.signal) return `killed by ${outcome.signal}`;
  if (outcome.counts && outcome.counts.fail > 0) return `${outcome.counts.fail} failing`;
  if (outcome.report === "missing")
    return `exit ${outcome.exitCode}, and it wrote no test report, which usually means it registered no test or stopped before bun finished, so its tests are unaccounted for`;
  if (outcome.report === "unreadable")
    return `exit ${outcome.exitCode}, and its test report could not be read, so its tests are unaccounted for`;
  if (
    outcome.counts !== null &&
    outcome.counts.pass + outcome.counts.fail + outcome.counts.skip + outcome.counts.todo === 0
  )
    return `exit ${outcome.exitCode}, and it registered no test`;
  return `exit ${outcome.exitCode}`;
}

export function formatSummary(summary: RunSummary, notRun: NotRunFile[] = []): string {
  const { totals } = summary;
  const tests = [`${totals.tests.pass} pass`];
  if (totals.tests.fail > 0) tests.push(`${totals.tests.fail} fail`);
  if (totals.tests.skip > 0) tests.push(`${totals.tests.skip} skip`);
  if (totals.tests.todo > 0) tests.push(`${totals.tests.todo} todo`);

  const files = [`${totals.filesPassed} passed`];
  if (totals.filesFailed > 0) files.push(`${totals.filesFailed} failed`);
  if (totals.filesTimedOut > 0) files.push(`${totals.filesTimedOut} timed out`);

  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const totalTests = totals.tests.pass + totals.tests.fail + totals.tests.skip + totals.tests.todo;
  const lines = [
    "",
    "=".repeat(72),
    `${plural(totals.files, "file")}: ${files.join(", ")}  |  ${plural(totalTests, "test")}: ${tests.join(", ")}  |  ${seconds(summary.durationMs)} with ${plural(summary.jobs, "job")}`,
  ];

  if (totals.filesWithoutCounts > 0) {
    lines.push(
      `${plural(totals.filesWithoutCounts, "file")} left no readable test report, so ${totals.filesWithoutCounts === 1 ? "its" : "their"} tests are not in the totals above.`,
    );
  }

  // A file that needs something this machine does not have was never started, so it is in none
  // of the totals above. It is named here under its reason, printed once: on a machine without
  // Helm that is twelve chart test files and one sentence (see tests/runner/requirements.ts).
  if (notRun.length > 0) {
    lines.push("", "Files not run on this machine:");
    const byReason = new Map<string, string[]>();
    for (const { file, reason } of notRun) byReason.set(reason, [...(byReason.get(reason) ?? []), file]);
    for (const [reason, files] of byReason) {
      lines.push(`  ${reason}`);
      for (const file of files.sort()) lines.push(`    ${file}`);
    }
  }

  // A skipped test is not a passing test, and bun prints its title nowhere (see
  // parseSkippedTests), so this is where a reader meets it. Each such title states
  // the reason: a platform that cannot host the artifact, a tool that is not
  // installed. A run that says only "3 skip" has told nobody anything.
  //
  // Selected by what there is to say, which is either of two things: a skip count, or
  // titles. A truncated report has titles and no count, and selecting on the count
  // alone dropped exactly those files, parsed and then thrown away; a report this
  // parser read but could not name titles in has the count and no titles, and saying
  // "4 skipped" without them is still more than saying nothing.
  const skipping = summary.outcomes.filter(
    (outcome) => outcome.skippedTests.length > 0 || (outcome.counts?.skip ?? 0) > 0,
  );
  if (skipping.length > 0) {
    lines.push("", "Files with skipped tests:");
    for (const outcome of skipping.sort((a, b) => a.file.localeCompare(b.file))) {
      const counted = outcome.counts
        ? `${outcome.counts.skip} skipped`
        : `unreadable report; it named ${plural(outcome.skippedTests.length, "skipped test")}`;
      lines.push(`  ${outcome.file} (${counted})`);
      for (const title of outcome.skippedTests) lines.push(`    ${title}`);
    }
  }

  if (summary.failures.length > 0) {
    lines.push("", "Failed files:");
    for (const outcome of summary.failures) {
      lines.push(`  ${outcome.file} (${failureReason(outcome, summary.timeoutMs)})`);
      // The runner, not bare `bun test <file>`: bare bun reads the verdict off its
      // console and takes no --jobs, which the SIGKILL reason above tells the reader to
      // lower. It is also what CONTRIBUTING.md and CLAUDE.md tell a contributor to run.
      lines.push(`    re-run alone with: bun tests/run-tests.ts ${outcome.file}`);
    }
  }

  return lines.join("\n");
}
