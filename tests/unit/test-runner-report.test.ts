import { describe, expect, test } from "bun:test";
import type { FileOutcome, RunSummary } from "../runner/execute";
import type { TestReport } from "../runner/report";
import { formatFileLine, formatSummary, parseSkippedTests, readTestReport } from "../runner/report";

describe("reading the counts from bun's junit report", () => {
  // Written by bun 1.4.2 for a file with one passing, one failing, one skipped and one
  // todo test (`bun test --reporter=junit`), verbatim.
  const mixed = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="2" failures="1" skipped="2" time="0.01928899">
  <testsuite name="tests/mixed.test.ts" file="tests/mixed.test.ts" tests="4" assertions="2" failures="1" skipped="2" time="0.000636096" hostname="cevherips">
    <testcase name="a" classname="" time="0.000022" file="tests/mixed.test.ts" line="2" assertions="1" />
    <testcase name="b" classname="" time="0.000132" file="tests/mixed.test.ts" line="3" assertions="1">
      <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;&#10;      at tests/mixed.test.ts:3:29&#10;</failure>
    </testcase>
    <testcase name="c" classname="" time="0" file="tests/mixed.test.ts" line="4" assertions="0">
      <skipped />
    </testcase>
    <testcase name="d" classname="" time="0" file="tests/mixed.test.ts" line="5" assertions="0">
      <skipped message="TODO" />
    </testcase>
  </testsuite>
</testsuites>`;

  test("reads pass, fail, skip and todo, where bun counts a todo among the skipped", () => {
    expect(readTestReport(mixed)).toEqual({ state: "read", counts: { pass: 1, fail: 1, skip: 1, todo: 1 } });
  });

  test("a --bail run still counts its failure, although bun prints no count lines for it", () => {
    // Measured on 1.4.2: under --bail stderr carries "Bailed out after 1 failure" and no
    // " N fail" line at all, so a console reader saw nothing. The report still has it.
    const bail = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" assertions="1" failures="1" skipped="0" time="0.013511311">
  <testsuite name="tests/bail.test.ts" file="tests/bail.test.ts" tests="1" assertions="1" failures="1" skipped="0" time="0.000631151" hostname="cevherips">
    <testcase name="a" classname="" time="0.00016" file="tests/bail.test.ts" line="2" assertions="1">
      <failure type="AssertionError" message="expect(received).toBe(expected)">AssertionError</failure>
    </testcase>
  </testsuite>
</testsuites>`;

    expect(readTestReport(bail)).toEqual({ state: "read", counts: { pass: 0, fail: 1, skip: 0, todo: 0 } });
  });

  test("no report is unknown, never zero", () => {
    expect(readTestReport(null)).toEqual({ state: "missing", counts: null });
  });

  test("a report that exists but cannot be read is unknown too, and is unreadable rather than missing", () => {
    const unreadable: TestReport = { state: "unreadable", counts: null };
    // No <testsuites> element at all.
    expect(readTestReport("")).toEqual(unreadable);
    expect(readTestReport('<testsuite name="x" tests="1" failures="0" skipped="0"></testsuite>')).toEqual(unreadable);
    // An attribute the counts need is missing, or is not a count.
    expect(readTestReport('<testsuites tests="1" skipped="0"></testsuites>')).toEqual(unreadable);
    expect(readTestReport('<testsuites tests="one" failures="0" skipped="0"></testsuites>')).toEqual(unreadable);
    // Cut off before its end: the todo count is read from the elements, so it cannot be trusted.
    expect(readTestReport(mixed.slice(0, mixed.indexOf("</testsuite>")))).toEqual(unreadable);
    // Counts that contradict each other.
    expect(readTestReport('<testsuites tests="1" failures="1" skipped="1"></testsuites>')).toEqual(unreadable);
    // The control: the same shape with counts that agree is read.
    expect(readTestReport('<testsuites tests="2" failures="1" skipped="1"></testsuites>')).toEqual({
      state: "read",
      counts: { pass: 0, fail: 1, skip: 1, todo: 0 },
    });
  });
});

describe("reading which tests were skipped", () => {
  // bun prints a skipped test's title NOWHERE: measured on 1.4.2 piped, with
  // FORCE_COLOR, and under a real pty, the output carries only " 1 skip". Its junit
  // reporter does name them, which is why the runner asks for one per file.
  const report = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" failures="0" skipped="2">
  <testsuite name="tests/unit/packaging.test.ts" file="tests/unit/packaging.test.ts" tests="3" skipped="2">
    <testcase name="packs the payload (needs a POSIX shell)" classname="" line="4" assertions="0">
      <skipped />
    </testcase>
    <testcase name="runs everywhere" classname="" line="7" assertions="1" />
    <testcase name="mode bits &amp; the &quot;x&quot; bit (POSIX only)" classname="" line="9">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`;

  // Written by bun 1.4.2 for a file with describes titled "rows where count > 100" and
  // `inner & "quoted" <tag>`, a test.skip named "skipped a > b", a describe.skip titled
  // "outer skip > reason", and a three-level plain/mid/deep. Verbatim, because the point
  // of the case is the layout bun really writes.
  const nested = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="1" failures="0" skipped="3" time="0.013867416">
  <testsuite name="fixture.test.ts" file="fixture.test.ts" tests="4" assertions="1" failures="0" skipped="3" time="0.000620596" hostname="cevherips">
    <testsuite name="rows where count &gt; 100" file="fixture.test.ts" line="3" tests="2" assertions="1" failures="0" skipped="1" time="0" hostname="cevherips">
      <testsuite name="inner &amp; &quot;quoted&quot; &lt;tag&gt;" file="fixture.test.ts" line="4" tests="2" assertions="1" failures="0" skipped="1" time="0" hostname="cevherips">
        <testcase name="skipped a &gt; b" classname="inner &amp; &quot;quoted&quot; &lt;tag&gt; &gt; rows where count &gt; 100" time="0" file="fixture.test.ts" line="5" assertions="0">
          <skipped />
        </testcase>
        <testcase name="passes" classname="inner &amp; &quot;quoted&quot; &lt;tag&gt; &gt; rows where count &gt; 100" time="0.00001" file="fixture.test.ts" line="6" assertions="1" />
      </testsuite>
    </testsuite>
    <testsuite name="outer skip &gt; reason" file="fixture.test.ts" line="10" tests="1" assertions="0" failures="0" skipped="1" time="0" hostname="cevherips">
      <testcase name="inside a skipped describe" classname="outer skip &gt; reason" time="0" file="fixture.test.ts" line="11" assertions="0">
        <skipped />
      </testcase>
    </testsuite>
    <testsuite name="plain" file="fixture.test.ts" line="14" tests="1" assertions="0" failures="0" skipped="1" time="0" hostname="cevherips">
      <testsuite name="mid" file="fixture.test.ts" line="15" tests="1" assertions="0" failures="0" skipped="1" time="0" hostname="cevherips">
        <testsuite name="deep" file="fixture.test.ts" line="16" tests="1" assertions="0" failures="0" skipped="1" time="0" hostname="cevherips">
          <testcase name="leaf" classname="deep &gt; mid &gt; plain" time="0" file="fixture.test.ts" line="17" assertions="0">
            <skipped />
          </testcase>
        </testsuite>
      </testsuite>
    </testsuite>
  </testsuite>
</testsuites>`;

  test("names every skipped test, and nothing else", () => {
    expect(parseSkippedTests(report)).toEqual([
      "packs the payload (needs a POSIX shell)",
      'mode bits & the "x" bit (POSIX only)',
    ]);
  });

  test("a test skipped by its describe carries that describe's reason, outermost first", () => {
    // The Windows packaging skips are made with describe.skip, so the reason is in the
    // describe title and the test inside is only named for what it checks. The path comes
    // from the nested <testsuite> elements, never from classname: bun writes the separator
    // between two describe titles and a literal ">" inside one title identically, as
    // " &gt; ", so a title containing ">" came out split and reversed (measured 1.4.2:
    // "rows where count > 100" printed as "100 > rows where count").
    expect(parseSkippedTests(nested)).toEqual([
      'rows where count > 100 > inner & "quoted" <tag> > skipped a > b',
      "outer skip > reason > inside a skipped describe",
      "plain > mid > deep > leaf",
    ]);
  });

  test("a todo is not a skipped test, because bun writes it with the same element", () => {
    // bun 1.4.2 writes a todo as `<skipped message="TODO" />`, and readTestReport takes
    // the todos back out of the skip count. The titles have to leave them out too, or
    // the summary states one number and lists another (a file with 1 skip and 2 todos
    // printed "(1 skipped)" over three titles).
    const withTodos = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" failures="0" skipped="3">
  <testsuite name="tests/unit/mixed.test.ts" file="tests/unit/mixed.test.ts" tests="4" failures="0" skipped="3">
    <testcase name="runs everywhere" classname="" line="2" assertions="1" />
    <testcase name="packs the payload (needs a POSIX shell)" classname="" line="4" assertions="0">
      <skipped />
    </testcase>
    <testcase name="reads the manifest back" classname="" line="7" assertions="0">
      <skipped message="TODO" />
    </testcase>
    <testcase name="fails the build on a bad manifest" classname="" line="9" assertions="0">
      <skipped message="TODO" />
    </testcase>
  </testsuite>
</testsuites>`;

    expect(parseSkippedTests(withTodos)).toEqual(["packs the payload (needs a POSIX shell)"]);
    // The control: the counts read from the same report separate them the same way.
    expect(readTestReport(withTodos)).toEqual({ state: "read", counts: { pass: 1, fail: 0, skip: 1, todo: 2 } });
  });

  test("a report with no skips names nothing", () => {
    expect(parseSkippedTests('<testcase name="runs" classname="c" />')).toEqual([]);
  });

  test("a self-closing <testsuite /> opens no describe, so the titles after it keep their path", () => {
    // Tolerated, not observed: bun 1.4.2 writes no element at all for a describe with
    // nothing in it (measured against an empty describe, one holding only a hook, and an
    // empty describe.skip: none of the three appears in the report), so this shape comes
    // from the junit format rather than from today's writer. A suite element that opened
    // a scope it never closes would put its name in front of every title after it, which
    // is a wrong reason attached to a real skip, so the shape is pinned rather than left
    // to be discovered by whatever writes the next report.
    const selfClosing = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" failures="0" skipped="1">
  <testsuite name="fixture.test.ts" file="fixture.test.ts" tests="1" failures="0" skipped="1">
    <testsuite name="an empty describe" file="fixture.test.ts" line="3" tests="0" failures="0" skipped="0" />
    <testsuite name="outer" file="fixture.test.ts" line="5" tests="1" failures="0" skipped="1">
      <testcase name="the skip (no dpkg here)" classname="outer" line="6" assertions="0">
        <skipped />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>`;

    expect(parseSkippedTests(selfClosing)).toEqual(["outer > the skip (no dpkg here)"]);
  });

  test("a report that was never written, or was written half way, names what it reached rather than throwing", () => {
    expect(parseSkippedTests("")).toEqual([]);
    expect(parseSkippedTests('<testsuites><testcase name="cut off"')).toEqual([]);
    // Cut off in the middle of the second describe: the first skip is still named, and
    // the two the report never reached are simply absent.
    expect(parseSkippedTests(nested.slice(0, nested.indexOf("outer skip")))).toEqual([
      'rows where count > 100 > inner & "quoted" <tag> > skipped a > b',
    ]);
  });
});

function outcome(overrides: Partial<FileOutcome> = {}): FileOutcome {
  return {
    file: "tests/unit/a.test.ts",
    status: "passed",
    exitCode: 0,
    signal: null,
    durationMs: 420,
    output: "",
    counts: { pass: 13, fail: 0, skip: 0, todo: 0 },
    report: "read",
    skippedTests: [],
    ...overrides,
  };
}

describe("what the runner prints", () => {
  test("a passing file is one line with its position, time and counts", () => {
    const line = formatFileLine(outcome(), 12, 533);

    expect(line).toContain("12/533");
    expect(line).toContain("tests/unit/a.test.ts");
    expect(line).toContain("13 pass");
    expect(line).toContain("0.4s");
    expect(line).toContain("PASS");
  });

  test("a skipped test is visible on the file's line, so a platform skip is never silent", () => {
    const line = formatFileLine(outcome({ counts: { pass: 3, fail: 0, skip: 4, todo: 0 } }), 1, 1);

    expect(line).toContain("4 skip");
  });

  test("a failed file says so, and a timed-out file says how long it was given", () => {
    expect(formatFileLine(outcome({ status: "failed", exitCode: 1 }), 1, 1)).toContain("FAIL");

    const timedOut = formatFileLine(outcome({ status: "timed-out", exitCode: null, durationMs: 305_000 }), 1, 1);
    expect(timedOut).toContain("TIMEOUT");
    expect(timedOut).toContain("305.0s");
  });

  function summary(overrides: Partial<RunSummary> = {}): RunSummary {
    return {
      outcomes: [outcome()],
      failures: [],
      durationMs: 77_400,
      jobs: 16,
      timeoutMs: 300_000,
      totals: {
        files: 533,
        filesPassed: 533,
        filesFailed: 0,
        filesTimedOut: 0,
        filesWithoutCounts: 0,
        tests: { pass: 13_960, fail: 0, skip: 3, todo: 0 },
      },
      ...overrides,
    };
  }

  test("a green run reports the whole population, not just the failures", () => {
    const text = formatSummary(summary());

    expect(text).toContain("533 files");
    expect(text).toContain("13960");
    expect(text).toContain("3 skip");
    expect(text).toContain("77.4s");
    expect(text).toContain("16 jobs");
  });

  test("a timed-out file is reported against the budget, not against the time it took to die", () => {
    // The elapsed time is the budget plus the kill escalation, so printing it would
    // answer a question nobody asked: a 3 s budget reported "timed out after 8.0s".
    const timedOut = outcome({ file: "tests/unit/hang.test.ts", status: "timed-out", durationMs: 305_000 });
    const text = formatSummary(
      summary({
        failures: [timedOut],
        timeoutMs: 300_000,
        totals: { ...summary().totals, filesPassed: 532, filesTimedOut: 1 },
      }),
    );

    expect(text).toContain("the budget is 300.0s per file");
    expect(text).not.toContain("305.0s per file");
  });

  test("a failing file that wrote no test report says what that usually means, and that its tests are unaccounted for", () => {
    const silent = outcome({
      file: "tests/unit/c.test.ts",
      status: "failed",
      exitCode: 0,
      counts: null,
      report: "missing",
    });
    const text = formatSummary(summary({ failures: [silent], totals: { ...summary().totals, filesFailed: 1 } }));

    expect(text).toContain(
      "tests/unit/c.test.ts (exit 0, and it wrote no test report, which usually means it registered no test or stopped before bun finished, so its tests are unaccounted for)",
    );
    expect(formatFileLine(silent, 1, 1)).toContain("no test report");
  });

  test("a report that could not be read is named as unreadable, not as missing", () => {
    const garbled = outcome({
      file: "tests/unit/c.test.ts",
      status: "failed",
      exitCode: 0,
      counts: null,
      report: "unreadable",
    });
    const text = formatSummary(summary({ failures: [garbled], totals: { ...summary().totals, filesFailed: 1 } }));

    expect(text).toContain("tests/unit/c.test.ts (exit 0, and its test report could not be read");
    expect(text).not.toContain("wrote no test report");
    expect(formatFileLine(garbled, 1, 1)).toContain("unreadable test report");
  });

  test("a file killed by SIGKILL from outside says where that comes from and what to do", () => {
    // The runner sends SIGKILL itself only after a timeout, and that file is reported
    // as timed out, so a SIGKILL on a failed file came from outside. Measured: a real
    // kernel OOM kill of one child read only "killed by SIGKILL", which names neither
    // the cause nor anything the reader can act on.
    const killed = outcome({ file: "tests/unit/heavy.test.ts", status: "failed", exitCode: null, signal: "SIGKILL" });
    const text = formatSummary(summary({ failures: [killed], totals: { ...summary().totals, filesFailed: 1 } }));

    expect(text).toContain("OOM killer");
    expect(text).toContain("--jobs");
  });

  test("another signal keeps the plain wording, and a timed-out file keeps its own", () => {
    // The two controls for the case above: only an outside SIGKILL gets the advice.
    const segfault = outcome({ status: "failed", exitCode: null, signal: "SIGSEGV" });
    const segfaultText = formatSummary(
      summary({ failures: [segfault], totals: { ...summary().totals, filesFailed: 1 } }),
    );

    expect(segfaultText).toContain("(killed by SIGSEGV)");
    expect(segfaultText).not.toContain("--jobs");

    // A timed-out file is killed with SIGKILL by the runner itself.
    const timedOut = outcome({ status: "timed-out", exitCode: null, signal: "SIGKILL", durationMs: 305_000 });
    const timedOutText = formatSummary(
      summary({ failures: [timedOut], totals: { ...summary().totals, filesTimedOut: 1 } }),
    );

    expect(timedOutText).toContain("timed out, the budget is 300.0s per file");
    expect(timedOutText).not.toContain("OOM killer");
  });

  test("a file whose report counts no test at all says it registered none", () => {
    const empty = outcome({ status: "failed", counts: { pass: 0, fail: 0, skip: 0, todo: 0 } });
    const text = formatSummary(summary({ failures: [empty], totals: { ...summary().totals, filesFailed: 1 } }));

    expect(text).toContain("tests/unit/a.test.ts (exit 0, and it registered no test)");
  });

  test("one of something is not plural", () => {
    const text = formatSummary(
      summary({
        jobs: 1,
        totals: {
          files: 1,
          filesPassed: 1,
          filesFailed: 0,
          filesTimedOut: 0,
          filesWithoutCounts: 0,
          tests: { pass: 1, fail: 0, skip: 0, todo: 0 },
        },
      }),
    );

    expect(text).toContain("1 file: 1 passed");
    expect(text).toContain("1 test: 1 pass");
    expect(text).toContain("with 1 job");
  });

  test("a red run names every failing file and how to re-run it alone", () => {
    const failure = outcome({ file: "tests/unit/b.test.ts", status: "failed", exitCode: 1 });
    const text = formatSummary(
      summary({
        failures: [failure],
        totals: { ...summary().totals, filesPassed: 532, filesFailed: 1 },
      }),
    );

    expect(text).toContain("tests/unit/b.test.ts");
    expect(text).toContain("re-run alone with: bun tests/run-tests.ts tests/unit/b.test.ts");
    // Never bare `bun test ./file`: it takes no --jobs, which the SIGKILL reason above
    // tells the reader to lower, and it reads the verdict off the console instead of the
    // junit report, so a file calling process.exit(0) reads green when re-run that way.
    // It is also the form CONTRIBUTING.md and CLAUDE.md tell contributors not to use.
    expect(text).not.toContain("bun test ./");
  });

  test("a file that left no readable test report is called out, so the total is honest", () => {
    expect(formatSummary(summary({ totals: { ...summary().totals, filesWithoutCounts: 2 } }))).toContain(
      "2 files left no readable test report, so their tests are not in the totals above.",
    );
    expect(formatSummary(summary())).not.toContain("readable test report");
  });

  test("every file that skipped a test is named, with the titles that carry the reason", () => {
    // A test skipped because the artifact it drives cannot exist on this platform
    // (a deb postinstall, a snap launcher) says so in its own title, and bun prints
    // that title nowhere, so the summary is the only place a reader meets it.
    const skipping = outcome({
      file: "tests/unit/snap-launcher.test.ts",
      counts: { pass: 4, fail: 0, skip: 9, todo: 0 },
      skippedTests: ["the launcher exports SNAP_DATA (POSIX shell only)"],
    });
    const text = formatSummary(
      summary({
        outcomes: [outcome(), skipping],
        totals: { ...summary().totals, tests: { pass: 13_960, fail: 0, skip: 9, todo: 0 } },
      }),
    );

    expect(text).toContain("Files with skipped tests:");
    expect(text).toContain("tests/unit/snap-launcher.test.ts (9 skipped)");
    expect(text).toContain("the launcher exports SNAP_DATA (POSIX shell only)");
    expect(text).not.toContain("tests/unit/a.test.ts (");
  });

  test("the count over the titles is the number of titles under it, todos in neither", () => {
    // Read and printed the way the runner does it, from one report, so the section and
    // its header cannot drift apart: a todo is written as `<skipped message="TODO" />`,
    // and it belongs in neither, since "todo" is already its own count on the file line.
    const withTodos = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" failures="0" skipped="3">
  <testsuite name="tests/unit/mixed.test.ts" file="tests/unit/mixed.test.ts" tests="4" failures="0" skipped="3">
    <testcase name="runs everywhere" classname="" line="2" assertions="1" />
    <testcase name="packs the payload (needs a POSIX shell)" classname="" line="4" assertions="0">
      <skipped />
    </testcase>
    <testcase name="a todo nobody has written yet" classname="" line="7" assertions="0">
      <skipped message="TODO" />
    </testcase>
    <testcase name="a second todo" classname="" line="9" assertions="0">
      <skipped message="TODO" />
    </testcase>
  </testsuite>
</testsuites>`;
    const read = readTestReport(withTodos);
    if (read.state !== "read") throw new Error("the fixture is a report this parser reads");
    const mixed = outcome({
      file: "tests/unit/mixed.test.ts",
      counts: read.counts,
      skippedTests: parseSkippedTests(withTodos),
    });
    const text = formatSummary(
      summary({
        outcomes: [mixed],
        totals: { ...summary().totals, tests: { pass: 1, fail: 0, skip: 1, todo: 2 } },
      }),
    );

    expect(text).toContain("tests/unit/mixed.test.ts (1 skipped)");
    expect(text).toContain("    packs the payload (needs a POSIX shell)");
    expect(text).not.toContain("a todo nobody has written yet");
    expect(text).not.toContain("a second todo");
  });

  test("a file whose unrun tests are all todos is named nowhere as skipping something", () => {
    // The mirror of the case above: "3 todo" on the file line and in the totals is the
    // whole story, and a todo has no reason to state, so there is no section to print.
    const todosOnly = outcome({ file: "tests/unit/todo.test.ts", counts: { pass: 1, fail: 0, skip: 0, todo: 3 } });
    const text = formatSummary(
      summary({
        outcomes: [todosOnly],
        totals: { ...summary().totals, tests: { pass: 1, fail: 0, skip: 0, todo: 3 } },
      }),
    );

    expect(text).toContain("3 todo");
    expect(text).not.toContain("Files with skipped tests");
    // The control: the same file with one real skip is named, with its title.
    const withSkip = formatSummary(
      summary({
        outcomes: [outcome({ ...todosOnly, counts: { pass: 1, fail: 0, skip: 1, todo: 3 }, skippedTests: ["a skip"] })],
        totals: { ...summary().totals, tests: { pass: 1, fail: 0, skip: 1, todo: 3 } },
      }),
    );

    expect(withSkip).toContain("tests/unit/todo.test.ts (1 skipped)");
    expect(withSkip).toContain("a skip");
  });

  test("a file that counted skips whose titles it could not name is still named, with its count", () => {
    // The count and the titles come from different parts of the report (the <testsuites>
    // attributes and the <testcase> elements), so one can be there without the other.
    // "4 skipped" with no titles is less than this section is for and more than silence.
    const quiet = outcome({
      file: "tests/unit/quiet.test.ts",
      counts: { pass: 1, fail: 0, skip: 4, todo: 0 },
      skippedTests: [],
    });
    const text = formatSummary(
      summary({
        outcomes: [quiet],
        totals: { ...summary().totals, tests: { pass: 1, fail: 0, skip: 4, todo: 0 } },
      }),
    );

    expect(text).toContain("tests/unit/quiet.test.ts (4 skipped)");
  });

  test("a file whose report could not be read still names the skips it reached, under an unknown count", () => {
    // A child killed while bun was writing its report leaves a truncated one: the counts
    // are refused (they would undercount), but what it did reach still names tests, and
    // this section is the only place a skip's reason is ever printed. Selecting the
    // section by the skip count dropped exactly these files, since their count is null.
    const cut = outcome({
      file: "tests/unit/packaging.test.ts",
      status: "failed",
      exitCode: null,
      signal: "SIGKILL",
      counts: null,
      report: "unreadable",
      skippedTests: ["windows packaging (no dpkg on this platform) > packs the payload", "signs the installer"],
    });
    const text = formatSummary(
      summary({
        outcomes: [outcome(), cut],
        failures: [cut],
        totals: { ...summary().totals, filesFailed: 1, filesWithoutCounts: 1 },
      }),
    );

    expect(text).toContain("tests/unit/packaging.test.ts (unreadable report; it named 2 skipped tests)");
    expect(text).toContain("    windows packaging (no dpkg on this platform) > packs the payload");
    expect(text).toContain("    signs the installer");
    // The control: a file whose report was read keeps the plain count in its header.
    expect(text).not.toContain("tests/unit/a.test.ts (unreadable report");
  });

  test("files that could not run here are listed under the reason, which is printed once", () => {
    const notRun = [
      { file: "tests/unit/helm-chart-agent.test.ts", reason: "Helm is not installed." },
      { file: "tests/unit/helm-chart-route.test.ts", reason: "Helm is not installed." },
    ];
    const text = formatSummary(summary(), notRun);

    expect(text).toContain("Files not run on this machine:");
    expect(text.split("Helm is not installed.").length - 1).toBe(1);
    expect(text).toContain("tests/unit/helm-chart-agent.test.ts");
    expect(text).toContain("tests/unit/helm-chart-route.test.ts");
  });

  test("a run where everything could run says nothing about it", () => {
    expect(formatSummary(summary(), [])).not.toContain("not run on this machine");
  });

  test("a run with no skips says nothing about skips", () => {
    expect(formatSummary(summary())).not.toContain("Files with skipped tests");
  });
});
