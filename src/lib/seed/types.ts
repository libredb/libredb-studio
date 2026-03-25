import { z } from 'zod';
import type { DatabaseConnection } from '@/lib/types';

// SSLMode matches src/lib/types.ts line 21 — NO 'prefer'
const SSLModeSchema = z.enum(['disable', 'require', 'verify-ca', 'verify-full']);

const SSLConfigSchema = z.object({
  mode: SSLModeSchema.optional(),
  rejectUnauthorized: z.boolean().optional(),
  caCert: z.string().optional(),
  clientCert: z.string().optional(),
  clientKey: z.string().optional(),
}).optional();

const ConnectionEnvironmentSchema = z.enum([
  'production', 'staging', 'development', 'local', 'other',
]);

// Allowed roles in current iteration (matches JWT role: 'admin' | 'user' + wildcard)
const AllowedRoleSchema = z.enum(['*', 'admin', 'user']);

const SeedDatabaseType = z.enum([
  'postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'oracle', 'mssql',
]);

export const SeedDefaultsSchema = z.object({
  managed: z.boolean().optional(),
  environment: ConnectionEnvironmentSchema.optional(),
  ssl: SSLConfigSchema,
});

export const SeedConnectionSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'ID must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1).max(128),
  type: SeedDatabaseType,
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  connectionString: z.string().optional(),
  environment: ConnectionEnvironmentSchema.optional(),
  group: z.string().max(64).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  roles: z.array(AllowedRoleSchema).min(1, 'At least one role is required'),
  managed: z.boolean().optional(),
  ssl: SSLConfigSchema,
  serviceName: z.string().optional(),
  instanceName: z.string().optional(),
});

export const SeedConfigSchema = z.object({
  version: z.literal('1'),
  defaults: SeedDefaultsSchema.optional(),
  connections: z.array(SeedConnectionSchema).min(1, 'At least one connection is required'),
}).refine(
  (cfg) => new Set(cfg.connections.map((c) => c.id)).size === cfg.connections.length,
  { message: 'Connection IDs must be unique' },
);

export type SeedConnection = z.infer<typeof SeedConnectionSchema>;
export type SeedDefaults = z.infer<typeof SeedDefaultsSchema>;
export type SeedConfig = z.infer<typeof SeedConfigSchema>;

export interface ManagedConnection extends DatabaseConnection {
  managed: boolean;
  roles: string[];
  seedId: string;
}
