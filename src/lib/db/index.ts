/**
 * Database Provider Module
 * Strategy Pattern implementation for multi-database support
 *
 * @example
 * import { getOrCreateProvider } from '@/lib/db';
 *
 * // Use cached provider (recommended for API routes)
 * const provider = await getOrCreateProvider(connection);
 * const result = await provider.query('SELECT * FROM users');
 */

// ============================================================================
// Factory (Primary API)
// ============================================================================

export { getOrCreateProvider, createDatabaseProvider } from "./factory";

// ============================================================================
// Types & Interfaces
// ============================================================================

// Only what an in-repo consumer actually imports from this barrel. The npm
// package's public type surface is `src/exports/types.ts`, which re-exports
// from `src/lib/types` directly and never passes through here - so a type
// mirrored here for symmetry is dead weight, not API.
export type { MaintenanceType } from "./types";
