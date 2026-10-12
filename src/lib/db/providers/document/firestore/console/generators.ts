/**
 * Statement text Studio writes itself (spec 5.4): the tree's preview and count and the Source tab's subcollection
 * queries, and the plan-mode sentence. Pure and browser-safe; every generated statement re-parses to its path.
 */
import { LIMITS } from "../constants";

// The plan-mode sentence lives in labels.ts (spec 3.1) and names one example (spec 7).
export { FIRESTORE_STATEMENT_LANGUAGE } from "../labels";

/** The one example the plan-mode sentence quotes, so this module's test can check that it parses. */
export const FIRESTORE_STATEMENT_EXAMPLES: readonly string[] = [
  'db.collection("users").where("age", ">=", 18).orderBy("age").limit(100)',
];

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};
const unicodeEscape = (code: number): string => `\\u${code.toString(16).padStart(4, "0")}`;

/** A double-quoted JavaScript string literal the console lexer reads back to exactly `value`. */
export function jsString(value: string): string {
  let out = '"';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    const code = value.charCodeAt(index);
    const pair = code >= 0xd800 && code <= 0xdbff && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00;
    if (char in NAMED_ESCAPES) {
      out += NAMED_ESCAPES[char];
    } else if (pair) {
      out += value.slice(index, index + 2);
      index++;
    } else if (
      code < 0x20 ||
      code === 0x7f ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      out += unicodeEscape(code);
    } else {
      out += char;
    }
  }
  return `${out}"`;
}

/** The tree's preview of a collection: `db.collection("<path>").limit(100)`. */
export function previewStatement(collectionPath: readonly string[]): string {
  return `db.collection(${jsString(collectionPath.join("/"))}).limit(${LIMITS.defaultQueryLimit})`;
}

/** The tree's count of a collection: `db.collection("<path>").count()`. */
export function countStatement(collectionPath: readonly string[]): string {
  return `db.collection(${jsString(collectionPath.join("/"))}).count()`;
}
