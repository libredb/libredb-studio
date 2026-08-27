/**
 * Which measured profiles are in force, and where they came from.
 *
 * Two sources, in order. The BUNDLED document ships with Studio and is what a default install
 * runs — vendored, not a dependency, because "a default install behaves as it was measured"
 * cannot be contingent on what a lockfile resolves to. An OPERATOR document, named by
 * `agentModelTuningPath()`, is read once and layered on top.
 *
 * The operator layer is the point of the whole exercise. A model nobody here has measured can be
 * given the settings somebody else measured, by mounting a file — no Studio release, no code
 * change, no settings screen. It is a file path rather than a URL deliberately: it needs no cache
 * and no story about what a run should do while a fetch is in flight, and it matches how this
 * product is configured everywhere else.
 *
 * MERGED PER MODEL, WHOLE ENTRY, NEVER PER FIELD ACROSS SOURCES. An operator entry for
 * `qwen3:8b` replaces the bundled entry for `qwen3:8b` entirely; it does not contribute one
 * field to it. Half of one measurement beside half of another is a configuration nobody has ever
 * run, and it would resolve without anybody being able to say what it was.
 *
 * A BAD OPERATOR DOCUMENT IS IGNORED, AND SAYS SO. Whole where nothing in it survives — bad JSON,
 * a wrong `schemaVersion`, an unreadable path — and per ENTRY otherwise: an entry that does not
 * read is dropped and reported by id, and the entries beside it apply (`schema.ts` rule 3). Where
 * the document is refused whole the bundled document stands — which is a measured configuration, where a half-applied one is not — and the reason is
 * both logged AND returned by `operatorTuningStatus()`. Two surfaces because they answer to
 * different people: the log is for whoever is tailing it at the moment it happens, and the status
 * is for the operator who mounted a file, sees the shipped behaviour instead, and has to find out
 * why. `../config.ts` states the same fail-open policy for its own variable: a mistyped setting
 * must not take the runtime down. Fail-open with no diagnosis is just a setting that does nothing.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { logger } from "@/lib/logger";
import { agentModelTuningPath } from "../config";
import type { AgentRunTuningProvenance } from "../types";
import { type ModelTuning, parseOperatorTuning, parseTuning } from "./schema";
import bundled from "./measured-profiles.json";

/**
 * Statically imported, never read from disk.
 *
 * `next build` traces what it can see; a path assembled at runtime is not traced, so a
 * `readFileSync` here would work on this laptop and ship an image whose agent has no settings.
 */
const BUNDLED_ORIGIN = "bundled";

/**
 * What became of the operator's document, for whoever has to explain a run.
 *
 * A discriminated union rather than a state string beside optional fields, so a caller cannot read
 * a `reason` off a document that was applied, or a model count off one that was not.
 */
export type OperatorTuningStatus =
  | { readonly state: "unset" }
  | {
      readonly state: "applied";
      readonly path: string;
      readonly models: number;
      /**
       * Keys the document stated that this Studio does not implement — a misspelling, or a setting
       * from a newer Studio. Reported because the document was applied around them: without this
       * an operator's `retryEmtpyTurn` would do nothing and say nothing.
       */
      readonly ignoredKeys: readonly string[];
      /**
       * Entries that did not read, by id, and so were not applied — `"<id>: <what was wrong>"`.
       *
       * Reported for the reason `ignoredKeys` is: the document was applied AROUND them, and
       * `models` above counts what DID apply, so without this an entry would vanish silently.
       * Empty is the ordinary case, and it is not the same statement as an absent field: this is
       * present on every applied document, so an empty list means every entry read.
       */
      readonly skippedEntries: readonly string[];
      /**
       * SHA-256 of the document's bytes AS READ.
       *
       * The path says which file; this says which version of it. A run recorded against a path
       * alone cannot be told apart from a run against that path after somebody edited it, which
       * is most of what recording the path was for.
       *
       * Of the bytes rather than of the parsed result: a parsed object would have to be
       * serialised to be hashed, and two serialisations of one document are the same file while
       * two files that happen to mean the same thing are not the same evidence.
       */
      readonly digest: string;
    }
  | { readonly state: "ignored"; readonly path: string; readonly reason: string };

let active: ModelTuning | null = null;
/**
 * The model ids the operator's document supplied, lower-cased.
 *
 * Kept because provenance is a question about ONE model: a document that names `mistral-small:24b`
 * did not drive a run on `gemini-3.5-flash-lite`, and saying it did names a file that never touched
 * the run. `activeTuning` merges the two maps and forgets which side each entry came from, so the
 * keys are recorded as they are merged.
 */
let operatorModels: ReadonlySet<string> = new Set();
let operatorStatus: OperatorTuningStatus = { state: "unset" };

/** The operator's document with the digest of what was read, or the reason it is not used. Never throws. */
function readOperatorDocument(
  path: string,
): { readonly doc: ModelTuning; readonly digest: string } | { readonly reason: string } {
  try {
    // Read as BYTES and hashed as bytes. `readFileSync(path, "utf8")` decodes, and decoding is
    // lossy: invalid UTF-8 inside an otherwise parseable document becomes U+FFFD, so two different
    // files can re-encode to one string and hash the same. A digest that cannot tell two files
    // apart is not doing the job the path was recorded for.
    const bytes = readFileSync(path);
    // The tolerant contract, because this document has a different author: see `parseOperatorTuning`.
    const doc = parseOperatorTuning(JSON.parse(bytes.toString("utf8")), path);
    // Hashed here rather than by the caller, because THESE are the bytes that were parsed: a
    // second read to hash could get a different file, which is the one thing a digest must rule out.
    return { doc, digest: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The profiles in force, resolved once.
 *
 * Lazy rather than a module-level constant, following `../config.ts`: a constant would read the
 * environment at import time, which is before a test can set it and before a container has
 * finished starting.
 */
export function activeTuning(): ModelTuning {
  if (active !== null) return active;

  const base = parseTuning(bundled, BUNDLED_ORIGIN);
  const path = agentModelTuningPath();
  if (path === undefined) {
    operatorStatus = { state: "unset" };
    active = base;
    return active;
  }

  const read = readOperatorDocument(path);
  if ("reason" in read) {
    operatorStatus = { state: "ignored", path, reason: read.reason };
    logger.warn("Operator model tuning ignored; the measurements Studio ships with still stand", {
      route: "agent/model-tuning",
      path,
      error: read.reason,
    });
    active = base;
    return active;
  }

  operatorModels = new Set(Object.keys(read.doc.models));
  active = {
    // Whole entries, later wins.
    models: { ...base.models, ...read.doc.models },
    measuredAgainst: base.measuredAgainst,
    undocumentedOverrides: [...base.undocumentedOverrides, ...read.doc.undocumentedOverrides],
    ignoredKeys: read.doc.ignoredKeys,
    skippedEntries: read.doc.skippedEntries,
  };
  // `applied` even when every entry was skipped: the document parsed and was layered on, which is
  // a different fact from `ignored`, and `models` plus `skippedEntries` say exactly what it added.
  operatorStatus = {
    state: "applied",
    path,
    models: Object.keys(read.doc.models).length,
    ignoredKeys: read.doc.ignoredKeys,
    skippedEntries: read.doc.skippedEntries,
    digest: read.digest,
  };
  logger.info("Operator model tuning applied over the measurements Studio ships with", {
    route: "agent/model-tuning",
    path,
    models: operatorStatus.models,
    ignoredKeys: read.doc.ignoredKeys.length,
    skippedEntries: read.doc.skippedEntries.length,
  });
  return active;
}

/**
 * What became of the operator's document.
 *
 * Resolves the tuning first, because the status is a by-product of reading it: a caller asking
 * before any run has needed a profile would otherwise be told "unset" about a document that is
 * about to be applied.
 */
export function operatorTuningStatus(): OperatorTuningStatus {
  activeTuning();
  return operatorStatus;
}

/**
 * The same fact a run needs to record: where the settings that drove it came from.
 *
 * Here rather than in the drive, because it is a projection of THIS module's status and belongs
 * beside the thing it projects. In the drive it would be a four-line mapping nothing could test
 * without driving a model.
 *
 * `unset` becomes `bundled` rather than being left out: a ledger silent about provenance and one
 * that says "the shipped measurements" are different claims, and only the second is checkable.
 * `ignored` keeps its own origin for the reason the fail-open policy exists — a run driven by the
 * shipped settings because nobody configured a document and one driven by them because the
 * operator's could not be read behave identically and mean opposite things.
 */
export function tuningProvenance(modelId: string): AgentRunTuningProvenance {
  const status = operatorTuningStatus();
  if (status.state === "unset") return { origin: "bundled" };
  if (status.state === "ignored") return { origin: "operator-ignored" };
  // Applied, but silent about this model: the run was driven by the shipped settings, and saying
  // otherwise would attribute it to a document that contributed nothing to it. Lower-cased because
  // that is how the register is keyed, and a provenance that disagreed with the resolver about
  // which entry applies would be worse than none.
  if (!operatorModels.has(modelId.toLowerCase())) return { origin: "bundled" };
  return { origin: "operator", digest: status.digest };
}

/** Drops the memo so a test can change the environment and read the result. */
export function resetTuning(): void {
  active = null;
  operatorStatus = { state: "unset" };
  operatorModels = new Set();
}
