/**
 * Every key of `QueryResult` reaches the embedded shell, or is listed here with the reason it does not
 * (vector-family spec 3.10, R51 U13).
 *
 * `StudioWorkspace` builds its tab result from the host's `WorkspaceQueryResult`, so a channel `QueryResult` gains
 * and `WorkspaceQueryResult` lacks is a channel the standalone app shows and a host cannot send: the gap #285
 * closed for warnings and declared types. Both key lists below are `Record`s over the interfaces' own keys, so a
 * key added to either interface does not compile until it is listed here, and the tests then hold the relation.
 */
import { describe, expect, test } from "bun:test";
import type { QueryResult } from "@/lib/types";
import type { WorkspaceQueryResult } from "@/workspace/types";

const QUERY_RESULT_KEYS: Readonly<Record<keyof QueryResult, true>> = {
  rows: true,
  fields: true,
  rowCount: true,
  executionTime: true,
  explainPlan: true,
  pagination: true,
  warnings: true,
  columnTypes: true,
  vectorColumns: true,
};

const WORKSPACE_RESULT_KEYS: Readonly<Record<keyof WorkspaceQueryResult, true>> = {
  rows: true,
  fields: true,
  columns: true,
  rowCount: true,
  executionTime: true,
  warnings: true,
  pagination: true,
  vectorColumns: true,
};

/** The keys of `QueryResult` a host does not send under the same name, each with the reason. */
const NOT_CARRIED: Readonly<Partial<Record<keyof QueryResult, string>>> = {
  explainPlan: "a plan reaches a tab through its own channel, QueryTab.explainPlan, and never through the result",
  columnTypes:
    "carried under another name: a host declares WorkspaceQueryResult.columns[].type and the adapter builds columnTypes from it",
};

describe("QueryResult and WorkspaceQueryResult", () => {
  test("every key of QueryResult is a key of WorkspaceQueryResult or is listed as not carried", () => {
    const missing = Object.keys(QUERY_RESULT_KEYS).filter(
      (key) => !Object.hasOwn(WORKSPACE_RESULT_KEYS, key) && !Object.hasOwn(NOT_CARRIED, key),
    );
    expect(missing).toEqual([]);
  });

  test("a key listed as not carried is really not carried, so the list cannot outlive the gap it explains", () => {
    const carriedAnyway = Object.keys(NOT_CARRIED).filter((key) => Object.hasOwn(WORKSPACE_RESULT_KEYS, key));
    expect(carriedAnyway).toEqual([]);
  });

  test("vectorColumns is carried under its own name", () => {
    // The constants are `Record`s over each interface's keys, so `bun run typecheck` is what fails if either
    // interface loses `vectorColumns`; at run time this pins only that the listing carries it rather than excusing it.
    expect(Object.hasOwn(NOT_CARRIED, "vectorColumns")).toBe(false);
    expect(Object.hasOwn(QUERY_RESULT_KEYS, "vectorColumns")).toBe(true);
    expect(Object.hasOwn(WORKSPACE_RESULT_KEYS, "vectorColumns")).toBe(true);
  });
});
