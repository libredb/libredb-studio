import { CONNECTION_FORM } from "@/lib/db/connection-form";
import { connectionFieldRefusal } from "@/lib/db/connection-field-rules";
import type { ConnectionField } from "@/lib/db/connection-fields";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "./census-connection";

/**
 * The connections the shared field rules (src/lib/db/connection-field-rules.ts) are held to, read by the two tests that
 * hold the rules to the providers and to the test-connection route: each engine's base connection, and for every field
 * rule of every engine, the base with that field set to each of `FIELD_RULE_VALUES`.
 *
 * The values are the candidates of the measurement the shared module was designed on: text, padded text, text of only
 * whitespace (a tab, a line feed and U+00A0 among it), separators, long text, non-ASCII and control characters, and
 * values that are not text at all, `null` among them. Each is set on its field with a computed key, so no value here
 * is ever written after a secret-named key.
 */
const LONG = (n: number): string => "a".repeat(n);

export const FIELD_RULE_VALUES: readonly unknown[] = Object.freeze([
  "",
  " ",
  "  ",
  "\t",
  "\n",
  " \t ",
  " ",
  ",",
  " , ",
  ", ,",
  ";",
  "/",
  "//",
  ".",
  "..",
  "-",
  "_",
  "0",
  "00",
  "1",
  "a",
  "A",
  "a b",
  "a,b",
  "a, b",
  " a",
  "a ",
  " a ",
  "a\t",
  "\ta",
  "a\n",
  "é",
  "ü",
  "日本",
  "a ",
  "​",
  "x\u0001y",
  "x\u007fy",
  "%41",
  "a%2Fb",
  "?",
  "#",
  "`",
  "``",
  "`a`",
  "`a``b`",
  "`a.b`",
  "a`b",
  "a.b",
  "a..b",
  ".a",
  "a.",
  "a-b",
  "-a",
  "a-",
  "a_b",
  "_a",
  "A_b",
  "abc",
  "ABC",
  "123",
  "1a",
  "a1",
  LONG(62),
  LONG(63),
  LONG(64),
  LONG(253),
  LONG(255),
  LONG(256),
  LONG(300),
  LONG(512),
  LONG(513),
  "/api",
  "/apis",
  "/a",
  "/a/",
  "/a//",
  "/a/b",
  "/./a",
  "/a/..",
  "/API",
  "/rabbitmq",
  "/a/api",
  "/a/api/",
  "/apix",
  "/a%20b",
  "/a b",
  "../x",
  "a/b/",
  "x,,y",
  "UPPER_case!",
  "-x-",
  "5672",
  "05672",
  "+5672",
  "5672 ",
  " 5672",
  "65535",
  "65536",
  "70000",
  "0x10",
  "1e3",
  "5672.0",
  "-1",
  "us-east-1",
  "US-EAST-1",
  " us-east-1",
  "default",
  "kube-system",
  " default",
  "a,,b",
  ",a",
  "a,",
  " a , b ",
  "a  b",
  "a\nb",
  "a\tb",
  "census",
  " census",
  "census ",
  "a=b",
  "a/b",
  "a,b,c",
  "spark_catalog",
  "db.schema",
  "a.b.c.d.e.f.g.h",
  "a.b.c.d.e.f.g.h.i",
  "myorg-myaccount",
  "jdbc:snowflake://a",
  "1.2.3.4",
  "https://app.snowflake.com/x",
  5672,
  0,
  65536,
  5672.5,
  -1,
  true,
  false,
  null,
  ["a"],
  { a: 1 },
]);

/**
 * What each engine's base adds to its census connection (tests/helpers/census-connection.ts), so the base passes its
 * own rules and, on loopback, its provider's checks: Snowflake's Account must be an account identifier and its role a
 * word, and RabbitMQ's management port is 1, the census's unconnected port, so nothing real is ever reached.
 */
const BASE_OVERRIDES: Partial<Record<DatabaseType, Partial<Record<ConnectionField, unknown>>>> = {
  snowflake: { host: "myorg-myaccount", role: "analyst" },
  rabbitmq: { port: 1 },
};

/**
 * An engine's base connection: its census connection with `BASE_OVERRIDES`.
 *
 * @throws {Error} When the shared rules refuse the base itself, naming the engine and the sentence, since every entry
 * built on a refused base would then be refused for the base's field and not its own.
 */
export function fieldRuleBase(type: DatabaseType): DatabaseConnection {
  const base = { ...CENSUS_CONNECTION[type], ...BASE_OVERRIDES[type] } as DatabaseConnection;
  const refusal = connectionFieldRefusal(CONNECTION_FORM[type], base);
  if (refusal !== undefined) throw new Error(`${type}'s base connection is refused by its own field rules: ${refusal}`);
  return base;
}

/** One connection of the corpus: an engine's base (no `field`), or the base with one rule field set to `value`. */
export interface FieldRuleCase {
  readonly type: DatabaseType;
  readonly field?: ConnectionField;
  readonly value?: unknown;
  readonly connection: DatabaseConnection;
  /** The engine, the field and the value, for a failure message. */
  readonly label: string;
}

/** The engines that declare field rules, in `CONNECTION_FORM` order. */
export function fieldRuleEngines(): DatabaseType[] {
  return (Object.keys(CONNECTION_FORM) as DatabaseType[]).filter(
    (type) => Object.keys(CONNECTION_FORM[type].fieldRules ?? {}).length > 0,
  );
}

/**
 * Every connection of the corpus, in `CONNECTION_FORM` order: for each engine that declares field rules, its base,
 * then for each rule field in declaration order, the base with that field set to each of `FIELD_RULE_VALUES`.
 */
export function fieldRuleCorpus(): FieldRuleCase[] {
  const cases: FieldRuleCase[] = [];
  for (const type of fieldRuleEngines()) {
    const base = fieldRuleBase(type);
    cases.push({ type, connection: base, label: `${type} base` });
    for (const field of Object.keys(CONNECTION_FORM[type].fieldRules ?? {}) as ConnectionField[]) {
      for (const value of FIELD_RULE_VALUES) {
        cases.push({
          type,
          field,
          value,
          connection: { ...base, [field]: value } as DatabaseConnection,
          label: `${type}.${field} = ${JSON.stringify(value)}`,
        });
      }
    }
  }
  return cases;
}
