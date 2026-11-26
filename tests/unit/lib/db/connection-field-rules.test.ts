/**
 * src/lib/db/connection-field-rules.ts, the one core module that evaluates the connection field rules: the dialog
 * reads it before Test Connection and Save send anything, and the test-connection path both post to reads it again,
 * over the engine record's field rules, before it opens a tunnel or anything else (docs/providers/CONTRACT.md, clause
 * M-33).
 */
import { describe, expect, test } from "bun:test";
import { builtinModules } from "node:module";
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import { connectionFieldRefusal, requiredSecretOf } from "@/lib/db/connection-field-rules";
import type { EngineRecord } from "@/lib/db/server-catalog";
import { LEGACY_ENGINES } from "@/lib/provider-host/legacy-adapter/records";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { fieldRuleBase } from "../../../helpers/field-rule-corpus";
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
    // No provider module of its own: it reads the rules its caller hands it, so what it reaches beyond itself is the
    // storage classification alone, which says which fields are secrets.
    expect(valueImportsOf(MODULE).filter((path) => path.startsWith("src/lib/db/providers/"))).toEqual([]);
    expect([...closure.modules].sort()).toEqual([MODULE, "src/lib/storage/secret-fields.ts"]);
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
});
