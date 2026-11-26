/**
 * The built-in sample databases: a core-owned Studio feature, one row per engine that ships a sample.
 *
 * At boot (src/instrumentation.ts) `startSampleSeeding` decides once which samples are enabled, what each one's target
 * is and whether it is admitted, keeps that decision for the process, and copies each admitted sample's committed,
 * digest-pinned asset from the seed assets directory into the data directory, asynchronously, opening no database:
 * the copy is src/lib/seed/sample-copy.ts. The managed connections route lists a sample once its file exists, lists its
 * seed id in `pendingSeeds` while it copies, and lists it unavailable, with a named reason, when its copy failed, its
 * target was refused or its file was lost after boot (src/lib/seed/index.ts composes those listings from the kept
 * decision with the role filter, at request time).
 *
 * This module is loaded by the boot hook, so it imports no engine code and nothing that reaches it: not the role
 * filter (./connection-filter brings in the provider connection-string rows), and from ./types and @/lib/types only
 * types. tests/unit/seed/no-engine-imports.test.ts holds that.
 *
 * None of this is in the published @libredb/studio surface: instrumentation never runs there, no file is copied, and
 * no state is set.
 */
import * as fs from "fs";
import * as path from "path";
import { canonicalPath, foldPathKey, getDataDir, isReservedStoragePath, reservedStorageKey } from "@/lib/data-dir";
import { readEnabledProviders } from "@/lib/db/enabled-providers";
import { governanceEnabled } from "@/lib/governance/config";
import { accessReviewEnabled } from "@/lib/kubernetes-access/config";
import { logger } from "@/lib/logger";
import type { DatabaseType } from "@/lib/types";
import { copySampleAsset, errnoCode, messageOf, SampleCopyError } from "./sample-copy";
import type { ManagedConnection, SampleUnavailableReason } from "./types";

/** One built-in sample. */
export interface SampleSpec {
  /** The seed id; the connection id is `seed:<seedId>`. */
  readonly seedId: string;
  readonly name: string;
  /**
   * The roles it is offered to: `admin` exactly when its engine refuses a handle under a denied file-access posture
   * (Studio's grant of `policy.deniedFileAccessRefusal`), else every role.
   */
  readonly roles: readonly string[];
  /** The target's file name in the data directory, when no path override is set. */
  readonly fileName: string;
  /** The committed asset, relative to the seed assets directory, with `/` between segments. */
  readonly asset: string;
  /** The asset's SHA-256 digest, in lowercase hex, and its size: a copy of any other bytes is refused. */
  readonly sha256: string;
  readonly bytes: number;
  /** The variable that switches the sample off (`false`), or on under the Kubernetes access review (`true`). */
  readonly switchVariable: string;
  /** The variable that overrides the target's path. */
  readonly pathVariable: string;
}

/**
 * The built-in samples, in listing order: Map iteration follows insertion order, and every listing follows the map.
 *
 * The SQLite sample leads, and the order is the point: a client with no saved active connection opens the first one
 * listed, so the first sample is what a new administrator lands on. Agent mode executes statements on SQLite
 * (`GRANTED_AGENT_EXECUTION_ENGINES`, src/lib/db/claim-grants.ts), and the SQLite sample offers every agent workflow, where
 * the LibreDB one offers no plan or profile workflow. An operator's own seed connections still lead both.
 *
 * Each asset is the output of a committed script, held by a test that reruns it: scripts/generate-sqlite-sample.mjs
 * (tests/unit/seed/sqlite-sample-asset.test.ts) and scripts/generate-libredb-sample.mjs
 * (tests/unit/seed/libredb-sample-asset.test.ts). A change to an asset is a rerun and a new pin here.
 */
export const SAMPLES: ReadonlyMap<DatabaseType, SampleSpec> = new Map<DatabaseType, SampleSpec>([
  [
    "sqlite",
    {
      seedId: "sqlite-embedded-sample",
      name: "Sample (Employees)",
      roles: ["admin"],
      fileName: "sample-employees.db",
      asset: "sqlite/employee.db",
      sha256: "e640f759c20119081cbe7493f4bb2f812f965970aacc636fdfd4e8f8b5142acb",
      bytes: 815104,
      switchVariable: "SQLITE_EMBEDDED_SAMPLE",
      pathVariable: "SQLITE_EMBEDDED_SAMPLE_PATH",
    },
  ],
  [
    "libredb",
    {
      seedId: "libredb-embedded-sample",
      name: "Sample (LibreDB)",
      roles: ["*"],
      fileName: "sample.libredb",
      asset: "libredb/sample.libredb",
      sha256: "33ab4d1d0d513f370784f4a9d0f06d2ded759b67de310d7372ef4243f2a506da",
      bytes: 761,
      switchVariable: "LIBREDB_EMBEDDED_SAMPLE",
      pathVariable: "LIBREDB_EMBEDDED_SAMPLE_PATH",
    },
  ],
]);

/**
 * Whether a sample is on, one rule for every row. The listings read it once, at boot, through the admissions
 * `startSampleSeeding` keeps, so what a process offers has one source for its whole life, `LIBREDB_ENABLED_PROVIDERS`
 * included. Off under governance whatever its switch says (docs/GOVERNANCE.md). Off when `LIBREDB_ENABLED_PROVIDERS`
 * does not let the provider factory open its engine: the factory would refuse every open of it, so the sample could
 * never open; the list is the factory's own reading, and a value the factory refuses as a whole leaves every sample
 * off. Otherwise its switch decides: only the exact value `false` turns it off, except that with the Kubernetes access
 * review on, a sample offered to any role but admin is on only for the exact value `true`, because it is listed to
 * every signed-in person and names no Secret, so no review gates it, and an install that promises people only the
 * databases the review allows must not list it unasked.
 */
export function sampleEnabled(type: DatabaseType, spec: SampleSpec): boolean {
  if (governanceEnabled()) return false;
  const enabled = readEnabledProviders();
  if (enabled.kind === "refused") return false;
  if (enabled.kind === "listed" && !enabled.types.includes(type)) return false;
  const value = process.env[spec.switchVariable];
  if (accessReviewEnabled() && spec.roles.some((role) => role !== "admin")) return value === "true";
  return value !== "false";
}

/**
 * Whether a listing considers the sample at all: always, except in a test run, where only a sample whose path override
 * is set is considered, so an uncontrolled real ./data/sample.* cannot perturb unrelated suites.
 */
export function sampleConsidered(spec: SampleSpec): boolean {
  return process.env.NODE_ENV !== "test" || !!process.env[spec.pathVariable];
}

/** The path override when set, else the sample's file name in the data directory. */
export function sampleTarget(spec: SampleSpec): string {
  const override = process.env[spec.pathVariable];
  if (override) return override;
  return path.join(getDataDir(), spec.fileName);
}

/**
 * The seed assets directory: `SEED_ASSETS_DIR`, trimmed, resolved against the working directory when relative, as every
 * other path setting is; null when it is unset or blank. Every launcher sets it to its payload's own `seed-assets` as an
 * absolute path, and `bun dev` and `bun start` to the checkout's (docs/DISTRIBUTION.md, "Built-in sample assets"). The
 * server never takes it from its working directory: with none, a sample whose file is not in place yet is listed
 * unavailable as `asset-directory-unset`.
 */
export function seedAssetsDirectory(): string | null {
  const configured = (process.env.SEED_ASSETS_DIR ?? "").trim();
  return configured === "" ? null : path.resolve(configured);
}

/** The sample's asset file in the seed assets directory, or null when there is no seed assets directory. */
export function sampleAssetPath(spec: SampleSpec): string | null {
  const directory = seedAssetsDirectory();
  return directory === null ? null : path.join(directory, ...spec.asset.split("/"));
}

/** Why an enabled sample's target is refused before any copy, or null when it is admitted. */
export type SampleAdmissionRefusal = Extract<
  SampleUnavailableReason,
  "target-unreadable" | "target-reserved" | "target-conflict"
>;

/** An enabled sample, its target, and whether that target is admitted. */
export interface SampleAdmission {
  readonly type: DatabaseType;
  readonly spec: SampleSpec;
  readonly target: string;
  readonly refusal: SampleAdmissionRefusal | null;
  /** With `target-unreadable` only: the errno code and message of the error the path check threw. */
  readonly failure?: { readonly code: string | undefined; readonly message: string };
}

/** The file itself (no suffix) and the engines' sidecars. */
const FAMILY_SUFFIXES = ["", "-wal", "-shm", "-journal", ".lock"] as const;

/**
 * The files a sample on `target` can create, as real paths (`canonicalPath`), so two spellings of one file, through a
 * symlinked directory for one, name one family: the target and the engines' sidecars. A target can live in two places,
 * and the family claims both: where the copy's rename creates it (the real directory plus the target's own name, since
 * the rename replaces a symlink at the target with a regular file), and where an engine opens it (the target followed
 * through a symlink, dangling or not). The two are one place unless the target itself is a symlink. The copy's temp is
 * not a member: its name carries a random part (src/lib/seed/sample-copy.ts), so no other path can name it. Throws what
 * the path check throws.
 */
function targetFamily(target: string): string[] {
  const resolved = path.resolve(target);
  const created = path.join(canonicalPath(path.dirname(resolved)), path.basename(resolved));
  const opened = canonicalPath(resolved);
  const places = created === opened ? [created] : [created, opened];
  return places.flatMap((place) => FAMILY_SUFFIXES.map((suffix) => `${place}${suffix}`));
}

/**
 * The enabled samples, in table order, each with its target and admission, computed from the environment and the
 * filesystem as they are now; it never throws. `startSampleSeeding` computes it once, at boot, and keeps it, and the
 * listings read what it kept (`seededSampleAdmissions`). A sample whose target's path cannot be checked (an error other
 * than ENOENT, such as EACCES, ENOTDIR or ELOOP, from resolving it or checking its family) is refused
 * `target-unreadable` with that error; a sample any of whose family names one of the server's own storage files
 * (`isReservedStoragePath`, and `reservedStorageKey` on its paths as given as well as real) is refused
 * `target-reserved`; a sample whose family shares a file with an earlier admitted sample's is refused
 * `target-conflict`. A refused sample claims nothing.
 *
 * Two paths that differ only in letter case, or only in Unicode normalization form (NFC against NFD), are one file for
 * both comparisons, on every OS, because on macOS (both) and Windows (letter case) they name one file: a configuration
 * that conflicts there conflicts on Linux too. So the family is compared with normalization and letter case folded
 * (`foldPathKey`), as real paths and also as given: a symlinked directory spelled in another case or form is followed on
 * macOS and Windows but not on Linux, where only the paths as given still match.
 */
export function sampleAdmissions(): SampleAdmission[] {
  const claimed = new Set<string>();
  const admissions: SampleAdmission[] = [];
  for (const [type, spec] of SAMPLES) {
    if (!sampleEnabled(type, spec)) continue;
    const target = sampleTarget(spec);
    let keys: string[];
    let reserved: boolean;
    try {
      const family = targetFamily(target);
      const given = FAMILY_SUFFIXES.map((suffix) => `${path.resolve(target)}${suffix}`);
      const isReservedKey = reservedStorageKey();
      keys = [...family, ...given].map(foldPathKey);
      reserved = family.some((file) => isReservedStoragePath(file)) || keys.some(isReservedKey);
    } catch (error) {
      const failure = { code: errnoCode(error), message: messageOf(error) };
      admissions.push({ type, spec, target, refusal: "target-unreadable", failure });
      continue;
    }
    let refusal: SampleAdmissionRefusal | null = null;
    if (reserved) refusal = "target-reserved";
    else if (keys.some((key) => claimed.has(key))) refusal = "target-conflict";
    else for (const key of keys) claimed.add(key);
    admissions.push({ type, spec, target, refusal });
  }
  return admissions;
}

function withCode(code: string | undefined): string {
  return code === undefined ? "" : ` (${code})`;
}

/** The sentence a client shows for an unavailable sample: it names no path and no secret, and says where to look. */
export function unavailableSentence(reason: SampleUnavailableReason, code?: string): string {
  switch (reason) {
    case "asset-directory-unset":
      return "No seed assets directory is set (SEED_ASSETS_DIR), so this sample was not copied. Start the server through its launcher, or set SEED_ASSETS_DIR to the seed-assets directory of this release.";
    case "asset-missing":
      return "This sample's file is not in the seed assets directory (SEED_ASSETS_DIR), so it was not copied. The server log names the path.";
    case "asset-unreadable":
      return `This sample's file in the seed assets directory (SEED_ASSETS_DIR) could not be read${withCode(code)}, so it was not copied. The server log names the path.`;
    case "digest-mismatch":
      return "This sample's file in the seed assets directory is not the one this LibreDB Studio ships, so it was not copied.";
    case "copy-failed":
      return `This sample could not be copied into the server's data directory${withCode(code)}. The server log names the path.`;
    case "copy-defect":
      return "This sample's copy met an internal error, so it was not copied. The server log shows the error as an unhandled rejection.";
    case "target-unreadable":
      return `The server could not check this sample's path${withCode(code)}, so the sample is not created there. The server log names the path.`;
    case "target-reserved":
      return "This sample's path names one of the server's own storage files, so the sample is not created there.";
    case "target-conflict":
      return "This sample's path is another sample's, so only the first one is created.";
    case "target-lost":
      return `The server can no longer find or check this sample's file${withCode(code)}. The server log names the path.`;
  }
}

/**
 * A sample's seed state in this process. Absent until seeding starts; `seeding` while its copy runs; `done` once its
 * file is present; `failed`, with the reason and sentence the listing shows, when its copy failed, its target was
 * refused, or its file was lost after that (`sampleFilePresent`).
 */
export type SampleSeedState =
  | { readonly phase: "seeding" }
  | { readonly phase: "done" }
  | { readonly phase: "failed"; readonly reason: SampleUnavailableReason; readonly sentence: string };

/** What `startSampleSeeding` decided for this process: the admissions it computed, and each sample's seed state. */
interface SampleSeeding {
  readonly admissions: readonly SampleAdmission[];
  readonly states: Map<string, SampleSeedState>;
}

/**
 * Kept on globalThis under a Symbol.for key, because Next.js bundles instrumentation apart from the route handlers: a
 * module-level variable would be one per bundle, and the route would never see what boot wrote.
 */
const SAMPLE_SEEDING_KEY = Symbol.for("libredb-studio.sample-seeding");

type SampleSeedingHolder = { [SAMPLE_SEEDING_KEY]?: SampleSeeding };

/**
 * This process's seeding, or, in a process that never ran `startSampleSeeding`, one with no admission: such a process
 * offers no sample at all, whatever files exist. No production process lists samples without seeding: every server
 * channel runs register(), and neither the published @libredb/studio surface nor the VS Code extension's backend
 * reaches this module.
 */
function seeding(): SampleSeeding {
  const holder = globalThis as SampleSeedingHolder;
  holder[SAMPLE_SEEDING_KEY] ??= { admissions: [], states: new Map() };
  return holder[SAMPLE_SEEDING_KEY];
}

/** The admissions `startSampleSeeding` computed for this process, in table order; none before it runs. */
export function seededSampleAdmissions(): readonly SampleAdmission[] {
  return seeding().admissions;
}

export function getSampleSeedState(seedId: string): SampleSeedState | undefined {
  return seeding().states.get(seedId);
}

/** A test seam: sets a sample's state in this process's current seeding, as a copy in flight would. */
export function setSampleSeedState(seedId: string, state: SampleSeedState): void {
  seeding().states.set(seedId, state);
}

/** Forget this process's seeding, its admissions and its states, as a process that never seeded. */
export function resetSampleSeedStates(): void {
  delete (globalThis as SampleSeedingHolder)[SAMPLE_SEEDING_KEY];
}

/**
 * Whether an admitted sample's file is at its target now; a listing asks on every request. A file a check cannot find
 * or cannot check (ENOENT, EACCES, ENOTDIR and the like) is not there. A sample whose copy ended `done` and whose file
 * is then not there was lost after boot: in one synchronous step it is set `failed` with `target-lost` and that
 * error's code, and logged once as the warning "Embedded sample unavailable", so the listings show it unavailable
 * instead of dropping it in silence. It is listed again if its file comes back, and a later loss logs nothing more. A
 * sample still copying, or whose copy failed, has no file to lose: its check only answers.
 */
export function sampleFilePresent({ spec, target }: SampleAdmission): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch (error) {
    const { states } = seeding();
    if (states.get(spec.seedId)?.phase !== "done") return false;
    const code = errnoCode(error);
    states.set(spec.seedId, {
      phase: "failed",
      reason: "target-lost",
      sentence: unavailableSentence("target-lost", code),
    });
    logger.warn("Embedded sample unavailable", {
      route: "seed/samples",
      seedId: spec.seedId,
      reason: "target-lost",
      target,
      assets: seedAssetsDirectory(),
      error: messageOf(error),
    });
    return false;
  }
}

/** The listed connection of a sample whose file exists: editable, unmanaged, at its target, created at the epoch. */
export function sampleConnection(type: DatabaseType, spec: SampleSpec, target: string): ManagedConnection {
  return {
    id: `seed:${spec.seedId}`,
    seedId: spec.seedId,
    name: spec.name,
    type,
    database: target,
    managed: false,
    roles: [...spec.roles],
    createdAt: new Date(0),
  };
}

/**
 * Start copying every enabled sample, for the boot hook. Synchronously, before it returns, it computes the admissions
 * (`sampleAdmissions`) and keeps them for the process, replacing what an earlier call kept, and sets each enabled
 * sample `failed` with its admission refusal, or `seeding`, so no request can see a sample idle while its copy is about
 * to start. The returned promise settles once every copy has, concurrently. The boot hook does not wait for it.
 *
 * Each outcome sets the state and logs exactly one line in one synchronous step, so a state that is no longer
 * `seeding` means its line has been written: info "Embedded sample copied", debug "Embedded sample already present"
 * (every boot after the first), or warn "Embedded sample unavailable" with the reason, the target and the seed assets
 * directory (null when none is set). A failure never stops boot.
 *
 * copySampleAsset rejects with a SampleCopyError for every failure it knows. Anything else is a defect: its sample is
 * set `failed` with `copy-defect` and logged as above, so it never stays pending, and the error is rethrown, so the
 * returned promise rejects with it (with an AggregateError of them, in table order, when several copies met one). The
 * boot hook does not catch that rejection either: it surfaces as the process's unhandled rejection.
 */
export function startSampleSeeding(): Promise<void> {
  const assets = seedAssetsDirectory();
  const admissions = sampleAdmissions();
  const states = new Map<string, SampleSeedState>();
  (globalThis as SampleSeedingHolder)[SAMPLE_SEEDING_KEY] = { admissions, states };
  const copies: Promise<void>[] = [];
  for (const { spec, target, refusal, failure } of admissions) {
    if (refusal !== null) {
      states.set(spec.seedId, {
        phase: "failed",
        reason: refusal,
        sentence: unavailableSentence(refusal, failure?.code),
      });
      logger.warn("Embedded sample unavailable", {
        route: "instrumentation",
        seedId: spec.seedId,
        reason: refusal,
        target,
        assets,
        ...(failure === undefined ? {} : { error: failure.message }),
      });
      continue;
    }
    states.set(spec.seedId, { phase: "seeding" });
    const started = Date.now();
    const asset = sampleAssetPath(spec);
    const pinned = asset === null ? null : { asset, sha256: spec.sha256, bytes: spec.bytes };
    copies.push(
      copySampleAsset(pinned, target).then(
        (outcome) => {
          states.set(spec.seedId, { phase: "done" });
          if (outcome === "present") {
            logger.debug("Embedded sample already present", { route: "instrumentation", seedId: spec.seedId, target });
          } else {
            logger.info("Embedded sample copied", {
              route: "instrumentation",
              seedId: spec.seedId,
              target,
              durationMs: Date.now() - started,
            });
          }
        },
        (error: unknown) => {
          const known = error instanceof SampleCopyError;
          const reason = known ? error.reason : "copy-defect";
          states.set(spec.seedId, {
            phase: "failed",
            reason,
            sentence: unavailableSentence(reason, known ? error.code : undefined),
          });
          logger.warn("Embedded sample unavailable", {
            route: "instrumentation",
            seedId: spec.seedId,
            reason,
            target,
            assets,
            error: messageOf(error),
          });
          if (!known) throw error;
        },
      ),
    );
  }
  return Promise.allSettled(copies).then((outcomes) => {
    const defects = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
    if (defects.length === 1) throw defects[0];
    if (defects.length > 1) throw new AggregateError(defects, "More than one embedded sample copy met a defect");
  });
}
