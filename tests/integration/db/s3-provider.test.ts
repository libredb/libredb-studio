/**
 * The s3 provider, end to end over the recorded wire.
 *
 * Every capture under tests/fixtures/s3/captures/ was written by tests/live/s3-evidence.ts against a live compose
 * fixture (docker/s3/README.md) and is held by the digest tests/fixtures/s3/captures/README.md records. Each scenario
 * of tests/live/s3-evidence-plan.ts is replayed here through the real `S3Provider` over `recordedS3Transport`, which
 * calls the provider's signer exactly where the byte transport does and checks what was signed and sent against the
 * recording, and must answer what the server answered. The replay opens no socket. The object-surface contract runs
 * over each set's surface capture. `mock.module()` is not used.
 *
 * Servers: MinIO RELEASE.2025-10-15T17-29-55Z (built from source) with and without a site region, Silo
 * RELEASE.2026-09-16T00-00-00Z, Garage v2.4.1 and RustFS 1.0.1, each pinned in database-compose.yml.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import {
  captureFilesOnDisk,
  loadManifest,
  loadS3Capture,
  parseSetName,
  readDigestTable,
  S3_CAPTURES_ROOT,
} from "../../helpers/s3-fixtures";
import { recordedS3Transport, type S3Capture, type S3RecordedTransport } from "../../helpers/s3-wire";
import { runS3Scenario, S3_SCENARIOS, scenariosFor } from "../../live/s3-evidence-plan";
import {
  replayPrincipals,
  S3_CONFORMANCE,
  type S3RunContext,
  type S3StepSummary,
  wireViolations,
} from "../../live/s3-live-support";

/** Every file the README's digest table names: `| <set>/<file>.json | <sha256> |`. */
const TABLE = readDigestTable(readFileSync(path.join(S3_CAPTURES_ROOT, "README.md"), "utf8"));
const CAPTURES = TABLE.map((row) => row.file).filter((file) => !file.endsWith("/manifest.json"));

/** Replays one capture through the scenario it records, the same runner the live check calls. */
async function replay(
  file: string,
): Promise<{ capture: S3Capture; recorded: S3RecordedTransport; summaries: readonly S3StepSummary[] }> {
  const capture = loadS3Capture(file);
  const set = parseSetName(path.dirname(file));
  if (set === undefined) throw new Error(`${file} is not in a <target>-<date>-<version> set`);
  const planned = scenariosFor(set.target).find(({ scenario }) => scenario.name === capture.scenario);
  if (planned === undefined)
    throw new Error(`${file} records ${capture.scenario}, which ${set.target} does not record`);
  const recorded = recordedS3Transport(capture);
  const run: S3RunContext = {
    target: set.target,
    principals: replayPrincipals(set.target),
    createTransport: recorded.createTransport,
    // The recording already holds the scenario's offset: a signed exchange's x-amz-date, an unsigned one's date.
    clockFor: () => recorded.clock,
    signerWrapper: (signer) => signer,
    setStep: (step) => recorded.setStep(step),
    sockets: () => 0,
    recorded: () => recorded.sent,
  };
  const runs = await runS3Scenario(planned.scenario, run, planned.steps, {
    assertSurface: (provider) => assertObjectSurface(provider, S3_CONFORMANCE),
  });
  recorded.assertConsumed();
  return { capture, recorded, summaries: runs.map((stepRun) => stepRun.summary) };
}

describe("S3 captures", () => {
  test("1. the README's digest table lists exactly the captures on disk, and every digest holds", () => {
    expect(CAPTURES.length).toBeGreaterThan(0);
    expect(captureFilesOnDisk()).toEqual(TABLE.map((row) => row.file).sort());
    for (const { file, sha256 } of TABLE)
      expect({
        file,
        sha256: createHash("sha256")
          .update(readFileSync(path.join(S3_CAPTURES_ROOT, file)))
          .digest("hex"),
      }).toEqual({ file, sha256 });
  });

  test("five sets, one per capture target, each manifest naming exactly its scenarios", () => {
    const sets = [...new Set(TABLE.map((row) => path.dirname(row.file)))].map((name) => parseSetName(name));
    expect(sets.map((set) => set?.target).sort()).toEqual(["garage", "minio", "minio-region", "rustfs", "silo"]);
    for (const set of sets) {
      if (set === undefined) continue;
      const manifest = loadManifest(set.name);
      const files = CAPTURES.filter((file) => path.dirname(file) === set.name).map((file) =>
        path.basename(file, ".json"),
      );
      expect(manifest.scenarios.map((scenario) => scenario.name).sort()).toEqual(files.sort());
      expect(files.sort()).toEqual(
        scenariosFor(set.target)
          .map(({ scenario }) => scenario.name)
          .sort(),
      );
    }
  });

  test.each(CAPTURES)("2. %s replays to the answer the server gave", async (file) => {
    const { capture, summaries } = await replay(file);
    expect(summaries).toEqual(capture.result as readonly S3StepSummary[]);
  });

  test("3. every exchange of every capture is GET or HEAD, with no attributes query, no max-keys outside 1 to 1,000, no start-after and no multi-range", () => {
    const requests = CAPTURES.flatMap((file) => loadS3Capture(file).exchanges.map((exchange) => exchange.request));
    for (const row of ["A52", "A45", "A26", "A27", "A33", "A53", "A54"] as const)
      expect({ row, violations: wireViolations(row, requests) }).toEqual({ row, violations: [] });
  });

  test("4. the object-surface contract holds over each set's surface capture", async () => {
    const surfaces = CAPTURES.filter((file) => path.basename(file) === "surface.json");
    expect(surfaces).toHaveLength(5);
    for (const file of surfaces) {
      const { summaries } = await replay(file);
      expect(summaries).toEqual([{ step: "surface", ok: {}, exchanges: summaries[0].exchanges }]);
    }
  });

  test("every scenario of the plan is recorded on every target that runs it", () => {
    for (const set of [...new Set(CAPTURES.map((file) => path.dirname(file)))]) {
      const target = parseSetName(set)?.target;
      if (target === undefined) continue;
      for (const { scenario } of scenariosFor(target)) expect(CAPTURES).toContain(`${set}/${scenario.name}.json`);
    }
    expect(S3_SCENARIOS.length).toBeGreaterThan(0);
  });
});

describe("console over captures", () => {
  test("a write-shaped command is refused with nothing sent", async () => {
    for (const file of CAPTURES.filter((name) => path.basename(name) === "A50.json")) {
      const { recorded, summaries } = await replay(file);
      expect(summaries.every((summary) => summary.refused !== undefined && summary.exchanges === 0)).toBe(true);
      // Only the session's own connect probes were sent, never anything the refused commands asked for.
      expect(recorded.sent.every((request) => request.method === "GET" && request.path === "/")).toBe(true);
    }
  });
});

describe("Source tab and preview over captures", () => {
  test("the Source tab's metadata part of meta/tagged.txt reads the measured fields on every set", async () => {
    for (const file of CAPTURES.filter((name) => path.basename(name) === "A28.json")) {
      const { summaries } = await replay(file);
      const tagged = summaries.find((summary) => summary.step === "tagged");
      expect(tagged?.ok?.headers?.size_bytes).toBe("12");
      expect(tagged?.ok?.headers?.["user_metadata.project"]).toBe("libredb");
    }
  });
});
