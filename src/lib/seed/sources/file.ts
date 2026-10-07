/**
 * The SEED_CONFIG_PATH source: one seed file, read on every load. The operator loader's cache is the only cache
 * (Spec A, section 5.2 step 6), so this source keeps none of its own.
 */
import { readFile } from "fs/promises";
import { logger } from "@/lib/logger";
import { entriesFromConfig, parseSeedConfigText, seedConfigFormatOf } from "./config-text";
import { OperatorSourceError, type OperatorLoadContext, type OperatorSource, type OperatorSourceResult } from "./types";

export const DEFAULT_SEED_CONFIG_PATH = "/app/config/seed-connections.yaml";

const ROUTE = "seed/sources/file";

/**
 * Paths already reported missing. A deployment that ships no seed file reads it again on every fill, so the
 * warning is logged once per path, and again only after the file has appeared and gone.
 */
const missingPathsLogged = new Set<string>();

/** `SEED_CONFIG_PATH` when non-empty (explicit), else the default path (not explicit). */
export function seedConfigPath(): { path: string; explicit: boolean } {
  const configured = process.env.SEED_CONFIG_PATH;
  return configured ? { path: configured, explicit: true } : { path: DEFAULT_SEED_CONFIG_PATH, explicit: false };
}

/** Clears the once-per-path "not found" log set. */
export function resetFileSourceState(): void {
  missingPathsLogged.clear();
}

async function loadFile(context: OperatorLoadContext): Promise<OperatorSourceResult> {
  const { path, explicit } = seedConfigPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // An error without a code is named by its name, so the message never reads "undefined".
      const reason = code ?? (err as Error).name;
      throw new OperatorSourceError("unreadable", `Cannot read seed config at ${path}: ${reason}`, { cause: err });
    }
    if (!missingPathsLogged.has(path)) {
      missingPathsLogged.add(path);
      logger.warn("Seed config file not found, seed connections disabled", { route: ROUTE, path });
    }
    // An explicit path the operator named is shown as not found; the absent default file is a zero-config install.
    return { entries: [], skips: [], notes: [], status: { state: explicit ? "missing" : "empty" } };
  }
  missingPathsLogged.delete(path);

  const config = parseSeedConfigText(raw, path, seedConfigFormatOf(path));
  logger.info("Seed config loaded", { route: ROUTE, connectionCount: config.connections.length });
  const entries = entriesFromConfig(config, path, context.literalValues);
  return { entries, skips: [], notes: [], status: { state: "ok" } };
}

export function createFileSource(): OperatorSource {
  return { name: "SEED_CONFIG_PATH", load: loadFile };
}
