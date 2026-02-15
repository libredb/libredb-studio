/**
 * MongoDB / JSON Completion Provider for Monaco Editor
 *
 * Pure utility module (no React) that registers MQL operator, operation,
 * collection, field, and snippet completions for the JSON language.
 */

import type * as Monaco from 'monaco-editor';
import type { SchemaCompletionCache } from './sql-completions';

// ---------------------------------------------------------------------------
// Static constants
// ---------------------------------------------------------------------------

const MQL_OPERATORS = [
  '$match', '$group', '$sort', '$project', '$lookup', '$unwind', '$limit', '$skip',
  '$addFields', '$count', '$facet', '$bucket', '$merge', '$out', '$replaceRoot',
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$and', '$or', '$not', '$nor',
  '$exists', '$type', '$regex', '$text', '$where', '$all', '$elemMatch', '$size',
  '$set', '$unset', '$inc', '$push', '$pull', '$addToSet', '$pop', '$rename',
  '$sum', '$avg', '$min', '$max', '$first', '$last',
];

const MONGO_OPERATIONS = [
  'find', 'findOne', 'aggregate', 'count', 'distinct',
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
];

const MONGO_SNIPPETS: { label: string; template: string; detail: string }[] = [
  {
    label: 'find',
    template: JSON.stringify({ collection: '${1:collection}', operation: 'find', filter: {}, options: { limit: 50 } }, null, 2),
    detail: 'Find documents',
  },
  {
    label: 'findOne',
    template: JSON.stringify({ collection: '${1:collection}', operation: 'findOne', filter: { _id: '${2:id}' } }, null, 2),
    detail: 'Find single document',
  },
  {
    label: 'aggregate',
    template: JSON.stringify({ collection: '${1:collection}', operation: 'aggregate', pipeline: [{ '$match': {} }, { '$group': { _id: '${2:field}', count: { '$sum': 1 } } }] }, null, 2),
    detail: 'Aggregation pipeline',
  },
  {
    label: 'count',
    template: JSON.stringify({ collection: '${1:collection}', operation: 'count', filter: {} }, null, 2),
    detail: 'Count documents',
  },
  {
    label: 'insertOne',
    template: JSON.stringify({ collection: '${1:collection}', operation: 'insertOne', documents: [{ '${2:field}': '${3:value}' }] }, null, 2),
    detail: 'Insert one document',
  },
  {
    label: 'updateOne',
    template: JSON.stringify({ collection: '${1:collection}', operation: 'updateOne', filter: { _id: '${2:id}' }, update: { '$set': { '${3:field}': '${4:value}' } } }, null, 2),
    detail: 'Update one document',
  },
  {
    label: 'deleteMany',
    template: JSON.stringify({ collection: '${1:collection}', operation: 'deleteMany', filter: { '${2:field}': '${3:value}' } }, null, 2),
    detail: 'Delete matching documents',
  },
];

// ---------------------------------------------------------------------------
// Registration function
// ---------------------------------------------------------------------------

/**
 * Registers the MongoDB/JSON completion item provider with Monaco.
 *
 * @param monaco  - The Monaco namespace
 * @param schemaCompletionCache - Pre-computed schema data for collection/field completions
 * @returns An `IDisposable` that should be called on cleanup.
 */
export function registerMongoDBCompletionProvider(
  monaco: typeof Monaco,
  schemaCompletionCache: SchemaCompletionCache,
): Monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider('json', {
    triggerCharacters: ['"', '$', ':'],
    provideCompletionItems: (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const line = model.getLineContent(position.lineNumber);
      const textBefore = line.substring(0, position.column - 1);
      const suggestions: Monaco.languages.CompletionItem[] = [];

      // After "$" -- MQL operators
      if (textBefore.includes('$') || word.word.startsWith('$')) {
        MQL_OPERATORS.forEach(op => {
          suggestions.push({
            label: op,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: op,
            range,
            detail: 'MQL Operator',
            sortText: '0' + op,
          });
        });
      }

      // After "operation": " -- operation names
      if (/"operation"\s*:\s*"[^"]*$/.test(textBefore)) {
        MONGO_OPERATIONS.forEach(op => {
          suggestions.push({
            label: op,
            kind: monaco.languages.CompletionItemKind.Enum,
            insertText: op,
            range,
            detail: 'MongoDB Operation',
            sortText: '0' + op,
          });
        });
      }

      // After "collection": " -- collection names from schema
      if (/"collection"\s*:\s*"[^"]*$/.test(textBefore)) {
        schemaCompletionCache.tableItems.forEach(table => {
          suggestions.push({
            label: table.label,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: table.label,
            range,
            detail: `Collection (${table.rowCount} docs)`,
            sortText: '0' + table.label,
          });
        });
      }

      // Field names inside filter/sort/projection
      if (/"[^"]*$/.test(textBefore) && !/"(collection|operation)"\s*:\s*"/.test(textBefore)) {
        schemaCompletionCache.allColumns.forEach((col, colName) => {
          suggestions.push({
            label: colName,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: colName,
            range,
            detail: `Field (${col.type})`,
            sortText: '2' + colName,
          });
        });
      }

      // Full template snippets -- when editor is mostly empty or at line start
      const fullText = model.getValue().trim();
      if (fullText.length < 5 || /^\s*$/.test(textBefore)) {
        MONGO_SNIPPETS.forEach(snippet => {
          suggestions.push({
            label: snippet.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: snippet.template,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            detail: snippet.detail,
            sortText: '1' + snippet.label,
          });
        });
      }

      return { suggestions };
    },
  });
}
