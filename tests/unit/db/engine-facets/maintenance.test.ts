import { describe, expect, test } from "bun:test";
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import {
  assertMaintenanceAccepted,
  assertMaintenanceOffered,
  maintenanceNotAcceptedSentence,
  maintenanceNotOfferedSentence,
} from "@/lib/db/engine-facets/maintenance";
import { errorOutcome } from "@/lib/db/error-record";
import { FacetNotOfferedError } from "@/lib/db/errors";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { type EngineRecord, servedEngineRecord } from "@/lib/db/server-catalog";
import { quoteTypeId } from "@/lib/db/type-id";

/** The error `run` throws, failing the test when it throws nothing. */
function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal, and nothing was thrown");
}

describe("assertMaintenanceOffered: the engine facets row before any provider", () => {
  test("a declared operation passes for its engine", () => {
    expect(() => assertMaintenanceOffered(servedEngineRecord("postgres"), "vacuum")).not.toThrow();
    expect(() => assertMaintenanceOffered(servedEngineRecord("trino"), "kill")).not.toThrow();
  });

  test("an operation the engine does not offer is refused by name, with the operations it offers", () => {
    const error = thrownBy(() => assertMaintenanceOffered(servedEngineRecord("mysql"), "vacuum"));
    expect(error).toBeInstanceOf(FacetNotOfferedError);
    const refusal = error as FacetNotOfferedError;
    expect(refusal.code).toBe(ApiErrorCode.FACET_NOT_OFFERED);
    expect(refusal.provider).toBe("mysql");
    expect(refusal.facet).toBe("maintenance");
    expect(refusal.operation).toBe("vacuum");
    expect(refusal.message).toBe(
      maintenanceNotOfferedSentence(CONNECTION_FORM.mysql.label, '"vacuum"', ["analyze", "optimize", "check", "kill"]),
    );
    expect(refusal.message).toBe(
      '"vacuum" is not a maintenance operation LibreDB Studio offers on MySQL, which offers analyze, optimize, check, kill; no connection was opened and nothing was run.',
    );
  });

  test("an engine that offers no maintenance refuses every operation and says it offers none", () => {
    const error = thrownBy(() =>
      assertMaintenanceOffered(servedEngineRecord("kafka"), "vacuum"),
    ) as FacetNotOfferedError;
    expect(error).toBeInstanceOf(FacetNotOfferedError);
    expect(error.provider).toBe("kafka");
    expect(error.message).toBe(
      '"vacuum" is not a maintenance operation LibreDB Studio offers on Apache Kafka, which offers none; no connection was opened and nothing was run.',
    );
  });

  test.each(["constructor", "__proto__", "toString"])(
    "a prototype key is not an operation any engine offers: %s",
    (key) => {
      const error = thrownBy(() =>
        assertMaintenanceOffered(servedEngineRecord("postgres"), key),
      ) as FacetNotOfferedError;
      expect(error).toBeInstanceOf(FacetNotOfferedError);
      expect(error.operation).toBe(key);
      expect(error.message.startsWith(`${JSON.stringify(key)} is not a maintenance operation`)).toBe(true);
    },
  );

  test("a refused operation is quoted on one line", () => {
    const operation = "va\u2028cuum\n";
    const error = thrownBy(() =>
      assertMaintenanceOffered(servedEngineRecord("postgres"), operation),
    ) as FacetNotOfferedError;
    expect(error.operation).toBe(operation);
    expect(error.message.startsWith(`${quoteTypeId(operation)} is not a maintenance operation`)).toBe(true);
    expect(error.message).not.toMatch(/[\n\u2028]/);
  });
});

describe("assertMaintenanceAccepted: the connected server's declaration", () => {
  test("after connect, an operation the server accepts passes", () => {
    expect(() =>
      assertMaintenanceAccepted(servedEngineRecord("postgres"), "vacuum", {
        supportsMaintenance: true,
        maintenanceOperations: ["vacuum", "analyze", "kill"],
      }),
    ).not.toThrow();
  });

  test("after connect, an operation the server does not accept is refused with what it accepts", () => {
    const error = thrownBy(() =>
      assertMaintenanceAccepted(servedEngineRecord("postgres"), "reindex", {
        supportsMaintenance: true,
        maintenanceOperations: ["vacuum", "analyze", "kill"],
      }),
    ) as FacetNotOfferedError;
    expect(error).toBeInstanceOf(FacetNotOfferedError);
    expect(error.code).toBe(ApiErrorCode.FACET_NOT_OFFERED);
    expect(error.provider).toBe("postgres");
    expect(error.facet).toBe("maintenance");
    expect(error.operation).toBe("reindex");
    expect(error.message).toBe(
      maintenanceNotAcceptedSentence(CONNECTION_FORM.postgres.label, '"reindex"', ["vacuum", "analyze", "kill"]),
    );
    expect(error.message).toBe(
      '"reindex" is not a maintenance operation the PostgreSQL server this connection reaches accepts, which accepts vacuum, analyze, kill; nothing was run.',
    );
  });

  test("after connect, a server that accepts no maintenance is refused saying it accepts none", () => {
    const error = thrownBy(() =>
      assertMaintenanceAccepted(servedEngineRecord("postgres"), "vacuum", {
        supportsMaintenance: false,
        maintenanceOperations: ["vacuum"],
      }),
    ) as FacetNotOfferedError;
    expect(error).toBeInstanceOf(FacetNotOfferedError);
    expect(error.message).toBe(
      '"vacuum" is not a maintenance operation the PostgreSQL server this connection reaches accepts, which accepts none; nothing was run.',
    );
  });
});

/**
 * A package engine's record as the two checks read it: its display name, its maintenance list and no legacy provider.
 * Built as a literal, since the checks read nothing else of a record.
 */
function packageRecord(maintenance: readonly string[]): EngineRecord {
  return {
    id: "acmemaintcheck",
    displayName: "Acme Maintenance Check",
    maintenance,
    offers: { legacyProvider: false },
  } as unknown as EngineRecord;
}

describe("both checks read a package engine's record", () => {
  test("a package record's operation outside its list, or one its session does not accept, is refused naming its display name and no legacy provider", () => {
    const listed = packageRecord(["vacuum", "kill"]);
    expect(() => assertMaintenanceOffered(listed, "vacuum")).not.toThrow();
    const notListed = thrownBy(() => assertMaintenanceOffered(listed, "analyze")) as FacetNotOfferedError;
    expect(notListed).toBeInstanceOf(FacetNotOfferedError);
    expect([notListed.provider, notListed.facet, notListed.operation, notListed.code]).toEqual([
      undefined,
      "maintenance",
      "analyze",
      ApiErrorCode.FACET_NOT_OFFERED,
    ]);
    expect(notListed.message).toBe(
      '"analyze" is not a maintenance operation LibreDB Studio offers on Acme Maintenance Check, which offers vacuum, kill; no connection was opened and nothing was run.',
    );
    const none = thrownBy(() => assertMaintenanceOffered(packageRecord([]), "vacuum")) as FacetNotOfferedError;
    expect(none.message).toBe(
      '"vacuum" is not a maintenance operation LibreDB Studio offers on Acme Maintenance Check, which offers none; no connection was opened and nothing was run.',
    );
    const prototypeKey = thrownBy(() => assertMaintenanceOffered(listed, "constructor")) as FacetNotOfferedError;
    expect(prototypeKey.operation).toBe("constructor");

    expect(() =>
      assertMaintenanceAccepted(listed, "vacuum", { supportsMaintenance: true, maintenanceOperations: ["vacuum"] }),
    ).not.toThrow();
    const notAccepted = thrownBy(() =>
      assertMaintenanceAccepted(listed, "kill", { supportsMaintenance: false, maintenanceOperations: [] }),
    ) as FacetNotOfferedError;
    expect(notAccepted).toBeInstanceOf(FacetNotOfferedError);
    expect([notAccepted.provider, notAccepted.facet, notAccepted.operation]).toEqual([
      undefined,
      "maintenance",
      "kill",
    ]);
    expect(notAccepted.message).toBe(
      '"kill" is not a maintenance operation the Acme Maintenance Check server this connection reaches accepts, which accepts none; nothing was run.',
    );
  });
});

describe("both refusals are raised before any call", () => {
  test("both refusals are not-sent, for a legacy record and a package's alike, since neither is raised after a call", () => {
    for (const engine of [servedEngineRecord("postgres"), packageRecord(["vacuum"])]) {
      const notListed = thrownBy(() => assertMaintenanceOffered(engine, "optimize"));
      expect(notListed).toBeInstanceOf(FacetNotOfferedError);
      expect(errorOutcome(notListed)).toBe("not-sent");
      const notAccepted = thrownBy(() =>
        assertMaintenanceAccepted(engine, "vacuum", { supportsMaintenance: false, maintenanceOperations: [] }),
      );
      expect(notAccepted).toBeInstanceOf(FacetNotOfferedError);
      expect(errorOutcome(notAccepted)).toBe("not-sent");
    }
  });
});
