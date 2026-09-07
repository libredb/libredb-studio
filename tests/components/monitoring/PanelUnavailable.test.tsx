import "../../setup-dom";

import React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { PanelUnavailable } from "@/components/monitoring/PanelUnavailable";

afterEach(cleanup);

describe("PanelUnavailable", () => {
  // Two absences reach this component and they are not the same fact. An engine that
  // never had the object cannot answer and never will; an engine that has it and
  // refused this particular statement might answer a different one. Reading the first
  // as a fault made Materialize's dashboard look broken while it was working.
  test("an object the engine never had reads as a limit, not a fault", () => {
    render(<PanelUnavailable message={'function "pg_table_size" does not exist'} />);

    expect(screen.getByTestId("panel-unavailable-message").textContent).toContain("pg_table_size");
    expect(screen.getByTestId("panel-unavailable").textContent).toContain("does not publish");
    expect(screen.getByTestId("panel-unavailable").textContent).not.toContain("could not answer");
  });

  // The same distinction, in each engine's own words. PanelUnavailable is shared by all
  // six monitoring tabs, so a rule that only recognises PostgreSQL's phrasing renders
  // every other engine's genuine absence as a fault. Every message below was taken from
  // a real engine, several of them recorded in compatibility.ts.
  test.each([
    ["Materialize", 'function "pg_table_size" does not exist'],
    ["CockroachDB", "unknown function: pg_size_pretty()"],
    ["StarRocks", "Unknown table 'information_schema.PROCESSLIST'"],
    ["ClickHouse", "Unknown table expression identifier 'system.parts'"],
    ["Cassandra", "unconfigured table system_views.clients"],
  ])("%s: an object that is not there reads as a limit", (_engine, message) => {
    render(<PanelUnavailable message={message} />);

    expect(screen.getByTestId("panel-unavailable").textContent).toContain("does not publish");
  });

  test("a refused statement still reads as a fault", () => {
    // Cloudberry: pg_stat_user_tables is there and readable, its MPP planner refused
    // this query's shape. Another statement could succeed, so this is not a limit.
    render(<PanelUnavailable message="query plan with multiple segworker groups is not supported" />);

    expect(screen.getByTestId("panel-unavailable").textContent).toContain("could not answer");
    expect(screen.getByTestId("panel-unavailable").textContent).not.toContain("does not publish");
  });

  test("the engine's own sentence is shown either way", () => {
    render(<PanelUnavailable message="Unknown table 'information_schema.PROCESSLIST'" />);

    expect(screen.getByTestId("panel-unavailable-message").textContent).toBe(
      "Unknown table 'information_schema.PROCESSLIST'",
    );
  });
});
