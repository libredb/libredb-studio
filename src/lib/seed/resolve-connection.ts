import type { DatabaseConnection } from '@/lib/types';
import { getSeedConnectionById, getSeedConnectionByIdUnfiltered } from './index';
import { logger } from '@/lib/logger';

export class SeedConnectionError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'SeedConnectionError';
  }
}

export async function resolveConnection(
  body: { connection?: DatabaseConnection; connectionId?: string },
  session: { role: string; username: string },
): Promise<DatabaseConnection> {
  const { connection, connectionId } = body;

  if (connection && !connectionId) {
    return connection;
  }

  if (connectionId) {
    if (!connectionId.startsWith('seed:')) {
      throw new SeedConnectionError('Invalid connection ID format', 400);
    }

    const seedId = connectionId.slice(5);
    const seedConn = await getSeedConnectionById(seedId, [session.role]);

    if (!seedConn) {
      const exists = await getSeedConnectionByIdUnfiltered(seedId);
      if (exists) {
        logger.warn('Seed connection access denied', {
          route: 'seed/resolve-connection',
          connectionId: seedId,
          user: session.username,
          role: session.role,
        });
        throw new SeedConnectionError(
          `Access denied: connection "${seedId}" not available for role "${session.role}"`,
          403,
        );
      }
      throw new SeedConnectionError(`Seed connection "${seedId}" not found`, 404);
    }

    logger.debug('Resolved seed connection', {
      route: 'seed/resolve-connection',
      connectionId: seedId,
      user: session.username,
    });

    return seedConn;
  }

  throw new SeedConnectionError('Either connection or connectionId is required', 400);
}
