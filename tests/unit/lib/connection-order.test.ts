import { describe, test, expect } from "bun:test";
import { applyConnectionOrder } from "@/lib/connection-order";
import { mockPostgresConnection, mockMySQLConnection, mockSQLiteConnection } from "../../fixtures/connections";

describe("applyConnectionOrder", () => {
  test("returns connections unchanged when order is empty", () => {
    const connections = [mockPostgresConnection, mockMySQLConnection];
    expect(applyConnectionOrder(connections, [])).toBe(connections);
  });

  test("sorts connections by their position in order", () => {
    const connections = [mockPostgresConnection, mockMySQLConnection];
    const result = applyConnectionOrder(connections, [mockMySQLConnection.id, mockPostgresConnection.id]);
    expect(result.map((c) => c.id)).toEqual([mockMySQLConnection.id, mockPostgresConnection.id]);
  });

  test("does not mutate the input array", () => {
    const connections = [mockPostgresConnection, mockMySQLConnection];
    const original = [...connections];
    applyConnectionOrder(connections, [mockMySQLConnection.id, mockPostgresConnection.id]);
    expect(connections).toEqual(original);
  });

  test("a connection absent from order sorts after every connection order knows about", () => {
    const connections = [mockSQLiteConnection, mockPostgresConnection, mockMySQLConnection];
    const result = applyConnectionOrder(connections, [mockMySQLConnection.id, mockPostgresConnection.id]);
    expect(result.map((c) => c.id)).toEqual([
      mockMySQLConnection.id,
      mockPostgresConnection.id,
      mockSQLiteConnection.id,
    ]);
  });

  test("two connections both absent from order keep their original relative order", () => {
    const connections = [mockPostgresConnection, mockMySQLConnection, mockSQLiteConnection];
    const result = applyConnectionOrder(connections, [mockSQLiteConnection.id]);
    expect(result.map((c) => c.id)).toEqual([
      mockSQLiteConnection.id,
      mockPostgresConnection.id,
      mockMySQLConnection.id,
    ]);
  });
});
