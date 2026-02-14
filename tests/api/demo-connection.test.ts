import { describe, test, expect, beforeEach } from 'bun:test';
import { parseResponseJSON } from '../helpers/mock-next';

// ─── Import route handler ───────────────────────────────────────────────────
const { GET } = await import('@/app/api/demo-connection/route');

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('GET /api/demo-connection', () => {
  beforeEach(() => {
    // Reset relevant env vars
    delete process.env.DEMO_DB_ENABLED;
    delete process.env.DEMO_DB_HOST;
    delete process.env.DEMO_DB_DATABASE;
    delete process.env.DEMO_DB_USER;
    delete process.env.DEMO_DB_PASSWORD;
    delete process.env.DEMO_DB_PORT;
    delete process.env.DEMO_DB_NAME;
  });

  // Restore env after all tests (using a manual approach since afterAll may not help with module-level env)
  // The beforeEach resets state each time

  test('returns disabled when DEMO_DB_ENABLED is not true', async () => {
    process.env.DEMO_DB_ENABLED = 'false';

    const res = await GET();
    const data = await parseResponseJSON<{ enabled: boolean; connection: null }>(res);

    expect(res.status).toBe(200);
    expect(data.enabled).toBe(false);
    expect(data.connection).toBeNull();
  });

  test('returns postgres connection when all env vars are set', async () => {
    process.env.DEMO_DB_ENABLED = 'true';
    process.env.DEMO_DB_HOST = 'demo-host.example.com';
    process.env.DEMO_DB_DATABASE = 'demodb';
    process.env.DEMO_DB_USER = 'demouser';
    process.env.DEMO_DB_PASSWORD = 'demopass';
    process.env.DEMO_DB_PORT = '5433';
    process.env.DEMO_DB_NAME = 'My Demo DB';

    const res = await GET();
    const data = await parseResponseJSON<{
      enabled: boolean;
      connection: {
        id: string;
        name: string;
        type: string;
        host: string;
        port: number;
        database: string;
        user: string;
        password: string;
        isDemo: boolean;
      };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.enabled).toBe(true);
    expect(data.connection.type).toBe('postgres');
    expect(data.connection.host).toBe('demo-host.example.com');
    expect(data.connection.database).toBe('demodb');
    expect(data.connection.user).toBe('demouser');
    expect(data.connection.port).toBe(5433);
    expect(data.connection.name).toBe('My Demo DB');
    expect(data.connection.isDemo).toBe(true);
  });

  test('returns mock demo fallback when env vars are missing', async () => {
    process.env.DEMO_DB_ENABLED = 'true';
    // Host, database, user, password are all missing

    const res = await GET();
    const data = await parseResponseJSON<{
      enabled: boolean;
      connection: { id: string; name: string; type: string; isDemo: boolean };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.enabled).toBe(true);
    expect(data.connection.type).toBe('demo');
    expect(data.connection.isDemo).toBe(true);
  });

  test('connection has correct fields', async () => {
    process.env.DEMO_DB_ENABLED = 'true';
    process.env.DEMO_DB_HOST = 'localhost';
    process.env.DEMO_DB_DATABASE = 'testdb';
    process.env.DEMO_DB_USER = 'testuser';
    process.env.DEMO_DB_PASSWORD = 'testpass';

    const res = await GET();
    const data = await parseResponseJSON<{
      connection: {
        host: string; port: number; database: string; user: string;
      };
    }>(res);

    expect(data.connection.host).toBe('localhost');
    expect(data.connection.database).toBe('testdb');
    expect(data.connection.user).toBe('testuser');
    expect(data.connection.port).toBeDefined();
  });

  test('mock demo has type demo', async () => {
    process.env.DEMO_DB_ENABLED = 'true';
    // Missing required env vars triggers mock demo

    const res = await GET();
    const data = await parseResponseJSON<{
      connection: { type: string };
    }>(res);

    expect(data.connection.type).toBe('demo');
  });

  test('port defaults to 5432', async () => {
    process.env.DEMO_DB_ENABLED = 'true';
    process.env.DEMO_DB_HOST = 'localhost';
    process.env.DEMO_DB_DATABASE = 'testdb';
    process.env.DEMO_DB_USER = 'testuser';
    process.env.DEMO_DB_PASSWORD = 'testpass';
    // DEMO_DB_PORT is not set

    const res = await GET();
    const data = await parseResponseJSON<{
      connection: { port: number };
    }>(res);

    expect(data.connection.port).toBe(5432);
  });

  test('name from DEMO_DB_NAME env var', async () => {
    process.env.DEMO_DB_ENABLED = 'true';
    process.env.DEMO_DB_HOST = 'localhost';
    process.env.DEMO_DB_DATABASE = 'testdb';
    process.env.DEMO_DB_USER = 'testuser';
    process.env.DEMO_DB_PASSWORD = 'testpass';
    process.env.DEMO_DB_NAME = 'Custom Demo Name';

    const res = await GET();
    const data = await parseResponseJSON<{
      connection: { name: string };
    }>(res);

    expect(data.connection.name).toBe('Custom Demo Name');
  });

  test('isDemo flag is true for real postgres connection', async () => {
    process.env.DEMO_DB_ENABLED = 'true';
    process.env.DEMO_DB_HOST = 'localhost';
    process.env.DEMO_DB_DATABASE = 'testdb';
    process.env.DEMO_DB_USER = 'testuser';
    process.env.DEMO_DB_PASSWORD = 'testpass';

    const res = await GET();
    const data = await parseResponseJSON<{
      connection: { isDemo: boolean };
    }>(res);

    expect(data.connection.isDemo).toBe(true);
  });
});
