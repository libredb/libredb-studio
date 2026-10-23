/**
 * Reads one step of `.github/workflows/ci.yml` by its `name`, as text.
 *
 * WHY THIS EXISTS. Six provider fixtures are pinned in two places on purpose: the compose
 * fragment a developer runs and the CI step CI runs. Tests hold the two equal, because a pin
 * that lives in two files and is compared by nobody is two pins. Until 19 October 2026 those
 * tests compared the compose fragment against `docker/<engine>/ci-step.yml`, a file that was
 * written to be pasted into the workflow and never was, so the comparison held two files equal
 * while the file that actually ran was a third one nobody checked. The steps now live in
 * `ci.yml`, and this reader is what lets the same tests compare the pin against the step that
 * runs.
 *
 * It returns the step's own text and not the whole workflow, and that is the whole point: a
 * test that asks "is this the only digest here" cannot be handed a file carrying every other
 * job's images and action pins.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..", "..");
const STEP = /^ {6}- name: /;

/** The text of the `ci.yml` step with this name, from its `- name:` line to the next step. */
export function ciStep(name: string): string {
  const lines = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8").split("\n");
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  if (start < 0) {
    throw new Error(`.github/workflows/ci.yml has no step named "${name}"`);
  }
  const rest = lines.slice(start + 1).findIndex((line) => STEP.test(line));
  return (rest < 0 ? lines.slice(start) : lines.slice(start, start + 1 + rest)).join("\n");
}
