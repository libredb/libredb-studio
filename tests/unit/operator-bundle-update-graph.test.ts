/**
 * Where the committed OLM bundle sits in the community catalogs' update graph,
 * and which half of that graph the repo is allowed to know.
 *
 * `olm.skipRange` is derivable from package.json, so the repo owns it:
 * `make -C operator bundle` stamps `>=0.0.0 <$(VERSION)` and greps it back.
 * An unparseable range is *ignored with a log warning* upstream rather than
 * rejected, so a typo would silently degrade to no range at all - hence the
 * exact-string assertion rather than a loose match.
 *
 * `spec.replaces` is deliberately ABSENT, and that absence is the invariant
 * this file exists to hold. Its only correct value is the version immediately
 * preceding this one *in a given catalog*, which is external state: it lags
 * our releases by however many submissions are unmerged, it differs between
 * the two catalogs, and nothing in this repo can derive it. Stamping a
 * declared value here (what `CATALOG_REPLACES` did) makes the committed bundle
 * correct only by coincidence and stale by default, which is a cost paid on
 * every release.
 *
 * So the field is derived and injected at submission time instead, from the
 * catalog being submitted to. See docs/DISTRIBUTION.md, "The update graph".
 *
 * The consequence is worth stating plainly, because it looks like an omission:
 * this bundle on its own does NOT pass `opm index add --mode replaces`, which
 * reads `spec.replaces` and `spec.skips` and never `olm.skipRange`. That is
 * intended. Adding a `replaces` here to "fix" it reintroduces the stale value,
 * which is why the absence is asserted rather than merely documented.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const CSV = join(ROOT, "operator/bundle/manifests/libredb-studio-operator.clusterserviceversion.yaml");
const BASE_CSV = join(ROOT, "operator/config/manifests/bases/libredb-studio-operator.clusterserviceversion.yaml");

function packageVersion(): string {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

function annotation(file: string, name: string): string | undefined {
  const match = readFileSync(file, "utf8").match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.replace(/^['"]|['"]$/g, "");
}

/** A two-space-indented key, i.e. one directly under the CSV's `spec`. */
function csvField(name: string, file: string = CSV): string | undefined {
  return readFileSync(file, "utf8").match(new RegExp(`^  ${name}:\\s*(.+?)\\s*$`, "m"))?.[1];
}

describe("the committed bundle's place in the catalog update graph", () => {
  test("the CSV carries an olm.skipRange stamped from package.json", () => {
    expect(annotation(CSV, "olm\\.skipRange")).toBe(`>=0.0.0 <${packageVersion()}`);
  });

  test("the range excludes the bundle's own version, so the bundle cannot skip itself", () => {
    const range = annotation(CSV, "olm\\.skipRange");
    expect(range).toContain(`<${packageVersion()}`);
    expect(range).not.toContain(`<=${packageVersion()}`);
  });

  test("the base CSV holds the skipRange placeholder the Makefile stamps over", () => {
    // Mirrors containerImage: the stamp is a sed over a placeholder the base
    // owns, and sed exits 0 on zero matches - so a removed or reformatted
    // placeholder must be a visible failure here, not a silently unstamped CSV.
    expect(annotation(BASE_CSV, "olm\\.skipRange")).toBe(">=0.0.0 <0.0.0");
  });

  test("csvField can see a spec-level key at all, so the absences below mean something", () => {
    // The control for the three absence assertions that follow. Without it a
    // typo in the helper, a renamed file or a moved bundle would satisfy all
    // three by reading nothing.
    expect(csvField("version")).toBe(packageVersion());
    expect(csvField("version", BASE_CSV)).toBe("0.0.0");
  });

  test("the CSV declares no spec.replaces, because its value is not knowable here", () => {
    expect(csvField("replaces")).toBeUndefined();
  });

  test("the base CSV declares no replaces placeholder either", () => {
    // A placeholder would invite a stamp, and a stamp needs a declared value.
    expect(csvField("replaces", BASE_CSV)).toBeUndefined();
  });

  test("nothing in the operator build declares a replaces version to stamp", () => {
    // The whole point is that no such value exists in the repo. A narrow
    // pattern would catch only the exact name this bundle used to carry, so
    // this looks for any assignment or stamp that mentions replaces at all,
    // under any variable name.
    const makefile = readFileSync(join(ROOT, "operator/Makefile"), "utf8");
    const suspicious = makefile
      .split("\n")
      .filter((line) => /replaces/i.test(line))
      .filter((line) => !line.trimStart().startsWith("#"));
    expect(suspicious).toEqual([]);
  });

  test("the Makefile still stamps and verifies the half the repo does own", () => {
    // The counterpart control: proving replaces is gone means nothing if the
    // skipRange stamp went with it.
    const makefile = readFileSync(join(ROOT, "operator/Makefile"), "utf8");
    expect(makefile).toContain("olm.skipRange: '>=0.0.0 <$(VERSION)'");
    expect(makefile).toMatch(/grep -q "olm\.skipRange/);
  });
});
