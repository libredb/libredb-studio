/**
 * src/lib/db/connection-field-rules.ts, the one core module that evaluates the connection field rules: the dialog
 * reads it before Test Connection and Save send anything, and the test-connection path both post to reads it again
 * before it opens a tunnel or builds a provider (docs/providers/CONTRACT.md, clause M-33).
 */
import { describe, expect, test } from "bun:test";
import { builtinModules } from "node:module";
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import { connectionFieldRefusal, fieldRuleRefusal, requiredSecretOf } from "@/lib/db/connection-field-rules";
import type { EngineRecord } from "@/lib/db/server-catalog";
import { LEGACY_ENGINES } from "@/lib/provider-host/legacy-adapter/records";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { fieldRuleBase, fieldRuleCorpus } from "../../../helpers/field-rule-corpus";
import { OUTSIDE_THE_UNION, refusalOf, refusalThrownBy } from "../../../helpers/outside-the-union";
import { valueImportClosure, valueImportsOf } from "../../../helpers/value-import-closure";

const MODULE = "src/lib/db/connection-field-rules.ts";

/** `type`'s base connection of the field rule corpus with `fields` set. */
const withFields = (type: DatabaseType, fields: Record<string, unknown>): DatabaseConnection =>
  ({ ...fieldRuleBase(type), ...fields }) as DatabaseConnection;

describe("src/lib/db/connection-field-rules.ts", () => {
  test("its run-time graph reaches no React, component, provider or Node built-in module", () => {
    const closure = valueImportClosure(MODULE);
    expect(closure.unresolved).toEqual([]);
    const builtins = new Set(builtinModules);
    expect(closure.packages.filter((name) => name.startsWith("node:") || builtins.has(name))).toEqual([]);
    expect(
      closure.packages.filter((name) => name === "react" || name.startsWith("react") || name === "lucide-react"),
    ).toEqual([]);
    expect(
      closure.modules.filter((path) => path.startsWith("src/components/") || path === "src/lib/db-ui-config.ts"),
    ).toEqual([]);
    // No provider module of its own: what it reaches beyond itself is the form table's graph, which binds Studio's
    // named functions, and the storage classification, which says which fields are secrets.
    expect(valueImportsOf(MODULE).filter((path) => path.startsWith("src/lib/db/providers/"))).toEqual([]);
    const formGraph = new Set(valueImportClosure("src/lib/db/connection-form.ts").modules);
    expect(closure.modules.filter((path) => !formGraph.has(path))).toEqual([
      MODULE,
      "src/lib/storage/secret-fields.ts",
    ]);
  });

  test("a field holding null holds no value: its required rule refuses it and no other check reads it", () => {
    // RabbitMQ's AMQP port and Path prefix are optional: null is no port and no prefix, as the provider reads it.
    expect(
      connectionFieldRefusal(CONNECTION_FORM.rabbitmq, withFields("rabbitmq", { amqpPort: null })),
    ).toBeUndefined();
    expect(connectionFieldRefusal(CONNECTION_FORM.rabbitmq, withFields("rabbitmq", { apiPath: null }))).toBeUndefined();
    // A required field holding null is blank, so its required sentence answers, as the provider's does.
    expect(connectionFieldRefusal(CONNECTION_FORM.spark, withFields("spark", { host: null }))).toBe(
      CONNECTION_FORM.spark.fieldRules?.host?.required,
    );
    expect(connectionFieldRefusal(CONNECTION_FORM.databend, withFields("databend", { user: null }))).toBe(
      CONNECTION_FORM.databend.fieldRules?.user?.required,
    );
    // A secret's reading is unchanged: null is not text, so a required token is blank.
    const pat = withFields("snowflake", { authMethod: "pat", password: null });
    expect(connectionFieldRefusal(CONNECTION_FORM.snowflake, pat)).toBe(
      CONNECTION_FORM.snowflake.fieldRules?.password?.required,
    );
    expect(requiredSecretOf((LEGACY_ENGINES.get("snowflake") as EngineRecord).fieldRules, pat)).toBe(
      CONNECTION_FORM.snowflake.fieldRules?.password?.required,
    );
    // The control: a value that is text is still read by every check.
    expect(connectionFieldRefusal(CONNECTION_FORM.rabbitmq, withFields("rabbitmq", { amqpPort: "null" }))).toBe(
      CONNECTION_FORM.rabbitmq.fieldRules?.amqpPort?.format?.sentence,
    );
  });

  test("fieldRuleRefusal answers what connectionFieldRefusal answers on the engine's form entry, and refuses a type outside the union by name", () => {
    let refused = 0;
    for (const { type, connection, label } of fieldRuleCorpus()) {
      const expected = connectionFieldRefusal(CONNECTION_FORM[type], connection);
      if (expected !== undefined) refused += 1;
      expect({ label, answer: fieldRuleRefusal(type, connection) }).toEqual({ label, answer: expected });
    }
    // The control that the corpus holds refusals at all.
    expect(refused).toBeGreaterThan(500);
    // An engine that declares no rule refuses nothing.
    expect(
      fieldRuleRefusal("postgres", { id: "p", name: "p", type: "postgres", createdAt: new Date(0) }),
    ).toBeUndefined();
    for (const [label, value] of OUTSIDE_THE_UNION) {
      const connection = { id: "x", name: "x", type: value, createdAt: new Date(0) } as DatabaseConnection;
      expect({ label, refusal: refusalThrownBy(() => fieldRuleRefusal(value as DatabaseType, connection)) }).toEqual({
        label,
        refusal: refusalOf(value),
      });
    }
  });
});
