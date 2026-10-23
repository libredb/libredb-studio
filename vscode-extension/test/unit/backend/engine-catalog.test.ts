import assert from "node:assert/strict";
import { CONNECTION_FORM_URI_MODE, EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { CONNECTION_FIELDS } from "@/lib/db/connection-fields";
import { CONNECTION_PICKER_ORDER } from "@/lib/db/connection-form";
import { CONNECTION_STRING } from "@/lib/db/connection-string";
import type { DatabaseType } from "@/lib/types";
import { engineCatalog, engineForm } from "../../../src/backend/engine-catalog";

const V0: readonly DatabaseType[] = ["postgres", "mssql", "mysql", "mongodb"];
const plain = (name: string) => ({ name, label: null, hint: null, placeholder: null, placement: "open" });
const ADDRESS = ["host", "port", "user", "password", "database"].map(plain);

describe("engines/list's projection", () => {
  it("offers the four v0 engines in picker order when the channel enables them (criterion 2)", () => {
    assert.deepEqual(
      engineCatalog(V0).engines.map((e) => [e.type, e.label]),
      [
        ["postgres", "PostgreSQL"],
        ["mysql", "MySQL"],
        ["mssql", "SQL Server"],
        ["mongodb", "MongoDB"],
      ],
    );
  });

  it("keeps the picker order whatever order the enabled list has", () => {
    assert.deepEqual(
      engineCatalog(["mongodb", "postgres"]).engines.map((e) => e.type),
      ["postgres", "mongodb"],
    );
  });

  it("offers every external type, in picker order, when no list is set (criterion 2)", () => {
    const types = engineCatalog(null).engines.map((e) => e.type);
    assert.deepEqual(
      types,
      CONNECTION_PICKER_ORDER.filter((t) => EXTERNAL_DATABASE_TYPES.includes(t)),
    );
    assert.deepEqual([...types].sort(), [...EXTERNAL_DATABASE_TYPES].sort());
    assert.equal(types.includes("libredb"), false);
  });

  it("projects PostgreSQL", () => {
    assert.deepEqual(engineForm("postgres"), {
      type: "postgres",
      label: "PostgreSQL",
      defaultHost: null,
      defaultPort: "5432",
      pasteScheme: "postgres",
      keepsPastedString: false,
      offersSsl: true,
      fields: ADDRESS,
    });
  });

  it("projects SQL Server with its instance name behind More Options and its hint", () => {
    assert.deepEqual(engineForm("mssql"), {
      type: "mssql",
      label: "SQL Server",
      defaultHost: null,
      defaultPort: "1433",
      pasteScheme: "mssql",
      keepsPastedString: false,
      offersSsl: true,
      fields: [
        ...ADDRESS,
        {
          name: "instanceName",
          label: null,
          placeholder: null,
          placement: "advanced",
          hint: "For named instances (e.g. SQLEXPRESS). Leave empty for default instance.",
        },
      ],
    });
  });

  it("projects MongoDB with its kept string, its placeholder and its open authentication database", () => {
    assert.deepEqual(engineForm("mongodb"), {
      type: "mongodb",
      label: "MongoDB",
      defaultHost: null,
      defaultPort: "27017",
      pasteScheme: "mongodb",
      keepsPastedString: true,
      offersSsl: true,
      fields: [
        ...ADDRESS,
        {
          name: "connectionString",
          label: null,
          hint: null,
          placement: "open",
          placeholder: "mongodb://localhost:27017/mydb  or  mongodb+srv://...",
        },
        {
          name: "authSource",
          label: null,
          placeholder: null,
          placement: "open",
          hint: "The database the user was created in, usually admin. Leave empty when the credentials live in the database above.",
        },
      ],
    });
  });

  it("takes every row's scheme, URI mode and field order from its record, as plain JSON", () => {
    for (const form of engineCatalog(null).engines) {
      assert.equal(form.pasteScheme, CONNECTION_STRING[form.type].scheme, form.type);
      assert.equal(form.keepsPastedString, CONNECTION_FORM_URI_MODE[form.type], form.type);
      assert.deepEqual(
        form.fields.map((f) => f.name),
        [...CONNECTION_FIELDS[form.type]],
        form.type,
      );
      assert.deepEqual(JSON.parse(JSON.stringify(form)), form, form.type);
    }
  });
});
