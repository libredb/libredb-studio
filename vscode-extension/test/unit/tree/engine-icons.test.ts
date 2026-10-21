import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, type SVGAttributes } from "react";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { writeEngineIcons, writeShippedEngineIcons } from "../../../scripts/engine-icons";
import { EngineIcons, readEngineIndex } from "../../../src/host/tree/icons";
import { Uri } from "../../fakes/vscode";

/** A logo drawn the way src/components/icons/db-icons.tsx draws them: currentColor strokes and fills. */
function Mark(props: SVGAttributes<SVGSVGElement>) {
  return createElement(
    "svg",
    { viewBox: "0 0 24 24", stroke: "currentColor", ...props },
    createElement("path", { fill: "currentColor", d: "M0 0h24" }),
  );
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "engine-icons-"));
}

describe("engine-icons", () => {
  it("writes a light and a dark logo per source with the theme colour, and the label index", () => {
    const dir = freshDir();
    writeEngineIcons({ alpha: { label: "Alpha", icon: Mark } }, ["alpha"], dir);
    assert.deepEqual(readdirSync(dir).sort(), ["alpha.dark.svg", "alpha.light.svg", "index.json"]);
    const light = readFileSync(join(dir, "alpha.light.svg"), "utf8");
    for (const part of ['stroke="#424242"', 'fill="#424242"', 'width="16"', 'height="16"']) {
      assert.ok(light.includes(part), `${part} in ${light}`);
    }
    assert.ok(!light.includes("currentColor"));
    const dark = readFileSync(join(dir, "alpha.dark.svg"), "utf8");
    for (const part of ['stroke="#C5C5C5"', 'fill="#C5C5C5"', 'width="16"', 'height="16"']) {
      assert.ok(dark.includes(part), `${part} in ${dark}`);
    }
    assert.ok(!dark.includes("currentColor"));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")), { alpha: { label: "Alpha" } });
  });

  it("removes a stale file the directory held", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "old.light.svg"), "<svg/>");
    writeEngineIcons({ alpha: { label: "Alpha", icon: Mark } }, ["alpha"], dir);
    assert.ok(!existsSync(join(dir, "old.light.svg")));
  });

  it("refuses a missing type and writes nothing", () => {
    const dir = join(freshDir(), "out");
    assert.throws(() => writeEngineIcons({ alpha: { label: "Alpha", icon: Mark } }, ["alpha", "beta"], dir), {
      message: "engine-icons: every DatabaseType needs a logo and a label; missing: beta; unknown: none.",
    });
    assert.ok(!existsSync(dir));
  });

  it("refuses an unknown type and writes nothing", () => {
    const dir = join(freshDir(), "out");
    assert.throws(
      () =>
        writeEngineIcons(
          { alpha: { label: "Alpha", icon: Mark }, gamma: { label: "Gamma", icon: Mark } },
          ["alpha"],
          dir,
        ),
      { message: "engine-icons: every DatabaseType needs a logo and a label; missing: none; unknown: gamma." },
    );
    assert.ok(!existsSync(dir));
  });

  it("writes every shipped type's logos and labels into media/engines", () => {
    const dir = freshDir();
    writeShippedEngineIcons(dir);
    const out = join(dir, "media", "engines");
    assert.equal(readdirSync(out).length, 2 * SHIPPED_DATABASE_TYPES.length + 1);
    const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8")) as Record<string, { label: string }>;
    assert.deepEqual(new Set(Object.keys(index)), new Set(SHIPPED_DATABASE_TYPES));
    assert.ok(existsSync(join(out, "postgres.light.svg")));
    assert.equal(index.postgres.label, DB_UI_CONFIG.postgres.label);
    assert.equal(index.mssql.label, DB_UI_CONFIG.mssql.label);
    assert.equal(index.mysql.label, DB_UI_CONFIG.mysql.label);
    assert.equal(index.mongodb.label, DB_UI_CONFIG.mongodb.label);
    assert.deepEqual(
      [index.postgres.label, index.mssql.label, index.mysql.label, index.mongodb.label],
      ["PostgreSQL", "SQL Server", "MySQL", "MongoDB"],
    );
  });

  it("writes the labels the host reads", () => {
    const dir = freshDir();
    writeShippedEngineIcons(dir);
    const index = readEngineIndex(readFileSync(join(dir, "media", "engines", "index.json"), "utf8"));
    assert.equal(new EngineIcons(Uri.file(dir), index).label("mongodb"), "MongoDB");
  });
});
