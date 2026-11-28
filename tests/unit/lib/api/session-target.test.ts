/**
 * The session targets of the caller facades (src/lib/api/session-target.ts): what a facade of the provider host core
 * runs its calls on, a session, the environment each call is given, its statement timeout and the run marks of its
 * cache entry. A legacy provider's target is one bridged session of it, with no environment, its provider's statement
 * timeout and marks that count nothing; `markedCall` brackets one call with a target's marks.
 */
import { describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CallRefusalError } from "@libredb/provider-sdk/calls";
import {
  markedCall,
  providerMaintenanceTarget,
  providerMonitoringTarget,
  providerTreeTarget,
  type SessionTarget,
} from "@/lib/api/session-target";
import type { DatabaseProvider, MaintenanceDeclaration } from "@/lib/db/types";
import { bridgedConsole, bridgedMaintenance } from "@/lib/provider-host/legacy-bridge";
import type { DatabaseConnection } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";

/** A declaration with vacuum on a row and whole, and analyze on a row. */
const DECLARED: Required<MaintenanceDeclaration> = {
  maintenanceOperations: ["vacuum", "analyze"],
  maintenanceOperationSpecs: {
    vacuum: { label: "Vacuum", perEntity: true, global: true },
    analyze: { label: "Analyze", perEntity: true, global: false },
  },
};

/** A mock PostgreSQL provider whose statement timeout is `queryTimeout`, connected as `DECLARED`. */
function providerOf(queryTimeout?: number): DatabaseProvider {
  return createMockProvider({
    config: { id: "c1", name: "Prod", type: "postgres", host: "db.internal", queryTimeout } as DatabaseConnection,
    capabilities: { supportsMaintenance: true, ...DECLARED },
  });
}

/** The mock behind a provider's member, for its recorded calls and its implementation. */
const mockOf = (fn: unknown) => fn as ReturnType<typeof mock>;

/** Marks that record each mark in `marks`. */
function recordedMarks(marks: string[]): Pick<SessionTarget<unknown>, "started" | "ended"> {
  return {
    started: () => {
      marks.push("started");
    },
    ended: (record) => {
      marks.push(`ended ${record?.kind}`);
    },
  };
}

describe("the session targets of a legacy provider", () => {
  test("a provider's monitoring target is one bridged session with no environment and no marks under the provider's statement timeout, and its maintenance target reads the provider's narrowed maintenance when a call reads it, never when it is built", async () => {
    const provider = providerOf(4_000);
    const monitoring = providerMonitoringTarget(provider);
    expect(monitoring.session.calls.monitoring.panel).toBe("offered");
    expect(monitoring.session.panels).toBe(bridgedConsole(provider, {}).session.panels);
    expect(typeof monitoring.session.health).toBe("function");
    // No environment: the reader a legacy provider's tree target holds, which declares no variable.
    expect(monitoring.env).toBe(providerTreeTarget(provider).env);
    expect(() => monitoring.env.get(randomUUID())).toThrow();
    // The statement timeout is read when asked, so a later change of the connection's timeout is the one read.
    expect(monitoring.timeout()).toBe(4_000);
    provider.config.queryTimeout = 7_000;
    expect(monitoring.timeout()).toBe(7_000);
    expect(monitoring.started()).toBeUndefined();
    expect(monitoring.ended({ kind: "answered" })).toBeUndefined();

    // The maintenance target's session is the bridged one without its maintenance, which no builder reads.
    const capabilities = mockOf(provider.getCapabilities);
    capabilities.mockClear();
    const maintenance = providerMaintenanceTarget(provider, DECLARED);
    const builtReads = capabilities.mock.calls.length;
    expect(Object.hasOwn(maintenance.session, "maintenance")).toBe(false);
    expect(maintenance.session.calls.maintenance.run).toBe("offered");
    expect(maintenance.env).toBe(monitoring.env);
    expect(maintenance.timeout()).toBe(7_000);
    expect(maintenance.started()).toBeUndefined();
    expect(maintenance.ended(undefined)).toBeUndefined();
    // Read on each call: the declaration narrowed by what the connected provider accepts at that call.
    const first = maintenance.maintenance();
    expect(capabilities.mock.calls.length).toBe(builtReads + 1);
    expect(first).toEqual(bridgedMaintenance(provider, DECLARED));
    capabilities.mockImplementation(() => ({ supportsMaintenance: true, maintenanceOperations: ["vacuum"] }));
    const second = maintenance.maintenance();
    expect(second).not.toBe(first);
    expect(second).toEqual(bridgedMaintenance(provider, DECLARED));
    expect(second).not.toEqual(first);

    // A declaration the SDK refuses to narrow is refused by `maintenance()`, never by the builder.
    const refused = { ...DECLARED, maintenanceOperations: ["vacuum", "analyze", "shrink"] };
    const unreadable = {
      ...refused,
      maintenanceOperationSpecs: { ...DECLARED.maintenanceOperationSpecs, shrink: { label: "Shrink" } },
    } as unknown as MaintenanceDeclaration;
    const built = providerMaintenanceTarget(provider, unreadable);
    expect(() => built.maintenance()).toThrow(CallRefusalError);
  });

  test("markedCall marks a call started before it runs and ended as its record once it answered, and ended undefined for a call that threw, passing the error as the same object", async () => {
    const marks: string[] = [];
    const target = recordedMarks(marks);
    const answer = { kind: "answered" as const, answer: randomUUID() };
    const record = await markedCall(target, async () => {
      marks.push("called");
      return answer;
    });
    expect(record).toBe(answer);
    expect(marks).toEqual(["started", "called", "ended answered"]);

    marks.length = 0;
    const thrown = new Error(randomUUID());
    let caught: unknown;
    try {
      await markedCall(target, () => Promise.reject(thrown));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(thrown);
    expect(marks).toEqual(["started", "ended undefined"]);
  });
});
