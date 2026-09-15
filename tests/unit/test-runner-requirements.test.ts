import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { discoverTestFiles } from "../runner/discover";
import { missingHelm, parseRequirements, planRequirements, requiredCapabilities } from "../runner/requirements";

// A test file that needs an external tool says so in one line, and the runner decides what
// that means on this machine: run it, name it as not run, or refuse the whole run. The chart
// tests are the reason: they drive the real `helm` binary against a subchart that has to be
// downloaded, and a contributor who never touches the chart should not have to install either
// to get a green `bun run test`. CI sets LIBREDB_REQUIRE_HELM=1, so there nothing is ever
// quietly left out.
const root = path.resolve(import.meta.dir, "../..");

// Built from pieces so that no line of THIS file starts with the marker: the invariant test
// below reads every test file in the tree, this one included.
const MARKER = ["//", "@requires", "helm"].join(" ");

describe("reading what a test file requires", () => {
  test("a marker on its own line names a requirement", () => {
    expect(parseRequirements(`${MARKER}\nimport { test } from "bun:test";\n`, "tests/unit/a.test.ts")).toEqual([
      "helm",
    ]);
  });

  test("a file saved with CRLF line endings still declares its requirement", () => {
    // .gitattributes checks every text file out as LF, but an editor on Windows can save a new
    // test file with CRLF long before git ever normalises it. A multiline `$` already treats the
    // CR as a line end; this pins that, so a parser rewritten to split on "\n" cannot lose it.
    expect(parseRequirements(`${MARKER}\r\nimport { test } from "bun:test";\r\n`, "tests/unit/a.test.ts")).toEqual([
      "helm",
    ]);
  });

  test("the marker anywhere else is not a declaration", () => {
    const quoted = `const text = "${MARKER}";\n  ${MARKER}\n`;

    expect(parseRequirements(quoted, "tests/unit/a.test.ts")).toEqual([]);
    expect(parseRequirements('import { test } from "bun:test";\n', "tests/unit/a.test.ts")).toEqual([]);
  });

  test("a requirement the runner does not know is refused by name, never ignored", () => {
    expect(() => parseRequirements("// @requires docker\n", "tests/unit/b.test.ts")).toThrow(
      /tests\/unit\/b\.test\.ts declares "@requires docker"/,
    );
  });
});

describe("whether Helm is usable here", () => {
  test("no helm binary is the first thing said", () => {
    expect(missingHelm({ which: () => null, subchartBuilt: () => false })).toMatch(/Helm is not installed/);
  });

  test("a helm binary without the chart's built dependency names the command that builds it", () => {
    expect(missingHelm({ which: () => "/usr/bin/helm", subchartBuilt: () => false })).toContain(
      "helm dependency build charts/libredb-studio --skip-refresh",
    );
  });

  test("a helm binary and a built dependency is usable", () => {
    expect(missingHelm({ which: () => "/usr/bin/helm", subchartBuilt: () => true })).toBeNull();
  });
});

describe("what a run requires", () => {
  test("LIBREDB_REQUIRE_HELM=1 makes Helm a requirement of the run", () => {
    expect([...requiredCapabilities({ LIBREDB_REQUIRE_HELM: "1" })]).toEqual(["helm"]);
  });

  test("an unset or zero variable requires nothing", () => {
    expect([...requiredCapabilities({})]).toEqual([]);
    expect([...requiredCapabilities({ LIBREDB_REQUIRE_HELM: "0" })]).toEqual([]);
    expect([...requiredCapabilities({ LIBREDB_REQUIRE_HELM: "" })]).toEqual([]);
  });

  test("any other value is refused, because a typo must not quietly mean 'not required'", () => {
    expect(() => requiredCapabilities({ LIBREDB_REQUIRE_HELM: "true" })).toThrow(/LIBREDB_REQUIRE_HELM/);
  });
});

describe("planning the run", () => {
  const sources: Record<string, string> = {
    "tests/unit/chart.test.ts": `${MARKER}\ntest("renders", () => {});\n`,
    "tests/unit/plain.test.ts": 'test("adds", () => {});\n',
  };
  const readSource = (file: string) => sources[file] as string;
  const files = Object.keys(sources).sort();

  test("a file whose requirement is missing is not run, and says why; the rest run", () => {
    const plan = planRequirements({
      files,
      readSource,
      missing: { helm: () => "Helm is not installed." },
      required: new Set(),
    });

    expect(plan.run).toEqual(["tests/unit/plain.test.ts"]);
    expect(plan.notRun).toEqual([{ file: "tests/unit/chart.test.ts", reason: "Helm is not installed." }]);
  });

  test("a file whose requirement is present simply runs", () => {
    const plan = planRequirements({ files, readSource, missing: { helm: () => null }, required: new Set() });

    expect(plan.run).toEqual(files);
    expect(plan.notRun).toEqual([]);
  });

  test("a required capability that is missing stops the run and names the file and the variable", () => {
    expect(() =>
      planRequirements({
        files,
        readSource,
        missing: { helm: () => "Helm is not installed." },
        required: new Set(["helm"]),
      }),
    ).toThrow(/tests\/unit\/chart\.test\.ts needs helm, and LIBREDB_REQUIRE_HELM=1 .*Helm is not installed\./);
  });

  test("a selection in which nothing can run is an error, not an empty green run", () => {
    expect(() =>
      planRequirements({
        files: ["tests/unit/chart.test.ts"],
        readSource,
        missing: { helm: () => "Helm is not installed." },
        required: new Set(),
      }),
    ).toThrow(/None of the 1 selected file can run here/);
  });

  test("the machine is asked once per capability, not once per file", () => {
    let asked = 0;
    planRequirements({
      files: ["tests/unit/chart-a.test.ts", "tests/unit/chart-b.test.ts"],
      readSource: () => `${MARKER}\n`,
      missing: {
        helm: () => {
          asked += 1;
          return null;
        },
      },
      required: new Set(),
    });

    expect(asked).toBe(1);
  });
});

describe("every test file that drives helm declares it, and no other file does", () => {
  // The marker is only worth anything while it is true of the whole tree: a new chart test
  // that forgot it would fail on every machine without Helm, and a stale marker would hide a
  // file that needs nothing. Detection is the helm invocation itself, the one shape all twelve
  // chart tests share.
  const SPAWNS_HELM = /\[\s*"helm"\s*,\s*"(?:template|repo|dependency)"/;
  const files = discoverTestFiles(root).map((file) => ({ file, source: readFileSync(path.join(root, file), "utf8") }));
  const declaring = files.filter(({ file, source }) => parseRequirements(source, file).includes("helm"));
  const spawning = files.filter(({ source }) => SPAWNS_HELM.test(source));

  test("the tree has chart tests at all, so the two checks below are not vacuous", () => {
    expect(spawning.length).toBeGreaterThan(0);
  });

  test("a file that runs helm declares @requires helm", () => {
    expect(spawning.filter(({ file }) => !declaring.some((d) => d.file === file)).map(({ file }) => file)).toEqual([]);
  });

  test("a file that declares @requires helm runs helm", () => {
    expect(declaring.filter(({ file }) => !spawning.some((s) => s.file === file)).map(({ file }) => file)).toEqual([]);
  });
});
