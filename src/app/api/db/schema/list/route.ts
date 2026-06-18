import { NextRequest } from 'next/server';
import { handleSchemaRequest } from '@/lib/api/schema-route';

export const dynamic = 'force-dynamic';

/**
 * Fast structural schema (tables + columns + PKs), excluding the expensive
 * foreign-key/index introspection. Used by the schema explorer to render the
 * table tree immediately; relationships/indexes are fetched separately via
 * /api/db/schema/relations and merged in asynchronously.
 *
 * Falls back to the full getSchema() for providers that don't implement the
 * fast path, so non-postgres databases keep working unchanged.
 */
export async function POST(req: NextRequest) {
  return handleSchemaRequest(req, 'api/db/schema/list', (provider) =>
    provider.getSchemaList ? provider.getSchemaList() : provider.getSchema(),
  );
}
