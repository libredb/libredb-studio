"use client";

import React, { useState, useMemo } from 'react';
import { Code, X, Copy, Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TableSchema } from '@/lib/types';

interface CodeGeneratorProps {
  isOpen: boolean;
  onClose: () => void;
  tableName: string;
  tableSchema: TableSchema | null;
  databaseType?: string;
}

type Language = 'typescript' | 'zod' | 'prisma' | 'go' | 'python' | 'java';

const LANGUAGES: { id: Language; label: string; ext: string }[] = [
  { id: 'typescript', label: 'TypeScript Interface', ext: 'ts' },
  { id: 'zod', label: 'Zod Schema', ext: 'ts' },
  { id: 'prisma', label: 'Prisma Model', ext: 'prisma' },
  { id: 'go', label: 'Go Struct', ext: 'go' },
  { id: 'python', label: 'Python Dataclass', ext: 'py' },
  { id: 'java', label: 'Java POJO', ext: 'java' },
];

export function toPascalCase(str: string): string {
  return str
    .replace(/[_-](\w)/g, (_, c) => c.toUpperCase())
    .replace(/^\w/, c => c.toUpperCase())
    .replace(/s$/, ''); // Remove trailing 's' (pluralized table name)
}

export function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export function toSnakeCase(str: string): string {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}

export function mapSqlTypeToTS(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (t.includes('int') || t.includes('float') || t.includes('double') || t.includes('decimal') || t.includes('numeric') || t.includes('real') || t.includes('serial')) return 'number';
  if (t.includes('bool')) return 'boolean';
  if (t.includes('date') || t.includes('time')) return 'Date';
  if (t.includes('json')) return 'Record<string, unknown>';
  if (t.includes('uuid')) return 'string';
  if (t.includes('array')) return 'unknown[]';
  return 'string';
}

export function mapSqlTypeToZod(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (t.includes('int') || t.includes('float') || t.includes('double') || t.includes('decimal') || t.includes('numeric') || t.includes('real') || t.includes('serial')) return 'z.number()';
  if (t.includes('bool')) return 'z.boolean()';
  if (t.includes('date') || t.includes('time')) return 'z.date()';
  if (t.includes('json')) return 'z.record(z.unknown())';
  if (t.includes('uuid')) return 'z.string().uuid()';
  return 'z.string()';
}

export function mapSqlTypeToPrisma(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (t.includes('serial') || t === 'integer' || t === 'int' || t === 'int4') return 'Int';
  if (t.includes('bigint') || t.includes('int8')) return 'BigInt';
  if (t.includes('float') || t.includes('double') || t.includes('decimal') || t.includes('numeric') || t.includes('real')) return 'Float';
  if (t.includes('bool')) return 'Boolean';
  if (t.includes('timestamp') || t.includes('datetime')) return 'DateTime';
  if (t.includes('date')) return 'DateTime';
  if (t.includes('json')) return 'Json';
  return 'String';
}

export function mapSqlTypeToGo(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (t.includes('serial') || t === 'integer' || t === 'int' || t === 'int4') return 'int';
  if (t.includes('bigint') || t.includes('int8')) return 'int64';
  if (t.includes('float') || t.includes('real')) return 'float32';
  if (t.includes('double') || t.includes('decimal') || t.includes('numeric')) return 'float64';
  if (t.includes('bool')) return 'bool';
  if (t.includes('date') || t.includes('time')) return 'time.Time';
  return 'string';
}

export function mapSqlTypeToPython(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (t.includes('int') || t.includes('serial')) return 'int';
  if (t.includes('float') || t.includes('double') || t.includes('decimal') || t.includes('numeric') || t.includes('real')) return 'float';
  if (t.includes('bool')) return 'bool';
  if (t.includes('date') || t.includes('time')) return 'datetime';
  if (t.includes('json')) return 'dict';
  return 'str';
}

export function mapSqlTypeToJava(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (t.includes('serial') || t === 'integer' || t === 'int' || t === 'int4') return 'Integer';
  if (t.includes('bigint') || t.includes('int8')) return 'Long';
  if (t.includes('float') || t.includes('real')) return 'Float';
  if (t.includes('double') || t.includes('decimal') || t.includes('numeric')) return 'Double';
  if (t.includes('bool')) return 'Boolean';
  if (t.includes('date') || t.includes('time')) return 'LocalDateTime';
  return 'String';
}

export function generateCode(lang: Language, table: TableSchema): string {
  const name = toPascalCase(table.name);
  const columns = table.columns || [];

  switch (lang) {
    case 'typescript': {
      const fields = columns.map(c => {
        const tsType = mapSqlTypeToTS(c.type);
        const nullable = c.nullable ? ' | null' : '';
        return `  ${toCamelCase(c.name)}: ${tsType}${nullable};`;
      });
      return `export interface ${name} {\n${fields.join('\n')}\n}`;
    }
    case 'zod': {
      const fields = columns.map(c => {
        let zodType = mapSqlTypeToZod(c.type);
        if (c.nullable) zodType += '.nullable()';
        return `  ${toCamelCase(c.name)}: ${zodType},`;
      });
      return `import { z } from 'zod';\n\nexport const ${name}Schema = z.object({\n${fields.join('\n')}\n});\n\nexport type ${name} = z.infer<typeof ${name}Schema>;`;
    }
    case 'prisma': {
      const fields = columns.map(c => {
        const prismaType = mapSqlTypeToPrisma(c.type);
        const nullable = c.nullable ? '?' : '';
        const pk = c.isPrimary ? ' @id' : '';
        const auto = c.type.toLowerCase().includes('serial') ? ' @default(autoincrement())' : '';
        return `  ${c.name}  ${prismaType}${nullable}${pk}${auto}`;
      });
      return `model ${name} {\n${fields.join('\n')}\n\n  @@map("${table.name}")\n}`;
    }
    case 'go': {
      const fields = columns.map(c => {
        const goType = mapSqlTypeToGo(c.type);
        const nullable = c.nullable ? '*' : '';
        const fieldName = toPascalCase(c.name);
        return `\t${fieldName} ${nullable}${goType} \`json:"${c.name}" db:"${c.name}"\``;
      });
      const needsTime = columns.some(c => c.type.toLowerCase().includes('date') || c.type.toLowerCase().includes('time'));
      const imports = needsTime ? '\nimport "time"\n' : '';
      return `package models${imports}\n\ntype ${name} struct {\n${fields.join('\n')}\n}`;
    }
    case 'python': {
      const fields = columns.map(c => {
        const pyType = mapSqlTypeToPython(c.type);
        const optional = c.nullable ? `Optional[${pyType}]` : pyType;
        return `    ${toSnakeCase(c.name)}: ${optional}`;
      });
      const needsOptional = columns.some(c => c.nullable);
      const needsDatetime = columns.some(c => c.type.toLowerCase().includes('date') || c.type.toLowerCase().includes('time'));
      const imports: string[] = ['from dataclasses import dataclass'];
      if (needsOptional) imports.push('from typing import Optional');
      if (needsDatetime) imports.push('from datetime import datetime');
      return `${imports.join('\n')}\n\n\n@dataclass\nclass ${name}:\n${fields.join('\n')}`;
    }
    case 'java': {
      const fields = columns.map(c => {
        const javaType = mapSqlTypeToJava(c.type);
        return `    private ${javaType} ${toCamelCase(c.name)};`;
      });
      const needsLocalDateTime = columns.some(c => c.type.toLowerCase().includes('date') || c.type.toLowerCase().includes('time'));
      const imports = needsLocalDateTime ? 'import java.time.LocalDateTime;\n\n' : '';
      return `${imports}public class ${name} {\n${fields.join('\n')}\n}`;
    }
  }
}

export function CodeGenerator({
  isOpen,
  onClose,
  tableName,
  tableSchema,
  databaseType,
}: CodeGeneratorProps) {
  const [language, setLanguage] = useState<Language>('typescript');
  const [copied, setCopied] = useState(false);
  const [showLangDropdown, setShowLangDropdown] = useState(false);

  const code = useMemo(() => {
    if (!tableSchema) return '// No schema available';
    return generateCode(language, tableSchema);
  }, [language, tableSchema]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  const currentLang = LANGUAGES.find(l => l.id === language)!;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#111] border border-white/10 rounded-xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <div className="flex items-center gap-2">
            <Code className="w-4 h-4 text-purple-400" />
            <span className="text-xs font-medium text-zinc-200">Code Generator</span>
            <span className="text-xs text-zinc-500 font-mono">{tableName}</span>
            {databaseType && (
              <span className="text-xs text-zinc-600 font-mono uppercase">{databaseType}</span>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/5 text-zinc-500">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Language Selector */}
        <div className="px-5 py-2 border-b border-white/5 bg-[#0a0a0a]">
          <div className="relative">
            <button
              onClick={() => setShowLangDropdown(!showLangDropdown)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-zinc-300 hover:bg-white/10 transition-colors"
            >
              {currentLang.label}
              <ChevronDown className="w-3 h-3 text-zinc-500" />
            </button>
            {showLangDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-[#111] border border-white/10 rounded-lg shadow-xl z-10 py-1 w-48">
                {LANGUAGES.map(lang => (
                  <button
                    key={lang.id}
                    onClick={() => { setLanguage(lang.id); setShowLangDropdown(false); }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors",
                      language === lang.id ? "text-purple-400" : "text-zinc-400"
                    )}
                  >
                    {lang.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Code Preview */}
        <div className="relative">
          <pre className="p-5 text-xs font-mono text-zinc-300 overflow-auto max-h-[50vh] bg-[#050505] leading-relaxed whitespace-pre">
            {code}
          </pre>
          <button
            onClick={handleCopy}
            className="absolute top-3 right-3 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-xs text-zinc-400 transition-colors"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-white/5 bg-[#0a0a0a]">
          <p className="text-xs text-zinc-600">
            Generated from <span className="text-zinc-500">{tableName}</span> • {tableSchema?.columns?.length || 0} columns • {currentLang.ext} format
          </p>
        </div>
      </div>
    </div>
  );
}
