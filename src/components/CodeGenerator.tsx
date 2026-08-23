"use client";

import React, { useState, useMemo } from "react";
import { Code, X, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/copy-button";
import { TableSchema } from "@/lib/types";

interface CodeGeneratorProps {
  isOpen: boolean;
  onClose: () => void;
  tableName: string;
  tableSchema: TableSchema | null;
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
  return str
    .replace(/[_-](\w)/g, (_, c) => c.toUpperCase())
    .replace(/^\w/, (c) => c.toUpperCase())
    .replace(/s$/, ""); // Remove trailing 's' (pluralized table name)
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
 */
export function toIdentifier(str: string): string {
  // The trim is `^_|_$`, not `^_+|_+$`: the collapse above has already reduced
  // every run of separators to ONE underscore, so a repeated quantifier here can
  // never match more — it only adds the backtracking that makes the pattern
  // super-linear on a long run of separators (SonarCloud S5852).
  const result = toPascalCase(str.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, ""));
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

export function mapSqlTypeToTS(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (
    t.includes("int") ||
    t.includes("float") ||
    t.includes("double") ||
    t.includes("decimal") ||
    t.includes("numeric") ||
    t.includes("real") ||
    t.includes("serial")
  )
    return "number";
  if (t.includes("bool")) return "boolean";
  if (t.includes("date") || t.includes("time")) return "Date";
  if (t.includes("json")) return "Record<string, unknown>";
  if (t.includes("uuid")) return "string";
  if (t.includes("array")) return "unknown[]";
  return "string";
}

export function mapSqlTypeToZod(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (
    t.includes("int") ||
    t.includes("float") ||
    t.includes("double") ||
    t.includes("decimal") ||
    t.includes("numeric") ||
    t.includes("real") ||
    t.includes("serial")
  )
    return "z.number()";
  if (t.includes("bool")) return "z.boolean()";
  if (t.includes("date") || t.includes("time")) return "z.date()";
  if (t.includes("json")) return "z.record(z.unknown())";
  if (t.includes("uuid")) return "z.string().uuid()";
  return "z.string()";
}

export function mapSqlTypeToPrisma(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (t.includes("serial") || t === "integer" || t === "int" || t === "int4") return "Int";
  if (t.includes("bigint") || t.includes("int8")) return "BigInt";
  if (
    t.includes("float") ||
    t.includes("double") ||
    t.includes("decimal") ||
    t.includes("numeric") ||
    t.includes("real")
  )
    return "Float";
  if (t.includes("bool")) return "Boolean";
  if (t.includes("timestamp") || t.includes("datetime")) return "DateTime";
  if (t.includes("date")) return "DateTime";
  if (t.includes("json")) return "Json";
  return "String";
}

export function mapSqlTypeToGo(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (t.includes("serial") || t === "integer" || t === "int" || t === "int4") return "int";
  if (t.includes("bigint") || t.includes("int8")) return "int64";
  if (t.includes("float") || t.includes("real")) return "float32";
  if (t.includes("double") || t.includes("decimal") || t.includes("numeric")) return "float64";
  if (t.includes("bool")) return "bool";
  if (t.includes("date") || t.includes("time")) return "time.Time";
  return "string";
}

export function mapSqlTypeToPython(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (t.includes("int") || t.includes("serial")) return "int";
  if (
    t.includes("float") ||
    t.includes("double") ||
    t.includes("decimal") ||
    t.includes("numeric") ||
    t.includes("real")
  )
    return "float";
  if (t.includes("bool")) return "bool";
  if (t.includes("date") || t.includes("time")) return "datetime";
  if (t.includes("json")) return "dict";
  return "str";
}

export function mapSqlTypeToJava(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (t.includes("serial") || t === "integer" || t === "int" || t === "int4") return "Integer";
  if (t.includes("bigint") || t.includes("int8")) return "Long";
  if (t.includes("float") || t.includes("real")) return "Float";
  if (t.includes("double") || t.includes("decimal") || t.includes("numeric")) return "Double";
  if (t.includes("bool")) return "Boolean";
  if (t.includes("date") || t.includes("time")) return "LocalDateTime";
  return "String";
}

export function generateCode(lang: Language, table: TableSchema): string {
  const name = toIdentifier(table.name);
  const columns = table.columns || [];

  switch (lang) {
    case "typescript": {
      const fields = columns.map((c) => {
        const tsType = mapSqlTypeToTS(c.type);
        const nullable = c.nullable ? " | null" : "";
        return `  ${toCamelCase(c.name)}: ${tsType}${nullable};`;
      });
      return `export interface ${name} {\n${fields.join("\n")}\n}`;
    }
    case "zod": {
      const fields = columns.map((c) => {
        let zodType = mapSqlTypeToZod(c.type);
        if (c.nullable) zodType += ".nullable()";
        return `  ${toCamelCase(c.name)}: ${zodType},`;
      });
      return `import { z } from 'zod';\n\nexport const ${name}Schema = z.object({\n${fields.join("\n")}\n});\n\nexport type ${name} = z.infer<typeof ${name}Schema>;`;
    }
    case "prisma": {
      const fields = columns.map((c) => {
        const prismaType = mapSqlTypeToPrisma(c.type);
        const nullable = c.nullable ? "?" : "";
        const pk = c.isPrimary ? " @id" : "";
        const auto = c.type.toLowerCase().includes("serial") ? " @default(autoincrement())" : "";
        return `  ${c.name}  ${prismaType}${nullable}${pk}${auto}`;
      });
      return `model ${name} {\n${fields.join("\n")}\n\n  @@map("${table.name}")\n}`;
    }
    case "go": {
      const fields = columns.map((c) => {
        const goType = mapSqlTypeToGo(c.type);
        const nullable = c.nullable ? "*" : "";
        const fieldName = toPascalCase(c.name);
        return `\t${fieldName} ${nullable}${goType} \`json:"${c.name}" db:"${c.name}"\``;
      });
      const needsTime = columns.some(
        (c) => c.type.toLowerCase().includes("date") || c.type.toLowerCase().includes("time"),
      );
      const imports = needsTime ? '\nimport "time"\n' : "";
      return `package models${imports}\n\ntype ${name} struct {\n${fields.join("\n")}\n}`;
    }
    case "python": {
      const fields = columns.map((c) => {
        const pyType = mapSqlTypeToPython(c.type);
        const optional = c.nullable ? `Optional[${pyType}]` : pyType;
        return `    ${toSnakeCase(c.name)}: ${optional}`;
      });
      const needsOptional = columns.some((c) => c.nullable);
      const needsDatetime = columns.some(
        (c) => c.type.toLowerCase().includes("date") || c.type.toLowerCase().includes("time"),
      );
      const imports: string[] = ["from dataclasses import dataclass"];
      if (needsOptional) imports.push("from typing import Optional");
      if (needsDatetime) imports.push("from datetime import datetime");
      return `${imports.join("\n")}\n\n\n@dataclass\nclass ${name}:\n${fields.join("\n")}`;
    }
    case "java": {
      const fields = columns.map((c) => {
        const javaType = mapSqlTypeToJava(c.type);
        return `    private ${javaType} ${toCamelCase(c.name)};`;
      });
      const needsLocalDateTime = columns.some(
        (c) => c.type.toLowerCase().includes("date") || c.type.toLowerCase().includes("time"),
      );
      const imports = needsLocalDateTime ? "import java.time.LocalDateTime;\n\n" : "";
      return `${imports}public class ${name} {\n${fields.join("\n")}\n}`;
    }
  }
}

export function CodeGenerator({ isOpen, onClose, tableName, tableSchema, databaseType }: CodeGeneratorProps) {
  const [language, setLanguage] = useState<Language>("typescript");
  const [showLangDropdown, setShowLangDropdown] = useState(false);

  const code = useMemo(() => {
    if (!tableSchema) return "// No schema available";
    return generateCode(language, tableSchema);
  }, [language, tableSchema]);

  if (!isOpen) return null;

  const currentLang = LANGUAGES.find((l) => l.id === language)!;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-overlay border border-hairline-strong rounded-xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-hairline">
          <div className="flex items-center gap-2">
            <Code strokeWidth={1.5} className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-xs font-medium text-fg">Code Generator</span>
            <span className="text-xs text-fg-muted font-mono">{tableName}</span>
            {databaseType && <span className="text-xs text-fg-subtle font-mono uppercase">{databaseType}</span>}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-fill text-fg-muted">
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
                      language === lang.id ? "text-purple-400" : "text-fg-tertiary",
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
