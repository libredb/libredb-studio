/**
 * The provider's structural guards (R-S1), read from its source:
 *
 * - the encoder table holds exactly the frames the read path may send, and nothing else;
 * - only `amqp/dial.ts` imports `node:net` or `node:tls`, type-only imports included; nothing under `amqp/` imports
 *   the management client, the read path or the provider; `generators.ts` and `limits.ts` import nothing from
 *   `amqp/`, `management/` or `node:*`, and `limits.ts` takes only type imports from outside the directory;
 * - no module imports from another provider's directory, by the `@/lib/db/providers/` alias or by a relative path
 *   out of this one, so the provider stays self-contained;
 * - exactly one `.write(` call exists in the whole directory, in `amqp/connection.ts`, which is the socket write every
 *   outbound frame passes through. `amqp/codec.ts` encodes strings with `TextEncoder.encodeInto` or `Buffer.from`,
 *   never `Buffer#write`, so the count holds no false call.
 *
 * The walk is recursive, because the modules sit under `amqp/` and `management/`, and it asserts it saw at least the
 * 24 modules of the provider, so a moved directory cannot pass by seeing nothing. Comments are stripped before
 * every count, so prose naming a rule is never a call site.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ENCODERS } from "@/lib/db/providers/stream/rabbitmq/amqp/codec";

const ROOT = path.join(import.meta.dir, "..", "..", "..", "..", "src", "lib", "db", "providers", "stream", "rabbitmq");

/** The provider's modules by their path under the directory, `amqp/dial.ts` style. */
function modules(dir = ROOT): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return modules(full);
    return name.endsWith(".ts") ? [path.relative(ROOT, full).split(path.sep).join("/")] : [];
  });
}

function code(module: string): string {
  return readFileSync(path.join(ROOT, module), "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/.*$/gm, "");
}

interface Import {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

/** Static imports and re-exports, side-effect imports, dynamic imports and requires, in comment-free text. */
function importsOf(text: string): Import[] {
  const found: Import[] = [];
  for (const match of text.matchAll(/\b(import|export)\s+(type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']/g)) {
    found.push({ specifier: match[3], typeOnly: match[1] === "import" && match[2] !== undefined });
  }
  for (const match of text.matchAll(/\bimport\s*["']([^"']+)["']/g))
    found.push({ specifier: match[1], typeOnly: false });
  for (const match of text.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    found.push({ specifier: match[1], typeOnly: false });
  }
  return found;
}

function imports(module: string): Import[] {
  return importsOf(code(module));
}

/** A relative specifier resolved to its module path under the directory; anything else as written. */
function target(module: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  return path.posix.normalize(path.posix.join(path.posix.dirname(module), specifier));
}

const isNodeSocket = (specifier: string) => /^(node:)?(net|tls)$/.test(specifier);

/** The imports of `text` that reach another provider: an alias under providers/ outside this one, or a path out of it. */
function foreignProviderImports(module: string, text: string): string[] {
  return importsOf(text)
    .filter(({ specifier }) =>
      specifier.startsWith("@/lib/db/providers/")
        ? !specifier.startsWith("@/lib/db/providers/stream/rabbitmq/")
        : target(module, specifier).startsWith("../"),
    )
    .map(({ specifier }) => `${module} imports ${specifier}`);
}
const ALL = modules();

describe("the provider directory", () => {
  test("holds at least the 24 modules of the provider", () => {
    for (const expected of [
      "index.ts",
      "connection-options.ts",
      "limits.ts",
      "generators.ts",
      "errors.ts",
      "labels.ts",
      "objects.ts",
      "source.ts",
      "tracking-probe.ts",
      "monitoring.ts",
      "access-check.ts",
      "request.ts",
      "read.ts",
      "results.ts",
      "render.ts",
      "management/routes.ts",
      "management/client.ts",
      "management/depth.ts",
      "amqp/codec.ts",
      "amqp/field-table.ts",
      "amqp/frame-reader.ts",
      "amqp/connection.ts",
      "amqp/read-loop.ts",
      "amqp/dial.ts",
    ]) {
      expect(ALL).toContain(expected);
    }
    expect(ALL.length).toBeGreaterThanOrEqual(24);
  });
});

describe("the encoder table (R-S1)", () => {
  test("its keys are exactly the frames the read path may send", () => {
    expect(Object.keys(ENCODERS).sort()).toEqual(
      [
        "protocol-header",
        "connection.start-ok",
        "connection.tune-ok",
        "connection.open",
        "connection.close",
        "connection.close-ok",
        "channel.open",
        "channel.close-ok",
        "basic.qos",
        "basic.consume",
        "basic.ack",
        "basic.cancel-ok",
        "heartbeat",
      ].sort(),
    );
  });
});

describe("the import guard", () => {
  test("only amqp/dial.ts imports node:net or node:tls, type-only imports included", () => {
    const importers = ALL.filter((module) => imports(module).some((each) => isNodeSocket(each.specifier)));
    expect(importers).toEqual(["amqp/dial.ts"]);
  });

  test("no module imports from another provider's directory, by alias or by a relative path out of this one", () => {
    expect(ALL.flatMap((module) => foreignProviderImports(module, code(module)))).toEqual([]);
    expect(
      foreignProviderImports("render.ts", 'import { x } from "@/lib/db/providers/stream/kafka/decode";\n'),
    ).toEqual(["render.ts imports @/lib/db/providers/stream/kafka/decode"]);
    expect(foreignProviderImports("amqp/codec.ts", 'import type { y } from "../../kafka/types";\n')).toEqual([
      "amqp/codec.ts imports ../../kafka/types",
    ]);
    expect(
      foreignProviderImports("render.ts", 'import { z } from "@/lib/db/providers/stream/rabbitmq/limits";\n'),
    ).toEqual([]);
  });

  test("nothing under amqp/ imports management/, read.ts, results.ts or index.ts", () => {
    const forbidden = (resolved: string) =>
      resolved.startsWith("management/") || ["read", "results", "index"].includes(resolved.replace(/\.ts$/, ""));
    for (const file of ALL.filter((each) => each.startsWith("amqp/"))) {
      const reached = imports(file).map((each) => target(file, each.specifier));
      expect({ file, forbidden: reached.filter(forbidden) }).toEqual({ file, forbidden: [] });
    }
  });

  test("generators.ts and limits.ts import nothing from amqp/, management/ or node:*", () => {
    for (const file of ["generators.ts", "limits.ts"]) {
      const reached = imports(file).map((each) => target(file, each.specifier));
      const bad = reached.filter(
        (each) => each.startsWith("amqp/") || each.startsWith("management/") || each.startsWith("node:"),
      );
      expect({ file, bad }).toEqual({ file, bad: [] });
    }
  });

  test("limits.ts takes only type imports from outside the directory", () => {
    const outside = imports("limits.ts").filter((each) => !each.specifier.startsWith("."));
    expect(outside.every((each) => each.typeOnly)).toBe(true);
  });

  test("the parser reads every import form, a multi-line one included", () => {
    // Checked on a sample, so a form the parser cannot read cannot make a module look clean.
    const sample = [
      'import type { Socket } from "node:net";',
      'export { x } from "./a";',
      'import "node:tls";',
      'const m = await import("net");',
      'const t = require("tls");',
      "import {",
      "  a,",
      "  b,",
      '} from "../management/client";',
    ].join("\n");
    expect(importsOf(sample)).toEqual([
      { specifier: "node:net", typeOnly: true },
      { specifier: "./a", typeOnly: false },
      { specifier: "../management/client", typeOnly: false },
      { specifier: "node:tls", typeOnly: false },
      { specifier: "net", typeOnly: false },
      { specifier: "tls", typeOnly: false },
    ]);
    expect(target("amqp/read-loop.ts", "../management/client")).toBe("management/client");
  });
});

describe("the write-site sweep (R-S1)", () => {
  test("exactly one .write( call, in amqp/connection.ts", () => {
    const sites = ALL.flatMap((module) => (code(module).match(/\.write\(/g) ?? []).map(() => module));
    expect(sites).toEqual(["amqp/connection.ts"]);
  });
});
