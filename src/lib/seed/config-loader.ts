import { readFile } from 'fs/promises';
import { parse as parseYAML } from 'yaml';
import { SeedConfigSchema, type SeedConfig } from './types';
import { logger } from '@/lib/logger';

const DEFAULT_PATH = '/app/config/seed-connections.yaml';

let cachedConfig: SeedConfig | null = null;
let cachedAt = 0;
let cacheIsNull = false;

function getCacheTTL(): number {
  return Number(process.env.SEED_CACHE_TTL_MS) || 60_000;
}

function getConfigPath(): string {
  return process.env.SEED_CONFIG_PATH || DEFAULT_PATH;
}

export function resetCache(): void {
  cachedConfig = null;
  cachedAt = 0;
  cacheIsNull = false;
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
    raw = await readFile(configPath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      logger.warn('Seed config file not found, seed connections disabled', {
        route: 'seed/config-loader',
        path: configPath,
      });
      cachedConfig = null;
      cacheIsNull = true;
      cachedAt = now;
      return null;
    }
    throw err;
  }

  const isJSON = configPath.endsWith('.json');
  let parsed: unknown;
  try {
    parsed = isJSON ? JSON.parse(raw) : parseYAML(raw);
  } catch (err) {
    throw new Error(`Failed to parse seed config at ${configPath}: ${err}`);
  }

  const result = SeedConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid seed config: ${issues}`);
  }

  cachedConfig = result.data;
  cachedAt = now;
  cacheIsNull = false;

  logger.info('Seed config loaded', {
    route: 'seed/config-loader',
    connectionCount: result.data.connections.length,
  });

  return cachedConfig;
}
