/**
 * The census of a statement language some engine declares as data: the declared request form, read by core's one
 * engine-neutral admission (src/lib/db/operations/declared-request-form.ts), and the provider's own reader, which reads
 * every request before it sends anything, must answer every request of a corpus alike, admitted or refused with the
 * same code and the same sentence. The form is the agent's admission and the reader is the provider's, so a form that
 * drifted from its reader would tell the model one thing and the engine another; the census names every such
 * request instead.
 *
 * `READER_ENROLLMENTS` names each language's reader and corpus by the language's name. A language enters it in the same
 * change that makes a shipped declaration state the language's agent part, and the declared language admission test
 * (tests/unit/lib/agent/declared-language-admission.test.ts) holds the two sets equal, so no shipped form goes
 * uncensused.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentRequestForm, StatementLanguageData } from "@libredb/provider-sdk/manifest";
import { admitDeclaredRequest, type DeclaredRequestRefusal } from "@/lib/db/operations/declared-request-form";
import { readKafkaAgentStatement } from "@/lib/db/providers/stream/kafka/agent-metadata-read";

/** What a provider's reader answers for one request: admitted, or refused with a code and a sentence. */
export type ProviderReading =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** A provider's own reader of a request in its language. */
export type ProviderReader = (text: string) => ProviderReading;

/** A language's reader and the requests the census reads it over. */
export interface ReaderEnrollment {
  readonly reader: ProviderReader;
  readonly corpus: readonly string[];
}

/**
 * The requests Kafka's read request form is read over: the Kafka reader tests' own requests, and the cross product of
 * every key's values, admitted and refused, each written twice, with its keys in order and compact, and with its keys
 * reversed and spaced, so a request is read in more than one spelling. Built in code, never read from a file.
 */
export function kafkareadCorpus(): readonly string[] {
  const corpus = new Set<string>([
    '{"read": "topics"}',
    '{"read": "topics", "after": "orders", "limit": 7}',
    '{"read":"brokers"}',
    '{"read":"brokers","after":0,"limit":2}',
    '{"read": "partitions", "topic": "orders"}',
    '{"read": "offsets", "topic": "a.b_c-1", "after": 3, "limit": 500}',
    '{"read": "offsets", "topic": "orders", "after": 1, "limit": 2, "from": "earliest"}',
    "  \n",
    "",
    "topics",
    '["topics"]',
    "null",
    '"topics"',
    '{"read": "topics"} {"read": "brokers"}',
    '{"topic": "orders"}',
    '{"read": "topics", "read": "offsets", "topic": "orders"}',
    '{"read": "offsets", "topic": "a", "t\\u006fpic": "b"}',
    '{"read": "topics", "after": "a"}',
    '{"read": "partitions", "topic": "__Consumer_offsets"}',
    "not json",
    '{"read": "topics", "extra-key": 1}',
    '{"__proto__": 1, "read": "topics"}',
    '{"read": "topics", "constructor": 1}',
    '{"read": "topics", "limit": 1e400}',
    '{"read": "topics", "limit": -0}',
    '{"read": "topics", "limit": 5.0}',
    '{"limit":5,"topic":"orders","read":"offsets"}',
    '{"read": "offsets", "topic": "orders", "limit": 5}',
    '{"read": "offsets", "topic": "orders", "limit": 50}',
    "{}",
    "[]",
    "1",
    "true",
    " ",
    '{"read": "t\u00f6pics"}',
    '{"read": "brokers", "after": "\\ud800"}',
    "x".repeat(4096),
    JSON.stringify({ read: "topics", after: "a".repeat(4000) }),
  ]);
  const reads = ["topics", "brokers", "partitions", "offsets", "records", "", 1, null, true, ["topics"], { a: 1 }];
  const topics = [
    ...[undefined, ".", "..", "...", "", "a b", "a/b", "\u00e9", "x".repeat(249), "x".repeat(250), 7, null],
    ...[["o"], { n: "o" }, "__consumer_offsets", "__transaction_state", "__share_group_state", "__Consumer_offsets"],
    ...["_schemas", "connect-configs", "orders_", "Connect-orders", "connector-logs", "orders", "\u{1F600}"],
  ];
  const afters = [undefined, "orders", "a b", "_schemas", 0, 3, -1, 1.5, 2147483647, 2147483648, "3", null, ".", ".."];
  const limits = [undefined, 0, 1, 50, 500, 501, -1, 1.5, "5", null, true];
  for (const read of [...reads, undefined])
    for (const topic of topics)
      for (const after of afters)
        for (const limit of limits) {
          const request = Object.fromEntries(
            Object.entries({ read, topic, after, limit }).filter(([, value]) => value !== undefined),
          );
          corpus.add(JSON.stringify(request));
          corpus.add(JSON.stringify(Object.fromEntries(Object.entries(request).reverse()), null, 1));
        }
  return [...corpus];
}

/** Kafka's own reader of a request, the one its provider reads before it sends anything, as the census reads it. */
function kafkaReader(text: string): ProviderReading {
  const reading = readKafkaAgentStatement(text);
  return reading.ok ? { ok: true } : { ok: false, code: reading.code, message: reading.message };
}

/** Each language a shipped declaration states an agent part for, by name: its reader and its corpus. */
export const READER_ENROLLMENTS: ReadonlyMap<string, ReaderEnrollment> = new Map([
  ["kafkaread", { reader: kafkaReader, corpus: kafkareadCorpus() }],
]);

const DECLARATIONS = path.join(import.meta.dir, "../../src/lib/db/engine-declarations");

/** The statement language data every shipped declaration states, the null ones left out, in file name order. */
export function shippedLanguageData(): NonNullable<StatementLanguageData>[] {
  return readdirSync(DECLARATIONS)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map(
      (file) =>
        (
          JSON.parse(readFileSync(path.join(DECLARATIONS, file), "utf8")) as {
            statementLanguageData: StatementLanguageData;
          }
        ).statementLanguageData,
    )
    .filter((data): data is NonNullable<StatementLanguageData> => data !== null);
}

/** One answer in words: admitted, or the code and the sentence it was refused with. */
function described(answer: DeclaredRequestRefusal | null): string {
  return answer === null ? "admitted" : `refused ${answer.code} ${JSON.stringify(answer.message)}`;
}

/**
 * One line for each request of `corpus` that the declared form of `language` and `reader` answer differently, naming
 * the language, the request as a JSON string and both answers; empty where they agree on every request. A request
 * longer than the form's bound is passed over: that refusal is the agent's own, which the reader never meets.
 */
export function censusDisagreements(
  language: string,
  form: AgentRequestForm,
  reader: ProviderReader,
  corpus: Iterable<string>,
): string[] {
  const lines: string[] = [];
  for (const text of corpus) {
    if (text.length > form.maxCharacters) continue;
    const declared = admitDeclaredRequest(form, text);
    const reading = reader(text);
    const read = reading.ok ? null : { code: reading.code, message: reading.message };
    if (described(declared) !== described(read)) {
      lines.push(
        `${language}: ${JSON.stringify(text)} is ${described(declared)} by the declared form and ${described(read)} by the provider's reader`,
      );
    }
  }
  return lines;
}
