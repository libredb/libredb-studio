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
 * change, no settings screen. It is a file path rather than a URL deliberately: it works in an
 * air-gapped install, it needs no cache or fetch-failure story, and it matches how this product
 * is configured everywhere else.
 *
 * MERGED PER MODEL, WHOLE ENTRY, NEVER PER FIELD ACROSS SOURCES. An operator entry for
 * `qwen3:8b` replaces the bundled entry for `qwen3:8b` entirely; it does not contribute one
 * field to it. Half of one measurement beside half of another is a configuration nobody has ever
 * run, and it would resolve without anybody being able to say what it was.
 *
 * A BAD OPERATOR DOCUMENT IS IGNORED, LOUDLY. It is refused whole, the reason is logged, and the
 * bundled document stands — which is a measured configuration, where a half-applied one is not.
 * `../config.ts` states the same policy for its own variable: a mistyped setting must not take
 * the runtime down.
 */
import { readFileSync } from "node:fs";
import { logger } from "@/lib/logger";
import { agentModelTuningPath } from "../config";
import type { AgentModelProfile } from "../models/profile";
import { type ModelTuning, parseTuning } from "./schema";
import bundled from "./measured-profiles.json";

/**
 * Statically imported, never read from disk.
 *
 * `next build` traces what it can see; a path assembled at runtime is not traced, so a
 * `readFileSync` here would work on this laptop and ship an image whose agent has no settings.
 */
const BUNDLED_ORIGIN = "bundled";

let active: ModelTuning | null = null;

/** Reads the operator's document, or explains why it is not being used and returns null. */
function readOperatorDocument(path: string): ModelTuning | null {
  try {
    return parseTuning(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    logger.warn("Operator model tuning ignored; the measurements Studio ships with still stand", {
      route: "agent/model-tuning",
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
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
  const operator = path === undefined ? null : readOperatorDocument(path);
  if (operator === null) {
    active = base;
    return active;
  }

  active = {
    // Whole entries, later wins. `providers` merges the same way, one tier at a time.
    models: { ...base.models, ...operator.models },
    providers: { ...base.providers, ...operator.providers },
    measuredAgainst: base.measuredAgainst,
    undocumentedOverrides: [...base.undocumentedOverrides, ...operator.undocumentedOverrides],
  };
  logger.info("Operator model tuning applied over the measurements Studio ships with", {
    route: "agent/model-tuning",
    path,
    models: Object.keys(operator.models).length,
  });
  return active;
}

/** Drops the memo so a test can change the environment and read the result. */
export function resetTuning(): void {
  active = null;
}

/**
 * What one model inherits before its own entry is applied: its provider's tier, or nothing.
 *
 * Separate from `activeTuning` because the resolvers ask about one model at a time, and because
 * this is the layer requirement (c) is about — a model with no entry of its own still gets the
 * settings its provider was measured with.
 */
export function providerTier(provider: string | undefined): Partial<AgentModelProfile> {
  if (provider === undefined) return {};
  return activeTuning().providers[provider] ?? {};
}
