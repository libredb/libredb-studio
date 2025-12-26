import { test, expect, mock } from "bun:test";
import { PostgresProvider } from "./postgres";

// Mock the 'pg' module
mock.module('pg', () => {
  const mockPool = {
    connect: async () => {
      return {
        query: async (query: string) => {
          if (query.includes('pg_stat_activity')) {
            return {
              rows: [
                {
                  datname: 'testdb',
                  pid: 123,
                  usename: 'testuser',
                  application_name: 'testapp',
                  client_addr: '127.0.0.1',
                  backend_start: new Date().toISOString(),
                  state: 'active',
                  query: 'SELECT * FROM test_table',
                },
              ],
            };
          }
          return { rows: [] };
        },
        release: () => {},
      };
    },
  };
  return {
    Pool: function () {
      return mockPool;
    },
  };
});

test("PostgresProvider.getPgStatActivity should return data from pg_stat_activity", async () => {
  const provider = new PostgresProvider({
    id: 'test-connection',
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    user: 'test',
    password: 'test',
    database: 'test',
  });

  await provider.connect();
  const activity = await provider.getPgStatActivity();

  expect(activity).toBeArray();
  expect(activity.length).toBe(1);
  expect(activity[0].datname).toBe('testdb');
  expect(activity[0].pid).toBe(123);
  expect(activity[0].usename).toBe('testuser');
  expect(activity[0].application_name).toBe('testapp');
  expect(activity[0].client_addr).toBe('127.0.0.1');
  expect(activity[0].state).toBe('active');
  expect(activity[0].query).toBe('SELECT * FROM test_table');
});