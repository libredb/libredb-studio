/**
 * Where a dialect's own confirmation forms (`SqlGrammar.confirmForms`, `confirmFormsWhen` and `confirmCodeForms`) are
 * found in a statement's code.
 *
 * The confirmation gate (`isDangerousQuery`) reads them, and so does an EXPLAIN strategy that must never send a
 * statement the gate would ask about: Snowflake's compiler evaluates a `SYSTEM$` function while it explains the
 * statement (SF-001), so its strategy declines whatever these forms find. One reading for both, so the gate and the
 * strategy cannot drift apart.
 *
 * Forms found anywhere in the code are looked up in one reading of the text's code words (`indexCodeWords`), and the
 * word sequences of one list are compared as a tree, so the words after a code word that starts thirty forms are read
 * once. A walk of the text for every form, and a reading of the words after every code word for every form, made a
 * 1,000,000-unit Snowflake block cost seconds.
 */

import type { ConfirmCodeForm, SqlGrammar } from "@/lib/sql/grammar";
import { ParenthesisedRuns } from "@/lib/sql/parenthesised";
import { readSqlSpan } from "@/lib/sql/spans";
import { type CodeWordIndex, type CodeWordQuery, findCodeWord, indexCodeWords, readSqlWord } from "@/lib/sql/words";

/** The code word after `from`, past whitespace and comments, or `null` when the next code is not a word. */
function nextCodeWord(text: string, from: number, grammar: SqlGrammar): { word: string; end: number } | null {
  let i = from;
  for (;;) {
    const span = readSqlSpan(text, i, grammar);
    if (
      span === null ||
      (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment")
    ) {
      break;
    }
    i = span.end;
  }
  const found = readSqlWord(text, i);
  return found === null ? null : { word: found.text, end: found.end };
}

/**
 * Keyword sequences as one tree of their words, each upper-cased as `readSqlWord` reports a word. A sequence ends at a
 * node that `ends`, or, for a form of `confirmFormsWhen`, at a node whose `whens` hold the code word that has to follow
 * it for the form to ask.
 */
export interface FormTree {
  readonly ends: boolean;
  readonly whens: readonly string[];
  readonly next: ReadonlyMap<string, FormTree>;
}

interface FormNode extends FormTree {
  ends: boolean;
  readonly whens: string[];
  readonly next: Map<string, FormNode>;
}

function formNode(): FormNode {
  return { ends: false, whens: [], next: new Map() };
}

/** The node `words` lead to from `root`, made where missing. */
function nodeOf(root: FormNode, words: readonly string[]): FormNode {
  let node = root;
  for (const word of words) {
    const key = word.toUpperCase();
    let child = node.next.get(key);
    if (child === undefined) {
      child = formNode();
      node.next.set(key, child);
    }
    node = child;
  }
  return node;
}

/** A `confirmCodeForms` entry that is neither a word sequence nor a quoted name called as a function. */
type CodeForm = Exclude<ConfirmCodeForm, readonly string[] | { readonly quotedCall: string }>;

/**
 * A grammar's forms, compiled once per grammar record, which is a constant: its word sequences as trees, the names of
 * its quoted calls lower-cased as one set, its other code forms with each word upper-cased as it is compared, and the
 * query that finds them all.
 */
interface GrammarForms {
  readonly operating: FormTree;
  readonly exempt: FormTree;
  readonly codeSequences: FormTree;
  readonly quotedCalls: ReadonlySet<string>;
  readonly codeForms: readonly CodeForm[];
  readonly query: CodeWordQuery;
}

const GRAMMAR_FORMS = new WeakMap<SqlGrammar, GrammarForms>();

function isSequence(form: ConfirmCodeForm): form is readonly string[] {
  return Array.isArray(form);
}

function grammarForms(grammar: SqlGrammar): GrammarForms {
  const known = GRAMMAR_FORMS.get(grammar);
  if (known !== undefined) return known;

  const operating = formNode();
  for (const form of grammar.confirmForms ?? []) nodeOf(operating, form).ends = true;
  for (const form of grammar.confirmFormsWhen ?? []) nodeOf(operating, form.form).whens.push(form.when.toUpperCase());
  const exempt = formNode();
  for (const form of grammar.confirmExemptForms ?? []) nodeOf(exempt, form).ends = true;
  const codeSequences = formNode();
  const quotedCalls = new Set<string>();
  const codeForms: CodeForm[] = [];
  const words = new Set([...operating.next.keys()]);
  const prefixes = new Set<string>();
  let quotedIdentifiers = false;
  for (const form of grammar.confirmFormsWhen ?? []) words.add(form.when.toUpperCase());
  for (const form of grammar.confirmCodeForms ?? []) {
    if (isSequence(form)) {
      nodeOf(codeSequences, form).ends = true;
      words.add(form[0].toUpperCase());
    } else if ("prefix" in form) {
      codeForms.push({ prefix: form.prefix.toUpperCase() });
      prefixes.add(form.prefix.toUpperCase());
      quotedIdentifiers = true;
    } else if ("wordThenLiteral" in form) {
      codeForms.push({ wordThenLiteral: form.wordThenLiteral.toUpperCase() });
      words.add(form.wordThenLiteral.toUpperCase());
    } else if ("wordThenBody" in form) {
      codeForms.push({ wordThenBody: form.wordThenBody.toUpperCase() });
      words.add(form.wordThenBody.toUpperCase());
    } else if ("quotedCall" in form) {
      quotedCalls.add(form.quotedCall.toLowerCase());
      quotedIdentifiers = true;
    } else if ("computedCall" in form) {
      codeForms.push({ computedCall: form.computedCall.toUpperCase() });
      words.add(form.computedCall.toUpperCase());
    } else {
      codeForms.push(form);
    }
  }

  const query = { words, prefixes: [...prefixes], quotedIdentifiers };
  const forms = { operating, exempt, codeSequences, quotedCalls, codeForms, query };
  GRAMMAR_FORMS.set(grammar, forms);
  return forms;
}

/** `confirmForms` and `confirmFormsWhen`, the forms that ask where they operate a statement, as one tree. */
export function operatingForms(grammar: SqlGrammar): FormTree {
  return grammarForms(grammar).operating;
}

/** `confirmExemptForms`, as one tree. */
export function exemptForms(grammar: SqlGrammar): FormTree {
  return grammarForms(grammar).exempt;
}

/** The code words, prefixes and quoted names every form of `grammar` is found by, for `indexCodeWords`. */
export function confirmFormQuery(grammar: SqlGrammar): CodeWordQuery {
  return grammarForms(grammar).query;
}

/**
 * Whether a form of `tree` operates at the code word `first` that ends at `end`: its other words follow, and a
 * `confirmFormsWhen` form's `when` word is in the code after `end`. That word is looked for with `findCodeWord`, from
 * `end` itself, which can be a position the walk of `indexCodeWords` does not stand on: the end of a keyword read past
 * a `#` comment the dialect does not have.
 */
export function formOperates(tree: FormTree, first: string, text: string, end: number, grammar: SqlGrammar): boolean {
  let node = tree.next.get(first);
  let at = end;
  while (node !== undefined) {
    if (node.ends) return true;
    if (node.whens.some((when) => findCodeWord(text, when, end, grammar) !== null)) return true;
    const next = nextCodeWord(text, at, grammar);
    if (next === null) return false;
    node = node.next.get(next.word);
    at = next.end;
  }
  return false;
}

/**
 * Whether a form of `tree` appears anywhere in the code of `text`, read from `code`, which has to know every first word
 * of `tree` and every `when` word: the form's other words follow a code occurrence of its first word, and a
 * `confirmFormsWhen` form's `when` word is in the code after that occurrence.
 *
 * Only a `confirmFormsWhen` form's first occurrence is asked about its `when` word: every later occurrence ends further
 * along the same walk, so a `when` word missing after the first is missing after them too.
 */
export function formInCode(tree: FormTree, text: string, grammar: SqlGrammar, code: CodeWordIndex): boolean {
  const decided = new Set<FormTree>();
  for (const [first, start] of tree.next) {
    for (const found of code.occurrences(first)) {
      let node: FormTree | undefined = start;
      let at = found.end;
      while (node !== undefined) {
        if (node.ends) return true;
        if (node.whens.length > 0 && !decided.has(node)) {
          decided.add(node);
          if (node.whens.some((when) => code.find(when, found.end) !== null)) return true;
        }
        const next = nextCodeWord(text, at, grammar);
        if (next === null) break;
        node = node.next.get(next.word);
        at = next.end;
      }
    }
  }
  return false;
}

/** The index of the `(` that the next code after `from` is, past whitespace and comments, or -1 when it is none. */
function callOpenAt(text: string, from: number, grammar: SqlGrammar): number {
  let i = from;
  for (let span = readSqlSpan(text, i, grammar); span !== null; span = readSqlSpan(text, i, grammar)) {
    if (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment") return -1;
    i = span.end;
  }
  return text[i] === "(" ? i : -1;
}

/** Whether the next code after `from`, past whitespace and comments, is `(`. */
function callFollows(text: string, from: number, grammar: SqlGrammar): boolean {
  return callOpenAt(text, from, grammar) !== -1;
}

/**
 * Whether a code word of `text` starts with `target`, an upper-cased prefix, compared case-insensitively, or a quoted
 * name called as a function does, compared exactly: a quoted upper-case name resolves as the bare one, and a quoted
 * name is case-sensitive, so `"SYSTEM$WAIT"(10)` is the bare call and `"system$wait"(10)` is another function.
 */
function prefixInCode(text: string, target: string, grammar: SqlGrammar, code: CodeWordIndex): boolean {
  return (
    code.startsWith(target) ||
    code
      .quotedIdentifiers()
      .some(
        (name) => text.slice(name.start + 1, name.end - 1).startsWith(target) && callFollows(text, name.end, grammar),
      )
  );
}

/**
 * Whether the next code after `from`, past whitespace and comments, opens a string literal: a `string` span (a raw
 * string included) or a run opened by `"`, which Spark reads as a string unless two ANSI settings are both on. A
 * dollar-quoted run, a backtick name, a `(` or a word does not count.
 */
function literalFollows(text: string, from: number, grammar: SqlGrammar): boolean {
  let i = from;
  for (let span = readSqlSpan(text, i, grammar); span !== null; span = readSqlSpan(text, i, grammar)) {
    if (span.kind === "string") return true;
    if (span.kind === "quoted-identifier") return text[i] === '"';
    if (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment") return false;
    i = span.end;
  }
  return false;
}

/**
 * Whether the next code after `from`, past whitespace and comments, opens a routine body: a string literal or a
 * dollar-quoted run, the two forms PostgreSQL takes a `DO` block's code in. A word, a quoted name or a `(` does not.
 */
function bodyFollows(text: string, from: number, grammar: SqlGrammar): boolean {
  let i = from;
  for (let span = readSqlSpan(text, i, grammar); span !== null; span = readSqlSpan(text, i, grammar)) {
    if (span.kind === "string" || span.kind === "dollar-string") return true;
    if (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment") return false;
    i = span.end;
  }
  return false;
}

/**
 * Whether a code occurrence of `word`, upper-cased, is followed by what `follows` looks for (`literalFollows`,
 * `bodyFollows`).
 */
function wordThenInCode(
  text: string,
  word: string,
  follows: (text: string, from: number, grammar: SqlGrammar) => boolean,
  grammar: SqlGrammar,
  code: CodeWordIndex,
): boolean {
  return code.occurrences(word).some((found) => follows(text, found.end, grammar));
}

/**
 * Whether a closed quoted name whose text is one of `names`, lower-cased, compared without case, is called: a `(`
 * follows it past whitespace and comments. Spark resolves a function name without case, quoted or not, so
 * `` `Reflect`(1) `` calls `reflect`.
 */
function quotedCallInCode(text: string, names: ReadonlySet<string>, grammar: SqlGrammar, code: CodeWordIndex): boolean {
  return code
    .quotedIdentifiers()
    .some(
      (quoted) =>
        names.has(text.slice(quoted.start + 1, quoted.end - 1).toLowerCase()) && callFollows(text, quoted.end, grammar),
    );
}

/**
 * Whether a code occurrence of `word`, upper-cased, is followed, past whitespace and comments, by a parenthesised run
 * and then a `(`: a call whose function name the run computes, as Spark's `IDENTIFIER('f')(1)` is, which the gate
 * cannot read. Literals, quoted names and comments inside the run are read whole, so a `)` written in one closes
 * nothing. Where each run closes is remembered, so a run nested in another one's is crossed once.
 */
function computedCallInCode(text: string, word: string, grammar: SqlGrammar, code: CodeWordIndex): boolean {
  let runs: ParenthesisedRuns | undefined;
  return code.occurrences(word).some((found) => {
    const open = callOpenAt(text, found.end, grammar);
    if (open === -1) return false;
    runs ??= new ParenthesisedRuns(text, grammar, "characters");
    const end = runs.closeOf(open);
    return end !== -1 && callFollows(text, end, grammar);
  });
}

/**
 * Whether a dollar-quoted run (`$$...$$`, `$tag$...$tag$`) opens at a code position of `text`, the span reader asked at
 * each character as `hasUnterminatedSpan` asks it: Spark's names hold no `$`, so a `$$` right after a name's letters
 * opens a run there too. A run that never closes counts as well.
 */
function dollarQuotedInCode(text: string, grammar: SqlGrammar): boolean {
  let i = 0;
  while (i < text.length) {
    const span = readSqlSpan(text, i, grammar);
    if (span === null) i++;
    else if (span.kind === "dollar-string") return true;
    else i = span.end;
  }
  return false;
}

/** Whether `form`, cased as `GrammarForms` holds it, appears in the code of `text`. */
function codeFormInText(text: string, form: CodeForm, grammar: SqlGrammar, code: CodeWordIndex): boolean {
  if ("prefix" in form) return prefixInCode(text, form.prefix, grammar, code);
  if ("wordThenLiteral" in form) return wordThenInCode(text, form.wordThenLiteral, literalFollows, grammar, code);
  if ("wordThenBody" in form) return wordThenInCode(text, form.wordThenBody, bodyFollows, grammar, code);
  if ("computedCall" in form) return computedCallInCode(text, form.computedCall, grammar, code);
  return dollarQuotedInCode(text, grammar);
}

/**
 * Whether any of `grammar`'s `confirmCodeForms` appears in the code of `text`; a grammar without them has none. `code`
 * is the text's code words as `indexCodeWords` read them for a query that holds `confirmFormQuery(grammar)`, which a
 * caller that already read them passes rather than have them read again.
 */
export function hasConfirmCodeForm(
  text: string,
  grammar: SqlGrammar,
  code: CodeWordIndex = indexCodeWords(text, confirmFormQuery(grammar), grammar),
): boolean {
  const forms = grammarForms(grammar);
  if (formInCode(forms.codeSequences, text, grammar, code)) return true;
  if (forms.quotedCalls.size > 0 && quotedCallInCode(text, forms.quotedCalls, grammar, code)) return true;
  return forms.codeForms.some((form) => codeFormInText(text, form, grammar, code));
}
