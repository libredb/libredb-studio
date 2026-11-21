import { describe, expect, test } from "bun:test";
import {
  defaultConnection,
  unavailableConnectionNotice,
  unavailableSavedQueryNotice,
} from "@/lib/connection-availability";
import type { DatabaseConnection } from "@/lib/types";

const SENTENCE = 'No provider for the connection type "acmefoo" is installed in this LibreDB Studio.';

const postgres: DatabaseConnection = {
  id: "pg",
  name: "Orders",
  type: "postgres",
  host: "localhost",
  port: 5432,
  createdAt: new Date("2026-11-21T10:00:00.000Z"),
};
const mysql: DatabaseConnection = { ...postgres, id: "my", name: "Billing", type: "mysql" };
const unknown = { ...postgres, id: "u", name: "Acme", type: "acmefoo" } as unknown as DatabaseConnection;
const absent = { ...postgres, id: "n", name: "Untyped", type: undefined } as unknown as DatabaseConnection;
const malformed = {
  ...postgres,
  id: "m",
  name: "Malformed",
  type: { id: "postgres" },
} as unknown as DatabaseConnection;

describe("defaultConnection (FND-1)", () => {
  test("answers the saved connection while it is listed and a provider can open it", () => {
    expect(defaultConnection([postgres, mysql], "my")).toBe(mysql);
  });

  test.each([
    ["names no provider", unknown],
    ["names no type", absent],
    ["has a type that is not text", malformed],
  ])("answers the first available connection when the saved one %s", (_label, saved) => {
    expect(defaultConnection([saved, mysql, postgres], saved.id)).toBe(mysql);
  });

  test("answers the first available connection when the saved one is not listed, or there is no saved id", () => {
    expect(defaultConnection([unknown, postgres, mysql], "gone")).toBe(postgres);
    expect(defaultConnection([unknown, postgres, mysql], null)).toBe(postgres);
  });

  test("answers null for an empty list and for a list with no available connection", () => {
    expect(defaultConnection([], null)).toBeNull();
    expect(defaultConnection([], "pg")).toBeNull();
    expect(defaultConnection([unknown, absent, malformed], "u")).toBeNull();
  });
});

describe("unavailableConnectionNotice (FND-1)", () => {
  test("names the connection and gives the reason", () => {
    expect(unavailableConnectionNotice(unknown, SENTENCE)).toEqual({
      title: "Connection unavailable",
      description: `Acme: ${SENTENCE}`,
    });
  });

  test.each([
    ["missing", {}],
    ["empty", { name: "" }],
    ["not text", { name: 5 }],
  ])('calls a connection whose name is %s "This connection"', (_label, connection) => {
    expect(unavailableConnectionNotice(connection, SENTENCE)).toEqual({
      title: "Connection unavailable",
      description: `This connection: ${SENTENCE}`,
    });
  });
});

describe("unavailableSavedQueryNotice (FND-1)", () => {
  test("names the saved query and gives the reason", () => {
    expect(unavailableSavedQueryNotice({ name: "Acme report" }, SENTENCE)).toEqual({
      title: "Saved query unavailable",
      description: `Acme report: ${SENTENCE}`,
    });
  });

  test.each([
    ["missing", {}],
    ["empty", { name: "" }],
    ["not text", { name: ["Acme"] }],
  ])('calls a saved query whose name is %s "This saved query"', (_label, query) => {
    expect(unavailableSavedQueryNotice(query, SENTENCE)).toEqual({
      title: "Saved query unavailable",
      description: `This saved query: ${SENTENCE}`,
    });
  });
});
