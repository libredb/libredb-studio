import { readFile } from "fs/promises";
import { parse as parseYAML, YAMLParseError } from "yaml";
import { SeedConfigSchema, type SeedConfig } from "./types";
import { logger } from "@/lib/logger";

const DEFAULT_PATH = "/app/config/seed-connections.yaml";

let cachedConfig: SeedConfig | null = null;
let cachedAt = 0;
let cacheIsNull = false;

function getCacheTTL(): number {
  const raw = Number(process.env.SEED_CACHE_TTL_MS);
  return Number.isFinite(raw) ? raw : 60_000;
}

function getConfigPath(): string {
  return process.env.SEED_CONFIG_PATH || DEFAULT_PATH;
}

export function resetCache(): void {
  cachedConfig = null;
  cachedAt = 0;
  cacheIsNull = false;
}

/**
 * Where the file fails to parse, without the file's text. A parser's message quotes the line it
 * failed on, and in a seed file that line can hold a plaintext password; this message reaches every
 * caller of a `seed:` route through the error response, before any role filter runs. The parser's
 * own error stays attached as `cause`.
 */
function parseFailure(err: unknown, isJSON: boolean): string {
  if (err instanceof YAMLParseError) {
    const at = err.linePos?.[0];
    return at ? `${err.code} at line ${at.line}, column ${at.col}` : err.code;
  }
  return isJSON ? "the file is not valid JSON" : "the file is not valid YAML";
}

export async function loadConfig(): Promise<SeedConfig | null> {
  const now = Date.now();
  const ttl = getCacheTTL();

  if ((cachedConfig || cacheIsNull) && now - cachedAt < ttl) {
    return cachedConfig;
  }

  const configPath = getConfigPath();

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      logger.warn("Seed config file not found, seed connections disabled", {
        route: "seed/config-loader",
        path: configPath,
      });
      cachedConfig = null;
      cacheIsNull = true;
      cachedAt = now;
      return null;
    }
    throw err;
  }

  const isJSON = configPath.endsWith(".json");
  let parsed: unknown;
  try {
    parsed = isJSON ? JSON.parse(raw) : parseYAML(raw);
  } catch (err) {
    throw new Error(`Failed to parse seed config at ${configPath}: ${parseFailure(err, isJSON)}`, { cause: err });
  }

  const result = SeedConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid seed config: ${issues}`);
  }

  cachedConfig = result.data;
  cachedAt = now;
  cacheIsNull = false;

  logger.info("Seed config loaded", {
    route: "seed/config-loader",
    connectionCount: result.data.connections.length,
  });

  return cachedConfig;
}
