import "../setup-dom";

import { describe, test, expect, mock } from "bun:test";
import { renderHook } from "@testing-library/react";

import { useConnectionForm } from "@/hooks/use-connection-form";
import { DEFAULT_CONNECTION_TYPE } from "@/lib/db/connection-form";
import { unknownTypeSentence } from "@/lib/db/type-id";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The connection form handed an edit target whose type names no provider (FND-1), through the real hook and the real
 * `DB_UI_CONFIG`: unlike tests/hooks/use-connection-form.test.ts, nothing here mocks `@/lib/db-ui-config`, whose
 * `getDBConfig` is what refuses such a type, so a test here cannot pass against a mocked table.
 *
 * A host application hands the published `ConnectionModal` any record it holds, so the target may carry a type this
 * package has no provider for. The form seeds nothing from it and answers its refusal, so the dialog can say why
 * instead of throwing in render or rebinding the record to another engine.
 */

/** A fabricated credential, only ever compared against the form's state. */
const CANARY = "SEED-CANARY-7f3a";

const P1 = {
  id: "p1",
  name: "DB One",
  type: "postgres",
  host: "one.internal",
  port: 5432,
  user: "reader",
  password: CANARY,
  createdAt: new Date(0),
} as DatabaseConnection;
const P2 = {
  id: "p2",
  name: "DB Two",
  type: "postgres",
  host: "two.internal",
  createdAt: new Date(0),
} as DatabaseConnection;
const U = {
  id: "u",
  name: "Acme",
  type: "acmefoo",
  host: "acme.internal",
  port: 7000,
  createdAt: new Date(0),
} as unknown as DatabaseConnection;

function formFor(editConnection: DatabaseConnection) {
  return renderHook(
    ({ target }) => useConnectionForm({ isOpen: true, onClose: mock(), onConnect: mock(), editConnection: target }),
    { initialProps: { target: editConnection } },
  );
}

describe("useConnectionForm and an edit target whose type names no provider (FND-1)", () => {
  test("seeds nothing from an edit target whose type names no provider and answers its refusal", () => {
    const { result } = formFor(U);

    expect(result.current.editRefusal).toEqual({
      reason: "unknown",
      typeId: "acmefoo",
      sentence: unknownTypeSentence("acmefoo"),
    });
    expect(result.current.type).toBe(DEFAULT_CONNECTION_TYPE);
    expect(result.current.name).toBe("");
    expect(result.current.host).toBe("localhost");
  });

  test("applying such a target withdraws the previous target's values", () => {
    const { result, rerender } = formFor(P1);
    expect(result.current.fieldValues.password).toBe(CANARY);
    expect(result.current.editRefusal).toBeNull();

    rerender({ target: U });

    expect(result.current.name).toBe("");
    expect(result.current.host).toBe("localhost");
    expect(result.current.fieldValues.password).toBe("");
    expect(result.current.editRefusal).not.toBeNull();
  });

  test("a later target a provider can open is seeded as before", () => {
    const { result, rerender } = formFor(U);

    rerender({ target: P2 });

    expect(result.current.editRefusal).toBeNull();
    expect(result.current.type).toBe("postgres");
    expect(result.current.name).toBe("DB Two");
    expect(result.current.host).toBe("two.internal");
  });
});
