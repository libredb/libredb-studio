/**
 * The host refuses, before the call, a request field the session does not honour (docs/providers/CONTRACT.md, clause
 * C-9).
 *
 * Each case holds a request to the session's calls, the manifest's `calls` or the narrowed ones a refinement leaves,
 * and asserts the exact refusal list: a pointer into the request, the field's name, and never a value of the request.
 * A statement sent inside a transaction goes only to a session that offers `console.transaction`, and never with a
 * scope. A console facet call goes only to a session that offers the facet, and an object facet call only to one that
 * offers the object facet, a maintenance facet call only to one that offers the maintenance facet, and a monitoring
 * facet call only to one that offers the monitoring facet (clause C-17).
 * A maintenance run or preview request is held to the session's maintenance: an operation it lists, a placement its
 * spec offers, a preview its spec declares on a row, and no empty text where the request names something. A monitoring
 * panel request is held to the panels the session's engine offers (clause C-71).
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CALL_REFUSAL_RULES,
  type CallRefusal,
  CallRefusalError,
  callRefusalSentence,
  checkConsoleFacet,
  checkExecuteRequest,
  checkMaintenanceFacet,
  checkMaintenancePreviewRequest,
  checkMaintenanceRunRequest,
  checkMonitoringFacet,
  checkMonitoringPanelRequest,
  checkObjectsFacet,
  type EngineMaintenance,
  type ExecuteRequest,
  type MaintenancePreviewRequest,
  type MaintenanceRunRequest,
  type MonitoringPanelRequest,
  sessionCalls,
  sessionMaintenance,
} from "@libredb/provider-sdk/calls";
import type { Calls, MaintenanceOperation, MaintenanceSpec, MonitoringPanels } from "@libredb/provider-sdk/manifest";

/** The calls of a package that honours nothing and offers no facet. */
const NOTHING: Calls = {
  console: { execute: { honours: [] }, cancel: "not-offered", endScope: "not-offered", transaction: "not-offered" },
  objects: { tree: "not-offered" },
  maintenance: { run: "not-offered", preview: "not-offered" },
  monitoring: { panel: "not-offered", poolStats: "not-offered" },
};

/** The calls of a package that honours every field and offers every facet. */
const EVERYTHING: Calls = {
  console: {
    execute: { honours: ["params", "offset"] },
    cancel: "offered",
    endScope: "offered",
    transaction: "offered",
  },
  objects: { tree: "offered" },
  maintenance: { run: "offered", preview: "offered" },
  monitoring: { panel: "offered", poolStats: "offered" },
};

const statement = `select ${randomUUID()}`;
const firstPage: ExecuteRequest = { statement, page: { limit: 500, offset: 0 } };
const withParams: ExecuteRequest = { ...firstPage, params: [1] };
const withEmptyParams: ExecuteRequest = { ...firstPage, params: [] };
const laterPage: ExecuteRequest = { statement, page: { limit: 500, offset: 500 } };
const scoped: ExecuteRequest = { ...firstPage, scope: "s" };
const unlimited: ExecuteRequest = { statement, page: { unlimited: true } };
const allThree: ExecuteRequest = { statement, params: [1], page: { limit: 500, offset: 500 }, scope: "s" };

const PARAMS: CallRefusal = { rule: "request-field-not-honoured", pointer: "/params", name: "params" };
const OFFSET: CallRefusal = { rule: "request-field-not-honoured", pointer: "/page/offset", name: "offset" };
const SCOPE: CallRefusal = { rule: "request-scope-not-offered", pointer: "/scope" };
const TRANSACTION: CallRefusal = { rule: "request-transaction-not-offered", pointer: "/transaction" };
const SCOPE_IN_TRANSACTION: CallRefusal = { rule: "request-scope-in-transaction", pointer: "/scope" };
const inTransaction: ExecuteRequest = { ...firstPage, transaction: true };

describe("checkExecuteRequest", () => {
  test("a request field the session does not honour is refused before the call", () => {
    expect(checkExecuteRequest(NOTHING, firstPage)).toEqual([]);
    expect(checkExecuteRequest(NOTHING, withParams)).toEqual([PARAMS]);
    expect(checkExecuteRequest(NOTHING, withEmptyParams)).toEqual([PARAMS]);
    expect(checkExecuteRequest(NOTHING, laterPage)).toEqual([OFFSET]);
    expect(checkExecuteRequest(NOTHING, scoped)).toEqual([SCOPE]);
    expect(checkExecuteRequest(NOTHING, allThree)).toEqual([PARAMS, OFFSET, SCOPE]);
    expect(checkExecuteRequest(NOTHING, unlimited)).toEqual([]);
  });

  test("a session that honours every field and offers endScope takes each", () => {
    for (const request of [firstPage, withParams, withEmptyParams, laterPage, scoped, unlimited, allThree]) {
      expect(checkExecuteRequest(EVERYTHING, request)).toEqual([]);
    }
  });

  test("a request on a refined session is held to the narrowed calls", () => {
    const narrowed = sessionCalls(EVERYTHING, {
      calls: { console: { execute: { honours: ["params"] }, endScope: "not-offered" } },
    });

    expect(checkExecuteRequest(narrowed, withParams)).toEqual([]);
    expect(checkExecuteRequest(narrowed, laterPage)).toEqual([OFFSET]);
    expect(checkExecuteRequest(narrowed, scoped)).toEqual([SCOPE]);
    expect(checkExecuteRequest(sessionCalls(EVERYTHING, undefined), allThree)).toEqual([]);
  });

  test("a statement sent inside a transaction to a session without console.transaction is refused before the call", () => {
    const withdrawn = sessionCalls(EVERYTHING, { calls: { console: { transaction: "not-offered" } } });

    expect(checkExecuteRequest(NOTHING, inTransaction)).toEqual([TRANSACTION]);
    expect(checkExecuteRequest(withdrawn, inTransaction)).toEqual([TRANSACTION]);
    expect(checkExecuteRequest(NOTHING, { ...withParams, transaction: true })).toEqual([PARAMS, TRANSACTION]);
    expect(callRefusalSentence(TRANSACTION)).toBe(
      'The request is sent inside a transaction at "/transaction", and the session does not offer console.transaction, so the call was not made.',
    );
  });

  test("a statement sent inside a transaction never carries a scope", () => {
    const scopedInTransaction: ExecuteRequest = { ...inTransaction, scope: "s" };

    expect(checkExecuteRequest(EVERYTHING, scopedInTransaction)).toEqual([SCOPE_IN_TRANSACTION]);
    expect(checkExecuteRequest(NOTHING, scopedInTransaction)).toEqual([SCOPE, SCOPE_IN_TRANSACTION, TRANSACTION]);
    expect(callRefusalSentence(SCOPE_IN_TRANSACTION)).toBe(
      'The request carries a scope at "/scope" on a statement sent inside a transaction, which runs on the transaction\'s own session, so the call was not made.',
    );
  });

  test("a session that offers console.transaction takes a statement inside its transaction with its params and offset", () => {
    const narrowed = sessionCalls(EVERYTHING, {
      calls: { console: { endScope: "not-offered", cancel: "not-offered" } },
    });

    for (const calls of [EVERYTHING, narrowed]) {
      expect(checkExecuteRequest(calls, inTransaction)).toEqual([]);
      expect(checkExecuteRequest(calls, { ...withParams, transaction: true })).toEqual([]);
      expect(checkExecuteRequest(calls, { ...laterPage, params: [1], transaction: true })).toEqual([]);
    }
  });
});

describe("checkConsoleFacet", () => {
  test("a console facet the session does not offer is refused before the call", () => {
    const declaredOnly = sessionCalls(NOTHING, undefined);
    const narrowed = sessionCalls(EVERYTHING, { calls: { console: { endScope: "not-offered" } } });
    const cancel: CallRefusal = { rule: "facet-not-offered", pointer: "/console/cancel", name: "console.cancel" };
    const endScope: CallRefusal = { rule: "facet-not-offered", pointer: "/console/endScope", name: "console.endScope" };

    expect(checkConsoleFacet(declaredOnly, "cancel")).toEqual([cancel]);
    expect(checkConsoleFacet(declaredOnly, "endScope")).toEqual([endScope]);
    expect(checkConsoleFacet(narrowed, "endScope")).toEqual([endScope]);
    expect(callRefusalSentence(cancel)).toBe(
      'The session does not offer the facet "console.cancel" at "/console/cancel", so the call was not made.',
    );
  });

  test("the transaction facet is refused by name to a session that does not offer it", () => {
    const withdrawn = sessionCalls(EVERYTHING, { calls: { console: { transaction: "not-offered" } } });
    const transaction: CallRefusal = {
      rule: "facet-not-offered",
      pointer: "/console/transaction",
      name: "console.transaction",
    };

    expect(checkConsoleFacet(NOTHING, "transaction")).toEqual([transaction]);
    expect(checkConsoleFacet(withdrawn, "transaction")).toEqual([transaction]);
    expect(checkConsoleFacet(EVERYTHING, "transaction")).toEqual([]);
    expect(callRefusalSentence(transaction)).toBe(
      'The session does not offer the facet "console.transaction" at "/console/transaction", so the call was not made.',
    );
  });

  test("a console facet the session offers is called", () => {
    const narrowed = sessionCalls(EVERYTHING, { calls: { console: { endScope: "not-offered" } } });

    expect(checkConsoleFacet(EVERYTHING, "cancel")).toEqual([]);
    expect(checkConsoleFacet(EVERYTHING, "endScope")).toEqual([]);
    expect(checkConsoleFacet(narrowed, "cancel")).toEqual([]);
  });
});

describe("checkObjectsFacet", () => {
  test("the objects tree facet is refused by name to a session that does not offer it", () => {
    const withdrawn = sessionCalls(EVERYTHING, { calls: { objects: { tree: "not-offered" } } });
    const tree: CallRefusal = { rule: "facet-not-offered", pointer: "/objects/tree", name: "objects.tree" };

    expect(checkObjectsFacet(NOTHING, "tree")).toEqual([tree]);
    expect(checkObjectsFacet(sessionCalls(NOTHING, undefined), "tree")).toEqual([tree]);
    expect(checkObjectsFacet(withdrawn, "tree")).toEqual([tree]);
    expect(callRefusalSentence(tree)).toBe(
      'The session does not offer the facet "objects.tree" at "/objects/tree", so the call was not made.',
    );
  });

  test("a session that offers objects.tree is called", () => {
    const consoleNarrowed = sessionCalls(EVERYTHING, { calls: { console: { cancel: "not-offered" } } });

    expect(checkObjectsFacet(EVERYTHING, "tree")).toEqual([]);
    expect(checkObjectsFacet(sessionCalls(EVERYTHING, undefined), "tree")).toEqual([]);
    expect(checkObjectsFacet(consoleNarrowed, "tree")).toEqual([]);
  });
});

describe("checkMaintenanceFacet", () => {
  test("the maintenance facets are refused by name to a session that does not offer them", () => {
    for (const facet of ["run", "preview"] as const) {
      const withdrawn = sessionCalls(EVERYTHING, { calls: { maintenance: { [facet]: "not-offered" } } });
      const refused: CallRefusal = {
        rule: "facet-not-offered",
        pointer: `/maintenance/${facet}`,
        name: `maintenance.${facet}`,
      };

      expect(checkMaintenanceFacet(NOTHING, facet)).toEqual([refused]);
      expect(checkMaintenanceFacet(sessionCalls(NOTHING, undefined), facet)).toEqual([refused]);
      expect(checkMaintenanceFacet(withdrawn, facet)).toEqual([refused]);
      expect(callRefusalSentence(refused)).toBe(
        `The session does not offer the facet "maintenance.${facet}" at "/maintenance/${facet}", so the call was not made.`,
      );
    }
  });

  test("a session that offers maintenance.run and maintenance.preview is called", () => {
    const previewWithdrawn = sessionCalls(EVERYTHING, { calls: { maintenance: { preview: "not-offered" } } });

    for (const facet of ["run", "preview"] as const) {
      expect(checkMaintenanceFacet(EVERYTHING, facet)).toEqual([]);
      expect(checkMaintenanceFacet(sessionCalls(EVERYTHING, undefined), facet)).toEqual([]);
    }
    expect(checkMaintenanceFacet(previewWithdrawn, "run")).toEqual([]);
  });
});

describe("checkMonitoringFacet", () => {
  test("the monitoring facets are refused by name to a session that does not offer them", () => {
    for (const facet of ["panel", "poolStats"] as const) {
      const withdrawn = sessionCalls(EVERYTHING, { calls: { monitoring: { [facet]: "not-offered" } } });
      const refused: CallRefusal = {
        rule: "facet-not-offered",
        pointer: `/monitoring/${facet}`,
        name: `monitoring.${facet}`,
      };

      expect(checkMonitoringFacet(NOTHING, facet)).toEqual([refused]);
      expect(checkMonitoringFacet(sessionCalls(NOTHING, undefined), facet)).toEqual([refused]);
      expect(checkMonitoringFacet(withdrawn, facet)).toEqual([refused]);
      expect(callRefusalSentence(refused)).toBe(
        `The session does not offer the facet "monitoring.${facet}" at "/monitoring/${facet}", so the call was not made.`,
      );
    }
  });

  test("a session that offers monitoring.panel and monitoring.poolStats is called", () => {
    const poolStatsWithdrawn = sessionCalls(EVERYTHING, { calls: { monitoring: { poolStats: "not-offered" } } });

    for (const facet of ["panel", "poolStats"] as const) {
      expect(checkMonitoringFacet(EVERYTHING, facet)).toEqual([]);
      expect(checkMonitoringFacet(sessionCalls(EVERYTHING, undefined), facet)).toEqual([]);
    }
    expect(checkMonitoringFacet(poolStatsWithdrawn, "panel")).toEqual([]);
  });
});

/** An engine that offers the overview, the slow queries and the table statistics, and no other panel. */
const SOME_PANELS: MonitoringPanels = {
  overview: "offered",
  performance: "not-offered",
  slowQueries: "offered",
  activeSessions: "not-offered",
  tables: "offered",
  indexes: "not-offered",
  storage: "not-offered",
};

const PANEL_NOT_OFFERED: CallRefusal = { rule: "request-panel-not-offered", pointer: "/panel" };

describe("checkMonitoringPanelRequest", () => {
  test("a monitoring panel request is held to the panels the session's engine offers", () => {
    const offered: MonitoringPanelRequest[] = [
      { panel: "overview" },
      { panel: "slowQueries", limit: 10 },
      { panel: "tables" },
      { panel: "tables", schema: "public" },
    ];
    const notOffered: MonitoringPanelRequest[] = [
      { panel: "performance" },
      { panel: "activeSessions", limit: 50 },
      { panel: "indexes", schema: "public" },
      { panel: "storage" },
    ];
    // Requests no host builds: no panel, a key every object inherits, and no text.
    const malformed = [{}, { panel: "__proto__" }, { panel: "constructor" }, { panel: "toString" }, { panel: 1 }].map(
      (request) => request as unknown as MonitoringPanelRequest,
    );

    for (const request of offered) expect(checkMonitoringPanelRequest(SOME_PANELS, request)).toEqual([]);
    for (const request of [...notOffered, ...malformed]) {
      expect(checkMonitoringPanelRequest(SOME_PANELS, request)).toEqual([PANEL_NOT_OFFERED]);
    }
    expect(callRefusalSentence(PANEL_NOT_OFFERED)).toBe(
      'The request names at "/panel" a monitoring panel the session\'s engine does not offer, so the call was not made.',
    );
  });

  test("no monitoring request refusal carries a value of the request", () => {
    const schema = randomUUID();
    const unknownPanel = randomUUID();
    const refusals = [
      ...checkMonitoringPanelRequest(SOME_PANELS, { panel: "indexes", schema }),
      ...checkMonitoringPanelRequest(SOME_PANELS, { panel: unknownPanel } as unknown as MonitoringPanelRequest),
    ];
    const text = JSON.stringify(refusals) + new CallRefusalError(refusals).message;

    expect(refusals).toEqual([PANEL_NOT_OFFERED, PANEL_NOT_OFFERED]);
    expect(text).not.toContain(schema);
    expect(text).not.toContain(unknownPanel);
  });
});

/** One maintenance spec, placed as given, with every other member as the declaration writes an unstated one. */
function specOf(
  operation: MaintenanceOperation,
  perEntity: boolean,
  global: boolean,
  preview = false,
): MaintenanceSpec {
  return {
    operation,
    label: operation,
    perEntity,
    global,
    title: null,
    description: null,
    confirmation: null,
    preview,
    kinds: null,
  };
}

/** A PostgreSQL-shaped maintenance: vacuum, analyze and reindex on a row and over the whole database, kill on neither. */
const POSTGRES_LIKE: EngineMaintenance = {
  maintenance: ["vacuum", "analyze", "reindex", "kill"],
  maintenanceSpecs: [
    specOf("vacuum", true, true),
    specOf("analyze", true, true),
    specOf("reindex", true, true),
    specOf("kill", false, false),
  ],
};

/** The same maintenance narrowed as a server that runs vacuum only over the whole database and no reindex narrows it. */
const NARROWED = sessionMaintenance(POSTGRES_LIKE, {
  maintenance: [
    { operation: "vacuum", perEntity: false, global: true },
    { operation: "reindex", perEntity: false, global: false },
  ],
});

/** A maintenance with a row-only preview, a row-only operation that previews nothing, and one listed with no spec. */
const PREVIEWING: EngineMaintenance = {
  maintenance: ["release", "load", "optimize", "check"],
  maintenanceSpecs: [
    specOf("release", true, false, true),
    specOf("load", true, false),
    specOf("optimize", false, true, true),
  ],
};

const OPERATION_NOT_OFFERED: CallRefusal = { rule: "request-operation-not-offered", pointer: "/operation" };
const PLACEMENT_NOT_OFFERED: CallRefusal = { rule: "request-placement-not-offered", pointer: "/target" };
const PREVIEW_NOT_OFFERED: CallRefusal = { rule: "request-preview-not-offered", pointer: "/operation" };

describe("checkMaintenanceRunRequest and checkMaintenancePreviewRequest", () => {
  test("a maintenance run is held to the operations and placements the session's maintenance offers, kill placed nowhere", () => {
    const target = randomUUID();
    const container = randomUUID();
    const taken: MaintenanceRunRequest[] = [
      { operation: "vacuum", target, container },
      { operation: "vacuum" },
      { operation: "analyze", target },
      { operation: "kill", target },
      { operation: "kill" },
    ];
    for (const request of taken) {
      expect(checkMaintenanceRunRequest(POSTGRES_LIKE, request)).toEqual([]);
    }

    expect(checkMaintenanceRunRequest(POSTGRES_LIKE, { operation: "optimize", target })).toEqual([
      OPERATION_NOT_OFFERED,
    ]);
    expect(checkMaintenanceRunRequest(NARROWED, { operation: "reindex" })).toEqual([OPERATION_NOT_OFFERED]);
    expect(checkMaintenanceRunRequest(NARROWED, { operation: "vacuum", target, container })).toEqual([
      PLACEMENT_NOT_OFFERED,
    ]);
    expect(checkMaintenanceRunRequest(NARROWED, { operation: "vacuum" })).toEqual([]);
    expect(checkMaintenanceRunRequest(NARROWED, { operation: "kill", target })).toEqual([]);
    expect(checkMaintenanceRunRequest(PREVIEWING, { operation: "release" })).toEqual([PLACEMENT_NOT_OFFERED]);
    expect(checkMaintenanceRunRequest(PREVIEWING, { operation: "release", target })).toEqual([]);
    // An operation the maintenance lists with no spec is placed nowhere, so no placement is refused.
    expect(checkMaintenanceRunRequest(PREVIEWING, { operation: "check" })).toEqual([]);
    expect(checkMaintenanceRunRequest(PREVIEWING, { operation: "check", target })).toEqual([]);
    expect(callRefusalSentence(OPERATION_NOT_OFFERED)).toBe(
      'The request names at "/operation" an operation the session\'s maintenance does not list, so the call was not made.',
    );
    expect(callRefusalSentence(PLACEMENT_NOT_OFFERED)).toBe(
      "The request asks at \"/target\" for a placement the operation's spec in the session's maintenance does not offer, so the call was not made.",
    );
  });

  test("a maintenance preview is held to an operation whose spec previews on a row", () => {
    const path = [randomUUID(), randomUUID()];

    expect(checkMaintenancePreviewRequest(PREVIEWING, { operation: "release", path })).toEqual([]);
    expect(checkMaintenancePreviewRequest(PREVIEWING, { operation: "release", path: [randomUUID()] })).toEqual([]);
    expect(checkMaintenancePreviewRequest(PREVIEWING, { operation: "vacuum", path })).toEqual([OPERATION_NOT_OFFERED]);
    expect(checkMaintenancePreviewRequest(PREVIEWING, { operation: "load", path })).toEqual([PREVIEW_NOT_OFFERED]);
    // A spec that declares a preview but offers no row has no per-row dialog to show it in.
    expect(checkMaintenancePreviewRequest(PREVIEWING, { operation: "optimize", path })).toEqual([PREVIEW_NOT_OFFERED]);
    expect(checkMaintenancePreviewRequest(PREVIEWING, { operation: "check", path })).toEqual([PREVIEW_NOT_OFFERED]);
    expect(checkMaintenancePreviewRequest(POSTGRES_LIKE, { operation: "vacuum", path })).toEqual([PREVIEW_NOT_OFFERED]);
    // A request with no path list is not of this shape: the check does not read it, and the request's frame refuses it.
    const noPath = { operation: "release" } as unknown as MaintenancePreviewRequest;
    expect(checkMaintenancePreviewRequest(PREVIEWING, noPath)).toEqual([]);
    expect(checkMaintenancePreviewRequest(POSTGRES_LIKE, { ...noPath, operation: "vacuum" })).toEqual([
      PREVIEW_NOT_OFFERED,
    ]);
    expect(callRefusalSentence(PREVIEW_NOT_OFFERED)).toBe(
      'The request at "/operation" names an operation whose spec in the session\'s maintenance declares no preview on a row, so the call was not made.',
    );
  });

  test("a maintenance request with empty text where it names something is refused by the field", () => {
    const target: CallRefusal = { rule: "request-field-empty", pointer: "/target", name: "target" };
    const container: CallRefusal = { rule: "request-field-empty", pointer: "/container", name: "container" };
    const path: CallRefusal = { rule: "request-field-empty", pointer: "/path", name: "path" };
    const item = (index: number): CallRefusal => ({
      rule: "request-field-empty",
      pointer: `/path/${index}`,
      name: "path",
    });

    expect(checkMaintenanceRunRequest(POSTGRES_LIKE, { operation: "vacuum", target: "" })).toEqual([target]);
    expect(checkMaintenanceRunRequest(POSTGRES_LIKE, { operation: "vacuum", container: "" })).toEqual([container]);
    expect(checkMaintenanceRunRequest(POSTGRES_LIKE, { operation: "vacuum", target: "", container: "" })).toEqual([
      target,
      container,
    ]);
    // An empty target is refused as empty, never also read as a placement.
    expect(checkMaintenanceRunRequest(NARROWED, { operation: "vacuum", target: "" })).toEqual([target]);
    expect(checkMaintenancePreviewRequest(PREVIEWING, { operation: "release", path: [] })).toEqual([path]);
    expect(checkMaintenancePreviewRequest(PREVIEWING, { operation: "release", path: ["", randomUUID(), ""] })).toEqual([
      item(0),
      item(2),
    ]);
    expect(callRefusalSentence(target)).toBe(
      'The request carries the field "target" at "/target" empty, so it names nothing and the call was not made.',
    );
  });

  test("no maintenance request refusal carries a value of the request", () => {
    const values = [randomUUID(), randomUUID(), randomUUID()];
    const unlisted = randomUUID() as MaintenanceOperation;
    const run: MaintenanceRunRequest = { operation: unlisted, target: values[0], container: values[1] };
    const preview: MaintenancePreviewRequest = { operation: unlisted, path: [values[2] as string, ""] };
    const placed: MaintenanceRunRequest = { operation: "vacuum", target: values[0], container: "" };

    const refusals = [
      ...checkMaintenanceRunRequest(POSTGRES_LIKE, run),
      ...checkMaintenancePreviewRequest(POSTGRES_LIKE, preview),
      ...checkMaintenanceRunRequest(NARROWED, placed),
    ];
    const text = JSON.stringify(refusals) + new CallRefusalError(refusals).message;

    expect(refusals.map((refusal) => refusal.rule)).toEqual([
      "request-operation-not-offered",
      "request-operation-not-offered",
      "request-field-empty",
      "request-placement-not-offered",
      "request-field-empty",
    ]);
    for (const value of [unlisted, ...values]) expect(text).not.toContain(value);
  });
});

describe("CallRefusalError", () => {
  test("a CallRefusalError carries every refusal and words each", () => {
    const refusals = checkExecuteRequest(NOTHING, allThree);
    const error = new CallRefusalError(refusals);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CallRefusalError");
    expect(error.refusals).toEqual([PARAMS, OFFSET, SCOPE]);
    expect(error.refusals).not.toBe(refusals);
    expect(Object.isFrozen(error.refusals)).toBe(true);
    expect(error.message).toBe(refusals.map(callRefusalSentence).join(" "));
    expect(callRefusalSentence(PARAMS)).toBe(
      'The request carries the field "params" at "/params", which the session\'s execute does not honour, so the call was not made.',
    );
    expect(callRefusalSentence(SCOPE)).toBe(
      'The request carries a scope at "/scope", and the session does not offer console.endScope, so the call was not made.',
    );
    expect(error.message).not.toContain(statement);
  });

  test("every call refusal rule is worded in one sentence", () => {
    for (const rule of CALL_REFUSAL_RULES) {
      const forms: CallRefusal[] = [
        { rule, pointer: "" },
        { rule, pointer: "/a\nb", name: 'a"\nb', limit: 1048576, size: 1048577 },
      ];
      for (const item of forms) {
        const sentence = callRefusalSentence(item);

        expect(sentence).toMatch(/^[A-Z][^\n]*\.$/);
        expect(sentence).not.toMatch(/\. [A-Z]/);
      }
      expect(callRefusalSentence(forms[0])).toContain("the top level");
      expect(callRefusalSentence(forms[1])).toContain('"/a\\nb"');
    }
  });
});
