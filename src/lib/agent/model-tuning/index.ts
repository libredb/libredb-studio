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
 * A BAD OPERATOR DOCUMENT IS IGNORED, AND SAYS SO. It is refused whole, the bundled document
 * stands — which is a measured configuration, where a half-applied one is not — and the reason is
 * both logged AND returned by `operatorTuningStatus()`. Two surfaces because they answer to
 * different people: the log is for whoever is tailing it at the moment it happens, and the status
 * is for the operator who mounted a file, sees the shipped behaviour instead, and has to find out
 * why. `../config.ts` states the same fail-open policy for its own variable: a mistyped setting
 * must not take the runtime down. Fail-open with no diagnosis is just a setting that does nothing.
 */
import { readFileSync } from "node:fs";
import { logger } from "@/lib/logger";
import { agentModelTuningPath } from "../config";
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
    }
  | { readonly state: "ignored"; readonly path: string; readonly reason: string };

let active: ModelTuning | null = null;
let operatorStatus: OperatorTuningStatus = { state: "unset" };

/** The operator's document, or the reason it is not being used. Never throws. */
function readOperatorDocument(path: string): { readonly doc: ModelTuning } | { readonly reason: string } {
  try {
    // The tolerant contract, because this document has a different author: see `parseOperatorTuning`.
    return { doc: parseOperatorTuning(JSON.parse(readFileSync(path, "utf8")), path) };
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

  active = {
    // Whole entries, later wins.
    models: { ...base.models, ...read.doc.models },
    measuredAgainst: base.measuredAgainst,
    undocumentedOverrides: [...base.undocumentedOverrides, ...read.doc.undocumentedOverrides],
    ignoredKeys: read.doc.ignoredKeys,
  };
  operatorStatus = {
    state: "applied",
    path,
    models: Object.keys(read.doc.models).length,
    ignoredKeys: read.doc.ignoredKeys,
  };
  logger.info("Operator model tuning applied over the measurements Studio ships with", {
    route: "agent/model-tuning",
    path,
    models: operatorStatus.models,
    ignoredKeys: read.doc.ignoredKeys.length,
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

/** Drops the memo so a test can change the environment and read the result. */
export function resetTuning(): void {
  active = null;
  operatorStatus = { state: "unset" };
}
