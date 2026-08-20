import "../setup-dom";

import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, cleanup, screen } from "@testing-library/react";
import type { WireCompatibleEngine } from "@/lib/db/compatibility";

/**
 * The hint answers one user question - "I have MariaDB, which of these fourteen
 * buttons do I press?" - so the tests assert what a user can read, not markup.
 *
 * The registry is mocked rather than read, because the real one is data that
 * changes every time a probe lands (#424 Phase 0). A component test that asserts
 * on today's registry contents would fail on the next probe and teach the next
 * maintainer to delete it.
 *
 * "ExampleStore" is deliberately not a real product. An earlier version used TiDB,
 * which reads as a probe result to anyone skimming - and TiDB is a name #424 lists
 * as explicitly NOT measured, so the fixture contradicted the record it sits beside.
 */
const MOCK: WireCompatibleEngine[] = [
  { name: "MariaDB", via: "mysql", tier: "full", probedVersion: "12.3.2-MariaDB-ubu2404", caveats: [] },
  {
    name: "ExampleStore",
    via: "mysql",
    tier: "query-only",
    probedVersion: "8.5.0",
    caveats: ["No slow-query view; SLOWLOG is empty."],
  },
];

mock.module("@/lib/db/compatibility", () => ({
  SHIPPED_DATABASE_TYPES: ["postgres", "mysql"],
  WIRE_COMPATIBLE_ENGINES: MOCK,
  compatibleEnginesFor: (type: string) => MOCK.filter((e) => e.via === type),
  verifiedEngineCount: () => 13,
}));

const { WireCompatibilityHint } = await import("@/components/WireCompatibilityHint");

afterEach(() => {
  cleanup();
});

describe("WireCompatibilityHint", () => {
  test("names the engines that the selected driver also serves", () => {
    render(<WireCompatibilityHint type="mysql" />);
    // Exact matches: a regex would also hit the version string, which embeds the
    // product name ("12.3.2-MariaDB-ubu2404").
    expect(screen.getByText("MariaDB")).toBeTruthy();
    expect(screen.getByText("ExampleStore")).toBeTruthy();
  });

  test("shows the probed version, so the claim is dated rather than open-ended", () => {
    render(<WireCompatibilityHint type="mysql" />);
    expect(screen.getByText(/12\.3\.2-MariaDB-ubu2404/)).toBeTruthy();
  });

  test("announces that some engines carry caveats instead of listing them inline", () => {
    render(<WireCompatibilityHint type="mysql" />);
    // The dialog must not imply untested parity, but sixteen caveat lines would
    // drown the form: the detail belongs in the docs compatibility table.
    expect(screen.getByTestId("wire-compat-caveat-notice")).toBeTruthy();
    expect(screen.queryByText(/SLOWLOG is empty/)).toBeNull();
  });

  test("marks an engine where only the editor works, so the name alone cannot mislead", () => {
    render(<WireCompatibilityHint type="mysql" />);
    expect(screen.getByTestId("wire-compat-tier-ExampleStore").textContent).toContain("query editor only");
    // A full-parity engine carries no qualifier: the marker must mean something.
    expect(screen.queryByTestId("wire-compat-tier-MariaDB")).toBeNull();
  });

  test("marks a partially supported engine with its own wording", () => {
    const partial: WireCompatibleEngine = {
      name: "CockroachDB",
      via: "postgres",
      tier: "partial",
      probedVersion: "v26.2.5",
      caveats: ["The object browser is empty."],
    };
    render(<WireCompatibilityHint type="postgres" engines={[partial]} />);
    expect(screen.getByTestId("wire-compat-tier-CockroachDB").textContent).toContain("partial support");
  });

  test("stays silent when nothing was verified for that driver", () => {
    const { container } = render(<WireCompatibilityHint type="postgres" />);
    expect(container.textContent).toBe("");
  });

  test("omits the caveat notice when every verified engine is clean", () => {
    render(<WireCompatibilityHint type="mysql" engines={[MOCK[0]!]} />);
    expect(screen.queryByTestId("wire-compat-caveat-notice")).toBeNull();
    expect(screen.getByText("MariaDB")).toBeTruthy();
  });
});
