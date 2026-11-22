/**
 * The shared matching of a credential's forms held to realistic server text: every captured server answer and log
 * under tests/fixtures and the driver error corpus, read at run time.
 *
 * A generated credential of any common shape withholds none of them. For a word the texts themselves use, reading a
 * text through its JSON string escapes and without the dropped control characters withholds nothing the text as
 * written does not already hold, and every text the base64 offset forms withhold holds the word base64-encoded behind
 * a prefix, its first character tolerated in the top bits the prefix's characters carry.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { holdsSecretForm, secretForms, serverText } from "@/lib/db/utils/server-text";
import { CORPUS_MESSAGES } from "../../fixtures/driver-errors/corpus";

const FIXTURES = join(import.meta.dir, "../../fixtures");
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const WORD_COUNT = 50;

/** Every JSON string value and every line of a captured body, trimmed, 8 to 65,536 characters, each once. */
function corpus(): string[] {
  const texts = new Set<string>();
  const add = (value: string) => {
    const text = value.trim();
    if (text.length >= 8 && text.length <= 64 * 1024) texts.add(text);
  };
  const walk = (value: unknown): void => {
    if (typeof value === "string") add(value);
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value !== null && typeof value === "object") for (const item of Object.values(value)) walk(item);
  };
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const info = statSync(path);
      if (info.isDirectory()) visit(path);
      else if (info.size <= MAX_FILE_BYTES && /\.(json|txt|log|ndjson)$/.test(entry)) {
        const raw = readFileSync(path, "utf8");
        if (entry.endsWith(".json")) {
          try {
            walk(JSON.parse(raw));
          } catch {
            // A file named .json that holds no single JSON value is read by its lines only, as every other body is.
          }
        }
        for (const line of raw.split("\n")) add(line);
      }
    }
  };
  for (const message of CORPUS_MESSAGES) add(message);
  visit(FIXTURES);
  return [...texts];
}

const texts = corpus();

const pick = (alphabet: string, length: number) =>
  Array.from(crypto.getRandomValues(new Uint32Array(length)), (value) => alphabet[value % alphabet.length]).join("");
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = `${LOWER}${LOWER.toUpperCase()}0123456789`;

/** Words of 6 to 12 lowercase letters the texts use, spread evenly over their sorted list. */
function corpusWords(): string[] {
  const words = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(/\b[a-z]{6,12}\b/g)) words.add(match[0]);
  const sorted = [...words].sort();
  const step = sorted.length / WORD_COUNT;
  return Array.from({ length: WORD_COUNT }, (_, index) => sorted[Math.floor(index * step)]);
}

const unpadded = (value: string) => Buffer.from(value, "utf8").toString("base64").replace(/=+$/, "");

/** Whether a run of the base64 alphabet decodes, at some alignment, to the word's bytes after its first, preceded by a byte that agrees with its first byte in the low 4 bits. */
function holdsWordAtOffset(run: string, word: string): boolean {
  const bytes = Buffer.from(word, "utf8");
  const tail = bytes.subarray(1);
  for (let align = 0; align < 4; align++) {
    const usable = run.slice(align, align + Math.floor((run.length - align) / 4) * 4);
    const decoded = Buffer.from(usable, "base64");
    for (let at = decoded.indexOf(tail, 1); at !== -1; at = decoded.indexOf(tail, at + 1)) {
      if ((decoded[at - 1] & 0x0f) === (bytes[0] & 0x0f)) return true;
    }
  }
  return false;
}

describe("the shared matching on realistic server text", () => {
  test("the corpus is the captured server text it is meant to be", () => {
    expect(texts.length).toBeGreaterThan(100_000);
  });

  test("withholds no text for a generated credential of any common shape", () => {
    const credentials = Array.from({ length: 20 }, () => [
      crypto.randomUUID(),
      pick(ALNUM, 12),
      `${pick(ALNUM, 5)}"\\<>&/${pick(ALNUM, 5)}`,
      pick(`${ALNUM}-_`, 24),
      pick(LOWER, 8),
    ]).flat();
    const forms = secretForms(credentials);
    const held = texts.filter((text) => holdsSecretForm(text, forms));
    expect(held.slice(0, 5)).toEqual([]);
  }, 60_000);

  const words = corpusWords();

  test("the readings withhold no text for a word the texts use unless the text as written already holds one of its forms", () => {
    const readable = texts.filter((text) =>
      /\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])|[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text),
    );
    expect(readable.length).toBeGreaterThan(1_000);
    const added: [string, string][] = [];
    for (const word of words) {
      const forms = secretForms([word]);
      for (const text of readable) {
        if (holdsSecretForm(text, forms) && !forms.some((form) => text.includes(form))) added.push([word, text]);
      }
    }
    expect(added.slice(0, 5)).toEqual([]);
  }, 60_000);

  test("a text the offset forms add holds the word base64-encoded behind a prefix", () => {
    const joined = texts.join("\n");
    const starts: number[] = [];
    let position = 0;
    for (const text of texts) {
      starts.push(position);
      position += text.length + 1;
    }
    const textAt = (index: number) => {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle] <= index) low = middle;
        else high = middle - 1;
      }
      return low;
    };
    const unexplained: [string, string][] = [];
    let added = 0;
    for (const word of words) {
      const before = [word, unpadded(word), encodeURIComponent(word)];
      const offsetForms = secretForms([word]).filter((form) => !before.includes(form));
      const seen = new Set<number>();
      for (const form of offsetForms) {
        for (let at = joined.indexOf(form); at !== -1; at = joined.indexOf(form, at + 1)) {
          const index = textAt(at);
          if (seen.has(index)) continue;
          seen.add(index);
          const text = texts[index];
          if (before.some((value) => text.includes(value))) continue;
          expect(serverText(text, secretForms([word]))).not.toBe(text);
          added += 1;
          const runs = text.match(/[A-Za-z0-9+/]+/g) ?? [];
          if (!runs.some((run) => run.includes(form) && holdsWordAtOffset(run, word))) unexplained.push([word, text]);
        }
      }
    }
    expect(unexplained.slice(0, 5)).toEqual([]);
    expect(added).toBeGreaterThan(0);
  }, 60_000);
});
