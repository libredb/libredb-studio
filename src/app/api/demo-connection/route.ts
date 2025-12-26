import { NextResponse } from 'next/server';
import { DatabaseConnection } from '@/lib/types';

const LOG_PREFIX = '[DemoDB]';

/**
 * GET /api/demo-connection
 * Returns demo database connection if DEMO_DB_ENABLED is true
 * This allows users to instantly try the app with a pre-configured database
 */
export async function GET() {
  const isEnabled = process.env.DEMO_DB_ENABLED === 'true';

  if (!isEnabled) {
    console.log(`${LOG_PREFIX} Feature disabled (DEMO_DB_ENABLED !== 'true')`);
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
    console.warn(`${LOG_PREFIX} Enabled but missing required env vars, falling back to mock demo:`, {
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

  console.log(`${LOG_PREFIX} Serving demo connection:`, {
    name,
    host: host.substring(0, 20) + '...', // Truncate for security
    database,
    user,
    port,
  });

  return NextResponse.json({
    enabled: true,
    connection: demoConnection,
  });
}
