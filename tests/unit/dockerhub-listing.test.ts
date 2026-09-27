/**
 * Unit test for the Docker Hub listing text (`DOCKERHUB.md`), which the
 * `sync-dockerhub-description` job in .github/workflows/docker-build-push.yml
 * PATCHes onto the public repository page on every release. The whole path was
 * measured against the live API on 21 Sep 2026 against a throwaway repository,
 * which was deleted afterwards: this exact file PATCHes with 200 and reads back
 * byte-identical.
 *
 * The limits below are Docker Hub's, and they are enforced here rather than in
 * the workflow on purpose: a release-time check can only warn after the fact,
 * and a warning is exactly how the listing came to sit nine releases behind the
 * repo. Measured 20 Sep 2026, the live page still advertised
 * `docker pull libredb/libredb-studio:0.12.0` while this file said 0.16.1.
 * Crossing a limit has to fail a PR, at the commit that crosses it.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { WIRE_COMPATIBLE_ENGINES } from "@/lib/db/compatibility";

const REPO_ROOT = join(import.meta.dir, "../..");
const LISTING_PATH = join(REPO_ROOT, "DOCKERHUB.md");
const WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/docker-build-push.yml");

/**
 * Docker Hub caps `full_description` at 25000 BYTES, not characters - measured
 * against the live API on 21 Sep 2026 with a throwaway repository: 12501
 * two-byte characters is 12501 characters and 25002 bytes, and it is refused
 * with `Exceeded max number of bytes 25000 - actual 25002`. So a file can be
 * comfortably inside the limit by `String.length` and still be rejected.
 *
 * Held at 23000 rather than 25000: the file is one table of engines that grows
 * with every provider, and a guard that only trips at the wall leaves the
 * engine that crosses it nowhere to land.
 */
const FULL_DESCRIPTION_BUDGET = 23000;
/** Docker Hub caps the short description at 100. */
const SHORT_DESCRIPTION_LIMIT = 100;

const listing = readFileSync(LISTING_PATH, "utf8");

test("DOCKERHUB.md fits Docker Hub's full_description byte limit", () => {
  // Bytes is the measure the API enforces, and it is the larger of the two for
  // this file, which is not ASCII. Asserting it also holds the character count.
  expect(Buffer.byteLength(listing, "utf8")).toBeLessThanOrEqual(FULL_DESCRIPTION_BUDGET);
});

test("package.json description fits Docker Hub's short-description limit", () => {
  // The same string the sync job sends as `short-description`, so the listing
  // headline and the npm package headline cannot drift apart.
  const { description } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

  expect(typeof description).toBe("string");
  expect(description.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(SHORT_DESCRIPTION_LIMIT);
});

test("DOCKERHUB.md links and images are absolute", () => {
  // Docker Hub serves the listing from hub.docker.com, where a repo-relative
  // path resolves against the registry and 404s. This file is written absolute
  // today; the assertion is what keeps a copy-paste from README.md - which is
  // full of relative links - from silently breaking the public page.
  const markdownTargets = [...listing.matchAll(/]\(([^)]+)\)/g)].map((m) => m[1]);
  const htmlTargets = [...listing.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);

  const relative = [...markdownTargets, ...htmlTargets].filter((target) => !/^(https?:\/\/|#|mailto:)/.test(target));

  expect(relative).toEqual([]);
});

test("the sync job publishes the file this test guards", () => {
  // A guard pointed at a file the workflow does not publish guards nothing.
  const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8"));
  const step = workflow.jobs["sync-dockerhub-description"].steps.find((s: { uses?: string }) =>
    s.uses?.startsWith("peter-evans/dockerhub-description@"),
  );

  expect(step.with["readme-filepath"]).toBe("./DOCKERHUB.md");
});

test("the listing's relatives section names every verified relative", () => {
  // The section says every engine that connects through another's driver is named in it, and no
  // other test holds it to the registry: a relative whose row was left out passed every gate.
  const start = listing.indexOf("### Engines with no provider of their own");
  expect(start).toBeGreaterThan(-1);
  const rest = listing.slice(start + 1);
  const end = rest.search(/\n#{1,3} /);
  const section = end < 0 ? rest : rest.slice(0, end);
  // The control: the section holds its table, so an empty slice cannot pass the names below.
  expect(section).toContain("| Engine | Connect as | Support |");
  const missing = WIRE_COMPATIBLE_ENGINES.filter(
    (engine) => !section.includes(`${engine.name} |`) && !section.includes(`${engine.name} ·`),
  );
  expect(missing.map((engine) => engine.name)).toEqual([]);
});
