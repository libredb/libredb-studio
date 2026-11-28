/**
 * The agent's admission of one request in a statement language an engine declares as data, read from the language's
 * declared request form (`statementLanguageData.agent.request` of the engine's declaration) and from nothing else: one
 * engine-neutral admission for every such language, so core holds no reader of any of them.
 *
 * The form is answered in one fixed order, the first failing step answering its declared refusal:
 * 1. a text longer than `maxCharacters`, counted in UTF-16 code units as `String.length` counts them: `tooLong`;
 * 2. a blank text: `empty`;
 * 3. a text `JSON.parse` refuses, or whose value is no plain object (null, an array or a scalar): `notAnObject`;
 * 4. a key written twice in any object of the text, by any spelling JSON reads as the same key: `repeatedKey`;
 * 5. an own key outside the form's `keys`: `unknownKey`;
 * 6. with a selector, the read whose `value` is the selector key's own string value, or else the selector's refusal;
 * 7. each common check, in order;
 * 8. each key the read refuses, in order, where the request writes it;
 * 9. each check of the read, in order; and then the request is admitted.
 * A check answers its `absent` refusal for a key the request does not write, or passes where `absent` is null; for a
 * key it writes, the value rule answers. An enumeration admits a string among its values. An integer admits a JSON
 * number holding an integer within its range, so a JSON null is a wrong type and never the default, which no answer
 * applies. A name admits a well-formed string of `minLength` to `maxLength` code points, each within one of its
 * character ranges, and then answers the first refused group that lists the name or a prefix it opens with. Keys are
 * read as own properties only, so `__proto__` or `constructor` is a key like any other and no prototype is read.
 *
 * A refusal's message is the declared sentence and nothing else, so no byte of the request is ever quoted back. The
 * admission never throws on any text: the bound comes first, and `JSON.parse` of a text within the largest bound a
 * form may declare (65,536 code units, at most 32,768 nested arrays) parses or refuses it as JSON (measured, bun
 * 1.4.4), so only its `SyntaxError` is answered and any other error is thrown as it is.
 *
 * The repair identity of an admitted request (`declaredRequestIdentity`) is read by the same admission, so one reader
 * decides both what is admitted and which requests are one read.
 *
 * Not the boundary. The provider reads every request with its own reader before it sends anything, and the engine's
 * structural boundary bounds what it sends; this is what lets the model read why a request was refused before anything
 * is sent. The census (tests/helpers/declared-language-census.ts) holds a declared form and its provider's reader to
 * the same answer on every request of a corpus.
 */
import type {
  AgentRequestForm,
  AgentRequestKeyCheck,
  AgentRequestRead,
  AgentRequestRefusal,
  AgentRequestRule,
} from "@libredb/provider-sdk/manifest";
import { repeatsAKey } from "@libredb/provider-sdk/values";

/** A refusal of a request: the declared code, and the declared sentence as the message. */
export interface DeclaredRequestRefusal {
  readonly code: string;
  readonly message: string;
}

/** The answer of a declared refusal. */
function answer(refusal: AgentRequestRefusal): DeclaredRequestRefusal {
  return { code: refusal.code, message: refusal.sentence };
}

/** The object `text` holds, or null where it holds no JSON text or a JSON value that is no plain object. */
function parsedObject(text: string): Readonly<Record<string, unknown>> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The code point of a character range's end, which the manifest validator holds to one well-formed character. */
const codePoint = (end: string): number => end.codePointAt(0) as number;

/** The refusal `rule` answers for `value`, or null where it admits it. */
function ruleRefusal(rule: AgentRequestRule, value: unknown): AgentRequestRefusal | null {
  if (rule.kind === "enumeration") {
    return typeof value === "string" && rule.values.includes(value) ? null : rule.refusal;
  }
  if (rule.kind === "integer") {
    return typeof value === "number" && Number.isInteger(value) && value >= rule.minimum && value <= rule.maximum
      ? null
      : rule.refusal;
  }
  if (typeof value !== "string" || !value.isWellFormed()) return rule.refusal;
  let length = 0;
  for (const character of value) {
    length += 1;
    const point = codePoint(character);
    const within = rule.characters.some(({ from, to }) => point >= codePoint(from) && point <= codePoint(to));
    if (length > rule.maxLength || !within) return rule.refusal;
  }
  if (length < rule.minLength) return rule.refusal;
  const refused = rule.refused.find(
    ({ names, prefixes }) => names.includes(value) || prefixes.some((prefix) => value.startsWith(prefix)),
  );
  return refused === undefined ? null : refused.refusal;
}

/** The refusal `check` answers for `request`, or null where it passes. */
function checkRefusal(
  check: AgentRequestKeyCheck,
  request: Readonly<Record<string, unknown>>,
): AgentRequestRefusal | null {
  if (!Object.hasOwn(request, check.key)) return check.absent;
  return ruleRefusal(check.rule, request[check.key]);
}

/** The first refusal of `checks` for `request`, in order, or null where every check passes. */
function firstRefusal(
  checks: readonly AgentRequestKeyCheck[],
  request: Readonly<Record<string, unknown>>,
): AgentRequestRefusal | null {
  for (const check of checks) {
    const refusal = checkRefusal(check, request);
    if (refusal !== null) return refusal;
  }
  return null;
}

/** What the admission reads of a request: its refusal, or the admitted request and the read its selector names. */
type Admission =
  | { readonly refusal: AgentRequestRefusal }
  | {
      readonly refusal: null;
      readonly request: Readonly<Record<string, unknown>>;
      readonly read: AgentRequestRead | null;
    };

/** The admission of `text` under `form`, in the order the module's docblock states. */
function admission(form: AgentRequestForm, text: string): Admission {
  const { refusals } = form;
  if (text.length > form.maxCharacters) return { refusal: refusals.tooLong };
  if (text.trim() === "") return { refusal: refusals.empty };
  const request = parsedObject(text);
  if (request === null) return { refusal: refusals.notAnObject };
  if (repeatsAKey(text)) return { refusal: refusals.repeatedKey };
  if (Object.keys(request).some((key) => !form.keys.includes(key))) return { refusal: refusals.unknownKey };
  const { selector } = form;
  let read: AgentRequestRead | null = null;
  if (selector !== null) {
    const named = Object.hasOwn(request, selector.key) ? request[selector.key] : undefined;
    const found = form.reads.find(({ value }) => value === named);
    if (found === undefined) return { refusal: selector.refusal };
    read = found;
  }
  const common = firstRefusal(form.common, request);
  if (common !== null) return { refusal: common };
  if (read === null) return { refusal: null, request, read };
  const refused = read.refuses.find(({ key }) => Object.hasOwn(request, key));
  if (refused !== undefined) return { refusal: refused.refusal };
  const checked = firstRefusal(read.checks, request);
  return checked === null ? { refusal: null, request, read } : { refusal: checked };
}

/**
 * The refusal an agent's request `text` in a data-declared language meets under `form`, or null where it is admitted.
 * Never throws on any text, and never quotes it.
 */
export function admitDeclaredRequest(form: AgentRequestForm, text: string): DeclaredRequestRefusal | null {
  const { refusal } = admission(form, text);
  return refusal === null ? null : answer(refusal);
}

/**
 * The repair identity of an admitted request `text` under `form`: the JSON text of one object holding the request's
 * keys in the order of the form's `keys`, each written key with its value as JSON reads it, and each absent key whose
 * integer rule for the request (a common check, or a check of the read its selector names) states a default with that
 * default. So one read written with its keys in another order or another spacing, with a default written out or left
 * out, or with a number spelled `5.0` or `-0`, has one identity. Null for a request the form refuses, which its caller
 * identifies by its text. Total over any text, as the admission is.
 */
export function declaredRequestIdentity(form: AgentRequestForm, text: string): string | null {
  const admitted = admission(form, text);
  if (admitted.refusal !== null) return null;
  const { request, read } = admitted;
  const checks = [...form.common, ...(read === null ? [] : read.checks)];
  const entries: [string, unknown][] = [];
  for (const key of form.keys) {
    if (Object.hasOwn(request, key)) {
      entries.push([key, request[key]]);
      continue;
    }
    const rule = checks.find((check) => check.key === key)?.rule;
    if (rule?.kind === "integer" && rule.default !== null) entries.push([key, rule.default]);
  }
  return JSON.stringify(Object.fromEntries(entries));
}
