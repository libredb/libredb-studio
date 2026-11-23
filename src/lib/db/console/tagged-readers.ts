import { checkIntRange, isTaggedFloat, isTaggedInt, type TaggedJson, type TaggedObject } from "./tagged-json";

/**
 * The readers of a console request's tagged JSON body: each takes the value at one place in the request and answers
 * it as the type that place takes, or refuses with a sentence that names the place and the kind it found.
 *
 * The sentences are the same for every console that reads a tagged body. How a refusal is raised is the language's:
 * `taggedReaders` takes the language's own refusal function, which receives the sentence and the place, so the
 * refusal carries the language's error class and phase.
 */

const SHOWN = 80;

/** A text as a refusal quotes it, cut after 80 characters. */
export function shownText(text: string): string {
  return JSON.stringify(text.length > SHOWN ? `${text.slice(0, SHOWN)}...` : text);
}

/** The JSON kind of a value, as a refusal names it, never the value itself. */
export function kindOf(value: TaggedJson | undefined): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (isTaggedInt(value) || isTaggedFloat(value)) return "a number";
  if (typeof value === "object") return "an object";
  return typeof value === "boolean" ? "a boolean" : `a ${typeof value}`;
}

export const isTaggedObject = (value: TaggedJson | undefined): value is TaggedObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !isTaggedInt(value) && !isTaggedFloat(value);

/** Whether the object holds the key with a value: a key written as null is a key left out. */
export const hasValue = (object: TaggedObject, key: string): boolean =>
  Object.hasOwn(object, key) && object[key] !== null;

/** The readers over one language's refusal function, which never returns. */
export function taggedReaders(refuse: (message: string, key: string) => never) {
  return {
    objectAt(value: TaggedJson | undefined, where: string): TaggedObject {
      if (!isTaggedObject(value)) return refuse(`${where} must be an object, found ${kindOf(value)}.`, where);
      return value;
    },

    listAt(value: TaggedJson | undefined, where: string): readonly TaggedJson[] {
      if (!Array.isArray(value)) return refuse(`${where} must be a list, found ${kindOf(value)}.`, where);
      return value;
    },

    stringAt(value: TaggedJson | undefined, where: string): string {
      if (typeof value !== "string") return refuse(`${where} must be a string, found ${kindOf(value)}.`, where);
      return value;
    },

    booleanAt(value: TaggedJson | undefined, where: string): boolean {
      if (typeof value !== "boolean") return refuse(`${where} must be true or false, found ${kindOf(value)}.`, where);
      return value;
    },

    /** A whole number written as an integer literal, from `min` to `max`. */
    integerAt(value: TaggedJson | undefined, where: string, min: number, max: number): number {
      if (value === undefined || !isTaggedInt(value)) {
        return refuse(`${where} must be an integer, found ${kindOf(value)}.`, where);
      }
      if (!checkIntRange(value, "safe") || Number(value.digits) < min || Number(value.digits) > max) {
        return refuse(`${where} is ${value.digits}; it takes an integer from ${min} to ${max}.`, where);
      }
      return Number(value.digits);
    },

    numberAt(value: TaggedJson | undefined, where: string): number {
      if (value !== undefined && isTaggedFloat(value)) return Number(value.text);
      if (value !== undefined && isTaggedInt(value)) return Number(value.digits);
      return refuse(`${where} must be a number, found ${kindOf(value)}.`, where);
    },

    wordAt(value: TaggedJson | undefined, where: string, words: readonly string[]): string {
      if (typeof value !== "string" || !words.includes(value)) {
        return refuse(
          `${where} takes one of ${words.join(", ")}, not ${typeof value === "string" ? shownText(value) : kindOf(value)}.`,
          where,
        );
      }
      return value;
    },
  };
}
