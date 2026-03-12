import { NextResponse } from 'next/server';
import { DatabaseConnection } from '@/lib/types';
import { createErrorResponse } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

/**
 * GET /api/demo-connection
 * Returns demo database connection if DEMO_DB_ENABLED is true
 * This allows users to instantly try the app with a pre-configured database
 */
export async function GET() {
  try {
    const isEnabled = process.env.DEMO_DB_ENABLED === 'true';

    if (!isEnabled) {
      logger.debug('Demo DB feature disabled', { route: 'GET /api/demo-connection' });
      return NextResponse.json({ enabled: false, connection: null });
    }

    const host = process.env.DEMO_DB_HOST;
    const database = process.env.DEMO_DB_DATABASE;
    const user = process.env.DEMO_DB_USER;
    const password = process.env.DEMO_DB_PASSWORD;
    const port = parseInt(process.env.DEMO_DB_PORT || '5432', 10);
    const name = process.env.DEMO_DB_NAME || 'Employee PostgreSQL (Demo)';

    // Validate required fields
    if (!host || !database || !user || !password) {
      logger.warn('Demo DB enabled but missing required env vars, falling back to mock demo', {
        route: 'GET /api/demo-connection',
        hasHost: !!host,
        hasDatabase: !!database,
        hasUser: !!user,
        hasPassword: !!password,
      });

      // Fallback to mock demo provider when env vars are missing
      const mockDemoConnection: DatabaseConnection = {
        id: 'demo-mock',
        name: 'Demo Database (Mock)',
        type: 'demo',
        createdAt: new Date(),
        isDemo: true,
      };

      return NextResponse.json({
        enabled: true,
        connection: mockDemoConnection,
      });
    }

    const demoConnection: DatabaseConnection = {
      id: 'demo-postgres-neon',
      name,
      type: 'postgres',
      host,
      port,
      database,
      user,
      password,
      createdAt: new Date(),
      isDemo: true,
    };

    logger.info('Serving demo connection', {
      route: 'GET /api/demo-connection',
      database,
    });

    return NextResponse.json({
      enabled: true,
      connection: demoConnection,
    });
  } catch (error) {
    return createErrorResponse(error, { route: 'GET /api/demo-connection' });
  }
}
