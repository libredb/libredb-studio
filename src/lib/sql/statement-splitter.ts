/**
 * SQL Statement Splitter
 * Splits a multi-statement SQL string into individual statements,
 * correctly handling string literals, comments, and dollar-quoted strings (PostgreSQL).
 */

export interface SplitStatement {
  sql: string;
  /** 0-based line number where this statement starts in the original text */
  startLine: number;
}

export function splitStatements(input: string): SplitStatement[] {
  const statements: SplitStatement[] = [];
  let current = '';
  let i = 0;
  let statementStartLine = 0;
  let currentLine = 0;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    // Track line numbers
    if (ch === '\n') {
      currentLine++;
    }

    // Single-line comment: -- ...
    if (ch === '-' && next === '-') {
      const lineEnd = input.indexOf('\n', i);
      if (lineEnd === -1) {
        current += input.slice(i);
        i = input.length;
      } else {
        current += input.slice(i, lineEnd + 1);
        currentLine++; // the \n
        i = lineEnd + 1;
      }
      continue;
    }

    // Multi-line comment: /* ... */
    if (ch === '/' && next === '*') {
      const commentEnd = input.indexOf('*/', i + 2);
      if (commentEnd === -1) {
        current += input.slice(i);
        i = input.length;
      } else {
        const commentBlock = input.slice(i, commentEnd + 2);
        // Count newlines in comment
        for (const c of commentBlock) {
          if (c === '\n') currentLine++;
        }
        current += commentBlock;
        i = commentEnd + 2;
      }
      continue;
    }

    // Single-quoted string: '...' with '' escape
    if (ch === "'") {
      let j = i + 1;
      current += "'";
      while (j < input.length) {
        if (input[j] === '\n') currentLine++;
        if (input[j] === "'" && input[j + 1] === "'") {
          current += "''";
          j += 2;
        } else if (input[j] === "'") {
          current += "'";
          j++;
          break;
        } else {
          current += input[j];
          j++;
        }
      }
      i = j;
      continue;
    }

    // Double-quoted identifier: "..."
    if (ch === '"') {
      let j = i + 1;
      current += '"';
      while (j < input.length) {
        if (input[j] === '\n') currentLine++;
        if (input[j] === '"' && input[j + 1] === '"') {
          current += '""';
          j += 2;
        } else if (input[j] === '"') {
          current += '"';
          j++;
          break;
        } else {
          current += input[j];
          j++;
        }
      }
      i = j;
      continue;
    }

    // PostgreSQL dollar-quoted string: $tag$...$tag$
    if (ch === '$') {
      const dollarMatch = input.slice(i).match(/^\$([A-Za-z_]*)\$/);
      if (dollarMatch) {
        const tag = dollarMatch[0]; // e.g. $$ or $func$
        const endIdx = input.indexOf(tag, i + tag.length);
        if (endIdx === -1) {
          // No closing tag — consume rest
          const rest = input.slice(i);
          for (const c of rest) {
            if (c === '\n') currentLine++;
          }
          current += rest;
          i = input.length;
        } else {
          const block = input.slice(i, endIdx + tag.length);
          for (const c of block) {
            if (c === '\n') currentLine++;
          }
          current += block;
          i = endIdx + tag.length;
        }
        continue;
      }
    }

    // Semicolon — statement boundary
    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push({ sql: trimmed, startLine: statementStartLine });
      }
      current = '';
      i++;
      // Skip whitespace to find next statement start
      while (i < input.length && /\s/.test(input[i])) {
        if (input[i] === '\n') currentLine++;
        i++;
      }
      statementStartLine = currentLine;
      continue;
    }

    // Regular character
    current += ch;
    i++;
  }

  // Remaining content
  const trimmed = current.trim();
  if (trimmed.length > 0) {
    statements.push({ sql: trimmed, startLine: statementStartLine });
  }

  return statements;
}

/**
 * Check if input contains multiple statements
 */
export function isMultiStatement(input: string): boolean {
  return splitStatements(input).length > 1;
}
