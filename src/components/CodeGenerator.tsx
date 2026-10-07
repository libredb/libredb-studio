"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Code, X, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/copy-button";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { ColumnSchema } from "@/lib/types";
import { objectPathLabel } from "@/lib/db/object-path";
import { objectSegment } from "@/lib/query-generators";

interface CodeGeneratorProps {
  isOpen: boolean;
  onClose: () => void;
  /** The object's ADDRESS, one element per segment (#789, Task 35), never its label. */
  tablePath: readonly string[];
  tableSchema: DetailedObject | null;
  databaseType?: string;
}

type Language = "typescript" | "zod" | "prisma" | "go" | "python" | "java";

const LANGUAGES: { id: Language; label: string; ext: string }[] = [
  { id: "typescript", label: "TypeScript Interface", ext: "ts" },
  { id: "zod", label: "Zod Schema", ext: "ts" },
  { id: "prisma", label: "Prisma Model", ext: "prisma" },
  { id: "go", label: "Go Struct", ext: "go" },
  { id: "python", label: "Python Dataclass", ext: "py" },
  { id: "java", label: "Java POJO", ext: "java" },
];

export function toPascalCase(str: string): string {
  return str.replace(/[_-](\w)/g, (_, c) => c.toUpperCase()).replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * A legal type identifier for every target language. Table names are not always
 * identifiers: Redis "tables" are key-prefix groupings like `user:*` (#427), so
 * `export interface User:*` was being emitted for every language. Punctuation
 * runs become word boundaries, the segments PascalCase, and anything that cannot
 * start an identifier is replaced rather than prefixed with `_`, because Prisma
 * model names must begin with a letter and would reject a leading underscore.
 * One shared rule for all six languages: their union constraint is a letter
 * followed by letters and digits, so per-language variants would buy nothing.
 *
 * The classes are Unicode (`\p{L}` / `\p{N}`), never `A-Za-z0-9`: TypeScript,
 * Zod, Go, Python and Java all accept Unicode letters in an identifier, so an
 * ASCII-only strip DESTROYS names that were already legal in five of the six
 * targets — `musteri` with its Turkish diacritics collapsed to `MTeri`, and a
 * wholly non-Latin name such as a CJK one lost every character and fell back to
 * `Record`, which made two different tables generate two files declaring ONE
 * type (#427).
 *
 * Prisma is the exception: a model name is `[A-Za-z][A-Za-z0-9_]*`, so a Unicode
 * name still yields a model Prisma would reject. Stripping to ASCII would not
 * rescue it — the surviving stem names the wrong thing, or nothing — and it
 * would break the other five, so the Unicode classes stand and the Prisma output
 * for such a name is left where it already was before this function existed.
 *
 * The trailing `s` strip singularizes a table name (`users` gives `User`) and lives HERE,
 * not in `toPascalCase()`: that one also names fields, and a field must keep the column's
 * name, or `status` becomes `statu` and the generated type no longer describes the row (#1138).
 */
export function toIdentifier(str: string): string {
  // The trim is `^_|_$`, not `^_+|_+$`: the collapse above has already reduced
  // every run of separators to ONE underscore, so a repeated quantifier here can
  // never match more — it only adds the backtracking that makes the pattern
  // super-linear on a long run of separators (SonarCloud S5852).
  const result = toPascalCase(str.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "")).replace(/s$/, "");
  if (!/^\p{L}/u.test(result)) return result ? `T${result}` : "Record";
  return result;
}

export function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "");
}

/**
 * What a declared type IS, decided once and mapped by every language (#1446).
 *
 * The mappers below used to test substrings in their own order, which is how the
 * defects came in: `Array(Int32)` and `Map(String, Int32)` contain `int`, so the int
 * test won before any container was considered and a list of numbers was typed as
 * one number; a type spelled `number` (LibreDB) or `NUMBER` (Oracle) matched no arm
 * at all and fell to the string default. One classification, decided here, ends the
 * divergence: every mapper below maps a class, so a new type family has to be added
 * once rather than six times in the same order.
 */
type TypeClass =
  | { kind: "array"; element?: TypeClass }
  | { kind: "map"; key?: TypeClass; value?: TypeClass }
  | { kind: "int64" }
  | { kind: "integer" }
  | { kind: "float" }
  | { kind: "double" }
  | { kind: "boolean" }
  | { kind: "datetime" }
  | { kind: "json" }
  | { kind: "uuid" }
  | { kind: "string" };

const classifySqlType = (sqlType: string): TypeClass => {
  // The original spelling is kept beside the lowercased one: the width-explicit
  // integer family below is read case-sensitively, because `Int8` and `int8` are
  // different types - ClickHouse's 8-bit integer and PostgreSQL's 64-bit one -
  // and the two readings agree on no language's type.
  let original = sqlType.trim();
  let t = original.toLowerCase();
  // ClickHouse's `Nullable(...)` wrapper names nullability, which the column's own
  // `nullable` flag carries; unwrapping it keeps the inner type visible to the
  // container test below, so `Nullable(Array(String))` is a list of strings.
  while (t.startsWith("nullable(") && t.endsWith(")")) {
    original = original.slice(9, -1);
    t = t.slice(9, -1);
  }
  // PostgreSQL's own array spelling, from `format_type`: a trailing `[]` makes the
  // type an array of whatever precedes it (`integer[]`, `timestamp with time
  // zone[]`), and a second `[]` nests. The internal `_text` spelling and the word
  // `ARRAY` name no element, so those keep the bare-array treatment below.
  if (t.endsWith("[]")) return { kind: "array", element: classifySqlType(original.slice(0, -2)) };
  // Containers FIRST, before any numeric word: an `Array(Int32)` contains `int`,
  // and the int test used to win. The element sits between the first `(` and the
  // last `)` of the whole spelling, which also holds for one nested level
  // (`Array(Nullable(String))`). A spelling with no parentheses (PostgreSQL's
  // `_text ARRAY`, Cassandra's `list<timestamp>`) names no element, and a tuple
  // names several, so all of them stay bare.
  // The element is sliced from the ORIGINAL spelling, so a ClickHouse `Int32`
  // inside `Array(Int32)` reaches the case-sensitive width test below as `Int32`
  // and not as the lowercased `int32`, which is a different type's spelling.
  const container = /\b(array|list|map|tuple)\b/.exec(t);
  if (container !== null) {
    const open = t.indexOf("(");
    const close = t.lastIndexOf(")");
    const inner = open >= 0 && close > open ? original.slice(open + 1, close) : null;
    if (container[1] === "map") {
      const comma = inner === null ? -1 : inner.indexOf(",");
      if (inner !== null && comma > 0) {
        return {
          kind: "map",
          key: classifySqlType(inner.slice(0, comma)),
          value: classifySqlType(inner.slice(comma + 1)),
        };
      }
      return { kind: "map" };
    }
    if (container[1] !== "tuple" && inner !== null) return { kind: "array", element: classifySqlType(inner) };
    return { kind: "array" };
  }
  // ClickHouse's width-explicit family, spelled CamelCase and read
  // case-sensitively: `Int8`, `Int16` and `Int32` are 8/16/32-bit integers, while
  // `Int64`, `UInt64` and the wider ones are the 64-bit class. A lowercase `int8`
  // is PostgreSQL's spelling of BIGINT and is read by the token test below, which
  // is why the two are not one rule.
  const width = /\bU?Int(\d+)\b/.exec(original);
  if (width !== null) return Number(width[1]) >= 64 ? { kind: "int64" } : { kind: "integer" };
  // Integer spellings are WHOLE TOKENS, never a substring: `point`, `interval`
  // and `geo_point` each carry `int` as characters and none is an integer type,
  // and the substring test typed them `int`/`Integer`/`Int` in three languages
  // (#1446 review). DuckDB's unsigned and 128-bit spellings (`UINTEGER`, `UBIGINT`,
  // `HUGEINT`) are whole tokens of their own and join the family they widen.
  if (/\b(u?bigint|u?hugeint|int8|int64|uint64|bigserial|serial8)\b/.test(t)) return { kind: "int64" };
  if (
    /\b(int|u?integer|int2|int4|u?smallint|u?tinyint|mediumint|serial|serial2|serial4|smallserial|varint)\b/.test(t)
  ) {
    return { kind: "integer" };
  }
  // Two numeric families, because Go and Java spell them differently: the
  // single-precision family (float, real) and the wide one (double, decimal,
  // numeric, and a type spelled `number`, which is LibreDB's and Oracle's word).
  if (t.includes("float") || t.includes("real")) return { kind: "float" };
  if (t.includes("double") || t.includes("decimal") || t.includes("numeric") || /\bnumber\b/.test(t)) {
    return { kind: "double" };
  }
  if (t.includes("bool")) return { kind: "boolean" };
  if (t.includes("date") || t.includes("time")) return { kind: "datetime" };
  if (t.includes("json")) return { kind: "json" };
  if (t.includes("uuid")) return { kind: "uuid" };
  return { kind: "string" };
};

const tsType = (type: TypeClass): string => {
  switch (type.kind) {
    case "array":
      return type.element === undefined ? "unknown[]" : `${tsType(type.element)}[]`;
    case "map":
      return type.value === undefined ? "Record<string, unknown>" : `Record<string, ${tsType(type.value)}>`;
    case "int64":
      return "bigint";
    case "integer":
    case "float":
    case "double":
      return "number";
    case "boolean":
      return "boolean";
    case "datetime":
      return "Date";
    case "json":
      return "Record<string, unknown>";
    case "uuid":
    case "string":
      return "string";
  }
};

const zodType = (type: TypeClass): string => {
  switch (type.kind) {
    case "array":
      return `z.array(${type.element === undefined ? "z.unknown()" : zodType(type.element)})`;
    case "map":
      return `z.record(${type.value === undefined ? "z.unknown()" : zodType(type.value)})`;
    case "int64":
      return "z.bigint()";
    case "integer":
    case "float":
    case "double":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "datetime":
      return "z.date()";
    case "json":
      return "z.record(z.unknown())";
    case "uuid":
      return "z.string().uuid()";
    case "string":
      return "z.string()";
  }
};

const prismaType = (type: TypeClass): string => {
  switch (type.kind) {
    // Prisma's scalar lists are a connector conditional (PostgreSQL and CockroachDB
    // alone) and it has no map type at all, and this generator serves every engine,
    // so a container is Json there rather than a list only one connector accepts.
    case "array":
    case "map":
    case "json":
      return "Json";
    case "int64":
      return "BigInt";
    case "integer":
      return "Int";
    case "float":
    case "double":
      return "Float";
    case "boolean":
      return "Boolean";
    case "datetime":
      return "DateTime";
    case "uuid":
    case "string":
      return "String";
  }
};

const goType = (type: TypeClass): string => {
  switch (type.kind) {
    case "array":
      return type.element === undefined ? "[]interface{}" : `[]${goType(type.element)}`;
    case "map":
      return `map[${type.key === undefined ? "string" : goType(type.key)}]${
        type.value === undefined ? "interface{}" : goType(type.value)
      }`;
    case "int64":
      return "int64";
    case "integer":
      return "int";
    case "float":
      return "float32";
    case "double":
      return "float64";
    case "boolean":
      return "bool";
    case "datetime":
      return "time.Time";
    case "json":
    case "uuid":
    case "string":
      return "string";
  }
};

const pythonType = (type: TypeClass): string => {
  switch (type.kind) {
    case "array":
      return type.element === undefined ? "list" : `list[${pythonType(type.element)}]`;
    case "map":
      return type.key === undefined || type.value === undefined
        ? "dict"
        : `dict[${pythonType(type.key)}, ${pythonType(type.value)}]`;
    case "int64":
    case "integer":
      return "int";
    case "float":
    case "double":
      return "float";
    case "boolean":
      return "bool";
    case "datetime":
      return "datetime";
    case "json":
      return "dict";
    case "uuid":
    case "string":
      return "str";
  }
};

const javaType = (type: TypeClass): string => {
  switch (type.kind) {
    case "array":
      return type.element === undefined ? "Object[]" : `${javaType(type.element)}[]`;
    case "map":
      return `Map<${type.key === undefined ? "String" : javaType(type.key)}, ${
        type.value === undefined ? "Object" : javaType(type.value)
      }>`;
    case "int64":
      return "Long";
    case "integer":
      return "Integer";
    case "float":
      return "Float";
    case "double":
      return "Double";
    case "boolean":
      return "Boolean";
    case "datetime":
      return "LocalDateTime";
    case "json":
    case "uuid":
    case "string":
      return "String";
  }
};

export function mapSqlTypeToTS(sqlType: string): string {
  return tsType(classifySqlType(sqlType));
}

export function mapSqlTypeToZod(sqlType: string): string {
  return zodType(classifySqlType(sqlType));
}

export function mapSqlTypeToPrisma(sqlType: string): string {
  return prismaType(classifySqlType(sqlType));
}

export function mapSqlTypeToGo(sqlType: string): string {
  return goType(classifySqlType(sqlType));
}

export function mapSqlTypeToPython(sqlType: string): string {
  return pythonType(classifySqlType(sqlType));
}

export function mapSqlTypeToJava(sqlType: string): string {
  return javaType(classifySqlType(sqlType));
}

/**
 * The type these mappers decide on, which is not always the one the browser shows.
 *
 * Every mapper below matches a type FAMILY - by `===` for the integer arms, by substring for
 * the rest - and a DECLARED type is not one. MySQL and MariaDB report `int unsigned`,
 * `varchar(20)` and `enum('x','y')` (#1033), so `t === "int"` matches none of them and the
 * column falls through to the string default, while `enum('int','text')` matches the
 * substring test for `int` and is typed a number. `baseType` is the provider's own answer to
 * that question and is absent wherever an engine draws no such distinction, which is the same
 * rule `decidableType` in `src/lib/agent/table-profile.ts` applies.
 */
const decidableType = (column: ColumnSchema): string => column.baseType ?? column.type;

/** A key or name that every language here accepts: a letter (Unicode), then letters, digits, `_` or `$`. */
const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/** Python drops `$` from that union. */
const PYTHON_IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** A name inside a string literal, with the two characters a double-quoted literal cannot carry raw. */
const stringLiteral = (text: string): string => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * A field NAME for the languages that have no quoted key (#1446): the same rule as
 * `toIdentifier` — punctuation runs become word boundaries, the segments PascalCase,
 * Unicode letters kept — without the trailing-`s` strip, because a field keeps the
 * column's name (#1138), and with a `Field` fallback rather than `Record`, which
 * names a type, not a field.
 */
const fieldIdentifier = (str: string): string => {
  const result = toPascalCase(str.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, ""));
  if (!/^\p{L}/u.test(result)) return result ? `T${result}` : "Field";
  return result;
};

/**
 * A field key as TypeScript and Zod write it (#1446): the styled name when that is an
 * identifier, and the column's own name quoted when it is not — `toCamelCase` kept
 * every non-`_`/`-` character, so a nested Elasticsearch field emitted
 * `address.city: string | null;`, which does not parse. The quoted key is the
 * column's own name, because that is the key the row carries.
 */
const tsFieldKey = (name: string): string => {
  const styled = toCamelCase(name);
  return IDENTIFIER.test(styled) ? styled : `"${stringLiteral(name)}"`;
};

/**
 * A Go field name: the styled name when it is an identifier, `fieldIdentifier`
 * otherwise. The tag beside it already carries the column's own name, so a
 * sanitised field name loses nothing.
 */
const goFieldName = (name: string): string => {
  const styled = toPascalCase(name);
  return IDENTIFIER.test(styled) ? styled : fieldIdentifier(name);
};

/**
 * A Java field name: the styled name when it is an identifier, `fieldIdentifier`
 * camel-cased otherwise, with `@JsonProperty` carrying the column's own name.
 */
const javaFieldName = (name: string): string => {
  const styled = toCamelCase(name);
  return IDENTIFIER.test(styled) ? styled : toCamelCase(fieldIdentifier(name));
};

/** A Prisma field name: the column's own name when Prisma accepts it, else the closest sanitised spelling. */
const prismaField = (name: string): string => {
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return name;
  const sanitised = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "");
  return /^[A-Za-z]/.test(sanitised) ? sanitised : `t${sanitised}`;
};

export function generateCode(lang: Language, table: DetailedObject): string {
  // The type, model or struct NAME is for a person to read, so it is derived from the display
  // label. The Prisma `@@map` below is not: it is what Prisma addresses the table by, so it
  // takes the object's own segment, which the label is not required to equal (#789).
  const name = toIdentifier(table.name);
  const columns = table.columns || [];

  switch (lang) {
    case "typescript": {
      const fields = columns.map((c) => {
        const tsType = mapSqlTypeToTS(decidableType(c));
        const nullable = c.nullable ? " | null" : "";
        return `  ${tsFieldKey(c.name)}: ${tsType}${nullable};`;
      });
      return `export interface ${name} {\n${fields.join("\n")}\n}`;
    }
    case "zod": {
      const fields = columns.map((c) => {
        let zodType = mapSqlTypeToZod(decidableType(c));
        if (c.nullable) zodType += ".nullable()";
        return `  ${tsFieldKey(c.name)}: ${zodType},`;
      });
      return `import { z } from 'zod';\n\nexport const ${name}Schema = z.object({\n${fields.join("\n")}\n});\n\nexport type ${name} = z.infer<typeof ${name}Schema>;`;
    }
    case "prisma": {
      const fields = columns.map((c) => {
        const prismaType = mapSqlTypeToPrisma(decidableType(c));
        const nullable = c.nullable ? "?" : "";
        const pk = c.isPrimary ? " @id" : "";
        const auto = decidableType(c).toLowerCase().includes("serial") ? " @default(autoincrement())" : "";
        const mapped = prismaField(c.name);
        const map = mapped === c.name ? "" : ` @map("${stringLiteral(c.name)}")`;
        return `  ${mapped}  ${prismaType}${nullable}${pk}${auto}${map}`;
      });
      return `model ${name} {\n${fields.join("\n")}\n\n  @@map("${objectSegment(table.path)}")\n}`;
    }
    case "go": {
      const fields = columns.map((c) => {
        const goType = mapSqlTypeToGo(decidableType(c));
        const nullable = c.nullable ? "*" : "";
        return `\t${goFieldName(c.name)} ${nullable}${goType} \`json:"${c.name}" db:"${c.name}"\``;
      });
      // The import follows the MAPPED type, not the declared string: a container
      // the classifier cannot see into (Cassandra's `list<timestamp>`, ClickHouse's
      // `Tuple(DateTime, Int32)`) maps to `[]interface{}` and `map[string]interface{}`,
      // and an import decided from the raw text was emitted beside a type that never
      // uses it, which `go build` refuses (#1446 review).
      const needsTime = columns.some((c) => mapSqlTypeToGo(decidableType(c)).includes("time.Time"));
      const imports = needsTime ? '\nimport "time"\n' : "";
      return `package models${imports}\n\ntype ${name} struct {\n${fields.join("\n")}\n}`;
    }
    case "python": {
      const fields = columns.map((c) => {
        const pyType = mapSqlTypeToPython(decidableType(c));
        const optional = c.nullable ? `Optional[${pyType}]` : pyType;
        const styled = toSnakeCase(c.name);
        if (PYTHON_IDENTIFIER.test(styled)) return `    ${styled}: ${optional}`;
        const sanitised = toSnakeCase(fieldIdentifier(c.name));
        return `    ${sanitised}: ${optional} = field(metadata={"alias": "${stringLiteral(c.name)}"})`;
      });
      const aliased = columns.some((c) => !PYTHON_IDENTIFIER.test(toSnakeCase(c.name)));
      const needsOptional = columns.some((c) => c.nullable);
      // Mapped type, for the same reason as Go's `time` import above.
      const needsDatetime = columns.some((c) => mapSqlTypeToPython(decidableType(c)).includes("datetime"));
      const imports: string[] = [`from dataclasses import ${aliased ? "dataclass, field" : "dataclass"}`];
      if (needsOptional) imports.push("from typing import Optional");
      if (needsDatetime) imports.push("from datetime import datetime");
      return `${imports.join("\n")}\n\n\n@dataclass\nclass ${name}:\n${fields.join("\n")}`;
    }
    case "java": {
      const fields = columns.map((c) => {
        const javaType = mapSqlTypeToJava(decidableType(c));
        const styled = toCamelCase(c.name);
        if (IDENTIFIER.test(styled)) return `    private ${javaType} ${styled};`;
        return `    @JsonProperty("${stringLiteral(c.name)}")\n    private ${javaType} ${javaFieldName(c.name)};`;
      });
      // Mapped type, like Go's `time` and Python's `datetime` above, and like
      // `needsMap` already was: a container that maps to `Object[]` or
      // `Map<String, Object>` names no LocalDateTime, whatever its element text.
      const needsLocalDateTime = columns.some((c) => mapSqlTypeToJava(decidableType(c)).includes("LocalDateTime"));
      const needsMap = columns.some((c) => mapSqlTypeToJava(decidableType(c)).startsWith("Map<"));
      const needsJsonProperty = columns.some((c) => !IDENTIFIER.test(toCamelCase(c.name)));
      const imports: string[] = [];
      if (needsJsonProperty) imports.push("import com.fasterxml.jackson.annotation.JsonProperty;");
      if (needsLocalDateTime) imports.push("import java.time.LocalDateTime;");
      if (needsMap) imports.push("import java.util.Map;");
      const importBlock = imports.length > 0 ? `${imports.join("\n")}\n\n` : "";
      return `${importBlock}public class ${name} {\n${fields.join("\n")}\n}`;
    }
  }
}

export function CodeGenerator({ isOpen, onClose, tablePath, tableSchema, databaseType }: CodeGeneratorProps) {
  // Display only, and the qualified spelling rather than the last segment: two objects can
  // carry one label, so a header reading `customers` cannot say which one this is.
  const tableName = objectPathLabel(tablePath);
  const [language, setLanguage] = useState<Language>("typescript");
  const [showLangDropdown, setShowLangDropdown] = useState(false);

  const code = useMemo(() => {
    if (!tableSchema) return "// No schema available";
    return generateCode(language, tableSchema);
  }, [language, tableSchema]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const currentLang = LANGUAGES.find((l) => l.id === language)!;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-overlay border border-hairline-strong rounded-xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-hairline">
          <div className="flex items-center gap-2">
            <Code strokeWidth={1.5} className="w-3.5 h-3.5 text-hue-purple" />
            <span className="text-xs font-medium text-fg">Code Generator</span>
            <span className="text-xs text-fg-muted font-mono">{tableName}</span>
            {databaseType && <span className="text-xs text-fg-subtle font-mono uppercase">{databaseType}</span>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="p-1 rounded hover:bg-fill text-fg-muted"
          >
            <X strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-5 py-2 border-b border-hairline bg-surface">
          <div className="relative">
            <button
              onClick={() => setShowLangDropdown(!showLangDropdown)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-fill border border-hairline-strong text-xs text-fg-secondary hover:bg-fill-strong transition-colors"
            >
              {currentLang.label}
              <ChevronDown strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
            </button>
            {showLangDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-overlay border border-hairline-strong rounded-lg shadow-xl z-10 py-1 w-48">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.id}
                    onClick={() => {
                      setLanguage(lang.id);
                      setShowLangDropdown(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs hover:bg-fill transition-colors",
                      language === lang.id ? "text-hue-purple" : "text-fg-tertiary",
                    )}
                  >
                    {lang.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="relative">
          <pre className="p-5 text-xs font-mono text-fg-secondary overflow-auto max-h-[50vh] bg-canvas leading-relaxed whitespace-pre">
            {code}
          </pre>
          {/*
            `CopyButton` rather than a local `copied` flag (B43): the flag flipped in the
            same statement that started the write, which reads "Copied!" over an empty
            clipboard wherever `navigator.clipboard` is absent — plain HTTP off loopback,
            which several distribution channels are.
          */}
          <CopyButton
            text={code}
            testId="code-generator-copy"
            className="absolute top-3 right-3 gap-1.5 px-2.5 py-1 rounded-lg bg-fill-strong hover:bg-edge text-xs"
          />
        </div>

        <div className="px-5 py-3 border-t border-hairline bg-surface">
          <p className="text-xs text-fg-subtle">
            Generated from <span className="text-fg-muted">{tableName}</span> • {tableSchema?.columns?.length || 0}{" "}
            columns • {currentLang.ext} format
          </p>
        </div>
      </div>
    </div>
  );
}
